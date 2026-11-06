/**
 * Desktop app (#239, spike): compile the server into one binary that Tauri bundles as a
 * sidecar (externalBin). Tauri looks it up with the host's target triple as a suffix.
 */
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const triple = /host: (\S+)/.exec(Bun.spawnSync(["rustc", "-vV"]).stdout.toString())?.[1];
if (!triple) throw new Error("could not read the host target triple from rustc -vV");
const out = join(import.meta.dir, "src-tauri", "binaries", `anvideck-server-${triple}`);
const r = Bun.spawnSync(["bun", "build", "--compile", join(ROOT, "server", "index.ts"), "--outfile", out], { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
if (r.exitCode !== 0) process.exit(r.exitCode ?? 1);
console.log(`sidecar → ${out}`);
