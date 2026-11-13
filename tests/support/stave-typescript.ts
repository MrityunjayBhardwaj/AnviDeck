import { createRequire } from "node:module";

/**
 * Why anvi's structure guard cannot measure a package here, or null when it can (#281). The guard
 * loads TypeScript as `require.resolve("typescript", { paths: [package] })` (anvi's
 * scripts/ownership-index.js, loadTypeScript), borrowing the checkout's installed packages for the
 * commit it measures; without them it answers NOT MEASURED. Same question, asked the same way.
 */
export function typescriptMissing(pkgDir: string): string | null {
  try {
    createRequire(import.meta.url).resolve("typescript", { paths: [pkgDir] });
    return null;
  } catch {
    return `TypeScript, which the guard resolves from ${pkgDir} (its installed packages are not there)`;
  }
}
