/**
 * Notes (#89): what anvi knows about one project. Catalogues by kind with search; which
 * catalogue is used when, per activity; currency (anvi's own report, the snapshot series, the
 * oldest out-of-date entries still in use, Re-check a batch); grounding; project memory with
 * Promote. The rules live in notes-model.ts (tested); this file only builds the DOM.
 *
 * Re-check and Promote start an agent (POST /api/agents, through ui/write.ts) in the project's
 * folder. The prompt is shown in full first and the same string is what is sent. AnviDeck never
 * edits a catalogue or a memory note itself. All file text is set as text, never as HTML.
 */
import { api } from "../api";
import { write, WriteError } from "../write";
import type { CurrencyAnswer, GtCheckAnswer, GtDocCheck, SnapshotSeries, UsageAnswer } from "../../shared/notes-types";
import type { CatalogueEntry, EntryDates, ProjectState, RoutingArchitecture } from "../../shared/types";
import {
  KINDS,
  WHEN_COLUMNS,
  ageDays,
  batchLabel,
  batches,
  citations,
  countGap,
  currencyCaveat,
  currencyHeadline,
  entryNote,
  headerCounts,
  key,
  matches,
  memoryFile,
  oldestStillUsed,
  outOfDate,
  promotePrompt,
  recheckPrompt,
  recurrenceHint,
  routingMatrix,
  sectionsText,
  seriesPoints,
  usageWindow,
  verdicts,
  whyOutOfDate,
  type Batch,
  type SeriesPoint,
} from "./notes-model";

type Kid = Node | string | null | undefined | false;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const k of kids) if (k !== null && k !== undefined && k !== false) e.append(typeof k === "string" ? document.createTextNode(k) : k);
  return e;
}

function ensureStyles() {
  if (document.querySelector("link[data-notes-css]")) return;
  document.head.appendChild(el("link", { rel: "stylesheet", href: "/styles/notes.css", "data-notes-css": "" }));
}

async function getJson<T>(url: string): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    const res = await fetch(url);
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return { ok: false, error: typeof j.error === "string" ? j.error : `status ${res.status}` };
    return { ok: true, value: j as T };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

const TABS = [
  { k: "cat", label: "Catalogues" },
  { k: "when", label: "Which catalogue, when" },
  { k: "decay", label: "Currency" },
  { k: "ground", label: "Grounding" },
  { k: "mem", label: "Memory" },
] as const;
type Tab = (typeof TABS)[number]["k"];

const fmt = (n: number) => n.toLocaleString("en-US");
const local = (iso: string | null) => (iso ? `${new Date(iso).toLocaleDateString("sv-SE")} ${new Date(iso).toTimeString().slice(0, 5)}` : "?");

interface State {
  project: ProjectState | null;
  projectError: string | null;
  currency: CurrencyAnswer | null;
  series: SnapshotSeries | null;
  currencyError: string | null;
  usage: UsageAnswer | null;
  usageError: string | null;
  dates: EntryDates | null;
  datesNote: string;
  routing: RoutingArchitecture | null;
  routingError: string | null;
  gt: GtCheckAnswer | null;
  gtError: string | null;
}

export function NotesScreen(projectName: string | null, params: URLSearchParams): HTMLElement {
  ensureStyles();
  const wrap = el("section", { class: "sh-screen nt", "data-screen": "notes" });
  const sub = el("span", { class: "sh-sub", id: "nt-sub" }, "what anvi knows about this project");
  const search = el("input", { type: "search", id: "nt-search", placeholder: "Search entries", "aria-label": "Search entries" });
  const headRecheck = el("button", { class: "sh-btn nt-warn", type: "button", id: "nt-recheck-top", hidden: "" });
  wrap.append(el("div", { class: "sh-head" }, el("h1", {}, "Notes"), sub, el("div", { class: "nt-acts" }, search, headRecheck)));
  if (!projectName) {
    wrap.append(el("div", { class: "sh-card" }, "Pick a project in the switcher above."));
    return wrap;
  }
  const project = projectName;

  let tab: Tab = (TABS.find((t) => t.k === params.get("tab"))?.k ?? "cat") as Tab;
  const tabBar = el("div", { class: "nt-tabs", role: "tablist" });
  const body = el("div", { class: "nt-body" });
  const confirm = el("div", { class: "sh-card nt-confirm", id: "nt-confirm", hidden: "" });
  const sources = el("div", { class: "sh-dim nt-sources", id: "nt-sources" });
  wrap.append(confirm, tabBar, body, sources);

  const st: State = {
    project: null, projectError: null, currency: null, series: null, currencyError: null,
    usage: null, usageError: null, dates: null, datesNote: "reading", routing: null, routingError: null, gt: null, gtError: null,
  };

  function paintTabs() {
    tabBar.replaceChildren(...TABS.map((t) => {
      const b = el("button", { type: "button", role: "tab", "data-k": t.k, class: t.k === tab ? "on" : "" }, t.label);
      b.onclick = () => {
        tab = t.k;
        // Keep the tab in the URL without re-rendering the screen.
        history.replaceState(null, "", `#notes?tab=${t.k}`);
        paint();
      };
      return b;
    }));
  }

  // ── Starting an agent: shown first, exactly ───────────────────────────────────────────
  function ask(title: string, prompt: string) {
    const cwd = st.project?.path ?? "";
    const out = el("div", { class: "nt-confirm-out", "aria-live": "polite" });
    const go = el("button", { type: "button", class: "sh-btn nt-go", id: "nt-start" }, "Start agent");
    const cancel = el("button", { type: "button", class: "sh-btn", id: "nt-cancel" }, "Cancel");
    confirm.replaceChildren(
      el("h3", {}, title),
      el("div", { class: "sh-dim" }, "Nothing has started. Start agent runs one Claude Code agent (on your Claude Code login) in ", el("span", { class: "nt-mono", id: "nt-cwd" }, cwd || "(no folder)"), " and tells it exactly this:"),
      el("pre", { class: "nt-prompt", id: "nt-prompt" }, prompt),
      el("div", { class: "sh-dim" }, "AnviDeck does not change any catalogue or memory note itself; the agent does, as it would in a terminal, and asks you for anything your permission rules don't cover."),
      el("div", { class: "nt-row" }, go, cancel),
      out,
    );
    confirm.hidden = false;
    confirm.scrollIntoView({ block: "nearest" });
    cancel.onclick = () => (confirm.hidden = true);
    if (!cwd) go.disabled = true;
    go.onclick = async () => {
      go.disabled = true;
      out.replaceChildren(el("span", { class: "sh-dim" }, "Starting…"));
      try {
        const a = await write<{ id: string; status: string }>("POST", "/api/agents", { cwd, prompt });
        cancel.textContent = "Close";
        out.replaceChildren(el("span", { class: "nt-ok" }, "Started agent ", el("b", { id: "nt-agent" }, a.id), ` (${a.status}). `),
          el("a", { href: `#agents?agent=${encodeURIComponent(a.id)}`, id: "nt-open" }, "Open it on Agents"));
      } catch (e) {
        const why = e instanceof WriteError ? e.message : (e as Error).message;
        out.replaceChildren(el("span", { class: "nt-bad" }, `Not started: ${why}`));
        go.disabled = false;
      }
    };
  }

  const askRecheck = (b: Batch) => st.currency && ask(batchLabel(b), recheckPrompt(project, b, st.currency));

  // ── Painting ──────────────────────────────────────────────────────────────────────────
  function allEntries(): CatalogueEntry[] {
    return (st.project?.catalogues ?? []).flatMap((c) => c.entries);
  }

  function paintHead() {
    const parts = ["what anvi knows about this project"];
    if (st.project) {
      const h = headerCounts(allEntries(), st.project.grounding);
      parts.push(`${fmt(h.notes)} notes`);
      if (h.backedPct !== null) parts.push(`${h.backedPct}% backed by source`);
    }
    const cur = currencyHeadline(st.currency);
    if (cur) parts.push(cur);
    sub.textContent = parts.join(" · ");
    const top = batches(st.currency)[0];
    headRecheck.hidden = !top;
    if (top) {
      headRecheck.textContent = batchLabel(top);
      headRecheck.onclick = () => askRecheck(top);
    }
  }

  function paintSources() {
    const p = st.project;
    const c = st.currency;
    const lines: Kid[] = [];
    if (p) lines.push(el("div", {}, `Entries: parsed from ${p.readStatus?.catalogues.path ?? "the project's .anvi"} (${p.readStatus?.catalogues.status ?? "?"}). Backed by source: entries in hetvabhasa, vyapti and krama with a REF that is not UNGROUNDED, ${p.grounding.groundedEntries} of ${p.grounding.totalEntries}, as anvi's grounding count.`));
    if (c) lines.push(el("div", { id: "nt-currency-src" }, `Out of date: 🟡 + 🔴 in anvi's currency report, ${c.command}`, c.ranAt ? `, run ${local(c.ranAt)}` : c.startedAt ? `, running since ${local(c.startedAt)}` : "", c.measuringAgain ? " (a newer run is going)" : "", "."));
    sources.replaceChildren(...lines.filter(Boolean) as Node[]);
  }

  function statusLine(): HTMLElement | null {
    if (st.projectError) return el("div", { class: "sh-card nt-bad" }, `Could not read the project: ${st.projectError}`);
    if (!st.project) return el("div", { class: "sh-card sh-dim" }, "Reading the catalogues…");
    const r = st.project.readStatus?.catalogues;
    if (r && (r.status === "unreadable" || r.status === "partial")) return el("div", { class: "sh-card nt-bad" }, `Catalogues ${r.status === "partial" ? "partly read" : "could not be read"}: ${r.errors.join("; ")}`);
    if (r?.status === "none") return el("div", { class: "sh-card" }, `${project} has no catalogues (no .anvi folder found for ${st.project.path}).`);
    return null;
  }

  function catTab(): HTMLElement {
    const q = search.value;
    const v = verdicts(st.currency);
    const grid = el("div", { class: "nt-grid4" });
    for (const k of KINDS) {
      const cat = st.project?.catalogues.find((c) => c.name === k.cat);
      const entries = cat?.entries ?? [];
      const shown = entries.filter((e) => matches(e, q));
      const gap = countGap(k.cat, entries, st.currency);
      const unit = k.cat === "dharana" ? "entries" : "";
      const col = el("div", { class: "nt-col", "data-cat": k.cat },
        el("h3", {}, `${k.label} · ${cat ? fmt(entries.length) : "none"}${unit && cat ? ` ${unit}` : ""}`, q && cat ? el("span", { class: "sh-dim" }, ` (${shown.length} match)`) : null),
        gap && gap.anvi !== entries.length
          ? el("div", { class: "sh-dim nt-gap" }, `anvi's currency report counts ${gap.anvi} here${gap.missing.length ? `; not listed: ${gap.missing.slice(0, 8).join(", ")}${gap.missing.length > 8 ? "…" : ""}` : ""}`)
          : null);
      const list = el("div", { class: "nt-list" });
      for (const e of shown.slice(0, 200)) {
        const verdict = v.get(key(k.cat, e.id));
        const tone = verdict?.status === "RED" ? "bad" : verdict?.status === "YELLOW" ? "warn" : verdict?.status === "GREEN" ? "ok" : "";
        list.append(el("div", { class: `nt-entry ${tone}`, title: e.ref ? `REF: ${e.ref}` : "no REF" },
          el("span", { class: "nt-id" }, e.id), el("b", {}, e.title), el("span", { class: "sh-dim" }, entryNote(e, st.currency, verdict))));
      }
      if (shown.length > 200) list.append(el("div", { class: "sh-dim" }, `${shown.length - 200} more; search to narrow.`));
      if (!cat) list.append(el("div", { class: "sh-dim" }, `No ${k.cat}.md in this project.`));
      col.append(list);
      grid.append(col);
    }
    return grid;
  }

  function whenTab(): HTMLElement {
    const card = el("div", { class: "sh-card" });
    if (st.routingError) return el("div", { class: "sh-card nt-bad" }, `Could not read the routing table: ${st.routingError}`);
    if (!st.routing) return el("div", { class: "sh-card sh-dim" }, "Reading the routing table…");
    const src = st.routing.source;
    if (src && src.status !== "ok") return el("div", { class: "sh-card nt-bad" }, `The routing table in ${src.path} ${src.status === "unreadable" ? "could not be read" : "did not parse"}: ${src.error ?? ""}`);
    const cols: Record<string, string> = { hetvabhasa: "Error patterns", vyapti: "Invariants", krama: "Lifecycles", dharana: "Focus map", "ground-truth": "Ground Truth" };
    const t = el("table", { class: "nt-matrix", id: "nt-when" }, el("tr", {}, el("th", {}, "activity"), ...WHEN_COLUMNS.map((c) => el("th", {}, cols[c]!))));
    const matrix = routingMatrix(st.routing.routingTable);
    const unnamed = WHEN_COLUMNS.filter((c) => !matrix.some((r) => r.named.has(c))).map((c) => cols[c]!);
    for (const row of matrix) {
      t.append(el("tr", {}, el("td", { class: "l" }, row.activity), ...WHEN_COLUMNS.map((c) => el("td", {}, row.named.has(c) ? el("i", { class: "nt-dot", title: `the routing table names ${cols[c]} for ${row.activity}` }) : ""))));
    }
    const u = st.usage;
    const injected = st.usageError
      ? `The injector's log could not be read: ${st.usageError}.`
      : !u
        ? "Reading the injector's log…"
        : u.status === "unreadable"
          ? `The injector's log could not be read: ${u.errors.join("; ")}.`
          : `On edits ${usageWindow(u, new Date()).text}: the injector delivered ${fmt(u.delivered.hetvabhasa)} error patterns, ${fmt(u.delivered.vyapti)} invariants and ${fmt(u.delivered.dharana)} focus-map boundaries on ${fmt(u.edits)} edits in ${fmt(u.sessions)} ${u.sessions === 1 ? "session" : "sessions"} of ${project}${u.status === "partial" ? ` (some logs could not be read: ${u.errors.length})` : ""}.`;
    card.append(t,
      el("div", { class: "sh-dim nt-note" }, el("i", { class: "nt-dot" }), ` named for the activity in the routing table (${src?.path ?? "~/.claude/CLAUDE.md"}).${unnamed.length ? ` No row names ${unnamed.join(" or ")}.` : ""}`),
      el("div", { class: "nt-note", id: "nt-injected" }, injected));
    return card;
  }

  function chart(pts: SeriesPoint[]): Node {
    if (!pts.length) return el("div", { class: "sh-dim" }, "No snapshot measures this project yet.");
    const W = 320, H = 130, L = 40, R = 310, T = 22, B = 106;
    const vals = pts.map((p) => p.value);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (lo === hi) (lo = Math.max(0, lo - 1), hi = hi + 1);
    const x = (i: number) => (pts.length === 1 ? (L + R) / 2 : L + ((R - L) * i) / (pts.length - 1));
    const y = (v: number) => B - ((B - T) * (v - lo)) / (hi - lo);
    const ns = "http://www.w3.org/2000/svg";
    const s = (tag: string, a: Record<string, string | number>, text?: string) => {
      const n = document.createElementNS(ns, tag);
      for (const [k, v] of Object.entries(a)) n.setAttribute(k, String(v));
      if (text !== undefined) n.textContent = text;
      return n;
    };
    const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%", "aria-label": "Out-of-date entries by snapshot", id: "nt-chart" });
    svg.append(s("line", { x1: L, y1: B, x2: R, y2: B, stroke: "var(--sh-line)" }), s("line", { x1: L, y1: T, x2: R, y2: T, stroke: "var(--sh-line)", "stroke-dasharray": "2 4" }));
    svg.append(s("text", { x: 2, y: T + 4, fill: "var(--sh-ink-3)", "font-size": 10 }, String(hi)), s("text", { x: 2, y: B + 4, fill: "var(--sh-ink-3)", "font-size": 10 }, String(lo)));
    svg.append(s("path", { d: pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`).join(" "), stroke: "var(--yellow)", fill: "none", "stroke-width": 2 }));
    pts.forEach((p, i) => {
      const c = s("circle", { cx: x(i), cy: y(p.value), r: p.live ? 4 : 3, fill: p.live ? "var(--accent)" : "var(--yellow)" });
      c.append(s("title", {}, `${p.live ? "now (live run)" : p.label}: ${p.value} of ${p.of}`));
      svg.append(c, s("text", { x: x(i) - 12, y: H - 10, fill: "var(--sh-ink-3)", "font-size": 9 }, p.label));
    });
    return svg;
  }

  function decayTab(): HTMLElement {
    const c = st.currency;
    const grid = el("div", { class: "nt-grid2" });
    // Series
    const s = st.series;
    const pts = seriesPoints(s, c);
    const seriesNote = s
      ? s.status === "unreadable"
        ? `Snapshots could not be read: ${s.errors.join("; ")}`
        : `Each point: 🟡 + 🔴 for "${s.key}" in a fleet snapshot (${s.dir}/health-<date>.json, dates UTC, written by anvi's catalogue-health.js --write)${pts.some((p) => p.live) ? "; the last point is the live run above" : ""}.${s.notMeasuredIn.length ? ` Not measured in the snapshots of ${s.notMeasuredIn.join(", ")}.` : ""}${s.status === "partial" ? ` Some could not be read: ${s.errors.join("; ")}` : ""}`
      : st.currencyError ? "" : "Reading the snapshots…";
    grid.append(el("div", { class: "sh-card" }, el("h3", {}, "Out-of-date entries over snapshots"), chart(pts),
      el("div", { class: "sh-dim nt-note" }, "Goal: each session ends with fewer drifted entries than it started with."),
      el("div", { class: "sh-dim nt-note", id: "nt-series-src" }, seriesNote)));

    // Oldest still used + freshness states
    const used = el("div", { class: "sh-card" }, el("h3", {}, "Oldest out-of-date entries that are still used"));
    if (c?.state === "ok") {
      const u = st.usage;
      const rows = oldestStillUsed(c, st.dates, u);
      if (st.usageError || u?.status === "unreadable") used.append(el("div", { class: "nt-bad" }, `Could not read the injector's log: ${st.usageError ?? u?.errors.join("; ")}`));
      else if (!u) used.append(el("div", { class: "sh-dim" }, "Reading the injector's log…"));
      else if (!rows.length) used.append(el("div", { class: "sh-dim", id: "nt-used-none" }, `The injector delivered none of the ${fmt(outOfDate(c)!.n)} out-of-date entries on an edit ${usageWindow(u, new Date()).text} (${fmt(u.edits)} edits of ${project} read in ${fmt(u.logsRead)} logs).`));
      else {
        used.append(el("table", { class: "nt-table", id: "nt-used" },
          el("tr", {}, el("th", {}, "entry"), el("th", {}, "text last changed"), el("th", { class: "num", title: usageWindow(u, new Date()).text }, `uses / ${usageWindow(u, new Date()).short}`)),
          ...rows.map((r) => el("tr", {}, el("td", { class: "nt-mono" }, r.id), el("td", { class: "nt-mono" }, r.lastChanged?.slice(0, 10) ?? (st.dates ? "unknown" : st.datesNote)), el("td", { class: "num" }, String(r.uses))))));
        used.append(el("div", { class: "sh-dim nt-note" }, `Uses: deliveries by the injector on edits ${usageWindow(u, new Date()).text} (/tmp/anvi-hook-<sid>.log, sessions of ${project}). Last changed: the entry's text, from the catalogue's git history${st.dates ? "" : ` (${st.datesNote})`}.`));
      }
      const cav = currencyCaveat(c);
      if (cav) used.append(el("div", { class: "nt-bad nt-note", id: "nt-caveat" }, `anvi's report ran ${cav}. Its counts on this screen are not a complete measurement.`));
      const sv = c.states ?? {};
      used.append(el("div", { class: "nt-note", id: "nt-states" }, `anvi's freshness of ${fmt(sv.primaries ?? 0)} primary entries: verified ${fmt(sv.verified ?? 0)} · drifted ${fmt(sv.drifted ?? 0)} · never confirmed ${fmt(sv["never confirmed"] ?? 0)} · not checked ${fmt(sv["not checked"] ?? 0)}.`));
    } else used.append(currencyState(c));
    grid.append(used);

    // Re-check a batch
    const re = el("div", { class: "sh-card nt-span2", id: "nt-batches" }, el("h3", {}, "Re-check a batch, by subsystem"));
    const bs = batches(c);
    if (c?.state !== "ok") re.append(currencyState(c));
    else if (!bs.length) re.append(el("div", { class: "sh-dim" }, "anvi's report marks no entry out of date."));
    else {
      re.append(el("div", { class: "sh-dim nt-note" }, "A subsystem is the folder (two levels at most) most of an entry's changed or gone files are in. Re-check starts one agent on that batch; you see its prompt first."));
      for (const b of bs) {
        const btn = el("button", { type: "button", class: "sh-btn nt-warn", "data-subsystem": b.subsystem }, "Re-check");
        btn.onclick = () => askRecheck(b);
        re.append(el("details", { class: "nt-batch" },
          el("summary", {}, el("b", {}, b.subsystem), ` · ${b.entries.length} out of date `, btn),
          el("div", { class: "nt-batch-list" }, ...b.entries.map((v) => el("div", {}, el("span", { class: "nt-id" }, v.id), el("span", { class: "sh-dim" }, ` ${v.catalogue} · ${whyOutOfDate(v)}`))))));
      }
    }
    grid.append(re);
    return grid;
  }

  function currencyState(c: CurrencyAnswer | null): HTMLElement {
    if (st.currencyError) return el("div", { class: "nt-bad" }, `Could not ask for anvi's currency report: ${st.currencyError}`);
    if (!c || c.state === "measuring") return el("div", { class: "sh-dim", id: "nt-measuring" }, `anvi's currency report is running${c?.startedAt ? ` (since ${local(c.startedAt)})` : ""}; a large catalogue takes minutes. This page asks again every 5 seconds.`);
    if (c.state === "none") return el("div", {}, `anvi's currency report found no catalogues: ${c.reason ?? ""}`);
    return el("div", { class: "nt-bad" }, `anvi's currency report ${c.state === "withheld" ? "refused to read the catalogues" : "could not answer"}: ${c.reason ?? ""}. Nothing is known about freshness; this is not "nothing out of date".`);
  }

  function groundTab(): HTMLElement {
    const g = st.project?.grounding;
    if (!g) return el("div", { class: "sh-card sh-dim" }, "Reading…");
    const card = el("div", { class: "sh-card" });
    const docs = g.groundTruthDocs;
    if (g.readStatus?.status === "unreadable") card.append(el("div", { class: "nt-bad" }, `Ground Truth docs could not be read: ${g.readStatus.errors.join("; ")}`));
    if (!docs.length) card.append(el("div", { class: "sh-dim" }, g.readStatus?.status === "unreadable" ? "" : `No Ground Truth docs (GROUND_TRUTH_*.md) in ${g.readStatus?.path ?? "the project's ref folder"}.`));
    else {
      const cites = citations(docs, allEntries());
      const now = new Date();
      const gt = st.gtError ? null : st.gt;
      const cell = (system: string, f: (d: GtDocCheck) => number) => {
        const d = gt?.docs.find((x) => x.system === system);
        return d && gt && gt.state !== "not-measured" ? String(f(d)) : st.gt || st.gtError ? "not measured" : "checking…";
      };
      card.append(el("table", { class: "nt-table", id: "nt-gt" },
        el("tr", {}, el("th", {}, "Ground Truth doc"), el("th", {}, "age"), el("th", {}, "sections traced"), el("th", { class: "num" }, "file:line citations"), el("th", { class: "num" }, "entries citing it")),
        ...docs.map((d) => el("tr", {},
          el("td", { class: "nt-mono", title: d.path }, d.system),
          el("td", { title: `file last modified ${String(d.lastModified)}` }, `${ageDays(d.lastModified, now)} days`),
          el("td", {}, st.gtError ? "not measured" : sectionsText(st.gt, d.system)),
          el("td", { class: "num" }, cell(d.system, (x) => x.citations)),
          el("td", { class: "num" }, String(cites.get(d.system) ?? 0))))));
    }
    const gtSrc = st.gtError
      ? ` anvi's citation check could not be asked: ${st.gtError}.`
      : st.gt?.command
        ? ` Sections and citations: ${st.gt.command}, run ${local(st.gt.ranAt)}${st.gt.state === "not-measured" ? `: not measured (${st.gt.reason ?? "?"})` : st.gt.state === "missing" ? ": some section neither cites code nor says why" : ""}.`
        : "";
    card.append(el("div", { class: "sh-dim nt-note", id: "nt-gt-note" },
      `Each entry traces catalogue → Ground Truth stage → source file:line. ${fmt(g.ungroundedEntries)} of ${fmt(g.totalEntries)} entries are ungrounded (no REF, or REF says UNGROUNDED). Age: days since the doc's file last changed. Entries citing it: entries whose text names GROUND_TRUTH_<doc>.${gtSrc}`,
      g.sourceDirectories.length ? ` Downloaded sources: ${g.sourceDirectories.join(", ")}.` : ""));
    return card;
  }

  function memTab(): HTMLElement {
    const p = st.project;
    if (!p) return el("div", { class: "sh-card sh-dim" }, "Reading…");
    const r = p.readStatus?.memory;
    const list = el("div", { class: "nt-stack", id: "nt-memory" });
    if (r && (r.status === "unreadable" || r.status === "partial")) list.append(el("div", { class: "nt-bad" }, `Memory ${r.status === "partial" ? "partly read" : "could not be read"}: ${r.errors.join("; ")}`));
    if (!p.memory.length && r?.status !== "unreadable") list.append(el("div", { class: "sh-dim" }, `No project memory notes in ${r?.path ?? "the project's memory folder"}.`));
    for (const m of p.memory) {
      const hint = recurrenceHint(m);
      const btn = el("button", { type: "button", class: "sh-btn", "data-memory": memoryFile(m) }, "Promote");
      btn.onclick = () => ask(`Promote ${memoryFile(m)} to the focus map?`, promotePrompt(project, m));
      list.append(el("div", { class: "nt-mem" },
        el("span", { class: "nt-mono" }, memoryFile(m)),
        el("span", { class: "sh-dim" }, `${m.type} · ${m.description}`),
        hint ? el("span", { class: "nt-hint", title: "quoted from the note" }, `says: “${hint}”`) : null,
        btn));
    }
    return el("div", { class: "nt-grid2" },
      el("div", { class: "sh-card" }, el("h3", {}, "Project memory"), list, el("div", { class: "sh-dim nt-note" }, `${r?.path ?? ""}. "says" quotes a line that mentions a recurrence; whether it recurred is the agent's call, then yours.`)),
      el("div", { class: "sh-card" }, el("h3", {}, "Rule for promotion"), el("div", { class: "sh-dim" }, "Seen once: stays in memory. Seen again: becomes a focus-map entry, recording where it came from, why it matters and how to check it.")));
  }

  function paint() {
    paintTabs();
    paintHead();
    paintSources();
    const top = statusLine();
    const view = tab === "cat" ? catTab() : tab === "when" ? whenTab() : tab === "decay" ? decayTab() : tab === "ground" ? groundTab() : memTab();
    body.replaceChildren(...[top, view].filter(Boolean) as Node[]);
  }

  search.addEventListener("input", () => {
    if (tab !== "cat") tab = "cat";
    paint();
    search.focus();
  });

  // ── Loading ───────────────────────────────────────────────────────────────────────────
  const alive = () => wrap.isConnected;

  async function loadCurrency(refresh = false) {
    const r = await getJson<{ currency: CurrencyAnswer; series: SnapshotSeries }>(`/api/notes/currency?project=${encodeURIComponent(project)}${refresh ? "&refresh=1" : ""}`);
    if (!r.ok) st.currencyError = r.error;
    else {
      st.currencyError = null;
      st.currency = r.value.currency;
      st.series = r.value.series;
    }
    paint();
    if (r.ok && (r.value.currency.state === "measuring" || r.value.currency.measuringAgain)) setTimeout(() => alive() && void loadCurrency(), 5000);
  }

  async function loadDates() {
    // The first ask runs before the screen is in the page, so only later asks check alive().
    for (let i = 0; i < 120 && (i === 0 || alive()); i++) {
      try {
        const r = await api.entryDatesRead(project);
        if (r.status === "ready") {
          st.dates = r.dates;
          break;
        }
        if (r.status === "failed") {
          st.datesNote = `dates could not be read: ${r.error}`;
          break;
        }
        st.datesNote = "still reading git history";
      } catch (e) {
        st.datesNote = `dates could not be read: ${(e as Error).message}`;
        break;
      }
      await new Promise((ok) => setTimeout(ok, 1500));
    }
    if (alive()) paint();
  }

  paint();
  void api.project(project).then(
    (p) => ((st.project = p), paint()),
    (e) => ((st.projectError = (e as Error).message), paint()),
  );
  void loadCurrency();
  void getJson<UsageAnswer>(`/api/notes/usage?project=${encodeURIComponent(project)}`).then((r) => {
    if (r.ok) st.usage = r.value;
    else st.usageError = r.error;
    if (alive()) paint();
  });
  void api.routingArchitecture().then(
    (r) => ((st.routing = r), alive() && paint()),
    (e) => ((st.routingError = (e as Error).message), alive() && paint()),
  );
  void loadDates();
  void getJson<GtCheckAnswer>(`/api/notes/grounding?project=${encodeURIComponent(project)}`).then((r) => {
    if (r.ok) st.gt = r.value;
    else st.gtError = r.error;
    if (alive()) paint();
  });

  // "Measure again" lives with the source line.
  const again = el("button", { type: "button", class: "sh-btn nt-again", id: "nt-measure" }, "Run anvi's currency report again");
  again.onclick = () => void loadCurrency(true);
  wrap.append(again);
  return wrap;
}
