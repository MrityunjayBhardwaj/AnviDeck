// The agent's own words per tool step (#48): taken from the transcript, from the same turn,
// with the line that holds them. Synthetic records pin the rule; the stave control pins the
// issue's Done-when on the real transcript (skipped, saying so, when it is not on this machine).
import { describe, expect, test } from "bun:test";
import { findTranscript, readReplay, wordsForToolUse, WORDS_MAX } from "../server/readers/replay";

const asst = (id: string | undefined, content: unknown[]) => ({ type: "assistant", timestamp: "2026-10-30T09:26:17.000Z", message: { id, content } });
const tool = (id: string, input: Record<string, unknown> = {}) => ({ type: "tool_use", id, name: "Bash", input: { command: "ls", ...input } });

describe("wordsForToolUse: the rule", () => {
  test("text and thinking of the same turn, split over records, with their own lines", () => {
    const recs = [
      { type: "user", message: { content: "go" } },
      asst("m1", [{ type: "text", text: "First I check the tests." }]),
      { type: "attachment", attachment: { type: "hook_additional_context" } },
      asst("m1", [{ type: "thinking", thinking: "Baseline looks good.", signature: "x" }]),
      asst("m1", [tool("t1", { description: "Run the tests" })]),
    ];
    const r = wordsForToolUse(recs, 4, 0);
    expect(r.words).toEqual([
      { source: "transcript", kind: "text", text: "First I check the tests.", line: 2 },
      { source: "transcript", kind: "thinking", text: "Baseline looks good.", line: 4 },
      { source: "transcript", kind: "description", text: "Run the tests", line: 5 },
    ]);
    expect(r.hidden).toBe(0);
  });

  test("must not take another turn's words, nor words across the user's message", () => {
    const recs = [
      asst("m0", [{ type: "text", text: "Words of an earlier turn." }]),
      { type: "user", message: { content: [{ type: "tool_result" }] } },
      asst("m1", [tool("t1")]),
    ];
    expect(wordsForToolUse(recs, 2, 0).words).toEqual([]);
    const recs2 = [asst("m0", [{ type: "text", text: "Other turn, no user record between." }]), asst("m1", [tool("t1")])];
    expect(wordsForToolUse(recs2, 1, 0).words).toEqual([]);
  });

  test("a later call of the same turn gets only the words after the previous call", () => {
    const recs = [asst("m1", [{ type: "text", text: "A" }, tool("t1"), { type: "text", text: "B" }, tool("t2")])];
    expect(wordsForToolUse(recs, 0, 1).words.map((w) => w.text)).toEqual(["A"]);
    expect(wordsForToolUse(recs, 0, 3).words.map((w) => w.text)).toEqual(["B"]);
  });

  test("calls made back to back share the words before the first of them", () => {
    const recs = [asst("m1", [{ type: "text", text: "Reading both." }]), asst("m1", [tool("t1")]), asst("m1", [tool("t2")])];
    expect(wordsForToolUse(recs, 2, 0).words.map((w) => w.text)).toEqual(["Reading both."]);
  });

  test("thinking kept without its text is counted as hidden, not shown as words", () => {
    const recs = [asst("m1", [{ type: "thinking", thinking: "", signature: "sig" }]), asst("m1", [tool("t1")])];
    const r = wordsForToolUse(recs, 1, 0);
    expect(r.words).toEqual([]);
    expect(r.hidden).toBe(1);
  });

  test("a record with no message id falls back to the record just before", () => {
    const recs = [asst(undefined, [{ type: "text", text: "Before." }]), asst(undefined, [tool("t1")])];
    expect(wordsForToolUse(recs, 1, 0).words).toEqual([{ source: "transcript", kind: "text", text: "Before.", line: 1 }]);
  });

  test("long words are cut and say how long they were", () => {
    const long = "x".repeat(WORDS_MAX + 10);
    const w = wordsForToolUse([asst("m1", [{ type: "text", text: long }, tool("t1")])], 0, 1).words[0];
    expect(w.text.length).toBe(WORDS_MAX);
    expect(w.truncated).toBe(true);
    expect(w.length).toBe(WORDS_MAX + 10);
  });
});

const CONTROL_SID = "811b15d0-2d6e-4ef9-8a42-cb524fe22131";
const controlPath = findTranscript(CONTROL_SID);
if (!controlPath) console.warn(`SKIP words control: transcript ${CONTROL_SID}.jsonl not found under ~/.claude/projects`);

describe.skipIf(!controlPath)("stave 811b15d0, 2026-10-30 00:00–12:00 UTC: the git mv step at 09:26:22 (#48 Done-when)", () => {
  test("carries the agent's words from the transcript, with their lines", async () => {
    const r = await readReplay(CONTROL_SID, { from: "2026-10-30T00:00:00Z", to: "2026-10-30T12:00:00Z", github: false });
    const s = r.steps.find((x) => x.kind === "tool" && x.ts?.startsWith("2026-10-30T09:26:22"))!;
    expect(s.command).toContain("git mv engine/noteToMidi.ts");
    expect(s.line).toBe(7394);
    expect(s.words).toEqual([
      {
        source: "transcript",
        kind: "thinking",
        text: "Baseline looks good: 375 editor test files (5,967 tests) and 168 app test files (2,151 tests) all pass. Now I'll make the move as specified, routing every engine and visualizer import through the barrel.",
        line: 7393,
      },
      { source: "transcript", kind: "description", text: "Move noteToMidi into notation and rewire imports through the barrel", line: 7394 },
    ]);
    expect(s.wordsHidden).toBe(1); // line 7392: thinking recorded with no text
    // Every tool step says what the transcript holds: a list, never missing.
    expect(r.steps.filter((x) => x.kind === "tool" && !Array.isArray(x.words)).length).toBe(0);
  }, 60_000);
});
