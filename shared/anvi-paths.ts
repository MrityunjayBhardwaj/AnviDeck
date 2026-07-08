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

/** First existing candidate directory for `kind`, or null if none exist. */
export function resolveDir(projectPath: string, kind: string): string | null {
  for (const candidate of candidates(projectPath, kind)) {
    try {
      if (existsSync(candidate) && statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch {
      // ignore unreadable candidate
    }
  }
  return null;
}
