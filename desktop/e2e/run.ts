/**
 * End-to-end checks that drive the real desktop window (#242).
 *
 *   bun run desktop:e2e                 build the test app, then run every check
 *   bun desktop/e2e/run.ts [--out dir]  run against an app already built with `--features e2e`
 *
 * The app is the debug build with the opt-in `e2e` feature, which adds a WebDriver port (it can
 * press any button, so it is never in a normal build; the last check confirms the release
 * binary has none). Agents play recordings (tests/fixtures/replays) instead of running Claude
 * Code, so no plan usage is spent and nothing runs on disk. The agent registry and the action
 * log go to a scratch folder. Your real projects are only read, as the screens always do.
 *
 * A failing check saves a screenshot to --out and the run exits 1.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCREENS } from "../../ui/shell/routes";
import { SCENARIOS } from "../../server/agents/replay-scenarios";

const ROOT = join(import.meta.dir, "..", "..");
const args = process.argv.slice(2);
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const APP = opt("--app") ?? join(ROOT, "desktop", "src-tauri", "target", "debug", "anvideck");
const RELEASE = join(ROOT, "desktop", "src-tauri", "target", "release", "anvideck");
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "anvideck-e2e-")));
const OUT = opt("--out") ?? join(scratch, "shots");
mkdirSync(OUT, { recursive: true });
const AGENT_DIR = join(scratch, "agents");
const CWD = join(scratch, "agent-cwd");
mkdirSync(AGENT_DIR);
mkdirSync(CWD);

// The order agents are started in below; each start plays the next recording.
const REPLAYS = ["allow", "deny", "stop-resume"];
const prompt = (name: string) => SCENARIOS.find((s) => s.name === name)!.prompt;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const p = s.port!;
  s.stop(true);
  return p;
}

// ── WebDriver, the few commands used ────────────────────────────────────────────────────────

const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";
let WD = "";
let sid = "";
async function wd(method: string, path: string, body?: unknown): Promise<any> {
  const r = await fetch(`${WD}${path.replace("{s}", sid)}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = (await r.json().catch(() => ({}))) as { value?: any };
  if (!r.ok) throw new Error(`WebDriver ${method} ${path}: ${r.status} ${JSON.stringify(j.value ?? j).slice(0, 200)}`);
  return j.value;
}
const run = (script: string, ...a: unknown[]) => wd("POST", "/session/{s}/execute/sync", { script, args: a });
async function find(css: string, timeoutMs = 15_000): Promise<string> {
  const t0 = Date.now();
  for (;;) {
    try {
      const v = await wd("POST", "/session/{s}/element", { using: "css selector", value: css });
      if (v?.[ELEMENT]) return v[ELEMENT];
    } catch { /* not there yet */ }
    if (Date.now() - t0 > timeoutMs) throw new Error(`no element ${css} after ${timeoutMs} ms`);
    await sleep(200);
  }
}
const click = async (css: string, timeoutMs?: number) => wd("POST", `/session/{s}/element/${await find(css, timeoutMs)}/click`, {});
async function type(css: string, text: string) {
  const id = await find(css);
  await wd("POST", `/session/{s}/element/${id}/clear`, {});
  await wd("POST", `/session/{s}/element/${id}/value`, { text });
}
async function go(where: string) {
  await run("location.href = arguments[0];", where);
  await sleep(600);
}

// ── the app's server, read the way the screens read it ─────────────────────────────────────

let ORIGIN = "";
type Agent = { id: string; status: string; running: boolean; runs: number; reason?: string; pendingPermissions: unknown[] };
async function agents(): Promise<Agent[]> {
  return ((await (await fetch(`${ORIGIN}/api/agents`)).json()) as { agents: Agent[] }).agents;
}
async function waitAgent(id: string, pred: (a: Agent) => boolean, what: string, timeoutMs = 20_000): Promise<Agent> {
  const t0 = Date.now();
  for (;;) {
    const a = (await agents()).find((x) => x.id === id);
    if (a && pred(a)) return a;
    if (a?.status === "failed") throw new Error(`agent ${id} failed: ${a.reason}`);
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what} (agent ${id}: ${a?.status ?? "not listed"})`);
    await sleep(200);
  }
}
/** Start an agent from the agent host page's form, as a person would; returns its id. */
async function startAgent(scenario: string): Promise<string> {
  const before = new Set((await agents()).map((a) => a.id));
  await go("/agent-host");
  await type("#cwd", CWD);
  await type("#prompt", prompt(scenario));
  await click("#start");
  const t0 = Date.now();
  for (;;) {
    const fresh = (await agents()).find((a) => !before.has(a.id));
    if (fresh) return fresh.id;
    if (Date.now() - t0 > 10_000) throw new Error("Start agent added no agent to the list");
    await sleep(200);
  }
}

// ── the checks ──────────────────────────────────────────────────────────────────────────────

const checks: { name: string; run: () => Promise<string> }[] = [
  {
    name: "every screen opens with no failed read and no script error",
    async run() {
      await go("/index.html#home");
      await run(`if (!window.__e2e) { window.__e2e = []; var f = window.fetch; window.fetch = function (i, o) { var u = String(i && i.url || i); return f(i, o).then(function (r) { if (!r.ok) window.__e2e.push(r.status + ' ' + u); return r; }, function (e) { window.__e2e.push('ERR ' + u + ' ' + e); throw e; }); }; window.addEventListener('error', function (e) { window.__e2e.push('JS ' + e.message); }); window.addEventListener('unhandledrejection', function (e) { window.__e2e.push('REJECTED ' + (e.reason && e.reason.message || e.reason)); }); }`);
      const bad: string[] = [];
      for (const s of SCREENS) {
        await run("window.__e2e.length = 0; location.hash = arguments[0];", `#${s.id}`);
        await sleep(2500);
        const got = (await run("return { probe: window.__e2e.slice(0, 5), chars: (document.body.innerText || '').length };")) as { probe: string[]; chars: number };
        if (got.probe.length) bad.push(`${s.id}: ${got.probe.join("; ")}`);
        if (got.chars < 50) bad.push(`${s.id}: the page is nearly empty (${got.chars} characters)`);
      }
      if (bad.length) throw new Error(bad.join("\n"));
      return `${SCREENS.length} screens`;
    },
  },
  {
    name: "Allow on Home: a waiting request shows on Home, Allow lets the agent finish",
    async run() {
      const id = await startAgent("allow");
      await waitAgent(id, (a) => a.pendingPermissions.length > 0, "the permission request");
      await go("/index.html#home");
      // Home lists the request; Answer opens its card with Allow / Deny.
      await click("button[data-act=answer]");
      await click(".hm-answer button[data-act=allow]");
      await waitAgent(id, (a) => a.status === "done", "the agent to finish");
      return `agent ${id} done`;
    },
  },
  {
    name: "Deny with a message on the agent's card on Agents",
    async run() {
      const id = await startAgent("deny");
      await waitAgent(id, (a) => a.pendingPermissions.length > 0, "the permission request");
      await go(`/index.html#agents?agent=${encodeURIComponent(id)}`);
      await type("[data-act=deny-message]", "not now");
      await click("button[data-act=deny]");
      await waitAgent(id, (a) => a.status === "done", "the agent to finish");
      return `agent ${id} done`;
    },
  },
  {
    name: "Stop on Agents withdraws the waiting request; Resume with a message runs it again",
    async run() {
      const id = await startAgent("stop-resume");
      await waitAgent(id, (a) => a.pendingPermissions.length > 0, "the permission request");
      await go(`/index.html#agents?agent=${encodeURIComponent(id)}`);
      await click("button[data-act=stop]");
      await waitAgent(id, (a) => a.status === "stopped" && !a.running, "the stop");
      await sleep(800); // the card re-renders with Resume once the run has ended
      await type(`[data-composer="${id}"] textarea`, "Do not create the file. Reply with the single word: resumed.");
      await click("button[data-act=resume]");
      await waitAgent(id, (a) => a.status === "done" && a.runs === 2, "the resumed run to finish");
      return `agent ${id} done after 2 runs`;
    },
  },
  {
    name: "Help: a flow plays over the real screens, Next moves on, End closes it",
    async run() {
      await go("/index.html#flows");
      await click("button[data-play='0']");
      const first = (await run("var c = document.querySelector('.ht-count'); return c && c.textContent;")) as string | null;
      if (!first) throw new Error("no tour card after Play");
      await click(".ht-card .ht-next");
      await sleep(500);
      const second = (await run("return document.querySelector('.ht-count').textContent;")) as string;
      if (second === first) throw new Error(`Next did not move on (still "${first}")`);
      await click(".ht-card .ht-end");
      await sleep(300);
      if (await run("return !!document.querySelector('.ht-card') && document.querySelector('.ht-card').offsetParent !== null;")) throw new Error("End left the tour card on screen");
      return `${first} → ${second}`;
    },
  },
  {
    name: "nothing writes over HTTP: the server's port refuses a write, and the page holds no token",
    async run() {
      const r = await fetch(`${ORIGIN}/api/agents`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ cwd: CWD, prompt: "x" }) });
      if (r.status !== 403) throw new Error(`a write over HTTP answered ${r.status}`);
      if (await run("return !!document.querySelector('meta[name=anvideck-write-token]');")) throw new Error("the page carries a write token");
      return "403, no token";
    },
  },
  {
    name: "the release build has no WebDriver in it",
    async run() {
      if (!existsSync(RELEASE)) return "skipped: no release build (bun run desktop:build makes one)";
      const bin = readFileSync(RELEASE);
      for (const s of ["wdio", "webdriver", "WebDriver"]) if (bin.includes(s)) throw new Error(`the release binary contains "${s}"`);
      return "none found";
    },
  },
];

// ── run ─────────────────────────────────────────────────────────────────────────────────────

if (!existsSync(APP)) {
  console.error(`no app at ${APP}: build it with  cd desktop/src-tauri && cargo build --features e2e`);
  process.exit(2);
}
const port = await freePort();
WD = `http://127.0.0.1:${port}`;
const app: ChildProcess = spawn(APP, [], {
  env: {
    ...process.env,
    TAURI_WEBDRIVER_PORT: String(port),
    ANVIDECK_AGENT_DIR: AGENT_DIR,
    ANVIDECK_AGENT_REPLAY: REPLAYS.join(","),
    ANVIDECK_AGENT_REPLAY_DIR: join(ROOT, "tests", "fixtures", "replays"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
app.stdout?.on("data", (d) => (log += d));
app.stderr?.on("data", (d) => (log += d));

let failed = 0;
try {
  const t0 = Date.now();
  for (;;) {
    const up = await fetch(`${WD}/status`).then((r) => r.ok, () => false);
    if (up) break;
    if (app.exitCode !== null) throw new Error(`the app exited (${app.exitCode}) before its WebDriver port opened:\n${log.slice(-1500)}`);
    if (Date.now() - t0 > 60_000) throw new Error(`no WebDriver on port ${port} after 60 s: was the app built with --features e2e?`);
    await sleep(300);
  }
  sid = (await wd("POST", "/session", { capabilities: {} })).sessionId;
  for (let i = 0; i < 100 && !ORIGIN; i++) {
    ORIGIN = ((await run("return window.__ANVIDECK_ORIGIN__ || '';").catch(() => "")) as string) || "";
    if (!ORIGIN) await sleep(300);
  }
  if (!ORIGIN) throw new Error("the window never learned its server's address");
  if (!log.includes("REPLAY MODE")) throw new Error(`the server is not in replay mode; refusing to start real agents:\n${log.slice(-800)}`);

  for (const c of checks) {
    const t = Date.now();
    try {
      const said = await c.run();
      console.log(`  ok    ${c.name}  (${said}, ${((Date.now() - t) / 1000).toFixed(1)} s)`);
    } catch (e) {
      failed++;
      const shot = join(OUT, `${checks.indexOf(c) + 1}.png`);
      try {
        await Bun.write(shot, Buffer.from(await wd("GET", "/session/{s}/screenshot"), "base64"));
      } catch { /* the window may be gone */ }
      console.log(`  FAIL  ${c.name}\n        ${(e as Error).message.split("\n").join("\n        ")}\n        screenshot: ${shot}`);
    }
  }
} catch (e) {
  failed++;
  console.log(`  FAIL  setting up: ${(e as Error).message}`);
} finally {
  if (sid) await wd("DELETE", "/session/{s}").catch(() => undefined);
  app.kill("SIGTERM");
  await new Promise((r) => (app.exitCode !== null ? r(null) : app.once("exit", r)));
}
console.log(failed ? `\n${failed} of ${checks.length} checks failed (scratch: ${scratch})` : `\nall ${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
