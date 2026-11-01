import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { getTimeline, showAtCommit, diffCommits } from "../server/readers/git-history";
import api from "../server/routes/api";

// #35: a failed git read must never answer as "nothing there".
let repo = "";
let notRepo = "";
let first = "";
let second = "";

const git = (...args: string[]) =>
  execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).trim();

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "anvideck-gh-"));
  notRepo = mkdtempSync(join(tmpdir(), "anvideck-nogit-"));
  git("init", "-q");
  writeFileSync(join(repo, "a.md"), "one\n");
  writeFileSync(join(repo, "empty.md"), "");
  git("add", ".");
  git("commit", "-q", "-m", "first");
  first = git("rev-parse", "HEAD");
  writeFileSync(join(repo, "a.md"), "two\n");
  git("commit", "-q", "-am", "second");
  second = git("rev-parse", "HEAD");
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(notRepo, { recursive: true, force: true });
});

describe("history reads tell 'git failed' from 'nothing there' (#35)", () => {
  test("timeline: a real repo gives its commits; a folder that is not a repo is a failure, not []", async () => {
    const ok = await getTimeline(10, 0, repo);
    expect(ok.ok && ok.value.map((p) => p.message)).toEqual(["second", "first"]);

    const bad = await getTimeline(10, 0, notRepo);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.err).toContain("not a git repository");
  });

  test("state-at: content, an empty file, a file the commit lacks, and a bad hash are four different answers", async () => {
    expect(await showAtCommit(first, "a.md", repo)).toEqual({ ok: true, value: "one" });
    expect(await showAtCommit(first, "empty.md", repo)).toEqual({ ok: true, value: "" });
    expect(await showAtCommit(first, "missing.md", repo)).toEqual({ ok: true, value: null });

    const bad = await showAtCommit("deadbeef", "a.md", repo);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.err).toContain("deadbeef");

    expect((await showAtCommit(first, "a.md", notRepo)).ok).toBe(false);
  });

  test("diff: no changes is an empty diff; a bad hash is a failure", async () => {
    expect(await diffCommits(second, second, repo)).toEqual({ ok: true, value: "" });
    const d = await diffCommits(first, second, repo);
    expect(d.ok && d.value).toContain("+two");

    const bad = await diffCommits("deadbeef", second, repo);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.err).toContain("deadbeef");
  });

  test("routes answer 503 with git's words for a hash git cannot resolve", async () => {
    const s = await api.request("/state-at/deadbeef?file=CLAUDE.md");
    expect(s.status).toBe(503);
    const sb = (await s.json()) as { status: string; errors: string[] };
    expect(sb.status).toBe("unreadable");
    expect(sb.errors[0]).toBeTruthy();

    const d = await api.request("/diff/deadbeef/HEAD");
    expect(d.status).toBe(503);
  });
});
