## Project: AnviDeck

A local desktop app (Tauri, #240) for working with Claude Code agents on projects that use the Ānvīkṣikī (anvi) framework. You see what each agent is doing and what anvi told it, review its changes, answer it, and steer the work, all from one screen on your own machine.

AnviDeck started as an observability dashboard that only read the framework's files. On 2026-11-05 the owner decided it becomes a full agent workspace in this same repo, matching the prototype at https://claude.ai/artifact/RucrgeLUJLfb8HaCTUGViF (tracking issue #93). On 2026-11-06 the owner decided it runs as a desktop app (#239–#244): the window shows the screens, the server runs inside the app as a sidecar, and every action goes over the app's private channel, never over HTTP. The same server opened in a browser (`bun run dev`) is read-only. The workspace's actions are on `main` (listed below); some screens and guards are still to come, and each says so. Do not describe planned behaviour as shipped. An item counts as done only once its PR is merged on `main`.

### Required Reading
1. `BUILD.md`: the workspace specification: screens, the reader / agent-host split, the safety model, build order, what gets retired, and what exists today.
2. Issue #93 (`gh issue view 93 --repo MrityunjayBhardwaj/AnviDeck`): build order and the owner's decisions. Each step has its own issue (#72–#92).
3. `ref/ANVI_THESIS.md`: why the framework exists; Part VI covers the three-tier context architecture.
4. `ref/DATA_EXAMPLES.md`: input and output for the data types the parser handles.

### The rule that shapes the code: readers read, one module acts

- **Readers** (`server/readers/*`, the GET routes in `server/routes/*`, `shared/parser.ts`) are read-only and stay that way. They never write into a project, a catalogue, memory or the anvi store. What they do today besides reading files: spawn `git`, `gh` and `node` to ask questions (log, show, ls-tree, `gh pr view`, `gh search prs`, `gh issue list`, anvi's structure guard), the structure reader makes a scratch folder under `ANVIDECK_STRUCTURE_TMP` (default `/private/tmp/claude-501/anvideck-structure`) for the guard's temporary checkouts, and Work's conflict reader (`server/readers/work-conflicts.ts`) keeps a scratch bare repository per repo under `ANVIDECK_WORK_TMP` (default `/private/tmp/claude-501/anvideck-work`): it is cloned `--bare --shared` from the main checkout, fetches PR heads from GitHub into itself, and `git merge-tree --write-tree` writes trial-merge objects there, never into the project.
- **The agent host** (`server/agents/host.ts`, #75) is the only code that acts. It runs Claude Code agents through the Claude Agent SDK's `query()`: start, stream, stop, resume, and the permission callback. Every other write AnviDeck makes goes through it or through the action log.
- A test fails if a reader imports the agent host, the action log or the write guard, calls a file write API, or spawns a git or gh command that writes (#76, on `main`: `tests/reader-actor-split.test.ts`). The listed exemptions, each with why: the structure reader's scratch folder, and the Work conflict reader's clone, fetch and `merge-tree --write-tree` into its scratch repo (#85).

**What AnviDeck writes** (all on `main`, each only from the desktop app's window):
- Agent actions: start an agent (#75), in its own worktree and branch for an issue (#78, `POST /api/agents/from-issue`); stop and resume it; answer its permission requests (#77); send it messages and diff comments (#79).
- Merge a PR, only when you press **Merge**, and only the head you reviewed (#85).
- Push an agent's branch and open its PR, only when you press **Push and open the PR** on its card (offered for agents under Agent GitHub access None, which cannot push): only the branch and commit the card showed, to the branch's own name on origin, never `main` or origin's base branch, never with force, never while the agent runs; then `gh pr create` on your login, or the PR already open from it (#268; `server/agents/push-pr.ts`, `tests/push-pr.test.ts`).
- Edit a file from the Code screen, only one no running agent is touching, and never a catalogue, a Ground Truth doc or Claude Code's configuration (#88, #244; `server/code-edit.ts`; only from the desktop app's window).
- Checkpoints per agent turn (#248; `server/agents/checkpoints.ts`, `server/agents/turns.ts`): before each run and after each turn, a snapshot of the agent's folder (tracked and untracked files; ignored ones are left out) as git objects in `checkpoints/<agent>.git` in AnviDeck's own folder. That folder holds a `.gitignore` of `*`, so snapshots stay on this machine and the store never commits them (they can hold an `.env`). The record of what each turn changed (file names and line counts, never contents) is `turns/<agent>.jsonl`, backed up with the action log. **Undo** puts the agent's folder back to a checkpoint: it shows what it would discard first, is refused while the agent, another agent or a terminal session works in that folder or one inside it (one in a folder above it, such as a session at the project root over an issue worktree, is named as a warning), never moves the branch, and runs only from the desktop app's window. Snapshots are cleared by hand (Clear) or when the agent's folder is gone. A snapshot that would copy in more than `ANVIDECK_CHECKPOINT_MAX_MB` (default 200) of untracked or changed files is not taken, and the record says why (#276); the Turns card shows the disk an agent's snapshots use. Changes shows a PR's agents' turns and, per file, the turns that changed it, read from the same record (#275); Undo stays on Agents. Nothing is written into the project's repository: the snapshot repository only reads its objects.
- Its own records, in AnviDeck's own folder in the store: the action log (#76), your calls on blocked edits (#86: recorded from the Agents screen's refusal card, Design's trial record and History into `calls.jsonl`; Design (#87) and History's timeline (#90) show them), the agent registry (#75), and settings such as Agent GitHub access (`settings.json`, #147; changed only from the desktop app's window).

**Changed only by agents, not by AnviDeck directly:** catalogues (`.anvi/`), memory and Ground Truth docs. A change to them (Re-check a batch, Promote) starts an agent with that task (#89); the agent makes the change, as in a terminal session.

### Safety model

| Guard | Status |
|---|---|
| This machine only: listens on `127.0.0.1` unless `HOST` is set; refuses a request whose Host is not a loopback name or whose Origin is another page (`server/access.ts`, `tests/access.test.ts`) | On `main` (#66) |
| Nothing sent over HTTP can act: every request other than GET is refused on every port. Actions come only from the desktop app's window, over its private channel (`invoke("write")` → the app's Rust command → the server's stdin → `dispatch` in `server/desktop.ts`). The page carries no token. In a browser AnviDeck is read-only (`server/guard.ts` `writesOnlyFromApp`; `ui/write.ts`; `tests/no-http-writes.test.ts` sends every non-GET route the real app has over a real port) | On `main` (#241); the write-token check it replaces was #76 |
| Every action (what, target, result, time) is appended to the action log (`actions.jsonl` in the agent registry folder; `GET /api/actions`) and shown in History | Logged on `main` (#76); shown in History, the lines that name a project (#90) |
| Agents run on the installed Claude Code and its claude.ai login, never an API key: API-key and provider variables are removed from each agent's environment, and an agent whose init message reports an `apiKeySource` other than `none` is stopped at once (`server/agents/login.ts` `loginOnlyEnv`, `server/agents/host.ts`) | On `main` (#75) |
| Your normal permission rules apply, as in the terminal; only calls they don't cover come to AnviDeck, on Home, the agent's card on Agents and its row of `/agent-host`, with Allow / Deny (`POST /api/agents/:id/permissions/:requestId`, `shared/permission-requests.ts`, `tests/permission-requests.test.ts`). A request nobody answers keeps waiting, and a timeout never allows it; if the agent stops it is withdrawn. A request from one of the agent's subagents is on the same card, named as the subagent's ("Explore (subagent) asks to …", with its description and id), or "A subagent" until Claude Code has said which (#267) | On `main` (#77); subagents' requests named (#267) |
| Each agent runs in the permission mode chosen when it starts: Plan only, Only what my rules allow, Ask me (the default), Accept edits, or Full access (`bypassPermissions`). The mode is sent to Claude Code explicitly, shown on the agent's card and tab, kept on resume, and an agent whose init reports a wider mode than chosen is stopped at once. The highest mode is capped per machine by `ANVIDECK_AGENT_MODE_CAP`, enforced by the server (default Accept edits, so Full access is off until you raise it); Full access also needs a confirm that says what it allows and names the Agent GitHub access it gets (under Your login: pushing and merging on GitHub as you); the confirm counts only for that GitHub access, so a start or resume under another is refused (`shared/agent-modes.ts`, `tests/agent-modes.test.ts`, `tests/agent-host.test.ts`) | On `main` (#249, #270) |
| Agents never merge; Merge is a button only you press | Partly. An agent started from an issue is told so in its prompt (#78, on main). Merge on Work squash-merges only the head and into the base the page showed, else 409 (#85). AnviDeck's Merge can no longer be called by another process: it exists only behind the desktop app's channel (#241). **Still not enforced against agents:** by default an agent's shell runs on your `gh` login, so it can merge on GitHub without AnviDeck at all. The Agent GitHub access setting on Agents (#147; `server/agents/github-access.ts`, `tests/github-access.test.ts`) can switch that to None, which takes GitHub and git credentials out of each agent's environment (gh finds no login, git's credential helpers and ssh keys are not used); it is not airtight until agents are sandboxed, and a bot account is not set up yet |
| Deleting the old views needs the owner's go on the PR | Planned (#92) |

### Current state (2026-11-14)

Runs as the desktop app: `bun run desktop:dev` (debug build), `bun run desktop:build` (release `AnviDeck.app`); needs Bun and a Rust toolchain. The same server alone, read-only in a browser: `bun run dev` (port 4000 unless `PORT` is set). Tests: `bun test`; checks that drive the app window: `bun run desktop:e2e` (#242). Types: `bunx tsc --noEmit -p .`.

The rail (`ui/shell/routes.ts`): **Home**, **Map**, **Agents**, **Changes**, **Notes**, **Project** (tabs: Code, Design, History, Work), and **Older views** (the dashboard's views from before the workspace, to be retired, #92). Each screen:

**Home** (`HomeScreen.ts`, #81; described below), **Live Sessions** (older), **Agents** (`AgentsScreen.ts`, #82: a tab per agent AnviDeck started and a 2×2 grid, each with its permission requests, message box, Stop/Resume, tool calls with the anvi hooks that ran, refusal cards; the project's terminal sessions after them, view only; the older replay view at `#agents?view=replay`), **Map** (projects, design blocks, files and imports from anvi's structure guard, with agents replayed on them), **Changes** (`ChangesScreen.ts`, #84: one PR's files, layers, boundaries and diff with the anvi context its agent's session received per file, line comments to its running AnviDeck agent, evidence, a guided tour in commit order, and the turns of the PR's AnviDeck agents with the files each changed, #275), **Notes** (`NotesScreen.ts`, #89: catalogues by kind with search, which catalogue each activity is routed to, currency from anvi's own `currency-report.js --json` with the snapshot series and Re-check a batch, Ground Truth docs measured by anvi's `gt-citation-check.js`, project memory with Promote; Re-check and Promote show the agent's prompt, then start it through `POST /api/agents`), **Live Trace**, **Brain**, **System Lens**, **Cross-Project**, **Routing** (older). Reached from links: **Project** (catalogues, memory, grounding; with the timeline strip, also on Home) and **GitHub Trace**.

What the workspace adds is in `BUILD.md` under "The workspace". Six of today's views (Live Sessions, Live Trace, Brain, System Lens, Cross-Project, Routing) are to be retired once Notes, History and Agents carry what's useful from them (#92).

Home (`HomeScreen.ts`, #81): one queue, soonest first, where a permission request is answered in place, a PR links to GitHub with why it is or is not ready to merge (what its body claims is worded as a claim), and a ready PR goes to its row on Work with the head it was judged at; the health line with guards, rule breaks, out-of-date notes and notes backed by source, each dated; the agents.

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
- **Agent host on the Claude Agent SDK**: a spike on 2026-11-05 ran it under Bun on the existing login; it loaded the user's settings and anvi's hooks and handed permission requests to the callback (details in #75). `@anthropic-ai/claude-agent-sdk` is pinned in `package.json`.
- **A desktop app, not a browser page** (2026-11-06, #239–#244): Tauri; the server is the app's sidecar; actions only over the app's private channel (#241). The browser view is kept, read-only.
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
| Refusals by the design guard | anvi's `~/.claude/anvi/scripts/structure-refusals.js` | `server/readers/refusals.ts` |
| Your calls on blocked edits | `calls.jsonl` in AnviDeck's own folder (written by `server/calls.ts`, #86) | `server/readers/calls.ts` |
| Notes currency | `~/.anvideck/projects/anvi/instances` (`ANVIDECK_HEALTH_DIR`); live, anvi's `currency-report.js --json` and `gt-citation-check.js --json`, run read-only | `server/readers/home.ts`, `server/readers/notes.ts` |
| GitHub | `gh` (PR state, your open PRs, issues and PRs for GitHub Trace) | `server/readers/home.ts`, `server/readers/replay.ts`, `server/routes/api.ts` |

### Constraints

- Zero config: point it at `~/.claude/` and `~/.anvideck/` and it works. Overrides are environment variables (`PORT`, `HOST`, `ANVIDECK_HEALTH_DIR`, `ANVIDECK_STRUCTURE_TMP`, `ANVIDECK_STRUCTURE_GUARD`, `ANVIDECK_WORK_TMP`, `ANVIDECK_CURRENCY_REPORT`, `ANVIDECK_GT_CHECK`, `ANVIDECK_HOOK_LOG_DIR`, `ANVIDECK_AGENT_MODE_CAP`, `ANVIDECK_CHECKPOINT_MAX_MB`).
- This machine only, by default (#66).
- No cloud service of AnviDeck's own and no telemetry. Network use is GitHub through `gh`, and, once #75 lands, the agents' own Claude Code sessions on the user's login.
- Fast startup: lazy file reads, immediate UI render.
- Readers stay read-only; every action goes through the agent host or the action log, and reaches AnviDeck only through the desktop app's private channel, never HTTP (#241).
- Bun as runtime. No external databases.
