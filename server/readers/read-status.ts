import type { ReadReport } from "../../shared/types";

/** True for "the thing is not there" (as opposed to "it is there but I could not read it"). */
export function isAbsent(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** "<path>: <errno code>" (e.g. EACCES), or the message when there is no code. */
export function errText(path: string, e: unknown): string {
  const err = e as NodeJS.ErrnoException;
  return `${path}: ${err?.code ?? err?.message ?? String(e)}`;
}

/**
 * Build a report from what a reader found:
 *   none       — the location is absent or holds nothing (nothing found)
 *   ok         — items were read and nothing failed
 *   partial    — some items were read, some could not be (errors say which)
 *   unreadable — nothing could be read because reading failed
 */
export function report(found: number, errors: string[], path?: string): ReadReport {
  const status: ReadReport["status"] = errors.length
    ? found > 0
      ? "partial"
      : "unreadable"
    : found > 0
      ? "ok"
      : "none";
  return { status, ...(path ? { path } : {}), errors };
}
