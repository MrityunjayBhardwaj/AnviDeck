import type { MiddlewareHandler } from "hono";

/**
 * Who may read AnviDeck. It serves session transcripts, memory and catalogues,
 * so by default only this machine's own browser may: the server listens on
 * loopback, and every request must name a loopback host and come from no
 * other web page. HOST=<address> opts into listening elsewhere (e.g. 0.0.0.0).
 */

export const DEFAULT_HOST = "127.0.0.1";

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "::1"]);

export function isLoopback(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return LOOPBACK_NAMES.has(h) || h.endsWith(".localhost") || /^127(\.\d{1,3}){3}$/.test(h);
}

/** The address to listen on: HOST if set, else loopback only. */
export function bindHost(env: Record<string, string | undefined> = process.env): string {
  const h = env.HOST?.trim();
  return h ? h : DEFAULT_HOST;
}

/** "localhost:4000" → "localhost"; "[::1]:4000" → "::1". */
function hostnameOf(hostHeader: string): string {
  const m = hostHeader.match(/^\[([^\]]+)\](?::\d+)?$/) ?? hostHeader.match(/^([^:]+)(?::\d+)?$/);
  return m ? m[1] : hostHeader;
}

/**
 * Refuse a request when
 *  - its Host is not a loopback name (a page on another site that re-pointed
 *    its own domain at 127.0.0.1 arrives with that domain as Host), unless the
 *    owner opted into a non-loopback bind; or
 *  - it carries an Origin other than the server's own, i.e. another web page
 *    (or its WebSocket) is asking. Same-origin GETs and non-browser clients
 *    such as curl send no Origin and pass.
 */
export function localOnly(bind: string = bindHost(), extraOrigins: readonly string[] = []): MiddlewareHandler {
  const anyHost = !isLoopback(bind);
  const allowed = new Set(extraOrigins);
  return async (c, next) => {
    const host = c.req.header("host") ?? "";
    if (!anyHost && !isLoopback(hostnameOf(host))) {
      return c.json({ error: `AnviDeck answers only on this machine (Host "${host}" refused)` }, 403);
    }
    const origin = c.req.header("origin");
    if (origin !== undefined && allowed.has(origin)) {
      // The desktop app's own window (#239): it reads from here, so the browser needs CORS.
      await next();
      c.res.headers.set("access-control-allow-origin", origin);
      c.res.headers.set("vary", "Origin");
      return;
    }
    if (origin !== undefined) {
      let ok = false;
      try { ok = new URL(origin).host === host; } catch { ok = false; }
      if (!ok) return c.json({ error: `AnviDeck answers only its own pages (Origin "${origin}" refused)` }, 403);
    }
    await next();
  };
}
