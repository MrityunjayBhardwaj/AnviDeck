/**
 * The workspace frame's DOM (#80): top bar (brand, project switcher, palette button, guards,
 * help), rail, project tabs, placeholders for screens not built yet, the Older views list,
 * and the activity strip. app.ts owns the state and calls these; each paints one region.
 */
import { GUARDS, guardsLabel } from "./guards";
import { activityText, activityTitle, type AgentsRead } from "./activity";
import { ISSUE_URL, OLDER_VIEWS, PROJECT_TABS, RAIL, SCREENS, screen, type RailKey, type ScreenId } from "./routes";
import { screenHash } from "./palette-model";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Icons from the prototype; Older is new. */
const ICONS: Record<Exclude<RailKey, null>, string> = {
  home: `<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>`,
  map: `<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="7" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M8.3 6.4l7.4.4M7.3 8.2l3.6 7.6M16.9 9.3l-3.7 6.6"/>`,
  agents: `<rect x="4" y="7" width="16" height="12" rx="3"/><path d="M12 3v4M9 12h.01M15 12h.01M9 16h6"/>`,
  changes: `<path d="M6 3v12M18 9v12M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9c0 6-12 3-12 6"/>`,
  notes: `<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2zM4 21V5M8 7h7M8 11h7"/>`,
  project: `<rect x="9" y="3" width="6" height="5" rx="1"/><rect x="3" y="16" width="6" height="5" rx="1"/><rect x="15" y="16" width="6" height="5" rx="1"/><path d="M12 8v4M6 16v-4h12v4"/>`,
  older: `<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4"/>`,
};

export interface TopBarInput {
  projects: { name: string; sharesNotesWith?: string }[];
  current: string | null;
  onProject: (name: string) => void;
  onPalette: () => void;
}

export function paintTopBar(el: HTMLElement, inp: TopBarInput): void {
  const g = guardsLabel();
  const opts = inp.projects
    .map((p) => `<option value="${esc(p.name)}"${p.name === inp.current ? " selected" : ""}>${esc(p.name)}${p.sharesNotesWith ? ` (notes of ${esc(p.sharesNotesWith)})` : ""}</option>`)
    .join("");
  el.innerHTML = `
    <div class="sh-brand"><div class="sh-brand-mark" aria-hidden="true">a</div>Anvi Workspace</div>
    <label class="sh-proj" title="The project the Project tabs, Agents and the older project views open on">
      <span class="sh-proj-k">Project</span>
      <select aria-label="Project">${opts || `<option value="">no projects found</option>`}</select>
    </label>
    <button class="sh-search" type="button"><span>Search, jump, or ask an agent…</span><kbd>⌘K</kbd></button>
    <div class="sh-top-right">
      <div class="sh-pop-wrap">
        <button class="sh-pill sh-guards ${g.state}" type="button" aria-haspopup="true" aria-expanded="false"><span class="sh-dot"></span>${esc(g.text)}</button>
        <div class="sh-pop sh-guards-pop" role="dialog" aria-label="Guards">
          <div class="sh-pop-h">What guards this server today</div>
          ${GUARDS.map((x) => `<div class="sh-guard ${x.on ? "on" : "off"}"><span class="sh-guard-s">${x.on ? "on" : "not yet"}</span><div><div>${esc(x.what)}</div><div class="sh-dim">${esc(x.where)}</div></div></div>`).join("")}
          <div class="sh-dim sh-pop-f">Read from the code on main, not measured by this page.</div>
        </div>
      </div>
      <div class="sh-pop-wrap">
        <button class="sh-btn sh-help" type="button" aria-haspopup="true" aria-expanded="false">? Help</button>
        <div class="sh-pop sh-help-pop">
          <a href="#flows">Walk the example flows <span class="sh-dim">(#91)</span></a>
          <button type="button" class="sh-help-palette">Search and commands (⌘K)</button>
        </div>
      </div>
    </div>`;
  el.querySelector("select")!.addEventListener("change", (e) => inp.onProject((e.target as HTMLSelectElement).value));
  el.querySelector(".sh-search")!.addEventListener("click", inp.onPalette);
  el.querySelector(".sh-help-palette")!.addEventListener("click", inp.onPalette);
  for (const wrap of el.querySelectorAll<HTMLElement>(".sh-pop-wrap")) {
    const btn = wrap.querySelector("button")!;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = !wrap.classList.contains("open");
      for (const w of el.querySelectorAll(".sh-pop-wrap.open")) w.classList.remove("open");
      wrap.classList.toggle("open", open);
      btn.setAttribute("aria-expanded", String(open));
    });
  }
}

/** Closes the top bar's popovers on any click outside them. Installed once. */
export function closePopoversOnOutsideClick(top: HTMLElement): void {
  document.addEventListener("click", (e) => {
    for (const w of top.querySelectorAll<HTMLElement>(".sh-pop-wrap.open")) {
      if (!w.contains(e.target as Node)) {
        w.classList.remove("open");
        w.querySelector("button")?.setAttribute("aria-expanded", "false");
      }
    }
  });
}

export function paintRail(el: HTMLElement, active: RailKey, homeBadge: { text: string; zero: boolean }, project: string | null): void {
  el.innerHTML = RAIL.map((r) => {
    const badge = r.key === "home" ? `<span class="sh-badge${homeBadge.zero ? " zero" : ""}" title="things that need you (same count as the Home headline)">${esc(homeBadge.text)}</span>` : "";
    const sep = r.key === "older" ? `<div class="sh-sep" aria-hidden="true"></div>` : "";
    return `${sep}<a href="${screenHash(r.to, project)}" data-rail="${r.key}" class="${active === r.key ? "on" : ""}"${active === r.key ? ' aria-current="page"' : ""}><svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[r.key]}</svg>${r.label}${badge}</a>`;
  }).join("");
}

/** The Project rail item's tabs, above each project screen. */
export function projectTabs(active: ScreenId, project: string | null): string {
  return `<nav class="sh-ptabs" aria-label="Project">${PROJECT_TABS.map((id) => `<a href="#${id}" class="${id === active ? "on" : ""}">${esc(screen(id).label)}</a>`).join("")}<span class="sh-ptabs-proj sh-dim">${project ? esc(project) : "no project picked"}</span></nav>`;
}

/** Older views that hold what a placeholder will show, until it is built. */
const MEANWHILE: Partial<Record<ScreenId, { id: ScreenId; why: string }[]>> = {
  notes: [
    { id: "project", why: "catalogues, memory and grounding" },
    { id: "brain", why: "entries by stratum with their dates" },
  ],
  history: [{ id: "project", why: "the ~/.claude history strip and diffs" }],
  design: [{ id: "map", why: "design blocks and imports" }],
  code: [{ id: "map", why: "files and imports at the Files zoom" }],
  changes: [{ id: "agents", why: "a session's changes, replayed" }],
};

export function placeholder(id: ScreenId, project: string | null): HTMLElement {
  const s = screen(id);
  const wrap = document.createElement("section");
  wrap.className = "sh-screen sh-placeholder";
  wrap.dataset.screen = id;
  const meanwhile = (MEANWHILE[id] ?? [])
    .map((m) => `<li><a href="${screenHash(m.id, project)}">${esc(screen(m.id).label)}</a> <span class="sh-dim">${esc(m.why)}</span></li>`)
    .join("");
  wrap.innerHTML = `
    ${s.group === "project" ? projectTabs(id, project) : ""}
    <div class="sh-head"><h1>${esc(s.label)}</h1><span class="sh-chip">not built yet</span></div>
    <div class="sh-card">
      <p>${esc(s.blurb)}</p>
      <p class="sh-dim">This screen is built by <a href="${ISSUE_URL(s.buildsIn!)}" target="_blank" rel="noopener">#${s.buildsIn}</a>. Until then nothing here is real data, so nothing is shown.</p>
      ${meanwhile ? `<div class="sh-meanwhile"><div class="sh-dim">Meanwhile</div><ul>${meanwhile}</ul></div>` : ""}
    </div>`;
  return wrap;
}

export function olderViews(project: string | null): HTMLElement {
  const wrap = document.createElement("section");
  wrap.className = "sh-screen sh-older";
  wrap.dataset.screen = "older";
  wrap.innerHTML = `
    <div class="sh-head"><h1>Older views</h1><span class="sh-sub">the dashboard's views from before the workspace</span></div>
    <p class="sh-dim">They stay here until <a href="${ISSUE_URL(92)}" target="_blank" rel="noopener">#92</a> retires them, once Notes, History and Agents carry what is useful from them.</p>
    <div class="sh-older-list">
      ${OLDER_VIEWS.map((id) => {
        const s = screen(id);
        return `<a class="sh-card sh-older-item" href="${screenHash(id, project)}" data-older="${id}"><div class="sh-older-t">${esc(s.label)}</div><div class="sh-dim">${esc(s.blurb)}</div><div class="sh-older-fate">${esc(s.fate ?? "")}</div></a>`;
      }).join("")}
    </div>`;
  return wrap;
}

export function unknownScreenNote(name: string): HTMLElement {
  const d = document.createElement("div");
  d.className = "sh-unknown";
  d.textContent = `No screen is called "${name}"; showing Home. Screens: ${SCREENS.map((s) => s.id).join(", ")}.`;
  return d;
}

export interface StripInput {
  wsConnected: boolean;
  agents: AgentsRead;
  /** Terminal sessions and Home's count, as the old header showed them (stripText). */
  terminals: string;
  events: { kind: "ok" | "info" | "warn" | "bad"; text: string }[];
  open: boolean;
  onToggle: () => void;
}

export function paintStrip(el: HTMLElement, inp: StripInput): void {
  el.classList.toggle("open", inp.open);
  el.innerHTML = `
    <span class="sh-live ${inp.wsConnected ? "on" : "off"}" role="status" aria-label="live updates ${inp.wsConnected ? "connected" : "disconnected"}">● ${inp.wsConnected ? "live" : "disconnected"}</span>
    <span class="sh-strip-agents" title="${esc(activityTitle(inp.agents))}"><span class="sh-dim">started here</span> ${esc(activityText(inp.agents))}</span>
    <span class="sh-strip-term" title="From /api/home: Claude Code sessions in terminals, and Home's count"><span class="sh-dim">in terminals</span> ${esc(inp.terminals)}</span>
    <span class="sh-evs">${inp.events.length ? inp.events.map((e) => `<span class="sh-ev"><i class="${e.kind}"></i>${esc(e.text)}</span>`).join("") : `<span class="sh-dim">no activity since this page opened</span>`}</span>
    <button class="sh-tog" type="button">${inp.open ? "Hide activity ▾" : "Show activity ▴"}</button>`;
  el.querySelector(".sh-tog")!.addEventListener("click", inp.onToggle);
}
