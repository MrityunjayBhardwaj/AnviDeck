/**
 * Home as in the prototype (#81): one queue "N things need you", soonest first, each item with
 * one action done in place; under it the one health line that opens to its figures; then the
 * agents. The model (what each row says and does) is ./home-model.ts; this file only draws it.
 *
 *   Answer   opens the agent's permission card in the row (./PermissionRequests.ts): Allow / Deny
 *            go through write(), with the token, into the action log
 *   Review   the PR on GitHub, with why it is not ready to merge yet
 *   Merge…   the PR's row on Work (#work?pr=N), where Merge is a button only you press
 *
 * The headline reads `count` (needsCount in app.ts), never the queue itself. Readiness is asked
 * of GET /api/home/ready after the queue is drawn, and each PR row is redrawn when it answers.
 */
import type { HomeResponse } from "../../shared/home-types";
import type { ProjectSummary } from "../../shared/types";
import type { ReadyAnswer } from "../../shared/pr-ready";
import { permissionQueue, type AskingAgent } from "../../shared/permission-requests";
import type { AgentsRead } from "../shell/activity";
import { headlineText, type NeedsCount } from "../home-count";
import { requestCard } from "./PermissionRequests";
import {
  agentRows,
  healthModel,
  queueRows,
  readyKeys,
  type AgentsModel,
  type HomeRow,
  type ReadyRead,
  type UnreadRow,
} from "./home-model";

export interface HomeInput {
  home: HomeResponse | null;
  count: NeedsCount;
  /** /api/home itself could not be read. */
  failed: boolean;
  host: AgentsRead;
  /** The project picked in the switcher. */
  project: ProjectSummary | null;
  projectsReadAt: string | null;
}

// The stylesheet is this screen's own file, added once.
if (!document.querySelector('link[data-for="home-screen"]')) {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = "/styles/home.css";
  link.dataset.for = "home-screen";
  document.head.append(link);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const TONE: Record<string, string> = {
  warn: "var(--yellow)",
  bad: "var(--red)",
  info: "var(--cyan)",
  ok: "var(--green)",
  unknown: "var(--text-2)",
  muted: "var(--text-2)",
};

function dot(tone: string, hollow = false): HTMLElement {
  const d = el("span", `hm-dot${hollow ? " hollow" : ""}`);
  if (!hollow) d.style.background = TONE[tone] ?? TONE.muted!;
  return d;
}

// State kept across the page's rebuilds (Home is redrawn every minute and on every count change).
const openAsks = new Set<string>();
let expanded = false;
const SHOWN = 6;
let healthOpen = location.hash === "#status";
let ready: ReadyRead = { state: "loading" };
let readyKeysAsked = "";
let readyAt = 0;
let readyInFlight = false;
const READY_REFRESH_MS = 60_000;
let last: HomeInput | null = null;
let queueEl: HTMLElement | null = null;
let agentsEl: HTMLElement | null = null;

export function HomeScreen(input: HomeInput): HTMLElement {
  last = input;
  const root = el("div", "hm");

  const head = el("div", "hm-head");
  head.append(el("h1", "hm-h1", headlineText(input.count)));
  const today = new Date().toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  const checked = input.home ? ` · checked ${new Date(input.home.generatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "";
  head.append(el("span", "hm-sub", `all projects · ${today} · soonest first${checked}`));
  root.append(head);

  queueEl = el("div", "hm-queue");
  paintQueue(queueEl, input);
  root.append(queueEl);

  root.append(healthEl(input));

  agentsEl = el("div", "hm-agents");
  paintAgents(agentsEl, agentRows(input.host, input.home, input.failed));
  root.append(agentsEl);

  const foot = el("div", "hm-foot");
  const m = (id: string) => input.home?.metrics.find((x) => x.id === id);
  const structureOf = m("new-breaks")?.asOf?.slice(0, 10);
  const notesOf = m("notes")?.asOf?.slice(0, 10);
  foot.textContent =
    "Nothing on this page is an example: all of it is read when the page loads, and again every minute." +
    (structureOf ? ` Rule breaks are measured at the commit of ${structureOf}.` : "") +
    (notesOf ? ` Out-of-date notes come from the snapshot of ${notesOf}.` : "");
  root.append(foot);

  askReadiness(input.home);
  return root;
}

/** Redraw the agents list in place, when the agent host reports a change (no full rebuild). */
export function refreshHomeAgents(host: AgentsRead): void {
  if (!last || !agentsEl?.isConnected) return;
  last = { ...last, host };
  paintAgents(agentsEl, agentRows(host, last.home, last.failed));
}

// ── the queue ────────────────────────────────────────────────────────────────────────────

function paintQueue(box: HTMLElement, input: HomeInput): void {
  box.replaceChildren();
  if (!input.home && input.failed) {
    box.append(unreadRowEl({ key: "home", what: "Could not read the queue", source: "/api/home did not answer. This is not “nothing to decide”; retrying every minute.", reading: false }));
  }
  const { rows, unread } = queueRows(input.home, input.host, ready);
  if (!input.home && !input.failed) box.append(noteEl("Loading: live sessions, their PRs on GitHub, the structure guard, the notes snapshot…", "muted"));
  if (input.home && rows.length === 0) {
    box.append(
      input.count.state === "ok"
        ? noteEl(`Nothing to decide. Checked: ${Object.values(input.home.sources).map((s) => s.label).join(" · ")}.`, "ok")
        : noteEl("Nothing to decide among what could be read. Some sources did not answer; they are listed below.", "muted"),
    );
  }
  const els = rows.map((r, i) => rowEl(r, i === 0, input.host));
  els.slice(0, expanded ? els.length : SHOWN).forEach((e) => box.append(e));
  if (els.length > SHOWN) {
    const more = el("button", "hm-more", expanded ? "Show fewer" : `Show ${els.length - SHOWN} more`);
    more.type = "button";
    more.addEventListener("click", () => {
      expanded = !expanded;
      if (last) paintQueue(box, last);
    });
    box.append(more);
  }
  for (const u of unread) box.append(unreadRowEl(u));
  if (input.home?.olderPrs.length) box.append(olderPrsEl(input.home.olderPrs));
}

/** Open PRs you authored that have been quiet for 30 days: named once, never counted (#45). */
let olderOpen = false;
function olderPrsEl(prs: HomeResponse["olderPrs"]): HTMLElement {
  const d = el("details", "hm-older");
  d.open = olderOpen;
  d.addEventListener("toggle", () => (olderOpen = d.open));
  const s = el("summary");
  s.append(dot("muted", true), ` ${prs.length} older open PR${prs.length === 1 ? "" : "s"} you authored, not updated in 30 days (oldest last updated ${prs[0]!.updatedAt.slice(0, 10)}) · not counted`);
  d.append(s);
  const ul = el("ul");
  for (const p of prs) {
    const li = el("li");
    const a = el("a", "", `${p.repo}#${p.number}`);
    a.href = p.url;
    a.target = "_blank";
    a.rel = "noopener";
    li.append(a, ` ${p.title} `, el("span", "hm-src", `updated ${p.updatedAt.slice(0, 10)}`));
    ul.append(li);
  }
  d.append(ul, el("div", "hm-src", "Source: gh search prs --author=@me --state=open"));
  return d;
}

function noteEl(text: string, tone: string): HTMLElement {
  const n = el("div", "hm-note");
  n.append(dot(tone), el("span", "", text));
  return n;
}

function unreadRowEl(u: UnreadRow): HTMLElement {
  const r = el("div", "hm-q hm-unread");
  r.dataset.key = u.key;
  const mid = el("div");
  mid.append(el("div", "hm-t", u.what), el("div", "hm-src", `${u.reading ? "Still reading" : "Could not read"} · ${u.source}`));
  const right = el("div", "hm-right");
  right.append(el("span", "hm-when", "not counted"));
  r.append(dot("muted", true), mid, right);
  return r;
}

function rowEl(row: HomeRow, primary: boolean, host: AgentsRead): HTMLElement {
  const wrap = el("div", "hm-q");
  wrap.dataset.kind = row.kind;
  wrap.dataset.key = row.key;
  const mid = el("div");
  mid.append(el("div", "hm-t", row.title), el("div", "hm-why", row.why));
  if (row.note) mid.append(el("div", `hm-why hm-sub2${row.note.startsWith("Could not") ? " err" : ""}`, row.note));
  mid.append(el("div", "hm-src", `Source: ${row.source}`));
  const right = el("div", "hm-right");
  right.append(el("span", "hm-when", row.when));
  const cls = `hm-btn${primary ? " primary" : ""}`;
  const a = row.action;
  if (a.type === "link") {
    const l = el("a", cls, a.label);
    l.href = a.href;
    l.target = "_blank";
    l.rel = "noopener";
    right.append(l);
  } else if (a.type === "hash") {
    const l = el("a", cls, a.label);
    l.href = a.hash;
    if (row.kind === "merge") l.title = "Opens the PR's row on Work, where Merge is a button only you press";
    right.append(l);
  } else if (a.type === "copy") {
    const b = el("button", cls, a.label);
    b.type = "button";
    b.title = a.copy;
    b.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(a.copy);
        b.textContent = "Copied";
      } catch {
        b.textContent = "Copy failed";
      }
      setTimeout(() => (b.textContent = a.label), 1500);
    });
    right.append(b);
  } else {
    // Answer: the agent's permission card opens in the row, and the answer is given there.
    const b = el("button", cls, openAsks.has(a.requestId) ? "Hide" : a.label);
    b.type = "button";
    b.dataset.act = "answer";
    const slot = el("div", "hm-answer");
    const fill = () => {
      slot.replaceChildren();
      if (!openAsks.has(a.requestId)) return;
      const found = host.state === "ok" ? permissionQueue(host.agents as unknown as AskingAgent[]).requests.find((r) => r.request.requestId === a.requestId) : undefined;
      slot.append(found ? requestCard(found.agent, found.request) : el("div", "hm-src err", "This request is no longer parked: it was answered or withdrawn."));
    };
    b.addEventListener("click", () => {
      if (openAsks.has(a.requestId)) openAsks.delete(a.requestId);
      else openAsks.add(a.requestId);
      b.textContent = openAsks.has(a.requestId) ? "Hide" : a.label;
      fill();
    });
    right.append(b);
    fill();
    wrap.append(dot(row.tone), mid, right, slot);
    return wrap;
  }
  wrap.append(dot(row.tone), mid, right);
  return wrap;
}

// ── readiness: asked after the queue is drawn ────────────────────────────────────────────

function askReadiness(home: HomeResponse | null): void {
  const keys = readyKeys(home);
  if (keys.length === 0) {
    if (ready.state === "loading") ready = { state: "ok", answers: new Map() };
    return;
  }
  const joined = keys.join(" ");
  if (readyInFlight || (joined === readyKeysAsked && Date.now() - readyAt < READY_REFRESH_MS && ready.state !== "loading")) return;
  readyInFlight = true;
  readyKeysAsked = joined;
  const chunks: string[][] = [];
  for (let i = 0; i < keys.length; i += 40) chunks.push(keys.slice(i, i + 40));
  Promise.all(
    chunks.map(async (c) => {
      const res = await fetch(`/api/home/ready?${c.map((k) => `pr=${encodeURIComponent(k)}`).join("&")}`);
      const body = (await res.json().catch(() => null)) as { answers?: ReadyAnswer[]; error?: string } | null;
      if (!res.ok || !body?.answers) throw new Error(body?.error ?? `GET /api/home/ready answered ${res.status}`);
      return body.answers;
    }),
  ).then(
    (all) => {
      const answers = new Map(ready.state === "ok" ? ready.answers : []);
      for (const a of all.flat()) answers.set(a.key, a);
      ready = { state: "ok", answers };
    },
    (e: Error) => {
      ready = { state: "failed", reason: e.message };
    },
  ).finally(() => {
    readyInFlight = false;
    readyAt = Date.now();
    if (last && queueEl?.isConnected) paintQueue(queueEl, last);
  });
}

// ── the health line ──────────────────────────────────────────────────────────────────────

function healthEl(input: HomeInput): HTMLElement {
  const h = healthModel({ home: input.home, failed: input.failed, project: input.project, projectsReadAt: input.projectsReadAt });
  const d = el("details", "hm-health");
  d.id = "status";
  d.open = healthOpen;
  d.addEventListener("toggle", () => (healthOpen = d.open));
  const sum = el("summary");
  const line = el("div", "hm-status");
  line.append(dot(h.dot), el("b", "", h.word), el("span", "hm-tail", h.tail));
  if (h.rows.length) line.append(el("span", "hm-more-l", "Details ▾"));
  sum.append(line);
  d.append(sum);
  if (!h.rows.length) return d;
  const body = el("div", "hm-health-body");
  for (const r of h.rows) {
    const m = el("div", "hm-met");
    m.dataset.metric = r.id;
    const v = el("span", "hm-v", r.value);
    if (r.of) v.append(" ", el("span", "hm-of", r.of));
    const words = el("span", "hm-mnote");
    words.append(r.note);
    if (r.link) {
      const a = el("a", "hm-link", r.link.label);
      a.href = r.link.hash;
      words.append(" ", a);
    }
    words.append(el("span", "hm-src", `${r.asOf ? `${r.asOf} · ` : "no date recorded · "}Source: ${r.source}`));
    m.append(dot(r.state), el("span", "hm-label", r.label), v, words);
    body.append(m);
  }
  d.append(body);
  return d;
}

// ── the agents ───────────────────────────────────────────────────────────────────────────

const AGENTS_SHOWN = 8;

function paintAgents(box: HTMLElement, a: AgentsModel): void {
  box.replaceChildren();
  const head = el("div", "hm-agents-head");
  head.append(el("h2", "hm-h2", a.heading));
  const all = el("a", "hm-all", "Open all →");
  all.href = "#agents";
  head.append(all);
  box.append(head);
  for (const u of a.unread) {
    const r = el("div", "hm-arow hm-unread");
    r.append(dot("muted", true), el("div", "", u));
    box.append(r);
  }
  if (a.rows.length === 0 && a.unread.length === 0) box.append(noteEl("No agent is running, and none was started here.", "muted"));
  for (const r of a.rows.slice(0, AGENTS_SHOWN)) {
    const row = el("div", "hm-arow");
    row.dataset.key = r.key;
    const mid = el("div");
    mid.append(el("b", "", r.title), el("div", "hm-why", r.doing || (r.started === "here" ? "started here" : "")));
    const right = el("div", "hm-right");
    right.append(r.needsYou ? el("span", "hm-chip", "needs you") : el("span", "hm-when", r.state));
    const open = el("a", "hm-btn sm", "Open");
    open.href = r.href;
    right.append(open);
    row.append(dot(r.dot), mid, right);
    box.append(row);
  }
  if (a.rows.length > AGENTS_SHOWN) box.append(el("div", "hm-src", `and ${a.rows.length - AGENTS_SHOWN} more under Open all →`));
  box.append(el("div", "hm-src", `Source: ${a.source}`));
}
