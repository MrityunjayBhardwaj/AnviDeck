import { appendFileSync, mkdirSync } from "node:fs";
import { DEFAULT_AGENT_DIR } from "./agents/registry";
import { CALLS_FILE } from "./readers/calls";
import { join } from "node:path";
import type { CallRecord, CallVerdict } from "../shared/refusal-types";

/**
 * Record your call on a blocked edit (#86): one JSON line appended to calls.jsonl in AnviDeck's
 * own folder (ANVIDECK_AGENT_DIR, else ~/.anvideck/anvideck/, beside actions.jsonl). Never a
 * project, a catalogue or memory. Earlier calls on the same refusal stay in the file; the reader
 * (server/readers/calls.ts) takes the last one as the call.
 *
 * Reached only through POST /api/refusals/:key/call, which the write guard admits only from
 * AnviDeck's own pages with this server's token, and which the action log records either way.
 */

/** A request the route answers with a status and this reason (the caller can branch on `status`). */
export class CallError extends Error {
  constructor(readonly status: 400 | 500, message: string) {
    super(message);
  }
}

export const KEY_RE = /^[A-Za-z0-9_:-]{1,200}$/;
const PROJECT_RE = /^[A-Za-z0-9._-]{1,200}$/;
export const MAX_NOTE = 2000;

const str = (v: unknown, max: number): string | undefined =>
  typeof v === "string" && v !== "" ? v.slice(0, max) : undefined;

/** Check a call's body and build the line it records. Throws CallError(400) with the reason. */
export function callFrom(key: string, body: Record<string, unknown>, now: () => Date = () => new Date()): CallRecord {
  if (!KEY_RE.test(key)) throw new CallError(400, `the refusal key ${JSON.stringify(key)} is not one this server records (letters, digits, _ : -)`);
  const project = body.project;
  if (typeof project !== "string" || !PROJECT_RE.test(project)) throw new CallError(400, "project must be a project name");
  const call = body.call;
  if (call !== "right" && call !== "wrong") throw new CallError(400, 'call must be "right" or "wrong"');
  const note = body.note;
  if (note !== undefined && note !== null && typeof note !== "string") throw new CallError(400, "note must be text");
  // A note longer than this is refused, not cut: the record must hold exactly what you wrote.
  if (typeof note === "string" && note.length > MAX_NOTE) throw new CallError(400, `note is ${note.length} characters; at most ${MAX_NOTE}`);
  const rec: CallRecord = { at: now().toISOString(), key, project, call: call as CallVerdict };
  if (typeof note === "string" && note.trim() !== "") rec.note = note;
  const r = body.refusal;
  if (r && typeof r === "object" && !Array.isArray(r)) {
    const o = r as Record<string, unknown>;
    const refusal = { session: str(o.session, 200), tool: str(o.tool, 40), file: str(o.file, 1000), at: str(o.at, 40) };
    if (Object.values(refusal).some((v) => v !== undefined)) rec.refusal = JSON.parse(JSON.stringify(refusal));
  }
  return rec;
}

export class CallStore {
  readonly dir: string;
  readonly file: string;
  constructor(dir: string = process.env.ANVIDECK_AGENT_DIR ?? DEFAULT_AGENT_DIR) {
    this.dir = dir;
    this.file = join(dir, CALLS_FILE);
  }

  /** Append one call. A failure is an error the route answers (500): a call that was not kept must not look kept. */
  append(rec: CallRecord): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(this.file, JSON.stringify(rec) + "\n");
    } catch (e) {
      throw new CallError(500, `your call was not recorded: ${this.file}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
    }
  }
}
