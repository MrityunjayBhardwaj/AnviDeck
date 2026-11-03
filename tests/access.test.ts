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
