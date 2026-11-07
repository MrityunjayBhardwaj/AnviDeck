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
  | { state: "ok"; agents: StripAgent[] }
  /** The server answered that the agent host is off (503 with its reason). */
  | { state: "off"; reason: string }
  /** The request itself failed: we could not look. Never shown as "0 agents". */
  | { state: "failed"; reason: string };

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
  return `${plural(c.total, "agent", "agents")} · ${c.working} working · ${c.waiting} waiting on you${c.elsewhere ? ` · ${c.elsewhere} in other servers` : ""}`;
}

/** The hover text: where the figures come from and what they leave out. */
export function activityTitle(read: AgentsRead): string {
  const src = "From GET /api/agents: agents AnviDeck started (all statuses, done and stopped included).";
  if (read.state === "off") return `${src} The server said: ${read.reason}`;
  if (read.state === "failed") return `${src} The request failed: ${read.reason}`;
  if (read.state === "loading") return src;
  const c = activityCounts(read.agents);
  return `${src} Waiting on you = agents with a permission request parked (${c.waiting} now); answer them on Home or on the agent's row at /agent-host. Working and waiting count only this server's agents; ${c.elsewhere} run in other AnviDeck servers sharing the registry.`;
}
