import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";

/**
 * Shared artifact-path resolver — the single place AnviDeck decides where a
 * project's anvi artifacts live. Mirrors anvi's `hooks/anvi-paths.js`
 * `candidates(cwd, kind)` so the dashboard and the framework can never disagree
 * about a location.
 *
 * A project's artifacts can live in one of three places (first existing wins,
 * so a project-local copy overrides the centralized one):
 *   1. {projectPath}/{kind}                          (in-repo)
 *   2. {projectPath}/artifacts/{kind}                (in-repo, artifacts/ layout)
 *   3. ~/.anvideck/projects/{name}/{kind}            (centralized, out-of-repo)
 *
 * `kind` is a bare directory name: ".anvi" | "ref" | "investigations".
 */
export function candidates(projectPath: string, kind: string): string[] {
  const name = basename(projectPath);
  return [
    join(projectPath, kind),
    join(projectPath, "artifacts", kind),
    join(homedir(), ".anvideck", "projects", name, kind),
  ];
}

/**
 * All candidate directories that actually exist, in resolution order (first =
 * the one `resolveDir` serves), deduped by physical directory. A candidate
 * counts only if it is a directory.
 *
 * A symlink and its target are two path strings but ONE directory — the
 * local-symlink-to-central layout `/anvi:init` creates and the fleet
 * standardizes on. Counting both as separate copies would falsely trip
 * split-brain detection (a symlink is an alias, not a divergent copy); identity
 * is by realpath, not by path string. The first path to reach a given realpath
 * is kept, so local-first ordering is preserved. Two genuinely distinct
 * directories still survive as two entries → real split-brain still detected.
 * Mirrors anvi's `hooks/anvi-paths.js` fix (anvi #37).
 */
/**
 * True when ~/.anvideck/projects holds a folder with EXACTLY this name. On a case-insensitive
 * filesystem (macOS) `~/.anvideck/projects/Stave` opens `…/stave`, so existsSync alone would hand
 * one project another's notes (#32). The directory listing keeps the on-disk case.
 */
function storeNamedExactly(name: string): boolean {
  try {
    return readdirSync(join(homedir(), ".anvideck", "projects")).includes(name);
  } catch {
    return false;
  }
}

export function existingDirs(projectPath: string, kind: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const all = candidates(projectPath, kind);
  for (const candidate of all) {
    // The centralized candidate counts only under the project's exact name (#32).
    if (candidate === all[2] && !storeNamedExactly(basename(projectPath))) continue;
    try {
      if (!existsSync(candidate) || !statSync(candidate).isDirectory()) continue;
    } catch {
      // ignore unreadable candidate
      continue;
    }
    let real: string;
    try {
      real = realpathSync(candidate);
    } catch {
      real = candidate;
    }
    if (seen.has(real)) continue; // same physical dir as an earlier candidate (symlink → target)
    seen.add(real);
    out.push(candidate);
  }
  return out;
}

/**
 * Split-brain detection. When more than one candidate exists for a kind, the
 * resolver silently serves the first and shadows the rest — and the copies
 * diverge. Warn ONCE per process to stderr (never stdout), naming the served
 * winner and the shadowed copies. Detection only: never changes resolution or
 * output. Silence with ANVI_SILENCE_SPLITBRAIN=1.
 */
const warned = new Set<string>();
export function warnIfSplitBrain(kind: string, existing: string[]): void {
  if (process.env.ANVI_SILENCE_SPLITBRAIN) return;
  if (existing.length < 2) return;
  const key = kind + "\0" + existing.join("\0");
  if (warned.has(key)) return;
  warned.add(key);
  const [winner, ...shadowed] = existing;
  process.stderr.write(
    `⚠ anvi: ${existing.length} copies of '${kind}' resolve for this project — ` +
      `serving ${winner}, shadowing ${shadowed.join(", ")}. ` +
      `Copies diverge (split-brain); consolidate to one. ` +
      `(silence: ANVI_SILENCE_SPLITBRAIN=1)\n`,
  );
}

/** First existing candidate directory for `kind`, or null if none exist. */
export function resolveDir(projectPath: string, kind: string): string | null {
  const existing = existingDirs(projectPath, kind);
  warnIfSplitBrain(kind, existing);
  return existing.length ? existing[0]! : null;
}
