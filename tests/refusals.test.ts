import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { Hono } from "hono";
import { installGuard, TOKEN_HEADER } from "../server/guard";
import { ActionLog, type ActionRecord } from "../server/action-log";
import { refusalRoutes } from "../server/routes/refusals";
import { CallError, CallStore, callFrom, MAX_NOTE } from "../server/calls";
import { checkKey, mainCheckout, projectOfFolder } from "../server/call-project";
import { byKey, readCalls } from "../server/readers/calls";
import { discoverProjects, listStructure, readRegistry } from "../server/readers/structure";
import { TMP_ROOT } from "../server/readers/structure";
import {
  CACHE_TTL_MS,
  callStateOf,
  clearRefusalsCache,
  isStale,
  RETRY_MS,
  settle,
  defaultSince,
  exitMeaning,
  noticesFrom,
  packageOf,
  readRefusals,
  REFUSALS_SCRIPT,
  RefusalsError,
  runInstrument,
  windowOf,
} from "../server/readers/refusals";
import { callLine, shortDay, withRecorded } from "../ui/components/refusal-call-model";
import { refusalCallTarget } from "../ui/components/agents-model";
import type { CallRecord, CallsRead, RefusalsMeasured, RefusalsResponse, RefusalWindow } from "../shared/refusal-types";

const dirs: string[] = [];
const scratch = (p = "refusals-") => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), p)));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const call = (key: string, c: "right" | "wrong", at: string, note?: string): CallRecord => ({ at, key, project: "stave", call: c, ...(note ? { note } : {}) });

// ── your calls: the reader ─────────────────────────────────────────────────────────────────

describe("calls reader", () => {
  test("no file is 'none', not unreadable; nothing is invented", () => {
    const r = readCalls({ dir: scratch() });
    expect(r.exists).toBe(false);
    expect(r.status).toBe("none");
    expect(r.calls).toEqual([]);
  });

  test("the latest call on a refusal wins; earlier ones are kept as its history, oldest first", () => {
    const d = scratch();
    const lines = [call("k1", "wrong", "2026-10-25T10:00:00Z", "first look"), call("k2", "right", "2026-10-26T10:00:00Z"), call("k1", "right", "2026-10-27T10:00:00Z", "second look")];
    writeFileSync(join(d, "calls.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const r = readCalls({ dir: d });
    expect(r.status).toBe("ok");
    expect(r.byKey.k1.latest.call).toBe("right");
    expect(r.byKey.k1.latest.note).toBe("second look");
    expect(r.byKey.k1.earlier.map((c) => c.call)).toEqual(["wrong"]);
    expect(r.byKey.k2.earlier).toEqual([]);
    expect(r.calls.length).toBe(3);
  });

  test("a torn or damaged line is counted, never dropped silently; all damaged is unreadable, not none", () => {
    const d = scratch();
    writeFileSync(join(d, "calls.jsonl"), JSON.stringify(call("k1", "right", "2026-10-27T10:00:00Z")) + "\n" + '{"at":"2026-10-28T1' + "\n" + JSON.stringify({ at: "x", key: "k", project: "p", call: "maybe" }) + "\n");
    const r = readCalls({ dir: d });
    expect(r.status).toBe("partial");
    expect(r.lines).toBe(3);
    expect(r.unreadableLines).toBe(2);
    expect(r.byKey.k1.latest.call).toBe("right");

    const e = scratch();
    writeFileSync(join(e, "calls.jsonl"), "not json\n");
    const u = readCalls({ dir: e });
    expect(u.status).toBe("unreadable");
    expect(u.unreadableLines).toBe(1);
  });

  test("a calls file that cannot be read at all is unreadable with the reason", () => {
    const d = scratch();
    mkdirSync(join(d, "calls.jsonl")); // a directory where the file should be: EISDIR
    const r = readCalls({ dir: d });
    expect(r.exists).toBe(true);
    expect(r.status).toBe("unreadable");
    expect(r.error).toContain("EISDIR");
  });

  test("?project and ?key filter what is returned", () => {
    const d = scratch();
    writeFileSync(join(d, "calls.jsonl"), [call("k1", "right", "2026-10-27T10:00:00Z"), { ...call("k2", "wrong", "2026-10-27T11:00:00Z"), project: "other" }].map((l) => JSON.stringify(l)).join("\n") + "\n");
    expect(readCalls({ dir: d, project: "stave" }).calls.map((c) => c.key)).toEqual(["k1"]);
    expect(readCalls({ dir: d, key: "k2" }).calls.map((c) => c.key)).toEqual(["k2"]);
  });
});

// ── your calls: the record ─────────────────────────────────────────────────────────────────

describe("callFrom", () => {
  const at = () => new Date("2026-10-27T12:00:00Z");
  test("a call is right or wrong on a known key shape for a project; the note is kept exactly", () => {
    const note = "  engine must not know monaco — see #528  ";
    const r = callFrom("toolu_01WH1U6BSSp7vQGkSwJ9vjez", { project: "stave", call: "right", note, refusal: { file: "src/engine/StrudelEngine.ts", at: "2026-10-22T16:16:25Z", extra: 1 } }, at);
    expect(r).toEqual({ at: "2026-10-27T12:00:00.000Z", key: "toolu_01WH1U6BSSp7vQGkSwJ9vjez", project: "stave", projectFrom: "the page", call: "right", note, refusal: { file: "src/engine/StrudelEngine.ts", at: "2026-10-22T16:16:25Z" } });
  });
  test("anything else is refused with a reason the caller can branch on (status 400)", () => {
    const bad: [string, Record<string, unknown>, string][] = [
      ["k", { project: "stave", call: "maybe" }, 'call must be "right" or "wrong"'],
      ["k", { call: "right" }, "project must be a project name"],
      ["../etc", { project: "stave", call: "right" }, "is not one this server records"],
      ["k", { project: "stave", call: "right", note: 3 }, "note must be text"],
    ];
    for (const [key, body, why] of bad) {
      try {
        callFrom(key, body);
        throw new Error("accepted");
      } catch (e) {
        expect(e).toBeInstanceOf(CallError);
        expect((e as CallError).status).toBe(400);
        expect((e as Error).message).toContain(why);
      }
    }
  });
  test("a note over the limit is refused, never cut: the record holds exactly what you wrote", () => {
    expect(() => callFrom("k", { project: "stave", call: "wrong", note: "x".repeat(MAX_NOTE + 1) })).toThrow(`at most ${MAX_NOTE}`);
    expect(callFrom("k", { project: "stave", call: "wrong", note: "x".repeat(MAX_NOTE) }).note!.length).toBe(MAX_NOTE);
  });
});

// ── the routes, behind the whole guard ─────────────────────────────────────────────────────

const TOKEN = "refusals-test-token";
const HOST = "localhost:4111";
const ORIGIN = `http://${HOST}`;

function server(dir = scratch(), deps: Omit<NonNullable<Parameters<typeof refusalRoutes>[0]>, "store"> = {}) {
  const log = new ActionLog(join(dir, "log"));
  const app = new Hono();
  installGuard(app, { bind: "127.0.0.1", token: TOKEN, log });
  const store = new CallStore(dir);
  app.route("/api", refusalRoutes({ store, ...deps }));
  const post = (key: string, headers: Record<string, string>, body: unknown) =>
    app.request(`${ORIGIN}/api/refusals/${encodeURIComponent(key)}/call`, { method: "POST", headers: { host: HOST, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const get = (path: string) => app.request(`${ORIGIN}${path}`, { headers: { host: HOST } });
  const actions = (): ActionRecord[] => (existsSync(log.file) ? readFileSync(log.file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { app, store, post, get, actions, dir };
}

describe("POST /api/refusals/:key/call and GET /api/calls", () => {
  test("without the token or Origin the call is refused, logged, and not recorded", async () => {
    const s = server();
    expect((await s.post("toolu_1", { origin: ORIGIN }, { project: "stave", call: "right" })).status).toBe(403);
    expect((await s.post("toolu_1", { [TOKEN_HEADER]: TOKEN }, { project: "stave", call: "right" })).status).toBe(403);
    expect(existsSync(s.store.file)).toBe(false);
    expect(s.actions().map((a) => `${a.result} ${a.area} ${a.target}`)).toEqual(["refused refusals toolu_1", "refused refusals toolu_1"]);
  });

  test("from AnviDeck's page with the token: appended to calls.jsonl, logged as accepted, and read back; a new server reads it too", async () => {
    const s = server();
    const h = { origin: ORIGIN, [TOKEN_HEADER]: TOKEN };
    const a = await s.post("toolu_1", h, { project: "stave", call: "wrong", note: "first" });
    expect(a.status).toBe(201);
    const b = await s.post("toolu_1", h, { project: "stave", call: "right", refusal: { file: "src/engine/StrudelEngine.ts" } });
    expect(b.status).toBe(201);
    expect(((await b.json()) as { file: string }).file).toBe(join(s.dir, "calls.jsonl"));
    expect(readFileSync(s.store.file, "utf8").trim().split("\n").length).toBe(2);
    expect(s.actions().map((x) => `${x.result} ${x.status} ${x.target}`)).toEqual(["accepted 201 toolu_1", "accepted 201 toolu_1"]);
    // A restart: a new app over the same folder.
    const again = server(s.dir);
    const r = (await (await again.get("/api/calls?project=stave")).json()) as CallsRead;
    expect(r.byKey.toolu_1.latest.call).toBe("right");
    expect(r.byKey.toolu_1.earlier.map((c) => `${c.call} ${c.note}`)).toEqual(["wrong first"]);
  });

  test("a bad call is answered 400 with its reason and logged as failed; nothing is appended", async () => {
    const s = server();
    const r = await s.post("toolu_1", { origin: ORIGIN, [TOKEN_HEADER]: TOKEN }, { project: "stave", call: "maybe" });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toContain('"right" or "wrong"');
    expect(existsSync(s.store.file)).toBe(false);
    expect(s.actions()[0].result).toBe("failed");
  });

  test("a call that cannot be written is an error (500), never a quiet success", async () => {
    const d = scratch();
    const blocker = join(d, "file");
    writeFileSync(blocker, "");
    const s = server(d);
    const app = new Hono();
    installGuard(app, { bind: "127.0.0.1", token: TOKEN, log: new ActionLog(join(d, "log")) });
    app.route("/api", refusalRoutes({ store: new CallStore(join(blocker, "sub")) }));
    const r = await app.request(`${ORIGIN}/api/refusals/k/call`, { method: "POST", headers: { host: HOST, origin: ORIGIN, [TOKEN_HEADER]: TOKEN, "content-type": "application/json" }, body: JSON.stringify({ project: "stave", call: "right" }) });
    expect(r.status).toBe(500);
    expect(((await r.json()) as { error: string }).error).toContain("your call was not recorded");
    void s;
  });

  test("mounted without the whole guard, the router still refuses a call with no Origin of its own server", async () => {
    const d = scratch();
    const app = new Hono();
    app.route("/api", refusalRoutes({ store: new CallStore(d) }));
    const r = await app.request(`${ORIGIN}/api/refusals/k/call`, { method: "POST", headers: { host: HOST, "content-type": "application/json" }, body: JSON.stringify({ project: "stave", call: "right" }) });
    expect(r.status).toBe(403);
    expect(existsSync(join(d, "calls.jsonl"))).toBe(false);
  });

  test("GET /api/refusals needs a project", async () => {
    expect((await server().get("/api/refusals")).status).toBe(400);
  });
});

// ── the refusals reader ────────────────────────────────────────────────────────────────────

describe("window", () => {
  test("default: the last 30 days from midnight UTC; a bad time is a 400 the route can answer", () => {
    expect(defaultSince(new Date("2026-11-05T16:39:00Z"))).toBe("2026-10-06T00:00:00.000Z");
    expect(windowOf(null, null, new Date("2026-11-05T16:39:00Z")).chosenBy).toContain("30 days");
    expect(windowOf("2026-10-01", null).since).toBe("2026-10-01T00:00:00.000Z");
    expect(() => windowOf("yesterday", null)).toThrow(RefusalsError);
  });
  test("the instrument's exits mean what its header says", () => {
    expect(exitMeaning(1)).toContain("refusal");
    expect(exitMeaning(2)).toContain("not measured");
    expect(exitMeaning(3)).toContain("untested");
    expect(exitMeaning(9)).toContain("does not define");
  });
  test("the notice line is read with every kind, zeros included", () => {
    expect(noticesFrom("x\n  notices said (not refused): on disk 1 · fixed 12 · not measured 0 · check: on disk 0\n")).toEqual({ "on disk": 1, fixed: 12, "not measured": 0, "check: on disk": 0 });
    expect(noticesFrom("no such line")).toBeNull();
  });
});

const WIN: RefusalWindow = { since: "2026-10-01T00:00:00.000Z", until: null, chosenBy: "test" };
const BLOCKED = "PreToolUse:Edit hook error: BLOCKED: this edit to src/a.ts adds 1 import that erode pkg's declared structure:\n  · divergence: src/a.ts -> src/b.ts\n      one imports two, which the design does not declare\n(judged under design abcdefabcdef, against its baseline over 2 modules and 1 edges)\nRemedies:\n  · keep it out";
const UNKNOWN_SHAPE = "SomeNewWrapper: BLOCKED: this edit to src/c.ts adds 1 import that erode pkg's declared structure:";

/** A transcript folder with four edits of <pkg>: one refused, one applied, one timed out, one denied in an unknown shape. */
function fixture() {
  const root = scratch("refusals-fx-");
  const pkg = join(root, "pkg");
  mkdirSync(join(pkg, "src"), { recursive: true });
  const tr = join(root, "transcripts", "-proj");
  mkdirSync(tr, { recursive: true });
  const rec = (o: object) => JSON.stringify({ sessionId: "sess-1", version: "2.1.317", ...o });
  const use = (id: string, name: string, file: string, ts: string) => rec({ type: "assistant", timestamp: ts, message: { content: [{ type: "tool_use", id, name, input: { file_path: join(pkg, file), old_string: "a", new_string: "b", content: "x" } }] } });
  const result = (id: string, text: string, isError: boolean, ts: string) => rec({ type: "user", timestamp: ts, message: { content: [{ type: "tool_result", tool_use_id: id, content: text, is_error: isError }] } });
  const lines = [
    use("toolu_A", "Edit", "src/a.ts", "2026-10-22T16:16:24.153Z"), result("toolu_A", BLOCKED, true, "2026-10-22T16:16:25.000Z"),
    use("toolu_B", "Write", "src/b.ts", "2026-10-22T16:17:00.000Z"), result("toolu_B", "ok", false, "2026-10-22T16:17:01.000Z"),
    use("toolu_C", "Edit", "src/c.ts", "2026-10-22T16:18:00.000Z"), result("toolu_C", "ok", false, "2026-10-22T16:18:01.000Z"),
    rec({ type: "attachment", timestamp: "2026-10-22T16:18:01.500Z", attachment: { type: "hook_cancelled", toolUseID: "toolu_C", command: "node ~/.claude/hooks/structure-guard-hook.js", timedOut: true } }),
    use("toolu_D", "Edit", "src/c.ts", "2026-10-22T16:19:00.000Z"), result("toolu_D", UNKNOWN_SHAPE + " " + "BLOCKED: this edit to src/c.ts adds 1 import", true, "2026-10-22T16:19:01.000Z"),
    use("toolu_OLD", "Edit", "src/a.ts", "2026-09-01T00:00:00.000Z"), result("toolu_OLD", BLOCKED, true, "2026-09-01T00:00:01.000Z"),
  ];
  writeFileSync(join(tr, "sess-1.jsonl"), lines.join("\n") + "\n");
  return { pkg, transcripts: join(root, "transcripts"), root };
}

const haveInstrument = existsSync(REFUSALS_SCRIPT);

describe.skipIf(!haveInstrument)("runInstrument with anvi's real structure-refusals.js on fixture transcripts", () => {
  test("refusal, timeout and unrecognised shape come back with the instrument's counts, the guard's verbatim words, and who ran it", async () => {
    const fx = fixture();
    const r = (await runInstrument("fx", fx.pkg, WIN, { transcripts: fx.transcripts })) as RefusalsMeasured;
    expect(r.status).toBe("measured");
    // The population: 4 edits in the window (the September one is outside it), never a bare zero.
    expect(r.totals).toMatchObject({ edits: 4, sessions: 1, refused: 1, applied: 1, timedOut: 1, unrecognised: 1 });
    expect(r.refusals.length).toBe(1);
    const x = r.refusals[0];
    expect(x).toMatchObject({ key: "toolu_A", session: "sess-1", tool: "Edit", file: "src/a.ts", refusedBy: "graph rule", design: "abcdefabcdef", checkout: "registered" });
    expect(x.violations).toEqual([{ rule: "divergence", key: "src/a.ts -> src/b.ts" }]);
    expect(x.reason).toBe(BLOCKED);
    expect(r.timeouts.map((t) => `${t.key} ${t.outcome}`)).toEqual(["toolu_C timed out"]);
    expect(r.unrecognised.map((t) => t.key)).toEqual(["toolu_D"]);
    expect(r.unrecognised[0].reason).toContain(UNKNOWN_SHAPE);
    expect(r.instrument.name).toBe("structure-refusals.js");
    expect(r.instrument.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.instrument.args).toEqual(expect.arrayContaining(["--package", fx.pkg, "--since", WIN.since, "--transcripts", fx.transcripts]));
    expect(r.instrument.exit).toBe(1);
    expect(Object.keys(r.notices)).toEqual(expect.arrayContaining(["on disk", "fixed", "not measured"]));
    expect(r.report).toContain("REFUSALS — 1 of 4 edits");
  }, 60_000);

  test("a window with no edit is the instrument's NOT MEASURED, with its reason, never 0 refusals", async () => {
    const fx = fixture();
    const r = await runInstrument("fx", fx.pkg, { since: "2026-11-01T00:00:00.000Z", until: null, chosenBy: "test" }, { transcripts: fx.transcripts });
    expect(r.status).toBe("not-measured");
    if (r.status === "not-measured") expect(r.reason).toContain("no edit in the package in this window");
  }, 60_000);
});

describe("runInstrument when the instrument cannot answer", () => {
  const fake = (body: string) => {
    const d = scratch("refusals-fake-");
    const p = join(d, "fake.js");
    writeFileSync(p, body);
    return p;
  };
  const pkg = () => scratch("refusals-pkg-");

  test("missing instrument → unreadable, saying which file", async () => {
    const r = await runInstrument("p", pkg(), WIN, { script: "/nonexistent/structure-refusals.js" });
    expect(r.status).toBe("unreadable");
    if (r.status === "unreadable") expect(r.reason).toContain("/nonexistent/structure-refusals.js");
  });
  test("no --json report and no NOT MEASURED line → unreadable with the exit and the error", async () => {
    const r = await runInstrument("p", pkg(), WIN, { script: fake("console.log('hello'); console.error('TypeError: boom'); process.exit(4);") });
    expect(r.status).toBe("unreadable");
    if (r.status === "unreadable") {
      expect(r.reason).toContain("exited 4");
      expect(r.reason).toContain("TypeError: boom");
    }
  });
  test("a report that does not parse → unreadable", async () => {
    const r = await runInstrument("p", pkg(), WIN, { script: fake("require('fs').writeFileSync('/dev/fd/3', '{not json'); process.exit(1);") });
    expect(r.status).toBe("unreadable");
    if (r.status === "unreadable") expect(r.reason).toContain("does not parse");
  });
  test("an outcome this reader does not know → unreadable, never left out of the totals", async () => {
    const r = await runInstrument("p", pkg(), WIN, { script: fake("require('fs').writeFileSync('/dev/fd/3', JSON.stringify({ calls: [{ id: 'x', outcome: 'quarantined', session: 's' }] })); process.exit(1);") });
    expect(r.status).toBe("unreadable");
    if (r.status === "unreadable") expect(r.reason).toContain("quarantined");
  });
  test("the instrument refusing the reader's own arguments → unreadable, never its verdict on the data", async () => {
    for (const why of ["unrecognised argument(s): --json /dev/fd/3", "--since is required", "--since is not a time: x"]) {
      const r = await runInstrument("p", pkg(), WIN, { script: fake(`console.log('structure-refusals: NOT MEASURED — ${why}'); process.exit(2);`) });
      expect(`${why}: ${r.status}`).toBe(`${why}: unreadable`);
      if (r.status === "unreadable") expect(r.reason).toContain(why);
    }
  });
  test("the instrument's NOT MEASURED → not-measured with its words", async () => {
    const r = await runInstrument("p", pkg(), WIN, { script: fake("console.log('structure-refusals: NOT MEASURED — no transcripts under /x'); process.exit(2);") });
    expect(r.status).toBe("not-measured");
    if (r.status === "not-measured") expect(r.reason).toBe("no transcripts under /x");
  });
});

// ── packages and the cache ─────────────────────────────────────────────────────────────────

/** A git checkout with one package in a user registry of its own. */
function registered() {
  const top = scratch("refusals-proj-");
  spawnSync("git", ["-C", top, "init", "-q"]);
  const pkg = join(top, "pkg");
  mkdirSync(pkg);
  const reg = join(top, "registry.json");
  writeFileSync(reg, JSON.stringify({ packages: [{ dir: pkg, design: join(top, "d.json"), baseline: join(top, "b.json") }] }));
  return { top, pkg, name: basename(top), registry: { locked: join(top, "no-lock.json"), user: reg } };
}

describe("packages", () => {
  test("a project with no registered package says no-design, never 0 refusals", () => {
    const reg = { locked: join(scratch(), "none.json"), user: join(scratch(), "none.json") };
    const plain = listStructure({ registry: reg }).projects.find((p) => !p.hasDesign);
    if (!plain) return; // no known project on this machine
    const r = packageOf(plain.name, { registry: reg, path: plain.path });
    expect("response" in r && r.response.status).toBe("no-design");
    if ("response" in r && r.response.status === "no-design") expect(r.response.reason).toContain('not "0 refusals"');
  });
  test("an unknown project is not found", () => {
    const r = packageOf("no-such-project-refusals-test");
    expect("notFound" in r && r.notFound).toBe(true);
  });
  test("a registered package is found", () => {
    const p = registered();
    const r = packageOf(p.name, { registry: p.registry });
    expect(r).toEqual({ dir: p.pkg });
  });
});

/**
 * One run of the instrument, injected (as other reader tests inject `run`): the cache and the calls
 * are tested here, not Bun's spawn of node, which now and then fails to set up the report pipe
 * (#219). runInstrument's own tests above and below still spawn the real thing.
 */
type Run = NonNullable<NonNullable<Parameters<typeof readRefusals>[1]>["run"]>;
const measuredAnswer = (project: string, pkg: string, win: RefusalWindow, refusals: { key: string; at: string }[] = [], ranAt = "2026-11-05T12:00:00.000Z"): RefusalsMeasured => ({
  status: "measured", project, package: pkg, window: win,
  instrument: { name: "structure-refusals.js", path: "/injected", sha256: "0", mtime: "", args: [], ranAt, ms: 1, exit: 3, exitMeaning: exitMeaning(3) },
  transcripts: { read: 1, unreadable: 0, badLines: 0 },
  totals: { edits: 1 + refusals.length, sessions: 1, applied: 1, refused: refusals.length, refusedByCheckAlone: 0, deniedOtherwise: 0, erroredOtherwise: 0, noResult: 0, timedOut: 0, cancelled: 0, unrecognised: 0 },
  notices: {},
  refusals: refusals.map((r) => ({ key: r.key, at: r.at, session: "s", tool: "Edit", file: "src/a.ts", checkout: "registered", checkoutDir: pkg, version: null, transcript: "/t.jsonl", refusedBy: "graph rule" as const, checkToo: false, design: null, violations: [], pairs: [], reason: "BLOCKED", call: { state: "none" as const } })),
  timeouts: [], unrecognised: [], exposure: null, defaultBranch: null, byDesign: [],
  trialReading: "TRIAL READING: UNTESTED — 0 chances", report: "", cache: { at: ranAt, ageMs: 0, refreshing: false, ttlMs: CACHE_TTL_MS },
  calls: { file: "", exists: false, status: "none", lines: 0, unreadableLines: 0, unverified: 0, ofProject: 0, notListed: 0, readAt: ranAt },
});
/** A run that answers what `mode()` says, counting its runs; it settles a few ms later, as a real run never settles at once. */
function injected(mode: () => "good" | "broken", refusals: { key: string; at: string }[] = []) {
  let runs = 0;
  const run: Run = async (project, pkg, win) => {
    runs++;
    await new Promise((r) => setTimeout(r, 5));
    return mode() === "broken"
      ? { status: "unreadable", project, package: pkg, window: win, reason: "the instrument exited 9 with no --json report (TypeError: boom)" }
      : measuredAnswer(project, pkg, win, refusals);
  };
  return { run, runs: () => runs };
}

describe("cache", () => {
  test("the first request answers measuring; the run is shared; a fresh answer is served from the cache with its age", async () => {
    clearRefusalsCache();
    const p = registered();
    const r = injected(() => "good");
    let t = Date.parse("2026-11-05T12:00:00Z");
    const opts = { registry: p.registry, run: r.run, now: () => t, callsDir: p.top };
    const first = await readRefusals(p.name, opts);
    expect(first.response.status).toBe("measuring");
    const second = await readRefusals(p.name, { ...opts, wait: true });
    expect(second.response.status).toBe("measured");
    // The second request joined the first one's run: one run, not two.
    expect(r.runs()).toBe(1);
    const m = second.response as RefusalsMeasured;
    expect(m.totals.edits).toBe(1);
    expect(m.trialReading).toBe("TRIAL READING: UNTESTED — 0 chances");
    t += 60_000;
    const third = (await readRefusals(p.name, opts)).response as RefusalsMeasured;
    expect(third.cache.ageMs).toBe(60_000);
    expect(third.cache.refreshing).toBe(false);
    expect(r.runs()).toBe(1);
    // Stale: served with its age while a new run starts.
    t += 16 * 60_000;
    const stale = (await readRefusals(p.name, opts)).response as RefusalsMeasured;
    expect(stale.status).toBe("measured");
    expect(stale.cache.refreshing).toBe(true);
    await readRefusals(p.name, { ...opts, wait: true });
    expect(r.runs()).toBe(2);
  });

  test("each refusal carries your latest call, read at answer time; calls on refusals the answer does not list are counted", async () => {
    clearRefusalsCache();
    const p = registered();
    const r = injected(() => "good", [{ key: "toolu_R", at: "2026-10-22T16:16:24Z" }]);
    writeFileSync(join(p.top, "calls.jsonl"), [call("toolu_R", "right", "2026-10-27T10:00:00Z"), call("toolu_GONE", "wrong", "2026-10-27T10:00:00Z")].map((c) => JSON.stringify({ ...c, project: p.name })).join("\n") + "\n");
    const m = (await readRefusals(p.name, { registry: p.registry, run: r.run, wait: true, callsDir: p.top })).response as RefusalsMeasured;
    expect(m.refusals[0].call.state).toBe("called");
    if (m.refusals[0].call.state === "called") expect(m.refusals[0].call.latest.call).toBe("right");
    expect(m.calls.status).toBe("ok");
    expect(m.calls.ofProject).toBe(2);
    expect(m.calls.notListed).toBe(1);
  });
});

function fakeRun(mode: "good" | "broken") {
  clearRefusalsCache();
  const p = registered();
  let m = mode;
  const r = injected(() => m);
  const set = (x: "good" | "broken") => (m = x);
  const clock = { t: Date.parse("2026-11-05T12:00:00Z") };
  const opts = { registry: p.registry, run: r.run, now: () => clock.t, callsDir: p.top };
  return { p, opts, clock, runs: r.runs, set, read: (o: object = {}) => readRefusals(p.name, { ...opts, ...o }).then((x) => x.response) };
}

describe("cache when a run fails", () => {
  test("a failed refresh never replaces the last good answer: it is served with the failure beside it, and retried soon", async () => {
    const f = fakeRun("good");
    expect((await f.read({ wait: true })).status).toBe("measured");
    f.set("broken");
    f.clock.t += CACHE_TTL_MS + 1;
    const kept = (await f.read({ wait: true })) as RefusalsMeasured;
    expect(f.runs()).toBe(2);
    expect(kept.status).toBe("measured");
    expect(kept.totals.edits).toBe(1);
    expect(kept.cache.lastRunFailed?.reason).toContain("exited 9");
    // Served from the cache until RETRY_MS after the failure, then tried again.
    f.clock.t += RETRY_MS - 1;
    expect(((await f.read()) as RefusalsMeasured).cache.refreshing).toBe(false);
    expect(f.runs()).toBe(2);
    f.set("good");
    f.clock.t += 2;
    await f.read({ wait: true });
    expect(f.runs()).toBe(3);
    const fresh = (await f.read()) as RefusalsMeasured;
    expect(fresh.cache.lastRunFailed).toBeUndefined();
    expect(fresh.cache.ageMs).toBe(0);
  }, 30_000);

  test("an unreadable answer is cached for RETRY_MS, not the full TTL", async () => {
    const f = fakeRun("broken");
    const u = await f.read({ wait: true });
    expect(u.status).toBe("unreadable");
    if (u.status === "unreadable") expect(u.cache?.ttlMs).toBe(RETRY_MS);
    f.clock.t += RETRY_MS - 1;
    expect((await f.read()).status).toBe("unreadable");
    expect(f.runs()).toBe(1);
    f.set("good");
    f.clock.t += 2;
    expect((await f.read({ wait: true })).status).toBe("measured");
    expect(f.runs()).toBe(2);
  }, 30_000);

  test("refresh=1 starts a new run though the answer is fresh, and serves the old one while it runs", async () => {
    const f = fakeRun("good");
    await f.read({ wait: true });
    f.clock.t += 1000;
    const r = (await f.read({ refresh: true })) as RefusalsMeasured;
    expect(r.status).toBe("measured");
    expect(r.cache.refreshing).toBe(true);
    await f.read({ refresh: true, wait: true });
    expect(f.runs()).toBe(2);
  }, 30_000);

  test("isStale and settle: the rule the cache keeps", () => {
    const good = { value: { status: "measured" } as RefusalsResponse, at: 0, started: "" };
    const bad = { status: "unreadable", project: "p", reason: "boom" } as RefusalsResponse;
    expect(settle(good, bad, 5, "s")).toEqual({ ...good, failed: { at: 5, reason: "boom" } });
    expect(settle(undefined, bad, 5, "s").value).toBe(bad);
    expect(settle({ value: bad, at: 0, started: "" }, bad, 5, "s")).toEqual({ value: bad, at: 5, started: "s" });
    expect(isStale(undefined, 0)).toBe(true);
    expect(isStale({ value: bad, at: 0, started: "" }, RETRY_MS + 1)).toBe(true);
    expect(isStale({ ...good, failed: { at: CACHE_TTL_MS, reason: "x" } }, CACHE_TTL_MS + RETRY_MS)).toBe(false);
  });
});

describe("runInstrument's own temporary folder and the reason re-read", () => {
  test("a run stopped at the time limit leaves no temporary folder behind", async () => {
    const d = scratch("refusals-timeout-");
    const told = join(d, "made");
    const script = join(d, "slow.js");
    // Like checkoutAtRef: make a folder under TMPDIR, then be killed before removing it.
    writeFileSync(script, `const fs = require('fs'), os = require('os'), path = require('path');
const t = fs.mkdtempSync(path.join(os.tmpdir(), 'structure-guard-ref-'));
fs.writeFileSync(path.join(t, 'archive'), 'x');
fs.writeFileSync(${JSON.stringify(told)}, t);
setTimeout(() => {}, 60000);`);
    const r = await runInstrument("p", scratch("refusals-pkg-"), WIN, { script, timeoutMs: 1500 });
    expect(r.status).toBe("unreadable");
    if (r.status === "unreadable") expect(r.reason).toContain("time limit");
    const made = readFileSync(told, "utf8");
    expect(made.startsWith(TMP_ROOT)).toBe(true);
    expect(existsSync(made)).toBe(false);
  }, 30_000);

  test("when the reason re-read fails, each refusal says why, never blank", async () => {
    // The fake writes to fd 3 at load, so the driver's require() of it throws: the driver answers ok:false.
    const d = scratch("refusals-driver-");
    const script = join(d, "fake.js");
    writeFileSync(script, `require('fs').writeFileSync('/dev/fd/3', JSON.stringify({ calls: [{ id: 'toolu_R', outcome: 'refused', session: 's', at: '2026-10-22T16:16:24Z', tool: 'Edit', file: 'src/a.ts', transcript: '/nonexistent.jsonl' }] })); process.exit(1);`);
    const r = (await runInstrument("p", scratch("refusals-pkg-"), WIN, { script })) as RefusalsMeasured;
    expect(r.status).toBe("measured");
    expect(r.refusals[0].reason).toBeNull();
    expect(r.refusals[0].reasonError).toContain("cannot load");
  }, 30_000);
});

describe("your call on each refusal", () => {
  const read = (calls: CallRecord[], extra: Partial<CallsRead> = {}): CallsRead => ({ file: "/x/calls.jsonl", exists: true, status: "ok", lines: calls.length, unreadableLines: 0, unverified: 0, calls, byKey: byKey(calls), readAt: "", ...extra });
  test("'no call' and 'could not look' are different values", () => {
    expect(callStateOf(read([]), "k")).toEqual({ state: "none" });
    expect(callStateOf(read([], { exists: false, status: "none" }), "k")).toEqual({ state: "none" });
    const u = callStateOf(read([], { status: "unreadable", error: "/x/calls.jsonl: EISDIR" }), "k");
    expect(u.state).toBe("unknown");
    if (u.state === "unknown") expect(u.reason).toContain("EISDIR");
    // A damaged line could have been this call.
    expect(callStateOf(read([call("j", "right", "2026-10-27T09:00:00Z")], { status: "partial", lines: 2, unreadableLines: 1 }), "k").state).toBe("unknown");
    const c = callStateOf(read([call("k", "right", "2026-10-27T09:00:00Z")]), "k");
    expect(c.state === "called" && c.latest.call).toBe("right");
  });

  test("through the reader: calls.jsonl that cannot be read makes every refusal's call unknown, not none", async () => {
    clearRefusalsCache();
    const p = registered();
    mkdirSync(join(p.top, "calls.jsonl"));
    const run = injected(() => "good", [{ key: "toolu_R", at: "2026-10-22T16:16:24Z" }]).run;
    const r = (await readRefusals(p.name, { registry: p.registry, run, wait: true, callsDir: p.top })).response as RefusalsMeasured;
    expect(r.calls.status).toBe("unreadable");
    expect(r.refusals.map((x) => x.call.state)).toEqual(["unknown"]);
  }, 30_000);

  test("a project's answer counts only that project's unverified calls, as ofProject and notListed beside it do", async () => {
    clearRefusalsCache();
    const p = registered();
    const mark = (key: string, project: string): CallRecord => ({ ...call(key, "right", "2026-10-27T09:00:00Z"), project, projectFrom: "the page", unverified: "no measured answer" });
    writeFileSync(join(p.top, "calls.jsonl"), [mark("toolu_MINE", p.name), mark("toolu_OTHER1", "tmp"), mark("toolu_OTHER2", "AnviDeck")].map((c) => JSON.stringify(c)).join("\n") + "\n");
    const run = injected(() => "good", [{ key: "toolu_R", at: "2026-10-22T16:16:24Z" }]).run;
    const r = (await readRefusals(p.name, { registry: p.registry, run, wait: true, callsDir: p.top })).response as RefusalsMeasured;
    expect({ unverified: r.calls.unverified, ofProject: r.calls.ofProject, notListed: r.calls.notListed }).toEqual({ unverified: 1, ofProject: 1, notListed: 1 });
  }, 30_000);
});

// ── what the card says ─────────────────────────────────────────────────────────────────────

describe("callLine", () => {
  const read = (calls: CallRecord[], extra: Partial<CallsRead> = {}): CallsRead => ({ file: "/x/calls.jsonl", exists: true, status: "ok", lines: calls.length, unreadableLines: 0, unverified: 0, calls, byKey: byKey(calls), readAt: "", ...extra });
  test("the call as the prototype says it, with the note and earlier calls", () => {
    const l = callLine({ state: "ok", data: read([call("k", "wrong", "2026-10-25T09:00:00Z", "hm"), call("k", "right", "2026-10-27T09:00:00Z", "engine stays low")]) }, "k");
    expect(l.text).toBe("your call 10-27: right");
    expect(l.note).toBe("engine stays low");
    expect(l.earlier).toEqual(['10-25 wrong ("hm")']);
    expect(shortDay("2026-10-27T09:00:00Z")).toBe("10-27");
  });
  test("calls that could not be read never say 'no call yet'", () => {
    expect(callLine({ state: "error", error: "500 boom" }, "k").text).toContain("could not be read");
    expect(callLine({ state: "ok", data: read([], { status: "unreadable", error: "EACCES" }) }, "k").text).toContain("could not be read");
    expect(callLine({ state: "ok", data: read([]) }, "k").text).toBe("no call yet");
  });
  test("damaged lines are said beside the call", () => {
    const l = callLine({ state: "ok", data: read([call("k", "right", "2026-10-27T09:00:00Z")], { status: "partial", lines: 2, unreadableLines: 1 }) }, "k");
    expect(l.damaged).toContain("1 of 2 lines");
  });
  test("a call recorded on the page groups like the reader groups it", () => {
    const d = withRecorded(read([call("k", "wrong", "2026-10-25T09:00:00Z")]), call("k", "right", "2026-10-27T09:00:00Z"));
    expect(d.byKey.k.latest.call).toBe("right");
    expect(d.byKey.k.earlier.map((c) => c.call)).toEqual(["wrong"]);
  });
});

// ── a call's key must name a refusal the instrument counted (#178) ─────────────────────────

describe("a call on a key that is no refusal", () => {
  const h = { origin: ORIGIN, [TOKEN_HEADER]: TOKEN };
  const WIN2: RefusalWindow = { since: "2026-10-06T00:00:00.000Z", until: null, chosenBy: "test" };
  const A = measuredAnswer("proj", "/pkg", WIN2, [{ key: "toolu_REAL", at: "2026-10-22T16:16:24Z" }], "2026-11-05T12:00:00.000Z");

  const IN = "/pkg/src/a.ts";
  test("checkKey: listed, refused only when an answer could have seen it, else unverified with the reason", () => {
    expect(checkKey("toolu_REAL", { at: "2026-10-22T16:16:24Z", path: IN }, [A])).toEqual({ state: "listed", measuredAt: "2026-11-05T12:00:00.000Z" });
    const no = checkKey("toolu_TYPO", { at: "2026-10-22T16:16:24Z", path: IN }, [A]);
    expect(no.state).toBe("not-listed");
    if (no.state === "not-listed") expect(no.reason).toContain("lists no refusal with key toolu_TYPO");
    // Nothing measured: recorded, marked.
    expect(checkKey("toolu_TYPO", { at: "2026-10-22T16:16:24Z", path: IN }, []).state).toBe("unverified");
    // Newer than the run (an agent blocked a minute ago): a real refusal not measured yet, never refused.
    expect(checkKey("toolu_NEW", { at: "2026-11-05T12:01:00Z", path: IN }, [A]).state).toBe("unverified");
    // Before the window: the answer could not have seen it.
    expect(checkKey("toolu_OLD", { at: "2026-09-01T00:00:00Z", path: IN }, [A]).state).toBe("unverified");
    // No time given: cannot tell what could have seen it.
    expect(checkKey("toolu_TYPO", { path: IN }, [A]).state).toBe("unverified");
  });

  test("checkKey: an answer asked ?until later than its run never refuses a refusal made after the run", () => {
    // Asked until 2026-11-10, run at 2026-11-05 12:00: a refusal at 2026-11-07 is inside the window but
    // after the run, so the run could not have seen it.
    const U = measuredAnswer("proj", "/pkg", { ...WIN2, until: "2026-11-10T00:00:00.000Z" }, [], "2026-11-05T12:00:00.000Z");
    const late = checkKey("toolu_AFTER_RUN", { at: "2026-11-07T00:00:00Z", path: IN }, [U]);
    expect(late.state).toBe("unverified");
    // Before the run, inside the window: that answer could have seen it, so it is refused.
    expect(checkKey("toolu_BEFORE_RUN", { at: "2026-11-01T00:00:00Z", path: IN }, [U]).state).toBe("not-listed");
  });

  test("checkKey: an answer measures one package; a refusal in another package is never refused by it", () => {
    const pkgA = measuredAnswer("proj", "/m/pkgA", WIN2, [{ key: "toolu_IN_A", at: "2026-10-22T16:16:24Z" }]);
    const inB = checkKey("toolu_REAL_IN_PKG_B", { at: "2026-10-22T16:16:24Z", path: "/m/pkgB/src/x.ts" }, [pkgA]);
    expect(inB.state).toBe("unverified");
    if (inB.state === "unverified") expect(inB.reason).toContain("no measured answer is of the package holding /m/pkgB/src/x.ts");
    // A sibling folder whose name starts with the package's is not inside it.
    expect(checkKey("toolu_X", { at: "2026-10-22T16:16:24Z", path: "/m/pkgA2/x.ts" }, [pkgA]).state).toBe("unverified");
    // The same refusal in package A is refused by A's answer.
    expect(checkKey("toolu_TYPO", { at: "2026-10-22T16:16:24Z", path: "/m/pkgA/src/x.ts" }, [pkgA]).state).toBe("not-listed");
    // No path: which package's answer should list it is unknown, so unverified, never refused.
    const noPath = checkKey("toolu_TYPO", { at: "2026-10-22T16:16:24Z" }, [pkgA]);
    expect(noPath.state).toBe("unverified");
    if (noPath.state === "unverified") expect(noPath.reason).toContain("did not name the edited file's absolute path");
  });

  test("through the route and the reader's own cache: a key the measured answer does not list is refused (400) and not recorded", async () => {
    clearRefusalsCache();
    const p = registered();
    const run = injected(() => "good", [{ key: "toolu_REAL", at: "2026-10-22T16:16:24Z" }]).run;
    await readRefusals(p.name, { registry: p.registry, run, wait: true, callsDir: p.top, now: () => Date.parse("2026-11-05T12:00:00Z") });
    const s = server();
    const bad = await s.post("toolu_TYPO", h, { project: p.name, call: "wrong", refusal: { at: "2026-10-22T16:16:24Z", path: join(p.pkg, "src/a.ts") } });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain("lists no refusal with key toolu_TYPO");
    expect(existsSync(s.store.file)).toBe(false);
    const ok = await s.post("toolu_REAL", h, { project: p.name, call: "right", refusal: { at: "2026-10-22T16:16:24Z" } });
    expect(ok.status).toBe(201);
    const rec = ((await ok.json()) as { recorded: CallRecord }).recorded;
    expect(rec.unverified).toBeUndefined();
  });

  test("with no measured answer held, the call is recorded but marked unverified, and the reader counts it", async () => {
    clearRefusalsCache();
    const s = server();
    const r = await s.post("toolu_ANY", h, { project: "nothing-measured", call: "right", refusal: { at: "2026-10-22T16:16:24Z" } });
    expect(r.status).toBe(201);
    expect(((await r.json()) as { recorded: CallRecord }).recorded.unverified).toContain("no measured answer");
    const read = (await (await s.get("/api/calls?project=nothing-measured")).json()) as CallsRead;
    expect(read.unverified).toBe(1);
    expect(read.calls[0].unverified).toContain("no measured answer");
    expect(callLine({ state: "ok", data: read }, "toolu_ANY").unverified).toContain("unverified: no measured answer");
  });
});

// ── a call from an agent in a worktree belongs to its project (#179) ────────────────────────

describe("the project of a call made from an agent's folder", () => {
  const h = { origin: ORIGIN, [TOKEN_HEADER]: TOKEN };
  const g = (cwd: string, ...a: string[]) => spawnSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8" });
  /** A main checkout with a registered package, and a sibling worktree of it named like stave-wt-gaps. */
  function repoWithWorktree() {
    const root = scratch("refusals-wt-");
    const main = join(root, "calproj");
    mkdirSync(join(main, "pkg"), { recursive: true });
    g(main, "init", "-q");
    g(main, "commit", "-q", "--allow-empty", "-m", "init");
    const wt = join(root, "calproj-wt-gaps");
    expect(g(main, "worktree", "add", "-q", "-b", "gaps", wt).status).toBe(0);
    const reg = join(root, "registry.json");
    writeFileSync(reg, JSON.stringify({ packages: [{ dir: join(main, "pkg"), design: join(root, "d.json"), baseline: join(root, "b.json") }] }));
    const registry = { locked: join(root, "no-lock.json"), user: reg };
    return { root, main, wt, projects: () => discoverProjects(readRegistry(registry)), known: { projects: () => discoverProjects(readRegistry(registry)), packages: () => readRegistry(registry).packages } };
  }

  test("a parent folder that is a known project never claims a repository below it; the main checkout's name is used", () => {
    const parent = scratch("refusals-parent-");
    const repo = join(parent, "other-repo");
    mkdirSync(repo);
    g(repo, "init", "-q");
    // The parent is known (Claude was once run there), the repository is not.
    const pick = projectOfFolder(join(repo), () => [{ name: basename(parent), path: parent }]);
    expect(pick.project).toBe("other-repo");
    expect(pick.projectFrom).toContain("the main checkout's name");
    // A worktree of it, too: the main checkout's name, not the parent's and not the worktree folder's.
    g(repo, "commit", "-q", "--allow-empty", "-m", "init");
    const wt = join(parent, "other-repo-wt");
    expect(g(repo, "worktree", "add", "-q", "-b", "x", wt).status).toBe(0);
    expect(projectOfFolder(wt, () => [{ name: basename(parent), path: parent }]).project).toBe("other-repo");
  });

  test("an agent started in another repo editing a package: the call goes to the project of the answer listing its key, checked", async () => {
    clearRefusalsCache();
    const r = repoWithWorktree();
    const other = scratch("refusals-elsewhere-");
    g(other, "init", "-q");
    const WINX: RefusalWindow = { since: "2026-10-06T00:00:00.000Z", until: null, chosenBy: "test" };
    const answer = measuredAnswer("calproj", join(r.main, "pkg"), WINX, [{ key: "toolu_ELSEWHERE", at: "2026-10-22T16:16:24Z" }]);
    const s = server(undefined, { known: r.known, measured: () => [answer] });
    const res = await s.post("toolu_ELSEWHERE", h, { cwd: other, call: "wrong", refusal: { at: "2026-10-22T16:16:24Z" } });
    expect(res.status).toBe(201);
    const rec = ((await res.json()) as { recorded: CallRecord }).recorded;
    expect(rec.project).toBe("calproj");
    expect(rec.unverified).toBeUndefined();
    expect(rec.projectFrom).toContain("lists this key");
    expect(((await (await s.get("/api/calls?project=calproj")).json()) as CallsRead).calls.map((c) => c.key)).toEqual(["toolu_ELSEWHERE"]);
  });

  test("with no answer listing the key, the edited file's registered package names the project, not the agent's folder", async () => {
    clearRefusalsCache();
    const r = repoWithWorktree();
    const other = scratch("refusals-elsewhere-");
    g(other, "init", "-q");
    const s = server(undefined, { known: r.known, measured: () => [] });
    const res = await s.post("toolu_NEWER", h, { cwd: other, call: "right", refusal: { at: "2026-11-05T12:30:00Z", path: join(r.wt, "pkg", "a.ts") } });
    // The worktree's copy of the package is not the registered folder: only the registered package counts.
    expect(((await res.json()) as { recorded: CallRecord }).recorded.project).toBe(basename(other));
    const res2 = await s.post("toolu_NEWER2", h, { cwd: other, call: "right", refusal: { at: "2026-11-05T12:30:00Z", path: join(r.main, "pkg", "a.ts") } });
    const rec = ((await res2.json()) as { recorded: CallRecord }).recorded;
    expect(rec.project).toBe("calproj");
    expect(rec.projectFrom).toContain("registered package");
  });

  test("a worktree maps through its git common dir to the main checkout's project, not the folder name", () => {
    const r = repoWithWorktree();
    expect(mainCheckout(r.wt)).toEqual({ path: r.main });
    const pick = projectOfFolder(r.wt, r.projects);
    expect(pick.project).toBe("calproj");
    expect(pick.projectFrom).toContain("git common dir");
    // The main checkout itself, too.
    expect(projectOfFolder(r.main, r.projects).project).toBe("calproj");
  });

  test("a folder nothing owns falls back to its name, and the record says so", () => {
    const plain = scratch("refusals-plain-");
    const pick = projectOfFolder(plain, () => []);
    expect(pick.project).toBe(basename(plain));
    expect(pick.projectFrom).toContain("the folder's name");
  });

  test("POST with the agent's worktree folder: GET /api/calls?project=<main project> returns the call", async () => {
    clearRefusalsCache();
    const r = repoWithWorktree();
    const s = server(undefined, { known: r.known, measured: () => [] });
    const res = await s.post("toolu_WT", h, { cwd: r.wt, call: "wrong", refusal: { file: "pkg/a.ts", at: "2026-10-22T16:16:24Z" } });
    expect(res.status).toBe(201);
    const byProject = (await (await s.get("/api/calls?project=calproj")).json()) as CallsRead;
    expect(byProject.calls.map((c) => c.key)).toEqual(["toolu_WT"]);
    expect(byProject.calls[0].projectFrom).toContain(r.main);
    const byFolder = (await (await s.get("/api/calls?project=calproj-wt-gaps")).json()) as CallsRead;
    expect(byFolder.calls).toEqual([]);
  });

  test("neither a project nor an absolute folder or file, nor a listed key, is a 400, nothing recorded", async () => {
    const s = server(undefined, { measured: () => [] });
    expect((await s.post("k", h, { cwd: "relative/dir", call: "right" })).status).toBe(400);
    expect((await s.post("k", h, { call: "right", refusal: { path: "rel/a.ts" } })).status).toBe(400);
    expect(existsSync(s.store.file)).toBe(false);
  });

  test("the Agents card sends the screen's project, else the agent's folder, and the edited file's absolute path from the call's input", () => {
    const t = { id: "toolu_C", name: "Edit", input: { file_path: "/r/pkg/src/a.ts" }, at: "2026-10-22T16:16:24Z" };
    expect(refusalCallTarget(t, { file: "src/a.ts" }, null, "/r/wt")).toEqual({
      key: "toolu_C", cwd: "/r/wt", refusal: { tool: "Edit", file: "src/a.ts", path: "/r/pkg/src/a.ts", at: "2026-10-22T16:16:24Z" },
    });
    expect(refusalCallTarget(t, { file: "src/a.ts" }, "stave", "/r/wt")).toMatchObject({ project: "stave" });
    expect(refusalCallTarget(t, { file: "src/a.ts" }, "stave", "/r/wt")).not.toHaveProperty("cwd");
    // No folder and no project: neither is invented (no "unknown", no folder-name guess); the server finds it from the key or the file.
    const bare = refusalCallTarget({ ...t, input: { notebook_path: "/r/pkg/n.ipynb" }, at: null }, { file: "n.ipynb" }, undefined, undefined);
    expect(bare).toEqual({ key: "toolu_C", refusal: { tool: "Edit", file: "n.ipynb", path: "/r/pkg/n.ipynb" } });
  });
});
