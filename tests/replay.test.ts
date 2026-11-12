import { describe, test, expect, beforeAll } from "bun:test";
import { findTranscript, readReplay, shellWriteReason, shellWriteScope, listReplaySessions, mergeEvidence, repoFileKey, joinMeter, judgementRowFor, removedWorktree, GIT_COMMIT_RUN_RE, attributeCommits, githubRepoOf } from "../server/readers/replay";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

/**
 * GitHub's GraphQL quota is shared with every tool and agent on this account. When gh answered
 * that it is used up, a test that needs GitHub's answer says so and stops, rather than fail for
 * a reason no code caused (#235). Only a rate limit: any other failure to read still fails.
 */
function githubRateLimited(r: ReplayResponse, pr: number): boolean {
  const read = r.prs.find((p) => p.number === pr)?.read;
  if (!read || read.status === "ok" || !/rate limit/i.test(read.detail ?? "")) return false;
  console.warn(`  SKIPPED — GitHub rate limit: gh could not read PR #${pr} (${read.detail})`);
  return true;
}

const controlPath = findTranscript(CONTROL_SID);
if (!controlPath) console.warn(`SKIP control: transcript ${CONTROL_SID}.jsonl not found under ~/.claude/projects`);

describe.skipIf(!controlPath)("stave control session 811b15d0, 2026-10-30 00:00–12:00 UTC", () => {
  let r: ReplayResponse;
  beforeAll(async () => {
    r = await readReplay(CONTROL_SID, WINDOW);
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

  test("a second replay reuses the merged PRs' GitHub answers (#28)", async () => {
    const again = await readReplay(CONTROL_SID, WINDOW);
    if (githubRateLimited(again, 2271)) return;
    expect(again.sources.github.detail).toMatch(/^2 of 2 PR answer\(s\) from cache/);
    expect(again.prs.find((p) => p.number === 2271)?.changedFiles).toBe(24);
  }, 60000);

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
    // The session committed in the worktree stave-wt-2264. While it exists, the commit is read
    // there. Once it is removed, the reader does not guess where a sibling folder came from (only
    // Claude Code's .claude/worktrees layout is trusted, #65): it says the folder is gone and the
    // commit is attributed from the stave checkout that still holds it (#264).
    const WT = `${process.env.HOME}/Documents/projects/stave-wt-2264`;
    if (existsSync(WT)) expect(c!.repoDir).toBe(WT);
    else {
      console.log(`  ${WT} is gone: expecting the commit from the stave checkout`);
      expect(c!.repoDir).toBe(`${process.env.HOME}/Documents/projects/stave`);
      expect(r.sources.git.dirs?.find((d) => d.dir === WT)?.status).toBe("not-found");
    }
    expect(r.steps.find((s) => s.kind === "commit" && s.sha === c!.sha)?.source).toBe("commit");
  });

  test("PR #2271: 24 files, 10 under packages/editor/src, 14 under dist/ (measured with gh 2026-10-30)", () => {
    const pr = r.prs.find((p) => p.number === 2271);
    expect(pr).toBeDefined();
    if (githubRateLimited(r, 2271)) return;
    expect(pr!.read.status).toBe("ok");
    expect(pr!.headRefOid!.startsWith("2b25412e")).toBe(true);
    expect(pr!.changedFiles).toBe(24);
    const files = r.changes.files.filter((f) => f.pr === 2271);
    expect(files).toHaveLength(24);
    expect(files.filter((f) => f.path.includes("/packages/editor/src/"))).toHaveLength(10);
    expect(files.filter((f) => f.path.includes("/dist/"))).toHaveLength(14);
  });

  test("shell-only files carry the two gaps as separate labels", async () => {
    // The file is known from PR #2271's file list, which only GitHub has.
    if (githubRateLimited(r, 2271)) return;
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
  test("returns 'no notes' (status none, empty list), not an error", async () => {
    const r = await readReplay(NO_NOTES_SID, { github: false });
    expect(r.transcript.status).toBe("ok");
    expect(r.steps.filter((s) => s.kind === "tool").length).toBeGreaterThan(0);
    expect(r.notes.status).toBe("none");
    expect(r.notes.items).toEqual([]);
  });
});

describe("could not read vs nothing found", () => {
  test("a nonexistent session says 'not-found', which differs from 'none'", async () => {
    const r = await readReplay("00000000-0000-0000-0000-000000000000", WINDOW);
    expect(r.transcript.status).toBe("not-found");
    expect(r.transcript.detail).toContain("transcript not found");
    expect(r.notes.status).toBe("not-found");
    expect(r.notes.status).not.toBe("none");
    expect(r.changes.status).toBe("not-found");
    expect(r.timezone).toBe("UTC");
  });

  test.skipIf(!controlPath)("a window with nothing in it says 'none', not 'not-found'", async () => {
    const r = await readReplay(CONTROL_SID, { from: "2020-01-01T00:00:00Z", to: "2020-01-02T00:00:00Z", github: false });
    expect(r.transcript.status).toBe("none");
    expect(r.notes.status).toBe("none");
    expect(r.steps).toEqual([]);
  });

  // A real session whose working directory (a scratch git repo) has been deleted.
  const GONE_REPO_SID = "244a9823-fde6-44a2-b007-c681215100dc";
  test.skipIf(!findTranscript(GONE_REPO_SID))("a session whose repo is gone says git 'not-found', not 'none' (#25)", async () => {
    const r = await readReplay(GONE_REPO_SID, { github: false, fullText: false });
    expect(r.transcript.status).toBe("ok");
    expect(r.sources.git.status).toBe("not-found");
    expect(r.sources.git.dirs?.some((d) => d.status === "not-found")).toBe(true);
  });

  test.skipIf(!noNotesPath)("a session in a live repo with no commits says git 'none'", async () => {
    const r = await readReplay(NO_NOTES_SID, { github: false, fullText: false });
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
  test("a judgement row written later by a probe is not the merge's own row", () => {
    // merges.jsonl holds a row for #2271 from session "probe-702-control"
    // (18:40Z), not from the merging session: the merge check is not confirmed.
    const m = mergeEvidence(2271, "MrityunjayBhardwaj/Stave", "2026-10-30T17:44:30Z");
    expect(m.judgementRow).toBe("none");
  });
});

describe("judgement row matching", () => {
  const log = [
    JSON.stringify({ session: "probe-702-control", pr: 2271, outcome: "clean" }),
    JSON.stringify({ session: "abfc9da5", pr: 2083, outcome: "clean" }),
    "not json",
  ].join("\n");
  test("must match: the merging session's own row for the PR", () => {
    expect(judgementRowFor(2083, "abfc9da5", log)).toBe("found");
  });
  test("must not match: a row for the same PR from another session", () => {
    expect(judgementRowFor(2271, "a65698cb", log)).toBe("none");
  });
  test("must not match: the same session's row for another PR", () => {
    expect(judgementRowFor(2271, "abfc9da5", log)).toBe("none");
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
// The session worked in a worktree since removed; its commit 441b653 can be read only
// while some branch still reaches it (squash-merged branches get deleted) (#65).
const onBranch = (sha: string) => {
  try { return execFileSync("git", ["-C", join(import.meta.dir, ".."), "branch", "-a", "--contains", sha], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() !== ""; } catch { return false; }
};
const fixCommitOnBranch = onBranch("441b653");
// Off-branch, the commit is read from GitHub through PR #24 (#67), when gh can reach it.
const ghHasFixPr = (() => {
  try { return execFileSync("gh", ["pr", "view", "24", "--repo", "MrityunjayBhardwaj/AnviDeck", "--json", "number"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 20000 }).includes("24"); } catch { return false; }
})();
const fixReadable = fixCommitOnBranch || ghHasFixPr;
const fixGithub = !fixCommitOnBranch; // ask GitHub only when no local branch has it
if (findTranscript(FIX_SID) && !fixReadable) console.warn("SKIP #29/#67 controls: commit 441b653 is on no branch and GitHub (gh) cannot read PR #24");
describe.skipIf(!findTranscript(FIX_SID) || fixCommitOnBranch)("a session's commit that is on no branch any more (#65, #67)", () => {
  test("with GitHub off: says the commit is missing, not that the window has none", async () => {
    const r = await readReplay(FIX_SID, { from: "2026-10-30T18:41:40Z", to: "2026-10-30T18:43:30Z", github: false, fullText: false });
    expect(r.sources.git.status).toBe("not-found");
    expect(r.sources.git.missingCommits).toBe(1);
    expect(r.sources.git.detail).toContain("no matching commit on any branch");
    expect(r.sources.git.detail).toContain("GitHub was not asked");
    expect(r.commits).toHaveLength(0);
    // the removed worktree is resolved to the repository it was made from
    expect(r.sources.git.dirs?.some((d) => d.dir.endsWith("/.claude/worktrees/agent-ad7f9578ad471a66f") && /read from the repository it was made from/.test(d.detail ?? ""))).toBe(true);
  }, 60000);
  test.skipIf(!ghHasFixPr)("with GitHub on: reads the commit through the PR the session linked (#67)", async () => {
    const r = await readReplay(FIX_SID, { from: "2026-10-30T18:41:40Z", to: "2026-10-30T18:43:30Z", fullText: false });
    expect(r.sources.git.status).toBe("ok");
    expect(r.sources.git.missingCommits).toBeUndefined();
    expect(r.sources.git.fromGitHub).toBe(1);
    expect(r.commits.map((c) => c.sha.slice(0, 7))).toEqual(["441b653"]);
    const c = r.commits[0];
    expect(c.from).toEqual({ source: "github", pr: 24, repo: "MrityunjayBhardwaj/AnviDeck" });
    expect(c.subject.startsWith("🧹 fix: say where a guessed shell write lands")).toBe(true);
    expect(c.files.map((f) => f.status + " " + f.path).sort()).toEqual(["M server/readers/replay.ts", "M shared/replay-types.ts", "M tests/replay.test.ts"]);
    const step = r.steps.find((s) => s.kind === "commit");
    expect(String(step?.detail?.from)).toContain("PR #24");
    const f = r.changes.files.find((x) => x.path.endsWith("shared/replay-types.ts") && x.sha?.startsWith("441b653"));
    expect(f?.pr).toBe(24);
    expect(f?.commitFrom?.pr).toBe(24);
    expect(f?.designRules).toContain("PR #24");
    // must-not-claim: PR #24's other commits fall outside this window and are not listed
    expect(r.unattributedCommits).toHaveLength(0);
  }, 60000);
});
describe.skipIf(!findTranscript(FIX_SID) || !fixReadable)("tool edits before the window or by another path (#29)", () => {
  test("a file edited with Edit just before the window is not called shell-only", async () => {
    const r = await readReplay(FIX_SID, { from: "2026-10-30T18:41:40Z", to: "2026-10-30T18:42:40Z", github: fixGithub, fullText: false });
    const f = (end: string) => r.changes.files.find((x) => x.path.endsWith(end) && x.sha?.startsWith("441b653"));
    expect(f("server/readers/replay.ts")?.viaShell).toBe(false);
    expect(f("server/readers/replay.ts")?.toolEdit?.ts).toBe("2026-10-30T18:41:33.982Z");
    // must-not-match: files that really changed only through the shell keep the label
    expect(f("shared/replay-types.ts")?.viaShell).toBe(true);
    expect(f("tests/replay.test.ts")?.viaShell).toBe(true);
  }, 60000);
  test("an Edit made after the commit does not explain the commit", async () => {
    const r = await readReplay(FIX_SID, { from: "2026-10-30T18:41:40Z", to: "2026-10-30T18:43:30Z", github: fixGithub, fullText: false });
    const f = r.changes.files.find((x) => x.path.endsWith("shared/replay-types.ts") && x.sha?.startsWith("441b653"));
    expect(f?.viaShell).toBe(true);
  }, 60000);
});

describe("attributeCommits: one rule for local and GitHub commits (#67)", () => {
  const repoOf = new Map<string, { top: string; store: string } | null>([
    ["/w/a", { top: "/w/a", store: "/s/A" }],
    ["/w/b", { top: "/w/b", store: "/s/B" }],
  ]);
  const at = (iso: string) => Date.parse(iso);
  test("a commit just after a git commit step is that step's", () => {
    const steps = [{ sortMs: at("2026-01-01T00:00:00Z"), command: "cd /w/a && git commit -m x" }];
    const [h] = attributeCommits([{ committedAt: "2026-01-01T00:00:03Z", stores: ["/s/A", "/s/B"] }], steps, new Set(), repoOf);
    expect(h.step).toBe(steps[0]);
    expect(h.top).toBe("/w/a");
    expect(h.store).toBe("/s/A");
  });
  test("must-not-match: another repository, too late, or before the step", () => {
    const step = { sortMs: at("2026-01-01T00:00:00Z"), command: "cd /w/a && git commit -m x" };
    expect(attributeCommits([{ committedAt: "2026-01-01T00:00:03Z", stores: ["/s/B"] }], [step], new Set(), repoOf)[0].step).toBeNull();
    expect(attributeCommits([{ committedAt: "2026-01-01T00:05:01Z", stores: ["/s/A"] }], [step], new Set(), repoOf)[0].step).toBeNull();
    expect(attributeCommits([{ committedAt: "2025-12-31T23:59:57Z", stores: ["/s/A"] }], [step], new Set(), repoOf)[0].step).toBeNull();
  });
  test("a step explains one commit only; the nearest wins", () => {
    const step = { sortMs: at("2026-01-01T00:00:00Z"), command: "git commit -m x" };
    const hs = attributeCommits(
      [{ committedAt: "2026-01-01T00:01:00Z", stores: ["/s/A"] }, { committedAt: "2026-01-01T00:00:02Z", stores: ["/s/A"] }],
      [step], new Set(), repoOf);
    expect(hs.map((h) => [h.commit.committedAt, !!h.step])).toEqual([["2026-01-01T00:00:02Z", true], ["2026-01-01T00:01:00Z", false]]);
  });
});

describe("githubRepoOf", () => {
  test("ssh, https and ssh:// remotes", () => {
    expect(githubRepoOf("git@github.com:MrityunjayBhardwaj/AnviDeck.git")).toBe("MrityunjayBhardwaj/AnviDeck");
    expect(githubRepoOf("https://github.com/o/r")).toBe("o/r");
    expect(githubRepoOf("https://token@github.com/o/r.git")).toBe("o/r");
    expect(githubRepoOf("ssh://git@github.com/o/r.git")).toBe("o/r");
  });
  test("must-not-match: other hosts and lookalikes", () => {
    for (const u of ["git@gitlab.com:o/r.git", "https://github.com.evil.com/o/r", "https://evilgithub.com/o/r", "https://mirror.example.com/https://github.com/o/r", "/local/path/r.git", "https://github.com/o"])
      expect(githubRepoOf(u)).toBeNull();
  });
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

describe("hook-meter rows go to the nearest injection (#30)", () => {
  const T = (sec: number) => new Date(Date.UTC(2026, 9, 30, 12, 0, 0) + sec * 1000).toISOString();
  const row = (sec: number, hook: string) => ({ ts: T(sec), ms: Date.parse(T(sec)), hook, event: "PreToolUse", bytes: 300, dur: 50 });
  test("two same-event injections 0.5 s apart each get their own row", () => {
    const notes: any[] = [{ ts: T(10), hookName: "PreToolUse:Bash" }, { ts: T(10.5), hookName: "PreToolUse:Bash" }];
    const claimed = joinMeter(notes, [row(9.9, "a.js"), row(10.4, "b.js")]);
    expect(notes.map((n) => (n.meter ?? []).map((m: any) => m.hook))).toEqual([["a.js"], ["b.js"]]);
    expect(claimed.size).toBe(2);
  });
  test("a row of another event, or one too early, is not joined", () => {
    const notes: any[] = [{ ts: T(10), hookName: "PreToolUse:Bash" }];
    joinMeter(notes, [{ ...row(9.9, "x.js"), event: "PostToolUse" }, row(2, "early.js")]);
    expect(notes[0].meter).toBeUndefined();
  });
});

// Worktree sessions (#30). On this machine anvi had 6 worktree transcripts and
// MoGraph-DSL 3, none listed before. The sibling project basher/ai shares the
// basher repository but is its own project, so it must NOT be listed as basher's.
describe("session list includes sessions started in a worktree (#30)", () => {
  test("anvi lists its -wt- sessions, each saying how it was tied to the project", () => {
    const r = listReplaySessions("anvi");
    const wt = r.sessions.filter((s) => s.worktree);
    if (!r.searched.some((d) => d.includes("-anvi-wt-"))) return console.warn("SKIP: no anvi worktree transcripts on this machine");
    expect(wt.length).toBeGreaterThan(0);
    for (const s of wt) expect(["cwd-is-project", "same-repository", "unverified-gone"]).toContain(s.worktree!.check);
  });
  test("must-not-match: a sibling project or a scratchpad dir is not a worktree", () => {
    const r = listReplaySessions("basher");
    expect(r.searched.some((d) => d.endsWith("-basher-ai"))).toBe(false);
    const a = listReplaySessions("anvi");
    expect(a.searched.some((d) => d.includes("scratchpad"))).toBe(false);
  });
});

// must-not-match on a real session: 08:23–08:24 UTC on 2026-11-03 ran only
// `git diff-tree --no-commit-id`, which names "commit" but commits nothing.
const WORD_ONLY_SID = "19516d75-b2f2-4d30-b6dc-42783378d6bc";
test.skipIf(!findTranscript(WORD_ONLY_SID))("a window whose commands only mention 'commit' claims no missing commit (#65)", async () => {
  const r = await readReplay(WORD_ONLY_SID, { from: "2026-11-03T08:23:00Z", to: "2026-11-03T08:24:00Z", github: false, fullText: false });
  expect(r.steps.some((s) => s.command?.includes("--no-commit-id"))).toBe(true);
  expect(r.sources.git.missingCommits).toBeUndefined();
  expect(r.sources.git.status).toBe("none");
}, 60000);

describe("git commit as the command run, not the word (#65)", () => {
  const must = ["git commit -m x", "cd /a && git commit -q -F - <<'EOF'", "git -C /tmp/r commit -m x", "git -c user.name=a commit --amend", "(git commit -m x)", "x; git commit", "if true; then git commit -m x; fi", "git add a\ngit commit -m x"];
  const mustNot = ["git diff-tree --cc --no-commit-id HEAD", "git log --format=%H commit", "echo '(fail) … an Edit made after the commit does not explain the commit'", "gh pr merge 66 --squash", "git show HEAD # commit", "mygit commit", "git commit-tree abc"];
  for (const c of must) test(`matches: ${c}`, () => expect(GIT_COMMIT_RUN_RE.test(c)).toBe(true));
  for (const c of mustNot) test(`does not match: ${c}`, () => expect(GIT_COMMIT_RUN_RE.test(c)).toBe(false));
});

describe("a removed Claude Code worktree resolves to its repository (#65)", () => {
  const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "anvideck-wt-")));
  const repo = join(root, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "a.ts"), "a\n");
  git(root, "init", "-q", repo);
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "add", ".");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "a");
  const wt = join(repo, ".claude", "worktrees", "gone");
  git(repo, "worktree", "add", "-q", "-b", "gone-branch", wt);
  const liveWt = join(repo, ".claude", "worktrees", "live");
  git(repo, "worktree", "add", "-q", "-b", "live-branch", liveWt);
  git(repo, "worktree", "remove", "--force", wt);

  test("a path in the removed worktree maps to the repository and keeps its repo-relative name", () => {
    const r = removedWorktree(join(wt, "src", "a.ts"));
    expect(r?.worktree).toBe(wt);
    expect(r?.top).toBe(repo);
    expect(r?.rel).toBe("src/a.ts");
    expect(repoFileKey(join(wt, "src", "a.ts"))).toBe(repoFileKey(join(repo, "src", "a.ts")));
    expect(repoFileKey(join(wt, "src", "a.ts"))).not.toBeNull();
  });
  test("must-not-match: a live worktree, another gone folder, a gone repository", () => {
    expect(removedWorktree(join(liveWt, "src", "a.ts"))).toBeNull(); // still there: read it directly
    expect(removedWorktree(join(repo, "scratch", "gone", "a.ts"))).toBeNull(); // not the worktree layout
    expect(removedWorktree(join(root, "nope", ".claude", "worktrees", "x", "a.ts"))).toBeNull(); // repository gone too
    // the folder holding .claude/worktrees must be the repository's top, not a folder inside it
    expect(removedWorktree(join(repo, "src", ".claude", "worktrees", "x", "a.ts"))).toBeNull();
  });
  test("cleanup", () => { rmSync(root, { recursive: true, force: true }); });
});
