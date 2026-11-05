import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { AgentHost, HostError, type QueryFn } from "../server/agents/host";
import { AgentRegistry } from "../server/agents/registry";
import { loginOnlyEnv, type ClaudeBinary } from "../server/agents/login";
import { FromIssue } from "../server/agents/from-issue";
import { compareWithOrigin, spawnRun, type Run } from "../server/agents/worktree";

/**
 * #136: an agent started from an issue must not start from a local main that is behind
 * origin/main as last fetched. Real git repositories in temp folders; "origin" has a GitHub URL
 * (so the project resolves) but its branch is filled from a local bare repo, never the network.
 */

const dirs: string[] = [];
const scratch = (p = "upstream-") => {
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

async function commit(repo: string, file: string) {
  writeFileSync(join(repo, file), `${file}\n`);
  await sh(repo, "add", "-A");
  await sh(repo, "commit", "-q", "-m", file);
  return sh(repo, "rev-parse", "HEAD");
}

/**
 * `widget` is the main checkout; `upstream` a bare repo standing in for GitHub; `other` a second
 * clone that pushes to it. fetchOrigin() updates refs/remotes/origin/main from the bare repo, as
 * `git fetch` would (a reflog entry included).
 */
async function world() {
  const root = scratch();
  const upstream = join(root, "upstream.git");
  const main = join(root, "widget");
  const other = join(root, "other");
  await spawnRun("git", ["init", "-q", "--bare", "-b", "main", upstream]);
  mkdirSync(main);
  await sh(main, "init", "-q", "-b", "main");
  for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "t"]]) await sh(main, "config", k!, v!);
  await sh(main, "remote", "add", "origin", "https://github.com/acme/widget.git");
  await commit(main, "README.md");
  await sh(main, "push", "-q", upstream, "main:main");
  await spawnRun("git", ["clone", "-q", upstream, other]);
  for (const [k, v] of [["user.email", "o@example.com"], ["user.name", "o"]]) await sh(other, "config", k!, v!);
  const fetchOrigin = () => sh(main, "fetch", "-q", upstream, "+main:refs/remotes/origin/main");
  const pushOther = async (...files: string[]) => {
    for (const f of files) await commit(other, f);
    await sh(other, "push", "-q", "origin", "main");
  };
  return { main, upstream, other, fetchOrigin, pushOther };
}

const CLAUDE: ClaudeBinary = { path: "/fake/bin/claude", realPath: "/fake/lib/claude", fileId: "1:1:1" };
const init = { type: "system", subtype: "init", apiKeySource: "none", session_id: "s1", claude_code_version: "2", model: "m", cwd: "/x", tools: [], mcp_servers: [], permissionMode: "default", slash_commands: [], output_style: "default", uuid: "u" } as unknown as SDKMessage;

function fromIssue(main: string) {
  const prompts: string[] = [];
  const query: QueryFn = ({ prompt, options }) =>
    (async function* () {
      const first = await prompt[Symbol.asyncIterator]().next();
      prompts.push(String((first.value as { message: { content: string } }).message.content));
      yield init;
      await new Promise((_, rej) => options.abortController!.signal.addEventListener("abort", () => rej(new Error("aborted"))));
    })();
  const host = new AgentHost({ registry: new AgentRegistry(scratch("upstream-reg-")), query, resolveClaude: () => CLAUDE, env: () => loginOnlyEnv({ PATH: "/usr/bin" }) });
  const run: Run = async (cmd, args, o) => {
    if (cmd !== "gh") return spawnRun(cmd, args, o);
    if (args[0] === "issue" && args[1] === "view") {
      return { code: 0, stderr: "", stdout: JSON.stringify({ number: 7, title: "Start the widget", body: "b", state: "OPEN", url: "https://github.com/acme/widget/issues/7", labels: [] }) };
    }
    return { code: 1, stdout: "", stderr: "unexpected gh" };
  };
  const fi = new FromIssue(host, {
    run,
    projects: () => [{ name: "widget", path: main }],
    board: async () => ({ state: "no board", reason: "test" }),
    linkCheck: async () => ({ state: "not checked", reason: "test", missing: [], differs: [] }),
  });
  return { fi, host, prompts };
}

async function refusal(p: Promise<unknown>): Promise<HostError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof HostError) return e;
    throw e;
  }
  throw new Error("expected a refusal, got success");
}

describe("start from an issue against origin's main as last fetched (#136)", () => {
  test("local main behind origin/main: the plan says by how much, and the worktree starts from origin/main", async () => {
    const w = await world();
    const localSha = await sh(w.main, "rev-parse", "main");
    await w.pushOther("a.txt", "b.txt", "c.txt");
    await w.fetchOrigin();
    const originSha = await sh(w.main, "rev-parse", "refs/remotes/origin/main");
    const { fi, host, prompts } = fromIssue(w.main);

    const plan = await fi.plan({ project: "widget", issue: 7 });
    expect(plan.upstream.state).toBe("behind");
    expect(plan.upstream.behind).toBe(3);
    expect(plan.upstream.ahead).toBe(0);
    expect(plan.upstream.summary).toContain("3 commits behind origin/main as of the last fetch (");
    expect(plan.startFrom).toBe("origin/main");
    expect(plan.baseSha).toBe(originSha);
    expect(plan.base).toBe("main");

    const out = await fi.start({ project: "widget", issue: 7 });
    expect(await sh(out.worktree, "rev-parse", "HEAD")).toBe(originSha);
    // The main checkout is untouched: its main is where it was.
    expect(await sh(w.main, "rev-parse", "main")).toBe(localSha);
    await new Promise((r) => setTimeout(r, 20));
    expect(prompts[0]).toContain(`made from origin/main at ${originSha.slice(0, 12)}`);
    expect(prompts[0]).toContain("3 commits behind origin/main");
    host.stopAll("test over");
  });

  test("local main at origin/main: starts from main, and says they match", async () => {
    const w = await world();
    await w.fetchOrigin();
    const { fi } = fromIssue(w.main);
    const plan = await fi.plan({ project: "widget", issue: 7 });
    expect(plan.upstream.state).toBe("same");
    expect(plan.startFrom).toBe("main");
    expect(plan.baseSha).toBe(await sh(w.main, "rev-parse", "main"));
    expect(plan.upstream.summary).toContain("main is at origin/main, as of the last fetch");
  });

  test("local main ahead (unpushed commits): starts from main, and says the PR carries them", async () => {
    const w = await world();
    await w.fetchOrigin();
    const mine = await commit(w.main, "local.txt");
    const { fi } = fromIssue(w.main);
    const plan = await fi.plan({ project: "widget", issue: 7 });
    expect(plan.upstream.state).toBe("ahead");
    expect(plan.upstream.ahead).toBe(1);
    expect(plan.startFrom).toBe("main");
    expect(plan.baseSha).toBe(mine);
    expect(plan.upstream.summary).toContain("1 commit ahead of origin/main");
  });

  test("diverged: refused with both counts, and nothing is made", async () => {
    const w = await world();
    await w.pushOther("theirs.txt", "theirs2.txt");
    await w.fetchOrigin();
    await commit(w.main, "mine.txt");
    const { fi } = fromIssue(w.main);
    const e = await refusal(fi.start({ project: "widget", issue: 7 }));
    expect(e.status).toBe(409);
    expect(e.detail?.refusal).toBe("diverged");
    expect(e.message).toContain("has 1 commit that origin/main lacks, and is 2 commits behind it");
    expect(existsSync(join(w.main, ".claude", "worktrees", "issue-7"))).toBe(false);
    expect(await sh(w.main, "branch", "--format=%(refname:short)")).toBe("main");
  });

  test("origin/main never fetched: starts from main, and says the comparison could not be made", async () => {
    const w = await world();
    const { fi } = fromIssue(w.main);
    const plan = await fi.plan({ project: "widget", issue: 7 });
    expect(plan.upstream.state).toBe("unknown");
    expect(plan.startFrom).toBe("main");
    expect(plan.upstream.summary).toContain("could not be checked");
    expect(plan.upstream.summary).not.toContain("is at origin/main");
  });

  test("no local main, origin/main fetched: starts from origin/main; neither: refused", async () => {
    const w = await world();
    await w.fetchOrigin();
    await sh(w.main, "checkout", "-q", "-b", "trunk");
    await sh(w.main, "branch", "-q", "-D", "main");
    const c = await compareWithOrigin(spawnRun, w.main, "main");
    expect(c.state).toBe("no-local");
    expect(c.startFrom).toBe("origin/main");
    await sh(w.main, "update-ref", "-d", "refs/remotes/origin/main");
    const { fi } = fromIssue(w.main);
    const e = await refusal(fi.plan({ project: "widget", issue: 7 }));
    expect(e.detail?.refusal).toBe("no-repo");
    expect(e.message).toContain("neither a local main nor a fetched origin/main");
  });
});
