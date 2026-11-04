/**
 * Single-pass build: bundle ui/app.ts → dist/app.js
 */
const result = await Bun.build({
  entrypoints: ["./ui/app.ts", "./ui/agent-host.ts"],
  outdir: "./dist",
  target: "browser",
  format: "esm",
  minify: false,
  sourcemap: "inline",
});

if (!result.success) {
  console.error("Build failed:");
  for (const msg of result.logs) {
    console.error(msg);
  }
  process.exit(1);
}

console.log("Built ui/app.ts → dist/app.js, ui/agent-host.ts → dist/agent-host.js");
