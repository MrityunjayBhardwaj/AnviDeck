// ui/write.ts: the one way a page writes (#76, #241). In the desktop app a write goes over the
// app's private channel (invoke "write"); in a browser nothing is sent and the page is told why.
// A refusal or error keeps the server's status and body, so a page can act on what the answer
// says (e.g. resumable: true on a 409).
import { afterEach, expect, test } from "bun:test";
import { BROWSER_READ_ONLY, write, WriteError } from "../ui/write";

const realFetch = globalThis.fetch;
const g = globalThis as { window?: unknown };
const realWindow = g.window;
afterEach(() => {
  globalThis.fetch = realFetch;
  g.window = realWindow;
});

/** The desktop window: the app answers each invoke("write") with {status, body}. */
function inApp(answer: (args: Record<string, unknown>) => { status: number; body: unknown }) {
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  g.window = {
    __TAURI_INTERNALS__: {
      invoke: async (cmd: string, args: Record<string, unknown>) => {
        calls.push({ cmd, args });
        return answer(args);
      },
      transformCallback: () => 0,
    },
  };
  return calls;
}

function noHttp() {
  let sent = 0;
  globalThis.fetch = (async () => { sent++; return new Response("{}"); }) as unknown as typeof fetch;
  return () => sent;
}

test("in the app: the write goes over the app's channel, never HTTP, and an error keeps status, body and reason", async () => {
  const sent = noHttp();
  const calls = inApp(() => ({ status: 409, body: { error: "the agent is not running (done)", resumable: true, status: "done" } }));
  const e = await write("POST", "/api/agents/a1/message", { text: "hi" }).catch((x) => x);
  expect(calls).toEqual([{ cmd: "write", args: { method: "POST", path: "/api/agents/a1/message", body: { text: "hi" } } }]);
  expect(sent()).toBe(0);
  expect(e).toBeInstanceOf(WriteError);
  expect(e.status).toBe(409);
  expect(e.body.resumable).toBe(true);
  expect(e.message).toBe("the agent is not running (done)");
});

test("in the app: an error with no JSON body still says its status; a success resolves with the answer", async () => {
  inApp(() => ({ status: 502, body: {} }));
  const e = await write("POST", "/api/x").catch((x) => x);
  expect(e.status).toBe(502);
  expect(e.message).toBe("request failed (502)");
  inApp((a) => ({ status: 201, body: { ok: 1, got: a.body } }));
  expect(await write("POST", "/api/x")).toEqual({ ok: 1, got: null });
});

test("in a browser: nothing is sent, and the refusal says actions are taken in the app", async () => {
  const sent = noHttp();
  g.window = {};
  const e = await write("POST", "/api/prs/1/merge", { head: "abc" }).catch((x) => x);
  expect(sent()).toBe(0);
  expect(e).toBeInstanceOf(WriteError);
  expect(e.status).toBe(403);
  expect(e.message).toBe(BROWSER_READ_ONLY);
});
