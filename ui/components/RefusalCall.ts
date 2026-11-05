/**
 * Your call on a blocked edit (#86): Right / Wrong with an optional note, and the call recorded
 * ("your call 10-27: right"). Reusable: the Agents screen's refusal card uses it today; Design and
 * History will.
 *
 * The calls are read once per page from GET /api/calls (calls.jsonl in AnviDeck's own folder) and
 * kept here; a call is recorded with POST /api/refusals/:key/call through ui/write.ts. One element
 * per refusal key is built and kept, so a screen that repaints moves it rather than rebuilding it,
 * and a note being typed survives the repaint.
 */
import { write, WriteError } from "../write";
import type { CallRecord, CallsRead } from "../../shared/refusal-types";
import { callLine, withRecorded, type CallsLoad } from "./refusal-call-model";

if (!document.querySelector('link[data-for="refusal-call"]')) {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = "/styles/refusal-call.css";
  link.dataset.for = "refusal-call";
  document.head.append(link);
}

export interface RefusalCallTarget {
  /** The refusal's key: its tool_use id (shared/refusal-types.ts Refusal.key). */
  key: string;
  /** The project the page shows; when the page has none, `cwd` (the agent's folder) and the server finds the project from it (#179). */
  project?: string;
  cwd?: string;
  /** What the card shows about the blocked edit; recorded with the call so the record says what it was about. */
  refusal?: { session?: string; tool?: string; file?: string; at?: string; path?: string };
}

let load: CallsLoad | null = null;
const widgets = new Map<string, { root: HTMLElement; paint: () => void; target: RefusalCallTarget }>();

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", ...kids: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of kids) if (k !== null && k !== undefined && k !== false) e.append(typeof k === "string" ? document.createTextNode(k) : k);
  return e;
}

function paintAll() {
  for (const w of widgets.values()) w.paint();
}

/** Read the calls again (after a restart, or when another page recorded one). */
export function reloadCalls(): void {
  load = { state: "loading" };
  paintAll();
  fetch("/api/calls")
    .then(async (r) => {
      const j = (await r.json().catch(() => null)) as CallsRead | { error?: string } | null;
      if (!r.ok || !j || !("byKey" in j)) throw new Error(`${r.status} ${(j as { error?: string } | null)?.error ?? r.statusText}`);
      load = { state: "ok", data: j };
    })
    .catch((e: Error) => (load = { state: "error", error: e.message }))
    .finally(paintAll);
}

export function refusalCall(target: RefusalCallTarget): HTMLElement {
  const have = widgets.get(target.key);
  if (have) {
    have.target = target;
    have.paint();
    return have.root;
  }
  if (!load) reloadCalls();
  const root = el("div", "rc");
  root.dataset.refusalKey = target.key;
  const line = el("span", "rc-line");
  const note = el("input", "rc-note");
  note.placeholder = "note (optional): why";
  note.maxLength = 2000;
  const right = el("button", "rc-btn ok", "Right");
  const wrong = el("button", "rc-btn bad", "Wrong");
  right.title = "The guard was right to block this edit";
  wrong.title = "The guard was wrong to block this edit";
  const out = el("div", "rc-out");
  const detail = el("div", "rc-detail");
  root.append(el("div", "rc-row", el("span", "rc-k", "Your ruling"), line, right, wrong, note), detail, out);

  const w = { root, target, paint: () => {} };
  w.paint = () => {
    const l = callLine(load ?? { state: "loading" }, w.target.key);
    line.textContent = l.text;
    line.className = `rc-line ${l.tone}`;
    const ats = load?.state === "ok" ? load.data.byKey[w.target.key]?.latest.at : undefined;
    line.title = ats ? `${ats} (UTC) · ${load!.state === "ok" ? (load as { data: CallsRead }).data.file : ""}` : "";
    detail.replaceChildren(
      ...(l.note ? [el("div", "rc-quote", `“${l.note}”`)] : []),
      ...(l.earlier.length ? [el("div", "rc-earlier", `earlier: ${l.earlier.join(" · ")}`)] : []),
      ...(l.damaged ? [el("div", "rc-warn", l.damaged)] : []),
      ...(l.unverified ? [el("div", "rc-warn", l.unverified)] : []),
    );
  };
  const send = async (call: "right" | "wrong") => {
    right.disabled = wrong.disabled = true;
    out.className = "rc-out";
    out.textContent = `recording "${call}"…`;
    try {
      const body = { ...(w.target.project ? { project: w.target.project } : { cwd: w.target.cwd }), call, ...(note.value.trim() ? { note: note.value } : {}), ...(w.target.refusal ? { refusal: w.target.refusal } : {}) };
      const r = await write<{ recorded: CallRecord; file: string }>("POST", `/api/refusals/${encodeURIComponent(w.target.key)}/call`, body);
      if (load?.state === "ok") load = { state: "ok", data: withRecorded(load.data, r.recorded) };
      else reloadCalls();
      note.value = "";
      out.textContent = `recorded in ${r.file}`;
      // Screens that count calls (Design's trial record) recount from the record the server returned.
      root.dispatchEvent(new CustomEvent<CallRecord>("refusal-call-recorded", { bubbles: true, detail: r.recorded }));
      paintAll();
    } catch (e) {
      out.className = "rc-out rc-warn";
      out.textContent = e instanceof WriteError ? `not recorded (${e.status}): ${e.message}` : `not recorded: ${(e as Error).message}`;
    } finally {
      right.disabled = wrong.disabled = false;
    }
  };
  right.onclick = () => void send("right");
  wrong.onclick = () => void send("wrong");
  widgets.set(target.key, w);
  w.paint();
  return root;
}
