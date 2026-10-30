import { describe, test, expect, beforeAll } from "bun:test";
import { findTranscript, readReplay, shellWriteReason, listReplaySessions } from "../server/readers/replay";
import replayRoutes from "../server/routes/replay";
import type { ReplayResponse } from "../shared/replay-types";

/**
 * Controls for issue #15. They read real transcripts on this machine; when a
 * transcript is missing (another machine, or past retention) the block is
 * skipped with a message saying which file was missing.
 */

const CONTROL_SID = "811b15d0-2d6e-4ef9-8a42-cb524fe22131"; // stave
const WINDOW = { from: "2026-10-30T00:00:00Z", to: "2026-10-30T12:00:00Z" };
// A real session (11 tool calls) in which anvi injected nothing.
const NO_NOTES_SID = "2113ccbd-f123-4d6f-8dbe-f318bf254881";

const hms = (ts: string | null) => (ts ? ts.slice(11, 19) : null);

const controlPath = findTranscript(CONTROL_SID);
if (!controlPath) console.warn(`SKIP control: transcript ${CONTROL_SID}.jsonl not found under ~/.claude/projects`);

describe.skipIf(!controlPath)("stave control session 811b15d0, 2026-10-30 00:00–12:00 UTC", () => {
  let r: ReplayResponse;
  beforeAll(() => {
    r = readReplay(CONTROL_SID, WINDOW);
  }, 60000);

  test("says its timezone, and the transcript was read", () => {
    expect(r.timezone).toBe("UTC");
    expect(r.transcript.status).toBe("ok");
  });

  test("exactly 6 injections, at the issue's times; the 17:20:29 SessionStart is outside", () => {
    expect(r.notes.status).toBe("ok");
    expect(r.notes.items.map((n) => `${hms(n.ts)} ${n.hookName}`)).toEqual([
      "09:14:50 UserPromptSubmit",
      "09:15:14 PreToolUse:Bash",
      "11:24:38 UserPromptSubmit",
      "11:39:21 PreToolUse:Bash",
      "11:42:37 PreToolUse:Bash",
      "11:43:23 PostToolUse:Edit",
    ]);
    expect(r.notes.items.some((n) => n.hookName === "SessionStart")).toBe(false);
    expect(r.steps.filter((s) => s.kind === "injection")).toHaveLength(6);
  });

  test("the 09:14:50 note is loaded in full from its persisted file (~30.7 KB)", () => {
    const n = r.notes.items[0];
    expect(n.persisted?.status).toBe("ok");
    expect(n.persisted?.path).toMatch(/tool-results\/hook-.*-additionalContext\.txt$/);
    expect(n.size).toBeGreaterThan(30000);
    expect(n.text?.length).toBeGreaterThan(30000);
    expect(n.text).not.toContain("<persisted-output>");
    expect(n.meter?.[0]?.hook).toBe("debug-grounding-gate.js");
  });

  test("0 Edit/Write calls on stave source: 3 scratchpad Writes + 1 MEMORY.md Edit", () => {
    const edits = r.steps.filter((s) => s.kind === "tool" && ["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(s.tool!));
    expect(edits).toHaveLength(4);
    expect(edits.filter((s) => /\/Documents\/projects\/stave/.test(s.filePath!))).toHaveLength(0);
    expect(edits.filter((s) => s.tool === "Write" && s.filePath!.includes("/scratchpad/"))).toHaveLength(3);
    expect(edits.filter((s) => s.tool === "Edit" && s.filePath!.endsWith("/memory/MEMORY.md"))).toHaveLength(1);
  });

  test("the shell commands that changed code are flagged, labelled as a guess", () => {
    for (const t of ["09:26:22", "09:27:07", "09:27:21", "11:25:06"]) {
      const s = r.steps.find((x) => x.kind === "tool" && x.tool === "Bash" && hms(x.ts) === t);
      expect(s, `Bash step at ${t}`).toBeDefined();
      expect(s!.mayEditFiles?.source).toBe("guessed");
    }
  });

  test("untimed records are counted and placed, not dropped", () => {
    expect(r.transcript.untimedRecords!).toBeGreaterThan(2000);
    expect(r.transcript.untimedInWindow!).toBeGreaterThan(0);
    const sum = Object.values(r.transcript.untimedByType!).reduce((a, b) => a + b, 0);
    expect(sum).toBe(r.transcript.untimedInWindow!);
  });

  test("the session's commit 2b25412e is attributed from git, labelled 'commit'", () => {
    const c = r.commits.find((x) => x.sha.startsWith("2b25412e"));
    expect(c).toBeDefined();
    expect(c!.repoDir).toMatch(/stave-wt-2264$/);
    expect(r.steps.find((s) => s.kind === "commit" && s.sha === c!.sha)?.source).toBe("commit");
  });

  test("PR #2271: 24 files, 10 under packages/editor/src, 14 under dist/ (measured with gh 2026-10-30)", () => {
    const pr = r.prs.find((p) => p.number === 2271);
    expect(pr).toBeDefined();
    if (pr!.read.status !== "ok") {
      console.warn(`SKIP PR counts: gh could not read PR #2271 (${pr!.read.detail})`);
      return;
    }
    expect(pr!.headRefOid!.startsWith("2b25412e")).toBe(true);
    expect(pr!.changedFiles).toBe(24);
    const files = r.changes.files.filter((f) => f.pr === 2271);
    expect(files).toHaveLength(24);
    expect(files.filter((f) => f.path.includes("/packages/editor/src/"))).toHaveLength(10);
    expect(files.filter((f) => f.path.includes("/dist/"))).toHaveLength(14);
  });

  test("shell-only files carry the two gaps as separate labels", () => {
    const f = r.changes.files.find((x) => x.path.endsWith("packages/editor/src/engine/HapStream.ts"));
    expect(f).toBeDefined();
    expect(f!.viaShell).toBe(true);
    expect(f!.notesGap).toBe("no notes given for these files");
    expect(f!.designRules).toContain("checked at merge, not at edit");
  });
});

const noNotesPath = findTranscript(NO_NOTES_SID);
if (!noNotesPath) console.warn(`SKIP must-not-match: transcript ${NO_NOTES_SID}.jsonl not found`);

describe.skipIf(!noNotesPath)("must-not-match: a session with no anvi injections", () => {
  test("returns 'no notes' (status none, empty list), not an error", () => {
    const r = readReplay(NO_NOTES_SID, { github: false });
    expect(r.transcript.status).toBe("ok");
    expect(r.steps.filter((s) => s.kind === "tool").length).toBeGreaterThan(0);
    expect(r.notes.status).toBe("none");
    expect(r.notes.items).toEqual([]);
  });
});

describe("could not read vs nothing found", () => {
  test("a nonexistent session says 'not-found', which differs from 'none'", () => {
    const r = readReplay("00000000-0000-0000-0000-000000000000", WINDOW);
    expect(r.transcript.status).toBe("not-found");
    expect(r.transcript.detail).toContain("transcript not found");
    expect(r.notes.status).toBe("not-found");
    expect(r.notes.status).not.toBe("none");
    expect(r.changes.status).toBe("not-found");
    expect(r.timezone).toBe("UTC");
  });

  test.skipIf(!controlPath)("a window with nothing in it says 'none', not 'not-found'", () => {
    const r = readReplay(CONTROL_SID, { from: "2020-01-01T00:00:00Z", to: "2020-01-02T00:00:00Z", github: false });
    expect(r.transcript.status).toBe("none");
    expect(r.notes.status).toBe("none");
    expect(r.steps).toEqual([]);
  });

  // A real session whose working directory (a scratch git repo) has been deleted.
  const GONE_REPO_SID = "244a9823-fde6-44a2-b007-c681215100dc";
  test.skipIf(!findTranscript(GONE_REPO_SID))("a session whose repo is gone says git 'not-found', not 'none' (#25)", () => {
    const r = readReplay(GONE_REPO_SID, { github: false, fullText: false });
    expect(r.transcript.status).toBe("ok");
    expect(r.sources.git.status).toBe("not-found");
    expect(r.sources.git.dirs?.some((d) => d.status === "not-found")).toBe(true);
  });

  test.skipIf(!noNotesPath)("a session in a live repo with no commits says git 'none'", () => {
    const r = readReplay(NO_NOTES_SID, { github: false, fullText: false });
    expect(r.sources.git.status).toBe("none");
  });

  test("an unknown project lists no sessions and says why", () => {
    const r = listReplaySessions("no-such-project-zz9");
    expect(r.status).toBe("not-found");
    expect(r.sessions).toEqual([]);
  });
});

describe("shell write guess", () => {
  test("fires on commands that write files", () => {
    expect(shellWriteReason("cd x && git mv a b")).toBe("git mv");
    expect(shellWriteReason("sed -i '' 's/a/b/' f")).toBe("sed -i");
    expect(shellWriteReason("python3 - <<'EOF'\nopen(p,'w').write(s)\nEOF")).toBe("a script opens a file for writing");
    expect(shellWriteReason("git show HEAD:f > f")).toBe("redirects output to f");
    expect(shellWriteReason("ls && cp a b")).toBe("cp");
  });
  test("stays quiet on read-only commands", () => {
    expect(shellWriteReason("git status --short 2>&1")).toBeNull();
    expect(shellWriteReason("grep -rn foo . > /dev/null")).toBeNull();
    expect(shellWriteReason("cat a | head -5")).toBeNull();
  });
});

describe("routes", () => {
  test("rejects a bad session id and a bad time", async () => {
    expect((await replayRoutes.request("/session/..%2F..%2Fetc")).status).toBe(400);
    expect((await replayRoutes.request(`/session/${CONTROL_SID}?from=yesterday`)).status).toBe(400);
    expect((await replayRoutes.request("/sessions")).status).toBe(400);
  });
});
