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

describe("the tour only navigates and highlights", () => {
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
});

test("⌘K lists each flow as a command that plays it", () => {
  const e = paletteEntries({ projects: [], currentProject: "stave", hostAgents: [], terminalAgents: [] }).filter((x) => x.flow !== undefined);
  expect(e.map((x) => x.flow)).toEqual([0, 1, 2, 3, 4, 5]);
  expect(e.every((x) => x.group === "Commands" && x.label.startsWith("Play flow"))).toBe(true);
});
