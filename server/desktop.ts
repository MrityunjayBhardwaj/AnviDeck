import type { Hono } from "hono";

/**
 * The desktop app's side of the sidecar (#239, #240).
 *
 * When ANVIDECK_DESKTOP=1 this server is started by the Tauri app as a sidecar. Reads stay on
 * HTTP on loopback; writes never arrive over HTTP (the guard refuses them). They arrive as one
 * JSON line each on this process's stdin, which only the app holds, and are answered on stdout:
 *
 *   in:  {"id": 7, "method": "POST", "path": "/api/agents/a-1/stop", "body": {...}}
 *   out: <RS>ANVIDECK-REPLY {"id": 7, "status": 200, "body": {...}}
 *
 * Each write is run through the same app (guard, action log, routes) by calling app.fetch
 * in-process with PIPE_ENV, so every route and the log behave exactly as they do today.
 */

export const DESKTOP = process.env.ANVIDECK_DESKTOP === "1";
/** The window's origin under Tauri on macOS. */
export const DESKTOP_ORIGINS = ["tauri://localhost"] as const;

const PIPE = Symbol("anvideck-pipe");
const PIPE_ENV = { [PIPE]: true };
export const isPipe = (env: unknown): boolean => !!env && typeof env === "object" && (env as Record<symbol, unknown>)[PIPE] === true;

/** Lines the app reads; anything else on stdout is a log line. */
const RS = "\u001e";
export function emit(kind: "READY" | "REPLY", payload: unknown): void {
  process.stdout.write(`${RS}ANVIDECK-${kind} ${JSON.stringify(payload)}\n`);
}

type PipeRequest = { id: number; method: string; path: string; body?: unknown };

function parse(line: string): PipeRequest | string {
  let j: unknown;
  try { j = JSON.parse(line); } catch { return "not JSON"; }
  const r = j as Partial<PipeRequest>;
  if (typeof r?.id !== "number") return "no id";
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(String(r.method))) return `method ${r.method} is not a write`;
  if (typeof r.path !== "string" || !r.path.startsWith("/api/")) return "path must start with /api/";
  return r as PipeRequest;
}

/** Answer writes from stdin until it closes; when the app goes away, so does this process. */
export async function serveWritePipe(app: Hono, opts: { port: number; token: string; tokenHeader: string; onClose: () => void }): Promise<void> {
  const host = `127.0.0.1:${opts.port}`;
  const decoder = new TextDecoder();
  let buf = "";
  const reader = Bun.stdin.stream().getReader();
  for (;;) {
    const { value: chunk, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const r = parse(line);
      if (typeof r === "string") {
        const id = (() => { try { return (JSON.parse(line) as { id?: unknown }).id; } catch { return null; } })();
        emit("REPLY", { id, status: 400, body: { error: `pipe request refused: ${r}` } });
        continue;
      }
      void (async () => {
        const headers: Record<string, string> = { host, origin: `http://${host}`, [opts.tokenHeader]: opts.token };
        if (r.body !== undefined) headers["content-type"] = "application/json";
        const req = new Request(`http://${host}${r.path}`, { method: r.method, headers, body: r.body === undefined ? undefined : JSON.stringify(r.body) });
        try {
          const res = await app.fetch(req, PIPE_ENV);
          const text = await res.text();
          let body: unknown = {};
          try { body = text ? JSON.parse(text) : {}; } catch { body = { error: `non-JSON answer (${text.length} chars)` }; }
          emit("REPLY", { id: r.id, status: res.status, body });
        } catch (e) {
          emit("REPLY", { id: r.id, status: 500, body: { error: e instanceof Error ? e.message : String(e) } });
        }
      })();
    }
  }
  opts.onClose();
}
