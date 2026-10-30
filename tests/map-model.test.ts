// The Map's model (issue #19): layout, edge classes and replay → file matching.
// Pure functions on small fixtures shaped like the real API answers; nothing is read from disk.
import { describe, expect, test } from "bun:test";
import {
  agentAt,
  blockEdges,
  blockRules,
  layerComponents,
  layoutFolders,
  layoutMeasured,
  moduleForPath,
  modulesNamedInCommand,
  stepTouches,
} from "../ui/components/map-model";
import type { StructureMeasured, StructureNoDesign, StructureEdge, EdgeClass } from "../shared/structure-types";
import type { ReplayResponse, ReplayStep } from "../shared/replay-types";

const PKG = "/Users/x/projects/stave/packages/editor";

function edge(from: string, to: string, fc: string | null, tc: string | null, cls: EdgeClass): StructureEdge {
  return { from, to, fromComponent: fc, toComponent: tc, pair: fc && tc && fc !== tc ? `${fc} -> ${tc}` : null, class: cls, cycle: null, reexport: false, typeOnly: false };
}

function measured(): StructureMeasured {
  const modules = [
    { path: "src/index.ts", rel: "index.ts", component: "entry" },
    { path: "src/engine/HapStream.ts", rel: "engine/HapStream.ts", component: "engine" },
    { path: "src/engine/NormalizedHap.ts", rel: "engine/NormalizedHap.ts", component: "engine" },
    { path: "src/codeView/index.ts", rel: "codeView/index.ts", component: "codeView" },
    { path: "src/codeView/notation/noteToMidi.ts", rel: "codeView/notation/noteToMidi.ts", component: "codeView" },
    { path: "src/workspace/editorRegistry.ts", rel: "workspace/editorRegistry.ts", component: "workspace" },
    { path: "src/loose.ts", rel: "loose.ts", component: null },
  ];
  const edges = [
    edge("src/index.ts", "src/engine/HapStream.ts", "entry", "engine", "allowed"),
    edge("src/engine/HapStream.ts", "src/codeView/index.ts", "engine", "codeView", "allowed"),
    edge("src/engine/HapStream.ts", "src/engine/NormalizedHap.ts", "engine", "engine", "internal"),
    edge("src/codeView/index.ts", "src/workspace/editorRegistry.ts", "codeView", "workspace", "grandfathered"),
    edge("src/codeView/notation/noteToMidi.ts", "src/workspace/editorRegistry.ts", "codeView", "workspace", "new"),
    edge("src/loose.ts", "src/index.ts", null, "entry", "unmapped"),
  ];
  return {
    status: "measured",
    project: "stave",
    package: { dir: PKG, design: "d", baseline: "b", designId: "cffdf7d00026", extractor: null, source: "locked", check: null },
    refAsked: null,
    refChosenBy: "test",
    measuredAt: { ref: "origin/main", sha: "6ab62e46", date: null, why: "test", modulesFrom: [] },
    designId: "cffdf7d00026",
    baselineDesignId: "cffdf7d00026",
    components: ["entry", "engine", "codeView", "workspace", "theme"].map((name) => ({ name, dirs: [name], files: [], why: name === "engine" ? "sound" : null, modules: 0 })),
    allowedPairs: ["entry -> engine", "engine -> codeView", "entry -> workspace", "workspace -> theme"],
    edgeNotes: { "engine -> codeView": "ARGUED: one path between code and a view." },
    modules,
    edges,
    cycles: [],
    rules: {
      divergence: { examined: 4, total: 2, grandfathered: 1, new: [], fixed: [] },
      cycle: { examined: 6, total: 0, grandfathered: 0, new: [], fixed: [] },
    },
    byPair: [],
    unmapped: ["src/loose.ts"],
    absences: [],
    counts: {
      modules: modules.length,
      edges: edges.length,
      examinedBetweenComponents: 4,
      byClass: { internal: 1, allowed: 2, grandfathered: 1, new: 1, unmapped: 1 },
      divergence: { total: 2, grandfathered: 1, new: 1, fixed: 0 },
      cycle: { total: 0, grandfathered: 0, new: 0, fixed: 0 },
      baselineKeys: { divergence: 1, cycle: 0 },
      relativeImports: edges.length,
      unresolvedRelative: 0,
    },
    extractor: "typescript",
    typeOnlyImports: "not counted",
    source: { label: "structure-guard x@sha256:1f1e", guard: { path: "g", sha256: "1f1e", mtime: "t" }, rules: null, graph: null },
    timing: { cache: "miss", ms: 1, guardMs: 1 },
  };
}

describe("layout", () => {
  test("a component sits above what it may use; components in no declared pair get a last row", () => {
    const l = layerComponents(["entry", "engine", "codeView", "gates"], ["entry -> engine", "engine -> codeView"]);
    expect(l.get("entry")).toBe(0);
    expect(l.get("engine")).toBe(1);
    expect(l.get("codeView")).toBe(2);
    expect(l.get("gates")).toBe(3);
  });

  test("a cycle in the declared pairs ends (no endless relaxation)", () => {
    const l = layerComponents(["a", "b"], ["a -> b", "b -> a"]);
    expect(l.size).toBe(2);
    for (const v of l.values()) expect(v).toBeLessThan(2);
  });

  test("every module gets exactly one cell, and blocks do not overlap", () => {
    const m = measured();
    const L = layoutMeasured(m);
    expect(L.cellByPath.size).toBe(m.modules.length);
    expect([...L.cellByPath.keys()].sort()).toEqual(m.modules.map((x) => x.path).sort());
    // modules outside every component get their own block, not a design component
    expect(L.byId.get("(outside every component)")?.kind).toBe("outside");
    for (const a of L.blocks)
      for (const b of L.blocks) {
        if (a === b) continue;
        const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        expect(apart).toBe(true);
      }
    expect(L.byId.get("entry")!.y).toBeLessThan(L.byId.get("engine")!.y);
  });

  test("a project with no design shows its top folders as folder blocks", () => {
    const nd: StructureNoDesign = {
      status: "no-design",
      project: "anvi",
      path: "/x/anvi",
      label: "nothing blocked",
      refAsked: null,
      refChosenBy: "t",
      measuredAt: null,
      treeFrom: "disk",
      folders: [
        { path: ".", files: 3, total: 10 },
        { path: "hooks", files: 4, total: 4 },
        { path: "scripts", files: 1, total: 3 },
        { path: "scripts/lib", files: 2, total: 2 },
      ],
      files: 10,
      timing: { cache: "miss", ms: 1 },
    };
    const L = layoutFolders(nd);
    expect(L.blocks.every((b) => b.kind === "folder")).toBe(true);
    expect(L.byId.get("scripts")!.count).toBe(3);
    expect(L.byId.get("scripts")!.subfolders).toEqual([{ path: "lib", total: 2 }]);
    expect(L.byId.get("(top level)")!.count).toBe(3);
    expect(L.cellByPath.size).toBe(0);
  });
});

describe("edges and rules", () => {
  test("block arrows carry the guard's class counts; inside-one-component imports are not arrows", () => {
    const m = measured();
    const be = blockEdges(m);
    const cw = be.find((e) => e.from === "codeView" && e.to === "workspace")!;
    expect(cw.byClass.grandfathered).toBe(1);
    expect(cw.byClass.new).toBe(1);
    expect(cw.declared).toBe(false);
    expect(be.some((e) => e.from === "engine" && e.to === "engine")).toBe(false);
    // the counts over arrows add up to every import between blocks
    const sum = be.reduce((s, e) => s + e.total, 0);
    expect(sum).toBe(m.edges.filter((e) => (e.fromComponent ?? "-") !== (e.toComponent ?? "-")).length);
    // a declared pair that no import uses is still drawn (what the design allows)
    const unused = be.find((e) => e.from === "workspace" && e.to === "theme")!;
    expect(unused.total).toBe(0);
    expect(unused.declared).toBe(true);
  });

  test("a block's rules: what it may use, who may use it, and the design's notes", () => {
    const r = blockRules(measured(), "engine");
    expect(r.mayUse).toEqual(["codeView"]);
    expect(r.usedBy).toEqual(["entry"]);
    expect(r.notes.map((n) => n.pair)).toEqual(["engine -> codeView"]);
    expect(r.why).toBe("sound");
    expect(blockRules(measured(), "codeView").breaks.length).toBe(2);
  });
});

describe("replay paths → files on the map", () => {
  const paths = new Set(measured().modules.map((m) => m.path));

  test("a file in another worktree of the same package maps to the module", () => {
    expect(moduleForPath("/Users/x/projects/stave-wt-2264/packages/editor/src/engine/HapStream.ts", paths, "packages/editor")).toBe("src/engine/HapStream.ts");
    expect(moduleForPath("packages/editor/src/index.ts", paths, "packages/editor")).toBe("src/index.ts");
  });

  test("another package's file of the same name does not map", () => {
    expect(moduleForPath("/Users/x/projects/stave/packages/other/src/index.ts", paths, "packages/editor")).toBeNull();
    expect(moduleForPath("/Users/x/projects/stave/packages/editor/dist/index.js", paths, "packages/editor")).toBeNull();
  });

  test("a command names a module by its path inside src, at a word start only", () => {
    const mods = measured().modules;
    const cmd = `cd /w/packages/editor/src && python3 - <<'EOF'\nsub('engine/HapStream.ts', a, b)\nsub('codeView/index.ts', c, d)\nEOF`;
    expect(modulesNamedInCommand(cmd, mods)).toEqual(["src/codeView/index.ts", "src/engine/HapStream.ts"]);
    // "index.ts" inside "codeView/index.ts" is not the root index.ts; a longer name is not a match
    expect(modulesNamedInCommand("cat codeView/index.ts", mods)).toEqual(["src/codeView/index.ts"]);
    expect(modulesNamedInCommand("cat engine/HapStream.tsx", mods)).toEqual([]);
  });

  function replay(steps: Partial<ReplayStep>[], files: ReplayResponse["changes"]["files"] = []): ReplayResponse {
    return {
      timezone: "UTC",
      sessionId: "s",
      window: { from: null, to: null },
      transcript: { status: "ok" },
      sources: { hookMeter: { status: "none" }, hookLog: { status: "none" }, git: { status: "ok" }, github: { status: "ok" } },
      steps: steps.map((s, i) => ({ seq: i, ts: null, placement: "timestamp", placedAt: `2026-10-30T09:0${i}:00.000Z`, kind: "tool", source: "transcript", ...s }) as ReplayStep),
      notes: { status: "none", items: [] },
      changes: { status: files.length ? "ok" : "none", files },
      commits: [
        { sha: "2b25412e00", committedAt: "2026-10-30T11:39:21Z", subject: "move", repoDir: "/w", files: [{ status: "M", path: "packages/editor/src/engine/HapStream.ts" }, { status: "M", path: "packages/editor/dist/index.js" }] },
      ],
      unattributedCommits: [],
      prs: [],
      timingsMs: {},
    };
  }

  test("a shell write is marked, and carries the replay's own design-rules label for its files", () => {
    const r = replay(
      [
        { tool: "Bash", command: "cd /w/packages/editor/src && python3 -c \"open('engine/HapStream.ts','w')\"", mayEditFiles: { source: "guessed", reason: "a script opens a file for writing", scope: "project" } },
        { tool: "Bash", command: "echo > $S/x.txt", mayEditFiles: { source: "guessed", reason: "redirect", scope: "scratch" } },
        { tool: "Bash", command: "sed -i s/a/b/ README.md", mayEditFiles: { source: "guessed", reason: "sed -i", scope: "project" } },
        { tool: "Edit", filePath: "/w/stave-wt/packages/editor/src/codeView/index.ts" },
        { kind: "commit", source: "commit", sha: "2b25412e00" },
      ],
      [
        { path: "/w/stave-wt/packages/editor/src/engine/HapStream.ts", how: ["commit", "pr"], viaShell: true, designRules: "checked at merge, not at edit (PR #2271 merged)", notesGap: "no notes given for these files" },
      ]
    );
    const t = stepTouches(r, measured());
    expect(t[0].shellWrite).toBe(true);
    expect(t[0].modules).toEqual(["src/engine/HapStream.ts"]);
    expect(t[0].how).toBe("shell-guess");
    expect(t[0].designRules).toBe("checked at merge, not at edit (PR #2271 merged)");
    expect(t[0].notesGap).toBe("no notes given for these files");
    // scratch-only writes are not code changes
    expect(t[1].shellWrite).toBe(false);
    // a shell write whose files the replay did not confirm says so
    expect(t[2].shellWrite).toBe(true);
    expect(t[2].designRules).toBe("not confirmed");
    expect(t[3]).toMatchObject({ how: "tool", modules: ["src/codeView/index.ts"], shellWrite: false });
    expect(t[4]).toMatchObject({ how: "commit", modules: ["src/engine/HapStream.ts"] });
    const at = agentAt(t, 3);
    expect(at.last).toBe("src/codeView/index.ts");
  });

  test("a shell edit to a changed file the map does not hold takes the replay's label for it (#42)", () => {
    const r = replay(
      [{ tool: "Bash", command: "cd /w/packages/editor/src && python3 - <<'EOF'\np='engine/StrudelEngine.test.ts'\nopen(p,'w')\nEOF", mayEditFiles: { source: "guessed", reason: "a script opens a file for writing", scope: "project" } }],
      [{ path: "/w/stave-wt-2264/packages/editor/src/engine/StrudelEngine.test.ts", how: ["commit"], viaShell: true, designRules: "checked at merge, not at edit (PR #2271 merged)", notesGap: "no notes given for these files" }]
    );
    const [t] = stepTouches(r, measured());
    expect(t.modules).toEqual([]);
    expect(t.offMap).toEqual(["src/engine/StrudelEngine.test.ts"]);
    expect(t.designRules).toBe("checked at merge, not at edit (PR #2271 merged)");
  });

  test("agentAt keeps the order files were first touched", () => {
    const r = replay([
      { tool: "Edit", filePath: "/w/packages/editor/src/engine/HapStream.ts" },
      { tool: "Edit", filePath: "/w/packages/editor/src/codeView/index.ts" },
    ]);
    const t = stepTouches(r, measured());
    const at = agentAt(t, 1);
    expect(at.last).toBe("src/codeView/index.ts");
    expect(at.trail).toEqual(["src/engine/HapStream.ts", "src/codeView/index.ts"]);
  });
});
