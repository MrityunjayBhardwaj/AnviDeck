/**
 * "Start an agent on an issue" (#78), opened from ⌘K. Pick the project and the issue, Check
 * (what would be made, or why it would refuse; nothing is written) and Start agent (the write,
 * through ui/write.ts). The answer shows the worktree, the branch, each anvi link and whether it
 * resolves, anvi's own check of the worktree, and the board. All server text is set as text.
 */
import { write, WriteError } from "../write";

export interface StartAgentDeps {
  projects: () => string[];
  /** Called with the new agent's id once it has started. */
  started?: (id: string) => void;
}

interface Link { kind: string; state: string; path: string; target?: string; resolvesTo?: string; resolves: boolean; note: string }
interface Plan {
  project: string; repo: string; branch: string; worktree: string; base: string; baseSha: string;
  issue: { number: number; title: string; url: string };
}
interface Started extends Plan {
  agent: { id: string; status: string };
  links: Link[];
  anviCheck: { state: string; reason?: string; missing: string[]; differs: { kind: string; have: string; target: string }[] };
  board: { state: string; board?: string; reason?: string };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const k of kids) e.append(typeof k === "string" ? document.createTextNode(k) : k);
  return e;
}

export function createStartAgent(deps: StartAgentDeps): { open: (project: string | null, issue?: number) => void; close: () => void } {
  const project = el("select", { id: "sa-project", "aria-label": "Project" });
  const issue = el("input", { id: "sa-issue", type: "text", inputmode: "numeric", placeholder: "issue number", size: "8", "aria-label": "Issue number" });
  const note = el("textarea", { id: "sa-note", rows: "2", placeholder: "optional note for this run (it wins over the workflow where they differ)", "aria-label": "Note" });
  const check = el("button", { id: "sa-check", type: "button", class: "sh-btn" }, "Check");
  const start = el("button", { id: "sa-start", type: "button", class: "sh-btn sh-sa-go" }, "Start agent");
  const close = el("button", { id: "sa-close", type: "button", class: "sh-btn" }, "Close");
  const out = el("div", { id: "sa-out", class: "sh-sa-out", "aria-live": "polite" });
  const box = el("div", { class: "sh-sa", role: "dialog", "aria-modal": "true", "aria-label": "Start an agent on an issue" },
    el("div", { class: "sh-sa-h" }, "Start an agent on an issue"),
    el("div", { class: "sh-sa-row" }, el("label", {}, "Project ", project), el("label", {}, "Issue #", issue)),
    el("div", { class: "sh-sa-row" }, note),
    el("div", { class: "sh-sa-row sh-dim" }, "Makes the issue's own worktree and branch, links the project's .anvi and ref into it, and starts the agent there with the issue and your workflow. Agents never merge."),
    el("div", { class: "sh-sa-row" }, check, start, close),
    out);
  const bg = el("div", { class: "sh-palette-bg sh-sa-bg" }, box);
  document.body.appendChild(bg);

  const params = () => ({ project: project.value, issue: issue.value.trim().replace(/^#/, "") });
  const say = (cls: string, ...kids: (Node | string)[]) => out.replaceChildren(el("div", { class: cls }, ...kids));

  function planLines(p: Plan): HTMLElement[] {
    return [
      el("div", {}, el("b", {}, `#${p.issue.number} ${p.issue.title}`), el("span", { class: "sh-dim" }, `  ${p.repo}`)),
      el("div", {}, el("span", { class: "sh-dim" }, "worktree "), el("span", { id: "sa-worktree" }, p.worktree)),
      el("div", {}, el("span", { class: "sh-dim" }, "branch "), el("span", { id: "sa-branch" }, p.branch), el("span", { class: "sh-dim" }, `  from ${p.base} at ${p.baseSha.slice(0, 12)}`)),
    ];
  }

  check.onclick = async () => {
    const q = params();
    say("sh-dim", "Checking…");
    try {
      const res = await fetch(`/api/agents/from-issue/plan?project=${encodeURIComponent(q.project)}&issue=${encodeURIComponent(q.issue)}`);
      const j = (await res.json().catch(() => ({}))) as Plan & { error?: string; refusal?: string };
      // A read that failed (GitHub unreachable) is not a refusal: say it could not be checked.
      if (res.status === 502) return say("sh-sa-err", `Could not check: ${j.error ?? "GitHub could not be read"}`);
      if (!res.ok) return say("sh-sa-err", `Would refuse${j.refusal ? ` (${j.refusal})` : ""}: ${j.error ?? `status ${res.status}`}`);
      out.replaceChildren(el("div", { class: "sh-dim" }, "Nothing has been made yet. Start agent would make:"), ...planLines(j));
    } catch (e) {
      say("sh-sa-err", `Could not check: ${(e as Error).message}`);
    }
  };

  start.onclick = async () => {
    const q = params();
    start.disabled = true;
    say("sh-dim", "Making the worktree and starting the agent…");
    try {
      const r = await write<Started>("POST", "/api/agents/from-issue", { project: q.project, issue: q.issue, note: note.value || undefined });
      const links = r.links.map((l) =>
        el("div", { class: "sh-sa-link", "data-kind": l.kind, "data-state": l.state, "data-resolves": String(l.resolves) },
          el("span", { class: l.resolves ? "sh-sa-ok" : "sh-sa-err" }, l.resolves ? "resolves" : "does not resolve"),
          `  ${l.kind} · ${l.state} · `, l.state === "linked" ? `${l.path} → ${l.resolvesTo ?? "nothing"}` : l.note));
      const a = r.anviCheck;
      const anvi = a.state === "asked"
        ? `anvi's own check: ${a.missing.length ? `still missing ${a.missing.join(", ")}` : "nothing missing"}${a.differs.length ? `; served from another folder than the main checkout's: ${a.differs.map((d) => `${d.kind} (${d.have})`).join(", ")}` : ""}`
        : `anvi's own check: not checked (${a.reason ?? "?"})`;
      const board = r.board.state === "moved" ? `board: moved to In Progress on ${r.board.board}` : `board: ${r.board.state}${r.board.reason ? ` (${r.board.reason})` : ""}`;
      out.replaceChildren(
        el("div", { class: "sh-sa-ok" }, "Started agent ", el("b", { id: "sa-agent" }, r.agent.id), ` (${r.agent.status}). `,
          el("a", { href: `/agent-host#${r.agent.id}`, id: "sa-watch" }, "Watch it on the agent host page")),
        ...planLines(r),
        ...links,
        el("div", { id: "sa-anvi" }, anvi),
        el("div", { id: "sa-board" }, board),
      );
      deps.started?.(r.agent.id);
    } catch (e) {
      const why = e instanceof WriteError ? `${e.message}${typeof e.body.refusal === "string" ? ` (${e.body.refusal})` : ""}` : (e as Error).message;
      say("sh-sa-err", `Not started: ${why}`);
    } finally {
      start.disabled = false;
    }
  };

  function hide() {
    bg.classList.remove("on");
  }
  close.onclick = hide;
  bg.addEventListener("click", (e) => {
    if (e.target === bg) hide();
  });
  bg.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hide();
  });

  return {
    open(current, issueNumber) {
      const names = deps.projects();
      project.replaceChildren(...names.map((n) => el("option", { value: n }, n)));
      if (current && names.includes(current)) project.value = current;
      // Opened from an issue (Work's Start agent, #85): its number is filled in.
      if (issueNumber !== undefined) issue.value = String(issueNumber);
      out.replaceChildren();
      bg.classList.add("on");
      issue.focus();
    },
    close: hide,
  };
}
