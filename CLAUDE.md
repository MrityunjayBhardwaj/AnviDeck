## Project: AnviDeck

A local, browser-based workspace for working with Claude Code agents on projects that use the Ānvīkṣikī (anvi) framework. You see what each agent is doing and what anvi told it, review its changes, answer it, and steer the work, all from one screen on your own machine.

AnviDeck started as an observability dashboard that only read the framework's files. On 2026-11-05 the owner decided it becomes a full agent workspace in this same repo, matching the prototype at https://claude.ai/artifact/RucrgeLUJLfb8HaCTUGViF (tracking issue #93). That work is in progress: **on `main` today no workspace action exists yet** (every HTTP route is a GET; see "Current state"). Do not describe planned behaviour as shipped. An item counts as done only once its PR is merged on `main`.

### Required Reading
1. `BUILD.md`: the workspace specification: screens, the reader / agent-host split, the safety model, build order, what gets retired, and what exists today.
2. Issue #93 (`gh issue view 93 --repo MrityunjayBhardwaj/AnviDeck`): build order and the owner's decisions. Each step has its own issue (#72–#92).
3. `ref/ANVI_THESIS.md`: why the framework exists; Part VI covers the three-tier context architecture.
4. `ref/DATA_EXAMPLES.md`: input and output for the data types the parser handles.

### The rule that shapes the code: readers read, one module acts

- **Readers** (`server/readers/*`, the GET routes in `server/routes/*`, `shared/parser.ts`) are read-only and stay that way. They never write into a project, a catalogue, memory or the anvi store. What they do today besides reading files: spawn `git`, `gh` and `node` to ask questions (log, show, ls-tree, `gh pr view`, `gh search prs`, `gh issue list`, anvi's structure guard), and the structure reader makes a scratch folder under `ANVIDECK_STRUCTURE_TMP` (default `/private/tmp/claude-501/anvideck-structure`) for the guard's temporary checkouts.
- **The agent host** (planned, #75) is the only code that acts. It runs Claude Code agents through the Claude Agent SDK's `query()`: start, stream, stop, resume, and the permission callback. Every other write AnviDeck makes goes through it or through the action log.
- A test fails if a reader imports the agent host, the action log or the write guard, or calls a file write API (#76, on `main`: `tests/reader-actor-split.test.ts`; the structure reader's scratch folder is its one listed exemption).

**What AnviDeck will write once the workspace lands** (none of this is on `main` yet):
- Agent actions: start an agent (#75), in its own worktree and branch for an issue (#78, on main: `POST /api/agents/from-issue`); stop and resume it; answer its permission requests (#77); send it messages and diff comments (#79).
- Merge a PR, only when you press **Merge**, and only the head you reviewed (#85).
- Edit a file from the Code screen, only one no running agent is touching (#88).
- Its own records, in AnviDeck's own folder in the store: the action log (#76), your calls on blocked edits (#86), the agent registry (#75).

**Changed only by agents, not by AnviDeck directly:** catalogues (`.anvi/`), memory and Ground Truth docs. A change to them (Re-check a batch, Promote) starts an agent with that task (#89); the agent makes the change, as in a terminal session.

### Safety model

| Guard | Status |
|---|---|
| This machine only: listens on `127.0.0.1` unless `HOST` is set; refuses a request whose Host is not a loopback name or whose Origin is another page (`server/access.ts`, `tests/access.test.ts`) | On `main` (#66) |
| Every write endpoint requires the same origin **and** a per-server token placed in the page; anything else is refused (`server/guard.ts`, installed on the whole app before any route; pages write through `ui/write.ts`; `tests/write-guard.test.ts`) | On `main` (#76) |
| Every action (what, target, result, time) is appended to the action log (`actions.jsonl` in the agent registry folder; `GET /api/actions`) and shown in History | Logged on `main` (#76); History planned (#90) |
| Agents run on the installed Claude Code and its claude.ai login, never an API key: API-key and provider variables are removed from each agent's environment, and an agent whose init message reports an `apiKeySource` other than `none` is stopped at once | Planned (#75) |
| Your normal permission rules apply, as in the terminal; only calls they don't cover come to AnviDeck, on Home and the agent's row of `/agent-host`, with Allow / Deny (`POST /api/agents/:id/permissions/:requestId`, `shared/permission-requests.ts`, `tests/permission-requests.test.ts`). A request nobody answers keeps waiting, and a timeout never allows it; if the agent stops it is withdrawn | On `main` (#77) |
| Agents never merge; Merge is a button only you press | An agent started from an issue is told so in its prompt (#78, on main); Merge button planned (#85) |
| Deleting the old views needs the owner's go on the PR | Planned (#92) |

### Current state (`main` at `dd71c3e`, 2026-11-05)

Builds and runs (`bun run dev`; port 4000 unless `PORT` is set). Tests: `bun test`. Types: `bunx tsc --noEmit -p .`.

Sidebar views today (`ui/app.ts`): **Home** (`CommandCenter.ts`: one queue of PRs and agents, a one-line status, the project list; each row's action is a link), **Live Sessions**, **Agents** (one project's terminal-started sessions replayed from their transcripts; it can't act on them), **Map** (projects, design blocks, files and imports from anvi's structure guard, with agents replayed on them), **Changes** (`ChangesScreen.ts`, #84: one PR's files, layers, boundaries and diff with the anvi context its agent's session received per file, line comments to its running AnviDeck agent, evidence, a guided tour in commit order), **Live Trace**, **Brain**, **System Lens**, **Cross-Project**, **Routing**. Reached from links: **Project** (catalogues, memory, grounding; with the timeline strip, also on Home) and **GitHub Trace**.

What the workspace adds is in `BUILD.md` under "The workspace". Six of today's views (Live Sessions, Live Trace, Brain, System Lens, Cross-Project, Routing) are to be retired once Notes, History and Agents carry what's useful from them (#92).

### Architecture decisions that still hold

**Bun + Hono server**: lightweight TypeScript, zero-config. No Express.

**Plain TypeScript UI**: no React/Vue/Svelte. Components are functions returning DOM elements. The UI is information-dense; a reactivity framework adds build complexity without proportional benefit.

**One esbuild pass**: `bun run build.ts`. No webpack, no vite.

**No database**: data comes from the filesystem, git and `gh`. AnviDeck's own records (action log, calls, agent registry) are files in its own store folder.

**No Neo4j/graph DB**: investigated 2026-04-01: catalogue data was 41 nodes, 27 edges, 1.6% density, stratified by cognitive function rather than networked. Tables and strata are the right representation.

**Dark theme, monospace**: an engineering instrument (Grafana/Bloomberg), not Notion.

**Selective DOM updates**: `ui/app.ts` keeps the frame (top bar, rail, timeline, activity strip) across navigations; only the main content swaps (#80).

**Nav object for cross-linking**: components receive a `Nav` (`toHome`, `toProject`, `toTrace`, `toSystemLens`, `toCrossProject`, `toRouting`, `toBrain`, `toGitHubTrace`, `toSessions`, `render`). Every screen has a URL hash (`ui/shell/routes.ts`; `#agents?…`, `#map?…` carry their own params) and is in the ⌘K palette (#80).

**Every figure says where it came from**: a reader that could not look reports `unreadable` or `partial`, never "nothing found" (`server/readers/read-status.ts`).

### Decisions added for the workspace (2026-11-05, #93)

- **Same repo, not a new app**: the readers, their tests and Home / Agents / Map are reused.
- **Agent host on the Claude Agent SDK**: a spike on 2026-11-05 ran it under Bun on the existing login; it loaded the user's settings and anvi's hooks and handed permission requests to the callback (details in #75). The SDK is not yet a dependency in `package.json`.
- **Claude Code login, never an API key** (#75): agents start with `pathToClaudeCodeExecutable` set to the installed `claude`; the screen shows which login they run on (method and plan, not the email). Each agent is a full Claude Code session and counts toward the plan's usage limits.
- **Catalogue changes are done by agents**, never written by AnviDeck directly.

### Data sources (readers)

| Data | Location | Reader |
|------|----------|--------|
| Framework principles, routing table | `~/.claude/CLAUDE.md` | `server/readers/routing.ts`, `server/routes/api.ts` |
| Global memory | `~/.claude/memory/*.md` | `server/readers/memory.ts` |
| Project memory | `~/.claude/projects/<encoded-path>/memory/*.md` | `server/readers/memory.ts` |
| Projects | `~/.claude/projects/<encoded-path>/` (path from the transcripts' `cwd`) | `server/readers/projects.ts` |
| Catalogues, Ground Truth docs | first existing of `{project}/.anvi`, `{project}/artifacts/.anvi`, `~/.anvideck/projects/{name}/.anvi` (same for `ref`) | `shared/anvi-paths.ts`, `server/readers/catalogue.ts`, `server/readers/ground-truth.ts` |
| Session transcripts | `~/.claude/projects/<encoded-cwd>/<session>.jsonl` | `server/readers/replay.ts`, `server/readers/home.ts` |
| Live sessions | `~/.claude/sessions/*.json` | `server/readers/sessions.ts` |
| Hook and routing activity | `/tmp/anvi-hook-*.log`, `/tmp/anvi-route-*.log` | `server/watchers/hook-logger.ts` → WebSocket `/ws` |
| Framework history | `~/.claude` git repo | `server/readers/git-history.ts` |
| Design structure | anvi's structure guard (`~/.claude/anvi/scripts/structure-guard.js`) and its registries | `server/readers/structure.ts`, `server/readers/structure-lock.ts` |
| Notes currency | `~/.anvideck/projects/anvi/instances` (`ANVIDECK_HEALTH_DIR`) | `server/readers/home.ts` |
| GitHub | `gh` (PR state, your open PRs, issues and PRs for GitHub Trace) | `server/readers/home.ts`, `server/readers/replay.ts`, `server/routes/api.ts` |

### Constraints

- Zero config: point it at `~/.claude/` and `~/.anvideck/` and it works. Overrides are environment variables (`PORT`, `HOST`, `ANVIDECK_HEALTH_DIR`, `ANVIDECK_STRUCTURE_TMP`, `ANVIDECK_STRUCTURE_GUARD`).
- This machine only, by default (#66).
- No cloud service of AnviDeck's own and no telemetry. Network use is GitHub through `gh`, and, once #75 lands, the agents' own Claude Code sessions on the user's login.
- Fast startup: lazy file reads, immediate UI render.
- Readers stay read-only; every action goes through the agent host or the action log, guarded by origin and token (#76).
- Bun as runtime. No external databases.
