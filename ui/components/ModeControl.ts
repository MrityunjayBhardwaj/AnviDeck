/**
 * Change a running agent's permission mode from its card (#306), as Shift+Tab does in the
 * terminal. Offers the modes this machine allows (modesOnOffer: never Full access, which is set
 * when an agent starts); the server checks the mode, the cap and Full access again
 * (POST /api/agents/:id/mode, checkModeChange) and records the change on the agent.
 *
 * One control per agent, kept across redraws of its card like the request cards, so a choice
 * being made is not reset by the next update; its selection follows the agent's mode only while
 * it is not being used.
 */
import { write } from "../write";
import { modeInfo, isAgentMode } from "../../shared/agent-modes";
import { modesOnOffer } from "../shell/mode-picker";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export interface ModeAgent {
  id: string;
  mode?: string;
}

const controls = new Map<string, { box: HTMLElement; sync: (mode: string) => void }>();

/** Forget the controls of agents no longer shown as running. */
export function keepModeControlsOf(ids: Set<string>): void {
  for (const id of [...controls.keys()]) if (!ids.has(id)) controls.delete(id);
}

export function modeControl(a: ModeAgent): HTMLElement {
  const mode = a.mode ?? "default";
  const had = controls.get(a.id);
  if (had) {
    had.sync(mode);
    return had.box;
  }
  const select = el("select", "aw-mode-pick");
  select.setAttribute("aria-label", "Change the permission mode");
  select.dataset.act = "mode";
  const change = el("button", "aw-btn sm", "Change mode");
  change.dataset.act = "change-mode";
  const out = el("span", "aw-note");
  const box = el("span", "aw-mode-control");
  box.dataset.agent = a.id;
  box.append(select, " ", change, " ", out);
  let current = mode;
  let busy = false;
  const fillFallback = () => {
    const o = el("option", "", isAgentMode(current) ? modeInfo(current).label : current);
    o.value = current;
    select.replaceChildren(o);
  };
  fillFallback();
  select.disabled = change.disabled = true;
  const sync = (m: string) => {
    if (m === current) return;
    current = m;
    if (!busy && document.activeElement !== select) select.value = m;
  };
  void modesOnOffer().then((r) => {
    if (!r.ok) {
      out.className = "aw-note aw-err";
      out.textContent = `modes not known (${r.why})`;
      return;
    }
    select.replaceChildren(...r.modes.map((m) => {
      const o = el("option", "", m.allowed ? m.label : `${m.label} (${m.why})`);
      o.value = m.mode;
      o.disabled = !m.allowed;
      return o;
    }));
    select.value = current;
    select.title = r.note;
    select.disabled = change.disabled = false;
  });
  change.onclick = async () => {
    if (select.value === current) {
      out.className = "aw-note";
      out.textContent = "already in that mode";
      return;
    }
    busy = true;
    select.disabled = change.disabled = true;
    out.className = "aw-note";
    out.textContent = "changing…";
    try {
      const v = (await write("POST", `/api/agents/${encodeURIComponent(a.id)}/mode`, { mode: select.value })) as { mode?: string } | undefined;
      current = v?.mode ?? select.value;
      out.className = "aw-note aw-ok";
      out.textContent = `now ${isAgentMode(current) ? modeInfo(current).label : current}`;
    } catch (e) {
      out.className = "aw-note aw-err";
      out.textContent = `refused: ${(e as Error).message}`;
      select.value = current;
    }
    busy = false;
    select.disabled = change.disabled = false;
  };
  controls.set(a.id, { box, sync });
  return box;
}
