import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Hono, MiddlewareHandler } from "hono";
import { localOnly } from "./access";
import type { ActionLog, ActionRecord } from "./action-log";

/**
 * Who may make AnviDeck act, and the record of every time something asked (#76).
 *
 * Reads stay open to this machine's own browser (localOnly). A write (any method other than
 * GET or HEAD under /api) is accepted only when
 *   - its Origin is present and names this server (a page on this server asked), and
 *   - it carries this server's write token in the X-AnviDeck-Token header.
 * The token is random per server start, never written to disk or a log, and reaches pages only
 * inside the HTML this server serves (a meta tag). Another page in the same browser can send a
 * request to localhost, but it cannot read our HTML, so it cannot learn the token.
 *
 * Every write, accepted or refused, is appended to the action log with its final status.
 */

export const TOKEN_HEADER = "x-anvideck-token";
export const TOKEN_META = "anvideck-write-token";

const isWrite = (method: string) => method !== "GET" && method !== "HEAD";

let processToken: string | null = null;
/** This server's write token: made once per process start, kept only in memory. */
export function serverWriteToken(): string {
  if (!processToken) processToken = randomBytes(32).toString("base64url");
  return processToken;
}

/** Constant-time comparison: both sides are hashed first, so lengths never leak or throw. */
export function tokenMatches(given: string | undefined, expected: string): boolean {
  if (given === undefined || expected === "") return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Put the token into a page this server serves, as <meta name="anvideck-write-token">. */
export function withWriteToken(html: string, token: string = serverWriteToken()): string {
  const i = html.indexOf("</head>");
  if (i < 0) throw new Error("page has no </head>; cannot place the write token");
  // base64url never needs HTML escaping.
  return `${html.slice(0, i)}<meta name="${TOKEN_META}" content="${token}">\n${html.slice(i)}`;
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
 * none (a bare curl, or a client that strips it). Kept on its own for routers mounted without
 * the full guard (e.g. in tests); writeGuard adds the token.
 */
export const sameOriginWrites: MiddlewareHandler = async (c, next) => {
  if (!isWrite(c.req.method)) return next();
  const why = originRefusal(c.req.header("origin"), c.req.header("host") ?? "");
  if (why) return c.json({ error: why }, 403);
  return next();
};

/** Same origin AND this server's token on every write. */
export function writeGuard(token: string): MiddlewareHandler {
  return async (c, next) => {
    if (!isWrite(c.req.method)) return next();
    const why = originRefusal(c.req.header("origin"), c.req.header("host") ?? "");
    if (why) return c.json({ error: why }, 403);
    const given = c.req.header(TOKEN_HEADER);
    if (given === undefined || given === "") {
      return c.json({ error: "this write carries no AnviDeck token; only pages this server served can act (reload the page)" }, 403);
    }
    if (!tokenMatches(given, token)) {
      return c.json({ error: "this write's AnviDeck token is not this server's (the server may have restarted: reload the page)" }, 403);
    }
    return next();
  };
}

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
 * status it got. Installed before every other middleware, so refusals by localOnly and the write
 * guard are recorded too: refused writes are the interesting ones.
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
      // Nothing but the guard and localOnly answers 403 under /api; a failed write is the route's own answer.
      result: status === 403 ? "refused" : status < 400 ? "accepted" : "failed",
      reason,
      body,
      ...(detail ? { detail } : {}),
    });
  };
}

/**
 * Install the whole guard on an app, in the one order that works: log first (so it sees every
 * refusal), then localOnly (this machine only), then the write guard on /api. Every router
 * mounted afterwards under /api is guarded and logged without any code of its own.
 */
export function installGuard(app: Hono, opts: { bind: string; token: string; log: ActionLog }): void {
  app.use("/api/*", logWrites(opts.log));
  app.use("/*", localOnly(opts.bind));
  app.use("/api/*", writeGuard(opts.token));
}
