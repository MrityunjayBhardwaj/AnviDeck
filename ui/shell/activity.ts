/**
 * The activity strip's counts (#80), from GET /api/agents: the agents AnviDeck started.
 * Pure, so tests check the wording and the counts.
 *
 * "Waiting on you" is an agent with a permission request parked by the host. They are answered
 * on Home and on the agent's row of /agent-host (#77).
 */

/** The fields of the host's AgentView this strip reads (server/agents/host.ts). */
export interface StripAgent {
  id: string;
  status: string;
  cwd: string;
  prompt: string;
  issue?: number;
  sessionId?: string;
  pendingPermissions: unknown[];
  /** Another AnviDeck server runs it (#104): counted apart, never as working here. */
  runsElsewhere?: { pid: number; port?: number };
}

export type AgentsRead =
  | { state: "loading" }
  /**
   * `unfollowed`: this server cannot read the shared registry (#297), so other servers' agents
   * are not followed: pushed by the server's watch (with `since`, its last good read), or said by
   * a list read that could only list this server's own agents.
   */
  | { state: "ok"; agents: StripAgent[]; unfollowed?: Unfollowed }
  /** The server answered that the agent host is off (503 with its reason). */
  | { state: "off"; reason: string }
  /** The request itself failed: we could not look. Never shown as "0 agents". */
  | { state: "failed"; reason: string };

export interface Unfollowed {
  reason: string;
  since?: string;
}

/** "since 15:07:47" in local time, or nothing when the server never read the registry. */
const sinceText = (u: Unfollowed) => (u.since && !Number.isNaN(Date.parse(u.since)) ? ` since ${new Date(u.since).toLocaleTimeString([], { hour12: false })}` : "");

/** The note on a row that may have changed unseen, and on the Agents screen's host line (#297). */
export function unfollowedText(u: Unfollowed): string {
  return `other AnviDeck servers' agents not followed${sinceText(u)}: ${u.reason}`;
}

/**
 * A list read while the registry cannot be read lists only this server's own agents (#297). The
 * rows of other servers' agents the page already shows are kept, marked not followed, rather
 * than dropped as if they had gone; the time of the last good read, if pushed, is kept too.
 */
export function keepUnfollowed(prev: AgentsRead, next: AgentsRead): AgentsRead {
  if (next.state !== "ok" || !next.unfollowed || prev.state !== "ok") return next;
  const listed = new Set(next.agents.map((a) => a.id));
  const kept = prev.agents.filter((a) => !listed.has(a.id));
  const since = next.unfollowed.since ?? prev.unfollowed?.since;
  return { ...next, agents: [...next.agents, ...kept], unfollowed: { ...next.unfollowed, ...(since ? { since } : {}) } };
}

export interface ActivityCounts {
  total: number;
  working: number;
  waiting: number;
  /** Run by other AnviDeck servers sharing the registry: neither working here nor answerable here. */
  elsewhere: number;
}

export function activityCounts(agents: StripAgent[]): ActivityCounts {
  const here = agents.filter((a) => !a.runsElsewhere);
  return {
    total: agents.length,
    working: here.filter((a) => a.status === "working" || a.status === "starting").length,
    waiting: here.filter((a) => a.pendingPermissions.length > 0).length,
    elsewhere: agents.length - here.length,
  };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "4 agents · 1 working · 3 waiting on you", or why there is no count. */
export function activityText(read: AgentsRead): string {
  if (read.state === "loading") return "checking agents…";
  if (read.state === "off") return "agent host off";
  if (read.state === "failed") return "could not read agents";
  const c = activityCounts(read.agents);
  return `${plural(c.total, "agent", "agents")} · ${c.working} working · ${c.waiting} waiting on you${c.elsewhere ? ` · ${c.elsewhere} in other servers` : ""}${read.unfollowed ? ` · other servers not followed${sinceText(read.unfollowed)}` : ""}`;
}

/** The hover text: where the figures come from and what they leave out. */
export function activityTitle(read: AgentsRead): string {
  const src = "From GET /api/agents: agents AnviDeck started (all statuses, done and stopped included).";
  if (read.state === "off") return `${src} The server said: ${read.reason}`;
  if (read.state === "failed") return `${src} The request failed: ${read.reason}`;
  if (read.state === "loading") return src;
  const c = activityCounts(read.agents);
  return `${src} Waiting on you = agents with a permission request parked (${c.waiting} now); answer them on Home or on the agent's row at /agent-host. Working and waiting count only this server's agents; ${c.elsewhere} run in other AnviDeck servers sharing the registry.${read.unfollowed ? ` Now: ${unfollowedText(read.unfollowed)}.` : ""}`;
}
