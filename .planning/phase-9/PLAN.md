---
phase: 9
title: GitHub Trace — Knowledge → Artifact → Outcome Loop
goal: Close the loop from brain knowledge to GitHub artifacts. For any catalogue entry, see which issues/PRs/commits it informed. For any artifact, see which entries were active.
status: planned
created: 2026-04-01
---

# Phase 9 Plan: GitHub Trace

## Goal

Make the cognitive loop fully observable: knowledge in catalogues → hook activation → Claude acts → GitHub artifact produced. For any catalogue entry, surface the issues/PRs/commits it likely informed. For any artifact, show which brain entries were active when it was created.

## Design Analysis

### Existence Gate

1. **Who uses this?** The framework author auditing whether the framework actually influenced outcomes — and regulators/reviewers asking "what knowledge informed this decision?" This is the contestability closer: the audit trail from knowledge to artifact.
2. **What breaks without it?** The cognitive loop is visible in the abstract (Brain View shows entries, Flow shows hook fires) but the *outcome* is invisible. You can't see that SP8 (param mismatch) was active when Issue #64 (bus routing bug) was filed. The loop has no exit.
3. **Simpler alternative?** No — the loop visualization requires correlation across two data domains (catalogues + GitHub). No existing view does this.

### Observed Data Reality (from probing sonicPiWeb)

- Commits: gitmoji format (`🐛 fix: ...`) — NO explicit catalogue IDs (SP8, SV12) in messages
- Issues: keyword-rich bodies with technical terms — high overlap with catalogue entry content
- PRs: mix of feature and fix PRs

**Implication:** ID-based matching (scan for "SP8") is nearly zero-signal. **Keyword-based matching** is the primary signal:
- Extract significant terms from catalogue entry title + key sections
- Score each artifact (issue/PR/commit) by keyword overlap + temporal proximity
- Confidence = HIGH (≥3 keyword matches or temporal + file-path overlap), MEDIUM (1-2 matches or proximity alone), LOW (exclude from results)

### Key Design Decision: /tmp Cache

`gh` CLI calls are network-bound (300-1000ms each). Running 3 commands per page load is unacceptable. Cache results to `/tmp/anvi-github-trace-{projectName}.json` with a 10-minute TTL. Stale-while-revalidate: return cached data immediately, refresh in background.

### Invariants

- **IV1**: Correlation is probabilistic — confidence scores, not certainty. UI always shows score alongside link.
- **IV2**: `gh` calls run from the project directory, not AnviDeck directory. Wrong cwd = wrong repo.
- **IV3**: If `gh` is not authenticated or repo is private with no access → return empty artifact list gracefully, no crash.
- **IV4**: Commits are always available (local git, no auth needed). Issues/PRs need `gh`.
- **IV5**: The loop visualization is static — it shows the 7-step model with counts populated from real data. It's not an interactive graph.

### Lifecycle

```
User opens GitHub Trace view
  → API: GET /api/project/:name/github-trace
      → Check /tmp cache (< 10min old) → return cached
      → Else: parallel fetch
          → git log (local, fast)
          → gh issue list (network, ~300ms)
          → gh pr list (network, ~300ms)
      → Correlate with catalogue entries
      → Write to /tmp cache
      → Return GitHubTrace response
  → UI renders: loop diagram + entry→artifact table
```

### Ownership

| Data | Owner |
|------|-------|
| Catalogue entries + keywords | server/readers/catalogue.ts (existing) |
| Git commits | `git log` via execSync in project dir |
| GitHub issues/PRs | `gh` CLI via execSync in project dir |
| Correlation results | API endpoint (computed, cached to /tmp) |
| Cache file | /tmp/anvi-github-trace-{name}.json |
| View state (selected entry, direction) | GitHubTrace.ts component |

### Pre-mortem

1. **No GitHub remote**: Project has no GitHub remote or `gh` can't resolve it → catch error, show "Repository not connected to GitHub" message, still show commits.
2. **Private repo, different account**: `gh` call fails silently with empty list → same graceful handling.
3. **Keyword false positives**: Common words like "bus", "audio" match many entries → filter stop-words aggressively, require minimum 4-char non-stop keywords, weight title-match higher than body-match.
4. **Performance**: 3 network calls + correlation across 100 artifacts × 41 entries = 4,100 comparisons — trivial. The bottleneck is network. Cache solves it.
5. **Empty state**: Project with no commits visible to git (detached HEAD, fresh clone, no remote) → show "No git history found" instead of crashing.

---

## Task Breakdown

### Wave 1: Types + API (server-side correlation engine)

#### Task 9.1: Types — shared/types.ts

```typescript
export interface GitHubArtifact {
  type: "issue" | "pr" | "commit";
  id: string;           // "#47", "#18", or short hash "abc123"
  title: string;
  url: string | null;
  date: string;         // ISO timestamp
  confidence: "high" | "medium";
  matchedKeywords: string[];
}

export interface EntryTrace {
  entryId: string;
  entryTitle: string;
  catalogue: string;
  artifacts: GitHubArtifact[];
}

export interface GitHubTrace {
  project: string;
  repoUrl: string | null;
  entries: EntryTrace[];
  artifactCount: { issues: number; prs: number; commits: number };
  correlationCount: number;
  cachedAt: string;     // ISO — so UI can show "last refreshed X ago"
  error: string | null; // non-null if gh failed
}
```

#### Task 9.2: GitHub Trace API endpoint — server/routes/api.ts

**New endpoint:** `GET /api/project/:name/github-trace?refresh=1`

**Logic:**

```
1. Find project path (existing discoverProjects())
2. Check /tmp cache: if exists + age < 10min + no ?refresh → return cached
3. Read catalogues from project (existing readCatalogues())
4. Fetch artifacts in parallel:
   a. git log (always available):
      git log --format="%H|||%aI|||%s|||%b" -n 100
   b. gh issue list (may fail):
      gh issue list --json number,title,body,createdAt,url --limit 100
   c. gh pr list (may fail):
      gh pr list --json number,title,body,createdAt,url,mergedAt --limit 50
   d. gh repo view --json url (to get repo URL)
5. Correlate: for each entry, score each artifact
6. Filter: only keep HIGH + MEDIUM confidence links
7. Cache to /tmp + return
```

**Keyword extraction** (stop-word filtered, ≥4 chars):
```typescript
function extractKeywords(entry: CatalogueEntry): string[] {
  const text = [
    entry.title,
    entry.sections["Root cause"] ?? "",
    entry.sections["Detection signal"] ?? "",
    entry.why ?? "",
  ].join(" ");
  // Filter stop words, require ≥4 chars, lowercase
  return [...new Set(text.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(w => w.length >= 4 && !STOP_WORDS.has(w)))];
}
```

**Scoring:**
- 3+ keyword matches in title → HIGH
- 2+ keyword matches in title, or 3+ in body → HIGH
- 1 keyword match in title or 2+ in body → MEDIUM
- Temporal proximity bonus: entry created within 48h of artifact → +1 tier

**Commit scoring**: match against commit message subject only (body too noisy).

**Error handling**: if `gh` throws → set `error` field, still return commits.

#### Task 9.3: API client — ui/api.ts

```typescript
githubTrace: (name: string, refresh = false) =>
  get<GitHubTrace>(`/project/${encodeURIComponent(name)}/github-trace${refresh ? "?refresh=1" : ""}`),
```

### Wave 2: UI Component

#### Task 9.4: GitHubTrace.ts — ui/components/GitHubTrace.ts

**New file.** Three sections:

**Section 1: Cognitive Loop Diagram**

```
OBSERVE ──→ LEARN ──→ ACTIVATE ──→ ACT ──→ PRODUCE ──→ VERIFY ──→ REFINE
(session)  (entry)    (hook)    (Claude)  (issue/PR)   (test)   (update)
  ●──────────●──────────●──────────●──────────●──────────●──────────●
             41         32 fires             12 artifacts
```

- 7 nodes, horizontal, connected by arrows
- Each node shows a count pulled from real data (entry count, hook fire count, artifact count)
- Static — no click behavior needed, it's a header overview

**Section 2: Entry → Artifacts (forward)**

Default view. Table of catalogue entries with linked artifacts:

```
┌─────────────────────────────────────────────────────────────────────┐
│ Entry                          │ Linked Artifacts                   │
├────────────────────────────────┼────────────────────────────────────┤
│ SP8  Param name mismatch       │ Issue #64 HIGH  "bus routing bug"  │
│      (hetvabhasa)              │ Issue #65 HIGH  "gain difference"  │
│                                │ abc123   MED    "fix: out_bus:0"   │
├────────────────────────────────┼────────────────────────────────────┤
│ SV12 Framework creates         │ PR #40   HIGH   "OSC bundle..."    │
│      instances (vyapti)        │                                    │
├────────────────────────────────┼────────────────────────────────────┤
│ SK4  Build pipeline lifecycle  │ (no links found)                   │
└────────────────────────────────┴────────────────────────────────────┘
```

Click any artifact → expands to show matched keywords.

**Section 3: Artifact → Entries (reverse)**

Toggle to switch direction. Same data, reversed:

```
Issue #64 "bus routing bug"
  → SP8 (HIGH): "parameter", "bus", "routing"
  → SV12 (MED): "framework", "bus"
```

**Controls:**
- Toggle button: "Entry → Artifacts" / "Artifact → Entries"
- Project selector (uses same sidebar pattern as SystemLens)
- Refresh button (calls with `?refresh=1`)
- "Last refreshed X min ago" from `cachedAt`

**Empty/error states:**
- No GitHub connection: "Repository not connected to GitHub. Commits shown only."
- No correlations found: "No links found between catalogue entries and GitHub artifacts. This may improve as more entries are created."
- Loading: spinner

#### Task 9.5: App integration — ui/app.ts

- Import GitHubTrace
- Add `"github-trace"` to ViewName
- Add `toGitHubTrace: (project?: string) => void` to Nav
- Add "GitHub Trace" to sidebar views list (after Brain)
- Add case in renderMain()
- No WebSocket changes needed (trace is on-demand, not live)

#### Task 9.6: CSS — ui/styles/deck.css

- `.github-trace-view` — container
- `.loop-diagram` — horizontal 7-node row
- `.loop-node` — each step box
- `.loop-arrow` — connectors between nodes
- `.loop-node-count` — count below node label
- `.trace-table` — entry/artifact two-column table
- `.trace-entry-row` — left column (entry ID + title)
- `.trace-artifact-list` — right column (artifact chips)
- `.artifact-chip` — individual issue/PR/commit badge
- `.artifact-chip.high` — green border
- `.artifact-chip.medium` — yellow border
- `.artifact-detail` — expanded keyword match display
- `.trace-toggle` — Entry→Artifacts / Artifact→Entries switch
- `.trace-meta` — "last refreshed" + refresh button bar

---

## Execution Order

```
Wave 1:  9.1 Types → 9.2 API endpoint → 9.3 API client  (sequential)
              ↓
Wave 2:  9.4 GitHubTrace component
         9.5 App integration         (parallel)
         9.6 CSS
```

## Verification Criteria

1. Open "GitHub Trace" → select sonicPiWeb → see loop diagram with real counts
2. Entry → Artifacts: SP8 shows at least one linked issue with HIGH or MEDIUM confidence and matched keywords visible on expand
3. Artifact → Entries: Issue #64 shows SP8 and/or SV12 as informing entries
4. Refresh button works: clears cache, re-fetches, updates "last refreshed" time
5. Error state: if tested with a project that has no GitHub remote → shows error message, still shows commit-based links
6. All existing views still work — no regressions

## Scope

- **New files**: 1 (`ui/components/GitHubTrace.ts`, ~350 lines)
- **Modified files**: 3 (`shared/types.ts` ~25 lines, `server/routes/api.ts` ~150 lines, `ui/api.ts` ~3 lines, `ui/app.ts` ~20 lines, `ui/styles/deck.css` ~120 lines)
- **New API endpoints**: 1 (`GET /api/project/:name/github-trace`)
- **External dependencies**: `gh` CLI (already installed + authenticated), `git` (always available)
- **Total new code**: ~650 lines
