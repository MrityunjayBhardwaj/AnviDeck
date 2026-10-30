import type { ProjectSummary } from "../../shared/types";
import type { HomeAgent, HomeMetric, HomeResponse, HomeSource, QueueItem } from "../../shared/home-types";
import type { Nav } from "../app";
import { headlineText, type NeedsCount } from "../home-count";

/**
 * Home (#18): one decision queue, a one-line status, the agents. Everything else is one
 * click away. AnviDeck is read-only, so each row's one button is a deep link (open a PR) or
 * a command to copy (`cd <dir>`); nothing here acts.
 *
 * The headline reads `count` (from needsCount in app.ts), never the queue's length itself.
 */

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// The status line's open/closed state survives the 60 s refresh.
let statusOpen = false;
let queueExpanded = false;
const QUEUE_SHOWN = 5;

export function CommandCenter(
  projects: ProjectSummary[],
  nav: Nav,
  home: HomeResponse | null,
  count: NeedsCount
): HTMLElement {
  const el = document.createElement("div");
  el.className = "home";

  // ── headline ──
  const head = document.createElement("div");
  head.className = "home-head";
  const checked = home ? new Date(home.generatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;
  head.innerHTML = `
    <h1 class="home-h1">${esc(headlineText(count))}</h1>
    <span class="home-sub">soonest first · no source records a deadline${checked ? ` · checked ${checked}` : ""}</span>`;
  el.appendChild(head);

  // ── the queue ──
  el.appendChild(queueEl(home, count));

  // ── one-line status ──
  el.appendChild(statusEl(home, count.state === "failed"));

  // ── agents ──
  el.appendChild(agentsEl(home, nav, count.state === "failed"));

  // ── what Home used to show, one click away ──
  el.appendChild(cataloguesEl(projects, nav));

  const foot = document.createElement("div");
  foot.className = "home-foot";
  foot.textContent = "Every row and figure names its source. Nothing on this page is an example: all of it is read when the page loads, and again every minute.";
  el.appendChild(foot);

  return el;
}

function queueEl(home: HomeResponse | null, count: NeedsCount): HTMLElement {
  const q = document.createElement("div");
  q.className = "home-queue";
  if (!home && count.state === "failed") {
    q.innerHTML = `<div class="hq-row hq-unread"><span class="hq-dot hollow"></span><div><div class="hq-what">Could not read the queue</div><div class="hq-src">Could not read · /api/home did not answer. This is not “nothing to decide”.</div></div><div class="hq-right"><span class="hq-when">retrying every minute</span></div></div>`;
    return q;
  }
  if (!home) {
    q.innerHTML = `<div class="hq-note"><span class="hq-dot" style="background:var(--text-2)"></span>Loading: live sessions, their PRs on GitHub, the structure guard, the notes snapshot…</div>`;
    return q;
  }
  if (home.queue.length === 0) {
    const row = document.createElement("div");
    row.className = "hq-note";
    row.innerHTML =
      count.state === "ok"
        ? `<span class="hq-dot" style="background:var(--green)"></span>Nothing to decide. Checked: ${esc(Object.values(home.sources).map((s) => s.label).join(" · "))}.`
        : `<span class="hq-dot" style="background:var(--text-2)"></span>Nothing to decide among what could be read. Some sources did not answer; see below.`;
    q.appendChild(row);
  }
  // The first QUEUE_SHOWN rows are shown; the rest are one click away, so the status line and
  // the agents stay on the first screen. The headline still counts every row.
  const rows = home.queue.map((item, i) => queueRow(item, i === 0));
  rows.slice(0, queueExpanded ? rows.length : QUEUE_SHOWN).forEach((r) => q.appendChild(r));
  if (rows.length > QUEUE_SHOWN) {
    const more = document.createElement("button");
    more.className = "hq-more";
    more.textContent = queueExpanded ? "Show fewer" : `Show ${rows.length - QUEUE_SHOWN} more`;
    more.addEventListener("click", () => {
      queueExpanded = !queueExpanded;
      if (queueExpanded) rows.slice(QUEUE_SHOWN).forEach((r) => q.insertBefore(r, more));
      else rows.slice(QUEUE_SHOWN).forEach((r) => r.remove());
      more.textContent = queueExpanded ? "Show fewer" : `Show ${rows.length - QUEUE_SHOWN} more`;
    });
    q.appendChild(more);
  }
  for (const u of home.unread) {
    const row = document.createElement("div");
    row.className = "hq-row hq-unread";
    row.innerHTML = `<span class="hq-dot hollow"></span>
      <div><div class="hq-what">${esc(u.what)}</div><div class="hq-src">Could not read · ${esc(u.source)}</div></div>
      <div class="hq-right"><span class="hq-when">not counted</span></div>`;
    q.appendChild(row);
  }
  return q;
}

const KIND_COLOUR: Record<QueueItem["kind"], string> = {
  "agent-waiting": "var(--yellow)",
  "rule-break": "var(--red)",
  "pr-review": "var(--cyan)",
};

function queueRow(item: QueueItem, primary: boolean): HTMLElement {
  const row = document.createElement("div");
  row.className = "hq-row";
  row.dataset.kind = item.kind;
  row.dataset.id = item.id;
  row.innerHTML = `<span class="hq-dot" style="background:${KIND_COLOUR[item.kind]}"></span>
    <div><div class="hq-what">${esc(item.what)}</div><div class="hq-why">${esc(item.why)}</div><div class="hq-src">Source: ${esc(item.source)}</div></div>
    <div class="hq-right"><span class="hq-when">${item.dueBy ? `due ${esc(item.dueBy)}` : "no deadline recorded"}</span></div>`;
  const right = row.querySelector(".hq-right")!;
  const btnClass = `hq-btn${primary ? " primary" : ""}`;
  if (item.action.href) {
    const a = document.createElement("a");
    a.className = btnClass;
    a.href = item.action.href;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = item.action.label;
    right.appendChild(a);
  } else if (item.action.copy) {
    const b = document.createElement("button");
    b.className = btnClass;
    b.textContent = item.action.label;
    b.title = item.action.copy;
    b.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(item.action.copy!);
        b.textContent = "Copied";
      } catch {
        b.textContent = "Copy failed";
      }
      setTimeout(() => (b.textContent = item.action.label), 1500);
    });
    right.appendChild(b);
  }
  return row;
}

const STATE_COLOUR: Record<HomeMetric["state"], string> = {
  ok: "var(--green)",
  warn: "var(--yellow)",
  bad: "var(--red)",
  unknown: "var(--text-2)",
};

function statusEl(home: HomeResponse | null, failed: boolean): HTMLElement {
  const d = document.createElement("details");
  d.className = "home-status";
  // `#status` in the address opens it, so the details can be linked to (and screenshotted).
  d.open = statusOpen || location.hash === "#status";
  d.addEventListener("toggle", () => (statusOpen = d.open));
  if (!home) {
    d.innerHTML = `<summary><span class="hq-dot" style="background:var(--text-2)"></span><b>${failed ? "Could not read health" : "Checking health…"}</b></summary>`;
    return d;
  }
  const bad = home.metrics.filter((m) => m.state === "bad");
  const watch = home.metrics.filter((m) => m.state === "warn");
  const unknown = home.metrics.filter((m) => m.state === "unknown");
  const word = bad.length ? "Needs attention" : unknown.length ? "Could not check everything" : "Healthy";
  const dot = bad.length ? STATE_COLOUR.bad : unknown.length ? STATE_COLOUR.unknown : STATE_COLOUR.ok;
  const watched = [...bad, ...watch];
  const tail = watched.length
    ? `· ${watched.length} thing${watched.length > 1 ? "s" : ""} to watch: ${watched.map((m) => `${m.label.toLowerCase()} ${m.value}`).join("; ")}`
    : "· nothing to watch";
  d.innerHTML = `<summary><span class="hq-dot" style="background:${dot}"></span><b>${word}</b><span class="hs-tail">${esc(tail)}</span><span class="hs-more">Details ▾</span></summary>`;
  const body = document.createElement("div");
  body.className = "hs-body";
  for (const m of home.metrics) {
    const r = document.createElement("div");
    r.className = "hs-metric";
    r.dataset.metric = m.id;
    r.innerHTML = `<span class="hq-dot" style="background:${STATE_COLOUR[m.state]}"></span><span class="hs-label">${esc(m.label)}</span><span class="hs-value">${esc(m.value)}</span>
      <span class="hs-note">${esc(m.note)}<span class="hs-src">Source: ${esc(m.source)}</span></span>`;
    body.appendChild(r);
  }
  const src = document.createElement("div");
  src.className = "hs-sources";
  src.innerHTML = `<div class="hs-sources-h">Sources</div>` +
    (Object.entries(home.sources) as [string, HomeSource][])
      .map(([k, s]) => `<div class="hs-source"><span class="hs-st st-${s.status}">${esc(s.status.replace(/-/g, " "))}</span><span>${esc(k)}</span><span class="hs-note">${esc(s.label)}${s.detail ? ` — ${esc(s.detail)}` : ""}</span></div>`)
      .join("");
  body.appendChild(src);
  d.appendChild(body);
  return d;
}

const AGENT_COLOUR: Record<string, string> = { waiting: "var(--yellow)", busy: "var(--cyan)" };

function agentsEl(home: HomeResponse | null, nav: Nav, failed: boolean): HTMLElement {
  const card = document.createElement("div");
  card.className = "home-agents";
  const n = home ? home.agents.length : null;
  card.innerHTML = `<div class="ha-head"><h2 class="home-h2">Agents${n !== null ? ` · ${n}` : ""}</h2><span class="hs-src">Source: ~/.claude/sessions (running processes only)</span></div>`;
  const open = document.createElement("button");
  open.className = "ha-all";
  open.textContent = "Open all →";
  open.addEventListener("click", () => nav.toSessions());
  card.querySelector(".ha-head")!.appendChild(open);
  if (!home) {
    card.insertAdjacentHTML("beforeend", `<div class="ha-row"><span class="hq-dot" style="background:var(--text-2)"></span><span>${failed ? "Could not read the agents" : "Loading…"}</span></div>`);
    return card;
  }
  if (home.sources.sessions.status === "could-not-read") {
    card.insertAdjacentHTML("beforeend", `<div class="ha-row hq-unread"><span class="hq-dot hollow"></span><span>Could not read the session registry: ${esc(home.sources.sessions.detail ?? "")}</span></div>`);
    return card;
  }
  if (home.agents.length === 0) {
    card.insertAdjacentHTML("beforeend", `<div class="ha-row"><span class="hq-dot" style="background:var(--text-2)"></span><span>No agent is running.</span></div>`);
    return card;
  }
  const order: Record<string, number> = { waiting: 0, busy: 1 };
  const sorted = [...home.agents].sort((a, b) => (order[a.status] ?? 2) - (order[b.status] ?? 2) || b.updatedAt - a.updatedAt);
  for (const a of sorted) card.appendChild(agentRow(a));
  return card;
}

function agentRow(a: HomeAgent): HTMLElement {
  const row = document.createElement("div");
  row.className = "ha-row";
  const mins = Math.max(0, Math.round((Date.now() - a.updatedAt) / 60000));
  const state = a.status === "waiting" ? `waiting on you${a.waitingFor ? ` (${a.waitingFor})` : ""}` : a.status === "busy" ? "working" : a.status;
  row.innerHTML = `<span class="hq-dot" style="background:${AGENT_COLOUR[a.status] ?? "var(--text-2)"}"></span>
    <span class="ha-name"><b>${esc(a.project)}</b> · ${esc(a.name)}${a.branch ? ` <span class="mono ha-branch">${esc(a.branch)}</span>` : ""}</span>
    <span class="ha-state">${esc(state)} · ${mins < 60 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`}${a.openPrs.length ? ` · open PR ${a.openPrs.map((p) => `#${p}`).join(", ")}` : ""}</span>`;
  return row;
}

function cataloguesEl(all: ProjectSummary[], nav: Nav): HTMLElement {
  const d = document.createElement("details");
  d.className = "home-more";
  // Totals count each notes store once: a project sharing another's store carries its notes (#36).
  const owners = all.filter((p) => !p.sharesNotesWith);
  const entries = (p: ProjectSummary) => Object.values(p.catalogueCounts).reduce((a, b) => a + b, 0);
  const total = owners.reduce((s, p) => s + entries(p), 0);
  const fatality = owners.reduce((s, p) => s + p.fatalitySignals, 0);
  const misaligned = owners.reduce((s, p) => s + p.misalignedInvariants, 0);
  d.innerHTML = `<summary><b>Notes and projects</b><span class="hs-tail">· ${total.toLocaleString("en-US")} notes in ${owners.filter((p) => entries(p) > 0).length} projects · ${fatality} fatality signals · ${misaligned} misaligned invariants</span><span class="hs-more">Details ▾</span></summary>`;
  const body = document.createElement("div");
  body.className = "hs-body";
  body.insertAdjacentHTML("beforeend", `<div class="hs-src">Source: /api/projects (each project's catalogues and memory; a shared notes store is counted once)</div>`);
  const sorted = [...all].sort((a, b) => (b.sharesNotesWith ? 0 : entries(b)) - (a.sharesNotesWith ? 0 : entries(a)));
  for (const p of sorted) {
    const n = p.sharesNotesWith ? 0 : entries(p);
    const row = document.createElement("button");
    row.className = "hm-project";
    row.innerHTML = `<span>${esc(p.name)}</span><span class="hs-note">${
      p.sharesNotesWith ? `notes of ${esc(p.sharesNotesWith)}` : n > 0 ? `${n} notes · ${p.groundingPercent}% backed by source` : "no notes"
    }${!p.sharesNotesWith && p.fatalitySignals > 0 ? ` · <span style="color:var(--red)">${p.fatalitySignals} fatality</span>` : ""}${
      !p.sharesNotesWith && p.misalignedInvariants > 0 ? ` · <span style="color:var(--yellow)">${p.misalignedInvariants} misaligned</span>` : ""
    }</span>`;
    row.addEventListener("click", () => nav.toProject(p.name));
    body.appendChild(row);
  }
  d.appendChild(body);
  return d;
}
