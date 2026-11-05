import type { Run } from "./worktree";

/**
 * Move an issue to In Progress on its repository's project board (#78), with every id derived
 * at run time, never stored (the same steps as anvi's update-board workflow):
 *   the board linked to the repository → its Status field and the "In Progress" option →
 *   add-or-get the issue's item → set its Status.
 * A repository with no linked board says "no board"; several linked boards are not guessed
 * between. An item added whose Status could not be set is said in those words: it sits on the
 * board in no column.
 */

export type BoardResult =
  | { state: "moved"; board: string; item: string }
  | { state: "no board"; reason: string }
  | { state: "not moved"; reason: string };

export const IN_PROGRESS = "In Progress";

const QUERY = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){projectsV2(first:10){nodes{id number title url owner{... on User{login} ... on Organization{login}} field(name:"Status"){... on ProjectV2SingleSelectField{id options{id name}}}}}}}`;

export interface Board {
  id: string;
  number: number;
  title: string;
  url?: string;
  owner: { login: string };
  field: { id: string; options: { id: string; name: string }[] } | null;
}

/**
 * The project boards linked to a repository, as GitHub lists them (ids derived, never stored).
 * Shared by the move to In Progress (#78) and the Work screen's board (#85). A read that failed
 * says so in its own state; it is never an empty list.
 */
export async function linkedBoards(run: Run, repo: string): Promise<{ state: "read"; boards: Board[] } | { state: "unreadable"; reason: string }> {
  const [owner, name] = repo.split("/");
  const q = await run("gh", ["api", "graphql", "-f", `owner=${owner}`, "-f", `name=${name}`, "-f", `query=${QUERY}`]);
  if (q.code !== 0) return { state: "unreadable", reason: `could not ask GitHub which board ${repo} has: ${q.stderr.trim().slice(0, 300)}` };
  try {
    const boards = (JSON.parse(q.stdout) as { data: { repository: { projectsV2: { nodes: Board[] } } } }).data.repository.projectsV2.nodes;
    if (!Array.isArray(boards)) throw new Error("not a list");
    return { state: "read", boards };
  } catch {
    return { state: "unreadable", reason: `GitHub's answer about ${repo}'s boards could not be read` };
  }
}

export async function moveToInProgress(run: Run, repo: string, issueUrl: string): Promise<BoardResult> {
  const linked = await linkedBoards(run, repo);
  if (linked.state === "unreadable") return { state: "not moved", reason: linked.reason };
  const boards = linked.boards;
  if (!boards.length) return { state: "no board", reason: `no project board is linked to ${repo}` };
  if (boards.length > 1) {
    return { state: "not moved", reason: `${boards.length} boards are linked to ${repo} (${boards.map((b) => `#${b.number} ${b.title}`).join(", ")}); not guessing which one` };
  }
  const b = boards[0]!;
  const label = `#${b.number} ${b.title}`;
  if (!b.field || !Array.isArray(b.field.options)) return { state: "not moved", reason: `board ${label} has no single-select Status field` };
  const option = b.field.options.find((o) => o.name === IN_PROGRESS);
  if (!option) {
    return { state: "not moved", reason: `board ${label} has no Status column named "${IN_PROGRESS}" (its columns: ${b.field.options.map((o) => o.name).join(", ")})` };
  }
  const add = await run("gh", ["project", "item-add", String(b.number), "--owner", b.owner.login, "--url", issueUrl, "--format", "json"]);
  let item = "";
  try {
    item = add.code === 0 ? String((JSON.parse(add.stdout) as { id?: unknown }).id ?? "") : "";
  } catch {
    item = "";
  }
  if (!item) return { state: "not moved", reason: `could not put the issue on board ${label}: ${add.stderr.trim().slice(0, 300) || "no item id in the answer"}` };
  const edit = await run("gh", ["project", "item-edit", "--id", item, "--project-id", b.id, "--field-id", b.field.id, "--single-select-option-id", option.id]);
  if (edit.code !== 0) {
    return { state: "not moved", reason: `the issue is on board ${label} but its Status was NOT set, so it sits in no column: ${edit.stderr.trim().slice(0, 300)}` };
  }
  return { state: "moved", board: label, item };
}
