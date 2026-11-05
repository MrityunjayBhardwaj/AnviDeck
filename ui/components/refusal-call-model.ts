/**
 * What a refusal's call line says (#86), kept apart from the DOM so the tests can pin it.
 * Design, Code and History use the same words through ui/components/RefusalCall.ts.
 */
import type { CallRecord, CallsRead, CallState } from "../../shared/refusal-types";

/** "2026-10-27T…" → "10-27" (UTC, as the screens' stamps are). */
export const shortDay = (iso: string): string => (/^\d{4}-(\d{2})-(\d{2})/.exec(iso) ?? [])
  .slice(1).join("-") || iso;

export type CallsLoad = { state: "loading" } | { state: "ok"; data: CallsRead } | { state: "error"; error: string };

export interface CallLine {
  /** The one line shown: "your call 10-27: right", "no call yet", or why it cannot be told. */
  text: string;
  tone: "ok" | "bad" | "none" | "warn";
  note?: string;
  /** Earlier calls on the same refusal, oldest first: "10-25 wrong". */
  earlier: string[];
  /** Said beside the call when the file had lines that are not calls. */
  damaged?: string;
}

const verdict = (c: CallRecord) => `your call ${shortDay(c.at)}: ${c.call}`;

/**
 * The call on one refusal. A calls file that could not be read never says "no call yet": a call
 * you made may be in it.
 */
export function callLine(load: CallsLoad, key: string): CallLine {
  if (load.state === "loading") return { text: "your call: reading…", tone: "none", earlier: [] };
  if (load.state === "error") return { text: `your calls could not be read (${load.error}); a call you made may not show here`, tone: "warn", earlier: [] };
  const d = load.data;
  if (d.status === "unreadable") return { text: `your calls could not be read (${d.error ?? d.file}); a call you made may not show here`, tone: "warn", earlier: [] };
  const damaged = d.unreadableLines ? `${d.unreadableLines} of ${d.lines} lines in ${d.file} are not calls and were skipped` : undefined;
  const s: CallState | undefined = d.byKey[key];
  if (!s) return { text: "no call yet", tone: "none", earlier: [], ...(damaged ? { damaged } : {}) };
  return {
    text: verdict(s.latest),
    tone: s.latest.call === "right" ? "ok" : "bad",
    ...(s.latest.note ? { note: s.latest.note } : {}),
    earlier: s.earlier.map((c) => `${shortDay(c.at)} ${c.call}${c.note ? ` ("${c.note}")` : ""}`),
    ...(damaged ? { damaged } : {}),
  };
}

/** Add a call the server just recorded to what the page holds, the same way the reader groups them. */
export function withRecorded(d: CallsRead, rec: CallRecord): CallsRead {
  const prev = d.byKey[rec.key];
  return {
    ...d,
    exists: true,
    status: d.status === "none" ? "ok" : d.status,
    lines: d.lines + 1,
    calls: [...d.calls, rec],
    byKey: { ...d.byKey, [rec.key]: prev ? { latest: rec, earlier: [...prev.earlier, prev.latest] } : { latest: rec, earlier: [] } },
  };
}
