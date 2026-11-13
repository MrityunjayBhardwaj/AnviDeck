/**
 * Checkpoints per agent turn (#248): capture, what each turn changed, Undo and its refusals,
 * clean-up, and the owner's build test: no file from a snapshot can ever be committed to the store.
 *
 * Real git on scratch repositories; the agent is a fake query() that edits the folder as a turn would.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { AgentHost, HostError, type QueryFn } from "../server/agents/host";
import { AgentRegistry } from "../server/agents/registry";
import { loginOnlyEnv, type ClaudeBinary } from "../server/agents/login";
import { CheckpointStore, IGNORE_ALL } from "../server/agents/checkpoints";
import { AgentTurns } from "../server/agents/turns";
import type { CheckpointEntry } from "../shared/checkpoint-types";

const dirs: string[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "ckpt-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** Runs a command with no GIT_* variable from this process, so the checks see what is on disk. */
const sh = (cmd: string[], cwd: string, env?: Record<string, string>) => {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))) as Record<string, string>;
  const r = Bun.spawnSync(cmd, { cwd, env: { ...clean, ...env } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};

/** A git checkout with one commit, a gitignored file and an untracked one. */
function project(): string {
  const p = join(scratch(), "proj");
  mkdirSync(p);
  sh(["git", "init", "-q", "-b", "main"], p);
  writeFileSync(join(p, "a.txt"), "a\n");
  writeFileSync(join(p, ".gitignore"), "ignored.log\n");
  sh(["git", "add", "."], p);
  sh(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], p);
  writeFileSync(join(p, "ignored.log"), "ignored\n");
  writeFileSync(join(p, "u.env"), "untracked\n");
  return p;
}

const checkpoints = (store: CheckpointStore, id: string) => store.read(id).records.filter((r): r is CheckpointEntry => r.kind === "checkpoint");

describe("the checkpoint store", () => {
  test("a checkpoint holds tracked and untracked files, not ignored ones; the next lists what changed", async () => {
    const p = project();
    const store = new CheckpointStore(join(scratch(), "agentdir"));
    const c1 = await store.capture("ag1", p, { when: "before-run", run: 1 });
    expect(c1?.changeCount).toBe(0);
    const files = sh(["git", `--git-dir=${store.repoOf("ag1")}`, "ls-tree", "-r", "--name-only", c1!.tree], p).out.trim().split("\n");
    expect(files.sort()).toEqual([".gitignore", "a.txt", "u.env"]);
    writeFileSync(join(p, "a.txt"), "a\nb\n");
    rmSync(join(p, "u.env"));
    writeFileSync(join(p, "n.txt"), "n\n");
    const c2 = await store.capture("ag1", p, { when: "after-turn", run: 1 });
    expect(c2?.changes).toEqual([
      { path: "a.txt", status: "M", added: 1, removed: 0 },
      { path: "n.txt", status: "A", added: 1, removed: 0 },
      { path: "u.env", status: "D", added: 0, removed: 1 },
    ]);
    expect(c2?.head).toEqual({ sha: expect.stringMatching(/^[0-9a-f]{40}$/), branch: "main" });
    // Nothing was written into the project's repository: its status is what the edits made it.
    expect(sh(["git", "status", "--porcelain"], p).out.split("\n").filter(Boolean).sort()).toEqual([" M a.txt", "?? n.txt"]);
  });

  test("checkpoints/ ignores itself before any snapshot is written", async () => {
    const dir = join(scratch(), "agentdir");
    const store = new CheckpointStore(dir);
    await store.capture("ag1", project(), { when: "before-run", run: 1 });
    expect(readFileSync(join(dir, "checkpoints", ".gitignore"), "utf8")).toBe(IGNORE_ALL);
  });

  test("Undo puts the folder back: added files go, deleted ones return, ignored ones stay; it can be undone too", async () => {
    const p = project();
    const store = new CheckpointStore(join(scratch(), "agentdir"));
    await store.capture("ag1", p, { when: "before-run", run: 1 });
    writeFileSync(join(p, "a.txt"), "changed\n");
    rmSync(join(p, "u.env"));
    writeFileSync(join(p, "n.txt"), "n\n");
    writeFileSync(join(p, "ignored.log"), "ignored, changed\n");
    await store.capture("ag1", p, { when: "after-turn", run: 1 });
    const now = await store.snapshot("ag1", p);
    const r = await store.undo("ag1", p, 1, now.tree, 1);
    expect(readFileSync(join(p, "a.txt"), "utf8")).toBe("a\n");
    expect(readFileSync(join(p, "u.env"), "utf8")).toBe("untracked\n");
    expect(existsSync(join(p, "n.txt"))).toBe(false);
    expect(readFileSync(join(p, "ignored.log"), "utf8")).toBe("ignored, changed\n");
    expect(r.after.undoTo).toBe(1);
    expect(r.after.tree).toBe(checkpoints(store, "ag1")[0]!.tree);
    // The Undo is undone: back to the checkpoint taken just before it.
    const again = await store.snapshot("ag1", p);
    await store.undo("ag1", p, r.before.n, again.tree, 1);
    expect(readFileSync(join(p, "a.txt"), "utf8")).toBe("changed\n");
    expect(existsSync(join(p, "n.txt"))).toBe(true);
  });

  test("Undo is refused when the folder changed after the preview, and nothing is put back", async () => {
    const p = project();
    const store = new CheckpointStore(join(scratch(), "agentdir"));
    await store.capture("ag1", p, { when: "before-run", run: 1 });
    writeFileSync(join(p, "a.txt"), "turn\n");
    const seen = await store.snapshot("ag1", p);
    writeFileSync(join(p, "a.txt"), "edited after the preview\n");
    await expect(store.undo("ag1", p, 1, seen.tree, 1)).rejects.toMatchObject({ status: 409, refusal: "folder-moved" });
    expect(readFileSync(join(p, "a.txt"), "utf8")).toBe("edited after the preview\n");
  });

  test("after Clear, no checkpoint before it can be undone to, and the record says so", async () => {
    const p = project();
    const store = new CheckpointStore(join(scratch(), "agentdir"));
    await store.capture("ag1", p, { when: "before-run", run: 1 });
    await store.clear("ag1", "cleared by you");
    expect(store.kept("ag1")).toBe(false);
    expect(store.undoable("ag1")).toEqual([]);
    await expect(store.target("ag1", p, 1)).rejects.toMatchObject({ status: 404, refusal: "cleared" });
    expect(store.read("ag1").records.map((r) => r.kind)).toEqual(["checkpoint", "cleared"]);
    // A checkpoint after the Clear starts afresh: no changes counted against the cleared one, a new number.
    const c = await store.capture("ag1", p, { when: "before-run", run: 2 });
    expect(c).toMatchObject({ n: 2, changeCount: 0 });
    // Its snapshots are kept again, but only the new checkpoint can be undone to.
    expect(store.kept("ag1")).toBe(true);
    expect(store.undoable("ag1").map((x) => x.n)).toEqual([2]);
    await expect(store.target("ag1", p, 1)).rejects.toMatchObject({ status: 404, refusal: "cleared" });
  });

  test("git variables in the server's environment (e.g. started from a git hook) do not redirect a snapshot", async () => {
    const p = project();
    const elsewhere = project();
    const store = new CheckpointStore(join(scratch(), "agentdir"));
    const saved = { dir: process.env.GIT_DIR, index: process.env.GIT_INDEX_FILE, tree: process.env.GIT_WORK_TREE };
    process.env.GIT_DIR = join(elsewhere, ".git");
    process.env.GIT_INDEX_FILE = join(elsewhere, ".git", "index");
    process.env.GIT_WORK_TREE = elsewhere;
    try {
      writeFileSync(join(p, "only-here.txt"), "x\n");
      const c = await store.capture("ag1", p, { when: "before-run", run: 1 });
      const files = sh(["git", `--git-dir=${store.repoOf("ag1")}`, "ls-tree", "-r", "--name-only", c!.tree], p);
      expect(files.out).toContain("only-here.txt");
    } finally {
      for (const [k, v] of [["GIT_DIR", saved.dir], ["GIT_INDEX_FILE", saved.index], ["GIT_WORK_TREE", saved.tree]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    // The other checkout's index was not touched.
    expect(sh(["git", "status", "--porcelain"], elsewhere).out.trim().split("\n").sort()).toEqual(["?? u.env"]);
  });

  test("an index.lock left by a stopped git step is removed once it is older than the time limit, not before", async () => {
    const p = project();
    const store = new CheckpointStore(join(scratch(), "agentdir"), { lockStaleMs: 60_000 });
    await store.capture("ag1", p, { when: "before-run", run: 1 });
    const lock = join(store.repoOf("ag1"), "index.lock");
    writeFileSync(lock, "");
    // A fresh lock may be another git step's: the snapshot fails (and says so), the lock stays.
    expect(await store.capture("ag1", p, { when: "after-turn", run: 1 })).toBeNull();
    expect(existsSync(lock)).toBe(true);
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    expect(await store.capture("ag1", p, { when: "after-turn", run: 1 })).not.toBeNull();
    expect(existsSync(lock)).toBe(false);
  });

  test("a snapshot that cannot be taken is recorded as failed, never thrown", async () => {
    const store = new CheckpointStore(join(scratch(), "agentdir"));
    const c = await store.capture("ag1", join(scratch(), "no-such-folder"), { when: "before-run", run: 1 });
    expect(c).toBeNull();
    expect(store.read("ag1").records).toEqual([expect.objectContaining({ kind: "checkpoint-failed", when: "before-run", reason: expect.stringContaining("no longer exists") })]);
  });
});

describe("no file from a snapshot is ever committed to the store (the owner's build test)", () => {
  /** A store like ~/.anvideck: a git repository, with AnviDeck's folder inside and one commit. */
  function storeWithSnapshot() {
    const root = join(scratch(), "store");
    const agentDir = join(root, "anvideck");
    mkdirSync(agentDir, { recursive: true });
    sh(["git", "init", "-q", "-b", "main"], root);
    writeFileSync(join(root, "README.md"), "store\n");
    sh(["git", "add", "."], root);
    sh(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], root);
    const p = project();
    // A known untracked file in the agent's folder: its content is what must never reach the store.
    const secret = `token-${crypto.randomUUID()}\n`;
    writeFileSync(join(p, "local.env"), secret);
    const blobId = sh(["git", "hash-object", join(p, "local.env")], p).out.trim();
    return { root, agentDir, p, blobId };
  }

  const inStore = (root: string, blobId: string) => ({
    paths: sh(["git", "log", "--all", "--name-only", "--format="], root).out.split("\n").filter((l) => l.includes("checkpoints")),
    blob: sh(["git", "cat-file", "-e", blobId], root).code === 0,
    record: sh(["git", "log", "--all", "--name-only", "--format="], root).out.split("\n").filter((l) => l.startsWith("anvideck/turns/")),
  });

  test("git add -A and commit in the store take the record, never the snapshot", async () => {
    const { root, agentDir, p, blobId } = storeWithSnapshot();
    const store = new CheckpointStore(agentDir);
    const c = await store.capture("ag1", p, { when: "before-run", run: 1 });
    // The snapshot does hold the file (so the test is not passing on an empty snapshot).
    expect(sh(["git", `--git-dir=${store.repoOf("ag1")}`, "cat-file", "-e", blobId], p).code).toBe(0);
    expect(c).not.toBeNull();
    sh(["git", "add", "-A"], root);
    sh(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "sweep"], root);
    expect(inStore(root, blobId)).toEqual({ paths: [], blob: false, record: ["anvideck/turns/ag1.jsonl"] });
  });

  const HOOK = join(homedir(), ".claude", "hooks", "anvideck-checkpoint.js");
  test.skipIf(!existsSync(HOOK))("the store's own commit hook takes the record, never the snapshot", async () => {
    const { root, agentDir, p, blobId } = storeWithSnapshot();
    const store = new CheckpointStore(agentDir);
    await store.capture("ag1", p, { when: "before-run", run: 1 });
    // The real hook, pointed at the scratch store and a scratch ~/.claude; no remote, so its push fails quietly.
    const claudeDir = join(scratch(), "claude");
    mkdirSync(claudeDir);
    const r = Bun.spawnSync(["node", HOOK], {
      cwd: p,
      stdin: new TextEncoder().encode("{}"),
      env: { ...process.env, ANVIDECK_DIR: root, CLAUDE_DIR: claudeDir, ANVIDECK_QUIET_SECONDS: "0.001" },
    });
    expect(r.exitCode).toBe(0);
    // The hook did commit (else this would pass on a hook that did nothing).
    expect(sh(["git", "log", "-1", "--format=%s"], root).out).toContain("auto-checkpoint");
    expect(inStore(root, blobId)).toEqual({ paths: [], blob: false, record: ["anvideck/turns/ag1.jsonl"] });
  });
});

// ── the agent host takes them at turn boundaries ──────────────────────────────────────────────

const CLAUDE: ClaudeBinary = { path: "/fake/bin/claude", realPath: "/fake/lib/claude", fileId: "1:1:1" };
const init = { type: "system", subtype: "init", apiKeySource: "none", session_id: "sess-1", claude_code_version: "x", model: "m", cwd: "/x", tools: [], mcp_servers: [], permissionMode: "default", slash_commands: [], output_style: "default", uuid: "u" } as unknown as SDKMessage;
const result = { type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0, num_turns: 1, duration_ms: 1, duration_api_ms: 1, stop_reason: null, usage: {}, modelUsage: {}, session_id: "sess-1", uuid: "u3" } as unknown as SDKMessage;
type Script = (o: Options) => AsyncGenerator<SDKMessage>;

function hostWith(script: Script, opts: { sessions?: ConstructorParameters<typeof AgentTurns>[1]["sessions"]; dir?: string } = {}) {
  const dir = opts.dir ?? scratch();
  const registry = new AgentRegistry(dir);
  const store = new CheckpointStore(dir);
  const firstTurnSaw: { files: string[] }[] = [];
  const query: QueryFn = ({ prompt, options }) =>
    (async function* () {
      const it = (prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
      await it.next();
      // What the record held when Claude Code started: the before-run checkpoint must be there already.
      firstTurnSaw.push({ files: store.read(registry.load()[0]?.id ?? "").records.map((r) => r.kind) });
      yield* script(options);
    })();
  const host = new AgentHost({
    registry,
    query,
    resolveClaude: () => CLAUDE,
    env: () => loginOnlyEnv({ PATH: "/usr/bin" }),
    cap: 3,
    checkpoints: store,
    githubAccess: () => ({ status: "ok", access: "your-login", source: "default", file: join(dir, "settings.json") }) as never,
    emit: () => {},
  });
  const turns = new AgentTurns(host, { sessions: opts.sessions ?? (() => ({ sessions: [], report: { status: "ok", errors: [] } as never })) });
  return { host, store, turns, dir, firstTurnSaw };
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 4000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await tick();
  }
}
const whens = (store: CheckpointStore, id: string) => checkpoints(store, id).map((c) => c.when);

describe("the agent host takes a checkpoint before each run and after each turn", () => {
  test("before the run (taken before Claude Code starts), then the turn's changes when its result comes", async () => {
    const p = project();
    const { host, store, firstTurnSaw } = hostWith(async function* (o) {
      yield init;
      writeFileSync(join(o.cwd!, "made-by-turn.txt"), "x\n");
      yield result;
    });
    const a = host.start({ cwd: p, prompt: "go" });
    await until(() => whens(store, a.id).length === 2 && !host.get(a.id).running);
    expect(firstTurnSaw[0]!.files).toEqual(["checkpoint"]);
    const [before, after] = checkpoints(store, a.id);
    expect(before).toMatchObject({ n: 1, when: "before-run", run: 1, changeCount: 0 });
    expect(after).toMatchObject({ n: 2, when: "after-turn", run: 1, changes: [{ path: "made-by-turn.txt", status: "A", added: 1, removed: 0 }] });
  });

  test("a run stopped mid-turn still gets the turn's checkpoint; a resume's first one lists changes made outside the agent", async () => {
    const p = project();
    let resumed = false;
    const { host, store } = hostWith(async function* (o) {
      yield init;
      if (resumed) {
        yield result;
        return;
      }
      writeFileSync(join(o.cwd!, "half.txt"), "half\n");
      await new Promise<never>((_, rej) => o.abortController!.signal.addEventListener("abort", () => rej(new Error("aborted"))));
    });
    const a = host.start({ cwd: p, prompt: "go" });
    await until(() => existsSync(join(p, "half.txt")));
    host.stop(a.id);
    await until(() => whens(store, a.id).length === 2 && !host.get(a.id).running);
    expect(checkpoints(store, a.id)[1]).toMatchObject({ when: "run-ended", reason: "stopped by you", changes: [{ path: "half.txt", status: "A" }] });
    writeFileSync(join(p, "by-you.txt"), "you\n");
    resumed = true;
    host.resume(a.id, "again");
    await until(() => whens(store, a.id).length === 4 && !host.get(a.id).running);
    expect(checkpoints(store, a.id)[2]).toMatchObject({ when: "before-run", run: 2, changes: [{ path: "by-you.txt", status: "A" }] });
    expect(whens(store, a.id)).toEqual(["before-run", "run-ended", "before-run", "after-turn"]);
  });

  test("an agent stopped while its first checkpoint is taken never starts Claude Code", async () => {
    const p = project();
    let started = 0;
    const { host, store } = hostWith(async function* () {
      started++;
      yield init;
      yield result;
    });
    const a = host.start({ cwd: p, prompt: "go" });
    host.stop(a.id);
    await until(() => !host.get(a.id).running);
    await tick(50);
    expect(started).toBe(0);
    expect(host.get(a.id).status).toBe("stopped");
    expect(whens(store, a.id)).toEqual(["before-run"]);
  });
});

describe("Undo through the routes' side (AgentTurns)", () => {
  async function finished() {
    const p = project();
    let hang = false;
    const h = hostWith(async function* (o) {
      yield init;
      if (hang) await new Promise<never>((_, rej) => o.abortController!.signal.addEventListener("abort", () => rej(new Error("aborted"))));
      writeFileSync(join(o.cwd!, "a.txt"), "the turn's\n");
      yield result;
    });
    const a = h.host.start({ cwd: p, prompt: "go" });
    await until(() => whens(h.store, a.id).length === 2 && !h.host.get(a.id).running);
    return { ...h, p, id: a.id, hangNext: () => (hang = true) };
  }

  test("preview, then press: the folder is put back and the answer names the checkpoints around it", async () => {
    const { turns, id, p, store } = await finished();
    expect(turns.list(id)).toMatchObject({ undoable: [1, 2], undo: { ok: true }, kept: true, folderGone: false });
    const plan = await turns.plan(id, "1");
    expect(plan.discarded).toEqual([{ path: "a.txt", status: "M", added: 1, removed: 1 }]);
    // The preview wrote nothing to the record.
    expect(whens(store, id)).toEqual(["before-run", "after-turn"]);
    const r = await turns.undo(id, "1", { current: plan.current });
    expect(r).toMatchObject({ to: 1, before: 3, after: 4, changeCount: 1 });
    expect(readFileSync(join(p, "a.txt"), "utf8")).toBe("a\n");
  });

  test("refused while the agent runs", async () => {
    const p = project();
    const { host, turns, store } = hostWith(async function* (o) {
      yield init;
      await new Promise<never>((_, rej) => o.abortController!.signal.addEventListener("abort", () => rej(new Error("aborted"))));
    });
    const a = host.start({ cwd: p, prompt: "go" });
    await until(() => whens(store, a.id).length === 1 && host.get(a.id).status === "working");
    expect(turns.list(a.id).undo).toEqual({ ok: false, why: "it is working; stop it first" });
    await expect(turns.plan(a.id, "1")).rejects.toMatchObject({ status: 409 });
    await expect(turns.undo(a.id, "1", { current: "0".repeat(40) })).rejects.toMatchObject({ status: 409 });
    host.stop(a.id);
  });

  test("refused while another agent works in the same folder", async () => {
    const { host, turns, id, p, store, hangNext } = await finished();
    // A second agent in the same folder that keeps working until stopped.
    hangNext();
    const second = host.start({ cwd: p, prompt: "second" });
    await until(() => whens(store, second.id).length === 1 && host.get(second.id).status === "working");
    expect(turns.list(id).undo).toEqual({ ok: false, why: `agent ${second.id} is working in ${p}` });
    host.stop(second.id);
    await until(() => !host.get(second.id).running);
    expect(turns.list(id).undo).toEqual({ ok: true, warnings: [] });
  });

  test("refused while a terminal Claude Code session works in the folder, and when the sessions cannot be read", async () => {
    const p = project();
    let sessions: ReturnType<NonNullable<ConstructorParameters<typeof AgentTurns>[1]["sessions"]>> = { sessions: [], report: { status: "ok", errors: [] } as never };
    const h = hostWith(async function* () {
      yield init;
      yield result;
    }, { sessions: () => sessions });
    const a = h.host.start({ cwd: p, prompt: "go" });
    await until(() => whens(h.store, a.id).length === 2 && !h.host.get(a.id).running);
    sessions = { sessions: [{ sessionId: "abcdef12-x", pid: 42, cwd: p, status: "busy" }], report: { status: "ok", errors: [] } as never };
    expect(h.turns.list(a.id).undo).toEqual({ ok: false, why: expect.stringContaining("a terminal Claude Code session (abcdef12, pid 42)") });
    // In a folder inside the agent's: refused too.
    mkdirSync(join(p, "sub"));
    sessions = { sessions: [{ sessionId: "abcdef12-x", pid: 42, cwd: join(p, "sub"), status: "busy" }], report: { status: "ok", errors: [] } as never };
    expect(h.turns.list(a.id).undo).toEqual({ ok: false, why: expect.stringContaining("works in " + join(p, "sub")) });
    // In a folder above it (the project's root, when the agent's folder is a worktree inside it):
    // Undo is offered, and the preview names the session.
    sessions = { sessions: [{ sessionId: "abcdef12-x", pid: 42, cwd: join(p, ".."), status: "busy" }], report: { status: "ok", errors: [] } as never };
    expect(h.turns.list(a.id).undo).toEqual({ ok: true, warnings: [expect.stringContaining("which holds this folder")] });
    expect((await h.turns.plan(a.id, "1")).warnings).toEqual([expect.stringContaining("a terminal Claude Code session (abcdef12, pid 42)")]);
    sessions = { sessions: [], report: { status: "partial", errors: ["x.json: EACCES"] } as never };
    expect(h.turns.list(a.id).undo).toEqual({ ok: false, why: expect.stringContaining("could not all be read") });
  });

  test("a resume, or a start in the same folder, is refused while an Undo holds the agent", async () => {
    const { host, id, p } = await finished();
    host.hold(id, p, "Undo to checkpoint 1 is putting its folder back");
    expect(() => host.resume(id, "go on")).toThrow(HostError);
    expect(() => host.start({ cwd: p, prompt: "another" })).toThrow(/is busy: Undo to checkpoint 1/);
    // The same folder by another name (the temp folder is under a symlink on macOS: /var → /private/var).
    const other = realpathSync(p) === p ? null : realpathSync(p);
    if (other) expect(() => host.start({ cwd: other, prompt: "another" })).toThrow(/is busy: Undo to checkpoint 1/);
    host.release(id);
    expect(host.resume(id, "go on").status).toBe("starting");
  });

  test("Clear removes the snapshots, keeps the record, and leaves nothing to undo to", async () => {
    const { turns, id, store } = await finished();
    await turns.clear(id);
    expect(store.kept(id)).toBe(false);
    expect(turns.list(id)).toMatchObject({ undoable: [], kept: false });
    expect(store.read(id).records.at(-1)).toMatchObject({ kind: "cleared", reason: "cleared by you" });
    await expect(turns.plan(id, "1")).rejects.toMatchObject({ status: 404 });
  });

  test("snapshots of an agent whose folder is gone are cleared when the host starts", async () => {
    const { id, p, dir, store } = await finished();
    expect(store.kept(id)).toBe(true);
    rmSync(p, { recursive: true, force: true });
    const next = hostWith(async function* () {}, { dir });
    await until(() => !next.store.kept(id));
    expect(next.store.read(id).records.at(-1)).toMatchObject({ kind: "cleared", reason: expect.stringContaining("no longer exists") });
  });
});

describe("the answer places the agent's folder in its checkout (#275)", () => {
  async function ranIn(cwd: string) {
    const h = hostWith(async function* (o) {
      yield init;
      writeFileSync(join(o.cwd!, "b.txt"), "the turn's\n");
      yield result;
    });
    const a = h.host.start({ cwd, prompt: "go" });
    await until(() => whens(h.store, a.id).length === 2 && !h.host.get(a.id).running);
    return { ...h, id: a.id };
  }

  test("at the checkout's top the prefix is empty; in a folder inside it, that folder; paths stay the folder's own", async () => {
    const p = project();
    const top = await ranIn(p);
    expect(top.turns.list(top.id).prefix).toBe("");
    mkdirSync(join(p, "pkg", "sub"), { recursive: true });
    const inner = await ranIn(join(p, "pkg", "sub"));
    const ans = inner.turns.list(inner.id);
    expect(ans.prefix).toBe("pkg/sub/");
    const after = ans.records.find((r) => r.kind === "checkpoint" && r.when === "after-turn");
    expect(after).toMatchObject({ changes: [{ path: "b.txt", status: "A" }] });
  });

  test("a folder outside any git checkout, or one that is gone: null, so its paths are not joined to a PR's", async () => {
    const plain = join(scratch(), "plain");
    mkdirSync(plain);
    const h = await ranIn(plain);
    expect(h.turns.list(h.id).prefix).toBeNull();
    const p = project();
    const g = await ranIn(p);
    rmSync(p, { recursive: true, force: true });
    expect(g.turns.list(g.id)).toMatchObject({ folderGone: true, prefix: null });
  });
});
