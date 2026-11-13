import { describe, expect, test } from "bun:test";
import { fileTurnsLine, prAgentIds, prTurns, turnsForFile, type TurnsLoad } from "../ui/components/changes-turns";
import type { PrSession, SessionsRead } from "../shared/changes-types";
import type { CheckpointEntry, CheckpointsAnswer, TurnRecordLine } from "../shared/checkpoint-types";

/** #275: the Changes screen's join from a PR to the turns of the AnviDeck agents that worked on it. */

const BRANCH = "issue-7";
const PR = { headRefName: BRANCH, files: [{ path: "src/a.ts" }, { path: "src/b.ts" }, { path: "README.md" }] };

function session(over: Partial<PrSession> = {}): PrSession {
  return { sessionId: "s1", how: ["branch"], transcripts: [], log: null, ...over };
}
function sessions(list: PrSession[], over: Partial<Extract<SessionsRead, { status: "ok" }>> = {}): SessionsRead {
  return { status: "ok", searched: [], filesSearched: [], errors: [], sessions: list, registry: { path: "/r/agents.json", status: "read" }, ...over };
}
let n = 0;
function cp(over: Partial<CheckpointEntry> & { files?: string[] }): CheckpointEntry {
  const files = over.files ?? [];
  const { files: _f, ...rest } = over;
  return {
    kind: "checkpoint",
    n: ++n,
    at: `2026-11-13T10:${String(n).padStart(2, "0")}:00Z`,
    when: "after-turn",
    run: 1,
    tree: "t",
    head: { sha: "a".repeat(40), branch: BRANCH },
    changes: files.map((path) => ({ path, status: "M", added: 1, removed: 0 })),
    changeCount: files.length,
    ...rest,
  };
}
function answer(records: TurnRecordLine[], over: Partial<CheckpointsAnswer> = {}): TurnsLoad {
  return { state: "ok", data: { agentId: "ag1", cwd: "/w/issue-7", records, unreadable: 0, undoable: [], undo: { ok: true, warnings: [] }, folderGone: false, kept: true, prefix: "", ...over } };
}
const one = (load: TurnsLoad) => new Map([["ag1", load]]);
const AGENT = [session({ agentId: "ag1" })];

describe("from a PR to its agents", () => {
  test("the AnviDeck agents among the PR's sessions, each once; terminal sessions are not agents", () => {
    const s = sessions([session({ agentId: "ag1" }), session({ sessionId: "s2" }), session({ sessionId: "s3", agentId: "ag1" }), session({ sessionId: "s4", agentId: "ag2" })]);
    expect(prAgentIds(s)).toEqual(["ag1", "ag2"]);
    const v = prTurns(s, PR, new Map());
    expect(v.state === "agents" && v.agents.map((a) => [a.agentId, a.state])).toEqual([["ag1", "loading"], ["ag2", "loading"]]);
  });

  test("no session, a terminal session only, or an unread registry are said apart", () => {
    expect(prTurns(sessions([]), PR, new Map())).toEqual({ state: "no-agent", note: expect.stringContaining("No agent session was found") });
    expect(prTurns(sessions([session()]), PR, new Map())).toEqual({ state: "no-agent", note: expect.stringContaining("None of this PR's 1 session(s) is an AnviDeck agent") });
    const reg = sessions([session()], { registry: { path: "/r", status: "unreadable", reason: "EACCES" } });
    expect(prTurns(reg, PR, new Map())).toEqual({ state: "no-agent", note: expect.stringContaining("registry could not be read (EACCES)") });
    const partial = sessions([], { status: "partial", errors: ["grep failed"] });
    expect(prTurns(partial, PR, new Map())).toMatchObject({ note: expect.stringContaining("partial (grep failed)") });
  });

  test("sessions that could not be searched: could not look, and a file's turns are not known", () => {
    const v = prTurns({ status: "unreadable", reason: "no transcripts folder" }, PR, new Map());
    expect(v).toEqual({ state: "could-not-look", note: expect.stringContaining("no transcripts folder") });
    expect(turnsForFile(v, "src/a.ts")).toEqual({ kind: "not-known", why: expect.stringContaining("no transcripts folder") });
  });
});

describe("an agent's turns", () => {
  test("turns on the PR's branch that changed files, oldest first; checkpoints with nothing changed and other branches are counted", () => {
    const records = [
      cp({ when: "before-run" }),
      cp({ files: ["src/a.ts", "notes.txt"] }),
      cp({}),
      cp({ files: ["src/b.ts"], head: { sha: "b".repeat(40), branch: "main" } }),
      cp({ files: ["src/a.ts"], when: "run-ended" }),
    ];
    const v = prTurns(sessions(AGENT), PR, one(answer(records)));
    if (v.state !== "agents") throw new Error(v.state);
    const a = v.agents[0];
    expect(a.state).toBe("listed");
    expect(a.turns.map((t) => [t.n, t.label, t.files.map((f) => `${f.path}${f.inPr ? "" : " (not in PR)"}`)])).toEqual([
      [records[1].n, "turn ended", ["src/a.ts", "notes.txt (not in PR)"]],
      [records[4].n, "run ended mid-turn", ["src/a.ts"]],
    ]);
    expect([a.unchanged, a.otherBranch]).toEqual([1, 1]);
    expect(a.notes).toEqual([expect.stringContaining("1 checkpoint was taken on another branch than issue-7")]);
  });

  test("paths are put in the repository's terms with the folder's prefix", () => {
    const v = prTurns(sessions(AGENT), PR, one(answer([cp({ files: ["a.ts"] })], { prefix: "src/" })));
    expect(turnsForFile(v, "src/a.ts")).toMatchObject({ kind: "turns", turns: [{ files: [{ path: "src/a.ts", inPr: true }] }] });
    expect(turnsForFile(v, "a.ts")).toMatchObject({ kind: "none-recorded" });
  });

  test("a folder not placed in a checkout: its paths are not joined, and a file's turns are not known", () => {
    const v = prTurns(sessions(AGENT), PR, one(answer([cp({ files: ["src/a.ts"] })], { prefix: null })));
    expect(v.state === "agents" && v.agents[0].state).toBe("paths-unknown");
    expect(turnsForFile(v, "src/a.ts")).toEqual({ kind: "not-known", why: expect.stringContaining("could not be placed in a git checkout") });
  });

  test("labels: outside the agent before a run, and an Undo", () => {
    const v = prTurns(sessions(AGENT), PR, one(answer([cp({ when: "before-run", run: 2, files: ["README.md"] }), cp({ when: "after-undo", undoTo: 3, files: ["src/a.ts"] })])));
    expect(v.state === "agents" && v.agents[0].turns.map((t) => t.label)).toEqual(["changed outside the agent before run 2", "Undo to #3"]);
  });
});

describe("an agent with no checkpoints is labelled as such, never as 'no changes'", () => {
  test("an empty record: no checkpoint recorded, and the PR's files say which turn is not known", () => {
    const v = prTurns(sessions(AGENT), PR, one(answer([])));
    expect(v.state === "agents" && v.agents[0]).toMatchObject({ state: "no-record", turns: [], notes: [expect.stringContaining("ran before AnviDeck took checkpoints per turn")] });
    const f = turnsForFile(v, "src/a.ts");
    expect(f.kind).toBe("not-known");
    expect(fileTurnsLine(f)).toContain("Which turn changed this file is not known");
    expect(fileTurnsLine(f)).not.toContain("No recorded turn");
  });

  test("a server that takes no checkpoints (503), and a record that could not be read, are not 'no turns'", () => {
    const off = prTurns(sessions(AGENT), PR, one({ state: "error", status: 503, error: "503 this server takes no checkpoints" }));
    expect(off.state === "agents" && off.agents[0].state).toBe("off");
    expect(turnsForFile(off, "src/a.ts").kind).toBe("not-known");
    const gone = prTurns(sessions(AGENT), PR, one({ state: "error", status: 404, error: "404 no such agent" }));
    expect(gone.state === "agents" && gone.agents[0]).toMatchObject({ state: "unreadable", notes: ["Could not read its checkpoints: 404 no such agent"] });
    const net = prTurns(sessions(AGENT), PR, one({ state: "error", status: null, error: "Failed to fetch" }));
    expect(turnsForFile(net, "src/a.ts")).toEqual({ kind: "not-known", why: expect.stringContaining("Failed to fetch") });
  });

  test("still reading: not known yet", () => {
    expect(turnsForFile(prTurns(sessions(AGENT), PR, new Map()), "src/a.ts")).toEqual({ kind: "not-known", why: "reading the agents' checkpoints…" });
  });
});

describe("per file: the turns that changed it", () => {
  const two = (a: TurnsLoad, b: TurnsLoad) =>
    prTurns(sessions([session({ agentId: "ag1" }), session({ sessionId: "s2", agentId: "ag2" })]), PR, new Map([["ag1", a], ["ag2", b]]));

  test("joined across agents, oldest first; a file no turn changed is 'no recorded turn'", () => {
    const a = cp({ files: ["src/a.ts"] });
    const b = cp({ files: ["src/a.ts", "src/b.ts"] });
    const v = two(answer([b]), answer([a]));
    const f = turnsForFile(v, "src/a.ts");
    expect(f.kind === "turns" && f.turns.map((t) => [t.agentId, t.n])).toEqual([["ag2", a.n], ["ag1", b.n]]);
    expect(fileTurnsLine(f)).toBe(`Changed in #${a.n} (turn ended, agent ag2), #${b.n} (turn ended, agent ag1).`);
    expect(turnsForFile(v, "README.md")).toEqual({ kind: "none-recorded", gaps: [] });
  });

  test("one agent read and another not: what was found, marked incomplete", () => {
    const v = two(answer([cp({ files: ["src/a.ts"] })]), { state: "error", status: 500, error: "500 boom" });
    const f = turnsForFile(v, "src/a.ts");
    expect(f).toMatchObject({ kind: "turns", gaps: ["agent ag2: Could not read its checkpoints: 500 boom"] });
    expect(fileTurnsLine(f)).toContain("Not complete: agent ag2");
    expect(turnsForFile(v, "README.md")).toMatchObject({ kind: "none-recorded", gaps: [expect.stringContaining("ag2")] });
  });

  test("a turn whose file list was cut short may hold the file: said, not 'no recorded turn' alone", () => {
    const big = cp({ files: ["src/b.ts"] });
    big.changeCount = 250;
    const v = prTurns(sessions(AGENT), PR, one(answer([big])));
    const f = turnsForFile(v, "README.md");
    expect(f).toEqual({ kind: "none-recorded", gaps: [`turn #${big.n} of agent ag1 changed 249 more files than its record kept, which may include this one`] });
    expect(fileTurnsLine(f)).toContain("Not complete:");
  });

  test("unreadable record lines and failed checkpoints are said on the agent", () => {
    const v = prTurns(sessions(AGENT), PR, one(answer([cp({ files: ["src/a.ts"] }), { kind: "checkpoint-failed", at: "2026-11-13T11:00:00Z", when: "after-turn", run: 1, reason: "disk full" }], { unreadable: 2 })));
    expect(v.state === "agents" && v.agents[0].notes).toEqual([
      "2 lines of its record could not be read, so a turn may be missing.",
      expect.stringContaining("No checkpoint at 2026-11-13T11:00:00Z (after-turn, run 1): disk full"),
    ]);
  });

  test("no AnviDeck agent: no line on the file at all", () => {
    expect(fileTurnsLine(turnsForFile(prTurns(sessions([session()]), PR, new Map()), "src/a.ts"))).toBeNull();
  });
});
