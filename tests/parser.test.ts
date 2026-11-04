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
