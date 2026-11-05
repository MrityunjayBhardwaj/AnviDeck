import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  EVENT_CAP,
  HistoryError,
  compareCode,
  compareKnowledge,
  dayOf,
  diffEntries,
  readActionLane,
  readCatalogueLane,
  readCommitLane,
  readHistory,
  readRefusalLane,
  readRulingLane,
  readTranscriptLanes,
  scanTranscript,
  windowFrom,
} from "../server/readers/history";
import { historyRoutes, wideRefusals } from "../server/routes/history";
import { defaultSince } from "../server/readers/refusals";
import {
  ROWS,
  cellCount,
  cellEvents,
  codeLine,
  daysBetween,
  designLine,
  knowledgeLine,
  mapReplayHash,
  replayHash,
  rowNote,
  rowState,
  shouldPoll,
  showingLine,
  sourceLines,
  totalLine,
  windowDays,
} from "../ui/components/history-model";
import { parseAgentsScreenParams } from "../ui/components/agents-model";
import { HISTORY_KINDS, type HistoryEvent, type HistoryResponse, type HistoryWindow, type LaneRead } from "../shared/history-types";
import type { RefusalsResponse, Refusal } from "../shared/refusal-types";
import type { ReplaySessionsResponse } from "../shared/replay-types";
import type { StructureProjectResponse } from "../shared/structure-types";

const tmp: string[] = [];
const dir = () => {
  const d = mkdtempSync(join(tmpdir(), "history-test-"));
  tmp.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

const W: HistoryWindow = { since: "2026-10-22T00:00:00.000Z", until: "2026-10-24T00:00:00.000Z", tzMinutes: 0 };

function git(cwd: string, args: string[], date?: string) {
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) };
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}
function commitFile(repo: string, file: string, text: string, date: string, msg: string) {
  mkdirSync(join(repo, file, ".."), { recursive: true });
  writeFileSync(join(repo, file), text);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", msg], date);
  return git(repo, ["rev-parse", "HEAD"]);
}
function repoWithMain() {
  const r = dir();
  git(r, ["init", "-q", "-b", "main"]);
  return r;
}
const pointMain = (r: string) => git(r, ["update-ref", "refs/remotes/origin/main", "HEAD"]);

// ── the window ─────────────────────────────────────────────────────────────────────────────

describe("the window", () => {
  test("defaults to the 14 days before until; refuses an empty, reversed or too-wide window and a bad tz", () => {
    const w = windowFrom(undefined, "2026-10-30T00:00:00Z", "330");
    expect(w).toEqual({ since: "2026-10-16T00:00:00.000Z", until: "2026-10-30T00:00:00.000Z", tzMinutes: 330 });
    expect(() => windowFrom("2026-10-30T00:00:00Z", "2026-10-30T00:00:00Z", "0")).toThrow(HistoryError);
    expect(() => windowFrom("2026-01-01T00:00:00Z", "2026-10-30T00:00:00Z", "0")).toThrow(/at most 92 days/);
    expect(() => windowFrom("yesterday", undefined, "0")).toThrow(/not a time/);
    expect(() => windowFrom(undefined, undefined, "5.5")).toThrow(/tz/);
  });

  test("days are counted in the page's time zone: 16:16 UTC on 10-22 is 10-22 in UTC and 10-23 at +10:00", () => {
    expect(dayOf("2026-10-22T16:16:24Z", 0)).toBe("2026-10-22");
    expect(dayOf("2026-10-22T16:16:24Z", 600)).toBe("2026-10-23");
  });
});

// ── transcripts ────────────────────────────────────────────────────────────────────────────

const line = (o: object) => JSON.stringify(o);
function transcript(d: string, name: string, lines: string[]) {
  const p = join(d, name);
  writeFileSync(p, lines.join("\n") + "\n");
  return p;
}
const editTool = (id: string, file: string) => ({ type: "tool_use", id, name: "Edit", input: { file_path: file, old_string: "a", new_string: "b" } });

describe("turns and edits from transcripts", () => {
  test("a prompt is a turn; tool results, commands, sidechains and meta records are not; an edit whose type sits after its message is found; api-request copies are not edits", () => {
    const d = dir();
    const p = transcript(d, "s1.jsonl", [
      line({ parentUuid: null, isSidechain: false, type: "user", message: { role: "user", content: "fix the grid" }, uuid: "u1", timestamp: "2026-10-22T10:00:00Z", origin: { kind: "human" } }),
      line({ parentUuid: "u1", isSidechain: false, type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t0", content: "ok" }] }, uuid: "u2", timestamp: "2026-10-22T10:00:01Z" }),
      line({ isSidechain: false, type: "user", message: { role: "user", content: "<command-name>/clear</command-name>" }, uuid: "u3", timestamp: "2026-10-22T10:00:02Z" }),
      line({ isSidechain: true, type: "user", message: { role: "user", content: "subagent prompt" }, uuid: "u4", timestamp: "2026-10-22T10:00:03Z" }),
      line({ isSidechain: false, isMeta: true, type: "user", message: { role: "user", content: "caveat" }, uuid: "u5", timestamp: "2026-10-22T10:00:04Z" }),
      // The real shape: "type":"assistant" comes after the message, far past the first 600 characters.
      line({ parentUuid: "u2", isSidechain: false, message: { model: "m", id: "msg", type: "message", role: "assistant", content: [{ type: "text", text: "x".repeat(900) }, editTool("toolu_1", "/proj/src/a.ts")] }, type: "assistant", uuid: "a1", timestamp: "2026-10-22T10:00:05Z" }),
      line({ type: "api-request-shape", message: { role: "assistant", content: [editTool("toolu_copy", "/proj/src/b.ts")] }, timestamp: "2026-10-22T10:00:06Z" }),
      "{not json \"type\":\"user\"",
    ]);
    const f = scanTranscript(p);
    expect(f.turns.map((t) => t.prompt)).toEqual(["fix the grid"]);
    expect(f.turns[0]!.origin).toBe("human");
    expect(f.edits.map((e) => [e.id, e.tool, e.file])).toEqual([["toolu_1", "Edit", "/proj/src/a.ts"]]);
    expect(f.badLines).toBe(1);
  });

  const sessions = (d: string, paths: { id: string; path: string; first: string; last: string }[]): ReplaySessionsResponse => ({
    timezone: "UTC",
    project: "p",
    status: "ok",
    searched: [d],
    sessions: paths.map((s) => ({ sessionId: s.id, project: "p", cwd: "/proj", transcriptPath: s.path, sizeBytes: 100, modifiedAt: s.last, firstTs: s.first, lastTs: s.last })),
  });

  test("only events inside the window count; a file path inside the project is shown relative; a session outside the window is not read", async () => {
    const d = dir();
    const p = transcript(d, "s2.jsonl", [
      line({ isSidechain: false, type: "user", message: { role: "user", content: "before" }, uuid: "b", timestamp: "2026-10-21T23:59:59Z" }),
      line({ isSidechain: false, type: "user", message: { role: "user", content: "inside" }, uuid: "i", timestamp: "2026-10-22T08:00:00Z" }),
      line({ isSidechain: false, message: { role: "assistant", content: [editTool("toolu_9", "/proj/src/c.ts")] }, type: "assistant", uuid: "a", timestamp: "2026-10-23T23:59:59Z" }),
      line({ isSidechain: false, type: "user", message: { role: "user", content: "after" }, uuid: "z", timestamp: "2026-10-24T00:00:00Z" }),
    ]);
    const r = await readTranscriptLanes(sessions(d, [
      { id: "s2", path: p, first: "2026-10-21T23:59:59Z", last: "2026-10-24T00:00:00Z" },
      { id: "gone", path: join(d, "never-read.jsonl"), first: "2026-09-01T00:00:00Z", last: "2026-09-02T00:00:00Z" },
    ]), W, "/proj", EVENT_CAP);
    expect(r.turn.events.map((e) => (e as { prompt: string }).prompt)).toEqual(["inside"]);
    expect(r.edit.events.map((e) => (e as { file: string }).file)).toEqual(["src/c.ts"]);
    expect(r.turn.lane.status).toBe("ok");
    expect(r.sessions).toEqual([{ id: "s2", first: "2026-10-22T08:00:00Z", last: "2026-10-23T23:59:59Z", turns: 1, edits: 1, cwd: "/proj" }]);
  });

  test("a forked or resumed session's repeats of earlier records count once, kept by the session that started first; the lanes say how many were dropped, 0 included (#211)", async () => {
    const d = dir();
    const prompt = line({ isSidechain: false, type: "user", message: { role: "user", content: "fix the grid" }, uuid: "u-orig", timestamp: "2026-10-22T08:00:00Z" });
    const edit = line({ isSidechain: false, message: { role: "assistant", content: [editTool("toolu_shared", "/proj/src/a.ts")] }, type: "assistant", uuid: "a-orig", timestamp: "2026-10-22T08:01:00Z" });
    const orig = transcript(d, "orig.jsonl", [prompt, edit]);
    // The fork repeats both records under its own session, then adds one of each.
    const fork = transcript(d, "fork.jsonl", [prompt, edit,
      line({ isSidechain: false, type: "user", message: { role: "user", content: "and the rows" }, uuid: "u-new", timestamp: "2026-10-22T09:00:00Z" }),
      line({ isSidechain: false, message: { role: "assistant", content: [editTool("toolu_new", "/proj/src/b.ts")] }, type: "assistant", uuid: "a-new", timestamp: "2026-10-22T09:01:00Z" })]);
    const r = await readTranscriptLanes(sessions(d, [
      { id: "fork", path: fork, first: "2026-10-22T08:00:00Z", last: "2026-10-22T09:01:00Z" },
      { id: "orig", path: orig, first: "2026-10-22T07:59:00Z", last: "2026-10-22T08:01:00Z" },
    ]), W, "/proj", EVENT_CAP);
    expect(r.turn.lane.total).toBe(2);
    expect(r.edit.lane.total).toBe(2);
    expect(r.edit.events.map((e) => [e.id, (e as { session: string }).session])).toEqual([["toolu_shared", "orig"], ["toolu_new", "fork"]]);
    expect(r.turn.events.map((e) => (e as { session: string }).session)).toEqual(["orig", "fork"]);
    expect(r.turn.lane.source).toContain("1 turn repeated by a forked or resumed session dropped");
    expect(r.edit.lane.source).toContain("1 edit repeated by a forked or resumed session dropped");
    expect(r.sessions.map((s) => [s.id, s.turns, s.edits])).toEqual([["orig", 1, 1], ["fork", 1, 1]]);
    // No repeats: said, as 0.
    const one = await readTranscriptLanes(sessions(d, [{ id: "orig", path: orig, first: "2026-10-22T07:59:00Z", last: "2026-10-22T08:01:00Z" }]), W, "/proj", EVENT_CAP);
    expect(one.edit.lane.source).toContain("0 edits repeated");
    expect(one.turn.lane.source).toContain("0 turns repeated");
  });

  test("a transcript that cannot be read makes the lanes partial or unreadable, never none", async () => {
    const d = dir();
    const r = await readTranscriptLanes(sessions(d, [{ id: "x", path: join(d, "missing.jsonl"), first: W.since, last: W.until }]), W, "/proj", EVENT_CAP);
    expect(r.turn.lane.status).toBe("unreadable");
    expect(r.edit.lane.status).toBe("unreadable");
    expect(r.turn.lane.detail).toContain("could not be read");
    const listing = await readTranscriptLanes({ timezone: "UTC", project: "p", status: "unreadable", searched: [], sessions: [], detail: "EACCES" }, W, "/proj", EVENT_CAP);
    expect(listing.turn.lane.status).toBe("unreadable");
    expect(listing.turn.lane.detail).toBe("EACCES");
  });
});

// ── the cap ────────────────────────────────────────────────────────────────────────────────

describe("large windows", () => {
  test("past the scan budget the newest sessions are read and the rest are named as not scanned: the lanes are partial, never complete", async () => {
    const d = dir();
    const mk = (name: string, at: string) => transcript(d, name, [line({ isSidechain: false, type: "user", message: { role: "user", content: name }, uuid: name, timestamp: at })]);
    const older = mk("older", "2026-10-22T01:00:00Z");
    const newer = mk("newer", "2026-10-23T01:00:00Z");
    const s = (id: string, p: string, at: string) => ({ sessionId: id, project: "p", cwd: null, transcriptPath: p, sizeBytes: 100, modifiedAt: at, firstTs: at, lastTs: at });
    const listing: ReplaySessionsResponse = { timezone: "UTC", project: "p", status: "ok", searched: [d], sessions: [s("older", older, "2026-10-22T01:00:00Z"), s("newer", newer, "2026-10-23T01:00:00Z")] };
    const r = await readTranscriptLanes(listing, W, "/proj", EVENT_CAP, 150);
    expect(r.turn.events.map((e) => (e as { prompt: string }).prompt)).toEqual(["newer"]);
    expect(r.turn.lane.status).toBe("partial");
    expect(r.turn.lane.detail).toContain("1 older sessions were not scanned");
    const all = await readTranscriptLanes(listing, W, "/proj", EVENT_CAP, 1000);
    expect([all.turn.lane.status, all.turn.lane.total]).toEqual(["ok", 2]);
  });

  test("past the cap the newest events are sent, and the total and per-day counts still cover every event", async () => {
    const d = dir();
    const lines = Array.from({ length: 30 }, (_, i) =>
      line({ isSidechain: false, type: "user", message: { role: "user", content: `p${i}` }, uuid: `u${i}`, timestamp: new Date(Date.parse("2026-10-22T00:00:00Z") + i * 3_600_000 * 1.5).toISOString() }));
    const p = transcript(d, "big.jsonl", lines);
    const r = await readTranscriptLanes({ timezone: "UTC", project: "p", status: "ok", searched: [d], sessions: [{ sessionId: "b", project: "p", cwd: null, transcriptPath: p, sizeBytes: 1, modifiedAt: W.until, firstTs: W.since, lastTs: W.until }] }, W, "/proj", 10);
    expect(r.turn.lane.total).toBe(30);
    expect(r.turn.lane.shown).toBe(10);
    expect(r.turn.events.length).toBe(10);
    expect((r.turn.events[9] as { prompt: string }).prompt).toBe("p29");
    expect(Object.values(r.turn.lane.perDay).reduce((a, b) => a + b, 0)).toBe(30);
  });
});

// ── refusals, rulings, actions ─────────────────────────────────────────────────────────────

const refusal = (key: string, at: string, call: Refusal["call"] = { state: "none" }): Refusal => ({
  key, at, session: "s", tool: "Edit", file: "src/engine/StrudelEngine.ts", checkout: "registered", checkoutDir: "/p", version: null, transcript: "/t",
  refusedBy: "graph rule", checkToo: false, design: "cffdf7d", violations: [], pairs: [{ key: "k", pair: "engine -> monaco" }], reason: "BLOCKED", call,
});
const measured = (refusals: Refusal[], since = "2026-10-01T00:00:00.000Z"): RefusalsResponse => ({
  status: "measured", project: "p", package: "/p/pkg", window: { since, until: null, chosenBy: "x" },
  instrument: {} as never, transcripts: { read: 1, unreadable: 0, badLines: 0 }, totals: {} as never, notices: {}, refusals, timeouts: [], unrecognised: [],
  exposure: null, defaultBranch: null, byDesign: [], trialReading: null, report: "", cache: { at: "2026-11-05T10:00:00Z", ageMs: 0, refreshing: false, ttlMs: 1 }, calls: {} as never,
});

describe("refusals", () => {
  test("a run still going is measuring, a project without a design has no source, a failed run is unreadable: none of them reads as zero refusals", () => {
    expect(readRefusalLane({ status: "measuring", project: "p", package: "/p", window: { since: "", until: null, chosenBy: "" }, startedAt: "t" }, W, 10).lane.status).toBe("measuring");
    const nd = readRefusalLane({ status: "no-design", project: "p", reason: "no package registered" }, W, 10).lane;
    expect(nd.status).toBe("not-available");
    expect(nd.detail).toBe("no package registered");
    expect(readRefusalLane({ status: "unreadable", project: "p", reason: "node missing" }, W, 10).lane.status).toBe("unreadable");
  });

  test("measured: only refusals in the window, each with your call as the reader read it", () => {
    const r = readRefusalLane(measured([
      refusal("k1", "2026-10-22T16:16:24Z", { state: "called", latest: { at: "2026-10-27T09:00:00Z", key: "k1", project: "p", call: "right", note: "fine" }, earlier: [] }),
      refusal("k2", "2026-10-25T00:00:00Z"),
      refusal("k3", "2026-10-23T01:00:00Z", { state: "unknown", reason: "calls unreadable" }),
    ]), W, 10);
    expect(r.events.map((e) => e.id)).toEqual(["k1", "k3"]);
    expect((r.events[0] as { call: unknown }).call).toEqual({ state: "called", call: "right", at: "2026-10-27T09:00:00Z", note: "fine", earlier: 0 });
    expect((r.events[1] as { call: unknown }).call).toEqual({ state: "unknown", reason: "calls unreadable" });
    expect(r.lane.status).toBe("ok");
  });

  test("an instrument window that starts after this window's start makes the lane partial and says so", () => {
    const r = readRefusalLane(measured([], "2026-10-23T00:00:00.000Z"), W, 10);
    expect(r.lane.status).toBe("partial");
    expect(r.lane.detail).toContain("refusals before it are not counted");
  });
});

describe("rulings (your calls)", () => {
  test("every call in the window is on the timeline; one a later call replaced is marked so", () => {
    const d = dir();
    writeFileSync(join(d, "calls.jsonl"), [
      line({ at: "2026-10-22T10:00:00Z", key: "k1", project: "p", call: "wrong" }),
      line({ at: "2026-10-23T10:00:00Z", key: "k1", project: "p", call: "right", note: "on reflection" }),
      line({ at: "2026-10-23T11:00:00Z", key: "k2", project: "other", call: "right" }),
    ].join("\n") + "\n");
    const r = readRulingLane("p", W, 10, d);
    expect(r.events.map((e) => [(e as { call: string }).call, (e as { superseded: boolean }).superseded])).toEqual([["wrong", true], ["right", false]]);
    expect(r.lane.status).toBe("ok");
    // How many were recorded without a measured refusal to check against: said every time, 0 included (#178).
    expect(r.lane.detail).toContain("0 of 2 calls on this project were recorded without a measured refusal");
  });

  test("no file is none (and says nothing was recorded); a file that cannot be read is unreadable", () => {
    const d = dir();
    const none = readRulingLane("p", W, 10, d).lane;
    expect(none.status).toBe("none");
    expect(none.detail).toContain("no call has been recorded yet");
    mkdirSync(join(d, "calls.jsonl")); // a directory where the file should be: EISDIR
    expect(readRulingLane("p", W, 10, d).lane.status).toBe("unreadable");
  });
});

describe("AnviDeck's own actions", () => {
  test("only lines naming this project, by body.project or an agent's folder; the rest are counted, damaged lines make it partial", () => {
    const d = dir();
    writeFileSync(join(d, "actions.jsonl"), [
      line({ at: "2026-10-22T10:00:00Z", method: "POST", path: "/api/prs/1/merge", area: "prs", status: 200, result: "accepted", body: { project: "p" } }),
      line({ at: "2026-10-22T11:00:00Z", method: "POST", path: "/api/agents", area: "agents", status: 201, result: "accepted", body: { cwd: d } }),
      line({ at: "2026-10-22T12:00:00Z", method: "POST", path: "/api/agents", area: "agents", status: 403, result: "refused", body: {} }),
      line({ at: "2026-10-22T12:00:00Z", method: "POST", path: "/api/x", area: "x", status: 200, result: "accepted", body: { project: "q" } }),
      "torn",
    ].join("\n"));
    const r = readActionLane("p", d, W, 10, d);
    expect(r.events.map((e) => (e as { path: string }).path)).toEqual(["/api/prs/1/merge", "/api/agents"]);
    expect(r.lane.status).toBe("partial");
    expect(r.lane.detail).toContain("1 of 5 logged actions belong to another project; 1 name no project, folder or agent");
  });

  test("an action on an agent (stop, message, permission answer) is placed by the registry: started in the project's folder or one of its worktrees; a cut-short folder matches by prefix and length", async () => {
    const d = dir();
    const repo = repoWithMain();
    commitFile(repo, "a.txt", "a", "2026-10-01T00:00:00Z", "first");
    const wt = join(repo, ".claude", "worktrees", "issue-7-with-a-folder-name-long-enough-to-be-cut-short-by-the-log");
    git(repo, ["worktree", "add", "-q", "-b", "issue-7", wt]);
    const other = dir();
    writeFileSync(join(d, "agents.json"), JSON.stringify({ version: 1, agents: [
      { id: "a1", cwd: repo }, { id: "a2", cwd: wt }, { id: "a3", cwd: other },
    ] }));
    const cut = (s: string) => `${s.slice(0, 80)}… (${s.length} chars)`;
    writeFileSync(join(d, "actions.jsonl"), [
      line({ at: "2026-10-22T10:00:00Z", method: "POST", path: "/api/agents/a1/permissions/r1", area: "agents", target: "a1", status: 200, result: "accepted", body: { decision: "allow" } }),
      line({ at: "2026-10-22T10:01:00Z", method: "POST", path: "/api/agents/a2/stop", area: "agents", target: "a2", status: 200, result: "accepted" }),
      line({ at: "2026-10-22T10:02:00Z", method: "POST", path: "/api/agents/a3/stop", area: "agents", target: "a3", status: 200, result: "accepted" }),
      line({ at: "2026-10-22T10:03:00Z", method: "POST", path: "/api/agents", area: "agents", status: 400, result: "failed", body: { cwd: cut(wt) } }),
      line({ at: "2026-10-22T10:04:00Z", method: "POST", path: "/api/agents/gone/stop", area: "agents", target: "gone", status: 404, result: "failed" }),
    ].join("\n"));
    const h = await readHistory({ project: "p", path: repo, window: W, refusals: measured([]), sessions: { timezone: "UTC", project: "p", status: "none", searched: [], sessions: [] }, callsDir: d, anviDir: null });
    expect(h.lanes.action.total).toBe(3);
    expect(h.events.filter((e) => e.kind === "action").map((e) => (e as { path: string }).path)).toEqual(["/api/agents/a1/permissions/r1", "/api/agents/a2/stop", "/api/agents"]);
    // a3 is another project's; "gone" is an agent nobody can place: the lane says so and is partial.
    expect(h.lanes.action.status).toBe("partial");
    expect(h.lanes.action.detail).toContain("1 of 5 logged actions belong to another project");
    expect(h.lanes.action.detail).toContain("1 act on an agent the registry does not list");
  });
});

// ── git: commits, catalogue changes, compare ───────────────────────────────────────────────

describe("commits and catalogue changes from git", () => {
  test("commits on the default branch in the window, by committer time; a folder in no repository has no source", async () => {
    const r = repoWithMain();
    commitFile(r, "a.ts", "1", "2026-10-21T12:00:00Z", "before");
    const sha = commitFile(r, "a.ts", "2", "2026-10-22T12:00:00Z", "inside");
    commitFile(r, "a.ts", "3", "2026-10-24T12:00:00Z", "after");
    pointMain(r);
    commitFile(r, "a.ts", "4", "2026-10-22T13:00:00Z", "local only, not on origin/main");
    const c = await readCommitLane(r, W, 10);
    expect(c.events.map((e) => (e as { sha: string }).sha)).toEqual([sha]);
    expect(c.lane.source).toContain("origin/main");
    const none = await readCommitLane(dir(), W, 10);
    expect(none.lane.status).toBe("not-available");
  });

  test("past the cap, the newest commits are sent and every day's count still covers all of them", async () => {
    const r = repoWithMain();
    commitFile(r, "a.ts", "1", "2026-10-22T08:00:00Z", "day one a");
    commitFile(r, "a.ts", "2", "2026-10-22T09:00:00Z", "day one b");
    commitFile(r, "a.ts", "3", "2026-10-23T08:00:00Z", "day two");
    pointMain(r);
    const c = await readCommitLane(r, W, 1);
    expect(c.events.map((e) => (e as { subject: string }).subject)).toEqual(["day two"]);
    expect([c.lane.total, c.lane.shown]).toEqual([3, 1]);
    expect(c.lane.perDay).toEqual({ "2026-10-22": 2, "2026-10-23": 1 });
  });

  test("catalogue changes are the commits that touched the catalogue folder, with the files; a folder no repository holds says it has no history source", async () => {
    const r = repoWithMain();
    commitFile(r, "src/x.ts", "x", "2026-10-22T09:00:00Z", "code only");
    commitFile(r, ".anvi/hetvabhasa.md", "## H1: one\nbody\n", "2026-10-22T10:00:00Z", "add H1");
    const lane = await readCatalogueLane(r, W, 10, join(r, ".anvi"));
    expect(lane.events.map((e) => (e as { subject: string }).subject)).toEqual(["add H1"]);
    expect((lane.events[0] as { files: unknown }).files).toEqual([{ status: "A", file: "hetvabhasa.md" }]);
    const loose = dir();
    mkdirSync(join(loose, ".anvi"));
    const nl = await readCatalogueLane(loose, W, 10, join(loose, ".anvi"));
    expect(nl.lane.status).toBe("not-available");
    expect(nl.lane.detail).toContain("no history source");
  });

  test("compare: code is the default branch at each time; knowledge is entries added, removed and changed", async () => {
    const r = repoWithMain();
    const a = commitFile(r, ".anvi/hetvabhasa.md", "## H1: one\nbody\n\n## H2: two\nbody\n", "2026-10-20T10:00:00Z", "start");
    commitFile(r, "src/x.ts", "x\n", "2026-10-21T10:00:00Z", "code");
    const b = commitFile(r, ".anvi/hetvabhasa.md", "## H1: one\nbody changed\n\n## H3: three\nbody\n", "2026-10-22T10:00:00Z", "catalogue");
    pointMain(r);
    const code = await compareCode(r, "2026-10-20T23:00:00Z", "2026-10-23T00:00:00Z");
    expect(code.ok && code.value.a?.sha).toBe(a);
    expect(code.ok && code.value.b?.sha).toBe(b);
    expect(code.ok && code.value.commits).toBe(2);
    expect(code.ok && code.value.files.map((f) => f.file).sort()).toEqual([".anvi/hetvabhasa.md", "src/x.ts"]);
    const k = await compareKnowledge(r, "2026-10-20T23:00:00Z", "2026-10-23T00:00:00Z", join(r, ".anvi"));
    expect(k.ok).toBe(true);
    if (!k.ok) return;
    expect(k.value.commits).toBe(1);
    expect(k.value.files).toEqual([{ file: "hetvabhasa.md", before: 2, after: 2, added: ["H3"], removed: ["H2"], changed: ["H1"] }]);
    // Before the first commit there is nothing to compare from: said, not invented.
    const early = await compareCode(r, "2026-01-01T00:00:00Z", "2026-10-23T00:00:00Z");
    expect(early.ok && early.value.a).toBeNull();
  });

  test("an entry whose only change is a field counts as changed; a file that did not exist then is null, not 0", () => {
    const d = diffEntries("vyapti.md", null, "## V1: x\n**WHY:** a\n");
    expect(d).toEqual({ file: "vyapti.md", before: null, after: 1, added: ["V1"], removed: [], changed: [] });
    expect(diffEntries("vyapti.md", "## V1: x\nWHY: a\n", "## V1: x\nWHY: b\n").changed).toEqual(["V1"]);
  });
});

// ── the whole response and the route ───────────────────────────────────────────────────────

describe("the route", () => {
  const emptySessions = (): ReplaySessionsResponse => ({ timezone: "UTC", project: "p", status: "none", searched: ["/x"], sessions: [] });

  test("400 for a bad window, 404 for an unknown project; every lane is in the answer", async () => {
    const d = dir();
    const asked: (string | null | undefined)[] = [];
    const app = historyRoutes({
      projects: () => [{ name: "p", path: d }],
      refusals: async (_p, o) => (asked.push(o.since), { response: { status: "no-design", project: "p", reason: "none registered" } }),
      sessions: emptySessions,
      callsDir: d,
      anviDir: () => null,
    });
    expect((await app.request("/?project=p&since=2026-10-30T00:00:00Z&until=2026-10-01T00:00:00Z")).status).toBe(400);
    expect((await app.request("/?project=nope")).status).toBe(404);
    expect((await app.request("/")).status).toBe(400);
    const res = await app.request("/?project=p&tz=60");
    expect(res.status).toBe(200);
    const j = (await res.json()) as HistoryResponse;
    expect(Object.keys(j.lanes).sort()).toEqual([...HISTORY_KINDS].sort());
    expect(j.lanes.refusal.status).toBe("not-available");
    expect(j.lanes.catalogue.status).toBe("not-available");
    expect(j.lanes.commit.status).toBe("not-available");
    // Within the refusals reader's default window: its own default (shared cache), not a run of our own.
    expect(asked[0]).toBeNull();
    await app.request(`/?project=p&since=2026-01-01T05:00:00Z&until=2026-02-01T00:00:00Z`);
    expect(asked[1]).toBe(defaultSince() > "2026-01-01" ? "2026-01-01T00:00:00.000Z" : null);
  });

  test("windows older than the reader's default share one wide run per project, and only one wide run goes at a time", async () => {
    const now = () => new Date("2026-11-05T12:00:00Z");
    const asked: { project: string; since: string | null | undefined; wait: boolean }[] = [];
    let finish = () => {};
    const refusals = async (project: string, o: { since?: string | null; wait?: boolean }) => {
      asked.push({ project, since: o.since, wait: !!o.wait });
      if (o.wait) await new Promise<void>((res) => (finish = res));
      return { response: { status: "no-design", project, reason: "x" } as RefusalsResponse };
    };
    const forWindow = wideRefusals(refusals, now);
    // The review's case: windows from 08-10, 08-11, 08-12 and one from 10-05T18:30Z (just before the default 10-06).
    for (const s of ["2026-08-10T00:00:00.000Z", "2026-08-11T00:00:00.000Z", "2026-08-12T00:00:00.000Z", "2026-10-05T18:30:00.000Z"]) expect((await forWindow("stave", s)).waiting).toBeUndefined();
    const runs = asked.filter((a) => a.wait);
    expect(runs).toEqual([{ project: "stave", since: "2026-08-01T00:00:00.000Z", wait: true }]);
    expect(new Set(asked.map((a) => a.since))).toEqual(new Set(["2026-08-01T00:00:00.000Z"]));
    // Another project, or an older month, while that run goes: told it waits, and no second run starts.
    const other = await forWindow("p", "2026-09-01T00:00:00.000Z");
    expect(other.waiting).toContain("starts when that one ends");
    expect((await forWindow("stave", "2026-07-15T00:00:00.000Z")).waiting).toContain("from 2026-07-01");
    expect(asked.filter((a) => a.wait)).toHaveLength(1);
    // Inside the default window: the shared default run, never a wide one.
    await forWindow("stave", "2026-10-20T00:00:00.000Z");
    expect(asked.at(-1)).toEqual({ project: "stave", since: null, wait: false });
    // When the run ends, the older month gets its run, which then serves every later window.
    finish();
    await new Promise((r) => setTimeout(r, 0));
    expect((await forWindow("stave", "2026-07-15T00:00:00.000Z")).waiting).toBeUndefined();
    expect(asked.filter((a) => a.wait).map((a) => a.since)).toEqual(["2026-08-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z"]);
    expect((await forWindow("stave", "2026-08-20T00:00:00.000Z")).waiting).toBeUndefined();
    expect(asked.at(-1)!.since).toBe("2026-07-01T00:00:00.000Z");
  });

  test("the refusals lane says it is waiting when another run holds the slot, so the page keeps asking", () => {
    const r = readRefusalLane(measured([]), W, 10, "waiting: another run");
    expect(r.lane.status).toBe("measuring");
    expect(r.lane.detail).toBe("waiting: another run");
  });

  test("compare needs two times", async () => {
    const app = historyRoutes({ projects: () => [{ name: "p", path: "/nowhere" }] });
    expect((await app.request("/compare?project=p&a=2026-10-01T00:00:00Z")).status).toBe(400);
    const r = await app.request("/compare?project=p&a=2026-10-02T00:00:00Z&b=2026-10-01T00:00:00Z");
    const j = (await r.json()) as { a: string; b: string; code: { ok: boolean } };
    expect([j.a, j.b]).toEqual(["2026-10-01T00:00:00.000Z", "2026-10-02T00:00:00.000Z"]);
    expect(j.code.ok).toBe(false);
  });

  test("readHistory puts every lane's events on one time-sorted list", async () => {
    const d = dir();
    writeFileSync(join(d, "calls.jsonl"), line({ at: "2026-10-23T10:00:00Z", key: "k1", project: "p", call: "right" }) + "\n");
    const h = await readHistory({ project: "p", path: d, window: W, refusals: measured([refusal("k1", "2026-10-22T16:16:24Z")]), sessions: emptySessions(), callsDir: d, anviDir: null });
    expect(h.events.map((e) => e.kind)).toEqual(["refusal", "ruling"]);
    expect(h.lanes.turn.status).toBe("none");
  });
});

// ── the screen's rules ─────────────────────────────────────────────────────────────────────

function lanes(over: Partial<Record<string, Partial<LaneRead>>> = {}): HistoryResponse["lanes"] {
  return Object.fromEntries(HISTORY_KINDS.map((k) => [k, { kind: k, status: "none", source: `src ${k}`, total: 0, shown: 0, perDay: {}, ...(over[k] ?? {}) }])) as HistoryResponse["lanes"];
}
const resp = (l: HistoryResponse["lanes"], events: HistoryEvent[] = []): HistoryResponse => ({ project: "p", path: "/p", window: { since: "", until: "", tzMinutes: 0 }, readAt: "", ms: 1, cap: 400, lanes: l, events, sessions: [] });
const row = (k: string) => ROWS.find((r) => r.key === k)!;

describe("the timeline's cells", () => {
  test("a cell's number is the lane's own per-day count, so a capped day still shows how many happened, and the list says showing N of M", () => {
    const ev: HistoryEvent = { kind: "edit", at: "2026-10-22T10:00:00Z", id: "e", session: "s", tool: "Edit", file: "a" };
    const r = resp(lanes({ edit: { status: "ok", total: 900, shown: 400, perDay: { "2026-10-22": 900 } } }), [ev]);
    expect(cellCount(r, row("edits"), "2026-10-22")).toBe(900);
    const c = cellEvents(r, row("edits"), "2026-10-22");
    expect([c.events.length, c.total]).toEqual([1, 900]);
    expect(showingLine(c.events.length, c.total)).toBe("showing 1 of 900 — the newest are kept; open this day alone to see more");
    expect(showingLine(3, 3)).toBe("3 events");
  });

  test("the refusals row sums refusals and rulings, and is as bad as its worst lane", () => {
    const r = resp(lanes({ refusal: { status: "measuring", perDay: { d: 1 } }, ruling: { status: "ok", perDay: { d: 2 } } }));
    expect(cellCount(r, row("refusals"), "d")).toBe(3);
    expect(rowState(r, row("refusals"))).toBe("measuring");
    expect(rowNote(r, row("refusals"))).toBe("refusals: still being measured");
    const u = resp(lanes({ commit: { status: "unreadable", detail: "git failed" } }));
    expect(rowState(u, row("commits"))).toBe("unreadable");
    expect(rowNote(u, row("commits"))).toBe("commits: could not be read");
    expect(rowNote(resp(lanes()), row("commits"))).toBeNull();
  });

  test("the sources footer names each lane's source and never prints a count for a lane that could not be read", () => {
    const lines = sourceLines(resp(lanes({ commit: { status: "unreadable", detail: "git failed" }, edit: { status: "ok", total: 900, shown: 400 } })));
    expect(lines.find((l) => l.startsWith("commits"))).toBe("commits — could not be read · src commit · git failed");
    expect(lines.find((l) => l.startsWith("edits"))).toBe("edits — 900 in this window · showing 400 of 900 · src edit");
    expect(lines.length).toBe(HISTORY_KINDS.length);
    expect(lines.find((l) => l.startsWith("your calls"))).toBe("your calls — none in this window · src ruling");
  });

  test("the total is 'at least' and names the lanes that are not whole; a whole read is a plain count", () => {
    expect(totalLine(resp(lanes({ edit: { status: "ok", total: 1200 }, refusal: { status: "not-available" } })))).toBe("1,200 events");
    expect(totalLine(resp(lanes({ edit: { status: "ok", total: 1200 }, refusal: { status: "measuring" }, commit: { status: "unreadable" } })))).toBe(
      "at least 1,200 events (refusals still being measured, commits could not be read)",
    );
  });

  test("poll while the refusals instrument runs, and only then", () => {
    expect(shouldPoll(resp(lanes({ refusal: { status: "measuring" } })))).toBe(true);
    expect(shouldPoll(resp(lanes({ refusal: { status: "ok" } })))).toBe(false);
    expect(shouldPoll(null)).toBe(false);
  });
});

describe("days and links", () => {
  test("the window is the URL's days, else the last 14; days are listed both ends included", () => {
    expect(windowDays(new URLSearchParams("from=2026-10-19&to=2026-10-30"))).toEqual({ from: "2026-10-19", to: "2026-10-30" });
    expect(windowDays(new URLSearchParams("from=2026-10-31&to=2026-10-30"), new Date(2026, 10, 5))).toEqual({ from: "2026-10-17", to: "2026-10-30" });
    expect(windowDays(new URLSearchParams(), new Date(2026, 10, 5))).toEqual({ from: "2026-10-23", to: "2026-11-05" });
    expect(daysBetween("2026-10-30", "2026-11-02")).toEqual(["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
  });

  test("Replay opens the Agents screen's replay view for that session; the Map link names it too", () => {
    const h = replayHash("stave", "4a681850", "2026-10-22T16:06:24Z", "2026-10-22T16:26:24Z");
    const params = new URLSearchParams(h.slice(h.indexOf("?") + 1));
    expect(h.startsWith("#agents?")).toBe(true);
    expect(parseAgentsScreenParams(params).replay).toBe(true);
    expect(params.get("sid")).toBe("4a681850");
    expect(mapReplayHash("stave", "4a681850")).toBe("#map?project=stave&session=4a681850");
  });
});

describe("compare lines", () => {
  const measuredAt = (designId: string, nw: number, modules: number) =>
    ({ status: "measured", designId, counts: { modules, divergence: { new: nw }, cycle: { new: 0 } } }) as unknown as StructureProjectResponse;

  test("code: commits between and the shortstat; the same commit at both is said, not counted as zero work", () => {
    const v = { repo: "/r", ref: "origin/main", refWhy: "", commits: 14, shortstat: "3 files changed", files: [], filesTotal: 3 };
    expect(codeLine({ ok: true, value: { ...v, a: { at: "", sha: "aaaaaaaa1", date: "", subject: "" }, b: { at: "", sha: "bbbbbbbb1", date: "", subject: "" } } })).toBe("code: 14 commits on origin/main (aaaaaaa → bbbbbbb) · 3 files changed");
    expect(codeLine({ ok: true, value: { ...v, commits: 0, a: { at: "", sha: "aaaaaaaa1", date: "", subject: "" }, b: { at: "", sha: "aaaaaaaa1", date: "", subject: "" } } })).toBe("code: no commit between (aaaaaaa at both)");
    expect(codeLine({ ok: false, reason: "not a git repository" })).toBe("code: not compared — not a git repository");
  });

  test("design: the guard's verdict at both commits; loading, no design and a failed run each say which", () => {
    expect(designLine({ state: "loading" }, { state: "loading" })).toContain("measuring");
    expect(designLine({ state: "done", value: measuredAt("cffdf7d", 0, 359) }, { state: "done", value: measuredAt("cffdf7d", 1, 367) })).toBe(
      "design: 1 version (cffdf7d) · imports breaking it (new, not grandfathered) 0 → 1 · modules 359 → 367",
    );
    expect(designLine({ state: "done", value: measuredAt("a1", 0, 1) }, { state: "done", value: measuredAt("b2", 0, 1) })).toContain("a1 → b2");
    expect(designLine({ state: "done", value: { status: "no-design" } as StructureProjectResponse }, { state: "done", value: measuredAt("x", 0, 1) })).toContain("no design registered");
    expect(designLine({ state: "error", reason: "500" }, { state: "done", value: measuredAt("x", 0, 1) })).toBe("design: not compared — the earlier commit could not be measured (500)");
  });

  test("knowledge: entries per catalogue, by name", () => {
    expect(knowledgeLine({ ok: true, value: { repo: "/s", dir: "/s/.anvi", a: null, b: { at: "", sha: "b", date: "" }, commits: 8, files: [
      { file: "hetvabhasa.md", before: 917, after: 929, added: ["P1", "P2"], removed: [], changed: ["P3"] },
      { file: "krama.md", before: 141, after: 141, added: [], removed: [], changed: [] },
    ] } })).toBe("knowledge: 8 catalogue commits · error patterns +2 1 changed");
    expect(knowledgeLine({ ok: false, reason: "no history source" })).toBe("knowledge: not compared — no history source");
  });
});
