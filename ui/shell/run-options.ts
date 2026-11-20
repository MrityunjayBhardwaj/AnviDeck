/**
 * How an agent runs besides its mode (#305): the model, the effort and extra folders, in the start
 * dialog and beside Resume, and the model picker on a running agent's card. The models are the
 * list Claude Code gave for this login (GET /api/agents `models`), never typed by hand; with no
 * list yet, only Claude Code's default is offered and Read models asks Claude Code for it
 * (POST /api/agents/models/read, a write: it starts Claude Code without a prompt). The server
 * checks every choice again (checkRunOptions).
 */
import { write } from "../write";
import { DEFAULT_MODEL, EFFORTS, type Effort, type ModelChoice, type ModelList } from "../../shared/agent-run-options";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const k of kids) e.append(typeof k === "string" ? document.createTextNode(k) : k);
  return e;
}

export type ModelsRead = { ok: true; list: ModelList | null } | { ok: false; why: string };
let cache: { at: number; p: Promise<ModelsRead> } | null = null;

/** The models on offer, from GET /api/agents, read at most every 30 s (or again after Read models). */
export function modelsOnOffer(now = Date.now(), fresh = false): Promise<ModelsRead> {
  if (!fresh && cache && now - cache.at < 30_000) return cache.p;
  const p = (async (): Promise<ModelsRead> => {
    try {
      const res = await fetch("/api/agents");
      const j = (await res.json()) as { models?: ModelList | null };
      if (!res.ok) throw new Error(`status ${res.status}`);
      return { ok: true, list: j.models ?? null };
    } catch (e) {
      cache = null;
      return { ok: false, why: (e as Error).message };
    }
  })();
  cache = { at: now, p };
  return p;
}

/** Ask Claude Code for the list (Read models), then read it again. */
export async function readModelsNow(): Promise<ModelList> {
  const list = (await write("POST", "/api/agents/models/read", {})) as ModelList;
  cache = { at: Date.now(), p: Promise.resolve({ ok: true, list }) };
  return list;
}

const DEFAULT_LABEL = "Claude Code's default";
export const modelLabel = (m: ModelChoice) => (m.value === DEFAULT_MODEL ? `${DEFAULT_LABEL}${m.resolvedModel ? ` (now ${m.resolvedModel})` : ""}` : `${m.displayName}${m.resolvedModel && m.resolvedModel !== m.value ? ` (${m.resolvedModel})` : ""}`);

/** Fill a model select: Claude Code's default first, then the list. `keep` stays chosen when offered. */
export function fillModels(select: HTMLSelectElement, list: ModelList | null, keep: string): void {
  const rows = list?.models ?? [];
  const opts = [el("option", { value: "" }, rows.find((m) => m.value === DEFAULT_MODEL) ? modelLabel(rows.find((m) => m.value === DEFAULT_MODEL)!) : DEFAULT_LABEL)];
  for (const m of rows) if (m.value !== DEFAULT_MODEL) opts.push(el("option", { value: m.value }, modelLabel(m)));
  // A model the agent has that the list no longer offers is still shown, as such.
  if (keep && !rows.some((m) => m.value === keep)) opts.push(el("option", { value: keep }, `${keep} (not in the list read)`));
  select.replaceChildren(...opts);
  select.value = keep;
}

/** Fill an effort select with the levels the chosen model takes (all when not known). */
function fillEfforts(select: HTMLSelectElement, list: ModelList | null, model: string, keep: string): void {
  const row = list?.models.find((m) => m.value === (model || DEFAULT_MODEL));
  const levels: readonly Effort[] = row ? (row.efforts ?? []) : EFFORTS;
  select.replaceChildren(el("option", { value: "" }, levels.length ? "default effort" : "no effort level"), ...levels.map((l) => el("option", { value: l }, l)));
  select.value = levels.includes(keep as Effort) ? keep : "";
  select.disabled = levels.length === 0;
}

export interface RunOptionsPicker {
  element: HTMLElement;
  /** Read the models on offer (call when the dialog opens). */
  load: () => Promise<void>;
  /** The fields for the start or resume request; only those chosen. */
  body: () => { ok: true; body: { model?: string; effort?: string; extraDirs?: string[] } } | { ok: false; why: string };
}

/**
 * The model, effort and extra folders in a start dialog (`folders` true) or beside Resume
 * (`kept`: what the agent has, sent again unless changed).
 */
export function createRunOptionsPicker(idPrefix: string, opts: { folders: boolean; kept?: { model?: string; effort?: string } } = { folders: true }): RunOptionsPicker {
  const model = el("select", { id: `${idPrefix}-model`, "aria-label": "Model", class: "aw-mode-pick aw-model-pick" });
  const effort = el("select", { id: `${idPrefix}-effort`, "aria-label": "Effort", class: "aw-mode-pick" });
  const read = el("button", { id: `${idPrefix}-read-models`, type: "button", class: "sh-btn" }, "Read models");
  read.title = "Ask Claude Code which models this login offers: it starts in your home folder without a prompt (no usage; its start-up hooks run) and ends";
  const note = el("span", { id: `${idPrefix}-models-note`, class: "sh-dim" });
  const dirs = el("textarea", { id: `${idPrefix}-extra-dirs`, rows: "2", placeholder: "extra folders it may work in, one absolute path per line (optional)", "aria-label": "Extra folders" });
  let list: ModelList | null = null;
  const kept = opts.kept ?? {};
  const refill = () => fillEfforts(effort, list, model.value, effort.value || kept.effort || "");
  model.onchange = refill;
  const show = (r: ModelsRead) => {
    if (!r.ok) {
      note.className = "sh-sa-err";
      note.textContent = `the models on offer could not be read (${r.why}): only Claude Code's default`;
      list = null;
    } else {
      list = r.list;
      note.className = "sh-dim";
      // Beside Resume only what needs saying (no list, or an error); the start dialog says where it came from.
      note.textContent = list ? (opts.folders ? `${list.models.length} models, from ${list.from}, ${new Date(list.at).toLocaleString()}` : "") : "no model list yet: Read models, or keep Claude Code's default (the list is kept from the first agent that runs)";
      note.title = list ? `${list.models.length} models, from ${list.from}, ${list.at}` : "";
    }
    fillModels(model, list, model.value || kept.model || "");
    refill();
  };
  read.onclick = async () => {
    read.disabled = true;
    note.className = "sh-dim";
    note.textContent = "asking Claude Code…";
    try {
      show({ ok: true, list: await readModelsNow() });
    } catch (e) {
      note.className = "sh-sa-err";
      note.textContent = `Read models refused: ${(e as Error).message}`;
    }
    read.disabled = false;
  };
  fillModels(model, null, kept.model ?? "");
  fillEfforts(effort, null, "", kept.effort ?? "");
  const row = el("div", { class: "sh-sa-row sh-sa-run" }, el("label", {}, "Model ", model), el("label", {}, "Effort ", effort), read, note);
  const element = opts.folders ? el("div", {}, row, el("div", { class: "sh-sa-row" }, dirs)) : row;
  return {
    element,
    async load() {
      show(await modelsOnOffer());
    },
    body() {
      const out: { model?: string; effort?: string; extraDirs?: string[] } = {};
      if (model.value || kept.model) out.model = model.value;
      if (effort.value || kept.effort) out.effort = effort.value;
      if (opts.folders) {
        const paths = dirs.value.split("\n").map((s) => s.trim()).filter(Boolean);
        const rel = paths.find((p) => !p.startsWith("/"));
        if (rel) return { ok: false, why: `extra folder ${rel} must be an absolute path` };
        if (paths.length) out.extraDirs = paths;
      }
      return { ok: true, body: out };
    },
  };
}
