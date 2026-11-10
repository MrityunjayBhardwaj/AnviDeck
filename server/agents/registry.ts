import type { AgentMode } from "../../shared/agent-modes";
import type { GithubAccess } from "../../shared/github-access";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, linkSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
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
 * The lock file is never seen empty: its token is written to a private file first and then
 * hard-linked into place, which fails if the lock exists (see lock()).
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

/** The lock could not be taken in time: another server holds it. The file itself is fine. */
export class RegistryLockedError extends Error {}

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

/**
 * When the process with this pid started (ms since epoch, to the second), from `ps -o etime=`
 * (elapsed time, so no time zone is involved). Undefined when ps could not say.
 */
export function processStartMs(pid: number, now = Date.now()): number | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  let out = "";
  try {
    const r = spawnSync("ps", ["-o", "etime=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 });
    if (r.status !== 0) return undefined;
    out = (r.stdout ?? "").trim();
  } catch {
    return undefined;
  }
  // [[dd-]hh:]mm:ss
  const m = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(out);
  if (!m) return undefined;
  const secs = Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4]);
  return now - secs * 1000;
}

/** ps reports whole seconds; a process that started this much after its owner's record is another process. */
const START_SLACK_MS = 2000;
const startCache = new Map<number, { start: number | undefined; at: number }>();

function cachedStart(pid: number): number | undefined {
  const hit = startCache.get(pid);
  if (hit && Date.now() - hit.at < 5000) return hit.start;
  const start = processStartMs(pid);
  startCache.set(pid, { start, at: Date.now() });
  return start;
}

/**
 * Is the AnviDeck server that wrote `owner` still running? Its pid must be alive AND the process
 * now holding that pid must have started no later than the server recorded itself
 * (`owner.startedAt`): a dead server's pid that the OS has given to another process (often a
 * root or system one after a reboot, which kill(pid, 0) reports as EPERM) is not that server
 * (#224). When ps cannot tell the start time, the pid check alone decides.
 */
export function ownerProcessAlive(
  owner: Pick<AgentOwner, "pid" | "startedAt">,
  startOf: (pid: number) => number | undefined = cachedStart,
): boolean {
  if (!pidAlive(owner.pid)) return false;
  const recorded = Date.parse(owner.startedAt);
  if (!Number.isFinite(recorded)) return true;
  const start = startOf(owner.pid);
  return start === undefined || start <= recorded + START_SLACK_MS;
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
  /**
   * A Claude Code process for this agent is still alive on its owner. A "done" agent can still be
   * exiting after its result; no other server may resume the session until it has (#104).
   */
  processAlive?: boolean;
  /** Why the agent is failed or stopped, in plain words. */
  reason?: string;
  /** From the init message: where the credential came from. Must be "none". */
  apiKeySource?: string;
  /** The permission mode it was started in (#249). Absent on records from before: those ran in "default". */
  mode?: AgentMode;
  /** The permission mode Claude Code reported at init on the last run, as it said it. */
  permissionMode?: string;
  /** The GitHub access its last run had (#147). Absent on records from before: those ran on your login. */
  githubAccess?: GithubAccess;
  /** What that access took out of its environment (names only). */
  githubRemoved?: string[];
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

  /** How long a write waits for another server's lock before RegistryLockedError. */
  readonly lockWaitMs: number;

  constructor(dir: string = process.env.ANVIDECK_AGENT_DIR ?? DEFAULT_AGENT_DIR, opts: { lockWaitMs?: number } = {}) {
    this.dir = dir;
    this.lockWaitMs = opts.lockWaitMs ?? 3000;
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
   * An unreadable file throws before anything is written; a lock held past `waitMs` throws
   * RegistryLockedError, also before anything is written.
   */
  update<T>(fn: (agents: AgentRecord[]) => { agents?: AgentRecord[]; out: T }, waitMs = this.lockWaitMs): T {
    this.ensureDirs();
    const release = this.lock(waitMs);
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
   * Take the lock file, waiting up to `waitMs` while another server writes.
   *
   * Taking it: our token is written to a private file, then hard-linked to the lock's name. The
   * link fails if the lock exists, and when it succeeds the lock already holds our token, so no
   * other writer can ever read it empty or half-written.
   *
   * A lock whose holder is gone (its pid is dead, it is our own pid, or it is older than
   * STALE_LOCK_MS) is taken over. A holder that cannot be read as "<pid> <time> <id>" (an older
   * AnviDeck's lock caught mid-write) counts as live until it is stale by age. A takeover is
   * itself done under a second lock (`.takeover`), so two waiters cannot both remove the stale
   * lock and then one remove the other's fresh one. The wait blocks this thread (every write
   * here is synchronous), so callers on a request path pass a short `waitMs`.
   */
  private lock(waitMs: number): () => void {
    const path = `${this.file}.lock`;
    const token = `${process.pid} ${Date.now()} ${Math.random().toString(36).slice(2)}`;
    const mine = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}`;
    writeFileSync(mine, token);
    const t0 = Date.now();
    try {
      for (;;) {
        if (Date.now() - t0 > 1000) {
          // A lock's age is its file's mtime: keep ours fresh while we wait.
          const now = new Date();
          utimesSync(mine, now, now);
        }
        try {
          linkSync(mine, path);
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
          continue; // released between our link and our read: try again
        }
        const m = /^(\d+) \d+ \S+$/.exec(holder);
        const pid = m ? Number(m[1]) : undefined;
        // Our own pid cannot be holding it: every write here is synchronous, so it is a leftover.
        const gone = pid !== undefined && (pid === process.pid || !pidAlive(pid));
        if (gone || age > STALE_LOCK_MS) {
          this.takeOver(path, holder, mine);
          continue;
        }
        if (Date.now() - t0 > waitMs) {
          throw new RegistryLockedError(
            `the agent registry is locked by ${pid !== undefined ? `AnviDeck process ${pid}` : "another AnviDeck server"} (${path}) and was not released within ${waitMs} ms`,
          );
        }
        Atomics.wait(SLEEP, 0, 0, 5);
      }
    } finally {
      try {
        unlinkSync(mine);
      } catch {
        /* already gone */
      }
    }
  }

  /** Remove the lock if it still holds `holder`, under the takeover lock. */
  private takeOver(path: string, holder: string, mine: string): void {
    const guard = `${path}.takeover`;
    try {
      linkSync(mine, guard);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      // Another waiter is taking it over. A guard this old is a crashed waiter's (it is held for microseconds).
      try {
        if (Date.now() - statSync(guard).mtimeMs > STALE_LOCK_MS) unlinkSync(guard);
      } catch {
        /* gone already */
      }
      return;
    }
    try {
      if (readFileSync(path, "utf8") === holder) unlinkSync(path);
    } catch {
      /* released meanwhile */
    } finally {
      try {
        unlinkSync(guard);
      } catch {
        /* gone already */
      }
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
