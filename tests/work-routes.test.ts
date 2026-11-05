import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { installGuard } from "../server/guard";
import { ActionLog, type ActionRecord } from "../server/action-log";
import { workRoutes } from "../server/routes/work";
import { workActionRoutes } from "../server/routes/work-actions";
import { spawnRun, type Run, type RunResult } from "../server/agents/worktree";
import { boardItem, partOfRefs, readBoard } from "../server/readers/work";
import { conflictsOf, pairFrom } from "../server/readers/work-conflicts";
import { createIssue, mergePr } from "../server/work/act";
import type { BoardResponse, PrsResponse } from "../shared/work-types";

const dirs: string[] = [];
const scratch = (p = "work-") => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const HEAD = "1111111111111111111111111111111111111111";
const MOVED = "2222222222222222222222222222222222222222";
const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string, code = 1): RunResult => ({ code, stdout: "", stderr });

/** A fake gh/git: answers by the first rule whose words all appear in the command, and records every call. */
function fake(rules: [string, RunResult | ((args: string[]) => RunResult)][]) {
  const calls: string[][] = [];
  const run: Run = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const line = [cmd, ...args].join(" ");
    for (const [words, ans] of rules) {
      if (words.split(" ").every((w) => line.includes(w))) return typeof ans === "function" ? ans(args) : ans;
    }
    return fail(`no fake for: ${line}`, 127);
  };
  return { run, calls, ran: (words: string) => calls.some((c) => words.split(" ").every((w) => c.join(" ").includes(w))) };
}

/** A git checkout with origin on GitHub, so resolveProject finds acme/widget. */
async function repoDir(): Promise<string> {
  const d = scratch("work-repo-");
  for (const args of [["init", "-q", "-b", "main"], ["remote", "add", "origin", "https://github.com/acme/widget.git"]]) await spawnRun("git", ["-C", d, ...args]);
  return d;
}

const TOKEN = "work-test-token";
const HOSTNAME = "localhost:4104";

async function server(rules: [string, RunResult | ((args: string[]) => RunResult)][]) {
  const main = await repoDir();
  const f = fake(rules);
  // git questions about the checkout go to real git; gh goes to the fake.
  // A fetch never leaves this machine in a test.
  const run: Run = async (cmd, args, opts) =>
    cmd === "git" ? (args.includes("fetch") ? fail("fetch is offline in tests", 128) : spawnRun(cmd, args, opts)) : f.run(cmd, args, opts);
  const log = new ActionLog(scratch("work-log-"));
  const app = new Hono();
  installGuard(app, { bind: "127.0.0.1", token: TOKEN, log });
  const deps = { run, projects: () => [{ name: "widget", path: main }], tmpRoot: scratch("work-tmp-") };
  app.route("/api", workRoutes(deps));
  app.route("/api", workActionRoutes(deps));
  const send = (path: string, body: unknown, headers: Record<string, string> = { origin: `http://${HOSTNAME}`, "x-anvideck-token": TOKEN }) =>
    app.request(`http://${HOSTNAME}${path}`, { method: "POST", headers: { host: HOSTNAME, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const get = (path: string) => app.request(`http://${HOSTNAME}${path}`, { headers: { host: HOSTNAME } });
  const lines = (): ActionRecord[] => {
    try {
      return readFileSync(log.file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  return { send, get, lines, f };
}

const view = (state: string, head: string, isDraft = false, base = "main") => ok(JSON.stringify({ number: 7, state, isDraft, headRefOid: head, baseRefName: base }));

describe("merge refuses a head that moved", () => {
  test("the page's head is no longer the PR's: 409 with both heads, gh pr merge is never run, the refusal is logged", async () => {
    const s = await server([["gh pr view 7", view("OPEN", MOVED)], ["gh pr merge", ok()]]);
    const res = await s.send("/api/prs/7/merge", { project: "widget", head: HEAD, base: "main" });
    expect(res.status).toBe(409);
    const j = (await res.json()) as Record<string, unknown>;
    expect(j).toMatchObject({ refusal: "head-moved", reviewedHead: HEAD, currentHead: MOVED });
    expect(String(j.error)).toContain("Nothing was merged");
    expect(s.f.ran("gh pr merge")).toBe(false);
    const rec = s.lines().at(-1)!;
    expect(rec).toMatchObject({ method: "POST", path: "/api/prs/7/merge", area: "prs", target: "7", status: 409, result: "failed" });
    expect(rec.body).toMatchObject({ project: "widget", head: HEAD, base: "main" });
  });

  test("the same head: merged with --squash and --match-head-commit <that head>, in the project's repo", async () => {
    const s = await server([
      ["gh pr view 7 --repo acme/widget --json number,state", view("OPEN", HEAD)],
      ["gh pr view 7 --repo acme/widget --json state,mergeCommit", ok(JSON.stringify({ state: "MERGED", mergeCommit: { oid: "abc" }, mergedAt: "2026-11-05T12:00:00Z" }))],
      ["gh pr merge 7", ok()],
    ]);
    const res = await s.send("/api/prs/7/merge", { project: "widget", head: HEAD, base: "main" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ merged: true, repo: "acme/widget", number: 7, head: HEAD, readBack: { state: "read", mergeCommit: "abc" } });
    const merge = s.f.calls.find((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "merge")!;
    expect(merge).toEqual(["gh", "pr", "merge", "7", "--repo", "acme/widget", "--squash", "--match-head-commit", HEAD]);
    expect(s.lines().at(-1)).toMatchObject({ status: 200, result: "accepted", area: "prs", target: "7" });
  });

  test("GitHub refusing a head that moved between the read and the merge is head-moved too", async () => {
    const r = fake([["gh pr view", view("OPEN", HEAD)], ["gh pr merge", fail("GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest)")]]);
    const e = await mergePr(r.run, "acme/widget", 7, HEAD, "main").catch((x) => x);
    expect(e.status).toBe(409);
    expect(e.detail.refusal).toBe("head-moved");
  });

  test("a merge GitHub did is never reported as failed because the read-back failed", async () => {
    const r = fake([["gh pr view 7 --repo acme/widget --json number", view("OPEN", HEAD)], ["state,mergeCommit", fail("timeout")], ["gh pr merge", ok()]]);
    const a = await mergePr(r.run, "acme/widget", 7, HEAD, "main");
    expect(a.merged).toBe(true);
    expect(a.readBack).toEqual({ state: "unreadable", reason: "merged, but the read-back failed: timeout" });
  });

  test("no token, or another origin: refused by the guard (403), never reaching gh, and logged as refused", async () => {
    const s = await server([["gh", ok()]]);
    const noToken = await s.send("/api/prs/7/merge", { project: "widget", head: HEAD, base: "main" }, { origin: `http://${HOSTNAME}` });
    const otherPage = await s.send("/api/prs/7/merge", { project: "widget", head: HEAD, base: "main" }, { origin: "http://evil.example", "x-anvideck-token": TOKEN });
    expect([noToken.status, otherPage.status]).toEqual([403, 403]);
    expect(s.f.calls.filter((c) => c[0] === "gh")).toEqual([]);
    expect(s.lines().map((l) => l.result)).toEqual(["refused", "refused"]);
  });

  test("a short or missing head, a closed PR, a draft: refused with the reason, nothing merged", async () => {
    const r = fake([["gh pr view 8", view("MERGED", HEAD)], ["gh pr view 9", view("OPEN", HEAD, true)], ["gh pr merge", ok()]]);
    expect((await mergePr(r.run, "acme/widget", 7, "abc1234", "main").catch((x) => x)).status).toBe(400);
    expect((await mergePr(r.run, "acme/widget", 8, HEAD, "main").catch((x) => x)).detail.refusal).toBe("not-open");
    expect((await mergePr(r.run, "acme/widget", 9, HEAD, "main").catch((x) => x)).detail.refusal).toBe("draft");
    expect(r.ran("gh pr merge")).toBe(false);
  });

  test("GitHub unreachable before the merge: 502, nothing merged (not 'no such PR')", async () => {
    const r = fake([["gh pr view", fail("error connecting to api.github.com")]]);
    const e = await mergePr(r.run, "acme/widget", 7, HEAD, "main").catch((x) => x);
    expect([e.status, e.detail.refusal]).toEqual([502, "github-unread"]);
    const missing = await mergePr(fake([["gh pr view", fail("GraphQL: Could not resolve to a PullRequest with the number of 7.")]]).run, "acme/widget", 7, HEAD, "main").catch((x) => x);
    expect([missing.status, missing.detail.refusal]).toEqual([404, "no-pr"]);
  });
});

describe("merge refuses a PR retargeted since the page showed it", () => {
  test("the page showed base main, the PR now merges into other-base: 409 base-moved, gh pr merge is never run", async () => {
    const s = await server([["gh pr view 7", view("OPEN", HEAD, false, "other-base")], ["gh pr merge", ok()]]);
    const res = await s.send("/api/prs/7/merge", { project: "widget", head: HEAD, base: "main" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ refusal: "base-moved", shownBase: "main", currentBase: "other-base" });
    expect(s.f.ran("gh pr merge")).toBe(false);
    expect(s.lines().at(-1)).toMatchObject({ status: 409, result: "failed", target: "7" });
  });

  test("no base sent, or one that is not a branch name: 400 before GitHub is asked", async () => {
    const s = await server([["gh", ok()]]);
    const none = await s.send("/api/prs/7/merge", { project: "widget", head: HEAD });
    expect(none.status).toBe(400);
    const r = fake([["gh", ok()]]);
    expect((await mergePr(r.run, "acme/widget", 7, HEAD, "has space").catch((x) => x)).status).toBe(400);
    expect(s.f.calls.filter((c) => c[0] === "gh")).toEqual([]);
    expect(r.calls).toEqual([]);
  });
});

describe("gh pr merge failing is read back before it is called a failure", () => {
  const merged = ok(JSON.stringify({ state: "MERGED", mergeCommit: { oid: "abc" }, mergedAt: "2026-11-05T12:00:00Z" }));
  const timedOut = fail("gh pr took longer than 60s and was stopped", 124);

  test("gh timed out but GitHub merged it: 200 merged, with gh's words, and the log says accepted", async () => {
    const s = await server([["gh pr view 7 --repo acme/widget --json number", view("OPEN", HEAD)], ["state,mergeCommit", merged], ["gh pr merge", timedOut]]);
    const res = await s.send("/api/prs/7/merge", { project: "widget", head: HEAD, base: "main" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ merged: true, base: "main", ghFailed: "gh pr took longer than 60s and was stopped", readBack: { state: "read", mergeCommit: "abc" } });
    expect(s.f.ran("state,mergeCommit")).toBe(true);
    expect(s.lines().at(-1)).toMatchObject({ status: 200, result: "accepted" });
  });

  test("gh failed and GitHub says it is still open: 502 merge-failed, naming the read-back", async () => {
    const r = fake([["gh pr view 7 --repo acme/widget --json number", view("OPEN", HEAD)], ["state,mergeCommit", ok(JSON.stringify({ state: "OPEN", mergeCommit: null, mergedAt: null }))], ["gh pr merge", fail("GraphQL: Pull request is not mergeable")]]);
    const e = await mergePr(r.run, "acme/widget", 7, HEAD, "main").catch((x) => x);
    expect([e.status, e.detail.refusal, e.detail.state]).toEqual([502, "merge-failed", "OPEN"]);
    expect(String(e.message)).toContain("read back: it is open");
  });

  test("gh failed and the read-back failed too: 502 merge-unknown, never 'did not merge'", async () => {
    const r = fake([["gh pr view 7 --repo acme/widget --json number", view("OPEN", HEAD)], ["state,mergeCommit", fail("error connecting to api.github.com")], ["gh pr merge", timedOut]]);
    const e = await mergePr(r.run, "acme/widget", 7, HEAD, "main").catch((x) => x);
    expect([e.status, e.detail.refusal]).toEqual([502, "merge-unknown"]);
    expect(String(e.message)).toContain("not known whether PR #7 merged");
    expect(String(e.message)).not.toContain("did not merge");
  });
});

describe("new issue", () => {
  test("files with gh issue create --repo <the project's repo>; the log names the new issue", async () => {
    const s = await server([["gh issue create --repo acme/widget --title Work is slow --body Problem", ok("https://github.com/acme/widget/issues/31\n")]]);
    const res = await s.send("/api/issues", { project: "widget", title: "Work is slow", body: "Problem" });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: "acme/widget#31", repo: "acme/widget", number: 31, url: "https://github.com/acme/widget/issues/31" });
    expect(s.lines().at(-1)).toMatchObject({ path: "/api/issues", area: "issues", target: "acme/widget#31", result: "accepted" });
  });

  test("no title is refused before gh runs; a URL of another repo is not taken as this repo's number", async () => {
    const r = fake([["gh issue create", ok("https://github.com/acme/other/issues/4")]]);
    expect((await createIssue(r.run, "acme/widget", "  ", "").catch((x) => x)).status).toBe(400);
    expect(r.ran("gh issue create")).toBe(false);
    expect(await createIssue(r.run, "acme/widget", "t", undefined)).toMatchObject({ number: null, url: "https://github.com/acme/other/issues/4" });
  });

  test("an unknown project is 404 and nothing is filed", async () => {
    const s = await server([["gh", ok()]]);
    const res = await s.send("/api/issues", { project: "nope", title: "x" });
    expect(res.status).toBe(404);
    expect(s.f.calls.filter((c) => c[0] === "gh")).toEqual([]);
  });
});

const boardsJson = (n: number) =>
  JSON.stringify({ data: { repository: { projectsV2: { nodes: Array.from({ length: n }, (_, i) => ({ id: `P${i}`, number: i + 1, title: `Board ${i + 1}`, url: `https://github.com/users/acme/projects/${i + 1}`, owner: { login: "acme" }, field: { id: "F", options: [{ id: "a", name: "Todo" }, { id: "b", name: "In Progress" }, { id: "c", name: "Done" }] } })) } } } });

describe("board", () => {
  test("no board: says so and lists the open issues", async () => {
    const r = fake([["gh api graphql", ok(boardsJson(0))], ["gh issue list --repo acme/widget --state open", ok(JSON.stringify([{ number: 3, title: "A", url: "u", labels: [{ name: "bug" }], updatedAt: "t" }]))]]);
    const b = await readBoard(r.run, "acme/widget");
    expect(b.board.state).toBe("no board");
    expect(b.issues).toEqual({ state: "read", limit: 500, issues: [{ number: 3, title: "A", url: "u", labels: ["bug"], updatedAt: "t" }] });
  });

  test("a board that could not be asked about is unreadable, never 'no board'", async () => {
    const r = fake([["gh api graphql", fail("HTTP 502")], ["gh issue list", ok("[]")]]);
    expect((await readBoard(r.run, "acme/widget")).board.state).toBe("unreadable");
  });

  test("open issues that could not be listed are unreadable, never an empty list", async () => {
    const r = fake([["gh api graphql", ok(boardsJson(0))], ["gh issue list", fail("offline")]]);
    expect((await readBoard(r.run, "acme/widget")).issues).toMatchObject({ state: "unreadable" });
  });

  test("several boards are not guessed between", async () => {
    const r = fake([["gh api graphql", ok(boardsJson(2))], ["gh issue list", ok("[]")]]);
    const b = await readBoard(r.run, "acme/widget");
    expect(b.board).toMatchObject({ state: "several boards", boards: [{ number: 1 }, { number: 2 }] });
  });

  test("one board: every item with its Status, the columns in the board's order, and GitHub's total", async () => {
    const items = [
      { id: "I1", content: { type: "Issue", number: 5, title: "Five", url: "https://github.com/acme/widget/issues/5", repository: "acme/widget" }, status: "Todo", labels: ["Armed"], "linked pull requests": ["https://github.com/acme/widget/pull/6"] },
      { id: "I2", content: { type: "DraftIssue", title: "Draft" }, status: null },
    ];
    const r = fake([["gh api graphql", ok(boardsJson(1))], ["gh project item-list 1 --owner acme", ok(JSON.stringify({ items, totalCount: 3 }))]]);
    const b = await readBoard(r.run, "acme/widget");
    expect(b.board).toMatchObject({ state: "board", number: 1, columns: ["Todo", "In Progress", "Done"], total: 3, url: "https://github.com/users/acme/projects/1" });
    if (b.board.state !== "board") throw new Error("no board");
    expect(b.board.items[0]).toEqual({ id: "I1", type: "Issue", number: 5, title: "Five", url: "https://github.com/acme/widget/issues/5", repo: "acme/widget", status: "Todo", labels: ["Armed"], linkedPrs: [6] });
    expect(b.board.items[1]).toMatchObject({ type: "DraftIssue", number: null, status: null });
    expect(b.issues).toBeNull();
  });

  test("items that could not be read: unreadable with gh's words", async () => {
    const r = fake([["gh api graphql", ok(boardsJson(1))], ["gh project item-list", fail("missing scope read:project")]]);
    const b = await readBoard(r.run, "acme/widget");
    expect(b.board).toMatchObject({ state: "unreadable" });
    expect((b.board as { reason: string }).reason).toContain("read:project");
  });

  test("boardItem keeps an item without content readable", () => {
    expect(boardItem({ id: "x", title: "T" })).toMatchObject({ id: "x", title: "T", number: null, type: "unknown" });
  });

  test("GET /api/work/board answers with the project's repo and the read time", async () => {
    const s = await server([["gh api graphql", ok(boardsJson(0))], ["gh issue list", ok("[]")]]);
    const res = await s.get("/api/work/board?project=widget");
    expect(res.status).toBe(200);
    const j = (await res.json()) as BoardResponse;
    expect(j).toMatchObject({ project: "widget", repo: "acme/widget", board: { state: "no board" }, issues: { state: "read", issues: [] } });
    expect(Number.isNaN(Date.parse(j.readAt))).toBe(false);
  });

  test("GET /api/work/prs: GitHub unreachable is a 502 with the reason, never 'no open PRs'", async () => {
    const s = await server([["gh api graphql", fail("could not connect")]]);
    const res = await s.get("/api/work/prs?project=widget");
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain("could not connect");
  });
});

/** A real repo: base, then three branches. a and b change the same line; c changes another file. */
async function conflictRepo() {
  const d = scratch("work-conf-");
  const g = async (...a: string[]) => {
    const r = await spawnRun("git", ["-C", d, "-c", "user.name=t", "-c", "user.email=t@t", ...a]);
    if (r.code !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  await g("init", "-q", "-b", "main");
  writeFileSync(join(d, "f.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(d, "g.txt"), "g\n");
  await g("add", ".");
  await g("commit", "-q", "-m", "base");
  const base = await g("rev-parse", "HEAD");
  const branch = async (name: string, file: string, text: string) => {
    await g("checkout", "-q", "-b", name, base);
    writeFileSync(join(d, file), text);
    await g("commit", "-q", "-am", name);
    return g("rev-parse", "HEAD");
  };
  const a = await branch("a", "f.txt", "one\nTWO-a\nthree\n");
  const b = await branch("b", "f.txt", "one\nTWO-b\nthree\n");
  const c = await branch("c", "g.txt", "G\n");
  // main moves on, changing g.txt; e (from base) changes g.txt too, so e conflicts with main.
  // s is stacked on e (its PR's base is e's branch) and changes only f.txt's last line.
  await g("checkout", "-q", "main");
  writeFileSync(join(d, "g.txt"), "g-main\n");
  await g("commit", "-q", "-am", "main moves");
  const tip = await g("rev-parse", "HEAD");
  const e = await branch("e", "g.txt", "g-e\n");
  writeFileSync(join(d, "f.txt"), "one\ntwo\nTHREE-s\n");
  await g("checkout", "-q", "-b", "s");
  await g("commit", "-q", "-am", "s");
  const s = await g("rev-parse", "HEAD");
  await g("checkout", "-q", "main");
  return { d, base, a, b, c, tip, e, s };
}

describe("conflicts with other open PRs (git merge-tree, real git)", () => {
  test("a and b conflict on f.txt; c conflicts with neither; none conflicts with the base; the project gets no ref", async () => {
    const r = await conflictRepo();
    const refsBefore = (await spawnRun("git", ["-C", r.d, "for-each-ref"])).stdout;
    const main = { name: "main", oid: r.base };
    const out = await conflictsOf(spawnRun, { repo: "acme/widget", main: r.d, heads: [{ number: 1, oid: r.a, base: main }, { number: 2, oid: r.b, base: main }, { number: 3, oid: r.c, base: main }], tmpRoot: scratch("work-tmp-") });
    expect(out.get(1)).toEqual({ state: "checked", base: { state: "clean" }, others: [{ number: 2, result: { state: "conflict", files: ["f.txt"] } }, { number: 3, result: { state: "clean" } }] });
    expect(out.get(3)).toEqual({ state: "checked", base: { state: "clean" }, others: [{ number: 1, result: { state: "clean" } }, { number: 2, result: { state: "clean" } }] });
    expect((await spawnRun("git", ["-C", r.d, "for-each-ref"])).stdout).toBe(refsBefore);
  });

  test("a stacked PR is merged against its own base: clean with its parent even though the parent conflicts with main", async () => {
    const r = await conflictRepo();
    const out = await conflictsOf(spawnRun, {
      repo: "acme/widget",
      main: r.d,
      heads: [{ number: 5, oid: r.e, base: { name: "main", oid: r.tip } }, { number: 6, oid: r.s, base: { name: "e", oid: r.e } }],
      tmpRoot: scratch("work-tmp-"),
    });
    expect(out.get(5)).toMatchObject({ state: "checked", base: { state: "conflict", files: ["g.txt"] } });
    expect(out.get(6)).toMatchObject({ state: "checked", base: { state: "clean" }, others: [{ number: 5, result: { state: "clean" } }] });
  });

  test("a head that is not local and cannot be fetched is unchecked, never clean", async () => {
    const r = await conflictRepo();
    const run: Run = async (cmd, args, opts) => (args.includes("fetch") ? fail("could not read Username for 'https://github.com'", 128) : spawnRun(cmd, args, opts));
    const missing = "3333333333333333333333333333333333333333";
    const main = { name: "main", oid: r.base };
    const out = await conflictsOf(run, { repo: "acme/widget", main: r.d, heads: [{ number: 1, oid: r.a, base: main }, { number: 9, oid: missing, base: main }], tmpRoot: scratch("work-tmp-") });
    expect(out.get(1)).toMatchObject({ state: "unchecked" });
    expect(out.get(9)).toMatchObject({ state: "unchecked" });
    expect((out.get(9) as { reason: string }).reason).toContain("could not fetch");
  });

  test("merge-tree's exit code decides: 0 clean, 1 conflict with its files, anything else unchecked", () => {
    expect(pairFrom({ code: 0, stdout: "tree\n", stderr: "" })).toEqual({ state: "clean" });
    expect(pairFrom({ code: 1, stdout: "tree\na.ts\nb.ts\na.ts\n", stderr: "" })).toEqual({ state: "conflict", files: ["a.ts", "b.ts"] });
    expect(pairFrom({ code: 128, stdout: "", stderr: "fatal: refusing to merge unrelated histories" })).toMatchObject({ state: "unchecked" });
  });
});

describe("GET /api/work/prs", () => {
  test('"Part of #N" links are read from the body, each once; other repos\' and look-alikes are not', () => {
    expect(partOfRefs("Part of #81. What remains: …\npart of #81 and Part of #93")).toEqual([81, 93]);
    expect(partOfRefs("Part of acme/other#5, apart of #6, Part of #7x")).toEqual([]);
    expect(partOfRefs(null)).toEqual([]);
  });

  test("open PRs come back with parsed sections, CI and conflicts per PR", async () => {
    const node = {
      number: 4, title: "T", url: "https://github.com/acme/widget/pull/4", isDraft: false, headRefName: "feat/4", headRefOid: HEAD, baseRefName: "main", baseRefOid: MOVED, mergeable: "MERGEABLE", updatedAt: "t", author: { login: "me" },
      body: "Closes #3", commits: { totalCount: 2 },
      closingIssuesReferences: { nodes: [{ number: 3, title: "I", url: "u", body: "## Problem\nx", repository: { nameWithOwner: "acme/widget" } }] },
      reviews: { nodes: [] },
      last: { nodes: [{ commit: { statusCheckRollup: null } }] },
    };
    const gql = JSON.stringify({ data: { repository: { defaultBranchRef: { name: "main", target: { oid: MOVED } }, pullRequests: { totalCount: 1, nodes: [node] } } } });
    const s = await server([["gh api graphql", ok(gql)]]);
    const res = await s.get("/api/work/prs?project=widget");
    expect(res.status).toBe(200);
    const j = (await res.json()) as PrsResponse;
    expect(j).toMatchObject({ repo: "acme/widget", total: 1, base: { name: "main", oid: MOVED } });
    expect(j.prs[0]).toMatchObject({ number: 4, commits: 2, ci: { rollup: null, total: 0 }, sections: { evidence: { status: "not recorded" } }, closing: [{ number: 3 }] });
    // The fake heads are not real commits and cannot be fetched: unchecked, with the reason.
    expect(j.prs[0]!.conflicts.state).toBe("unchecked");
  });
});
