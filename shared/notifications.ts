/**
 * Desktop notifications (#314): which moments of an agent's run need you, worded for a system
 * notification, and the setting that turns each kind on or off.
 *
 * The server compares each agent's view with the one before it (`noticesFor`) and hands what is
 * new to the desktop app, which shows it only while its window is not in front. The browser build
 * has no channel to the app, so it never notifies.
 */
import { askerOf, PLAN_TOOL, QUESTION_TOOL, type PendingPermission } from "./permission-requests";

export const NOTIFY_KINDS = ["permission", "question", "ended"] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number];
export const isNotifyKind = (v: unknown): v is NotifyKind => typeof v === "string" && (NOTIFY_KINDS as readonly string[]).includes(v);

export const NOTIFY_INFO: Record<NotifyKind, { label: string; means: string }> = {
  permission: { label: "Permission requests", means: "an agent asks to use a tool your rules do not settle" },
  question: { label: "Questions and plans", means: "an agent asks you a question or to approve its plan" },
  ended: { label: "Runs that end", means: "an agent finishes, fails, or is stopped by something other than you" },
};

/**
 * A known problem with showing notifications on this platform, said wherever you would turn them on.
 * macOS (#320, parked): the app hands each notification to macOS, which records it as presented,
 * yet nothing appears on screen, so there is nothing to click.
 */
export function notifyKnownProblem(platform: string): { issue: number; text: string } | null {
  if (platform === "darwin")
    return { issue: 320, text: "On macOS these notifications do not appear yet: macOS takes them but shows nothing (#320, parked). Keep an eye on Home or Agents instead." };
  return null;
}

export type NotifySettings = Record<NotifyKind, boolean>;
/** Every kind is on until you turn it off. */
export const DEFAULT_NOTIFY: NotifySettings = { permission: true, question: true, ended: true };

export type NotifyRead =
  | { status: "ok"; settings: NotifySettings; source: "default" | "set"; setAt?: string; file: string }
  | { status: "unreadable"; file: string; reason: string };

/** The reason a stop you asked for carries (AgentHost.stop's default): never notified. */
export const STOPPED_BY_YOU = "stopped by you";
/** Quitting the app, or stopping its server, stops every agent with these reasons: your doing too. */
export const APP_CLOSED = "AnviDeck app closed";
export const SHUT_DOWN = "AnviDeck shut down";
const BY_YOU = [STOPPED_BY_YOU, APP_CLOSED, SHUT_DOWN];

/** What a notice needs to know about an agent: a slice of the host's AgentView. */
export type NoticeAgent = {
  id: string;
  prompt: string;
  issue?: number;
  status: string;
  reason?: string;
  pendingPermissions: Pick<PendingPermission, "requestId" | "toolName" | "subagent">[];
};

export type Notice = { agentId: string; kind: NotifyKind; key: string; title: string; body: string };

const LIVE = new Set(["starting", "working", "waiting"]);

/** The agent as a notification title: its issue and the first words of its prompt. */
export function noticeTitle(a: Pick<NoticeAgent, "id" | "prompt" | "issue">): string {
  const words = a.prompt.replace(/\s+/g, " ").trim();
  const head = words.length > 60 ? `${words.slice(0, 59)}…` : words;
  return `${a.issue ? `#${a.issue} · ` : ""}${head || a.id}`;
}

const clip = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * What changed between two views of one agent that needs you: each request not in `prev`, and a
 * run that ended (live before, ended now) other than by your own Stop or by quitting the app. `prev` undefined is an agent
 * seen for the first time: its requests count, an end does not (it was not seen running).
 *
 * A request says only the tool it is for, not its input: a notification can show on a locked
 * screen, and the command or path stays on the agent's card.
 */
export function noticesFor(prev: NoticeAgent | undefined, next: NoticeAgent): Notice[] {
  const out: Notice[] = [];
  const title = noticeTitle(next);
  const seen = new Set(prev?.pendingPermissions.map((p) => p.requestId) ?? []);
  for (const p of next.pendingPermissions) {
    if (seen.has(p.requestId)) continue;
    const who = p.subagent ? askerOf(p) : "The agent";
    if (p.toolName === QUESTION_TOOL) out.push({ agentId: next.id, kind: "question", key: p.requestId, title, body: `${who} asks you a question.` });
    else if (p.toolName === PLAN_TOOL) out.push({ agentId: next.id, kind: "question", key: p.requestId, title, body: `${who} asks you to approve its plan.` });
    else out.push({ agentId: next.id, kind: "permission", key: p.requestId, title, body: `${who} asks to use ${p.toolName}.` });
  }
  if (prev && LIVE.has(prev.status) && !LIVE.has(next.status)) {
    const reason = next.reason ?? "";
    const key = `end:${next.status}:${reason}`;
    if (next.status === "done") out.push({ agentId: next.id, kind: "ended", key, title, body: "The agent finished its turn." });
    else if (next.status === "failed") out.push({ agentId: next.id, kind: "ended", key, title, body: clip(`The agent failed${reason ? `: ${reason}` : "."}`) });
    else if (next.status === "stopped" && !BY_YOU.some((r) => reason.startsWith(r))) out.push({ agentId: next.id, kind: "ended", key, title, body: clip(`The agent was stopped${reason ? `: ${reason}` : "."}`) });
  }
  return out;
}

/** Read the setting's fields out of a parsed settings file; anything not a boolean is said. */
export function readNotifyFields(j: Record<string, unknown>): { settings: NotifySettings; set: boolean; setAt?: string } | { error: string } {
  const raw = j.notifications;
  if (raw === undefined) return { settings: { ...DEFAULT_NOTIFY }, set: false };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: `notifications is ${JSON.stringify(raw)}, not an object` };
  const o = raw as Record<string, unknown>;
  const settings = { ...DEFAULT_NOTIFY };
  for (const k of NOTIFY_KINDS) {
    if (o[k] === undefined) continue;
    if (typeof o[k] !== "boolean") return { error: `notifications.${k} is ${JSON.stringify(o[k])}, not true or false` };
    settings[k] = o[k] as boolean;
  }
  return { settings, set: true, ...(typeof j.notificationsSetAt === "string" ? { setAt: j.notificationsSetAt } : {}) };
}
