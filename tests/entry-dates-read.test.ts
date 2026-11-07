import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  readEntryDatesForFile,
  peekEntryDatesForFile,
  readEntryDatesForStore,
  datesJobsStarted,
  setDatesGitTimeoutMs,
  EntryDatesGitError,
} from "../server/readers/git-history";

// #34: the first dates request answers quickly, and a read git cannot finish
// is reported as a failure, never as an empty set of dates.

const made: string[] = [];
function repoWith(files: Record<string, string[]>): string {
  const repo = mkdtempSync(join(tmpdir(), "anvideck-dates-"));
  made.push(repo);
  const git = (date: string, ...args: string[]) =>
    execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    }).trim();
  git("2026-01-01T00:00:00Z", "init", "-q");
  const versions = Math.max(...Object.values(files).map((v) => v.length));
  for (let i = 0; i < versions; i++) {
    for (const [name, v] of Object.entries(files)) if (v[i] !== undefined) writeFileSync(join(repo, name), v[i]!);
    git(`2026-0${i + 1}-01T00:00:00Z`, "add", ".");
    git(`2026-0${i + 1}-01T00:00:00Z`, "commit", "-q", "-m", `v${i}`);
  }
  return repo;
}
const gitOut = (repo: string, ...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();

const V1 = "# H\n\n### X1: first\n\nx\n";
const V2 = "# H\n\n### X1: first\n\nx\n\n### X2: second\n\ny\n";

afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

describe("the first dates request does not wait for git (#34)", () => {
  test("a cold read answers 'pending' at once, carries on, and the next ask finds it done", async () => {
    const repo = repoWith({ "hetvabhasa.md": [V1, V2] });
    const file = join(repo, "hetvabhasa.md");
    const t0 = performance.now();
    const first = await peekEntryDatesForFile(file, 0);
    expect(first.state).toBe("pending");
    expect(performance.now() - t0).toBeLessThan(500);

    const full = await readEntryDatesForFile(file); // joins the running read
    expect(full["X2"]!.created).toStartWith("2026-02-01");
    expect(full["X2"]!.dateSource).toBe("entry");

    const again = await peekEntryDatesForFile(file, 0);
    expect(again).toEqual({ state: "ready", value: full });
  });

  test("requests that arrive while a read runs join it instead of starting their own", async () => {
    const repo = repoWith({ "vyapti.md": [V1, V2] });
    const file = join(repo, "vyapti.md");
    const before = datesJobsStarted();
    const answers = await Promise.all([
      peekEntryDatesForFile(file, 0),
      peekEntryDatesForFile(file, 0),
      readEntryDatesForFile(file),
      readEntryDatesForFile(file),
    ]);
    expect(datesJobsStarted() - before).toBe(1);
    expect(answers[2]).toBe(answers[3]);
  });

  test("a store answers 202 with the finished catalogues, then 200 with all of them", async () => {
    const repo = repoWith({ "hetvabhasa.md": [V1, V2], "krama.md": [V1] });
    const cold = await readEntryDatesForStore(repo, 0);
    expect(cold.code).toBe(202);
    if (cold.code === 202) expect(cold.body.pending.sort()).toEqual(["hetvabhasa", "krama"]);

    await readEntryDatesForFile(join(repo, "hetvabhasa.md"));
    await readEntryDatesForFile(join(repo, "krama.md"));
    const warm = await readEntryDatesForStore(repo, 0);
    expect(warm.code).toBe(200);
    // Absent catalogues (vyapti, dharana) are simply not there.
    expect(Object.keys(warm.body).sort()).toEqual(["hetvabhasa", "krama"]);
    if (warm.code === 200) expect(warm.body["hetvabhasa"]!["X2"]!.created).toStartWith("2026-02-01");
  });
});

describe("a read git cannot finish is a failure, never 'no dates' (#34)", () => {
  test("a git log/blame that fails (a missing object) fails the read and the store answers 503", async () => {
    const repo = repoWith({ "hetvabhasa.md": [V1, V2] });
    // Remove the first version's blob: rev-parse and ls-files still work, but
    // the history cannot be read.
    const blob = gitOut(repo, "rev-parse", "HEAD~1:hetvabhasa.md");
    const obj = join(repo, ".git", "objects", blob.slice(0, 2), blob.slice(2));
    chmodSync(obj, 0o644);
    unlinkSync(obj);

    const file = join(repo, "hetvabhasa.md");
    await expect(readEntryDatesForFile(file)).rejects.toBeInstanceOf(EntryDatesGitError);

    const store = await readEntryDatesForStore(repo, 5000);
    expect(store.code).toBe(503);
    if (store.code === 503 && store.body.status === "failed") {
      expect(store.body.failed).toEqual(["hetvabhasa"]);
      expect(store.body.error).toContain("git log of hetvabhasa.md failed");
      expect(store.body.dates).toEqual({});
    } else throw new Error(`expected a failed answer, got ${JSON.stringify(store.body)}`);
  });

  test("a failure is held briefly: the next request reports it without starting another read", async () => {
    const repo = repoWith({ "dharana.md": [V1, V2] });
    const blob = gitOut(repo, "rev-parse", "HEAD~1:dharana.md");
    const obj = join(repo, ".git", "objects", blob.slice(0, 2), blob.slice(2));
    chmodSync(obj, 0o644);
    unlinkSync(obj);
    const file = join(repo, "dharana.md");
    expect((await peekEntryDatesForFile(file, 5000)).state).toBe("failed");
    const before = datesJobsStarted();
    const held = await peekEntryDatesForFile(file, 0);
    expect(held.state).toBe("failed");
    expect(datesJobsStarted()).toBe(before);
  });

  // A stand-in `git` first on PATH: it hangs or fails for `log`/`blame` as
  // FAKE_GIT says, and hands every other command to the real git.
  function withFakeGit<T>(mode: "hang" | "blame-fails", run: () => Promise<T>): Promise<T> {
    const realGit = Bun.which("git")!;
    const bin = mkdtempSync(join(tmpdir(), "anvideck-fakegit-"));
    made.push(bin);
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh
for a in "$@"; do
  case "$a" in
    log|blame)
      if [ "$FAKE_GIT" = hang ]; then exec sleep 30; fi
      if [ "$FAKE_GIT" = blame-fails ] && [ "$a" = blame ]; then echo "fatal: blame broke" >&2; exit 1; fi
      break;;
  esac
done
exec "${realGit}" "$@"
`
    );
    chmodSync(join(bin, "git"), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    process.env.FAKE_GIT = mode;
    return run().finally(() => {
      process.env.PATH = path;
      delete process.env.FAKE_GIT;
    });
  }

  test("a git that runs past the limit is stopped and reported as a failure", async () => {
    const repo = repoWith({ "krama.md": [V1, V2] });
    const prev = setDatesGitTimeoutMs(400);
    try {
      const t0 = performance.now();
      const r = await withFakeGit("hang", () => peekEntryDatesForFile(join(repo, "krama.md"), 4000));
      expect(r.state).toBe("failed");
      if (r.state === "failed") expect(r.err).toContain("did not finish within 0.4 s");
      // Stopped, not waited out: the stand-in would hang for 30 s. (The wait after the exit can take a few seconds: #253.)
      expect(performance.now() - t0).toBeLessThan(10_000);
    } finally {
      setDatesGitTimeoutMs(prev);
    }
  });

  test("a git blame that fails fails the read even when git log worked", async () => {
    const repo = repoWith({ "vyapti.md": [V1, V2] });
    const r = await withFakeGit("blame-fails", () => peekEntryDatesForFile(join(repo, "vyapti.md"), 4000));
    expect(r.state).toBe("failed");
    if (r.state === "failed") expect(r.err).toContain("git blame of vyapti.md failed: fatal: blame broke");
  });

  test("a file outside any repo still gets file dates, not a failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "anvideck-dates-nogit-"));
    made.push(dir);
    writeFileSync(join(dir, "krama.md"), V2);
    const store = await readEntryDatesForStore(dir, 5000);
    expect(store.code).toBe(200);
    if (store.code === 200) expect(store.body["krama"]!["X1"]!.dateSource).toBe("file");
  });
});
