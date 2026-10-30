/**
 * Map view (issue #19): one zoomable view from every project down to files and
 * their imports, with agents replayed over the files they touched.
 *
 *   far     every project, with how many agents run in it now (GET /api/sessions)
 *   blocks  a project's design components as bordered blocks (GET /api/structure/:project)
 *   files   every module and its imports, as anvi's structure guard reads them
 *
 * Read-only. Every figure says where it came from: the guard's graph names the
 * commit it measured and the guard's own hash; replay steps name their source.
 *
 * Route: #map?project=stave&zoom=files&ref=origin/main&session=<sid>&from=<iso>&to=<iso>&step=<n>
 */
import type { Nav } from "../app";
import type { LiveSession } from "../../shared/types";
import type {
  StructureListResponse,
  StructureMeasured,
  StructureProjectResponse,
  EdgeClass,
} from "../../shared/structure-types";
import type { ReplayResponse, ReplaySessionsResponse, ReplayStep } from "../../shared/replay-types";
import {
  CELL_H,
  CELL_W,
  agentAt,
  blockEdges,
  blockFlow,
  blockRules,
  fileImports,
  layoutFolders,
  layoutMeasured,
  stepTime,
  stepTouches,
  type Block,
  type MapLayout,
  type StepTouch,
} from "./map-model";

type Zoom = "far" | "blocks" | "files";
type Tab = "chat" | "changes" | "notes" | "step";
type Sel = { kind: "block"; id: string } | { kind: "file"; path: string } | null;

interface MapState {
  project: string;
  zoom: Zoom;
  ref: string | null;
  session: string | null;
  from: string | null;
  to: string | null;
  step: number | null; // null = the latest step ("now")
  tab: Tab;
  sel: Sel;
  toggles: { guard: boolean; agents: boolean; flow: boolean; imports: boolean };
  // data
  list: StructureListResponse | null;
  listError: string | null;
  live: LiveSession[] | null;
  liveError: string | null;
  struct: StructureProjectResponse | null;
  structKey: string | null;
  structLoading: boolean;
  structError: string | null;
  layout: MapLayout | null;
  sessions: ReplaySessionsResponse | null;
  sessionsFor: string | null;
  replay: ReplayResponse | null;
  replayKey: string | null;
  replayLoading: boolean;
  replayError: string | null;
  touches: StepTouch[];
  cam: { x: number; y: number; k: number };
  camFor: string | null;
  playing: ReturnType<typeof setInterval> | null;
}

const S: MapState = {
  project: "stave",
  zoom: "blocks",
  ref: null,
  session: null,
  from: null,
  to: null,
  step: null,
  tab: "chat",
  sel: null,
  toggles: { guard: true, agents: true, flow: false, imports: false },
  list: null,
  listError: null,
  live: null,
  liveError: null,
  struct: null,
  structKey: null,
  structLoading: false,
  structError: null,
  layout: null,
  sessions: null,
  sessionsFor: null,
  replay: null,
  replayKey: null,
  replayLoading: false,
  replayError: null,
  touches: [],
  cam: { x: 0, y: 0, k: 1 },
  camFor: null,
  playing: null,
};

let root: HTMLElement | null = null;
let hashListening = false;
let structToken = 0;
let replayToken = 0;

// ── helpers ──────────────────────────────────────────────────────────────

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
const mono = (s: unknown) => `<span class="mono">${esc(s)}</span>`;
const short = (sha: string | null | undefined, n = 8) => (sha ? sha.slice(0, n) : "?");
const hhmmss = (iso: string | null | undefined) => (iso ? iso.slice(11, 19) : "no time");
const dayTime = (iso: string | null | undefined) => (iso ? `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC` : "no time");
const plural = (n: number, w: string, ws = w + "s") => `${n} ${n === 1 ? w : ws}`;
const baseName = (p: string) => {
  const b = p.split("/").pop() ?? p;
  return b.length > 18 ? b.slice(0, 17) + "…" : b;
};
async function getJSON<T>(url: string): Promise<T> {
  const r = await fetch(url);
  const body = await r.json().catch(() => null);
  if (!r.ok && !(body && typeof body === "object" && "status" in body)) throw new Error(`${r.status} ${r.statusText}`);
  return body as T;
}
function measured(): StructureMeasured | null {
  return S.struct && S.struct.status === "measured" ? S.struct : null;
}

const CLASS_WORDS: Record<EdgeClass, string> = {
  internal: "inside one component",
  allowed: "allowed by the design",
  grandfathered: "allowed rule break (the baseline holds it)",
  new: "new rule break (the guard refuses it)",
  unmapped: "outside every component (not examined)",
};

// ── hash route ───────────────────────────────────────────────────────────

function readHash() {
  const h = location.hash;
  if (!h.startsWith("#map")) return;
  const q = new URLSearchParams(h.split("?")[1] ?? "");
  const z = q.get("zoom");
  S.project = q.get("project") || S.project;
  S.zoom = z === "far" || z === "files" || z === "blocks" ? z : S.zoom;
  S.ref = q.get("ref") || null;
  S.session = q.get("session") || null;
  S.from = q.get("from") || null;
  S.to = q.get("to") || null;
  const st = q.get("step");
  S.step = st !== null && st !== "" && !Number.isNaN(+st) ? +st : null;
  const tab = q.get("tab");
  if (tab === "chat" || tab === "changes" || tab === "notes" || tab === "step") S.tab = tab;
  const sel = q.get("sel");
  if (sel?.startsWith("block:")) S.sel = { kind: "block", id: sel.slice(6) };
  else if (sel?.startsWith("file:")) S.sel = { kind: "file", path: sel.slice(5) };
  const t = q.get("show");
  if (t !== null) {
    const on = new Set(t.split(","));
    S.toggles = { guard: on.has("guard"), agents: on.has("agents"), flow: on.has("flow"), imports: on.has("imports") };
  }
}

function writeHash() {
  const q = new URLSearchParams();
  q.set("project", S.project);
  q.set("zoom", S.zoom);
  if (S.ref) q.set("ref", S.ref);
  if (S.session) q.set("session", S.session);
  if (S.from) q.set("from", S.from);
  if (S.to) q.set("to", S.to);
  if (S.step !== null) q.set("step", String(S.step));
  if (S.tab !== "chat") q.set("tab", S.tab);
  if (S.sel) q.set("sel", S.sel.kind === "block" ? `block:${S.sel.id}` : `file:${S.sel.path}`);
  const show = (Object.keys(S.toggles) as (keyof MapState["toggles"])[]).filter((k) => S.toggles[k]).join(",");
  if (show !== "guard,agents") q.set("show", show);
  const next = `#map?${q.toString()}`;
  if (location.hash !== next) history.replaceState(null, "", next);
}

// ── data loading ─────────────────────────────────────────────────────────

async function loadList() {
  if (S.list || S.listError) return;
  try {
    S.list = await getJSON<StructureListResponse>("/api/structure");
  } catch (e) {
    S.listError = `Could not read the project list: ${(e as Error).message}`;
  }
  draw();
}

async function loadLive() {
  try {
    const r = await fetch("/api/sessions");
    if (!r.ok) throw new Error(`${r.status}`);
    S.live = (await r.json()) as LiveSession[];
    S.liveError = null;
  } catch (e) {
    S.liveError = `could not read live sessions (${(e as Error).message})`;
  }
  draw();
}

/** One guard run at a time: a newer request makes an older answer stale, and it is dropped. */
async function loadStructure() {
  const key = `${S.project}@${S.ref ?? ""}`;
  if (S.structKey === key && (S.struct || S.structLoading)) return;
  const token = ++structToken;
  S.structKey = key;
  S.struct = null;
  S.layout = null;
  S.structError = null;
  S.structLoading = true;
  S.camFor = null;
  draw();
  try {
    const q = S.ref ? `?ref=${encodeURIComponent(S.ref)}` : "";
    const r = await getJSON<StructureProjectResponse>(`/api/structure/${encodeURIComponent(S.project)}${q}`);
    if (token !== structToken) return;
    S.struct = r;
    S.layout = r.status === "measured" ? layoutMeasured(r) : r.status === "no-design" ? layoutFolders(r) : null;
  } catch (e) {
    if (token !== structToken) return;
    S.structError = (e as Error).message;
  }
  S.structLoading = false;
  recomputeTouches();
  draw();
}

async function loadSessions() {
  if (S.sessionsFor === S.project) return;
  S.sessionsFor = S.project;
  S.sessions = null;
  try {
    const r = await getJSON<ReplaySessionsResponse>(`/api/replay/sessions?project=${encodeURIComponent(S.project)}`);
    if (S.sessionsFor === S.project) S.sessions = r;
  } catch {
    S.sessions = null;
  }
  drawTimebar();
}

async function loadReplay() {
  if (!S.session) return;
  const key = `${S.session}|${S.from ?? ""}|${S.to ?? ""}`;
  if (S.replayKey === key && (S.replay || S.replayLoading)) return;
  const token = ++replayToken;
  S.replayKey = key;
  S.replay = null;
  S.replayError = null;
  S.replayLoading = true;
  draw();
  try {
    const q = new URLSearchParams();
    if (S.from) q.set("from", S.from);
    if (S.to) q.set("to", S.to);
    const r = await getJSON<ReplayResponse & { error?: string }>(`/api/replay/session/${encodeURIComponent(S.session)}?${q}`);
    if (token !== replayToken) return;
    if (r.error) throw new Error(r.error);
    S.replay = r;
  } catch (e) {
    if (token !== replayToken) return;
    S.replayError = (e as Error).message;
  }
  S.replayLoading = false;
  recomputeTouches();
  if (S.replay && S.step !== null && S.step >= S.replay.steps.length) S.step = null;
  draw();
}

function recomputeTouches() {
  const m = measured();
  S.touches = m && S.replay ? stepTouches(S.replay, m) : [];
}

// ── step helpers ─────────────────────────────────────────────────────────

function steps(): ReplayStep[] {
  return S.replay?.steps ?? [];
}
function curIndex(): number {
  const n = steps().length;
  if (!n) return -1;
  return S.step === null ? n - 1 : Math.max(0, Math.min(n - 1, S.step));
}
function curStep(): ReplayStep | undefined {
  return steps()[curIndex()];
}
function isPast(): boolean {
  const n = steps().length;
  return n > 0 && curIndex() < n - 1;
}
function sourceLabel(s: ReplayStep): string {
  const where =
    s.source === "transcript"
      ? `the session transcript${s.line ? `, line ${s.line}` : ""}`
      : s.source === "commit"
        ? "a git commit, tied to this session by time"
        : s.source === "hook-meter"
          ? "anvi's hook meter"
          : s.source === "hook-log"
            ? "the live hook log"
            : "a guess, not observed";
  const placed = s.placement === "neighbour" ? " (no time of its own: placed by its neighbour)" : "";
  return `Recorded in ${where}${placed}`;
}

// ── scene: far (every project) ───────────────────────────────────────────

const TILE_W = 300;
const TILE_H = 104;
const TILE_COLS = 5;

function farScene(): { svg: string; w: number; h: number } {
  const projects = S.list?.projects ?? [];
  const liveBy = new Map<string, number>();
  for (const l of S.live ?? []) liveBy.set(l.project, (liveBy.get(l.project) ?? 0) + 1);
  let s = "";
  projects.forEach((p, i) => {
    const x = (i % TILE_COLS) * (TILE_W + 30);
    const y = Math.floor(i / TILE_COLS) * (TILE_H + 30);
    const n = liveBy.get(p.name) ?? 0;
    const on = p.name === S.project;
    s += `<g class="map-tile${on ? " on" : ""}${p.hasDesign ? " guarded" : ""}" data-proj="${esc(p.name)}" data-path="${esc(p.path)}" tabindex="0" role="button" aria-label="Open ${esc(p.name)}">
      <rect x="${x}" y="${y}" width="${TILE_W}" height="${TILE_H}" rx="12" class="map-tile-box"/>
      <text x="${x + 16}" y="${y + 34}" class="map-tile-name">${esc(p.name)}${p.sameNameAs?.length ? " ·  same name as another" : ""}</text>
      <text x="${x + 16}" y="${y + 62}" class="map-tile-sub">${
        p.hasDesign ? `design ${esc(p.packages.map((k) => k.designId ?? "?").join(", "))} · guardrails` : "no design · nothing blocked"
      }</text>
      ${
        S.toggles.agents
          ? `<text x="${x + 16}" y="${y + 88}" class="map-tile-agents${n ? " live" : ""}">${
              S.live ? (n ? `${plural(n, "agent")} running now` : "no agent running now") : "agents: not read"
            }</text>`
          : ""
      }
    </g>`;
  });
  const rows = Math.ceil(projects.length / TILE_COLS);
  return { svg: s, w: TILE_COLS * (TILE_W + 30) - 30, h: Math.max(rows, 1) * (TILE_H + 30) - 30 };
}

// ── scene: a project (blocks and files) ──────────────────────────────────

function staticProjectSVG(L: MapLayout): string {
  let s = "";
  for (const b of L.blocks) {
    const cls = b.kind === "component" ? "guarded" : b.kind === "folder" ? "folder" : "outside";
    s += `<g class="map-blk" data-block="${esc(b.id)}"><rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="9" class="map-bord ${cls}"/>`;
    for (const c of b.cells) {
      s += `<g class="map-fc" data-cell="${esc(c.path)}"><title>${esc(c.path)}</title><rect x="${c.x}" y="${c.y}" width="${CELL_W - 4}" height="${CELL_H - 3}" rx="2"/><text x="${c.x + 3}" y="${c.y + 8.4}" class="map-flabel">${esc(baseName(c.rel))}</text></g>`;
    }
    if (b.subfolders) {
      b.subfolders.slice(0, 8).forEach((f, i) => {
        s += `<text x="${b.x + 12}" y="${b.y + 30 + i * CELL_H + 10}" class="map-sublabel">${esc(f.path)}/ · ${f.total}</text>`;
      });
      if (b.subfolders.length > 8)
        s += `<text x="${b.x + 12}" y="${b.y + 30 + 8 * CELL_H + 10}" class="map-sublabel dim">${b.subfolders.length - 8} more folders</text>`;
    }
    s += `</g>`;
  }
  return s;
}

function curve(ax: number, ay: number, bx: number, by: number, bend: number) {
  const mx = (ax + bx) / 2 + bend;
  const my = (ay + by) / 2;
  return `M${ax.toFixed(1)} ${ay.toFixed(1)} Q${mx.toFixed(1)} ${my.toFixed(1)} ${bx.toFixed(1)} ${by.toFixed(1)}`;
}

/**
 * Where an arrow leaves A and enters B. Arrows going down leave A's bottom and
 * enter B's top, spread along the side by the other end's position so they do
 * not all meet in one point; arrows going up run along the right-hand sides.
 */
function anchor(A: Block, B: Block, ports: Map<string, number[]>) {
  const spread = (blk: Block, side: string, otherX: number) => {
    const xs = ports.get(`${blk.id}|${side}`) ?? [otherX];
    const i = Math.max(0, xs.indexOf(otherX));
    return blk.x + (blk.w * (i + 1)) / (xs.length + 1);
  };
  const down = B.y > A.y + 1;
  const up = B.y < A.y - 1;
  const aMid = A.x + A.w / 2;
  const bMid = B.x + B.w / 2;
  if (down) return { a: { x: spread(A, "bottom", bMid), y: A.y + A.h }, b: { x: spread(B, "top", aMid), y: B.y }, bend: 0 };
  if (up) return { a: { x: A.x + A.w, y: A.y + A.h / 2 }, b: { x: B.x + B.w, y: B.y + B.h / 2 }, bend: 160 };
  const right = B.x > A.x;
  return { a: { x: right ? A.x + A.w : A.x, y: A.y + A.h / 2 }, b: { x: right ? B.x : B.x + B.w, y: B.y + B.h / 2 }, bend: 0 };
}

/** For each block side, the sorted x of the blocks its downward arrows meet, so anchor() can spread them. */
function portsFor(L: MapLayout, edges: { from: string; to: string }[]): Map<string, number[]> {
  const ports = new Map<string, number[]>();
  const add = (k: string, x: number) => {
    const l = ports.get(k) ?? [];
    if (!l.includes(x)) l.push(x);
    ports.set(k, l);
  };
  for (const e of edges) {
    const A = L.byId.get(e.from);
    const B = L.byId.get(e.to);
    if (!A || !B || !(B.y > A.y + 1)) continue;
    add(`${A.id}|bottom`, B.x + B.w / 2);
    add(`${B.id}|top`, A.x + A.w / 2);
  }
  for (const l of ports.values()) l.sort((a, b) => a - b);
  return ports;
}

interface DynCounts {
  fileEdges: number;
  blockEdges: number;
}

function dynProjectSVG(L: MapLayout, counts: DynCounts): string {
  const m = measured();
  const k = S.cam.k;
  const inv = 1 / k;
  const lbl = (x: number, y: number, html: string, cls: string, anchorAttr = "") =>
    `<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${inv.toFixed(4)})"><text class="${cls}"${anchorAttr}>${html}</text></g>`;
  let s = "";
  const selBlock = S.sel?.kind === "block" ? S.sel.id : null;
  const selFile = S.sel?.kind === "file" ? S.sel.path : null;

  // block titles, always readable
  for (const b of L.blocks) {
    s += lbl(b.x + 8, b.y - 6, `${esc(b.id)}<tspan class="map-bcount" dx="8">${b.count}${b.kind === "folder" ? " files" : ""}</tspan>`, `map-btitle${b.kind === "component" ? " mono" : ""}`);
  }

  // block-level arrows: the guard's classes per pair, and declared pairs no import uses
  // (Up close the file lines carry the classes; block arrows would only cover them.)
  if (m && S.toggles.guard && !S.toggles.flow && k < 1.5) {
    // Labels that would land on one another move down a line (sizes in screen pixels).
    const placed: { x: number; y: number }[] = [];
    const place = (x: number, y: number) => {
      while (placed.some((p) => Math.abs(p.x - x) < 150 * inv && Math.abs(p.y - y) < 15 * inv)) y += 16 * inv;
      placed.push({ x, y });
      return { x, y };
    };
    const all = blockEdges(m);
    const ports = portsFor(L, all);
    for (const e of all) {
      const A = L.byId.get(e.from);
      const B = L.byId.get(e.to);
      if (!A || !B) continue;
      const { a, b, bend } = anchor(A, B, ports);
      const hot = selBlock === e.from || selBlock === e.to;
      const dim = selBlock && !hot ? " dim" : "";
      const allowed = e.byClass.allowed + e.byClass.unmapped;
      const breaks = e.byClass.grandfathered;
      const fresh = e.byClass.new;
      if (e.total === 0) {
        s += `<path d="${curve(a.x, a.y, b.x, b.y, bend - 30)}" class="map-cedge declared${dim}${hot ? " hot" : ""}"><title>declared, no import uses it: ${esc(e.from)} → ${esc(e.to)}</title></path>`;
        counts.blockEdges++;
      }
      if (allowed > 0) {
        s += `<path d="${curve(a.x, a.y, b.x, b.y, bend)}" class="map-cedge ok${dim}${hot ? " hot" : ""}" stroke-width="${Math.min(1 + Math.log2(allowed + 1) * 0.6, 4).toFixed(2)}" marker-end="url(#map-m-ok)"><title>${plural(allowed, "import")} allowed: ${esc(e.from)} → ${esc(e.to)}</title></path>`;
        counts.blockEdges++;
      }
      if (breaks > 0) {
        s += `<path d="${curve(a.x, a.y, b.x, b.y, bend + 40)}" class="map-cedge brk${dim}" marker-end="url(#map-m-brk)"><title>${plural(breaks, "allowed rule break")}: ${esc(e.from)} → ${esc(e.to)}</title></path>`;
        const at = place((a.x + b.x) / 2 + (bend + 40) / 2 + 8, (a.y + b.y) / 2);
        s += lbl(at.x, at.y, `${plural(breaks, "allowed rule break")}`, "map-elabel warn");
        counts.blockEdges++;
      }
      if (fresh > 0) {
        s += `<path d="${curve(a.x, a.y, b.x, b.y, bend + 70)}" class="map-cedge new${dim}" marker-end="url(#map-m-new)"><title>${plural(fresh, "new rule break")}: ${esc(e.from)} → ${esc(e.to)}</title></path>`;
        const at = place((a.x + b.x) / 2 + (bend + 70) / 2 + 8, (a.y + b.y) / 2 + 16);
        s += lbl(at.x, at.y, `${fresh} new, refused`, "map-elabel bad");
        counts.blockEdges++;
      }
    }
  }

  // file-level imports: every import, or the selected file's
  // Up close with guardrails on, every rule break is drawn file to file.
  const breaksUpClose = S.toggles.guard && k >= 1.5;
  if (m && (S.toggles.imports || selFile || breaksUpClose)) {
    const d = { ok: "", brk: "", nw: "", out: "", inn: "" };
    for (const e of m.edges) {
      const isBreak = e.class === "grandfathered" || e.class === "new";
      if (!S.toggles.imports && e.from !== selFile && e.to !== selFile && !(breaksUpClose && isBreak)) continue;
      const A = L.cellByPath.get(e.from);
      const B = L.cellByPath.get(e.to);
      if (!A || !B) continue;
      const p = curve(A.cx, A.cy, B.cx, B.cy, 14) + " ";
      if (e.class === "new") d.nw += p;
      else if (e.class === "grandfathered") d.brk += p;
      else if (selFile && e.from === selFile) d.out += p;
      else if (selFile && e.to === selFile) d.inn += p;
      else d.ok += p;
      counts.fileEdges++;
    }
    if (d.ok) s += `<path d="${d.ok}" class="map-fedge"/>`;
    if (d.out) s += `<path d="${d.out}" class="map-fedge out"/>`;
    if (d.inn) s += `<path d="${d.inn}" class="map-fedge inn"/>`;
    if (d.brk) s += `<path d="${d.brk}" class="map-fedge brk"/>`;
    if (d.nw) s += `<path d="${d.nw}" class="map-fedge new"/>`;
  }

  // selection outlines
  if (selBlock) {
    const b = L.byId.get(selBlock);
    if (b) s += `<rect x="${b.x - 3}" y="${b.y - 3}" width="${b.w + 6}" height="${b.h + 6}" rx="11" class="map-selblk"/>`;
  }
  if (selFile) {
    const c = L.cellByPath.get(selFile);
    if (c) s += `<rect x="${c.x - 1.5}" y="${c.y - 1.5}" width="${CELL_W - 1}" height="${CELL_H}" rx="3" class="map-selcell"/>`;
  }

  // agents: the replayed session, over the files it touched up to the step
  if (S.replay && S.touches.length && (S.toggles.agents || S.toggles.flow)) {
    const at = curIndex();
    if (S.toggles.flow) {
      const flow = blockFlow(S.touches, at, (mod) => L.cellByPath.get(mod)?.block ?? null);
      const seen = new Map<string, number>();
      const pts = flow.map((b) => {
        const B = L.byId.get(b)!;
        const n = (seen.get(b) ?? 0) + 1;
        seen.set(b, n);
        return { x: B.x + B.w / 2 + (n - 1) * 26, y: B.y + B.h / 2, b };
      });
      for (let i = 1; i < pts.length; i++)
        s += `<path d="${curve(pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y, i % 2 ? 90 : -90)}" class="map-flowline" marker-end="url(#map-m-flow)"/>`;
      pts.forEach((p, i) => {
        s += `<g transform="translate(${p.x.toFixed(1)} ${p.y.toFixed(1)}) scale(${Math.min(inv, 2.4).toFixed(4)})"><circle r="11" class="map-flowdot"/><text y="4" text-anchor="middle" class="map-flownum">${i + 1}</text></g>`;
      });
    }
    if (S.toggles.agents) {
      const shellCells = new Set<string>();
      for (const t of S.touches) if (t.seq <= at && t.shellWrite) for (const mod of t.modules) shellCells.add(mod);
      const { last, trail } = agentAt(S.touches, at);
      for (const mod of trail) {
        const c = L.cellByPath.get(mod);
        if (!c) continue;
        s += `<rect x="${c.x - 1}" y="${c.y - 1}" width="${CELL_W - 2}" height="${CELL_H - 1}" rx="3" class="map-trail${shellCells.has(mod) ? " shell" : ""}"><title>${esc(mod)}${shellCells.has(mod) ? " · edited through the shell: checked at merge, not at edit" : ""}</title></rect>`;
      }
      const pts = trail.map((t) => L.cellByPath.get(t)).filter((c): c is NonNullable<typeof c> => !!c);
      for (let i = 1; i < pts.length; i++) s += `<path d="${curve(pts[i - 1].cx, pts[i - 1].cy, pts[i].cx, pts[i].cy, 30)}" class="map-trailline"/>`;
      if (last) {
        const c = L.cellByPath.get(last)!;
        const cur = S.touches[at];
        const st = curStep();
        const verb = cur && cur.modules.length ? (cur.shellWrite ? "Shell edit" : cur.how === "commit" ? "Commit" : st?.tool ?? "Touch") : "Last touched";
        const tag = `${verb} ${baseName(last)}`;
        const sc = Math.min(inv, 4);
        s += `<g class="map-avatar" transform="translate(${c.cx.toFixed(1)} ${(c.cy - 6).toFixed(1)}) scale(${sc.toFixed(4)})"><circle r="12" class="map-av"/><text y="4" text-anchor="middle" class="map-avl">A</text><g transform="translate(16 -10)"><rect width="${Math.max(110, tag.length * 6.6 + 16)}" height="20" rx="6" class="map-avtag"/><text x="8" y="14" class="map-avtext">${esc(tag)}</text></g></g>`;
      }
    }
  }
  return s;
}

// ── camera ───────────────────────────────────────────────────────────────

function svgSize(): { w: number; h: number } {
  const svg = root?.querySelector<SVGSVGElement>(".map-svg");
  const r = svg?.getBoundingClientRect();
  return { w: r?.width || 1000, h: r?.height || 640 };
}

function fit(w: number, h: number, pad = 40, x0 = 0, y0 = 0) {
  const { w: vw, h: vh } = svgSize();
  const k = Math.min(vw / (w + pad * 2), vh / (h + pad * 2));
  S.cam = { k, x: x0 - pad - (vw / k - w - pad * 2) / 2, y: y0 - pad - (vh / k - h - pad * 2) / 2 };
}

/** Camera for the current zoom level. "files" centres on the selection, else on the agent, else on the biggest block. */
function placeCamera() {
  if (S.zoom === "far") {
    const f = farScene();
    fit(f.w, f.h, 30);
    return;
  }
  const L = S.layout;
  if (!L) return;
  if (S.zoom === "blocks" || !L.cellByPath.size) {
    fit(L.width, L.height, 50);
    return;
  }
  const { w: vw, h: vh } = svgSize();
  const k = 2.4;
  let cx: number | null = null;
  let cy: number | null = null;
  if (S.sel?.kind === "file") {
    const c = L.cellByPath.get(S.sel.path);
    if (c) [cx, cy] = [c.cx, c.cy];
  } else if (S.sel?.kind === "block") {
    const b = L.byId.get(S.sel.id);
    if (b) [cx, cy] = [b.x + Math.min(b.w, vw / k) / 2, b.y + Math.min(b.h, vh / k) / 2];
  }
  if (cx === null) {
    const last = agentAt(S.touches, curIndex()).last;
    const c = last ? L.cellByPath.get(last) : null;
    if (c) [cx, cy] = [c.cx, c.cy];
  }
  if (cx === null) {
    const b = [...L.blocks].sort((a, b) => b.count - a.count)[0];
    [cx, cy] = [b.x + Math.min(b.w, vw / k) / 2, b.y + Math.min(b.h, vh / k) / 2];
  }
  S.cam = { k, x: cx - vw / k / 2, y: cy! - vh / k / 2 };
}

function lodClass(): string {
  if (S.zoom === "far") return "lod-far";
  return S.cam.k >= 1.5 ? "lod-files" : "lod-blocks";
}

function applyCamera() {
  const world = root?.querySelector<SVGGElement>(".map-world");
  if (!world) return;
  const { x, y, k } = S.cam;
  world.setAttribute("transform", `translate(${(-x * k).toFixed(2)} ${(-y * k).toFixed(2)}) scale(${k.toFixed(4)})`);
  const svg = root!.querySelector(".map-svg")!;
  svg.setAttribute("class", `map-svg ${lodClass()}${S.toggles.guard ? " guard" : ""}`);
}

// ── drawing ──────────────────────────────────────────────────────────────

let staticFor: string | null = null;

function draw() {
  if (!root || !root.isConnected) return;
  writeHash();
  // Everything that can change the map's size first, so the camera fits the final box.
  drawBar();
  drawHead();
  drawPanel();
  drawTimebar();
  drawScene();
  drawInspector();
}

function drawScene() {
  if (!root) return;
  const t0 = performance.now();
  const stat = root.querySelector<SVGGElement>(".map-static")!;
  const dyn = root.querySelector<SVGGElement>(".map-dyn")!;
  const msg = root.querySelector<HTMLElement>(".map-msg")!;
  msg.textContent = "";
  msg.style.display = "none";
  const counts: DynCounts = { fileEdges: 0, blockEdges: 0 };
  let cells = 0;
  let rebuiltStatic = false;

  if (S.zoom === "far") {
    if (staticFor !== "far|" + (S.live?.length ?? -1) + "|" + S.toggles.agents + "|" + S.project) {
      const f = farScene();
      stat.innerHTML = f.svg;
      staticFor = "far|" + (S.live?.length ?? -1) + "|" + S.toggles.agents + "|" + S.project;
    }
    dyn.innerHTML = "";
    if (!S.list) showMsg(S.listError ?? "Reading the project list…");
    if (S.camFor !== "far") {
      placeCamera();
      S.camFor = "far";
    }
  } else {
    const L = S.layout;
    if (!L) {
      stat.innerHTML = "";
      dyn.innerHTML = "";
      staticFor = null;
      if (S.structLoading) showMsg(`Measuring ${S.project}${S.ref ? ` at ${S.ref}` : ""} with anvi's structure guard (a cold run takes about 2 seconds)…`);
      else if (S.structError) showMsg(`Could not read the map: ${S.structError}`);
      else if (S.struct && S.struct.status !== "measured" && S.struct.status !== "no-design")
        showMsg(`${S.struct.status === "could-not-read" ? "Could not read" : "Not measured"}: ${S.struct.reason}`);
    } else {
      const key = `${S.structKey}`;
      if (staticFor !== key) {
        stat.innerHTML = staticProjectSVG(L);
        staticFor = key;
        rebuiltStatic = true;
      }
      cells = L.cellByPath.size;
      const camKey = `${S.structKey}|${S.zoom}`;
      if (S.camFor !== camKey) {
        placeCamera();
        S.camFor = camKey;
      }
      dyn.innerHTML = dynProjectSVG(L, counts);
    }
  }
  applyCamera();
  const ms = performance.now() - t0;
  // Force the browser to lay the drawing out, so the figure includes layout, not only building the markup.
  root.querySelector<SVGGElement>(".map-world")!.getBBox();
  const withLayout = performance.now() - t0;
  const view = root;
  view.dataset.renderMs = ms.toFixed(1);
  view.dataset.layoutMs = withLayout.toFixed(1);
  if (rebuiltStatic) view.dataset.fullRenderMs = withLayout.toFixed(1);
  view.dataset.cells = String(cells);
  view.dataset.fileEdges = String(counts.fileEdges);
  view.dataset.blockEdges = String(counts.blockEdges);
  view.dataset.zoom = S.zoom;
  view.dataset.ready = String(S.zoom === "far" ? !!S.list : !!S.layout);
  const rt = root.querySelector<HTMLElement>(".map-rt");
  if (rt) rt.textContent = `drawn in ${withLayout.toFixed(0)} ms (this browser, last draw) · ${cells} files · ${counts.fileEdges} import lines · ${counts.blockEdges} block arrows`;
}

function showMsg(t: string) {
  const msg = root!.querySelector<HTMLElement>(".map-msg")!;
  msg.textContent = t;
  msg.style.display = "";
}

function drawBar() {
  if (!root) return;
  root.querySelectorAll<HTMLButtonElement>(".map-levels button").forEach((b) => b.classList.toggle("on", b.dataset.zoom === S.zoom));
  root.querySelectorAll<HTMLButtonElement>(".map-toggles button").forEach((b) => {
    const k = b.dataset.t as keyof MapState["toggles"];
    b.classList.toggle("on", S.toggles[k]);
    b.setAttribute("aria-pressed", String(S.toggles[k]));
  });
  const sel = root.querySelector<HTMLSelectElement>(".map-project")!;
  const names = S.list?.projects.map((p) => p.name) ?? [S.project];
  if (!names.includes(S.project)) names.unshift(S.project);
  if (sel.dataset.names !== names.join("|")) {
    sel.innerHTML = names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join("");
    sel.dataset.names = names.join("|");
  }
  sel.value = S.project;
  const ref = root.querySelector<HTMLInputElement>(".map-ref")!;
  if (document.activeElement !== ref) ref.value = S.ref ?? "";
  const go = root.querySelector<HTMLButtonElement>(".map-ref-go")!;
  go.disabled = S.structLoading;
}

function drawHead() {
  const el = root!.querySelector<HTMLElement>(".map-head")!;
  if (S.zoom === "far") {
    const n = S.list?.projects.length ?? 0;
    const d = S.list?.projects.filter((p) => p.hasDesign).length ?? 0;
    const liveN = S.live?.length ?? 0;
    el.innerHTML = `<b>${plural(n, "project")}</b> · ${d} with a design (guardrails), ${n - d} with none (nothing blocked)
      <div class="map-src">Projects: ${mono("GET /api/structure")} (anvi's registry${S.list?.registry.locked ? `, lock ${mono(S.list.registry.locked)}` : ""}). Agents: ${
        S.liveError ? esc(S.liveError) : `${plural(liveN, "live session")} from ${mono("GET /api/sessions")}`
      }. Click a project to open it.</div>`;
    return;
  }
  const st = S.struct;
  if (!st) {
    el.innerHTML = `<b>${esc(S.project)}</b> <span class="dim">${S.structLoading ? "measuring…" : ""}</span>`;
    return;
  }
  if (st.status === "measured") {
    const c = st.counts;
    el.innerHTML = `<b>${esc(st.project)}</b> · ${mono(st.package.dir.split("/").slice(-2).join("/"))} · ${c.modules} modules · ${c.edges} imports · design ${mono(st.designId)}
      <div class="map-counts">Between components (${c.examinedBetweenComponents} examined): <span>${c.byClass.allowed} allowed</span> · <span class="s-warn">${c.divergence.grandfathered} allowed rule breaks</span> · <span class="${c.divergence.new ? "s-bad" : ""}">${c.divergence.new} new</span> · <span class="${c.divergence.fixed ? "s-ok" : ""}">${c.divergence.fixed} fixed</span> <span class="dim">(baseline holds ${c.baselineKeys.divergence})</span> · cycles: ${c.cycle.total} (${c.cycle.new} new) · inside one component: ${c.byClass.internal} · outside every component: ${c.byClass.unmapped}</div>
      <div class="map-src">Measured ${mono(st.measuredAt.ref)} at ${mono(short(st.measuredAt.sha))}${st.measuredAt.date ? ` (${esc(st.measuredAt.date)})` : ""} by anvi's structure guard ${mono("sha256:" + short(st.source.guard.sha256, 12))} · ${
        st.timing.cache === "hit" ? "cached answer" : `guard run ${st.timing.guardMs ?? "?"} ms`
      }${st.timing.queuedMs ? `, waited ${st.timing.queuedMs} ms for a free slot` : ""} · ${mono(`GET /api/structure/${st.project}${S.ref ? `?ref=${S.ref}` : ""}`)}</div>`;
    return;
  }
  if (st.status === "no-design") {
    el.innerHTML = `<b>${esc(st.project)}</b> · <span class="map-nothing">no design · nothing blocked</span> · ${st.files} files in ${st.folders.length} folders
      <div class="map-src">Folders only: a project with no design has no guardrails, so every border here is a folder. Read from ${
        st.treeFrom === "git" ? `the files git tracks at ${mono(st.measuredAt?.ref ?? "?")} ${mono(short(st.measuredAt?.sha))}` : "the folder as it is on disk (not a git checkout)"
      } · ${mono(`GET /api/structure/${st.project}`)}</div>`;
    return;
  }
  el.innerHTML = `<b>${esc(st.project)}</b> · <span class="s-bad">${st.status === "could-not-read" ? "could not read" : "not measured"}</span>
    <div class="map-src">${esc(st.reason)}</div>`;
}

function drawInspector() {
  const el = root!.querySelector<HTMLElement>(".map-insp")!;
  let h = "";
  const m = measured();
  const close = `<button class="map-x" type="button" data-unsel aria-label="Close">✕</button>`;
  if (S.zoom !== "far" && S.sel?.kind === "block") {
    const b = S.layout?.byId.get(S.sel.id);
    if (b && b.kind === "folder") {
      h = `<div class="map-insp-top"><b class="mono">${esc(b.id)}/</b>${close}</div>
        <div>No design declared for ${esc(S.project)}, so this border is a folder, not a guardrail. <b>Nothing is blocked here.</b></div>
        <div class="dim">${b.count} files below it${b.subfolders?.length ? ` · ${b.subfolders.length} sub-folders` : ""}</div>`;
    } else if (m && b) {
      const r = blockRules(m, b.id);
      h = `<div class="map-insp-top"><b class="mono">${esc(b.id)}</b>${close}</div>
        <div class="dim">${b.count} modules${r.dirs.length ? ` · folders ${r.dirs.map(mono).join(", ")}` : ""}</div>
        ${r.why ? `<div>${esc(r.why)}</div>` : ""}
        <div><span class="s-ok">May use:</span> ${r.mayUse.length ? r.mayUse.map(mono).join(", ") : "nothing outside itself"}</div>
        <div><span class="dim">May be used by:</span> ${r.usedBy.length ? r.usedBy.map(mono).join(", ") : "nobody"}</div>
        ${
          r.notes.length
            ? `<div class="map-insp-notes"><div class="dim">What the design says about these pairs:</div>${r.notes
                .map((n) => `<div>${mono(n.pair)}: ${esc(n.note)}</div>`)
                .join("")}</div>`
            : ""
        }
        ${
          r.breaks.length
            ? `<div class="s-warn">${plural(r.breaks.length, "import breaks", "imports break")} the design here (${r.breaks.filter((e) => e.class === "new").length} new):</div><div class="map-insp-list">${r.breaks
                .slice(0, 12)
                .map((e) => `<div class="mono ${e.class === "new" ? "s-bad" : "s-warn"}">${esc(e.from)} → ${esc(e.to)}</div>`)
                .join("")}${r.breaks.length > 12 ? `<div class="dim">${r.breaks.length - 12} more</div>` : ""}</div>`
            : ""
        }
        <div class="dim">Any other import between components is a rule break; the guard refuses new ones (design ${mono(m.designId)}).</div>`;
    } else if (b) {
      h = `<div class="map-insp-top"><b>${esc(b.id)}</b>${close}</div><div>${b.count} modules outside every component: the divergence rule does not examine them.</div>`;
    }
  } else if (S.zoom !== "far" && S.sel?.kind === "file" && m) {
    const selPath = S.sel.path;
    const { out, inn } = fileImports(m, selPath);
    const mod = m.modules.find((x) => x.path === selPath);
    const row = (e: (typeof out)[number], other: string) =>
      `<div class="map-imp ${e.class}"><span class="mono">${esc(other)}</span> <span class="dim">${esc(CLASS_WORDS[e.class])}${e.typeOnly ? ", types only" : ""}</span></div>`;
    h = `<div class="map-insp-top"><b class="mono">${esc(selPath)}</b>${close}</div>
      <div class="dim">in ${mono(mod?.component ?? "no component")} · imports ${out.length} · imported by ${inn.length}</div>
      <div class="map-insp-list"><div class="dim">Imports (white lines):</div>${out.slice(0, 20).map((e) => row(e, e.to)).join("") || '<div class="dim">none</div>'}${out.length > 20 ? `<div class="dim">${out.length - 20} more</div>` : ""}
      <div class="dim">Imported by (blue lines):</div>${inn.slice(0, 20).map((e) => row(e, e.from)).join("") || '<div class="dim">none</div>'}${inn.length > 20 ? `<div class="dim">${inn.length - 20} more</div>` : ""}</div>`;
  }
  el.innerHTML = h;
  el.style.display = h ? "" : "none";
}

// ── right panel ──────────────────────────────────────────────────────────

function drawPanel() {
  const el = root!.querySelector<HTMLElement>(".map-panel")!;
  const tabs: [Tab, string][] = [
    ["chat", "Chat"],
    ["changes", "Changes"],
    ["notes", "Notes used"],
    ["step", "Step & sources"],
  ];
  const head = `<div class="map-tabs" role="tablist">${tabs
    .map(([k, l]) => `<button type="button" role="tab" data-tab="${k}" class="${S.tab === k ? "on" : ""}" aria-selected="${S.tab === k}">${l}</button>`)
    .join("")}</div>`;
  let body = "";
  if (!S.session) body = `<div class="map-empty">No agent session chosen. Pick one in the bar under the map to replay what it did.</div>`;
  else if (S.replayLoading) body = `<div class="map-empty">Reading the session's transcript, notes and commits…</div>`;
  else if (S.replayError) body = `<div class="map-empty s-bad">Could not read the replay: ${esc(S.replayError)}</div>`;
  else if (S.replay) {
    const hist = isPast()
      ? `<div class="map-hist"><span>Viewing a past step (${curIndex() + 1} of ${steps().length}). Past steps are read-only.</span><button type="button" class="map-btn sm" data-now>Back to now</button></div>`
      : "";
    body = hist + (S.tab === "chat" ? panelChat() : S.tab === "changes" ? panelChanges() : S.tab === "notes" ? panelNotes() : panelStep());
  }
  el.innerHTML = head + `<div class="map-panel-body">${body}</div>`;
}

function shellBadge(t: StepTouch | undefined): string {
  if (!t || !t.shellWrite) return "";
  return `<div class="map-shell">
    <div><b>Edited through the shell</b> (the replay's guess from the command text).</div>
    <div>Design rules: <b>${esc(t.designRules ?? "not confirmed")}</b>.</div>
    <div>Notes: ${esc(t.notesGap ?? "no notes given for these files")}.</div>
    <div class="dim">Files named in the command, on the map: ${t.modules.length ? t.modules.map(mono).join(", ") : "none"}.</div>
    ${t.offMap.length ? `<div class="dim">Changed files it names that the guard's graph does not hold: ${t.offMap.map(mono).join(", ")}.</div>` : ""}
  </div>`;
}

function panelChat(): string {
  const s = curStep();
  if (!s) return `<div class="map-empty">This window has no steps.</div>`;
  const t = S.touches[curIndex()];
  const note = s.kind === "injection" ? S.replay!.notes.items.find((n) => n.id === (s.detail?.noteId as number)) : undefined;
  let what = "";
  if (s.kind === "tool") {
    what = `<div><b>${esc(s.tool ?? "tool")}</b>${s.filePath ? ` ${mono(s.filePath)}` : ""}</div>`;
    if (s.command) what += `<div class="dim">The command, as the transcript records it:</div><pre class="map-pre">${esc(s.command.slice(0, 4000))}${s.command.length > 4000 ? "\n…" : ""}</pre>`;
  } else if (s.kind === "injection") {
    what = `<div><b>anvi gave the agent a note</b> (${esc(s.hookName ?? "hook")}, ${note ? `${note.size} bytes` : "size unknown"})</div>${
      note ? `<pre class="map-pre prose">${esc((note.text ?? note.preview).slice(0, 3000))}</pre>` : ""
    }`;
  } else if (s.kind === "commit") {
    what = `<div><b>Commit</b> ${mono(short(s.sha))}</div><div>${esc(s.subject ?? "")}</div>`;
  } else if (s.kind === "pr") {
    what = `<div><b>Pull request</b> ${mono(`#${s.pr}`)} ${s.repo ? mono(s.repo) : ""}</div><div class="dim">The transcript links this PR here.</div>`;
  } else {
    what = `<div><b>${esc(s.kind)}</b> ${esc(s.hookName ?? "")}</div>`;
  }
  return `<div class="map-stack">
    <div class="map-steph">Step ${curIndex() + 1} of ${steps().length} · ${esc(dayTime(stepTime(s)))}</div>
    <div class="dim">${esc(sourceLabel(s))}</div>
    ${what}
    ${shellBadge(t)}
    <div class="map-unavail">The agent's own words at this step: <b>not available</b>. The replay carries tool calls, notes and commits, not the agent's messages.</div>
    <div class="dim">AnviDeck only reads: there is no message box.</div>
  </div>`;
}

function changeTime(f: ReplayResponse["changes"]["files"][number]): string | null {
  const r = S.replay!;
  const times: string[] = [];
  if (f.how.includes("tool")) {
    const s = r.steps.find((x) => x.filePath === f.path || (f.toolEdit && x.filePath === f.toolEdit.path));
    const t = stepTime(s) ?? f.toolEdit?.ts ?? null;
    if (t) times.push(t);
  }
  if (f.sha) {
    const c = r.commits.find((c) => c.sha === f.sha);
    if (c) times.push(c.committedAt);
  } else if (f.how.includes("commit")) {
    for (const c of r.commits) if (c.files.some((x) => f.path.endsWith("/" + x.path))) times.push(c.committedAt);
  }
  if (f.pr) {
    const p = r.prs.find((p) => p.number === f.pr);
    if (p) times.push(p.firstSeen);
  }
  return times.sort()[0] ?? null;
}

function panelChanges(): string {
  const r = S.replay!;
  const now = stepTime(curStep());
  const files = r.changes.files;
  if (r.changes.status !== "ok" && !files.length)
    return `<div class="map-empty">${r.changes.status === "none" ? "Nothing changed in this window." : `Could not read the changes (${esc(r.changes.status)}${r.changes.detail ? `: ${esc(r.changes.detail)}` : ""}).`}</div>`;
  const shell = files.filter((f) => f.viaShell).length;
  const rows = files
    .map((f) => {
      const t = changeTime(f);
      const later = !!(now && t && t > now);
      return `<div class="map-chg${later ? " later" : ""}">
        <div class="mono map-path">${esc(f.path.replace(/^.*\/projects\//, ""))}</div>
        <div class="dim">${f.how.map((h) => (h === "tool" ? "Edit/Write call" : h === "commit" ? "attributed commit" : "the PR's files")).join(" · ")}${f.status ? ` · ${mono(f.status)}` : ""}${f.additions !== undefined ? ` · +${f.additions} −${f.deletions ?? 0}` : ""}${t ? ` · ${hhmmss(t)}` : ""}${later ? " · after this step" : ""}</div>
        ${f.viaShell ? `<div class="map-shell-line">Through the shell · design rules: <b>${esc(f.designRules ?? "not confirmed")}</b> · ${esc(f.notesGap ?? "no notes given for these files")}</div>` : ""}
      </div>`;
    })
    .join("");
  return `<div class="map-stack"><div class="dim">${plural(files.length, "file")} changed in the window, ${shell} only through the shell or a commit. From: Edit/Write calls in the transcript, commits tied to the session, and ${mono("gh pr view")}.</div>${rows}</div>`;
}

function panelNotes(): string {
  const r = S.replay!;
  const now = stepTime(curStep());
  if (r.notes.status !== "ok" && !r.notes.items.length)
    return `<div class="map-empty">${r.notes.status === "none" ? "anvi gave this agent no notes in this window." : `Could not read the notes (${esc(r.notes.status)}${r.notes.detail ? `: ${esc(r.notes.detail)}` : ""}).`}</div>`;
  const items = r.notes.items.filter((n) => !now || !n.ts || n.ts <= now);
  const cur = curStep();
  const shellAny = S.touches.some((t) => t.seq <= curIndex() && t.shellWrite);
  return `<div class="map-stack">
    <div class="dim">${items.length} of ${plural(r.notes.items.length, "note")} given up to this step, read from the transcript${r.sources.hookMeter.status === "ok" ? " and anvi's hook meter" : ""}.</div>
    ${shellAny ? `<div class="map-shell-line">Edits made through the shell got no notes for their files: the per-file notes fire on the Edit and Write tools only.</div>` : ""}
    ${items
      .map(
        (n) => `<div class="map-note${cur?.noteIds?.includes(n.id) || cur?.detail?.noteId === n.id ? " cur" : ""}">
        <div><b>${esc(n.hookName)}</b> <span class="dim">${esc(hhmmss(n.ts))} · ${n.size} bytes${n.meter?.length ? ` · metered as ${esc(n.meter.map((x) => x.hook).join(", "))}` : ""}</span></div>
        <div class="map-note-text">${esc(n.preview.slice(0, 400))}${n.preview.length > 400 ? "…" : ""}</div></div>`
      )
      .join("")}
  </div>`;
}

function srcRow(name: string, s: { status: string; path?: string; detail?: string; count?: number } | undefined) {
  if (!s) return "";
  return `<dt>${esc(name)}</dt><dd><span class="${s.status === "ok" ? "" : s.status === "none" ? "dim" : s.status === "skipped" ? "dim" : "s-bad"}">${esc(s.status)}</span>${s.count !== undefined ? ` · ${s.count} rows` : ""}${s.path ? ` · ${mono(s.path)}` : ""}${s.detail ? ` · ${esc(s.detail)}` : ""}</dd>`;
}

function panelStep(): string {
  const r = S.replay!;
  const s = curStep();
  const t = S.touches[curIndex()];
  const st = S.struct;
  let structInfo = "";
  if (st?.status === "measured") {
    structInfo = `<dt>map</dt><dd>${mono(st.measuredAt.ref)} at ${mono(st.measuredAt.sha)}</dd>
      <dt>why this commit</dt><dd>${esc(st.measuredAt.why)}</dd>
      <dt>guard</dt><dd>${mono(st.source.label)}</dd>
      <dt>design</dt><dd>${mono(st.designId)}${st.baselineDesignId && st.baselineDesignId !== st.designId ? ` (baseline written for ${mono(st.baselineDesignId)})` : ""}</dd>
      <dt>graph</dt><dd>${esc(st.extractor)} · type-only imports: ${esc(st.typeOnlyImports)}</dd>`;
  } else if (st?.status === "no-design") {
    structInfo = `<dt>map</dt><dd>folders only (no design), ${st.measuredAt ? `${mono(st.measuredAt.ref)} at ${mono(st.measuredAt.sha)}` : "read from disk"}</dd>`;
  }
  return `<div class="map-stack">
    ${
      s
        ? `<div class="map-steph">Step ${curIndex() + 1} of ${steps().length}</div><dl class="map-kv">
      <dt>time</dt><dd>${esc(dayTime(stepTime(s)))}${s.placement === "neighbour" ? " (placed by its neighbour)" : ""}</dd>
      <dt>kind</dt><dd>${esc(s.kind)}${s.tool ? ` · ${esc(s.tool)}` : ""}</dd>
      <dt>source</dt><dd>${esc(sourceLabel(s))}</dd>
      ${s.mayEditFiles ? `<dt>writes files?</dt><dd>${esc(s.mayEditFiles.source)}: ${esc(s.mayEditFiles.reason)} (${esc(s.mayEditFiles.scope)})</dd>` : ""}
      <dt>on the map</dt><dd>${t?.modules.length ? t.modules.map(mono).join(", ") + ` <span class="dim">(${t.how === "tool" ? "the tool's file path" : t.how === "commit" ? "the commit's files" : "named in the command: a guess"})</span>` : "no file of this map"}</dd>
    </dl>`
        : ""
    }
    <h4>Sources</h4>
    <dl class="map-kv">
      <dt>session</dt><dd>${mono(r.sessionId)}</dd>
      <dt>window</dt><dd>${esc(r.window.from ?? "start")} → ${esc(r.window.to ?? "end")} (UTC)</dd>
      ${srcRow("transcript", r.transcript)}
      ${srcRow("hook meter", r.sources.hookMeter)}
      ${srcRow("hook log", r.sources.hookLog)}
      ${srcRow("git", r.sources.git)}
      ${srcRow("GitHub", r.sources.github)}
      ${structInfo}
    </dl>
    <div class="dim">Replay read in ${Object.entries(r.timingsMs).map(([k, v]) => `${esc(k)} ${v} ms`).join(", ")}.</div>
  </div>`;
}

// ── timeline bar ─────────────────────────────────────────────────────────

function drawTimebar() {
  if (!root) return;
  const el = root.querySelector<HTMLElement>(".map-timebar")!;
  const sel = el.querySelector<HTMLSelectElement>(".map-sess")!;
  const list = [...(S.sessions?.sessions ?? [])].sort((a, b) => (b.lastTs ?? "").localeCompare(a.lastTs ?? ""));
  const shown = list.slice(0, 40);
  if (S.session && !shown.some((x) => x.sessionId === S.session)) {
    const found = list.find((x) => x.sessionId === S.session);
    if (found) shown.unshift(found);
  }
  const key = `${S.project}|${shown.map((x) => x.sessionId).join(",")}|${S.session}`;
  if (sel.dataset.key !== key) {
    sel.innerHTML =
      `<option value="">${S.sessions ? `Replay an agent session (${list.length} in ${esc(S.project)})` : "Reading sessions…"}</option>` +
      (S.session && !shown.some((x) => x.sessionId === S.session) ? `<option value="${esc(S.session)}">${esc(S.session.slice(0, 8))}</option>` : "") +
      shown
        .map(
          (x) =>
            `<option value="${esc(x.sessionId)}">${esc(x.sessionId.slice(0, 8))} · ${esc((x.firstTs ?? "?").slice(5, 16))} → ${esc((x.lastTs ?? "?").slice(5, 16))}${x.worktree ? " · worktree" : ""}</option>`
        )
        .join("");
    sel.dataset.key = key;
  }
  sel.value = S.session ?? "";
  const from = el.querySelector<HTMLInputElement>(".map-from")!;
  const to = el.querySelector<HTMLInputElement>(".map-to")!;
  if (document.activeElement !== from) from.value = S.from ?? "";
  if (document.activeElement !== to) to.value = S.to ?? "";

  const n = steps().length;
  const range = el.querySelector<HTMLInputElement>(".map-range")!;
  const play = el.querySelector<HTMLButtonElement>(".map-play")!;
  const label = el.querySelector<HTMLElement>(".map-steplabel")!;
  const now = el.querySelector<HTMLButtonElement>(".map-now")!;
  const ticks = el.querySelector<HTMLElement>(".map-ticks")!;
  range.disabled = n === 0;
  play.disabled = n === 0;
  range.max = String(Math.max(0, n - 1));
  range.value = String(Math.max(0, curIndex()));
  play.textContent = S.playing ? "Pause" : "Play";
  now.style.display = isPast() ? "" : "none";
  const s = curStep();
  label.innerHTML = n
    ? `${curIndex() + 1} / ${n} · ${esc(hhmmss(stepTime(s)))}${S.touches[curIndex()]?.shellWrite ? ' · <span class="s-warn">shell edit</span>' : ""}`
    : S.session
      ? S.replayLoading
        ? "reading…"
        : "no steps"
      : "";
  const tkey = `${S.replayKey}|${n}|${S.touches.length}`;
  if (ticks.dataset.key !== tkey) {
    ticks.innerHTML = steps()
      .map((st, i) => {
        const t = S.touches[i];
        const pos = n > 1 ? (i / (n - 1)) * 100 : 0;
        if (t?.shellWrite)
          return `<span class="map-tick shell" style="left:${pos}%" title="${esc(`Step ${i + 1} · ${hhmmss(stepTime(st))} · shell edit: ${t.designRules ?? "not confirmed"}`)}">✎</span>`;
        if (st.kind === "commit" || st.kind === "pr")
          return `<span class="map-tick cm" style="left:${pos}%" title="${esc(`Step ${i + 1} · ${st.kind === "commit" ? `commit ${short(st.sha)}` : `PR #${st.pr}`}`)}">◆</span>`;
        if (t?.modules.length) return `<span class="map-tick f" style="left:${pos}%" title="${esc(`Step ${i + 1} · ${t.modules.join(", ")}`)}">·</span>`;
        return "";
      })
      .join("");
    ticks.dataset.key = tkey;
  }
  const shellN = S.touches.filter((t) => t.shellWrite).length;
  const note = el.querySelector<HTMLElement>(".map-tnote")!;
  note.innerHTML = S.replay
    ? `${plural(n, "step")} · <span class="s-warn">✎ ${plural(shellN, "shell edit")}</span> (checked at merge, not at edit) · ◆ commits and PRs · times in UTC`
    : "";
}

function setStep(i: number | null) {
  const n = steps().length;
  S.step = i === null || i >= n - 1 ? null : Math.max(0, i);
  draw();
}

function togglePlay() {
  if (S.playing) {
    clearInterval(S.playing);
    S.playing = null;
    drawTimebar();
    return;
  }
  const n = steps().length;
  if (!n) return;
  if (!isPast()) S.step = 0;
  S.playing = setInterval(() => {
    if (!root?.isConnected) {
      clearInterval(S.playing!);
      S.playing = null;
      return;
    }
    const next = curIndex() + 1;
    if (next >= steps().length - 1) {
      clearInterval(S.playing!);
      S.playing = null;
      setStep(null);
      return;
    }
    setStep(next);
  }, 900);
  draw();
}

// ── events ───────────────────────────────────────────────────────────────

function setProject(name: string) {
  if (name === S.project && S.zoom !== "far") return;
  if (name !== S.project) {
    S.project = name;
    S.ref = null;
    S.session = null;
    S.from = null;
    S.to = null;
    S.step = null;
    S.sel = null;
    S.replay = null;
    S.replayKey = null;
    S.touches = [];
  }
  S.zoom = "blocks";
  S.camFor = null;
  loadStructure();
  loadSessions();
  draw();
}

// Drag state and the window listeners belong to the module, not to one mount: the
// listeners are added once and act on whichever map is in the page now.
let drag: { x: number; y: number; cx: number; cy: number } | null = null;
let moved = false;
let windowWired = false;

function wireWindow() {
  if (windowWired) return;
  windowWired = true;
  window.addEventListener("pointermove", (e) => {
    if (!drag || !root?.isConnected) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
    if (moved) {
      S.cam.x = drag.cx - dx / S.cam.k;
      S.cam.y = drag.cy - dy / S.cam.k;
      applyCamera();
    }
  });
  window.addEventListener("pointerup", (e) => {
    if (!drag) return;
    const wasDrag = moved;
    drag = null;
    const svg = root?.querySelector(".map-svg");
    if (wasDrag || !root?.isConnected || !svg) return;
    const target = e.target as Element | null;
    if (!target || !svg.contains(target)) return;
    const tile = target.closest<SVGGElement>("[data-proj]");
    if (tile) {
      setProject(tile.dataset.proj!);
      return;
    }
    const cell = target.closest<SVGGElement>("[data-cell]");
    if (cell && S.zoom === "files") {
      S.sel = { kind: "file", path: cell.dataset.cell! };
      draw();
      return;
    }
    const blk = target.closest<SVGGElement>("[data-block]");
    if (blk) {
      S.sel = { kind: "block", id: blk.dataset.block! };
      draw();
      return;
    }
    if (S.sel) {
      S.sel = null;
      draw();
    }
  });
}

function wire(view: HTMLElement) {
  const svg = view.querySelector<SVGSVGElement>(".map-svg")!;
  wireWindow();
  let raf = 0;
  const redrawDyn = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      drawScene();
    });
  };
  svg.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const r = svg.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      const c = S.cam;
      const nk = Math.max(0.08, Math.min(8, c.k * Math.exp(-e.deltaY * 0.0015)));
      S.cam = { k: nk, x: c.x + px / c.k - px / nk, y: c.y + py / c.k - py / nk };
      if (S.zoom !== "far") {
        const z: Zoom = nk >= 1.5 ? "files" : "blocks";
        if (z !== S.zoom) {
          S.zoom = z;
          S.camFor = `${S.structKey}|${S.zoom}`;
          writeHash();
          drawBar();
        }
      }
      redrawDyn();
    },
    { passive: false }
  );
  svg.addEventListener("pointerdown", (e) => {
    drag = { x: e.clientX, y: e.clientY, cx: S.cam.x, cy: S.cam.y };
    moved = false;
  });
  svg.addEventListener("keydown", (e) => {
    const tile = (e.target as Element).closest?.<SVGGElement>("[data-proj]");
    if (tile && (e.key === "Enter" || e.key === " ")) setProject(tile.dataset.proj!);
  });

  view.querySelector(".map-levels")!.addEventListener("click", (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>("button[data-zoom]");
    if (!b) return;
    S.zoom = b.dataset.zoom as Zoom;
    S.camFor = null;
    if (S.zoom !== "far") {
      loadStructure();
      loadSessions();
    }
    draw();
  });
  view.querySelector(".map-toggles")!.addEventListener("click", (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>("button[data-t]");
    if (!b) return;
    const k = b.dataset.t as keyof MapState["toggles"];
    S.toggles[k] = !S.toggles[k];
    staticFor = S.zoom === "far" ? null : staticFor;
    draw();
  });
  view.querySelector<HTMLSelectElement>(".map-project")!.addEventListener("change", (e) => setProject((e.target as HTMLSelectElement).value));
  const refInput = view.querySelector<HTMLInputElement>(".map-ref")!;
  const goRef = () => {
    const v = refInput.value.trim() || null;
    if (v === S.ref) return;
    S.ref = v;
    if (S.zoom === "far") S.zoom = "blocks";
    loadStructure();
  };
  view.querySelector(".map-ref-go")!.addEventListener("click", goRef);
  refInput.addEventListener("keydown", (e) => e.key === "Enter" && goRef());

  view.querySelector(".map-panel")!.addEventListener("click", (e) => {
    const t = (e.target as Element).closest<HTMLElement>("[data-tab]");
    if (t) {
      S.tab = t.dataset.tab as Tab;
      draw();
      return;
    }
    if ((e.target as Element).closest("[data-now]")) setStep(null);
  });
  view.querySelector(".map-insp")!.addEventListener("click", (e) => {
    if ((e.target as Element).closest("[data-unsel]")) {
      S.sel = null;
      draw();
    }
  });

  const tb = view.querySelector<HTMLElement>(".map-timebar")!;
  tb.querySelector<HTMLSelectElement>(".map-sess")!.addEventListener("change", (e) => {
    const sid = (e.target as HTMLSelectElement).value || null;
    S.session = sid;
    S.step = null;
    S.replay = null;
    S.replayKey = null;
    S.touches = [];
    const info = S.sessions?.sessions.find((x) => x.sessionId === sid);
    if (info?.lastTs) {
      // Default window: the session's last 12 hours.
      const end = Date.parse(info.lastTs);
      S.to = new Date(end).toISOString();
      S.from = new Date(Math.max(Date.parse(info.firstTs ?? info.lastTs), end - 12 * 3600_000)).toISOString();
    }
    if (sid) loadReplay();
    draw();
  });
  tb.querySelector(".map-load")!.addEventListener("click", () => {
    const f = tb.querySelector<HTMLInputElement>(".map-from")!.value.trim();
    const t = tb.querySelector<HTMLInputElement>(".map-to")!.value.trim();
    S.from = f || null;
    S.to = t || null;
    S.step = null;
    loadReplay();
  });
  tb.querySelector(".map-range")!.addEventListener("input", (e) => {
    if (S.playing) {
      clearInterval(S.playing);
      S.playing = null;
    }
    setStep(+(e.target as HTMLInputElement).value);
  });
  tb.querySelector(".map-play")!.addEventListener("click", togglePlay);
  tb.querySelector(".map-now")!.addEventListener("click", () => setStep(null));
}

// ── mount ────────────────────────────────────────────────────────────────

export function MapView(_nav: Nav): HTMLElement {
  readHash();
  if (!hashListening) {
    hashListening = true;
    window.addEventListener("hashchange", () => {
      if (!root?.isConnected || !location.hash.startsWith("#map")) return;
      readHash();
      S.camFor = null;
      if (S.zoom !== "far") loadStructure();
      loadSessions();
      if (S.session) loadReplay();
      draw();
    });
  }
  const view = document.createElement("div");
  view.className = "map-view";
  view.innerHTML = `
    <div class="map-bar">
      <h2>Map</h2>
      <div class="map-seg map-levels" role="group" aria-label="Zoom level">
        <button type="button" data-zoom="far">All projects</button><button type="button" data-zoom="blocks">Blocks</button><button type="button" data-zoom="files">Files</button>
      </div>
      <div class="map-seg map-toggles" role="group" aria-label="Show">
        <button type="button" data-t="guard">Guardrails</button><button type="button" data-t="agents">Agents</button><button type="button" data-t="flow">Flow</button><button type="button" data-t="imports">Every import</button>
      </div>
      <select class="map-project map-btn" aria-label="Project"></select>
      <label class="map-reflabel">commit <input class="map-ref mono" type="text" placeholder="origin/main" size="12" aria-label="Commit or branch to measure"></label>
      <button type="button" class="map-btn map-ref-go">Measure</button>
      <span class="map-hint">Scroll to zoom · drag to move · click a block or a file</span>
    </div>
    <div class="map-head"></div>
    <div class="map-body">
      <div class="map-wrap">
        <svg class="map-svg" aria-label="Map of projects, design components, files and imports">
          <defs>
            <marker id="map-m-ok" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="11" markerHeight="11" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#7d869b"/></marker>
            <marker id="map-m-brk" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="11" markerHeight="11" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#facc15"/></marker>
            <marker id="map-m-new" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="11" markerHeight="11" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#f87171"/></marker>
            <marker id="map-m-flow" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="11" markerHeight="11" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#4ade80"/></marker>
          </defs>
          <g class="map-world"><g class="map-static"></g><g class="map-dyn"></g></g>
        </svg>
        <div class="map-msg" style="display:none"></div>
        <div class="map-insp" style="display:none"></div>
        <details class="map-legend"><summary>Key</summary>
          <span><i class="k-ok"></i>imports the design allows</span>
          <span><i class="k-brk"></i>allowed rule break (the baseline holds it)</span>
          <span><i class="k-new"></i>new rule break (the guard refuses it)</span>
          <span><i class="k-decl"></i>declared pair, no import uses it</span>
          <span><i class="k-flow"></i>flow: the order the agent entered blocks</span>
          <span><i class="k-shell"></i>file edited through the shell</span>
          <span>solid border = design component (guardrail) · dashed = folder only, nothing blocked</span>
          <span class="map-rt"></span>
        </details>
      </div>
      <aside class="map-panel" aria-label="Agent replay"></aside>
    </div>
    <div class="map-timebar">
      <select class="map-sess map-btn" aria-label="Agent session to replay"></select>
      <input class="map-from mono" type="text" placeholder="from (UTC)" size="22" aria-label="Window start, ISO time">
      <input class="map-to mono" type="text" placeholder="to (UTC)" size="22" aria-label="Window end, ISO time">
      <button type="button" class="map-btn map-load">Load</button>
      <button type="button" class="map-btn map-play">Play</button>
      <div class="map-track"><div class="map-ticks"></div><input type="range" class="map-range" min="0" value="0" aria-label="Step in time"></div>
      <span class="map-steplabel mono"></span>
      <button type="button" class="map-btn map-now" style="display:none">Back to now</button>
      <span class="map-tnote"></span>
    </div>`;
  root = view;
  staticFor = null;
  S.camFor = null;
  wire(view);
  loadList();
  loadLive();
  if (S.zoom !== "far") loadStructure();
  loadSessions();
  if (S.session) loadReplay();
  // Draw once the view is in the page, so the camera knows the map's size.
  requestAnimationFrame(() => {
    S.camFor = null;
    draw();
  });
  return view;
}
