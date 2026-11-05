import { describe, expect, test } from "bun:test";
import {
  ASK_EMPTY,
  NO_FATALITY_SIGNALS,
  NO_MOVES_SOURCE,
  NO_PLACEMENT,
  askPrompt,
  askQuestion,
  guardRegistration,
  boundaryClusters,
  callStates,
  callsPhrase,
  costGap,
  enforcement,
  flowNodes,
  headlinePair,
  heldGroups,
  lensOf,
  pairClusters,
  structureGap,
  tally,
  trialRows,
  trialSummary,
} from "../ui/components/design-model";
import type { StructureMeasured } from "../shared/structure-types";
import type { Refusal, RefusalsMeasured, RefusalsResponse } from "../shared/refusal-types";
import type { EditHooksAnswer, FixCostMeasured, HookSettingsFile, PairCost } from "../shared/design-types";
import type { BoundaryInfo } from "../shared/types";

function structure(over: Partial<StructureMeasured> = {}): StructureMeasured {
  return {
    status: "measured",
    project: "stave",
    package: { dir: "/s/packages/editor", design: "/L/design.json", baseline: "/L/baseline.json", designId: "cffdf7d00026", extractor: null, source: "locked", check: { mode: "refuse" } },
    refAsked: null,
    refChosenBy: "default",
    measuredAt: { ref: "origin/main", sha: "6a5c17c682ad", date: "2026-11-05T17:21:15+05:30", why: "", modulesFrom: [] },
    designId: "cffdf7d00026",
    baselineDesignId: "cffdf7d00026",
    components: [],
    allowedPairs: [],
    edgeNotes: {},
    modules: [],
    edges: [
      { from: "src/a/x.ts", to: "src/w/y.ts", fromComponent: "a", toComponent: "w", pair: "a -> w", class: "grandfathered", cycle: null, reexport: false, typeOnly: false },
      { from: "src/v/1.ts", to: "src/w/2.ts", fromComponent: "v", toComponent: "w", pair: "v -> w", class: "grandfathered", cycle: null, reexport: false, typeOnly: false },
      { from: "src/v/3.ts", to: "src/w/4.ts", fromComponent: "v", toComponent: "w", pair: "v -> w", class: "grandfathered", cycle: null, reexport: false, typeOnly: false },
      { from: "src/v/5.ts", to: "src/w/6.ts", fromComponent: "v", toComponent: "w", pair: "v -> w", class: "allowed", cycle: null, reexport: false, typeOnly: false },
    ],
    cycles: [],
    rules: { divergence: { examined: 301, total: 3, grandfathered: 3, new: [], fixed: [] }, cycle: { examined: 0, total: 0, grandfathered: 0, new: [], fixed: [] } },
    byPair: [{ pair: "a -> w", count: 1 }, { pair: "v -> w", count: 2 }],
    unmapped: [],
    absences: [],
    counts: {
      modules: 367, edges: 938, examinedBetweenComponents: 301,
      byClass: { internal: 0, allowed: 0, grandfathered: 3, new: 0, unmapped: 0 },
      divergence: { total: 3, grandfathered: 3, new: 0, fixed: 0 },
      cycle: { total: 0, grandfathered: 0, new: 0, fixed: 0 },
      baselineKeys: { divergence: 3, cycle: 0 },
      relativeImports: 938, unresolvedRelative: 0,
    },
    extractor: "",
    typeOnlyImports: "",
    source: { label: "structure-guard", guard: { path: "", sha256: "", mtime: "" }, rules: null, graph: null },
    timing: { cache: "hit", ms: 0, guardMs: null },
    ...over,
  };
}

function refusal(key: string, at: string, over: Partial<Refusal> = {}): Refusal {
  return {
    key, at, session: "s1", tool: "Edit", file: "src/engine/E.ts", checkout: "registered", checkoutDir: "/s", version: null, transcript: "/t.jsonl",
    refusedBy: "graph rule", checkToo: false, design: "cffdf7d00026", violations: [{ rule: "divergence", key: "a -> b" }],
    pairs: [{ key: "src/engine/E.ts -> src/monaco/M.ts", pair: "engine -> monaco" }], reason: "BLOCKED", call: { state: "none" }, ...over,
  };
}

function refusals(rs: Refusal[], over: Partial<RefusalsMeasured> = {}): RefusalsMeasured {
  return {
    status: "measured", project: "stave", package: "/s/packages/editor",
    window: { since: "2026-10-06T00:00:00.000Z", until: null, chosenBy: "default" },
    instrument: { name: "structure-refusals.js", path: "/r.js", sha256: "abc", mtime: "", args: [], ranAt: "2026-11-05T12:13:53.242Z", ms: 1, exit: 1, exitMeaning: "" },
    transcripts: { read: 4417, unreadable: 0, badLines: 0 },
    totals: { edits: 704, sessions: 26, applied: 696, refused: rs.length, refusedByCheckAlone: 0, deniedOtherwise: 1, erroredOtherwise: 4, noResult: 0, timedOut: 0, cancelled: 0, unrecognised: 0 },
    notices: {}, refusals: rs, timeouts: [], unrecognised: [],
    exposure: { chances: rs.length, refused: rs.length, missed: 0 }, defaultBranch: null, byDesign: [], trialReading: null, report: "",
    cache: { at: "", ageMs: 0, refreshing: false, ttlMs: 1 },
    calls: { file: "/c.jsonl", exists: true, status: "ok", lines: 0, unreadableLines: 0, readAt: "" },
    ...over,
  };
}

const called = (call: "right" | "wrong") => ({ state: "called" as const, latest: { at: "2026-10-27T00:00:00Z", key: "k", project: "stave", call }, earlier: [] });

describe("lenses", () => {
  test("the lens comes from ?lens, Armed by default", () => {
    expect(lensOf(new URLSearchParams("lens=path"))).toBe("path");
    expect(lensOf(new URLSearchParams("lens=nope"))).toBe("armed");
    expect(lensOf(new URLSearchParams(""))).toBe("armed");
  });

  test("a design that could not be measured says why; no design says nothing is enforced", () => {
    expect(structureGap({ status: "not-measured", project: "p", refAsked: null, reason: "guard crashed" }, null)).toContain("guard crashed");
    expect(structureGap({ status: "no-design", project: "p", path: "/p", label: "nothing blocked", refAsked: null, refChosenBy: "", measuredAt: null, treeFrom: "git", folders: [], files: 0, timing: { cache: "hit", ms: 0 } }, null)).toContain("nothing is enforced");
    expect(structureGap(null, "status 500")).toContain("could not be read");
    expect(structureGap(structure(), null)).toBeNull();
  });
});

describe("Armed", () => {
  const hooks = (names: string[], files: HookSettingsFile[] = [{ scope: "user", file: "/settings.json", status: "read" }]): EditHooksAnswer => ({
    readAt: "2026-11-05T12:00:00Z", files, notRead: "hooks from plugins and from skill or agent frontmatter are not read here",
    hooks: names.map((name) => ({ matcher: "Edit", name, command: name, file: files[0]?.file ?? "/settings.json" })),
  });

  test("enforcement names the design, the held breaks with where and when they were measured, and who can change it", () => {
    const rows = Object.fromEntries(enforcement(structure(), hooks(["structure-guard-hook.js"])).map((r) => [r.k, r]));
    expect(rows["graph rule"].v).toBe("refusing");
    expect(rows["project's own check"].v).toBe("refuse");
    expect(rows.design.v).toBe("cffdf7d00026");
    expect(rows["allowed breaks"].v).toBe("3 held · 0 new · 0 cycles");
    expect(rows["allowed breaks"].note).toContain("origin/main 6a5c17c (commit of 2026-11-05)");
    expect(rows.change.v).toBe("needs owner sudo");
    const user = Object.fromEntries(enforcement(structure({ package: { ...structure().package, source: "user", check: null } }), hooks(["structure-guard-hook.js"])).map((r) => [r.k, r]));
    expect(user.change.v).toBe("your own registry");
    expect(user["project's own check"].v).toBe("none registered");
  });

  test("the graph rule refuses only if the edit hook is registered; settings that cannot be read leave it unknown", () => {
    const k = (h: EditHooksAnswer | null) => enforcement(structure(), h).find((r) => r.k === "graph rule")!;
    const unreadable: HookSettingsFile[] = [{ scope: "user", file: "/s", status: "read" }, { scope: "project", file: "/p/.claude/settings.json", status: "unreadable", reason: "EACCES" }];
    expect(k(hooks([], unreadable)).v).toBe("unknown");
    expect(k(hooks([], unreadable)).note).toContain("/p/.claude/settings.json (unreadable: EACCES)");
  });

  test("a guard hook found in no settings file read is 'not found', never 'not running': plugins are not read", () => {
    const k = (h: EditHooksAnswer) => enforcement(structure(), h).find((r) => r.k === "graph rule")!;
    const all: HookSettingsFile[] = [
      { scope: "user", file: "/u/settings.json", status: "read" },
      { scope: "project", file: "/p/.claude/settings.json", status: "absent" },
      { scope: "project-local", file: "/p/.claude/settings.local.json", status: "absent" },
      { scope: "managed", file: "/m.json", status: "absent" },
    ];
    const r = k(hooks(["catalogue-context-injector.js"], all));
    expect(r.v).toBe("hook not found");
    expect(r.tone).toBe("warn");
    expect(r.note).toContain("plugins");
    expect(r.note).toContain("/p/.claude/settings.json (absent)");
    // Registered in the project's own settings, not yours: refusing, and it says where.
    const inProject = hooks(["structure-guard-hook.js"], [all[1], all[0]].map((f) => ({ ...f, status: "read" as const })));
    expect(guardRegistration(inProject)).toBe("registered");
    expect(k(inProject).v).toBe("refusing");
    expect(k(inProject).note).toContain("/p/.claude/settings.json");
  });

  test("a new rule break turns the allowed breaks red", () => {
    const s = structure();
    s.counts.divergence.new = 1;
    expect(enforcement(s, null).find((r) => r.k === "allowed breaks")!.tone).toBe("bad");
  });

  test("the trial record has one row per refusal key, oldest first, and says how many repeats were merged", () => {
    const r = refusals([refusal("b", "2026-10-22T16:16:24Z"), refusal("a", "2026-10-13T05:03:45Z", { pairs: [] }), refusal("b", "2026-10-22T16:16:24Z")]);
    const { rows, merged } = trialRows(r);
    expect(rows.map((x) => x.key)).toEqual(["a", "b"]);
    expect(merged).toBe(1);
    expect(rows[0].edge).toBe("divergence"); // no pair named: the rule
    expect(rows[1].edge).toBe("engine -> monaco");
    const t = tally(rows, callStates(r));
    expect(t.rows).toBe(2);
    expect(trialSummary(r, t, merged)).toMatchObject({ population: expect.stringContaining("1 repeated row with the same key merged") });
  });

  test("the summary names its population, so zero refusals read as 0 of N edits", () => {
    const r = refusals([], { exposure: { chances: 0, missed: 0 } });
    const s = trialSummary(r, tally([], callStates(r)), 0);
    expect("line" in s && s.line).toBe("0 chances · 0 blocked · 0 missed · nothing to call");
    expect("population" in s && s.population).toContain("0 of 704 edits to packages/editor refused, in 26 sessions since 2026-10-06");
  });

  test("an instrument still reading, not measured or unreadable is a gap, never a zero", () => {
    const t = tally([], {});
    for (const r of [
      { status: "measuring", project: "p", package: "/x", window: { since: "", until: null, chosenBy: "" }, startedAt: "2026-11-05T00:00:00Z" },
      { status: "not-measured", project: "p", reason: "no edits in the window" },
      { status: "unreadable", project: "p", reason: "node missing" },
      { status: "no-design", project: "p", reason: "no package" },
    ] as RefusalsResponse[]) {
      const s = trialSummary(r, t, 0);
      expect("gap" in s).toBe(true);
    }
  });

  test("calls are counted from the answer and from calls recorded since; unreadable ones apart", () => {
    const r = refusals([refusal("a", "2026-10-13T00:00:00Z", { call: called("right") }), refusal("b", "2026-10-22T00:00:00Z"), refusal("c", "2026-10-27T00:00:00Z", { call: { state: "unknown", reason: "torn line" } })]);
    const { rows } = trialRows(r);
    expect(tally(rows, callStates(r))).toEqual({ rows: 3, right: 1, wrong: 0, none: 1, unknown: 1 });
    const after = tally(rows, callStates(r, { b: "wrong" }));
    expect(after).toEqual({ rows: 3, right: 1, wrong: 1, none: 0, unknown: 1 });
    expect(callsPhrase(after)).toBe("you called 2 of 3: 1 right, 1 wrong · 1 could not be read (a call you made may not show)");
    // a recorded call on a key that is not a row changes nothing
    expect(tally(rows, callStates(r, { zz: "right" }))).toEqual({ rows: 3, right: 1, wrong: 0, none: 1, unknown: 1 });
  });

  test("the calls phrase matches the prototype's wording when every call agrees", () => {
    expect(callsPhrase({ rows: 2, right: 2, wrong: 0, none: 0, unknown: 0 })).toBe("you called both right");
    expect(callsPhrase({ rows: 3, right: 0, wrong: 3, none: 0, unknown: 0 })).toBe("you called all 3 wrong");
    expect(callsPhrase({ rows: 3, right: 0, wrong: 0, none: 3, unknown: 0 })).toBe("no call yet on any of the 3");
  });
});

describe("Placed", () => {
  test("no source records a placement, and the screen says so", () => {
    expect(NO_PLACEMENT).toContain("no source records one");
  });

  test("an empty question is no question: nothing stands in for it", () => {
    expect(askQuestion("   ")).toEqual({ ok: false, why: ASK_EMPTY });
    expect(askQuestion("")).toEqual({ ok: false, why: ASK_EMPTY });
    expect(askQuestion("  where?  ")).toEqual({ ok: true, question: "where?" });
  });

  test("the question is sent verbatim, with the design it is asked against and an instruction to change nothing", () => {
    const p = askPrompt("stave", structure(), "  Where should a tempo map go?  ");
    expect(p).toContain("Question: Where should a tempo map go?\n");
    expect(p).toContain("do not create, edit or delete any file, and do not commit");
    expect(p).toContain("/s/packages/editor is cffdf7d00026: /L/design.json");
    expect(p).toContain("/L/baseline.json");
    expect(p).toContain("origin/main (6a5c17c)");
  });
});

describe("Consolidated", () => {
  test("clusters are the guard's pairs, most first", () => {
    expect(pairClusters(structure())).toEqual([{ where: "v → w", count: 2 }, { where: "a → w", count: 1 }]);
  });

  test("the prototype's fatality-signal table is said to be missing, with its issue", () => {
    for (const w of ["error patterns at one boundary", "an invariant spanning modules", "a lifecycle crossing boundaries", "approaching", "#210"]) expect(NO_FATALITY_SIGNALS).toContain(w);
  });

  test("boundaries keep only those whose catalogue says the fatality test tripped, with the heading's own count and date", () => {
    const bs: BoundaryInfo[] = [
      { id: "B10", name: "viz preview PLACEMENT arms ↔ shell state — TRACKED 2026-07-07 (cont.66, fatality test TRIPPED: 6 patterns)", fatality: true, patternCount: 0 },
      { id: "B4", name: "worker DOM shim ↔ p5 — TRACKED 2026-06-11 (fatality test TRIPPED)", fatality: true, patternCount: 0 },
      { id: "B15", name: "REPRESENTATION SEAMS — TRACKED 2026-07-15 (cont.94, fatality test TRIPPED: 4 instances, 9+ patterns)", fatality: true, patternCount: 0 },
      { id: "B2", name: "viz `language` ↔ renderer `kind`", fatality: false, patternCount: 1 },
    ];
    expect(boundaryClusters(bs)).toEqual([
      { id: "B10", name: "viz preview PLACEMENT arms ↔ shell state", stated: "6 patterns", date: "2026-07-07" },
      { id: "B4", name: "worker DOM shim ↔ p5", stated: null, date: "2026-06-11" },
      { id: "B15", name: "REPRESENTATION SEAMS", stated: "4 instances", date: "2026-07-15" },
    ]);
  });

  const pc = (pair: string, held: number, files: number[], trend: PairCost["trend"]): PairCost => ({ pair, held, trend, fixes: files.map((f, i) => ({ sha: `s${i}`, date: `2026-0${i + 1}-01T00:00:00Z`, subject: "🐛", files: f })) });
  const cost = (pairs: PairCost[]): FixCostMeasured => ({ status: "measured", project: "p", package: "/x", at: { ref: "origin/main", sha: "abc", date: null }, predicate: "", trendRule: "", commits: 10, fixCommits: 3, unmappedFiles: 0, pairs, command: "", ms: 0 });

  test("the curve is drawn for the pair with the most held breaks that has enough fixes to say", () => {
    const c = cost([pc("a -> b", 11, [1, 2, 3], "rising"), pc("c -> d", 20, [4], "too few"), pc("e -> f", 2, [3, 3, 3], "flat")]);
    expect(headlinePair(c)!.pair).toBe("a -> b");
    expect(costGap(c, null)).toBeNull();
  });

  test("the cost curve says why it cannot be measured rather than drawing an example", () => {
    expect(costGap({ status: "not-measured", project: "p", reason: "the structure is not measured" }, null)).toContain("cannot be measured: the structure is not measured");
    expect(costGap(null, "status 500")).toContain("could not be measured");
    expect(costGap(cost([]), null)).toContain("holds no rule break");
    const few = costGap(cost([pc("a -> b", 3, [2], "too few"), pc("c -> d", 1, [], "too few")]), null);
    expect(few).toContain("no pair has the 3 fixes");
    expect(few).toContain("a -> b: 1 fix; c -> d: 0 fixes");
  });
});

describe("Path to target", () => {
  test("no source lists moves; the held breaks are grouped by pair, allowed imports left out", () => {
    expect(NO_MOVES_SOURCE).toContain("No source lists the moves");
    expect(heldGroups(structure())).toEqual([
      { pair: "v → w", imports: [{ from: "src/v/1.ts", to: "src/w/2.ts" }, { from: "src/v/3.ts", to: "src/w/4.ts" }] },
      { pair: "a → w", imports: [{ from: "src/a/x.ts", to: "src/w/y.ts" }] },
    ]);
  });
});

describe("System flows", () => {
  test("each step's figure is measured or null; the guard step says when the hook is not registered", () => {
    const r = refusals([refusal("a", "2026-10-13T00:00:00Z")]);
    const t = tally(trialRows(r).rows, callStates(r));
    const hooks: EditHooksAnswer = {
      readAt: "2026-11-05T12:00:00Z", files: [{ scope: "user", file: "/s.json", status: "read" }], notRead: "plugins are not read",
      hooks: ["tree-lock-guard.js", "structure-guard-hook.js", "catalogue-context-injector.js"].map((name) => ({ matcher: "Edit", name, command: name, file: "/s.json" })),
    };
    const n = Object.fromEntries(flowNodes(r, hooks, t).map((x) => [x.id, x]));
    expect(n.call.figure).toBe("704 edits in 26 sessions");
    // Claude Code starts matching hooks together: the other hooks are listed, not sequenced, and
    // a hook listed after the guard is as much "with" it as one listed before.
    expect(n.hooks.figure).toBe("tree-lock-guard.js · catalogue-context-injector.js");
    expect(n.hooks.next).toBe("with");
    expect(n.hooks.label).not.toContain("Context");
    expect(n.hooks.source).toContain("parallel");
    expect(flowNodes(r, hooks, t).map((x) => x.next)).toEqual(["→", "with", "→", "or", "→", null]);
    expect(n.guard.figure).toBe("1 refused · 1 denied by something else · 4 errored");
    expect(n.lands.figure).toBe("696 applied");
    expect(n.refusal.figure).toBe("1 refusal");
    expect(n.ruling.figure).toBe("0 of 1 called");
    const none = Object.fromEntries(flowNodes(null, null, null).map((x) => [x.id, x]));
    for (const k of Object.keys(none)) expect(none[k].figure).toBeNull();
    const noGuard = { ...hooks, hooks: hooks.hooks.filter((h) => h.name !== "structure-guard-hook.js") };
    expect(flowNodes(r, noGuard, t).find((x) => x.id === "guard")!.figure).toBe("structure-guard-hook.js not found in the settings read");
  });
});
