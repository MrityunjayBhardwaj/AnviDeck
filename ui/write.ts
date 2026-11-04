/**
 * The one way a page asks AnviDeck to act (#76). Every write (anything but GET) goes through
 * write(): it sends this server's write token, read from the
 * <meta name="anvideck-write-token"> the server put into the page, in the X-AnviDeck-Token
 * header. The server refuses a write without it, and logs every write either way.
 */

const TOKEN_META = "anvideck-write-token";
const TOKEN_HEADER = "X-AnviDeck-Token";

/** The token the server placed in this page, or null when the page has none. */
export function writeToken(): string | null {
  return document.querySelector<HTMLMetaElement>(`meta[name="${TOKEN_META}"]`)?.content || null;
}

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
  const headers: Record<string, string> = {};
  const token = writeToken();
  // Sent without a token when the page has none: the server then refuses with its reason and logs it.
  if (token) headers[TOKEN_HEADER] = token;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = (await res.json().catch(() => ({}))) as unknown;
  const obj = j && typeof j === "object" ? (j as Record<string, unknown>) : {};
  if (!res.ok) throw new WriteError(res.status, obj);
  return j as T;
}
