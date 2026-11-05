import { describe, expect, test } from "bun:test";
import {
  baseCheck,
  boardColumns,
  boardCoverage,
  canStartAgent,
  ciCheck,
  closingCheck,
  confirmLabel,
  focusedPr,
  itemRef,
  mergeBlocked,
  mergeChecks,
  mergeLabel,
  NO_STATUS,
  othersCheck,
  prSteps,
  refusalText,
} from "../ui/components/work-model";
import { parsePrSections, PR_SECTIONS_EXAMPLE } from "../shared/pr-evidence";
import type { BoardItem, PairResult, PrConflicts, PrFacts } from "../shared/work-types";

const HEAD = "0123456789abcdef0123456789abcdef01234567";

function pr(over: Partial<PrFacts> = {}): PrFacts {
  return {
    number: 12,
    title: "Work screen",
    url: "https://github.com/acme/widget/pull/12",
    isDraft: false,
    author: "me",
    updatedAt: "2026-11-05T10:00:00Z",
    headRefName: "feat/85-work",
    headRefOid: HEAD,
    baseRefName: "main",
    baseRefOid: "9999999999999999999999999999999999999999",
    mergeable: "MERGEABLE",
    commits: 3,
    closing: [{ number: 85, title: "Work", url: "https://github.com/acme/widget/issues/85", repo: "acme/widget", body: "## Problem\nNone of it exists.\n" }],
    partOf: [],
    ci: { rollup: "SUCCESS", contexts: [{ name: "test", state: "SUCCESS" }], total: 1 },
    sections: parsePrSections(PR_SECTIONS_EXAMPLE),
    reviews: [],
    ...over,
  };
}

const item = (over: Partial<BoardItem>): BoardItem => ({ id: "i", type: "Issue", number: 1, title: "t", url: null, repo: "acme/widget", status: "Todo", labels: [], linkedPrs: [], ...over });

describe("board", () => {
  test("columns follow the board's own order; every item lands in exactly one column", () => {
    const items = [item({ number: 1, status: "Done" }), item({ number: 2, status: "Todo" }), item({ number: 3, status: null }), item({ number: 4, status: "Archived?" }), item({ number: 5, status: "In Progress" })];
    const cols = boardColumns(["Todo", "In Progress", "Done"], items);
    expect(cols.map((c) => [c.name, c.items.map((i) => i.number)])).toEqual([
      ["Todo", [2]],
      ["In Progress", [5]],
      ["Done", [1]],
      [NO_STATUS, [3, 4]],
    ]);
    expect(cols.reduce((n, c) => n + c.items.length, 0)).toBe(items.length);
  });

  test("an empty column is still shown; no No Status column when every item has one", () => {
    const cols = boardColumns(["Todo", "In Progress", "Done"], [item({ status: "Todo" })]);
    expect(cols.map((c) => c.name)).toEqual(["Todo", "In Progress", "Done"]);
  });

  test("Start agent: only this repo's issues nobody has started (not In Progress, not Done)", () => {
    expect(canStartAgent(item({}), "acme/widget", "Todo")).toBe(true);
    expect(canStartAgent(item({ repo: "ACME/Widget" }), "acme/widget", "open")).toBe(true);
    expect(canStartAgent(item({}), "acme/widget", NO_STATUS)).toBe(true);
    expect(canStartAgent(item({}), "acme/widget", "In Progress")).toBe(false);
    expect(canStartAgent(item({}), "acme/widget", "Done")).toBe(false);
    expect(canStartAgent(item({ repo: "acme/other" }), "acme/widget", "Todo")).toBe(false);
    expect(canStartAgent(item({ type: "PullRequest" }), "acme/widget", "Todo")).toBe(false);
    expect(canStartAgent(item({ type: "DraftIssue", number: null }), "acme/widget", "Todo")).toBe(false);
  });

  test("an item from another repo names it; a draft says draft", () => {
    expect(itemRef(item({ number: 7 }), "acme/widget")).toBe("#7");
    expect(itemRef(item({ number: 2262, repo: "acme/stave" }), "acme/widget")).toBe("stave #2262");
    expect(itemRef(item({ number: null }), "acme/widget")).toBe("draft");
  });

  test("a partial read says how much was read", () => {
    expect(boardCoverage(373, 373)).toBe("373 items");
    expect(boardCoverage(100, 373)).toBe("100 of 373 items read (the rest are not shown)");
  });
});

describe("your workflow", () => {
  const states = (p: PrFacts) => Object.fromEntries(prSteps(p).map((s) => [s.key, s.state]));
  const now = (p: PrFacts) => prSteps(p).find((s) => s.now)?.key;

  test("a PR with everything recorded is done up to Merge (you), which is where it is now", () => {
    expect(states(pr())).toEqual({ friction: "done", issue: "done", branch: "done", fix: "done", test: "done", observe: "done", pr: "done", "self-review": "done", merge: "todo" });
    expect(now(pr())).toBe("merge");
    expect(prSteps(pr()).map((s) => s.label)).toEqual(["Friction", "Issue #85", "Branch", "Fix", "Test", "Observe", "PR", "Self-review", "Merge (you)"]);
  });

  test("no Evidence or Self-review in the body: Test, Observe and Self-review are missing, never done", () => {
    const p = pr({ sections: parsePrSections("Just a description.") });
    expect(states(p)).toMatchObject({ test: "missing", observe: "missing", "self-review": "missing" });
    expect(now(p)).toBe("test");
  });

  test("a test run with a non-zero exit fails the Test step, whatever its tally says", () => {
    const body = PR_SECTIONS_EXAMPLE.replace("| `bun test` | 0 | 152 pass, 0 fail |", "| `bun test` | 1 | 152 pass, 0 fail |");
    const p = pr({ sections: parsePrSections(body) });
    expect(states(p).test).toBe("failed");
    expect(prSteps(p).find((s) => s.key === "test")!.detail).toContain("bun test exit 1");
  });

  test("malformed Evidence is failed with the parser's reason", () => {
    const p = pr({ sections: parsePrSections("## Evidence\nsomething\n## Self-review\nNone found.") });
    expect(states(p)).toMatchObject({ test: "failed", observe: "failed", "self-review": "done" });
    expect(prSteps(p).find((s) => s.key === "test")!.detail).toContain("malformed");
  });

  test("no closing reference: Friction and Issue are missing", () => {
    const p = pr({ closing: [] });
    expect(states(p)).toMatchObject({ friction: "missing", issue: "missing" });
    expect(now(p)).toBe("friction");
  });

  test('"Part of #N" without a closing reference: the Issue step is done, the closing check still is not', () => {
    const p = pr({ closing: [], partOf: [81] });
    const issue = prSteps(p)[1]!;
    expect([issue.label, issue.state]).toEqual(["Issue #81", "done"]);
    expect(issue.detail).toContain("merging does not close it");
    expect(prSteps(p)[0]).toMatchObject({ state: "missing" });
    expect(prSteps(p)[0]!.detail).toContain('"Part of"');
    expect(closingCheck(p).state).toBe("bad");
  });

  test("an issue with an empty body records no friction; one with text does", () => {
    expect(states(pr({ closing: [{ ...pr().closing[0]!, body: "  " }] })).friction).toBe("missing");
    expect(prSteps(pr({ closing: [{ ...pr().closing[0]!, body: "It breaks when…" }] }))[0]!.detail).toBe("described in #85");
    expect(prSteps(pr())[0]!.detail).toBe('stated under "Problem" in #85');
  });

  test("another repo's issue is named with its repo", () => {
    const p = pr({ closing: [{ number: 9, title: "x", url: "", repo: "acme/other", body: "x" }] });
    expect(prSteps(p)[1]!.label).toBe("Issue acme/other#9");
  });

  test("a draft PR, no commits, a head that is the base", () => {
    expect(states(pr({ isDraft: true })).pr).toBe("missing");
    expect(states(pr({ commits: 0 })).fix).toBe("missing");
    expect(states(pr({ headRefName: "main" })).branch).toBe("missing");
  });

  test("exactly one step is now", () => {
    for (const p of [pr(), pr({ closing: [] }), pr({ isDraft: true }), pr({ sections: parsePrSections("") })]) {
      expect(prSteps(p).filter((s) => s.now).length).toBe(1);
    }
  });
});

describe("merge checks", () => {
  test("no checks on the head commit is 'no CI configured', not green", () => {
    expect(ciCheck({ rollup: null, contexts: [], total: 0 })).toMatchObject({ state: "none", text: "no CI configured" });
    expect(ciCheck({ rollup: "SUCCESS", contexts: [], total: 0 }).state).toBe("none");
  });

  test("green only when the rollup is SUCCESS and no context failed or runs", () => {
    expect(ciCheck({ rollup: "SUCCESS", contexts: [{ name: "a", state: "SUCCESS" }, { name: "b", state: "SKIPPED" }], total: 2 })).toMatchObject({ state: "ok", text: "CI green (2 checks)" });
    expect(ciCheck({ rollup: "FAILURE", contexts: [{ name: "lint", state: "SUCCESS" }, { name: "test", state: "FAILURE" }], total: 2 })).toMatchObject({ state: "bad", text: "CI failing: test" });
    expect(ciCheck({ rollup: "PENDING", contexts: [{ name: "test", state: "IN_PROGRESS" }], total: 1 }).state).toBe("pending");
    expect(ciCheck({ rollup: "ERROR", contexts: [], total: 3 }).state).toBe("bad");
  });

  test("a cut list of contexts says how many were read", () => {
    expect(ciCheck({ rollup: "SUCCESS", contexts: [{ name: "a", state: "SUCCESS" }], total: 150 }).detail).toContain("1 of 150 read");
  });

  test("closing reference parsed, or not", () => {
    expect(closingCheck(pr())).toMatchObject({ state: "ok", text: "closes #85 parsed" });
    expect(closingCheck(pr({ closing: [] }))).toMatchObject({ state: "bad", text: "no closing reference parsed" });
  });

  const checked = (base: PairResult, others: { number: number; result: PairResult }[] = []): PrConflicts => ({ state: "checked", base, others });

  test("the base: GitHub's CONFLICTING or merge-tree's conflict is bad; unchecked is never 'no conflict'", () => {
    expect(baseCheck(pr(), checked({ state: "clean" }), "main")).toMatchObject({ state: "ok", text: "no conflict with main" });
    expect(baseCheck(pr({ mergeable: "CONFLICTING" }), checked({ state: "clean" }), "main").state).toBe("bad");
    expect(baseCheck(pr(), checked({ state: "conflict", files: ["a.ts"] }), "main")).toMatchObject({ state: "bad", text: "conflicts with main: a.ts" });
    expect(baseCheck(pr(), checked({ state: "unchecked", reason: "x" }), "main").state).toBe("unknown");
    expect(baseCheck(pr(), { state: "unchecked", reason: "offline" }, "main")).toMatchObject({ state: "unknown", detail: "offline" });
  });

  test("a stacked PR is checked against its own base branch, not the default branch", () => {
    const stacked = { ...pr({ baseRefName: "feat/723-place" }), conflicts: checked({ state: "clean" }) };
    const base = mergeChecks(stacked).find((c) => c.key === "base")!;
    expect(base.text).toBe("no conflict with feat/723-place");
    expect(base.detail).toContain("feat/723-place's tip 9999999");
  });

  test("other open PRs: a conflict names the PR; any unchecked pair keeps it from reading clean", () => {
    expect(othersCheck(checked({ state: "clean" }, [{ number: 3, result: { state: "clean" } }, { number: 4, result: { state: "clean" } }]))).toMatchObject({ state: "ok", text: "no conflict with 2 open PRs" });
    expect(othersCheck(checked({ state: "clean" }, [{ number: 3, result: { state: "conflict", files: ["x"] } }]))).toMatchObject({ state: "bad", text: "conflicts with #3" });
    expect(othersCheck(checked({ state: "clean" }, [{ number: 3, result: { state: "clean" } }, { number: 4, result: { state: "unchecked", reason: "r" } }]))).toMatchObject({ state: "unknown", text: "1 of 2 open PRs not checked" });
    expect(othersCheck({ state: "unchecked", reason: "fetch failed" }).state).toBe("unknown");
    expect(othersCheck(checked({ state: "clean" }, [])).text).toBe("no other open PRs");
  });
});

describe("merge", () => {
  test("the button and its confirmation name the exact commit", () => {
    expect(mergeLabel(HEAD)).toBe("Merge 0123456");
    expect(confirmLabel(pr())).toBe("Squash-merge #12 at 0123456 into main");
  });

  test("a draft, or a head that is not a full commit, is not offered", () => {
    expect(mergeBlocked(pr())).toBeNull();
    expect(mergeBlocked(pr({ isDraft: true }))).toContain("draft");
    expect(mergeBlocked(pr({ headRefOid: "abc" }))).toContain("could not be read");
  });

  test("a head-moved refusal names both commits; a guard refusal says it was the guard", () => {
    const t = refusalText(409, { error: "x", refusal: "head-moved", reviewedHead: HEAD, currentHead: "fedcba9876543210fedcba9876543210fedcba98" });
    expect(t).toContain("you reviewed 0123456, it is now fedcba9");
    expect(t).toContain("nothing merged");
    expect(refusalText(403, { error: "no token" })).toBe("Refused by the write guard: no token");
    expect(refusalText(502, { error: "offline" })).toBe("Not done: offline");
  });

  test("#work?pr=N focuses one PR", () => {
    expect(focusedPr(new URLSearchParams("pr=12"))).toBe(12);
    expect(focusedPr(new URLSearchParams("pr=x"))).toBeNull();
    expect(focusedPr(new URLSearchParams(""))).toBeNull();
  });
});
