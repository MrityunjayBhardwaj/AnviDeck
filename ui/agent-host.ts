/**
 * Temporary page for the agent host (#75): start, watch, stop and resume agents. Deliberately
 * plain; the Agents screen (#82) and the shell (#80) replace it. Served at /agent-host.
 * All text from agents is set with textContent, never as HTML.
 */
import { write, type WriteMethod } from "./write";

import { messagesIn, parseMessageRequest, renderForAgent } from "../shared/agent-messages";
import type { PendingPermission } from "../shared/permission-requests";
import { elsewhereText, type RunsElsewhere } from "../shared/agent-elsewhere";
import { agentRequests, keepCardsOf, onAnswerSent } from "./components/PermissionRequests";

interface Agent {
  id: string;
  sessionId?: string;
  cwd: string;
  prompt: string;
  issue?: number;
  status: string;
  reason?: string;
  apiKeySource?: string;
  claudeCodeVersion?: string;
  model?: string;
  claudePath?: string;
  claudeRealPath?: string;
  strippedEnv?: string[];
  costEstimateUsd?: number;
  createdAt: string;
  updatedAt: string;
  runs: number;
  messageCount: number;
  running: boolean;
  runsElsewhere?: RunsElsewhere;
  pendingPermissions: PendingPermission[];
}
interface Line { seq: number; at: string; from: "sdk" | "host"; message: Record<string, unknown> }
interface Overview {
  claude: { path: string; realPath: string } | null;
  login: { ok: boolean; authMethod?: string; apiProvider?: string; plan?: string; loggedIn?: boolean; error?: string };
  cap: number;
  running: number;
  registry: string;
  agents: Agent[];
}

const root = document.getElementById("agent-host")!;
const agents = new Map<string, Agent>();
let selected: string | null = location.hash.slice(1) || null;
let transcript: Line[] = [];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const k of kids) e.append(typeof k === "string" ? document.createTextNode(k) : k);
  return e;
}

/** A refused request: its status and the whole JSON body (e.g. `resumable` on a 409). */
class ApiError extends Error {
  constructor(readonly status: number, readonly body: Record<string, unknown>) {
    super(typeof body.error === "string" ? body.error : `request failed (${status})`);
  }
}

/** Every request this page makes goes through here, so the write token (#76) is one line. */
async function call(method: string, path: string, body?: unknown): Promise<unknown> {
  const url = `/api/agents${path === "/" ? "" : path}`;
  // Every write goes through the one write helper (token + reason on refusal), then the
  // action list is re-read so the write shows up there, refused or not.
  if (method !== "GET") return write(method as WriteMethod, url, body).finally(() => void renderActions());
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new ApiError(res.status, j && typeof j === "object" ? j : {});
  return j;
}

const STATUS_COLOR: Record<string, string> = {
  starting: "var(--cyan)", working: "var(--accent)", waiting: "var(--yellow)",
  done: "var(--green)", failed: "var(--red)", stopped: "var(--text-2)",
};

const css = el("style", {}, `
  #agent-host { padding: 16px 24px; font-family: var(--font-mono); font-size: var(--font-size); color: var(--text-0); }
  #agent-host h1 { font-size: 16px; margin: 0 0 4px; }
  #agent-host .note { color: var(--text-2); margin-bottom: 12px; }
  #agent-host .box { border: 1px solid var(--border); border-radius: var(--radius); padding: 10px 12px; margin-bottom: 12px; background: var(--bg-1); }
  #agent-host input, #agent-host textarea { background: var(--bg-2); color: var(--text-0); border: 1px solid var(--border); border-radius: 4px; font: inherit; padding: 4px 6px; }
  #agent-host button { background: var(--bg-3); color: var(--text-0); border: 1px solid var(--border-active); border-radius: 4px; font: inherit; padding: 3px 10px; cursor: pointer; }
  #agent-host table { border-collapse: collapse; width: 100%; }
  #agent-host td, #agent-host th { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
  #agent-host tr.sel { background: var(--bg-2); }
  #agent-host .status { font-weight: bold; }
  #agent-host .err { color: var(--red); }
  #agent-host .ok { color: var(--green); }
  #agent-host .tx { max-height: 60vh; overflow: auto; white-space: pre-wrap; word-break: break-word; }
  #agent-host .tx div { border-bottom: 1px dotted var(--border); padding: 2px 0; }
  #agent-host .k { color: var(--text-2); }
  #agent-host .compose { margin: 8px 0; padding: 8px 0; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
  #agent-host .compose > div { margin-bottom: 6px; }
  #agent-host .msgs div { padding: 2px 0; }
  #agent-host .st-queued { color: var(--yellow); }
  #agent-host .st-delivered { color: var(--green); }
  #agent-host .st-not-delivered { color: var(--red); }
`);

const loginBox = el("div", { class: "box", id: "login" });
const msg = el("div", { id: "msg" });
const listBox = el("div", { class: "box", id: "agents" });
const detailBox = el("div", { class: "box", id: "detail" });
const actionsBox = el("div", { class: "box", id: "actions" });

const cwdIn = el("input", { id: "cwd", size: "60", placeholder: "/absolute/folder" });
const promptIn = el("textarea", { id: "prompt", rows: "2", cols: "60", placeholder: "prompt" });
const issueIn = el("input", { id: "issue", size: "6", placeholder: "issue #" });
const startBtn = el("button", { id: "start" }, "Start agent");
startBtn.onclick = async () => {
  msg.textContent = "";
  try {
    const a = (await call("POST", "/", { cwd: cwdIn.value, prompt: promptIn.value, issue: issueIn.value || undefined })) as Agent;
    agents.set(a.id, a);
    select(a.id);
  } catch (e) {
    msg.className = "err";
    msg.textContent = (e as Error).message;
  }
};

// Start an agent from an issue (#78): its own worktree and branch, with .anvi and ref linked.
const fiProject = el("input", { id: "fi-project", size: "18", placeholder: "project" });
const fiIssue = el("input", { id: "fi-issue", size: "6", placeholder: "issue #" });
const fiNote = el("input", { id: "fi-note", size: "50", placeholder: "optional note for this run" });
const fiBtn = el("button", { id: "fi-start" }, "Start agent on issue");
const fiMsg = el("div", { id: "fi-msg" });
fiBtn.onclick = async () => {
  fiMsg.className = "k";
  fiMsg.textContent = "making the worktree…";
  try {
    const r = (await call("POST", "/from-issue", { project: fiProject.value, issue: fiIssue.value, note: fiNote.value || undefined })) as {
      agent: Agent; worktree: string; branch: string;
      links: { kind: string; state: string; resolves: boolean; resolvesTo?: string; note: string }[];
      board: { state: string; board?: string; reason?: string };
    };
    fiMsg.className = "ok";
    fiMsg.replaceChildren(
      el("div", {}, `started ${r.agent.id} in ${r.worktree} on ${r.branch}`),
      ...r.links.map((l) => el("div", { "data-kind": l.kind, "data-resolves": String(l.resolves), class: l.resolves ? "ok" : "err" },
        `${l.kind}: ${l.state}, ${l.resolves ? `resolves to ${l.resolvesTo}` : "does not resolve"} (${l.note})`)),
      el("div", { class: "k" }, `board: ${r.board.state}${r.board.board ? ` ${r.board.board}` : ""}${r.board.reason ? ` (${r.board.reason})` : ""}`),
    );
    agents.set(r.agent.id, r.agent);
    void select(r.agent.id);
  } catch (e) {
    fiMsg.className = "err";
    fiMsg.textContent = (e as Error).message;
  }
};

root.append(
  css,
  el("h1", {}, "Agent host"),
  el("div", { class: "note" }, "Temporary page (#75). The Agents screen (#82) replaces it."),
  loginBox,
  el("div", { class: "box" }, el("div", {}, "Folder ", cwdIn, "  Issue ", issueIn), el("div", {}, promptIn), startBtn, " ", msg),
  el("div", { class: "box", id: "from-issue" }, el("div", {}, el("b", {}, "From an issue"), el("span", { class: "k" }, "  its own worktree and branch, .anvi and ref linked (#78)")),
    el("div", {}, "Project ", fiProject, "  Issue ", fiIssue, "  ", fiNote, " ", fiBtn), fiMsg),
  listBox,
  detailBox,
  actionsBox,
);

/** The last few writes from the action log (#76), refused ones included. History (#90) replaces this. */
async function renderActions(): Promise<void> {
  try {
    const r = await fetch("/api/actions?limit=8");
    const j = (await r.json()) as {
      error?: string; file: string; total: number; unreadableLines: number; writeFailures: { count: number; last?: string };
      actions: { at: string; method: string; path: string; target?: string; status: number; result: string; reason?: string }[];
    };
    if (!r.ok) throw new Error(j.error ?? `${r.status}`);
    const table = el("table", {}, el("tr", {}, ...["time", "result", "status", "action", "target", "reason"].map((h) => el("th", {}, h))));
    for (const a of j.actions) {
      table.append(el("tr", { "data-result": a.result },
        el("td", {}, a.at.slice(11, 19)),
        el("td", { class: a.result === "accepted" ? "ok" : "err" }, a.result),
        el("td", {}, String(a.status)),
        el("td", {}, `${a.method} ${a.path}`),
        el("td", {}, a.target ?? ""),
        el("td", {}, a.reason ?? "")));
    }
    actionsBox.replaceChildren(
      el("div", {}, el("b", {}, "Recent actions"), el("span", { class: "k" },
        `  ${j.actions.length} newest of ${j.total} in ${j.file}${j.unreadableLines ? ` · ${j.unreadableLines} unreadable lines` : ""}`),
        j.writeFailures.count ? el("span", { class: "err" }, `  · ${j.writeFailures.count} actions could not be logged (${j.writeFailures.last ?? ""})`) : ""),
      j.actions.length ? table : el("div", { class: "k" }, "No actions yet."),
    );
  } catch (e) {
    actionsBox.replaceChildren(el("div", { class: "err" }, `could not read the action log: ${(e as Error).message}`));
  }
}

function renderLogin(o: Overview): void {
  loginBox.replaceChildren(
    el("div", {}, el("span", { class: "k" }, "Claude Code: "),
      o.claude ? `${o.claude.path} → ${o.claude.realPath}` : el("span", { class: "err" }, "not on PATH")),
    el("div", {}, el("span", { class: "k" }, "Login: "),
      o.login.error
        ? el("span", { class: "err" }, `could not read (${o.login.error})`)
        : el("span", { class: o.login.ok ? "ok" : "err", id: "login-method" },
          `${o.login.authMethod ?? "?"} · plan ${o.login.plan ?? "?"} · provider ${o.login.apiProvider ?? "?"}${o.login.loggedIn ? "" : " · NOT logged in"}`)),
    el("div", {}, el("span", { class: "k" }, "Running: "), el("span", { id: "running-count" }, String(o.running)), ` of at most ${o.cap}`,
      el("span", { class: "k" }, "   registry: "), o.registry),
  );
}

function renderList(): void {
  // Kept current from the agents themselves, not only from the last full read.
  const count = document.getElementById("running-count");
  if (count) count.textContent = String([...agents.values()].filter((a) => a.running).length);
  const rows = [...agents.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  keepCardsOf(rows);
  const table = el("table", {},
    el("tr", {}, ...["agent", "status", "apiKeySource", "folder", "prompt", "runs", "why", ""].map((h) => el("th", {}, h))));
  for (const a of rows) {
    const live = a.running;
    const actions = el("td", {});
    if (a.runsElsewhere) {
      actions.append(el("span", { class: "k", "data-elsewhere": String(a.runsElsewhere.port ?? "") }, `${elsewhereText(a.runsElsewhere)}; act on it there`));
    } else if (live) {
      const b = el("button", { "data-act": "stop" }, "Stop");
      b.onclick = (ev) => { ev.stopPropagation(); void act(() => call("POST", `/${a.id}/stop`)); };
      actions.append(b);
    } else if (a.sessionId) {
      const inp = el("input", { size: "18", placeholder: "resume prompt", "data-act": "resume-prompt" });
      inp.onclick = (ev) => ev.stopPropagation();
      const b = el("button", { "data-act": "resume" }, "Resume");
      b.onclick = (ev) => { ev.stopPropagation(); void act(() => call("POST", `/${a.id}/resume`, { prompt: inp.value })); };
      actions.append(inp, " ", b);
    }
    const tr = el("tr", { "data-id": a.id, class: a.id === selected ? "sel" : "" },
      el("td", {}, a.id),
      el("td", {}, el("span", { class: "status", style: `color:${STATUS_COLOR[a.status] ?? "inherit"}` },
        a.status === "waiting" ? `waiting on you (${a.pendingPermissions.map((p) => p.toolName).join(", ")})` : a.status),
        // Its parked permission requests (#77), each with Allow and Deny.
        ...agentRequests(a)),
      el("td", { class: a.apiKeySource === undefined ? "k" : a.apiKeySource === "none" ? "ok" : "err" }, a.apiKeySource ?? "not reported yet"),
      el("td", {}, a.cwd),
      el("td", {}, a.prompt.slice(0, 60)),
      el("td", {}, String(a.runs)),
      el("td", {}, a.reason ?? ""),
      actions,
    );
    tr.onclick = () => select(a.id);
    table.append(tr);
  }
  listBox.replaceChildren(rows.length ? table : el("div", { class: "k" }, "No agents yet."));
}

function summarize(m: Record<string, unknown>): string {
  const t = String(m.type ?? m.event ?? "?");
  if (m.event === "message-sent") return `you → agent: ${m.text}`;
  if (m.event === "message-delivered") return `message ${m.messageId} delivered (seen on ${m.by})`;
  if (m.event === "message-not-delivered") return `message ${m.messageId} NOT delivered: ${m.reason}`;
  if (m.event) return JSON.stringify(m);
  if (t === "command_lifecycle") return `Claude Code: message ${m.command_uuid} ${m.state}`;
  if (t === "system") {
    const sub = String(m.subtype);
    if (sub === "init") return `init · apiKeySource=${m.apiKeySource} · claude ${m.claude_code_version} · model ${m.model} · session ${m.session_id}`;
    if (sub === "hook_started" || sub === "hook_response") return `${sub} · ${m.hook_name ?? ""} ${m.hook_event ?? ""}`;
    return sub;
  }
  if (t === "assistant" || t === "user") {
    const content = (m.message as { content?: unknown })?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content.map((b: Record<string, unknown>) =>
        b.type === "text" ? String(b.text)
          : b.type === "tool_use" ? `[tool ${b.name}] ${JSON.stringify(b.input).slice(0, 200)}`
          : b.type === "tool_result" ? `[result] ${JSON.stringify(b.content).slice(0, 200)}`
          : `[${b.type}]`).join("\n");
    }
  }
  if (t === "result") return `${m.subtype} · ${m.num_turns} turns · Claude Code usage estimate $${Number(m.total_cost_usd).toFixed(2)} (not a bill) · ${String(m.result ?? "").slice(0, 300)}`;
  return JSON.stringify(m).slice(0, 300);
}

function lineEl(l: Line): HTMLElement {
  const m = l.message ?? {};
  const kind = l.from === "host" ? `anvideck` : `${m.type ?? "?"}${m.subtype ? `/${m.subtype}` : ""}`;
  return el("div", { "data-seq": String(l.seq) }, el("span", { class: "k" }, `#${l.seq} ${l.at.slice(11, 19)} ${kind}  `), summarize(m));
}

// --- Talking to the selected agent (#79) -------------------------------------------------------
// The compose box is built once and never re-rendered, so what you are typing survives the
// agent's updates. A refused message (409) offers to resume the agent with the same words.
const msgIn = el("textarea", { id: "message", rows: "2", cols: "60", placeholder: "message to the agent (arrives on its next turn)" });
const msgBtn = el("button", { id: "send-message" }, "Send");
const cFile = el("input", { id: "comment-file", size: "28", placeholder: "file" });
const cLine = el("input", { id: "comment-line", size: "5", placeholder: "line" });
const cLineText = el("input", { id: "comment-linetext", size: "40", placeholder: "the line's text" });
const cText = el("input", { id: "comment-text", size: "50", placeholder: "your comment" });
const cBtn = el("button", { id: "send-comment" }, "Send comment");
const composeMsg = el("div", { id: "compose-msg" });
const compose = el("div", { class: "compose", id: "compose" },
  el("div", {}, msgIn, " ", msgBtn),
  el("div", {}, el("span", { class: "k" }, "Line comment: "), cFile, " ", cLine, " ", cLineText, " ", cText, " ", cBtn),
  composeMsg);

async function sendToAgent(body: Record<string, unknown>, sent: () => void): Promise<void> {
  const id = selected;
  if (!id) return;
  composeMsg.replaceChildren();
  try {
    await call("POST", `/${id}/message`, body);
    sent();
    composeMsg.className = "ok";
    composeMsg.textContent = "Queued. It arrives on the agent's next turn; delivery shows below.";
  } catch (e) {
    composeMsg.className = "err";
    composeMsg.append((e as Error).message);
    const err = e as ApiError;
    if (err.status === 409 && err.body?.resumable === true) {
      // Resume with exactly what the agent would have read (a comment keeps its file and line).
      const req = parseMessageRequest(body);
      const prompt = "error" in req ? "" : renderForAgent(req);
      const b = el("button", { id: "resume-with-message" }, "Resume with this message");
      b.onclick = () => void act(async () => {
        const a = await call("POST", `/${id}/resume`, { prompt });
        sent();
        composeMsg.className = "ok";
        composeMsg.textContent = "Resumed with your message.";
        return a;
      });
      composeMsg.append(" ", b);
    }
  }
}
msgBtn.onclick = () => void sendToAgent({ text: msgIn.value }, () => { msgIn.value = ""; });
cBtn.onclick = () => void sendToAgent(
  { comment: { file: cFile.value, line: Number(cLine.value), lineText: cLineText.value, text: cText.value } },
  () => { cText.value = ""; },
);

const STATE_WORDS: Record<string, string> = { queued: "queued", delivered: "delivered", "not-delivered": "not delivered" };
const detailHead = el("div", {});
const msgsBox = el("div", { class: "msgs", id: "messages" });
let txBox: HTMLElement | null = null;

function renderMessages(): void {
  const sent = messagesIn(transcript);
  msgsBox.replaceChildren(...(sent.length ? [el("div", { class: "k" }, "Messages you sent:")] : []), ...sent.map((s) =>
    el("div", { "data-message": s.messageId, "data-state": s.state },
      el("span", { class: `st-${s.state}` }, `[${STATE_WORDS[s.state]}${s.reason ? `: ${s.reason}` : ""}] `),
      s.comment ? el("span", { class: "k" }, `${s.comment.file}:${s.comment.line} `) : "",
      s.said)));
}

function renderDetail(): void {
  const a = selected ? agents.get(selected) : undefined;
  if (!a) { detailBox.replaceChildren(el("div", { class: "k" }, "Select an agent to see its messages.")); txBox = null; return; }
  detailHead.replaceChildren(
    el("div", {}, el("b", {}, a.id), `  ${a.status}`, el("span", { class: "k" }, "  session "), a.sessionId ?? "—",
      el("span", { class: "k" }, "  apiKeySource "), el("span", { id: "detail-apikeysource", class: a.apiKeySource === "none" ? "ok" : "err" }, a.apiKeySource ?? "not reported yet")),
    el("div", { class: "k" }, `claude ${a.claudePath ?? "?"} → ${a.claudeRealPath ?? "?"} · v${a.claudeCodeVersion ?? "?"} · removed from env: ${a.strippedEnv?.length ? a.strippedEnv.join(", ") : "nothing"}${a.costEstimateUsd !== undefined ? ` · Claude Code usage estimate $${a.costEstimateUsd.toFixed(2)} (not a bill)` : ""}`),
  );
  renderMessages();
  txBox = el("div", { class: "tx", id: "transcript" }, ...transcript.map(lineEl));
  // The compose box is moved, never rebuilt: only the parts around it are replaced.
  if (compose.parentElement !== detailBox) detailBox.replaceChildren(detailHead, compose, msgsBox, txBox);
  else detailBox.replaceChild(txBox, detailBox.lastElementChild!);
  txBox.scrollTop = txBox.scrollHeight;
}

async function select(id: string): Promise<void> {
  selected = id;
  history.replaceState(null, "", `#${id}`);
  const r = (await call("GET", `/${id}`)) as { agent: Agent; transcript: Line[] };
  agents.set(id, r.agent);
  transcript = r.transcript;
  renderList();
  renderDetail();
}

async function act(fn: () => Promise<unknown>): Promise<void> {
  msg.textContent = "";
  try {
    const a = (await fn()) as Agent;
    agents.set(a.id, a);
    renderList();
    if (a.id === selected) renderDetail();
  } catch (e) {
    msg.className = "err";
    msg.textContent = (e as Error).message;
  }
}

async function refresh(): Promise<void> {
  void renderActions();
  const o = (await call("GET", "/")) as Overview;
  renderLogin(o);
  agents.clear();
  for (const a of o.agents) agents.set(a.id, a);
  renderList();
  if (selected && agents.has(selected)) await select(selected);
  else renderDetail();
}

function connect(): void {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`);
  ws.onmessage = (evt) => {
    let m: { type: string; data: unknown };
    try { m = JSON.parse(evt.data); } catch { return; }
    if (m.type === "agent") {
      const a = m.data as Agent;
      agents.set(a.id, a);
      renderList();
      if (a.id === selected) renderDetail();
    } else if (m.type === "agent-message") {
      const { id, line } = m.data as { id: string; line: Line };
      if (id !== selected || transcript.some((l) => l.seq === line.seq)) return;
      transcript.push(line);
      if (txBox) { txBox.append(lineEl(line)); txBox.scrollTop = txBox.scrollHeight; }
      if (line.from === "host" && String(line.message?.event ?? "").startsWith("message-")) renderMessages();
    }
  };
  // After a reconnect (e.g. server restart) re-read everything: messages may have been missed.
  ws.onopen = () => refresh().catch((e) => { msg.className = "err"; msg.textContent = `could not read agents: ${(e as Error).message}`; });
  ws.onclose = () => setTimeout(connect, 2000);
}

onAnswerSent(() => void renderActions());
connect();
