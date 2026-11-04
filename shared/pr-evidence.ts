/**
 * The PR-body Evidence and Self-review sections (issue #83).
 *
 * Agents AnviDeck starts write these two sections into every PR body in one
 * fixed, human-readable markdown shape. This module owns both sides of that
 * contract: the instruction text an agent is given (PR_SECTIONS_INSTRUCTIONS,
 * which the agent host puts into its prompt) and the parser that reads the
 * sections back (parsePrSections) for the Changes screen.
 *
 * Each section comes back in one of three states, never as a bare empty list:
 *   - "recorded":     the section is present and parsed fully;
 *   - "not recorded": the body has no such section (older PRs, hand-written PRs);
 *   - "malformed":    the section is present but does not follow the shape,
 *                     with the reason, so "written wrong" never reads as "nothing found".
 *
 * An empty list inside a recorded section only ever comes from the author
 * writing the explicit "None." / "None found." line.
 */

export type SectionState<T> =
  | { status: "recorded"; value: T }
  | { status: "not recorded" }
  | { status: "malformed"; reason: string };

/** One test command, with the runner's own exit status kept apart from its tally. */
export interface TestRun {
  command: string;
  /** The runner's exit status, as the shell reported it. Non-zero is a failure whatever the tally says. */
  exitCode: number;
  /** The runner's tally or summary line, as written (e.g. "152 pass, 0 fail"). */
  result: string;
}

export interface Evidence {
  tests: TestRun[];
  observed: string[];
  /** Empty only when the author wrote "None." under "Not checked". */
  notChecked: string[];
}

export type Severity = "high" | "medium" | "low";

export interface IssueRef {
  /** "owner/name" when the cell names another repository or a full URL; null for a bare "#N". */
  repo: string | null;
  number: number;
}

export interface Gap {
  severity: Severity;
  gap: string;
  /** The issue filed for this gap, or null when the author wrote "none". */
  issue: IssueRef | null;
}

export interface SelfReview {
  /** Empty only when the author wrote "None found." */
  gaps: Gap[];
}

export interface PrSections {
  evidence: SectionState<Evidence>;
  selfReview: SectionState<SelfReview>;
}

/** The sample PR body tail in the fixed shape. It is part of the instructions and must parse fully (tested). */
export const PR_SECTIONS_EXAMPLE = `## Evidence

### Tests
| Command | Exit | Result |
|---|---|---|
| \`bun test\` | 0 | 152 pass, 0 fail |
| \`bunx tsc --noEmit -p .\` | 0 | no errors |

### Observed
- Started the server on port 4476 and opened the Changes screen in headless Chrome: PR #12 shows 2 test runs and 3 observations.
- Ran the parser over 27 merged PRs on 2026-11-05: 0 recorded, 27 not recorded, 0 malformed.

### Not checked
- Behaviour on a PR body longer than 65,536 characters.

## Self-review

| Severity | Gap | Issue |
|---|---|---|
| medium | A near-miss heading such as "Self review" reads as not recorded. | #101 |
| low | Severity words other than high, medium, low are refused rather than mapped. | none |
`;

/** The exact text an agent is given about these two sections. */
export const PR_SECTIONS_INSTRUCTIONS = `Every PR body you write must end with two sections, "## Evidence" and "## Self-review", in exactly this shape. AnviDeck reads them; a section that does not follow the shape is shown as malformed.

The "## Evidence" section has three parts, each a "###" heading, in any order, each exactly once:
- "### Tests": a table with the header "| Command | Exit | Result |". One row per command you ran. Exit is the runner's own exit status as a whole number (capture it separately, e.g. "bun test; echo $?"), never inferred from the tally. Result is the runner's tally or summary line. A command you did not run does not go here; put it under Not checked.
- "### Observed": a "- " bullet list, at least one item, of what you saw when you ran the real thing (server, page, command output) with real numbers, their population and date.
- "### Not checked": a "- " bullet list of what you could not or did not check. If there is nothing, write the single line "None." instead of a list.

The "## Self-review" section is a table with the header "| Severity | Gap | Issue |", one row per gap you found in your own diff:
- Severity is one of high, medium, low.
- Gap is one plain sentence.
- Issue is the issue you filed for it, as #N, owner/name#N or its GitHub URL, or the word none.
If you found no gaps, write the single line "None found." instead of the table.

Write "\\|" for a "|" inside a table cell. Put nothing else inside these two sections; other sections (Problem, Fix, ...) go above them, and a closing line such as "Closes #N" may follow them. Example:

${PR_SECTIONS_EXAMPLE}`;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*(?:#+[ \t]*)?$/;

interface Heading {
  level: number;
  text: string;
  line: number;
}

/** ATX headings outside fenced code blocks. */
function headingsOf(lines: string[]): Heading[] {
  const out: Heading[] = [];
  let fence: string | null = null;
  lines.forEach((l, i) => {
    const f = FENCE_RE.exec(l);
    if (f) {
      const marker = f[1];
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      return;
    }
    if (fence !== null) return;
    const h = HEADING_RE.exec(l);
    if (h) out.push({ level: h[1].length, text: h[2], line: i });
  });
  return out;
}

const norm = (s: string) => s.trim().toLowerCase();

/**
 * A whole line that only closes issues ("Closes #83", "Fixes o/r#4, resolves #5").
 * GitHub's closing keywords; such a line conventionally ends a PR body, after these sections.
 */
const CLOSING_LINE_RE =
  /^\s*(?:(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+(?:[\w.-]+\/[\w.-]+)?#\d+[\s,.;]*(?:and\s+)?)+$/i;

/**
 * The body lines of each level-2 section named `name` (case-insensitive, whole heading).
 * A section runs until the next level-1 or level-2 heading. Lines that only close
 * issues are not part of a section (see CLOSING_LINE_RE).
 */
function sectionsNamed(lines: string[], heads: Heading[], name: string): string[][] {
  const found: string[][] = [];
  heads.forEach((h, idx) => {
    if (h.level !== 2 || norm(h.text) !== name) return;
    const next = heads.slice(idx + 1).find((n) => n.level <= 2);
    found.push(lines.slice(h.line + 1, next ? next.line : lines.length).filter((l) => !CLOSING_LINE_RE.test(l)));
  });
  return found;
}

/** Split one table row into cells; "\|" is a literal pipe. Returns null if the line is not a row. */
function cellsOf(line: string): string[] | null {
  const t = line.trim();
  if (!t.startsWith("|")) return null;
  const cells: string[] = [];
  let cur = "";
  for (let i = 1; i < t.length; i++) {
    const ch = t[i];
    if (ch === "\\" && t[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (ch === "|") {
      cells.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim() !== "") return null; // a row must close with "|"
  return cells;
}

const SEPARATOR_CELL = /^:?-{3,}:?$/;

type TableResult = { ok: true; rows: string[][] } | { ok: false; reason: string };

/** A table with exactly the given header, then a separator row, then at least one data row. Nothing else but blank lines. */
function parseTable(body: string[], header: string[], where: string): TableResult {
  const lines = body.filter((l) => l.trim() !== "");
  const want = `| ${header.join(" | ")} |`;
  if (lines.length === 0) return { ok: false, reason: `${where} is empty; expected a table with the header "${want}"` };
  const head = cellsOf(lines[0]);
  if (!head || head.length !== header.length || head.some((c, i) => norm(c) !== norm(header[i])))
    return { ok: false, reason: `${where} must start with the table header "${want}", found "${lines[0].trim()}"` };
  const sep = lines.length > 1 ? cellsOf(lines[1]) : null;
  if (!sep || sep.length !== header.length || !sep.every((c) => SEPARATOR_CELL.test(c)))
    return { ok: false, reason: `${where}: the line after the header must be the separator row "|${"---|".repeat(header.length)}"` };
  const rows: string[][] = [];
  for (const l of lines.slice(2)) {
    const cells = cellsOf(l);
    if (!cells) return { ok: false, reason: `${where}: "${l.trim()}" is not a table row` };
    if (cells.length !== header.length)
      return { ok: false, reason: `${where}: row "${l.trim()}" has ${cells.length} cells, expected ${header.length}` };
    rows.push(cells);
  }
  if (rows.length === 0) return { ok: false, reason: `${where} has a header but no rows` };
  return { ok: true, rows };
}

const BULLET_RE = /^[-*+][ \t]+(.*)$/;
const NONE_RE = (word: string) => new RegExp(`^${word}\\.?$`, "i");

type ListResult = { ok: true; items: string[]; none: boolean } | { ok: false; reason: string };

/**
 * A "- " bullet list. Indented lines continue the previous item. When `noneWord`
 * is given, the single line "<noneWord>." stands for an explicit empty list.
 */
function parseList(body: string[], where: string, noneWord: string | null): ListResult {
  const nonBlank = body.filter((l) => l.trim() !== "");
  if (noneWord && nonBlank.length === 1 && NONE_RE(noneWord).test(nonBlank[0].trim()))
    return { ok: true, items: [], none: true };
  const items: string[] = [];
  for (const l of body) {
    if (l.trim() === "") continue;
    const b = BULLET_RE.exec(l);
    if (b) {
      const text = b[1].trim();
      if (text === "") return { ok: false, reason: `${where} has an empty bullet` };
      items.push(text);
    } else if (/^[ \t]+\S/.test(l) && items.length > 0) {
      items[items.length - 1] += "\n" + l.trim();
    } else {
      return { ok: false, reason: `${where}: "${l.trim()}" is not a "- " bullet` };
    }
  }
  if (items.length === 0)
    return {
      ok: false,
      reason: noneWord ? `${where} has no bullets; write "${noneWord}." if there is nothing` : `${where} has no bullets`,
    };
  return { ok: true, items, none: false };
}

const stripTicks = (s: string) => {
  const m = /^(`+)(.*)\1$/.exec(s);
  return m ? m[2].trim() : s;
};

function single<T>(found: string[][], heading: string, parse: (body: string[]) => SectionState<T>): SectionState<T> {
  if (found.length === 0) return { status: "not recorded" };
  if (found.length > 1) return { status: "malformed", reason: `the body has ${found.length} "## ${heading}" sections; write it once` };
  return parse(found[0]);
}

const EVIDENCE_PARTS = ["tests", "observed", "not checked"] as const;
const PART_TITLE: Record<(typeof EVIDENCE_PARTS)[number], string> = {
  tests: "Tests",
  observed: "Observed",
  "not checked": "Not checked",
};

function parseEvidence(body: string[]): SectionState<Evidence> {
  const heads = headingsOf(body);
  const firstH3 = heads.find((h) => h.level === 3);
  const lead = body.slice(0, firstH3 ? firstH3.line : body.length).filter((l) => l.trim() !== "");
  if (lead.length > 0)
    return { status: "malformed", reason: `Evidence must contain only the "### Tests", "### Observed" and "### Not checked" parts; found "${lead[0].trim()}" before them` };
  const other = heads.find((h) => h.level !== 3);
  if (other) return { status: "malformed", reason: `Evidence has a level-${other.level} heading "${other.text}"; its parts are "###" headings` };

  const parts = new Map<string, string[]>();
  const h3 = heads.filter((h) => h.level === 3);
  for (let i = 0; i < h3.length; i++) {
    const name = norm(h3[i].text);
    if (!(EVIDENCE_PARTS as readonly string[]).includes(name))
      return { status: "malformed", reason: `Evidence has an unknown part "### ${h3[i].text}"; the parts are Tests, Observed, Not checked` };
    if (parts.has(name)) return { status: "malformed", reason: `Evidence has "### ${PART_TITLE[name as keyof typeof PART_TITLE]}" twice` };
    parts.set(name, body.slice(h3[i].line + 1, i + 1 < h3.length ? h3[i + 1].line : body.length));
  }
  const missing = EVIDENCE_PARTS.filter((p) => !parts.has(p));
  if (missing.length > 0)
    return { status: "malformed", reason: `Evidence is missing ${missing.map((p) => `"### ${PART_TITLE[p]}"`).join(", ")}` };

  const t = parseTable(parts.get("tests")!, ["Command", "Exit", "Result"], "Evidence / Tests");
  if (!t.ok) return { status: "malformed", reason: t.reason };
  const tests: TestRun[] = [];
  for (const [cmd, exit, result] of t.rows) {
    const command = stripTicks(cmd);
    if (command === "") return { status: "malformed", reason: "Evidence / Tests has a row with an empty Command" };
    if (!/^\d+$/.test(exit))
      return { status: "malformed", reason: `Evidence / Tests: Exit for "${command}" is "${exit}", expected the runner's exit status as a whole number` };
    if (result === "") return { status: "malformed", reason: `Evidence / Tests: Result for "${command}" is empty` };
    tests.push({ command, exitCode: Number(exit), result });
  }

  const obs = parseList(parts.get("observed")!, "Evidence / Observed", null);
  if (!obs.ok) return { status: "malformed", reason: obs.reason };
  const nc = parseList(parts.get("not checked")!, "Evidence / Not checked", "None");
  if (!nc.ok) return { status: "malformed", reason: nc.reason };

  return { status: "recorded", value: { tests, observed: obs.items, notChecked: nc.items } };
}

const ISSUE_URL_RE = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+)\/?$/;
const ISSUE_REF_RE = /^(?:([\w.-]+\/[\w.-]+))?#(\d+)$/;

function parseIssueCell(cell: string): IssueRef | null | undefined {
  const c = cell.trim();
  if (/^none$/i.test(c)) return null;
  const u = ISSUE_URL_RE.exec(c);
  if (u) return { repo: u[1], number: Number(u[2]) };
  const r = ISSUE_REF_RE.exec(c);
  if (r) return { repo: r[1] ?? null, number: Number(r[2]) };
  return undefined;
}

function parseSelfReview(body: string[]): SectionState<SelfReview> {
  const nonBlank = body.filter((l) => l.trim() !== "");
  if (nonBlank.length === 1 && NONE_RE("None found").test(nonBlank[0].trim())) return { status: "recorded", value: { gaps: [] } };
  const t = parseTable(body, ["Severity", "Gap", "Issue"], "Self-review");
  if (!t.ok) return { status: "malformed", reason: `${t.reason} (or the single line "None found.")` };
  const gaps: Gap[] = [];
  for (const [sev, gap, issueCell] of t.rows) {
    const severity = norm(sev);
    if (severity !== "high" && severity !== "medium" && severity !== "low")
      return { status: "malformed", reason: `Self-review: severity "${sev}" is not one of high, medium, low` };
    if (gap === "") return { status: "malformed", reason: "Self-review has a row with an empty Gap" };
    const issue = parseIssueCell(issueCell);
    if (issue === undefined)
      return { status: "malformed", reason: `Self-review: Issue "${issueCell}" is not #N, owner/name#N, a GitHub issue URL or "none"` };
    gaps.push({ severity, gap, issue });
  }
  return { status: "recorded", value: { gaps } };
}

/** Read the Evidence and Self-review sections from a PR body. A null/empty body has neither. */
export function parsePrSections(body: string | null | undefined): PrSections {
  const lines = (body ?? "").replace(/\r\n?/g, "\n").split("\n");
  const heads = headingsOf(lines);
  return {
    evidence: single(sectionsNamed(lines, heads, "evidence"), "Evidence", parseEvidence),
    selfReview: single(sectionsNamed(lines, heads, "self-review"), "Self-review", parseSelfReview),
  };
}
