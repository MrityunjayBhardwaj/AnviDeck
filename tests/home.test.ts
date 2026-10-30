// Home (issue #18): one queue, one count, and "could not read" kept apart from "nothing to decide".
import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { needsCount, headlineText, badgeText, stripText } from "../ui/home-count";
import { orderQueue, prLinkFromLine, prLinksIn, prVerdict, readNotesCurrency } from "../server/readers/home";
import type { HomeResponse, QueueItem } from "../shared/home-types";

const TMP = "/private/tmp/claude-501/ui18/test-fixtures";

function item(kind: QueueItem["kind"], id: string, since: number | null): QueueItem {
  return { kind, id, what: id, why: "", dueBy: null, since, action: { label: "x", href: "https://example.invalid" }, source: "fixture" };
}

function fixture(queue: QueueItem[], opts: { unread?: number; prs?: HomeResponse["sources"]["prs"]["status"] } = {}): HomeResponse {
  const ok = { status: "ok" as const, label: "fixture" };
  return {
    generatedAt: "2026-10-31T00:00:00Z",
    queue,
    unread: Array.from({ length: opts.unread ?? 0 }, (_, i) => ({ id: `u${i}`, what: "could not check", source: "fixture" })),
    metrics: [],
    agents: [
      { sessionId: "a", name: "a", project: "p", cwd: "/p", branch: null, status: "busy", updatedAt: 0, openPrs: [] },
      { sessionId: "b", name: "b", project: "p", cwd: "/p", branch: null, status: "waiting", updatedAt: 0, openPrs: [] },
      { sessionId: "c", name: "c", project: "p", cwd: "/p", branch: null, status: "idle", updatedAt: 0, openPrs: [] },
    ],
    sources: { sessions: ok, prs: { status: opts.prs ?? "ok", label: "fixture" }, structure: ok, notes: ok },
    timings: {},
  };
}

const firstNumber = (s: string) => Number(/(\d+)/.exec(s)?.[1]);
const needYouNumber = (s: string) => Number(/(\d+) needs? you/.exec(s)?.[1]);

describe("one count drives the headline, the badge and the live strip", () => {
  for (const n of [0, 1, 3, 15]) {
    test(`queue of ${n}: all three say ${n}`, () => {
      const q = Array.from({ length: n }, (_, i) => item(i === 0 ? "agent-waiting" : "pr-review", `q${i}`, i));
      const c = needsCount(fixture(q));
      expect(c.n).toBe(n);
      expect(firstNumber(badgeText(c))).toBe(n);
      expect(needYouNumber(stripText(c))).toBe(n);
      if (n === 0) expect(headlineText(c)).toBe("Nothing needs you");
      else expect(firstNumber(headlineText(c))).toBe(n);
    });
  }

  test("the waiting count in the strip is the queue's waiting rows", () => {
    const c = needsCount(fixture([item("agent-waiting", "w1", 1), item("agent-waiting", "w2", 2), item("pr-review", "p", 3)]));
    expect(stripText(c)).toContain("2 waiting on you");
    expect(stripText(c)).toContain("3 agents · 1 working");
  });

  test("could not read is never shown as nothing to decide", () => {
    const partial = needsCount(fixture([], { prs: "could-not-read" }));
    expect(partial.state).toBe("partial");
    expect(headlineText(partial)).not.toBe("Nothing needs you");
    expect(headlineText(partial)).toContain("could not be read");
    expect(badgeText(partial)).toBe("0?");

    const unreadRows = needsCount(fixture([item("pr-review", "p", 1)], { unread: 2 }));
    expect(unreadRows.n).toBe(1); // unread rows are shown, never counted
    expect(badgeText(unreadRows)).toBe("1?");

    const failed = needsCount(null, true);
    expect(headlineText(failed)).toBe("Could not read what needs you");
    expect(badgeText(failed)).toBe("?");
    const loading = needsCount(null);
    expect(badgeText(loading)).toBe("…");
    expect(headlineText(loading)).not.toMatch(/\d/);
  });

  test("no other UI file counts the queue on its own", () => {
    // The count must come from needsCount() only: any other `.queue.length` / `.queue.filter`
    // in the UI would be a second derivation that could disagree.
    const files = [
      ...readdirSync("ui").filter((f) => f.endsWith(".ts")).map((f) => join("ui", f)),
      ...readdirSync("ui/components").filter((f) => f.endsWith(".ts")).map((f) => join("ui/components", f)),
    ];
    const offenders = files.filter((f) => f !== join("ui", "home-count.ts") && /queue\.(length|filter|reduce)/.test(readFileSync(f, "utf8").replace(/home\.queue\.length === 0/g, "")));
    expect(offenders).toEqual([]);
    const app = readFileSync("ui/app.ts", "utf8");
    expect(app).toContain("count = needsCount(home, failed)");
    expect(app).toContain("badgeText(count)");
    expect(app).toContain("stripText(count)");
    expect(app).toContain("CommandCenter(projects, nav, home, count)");
    expect(readFileSync("ui/components/CommandCenter.ts", "utf8")).toContain("headlineText(count)");
    // And the check can fail: a second derivation is caught.
    expect(/queue\.(length|filter|reduce)/.test("const n = home.queue.filter(x => x).length")).toBe(true);
  });
});

describe("what may enter the queue", () => {
  test("only an open, non-draft PR is a review (merged, closed and draft must NOT match)", () => {
    expect(prVerdict({ state: "OPEN", isDraft: false, title: "", url: null })).toBe("review");
    expect(prVerdict({ state: "OPEN", isDraft: true, title: "", url: null })).toBe("draft");
    expect(prVerdict({ state: "MERGED", isDraft: false, title: "", url: null })).toBe("merged");
    expect(prVerdict({ state: "CLOSED", isDraft: false, title: "", url: null })).toBe("closed");
    expect(prVerdict({ state: "", isDraft: false, title: "", url: null })).toBe("other");
  });

  test("order: agents blocked now, then rule breaks, then PRs; oldest first within a kind", () => {
    const out = orderQueue([
      item("pr-review", "pr-new", 300),
      item("pr-review", "pr-old", 100),
      item("rule-break", "rules", 500),
      item("agent-waiting", "agent", 900),
    ]).map((q) => q.id);
    expect(out).toEqual(["agent", "rules", "pr-old", "pr-new"]);
    // A recorded deadline would go first, whatever its kind.
    const due = { ...item("pr-review", "due", 999), dueBy: "2026-11-01" };
    expect(orderQueue([item("agent-waiting", "agent", 1), due])[0].id).toBe("due");
  });

  test("pr-link lines: only real pr-link records, not text that mentions them", () => {
    expect(prLinkFromLine('{"type":"pr-link","prNumber":7,"prRepository":"o/r","prUrl":"https://github.com/o/r/pull/7","timestamp":"2026-10-30T00:00:00Z"}'))
      .toEqual({ number: 7, repo: "o/r", url: "https://github.com/o/r/pull/7", first: Date.parse("2026-10-30T00:00:00Z") });
    expect(prLinkFromLine('{"type":"user","message":"the \\"pr-link\\" record"}')).toBeNull();
    expect(prLinkFromLine('{"type":"pr-link","prNumber":"7","prRepository":"o/r"}')).toBeNull();
    expect(prLinkFromLine('{"type":"pr-link","prNumber":7}')).toBeNull(); // no repo: cannot be asked of GitHub
    expect(prLinkFromLine("not json \"pr-link\"")).toBeNull();
  });

  test("a transcript is read incrementally, and a half-written line is read again", () => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
    const t = join(TMP, "t.jsonl");
    const link = (n: number) => JSON.stringify({ type: "pr-link", prNumber: n, prRepository: "o/r", timestamp: "2026-10-30T00:00:00Z" });
    writeFileSync(t, `{"type":"user"}\n${link(1)}\n${link(1)}\n`);
    expect(prLinksIn(t).map((l) => l.number)).toEqual([1]);
    const half = link(2);
    appendFileSync(t, half.slice(0, 20));
    expect(prLinksIn(t).map((l) => l.number)).toEqual([1]);
    appendFileSync(t, `${half.slice(20)}\n`);
    expect(prLinksIn(t).map((l) => l.number)).toEqual([1, 2]);
    writeFileSync(t, `${link(3)}\n`); // shrank: read again from the start
    expect(prLinksIn(t).map((l) => l.number)).toEqual([3]);
  });
});

describe("notes currency snapshot", () => {
  test("newest snapshot; drifted = YELLOW + RED; absent and unreadable differ", () => {
    const d = join(TMP, "health");
    rmSync(d, { recursive: true, force: true });
    mkdirSync(d, { recursive: true });
    expect(readNotesCurrency(d).source.status).toBe("none");
    expect(readNotesCurrency(join(TMP, "no-such-dir")).source.status).toBe("none");
    writeFileSync(join(d, "health-2026-09-01.json"), JSON.stringify({ date: "2026-09-01", projects: { a: { examined: 1, counts: { RED: 1 } } } }));
    writeFileSync(join(d, "health-2026-10-02.json"), JSON.stringify({
      date: "2026-10-02",
      projects: { a: { examined: 10, counts: { RED: 1, YELLOW: 2, GREEN: 7 } }, b: { examined: 5, counts: { GRAY: 5 } } },
      unmeasured: { c: "no working copy" },
    }));
    writeFileSync(join(d, "health-README.md"), "not a snapshot");
    const r = readNotesCurrency(d);
    expect(r.source.status).toBe("ok");
    expect(r.value).toMatchObject({ date: "2026-10-02", examined: 15, red: 1, yellow: 2, projects: 2, unmeasured: ["c"] });
    writeFileSync(join(d, "health-2026-10-03.json"), "{ broken");
    expect(readNotesCurrency(d).source.status).toBe("could-not-read");
  });
});
