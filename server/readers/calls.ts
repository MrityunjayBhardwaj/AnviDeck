/**
 * Your calls on blocked edits (#86), read from calls.jsonl in AnviDeck's own folder.
 *
 * Read-only: server/calls.ts appends the lines (behind the write guard and the action log); this
 * only reads the file. The latest call on a refusal wins and the earlier ones are kept as its
 * history. A line that is not a call (torn by a crash, or damaged) is counted in
 * `unreadableLines`, never dropped silently; a file that cannot be read at all is `unreadable`,
 * never "no calls".
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CallRecord, CallsRead, CallState } from "../../shared/refusal-types";

/**
 * AnviDeck's own folder. Same rule as server/agents/registry.ts (DEFAULT_AGENT_DIR), which a
 * reader may not import (tests/reader-actor-split.test.ts); read here, never written.
 */
export const callsDir = () => process.env.ANVIDECK_AGENT_DIR ?? join(homedir(), ".anvideck", "anvideck");
export const CALLS_FILE = "calls.jsonl";
export const callsPath = (dir: string = callsDir()) => join(dir, CALLS_FILE);

/** A line of calls.jsonl that is a call; anything else is an unreadable line. */
export function isCall(r: unknown): r is CallRecord {
  const o = r as Record<string, unknown>;
  return !!o && typeof o === "object" && typeof o.at === "string" && typeof o.key === "string" && o.key !== "" &&
    typeof o.project === "string" && (o.call === "right" || o.call === "wrong") &&
    (o.note === undefined || typeof o.note === "string") &&
    (o.unverified === undefined || typeof o.unverified === "string") && (o.projectFrom === undefined || typeof o.projectFrom === "string");
}

/** Group calls (in the order recorded) by refusal key: the last one is the call, the rest its history. */
export function byKey(calls: CallRecord[]): Record<string, CallState> {
  const out: Record<string, CallState> = {};
  for (const c of calls) {
    const s = out[c.key];
    if (!s) out[c.key] = { latest: c, earlier: [] };
    else {
      s.earlier.push(s.latest);
      s.latest = c;
    }
  }
  return out;
}

export function readCalls(opts: { dir?: string; project?: string | null; key?: string | null } = {}): CallsRead {
  const file = callsPath(opts.dir ?? callsDir());
  const readAt = new Date().toISOString();
  const empty = { file, lines: 0, unreadableLines: 0, unverified: 0, calls: [], byKey: {}, readAt };
  if (!existsSync(file)) return { ...empty, exists: false, status: "none" };
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    return { ...empty, exists: true, status: "unreadable", error: `${file}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}` };
  }
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  const all: CallRecord[] = [];
  let unreadable = 0;
  for (const l of lines) {
    try {
      const r = JSON.parse(l);
      if (isCall(r)) all.push(r);
      else unreadable++;
    } catch {
      unreadable++;
    }
  }
  const calls = all.filter((c) => (!opts.project || c.project === opts.project) && (!opts.key || c.key === opts.key));
  return {
    file,
    exists: true,
    status: unreadable ? (all.length ? "partial" : "unreadable") : all.length ? "ok" : "none",
    ...(unreadable && !all.length ? { error: `none of the ${lines.length} lines in ${file} is a call` } : {}),
    lines: lines.length,
    unreadableLines: unreadable,
    unverified: calls.filter((c) => typeof c.unverified === "string").length,
    calls,
    byKey: byKey(calls),
    readAt,
  };
}
