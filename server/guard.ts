import type { Hono, MiddlewareHandler } from "hono";
import { localOnly } from "./access";
import type { ActionLog, ActionRecord } from "./action-log";

/**
 * Who may make AnviDeck act, and the record of every time something asked (#76, #241).
 *
 * Nothing that reaches AnviDeck over HTTP can make it act. Reads (GET, HEAD) are served on
 * loopback to this machine (localOnly); every other request over HTTP is refused, whatever it
 * carries. A write runs only when it arrives through the desktop app's private channel: the
 * window's `invoke` → the app's Rust command → this process's stdin, handed to the app
 * in-process with the channel's own env (server/desktop.ts). No port, token or header can
 * forge that env, so no other process on the machine (an agent's shell included) can act.
 *
 * Before #241 a write over HTTP was accepted with this server's token, which was placed in the
 * page; any local process could read the page, so the token stopped other web pages but not
 * local programs (#147). The token is gone.
 *
 * Every write, accepted or refused, is appended to the action log with its final status.
 */

export const isWrite = (method: string) => method !== "GET" && method !== "HEAD";

/** The answer to any write that reached AnviDeck over HTTP. */
export const HTTP_WRITE_REFUSAL =
  "AnviDeck takes actions only from its desktop app's window, over the app's private channel; nothing sent over HTTP can act, so this page and this port are read-only";

/** Refuse every write that did not come through the app's channel (#241). */
export function writesOnlyFromApp(isFromApp: (env: unknown) => boolean): MiddlewareHandler {
  return async (c, next) => {
    if (isWrite(c.req.method) && !isFromApp(c.env)) return c.json({ error: HTTP_WRITE_REFUSAL }, 403);
    return next();
  };
}

/** Why a write's Origin is refused, or null when it names this server. */
function originRefusal(origin: string | undefined, host: string): string | null {
  let ok = false;
  try {
    ok = origin !== undefined && new URL(origin).host === host;
  } catch {
    ok = false;
  }
  return ok ? null : `actions are taken only from AnviDeck's own pages (Origin ${origin === undefined ? "missing" : `"${origin}"`} refused)`;
}

/**
 * Writes must come from one of AnviDeck's own pages: the Origin header must be present and name
 * this server. localOnly already refuses a foreign Origin; this also refuses a write that carries
 * none (a bare curl, or a client that strips it). A second check inside the write routers, for
 * routers mounted without the full guard (tests); the app's channel sends this server's Origin.
 */
export const sameOriginWrites: MiddlewareHandler = async (c, next) => {
  if (!isWrite(c.req.method)) return next();
  const why = originRefusal(c.req.header("origin"), c.req.header("host") ?? "");
  if (why) return c.json({ error: why }, 403);
  return next();
};

const PREVIEW = 80;
const MAX_BODY_READ = 64 * 1024;

/** A short, safe view of a write's JSON body: strings cut to a preview, nested values not kept. */
export function previewBody(text: string): Record<string, unknown> | string | undefined {
  if (text === "") return undefined;
  let b: unknown;
  try {
    b = JSON.parse(text);
  } catch {
    return `not JSON (${text.length} chars)`;
  }
  if (!b || typeof b !== "object" || Array.isArray(b)) return `JSON ${Array.isArray(b) ? "array" : typeof b}`;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(b as Record<string, unknown>).slice(0, 8)) {
    if (typeof v === "string") out[k] = v.length > PREVIEW ? `${v.slice(0, PREVIEW)}… (${v.length} chars)` : v;
    else if (typeof v === "number" || typeof v === "boolean" || v === null) out[k] = v;
    else out[k] = Array.isArray(v) ? `[array of ${v.length}]` : "[object]";
  }
  return out;
}

/** The context key a route sets to name what it acted on; logWrites records it as `detail`. */
export const AUDIT_KEY = "anvideckAudit";

/** Only short strings and numbers are kept, so a route cannot put file contents in the log. */
function auditOf(v: unknown): Record<string, string | number> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, string | number> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (typeof x === "number") out[k] = x;
    else if (typeof x === "string") out[k] = x.length > 4096 ? `${x.slice(0, 4096)}… (${x.length} chars)` : x;
  }
  return Object.keys(out).length ? out : undefined;
}

/** "/api/agents/a-1/stop" → area "agents", target "a-1". */
function areaAndTarget(path: string): { area: string; target?: string } {
  const parts = path.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  return { area: parts[0] ?? "", target: parts[1] ? decodeURIComponent(parts[1]) : undefined };
}

/**
 * Append one line per write to the action log, after the request has been answered, with the
 * status it got. Installed before every other middleware, so refusals by writesOnlyFromApp and
 * localOnly are recorded too: refused writes are the interesting ones.
 */
export function logWrites(log: ActionLog, now: () => Date = () => new Date()): MiddlewareHandler {
  return async (c, next) => {
    if (!isWrite(c.req.method)) return next();
    const len = Number(c.req.header("content-length") ?? "0");
    let body: ActionRecord["body"];
    if (len > MAX_BODY_READ) body = `not read (${len} bytes)`;
    else {
      try {
        body = previewBody(await c.req.raw.clone().text());
      } catch {
        body = "unreadable";
      }
    }
    await next();
    const status = c.res.status;
    const { area, target: fromPath } = areaAndTarget(c.req.path);
    let reason: string | undefined;
    let id: string | undefined;
    try {
      if ((c.res.headers.get("content-type") ?? "").includes("json")) {
        const j = (await c.res.clone().json()) as { error?: unknown; id?: unknown };
        if (typeof j?.error === "string") reason = j.error.slice(0, 300);
        if (typeof j?.id === "string") id = j.id;
      }
    } catch {
      /* a body that is not JSON keeps no reason */
    }
    const detail = auditOf((c.get as (k: string) => unknown)(AUDIT_KEY));
    log.append({
      at: now().toISOString(),
      method: c.req.method,
      path: c.req.path,
      area,
      target: fromPath ?? id,
      status,
      // Nothing but the guard, localOnly and the routers' Origin check answer 403 under /api; a failed write is the route's own answer.
      result: status === 403 ? "refused" : status < 400 ? "accepted" : "failed",
      reason,
      body,
      ...(detail ? { detail } : {}),
    });
  };
}

/**
 * Install the whole guard on an app, in the one order that works: log first (so it sees every
 * refusal), then refuse every write that did not come through the app's channel, then localOnly
 * (this machine only). Every router mounted afterwards is guarded and logged without any code of
 * its own. `isFromApp` says whether a request came through the channel (desktop.ts isFromApp).
 */
export function installGuard(
  app: Hono,
  opts: { bind: string; log: ActionLog; isFromApp: (env: unknown) => boolean; origins?: readonly string[] },
): void {
  app.use("/api/*", logWrites(opts.log));
  app.use("/*", writesOnlyFromApp(opts.isFromApp));
  app.use("/*", localOnly(opts.bind, opts.origins ?? []));
}
