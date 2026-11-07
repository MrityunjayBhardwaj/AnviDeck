/**
 * Project · Code (#88), the reads and the screen's rules: the tree at the design reader's commit,
 * blame, the catalogues' file:line citations, and the markers joined from the refusals and the
 * design reader (counted from those answers, never on their own).
 */
import { describe, expect, test, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { citesIn, cleanRelPath, parseBlame, placeCites, readCodeTree } from "../server/readers/code";
import { onlyFile } from "../server/routes/refusals";
import { ALL_TIME, windowOf } from "../server/readers/refusals";
import { breakingEdges, buildTree, countsLine, defaultFile, editState, importLines, lineMarks, marks, refusalsSource, resolveSpec, gutterOf, workingHere, lineChunks, blameLabelAt, WHOLE_FILE_LINES, CHUNK_LINES } from "../ui/components/code-model";
import type { CodeTreeOk, WorkingFile } from "../shared/code-types";
import type { Refusal, RefusalsMeasured, RefusalsResponse } from "../shared/refusal-types";
import type { StructureEdge, StructureMeasured, StructureNoDesign } from "../shared/structure-types";
import type { Catalogue } from "../shared/types";

const dirs: string[] = [];
const scratch = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "code-screen-")));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const git = (cwd: string, ...a: string[]) => {
  const r = spawnSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=Tess", ...a], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};

const edge = (from: string, to: string, cls: StructureEdge["class"], cycle: StructureEdge["cycle"] = null, pair = "a -> b"): StructureEdge =>
  ({ from, to, fromComponent: "a", toComponent: "b", pair, class: cls, cycle, reexport: false, typeOnly: false });

function structure(edges: StructureEdge[]): StructureMeasured {
  return {
    status: "measured", project: "p", refAsked: null, refChosenBy: "origin/HEAD", designId: "d1", baselineDesignId: "d1",
    package: { dir: "/r/pkg", design: "", baseline: "", designId: "d1", extractor: null, source: "user", check: null },
    measuredAt: { ref: "origin/main", sha: "a".repeat(40), date: null, why: "origin/HEAD", modulesFrom: [] },
    components: [{ name: "engine", dirs: ["engine"], files: [], why: null, modules: 2 }], allowedPairs: [], edgeNotes: {},
    modules: [{ path: "src/engine/x.ts", rel: "engine/x.ts", component: "engine" }], edges, cycles: [],
    rules: { divergence: { examined: 0, total: 0, grandfathered: 0, new: [], fixed: [] }, cycle: { examined: 0, total: 0, grandfathered: 0, new: [], fixed: [] } },
    byPair: [], unmapped: [], absences: [],
    counts: { modules: 2, edges: edges.length, examinedBetweenComponents: 0, byClass: { internal: 0, allowed: 0, grandfathered: 0, new: 0, unmapped: 0 },
      divergence: { total: 0, grandfathered: 0, new: 0, fixed: 0 }, cycle: { total: 0, grandfathered: 0, new: 0, fixed: 0 }, baselineKeys: { divergence: 0, cycle: 0 }, relativeImports: 0, unresolvedRelative: 0 },
    extractor: "", typeOnlyImports: "", source: { label: "guard", guard: { path: "", sha256: "", mtime: "" }, rules: null, graph: null }, timing: { cache: "hit", ms: 0, guardMs: null },
  };
}

const refusal = (file: string, key: string, target = "src/monaco/m.ts"): Refusal => ({
  key, at: "2026-10-22T16:16:00Z", session: "s".repeat(36), tool: "Edit", file, checkout: "worktree", checkoutDir: "/w", version: null, transcript: "/t",
  refusedBy: "graph rule", checkToo: false, design: "d1", violations: [{ rule: "divergence", key: `${file} -> ${target}` }], pairs: [{ key: `${file} -> ${target}`, pair: "engine -> monaco" }],
  reason: "BLOCKED", call: { state: "none" },
});
const measured = (refusals: Refusal[]): RefusalsMeasured => ({
  status: "measured", project: "p", package: "/r/pkg", window: { since: "2026-10-06T00:00:00.000Z", until: null, chosenBy: "the last 30 days (from midnight UTC)" },
  instrument: { name: "structure-refusals.js", path: "", sha256: "", mtime: "", args: [], ranAt: "", ms: 0, exit: 1, exitMeaning: "" },
  transcripts: { read: 1, unreadable: 0, badLines: 0 },
  totals: { edits: 9, sessions: 1, applied: 9, refused: refusals.length, refusedByCheckAlone: 0, deniedOtherwise: 0, erroredOtherwise: 0, noResult: 0, timedOut: 0, cancelled: 0, unrecognised: 0 },
  notices: {}, refusals, timeouts: [], unrecognised: [], exposure: null, defaultBranch: null, byDesign: [], trialReading: null, report: "",
  cache: { at: "", ageMs: 0, refreshing: false, ttlMs: 0 }, calls: { file: "", exists: false, status: "none", lines: 0, unreadableLines: 0, readAt: "" },
});

function tree(s: CodeTreeOk["structure"], files: string[], extra: Partial<CodeTreeOk> = {}): CodeTreeOk {
  return {
    status: "ok", project: "p", top: "/r", packageDir: "/r/pkg", packageRel: "pkg", commit: { ref: "origin/main", sha: "a".repeat(40), date: null, why: "" },
    files, filesFrom: "git ls-tree", structure: s,
    agents: { status: "ok", registry: "/reg", total: 0, running: 0, agents: [] },
    traps: { status: "ok", dir: "/r/.anvi", errors: [], cites: 0, placed: [], elsewhere: 0, ambiguousCites: 0, ambiguous: [] },
    editRule: "rule", ...extra,
  };
}

describe("markers are joined from the sources' own answers", () => {
  const edges = [
    edge("src/engine/x.ts", "src/monaco/m.ts", "grandfathered"),
    edge("src/engine/x.ts", "src/monaco/n.ts", "new"),
    edge("src/engine/y.ts", "src/engine/x.ts", "internal", "grandfathered"),
    edge("src/engine/y.ts", "src/engine/z.ts", "allowed"),
    edge("src/engine/z.ts", "src/x/q.ts", "internal"),
    edge("src/engine/z.ts", "src/other/w.ts", "allowed"),
  ];
  const files = ["src/engine/x.ts", "src/engine/y.ts", "src/engine/z.ts"];

  test("every edge the rules break is a ◆, on its importing file; allowed and internal edges are not", () => {
    const m = marks(tree(structure(edges), files), refusalsSource(measured([]), null));
    expect(breakingEdges(structure(edges)).length).toBe(3);
    expect(m.counts.breaking).toBe(3);
    expect(m.counts.breakingFiles).toBe(2);
    expect(m.byFile.get("src/engine/x.ts")!.divergent.length).toBe(2);
    expect(m.byFile.get("src/engine/z.ts")?.divergent.length ?? 0).toBe(0);
  });

  test("every refusal is a ✕ on its file, or listed apart when the file is not at the commit; the count is the answer's", () => {
    const rs = [refusal("src/engine/x.ts", "k1"), refusal("src/engine/x.ts", "k2"), refusal("src/engine/gone.ts", "k3")];
    const m = marks(tree(structure(edges), files), refusalsSource(measured(rs), null));
    expect(m.counts.refusals).toBe(rs.length);
    expect(m.counts.refusedFiles).toBe(2);
    expect(m.byFile.get("src/engine/x.ts")!.refused.map((r) => r.key)).toEqual(["k1", "k2"]);
    expect(m.refusedElsewhere.map((r) => r.key)).toEqual(["k3"]);
  });

  test("refusals still being measured, unreadable or not measured never count as zero", () => {
    const answers: (RefusalsResponse | null)[] = [
      null,
      { status: "measuring", project: "p", package: "/r", window: { since: "", until: null, chosenBy: "" }, startedAt: "2026-11-05T12:00:00Z" },
      { status: "unreadable", project: "p", reason: "boom" },
      { status: "not-measured", project: "p", reason: "no edit" },
    ];
    for (const a of answers) {
      const src = refusalsSource(a, null);
      const m = marks(tree(structure(edges), files), src);
      expect(m.counts.refusals).toBeNull();
      expect(countsLine(m, src, tree(structure(edges), files), null)[0]).not.toMatch(/^0 /);
    }
    expect(refusalsSource(null, "500").state).toBe("unreadable");
    // The reason already names what it is about: said once, not "refused edits: refused edits: …".
    const measuring = refusalsSource(answers[1], null);
    const line = countsLine(marks(tree(structure(edges), files), measuring), measuring, tree(structure(edges), files), null)[0];
    expect(line).toStartWith("refused edits: anvi's structure-refusals.js");
    expect(line).not.toContain("refused edits: refused edits");
  });

  test("catalogues only partly read: the citations are 'at least', and what could not be read is said", () => {
    const t = tree(structure(edges), files, { traps: { status: "partial", dir: "/p/.anvi", errors: ["hetvabhasa.md: EACCES"], cites: 0, placed: [], elsewhere: 0, ambiguousCites: 0, ambiguous: [] } });
    const src = refusalsSource(null, null);
    const line = countsLine(marks(t, src), src, t, null)[3];
    expect(line).toStartWith("at least 0 known-trap citations");
    expect(line).toContain("hetvabhasa.md: EACCES");
    expect(line).toContain("could not be read");
    // A whole read says neither.
    const ok = countsLine(marks(tree(structure(edges), files), src), src, tree(structure(edges), files), null)[3];
    expect(ok).toStartWith("0 known-trap citations");
    expect(ok).not.toContain("could not be read");
  });

  test("no design: no ◆ count, said as nothing judged", () => {
    const nd: StructureNoDesign = { status: "no-design", project: "p", path: "/r", label: "nothing blocked", refAsked: null, refChosenBy: "", measuredAt: { ref: "m", sha: "a".repeat(40) }, treeFrom: "git", folders: [], files: 1, timing: { cache: "hit", ms: 0 } };
    const t = tree(nd, files);
    const m = marks(t, refusalsSource({ status: "no-design", project: "p", reason: "no package" }, null));
    expect(m.counts.breaking).toBeNull();
    expect(countsLine(m, refusalsSource(null, null), t, null)[1]).toContain("nothing is judged");
  });

  test("agents' edits and citations are placed on their files; an agent host that is off is not 0", () => {
    const t = tree(structure([]), files, {
      agents: { status: "ok", registry: "/reg", total: 2, running: 1, agents: [{ id: "a1", status: "working", running: true, cwd: "/w", prompt: "p", edits: [{ file: "src/engine/y.ts", abs: "/w/pkg/src/engine/y.ts", tool: "Edit", at: "t" }] }] },
      traps: { status: "ok", dir: "/r/.anvi", errors: [], cites: 1, placed: [{ catalogue: "hetvabhasa", kind: "error pattern", entryId: "P1", title: "t", field: "REF", cite: "x.ts:2", file: "src/engine/x.ts", lines: [2] }], elsewhere: 0, ambiguousCites: 0, ambiguous: [] },
    });
    const m = marks(t, refusalsSource(null, null));
    expect(m.counts.touchedFiles).toBe(1);
    expect(m.byFile.get("src/engine/y.ts")!.touched[0].agent).toBe("a1");
    expect(m.counts.trapFiles).toBe(1);
    const off = marks(tree(structure([]), files, { agents: { status: "off", reason: "no host", registry: null, total: 0, running: 0, agents: [] } }), refusalsSource(null, null));
    expect(off.counts.touchedFiles).toBeNull();
  });

  test("folders count the marked files below them; the first file shown is a refused one", () => {
    const rs = [refusal("src/engine/y.ts", "k1")];
    const m = marks(tree(structure(edges), files), refusalsSource(measured(rs), null));
    const root = buildTree(files, m);
    const engine = root.dirs[0].dirs[0];
    expect([engine.path, engine.refused, engine.divergent]).toEqual(["src/engine", 1, 2]);
    expect(defaultFile(files, m)).toBe("src/engine/y.ts");
    expect(defaultFile(files, marks(tree(structure(edges), files), refusalsSource(null, null)))).toBe("src/engine/x.ts");
  });
});

describe("lines", () => {
  test("a relative import resolves the way TypeScript reads it", () => {
    expect(resolveSpec("src/engine/x.ts", "../monaco/m")).toContain("src/monaco/m.ts");
    expect(resolveSpec("src/engine/x.ts", "./dir")).toContain("src/engine/dir/index.ts");
    expect(resolveSpec("src/engine/x.ts", "../monaco/m.js")).toContain("src/monaco/m.ts");
    expect(resolveSpec("src/engine/x.ts", "react")).toEqual([]);
  });

  test("the import line of an edge is found, including the last line of a multi-line import", () => {
    const text = "import { a } from './a';\nimport {\n  b,\n} from '../monaco/m';\nconst c = await import('./c');\n";
    expect(importLines(text, "src/engine/x.ts", "src/monaco/m.ts")).toEqual([4]);
    expect(importLines(text, "src/engine/x.ts", "src/engine/c.ts")).toEqual([5]);
    expect(importLines(text, "src/engine/x.ts", "src/engine/zz.ts")).toEqual([]);
  });

  test("a refused import that never landed is kept aside, not put on a line; a trap past the end too", () => {
    const text = "import { m } from '../monaco/m';\nexport const x = 1;\n";
    const fm = {
      refused: [refusal("src/engine/x.ts", "k1", "src/monaco/other.ts")],
      divergent: [edge("src/engine/x.ts", "src/monaco/m.ts", "grandfathered")],
      touched: [],
      traps: [{ catalogue: "hetvabhasa", kind: "error pattern", entryId: "P1", title: "t", field: "REF", cite: "x.ts:2", file: "src/engine/x.ts", lines: [2, 99] }],
    };
    const lm = lineMarks(text, "src/engine/x.ts", fm);
    expect(gutterOf(lm.byLine.get(1))?.glyph).toBe("◆");
    expect(gutterOf(lm.byLine.get(2))?.glyph).toBe("▲");
    expect(lm.unplaced.map((u) => u.kind)).toEqual(["refused"]);
    // When the refused target is imported on a line, the line carries ✕ above ◆.
    const lm2 = lineMarks(text, "src/engine/x.ts", { ...fm, refused: [refusal("src/engine/x.ts", "k2", "src/monaco/m.ts")] });
    expect(gutterOf(lm2.byLine.get(1))?.glyph).toBe("✕");
  });
});

describe("catalogue citations", () => {
  test("citations of one line, a range and a list are read; URLs are not", () => {
    expect(citesIn("see `StrudelEngine.ts:445` and src/a/b.tsx:3-5, c.ts:7,9 http://x.com:80").map((c) => [c.path, c.lines])).toEqual([
      ["StrudelEngine.ts", [445]], ["src/a/b.tsx", [3, 4, 5]], ["c.ts", [7, 9]],
    ]);
  });

  test("placed only on the one file a citation can name; ambiguous and outside ones are counted, and the parts sum", () => {
    const cat: Catalogue = { name: "hetvabhasa", path: "/r/.anvi/hetvabhasa.md", lastModified: new Date(), entries: [
      { id: "P1", title: "one", sections: { REF: "`engine/x.ts:4`; `util.ts:1`; `other/q.ts:2`; `missing.ts:3`" }, tags: [], grounded: true },
    ] } as unknown as Catalogue;
    const repoFiles = ["pkg/src/engine/x.ts", "pkg/src/util.ts", "pkg/src/b/util.ts", "other/q.ts"];
    const r = placeCites([cat], repoFiles, "pkg");
    expect(r.placed.map((p) => [p.file, p.lines, p.kind])).toEqual([["src/engine/x.ts", [4], "error pattern"]]);
    expect(r.ambiguous).toEqual([{ cite: "util.ts:1", candidates: 2 }]);
    expect(r.elsewhere).toBe(2);
    expect(r.placed.length + r.elsewhere + r.ambiguousCites).toBe(r.cites);
  });
});

describe("the reads", () => {
  test("paths: no climbing out, no absolute, no empty part", () => {
    for (const bad of ["../a", "/a", "a//b", "a/./b", "", "a\\b", "a\0b"]) expect(cleanRelPath(bad)).toBeNull();
    expect(cleanRelPath("src/a.ts")).toBe("src/a.ts");
  });

  test("git blame --porcelain gives each line its commit, and each commit once", () => {
    const d = scratch();
    git(d, "init", "-q", "-b", "main");
    writeFileSync(join(d, "f.ts"), "one\ntwo\n");
    git(d, "add", ".");
    git(d, "commit", "-q", "-m", "first");
    writeFileSync(join(d, "f.ts"), "one\nTWO\nthree\n");
    git(d, "commit", "-qam", "second");
    const head = git(d, "rev-parse", "HEAD");
    const b = parseBlame(git(d, "blame", "--porcelain", head, "--", "f.ts"));
    expect(b.lines.length).toBe(3);
    expect(b.lines[1]).toBe(head);
    expect(b.lines[0]).not.toBe(head);
    expect(Object.values(b.commits).map((c) => c.summary).sort()).toEqual(["first", "second"]);
    expect(b.commits[head].author).toBe("Tess");
  });

  test("the tree is the package's files at the design reader's commit, never the working tree", async () => {
    const d = scratch();
    git(d, "init", "-q", "-b", "main");
    mkdirSync(join(d, "pkg", "src"), { recursive: true });
    writeFileSync(join(d, "pkg", "src", "x.ts"), "x");
    writeFileSync(join(d, "top.md"), "t");
    git(d, "add", ".");
    git(d, "commit", "-q", "-m", "c");
    const sha = git(d, "rev-parse", "HEAD");
    writeFileSync(join(d, "pkg", "src", "uncommitted.ts"), "u");
    const s = structure([]);
    s.package.dir = join(d, "pkg");
    s.measuredAt.sha = sha;
    const { response } = await readCodeTree("p", { structure: async () => s, agents: () => ({ status: "ok", registry: "/r", total: 0, running: 0, agents: [] }) });
    expect(response.status).toBe("ok");
    const ok = response as CodeTreeOk;
    expect([ok.packageRel, ok.files]).toEqual(["pkg", ["src/x.ts"]]);
    expect(ok.commit.sha).toBe(sha);
  });

  test("a design reader that could not measure is said, not shown as an empty tree", async () => {
    const { response } = await readCodeTree("p", { structure: async () => ({ status: "could-not-read", project: "p", refAsked: null, reason: "cannot read the design" }) });
    expect(response).toEqual(expect.objectContaining({ status: "could-not-read", reason: "cannot read the design" }));
  });
});

describe("GET /api/refusals for one file, and over all time (#193)", () => {
  test("?file= keeps that file's refusals and says what it filtered by", () => {
    const r = measured([refusal("src/a.ts", "k1"), refusal("src/b.ts", "k2")]);
    const f = onlyFile(r, "src/a.ts") as RefusalsMeasured & { filter: { file: string; refusals: number; ofRefusals: number } };
    expect(f.refusals.map((x) => x.key)).toEqual(["k1"]);
    expect(f.filter).toEqual(expect.objectContaining({ file: "src/a.ts", refusals: 1, ofRefusals: 2 }));
    expect(onlyFile(r, null)).toBe(r);
  });

  test("?file= on an answer not measured yet gives no counts (null), never 0, and says why", () => {
    const answers: RefusalsResponse[] = [
      { status: "measuring", project: "p", package: "/r", window: { since: "", until: null, chosenBy: "" }, startedAt: "2026-11-05T12:00:00Z" },
      { status: "unreadable", project: "p", reason: "boom" },
      { status: "not-measured", project: "p", reason: "no edit" },
    ];
    for (const a of answers) {
      const f = onlyFile(a, "src/a.ts") as RefusalsResponse & { filter: { refusals: number | null; ofRefusals: number | null; totalsAre: string } };
      expect(f.filter.refusals).toBeNull();
      expect(f.filter.ofRefusals).toBeNull();
      expect(f.status).toBe(a.status);
      expect(f.filter.totalsAre).toContain(a.status);
    }
  });

  test("?since=all is every refusal the transcripts hold, and says so", () => {
    expect(windowOf("all", null)).toEqual({ since: ALL_TIME, until: null, chosenBy: "all time (?since=all)" });
    expect(windowOf(null, null).chosenBy).toContain("30 days");
  });
});

describe("the head says why a file is read-only", () => {
  const w = (o: Partial<WorkingFile>): WorkingFile => ({ project: "p", path: "src/a.ts", abs: "/r/src/a.ts", text: "", hash: "h", bytes: 0, touching: [], editable: true, rule: "r", readAt: "t", ...o });
  test("off, editable, and each kind of read-only", () => {
    expect(editState(false, null)).toBe("read-only while agents work");
    expect(editState(true, { state: "ok", value: w({}) })).toBe("editing the working copy in /r");
    expect(editState(true, { state: "ok", value: w({ editable: false, touching: [{ id: "ag-1", status: "working", why: "edited this file", detail: "d" }] }) })).toBe("read-only: edited this file (ag-1)");
    expect(editState(true, { state: "ok", value: w({ editable: false, reason: "host off" }) })).toBe("read-only: host off");
    expect(editState(true, { state: "error", error: "404" })).toBe("read-only: 404");
  });
});

describe("editing belongs to the desktop window (#241, #244)", () => {
  const w = { project: "p", path: "src/a.ts", abs: "/r/src/a.ts", text: "x", hash: "h", bytes: 1, touching: [], editable: true, rule: "r", readAt: "t" } as unknown as WorkingFile;

  test("in a browser a free file is read-only and says why, before anything is typed", () => {
    const here = workingHere(w, false, "only the app acts");
    expect(here.editable).toBe(false);
    expect(editState(true, { state: "ok", value: here })).toBe("read-only: only the app acts");
  });

  test("in the window a free file stays editable", () => {
    expect(workingHere(w, true, "only the app acts")).toBe(w);
  });

  test("a file an agent holds keeps its own reason, in the window and out of it", () => {
    const held = { ...w, editable: false, reason: "an agent is working on it" };
    expect(workingHere(held, false, "only the app acts").reason).toBe("an agent is working on it");
  });
});

describe("a long file is painted in chunks (#251)", () => {
  test("up to the limit it is one chunk, so every line is painted", () => {
    expect(lineChunks(WHOLE_FILE_LINES)).toEqual([{ start: 0, end: WHOLE_FILE_LINES }]);
    expect(lineChunks(1)).toEqual([{ start: 0, end: 1 }]);
    expect(lineChunks(0)).toEqual([]);
  });

  test("past it, every line is in exactly one chunk, and in order", () => {
    for (const count of [WHOLE_FILE_LINES + 1, CHUNK_LINES * 8, 50_000, 50_001]) {
      const chunks = lineChunks(count);
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks[0].start).toBe(0);
      expect(chunks[chunks.length - 1].end).toBe(count);
      chunks.forEach((c, i) => {
        expect(c.end).toBeGreaterThan(c.start);
        expect(c.end - c.start).toBeLessThanOrEqual(CHUNK_LINES);
        if (i) expect(c.start).toBe(chunks[i - 1].end);
      });
    }
  });

  test("the blame column names a commit only where it changes, whichever line is painted first", () => {
    const shas = ["a", "a", "b", "b", "a"];
    expect(shas.map((_, i) => blameLabelAt(shas, i))).toEqual(["a", null, "b", null, "a"]);
    // A chunk starting at line 3 (index 2) and one starting mid-run at index 3 answer the same out of order.
    expect(blameLabelAt(shas, 3)).toBeNull();
    expect(blameLabelAt(shas, 2)).toBe("b");
    expect(blameLabelAt(undefined, 0)).toBeNull();
    expect(blameLabelAt([""], 0)).toBeNull();
  });
});
