/**
 * The one way a page asks AnviDeck to act (#76, #241). Every write (anything but GET) goes
 * through write(), and only the desktop app can send one: it travels over the app's private
 * channel (`invoke("write")` → the app → the server's stdin), never over HTTP. The server
 * refuses every write that reaches it over HTTP and logs it.
 *
 * In a browser (the read-only build) write() sends nothing and throws a WriteError saying where
 * actions are taken, so every screen's error path shows the reason.
 */

export type WriteMethod = "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * A write the server answered with an error. It carries the status and the whole JSON body,
 * because some answers say what to do next (a 409 for a stopped agent says resumable: true).
 */
export class WriteError extends Error {
  constructor(readonly status: number, readonly body: Record<string, unknown>) {
    super(typeof body.error === "string" ? body.error : `request failed (${status})`);
  }
}

/**
 * Send one write. Resolves with the parsed JSON answer; throws a WriteError carrying the
 * server's status, body and own reason when it answers an error (a refusal included).
 */
export async function write<T = unknown>(method: WriteMethod, url: string, body?: unknown): Promise<T> {
  // Desktop app (#239): writes travel only over the app's private channel, never HTTP.
  if (inDesktop()) {
    const { invoke } = await import("@tauri-apps/api/core");
    const r = await invoke<{ status: number; body: unknown }>("write", { method, path: url, body: body ?? null });
    const obj = r.body && typeof r.body === "object" ? (r.body as Record<string, unknown>) : {};
    if (r.status < 200 || r.status >= 300) throw new WriteError(r.status, obj);
    return r.body as T;
  }
  throw new WriteError(403, { error: BROWSER_READ_ONLY });
}

/** What a write from a browser page answers: nothing is sent. */
export const BROWSER_READ_ONLY =
  "AnviDeck takes actions only in its desktop app (bun run desktop:dev); this browser page is read-only";

/** True inside the Tauri desktop window. */
export function inDesktop(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
