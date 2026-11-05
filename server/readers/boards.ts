import type { Run } from "./repo";

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
