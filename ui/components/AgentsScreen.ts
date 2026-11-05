/**
 * The Agents screen (#82): a tab per agent and a 2×2 grid.
 *
 * Agents AnviDeck started come from the agent host (GET /api/agents, GET /api/agents/:id, live
 * over the WebSocket); each card carries its parked permission requests with Allow and Deny (the
 * same cards as Home, ui/components/PermissionRequests.ts), a message box (#79), Stop and Resume.
 * Sessions started in a terminal are listed after them, labelled view only: AnviDeck shows what
 * they did but cannot act on them.
 *
 * For every agent: its plan with progress (from its own TodoWrite / TaskCreate calls), its tool
 * calls with which anvi hooks ran and what context they gave, and a refusal card when the design
 * guard blocked an edit. How each piece was found is in ui/components/agents-model.ts; where
 * each comes from is printed under the agent (Sources), "not present" kept apart from
 * "could not read".
 *
 * Writes go through ui/write.ts only. All text from agents is set as text, never as HTML.
 */
import { write, WriteError } from "../write";
import { agentRequests, keepCardsOf } from "./PermissionRequests";
import { refusalCall } from "./RefusalCall";
import type { AgentsRead } from "../shell/activity";
import type { AgentSessionResponse } from "../../shared/agents-screen-types";
import type { ReplaySessionsResponse } from "../../shared/replay-types";
import type { AskingAgent } from "../../shared/permission-requests";
import {
  agentLabel,
  agentTabs,
  buildTimeline,
  gridAgents,
  hookWindow,
  hostLineArrived,
  hostReadDone,
  hostReadFailed,
  hostSourceLine,
  hostTone,
  planProgress,
  restoreFocus,
  sortHostAgents,
  sourceLine,
  type AgentsScreenRoute,
  type HostAgent,
  type HostLoad,
  type Item,
  type Refusal,
  type SavedFocus,
  type Timeline,
  type ToolCall,
} from "./agents-model";

export interface AgentsScreenDeps {
  project: string | null;
  route: AgentsScreenRoute;
  hostAgents: AgentsRead;
  /** Set the URL hash (the screen's state lives in it). */
  go: (hash: string) => void;
  /** Open "Start an agent on an issue". */
  newAgent: () => void;
}

type Load<T> = { state: "loading" } | { state: "ok"; data: T; readAt: string } | { state: "error"; error: string };

interface Overview {
  claude: { path: string; realPath: string } | null;
  login: { ok: boolean; authMethod?: string; plan?: string; loggedIn?: boolean; error?: string };
  cap: number;
  running: number;
  registry: string;
}

// ── state kept across renders (the screen is rebuilt on every navigation) ───────────────────

const S = {
  deps: null as AgentsScreenDeps | null,
  root: null as HTMLElement | null,
  overview: { state: "loading" } as Load<Overview>,
  /** Host transcripts by agent id; lines that arrive while one is read are merged in (agents-model). */
  host: new Map<string, HostLoad>(),
  /** Claude Code's own view of a session (transcript, hook meter, hook log), by session id. */
  sessions: new Map<string, Load<AgentSessionResponse>>(),
  /** Terminal sessions by project. */
  terminals: new Map<string, Load<ReplaySessionsResponse>>(),
  /** Message boxes by agent id: built once, so what you type survives every repaint. */
  composers: new Map<string, HTMLElement>(),
  /** Open tool-call bodies, by tool id, kept open across repaints. */
  open: new Set<string>(),
  refetch: new Map<string, ReturnType<typeof setTimeout>>(),
  /** Sessions read whole (Read all): how many records to ask for. */
  tails: new Map<string, number>(),
  /** The field the owner was typing in, and where the cursor was: given back after a repaint. */
  focus: null as SavedFocus | null,
};

const TAB_ROW_TERMINALS = 6;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", ...kids: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of kids) if (k !== null && k !== undefined && k !== false) e.append(typeof k === "string" ? document.createTextNode(k) : k);
  return e;
}

const hhmm = (iso: string | null | undefined) => (iso ? `${iso.slice(11, 19)}` : "");
function stamp(iso: string | null | undefined): HTMLElement {
  const s = el("span", "aw-note", hhmm(iso));
  if (iso) s.title = `${iso} (UTC)`;
  return s;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const j = (await res.json().catch(() => null)) as T & { error?: string };
  if (!res.ok) throw new Error(`${res.status} ${(j && (j as { error?: string }).error) || res.statusText}`);
  return j;
}

// ── loading ─────────────────────────────────────────────────────────────────────────────────

function hostAgents(): HostAgent[] {
  const r = S.deps?.hostAgents;
  return r && r.state === "ok" ? (r.agents as unknown as HostAgent[]) : [];
}

function loadOverview(): void {
  getJson<Overview>("/api/agents").then(
    (o) => (S.overview = { state: "ok", data: o, readAt: new Date().toISOString() }),
    (e: Error) => (S.overview = { state: "error", error: e.message }),
  ).finally(paint);
}

/**
 * Read an agent's host transcript. Lines that arrive over the WebSocket meanwhile are merged into
 * the answer (hostReadDone), and a re-read (after the socket reconnects) merges with what is shown.
 */
function loadHost(id: string): void {
  if (!S.host.has(id)) S.host.set(id, { state: "loading", early: [] });
  getJson<{ transcript: { seq: number; at: string; from: "sdk" | "host"; message: Record<string, unknown> }[]; unreadableLines?: number }>(`/api/agents/${encodeURIComponent(id)}`).then(
    (r) => {
      const fetched = r.transcript.map((l) => ({ seq: l.seq, at: l.at, from: l.from, message: l.message ?? {} }));
      S.host.set(id, hostReadDone(S.host.get(id), fetched, r.unreadableLines ?? 0, new Date().toISOString()));
    },
    (e: Error) => {
      const had = S.host.get(id);
      if (had?.state === "ok") console.warn(`[agents] re-read of agent ${id} failed: ${e.message}`);
      S.host.set(id, hostReadFailed(had, e.message));
    },
  ).finally(paint);
}

function loadSession(sid: string): void {
  if (!S.sessions.has(sid)) S.sessions.set(sid, { state: "loading" });
  const tail = S.tails.get(sid);
  getJson<AgentSessionResponse>(`/api/agents-screen/session/${encodeURIComponent(sid)}${tail ? `?tail=${tail}` : ""}`).then(
    (r) => S.sessions.set(sid, { state: "ok", data: r, readAt: r.readAt }),
    (e: Error) => {
      // A later re-read that fails keeps the earlier answer, and says the re-read failed.
      const had = S.sessions.get(sid);
      if (had?.state !== "ok") S.sessions.set(sid, { state: "error", error: e.message });
      else console.warn(`[agents] re-read of ${sid} failed: ${e.message}`);
    },
  ).finally(paint);
}

/** Re-read a live agent's Claude Code transcript (hook context) a little after its tool calls. */
function refetchSoon(sid: string): void {
  if (S.refetch.has(sid)) return;
  S.refetch.set(sid, setTimeout(() => {
    S.refetch.delete(sid);
    loadSession(sid);
  }, 3000));
}

function loadTerminals(project: string): void {
  if (S.terminals.get(project)?.state === "ok") return;
  S.terminals.set(project, { state: "loading" });
  getJson<ReplaySessionsResponse>(`/api/replay/sessions?project=${encodeURIComponent(project)}`).then(
    (r) => S.terminals.set(project, { state: "ok", data: r, readAt: new Date().toISOString() }),
    (e: Error) => S.terminals.set(project, { state: "error", error: e.message }),
  ).finally(paint);
}

// ── live updates from app.ts ────────────────────────────────────────────────────────────────

/** A host transcript line arrived over the WebSocket. */
export function agentsScreenLine(id: string, line: { seq: number; at: string; from: "sdk" | "host"; message: Record<string, unknown> }): void {
  const h = S.host.get(id);
  const next = hostLineArrived(h, { seq: line.seq, at: line.at, from: line.from, message: line.message ?? {} });
  if (!next || next === h) return;
  S.host.set(id, next);
  const sid = hostAgents().find((a) => a.id === id)?.sessionId;
  if (sid && line.from === "sdk" && (line.message?.type === "user" || line.message?.type === "result")) refetchSoon(sid);
  paintSoon();
}

/**
 * The WebSocket (re)connected: lines sent while it was down never arrive, so every host
 * transcript the screen holds is read again and merged; the Claude Code side too, for hook context.
 */
export function agentsScreenReconnected(): void {
  for (const id of S.host.keys()) loadHost(id);
  for (const a of hostAgents()) if (a.sessionId && S.sessions.has(a.sessionId)) refetchSoon(a.sessionId);
}

/** The host's agent list changed (status, a parked request): repaint if the screen is open. */
export function agentsScreenAgents(read: AgentsRead): void {
  if (S.deps) S.deps.hostAgents = read;
  paintSoon();
}

let paintQueued = false;
function paintSoon(): void {
  if (paintQueued) return;
  paintQueued = true;
  requestAnimationFrame(() => {
    paintQueued = false;
    paint();
  });
}

// ── the screen ──────────────────────────────────────────────────────────────────────────────

export function AgentsScreen(deps: AgentsScreenDeps): HTMLElement {
  S.deps = deps;
  S.root = el("section", "aw");
  S.root.id = "s-agents";
  watchFocus(S.root);
  loadOverview();
  if (deps.project) loadTerminals(deps.project);
  paint();
  return S.root;
}

function selected(): { kind: "host"; agent: HostAgent } | { kind: "terminal"; sid: string } | null {
  const d = S.deps!;
  const agents = sortHostAgents(hostAgents());
  if (d.route.agent) {
    const a = agents.find((x) => x.id === d.route.agent);
    return a ? { kind: "host", agent: a } : null;
  }
  if (d.route.session) return { kind: "terminal", sid: d.route.session };
  return agents[0] ? { kind: "host", agent: agents[0] } : null;
}

function hashFor(p: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v) q.set(k, v);
  const s = q.toString();
  return `#agents${s ? `?${s}` : ""}`;
}

function paint(): void {
  const root = S.root;
  const d = S.deps;
  if (!root || !d || !root.isConnected && root.childElementCount > 0) return;
  const agents = hostAgents();
  keepCardsOf(agents as unknown as AskingAgent[]);
  const sel = selected();

  const gridBtn = el("button", `aw-btn${d.route.grid ? " on" : ""}`, d.route.grid ? "Tabs" : "2×2 grid");
  gridBtn.id = "aw-grid-toggle";
  gridBtn.type = "button";
  gridBtn.onclick = () => d.go(hashFor({ grid: d.route.grid ? undefined : "1", agent: d.route.agent, session: d.route.session }));
  const newBtn = el("button", "aw-btn", "+ New agent");
  newBtn.id = "aw-new";
  newBtn.type = "button";
  newBtn.onclick = () => d.newAgent();

  const head = el("div", "aw-head",
    el("h1", "", "Agents"),
    el("span", "aw-sub", "agents AnviDeck started, live · sessions started in a terminal, view only"),
    el("div", "aw-acts", gridBtn, newBtn));

  const kids: HTMLElement[] = [head, hostLine(d.hostAgents), tabsRow(agents, sel)];
  if (d.route.grid) kids.push(grid(agents));
  else if (sel?.kind === "host") kids.push(hostDetail(sel.agent));
  else if (sel?.kind === "terminal") kids.push(terminalDetail(sel.sid));
  else if (d.route.agent) kids.push(el("div", "aw-empty aw-err", `No agent ${d.route.agent} in the agent host's list (${d.hostAgents.state === "ok" ? "read" : "could not read the list"}).`));
  else kids.push(el("div", "aw-empty", d.hostAgents.state === "ok" ? "No agent AnviDeck started yet. + New agent starts one on an issue; terminal sessions are in the tabs above." : "The agent host's list could not be read (see above)."));
  root.replaceChildren(...kids);
  // Replacing the children detaches the message box and permission cards for a moment, which
  // blurs them; give the cursor back to where the owner was typing.
  restoreFocus(S.focus, document.activeElement, document.body);
}

/** Remember the field the owner types in (and the cursor in it); forget it once they move on. */
let focusDocWatched = false;
function watchFocus(root: HTMLElement): void {
  const isField = (t: EventTarget | null): t is HTMLInputElement | HTMLTextAreaElement =>
    t instanceof HTMLTextAreaElement || (t instanceof HTMLInputElement && !["button", "submit", "checkbox", "radio"].includes(t.type));
  const save = (e: Event) => {
    if (isField(e.target)) S.focus = { el: e.target, start: e.target.selectionStart, end: e.target.selectionEnd };
  };
  for (const ev of ["focusin", "input", "keyup", "select", "mouseup"]) root.addEventListener(ev, save);
  if (focusDocWatched) return;
  focusDocWatched = true;
  // Pressing elsewhere, or focus going to another element, is the owner moving on.
  document.addEventListener("pointerdown", (e) => {
    if (S.focus && (e.target as unknown) !== S.focus.el) S.focus = null;
  }, true);
  // (A field inside the screen is saved again by the root's own listener, which runs after this.)
  document.addEventListener("focusin", (e) => {
    if (S.focus && (e.target as unknown) !== S.focus.el) S.focus = null;
  }, true);
}

/** One line: how many agents, the cap, and the login they run on. Unread is never zero. */
function hostLine(read: AgentsRead): HTMLElement {
  const line = el("div", "aw-note");
  line.id = "aw-host-line";
  if (read.state === "loading") line.append("Agent host: checking…");
  else if (read.state === "off") line.append(el("span", "aw-err", `Agent host off: ${read.reason}`));
  else if (read.state === "failed") line.append(el("span", "aw-err", `Could not read the agent host: ${read.reason}`));
  else {
    const running = (read.agents as unknown as HostAgent[]).filter((a) => a.running).length;
    line.append(`Agent host: ${read.agents.length} agent${read.agents.length === 1 ? "" : "s"}, ${running} running`);
    const o = S.overview;
    if (o.state === "ok") {
      const l = o.data.login;
      line.append(` of at most ${o.data.cap} · login `,
        l.error ? el("span", "aw-err", `could not read (${l.error})`) : el("span", l.ok ? "aw-ok" : "aw-err", `${l.authMethod ?? "?"} · plan ${l.plan ?? "?"}${l.loggedIn ? "" : " · NOT logged in"}`),
        ` · registry ${o.data.registry} (GET /api/agents)`);
    } else if (o.state === "error") line.append(el("span", "aw-err", ` · login and cap could not be read (${o.error})`));
  }
  return line;
}

function tabsRow(agents: HostAgent[], sel: ReturnType<typeof selected>): HTMLElement {
  const d = S.deps!;
  const row = el("div", "aw-tabs");
  row.id = "aw-tabs";
  row.dataset.tour = "agent-tabs";
  const t = d.project ? S.terminals.get(d.project) : undefined;
  const terms = t?.state === "ok"
    ? [...t.data.sessions].sort((a, b) => (b.lastTs ?? b.modifiedAt).localeCompare(a.lastTs ?? a.modifiedAt)).slice(0, TAB_ROW_TERMINALS)
    : [];
  const tabs = agentTabs(agents, terms.map((s) => ({ sessionId: s.sessionId, project: s.project, cwd: s.cwd, lastTs: s.lastTs, modifiedAt: s.modifiedAt })));
  row.append(el("span", "aw-tabs-k", "AnviDeck"));
  if (!agents.length) row.append(el("span", "aw-note", d.hostAgents.state === "ok" ? "no agents yet" : "list not read"));
  let termHead = false;
  for (const tab of tabs) {
    if (tab.kind === "terminal" && !termHead) {
      termHead = true;
      row.append(el("span", "aw-tabs-k", `· ${d.project} terminal sessions`));
    }
    const on = !d.route.grid && sel !== null && (sel.kind === "host" ? tab.kind === "host" && sel.agent.id === tab.id : tab.kind === "terminal" && sel.sid === tab.id);
    const b = el("button", `aw-tab${on ? " on" : ""}`, el("span", `aw-dot ${tab.tone}`), el("span", "l", tab.label), el("span", "st", tab.status));
    b.type = "button";
    b.dataset.tab = tab.key;
    b.title = tab.kind === "terminal" ? `${tab.id} · started in a terminal: view only` : tab.id;
    b.onclick = () => d.go(hashFor(tab.kind === "host" ? { agent: tab.id } : { session: tab.id }));
    row.append(b);
  }
  if (d.project && !termHead) {
    // Absent and unread are said differently from "none".
    if (!t || t.state === "loading") row.append(el("span", "aw-note", `· ${d.project} terminal sessions: reading…`));
    else if (t.state === "error") row.append(el("span", "aw-note aw-err", `· ${d.project} terminal sessions: could not read (${t.error})`));
    else if (t.data.status !== "ok" && t.data.status !== "none") row.append(el("span", "aw-note aw-err", `· ${d.project} terminal sessions: could not read (${t.data.status}${t.data.detail ? `: ${t.data.detail}` : ""})`));
    else row.append(el("span", "aw-note", `· ${d.project}: no terminal sessions in its transcripts`));
  } else if (t?.state === "ok" && t.data.sessions.length > terms.length) {
    const more = el("a", "aw-note", `${t.data.sessions.length - terms.length} older in the replay view`);
    (more as HTMLAnchorElement).href = hashFor({ view: "replay", project: d.project ?? undefined });
    row.append(more);
  }
  return row;
}

// ── one AnviDeck agent ──────────────────────────────────────────────────────────────────────

function timelineFor(a: HostAgent): { tl: Timeline | null; lines: HostLoad; session: Load<AgentSessionResponse> | null } {
  if (!S.host.has(a.id)) loadHost(a.id);
  if (a.sessionId && !S.sessions.has(a.sessionId)) loadSession(a.sessionId);
  const lines = S.host.get(a.id)!;
  const session = a.sessionId ? S.sessions.get(a.sessionId)! : null;
  if (lines.state !== "ok") return { tl: null, lines, session };
  const cli = session?.state === "ok" ? session.data : null;
  const tl = buildTimeline({
    lines: lines.lines,
    attachments: cli?.transcript.records.filter((r) => r.type === "attachment"),
    meter: cli?.meter.rows,
    hookLog: cli?.hookLog.rows,
    cwd: a.cwd,
    live: a.running,
    // Only the newest Claude Code records were read: calls before them have no hook data read.
    hooksFrom: cli ? hookWindow(cli.transcript)?.from ?? null : null,
  });
  return { tl, lines, session };
}

function statusChip(a: HostAgent): HTMLElement {
  const waiting = a.pendingPermissions.length;
  const cls = waiting ? "warn" : a.status === "failed" ? "bad" : a.status === "done" ? "ok" : "";
  return el("span", `aw-chip ${cls}`, waiting ? `waiting on you · ${waiting}` : a.status);
}

function controls(a: HostAgent, out: HTMLElement): HTMLElement {
  const box = el("span", "r");
  const act = async (label: string, url: string, body?: unknown) => {
    out.className = "aw-composer-out aw-note";
    out.textContent = `${label}…`;
    try {
      await write("POST", url, body);
      out.className = "aw-composer-out aw-ok";
      out.textContent = `${label}: done.`;
    } catch (e) {
      out.className = "aw-composer-out aw-err";
      out.textContent = `${label} refused: ${(e as Error).message}`;
    }
  };
  if (a.running) {
    const stop = el("button", "aw-btn sm bad", "Stop");
    stop.dataset.act = "stop";
    stop.onclick = () => void act("Stop", `/api/agents/${encodeURIComponent(a.id)}/stop`);
    box.append(stop);
  } else if (a.sessionId) {
    const resume = el("button", "aw-btn sm", "Resume");
    resume.dataset.act = "resume";
    resume.title = "Resume its session; the message box's text, if any, is the prompt (else \"Continue.\")";
    resume.onclick = () => {
      const ta = S.composers.get(a.id)?.querySelector("textarea");
      void act("Resume", `/api/agents/${encodeURIComponent(a.id)}/resume`, { prompt: ta?.value ?? "" }).then(() => {
        if (ta && out.classList.contains("aw-ok")) ta.value = "";
      });
    };
    box.append(resume);
  }
  return box;
}

/** The message box (#79), built once per agent. A refused message offers to resume with it. */
function composer(a: HostAgent): HTMLElement {
  let box = S.composers.get(a.id);
  if (box) return box;
  const ta = el("textarea");
  ta.rows = 2;
  ta.placeholder = "Message this agent… (arrives on its next turn)";
  ta.setAttribute("aria-label", "Message the agent");
  const send = el("button", "aw-btn", "Send");
  send.dataset.act = "send";
  const out = el("div", "aw-composer-out");
  box = el("div", "", el("div", "aw-composer", ta, send), out);
  box.dataset.composer = a.id;
  send.onclick = async () => {
    out.className = "aw-composer-out aw-note";
    out.textContent = "sending…";
    try {
      await write("POST", `/api/agents/${encodeURIComponent(a.id)}/message`, { text: ta.value });
      ta.value = "";
      out.className = "aw-composer-out aw-ok";
      out.textContent = "Queued. It arrives on the agent's next turn; its delivery shows in the log.";
    } catch (e) {
      out.className = "aw-composer-out aw-err";
      out.replaceChildren((e as Error).message);
      if (e instanceof WriteError && e.status === 409 && e.body.resumable === true) {
        const b = el("button", "aw-btn sm", "Resume with this message");
        b.onclick = async () => {
          try {
            await write("POST", `/api/agents/${encodeURIComponent(a.id)}/resume`, { prompt: ta.value });
            ta.value = "";
            out.className = "aw-composer-out aw-ok";
            out.textContent = "Resumed with your message.";
          } catch (e2) {
            out.className = "aw-composer-out aw-err";
            out.textContent = (e2 as Error).message;
          }
        };
        out.append(" ", b);
      }
    }
  };
  S.composers.set(a.id, box);
  return box;
}

function hostCard(a: HostAgent, compact: boolean): HTMLElement {
  const { tl, lines, session } = timelineFor(a);
  const card = el("div", "aw-card");
  card.dataset.agent = a.id;
  const out = el("div", "aw-composer-out");
  const title = el("b", "", agentLabel(a));
  title.title = a.prompt;
  const head = el("div", "aw-card-head", el("span", `aw-dot ${hostTone(a)}`), title,
    el("span", "aw-note", `${a.id} · ${a.cwd}`), statusChip(a), controls(a, out));
  if (compact) {
    title.style.cursor = "pointer";
    title.onclick = () => S.deps!.go(hashFor({ agent: a.id }));
  }
  card.append(head);
  if (a.reason && !a.running) card.append(el("div", `aw-note ${a.status === "failed" ? "aw-err" : ""}`, a.reason));
  if (compact && tl?.plan) card.append(planBlock(tl, true));
  // Its parked permission requests, each with Allow and Deny: the same cards as Home's.
  const perms = agentRequests(a as unknown as AskingAgent);
  if (perms.length) card.append(...perms);
  if (lines.state === "loading") card.append(el("div", "aw-note", "reading its transcript…"));
  else if (lines.state === "error") card.append(el("div", "aw-err", `Could not read its transcript: ${lines.error}`));
  else if (tl) {
    if (!compact && tl.hooksUnread && a.sessionId && session?.state === "ok") card.append(hooksWindowNote(a.sessionId, session.data, tl.hooksUnread));
    card.append(log(tl, compact ? 6 : undefined, a.cwd));
  }
  card.append(composer(a), out);
  if (!compact && session?.state === "error") card.append(el("div", "aw-note aw-err", `Claude Code's transcript for hook context could not be read: ${session.error}`));
  return card;
}

/**
 * Its tool calls come from the whole host transcript, but hook context and the meter only from
 * the newest Claude Code records: say so on the card, and offer to read the rest.
 */
function hooksWindowNote(sid: string, cli: AgentSessionResponse, unread: number): HTMLElement {
  const t = cli.transcript;
  const all = el("button", "aw-btn sm", `Read all ${t.total}`);
  all.id = "aw-read-all";
  all.onclick = () => {
    S.tails.set(sid, t.total!);
    all.disabled = true;
    all.textContent = "reading…";
    loadSession(sid);
  };
  const note = el("div", "aw-note aw-warn",
    `Hooks and context were read from Claude Code's newest ${t.count} of ${t.total} records: ${unread} earlier call${unread === 1 ? "" : "s"} show${unread === 1 ? "s" : ""} "hooks not read", not "none". `, all);
  note.id = "aw-hooks-window";
  return note;
}

function hostDetail(a: HostAgent): HTMLElement {
  const { tl, session } = timelineFor(a);
  const side = el("div", "aw-side",
    el("div", "aw-card",
      el("h3", "", "Session"),
      kv([
        ["agent", a.id],
        ["status", a.status + (a.reason ? ` (${a.reason})` : "")],
        ["issue", a.issue ? `#${a.issue}` : "none given"],
        ["folder", a.cwd],
        ["session", a.sessionId ?? "not reported yet"],
        ["model", a.model ?? "not reported yet"],
        ["login source", a.apiKeySource === undefined ? "not reported yet" : a.apiKeySource === "none" ? "claude.ai login (apiKeySource none)" : `NOT the login: ${a.apiKeySource}`],
        ["started", a.createdAt.replace("T", " ").slice(0, 19) + " UTC"],
        ["usage estimate", a.costEstimateUsd !== undefined ? `$${a.costEstimateUsd.toFixed(2)} (Claude Code's estimate, not a bill)` : "not reported yet"],
      ])),
    tl ? planCard(tl) : el("div", "aw-card aw-note", "Plan: reading…"),
    tl ? hooksCard(tl) : el("div", ""),
    sourcesCard([
      ["Agent host transcript", hostSourceLine(S.host.get(a.id), a.id)],
      ...sessionSources(a.sessionId, session),
    ]),
  );
  return el("div", "aw-split", hostCard(a, false), side);
}

function grid(agents: HostAgent[]): HTMLElement {
  const g = el("div", "aw-grid");
  g.id = "aw-grid";
  const shown = gridAgents(agents);
  if (!shown.length) g.append(el("div", "aw-empty", "No agent AnviDeck started to show. The grid shows up to four, running ones first; terminal sessions open one at a time from the tabs."));
  for (const a of shown) g.append(hostCard(a, true));
  if (agents.length > shown.length) g.append(el("div", "aw-note", `${agents.length - shown.length} more in the tabs above (the grid shows four).`));
  return g;
}

// ── a terminal session (view only) ──────────────────────────────────────────────────────────

function terminalDetail(sid: string): HTMLElement {
  if (!S.sessions.has(sid)) loadSession(sid);
  const s = S.sessions.get(sid)!;
  const d = S.deps!;
  const card = el("div", "aw-card");
  card.dataset.session = sid;
  const replay = el("a", "aw-note", "Open the replay (changes, notes used)") as HTMLAnchorElement;
  replay.href = hashFor({ view: "replay", project: d.project ?? undefined, sid });
  card.append(el("div", "aw-card-head", el("span", "aw-dot view"), el("b", "", sid.slice(0, 8)), el("span", "aw-viewonly", "view only"),
    el("span", "aw-note", "started in a terminal: AnviDeck cannot message, stop or answer it"), el("span", "r", replay)));
  let tl: Timeline | null = null;
  if (s.state === "loading") card.append(el("div", "aw-note", "reading its transcript…"));
  else if (s.state === "error") card.append(el("div", "aw-err", `Could not read the session: ${s.error}`));
  else {
    const t = s.data.transcript;
    if (t.status === "not-found" || t.status === "unreadable") card.append(el("div", "aw-err", `Could not read its transcript: ${t.detail ?? t.status}`));
    else {
      if (t.cwd) card.append(el("div", "aw-note", t.cwd));
      tl = buildTimeline({
        lines: t.records.map((r) => ({ at: r.at, from: "cli" as const, message: r as unknown as Record<string, unknown> })),
        meter: s.data.meter.rows,
        hookLog: s.data.hookLog.rows,
        cwd: t.cwd,
        live: false,
      });
      if (t.total !== undefined && t.total > t.count) {
        const all = el("button", "aw-btn sm", `Read all ${t.total}`);
        all.id = "aw-read-all";
        all.onclick = () => {
          S.tails.set(sid, t.total!);
          all.disabled = true;
          all.textContent = "reading…";
          loadSession(sid);
        };
        card.append(el("div", "aw-note", `Showing its newest ${t.count} of ${t.total} records: earlier tool calls, refusals and plan changes are not counted until read. `, all));
      }
      card.append(log(tl, undefined, t.cwd));
    }
  }
  const side = el("div", "aw-side",
    tl ? planCard(tl) : el("div", ""),
    tl ? hooksCard(tl) : el("div", ""),
    sourcesCard(sessionSources(sid, s)));
  return el("div", "aw-split", card, side);
}

// ── shared parts ────────────────────────────────────────────────────────────────────────────

function kv(rows: [string, string][]): HTMLElement {
  const dl = el("dl", "aw-kv");
  for (const [k, v] of rows) dl.append(el("dt", "", k), el("dd", "", v));
  return dl;
}

function sessionSources(sid: string | undefined, s: Load<AgentSessionResponse> | null | undefined): [string, { text: string; tone: string }][] {
  if (!sid) return [["Claude Code transcript", { text: "no session id yet (the agent has not reached Claude Code)", tone: "neutral" }]];
  if (!s || s.state === "loading") return [["Claude Code transcript", { text: "reading…", tone: "neutral" }]];
  if (s.state === "error") return [["Claude Code transcript, hook meter, hook log", { text: `could not read: ${s.error}`, tone: "bad" }]];
  return [
    [`Claude Code transcript ${s.data.transcript.path}`, sourceLine("transcript", s.data.transcript)],
    [`Hook meter ${s.data.meter.path}`, sourceLine("meter", s.data.meter)],
    [`Hook log ${s.data.hookLog.path}`, sourceLine("hookLog", s.data.hookLog)],
    ["Read at", { text: `${s.data.readAt.replace("T", " ").slice(0, 19)} UTC`, tone: "neutral" }],
  ];
}

function sourcesCard(rows: [string, { text: string; tone: string }][]): HTMLElement {
  const box = el("div", "aw-card aw-sources");
  box.id = "aw-sources";
  box.append(el("h3", "", "Sources"));
  for (const [k, v] of rows) {
    const line = el("div", "", `${k}: `, el("span", v.tone === "bad" ? "aw-err" : v.tone === "warn" ? "aw-warn" : v.tone === "ok" ? "" : "aw-note", v.text));
    line.dataset.tone = v.tone;
    box.append(line);
  }
  return box;
}

function planBlock(tl: Timeline, compact: boolean): HTMLElement {
  const p = tl.plan!;
  const box = el("div", "");
  box.dataset.plan = `${p.done}/${p.total}`;
  const bar = el("div", "aw-bar", el("i"));
  (bar.firstChild as HTMLElement).style.width = `${p.total ? Math.round((100 * p.done) / p.total) : 0}%`;
  box.append(el("div", "aw-note", `Plan: ${planProgress(p)} · from its ${p.source} calls, last changed ${hhmm(p.at)} UTC`), bar);
  if (!compact) {
    const ol = el("ol", "aw-plan");
    for (const it of p.items) ol.append(el("li", it.status === "completed" ? "done" : it.status === "in_progress" ? "now" : "", it.text));
    box.append(ol);
  }
  return box;
}

function planCard(tl: Timeline): HTMLElement {
  const c = el("div", "aw-card");
  c.id = "aw-plan";
  c.append(el("h3", "", "Plan"));
  if (tl.plan) c.append(planBlock(tl, false));
  else c.append(el("div", "aw-note", "No plan: the agent made no TodoWrite or TaskCreate call in what was read."));
  return c;
}

function hooksCard(tl: Timeline): HTMLElement {
  const c = el("div", "aw-card");
  c.id = "aw-hooks";
  const h = tl.hookTotals;
  const ctx = tl.tools.filter((t) => t.context.length).length;
  c.append(el("h3", "", "anvi at its tool calls"),
    kv([
      ["tool calls", String(tl.tools.length)],
      ["hook runs placed", `${h.runs} (hook meter) · ${h.informed} gave context · ${h.bytes} bytes${h.blocked ? ` · ${h.blocked} blocked` : ""}`],
      ["calls given context", `${ctx} (Claude Code's transcript, joined by tool-call id)`],
      ...(tl.hooksUnread ? [["hooks not read", `${tl.hooksUnread} of the ${tl.tools.length} calls started before the records read (Read all on the card)`] as [string, string]] : []),
      ["edits refused", `${tl.refusals.length} (in the records read, see Sources)`],
      ["context outside calls", `${tl.sessionContext.length} (session start, prompts)`],
    ]));
  const u = tl.unplaced;
  if (u.meter || u.hookLog || u.context) {
    c.append(el("div", "aw-note", `Not placed on one of its calls: ${u.meter} hook-meter rows, ${u.hookLog} hook-log rows, ${u.context} context records (subagents' calls, calls that overlapped, or outside the records read).`));
  }
  return c;
}

const STATE_ICON: Record<ToolCall["state"], [string, string, string]> = {
  running: ["…", "aw-note", "running"],
  ok: ["✓", "aw-ok", "ok"],
  error: ["!", "aw-err", "error"],
  refused: ["✕", "aw-err", "refused by the design guard"],
  blocked: ["✕", "aw-err", "blocked by a hook"],
  denied: ["✕", "aw-warn", "denied"],
  "no-result": ["?", "aw-warn", "no result recorded"],
};

function log(tl: Timeline, last: number | undefined, cwd: string | undefined): HTMLElement {
  const box = el("div", "aw-log");
  const items = last ? tl.items.slice(-last) : tl.items;
  if (last && tl.items.length > last) box.append(el("div", "aw-event", `${tl.items.length - last} earlier steps · open the tab to see all`));
  if (!items.length) box.append(el("div", "aw-event", "nothing in its transcript yet"));
  for (const it of items) box.append(item(it, cwd));
  requestAnimationFrame(() => (box.scrollTop = box.scrollHeight));
  return box;
}

function item(it: Item, cwd: string | undefined): HTMLElement {
  if (it.kind === "you") {
    const m = el("div", "aw-msg you", el("div", "aw-who", "You", it.comment ? ` · on ${it.comment}` : "", " · ", stamp(it.at),
      it.state ? el("span", it.state === "delivered" ? "aw-ok" : it.state === "queued" ? "aw-warn" : "aw-err", ` · ${it.state === "not-delivered" ? `not delivered${it.reason ? `: ${it.reason}` : ""}` : it.state}`) : ""), it.text);
    if (it.messageId) m.dataset.message = it.messageId;
    return m;
  }
  if (it.kind === "agent") return el("div", "aw-msg", el("div", "aw-who", "Agent · ", stamp(it.at)), it.text);
  if (it.kind === "event") return el("div", `aw-event ${it.tone}`, `${hhmm(it.at)} ${it.text}`);
  return tool(it, cwd);
}

function tool(t: ToolCall, _cwd: string | undefined): HTMLElement {
  const wrap = el("div", "");
  const [icon, cls, word] = STATE_ICON[t.state];
  const det = el("details", "aw-tool");
  det.dataset.tool = t.id;
  det.dataset.state = t.state;
  det.open = S.open.has(t.id);
  det.addEventListener("toggle", () => (det.open ? S.open.add(t.id) : S.open.delete(t.id)));
  const informed = t.hooks.filter((h) => h.outcome === "informed").length + t.context.length;
  const sum = el("summary", "",
    el("span", cls, icon), el("span", "t", `${t.name} · ${t.target}`),
    el("span", "r",
      t.context.length || t.hooks.length ? el("span", informed ? "aw-o-informed" : "", `${t.hooks.length} hook${t.hooks.length === 1 ? "" : "s"}${t.context.length ? ` · ${t.context.length} gave context` : ""}`) : t.hooksUnread ? el("span", "aw-warn", "hooks not read") : "",
      t.hookLog.length ? el("span", "aw-o-informed", `${t.hookLog.length} hook-log`) : "",
      t.permission ? el("span", "aw-warn", t.permission.answer ? `permission: ${t.permission.answer}` : "asked permission") : "",
      el("span", cls, word), stamp(t.at)));
  det.append(sum);
  const body = el("div", "body");
  if (t.hooks.length) {
    const table = el("table", "aw-hooks", el("tr", "", el("th", "", "check"), el("th", "", "outcome"), el("th", "", "bytes"), el("th", "", "source")));
    for (const h of t.hooks) {
      table.append(el("tr", "", el("td", "", `${h.name}${h.event ? ` (${h.event})` : ""}`), el("td", `aw-o-${h.outcome}`, h.outcome + (h.why ? ` · ${h.why}` : "")),
        el("td", "num", h.bytes !== undefined ? String(h.bytes) : "—"), el("td", "", h.source === "meter" ? "hook meter, by time" : "transcript, by call id")));
    }
    body.append(table);
  } else if (t.hooksUnread) body.append(el("div", "aw-note aw-warn", "Hooks not read for this call: it started before the newest Claude Code records that were read (Read all on the card fetches the rest)."));
  else body.append(el("div", "aw-note", "No hook run placed on this call (see Sources and the not-placed count)."));
  for (const c of t.context) body.append(el("div", "aw-note", `Context from ${c.hook} (${c.chars} characters, as the agent received it):`), el("pre", "", c.text));
  for (const r of t.hookLog) {
    body.append(el("div", "aw-note",
      `Hook log ${hhmm(r.ts)}: ${r.file} · boundaries ${r.boundaries.join(", ") || "none"} · ${r.patterns.length} error patterns · ${r.invariants.length} invariants${r.fatality ? " · organisational warning" : ""}`));
  }
  if (t.permission) body.append(el("div", "aw-note", `Permission request ${t.permission.requestId}: ${t.permission.answer ?? "waiting"}${t.permission.message ? ` · "${t.permission.message}"` : ""}${t.permission.reason ? ` (${t.permission.reason})` : ""}`));
  body.append(el("div", "aw-note", "Input"), el("pre", "", JSON.stringify(t.input, null, 2)));
  if (t.result) body.append(el("div", "aw-note", `Result${t.result.isError ? " (error)" : ""} · ${hhmm(t.result.at)}`), el("pre", "", t.result.text));
  det.append(body);
  wrap.append(det);
  if (t.refusal) wrap.append(refusalCard(t.refusal, t, _cwd));
  return wrap;
}

/** A blocked edit: the layer path, the rule, and the guard's first remedy. Whole text one click away. */
function refusalCard(r: Refusal, t: ToolCall, cwd: string | undefined): HTMLElement {
  const card = el("div", "aw-refusal");
  card.dataset.refusal = r.file;
  card.dataset.tour = "refusal-card";
  card.append(el("div", "aw-card-head", el("b", "", `Blocked edit · ${r.file}`), el("span", "r", el("span", "aw-chip bad", `design guard · ${r.pkg}`), stamp(t.result?.at ?? t.at))));
  for (const v of r.violations) {
    const layer = (name: string | undefined, file: string) => el("span", "layer", name ? el("i", "", name) : "", file);
    card.append(el("div", "path", layer(v.fromLayer, v.fromFile), el("span", "arrow", "── imports ──▶"), layer(v.toLayer, v.toFile)));
    card.append(el("div", "aw-note", `Rule (${v.rule}): ${v.detail}`));
  }
  if (!r.violations.length) card.append(el("div", "aw-note", "The guard's text names no import line this screen can read; its whole text is below."));
  if (r.remedy) card.append(el("div", "", `Remedy it gave: ${r.remedy}`));
  card.append(el("div", "aw-note", `${r.designId ? `Judged under design ${r.designId}. ` : ""}The edit did not land; the agent read this refusal.`));
  const whole = el("details", "", el("summary", "aw-note", "The refusal as the agent read it"), el("pre", "", r.text));
  card.append(whole);
  // Your call on it (#86), keyed by the refused call's tool_use id; the project is the screen's, else the agent's folder name.
  card.append(refusalCall({ key: t.id, project: S.deps?.project ?? cwd?.split("/").filter(Boolean).pop() ?? "unknown",
    refusal: { tool: t.name, file: r.file, at: t.at ?? undefined } }));
  return card;
}
