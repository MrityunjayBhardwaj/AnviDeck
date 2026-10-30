import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LiveSession } from "../../shared/types";
import type {
  HomeAgent,
  HomeMetric,
  HomeResponse,
  HomeSource,
  QueueItem,
  UnreadItem,
} from "../../shared/home-types";
import { readLiveSessionsReport } from "./sessions";
import { encodeCwd, findTranscript, ghPrView } from "./replay";
import { listStructure, readStructure } from "./structure";

/**
 * Home (issue #18): everything that needs a decision, from real data only.
 *
 * Read only. Four sources:
 *   - live sessions:   ~/.claude/sessions/<pid>.json (status "waiting" = blocked on you)
 *   - PRs:             "pr-link" records in the live sessions' transcripts, each asked of
 *                      GitHub with `gh pr view` (the replay reader's cache: merged/closed kept,
 *                      open for 60 s)
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

function ago(ms: number, now: number): string {
  const m = Math.max(0, Math.round((now - ms) / 60000));
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;
}

// ── Build ─────────────────────────────────────────────────────────────────────────────────

export async function readHome(): Promise<HomeResponse> {
  const t0 = performance.now();
  const now = Date.now();
  const timings: Record<string, number> = {};
  const queue: QueueItem[] = [];
  const unread: UnreadItem[] = [];

  // Live sessions
  const { sessions, report } = readLiveSessionsReport();
  timings.sessions = Math.round(performance.now() - t0);
  const sessionsSource: HomeSource = {
    status: report.status === "unreadable" ? "could-not-read" : report.status === "partial" ? "partial" : sessions.length ? "ok" : "none",
    label: `~/.claude/sessions (${sessions.length} live)`,
    ...(report.errors.length ? { detail: report.errors.join("; ") } : {}),
  };
  for (const s of sessions) {
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
  const answers = await Promise.all(entries.map((e) => ghPrView(e.link.number, e.link.repo)));
  timings.github = Math.round(performance.now() - tPr) - timings.transcripts;
  const tally = { review: 0, draft: 0, merged: 0, closed: 0, other: 0, failed: 0, cached: 0 };
  const openBySession = new Map<string, number[]>();
  entries.forEach((e, i) => {
    const r = answers[i];
    if (r.cached) tally.cached++;
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
      unread.push({ id: `pr:${key}`, what: `Could not check PR ${key}`, source: `gh pr view: ${(r.err || "unparseable answer").slice(0, 160)}` });
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
      source: `pr-link in ${e.sessions.length === 1 ? "this session's transcript" : `${e.sessions.length} transcripts`} + gh pr view (state OPEN, not a draft)`,
    });
  });
  const prsSource: HomeSource = {
    status:
      entries.length === 0 ? (scanErrors.length ? "could-not-read" : "none")
      : tally.failed === entries.length ? "could-not-read"
      : tally.failed || scanErrors.length ? "partial" : "ok",
    label: `PR links in ${scanned} of ${sessions.length} live transcripts, checked with gh pr view`,
    detail:
      `${entries.length} linked: ${tally.review} open for review, ${tally.draft} draft, ${tally.merged} merged, ${tally.closed} closed` +
      (tally.other ? `, ${tally.other} other` : "") +
      (tally.failed ? `, ${tally.failed} could not be checked` : "") +
      (tally.cached ? `; ${tally.cached} answers from cache` : "") +
      (scanErrors.length ? `; ${scanErrors.length} transcript(s) unreadable` : "") +
      ". PRs from sessions that have ended are not scanned.",
  };

  // Structure results
  const { list, results } = await structureP;
  let newBreaks = 0, allowed = 0, measured = 0;
  const notMeasured: string[] = [];
  const measuredLines: string[] = [];
  for (const r of results) {
    if (r.status === "measured") {
      measured++;
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
          action: { label: "Copy cd", copy: `cd ${list.projects.find((p) => p.name === r.project)?.path ?? r.project}` },
          source: `structure guard at ${at}`,
        });
      }
    } else if (r.status !== "no-design") {
      notMeasured.push(`${r.project}: ${r.reason}`);
      unread.push({ id: `rules:${r.project}`, what: `Could not measure ${r.project}'s structure`, source: `structure guard: ${r.reason.slice(0, 160)}` });
    }
  }
  const structureSource: HomeSource =
    list.status !== "ok"
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

  // Metrics: four, each naming its source.
  const metrics: HomeMetric[] = [];
  metrics.push({
    id: "new-breaks",
    label: "New rule breaks",
    state: structureSource.status === "ok" ? (newBreaks > 0 ? "bad" : "ok") : structureSource.status === "none" ? "ok" : "unknown",
    value: structureSource.status === "ok" || structureSource.status === "partial" ? String(newBreaks) : "not measured",
    note: structureSource.status === "none" ? "No project has a design, so nothing is checked." : "Imports added since the baseline that the design does not allow.",
    source: structureSource.detail ? `${structureSource.label}: ${structureSource.detail}` : structureSource.label,
  });
  metrics.push({
    id: "allowed-breaks",
    label: "Allowed rule breaks",
    state: measured ? "ok" : "unknown",
    value: measured ? String(allowed) : "not measured",
    note: "Known imports the design does not allow yet, kept in the baseline until fixed.",
    source: structureSource.label,
  });
  const n = notes.value;
  const stale = n ? n.red + n.yellow : 0;
  metrics.push({
    id: "notes",
    label: "Out-of-date notes",
    state: n ? (stale > 0 ? "warn" : "ok") : "unknown",
    value: n ? `${stale.toLocaleString("en-US")} of ${n.examined.toLocaleString("en-US")}` : notes.source.status === "none" ? "no snapshot" : "could not read",
    note: n
      ? `Snapshot of ${n.date} (UTC), ${Math.round((now - Date.parse(n.date)) / 86400000)} days old: ${n.yellow.toLocaleString("en-US")} point at code that changed since checked, ${n.red} at files that are gone. ${n.projects} projects${n.unmeasured.length ? `; not measured: ${n.unmeasured.join(", ")}` : ""}.`
      : notes.source.detail ?? "",
    source: notes.source.label,
  });
  const sourceList = { sessions: sessionsSource, prs: prsSource, structure: structureSource, notes: notes.source };
  const unreadable = Object.entries(sourceList).filter(([, s]) => s.status === "could-not-read" || s.status === "partial" || s.status === "not-measured");
  metrics.push({
    id: "sources",
    label: "Sources read",
    state: unreadable.length ? "warn" : "ok",
    value: `${4 - unreadable.length} of 4`,
    note: unreadable.length ? `Not fully read: ${unreadable.map(([k, s]) => `${k} (${s.status})`).join(", ")}.` : "Live sessions, PRs, structure and notes all answered.",
    source: "this page's four sources, listed under Sources",
  });

  // Agents, one line each
  const agents: HomeAgent[] = sessions.map((s) => ({
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
  return { generatedAt: new Date(now).toISOString(), queue: orderQueue(queue), unread, metrics, agents, sources: sourceList, timings };
}
