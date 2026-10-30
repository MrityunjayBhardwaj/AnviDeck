import { describe, test, expect, beforeAll } from "bun:test";
import { findTranscript, readReplay, shellWriteReason, shellWriteScope, listReplaySessions, mergeEvidence, repoFileKey } from "../server/readers/replay";
import { join } from "node:path";
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

  test("only the 5 real code changes are scope 'project'; scratch writes and links are not (#27)", () => {
    const flagged = r.steps.filter((x) => x.mayEditFiles);
    const project = flagged.filter((x) => x.mayEditFiles!.scope === "project").map((x) => hms(x.ts));
    expect(project).toEqual(["09:26:22", "09:27:07", "09:27:21", "11:25:06", "11:25:14"]);
    const scope = (t: string) => flagged.find((x) => hms(x.ts) === t)?.mayEditFiles?.scope;
    expect(scope("09:14:59")).toBe("link");
    for (const t of ["09:15:10", "09:26:25", "11:25:24", "11:26:26"]) expect(scope(t), t).toBe("scratch");
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

// The session that ran `gh pr merge 2271` (17:44:27Z, 2026-10-30).
const MERGER_SID = "a65698cb-7b6e-4c11-81f0-4d5b228e5476";
describe.skipIf(!findTranscript(MERGER_SID))("merge evidence is confirmed by a transcript, not a meter row (#26)", () => {
  test("the real merge of #2271 is confirmed in the merging session", () => {
    const m = mergeEvidence(2271, "MrityunjayBhardwaj/Stave", "2026-10-30T17:44:30Z");
    expect(m.how).toBe("claude-session");
    expect(m.sessionId).toBe(MERGER_SID);
    expect(m.commandAt?.slice(11, 19)).toBe("17:44:27");
  });
  test("a time with only an unrelated merge-hook run (17:26:14) is not called a Claude merge", () => {
    const m = mergeEvidence(2271, "MrityunjayBhardwaj/Stave", "2026-10-30T17:26:20Z");
    expect(m.how).not.toBe("claude-session");
  });
  test("another repo's PR with the same number is not confirmed", () => {
    const m = mergeEvidence(2271, "someone/other-repo", "2026-10-30T17:44:30Z");
    expect(m.how).not.toBe("claude-session");
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
  test("says where a write lands: scratch, link or project (#27)", () => {
    // must-not-fire as a code change: a scratchpad redirect through a variable
    expect(shellWriteScope("cd /repo && S=/private/tmp/x/scratchpad; npx vitest run > $S/out.txt 2>&1")).toBe("scratch");
    expect(shellWriteScope("cd /tmp/scratch && python3 - <<'EOF'\nopen('a.md','w').write(s)\nEOF")).toBe("scratch");
    expect(shellWriteScope("cd /repo && ln -s ../x node_modules")).toBe("link");
    // must fire: any target inside the project wins over scratch targets
    expect(shellWriteScope("cd /repo && S=/tmp/s; F=src/a.ts; cp $F $S/b.ts && git show HEAD:$F > $F")).toBe("project");
    expect(shellWriteScope("cd /repo/src && git mv a.ts b.ts")).toBe("project");
    expect(shellWriteScope("cd /repo/src && python3 - <<'EOF'\nopen(p,'w').write(s)\nEOF")).toBe("project");
  });
});

describe("routes", () => {
  test("rejects a bad session id and a bad time", async () => {
    expect((await replayRoutes.request("/session/..%2F..%2Fetc")).status).toBe(400);
    expect((await replayRoutes.request(`/session/${CONTROL_SID}?from=yesterday`)).status).toBe(400);
    expect((await replayRoutes.request("/sessions")).status).toBe(400);
  });
});

// #29: a tool edit must count for a committed file even when it named the file by
// another path or fell before the window. Control: the session that fixed this
// edited replay.ts with Edit at 18:41:33Z, committed 441b653 at 18:42:26Z, and
// changed replay-types.ts and replay.test.ts only through python (shell).
const FIX_SID = "dba8cb1e-5edb-4121-9d58-bd839b9c077c";
describe.skipIf(!findTranscript(FIX_SID))("tool edits before the window or by another path (#29)", () => {
  test("a file edited with Edit just before the window is not called shell-only", () => {
    const r = readReplay(FIX_SID, { from: "2026-10-30T18:41:40Z", to: "2026-10-30T18:42:40Z", github: false, fullText: false });
    const f = (end: string) => r.changes.files.find((x) => x.path.endsWith(end) && x.sha?.startsWith("441b653"));
    expect(f("server/readers/replay.ts")?.viaShell).toBe(false);
    expect(f("server/readers/replay.ts")?.toolEdit?.ts).toBe("2026-10-30T18:41:33.982Z");
    // must-not-match: files that really changed only through the shell keep the label
    expect(f("shared/replay-types.ts")?.viaShell).toBe(true);
    expect(f("tests/replay.test.ts")?.viaShell).toBe(true);
  }, 60000);
  test("an Edit made after the commit does not explain the commit", () => {
    const r = readReplay(FIX_SID, { from: "2026-10-30T18:41:40Z", to: "2026-10-30T18:43:30Z", github: false, fullText: false });
    const f = r.changes.files.find((x) => x.path.endsWith("shared/replay-types.ts") && x.sha?.startsWith("441b653"));
    expect(f?.viaShell).toBe(true);
  }, 60000);
});

describe("repoFileKey: one file, one key, whatever path names it (#29)", () => {
  const worktree = join(import.meta.dir, "..");
  const main = "/Users/mrityunjaybhardwaj/Documents/projects/AnviDeck";
  test.skipIf(worktree === main)("main checkout and worktree paths of the same file match", () => {
    expect(repoFileKey(join(main, "server/index.ts"))).not.toBeNull();
    expect(repoFileKey(join(worktree, "server/index.ts"))).toBe(repoFileKey(join(main, "server/index.ts")));
  });
  test("different files differ, and a path outside any repository has no key", () => {
    expect(repoFileKey(join(worktree, "server/index.ts"))).not.toBe(repoFileKey(join(worktree, "server/routes/replay.ts")));
    expect(repoFileKey("/private/tmp/not-a-repo-xyz/a.ts")).toBeNull();
  });
});
