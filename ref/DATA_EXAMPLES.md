# Data Examples — What the Parser Reads and What the UI Renders

## Example 1: Hetvabhasa Entry (from sonicPiWeb)

### Raw markdown:
```markdown
## SP9: Parameter Name Mismatch at Layer Boundary
**Root cause:** Sonic Pi's DSL uses one name (e.g., `cutoff`), but the scsynth synthdef expects a different name (e.g., `lpf`).
**Detection signal:** Filter/effect has no audible impact despite correct parameter value. No error logged.
**The trap:** Assume all parameter names pass through unchanged.
```

### Parsed to:
```json
{
  "id": "SP9",
  "title": "Parameter Name Mismatch at Layer Boundary",
  "sections": {
    "Root cause": "Sonic Pi's DSL uses one name...",
    "Detection signal": "Filter/effect has no audible impact...",
    "The trap": "Assume all parameter names pass through unchanged."
  },
  "tags": []
}
```

## Example 2: Dharana Boundary Entry (from sonicPiWeb)

### Raw markdown:
```markdown
### B2: AudioInterpreter ↔ SuperSonicBridge (FATALITY — 5 patterns cluster here)
ORIGIN: SP8, SP9, SP10, SP11, SP12 all cluster at this boundary.
WHY: This is the single highest-concentration error boundary...
HOW: Consolidation target: SoundLayer module...

**Known silent-failure modes:** scsynth ignores unrecognized params without error.
**Observe THEIR side:** Capture WAV output and analyze.
```

### Parsed to:
```json
{
  "id": "B2",
  "title": "AudioInterpreter ↔ SuperSonicBridge",
  "sections": {
    "Known silent-failure modes": "scsynth ignores unrecognized params without error.",
    "Observe THEIR side": "Capture WAV output and analyze."
  },
  "tags": ["FATALITY"],
  "origin": "SP8, SP9, SP10, SP11, SP12 all cluster at this boundary.",
  "why": "This is the single highest-concentration error boundary...",
  "how": "Consolidation target: SoundLayer module..."
}
```

## Example 3: Vyapti Entry with Status

### Raw markdown:
```markdown
## SV12: BPM Scales Time Parameters
**Statement:** All time-based synth parameters must be multiplied by `60/BPM` before sending.
**Status:** NOT YET IMPLEMENTED — P0 gap G_NEW.1.
```

### Parsed to:
```json
{
  "id": "SV12",
  "title": "BPM Scales Time Parameters",
  "sections": {
    "Statement": "All time-based synth parameters must be multiplied by 60/BPM...",
    "Status": "NOT YET IMPLEMENTED — P0 gap G_NEW.1."
  },
  "tags": ["NOT YET IMPLEMENTED"]
}
```

## Example 4: Memory Entry with Frontmatter

### Raw markdown:
```markdown
---
name: Match reference architecture, not smallest diff
description: Design decisions should optimize for structural parity...
type: feedback
---

When placing fixes or features, match the reference system's...

**Why:** User corrected my plan...
**How to apply:** Before proposing where to place a fix...
```

### Parsed to:
```json
{
  "name": "Match reference architecture, not smallest diff",
  "description": "Design decisions should optimize for structural parity...",
  "type": "feedback",
  "content": "When placing fixes or features, match the reference system's...",
  "sections": {
    "Why": "User corrected my plan...",
    "How to apply": "Before proposing where to place a fix..."
  }
}
```

## Example 5: Git Timeline Point

### From `git log --format`:
```
1ff0b0d|📋 init: complete Anvi cognitive framework — first tracked state|2026-03-31 19:30:00
891b5c1|📋 add: system lens, design-entailed requirements, observation dashboard|2026-03-31 19:45:00
40fa66a|📋 add: catalogue-context-injector hook — dhyana enforcement|2026-03-31 19:52:00
28204a5|📋 add: foundational principle — deductive over empirical|2026-03-31 20:10:00
7d5e086|📋 add: complete Anvi thesis — end-to-end WHY/WHAT/HOW|2026-03-31 20:20:00
```

### Parsed to:
```json
[
  { "hash": "1ff0b0d", "message": "📋 init: complete Anvi cognitive framework", "date": "2026-03-31T19:30:00", "filesChanged": ["CLAUDE.md", "memory/", "anvi/", ...] },
  { "hash": "891b5c1", "message": "📋 add: system lens, design-entailed, dashboard", "date": "2026-03-31T19:45:00", "filesChanged": ["CLAUDE.md", "tools/anvi-dashboard.sh"] }
]
```

## Example 6: Hook Activity Log Line

### Written by catalogue-context-injector.js to `/tmp/anvi-hook-{session}.log`:
```json
{"timestamp":"2026-03-31T20:30:00Z","session":"abc123","file":"src/engine/SuperSonicBridge.ts","boundaries":["B2","B3"],"fatality":true,"injected":"DHYANA: editing SuperSonicBridge.ts touches B2, B3. FATALITY."}
```

## Project Discovery

### How to find all projects:
```bash
ls ~/.claude/projects/
# Output: path-encoded directory names
# -Users-mrityunjaybhardwaj-Documents-projects-sonicPiWeb
# -Users-mrityunjaybhardwaj-Documents-projects-struCode
# ...
```

### Decode project path from directory name:
```typescript
function decodeProjectPath(dirName: string): string {
  return dirName.replace(/^-/, '/').replace(/-/g, '/')
}
// "-Users-mrityunjaybhardwaj-Documents-projects-sonicPiWeb"
// → "/Users/mrityunjaybhardwaj/Documents/projects/sonicPiWeb"
```

### Find .anvi/ for a project:
```typescript
function findAnviDir(projectPath: string): string | null {
  for (const candidate of [
    path.join(projectPath, '.anvi'),
    path.join(projectPath, 'artifacts', '.anvi'),
  ]) {
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}
```
