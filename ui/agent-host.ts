/**
 * Temporary page for the agent host (#75): start, watch, stop and resume agents. Deliberately
 * plain; the Agents screen (#82) and the shell (#80) replace it. Served at /agent-host.
 * All text from agents is set with textContent, never as HTML.
 */

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
  pendingPermissions: { requestId: string; toolName: string }[];
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

async function call(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`/api/agents${path === "/" ? "" : path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((j as { error?: string }).error ?? `${res.status} ${res.statusText}`);
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
`);

const loginBox = el("div", { class: "box", id: "login" });
const msg = el("div", { id: "msg" });
const listBox = el("div", { class: "box", id: "agents" });
const detailBox = el("div", { class: "box", id: "detail" });

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

root.append(
  css,
  el("h1", {}, "Agent host"),
  el("div", { class: "note" }, "Temporary page (#75). The Agents screen (#82) replaces it."),
  loginBox,
  el("div", { class: "box" }, el("div", {}, "Folder ", cwdIn, "  Issue ", issueIn), el("div", {}, promptIn), startBtn, " ", msg),
  listBox,
  detailBox,
);

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
  const table = el("table", {},
    el("tr", {}, ...["agent", "status", "apiKeySource", "folder", "prompt", "runs", "why", ""].map((h) => el("th", {}, h))));
  for (const a of rows) {
    const live = a.running;
    const actions = el("td", {});
    if (live) {
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
        a.status === "waiting" ? `waiting on you (${a.pendingPermissions.map((p) => p.toolName).join(", ")})` : a.status)),
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
  if (m.event) return JSON.stringify(m);
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

let txBox: HTMLElement | null = null;
function renderDetail(): void {
  const a = selected ? agents.get(selected) : undefined;
  if (!a) { detailBox.replaceChildren(el("div", { class: "k" }, "Select an agent to see its messages.")); txBox = null; return; }
  txBox = el("div", { class: "tx", id: "transcript" }, ...transcript.map(lineEl));
  detailBox.replaceChildren(
    el("div", {}, el("b", {}, a.id), `  ${a.status}`, el("span", { class: "k" }, "  session "), a.sessionId ?? "—",
      el("span", { class: "k" }, "  apiKeySource "), el("span", { id: "detail-apikeysource", class: a.apiKeySource === "none" ? "ok" : "err" }, a.apiKeySource ?? "not reported yet")),
    el("div", { class: "k" }, `claude ${a.claudePath ?? "?"} → ${a.claudeRealPath ?? "?"} · v${a.claudeCodeVersion ?? "?"} · removed from env: ${a.strippedEnv?.length ? a.strippedEnv.join(", ") : "nothing"}${a.costEstimateUsd !== undefined ? ` · Claude Code usage estimate $${a.costEstimateUsd.toFixed(2)} (not a bill)` : ""}`),
    txBox,
  );
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
    }
  };
  // After a reconnect (e.g. server restart) re-read everything: messages may have been missed.
  ws.onopen = () => refresh().catch((e) => { msg.className = "err"; msg.textContent = `could not read agents: ${(e as Error).message}`; });
  ws.onclose = () => setTimeout(connect, 2000);
}

connect();
