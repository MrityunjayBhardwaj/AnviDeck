import type { TimelinePoint } from "../../shared/types";

const CLAUDE_GIT_DIR = `${process.env.HOME ?? "/Users/mrityunjaybhardwaj"}/.claude`;

/**
 * Run a git command in the ~/.claude repo.
 */
async function gitCmd(args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", "-C", CLAUDE_GIT_DIR, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(proc.stdout).text();
  await proc.exited;
  return output.trim();
}

/**
 * Get git log as timeline points.
 * Default: last 100 commits.
 */
export async function getTimeline(
  limit = 100,
  offset = 0
): Promise<TimelinePoint[]> {
  const raw = await gitCmd([
    "log",
    `--skip=${offset}`,
    `-n`,
    `${limit}`,
    "--format=%H|%s|%aI",
    "--name-only",
  ]);

  if (!raw) return [];

  const points: TimelinePoint[] = [];
  const blocks = raw.split("\n\n");

  for (const block of blocks) {
    const lines = block.split("\n").filter(Boolean);
    if (lines.length === 0) continue;

    const [metaLine, ...fileLines] = lines;
    const [hash, message, dateStr] = metaLine.split("|");
    if (!hash || !message) continue;

    points.push({
      hash,
      message,
      date: new Date(dateStr),
      filesChanged: fileLines,
    });
  }

  return points;
}

/**
 * Show file contents at a specific commit.
 */
export async function showAtCommit(
  hash: string,
  filePath: string
): Promise<string | null> {
  try {
    const output = await gitCmd(["show", `${hash}:${filePath}`]);
    return output || null;
  } catch {
    return null;
  }
}

/**
 * Diff between two commits.
 */
export async function diffCommits(
  from: string,
  to: string
): Promise<string> {
  return gitCmd(["diff", from, to]);
}

/**
 * List files at a specific commit under a path.
 */
export async function listAtCommit(
  hash: string,
  dirPath: string
): Promise<string[]> {
  try {
    const output = await gitCmd([
      "ls-tree",
      "-r",
      "--name-only",
      hash,
      dirPath,
    ]);
    return output ? output.split("\n").filter(Boolean) : [];
  } catch {
    return [];
  }
}
