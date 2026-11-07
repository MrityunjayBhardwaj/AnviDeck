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
import { elsewhereText, type RunsElsewhere } from "../../shared/agent-elsewhere";
import type { DiffFile } from "../../shared/diff";
import { parsePrSections, type Evidence, type Gap, type SectionState } from "../../shared/pr-evidence";

// ── the diff ──

// Parsing lives in shared/diff.ts: the reader uses it too, to list every file the diff has.
export { parseDiff, type DiffFile, type DiffHunk, type DiffLine } from "../../shared/diff";

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
  /** Sessions were found, but this file was not among those their hook logs were searched for. */
  | { kind: "not-searched" }
  /** Sessions were found, but none of them has a readable hook log. */
  | { kind: "no-log"; logs: { sessionId: string | null; state: "absent" | "unreadable" | "no session id"; path?: string; reason?: string }[]; gaps: Gaps }
  /** Logs were read; the injector logged nothing for this file in them. */
  | { kind: "not-fired"; sessions: string[]; otherEntries: number; gaps: Gaps }
  | {
      kind: "fired";
      fires: Fire[];
      boundaries: string[];
      patterns: string[];
      invariants: string[];
      fatality: boolean;
      gaps: Gaps;
    };

/**
 * What was not looked at, beside what was: each makes "nothing logged" or the context shown possibly
 * incomplete, and each is said apart, so "could not read" never reads as "had nothing".
 */
export interface Gaps {
  /** Sessions whose hook log is absent or could not be read. */
  unreadLogs: number;
  /** AnviDeck agents tied to the PR that have no session id yet, so no log to look for. */
  noSessionId: number;
  /** The session search was partial: these could not be searched (registry, grep, worktree list). */
  searchErrors: string[];
}

export const incomplete = (g: Gaps) => g.unreadLogs > 0 || g.noSessionId > 0 || g.searchErrors.length > 0;

/** The gaps as a clause, or "" when there are none. */
export function gapsText(g: Gaps): string {
  const parts: string[] = [];
  if (g.unreadLogs) parts.push(`${g.unreadLogs} other session log(s) are absent or could not be read`);
  if (g.noSessionId) parts.push(`${g.noSessionId} AnviDeck agent(s) tied to this PR have no session id yet, so there is no log of theirs to read`);
  if (g.searchErrors.length) parts.push(`the search for the PR's sessions was partial (${g.searchErrors.join("; ")}), so a session may be missing`);
  return parts.join("; ");
}

const uniq = <T,>(xs: T[]) => [...new Set(xs)];

/** What anvi's injector gave the PR's agent session(s) when they edited `path`. */
export function contextFor(path: string, sessions: SessionsRead): FileContext {
  if (sessions.status === "unreadable") return { kind: "could-not-look", reason: sessions.reason };
  if (sessions.sessions.length === 0) {
    if (sessions.errors.length) return { kind: "could-not-look", reason: sessions.errors.join("; ") };
    return { kind: "no-session" };
  }
  if (!sessions.filesSearched.includes(path)) return { kind: "not-searched" };
  const readLogs = sessions.sessions.filter((s) => s.log?.status === "read");
  const gaps: Gaps = {
    unreadLogs: sessions.sessions.filter((s) => s.sessionId && s.log && s.log.status !== "read").length,
    noSessionId: sessions.sessions.filter((s) => !s.sessionId || !s.log).length,
    searchErrors: sessions.errors,
  };
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
      gaps: { unreadLogs: 0, noSessionId: 0, searchErrors: sessions.errors },
    };
  }
  const fires: Fire[] = [];
  for (const s of readLogs)
    if (s.log?.status === "read") for (const e of s.log.entries) if (logFileMatches(e.file, path)) fires.push({ sessionId: s.sessionId!, entry: e });
  if (fires.length === 0) {
    const others = readLogs.reduce((n, s) => n + (s.log?.status === "read" ? s.log.entries.length : 0), 0);
    return { kind: "not-fired", sessions: readLogs.map((s) => s.sessionId!), otherEntries: others, gaps };
  }
  fires.sort((a, b) => a.entry.ts.localeCompare(b.entry.ts));
  return {
    kind: "fired",
    fires,
    boundaries: uniq(fires.flatMap((f) => f.entry.boundaries ?? [])),
    patterns: uniq(fires.flatMap((f) => f.entry.patterns ?? [])),
    invariants: uniq(fires.flatMap((f) => f.entry.invariants ?? [])),
    fatality: fires.some((f) => f.entry.fatality),
    gaps,
  };
}

const short = (sid: string | null) => (sid ? sid.slice(0, 8) : "?");

/** One line for a file's diff: the context, or exactly why there is none to show. */
export function contextLine(ctx: FileContext, titles: Record<string, string>, dharana: DharanaRead): string {
  switch (ctx.kind) {
    case "could-not-look":
      return `Could not look for the agent's session: ${ctx.reason}`;
    case "no-session":
      return "No agent session found for this PR, so what anvi gave the agent here is not known.";
    case "not-searched":
      return "Not searched: this file is not in the PR's file list as read, so the hook logs were not searched for it. What anvi gave the agent here is not known.";
    case "no-log": {
      const g = gapsText(ctx.gaps);
      return `No hook log to read: ${ctx.logs
        .map((l) =>
          l.state === "absent"
            ? `session ${short(l.sessionId)}'s ${l.path} is not present (the injector writes it only for projects with a dharana.md, and /tmp is cleared on restart)`
            : l.state === "unreadable"
              ? `session ${short(l.sessionId)}'s ${l.path} could not be read (${l.reason ?? "error"})`
              : "an AnviDeck agent with no session id yet",
        )
        .join("; ")}${g ? `; ${g}` : ""}.`;
    }
    case "not-fired": {
      const g = gapsText(ctx.gaps);
      return `The injector logged nothing for this file in session ${ctx.sessions.map(short).join(", ")} (${ctx.otherEntries} firings for the PR's other files)${
        g ? `; but ${g}, so this may be incomplete` : ""
      }. The file may have been written by a shell command (the injector sees only Edit and Write) or in a session not tied to this PR.`;
    }
    case "fired": {
      const names = ctx.boundaries.map((b) => boundaryName(b, dharana));
      const ex = ctx.patterns.find((p) => titles[p]);
      const n = ctx.fires.length;
      const when = ctx.fires[n - 1].entry.ts;
      const g = gapsText(ctx.gaps);
      return [
        names.length ? `${names.length === 1 ? "Boundary" : "Boundaries"} ${names.join(", ")}` : "No boundary matched",
        `: ${ctx.patterns.length} error pattern${ctx.patterns.length === 1 ? "" : "s"} and ${ctx.invariants.length} invariant${ctx.invariants.length === 1 ? "" : "s"} delivered`,
        ex ? `, including ${ex} "${titles[ex]}"` : "",
        ctx.fatality ? ". Flagged FATALITY" : "",
        `. Fired ${n} time${n === 1 ? "" : "s"}, last ${when}, session ${uniq(ctx.fires.map((f) => short(f.sessionId))).join(", ")}`,
        g ? `; ${g}, so this may be incomplete` : "",
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
  | { state: "listed"; items: { id: string; name: string; files: string[] }[]; note: string; incomplete: boolean };

/**
 * The project's dharana boundaries this PR touches, as the injector matched them for the PR's
 * files in the agent's session(s). Without a dharana.md: "none recorded". With one, but no log to
 * read: not known (and why), never "none". When some logs were read and some were not, what was
 * found is listed and the rest is said; nothing found then is "not known", never "none touched".
 */
export function boundariesTouched(r: Pick<ChangesResponse, "dharana" | "sessions">, files: PrFile[]): BoundariesView {
  const d = r.dharana;
  if (d.status === "none") return { state: "none-recorded", note: `None recorded: this project has no dharana.md (looked at ${d.searched.join(", ")}).` };
  if (d.status === "unreadable") return { state: "unreadable", note: `Could not read ${d.path}: ${d.reason}` };
  const byId = new Map<string, { id: string; name: string; files: string[] }>();
  let anyFired = false;
  let anyRead = false;
  let gaps: Gaps | null = null;
  let notSearched = 0;
  for (const f of files) {
    const c = contextFor(f.path, r.sessions);
    if (c.kind === "could-not-look") return { state: "unknown", note: `Not known: could not look for the agent's session (${c.reason}).` };
    if (c.kind === "no-session") return { state: "unknown", note: `Not known: no agent session found for this PR. dharana.md lists ${d.boundaries.length} boundaries; only the injector's log for the agent's session says which ones these files touched.` };
    if (c.kind === "no-log") return { state: "unknown", note: `Not known: the agent's session has no hook log to read (${c.logs.map((l) => l.state).join(", ")}).` };
    if (c.kind === "not-searched") {
      notSearched++;
      continue;
    }
    anyRead = true;
    gaps = c.gaps;
    if (c.kind !== "fired") continue;
    anyFired = true;
    for (const b of c.boundaries) {
      const id = boundaryId(b);
      const item = byId.get(id) ?? { id, name: boundaryName(b, d), files: [] };
      if (!item.files.includes(f.path)) item.files.push(f.path);
      byId.set(id, item);
    }
  }
  if (!anyRead) return { state: "unknown", note: files.length ? `Not known: none of the PR's ${files.length} files was searched for in the hook logs.` : "Not known: the PR has no files." };
  const missing = [gaps ? gapsText(gaps) : "", notSearched ? `${notSearched} PR file(s) were not searched for` : ""].filter(Boolean).join("; ");
  const src = `From the injector's log for the agent's session, matched against ${d.path}.`;
  if (byId.size === 0) {
    if (missing) return { state: "unknown", note: `Not known: the logs that were read have no boundary for these files, but ${missing}. ${src}` };
    return { state: "listed", items: [], incomplete: false, note: anyFired ? `The injector fired for these files but matched no boundary. ${src}` : `The injector logged nothing for these files, so no boundary is known to be touched. ${src}` };
  }
  return { state: "listed", items: [...byId.values()], incomplete: !!missing, note: missing ? `${src} May be incomplete: ${missing}.` : src };
}

// ── the session search ───────────────────────────────────────────────────────────────────

/** What the session search looked at and what it could not, for the screen to show beside its results. */
export function sessionsSummary(sessions: SessionsRead): { lines: string[]; problems: string[] } {
  if (sessions.status === "unreadable") return { lines: [], problems: [`Could not search for the PR's sessions: ${sessions.reason}`] };
  const regRead = sessions.registry.status !== "unreadable";
  const lines = sessions.sessions.map(
    (s) => `${s.sessionId ? `session ${short(s.sessionId)}` : "no session id yet"} · found by ${s.how.join(", ")}${
      s.agentId ? ` · AnviDeck agent ${s.agentId}` : regRead ? " · not started by AnviDeck" : " · whether AnviDeck started it is not known"
    }${
      s.log ? ` · hook log ${s.log.status}` : ""
    }`,
  );
  const reg = sessions.registry;
  const regLine =
    reg.status === "read" ? `agent registry read (${reg.path})` : reg.status === "absent" ? `no agent registry at ${reg.path} (AnviDeck has started no agent)` : `agent registry could not be read (${reg.reason ?? reg.path})`;
  lines.push(`Searched ${sessions.searched.length} transcript folder(s); ${regLine}.`);
  return { lines, problems: sessions.status === "partial" ? sessions.errors.map((e) => `Partial search: ${e}`) : [] };
}

// ── line comments ────────────────────────────────────────────────────────────────────────

/** The fields of an agent this screen reads from GET /api/agents. */
export interface AgentLite {
  id: string;
  status: string;
  /** Another AnviDeck server runs it (#104): only that server can take a comment for it. */
  runsElsewhere?: RunsElsewhere;
}

export type AgentsList = { state: "loading" } | { state: "ok"; agents: AgentLite[] } | { state: "off" | "failed"; reason: string };

export const LIVE = new Set(["starting", "working", "waiting"]);

export type CommentTarget =
  | { enabled: true; agentId: string; note: string }
  /** `elsewhere`: the agent runs in another AnviDeck server; the page links to it there. */
  | { enabled: false; why: string; elsewhere?: { agentId: string; at: RunsElsewhere } };

/** Where a line comment goes: the PR's running AnviDeck agent, or why the box is off. */
export function commentTarget(sessions: SessionsRead, agents: AgentsList): CommentTarget {
  if (sessions.status === "unreadable") return { enabled: false, why: `Could not look for this PR's agent: ${sessions.reason}` };
  if (sessions.sessions.length === 0) return { enabled: false, why: "No agent session found for this PR, so there is no agent to send a comment to." };
  const ids = uniq(sessions.sessions.map((s) => s.agentId).filter((x): x is string => !!x));
  if (ids.length === 0) {
    // "Not started by AnviDeck" is known only when the registry was read and the search was whole.
    if (sessions.registry.status === "unreadable")
      return { enabled: false, why: `AnviDeck's agent registry could not be read (${sessions.registry.reason ?? sessions.registry.path}), so it cannot tell whether this PR's session is an agent it started.` };
    if (sessions.errors.length)
      return { enabled: false, why: `No AnviDeck agent found among this PR's sessions, but the search was partial (${sessions.errors.join("; ")}), so its agent may have been missed.` };
    return { enabled: false, why: "This PR's session was not started by AnviDeck (a terminal session), and AnviDeck can only message agents it started." };
  }
  if (agents.state === "loading") return { enabled: false, why: "Reading the agents…" };
  if (agents.state !== "ok") return { enabled: false, why: `Could not read the agents (${agents.state}): ${agents.reason}` };
  const matched = ids.map((id) => agents.agents.find((a) => a.id === id)).filter((a): a is AgentLite => !!a);
  // Running, but in another server: this one would refuse the comment (409), so say where it is.
  const there = matched.filter((a) => a.runsElsewhere);
  const live = matched.filter((a) => !a.runsElsewhere && LIVE.has(a.status));
  if (live.length === 0 && there.length === 1) {
    const a = there[0];
    return {
      enabled: false,
      why: `This PR's agent ${a.id} (${a.status}) is not run by this server: ${elsewhereText(a.runsElsewhere!)}, and only that server can send it a comment. Comment from that server's Changes screen.`,
      elsewhere: { agentId: a.id, at: a.runsElsewhere! },
    };
  }
  if (live.length === 0 && there.length > 1)
    return { enabled: false, why: `This PR's agents run in other AnviDeck servers (${there.map((a) => `${a.id}: ${elsewhereText(a.runsElsewhere!)}`).join("; ")}); comment from the server that runs the one you mean.` };
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
