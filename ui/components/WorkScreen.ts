/**
 * Project · Work (#85): the board (or the open issues when there is no board), Start agent,
 * New issue, and each open PR as your workflow with its merge checks and a Merge button only
 * you press. The rules live in work-model.ts (tested); this file only builds the DOM.
 * All text from GitHub is set as text, never as HTML.
 */
import { projectTabs } from "../shell/frame";
import { write, WriteError } from "../write";
import type { BoardItem, BoardResponse, MergeAnswer, NewIssueAnswer, PrConflicts, PrFacts, PrsResponse } from "../../shared/work-types";
import {
  boardColumns,
  boardCoverage,
  canStartAgent,
  confirmLabel,
  focusedPr,
  itemRef,
  mergeBlocked,
  mergeChecks,
  mergeLabel,
  prSteps,
  refusalText,
  shortSha,
} from "./work-model";

export interface WorkDeps {
  /** Opens the Start agent dialog on this project and issue (ui/shell/start-agent.ts). */
  startAgent: (project: string, issue: number) => void;
}

/** The most cards a column shows; its header still counts every item. */
const COLUMN_CAP = 30;

type Kid = Node | string | null | undefined | false;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const k of kids) if (k !== null && k !== undefined && k !== false) e.append(typeof k === "string" ? document.createTextNode(k) : k);
  return e;
}

/** Its own stylesheet, added once (keeps the shared CSS files untouched). */
function ensureStyles() {
  if (document.querySelector('link[data-work-css]')) return;
  const l = el("link", { rel: "stylesheet", href: "/styles/work.css", "data-work-css": "" });
  document.head.appendChild(l);
}

const when = (iso: string) => {
  const d = new Date(iso);
  return `${d.toLocaleDateString("sv-SE")} ${d.toTimeString().slice(0, 5)}`;
};

async function getJson<T>(url: string): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    const res = await fetch(url);
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return { ok: false, error: typeof j.error === "string" ? j.error : `status ${res.status}` };
    return { ok: true, value: j as T };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export function WorkScreen(project: string | null, params: URLSearchParams, deps: WorkDeps): HTMLElement {
  ensureStyles();
  const wrap = el("section", { class: "sh-screen wk", "data-screen": "work" });
  wrap.innerHTML = projectTabs("work", project);
  const newBtn = el("button", { class: "sh-btn", type: "button", id: "wk-new-issue" }, "New issue");
  wrap.append(
    el("div", { class: "sh-head" },
      el("h1", {}, "Project · Work"),
      el("span", { class: "sh-sub" }, "issues and PRs from GitHub · board Status is the source of truth"),
      el("div", { class: "wk-acts" }, newBtn)),
  );
  if (!project) {
    wrap.append(el("div", { class: "sh-card" }, "Pick a project in the switcher above."));
    newBtn.disabled = true;
    return wrap;
  }
  const form = newIssueForm(project, () => void loadBoard());
  const prsEl = el("div", { class: "wk-prs", id: "wk-prs" }, el("div", { class: "sh-card sh-dim" }, "Reading the open PRs from GitHub and checking them for conflicts…"));
  const boardEl = el("div", { class: "wk-board-wrap", id: "wk-board" }, el("div", { class: "sh-card sh-dim" }, "Reading the board from GitHub…"));
  wrap.append(form.el, prsEl, boardEl);
  newBtn.onclick = () => form.toggle();

  const p = project;
  const focus = focusedPr(params);
  void (async () => {
    const r = await getJson<PrsResponse>(`/api/work/prs?project=${encodeURIComponent(p)}`);
    prsEl.replaceChildren(r.ok ? prsSection(r.value, focus) : el("div", { class: "sh-card wk-bad", id: "wk-prs-error" }, `Could not read the open PRs: ${r.error}`));
  })();
  async function loadBoard() {
    const r = await getJson<BoardResponse>(`/api/work/board?project=${encodeURIComponent(p)}`);
    boardEl.replaceChildren(r.ok ? boardSection(r.value, deps) : el("div", { class: "sh-card wk-bad", id: "wk-board-error" }, `Could not read the board: ${r.error}`));
  }
  void loadBoard();
  return wrap;
}

// ---------------------------------------------------------------------------
// PRs
// ---------------------------------------------------------------------------

function prsSection(r: PrsResponse, focus: number | null): HTMLElement {
  const box = el("div", { class: "wk-prs-in" });
  const shown = r.prs.length < r.total ? `the newest ${r.prs.length} of ${r.total} open PRs` : `${r.total} open PR${r.total === 1 ? "" : "s"}`;
  const source = el("div", { class: "sh-dim wk-src", id: "wk-prs-src" },
    `${r.repo} · ${shown} · read from GitHub ${when(r.readAt)} · conflicts by git merge-tree against each PR's own base and each other open PR`);
  if (!r.prs.length) {
    box.append(el("div", { class: "sh-card", id: "wk-no-prs" }, `${r.repo} has no open PRs.`), source);
    return box;
  }
  let list = r.prs;
  if (focus !== null) {
    const one = r.prs.find((x) => x.number === focus);
    if (!one) box.append(el("div", { class: "sh-card wk-bad", id: "wk-focus-missing" }, `PR #${focus} is not among ${shown} of ${r.repo}. `, el("a", { href: "#work" }, "Show all")));
    else list = [one];
  }
  for (const pr of list) box.append(prCard(r, pr));
  if (focus !== null && list.length === 1 && r.prs.length > 1) {
    box.append(el("div", { class: "sh-dim wk-others" }, "Other open PRs: ",
      ...r.prs.filter((x) => x.number !== focus).flatMap((x) => [el("a", { href: `#work?pr=${x.number}` }, `#${x.number}`), " "]),
      "· ", el("a", { href: "#work" }, "show all")));
  }
  box.append(source);
  return box;
}

const MARK = { done: "✓", missing: "○", failed: "✕", todo: "" } as const;

function prCard(r: PrsResponse, pr: PrFacts & { conflicts: PrConflicts }): HTMLElement {
  const card = el("div", { class: "sh-card wk-pr", "data-pr": String(pr.number), id: `wk-pr-${pr.number}` });
  card.append(el("h3", {},
    el("a", { href: `#work?pr=${pr.number}` }, `PR #${pr.number}`), " · your workflow ",
    el("span", { class: "wk-pr-title" }, el("a", { href: pr.url, target: "_blank", rel: "noopener" }, pr.title)),
    el("span", { class: "sh-dim wk-pr-by" }, ` ${pr.author ?? "?"} · ${pr.headRefName} · updated ${when(pr.updatedAt)}`)));

  const pipe = el("div", { class: "wk-pipeline", role: "list", "data-tour": "pipeline" });
  for (const s of prSteps(pr)) {
    const mark = s.now && s.state !== "failed" ? "●" : MARK[s.state];
    pipe.append(el("span", { class: `wk-st ${s.state}${s.now ? " now" : ""}`, role: "listitem", title: s.detail, "data-step": s.key, "data-state": s.state }, `${mark ? `${mark} ` : ""}${s.label}`));
  }
  card.append(pipe);

  const row = el("div", { class: "wk-row" });
  for (const c of mergeChecks(pr)) row.append(el("span", { class: `sh-chip wk-chk ${c.state}`, title: c.detail, "data-check": c.key, "data-state": c.state }, c.text));
  const out = el("div", { class: "wk-merge-out", "aria-live": "polite" });
  row.append(mergeControl(r.project, pr, out));
  card.append(row, out);
  return card;
}

/**
 * Merge, in two clicks: the first names the commit, the second says exactly what happens
 * (squash-merge #N at <sha> into <base>). Only the head shown here is sent; the server refuses
 * with 409 if the PR's head is no longer that commit.
 */
function mergeControl(project: string, pr: PrFacts, out: HTMLElement): HTMLElement {
  const box = el("span", { class: "wk-merge" });
  const blocked = mergeBlocked(pr);
  const head = pr.headRefOid;
  const btn = el("button", { class: "sh-btn wk-merge-btn", type: "button", "data-head": head, "data-base": pr.baseRefName, title: blocked ?? `You merge; agents never do. Merges exactly ${head}.` }, mergeLabel(head));
  if (blocked) {
    btn.disabled = true;
    box.append(btn);
    return box;
  }
  const sure = el("button", { class: "sh-btn wk-merge-go", type: "button" }, confirmLabel(pr));
  const cancel = el("button", { class: "sh-btn", type: "button" }, "Cancel");
  btn.onclick = () => {
    box.replaceChildren(sure, cancel);
    out.replaceChildren(el("span", { class: "sh-dim" }, `This merges commit ${head} and nothing newer.`));
  };
  cancel.onclick = () => {
    box.replaceChildren(btn);
    out.replaceChildren();
  };
  sure.onclick = async () => {
    sure.disabled = true;
    cancel.disabled = true;
    out.replaceChildren(el("span", { class: "sh-dim" }, "Asking GitHub to merge…"));
    try {
      // The head and base sent are the ones this button was built with (and the confirmation
      // named), read from its data attributes; the server refuses if either changed.
      const a = await write<MergeAnswer>("POST", `/api/prs/${pr.number}/merge`, { project, head: btn.dataset.head, base: btn.dataset.base });
      const back = a.readBack.state === "read" ? `merge commit ${a.readBack.mergeCommit ? shortSha(a.readBack.mergeCommit) : "?"}` : `read-back: ${a.readBack.reason}`;
      const odd = a.ghFailed ? ` · gh reported "${a.ghFailed}", but GitHub reads it back as merged` : "";
      box.replaceChildren();
      out.replaceChildren(el("span", { class: "wk-ok", id: `wk-merged-${pr.number}` }, `Merged #${a.number} at ${shortSha(a.head)} into ${a.base} (squash) · ${back}${odd}`));
    } catch (e) {
      const text = e instanceof WriteError ? refusalText(e.status, e.body) : `Not done: ${(e as Error).message}`;
      out.replaceChildren(el("span", { class: "wk-bad", id: `wk-merge-refused-${pr.number}` }, text));
      box.replaceChildren(btn);
    }
  };
  box.append(btn);
  return box;
}

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

function issueCard(it: BoardItem, repo: string, column: string, project: string, deps: WorkDeps): HTMLElement {
  const card = el("div", { class: "wk-issue", "data-issue": String(it.number ?? ""), "data-tour": "issue" });
  card.append(el("div", { class: "wk-issue-h" },
    el("span", { class: "wk-mono sh-dim" }, itemRef(it, repo)),
    ...it.labels.slice(0, 2).map((l) => el("span", { class: "sh-chip" }, l))));
  card.append(it.url ? el("a", { class: "wk-issue-t", href: it.url, target: "_blank", rel: "noopener" }, it.title) : el("b", {}, it.title));
  if (it.linkedPrs.length) {
    const own = (it.repo ?? "").toLowerCase() === repo.toLowerCase();
    card.append(el("span", { class: "sh-dim wk-note" }, `linked PR${it.linkedPrs.length === 1 ? "" : "s"} `,
      ...it.linkedPrs.flatMap((n) => [own ? el("a", { href: `#work?pr=${n}` }, `#${n}`) : `#${n}`, " "])));
  }
  if (canStartAgent(it, repo, column)) {
    const b = el("button", { class: "sh-btn wk-start", type: "button", "data-start": String(it.number), "data-tour": "start-agent" }, "Start agent");
    b.onclick = () => deps.startAgent(project, it.number!);
    card.append(b);
  }
  return card;
}

function boardSection(r: BoardResponse, deps: WorkDeps): HTMLElement {
  const box = el("div", { class: "wk-board-in" });
  const b = r.board;
  const read = `read from GitHub ${when(r.readAt)}`;
  if (b.state === "board") {
    const cols = boardColumns(b.columns, b.items);
    box.append(el("div", { class: "sh-dim wk-src", id: "wk-board-src" },
      el("a", { href: b.url, target: "_blank", rel: "noopener" }, `Board #${b.number} ${b.title}`),
      ` · ${boardCoverage(b.items.length, b.total)} · Status field · ${read}`));
    const grid = el("div", { class: "wk-board", style: `grid-template-columns: repeat(${Math.min(cols.length, 4)}, minmax(0, 1fr))` });
    for (const c of cols) {
      const col = el("div", { class: "wk-col", "data-column": c.name }, el("h3", {}, c.name, el("span", { class: "sh-dim wk-count" }, ` · ${c.items.length}`)));
      for (const it of c.items.slice(0, COLUMN_CAP)) col.append(issueCard(it, r.repo, c.name, r.project, deps));
      if (c.items.length > COLUMN_CAP) col.append(el("a", { class: "sh-dim wk-more", href: b.url, target: "_blank", rel: "noopener" }, `and ${c.items.length - COLUMN_CAP} more on the board`));
      if (!c.items.length) col.append(el("span", { class: "sh-dim" }, "nothing in this column"));
      grid.append(col);
    }
    box.append(grid);
    return box;
  }
  const head = b.state === "no board"
    ? el("div", { class: "wk-src", id: "wk-no-board" }, el("b", {}, "no project board — showing open issues"), el("span", { class: "sh-dim" }, ` · ${b.reason}`))
    : el("div", { class: "wk-src wk-warn", id: b.state === "several boards" ? "wk-several-boards" : "wk-board-unreadable" },
        el("b", {}, b.state === "several boards" ? "several boards — showing open issues" : "could not read the board — showing open issues"),
        el("span", {}, ` · ${b.reason}`));
  box.append(head);
  const iss = r.issues;
  if (!iss) return box;
  if (iss.state === "unreadable") {
    box.append(el("div", { class: "sh-card wk-bad", id: "wk-issues-error" }, `Could not read the open issues: ${iss.reason}`));
    return box;
  }
  const many = iss.issues.length >= iss.limit ? `at least ${iss.issues.length}` : String(iss.issues.length);
  box.append(el("div", { class: "sh-dim wk-src", id: "wk-issues-src" }, `${r.repo} · ${many} open issue${iss.issues.length === 1 ? "" : "s"} · ${read}`));
  const list = el("div", { class: "wk-list", id: "wk-issues" });
  if (!iss.issues.length) list.append(el("div", { class: "sh-card" }, `${r.repo} has no open issues.`));
  for (const i of iss.issues) {
    list.append(issueCard({ id: String(i.number), type: "Issue", number: i.number, title: i.title, url: i.url, repo: r.repo, status: null, labels: i.labels, linkedPrs: [] }, r.repo, "open", r.project, deps));
  }
  box.append(list);
  return box;
}

// ---------------------------------------------------------------------------
// New issue
// ---------------------------------------------------------------------------

function newIssueForm(project: string, filed: () => void): { el: HTMLElement; toggle: () => void } {
  const title = el("input", { type: "text", id: "wk-ni-title", placeholder: "Title: the friction, in one line", "aria-label": "Issue title" });
  const body = el("textarea", { id: "wk-ni-body", rows: "5", placeholder: "## Problem\n…\n\n## Fix\n…\n\n## Done when\n…", "aria-label": "Issue body" });
  const go = el("button", { type: "button", class: "sh-btn wk-ni-go", id: "wk-ni-go" }, "File the issue");
  const cancel = el("button", { type: "button", class: "sh-btn" }, "Cancel");
  const out = el("div", { class: "wk-ni-out", "aria-live": "polite" });
  const box = el("div", { class: "sh-card wk-ni", id: "wk-ni", hidden: "" },
    el("div", {}, el("b", {}, "New issue"), el("span", { class: "sh-dim" }, ` in ${project}'s GitHub repository, filed with gh as you`)),
    title, body, el("div", { class: "wk-row" }, go, cancel), out);
  const toggle = () => {
    box.hidden = !box.hidden;
    if (!box.hidden) title.focus();
  };
  cancel.onclick = () => (box.hidden = true);
  go.onclick = async () => {
    go.disabled = true;
    out.replaceChildren(el("span", { class: "sh-dim" }, "Filing…"));
    try {
      const a = await write<NewIssueAnswer>("POST", "/api/issues", { project, title: title.value, body: body.value });
      out.replaceChildren(el("span", { class: "wk-ok", id: "wk-ni-done" }, a.number !== null ? `Filed ${a.repo}#${a.number} ` : "Filed ", el("a", { href: a.url, target: "_blank", rel: "noopener" }, a.url)));
      title.value = "";
      body.value = "";
      filed();
    } catch (e) {
      out.replaceChildren(el("span", { class: "wk-bad" }, e instanceof WriteError ? refusalText(e.status, e.body) : `Not filed: ${(e as Error).message}`));
    } finally {
      go.disabled = false;
    }
  };
  return { el: box, toggle };
}
