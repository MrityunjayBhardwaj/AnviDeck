import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * READ-ONLY view of anvi's root-owned structure lock.
 *
 * Mirrors anvi's hooks/structure-lock.js (installed under
 * `<lock dir>/guard/hooks/`): the lock directory is
 * `/Library/Application Support/anvi` on macOS, `/etc/anvi` on Linux
 * (LOCK_DIRS), the locked registry is `<lock dir>/structure-guard.json`
 * (lockedRegistry), and a registry without a `packages` array is an error,
 * not an empty lock (packagesOf). Entries without a string `dir` are dropped,
 * as anvi drops them.
 *
 * Never writes. `none` = no lock file (nothing locked); `unreadable` = the
 * file exists but could not be read or is not a registry — which packages are
 * locked is then unknown, so it must not read as "none".
 */

export const LOCK_DIRS: Record<string, string> = {
  darwin: "/Library/Application Support/anvi",
  linux: "/etc/anvi",
};

export interface LockedPackage {
  /** The package directory the lock guards. */
  dir: string;
  design?: string;
  baseline?: string;
  designId?: string;
  check?: {
    adapter?: string;
    root?: string;
    files?: string[];
    mode?: string;
    node?: number;
  };
}

export type StructureLock =
  | { status: "ok"; path: string; packages: LockedPackage[] }
  | { status: "none"; path: string | null }
  | { status: "unreadable"; path: string; error: string };

export function structureLockPath(platform: string = process.platform): string | null {
  const dir = LOCK_DIRS[platform];
  return dir ? join(dir, "structure-guard.json") : null;
}

export function readStructureLock(path: string | null = structureLockPath()): StructureLock {
  if (!path) return { status: "none", path: null };
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { status: "none", path };
    return { status: "unreadable", path, error: code ?? (e as Error).message };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { status: "unreadable", path, error: `not JSON: ${(e as Error).message}` };
  }
  const packages = (json as { packages?: unknown })?.packages;
  if (!Array.isArray(packages)) {
    return { status: "unreadable", path, error: 'the registry has no "packages" list' };
  }
  return {
    status: "ok",
    path,
    packages: packages.filter(
      (p): p is LockedPackage => !!p && typeof (p as LockedPackage).dir === "string"
    ),
  };
}
