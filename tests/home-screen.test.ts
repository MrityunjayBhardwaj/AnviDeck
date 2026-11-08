// Home as in the prototype (#81): the queue's rows, ready-to-merge, the health line, the agents.
import { beforeEach, describe, expect, test } from "bun:test";
import { judgeReady, parsePrKey, type PrReadyView, type ReadyAnswer } from "../shared/pr-ready";
import { readReady, readyFromGh, resetReadyCache } from "../server/readers/pr-ready";
import { agentRows, groundingRow, healthModel, queueRows, readyKeys, type ReadyRead } from "../ui/components/home-model";
import { needsCount, type HostAsks } from "../ui/home-count";
import { permissionQueue, type AskingAgent } from "../shared/permission-requests";
import type { AgentsRead, StripAgent } from "../ui/shell/activity";
import type { HomeMetric, HomeResponse, QueueItem } from "../shared/home-types";
import type { ProjectSummary } from "../shared/types";
import home from "../server/routes/home";
import { newestDate, notesMetric, structureMetrics } from "../server/readers/home";
import { keyedReuse, reconcile, type ParentLike } from "../ui/components/keyed-rows";
import { readFileSync } from "node:fs";

const EVIDENCE = `Summary.

## Evidence

### Tests
| Command | Exit | Result |
|---|---|---|
| \`bun test\` | 0 | 10 pass, 0 fail |

### Observed
- Opened Home on port 4101: the row reads "ready to merge".

### Not checked
- None.

## Self-review

| Severity | Gap | Issue |
|---|---|---|
| low | A gap. | none |
`;

function view(over: Partial<PrReadyView> = {}): PrReadyView {
  return {
    number: 7,
    state: "OPEN",
    isDraft: false,
    mergeable: "MERGEABLE",
    reviewDecision: "",
    statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }, { __typename: "StatusContext", state: "SUCCESS" }],
    headRefOid: "abcdef1234567",
    body: EVIDENCE,
    ...over,
  };
}

describe("ready to merge: every condition must hold", () => {
  test("a clean PR with recorded evidence is ready, and says which head", () => {
    const v = judgeReady(view());
    expect(v.reasons).toEqual([]);
    expect(v.ready).toBe(true);
    expect(v.checks).toBe("2 checks passed");
    expect(v.headRefOid).toBe("abcdef1234567");
  });
  test("no checks at all is said, not hidden", () => {
    expect(judgeReady(view({ statusCheckRollup: [] }))).toMatchObject({ ready: true, checks: "no checks", noChecks: true });
    expect(judgeReady(view()).noChecks).toBe(false);
  });
  const withGaps = (rows: string) => EVIDENCE.replace("| low | A gap. | none |", rows);
  test("a high-severity self-review gap blocks, tracked or not", () => {
    const v = judgeReady(view({ body: withGaps("| high | Merge can lose data. | #9 |") }));
    expect(v.ready).toBe(false);
    expect(v.reasons.join(" ")).toContain("1 high-severity gap: Merge can lose data.");
  });
  test("a medium gap blocks until it has an issue, then is listed", () => {
    const untracked = judgeReady(view({ body: withGaps("| medium | Focus is lost. | none |") }));
    expect(untracked.ready).toBe(false);
    expect(untracked.reasons.join(" ")).toContain("1 medium gap with no issue filed");
    const tracked = judgeReady(view({ body: withGaps("| medium | Focus is lost. | #142 |\n| low | Small. | none |") }));
    expect(tracked.ready).toBe(true);
    expect(tracked.claims).toEqual({ testRuns: 1, observed: 1, gaps: { high: 0, medium: 1, low: 1 }, mediumGaps: ["Focus is lost. (#142)"] });
  });
  const cases: [string, Partial<PrReadyView>, RegExp][] = [
    ["closed", { state: "CLOSED" }, /closed/],
    ["draft", { isDraft: true }, /draft/],
    ["conflicts", { mergeable: "CONFLICTING" }, /merge conflicts/],
    ["mergeability not known yet", { mergeable: "UNKNOWN" }, /not worked out/],
    ["changes requested", { reviewDecision: "CHANGES_REQUESTED" }, /asks for changes/],
    ["review required", { reviewDecision: "REVIEW_REQUIRED" }, /required review/],
    ["a failed check", { statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }] }, /1 of 1 checks failed/],
    ["a running check", { statusCheckRollup: [{ status: "IN_PROGRESS", conclusion: "" }] }, /not finished/],
    ["a failing status", { statusCheckRollup: [{ state: "ERROR" }] }, /checks failed/],
    ["a pending status", { statusCheckRollup: [{ state: "PENDING" }] }, /not finished/],
    ["no Evidence section", { body: "## Summary\nhello" }, /no Evidence section/],
    ["no Self-review section", { body: EVIDENCE.split("## Self-review")[0] }, /no Self-review section/],
    ["a test exited non-zero", { body: EVIDENCE.replace("| 0 | 10 pass", "| 1 | 10 pass") }, /exited non-zero/],
    ["nothing observed", { body: EVIDENCE.replace(/### Observed\n- [^\n]*\n/, "### Observed\n") }, /seen working|written wrong/],
    ["null body", { body: null }, /no Evidence section/],
  ];
  for (const [name, over, why] of cases) {
    test(`not ready: ${name}`, () => {
      const v = judgeReady(view(over));
      expect(v.ready).toBe(false);
      expect(v.reasons.join("; ")).toMatch(why);
    });
  }
  test("PR keys", () => {
    expect(parsePrKey("o/n#12")).toEqual({ repo: "o/n", number: 12 });
    expect(parsePrKey("o/n#x")).toBeNull();
    expect(parsePrKey("o#1")).toBeNull();
  });
});

describe("the readiness reader: could not read is never 'not ready'", () => {
  beforeEach(() => resetReadyCache());
  test("gh failing, non-JSON or a short answer are could-not-read with the reason", () => {
    expect(readyFromGh("o/n#1", { ok: false, out: "", err: "HTTP 502" })).toEqual({ status: "could-not-read", key: "o/n#1", reason: "HTTP 502" });
    expect(readyFromGh("o/n#1", { ok: true, out: "<html>", err: "" }).status).toBe("could-not-read");
    expect(readyFromGh("o/n#1", { ok: true, out: JSON.stringify({ state: "OPEN" }), err: "" }).status).toBe("could-not-read");
    const ok = readyFromGh("o/n#1", { ok: true, out: JSON.stringify(view()), err: "" });
    expect(ok).toMatchObject({ status: "ok", ready: true, repo: "o/n", number: 1 });
  });
  test("a not-ready answer is cached; a failure is not", async () => {
    let calls = 0;
    let fail = true;
    const run = async (cmd: string[]) => {
      calls++;
      expect(cmd.slice(0, 3)).toEqual(["gh", "pr", "view"]);
      return fail ? { ok: false, out: "", err: "offline" } : { ok: true, out: JSON.stringify(view({ isDraft: true })), err: "" };
    };
    const a = await readReady(["o/n#1"], run);
    expect(a[0]!.status).toBe("could-not-read");
    fail = false;
    const b = await readReady(["o/n#1"], run);
    expect(b[0]).toMatchObject({ status: "ok", ready: false });
    await readReady(["o/n#1"], run);
    expect(calls).toBe(2);
  });
  test("a ready answer is never cached: a push after it is seen at the next ask", async () => {
    // The cache is keyed by PR, not head. Ready at head A, then a push of head B that fails.
    let head = "aaaaaaa1111";
    let calls = 0;
    const run = async () => {
      calls++;
      const v = head === "aaaaaaa1111" ? view({ headRefOid: head }) : view({ headRefOid: head, statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }] });
      return { ok: true, out: JSON.stringify(v), err: "" };
    };
    const first = await readReady(["o/n#1"], run);
    expect(first[0]).toMatchObject({ status: "ok", ready: true, headRefOid: "aaaaaaa1111" });
    head = "bbbbbbb2222";
    const second = await readReady(["o/n#1"], run);
    expect(calls).toBe(2);
    expect(second[0]).toMatchObject({ status: "ok", ready: false, headRefOid: "bbbbbbb2222" });
  });
  test("answers come back in the order asked; a bad key is could-not-read without asking", async () => {
    let calls = 0;
    const run = async (cmd: string[]) => {
      calls++;
      return { ok: true, out: JSON.stringify(view({ number: Number(cmd[3]) })), err: "" };
    };
    const r = await readReady(["o/n#3", "nope", "o/n#1", "o/n#2"], run);
    expect(r.map((x) => x.key)).toEqual(["o/n#3", "nope", "o/n#1", "o/n#2"]);
    expect(r[1]!.status).toBe("could-not-read");
    expect(calls).toBe(3);
  });
  test("the route refuses no keys, bad keys and too many", async () => {
    expect((await home.request("/ready")).status).toBe(400);
    expect((await home.request("/ready?pr=nope")).status).toBe(400);
    const many = Array.from({ length: 41 }, (_, i) => `pr=${encodeURIComponent(`o/n#${i}`)}`).join("&");
    expect((await home.request(`/ready?${many}`)).status).toBe(400);
  });
});

// ── the queue ────────────────────────────────────────────────────────────────────────────

const ok = { status: "ok" as const, label: "fixture" };
function item(kind: QueueItem["kind"], id: string, over: Partial<QueueItem> = {}): QueueItem {
  return { kind, id, what: kind === "pr-review" ? `Review PR #${id.split("#")[1]}: Title ${id}` : id, why: "why", dueBy: null, since: null, action: { label: "Open on GitHub", href: "https://github.com/x" }, source: "fixture", ...over };
}
function homeOf(queue: QueueItem[], over: Partial<HomeResponse> = {}): HomeResponse {
  return {
    generatedAt: "2026-11-05T10:00:00Z",
    queue,
    unread: [],
    olderPrs: [],
    metrics: [],
    agents: [{ sessionId: "s1", name: "anvi-1", project: "anvi", cwd: "/x/anvi", branch: null, status: "waiting", updatedAt: 0, openPrs: [] }],
    sources: { sessions: ok, prs: ok, structure: ok, notes: ok },
    timings: {},
    ...over,
  };
}
function ask(id: string, at: string) {
  return { requestId: id, toolName: "Bash", input: { command: `echo ${id}` }, askedAt: at };
}
function hostAgent(id: string, pending: unknown[], status = "waiting"): StripAgent {
  return { id, status, cwd: `/w/${id}`, prompt: `do ${id}\nmore`, pendingPermissions: pending };
}
/** The same derivation app.ts makes for the count. */
function asksOf(host: AgentsRead): HostAsks | undefined {
  if (host.state === "loading") return undefined;
  if (host.state !== "ok") return { state: host.state === "off" ? "off" : "failed" };
  const q = permissionQueue(host.agents as unknown as AskingAgent[]);
  return { state: "ok", requests: q.requests.length, unreadable: q.unreadable };
}
const READY_NONE: ReadyRead = { state: "ok", answers: new Map() };

describe("the queue's rows are the count's things, one each", () => {
  const queue = [item("agent-waiting", "agent:s1"), item("rule-break", "rules:stave"), item("pr-review", "pr:o/n#5"), item("pr-review", "pr:o/n#6")];
  const hosts: [string, AgentsRead][] = [
    ["loading", { state: "loading" }],
    ["off", { state: "off", reason: "no claude" }],
    ["failed", { state: "failed", reason: "502" }],
    ["two asks and one unreadable", { state: "ok", agents: [hostAgent("a1", [ask("r1", "2026-11-05T09:00:00Z"), { junk: true }]), hostAgent("a2", [ask("r2", "2026-11-05T08:00:00Z")]), hostAgent("a3", [], "working")] }],
  ];
  for (const [name, host] of hosts) {
    test(`host ${name}: rows = needsCount().n`, () => {
      const h = homeOf(queue);
      const { rows } = queueRows(h, host, READY_NONE);
      expect(rows.length).toBe(needsCount(h, false, asksOf(host)).n);
    });
  }
  test("host could not be read: an unread row, never 'no requests'", () => {
    const { unread } = queueRows(homeOf([]), { state: "failed", reason: "502" }, READY_NONE);
    expect(unread.map((u) => u.what).join(" ")).toMatch(/Could not read permission requests/);
    expect(unread[0]!.reading).toBe(false);
  });
  test("an unreadable request is an unread row", () => {
    const host: AgentsRead = { state: "ok", agents: [hostAgent("a1", [{ junk: true }])] };
    expect(queueRows(homeOf([]), host, READY_NONE).unread.map((u) => u.what)).toEqual(["1 permission request could not be read"]);
  });
  test("order: a deadline first, then asks (longest waiting first), then the readers' order", () => {
    const host: AgentsRead = { state: "ok", agents: [hostAgent("a1", [ask("late", "2026-11-05T09:00:00Z")]), hostAgent("a2", [ask("early", "2026-11-05T08:00:00Z")])] };
    const due = item("pr-review", "pr:o/n#9", { dueBy: "2026-11-06" });
    const { rows } = queueRows(homeOf([item("agent-waiting", "agent:s1"), item("pr-review", "pr:o/n#5"), due]), host, READY_NONE);
    expect(rows.map((r) => r.key)).toEqual(["pr:o/n#9", "ask:early", "ask:late", "agent:s1", "pr:o/n#5"]);
    expect(rows[0]!.when).toBe("due 2026-11-06");
    expect(rows[4]!.when).toBe("no deadline");
  });
  test("an ask is answered in place; a terminal agent opens its session; a rule break opens the Map", () => {
    const host: AgentsRead = { state: "ok", agents: [hostAgent("a1", [ask("r1", "2026-11-05T09:00:00Z")])] };
    const { rows } = queueRows(homeOf([item("agent-waiting", "agent:s1"), item("rule-break", "rules:stave")]), host, READY_NONE);
    expect(rows[0]).toMatchObject({ kind: "answer", title: "An agent asks to run `echo r1`", action: { type: "answer", agentId: "a1", requestId: "r1" } });
    expect(rows[1]!.action).toEqual({ type: "hash", label: "Open session", hash: "#agents?project=anvi&sid=s1" });
    expect(rows[2]!.action).toEqual({ type: "hash", label: "Open on Map", hash: "#map?project=stave" });
  });
});

describe("a PR row: Review, or Merge when it is ready", () => {
  const h = homeOf([item("pr-review", "pr:o/name#5")]);
  const answer = (over: Partial<Extract<ReadyAnswer, { status: "ok" }>> = {}): ReadyAnswer => ({
    status: "ok", key: "o/name#5", number: 5, repo: "o/name", checkedAt: "2026-11-05T10:00:00Z", ready: true, reasons: [], checks: "3 checks passed", headRefOid: "1234567abc",
    noChecks: false, claims: { testRuns: 2, observed: 1, gaps: { high: 0, medium: 1, low: 1 }, mediumGaps: ["A medium gap. (#142)"] }, ...over,
  });
  const rowWith = (r: ReadyRead) => queueRows(h, { state: "ok", agents: [] }, r).rows[0]!;
  test("ready: a Merge row that goes to the PR's row on Work", () => {
    const r = rowWith({ state: "ok", answers: new Map([["o/name#5", answer()]]) });
    expect(r.kind).toBe("merge");
    expect(r.title).toBe("name PR #5 is ready to merge");
    // The hash names the head the verdict is about, so Work can refuse any other head.
    expect(r.action).toEqual({ type: "hash", label: "Merge…", hash: "#work?pr=5&repo=o%2Fname&head=1234567abc" });
    expect(r.note).toContain("head 1234567");
    // What the body says is worded as a claim, and an open medium gap is shown.
    expect(r.why).toContain("The PR body says 2 test runs exited 0 and 1 thing was seen working; its self-review lists 2 gaps (1 medium, 1 low).");
    expect(r.why).toContain("Open medium gaps: A medium gap. (#142).");
    expect(r.why).not.toMatch(/^[^.]*\. Tests pass/);
    expect(r.note).toContain("3 checks passed");
  });
  test("ready with no checks on GitHub says the tests rest on the PR body", () => {
    const r = rowWith({ state: "ok", answers: new Map([["o/name#5", answer({ noChecks: true, checks: "no checks" })]]) });
    expect(r.kind).toBe("merge");
    expect(r.note).toContain("no checks ran on GitHub, so tests rest only on the PR body");
  });
  test("not ready: Review on GitHub, saying why", () => {
    const r = rowWith({ state: "ok", answers: new Map([["o/name#5", answer({ ready: false, reasons: ["it is a draft"] })]]) });
    expect(r.kind).toBe("review");
    expect(r.action.type).toBe("link");
    expect(r.note).toBe("Not ready to merge: it is a draft.");
  });
  test("could not check: says so, never 'not ready'", () => {
    for (const rd of [
      { state: "ok", answers: new Map([["o/name#5", { status: "could-not-read", key: "o/name#5", reason: "HTTP 502" } as ReadyAnswer]]) },
      { state: "failed", reason: "GET /api/home/ready answered 500" },
    ] as ReadyRead[]) {
      const r = rowWith(rd);
      expect(r.kind).toBe("review");
      expect(r.note).toMatch(/^Could not check whether it is ready to merge: /);
      expect(r.note).not.toMatch(/Not ready/);
    }
  });
  test("not asked yet: checking", () => {
    expect(rowWith({ state: "loading" }).note).toBe("Checking whether it is ready to merge…");
    expect(rowWith(READY_NONE).note).toBe("Checking whether it is ready to merge…");
  });
  test("readiness is asked for the PR rows only", () => {
    expect(readyKeys(homeOf([item("agent-waiting", "agent:s1"), item("pr-review", "pr:o/n#5")]))).toEqual(["o/n#5"]);
    expect(readyKeys(null)).toEqual([]);
  });
});

// ── health ───────────────────────────────────────────────────────────────────────────────

function metric(id: HomeMetric["id"], over: Partial<HomeMetric>): HomeMetric {
  return { id, label: id, state: "ok", value: "0", note: "note", source: "src", ...over };
}
const project = (over: Partial<ProjectSummary> = {}): ProjectSummary => ({
  name: "stave", path: "/p", catalogueCounts: { hetvabhasa: 10, vyapti: 10 }, memoryCount: 0, fatalitySignals: 0, misalignedInvariants: 0, blindSpots: 0,
  groundingPercent: 51, groundTruthDocCount: 0, readStatus: { catalogues: { status: "ok", errors: [] }, memory: { status: "ok", errors: [] } }, ...over,
});

describe("the health line", () => {
  const good = [
    metric("new-breaks", { value: "0", asOf: "2026-11-05T13:19:36+05:30" }),
    metric("allowed-breaks", { value: "17", asOf: "2026-11-05T13:19:36+05:30" }),
    metric("notes", { state: "warn", value: "2,906 of 7,248", asOf: "2026-10-02" }),
    metric("sources", { value: "4 of 4" }),
    metric("child-reads", { value: "0" }),
  ];
  test("healthy with one thing to watch, each figure with its date", () => {
    const h = healthModel({ home: homeOf([], { metrics: good }), failed: false, project: project(), projectsReadAt: "2026-11-05T10:00:00Z" });
    expect(h.word).toBe("Healthy");
    expect(h.tail).toBe("· 1 thing to watch: 2,906 notes are out of date");
    const by = Object.fromEntries(h.rows.map((r) => [r.id, r]));
    expect(by.guards).toMatchObject({ value: "on", asOf: "commit of 2026-11-05" });
    expect(by["allowed-breaks"]).toMatchObject({ value: "17", asOf: "commit of 2026-11-05" });
    expect(by.notes).toMatchObject({ value: "2,906", of: "of 7,248", asOf: "snapshot of 2026-10-02", link: { hash: "#notes" } });
    expect(by.grounding).toMatchObject({ value: "51%", of: "of 20" });
    expect(by.grounding!.asOf).toContain("2026-11-05");
  });
  test("a structure guard that could not measure says could not read, never 0", () => {
    const m = [metric("new-breaks", { state: "unknown", value: "not measured" }), metric("allowed-breaks", { state: "unknown", value: "not measured" }), good[2]!, good[3]!];
    const h = healthModel({ home: homeOf([], { metrics: m }), failed: false, project: project(), projectsReadAt: null });
    const by = Object.fromEntries(h.rows.map((r) => [r.id, r]));
    expect(by["allowed-breaks"]!.value).toBe("could not read");
    expect(by.guards!.note).toContain("Structure guard: could not read");
    expect(by.guards!.state).toBe("unknown");
    expect(h.word).toBe("Could not check everything");
    for (const r of h.rows) if (r.state === "unknown") expect(r.value).not.toMatch(/^0/);
  });
  test("still measuring stays still measuring", () => {
    const m = [metric("allowed-breaks", { state: "unknown", value: "still measuring" })];
    const h = healthModel({ home: homeOf([], { metrics: m }), failed: false, project: null, projectsReadAt: null });
    expect(h.rows.find((r) => r.id === "allowed-breaks")!.value).toBe("still measuring");
  });
  test("missing metrics and unreadable notes say could not read", () => {
    const h = healthModel({ home: homeOf([], { metrics: [metric("notes", { state: "unknown", value: "could not read" })] }), failed: false, project: null, projectsReadAt: null });
    const by = Object.fromEntries(h.rows.map((r) => [r.id, r]));
    expect(by.notes!.value).toBe("could not read");
    expect(by["allowed-breaks"]!.value).toBe("could not read");
  });
  test("a new rule break needs attention", () => {
    const m = [metric("new-breaks", { state: "bad", value: "2" }), ...good.slice(1)];
    const h = healthModel({ home: homeOf([], { metrics: m }), failed: false, project: project(), projectsReadAt: null });
    expect(h.word).toBe("Needs attention");
    expect(h.tail).toContain("2 new rule breaks");
  });
  test("reads cut short (#257): 0 is said and fine; any is a thing to watch; absent is could not read, never 0", () => {
    const rowOf = (m: HomeMetric[]) => healthModel({ home: homeOf([], { metrics: m }), failed: false, project: project(), projectsReadAt: "2026-11-05T10:00:00Z" });
    const zero = rowOf(good);
    expect(zero.rows.find((r) => r.id === "child-reads")).toMatchObject({ label: "Reads cut short", value: "0", state: "ok" });
    expect(zero.tail).not.toContain("cut short");
    const two = rowOf([...good.slice(0, 4), metric("child-reads", { state: "warn", value: "2" })]);
    expect(two.rows.find((r) => r.id === "child-reads")).toMatchObject({ value: "2", state: "warn", watch: "2 reads cut short" });
    expect(two.tail).toBe("· 2 things to watch: 2,906 notes are out of date; 2 reads cut short");
    const old = rowOf(good.slice(0, 4));
    expect(old.rows.find((r) => r.id === "child-reads")).toMatchObject({ value: "could not read", state: "unknown", asOf: null });
    expect(old.word).toBe("Could not check everything");
  });
  test("Home not read: could not read health, not healthy", () => {
    expect(healthModel({ home: null, failed: true, project: null, projectsReadAt: null }).word).toBe("Could not read health");
    expect(healthModel({ home: null, failed: false, project: null, projectsReadAt: null }).word).toBe("Checking health…");
  });
  test("notes backed by source: unreadable, shared, empty and normal differ", () => {
    expect(groundingRow(project({ readStatus: { catalogues: { status: "unreadable", errors: ["EACCES"] }, memory: { status: "ok", errors: [] } } }), null).value).toBe("could not read");
    expect(groundingRow(project({ catalogueCounts: {} }), null).value).toBe("no notes");
    expect(groundingRow(project({ sharesNotesWith: "anvi" }), null).value).toBe("shared");
    expect(groundingRow(null, null).value).toBe("no project");
    expect(groundingRow(project({ groundingPercent: 0 }), null).value).toBe("0%");
  });
});

describe("the agents list", () => {
  test("host agents and terminal sessions, needs-you first", () => {
    const host: AgentsRead = { state: "ok", agents: [hostAgent("done1", [], "done"), hostAgent("w1", [ask("r", "2026-11-05T09:00:00Z")])] };
    const h = homeOf([], { agents: [{ sessionId: "s2", name: "n", project: "p", cwd: "/p", branch: "main", status: "busy", updatedAt: 0, openPrs: [3] }] });
    const a = agentRows(host, h, false);
    expect(a.heading).toBe("Agents · 3");
    expect(a.rows.map((r) => r.key)).toEqual(["host:w1", "term:s2", "host:done1"]);
    expect(a.rows[0]).toMatchObject({ needsYou: true, href: "/agent-host#w1" });
    expect(a.rows[1]!.href).toBe("#agents?project=p&sid=s2");
  });
  test("a source that could not be read is said, and the count is not a plain number", () => {
    const h = homeOf([], { sources: { sessions: { status: "could-not-read", label: "x", detail: "EACCES" }, prs: ok, structure: ok, notes: ok } });
    const a = agentRows({ state: "failed", reason: "502" }, h, false);
    expect(a.heading).toBe("Agents · 0 + ?");
    expect(a.unread.join(" ")).toMatch(/Could not read the agents AnviDeck started: 502/);
    expect(a.unread.join(" ")).toMatch(/Could not read the terminal sessions: EACCES/);
  });
});

// ── the dated figures, from the reader (#81) ─────────────────────────────────────────────

describe("the reader dates each health figure", () => {
  const src = { status: "ok" as const, label: "structure guard, 2 of 2 project(s) with a design measured", detail: "a: 0 new" };
  test("rule breaks carry the newest commit date measured", () => {
    expect(newestDate([null, "2026-11-01T10:00:00Z", undefined, "2026-11-05T13:19:36+05:30", "not a date", "2026-11-03"])).toBe("2026-11-05T13:19:36+05:30");
    expect(newestDate([null, undefined])).toBeNull();
    const ms = structureMetrics({ source: src, reading: false, newBreaks: 0, allowed: 17, measured: 2, measuredOf: "2026-11-05T13:19:36+05:30" });
    expect(ms.map((m) => [m.id, m.asOf])).toEqual([["new-breaks", "2026-11-05T13:19:36+05:30"], ["allowed-breaks", "2026-11-05T13:19:36+05:30"]]);
    expect(ms[1]!.source).toBe(`${src.label}: ${src.detail}`);
    const none = structureMetrics({ source: { status: "reading", label: "structure guard" }, reading: true, newBreaks: 0, allowed: 0, measured: 0, measuredOf: null });
    expect(none.map((m) => m.asOf)).toEqual([null, null]);
  });
  test("out-of-date notes carry the snapshot's date; no snapshot, no date", () => {
    const n = { file: "/h/health-2026-10-02.json", date: "2026-10-02", examined: 7248, red: 6, yellow: 2900, projects: 9, unmeasured: [] };
    const m = notesMetric({ value: n, source: { status: "ok", label: n.file } }, Date.parse("2026-11-05T00:00:00Z"));
    expect(m).toMatchObject({ id: "notes", value: "2,906 of 7,248", asOf: "2026-10-02" });
    expect(notesMetric({ value: null, source: { status: "none", label: "/h", detail: "no snapshot" } }, 0).asOf).toBeNull();
  });
  test("readHome builds its metrics through these, with the measured date", () => {
    const src = readFileSync("server/readers/home.ts", "utf8");
    expect(src).toContain("measuredOf = newestDate([measuredOf, r.measuredAt.date]);");
    expect(src).toContain("healthMetrics({ source: structureSource, reading: structureReading, newBreaks, allowed, measured, measuredOf }, notes, now)");
    expect(src).toContain("return [...structureMetrics(structure), notesMetric(notes, now), childReadsMetric()];");
  });
});

// ── repaints keep unchanged rows in place (an open card keeps focus) ─────────────────────

/** A parent that records every time a node already in it is taken out (which blurs it in a page). */
class FakeParent implements ParentLike<string> {
  nodes: string[];
  detached: string[] = [];
  constructor(nodes: string[]) {
    this.nodes = [...nodes];
  }
  get childNodes() {
    return this.nodes;
  }
  insertBefore(n: string, ref: string | null) {
    const at = this.nodes.indexOf(n);
    if (at !== -1) {
      this.detached.push(n);
      this.nodes.splice(at, 1);
    }
    const i = ref === null ? this.nodes.length : this.nodes.indexOf(ref);
    this.nodes.splice(i, 0, n);
  }
  removeChild(n: string) {
    this.detached.push(n);
    this.nodes.splice(this.nodes.indexOf(n), 1);
  }
}

describe("Home's queue is patched, not rebuilt", () => {
  test("a kept row is never taken out when rows around it come and go", () => {
    const p = new FakeParent(["note", "answer", "pr1", "pr2", "more"]);
    reconcile(p, ["answer", "pr1-ready", "pr2", "unread", "more"]);
    expect(p.nodes).toEqual(["answer", "pr1-ready", "pr2", "unread", "more"]);
    expect(p.detached.sort()).toEqual(["note", "pr1"]);
    expect(p.detached).not.toContain("answer");
  });
  test("a row is the same element while its model is the same", () => {
    const cache = new Map<string, { sig: string; el: { built: number } }>();
    let n = 0;
    const build = () => ({ built: ++n });
    const rows = (sig2: string) => [{ k: "ask:1", s: "a" }, { k: "pr:o/n#2", s: sig2 }];
    const first = keyedReuse(cache, rows("checking"), (r) => r.k, (r) => r.s, build);
    const second = keyedReuse(cache, rows("ready"), (r) => r.k, (r) => r.s, build);
    expect(second[0]).toBe(first[0]!);
    expect(second[1]).not.toBe(first[1]!);
    keyedReuse(cache, [{ k: "pr:o/n#2", s: "ready" }], (r) => r.k, (r) => r.s, build);
    expect([...cache.keys()]).toEqual(["pr:o/n#2"]);
  });
  test("HomeScreen repaints through these and the app patches Home in place", () => {
    const screen = readFileSync("ui/components/HomeScreen.ts", "utf8");
    expect(screen).toContain("reconcile(box, out);");
    const paintQueue = screen.slice(screen.indexOf("function paintQueue("), screen.indexOf("/** Open PRs you authored"));
    expect(paintQueue).toContain("reconcile(box, out);");
    expect(paintQueue).not.toContain("replaceChildren");
    expect(screen).toContain("keyedReuse(rowCache,");
    const app = readFileSync("ui/app.ts", "utf8");
    // The count change, the minute refresh and the switcher patch Home; none rebuilds it while shown.
    expect(app.match(/route\.screen === "home"[^\n]*renderMain\(\)/g) ?? []).toEqual([]);
    expect(app.match(/repaintHome\(\)/g)?.length).toBeGreaterThanOrEqual(3);
  });
});
