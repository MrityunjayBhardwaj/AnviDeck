import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { DEFAULT_AGENT_DIR } from "./agents/registry";

/**
 * The action log (#76): one JSON line per write anyone asked AnviDeck to make, accepted or
 * refused, in AnviDeck's own folder (the agent host's registry dir: ANVIDECK_AGENT_DIR, else
 * ~/.anvideck/anvideck/), file actions.jsonl.
 *
 * A line holds what was asked (method, path, area, target), how it ended (status, result,
 * the short reason AnviDeck answered) and a preview of the body (strings cut short). Never a
 * header, so never the write token. History (#90) will read it through GET /api/actions.
 */

export interface ActionRecord {
  at: string;
  method: string;
  path: string;
  /** "/api/agents/..." → "agents". */
  area: string;
  /** The thing acted on: an id from the path, or the id the answer named (a new agent). */
  target?: string;
  status: number;
  /** refused = the guard or localOnly said no (403); failed = the route answered an error. */
  result: "accepted" | "refused" | "failed";
  reason?: string;
  body?: Record<string, unknown> | string;
  /**
   * What the route itself says it acted on (set with `c.set(AUDIT_KEY, …)`), recorded whole
   * whatever the body's size: e.g. Code's edit names the file, its path on disk and the sha256
   * before and after, which the body preview cannot carry for a large edit.
   */
  detail?: Record<string, string | number>;
}

export interface ActionRead {
  file: string;
  /** false when nothing has been logged yet: "no file" is not "unreadable". */
  exists: boolean;
  /** Newest first, at most `limit`. */
  actions: ActionRecord[];
  /** Lines in the file in total (the population `actions` was taken from). */
  total: number;
  /** Lines that were not JSON; they are skipped, and counted here so a damaged log never reads as a quiet one. */
  unreadableLines: number;
  /** Set when the file exists but could not be read at all. */
  error?: string;
  /** Appends that failed since this server started, with the last reason. */
  writeFailures: { count: number; last?: string };
}

export class ActionLog {
  readonly dir: string;
  readonly file: string;
  private failures = { count: 0, last: undefined as string | undefined };

  constructor(dir: string = process.env.ANVIDECK_AGENT_DIR ?? DEFAULT_AGENT_DIR) {
    this.dir = dir;
    this.file = join(dir, "actions.jsonl");
  }

  /** Never throws: a log that cannot be written must not undo the action it records. The failure is counted and shown. */
  append(rec: ActionRecord): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(this.file, JSON.stringify(rec) + "\n");
    } catch (e) {
      this.failures.count++;
      this.failures.last = (e as Error).message;
      console.error("[actions] could not append to the action log:", (e as Error).message);
    }
  }

  read(limit: number): ActionRead {
    const base = { file: this.file, writeFailures: { ...this.failures } };
    if (!existsSync(this.file)) return { ...base, exists: false, actions: [], total: 0, unreadableLines: 0 };
    let text: string;
    try {
      text = readFileSync(this.file, "utf8");
    } catch (e) {
      return { ...base, exists: true, actions: [], total: 0, unreadableLines: 0, error: (e as Error).message };
    }
    const lines = text.split("\n").filter((l) => l.trim() !== "");
    const parsed: ActionRecord[] = [];
    let unreadable = 0;
    for (const l of lines) {
      try {
        const r = JSON.parse(l);
        if (r && typeof r === "object" && typeof r.at === "string" && typeof r.method === "string") parsed.push(r);
        else unreadable++;
      } catch {
        unreadable++;
      }
    }
    return { ...base, exists: true, actions: parsed.reverse().slice(0, limit), total: lines.length, unreadableLines: unreadable };
  }
}

export const DEFAULT_ACTION_LIMIT = 50;
export const MAX_ACTION_LIMIT = 500;

/** GET /api/actions?limit=N: the newest N actions (default 50, at most 500). */
export function actionRoutes(log: ActionLog): Hono {
  const r = new Hono();
  r.get("/", (c) => {
    const q = c.req.query("limit");
    let limit = DEFAULT_ACTION_LIMIT;
    if (q !== undefined) {
      const n = Number(q);
      if (!Number.isInteger(n) || n < 1) return c.json({ error: "limit must be a whole number of at least 1" }, 400);
      limit = Math.min(n, MAX_ACTION_LIMIT);
    }
    return c.json({ limit, ...log.read(limit) });
  });
  return r;
}
