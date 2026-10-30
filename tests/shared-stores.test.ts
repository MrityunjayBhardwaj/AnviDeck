import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { markSharedStores } from "../server/routes/api";
import type { ProjectSummary } from "../shared/types";

/**
 * #36 / #32: one notes store must be counted once. Fixture under /private/tmp:
 *   store/main/.anvi            real store, owned by project "main"
 *   main-wt/.anvi -> store/main/.anvi   a worktree's symlink (shares main's store)
 *   store/twin/.anvi            real store, reached also as store/TWIN/.anvi (case-insensitive FS)
 *   other/.anvi                 a different store that merely looks alike (must not be grouped)
 */
const F = "/private/tmp/claude-501/anvideck-test-shared-stores";
const summary = (name: string, path: string): ProjectSummary =>
  ({ name, path, catalogueCounts: { hetvabhasa: 5 }, memoryCount: 0, fatalitySignals: 1, misalignedInvariants: 0, blindSpots: 0, groundingPercent: 0, groundTruthDocCount: 0 }) as ProjectSummary;

beforeAll(() => {
  rmSync(F, { recursive: true, force: true });
  mkdirSync(`${F}/store/main/.anvi`, { recursive: true });
  mkdirSync(`${F}/main-wt`, { recursive: true });
  symlinkSync(`${F}/store/main/.anvi`, `${F}/main-wt/.anvi`);
  mkdirSync(`${F}/store/twin/.anvi`, { recursive: true });
  mkdirSync(`${F}/other/.anvi`, { recursive: true });
});
afterAll(() => rmSync(F, { recursive: true, force: true }));

describe("one notes store, one owner", () => {
  test("a worktree whose .anvi is a symlink to the parent's store shares it; the parent owns it", () => {
    const s = [summary("main-wt", `${F}/main-wt`), summary("main", `${F}/store/main`)];
    markSharedStores(s, [`${F}/main-wt/.anvi`, `${F}/store/main/.anvi`]);
    expect(s[0].sharesNotesWith).toBe("main");
    expect(s[1].sharesNotesWith).toBeUndefined();
  });

  test.skipIf(process.platform !== "darwin")("a case-twin path to the same store (macOS) is the same store; the exact name owns it", () => {
    const s = [summary("TWIN", `${F}/elsewhere/TWIN`), summary("twin", `${F}/store/twin`)];
    markSharedStores(s, [`${F}/store/TWIN/.anvi`, `${F}/store/twin/.anvi`]);
    expect(s[0].sharesNotesWith).toBe("twin");
    expect(s[1].sharesNotesWith).toBeUndefined();
  });

  test("must-not-match: two different stores are both owners", () => {
    const s = [summary("main", `${F}/store/main`), summary("other", `${F}/other`)];
    markSharedStores(s, [`${F}/store/main/.anvi`, `${F}/other/.anvi`]);
    expect(s.map((x) => x.sharesNotesWith)).toEqual([undefined, undefined]);
  });

  test("a project with no store, or an unreadable one, is left alone", () => {
    const s = [summary("none", `${F}/none`), summary("gone", `${F}/gone`)];
    markSharedStores(s, [null, `${F}/gone/.anvi`]);
    expect(s.map((x) => x.sharesNotesWith)).toEqual([undefined, undefined]);
  });
});

// #32: the centralized store counts only under the project's exact folder name. Uses the real
// ~/.anvideck/projects/stave store and a parent folder that does not exist, so only the
// centralized candidate can match.
import { existingDirs } from "../shared/anvi-paths";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
const STAVE_STORE = `${homedir()}/.anvideck/projects/stave/.anvi`;
describe.skipIf(!existsSync(STAVE_STORE))("central store name must match exactly (#32)", () => {
  test("must-resolve: a project named exactly 'stave' gets the store", () => {
    expect(existingDirs("/nonexistent-parent-for-test/stave", ".anvi")).toEqual([STAVE_STORE]);
  });
  test("must-not-resolve: 'Stave' (case only) does not", () => {
    expect(existingDirs("/nonexistent-parent-for-test/Stave", ".anvi")).toEqual([]);
  });
});
