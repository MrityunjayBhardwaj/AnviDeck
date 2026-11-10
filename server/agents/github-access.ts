/**
 * Agent GitHub access (#147), the server side: the setting's file in AnviDeck's own folder, and the
 * environment each agent gets from it.
 *
 * "none" takes away every route to the owner's GitHub login that the agent's gh and git would use
 * by themselves, as observed on this machine 2026-11-10 (gh 2.87.3, git with the Command Line
 * Tools' gitconfig):
 *  - gh: token variables removed, and GH_CONFIG_DIR pointed at an empty folder, so gh does not find
 *    the account its keyring token belongs to ("You are not logged into any GitHub hosts").
 *  - git over HTTPS: the system gitconfig (credential.helper osxkeychain) is not read, and the
 *    credential helpers the user's gitconfig sets for github.com and gist.github.com are cleared.
 *  - git over SSH: ssh gets no agent and no key file, so GitHub refuses it (publickey).
 * It is not airtight: the agent's shell can still go and read the stored login on purpose (point
 * GH_CONFIG_DIR back, ask the keychain). Only a sandbox stops that, and the setting says so. Claude
 * Code also adds the `env` block of your settings.json to the agent's environment: a GitHub token
 * put there would come back (none was there on 2026-11-10).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_GITHUB_ACCESS, isGithubAccess, type GithubAccess, type GithubAccessRead } from "../../shared/github-access";

export const SETTINGS_FILE = "settings.json";

/** Variables that carry a GitHub token by themselves. */
export const GITHUB_TOKEN_VARS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"] as const;

/** git configuration given through the environment: read last, so these win over every file. */
const GIT_CLEARS: [string, string][] = [
  ["credential.helper", ""],
  ["credential.https://github.com.helper", ""],
  ["credential.https://gist.github.com.helper", ""],
];

/**
 * An empty folder for one agent's gh configuration: outside AnviDeck's store, so whatever gh writes
 * there is never committed, and one per agent, so a login one agent puts there reaches no other.
 */
export const emptyGhConfigDir = (agentId: string) => join(tmpdir(), "anvideck-agent-gh-none", agentId);

/**
 * The environment for an agent under `access`. "your-login" changes nothing. "none" returns what
 * it removed and set, names only, for the agent's record.
 */
export function withGithubAccess(
  base: Record<string, string>,
  access: GithubAccess,
  ghConfigDir: string,
): { env: Record<string, string>; removed: string[] } {
  if (access !== "none") return { env: base, removed: [] };
  const env = { ...base };
  const removed: string[] = [];
  for (const k of [...GITHUB_TOKEN_VARS, "SSH_AUTH_SOCK", "GH_CONFIG_DIR", "GIT_SSH", "GIT_SSH_COMMAND", "GIT_ASKPASS", "SSH_ASKPASS"]) {
    if (k in env) {
      delete env[k];
      removed.push(k);
    }
  }
  // Ours replace any GIT_CONFIG_* the server had: they take its numbers from 0, and git reads only GIT_CONFIG_COUNT of them.
  mkdirSync(ghConfigDir, { recursive: true });
  env.GH_CONFIG_DIR = ghConfigDir;
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_COUNT = String(GIT_CLEARS.length);
  GIT_CLEARS.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  env.GIT_SSH_COMMAND = "ssh -o IdentityAgent=none -o IdentitiesOnly=yes -o IdentityFile=/dev/null -o BatchMode=yes";
  env.GIT_TERMINAL_PROMPT = "0";
  return { env, removed: removed.sort() };
}

/** The setting, from `settings.json` in AnviDeck's own folder. No file is the default; a broken one is said, never guessed. */
export function readGithubAccess(dir: string): GithubAccessRead {
  const file = join(dir, SETTINGS_FILE);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { status: "ok", access: DEFAULT_GITHUB_ACCESS, source: "default", file };
    return { status: "unreadable", file, reason: (e as Error).message };
  }
  let j: { agentGithubAccess?: unknown; agentGithubAccessSetAt?: unknown };
  try {
    j = JSON.parse(raw);
  } catch (e) {
    return { status: "unreadable", file, reason: `it does not parse: ${(e as Error).message}` };
  }
  if (j === null || typeof j !== "object") return { status: "unreadable", file, reason: "it is not an object" };
  if (j.agentGithubAccess === undefined) return { status: "ok", access: DEFAULT_GITHUB_ACCESS, source: "default", file };
  if (!isGithubAccess(j.agentGithubAccess)) return { status: "unreadable", file, reason: `agentGithubAccess is ${JSON.stringify(j.agentGithubAccess)}, not one of your-login, none, bot` };
  return { status: "ok", access: j.agentGithubAccess, source: "set", file, ...(typeof j.agentGithubAccessSetAt === "string" ? { setAt: j.agentGithubAccessSetAt } : {}) };
}

/** Set it, keeping any other settings in the file. Written whole to a temporary file and renamed, so a reader never sees half of it. */
export function writeGithubAccess(dir: string, access: GithubAccess, now = new Date()): void {
  const file = join(dir, SETTINGS_FILE);
  let current: Record<string, unknown> = {};
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    if (j && typeof j === "object") current = j;
  } catch (e) {
    // A missing file starts empty; a broken one is not written over, so nothing in it is lost.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`${file} could not be read (${(e as Error).message}); fix or move it first`);
  }
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...current, agentGithubAccess: access, agentGithubAccessSetAt: now.toISOString() }, null, 2) + "\n");
  renameSync(tmp, file);
}
