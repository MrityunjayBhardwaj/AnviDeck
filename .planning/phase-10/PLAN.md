---
phase: 10
title: Ground Truth Visualization — Three-Layer Grounding Observability
goal: Visualize the grounding chain (Catalogue → Ground Truth doc → source code), show which entries are grounded vs ungrounded, and let the user click through the full provenance chain
status: planned
created: 2026-04-03
---

# Phase 10 Plan: Ground Truth Visualization

## Goal

Make the three-layer grounding abstraction visible. For any catalogue entry, show whether it's grounded (has a `**REF:**` tracing to source code) or ungrounded (a claim without proof). Surface grounding health as a first-class metric alongside fatality, misalignment, and blind spots.

## What Already Exists (v1.1.0 — committed)

- `CatalogueEntry.ref` — the `**REF:**` field extracted by parser
- `CatalogueEntry.grounded` — boolean, true if ref exists and isn't "UNGROUNDED"
- `GroundTruthDoc` type — system, path, lines, codeCitations, stages, lastModified
- `GroundingStatus` type — totalEntries, groundedEntries, ungroundedEntries, groundTruthDocs, sourceDirectories
- `ProjectState.grounding` — field exists in type but server doesn't populate it yet
- `ProjectSummary.groundingPercent` + `groundTruthDocCount` — fields exist but not populated

## Design Analysis

### Existence Gate

1. **Who uses this?** The framework author auditing whether catalogue entries are claims or grounded knowledge. Regulators asking "how do you know this?" for contestability.
2. **What breaks without it?** Ungrounded entries accumulate silently. An entry says "the framework does X at boundary B2" but there's no `file:line` proof. The entry might be wrong — and nobody knows.
3. **Simpler alternative?** No — grounding status is binary per entry (grounded/not) but the visualization needs to show the chain: entry → Ground Truth doc → source code. That's three layers on one screen.

### Data Sources

- **Catalogue entries with REF fields**: Already parsed by `shared/parser.ts`
- **Ground Truth docs**: `{project}/artifacts/ref/GROUND_TRUTH_*.md` — need to scan and parse
- **Source directories**: `{project}/artifacts/ref/sources/*/` — need to list
- **Grounding counts**: Derivable from catalogues (count entries where `grounded === true`)

### Key Insight: Server-Side Reader Is the Foundation

Everything else (UI, Brain overlay, Command Center metric) depends on the server correctly computing `GroundingStatus`. The reader scans Ground Truth docs and counts grounded entries. Once the API returns this data, the UI layers are straightforward.

### Invariants

- **IV1**: `grounded` is derived from `ref` field — parser already handles this. No re-derivation needed.
- **IV2**: Ground Truth docs live at `{projectPath}/artifacts/ref/GROUND_TRUTH_*.md`. Not all projects have them. Return empty arrays gracefully.
- **IV3**: Source directories live at `{projectPath}/artifacts/ref/sources/*/`. Same — may not exist.
- **IV4**: `groundingPercent` = `groundedEntries / totalEntries * 100`. Zero entries → 0%, not NaN.

### Pre-mortem

1. **No Ground Truth docs exist**: Most projects won't have them yet. Every UI element must show a clear "no Ground Truth docs" state, not crash.
2. **ProjectState.grounding not populated**: The type requires it but the server doesn't compute it. Build will fail or return undefined until the server reader is wired. **Fix: server reader is Wave 1.**
3. **REF fields not present in existing catalogues**: sonicPiWeb's entries were created before v1.1.0 — they have no `**REF:**` fields. `grounded` will be `false` for all. The UI must handle 0% grounding gracefully (it's the expected state, not an error).

---

## Task Breakdown

### Wave 1: Server Reader + API (foundation)

#### Task 10.1: Ground Truth reader — server/readers/ground-truth.ts

**New file.** Scans a project for Ground Truth docs and source directories.

```typescript
export async function readGroundingStatus(projectPath: string): Promise<GroundingStatus>
```

**Logic:**
1. Scan `{projectPath}/artifacts/ref/` for `GROUND_TRUTH_*.md` files
2. For each: count lines, count code citations (regex `[a-z_]+\.[a-z]+:\d+`), count stages (`## STAGE` or `## Stage`)
3. Scan `{projectPath}/artifacts/ref/sources/*/` for directory names
4. Count grounded/ungrounded from catalogue entries (call `readCatalogues()`)
5. Return `GroundingStatus`

Graceful when paths don't exist — return zeros and empty arrays.

#### Task 10.2: Wire grounding into existing API endpoints — server/routes/api.ts

- `GET /api/projects`: add `groundingPercent` and `groundTruthDocCount` to each `ProjectSummary`
- `GET /api/project/:name`: add `grounding: GroundingStatus` to `ProjectState`

### Wave 2: UI — Command Center + ProjectView + CatalogueTree

#### Task 10.3: Command Center grounding metric — ui/components/CommandCenter.ts

Add to the health summary card:
```
Grounding: 14/22 (64%)  [yellow bar]
```
Color: green >80%, yellow >50%, red <50%.
Per-project: show grounding % badge next to fatality badge in project list.

#### Task 10.4: ProjectView Ground Truth Inventory — ui/components/ProjectView.ts

New card: "Ground Truth" between Boundaries and Catalogues.

```
┌─────────────────────────────────────────────────┐
│ Ground Truth                                     │
│                                                  │
│ Grounding: ████████░░░░░░ 14/22 (64%)           │
│                                                  │
│ Documents:                                       │
│  GROUND_TRUTH_SUPERSONIC.md  482 lines  87 refs  │
│  GROUND_TRUTH_STRUDEL.md     312 lines  54 refs  │
│                                                  │
│ Sources: artifacts/ref/sources/                   │
│  supersonic/ (23 files)                          │
│  strudel/    (18 files)                          │
│                                                  │
│ Ungrounded entries: SP3, SP7, SV2, SK8           │
└─────────────────────────────────────────────────┘
```

If no Ground Truth docs: show "No Ground Truth docs. Run /anvi:ground to establish grounding."

#### Task 10.5: CatalogueTree REF display — ui/components/CatalogueTree.ts

- Each entry: if `ref` exists, show it as a subtle line below the title
- If `grounded === false`: amber left border on the entry
- Toggle: "Show ungrounded only" filter button at top of catalogue tree

#### Task 10.6: CSS for grounding elements — ui/styles/deck.css

- `.grounding-bar` — progress bar (green/yellow/red fill)
- `.grounding-badge` — small % badge for project list
- `.gt-inventory` — Ground Truth docs table
- `.entry-ungrounded` — amber left border for ungrounded entries
- `.entry-ref` — subtle REF display line
- `.gt-empty` — "no Ground Truth docs" state

### Wave 3: Brain View Integration

#### Task 10.7: BrainView grounding overlay — ui/components/BrainView.ts

In Project mode, boundary cards get grounding indicator:
- Boundary WITH Ground Truth doc covering it: solid border (already the default)
- Boundary WITHOUT: dashed border + "OPAQUE" label
- Grounding status section in the right side of the flow aggregate area

Detection: check if any Ground Truth doc filename matches the boundary name (e.g., `GROUND_TRUTH_SUPERSONIC.md` for boundary "SuperSonicBridge ↔ External").

---

## Execution Order

```
Wave 1:  10.1 Reader → 10.2 Wire API          (sequential — API depends on reader)
              ↓
Wave 2:  10.3 CommandCenter  ←→  10.4 ProjectView  ←→  10.5 CatalogueTree  ←→  10.6 CSS
         (all parallel — independent UI components, all consume same API data)
              ↓
Wave 3:  10.7 BrainView overlay                (depends on Wave 2 CSS + reader)
```

## Verification Criteria

1. `curl /api/projects` → each project has `groundingPercent` and `groundTruthDocCount`
2. `curl /api/project/sonicPiWeb` → `grounding` field with totalEntries, groundedEntries, ungroundedEntries, docs list
3. Command Center shows grounding % per project (likely 0% for all — expected, v1.1.0 just shipped)
4. ProjectView shows Ground Truth Inventory panel (empty state for projects without docs, populated for those with)
5. CatalogueTree shows amber border on ungrounded entries, REF line on grounded ones
6. BrainView boundary cards show dashed/solid based on Ground Truth coverage
7. All existing views still work — no regressions
8. Build passes cleanly

## Scope

- **New files**: 1 (`server/readers/ground-truth.ts`, ~60 lines)
- **Modified files**: 5 (`server/routes/api.ts` ~30 lines, `ui/components/CommandCenter.ts` ~15 lines, `ui/components/ProjectView.ts` ~40 lines, `ui/components/CatalogueTree.ts` ~20 lines, `ui/components/BrainView.ts` ~15 lines, `ui/styles/deck.css` ~40 lines)
- **Total new code**: ~220 lines
- **New API endpoints**: 0 (augmenting existing endpoints)
