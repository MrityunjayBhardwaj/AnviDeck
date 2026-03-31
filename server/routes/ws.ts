import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import type { WSContext } from "hono/ws";

const ws = new Hono();

// Connected dashboard clients
const clients = new Set<WSContext>();

ws.get(
  "/ws",
  upgradeWebSocket(() => ({
    onOpen(_evt, wsCtx) {
      clients.add(wsCtx);
      console.log(`[ws] client connected (${clients.size} total)`);
    },
    onClose(_evt, wsCtx) {
      clients.delete(wsCtx);
      console.log(`[ws] client disconnected (${clients.size} total)`);
    },
    onMessage(evt, _wsCtx) {
      // Client can send "pong" in response to heartbeat — no action needed
      void evt;
    },
  }))
);

/**
 * Broadcast a message to all connected WebSocket clients.
 */
export function broadcast(data: string): void {
  for (const client of clients) {
    try {
      if (client.readyState === 1) {
        client.send(data);
      } else {
        clients.delete(client);
      }
    } catch {
      clients.delete(client);
    }
  }
}

/**
 * Get number of connected clients.
 */
export function getClientCount(): number {
  return clients.size;
}

// Heartbeat: every 30s send a ping to detect stale connections
setInterval(() => {
  const msg = JSON.stringify({ type: "heartbeat" });
  for (const client of clients) {
    try {
      if (client.readyState === 1) {
        client.send(msg);
      } else {
        clients.delete(client);
      }
    } catch {
      clients.delete(client);
    }
  }
}, 30_000);

export default ws;
