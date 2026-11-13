import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LiveSession } from "../../shared/types";
import type {
  HomeAgent,
  HomeMetric,
  HomeResponse,
  HomeSource,
  OlderPr,
  QueueItem,
  UnreadItem,
} from "../../shared/home-types";
import { readLiveSessionsReport } from "./sessions";
import { readAgentRegistry, type RegistryRead } from "./agent-registry";
import { encodeCwd, findTranscript, ghPrView, runAsync } from "./replay";
import { countingSince, lostOutputEnds } from "../child-output";
import { listStructure, readStructure } from "./structure";

/**
 * Home (issue #18): everything that needs a decision, from real data only.
 *
 * Read only. Four sources:
 *   - live sessions:   ~/.claude/sessions/<pid>.json (status "waiting" = blocked on you)
 *   - PRs:             "pr-link" records in the live sessions' transcripts, each asked of
 *                      GitHub with `gh pr view` (the replay reader's cache: merged/closed kept,
 *                      open for 60 s), plus `gh search prs --author=@me --state=open` for PRs
 *                      whose session has ended (#45)
 *   - structure:       the structure guard's verdict for each project that has a design
 *   - notes currency:  the newest fleet health snapshot, health-<date>.json
 *
 * Only LIVE sessions' transcripts are scanned, and each is read incrementally (only bytes
 * appended since the last call), so a Home load never walks every project's history.
 */

const CLAUDE_PROJECTS = join(homedir(), ".claude", "projects");
export const HEALTH_DIR =
  process.env.ANVIDECK_HEALTH_DIR ?? join(homedir(), ".anvideck", "projects", "anvi", "instances");

// ── PR links in a transcript, read incrementally ──────────────────────────────────────────

export interface PrLink {
  number: number;
  repo: string;
  url: string | null;
  /** Epoch ms of the first link record. */
  first: number;
}

const linkCache = new Map<string, { offset: number; size: number; links: Map<string, PrLink> }>();
const CHUNK = 4 * 1024 * 1024;

/** Parse one transcript line; returns a PR link if it is a "pr-link" record. */
export function prLinkFromLine(line: string): PrLink | null {
  if (!line.includes('"pr-link"')) return null;
  try {
    const r = JSON.parse(line);
    if (r?.type !== "pr-link" || typeof r.prNumber !== "number") return null;
    const repo = String(r.prRepository ?? "");
    if (!repo) return null;
    const ms = Date.parse(r.timestamp ?? "");
    return { number: r.prNumber, repo, url: typeof r.prUrl === "string" ? r.prUrl : null, first: Number.isNaN(ms) ? 0 : ms };
  } catch {
    return null;
  }
}

/**
 * PR links recorded in a transcript. Only bytes appended since the previous call are read;
 * a file that shrank is read again from the start.
 */
export function prLinksIn(path: string): PrLink[] {
  const st = statSync(path);
  let c = linkCache.get(path);
  if (!c || st.size < c.size) c = { offset: 0, size: 0, links: new Map() };
  if (st.size > c.offset) {
    const fd = openSync(path, "r");
    try {
      let pos = c.offset;
      let carry = "";
      const buf = Buffer.alloc(CHUNK);
      while (pos < st.size) {
        const n = readSync(fd, buf, 0, Math.min(CHUNK, st.size - pos), pos);
        if (n <= 0) break;
        pos += n;
        const text = carry + buf.toString("utf8", 0, n);
        const lines = text.split("\n");
        carry = lines.pop() ?? "";
        for (const l of lines) {
          const link = prLinkFromLine(l);
          if (!link) continue;
          const key = `${link.repo}#${link.number}`;
          if (!c.links.has(key)) c.links.set(key, link);
        }
      }
      // An unfinished last line is read again next time.
      c.offset = pos - Buffer.byteLength(carry);
    } finally {
      closeSync(fd);
    }
  }
  c.size = st.size;
  linkCache.set(path, c);
  return [...c.links.values()];
}

function transcriptOf(s: LiveSession): string | null {
  if (s.cwd && s.sessionId) {
    const direct = join(CLAUDE_PROJECTS, encodeCwd(s.cwd), `${s.sessionId}.jsonl`);
    if (existsSync(direct)) return direct;
  }
  return s.sessionId ? findTranscript(s.sessionId) : null;
}

// ── PR state, judged from gh's answer ─────────────────────────────────────────────────────

export interface PrAnswer {
  state: string;
  isDraft: boolean;
  title: string;
  url: string | null;
}

/** "review" = open and not a draft: the only PR state that is a decision for you. */
export function prVerdict(a: PrAnswer): "review" | "draft" | "merged" | "closed" | "other" {
  if (a.state === "OPEN") return a.isDraft ? "draft" : "review";
  if (a.state === "MERGED") return "merged";
  if (a.state === "CLOSED") return "closed";
  return "other";
}

// ── Open PRs you authored, asked of GitHub (#45) ──────────────────────────────────────────
//
// pr-link records only exist in transcripts, and only live ones are scanned, so a PR whose
// session has ended was invisible. Scanning every recent transcript costs ~1.4 GB a week;
// one `gh search prs` finds every open PR you authored in ~2 s, and is cached.

export interface AuthoredPr {
  key: string;
  number: number;
  repo: string;
  title: string;
  url: string;
  isDraft: boolean;
  /** Epoch ms. */
  createdAt: number;
  updatedAt: number;
}

/** A PR not updated in this many days is listed apart from the queue, not in it. */
export const RECENT_DAYS = 30;
export const SEARCH_LIMIT = 100;
const SEARCH_TTL_MS = 60_000;

/** Parse `gh search prs --json number,repository,title,url,isDraft,createdAt,updatedAt`. Throws on bad JSON. */
export function parseAuthoredPrs(out: string): AuthoredPr[] {
  const rows = JSON.parse(out);
  if (!Array.isArray(rows)) throw new Error("gh search prs did not answer with a list");
  return rows.map((r: any) => {
    const repo = String(r.repository?.nameWithOwner ?? "");
    return {
      key: `${repo}#${r.number}`,
      number: Number(r.number),
      repo,
      title: String(r.title ?? ""),
      url: String(r.url ?? `https://github.com/${repo}/pull/${r.number}`),
      isDraft: !!r.isDraft,
      createdAt: Date.parse(r.createdAt ?? "") || 0,
      updatedAt: Date.parse(r.updatedAt ?? "") || 0,
    };
  });
}

/**
 * Which authored PRs join the queue: open, not a draft, not already linked by a live session
 * (that row names the session), and updated within RECENT_DAYS. Older ones are listed apart.
 */
export function splitAuthoredPrs(prs: AuthoredPr[], linked: Set<string>, now: number, days = RECENT_DAYS) {
  const cutoff = now - days * 86_400_000;
  const out = { recent: [] as AuthoredPr[], older: [] as AuthoredPr[], alreadyLinked: 0, drafts: 0 };
  for (const p of prs) {
    if (linked.has(p.key)) out.alreadyLinked++;
    else if (p.isDraft) out.drafts++;
    else if (p.updatedAt >= cutoff) out.recent.push(p);
    else out.older.push(p);
  }
  out.older.sort((a, b) => a.updatedAt - b.updatedAt);
  return out;
}

/**
 * Linked PRs the search already answers for (#46). `gh search prs --state=open` lists only
 * open PRs, with their draft flag, title and URL, which is all prVerdict needs. So a linked
 * PR it lists needs no `gh pr view`; one it does not list (merged, closed, someone else's, or
 * past the search limit) is still asked about.
 */
export function answersFromSearch(keys: string[], search: SearchAnswer | null): Map<string, PrAnswer> {
  const out = new Map<string, PrAnswer>();
  if (!search?.ok) return out;
  const open = new Map(search.prs.map((p) => [p.key.toLowerCase(), p]));
  for (const k of keys) {
    const p = open.get(k.toLowerCase());
    if (p) out.set(k, { state: "OPEN", isDraft: p.isDraft, title: p.title, url: p.url });
  }
  return out;
}

export type SearchAnswer =
  | {
      ok: true; prs: AuthoredPr[]; at: number; cached: boolean;
      /** Set while the latest background refresh failed: `prs` is then older than it looks (#54). */
      refreshFailed?: { err: string; at: number };
    }
  | { ok: false; err: string };

type Runner = (cmd: string[], timeoutMs?: number) => Promise<{ ok: boolean; out: string; err: string }>;
let searchCache: { at: number; prs: AuthoredPr[] } | null = null;
let searchInFlight: Promise<SearchAnswer> | null = null;
/** The latest search failure, cleared by the next success. */
let searchFailure: { err: string; at: number } | null = null;

export function resetAuthoredSearch() {
  searchCache = null;
  searchInFlight = null;
  searchFailure = null;
}

async function runSearch(run: Runner): Promise<SearchAnswer> {
  const r = await run(
    ["gh", "search", "prs", "--author=@me", "--state=open", "--limit", String(SEARCH_LIMIT), "--json", "number,repository,title,url,isDraft,createdAt,updatedAt"],
    20000
  );
  const fail = (err: string): SearchAnswer => {
    searchFailure = { err: err.slice(0, 160), at: Date.now() };
    return { ok: false, err: searchFailure.err };
  };
  if (!r.ok) return fail(r.err || "gh search prs failed");
  try {
    const prs = parseAuthoredPrs(r.out);
    searchCache = { at: Date.now(), prs };
    searchFailure = null;
    return { ok: true, prs, at: searchCache.at, cached: false };
  } catch (e) {
    return fail(`unparseable answer: ${(e as Error).message}`);
  }
}

/**
 * Open PRs you authored. Fresh for 60 s; after that the last answer is returned at once and
 * a new search runs behind it, so only the very first Home load waits for GitHub. Failures
 * are never cached, but a failed refresh is reported beside the answer it could not replace.
 */
export async function searchAuthoredPrs(run: Runner = runAsync, now = Date.now()): Promise<SearchAnswer> {
  const refresh = () => (searchInFlight ??= runSearch(run).finally(() => (searchInFlight = null)));
  if (searchCache) {
    if (now - searchCache.at >= SEARCH_TTL_MS) void refresh();
    return {
      ok: true, prs: searchCache.prs, at: searchCache.at, cached: true,
      ...(searchFailure ? { refreshFailed: searchFailure } : {}), // a success clears it, so it is newer than the cache
    };
  }
  return refresh();
}

// ── Notes currency: the newest fleet health snapshot ──────────────────────────────────────

export interface NotesCurrency {
  file: string;
  date: string;
  examined: number;
  red: number;
  yellow: number;
  projects: number;
  unmeasured: string[];
}

export function readNotesCurrency(dir = HEALTH_DIR): { value: NotesCurrency | null; source: HomeSource } {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => /^health-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { value: null, source: { status: code === "ENOENT" ? "none" : "could-not-read", label: dir, detail: code === "ENOENT" ? "no snapshot directory" : String((e as Error).message) } };
  }
  const f = files[files.length - 1];
  if (!f) return { value: null, source: { status: "none", label: dir, detail: "no health-<date>.json snapshot" } };
  const file = join(dir, f);
  try {
    const d = JSON.parse(readFileSync(file, "utf8"));
    let examined = 0, red = 0, yellow = 0;
    const projects = Object.values<any>(d.projects ?? {});
    for (const p of projects) {
      examined += Number(p.examined) || 0;
      red += Number(p.counts?.RED) || 0;
      yellow += Number(p.counts?.YELLOW) || 0;
    }
    return {
      value: { file, date: String(d.date ?? f.slice(7, 17)), examined, red, yellow, projects: projects.length, unmeasured: Object.keys(d.unmeasured ?? {}) },
      source: { status: "ok", label: file },
    };
  } catch (e) {
    return { value: null, source: { status: "could-not-read", label: file, detail: (e as Error).message } };
  }
}

// ── The dated health figures (#81): each says what date it is of ──────────────────────────

/** The newest of some ISO dates; unparseable or missing ones are skipped. null when none parse. */
export function newestDate(dates: (string | null | undefined)[]): string | null {
  let best: string | null = null;
  for (const d of dates) {
    if (!d || Number.isNaN(Date.parse(d))) continue;
    if (!best || Date.parse(d) > Date.parse(best)) best = d;
  }
  return best;
}

/** New and allowed rule breaks, dated by the newest commit measured (`measuredOf`). */
export function structureMetrics(a: {
  source: HomeSource;
  reading: boolean;
  newBreaks: number;
  allowed: number;
  measured: number;
  measuredOf: string | null;
}): HomeMetric[] {
  const src = a.source.detail ? `${a.source.label}: ${a.source.detail}` : a.source.label;
  return [
    {
      id: "new-breaks",
      label: "New rule breaks",
      state: a.source.status === "ok" ? (a.newBreaks > 0 ? "bad" : "ok") : a.source.status === "none" ? "ok" : "unknown",
      value: a.source.status === "ok" || a.source.status === "partial" ? String(a.newBreaks) : a.reading ? "still measuring" : "not measured",
      note: a.source.status === "none" ? "No project has a design, so nothing is checked." : "Imports added since the baseline that the design does not allow.",
      source: src,
      asOf: a.measuredOf,
    },
    {
      id: "allowed-breaks",
      label: "Allowed rule breaks",
      state: a.measured ? "ok" : "unknown",
      value: a.measured ? String(a.allowed) : a.reading ? "still measuring" : "not measured",
      note: "Known imports the design does not allow yet, kept in the baseline until fixed.",
      source: src,
      asOf: a.measuredOf,
    },
  ];
}

/**
 * Reads of a child's output cut short (#257): how many times, since this server started, a process exited and its
 * output never ended, so the wait gave up (server/child-output.ts). Said every time, 0 included, with when counting
 * began, so silence can't read as "not measured".
 */
export function childReadsMetric(lost = lostOutputEnds(), since = countingSince): HomeMetric {
  return {
    id: "child-reads",
    label: "Reads cut short",
    state: lost > 0 ? "warn" : "ok",
    value: String(lost),
    note:
      lost === 0
        ? `No process's output has been cut short since this server started (${since.slice(0, 16).replace("T", " ")} UTC).`
        : `${lost} time${lost === 1 ? "" : "s"} since this server started (${since.slice(0, 16).replace("T", " ")} UTC), a process exited but its output never ended, so AnviDeck stopped waiting. Plain text from such a run was reported as a failed read, never as a shorter answer; JSON was used only if it parsed. Each one is a [child] line in the server's log.`,
    source: "server/child-output.ts, counted in this server process",
  };
}

/** The figures Home's health line is built from, each naming its source; "sources" is added once they are all read. */
export function healthMetrics(structure: Parameters<typeof structureMetrics>[0], notes: Parameters<typeof notesMetric>[0], now: number): HomeMetric[] {
  return [...structureMetrics(structure), notesMetric(notes, now), childReadsMetric()];
}

/** Out-of-date notes, dated by the snapshot it comes from. */
export function notesMetric(notes: { value: NotesCurrency | null; source: HomeSource }, now: number): HomeMetric {
  const n = notes.value;
  const stale = n ? n.red + n.yellow : 0;
  return {
    id: "notes",
    label: "Out-of-date notes",
    state: n ? (stale > 0 ? "warn" : "ok") : "unknown",
    value: n ? `${stale.toLocaleString("en-US")} of ${n.examined.toLocaleString("en-US")}` : notes.source.status === "none" ? "no snapshot" : "could not read",
    note: n
      ? `Snapshot of ${n.date} (UTC), ${Math.round((now - Date.parse(n.date)) / 86400000)} days old: ${n.yellow.toLocaleString("en-US")} point at code that changed since checked, ${n.red} at files that are gone. ${n.projects} projects${n.unmeasured.length ? `; not measured: ${n.unmeasured.join(", ")}` : ""}.`
      : notes.source.detail ?? "",
    source: notes.source.label,
    asOf: n ? n.date : null,
  };
}

// ── The queue, ordered ────────────────────────────────────────────────────────────────────

const KIND_ORDER: Record<QueueItem["kind"], number> = { "agent-waiting": 0, "rule-break": 1, "pr-review": 2 };

/**
 * Soonest first. No source records a deadline, so: agents blocked right now, then new rule
 * breaks, then PRs; within a kind, whatever has waited longest comes first.
 */
export function orderQueue(items: QueueItem[]): QueueItem[] {
  return [...items].sort(
    (a, b) =>
      (a.dueBy ?? "￿").localeCompare(b.dueBy ?? "￿") ||
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      (a.since ?? Infinity) - (b.since ?? Infinity) ||
      a.id.localeCompare(b.id)
  );
}

/**
 * PRs that could not be checked, one row per distinct reason: when gh is missing or logged
 * out, every PR fails the same way, and 50 identical rows would bury the rest of the page.
 */
export function groupFailedPrs(failed: { key: string; reason: string }[]): UnreadItem[] {
  const byReason = new Map<string, string[]>();
  for (const f of failed) byReason.set(f.reason, [...(byReason.get(f.reason) ?? []), f.key]);
  return [...byReason].map(([reason, keys]) => ({
    id: `pr-unread:${reason}`,
    what: keys.length === 1 ? `Could not check PR ${keys[0]}` : `Could not check ${keys.length} PRs`,
    source: `gh pr view: ${reason}${keys.length > 1 ? ` (${keys.slice(0, 3).join(", ")}${keys.length > 3 ? ` and ${keys.length - 3} more` : ""})` : ""}`,
  }));
}

function ago(ms: number, now: number): string {
  const m = Math.max(0, Math.round((now - ms) / 60000));
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;
}

// ── Build ─────────────────────────────────────────────────────────────────────────────────

/**
 * How long Home waits for its slow sources (structure guard, gh). Bun closes a request that
 * has not answered in 10 s; a cold load on a busy machine took longer than that (#61).
 */
export const HOME_BUDGET_MS = 5000;

export const STILL_READING = Symbol("still reading");
/** How long a Home read waits for the open-PR search before asking about each linked PR (#46). */
const SEARCH_WAIT_MS = 300;
export type Deadline = { at: Promise<typeof STILL_READING>; cancel: () => void };

/** One deadline shared by every slow read of a load. */
export function deadlineIn(ms: number): Deadline {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const at = new Promise<typeof STILL_READING>((r) => (timer = setTimeout(() => r(STILL_READING), ms)));
  return { at, cancel: () => clearTimeout(timer) };
}

/**
 * The read's answer, or STILL_READING if the deadline came first. The read keeps running and
 * fills its cache, so a later load gets the answer.
 */
export function byDeadline<T>(p: Promise<T>, d: Deadline): Promise<T | typeof STILL_READING> {
  return Promise.race([p, d.at]);
}

/**
 * The live sessions that are terminal sessions: every one but those whose id is an AnviDeck
 * agent's in the registry (#252). An unreadable registry leaves them all in, and says so.
 */
export function terminalSessions<S extends { sessionId: string }>(sessions: S[], registry: RegistryRead): { terminals: S[]; agentSessions: number; registryNote: string | null } {
  if (registry.status === "unreadable")
    return { terminals: sessions, agentSessions: 0, registryNote: `AnviDeck's agent registry could not be read (${registry.reason}), so its agents' sessions are counted as terminal sessions too` };
  const ids = new Set(registry.agents.map((a) => a.sessionId).filter((x): x is string => !!x));
  const terminals = sessions.filter((s) => !ids.has(s.sessionId));
  return { terminals, agentSessions: sessions.length - terminals.length, registryNote: null };
}

export async function readHome(budgetMs = HOME_BUDGET_MS): Promise<HomeResponse> {
  const t0 = performance.now();
  const now = Date.now();
  const deadline = deadlineIn(budgetMs);
  const timings: Record<string, number> = {};
  const queue: QueueItem[] = [];
  const unread: UnreadItem[] = [];

  // Live sessions
  const { sessions, report } = readLiveSessionsReport();
  // An AnviDeck agent is a live Claude Code session too. Home shows it as the agent (its card and
  // permission requests come from the agent host), so here it is not a terminal session (#252).
  // Its transcript is still scanned for PR links below. If the registry cannot be read, every
  // session stays a terminal session: counted twice rather than not at all.
  const { terminals, agentSessions, registryNote } = terminalSessions(sessions, readAgentRegistry());
  timings.sessions = Math.round(performance.now() - t0);
  const sessionsSource: HomeSource = {
    status: report.status === "unreadable" ? "could-not-read" : report.status === "partial" ? "partial" : sessions.length ? "ok" : "none",
    label: `~/.claude/sessions (${sessions.length} live${agentSessions ? `, ${agentSessions} of them AnviDeck agents, shown as agents` : ""})`,
    ...(report.errors.length || registryNote ? { detail: [...report.errors, ...(registryNote ? [registryNote] : [])].join("; ") } : {}),
  };
  for (const s of terminals) {
    if (s.status !== "waiting") continue;
    queue.push({
      kind: "agent-waiting",
      id: `agent:${s.sessionId}`,
      what: `${s.project} agent is waiting for you`,
      why: `${s.name} reports “${s.waitingFor ?? "waiting"}” and has been waiting ${ago(s.updatedAt, now)}.`,
      dueBy: null,
      since: s.updatedAt || null,
      action: { label: "Copy cd", copy: `cd ${s.cwd}` },
      source: `~/.claude/sessions/${s.pid}.json: status "waiting"`,
    });
  }

  // Structure: run the guard measurements and the PR scan at the same time.
  const tStruct = performance.now();
  const structureP = (async () => {
    const list = listStructure();
    if (list.status !== "ok") return { list, results: [] as Awaited<ReturnType<typeof readStructure>>[] };
    const withDesign = list.projects.filter((p) => p.hasDesign);
    const results = await Promise.all(withDesign.map((p) => readStructure(p.name)));
    return { list, results };
  })().finally(() => (timings.structure = Math.round(performance.now() - tStruct)));
  const tSearch = performance.now();
  const searchP = searchAuthoredPrs().finally(() => (timings.search = Math.round(performance.now() - tSearch)));

  // PRs linked by live sessions
  const tPr = performance.now();
  const links = new Map<string, { link: PrLink; sessions: LiveSession[] }>();
  let scanned = 0;
  const scanErrors: string[] = [];
  for (const s of sessions) {
    const t = transcriptOf(s);
    if (!t) continue;
    try {
      for (const l of prLinksIn(t)) {
        const k = `${l.repo}#${l.number}`;
        const e = links.get(k);
        if (e) {
          e.sessions.push(s);
          e.link.first = Math.min(e.link.first, l.first);
        } else links.set(k, { link: { ...l }, sessions: [s] });
      }
      scanned++;
    } catch (e) {
      scanErrors.push(`${t}: ${(e as Error).message}`);
    }
  }
  timings.transcripts = Math.round(performance.now() - tPr);
  const entries = [...links.values()];
  // The search is cached after the first read; when it is ready, it answers for the linked
  // PRs it lists and only the rest are asked one by one. Not ready: ask them all, as before,
  // rather than wait for it and leave the PR reads less of the budget (#46).
  const searchWait = deadlineIn(SEARCH_WAIT_MS);
  const early = await byDeadline(searchP, searchWait);
  searchWait.cancel();
  const fromSearch = answersFromSearch(
    entries.map((e) => `${e.link.repo}#${e.link.number}`),
    early === STILL_READING ? null : early
  );
  const searchedAgo = early !== STILL_READING && early.ok ? ago(early.at, now) : "";
  type ViewAnswer = Awaited<ReturnType<typeof ghPrView>> | { ok: true; out: string; err: string; cached: boolean; search: true };
  const answers = await Promise.all(
    entries.map((e): Promise<ViewAnswer | typeof STILL_READING> => {
      const a = fromSearch.get(`${e.link.repo}#${e.link.number}`);
      return a ? Promise.resolve({ ok: true, out: JSON.stringify(a), err: "", cached: false, search: true }) : byDeadline(ghPrView(e.link.number, e.link.repo), deadline);
    })
  );
  timings.github = Math.round(performance.now() - tPr) - timings.transcripts;
  const tally = { review: 0, draft: 0, merged: 0, closed: 0, other: 0, failed: 0, cached: 0, reading: 0, search: 0 };
  const openBySession = new Map<string, number[]>();
  const failedPrs: { key: string; reason: string }[] = [];
  entries.forEach((e, i) => {
    const r = answers[i];
    if (r === STILL_READING) {
      tally.reading++;
      return;
    }
    if (r.cached) tally.cached++;
    const viaSearch = "search" in r;
    if (viaSearch) tally.search++;
    const key = `${e.link.repo}#${e.link.number}`;
    let a: PrAnswer | null = null;
    if (r.ok) {
      try {
        const j = JSON.parse(r.out);
        a = { state: String(j.state ?? ""), isDraft: !!j.isDraft, title: String(j.title ?? ""), url: j.url ?? e.link.url };
      } catch {
        a = null;
      }
    }
    if (!a) {
      tally.failed++;
      failedPrs.push({ key, reason: (r.err || "unparseable answer").slice(0, 160) });
      return;
    }
    const v = prVerdict(a);
    tally[v]++;
    if (v !== "review") return;
    for (const s of e.sessions) openBySession.set(s.sessionId, [...(openBySession.get(s.sessionId) ?? []), e.link.number]);
    const by = e.sessions.map((s) => s.name).join(", ");
    queue.push({
      kind: "pr-review",
      id: `pr:${key}`,
      what: `Review PR #${e.link.number}${a.title ? `: ${a.title}` : ""}`,
      why: `Open and not a draft in ${e.link.repo}. First linked by the live session ${by} ${ago(e.link.first, now)} ago.`,
      dueBy: null,
      since: e.link.first || null,
      action: { label: "Open on GitHub", href: a.url ?? `https://github.com/${e.link.repo}/pull/${e.link.number}` },
      source: `pr-link in ${e.sessions.length === 1 ? "this session's transcript" : `${e.sessions.length} transcripts`} + ${
        viaSearch ? `gh search prs (open, not a draft; searched ${searchedAgo} ago)` : "gh pr view (state OPEN, not a draft)"
      }`,
    });
  });
  unread.push(...groupFailedPrs(failedPrs));
  if (tally.reading) {
    unread.push({
      id: "pr-reading",
      what: `Still asking GitHub about ${tally.reading} PR(s) linked by live sessions; the next refresh shows them`,
      source: `gh pr view: no answer within ${budgetMs / 1000} s`,
      reading: true,
    });
  }

  // Open PRs you authored that no live session links: their session has ended, or they
  // were opened outside Claude.
  const searched = await byDeadline(searchP, deadline);
  const search: SearchAnswer | null = searched === STILL_READING ? null : searched;
  let olderPrs: OlderPr[] = [];
  let searchDetail: string;
  if (!search) {
    unread.push({
      id: "pr-search",
      what: "Still searching GitHub for your open PRs; the next refresh shows them",
      source: `gh search prs: no answer within ${budgetMs / 1000} s`,
      reading: true,
    });
    searchDetail = `gh search prs had not answered within ${budgetMs / 1000} s, so PRs from sessions that have ended are not shown yet.`;
  } else if (search.ok) {
    const split = splitAuthoredPrs(search.prs, new Set(links.keys()), now);
    for (const p of split.recent) {
      queue.push({
        kind: "pr-review",
        id: `pr:${p.key}`,
        what: `Review PR #${p.number}${p.title ? `: ${p.title}` : ""}`,
        why: `Open and not a draft in ${p.repo}, opened ${ago(p.createdAt, now)} ago, last updated ${ago(p.updatedAt, now)} ago. No live session links it: its session has ended, or it was opened outside Claude.`,
        dueBy: null,
        since: p.createdAt || null,
        action: { label: "Open on GitHub", href: p.url },
        source: "gh search prs --author=@me --state=open",
      });
    }
    olderPrs = split.older.map((p) => ({ key: p.key, number: p.number, repo: p.repo, title: p.title, url: p.url, updatedAt: new Date(p.updatedAt).toISOString() }));
    const n = search.prs.length;
    searchDetail =
      `gh search found ${n >= SEARCH_LIMIT ? `at least ${n}` : n} open PR(s) you authored` +
      ` (searched ${ago(search.at, now)} ago): ${split.alreadyLinked} linked by a live session, ${split.recent.length} added to the queue,` +
      ` ${split.older.length} not updated in ${RECENT_DAYS} days listed apart, ${split.drafts} draft(s).`;
    if (search.refreshFailed) {
      unread.push({
        id: "pr-search",
        what: `Could not refresh the search of GitHub for your open PRs; showing the answer from ${ago(search.at, now)} ago`,
        source: `gh search prs: ${search.refreshFailed.err}`,
      });
      searchDetail += ` The latest refresh failed (${search.refreshFailed.err}), so PRs opened or closed since then are not shown.`;
    }
  } else {
    unread.push({ id: "pr-search", what: "Could not search GitHub for your open PRs", source: `gh search prs: ${search.err}` });
    searchDetail = `gh search prs could not be read (${search.err}), so PRs from sessions that have ended are missing.`;
  }

  const prsSource: HomeSource = {
    status:
      !search || tally.reading ? "reading"
      : !search.ok && tally.failed === entries.length ? "could-not-read"
      : !search.ok || search.refreshFailed || tally.failed || scanErrors.length ? "partial"
      : entries.length === 0 && search.prs.length === 0 ? "none" : "ok",
    label: `PR links in ${scanned} of ${sessions.length} live transcripts, checked with gh pr view · open PRs you authored, from gh search`,
    detail:
      `${entries.length} linked: ${tally.review} open for review, ${tally.draft} draft, ${tally.merged} merged, ${tally.closed} closed` +
      (tally.other ? `, ${tally.other} other` : "") +
      (tally.failed ? `, ${tally.failed} could not be checked` : "") +
      (tally.reading ? `, ${tally.reading} still being read` : "") +
      (tally.search ? `; ${tally.search} judged from the open-PR search, not asked one by one` : "") +
      (tally.cached ? `; ${tally.cached} answers from cache` : "") +
      (scanErrors.length ? `; ${scanErrors.length} transcript(s) unreadable` : "") +
      `. ${searchDetail}`,
  };

  // Structure results
  const structured = await byDeadline(structureP, deadline);
  deadline.cancel();
  const structureReading = structured === STILL_READING;
  const { list, results } = structureReading ? { list: null, results: [] } : structured;
  let newBreaks = 0, allowed = 0, measured = 0;
  let measuredOf: string | null = null;
  const notMeasured: string[] = [];
  const measuredLines: string[] = [];
  for (const r of results) {
    if (r.status === "measured") {
      measured++;
      measuredOf = newestDate([measuredOf, r.measuredAt.date]);
      const nNew = r.counts.divergence.new + r.counts.cycle.new;
      newBreaks += nNew;
      allowed += r.counts.divergence.grandfathered + r.counts.cycle.grandfathered;
      const at = `${r.measuredAt.ref} ${r.measuredAt.sha.slice(0, 7)}`;
      measuredLines.push(`${r.project}: ${nNew} new, ${r.counts.divergence.grandfathered + r.counts.cycle.grandfathered} allowed at ${at}`);
      if (nNew > 0) {
        const keys = [...r.rules.divergence.new, ...r.rules.cycle.new].map((k: unknown) => (typeof k === "string" ? k : JSON.stringify(k)));
        queue.push({
          kind: "rule-break",
          id: `rules:${r.project}`,
          what: `${r.project} has ${nNew} new rule break${nNew > 1 ? "s" : ""}`,
          why: `Imports its design does not allow: ${keys.slice(0, 2).join("; ")}${keys.length > 2 ? ` and ${keys.length - 2} more` : ""}.`,
          dueBy: null,
          since: (r.measuredAt.date && Date.parse(r.measuredAt.date)) || null,
          action: { label: "Copy cd", copy: `cd ${list?.projects.find((p) => p.name === r.project)?.path ?? r.project}` },
          source: `structure guard at ${at}`,
        });
      }
    } else if (r.status !== "no-design") {
      notMeasured.push(`${r.project}: ${r.reason}`);
      unread.push({ id: `rules:${r.project}`, what: `Could not measure ${r.project}'s structure`, source: `structure guard: ${r.reason.slice(0, 160)}` });
    }
  }
  if (structureReading) {
    unread.push({
      id: "rules-reading",
      what: "Still measuring structure; the next refresh shows rule breaks",
      source: `structure guard: no answer within ${budgetMs / 1000} s`,
      reading: true,
    });
  }
  const structureSource: HomeSource =
    !list
      ? { status: "reading", label: "structure guard", detail: `still measuring after ${budgetMs / 1000} s; the next refresh shows the result` }
      : list.status !== "ok"
      ? { status: "could-not-read", label: "structure guard registry", detail: list.reason }
      : results.length === 0
        ? { status: "none", label: "structure guard registry", detail: "no project has a design" }
        : {
            status: measured === results.length ? "ok" : measured ? "partial" : "not-measured",
            label: `structure guard, ${measured} of ${results.length} project(s) with a design measured`,
            detail: [...measuredLines, ...notMeasured].join("; "),
          };

  // Notes currency
  const notes = readNotesCurrency();

  // Metrics, each naming its source.
  const metrics = healthMetrics({ source: structureSource, reading: structureReading, newBreaks, allowed, measured, measuredOf }, notes, now);
  const sourceList = { sessions: sessionsSource, prs: prsSource, structure: structureSource, notes: notes.source };
  const unreadable = Object.entries(sourceList).filter(([, s]) => s.status === "could-not-read" || s.status === "partial" || s.status === "not-measured" || s.status === "reading");
  metrics.push({
    id: "sources",
    label: "Sources read",
    state: unreadable.length ? "warn" : "ok",
    value: `${4 - unreadable.length} of 4`,
    note: unreadable.length ? `Not fully read: ${unreadable.map(([k, s]) => `${k} (${s.status})`).join(", ")}.` : "Live sessions, PRs, structure and notes all answered.",
    source: "this page's four sources, listed under Sources",
  });

  // Agents, one line each
  const agents: HomeAgent[] = terminals.map((s) => ({
    sessionId: s.sessionId,
    name: s.name,
    project: s.project,
    cwd: s.cwd,
    branch: s.branch,
    status: s.status,
    ...(s.waitingFor ? { waitingFor: s.waitingFor } : {}),
    updatedAt: s.updatedAt,
    openPrs: openBySession.get(s.sessionId) ?? [],
  }));

  timings.total = Math.round(performance.now() - t0);
  return { generatedAt: new Date(now).toISOString(), queue: orderQueue(queue), unread, olderPrs, metrics, agents, sources: sourceList, timings };
}
