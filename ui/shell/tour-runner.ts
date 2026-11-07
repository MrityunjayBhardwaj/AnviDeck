/**
 * The tour's engine (#91): opens a step's screen, looks for its element until the step's limit,
 * highlights it or says why it is skipped, and keeps the highlight on an element the screen
 * redraws. The page is reached only through `TourHost`, so tests drive it with a fake page.
 *
 * It navigates and highlights, nothing else: the host has no way to press, type or send.
 */
import { FLOWS, backPos, countText, decide, nextLabel, nextPos, squeeze, type Flow, type Outcome, type Step, type TourCtx, type TourPos } from "./tour-model";

/** An element as the tour sees it: its words, its attributes, whether it is still on the page. */
export interface TourEl {
  text(): string;
  attr(name: string): string | null;
  connected(): boolean;
}

export interface TourHost {
  /** Open a hash (the app routes it). */
  go(hash: string): void;
  currentHash(): string;
  find(sel: string): TourEl | null;
  /** Mark one element (null: none) and bring it into view unless `scroll` is false. Marking never changes what the element does. */
  highlight(el: TourEl | null, scroll?: boolean): void;
  /** Draw the card, or hide it (null). */
  paint(view: CardView | null): void;
  /** The project picked in the switcher. */
  project(): string | null;
  now(): number;
  /** Call `fn` every `ms` until the returned function is called. */
  every(ms: number, fn: () => void): () => void;
  /** Call `fn` whenever the page changes (a screen redrew), until the returned function is called. */
  watch(fn: () => void): () => void;
  /** After the last flow's Finish. */
  finished?(): void;
}

export interface CardView {
  flow: string;
  count: string;
  title: string;
  body: string;
  project: string | null;
  status: { kind: "looking" | "shown" | "skipped"; text: string };
  /** The highlighted element's own words, for steps whose point is its state. */
  quote: string | null;
  canBack: boolean;
  next: string;
}

/** How often the screen is looked at while a step waits, and the first look after opening it. */
export const LOOK_MS = 250;

export interface TourRunner {
  start(flow: number): void;
  next(): void;
  back(): void;
  end(): void;
  /** Where the tour is, or null when it is not running. */
  pos(): TourPos | null;
  /** The last outcome of the current step (for tests and the probe). */
  outcome(): Outcome | null;
}

export function createTourRunner(host: TourHost, flows: readonly Flow[] = FLOWS): TourRunner {
  let pos: TourPos | null = null;
  let ctx: TourCtx = { project: null, got: {}, now: new Date() };
  let stop: (() => void) | null = null;
  let last: Outcome | null = null;
  let shown: TourEl | null = null;

  const step = (): Step => flows[pos!.flow]!.steps[pos!.step]!;

  function view(status: CardView["status"], quote: string | null = null): CardView {
    const f = flows[pos!.flow]!;
    const s = step();
    return {
      flow: f.name,
      count: countText(pos!, flows),
      title: s.title,
      body: s.body,
      project: ctx.project,
      status,
      quote,
      canBack: backPos(pos!) !== null,
      next: nextLabel(pos!, flows),
    };
  }

  function halt() {
    stop?.();
    stop = null;
    shown = null;
    host.highlight(null);
  }

  function gapOf(s: Step): { text: string; transient: boolean } | null {
    for (const g of s.gaps ?? []) {
      const e = host.find(g.sel);
      if (e) return { text: g.say ?? (squeeze(e.attr("title") || e.text()) || "(no words)"), transient: !!g.transient };
    }
    return null;
  }

  function capture(s: Step, target: TourEl) {
    for (const [name, c] of Object.entries(s.capture ?? {})) {
      const from = c.sel ? host.find(c.sel) : target;
      const v = from?.attr(c.attr);
      if (v) ctx.got[name] = v;
    }
  }

  function open() {
    halt();
    const s = step();
    ctx.now = new Date(host.now());
    const missing = (s.requires ?? []).filter((k) => !ctx.got[k]);
    if (missing.length) {
      // Nothing to open: the step before did not find what this one follows.
      last = { kind: "skip", why: "no-data", text: s.none(ctx) };
      host.paint(view({ kind: "skipped", text: `skipped: ${last.text}` }));
      return;
    }
    const hash = s.to(ctx);
    // Opening the hash already shown would rebuild the screen and read it all again.
    if (host.currentHash() !== hash) host.go(hash);
    const t0 = host.now();
    let readyAt: number | null = null;
    host.paint(view({ kind: "looking", text: `Looking for ${s.what}…` }));
    const look = () => {
      const now = host.now();
      const target = host.find(s.target);
      const needs = !!target && (s.needs ? !!host.find(s.needs) : true);
      const ready = !!host.find(s.ready);
      if (ready && readyAt === null) readyAt = now;
      const gap = target && needs ? null : gapOf(s);
      const quote = s.noneQuote ? host.find(s.noneQuote) : null;
      const out = decide(s, { target: !!target, needs, ready, gap, elapsed: now - t0, sinceReady: readyAt === null ? null : now - readyAt }, ctx, quote ? squeeze(quote.text()) : null);
      last = out;
      if (out.kind === "wait") {
        host.paint(view({ kind: "looking", text: `Looking for ${s.what}… ${Math.round((now - t0) / 1000)} s` }));
        return;
      }
      stop?.();
      stop = null;
      if (out.kind === "skip") {
        host.paint(view({ kind: "skipped", text: `skipped: ${out.text}` }));
        return;
      }
      shown = target!;
      capture(s, shown);
      host.highlight(shown);
      host.paint(view({ kind: "shown", text: "Highlighted on the screen." }, s.quote ? squeeze(shown.text(), 400) : null));
      // A screen that redraws (a read came back) replaces the element: mark the new one as soon
      // as the page changes, so the highlight is not lost between two looks.
      stop = host.watch(() => {
        if (shown?.connected()) return;
        const again = host.find(s.target);
        if (again) {
          shown = again;
          host.highlight(again, false);
        }
      });
    };
    stop = host.every(LOOK_MS, look);
  }

  return {
    start(flow) {
      pos = { flow, step: 0 };
      ctx = { project: host.project(), got: {}, now: new Date(host.now()) };
      open();
    },
    next() {
      if (!pos) return;
      const n = nextPos(pos, flows);
      if (n === "done") {
        this.end();
        host.finished?.();
        return;
      }
      if (n.flow !== pos.flow) ctx = { project: host.project(), got: {}, now: new Date(host.now()) };
      pos = n;
      open();
    },
    back() {
      if (!pos) return;
      const b = backPos(pos);
      if (!b) return;
      pos = b;
      open();
    },
    end() {
      halt();
      pos = null;
      last = null;
      host.paint(null);
    },
    pos: () => pos,
    outcome: () => last,
  };
}
