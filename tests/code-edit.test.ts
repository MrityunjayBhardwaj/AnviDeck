/**
 * Code's edit path (#88): server/code-edit.ts writes a project file only when no running AnviDeck
 * agent is touching it, only inside the project's own folder, and only over the bytes the page
 * showed. Every refusal case has a test here; each is exercised on a scratch git repository.
 */
import { describe, expect, test, afterAll } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Hono } from "hono";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { AgentHost, type QueryFn } from "../server/agents/host";
import { AgentRegistry } from "../server/agents/registry";
import { loginOnlyEnv } from "../server/agents/login";
import { applyEdit, CodeEditError, readWorking, resolveTarget, type EditDeps } from "../server/code-edit";
import { agentFacts, agentsRead, editsIn, touching, type AgentFact } from "../server/code-touch";
import { codeRoutes } from "../server/routes/code";
import { installGuard, TOKEN_HEADER } from "../server/guard";
import { ActionLog, type ActionRecord } from "../server/action-log";
import { editBody, savedAs } from "../ui/components/code-model";

const dirs: string[] = [];
const scratch = (p = "code-edit-") => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), p)));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...a: string[]) => {
  const r = spawnSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

/** A scratch repository with src/a.ts and README.md committed. */
function repo(): string {
  const d = scratch("code-repo-");
  git(d, "init", "-q", "-b", "main");
  mkdirSync(join(d, "src"));
  writeFileSync(join(d, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(d, "README.md"), "# scratch\n");
  git(d, "add", ".");
  git(d, "commit", "-q", "-m", "init");
  return d;
}

const NO_SESSIONS = () => ({ sessions: [], report: { status: "none" as const, errors: [] } });
const deps = (top: string, agents: EditDeps["agents"] = () => [], sessions: EditDeps["sessions"] = NO_SESSIONS): EditDeps => ({ top: () => ({ top }), agents, sessions });
const body = (path: string, top: string, content: string) => ({ path, baseHash: sha(readFileSync(join(top, path))), content });
const fact = (o: Partial<AgentFact> & { cwd: string }): AgentFact => ({ id: "a-1", status: "working", running: true, prompt: "p", edits: [], ...o });

function refused(fn: () => unknown): CodeEditError {
  try {
    fn();
  } catch (e) {
    if (e instanceof CodeEditError) return e;
    throw e;
  }
  throw new Error("expected a refusal, got a write");
}

describe("where Code may write", () => {
  test("a file of the project is written exactly, and its mode is kept", () => {
    const top = repo();
    chmodSync(join(top, "src", "a.ts"), 0o640);
    const r = applyEdit("p", body("src/a.ts", top, "export const a = 2;\n"), deps(top));
    expect(readFileSync(join(top, "src", "a.ts"), "utf8")).toBe("export const a = 2;\n");
    expect(r.after).toBe(sha("export const a = 2;\n"));
    expect(statSync(join(top, "src", "a.ts")).mode & 0o777).toBe(0o640);
    // No temporary file is left beside it.
    expect(readFileSync(join(top, "src", "a.ts"), "utf8")).toBe("export const a = 2;\n");
    expect(spawnSync("ls", ["-a", join(top, "src")], { encoding: "utf8" }).stdout.trim().split("\n").sort()).toEqual([".", "..", "a.ts"]);
  });

  test("a path that climbs out, is absolute, or has an empty part is refused (400)", () => {
    const top = repo();
    for (const p of ["../x", "src/../../x", "/etc/hosts", "src//a.ts", "./src/a.ts", ""]) {
      const e = refused(() => applyEdit("p", { path: p, baseHash: "0".repeat(64), content: "x" }, deps(top)));
      expect(`${p}: ${e.status}`).toBe(`${p}: 400`);
    }
  });

  test("nothing under .git, in any letter case", () => {
    const top = repo();
    for (const p of [".git/config", ".GIT/config", "src/.git/x"]) expect(refused(() => resolveTarget(top, p)).status).toBe(400);
    expect(readFileSync(join(top, ".git", "config"), "utf8")).not.toContain("x");
  });

  test("a symlinked file, or a symlinked folder on the way, is refused: the write cannot leave the project", () => {
    const top = repo();
    const outside = scratch("code-outside-");
    writeFileSync(join(outside, "secret.txt"), "keep\n");
    symlinkSync(join(outside, "secret.txt"), join(top, "link.txt"));
    symlinkSync(outside, join(top, "out"));
    const e1 = refused(() => applyEdit("p", { path: "link.txt", baseHash: sha("keep\n"), content: "gone\n" }, deps(top)));
    expect(e1.status).toBe(400);
    expect(e1.message).toContain("symlink");
    const e2 = refused(() => applyEdit("p", { path: "out/secret.txt", baseHash: sha("keep\n"), content: "gone\n" }, deps(top)));
    expect(e2.status).toBe(400);
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("keep\n");
  });

  test("a file inside another checkout nested in the folder (an agent's worktree) is refused (409)", () => {
    const top = repo();
    git(top, "worktree", "add", "-q", join(top, "wt"), "-b", "side");
    const e = refused(() => applyEdit("p", body("wt/src/a.ts", top, "x\n"), deps(top)));
    expect(e.status).toBe(409);
    expect(e.message).toContain("another checkout");
  });

  test("a file that does not exist is not created (404), and a folder is not a file (400)", () => {
    const top = repo();
    expect(refused(() => resolveTarget(top, "src/new.ts")).status).toBe(404);
    expect(refused(() => resolveTarget(top, "src")).status).toBe(400);
  });

  test("a file that is not UTF-8 text is refused, and so is text with a NUL", () => {
    const top = repo();
    writeFileSync(join(top, "bin.dat"), Buffer.from([0x89, 0x50, 0x00, 0xff]));
    expect(refused(() => applyEdit("p", body("bin.dat", top, "x"), deps(top))).status).toBe(409);
    expect(refused(() => applyEdit("p", body("src/a.ts", top, "a\0b"), deps(top))).status).toBe(400);
  });
});

describe("an approval writes exactly over what was shown", () => {
  test("a file changed since it was opened is not written (409), and is left as it is", () => {
    const top = repo();
    const shown = readWorking("p", "src/a.ts", deps(top));
    writeFileSync(join(top, "src", "a.ts"), "export const a = 'theirs';\n");
    const e = refused(() => applyEdit("p", { path: "src/a.ts", baseHash: shown.hash, content: "mine\n" }, deps(top)));
    expect(e.status).toBe(409);
    expect(e.message).toContain("changed since you opened it");
    expect(readFileSync(join(top, "src", "a.ts"), "utf8")).toBe("export const a = 'theirs';\n");
  });

  test("the working copy's hash is of the bytes on disk", () => {
    const top = repo();
    const w = readWorking("p", "src/a.ts", deps(top));
    expect(w.hash).toBe(sha(readFileSync(join(top, "src", "a.ts"))));
    expect(w.text).toBe("export const a = 1;\n");
    expect(w.editable).toBe(true);
  });
});

describe("a running agent keeps a file read-only", () => {
  test("an agent working in the folder that holds the file: refused (409), named, file unchanged", () => {
    const top = repo();
    const e = refused(() => applyEdit("p", body("src/a.ts", top, "x\n"), deps(top, () => [fact({ cwd: top })])));
    expect(e.status).toBe(409);
    expect(e.detail.touching?.map((t) => t.why)).toEqual(["works in this folder"]);
    expect(readFileSync(join(top, "src", "a.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(readWorking("p", "src/a.ts", deps(top, () => [fact({ cwd: top })])).editable).toBe(false);
  });

  test("an agent that edited the same file in another checkout of the repository: refused", () => {
    const top = repo();
    const wt = join(scratch("code-wt-"), "wt");
    git(top, "worktree", "add", "-q", wt, "-b", "agent");
    const a = fact({ cwd: wt, edits: [{ abs: join(wt, "src", "a.ts"), tool: "Edit", at: "2026-11-05T10:00:00Z" }] });
    const e = refused(() => applyEdit("p", body("src/a.ts", top, "x\n"), deps(top, () => [a])));
    expect(e.detail.touching?.map((t) => t.why)).toEqual(["edited this file"]);
    // The same agent does not keep another file of the repository.
    applyEdit("p", body("README.md", top, "# changed\n"), deps(top, () => [a]));
    expect(readFileSync(join(top, "README.md"), "utf8")).toBe("# changed\n");
  });

  test("an agent that is not running keeps nothing", () => {
    const top = repo();
    const a = fact({ cwd: top, status: "done", running: false, edits: [{ abs: join(top, "src", "a.ts"), tool: "Write", at: "t" }] });
    applyEdit("p", body("src/a.ts", top, "after\n"), deps(top, () => [a]));
    expect(readFileSync(join(top, "src", "a.ts"), "utf8")).toBe("after\n");
  });

  test("a running agent whose transcript could not be read whole keeps every file of its repository", () => {
    const top = repo();
    const wt = join(scratch("code-wt-"), "wt");
    git(top, "worktree", "add", "-q", wt, "-b", "agent2");
    const a = fact({ cwd: wt, unreadable: "1 line(s) of its transcript could not be read" });
    const e = refused(() => applyEdit("p", body("README.md", top, "x\n"), deps(top, () => [a])));
    expect(e.detail.touching?.map((t) => t.why)).toEqual(["edits not known"]);
    // ...but not a file of another repository.
    const other = repo();
    applyEdit("p", body("README.md", other, "# other\n"), deps(other, () => [a]));
  });

  test("when the agent host cannot be asked, nothing is written (503)", () => {
    const top = repo();
    expect(refused(() => applyEdit("p", body("src/a.ts", top, "x\n"), deps(top, () => ({ off: "registry broken" })))).status).toBe(503);
    expect(refused(() => applyEdit("p", body("src/a.ts", top, "x\n"), deps(top, () => { throw new Error("boom"); }))).status).toBe(503);
    expect(readWorking("p", "src/a.ts", deps(top, () => ({ off: "registry broken" }))).editable).toBe(false);
    expect(readFileSync(join(top, "src", "a.ts"), "utf8")).toBe("export const a = 1;\n");
  });

  test("the edit tools are read from the transcript; reads and shell calls are not edits", () => {
    const lines = [
      { at: "t1", from: "sdk", message: { type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "/r/src/a.ts" } }, { type: "tool_use", name: "Read", input: { file_path: "/r/src/b.ts" } }] } } },
      { at: "t2", from: "sdk", message: { type: "assistant", message: { content: [{ type: "tool_use", name: "NotebookEdit", input: { notebook_path: "/r/n.ipynb" } }, { type: "tool_use", name: "Bash", input: { command: "echo > /r/c.ts" } }] } } },
      { at: "t3", from: "host", message: { type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: "/r/d.ts" } }] } } },
    ];
    expect(editsIn(lines)).toEqual([{ abs: "/r/src/a.ts", tool: "Edit", at: "t1" }, { abs: "/r/n.ipynb", tool: "NotebookEdit", at: "t2" }]);
  });
});

// ── the agent host's own live state ─────────────────────────────────────────────────────

const initMsg = { type: "system", subtype: "init", apiKeySource: "none", session_id: "s1", claude_code_version: "2", model: "m", cwd: "/x", tools: [], mcp_servers: [], permissionMode: "default", slash_commands: [], output_style: "default", uuid: "u" } as unknown as SDKMessage;
const editMsg = (file: string) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "Edit", input: { file_path: file, old_string: "1", new_string: "2" } }] }, parent_tool_use_id: null, session_id: "s1", uuid: "u2" }) as unknown as SDKMessage;

/** A fake Claude Code run that edits `file` and then keeps working until it is stopped. */
function hostEditing(file: string) {
  const fn: QueryFn = ({ prompt, options }) =>
    (async function* () {
      await prompt[Symbol.asyncIterator]().next();
      yield initMsg;
      yield editMsg(file);
      await new Promise<never>((_, rej) => (options as Options).abortController!.signal.addEventListener("abort", () => rej(new Error("aborted"))));
    })() as unknown as ReturnType<QueryFn>;
  return new AgentHost({
    registry: new AgentRegistry(scratch("code-reg-")),
    query: fn,
    resolveClaude: () => ({ path: "/fake/claude", realPath: "/fake/claude-2", fileId: "1:1:1" }),
    env: () => loginOnlyEnv({ PATH: "/usr/bin" }),
    emit: () => {},
  });
}
const until = async (pred: () => boolean) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > 3000) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};
void ({} as SDKUserMessage);

describe("an edit is refused while an AnviDeck agent works on that file (the agent host's live state)", () => {
  test("refused while the agent runs; written once it is stopped", async () => {
    const top = repo();
    const wt = join(scratch("code-wt-"), "wt");
    git(top, "worktree", "add", "-q", wt, "-b", "agent-live");
    const host = hostEditing(join(wt, "src", "a.ts"));
    const a = host.start({ cwd: wt, prompt: "change a" });
    await until(() => host.transcript(a.id).lines.some((l) => JSON.stringify(l.message).includes('"Edit"')));
    expect(host.get(a.id).running).toBe(true);
    const d: EditDeps = { top: () => ({ top }), agents: () => agentFacts(host), sessions: NO_SESSIONS };
    const e = refused(() => applyEdit("p", body("src/a.ts", top, "mine\n"), d));
    expect(e.status).toBe(409);
    expect(e.detail.touching).toEqual([expect.objectContaining({ id: a.id, why: "edited this file" })]);
    expect(readFileSync(join(top, "src", "a.ts"), "utf8")).toBe("export const a = 1;\n");
    // The tree shows the same agent on the same file.
    const read = agentsRead(host, null, { top, packageRel: "" });
    expect(read.agents.map((x) => [x.id, x.running, x.edits.map((ed) => ed.file)])).toEqual([[a.id, true, ["src/a.ts"]]]);
    host.stop(a.id);
    await until(() => !host.get(a.id).running);
    applyEdit("p", body("src/a.ts", top, "mine\n"), d);
    expect(readFileSync(join(top, "src", "a.ts"), "utf8")).toBe("mine\n");
  });
});

// ── the route, behind the whole guard ───────────────────────────────────────────────────

describe("POST /api/code/:project/edit is guarded and logged", () => {
  const TOKEN = "tok-code-edit";
  const HOST = "localhost:4476";
  function app(top: string, agents: AgentFact[] = []) {
    const log = new ActionLog(scratch("code-log-"));
    const a = new Hono();
    installGuard(a, { bind: "127.0.0.1", token: TOKEN, log });
    const host = { registry: { dir: "/reg" }, list: () => agents.map((x) => ({ id: x.id, status: x.status, running: x.running, cwd: x.cwd, prompt: x.prompt })), transcript: () => ({ lines: [], unreadable: 0 }) };
    a.route("/api/code", codeRoutes({ host: () => host, edit: { top: () => ({ top }), sessions: NO_SESSIONS } }));
    const send = (path: string, b: unknown, headers: Record<string, string> = { origin: `http://${HOST}`, [TOKEN_HEADER]: TOKEN }) =>
      a.request(`http://${HOST}${path}`, { method: "POST", headers: { host: HOST, "content-type": "application/json", ...headers }, body: JSON.stringify(b) });
    const lines = (): ActionRecord[] => readFileSync(log.file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    return { send, lines, get: (path: string) => a.request(`http://${HOST}${path}`, { headers: { host: HOST } }) };
  }

  test("without the token it is refused (403) and logged; with it, written and logged", async () => {
    const top = repo();
    const s = app(top);
    const b = body("src/a.ts", top, "export const a = 3;\n");
    const r1 = await s.send("/api/code/scratch/edit", b, { origin: `http://${HOST}` });
    expect(r1.status).toBe(403);
    expect(readFileSync(join(top, "src", "a.ts"), "utf8")).toBe("export const a = 1;\n");
    const r2 = await s.send("/api/code/scratch/edit", b);
    expect(r2.status).toBe(200);
    expect(readFileSync(join(top, "src", "a.ts"), "utf8")).toBe("export const a = 3;\n");
    expect(s.lines().map((l) => [l.area, l.target, l.status, l.result])).toEqual([["code", "scratch", 403, "refused"], ["code", "scratch", 200, "accepted"]]);
    expect((s.lines()[1].body as Record<string, unknown>).path).toBe("src/a.ts");
  });

  test("an agent working there: 409 with the agent named, logged as failed", async () => {
    const top = repo();
    const s = app(top, [fact({ cwd: top, id: "ag-9" })]);
    const r = await s.send("/api/code/scratch/edit", body("src/a.ts", top, "x\n"));
    expect(r.status).toBe(409);
    const j = (await r.json()) as { error: string; touching: { id: string }[] };
    expect(j.touching.map((t) => t.id)).toEqual(["ag-9"]);
    expect(j.error).toContain("ag-9");
    expect(s.lines()[0]).toEqual(expect.objectContaining({ status: 409, result: "failed" }));
    const w = (await (await s.get("/api/code/scratch/working?path=src/a.ts")).json()) as { editable: boolean; reason: string };
    expect(w.editable).toBe(false);
    expect(w.reason).toContain("ag-9");
  });
});

describe("a live terminal Claude Code session keeps its folder read-only", () => {
  test("a session working in the folder that holds the file: refused (409); one elsewhere: not", () => {
    const top = repo();
    const here = () => ({ sessions: [{ sessionId: "abcdef12-0000", pid: 42, cwd: top, status: "busy" }], report: { status: "ok" as const, errors: [] } });
    const e = refused(() => applyEdit("p", body("src/a.ts", top, "x\n"), deps(top, () => [], here)));
    expect(e.status).toBe(409);
    expect(e.detail.touching?.map((t) => t.why)).toEqual(["a terminal session works in this folder"]);
    expect(readWorking("p", "src/a.ts", deps(top, () => [], here)).editable).toBe(false);
    const other = repo();
    applyEdit("p", body("src/a.ts", other, "y\n"), deps(other, () => [], here));
    expect(readFileSync(join(other, "src", "a.ts"), "utf8")).toBe("y\n");
  });

  test("sessions that could not all be read keep every file read-only", () => {
    const top = repo();
    const bad = () => ({ sessions: [], report: { status: "partial" as const, errors: ["/s/1.json: EACCES"] } });
    expect(refused(() => applyEdit("p", body("src/a.ts", top, "x\n"), deps(top, () => [], bad))).detail.touching?.map((t) => t.why)).toEqual(["sessions not known"]);
    const boom = () => {
      throw new Error("EIO");
    };
    expect(refused(() => applyEdit("p", body("src/a.ts", top, "x\n"), deps(top, () => [], boom))).status).toBe(409);
    expect(readFileSync(join(top, "src", "a.ts"), "utf8")).toBe("export const a = 1;\n");
  });
});

describe("the touching rule on paths", () => {
  test("a folder whose name starts like the agent's is not inside it", () => {
    const base = scratch("code-pfx-");
    mkdirSync(join(base, "repo"));
    mkdirSync(join(base, "repo-2"));
    writeFileSync(join(base, "repo-2", "f.ts"), "x");
    expect(touching(join(base, "repo-2", "f.ts"), [fact({ cwd: join(base, "repo") })], () => null)).toEqual([]);
    expect(touching(join(base, "repo-2", "f.ts"), [fact({ cwd: join(base, "repo-2") })], () => null).map((t) => t.why)).toEqual(["works in this folder"]);
  });
});

const NO_HOST = () => ({ registry: { dir: "/reg" }, list: () => [], transcript: () => ({ lines: [], unreadable: 0 }) });
/** The code routes behind the whole guard, as server/index.ts mounts them, with token "t". */
function guarded(top: string) {
  const log = new ActionLog(scratch("code-log-"));
  const a = new Hono();
  installGuard(a, { bind: "127.0.0.1", token: "t", log });
  a.route("/api/code", codeRoutes({ host: NO_HOST, edit: { top: () => ({ top }), sessions: NO_SESSIONS } }));
  const post = (path: string, payload: string) =>
    a.request(`http://localhost:4476${path}`, {
      method: "POST",
      // content-length as a browser sends it: logWrites decides from it whether to read the body.
      headers: { host: "localhost:4476", origin: "http://localhost:4476", [TOKEN_HEADER]: "t", "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) },
      body: payload,
    });
  const lines = (): ActionRecord[] => readFileSync(log.file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return { post, lines };
}

describe("Code never writes catalogues, Ground Truth docs or Claude Code's configuration", () => {
  const KEPT = [
    ".anvi/hetvabhasa.md",
    "artifacts/.anvi/vyapti.md",
    "pkg/.anvi/krama.md",
    "ref/GROUND_TRUTH_X.md",
    "artifacts/ref/GROUND_TRUTH_Y.md",
    ".claude/settings.local.json",
    "pkg/.claude/commands/x.md",
    ".mcp.json",
  ];
  const ESCALATE = '{"permissions":{"allow":["Bash(*)"]}}\n';
  /** A repository holding each kept file with the text "keep". */
  function keptRepo(): string {
    const top = repo();
    for (const p of KEPT) {
      mkdirSync(join(top, p, ".."), { recursive: true });
      writeFileSync(join(top, p), "keep\n");
    }
    return top;
  }

  test("each is refused (400) and left as it was, in any letter case; a look-alike is still editable", () => {
    const top = keptRepo();
    for (const p of [...KEPT, ".Claude/settings.local.json", ".ANVI/hetvabhasa.md"]) {
      const e = refused(() => applyEdit("p", { path: p, baseHash: sha("keep\n"), content: ESCALATE }, deps(top)));
      expect(`${p}: ${e.status}`).toBe(`${p}: 400`);
      expect(e.message).toMatch(/changed only by agents|never writes there/);
    }
    for (const p of KEPT) expect(readFileSync(join(top, p), "utf8")).toBe("keep\n");
    // The working copy is not offered for editing either.
    expect(refused(() => readWorking("p", ".anvi/hetvabhasa.md", deps(top))).status).toBe(400);
    mkdirSync(join(top, "src", "refs"), { recursive: true });
    writeFileSync(join(top, "src", "refs", "anvi.ts"), "keep\n");
    writeFileSync(join(top, "src", "ref"), "keep\n");
    expect(applyEdit("p", body("src/refs/anvi.ts", top, "x\n"), deps(top)).after).toBe(sha("x\n"));
    expect(applyEdit("p", body("src/ref", top, "x\n"), deps(top)).after).toBe(sha("x\n"));
  });

  test("through POST /api/code/:project/edit with a valid token: 400, file unchanged, logged as failed with the path", async () => {
    const top = keptRepo();
    const s = guarded(top);
    const r = await s.post("/api/code/p/edit", JSON.stringify({ path: ".claude/settings.local.json", baseHash: sha("keep\n"), content: ESCALATE }));
    expect(r.status).toBe(400);
    expect(readFileSync(join(top, ".claude", "settings.local.json"), "utf8")).toBe("keep\n");
    expect(s.lines()[0]).toEqual(expect.objectContaining({ status: 400, result: "failed", detail: expect.objectContaining({ path: ".claude/settings.local.json" }) }));
  });
});

describe("the action log names the file an edit wrote, whatever the body's size", () => {
  test("a 70 000-character edit whose body is not previewed: path, abs and sha256 before and after are logged", async () => {
    const top = repo();
    writeFileSync(join(top, "src", "big.ts"), "// big\n");
    const s = guarded(top);
    const content = "x".repeat(70_000);
    // Eight keys before path, too: the preview, when it is read, keeps only the first eight.
    const payload = JSON.stringify({ k1: 1, k2: 2, k3: 3, k4: 4, k5: 5, k6: 6, k7: 7, k8: 8, path: "src/big.ts", baseHash: sha("// big\n"), content });
    const r = await s.post("/api/code/proj/edit", payload);
    expect(r.status).toBe(200);
    const [line] = s.lines();
    expect(line.body).toBe(`not read (${Buffer.byteLength(payload)} bytes)`);
    expect(line.detail).toEqual({ path: "src/big.ts", abs: join(top, "src", "big.ts"), before: sha("// big\n"), after: sha(content), bytes: 70_000 });
  });
});

describe("a second Save is over the file the first one wrote", () => {
  test("savedAs carries the new sha256, so the next Save is written; the first-opened hash is refused", () => {
    const top = repo();
    const opened = readWorking("p", "src/a.ts", deps(top));
    const r1 = applyEdit("p", editBody(opened, "export const a = 2;\n"), deps(top));
    const after1 = savedAs(opened, "export const a = 2;\n", r1);
    expect(after1.hash).toBe(sha("export const a = 2;\n"));
    expect(after1.text).toBe("export const a = 2;\n");
    // What the screen did before: the second Save sent the first-opened hash, refused as a change on disk.
    expect(refused(() => applyEdit("p", editBody(opened, "export const a = 3;\n"), deps(top))).status).toBe(409);
    const r2 = applyEdit("p", editBody(after1, "export const a = 3;\n"), deps(top));
    expect(r2.before).toBe(after1.hash);
    expect(readFileSync(join(top, "src", "a.ts"), "utf8")).toBe("export const a = 3;\n");
  });
});
