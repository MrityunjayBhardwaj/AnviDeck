import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { getTimeline, showAtCommit, diffCommits, isRevision } from "../server/readers/git-history";
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

describe("URL values never reach git as options (#56)", () => {
  test("revision shapes: hashes, HEAD~n and branch names pass; option-shaped and odd values do not", () => {
    for (const ok of ["deadbeef", "HEAD", "HEAD~3", "HEAD^", "main", "fix/35-x", "v1.2"]) expect(isRevision(ok)).toBe(true);
    for (const bad of ["--output=x", "-p", "", "a b", "a:b", "x".repeat(201)]) expect(isRevision(bad)).toBe(false);
  });

  test("an option-shaped value gets 400 from the routes and git writes nothing", async () => {
    const out = join(notRepo, "written.txt");
    const opt = encodeURIComponent(`--output=${out}`);
    expect((await api.request(`/diff/${opt}/HEAD`)).status).toBe(400);
    expect((await api.request(`/diff/HEAD/${opt}`)).status).toBe(400);
    expect((await api.request(`/state-at/${opt}?file=a.md`)).status).toBe(400);
    expect(existsSync(out)).toBe(false);
  });

  test("the reader alone also keeps git from reading an option-shaped value as an option", async () => {
    const out = join(notRepo, "written2.txt");
    expect((await diffCommits(`--output=${out}`, second, repo)).ok).toBe(false);
    expect((await showAtCommit(`--output=${out}`, "a.md", repo)).ok).toBe(false);
    expect(existsSync(out)).toBe(false);
  });
});
