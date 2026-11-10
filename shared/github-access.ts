/**
 * Agent GitHub access (#147): what the agents AnviDeck starts may do on GitHub. Chosen by you in a
 * setting, applied to each agent's environment when it starts or resumes, and shown on its card.
 * Shared by the server (which applies it) and the screens (which only show it).
 */

export type GithubAccess = "your-login" | "none" | "bot";

export interface GithubAccessInfo {
  access: GithubAccess;
  label: string;
  /** What an agent can do on GitHub under it, in one sentence, limits included. */
  means: string;
}

export const GITHUB_ACCESS: readonly GithubAccessInfo[] = [
  {
    access: "your-login",
    label: "Your login",
    means: "agents run on your own GitHub login: they can push, open PRs, and merge as you, and GitHub's rules cannot tell them from you",
  },
  {
    access: "none",
    label: "None",
    means:
      "GitHub and git credentials are taken out of each agent's environment, so its gh and git cannot reach your login; it commits locally. " +
      "Not airtight until agents are sandboxed: a command that goes looking for your stored login on purpose can still find it",
  },
  {
    access: "bot",
    label: "Bot account",
    means: "agents use a separate GitHub account with write access but no admin, so the branch rules apply to them",
  },
];

/** Your login, as before the setting existed: the owner's decision of 2026-11-09 (#147). */
export const DEFAULT_GITHUB_ACCESS: GithubAccess = "your-login";

export const isGithubAccess = (x: unknown): x is GithubAccess => typeof x === "string" && GITHUB_ACCESS.some((g) => g.access === x);
export const githubAccessInfo = (a: GithubAccess): GithubAccessInfo => GITHUB_ACCESS.find((g) => g.access === a)!;

/** Why an access cannot be chosen yet, or null when it can. */
export function unavailable(a: GithubAccess): string | null {
  return a === "bot" ? "not set up: it needs a separate GitHub account and its token, which AnviDeck cannot make for you yet (#147)" : null;
}

/** The setting as read from its file: what it is, or why it could not be read. */
export type GithubAccessRead =
  | { status: "ok"; access: GithubAccess; /** "set" by you, or the "default" because nothing is set. */ source: "set" | "default"; file: string; setAt?: string }
  | { status: "unreadable"; file: string; reason: string };

/** An agent's GitHub access as its card says it. Agents from before the setting ran on your login. */
export function githubAccessLine(a: string | undefined): { text: string; yours: boolean } {
  if (a === undefined) return { text: "Your login (started before this setting existed)", yours: true };
  if (!isGithubAccess(a)) return { text: `unknown: ${a}`, yours: false };
  const i = githubAccessInfo(a);
  return { text: a === "your-login" ? `${i.label}: can push and merge as you` : a === "none" ? `${i.label}: commits locally; gh and git have no login` : i.label, yours: a === "your-login" };
}
