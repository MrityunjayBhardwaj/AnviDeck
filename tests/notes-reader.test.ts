import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  currencyFromRun,
  currencySettled,
  forgetCurrency,
  gtCheckFromRun,
  ownerOf,
  readGtCheck,
  readCurrency,
  readSnapshotSeries,
  readUsage,
  type Spawned,
  type SpawnFn,
} from "../server/readers/notes";
import { notesRoutes } from "../server/routes/notes";

const base = { project: "p", path: "/p", command: "node r.js --json /p", startedAt: "2026-11-05T10:00:00Z" };
const run = (o: Partial<Spawned>): Spawned => ({ code: 0, stdout: "", stderr: "", timedOut: false, ...o });
const report = (entries: object[] = [{ catalogue: "hetvabhasa", id: "H1", status: "YELLOW", state: "drifted", drifted: ["a/b.js"], gone: "x/y.js, z.js", anchor: "VALIDATED" }]) =>
  JSON.stringify({ project: "p", examined: entries.length, counts: { GREEN: 0, YELLOW: 1, RED: 0, GRAY: 0, REFERENCE: 0, WITHHELD: 0 }, states: { primaries: 1, verified: 0, drifted: 1, "never confirmed": 0, "not checked": 0 }, entries });

const tmp: string[] = [];
const dir = () => {
  const d = mkdtempSync(join(tmpdir(), "notes-test-"));
  tmp.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
  forgetCurrency();
});

describe("anvi's currency report, one run", () => {
  test("exit 0 with the report's JSON is ok, with its own counts; gone files are split as the report joins them", () => {
    const a = currencyFromRun(base, run({ stdout: report() }), "t");
    expect(a.state).toBe("ok");
    expect(a.examined).toBe(1);
    expect(a.counts!.YELLOW).toBe(1);
    expect(a.states).toEqual({ primaries: 1, verified: 0, drifted: 1, "never confirmed": 0, "not checked": 0 });
    expect(a.entries![0]!.gone).toEqual(["x/y.js", "z.js"]);
    expect(a.partial).toBe(0);
    expect(a.withheldKinds).toEqual([]);
  });

  test("keeps what the report says it could not look at: partial verdicts, withheld areas, per entry", () => {
    const j = JSON.parse(report([
      { catalogue: "hetvabhasa", id: "H1", status: "YELLOW", state: "drifted", partial: true, drifted: [], gone: null, anchor: "VALIDATED" },
      { catalogue: "hetvabhasa", id: "H2", status: "WITHHELD", state: "not checked", partial: false, drifted: [], gone: null, anchor: "none" },
    ]));
    const a = currencyFromRun(base, run({ stdout: JSON.stringify({ ...j, partial: 1, withheld_kinds: ["ref"] }) }), "t");
    expect(a.state).toBe("ok");
    expect(a.partial).toBe(1);
    expect(a.withheldKinds).toEqual(["ref"]);
    expect(a.entries!.map((e) => e.partial ?? false)).toEqual([true, false]);
  });

  test("each failure says what it is and is never 'ok' with nothing in it", () => {
    expect(currencyFromRun(base, run({ code: 2, stderr: "no .anvi catalogues for /p" }), "t")).toMatchObject({ state: "none", reason: "no .anvi catalogues for /p" });
    expect(currencyFromRun(base, run({ code: 3, stderr: "catalogues WITHHELD for /p" }), "t")).toMatchObject({ state: "withheld" });
    expect(currencyFromRun(base, run({ code: 1, stderr: "boom" }), "t")).toMatchObject({ state: "unreadable", reason: "exit 1: boom" });
    expect(currencyFromRun(base, run({ code: null, timedOut: true }), "t").state).toBe("unreadable");
    expect(currencyFromRun(base, run({ code: null, error: "spawn node ENOENT" }), "t")).toMatchObject({ state: "unreadable", reason: "spawn node ENOENT" });
    expect(currencyFromRun(base, run({ stdout: "not json" }), "t").state).toBe("unreadable");
    expect(currencyFromRun(base, run({ stdout: "{}" }), "t")).toMatchObject({ state: "unreadable", reason: "the report's JSON has no examined/counts/entries" });
    for (const r of [run({ code: 1 }), run({ stdout: "{}" }), run({ timedOut: true, code: null })]) expect(currencyFromRun(base, r, "t").examined).toBeUndefined();
  });
});

describe("anvi's currency report, kept per project", () => {
  function fakeSpawn() {
    const calls: string[][] = [];
    let release: (r: Spawned) => void = () => {};
    const fn: SpawnFn = (cmd, args) => {
      calls.push([cmd, ...args]);
      return new Promise((ok) => (release = ok));
    };
    return { fn, calls, finish: (r: Spawned) => release(r) };
  }

  test("the first ask starts one run and answers measuring; a second ask meanwhile starts nothing", async () => {
    const f = fakeSpawn();
    expect(readCurrency("p", "/p", { spawnFn: f.fn, script: "/s/r.js" }).state).toBe("measuring");
    expect(readCurrency("p", "/p", { spawnFn: f.fn, script: "/s/r.js", refresh: true }).state).toBe("measuring");
    expect(f.calls).toEqual([["node", "/s/r.js", "--json", "/p"]]);
    f.finish(run({ stdout: report() }));
    expect((await currencySettled("/p"))!.state).toBe("ok");
    expect(readCurrency("p", "/p", { spawnFn: f.fn }).state).toBe("ok");
    expect(f.calls.length).toBe(1);
  });

  test("asking again keeps the last answer, marked, until the new run finishes", async () => {
    const f = fakeSpawn();
    readCurrency("p", "/p", { spawnFn: f.fn });
    f.finish(run({ stdout: report() }));
    await currencySettled("/p");
    const during = readCurrency("p", "/p", { spawnFn: f.fn, refresh: true });
    expect(during).toMatchObject({ state: "ok", measuringAgain: true });
    expect(f.calls.length).toBe(2);
    f.finish(run({ code: 1, stderr: "broke" }));
    await currencySettled("/p");
    expect(readCurrency("p", "/p", { spawnFn: f.fn })).toMatchObject({ state: "unreadable", reason: "exit 1: broke" });
  });
});

describe("the fleet snapshots, for one project", () => {
  test("each snapshot that measures the project is a point; one that doesn't is named", () => {
    const d = dir();
    writeFileSync(join(d, "health-2026-09-03.json"), JSON.stringify({ date: "2026-09-03", projects: { p: { examined: 10, counts: { YELLOW: 3, RED: 1 } } } }));
    writeFileSync(join(d, "health-2026-10-02.json"), JSON.stringify({ date: "2026-10-02", projects: { other: { examined: 5, counts: {} } } }));
    writeFileSync(join(d, "health-README.md"), "not a snapshot");
    const s = readSnapshotSeries("p", d);
    expect(s.status).toBe("ok");
    expect(s.points.map((p) => [p.date, p.examined, p.yellow, p.red])).toEqual([["2026-09-03", 10, 3, 1]]);
    expect(s.notMeasuredIn).toEqual(["2026-10-02"]);
  });

  test("a snapshot that cannot be read is an error, not a missing point", () => {
    const d = dir();
    writeFileSync(join(d, "health-2026-09-03.json"), "{ broken");
    expect(readSnapshotSeries("p", d)).toMatchObject({ status: "unreadable", points: [] });
    writeFileSync(join(d, "health-2026-09-21.json"), JSON.stringify({ projects: { p: { examined: 1, counts: {} } } }));
    expect(readSnapshotSeries("p", d).status).toBe("partial");
    expect(readSnapshotSeries("p", join(d, "absent")).status).toBe("none");
  });
});

describe("injector deliveries, for one project's sessions", () => {
  test("a session belongs to the longest known project its transcript folder starts with", () => {
    expect(ownerOf("-a-proj", ["-a-proj", "-a-proj-x"])).toBe("-a-proj");
    expect(ownerOf("-a-proj--claude-worktrees-w1", ["-a-proj", "-a-proj-x"])).toBe("-a-proj");
    expect(ownerOf("-a-proj-x", ["-a-proj", "-a-proj-x"])).toBe("-a-proj-x");
    expect(ownerOf("-a-projectile", ["-a-proj"])).toBeNull();
  });

  function setup() {
    const logs = dir();
    const projects = dir();
    const now = new Date("2026-11-05T12:00:00Z");
    for (const [folder, sid] of [["-a-proj", "s1"], ["-a-proj--claude-worktrees-w1", "s2"], ["-a-proj-x", "s3"]] as const) {
      mkdirSync(join(projects, folder), { recursive: true });
      writeFileSync(join(projects, folder, `${sid}.jsonl`), "");
    }
    const line = (sid: string, ts: string, patterns: string[], invariants: string[] = [], boundaries: string[] = []) =>
      JSON.stringify({ ts, sid, file: "f.ts", boundaries, fatality: false, patterns, invariants });
    writeFileSync(join(logs, "anvi-hook-s1.log"), [line("s1", "2026-11-04T10:00:00Z", ["H1", "H2"], ["V1"], ["B1"]), line("s1", "2026-09-01T10:00:00Z", ["H1"]), "garbage"].join("\n"));
    writeFileSync(join(logs, "anvi-hook-s2.log"), line("s2", "2026-11-05T10:00:00Z", ["H1"]));
    writeFileSync(join(logs, "anvi-hook-s3.log"), line("s3", "2026-11-05T10:00:00Z", ["H9"]));
    writeFileSync(join(logs, "anvi-hook-nobody.log"), line("nobody", "2026-11-05T10:00:00Z", ["H1"]));
    return { logs, projects, now };
  }

  test("counts this project's and its worktrees' deliveries in the window, per catalogue and ID", () => {
    const { logs, projects, now } = setup();
    const u = readUsage("proj", "/a/proj", ["/a/proj", "/a/proj-x"], { now, logDir: logs, projectsDir: projects });
    expect(u.status).toBe("ok");
    expect(u.sessions).toBe(2);
    expect(u.edits).toBe(2);
    expect(u.uses).toEqual({ "hetvabhasa/H1": 2, "hetvabhasa/H2": 1, "vyapti/V1": 1, "dharana/B1": 1 });
    expect(u.delivered).toEqual({ hetvabhasa: 3, vyapti: 1, dharana: 1 });
    expect(u.malformed).toBe(1);
    expect(u.logsRead).toBe(4);
  });

  test("where the logs reach: the oldest line read, never before the window; null when nothing was read", () => {
    const { logs, projects, now } = setup();
    // s1 has a line from 2026-09-01, before the 30-day window: the logs reach the whole window.
    expect(readUsage("proj", "/a/proj", [], { now, logDir: logs, projectsDir: projects, days: 30 }).coveredFrom).toBe("2026-10-06T12:00:00.000Z");
    // Only logs from the last day: the window shown starts at their oldest line, whoever's session it is.
    const fresh = dir();
    writeFileSync(join(fresh, "anvi-hook-x.log"), JSON.stringify({ ts: "2026-11-05T09:00:00Z", sid: "nobody", patterns: [] }) + "\n" + JSON.stringify({ ts: "2026-11-05T11:00:00Z", sid: "nobody", patterns: [] }));
    expect(readUsage("proj", "/a/proj", [], { now, logDir: fresh, projectsDir: projects }).coveredFrom).toBe("2026-11-05T09:00:00.000Z");
    // A log untouched since before the window reaches the whole window without being read.
    const old = dir();
    writeFileSync(join(old, "anvi-hook-y.log"), "x");
    const t = new Date("2026-08-01T00:00:00Z");
    utimesSync(join(old, "anvi-hook-y.log"), t, t);
    expect(readUsage("proj", "/a/proj", [], { now, logDir: old, projectsDir: projects }).coveredFrom).toBe("2026-10-06T12:00:00.000Z");
    expect(readUsage("proj", "/a/proj", [], { now, logDir: dir(), projectsDir: projects }).coveredFrom).toBeNull();
  });

  test("a log untouched since before the window is skipped without reading", () => {
    const { logs, projects, now } = setup();
    const old = new Date("2026-08-01T00:00:00Z");
    utimesSync(join(logs, "anvi-hook-s2.log"), old, old);
    const u = readUsage("proj", "/a/proj", ["/a/proj"], { now, logDir: logs, projectsDir: projects });
    expect(u.uses["hetvabhasa/H1"]).toBe(1);
  });

  test("no log folder is none; it is never read as 'no deliveries'", () => {
    const u = readUsage("proj", "/a/proj", [], { logDir: join(dir(), "absent"), projectsDir: dir() });
    expect(u.status).toBe("none");
  });
});

describe("Ground Truth docs, as anvi's citation check measures them", () => {
  const doc = (name: string, verdicts: [string, number][]) => ({
    doc: `/r/GROUND_TRUTH_${name}.md`,
    sections: [{ heading: null, line: 1, citations: 0, verdict: "preamble" }, ...verdicts.map(([verdict, citations], i) => ({ heading: `${i}.`, line: i + 2, citations, verdict }))],
  });

  test("counts sections without the preamble, by verdict, and all citations", () => {
    const out = JSON.stringify([doc("GIT_PLUMBING", [["cited", 3], ["uncitable", 0], ["cited", 2]]), doc("GH", [["missing", 0], ["cited", 1]])]);
    const a = gtCheckFromRun("/r", "c", run({ code: 1, stdout: out }), "t");
    expect(a.state).toBe("missing");
    expect(a.docs).toEqual([
      { doc: "/r/GROUND_TRUTH_GIT_PLUMBING.md", system: "GIT_PLUMBING", sections: 3, cited: 2, uncitable: 1, missing: 0, citations: 5 },
      { doc: "/r/GROUND_TRUTH_GH.md", system: "GH", sections: 2, cited: 1, uncitable: 0, missing: 1, citations: 1 },
    ]);
    expect(gtCheckFromRun("/r", "c", run({ stdout: out }), "t").state).toBe("ok");
  });

  test("NOT MEASURED (exit 2), a crash or garbage is not-measured with no docs, never a doc with 0 sections", () => {
    expect(gtCheckFromRun("/r", "c", run({ code: 2, stderr: "gt-citation-check: NOT MEASURED — cannot read /r" }), "t")).toMatchObject({ state: "not-measured", docs: [], reason: "gt-citation-check: NOT MEASURED — cannot read /r" });
    expect(gtCheckFromRun("/r", "c", run({ stdout: "nope" }), "t")).toMatchObject({ state: "not-measured", docs: [] });
    expect(gtCheckFromRun("/r", "c", run({ code: null, timedOut: true }), "t")).toMatchObject({ state: "not-measured", docs: [] });
  });

  test("no ref folder is none, and nothing is run", async () => {
    let ran = false;
    const a = await readGtCheck(null, { spawnFn: async () => ((ran = true), run({})) });
    expect(a.state).toBe("none");
    expect(ran).toBe(false);
  });
});

describe("GET /api/notes", () => {
  const projects = () => [{ name: "p", path: "/p" }];

  test("an unknown project is a 404 with the reason", async () => {
    const r = await notesRoutes({ projects }).request("/currency?project=nope");
    expect(r.status).toBe(404);
    expect((await r.json()).error).toContain("nope");
  });

  test("currency answers measuring at once, then anvi's counts, with the snapshot series", async () => {
    let release: (r: Spawned) => void = () => {};
    const spawnFn: SpawnFn = () => new Promise((ok) => (release = ok));
    const app = notesRoutes({ projects, spawnFn, script: "/s/r.js", healthDir: dir() });
    const first = await (await app.request("/currency?project=p")).json();
    expect(first.currency.state).toBe("measuring");
    expect(first.currency.command).toBe("node /s/r.js --json /p");
    expect(first.series.status).toBe("none");
    release(run({ stdout: report() }));
    await currencySettled("/p");
    const second = await (await app.request("/currency?project=p")).json();
    expect(second.currency).toMatchObject({ state: "ok", examined: 1 });
  });
});
