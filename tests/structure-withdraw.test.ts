// #49 item 5: a page that moves to another project withdraws its guard request, and the
// server stops that run when no other request waits for it. Runs the real guard on stave
// (skipped, saying why, on a machine without stave, the lock or the guard).
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  GUARD_PATH,
  LOCKED_REGISTRY,
  GUARD_CONCURRENCY,
  WITHDRAWN_REASON,
  clearStructureCache,
  guardRunStats,
  readStructure,
  resetGuardRunStats,
} from "../server/readers/structure";

const STAVE_PKG = "/Users/mrityunjaybhardwaj/Documents/projects/stave/packages/editor";
const missing = [STAVE_PKG, LOCKED_REGISTRY, GUARD_PATH].filter((p) => !existsSync(p));
if (missing.length) console.log(`structure withdrawal controls: SKIPPED — not on this machine: ${missing.join(", ")}`);
const control = missing.length ? test.skip : test;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("a withdrawn guard request stops its run (#49)", () => {
  control("the only request withdraws mid-run: the run stops, says why, and is not cached", async () => {
    clearStructureCache();
    resetGuardRunStats();
    const ctl = new AbortController();
    const t0 = Date.now();
    const p = readStructure("stave", { ref: "origin/main~4", signal: ctl.signal });
    await sleep(250);
    ctl.abort();
    const r = await p;
    const ms = Date.now() - t0;
    expect(r.status).toBe("not-measured");
    expect((r as any).reason).toBe(WITHDRAWN_REASON);
    expect(guardRunStats().withdrawn).toBe(1);
    expect(ms).toBeLessThan(1500); // a cold stave run takes about 2 s
    // Asked again, with nobody withdrawing: measured, not the withdrawn answer from a cache.
    const again = await readStructure("stave", { ref: "origin/main~4" });
    expect(again.status).toBe("measured");
    expect((again as any).timing.cache).toBe("miss");
  }, 120_000);

  control("must not stop: one of two requests for the same run withdraws, the other still gets the answer", async () => {
    clearStructureCache();
    resetGuardRunStats();
    const ctl = new AbortController();
    const a = readStructure("stave", { ref: "origin/main~5", signal: ctl.signal });
    const b = readStructure("stave", { ref: "origin/main~5" });
    await sleep(250);
    ctl.abort();
    const [ra, rb] = await Promise.all([a, b]);
    expect(rb.status).toBe("measured");
    expect(ra.status).toBe("measured"); // the shared run finished; its answer is the run's
    expect(guardRunStats().started).toBe(1);
    expect(guardRunStats().withdrawn).toBe(0);
  }, 120_000);

  control(`a request withdrawn while it waits for a slot never starts a run`, async () => {
    clearStructureCache();
    resetGuardRunStats();
    const busy = Array.from({ length: GUARD_CONCURRENCY }, (_, i) => readStructure("stave", { ref: `origin/main~${6 + i}` }));
    await sleep(100);
    const ctl = new AbortController();
    const queued = readStructure("stave", { ref: `origin/main~${6 + GUARD_CONCURRENCY}`, signal: ctl.signal });
    await sleep(100);
    expect(guardRunStats().queued).toBe(1);
    let freed = 0;
    for (const b of busy) b.then(() => freed++);
    const tAbort = Date.now();
    ctl.abort();
    const r = await queued;
    expect((r as any).reason).toBe(WITHDRAWN_REASON);
    // It leaves the queue at once, not when a slot frees (a run takes seconds).
    expect(freed).toBe(0);
    expect(Date.now() - tAbort).toBeLessThan(150);
    for (const x of await Promise.all(busy)) expect(x.status).toBe("measured");
    expect(guardRunStats().started).toBe(GUARD_CONCURRENCY);
    expect(guardRunStats().withdrawn).toBe(1);
  }, 120_000);
});
