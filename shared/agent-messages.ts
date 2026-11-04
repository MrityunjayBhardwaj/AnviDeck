/**
 * Talking to a running agent (#79): what the owner sends, what the agent reads, and whether it
 * arrived. Shared by the host (server/agents/host.ts) and the pages that show the transcript.
 *
 * A message is plain text, or a line comment on the agent's diff. Each one the host takes is
 * written into the agent's transcript as a host event, and its delivery is written there too:
 *   { event: "message-sent", messageId, said, comment?, text }   queued for the agent
 *   { event: "message-delivered", messageId, by }                the agent's turn took it in
 *   { event: "message-not-delivered", messageId, reason }        it never reached the agent
 * The transcript is therefore the record of every message and what became of it.
 */

/** A comment on one line of the agent's diff. `lineText` is the line as the owner saw it. */
export interface LineComment {
  file: string;
  line: number;
  lineText: string;
  text: string;
}

export type MessageRequest = { kind: "text"; text: string } | { kind: "comment"; comment: LineComment };

export type DeliveryState = "queued" | "delivered" | "not-delivered";

export interface SentMessage {
  messageId: string;
  /** What the owner wrote: the message, or the comment's own words. */
  said: string;
  comment?: Omit<LineComment, "text">;
  /** Exactly what the agent receives. */
  text: string;
  sentAt: string;
  state: DeliveryState;
  /** How delivery was seen ("started": Claude Code began a turn with it; "result": the turn's result named it). */
  by?: string;
  reason?: string;
}

export const MAX_MESSAGE_CHARS = 20_000;

/** Read a POST body: `{ text }` or `{ comment: { file, line, lineText, text } }`. Errors are plain words. */
export function parseMessageRequest(body: Record<string, unknown>): MessageRequest | { error: string } {
  const hasText = body.text !== undefined;
  const hasComment = body.comment !== undefined;
  if (hasText === hasComment) return { error: "send either text or a comment ({ file, line, lineText, text }), not both or neither" };
  if (hasText) {
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return { error: "message is empty" };
    if (text.length > MAX_MESSAGE_CHARS) return { error: `message is longer than ${MAX_MESSAGE_CHARS} characters` };
    return { kind: "text", text };
  }
  const c = body.comment;
  if (!c || typeof c !== "object" || Array.isArray(c)) return { error: "comment must be an object { file, line, lineText, text }" };
  const o = c as Record<string, unknown>;
  const file = typeof o.file === "string" ? o.file.trim() : "";
  if (!file) return { error: "comment.file is empty" };
  if (typeof o.line !== "number" || !Number.isInteger(o.line) || o.line <= 0) return { error: "comment.line must be a positive whole number" };
  if (typeof o.lineText !== "string") return { error: "comment.lineText must be the line's text (it may be empty)" };
  const text = typeof o.text === "string" ? o.text.trim() : "";
  if (!text) return { error: "comment.text is empty" };
  if (text.length + o.lineText.length > MAX_MESSAGE_CHARS) return { error: `comment is longer than ${MAX_MESSAGE_CHARS} characters` };
  return { kind: "comment", comment: { file, line: o.line, lineText: o.lineText, text } };
}

/** The words the agent reads. A line comment names the file, the line number and the line's text. */
export function renderForAgent(req: MessageRequest): string {
  if (req.kind === "text") return req.text;
  const { file, line, lineText, text } = req.comment;
  return [
    `The owner left a comment on your change, on ${file} line ${line}, where the line reads:`,
    `    ${lineText}`,
    "",
    text,
  ].join("\n");
}

/** Every message in a transcript, with what became of it. Order is the order they were sent. */
export function messagesIn(lines: { at: string; from: string; message: unknown }[]): SentMessage[] {
  const byId = new Map<string, SentMessage>();
  for (const l of lines) {
    if (l.from !== "host") continue;
    const m = l.message as Record<string, unknown> | null;
    const id = typeof m?.messageId === "string" ? m.messageId : undefined;
    if (!m || !id) continue;
    if (m.event === "message-sent") {
      byId.set(id, {
        messageId: id,
        said: String(m.said ?? ""),
        comment: m.comment as SentMessage["comment"],
        text: String(m.text ?? ""),
        sentAt: l.at,
        state: "queued",
      });
    } else {
      const s = byId.get(id);
      if (!s || s.state !== "queued") continue;
      if (m.event === "message-delivered") {
        s.state = "delivered";
        s.by = typeof m.by === "string" ? m.by : undefined;
      } else if (m.event === "message-not-delivered") {
        s.state = "not-delivered";
        s.reason = typeof m.reason === "string" ? m.reason : undefined;
      }
    }
  }
  return [...byId.values()];
}
