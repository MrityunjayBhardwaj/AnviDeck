import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The on-disk record of agents AnviDeck started (#75). It lives in AnviDeck's own folder in the
 * store, never inside a project:
 *   <dir>/agents.json          one entry per agent (id, session id, folder, issue, status, ...)
 *   <dir>/agents/<id>.jsonl    every message the agent sent, one JSON object per line
 * A server restart reads both back; an agent that was live when the server went away is
 * listed as stopped, with its transcript, and can be resumed by its session id.
 */

export const DEFAULT_AGENT_DIR = join(homedir(), ".anvideck", "anvideck");

export type AgentStatus = "starting" | "working" | "waiting" | "done" | "failed" | "stopped";

/** Statuses in which a Claude Code process is (or is about to be) running for the agent. */
export const LIVE_STATUSES: ReadonlySet<AgentStatus> = new Set(["starting", "working", "waiting"]);

export interface AgentRecord {
  id: string;
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
   * Read the registry. Agents that were live when the server last stopped come back as
   * "stopped" (their process went with the server). A missing file is an empty registry;
   * an unreadable one is an error, never silently empty.
   */
  load(): AgentRecord[] {
    if (!existsSync(this.file)) return [];
    const raw = JSON.parse(readFileSync(this.file, "utf8")) as { agents?: AgentRecord[] };
    const agents = Array.isArray(raw.agents) ? raw.agents : [];
    return agents.map((a) =>
      LIVE_STATUSES.has(a.status)
        ? { ...a, status: "stopped" as const, reason: `AnviDeck restarted while this agent was ${a.status}` }
        : a,
    );
  }

  /** Write the whole registry atomically (write a temp file, then rename over). */
  save(agents: AgentRecord[]): void {
    this.ensureDirs();
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, agents }, null, 2));
    renameSync(tmp, this.file);
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
