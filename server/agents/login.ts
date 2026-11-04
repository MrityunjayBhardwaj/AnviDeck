import { realpathSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * Agents run on this machine's installed Claude Code and its claude.ai login, never on an
 * API key (#75, owner requirement 2026-11-05). This module owns the three things that make
 * that true before an agent starts: which `claude` runs, which environment it gets, and what
 * login it reports. The binding check after start is the agent's own init message
 * (`apiKeySource` must be "none"), enforced in host.ts.
 */

/**
 * Variables that would make Claude Code bill an API key, a gateway or a cloud provider instead
 * of the claude.ai login. Removed from every agent's environment (and from `claude auth status`).
 */
export const CREDENTIAL_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_FOUNDRY_RESOURCE",
  "AWS_BEARER_TOKEN_BEDROCK",
] as const;

/**
 * Variables a Claude Code session sets for its own children. When AnviDeck itself was started
 * from inside a Claude Code session they would make each agent look like that session's child;
 * an agent AnviDeck starts is its own session, as if started in a terminal.
 */
export const PARENT_SESSION_VARS = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_PID",
] as const;

export interface AgentEnv {
  env: Record<string, string>;
  /** Credential variables that were present and removed (names only, never values). */
  stripped: string[];
}

/** The environment an agent runs with: the server's own, minus credentials and parent-session links. */
export function loginOnlyEnv(source: Record<string, string | undefined> = process.env): AgentEnv {
  const drop = new Set<string>([...CREDENTIAL_VARS, ...PARENT_SESSION_VARS]);
  const env: Record<string, string> = {};
  const stripped: string[] = [];
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined) continue;
    if (drop.has(k)) {
      if ((CREDENTIAL_VARS as readonly string[]).includes(k)) stripped.push(k);
      continue;
    }
    env[k] = v;
  }
  env.CLAUDE_AGENT_SDK_CLIENT_APP = "anvideck/agent-host";
  return { env, stripped: stripped.sort() };
}

export interface ClaudeBinary {
  /** The `claude` found on PATH, as PATH names it (e.g. /opt/homebrew/bin/claude). */
  path: string;
  /** What it points at right now. */
  realPath: string;
  /**
   * Which file that is (device, inode, modified time). Claude Code updates itself by replacing
   * its install folder, so the real path can stay the same while the file under it changes
   * (observed 2026-11-05: /opt/homebrew/bin/claude vanished for about a minute, then pointed
   * at the same path again).
   */
  fileId: string;
}

function isExecutableFile(p: string): boolean {
  try {
    const s = statSync(p);
    return s.isFile() && (s.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/** Find the installed `claude` on PATH. null when there is none. */
export function resolveClaude(pathVar: string | undefined = process.env.PATH): ClaudeBinary | null {
  for (const dir of (pathVar ?? "").split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, "claude");
    if (!isExecutableFile(p)) continue;
    try {
      const realPath = realpathSync(p);
      const st = statSync(realPath);
      return { path: p, realPath, fileId: `${st.dev}:${st.ino}:${st.mtimeMs}` };
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Explain a start that failed before the agent said who it is. When the binary it was started
 * with has since been replaced or gone missing, Claude Code was updating itself: say so, and
 * that trying again will work, instead of passing on a spawn error.
 */
export function explainStartFailure(
  startedWith: ClaudeBinary,
  now: ClaudeBinary | null,
  error: string,
): string {
  if (!now || now.realPath !== startedWith.realPath || now.fileId !== startedWith.fileId) {
    return `Claude Code was updating, try again (${startedWith.path} changed while the agent started: ${error})`;
  }
  return `Could not start: ${error}`;
}

export interface LoginStatus {
  ok: boolean;
  /** e.g. "claude.ai". Never the email or org. */
  authMethod?: string;
  apiProvider?: string;
  plan?: string;
  loggedIn?: boolean;
  /** Set when the status could not be read at all ("could not look" is not "logged out"). */
  error?: string;
}

/** Keep only what the page may show from `claude auth status --json`: method and plan, not who. */
export function parseAuthStatus(stdout: string): LoginStatus {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(stdout);
  } catch {
    return { ok: false, error: "claude auth status did not print JSON" };
  }
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const loggedIn = j.loggedIn === true;
  const authMethod = str(j.authMethod);
  return {
    ok: loggedIn && authMethod === "claude.ai",
    loggedIn,
    authMethod,
    apiProvider: str(j.apiProvider),
    plan: str(j.subscriptionType),
  };
}

/** Run `claude auth status` with the same stripped environment agents get. */
export async function readLogin(claude: ClaudeBinary | null, env: Record<string, string>): Promise<LoginStatus> {
  if (!claude) return { ok: false, error: "claude is not on PATH" };
  try {
    const proc = Bun.spawn([claude.path, "auth", "status", "--json"], { env, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(), 15_000);
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    const parsed = parseAuthStatus(out);
    if (parsed.error) return { ...parsed, error: `${parsed.error} (exit ${code}${err.trim() ? `: ${err.trim().slice(0, 200)}` : ""})` };
    return parsed;
  } catch (e) {
    return { ok: false, error: `could not run claude auth status: ${(e as Error).message}` };
  }
}
