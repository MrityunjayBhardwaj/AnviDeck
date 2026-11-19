/**
 * Permission requests (#77): an agent asks to use a tool the owner's own rules did not cover,
 * and waits. Shown on Home (PermissionQueue) and on the agent's row of /agent-host
 * (requestCard), with Allow and Deny (Deny takes an optional message the agent reads). The agent's
 * multiple-choice question gets its questions and options to answer instead (#302), and its finished
 * plan gets Approve and continue in a mode, Keep planning with feedback, or Stop (#303).
 *
 * Each card is built once per request and kept until the request leaves the host, so a deny
 * message being typed survives every re-render of the page around it. Answers go through
 * write() (ui/write.ts), so each one carries the token and lands in the action log.
 * All text from agents is set with textContent, never as HTML.
 */
import { write, WriteError } from "../write";
import type { AgentsRead } from "../shell/activity";
import { askerOf, askSummary, permissionQueue, PLAN_TOOL, QUESTION_TOOL, readPlan, readQuestions, subagentDetail, type AgentQuestion, type AskingAgent, type PendingPermission, requestInputText } from "../../shared/permission-requests";
import { modesOnOffer } from "../shell/mode-picker";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** An element of class `cls` holding `kids`. */
function box2(tag: "div" | "label", cls: string, ...kids: (Node | string)[]): HTMLElement {
  const e = el(tag, cls);
  e.append(...kids);
  return e;
}

const cards = new Map<string, HTMLElement>();
let afterAnswer: () => void = () => {};
/** Called after every answer is sent, accepted or refused (the agent-host page re-reads its action list). */
export function onAnswerSent(fn: () => void): void {
  afterAnswer = fn;
}

/** Drop the cards of requests no longer parked anywhere (answered or withdrawn). */
function prune(live: Set<string>): void {
  for (const id of [...cards.keys()]) if (!live.has(id)) cards.delete(id);
}

/** Keep only the cards of requests these agents still have parked. */
export function keepCardsOf(agents: AskingAgent[]): void {
  prune(new Set(permissionQueue(agents).requests.map((r) => r.request.requestId)));
}

/** The card for one parked request, reused across renders. */
export function requestCard(agent: AskingAgent, p: PendingPermission): HTMLElement {
  const had = cards.get(p.requestId);
  if (had) return refreshAsker(had, p);
  const card = el("div", "perm-card");
  card.dataset.request = p.requestId;
  card.dataset.agent = agent.id;
  // A click inside a card is an answer, not a click on whatever row holds it.
  card.addEventListener("click", (ev) => ev.stopPropagation());

  const what = el("div", "perm-what");
  const asker = el("span", "perm-asker", askerOf(p));
  what.append(asker, " asks to ", el("b", "", askSummary(p.toolName, p.input)));
  const meta = el("div", "perm-meta",
    `${p.toolName} · agent ${agent.id}${agent.issue ? ` · #${agent.issue}` : ""} · ${agent.cwd} · asked ${new Date(p.askedAt).toLocaleTimeString()}`);
  // A subagent's ask (#267): named on its parent's card. The card is built once per request, so the
  // name is refreshed in place when it arrives after the request (see refreshAsker).
  const sub = el("div", "perm-meta perm-sub", subagentDetail(p));
  sub.hidden = !p.subagent;
  // The full input, never cut: Allow runs exactly this. Long inputs scroll, and say how long they are.
  const shown = requestInputText(p.input);
  const input = el("pre", "perm-input", shown.text);
  input.title = `${shown.chars} characters; scroll to read all of it`;
  card.append(what, meta, sub);
  if (p.decisionReason) card.append(el("div", "perm-meta", `Why it asks: ${p.decisionReason}`));
  // The agent's question (#302) and its finished plan (#303) are answered in their own way.
  const questions = p.toolName === QUESTION_TOOL ? readQuestions(p.input) : null;
  if (questions) return keep(p, questionForm(card, agent, p, questions));
  if (p.toolName === PLAN_TOOL) return keep(p, planForm(card, agent, p, input));
  card.append(input);
  if (shown.chars > 600) card.append(el("div", "perm-meta", `Input is ${shown.chars} characters: scroll the box to read all of it before you answer.`));

  const allow = el("button", "perm-allow", "Allow");
  allow.dataset.act = "allow";
  const msg = el("input", "perm-msg");
  msg.placeholder = "optional message the agent reads";
  msg.dataset.act = "deny-message";
  msg.size = 40;
  const deny = el("button", "perm-deny", "Deny");
  deny.dataset.act = "deny";
  const status = el("span", "perm-status");
  const row = el("div", "perm-actions");
  row.append(allow, " ", deny, " ", msg, " ", status);
  card.append(row);

  const send = async (body: { decision: "allow" } | { decision: "deny"; message: string }) => {
    allow.disabled = deny.disabled = msg.disabled = true;
    status.className = "perm-status";
    status.textContent = "sending…";
    try {
      await write("POST", `/api/agents/${encodeURIComponent(agent.id)}/permissions/${encodeURIComponent(p.requestId)}`, body);
      card.dataset.answered = body.decision;
      status.className = "perm-status ok";
      status.textContent = body.decision === "allow" ? "Allowed. The call runs." : "Denied. The agent reads your message.";
    } catch (e) {
      status.className = "perm-status err";
      status.textContent = (e as Error).message;
      // A request no longer waiting (409) cannot be answered again; anything else may be retried.
      if (!(e instanceof WriteError && e.status === 409)) allow.disabled = deny.disabled = msg.disabled = false;
    }
    afterAnswer();
  };
  allow.onclick = () => void send({ decision: "allow" });
  deny.onclick = () => void send({ decision: "deny", message: msg.value });
  return keep(p, card);
}

function keep(p: PendingPermission, card: HTMLElement): HTMLElement {
  cards.set(p.requestId, card);
  return card;
}

type Answer =
  | { decision: "deny"; message: string }
  | { decision: "answer"; answers: Record<string, string> }
  | { decision: "approve-plan"; mode: string };

/** Send one answer from a card; every control in it is disabled while it goes, and after a 409. */
async function sendAnswer(card: HTMLElement, agent: AskingAgent, p: PendingPermission, body: Answer, done: string): Promise<void> {
  const controls = [...card.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>("button, input, select, textarea")];
  const status = card.querySelector<HTMLElement>(".perm-status")!;
  for (const c of controls) c.disabled = true;
  status.className = "perm-status";
  status.textContent = "sending…";
  try {
    await write("POST", `/api/agents/${encodeURIComponent(agent.id)}/permissions/${encodeURIComponent(p.requestId)}`, body);
    card.dataset.answered = body.decision;
    status.className = "perm-status ok";
    status.textContent = done;
  } catch (e) {
    status.className = "perm-status err";
    status.textContent = (e as Error).message;
    if (!(e instanceof WriteError && e.status === 409)) for (const c of controls) c.disabled = false;
  }
  afterAnswer();
}

/**
 * The agent's multiple-choice question (#302): each question with its options (a description, and
 * a preview when it has one), radio buttons or, for a multiple choice, boxes; and a box for your
 * own answer, used instead of the options when filled. Answer sends every question's answer.
 */
function questionForm(card: HTMLElement, agent: AskingAgent, p: PendingPermission, questions: AgentQuestion[]): HTMLElement {
  card.classList.add("perm-question");
  card.querySelector(".perm-what")!.replaceChildren(el("span", "perm-asker", askerOf(p)), ` asks ${questions.length === 1 ? "a question" : `${questions.length} questions`}`);
  const read: (() => string)[] = [];
  questions.forEach((q, qi) => {
    const box = el("fieldset", "perm-q");
    box.dataset.question = q.question;
    const legend = el("legend", "");
    if (q.header) legend.append(el("span", "perm-q-head", q.header), " ");
    legend.append(el("b", "", q.question), q.multiSelect ? el("span", "perm-meta", " (choose any)") : "");
    box.append(legend);
    const picks: HTMLInputElement[] = [];
    q.options.forEach((o, oi) => {
      const pick = el("input", "");
      pick.type = q.multiSelect ? "checkbox" : "radio";
      pick.name = `${p.requestId}-q${qi}`;
      pick.value = o.label;
      pick.id = `${p.requestId}-q${qi}-o${oi}`;
      picks.push(pick);
      const label = el("label", "perm-opt");
      label.htmlFor = pick.id;
      label.append(pick, " ", el("b", "", o.label));
      if (o.description) label.append(el("span", "perm-meta", ` ${o.description}`));
      box.append(label);
      if (o.preview) box.append(el("pre", "perm-input perm-preview", o.preview));
    });
    const own = el("input", "perm-own");
    own.placeholder = "or your own answer";
    own.size = 40;
    box.append(box2("label", "perm-opt", "Other: ", own));
    read.push(() => own.value.trim() || picks.filter((x) => x.checked).map((x) => x.value).join(", "));
    card.append(box);
  });
  const answer = el("button", "perm-allow", "Answer");
  answer.dataset.act = "answer";
  const msg = el("input", "perm-msg");
  msg.placeholder = "optional message the agent reads";
  msg.size = 30;
  const deny = el("button", "perm-deny", "Decline");
  deny.dataset.act = "deny";
  const status = el("span", "perm-status");
  card.append(box2("div", "perm-actions", answer, " ", deny, " ", msg, " ", status));
  answer.onclick = () => {
    const answers: Record<string, string> = {};
    questions.forEach((q, i) => (answers[q.question] = read[i]!()));
    const missing = questions.filter((q) => !answers[q.question]);
    if (missing.length) {
      status.className = "perm-status err";
      status.textContent = `Answer every question first: ${missing.map((q) => q.header ?? q.question).join(", ")}.`;
      return;
    }
    void sendAnswer(card, agent, p, { decision: "answer", answers }, "Answered. The agent reads your answers.");
  };
  deny.onclick = () => void sendAnswer(card, agent, p, { decision: "deny", message: msg.value }, "Declined. The agent reads your message.");
  return card;
}

/**
 * The agent's finished plan (#303): the plan as it wrote it, then Approve and continue in a mode
 * (the modes this machine allows, never Full access), Keep planning with feedback, or Stop.
 */
function planForm(card: HTMLElement, agent: AskingAgent, p: PendingPermission, wholeInput: HTMLElement): HTMLElement {
  card.classList.add("perm-plan");
  card.querySelector(".perm-what")!.replaceChildren(el("span", "perm-asker", askerOf(p)), " has a plan and asks to go ahead");
  const plan = readPlan(p.input);
  if (plan) {
    const box = el("pre", "perm-input perm-plan-text", plan.plan);
    box.title = `${plan.plan.length} characters; scroll to read all of it`;
    card.append(box);
    if (plan.file) card.append(el("div", "perm-meta", `Saved by Claude Code to ${plan.file}`));
  } else {
    card.append(el("div", "perm-meta err", "The request carries no plan text; its whole input follows."), wholeInput);
  }
  const mode = el("select", "perm-mode");
  mode.setAttribute("aria-label", "Mode to continue in");
  mode.dataset.act = "plan-mode";
  mode.append(el("option", "", "reading the modes…"));
  mode.disabled = true;
  const approve = el("button", "perm-allow", "Approve and continue in");
  approve.dataset.act = "approve-plan";
  approve.disabled = true;
  const feedback = el("input", "perm-msg");
  feedback.placeholder = "what to change in the plan";
  feedback.size = 36;
  const keepPlanning = el("button", "perm-deny", "Keep planning");
  keepPlanning.dataset.act = "keep-planning";
  const stop = el("button", "perm-deny", "Stop");
  stop.dataset.act = "stop";
  const status = el("span", "perm-status");
  const note = el("div", "perm-meta");
  card.append(box2("div", "perm-actions", approve, " ", mode), box2("div", "perm-actions", keepPlanning, " ", feedback, " ", stop, " ", status), note);
  void modesOnOffer().then((r) => {
    if (!r.ok) {
      mode.replaceChildren(el("option", "", "modes not known"));
      note.className = "perm-meta err";
      note.textContent = `Could not read the modes this machine allows (${r.why}), so the plan cannot be approved here yet. Reload to try again.`;
      return;
    }
    mode.replaceChildren(...r.modes.filter((m) => m.mode !== "plan").map((m) => {
      const o = el("option", "", m.allowed ? m.label : `${m.label} (${m.why})`);
      o.value = m.mode;
      o.disabled = !m.allowed;
      return o;
    }));
    const pick = r.modes.find((m) => m.mode === "acceptEdits" && m.allowed) ?? r.modes.find((m) => m.mode === "default" && m.allowed);
    if (pick) mode.value = pick.mode;
    mode.disabled = approve.disabled = card.dataset.answered !== undefined;
    note.textContent = r.note;
  });
  approve.onclick = () => void sendAnswer(card, agent, p, { decision: "approve-plan", mode: mode.value }, `Approved. The agent goes on in ${mode.selectedOptions[0]?.textContent ?? mode.value}.`);
  keepPlanning.onclick = () => void sendAnswer(card, agent, p, { decision: "deny", message: feedback.value.trim() || "Keep planning: the plan is not approved yet." }, "Sent back. The agent keeps planning with your feedback.");
  stop.onclick = async () => {
    status.className = "perm-status";
    status.textContent = "stopping…";
    try {
      await write("POST", `/api/agents/${encodeURIComponent(agent.id)}/stop`);
      card.dataset.answered = "stop";
      status.className = "perm-status ok";
      status.textContent = "Stopped.";
    } catch (e) {
      status.className = "perm-status err";
      status.textContent = `Stop refused: ${(e as Error).message}`;
    }
    afterAnswer();
  };
  return card;
}

/**
 * A subagent's name can arrive after its request (#267): the kept card takes the current one.
 * Only these two text nodes change, so a deny message being typed is left alone.
 */
function refreshAsker(card: HTMLElement, p: PendingPermission): HTMLElement {
  const asker = card.querySelector<HTMLElement>(".perm-asker");
  const sub = card.querySelector<HTMLElement>(".perm-sub");
  if (asker && asker.textContent !== askerOf(p)) asker.textContent = askerOf(p);
  if (sub) {
    const d = subagentDetail(p);
    if (sub.textContent !== d) sub.textContent = d;
    sub.hidden = !p.subagent;
  }
  return card;
}

/** The cards for one agent's parked requests (the agent's row on /agent-host). */
export function agentRequests(agent: AskingAgent): HTMLElement[] {
  const { requests } = permissionQueue([agent]);
  return requests.map((r) => requestCard(r.agent, r.request));
}

// ── Home's section ────────────────────────────────────────────────────────────────────────────
// One element for the page's lifetime: Home rebuilds itself every minute and re-appends it, so
// the cards (and anything typed into them) are moved, never rebuilt. setPermissionAgents() is
// called on every agent update from the WebSocket, whichever screen is open.

const section = el("section", "home-perms");
section.id = "permission-queue";
let last: AgentsRead = { state: "loading" };

export function setPermissionAgents(read: AgentsRead): void {
  last = read;
  paint();
}

function paint(): void {
  // Only while the section is on a page: painting it detached would pull the shared cards out of
  // wherever they are shown now (Home's queue rows, #81). PermissionQueue() paints on mount.
  if (!section.isConnected) return;
  const head = el("div", "home-perms-head");
  if (last.state !== "ok") {
    // Could not look is never shown as "no requests".
    head.textContent =
      last.state === "loading" ? "Agent permission requests: checking…"
        : last.state === "off" ? `Agent permission requests: could not read, the agent host is off (${last.reason})`
          : `Agent permission requests: could not read (${last.reason})`;
    head.classList.add(last.state === "loading" ? "muted" : "err");
    section.replaceChildren(head);
    return;
  }
  const { requests, unreadable } = permissionQueue(last.agents as unknown as AskingAgent[]);
  prune(new Set(requests.map((r) => r.request.requestId)));
  const n = requests.length;
  head.textContent = n === 0
    ? "No agent is waiting for a permission answer."
    : `${n} permission ${n === 1 ? "request waits" : "requests wait"} for you · longest waiting first`;
  head.classList.add(n === 0 ? "muted" : "warn");
  head.dataset.count = String(n);
  const kids: HTMLElement[] = [head];
  if (unreadable) kids.push(el("div", "perm-meta err", `${unreadable} request${unreadable === 1 ? "" : "s"} could not be read`));
  kids.push(...requests.map((r) => requestCard(r.agent, r.request)));
  kids.push(el("div", "perm-meta", "Asked by agents AnviDeck started (GET /api/agents, live over the WebSocket). Your own permission rules settle the rest, as in the terminal; a request nobody answers keeps waiting."));
  section.replaceChildren(...kids);
}

/** Home's permission section: the same element every time. */
export function PermissionQueue(): HTMLElement {
  queueMicrotask(paint);
  return section;
}

/** Styles for the cards, shared by Home and /agent-host: added to the page once, on load. */
const PERMISSION_CSS = `
  .home-perms { border: 1px solid var(--border); border-radius: var(--radius); padding: 10px 12px; margin: 0 0 14px; background: var(--bg-1); }
  .home-perms-head { font-weight: bold; margin-bottom: 6px; }
  .home-perms-head.muted { color: var(--text-2); font-weight: normal; }
  .home-perms-head.warn { color: var(--yellow); }
  .home-perms-head.err, .perm-meta.err, .perm-status.err { color: var(--red); }
  .perm-status.ok { color: var(--green); }
  .perm-card { border-left: 3px solid var(--yellow); padding: 6px 10px; margin: 8px 0; background: var(--bg-2); }
  .perm-card[data-answered] { border-left-color: var(--text-2); opacity: .7; }
  .perm-what { color: var(--text-0); }
  .perm-meta { color: var(--text-2); font-size: 12px; }
  .perm-input { max-height: 140px; overflow: auto; margin: 4px 0; padding: 4px 6px; background: var(--bg-1); white-space: pre-wrap; word-break: break-word; font-size: 12px; }
  .perm-actions button { background: var(--bg-3); color: var(--text-0); border: 1px solid var(--border-active); border-radius: 4px; font: inherit; padding: 2px 10px; cursor: pointer; }
  .perm-actions .perm-allow { border-color: var(--green); }
  .perm-actions .perm-deny { border-color: var(--red); }
  .perm-q { border: 1px solid var(--border); border-radius: 4px; margin: 6px 0; padding: 4px 8px; }
  .perm-q-head { font-size: 11px; padding: 0 6px; border: 1px solid var(--border-active); border-radius: 8px; color: var(--text-1); }
  .perm-opt { display: block; margin: 2px 0; }
  .perm-preview { max-height: 100px; margin-left: 22px; }
  .perm-plan-text { max-height: 320px; }
  .perm-actions { margin-top: 4px; }
  .perm-actions select, .perm-q input.perm-own { background: var(--bg-1); color: var(--text-0); border: 1px solid var(--border); border-radius: 4px; font: inherit; padding: 2px 6px; }
  .perm-actions input { background: var(--bg-1); color: var(--text-0); border: 1px solid var(--border); border-radius: 4px; font: inherit; padding: 2px 6px; }
`;

const style = document.createElement("style");
style.dataset.for = "permission-requests";
style.textContent = PERMISSION_CSS;
document.head.append(style);
