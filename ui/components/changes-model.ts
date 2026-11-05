/**
 * The Changes screen's model (#84). Pure and DOM-free: tests import it directly.
 *
 * It turns GET /api/changes/pr/:n into what the screen says, keeping every "could not look"
 * apart from "nothing there":
 *   - no session found for the PR       → "no agent session found for this PR"
 *   - the session search failed          → "could not look for the agent's session"
 *   - a session, but no hook log         → says the log is absent (or unreadable), never "no context"
 *   - a log, but no firing for the file  → "the injector logged nothing for this file"
 */
import type { HookLogEntry } from "../../shared/types";
import type { ChangesResponse, CommitsRead, DharanaRead, PrFile, PrSession, SessionsRead } from "../../shared/changes-types";
import { boundaryId, logFileMatches } from "../../shared/changes";
import { parsePrSections, type Evidence, type Gap, type SectionState } from "../../shared/pr-evidence";

// ── the diff ──────────────────────────────────────────────────────────────────────────────

export interface DiffLine {
  kind: "add" | "del" | "ctx" | "meta";
  text: string;
  /** Line number on the old side (del, ctx). */
  oldNo: number | null;
  /** Line number on the new side (add, ctx). */
  newNo: number | null;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  oldPath: string | null;
  status: "added" | "deleted" | "renamed" | "modified";
  binary: boolean;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

const unquote = (p: string) => (p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1).replace(/\\(.)/g, "$1") : p);
const stripSide = (p: string) => unquote(p.trim()).replace(/^[ab]\//, "");

/** Parse `git diff` / `gh pr diff` output into files and hunks with both sides' line numbers. */
export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let f: DiffFile | null = null;
  let h: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    if (raw.startsWith("diff --git ")) {
      const m = /^diff --git ("?a\/.+?"?) ("?b\/.+"?)$/.exec(raw);
      const a = m ? stripSide(m[1]) : "";
      const b = m ? stripSide(m[2]) : "";
      f = { path: b || a, oldPath: null, status: "modified", binary: false, hunks: [], additions: 0, deletions: 0 };
      files.push(f);
      h = null;
      continue;
    }
    if (!f) continue;
    if (!h) {
      if (raw.startsWith("new file mode")) f.status = "added";
      else if (raw.startsWith("deleted file mode")) f.status = "deleted";
      else if (raw.startsWith("rename from ")) {
        f.status = "renamed";
        f.oldPath = raw.slice("rename from ".length);
      } else if (raw.startsWith("rename to ")) f.path = raw.slice("rename to ".length);
      else if (raw.startsWith("Binary files ") || raw === "GIT binary patch") f.binary = true;
      else if (raw.startsWith("--- ")) {
        const p = raw.slice(4);
        if (p !== "/dev/null" && f.status === "deleted") f.path = stripSide(p);
      } else if (raw.startsWith("+++ ")) {
        const p = raw.slice(4);
        if (p !== "/dev/null") f.path = stripSide(p);
      }
    }
    const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(raw);
    if (hm) {
      h = {
        header: raw,
        oldStart: Number(hm[1]),
        oldLines: hm[2] === undefined ? 1 : Number(hm[2]),
        newStart: Number(hm[3]),
        newLines: hm[4] === undefined ? 1 : Number(hm[4]),
        lines: [],
      };
      f.hunks.push(h);
      oldNo = h.oldStart;
      newNo = h.newStart;
      continue;
    }
    if (!h) continue;
    const c = raw[0];
    if (c === "+") {
      h.lines.push({ kind: "add", text: raw.slice(1), oldNo: null, newNo: newNo++ });
      f.additions++;
    } else if (c === "-") {
      h.lines.push({ kind: "del", text: raw.slice(1), oldNo: oldNo++, newNo: null });
      f.deletions++;
    } else if (c === " ") {
      h.lines.push({ kind: "ctx", text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ });
    } else if (c === "\\") {
      h.lines.push({ kind: "meta", text: raw, oldNo: null, newNo: null });
    }
    // An empty line ends the diff text or separates files; it is not a hunk line.
  }
  return files;
}

/**
 * Which files open with their diff drawn: in PR order, while the running line count stays within
 * `budget`. The rest open on a click. A PR of thousands of lines then still draws at once.
 */
export function openByDefault(files: DiffFile[], budget = 2500): Set<string> {
  const open = new Set<string>();
  let used = 0;
  for (const f of files) {
    const n = f.hunks.reduce((s, h) => s + h.lines.length, 0);
    if (used + n > budget) break;
    used += n;
    open.add(f.path);
  }
  return open;
}

// ── context the agent received ───────────────────────────────────────────────────────────

export interface Fire {
  sessionId: string;
  entry: HookLogEntry;
}

export type FileContext =
  | { kind: "could-not-look"; reason: string }
  | { kind: "no-session" }
  /** Sessions were found, but none of them has a readable hook log. */
  | { kind: "no-log"; logs: { sessionId: string | null; state: "absent" | "unreadable" | "no session id"; path?: string; reason?: string }[] }
  /** Logs were read; the injector logged nothing for this file. */
  | { kind: "not-fired"; sessions: string[]; otherEntries: number; unreadLogs: number }
  | {
      kind: "fired";
      fires: Fire[];
      boundaries: string[];
      patterns: string[];
      invariants: string[];
      fatality: boolean;
      /** Sessions whose log could not be read: the context shown may be incomplete. */
      unreadLogs: number;
    };

const uniq = <T,>(xs: T[]) => [...new Set(xs)];

/** What anvi's injector gave the PR's agent session(s) when they edited `path`. */
export function contextFor(path: string, sessions: SessionsRead): FileContext {
  if (sessions.status === "unreadable") return { kind: "could-not-look", reason: sessions.reason };
  if (sessions.sessions.length === 0) {
    if (sessions.errors.length) return { kind: "could-not-look", reason: sessions.errors.join("; ") };
    return { kind: "no-session" };
  }
  const readLogs = sessions.sessions.filter((s) => s.log?.status === "read");
  const unread = sessions.sessions.length - readLogs.length;
  if (readLogs.length === 0) {
    return {
      kind: "no-log",
      logs: sessions.sessions.map((s) =>
        !s.sessionId || !s.log
          ? { sessionId: s.sessionId, state: "no session id" as const }
          : s.log.status === "absent"
            ? { sessionId: s.sessionId, state: "absent" as const, path: s.log.path }
            : { sessionId: s.sessionId, state: "unreadable" as const, path: s.log.path, reason: s.log.status === "unreadable" ? s.log.reason : undefined },
      ),
    };
  }
  const fires: Fire[] = [];
  for (const s of readLogs)
    if (s.log?.status === "read") for (const e of s.log.entries) if (logFileMatches(e.file, path)) fires.push({ sessionId: s.sessionId!, entry: e });
  if (fires.length === 0) {
    const others = readLogs.reduce((n, s) => n + (s.log?.status === "read" ? s.log.entries.length : 0), 0);
    return { kind: "not-fired", sessions: readLogs.map((s) => s.sessionId!), otherEntries: others, unreadLogs: unread };
  }
  fires.sort((a, b) => a.entry.ts.localeCompare(b.entry.ts));
  return {
    kind: "fired",
    fires,
    boundaries: uniq(fires.flatMap((f) => f.entry.boundaries ?? [])),
    patterns: uniq(fires.flatMap((f) => f.entry.patterns ?? [])),
    invariants: uniq(fires.flatMap((f) => f.entry.invariants ?? [])),
    fatality: fires.some((f) => f.entry.fatality),
    unreadLogs: unread,
  };
}

const short = (sid: string | null) => (sid ? sid.slice(0, 8) : "?");

/** One line for under a hunk: the context, or exactly why there is none to show. */
export function contextLine(ctx: FileContext, titles: Record<string, string>, dharana: DharanaRead): string {
  switch (ctx.kind) {
    case "could-not-look":
      return `Could not look for the agent's session: ${ctx.reason}`;
    case "no-session":
      return "No agent session found for this PR, so what anvi gave the agent here is not known.";
    case "no-log":
      return `No hook log to read: ${ctx.logs
        .map((l) =>
          l.state === "absent"
            ? `session ${short(l.sessionId)}'s ${l.path} is not present (the injector writes it only for projects with a dharana.md, and /tmp is cleared on restart)`
            : l.state === "unreadable"
              ? `session ${short(l.sessionId)}'s ${l.path} could not be read (${l.reason ?? "error"})`
              : "an AnviDeck agent with no session id yet",
        )
        .join("; ")}.`;
    case "not-fired":
      return `The injector logged nothing for this file in session ${ctx.sessions.map(short).join(", ")} (${ctx.otherEntries} firings for the PR's other files)${ctx.unreadLogs ? `; ${ctx.unreadLogs} other session log(s) could not be read` : ""}. The file may have been written by a shell command, which the injector does not see.`;
    case "fired": {
      const names = ctx.boundaries.map((b) => boundaryName(b, dharana));
      const ex = ctx.patterns.find((p) => titles[p]);
      const n = ctx.fires.length;
      const when = ctx.fires[n - 1].entry.ts;
      return [
        names.length ? `${names.length === 1 ? "Boundary" : "Boundaries"} ${names.join(", ")}` : "No boundary matched",
        `: ${ctx.patterns.length} error pattern${ctx.patterns.length === 1 ? "" : "s"} and ${ctx.invariants.length} invariant${ctx.invariants.length === 1 ? "" : "s"} delivered`,
        ex ? `, including ${ex} "${titles[ex]}"` : "",
        ctx.fatality ? ". Flagged FATALITY" : "",
        `. Fired ${n} time${n === 1 ? "" : "s"}, last ${when}, session ${uniq(ctx.fires.map((f) => short(f.sessionId))).join(", ")}`,
        ctx.unreadLogs ? `; ${ctx.unreadLogs} other session log(s) could not be read, so this may be incomplete` : "",
        ".",
      ].join("");
    }
  }
}

/** "B16 Editor view camera ↔ DAG scene cameras": the logged label, titled from dharana.md when the log has only the ID. */
export function boundaryName(label: string, dharana: DharanaRead): string {
  const id = boundaryId(label);
  const logged = label.includes(":") ? label.slice(label.indexOf(":") + 1).trim() : "";
  const fromDharana = dharana.status === "read" ? dharana.boundaries.find((b) => b.id === id)?.title : undefined;
  const title = logged || fromDharana;
  return title ? `${id} ${title}` : id;
}

// ── boundaries the PR touches ────────────────────────────────────────────────────────────

export type BoundariesView =
  | { state: "none-recorded"; note: string }
  | { state: "unreadable"; note: string }
  | { state: "unknown"; note: string }
  | { state: "listed"; items: { id: string; name: string; files: string[] }[]; note: string };

/**
 * The project's dharana boundaries this PR touches, as the injector matched them for the PR's
 * files in the agent's session(s). Without a dharana.md: "none recorded". With one, but no log to
 * read: not known (and why), never "none".
 */
export function boundariesTouched(r: Pick<ChangesResponse, "dharana" | "sessions">, files: PrFile[]): BoundariesView {
  const d = r.dharana;
  if (d.status === "none") return { state: "none-recorded", note: `None recorded: this project has no dharana.md (looked at ${d.searched.join(", ")}).` };
  if (d.status === "unreadable") return { state: "unreadable", note: `Could not read ${d.path}: ${d.reason}` };
  const byId = new Map<string, { id: string; name: string; files: string[] }>();
  let anyFired = false;
  let anyRead = false;
  for (const f of files) {
    const c = contextFor(f.path, r.sessions);
    if (c.kind === "could-not-look") return { state: "unknown", note: `Not known: could not look for the agent's session (${c.reason}).` };
    if (c.kind === "no-session") return { state: "unknown", note: `Not known: no agent session found for this PR. dharana.md lists ${d.boundaries.length} boundaries; only the injector's log for the agent's session says which ones these files touched.` };
    if (c.kind === "no-log") return { state: "unknown", note: `Not known: the agent's session has no hook log to read (${c.logs.map((l) => l.state).join(", ")}).` };
    anyRead = true;
    if (c.kind !== "fired") continue;
    anyFired = true;
    for (const b of c.boundaries) {
      const id = boundaryId(b);
      const item = byId.get(id) ?? { id, name: boundaryName(b, d), files: [] };
      if (!item.files.includes(f.path)) item.files.push(f.path);
      byId.set(id, item);
    }
  }
  const src = `From the injector's log for the agent's session, matched against ${d.path}.`;
  if (!anyRead) return { state: "unknown", note: "Not known: the PR has no files." };
  if (byId.size === 0)
    return { state: "listed", items: [], note: anyFired ? `The injector fired for these files but matched no boundary. ${src}` : `The injector logged nothing for these files, so no boundary is known to be touched. ${src}` };
  return { state: "listed", items: [...byId.values()], note: src };
}

// ── line comments ────────────────────────────────────────────────────────────────────────

/** The fields of an agent this screen reads from GET /api/agents. */
export interface AgentLite {
  id: string;
  status: string;
}

export type AgentsList = { state: "loading" } | { state: "ok"; agents: AgentLite[] } | { state: "off" | "failed"; reason: string };

export const LIVE = new Set(["starting", "working", "waiting"]);

export type CommentTarget = { enabled: true; agentId: string; note: string } | { enabled: false; why: string };

/** Where a line comment goes: the PR's running AnviDeck agent, or why the box is off. */
export function commentTarget(sessions: SessionsRead, agents: AgentsList): CommentTarget {
  if (sessions.status === "unreadable") return { enabled: false, why: `Could not look for this PR's agent: ${sessions.reason}` };
  if (sessions.sessions.length === 0) return { enabled: false, why: "No agent session found for this PR, so there is no agent to send a comment to." };
  const ids = uniq(sessions.sessions.map((s) => s.agentId).filter((x): x is string => !!x));
  if (ids.length === 0)
    return { enabled: false, why: "This PR's session was not started by AnviDeck (a terminal session), and AnviDeck can only message agents it started." };
  if (agents.state === "loading") return { enabled: false, why: "Reading the agents…" };
  if (agents.state !== "ok") return { enabled: false, why: `Could not read the agents (${agents.state}): ${agents.reason}` };
  const live = ids.map((id) => agents.agents.find((a) => a.id === id)).filter((a): a is AgentLite => !!a && LIVE.has(a.status));
  if (live.length === 1) return { enabled: true, agentId: live[0].id, note: `Goes to agent ${live[0].id} (${live[0].status}) on its next turn.` };
  if (live.length > 1) return { enabled: false, why: `${live.length} running AnviDeck agents match this PR (${live.map((a) => a.id).join(", ")}); AnviDeck does not guess which one.` };
  const known = ids.map((id) => {
    const a = agents.agents.find((x) => x.id === id);
    return a ? `${id} is ${a.status}` : `${id} is not in the agent host's list`;
  });
  return { enabled: false, why: `This PR's agent is not running (${known.join("; ")}). Resume it on /agent-host to send it a comment.` };
}

// ── guided tour ──────────────────────────────────────────────────────────────────────────

export interface TourStep {
  file: string;
  commit: { oid: string; headline: string; index: number } | null;
}

export interface Tour {
  state: "ok" | "partial" | "unreadable";
  steps: TourStep[];
  note: string;
}

/**
 * A walk through the PR's files in the order its commits first touched them. Files no commit's
 * readable list names come last, marked as not placed, so a partial read never drops a file.
 */
export function guidedTour(commits: CommitsRead, files: PrFile[]): Tour {
  if (commits.status === "unreadable")
    return { state: "unreadable", steps: files.map((f) => ({ file: f.path, commit: null })), note: `The commits could not be read (${commits.reason}); files are in the PR's order.` };
  const wanted = new Set(files.map((f) => f.path));
  const seen = new Set<string>();
  const steps: TourStep[] = [];
  commits.commits.forEach((c, i) => {
    for (const p of c.files ?? []) {
      if (!wanted.has(p) || seen.has(p)) continue;
      seen.add(p);
      steps.push({ file: p, commit: { oid: c.oid, headline: c.headline, index: i + 1 } });
    }
  });
  const rest = files.filter((f) => !seen.has(f.path)).map((f) => ({ file: f.path, commit: null }));
  const n = commits.commits.length;
  const note =
    commits.status === "partial"
      ? `Partial: ${commits.reason}. ${rest.length} file(s) could not be placed in commit order and come last.`
      : rest.length
        ? `${steps.length} files in the order ${n} commit${n === 1 ? "" : "s"} first touched them; ${rest.length} file(s) no commit names (changed by a merge) come last.`
        : `${steps.length} files in the order ${n} commit${n === 1 ? "" : "s"} first touched them.`;
  return { state: commits.status === "partial" || rest.length ? "partial" : "ok", steps: [...steps, ...rest], note };
}

// ── evidence and self-review ─────────────────────────────────────────────────────────────

export type SectionView<T> = { state: "recorded"; value: T } | { state: "not-in-format"; why: string };

function view<T>(s: SectionState<T>, name: string): SectionView<T> {
  if (s.status === "recorded") return { state: "recorded", value: s.value };
  if (s.status === "not recorded") return { state: "not-in-format", why: `Not in the evidence format: the PR body has no "## ${name}" section.` };
  return { state: "not-in-format", why: `Not in the evidence format: ${s.reason}.` };
}

/** The PR body's Evidence and Self-review exactly as shared/pr-evidence.ts parses them. */
export function evidenceView(body: string): { evidence: SectionView<Evidence>; selfReview: SectionView<{ gaps: Gap[] }> } {
  const p = parsePrSections(body);
  return { evidence: view(p.evidence, "Evidence"), selfReview: view(p.selfReview, "Self-review") };
}

// ── which PR ────────────────────────────────────────────────────────────────────────────

/** The PR to show: the one the URL names, else the newest open one, else none (the picker). */
export function pickPr(fromUrl: string | null, open: { number: number; createdAt: string }[]): number | null {
  if (fromUrl && /^\d+$/.test(fromUrl)) return Number(fromUrl);
  if (open.length === 0) return null;
  return [...open].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.number - a.number)[0].number;
}

export type { PrSession };
