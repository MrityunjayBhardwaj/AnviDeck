/**
 * Map model (issue #19): pure functions that turn the guard's graph (#16) and
 * a replay (#15) into what the Map draws. No DOM here, so tests can run it.
 *
 * Nothing in this file measures imports itself: every module, edge and class
 * comes from GET /api/structure/:project, which runs anvi's structure guard.
 */
import type {
  EdgeClass,
  StructureEdge,
  StructureMeasured,
  StructureNoDesign,
} from "../../shared/structure-types";
import type { ChangedFile, ReplayResponse, ReplayStep } from "../../shared/replay-types";

// ── Layout ────────────────────────────────────────────────────────────────

export const CELL_W = 64;
export const CELL_H = 15;
const BLOCK_PAD = 8;
const BLOCK_HEAD = 30;
const BLOCK_GAP = 56;
const ROW_GAP = 86;
const MAX_ROW_W = 1500;

export interface FileCell {
  /** the guard's module path, e.g. "src/engine/HapStream.ts" */
  path: string;
  /** path inside the component, e.g. "engine/HapStream.ts" */
  rel: string;
  block: string;
  x: number;
  y: number;
  cx: number;
  cy: number;
}

export interface Block {
  id: string;
  /** "component" = a design component (a guardrail); "folder" = no design, a folder only; "outside" = modules outside every component */
  kind: "component" | "folder" | "outside";
  x: number;
  y: number;
  w: number;
  h: number;
  cols: number;
  count: number;
  cells: FileCell[];
  /** for folders: sub-folders and their file counts, as the reader gives them */
  subfolders?: { path: string; total: number }[];
  layer: number;
}

export interface MapLayout {
  blocks: Block[];
  byId: Map<string, Block>;
  cellByPath: Map<string, FileCell>;
  width: number;
  height: number;
}

/**
 * Rows from the declared pairs: a component sits above everything it may use.
 * Layer = longest chain of "uses" from a component nobody uses. Components in
 * no declared pair go in a last row of their own. A cycle in the pairs cannot
 * loop forever: relaxation stops after one pass per component.
 */
export function layerComponents(names: string[], allowedPairs: string[]): Map<string, number> {
  const pairs: [string, string][] = [];
  for (const p of allowedPairs) {
    const m = /^\s*(.+?)\s*->\s*(.+?)\s*$/.exec(p);
    if (m && names.includes(m[1]) && names.includes(m[2]) && m[1] !== m[2]) pairs.push([m[1], m[2]]);
  }
  const inPair = new Set(pairs.flat());
  const layer = new Map<string, number>();
  for (const n of names) if (inPair.has(n)) layer.set(n, 0);
  for (let i = 0; i < names.length; i++) {
    let changed = false;
    for (const [a, b] of pairs) {
      const want = (layer.get(a) ?? 0) + 1;
      if (want > (layer.get(b) ?? 0) && want < names.length) {
        layer.set(b, want);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const maxLayer = Math.max(-1, ...layer.values());
  for (const n of names) if (!inPair.has(n)) layer.set(n, maxLayer + 1);
  return layer;
}

function placeRows(blocks: Block[]): { width: number; height: number } {
  const byLayer = new Map<number, Block[]>();
  for (const b of blocks) {
    const l = byLayer.get(b.layer) ?? [];
    l.push(b);
    byLayer.set(b.layer, l);
  }
  // Wrap a wide layer onto more rows.
  const rows: Block[][] = [];
  for (const l of [...byLayer.keys()].sort((a, b) => a - b)) {
    let row: Block[] = [];
    let w = 0;
    for (const b of byLayer.get(l)!.sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))) {
      if (row.length && w + BLOCK_GAP + b.w > MAX_ROW_W) {
        rows.push(row);
        row = [];
        w = 0;
      }
      w += (row.length ? BLOCK_GAP : 0) + b.w;
      row.push(b);
    }
    if (row.length) rows.push(row);
  }
  const rowW = (r: Block[]) => r.reduce((s, b) => s + b.w, 0) + BLOCK_GAP * (r.length - 1);
  const width = Math.max(0, ...rows.map(rowW));
  let y = 0;
  for (const r of rows) {
    let x = (width - rowW(r)) / 2;
    const h = Math.max(...r.map((b) => b.h));
    for (const b of r) {
      b.x = x;
      b.y = y;
      x += b.w + BLOCK_GAP;
    }
    y += h + ROW_GAP;
  }
  return { width, height: Math.max(0, y - ROW_GAP) };
}

function sizeBlock(n: number): { cols: number; w: number; h: number } {
  const cols = Math.max(2, Math.ceil(Math.sqrt(n * 1.7)));
  const rows = Math.max(1, Math.ceil(n / cols));
  return { cols, w: cols * CELL_W + BLOCK_PAD * 2, h: rows * CELL_H + BLOCK_HEAD + BLOCK_PAD };
}

function fillCells(b: Block, mods: { path: string; rel: string }[]) {
  b.cells = mods.map((m, j) => {
    const x = b.x + BLOCK_PAD + (j % b.cols) * CELL_W;
    const y = b.y + BLOCK_HEAD + Math.floor(j / b.cols) * CELL_H;
    return { path: m.path, rel: m.rel, block: b.id, x, y, cx: x + (CELL_W - 4) / 2, cy: y + (CELL_H - 3) / 2 };
  });
}

/** Lay out a measured package: one block per design component, one cell per module. */
export function layoutMeasured(m: StructureMeasured): MapLayout {
  const OUTSIDE = "(outside every component)";
  const groups = new Map<string, { path: string; rel: string }[]>();
  for (const mod of m.modules) {
    const k = mod.component ?? OUTSIDE;
    const g = groups.get(k) ?? [];
    g.push({ path: mod.path, rel: mod.rel });
    groups.set(k, g);
  }
  for (const g of groups.values()) g.sort((a, b) => a.rel.localeCompare(b.rel));
  const names = m.components.map((c) => c.name).filter((n) => groups.has(n));
  const layers = layerComponents(names, m.allowedPairs);
  const blocks: Block[] = [];
  for (const [id, mods] of groups) {
    const s = sizeBlock(mods.length);
    blocks.push({
      id,
      kind: id === OUTSIDE ? "outside" : "component",
      x: 0,
      y: 0,
      w: s.w,
      h: s.h,
      cols: s.cols,
      count: mods.length,
      cells: [],
      layer: id === OUTSIDE ? 999 : layers.get(id) ?? 998,
    });
  }
  const size = placeRows(blocks);
  for (const b of blocks) fillCells(b, groups.get(b.id)!);
  return finish(blocks, size);
}

/** Lay out a project with no design: one dashed block per top-level folder. */
export function layoutFolders(nd: StructureNoDesign): MapLayout {
  const top = new Map<string, { total: number; subs: { path: string; total: number }[] }>();
  for (const f of nd.folders) {
    if (f.path === ".") continue;
    const head = f.path.split("/")[0];
    const t = top.get(head) ?? { total: 0, subs: [] };
    if (f.path === head) t.total = f.total;
    else if (f.path.split("/").length === 2) t.subs.push({ path: f.path.slice(head.length + 1), total: f.total });
    top.set(head, t);
  }
  const root = nd.folders.find((f) => f.path === ".");
  if (root && root.files > 0) top.set("(top level)", { total: root.files, subs: [] });
  const blocks: Block[] = [];
  for (const [id, t] of top) {
    const lines = Math.max(1, Math.min(t.subs.length, 8));
    const w = 230;
    const h = BLOCK_HEAD + lines * CELL_H + BLOCK_PAD + (t.subs.length > 8 ? CELL_H : 0);
    blocks.push({
      id,
      kind: "folder",
      x: 0,
      y: 0,
      w,
      h,
      cols: 1,
      count: t.total,
      cells: [],
      subfolders: t.subs.sort((a, b) => b.total - a.total),
      layer: 0,
    });
  }
  // Folders have no layers: wrap them in rows, biggest first.
  const size = placeRows(blocks);
  return finish(blocks, size);
}

function finish(blocks: Block[], size: { width: number; height: number }): MapLayout {
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const cellByPath = new Map<string, FileCell>();
  for (const b of blocks) for (const c of b.cells) cellByPath.set(c.path, c);
  return { blocks, byId, cellByPath, width: size.width, height: size.height };
}

// ── Block-level edges ─────────────────────────────────────────────────────

export interface BlockEdge {
  from: string;
  to: string;
  total: number;
  byClass: Record<EdgeClass, number>;
  /** the design declares this pair */
  declared: boolean;
}

const emptyByClass = (): Record<EdgeClass, number> => ({ internal: 0, allowed: 0, grandfathered: 0, new: 0, unmapped: 0 });

/**
 * One arrow per component pair that has imports between components, with the
 * guard's class counts; plus every declared pair no import uses (an absence),
 * so "what the design allows" is drawn even where nothing uses it yet.
 */
export function blockEdges(m: StructureMeasured): BlockEdge[] {
  const agg = new Map<string, BlockEdge>();
  const declared = new Set(m.allowedPairs.map((p) => p.replace(/\s+/g, "")));
  for (const e of m.edges) {
    const a = e.fromComponent ?? "(outside every component)";
    const b = e.toComponent ?? "(outside every component)";
    if (a === b) continue;
    const k = `${a} -> ${b}`;
    const be = agg.get(k) ?? { from: a, to: b, total: 0, byClass: emptyByClass(), declared: declared.has(`${a}->${b}`) };
    be.total++;
    be.byClass[e.class]++;
    agg.set(k, be);
  }
  for (const p of m.allowedPairs) {
    const mm = /^\s*(.+?)\s*->\s*(.+?)\s*$/.exec(p);
    if (!mm) continue;
    const k = `${mm[1]} -> ${mm[2]}`;
    if (!agg.has(k)) agg.set(k, { from: mm[1], to: mm[2], total: 0, byClass: emptyByClass(), declared: true });
  }
  return [...agg.values()];
}

/** What the design says a block may use and who may use it, with the edge notes. */
export function blockRules(m: StructureMeasured, block: string) {
  const parse = (p: string) => /^\s*(.+?)\s*->\s*(.+?)\s*$/.exec(p);
  const mayUse: string[] = [];
  const usedBy: string[] = [];
  for (const p of m.allowedPairs) {
    const mm = parse(p);
    if (!mm) continue;
    if (mm[1] === block) mayUse.push(mm[2]);
    if (mm[2] === block) usedBy.push(mm[1]);
  }
  const notes: { pair: string; note: string }[] = [];
  for (const [pair, note] of Object.entries(m.edgeNotes ?? {})) {
    const mm = parse(pair);
    if (mm && (mm[1] === block || mm[2] === block)) notes.push({ pair, note });
  }
  const comp = m.components.find((c) => c.name === block);
  const breaks = m.edges.filter(
    (e) => (e.fromComponent === block || e.toComponent === block) && (e.class === "grandfathered" || e.class === "new")
  );
  return { mayUse: mayUse.sort(), usedBy: usedBy.sort(), notes, why: comp?.why ?? null, dirs: comp?.dirs ?? [], breaks };
}

/** A file's imports (out) and importers (in), as the guard's edges give them. */
export function fileImports(m: StructureMeasured, path: string): { out: StructureEdge[]; inn: StructureEdge[] } {
  return { out: m.edges.filter((e) => e.from === path), inn: m.edges.filter((e) => e.to === path) };
}

// ── Replay → files on the map ─────────────────────────────────────────────

/** The last two folders of the package dir, e.g. "packages/editor", used to tie paths in other checkouts to it. */
export function packageTail(dir: string): string {
  return dir.replace(/\/+$/, "").split("/").slice(-2).join("/");
}

/**
 * A path from a replay (absolute, maybe in another worktree; or repo-relative
 * from a commit) → the guard's module path, when it is one of the package's
 * modules. Matching is by suffix "<package tail>/<module path>", so
 * stave-wt-2264/packages/editor/src/x.ts maps to stave's src/x.ts.
 */
export function moduleForPath(p: string, modulePaths: Set<string>, tail: string): string | null {
  const norm = "/" + p.replace(/\\/g, "/").replace(/^\/+/, "");
  const marker = `/${tail}/`;
  const i = norm.lastIndexOf(marker);
  if (i < 0) return null;
  const rest = norm.slice(i + marker.length);
  return modulePaths.has(rest) ? rest : null;
}

/**
 * Module paths a shell command names, by text. A guess, labelled as one: the
 * command may only read the file. A module matches by its full path
 * ("src/engine/x.ts") or its path inside src ("engine/x.ts"), only when the
 * text before it is a start, space, quote, "=" or "(" — so "index.ts" does
 * not match inside "codeView/index.ts".
 */
export function modulesNamedInCommand(command: string, modules: { path: string; rel: string }[]): string[] {
  const out = new Set<string>();
  const boundary = (i: number) => i === 0 || /[\s'"=(]/.test(command[i - 1]);
  for (const m of modules) {
    for (const form of [m.path, m.path.replace(/^src\//, "")]) {
      let i = command.indexOf(form);
      while (i >= 0) {
        const after = command[i + form.length];
        if (boundary(i) && (after === undefined || !/[\w.\/-]/.test(after))) {
          out.add(m.path);
          break;
        }
        i = command.indexOf(form, i + 1);
      }
    }
  }
  return [...out].sort();
}

export type TouchHow = "tool" | "shell-guess" | "commit";

export interface StepTouch {
  seq: number;
  /** module paths on the map this step touched */
  modules: string[];
  how: TouchHow | null;
  /** the step writes through the shell (the replay's own guess, scope "project") */
  shellWrite: boolean;
  /** for shell writes: the replay's design-rules label for those files, or "not confirmed" */
  designRules: string | null;
  notesGap: string | null;
  /** the file paths named, when none of them is on the map */
  offMap: string[];
}

/** For each step: which files on the map it touched, and how we know. */
export function stepTouches(r: ReplayResponse, m: StructureMeasured): StepTouch[] {
  const tail = packageTail(m.package.dir);
  const paths = new Set(m.modules.map((x) => x.path));
  const changeByModule = new Map<string, ChangedFile>();
  const shellChangesOffMap = new Map<string, ChangedFile>(); // path inside the package → change
  for (const f of r.changes?.files ?? []) {
    const mod = moduleForPath(f.path, paths, tail);
    if (mod) changeByModule.set(mod, f);
    else if (f.viaShell) {
      const norm = "/" + f.path.replace(/^\/+/, "");
      const i = norm.lastIndexOf(`/${tail}/`);
      if (i >= 0) shellChangesOffMap.set(norm.slice(i + tail.length + 2), f);
    }
  }
  const commitBySha = new Map(r.commits.map((c) => [c.sha, c]));
  return r.steps.map((s) => {
    const t: StepTouch = { seq: s.seq, modules: [], how: null, shellWrite: false, designRules: null, notesGap: null, offMap: [] };
    if (s.filePath) {
      const mod = moduleForPath(s.filePath, paths, tail);
      if (mod) {
        t.modules = [mod];
        t.how = "tool";
      } else t.offMap = [s.filePath];
    } else if (s.kind === "commit" && s.sha) {
      const c = commitBySha.get(s.sha) ?? r.commits.find((x) => x.sha.startsWith(s.sha!));
      if (c) {
        t.modules = [...new Set(c.files.map((f) => moduleForPath(f.path, paths, tail)).filter((x): x is string => !!x))].sort();
        t.how = t.modules.length ? "commit" : null;
      }
    } else if (s.command) {
      t.shellWrite = s.mayEditFiles?.scope === "project";
      if (t.shellWrite) {
        t.modules = modulesNamedInCommand(s.command, m.modules);
        t.how = t.modules.length ? "shell-guess" : null;
        // The replay's labels for the files this command names: map modules, and also changed
        // files the guard's graph does not hold (a test file, say), matched by their package path.
        const labels = t.modules.map((x) => changeByModule.get(x)).filter((c): c is ChangedFile => !!c && c.viaShell);
        for (const [inPkg, c] of shellChangesOffMap) {
          if (modulesNamedInCommand(s.command, [{ path: inPkg, rel: inPkg }]).length) {
            labels.push(c);
            t.offMap.push(inPkg);
          }
        }
        t.designRules = labels.find((c) => c.designRules)?.designRules ?? "not confirmed";
        t.notesGap = labels.find((c) => c.notesGap)?.notesGap ?? null;
      }
    }
    return t;
  });
}

/** Where the agent is at step `at`: the last file touched, and every file touched so far, in order. */
export function agentAt(touches: StepTouch[], at: number): { last: string | null; trail: string[]; lastSeq: number | null } {
  const trail: string[] = [];
  let last: string | null = null;
  let lastSeq: number | null = null;
  for (const t of touches) {
    if (t.seq > at) break;
    for (const mod of t.modules) {
      if (!trail.includes(mod)) trail.push(mod);
      last = mod;
      lastSeq = t.seq;
    }
  }
  return { last, trail, lastSeq };
}

/** The order the agent entered blocks, up to step `at` (consecutive repeats folded). */
export function blockFlow(touches: StepTouch[], at: number, blockOf: (mod: string) => string | null): string[] {
  const out: string[] = [];
  for (const t of touches) {
    if (t.seq > at) break;
    for (const mod of t.modules) {
      const b = blockOf(mod);
      if (b && out[out.length - 1] !== b) out.push(b);
    }
  }
  return out;
}

/** The time a step sits at, as the replay placed it. */
export function stepTime(s: ReplayStep | undefined): string | null {
  return s ? s.placedAt ?? s.ts : null;
}
