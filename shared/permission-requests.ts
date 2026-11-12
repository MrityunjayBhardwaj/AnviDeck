/**
 * Answering an agent's permission requests (#77). Shared by the host (server/agents/host.ts),
 * its route, and the two pages that show the requests (Home and /agent-host).
 *
 * A request is parked by the host when Claude Code asks about a tool call the owner's own
 * permission rules did not settle. It stays parked until one of three things happens, each
 * written into the agent's transcript as a host event:
 *   { event: "permission-asked", requestId, toolName, input, decisionReason?, toolUseId?, subagent? }
 *   { event: "permission-answered", requestId, behavior: "allow" | "deny", message? }  you answered
 *   { event: "permission-withdrawn", requestId, reason }   the agent stopped or the call was cancelled
 * Nothing else settles a request: there is no timeout, so a request nobody answers keeps waiting
 * and is never allowed by default.
 */

/**
 * The subagent a request comes from (#267). Claude Code's permission callback carries only the
 * subagent's id (`agentID`, the same id as the `task_id` of its `task_started` message); its type
 * and description come from that message, so they are missing until it has arrived. The
 * description is the model's own words: shown as text, never trusted.
 */
export interface AskingSubagent {
  id: string;
  type?: string;
  description?: string;
}

/** A parked request as the host shows it (AgentView.pendingPermissions). */
export interface PendingPermission {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  decisionReason?: string;
  blockedPath?: string;
  askedAt: string;
  /** The tool call's own id, when Claude Code gave one. */
  toolUseId?: string;
  /** Set when a subagent of the agent asks, not the agent itself. */
  subagent?: AskingSubagent;
}

export type PermissionAnswer = { decision: "allow" } | { decision: "deny"; message: string };

export const MAX_DENY_MESSAGE_CHARS = 4_000;

/** What the agent reads when you deny without a message. */
export const DEFAULT_DENY_MESSAGE = "The user denied this request in AnviDeck.";

/** Read a POST body: `{ decision: "allow" }` or `{ decision: "deny", message? }`. Errors are plain words. */
export function parsePermissionAnswer(body: Record<string, unknown>): PermissionAnswer | { error: string } {
  const d = body.decision;
  if (d === "allow") {
    if (body.message !== undefined && body.message !== "") return { error: "a message goes with deny only; allow takes none" };
    return { decision: "allow" };
  }
  if (d === "deny") {
    if (body.message !== undefined && typeof body.message !== "string") return { error: "message must be text" };
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (message.length > MAX_DENY_MESSAGE_CHARS) return { error: `message is longer than ${MAX_DENY_MESSAGE_CHARS} characters` };
    return { decision: "deny", message: message || DEFAULT_DENY_MESSAGE };
  }
  return { error: 'decision must be "allow" or "deny"' };
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
const clip = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** "write /x/y.txt", "run `ls -la`", "use WebFetch": what the agent asks to do, in a few words. */
export function askSummary(toolName: string, input: Record<string, unknown>): string {
  const path = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path);
  switch (toolName) {
    case "Write":
      return path ? `write ${path}` : "write a file";
    case "Edit":
    case "MultiEdit":
      return path ? `edit ${path}` : "edit a file";
    case "NotebookEdit":
      return path ? `edit the notebook ${path}` : "edit a notebook";
    case "Read":
      return path ? `read ${path}` : "read a file";
    case "Bash": {
      const cmd = str(input.command);
      return cmd ? `run \`${clip(cmd.replace(/\s+/g, " "))}\`` : "run a shell command";
    }
    case "WebFetch": {
      const url = str(input.url);
      return url ? `fetch ${clip(url)}` : "fetch a web page";
    }
    case "WebSearch": {
      const q = str(input.query);
      return q ? `search the web for "${clip(q)}"` : "search the web";
    }
    default:
      return path ? `use ${toolName} on ${path}` : `use ${toolName}`;
  }
}

/**
 * Who asks, as the start of a sentence: "An agent", "Explore (subagent)", or "A subagent" when its
 * name has not arrived yet. A subagent's request is answered on its parent's card like any other.
 */
export function askerOf(p: Pick<PendingPermission, "subagent">): string {
  if (!p.subagent) return "An agent";
  const type = p.subagent.type?.trim();
  return type ? `${clip(type, 60)} (subagent)` : "A subagent";
}

/** "subagent Explore, "Find the config", id a1b2c3": the subagent in a line of detail, or "". */
export function subagentDetail(p: Pick<PendingPermission, "subagent">): string {
  const s = p.subagent;
  if (!s) return "";
  const desc = s.description?.trim();
  return `subagent ${s.type?.trim() ? clip(s.type.trim(), 60) : "(name not known yet)"}${desc ? `, "${clip(desc.replace(/\s+/g, " "), 100)}"` : ""}, id ${s.id}`;
}

/** The agent fields a request row needs (a subset of the host's AgentView). */
export interface AskingAgent {
  id: string;
  cwd: string;
  prompt: string;
  issue?: number;
  pendingPermissions: unknown[];
}

export interface QueuedRequest {
  agent: AskingAgent;
  request: PendingPermission;
}

function isPending(p: unknown): p is PendingPermission {
  if (!p || typeof p !== "object") return false;
  const o = p as Record<string, unknown>;
  // A subagent field the page cannot read makes the row unreadable: it must never pass as the agent's own ask.
  const sub = o.subagent as Record<string, unknown> | undefined;
  const optText = (v: unknown) => v === undefined || typeof v === "string";
  if (sub !== undefined && (!sub || typeof sub !== "object" || typeof sub.id !== "string" || !optText(sub.type) || !optText(sub.description))) return false;
  return typeof o.requestId === "string" && typeof o.toolName === "string" && typeof o.askedAt === "string" && !!o.input && typeof o.input === "object";
}

/**
 * Every parked request across the agents, the one waiting longest first. A row the page cannot
 * read (wrong shape) is counted in `unreadable`, never dropped silently.
 */
export function permissionQueue(agents: AskingAgent[]): { requests: QueuedRequest[]; unreadable: number } {
  const requests: QueuedRequest[] = [];
  let unreadable = 0;
  for (const agent of agents) {
    for (const p of agent.pendingPermissions ?? []) {
      if (isPending(p)) requests.push({ agent, request: p });
      else unreadable++;
    }
  }
  requests.sort((a, b) => a.request.askedAt.localeCompare(b.request.askedAt) || a.request.requestId.localeCompare(b.request.requestId));
  return { requests, unreadable };
}

/**
 * The whole input a request would run with, as the card shows it. Never shortened: Allow sends
 * exactly this input, so every character of it must be on the card (the box scrolls instead).
 */
export function requestInputText(input: Record<string, unknown>): { text: string; chars: number } {
  const text = JSON.stringify(input, null, 2) ?? "{}";
  return { text, chars: text.length };
}
