/**
 * The Agents screen's model (#82). Pure: no DOM and no fetch, so tests import it directly.
 *
 * One agent's timeline is built from the lines it left:
 *   - an agent AnviDeck started: the agent host's transcript (GET /api/agents/:id; SDK frames
 *     and the host's own events: started, message-sent, permission-asked, stopped, …), live
 *     over the WebSocket;
 *   - a terminal session: Claude Code's own transcript (GET /api/agents-screen/session/:sid).
 * Both carry Claude Code's assistant and user messages in the same shape. To that are joined
 * what anvi did at each tool call, from three sources that each say how they were joined:
 *   - transcript  Claude Code's hook attachments, keyed by the tool call's id (exact);
 *   - meter       anvi's hook meter rows (hook, outcome, bytes), placed by time: a row is put on
 *                 a tool call only when exactly one call was open at that moment, else counted
 *                 as not placed;
 *   - hook-log    the context injector's live log (boundaries, patterns, invariants), placed by
 *                 file and time, else counted as not placed.
 * Nothing is dropped silently: whatever could not be placed is counted in `unplaced`.
 */
import { modeLine } from "../../shared/agent-modes";
import type { CliRecord, HookLogRow, MeterRow } from "../../shared/agents-screen-types";
import { messagesIn, type DeliveryState } from "../../shared/agent-messages";

export interface TLine {
  at: string | null;
  /** sdk: a Claude Code frame through the host; host: an event the host recorded; cli: Claude Code's transcript. */
  from: "sdk" | "host" | "cli";
  message: Record<string, unknown>;
  seq?: number;
}

export interface HookRun {
  source: "transcript" | "meter";
  /** The hook as its source names it (a script name, or Claude Code's "PreToolUse:Edit"). */
  name: string;
  event?: string;
  /** meter: silent / informed / skipped / blocked …; transcript: ran / error / cancelled. */
  outcome: string;
  bytes?: number;
  ms?: number;
  why?: string;
}

/** Context a hook gave the agent at this call, as Claude Code recorded it (exact join by tool id). */
export interface GivenContext {
  hook: string;
  text: string;
  chars: number;
}

export interface Violation {
  rule: string;
  fromFile: string;
  toFile: string;
  /** The layers (design components) on each side, as the guard named them. */
  fromLayer?: string;
  toLayer?: string;
  detail: string;
}

/** A design-guard refusal, read from the refused call's result text. */
export interface Refusal {
  file: string;
  /** The package whose structure the edit would erode. */
  pkg: string;
  designId?: string;
  violations: Violation[];
  /** The guard's first remedy, as it wrote it. */
  remedy?: string;
  /** The whole refusal, as the agent read it. */
  text: string;
}

export type ToolState = "running" | "ok" | "error" | "refused" | "blocked" | "denied" | "no-result";

export interface ToolCall {
  kind: "tool";
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** One line: what the call works on (a file, a command, a pattern). */
  target: string;
  at: string | null;
  result?: { at: string | null; isError: boolean; text: string };
  state: ToolState;
  refusal?: Refusal;
  hooks: HookRun[];
  context: GivenContext[];
  hookLog: HookLogRow[];
  /** A permission request the host parked for this call, and what became of it. */
  permission?: { requestId: string; answer?: "allow" | "deny" | "withdrawn"; message?: string; reason?: string };
  /**
   * The call started before the hook sources were read (only the newest records of Claude Code's
   * transcript and the meter rows after them are fetched): no hook run or context on it means
   * "not read", not "anvi gave nothing".
   */
  hooksUnread?: boolean;
}

export type Item =
  | { kind: "you"; at: string | null; text: string; messageId?: string; state?: DeliveryState; reason?: string; comment?: string }
  | { kind: "agent"; at: string | null; text: string }
  | ToolCall
  | { kind: "event"; at: string | null; text: string; tone: "info" | "ok" | "bad" | "warn" };

export interface PlanItem {
  text: string;
  status: "pending" | "in_progress" | "completed";
}

export interface Plan {
  source: "TodoWrite" | "TaskCreate/TaskUpdate";
  /** When the plan was last changed (the last plan call's time). */
  at: string | null;
  items: PlanItem[];
  done: number;
  total: number;
}

export interface Timeline {
  items: Item[];
  tools: ToolCall[];
  plan: Plan | null;
  refusals: { tool: ToolCall; refusal: Refusal }[];
  /** Hook context given outside any tool call (SessionStart, UserPromptSubmit): kept, listed apart. */
  sessionContext: GivenContext[];
  hookTotals: { runs: number; informed: number; bytes: number; blocked: number };
  unplaced: { meter: number; hookLog: number; context: number };
  /** Calls that started before the hook sources' window (see ToolCall.hooksUnread). */
  hooksUnread: number;
}

export interface TimelineInput {
  lines: TLine[];
  /** Claude Code's transcript hook attachments (for a host agent, only these are taken from it). */
  attachments?: CliRecord[];
  meter?: MeterRow[];
  hookLog?: HookLogRow[];
  /** The agent's folder: paths under it are shown relative. */
  cwd?: string;
  /** A Claude Code process is running for it now: calls with no result are "running", not "no result". */
  live?: boolean;
  /**
   * The hook sources (attachments, meter) were read only from this moment on (hookWindow()); calls
   * that started earlier are marked hooksUnread. Absent: they were read whole.
   */
  hooksFrom?: string | null;
}

// ── small readers ────────────────────────────────────────────────────────────────────────────

const obj = (x: unknown): Record<string, unknown> => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : {});
const str = (x: unknown): string => (typeof x === "string" ? x : "");
const ms = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : NaN);

/** A tool result's text, whatever shape Claude Code gave it. */
export function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b) => (typeof b === "string" ? b : str(obj(b).text))).filter(Boolean).join("\n");
  return content === undefined ? "" : JSON.stringify(content);
}

function rel(p: string, cwd?: string): string {
  if (cwd && p.startsWith(cwd.endsWith("/") ? cwd : `${cwd}/`)) return p.slice(cwd.length + (cwd.endsWith("/") ? 0 : 1));
  return p;
}

/** One line naming what a call works on. Display only: the full input is shown beside it. */
export function toolTarget(name: string, input: Record<string, unknown>, cwd?: string): string {
  const fp = str(input.file_path) || str(input.notebook_path) || str(input.path);
  if (fp) return rel(fp, cwd);
  if (name === "Bash") return str(input.command).split("\n")[0];
  if (str(input.pattern)) return str(input.pattern);
  if (str(input.url)) return str(input.url);
  if (name === "TodoWrite") return `plan: ${Array.isArray(input.todos) ? input.todos.length : 0} items`;
  if (str(input.subject)) return str(input.subject);
  if (str(input.description)) return str(input.description);
  const first = Object.values(input).find((v) => typeof v === "string");
  return typeof first === "string" ? first.split("\n")[0] : "";
}

// ── refusals ─────────────────────────────────────────────────────────────────────────────────

const REFUSAL_HEAD = /BLOCKED: this edit to (\S+) adds \d+ imports? that erode (.+?)'s declared structure:/;
const VIOLATION = /^[ \t]*· ([\w-]+): (\S+) -> (\S+)\n[ \t]+(.+)$/gm;

/**
 * What a refusal card sends with your call (#86, #179): keyed by the refused call's tool_use id;
 * the screen's project when it has one, else the agent's folder; and the edited file's absolute
 * path from the call's own input, which names the package whose measured answer should list the
 * key. The server finds the project from these; a card never invents one (no folder-name guess).
 */
export function refusalCallTarget(t: Pick<ToolCall, "id" | "name" | "input" | "at">, r: Pick<Refusal, "file">, project: string | null | undefined, cwd: string | undefined) {
  const p = t.input.file_path ?? t.input.notebook_path;
  const path = typeof p === "string" && p.startsWith("/") ? p : undefined;
  return {
    key: t.id,
    ...(project ? { project } : cwd ? { cwd } : {}),
    refusal: { tool: t.name, file: r.file, ...(path ? { path } : {}), ...(t.at ? { at: t.at } : {}) },
  };
}

/**
 * The design guard's refusal in a refused call's result (structure-guard-hook.js refusalText):
 * "BLOCKED: this edit to <file> adds N import(s) that erode <pkg>'s declared structure:" then
 * one "  · <rule>: <from> -> <to>" line per violation with its detail below, the design id, and
 * "Remedies:". Null when the text is not one.
 */
export function parseRefusal(text: string): Refusal | null {
  const head = REFUSAL_HEAD.exec(text);
  if (!head) return null;
  const body = text.slice(head.index);
  const violations: Violation[] = [];
  const end = body.search(/\n\((?:judged|against)|\nRemedies:/);
  const list = end === -1 ? body : body.slice(0, end);
  for (const m of list.matchAll(VIOLATION)) {
    const detail = m[4].trim();
    const layers = /^(.+?) imports (.+?)(?: \(types only\))?(?:,|$)/.exec(detail);
    violations.push({ rule: m[1], fromFile: m[2], toFile: m[3], fromLayer: layers?.[1], toLayer: layers?.[2], detail });
  }
  const remedies = body.indexOf("\nRemedies:\n");
  const remedy = remedies === -1 ? undefined : body.slice(remedies + 11).split("\n").find((l) => l.trim().startsWith("·"))?.trim().replace(/^·\s*/, "");
  return {
    file: head[1],
    pkg: head[2],
    designId: /judged under design (\w+)/.exec(body)?.[1],
    violations,
    remedy,
    text: body,
  };
}

// ── plan ─────────────────────────────────────────────────────────────────────────────────────

const PLAN_STATUS = new Set(["pending", "in_progress", "completed"]);

/**
 * The agent's plan from its own plan calls, in order: TodoWrite replaces the whole list;
 * TaskCreate adds one (its number read from the result "Task #N created", else counted);
 * TaskUpdate changes one by taskId ("deleted" removes it). Null when it made no plan call.
 */
export function planFrom(tools: ToolCall[]): Plan | null {
  let source: Plan["source"] | null = null;
  let at: string | null = null;
  let items: (PlanItem & { id?: string })[] = [];
  let created = 0;
  for (const t of tools) {
    if (t.name === "TodoWrite" && Array.isArray(t.input.todos)) {
      source = "TodoWrite";
      at = t.at;
      items = (t.input.todos as unknown[]).map((x) => {
        const o = obj(x);
        const s = str(o.status);
        return { text: str(o.content) || str(o.subject), status: (PLAN_STATUS.has(s) ? s : "pending") as PlanItem["status"] };
      });
    } else if (t.name === "TaskCreate") {
      source = "TaskCreate/TaskUpdate";
      at = t.at;
      created++;
      const id = /Task #(\d+)/.exec(t.result?.text ?? "")?.[1] ?? String(created);
      items.push({ id, text: str(t.input.subject) || str(t.input.description), status: "pending" });
    } else if (t.name === "TaskUpdate") {
      const it = items.find((i) => i.id === String(t.input.taskId));
      if (!it) continue;
      source = source ?? "TaskCreate/TaskUpdate";
      at = t.at;
      const s = str(t.input.status);
      if (s === "deleted") items = items.filter((i) => i !== it);
      else if (PLAN_STATUS.has(s)) it.status = s as PlanItem["status"];
      if (str(t.input.subject)) it.text = str(t.input.subject);
    }
  }
  if (!source) return null;
  const out = items.map(({ text, status }) => ({ text, status }));
  return { source, at, items: out, done: out.filter((i) => i.status === "completed").length, total: out.length };
}

// ── the timeline ─────────────────────────────────────────────────────────────────────────────

/** Text Claude Code puts in a user turn that the owner did not type. */
function isOwnerText(s: string): boolean {
  const t = s.trimStart();
  return t.length > 0 && !t.startsWith("<") && !t.startsWith("[Request interrupted") && !t.startsWith("Caveat:");
}

function settle(t: ToolCall, live: boolean): void {
  if (t.permission?.answer === "deny" || t.permission?.answer === "withdrawn") t.state = "denied";
  else if (!t.result) t.state = live ? "running" : "no-result";
  else if (t.refusal) t.state = "refused";
  else if (t.result.isError && /^PreToolUse:\w+ hook (?:error|blocking)/.test(t.result.text)) t.state = "blocked";
  else t.state = t.result.isError ? "error" : "ok";
}

export function buildTimeline(input: TimelineInput): Timeline {
  const items: Item[] = [];
  const tools: ToolCall[] = [];
  const byId = new Map<string, ToolCall>();
  const sessionContext: GivenContext[] = [];
  const unplaced = { meter: 0, hookLog: 0, context: 0 };
  const baseCwd = input.cwd;
  const sent = new Map(messagesIn(input.lines.map((l) => ({ at: l.at ?? "", from: l.from, message: l.message }))).map((s) => [s.messageId, s]));

  const attach = (rec: { at: string | null; attachment?: Record<string, unknown> }) => {
    const a = obj(rec.attachment);
    const toolId = str(a.toolUseID);
    const t = byId.get(toolId);
    if (a.type === "hook_additional_context") {
      const text = Array.isArray(a.content) ? a.content.map(String).join("\n") : str(a.content);
      const given = { hook: str(a.hookName) || "hook", text, chars: text.length };
      if (t) t.context.push(given);
      else if (/^(SessionStart|UserPromptSubmit|Setup)/.test(str(a.hookName)) || /^(SessionStart|UserPromptSubmit)$/.test(toolId)) sessionContext.push(given);
      else unplaced.context++;
      return;
    }
    if (!t) return; // a hook run outside a tool call (SessionStart, Stop): not a tool's
    const cmd = str(a.command);
    const name = cmd ? (cmd.match(/([\w.-]+\.(?:js|cjs|mjs|sh|py))\b/)?.[1] ?? cmd) : str(a.hookName) || "hook";
    const outcome = a.type === "hook_success" ? (str(a.stdout).trim() ? "ran, gave output" : "ran") : a.type === "hook_non_blocking_error" ? "error" : a.type === "hook_cancelled" ? "cancelled" : str(a.type).replace(/^hook_/, "");
    t.hooks.push({ source: "transcript", name, event: str(a.hookEvent) || undefined, outcome, ms: typeof a.durationMs === "number" ? a.durationMs : undefined });
  };

  for (const l of input.lines) {
    const m = l.message;
    if (l.from === "host") {
      const ev = str(m.event);
      if (ev === "started" || ev === "resumed") {
        items.push({ kind: "you", at: l.at, text: str(m.prompt) });
        if (ev === "resumed") items.push({ kind: "event", at: l.at, text: "resumed", tone: "info" });
      } else if (ev === "message-sent") {
        const s = sent.get(str(m.messageId));
        const c = obj(m.comment);
        items.push({
          kind: "you", at: l.at, text: str(m.said), messageId: str(m.messageId), state: s?.state ?? "queued", reason: s?.reason,
          comment: str(c.file) ? `${str(c.file)}:${c.line}` : undefined,
        });
      } else if (ev === "permission-asked") {
        // The call's own id when the host recorded it (#267); before that, the newest open call of
        // that tool with exactly that input. Otherwise it is shown on its own line.
        const json = JSON.stringify(m.input ?? {});
        const useId = str(m.toolUseId);
        const t = (useId ? byId.get(useId) : undefined) ?? [...tools].reverse().find((x) => !x.result && !x.permission && x.name === str(m.toolName) && JSON.stringify(x.input) === json);
        const sub = obj(m.subagent);
        const who = str(sub.id) ? `${str(sub.type) || "a subagent"} (subagent) ` : "";
        if (t && !t.permission) t.permission = { requestId: str(m.requestId) };
        else items.push({ kind: "event", at: l.at, text: `${who}asked permission for ${str(m.toolName)}`, tone: "warn" });
      } else if (ev === "permission-answered" || ev === "permission-withdrawn") {
        const t = tools.find((x) => x.permission?.requestId === str(m.requestId));
        const answer = ev === "permission-withdrawn" ? "withdrawn" : str(m.behavior) === "allow" ? "allow" : "deny";
        if (t?.permission) Object.assign(t.permission, { answer, message: str(m.message) || undefined, reason: str(m.reason) || undefined });
        else items.push({ kind: "event", at: l.at, text: `permission ${answer}${m.reason ? ` (${str(m.reason)})` : ""}`, tone: answer === "allow" ? "ok" : "warn" });
      } else if (ev === "stopped" || ev === "failed") {
        items.push({ kind: "event", at: l.at, text: `${ev}: ${str(m.reason)}`, tone: ev === "failed" ? "bad" : "info" });
      }
      continue;
    }
    if (m.type === "attachment") {
      attach({ at: l.at, attachment: obj(m.attachment) });
      continue;
    }
    if (m.type === "result" && l.from === "sdk") {
      const ok = m.subtype === "success" && !m.is_error;
      items.push({ kind: "event", at: l.at, text: ok ? "turn finished" : `turn ended: ${str(m.subtype)}`, tone: ok ? "ok" : "bad" });
      continue;
    }
    if (m.type !== "assistant" && m.type !== "user") continue;
    const content = obj(m.message).content;
    if (m.type === "user") {
      if (typeof content === "string") {
        // A host agent's prompts come from the host's own events; Claude Code's echo is not repeated.
        if (l.from === "cli" && isOwnerText(content)) items.push({ kind: "you", at: l.at, text: content });
        continue;
      }
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        const o = obj(b);
        if (o.type === "tool_result") {
          const t = byId.get(str(o.tool_use_id));
          if (!t) continue;
          const text = resultText(o.content);
          t.result = { at: l.at, isError: o.is_error === true, text };
          const r = t.result.isError || /^\s*BLOCKED: this edit to/.test(text) ? parseRefusal(text) : null;
          if (r) t.refusal = r;
        } else if (o.type === "text" && l.from === "cli" && isOwnerText(str(o.text))) {
          items.push({ kind: "you", at: l.at, text: str(o.text) });
        }
      }
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      const o = obj(b);
      if (o.type === "text" && str(o.text).trim()) items.push({ kind: "agent", at: l.at, text: str(o.text) });
      else if (o.type === "tool_use" && str(o.id) && !byId.has(str(o.id))) {
        const input = obj(o.input);
        const t: ToolCall = {
          kind: "tool", id: str(o.id), name: str(o.name), input, target: toolTarget(str(o.name), input, baseCwd),
          at: l.at, state: "running", hooks: [], context: [], hookLog: [],
        };
        items.push(t);
        tools.push(t);
        byId.set(t.id, t);
      }
    }
  }
  for (const a of input.attachments ?? []) if (a.type === "attachment") attach(a);

  // Meter rows and hook-log rows: placed by time (and file), only where the answer is unique.
  const span = (t: ToolCall) => ({ start: ms(t.at), end: t.result ? ms(t.result.at) : Infinity });
  // Calls by start time, for a binary search; a call whose span is longer than LONG (or open) is
  // checked against every row, the rest only within LONG of the row.
  const LONG = 10 * 60_000;
  // A subagent's (Agent/Task) hook runs carry this session's id but are the subagent's own calls:
  // they are not placed on the call that started it.
  const timed = tools
    .filter((t) => t.name !== "Agent" && t.name !== "Task")
    .map((t) => ({ t, ...span(t) }))
    .filter((x) => !Number.isNaN(x.start))
    .sort((a, b) => a.start - b.start);
  const long = timed.filter((x) => !(x.end - x.start <= LONG));
  const startsAtOrBefore = (v: number) => {
    let lo = 0, hi = timed.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (timed[mid].start <= v) lo = mid + 1;
      else hi = mid;
    }
    return lo; // timed[0..lo) start at or before v
  };
  // A hook runs after its call is written: a call recorded more than SKEW after the row is not its
  // call (SKEW covers the host recording the frame a moment after Claude Code emitted it). A
  // PreToolUse row falls before the call's result; a PostToolUse row up to AFTER past it.
  const SKEW = 250;
  const AFTER = 2000;
  for (const r of input.meter ?? []) {
    const at = ms(r.ts);
    if (r.event !== "PreToolUse" && r.event !== "PostToolUse") continue; // a session hook, not a tool call's
    const pre = r.event === "PreToolUse";
    const fits = (x: { start: number; end: number }) => at >= x.start - SKEW && (pre ? at <= x.end : at <= x.end + AFTER);
    const open = new Set<ToolCall>();
    for (let i = startsAtOrBefore(at + SKEW) - 1; i >= 0 && timed[i].start >= at - LONG - AFTER; i--) if (fits(timed[i])) open.add(timed[i].t);
    for (const x of long) if (fits(x)) open.add(x.t);
    if (open.size === 1) [...open][0].hooks.push({ source: "meter", name: r.hook, event: r.event, outcome: r.outcome, bytes: r.bytes, ms: r.ms, why: r.why });
    else unplaced.meter++;
  }
  for (const r of input.hookLog ?? []) {
    const at = ms(r.ts);
    const fits = tools.filter((t) => {
      const fp = str(t.input.file_path);
      if (!fp || !r.file || !(fp === r.file || fp.endsWith(`/${r.file}`))) return false;
      const s = span(t);
      return at >= s.start - SKEW && at <= s.end + 500;
    });
    // Several edits of one file in the window: the nearest call that started before the row.
    const best = fits.sort((a, b) => Math.abs(at - ms(a.at)) - Math.abs(at - ms(b.at)))[0];
    if (best) best.hookLog.push(r);
    else unplaced.hookLog++;
  }

  for (const t of tools) settle(t, input.live === true);
  const from = ms(input.hooksFrom);
  let hooksUnread = 0;
  if (!Number.isNaN(from)) {
    for (const t of tools) {
      if (ms(t.at) < from) {
        t.hooksUnread = true;
        hooksUnread++;
      }
    }
  }
  const hookTotals = { runs: 0, informed: 0, bytes: 0, blocked: 0 };
  for (const t of tools) {
    for (const h of t.hooks) {
      if (h.source !== "meter") continue;
      hookTotals.runs++;
      if (h.outcome === "informed") hookTotals.informed++;
      if (h.outcome === "blocked") hookTotals.blocked++;
      hookTotals.bytes += h.bytes ?? 0;
    }
  }
  return {
    items,
    tools,
    plan: planFrom(tools),
    refusals: tools.filter((t) => t.refusal).map((t) => ({ tool: t, refusal: t.refusal! })),
    sessionContext,
    hookTotals,
    unplaced,
    hooksUnread,
  };
}

/**
 * Where the hook sources start when only the newest records were read: the earliest record's
 * time. null when the transcript was read whole (or nothing was read), so no call is marked.
 */
export function hookWindow(t: { count: number; total?: number; records: { at: string | null }[] }): { from: string; count: number; total: number } | null {
  if (t.total === undefined || t.total <= t.count) return null;
  let from: string | null = null;
  for (const r of t.records) if (r.at && (from === null || ms(r.at) < ms(from))) from = r.at;
  return from ? { from, count: t.count, total: t.total } : null;
}

// ── an AnviDeck agent's host transcript, as it arrives ─────────────────────────────────────

/**
 * The host transcript of one agent on the page. Lines that arrive over the WebSocket while it is
 * being read (or after a read failed) are kept in `early` and merged into the answer, so a line
 * the server recorded after building its answer is not lost.
 */
export type HostLoad =
  | { state: "loading"; early: TLine[] }
  | { state: "ok"; lines: TLine[]; unreadable: number; readAt: string }
  | { state: "error"; error: string; early: TLine[] };

/** Union by seq, in seq order; a line without seq is kept once, by its place. */
export function mergeHostLines(a: TLine[], b: TLine[]): TLine[] {
  const bySeq = new Map<number, TLine>();
  const loose: TLine[] = [];
  for (const l of [...a, ...b]) {
    if (typeof l.seq !== "number") loose.push(l);
    else if (!bySeq.has(l.seq)) bySeq.set(l.seq, l);
  }
  return [...[...bySeq.values()].sort((x, y) => x.seq! - y.seq!), ...loose];
}

/** A line arrived over the WebSocket. Returns the new state (null: nothing to keep it in yet). */
export function hostLineArrived(h: HostLoad | undefined, line: TLine): HostLoad | null {
  if (!h) return null; // the screen has not asked for this agent: its read will include the line
  if (h.state === "ok") return h.lines.some((l) => l.seq === line.seq) ? h : { ...h, lines: mergeHostLines(h.lines, [line]) };
  return { ...h, early: mergeHostLines(h.early, [line]) };
}

/** A read of GET /api/agents/:id answered: merged with what arrived meanwhile and what was shown. */
export function hostReadDone(h: HostLoad | undefined, fetched: TLine[], unreadable: number, readAt: string): HostLoad {
  const had = !h ? [] : h.state === "ok" ? h.lines : h.early;
  return { state: "ok", lines: mergeHostLines(fetched, had), unreadable, readAt };
}

/** A read failed: an earlier answer is kept (and the failure only logged); else the error shows. */
export function hostReadFailed(h: HostLoad | undefined, error: string): HostLoad {
  if (h?.state === "ok") return h;
  return { state: "error", error, early: h ? h.early : [] };
}

/** The host transcript's line in Sources: lines it could not read make it partial, never complete. */
export function hostSourceLine(h: HostLoad | undefined, id: string): { text: string; tone: "ok" | "neutral" | "bad" | "warn" } {
  if (!h || h.state === "loading") return { text: "reading…", tone: "neutral" };
  if (h.state === "error") return { text: `could not read: ${h.error}`, tone: "bad" };
  const n = `${h.lines.length} line${h.lines.length === 1 ? "" : "s"}`;
  if (h.unreadable > 0) return { text: `${n}; ${h.unreadable} line${h.unreadable === 1 ? "" : "s"} could not be read, so events may be missing (GET /api/agents/${id}, live)`, tone: "warn" };
  return { text: `${n} (GET /api/agents/${id}, live)`, tone: "ok" };
}

// ── keeping the cursor where it was across a repaint ────────────────────────────────────────

/** The parts of a focused element the screen uses (structural, so the rule is testable without a DOM). */
export interface FocusTarget {
  isConnected: boolean;
  focus(o?: { preventScroll?: boolean }): void;
  selectionStart?: number | null;
  selectionEnd?: number | null;
  setSelectionRange?(start: number, end: number): void;
}
export interface SavedFocus {
  el: FocusTarget;
  start: number | null;
  end: number | null;
}

/**
 * After a repaint: give focus back to the element the owner was typing in, if the repaint (or
 * a card moved by another screen) took it away. Only when focus fell to nothing (the body): if
 * the owner moved to something else, that stays. Returns whether focus was given back.
 */
export function restoreFocus(saved: SavedFocus | null, active: unknown, body: unknown): boolean {
  if (!saved || !saved.el.isConnected || active === saved.el) return false;
  if (active !== null && active !== undefined && active !== body) return false;
  saved.el.focus({ preventScroll: true });
  if (saved.start !== null && saved.end !== null && saved.el.setSelectionRange) {
    try {
      saved.el.setSelectionRange(saved.start, saved.end);
    } catch {
      // an input type without a selection (checkbox, button): focus alone
    }
  }
  return true;
}

// ── tabs and grid ────────────────────────────────────────────────────────────────────────────

/** The fields of the host's AgentView the screen reads (server/agents/host.ts). */
export interface HostAgent {
  id: string;
  status: string;
  cwd: string;
  prompt: string;
  issue?: number;
  sessionId?: string;
  reason?: string;
  running: boolean;
  /** Another AnviDeck server sharing the registry runs it (#104): act on it there. */
  runsElsewhere?: { pid: number; port?: number };
  createdAt: string;
  updatedAt: string;
  model?: string;
  claudeCodeVersion?: string;
  apiKeySource?: string;
  /** The permission mode it was started in, and the one Claude Code reported (#249). */
  mode?: string;
  permissionMode?: string;
  /** The GitHub access its last run had (#147). */
  githubAccess?: string;
  costEstimateUsd?: number;
  /** How many runs it has had (start, then each resume). */
  runs?: number;
  pendingPermissions: { requestId: string; toolName: string; input: Record<string, unknown>; askedAt: string; decisionReason?: string; blockedPath?: string; toolUseId?: string; subagent?: { id: string; type?: string; description?: string } }[];
}

/** A session started in a terminal, listed by the replay reader (GET /api/replay/sessions). */
export interface TerminalSession {
  sessionId: string;
  project: string;
  cwd: string | null;
  lastTs: string | null;
  modifiedAt: string;
}

export interface AgentTab {
  key: string;
  kind: "host" | "terminal";
  /** The id to open: an agent id, or a Claude Code session id. */
  id: string;
  label: string;
  /** The dot's meaning. */
  tone: "waiting" | "working" | "done" | "failed" | "stopped" | "view";
  status: string;
  /** Runs in Full access (#249): marked on its tab as on its card. */
  fullAccess?: boolean;
}

/** Most urgent first: an agent waiting on you, then working, then failed, done, stopped. */
const URGENCY: Record<string, number> = { waiting: 0, starting: 1, working: 1, failed: 2, done: 3, stopped: 4 };

export function hostTone(a: HostAgent): AgentTab["tone"] {
  if (a.pendingPermissions.length > 0 || a.status === "waiting") return "waiting";
  if (a.status === "starting" || a.status === "working") return "working";
  if (a.status === "failed") return "failed";
  if (a.status === "done") return "done";
  return "stopped";
}

/** A short label for an agent: its issue and the first words of its prompt. */
export function agentLabel(a: Pick<HostAgent, "issue" | "prompt" | "id">): string {
  const words = a.prompt.replace(/\s+/g, " ").trim();
  const head = words.length > 42 ? `${words.slice(0, 41)}…` : words;
  return `${a.issue ? `#${a.issue} · ` : ""}${head || a.id}`;
}

export function sortHostAgents(agents: HostAgent[]): HostAgent[] {
  const u = (a: HostAgent) => (a.pendingPermissions.length ? 0 : (URGENCY[a.status] ?? 5));
  return [...agents].sort((x, y) => u(x) - u(y) || y.createdAt.localeCompare(x.createdAt));
}

/** One tab per AnviDeck agent (most urgent first), then the project's terminal sessions, view only. */
export function agentTabs(agents: HostAgent[], terminals: TerminalSession[]): AgentTab[] {
  const tabs: AgentTab[] = sortHostAgents(agents).map((a) => ({
    key: `agent:${a.id}`,
    kind: "host",
    id: a.id,
    label: agentLabel(a),
    tone: hostTone(a),
    status: a.pendingPermissions.length ? `waiting on you (${a.pendingPermissions.length})` : a.status,
    ...(modeLine(a.mode, a.permissionMode).wide ? { fullAccess: true } : {}),
  }));
  // A session AnviDeck started also has a Claude Code transcript: it is listed once, as the agent.
  const started = new Set(agents.map((a) => a.sessionId).filter((s): s is string => !!s));
  for (const s of terminals) {
    if (started.has(s.sessionId)) continue;
    const last = s.lastTs ?? s.modifiedAt;
    tabs.push({
      key: `session:${s.sessionId}`, kind: "terminal", id: s.sessionId,
      label: `${s.sessionId.slice(0, 8)} · ${last ? `${last.slice(5, 10)} ${last.slice(11, 16)}` : "terminal"}`, tone: "view", status: "view only",
    });
  }
  return tabs;
}

/** The grid: up to four of AnviDeck's agents, running ones first. */
export const GRID_MAX = 4;
export function gridAgents(agents: HostAgent[]): HostAgent[] {
  const sorted = sortHostAgents(agents);
  return [...sorted.filter((a) => a.running), ...sorted.filter((a) => !a.running)].slice(0, GRID_MAX);
}

/**
 * How one source reads on screen. Absence and failure are kept apart per source: the transcript
 * missing means the screen could not read the agent (red), while a missing hook meter or hook log
 * only means no such file exists for the session (not present, neutral). Unreadable is red always.
 */
export function sourceLine(
  name: "transcript" | "meter" | "hookLog",
  s: { status: string; count: number; total?: number; beforeWindow?: number; skippedLines: number; detail?: string; modifiedAt?: string },
): { text: string; tone: "ok" | "neutral" | "bad" | "warn" } {
  const unit = name === "transcript" ? "records" : "rows";
  const shown = s.total !== undefined && s.total > s.count ? `${s.count} newest of ${s.total} ${unit}` : `${s.count} ${unit}`;
  const left = s.beforeWindow ? ` (${s.beforeWindow} older left out)` : "";
  const at = s.modifiedAt ? `, changed ${s.modifiedAt.slice(0, 16).replace("T", " ")} UTC` : "";
  switch (s.status) {
    case "ok":
      return { text: `${shown}${left}${at}`, tone: "ok" };
    case "partial":
      return { text: `${shown}${left}; ${s.skippedLines} line${s.skippedLines === 1 ? "" : "s"} could not be read${at}`, tone: "warn" };
    case "none":
      return { text: `read, nothing in it${at}`, tone: "neutral" };
    case "not-found":
      return name === "transcript" ? { text: `could not read: ${s.detail ?? "not found"}`, tone: "bad" } : { text: "not present", tone: "neutral" };
    default:
      return { text: `could not read${s.detail ? `: ${s.detail}` : ""}`, tone: "bad" };
  }
}

/** "3 of 5 done" */
export function planProgress(p: Plan): string {
  return `${p.done} of ${p.total} done`;
}

/** What `#agents?…` carries. */
export interface AgentsScreenRoute {
  agent?: string;
  session?: string;
  grid: boolean;
  /** The older replay view (Agents before #82), kept until its retirement is decided. */
  replay: boolean;
}

export function parseAgentsScreenParams(params: URLSearchParams): AgentsScreenRoute {
  return {
    agent: params.get("agent") ?? undefined,
    session: params.get("session") ?? undefined,
    grid: params.get("grid") === "1",
    // The replay view's own hashes (`#agents?project=…&sid=…`, from Home, Map and the palette)
    // keep opening it: `sid` is its parameter, `session` this screen's.
    replay: params.get("view") === "replay" || params.has("sid"),
  };
}
