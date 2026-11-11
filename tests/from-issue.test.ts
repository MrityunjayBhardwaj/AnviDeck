import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { AgentHost, HostError, type QueryFn } from "../server/agents/host";
import { AgentRegistry } from "../server/agents/registry";
import { loginOnlyEnv, type ClaudeBinary } from "../server/agents/login";
import { FromIssue, type FromIssueDeps } from "../server/agents/from-issue";
import { anviLinkCheck, branchFor, githubRepoOf, slugOf, spawnRun, type Run } from "../server/agents/worktree";
import { buildIssuePrompt } from "../server/agents/issue-prompt";
import { moveToInProgress } from "../server/agents/board";
import { PR_SECTIONS_INSTRUCTIONS } from "../shared/pr-evidence";
import { agentRoutes } from "../server/routes/agents";
import { FULL_ACCESS_CONFIRM, modeCapFrom, type AgentMode } from "../shared/agent-modes";

const dirs: string[] = [];
const scratch = (p = "from-issue-") => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), p)));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const sh = async (cwd: string, ...args: string[]) => {
  const r = await spawnRun("git", ["-C", cwd, ...args]);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

/**
 * A main checkout like a real project's: commits on main, a GitHub origin URL (never fetched),
 * `.anvi` a symlink into a store folder outside the repo, and `ref` either tracked (as in
 * AnviDeck itself) or a symlink like `.anvi`.
 */
async function repo(opts: { ref?: "tracked" | "linked" | "none"; ignoreAnvi?: boolean } = {}) {
  const root = scratch();
  const main = join(root, "widget");
  const store = join(root, "store", "widget");
  mkdirSync(join(store, ".anvi"), { recursive: true });
  writeFileSync(join(store, ".anvi", "dharana.md"), "# dharana\n");
  mkdirSync(join(store, "ref"), { recursive: true });
  mkdirSync(main);
  await sh(main, "init", "-q", "-b", "main");
  await sh(main, "config", "user.email", "t@example.com");
  await sh(main, "config", "user.name", "t");
  await sh(main, "remote", "add", "origin", "https://github.com/acme/widget.git");
  writeFileSync(join(main, "README.md"), "hello\n");
  writeFileSync(join(main, ".gitignore"), opts.ignoreAnvi ? ".anvi\n" : "node_modules/\n");
  if ((opts.ref ?? "tracked") === "tracked") {
    mkdirSync(join(main, "ref"));
    writeFileSync(join(main, "ref", "THESIS.md"), "x\n");
  }
  await sh(main, "add", "-A");
  await sh(main, "commit", "-q", "-m", "first");
  symlinkSync(join(store, ".anvi"), join(main, ".anvi"));
  if (opts.ref === "linked") symlinkSync(join(store, "ref"), join(main, "ref"));
  return { root, main, store };
}

type Issue = { number: number; title: string; body: string; state: string; labels?: { name: string }[] };

/** Real git; gh answered from fixtures, every call recorded. */
function runner(issues: Issue[], gh: (args: string[]) => { code: number; stdout: string; stderr?: string } | null = () => null) {
  const calls: string[][] = [];
  const run: Run = async (cmd, args, o) => {
    calls.push([cmd, ...args]);
    if (cmd !== "gh") return spawnRun(cmd, args, o);
    const own = gh(args);
    if (own) return { stderr: "", ...own };
    if (args[0] === "issue" && args[1] === "view") {
      const i = issues.find((x) => x.number === Number(args[2]));
      if (!i) return { code: 1, stdout: "", stderr: "GraphQL: Could not resolve to an issue or pull request with the number of 999." };
      return { code: 0, stdout: JSON.stringify({ ...i, url: `https://github.com/acme/widget/issues/${i.number}`, labels: i.labels ?? [] }), stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
  };
  return { run, calls };
}

const CLAUDE: ClaudeBinary = { path: "/fake/bin/claude", realPath: "/fake/lib/claude", fileId: "1:1:1" };
const init = { type: "system", subtype: "init", apiKeySource: "none", session_id: "s1", claude_code_version: "2", model: "m", cwd: "/x", tools: [], mcp_servers: [], permissionMode: "default", slash_commands: [], output_style: "default", uuid: "u" } as unknown as SDKMessage;

function host(opts: { cap?: number; claude?: ClaudeBinary | null; modeCap?: AgentMode } = {}) {
  const started: { options: Options }[] = [];
  const query: QueryFn = ({ options }) => {
    started.push({ options });
    return (async function* () {
      yield init;
      await new Promise((_, rej) => options.abortController!.signal.addEventListener("abort", () => rej(new Error("aborted"))));
    })();
  };
  const h = new AgentHost({
    registry: new AgentRegistry(scratch("from-issue-reg-")),
    query,
    resolveClaude: () => (opts.claude === undefined ? CLAUDE : opts.claude),
    env: () => loginOnlyEnv({ PATH: "/usr/bin" }),
    cap: opts.cap ?? 3,
    ...(opts.modeCap ? { modeCap: modeCapFrom(opts.modeCap) } : {}),
  });
  return { h, started };
}

const OPEN: Issue = { number: 7, title: "Workspace: start the widget from an issue", body: "Make the widget start.\n\nDone when it starts.", state: "OPEN" };
const noBoard: FromIssueDeps["board"] = async () => ({ state: "no board", reason: "no project board is linked to acme/widget" });
const noCheck: FromIssueDeps["linkCheck"] = async () => ({ state: "not checked", reason: "test", missing: [], differs: [] });

async function setup(o: { ref?: "tracked" | "linked" | "none"; ignoreAnvi?: boolean; issues?: Issue[]; cap?: number; claude?: ClaudeBinary | null; modeCap?: AgentMode } = {}) {
  const r = await repo(o);
  const { run, calls } = runner(o.issues ?? [OPEN, { number: 8, title: "Old thing", body: "", state: "CLOSED" }]);
  const { h, started } = host({ cap: o.cap, claude: o.claude, modeCap: o.modeCap });
  const fi = new FromIssue(h, { run, projects: () => [{ name: "widget", path: r.main }], board: noBoard, linkCheck: noCheck });
  return { ...r, run, calls, h, started, fi };
}

test("a mode above the cap is refused before anything is made (#249)", async () => {
  const s = await setup();
  const e = await refusal(s.fi.start({ project: "widget", issue: "7", mode: "bypassPermissions", confirm: "I understand Full access runs every tool call without asking" }));
  expect(e.status).toBe(403);
  expect(s.calls.filter((c) => c.includes("worktree"))).toEqual([]);
  expect(s.calls).toEqual([]);
  expect(s.started).toHaveLength(0);
});

test("the mode chosen reaches the agent started from an issue (#249)", async () => {
  const s = await setup();
  const r = await s.fi.start({ project: "widget", issue: "7", mode: "plan" });
  expect(s.started[0]!.options.permissionMode).toBe("plan");
  expect(s.h.get(r.agent.id).mode).toBe("plan");
  s.h.stopAll("test over");
});

test("Full access confirmed for another Agent GitHub access is refused before anything is made (#270)", async () => {
  const s = await setup({ modeCap: "bypassPermissions" });
  const e = await refusal(s.fi.start({ project: "widget", issue: "7", mode: "bypassPermissions", confirm: FULL_ACCESS_CONFIRM, githubAccess: "none" }));
  expect(e.status).toBe(409);
  expect(e.message).toContain("confirmed for Agent GitHub access None, but it is now Your login");
  expect(s.calls).toEqual([]);
  expect(s.started).toHaveLength(0);
});

test("Full access confirmed for the GitHub access it gets reaches the agent started from an issue (#270)", async () => {
  const s = await setup({ modeCap: "bypassPermissions" });
  const r = await s.fi.start({ project: "widget", issue: "7", mode: "bypassPermissions", confirm: FULL_ACCESS_CONFIRM, githubAccess: "your-login" });
  expect(s.started[0]!.options.permissionMode).toBe("bypassPermissions");
  expect(s.h.get(r.agent.id)).toMatchObject({ mode: "bypassPermissions", githubAccess: "your-login" });
  s.h.stopAll("test over");
});

async function refusal(p: Promise<unknown>): Promise<HostError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof HostError) return e;
    throw e;
  }
  throw new Error("expected a refusal, got success");
}

const branches = (main: string) => sh(main, "branch", "--format=%(refname:short)");

describe("start an agent from an issue", () => {
  test("makes the issue's worktree and branch, links .anvi, and starts the agent there with the workflow", async () => {
    const s = await setup();
    const out = await s.fi.start({ project: "widget", issue: 7, note: "do not push, do not open a PR" });
    const wt = join(s.main, ".claude", "worktrees", "issue-7");
    expect(out.worktree).toBe(wt);
    expect(out.branch).toBe("feat/7-start-the-widget-from-an-issue");
    expect(out.repo).toBe("acme/widget");
    expect(await sh(wt, "rev-parse", "--abbrev-ref", "HEAD")).toBe(out.branch);
    expect(await sh(wt, "rev-parse", "HEAD")).toBe(await sh(s.main, "rev-parse", "main"));
    // .anvi: a symlink that resolves where the main checkout's does.
    const anvi = out.links.find((l) => l.kind === ".anvi")!;
    expect(anvi.state).toBe("linked");
    expect(lstatSync(join(wt, ".anvi")).isSymbolicLink()).toBe(true);
    expect(realpathSync(join(wt, ".anvi"))).toBe(realpathSync(join(s.store, ".anvi")));
    expect(anvi.resolves).toBe(true);
    expect(readFileSync(join(wt, ".anvi", "dharana.md"), "utf8")).toBe("# dharana\n");
    // ref is tracked: the branch's own copy, never replaced by a link.
    const ref = out.links.find((l) => l.kind === "ref")!;
    expect(ref.state).toBe("tracked");
    expect(lstatSync(join(wt, "ref")).isSymbolicLink()).toBe(false);
    // .anvi was not ignored by the repo: it is excluded so git does not list it as a new file.
    expect(readFileSync(join(s.main, ".git", "info", "exclude"), "utf8").split("\n")).toContain("/.anvi");
    expect(await sh(wt, "status", "--porcelain")).toBe("");
    // The agent runs in the worktree with the issue and the workflow.
    expect(s.started).toHaveLength(1);
    expect(s.started[0]!.options.cwd).toBe(wt);
    expect(out.agent.cwd).toBe(wt);
    expect(out.agent.issue).toBe(7);
    for (const want of ["issue #7 in acme/widget", "Workspace: start the widget from an issue", "Make the widget start.", out.branch, wt, "never merge", "Closes #7", PR_SECTIONS_INSTRUCTIONS, "do not push, do not open a PR", "Test and observe", "Self-review"]) {
      expect(out.prompt).toContain(want);
    }
    expect(out.agent.prompt).toBe(out.prompt);
    expect(out.board.state).toBe("no board");
    s.h.stopAll("test over");
  });

  test("a repo that already ignores .anvi gets no exclude line; a linked ref is linked too", async () => {
    const s = await setup({ ref: "linked", ignoreAnvi: true });
    const out = await s.fi.start({ project: "widget", issue: 7 });
    const ref = out.links.find((l) => l.kind === "ref")!;
    expect(ref.state).toBe("linked");
    expect(realpathSync(join(out.worktree, "ref"))).toBe(realpathSync(join(s.store, "ref")));
    const exclude = readFileSync(join(s.main, ".git", "info", "exclude"), "utf8").split("\n");
    expect(exclude).not.toContain("/.anvi");
    expect(exclude).toContain("/ref");
    s.h.stopAll("test over");
  });

  test("a project with no ref links nothing for it and says so", async () => {
    const s = await setup({ ref: "none" });
    const out = await s.fi.start({ repo: "acme/widget", issue: 7 });
    expect(out.project).toBe("widget");
    expect(out.links.find((l) => l.kind === "ref")!.state).toBe("none");
    expect(existsSync(join(out.worktree, "ref"))).toBe(false);
    s.h.stopAll("test over");
  });

  test("plan says what start would do and makes nothing", async () => {
    const s = await setup();
    const p = await s.fi.plan({ project: "widget", issue: "7" });
    expect(p.worktree).toBe(join(s.main, ".claude", "worktrees", "issue-7"));
    expect(existsSync(p.worktree)).toBe(false);
    expect(await branches(s.main)).toBe("main");
    expect(s.started).toHaveLength(0);
  });
});

describe("refusals: each says why and makes nothing", () => {
  async function nothingMade(s: Awaited<ReturnType<typeof setup>>) {
    expect(existsSync(join(s.main, ".claude", "worktrees", "issue-7"))).toBe(false);
    expect(s.started).toHaveLength(0);
  }

  test("a closed issue", async () => {
    const s = await setup();
    const e = await refusal(s.fi.start({ project: "widget", issue: 8 }));
    expect([e.status, e.detail?.refusal]).toEqual([409, "closed"]);
    expect(e.message).toContain("closed");
    expect(existsSync(join(s.main, ".claude", "worktrees", "issue-8"))).toBe(false);
    expect(await branches(s.main)).toBe("main");
  });

  test("the worktree already exists", async () => {
    const s = await setup();
    mkdirSync(join(s.main, ".claude", "worktrees", "issue-7"), { recursive: true });
    const e = await refusal(s.fi.start({ project: "widget", issue: 7 }));
    expect([e.status, e.detail?.refusal]).toEqual([409, "worktree-exists"]);
    expect(s.started).toHaveLength(0);
    expect(await branches(s.main)).toBe("main");
  });

  test("the branch already exists, locally or as origin's", async () => {
    const s = await setup();
    await sh(s.main, "branch", "feat/7-start-the-widget-from-an-issue");
    const e = await refusal(s.fi.start({ project: "widget", issue: 7 }));
    expect([e.status, e.detail?.refusal]).toEqual([409, "branch-exists"]);
    await nothingMade(s);
    const t = await setup();
    await sh(t.main, "update-ref", "refs/remotes/origin/feat/7-start-the-widget-from-an-issue", "HEAD");
    const e2 = await refusal(t.fi.start({ project: "widget", issue: 7 }));
    expect([e2.status, e2.detail?.refusal]).toEqual([409, "branch-exists"]);
    expect(e2.message).toContain("refs/remotes/origin/");
    await nothingMade(t);
  });

  test("the main checkout is on the base branch with uncommitted tracked changes", async () => {
    const s = await setup();
    writeFileSync(join(s.main, "README.md"), "changed\n");
    const e = await refusal(s.fi.start({ project: "widget", issue: 7 }));
    expect([e.status, e.detail?.refusal]).toEqual([409, "dirty"]);
    expect(e.message).toContain("README.md");
    await nothingMade(s);
  });

  test("dirt that does not reach the base is not a reason: untracked files, or another branch checked out", async () => {
    const s = await setup();
    writeFileSync(join(s.main, "scratch.txt"), "untracked\n");
    expect((await s.fi.plan({ project: "widget", issue: 7 })).base).toBe("main");
    await sh(s.main, "checkout", "-q", "-b", "other");
    writeFileSync(join(s.main, "README.md"), "changed on other\n");
    expect((await s.fi.plan({ project: "widget", issue: 7 })).base).toBe("main");
  });

  test("a project or repository AnviDeck does not know, and a missing issue", async () => {
    const s = await setup();
    const a = await refusal(s.fi.start({ project: "nope", issue: 7 }));
    expect([a.status, a.detail?.refusal]).toEqual([404, "unknown-project"]);
    const b = await refusal(s.fi.start({ repo: "acme/other", issue: 7 }));
    expect([b.status, b.detail?.refusal]).toEqual([404, "unknown-project"]);
    const c = await refusal(s.fi.start({ project: "widget", repo: "acme/other", issue: 7 }));
    expect([c.status, c.detail?.refusal]).toEqual([409, "unknown-project"]);
    const d = await refusal(s.fi.start({ project: "widget", issue: 999 }));
    expect([d.status, d.detail?.refusal]).toEqual([404, "no-issue"]);
    for (const bad of [{ project: "widget" }, { project: "widget", issue: "x" }, { project: "widget", issue: -1 }, { issue: 7 }]) {
      expect((await refusal(s.fi.start(bad))).status).toBe(400);
    }
    await nothingMade(s);
  });

  test("a project without a GitHub origin", async () => {
    const s = await setup();
    await sh(s.main, "remote", "set-url", "origin", "/somewhere/else.git");
    const e = await refusal(s.fi.start({ project: "widget", issue: 7 }));
    expect([e.status, e.detail?.refusal]).toEqual([409, "no-repo"]);
    await nothingMade(s);
  });

  test("the agent cap is reached: refused before anything is made", async () => {
    const s = await setup({ cap: 1 });
    s.h.start({ cwd: s.root, prompt: "busy" });
    const e = await refusal(s.fi.start({ project: "widget", issue: 7 }));
    expect(e.status).toBe(429);
    // Refused before git or GitHub is asked anything: no worktree is made and then taken away.
    expect(s.calls.filter((c) => c[0] === "gh" || c.includes("worktree"))).toEqual([]);
    expect(existsSync(join(s.main, ".claude", "worktrees", "issue-7"))).toBe(false);
    expect(await branches(s.main)).toBe("main");
    s.h.stopAll("test over");
  });

  test("an agent that cannot start takes its fresh worktree and branch away again", async () => {
    const s = await setup({ claude: null });
    const e = await refusal(s.fi.start({ project: "widget", issue: 7 }));
    expect(e.status).toBe(503);
    expect(existsSync(join(s.main, ".claude", "worktrees", "issue-7"))).toBe(false);
    expect(await branches(s.main)).toBe("main");
    expect(await sh(s.main, "worktree", "list", "--porcelain")).not.toContain("issue-7");
  });
});

describe("the route", () => {
  test("POST /from-issue starts, GET /from-issue/plan previews, refusals carry their reason", async () => {
    const s = await setup();
    const app = new Hono();
    app.route("/api/agents", agentRoutes(s.h, async () => ({ ok: true }) as never, s.fi));
    const post = (b: unknown) => app.request("/api/agents/from-issue", { method: "POST", headers: { origin: "http://localhost", host: "localhost", "content-type": "application/json" }, body: JSON.stringify(b) });
    const plan = await app.request("/api/agents/from-issue/plan?project=widget&issue=7", { headers: { host: "localhost" } });
    expect(plan.status).toBe(200);
    expect(((await plan.json()) as { branch: string }).branch).toBe("feat/7-start-the-widget-from-an-issue");
    const closed = await post({ project: "widget", issue: 8 });
    expect(closed.status).toBe(409);
    expect(((await closed.json()) as { refusal: string }).refusal).toBe("closed");
    const ok = await post({ project: "widget", issue: 7 });
    expect(ok.status).toBe(201);
    const j = (await ok.json()) as { agent: { id: string; cwd: string }; worktree: string };
    expect(j.agent.cwd).toBe(j.worktree);
    const again = await post({ project: "widget", issue: 7 });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { refusal: string }).refusal).toBe("worktree-exists");
    // A write from another page is refused before it reaches the route.
    const foreign = await app.request("/api/agents/from-issue", { method: "POST", headers: { origin: "http://evil.example", host: "localhost" }, body: "{}" });
    expect(foreign.status).toBe(403);
    s.h.stopAll("test over");
  });
});

describe("names and the prompt", () => {
  test("branch kind from labels, slug from the title", () => {
    expect(branchFor({ number: 3, title: "Fix: the login breaks", labels: ["bug"] })).toBe("fix/3-the-login-breaks");
    expect(branchFor({ number: 4, title: "Docs for setup", labels: ["documentation"] })).toBe("chore/4-docs-for-setup");
    expect(branchFor({ number: 5, title: "Add a thing", labels: ["workspace"] })).toBe("feat/5-add-a-thing");
    expect(slugOf("Workspace: start an agent from an issue, in its own worktree")).toBe("start-an-agent-from-an-issue-in-its-own");
    expect(slugOf("!!!")).toBe("issue");
    expect(slugOf("Supercalifragilisticexpialidocious-and-then-some-more-words")).toBe("supercalifragilisticexpialidocious-and");
  });

  test("GitHub remotes in https and ssh forms; anything else is not a GitHub repo", () => {
    expect(githubRepoOf("https://github.com/MrityunjayBhardwaj/AnviDeck.git")).toBe("MrityunjayBhardwaj/AnviDeck");
    expect(githubRepoOf("git@github.com:acme/widget.git\n")).toBe("acme/widget");
    expect(githubRepoOf("ssh://git@github.com/acme/widget")).toBe("acme/widget");
    expect(githubRepoOf("https://gitlab.com/acme/widget.git")).toBeNull();
    expect(githubRepoOf("/local/path.git")).toBeNull();
  });

  test("the prompt keeps the issue apart from the workflow, and the note comes last", () => {
    const p = buildIssuePrompt({ repo: "a/b", number: 9, title: "T", body: "", url: "u", branch: "feat/9-t", base: "main", baseSha: "0123456789abcdef", worktree: "/w", links: [".anvi: /w/.anvi → /s"], note: "  " });
    expect(p).toContain("(the issue has no description)");
    expect(p).toContain("- .anvi: /w/.anvi → /s");
    expect(p).toContain("made from main at 0123456789ab.");
    expect(p).not.toContain("owner's note");
    const withNote = buildIssuePrompt({ repo: "a/b", number: 9, title: "T", body: "b", url: "u", branch: "x", base: "main", baseSha: "0", worktree: "/w", links: [], note: "stop early" });
    expect(withNote.trimEnd().endsWith("stop early")).toBe(true);
  });
});

describe("anvi's own check of the worktree", () => {
  test("reads worktreeLinkGap's answer, and says 'not checked' when the hooks are not there", async () => {
    const d = scratch();
    const hook = join(d, "anvi-paths.js");
    writeFileSync(hook, `exports.worktreeLinkGap = (w) => ({ worktree: w, missing: [{ kind: "ref", target: "/t" }], differs: [{ kind: ".anvi", have: "/h", target: "/t" }] });`);
    const asked = await anviLinkCheck(spawnRun, "/some/worktree", hook);
    expect(asked).toEqual({ state: "asked", missing: ["ref"], differs: [{ kind: ".anvi", have: "/h", target: "/t" }] });
    writeFileSync(join(d, "null.js"), `exports.worktreeLinkGap = () => null;`);
    expect(await anviLinkCheck(spawnRun, "/w", join(d, "null.js"))).toEqual({ state: "asked", missing: [], differs: [] });
    const gone = await anviLinkCheck(spawnRun, "/w", join(d, "absent.js"));
    expect(gone.state).toBe("not checked");
    writeFileSync(join(d, "throws.js"), `exports.worktreeLinkGap = () => { throw new Error("boom") };`);
    expect((await anviLinkCheck(spawnRun, "/w", join(d, "throws.js"))).state).toBe("not checked");
  });
});

describe("the board", () => {
  const board = (nodes: unknown[]) => JSON.stringify({ data: { repository: { projectsV2: { nodes } } } });
  const B = (n: number, options = [{ id: "o1", name: "Todo" }, { id: "o2", name: "In Progress" }]) => ({ id: `PVT_${n}`, number: n, title: `Board ${n}`, owner: { login: "acme" }, field: { id: "F1", options } });
  const fake = (answers: Record<string, { code: number; stdout?: string; stderr?: string }>) => {
    const calls: string[][] = [];
    const run: Run = async (_cmd, args) => {
      calls.push(args);
      const key = args[0] === "api" ? "graphql" : `${args[0]} ${args[1]}`;
      const a = answers[key] ?? { code: 1, stderr: `unexpected ${key}` };
      return { code: a.code, stdout: a.stdout ?? "", stderr: a.stderr ?? "" };
    };
    return { run, calls };
  };
  const url = "https://github.com/acme/widget/issues/7";

  test("no linked board: 'no board', nothing written", async () => {
    const f = fake({ graphql: { code: 0, stdout: board([]) } });
    expect((await moveToInProgress(f.run, "acme/widget", url)).state).toBe("no board");
    expect(f.calls).toHaveLength(1);
  });

  test("one board: the item is added (or got) and its Status set to In Progress, with derived ids", async () => {
    const f = fake({ graphql: { code: 0, stdout: board([B(14)]) }, "project item-add": { code: 0, stdout: JSON.stringify({ id: "ITEM_1" }) }, "project item-edit": { code: 0 } });
    expect(await moveToInProgress(f.run, "acme/widget", url)).toEqual({ state: "moved", board: "#14 Board 14", item: "ITEM_1" });
    expect(f.calls[1]).toEqual(["project", "item-add", "14", "--owner", "acme", "--url", url, "--format", "json"]);
    expect(f.calls[2]).toEqual(["project", "item-edit", "--id", "ITEM_1", "--project-id", "PVT_14", "--field-id", "F1", "--single-select-option-id", "o2"]);
  });

  test("an edit that fails after the add says the item sits in no column", async () => {
    const f = fake({ graphql: { code: 0, stdout: board([B(14)]) }, "project item-add": { code: 0, stdout: JSON.stringify({ id: "ITEM_1" }) }, "project item-edit": { code: 1, stderr: "denied" } });
    const r = await moveToInProgress(f.run, "acme/widget", url);
    expect(r.state).toBe("not moved");
    expect((r as { reason: string }).reason).toContain("Status was NOT set");
  });

  test("several boards, no In Progress column, or GitHub unreachable: not moved, with the reason", async () => {
    const two = await moveToInProgress(fake({ graphql: { code: 0, stdout: board([B(1), B(2)]) } }).run, "acme/widget", url);
    expect(two.state).toBe("not moved");
    expect((two as { reason: string }).reason).toContain("not guessing");
    const cols = await moveToInProgress(fake({ graphql: { code: 0, stdout: board([B(1, [{ id: "o1", name: "Todo" }])]) } }).run, "acme/widget", url);
    expect((cols as { reason: string }).reason).toContain('no Status column named "In Progress"');
    const down = await moveToInProgress(fake({ graphql: { code: 1, stderr: "offline" } }).run, "acme/widget", url);
    expect(down.state).toBe("not moved");
  });

  test("start reports what the board step said", async () => {
    const r = await repo();
    const { run } = runner([OPEN]);
    const { h } = host();
    const fi = new FromIssue(h, { run, projects: () => [{ name: "widget", path: r.main }], linkCheck: noCheck, board: async () => ({ state: "moved", board: "#14 Board 14", item: "I" }) });
    const out = await fi.start({ project: "widget", issue: 7 });
    expect(out.board).toEqual({ state: "moved", board: "#14 Board 14", item: "I" });
    h.stopAll("test over");
  });
});

describe("review follow-ups: a started agent is never reported as a failed start, and a failed read is not 'no issue'", () => {
  test("a board step or link check that throws after the agent started is reported in its own field", async () => {
    const r = await repo();
    const { run } = runner([OPEN]);
    const { h } = host();
    const fi = new FromIssue(h, {
      run,
      projects: () => [{ name: "widget", path: r.main }],
      linkCheck: async () => { throw new Error("hooks gone"); },
      board: async () => { throw new Error("b.field.options is undefined"); },
    });
    const out = await fi.start({ project: "widget", issue: 7 });
    expect(out.agent.id).toBeTruthy();
    expect(out.board.state).toBe("not moved");
    expect((out.board as { reason: string }).reason).toContain("after the agent started");
    expect(out.anviCheck.state).toBe("not checked");
    expect(out.anviCheck.reason).toContain("hooks gone");
    h.stopAll("test over");
  });

  test("a board whose Status field has no options is 'not moved', not an exception", async () => {
    const run: Run = async (_c, args) =>
      args[0] === "api"
        ? { code: 0, stdout: JSON.stringify({ data: { repository: { projectsV2: { nodes: [{ id: "P", number: 3, title: "B", owner: { login: "acme" }, field: {} }] } } } }), stderr: "" }
        : { code: 1, stdout: "", stderr: "unexpected" };
    const res = await moveToInProgress(run, "acme/widget", "https://github.com/acme/widget/issues/7");
    expect(res.state).toBe("not moved");
  });

  test("gh failing for another reason (no auth, offline) answers 502 github-unread, never 404 no-issue", async () => {
    const r = await repo();
    const { run } = runner([OPEN], (args) => (args[0] === "issue" ? { code: 1, stdout: "", stderr: "error connecting to api.github.com" } : null));
    const { h } = host();
    const fi = new FromIssue(h, { run, projects: () => [{ name: "widget", path: r.main }], linkCheck: noCheck, board: noBoard });
    const e = await refusal(fi.start({ project: "widget", issue: 7 }));
    expect([e.status, e.detail?.refusal]).toEqual([502, "github-unread"]);
    const bad = runner([OPEN], (args) => (args[0] === "issue" ? { code: 0, stdout: "not json" } : null));
    const fi2 = new FromIssue(h, { run: bad.run, projects: () => [{ name: "widget", path: r.main }], linkCheck: noCheck, board: noBoard });
    const e2 = await refusal(fi2.start({ project: "widget", issue: 7 }));
    expect([e2.status, e2.detail?.refusal]).toEqual([502, "github-unread"]);
  });
});
