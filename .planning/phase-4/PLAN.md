---
phase: 4
title: Real-Time Session Trace
goal: Watch the framework operate in real-time during a Claude Code session
status: planned
created: 2026-03-31
---

# Phase 4 Plan: Real-Time Session Trace

## Goal

When a Claude Code session is active, AnviDeck shows LIVE what the framework is doing: which boundaries fire, which files get loaded by routing, and how much context is used. Without this, AnviDeck is a static viewer. With this, it becomes an instrument.

## Design Analysis

### Existence Gate

1. **Who uses this?** The framework author (user), watching the cognitive OS operate during real work.
2. **What breaks without it?** The dashboard can't show anything about active sessions. It's a historical viewer only.
3. **Simpler alternative?** No — this is the core value proposition of AnviDeck vs the CLI dashboard.

### Invariants (what MUST hold)

**V1: Hook modification is backward-compatible.** The catalogue-context-injector.js is a shared system resource used by ALL projects. Adding logging MUST NOT change its existing behavior (context injection), performance characteristics, or error handling. The log write is append-only, fire-and-forget.

**V2: WebSocket is additive to HTTP.** The existing REST API continues to work identically. WS is a new channel, not a replacement. If WS is disconnected, the dashboard degrades to polling, not crashing.

**V3: Log files are ephemeral.** `/tmp/anvi-hook-*.log` files are session-scoped. They don't accumulate across reboots. No cleanup required.

**V4: One websocket handler dispatches all routes.** Bun/Hono constraint — the `websocket` export object is singular. All WS logic goes through one handler, dispatched by Hono's per-route callbacks.

**V5: File watcher → broadcast is the only data path.** No polling, no REST endpoint for real-time data. The pipeline is: hook writes log → fs.watch detects → parse JSON → broadcast to WS clients.

### Lifecycle (execution order)

```
1. Claude Code session starts
   → statusline hook writes /tmp/claude-ctx-{session_id}.json (existing)

2. User edits a file in Claude Code
   → PreToolUse fires catalogue-context-injector.js
   → Hook injects context into Claude (existing behavior)
   → Hook ALSO appends JSON line to /tmp/anvi-hook-{session_id}.log (NEW)

3. AnviDeck server is running
   → fs.watch on /tmp/ detects new/changed anvi-hook-*.log files
   → Reads new bytes from the file (tail pattern)
   → Parses JSON lines
   → Broadcasts to all connected WS clients

4. AnviDeck browser client
   → Connected via WebSocket to /ws
   → Receives hook events, routing events
   → CognitiveTrace component renders live feed
   → ContextBudget component updates totals
```

**Critical ordering:** Step 2 must complete the log write before step 3 reads it. Since the hook uses `fs.appendFileSync` (blocking write) and `fs.watch` fires after write completes, this is guaranteed.

### Ownership Map

| Data | Created by | Consumed by | Source of truth |
|------|-----------|-------------|-----------------|
| Hook log entries | catalogue-context-injector.js | hook-logger.ts (server) | /tmp/anvi-hook-*.log |
| Route log entries | route-logger hook (NEW) | hook-logger.ts (server) | /tmp/anvi-route-*.log |
| WS messages | ws.ts (server) | Browser WS client | Transient (not persisted) |
| Connected clients set | ws.ts | ws.ts (broadcast) | In-memory Set |
| Session context | gsd-statusline.js | ContextBudget component | /tmp/claude-ctx-*.json |
| Session ID | Claude Code runtime | All hooks, all log files | Hook stdin JSON |

### Pre-mortem (most likely failure modes)

**F1: session_id not available in PreToolUse hooks.** Research shows PostToolUse has `data.session_id` confirmed, but PreToolUse is unconfirmed. **Mitigation:** Test first. Fallback: derive session ID from existing `/tmp/claude-ctx-*.json` files (scan for most recent), or use a fixed filename like `anvi-hook-latest.log`.

**F2: /tmp/ watch noise on macOS.** Many processes write to `/tmp/`. **Mitigation:** Filter by filename prefix `anvi-hook-` and `anvi-route-` in the watch callback. Negligible CPU cost.

**F3: Partial JSON line on read.** Hook append and watcher read could race. **Mitigation:** Standard line-buffering — hold incomplete lines until next read.

**F4: No active session when dashboard opens.** **Mitigation:** Show empty state "No active session detected." Scan for existing log files on startup. Auto-detect when new files appear.

**F5: Context routing decisions are invisible.** The routing protocol fires inside Claude's reasoning, not via a hook. **Mitigation:** BUILD.md option (a) — PostToolUse hook that detects Read calls to spec files (e.g., `adaptive-observation.md`, `diagnose.md`). This captures what was loaded, not why — but that's sufficient for visualization.

### Chesterton Review (what exists to respect)

- `catalogue-context-injector.js` — 197 lines, well-structured. Log writing goes at the END, after the existing `process.stdout.write` call. Never before it.
- `file-watcher.ts` — existing watcher for `.anvi/` and `memory/` dirs. The new hook-logger is a SEPARATE watcher for `/tmp/` — don't merge them. Different concern, different lifecycle.
- `server/index.ts` — export default pattern. Add `websocket` property, nothing else changes.
- `gsd-context-monitor.js` — PostToolUse hook that already reads `data.session_id`. Pattern to follow for the route-logger hook.

---

## Task Breakdown

### Wave 1: Data Sources (no UI dependencies)

#### Task 4.1: Hook Logger — Add structured logging to catalogue-context-injector.js

**File:** `~/.claude/hooks/catalogue-context-injector.js`
**Change:** After the existing `process.stdout.write(JSON.stringify(output))` line, append a JSON log line to `/tmp/anvi-hook-{session_id}.log`.

**Log format:**
```json
{"ts":"ISO","sid":"session_id","file":"relative/path","boundaries":["B1","B2"],"fatality":false,"patterns":["SP8","SP9"],"invariants":["SV12"]}
```

**Key decisions:**
- Use `fs.appendFileSync` — blocking but guaranteed atomic for small writes
- Wrap log write in its OWN try/catch nested inside the existing try/catch — log failure NEVER affects the already-written stdout output
- Log write happens AFTER stdout write (existing behavior first)

**session_id resolution (two-step):**
- **Step 1 (probe):** Before implementation, add a temporary `console.error(JSON.stringify(Object.keys(data)))` to the hook, trigger it by editing a file in a project with catalogues, check stderr for field list. This confirms whether `session_id` is in PreToolUse stdin.
- **Step 2 (implement):** If `session_id` is present, use it directly. If ABSENT, use concrete fallback: scan `/tmp/claude-ctx-*.json` files, pick the one with most recent mtime, extract session ID from filename (`claude-ctx-{session_id}.json`). If no ctx files exist, use `"unknown"`. Document as known limitation.
- **Rationale:** Zero precedent for `session_id` in PreToolUse — `catalogue-context-injector.js` accesses only `data.tool_input` and `data.cwd`. `gsd-context-monitor.js` (PostToolUse) accesses `data.session_id` successfully.

**Verification:** Edit a file in a project with `.anvi/` catalogues. Check that `/tmp/anvi-hook-*.log` has a new JSON line AND the hook still injects context normally.

#### Task 4.2: Context Routing Logger — PostToolUse hook for Read detection

**New file:** `~/.claude/hooks/anvi-route-logger.js`
**Config:** Add to `settings.json` PostToolUse hooks, matcher: `Read`

**settings.json modification protocol (CRITICAL — shared system config):**
1. Back up `~/.claude/settings.json` to `~/.claude/settings.json.bak` before any change
2. Add the new hook entry AFTER the existing `gsd-context-monitor` entry in the PostToolUse array
3. Validate the modified JSON with `JSON.parse()` before writing
4. After writing, verify existing hooks still fire (edit a file in a project with catalogues, confirm context injection still works)

**Note on performance:** Matcher `Read` fires on EVERY Read tool call across ALL projects. The hook is lightweight (parse stdin, string-match filename, exit if no match), but this is a known cost — ~500 Read calls per session means 500 hook invocations. Acceptable for the 5ms per invocation budget.

**Logic:**
1. Parse stdin JSON for `data.tool_input.file_path` and `data.session_id`
2. Check if the file path matches known spec files: `adaptive-observation.md`, `diagnose.md`, `design.md`, `review.md`, `recover.md`, `dharana.md`, `dhyana-spec.md`, `base-layer.md`, `context-rot.md`, `translation.md`
3. If match: append to `/tmp/anvi-route-{session_id}.log`
4. If no match: exit silently

**Log format:**
```json
{"ts":"ISO","sid":"session_id","file":"adaptive-observation.md","category":"diagnose","tier":3}
```

**Category inference:** Map spec files to activity types (diagnose, design, review, implement, resume).

**Verification:** In a Claude Code session, trigger a diagnosis (e.g., "debug this"). Check `/tmp/anvi-route-*.log` for entries showing the spec files that were loaded. Verify existing PostToolUse hooks (gsd-context-monitor) still function.

### Wave 2: Server Infrastructure (depends on Wave 1 log format)

#### Task 4.3: WebSocket Server — ws.ts + server integration

**New file:** `server/routes/ws.ts`
**Modified:** `server/index.ts`

**ws.ts exports:**
- `wsRoute` — Hono route using `upgradeWebSocket` from `hono/bun`
- `broadcast(data: string)` — sends to all connected clients
- `getClientCount()` — for health checks

**server/index.ts changes:**
- Import `websocket` from `hono/bun` and `wsRoute` from `./routes/ws`
- Mount `wsRoute` at `/ws`
- Add `websocket` to export default object

**Message protocol (server → client):**
```typescript
type WSMessage =
  | { type: "hook"; data: HookLogEntry }
  | { type: "route"; data: RouteLogEntry }
  | { type: "session"; data: SessionContext }
  | { type: "heartbeat" }
```

**Heartbeat:** Every 30s, send `{ type: "heartbeat" }`. Client responds with pong. Remove unresponsive clients after 60s.

**Verification:** Start server, connect via `wscat ws://localhost:3000/ws`, confirm heartbeat messages arrive. REST API still works.

#### Task 4.4: Hook Log Watcher — server/watchers/hook-logger.ts

**New file:** `server/watchers/hook-logger.ts`

**Exports:**
- `watchHookLogs(onEntry: (entry: HookLogEntry | RouteLogEntry) => void): () => void`

**Logic:**
1. On startup: scan `/tmp/` for existing `anvi-hook-*` and `anvi-route-*` files
2. Watch `/tmp/` directory for new matching files
3. For each file: track `lastSize`, on change read new bytes, parse JSON lines
4. Handle partial lines with buffer
5. Call `onEntry` for each parsed entry
6. Return cleanup function

**Integration:** In `server/index.ts`, wire `watchHookLogs` callback to `broadcast`.

**Verification:** Manually append a JSON line to `/tmp/anvi-hook-test.log`. Connected WS client receives the entry.

### Wave 3: UI Components (depends on Wave 2 WS)

#### Task 4.5: Types — Add real-time types to shared/types.ts

**Add to `shared/types.ts`:**
```typescript
// -- Real-time types --

export interface HookLogEntry {
  ts: string;
  sid: string;
  file: string;
  boundaries: string[];
  fatality: boolean;
  patterns: string[];
  invariants: string[];
}

export interface RouteLogEntry {
  ts: string;
  sid: string;
  file: string;
  category: string;
  tier: number;
}

export interface SessionContext {
  sessionId: string;
  model?: string;
  contextRemaining?: number;
  cwd?: string;
}

export type WSMessage =
  | { type: "hook"; data: HookLogEntry }
  | { type: "route"; data: RouteLogEntry }
  | { type: "session"; data: SessionContext }
  | { type: "heartbeat" };
```

#### Task 4.6: CognitiveTrace Component — ui/components/CognitiveTrace.ts

**New file:** `ui/components/CognitiveTrace.ts`

**Three-panel layout:**
- **Left: Hook Activity** — live feed of boundary matches
  - Each entry: timestamp, file, boundaries (color-coded), fatality badge
  - Click to expand → show patterns and invariants
  - Counters: total fires, fatality fires, unique boundaries
- **Center: Dhyana State** — currently active checks (BUILD.md 4.5)
  - Scoped boundaries from the active project's dharana (fetched via REST `/api/project/:name`)
  - Per boundary: associated hetvabhasa patterns and vyapti invariants (from catalogue data)
  - Fire count per boundary this session (aggregated from incoming hook events)
  - Contribution flag per check: did any fire diverge from expected? (matched boundary had fatality or new pattern)
  - Data flow: on first hook event, detect project from `cwd` in session context → fetch dharana via API → render scoped boundaries. Then correlate incoming hook events to update fire counts.
- **Right: Routing Decisions** — live feed of spec file loads
  - Each entry: timestamp, category badge, file loaded, tier indicator
  - Group by activity type

**Data source:** WebSocket messages (hook, route, session) + REST API for dharana data.

**State:** Maintained in component closure — hook entries array, route entries array, dhyana state (boundaries, fire counts, contribution flags). Cleared on session change.

**Verification:** With WS connected and hook firing:
1. Hook entries appear in real-time with color coding (red for fatality)
2. Dhyana panel shows scoped boundaries with fire counts incrementing
3. Contribution flags update when a fatality boundary is touched

#### Task 4.7: ContextBudget Component — ui/components/ContextBudget.ts

**New file:** `ui/components/ContextBudget.ts`

**Three-tier bar visualization:**
```
Tier 1 (always): ██████████████░░░░░░ 39k
Tier 2 (hook):   ██░░░░░░░░░░░░░░░░░ ~2k (last injection)
Tier 3 (routed): ████████░░░░░░░░░░░ ~18k
Total:           ████████████████████░ 59k / 200k
```

**Data sources:**
- Tier 1: fixed estimate (39k) — CLAUDE.md + project CLAUDE.md + base-layer
- Tier 2: from hook log entries — estimate injection size
- Tier 3: from route log entries — sum loaded spec file sizes
- Total capacity: from `/tmp/claude-ctx-*.json` if available, else 200k default

**Updates live** as new hook/route entries arrive via WS.

**Verification:** Budget bars update when hook fires and when routing loads spec files.

#### Task 4.8: App Integration — wire new views into app.ts

**Modified:** `ui/app.ts`

**Changes:**
- Add "trace" view to routing: `currentView: "home" | "project" | "trace"`
- Add navigation item in sidebar: "Live Trace" with active session indicator
- Import and render CognitiveTrace + ContextBudget when in trace view
- Establish WebSocket connection on app init
- Route WS messages to appropriate components

**Verification:** Click "Live Trace" in sidebar → shows CognitiveTrace + ContextBudget. Data flows from WS.

### Wave 4: Styles

#### Task 4.9: CSS — Add styles for new components

**Modified:** `ui/styles/deck.css`

**New sections:**
- `.cognitive-trace` — two-panel layout
- `.hook-entry`, `.route-entry` — log feed items
- `.fatality-badge` — red pulse animation
- `.context-budget` — bar visualization with tier colors
- `.tier-bar` — progress bar segments
- Active session indicator in sidebar

**Colors:** Consistent with existing theme. Fatality = `var(--red)`, clean = `var(--green)`, routing = `var(--cyan)`.

---

## Execution Order

```
Wave 1 (parallel):  4.1 Hook Logger  |  4.2 Route Logger
                         ↓                    ↓
Wave 2 (parallel):  4.3 WebSocket    |  4.4 Hook Log Watcher
                         ↓                    ↓
                    (wire together in server/index.ts)
                              ↓
Wave 3 (sequential): 4.5 Types → 4.6 CognitiveTrace → 4.7 ContextBudget → 4.8 App Integration
                              ↓
Wave 4:              4.9 CSS
```

**Waves 1-2 are server-side, Waves 3-4 are client-side.** Each wave can be verified independently before proceeding.

## Verification Criteria (Phase Goal)

The phase is DONE when:
1. Start a Claude Code session on a project with `.anvi/` catalogues
2. Edit a file that touches a known boundary
3. AnviDeck (browser) shows the hook firing in real-time with boundary names
4. Dhyana panel shows the scoped boundaries with fire counts incrementing per hook event
5. Dhyana panel shows associated hetvabhasa patterns and vyapti invariants per boundary
6. Trigger a "debug this" → AnviDeck shows routing decision (spec files loaded)
7. Context budget bars update with each event
8. REST API still works (backward compatible)
9. Hook still injects context into Claude (backward compatible)
10. All existing PostToolUse hooks still function after settings.json modification
