import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boundaryId, completeFiles, dharanaBoundaries, layersFor, logFileMatches, sessionOfTranscript } from "../shared/changes";
import {
  boundariesTouched,
  commentTarget,
  contextFor,
  contextLine,
  evidenceView,
  guidedTour,
  openByDefault,
  parseDiff,
  pickPr,
  sessionsSummary,
} from "../ui/components/changes-model";
import { findPrSessions, readHookLog } from "../server/readers/changes";
import { encodeCwd } from "../server/readers/replay";
import changesRoute from "../server/routes/changes";
import { PR_SECTIONS_EXAMPLE } from "../shared/pr-evidence";
import type { DharanaRead, PrFile, PrSession, SessionsRead } from "../shared/changes-types";
import type { StructureMeasured, StructureProjectResponse } from "../shared/structure-types";
import type { HookLogEntry } from "../shared/types";

const entry = (file: string, ts: string, boundaries: string[] = ["B4"], patterns: string[] = ["H1"], invariants: string[] = ["V1"]): HookLogEntry => ({
  ts,
  sid: "s1",
  file,
  boundaries,
  fatality: false,
  patterns,
  invariants,
});
const session = (over: Partial<PrSession> = {}): PrSession => ({ sessionId: "s1", how: ["pr-link"], transcripts: ["/t/s1.jsonl"], log: null, ...over });
const SEARCHED = ["a.ts", "b.ts", "c.ts", "src/a.ts"];
const sessions = (list: PrSession[], errors: string[] = [], filesSearched = SEARCHED): SessionsRead => ({
  status: errors.length ? "partial" : "ok",
  searched: ["/p"],
  filesSearched,
  errors,
  sessions: list,
  registry: { path: "/r/agents.json", status: "read" },
});
const readLog = (entries: HookLogEntry[]) => ({ status: "read" as const, path: "/tmp/anvi-hook-s1.log", entries, totalEntries: entries.length + 2, malformedLines: 0 });
const files = (...paths: string[]): PrFile[] => paths.map((path) => ({ path, additions: 1, deletions: 0 }));
const dharana: DharanaRead = { status: "read", path: "/s/.anvi/dharana.md", boundaries: [{ id: "B4", title: "store write" }, { id: "B9", title: "hook process" }] };

describe("which log entries belong to a PR file", () => {
  test("same path, or one ends with the other at a folder boundary", () => {
    expect(logFileMatches("src/app/lightAim.ts", "src/app/lightAim.ts")).toBe(true);
    expect(logFileMatches("/Users/x/repo/src/a.ts", "src/a.ts")).toBe(true);
    expect(logFileMatches("app/a.ts", "src/app/a.ts")).toBe(true);
  });
  test("a name that only ends the same way is another file", () => {
    expect(logFileMatches("data.ts", "src/a.ts")).toBe(false);
    expect(logFileMatches("src/xa.ts", "a.ts")).toBe(false);
    expect(logFileMatches("", "a.ts")).toBe(false);
  });
});

describe("boundary names", () => {
  test("the ID of a logged label", () => {
    expect(boundaryId("B16: Editor view camera ↔ DAG scene cameras")).toBe("B16");
    expect(boundaryId("B7")).toBe("B7");
    expect(boundaryId("B1.2: Evaluation-wrapper")).toBe("B1.2");
  });
  test("dharana.md headings in both styles; the first heading of an ID wins", () => {
    const md = ["# Dharana", "### Boundary B1: Editor ↔ Evaluator", "text", "### B45 — The drawn geometry", "### Boundary B1: later update", "### V1: not a boundary"].join("\n");
    expect(dharanaBoundaries(md)).toEqual([
      { id: "B1", title: "Editor ↔ Evaluator" },
      { id: "B45", title: "The drawn geometry" },
    ]);
  });
});

test("a subagent's transcript belongs to its parent session", () => {
  expect(sessionOfTranscript("abc.jsonl")).toBe("abc");
  expect(sessionOfTranscript("abc/subagents/workflows/w/agent-1.jsonl")).toBe("abc");
  expect(sessionOfTranscript("memory")).toBeNull();
});

describe("layers from the structure reader's layer map", () => {
  const measured = (): StructureMeasured =>
    ({
      status: "measured",
      project: "stave",
      package: { dir: "/r/packages/editor" },
      measuredAt: { ref: "main", sha: "abcdef1234", date: "2026-11-01", why: "", modulesFrom: [] },
      modules: [
        { path: "src/engine/a.ts", rel: "engine/a.ts", component: "engine" },
        { path: "src/x.ts", rel: "x.ts", component: null },
      ],
      components: [
        { name: "engine", dirs: ["engine"], files: [], why: null, modules: 1 },
        { name: "entry", dirs: [], files: ["index.ts"], why: null, modules: 0 },
      ],
    }) as unknown as StructureMeasured;

  test("no design, or not measured, is 'unknown' with the reason, never an empty list", () => {
    const nd = { status: "no-design", project: "AnviDeck" } as StructureProjectResponse;
    const r = layersFor(files("a.ts"), nd, "");
    expect(r.status).toBe("unknown");
    expect((r as any).reason).toContain("registers no design");
    const nm = { status: "not-measured", project: "p", refAsked: null, reason: "guard crashed" } as StructureProjectResponse;
    expect(layersFor(files("a.ts"), nm, "")).toEqual({ status: "unknown", reason: "guard crashed" });
  });

  test("each file by its module, else its block's folder; outside the package and unmapped are said", () => {
    const r = layersFor(files("packages/editor/src/engine/a.ts", "packages/editor/src/engine/new.ts", "packages/editor/src/index.ts", "packages/editor/src/x.ts", "README.md"), measured(), "packages/editor");
    if (r.status !== "measured") throw new Error("expected measured");
    expect(r.files.map((f) => [f.layer, f.how])).toEqual([
      ["engine", "module"],
      ["engine", "folder"],
      ["entry", "folder"],
      [null, "unmapped"],
      [null, "outside-package"],
    ]);
    expect(r.layers).toEqual([
      { name: "engine", files: 2 },
      { name: "entry", files: 1 },
    ]);
    expect(r.measuredAt.sha).toBe("abcdef1234");
  });

  test("a design package outside the repository is unknown", () => {
    expect(layersFor(files("a.ts"), measured(), null).status).toBe("unknown");
  });
});

describe("the diff", () => {
  const text = [
    "diff --git a/src/new.ts b/src/new.ts",
    "new file mode 100644",
    "index 0000000..1111111",
    "--- /dev/null",
    "+++ b/src/new.ts",
    "@@ -0,0 +1,2 @@",
    "+one",
    "+two",
    "diff --git a/src/old.ts b/src/old.ts",
    "index 1..2 100644",
    "--- a/src/old.ts",
    "+++ b/src/old.ts",
    "@@ -10,3 +10,3 @@ function f() {",
    " keep",
    "-gone",
    "+came",
    " keep2",
    "\\ No newline at end of file",
    "diff --git a/gone.ts b/gone.ts",
    "deleted file mode 100644",
    "--- a/gone.ts",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-x",
    "diff --git a/a.txt b/b.txt",
    "similarity index 100%",
    "rename from a.txt",
    "rename to b.txt",
    "diff --git a/img.png b/img.png",
    "Binary files a/img.png and b/img.png differ",
    "",
  ].join("\n");

  test("files, statuses and both sides' line numbers", () => {
    const f = parseDiff(text);
    expect(f.map((x) => [x.path, x.status, x.binary])).toEqual([
      ["src/new.ts", "added", false],
      ["src/old.ts", "modified", false],
      ["gone.ts", "deleted", false],
      ["b.txt", "renamed", false],
      ["img.png", "modified", true],
    ]);
    expect(f[3].oldPath).toBe("a.txt");
    expect(f[0].hunks[0].lines.map((l) => l.newNo)).toEqual([1, 2]);
    const h = f[1].hunks[0];
    expect(h.lines.map((l) => [l.kind, l.oldNo, l.newNo])).toEqual([
      ["ctx", 10, 10],
      ["del", 11, null],
      ["add", null, 11],
      ["ctx", 12, 12],
      ["meta", null, null],
    ]);
    expect([f[1].additions, f[1].deletions]).toEqual([1, 1]);
    expect(f[2].hunks[0].oldLines).toBe(1);
  });

  test("files open with their diff while the line budget lasts, in PR order", () => {
    const f = parseDiff(text);
    expect([...openByDefault(f, 3)]).toEqual(["src/new.ts"]);
    expect(openByDefault(f, 2500).size).toBe(5);
  });
});

describe("context the agent received at a file", () => {
  test("a session search that failed is 'could not look', never 'no session'", () => {
    const c = contextFor("a.ts", { status: "unreadable", reason: "EACCES" });
    expect(c.kind).toBe("could-not-look");
    expect(contextFor("a.ts", sessions([], ["grep: EIO"])).kind).toBe("could-not-look");
  });

  test("no session found says so in words", () => {
    const c = contextFor("a.ts", sessions([]));
    expect(c.kind).toBe("no-session");
    expect(contextLine(c, {}, dharana)).toContain("No agent session found for this PR");
  });

  test("a session whose hook log is absent says the log is not present, not 'no context'", () => {
    const c = contextFor("a.ts", sessions([session({ log: { status: "absent", path: "/tmp/anvi-hook-s1.log" } })]));
    expect(c.kind).toBe("no-log");
    expect(contextLine(c, {}, dharana)).toContain("/tmp/anvi-hook-s1.log is not present");
  });

  test("a read log with no firing for this file is 'not fired', with the other files' count", () => {
    const c = contextFor("a.ts", sessions([session({ log: readLog([entry("b.ts", "2026-11-01T00:00:00Z")]) })]));
    expect(c).toMatchObject({ kind: "not-fired", otherEntries: 1, gaps: { unreadLogs: 0, noSessionId: 0, searchErrors: [] } });
    expect(contextLine(c, {}, dharana)).not.toContain("incomplete");
  });

  test("firings for the file are joined across sessions, oldest first, and an unread log is counted", () => {
    const c = contextFor(
      "src/a.ts",
      sessions([
        session({ sessionId: "s1", log: readLog([entry("src/a.ts", "2026-11-02T00:00:00Z", ["B4"], ["H1", "H2"], ["V1"])]) }),
        session({ sessionId: "s2", log: readLog([entry("src/a.ts", "2026-11-01T00:00:00Z", ["B9: hook process"], ["H2"], ["V3"])]) }),
        session({ sessionId: "s3", log: { status: "unreadable", path: "/tmp/x", reason: "EACCES" } }),
      ]),
    );
    if (c.kind !== "fired") throw new Error(c.kind);
    expect(c.fires.map((f) => f.sessionId)).toEqual(["s2", "s1"]);
    expect(c.boundaries).toEqual(["B9: hook process", "B4"]);
    expect(c.patterns).toEqual(["H2", "H1"]);
    expect(c.gaps.unreadLogs).toBe(1);
    const line = contextLine(c, { H1: "a count printed without its population" }, dharana);
    expect(line).toContain("B9 hook process, B4 store write");
    expect(line).toContain('H1 "a count printed without its population"');
    expect(line).toContain("may be incomplete");
  });
});

describe("a file the hook logs were not searched for", () => {
  test("is 'not searched', never 'the injector logged nothing'", () => {
    // gh pr view lists 100 files; file 101 was never looked for in the log.
    const s = sessions([session({ log: readLog([entry("a.ts", "2026-11-01T00:00:00Z")]) })], [], ["a.ts"]);
    const c = contextFor("file-101.ts", s);
    expect(c.kind).toBe("not-searched");
    expect(contextLine(c, {}, dharana)).toContain("Not searched");
    expect(contextLine(c, {}, dharana)).not.toContain("logged nothing");
  });
});

describe("a partial session search, with sessions found", () => {
  const partial = (list: PrSession[]) => {
    const s = sessions(list, ["agent registry: /r/agents.json: JSON Parse error"]);
    if (s.status === "unreadable") throw new Error("x");
    return { ...s, registry: { path: "/r/agents.json", status: "unreadable" as const, reason: "JSON Parse error" } };
  };
  test("the comment box says the registry could not be read, not 'a terminal session'", () => {
    const t = commentTarget(partial([session()]), { state: "ok", agents: [] });
    expect(t).toEqual({ enabled: false, why: expect.stringContaining("agent registry could not be read") });
    if (t.enabled) throw new Error("on");
    expect(t.why).not.toContain("not started by AnviDeck");
  });
  test("a failed grep with the registry read: 'may have been missed', not 'a terminal session'", () => {
    const t = commentTarget(sessions([session()], ["grep for x: EIO"]), { state: "ok", agents: [] });
    expect(t).toEqual({ enabled: false, why: expect.stringContaining("may have been missed") });
  });
  test("a file's 'nothing logged' carries the search errors", () => {
    const c = contextFor("a.ts", partial([session({ log: readLog([entry("b.ts", "2026-11-01T00:00:00Z")]) })]));
    if (c.kind !== "not-fired") throw new Error(c.kind);
    expect(c.gaps.searchErrors).toEqual(["agent registry: /r/agents.json: JSON Parse error"]);
    expect(contextLine(c, {}, dharana)).toContain("search for the PR's sessions was partial");
  });
  test("the screen's session summary shows the errors and the registry's state", () => {
    const v = sessionsSummary(partial([session()]));
    expect(v.problems).toEqual(["Partial search: agent registry: /r/agents.json: JSON Parse error"]);
    expect(v.lines.join("\n")).toContain("agent registry could not be read");
    expect(v.lines[0]).toContain("whether AnviDeck started it is not known");
    expect(v.lines[0]).not.toContain("not started by AnviDeck");
  });
});

describe("boundaries the PR touches", () => {
  const withLog = sessions([session({ log: readLog([entry("a.ts", "2026-11-01T00:00:00Z", ["B4"]), entry("b.ts", "2026-11-01T00:00:00Z", ["B4", "B9"])]) })]);

  test("no dharana.md: none recorded", () => {
    const v = boundariesTouched({ dharana: { status: "none", searched: ["/p/.anvi/dharana.md"] }, sessions: withLog }, files("a.ts"));
    expect(v.state).toBe("none-recorded");
    expect(v.note).toContain("None recorded");
  });

  test("an unreadable dharana.md is not 'none'", () => {
    expect(boundariesTouched({ dharana: { status: "unreadable", path: "/d", reason: "EACCES" }, sessions: withLog }, files("a.ts")).state).toBe("unreadable");
  });

  test("dharana but no session: not known, never an empty list", () => {
    const v = boundariesTouched({ dharana, sessions: sessions([]) }, files("a.ts"));
    expect(v.state).toBe("unknown");
    expect(v.note).toContain("no agent session found");
  });

  test("one log read with nothing for the files, another absent: not known, never 'logged nothing'", () => {
    const two = sessions([
      session({ sessionId: "s1", how: ["branch"], log: readLog([]) }),
      session({ sessionId: "s2", agentId: "a1", log: { status: "absent", path: "/tmp/anvi-hook-s2.log" } }),
    ]);
    const v = boundariesTouched({ dharana, sessions: two }, files("a.ts"));
    expect(v.state).toBe("unknown");
    expect(v.note).not.toContain("logged nothing");
    expect(v.note).toContain("absent or could not be read");
  });

  test("an agent with no session id yet is said as such, not as a log that could not be read", () => {
    const s = sessions([session({ sessionId: "s1", log: readLog([]) }), session({ sessionId: null, agentId: "a1", how: ["agent-issue"], log: null })]);
    const c = contextFor("a.ts", s);
    if (c.kind !== "not-fired") throw new Error(c.kind);
    expect(c.gaps).toEqual({ unreadLogs: 0, noSessionId: 1, searchErrors: [] });
    const line = contextLine(c, {}, dharana);
    expect(line).toContain("no session id yet");
    expect(line).not.toContain("could not be read");
    expect(boundariesTouched({ dharana, sessions: s }, files("a.ts")).state).toBe("unknown");
  });

  test("boundaries found while another log was not read are listed, marked incomplete", () => {
    const s = sessions([
      session({ sessionId: "s1", log: readLog([entry("a.ts", "2026-11-01T00:00:00Z", ["B4"])]) }),
      session({ sessionId: "s2", log: { status: "unreadable", path: "/tmp/x", reason: "EACCES" } }),
    ]);
    const v = boundariesTouched({ dharana, sessions: s }, files("a.ts"));
    if (v.state !== "listed") throw new Error(v.state);
    expect(v.items.map((i) => i.id)).toEqual(["B4"]);
    expect(v.incomplete).toBe(true);
    expect(v.note).toContain("May be incomplete");
  });

  test("listed from the injector's firings for the PR's files, titled from dharana", () => {
    const v = boundariesTouched({ dharana, sessions: withLog }, files("a.ts", "b.ts", "c.ts"));
    if (v.state !== "listed") throw new Error(v.state);
    expect(v.items).toEqual([
      { id: "B4", name: "B4 store write", files: ["a.ts", "b.ts"] },
      { id: "B9", name: "B9 hook process", files: ["b.ts"] },
    ]);
  });
});

describe("where a line comment goes", () => {
  const agentSession = sessions([session({ agentId: "a1" })]);
  test("no session, or a terminal session: off, saying why", () => {
    expect(commentTarget(sessions([]), { state: "ok", agents: [] })).toEqual({ enabled: false, why: expect.stringContaining("No agent session found") });
    expect(commentTarget(sessions([session()]), { state: "ok", agents: [] })).toEqual({ enabled: false, why: expect.stringContaining("not started by AnviDeck") });
  });
  test("agents that could not be read are not 'not running'", () => {
    const t = commentTarget(agentSession, { state: "failed", reason: "500" });
    expect(t).toEqual({ enabled: false, why: expect.stringContaining("Could not read the agents") });
  });
  test("one running agent: on", () => {
    expect(commentTarget(agentSession, { state: "ok", agents: [{ id: "a1", status: "working" }] })).toMatchObject({ enabled: true, agentId: "a1" });
    expect(commentTarget(agentSession, { state: "ok", agents: [{ id: "a1", status: "waiting" }] })).toMatchObject({ enabled: true });
  });
  test("a stopped agent: off, naming its status", () => {
    const t = commentTarget(agentSession, { state: "ok", agents: [{ id: "a1", status: "stopped" }] });
    expect(t).toEqual({ enabled: false, why: expect.stringContaining("a1 is stopped") });
  });
  test("two running agents: off, no guess", () => {
    const two = sessions([session({ agentId: "a1" }), session({ sessionId: "s2", agentId: "a2" })]);
    const t = commentTarget(two, { state: "ok", agents: [{ id: "a1", status: "working" }, { id: "a2", status: "working" }] });
    expect(t).toEqual({ enabled: false, why: expect.stringContaining("does not guess") });
  });
  test("an agent another AnviDeck server runs: off, saying where, never promising delivery (#104)", () => {
    const at = { pid: 4242, port: 4135 };
    const t = commentTarget(agentSession, { state: "ok", agents: [{ id: "a1", status: "working", runsElsewhere: at }] });
    expect(t.enabled).toBe(false);
    if (t.enabled) throw new Error("on");
    expect(t.why).toContain("another AnviDeck server (port 4135, pid 4242)");
    expect(t.why).not.toContain("Goes to agent");
    expect(t.elsewhere).toEqual({ agentId: "a1", at });
    // Its sibling here is still the one that takes the comment.
    const two = sessions([session({ agentId: "a1" }), session({ sessionId: "s2", agentId: "a2" })]);
    expect(commentTarget(two, { state: "ok", agents: [{ id: "a1", status: "working", runsElsewhere: at }, { id: "a2", status: "working" }] })).toMatchObject({ enabled: true, agentId: "a2" });
  });
});

describe("guided tour", () => {
  const pf = files("a.ts", "b.ts", "c.ts");
  test("files in the order commits first touched them", () => {
    const t = guidedTour(
      {
        status: "ok",
        commits: [
          { oid: "1111111aaa", headline: "first", authoredDate: "", files: ["b.ts", "x-not-in-pr.ts"] },
          { oid: "2222222bbb", headline: "second", authoredDate: "", files: ["a.ts", "b.ts", "c.ts"] },
        ],
      },
      pf,
    );
    expect(t.steps.map((s) => [s.file, s.commit?.index])).toEqual([
      ["b.ts", 1],
      ["a.ts", 2],
      ["c.ts", 2],
    ]);
    expect(t.state).toBe("ok");
  });
  test("a commit whose files could not be read: its files come last, marked, and the tour says partial", () => {
    const t = guidedTour(
      {
        status: "partial",
        reason: "1 of 2 commits' files could not be read",
        commits: [
          { oid: "1", headline: "first", authoredDate: "", files: ["c.ts"] },
          { oid: "2", headline: "second", authoredDate: "", files: null, filesError: "gone" },
        ],
      },
      pf,
    );
    expect(t.steps.map((s) => [s.file, s.commit?.index ?? null])).toEqual([
      ["c.ts", 1],
      ["a.ts", null],
      ["b.ts", null],
    ]);
    expect(t.state).toBe("partial");
    expect(t.note).toContain("Partial");
  });
  test("commits unreadable: every file still listed, in PR order", () => {
    const t = guidedTour({ status: "unreadable", reason: "gh failed" }, pf);
    expect(t.state).toBe("unreadable");
    expect(t.steps.map((s) => s.file)).toEqual(["a.ts", "b.ts", "c.ts"]);
  });
});

describe("evidence and self-review, exactly as parsed", () => {
  test("a body in the format shows its tests, observations and gaps", () => {
    const v = evidenceView(`## Summary\nx\n\n${PR_SECTIONS_EXAMPLE}`);
    if (v.evidence.state !== "recorded" || v.selfReview.state !== "recorded") throw new Error("expected recorded");
    expect(v.evidence.value.tests.map((t) => [t.command, t.exitCode])).toEqual([
      ["bun test", 0],
      ["bunx tsc --noEmit -p .", 0],
    ]);
    expect(v.selfReview.value.gaps.map((g) => g.issue?.number ?? null)).toEqual([101, null]);
  });
  test("a body without the sections, or with them written wrong, says 'not in the evidence format' and why", () => {
    const none = evidenceView("Just a summary.");
    expect(none.evidence).toEqual({ state: "not-in-format", why: expect.stringContaining('no "## Evidence" section') });
    const bad = evidenceView("## Evidence\n\nsome prose\n\n## Self-review\n\nNone found.");
    expect(bad.evidence).toEqual({ state: "not-in-format", why: expect.stringMatching(/^Not in the evidence format: Evidence must contain only/) });
    expect(bad.selfReview).toEqual({ state: "recorded", value: { gaps: [] } });
  });
});

test("which PR: the URL's, else the newest open one, else the picker", () => {
  const open = [
    { number: 5, createdAt: "2026-11-01T00:00:00Z" },
    { number: 7, createdAt: "2026-11-03T00:00:00Z" },
    { number: 6, createdAt: "2026-11-02T00:00:00Z" },
  ];
  expect(pickPr("139", open)).toBe(139);
  expect(pickPr(null, open)).toBe(7);
  expect(pickPr("abc", [])).toBeNull();
});

describe("every file the PR changes, past gh pr view's 100", () => {
  const listed = files(...Array.from({ length: 100 }, (_, i) => `f${i}.ts`));
  const all = files(...Array.from({ length: 153 }, (_, i) => `f${i}.ts`));
  const diffOf = (paths: string[]) => paths.map((path) => ({ path, oldPath: null, status: "modified" as const, binary: false, hunks: [], additions: 2, deletions: 1 }));
  test("all listed by gh pr view: taken as they are", () => {
    expect(completeFiles(listed, 100, null, null)).toEqual({ files: listed, read: { status: "complete", from: "gh pr view" } });
  });
  test("100 of 153: the paged files API gives all 153", () => {
    const r = completeFiles(listed, 153, { ok: true, files: all }, null);
    expect(r.files.length).toBe(153);
    expect(r.read).toEqual({ status: "complete", from: "gh api" });
  });
  test("paging failed: the diff fills the gap, with its counts", () => {
    const r = completeFiles(listed, 153, { ok: false, reason: "HTTP 502" }, diffOf(all.map((f) => f.path)));
    expect(r.files.length).toBe(153);
    expect(r.files[152]).toEqual({ path: "f152.ts", additions: 2, deletions: 1 });
    expect(r.read).toEqual({ status: "complete", from: "gh pr view + diff" });
  });
  test("paging failed and no diff: partial, saying how many were not looked for", () => {
    const r = completeFiles(listed, 153, { ok: false, reason: "HTTP 502" }, null);
    expect(r.files.length).toBe(100);
    if (r.read.status !== "partial") throw new Error(r.read.status);
    expect(r.read.reason).toContain("listed 100 of 153");
    expect(r.read.reason).toContain("HTTP 502");
    expect(r.read.reason).toContain("53 file(s) are not shown and were not looked for");
  });
});

describe("the injector's log for a session", () => {
  const sid = `changes-test-${process.pid}`;
  const path = `/tmp/anvi-hook-${sid}.log`;
  afterAll(() => rmSync(path, { force: true }));

  test("absent is 'absent', not an empty read", () => {
    expect(readHookLog(`${sid}-none`, ["a.ts"], null)).toEqual({ status: "absent", path: `/tmp/anvi-hook-${sid}-none.log` });
  });

  test("keeps the PR's files only, drops firings after the PR closed, and counts bad lines", () => {
    writeFileSync(
      path,
      [
        JSON.stringify(entry("src/a.ts", "2026-11-01T00:00:00Z")),
        JSON.stringify(entry("src/other.ts", "2026-11-01T00:00:00Z")),
        JSON.stringify(entry("src/a.ts", "2026-11-09T00:00:00Z")),
        "{not json",
        "",
      ].join("\n"),
    );
    const r = readHookLog(sid, ["src/a.ts"], "2026-11-05T00:00:00Z");
    if (r.status !== "read") throw new Error(r.status);
    expect(r.entries.map((e) => e.ts)).toEqual(["2026-11-01T00:00:00Z"]);
    expect([r.totalEntries, r.malformedLines]).toEqual([3, 1]);
    expect((readHookLog(sid, ["src/a.ts"], null) as any).entries.length).toBe(2);
  });
});

describe("finding the PR's sessions across the repository's checkouts", () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "chg-sessions-")));
  const main = join(tmp, "main");
  const side = join(tmp, "side");
  const projects = join(tmp, "projects");
  const reg = join(tmp, "reg");
  const sid = (n: string) => `chgtest-${process.pid}-${n}`;
  const savedAgentDir = process.env.ANVIDECK_AGENT_DIR;
  afterAll(() => {
    if (savedAgentDir === undefined) delete process.env.ANVIDECK_AGENT_DIR;
    else process.env.ANVIDECK_AGENT_DIR = savedAgentDir;
    rmSync(tmp, { recursive: true, force: true });
  });

  test("pr-link in a sibling worktree, the branch in the main checkout, the registry agent for a closed issue; not another repo's folder", async () => {
    const git = (cwd: string, ...a: string[]) => {
      const p = Bun.spawnSync(["git", "-C", cwd, ...a], { stdout: "pipe", stderr: "pipe" });
      if (p.exitCode !== 0) throw new Error(p.stderr.toString());
    };
    mkdirSync(main, { recursive: true });
    git(main, "init", "-q", "-b", "main");
    git(main, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "x");
    git(main, "worktree", "add", "-q", "-b", "feat/9-x", side);
    const put = (dir: string, file: string, line: string) => {
      mkdirSync(join(projects, dir, file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ""), { recursive: true });
      writeFileSync(join(projects, dir, file), line + "\n");
    };
    const url = `"prUrl":"https://github.com/o/r/pull/7"`;
    put(encodeCwd(side), `${sid("S1")}.jsonl`, `{"type":"pr-link",${url},"prNumber":7}`);
    put(encodeCwd(main), `${sid("S2")}.jsonl`, `{"type":"user","gitBranch":"feat/9-x"}`);
    put(encodeCwd(main), `${sid("S3")}/subagents/w/agent-1.jsonl`, `{"type":"pr-link",${url}}`);
    put("-elsewhere-other-repo", `${sid("S4")}.jsonl`, `{"type":"pr-link",${url}}`);
    mkdirSync(reg, { recursive: true });
    writeFileSync(join(reg, "agents.json"), JSON.stringify({ agents: [{ id: "a1", sessionId: sid("S1"), cwd: side }, { id: "a2", cwd: main, issue: 9 }, { id: "a3", cwd: "/elsewhere", issue: 9 }, { id: "a4", cwd: main, issue: 10 }] }));
    process.env.ANVIDECK_AGENT_DIR = reg;

    const pr = { number: 7, headRefName: "feat/9-x", closingIssues: [9], files: [{ path: "a.ts", additions: 1, deletions: 0 }], mergedAt: null, closedAt: null } as any;
    const r = await findPrSessions(main, "o/r", pr, projects);
    if (r.status === "unreadable") throw new Error(r.reason);
    expect(r.errors).toEqual([]);
    expect(r.filesSearched).toEqual(["a.ts"]);
    const got = r.sessions.map((s) => [s.sessionId, s.how.sort().join("+"), s.agentId ?? null]).sort((a, b) => String(a[0] ?? "").localeCompare(String(b[0] ?? "")));
    expect(got).toEqual([
      [null, "agent-issue", "a2"],
      [sid("S1"), "pr-link", "a1"],
      [sid("S2"), "branch", null],
      [sid("S3"), "pr-link", null],
    ]);
    expect(r.sessions.find((s) => s.sessionId === sid("S1"))!.log).toEqual({ status: "absent", path: `/tmp/anvi-hook-${sid("S1")}.log` });
  });

  test("a corrupt agent registry: partial, and the PR's terminal-looking session is not called 'not started by AnviDeck'", async () => {
    const bad = join(tmp, "bad-reg");
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, "agents.json"), "{not json");
    process.env.ANVIDECK_AGENT_DIR = bad;
    const pr = { number: 7, headRefName: "feat/9-x", closingIssues: [9], files: [{ path: "a.ts", additions: 1, deletions: 0 }], mergedAt: null, closedAt: null } as any;
    const r = await findPrSessions(main, "o/r", pr, projects);
    if (r.status === "unreadable") throw new Error(r.reason);
    expect(r.status).toBe("partial");
    expect(r.registry.status).toBe("unreadable");
    expect(r.sessions.length).toBeGreaterThan(0);
    const t = commentTarget(r, { state: "ok", agents: [] });
    if (t.enabled) throw new Error("on");
    expect(t.why).toContain("agent registry could not be read");
    expect(sessionsSummary(r).problems[0]).toContain("agent registry");
  });

  test("a transcripts folder that cannot be read is 'unreadable', not 'no session'", async () => {
    const r = await findPrSessions(main, "o/r", { number: 7, headRefName: "x", closingIssues: [], files: [] } as any, join(tmp, "no-such-dir"));
    expect(r.status).toBe("unreadable");
  });
});

describe("the routes", () => {
  test("a PR number that is not a number, and a missing project, are refused with the reason", async () => {
    const bad = await changesRoute.request("/pr/abc?project=x");
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toContain("whole number");
    const noProject = await changesRoute.request("/prs");
    expect(noProject.status).toBe(400);
    expect((await noProject.json()).error).toContain("?project=");
    const unknown = await changesRoute.request("/prs?project=no-such-project-xyz");
    expect(unknown.status).toBe(404);
  });
});
