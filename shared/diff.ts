/**
 * Diff text (from gh pr diff) into files and hunks (#84). Pure: the Changes reader uses it to list
 * every file a PR's diff has (gh pr view caps its file list at 100), and the screen to draw the diff.
 */
export interface DiffLine {
  kind: "add" | "del" | "ctx" | "meta";
  text: string;
  /** Line number on the old side (del, ctx). */
  oldNo: number | null;
  /** Line number on the new side (add, ctx). */
  newNo: number | null;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  oldPath: string | null;
  status: "added" | "deleted" | "renamed" | "modified";
  binary: boolean;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

const unquote = (p: string) => (p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1).replace(/\\(.)/g, "$1") : p);
const stripSide = (p: string) => unquote(p.trim()).replace(/^[ab]\//, "");

/** Parse `git diff` / `gh pr diff` output into files and hunks with both sides' line numbers. */
export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let f: DiffFile | null = null;
  let h: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    if (raw.startsWith("diff --git ")) {
      const m = /^diff --git ("?a\/.+?"?) ("?b\/.+"?)$/.exec(raw);
      const a = m ? stripSide(m[1]) : "";
      const b = m ? stripSide(m[2]) : "";
      f = { path: b || a, oldPath: null, status: "modified", binary: false, hunks: [], additions: 0, deletions: 0 };
      files.push(f);
      h = null;
      continue;
    }
    if (!f) continue;
    if (!h) {
      if (raw.startsWith("new file mode")) f.status = "added";
      else if (raw.startsWith("deleted file mode")) f.status = "deleted";
      else if (raw.startsWith("rename from ")) {
        f.status = "renamed";
        f.oldPath = raw.slice("rename from ".length);
      } else if (raw.startsWith("rename to ")) f.path = raw.slice("rename to ".length);
      else if (raw.startsWith("Binary files ") || raw === "GIT binary patch") f.binary = true;
      else if (raw.startsWith("--- ")) {
        const p = raw.slice(4);
        if (p !== "/dev/null" && f.status === "deleted") f.path = stripSide(p);
      } else if (raw.startsWith("+++ ")) {
        const p = raw.slice(4);
        if (p !== "/dev/null") f.path = stripSide(p);
      }
    }
    const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(raw);
    if (hm) {
      h = {
        header: raw,
        oldStart: Number(hm[1]),
        oldLines: hm[2] === undefined ? 1 : Number(hm[2]),
        newStart: Number(hm[3]),
        newLines: hm[4] === undefined ? 1 : Number(hm[4]),
        lines: [],
      };
      f.hunks.push(h);
      oldNo = h.oldStart;
      newNo = h.newStart;
      continue;
    }
    if (!h) continue;
    const c = raw[0];
    if (c === "+") {
      h.lines.push({ kind: "add", text: raw.slice(1), oldNo: null, newNo: newNo++ });
      f.additions++;
    } else if (c === "-") {
      h.lines.push({ kind: "del", text: raw.slice(1), oldNo: oldNo++, newNo: null });
      f.deletions++;
    } else if (c === " ") {
      h.lines.push({ kind: "ctx", text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ });
    } else if (c === "\\") {
      h.lines.push({ kind: "meta", text: raw, oldNo: null, newNo: null });
    }
    // An empty line ends the diff text or separates files; it is not a hunk line.
  }
  return files;
}

