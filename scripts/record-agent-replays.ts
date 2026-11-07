/**
 * Record real agent runs for the replay tests (#242). Each scenario starts one tiny real
 * Claude Code agent through the real agent host, on your Claude Code login, in a new scratch
 * folder. It costs plan usage, so it runs only when you ask:
 *
 *   bun scripts/record-agent-replays.ts --out <dir> [--raw] [scenario...]
 *   bun scripts/record-agent-replays.ts --check [scenario...]   (default: plain)
 *
 * --check records into a scratch folder and compares each run's shape (turns, asks, answers,
 * results, and the fields AnviDeck reads) with the recording in tests/fixtures/replays. A
 * difference exits 1 and names it: record again, and read what changed before trusting it.
 *
 * Without --raw each recording is cleaned for the repo (cleanRecording): this machine's folders
 * become placeholders, and what the init message says about your own setup (MCP servers,
 * plugins, skills, slash commands, agents) is dropped.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { AgentHost, type QueryFn } from "../server/agents/host";
import { AgentRegistry } from "../server/agents/registry";
import { parseRecording, recordingQuery, replayShape, type ReplayStep } from "../server/agents/replay";
import { cleanRecording } from "../server/agents/replay-clean";
import { SCENARIOS, type Scenario } from "../server/agents/replay-scenarios";

const args = process.argv.slice(2);
const check = args.includes("--check");
const outAt = args.indexOf("--out");
if (!check && (outAt < 0 || !args[outAt + 1])) {
  console.error("usage: bun scripts/record-agent-replays.ts --out <dir> [--raw] [scenario...]  |  --check [scenario...]");
  process.exit(2);
}
const out = check ? mkdtempSync(join(tmpdir(), "anvideck-replay-check-")) : args[outAt + 1];
const raw = args.includes("--raw") || check;
const wanted = args.filter((a, i) => !a.startsWith("--") && (outAt < 0 || i !== outAt + 1));
const scenarios = SCENARIOS.filter((s) => (wanted.length === 0 ? !check || s.name === "plain" : wanted.includes(s.name)));
const FIXTURES = join(import.meta.dir, "..", "tests", "fixtures", "replays");
mkdirSync(out, { recursive: true });

const claudeVersion = (spawnSync("claude", ["--version"], { encoding: "utf8" }).stdout ?? "").trim() || null;
const sdkVersion = (await import("@anthropic-ai/claude-agent-sdk/package.json", { with: { type: "json" } })).default.version ?? null;

for (const s of scenarios) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "anvideck-replay-")));
  const calls: ReplayStep[][] = [];
  const real: QueryFn = (p) => {
    const steps: ReplayStep[] = [{ k: "meta", name: s.name, recordedAt: new Date().toISOString(), claudeCode: claudeVersion, sdk: sdkVersion, prompt: s.prompt }];
    calls.push(steps);
    return recordingQuery(query as unknown as QueryFn, (st) => steps.push(st))(p);
  };
  const host = new AgentHost({ registry: new AgentRegistry(mkdtempSync(join(tmpdir(), "anvideck-replay-reg-"))), query: real });
  console.log(`[${s.name}] recording in ${cwd}`);
  try {
    await s.drive(host, cwd);
  } catch (e) {
    console.error(`[${s.name}] failed: ${(e as Error).message}`);
    host.stopAll("recording failed");
    process.exitCode = 1;
    continue;
  }
  calls.forEach((steps, i) => {
    const file = join(out, `${s.name}${calls.length > 1 ? `.${i + 1}` : ""}.jsonl`);
    const kept = raw ? steps : cleanRecording(steps, { cwd, home: process.env.HOME ?? "" });
    writeFileSync(file, kept.map((x) => JSON.stringify(x)).join("\n") + "\n");
    console.log(`[${s.name}] ${file}: ${kept.length} steps (${kept.filter((x) => x.k === "sdk").length} messages)`);
    if (check) {
      const name = `${s.name}${calls.length > 1 ? `.${i + 1}` : ""}.jsonl`;
      const want = existsSync(join(FIXTURES, name)) ? replayShape(parseRecording(readFileSync(join(FIXTURES, name), "utf8"))) : null;
      const got = replayShape(steps);
      if (!want) { console.log(`[${s.name}] DIFFERENT: no recording ${name} in the repo`); process.exitCode = 1; return; }
      const same = JSON.stringify(want) === JSON.stringify(got);
      console.log(`[${s.name}] ${same ? "same shape" : "DIFFERENT"} as ${name} (recorded with ${claudeVersionOf(join(FIXTURES, name))}, now ${claudeVersion})`);
      if (!same) { console.log(`  recorded: ${want.join(" → ")}\n  now:      ${got.join(" → ")}`); process.exitCode = 1; }
    }
  });
}
function claudeVersionOf(file: string): string {
  const meta = parseRecording(readFileSync(file, "utf8"))[0];
  return meta?.k === "meta" ? meta.claudeCode ?? "unknown" : "unknown";
}
export type { Scenario };
