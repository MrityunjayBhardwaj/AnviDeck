import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  batchLabel,
  batches,
  citations,
  countGap,
  currencyCaveat,
  currencyHeadline,
  folderOf,
  freshnessText,
  headerCounts,
  oldestStillUsed,
  outOfDate,
  promotePrompt,
  recheckPrompt,
  recurrenceHint,
  routingMatrix,
  sectionsText,
  seriesPoints,
  subsystemOf,
  usageWindow,
  verdicts,
} from "../ui/components/notes-model";
import { currencyFromRun } from "../server/readers/notes";
import { parseRoutingTable } from "../server/readers/routing";
import type { CurrencyAnswer, CurrencyEntry, GtCheckAnswer, UsageAnswer } from "../shared/notes-types";
import type { CatalogueEntry } from "../shared/types";

const v = (o: Partial<CurrencyEntry> & { id: string }): CurrencyEntry => ({
  catalogue: "hetvabhasa", status: "YELLOW", state: "drifted", drifted: [], gone: null, anchor: "VALIDATED", ...o,
});
const ok = (entries: CurrencyEntry[], over: Partial<CurrencyAnswer> = {}): CurrencyAnswer => {
  const counts = { GREEN: 0, YELLOW: 0, RED: 0, GRAY: 0, REFERENCE: 0, WITHHELD: 0 };
  for (const e of entries) counts[e.status as keyof typeof counts]++;
  return { project: "p", path: "/p", command: "node currency-report.js --json /p", startedAt: "2026-11-05T10:00:00Z", ranAt: "2026-11-05T10:01:00Z", state: "ok", examined: entries.length, counts, entries, ...over };
};
const entry = (id: string, over: Partial<CatalogueEntry> = {}): CatalogueEntry => ({ id, title: `title ${id}`, sections: {}, tags: [], grounded: false, ...over });

/** anvi's own output for AnviDeck on 2026-11-05, captured from the shipped command. */
const REAL = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "notes", "currency-report-anvideck-2026-11-05.json"), "utf8"));
const realAnswer = () => currencyFromRun({ project: "AnviDeck", path: "/x", command: "c", startedAt: null }, { code: 0, stdout: JSON.stringify(REAL), stderr: "", timedOut: false }, "2026-11-05T11:22:08Z");

describe("out of date, as anvi's report counts it", () => {
  test("is 🟡 + 🔴 of the entries the report examined: 7 of 30 on AnviDeck, as its summary line printed", () => {
    // `node currency-report.js /Users/…/AnviDeck` printed, 2026-11-05:
    // "── 30 entries: 🟢 5 fresh  🟡 7 drifted  🔴 0 dangling  🔵 0 reference-grounded  ⚪ 18 unknown"
    expect(outOfDate(realAnswer())).toEqual({ n: 7, of: 30, yellow: 7, red: 0 });
    expect([...verdicts(realAnswer()).values()].filter((x) => x.status === "YELLOW" || x.status === "RED").length).toBe(7);
  });

  test("counts a dangling (🔴) entry as out of date", () => {
    expect(outOfDate(ok([v({ id: "A", status: "RED" }), v({ id: "B", status: "GREEN", state: "verified" })]))).toEqual({ n: 1, of: 2, yellow: 0, red: 1 });
  });

  test("is unknown, never zero, while measuring or when the report could not answer", () => {
    expect(outOfDate(null)).toBeNull();
    expect(outOfDate(ok([], { state: "measuring", examined: undefined, counts: undefined }))).toBeNull();
    expect(outOfDate(ok([], { state: "unreadable" }))).toBeNull();
    expect(freshnessText(ok([], { state: "unreadable" }), undefined)).toBe("currency: could not read");
    expect(freshnessText(ok([], { state: "measuring" }), undefined)).toBe("currency: measuring");
    expect(freshnessText(ok([]), undefined)).toBe("not in anvi's report");
  });

  test("a run over part of the evidence says so beside its count; a complete one says nothing extra", () => {
    // AnviDeck's real run looked everywhere: no caveat.
    expect(currencyCaveat(realAnswer())).toBeNull();
    expect(currencyHeadline(realAnswer())).toBe("7 of 30 out of date");
    // The report's own JSON when ref and investigations were refused (partial:2, withheld_kinds, one WITHHELD row).
    const held = currencyFromRun({ project: "p", path: "/p", command: "c", startedAt: null }, {
      code: 0, stderr: "", timedOut: false,
      stdout: JSON.stringify({ ...REAL, partial: 2, withheld_kinds: ["ref", "investigations"], counts: { ...REAL.counts, GRAY: 17, WITHHELD: 1 } }),
    }, "t");
    const cav = currencyCaveat(held)!;
    expect(cav).toContain("reference areas withheld, not read: ref, investigations");
    expect(cav).toContain("2 verdicts partial");
    expect(cav).toContain("1 entry withheld (not graded)");
    expect(currencyHeadline(held)).toBe(`7 of 30 out of date (${cav})`);
    // Each alone is enough to say so.
    expect(currencyCaveat(ok([], { partial: 1 }))).toContain("1 verdict partial");
    expect(currencyCaveat(ok([], { withheldKinds: ["ref"] }))).toContain("ref");
    expect(currencyCaveat(ok([v({ id: "W", status: "WITHHELD" })]))).toContain("1 entry withheld");
  });

  test("an entry graded with a withheld area set aside reads as partial", () => {
    expect(freshnessText(ok([]), v({ id: "A", partial: true }))).toBe("drifted · partial (a withheld area was set aside)");
    expect(freshnessText(ok([]), v({ id: "A", status: "RED", partial: true }))).toBe("dangling · partial (a withheld area was set aside)");
    expect(freshnessText(ok([]), v({ id: "A" }))).toBe("drifted");
  });

  test("the header tells a refusal from a failure", () => {
    expect(currencyHeadline(ok([], { state: "withheld" }))).toBe("currency: withheld (the report refused to read the catalogues)");
    expect(currencyHeadline(ok([], { state: "unreadable" }))).toBe("currency: could not read");
    expect(currencyHeadline(ok([], { state: "none" }))).toBe("currency: no catalogues");
    expect(currencyHeadline(null)).toBeNull();
  });

  test("an entry anvi never confirmed but counts as 🟡 says it is out of date", () => {
    const c = ok([v({ id: "A", state: "never confirmed" })]);
    expect(freshnessText(c, c.entries![0])).toBe("never confirmed · out of date");
    expect(freshnessText(c, v({ id: "B" }))).toBe("drifted");
    expect(freshnessText(c, v({ id: "C", status: "RED", state: "drifted" }))).toBe("dangling");
    expect(freshnessText(c, v({ id: "D", status: "GREEN", state: "verified" }))).toBe("verified");
  });

  test("a catalogue whose list differs from anvi's count names the IDs it does not list", () => {
    const c = realAnswer();
    const listed = ["AH1", "AH2", "AH3", "AH4", "AH5", "AH6", "AH7"].map((id) => entry(id));
    expect(countGap("hetvabhasa", listed, c)).toEqual({ anvi: 13, missing: ["U1", "U2", "U3", "U4", "U5", "U6"] });
    expect(countGap("hetvabhasa", listed, null)).toBeNull();
  });
});

describe("Re-check a batch, by subsystem", () => {
  test("a file's subsystem is its folder, two levels at most", () => {
    expect(folderOf("server/readers/notes.ts")).toBe("server/readers");
    expect(folderOf("ui/components/x/y.ts")).toBe("ui/components");
    expect(folderOf("hooks/currency.js")).toBe("hooks");
    expect(folderOf("install.sh")).toBe("(top level)");
  });

  test("an entry goes with the folder most of its changed or gone files are in", () => {
    expect(subsystemOf(v({ id: "A", drifted: ["hooks/a.js", "hooks/b.js", "scripts/c.js"] }))).toBe("hooks");
    expect(subsystemOf(v({ id: "B", drifted: ["install.sh"], gone: ["hooks/x.js", "hooks/y.js"] }))).toBe("hooks");
    expect(subsystemOf(v({ id: "C", drifted: ["b/x", "a/y"] }))).toBe("a"); // tie: alphabetical
    expect(subsystemOf(v({ id: "D", state: "never confirmed" }))).toBe("(no file named)");
  });

  test("batches hold only out-of-date entries, largest first", () => {
    const c = ok([
      v({ id: "H1", drifted: ["hooks/a.js"] }),
      v({ id: "H2", drifted: ["hooks/b.js"] }),
      v({ id: "H3", status: "RED", drifted: [], gone: ["scripts/x.js"] }),
      v({ id: "H4", status: "GREEN", state: "verified", drifted: ["hooks/c.js"] }),
      v({ id: "H5", status: "GRAY", state: "not checked", drifted: [] }),
    ]);
    const b = batches(c);
    expect(b.map((x) => [x.subsystem, x.entries.map((e) => e.id)])).toEqual([["hooks", ["H1", "H2"]], ["scripts", ["H3"]]]);
    expect(batchLabel(b[0]!)).toBe("Re-check 2 out-of-date notes about hooks");
    expect(batchLabel(b[1]!)).toBe("Re-check 1 out-of-date note about scripts");
    expect(batches(ok([], { state: "unreadable" }))).toEqual([]);
  });

  test("a subsystem larger than one agent's batch is split into numbered parts, every entry in exactly one", () => {
    const c = ok(Array.from({ length: 7 }, (_, i) => v({ id: `H${i + 1}`, drifted: ["hooks/a.js"] })).concat([v({ id: "S1", drifted: ["scripts/x.js"] })]));
    const b = batches(c, 3);
    expect(b.map((x) => [x.subsystem, x.entries.map((e) => e.id).join(",")])).toEqual([
      ["hooks, part 1 of 3", "H1,H2,H3"],
      ["hooks, part 2 of 3", "H4,H5,H6"],
      ["hooks, part 3 of 3", "H7"],
      ["scripts", "S1"],
    ]);
    expect(batchLabel(b[0]!)).toBe("Re-check 3 out-of-date notes about hooks, part 1 of 3");
    expect(batches(c).length).toBe(2); // the default cap (25) keeps both whole
  });

  test("the prompt names every entry of the batch, why it is out of date, the counter, and that nothing is merged", () => {
    const c = ok([v({ id: "H1", drifted: ["hooks/a.js"] }), v({ id: "V2", catalogue: "vyapti", status: "RED", gone: ["hooks/gone.js"] })]);
    const [b] = batches(c);
    const p = recheckPrompt("anvi", b!, c);
    expect(p).toContain("Re-check 2 out-of-date catalogue entries of anvi, about hooks.");
    expect(p).toContain("- H1 (hetvabhasa.md): changed since last checked: hooks/a.js");
    expect(p).toContain("- V2 (vyapti.md): gone: hooks/gone.js");
    expect(p).toContain("node currency-report.js --json /p, run 2026-11-05T10:01:00Z");
    expect(p).toContain("Change only these entries. Do not merge anything.");
    // No entry outside the batch is named.
    expect(recheckPrompt("anvi", { subsystem: "hooks", entries: [c.entries![0]!] }, c)).not.toContain("V2");
  });
});

describe("Memory, with Promote", () => {
  const m = { name: "Worktree links", description: "anvi links in worktrees", filePath: "/home/me/.claude/projects/x/memory/worktree-anvi-links.md", content: "First seen 10-20. Recurred on 10-28 in a second worktree." };

  test("the prompt names the note, its path, the promotion rule, and that the note is not edited", () => {
    const p = promotePrompt("stave", m);
    expect(p).toContain("worktree-anvi-links.md of stave");
    expect(p).toContain(`Read ${m.filePath}.`);
    expect(p).toContain("ORIGIN, WHY, HOW and REF");
    expect(p).toContain("If it has not recurred, change nothing");
    expect(p).toContain("Do not edit or delete the memory note.");
  });

  test("a line that mentions a recurrence is quoted; a note without one has no hint", () => {
    expect(recurrenceHint(m)).toBe("Recurred on 10-28 in a second worktree");
    expect(recurrenceHint({ description: "user profile", content: "Systems thinker." })).toBeNull();
    expect(recurrenceHint({ description: "", content: "Fine. The same trap was seen again on 10-30" })).toBe("The same trap was seen again on 10-30");
    expect(recurrenceHint({ description: "", content: "Suite 135/135 twice (runner exit 0)" })).toBeNull();
  });
});

describe("Grounding", () => {
  test("an entry cites a Ground Truth doc by its whole name, once per entry", () => {
    const docs = [{ system: "GIT" }, { system: "GIT_PLUMBING" }];
    const es = [
      entry("H1", { ref: "`ref/GROUND_TRUTH_GIT_PLUMBING.md` §2", grounded: true }),
      entry("H2", { ref: "ref/GROUND_TRUTH_GIT.md and again GROUND_TRUTH_GIT.md", grounded: true }),
      entry("H3", { sections: { FIX: "see ground_truth_git_plumbing.md §4" } }),
    ];
    expect(Object.fromEntries(citations(docs, es))).toEqual({ GIT: 1, GIT_PLUMBING: 2 });
  });

  test("sections traced come from anvi's citation check, and say 'not measured' rather than 0 when it could not look", () => {
    const check = (over: Partial<GtCheckAnswer> = {}): GtCheckAnswer => ({
      state: "ok", command: "c", refDir: "/r", ranAt: "t",
      docs: [{ doc: "/r/GROUND_TRUTH_GIT.md", system: "GIT", sections: 10, cited: 8, uncitable: 2, missing: 0, citations: 16 }], ...over,
    });
    expect(sectionsText(check(), "GIT")).toBe("8 of 10 cite code (2 say why not)");
    expect(sectionsText(check({ state: "missing", docs: [{ doc: "", system: "GIT", sections: 3, cited: 1, uncitable: 0, missing: 2, citations: 1 }] }), "GIT")).toBe("1 of 3 cite code (2 missing)");
    expect(sectionsText(check(), "OTHER")).toBe("not measured");
    expect(sectionsText(check({ state: "not-measured", docs: [] }), "GIT")).toBe("not measured");
    // The state decides, not the docs list: a not-measured answer never shows figures.
    expect(sectionsText(check({ state: "not-measured" }), "GIT")).toBe("not measured");
    expect(sectionsText(null, "GIT")).toBe("checking…");
  });

  test("backed by source is grounding's own count, and unknown when there are no entries", () => {
    expect(headerCounts([entry("A"), entry("B")], { totalEntries: 4, groundedEntries: 3 })).toEqual({ notes: 2, backed: 3, of: 4, backedPct: 75 });
    expect(headerCounts([], { totalEntries: 0, groundedEntries: 0 }).backedPct).toBeNull();
  });
});

describe("Which catalogue, when", () => {
  test("each routing row marks the catalogues and Ground Truth docs it names", () => {
    const md = [
      "## Context Routing Protocol — ALWAYS ACTIVE",
      "| If the message involves | Read these files before responding |",
      "|---|---|",
      "| Debugging (broken, bug) | `~/.claude/anvi/x/diagnose.md` + project `.anvi/hetvabhasa.md` + **relevant `GROUND_TRUTH_*.md` for affected boundaries** |",
      "| Planning (plan, design) | `~/.claude/anvi/x/design.md` + project `.anvi/dharana.md` |",
      "| Trivial (typo) | No extra reads needed |",
    ].join("\n");
    const rows = routingMatrix(parseRoutingTable(md).routes).map((r) => [r.activity, [...r.named].sort()]);
    expect(rows).toEqual([["Debugging", ["ground-truth", "hetvabhasa"]], ["Planning", ["dharana"]], ["Trivial", []]]);
  });
});

describe("Currency over time, and entries still in use", () => {
  const series = { key: "p", dir: "/d", status: "ok" as const, notMeasuredIn: [], errors: [], points: [{ date: "2026-09-03", file: "f", examined: 10, yellow: 4, red: 1 }] };

  test("the series is each snapshot's 🟡 + 🔴, then the live run when it has answered", () => {
    const c = ok([v({ id: "A" }), v({ id: "B", status: "GREEN" })]);
    expect(seriesPoints(series, c)).toEqual([{ label: "09-03", value: 5, of: 10, live: false }, { label: "now", value: 1, of: 2, live: true }]);
    expect(seriesPoints(series, ok([], { state: "measuring" }))).toEqual([{ label: "09-03", value: 5, of: 10, live: false }]);
  });

  const usage = (uses: Record<string, number>, status: UsageAnswer["status"] = "ok"): UsageAnswer => ({
    project: "p", since: "", days: 30, coveredFrom: null, status, errors: [], logsRead: 1, sessions: 1, edits: 3, delivered: { hetvabhasa: 0, vyapti: 0, dharana: 0 }, uses, malformed: 0,
  });

  test("only out-of-date entries the injector delivered, longest unchanged first", () => {
    const c = ok([v({ id: "H1" }), v({ id: "H2" }), v({ id: "H3" }), v({ id: "H4", status: "GREEN" }), v({ id: "V1", catalogue: "vyapti" })]);
    const dates = { hetvabhasa: { H1: { created: null, lastModified: "2026-09-01", dateSource: "entry" as const }, H2: { created: null, lastModified: "2026-08-01", dateSource: "entry" as const } } };
    const rows = oldestStillUsed(c, dates, usage({ "hetvabhasa/H1": 4, "hetvabhasa/H2": 1, "hetvabhasa/H4": 9, "vyapti/V1": 2 }));
    expect(rows.map((r) => [r.id, r.lastChanged, r.uses])).toEqual([["H2", "2026-08-01", 1], ["H1", "2026-09-01", 4], ["V1", null, 2]]);
    // A delivery of the same ID from another catalogue does not count.
    expect(oldestStillUsed(ok([v({ id: "H1" })]), null, usage({ "vyapti/H1": 3 }))).toEqual([]);
  });

  test("the window shown is where the logs reach, not the 30 days asked for", () => {
    const now = new Date("2026-11-05T12:00:00Z");
    const since = "2026-10-06T12:00:00.000Z";
    // Observed 2026-11-05: the oldest /tmp/anvi-hook-*.log line was 2026-11-03T14:30Z.
    const short = usageWindow({ since, days: 30, coveredFrom: "2026-11-03T14:30:00.000Z" }, now);
    expect(short.full).toBe(false);
    expect(short.short).toBe("1.9d");
    expect(short.text).toContain("since 2026-11-03 14:30 UTC (1.9 days");
    expect(short.text).not.toContain("in the last 30 days");
    expect(usageWindow({ since, days: 30, coveredFrom: since }, now)).toEqual({ text: "in the last 30 days", short: "30d", full: true });
    expect(usageWindow({ since, days: 30, coveredFrom: null }, now).full).toBe(false);
    expect(usageWindow({ since, days: 30, coveredFrom: null }, now).text).not.toContain("30 days");
  });

  test("an injector log that could not be read gives no rows (the screen says why), not 'unused'", () => {
    expect(oldestStillUsed(ok([v({ id: "H1" })]), null, usage({ "hetvabhasa/H1": 3 }, "unreadable"))).toEqual([]);
    expect(oldestStillUsed(ok([v({ id: "H1" })]), null, null)).toEqual([]);
  });
});
