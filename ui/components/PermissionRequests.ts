/**
 * Permission requests (#77): an agent asks to use a tool the owner's own rules did not cover,
 * and waits. Shown on Home (PermissionQueue) and on the agent's row of /agent-host
 * (requestCard), with Allow and Deny (Deny takes an optional message the agent reads).
 *
 * Each card is built once per request and kept until the request leaves the host, so a deny
 * message being typed survives every re-render of the page around it. Answers go through
 * write() (ui/write.ts), so each one carries the token and lands in the action log.
 * All text from agents is set with textContent, never as HTML.
 */
import { write, WriteError } from "../write";
import type { AgentsRead } from "../shell/activity";
import { askerOf, askSummary, permissionQueue, subagentDetail, type AskingAgent, type PendingPermission, requestInputText } from "../../shared/permission-requests";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
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
  cards.set(p.requestId, card);
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
  .perm-actions input { background: var(--bg-1); color: var(--text-0); border: 1px solid var(--border); border-radius: 4px; font: inherit; padding: 2px 6px; }
`;

const style = document.createElement("style");
style.dataset.for = "permission-requests";
style.textContent = PERMISSION_CSS;
document.head.append(style);
