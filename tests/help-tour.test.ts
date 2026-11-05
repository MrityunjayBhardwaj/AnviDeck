/**
 * Help's guided flows (#91): how a step is judged (shown, or skipped and why), how the tour moves,
 * that it only navigates and highlights, and that every element a step points at is marked on
 * its screen.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { FLOWS, decide, historyHashFor, nextLabel, nextPos, backPos, countText, type Look, type Step, type TourCtx } from "../ui/shell/tour-model";
import { createTourRunner, LOOK_MS, type CardView, type TourEl, type TourHost } from "../ui/shell/tour-runner";
import { paletteEntries } from "../ui/shell/palette-model";

const ctx: TourCtx = { project: "stave", got: {}, now: new Date("2026-11-05T12:00:00Z") };
const step: Step = {
  title: "t",
  body: "b",
  screen: "design",
  to: () => "#design",
  target: "#x",
  ready: "#ready",
  none: (c) => `no blocked edit in ${c.project} in the trial record`,
  what: "the trial record",
  limitMs: 10_000,
  graceMs: 1_000,
};
const look = (o: Partial<Look>): Look => ({ target: false, needs: false, ready: false, gap: null, elapsed: 0, sinceReady: null, ...o });

describe("deciding a step", () => {
  test("an element that is there, with its data, is shown", () => {
    expect(decide(step, look({ target: true, needs: true }), ctx)).toEqual({ kind: "show" });
  });

  test("an element without the data it stands for is never shown", () => {
    expect(decide(step, look({ target: true, needs: false }), ctx).kind).toBe("wait");
    expect(decide(step, look({ target: true, needs: false, elapsed: 10_000 }), ctx).kind).toBe("skip");
  });

  test("the four skips are told apart, each with its own words", () => {
    const gap = decide(step, look({ gap: { text: "The trial record could not be read: 500.", transient: false } }), ctx);
    expect(gap).toEqual({ kind: "skip", why: "gap", text: "the screen says: The trial record could not be read: 500." });

    const none = decide(step, look({ ready: true, sinceReady: 1_000, elapsed: 2_000 }), ctx, "3 chances to refuse in the last 30 days");
    expect(none).toEqual({ kind: "skip", why: "no-data", text: "no blocked edit in stave in the trial record (the screen: 3 chances to refuse in the last 30 days)" });

    const still = decide(step, look({ gap: { text: "measuring", transient: true }, elapsed: 10_000 }), ctx);
    expect(still).toEqual({ kind: "skip", why: "still-reading", text: "still reading after 10 s: measuring" });

    const timeout = decide(step, look({ elapsed: 10_000 }), ctx);
    expect(timeout).toEqual({ kind: "skip", why: "timeout", text: "the screen did not show the trial record within 10 s" });

    // No two outcomes share words: "could not show" never reads as "no data".
    const texts = [gap, none, still, timeout].map((o) => (o.kind === "skip" ? o.text : ""));
    expect(new Set(texts).size).toBe(4);
  });

  test("a screen still reading is waited for, not called empty", () => {
    expect(decide(step, look({ ready: true, sinceReady: 5_000, gap: { text: "measuring", transient: true }, elapsed: 5_000 }), ctx).kind).toBe("wait");
  });

  test("a screen that is ready and also states a reason: the reason wins over 'no data'", () => {
    // History's #hs-svg is ready while an unreadable lane cell is the gap; Work's
    // #wk-board-unreadable is both a ready marker and a gap.
    const gap = { text: "the Refusals & rulings lane could not be read", transient: false };
    expect(decide(step, look({ ready: true, sinceReady: 5_000, elapsed: 5_000, gap }), ctx)).toEqual({
      kind: "skip",
      why: "gap",
      text: "the screen says: the Refusals & rulings lane could not be read",
    });
    expect(decide(step, look({ target: true, needs: false, ready: true, sinceReady: 5_000, elapsed: 5_000, gap }), ctx).kind).toBe("skip");
    expect((decide(step, look({ target: true, needs: false, ready: true, sinceReady: 5_000, elapsed: 5_000, gap }), ctx) as { why: string }).why).toBe("gap");
  });

  test("ready but within the grace period: keep looking (rows arrive after the frame)", () => {
    expect(decide(step, look({ ready: true, sinceReady: 500, elapsed: 600 }), ctx).kind).toBe("wait");
  });

  test("History opens a window starting the day before the blocked edit", () => {
    expect(historyHashFor({ ...ctx, got: { at: "2026-10-13T12:03:45.088Z" } })).toBe("#history?from=2026-10-12");
    expect(historyHashFor(ctx)).toBe("#history");
  });
});

describe("moving through the flows", () => {
  test("six flows, the prototype's, each with steps", () => {
    expect(FLOWS.map((f) => f.name)).toEqual([
      "1 · Start a task",
      "2 · A blocked edit and your call",
      "3 · Review a change",
      "4 · Notes go out of date",
      "5 · Place new code",
      "6 · Fix a boundary",
    ]);
    for (const f of FLOWS) expect(f.steps.length).toBeGreaterThan(1);
  });

  test("Next walks the steps, then the next flow; Finish after the last; Back stays in the flow", () => {
    expect(countText({ flow: 0, step: 1 })).toBe(`step 2 of ${FLOWS[0]!.steps.length}`);
    expect(nextLabel({ flow: 0, step: 0 })).toBe("Next");
    expect(nextLabel({ flow: 0, step: FLOWS[0]!.steps.length - 1 })).toBe("Next flow");
    expect(nextLabel({ flow: 5, step: FLOWS[5]!.steps.length - 1 })).toBe("Finish");
    expect(nextPos({ flow: 0, step: FLOWS[0]!.steps.length - 1 })).toEqual({ flow: 1, step: 0 });
    expect(nextPos({ flow: 5, step: FLOWS[5]!.steps.length - 1 })).toBe("done");
    expect(backPos({ flow: 1, step: 0 })).toBeNull();
    expect(backPos({ flow: 1, step: 2 })).toEqual({ flow: 1, step: 1 });
  });
});

/** A fake page: selectors present, elements with attributes, a clock the test moves. */
function fakePage(present: (sel: string) => Record<string, string> | null) {
  let now = 0;
  const timers: { every: number; next: number; fn: () => void; on: boolean }[] = [];
  const gone = new Set<string>();
  const log = { go: [] as string[], highlighted: [] as (string | null)[], cards: [] as (CardView | null)[], finished: 0 };
  let hash = "#home";
  const elFor = (sel: string, attrs: Record<string, string>): TourEl & { sel: string } => ({
    sel,
    text: () => attrs.text ?? sel,
    attr: (n) => attrs[n] ?? null,
    connected: () => !gone.has(sel),
  });
  const host: TourHost = {
    go: (h) => {
      log.go.push(h);
      hash = h;
    },
    currentHash: () => hash,
    find: (sel) => {
      const a = present(sel);
      return a ? elFor(sel, a) : null;
    },
    highlight: (e) => log.highlighted.push(e ? (e as TourEl & { sel: string }).sel : null),
    paint: (v) => log.cards.push(v),
    project: () => "stave",
    now: () => now,
    every: (ms, fn) => {
      const t = { every: ms, next: now + ms, fn, on: true };
      timers.push(t);
      return () => (t.on = false);
    },
    watch: (fn) => host.every(100, fn),
    finished: () => log.finished++,
  };
  const advance = (ms: number) => {
    const end = now + ms;
    while (true) {
      const due = timers.filter((t) => t.on && t.next <= end).sort((a, b) => a.next - b.next)[0];
      if (!due) break;
      now = due.next;
      due.next += due.every;
      due.fn();
    }
    now = end;
  };
  return { host, log, advance, gone, card: () => log.cards[log.cards.length - 1] };
}

/** Every selector a step's own target and needs name (but none of its gaps). */
const shownSelectors = new Set(FLOWS.flatMap((f) => f.steps.flatMap((s) => [s.target, s.needs ?? s.target, s.ready])));

describe("the runner on a page", () => {
  test("all six flows play to the end: each step opens its screen and highlights its element", () => {
    const page = fakePage((sel) =>
      shownSelectors.has(sel) ? { "data-at": "2026-10-27T17:53:26.385Z", "data-session": "811b15d0-2d6e", href: "#work?pr=2399&project=stave" } : sel === ".chg-primary" ? { href: "#work?pr=2399&project=stave" } : null,
    );
    const r = createTourRunner(page.host);
    r.start(0);
    let steps = 0;
    while (r.pos()) {
      page.advance(LOOK_MS * 2);
      const s = FLOWS[r.pos()!.flow]!.steps[r.pos()!.step]!;
      expect({ step: s.title, outcome: r.outcome() }).toEqual({ step: s.title, outcome: { kind: "show" } });
      expect(page.log.highlighted[page.log.highlighted.length - 1]).toBe(s.target);
      expect(page.card()!.status.kind).toBe("shown");
      steps++;
      r.next();
    }
    expect(steps).toBe(FLOWS.reduce((n, f) => n + f.steps.length, 0));
    expect(page.log.finished).toBe(1);
    expect(page.card()).toBeNull();
    expect(page.log.highlighted[page.log.highlighted.length - 1]).toBeNull();
    // What an earlier step read sends a later one to the same thing: the refused call's session,
    // the day of the blocked edit on History, the PR's own row on Work.
    expect(page.log.go).toContain("#agents?project=stave&session=811b15d0-2d6e");
    expect(page.log.go).toContain("#history?from=2026-10-26");
    expect(page.log.go).toContain("#work?pr=2399&project=stave");
  });

  test("a page that never shows the element: the step is skipped at its limit and says so", () => {
    const page = fakePage(() => null);
    const r = createTourRunner(page.host);
    r.start(4);
    page.advance(29_000);
    expect(page.card()!.status.kind).toBe("looking");
    page.advance(2_000);
    expect(page.card()!.status).toEqual({ kind: "skipped", text: "skipped: the screen did not show the question box within 30 s" });
    expect(page.log.highlighted.every((h) => h === null)).toBe(true);
  });

  test("a screen that finished with no data: skipped with the reason, nothing highlighted", () => {
    const page = fakePage((sel) => (sel === "#wk-board-src, #wk-issues-src, #wk-no-board, #wk-several-boards, #wk-board-unreadable" ? {} : null));
    const r = createTourRunner(page.host);
    r.start(0);
    page.advance(LOOK_MS);
    expect(page.card()!.status.text).toBe("skipped: no issue on stave's board or among its open issues");
    expect(page.log.highlighted.every((h) => h === null)).toBe(true);
  });

  test("a screen that could not read: its own words, not 'no data'", () => {
    const page = fakePage((sel) => (sel === "#wk-board-error" ? { text: "Could not read the board: gh exited 1" } : null));
    const r = createTourRunner(page.host);
    r.start(0);
    page.advance(LOOK_MS);
    expect(page.card()!.status.text).toBe("skipped: the screen says: Could not read the board: gh exited 1");
  });

  test("a redrawn screen gets its highlight back on the new element", () => {
    const page = fakePage((sel) => (sel === '[data-tour="ask-placement"]' ? {} : null));
    const r = createTourRunner(page.host);
    r.start(4);
    page.advance(LOOK_MS);
    expect(page.log.highlighted.filter(Boolean).length).toBe(1);
    page.gone.add('[data-tour="ask-placement"]'); // the element the highlight was on is detached
    page.advance(600);
    expect(page.log.highlighted.filter(Boolean).length).toBeGreaterThan(1);
  });

  test("a step that follows an earlier step's find is skipped at once when that step found nothing", () => {
    const page = fakePage(() => null);
    const r = createTourRunner(page.host);
    r.start(1);
    r.next(); // "As the agent read it": no blocked edit was highlighted, so no session to open
    expect(r.outcome()).toEqual({ kind: "skip", why: "no-data", text: "no blocked edit was highlighted in the step before, so there is no session to open" });
    expect(page.log.go.some((h) => h.startsWith("#agents"))).toBe(false);
  });

  test("a step on the screen already open does not reopen it (no second read)", () => {
    const page = fakePage(() => null);
    const r = createTourRunner(page.host);
    r.start(2); // Changes, then Changes again
    r.next();
    r.next();
    expect(page.log.go).toEqual(["#changes?project=stave"]);
  });
});

/**
 * Play one step on a fake page where only `present` selectors are found (with their attributes),
 * and return the card's status after `ms`. Earlier steps of the flow are passed over with Next.
 */
function playStep(title: string, present: Record<string, Record<string, string>>, ms = LOOK_MS) {
  const page = fakePage((sel) => present[sel] ?? null);
  const r = createTourRunner(page.host);
  const flow = FLOWS.findIndex((f) => f.steps.some((s) => s.title === title));
  r.start(flow);
  while (FLOWS[flow]!.steps[r.pos()!.step]!.title !== title) r.next();
  page.advance(ms);
  return { status: page.card()!.status, outcome: r.outcome(), highlighted: page.log.highlighted.filter(Boolean) };
}
const stepNamed = (title: string) => FLOWS.flatMap((f) => f.steps).find((s) => s.title === title)!;

describe("a lane, list or board the screen could not read is never reported as no data", () => {
  const timeline = stepNamed("Recorded on the timeline");
  const lane = (state: string) => ({
    "#hs-svg": {},
    [`.hs-cell[data-row="refusals"][data-lane="${state}"]`]: {},
    "#hs-status": { text: "basher · 2026-10-23 – 2026-11-05 · 246 events" },
  });

  test("History: a Refusals lane with no source, or only partly read, is the screen's reason", () => {
    expect(timeline.ready).toBe("#hs-svg");
    const na = playStep("Recorded on the timeline", lane("not-available"));
    expect(na.status).toEqual({ kind: "skipped", text: "skipped: the screen says: the Refusals & rulings lane has no source for this project" });
    const partial = playStep("Recorded on the timeline", lane("partial"));
    expect(partial.status).toEqual({ kind: "skipped", text: "skipped: the screen says: the Refusals & rulings lane was only partly read" });
    // Control: a lane read whole with nothing in it is "none".
    const none = playStep("Recorded on the timeline", lane("ok"));
    expect(none.status.text).toStartWith("skipped: no refusal or call of stave in the window shown");
  });

  test("Changes: a failed PR-list read is the reason on every Changes step, not 'no open PR'", () => {
    const failed = { ".chg-pick": {}, ".chg-pick[title]": { title: "502 could not list the open PRs: rate limit" } };
    for (const t of ["Read the diff", "Comment on a line", "Check the evidence"]) {
      expect({ t, status: playStep(t, failed).status }).toEqual({ t, status: { kind: "skipped", text: "skipped: the screen says: 502 could not list the open PRs: rate limit" } });
    }
    // Control: a list read whole with no PR is "no open PR".
    for (const t of ["Comment on a line", "Check the evidence"]) {
      expect(playStep(t, { ".chg-pick": {} }).status.text).toBe("skipped: no open PR in stave");
    }
  });

  test("Agents: terminal sessions unread, still reading, or the host list unread is not 'no tabs'", () => {
    const row = { '[data-tour="agent-tabs"]': {}, "#aw-host-line": {} };
    const err = playStep("It runs here", { ...row, "#aw-tabs .aw-err": { text: "· stave terminal sessions: could not read (Failed to fetch)" } }, 5_000);
    expect(err.status).toEqual({ kind: "skipped", text: "skipped: the screen says: · stave terminal sessions: could not read (Failed to fetch)" });

    // Still reading past the 4 s grace: wait, then say it was still reading, never "none".
    const reading = { ...row, '#aw-tabs [data-read="reading"]': { text: "· stave terminal sessions: reading…" } };
    expect(playStep("It runs here", reading, 5_000).status.kind).toBe("looking");
    expect(playStep("It runs here", reading, 31_000).status.text).toBe("skipped: still reading after 30 s: · stave terminal sessions: reading…");

    const unread = playStep("It runs here", { ...row, '#aw-tabs [data-read="unread"]': { text: "list not read", title: "the agent host's list was not read: agent host off: no SDK" } }, 5_000);
    expect(unread.status.text).toBe("skipped: the screen says: the agent host's list was not read: agent host off: no SDK");

    // Control: both lists read, no tab.
    expect(playStep("It runs here", row, 5_000).status.text).toBe("skipped: no agent started here and no terminal session of stave to show as a tab");
  });

  test("Work: a board that could not be read, with no issue drawn, is the reason", () => {
    const ready = "#wk-board-src, #wk-issues-src, #wk-no-board, #wk-several-boards, #wk-board-unreadable";
    const unread = { [ready]: {}, "#wk-board-unreadable": { text: "could not read the board — showing open issues · gh: API rate limit exceeded" } };
    for (const t of ["Pick an issue", "Start the agent"]) {
      expect(playStep(t, unread).status.text).toBe("skipped: the screen says: could not read the board — showing open issues · gh: API rate limit exceeded");
    }
    // With an issue drawn under the unread board's head, the step is shown.
    expect(playStep("Pick an issue", { ...unread, '[data-tour="issue"]': {} }).status.kind).toBe("shown");
  });
});

/**
 * A fake browser for tour.ts: elements the tour finds on a screen are proxies that record every
 * member the tour touches, so a press in any spelling (`.click()`, `["click"]()`, dispatchEvent,
 * focus, a property set) is seen, not only the spellings a source scan knows.
 */
function fakeBrowser() {
  const touched: string[] = [];
  const marked = new Set<string>();
  const marks: string[] = [];
  const connected = new Map<string, boolean>();
  const MAY = new Set(["getAttribute", "classList", "scrollIntoView", "getBoundingClientRect", "isConnected", "innerText", "textContent"]);
  const pageEls = new Map<string, object>();
  const pageEl = (sel: string) => {
    if (pageEls.has(sel)) return pageEls.get(sel)!;
    connected.set(sel, true);
    const classList = new Proxy({}, {
      get: (_t, k) => {
        if (k === "add") return (c: string) => (marks.push(`${sel}:${c}`), marked.add(`${sel}:${c}`));
        if (k === "remove") return (c: string) => marked.delete(`${sel}:${c}`);
        touched.push(`classList.${String(k)}`);
        return () => {};
      },
    });
    const e = new Proxy({}, {
      get: (_t, k) => {
        if (typeof k === "symbol") return undefined;
        if (!MAY.has(k)) {
          touched.push(k);
          return () => {};
        }
        if (k === "getAttribute") return (n: string) => (n === "href" ? "#work?pr=1&project=stave" : "x");
        if (k === "classList") return classList;
        if (k === "scrollIntoView") return () => {};
        if (k === "getBoundingClientRect") return () => ({ height: 10 });
        if (k === "isConnected") return connected.get(sel);
        return sel; // innerText, textContent
      },
      set: (_t, k) => {
        touched.push(`set ${String(k)}`);
        return true;
      },
    });
    pageEls.set(sel, e);
    return e;
  };
  const made = () => {
    const o: Record<string, unknown> = { dataset: {}, style: {} };
    for (const m of ["setAttribute", "append", "appendChild", "addEventListener"]) o[m] = () => {};
    return o;
  };
  const intervals = new Map<number, () => void>();
  let nextId = 1;
  let observer: (() => void) | null = null;
  const g = globalThis as Record<string, unknown>;
  const names = ["document", "location", "matchMedia", "innerHeight", "MutationObserver", "setInterval", "clearInterval"];
  const saved = Object.fromEntries(names.map((n) => [n, g[n]]));
  const location = { hash: "#home" };
  Object.assign(g, {
    document: {
      head: made(),
      body: made(),
      createElement: made,
      addEventListener: () => {},
      querySelector: (sel: string) => (sel === "link[data-help-css]" ? null : pageEl(sel)),
    },
    location,
    matchMedia: () => ({ matches: true }),
    innerHeight: 800,
    MutationObserver: class {
      constructor(fn: () => void) {
        observer = fn;
      }
      observe() {}
      disconnect() {
        observer = null;
      }
    },
    setInterval: (fn: () => void) => {
      intervals.set(nextId, fn);
      return nextId++;
    },
    clearInterval: (id: number) => intervals.delete(id),
  });
  return {
    touched,
    marked,
    marks,
    location,
    tick: () => [...intervals.values()].forEach((f) => f()),
    redraw: () => {
      for (const k of connected.keys()) connected.set(k, false);
      pageEls.clear();
      observer?.();
    },
    restore: () => Object.assign(g, saved),
  };
}

describe("the tour only navigates and highlights", () => {
  test("played over every step, the tour touches a screen's elements only to read and mark them", async () => {
    const b = fakeBrowser();
    try {
      const { createTour } = await import("../ui/shell/tour");
      let done = 0;
      const tour = createTour({ go: (h) => (b.location.hash = h), project: () => "stave", finished: () => done++ });
      tour.start(0);
      let steps = 0;
      while (tour.pos()) {
        b.tick();
        expect(tour.outcome()).toEqual({ kind: "show" });
        b.redraw(); // a screen that redraws: the highlight moves to the new element
        steps++;
        tour.next();
      }
      expect(steps).toBe(FLOWS.reduce((n, f) => n + f.steps.length, 0));
      expect(done).toBe(1);
      // Each step's element was marked, and marked again after its screen redrew.
      const targets = new Set(FLOWS.flatMap((f) => f.steps.map((s) => `${s.target}:ht-hl`)));
      expect(new Set(b.marks)).toEqual(targets);
      expect(b.marks.length).toBe(2 * steps);
      expect(b.marked.size).toBe(0); // the last mark is taken off at the end
      expect(b.touched).toEqual([]);
    } finally {
      b.restore();
    }
  });

  const files = ["ui/shell/tour.ts", "ui/shell/tour-runner.ts", "ui/shell/tour-model.ts", "ui/components/HelpScreen.ts"];
  test("no file of the tour presses, sends or writes", () => {
    for (const f of files) {
      const src = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      for (const banned of [/\.click\(/, /dispatchEvent\(/, /\.submit\(/, /requestSubmit\(/, /\bfetch\(/, /from "\.\.?\/(\.\.\/)?write"/, /\bwrite\(/, /XMLHttpRequest/, /\.value\s*=/, /\.checked\s*=/]) {
        expect({ f, banned: String(banned), found: banned.test(src) }).toEqual({ f, banned: String(banned), found: false });
      }
    }
  });

  test("the page host can open a hash, find, mark and draw the card; nothing else", () => {
    const src = readFileSync("ui/shell/tour-runner.ts", "utf8");
    const iface = src.slice(src.indexOf("export interface TourHost"), src.indexOf("export interface CardView"));
    const members = [...iface.matchAll(/^\s{2}(\w+)\??\(/gm)].map((m) => m[1]).sort();
    expect(members).toEqual(["currentHash", "every", "find", "finished", "go", "highlight", "now", "paint", "project", "watch"]);
  });
});

describe("every element a step points at is marked on its screen", () => {
  const ui = readdirSync("ui/components").filter((f) => f.endsWith(".ts")).map((f) => readFileSync(`ui/components/${f}`, "utf8")).join("\n");
  test("each data-tour name a step uses is set by a screen", () => {
    const names = new Set(FLOWS.flatMap((f) => f.steps.flatMap((s) => [s.target, s.needs ?? "", s.ready, ...(s.gaps ?? []).map((g) => g.sel)]).flatMap((sel) => [...sel.matchAll(/data-tour="([^"]+)"/g)].map((m) => m[1]!))));
    expect(names.size).toBeGreaterThan(10);
    for (const n of names) {
      const set = ui.includes(`"data-tour": "${n}"`) || ui.includes(`dataset.tour = "${n}"`);
      expect({ n, set }).toEqual({ n, set: true });
    }
  });

  test("History's cells say their count and the lane's state, so an empty lane is not an unread one", () => {
    expect(ui).toContain('"data-n": n, "data-lane": state');
  });

  test("Agents' tab row says when a list is unread or still being read", () => {
    const agents = readFileSync("ui/components/AgentsScreen.ts", "utf8");
    expect(agents).toContain('dataset.read = "reading"');
    expect(agents).toContain('dataset.read = "unread"');
  });
});

test("⌘K lists each flow as a command that plays it", () => {
  const e = paletteEntries({ projects: [], currentProject: "stave", hostAgents: [], terminalAgents: [] }).filter((x) => x.flow !== undefined);
  expect(e.map((x) => x.flow)).toEqual([0, 1, 2, 3, 4, 5]);
  expect(e.every((x) => x.group === "Commands" && x.label.startsWith("Play flow"))).toBe(true);
});
