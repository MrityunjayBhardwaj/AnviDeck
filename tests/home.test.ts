// Home (issue #18): one queue, one count, and "could not read" kept apart from "nothing to decide".
import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { needsCount, headlineText, badgeText, stripText } from "../ui/home-count";
import { terminalSessions } from "../server/readers/home";
import { readAgentRegistry } from "../server/readers/agent-registry";
import { healthMetrics, byDeadline, deadlineIn, STILL_READING, groupFailedPrs, orderQueue, parseAuthoredPrs, prLinkFromLine, prLinksIn, prVerdict, readNotesCurrency, resetAuthoredSearch, searchAuthoredPrs, splitAuthoredPrs, answersFromSearch } from "../server/readers/home";
import type { HomeResponse, QueueItem } from "../shared/home-types";

const TMP = "/private/tmp/claude-501/ui18/test-fixtures";

function item(kind: QueueItem["kind"], id: string, since: number | null): QueueItem {
  return { kind, id, what: id, why: "", dueBy: null, since, action: { label: "x", href: "https://example.invalid" }, source: "fixture" };
}

function fixture(queue: QueueItem[], opts: { unread?: number; reading?: number; prs?: HomeResponse["sources"]["prs"]["status"] } = {}): HomeResponse {
  const ok = { status: "ok" as const, label: "fixture" };
  return {
    generatedAt: "2026-10-31T00:00:00Z",
    queue,
    unread: [
      ...Array.from({ length: opts.unread ?? 0 }, (_, i) => ({ id: `u${i}`, what: "could not check", source: "fixture" })),
      ...Array.from({ length: opts.reading ?? 0 }, (_, i) => ({ id: `r${i}`, what: "still reading", source: "fixture", reading: true as const })),
    ],
    olderPrs: [],
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
const needYouNumber = (s: string) => Number(/(\d+)[?…]? needs? you/.exec(s)?.[1]);

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
    expect(headlineText(partial)).not.toMatch(/^Nothing needs you/);
    expect(headlineText(partial)).toContain("could not be read");
    expect(badgeText(partial)).toBe("0?");
    expect(stripText(partial)).toContain("0? need");
    expect(needYouNumber(stripText(partial))).toBe(0);

    const unreadRows = needsCount(fixture([item("pr-review", "p", 1)], { unread: 2 }));
    expect(unreadRows.n).toBe(1); // unread rows are shown, never counted
    expect(badgeText(unreadRows)).toBe("1?");

    // Still reading (#61): neither the all-clear nor a failure, and never counted.
    const reading = needsCount(fixture([item("pr-review", "p", 1)], { prs: "reading", reading: 2 }));
    expect(reading.state).toBe("reading");
    expect(reading.n).toBe(1);
    expect(reading.unread).toBe(0);
    expect(reading.reading).toBe(3);
    expect(headlineText(reading)).toBe("1 thing needs you so far; still reading some sources");
    expect(badgeText(reading)).toBe("1…");
    expect(needYouNumber(stripText(reading))).toBe(1);
    const readingNone = needsCount(fixture([], { reading: 1 }));
    expect(headlineText(readingNone)).not.toMatch(/^Nothing needs you/);
    expect(headlineText(readingNone)).not.toContain("could not be read");
    // A real failure beside a slow source still says "could not be read".
    const both = needsCount(fixture([], { prs: "could-not-read", reading: 1 }));
    expect(both.state).toBe("partial");
    expect(headlineText(both)).toContain("could not be read");

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
    // `.queue.` — a property access like home.queue — not any local variable named queue (the
    // Agents view's own work queue counts fetch jobs, not decisions).
    const QUEUE_COUNT = /\.queue\.(length|filter|reduce)/;
    const offenders = files.filter((f) => f !== join("ui", "home-count.ts") && QUEUE_COUNT.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
    const app = readFileSync("ui/app.ts", "utf8");
    expect(app).toContain("count = needsCount(home, failed, hostAsks())");
    // Every recount passes the host's parked requests (#131): no needsCount(home) call without them.
    expect(app.match(/needsCount\(home, [^)]*\)/g)?.every((c) => c.includes("hostAsks()"))).toBe(true);
    expect(app).toContain("badgeText(count)");
    expect(app).toContain("stripText(count)");
    // Home is HomeScreen (#81): it is handed the one count and its headline reads it.
    expect(app).toContain("return { home, count, failed: count.state === \"failed\", host: hostAgents, project, projectsReadAt };");
    expect(app).toContain("HomeScreen(homeInput())");
    expect(app).toContain("updateHomeScreen(homeInput())");
    expect(readFileSync("ui/components/HomeScreen.ts", "utf8")).toContain("headlineText(input.count)");
    // And the check can fail: a second derivation is caught.
    expect(QUEUE_COUNT.test("const n = home.queue.filter(x => x).length")).toBe(true);
    expect(QUEUE_COUNT.test("while (running < 2 && queue.length) {")).toBe(false);
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

  test("PRs that could not be checked: one row per reason, not one per PR", () => {
    const fails = Array.from({ length: 53 }, (_, i) => ({ key: `o/r#${i}`, reason: 'Executable not found in $PATH: "gh"' }));
    fails.push({ key: "o/r#99", reason: "HTTP 404" });
    const rows = groupFailedPrs(fails);
    expect(rows.length).toBe(2);
    expect(rows[0].what).toBe("Could not check 53 PRs");
    expect(rows[0].source).toContain("o/r#0, o/r#1, o/r#2 and 50 more");
    expect(rows[1].what).toBe("Could not check PR o/r#99");
    expect(groupFailedPrs([])).toEqual([]);
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

describe("open PRs you authored, from gh search (#45)", () => {
  const DAY = 86_400_000;
  const NOW = Date.parse("2026-11-01T00:00:00Z");
  const row = (repo: string, n: number, updatedDaysAgo: number, isDraft = false) => ({
    number: n,
    repository: { nameWithOwner: repo },
    title: `t${n}`,
    url: `https://github.com/${repo}/pull/${n}`,
    isDraft,
    createdAt: new Date(NOW - (updatedDaysAgo + 5) * DAY).toISOString(),
    updatedAt: new Date(NOW - updatedDaysAgo * DAY).toISOString(),
  });

  test("an ended session's open PR joins the queue; linked, draft and quiet ones do not", () => {
    const prs = parseAuthoredPrs(JSON.stringify([row("o/a", 1, 2), row("o/b", 2, 3), row("o/c", 3, 1, true), row("o/d", 4, 400), row("o/e", 5, 31)]));
    const s = splitAuthoredPrs(prs, new Set(["o/b#2"]), NOW);
    expect(s.recent.map((p) => p.key)).toEqual(["o/a#1"]); // must match: recent, unlinked, not a draft
    expect(s.alreadyLinked).toBe(1); // must not: a live session already links it
    expect(s.drafts).toBe(1); // must not: a draft is not a review
    expect(s.older.map((p) => p.key)).toEqual(["o/d#4", "o/e#5"]); // must not: quiet for 30+ days, oldest first
  });

  test("the 30-day edge: updated exactly 30 days ago is still recent, a minute more is not", () => {
    const at = (ms: number) => parseAuthoredPrs(JSON.stringify([{ ...row("o/a", 1, 0), updatedAt: new Date(ms).toISOString() }]));
    expect(splitAuthoredPrs(at(NOW - 30 * DAY), new Set(), NOW).recent.length).toBe(1);
    expect(splitAuthoredPrs(at(NOW - 30 * DAY - 60_000), new Set(), NOW).older.length).toBe(1);
  });

  test("a bad answer throws instead of reading as no PRs", () => {
    expect(() => parseAuthoredPrs("not json")).toThrow();
    expect(() => parseAuthoredPrs('{"message":"rate limited"}')).toThrow();
    expect(parseAuthoredPrs("[]")).toEqual([]);
  });

  test("searched once, then served from cache; a failure is reported and never cached", async () => {
    resetAuthoredSearch();
    let calls = 0;
    const fail = async () => (calls++, { ok: false, out: "", err: "gh: not logged in" });
    const a = await searchAuthoredPrs(fail, NOW);
    expect(a).toEqual({ ok: false, err: "gh: not logged in" });
    const okRun = async () => (calls++, { ok: true, out: JSON.stringify([row("o/a", 1, 2)]), err: "" });
    const b = await searchAuthoredPrs(okRun, NOW); // the failure was not cached: asks again
    expect(b.ok && !b.cached && b.prs.length).toBe(1);
    expect(calls).toBe(2);
    const c = await searchAuthoredPrs(okRun, Date.now()); // fresh: no new call
    expect(c.ok && c.cached).toBe(true);
    expect(calls).toBe(2);
    const d = await searchAuthoredPrs(okRun, Date.now() + 61_000); // stale: answered at once, refreshed behind
    expect(d.ok && d.cached).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(3);
    resetAuthoredSearch();
  });

  test("a failing background refresh is reported beside the answer it could not replace, until one succeeds (#54)", async () => {
    resetAuthoredSearch();
    const okRun = async () => ({ ok: true, out: JSON.stringify([row("o/a", 1, 2)]), err: "" });
    const fail = async () => ({ ok: false, out: "", err: "gh: not logged in" });
    const tick = () => new Promise((r) => setTimeout(r, 0));
    await searchAuthoredPrs(okRun, NOW);
    const fresh = await searchAuthoredPrs(fail, Date.now()); // fresh cache: no refresh, nothing to report
    expect(fresh.ok && fresh.refreshFailed).toBeUndefined();

    await searchAuthoredPrs(fail, Date.now() + 61_000); // stale: served, refresh fails behind it
    await tick();
    const after = await searchAuthoredPrs(fail, Date.now() + 62_000);
    expect(after.ok && after.prs.length).toBe(1); // the last answer is still served...
    expect(after.ok && after.refreshFailed?.err).toBe("gh: not logged in"); // ...and says it could not be refreshed

    await tick();
    await searchAuthoredPrs(okRun, Date.now() + 63_000); // gh works again
    await tick();
    const healed = await searchAuthoredPrs(okRun, Date.now());
    expect(healed.ok && healed.refreshFailed).toBeUndefined();
    resetAuthoredSearch();
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

test("Home's health figures include reads cut short, whatever else could be read (#257)", () => {
  const none = { status: "none" as const, label: "x" };
  const ids = healthMetrics({ source: none, reading: false, newBreaks: 0, allowed: 0, measured: 0, measuredOf: null }, { value: null, source: none }, Date.now()).map((m) => m.id);
  expect(ids).toEqual(["new-breaks", "allowed-breaks", "notes", "child-reads"]);
});

describe("Home answers within a budget (#61)", () => {
  test("a read that beats the deadline gives its answer; a slow one gives STILL_READING and still finishes", async () => {
    const d = deadlineIn(40);
    let slowDone = false;
    const fast = byDeadline(Promise.resolve("fast"), d);
    const slow = byDeadline(new Promise<string>((r) => setTimeout(() => ((slowDone = true), r("slow")), 120)), d);
    expect(await fast).toBe("fast");
    expect(await slow).toBe(STILL_READING);
    expect(slowDone).toBe(false);
    await new Promise((r) => setTimeout(r, 120));
    expect(slowDone).toBe(true); // the read kept running, so its cache fills for the next load
    d.cancel();
  });

  test("one deadline is shared: a read started late gets only the time left", async () => {
    const d = deadlineIn(60);
    await new Promise((r) => setTimeout(r, 40));
    const late = byDeadline(new Promise<string>((r) => setTimeout(() => r("late"), 50)), d);
    expect(await late).toBe(STILL_READING);
    d.cancel();
  });
});

describe("linked PRs answered by the open-PR search (#46)", () => {
  const pr = (repo: string, number: number, isDraft = false) => ({
    key: `${repo}#${number}`, number, repo, title: `t${number}`, url: `https://github.com/${repo}/pull/${number}`, isDraft, createdAt: 0, updatedAt: 0,
  });
  const search = { ok: true as const, prs: [pr("o/r", 1), pr("o/r", 2, true)], at: 0, cached: true };
  test("a linked PR the search lists is judged from it, draft flag included", () => {
    const m = answersFromSearch(["o/r#1", "o/r#2"], search);
    expect(prVerdict(m.get("o/r#1")!)).toBe("review");
    expect(prVerdict(m.get("o/r#2")!)).toBe("draft");
    expect(m.get("o/r#1")!.url).toBe("https://github.com/o/r/pull/1");
  });
  test("repository names match whatever their case", () => {
    expect(answersFromSearch(["O/R#1"], search).has("O/R#1")).toBe(true);
  });
  test("must-not-answer: a PR the search does not list, another repo, or no usable search", () => {
    expect(answersFromSearch(["o/r#3", "o/x#1", "o/r#11"], search).size).toBe(0);
    expect(answersFromSearch(["o/r#1"], null).size).toBe(0);
    expect(answersFromSearch(["o/r#1"], { ok: false, err: "gh: not logged in" }).size).toBe(0);
  });
});

describe("agents' permission requests count toward what needs you (#131)", () => {
  test("one parked request with an empty Home queue: headline and badge say 1", () => {
    const c = needsCount(fixture([]), false, { state: "ok", requests: 1, unreadable: 0 });
    expect(c.n).toBe(1);
    expect(c.waiting).toBe(1);
    expect(headlineText(c)).toBe("1 thing needs you");
    expect(badgeText(c)).toBe("1");
  });

  test("requests add to the Home queue", () => {
    const c = needsCount(fixture([item("pr-review", "p", 1)]), false, { state: "ok", requests: 2, unreadable: 0 });
    expect(c.n).toBe(3);
  });

  test("agents that could not be read are unread, never 'Nothing needs you'", () => {
    for (const asks of [{ state: "failed" as const }, { state: "off" as const }]) {
      const c = needsCount(fixture([]), false, asks);
      expect(c.state).toBe("partial");
      expect(headlineText(c)).not.toBe("Nothing needs you");
    }
    const odd = needsCount(fixture([]), false, { state: "ok", requests: 0, unreadable: 1 });
    expect(odd.state).toBe("partial");
  });

  test("agents not read yet change nothing", () => {
    expect(needsCount(fixture([]), false, undefined)).toEqual(needsCount(fixture([])));
    expect(headlineText(needsCount(fixture([])))).toBe("Nothing needs you");
  });
});


describe("an AnviDeck agent's live session is the agent, not a terminal session (#252)", () => {
  const live = [{ sessionId: "sess-agent", name: "a" }, { sessionId: "sess-term", name: "t" }];
  const reg = (over: object) => ({ path: "/r/agents.json", status: "read" as const, agents: [], ...over });

  test("a session whose id is a registry agent's is left out; the rest are terminal sessions", () => {
    const r = terminalSessions(live, reg({ agents: [{ id: "ag1", cwd: "/p", sessionId: "sess-agent" }, { id: "ag2", cwd: "/p" }] }));
    expect(r).toEqual({ terminals: [live[1]], agentSessions: 1, registryNote: null });
  });

  test("no registry yet: every session is a terminal session, with nothing to say", () => {
    expect(terminalSessions(live, reg({ status: "absent" }))).toEqual({ terminals: live, agentSessions: 0, registryNote: null });
  });

  test("a registry that could not be read keeps every session, and says so: counted twice rather than not at all", () => {
    const r = terminalSessions(live, reg({ status: "unreadable", reason: "/r/agents.json: EACCES" }));
    expect(r.terminals).toEqual(live);
    expect(r.registryNote).toContain("could not be read (/r/agents.json: EACCES)");
  });

  test("the registry is read from ANVIDECK_AGENT_DIR", () => {
    const d = join(mkdtempSync(join(tmpdir(), "home-reg-")), "agentdir");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "agents.json"), JSON.stringify({ agents: [{ id: "ag1", cwd: "/p", sessionId: "s1" }] }));
    const was = process.env.ANVIDECK_AGENT_DIR;
    process.env.ANVIDECK_AGENT_DIR = d;
    try {
      expect(readAgentRegistry()).toMatchObject({ status: "read", agents: [{ id: "ag1", sessionId: "s1" }] });
      writeFileSync(join(d, "agents.json"), "{ not json");
      expect(readAgentRegistry().status).toBe("unreadable");
    } finally {
      if (was === undefined) delete process.env.ANVIDECK_AGENT_DIR;
      else process.env.ANVIDECK_AGENT_DIR = was;
    }
  });
});
