/**
 * Pure joins for the Changes screen (#84): no I/O, so tests drive them directly.
 * The reader (server/readers/changes.ts) gathers the inputs; these decide what they mean.
 */
import type { FileLayer, FilesRead, LayersRead, PrFile } from "./changes-types";
import type { DiffFile } from "./diff";
import type { StructureProjectResponse } from "./structure-types";

/**
 * Does an injector log entry's `file` name this PR file? The injector logs the edited path
 * relative to the session's project root, and an absolute path for a file outside it. A path
 * matches when it is the same, or when one ends with the other at a "/" boundary (a session
 * rooted in a subfolder, or an absolute path). "a.ts" never matches "data.ts".
 */
export function logFileMatches(logFile: string, prPath: string): boolean {
  const a = logFile.replace(/^\.\//, "");
  const b = prPath.replace(/^\.\//, "");
  if (!a || !b) return false;
  return a === b || a.endsWith("/" + b) || b.endsWith("/" + a);
}

/** The ID part of a boundary label as the injector logs it: "B16: Editor view …" → "B16"; "B7" → "B7". */
export function boundaryId(label: string): string {
  const m = /^\s*(?:Boundary\s+)?([A-Za-z][\w.-]*)\s*(?::|—|–|$)/.exec(label);
  return m ? m[1] : label.trim();
}

/**
 * Boundary headings of a dharana.md: "### Boundary B1: Editor ↔ Evaluator", "### B45 — The drawn …".
 * First heading of an ID wins (later ones are updates on it).
 */
export function dharanaBoundaries(markdown: string): { id: string; title: string }[] {
  const out = new Map<string, string>();
  for (const line of markdown.split("\n")) {
    const m = /^#{2,4}\s+(?:Boundary\s+)?(B[\w.-]*\d[\w.]*|B-[\w-]+)\s*(?::|—|–)\s*(.+?)\s*$/.exec(line);
    if (m && !out.has(m[1])) out.set(m[1], m[2]);
  }
  return [...out].map(([id, title]) => ({ id, title }));
}

/**
 * The Claude Code session a transcript file belongs to. Top-level `<sid>.jsonl` is the session;
 * `<sid>/subagents/…/agent-x.jsonl` is a subagent of session `<sid>` (its hooks log under `<sid>`).
 * `rel` is the path relative to the project's transcript folder.
 */
export function sessionOfTranscript(rel: string): string | null {
  const parts = rel.split("/").filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0].endsWith(".jsonl") ? parts[0].slice(0, -".jsonl".length) : null;
  return parts[0];
}

/**
 * Which layer (design block) each PR file sits in, from the structure reader's layer map.
 * `packagePrefix` is the measured package folder relative to the repository root ("" when it is
 * the root). A project without a measured design answers "unknown" with the reader's reason,
 * never an empty list of layers.
 */
export function layersFor(files: PrFile[], s: StructureProjectResponse, packagePrefix: string | null): LayersRead {
  if (s.status === "no-design")
    return { status: "unknown", reason: `${s.project} registers no design with anvi's structure guard, so its files have no layers` };
  if (s.status !== "measured") return { status: "unknown", reason: s.reason };
  if (packagePrefix === null)
    return { status: "unknown", reason: `the design package ${s.package.dir} is not inside this project's repository` };

  const byPath = new Map(s.modules.map((m) => [m.path, m]));
  // The source root inside the package (e.g. "src/"): what a module's path adds before its rel.
  const sample = s.modules.find((m) => m.path.endsWith(m.rel));
  const srcRoot = sample ? sample.path.slice(0, sample.path.length - sample.rel.length) : "";
  const pre = packagePrefix ? packagePrefix.replace(/\/+$/, "") + "/" : "";

  const out: FileLayer[] = files.map((f) => {
    if (pre && !f.path.startsWith(pre)) return { path: f.path, layer: null, how: "outside-package" };
    const inner = f.path.slice(pre.length);
    const mod = byPath.get(inner);
    if (mod) return { path: f.path, layer: mod.component, how: mod.component ? "module" : "unmapped" };
    if (inner.startsWith(srcRoot)) {
      const rel = inner.slice(srcRoot.length);
      const c = s.components.find((c) => c.files.includes(rel) || c.dirs.some((d) => rel.startsWith(d.replace(/\/+$/, "") + "/")));
      if (c) return { path: f.path, layer: c.name, how: "folder" };
    }
    return { path: f.path, layer: null, how: "unmapped" };
  });

  const counts = new Map<string, number>();
  for (const f of out) if (f.layer) counts.set(f.layer, (counts.get(f.layer) ?? 0) + 1);
  return {
    status: "measured",
    packageDir: s.package.dir,
    measuredAt: { ref: s.measuredAt.ref, sha: s.measuredAt.sha, date: s.measuredAt.date },
    files: out,
    layers: [...counts].map(([name, n]) => ({ name, files: n })).sort((a, b) => b.files - a.files || a.name.localeCompare(b.name)),
  };
}

/**
 * Every file the PR changes. `listed` is gh pr view's list (at most 100 files); `paged` is GitHub's
 * files API, read only when `listed` falls short of `changedFiles`; `diffFiles` are the files the
 * diff has. A file only the diff names is added with the diff's counts. When the files still fall
 * short of `changedFiles`, the read is "partial" with the reason, never a silently shorter list.
 */
export function completeFiles(
  listed: PrFile[],
  changedFiles: number,
  paged: { ok: true; files: PrFile[] } | { ok: false; reason: string } | null,
  diffFiles: DiffFile[] | null,
): { files: PrFile[]; read: FilesRead } {
  if (listed.length >= changedFiles) return { files: listed, read: { status: "complete", from: "gh pr view" } };
  const base = paged?.ok ? paged.files : listed;
  if (base.length >= changedFiles) return { files: base, read: { status: "complete", from: "gh api" } };
  const have = new Set(base.map((f) => f.path));
  const fromDiff = (diffFiles ?? []).filter((d) => !have.has(d.path)).map((d) => ({ path: d.path, additions: d.additions, deletions: d.deletions }));
  const files = [...base, ...fromDiff];
  const src = paged?.ok ? "gh api" : "gh pr view";
  if (files.length >= changedFiles) return { files, read: { status: "complete", from: `${src} + diff` } };
  const why = [
    `${src} listed ${base.length} of ${changedFiles} changed files`,
    paged && !paged.ok ? `paging GitHub's files API failed (${paged.reason})` : null,
    diffFiles ? `the diff added ${fromDiff.length}` : "the diff could not be read",
    `${changedFiles - files.length} file(s) are not shown and were not looked for in the hook logs`,
  ];
  return { files, read: { status: "partial", reason: why.filter(Boolean).join("; ") } };
}
