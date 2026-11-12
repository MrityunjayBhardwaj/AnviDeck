import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { CWD, HOME, type ReplayStep } from "./replay";

/**
 * Clean a raw recording for the repo (#242). The repository is public, and a raw recording
 * carries the recorder's own setup: the init message lists their MCP servers, plugins, skills,
 * agents, slash commands and memory folders; commands_changed lists every command they have;
 * hooks' output is whatever their hooks printed; rate_limit_event shows their plan's usage.
 *
 * Kept: what the agent host and the screens read (session, model, Claude Code version, the
 * credential source, built-in tool names, hook event and outcome, the conversation itself).
 * Emptied: the lists above. Swapped: the scratch folder and home folder for placeholders, both as
 * paths and in Claude Code's dash-encoded folder-name form (#277).
 *
 * Fails closed: if the home folder, the user name, an email address or a system temp folder
 * (/var/folders, in either form) is still anywhere in the cleaned text, it throws and nothing is written.
 */

type Msg = Record<string, unknown>;

const INIT_KEEP = ["type", "subtype", "cwd", "session_id", "tools", "model", "permissionMode", "apiKeySource", "claude_code_version", "uuid"] as const;

function cleanMessage(m: Msg): Msg {
  if (m.type === "system" && m.subtype === "init") {
    const out: Msg = {};
    for (const k of INIT_KEEP) if (k in m) out[k] = m[k];
    // Built-in tools only: an mcp__<server>__<tool> name tells which servers the recorder has.
    out.tools = Array.isArray(m.tools) ? (m.tools as string[]).filter((t) => !t.startsWith("mcp__")) : [];
    return { ...out, mcp_servers: [], slash_commands: [], agents: [], skills: [], plugins: [], output_style: "default" };
  }
  if (m.type === "system" && m.subtype === "commands_changed") return { ...m, commands: [] };
  if (m.type === "system" && (m.subtype === "hook_started" || m.subtype === "hook_response" || m.subtype === "hook_progress")) {
    const out: Msg = { ...m };
    for (const k of ["output", "stdout", "stderr"]) if (k in out) out[k] = "";
    return out;
  }
  if (m.type === "rate_limit_event") {
    const info = (m.rate_limit_info ?? {}) as Msg;
    return { ...m, rate_limit_info: { status: info.status ?? "allowed" } };
  }
  if (m.type === "result") {
    const { credential_expires_at: _c, ...rest } = m;
    return rest;
  }
  return m;
}

/** A path the way Claude Code turns it into a folder name: every character but a letter or digit is "-". */
export function encoded(path: string): string {
  return path.replace(/[^A-Za-z0-9]/g, "-");
}

export function cleanRecording(steps: ReplayStep[], where: { cwd: string; home: string; user?: string }): ReplayStep[] {
  const cleaned = steps.map((s) => (s.k === "sdk" ? { ...s, m: cleanMessage(s.m as unknown as Msg) as unknown as SDKMessage } : s));
  let text = JSON.stringify(cleaned);
  // The scratch folder first (it may sit under home), then home; both with and without /private.
  const swaps: [string, string][] = [];
  for (const [from, to] of [[where.cwd, CWD], [where.home, HOME]] as [string, string][]) {
    if (!from) continue;
    swaps.push([from, to]);
    if (from.startsWith("/private/")) swaps.push([from.slice("/private".length), to]);
    // Claude Code names folders after a path with every other character as "-" (its temp and
    // project folders, e.g. a subagent's output_file); that form is swapped too (#277).
    swaps.push([encoded(from), encoded(to)]);
    if (from.startsWith("/private/")) swaps.push([encoded(from.slice("/private".length)), encoded(to)]);
  }
  for (const [from, to] of swaps) text = text.split(from).join(to);
  const user = where.user ?? (where.home ? where.home.split("/").filter(Boolean).pop() : undefined);
  const leaks: string[] = [];
  if (where.home && text.includes(where.home)) leaks.push("the home folder");
  if (user && user.length >= 3 && new RegExp(`\\b${user.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text)) leaks.push(`the user name "${user}"`);
  if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(text)) leaks.push("an email address");
  if (/\/Users\/|\/home\/[a-z]/.test(text)) leaks.push("a home folder path");
  if (/[/-]var[/-]folders[/-]/.test(text)) leaks.push("a system temp folder");
  if (leaks.length) throw new Error(`the cleaned recording still contains ${leaks.join(", ")}; not written`);
  return JSON.parse(text) as ReplayStep[];
}
