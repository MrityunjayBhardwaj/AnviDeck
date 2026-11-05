/**
 * The Changes screen (#84): one PR's files, the layers and boundaries it touches, its diff with
 * the anvi context the agent received for each file (shown once per file: the injector's log names
 * the file, not the lines, so a per-hunk join is not yet possible, #153), line comments that go to the PR's running
 * agent, the evidence and self-review from the PR body, and a guided tour in commit order.
 *
 * Reads GET /api/changes/*, GET /api/agents and GET /api/agents/:id; writes only through
 * ui/write.ts (a line comment is POST /api/agents/:id/message, the #79 endpoint).
 */
import type { ChangesPrList, ChangesResponse } from "../../shared/changes-types";
import { messagesIn, type SentMessage } from "../../shared/agent-messages";
import { api } from "../api";
import { write, WriteError } from "../write";
import {
  boundariesTouched,
  commentTarget,
  contextFor,
  contextLine,
  evidenceView,
  guidedTour,
  openByDefault,
  parseDiff,
  pickPr,
  sessionsSummary,
  type AgentsList,
  type CommentTarget,
  type DiffFile,
  type DiffLine,
  type Tour,
} from "./changes-model";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const when = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${d.toISOString().slice(0, 10)} ${d.toTimeString().slice(0, 5)}`;
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const body = (await res.json().catch(() => null)) as any;
  if (!res.ok) throw new Error(`${res.status} ${body?.error ?? res.statusText}`);
  return body as T;
}

export function ChangesScreen(project: string | null, prParam: string | null): HTMLElement {
  const root = el("section", "sh-screen chg-screen");
  root.dataset.screen = "changes";
  if (!project) {
    root.append(el("div", "sh-head", "<h1>Changes</h1>"), el("div", "sh-message", "Pick a project in the switcher above."));
    return root;
  }
  root.append(el("div", "sh-head", `<h1>Changes</h1><span class="sh-sub">${esc(project)} · reading open PRs…</span>`));
  void load(root, project, prParam);
  return root;
}

async function load(root: HTMLElement, project: string, prParam: string | null) {
  let list: ChangesPrList | null = null;
  let listError: string | null = null;
  try {
    list = await getJson<ChangesPrList>(`/api/changes/prs?project=${encodeURIComponent(project)}`);
  } catch (e) {
    listError = (e as Error).message;
  }
  const n = pickPr(prParam, list?.prs ?? []);
  if (n === null) {
    root.innerHTML = "";
    root.append(head(project, null, list, listError));
    root.append(
      el(
        "div",
        "sh-card",
        listError
          ? `<b>Could not read the open PRs.</b> <span class="sh-dim">${esc(listError)}</span> Name a PR number above to open one.`
          : `No open PRs in <span class="mono">${esc(list!.repo)}</span> (asked GitHub at ${esc(when(list!.readAt))}). Name a PR number above to open a merged or closed one.`,
      ),
    );
    return;
  }
  root.querySelector(".sh-sub")!.textContent = `${project} · reading PR #${n} (diff, commits, sessions, hook logs)…`;
  let r: ChangesResponse;
  try {
    r = await getJson<ChangesResponse>(`/api/changes/pr/${n}?project=${encodeURIComponent(project)}`);
  } catch (e) {
    root.innerHTML = "";
    root.append(head(project, null, list, listError), el("div", "sh-card chg-bad", `<b>Could not read PR #${n}.</b> ${esc((e as Error).message)}`));
    return;
  }
  root.innerHTML = "";
  render(root, project, r, list, listError, !prParam);
}

function head(project: string, r: ChangesResponse | null, list: ChangesPrList | null, listError: string | null): HTMLElement {
  const h = el("div", "sh-head chg-head");
  const pr = r?.pr;
  h.innerHTML = `<h1>Changes</h1>${
    pr
      ? `<span class="sh-sub">PR #${pr.number} · <span class="mono">${esc(pr.headRefName)}</span> · ${pr.files.length} files · <span class="chg-ok">+${pr.additions}</span> <span class="chg-bad">−${pr.deletions}</span></span>
         <span class="sh-chip">${esc(pr.state.toLowerCase())}${pr.isDraft ? " · draft" : ""}</span>`
      : `<span class="sh-sub">${esc(project)}</span>`
  }<div class="chg-acts"></div>`;
  const acts = h.querySelector(".chg-acts")!;
  const pick = el("select", "chg-pick") as HTMLSelectElement;
  pick.setAttribute("aria-label", "Open PRs");
  pick.innerHTML =
    `<option value="">${list ? `${list.prs.length} open PR${list.prs.length === 1 ? "" : "s"}` : listError ? "open PRs: could not read" : "open PRs…"}</option>` +
    (list?.prs ?? []).map((p) => `<option value="${p.number}"${pr?.number === p.number ? " selected" : ""}>#${p.number} ${esc(p.title.slice(0, 70))}</option>`).join("");
  if (listError) pick.title = listError;
  pick.addEventListener("change", () => {
    if (pick.value) location.hash = `#changes?project=${encodeURIComponent(project)}&pr=${pick.value}`;
  });
  const num = el("input", "chg-num") as HTMLInputElement;
  num.placeholder = "PR #";
  num.setAttribute("aria-label", "PR number");
  num.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && /^\d+$/.test(num.value.trim())) location.hash = `#changes?project=${encodeURIComponent(project)}&pr=${num.value.trim()}`;
  });
  acts.append(pick, num);
  if (pr) {
    const tourBtn = el("button", "sh-btn chg-tour-btn", "Ask for a guided tour") as HTMLButtonElement;
    tourBtn.type = "button";
    const check = el("a", "sh-btn chg-primary", "Open PR checklist") as HTMLAnchorElement;
    check.href = `#work?pr=${pr.number}&project=${encodeURIComponent(project)}`;
    acts.append(tourBtn, check);
  }
  return h;
}

function render(root: HTMLElement, project: string, r: ChangesResponse, list: ChangesPrList | null, listError: string | null, defaulted: boolean) {
  const pr = r.pr;
  root.append(head(project, r, list, listError));
  const src = el(
    "div",
    "chg-src sh-dim",
    `<a href="${esc(pr.url)}" target="_blank" rel="noopener">${esc(r.repo)}#${pr.number}</a> “${esc(pr.title)}” · read from GitHub (gh) at ${esc(when(r.readAt))}${
      defaulted ? " · shown because it is the newest open PR" : ""
    }`,
  );
  root.append(src);

  const diffFiles = r.diff.status === "ok" ? parseDiff(r.diff.text) : [];
  const tour = guidedTour(r.commits, pr.files);
  const grid = el("div", "chg-grid");
  const left = el("div", "chg-col");
  const mid = el("div", "chg-col chg-mid");
  const right = el("div", "chg-col");
  grid.append(left, mid, right);
  root.append(grid);

  // ── left: files, layers, boundaries ──
  const filesCard = el("div", "sh-card chg-card", `<h3>Files</h3>`);
  const filesList = el("div", "chg-files");
  for (const f of pr.files) {
    const row = el("button", "chg-file", `<span class="mono">${esc(f.path)}</span><span><span class="chg-ok">+${f.additions}</span> <span class="chg-bad">−${f.deletions}</span></span>`) as HTMLButtonElement;
    row.type = "button";
    row.dataset.file = f.path;
    row.title = f.path;
    row.addEventListener("click", () => showFile(f.path));
    filesList.append(row);
  }
  filesCard.append(filesList);
  if (r.filesRead.status === "partial") filesCard.append(el("div", "chg-note chg-bad", `Partial file list: ${esc(r.filesRead.reason)}.`));
  else if (r.filesRead.from !== "gh pr view")
    filesCard.append(el("div", "sh-dim chg-note", `All ${pr.files.length} files, from ${esc(r.filesRead.from)} (gh pr view lists at most 100).`));
  left.append(filesCard);

  const layersCard = el("div", "sh-card chg-card", "<h3>Layers touched</h3>");
  if (r.layers.status === "unknown") {
    layersCard.append(el("div", "chg-note", `<span class="sh-chip">layers unknown</span> ${esc(r.layers.reason)}`));
  } else {
    const L = r.layers;
    const unmapped = L.files.filter((f) => !f.layer).length;
    layersCard.append(
      el("div", "chg-tags", L.layers.length ? L.layers.map((l) => `<span class="chg-tag" title="${l.files} file(s)">${esc(l.name)} · ${l.files}</span>`).join("") : `<span class="sh-dim">no PR file sits in a block</span>`),
      el(
        "div",
        "sh-dim chg-note",
        `${unmapped ? `${unmapped} file(s) in no block. ` : ""}Layer map from anvi's structure guard: ${esc(L.packageDir)} measured at ${esc(L.measuredAt.ref)} ${esc(L.measuredAt.sha.slice(0, 8))}${L.measuredAt.date ? ` (${esc(L.measuredAt.date.slice(0, 10))})` : ""}.`,
      ),
    );
  }
  left.append(layersCard);

  const b = boundariesTouched(r, pr.files);
  const bCard = el("div", "sh-card chg-card", "<h3>Boundaries</h3>");
  if (b.state === "listed" && b.items.length)
    bCard.append(el("div", "chg-stack", b.items.map((i) => `<span class="sh-chip chg-bchip" title="${esc(i.files.join("\n"))}">${esc(i.name)}</span>`).join("")));
  bCard.append(el("div", `chg-note ${b.state === "unreadable" ? "chg-bad" : "sh-dim"}`, esc(b.note)));
  left.append(bCard);

  const ss = sessionsSummary(r.sessions);
  const sCard = el("div", "sh-card chg-card", "<h3>Agent sessions</h3>");
  for (const p of ss.problems) sCard.append(el("div", "chg-note chg-bad", esc(p)));
  for (const l of ss.lines) sCard.append(el("div", "chg-note sh-dim", esc(l)));
  left.append(sCard);

  // ── middle: tour banner, comment status, diff ──
  const banner = el("div", "sh-card chg-banner");
  banner.hidden = true;
  mid.append(banner);

  const target = commentTarget(r.sessions, { state: "loading" });
  const cmtNote = el("div", "chg-cmt-note sh-dim");
  cmtNote.dataset.tour = "line-comments";
  mid.append(cmtNote);
  let currentTarget: CommentTarget = target;
  const paintTarget = () => {
    cmtNote.textContent = currentTarget.enabled ? `Line comments: ${currentTarget.note} Click a line number to comment.` : `Line comments off: ${currentTarget.why}`;
  };
  paintTarget();

  const diffCard = el("div", "chg-diff");
  diffCard.dataset.tour = "diff";
  mid.append(diffCard);
  const fileEls = new Map<string, HTMLElement>();
  const priorComments: SentMessage[] = [];

  if (r.diff.status === "unreadable") {
    diffCard.append(el("div", "chg-annot chg-bad-annot", `<b>Could not read the diff.</b> ${esc(r.diff.reason)}`));
  } else if (diffFiles.length === 0) {
    diffCard.append(el("div", "chg-annot", "gh pr diff returned no file changes."));
  }
  const open = openByDefault(diffFiles);
  for (const f of diffFiles) {
    const sec = el("div", "chg-fsec");
    sec.dataset.file = f.path;
    fileEls.set(f.path, sec);
    diffCard.append(sec);
    paintFile(sec, f, open.has(f.path));
  }

  function paintFile(sec: HTMLElement, f: DiffFile, drawn: boolean) {
    sec.innerHTML = "";
    const nLines = f.hunks.reduce((s, h) => s + h.lines.length, 0);
    const hd = el(
      "div",
      "chg-fhead",
      `<span class="mono">${esc(f.path)}</span>${f.oldPath ? ` <span class="sh-dim">from ${esc(f.oldPath)}</span>` : ""} <span class="sh-chip">${f.status}</span> <span class="chg-ok">+${f.additions}</span> <span class="chg-bad">−${f.deletions}</span>`,
    );
    sec.append(hd);
    if (f.binary) {
      sec.append(el("div", "chg-annot", "Binary file: no text diff."));
      return;
    }
    if (!drawn) {
      const more = el("button", "sh-btn chg-show", `Show diff (${nLines} lines in ${f.hunks.length} hunk${f.hunks.length === 1 ? "" : "s"})`) as HTMLButtonElement;
      more.type = "button";
      more.addEventListener("click", () => paintFile(sec, f, true));
      sec.append(more);
      return;
    }
    // Once per file: the injector's log names the file an edit touched, not its lines, so the same
    // context under every hunk would claim a per-hunk join this screen does not have (#153).
    const ctx = contextFor(f.path, r.sessions);
    const ctxText = contextLine(ctx, r.titles, r.dharana);
    sec.append(
      el(
        "div",
        `chg-annot chg-fctx ${ctx.kind === "fired" ? "" : ctx.kind === "could-not-look" || ctx.kind === "not-searched" ? "chg-bad-annot" : "chg-quiet"}`,
        `<b>Context the agent received for this file</b> <span class="sh-dim">(per file: the hook log does not say which lines)</span>. ${esc(ctxText)}`,
      ),
    );
    if (f.hunks.length === 0) sec.append(el("div", "chg-annot", "No text hunks (a mode change, an empty file or a rename only)."));
    for (const h of f.hunks) {
      sec.append(el("div", "chg-hunk mono", esc(`@@ ${f.path}  −${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@${h.header.replace(/^@@[^@]*@@/, "")}`)));
      for (const ln of h.lines) sec.append(lineEl(f, ln));
    }
  }

  function lineEl(f: DiffFile, ln: DiffLine): HTMLElement {
    const wrap = el("div", "chg-lwrap");
    const sign = ln.kind === "add" ? "+" : ln.kind === "del" ? "−" : ln.kind === "meta" ? "" : " ";
    const row = el("div", `chg-ln ${ln.kind}`, `<span class="n">${ln.oldNo ?? ""}</span><span class="n chg-newno">${ln.newNo ?? ""}</span><span class="sign">${sign}</span><span class="t">${esc(ln.text)}</span>`);
    wrap.append(row);
    if (ln.newNo !== null) {
      const no = row.querySelector(".chg-newno") as HTMLElement;
      no.title = currentTarget.enabled ? "Comment on this line" : currentTarget.why;
      no.classList.add("chg-clickable");
      no.addEventListener("click", () => toggleBox(wrap, f.path, ln));
      for (const m of priorComments) if (m.comment?.file === f.path && m.comment.line === ln.newNo) wrap.append(commentEl(m));
    }
    return wrap;
  }

  function commentEl(m: SentMessage): HTMLElement {
    const state = m.state === "delivered" ? "delivered" : m.state === "not-delivered" ? `not delivered${m.reason ? ` (${m.reason})` : ""}` : "queued";
    const d = el("div", "chg-annot chg-cmt", `<b>You</b> · line ${m.comment?.line}: ${esc(m.said)} <span class="sh-dim">· ${esc(when(m.sentAt))} · ${esc(state)}</span>`);
    d.dataset.messageId = m.messageId;
    return d;
  }

  function toggleBox(wrap: HTMLElement, file: string, ln: DiffLine) {
    const existing = wrap.querySelector(".chg-box");
    if (existing) {
      existing.remove();
      return;
    }
    const box = el("div", "chg-box");
    const ta = el("textarea") as HTMLTextAreaElement;
    ta.rows = 2;
    ta.setAttribute("aria-label", `Comment on ${file} line ${ln.newNo}`);
    const send = el("button", "sh-btn", "Send to agent") as HTMLButtonElement;
    send.type = "button";
    const out = el("div", "chg-box-out sh-dim");
    const t = currentTarget;
    if (!t.enabled) {
      ta.disabled = true;
      send.disabled = true;
      ta.placeholder = t.why;
      out.textContent = t.why;
    } else {
      ta.placeholder = `Comment on line ${ln.newNo}; the agent reads the file, the line number and the line's text.`;
      out.textContent = t.note;
    }
    send.addEventListener("click", async () => {
      if (!t.enabled || !ta.value.trim()) return;
      send.disabled = true;
      out.textContent = "Sending…";
      try {
        const res = await write<{ message: SentMessage }>("POST", `/api/agents/${encodeURIComponent(t.agentId)}/message`, {
          comment: { file, line: ln.newNo, lineText: ln.text, text: ta.value },
        });
        const m = res.message;
        const shown = commentEl(m);
        box.replaceWith(shown);
        void followDelivery(t.agentId, m.messageId, shown);
      } catch (e) {
        send.disabled = false;
        out.className = "chg-box-out chg-bad";
        out.textContent = e instanceof WriteError ? `Not sent (${e.status}): ${e.message}` : `Not sent: ${(e as Error).message}`;
      }
    });
    box.append(ta, el("div", "chg-box-row"), out);
    box.querySelector(".chg-box-row")!.append(send);
    wrap.append(box);
    if (t.enabled) ta.focus();
  }

  /** Read the agent's transcript until the comment is delivered or not (at most ~60 s). */
  async function followDelivery(agentId: string, messageId: string, shown: HTMLElement) {
    for (let i = 0; i < 30; i++) {
      await new Promise((ok) => setTimeout(ok, 2000));
      if (!shown.isConnected) return;
      try {
        const a = await getJson<{ transcript: { at: string; from: string; message: unknown }[] }>(`/api/agents/${encodeURIComponent(agentId)}`);
        const m = messagesIn(a.transcript).find((x) => x.messageId === messageId);
        if (m && m.state !== "queued") {
          shown.replaceWith(commentEl(m));
          return;
        }
      } catch {
        /* keep the queued state shown; the transcript is the record */
      }
    }
  }

  // ── right: evidence, tour, self-review ──
  const ev = evidenceView(pr.body);
  const evCard = el("div", "sh-card chg-card", "<h3>Evidence</h3>");
  evCard.dataset.tour = "evidence";
  if (ev.evidence.state === "not-in-format") evCard.append(el("div", "chg-note sh-dim", esc(ev.evidence.why)));
  else {
    const e = ev.evidence.value;
    for (const t of e.tests)
      evCard.append(
        el(
          "div",
          "chg-row",
          `<span class="chg-pill ${t.exitCode === 0 ? "ok" : "bad"}">tests</span><span class="chg-tag">exit ${t.exitCode}</span><span class="mono chg-cmd">${esc(t.command)}</span><span>${esc(t.result)}</span>`,
        ),
      );
    evCard.append(el("div", "chg-note sh-dim", "Exit is the runner's own status, recorded apart from the tally."));
    for (const o of e.observed) evCard.append(el("div", "chg-row", `<span class="chg-pill ok">observed</span><span>${esc(o)}</span>`));
    if (e.notChecked.length === 0) evCard.append(el("div", "chg-row", `<span class="chg-pill">not checked</span><span class="sh-dim">None, as the author wrote.</span>`));
    for (const o of e.notChecked) evCard.append(el("div", "chg-row", `<span class="chg-pill warn">not checked</span><span>${esc(o)}</span>`));
  }
  right.append(evCard);

  const tourCard = el("div", "sh-card chg-card", "<h3>Guided tour</h3>");
  const ol = el("ol", "chg-tour");
  tour.steps.forEach((s, i) => {
    const li = el(
      "li",
      "",
      `<button type="button" class="chg-linklike mono">${esc(s.file)}</button>${s.commit ? `<div class="sh-dim">commit ${s.commit.index} · ${esc(s.commit.oid.slice(0, 7))} ${esc(s.commit.headline)}</div>` : `<div class="sh-dim">not placed in commit order</div>`}`,
    );
    li.querySelector("button")!.addEventListener("click", () => startTour(i));
    ol.append(li);
  });
  tourCard.append(el("div", `chg-note ${tour.state === "unreadable" ? "chg-bad" : "sh-dim"}`, esc(tour.note)), ol);
  right.append(tourCard);

  const srCard = el("div", "sh-card chg-card", "<h3>Self-review gaps</h3>");
  if (ev.selfReview.state === "not-in-format") srCard.append(el("div", "chg-note sh-dim", esc(ev.selfReview.why)));
  else if (ev.selfReview.value.gaps.length === 0) srCard.append(el("div", "chg-note sh-dim", "None found, as the author wrote."));
  else
    for (const g of ev.selfReview.value.gaps) {
      const repo = g.issue?.repo ?? r.repo;
      const issue = g.issue
        ? `<a class="chg-tag" href="https://github.com/${esc(repo)}/issues/${g.issue.number}" target="_blank" rel="noopener">${g.issue.repo ? esc(g.issue.repo) : ""}#${g.issue.number} filed</a>`
        : `<span class="chg-tag">no issue</span>`;
      srCard.append(el("div", "chg-row", `<span class="chg-pill ${g.severity === "high" ? "bad" : g.severity === "medium" ? "warn" : ""}">${g.severity}</span><span>${esc(g.gap)}</span>${issue}`));
    }
  right.append(srCard);

  // ── navigation: files list, tour ──
  function showFile(path: string) {
    for (const b of filesList.querySelectorAll<HTMLElement>(".chg-file")) b.classList.toggle("on", b.dataset.file === path);
    const sec = fileEls.get(path);
    if (!sec) return;
    const f = diffFiles.find((x) => x.path === path)!;
    if (sec.querySelector(".chg-show")) paintFile(sec, f, true);
    sec.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  let step = -1;
  function startTour(i: number) {
    step = i;
    paintBanner(tour);
    showFile(tour.steps[i].file);
  }
  function paintBanner(t: Tour) {
    if (step < 0) {
      banner.hidden = true;
      return;
    }
    const s = t.steps[step];
    banner.hidden = false;
    banner.innerHTML = `<div><b>Tour ${step + 1} of ${t.steps.length}</b> · <span class="mono">${esc(s.file)}</span> ${
      s.commit ? `<span class="sh-dim">first touched by commit ${s.commit.index}: ${esc(s.commit.headline)}</span>` : `<span class="sh-dim">not placed in commit order</span>`
    }</div><div class="chg-row"><button type="button" class="sh-btn" data-k="prev"${step === 0 ? " disabled" : ""}>Previous</button><button type="button" class="sh-btn" data-k="next"${
      step === t.steps.length - 1 ? " disabled" : ""
    }>Next</button><button type="button" class="sh-btn" data-k="end">End tour</button></div>`;
    banner.querySelector('[data-k="prev"]')!.addEventListener("click", () => startTour(step - 1));
    banner.querySelector('[data-k="next"]')!.addEventListener("click", () => startTour(step + 1));
    banner.querySelector('[data-k="end"]')!.addEventListener("click", () => {
      step = -1;
      paintBanner(t);
    });
  }
  root.querySelector(".chg-tour-btn")?.addEventListener("click", () => {
    if (tour.steps.length) startTour(0);
  });

  // ── the agents: who can take a comment, and comments already sent ──
  void (async () => {
    const read = await api.agentsRead();
    const agents: AgentsList = read.state === "ok" ? { state: "ok", agents: read.agents } : read.state === "loading" ? { state: "loading" } : { state: read.state, reason: read.reason };
    currentTarget = commentTarget(r.sessions, agents);
    paintTarget();
    if (r.sessions.status === "unreadable") return;
    const ids = [...new Set(r.sessions.sessions.map((s) => s.agentId).filter((x): x is string => !!x))];
    const paths = new Set(pr.files.map((f) => f.path));
    for (const id of ids) {
      try {
        const a = await getJson<{ transcript: { at: string; from: string; message: unknown }[] }>(`/api/agents/${encodeURIComponent(id)}`);
        priorComments.push(...messagesIn(a.transcript).filter((m) => m.comment && paths.has(m.comment.file)));
      } catch (e) {
        cmtNote.textContent += ` (Earlier comments to ${id} could not be read: ${(e as Error).message})`;
      }
    }
    // Redraw the drawn files so earlier comments sit under their lines and line titles say where comments go.
    for (const f of diffFiles) {
      const sec = fileEls.get(f.path)!;
      if (!sec.querySelector(".chg-show")) paintFile(sec, f, true);
    }
  })();
}
