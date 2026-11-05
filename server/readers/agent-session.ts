import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  TOOL_RESULT_MAX_CHARS,
  type AgentSessionResponse,
  type CliRecord,
  type HookLogRow,
  type MeterRow,
  type SourceRead,
} from "../../shared/agents-screen-types";
import { errText, isAbsent } from "./read-status";

/**
 * One Claude Code session for the Agents screen (#82): its transcript, anvi's hook meter rows and
 * the live hook log, each with how it was read. Read only.
 *
 * Sources (paths overridable for tests):
 *   transcript  $CLAUDE_DIR/projects/<dir>/<sid>.jsonl (CLAUDE_DIR defaults to ~/.claude)
 *   meter       $ANVI_METER_DIR/<sid>.jsonl, else $CLAUDE_DIR/anvi-meter/<sid>.jsonl
 *               (as server/readers/replay.ts reads it; rows { ts, sid, hook, event, bytes, ms, outcome })
 *   hook log    $ANVIDECK_HOOK_LOG_DIR/anvi-hook-<sid>.log, else /tmp/anvi-hook-<sid>.log
 *               (server/watchers/hook-logger.ts; rows { ts, sid, file, boundaries, fatality, patterns, invariants })
 */

export interface AgentSessionPaths {
  claudeDir?: string;
  meterDir?: string;
  hookLogDir?: string;
}

const SID_RE = /^[A-Za-z0-9._-]{1,128}$/;
export function isSessionId(sid: string): boolean {
  return SID_RE.test(sid) && !/^\.+$/.test(sid);
}

function paths(p: AgentSessionPaths = {}) {
  const claudeDir = p.claudeDir ?? process.env.CLAUDE_DIR ?? join(homedir(), ".claude");
  return {
    projects: join(claudeDir, "projects"),
    meterDir: p.meterDir ?? process.env.ANVI_METER_DIR ?? join(claudeDir, "anvi-meter"),
    hookLogDir: p.hookLogDir ?? process.env.ANVIDECK_HOOK_LOG_DIR ?? "/tmp",
  };
}

/** Lines of a JSONL file, parsed; lines that are not JSON are counted, not dropped silently. */
function jsonLines(text: string): { rows: { line: number; v: Record<string, unknown> }[]; skipped: number } {
  const rows: { line: number; v: Record<string, unknown> }[] = [];
  let skipped = 0;
  const lines = text.split("\n");
  lines.forEach((l, i) => {
    if (!l.trim()) return;
    try {
      const v = JSON.parse(l);
      if (v && typeof v === "object" && !Array.isArray(v)) rows.push({ line: i + 1, v });
      else skipped++;
    } catch {
      skipped++;
    }
  });
  return { rows, skipped };
}

function status(count: number, skipped: number): SourceRead["status"] {
  if (skipped > 0) return "partial";
  return count > 0 ? "ok" : "none";
}

/** Read one file: its text and mtime, or why not (absent and unreadable kept apart). */
function readText(path: string): { text: string; modifiedAt: string } | { status: "not-found" | "unreadable"; detail: string } {
  try {
    const st = statSync(path);
    return { text: readFileSync(path, "utf8"), modifiedAt: st.mtime.toISOString() };
  } catch (e) {
    return isAbsent(e) ? { status: "not-found", detail: "the file does not exist" } : { status: "unreadable", detail: errText(path, e) };
  }
}

/** A tool result's text, cut at TOOL_RESULT_MAX_CHARS with the cut said in the text itself. */
function cutResult(content: unknown): unknown {
  const cut = (s: string) =>
    s.length > TOOL_RESULT_MAX_CHARS ? `${s.slice(0, TOOL_RESULT_MAX_CHARS)}\n… [cut by AnviDeck: ${s.length} characters in all]` : s;
  if (typeof content === "string") return cut(content);
  if (Array.isArray(content)) {
    return content.map((b) => {
      if (!b || typeof b !== "object") return b;
      if ((b as { type?: unknown }).type === "image") return IMAGE_LEFT_OUT;
      return typeof (b as { text?: unknown }).text === "string" ? { ...b, text: cut((b as { text: string }).text) } : b;
    });
  }
  return content;
}

/** An image block's place in a message: kept as a marker, its bytes left out. */
const IMAGE_LEFT_OUT = { type: "text", text: "[an image: left out by AnviDeck]" };

/** The parts of one transcript record the screen uses, or null when it uses none of it. */
export function trimRecord(v: Record<string, unknown>, line: number): CliRecord | null {
  if (v.isSidechain === true) return null; // a subagent's own turns: not this agent's tool calls
  const at = typeof v.timestamp === "string" ? v.timestamp : null;
  if (v.type === "attachment") {
    const a = v.attachment as Record<string, unknown> | undefined;
    if (!a || typeof a.type !== "string" || !a.type.startsWith("hook_")) return null;
    return { at, line, type: "attachment", attachment: a };
  }
  if (v.type !== "assistant" && v.type !== "user") return null;
  const msg = v.message as { role?: string; content?: unknown } | undefined;
  if (!msg) return null;
  let content = msg.content;
  if (Array.isArray(content)) {
    content = content
      .filter((b) => !(b && typeof b === "object" && ((b as { type?: string }).type === "thinking" || (b as { type?: string }).type === "redacted_thinking")))
      .map((b) => {
        if (!b || typeof b !== "object") return b;
        const o = b as { type?: string; content?: unknown; input?: unknown };
        if (o.type === "image") return IMAGE_LEFT_OUT;
        if (o.type === "tool_result") return { ...o, content: cutResult(o.content) };
        // A tool call's long text fields (a Write's content, an Edit's strings): shown, never acted on.
        if (o.type === "tool_use" && o.input && typeof o.input === "object") {
          const input = Object.fromEntries(Object.entries(o.input as Record<string, unknown>).map(([k, v]) => [k, typeof v === "string" ? cutResult(v) : v]));
          return { ...o, input };
        }
        return o;
      });
    if ((content as unknown[]).length === 0) return null;
  }
  return { at, line, type: v.type, message: { role: msg.role, content } };
}

/** Where the session's transcript is: the first projects/<dir>/<sid>.jsonl, or why there is none. */
function findTranscript(projectsDir: string, sid: string): { path: string } | { status: "not-found" | "unreadable"; detail: string; path: string } {
  let dirs: string[];
  try {
    dirs = readdirSync(projectsDir);
  } catch (e) {
    return isAbsent(e)
      ? { status: "not-found", detail: `${projectsDir} does not exist`, path: projectsDir }
      : { status: "unreadable", detail: errText(projectsDir, e), path: projectsDir };
  }
  for (const d of dirs) {
    const p = join(projectsDir, d, `${sid}.jsonl`);
    try {
      if (statSync(p).isFile()) return { path: p };
    } catch {
      /* not in this folder */
    }
  }
  return { status: "not-found", detail: `no ${sid}.jsonl in any folder of ${projectsDir} (Claude Code removes transcripts after its retention period)`, path: join(projectsDir, "*", `${sid}.jsonl`) };
}

/** How many of the newest transcript records an answer carries by default. */
export const DEFAULT_TAIL = 400;

export function readAgentSession(sid: string, p: AgentSessionPaths = {}, opts: { tail?: number } = {}): AgentSessionResponse {
  const where = paths(p);
  const readAt = new Date().toISOString();
  const tail = opts.tail && opts.tail > 0 ? Math.floor(opts.tail) : DEFAULT_TAIL;

  // ── transcript ──
  let transcript: AgentSessionResponse["transcript"];
  const found = findTranscript(where.projects, sid);
  if ("status" in found) {
    transcript = { status: found.status, path: found.path, detail: found.detail, count: 0, skippedLines: 0, records: [] };
  } else {
    const r = readText(found.path);
    if ("status" in r) transcript = { status: r.status, path: found.path, detail: r.detail, count: 0, skippedLines: 0, records: [] };
    else {
      const { rows, skipped } = jsonLines(r.text);
      const records: CliRecord[] = [];
      let cwd: string | undefined;
      for (const { line, v } of rows) {
        if (!cwd && typeof v.cwd === "string") cwd = v.cwd;
        const t = trimRecord(v, line);
        if (t) records.push(t);
      }
      const kept = records.length > tail ? records.slice(-tail) : records;
      transcript = {
        status: status(records.length, skipped), path: found.path, count: kept.length, total: records.length, skippedLines: skipped,
        modifiedAt: r.modifiedAt, records: kept, ...(cwd ? { cwd } : {}),
      };
    }
  }
  // When only the newest records are sent, hook rows from before them are left out too, and counted.
  const cutAt = transcript.records.length < (transcript.total ?? 0) ? Date.parse(transcript.records[0]?.at ?? "") - 5000 : NaN;
  const inWindow = <T extends { ts: string }>(rows: T[]): { rows: T[]; before: number } => {
    if (Number.isNaN(cutAt)) return { rows, before: 0 };
    const keep = rows.filter((x) => !(Date.parse(x.ts) < cutAt));
    return { rows: keep, before: rows.length - keep.length };
  };

  // ── hook meter ──
  const meterPath = join(where.meterDir, `${sid}.jsonl`);
  let meter: AgentSessionResponse["meter"];
  {
    const r = readText(meterPath);
    if ("status" in r) meter = { status: r.status, path: meterPath, detail: r.detail, count: 0, skippedLines: 0, rows: [] };
    else {
      const { rows, skipped } = jsonLines(r.text);
      const out: MeterRow[] = [];
      for (const { v } of rows) {
        if (typeof v.ts !== "string" || typeof v.hook !== "string") continue;
        out.push({
          ts: v.ts,
          hook: v.hook,
          event: typeof v.event === "string" ? v.event : "?",
          bytes: typeof v.bytes === "number" ? v.bytes : 0,
          ms: typeof v.ms === "number" ? v.ms : undefined,
          outcome: typeof v.outcome === "string" ? v.outcome : "?",
          why: typeof v.why === "string" ? v.why : undefined,
        });
      }
      const w = inWindow(out);
      meter = { status: status(out.length, skipped), path: meterPath, count: w.rows.length, total: out.length, beforeWindow: w.before, skippedLines: skipped, modifiedAt: r.modifiedAt, rows: w.rows };
    }
  }

  // ── live hook log ──
  const logPath = join(where.hookLogDir, `anvi-hook-${sid}.log`);
  let hookLog: AgentSessionResponse["hookLog"];
  {
    const r = readText(logPath);
    if ("status" in r) {
      hookLog = {
        status: r.status,
        path: logPath,
        detail: r.status === "not-found" ? "no live hook log for this session (it lives in /tmp, is cleared on reboot, and is written only when the context injector matched a file)" : r.detail,
        count: 0,
        skippedLines: 0,
        rows: [],
      };
    } else {
      const { rows, skipped } = jsonLines(r.text);
      const out: HookLogRow[] = [];
      const strs = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : []);
      for (const { v } of rows) {
        if (typeof v.ts !== "string") continue;
        out.push({
          ts: v.ts,
          file: typeof v.file === "string" ? v.file : "",
          boundaries: strs(v.boundaries),
          fatality: v.fatality === true,
          patterns: strs(v.patterns),
          invariants: strs(v.invariants),
        });
      }
      const w = inWindow(out);
      hookLog = { status: status(out.length, skipped), path: logPath, count: w.rows.length, total: out.length, beforeWindow: w.before, skippedLines: skipped, modifiedAt: r.modifiedAt, rows: w.rows };
    }
  }

  return { timezone: "UTC", sessionId: sid, readAt, transcript, meter, hookLog };
}
