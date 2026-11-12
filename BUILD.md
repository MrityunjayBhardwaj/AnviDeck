# AnviDeck: Agent Workspace for the Ānvīkṣikī Framework

## What This Is

A local browser workspace (`localhost:4000`) where you run and steer Claude Code agents on projects that use the Ānvīkṣikī (anvi) framework: start an agent on an issue, watch what it does and what anvi told it at each step, answer it when it waits on you, review its PR with the context it had, and merge when you are satisfied. Alongside the agents sit the project's design, its notes (catalogues, memory, Ground Truth) and its history.

**Status, 2026-11-05.** AnviDeck began as an observability dashboard that only read the framework's files (phases 1–10, below). On 2026-11-05 the owner decided it becomes a full agent workspace in this repo, matching the prototype at https://claude.ai/artifact/RucrgeLUJLfb8HaCTUGViF. Tracking issue: #93. **None of the workspace's actions are on `main` yet.** Each section below says whether it describes what exists or what is planned; "planned" items link the issue that builds them. An item becomes "exists" only when its PR is merged on `main`.

## Why

The anvi framework accumulates state: catalogues grow, dharana entries multiply, memory evolves, sessions produce observations. A system that accumulates state needs a place to see it, or that state rots undetected. That is why the dashboard was built.

The work that state serves is done by agents: Claude Code sessions that edit code, get context from anvi's hooks, get blocked by its guards, and open PRs. Watching them from one tool and acting on them from a terminal splits one loop in two. The workspace joins them: the screen that shows what anvi told an agent is the screen where you answer it.

---

## The workspace (planned, #93)

### Shell (#80)

The prototype's frame replaces today's sidebar:
- **Rail:** Home (with its badge), Map, Agents, Changes, Notes, Project (tabs: Code, Design, History, Work). Help is the **? Help** menu in the top bar (and ⌘K), not a rail item.
- **Project switcher** and a **"Guards on"** indicator.
- **Activity strip** at the bottom ("4 agents · 1 working · 3 waiting on you").
- **⌘K palette:** screens, agents, issues, and commands such as starting `/anvi:debug` in a new agent.
- Every screen reachable from the rail, by URL hash and from the palette. Selective re-rendering stays. Old views stay reachable until they are retired (#92).

### Screens

| Screen | What it shows and does | Built on | Issue |
|---|---|---|---|
| **Home** | One queue, soonest first; each item has one action done in place: review a PR (with its deadline), answer a waiting agent, merge a PR that's ready. A health line ("Healthy · 1 thing to watch …") that opens to guards, allowed rule breaks, out-of-date notes and notes backed by source. The list of agents. | Today's Home readers + the agent host | #81 (takes over #47) |
| **Map** | Projects, design blocks, files and imports, with agents replayed on them. **Exists** (#52); its Chat tab shows the agent's own words from the transcript (#48), and older sessions, agents on a project with no design and withdrawn guard runs are handled (#49). | Structure reader, replay reader | #48, #49 |
| **Agents** | A tab per agent and a 2×2 grid; its plan with progress; its tool calls with which anvi hooks ran and what context they gave; a refusal card (layer path and rule) when the design guard blocks an edit; a message box. Terminal-started sessions still open, labelled as view only. | Agent host live stream; replay reader for terminal sessions; Claude Code's transcript, anvi's hook meter and the live hook log per session (`GET /api/agents-screen/session/:sid`) | #82 (on main once its PR merges; `/agent-host` stays until the owner retires it) |
| **Changes** | A PR's files, the layers and boundaries it touches, the diff with the anvi context the agent received at each hunk, line comments that go back to the agent, the evidence, a guided tour, the self-review gaps. | `gh` diff, hook log joined per hunk, the evidence format | #84 (needs #79, #83). **Partly built** (PR #145, part of #84): `GET /api/changes/prs`, `GET /api/changes/pr/:n` (`server/readers/changes.ts`); every file of the PR (GitHub's files API paged past gh's 100); the agent's session is found by Claude Code's pr-link record, the PR's branch, or the registry agent for an issue it closes; the context is shown **per file, not per hunk** (the hook log names files, not lines; #153); comments go through `POST /api/agents/:id/message`. **Not yet**: the per-hunk join (#153); the agent's reply under a comment and the currency of delivered entries, as in the prototype; a tour of claims rather than files in commit order (#173); checked on a real AnviDeck-agent PR in a project with a dharana.md |
| **Notes** | Catalogues by kind with search; which catalogue is used when, per activity; freshness (drifted entries, oldest drifted entries still in use, **Re-check a batch** by subsystem); grounding (Ground Truth docs, their age, the entries citing them); project memory with **Promote**. Re-check and Promote start an agent. | Catalogue, currency, memory, grounding readers | #89. **Built** (on main once its PR merges): `NotesScreen.ts`; `GET /api/notes/currency` runs anvi's `currency-report.js --json` in the background (counts shown as it prints them) with the `health-<date>.json` series; `GET /api/notes/grounding` runs anvi's `gt-citation-check.js --json`; `GET /api/notes/usage` counts the injector's deliveries per entry for the project's sessions (`server/readers/notes.ts`). Re-check (at most 25 entries per agent) and Promote show the full prompt, then `POST /api/agents` in the project's folder |
| **Project · Code** | File tree coloured by layer, with markers for refused edits, imports that break the design, and files agents touched; a file view with blame and known-trap lines. Editing is off while agents work, behind an **Enable editing** switch. | Structure reader, refusal log, agents' edits, `git blame` | #88 (on main once its PR merges): `GET /api/code/:project` (files at the design reader's commit, catalogue citations placed), `/file` (one file with blame), `/working`, `POST /api/code/:project/edit` (`server/code-edit.ts`). Agent-touched is per file, not per line; known traps are `file:line` citations in the catalogues, placed only when exactly one file matches. A file over 1,000 lines is painted as you scroll, and says so (#251) |
| **Project · Design** | Five lenses: Armed (enforcement mode, allowed rule breaks, trial record), Placed (placement in review, "ask before writing"), Consolidated (where problems cluster, the cost curve of fixes, shown only where files per fix can be measured), Path to target (moves to the declared design, each linked to an issue), System flows. | Structure readers; your recorded calls | #87, #86. **Built** (on main once its PR merges): `DesignScreen.ts`. Armed from the registry and the guard's verdict at the measured commit, and the trial record from `GET /api/refusals` with Right / Wrong on each row; Placed says no source records a placement, and Ask before writing sends only a question you typed and shows the full prompt, then `POST /api/agents`; Consolidated lists the guard's held breaks by pair and the boundaries whose dharana.md heading says the fatality test tripped (the prototype's table of the three fatality signals is not shown, and the screen says so: #210), and draws files per fix from git history (`GET /api/design/cost`); Path to target says no source lists moves and shows the held breaks; System flows puts measured figures on a fixed description, with the edit hooks (started in parallel, not in sequence) read from your settings, the project's two settings files and the managed settings; plugin hooks are not read, so a guard hook not found reads "not found", never "not running" (`GET /api/design/hooks?project=`; `server/readers/design.ts`) |
| **Project · History** | One timeline of agent turns, edits, refusals, rulings, commits and catalogue changes, each event naming its source; a moment's details; compare two points (code, design, knowledge); replay a session. | Timeline, hook log, replay reader, action log | #90 |
| **Project · Work** | The board (Todo / In Progress / Done from the GitHub project's Status field; a list if the project has no board), **Start agent**, **New issue**; for each PR your workflow as steps (Friction → Issue → Branch → Fix → Test → Observe → PR → Self-review → Merge, by you) with merge checks (CI green, closing reference parsed, no conflict with other open PRs). **Merge** is a button only you press. | `gh`, `gh project`, `git merge-tree` | #85, on main: `GET /api/work/board`, `GET /api/work/prs`, `POST /api/issues`, `POST /api/prs/:n/merge { project, head, base }` (readers `server/readers/work.ts`, `work-conflicts.ts`, `boards.ts`, `repo.ts`; actions `server/work/act.ts`; routes `server/routes/work.ts` (GET) and `work-actions.ts` (POST)); conflicts are checked in a scratch bare clone under `ANVIDECK_WORK_TMP`, never in the project |
| **Help** | Six guided flows played over the real screens: start a task, a blocked edit and your call, review a change, notes go out of date, place new code, fix a boundary. A step whose data isn't there is skipped, and the tour says so. | All screens | #91. **Built** (on main once its PR merges): `HelpScreen.ts` (`#flows`, from Help in the top bar and ⌘K), the flows in `ui/shell/tour-model.ts`, the runner in `tour-runner.ts` and the card in `tour.ts`. Steps point at elements marked `data-tour` on each screen; a skip says which of four it is: no such data, the screen's own reason (could not read, no source records it), still reading at the limit, or not shown in time. The tour opens screens and highlights; it never presses a button. No step uses Code yet |

---

## Architecture

### Readers and the agent host

```
                     ┌──────────────────────── AnviDeck server (Bun + Hono) ────────────────────────┐
 browser (this       │                                                                              │
 machine only) ──────┤  GET  /api/...  ──► READERS (server/readers/*)      read-only: files, git, gh │
                     │                                                                              │
                     │  writes: app window ─► stdin ─► guard ─► AGENT HOST ─► Claude Agent SDK      │
                     │  (#241; none on HTTP)    │                  (planned, #75)  query() ──► installed
                     │                          └─► action log (AnviDeck's own store folder)  `claude`
                     │  WebSocket /ws  ◄── hook-log watcher (exists); agent message stream (planned)│
                     └──────────────────────────────────────────────────────────────────────────────┘
```

- **Readers are read-only.** They read files, spawn `git`/`gh`/`node` to ask questions, the structure reader keeps a scratch folder under `ANVIDECK_STRUCTURE_TMP` for anvi's structure guard, and Work's conflict reader keeps a scratch bare repo under `ANVIDECK_WORK_TMP` that it fetches PR heads into and runs `git merge-tree --write-tree` in. They never write into a project, a catalogue, memory or the store. A test will enforce that no reader imports the agent host or writes a file (#76).
- **The agent host is the only module that acts** (#75). Everything AnviDeck does beyond reading goes through it or the action log.
- **Catalogues, memory and Ground Truth docs are changed only by agents**, never by AnviDeck directly (#89, #93).

### Agent host (#75, planned)

- Starts an agent with a folder, a prompt and your normal settings: user, project and local settings load, so anvi's hooks and CLAUDE.md apply.
- Streams every SDK message to the page over the existing WebSocket and keeps it per agent.
- Keeps a registry of AnviDeck-started agents on disk (id, session id, folder, issue, status, and the server that runs it: pid and port). Several servers may share it (#104): each write changes only its own records, under a lock file, and a server lists every agent but acts only on its own; another live server's agent shows where it runs and is refused (409) here. An agent whose server is gone (its pid is not alive, or now belongs to a process that started after that server, #224) shows as stopped, with its transcript, and can be resumed by any server.
- Stops an agent, and caps how many run at once.
- Takes a checkpoint of the agent's folder before each run (before Claude Code starts) and after each turn's result, or when a run ends mid-turn (#248). Each one records what changed since the one before: the turn's own changes, or, before a resume, what changed outside the agent. The Agents screen lists them and offers **Undo** to any checkpoint: a preview of what it would discard (refused if the folder changes before you press), then `read-tree -m -u` from the folder as it is to the checkpoint, with a checkpoint before and after so an Undo can itself be undone. Refused (409) while the agent runs anywhere, while another AnviDeck agent or a terminal Claude Code session works in the same folder or one inside it, or when those cannot be read (one working in a folder above it is shown as a warning in the preview, not a refusal: a session at the project root would otherwise turn Undo off for every issue worktree); a resume or a start in the folder is refused while an Undo runs. Snapshots live in `checkpoints/` (ignored by the store, never backed up); the record in `turns/` is backed up. `GET /api/agents/:id/checkpoints`, `GET|POST /api/agents/:id/checkpoints/:n/undo`, `POST /api/agents/:id/checkpoints/clear`.
- Statuses: starting, working, waiting on you, done, failed, stopped. "Could not start" never shows as "done".
- Feeds each agent through a stream of user messages, so a message or a diff comment (file, line, the line's text) arrives on its next turn, with delivery shown (#79, on main: `POST /api/agents/:id/message`; a stopped agent answers 409 with `resumable`).
- Permission callback: a call your rules don't cover is parked on Home's queue and the agent's card with **Allow** / **Deny** (Deny takes an optional message). It survives a page reload, never times out to Allow, and is withdrawn if the agent stops (#77, on main: `POST /api/agents/:id/permissions/:requestId` with `{ decision: "allow" }` or `{ decision: "deny", message? }`; 409 once the request is no longer waiting). A subagent's request comes to the same callback carrying only the subagent's id; the host names it from that subagent's `task_started` message ("Explore (subagent) asks to …") on the parent's card, Home and `/agent-host`, and the transcript records the subagent and the call's id (#267).
- **Runs on your Claude Code login, never an API key:** `pathToClaudeCodeExecutable` is the installed `claude` (found on PATH, shown on screen); `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` and the Bedrock/Vertex switches are removed from each agent's environment; an agent whose init message reports an `apiKeySource` other than `none` is stopped at once and never shown as running; the screen shows the login method and plan from `claude auth status` (not the email). A start that fails while Claude Code is replacing its binary says "Claude Code was updating, try again".
- Spike 2026-11-05 (recorded in #75): SDK 0.3.318 with CLI 2.1.318 under Bun ran on the existing login with `apiKeySource: none`; both SessionStart hooks fired; the permission callback received a Write request and a deny stopped it.

### Starting an agent from an issue (#78, on main)

**Start agent** on an issue (⌘K "Start an agent on an issue", and a box on `/agent-host`; Work's Start agent on each Todo issue (#85); Home's button comes with #81): `POST /api/agents/from-issue { project | repo, issue, note? }`, previewed without writing by `GET /api/agents/from-issue/plan` (`server/agents/from-issue.ts`, `worktree.ts`, `issue-prompt.ts`, `board.ts`).
- Creates the worktree `<main checkout>/.claude/worktrees/issue-<n>` (beside Claude Code's own) on a new branch `feat|fix|chore/<n>-<slug>` (fix for a `bug` label, chore for `chore` or `documentation`, else feat), from the local default branch, or from origin's when the local one is only behind it as last fetched (no fetch is made); the plan, the dialog and the agent's prompt say "N commits behind origin/main as of the last fetch" (#136).
- Links `.anvi` and `ref` into it, each to where the main checkout's resolves (what anvi's `worktreeLinkGap` says a linked worktree needs). A tracked `ref` stays the branch's own copy. A link the repo does not already ignore is added to its `info/exclude`. Each link is read back, and anvi's own `worktreeLinkGap` is asked what is still missing.
- Starts the agent with a prompt built from the issue (repo, number, title, body) plus the workflow (issue → branch → fix → test and observe → PR → self-review; agents never merge) and `PR_SECTIONS_INSTRUCTIONS`. An optional note comes last and wins where it differs.
- Refuses, saying why (409/404 with `refusal`): unknown project or repo, no GitHub origin, no such issue, issue closed, worktree or branch (local or origin's) already exists, or the main checkout is on the base branch with uncommitted changes to tracked files, or the local base branch and origin's have diverged (`diverged`); and, before anything is made, the agent cap. If the agent cannot start, the fresh worktree and branch are removed.
- Moves the issue to In Progress on the one board linked to the repository (ids derived each time). Says "no board" when none is linked, and does not guess between several.

### Evidence and self-review (#83, planned)

Agents AnviDeck starts write two PR-body sections with a fixed shape: **Evidence** (tests with the runner's own exit code / observed / not checked) and **Self-review** (severity, gap, issue). AnviDeck parses them; a PR without them shows "not recorded", never an empty list.

### Safety model

| Guard | Status |
|---|---|
| Listens on `127.0.0.1` unless `HOST` is set; refuses a request whose Host is not a loopback name or whose Origin is another page (`server/access.ts`, tested in `tests/access.test.ts`) | **Exists** (#66) |
| Nothing sent over HTTP can act: writes come only from the desktop app's window, over its private channel; no token in the page | On `main` (#241; replaced #76's token check) |
| Every action (what, target, result, time) appended to an action log in AnviDeck's own store folder and shown in History | Logged (#76); History shows the lines that name a project (#90) |
| Readers can't act: a test fails if a reader imports the agent host or writes a file | Planned (#76) |
| Agents on the Claude Code login only (see Agent host) | Planned (#75) |
| Your permission rules apply as in the terminal; only uncovered calls reach AnviDeck; no timeout allows a call | **Exists** (#77) |
| Merge only the reviewed head, into the base the page showed; refused (409 with the current head or base) if either changed | **Exists** (#85) |
| Merge only by you: no agent can cause a merge | **Partial**: AnviDeck's Merge exists only behind the desktop app's channel (#241), so no other process can call it. By default an agent's shell still runs on your `gh` login and can merge on GitHub directly. The Agent GitHub access setting (#147) can take GitHub and git credentials out of agents' environments (None); that is not airtight until agents are sandboxed, and a separate bot account is not set up yet |
| Undo of an agent's turn never runs while something works in the folder, and never sends a snapshot off this machine | #248: 409 while the agent runs here or on another server, while another AnviDeck agent or a live terminal session works in the folder or one inside it (or the sessions can't all be read; one in a folder above is a warning), or if the folder changed since the preview; the branch and its commits are never moved; `checkpoints/` ignores itself, tested by running the store's own commit hook over a snapshot holding a known untracked file (`tests/checkpoints.test.ts`) |
| Code-screen edits only to files no running agent is touching, each through the action log | #88 (on main once its PR merges): 409 while a running AnviDeck agent works in the file's folder or edited the same file in any checkout, or a live terminal session works in its folder; 409 if the file changed since it was shown (sha256); no `..`, symlink or `.git`; never a catalogue (`.anvi/`), a Ground Truth doc (`ref/`) or Claude Code's configuration (`.claude/`, `.mcp.json`); each edit's action-log line names the file, its path on disk and the sha256 before and after (`detail`), whatever the body's size. The edit runs only through the desktop app's channel (#241, #244): over HTTP it is refused like every other write, so no other process can call it. An agent's own tools can still change files as its permission rules allow; that needs the agent sandbox (#147) |

### Stack

**Hono on Bun** (server): lightweight, TypeScript-native, zero-config.

**Plain TypeScript UI**: DOM functions, no React/Vue/Svelte. The UI is information-dense; a framework adds build complexity without proportional benefit.

**One esbuild pass**: `bun run build.ts` bundles `ui/app.ts` into `dist/app.js`. No webpack, no vite.

**No Electron**: a browser tab is enough for a local tool.

**Claude Agent SDK** (planned, #75): the only new dependency the workspace needs to run agents. Not yet in `package.json`.

### Data sources (readers)

| Data | Location |
|------|----------|
| Framework principles, routing table | `~/.claude/CLAUDE.md` |
| Global and project memory | `~/.claude/memory/*.md`, `~/.claude/projects/<encoded-path>/memory/*.md` |
| Projects | `~/.claude/projects/<encoded-path>/`, decoded from the transcripts' `cwd` |
| Catalogues, Ground Truth docs | first existing of `{project}/.anvi`, `{project}/artifacts/.anvi`, `~/.anvideck/projects/{name}/.anvi` (same for `ref`), via `shared/anvi-paths.ts` |
| Session transcripts | `~/.claude/projects/<encoded-cwd>/<session>.jsonl` |
| Live sessions | `~/.claude/sessions/*.json` |
| Hook and routing activity | `/tmp/anvi-hook-*.log`, `/tmp/anvi-route-*.log` (written by `catalogue-context-injector.js` and `anvi-route-logger.js`) |
| Framework history | the `~/.claude` git repo |
| Design structure | anvi's structure guard `~/.claude/anvi/scripts/structure-guard.js` and its registries |
| Refusals by the design guard | anvi's `~/.claude/anvi/scripts/structure-refusals.js`, run on the project's registered package (`server/readers/refusals.ts`, `GET /api/refusals`) |
| Your calls on blocked edits | `calls.jsonl` in AnviDeck's own store folder, beside `actions.jsonl` (`server/readers/calls.ts`, `GET /api/calls`; written by `POST /api/refusals/:key/call`, #86) |
| Notes currency | `~/.anvideck/projects/anvi/instances`; anvi's `currency-report.js --json` and `gt-citation-check.js --json` (Notes, #89) |
| GitHub | `gh`: PR state, your open PRs, issues and PRs |

AnviDeck's own store folder holds the agent registry, the action log and your calls on blocked edits (#75, #76, #86; calls are recorded from the Agents screen's refusal card, Design's trial record and History, and Design and History show them). The Work screen reads the board via `gh project` (#85).

---

## Build order (#93)

Each item goes issue → branch → PR → owner's merge. All are open as of 2026-11-05.

| Step | Issues |
|---|---|
| **0. Foundation** | #72 level-2 update headings listed as separate entries · #73 entries matched by ID alone across catalogues · #34 slow first entry-dates read · #74 these docs |
| **1. Agent host** | #75 run agents · #76 every action guarded and logged · #77 permission requests (needs #75) · #79 talk to a running agent (needs #75) · #78 start from an issue in its own worktree (needs #75, #83) · #83 evidence and self-review format |
| **2. Shell** | #80 navigation, project switcher, activity strip, ⌘K |
| **3. Screens** (independent once 1 and 2 are in) | #81 Home · #82 Agents · #84 Changes · #85 Work · #86 your calls → #87 Design · #88 Code · #89 Notes · #90 History · #48, #49 Map gaps |
| **4. Finish** | #91 Help and the six flows · #92 retire the old views |

## What gets retired (#92)

Live Sessions, Live Trace, Brain, System Lens, Cross-Project and Routing are outside the prototype. Once Notes, History and Agents carry what's useful from them, the views, their routes and any readers nothing else uses are removed, with a list of what each view showed and where it went. Deleting needs the owner's go on the PR. #92 does not name the Project view, GitHub Trace or the timeline strip; their future is open.

---

## What exists today (`main` at `dd71c3e`, 2026-11-05)

Every HTTP route is a GET; the WebSocket only pushes hook and routing log lines to the page.

```
server/
  index.ts                Hono app: access guard, routes, static files, file + hook-log watchers
  access.ts               this-machine-only guard (#66)
  routes/
    api.ts                projects, project, catalogues, memory, sessions, timeline, state-at, diff,
                          routing-architecture, cross-project, hook-logs, entry-dates, github-trace
    home.ts               /api/home
    replay.ts             /api/replay/sessions, /api/replay/session/:sid
    structure.ts          /api/structure, /api/structure/:project
    ws.ts                 /ws push channel
  readers/                catalogue, memory, projects, sessions, git-history, ground-truth, routing,
                          home, replay, structure (+ structure-driver.cjs, structure-lock), read-status
  watchers/               file-watcher (global memory changes, logged to the console), hook-logger (/tmp anvi logs)
shared/                   types, parser, anvi-paths (artifact resolver), home/replay/structure types
ui/
  app.ts                  shell (#80): rail, URL hash per screen, selective re-render, Nav, timeline strip, WebSocket
  shell/                  routes (every screen and its hash), frame (top bar, rail, placeholders, strip), ⌘K palette
  api.ts, home-count.ts   API client; Home badge count
  components/             HomeScreen (+ home-model), CommandCenter (old Home), ProjectView, CatalogueTree, Timeline, DiffViewer,
                          LiveSessions, AgentsView, MapView (+ map-model), CognitiveTrace,
                          ContextBudget, BrainView, SystemLens, CrossProject, RoutingView, GitHubTrace
  styles/deck.css
tests/                    access, git-history, home, map-model, parser, replay, shared-stores, structure
hooks/                    symlinks to ~/.claude/hooks (injector, route logger, settings.json)
ref/                      ANVI_THESIS.md, DATA_EXAMPLES.md
```

### Views today

| View | Shows | Fate |
|---|---|---|
| Old Home (`CommandCenter.ts`) | one queue of PRs and agents, a one-line status, project list; each row's action is a link | replaced by the workspace Home (`HomeScreen.ts`, #81); the file is left in place, no longer rendered |
| Project (`ProjectView.ts`, `CatalogueTree.ts`) | catalogues with REF and an "ungrounded only" filter, memory, grounding, read status | not named in #92 |
| Timeline strip (`Timeline.ts`, `DiffViewer.ts`) | `~/.claude` commits; diff between two | not named in #92 |
| Live Sessions | active Claude Code sessions | retire (#92) |
| Agents replay (`AgentsView.ts`, now `#agents?view=replay`) | one project's terminal-started sessions, replayed: session, changes, notes used | kept behind the workspace Agents (#82, `AgentsScreen.ts`), which links to it |
| Map (`MapView.ts`) | projects, design blocks, files, imports; agents replayed on them | kept; first gaps closed (#48, #49) |
| Live Trace (`CognitiveTrace.ts`, `ContextBudget.ts`) | live hook activity, routing decisions, context budget | retire (#92) |
| Brain (`BrainView.ts`) | a project's boundaries and entries by stratum, with hook and routing activity and entry dates | retire (#92) |
| System Lens | contribution matrix, pruning candidates with WHY | retire (#92) |
| Cross-Project | recurring patterns, shared invariants, memory network | retire (#92) |
| Routing | three-tier context diagram, routing table, coverage | retire (#92) |
| GitHub Trace (`GitHubTrace.ts`) | catalogue entries linked to issues, PRs and commits | not named in #92 |

### How we got here: the dashboard phases

| Phase | What shipped |
|---|---|
| 1. Data layer + API | parser, catalogue/memory/git readers, file watcher, REST API (`4cc09bd`) |
| 2. Command Center + Project view | (`423aeb8`) |
| 3. Timeline slider with diff mode | (`c62368b`) |
| 4. Real-time session trace | hook logger, route logger, WebSocket, Live Trace, Context Budget (`df25189`) |
| 5. System Lens | contribution matrix, pruning candidates (`0e7932c`); the planned Prune/Retire button was never built |
| 6. Cross-project intelligence | (`4acdc93`) |
| 7. Context routing visualization | (`58d4345`) |
| 8. Brain view | (`b1fd8ed`) |
| 9. GitHub Trace | (`bdb71f3`) |
| 10. Ground Truth visualization | grounding status, REF display, ungrounded filter, opaque boundaries in Brain (#4, #5); the three-panel provenance drill-down was not built |
| Since | Live Sessions (#11), replay reader (#24), structure data (#20), Agents view (#44), Home (#50), Map (#52), this-machine-only guard (#66), and fixes (#53–#71) |

---

## Design Principles

**Information density over visual flair.** An engineering instrument: Grafana, Bloomberg, a cockpit. Not Notion or Linear.

**Readers read; one module acts.** Every action goes through the agent host or the action log, reaches AnviDeck only through the desktop app's private channel (never HTTP), and is recorded.

**You decide; agents do.** Agents propose and change; you answer permission requests, review and merge. Agents never merge. How much an agent may do without asking is the permission mode you pick when it starts, capped per machine (#249).

**Every figure says where it came from.** A reader that could not look says so (`unreadable`, `partial`), never "nothing found". Nothing illustrative is shown as measured (#87).

**Zero config.** Point it at `~/.claude/` and `~/.anvideck/` and it works. Overrides are environment variables (`PORT`, `HOST`, `ANVIDECK_HEALTH_DIR`, `ANVIDECK_STRUCTURE_TMP`, `ANVIDECK_STRUCTURE_GUARD`, `ANVIDECK_WORK_TMP`, `ANVIDECK_AGENT_MODE_CAP`).

**Local by default.** This machine only; no cloud service of AnviDeck's own and no telemetry. Network use is GitHub through `gh` and the agents' own Claude Code sessions on your login.

**Fast startup.** Lazy file reads; the UI renders immediately; slow reads say what they are still reading.

**Dark theme, monospace.** Visual continuity with the terminal.

---

## Open Questions

1. **Where AnviDeck's own store folder lives** (action log, calls, agent registry): to be settled in #75 / #76.
2. **Large git histories:** `/api/timeline` pages (`limit`, `offset`, default 100), but the UI asks once for 200 commits and does not page further.
3. **GitHub Trace confidence scoring:** correlations between catalogue entries and GitHub artifacts were never calibrated. Open while the view's future is open.

## Success Criteria (the workspace)

1. An agent started from AnviDeck runs on the Claude Code login (`apiKeySource: none` shown), streams to the page, survives a page reload, and is listed as stopped after a server restart and resumes (#75).
2. Any write sent over HTTP is refused, whatever it carries; actions come only from the desktop app's window; every action appears in the log with its result (#76, #241).
3. A permission request appears on Home and the agent's card within a second; Allow lets the call run; Deny stops it with the message (#77).
4. Starting from a real issue creates the worktree with both links resolving, and the agent's first edit shows the anvi context it was given (#78).
5. Every prototype screen is reachable from the rail, by URL and from ⌘K (#80), and each shows real figures with their source and date.
6. All six Help flows play to the end on a real project (#91).
7. The old views are retired with each one's useful content named in its new home, and the build, tests and remaining screens are unaffected (#92).
