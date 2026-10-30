import { Hono } from "hono";
import { isValidSid, listReplaySessions, readReplay } from "../readers/replay";

/**
 * Replay endpoints (issue #15), mounted at /api/replay.
 *
 *   GET /sessions?project=<name>
 *   GET /session/:sid?from=<iso>&to=<iso>&github=0&full=0
 *
 * Read only. Times in and out are ISO 8601; output is always UTC.
 */
const replay = new Hono();

replay.get("/sessions", (c) => {
  const project = c.req.query("project");
  if (!project) return c.json({ error: "missing ?project=<name>" }, 400);
  return c.json(listReplaySessions(project));
});

function parseTime(v: string | undefined): { ok: boolean; value: string | null } {
  if (!v) return { ok: true, value: null };
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? { ok: false, value: null } : { ok: true, value: new Date(ms).toISOString() };
}

replay.get("/session/:sid", async (c) => {
  const sid = c.req.param("sid");
  if (!isValidSid(sid)) return c.json({ error: "invalid session id" }, 400);
  const from = parseTime(c.req.query("from"));
  const to = parseTime(c.req.query("to"));
  if (!from.ok || !to.ok) return c.json({ error: "from/to must be ISO 8601 times, e.g. 2026-10-30T00:00:00Z" }, 400);
  return c.json(
    await readReplay(sid, {
      from: from.value,
      to: to.value,
      github: c.req.query("github") !== "0",
      fullText: c.req.query("full") !== "0",
    })
  );
});

export default replay;
