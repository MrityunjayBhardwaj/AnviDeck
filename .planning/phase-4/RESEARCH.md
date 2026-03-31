---
phase: 4.3
confidence: HIGH
researcher: anvi-researcher
created: 2026-03-31T00:00:00Z
---

# Phase 4.3 Research: WebSocket for Real-Time Session Trace

## User Constraints

From CLAUDE.md and BUILD.md:
- Hono server, no Express. No framework switches.
- Plain TypeScript, no build pipeline complexity.
- Bun as runtime.
- Zero config, offline-first.
- Current server exports: `export default { port, fetch: app.fetch }`.

## Boundary Analysis

### Boundary 1: Bun default export to Bun.serve()

**What happens:** When a file has `export default { fetch, port }`, Bun internally wraps it with `Bun.serve()`. This is equivalent to calling `Bun.serve()` explicitly.

**Critical discovery:** The `websocket` property can be added to the default export object. Bun will wire it into the internal `Bun.serve()` call. The pattern is:

```ts
export default {
  port,
  fetch: app.fetch,
  websocket,   // <-- added
}
```

This means the current server pattern does NOT need to change to explicit `Bun.serve()`. Just add the `websocket` property.

```
Confidence: HIGH
Source: Hono GitHub issue #3618 (confirmed by maintainer), Bun docs (server page),
        and Hono source code (dist/adapter/bun/websocket.js)
Verified: Yes -- read the actual Hono adapter code AND confirmed via Bun docs that
          export default is equivalent to Bun.serve()
```

### Boundary 2: Hono fetch handler to Bun server instance

**What happens:** When Bun calls the fetch handler, it passes `(request, server)` as arguments. Hono's `app.fetch` maps this to `c.env.server` (or just `c.env` depending on how it's called). The `getBunServer(c)` helper extracts it via `"server" in c.env ? c.env.server : c.env`.

**Why this matters:** The `upgradeWebSocket` middleware calls `getBunServer(c)` to get the Bun server instance, then calls `server.upgrade(req)`. If the server isn't passed through, you get: `TypeError: env has to include the 2nd argument of fetch`.

**Confirmed working pattern:** When using `export default { fetch: app.fetch, websocket }`, Bun passes the server correctly through to Hono's fetch. No manual wiring needed.

```
Confidence: HIGH
Source: Read actual Hono source (dist/adapter/bun/server.js: getBunServer),
        dist/adapter/bun/websocket.js (upgradeWebSocket), Hono issue #3618
Verified: Yes -- traced the full call chain in Hono source code
```

### Boundary 3: Hono route to WebSocket upgrade

**What happens:** `upgradeWebSocket()` from `hono/bun` is used as a Hono route handler. It returns a middleware that:
1. Calls `getBunServer(c)` to get the Bun server
2. Calls `server.upgrade(c.req.raw, { data: { events, url, protocol } })`
3. Returns `new Response(null)` on success (Bun ignores this after upgrade)

The `websocket` object exported from `hono/bun` contains the Bun-side lifecycle handlers (`open`, `close`, `message`) that delegate to the per-route event callbacks stored in `ws.data.events`.

```
Confidence: HIGH
Source: Direct code reading of node_modules/hono/dist/adapter/bun/websocket.js
Verified: Yes -- read every line of the adapter
```

### Boundary 4: File system watcher to WebSocket broadcast

**What happens:** `fs.watch` on `/tmp/` fires events when files are created or modified. For individual log files, it fires `change` events on append. For the directory, it fires `rename` events when new files appear.

**Verified directly:** Ran test scripts confirming:
- `fs.watch('/tmp/anvi-hook-test.log')` fires `change` on append (confirmed)
- `fs.watch('/tmp/')` fires `rename` with filename when new `anvi-hook-*` files appear (confirmed)

**Tail pattern:** On `change` event, read new bytes from last-known file size to current size, parse as JSON lines, push to WebSocket clients. Track file size per watched file.

```
Confidence: HIGH
Source: Direct observation -- ran Bun scripts on macOS Darwin 24.4.0
Verified: Yes -- both /tmp/ directory watch and individual file watch confirmed working
```

## Technical Findings

### Finding 1: Minimal WebSocket integration pattern

The change to `server/index.ts` is minimal. Import two things, add one route, add one property to export:

```ts
// NEW imports
import { upgradeWebSocket, websocket } from "hono/bun";

// NEW route (can be defined in a separate routes/ws.ts file)
app.get("/ws", upgradeWebSocket((c) => ({
  onOpen(evt, ws) { /* add to clients set */ },
  onMessage(evt, ws) { /* handle client messages */ },
  onClose() { /* remove from clients set */ },
})));

// CHANGED export -- just add websocket property
export default {
  port,
  fetch: app.fetch,
  websocket,  // <-- this is the Bun-side handler from hono/bun
};
```

```
Confidence: HIGH
Source: Hono adapter source + Hono docs + confirmed pattern from GitHub issues
Verified: Yes
```

### Finding 2: createBunWebSocket is DEPRECATED

The older pattern `const { upgradeWebSocket, websocket } = createBunWebSocket()` still works but is deprecated. The current pattern imports `upgradeWebSocket` and `websocket` directly from `hono/bun`.

From the Hono type declarations:
```ts
/** @deprecated Import `upgradeWebSocket` and `websocket` directly from `hono/bun` instead. */
export declare const createBunWebSocket: <T>() => CreateWebSocket<T>;
```

```
Confidence: HIGH
Source: node_modules/hono/dist/types/adapter/bun/websocket.d.ts line 36-38
Verified: Yes -- read the actual type declaration
```

### Finding 3: Client tracking must be manual

Hono's WebSocket helper provides per-connection lifecycle events but no built-in broadcast mechanism. Broadcasting to all connected clients requires maintaining a `Set<WSContext>`:

```ts
const clients = new Set<WSContext>();

// In upgradeWebSocket callback:
onOpen(evt, ws) { clients.add(ws); },
onClose(evt, ws) { clients.delete(ws); },

// To broadcast:
function broadcast(data: string) {
  for (const client of clients) {
    if (client.readyState === 1) client.send(data);
  }
}
```

Alternative: Bun's native `server.publish(topic, data)` pub/sub. But this requires access to the Bun server instance outside of route handlers, which adds complexity. The manual Set approach is simpler for this use case (small number of dashboard clients).

```
Confidence: HIGH
Source: Hono WebSocket helper source (no broadcast API exists), Bun docs (pub/sub API)
Verified: Yes -- confirmed Hono helper has no broadcast, only per-connection send
```

### Finding 4: Log file tail strategy

For watching `/tmp/anvi-hook-*.log` and `/tmp/anvi-route-*.log`:

**Phase 1 -- Discover active log files:**
- Watch `/tmp/` directory for new files matching `anvi-hook-*` or `anvi-route-*`
- Also scan on startup for existing files (sessions already in progress)

**Phase 2 -- Tail individual files:**
- For each discovered log file, `fs.watch` it for `change` events
- Track `lastSize` per file
- On change: `Bun.file(path).slice(lastSize)` to read only new bytes
- Split by newline, parse each line as JSON, push to clients
- Update `lastSize`

**Why not `fs.watchFile` (polling)?** `fs.watch` uses OS-level events (kqueue on macOS), which is lower latency and lower CPU than polling. Since the hook writes are infrequent (only on Write|Edit operations in Claude Code), polling would waste resources.

**Edge case -- file rotation:** If session ends and new session starts with same ID (unlikely but possible), the file might be truncated. Detect by checking if current size < lastSize, and reset lastSize to 0.

```
Confidence: HIGH
Source: Direct observation (ran fs.watch on /tmp/ in Bun), Node.js fs docs
Verified: Yes -- tested both directory watch and file change detection
```

### Finding 5: WSContext type import

The WSContext type for the client Set can be imported from:
```ts
import type { WSContext } from "hono/ws";
```

The `hono/ws` path re-exports from `hono/dist/helper/websocket`.

```
Confidence: MEDIUM
Source: Hono type declarations (read dist/types/helper/websocket/index.d.ts)
Verified: Partially -- read types but did not compile-test the import path
```

## Invariants

**V-WS1: WebSocket and HTTP share one export.** The `websocket` handler object MUST be in the same `export default` as `fetch`. They cannot be separated -- Bun needs both in the same `Bun.serve()` call.

**V-WS2: upgradeWebSocket needs the Bun server.** The upgrade only works if Bun passes the server instance to the fetch handler. This happens automatically with `export default { fetch: app.fetch, websocket }` but would break if someone wraps `app.fetch` in a custom function that drops the second argument.

**V-WS3: One websocket handler for all routes.** The `websocket` object exported from `hono/bun` is a single handler that dispatches to per-route event callbacks via `ws.data.events`. You cannot have different `websocket` handlers for different routes -- there is exactly one, and it delegates.

## Risks and Mitigations

### Risk 1: TypeScript type mismatch on export default
**Severity:** Low (fixed in Hono 4.x)
**Details:** Earlier Hono versions had a type incompatibility between `BunWebSocketHandler` and Bun's `WebSocketHandler`. Fixed in Hono PR #3562. AnviDeck uses Hono 4.12.9 which includes the fix.
**Mitigation:** Already mitigated by current version. If types still complain, `satisfies` or a type assertion resolves it.

### Risk 2: /tmp/ directory watch noise on macOS
**Severity:** Medium
**Details:** `/tmp/` on macOS is a symlink to `/private/tmp/`. Other processes write to `/tmp/` frequently, generating many watch events. Filtering by filename prefix (`anvi-hook-`, `anvi-route-`) is necessary.
**Mitigation:** Filter in the watch callback. Only process filenames matching the expected prefix. The CPU cost of filtering string prefixes is negligible.

### Risk 3: Log file doesn't exist yet when dashboard starts
**Severity:** Low
**Details:** If no Claude Code session is active, there are no log files in `/tmp/`. The watcher should handle this gracefully.
**Mitigation:** Watch the `/tmp/` directory for new files. When a matching file appears, start tailing it. On startup, scan for existing files. No crash if nothing is found.

### Risk 4: Partial JSON line on read
**Severity:** Medium
**Details:** `Bun.file(path).slice(lastSize)` might read a partial line if the write hasn't flushed completely.
**Mitigation:** Buffer incomplete lines. If the last chunk doesn't end with `\n`, hold it and prepend to the next read. Standard line-buffering pattern.

### Risk 5: Memory leak from disconnected clients
**Severity:** Low
**Details:** If `onClose` doesn't fire (network drop without clean close), the client stays in the Set.
**Mitigation:** Periodic heartbeat ping. If a client doesn't respond within N seconds, remove it. Bun WebSocket supports `ws.ping()` natively. Alternatively, check `readyState` before sending and remove closed sockets.

## Recommended Approach

**Server changes (server/index.ts):**
1. Import `upgradeWebSocket` and `websocket` from `hono/bun`
2. Create a `routes/ws.ts` that exports the route handler using `upgradeWebSocket`
3. Mount the route at `/ws` on the Hono app
4. Add `websocket` to the export default object

**Log watcher (server/watchers/hook-logger.ts):**
1. Watch `/tmp/` directory for files matching `anvi-hook-*` and `anvi-route-*`
2. On new file: start tailing with `fs.watch` + size tracking
3. On change: read new bytes, parse JSON lines, call broadcast callback
4. On startup: scan for existing matching files

**Client tracking:**
1. Maintain a `Set<WSContext>` of connected clients
2. The broadcast function iterates the set, sends to each with readyState === 1
3. Wire the log watcher's callback to the broadcast function

**Message protocol (server to client):**
```ts
type WSMessage =
  | { type: "hook"; data: HookLogEntry }
  | { type: "route"; data: RouteLogEntry }
  | { type: "heartbeat" }
```

**Estimated scope:** ~3 files changed (index.ts), ~2 new files (ws.ts, hook-logger.ts). The WebSocket integration is straightforward because Hono already has first-class Bun WebSocket support.
