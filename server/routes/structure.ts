import { Hono } from "hono";
import { listStructure, readStructure } from "../readers/structure";

// Mounted at /api/structure.
//   GET /api/structure                 → every project: has a design or not (no measuring)
//   GET /api/structure/:project?ref=…  → the guard's graph and verdicts at that commit
//                                        (default: the repository's default branch, as the guard picks it)
const structure = new Hono();

structure.get("/", (c) => {
  const r = listStructure();
  return c.json(r, r.status === "ok" ? 200 : 503);
});

structure.get("/:project", async (c) => {
  const r = await readStructure(c.req.param("project"), { ref: c.req.query("ref") ?? null });
  // 200 for every answer the reader could give, including "not measured" and "nothing blocked":
  // the status field says which. 404 only for a project nobody knows.
  const unknown = r.status === "could-not-read" && /^no project named /.test(r.reason);
  return c.json(r, unknown ? 404 : 200);
});

export default structure;
