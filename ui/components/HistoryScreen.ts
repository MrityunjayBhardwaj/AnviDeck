/**
 * Project · History (#90): every agent turn, edit, refusal, ruling, commit and catalogue change
 * on one axis, with AnviDeck's own actions; a moment's details; compare two points (code, design,
 * knowledge); replay a session. The rules live in history-model.ts (tested); this file builds DOM.
 *
 * Reads only: GET /api/history (the lanes), GET /api/history/compare (code and knowledge),
 * GET /api/structure/:project?ref= (design at the two commits). The one write is your call on a
 * refusal, through the shared RefusalCall control (POST /api/refusals/:key/call via ui/write.ts).
 * All transcript, commit and file text is set as text, never as HTML.
 */
import type { CompareResponse, HistoryEvent, HistoryResponse } from "../../shared/history-types";
import type { StructureProjectResponse } from "../../shared/structure-types";
import { refusalCall } from "./RefusalCall";
import {
  ROWS,
  KIND_LABEL,
  around,
  cellCount,
  cellEvents,
  codeLine,
  daysBetween,
  designLine,
  designShas,
  eventTitle,
  historyQuery,
  knowledgeLine,
  mapReplayHash,
  pointOf,
  replayHash,
  rowNote,
  rowState,
  sessionOf,
  short,
  shouldPoll,
  showingLine,
  sourceLines,
  stamp,
  totalLine,
  windowDays,
  type DesignSide,
  type Row,
} from "./history-model";

type Kid = Node | string | null | undefined | false;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const k of kids) if (k !== null && k !== undefined && k !== false) e.append(typeof k === "string" ? document.createTextNode(k) : k);
  return e;
}
const SVG = "http://www.w3.org/2000/svg";
function sv(tag: string, attrs: Record<string, string | number>, text?: string): SVGElement {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text !== undefined) e.textContent = text;
  return e;
}

function ensureStyles() {
  if (document.querySelector("link[data-history-css]")) return;
  document.head.appendChild(el("link", { rel: "stylesheet", href: "/styles/history.css", "data-history-css": "" }));
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    const res = await fetch(url, { signal });
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return { ok: false, error: typeof j.error === "string" ? j.error : `status ${res.status}` };
    return { ok: true, value: j as T };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

const POLL_MS = 10_000;

export function HistoryScreen(projectName: string | null, params: URLSearchParams): HTMLElement {
  ensureStyles();
  const wrap = el("section", { class: "sh-screen hs", "data-screen": "history" });
  const head = el("div", { class: "sh-head" }, el("h1", {}, "Project · History"), el("span", { class: "sh-sub" }, "every agent turn, edit, refusal, ruling, commit and catalogue change on one axis"));
  wrap.append(head);
  if (!projectName) {
    wrap.append(el("div", { class: "sh-card" }, "Pick a project in the switcher above."));
    return wrap;
  }
  const project = projectName;
  let { from, to } = windowDays(params);

  const fromIn = el("input", { type: "date", id: "hs-from", value: from, "aria-label": "From day" });
  const toIn = el("input", { type: "date", id: "hs-to", value: to, "aria-label": "To day" });
  const load = el("button", { class: "sh-btn", type: "button", id: "hs-load" }, "Show");
  const compareBtn = el("button", { class: "sh-btn", type: "button", id: "hs-compare" }, "Compare two points");
  const replayBtn = el("button", { class: "sh-btn", type: "button", id: "hs-replay" }, "Replay a session");
  head.append(el("div", { class: "hs-acts" }, fromIn, el("span", { class: "sh-dim" }, "to"), toIn, load, compareBtn, replayBtn));

  const status = el("div", { class: "sh-dim hs-status", id: "hs-status" }, "reading…");
  const timeline = el("div", { class: "hs-timeline", id: "hs-timeline" });
  const hint = el("div", { class: "sh-dim hs-hint", id: "hs-hint" });
  const replayPanel = el("div", { class: "sh-card hs-replay", id: "hs-replay-panel", hidden: "" });
  const selCard = el("div", { class: "sh-card", id: "hs-selected" });
  const momentCard = el("div", { class: "sh-card", id: "hs-moment" });
  const cmpCard = el("div", { class: "sh-card", id: "hs-compare-card" });
  const sources = el("div", { class: "sh-dim hs-sources", id: "hs-sources" });
  wrap.append(status, timeline, hint, replayPanel, el("div", { class: "hs-grid" }, selCard, momentCard, cmpCard), sources);

  let res: HistoryResponse | null = null;
  let sel: { row: Row; day: string } | null = null;
  let picked: HistoryEvent | null = null;
  let comparing = false;
  let points: string[] = [];
  let cmp: { a: string; b: string; res: CompareResponse | null; error?: string; design: [DesignSide, DesignSide] } | null = null;
  let ctl: AbortController | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  const alive = () => wrap.isConnected;

  function writeUrl() {
    // The project is the switcher's (a ?project= in the URL sets it on load); the window is this screen's.
    const q = new URLSearchParams({ from, to });
    history.replaceState(null, "", `#history?${q}`);
  }

  async function fetchHistory(quiet = false) {
    ctl?.abort();
    ctl = new AbortController();
    if (pollTimer) clearTimeout(pollTimer);
    if (!quiet) status.textContent = `reading ${from} – ${to}…`;
    const r = await getJson<HistoryResponse>(historyQuery(project, from, to), ctl.signal);
    if (!alive()) return;
    if (!r.ok) {
      if (r.error.includes("abort")) return;
      res = null;
      status.textContent = `Could not read the history — ${r.error}`;
      status.className = "hs-status hs-bad";
      timeline.replaceChildren();
      return;
    }
    res = r.value;
    status.className = "sh-dim hs-status";
    paint();
    if (shouldPoll(res)) pollTimer = setTimeout(() => alive() && fetchHistory(true), POLL_MS);
  }

  function paint() {
    if (!res) return;
    status.textContent = `${project} · ${from} – ${to} · ${totalLine(res)} · read ${stamp(res.readAt)} in ${(res.ms / 1000).toFixed(1)} s`;
    paintTimeline();
    paintSelected();
    paintMoment();
    paintCompare();
    paintReplay();
    sources.replaceChildren(el("b", {}, "Where each lane comes from"), ...sourceLines(res).map((l) => el("div", {}, l)));
    hint.textContent = comparing
      ? points.length === 0 ? "Compare: pick the first day on the timeline." : "Compare: pick the second day."
      : "Pick a cell to see that day's events in its lane.";
  }

  function paintTimeline() {
    const r = res!;
    const days = daysBetween(from, to);
    const L = 150, top = 30, lh = 40, colW = Math.max(26, Math.min(70, 900 / Math.max(days.length, 1)));
    const W = L + days.length * colW + 20;
    const H = top + ROWS.length * lh + 10;
    const svg = sv("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img", "aria-label": "Timeline", id: "hs-svg" }) as SVGSVGElement;
    const X = (i: number) => L + i * colW + colW / 2;
    const every = Math.ceil(days.length / 16);
    days.forEach((d, i) => {
      svg.append(sv("line", { x1: X(i), y1: top - 8, x2: X(i), y2: top + ROWS.length * lh, stroke: "#273042" }));
      if (i % every === 0) svg.append(sv("text", { x: X(i), y: top - 12, "text-anchor": "middle", fill: "#6b7489", "font-size": 10, "font-family": "IBM Plex Mono, monospace" }, d.slice(5)));
    });
    ROWS.forEach((row, ri) => {
      const y = top + ri * lh + lh / 2;
      const state = rowState(r, row);
      svg.append(sv("text", { x: 10, y: y + (rowNote(r, row) ? 0 : 4), fill: "#9aa4b8", "font-size": 11 }, row.label));
      const note = rowNote(r, row);
      if (note) svg.append(sv("text", { x: 10, y: y + 12, fill: state === "unreadable" ? "#f2645a" : "#f2b84b", "font-size": 9 }, note.length > 26 ? note.slice(0, 25) + "…" : note));
      svg.append(sv("line", { x1: L, y1: y, x2: W - 20, y2: y, stroke: row.color, "stroke-opacity": state === "ok" ? 0.18 : 0.06, "stroke-width": 10, "stroke-linecap": "round", ...(state === "ok" ? {} : { "stroke-dasharray": "4 6" }) }));
      days.forEach((d, i) => {
        const n = cellCount(r, row, d);
        const x = X(i);
        if (n > 0) {
          if (row.key === "refusals") {
            const refused = r.lanes.refusal.perDay[d] ?? 0;
            const called = r.lanes.ruling.perDay[d] ?? 0;
            if (refused) svg.append(sv("circle", { cx: x - (called ? 5 : 0), cy: y, r: 6, fill: "#f2645a" }));
            if (called) svg.append(sv("circle", { cx: x + (refused ? 5 : 0), cy: y, r: 6, fill: "none", stroke: "#3ccf91", "stroke-width": 2.5 }));
          } else {
            const dots = Math.min(n, 5);
            for (let k = 0; k < dots; k++) svg.append(sv("circle", { cx: x - (dots - 1) * 2.5 + k * 5, cy: y, r: 2.4, fill: row.color }));
          }
          if (n > 1 || row.key === "refusals") svg.append(sv("text", { x, y: y - 9, "text-anchor": "middle", fill: "#e6e9f0", "font-size": 9.5, "font-family": "IBM Plex Mono, monospace" }, String(n)));
        }
        const hit = sv("rect", { x: x - colW / 2, y: y - lh / 2, width: colW, height: lh, fill: "transparent", class: "hs-cell", "data-row": row.key, "data-day": d, "data-n": n, "data-lane": state, tabindex: 0 });
        hit.append(sv("title", {}, `${row.label} · ${d}: ${n}`));
        hit.addEventListener("click", () => pick(row, d));
        hit.addEventListener("keydown", (e) => (e as KeyboardEvent).key === "Enter" && pick(row, d));
        svg.append(hit);
      });
    });
    const mark = (day: string, color: string) => {
      const i = days.indexOf(day);
      if (i >= 0) svg.append(sv("rect", { x: X(i) - colW / 2 + 2, y: top - 6, width: colW - 4, height: ROWS.length * lh + 4, fill: color, "fill-opacity": 0.07, stroke: color, "stroke-opacity": 0.5, rx: 4, "pointer-events": "none" }));
    };
    if (sel) mark(sel.day, "#8f7ef7");
    for (const p of points) mark(p, "#f2b84b");
    timeline.replaceChildren(svg);
  }

  function pick(row: Row, day: string) {
    if (comparing) {
      points = points.includes(day) ? points.filter((p) => p !== day) : [...points, day].slice(-2);
      if (points.length === 2) runCompare();
      paint();
      return;
    }
    sel = { row, day };
    const { events } = cellEvents(res!, row, day);
    picked = events.length ? events[events.length - 1] : null;
    paint();
  }

  function paintSelected() {
    if (!sel || !res) {
      selCard.replaceChildren(el("h3", {}, "Selected"), el("div", { class: "sh-dim" }, "Nothing selected yet."));
      return;
    }
    const { events, total } = cellEvents(res, sel.row, sel.day);
    const list = el("div", { class: "hs-list" });
    for (const e of [...events].reverse()) {
      const b = el("button", { type: "button", class: `hs-ev${picked === e ? " on" : ""}` }, el("span", { class: "hs-t" }, stamp(e.at).slice(6)), el("span", { class: `hs-k k-${e.kind}` }, KIND_LABEL[e.kind]), el("span", { class: "hs-ttl" }, eventTitle(e)));
      b.addEventListener("click", () => {
        picked = e;
        paintSelected();
        paintMoment();
      });
      list.append(b);
    }
    const kids: Kid[] = [el("h3", {}, `Selected · ${sel.day} · ${sel.row.label}`), el("div", { class: "sh-dim" }, showingLine(events.length, total))];
    if (events.length < total && (from !== sel.day || to !== sel.day)) {
      const one = el("button", { type: "button", class: "sh-btn hs-one" }, `Open ${sel.day} alone`);
      one.addEventListener("click", () => setWindow(sel!.day, sel!.day));
      kids.push(one);
    }
    const note = rowNote(res, sel.row);
    if (note) kids.push(el("div", { class: "hs-warn" }, note));
    selCard.replaceChildren(...kids.filter(Boolean) as Node[], list);
  }

  function paintMoment() {
    const e = picked;
    if (!e || !res) {
      momentCard.replaceChildren(el("h3", {}, "Moment"), el("div", { class: "sh-dim" }, "Pick an event to see its details."));
      return;
    }
    const kids: Kid[] = [el("h3", {}, `${KIND_LABEL[e.kind]} · ${stamp(e.at)}`)];
    const sid = sessionOf(e);
    if (e.kind === "turn") {
      kids.push(el("div", { class: "hs-quote" }, e.prompt), el("div", { class: "sh-dim" }, `prompt${e.origin ? ` by ${e.origin}` : ""} · session ${e.session.slice(0, 8)}`));
    } else if (e.kind === "edit") {
      kids.push(el("div", {}, `${e.tool} `, el("span", { class: "hs-mono" }, e.file)), el("div", { class: "sh-dim" }, `session ${e.session.slice(0, 8)} · the call, whatever its outcome`));
    } else if (e.kind === "refusal") {
      kids.push(
        el("div", {}, el("span", { class: "sh-chip hs-chip-bad" }, "blocked"), ` ${e.tool} `, el("span", { class: "hs-mono" }, e.file)),
        el("div", { class: "sh-dim" }, `${e.pairs.join(", ") || "no component pair named"} · refused by the ${e.refusedBy}${e.design ? ` · design ${e.design}` : ""} · session ${e.session.slice(0, 8)}`),
      );
      if (e.reason) kids.push(el("pre", { class: "hs-pre" }, e.reason));
      kids.push(refusalCall({ key: e.id, project, refusal: { session: e.session, tool: e.tool, file: e.file, at: e.at } }));
    } else if (e.kind === "ruling") {
      kids.push(
        el("div", {}, el("span", { class: `sh-chip ${e.call === "right" ? "hs-chip-ok" : "hs-chip-bad"}` }, e.call), ` your call${e.superseded ? " (replaced by a later call)" : ""}`),
        el("div", { class: "sh-dim" }, `on ${e.refusal?.tool ?? "an edit"} ${e.refusal?.file ?? ""}${e.refusal?.at ? ` blocked ${stamp(e.refusal.at)}` : ""} · key ${e.key.slice(0, 14)}…`),
      );
      if (e.note) kids.push(el("div", { class: "hs-quote" }, e.note));
      const refusal = res.events.find((x) => x.kind === "refusal" && x.id === e.key);
      if (refusal) {
        const go = el("button", { type: "button", class: "sh-btn" }, "Show the refusal");
        go.addEventListener("click", () => {
          picked = refusal;
          paintMoment();
        });
        kids.push(go);
      }
    } else if (e.kind === "commit" || e.kind === "catalogue") {
      kids.push(el("div", {}, el("span", { class: "hs-mono" }, short(e.sha)), ` ${e.subject}`));
      if (e.kind === "commit") kids.push(el("div", { class: "sh-dim" }, `by ${e.author} · ${res.lanes.commit.source}`));
      else kids.push(el("div", { class: "sh-dim" }, e.files.map((f) => `${f.status} ${f.file}`).join(" · ") || "no file listed"));
    } else if (e.kind === "action") {
      kids.push(el("div", { class: "hs-mono" }, `${e.method} ${e.path} → ${e.status} ${e.result}`), e.reason ? el("div", { class: "sh-dim" }, e.reason) : null);
    }
    if (sid) {
      const w = around(e.at);
      kids.push(el("div", { class: "hs-row" }, el("a", { href: replayHash(project, sid, w.from, w.to) }, "Replay this moment"), el("a", { href: mapReplayHash(project, sid) }, "On the Map")));
    }
    momentCard.replaceChildren(...(kids.filter(Boolean) as Node[]));
  }

  async function runCompare() {
    const [x, y] = [...points].sort();
    cmp = { a: x, b: y, res: null, design: [{ state: "loading" }, { state: "loading" }] };
    paintCompare();
    const q = new URLSearchParams({ project, a: pointOf(x), b: pointOf(y) });
    const r = await getJson<CompareResponse>(`/api/history/compare?${q}`);
    if (!alive() || !cmp || cmp.a !== x || cmp.b !== y) return;
    if (!r.ok) {
      cmp.error = r.error;
      cmp.design = [{ state: "error", reason: "the code compare failed" }, { state: "error", reason: "the code compare failed" }];
      paintCompare();
      return;
    }
    cmp.res = r.value;
    const shas = designShas(r.value.code);
    if (!shas) cmp.design = [{ state: "error", reason: "no commit at one of the points" }, { state: "error", reason: "no commit at one of the points" }];
    paintCompare();
    if (!shas) return;
    const one = async (sha: string): Promise<DesignSide> => {
      const d = await getJson<StructureProjectResponse>(`/api/structure/${encodeURIComponent(project)}?ref=${sha}`);
      return d.ok ? { state: "done", value: d.value } : { state: "error", reason: d.error };
    };
    const [da, db] = await Promise.all([one(shas.a), one(shas.b)]);
    if (!alive() || !cmp || cmp.a !== x || cmp.b !== y) return;
    cmp.design = [da, db];
    paintCompare();
  }

  function paintCompare() {
    if (!cmp) {
      cmpCard.replaceChildren(el("h3", {}, "Compare two points"), el("div", { class: "sh-dim" }, comparing ? "Pick two days on the timeline." : "Press Compare two points, then pick two days."));
      return;
    }
    const kids: Kid[] = [el("h3", {}, `Compare ${cmp.a.slice(5)} ↔ ${cmp.b.slice(5)}`), el("div", { class: "sh-dim" }, `as of the end of each day (${stamp(pointOf(cmp.a))} ↔ ${stamp(pointOf(cmp.b))})`)];
    if (cmp.error) kids.push(el("div", { class: "hs-bad" }, `Could not compare — ${cmp.error}`));
    else if (!cmp.res) kids.push(el("div", { class: "sh-dim" }, "reading git…"));
    else {
      const c = cmp.res.code;
      kids.push(el("div", { class: "hs-cmp" }, codeLine(c)));
      kids.push(el("div", { class: "hs-cmp" }, designLine(cmp.design[0], cmp.design[1])));
      kids.push(el("div", { class: "hs-cmp" }, knowledgeLine(cmp.res.knowledge)));
      if (c.ok && c.value.files.length) {
        const det = el("details", {}, el("summary", {}, `files changed (${c.value.files.length < c.value.filesTotal ? `showing ${c.value.files.length} of ${c.value.filesTotal}` : c.value.filesTotal})`));
        for (const f of c.value.files) det.append(el("div", { class: "hs-mono" }, `${f.added ?? "bin"} +  ${f.deleted ?? "bin"} −  ${f.file}`));
        kids.push(det);
      }
      const k = cmp.res.knowledge;
      if (k.ok && k.value.files.some((f) => f.added.length || f.removed.length || f.changed.length)) {
        const det = el("details", {}, el("summary", {}, "entries"));
        for (const f of k.value.files) {
          if (!f.added.length && !f.removed.length && !f.changed.length) continue;
          det.append(el("div", { class: "hs-mono" }, `${f.file} ${f.before ?? "—"} → ${f.after ?? "—"} entries`));
          if (f.added.length) det.append(el("div", { class: "hs-mono hs-ok" }, `added ${f.added.join(" ")}`));
          if (f.removed.length) det.append(el("div", { class: "hs-mono hs-bad" }, `removed ${f.removed.join(" ")}`));
          if (f.changed.length) det.append(el("div", { class: "hs-mono" }, `changed ${f.changed.join(" ")}`));
        }
        kids.push(det);
      }
      const src: string[] = [];
      if (c.ok) src.push(`code: ${c.value.ref} in ${c.value.repo}${c.value.a ? ` · ${short(c.value.a.sha)} (${stamp(c.value.a.date)})` : ""}${c.value.b ? ` → ${short(c.value.b.sha)} (${stamp(c.value.b.date)})` : ""}`);
      src.push("design: the structure guard at those two commits (GET /api/structure)");
      if (k.ok) src.push(`knowledge: ${k.value.dir} in ${k.value.repo}${k.value.a ? ` · ${short(k.value.a.sha)}` : ""}${k.value.b ? ` → ${short(k.value.b.sha)}` : ""}`);
      kids.push(el("div", { class: "sh-dim hs-small" }, src.join(" · ")));
    }
    cmpCard.replaceChildren(...(kids.filter(Boolean) as Node[]));
  }

  function paintReplay() {
    if (replayPanel.hidden || !res) return;
    const kids: Kid[] = [el("h3", {}, "Replay a session"), el("div", { class: "sh-dim" }, `${res.sessions.length} session${res.sessions.length === 1 ? "" : "s"} with a turn or an edit in this window (${res.lanes.turn.status === "ok" || res.lanes.turn.status === "none" ? "every one scanned" : "the transcripts were " + res.lanes.turn.status})`)];
    for (const s of [...res.sessions].reverse()) {
      kids.push(el("div", { class: "hs-row" }, el("span", { class: "hs-mono" }, s.id.slice(0, 8)), el("span", { class: "sh-dim" }, `${stamp(s.first)} – ${stamp(s.last)} · ${s.turns} turns · ${s.edits} edits${s.cwd ? ` · ${s.cwd}` : ""}`), el("a", { href: replayHash(project, s.id, s.first, s.last) }, "Replay"), el("a", { href: mapReplayHash(project, s.id) }, "On the Map")));
    }
    replayPanel.replaceChildren(...(kids.filter(Boolean) as Node[]));
  }

  function setWindow(f: string, t: string) {
    from = f;
    to = t;
    fromIn.value = f;
    toIn.value = t;
    sel = null;
    picked = null;
    writeUrl();
    fetchHistory();
  }

  load.addEventListener("click", () => {
    if (!fromIn.value || !toIn.value || fromIn.value > toIn.value) {
      status.textContent = "Pick a from day on or before the to day.";
      return;
    }
    setWindow(fromIn.value, toIn.value);
  });
  compareBtn.addEventListener("click", () => {
    comparing = !comparing;
    compareBtn.classList.toggle("on", comparing);
    if (comparing) points = [];
    paint();
    if (!res) paintCompare();
  });
  replayBtn.addEventListener("click", () => {
    replayPanel.hidden = !replayPanel.hidden;
    replayBtn.classList.toggle("on", !replayPanel.hidden);
    paintReplay();
  });

  paintSelected();
  paintMoment();
  paintCompare();
  fetchHistory();
  return wrap;
}
