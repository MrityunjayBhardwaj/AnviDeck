/**
 * Design (#87): five lenses on one project's design, from anvi's own instruments.
 *   Armed         — what is enforced (the registry and the guard's verdict at the measured commit),
 *                   and the trial record: each refused edit with your call on it (#86).
 *   Placed        — a placement in review (when a source records one), and Ask before writing,
 *                   which starts an agent with the question (the prompt is shown first, exactly).
 *   Consolidated  — where problems cluster, and files touched per fix from git history.
 *   Path to target — the moves, when a source lists them; else the measured distance.
 *   System flows  — how an edit passes through anvi, with the measured figure on each step.
 *
 * The rules live in design-model.ts (tested); this file only builds the DOM. All server text is
 * set as text, never as HTML.
 */
import { api } from "../api";
import { write, WriteError } from "../write";
import { refusalCall } from "./RefusalCall";
import type { StructureMeasured, StructureProjectResponse } from "../../shared/structure-types";
import type { CallRecord, CallVerdict, RefusalsResponse } from "../../shared/refusal-types";
import type { EditHooksAnswer, FixCostAnswer } from "../../shared/design-types";
import type { ProjectState } from "../../shared/types";
import {
  LENSES,
  NO_MOVES_SOURCE,
  NO_FATALITY_SIGNALS,
  NO_PLACEMENT,
  askPrompt,
  askQuestion,
  filesPhrase,
  boundaryClusters,
  callStates,
  costGap,
  curveGeometry,
  day,
  enforcement,
  flowNodes,
  headlinePair,
  heldGroups,
  lensOf,
  measuredPhrase,
  pairClusters,
  seriesPhrase,
  structureGap,
  tally,
  trialRows,
  trialSummary,
  type Lens,
} from "./design-model";

type Kid = Node | string | null | undefined | false;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const k of kids) if (k !== null && k !== undefined && k !== false) e.append(typeof k === "string" ? document.createTextNode(k) : k);
  return e;
}
const SVG = "http://www.w3.org/2000/svg";
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, ...kids: (SVGElement | string)[]): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  for (const k of kids) e.append(typeof k === "string" ? document.createTextNode(k) : k);
  return e;
}

function ensureStyles() {
  if (document.querySelector("link[data-design-css]")) return;
  document.head.appendChild(el("link", { rel: "stylesheet", href: "/styles/design.css", "data-design-css": "" }));
}

async function getJson<T>(url: string): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    const res = await fetch(url);
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    // The structure reader answers 404 with its own shape for a project nobody knows: keep its words.
    if (!res.ok && typeof j.status !== "string") return { ok: false, error: typeof j.error === "string" ? j.error : `status ${res.status}` };
    return { ok: true, value: j as T };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

const arrow = (s: string) => s.replace(/ -> /g, " → ");

interface State {
  structure: StructureProjectResponse | null;
  structureError: string | null;
  refusals: RefusalsResponse | null;
  refusalsError: string | null;
  recorded: Record<string, CallVerdict>;
  project: ProjectState | null;
  projectError: string | null;
  cost: FixCostAnswer | null;
  costError: string | null;
  hooks: EditHooksAnswer | null;
  hooksError: string | null;
}

export function DesignScreen(projectName: string | null, params: URLSearchParams): HTMLElement {
  ensureStyles();
  const wrap = el("section", { class: "sh-screen dz", "data-screen": "design" });
  const sub = el("span", { class: "sh-sub", id: "dz-sub" }, "actual imports over the declared design");
  const acts = el("div", { class: "dz-acts" });
  wrap.append(el("div", { class: "sh-head" }, el("h1", {}, "Project · Design"), sub, acts));
  if (!projectName) {
    wrap.append(el("div", { class: "sh-card" }, "Pick a project in the switcher above."));
    return wrap;
  }
  const project = projectName;
  acts.append(el("a", { class: "sh-btn dz-link", href: `#map?project=${encodeURIComponent(project)}`, id: "dz-map" }, "See the graph on Map"));

  let lens: Lens = lensOf(params);
  const tabBar = el("div", { class: "dz-tabs", role: "tablist", id: "lens-tabs" });
  const body = el("div", { class: "dz-body" });
  const sources = el("div", { class: "sh-dim dz-sources", id: "dz-sources" });
  wrap.append(tabBar, body, sources);

  const st: State = {
    structure: null, structureError: null, refusals: null, refusalsError: null, recorded: {},
    project: null, projectError: null, cost: null, costError: null, hooks: null, hooksError: null,
  };
  const measured = (): StructureMeasured | null => (st.structure?.status === "measured" ? st.structure : null);

  // A call recorded on a trial row recounts the summary from the record the server returned.
  wrap.addEventListener("refusal-call-recorded", (e) => {
    const rec = (e as CustomEvent<CallRecord>).detail;
    if (rec?.key) st.recorded[rec.key] = rec.call;
    paint();
  });

  function paintTabs() {
    tabBar.replaceChildren(...LENSES.map((l) => {
      const b = el("button", { type: "button", role: "tab", "data-lens": l.k, class: l.k === lens ? "on" : "" }, l.label);
      b.onclick = () => {
        lens = l.k;
        history.replaceState(null, "", `#design?lens=${l.k}`);
        paint();
      };
      return b;
    }));
  }

  function paintHead() {
    const s = measured();
    if (st.structure?.status === "no-design") return void sub.replaceChildren(`${project} · registers no design with anvi's structure guard`);
    sub.replaceChildren(
      `${project} · actual imports over the declared design `,
      s ? el("span", { class: "dz-mono" }, s.designId) : st.structure || st.structureError ? "(not measured)" : "(reading…)",
      s ? ` · measured at ${measuredPhrase(s)}` : "",
    );
  }

  // ── Armed ─────────────────────────────────────────────────────────────────────────────
  function armed(): HTMLElement {
    const grid = el("div", { class: "dz-grid2" });
    const gap = structureGap(st.structure, st.structureError);
    const s = measured();
    const enf = el("div", { class: "sh-card", id: "dz-enforcement" }, el("h3", {}, "Enforcement"));
    if (gap) enf.append(el("div", { class: "dz-gap" }, gap));
    else if (!s) enf.append(el("div", { class: "sh-dim" }, "Reading the registry and measuring with the guard…"));
    else {
      const dl = el("dl", { class: "dz-kv" });
      for (const r of enforcement(s, st.hooks)) dl.append(el("dt", {}, r.k), el("dd", {}, el("span", { class: `dz-chip ${r.tone ?? ""}` }, r.v), r.note ? el("span", { class: "sh-dim" }, ` ${r.note}`) : null));
      enf.append(dl);
    }
    grid.append(enf, trialCard());
    return grid;
  }

  function trialCard(): HTMLElement {
    const card = el("div", { class: "sh-card", id: "dz-trial" }, el("h3", {}, "Trial record"));
    if (st.refusalsError) return (card.append(el("div", { class: "dz-gap" }, `The trial record could not be read: ${st.refusalsError}.`)), card);
    const r = st.refusals;
    if (!r) return (card.append(el("div", { class: "sh-dim" }, "Asking anvi's structure-refusals.js…")), card);
    const { rows, merged } = trialRows(r);
    const t = tally(rows, callStates(r, st.recorded));
    const sum = trialSummary(r, t, merged);
    if ("gap" in sum) return (card.append(el("div", { class: r.status === "measuring" ? "sh-dim" : "dz-gap" }, sum.gap)), card);
    if (rows.length) {
      const table = el("table", { class: "dz-table" }, el("tr", {}, el("th", {}, "when"), el("th", {}, "edge"), el("th", {}, "file"), el("th", {}, "refused by")));
      for (const row of rows) {
        table.append(el("tr", { "data-key": row.key, "data-tour": "blocked-edit", "data-at": row.at, "data-session": row.session }, el("td", { class: "dz-mono" }, day(row.at).slice(5)), el("td", { class: "dz-mono" }, arrow(row.edge)), el("td", { class: "dz-mono", title: row.file }, row.file.split("/").pop() ?? row.file), el("td", {}, row.refusedBy, row.design ? el("span", { class: "sh-dim" }, ` · design ${row.design}`) : el("span", { class: "sh-dim" }, " · before refusals named a design"))));
        table.append(el("tr", { class: "dz-callrow", "data-tour": "your-call" }, el("td", { colspan: "4" }, refusalCall({ key: row.key, project, refusal: { session: row.session, tool: row.tool, file: row.file, at: row.at, ...(r.status === "measured" ? { path: `${r.package}/${row.file}` } : {}) } }))));
      }
      card.append(table);
    }
    card.append(el("div", { class: "dz-note", id: "dz-trial-sum" }, sum.line), el("div", { class: "sh-dim dz-note", id: "dz-trial-pop" }, sum.population));
    if (r.status === "measured" && r.textReportCut) card.append(el("div", { class: "dz-gap", id: "dz-trial-cut" }, r.textReportCut));
    else if (r.status === "measured" && r.trialReading) card.append(el("div", { class: "sh-dim dz-note dz-mono" }, r.trialReading));
    return card;
  }

  // ── Placed ────────────────────────────────────────────────────────────────────────────
  const question = el("input", { type: "text", id: "dz-question", placeholder: "e.g. where should a new 'tempo map' module go?", "aria-label": "Placement question" });
  const confirm = el("div", { class: "dz-confirm", id: "dz-confirm", hidden: "" });

  function placed(): HTMLElement {
    const grid = el("div", { class: "dz-grid2" });
    grid.append(el("div", { class: "sh-card", id: "dz-placement", "data-tour": "placement" },el("h3", {}, "Placement in review"), el("div", { class: "dz-gap" }, NO_PLACEMENT)));
    const s = measured();
    const askBtn = el("button", { class: "sh-btn", type: "button", id: "dz-ask" }, "Ask");
    const card = el("div", { class: "sh-card", id: "dz-askcard", "data-tour": "ask-placement" },el("h3", {}, "Ask before writing"), el("div", { class: "dz-composer" }, question, askBtn), confirm);
    const gap = structureGap(st.structure, st.structureError);
    if (gap || !s) {
      askBtn.disabled = true;
      card.append(el("div", { class: "sh-dim" }, gap ?? "Waiting for the design: the question is asked against it."));
    } else card.append(el("div", { class: "sh-dim dz-note" }, "Ask starts one Claude Code agent with the question. It is shown in full first; nothing starts until you press Start agent."));
    askBtn.onclick = () => {
      const q = askQuestion(question.value);
      if (!q.ok) {
        confirm.replaceChildren(el("div", { class: "dz-gap", id: "dz-ask-empty" }, q.why));
        confirm.hidden = false;
        return;
      }
      if (s) ask(askPrompt(project, s, q.question));
    };
    grid.append(card);
    return grid;
  }

  function ask(prompt: string) {
    // The one request Start agent sends: built once, shown below, and sent as is.
    const send = Object.freeze({ cwd: st.project?.path ?? "", prompt });
    const cwd = send.cwd;
    const out = el("div", { "aria-live": "polite" });
    const go = el("button", { type: "button", class: "sh-btn dz-go", id: "dz-start" }, "Start agent");
    const cancel = el("button", { type: "button", class: "sh-btn", id: "dz-cancel" }, "Cancel");
    confirm.replaceChildren(
      el("div", { class: "sh-dim" }, "Nothing has started. Start agent runs one Claude Code agent (on your Claude Code login) in ", el("span", { class: "dz-mono", id: "dz-cwd" }, cwd || "(no folder known)"), " and tells it exactly this:"),
      el("pre", { class: "dz-prompt", id: "dz-prompt" }, send.prompt),
      el("div", { class: "dz-row" }, go, cancel),
      out,
    );
    confirm.hidden = false;
    cancel.onclick = () => (confirm.hidden = true);
    if (!cwd) go.disabled = true;
    go.onclick = async () => {
      go.disabled = true;
      out.replaceChildren(el("span", { class: "sh-dim" }, "Starting…"));
      try {
        const a = await write<{ id: string; status: string }>("POST", "/api/agents", { cwd: send.cwd, prompt: send.prompt });
        cancel.textContent = "Close";
        out.replaceChildren(el("span", { class: "dz-ok" }, "Started agent ", el("b", { id: "dz-agent" }, a.id), ` (${a.status}). `), el("a", { href: `#agents?agent=${encodeURIComponent(a.id)}` }, "Open it on Agents"));
      } catch (e) {
        out.replaceChildren(el("span", { class: "dz-bad" }, `Not started: ${e instanceof WriteError ? e.message : (e as Error).message}`));
        go.disabled = false;
      }
    };
  }

  // ── Consolidated ──────────────────────────────────────────────────────────────────────
  function consolidated(): HTMLElement {
    const grid = el("div", { class: "dz-grid2" });
    const card = el("div", { class: "sh-card", id: "dz-clusters", "data-tour": "clusters" },el("h3", {}, "Where problems cluster"));
    const gap = structureGap(st.structure, st.structureError);
    const s = measured();
    if (gap) card.append(el("div", { class: "dz-gap" }, gap));
    else if (!s) card.append(el("div", { class: "sh-dim" }, "Measuring with the guard…"));
    else {
      const rows = pairClusters(s);
      card.append(el("div", { class: "dz-sub" }, "Rule breaks the design still allows, by component pair"));
      if (!rows.length) card.append(el("div", {}, `0 of ${s.counts.examinedBetweenComponents} imports between components break the design.`));
      else {
        const t = el("table", { class: "dz-table", id: "dz-pairs" }, el("tr", {}, el("th", {}, "where"), el("th", { class: "num" }, "held breaks")));
        for (const r of rows) t.append(el("tr", {}, el("td", { class: "dz-mono" }, r.where), el("td", { class: "num" }, String(r.count))));
        card.append(t);
      }
      card.append(el("div", { class: "sh-dim dz-note", "data-tour": "clusters-measured" }, `Measured by anvi's structure guard at ${measuredPhrase(s)}: ${s.counts.divergence.grandfathered} held of ${s.counts.examinedBetweenComponents} imports between components.`));
    }
    card.append(el("div", { class: "dz-gap", id: "dz-no-signals" }, NO_FATALITY_SIGNALS));
    card.append(el("div", { class: "dz-sub" }, "Boundaries where the project's catalogue says the fatality test tripped"));
    if (st.projectError) card.append(el("div", { class: "dz-gap" }, `The catalogues could not be read: ${st.projectError}.`));
    else if (!st.project) card.append(el("div", { class: "sh-dim" }, "Reading the catalogues…"));
    else {
      const rs = st.project.readStatus?.catalogues;
      if (rs && rs.status !== "ok") card.append(el("div", { class: "dz-gap" }, `Catalogues ${rs.status}: ${rs.errors.join("; ") || rs.path || ""}`));
      const bs = boundaryClusters(st.project.boundaries);
      if (rs?.status === "ok" || !rs) {
        if (!st.project.catalogues.some((c) => c.name === "dharana")) card.append(el("div", {}, `No dharana.md among ${project}'s catalogues${rs?.path ? ` (${rs.path})` : ""}: no boundary is tracked, so none can say the fatality test tripped.`));
        else if (!st.project.boundaries.length) card.append(el("div", {}, "dharana.md names no boundaries (no B-numbered entries)."));
        else {
          const t = el("table", { class: "dz-table", id: "dz-boundaries" }, el("tr", {}, el("th", {}, "boundary"), el("th", {}, "as its heading states"), el("th", {}, "dated")));
          for (const b of bs) t.append(el("tr", {}, el("td", {}, el("span", { class: "dz-mono sh-dim" }, `${b.id} `), b.name), el("td", {}, b.stated ?? el("span", { class: "sh-dim" }, "tripped (no count given)")), el("td", { class: "dz-mono" }, b.date ?? "?")));
          card.append(bs.length ? t : el("div", {}, `0 of ${st.project.boundaries.length} boundaries say the fatality test tripped.`));
          card.append(el("div", { class: "sh-dim dz-note" }, `${bs.length} of ${st.project.boundaries.length} boundaries in ${rs?.path ?? "the project's .anvi"}/dharana.md. The counts and dates are the catalogue's own words, not measured here.`));
        }
      }
    }
    grid.append(card, costCard());
    return grid;
  }

  function costCard(): HTMLElement {
    const card = el("div", { class: "sh-card", id: "dz-cost" }, el("h3", {}, "Cost curve · files touched per fix"));
    if (!st.cost && !st.costError) return (card.append(el("div", { class: "sh-dim" }, "Reading the fix history…")), card);
    const gap = costGap(st.cost, st.costError);
    if (gap) return (card.append(el("div", { class: "dz-gap", id: "dz-cost-gap" }, gap)), card);
    const c = st.cost!;
    if (c.status !== "measured") return card;
    const p = headlinePair(c)!;
    const files = p.fixes.map((f) => f.files);
    const W = 640, H = 170;
    const g = curveGeometry(files, W, H);
    const tone = p.trend === "rising" ? "var(--red)" : p.trend === "falling" ? "var(--green)" : "var(--sh-ink-2)";
    const chart = svg("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%", "aria-label": "Files touched per fix", id: "dz-curve" },
      svg("line", { x1: 30, y1: g.base, x2: W - 12, y2: g.base, stroke: "var(--sh-line)" }),
      svg("line", { x1: 30, y1: g.top, x2: W - 12, y2: g.top, stroke: "var(--sh-line)", "stroke-dasharray": "2 4" }),
      svg("path", { d: g.d, stroke: tone, fill: "none", "stroke-width": 2 }),
      ...g.xs.map((x, i) => svg("circle", { cx: x.toFixed(1), cy: g.ys[i].toFixed(1), r: 3, fill: tone }, svg("title", {}, `${day(p.fixes[i].date)} ${p.fixes[i].sha.slice(0, 8)}: ${p.fixes[i].files} files · ${p.fixes[i].subject}`))),
      svg("text", { x: 4, y: g.base + 4, fill: "var(--sh-ink-3)", "font-size": 10 }, "0"),
      svg("text", { x: 4, y: g.top + 4, fill: "var(--sh-ink-3)", "font-size": 10 }, String(g.max)),
      svg("text", { x: 30, y: H - 4, fill: "var(--sh-ink-3)", "font-size": 10 }, day(p.fixes[0].date)),
      svg("text", { x: W - 12, y: H - 4, fill: "var(--sh-ink-3)", "font-size": 10, "text-anchor": "end" }, day(p.fixes[p.fixes.length - 1].date)),
    );
    card.append(
      el("div", {}, el("span", { class: "dz-mono" }, arrow(p.pair)), ` · ${p.held} held breaks · `, el("span", { class: `dz-chip ${p.trend === "rising" ? "bad" : p.trend === "falling" ? "ok" : ""}`, id: "dz-trend" }, p.trend)),
      chart,
      el("div", { class: "dz-note" }, seriesPhrase(p)),
    );
    const others = c.pairs.filter((x) => x !== p);
    if (others.length) {
      const t = el("table", { class: "dz-table" }, el("tr", {}, el("th", {}, "other pairs"), el("th", {}, "fixes and files touched"), el("th", {}, "trend")));
      for (const o of others) t.append(el("tr", {}, el("td", { class: "dz-mono" }, arrow(o.pair)), el("td", {}, seriesPhrase(o)), el("td", {}, o.trend)));
      card.append(t);
    }
    card.append(el("div", { class: "sh-dim dz-note", id: "dz-cost-src" },
      `Measured from git history at ${c.at.ref} ${c.at.sha.slice(0, 7)}${c.at.date ? ` (commit of ${day(c.at.date)})` : ""}: ${c.fixCommits} fixes among ${c.commits} commits on the package. Predicate: ${c.predicate}. Trend: ${c.trendRule}. ${c.unmappedFiles} files changed by fixes are outside every component and count toward no pair.`));
    return card;
  }

  // ── Path to target ────────────────────────────────────────────────────────────────────
  function path(): HTMLElement {
    const card = el("div", { class: "sh-card", id: "dz-path", "data-tour": "path" },el("h3", {}, "From current to declared design"), el("div", { class: "dz-gap" }, NO_MOVES_SOURCE));
    const gap = structureGap(st.structure, st.structureError);
    const s = measured();
    if (gap) return (card.append(el("div", { class: "dz-gap" }, gap)), card);
    if (!s) return (card.append(el("div", { class: "sh-dim" }, "Measuring with the guard…")), card);
    const groups = heldGroups(s);
    if (!groups.length) card.append(el("div", {}, `0 rule breaks held: today's imports at ${measuredPhrase(s)} are what the design allows.`));
    const ol = el("ol", { class: "dz-moves" });
    for (const g of groups)
      ol.append(el("li", {}, el("b", { class: "dz-mono" }, g.pair), el("span", { class: "dz-tag" }, `${g.imports.length} held`),
        el("div", { class: "dz-imports" }, ...g.imports.map((i) => el("div", { class: "dz-mono sh-dim" }, `${i.from} → ${i.to}`)))));
    if (groups.length) card.append(ol);
    const c = s.counts;
    card.append(el("div", { class: "sh-dim dz-note" },
      `Measured by anvi's structure guard at ${measuredPhrase(s)}: ${c.divergence.grandfathered} held, ${c.divergence.new} new, ${c.cycle.total} on cycles; ${c.divergence.fixed} baseline entries no longer occur${s.rules.divergence.fixed.length ? ` (${s.rules.divergence.fixed.join("; ")})` : ""}.`));
    return card;
  }

  // ── System flows ──────────────────────────────────────────────────────────────────────
  function flows(): HTMLElement {
    const r = st.refusals;
    const rows = r ? trialRows(r).rows : [];
    const t = r && r.status === "measured" ? tally(rows, callStates(r, st.recorded)) : null;
    const nodes = flowNodes(r, st.hooks, t);
    const card = el("div", { class: "sh-card", id: "dz-flows" }, el("h3", {}, "How an edit flows through anvi"),
      el("div", { class: "sh-dim dz-note" }, "The steps and arrows are a fixed description of how anvi handles an edit, the same for every project. The figure on each step is measured, with its source beside it; a step with no figure is not measured here."));
    if (st.hooksError) card.append(el("div", { class: "dz-gap" }, `Your settings could not be read: ${st.hooksError}.`));
    const flow = el("div", { class: "dz-flow" });
    for (const [i, n] of nodes.entries()) {
      flow.append(el("div", { class: `dz-step ${n.id}`, "data-step": n.id },
        el("b", {}, n.label),
        el("div", { class: "sh-dim" }, n.what),
        el("div", { class: "dz-fig" }, n.figure ?? el("span", { class: "sh-dim" }, "not measured here")),
        el("div", { class: "dz-src" }, n.source)));
      if (n.next) flow.append(el("div", { class: "dz-arrow", "aria-hidden": "true", title: n.next === "with" ? "at the same time" : "" }, n.next));
    }
    card.append(flow);
    return card;
  }

  function paintSources() {
    const lines: string[] = [];
    const s = measured();
    if (s) lines.push(`Design and verdicts: anvi's structure guard (${s.source.label}), ${s.package.source} registry, measured at ${measuredPhrase(s)} (${s.refChosenBy}).`);
    if (st.refusals?.status === "measured") lines.push(`Trial record: ${st.refusals.instrument.path} (sha256 ${st.refusals.instrument.sha256.slice(0, 12)}), run ${st.refusals.instrument.ranAt}; your calls from ${st.refusals.calls.file} (${st.refusals.calls.status} when read at ${st.refusals.calls.readAt}; ${st.refusals.calls.notListed} of your ${st.refusals.calls.ofProject} calls on ${st.refusals.project} are on edits this answer does not list${Object.keys(st.recorded).length ? `; ${Object.keys(st.recorded).length} recorded on this page since` : ""}).`);
    if (st.cost?.status === "measured") lines.push(`Cost curve: ${st.cost.command}`);
    if (st.hooks) lines.push(`Edit hooks: ${filesPhrase(st.hooks)}, read ${st.hooks.readAt}; ${st.hooks.notRead}.`);
    sources.replaceChildren(...lines.map((l) => el("div", {}, l)));
  }

  function paint() {
    paintTabs();
    paintHead();
    const view = lens === "armed" ? armed() : lens === "placed" ? placed() : lens === "consolidated" ? consolidated() : lens === "path" ? path() : flows();
    body.replaceChildren(view);
    paintSources();
  }

  // ── Loading ───────────────────────────────────────────────────────────────────────────
  const live = () => wrap.isConnected || !wrap.dataset.mounted;
  getJson<StructureProjectResponse>(`/api/structure/${encodeURIComponent(project)}`).then((r) => {
    if (r.ok) st.structure = r.value;
    else st.structureError = r.error;
    paint();
  });
  const pollRefusals = async () => {
    const r = await getJson<RefusalsResponse>(`/api/refusals?project=${encodeURIComponent(project)}`);
    if (r.ok) st.refusals = r.value;
    else st.refusalsError = r.error;
    paint();
    // The instrument answers "measuring" on the first ask; ask again while the screen is open.
    if (r.ok && r.value.status === "measuring") setTimeout(() => live() && void pollRefusals(), 4000);
  };
  void pollRefusals();
  api.project(project).then((p) => ((st.project = p), paint()), (e: Error) => ((st.projectError = e.message), paint()));
  getJson<FixCostAnswer>(`/api/design/cost?project=${encodeURIComponent(project)}`).then((r) => {
    if (r.ok) st.cost = r.value;
    else st.costError = r.error;
    paint();
  });
  getJson<EditHooksAnswer>(`/api/design/hooks?project=${encodeURIComponent(project)}`).then((r) => {
    if (r.ok) st.hooks = r.value;
    else st.hooksError = r.error;
    paint();
  });
  queueMicrotask(() => (wrap.dataset.mounted = "1"));

  paint();
  return wrap;
}
