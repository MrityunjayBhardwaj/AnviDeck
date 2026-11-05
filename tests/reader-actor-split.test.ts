import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/**
 * The readers stay read-only (#76). Every module under server/readers/ (the list is read from
 * the directory, so a new reader is checked without anyone adding it here):
 *   - must not import the agent host (server/agents/*), the action log or the write guard, and
 *   - must not call a file-system write API.
 */

const ROOT = resolve(import.meta.dir, "..");
const READERS = join(ROOT, "server", "readers");
const WRITERS = [join(ROOT, "server", "agents"), join(ROOT, "server", "action-log"), join(ROOT, "server", "guard")];

// Write calls by name; any ".write(" except Bun.write (already named) and the process's own
// stdout/stderr; and open()/openSync() with a literal flag that writes (w, a or +). An open whose
// flag is a variable is not caught: name such a reader in ALLOWED with why.
const WRITE_CALL =
  /(?<![\w$])(?:writeFile|writeFileSync|appendFile|appendFileSync|writeSync|writev|writevSync|ftruncate|ftruncateSync|mkdir|mkdirSync|mkdtemp|mkdtempSync|rename|renameSync|rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync|copyFile|copyFileSync|cp|cpSync|truncate|truncateSync|createWriteStream|symlink|symlinkSync|link|linkSync|chmod|chmodSync|utimes|utimesSync)\s*\(|\bBun\.write\s*\(|\.writer\s*\(|(?<!\bBun|process\.stdout|process\.stderr)\.write\s*\(|(?<![\w$])open(?:Sync)?\s*\([^()]*,\s*["'][^"']*[wa+][^"']*["']/g;

const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm;

/**
 * Writes a reader may make, each with why. Matched by exact text and exact count, so a second
 * write in the same file, or the same call in another file, is still caught; an exemption whose
 * call is gone fails too, so the list cannot go stale.
 */
const ALLOWED: { file: string; call: string; count: number; why: string }[] = [
  {
    file: "structure.ts",
    call: "mkdirSync(TMP_ROOT, { recursive: true })",
    count: 1,
    why: "creates the scratch dir under the OS temp folder that the structure guard runs in; no store or project file is written",
  },
];

/**
 * Commands a reader may not spawn: git commands that write a repository (objects, refs, a
 * checkout), and gh commands that change GitHub. Matched as string literals in the argument
 * list, the way every reader passes them to its run function.
 */
const SPAWN_WRITE =
  /["'](?:clone|fetch|push|update-ref|--write-tree|init|checkout|reset|worktree|commit-tree|gc)["']|["'](?:pr|issue)["']\s*,\s*["'](?:merge|create|edit|close|comment|reopen)["']|["']project["']\s*,\s*["']item-(?:add|edit|delete|archive)["']/g;

export function spawnWritesIn(src: string): string[] {
  return [...code(src).matchAll(SPAWN_WRITE)].map((m) => m[0]);
}

/**
 * Spawned writes a reader may make, each with why. Matched by the literal and its exact count in
 * that file, so a new one, or one in another reader, is caught, and a stale exemption fails.
 */
const ALLOWED_SPAWN: { file: string; literal: string; count: number; why: string }[] = [
  {
    file: "work-conflicts.ts",
    literal: '"clone"',
    count: 1,
    why: "makes the scratch bare repo for Work's conflict check under ANVIDECK_WORK_TMP (git clone --bare --shared of the main checkout); the project's repository is not written",
  },
  {
    file: "work-conflicts.ts",
    literal: '"fetch"',
    count: 1,
    why: "fetches missing PR heads and bases from GitHub into that scratch repo only (destination-less refspecs: only its FETCH_HEAD moves)",
  },
  {
    file: "work-conflicts.ts",
    literal: '"--write-tree"',
    count: 1,
    why: "git merge-tree --write-tree writes the trial merge's objects into that scratch repo only",
  },
];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return files(p);
    return /\.(ts|js|cjs|mjs)$/.test(n) ? [p] : [];
  });
}

/** Drop comments so prose about writing a file never counts, keeping strings intact. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

export function writesIn(src: string): string[] {
  return [...code(src).matchAll(WRITE_CALL)].map((m) => m[0]);
}

export function writerImports(file: string, src: string): string[] {
  const bad: string[] = [];
  for (const m of code(src).matchAll(IMPORT)) {
    const spec = m[1];
    if (!spec.startsWith(".")) continue;
    const target = resolve(dirname(file), spec).replace(/\.(ts|js|cjs|mjs)$/, "");
    if (WRITERS.some((w) => target === w || target.startsWith(w + "/"))) bad.push(spec);
  }
  return bad;
}

const readers = files(READERS);

describe("reader/actor split", () => {
  test("the reader list comes from the directory and is not empty", () => {
    expect(readers.length).toBeGreaterThanOrEqual(10);
    expect(readers.map((f) => relative(READERS, f))).toContain("replay.ts");
  });

  test("the detectors fire on writes and writer imports, and not on reads or prose", () => {
    for (const w of ["writeFileSync(p, x)", "fs.appendFile(p, x)", "await Bun.write(p, x)", "mkdirSync(d)", "rmSync(d)", "await rename(a, b)", "Bun.file(p).writer()", "unlinkSync(p)", "await Bun.file(p).write(x)", "fs.writeSync(fd, x)", "openSync(p, \"w\")", "await fs.promises.open(p, 'a+')", "ftruncateSync(fd)"]) {
      expect(writesIn(w).length).toBe(1);
    }
    for (const r of ["readFileSync(p)", "// writeFileSync(p) in a comment", "/* Bun.write(x) */", "const re = /writeFileSync\\(/", "permissions.rm", "confirm(x)", "form(x)", "openSync(file, \"r\")", "openSync(p)", "process.stdout.write(x)", "reopen(p, 'w')"]) {
      expect(writesIn(r)).toEqual([]);
    }
    const f = join(READERS, "x.ts");
    expect(writerImports(f, `import { AgentHost } from "../agents/host";`)).toEqual(["../agents/host"]);
    expect(writerImports(f, `const m = await import("../agents/registry.ts");`)).toEqual(["../agents/registry.ts"]);
    expect(writerImports(f, `const g = require("../guard");`)).toEqual(["../guard"]);
    expect(writerImports(f, `import { ActionLog } from "../action-log";`)).toEqual(["../action-log"]);
    expect(writerImports(f, `import "../agents/login";`)).toEqual(["../agents/login"]);
    expect(writerImports(f, `import { x } from "./catalogue"; import { y } from "../../shared/agents";`)).toEqual([]);
  });

  test("the spawn detector fires on git and gh commands that write, and not on ones that read", () => {
    for (const w of [`run("git", ["clone", "--bare", a, b])`, `["--git-dir", d, "fetch", url]`, `["merge-tree", "--write-tree", a, b]`, `run("gh", ["pr", "merge", "7"])`, `["issue", "create", "--repo", r]`, `["project", "item-edit", "--id", x]`, `['push', 'origin']`]) {
      expect(spawnWritesIn(w).length).toBe(1);
    }
    for (const r of [`["log", "--oneline"]`, `["pr", "view", "7"]`, `["issue", "list"]`, `["merge-tree", "--name-only"]`, `kind: "commit"`, `Pick<PrInfo, "number" | "merge">`, `// git fetch in a comment`, `["project", "item-list", "1"]`]) {
      expect(spawnWritesIn(r)).toEqual([]);
    }
  });

  test("the Work screen's readers are among the readers checked", () => {
    expect(readers.map((f) => relative(READERS, f))).toEqual(expect.arrayContaining(["work.ts", "work-conflicts.ts", "repo.ts", "boards.ts"]));
  });

  test("no reader spawns a git or gh command that writes (beyond the listed exemptions)", () => {
    const found: string[] = [];
    for (const f of readers) {
      const name = relative(READERS, f);
      let src = code(readFileSync(f, "utf8"));
      for (const a of ALLOWED_SPAWN.filter((x) => x.file === name)) {
        const n = src.split(a.literal).length - 1;
        expect(`${name}: ${a.literal} x${n}`).toBe(`${name}: ${a.literal} x${a.count}`);
        src = src.split(a.literal).join("");
      }
      for (const w of spawnWritesIn(src)) found.push(`${relative(ROOT, f)}: ${w}`);
    }
    expect(found).toEqual([]);
  });

  test("no reader imports the agent host, the action log or the write guard", () => {
    const found = readers.flatMap((f) => writerImports(f, readFileSync(f, "utf8")).map((s) => `${relative(ROOT, f)} imports ${s}`));
    expect(found).toEqual([]);
  });

  test("no reader calls a file-system write API (beyond the listed exemptions)", () => {
    const found: string[] = [];
    for (const f of readers) {
      const name = relative(READERS, f);
      let src = code(readFileSync(f, "utf8"));
      for (const a of ALLOWED.filter((x) => x.file === name)) {
        const n = src.split(a.call).length - 1;
        // A stale exemption is a failure too: remove it when the call goes.
        expect(`${name}: ${a.call} x${n}`).toBe(`${name}: ${a.call} x${a.count}`);
        src = src.split(a.call).join("");
      }
      for (const w of writesIn(src)) found.push(`${relative(ROOT, f)}: ${w}`);
    }
    expect(found).toEqual([]);
  });
});
