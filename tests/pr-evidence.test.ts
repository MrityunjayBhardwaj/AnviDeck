import { describe, test, expect } from "bun:test";
import { parsePrSections, PR_SECTIONS_EXAMPLE, PR_SECTIONS_INSTRUCTIONS, type SectionState } from "../shared/pr-evidence";
import prEvidence from "../server/routes/pr-evidence";

/** Controls for issue #83: the PR-body Evidence and Self-review sections. */

const EVIDENCE = `## Evidence

### Tests
| Command | Exit | Result |
|---|---|---|
| \`bun test\` | 1 | 151 pass, 1 fail |

### Observed
- Saw X1 on the live page.

### Not checked
None.
`;

const SELF_REVIEW = `## Self-review

| Severity | Gap | Issue |
|---|---|---|
| high | Gap one. | #7 |
`;

const body = (...parts: string[]) => ["## Problem\nSomething.\n", ...parts, "Closes #1\n"].join("\n");

function reason<T>(s: SectionState<T>): string {
  if (s.status !== "malformed") throw new Error(`expected malformed, got ${JSON.stringify(s)}`);
  return s.reason;
}

describe("must parse", () => {
  test("the example given to agents parses fully, and is in the instructions verbatim", () => {
    expect(PR_SECTIONS_INSTRUCTIONS).toContain(PR_SECTIONS_EXAMPLE);
    const r = parsePrSections(body(PR_SECTIONS_EXAMPLE));
    expect(r.evidence).toEqual({
      status: "recorded",
      value: {
        tests: [
          { command: "bun test", exitCode: 0, result: "152 pass, 0 fail" },
          { command: "bunx tsc --noEmit -p .", exitCode: 0, result: "no errors" },
        ],
        observed: [
          "Started the server on port 4476 and opened the Changes screen in headless Chrome: PR #12 shows 2 test runs and 3 observations.",
          "Ran the parser over 27 merged PRs on 2026-11-05: 0 recorded, 27 not recorded, 0 malformed.",
        ],
        notChecked: ["Behaviour on a PR body longer than 65,536 characters."],
      },
    });
    expect(r.selfReview).toEqual({
      status: "recorded",
      value: {
        gaps: [
          { severity: "medium", gap: 'A near-miss heading such as "Self review" reads as not recorded.', issue: { repo: null, number: 101 } },
          { severity: "low", gap: "Severity words other than high, medium, low are refused rather than mapped.", issue: null },
        ],
      },
    });
  });

  test("exit status is kept apart from the tally: a non-zero exit with a passing-looking tally stays non-zero", () => {
    const r = parsePrSections(body(EVIDENCE));
    if (r.evidence.status !== "recorded") throw new Error(JSON.stringify(r.evidence));
    expect(r.evidence.value.tests).toEqual([{ command: "bun test", exitCode: 1, result: "151 pass, 1 fail" }]);
  });

  test('"None." under Not checked is an explicit empty list', () => {
    const r = parsePrSections(body(EVIDENCE));
    expect(r.evidence.status === "recorded" && r.evidence.value.notChecked).toEqual([]);
  });

  test('"None found." is a recorded self-review with no gaps', () => {
    expect(parsePrSections(body("## Self-review\n\nNone found.\n")).selfReview).toEqual({ status: "recorded", value: { gaps: [] } });
  });

  test("CRLF bodies, any part order, case-insensitive headings, continuation lines, escaped pipes, issue URL and cross-repo refs", () => {
    const md = [
      "## EVIDENCE ##",
      "### not checked",
      "- Item A",
      "  continued here.",
      "### Observed",
      "* Saw `a \\| b`.",
      "### Tests",
      "| command | exit | result |",
      "|:---|---:|---|",
      "| `grep a \\| wc -l` | 0 | 3 |",
      "## Self-Review",
      "| Severity | Gap | Issue |",
      "| --- | --- | --- |",
      "| HIGH | G1 | https://github.com/o/r/issues/12 |",
      "| low | G2 | o/r#3 |",
    ].join("\r\n");
    const r = parsePrSections(md);
    expect(r.evidence).toEqual({
      status: "recorded",
      value: {
        tests: [{ command: "grep a | wc -l", exitCode: 0, result: "3" }],
        observed: ["Saw `a \\| b`."],
        notChecked: ["Item A\ncontinued here."],
      },
    });
    expect(r.selfReview).toEqual({
      status: "recorded",
      value: {
        gaps: [
          { severity: "high", gap: "G1", issue: { repo: "o/r", number: 12 } },
          { severity: "low", gap: "G2", issue: { repo: "o/r", number: 3 } },
        ],
      },
    });
  });

  test("a section ends at the next level-2 heading, so a later section is not swallowed", () => {
    const r = parsePrSections(EVIDENCE + "\n## Notes\nfree prose here\n\n" + SELF_REVIEW);
    expect(r.evidence.status).toBe("recorded");
    expect(r.selfReview.status).toBe("recorded");
  });

  test('closing lines after the sections ("Closes #1, fixes o/r#2") are not part of them', () => {
    const r = parsePrSections(EVIDENCE + "\nCloses #1, fixes o/r#2\n\n" + SELF_REVIEW + "\nResolves: #3\n");
    expect(r.evidence.status).toBe("recorded");
    expect(r.selfReview.status).toBe("recorded");
  });

  test("headings inside fenced code are not sections", () => {
    const md = "## Fix\n```md\n## Evidence\n## Self-review\n```\n" + SELF_REVIEW;
    const r = parsePrSections(md);
    expect(r.evidence).toEqual({ status: "not recorded" });
    expect(r.selfReview.status).toBe("recorded");
  });
});

describe("not recorded", () => {
  test("a body without the sections, an empty body and a null body", () => {
    for (const b of ["## Problem\nx\n## Fix\ny\n## Verified\n- bun test: 140 pass\n", "", null, undefined]) {
      expect(parsePrSections(b)).toEqual({ evidence: { status: "not recorded" }, selfReview: { status: "not recorded" } });
    }
  });

  test('"## Self-review follow-ups" and "### Evidence" are different headings, not the sections', () => {
    const r = parsePrSections("## Self-review follow-ups\n- a\n## Fix\n### Evidence\n- b\n");
    expect(r).toEqual({ evidence: { status: "not recorded" }, selfReview: { status: "not recorded" } });
  });
});

describe("must not parse (malformed, with the reason)", () => {
  const ev = (s: string) => reason(parsePrSections(s).evidence);
  const sr = (s: string) => reason(parsePrSections(s).selfReview);

  test("evidence written as prose", () => {
    expect(ev("## Evidence\nbun test passed, 140 tests.\n")).toContain("found \"bun test passed");
  });
  test("a missing part", () => {
    expect(ev(EVIDENCE.replace("### Not checked\nNone.\n", ""))).toContain('missing "### Not checked"');
  });
  test("an unknown part", () => {
    expect(ev(EVIDENCE + "### Screenshots\n- x\n")).toContain('unknown part "### Screenshots"');
  });
  test("a part written twice", () => {
    expect(ev(EVIDENCE + "### Observed\n- again\n")).toContain('"### Observed" twice');
  });
  test("a deeper heading inside Evidence", () => {
    expect(ev(EVIDENCE + "#### Sub\n")).toContain("level-4 heading");
  });
  test("two Evidence sections", () => {
    expect(ev(EVIDENCE + "\n" + EVIDENCE)).toContain('2 "## Evidence" sections');
  });
  test("Exit not a whole number: a word, a tally, empty, negative", () => {
    for (const exit of ["passed", "140/140", "", "-1", "0.5"]) {
      expect(ev(EVIDENCE.replace("| 1 |", `| ${exit} |`))).toContain("Exit for \"bun test\"");
    }
  });
  test("wrong Tests header and a missing separator row", () => {
    expect(ev(EVIDENCE.replace("| Command | Exit | Result |", "| Command | Status | Result |"))).toContain("must start with the table header");
    expect(ev(EVIDENCE.replace("|---|---|---|\n", ""))).toContain("separator row");
  });
  test("a Tests table with a header but no rows, and a row with too few cells", () => {
    expect(ev(EVIDENCE.replace("| `bun test` | 1 | 151 pass, 1 fail |\n", ""))).toContain("no rows");
    expect(ev(EVIDENCE.replace("| `bun test` | 1 | 151 pass, 1 fail |", "| `bun test` | 1 |"))).toContain("has 2 cells");
  });
  test("an empty Command or Result", () => {
    expect(ev(EVIDENCE.replace("| `bun test` | 1 |", "|  | 1 |"))).toContain("empty Command");
    expect(ev(EVIDENCE.replace("| 151 pass, 1 fail |", "|  |"))).toContain("Result for");
  });
  test("an unpiped pipe splits a cell, so the row no longer fits", () => {
    expect(ev(EVIDENCE.replace("`bun test`", "`grep a | wc`"))).toContain("has 4 cells");
  });
  test("prose line inside a list, empty Observed, empty Not checked", () => {
    expect(ev(EVIDENCE.replace("- Saw X1 on the live page.", "Saw X1."))).toContain('"Saw X1." is not a "- " bullet');
    expect(ev(EVIDENCE.replace("- Saw X1 on the live page.\n", ""))).toContain("Evidence / Observed has no bullets");
    expect(ev(EVIDENCE.replace("None.\n", ""))).toContain('write "None." if there is nothing');
  });
  test('"None." is not accepted under Observed', () => {
    expect(ev(EVIDENCE.replace("- Saw X1 on the live page.", "None."))).toContain("is not a");
  });
  test("an empty bullet", () => {
    expect(ev(EVIDENCE.replace("- Saw X1 on the live page.", "- Saw X1.\n- "))).toContain("empty bullet");
  });
  test("self-review written as prose, empty, or with a bad severity / issue / gap", () => {
    expect(sr("## Self-review\nLooked fine to me.\n")).toContain('or the single line "None found."');
    expect(sr("## Self-review\n")).toContain("is empty");
    expect(sr(SELF_REVIEW.replace("| high |", "| critical |"))).toContain('severity "critical"');
    expect(sr(SELF_REVIEW.replace("| #7 |", "| filed |"))).toContain('Issue "filed"');
    expect(sr(SELF_REVIEW.replace("| #7 |", "| |"))).toContain('Issue ""');
    expect(sr(SELF_REVIEW.replace("| Gap one. |", "|  |"))).toContain("empty Gap");
  });
  test("a line that only mentions closing is still prose, not a dropped closing line", () => {
    expect(sr(SELF_REVIEW + "Closes the gap later.\n")).toContain('"Closes the gap later." is not a table row');
    expect(sr(SELF_REVIEW + "Closes #7 tomorrow\n")).toContain("is not a table row");
  });
  test("one section malformed does not hide the other", () => {
    const r = parsePrSections("## Evidence\nprose\n" + SELF_REVIEW);
    expect(r.evidence.status).toBe("malformed");
    expect(r.selfReview.status).toBe("recorded");
  });
});

describe("route /api/pr-evidence", () => {
  test("GET /format returns the instruction text and its example", async () => {
    const res = await prEvidence.request("/format");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ instructions: PR_SECTIONS_INSTRUCTIONS, example: PR_SECTIONS_EXAMPLE });
  });
  test("GET /pr/:number refuses a bad number or repo before asking GitHub", async () => {
    expect((await prEvidence.request("/pr/abc?repo=o/r")).status).toBe(400);
    expect((await prEvidence.request("/pr/1")).status).toBe(400);
    expect((await prEvidence.request("/pr/1?repo=o/r;rm")).status).toBe(400);
  });
});
