// Controls for the structure map (issue #16): the reader's numbers must be the guard's numbers.
//
// Each control runs the guard CLI itself (the reference answer) and the reader on the same inputs
// and compares. They read stave and the root-owned lock, so they skip — saying why — on a machine
// that has neither. Nothing here writes into stave: the guard measures a commit through a
// temporary `git archive` under TMP_ROOT and removes it.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import {
  GUARD_PATH,
  LOCKED_REGISTRY,
  TMP_ROOT,
  readRegistry,
  readStructure,
  safeRef,
} from "../server/readers/structure";
import type { StructureMeasured } from "../shared/structure-types";

const STAVE = "/Users/mrityunjaybhardwaj/Documents/projects/stave";
const STAVE_PKG = `${STAVE}/packages/editor`;
const PR_2271_HEAD = "2b25412e329d548de9188e2c7903c583df3908ad";
const PITCH_KEY = "src/codeView/notation/pitch.ts -> src/engine/noteToMidi.ts";
// The baseline in force before the pitch.ts repair was locked in (18 keys, pitch.ts among them).
const OCT14_BASELINE = `${process.env.HOME}/.anvideck/projects/anvi/instances/stave-structure-baseline-graph-2026-10-14.json`;

const missing: string[] = [];
if (!existsSync(STAVE_PKG)) missing.push(`stave package ${STAVE_PKG}`);
if (!existsSync(LOCKED_REGISTRY)) missing.push(`the lock ${LOCKED_REGISTRY}`);
if (!existsSync(GUARD_PATH)) missing.push(`the guard ${GUARD_PATH}`);
const why = missing.length ? `SKIPPED — not on this machine: ${missing.join(", ")}` : "";
if (why) console.log(`structure controls: ${why}`);
const control = missing.length ? test.skip : test;

const hasCommit = (sha: string) =>
  spawnSync("git", ["-C", STAVE, "cat-file", "-t", sha], { encoding: "utf8" }).stdout.trim() === "commit";

/** The guard CLI's own verdict: the reference answer, read off the lines it prints. */
function guardCli(baseline: string, ref: string) {
  const entry = readRegistry().packages.find((e) => e.dir === STAVE_PKG)!;
  mkdirSync(TMP_ROOT, { recursive: true });
  const r = spawnSync(
    "node",
    [GUARD_PATH, "--package", STAVE_PKG, "--design", entry.design, "--baseline", baseline, "--ref", ref],
    { encoding: "utf8", env: { ...process.env, TMPDIR: TMP_ROOT } },
  );
  const out = r.stdout;
  const g = out.match(/examined (\d+) modules · (\d+) edges · design (\w+)/);
  const d = out.match(/divergence: (\d+) of (\d+) examined — (\d+) grandfathered, (\d+) NEW, (\d+) fixed/);
  const at = out.match(/measured \S+ at ([0-9a-f]{8})/);
  const fixedKeys = [...out.matchAll(/^\s+divergence (\S+ -> \S+)$/gm)].map((m) => m[1]);
  if (!g || !d) throw new Error(`the guard gave no verdict (exit ${r.status}):\n${out}\n${r.stderr}`);
  return {
    exit: r.status,
    modules: +g[1], edges: +g[2], designId: g[3],
    total: +d[1], examined: +d[2], grandfathered: +d[3], fresh: +d[4], fixed: +d[5],
    fixedKeys, sha8: at?.[1],
  };
}

async function measured(ref: string, baseline?: string): Promise<StructureMeasured> {
  const r = await readStructure("stave", { ref, entry: baseline ? { baseline } : undefined });
  if (r.status !== "measured") throw new Error(`not measured: ${JSON.stringify(r)}`);
  return r;
}

describe("structure map controls (stave/packages/editor)", () => {
  control("the lock's baseline: the reader counts the keys the file holds", async () => {
    const entry = readRegistry().packages.find((e) => e.dir === STAVE_PKG)!;
    expect(entry.source).toBe("locked");
    expect(entry.designId).toBe("cffdf7d00026");
    const keys = JSON.parse(readFileSync(entry.baseline, "utf8")).rules.divergence.length;
    const r = await measured("origin/main");
    console.log(`  locked baseline ${entry.baseline}: ${keys} divergence keys (issue claimed 18)`);
    expect(r.counts.baselineKeys.divergence).toBe(keys);
  }, 180_000);

  control("the 18 rule breaks the issue names are the 2026-10-14 baseline's", () => {
    if (!existsSync(OCT14_BASELINE)) return console.log(`  SKIPPED — ${OCT14_BASELINE} not present`);
    const b = JSON.parse(readFileSync(OCT14_BASELINE, "utf8"));
    expect(b.designId).toBe("cffdf7d00026");
    expect(b.rules.divergence.length).toBe(18);
    expect(b.rules.divergence).toContain(PITCH_KEY);
  });

  control("origin/main: modules, edges and verdicts equal the guard CLI's", async () => {
    const entry = readRegistry().packages.find((e) => e.dir === STAVE_PKG)!;
    const r = await measured("origin/main");
    const cli = guardCli(entry.baseline, r.measuredAt.sha);
    console.log(`  origin/main ${r.measuredAt.sha.slice(0, 8)}: reader ${r.counts.modules} modules / ${r.counts.edges} edges; ` +
      `guard ${cli.modules} / ${cli.edges} (issue claimed 364 / 935 on an earlier commit)`);
    expect(r.measuredAt.sha.startsWith(cli.sha8!)).toBe(true);
    // The reader hands the guard a hash; that plumbing is not the user's choice of ref.
    expect(r.measuredAt.why).not.toContain("--ref");
    expect(r.measuredAt.why.startsWith(r.refChosenBy)).toBe(true);
    expect([r.counts.modules, r.counts.edges, r.designId]).toEqual([cli.modules, cli.edges, cli.designId]);
    expect([r.counts.divergence.total, r.counts.examinedBetweenComponents, r.counts.divergence.grandfathered, r.counts.divergence.new, r.counts.divergence.fixed])
      .toEqual([cli.total, cli.examined, cli.grandfathered, cli.fresh, cli.fixed]);
    // Every edge has exactly one class, and the classes add up to the graph.
    const c = r.counts.byClass;
    expect(c.internal + c.allowed + c.grandfathered + c.new + c.unmapped).toBe(r.counts.edges);
  }, 180_000);

  control("PR #2271's head against the 2026-10-14 baseline: 17 grandfathered, 0 NEW, 1 fixed (pitch.ts), as the guard says", async () => {
    if (!hasCommit(PR_2271_HEAD)) return console.log(`  SKIPPED — ${PR_2271_HEAD} is not in ${STAVE}; this test never fetches`);
    if (!existsSync(OCT14_BASELINE)) return console.log(`  SKIPPED — ${OCT14_BASELINE} not present`);
    const cli = guardCli(OCT14_BASELINE, PR_2271_HEAD);
    const r = await measured(PR_2271_HEAD, OCT14_BASELINE);
    console.log(`  guard: ${cli.grandfathered} grandfathered, ${cli.fresh} NEW, ${cli.fixed} fixed ${JSON.stringify(cli.fixedKeys)}; ` +
      `reader: ${r.counts.divergence.grandfathered} / ${r.counts.divergence.new} / ${r.counts.divergence.fixed} ${JSON.stringify(r.rules.divergence.fixed)}`);
    expect([cli.grandfathered, cli.fresh, cli.fixed]).toEqual([17, 0, 1]);
    expect(cli.fixedKeys).toEqual([PITCH_KEY]);
    expect([r.counts.divergence.grandfathered, r.counts.divergence.new, r.counts.divergence.fixed]).toEqual([17, 0, 1]);
    expect(r.rules.divergence.fixed).toEqual([PITCH_KEY]);
    expect(r.counts.byClass.grandfathered).toBe(17);
  }, 180_000);

  control("PR #2271's head against the lock in force: the repair is already locked in (0 fixed)", async () => {
    if (!hasCommit(PR_2271_HEAD)) return console.log(`  SKIPPED — ${PR_2271_HEAD} is not in ${STAVE}`);
    const entry = readRegistry().packages.find((e) => e.dir === STAVE_PKG)!;
    const cli = guardCli(entry.baseline, PR_2271_HEAD);
    const r = await measured(PR_2271_HEAD);
    expect([r.counts.divergence.grandfathered, r.counts.divergence.new, r.counts.divergence.fixed])
      .toEqual([cli.grandfathered, cli.fresh, cli.fixed]);
  }, 180_000);

  control("a second read of the same commit, design and baseline is served from the cache", async () => {
    const a = await readStructure("stave", { ref: "origin/main" });
    const b = await readStructure("stave", { ref: "origin/main" });
    expect(b.status).toBe("measured");
    expect((b as StructureMeasured).timing.cache).toBe("hit");
    expect((b as StructureMeasured).counts).toEqual((a as StructureMeasured).counts);
  }, 180_000);

  control("a ref that is not a commit is NOT MEASURED, never an empty graph", async () => {
    const r = await readStructure("stave", { ref: "no-such-branch-anvideck-16" });
    expect(r.status).toBe("not-measured");
  });
});

describe("structure map without a design", () => {
  const ANVI = "/Users/mrityunjaybhardwaj/Documents/projects/anvi";
  (existsSync(ANVI) ? test : test.skip)("anvi has no design: its folders, labelled nothing blocked", async () => {
    const r = await readStructure("anvi");
    expect(r.status).toBe("no-design");
    if (r.status !== "no-design") return;
    expect(r.label).toBe("nothing blocked");
    expect(r.files).toBeGreaterThan(0);
    expect(r.folders.find((f) => f.path === ".")!.total).toBe(r.files);
  });
});

describe("a project with several registered packages", () => {
  const dir = `${TMP_ROOT}-test-registry`;
  const user = `${dir}/structure-guard.json`;
  const registry = { locked: `${dir}/no-lock.json`, user };
  const OTHER = `${STAVE}/packages/other-for-test`;
  control("names none: NOT MEASURED, listing the packages — never the first one silently", async () => {
    const entry = readRegistry().packages.find((e) => e.dir === STAVE_PKG)!;
    mkdirSync(dir, { recursive: true });
    writeFileSync(user, JSON.stringify({ packages: [
      { dir: STAVE_PKG, design: entry.design, baseline: entry.baseline, designId: entry.designId },
      { dir: OTHER, design: entry.design, baseline: entry.baseline, designId: entry.designId },
    ] }));
    try {
      const r = await readStructure("stave", { ref: "origin/main", registry } as any);
      expect(r.status).toBe("not-measured");
      if (r.status !== "not-measured") return;
      expect(r.reason).toContain(STAVE_PKG);
      expect(r.reason).toContain(OTHER);
      const chosen = await readStructure("stave", { ref: "origin/main", registry, package: STAVE_PKG } as any);
      expect(chosen.status).toBe("measured");
      expect((chosen as StructureMeasured).package.dir).toBe(STAVE_PKG);
      expect((chosen as StructureMeasured).package.source).toBe("user");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 180_000);
});

describe("refs handed to git", () => {
  test("option-shaped and range refs are refused", () => {
    expect(safeRef("--output=/tmp/x")).toBe(false);
    expect(safeRef("main..evil")).toBe(false);
    expect(safeRef("origin/main")).toBe(true);
    expect(safeRef(PR_2271_HEAD)).toBe(true);
  });
});
