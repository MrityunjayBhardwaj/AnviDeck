import { existsSync, statSync } from "node:fs";
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
 * the one `resolveDir` serves). A candidate counts only if it is a directory.
 */
export function existingDirs(projectPath: string, kind: string): string[] {
  return candidates(projectPath, kind).filter((candidate) => {
    try {
      return existsSync(candidate) && statSync(candidate).isDirectory();
    } catch {
      // ignore unreadable candidate
      return false;
    }
  });
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
