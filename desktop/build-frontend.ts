/**
 * Desktop app (#239, spike): put the UI the window loads into desktop/frontend:
 * index.html, the styles and the bundled scripts. The app serves these from inside itself,
 * not from the sidecar.
 */
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const OUT = join(import.meta.dir, "frontend");
const built = Bun.spawnSync(["bun", "run", "build.ts"], { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
if (built.exitCode !== 0) process.exit(built.exitCode ?? 1);
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
cpSync(join(ROOT, "ui", "index.html"), join(OUT, "index.html"));
cpSync(join(ROOT, "ui", "styles"), join(OUT, "styles"), { recursive: true });
for (const f of ["app.js", "agent-host.js"]) cpSync(join(ROOT, "dist", f), join(OUT, f));
console.log(`desktop frontend → ${OUT}`);
