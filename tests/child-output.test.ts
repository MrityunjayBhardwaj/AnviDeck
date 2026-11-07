import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { lostOutputEnds, outputNeverEnded, readProcess, settleAfterExit } from "../server/child-output";
import { spawnRun } from "../server/agents/worktree";
import { gitIn } from "../server/readers/git-history";
import { gitRead } from "../server/readers/history";
import { runAsync } from "../server/readers/replay";
import { timedRun } from "../server/readers/work";

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

/**
 * #253: once a child has exited, waiting for its output has a limit. These use real processes. A
 * background `sleep` that inherits the output holds it open after the shell exits, so the end
 * reliably does not come while the test watches: the same state Bun sometimes reaches by itself.
 */
const QUIET = 300;
const HOLDS = "echo hello; sleep 8 & exit 3"; // exits at once with 3; the sleep keeps the output open
const WHOLE = "echo hello; exit 3";
// Exits at once; a background loop goes on writing for longer than QUIET, in gaps shorter than it.
const STILL_WRITING = "(for i in 1 2 3 4 5 6 7 8; do echo line$i; sleep 0.1; done; sleep 6) & exit 0";

function viaNode(script: string) {
  return new Promise<{ code: number | null; ended: boolean; out: string; ms: number }>((resolve) => {
    const t0 = Date.now();
    const child = spawn("sh", ["-c", script], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout!.on("data", (d) => (out += d));
    child.stderr!.on("data", () => {});
    settleAfterExit(child, "test child", (code, _s, ended) => resolve({ code, ended, out, ms: Date.now() - t0 }), QUIET);
  });
}
async function viaBun(script: string) {
  const t0 = Date.now();
  const proc = Bun.spawn(["sh", "-c", script], { stdout: "pipe", stderr: "pipe" });
  const r = await readProcess(proc, "test child", QUIET);
  return { code: r.code, ended: r.ended, out: r.stdout, ms: Date.now() - t0 };
}

for (const [name, run] of [["node:child_process", viaNode], ["Bun.spawn", viaBun]] as const) {
  describe(`waiting for a child's output, ${name}`, () => {
    test("a child that ends normally: its output and code, not counted", async () => {
      const before = lostOutputEnds();
      const r = await run(WHOLE);
      expect(r).toMatchObject({ code: 3, ended: true, out: "hello\n" });
      expect(lostOutputEnds()).toBe(before);
    });

    test("exited, and the output never ends: the wait ends, says so and is counted", async () => {
      const before = lostOutputEnds();
      const r = await run(HOLDS);
      expect(r).toMatchObject({ code: 3, ended: false, out: "hello\n" });
      expect(r.ms).toBeLessThan(5000); // the sleep holds it for 8 s
      expect(lostOutputEnds()).toBe(before + 1);
    });

    test("output still arriving after the exit is waited for", async () => {
      const r = await run(STILL_WRITING);
      expect(r.out.trim().split("\n")).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map((i) => `line${i}`));
      expect(r.ended).toBe(false);
    });
  });
}

describe("plain text that never ended is not taken as the answer", () => {
  // A cut-off git log would read as a shorter history; these say they could not tell instead.
  const standIn = (): string => {
    const d = mkdtempSync(join(tmpdir(), "child-output-git-"));
    made.push(d);
    writeFileSync(join(d, "git"), `#!/bin/sh\n${HOLDS.replace("exit 3", "exit 0")}\n`);
    chmodSync(join(d, "git"), 0o755);
    return d;
  };
  const withStandInGit = async <T>(run: () => Promise<T>): Promise<T> => {
    const path = process.env.PATH;
    process.env.PATH = `${standIn()}:${path}`;
    try {
      return await run();
    } finally {
      process.env.PATH = path;
    }
  };
  test("gitRead (History)", async () => {
    const r = await withStandInGit(() => gitRead("/tmp", ["log"]));
    expect(r).toEqual({ ok: false, err: expect.stringContaining("output never ended") });
  }, 15_000);
  test("gitIn (entry dates)", async () => {
    const r = await withStandInGit(() => gitIn("/tmp", ["log"]));
    expect(r).toMatchObject({ ok: false, out: "", err: expect.stringContaining("output never ended") });
  }, 15_000);
  test("runAsync (replay)", async () => {
    const r = await runAsync(["sh", "-c", HOLDS.replace("exit 3", "exit 0")]);
    expect(r).toMatchObject({ ok: false, out: "", err: expect.stringContaining("output never ended") });
  }, 15_000);
  test("timedRun (Work)", async () => {
    const r = await timedRun(10_000)("sh", ["-c", HOLDS.replace("exit 3", "exit 0")]);
    expect(r).toMatchObject({ code: 125, stdout: "", stderr: expect.stringContaining("output never ended") });
  }, 15_000);
  test("spawnRun (the agent host's git)", async () => {
    const r = await spawnRun("sh", ["-c", HOLDS.replace("exit 3", "exit 0")]);
    expect(r).toMatchObject({ code: 125, stdout: "", stderr: expect.stringContaining("output never ended") });
  }, 15_000);
});

test("Bun.spawn output whose stream fails has not ended, so it is never taken as whole", async () => {
  const bytes = new TextEncoder().encode("part of a log");
  let pulls = 0;
  const failing = new ReadableStream<Uint8Array>({
    pull(c) {
      if (pulls++ === 0) c.enqueue(bytes);
      else c.error(new Error("the stream broke"));
    },
  });
  const empty = new ReadableStream<Uint8Array>({ start: (c) => c.close() });
  const r = await readProcess({ stdout: failing, stderr: empty, exited: Promise.resolve(0) }, "test child", QUIET);
  expect(r).toMatchObject({ code: 0, ended: false, stdout: "part of a log" });
});

test("a caller's reason says why the output was not used", () => {
  expect(outputNeverEnded("git log")).toBe("git log exited, but its output never ended, so it may be cut short and was not used");
});

describe("every wait for a child's output goes through server/child-output.ts", () => {
  const root = join(import.meta.dir, "..", "server");
  const files = (d: string): string[] => readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
  const waitsForEnd = /\.(on|once)\("close"|new Response\(\s*\w+\.(stdout|stderr)\s*\)/;

  test("the rule can see one (else it would pass on nothing)", () => {
    expect(waitsForEnd.test(`child.on("close", () => {})`)).toBe(true);
    expect(waitsForEnd.test(`new Response(p.stdout).text()`)).toBe(true);
  });

  test("no other file under server/ waits for the end by itself", () => {
    const all = files(root);
    expect(all.length).toBeGreaterThan(20);
    const found = all
      .filter((f) => relative(root, f) !== "child-output.ts")
      .flatMap((f) => readFileSync(f, "utf8").split("\n").flatMap((l, i) => (waitsForEnd.test(l) ? [`${relative(root, f)}:${i + 1}: ${l.trim()}`] : [])));
    expect(found).toEqual([]);
  });
});
