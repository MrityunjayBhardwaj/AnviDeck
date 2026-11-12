/**
 * Home as in the prototype (#81): the model behind HomeScreen.ts. Pure and DOM-free, so
 * tests/home-screen.test.ts reads it directly.
 *
 *   queueRows    one queue, soonest first: an agent's permission request (Answer, in place),
 *                a PR to review, a PR ready to merge (to its row on Work), and what the
 *                readers already put in the queue (a terminal session waiting, a new rule break)
 *   healthModel  the one health line and its details: guards, allowed rule breaks, out-of-date
 *                notes, notes backed by source; each figure from its reader, with its date
 *   agentRows    the agents: those AnviDeck started (GET /api/agents) and terminal sessions
 *
 * The queue's length is never counted here: the headline reads needsCount() (ui/home-count.ts).
 * The rows are built from the same inputs, one row per counted thing, and a test checks that
 * the two agree. A source that could not be read is a row of its own, never "nothing".
 */
import type { HomeAgent, HomeMetric, HomeResponse, MetricState, QueueItem } from "../../shared/home-types";
import type { ProjectSummary } from "../../shared/types";
import type { AgentsRead, StripAgent } from "../shell/activity";
import { askerOf, askSummary, permissionQueue, subagentDetail, type AskingAgent } from "../../shared/permission-requests";
import type { ReadyAnswer } from "../../shared/pr-ready";
import { GUARDS, guardsLabel, type Guard } from "../shell/guards";

// ── the queue ────────────────────────────────────────────────────────────────────────────

export type RowKind = "answer" | "agent-terminal" | "rule-break" | "review" | "merge";

export type RowAction =
  | { type: "answer"; label: string; agentId: string; requestId: string }
  | { type: "link"; label: string; href: string }
  | { type: "hash"; label: string; hash: string }
  | { type: "copy"; label: string; copy: string };

export interface HomeRow {
  key: string;
  kind: RowKind;
  title: string;
  why: string;
  /** A second line under why, e.g. why a PR is not ready to merge yet. */
  note?: string;
  /** "agent waiting", "due 2026-11-07", "no deadline". */
  when: string;
  tone: "warn" | "bad" | "info";
  action: RowAction;
  source: string;
  /** Sort key: a recorded deadline, or null. */
  dueBy: string | null;
}

export interface UnreadRow {
  key: string;
  what: string;
  source: string;
  /** Still being read (not failed). Either way the row is never counted. */
  reading: boolean;
}

/** The readiness answers for Home's PRs (GET /api/home/ready), keyed "owner/name#N". */
export type ReadyRead =
  | { state: "loading" }
  | { state: "ok"; answers: Map<string, ReadyAnswer> }
  | { state: "failed"; reason: string };

/** The PR key of a pr-review row ("pr:owner/name#N" → "owner/name#N"), else null. */
export function prKeyOf(item: QueueItem): string | null {
  return item.kind === "pr-review" && item.id.startsWith("pr:") ? item.id.slice(3) : null;
}

/** The PR keys Home asks readiness for, in queue order. */
export function readyKeys(home: HomeResponse | null): string[] {
  const keys: string[] = [];
  for (const q of home?.queue ?? []) {
    const k = prKeyOf(q);
    if (k) keys.push(k);
  }
  return keys;
}

const base = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;

function hhmm(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** "Review PR #12: Some title" → "Some title". */
function prTitle(item: QueueItem): string {
  return item.what.replace(/^Review PR #\d+:?\s*/, "");
}

function prRow(item: QueueItem, ready: ReadyRead): HomeRow {
  const key = prKeyOf(item)!;
  const [repo, num] = key.split("#") as [string, string];
  const title = prTitle(item);
  const when = item.dueBy ? `due ${item.dueBy}` : "no deadline";
  const source = `${item.why} Source: ${item.source}`;
  const answer = ready.state === "ok" ? ready.answers.get(key) : undefined;
  if (answer?.status === "ok" && answer.ready) {
    const c = answer.claims;
    const gaps = c ? c.gaps.high + c.gaps.medium + c.gaps.low : 0;
    const said = c
      ? `The PR body says ${c.testRuns} test run${c.testRuns === 1 ? "" : "s"} exited 0 and ${c.observed} thing${c.observed === 1 ? " was" : "s were"} seen working; its self-review lists ${gaps === 0 ? "no gaps" : `${gaps} gap${gaps === 1 ? "" : "s"} (${c.gaps.medium} medium, ${c.gaps.low} low)`}.`
      : "The PR body records Evidence and a Self-review.";
    const medium = c?.mediumGaps.length ? ` Open medium gaps: ${c.mediumGaps.join("; ")}.` : "";
    return {
      key: item.id,
      kind: "merge",
      title: `${base(repo)} PR #${num} is ready to merge`,
      why: `${title || "(no title)"}. ${said}${medium}`,
      note:
        `GitHub: mergeable, ${answer.noChecks ? "no checks ran on GitHub, so tests rest only on the PR body" : answer.checks}, head ${answer.headRefOid.slice(0, 7)}` +
        ` · checked ${hhmm(answer.checkedAt)}`,
      when,
      tone: "info",
      // Merge is a button only you press, on the PR's row on Work. The hash carries the head this
      // verdict is about, so Work can refuse to merge any other head.
      action: { type: "hash", label: "Merge…", hash: `#work?pr=${num}&repo=${encodeURIComponent(repo)}&head=${answer.headRefOid}` },
      source,
      dueBy: item.dueBy,
    };
  }
  const note =
    ready.state === "loading" || (ready.state === "ok" && !answer)
      ? "Checking whether it is ready to merge…"
      : ready.state === "failed"
        ? `Could not check whether it is ready to merge: ${ready.reason}`
        : answer!.status === "could-not-read"
          ? `Could not check whether it is ready to merge: ${answer!.reason}`
          : `Not ready to merge: ${answer!.reasons.join("; ")}.`;
  return {
    key: item.id,
    kind: "review",
    title: `Review ${base(repo)} PR #${num}`,
    why: title || "(no title)",
    note,
    when,
    tone: "warn",
    action: { type: "link", label: "Review on GitHub", href: item.action.href ?? `https://github.com/${repo}/pull/${num}` },
    source,
    dueBy: item.dueBy,
  };
}

function readerRow(item: QueueItem, home: HomeResponse, ready: ReadyRead): HomeRow {
  if (item.kind === "pr-review" && prKeyOf(item)) return prRow(item, ready);
  if (item.kind === "agent-waiting") {
    const sid = item.id.replace(/^agent:/, "");
    const agent = home.agents.find((a) => a.sessionId === sid);
    // A terminal session cannot be answered from here: AnviDeck only reads it. Its row opens the session.
    const action: RowAction = agent
      ? { type: "hash", label: "Open session", hash: `#agents?project=${encodeURIComponent(agent.project)}&sid=${encodeURIComponent(sid)}` }
      : { type: "copy", label: item.action.label, copy: item.action.copy ?? "" };
    return { key: item.id, kind: "agent-terminal", title: item.what, why: `${item.why} It runs in a terminal: answer it there.`, when: "agent waiting", tone: "warn", action, source: item.source, dueBy: item.dueBy };
  }
  if (item.kind === "rule-break") {
    const project = item.id.replace(/^rules:/, "");
    return {
      key: item.id,
      kind: "rule-break",
      title: item.what,
      why: item.why,
      when: item.dueBy ? `due ${item.dueBy}` : "no deadline",
      tone: "bad",
      action: { type: "hash", label: "Open on Map", hash: `#map?project=${encodeURIComponent(project)}` },
      source: item.source,
      dueBy: item.dueBy,
    };
  }
  // A kind this screen does not know yet still shows, with the reader's own action.
  const action: RowAction = item.action.href
    ? { type: "link", label: item.action.label, href: item.action.href }
    : { type: "copy", label: item.action.label, copy: item.action.copy ?? "" };
  return { key: item.id, kind: "review", title: item.what, why: item.why, when: item.dueBy ? `due ${item.dueBy}` : "no deadline", tone: "warn", action, source: item.source, dueBy: item.dueBy };
}

/**
 * Soonest first: anything with a recorded deadline (earliest first), then agents paused on a
 * permission request (they are blocked right now; longest waiting first), then the readers'
 * queue in its own order (terminal agents waiting, rule breaks, PRs).
 */
export function queueRows(home: HomeResponse | null, host: AgentsRead, ready: ReadyRead): { rows: HomeRow[]; unread: UnreadRow[] } {
  const rows: HomeRow[] = [];
  const unread: UnreadRow[] = [];

  if (host.state === "ok") {
    const q = permissionQueue(host.agents as unknown as AskingAgent[]);
    const asks = [...q.requests].sort((a, b) => Date.parse(a.request.askedAt) - Date.parse(b.request.askedAt));
    for (const { agent, request: p } of asks) {
      rows.push({
        key: `ask:${p.requestId}`,
        kind: "answer",
        title: `${askerOf(p)} asks to ${askSummary(p.toolName, p.input)}`,
        why: `Agent ${agent.id}${agent.issue ? ` on #${agent.issue}` : ""} in ${base(agent.cwd)} is paused until you answer.${p.subagent ? ` Asked by its ${subagentDetail(p)}.` : ""}`,
        when: "agent waiting",
        tone: "warn",
        action: { type: "answer", label: "Answer", agentId: agent.id, requestId: p.requestId },
        source: `GET /api/agents: a ${p.toolName} call your permission rules did not settle, asked ${hhmm(p.askedAt)}`,
        dueBy: null,
      });
    }
    if (q.unreadable)
      unread.push({ key: "asks-unreadable", what: `${q.unreadable} permission request${q.unreadable === 1 ? "" : "s"} could not be read`, source: "GET /api/agents: a parked request without the fields an answer needs", reading: false });
  } else if (host.state === "loading") {
    unread.push({ key: "asks-reading", what: "Checking the agents AnviDeck started for permission requests…", source: "GET /api/agents", reading: true });
  } else {
    unread.push({
      key: "asks-unread",
      what: host.state === "off" ? "Could not read permission requests: the agent host is off" : "Could not read permission requests from the agents AnviDeck started",
      source: `GET /api/agents: ${host.reason}`,
      reading: false,
    });
  }

  if (home) {
    for (const item of home.queue) rows.push(readerRow(item, home, ready));
    for (const u of home.unread) unread.push({ key: u.id, what: u.what, source: u.source, reading: !!u.reading });
  }
  // A stable sort: only a recorded deadline moves a row ahead of the order above.
  const order = rows.map((r, i) => ({ r, i }));
  order.sort((a, b) => (a.r.dueBy ?? "￿").localeCompare(b.r.dueBy ?? "￿") || a.i - b.i);
  return { rows: order.map((o) => o.r), unread };
}

// ── the health line ──────────────────────────────────────────────────────────────────────

export interface HealthRow {
  id: "guards" | "allowed-breaks" | "notes" | "grounding" | "child-reads" | "sources";
  label: string;
  value: string;
  /** The population after the value, e.g. "of 7,248". */
  of?: string;
  state: MetricState;
  note: string;
  /** What date the figure is of, in words ("commit of 2026-11-05", "snapshot of 2026-10-02"), or null. */
  asOf: string | null;
  source: string;
  link?: { label: string; hash: string };
  /** The short phrase for "N things to watch: …", set only on rows to watch. */
  watch?: string;
}

export interface HealthModel {
  state: "loading" | "failed" | "ok";
  word: string;
  dot: MetricState;
  /** "· 1 thing to watch: 2,906 notes are out of date" */
  tail: string;
  rows: HealthRow[];
}

const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : null);

/** A metric's value as shown: a reader that could not look says so, never 0. */
function shownValue(m: HomeMetric | undefined): string {
  if (!m) return "could not read";
  if (m.state !== "unknown") return m.value;
  return m.value === "still measuring" ? "still measuring" : "could not read";
}

export interface HealthInput {
  home: HomeResponse | null;
  failed: boolean;
  /** The project picked in the switcher, as /api/projects read it; null when none is picked. */
  project: ProjectSummary | null;
  /** When /api/projects was read (ISO), for the grounding figure's date. */
  projectsReadAt: string | null;
  guards?: readonly Guard[];
}

export function healthModel(input: HealthInput): HealthModel {
  const { home, failed, project, projectsReadAt } = input;
  const guards = input.guards ?? GUARDS;
  if (!home) {
    return failed
      ? { state: "failed", word: "Could not read health", dot: "unknown", tail: "· /api/home did not answer; this is not “healthy”", rows: [] }
      : { state: "loading", word: "Checking health…", dot: "unknown", tail: "", rows: [] };
  }
  const metric = (id: HomeMetric["id"]) => home.metrics.find((m) => m.id === id);
  const rows: HealthRow[] = [];

  // Guards: AnviDeck's own write guards (on main, each checked by a test) and the structure guard's verdict.
  const g = guardsLabel(guards);
  const nb = metric("new-breaks");
  const nbValue = shownValue(nb);
  const nbState: MetricState = nb ? nb.state : "unknown";
  const guardsState: MetricState = nbState === "bad" ? "bad" : nbState === "unknown" ? "unknown" : g.state === "partial" ? "warn" : "ok";
  const structureWords =
    !nb ? "Structure guard: could not read."
      : nb.state === "unknown" ? `Structure guard: ${nbValue}.`
        : nb.value === "not measured" ? `Structure guard: ${nb.note}`
          : `Structure guard: ${nb.value} new rule break${nb.value === "1" ? "" : "s"} since the baseline.`;
  rows.push({
    id: "guards",
    label: "Guards",
    value: g.state === "on" ? "on" : g.text.replace(/^Guards: /, ""),
    state: guardsState,
    // Said from the guard list itself, so the words cannot drift from the guards counted (#262).
    note: `AnviDeck: ${guards.filter((x) => x.on).length} of ${guards.length} write guards on (${guards.filter((x) => x.on).map((x) => x.short).join("; ") || "none"}). ${structureWords}`,
    asOf: nb?.asOf ? `commit of ${day(nb.asOf)}` : null,
    source: `ui/shell/guards.ts (each guard's code checked by a test) · ${nb?.source ?? "structure guard: no answer"}`,
    ...(guardsState === "bad" ? { watch: `${nb!.value} new rule break${nb!.value === "1" ? "" : "s"}` } : g.state === "partial" ? { watch: g.text } : {}),
  });

  const ab = metric("allowed-breaks");
  rows.push({
    id: "allowed-breaks",
    label: "Allowed rule breaks",
    value: shownValue(ab),
    state: ab ? ab.state : "unknown",
    note: ab ? ab.note : "The structure guard's figures were not in the answer.",
    asOf: ab?.asOf ? `commit of ${day(ab.asOf)}` : null,
    source: ab?.source ?? "structure guard",
  });

  const nt = metric("notes");
  const ntValue = shownValue(nt);
  const ofMatch = nt && nt.state !== "unknown" ? /^([\d,]+) of ([\d,]+)$/.exec(nt.value) : null;
  rows.push({
    id: "notes",
    label: "Out-of-date notes",
    value: ofMatch ? ofMatch[1]! : nt?.value === "no snapshot" ? "no snapshot" : ntValue,
    ...(ofMatch ? { of: `of ${ofMatch[2]}` } : {}),
    state: nt ? nt.state : "unknown",
    note: nt ? nt.note : "The notes snapshot was not in the answer.",
    asOf: nt?.asOf ? `snapshot of ${day(nt.asOf)}` : null,
    source: nt?.source ?? "notes currency snapshot",
    link: { label: "Open currency", hash: "#notes" },
    ...(nt?.state === "warn" || nt?.state === "bad" ? { watch: ofMatch ? `${ofMatch[1]} notes are out of date` : `out-of-date notes ${nt.value}` } : {}),
  });

  rows.push(groundingRow(project, projectsReadAt));

  // Reads cut short (#257): absent from an older server's answer, which is "could not read", never 0.
  const cr = metric("child-reads");
  rows.push({
    id: "child-reads",
    label: "Reads cut short",
    value: shownValue(cr),
    state: cr ? cr.state : "unknown",
    note: cr ? cr.note : "This server's answer has no count of reads cut short.",
    asOf: cr ? `read ${hhmm(home.generatedAt)}` : null,
    source: cr?.source ?? "server/child-output.ts",
    ...(cr?.state === "warn" ? { watch: `${cr.value} read${cr.value === "1" ? "" : "s"} cut short` } : {}),
  });

  const src = metric("sources");
  if (src) {
    rows.push({
      id: "sources",
      label: "Sources read",
      value: src.value,
      state: src.state,
      note: src.note,
      asOf: `read ${hhmm(home.generatedAt)}`,
      source: Object.entries(home.sources).map(([k, s]) => `${k}: ${s.status.replace(/-/g, " ")} (${s.label})`).join(" · "),
      ...(src.state === "warn" ? { watch: `${src.value} sources read` } : {}),
    });
  }

  const bad = rows.some((r) => r.state === "bad");
  const unknown = rows.some((r) => r.state === "unknown");
  const watch = rows.filter((r) => r.watch).map((r) => r.watch!);
  return {
    state: "ok",
    word: bad ? "Needs attention" : unknown ? "Could not check everything" : "Healthy",
    dot: bad ? "bad" : unknown ? "unknown" : "ok",
    tail: watch.length ? `· ${watch.length} thing${watch.length === 1 ? "" : "s"} to watch: ${watch.join("; ")}` : "· nothing to watch",
    rows,
  };
}

/** Notes backed by source: the share of the picked project's notes that cite a Ground Truth doc. */
export function groundingRow(project: ProjectSummary | null, readAt: string | null): HealthRow {
  const base = { id: "grounding" as const, label: project ? `Notes backed by source (${project.name})` : "Notes backed by source", asOf: readAt ? `read ${day(readAt)} ${hhmm(readAt)}` : null };
  if (!project) return { ...base, value: "no project", state: "unknown", note: "Pick a project in the switcher to see its figure.", source: "/api/projects" };
  const src = `/api/projects: ${project.name}'s catalogues (entries with a REF to a Ground Truth doc)`;
  const cat = project.readStatus?.catalogues;
  if (cat && (cat.status === "unreadable" || cat.status === "partial")) {
    return { ...base, value: "could not read", state: "unknown", note: `${project.name}'s catalogues: ${cat.errors.slice(0, 2).join("; ") || cat.status}.`, source: src };
  }
  if (project.sharesNotesWith) {
    return { ...base, value: "shared", state: "ok", note: `${project.name} uses ${project.sharesNotesWith}'s notes; its figure is ${project.sharesNotesWith}'s.`, source: src };
  }
  const entries = Object.values(project.catalogueCounts).reduce((a, b) => a + b, 0);
  if (entries === 0) return { ...base, value: "no notes", state: "ok", note: `${project.name} has no catalogue entries yet.`, source: src };
  const gt = project.readStatus?.groundTruth;
  const docs =
    gt && (gt.status === "unreadable" || gt.status === "partial")
      ? "its Ground Truth folder could not be read"
      : `${project.groundTruthDocCount} Ground Truth doc${project.groundTruthDocCount === 1 ? "" : "s"}`;
  return {
    ...base,
    value: `${project.groundingPercent}%`,
    of: `of ${entries.toLocaleString("en-US")}`,
    state: "ok",
    note: `${project.groundingPercent}% of ${project.name}'s ${entries.toLocaleString("en-US")} notes cite a source; ${docs}.`,
    source: src,
  };
}

// ── the agents ───────────────────────────────────────────────────────────────────────────

export interface AgentRow {
  key: string;
  dot: "warn" | "info" | "ok" | "bad" | "muted";
  title: string;
  doing: string;
  /** "needs you" shows as a chip; anything else as plain words. */
  state: string;
  needsYou: boolean;
  /** Where Open goes: a hash on this page, or /agent-host for an agent AnviDeck started. */
  href: string;
  started: "here" | "terminal";
}

export interface AgentsModel {
  /** "Agents · 14", or "Agents · 13 + ?" when one source could not be read. */
  heading: string;
  rows: AgentRow[];
  /** Sources that could not be read, each a sentence; never shown as "no agents". */
  unread: string[];
  source: string;
}

function hostRow(a: StripAgent): AgentRow {
  const waiting = a.pendingPermissions.length > 0;
  const firstLine = (a.prompt ?? "").split("\n").find((l) => l.trim()) ?? "";
  const dot: AgentRow["dot"] = waiting ? "warn" : a.status === "working" || a.status === "starting" ? "info" : a.status === "failed" ? "bad" : a.status === "done" ? "ok" : "muted";
  return {
    key: `host:${a.id}`,
    dot,
    title: `${base(a.cwd)} · ${a.id}${a.issue ? ` · #${a.issue}` : ""}`,
    doing: firstLine.length > 140 ? `${firstLine.slice(0, 139)}…` : firstLine,
    state: waiting ? "needs you" : a.status,
    needsYou: waiting,
    href: `/agent-host#${encodeURIComponent(a.id)}`,
    started: "here",
  };
}

function terminalRow(a: HomeAgent): AgentRow {
  const waiting = a.status === "waiting";
  return {
    key: `term:${a.sessionId}`,
    dot: waiting ? "warn" : a.status === "busy" ? "info" : "muted",
    title: `${a.project} · ${a.name}`,
    doing: `${waiting ? `waiting${a.waitingFor ? ` (${a.waitingFor})` : ""}` : a.status === "busy" ? "working" : a.status}${a.branch ? ` on ${a.branch}` : ""}${a.openPrs.length ? ` · open PR ${a.openPrs.map((p) => `#${p}`).join(", ")}` : ""} · terminal`,
    state: waiting ? "needs you" : a.status === "busy" ? "working" : a.status,
    needsYou: waiting,
    href: `#agents?project=${encodeURIComponent(a.project)}&sid=${encodeURIComponent(a.sessionId)}`,
    started: "terminal",
  };
}

const URGENCY: Record<string, number> = { "needs you": 0, working: 1, starting: 1, busy: 1 };

export function agentRows(host: AgentsRead, home: HomeResponse | null, homeFailed: boolean): AgentsModel {
  const rows: AgentRow[] = [];
  const unread: string[] = [];
  let known = 0;
  let unknown = false;
  if (host.state === "ok") {
    rows.push(...host.agents.map(hostRow));
    known += host.agents.length;
  } else if (host.state === "loading") unknown = true;
  else {
    unknown = true;
    unread.push(host.state === "off" ? `Could not read the agents AnviDeck started: the agent host is off (${host.reason}).` : `Could not read the agents AnviDeck started: ${host.reason}.`);
  }
  if (home && home.sources.sessions.status !== "could-not-read") {
    rows.push(...home.agents.map(terminalRow));
    known += home.agents.length;
    if (home.sources.sessions.status === "partial") unread.push(`Some terminal sessions could not be read: ${home.sources.sessions.detail ?? "partial"}.`);
  } else {
    unknown = true;
    if (home) unread.push(`Could not read the terminal sessions: ${home.sources.sessions.detail ?? "could not read"}.`);
    else if (homeFailed) unread.push("Could not read the terminal sessions: /api/home did not answer.");
  }
  const indexed = rows.map((r, i) => ({ r, i }));
  indexed.sort((a, b) => (URGENCY[a.r.state] ?? 2) - (URGENCY[b.r.state] ?? 2) || a.i - b.i);
  return {
    heading: `Agents · ${known}${unknown ? " + ?" : ""}`,
    rows: indexed.map((x) => x.r),
    unread,
    source: "GET /api/agents (started here, every status) · ~/.claude/sessions (terminal sessions running now)",
  };
}
