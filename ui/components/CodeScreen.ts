/**
 * Project · Code (#88): the package's files coloured by layer, with refused edits, imports that
 * break the design, files AnviDeck's agents edited and known-trap lines; a file at the commit the
 * design reader measured, with git blame. Read-only until **Enable editing**: then the working
 * copy is shown and Save writes it through POST /api/code/:project/edit (ui/write.ts), which
 * refuses while a running agent is touching the file. The rules live in code-model.ts (tested);
 * this file only builds the DOM. All file text is set as text, never as HTML.
 */
import { BROWSER_READ_ONLY, inDesktop, write, WriteError } from "../write";
import { projectTabs } from "../shell/frame";
import { refusalCall } from "./RefusalCall";
import type { CodeFileResponse, CodeTreeOk, CodeTreeResponse, EditResult, Touching, WorkingFile } from "../../shared/code-types";
import type { Refusal, RefusalsResponse } from "../../shared/refusal-types";
import {
  UNMAPPED_COLOR,
  buildTree,
  countsLine,
  defaultFile,
  edgeVerdict,
  editBody,
  editState,
  savedAs,
  gutterOf,
  layerColors,
  lineMarks,
  marks,
  openFolders,
  refusalsSource,
  type LineMark,
  type Marks,
  type TreeNode,
  workingHere,
} from "./code-model";

type Kid = Node | string | null | undefined | false;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const k of kids) if (k !== null && k !== undefined && k !== false) e.append(typeof k === "string" ? document.createTextNode(k) : k);
  return e;
}

function ensureStyles() {
  if (document.querySelector("link[data-code-css]")) return;
  document.head.appendChild(el("link", { rel: "stylesheet", href: "/styles/code.css", "data-code-css": "" }));
}

async function getJson<T>(url: string): Promise<{ ok: true; value: T; status: number } | { ok: false; error: string; status: number }> {
  try {
    const res = await fetch(url);
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok && !("status" in j && typeof j.status === "string")) return { ok: false, error: typeof j.error === "string" ? j.error : `status ${res.status}`, status: res.status };
    return { ok: true, value: j as T, status: res.status };
  } catch (e) {
    return { ok: false, error: (e as Error).message, status: 0 };
  }
}

const local = (iso: string) => `${new Date(iso).toLocaleDateString("sv-SE")} ${new Date(iso).toTimeString().slice(0, 5)}`;
const enc = encodeURIComponent;

type Working = { state: "loading" } | { state: "error"; error: string } | { state: "ok"; value: WorkingFile };

export function CodeScreen(project: string | null, params: URLSearchParams): HTMLElement {
  ensureStyles();
  const wrap = el("section", { class: "sh-screen cd", "data-screen": "code" });
  wrap.innerHTML = projectTabs("code", project);
  const sub = el("span", { class: "sh-sub", id: "cd-sub" }, project ? `${project} · reading…` : "");
  const blameBtn = el("button", { class: "sh-btn", type: "button", id: "cd-blame", "aria-pressed": "false" }, "Blame");
  const editBtn = el("button", { class: "sh-btn", type: "button", id: "cd-edit", "aria-pressed": "false" }, "Enable editing");
  wrap.append(el("div", { class: "sh-head" }, el("h1", {}, "Project · Code"), sub, el("div", { class: "cd-acts" }, blameBtn, editBtn)));
  if (!project) {
    wrap.append(el("div", { class: "sh-card" }, "Pick a project in the switcher above."));
    blameBtn.disabled = editBtn.disabled = true;
    return wrap;
  }
  const p = project;
  const legendEl = el("div", { class: "cd-legend", id: "cd-legend" });
  const countsEl = el("div", { class: "cd-counts sh-dim", id: "cd-counts" });
  const treeEl = el("div", { class: "sh-card cd-tree", id: "cd-tree" }, el("span", { class: "sh-dim" }, "Reading the files at the design reader's commit…"));
  const fileEl = el("div", { class: "cd-file", id: "cd-file" });
  wrap.append(legendEl, countsEl, el("div", { class: "cd-wrap" }, treeEl, fileEl));

  let tree: CodeTreeOk | null = null;
  let refusals: RefusalsResponse | null = null;
  let refusalsError: string | null = null;
  let m: Marks | null = null;
  let colors: Record<string, string> = {};
  let componentOf = new Map<string, string | null>();
  let selected: string | null = params.get("file");
  /** The file was picked by the screen, not by you: it may move to a refused file once refusals arrive. */
  let autoPicked = !selected;
  let view: { file: string; resp: CodeFileResponse | null; error?: string } | null = null;
  let blame = params.get("blame") === "1";
  let editing = false;
  let working: Working | null = null;
  let open = new Set<string>();
  let openLine: number | null = null;

  const setHash = () => {
    const q = new URLSearchParams();
    if (selected) q.set("file", selected);
    if (blame) q.set("blame", "1");
    history.replaceState(null, "", `#code${q.toString() ? `?${q}` : ""}`);
  };

  function paintHead() {
    const file = selected ?? "no file";
    sub.textContent = `${p} · ${file} · ${editState(editing, working)}`;
    blameBtn.setAttribute("aria-pressed", String(blame));
    blameBtn.classList.toggle("on", blame);
    editBtn.textContent = editing ? "Editing on" : "Enable editing";
    editBtn.setAttribute("aria-pressed", String(editing));
    editBtn.classList.toggle("on", editing);
  }

  function paintLegend() {
    if (!tree) return;
    const comps = tree.structure.status === "measured" ? tree.structure.components.map((c) => c.name) : [];
    legendEl.replaceChildren(
      ...comps.map((c) => el("span", {}, el("i", { style: `background:${colors[c]}` }), c)),
      el("span", {}, el("i", { style: `background:${UNMAPPED_COLOR}` }), tree.structure.status === "measured" ? "not in the design" : "no layers: no design measured"),
      el("span", {}, "· ", el("span", { class: "cd-bad" }, "✕"), " refused edit · ", el("span", { class: "cd-warn" }, "◆"), " divergent import · ",
        el("span", { class: "cd-acc" }, "●"), " agent touched · ", el("span", { class: "cd-trap" }, "▲"), " known trap"),
    );
  }

  function paintCounts() {
    if (!tree || !m) return;
    const win = refusals && "window" in refusals && refusals.window ? `${refusals.window.chosenBy}` : null;
    const src = refusalsSource(refusals, refusalsError);
    const s = tree.structure;
    const design = s.status === "measured" ? `design ${s.designId} at ${tree.commit.ref} ${tree.commit.sha.slice(0, 7)}${tree.commit.date ? ` (${tree.commit.date.slice(0, 10)})` : ""}, ${s.source.label}` : `${tree.commit.ref} ${tree.commit.sha.slice(0, 7)}`;
    countsEl.replaceChildren(
      ...countsLine(m, src, tree, win).map((t, i) => el("div", { "data-count": ["refused", "breaking", "touched", "traps"][i] }, t)),
      el("div", {}, `files: ${tree.files.length} tracked (${tree.filesFrom}) · ${design}`),
      el("div", {}, `editing: ${tree.editRule}`),
    );
  }

  function treeRow(depth: number, kids: Kid[], cls = ""): HTMLElement {
    return el("div", { class: `cd-row ${cls}`, style: `padding-left:${6 + depth * 12}px` }, ...kids);
  }

  function marksOf(f: string): Kid[] {
    const fm = m?.byFile.get(f);
    if (!fm) return [];
    const out: Kid[] = [];
    if (fm.refused.length) out.push(el("span", { class: "cd-mk cd-bad", title: `${fm.refused.length} refused edit(s)` }, fm.refused.length > 1 ? `✕${fm.refused.length}` : "✕"));
    if (fm.divergent.length) out.push(el("span", { class: "cd-mk cd-warn", title: `${fm.divergent.length} import(s) that break the design` }, fm.divergent.length > 1 ? `◆${fm.divergent.length}` : "◆"));
    if (fm.touched.length) out.push(el("span", { class: "cd-mk cd-acc", title: `edited by ${[...new Set(fm.touched.map((t) => t.agent))].join(", ")}` }, "●"));
    if (fm.traps.length) out.push(el("span", { class: "cd-mk cd-trap", title: `${fm.traps.length} catalogue citation(s)` }, "▲"));
    return out;
  }

  function paintTree() {
    if (!tree || !m) return;
    const root = buildTree(tree.files, m);
    const rows: HTMLElement[] = [];
    const walk = (n: TreeNode, depth: number) => {
      for (const d of n.dirs) {
        const isOpen = open.has(d.path);
        const sum: Kid[] = [];
        if (!isOpen) {
          if (d.refused) sum.push(el("span", { class: "cd-mk cd-bad" }, `✕${d.refused}`));
          if (d.divergent) sum.push(el("span", { class: "cd-mk cd-warn" }, `◆${d.divergent}`));
          if (d.touched) sum.push(el("span", { class: "cd-mk cd-acc" }, `●${d.touched}`));
        }
        const row = treeRow(depth, [el("span", { class: "sh-dim" }, isOpen ? "▾" : "▸"), d.name, ...sum], "cd-dir");
        row.dataset.dir = d.path;
        row.onclick = () => {
          if (open.has(d.path)) open.delete(d.path);
          else open.add(d.path);
          paintTree();
        };
        rows.push(row);
        if (isOpen) walk(d, depth + 1);
      }
      for (const f of n.files) {
        const comp = componentOf.get(f.path) ?? null;
        const row = treeRow(depth, [el("span", { class: "cd-sw", style: `background:${comp ? colors[comp] : UNMAPPED_COLOR}`, title: comp ?? "not in the design" }), el("span", { class: "cd-name" }, f.name), ...marksOf(f.path)], f.path === selected ? "on" : "");
        row.dataset.file = f.path;
        row.onclick = () => select(f.path);
        rows.push(row);
      }
    };
    walk(root, 0);
    const extra: HTMLElement[] = [];
    if (m.refusedElsewhere.length) {
      extra.push(el("div", { class: "cd-elsewhere sh-dim" }, `Refused edits on files not tracked at ${tree.commit.sha.slice(0, 7)} (the refused edit would have made them):`));
      for (const r of m.refusedElsewhere) extra.push(el("div", { class: "cd-row", title: r.reason ?? "" }, el("span", { class: "cd-mk cd-bad" }, "✕"), el("span", { class: "cd-name" }, r.file), el("span", { class: "sh-dim" }, local(r.at))));
    }
    treeEl.replaceChildren(...rows, ...extra);
  }

  function chip(text: string, tone: string) {
    return el("span", { class: `sh-chip cd-chip-${tone}` }, text);
  }

  function refusalCard(r: Refusal, placed: boolean): HTMLElement {
    const pairs = r.pairs.length ? r.pairs.map((x) => `${x.pair}: ${x.key}`) : r.violations.map((v) => `${v.rule}: ${v.key}`);
    return el("div", { class: "cd-card cd-card-bad", "data-refusal": r.key },
      el("div", { class: "cd-row-flex" }, chip("not allowed by the design", "bad"), el("span", { class: "sh-dim" }, `${r.refusedBy}${r.checkToo && r.refusedBy === "graph rule" ? " (the project's own check too)" : ""} · design ${r.design ?? "not named"}`)),
      ...pairs.map((t) => el("div", { class: "cd-mono" }, t)),
      r.reason ? el("pre", { class: "cd-reason" }, r.reason) : el("div", { class: "cd-warn" }, `The guard's words could not be re-read: ${r.reasonError ?? "no reason given"}`),
      el("div", { class: "sh-dim" }, `Blocked ${local(r.at)} · ${r.tool} in the ${r.checkout} checkout ${r.checkoutDir} · session ${r.session.slice(0, 8)}`),
      placed ? null : el("div", { class: "sh-dim" }, `The refused import is not in this file at ${tree!.commit.sha.slice(0, 7)}: the edit never landed.`),
      refusalCall({ key: r.key, project: p, refusal: { session: r.session, tool: r.tool, file: r.file, at: r.at } }),
      el("a", { href: `#map?project=${enc(p)}` }, "see on the design graph"),
    );
  }

  function markCard(mk: LineMark): HTMLElement {
    if (mk.kind === "divergent" && mk.edge) {
      const v = edgeVerdict(mk.edge);
      const s = tree!.structure;
      const note = s.status === "measured" && mk.edge.pair ? s.edgeNotes[mk.edge.pair] : undefined;
      return el("div", { class: `cd-card cd-card-${v.tone}` },
        el("div", { class: "cd-row-flex" }, chip(v.text, v.tone)),
        el("div", { class: "cd-mono" }, `${mk.edge.pair ?? "?"}: ${mk.edge.from} → ${mk.edge.to}${mk.edge.typeOnly ? " (type only)" : ""}`),
        note ? el("div", { class: "sh-dim" }, `The design's note on ${mk.edge.pair}: ${note}`) : null,
        el("div", { class: "sh-dim" }, `From the design reader at ${tree!.commit.ref} ${tree!.commit.sha.slice(0, 7)}.`),
        el("a", { href: `#map?project=${enc(p)}` }, "see on the design graph"));
    }
    if (mk.kind === "refused" && mk.refusal) return refusalCard(mk.refusal, true);
    const t = mk.trap!;
    return el("div", { class: "cd-card cd-card-trap" },
      el("div", { class: "cd-row-flex" }, chip(`cited by ${t.kind === "error pattern" ? "an" : "a"} ${t.kind}`, "trap"), el("span", { class: "cd-mono" }, `${t.entryId}`), el("span", {}, t.title)),
      el("div", { class: "sh-dim" }, `${t.catalogue}.md · ${t.field}: ${t.cite}. The line is as the entry cites it; the entry does not say at which commit, so the file may have moved since.`));
  }

  function paintFile() {
    paintHead();
    if (!tree) return;
    if (!selected) {
      fileEl.replaceChildren(el("div", { class: "sh-card sh-dim" }, "No file to show."));
      return;
    }
    const fm = m?.byFile.get(selected);
    const head = el("div", { class: "cd-filehead sh-dim" }, el("span", { class: "cd-mono" }, selected), ` at ${tree.commit.ref} ${tree.commit.sha.slice(0, 7)} · component ${componentOf.get(selected) ?? "none"}`);
    const cards: HTMLElement[] = [];
    if (fm?.touched.length)
      cards.push(el("div", { class: "cd-card cd-card-acc" },
        el("div", {}, el("b", {}, "AnviDeck agents edited this file")),
        ...fm.touched.map((t) => el("div", { class: "cd-mono" }, `${t.agent} (${t.running ? "running" : "not running"}) · ${t.edit.tool} ${local(t.edit.at)} · ${t.edit.abs}`))));
    if (editing) {
      fileEl.replaceChildren(head, ...cards, editPanel());
      return;
    }
    if (!view || view.file !== selected || (!view.resp && !view.error)) {
      fileEl.replaceChildren(head, ...cards, el("div", { class: "sh-card sh-dim" }, "Reading the file and its blame…"));
      return;
    }
    if (view.error) {
      fileEl.replaceChildren(head, ...cards, el("div", { class: "sh-card cd-bad" }, `Could not read the file: ${view.error}`));
      return;
    }
    const r = view.resp!;
    if (r.status !== "ok") {
      fileEl.replaceChildren(head, ...cards, el("div", { class: "sh-card" }, `${r.status}: ${r.reason}`));
      return;
    }
    const lm = lineMarks(r.text, selected, fm);
    const refusedPlaced = new Set([...lm.byLine.values()].flat().filter((x) => x.kind === "refused").map((x) => x.refusal!.key));
    for (const ref of fm?.refused ?? []) if (!refusedPlaced.has(ref.key)) cards.push(refusalCard(ref, false));
    for (const u of lm.unplaced.filter((x) => x.kind !== "refused"))
      cards.push(el("div", { class: "cd-unplaced" }, u.kind === "divergent"
        ? `◆ ${u.edge!.pair}: the import of ${u.edge!.to} was not found on a line of this file (the design reader names the edge).`
        : `▲ ${u.trap!.entryId} cites ${u.trap!.cite}, past the end of this file (${r.text.split("\n").length} lines) at ${r.sha.slice(0, 7)}.`));
    const lines = r.text.split("\n");
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    const editor = el("div", { class: `cd-editor${blame ? " blame" : ""}`, id: "cd-editor" });
    const bl = r.blame.status === "ok" ? r.blame : null;
    let prev = "";
    lines.forEach((text, i) => {
      const n = i + 1;
      const ms = lm.byLine.get(n);
      const g = gutterOf(ms);
      const kids: Kid[] = [];
      if (blame) {
        const sha = bl?.lines[i] ?? "";
        const c = bl?.commits[sha];
        kids.push(el("span", { class: "cd-bl", title: c ? `${c.sha}\n${c.author} · ${c.at}\n${c.summary}` : "" }, sha && sha !== prev && c ? `${sha.slice(0, 7)} ${c.at.slice(0, 10)} ${c.author}` : ""));
        prev = sha;
      }
      kids.push(el("span", { class: `cd-g ${g ? `cd-${g.cls}` : ""}` }, g?.glyph ?? ""), el("span", { class: "cd-num" }, String(n)), el("span", { class: "cd-t" }, text));
      const row = el("div", { class: `cd-l${g ? ` mk-${g.cls}` : ""}`, "data-line": String(n) }, ...kids);
      if (ms) {
        row.classList.add("has");
        row.onclick = () => {
          openLine = openLine === n ? null : n;
          paintFile();
        };
      }
      editor.append(row);
      if (ms && openLine === n) editor.append(el("div", { class: "cd-hover" }, ...ms.map(markCard)));
    });
    const blameNote = blame ? el("div", { class: "sh-dim cd-note" }, r.blame.status === "ok" ? `blame: git blame ${r.sha.slice(0, 7)} -- ${r.file} (${Object.keys(r.blame.commits).length} commits)` : `blame could not be read: ${r.blame.reason}`) : null;
    fileEl.replaceChildren(head, ...cards, blameNote ?? "", editor);
  }

  function editPanel(): HTMLElement {
    const box = el("div", { class: "sh-card cd-editpanel", id: "cd-editpanel" });
    if (!working || working.state === "loading") return (box.append(el("span", { class: "sh-dim" }, "Reading the working copy…")), box);
    if (working.state === "error") return (box.append(el("div", { class: "cd-bad" }, `Read-only: ${working.error}`), el("div", { class: "sh-dim" }, tree!.editRule)), box);
    const w = working.value;
    // The file as the page last knew it: the one opened, then each one a Save wrote.
    let base: WorkingFile = w;
    const info = el("div", { class: "sh-dim", id: "cd-wc" });
    const paintInfo = () => (info.textContent = `Working copy ${base.abs} · ${base.bytes} bytes · sha256 ${base.hash.slice(0, 12)} · ${base === w ? "read" : "written"} ${local(base.readAt)}. This is the file on disk, not the commit shown with Blame.`);
    paintInfo();
    box.append(info);
    if (!w.editable) {
      box.append(el("div", { class: "cd-bad", id: "cd-readonly" }, `Read-only: ${w.reason}`), ...w.touching.map((t: Touching) => el("div", { class: "cd-mono" }, `${t.why}: ${t.detail}`)), el("div", { class: "sh-dim" }, `Rule: ${w.rule}`));
      box.append(el("pre", { class: "cd-reason" }, w.text));
      return box;
    }
    const ta = el("textarea", { class: "cd-ta", id: "cd-ta", spellcheck: "false" });
    ta.value = w.text;
    const save = el("button", { class: "sh-btn", type: "button", id: "cd-save" }, "Save");
    const out = el("div", { class: "cd-out", id: "cd-out" });
    const what = el("span", { class: "sh-dim" });
    const paintWhat = () => (what.textContent = ta.value === base.text ? "no change yet" : `Save writes this text (${new TextEncoder().encode(ta.value).length} bytes) over the file whose sha256 is ${base.hash.slice(0, 12)}; it is refused if the file changed since, or an agent starts working on it.`);
    ta.oninput = paintWhat;
    paintWhat();
    save.onclick = async () => {
      save.disabled = true;
      out.className = "cd-out";
      out.textContent = "writing…";
      try {
        const content = ta.value;
        const r = await write<EditResult>("POST", `/api/code/${enc(p)}/edit`, editBody(base, content));
        out.textContent = `Written ${local(r.writtenAt)}: ${r.abs}, sha256 ${r.before.slice(0, 12)} → ${r.after.slice(0, 12)}, ${r.bytes} bytes. The action log has it (GET /api/actions).`;
        out.classList.add("cd-ok");
        base = savedAs(base, content, r);
        working = { state: "ok", value: base };
        paintInfo();
        paintWhat();
      } catch (e) {
        out.classList.add("cd-bad");
        out.textContent = e instanceof WriteError ? `Not written (${e.status}): ${e.message}` : `Not written: ${(e as Error).message}`;
      } finally {
        save.disabled = false;
      }
    };
    box.append(el("div", { class: "sh-dim" }, `Rule: ${w.rule}`), ta, el("div", { class: "cd-row-flex" }, save, what), out);
    return box;
  }

  async function loadWorking() {
    if (!tree || !selected) return;
    working = { state: "loading" };
    paintFile();
    const path = tree.packageRel ? `${tree.packageRel}/${selected}` : selected;
    const r = await getJson<WorkingFile & { error?: string }>(`/api/code/${enc(p)}/working?path=${enc(path)}`);
    working = r.ok && !r.value.error ? { state: "ok", value: workingHere(r.value, inDesktop(), BROWSER_READ_ONLY) } : { state: "error", error: r.ok ? String(r.value.error) : r.error };
    paintFile();
  }

  async function loadFile(f: string) {
    if (!tree) return;
    view = { file: f, resp: null };
    paintFile();
    const path = tree.packageRel ? `${tree.packageRel}/${f}` : f;
    const r = await getJson<CodeFileResponse>(`/api/code/${enc(p)}/file?path=${enc(path)}&sha=${tree.commit.sha}`);
    if (selected !== f) return;
    view = r.ok ? { file: f, resp: r.value } : { file: f, resp: null, error: r.error };
    paintFile();
  }

  function select(f: string) {
    selected = f;
    autoPicked = false;
    openLine = null;
    setHash();
    paintTree();
    if (editing) void loadWorking();
    else void loadFile(f);
  }

  function recompute() {
    if (!tree) return;
    m = marks(tree, refusalsSource(refusals, refusalsError));
    paintLegend();
    paintCounts();
    paintTree();
  }

  blameBtn.onclick = () => {
    blame = !blame;
    setHash();
    paintFile();
  };
  editBtn.onclick = () => {
    editing = !editing;
    working = null;
    if (editing) void loadWorking();
    else if (selected) void loadFile(selected);
    paintFile();
  };

  async function loadRefusals() {
    const r = await getJson<RefusalsResponse>(`/api/refusals?project=${enc(p)}`);
    if (r.ok) {
      refusals = r.value;
      refusalsError = null;
    } else refusalsError = r.error;
    recompute();
    if (tree && m && autoPicked && !editing) {
      const best = defaultFile(tree.files, m);
      if (best && best !== selected) {
        open = openFolders(buildTree(tree.files, m), best);
        select(best);
        autoPicked = true;
      }
    }
    if (tree && selected && !editing) paintFile();
    if (r.ok && r.value.status === "measuring" && wrap.isConnected !== false) setTimeout(() => wrap.isConnected && void loadRefusals(), 10_000);
  }

  void (async () => {
    const r = await getJson<CodeTreeResponse>(`/api/code/${enc(p)}`);
    if (!r.ok) {
      treeEl.replaceChildren(el("span", { class: "cd-bad" }, `Could not read the files: ${r.error}`));
      return;
    }
    if (r.value.status !== "ok") {
      treeEl.replaceChildren(el("span", { class: "cd-bad" }, `${r.value.status}: ${r.value.reason}`));
      sub.textContent = `${p} · ${r.value.status}`;
      return;
    }
    tree = r.value;
    const s = tree.structure;
    colors = layerColors(s.status === "measured" ? s.components.map((c) => c.name) : []);
    componentOf = new Map(s.status === "measured" ? s.modules.map((x) => [x.path, x.component]) : []);
    recompute();
    if (!selected || !tree.files.includes(selected)) selected = defaultFile(tree.files, m!);
    open = openFolders(buildTree(tree.files, m!), selected);
    setHash();
    paintTree();
    if (selected) void loadFile(selected);
    void loadRefusals();
  })();
  paintHead();
  return wrap;
}
