/**
 * Change a running agent's model from its card (#305), as /model in the terminal. Offers the
 * models Claude Code gave for this login (modelsOnOffer); the server checks the choice again
 * (POST /api/agents/:id/model) and records it on the agent. It applies from the next turn: the
 * card's model line shows what Claude Code reports, not what was asked.
 *
 * One control per agent, kept across redraws of its card like the mode control (ModeControl.ts),
 * so a choice being made is not reset by the next update.
 */
import { write } from "../write";
import { fillModels, modelsOnOffer } from "../shell/run-options";
import type { ModelList } from "../../shared/agent-run-options";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export interface ModelAgent {
  id: string;
  requestedModel?: string;
}

const controls = new Map<string, { box: HTMLElement; sync: (model: string) => void }>();

/** Forget the controls of agents no longer shown as running. */
export function keepModelControlsOf(ids: Set<string>): void {
  for (const id of [...controls.keys()]) if (!ids.has(id)) controls.delete(id);
}

export function modelControl(a: ModelAgent): HTMLElement {
  const model = a.requestedModel ?? "";
  const had = controls.get(a.id);
  if (had) {
    had.sync(model);
    return had.box;
  }
  const select = el("select", "aw-mode-pick aw-model-pick");
  select.setAttribute("aria-label", "Change the model");
  select.dataset.act = "model";
  const change = el("button", "aw-btn sm", "Change model");
  change.dataset.act = "change-model";
  const out = el("span", "aw-note");
  const box = el("span", "aw-model-control");
  box.dataset.agent = a.id;
  box.append(select, " ", change, " ", out);
  let current = model;
  let busy = false;
  let list: ModelList | null = null;
  fillModels(select, null, current);
  select.disabled = change.disabled = true;
  const sync = (m: string) => {
    if (m === current) return;
    current = m;
    if (!busy && document.activeElement !== select) fillModels(select, list, m);
  };
  void modelsOnOffer().then((r) => {
    if (!r.ok) {
      out.className = "aw-note aw-err";
      out.textContent = `models not known (${r.why})`;
      return;
    }
    list = r.list;
    fillModels(select, list, current);
    if (!list) {
      select.title = "No model list yet: Read models in a start dialog, or it is kept once an agent has started";
      return;
    }
    select.title = `The models Claude Code offers, from ${list.from}. Applies from its next turn.`;
    select.disabled = change.disabled = false;
  });
  change.onclick = async () => {
    if (select.value === current) {
      out.className = "aw-note";
      out.textContent = "already on that model";
      return;
    }
    busy = true;
    select.disabled = change.disabled = true;
    out.className = "aw-note";
    out.textContent = "changing…";
    try {
      const v = (await write("POST", `/api/agents/${encodeURIComponent(a.id)}/model`, { model: select.value })) as { requestedModel?: string } | undefined;
      current = v?.requestedModel ?? "";
      out.className = "aw-note aw-ok";
      out.textContent = `asked for ${select.selectedOptions[0]?.textContent ?? (current || "Claude Code's default")}, from its next turn`;
    } catch (e) {
      out.className = "aw-note aw-err";
      out.textContent = `refused: ${(e as Error).message}`;
      fillModels(select, list, current);
    }
    busy = false;
    select.disabled = change.disabled = false;
  };
  controls.set(a.id, { box, sync });
  return box;
}
