/**
 * The tour card and the page side of the tour (#91): End / Back / Next, "step i of n", the flow's
 * name, and what happened to the step (highlighted, or skipped and why). The card lives outside
 * the main area, so it stays while the screens under it change.
 *
 * The page host below can open a hash, find an element, and add or remove one class. It has no
 * way to press, type or send anything (tests/help-tour.test.ts reads this file to keep it so).
 */
import { createTourRunner, type CardView, type TourEl, type TourHost, type TourRunner } from "./tour-runner";

const HL = "ht-hl";

function ensureStyles() {
  if (document.querySelector("link[data-help-css]")) return;
  const l = document.createElement("link");
  l.rel = "stylesheet";
  l.href = "/styles/help.css";
  l.dataset.helpCss = "";
  document.head.appendChild(l);
}

function wrapEl(e: Element): TourEl & { el: Element } {
  return {
    el: e,
    text: () => (e as HTMLElement).innerText ?? e.textContent ?? "",
    attr: (n) => e.getAttribute(n),
    connected: () => e.isConnected,
  };
}

export interface TourDeps {
  go: (hash: string) => void;
  project: () => string | null;
  /** After the last flow: back to the list of flows. */
  finished: () => void;
}

export function createTour(deps: TourDeps): TourRunner {
  ensureStyles();
  const card = document.createElement("div");
  card.className = "ht-card";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", "Flow walkthrough");
  card.hidden = true;
  const flowEl = document.createElement("span");
  flowEl.className = "ht-flow";
  const countEl = document.createElement("span");
  countEl.className = "ht-count";
  const titleEl = document.createElement("h2");
  const bodyEl = document.createElement("div");
  bodyEl.className = "ht-body";
  const statusEl = document.createElement("div");
  statusEl.className = "ht-status";
  statusEl.setAttribute("aria-live", "polite");
  const quoteEl = document.createElement("div");
  quoteEl.className = "ht-quote";
  const projEl = document.createElement("div");
  projEl.className = "ht-proj";
  const endBtn = document.createElement("button");
  endBtn.type = "button";
  endBtn.className = "sh-btn ht-end";
  endBtn.textContent = "End";
  const backBtn = document.createElement("button");
  backBtn.type = "button";
  backBtn.className = "sh-btn ht-back";
  backBtn.textContent = "Back";
  const nextBtn = document.createElement("button");
  nextBtn.type = "button";
  nextBtn.className = "sh-btn ht-next";
  const head = document.createElement("div");
  head.className = "ht-row ht-head";
  head.append(flowEl, countEl);
  const acts = document.createElement("div");
  acts.className = "ht-row ht-acts";
  acts.append(endBtn, backBtn, nextBtn);
  card.append(head, titleEl, bodyEl, statusEl, quoteEl, projEl, acts);
  document.body.appendChild(card);

  let marked: Element | null = null;

  const host: TourHost = {
    go: deps.go,
    currentHash: () => location.hash,
    find: (sel) => {
      try {
        const e = document.querySelector(sel);
        return e ? wrapEl(e) : null;
      } catch {
        return null; // a selector this browser cannot parse finds nothing; the step times out and says so
      }
    },
    highlight: (t, scroll = true) => {
      marked?.classList.remove(HL);
      marked = t ? (t as ReturnType<typeof wrapEl>).el : null;
      if (!marked) return;
      marked.classList.add(HL);
      if (!scroll) return;
      const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
      // A tall element (a whole diff) is brought in from its top, not its middle.
      const tall = marked.getBoundingClientRect().height > innerHeight * 0.7;
      marked.scrollIntoView({ block: tall ? "start" : "center", behavior: still ? "auto" : "smooth" });
    },
    paint: (v: CardView | null) => {
      card.hidden = !v;
      if (!v) return;
      flowEl.textContent = v.flow;
      countEl.textContent = v.count;
      titleEl.textContent = v.title;
      bodyEl.textContent = v.body;
      statusEl.className = `ht-status ${v.status.kind}`;
      statusEl.textContent = v.status.text;
      quoteEl.hidden = !v.quote;
      quoteEl.textContent = v.quote ? `On the screen: ${v.quote}` : "";
      projEl.textContent = v.project ? `on ${v.project}, the project picked above` : "no project picked: pick one above";
      backBtn.disabled = !v.canBack;
      nextBtn.textContent = v.next;
    },
    project: deps.project,
    now: () => Date.now(),
    every: (ms, fn) => {
      const t = setInterval(fn, ms);
      return () => clearInterval(t);
    },
    watch: (fn) => {
      const o = new MutationObserver(fn);
      o.observe(document.body, { childList: true, subtree: true });
      return () => o.disconnect();
    },
    finished: deps.finished,
  };

  const runner = createTourRunner(host);
  endBtn.addEventListener("click", () => runner.end());
  backBtn.addEventListener("click", () => runner.back());
  nextBtn.addEventListener("click", () => runner.next());
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && runner.pos()) runner.end();
  });
  return runner;
}
