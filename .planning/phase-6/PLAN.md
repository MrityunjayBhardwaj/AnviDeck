---
phase: 6
title: Cross-Project Intelligence
goal: Find patterns that span multiple projects without manual comparison
status: planned
created: 2026-04-01
---

# Phase 6 Plan: Cross-Project Intelligence

## Goal

Surface patterns that recur across projects: error patterns that appear in multiple hetvabhasa catalogues, invariants that hold universally, and memory entries that connect thematically. The user shouldn't have to manually compare catalogues across 6+ projects.

## Design Analysis

### Existence Gate

1. **Who uses this?** Framework author reviewing whether patterns discovered in one project apply elsewhere.
2. **What breaks without it?** Each project's catalogues are islands. The same mistake gets rediscovered across projects instead of recognized as a universal trap.
3. **Simpler alternative?** A text search across all `.anvi/` dirs, but that requires knowing what to search for. This surfaces patterns the user hasn't thought to look for.

### Invariants

**V1: Read-only aggregation.** This view computes similarities — it never modifies any project's catalogues.

**V2: All data from existing APIs.** No new data sources needed. `/api/projects` + `/api/project/:name` provide all catalogue and memory data. The cross-project analysis is purely client-side computation.

**V3: Similarity is structural, not textual.** Two hetvabhasa entries are "similar" if they share root cause category (data-flow/timing/ownership/boundary) AND similar detection signals — not just overlapping words.

### Pre-mortem

**F1: Similarity detection is hard.** NLP-level similarity requires infrastructure we don't have (embeddings, etc.). **Mitigation:** Use structural signals: same section headers (e.g., "Root cause: timing"), same tags, overlapping keywords in specific fields. Simple but effective for structured markdown.

**F2: Too many projects, most empty.** 17 projects discovered, but only ~6 have catalogues. **Mitigation:** Filter to projects with catalogue entries > 0. Already done in the existing API.

**F3: Memory network could be overwhelming.** 50+ memory entries across projects. **Mitigation:** Group by type (feedback, project, user, reference), show clusters, not individual connections.

---

## Task Breakdown

### Wave 1: Server-side (cross-project aggregation API)

#### Task 6.1: Cross-project analysis API — server/routes/api.ts

**New endpoint:** `GET /api/cross-project`

Returns pre-computed cross-project patterns:

```typescript
interface CrossProjectData {
  recurringPatterns: {
    keyword: string;       // shared root cause or detection signal
    entries: { project: string; entryId: string; title: string; content: string }[];
  }[];
  sharedInvariants: {
    keyword: string;
    entries: { project: string; entryId: string; title: string }[];
  }[];
  memoryNetwork: {
    byType: Record<string, { project: string; name: string; description: string }[]>;
    totalCount: number;
  };
  projectCount: number;
}
```

**Similarity logic:**
1. Load all projects with catalogues
2. For hetvabhasa: extract "Root cause" and "Detection signal" sections from each entry. Normalize text (lowercase, strip punctuation). Find entries across different projects that share 3+ significant keywords in these fields.
3. For vyapti: extract invariant statement (first line). Find entries across projects with matching keywords.
4. For memory: group all memory entries by type across all projects.

**Verification:** `curl localhost:3000/api/cross-project` returns recurring patterns from sonicPiWeb + struCode + composr etc.

### Wave 2: UI Component

#### Task 6.2: Types — Add cross-project types to shared/types.ts

Add the `CrossProjectData` interface and sub-types.

#### Task 6.3: CrossProject component — ui/components/CrossProject.ts

**New file.** Three sections:

**Section 1: Recurring Error Patterns**
- Cards showing patterns that appear in 2+ projects
- Each card: shared keyword/theme, list of matching entries with project badge
- Click entry → shows the full content side-by-side
- Sorted by number of projects (most widespread first)

**Section 2: Shared Invariants**
- Similar layout: invariants found across multiple projects
- Highlights universal principles vs project-specific rules

**Section 3: Memory Overview**
- Grouped by type: feedback, project, user, reference
- Per group: count across all projects, list of entries
- Shows which projects have the most accumulated memory

**Data flow:** Single API call to `/api/cross-project` on mount, render all three sections.

#### Task 6.4: App integration + CSS

- Add "Cross-Project" nav item in sidebar
- Add `currentView: "cross-project"` routing
- CSS for pattern cards, project badges, memory groups

---

## Execution Order

```
Wave 1:  6.1 API endpoint
              ↓
Wave 2:  6.2 Types → 6.3 CrossProject → 6.4 App + CSS
```

## Verification Criteria

The phase is DONE when:
1. Open AnviDeck → click "Cross-Project" → see the dashboard
2. Recurring patterns section shows entries from 2+ projects with shared themes
3. Shared invariants section shows cross-project invariants
4. Memory overview shows all memory grouped by type
5. All other views still work
