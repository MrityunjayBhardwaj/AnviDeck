/**
 * The permission-mode picker in the start dialogs (#249). It reads what this machine offers from
 * GET /api/agents (each mode, and why one is above the cap), shows what the picked mode lets the
 * agent do, and for Full access asks for a box to be ticked that says it plainly. What it sends
 * comes from startModeBody; the server checks the mode and the cap again.
 */
import { DEFAULT_MODE, FULL_ACCESS_CONFIRM, MODES, modeInfo, startModeBody, type OfferedMode } from "../../shared/agent-modes";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const k of kids) e.append(typeof k === "string" ? document.createTextNode(k) : k);
  return e;
}

export interface ModePicker {
  element: HTMLElement;
  /** Read the modes on offer again (call when the dialog opens). */
  load: () => Promise<void>;
  /** The mode fields for the start request, or why it cannot be sent. */
  body: () => ReturnType<typeof startModeBody>;
}

export function createModePicker(idPrefix: string): ModePicker {
  const select = el("select", { id: `${idPrefix}-mode`, "aria-label": "Permission mode" });
  const what = el("div", { id: `${idPrefix}-mode-what`, class: "sh-dim" });
  const tick = el("input", { type: "checkbox", id: `${idPrefix}-mode-confirm` });
  const confirm = el("label", { id: `${idPrefix}-mode-confirm-row`, class: "sh-sa-err", hidden: "" }, tick, ` ${FULL_ACCESS_CONFIRM}: it can run any command, change any file, and push or merge on GitHub as you.`);
  const note = el("div", { id: `${idPrefix}-mode-note`, class: "sh-dim" });
  let offered: OfferedMode[] | null = null;

  const fill = (list: readonly OfferedMode[]) => {
    const keep = select.value || DEFAULT_MODE;
    select.replaceChildren(...list.map((m) => {
      const o = el("option", { value: m.mode }, m.allowed ? m.label : `${m.label} (above the cap)`);
      if (!m.allowed) o.setAttribute("disabled", "");
      return o;
    }));
    select.value = list.some((m) => m.mode === keep && m.allowed) ? keep : DEFAULT_MODE;
  };
  const show = () => {
    const m = MODES.find((x) => x.mode === select.value);
    what.textContent = m ? `${m.label}: ${m.behaviour}.` : "";
    const full = select.value === "bypassPermissions";
    confirm.hidden = !full;
    if (!full) tick.checked = false;
  };
  select.onchange = show;
  fill(MODES.map((m) => ({ ...m, allowed: m.mode === DEFAULT_MODE })));
  show();

  return {
    element: el("div", { class: "sh-sa-row sh-sa-mode" }, el("label", {}, "Permission mode ", select), what, confirm, note),
    async load() {
      try {
        const res = await fetch("/api/agents");
        const j = (await res.json()) as { modes?: { cap: string; from: string; invalid?: string; offered: OfferedMode[] } };
        if (!res.ok || !j.modes) throw new Error(`status ${res.status}`);
        offered = j.modes.offered;
        fill(offered);
        const capped = offered.filter((m) => !m.allowed);
        note.textContent = capped.length
          ? `Highest mode on this machine: ${modeInfo(j.modes.cap as OfferedMode["mode"]).label}, from ${j.modes.from}. Not offered: ${capped.map((m) => m.label).join(", ")}.`
          : `Every mode is allowed on this machine (${j.modes.from}).`;
        note.className = j.modes.invalid ? "sh-sa-err" : "sh-dim";
      } catch (e) {
        // Could not read what is offered: only Ask me, said as such, never a guess at the cap.
        offered = MODES.map((m) => ({ ...m, allowed: m.mode === DEFAULT_MODE, ...(m.mode === DEFAULT_MODE ? {} : { why: "not known: the modes on offer could not be read" }) }));
        fill(offered);
        note.textContent = `Could not read the modes this machine allows (${(e as Error).message}), so only Ask me is offered.`;
        note.className = "sh-sa-err";
      }
      show();
    },
    body: () => startModeBody(select.value, tick.checked, offered),
  };
}
