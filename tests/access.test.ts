import { describe, expect, test, afterAll } from "bun:test";
import { Hono } from "hono";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { bindHost, isLoopback, localOnly, DEFAULT_HOST } from "../server/access";

function guarded(bind: string) {
  const app = new Hono();
  app.use("/*", localOnly(bind));
  app.get("/api/x", (c) => c.json({ ok: true }));
  return app;
}
const ask = (app: Hono, headers: Record<string, string>) =>
  app.request("http://ignored/api/x", { headers });

describe("bind address", () => {
  test("defaults to loopback, HOST opts out", () => {
    expect(bindHost({})).toBe("127.0.0.1");
    expect(bindHost({ HOST: "  " })).toBe(DEFAULT_HOST);
    expect(bindHost({ HOST: "0.0.0.0" })).toBe("0.0.0.0");
  });
  test("loopback names", () => {
    for (const h of ["localhost", "127.0.0.1", "127.0.1.1", "::1", "[::1]", "app.localhost", "LOCALHOST"]) expect(isLoopback(h)).toBe(true);
    for (const h of ["0.0.0.0", "192.168.1.37", "evil.com", "localhost.evil.com", "127.0.0.1.evil.com"]) expect(isLoopback(h)).toBe(false);
  });
});

describe("localOnly", () => {
  const app = guarded("127.0.0.1");

  test("this machine's own requests pass", async () => {
    expect((await ask(app, { host: "localhost:4000" })).status).toBe(200);
    expect((await ask(app, { host: "127.0.0.1:4000" })).status).toBe(200);
    expect((await ask(app, { host: "[::1]:4000" })).status).toBe(200);
    expect((await ask(app, { host: "localhost:4000", origin: "http://localhost:4000" })).status).toBe(200);
  });

  test("another web page is refused", async () => {
    for (const origin of ["https://example.com", "http://localhost:5173", "http://127.0.0.1:4000", "null"]) {
      const r = await ask(app, { host: "localhost:4000", origin });
      expect(r.status).toBe(403);
      expect(r.headers.get("access-control-allow-origin")).toBeNull();
    }
  });

  test("a non-loopback Host is refused (a re-pointed domain or a LAN address)", async () => {
    for (const host of ["evil.com:4000", "192.168.1.37:4000", "localhost.evil.com"]) {
      expect((await ask(app, { host })).status).toBe(403);
    }
  });

  test("HOST=0.0.0.0 accepts other hosts but still refuses other pages", async () => {
    const lan = guarded("0.0.0.0");
    expect((await ask(lan, { host: "192.168.1.37:4000" })).status).toBe(200);
    expect((await ask(lan, { host: "192.168.1.37:4000", origin: "http://192.168.1.37:4000" })).status).toBe(200);
    expect((await ask(lan, { host: "192.168.1.37:4000", origin: "https://example.com" })).status).toBe(403);
  });
});

describe("a request another site's page sent (#195)", () => {
  const app = new Hono();
  app.use("/*", localOnly("127.0.0.1", ["tauri://localhost"]));
  app.get("/api/x", (c) => c.json({ ok: true }));
  app.get("/ws", (c) => c.text("ws"));
  app.get("/", (c) => c.text("page"));
  app.get("/agent-host", (c) => c.text("page"));
  const at = (path: string, headers: Record<string, string>) => app.request(`http://ignored${path}`, { headers: { host: "127.0.0.1:4000", ...headers } });

  test("an <img> or script from another site (no Origin, Sec-Fetch-Site cross-site or same-site) is refused", async () => {
    for (const site of ["cross-site", "same-site"]) {
      for (const mode of ["no-cors", "cors"]) {
        const r = await at("/api/x?refresh=1", { "sec-fetch-site": site, "sec-fetch-mode": mode, "sec-fetch-dest": "image" });
        expect(r.status).toBe(403);
        expect((await r.json()).error).toContain(`Sec-Fetch-Site ${site}`);
      }
    }
  });

  test("a navigation from another site to the API or the WebSocket path is refused; to a page it loads", async () => {
    for (const path of ["/api/x?refresh=1", "/ws", "/api"]) expect((await at(path, { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" })).status).toBe(403);
    for (const path of ["/", "/agent-host"]) expect((await at(path, { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" })).status).toBe(200);
    // Only a navigation: another site's <img> or fetch of a page is refused like any other request.
    expect((await at("/agent-host", { "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors" })).status).toBe(403);
    // A path that only starts with "api" is a page, not the API.
    expect((await at("/apix", { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" })).status).not.toBe(403);
  });

  test("its own pages, a typed address, curl, and the desktop window pass", async () => {
    expect((await at("/api/x?refresh=1", { "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" })).status).toBe(200);
    expect((await at("/api/x?refresh=1", { "sec-fetch-site": "none", "sec-fetch-mode": "navigate" })).status).toBe(200);
    expect((await at("/api/x?refresh=1", {})).status).toBe(200);
    expect((await at("/api/x?refresh=1", { origin: "tauri://localhost", "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors" })).status).toBe(200);
  });
});

// The shipped server, started as `bun run dev` starts it.
describe("the real server", () => {
  const port = 4600 + Math.floor(Math.random() * 300);
  const env = { ...process.env, PORT: String(port) } as Record<string, string>;
  delete env.HOST;
  const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "..", "server", "index.ts")], { env, stdout: "pipe", stderr: "pipe" });
  afterAll(() => proc.kill());

  async function up(url: string, init?: RequestInit): Promise<Response> {
    let last: unknown;
    for (let i = 0; i < 60; i++) {
      try { return await fetch(url, init); } catch (e) { last = e; await Bun.sleep(100); }
    }
    throw last;
  }

  test("answers on loopback with no CORS grant, refuses other pages", async () => {
    const own = await up(`http://127.0.0.1:${port}/api/routing-architecture`);
    expect(own.status).toBe(200);
    expect(own.headers.get("access-control-allow-origin")).toBeNull();
    const other = await fetch(`http://127.0.0.1:${port}/api/routing-architecture`, { headers: { origin: "https://example.com" } });
    expect(other.status).toBe(403);
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  }, 15000);

  test("Notes' currency run is not started by another site's GET, and is by its own page (#195)", async () => {
    await up(`http://127.0.0.1:${port}/api/routing-architecture`);
    const url = `http://127.0.0.1:${port}/api/notes/currency?project=__no_such_project__&refresh=1`;
    const other = await fetch(url, { headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image" } });
    expect(other.status).toBe(403);
    // Its own page reaches the route (404: no such project), so the guard let it through.
    const own = await fetch(url, { headers: { "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" } });
    expect(own.status).toBe(404);
    expect(String((await own.json()).error)).toContain("__no_such_project__");
  }, 15000);

  test("a WebSocket from another page is refused, from its own page accepted", async () => {
    await up(`http://127.0.0.1:${port}/api/routing-architecture`);
    const open = (origin: string) => new Promise<string>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin } } as any);
      ws.onopen = () => { ws.close(); resolve("open"); };
      ws.onerror = () => resolve("refused");
    });
    expect(await open(`http://127.0.0.1:${port}`)).toBe("open");
    expect(await open("https://example.com")).toBe("refused");
  }, 15000);

  const lan = Object.values(networkInterfaces()).flat().find((a) => a && a.family === "IPv4" && !a.internal);
  test.skipIf(!lan)("is not reachable on this machine's network address", async () => {
    await up(`http://127.0.0.1:${port}/api/routing-architecture`);
    let reached = false;
    try { await fetch(`http://${lan!.address}:${port}/api/routing-architecture`, { signal: AbortSignal.timeout(2000) }); reached = true; } catch { reached = false; }
    expect(reached).toBe(false);
  }, 15000);
});
