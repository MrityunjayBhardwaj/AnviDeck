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
import { byKey, readCalls } from "../server/readers/calls";
import { listStructure } from "../server/readers/structure";
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
    expect(r).toEqual({ at: "2026-10-27T12:00:00.000Z", key: "toolu_01WH1U6BSSp7vQGkSwJ9vjez", project: "stave", call: "right", note, refusal: { file: "src/engine/StrudelEngine.ts", at: "2026-10-22T16:16:25Z" } });
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

function server(dir = scratch()) {
  const log = new ActionLog(join(dir, "log"));
  const app = new Hono();
  installGuard(app, { bind: "127.0.0.1", token: TOKEN, log });
  const store = new CallStore(dir);
  app.route("/api", refusalRoutes({ store }));
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

describe("cache", () => {
  test("the first request answers measuring; the run is shared; a fresh answer is served from the cache with its age", async () => {
    clearRefusalsCache();
    const p = registered();
    const counter = join(p.top, "runs");
    const script = join(p.top, "fake.js");
    writeFileSync(script, `require('fs').appendFileSync(${JSON.stringify(counter)}, 'x'); console.log('  TRIAL READING: UNTESTED — 0 chances'); require('fs').writeFileSync('/dev/fd/3', JSON.stringify({ calls: [{ id: 'a', outcome: 'applied', session: 's' }], transcripts: 1 })); process.exit(3);`);
    let t = Date.parse("2026-11-05T12:00:00Z");
    const opts = { registry: p.registry, script, now: () => t, callsDir: p.top };
    const first = await readRefusals(p.name, opts);
    expect(first.response.status).toBe("measuring");
    const second = await readRefusals(p.name, { ...opts, wait: true });
    expect(second.response.status).toBe("measured");
    const m = second.response as RefusalsMeasured;
    expect(m.totals.edits).toBe(1);
    expect(m.trialReading).toBe("TRIAL READING: UNTESTED — 0 chances");
    expect(m.instrument.exit).toBe(3);
    t += 60_000;
    const third = (await readRefusals(p.name, opts)).response as RefusalsMeasured;
    expect(third.cache.ageMs).toBe(60_000);
    expect(third.cache.refreshing).toBe(false);
    expect(readFileSync(counter, "utf8")).toBe("x");
    // Stale: served with its age while a new run starts.
    t += 16 * 60_000;
    const stale = (await readRefusals(p.name, opts)).response as RefusalsMeasured;
    expect(stale.status).toBe("measured");
    expect(stale.cache.refreshing).toBe(true);
    await readRefusals(p.name, { ...opts, wait: true });
    expect(readFileSync(counter, "utf8")).toBe("xx");
  }, 30_000);

  test("each refusal carries your latest call, read at answer time", async () => {
    clearRefusalsCache();
    const p = registered();
    const script = join(p.top, "fake.js");
    writeFileSync(script, `require('fs').writeFileSync('/dev/fd/3', JSON.stringify({ calls: [{ id: 'toolu_R', outcome: 'refused', session: 's', at: '2026-10-22T16:16:24Z', tool: 'Edit', file: 'src/a.ts', transcript: '/nonexistent.jsonl' }] })); process.exit(1);`);
    writeFileSync(join(p.top, "calls.jsonl"), JSON.stringify(call("toolu_R", "right", "2026-10-27T10:00:00Z")) + "\n");
    const r = (await readRefusals(p.name, { registry: p.registry, script, wait: true, callsDir: p.top })).response as RefusalsMeasured;
    expect(r.refusals[0].call.state).toBe("called");
    if (r.refusals[0].call.state === "called") expect(r.refusals[0].call.latest.call).toBe("right");
    expect(r.calls.status).toBe("ok");
    // The reason could not be re-read (the transcript is gone): said, not left blank.
    expect(r.refusals[0].reason).toBeNull();
    expect(r.refusals[0].reasonError).toBeTruthy();
  }, 30_000);
});

/**
 * A registered package and one fake instrument whose behaviour is chosen by a mode file beside it
 * (its bytes, and so the cache key, stay the same), run through readRefusals on a clock the test moves.
 */
function fakeRun(mode: "good" | "broken") {
  clearRefusalsCache();
  const p = registered();
  const counter = join(p.top, "runs");
  const modeFile = join(p.top, "mode");
  const script = join(p.top, "fake.js");
  writeFileSync(script, `const fs = require('fs');
fs.appendFileSync(${JSON.stringify(counter)}, 'x');
if (fs.readFileSync(${JSON.stringify(modeFile)}, 'utf8') === 'broken') { console.error('TypeError: boom'); process.exit(9); }
fs.writeFileSync('/dev/fd/3', JSON.stringify({ calls: [{ id: 'a', outcome: 'applied', session: 's' }], transcripts: 1 })); process.exit(3);`);
  const set = (m: "good" | "broken") => writeFileSync(modeFile, m);
  set(mode);
  const clock = { t: Date.parse("2026-11-05T12:00:00Z") };
  const opts = { registry: p.registry, script, now: () => clock.t, callsDir: p.top };
  const runs = () => (existsSync(counter) ? readFileSync(counter, "utf8").length : 0);
  return { p, opts, clock, runs, set, read: (o: object = {}) => readRefusals(p.name, { ...opts, ...o }).then((r) => r.response) };
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
  const read = (calls: CallRecord[], extra: Partial<CallsRead> = {}): CallsRead => ({ file: "/x/calls.jsonl", exists: true, status: "ok", lines: calls.length, unreadableLines: 0, calls, byKey: byKey(calls), readAt: "", ...extra });
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
    const script = join(p.top, "fake.js");
    writeFileSync(script, `require('fs').writeFileSync('/dev/fd/3', JSON.stringify({ calls: [{ id: 'toolu_R', outcome: 'refused', session: 's', at: '2026-10-22T16:16:24Z', tool: 'Edit', file: 'src/a.ts', transcript: '/nonexistent.jsonl' }] })); process.exit(1);`);
    mkdirSync(join(p.top, "calls.jsonl"));
    const r = (await readRefusals(p.name, { registry: p.registry, script, wait: true, callsDir: p.top })).response as RefusalsMeasured;
    expect(r.calls.status).toBe("unreadable");
    expect(r.refusals.map((x) => x.call.state)).toEqual(["unknown"]);
  }, 30_000);
});

// ── what the card says ─────────────────────────────────────────────────────────────────────

describe("callLine", () => {
  const read = (calls: CallRecord[], extra: Partial<CallsRead> = {}): CallsRead => ({ file: "/x/calls.jsonl", exists: true, status: "ok", lines: calls.length, unreadableLines: 0, calls, byKey: byKey(calls), readAt: "", ...extra });
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
