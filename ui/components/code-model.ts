/**
 * Project · Code (#88): the rules of the screen, apart from the DOM so the tests can pin them.
 *
 * The markers come from two answers every screen reads, never from a count of their own:
 *   ✕ refused edit     — GET /api/refusals (anvi's structure-refusals.js): one per refusal, on its file;
 *   ◆ divergent import — the design reader's edges (GET /api/structure, carried in GET /api/code):
 *                        every edge the guard's rules break (a divergence the baseline holds or does
 *                        not, or an edge on a cycle), on the importing file;
 *   ● agent touched    — AnviDeck's agents' Write/Edit calls, from the agent host's registry;
 *   ▲ known trap       — a catalogue entry that cites `<file>:<line>`.
 * A source that could not be read says so; it never shows as no markers.
 */
import type { CodeTreeOk, TrapCite, AgentEdit, EditResult, WorkingFile } from "../../shared/code-types";
import type { Refusal, RefusalsResponse } from "../../shared/refusal-types";
import type { StructureEdge, StructureMeasured } from "../../shared/structure-types";

/** The prototype's layer colours, by name, then a palette for the rest (in the design's order). */
const NAMED: Record<string, string> = { engine: "#5aa9f5", model: "#3ccf91", monaco: "#f2b84b", visualEdit: "#c792ea", codeView: "#8f7ef7", workspace: "#9aa4b8" };
const PALETTE = ["#3ccf91", "#f0a07a", "#4fd1c5", "#e879a6", "#b5c45a", "#f6c177", "#7fb3ff", "#d19af0", "#9ccfd8", "#e6b450", "#a3be8c", "#ff8f8f"];
export const UNMAPPED_COLOR = "#4a4a5e";

export function layerColors(components: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const used = new Set<string>();
  for (const c of components) if (NAMED[c]) (out[c] = NAMED[c]), used.add(NAMED[c]);
  const free = PALETTE.filter((p) => !used.has(p));
  let i = 0;
  for (const c of components) if (!out[c]) out[c] = free[i++ % free.length];
  return out;
}

export type Source<T> = { state: "ok"; value: T; note?: string } | { state: "waiting" | "unreadable" | "none"; text: string };

/** The refusals answer as the markers can use it: only "measured" gives markers. */
export function refusalsSource(r: RefusalsResponse | null, error: string | null): Source<Refusal[]> {
  if (error) return { state: "unreadable", text: `refused edits could not be read: ${error}` };
  if (!r) return { state: "waiting", text: "refused edits: reading…" };
  if (r.status === "measured") return { state: "ok", value: r.refusals };
  if (r.status === "measuring") return { state: "waiting", text: `refused edits: anvi's structure-refusals.js is reading every transcript (started ${r.startedAt.slice(11, 16)} UTC); this takes minutes` };
  if (r.status === "no-design") return { state: "none", text: r.reason };
  if (r.status === "not-measured") return { state: "unreadable", text: `refused edits not measured: ${r.reason}` };
  return { state: "unreadable", text: `refused edits could not be read: ${r.reason}` };
}

/** Every import the guard's rules break: a divergence (in the baseline or new) or an edge on a cycle. */
export function breakingEdges(s: StructureMeasured): StructureEdge[] {
  return s.edges.filter((e) => e.class === "grandfathered" || e.class === "new" || e.cycle !== null);
}

export interface FileMarks {
  refused: Refusal[];
  divergent: StructureEdge[];
  touched: { agent: string; running: boolean; edit: AgentEdit }[];
  traps: TrapCite[];
}

export interface Marks {
  byFile: Map<string, FileMarks>;
  /** Refusals whose file is not tracked at the commit shown (a file the refused edit would have made). */
  refusedElsewhere: Refusal[];
  counts: {
    refusals: number | null;
    refusedFiles: number | null;
    breaking: number | null;
    breakingFiles: number | null;
    touchedFiles: number | null;
    trapCites: number | null;
    trapFiles: number | null;
  };
}

const empty = (): FileMarks => ({ refused: [], divergent: [], touched: [], traps: [] });

/** Join the four sources onto the files. A count is null when its source gave no answer. */
export function marks(tree: CodeTreeOk, refusals: Source<Refusal[]>): Marks {
  const files = new Set(tree.files);
  const byFile = new Map<string, FileMarks>();
  const at = (f: string) => {
    let m = byFile.get(f);
    if (!m) byFile.set(f, (m = empty()));
    return m;
  };
  const refusedElsewhere: Refusal[] = [];
  if (refusals.state === "ok") for (const r of refusals.value) (files.has(r.file) ? at(r.file).refused.push(r) : refusedElsewhere.push(r));
  const s = tree.structure.status === "measured" ? tree.structure : null;
  const breaking = s ? breakingEdges(s) : null;
  for (const e of breaking ?? []) at(e.from).divergent.push(e);
  for (const a of tree.agents.agents) for (const e of a.edits) at(e.file).touched.push({ agent: a.id, running: a.running, edit: e });
  for (const t of tree.traps.placed) at(t.file).traps.push(t);
  const filesWith = (k: keyof FileMarks) => [...byFile.values()].filter((m) => m[k].length).length;
  const refusalsOk = refusals.state === "ok";
  return {
    byFile,
    refusedElsewhere,
    counts: {
      refusals: refusalsOk ? (refusals as { value: Refusal[] }).value.length : null,
      refusedFiles: refusalsOk ? new Set((refusals as { value: Refusal[] }).value.map((r) => r.file)).size : null,
      breaking: breaking ? breaking.length : null,
      breakingFiles: breaking ? new Set(breaking.map((e) => e.from)).size : null,
      touchedFiles: tree.agents.status === "off" ? null : filesWith("touched"),
      trapCites: tree.traps.status === "unreadable" ? null : tree.traps.placed.length,
      trapFiles: tree.traps.status === "unreadable" ? null : filesWith("traps"),
    },
  };
}

// ── the tree ────────────────────────────────────────────────────────────────────────────

export interface TreeNode {
  name: string;
  path: string;
  dirs: TreeNode[];
  files: { name: string; path: string }[];
  /** Files below with each marker. */
  refused: number;
  divergent: number;
  touched: number;
  traps: number;
}

export function buildTree(files: string[], m: Marks): TreeNode {
  const root: TreeNode = { name: "", path: "", dirs: [], files: [], refused: 0, divergent: 0, touched: 0, traps: 0 };
  for (const f of [...files].sort()) {
    const parts = f.split("/");
    let node = root;
    const fm = m.byFile.get(f);
    const bump = (n: TreeNode) => {
      if (!fm) return;
      if (fm.refused.length) n.refused++;
      if (fm.divergent.length) n.divergent++;
      if (fm.touched.length) n.touched++;
      if (fm.traps.length) n.traps++;
    };
    bump(root);
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join("/");
      let next = node.dirs.find((d) => d.name === parts[i]);
      if (!next) node.dirs.push((next = { name: parts[i], path, dirs: [], files: [], refused: 0, divergent: 0, touched: 0, traps: 0 }));
      node = next;
      bump(node);
    }
    node.files.push({ name: parts[parts.length - 1], path: f });
  }
  return root;
}

/** The folders shown open: those holding the file shown, and those with a refusal or a breaking import below. */
export function openFolders(root: TreeNode, selected: string | null): Set<string> {
  const open = new Set<string>([""]);
  if (selected) {
    const parts = selected.split("/");
    for (let i = 1; i < parts.length; i++) open.add(parts.slice(0, i).join("/"));
  }
  const walk = (n: TreeNode) => {
    for (const d of n.dirs) {
      if (d.refused) open.add(d.path);
      walk(d);
    }
  };
  walk(root);
  return open;
}

/** The file shown first: one with a refused edit, else a breaking import, else a known trap, else the first file. */
export function defaultFile(files: string[], m: Marks): string | null {
  const sorted = [...files].sort();
  return (
    sorted.find((f) => m.byFile.get(f)?.refused.length) ??
    sorted.find((f) => m.byFile.get(f)?.divergent.length) ??
    sorted.find((f) => m.byFile.get(f)?.traps.length) ??
    sorted[0] ??
    null
  );
}

// ── lines ───────────────────────────────────────────────────────────────────────────────

const SPEC_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+|^\s*export\s+\*\s+from\s*)['"]([^'"]+)['"]/g;
const EXTS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", "/index.ts", "/index.tsx", "/index.js"];

function joinPosix(dir: string, spec: string): string {
  const out: string[] = dir ? dir.split("/") : [];
  for (const p of spec.split("/")) {
    if (p === "" || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return out.join("/");
}

/** The files a relative module specifier in `file` can name (TypeScript's resolution, the common cases). */
export function resolveSpec(file: string, spec: string): string[] {
  if (!spec.startsWith(".")) return [];
  const base = joinPosix(file.split("/").slice(0, -1).join("/"), spec);
  const noJs = base.replace(/\.(m|c)?js$/, "");
  const out = new Set<string>();
  for (const b of [base, noJs]) for (const e of EXTS) out.add(b + e);
  return [...out];
}

/** The 1-based lines of `text` (the file `file`) whose import names `target`. */
export function importLines(text: string, file: string, target: string): number[] {
  const out: number[] = [];
  text.split("\n").forEach((l, i) => {
    for (const m of l.matchAll(SPEC_RE)) if (resolveSpec(file, m[1]).includes(target)) out.push(i + 1);
  });
  return [...new Set(out)];
}

export interface LineMark {
  kind: "refused" | "divergent" | "trap";
  edge?: StructureEdge;
  refusal?: Refusal;
  trap?: TrapCite;
}

/**
 * What each line carries. A refused import is placed on a line only when the line imports the
 * refused target (the refused edit itself never landed, so usually none does); a trap on a line
 * past the end of the file is kept aside, never moved.
 */
export function lineMarks(text: string, file: string, fm: FileMarks | undefined): { byLine: Map<number, LineMark[]>; unplaced: LineMark[] } {
  const byLine = new Map<number, LineMark[]>();
  const unplaced: LineMark[] = [];
  if (!fm) return { byLine, unplaced };
  const n = text.split("\n").length;
  const put = (line: number, m: LineMark) => {
    const l = byLine.get(line) ?? [];
    l.push(m);
    byLine.set(line, l);
  };
  for (const e of fm.divergent) {
    const at = importLines(text, file, e.to);
    if (at.length) at.forEach((l) => put(l, { kind: "divergent", edge: e }));
    else unplaced.push({ kind: "divergent", edge: e });
  }
  for (const r of fm.refused) {
    const targets = r.pairs.map((p) => p.key.split(" -> ")[1]).filter(Boolean);
    const at = [...new Set(targets.flatMap((t) => importLines(text, file, t)))];
    if (at.length) at.forEach((l) => put(l, { kind: "refused", refusal: r }));
    else unplaced.push({ kind: "refused", refusal: r });
  }
  for (const t of fm.traps) {
    const inside = t.lines.filter((l) => l <= n);
    if (inside.length) inside.forEach((l) => put(l, { kind: "trap", trap: t }));
    else unplaced.push({ kind: "trap", trap: t });
  }
  return { byLine, unplaced };
}

/** The strongest mark of a line, for its gutter: refused, then divergent, then trap. */
export function gutterOf(ms: LineMark[] | undefined): { glyph: string; cls: string } | null {
  if (!ms?.length) return null;
  if (ms.some((m) => m.kind === "refused")) return { glyph: "✕", cls: "bad" };
  if (ms.some((m) => m.kind === "divergent")) return { glyph: "◆", cls: "warn" };
  return { glyph: "▲", cls: "trap" };
}

/** "allowed rule break" for an edge the baseline holds; "new: the guard refuses it" otherwise. */
export function edgeVerdict(e: StructureEdge): { text: string; tone: "warn" | "bad" } {
  if (e.class === "new" || e.cycle === "new") return { text: "not allowed by the design: the guard refuses it", tone: "bad" };
  if (e.cycle === "grandfathered" && e.class !== "grandfathered") return { text: "on a cycle the baseline holds (allowed rule break)", tone: "warn" };
  return { text: "allowed rule break: the baseline holds it", tone: "warn" };
}

// ── editing ─────────────────────────────────────────────────────────────────────────────

/** The body of a Save: over the file as the page last knew it (its path and sha256). */
export function editBody(base: WorkingFile, content: string): { path: string; baseHash: string; content: string } {
  return { path: base.path, baseHash: base.hash, content };
}

/**
 * The working copy after a Save the server accepted: the text written and the sha256 the server
 * says is now on disk. The next Save is over this, not over the file first opened.
 */
export function savedAs(base: WorkingFile, content: string, r: EditResult): WorkingFile {
  return { ...base, text: content, hash: r.after, bytes: r.bytes, readAt: r.writtenAt };
}

/**
 * The working copy as this page may treat it. Only the desktop app's window can write (#241), so
 * in a browser a file nobody is touching is still read-only, and says why before anything is typed.
 */
export function workingHere(w: WorkingFile, canWrite: boolean, why: string): WorkingFile {
  return w.editable && !canWrite ? { ...w, editable: false, reason: why } : w;
}

/** The head's state words. */
export function editState(enabled: boolean, w: { state: "loading" } | { state: "error"; error: string } | { state: "ok"; value: WorkingFile } | null): string {
  if (!enabled) return "read-only while agents work";
  if (!w || w.state === "loading") return "reading the working copy…";
  if (w.state === "error") return `read-only: ${w.error}`;
  if (w.value.editable) return `editing the working copy in ${w.value.abs.slice(0, w.value.abs.length - w.value.path.length - 1)}`;
  const t = w.value.touching;
  if (!t.length) return `read-only: ${w.value.reason ?? "not editable now"}`;
  return `read-only: ${t.length === 1 ? `${t[0].why} (${t[0].id.slice(0, 12)})` : `${t.length} agents or sessions are working on it`}`;
}

/** The counts line under the legend, each figure with where it came from. Never a 0 for a source that gave no answer. */
export function countsLine(m: Marks, refusals: Source<Refusal[]>, tree: CodeTreeOk, window: string | null): string[] {
  // A reason that already names what it is about (refusalsSource's texts do) is not prefixed again.
  const n = (v: number | null, what: string, files: number | null, src: string, why: string, atLeast = false) =>
    v === null ? (why.startsWith(what) ? why : `${what}: ${why}`) : `${atLeast ? "at least " : ""}${v} ${what} on ${files} file${files === 1 ? "" : "s"} (${src})`;
  const sha = tree.commit.sha.slice(0, 7);
  // Some catalogues read and some not: the count is of those read, and the failure is said with it.
  const trapsPartial = tree.traps.status === "partial";
  const trapsMissed = trapsPartial ? `; some catalogues could not be read, so these are only the ones that could: ${tree.traps.errors.join("; ") || "no reason given"}` : "";
  return [
    n(m.counts.refusals, "refused edits", m.counts.refusedFiles, `GET /api/refusals, ${window ?? "window not known"}${m.refusedElsewhere.length ? `; ${m.refusedElsewhere.length} on files not at ${sha}` : ""}`, refusals.state === "ok" ? "" : refusals.text),
    n(m.counts.breaking, "imports that break the design", m.counts.breakingFiles, `the design reader at ${tree.commit.ref} ${sha}`, tree.structure.status === "no-design" ? "no design is registered, so nothing is judged" : `not measured (${"reason" in tree.structure ? tree.structure.reason : tree.structure.status})`),
    m.counts.touchedFiles === null
      ? `files AnviDeck agents edited: not known (${tree.agents.reason ?? "the agent host could not be asked"})`
      : `${m.counts.touchedFiles} file${m.counts.touchedFiles === 1 ? "" : "s"} AnviDeck agents edited (${tree.agents.total} agents in ${tree.agents.registry ?? "the registry"}, ${tree.agents.running} running${tree.agents.status === "partial" ? `; some transcripts could not be read: ${tree.agents.reason}` : ""})`,
    n(m.counts.trapCites, "known-trap citations", m.counts.trapFiles, `file:line in ${tree.traps.dir ?? "no catalogue folder"}; ${tree.traps.cites} citations read: ${tree.traps.placed.length} placed here, ${tree.traps.elsewhere} name files outside this package or not at ${sha}, ${tree.traps.ambiguousCites} name a file that several files could be${trapsMissed}`, `catalogues could not be read: ${tree.traps.errors.join("; ")}`, trapsPartial),
  ];
}
