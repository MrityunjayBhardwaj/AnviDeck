// The Map's open gaps (#49): reaching sessions past the newest 40, and agents on a project
// with no design. Pure functions on small fixtures shaped like the real API answers.
import { describe, expect, test } from "bun:test";
import { agentAt, blockFlow, folderOf, folderTouches, layoutFolders, pathInProject, pickSessions, SESSION_LIST_MAX } from "../ui/components/map-model";
import type { StructureNoDesign } from "../shared/structure-types";
import type { ReplayResponse, ReplayStep } from "../shared/replay-types";

describe("session picker: every session can be reached", () => {
  // 189 sessions, as stave had when #49 was filed; session i last active on day i.
  const all = Array.from({ length: 189 }, (_, i) => {
    const d = new Date(Date.UTC(2026, 4, 1) + i * 86400_000).toISOString();
    return { sessionId: `s${String(i).padStart(3, "0")}-x`, firstTs: d, lastTs: d, worktree: i % 50 === 0 ? {} : undefined };
  });

  test("with no query: the newest 40, newest first, and the total", () => {
    const p = pickSessions(all, "", null);
    expect(p.shown.length).toBe(SESSION_LIST_MAX);
    expect(p.shown[0].sessionId).toBe("s188-x");
    expect(p.matched).toBe(189);
    expect(p.total).toBe(189);
  });

  test("an old session past the newest 40 is found by its id or its date", () => {
    expect(pickSessions(all, "s003", null).shown.map((x) => x.sessionId)).toEqual(["s003-x"]);
    const day = all[3].firstTs.slice(0, 10);
    expect(pickSessions(all, day, null).shown.map((x) => x.sessionId)).toEqual(["s003-x"]);
    expect(pickSessions(all, "S003", null).matched).toBe(1);
  });

  test("a query matching more than 40 lists the newest 40 and counts them all", () => {
    const p = pickSessions(all, "-x", null);
    expect(p.matched).toBe(189);
    expect(p.shown.length).toBe(40);
  });

  test("must not match: a query nothing holds lists none", () => {
    const p = pickSessions(all, "zzz", null);
    expect(p.matched).toBe(0);
    expect(p.shown).toEqual([]);
  });

  test("the selected session stays listed whatever the query", () => {
    const p = pickSessions(all, "s150", "s002-x");
    expect(p.shown.map((x) => x.sessionId)).toEqual(["s002-x", "s150-x"]);
    expect(p.matched).toBe(1);
  });

  test("'worktree' lists the sessions started in a worktree", () => {
    expect(pickSessions(all, "worktree", null).shown.map((x) => x.sessionId)).toEqual(["s150-x", "s100-x", "s050-x", "s000-x"]);
  });
});

describe("agents on a project with no design", () => {
  const ROOT = "/Users/x/projects/anvideck";
  const nd: StructureNoDesign = {
    status: "no-design",
    project: "anvideck",
    path: ROOT,
    label: "nothing blocked",
    refAsked: null,
    refChosenBy: "test",
    measuredAt: null,
    treeFrom: "git",
    files: 9,
    folders: [
      { path: ".", files: 2, total: 9 },
      { path: "server", files: 1, total: 3 },
      { path: "server/readers", files: 2, total: 2 },
      { path: "ui", files: 4, total: 4 },
    ],
    timing: { cache: "miss", ms: 1 },
  };
  const L = layoutFolders(nd);
  const ids = new Set(L.byId.keys());

  test("paths in the project, its .claude worktrees and its -wt- siblings are cut to the project", () => {
    expect(pathInProject(`${ROOT}/server/readers/replay.ts`, ROOT)).toBe("server/readers/replay.ts");
    expect(pathInProject(`${ROOT}/.claude/worktrees/wf_1/ui/app.ts`, ROOT)).toBe("ui/app.ts");
    expect(pathInProject(`/Users/x/projects/anvideck-wt-12/ui/app.ts`, ROOT)).toBe("ui/app.ts");
    expect(pathInProject("server/index.ts", ROOT)).toBe("server/index.ts");
  });

  test("must not match: a sibling project whose name starts the same, or a path outside", () => {
    expect(pathInProject(`/Users/x/projects/anvideck-ai/ui/app.ts`, ROOT)).toBeNull();
    expect(pathInProject(`/private/tmp/scratch/ui/app.ts`, ROOT)).toBeNull();
  });

  test("a file sits in its top-level folder; a file at the top in '(top level)'; others in none", () => {
    expect(folderOf("server/readers/replay.ts", ids)).toBe("server");
    expect(folderOf("README.md", ids)).toBe("(top level)");
    expect(folderOf("docs/x.md", ids)).toBeNull();
  });

  function replay(steps: Partial<ReplayStep>[]): ReplayResponse {
    return {
      timezone: "UTC",
      sessionId: "s",
      window: { from: null, to: null },
      transcript: { status: "ok" },
      sources: { hookMeter: { status: "none" }, hookLog: { status: "none" }, git: { status: "ok" }, github: { status: "ok" } },
      steps: steps.map((s, i) => ({ seq: i, ts: null, placement: "timestamp", placedAt: `2026-11-05T09:0${i}:00.000Z`, kind: "tool", source: "transcript", ...s }) as ReplayStep),
      notes: { status: "none", items: [] },
      changes: { status: "ok", files: [{ path: `${ROOT}/ui/app.ts`, how: ["commit"], viaShell: true, notesGap: "no notes given for these files" }] },
      commits: [{ sha: "abc123", committedAt: "2026-11-05T09:09:00Z", subject: "x", repoDir: ROOT, files: [{ status: "M", path: "server/index.ts" }, { status: "M", path: "docs/x.md" }] }],
      unattributedCommits: [],
      prs: [],
      timingsMs: {},
    };
  }

  test("tool edits, commits and shell writes land on folders; the agent and its flow follow them", () => {
    const r = replay([
      { tool: "Edit", filePath: `${ROOT}/.claude/worktrees/wf_1/server/readers/replay.ts` },
      { tool: "Read", filePath: "/private/tmp/scratch/notes.md" },
      { tool: "Bash", command: "sed -i s/a/b/ ui/app.ts", mayEditFiles: { source: "guessed", reason: "sed -i", scope: "project" } },
      { kind: "commit", source: "commit", sha: "abc123" },
      { tool: "Bash", command: "python3 - <<'EOF'\np='server/readers/replay.ts'\nopen(p,'w')\nEOF", mayEditFiles: { source: "guessed", reason: "a script opens a file for writing", scope: "project" } },
    ]);
    const t = folderTouches(r, nd, ids);
    expect(t[0]).toMatchObject({ how: "tool", modules: ["server/readers/replay.ts"] });
    expect(t[1]).toMatchObject({ how: null, modules: [], offMap: ["/private/tmp/scratch/notes.md"] });
    expect(t[2]).toMatchObject({ how: "shell-guess", shellWrite: true, modules: ["ui/app.ts"], designRules: "none: this project has no design", notesGap: "no notes given for these files" });
    // the commit's file outside every folder block is left out, not forced onto one
    expect(t[3]).toMatchObject({ how: "commit", modules: ["server/index.ts"] });
    expect(agentAt(t, 3).last).toBe("server/index.ts");
    expect(blockFlow(t, 3, (m) => folderOf(m, ids))).toEqual(["server", "ui", "server"]);
    // a shell write names a file a tool edited earlier: it is on the map too, with no notes gap claimed
    expect(t[4]).toMatchObject({ how: "shell-guess", modules: ["server/readers/replay.ts"], notesGap: null });
  });
});
