import { Hono } from "hono";
import { isSessionId, readAgentSession, type AgentSessionPaths } from "../readers/agent-session";

/**
 * The Agents screen's read endpoint (#82), mounted at /api/agents-screen. Read only.
 *
 *   GET /session/:sid   one Claude Code session: its transcript (assistant and user messages,
 *                       hook attachments), anvi's hook meter rows and the live hook log rows,
 *                       each with its read status (shared/agents-screen-types.ts).
 *
 * Acting on an agent (message, stop, resume, permission answers) stays on /api/agents, through
 * the write guard and the action log.
 */
export function agentsScreenRoutes(p: AgentSessionPaths = {}): Hono {
  const r = new Hono();
  r.get("/session/:sid", (c) => {
    const sid = c.req.param("sid");
    if (!isSessionId(sid)) return c.json({ error: "invalid session id" }, 400);
    const tail = Number(c.req.query("tail") ?? "");
    return c.json(readAgentSession(sid, p, { tail: Number.isFinite(tail) && tail > 0 ? Math.min(tail, 50_000) : undefined }));
  });
  return r;
}

export default agentsScreenRoutes();
