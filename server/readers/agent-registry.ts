/**
 * AnviDeck's agent registry (`agents.json` in its own folder), read for the readers that need to
 * know which Claude Code sessions are AnviDeck's agents: Changes (which agent made a PR) and Home
 * (a live session that is an AnviDeck agent is shown as the agent, not as a terminal session, #252).
 *
 * The folder follows the same rule as server/agents/registry.ts (DEFAULT_AGENT_DIR), which a reader
 * may not import (tests/reader-actor-split.test.ts). Read here, never written.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { errText, isAbsent } from "./read-status";

export const AGENT_DIR = () => process.env.ANVIDECK_AGENT_DIR ?? join(homedir(), ".anvideck", "anvideck");

export interface RegistryAgent {
  id: string;
  sessionId?: string;
  cwd: string;
  issue?: number;
}

export interface RegistryRead {
  path: string;
  status: "read" | "absent" | "unreadable";
  reason?: string;
  agents: RegistryAgent[];
}

export function readAgentRegistry(): RegistryRead {
  const path = join(AGENT_DIR(), "agents.json");
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const agents = Array.isArray(raw?.agents) ? (raw.agents as RegistryAgent[]) : [];
    return { path, status: "read", agents };
  } catch (e) {
    if (isAbsent(e)) return { path, status: "absent", agents: [] };
    return { path, status: "unreadable", reason: errText(path, e), agents: [] };
  }
}
