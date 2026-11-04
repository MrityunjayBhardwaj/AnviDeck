import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { announcesContinuation, parseCatalogueEntries } from "../shared/parser";
import { readEntryDatesForFile } from "../server/readers/git-history";

// #33: an update written ABOVE its entry must not replace the entry.
// Shaped like a real boundary map: the newest "### <id> UPDATE" headings sit on
// top of the boundary's own "### <id>: … fatality test TRIPPED" heading.
const UPDATE_FIRST = `# Dharana

### X1 UPDATE 2026-07-31 (cont.179) — the newest note

Newest update text.

### X1 UPDATE 2026-07-31 (cont.178) — an older note

Older update text.

### X1: the boundary itself — TRACKED 2026-07-16 (cont.96, fatality test TRIPPED: 9 patterns)

The boundary itself.

### X2: next boundary — TRACKED

Text.
`;

describe("which heading of a repeated ID is the entry (#33)", () => {
  test("an UPDATE written above its entry gives way to the entry's own heading", () => {
    const entries = parseCatalogueEntries(UPDATE_FIRST, "dharana");
    expect(entries.map((e) => e.id)).toEqual(["X1", "X2"]);
    const x1 = entries[0]!;
    expect(x1.title).toContain("the boundary itself");
    expect(x1.tags).toContain("FATALITY");
  });

  test("the first heading stays the entry when it does not announce an update", () => {
    // "X3 — …" is the entry, written with a dash; a later "X3: …" heading
    // must not displace it (seen in real error-pattern catalogues).
    const md = `### X3 — The entry, written with a dash

Entry.

### X3: a later note about X3

Note.
`;
    const entries = parseCatalogueEntries(md, "hetvabhasa");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.title).toContain("The entry");
  });

  test("an entry whose title starts with an update word is not an update", () => {
    const md = `### X4: Update loop ordering — TRACKED (fatality test TRIPPED: 3 patterns)

Entry.

### X4 — a later note

Note.
`;
    const entries = parseCatalogueEntries(md, "dharana");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.title).toContain("Update loop ordering");
    expect(entries[0]!.tags).toContain("FATALITY");
  });

  test("when every heading is an update, the first one is kept", () => {
    const md = `### X5 UPDATE one

A.

### X5 UPDATE two

B.
`;
    const entries = parseCatalogueEntries(md, "dharana");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.title).toContain("one");
  });

  test("an h3 sub-section under an h2 entry is still folded into it", () => {
    const md = `## X8: The entry

Body.

### X8 — ORIGINAL FRAMING (SUPERSEDED)

Audit block.
`;
    const entries = parseCatalogueEntries(md, "hetvabhasa");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.title).toContain("The entry");
    expect(entries[0]!.continuations).toEqual([
      { level: 3, title: "— ORIGINAL FRAMING", announced: false, tags: [] },
    ]);
  });

  test("announcesContinuation reads the word right after the ID, with no colon", () => {
    expect(announcesContinuation("X1 UPDATE 2026-07-31 — x")).toBe(true);
    expect(announcesContinuation("X6 ADDENDUM (cont.4)")).toBe(true);
    expect(announcesContinuation("X7 (AMENDMENT) x")).toBe(true);
    expect(announcesContinuation("X1: the boundary itself")).toBe(false);
    expect(announcesContinuation("X4: Update loop ordering")).toBe(false);
    expect(announcesContinuation("X3 — The entry")).toBe(false);
    expect(announcesContinuation("X1 UPDATED-LIST")).toBe(false);
  });
});

// #72: a later heading of an ID, at EITHER level, continues the entry — as anvi's
// own parser numbers it (occurrence > 1) — and is kept on the entry, not counted.
describe("later headings of an ID are continuations, at either level (#72)", () => {
  test("level-2 UPDATE headings after a level-3 entry are attached, not listed", () => {
    // Shaped like the boundary map that listed one boundary as 24 entries.
    const md = `# Dharana

### X18: the boundary — TRACKED

Body.

### X19: next boundary

Text.

## X18 UPDATE 2026-08-01 — first note

A.

## X18 UPDATE 2026-08-02 — second note

B.

## X18 ADDENDUM — third note

C.
`;
    const entries = parseCatalogueEntries(md, "dharana");
    expect(entries.map((e) => e.id)).toEqual(["X18", "X19"]);
    const x18 = entries[0]!;
    expect(x18.title).toContain("the boundary");
    expect(x18.continuations!.map((c) => [c.level, c.announced, c.title])).toEqual([
      [2, true, "UPDATE 2026-08-01 — first note"],
      [2, true, "UPDATE 2026-08-02 — second note"],
      [2, true, "ADDENDUM — third note"],
    ]);
    expect(entries[1]!.continuations).toBeUndefined();
  });

  test("two level-2 headings with one ID make one entry; the second stays visible", () => {
    // A genuine reuse of an ID looks like this too. It is not counted as a
    // second entry, but it is kept, marked as not announcing itself.
    const md = `## X20: Stale cache read

Body.

## X21: Something else

Body.

## X20: An unrelated failure that reused the ID

Body.
`;
    const entries = parseCatalogueEntries(md, "hetvabhasa");
    expect(entries.map((e) => e.id)).toEqual(["X20", "X21"]);
    expect(entries[0]!.title).toBe("Stale cache read");
    expect(entries[0]!.continuations).toEqual([
      { level: 2, title: "An unrelated failure that reused the ID", announced: false, tags: [] },
    ]);
  });

  test("an update written above its entry becomes the entry's first continuation", () => {
    const entries = parseCatalogueEntries(UPDATE_FIRST, "dharana");
    const x1 = entries[0]!;
    expect(x1.title).toContain("the boundary itself");
    expect(x1.continuations!.map((c) => c.title)).toEqual([
      "UPDATE 2026-07-31 — the newest note",
      "UPDATE 2026-07-31 — an older note",
    ]);
    expect(x1.continuations!.every((c) => c.level === 3 && c.announced)).toBe(true);
  });

  test("a continuation keeps the status tags of its own heading", () => {
    const md = `### X22: invariant

Body.

### X22 UPDATE — now MISALIGNED

Note.
`;
    const [x22] = parseCatalogueEntries(md, "vyapti");
    expect(x22!.tags).toEqual([]);
    expect(x22!.continuations![0]!.tags).toEqual(["MISALIGNED"]);
  });
});

describe("per-entry dates read the entry's own lines (#33)", () => {
  let repo = "";
  const git = (date: string, ...args: string[]) =>
    execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    }).trim();

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "anvideck-parser-"));
    git("2026-01-01T00:00:00Z", "init", "-q");
    writeFileSync(join(repo, "dharana.md"), "# Dharana\n\n### X9: first\n\nx\n");
    git("2026-01-01T00:00:00Z", "add", ".");
    git("2026-01-01T00:00:00Z", "commit", "-q", "-m", "start");
    // The entry arrives on 2026-02-01 …
    writeFileSync(
      join(repo, "dharana.md"),
      "# Dharana\n\n### X9: first\n\nx\n\n### X1: the boundary (fatality test TRIPPED: 9 patterns)\n\nbody\n"
    );
    git("2026-02-01T00:00:00Z", "commit", "-q", "-am", "entry");
    // … and an update is written ABOVE it on 2026-03-01.
    writeFileSync(
      join(repo, "dharana.md"),
      "# Dharana\n\n### X9: first\n\nx\n\n### X1 UPDATE 2026-03-01 — newer\n\nupdate\n\n### X1: the boundary (fatality test TRIPPED: 9 patterns)\n\nbody\n"
    );
    git("2026-03-01T00:00:00Z", "commit", "-q", "-am", "update");
  });

  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  test("lastModified comes from the entry's lines, not the update written above it", async () => {
    const dates = await readEntryDatesForFile(join(repo, "dharana.md"));
    expect(dates["X1"]!.created).toStartWith("2026-02-01");
    expect(dates["X1"]!.lastModified).toStartWith("2026-02-01");
  });
});
