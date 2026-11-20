/**
 * How an agent runs besides its permission mode (#305): the model, the effort level and the extra
 * folders it may work in, as the terminal's /model, /effort and /add-dir. Each maps onto the
 * Claude Agent SDK's own option (@anthropic-ai/claude-agent-sdk 0.3.318, sdk.d.ts `Options`:
 * `model`, `effort`, `additionalDirectories`; `Query.setModel` while it runs).
 *
 * The models offered are never typed by hand: they are the list Claude Code gives for this login
 * (`supportedModels()`, sdk.d.ts `ModelInfo`), which the host keeps from the last agent that ran,
 * or reads when you press Read models.
 *
 * Shared by the server (which checks every choice) and the dialogs (which only show them).
 */

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];
export const isEffort = (x: unknown): x is Effort => typeof x === "string" && (EFFORTS as readonly string[]).includes(x);

/** Claude Code's own default model: the row `supportedModels()` calls "default", sent as no model at all. */
export const DEFAULT_MODEL = "default";

/** At most this many extra folders per agent. */
export const MAX_EXTRA_DIRS = 10;

/** One model Claude Code offers on this login (the parts of the SDK's ModelInfo the dialogs use). */
export interface ModelChoice {
  value: string;
  displayName: string;
  description?: string;
  /** The model id the value resolves to now (e.g. "sonnet" → "claude-sonnet-5-5"). */
  resolvedModel?: string;
  /** The effort levels it takes; absent when it takes none. */
  efforts?: Effort[];
}

/** The models on offer, and where and when the list was read. */
export interface ModelList {
  models: ModelChoice[];
  at: string;
  /** "agent a1b2's Claude Code", or "Read models in /path". */
  from: string;
}

/** The SDK's ModelInfo[] as ModelChoice[]: rows without a value or name are left out, never guessed. */
export function readModels(raw: unknown): ModelChoice[] {
  if (!Array.isArray(raw)) return [];
  const out: ModelChoice[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const o = r as Record<string, unknown> | null;
    if (!o || typeof o !== "object" || typeof o.value !== "string" || !o.value.trim() || seen.has(o.value)) continue;
    seen.add(o.value);
    const levels = Array.isArray(o.supportedEffortLevels) ? o.supportedEffortLevels.filter(isEffort) : [];
    out.push({
      value: o.value,
      displayName: typeof o.displayName === "string" && o.displayName.trim() ? o.displayName : o.value,
      ...(typeof o.description === "string" && o.description ? { description: o.description } : {}),
      ...(typeof o.resolvedModel === "string" && o.resolvedModel ? { resolvedModel: o.resolvedModel } : {}),
      ...(levels.length ? { efforts: levels } : {}),
    });
  }
  return out;
}

/** The parts of a start or resume body that choose how the agent runs. Undefined: not asked for. */
export interface RunOptions {
  /** A model from the list; undefined runs on Claude Code's default. */
  model?: string;
  effort?: Effort;
  /** Absolute paths, each a folder (the server checks that they exist). */
  extraDirs?: string[];
}

export type RunOptionsCheck = { ok: true; options: RunOptions } | { ok: false; status: 400 | 409; error: string };

/**
 * Check the model and effort against the list Claude Code gave, and the shape of the extra
 * folders. A model needs the list: with none read yet, only Claude Code's default can be asked
 * for. An effort the chosen model does not take is refused, not left for Claude Code to lower.
 */
export function checkRunOptions(body: { model?: unknown; effort?: unknown; extraDirs?: unknown }, list: ModelList | null, cwd?: string): RunOptionsCheck {
  const out: RunOptions = {};
  const m = body.model;
  let row: ModelChoice | undefined;
  if (m !== undefined && m !== null && m !== "" && m !== DEFAULT_MODEL) {
    if (typeof m !== "string") return { ok: false, status: 400, error: "model must be text" };
    if (!list) return { ok: false, status: 409, error: "the models Claude Code offers have not been read yet: press Read models, or start on Claude Code's default" };
    row = list.models.find((x) => x.value === m);
    if (!row) return { ok: false, status: 400, error: `${m} is not one of the models Claude Code offers on this login (${list.models.map((x) => x.value).join(", ")})` };
    out.model = m;
  } else row = list?.models.find((x) => x.value === DEFAULT_MODEL);
  const e = body.effort;
  if (e !== undefined && e !== null && e !== "") {
    if (!isEffort(e)) return { ok: false, status: 400, error: `effort must be one of ${EFFORTS.join(", ")}` };
    const name = row?.displayName ?? (out.model ? out.model : "Claude Code's default model");
    if (row && !row.efforts) return { ok: false, status: 400, error: `${name} takes no effort level` };
    if (row?.efforts && !row.efforts.includes(e)) return { ok: false, status: 400, error: `${name} takes effort ${row.efforts.join(", ")}, not ${e}` };
    out.effort = e;
  }
  const d = body.extraDirs;
  if (d !== undefined && d !== null && !(Array.isArray(d) && d.length === 0)) {
    if (!Array.isArray(d) || d.some((x) => typeof x !== "string")) return { ok: false, status: 400, error: "extraDirs must be a list of folder paths" };
    const dirs = [...new Set((d as string[]).map((x) => trimSlash(x.trim())).filter(Boolean))];
    if (dirs.length > MAX_EXTRA_DIRS) return { ok: false, status: 400, error: `at most ${MAX_EXTRA_DIRS} extra folders` };
    const rel = dirs.find((x) => !x.startsWith("/"));
    if (rel) return { ok: false, status: 400, error: `extra folder ${rel} must be an absolute path` };
    if (cwd && dirs.includes(trimSlash(cwd))) return { ok: false, status: 400, error: `${cwd} is the agent's own folder, not an extra one` };
    if (dirs.length) out.extraDirs = dirs;
  }
  return { ok: true, options: out };
}

const trimSlash = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);

/** "Sonnet 5.5 · effort high · also works in /a, /b": how an agent was asked to run, for its card. */
export function runOptionsLine(a: { requestedModel?: string; effort?: string; extraDirs?: string[] }, list?: ModelList | null): string {
  const row = a.requestedModel ? list?.models.find((m) => m.value === a.requestedModel) : undefined;
  const model = a.requestedModel ? (row ? `${row.displayName} (${a.requestedModel})` : a.requestedModel) : "Claude Code's default model";
  return [model, a.effort ? `effort ${a.effort}` : "default effort", a.extraDirs?.length ? `also works in ${a.extraDirs.join(", ")}` : ""].filter(Boolean).join(" · ");
}
