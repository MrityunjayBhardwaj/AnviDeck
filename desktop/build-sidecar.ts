/**
 * Desktop app (#240): compile the server into one binary that Tauri bundles as a
 * sidecar (externalBin). Tauri looks it up with the host's target triple as a suffix.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const triple = /host: (\S+)/.exec(Bun.spawnSync(["rustc", "-vV"]).stdout.toString())?.[1];
if (!triple) throw new Error("could not read the host target triple from rustc -vV");
const out = join(import.meta.dir, "src-tauri", "binaries", `anvideck-server-${triple}`);
// `bun build --compile` leaves a large `.<hash>.bun-build` file in its working folder; build in a
// scratch folder so none lands in the repo (one was committed by mistake during the spike).
const work = mkdtempSync(join(tmpdir(), "anvideck-sidecar-"));
const r = Bun.spawnSync(["bun", "build", "--compile", join(ROOT, "server", "index.ts"), "--outfile", out], { cwd: work, stdout: "inherit", stderr: "inherit" });
rmSync(work, { recursive: true, force: true });
if (r.exitCode !== 0) process.exit(r.exitCode ?? 1);
console.log(`sidecar → ${out}`);
