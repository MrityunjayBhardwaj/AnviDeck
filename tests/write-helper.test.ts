// ui/write.ts: the one way a page writes (#76). A refusal or error keeps the server's status and
// body, so a page can act on what the answer says (e.g. resumable: true on a 409).
import { afterEach, expect, test } from "bun:test";
import { write, WriteError } from "../ui/write";

const realFetch = globalThis.fetch;
const realDoc = (globalThis as { document?: unknown }).document;
afterEach(() => {
  globalThis.fetch = realFetch;
  (globalThis as { document?: unknown }).document = realDoc;
});

function page(token: string | null) {
  (globalThis as { document?: unknown }).document = {
    querySelector: () => (token === null ? null : { content: token }),
  };
}

test("an error answer throws a WriteError with the status, the body and the server's reason", async () => {
  page("t0k");
  let sent: Record<string, string> = {};
  globalThis.fetch = (async (_u: string, init: RequestInit) => {
    sent = init.headers as Record<string, string>;
    return new Response(JSON.stringify({ error: "the agent is not running (done)", resumable: true, status: "done" }), { status: 409 });
  }) as unknown as typeof fetch;
  const e = await write("POST", "/api/agents/a1/message", { text: "hi" }).catch((x) => x);
  expect(e).toBeInstanceOf(WriteError);
  expect(e.status).toBe(409);
  expect(e.body.resumable).toBe(true);
  expect(e.message).toBe("the agent is not running (done)");
  expect(sent["X-AnviDeck-Token"]).toBe("t0k");
});

test("an error with no JSON body still says its status", async () => {
  page(null);
  globalThis.fetch = (async () => new Response("nope", { status: 502 })) as unknown as typeof fetch;
  const e = await write("POST", "/api/x").catch((x) => x);
  expect(e).toBeInstanceOf(WriteError);
  expect(e.status).toBe(502);
  expect(e.message).toBe("request failed (502)");
});

test("a success resolves with the JSON answer", async () => {
  page("t");
  globalThis.fetch = (async () => new Response(JSON.stringify({ ok: 1 }), { status: 201 })) as unknown as typeof fetch;
  expect(await write("POST", "/api/x", {})).toEqual({ ok: 1 });
});
