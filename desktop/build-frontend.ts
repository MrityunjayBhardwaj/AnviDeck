/**
 * Desktop app (#240): put the UI the window loads into desktop/frontend:
 * index.html, the styles and the bundled scripts. The app serves these from inside itself,
 * not from the sidecar.
 */
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
// The agent host page (#75). The server writes it inline; in the app it is a file, and a link to
// /agent-host finds agent-host.html (Tauri tries "<path>.html"). No token: the app writes over its pipe.
writeFileSync(join(OUT, "agent-host.html"), `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>AnviDeck: agent host</title>
<link rel="stylesheet" href="/styles/deck.css"></head><body><div id="agent-host"></div>
<script type="module" src="/agent-host.js"></script></body></html>`);
console.log(`desktop frontend → ${OUT}`);
