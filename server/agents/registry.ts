import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The on-disk record of agents AnviDeck started (#75). It lives in AnviDeck's own folder in the
 * store, never inside a project:
 *   <dir>/agents.json          one entry per agent (id, session id, folder, issue, status, ...)
 *   <dir>/agents/<id>.jsonl    every message the agent sent, one JSON object per line
 * A server restart reads both back; an agent that was live when its server went away is
 * listed as stopped, with its transcript, and can be resumed by its session id.
 *
 * Several AnviDeck servers may share this folder at once (the owner's on port 4000, others
 * started in worktrees; #104). So each agent names its owner, the server that runs it, and no
 * server rewrites the whole file from its memory: every write is a read-modify-write of the
 * records it changes, under a lock file (`agents.json.lock`), finished by an atomic rename.
 * Only the owner changes a running agent; another server marks it stopped only once the
 * owner's process is gone.
 */

export const DEFAULT_AGENT_DIR = join(homedir(), ".anvideck", "anvideck");

/** A lock older than this is a crashed writer's, never a live one's (writes take milliseconds). */
export const STALE_LOCK_MS = 10_000;
const SLEEP = new Int32Array(new SharedArrayBuffer(4));

export type AgentStatus = "starting" | "working" | "waiting" | "done" | "failed" | "stopped";

/** Statuses in which a Claude Code process is (or is about to be) running for the agent. */
export const LIVE_STATUSES: ReadonlySet<AgentStatus> = new Set(["starting", "working", "waiting"]);

/** The AnviDeck server that runs (or last ran) an agent. */
export interface AgentOwner {
  pid: number;
  /** The port that server listens on, so another server can say where the agent is. */
  port?: number;
  /** One per AgentHost; tells two hosts in one process apart (tests), and a restarted host from its predecessor. */
  instance: string;
  startedAt: string;
}

/** Is this process alive? EPERM means it exists but belongs to another user: alive. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface AgentRecord {
  id: string;
  /** The server that runs or last ran it. Absent on records written before #104. */
  owner?: AgentOwner;
  /** Claude Code's session id, from the agent's init message. Needed to resume. */
  sessionId?: string;
  cwd: string;
  /** The prompt that started it (first line kept short in lists). */
  prompt: string;
  issue?: number;
  status: AgentStatus;
  /** Why the agent is failed or stopped, in plain words. */
  reason?: string;
  /** From the init message: where the credential came from. Must be "none". */
  apiKeySource?: string;
  claudeCodeVersion?: string;
  model?: string;
  /** The claude binary the last run used, as PATH named it and what it pointed at. */
  claudePath?: string;
  claudeRealPath?: string;
  /** Credential variables removed from the last run's environment (names only). */
  strippedEnv?: string[];
  /** Claude Code's own usage estimate for the last run, not a bill. */
  costEstimateUsd?: number;
  createdAt: string;
  updatedAt: string;
  runs: number;
  messageCount: number;
}

export interface TranscriptLine {
  seq: number;
  at: string;
  /** "sdk" = a message from Claude Code; "host" = something AnviDeck itself recorded. */
  from: "sdk" | "host";
  message: unknown;
}

export class AgentRegistry {
  readonly dir: string;
  private readonly file: string;
  private readonly transcriptDir: string;

  constructor(dir: string = process.env.ANVIDECK_AGENT_DIR ?? DEFAULT_AGENT_DIR) {
    this.dir = dir;
    this.file = join(dir, "agents.json");
    this.transcriptDir = join(dir, "agents");
  }

  private ensureDirs(): void {
    mkdirSync(this.transcriptDir, { recursive: true });
  }

  /**
   * Read the registry as written. A missing file is an empty registry; an unreadable one is an
   * error, never silently empty. Whether a live-looking agent still runs is the host's call (it
   * knows which owners are alive), not this reader's.
   */
  load(): AgentRecord[] {
    if (!existsSync(this.file)) return [];
    const raw = JSON.parse(readFileSync(this.file, "utf8")) as { agents?: AgentRecord[] };
    return Array.isArray(raw.agents) ? raw.agents : [];
  }

  /**
   * Read-modify-write under the lock: `fn` gets the records as they are on disk now and returns
   * the records to write (`agents`, or none to write nothing) and its answer (`out`). The file is
   * never replaced from a copy held in memory, so another server's agents written since are kept.
   * An unreadable file throws before anything is written.
   */
  update<T>(fn: (agents: AgentRecord[]) => { agents?: AgentRecord[]; out: T }): T {
    this.ensureDirs();
    const release = this.lock();
    try {
      const { agents, out } = fn(this.load());
      if (agents) this.write(agents);
      return out;
    } finally {
      release();
    }
  }

  /** Write these records over theirs by id (new ones are added); every other record is kept as it is on disk. */
  upsert(...recs: AgentRecord[]): void {
    this.update((agents) => {
      const byId = new Map(recs.map((r) => [r.id, r]));
      const next = agents.map((a) => byId.get(a.id) ?? a);
      for (const r of recs) if (!agents.some((a) => a.id === r.id)) next.push(r);
      return { agents: next, out: undefined };
    });
  }

  /** The whole file, atomically (temp file, then rename over). Called only under the lock. */
  private write(agents: AgentRecord[]): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, agents }, null, 2));
    renameSync(tmp, this.file);
  }

  /**
   * Take the lock file, waiting up to `waitMs` while another server writes. A lock whose holder
   * is gone (its pid is dead, it is our own pid, or it is older than STALE_LOCK_MS) is taken
   * over. Every write here is synchronous and short, so a held lock is released in milliseconds.
   */
  private lock(waitMs = 3000): () => void {
    const path = `${this.file}.lock`;
    const token = `${process.pid} ${Date.now()} ${Math.random().toString(36).slice(2)}`;
    const t0 = Date.now();
    for (;;) {
      try {
        const fd = openSync(path, "wx");
        writeSync(fd, token);
        closeSync(fd);
        return () => {
          try {
            if (readFileSync(path, "utf8") === token) unlinkSync(path);
          } catch {
            /* already gone */
          }
        };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      let holder: string;
      let age: number;
      try {
        holder = readFileSync(path, "utf8");
        age = Date.now() - statSync(path).mtimeMs;
      } catch {
        continue; // released between our open and our read: try again
      }
      const pid = Number(holder.split(" ")[0]);
      // Our own pid cannot be holding it: every write here is synchronous, so it is a leftover.
      if (pid === process.pid || !pidAlive(pid) || age > STALE_LOCK_MS) {
        try {
          if (readFileSync(path, "utf8") === holder) unlinkSync(path);
        } catch {
          /* someone else took it over first */
        }
        continue;
      }
      if (Date.now() - t0 > waitMs) {
        throw new Error(`the agent registry is locked by AnviDeck process ${pid} (${path}) and was not released within ${waitMs} ms`);
      }
      Atomics.wait(SLEEP, 0, 0, 5);
    }
  }

  transcriptPath(id: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`bad agent id ${JSON.stringify(id)}`);
    return join(this.transcriptDir, `${id}.jsonl`);
  }

  append(id: string, line: TranscriptLine): void {
    this.ensureDirs();
    appendFileSync(this.transcriptPath(id), JSON.stringify(line) + "\n");
  }

  /** The transcript as written. A torn last line (crash mid-write) is skipped and counted. */
  readTranscript(id: string): { lines: TranscriptLine[]; unreadable: number } {
    const p = this.transcriptPath(id);
    if (!existsSync(p)) return { lines: [], unreadable: 0 };
    const lines: TranscriptLine[] = [];
    let unreadable = 0;
    for (const text of readFileSync(p, "utf8").split("\n")) {
      if (!text.trim()) continue;
      try {
        lines.push(JSON.parse(text));
      } catch {
        unreadable++;
      }
    }
    return { lines, unreadable };
  }
}
