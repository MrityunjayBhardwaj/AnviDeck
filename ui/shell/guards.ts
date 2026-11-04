/**
 * The "Guards" indicator (#80): what protects this server today, and what is still to come.
 * It states only guards that are on `main`; each names the code that enforces it. The token
 * on every write and the action log are #76's, so the pill does not say "Guards on" until
 * they are in.
 */

export interface Guard {
  what: string;
  on: boolean;
  /** Where it is enforced, or the issue that builds it. */
  where: string;
}

export const GUARDS: readonly Guard[] = [
  {
    what: "Answers only this machine: Host must be a loopback name, a foreign Origin is refused",
    on: true,
    where: "server/access.ts (#66)",
  },
  {
    what: "Agent actions only from AnviDeck's own pages: a write must carry this server's Origin",
    on: true,
    where: "sameOriginWrites in server/routes/agents.ts (#75)",
  },
  { what: "A per-server token on every write", on: false, where: "arrives with #76" },
  { what: "Every action written to an action log", on: false, where: "arrives with #76" },
];

/** The pill's words: never "Guards on" while a planned guard is still off. */
export function guardsLabel(guards: readonly Guard[] = GUARDS): { text: string; state: "on" | "partial" } {
  const off = guards.filter((g) => !g.on).length;
  if (off === 0) return { text: "Guards on", state: "on" };
  return { text: `Guards: ${guards.length - off} of ${guards.length} on`, state: "partial" };
}
