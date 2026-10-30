/**
 * Agents view (issue #17) — one project's Claude Code sessions, read-only.
 *
 * Centre: the chosen project's sessions as a tab row, and the selected
 * session's steps. Right panel: Session · Changes · Notes used.
 *
 * Data: GET /api/replay/sessions, GET /api/replay/session/:sid (issue #15) and
 * GET /api/sessions (live status). Nothing here acts on an agent: anything that
 * would act is a deep link (PR, issue) or a copyable `cd <path>`.
 *
 * Rules the screen keeps:
 *   - every step, file and figure names where it is known from;
 *   - "could not read" never looks like "nothing found";
 *   - times are printed in UTC, as the API returns them;
 *   - signals the data does not carry (deadline) are named as unavailable,
 *     never invented.
 */
import type {
  ChangedFile,
  NoteUsed,
  PrInfo,
  ReadStatus,
  ReplayResponse,
  ReplaySessionSummary,
  ReplaySessionsResponse,
  ReplayStep,
} from "../../shared/replay-types";
import type { LiveSession } from "../../shared/types";

export type AgentsTab = "session" | "changes" | "notes";
export type AgentsScope = "one" | "all";

/** What `#agents?…` can carry. All optional. */
export interface AgentsRoute {
  project?: string;
  sid?: string;
  from?: string;
  to?: string;
  tab?: AgentsTab;
  scope?: AgentsScope;
}

type Load<T> = { status: "loading" } | { status: "ok"; data: T } | { status: "error"; error: string };

/** How many sessions the "All in <project>" switch reads at most. */
const ALL_SCOPE_MAX = 8;
/** How many sessions the tab row shows besides running ones and the selected one. */
const TAB_ROW_RECENT = 8;

const S = {
  project: null as string | null,
  sid: null as string | null,
  from: null as string | null,
  to: null as string | null,
  tab: "session" as AgentsTab,
  scope: "one" as AgentsScope,
  openNote: null as number | null,
  lists: new Map<string, Load<ReplaySessionsResponse>>(),
  live: { status: "loading" } as Load<LiveSession[]>,
  replays: new Map<string, Load<ReplayResponse>>(),
  projectNames: [] as string[],
};

let root: HTMLElement | null = null;
let liveRequested = false;

// ── helpers ───────────────────────────────────────────────────────────────

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** "2026-10-30 09:14:50 UTC". The API's times are UTC; we print them as such. */
function utc(ts: string | null | undefined): string {
  if (!ts) return "no time";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return esc(ts);
  return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, "").replace(/Z$/, "") + " UTC";
}

/** "10-30 09:14:50" for dense rows under a "UTC" column heading. */
function utcShort(ts: string | null | undefined): string {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return esc(ts);
  return d.toISOString().slice(5, 19).replace("T", " ");
}

/** Exact byte counts, so a note's size and its meter row can be compared. */
function bytes(n: number): string {
  return `${n.toLocaleString("en-US")} bytes`;
}

const HOME_RE = /^\/Users\/[^/]+\//;
function shortPath(p: string): string {
  return p.replace(HOME_RE, "~/");
}

/** The end of a path is what tells files apart; keep the last parts, full path in the title. */
function tailPath(p: string, keep = 4): string {
  const parts = shortPath(p).split("/");
  return parts.length > keep + 1 ? `…/${parts.slice(-keep).join("/")}` : shortPath(p);
}

function shortSid(sid: string): string {
  return sid.slice(0, 8);
}

function prUrl(repo: string, n: number): string {
  return `https://github.com/${repo}/pull/${n}`;
}

function isCouldNotRead(s: ReadStatus): boolean {
  return s === "not-found" || s === "unreadable";
}

/**
 * One status line per source. "Could not read" and "nothing found" are
 * different words AND a different look (class), never the same blank.
 */
function statusBlock(status: ReadStatus, detail: string | undefined, nothingTitle: string): string {
  if (isCouldNotRead(status)) {
    return `<div class="ag-state ag-cnr" role="status"><b>Could not read</b>${detail ? ` · ${esc(detail)}` : ""}</div>`;
  }
  if (status === "skipped") {
    return `<div class="ag-state ag-skip" role="status"><b>Not checked</b>${detail ? ` · ${esc(detail)}` : ""}</div>`;
  }
  if (status === "none") {
    return `<div class="ag-state ag-none" role="status"><b>${esc(nothingTitle)}</b>${detail ? ` · ${esc(detail)}` : ""}</div>`;
  }
  return "";
}

function srcTag(label: string, title?: string): string {
  return `<span class="ag-src"${title ? ` title="${esc(title)}"` : ""}>${esc(label)}</span>`;
}

function windowKey(sid: string, from: string | null, to: string | null): string {
  return `${sid}|${from ?? ""}|${to ?? ""}`;
}

function windowText(): string {
  if (!S.from && !S.to) return "whole session";
  return `${S.from ? utc(S.from) : "start"} – ${S.to ? utc(S.to) : "end"}`;
}

// ── data ──────────────────────────────────────────────────────────────────

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const b = await res.json();
      if (b?.error) msg += ` · ${b.error}`;
    } catch {}
    throw new Error(msg);
  }
  return res.json();
}

function loadList(project: string): void {
  if (S.lists.has(project)) return;
  S.lists.set(project, { status: "loading" });
  getJson<ReplaySessionsResponse>(`/api/replay/sessions?project=${encodeURIComponent(project)}`)
    .then((data) => S.lists.set(project, { status: "ok", data }))
    .catch((e) => S.lists.set(project, { status: "error", error: String(e?.message ?? e) }))
    .finally(paint);
}

/** When live status was last read (ISO, UTC); printed beside the ranking. */
let liveReadAt: string | null = null;

/** Read live status. Called each time the view opens, so a revisit is not stale. */
function loadLive(): void {
  if (liveRequested) return;
  liveRequested = true;
  getJson<LiveSession[]>("/api/sessions")
    .then((data) => (S.live = { status: "ok", data }))
    .catch((e) => (S.live = { status: "error", error: String(e?.message ?? e) }))
    .finally(() => {
      liveRequested = false;
      liveReadAt = new Date().toISOString();
      paint();
    });
}

const queue: (() => Promise<void>)[] = [];
let running = 0;
function pump(): void {
  while (running < 2 && queue.length) {
    const job = queue.shift()!;
    running++;
    job().finally(() => {
      running--;
      pump();
    });
  }
}

function loadReplay(sid: string, from: string | null, to: string | null): Load<ReplayResponse> {
  const key = windowKey(sid, from, to);
  const have = S.replays.get(key);
  if (have) return have;
  const pending: Load<ReplayResponse> = { status: "loading" };
  S.replays.set(key, pending);
  const qs = new URLSearchParams();
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  queue.push(() =>
    getJson<ReplayResponse>(`/api/replay/session/${encodeURIComponent(sid)}${qs.toString() ? `?${qs}` : ""}`)
      .then((data) => void S.replays.set(key, { status: "ok", data }))
      .catch((e) => void S.replays.set(key, { status: "error", error: String(e?.message ?? e) }))
      .finally(paint)
  );
  pump();
  return pending;
}

function liveBySid(): Map<string, LiveSession> {
  const m = new Map<string, LiveSession>();
  if (S.live.status === "ok") for (const l of S.live.data) m.set(l.sessionId, l);
  return m;
}

// ── urgency ───────────────────────────────────────────────────────────────

interface Ranked {
  s: ReplaySessionSummary;
  live?: LiveSession;
  tier: number;
  dot: "warn" | "info" | "ok" | "idle" | "off";
  label: string;
  why: string;
}

/** Open PRs this session linked, from its unwindowed replay if we have it. */
function openPrsFor(sid: string): PrInfo[] | null {
  const r = S.replays.get(windowKey(sid, null, null));
  if (!r || r.status !== "ok") return null;
  return r.data.prs.filter((p) => p.state === "OPEN");
}

/**
 * Ranked only by signals the data carries:
 *   0 waiting on you   live status "waiting" (~/.claude/sessions)
 *   1 ready for review a PR the session linked is open (gh pr view), and it is not busy
 *   2 working          live status "busy"
 *   3 running          any other live status (idle, shell…)
 *   4 not running      not in the live list; newest activity first
 * Deadline is not ranked: no source records one.
 */
function rank(sessions: ReplaySessionSummary[]): Ranked[] {
  const live = liveBySid();
  const out = sessions.map((s): Ranked => {
    const l = live.get(s.sessionId);
    const st = l?.status.toLowerCase();
    const open = openPrsFor(s.sessionId);
    if (st === "waiting") return { s, live: l, tier: 0, dot: "warn", label: "waiting on you", why: "live status: waiting" };
    if (open && open.length && st !== "busy")
      return {
        s,
        live: l,
        tier: 1,
        dot: "info",
        label: "ready for review",
        why: `open PR ${open.map((p) => `#${p.number}`).join(", ")} (GitHub)`,
      };
    if (st === "busy") return { s, live: l, tier: 2, dot: "ok", label: "working", why: "live status: busy" };
    if (l) return { s, live: l, tier: 3, dot: "idle", label: `running · ${l.status}`, why: `live status: ${l.status}` };
    return { s, tier: 4, dot: "off", label: "not running", why: `last activity ${utc(s.lastTs ?? s.modifiedAt)} (transcript)` };
  });
  const t = (r: Ranked) => Date.parse(r.s.lastTs ?? r.s.modifiedAt) || 0;
  return out.sort((a, b) => a.tier - b.tier || t(b) - t(a));
}

function sessionName(r: { s: ReplaySessionSummary; live?: LiveSession }): string {
  return r.live?.name ?? shortSid(r.s.sessionId);
}

// ── derived facts (labelled as derived) ───────────────────────────────────

interface Derived {
  branches: { name: string; from: string }[];
  worktrees: { path: string; from: string }[];
  issues: { n: number; from: string; repo?: string }[];
}

const BRANCH_RES = [
  /\bgit\s+worktree\s+add\b[^&|;\n]*?\s-[bB]\s+(\S+)/,
  /\bgit\s+(?:checkout|switch)\s+-[bcBC]\s+(\S+)/,
];

function worktreeAddPath(cmd: string): string | null {
  const m = cmd.match(/\bgit\s+worktree\s+add\b([^&|;\n]*)/);
  if (!m) return null;
  const toks = m[1].trim().split(/\s+/);
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (/^-[bB]$/.test(t) || t === "--reason") {
      i++;
      continue;
    }
    if (t.startsWith("-")) continue;
    return t;
  }
  return null;
}

function issueFromBranch(b: string): number | null {
  const m = b.match(/^(?:[\w.-]+\/)?(\d+)[-_]/);
  return m ? Number(m[1]) : null;
}

function derive(r: ReplayResponse | null, live?: LiveSession): Derived {
  const d: Derived = { branches: [], worktrees: [], issues: [] };
  const repo = r?.prs[0]?.repo;
  const addBranch = (name: string, from: string, guessIssue = true) => {
    if (d.branches.some((b) => b.name === name)) return;
    d.branches.push({ name, from });
    const n = guessIssue ? issueFromBranch(name) : null;
    if (n && !d.issues.some((i) => i.n === n)) d.issues.push({ n, from: `guessed from branch name ${name}`, repo });
  };
  for (const st of r?.steps ?? []) {
    if (!st.command) continue;
    for (const re of BRANCH_RES) {
      const m = st.command.match(re);
      if (m) addBranch(m[1], `transcript, ${utc(st.ts)}`);
    }
    const p = worktreeAddPath(st.command);
    if (p && !d.worktrees.some((w) => w.path === p)) d.worktrees.push({ path: p, from: `transcript, git worktree add at ${utc(st.ts)}` });
  }
  // The folder's branch now may be other work: guess an issue from it only
  // when the transcript itself created no branch.
  if (live?.branch) addBranch(live.branch, "live session: branch of its folder now", d.branches.length === 0);
  return d;
}

// ── hash ──────────────────────────────────────────────────────────────────

/** Parse `#agents?project=…&sid=…&from=…&to=…&tab=…&scope=…`. */
export function parseAgentsHash(hash: string): AgentsRoute | null {
  const m = hash.match(/^#agents(?:\?(.*))?$/);
  if (!m) return null;
  const q = new URLSearchParams(m[1] ?? "");
  const r: AgentsRoute = {};
  for (const k of ["project", "sid", "from", "to"] as const) {
    const v = q.get(k);
    if (v) r[k] = v;
  }
  const tab = q.get("tab");
  if (tab === "session" || tab === "changes" || tab === "notes") r.tab = tab;
  const scope = q.get("scope");
  if (scope === "one" || scope === "all") r.scope = scope;
  return r;
}

function normTime(v: string | undefined): string | null {
  if (!v) return null;
  const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : `${v}Z`);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function writeHash(): void {
  const q = new URLSearchParams();
  if (S.project) q.set("project", S.project);
  if (S.sid) q.set("sid", S.sid);
  if (S.from) q.set("from", S.from);
  if (S.to) q.set("to", S.to);
  if (S.tab !== "session") q.set("tab", S.tab);
  if (S.scope !== "one") q.set("scope", S.scope);
  const h = `#agents${q.toString() ? `?${q}` : ""}`;
  if (location.hash !== h) history.replaceState(null, "", h);
}

// ── render: centre ────────────────────────────────────────────────────────

function projectPicker(): string {
  const live = S.live.status === "ok" ? S.live.data : [];
  const running = new Set(live.map((l) => l.project));
  const names = [...new Set(S.projectNames)];
  const real = names.filter((n) => !n.startsWith("-")).sort((a, b) => a.localeCompare(b));
  const odd = names.filter((n) => n.startsWith("-")).sort();
  const opt = (n: string) => `<option value="${esc(n)}"${n === S.project ? " selected" : ""}>${esc(n)}</option>`;
  const withRun = real.filter((n) => running.has(n));
  const rest = real.filter((n) => !running.has(n));
  const extra = S.project && !names.includes(S.project) ? opt(S.project) : "";
  return `<label class="ag-picker">Project
    <select data-act="project" aria-label="Project">
      ${S.project ? "" : `<option value="" selected>Choose a project…</option>`}
      ${extra}
      ${withRun.length ? `<optgroup label="Has a running session">${withRun.map(opt).join("")}</optgroup>` : ""}
      <optgroup label="All projects">${rest.map(opt).join("")}</optgroup>
      ${odd.length ? `<optgroup label="Temporary folders">${odd.map(opt).join("")}</optgroup>` : ""}
    </select></label>`;
}

function windowControls(): string {
  const v = (iso: string | null) => (iso ? iso.slice(0, 16) : "");
  return `<form class="ag-window" data-act="window">
    <span class="ag-k">Window (UTC)</span>
    <input type="datetime-local" name="from" value="${v(S.from)}" aria-label="From, UTC">
    <span>–</span>
    <input type="datetime-local" name="to" value="${v(S.to)}" aria-label="To, UTC">
    <button type="submit" class="ag-btn">Apply</button>
    ${S.from || S.to ? `<button type="button" class="ag-btn" data-act="clear-window">Whole session</button>` : ""}
  </form>`;
}

function tabRow(ranked: Ranked[], total: number): string {
  const pick: Ranked[] = [];
  for (const r of ranked) if (r.live || r.s.sessionId === S.sid) pick.push(r);
  for (const r of ranked) {
    if (pick.length >= TAB_ROW_RECENT + ranked.filter((x) => x.live).length) break;
    if (!pick.includes(r)) pick.push(r);
  }
  const ordered = ranked.filter((r) => pick.includes(r));
  const outsider = S.sid && !ranked.some((r) => r.s.sessionId === S.sid);
  const tabs = ordered
    .map(
      (r) => `<button type="button" class="ag-stab${r.s.sessionId === S.sid ? " on" : ""}" data-sid="${esc(r.s.sessionId)}" title="${esc(r.label)} · ${esc(r.why)}">
        <span class="ag-dot ${r.dot}"></span>${esc(sessionName(r))}<span class="ag-stab-sub">${esc(r.label)}</span></button>`
    )
    .join("");
  const out = outsider
    ? `<button type="button" class="ag-stab on" data-sid="${esc(S.sid!)}" title="from the link; not in this project's session list"><span class="ag-dot off"></span><span class="mono">${esc(shortSid(S.sid!))}</span><span class="ag-stab-sub">not in ${esc(S.project ?? "")}'s list</span></button>`
    : "";
  return `<div class="ag-stabs" role="tablist" aria-label="${esc(S.project ?? "")} sessions">
    <span class="ag-k">${esc(S.project ?? "")} sessions</span>${tabs}${out}
  </div>
  <div class="ag-note">Showing ${ordered.length + (outsider ? 1 : 0)} of ${total} sessions (transcripts): running ones and the most recent. Every session is ranked in the Session tab.</div>`;
}

function stepWhat(st: ReplayStep, notes: Map<number, NoteUsed>): string {
  if (st.kind === "injection") {
    const id = (st.detail as any)?.noteId;
    const n = typeof id === "number" ? notes.get(id) : undefined;
    return `anvi note · ${esc(st.hookName ?? n?.hookName ?? "")}${n ? ` · ${bytes(n.size)}` : ""} ${typeof id === "number" ? `<button type="button" class="ag-link" data-note="${id}">show text</button>` : ""}`;
  }
  if (st.kind === "commit")
    return `commit <span class="mono">${esc((st.sha ?? "").slice(0, 7))}</span> · ${esc(st.subject ?? "")}`;
  if (st.kind === "pr")
    return `linked PR ${st.repo && st.pr ? `<a href="${esc(prUrl(st.repo, st.pr))}" target="_blank" rel="noopener">#${st.pr}</a>` : `#${st.pr}`}`;
  if (st.kind === "hook-run") return `hook run · ${esc(st.hookName ?? "")}`;
  const target = st.filePath ? shortPath(st.filePath) : st.command ?? "";
  const shell =
    st.mayEditFiles?.scope === "project"
      ? ` <span class="ag-chip warn" title="guessed from the command text: ${esc(st.mayEditFiles.reason)}">may edit project files · guessed (${esc(st.mayEditFiles.reason)})</span>`
      : "";
  const noted = st.noteIds?.length
    ? ` ${st.noteIds.map((id) => `<button type="button" class="ag-link" data-note="${id}">show the note it got</button>`).join(" ")}`
    : "";
  return `<b>${esc(st.tool ?? st.kind)}</b> <span class="mono ag-trunc" title="${esc(target)}">${esc(target)}</span>${shell}${noted}`;
}

const SRC_LABEL: Record<string, string> = {
  transcript: "transcript",
  "hook-meter": "hook meter",
  "hook-log": "hook log",
  commit: "commit",
  guessed: "guessed",
};

function sourcesLine(r: ReplayResponse): string {
  const t = r.transcript;
  // For the hook log and the hook meter, "not-found" means the file is simply not there (/tmp is
  // cleared on reboot; a session may predate the meter): absence, not a failure to read (#51).
  // For git it means no repository could be resolved, i.e. we could not look, so it stays red.
  const part = (name: string, st: ReadStatus, ok: string, detail?: string, absentMeansNone = false) => {
    const absent = absentMeansNone && st === "not-found";
    const cnr = isCouldNotRead(st) && !absent;
    return `<span class="ag-srcline ${cnr ? "ag-cnr-t" : st === "none" || absent ? "ag-none-t" : ""}" title="${esc(detail ?? "")}">${esc(name)}: ${
      cnr ? "could not read" : absent ? "not present" : st === "none" ? "nothing in window" : st === "skipped" ? "not checked" : ok
    }</span>`;
  };
  return `<div class="ag-srcs">
    ${part("Transcript", t.status, `${t.count ?? 0} records in window`, t.detail ?? t.path)}
    ${part("Hook meter", r.sources.hookMeter.status, `${r.sources.hookMeter.count ?? 0} rows`, r.sources.hookMeter.detail ?? r.sources.hookMeter.path, true)}
    ${part("Hook log", r.sources.hookLog.status, `${r.sources.hookLog.count ?? 0} rows`, r.sources.hookLog.detail ?? r.sources.hookLog.path, true)}
    ${part("Git", r.sources.git.status, `${r.sources.git.count ?? 0} commit${r.sources.git.count === 1 ? "" : "s"}`, r.sources.git.detail)}
    ${part("GitHub", r.sources.github.status, `${r.sources.github.count ?? 0} PRs`, r.sources.github.detail)}
  </div>`;
}

function stepsCard(load: Load<ReplayResponse>): string {
  if (load.status === "loading") return `<div class="ag-card"><div class="ag-loading">Reading this session's transcript…</div></div>`;
  if (load.status === "error") return `<div class="ag-card">${statusBlock("unreadable", `the server answered ${load.error}`, "")}</div>`;
  const r = load.data;
  if (isCouldNotRead(r.transcript.status)) {
    return `<div class="ag-card">${sourcesLine(r)}${statusBlock(r.transcript.status, r.transcript.detail ?? "transcript not found", "")}
      <div class="ag-note">Not found means the transcript is gone or the id is wrong. It does not mean the session did nothing.</div></div>`;
  }
  const notes = new Map(r.notes.items.map((n) => [n.id, n]));
  const rows = r.steps
    .map(
      (st) => `<tr class="${st.mayEditFiles?.scope === "project" ? "ag-shellrow" : ""}">
      <td class="ag-time" title="${st.placement === "neighbour" ? `no timestamp; placed at ${esc(utc(st.placedAt))} by its neighbour` : esc(utc(st.ts))}">${st.placement === "neighbour" ? "≈ " : ""}${utcShort(st.placedAt)}</td>
      <td>${stepWhat(st, notes)}</td>
      <td>${srcTag(SRC_LABEL[st.source] ?? st.source, st.line ? `transcript line ${st.line}` : undefined)}${st.mayEditFiles?.scope === "project" ? srcTag("guessed", st.mayEditFiles.reason) : ""}</td>
    </tr>`
    )
    .join("");
  const untimed = r.transcript.untimedInWindow
    ? `<div class="ag-note">${r.transcript.untimedInWindow} transcript records in this window have no timestamp; steps among them are placed by their neighbour and marked ≈.</div>`
    : "";
  return `<div class="ag-card">
    ${sourcesLine(r)}
    ${
      r.steps.length
        ? `<table class="ag-steps"><thead><tr><th>Time (UTC)</th><th>Step</th><th>Known from</th></tr></thead><tbody>${rows}</tbody></table>${untimed}`
        : statusBlock("none", "no steps in this window", "Nothing found")
    }
  </div>`;
}

function primaryAction(r: ReplayResponse | null, d: Derived): string {
  const prs = r?.prs ?? [];
  const open = prs.find((p) => p.state === "OPEN");
  const pr = open ?? prs[prs.length - 1];
  if (pr) return `<a class="ag-primary" href="${esc(prUrl(pr.repo, pr.number))}" target="_blank" rel="noopener">Open PR #${pr.number} on GitHub</a>`;
  const issue = d.issues.find((i) => i.repo);
  if (issue) return `<a class="ag-primary" href="https://github.com/${esc(issue.repo!)}/issues/${issue.n}" target="_blank" rel="noopener">Open issue #${issue.n} on GitHub</a>`;
  return "";
}

// ── render: right panel ───────────────────────────────────────────────────

function mergeLine(p: PrInfo): string {
  const m = p.merge;
  if (!m) return "";
  if (m.how === "not-merged") return "not merged";
  if (m.how === "no-hook-run") return "merged, but no merge-hook run was found near the merge (outside a Claude session?)";
  if (m.how === "unknown") return `could not tell how it was merged${m.detail ? `: ${esc(m.detail)}` : ""}`;
  const check =
    m.judgementRow === "found"
      ? `<span class="ag-chip ok">merge check recorded</span> <span class="ag-note">(judgement row found in the merge log)</span>`
      : m.judgementRow === "none"
        ? `<span class="ag-chip warn">merge check not confirmed</span> <span class="ag-note">(the merge hook ran but wrote no judgement row for this PR)</span>`
        : `<span class="ag-chip bad">could not read the merge log</span>`;
  return `merged with <span class="mono">gh pr merge</span> in Claude session <span class="mono">${esc(shortSid(m.sessionId ?? ""))}</span> at ${utc(
    m.commandAt
  )} (transcript + hook meter) · ${check}`;
}

function prBlock(p: PrInfo): string {
  const read = isCouldNotRead(p.read.status) ? ` · <span class="ag-cnr-t">could not read from GitHub: ${esc(p.read.detail ?? p.read.status)}</span>` : "";
  return `<div class="ag-pr">
    <div><a href="${esc(prUrl(p.repo, p.number))}" target="_blank" rel="noopener">PR #${p.number}</a> · ${esc(p.state ?? "state unknown")}${
      p.changedFiles != null ? ` · ${p.changedFiles} files ${srcTag("GitHub")}` : ""
    }${p.mergedAt ? ` · merged ${utc(p.mergedAt)}` : ""}${read}</div>
    <div class="ag-note">linked in the transcript ${utc(p.firstSeen)}${p.headCommittedInWindow ? " · its head commit was made by this session in the window" : ""}</div>
    ${p.merge ? `<div class="ag-merge">${mergeLine(p)}</div>` : ""}
  </div>`;
}

function copyCd(path: string): string {
  return `<div class="ag-cd"><code class="mono">cd ${esc(path)}</code><button type="button" class="ag-btn" data-copy="${esc(`cd ${path}`)}">Copy</button></div>`;
}

function sessionTab(ranked: Ranked[], sel: Ranked | undefined, load: Load<ReplayResponse> | null): string {
  const r = load?.status === "ok" ? load.data : null;
  const d = derive(r, sel?.live);
  const s = sel?.s;
  const cwd = sel?.live?.cwd ?? s?.cwd ?? null;
  let top = "";
  if (S.sid) {
    top = `<section class="ag-sec"><h3>Selected session</h3>
      <dl class="ag-kv">
        <dt>session</dt><dd class="mono">${esc(S.sid)}</dd>
        <dt>status</dt><dd>${sel ? `${esc(sel.label)} <span class="ag-note">(${esc(sel.why)})</span>` : "not in this project's list"}</dd>
        ${s ? `<dt>active</dt><dd>${utc(s.firstTs)} – ${utc(s.lastTs)} <span class="ag-note">(transcript)</span></dd>` : ""}
        <dt>issue</dt><dd>${
          d.issues.length
            ? d.issues
                .map((i) =>
                  i.repo
                    ? `<a href="https://github.com/${esc(i.repo)}/issues/${i.n}" target="_blank" rel="noopener">#${i.n}</a> <span class="ag-note">(${esc(i.from)})</span>`
                    : `#${i.n} <span class="ag-note">(${esc(i.from)}; repository unknown, so no link)</span>`
                )
                .join("<br>")
            : `<span class="ag-note">not derivable: no branch name with an issue number</span>`
        }</dd>
        <dt>branch</dt><dd>${
          d.branches.length
            ? d.branches.map((b) => `<span class="mono">${esc(b.name)}</span> <span class="ag-note">(${esc(b.from)})</span>`).join("<br>")
            : `<span class="ag-note">none found</span>`
        }</dd>
        <dt>worktree</dt><dd>${
          [
            ...(s?.worktree ? [`<span class="mono">${esc(shortPath(s.cwd ?? ""))}</span> <span class="ag-note">(session started in a worktree; check: ${esc(s.worktree.check)})</span>`] : []),
            ...d.worktrees.map((w) => `<span class="mono">${esc(w.path)}</span> <span class="ag-note">(${esc(w.from)})</span>`),
          ].join("<br>") || `<span class="ag-note">none found</span>`
        }</dd>
        <dt>plan</dt><dd><span class="ag-note">not available: the replay data carries no task list</span></dd>
      </dl>
      ${r?.prs.length ? `<h4>Pull requests</h4>${r.prs.map(prBlock).join("")}` : load?.status === "ok" ? `<div class="ag-note">No PR linked in this window (transcript).</div>` : ""}
      ${cwd ? `<h4>Open its terminal</h4>${copyCd(cwd)}<div class="ag-note">${sel?.live ? "current folder of the running session" : "folder the session started in (transcript)"}</div>` : ""}
    </section>`;
  }
  const rows = ranked
    .map(
      (x, i) => `<button type="button" class="ag-prio${x.s.sessionId === S.sid ? " on" : ""}" data-sid="${esc(x.s.sessionId)}">
      <span class="ag-rk">${i + 1}</span><span class="ag-dot ${x.dot}"></span>
      <span><b>${esc(sessionName(x))}</b> · ${esc(x.label)}<br><span class="ag-note">${esc(x.why)}</span></span></button>`
    )
    .join("");
  const liveNote =
    S.live.status === "error"
      ? `<div class="ag-state ag-cnr"><b>Could not read</b> live sessions (${esc(S.live.error)}): waiting/working cannot be ranked.</div>`
      : "";
  return `${top}
  <section class="ag-sec"><h3>All sessions · most urgent first</h3>
    <div class="ag-signals">
      <div><b>Ranked by:</b> waiting on you (live status) › ready for review (open PR, GitHub) › working (live status: busy) › running › not running (newest first).</div>
      <div><b>Not available:</b> deadline (no source records one). Open PRs are checked only for running sessions and the selected one.</div>
      <div>${liveReadAt ? `Live status read at ${utc(liveReadAt)} (~/.claude/sessions); re-read each time this view opens.` : "Reading live status…"}</div>
    </div>
    ${liveNote}
    <div class="ag-prios">${rows}</div>
  </section>`;
}

function scopeSwitch(total: number): string {
  return `<div class="ag-seg" role="group" aria-label="Scope">
    <button type="button" data-scope="one" class="${S.scope === "one" ? "on" : ""}">This agent</button>
    <button type="button" data-scope="all" class="${S.scope === "all" ? "on" : ""}">All in ${esc(S.project ?? "project")} (${total})</button>
  </div>`;
}

function fileSources(f: ChangedFile): string {
  const out: string[] = [];
  if (f.how.includes("tool")) out.push(srcTag("transcript", "an Edit/Write call"));
  if (f.how.includes("commit")) out.push(srcTag(`commit ${(f.sha ?? "").slice(0, 7)}`, f.sha));
  if (f.how.includes("pr")) out.push(srcTag(`PR #${f.pr} · GitHub`));
  return out.join("");
}

function changesFor(r: ReplayResponse): string {
  if (isCouldNotRead(r.changes.status) || r.changes.status === "none" || r.changes.status === "skipped") {
    const shells0 = r.steps.filter((s) => s.mayEditFiles?.scope === "project");
    return statusBlock(r.changes.status, r.changes.detail, "No changes found") + (shells0.length ? shellList(shells0) : "");
  }
  const files = r.changes.files
    .map(
      (f) => `<div class="ag-file${f.viaShell ? " shell" : ""}">
      <div class="ag-file-top"><span class="mono ag-trunc" title="${esc(f.path)}">${esc(tailPath(f.path))}</span>${
        f.status ? `<span class="mono ag-note">${esc(f.status)}</span>` : ""
      }</div>
      <div class="ag-file-src">${fileSources(f)}${
        f.toolEdit ? `<span class="ag-note">tool edit as ${esc(shortPath(f.toolEdit.path))} at ${utc(f.toolEdit.ts)}</span>` : ""
      }</div>
      ${
        f.viaShell
          ? `<div class="ag-gaps"><span class="ag-chip warn">${esc(f.notesGap ?? "no notes given")}</span><span class="ag-chip neutral">design rules: ${esc(
              f.designRules ?? "not confirmed"
            )}</span></div>`
          : ""
      }
    </div>`
    )
    .join("");
  const nShell = r.changes.files.filter((f) => f.viaShell).length;
  const shells = r.steps.filter((s) => s.mayEditFiles?.scope === "project");
  return `<div class="ag-note">${r.changes.files.length} files (transcript, commits, GitHub) · ${nShell} changed only through the shell</div>
    <div class="ag-files">${files}</div>${shellList(shells)}`;
}

function shellList(shells: ReplayStep[]): string {
  if (!shells.length) return `<div class="ag-note">No shell command in this window looks like it writes project files (guessed from command text).</div>`;
  return `<h4>Shell commands that may have edited project files · ${shells.length} <span class="ag-note">(guessed from command text)</span></h4>
    ${shells
      .map(
        (s) => `<details class="ag-shell"><summary>${utc(s.ts)} · ${esc(s.mayEditFiles!.reason)}</summary><pre class="mono">${esc(s.command ?? "")}</pre></details>`
      )
      .join("")}`;
}

function noteItem(n: NoteUsed): string {
  const meter = n.meter?.length
    ? n.meter.map((m) => `hook meter: ${esc(m.hook)}, ${bytes(m.bytes)} at ${utc(m.ts)}`).join("; ")
    : "no matching hook-meter row";
  const persisted = n.persisted
    ? isCouldNotRead(n.persisted.status)
      ? ` · <span class="ag-cnr-t">full text file could not be read</span>`
      : " · full text loaded from its saved file"
    : "";
  return `<details class="ag-noteitem" data-noteid="${n.id}"${S.openNote === n.id ? " open" : ""}>
    <summary><span class="ag-time">${utc(n.ts)}</span> · <b>${esc(n.hookName)}</b> · ${bytes(n.size)}</summary>
    <div class="ag-note">${srcTag("transcript", `line ${n.line}`)} line ${n.line} · ${meter}${persisted}</div>
    <pre class="ag-notetext">${esc(n.text ?? n.preview)}</pre>
  </details>`;
}

function notesFor(r: ReplayResponse): string {
  if (isCouldNotRead(r.notes.status)) return statusBlock(r.notes.status, r.notes.detail, "");
  if (r.notes.status === "skipped") return statusBlock("skipped", r.notes.detail, "");
  if (r.notes.status === "none" || !r.notes.items.length)
    return `<div class="ag-state ag-none" role="status"><b>No notes</b> · ${esc((r.notes.detail ?? "anvi injected nothing in this window").replace(/^no notes:\s*/i, ""))} (transcript)</div>`;
  return `<div class="ag-note">${r.notes.items.length} notes anvi injected in ${esc(windowText())} (transcript; full text one click away)</div>
    ${r.notes.items.map(noteItem).join("")}`;
}

function scoped(
  ranked: Ranked[],
  fn: (r: ReplayResponse) => string
): string {
  const targets: Ranked[] =
    S.scope === "one"
      ? ranked.filter((x) => x.s.sessionId === S.sid)
      : overlapping(ranked).slice(0, ALL_SCOPE_MAX);
  if (S.scope === "one" && !S.sid) return `<div class="ag-note">Choose a session.</div>`;
  const ids = S.scope === "one" ? [S.sid!] : targets.map((t) => t.s.sessionId);
  const nameOf = (sid: string) => {
    const t = ranked.find((x) => x.s.sessionId === sid);
    return t ? sessionName(t) : shortSid(sid);
  };
  const head =
    S.scope === "all"
      ? `<div class="ag-note">${ids.length} session${ids.length === 1 ? "" : "s"} ${
          S.from || S.to ? "active in this window" : "most recently active"
        } (transcripts)${overlapping(ranked).length > ALL_SCOPE_MAX ? `, the newest ${ALL_SCOPE_MAX} of ${overlapping(ranked).length}` : ""}.</div>`
      : "";
  return (
    head +
    ids
      .map((sid) => {
        const l = loadReplay(sid, S.from, S.to);
        const body =
          l.status === "loading"
            ? `<div class="ag-loading">Reading…</div>`
            : l.status === "error"
              ? statusBlock("unreadable", `the server answered ${l.error}`, "")
              : isCouldNotRead(l.data.transcript.status)
                ? statusBlock(l.data.transcript.status, l.data.transcript.detail, "")
                : fn(l.data);
        return S.scope === "all" ? `<section class="ag-sec"><h4>${esc(nameOf(sid))} <span class="mono ag-note">${esc(shortSid(sid))}</span></h4>${body}</section>` : body;
      })
      .join("")
  );
}

function overlapping(ranked: Ranked[]): Ranked[] {
  const f = S.from ? Date.parse(S.from) : -Infinity;
  const t = S.to ? Date.parse(S.to) : Infinity;
  const hit = ranked.filter((x) => {
    const a = Date.parse(x.s.firstTs ?? x.s.modifiedAt);
    const b = Date.parse(x.s.lastTs ?? x.s.modifiedAt);
    return !(b < f || a > t);
  });
  const ts = (x: Ranked) => Date.parse(x.s.lastTs ?? x.s.modifiedAt) || 0;
  return hit.sort((a, b) => ts(b) - ts(a));
}

function rightPanel(ranked: Ranked[], sel: Ranked | undefined, load: Load<ReplayResponse> | null): string {
  const tabs: [AgentsTab, string][] = [
    ["session", "Session"],
    ["changes", "Changes"],
    ["notes", "Notes used"],
  ];
  const head = `<div class="ag-rtabs" role="tablist">${tabs
    .map(([k, l]) => `<button type="button" role="tab" data-tab="${k}" class="${S.tab === k ? "on" : ""}" aria-selected="${S.tab === k}">${l}</button>`)
    .join("")}</div>`;
  let body = "";
  if (S.tab === "session") body = sessionTab(ranked, sel, load);
  else {
    const n = S.from || S.to ? overlapping(ranked).length : ranked.length;
    body = scopeSwitch(n) + scoped(ranked, S.tab === "changes" ? changesFor : notesFor);
  }
  return `<aside class="ag-panel" aria-label="Selected session">${head}<div class="ag-panel-body">${body}</div></aside>`;
}

// ── paint ─────────────────────────────────────────────────────────────────

function paint(): void {
  if (!root || !root.isConnected) return;
  writeHash();
  const header = `<div class="ag-head"><h2>Agents</h2><span class="ag-sub">Read-only. What each session did, what anvi told it, and what it changed. Times in UTC.</span></div>`;
  const controls = `<div class="ag-controls">${projectPicker()}${windowControls()}<span class="ag-note">Window: ${esc(windowText())}</span></div>`;

  if (!S.project && !S.sid) {
    root.innerHTML = `<div class="ag-main">${header}${controls}<div class="ag-note">Choose a project to see its sessions.</div></div>`;
    return;
  }

  let ranked: Ranked[] = [];
  let listHtml = "";
  if (S.project) {
    const lst = S.lists.get(S.project);
    if (!lst || lst.status === "loading") listHtml = `<div class="ag-loading">Reading ${esc(S.project)}'s sessions…</div>`;
    else if (lst.status === "error") listHtml = statusBlock("unreadable", `session list: the server answered ${lst.error}`, "");
    else if (isCouldNotRead(lst.data.status)) listHtml = statusBlock(lst.data.status, lst.data.detail, "");
    else if (!lst.data.sessions.length) listHtml = statusBlock("none", lst.data.detail ?? "no transcripts for this project", "No sessions found");
    else {
      ranked = rank(lst.data.sessions);
      if (!S.sid) S.sid = ranked[0].s.sessionId;
      // Open-PR check for running sessions (unwindowed), so "ready for review" can rank.
      for (const x of ranked) if (x.live) loadReplay(x.s.sessionId, null, null);
      listHtml = tabRow(ranked, lst.data.sessions.length);
    }
  }
  if (S.sid) loadReplay(S.sid, null, null); // the selected session's own open-PR check
  const sel = ranked.find((x) => x.s.sessionId === S.sid);
  const load = S.sid ? loadReplay(S.sid, S.from, S.to) : null;
  const r = load?.status === "ok" ? load.data : null;
  const d = derive(r, sel?.live);
  const primary = primaryAction(r, d);
  const selHead = S.sid
    ? `<div class="ag-selhead"><div><h3>${esc(sel ? sessionName(sel) : shortSid(S.sid))}</h3><span class="mono ag-note">${esc(S.sid)}</span>${
        sel ? ` <span class="ag-chip ${sel.dot === "warn" ? "warn" : sel.dot === "info" ? "info" : sel.dot === "ok" ? "ok" : "neutral"}">${esc(sel.label)}</span>` : ""
      }</div>${primary}</div>`
    : "";

  root.innerHTML = `<div class="ag-main">${header}${controls}${listHtml}${selHead}${load ? stepsCard(load) : ""}</div>${rightPanel(ranked, sel, load)}`;
}

function onClick(e: Event): void {
  const t = e.target as HTMLElement;
  const sidBtn = t.closest<HTMLElement>("[data-sid]");
  if (sidBtn) {
    S.sid = sidBtn.dataset.sid!;
    S.openNote = null;
    paint();
    return;
  }
  const tab = t.closest<HTMLElement>("[data-tab]");
  if (tab) {
    S.tab = tab.dataset.tab as AgentsTab;
    paint();
    return;
  }
  const sc = t.closest<HTMLElement>("[data-scope]");
  if (sc) {
    S.scope = sc.dataset.scope as AgentsScope;
    paint();
    return;
  }
  const note = t.closest<HTMLElement>("[data-note]");
  if (note) {
    S.tab = "notes";
    S.scope = "one";
    S.openNote = Number(note.dataset.note);
    paint();
    root?.querySelector(`[data-noteid="${S.openNote}"]`)?.scrollIntoView({ block: "start" });
    return;
  }
  const copy = t.closest<HTMLElement>("[data-copy]");
  if (copy) {
    navigator.clipboard?.writeText(copy.dataset.copy!).then(
      () => (copy.textContent = "Copied"),
      () => (copy.textContent = "Copy failed: select the text")
    );
    return;
  }
  if (t.closest("[data-act='clear-window']")) {
    S.from = S.to = null;
    paint();
  }
}

function onChange(e: Event): void {
  const t = e.target as HTMLSelectElement;
  if (t.dataset.act === "project") {
    S.project = t.value || null;
    S.sid = null;
    S.openNote = null;
    if (S.project) loadList(S.project);
    paint();
  }
}

function onSubmit(e: Event): void {
  const f = e.target as HTMLFormElement;
  if (f.dataset.act !== "window") return;
  e.preventDefault();
  const fd = new FormData(f);
  S.from = normTime(String(fd.get("from") ?? "") || undefined);
  S.to = normTime(String(fd.get("to") ?? "") || undefined);
  paint();
}

/**
 * The Agents view. `route` (from `#agents?…`) seeds the state; afterwards the
 * view keeps the hash in step with what is on screen, so any screen can be
 * reopened from its URL.
 */
export function AgentsView(projectNames: string[], route?: AgentsRoute | null): HTMLElement {
  S.projectNames = projectNames;
  if (route) {
    if (route.project !== undefined) S.project = route.project;
    if (route.sid !== undefined) S.sid = route.sid;
    S.from = normTime(route.from);
    S.to = normTime(route.to);
    if (route.tab) S.tab = route.tab;
    if (route.scope) S.scope = route.scope;
  }
  root = document.createElement("div");
  root.className = "agents-view";
  root.addEventListener("click", onClick);
  root.addEventListener("change", onChange);
  root.addEventListener("submit", onSubmit);
  loadLive();
  if (S.project) loadList(S.project);
  // paint after the element is in the DOM
  queueMicrotask(paint);
  return root;
}
