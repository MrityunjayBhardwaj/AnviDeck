import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FIX_SUBJECT,
  LOG_FORMAT,
  componentOf,
  costByPair,
  coversEdit,
  editHooksOf,
  hookName,
  parseLog,
  readEditHooks,
  readFixCost,
  trendOf,
  type ComponentMap,
} from "../server/readers/design";
import { designRoutes } from "../server/routes/design";
import type { StructureMeasured, StructureProjectResponse } from "../shared/structure-types";
import type { RunResult } from "../server/readers/repo";

const MAP: ComponentMap = {
  root: "src/",
  components: [
    { name: "engine", dirs: ["engine"], files: [] },
    { name: "ir", dirs: [], files: ["engine/vizNames.ts"] },
    { name: "workspace", dirs: ["workspace"], files: [] },
    { name: "visualEdit", dirs: ["visualEdit"], files: ["workspace/seed.tsx"] },
    { name: "deep", dirs: ["engine/deep"], files: [] },
  ],
};

const RS = "\x1e";
const US = "\x1f";
const log = (cs: { sha: string; date: string; s: string; files: string[] }[]) => cs.map((c) => `${RS}${c.sha}${US}${c.date}${US}${c.s}\n\n${c.files.join("\n")}\n`).join("");

describe("the cost curve's parts", () => {
  test("the log format and its parser agree", () => {
    expect(LOG_FORMAT).toBe("--format=\x1e%H\x1f%aI\x1f%s");
    const out = log([{ sha: "b", date: "2026-02-01T00:00:00+00:00", s: "🐛 two", files: ["p/src/a.ts", "p/src/b.ts"] }, { sha: "a", date: "2026-01-01T00:00:00+00:00", s: "fix: one", files: ["p/src/a.ts"] }]);
    expect(parseLog(out)).toEqual([
      { sha: "b", date: "2026-02-01T00:00:00+00:00", subject: "🐛 two", files: ["p/src/a.ts", "p/src/b.ts"] },
      { sha: "a", date: "2026-01-01T00:00:00+00:00", subject: "fix: one", files: ["p/src/a.ts"] },
    ]);
  });

  test("a fix is the bug gitmoji or a subject starting with the word fix", () => {
    for (const s of ["🐛 a bug", "fix: x", "fix(ui): x", "Fix the thing", "FIX x"]) expect(FIX_SUBJECT.test(s)).toBe(true);
    for (const s of ["✨ feature", "prefix fix", "fixture added", "🚚 move", "refactor: fix later"]) expect(FIX_SUBJECT.test(s)).toBe(false);
  });

  test("a file maps to its listed file first, then the longest listed folder; outside the root, to none", () => {
    expect(componentOf("src/engine/vizNames.ts", MAP)).toBe("ir");
    expect(componentOf("src/engine/x.ts", MAP)).toBe("engine");
    expect(componentOf("src/engine/deep/y.ts", MAP)).toBe("deep");
    expect(componentOf("src/workspace/seed.tsx", MAP)).toBe("visualEdit");
    expect(componentOf("src/engineering/z.ts", MAP)).toBeNull();
    expect(componentOf("package.json", MAP)).toBeNull();
  });

  test("the trend compares the later half's mean with the earlier half's by one file", () => {
    expect(trendOf([2, 3])).toBe("too few");
    expect(trendOf([2, 3, 4])).toBe("rising"); // 4 vs 2
    expect(trendOf([2, 3, 2.5])).toBe("flat");
    expect(trendOf([5, 5, 4, 4])).toBe("falling"); // exactly one fewer
    expect(trendOf([5, 5, 4.5, 4.5])).toBe("flat");
    expect(trendOf([4, 4, 5, 5])).toBe("rising"); // exactly one more
    expect(trendOf([6, 9, 8, 7, 17, 9])).toBe("rising");
  });

  test("a fix counts for a pair only when it changes files on both sides; its cost is every package file it changed", () => {
    const commits = parseLog(log([
      { sha: "4", date: "2026-04-01T00:00:00Z", s: "🐛 both", files: ["pkg/src/engine/a.ts", "pkg/src/workspace/b.ts", "pkg/README.md", "other/x.ts"] },
      { sha: "3", date: "2026-03-01T00:00:00Z", s: "✨ both but not a fix", files: ["pkg/src/engine/a.ts", "pkg/src/workspace/b.ts"] },
      { sha: "2", date: "2026-02-01T00:00:00Z", s: "fix: one side", files: ["pkg/src/engine/a.ts"] },
      { sha: "1", date: "2026-01-01T00:00:00Z", s: "Fix both", files: ["pkg/src/engine/a.ts", "pkg/src/workspace/c.ts"] },
    ]));
    const r = costByPair(commits, "pkg", MAP, [{ pair: "engine -> workspace", count: 3 }, { pair: "workspace -> visualEdit", count: 1 }]);
    expect(r.fixCommits).toBe(3);
    expect(r.unmappedFiles).toBe(1); // pkg/README.md; other/x.ts is outside the package
    expect(r.pairs[0].fixes.map((f) => [f.sha, f.files])).toEqual([["1", 2], ["4", 3]]); // oldest first
    expect(r.pairs[0].held).toBe(3);
    expect(r.pairs[1].fixes).toEqual([]);
    expect(r.pairs[1].trend).toBe("too few");
  });
});

function measured(over: Partial<StructureMeasured> = {}): StructureMeasured {
  return {
    status: "measured",
    project: "p",
    package: { dir: "/repo/pkg", design: "/d.json", baseline: "/b.json", designId: "d1", extractor: null, source: "locked", check: null },
    refAsked: null,
    refChosenBy: "default",
    measuredAt: { ref: "origin/main", sha: "abcdef1234", date: "2026-11-05T10:00:00+05:30", why: "", modulesFrom: [] },
    designId: "d1",
    baselineDesignId: "d1",
    components: MAP.components.map((c) => ({ ...c, why: null, modules: 1 })),
    allowedPairs: [],
    edgeNotes: {},
    modules: [{ path: "src/engine/a.ts", rel: "engine/a.ts", component: "engine" }],
    edges: [],
    cycles: [],
    rules: { divergence: { examined: 0, total: 0, grandfathered: 0, new: [], fixed: [] }, cycle: { examined: 0, total: 0, grandfathered: 0, new: [], fixed: [] } },
    byPair: [{ pair: "engine -> workspace", count: 2 }],
    unmapped: [],
    absences: [],
    counts: {} as StructureMeasured["counts"],
    extractor: "",
    typeOnlyImports: "",
    source: { label: "g", guard: { path: "", sha256: "", mtime: "" }, rules: null, graph: null },
    timing: { cache: "hit", ms: 0, guardMs: null },
    ...over,
  };
}

const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: "" });

describe("readFixCost", () => {
  test("no design, or a design not measured, is said so, never an empty curve", async () => {
    const noDesign = await readFixCost("p", { structure: async () => ({ status: "no-design", project: "p" }) as StructureProjectResponse });
    expect(noDesign.status).toBe("no-design");
    const notMeasured = await readFixCost("p", { structure: async () => ({ status: "not-measured", project: "p", refAsked: null, reason: "guard crashed" }) });
    expect(notMeasured).toMatchObject({ status: "not-measured" });
    expect((notMeasured as { reason: string }).reason).toContain("guard crashed");
  });

  test("git failing is unreadable, with git's own words", async () => {
    const r = await readFixCost("p", {
      structure: async () => measured(),
      run: async (_c, args) => (args.includes("rev-parse") ? ok("/repo\n") : { code: 128, stdout: "", stderr: "fatal: bad object abcdef1234" }),
    });
    expect(r).toMatchObject({ status: "unreadable" });
    expect((r as { reason: string }).reason).toContain("bad object");
  });

  test("reads the log at the commit the guard measured, for the package only, and names the population", async () => {
    const calls: string[][] = [];
    const r = await readFixCost("p", {
      structure: async () => measured(),
      run: async (_c, args) => {
        calls.push(args);
        if (args.includes("rev-parse")) return ok("/repo\n");
        return ok(log([
          { sha: "2", date: "2026-02-01T00:00:00Z", s: "🐛 b", files: ["pkg/src/engine/a.ts", "pkg/src/workspace/b.ts", "pkg/src/workspace/c.ts"] },
          { sha: "1", date: "2026-01-01T00:00:00Z", s: "🐛 a", files: ["pkg/src/engine/a.ts", "pkg/src/workspace/b.ts"] },
        ]));
      },
    });
    expect(calls[1]).toEqual(["-C", "/repo", "log", "abcdef1234", "--no-merges", LOG_FORMAT, "--name-only", "--", "pkg"]);
    expect(r.status).toBe("measured");
    if (r.status !== "measured") return;
    expect(r.commits).toBe(2);
    expect(r.fixCommits).toBe(2);
    expect(r.at).toEqual({ ref: "origin/main", sha: "abcdef1234", date: "2026-11-05T10:00:00+05:30" });
    expect(r.pairs[0].fixes.map((f) => f.files)).toEqual([2, 3]);
  });
});

describe("the hooks an edit passes through", () => {
  test("a matcher covers an edit when it matches Write, Edit or MultiEdit as a whole name, or is empty", () => {
    for (const m of ["Write|Edit|MultiEdit", "Edit", "", undefined, "*", ".*", "Bash|Edit|Write|MultiEdit|Agent|Task"]) expect(coversEdit(m)).toBe(true);
    // Claude Code's docs: a plain string matches the tool name exactly, so "dit" or "Edi" is not Edit.
    for (const m of ["Read", "Bash", "EditNotebook", "mcp__.*", "dit", "Edi", "Write2", 3]) expect(coversEdit(m)).toBe(false);
  });

  test("hooks are listed in registration order, PreToolUse only", () => {
    const settings = {
      hooks: {
        PostToolUse: [{ matcher: "Edit", hooks: [{ command: "node post.js" }] }],
        PreToolUse: [
          { matcher: "Read", hooks: [{ command: "node /h/reader.js" }] },
          { matcher: "Write|Edit|MultiEdit", hooks: [{ command: 'node "/h/catalogue-context-injector.js"' }, { command: 'node "/h/structure-guard-hook.js"' }] },
        ],
      },
    };
    expect(editHooksOf(settings).map((h) => h.name)).toEqual(["catalogue-context-injector.js", "structure-guard-hook.js"]);
    expect(hookName("/usr/local/bin/thing --x")).toBe("thing");
  });

  test("an absent settings file is none, a damaged one unreadable", () => {
    const d = mkdtempSync(join(tmpdir(), "design-hooks-"));
    expect(readEditHooks(join(d, "missing.json")).status).toBe("none");
    writeFileSync(join(d, "bad.json"), "{nope");
    expect(readEditHooks(join(d, "bad.json")).status).toBe("unreadable");
    writeFileSync(join(d, "ok.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Edit", hooks: [{ command: "node /x/structure-guard-hook.js" }] }] } }));
    const r = readEditHooks(join(d, "ok.json"));
    expect(r.status).toBe("ok");
    writeFileSync(join(d, "none.json"), JSON.stringify({ hooks: {} }));
    expect(readEditHooks(join(d, "none.json")).status).toBe("none");
  });
});

describe("GET /api/design", () => {
  test("cost needs a project", async () => {
    const app = designRoutes({ cost: { structure: async () => measured() } });
    expect((await app.request("/cost")).status).toBe(400);
  });
});
