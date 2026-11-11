import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { AgentHost, HostError, type QueryFn } from "../server/agents/host";
import { AgentRegistry } from "../server/agents/registry";
import { loginOnlyEnv, type ClaudeBinary } from "../server/agents/login";
import { lastSummary, PushPr } from "../server/agents/push-pr";
import { spawnRun, type Run } from "../server/agents/worktree";
import { agentRoutes } from "../server/routes/agents";
import type { PushPlan } from "../shared/push-pr-types";

/**
 * Push and open the PR (#268), against a stand-in remote: a local bare repository is origin, so
 * nothing reaches GitHub. Only `git remote get-url origin` is answered with a GitHub URL (the repo
 * name the PR is opened in), and gh is a stand-in that records what it was asked.
 */

const dirs: string[] = [];
const scratch = (p = "push-pr-") => {
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
const commit = async (dir: string, file: string, msg: string) => {
  writeFileSync(join(dir, file), `${msg}\n`);
  await sh(dir, "add", "-A");
  await sh(dir, "commit", "-q", "-m", msg);
  return sh(dir, "rev-parse", "HEAD");
};

/** origin (bare, with main), and the agent's clone on its own branch with two commits. */
async function world(branch = "feat/268-push") {
  const root = scratch();
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  await spawnRun("git", ["init", "-q", "--bare", "-b", "main", origin]);
  await spawnRun("git", ["init", "-q", "-b", "main", seed]);
  for (const d of [seed]) {
    await sh(d, "config", "user.email", "t@example.com");
    await sh(d, "config", "user.name", "t");
  }
  await commit(seed, "README.md", "first");
  await sh(seed, "push", "-q", origin, "main");
  const wt = join(root, "wt");
  await spawnRun("git", ["clone", "-q", origin, wt]);
  await sh(wt, "config", "user.email", "t@example.com");
  await sh(wt, "config", "user.name", "t");
  await sh(wt, "switch", "-q", "-c", branch);
  await commit(wt, "a.txt", "one");
  const head = await commit(wt, "b.txt", "two");
  return { root, origin, seed, wt, branch, head };
}

type Gh = (args: string[]) => { code: number; stdout: string; stderr: string };
function runner(gh: Gh) {
  const calls: string[][] = [];
  const run: Run = async (cmd, args, opts) => {
    calls.push([cmd, ...args]);
    if (cmd === "gh") return gh(args);
    const i = args.indexOf("get-url");
    if (cmd === "git" && i > 0 && args[i - 1] === "remote" && args[i + 1] === "origin") return { code: 0, stdout: "https://github.com/acme/widget.git\n", stderr: "" };
    return spawnRun(cmd, args, opts);
  };
  return { run, calls };
}
/** A gh with no open PR, that opens #42 when asked. */
const ghNoPr: Gh = (args) => {
  if (args[0] === "pr" && args[1] === "list") return { code: 0, stdout: "[]", stderr: "" };
  if (args[0] === "pr" && args[1] === "create") return { code: 0, stdout: "https://github.com/acme/widget/pull/42\n", stderr: "" };
  if (args[0] === "issue" && args[1] === "view") return { code: 0, stdout: JSON.stringify({ title: "Push the widget", body: "The issue's body." }), stderr: "" };
  return { code: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
};

const CLAUDE: ClaudeBinary = { path: "/usr/local/bin/claude", realPath: "/usr/local/bin/claude" } as ClaudeBinary;
const init = { type: "system", subtype: "init", apiKeySource: "none", session_id: "s1", claude_code_version: "2", model: "m", cwd: "/x", tools: [], mcp_servers: [], permissionMode: "default", slash_commands: [], output_style: "default", uuid: "u" } as unknown as SDKMessage;
const done = (text: string) => ({ type: "result", subtype: "success", is_error: false, result: text, total_cost_usd: 0, num_turns: 1, duration_ms: 1, duration_api_ms: 1, stop_reason: null, usage: {}, modelUsage: {}, session_id: "s1", uuid: "u2" }) as unknown as SDKMessage;

/** A host whose agents finish at once with `summary`, or keep running until stopped. */
function host(o: { keepRunning?: boolean; summary?: string } = {}) {
  const query: QueryFn = ({ options }: { options: Options }) =>
    (async function* () {
      yield init;
      if (o.keepRunning) await new Promise((_, rej) => options.abortController!.signal.addEventListener("abort", () => rej(new Error("aborted"))));
      yield done(o.summary ?? "Pushed nothing; added a and b.");
    })();
  return new AgentHost({ registry: new AgentRegistry(scratch("push-pr-reg-")), query, resolveClaude: () => CLAUDE, env: () => loginOnlyEnv({ PATH: "/usr/bin" }), cap: 3 });
}
const until = async (f: () => boolean) => {
  for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 10));
  if (!f()) throw new Error("timed out");
};
async function finished(h: AgentHost, cwd: string, issue?: number) {
  const a = h.start({ cwd, prompt: "Add a and b\nmore words", issue });
  await until(() => h.get(a.id).status === "done" && !h.get(a.id).running);
  return a.id;
}
const refused = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof HostError) return e;
    throw e;
  }
  throw new Error("expected a refusal");
};
const remoteRef = async (origin: string, ref: string) => {
  const r = await spawnRun("git", ["--git-dir", origin, "rev-parse", "--verify", "--quiet", ref]);
  return r.code === 0 ? r.stdout.trim() : null;
};

describe("push and open the PR (#268)", () => {
  test("the plan says the branch, the exact commit, the commits not on main, and a proposed PR", async () => {
    const w = await world();
    const h = host({ summary: "Added a and b." });
    const id = await finished(h, w.wt, 268);
    const { run } = runner(ghNoPr);
    const p = await new PushPr(h, { run }).plan(id);
    expect(p.ok).toBe(true);
    const plan = (p as { plan: PushPlan }).plan;
    expect(plan).toMatchObject({ repo: "acme/widget", branch: w.branch, head: w.head, base: "main", commitCount: 2, remote: { state: "new" }, openPr: null, uncommitted: 0 });
    expect(plan.commits.map((c) => c.subject)).toEqual(["two", "one"]);
    expect(plan).toMatchObject({ title: "Push the widget", body: "Added a and b.\n\nCloses #268", bodyFrom: "agent's last summary" });
  });

  test("pressing pushes exactly that commit to the branch's own name, leaves main alone, and opens the PR on that base", async () => {
    const w = await world();
    const h = host();
    const id = await finished(h, w.wt);
    const mainBefore = await remoteRef(w.origin, "refs/heads/main");
    const { run, calls } = runner(ghNoPr);
    const r = await new PushPr(h, { run }).push(id, { branch: w.branch, head: w.head, title: "T", body: "B" });
    expect(r).toEqual({ pushed: true, repo: "acme/widget", branch: w.branch, head: w.head, pr: { state: "created", number: 42, url: "https://github.com/acme/widget/pull/42" } });
    expect(await remoteRef(w.origin, `refs/heads/${w.branch}`)).toBe(w.head);
    expect(await remoteRef(w.origin, "refs/heads/main")).toBe(mainBefore);
    const push = calls.find((c) => c[0] === "git" && c.includes("push"))!;
    expect(push.slice(-2)).toEqual(["origin", `${w.head}:refs/heads/${w.branch}`]);
    expect(push.some((a) => a.startsWith("+") || a === "--force" || a === "-f" || a.startsWith("--force"))).toBe(false);
    expect(calls.find((c) => c[0] === "gh" && c[2] === "create")).toEqual(["gh", "pr", "create", "--repo", "acme/widget", "--base", "main", "--head", w.branch, "--title", "T", "--body", "B"]);
  });

  test("main is never pushed: an agent whose worktree is on main is refused, and origin's main does not move", async () => {
    const w = await world();
    await sh(w.wt, "switch", "-q", "main");
    const head = await commit(w.wt, "c.txt", "on main");
    const h = host();
    const id = await finished(h, w.wt);
    const { run, calls } = runner(ghNoPr);
    const pp = new PushPr(h, { run });
    expect(await pp.plan(id)).toMatchObject({ ok: false, refusal: "base-branch" });
    const mainBefore = await remoteRef(w.origin, "refs/heads/main");
    const e = await refused(pp.push(id, { branch: "main", head, title: "T" }));
    expect(e.status).toBe(409);
    expect(e.detail?.refusal).toBe("base-branch");
    expect(await remoteRef(w.origin, "refs/heads/main")).toBe(mainBefore);
    expect(calls.some((c) => c.includes("push"))).toBe(false);
  });

  test("refused while the agent runs, and nothing is pushed", async () => {
    const w = await world();
    const h = host({ keepRunning: true });
    const a = h.start({ cwd: w.wt, prompt: "x" });
    await until(() => h.get(a.id).running);
    const { run, calls } = runner(ghNoPr);
    const pp = new PushPr(h, { run });
    expect(await pp.plan(a.id)).toMatchObject({ ok: false, refusal: "running" });
    const e = await refused(pp.push(a.id, { branch: w.branch, head: w.head, title: "T" }));
    expect(e.detail?.refusal).toBe("running");
    expect(calls.some((c) => c.includes("push"))).toBe(false);
    expect(await remoteRef(w.origin, `refs/heads/${w.branch}`)).toBeNull();
    h.stopAll("test over");
  });

  test("a commit made after the card showed it is refused; a branch the card did not show is refused", async () => {
    const w = await world();
    const h = host();
    const id = await finished(h, w.wt);
    await commit(w.wt, "late.txt", "late");
    const { run } = runner(ghNoPr);
    const pp = new PushPr(h, { run });
    expect((await refused(pp.push(id, { branch: w.branch, head: w.head, title: "T" }))).detail?.refusal).toBe("head-moved");
    expect((await refused(pp.push(id, { branch: "feat/other", head: w.head, title: "T" }))).detail?.refusal).toBe("branch-moved");
    expect(await remoteRef(w.origin, `refs/heads/${w.branch}`)).toBeNull();
  });

  test("never a force push: origin's branch with commits this one lacks is left as it was", async () => {
    const w = await world();
    // Someone else's commit on the same branch name on origin.
    await sh(w.seed, "switch", "-q", "-c", w.branch);
    const theirs = await commit(w.seed, "x.txt", "theirs");
    await sh(w.seed, "push", "-q", w.origin, w.branch);
    const h = host();
    const id = await finished(h, w.wt);
    const { run, calls } = runner(ghNoPr);
    const pp = new PushPr(h, { run });
    const plan = await pp.plan(id);
    expect(plan).toMatchObject({ ok: true, plan: { remote: { state: "at", sha: theirs } } });
    const e = await refused(pp.push(id, { branch: w.branch, head: w.head, title: "T" }));
    expect(e.detail?.refusal).toBe("not-fast-forward");
    expect(await remoteRef(w.origin, `refs/heads/${w.branch}`)).toBe(theirs);
    expect(calls.some((c) => c[0] === "gh" && c[2] === "create")).toBe(false);
  });

  test("with a PR already open from the branch, it pushes to it and opens no second one", async () => {
    const w = await world();
    const h = host();
    const id = await finished(h, w.wt);
    const { run, calls } = runner((args) =>
      args[1] === "list" ? { code: 0, stdout: JSON.stringify([{ number: 7, url: "https://github.com/acme/widget/pull/7" }]), stderr: "" } : ghNoPr(args),
    );
    const r = await new PushPr(h, { run }).push(id, { branch: w.branch, head: w.head, title: "T" });
    expect(r.pr).toEqual({ state: "existing", number: 7, url: "https://github.com/acme/widget/pull/7" });
    expect(await remoteRef(w.origin, `refs/heads/${w.branch}`)).toBe(w.head);
    expect(calls.some((c) => c[0] === "gh" && c[2] === "create")).toBe(false);
  });

  test("pushed but the PR failed says both: 502 naming the commit that was pushed", async () => {
    const w = await world();
    const h = host();
    const id = await finished(h, w.wt);
    const { run } = runner((args) => (args[1] === "create" ? { code: 1, stdout: "", stderr: "GraphQL: something" } : ghNoPr(args)));
    const e = await refused(new PushPr(h, { run }).push(id, { branch: w.branch, head: w.head, title: "T" }));
    expect(e.status).toBe(502);
    expect(e.detail?.refusal).toBe("pushed-pr-failed");
    expect(e.message).toContain(`pushed ${w.branch} at ${w.head.slice(0, 7)}`);
    expect(await remoteRef(w.origin, `refs/heads/${w.branch}`)).toBe(w.head);
  });

  test("nothing ahead of main is not offered; uncommitted files are counted and not pushed", async () => {
    const w = await world();
    await sh(w.wt, "switch", "-q", "-c", "feat/empty", "origin/main");
    const h = host();
    const id = await finished(h, w.wt);
    const { run } = runner(ghNoPr);
    expect(await new PushPr(h, { run }).plan(id)).toMatchObject({ ok: false, refusal: "nothing" });
    await sh(w.wt, "switch", "-q", w.branch);
    writeFileSync(join(w.wt, "loose.txt"), "not committed\n");
    expect(await new PushPr(h, { run }).plan(id)).toMatchObject({ ok: true, plan: { uncommitted: 1 } });
  });

  test("a commit that lands between the check and the push is not sent: the push names the commit the card showed", async () => {
    const w = await world();
    const h = host();
    const id = await finished(h, w.wt);
    const { run: base } = runner(ghNoPr);
    let late = "";
    const run: Run = async (cmd, args, opts) => {
      // Just before git pushes, something commits on the branch.
      if (cmd === "git" && args.includes("push") && !late) late = await commit(w.wt, "late.txt", "late");
      return base(cmd, args, opts);
    };
    await new PushPr(h, { run }).push(id, { branch: w.branch, head: w.head, title: "T" });
    expect(late).not.toBe("");
    expect(await sh(w.wt, "rev-parse", w.branch)).toBe(late);
    expect(await remoteRef(w.origin, `refs/heads/${w.branch}`)).toBe(w.head);
  });

  test("a second press while the first is pushing is refused, and one PR is opened", async () => {
    const w = await world();
    const h = host();
    const id = await finished(h, w.wt);
    const { run: base, calls } = runner(ghNoPr);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const run: Run = async (cmd, args, opts) => {
      if (cmd === "git" && args.includes("push")) await gate;
      return base(cmd, args, opts);
    };
    const pp = new PushPr(h, { run });
    const first = pp.push(id, { branch: w.branch, head: w.head, title: "T" });
    await until(() => calls.some((c) => c[0] === "git" && c.includes("symbolic-ref")));
    const second = await refused(pp.push(id, { branch: w.branch, head: w.head, title: "T" }));
    expect(second.detail?.refusal).toBe("busy");
    release();
    expect((await first).pushed).toBe(true);
    expect(calls.filter((c) => c[0] === "gh" && c[2] === "create")).toHaveLength(1);
  });

  test("the last summary is the last result Claude Code sent, else none", () => {
    const line = (seq: number, message: unknown, from: "sdk" | "host" = "sdk") => ({ seq, at: "t", from, message });
    expect(lastSummary([line(1, done("first")), line(2, { type: "assistant" }), line(3, done("second"))])).toBe("second");
    expect(lastSummary([line(1, done("  "))])).toBeNull();
    expect(lastSummary([line(1, done("from the host"), "host")])).toBeNull();
  });

  test("over the route: the plan is a GET, the push a POST that answers 201, a refusal 409 with its kind", async () => {
    const w = await world();
    const h = host();
    const id = await finished(h, w.wt);
    const { run } = runner(ghNoPr);
    const app = new Hono();
    app.route("/api/agents", agentRoutes(h, async () => ({ ok: true, authMethod: "claude.ai", plan: "max" }), undefined, new PushPr(h, { run })));
    const hdr = { host: "localhost:4475", origin: "http://localhost:4475", "content-type": "application/json" };
    const plan = (await (await app.request(`http://localhost:4475/api/agents/${id}/push-pr`, { headers: hdr })).json()) as { ok: boolean; plan: PushPlan };
    expect(plan.plan.head).toBe(w.head);
    const post = (b: unknown) => app.request(`http://localhost:4475/api/agents/${id}/push-pr`, { method: "POST", headers: hdr, body: JSON.stringify(b) });
    const bad = await post({ branch: w.branch, head: "0".repeat(40), title: "T" });
    expect(bad.status).toBe(409);
    expect(((await bad.json()) as { refusal: string }).refusal).toBe("head-moved");
    expect((await post({ branch: w.branch, head: w.head, title: "" })).status).toBe(400);
    expect((await post({ branch: w.branch, head: w.head, title: "T" })).status).toBe(201);
  });
});
