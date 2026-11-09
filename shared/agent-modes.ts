/**
 * Permission modes for an agent AnviDeck starts (#249): chosen when you start it, capped on this
 * machine. Each maps onto the Claude Agent SDK's own `permissionMode`
 * (@anthropic-ai/claude-agent-sdk 0.3.318, sdk.d.ts `PermissionMode`; `bypassPermissions` also
 * needs `allowDangerouslySkipPermissions: true`, sdk.d.ts `Options`).
 *
 * The model-classifier mode (`auto`) is not offered: it would only be, once every decision it
 * makes is shown and logged.
 *
 * Shared by the server (which enforces the cap) and the start dialogs (which only show it).
 */

export type AgentMode = "plan" | "dontAsk" | "default" | "acceptEdits" | "bypassPermissions";

export interface ModeInfo {
  mode: AgentMode;
  label: string;
  /** What the agent may do without asking you, in one sentence. */
  behaviour: string;
}

/** Narrowest first: a cap allows its own mode and every one before it. */
export const MODES: readonly ModeInfo[] = [
  { mode: "plan", label: "Plan only", behaviour: "plans and runs no tools" },
  { mode: "dontAsk", label: "Only what my rules allow", behaviour: "anything your rules don't pre-approve is denied; nothing waits for you" },
  { mode: "default", label: "Ask me", behaviour: "your rules, and Allow / Deny for anything they don't cover" },
  { mode: "acceptEdits", label: "Accept edits", behaviour: "file edits go through without asking; commands still ask" },
  {
    mode: "bypassPermissions",
    label: "Full access",
    behaviour: "every tool call runs without asking, and only your deny rules still stop one: it can run any command, change any file, and push or merge on GitHub as you",
  },
];

export const DEFAULT_MODE: AgentMode = "default";
/** Full access stays off until you raise the cap on purpose. */
export const DEFAULT_MODE_CAP: AgentMode = "acceptEdits";
export const MODE_CAP_ENV = "ANVIDECK_AGENT_MODE_CAP";

export const isAgentMode = (x: unknown): x is AgentMode => typeof x === "string" && MODES.some((m) => m.mode === x);
export const rank = (m: AgentMode): number => MODES.findIndex((x) => x.mode === m);
export const modeInfo = (m: AgentMode): ModeInfo => MODES[rank(m)]!;

export interface ModeCap {
  cap: AgentMode;
  /** Where the cap came from, said beside it. */
  from: string;
  /** Set when the variable held something that is not a mode: the cap fell back to the default. */
  invalid?: string;
}

/** The cap on this machine. A value that is not a mode falls back to the default and says so, never to Full access. */
export function modeCapFrom(v: string | undefined): ModeCap {
  const raw = v?.trim();
  if (!raw) return { cap: DEFAULT_MODE_CAP, from: `the default (set ${MODE_CAP_ENV} to change it)` };
  if (isAgentMode(raw)) return { cap: raw, from: `${MODE_CAP_ENV}=${raw}` };
  return { cap: DEFAULT_MODE_CAP, from: `the default, because ${MODE_CAP_ENV}=${raw} is not a mode`, invalid: raw };
}

export interface OfferedMode extends ModeInfo {
  allowed: boolean;
  /** Why it is not allowed, when it is not. */
  why?: string;
}

/** Every mode, each saying whether the cap allows it and, if not, by what. */
export function modesOffered(c: ModeCap): OfferedMode[] {
  return MODES.map((m) =>
    rank(m.mode) <= rank(c.cap) ? { ...m, allowed: true } : { ...m, allowed: false, why: `above the cap on this machine (${modeInfo(c.cap).label}, from ${c.from})` },
  );
}

/** The words a Full access start must carry, so the server knows the confirm was shown (#249). */
export const FULL_ACCESS_CONFIRM = "I understand Full access runs every tool call without asking";

export type ModeCheck = { ok: true; mode: AgentMode } | { ok: false; status: 400 | 403; error: string };

/** The one check every start and resume goes through, on the server. */
export function checkMode(requested: unknown, c: ModeCap, confirm?: unknown): ModeCheck {
  const mode = requested === undefined || requested === null || requested === "" ? DEFAULT_MODE : requested;
  if (!isAgentMode(mode)) return { ok: false, status: 400, error: `mode must be one of ${MODES.map((m) => m.mode).join(", ")}` };
  if (rank(mode) > rank(c.cap)) return { ok: false, status: 403, error: `${modeInfo(mode).label} is ${modesOffered(c)[rank(mode)]!.why}` };
  if (mode === "bypassPermissions" && confirm !== FULL_ACCESS_CONFIRM) {
    return { ok: false, status: 400, error: `Full access needs its confirmation: send confirm "${FULL_ACCESS_CONFIRM}"` };
  }
  return { ok: true, mode };
}

/**
 * An agent's mode as its card says it (#249): the mode chosen and, once Claude Code has reported
 * it, the mode it runs in when that is narrower (a wider one is stopped at once by the host).
 * `wide` marks Full access, shown in red wherever the agent is.
 */
export function modeLine(mode: string | undefined, reported: string | undefined): { text: string; wide: boolean } {
  if (mode === undefined) return { text: "Ask me (started before modes were chosen)", wide: false };
  const chosen = isAgentMode(mode) ? modeInfo(mode).label : mode;
  const wide = mode === "bypassPermissions";
  if (reported === undefined) return { text: `${chosen} (Claude Code has not reported its mode yet)`, wide };
  if (reported === mode) return { text: chosen, wide };
  const runs = isAgentMode(reported) ? modeInfo(reported).label : reported;
  return { text: `${chosen} chosen; runs in ${runs}, as Claude Code reports (your settings can turn a wider mode off)`, wide: reported === "bypassPermissions" };
}

/**
 * What a start dialog sends for the mode picked (#249). Full access is sent only with its box
 * ticked, and a mode the cap does not allow is never sent: the dialog says why instead. The server
 * checks both again (checkMode); this only keeps the dialog honest.
 */
export function startModeBody(
  picked: string,
  confirmed: boolean,
  offered: readonly OfferedMode[] | null,
): { ok: true; body: { mode: AgentMode; confirm?: string } } | { ok: false; why: string } {
  if (!isAgentMode(picked)) return { ok: false, why: `${picked} is not a mode` };
  const o = offered?.find((m) => m.mode === picked);
  if (offered && !o) return { ok: false, why: `${modeInfo(picked).label} is not offered` };
  if (o && !o.allowed) return { ok: false, why: `${o.label} is ${o.why}` };
  if (picked === "bypassPermissions") {
    if (!confirmed) return { ok: false, why: "Full access: tick the box that says what it allows first" };
    return { ok: true, body: { mode: picked, confirm: FULL_ACCESS_CONFIRM } };
  }
  return { ok: true, body: { mode: picked } };
}
