/**
 * The "Guards" indicator (#80): what protects this server today, and what is still to come.
 * It states only guards that are on `main`; each names the file and the code that enforce it,
 * and a test reads that file, so a guard cannot be called on after its code moves or goes.
 */

export interface Guard {
  what: string;
  on: boolean;
  /** Where it is enforced (or the issue that builds it), as shown to the reader. */
  where: string;
  /** For a guard that is on: the file and the text in it that enforces it. */
  code?: { file: string; has: string };
}

export const GUARDS: readonly Guard[] = [
  {
    what: "Answers only this machine: Host must be a loopback name, a foreign Origin is refused",
    on: true,
    where: "server/access.ts (#66)",
    code: { file: "server/access.ts", has: "export function localOnly" },
  },
  {
    what: "Nothing sent over HTTP can act: every write is refused there; actions come only from the desktop app's window, over its private channel",
    on: true,
    where: "writesOnlyFromApp in server/guard.ts, dispatch in server/desktop.ts (#241)",
    code: { file: "server/guard.ts", has: "export function writesOnlyFromApp" },
  },
  {
    what: "Every write written to an action log, refused ones included",
    on: true,
    where: "logWrites in server/guard.ts, ActionLog in server/action-log.ts (#76)",
    code: { file: "server/action-log.ts", has: "export class ActionLog" },
  },
];

/** The pill's words: never "Guards on" while a planned guard is still off. */
export function guardsLabel(guards: readonly Guard[] = GUARDS): { text: string; state: "on" | "partial" } {
  const off = guards.filter((g) => !g.on).length;
  if (off === 0) return { text: "Guards on", state: "on" };
  return { text: `Guards: ${guards.length - off} of ${guards.length} on`, state: "partial" };
}
