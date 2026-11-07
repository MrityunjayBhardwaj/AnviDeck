import type { Hono } from "hono";

/**
 * The desktop app's private channel to this server (#239, #240, #241): the only way anything
 * makes AnviDeck act.
 *
 * When ANVIDECK_DESKTOP=1 this server is started by the Tauri app as a sidecar. Reads are served
 * on loopback over HTTP; writes are refused there (server/guard.ts). Writes arrive as one JSON
 * line each on this process's stdin, which only the app holds, and are answered on stdout:
 *
 *   in:  {"id": 7, "method": "POST", "path": "/api/agents/a-1/stop", "body": {...}}
 *   out: <RS>ANVIDECK-REPLY {"id": 7, "status": 200, "body": {...}}
 *
 * dispatch() runs each one through the same app (guard, action log, routes) by calling app.fetch
 * in-process with FROM_APP, an env object no HTTP request can carry, so every route and the log
 * behave as they would for any request, and the guard knows it came from the app.
 *
 * Without the app (`bun run dev` in a browser) there is no channel: AnviDeck is read-only.
 */

export const DESKTOP = process.env.ANVIDECK_DESKTOP === "1";
/** The window's origin under Tauri on macOS (and Linux); allowed to read. */
export const DESKTOP_ORIGINS = ["tauri://localhost"] as const;

const CHANNEL = Symbol("anvideck-app-channel");
const FROM_APP = Object.freeze({ [CHANNEL]: true });
/** Did this request come through the app's channel? (Bun's own server passes its Server as env.) */
export const isFromApp = (env: unknown): boolean => !!env && typeof env === "object" && (env as Record<symbol, unknown>)[CHANNEL] === true;

/** Lines the app reads; anything else on stdout is a log line. */
const RS = "\u001e";
export function emit(kind: "READY" | "REPLY", payload: unknown): void {
  process.stdout.write(`${RS}ANVIDECK-${kind} ${JSON.stringify(payload)}\n`);
}

export type WriteRequest = { method: string; path: string; body?: unknown };
export type WriteAnswer = { status: number; body: unknown };

/** Why a request the channel was handed is not a write it carries, or null when it is. */
export function channelRefusal(r: Partial<WriteRequest>): string | null {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(String(r.method))) return `method ${r.method} is not a write`;
  if (typeof r.path !== "string" || !r.path.startsWith("/api/")) return "path must start with /api/";
  return null;
}

/**
 * Run one write from the app through the whole app, in-process. `host` is this server's own
 * loopback host:port, so the request looks like one of AnviDeck's own (the routers' Origin
 * check passes) and the action log records the same path it would for any write.
 */
export async function dispatch(app: Hono, r: WriteRequest, host: string): Promise<WriteAnswer> {
  const why = channelRefusal(r);
  if (why) return { status: 400, body: { error: `refused by AnviDeck's app channel: ${why}` } };
  const headers: Record<string, string> = { host, origin: `http://${host}` };
  if (r.body !== undefined && r.body !== null) headers["content-type"] = "application/json";
  const req = new Request(`http://${host}${r.path}`, {
    method: r.method,
    headers,
    body: r.body === undefined || r.body === null ? undefined : JSON.stringify(r.body),
  });
  try {
    const res = await app.fetch(req, FROM_APP);
    const text = await res.text();
    let body: unknown = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { error: `non-JSON answer (${text.length} chars)` }; }
    return { status: res.status, body };
  } catch (e) {
    return { status: 500, body: { error: e instanceof Error ? e.message : String(e) } };
  }
}

/** Answer writes from stdin until it closes; when the app goes away, so does this process. */
export async function serveWritePipe(app: Hono, opts: { port: number; onClose: () => void }): Promise<void> {
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
      let j: Partial<WriteRequest & { id: number }>;
      try { j = JSON.parse(line); } catch { emit("REPLY", { id: null, status: 400, body: { error: "refused by AnviDeck's app channel: not JSON" } }); continue; }
      if (typeof j?.id !== "number") { emit("REPLY", { id: null, status: 400, body: { error: "refused by AnviDeck's app channel: no id" } }); continue; }
      const id = j.id;
      void dispatch(app, j as WriteRequest, host).then((a) => emit("REPLY", { id, ...a }));
    }
  }
  opts.onClose();
}
