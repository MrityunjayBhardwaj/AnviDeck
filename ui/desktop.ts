/**
 * Desktop app reads (#239, spike). The window's pages are bundled in the app (tauri://localhost),
 * while reads are served by the sidecar on loopback. The app tells the page which port with
 * window.__ANVIDECK_ORIGIN__ before any script runs. This shim sends every same-origin read
 * ("/api/…", "/ws") there. Writes never come through here: ui/write.ts uses the app's channel.
 *
 * Spike shortcut: a global patch of fetch and WebSocket. The real migration (#240) should give
 * the UI one apiUrl() helper instead.
 */
declare global {
  interface Window { __ANVIDECK_ORIGIN__?: string }
}

const origin = typeof window !== "undefined" ? window.__ANVIDECK_ORIGIN__ : undefined;

if (origin) {
  const base = new URL(origin);
  const rewrite = (u: string): string => (u.startsWith("/") && !u.startsWith("//") ? `${origin}${u}` : u);
  const realFetch = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === "string") return realFetch(rewrite(input), init);
    if (input instanceof URL && input.host === location.host) return realFetch(`${origin}${input.pathname}${input.search}`, init);
    return realFetch(input, init);
  }) as typeof fetch;
  const RealWS = window.WebSocket;
  class DesktopWS extends RealWS {
    constructor(url: string | URL, protocols?: string | string[]) {
      const u = new URL(String(url), location.href);
      if (u.host === location.host) { u.protocol = "ws:"; u.host = base.host; }
      super(u, protocols);
    }
  }
  window.WebSocket = DesktopWS as typeof WebSocket;
}

export {};
