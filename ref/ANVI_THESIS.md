# The Ānvīkṣikī Thesis: From Vanilla Claude to Deductive Software Engineering

## What This Document Is

A complete record of why and how we built a cognitive framework that transforms Claude from a reactive code assistant into a deductive engineering system. Every decision is traced from the problem it solves, through the mechanism it uses, to the outcome it produces.

This is not documentation of a tool. It is the thesis behind a methodology — one that emerged from real debugging sessions, real failures, and real corrections over the course of building Sonic Pi Web (a browser-native reimplementation of Sonic Pi's temporal scheduling model in JavaScript).

---

## Part I: The Problem — Why Vanilla Claude Falls Short

### 1.1 The Black Box Problem

Vanilla Claude operates empirically. It reads code, infers what should happen, writes a fix, and moves on. If the fix fails, it tries another. Each attempt is a fresh probe into a black box — the codebase, the runtime, the external systems.

This works for small, isolated tasks. It breaks for:

- **Multi-layer systems** where bugs hide at boundaries between components
- **Long-running sessions** where earlier context is lost to compression
- **Accumulated knowledge** that should carry across sessions but doesn't
- **Architectural decisions** that require understanding invariants, not just symptoms
- **Verification** where "it looks right" is different from "I observed it working"

The fundamental issue: **vanilla Claude's knowledge is amnesic and its reasoning is reactive.** It discovers the same patterns session after session. It falls into the same traps. It optimizes for the smallest diff instead of the right abstraction. And it declares things "verified" based on reading code (inference) instead of running it (observation).

### 1.2 The Cost: Five Concrete Failures

These failures from the Sonic Pi Web project motivated every piece of the framework:

**Failure 1: Event log mistaken for audio observation (SP8)**
The event log showed correct events, correct timing, correct patterns — for 5+ fix rounds. But the actual audio had zero snare content, 17% clipping, and 3x the correct volume. Five rounds of "it's still broken" because Claude read the event log (inference) and declared "verified ✓" instead of analyzing the WAV file (observation).

**Cost:** 5 wasted fix-observe cycles. ~2 hours of debugging.
**Root cause:** No principle distinguishing inference from observation.

**Failure 2: Parameter name mismatch at boundary (SP9)**
Sonic Pi's DSL says `cutoff`. The scsynth synthdef expects `lpf`. Claude sent `cutoff` directly — scsynth silently ignored it. No error. The filter never activated. Discovered only when someone analyzed the audio and noticed drums were unfiltered.

**Cost:** Silent correctness bug shipped and undetected for multiple sessions.
**Root cause:** No protocol for verifying BOTH sides of a system boundary.

**Failure 3: Scattered param fixes across files (SoundLayer)**
BPM scaling, symbol resolution, env_curve injection, param aliasing — each was a small fix. Claude's instinct: inline each fix where the code currently lives. This would scatter param handling across AudioInterpreter, SuperSonicBridge, and SonicPiEngine. Each subsequent fix would touch more files. Diminishing returns.

**Cost:** User had to correct the architectural approach.
**Root cause:** No principle for domain-aligned abstractions. Optimizing for smallest diff instead of right boundary.

**Failure 4: Same error pattern recurring across sessions**
The event-log-as-observation mistake (SP8) wasn't a one-time error. Without a catalogue, the same reasoning failure would recur in the next session. Claude has no cross-session memory of its own reasoning mistakes.

**Cost:** Each session rediscovers traps from scratch.
**Root cause:** No accumulated diagnostic knowledge that persists and is consulted.

**Failure 5: Framework built but not applied**
After building checks, catalogues, and principles — Claude would still "forget" to apply them mid-session. Instructions in CLAUDE.md decay as context fills. The checks exist but aren't enforced.

**Cost:** Framework overhead without framework benefit.
**Root cause:** No injection mechanism. Instructions without enforcement are suggestions.

### 1.3 The Pattern Behind the Failures

All five failures share one structure: **empirical reasoning applied where deductive reasoning was needed.**

- SP8: empirically checked the event log instead of deducing that audio output is the only valid observation for audio bugs.
- SP9: empirically assumed param names match instead of deducing from the synthdef's actual vocabulary.
- SoundLayer: empirically placed fixes where code currently lives instead of deducing from invariant spans where boundaries should be.
- Recurrence: empirically rediscovered patterns instead of deducing from catalogued knowledge.
- Enforcement: empirically hoped Claude would remember instead of deducing that accumulated state needs automatic injection.

**The thesis:** If the system's logic is EXPOSED (made deductive), these failures become structurally impossible — not through discipline, but through mechanism.

---

## Part II: The Architecture — What We Built

### 2.1 The Foundational Principle: Deductive Over Empirical

```
Empirical (black-boxed):
  Code is black box → probe → failure → "oh, THIS is how it works"
  → you only find what you stumble into

Deductive (exposed):
  Catalogues state what MUST hold, what WENT wrong, what ORDER matters
  → you DEDUCE what to check → observe to CONFIRM
  → you find what the logic tells you to look for
```

Observation (Lokayata) remains the final gate — deduction without empirical confirmation is inference. But the DIRECTION flips: top-down and targeted instead of bottom-up and reactive.

This converts "I don't know what I don't know" into "I know exactly what I don't know, and here's where to look."

### 2.2 The Four Catalogues

The catalogues are the deductive layer. They store project-specific knowledge in structured form so that reasoning about the system is deductive — from stated principles to conclusions.

**Hetvabhasa (error patterns):** What went wrong, why, the trap (wrong fix), and the real fix. Consulted BEFORE debugging — matches symptoms against known patterns. Prevents re-investigation.

**WHY:** SP8 caused 5 wasted rounds because the error pattern wasn't catalogued after round 1.

**Vyapti (invariants):** Structural rules that must hold. Each invariant has a span — the set of code it reaches. The span defines module boundaries.

**WHY:** SV12 (BPM scaling) spans 3 modules. Without the invariant stated, the span is invisible. With it stated, the misalignment is deducible — you don't need to discover it through failure.

**Krama (lifecycle patterns):** Execution order, numbered steps, common violations. Lifecycle steps that must execute atomically define what CAN'T be split across modules.

**WHY:** SK4 (audio message pipeline) crosses 4 boundaries. Each crossing is a bug site. Without the lifecycle mapped, you discover ordering bugs through runtime failures.

**Dharana (focused attention):** Project-specific instantiation of global principles. Boundaries, invariant spans, lens configuration, organizational health. Every entry carries ORIGIN/WHY/HOW provenance.

**WHY:** Global principles are a machine with no fuel. Dharana is the fuel — "for THIS project, check THESE specific things at THESE specific boundaries."

### 2.3 Domain-Aligned Abstractions

**Problem solved:** Vanilla Claude optimizes for smallest diff — scatter fixes inline. This creates diminishing returns as each fix touches more files.

**Mechanism:** Abstraction boundaries come from the domain structure, not implementation convenience. The domain structure is observable:

1. Read vyapti → invariant span = module boundary
2. Read krama → atomic lifecycle span = can't split
3. Check reference system → pre-validated boundaries
4. If no catalogues → observe where fixes land (Lokayata applied to architecture)

**The diminishing returns test:** If fix N touches more files than fix N-1 in the same concern, the abstraction is wrong. Observable signal, not design opinion.

**Decision:** User corrected Claude's plan to scatter 4 fixes inline. The principle was generalized: match the reference system's layer boundaries (Sonic Pi's `sound.rb` → our `SoundLayer.ts`). A standalone module that mirrors the reference 1:1 gives one audit surface, explicit divergences, and flat cost curve.

### 2.4 Organizational Fatality

**Problem solved:** When code organization doesn't match domain boundaries, every fix has a half-life. The structure actively works against correct fixes.

**Mechanism:** The catalogues diagnose it:
- Hetvabhasa clustering: 3+ error patterns at the same boundary → boundary is wrong
- Vyapti spanning: invariant spans 3+ modules → modules are entangled
- Krama crossing: lifecycle crosses 3+ boundaries → too many handoffs

**The fatality test:** Check all three. If ANY signals, the organization is the bug — stop fixing symptoms, restructure.

**Decision:** 5 hetvabhasa patterns (SP8, SP9, SP10, SP11, SP12) clustered at the AudioInterpreter↔SuperSonicBridge boundary. Fatality confirmed. Intervention: SoundLayer module that consolidates all parameter transformation.

### 2.5 Adaptive Observation System

**Problem solved:** Problems don't sit on one axis. SP11 (FX recreated per iteration) was ownership AND timing AND lifecycle. No single lens catches multi-axis bugs.

**Mechanism — four connected components:**

**Boundary-pair observation:** Observe BOTH sides of every boundary. Your side (what you sent) and their side (what they received). Closes the class of bugs where one side silently fails (SP9: scsynth ignores unknown params).

**Observation-driven lens chaining:** Each observation activates the next lens. Combinations emerge from signal, not exhaustive search. "Resource growing unboundedly" → timing fires → "created per iteration" → ownership fires → "wrapper recreates" → lifecycle fires → "reference creates once." Three axes, assembled by observation.

**Depth control:** Surface (does this axis apply?), shallow (what does it show at the boundary?), deep (trace end-to-end). Go deeper only when observation demands it. Catalogues accelerate at each depth — hetvabhasa shortcuts at surface, vyapti guides at shallow, krama sequences at deep.

**Detachment:** Stop when: Lokayata confirms + five-limbed argument complete + fix works. Going deeper without a concrete failed observation is attachment, not insight.

**Decision:** These emerged from analyzing how the actual debugging sessions worked — not from abstract design. The SP11 diagnosis was traced retroactively to identify the pattern.

### 2.6 Lens Span Completeness (Self-Adapting Coverage)

**Problem solved:** Fixed lens axes (data-flow, timing, ownership, boundary) can't cover every domain. New dimensions emerge that no existing axis models.

**Mechanism:** After every multi-attempt fix:
1. Which axis caught it? Update catalogue if entry was missing (sharpens existing lens).
2. No axis covered it? Blind spot → name the new dimension → create first catalogue entry → add axis.

**Decision:** Design-driven. If the system has fixed axes, it can never discover what it doesn't model. Self-adaptation is structurally necessary.

### 2.7 System Lens — Framework Observes Itself

**Problem solved:** The framework demands Lokayata for code but exempted itself. Nothing observed whether the catalogues, dharana, or lenses actually improved outcomes.

**Mechanism:**
- Per-session: contribution check (did any entry accelerate diagnosis? did dharana fire via dhyana?)
- Per-milestone: framework health (entries that never contributed → stale candidates, cost vs catch rate)
- Pruning: entries protected by WHY field (Chesterton's fence). Retire only when the guarded condition no longer exists.

**Decision:** Without self-observation, the framework is an open loop — it accumulates but can't self-correct. The system lens closes the loop.

### 2.8 Composition Verification

**Problem solved:** Individual fixes verified in isolation, but interactions between them unverified. Two correct changes can create emergent failure.

**Mechanism:** List all changes landing together → identify pairs where output of one flows through the other → observe each interaction specifically.

**Decision:** The SoundLayer has 4 P0 fixes that interact: BPM scaling × symbol resolution (order matters), BPM scaling × env_curve (must NOT scale), BPM scaling × FX persistence (FX params not BPM-scaled). Each pair needs its own observation.

### 2.9 Observation Grounding — Tool Generation

**Problem solved:** The system says "observe X" but never asks "CAN we observe X?"

**Mechanism:** Decision tree:
```
Assertion at level L → observation spec (signal, source, analysis)
  → existing tool matches? → use it
  → no tool? → capturable at runtime?
    → yes → spec IS the tool design → build it
    → no → document as blind spot in dharana
```

**Decision:** The Chromium capture tool (`tools/capture.ts`) was built ad-hoc because audio observation needed a tool. This protocol makes the tool generation process explicit and repeatable.

### 2.10 Design-Entailed Requirements

**Problem solved:** Some requirements are GUARANTEED by the architecture but the system would defer them to "observe first." This is a category error — applying an empirical principle where a logical one applies.

**Mechanism:** If the architecture guarantees a need (accumulated state → needs observability, multiple layers → need composition verification), build it at design time. Don't wait for the observation loop.

**Decision:** User pointed out that the observation dashboard isn't speculative — it's deductively necessary. A system that accumulates state necessarily needs observability infrastructure. Waiting to "observe the need" misapplies Lokayata to a logical entailment.

**The deeper insight the system can't generate itself:** Dharana focuses on project boundaries. Dhyana on current work. System lens on effectiveness. None have scope over "does the observation infrastructure itself need infrastructure?" This class of insight — foresight from design, not hindsight from failure — is meta to the system. It must be applied by the architect.

### 2.11 Dharana — Project-Specific Instantiation

**Problem solved:** Global principles are abstract. "Observe both sides of every boundary" — which boundaries? How many? What to look for?

**Mechanism:** Dharana instantiates global principles for a specific project:
1. Project boundaries (with silent-failure modes from hetvabhasa)
2. Active invariant spans (ALIGNED/MISALIGNED from vyapti)
3. Lens configuration (instantiated lens steps per boundary)
4. Organizational health (fatality test results)
5. Composition pairs (interaction verification targets)
6. Observation tools (exists/to-build/blind-spot)

Every entry carries **ORIGIN** (what created it), **WHY** (what breaks without it), **HOW** (what it enables).

**Provenance prevents:** Cargo-cult splits (no evidence for the boundary) AND premature removal (Chesterton's fence — read WHY before deleting).

**Promotion model:** Single occurrence → memory. Recurrence → dharana entry. Prevents bloat while capturing real patterns.

### 2.12 Dhyana — Sustained Runtime Awareness

**Problem solved:** Dharana defines WHAT to focus on. But it's a file read at session start and forgotten during work. The checks decay as context fills.

**Mechanism:** At session start, load dharana's project-specific knowledge into the base layer's check slots. Every code change during work pattern-matches against scoped dharana entries:

```
Code change → touches a dharana boundary?
  → NO: generic base-layer checks (sufficient)
  → YES: fire project-specific checks:
    - hetvabhasa patterns at this boundary
    - vyapti invariants that span it
    - boundary-pair observation targets
```

**The difference:** Without dhyana, checks are recalled (manual, decays). With dhyana, checks are injected (automatic, persistent).

**Session-level lens instantiation:** Generic lens steps become project-specific. "Scan boundaries" becomes "check SP9 at B2." "Error susceptibility" becomes "param name mismatch is the known trap here."

### 2.13 The Catalogue Context Injector — Enforcement Per Action

**Problem solved:** Even dhyana as an instruction can be forgotten. Instructions in CLAUDE.md decay as context compresses.

**Mechanism:** A `PreToolUse` hook (`catalogue-context-injector.js`) that fires on every `Write|Edit`:
1. Reads `.anvi/dharana.md`
2. Matches the file being edited against known boundaries
3. Injects relevant checks into the conversation as `additionalContext`

The injection is automatic — not reliant on Claude "remembering" to check. When editing `AudioInterpreter.ts`, the hook injects: "DHYANA: touches boundary B2. FATALITY — 3+ error patterns cluster here."

**Decision:** Design-entailed. The framework accumulates knowledge in catalogues. Without per-action injection, that knowledge decays within the context window. The hook ensures catalogue knowledge is active on every code change, not just at session start.

### 2.14 Framework Version Control

**Problem solved:** The framework evolves across sessions — CLAUDE.md changes, catalogues grow, memory mutates. Without version history, there's no diff visibility, no rollback, and no data for the system lens to analyze.

**Mechanism:** `git init` in `~/.claude/`. Tracks:
- Global CLAUDE.md (principles)
- Memory files (cross-session knowledge)
- Cognitive OS files (base layer, lenses)
- Per-project memory
- Hooks and tools

Commit per session. Commit message references the session and what changed.

**Decision:** Design-entailed. Accumulated state requires version history, or adaptation is irreversible and the system lens has no timeline to measure against.

### 2.15 The Dashboard — Primary Observation Desk

**Problem solved:** The system lens needs data to observe. Without a dashboard, system lens checks are manual grep-through-git-log.

**Mechanism:** CLI tool (`anvi-dashboard.sh`) that reads framework state:
- Framework git state (commits, dirty status)
- Global CLAUDE.md structure
- Project catalogues (entry counts per catalogue)
- Dharana health (fatality signals, misaligned invariants, blind spots)
- Project memory state
- Cross-project summary

**Decision:** Design-entailed. Accumulated state necessarily needs observability. The dashboard is the system lens's instrument.

---

## Part III: The Flow — How It All Connects

### 3.1 Information Flow: Top-Down (Instantiation)

```
GLOBAL PRINCIPLES (deductive over empirical, domain-aligned abstractions,
                   adaptive observation, design-entailed requirements)
    ↓ instantiate via catalogues
PROJECT CATALOGUES (hetvabhasa, vyapti, krama → dharana)
    ↓ scope to current work
SESSION (dhyana loads dharana into base-layer check slots)
    ↓ fire on every action
ACTION (hook injects boundary-specific checks per Write|Edit)
```

Each level adds specificity, removes abstraction. Global says "observe both sides." Project says "these 4 boundaries, these patterns." Session says "this work touches B2." Action says "this file at B2, check SP9."

### 3.2 Information Flow: Bottom-Up (Feedback)

```
ACTION (observation during fix)
    ↓ feeds
SESSION (catalogue updates, new patterns discovered)
    ↓ derives
PROJECT (dharana re-derived, fatality test re-run)
    ↓ informs
GLOBAL (new axis if blind spot detected, pruning if dead weight)
```

Each level adds generality, removes specifics. A failed fix at B2 becomes hetvabhasa entry SP15. SP15 clustered with SP8-12 strengthens the fatality signal. The fatality signal validates the SoundLayer consolidation decision. The consolidation pattern generalizes to the domain-aligned abstraction principle.

### 3.3 The Self-Regulating Properties

**Depth adapts:** Cheap problems resolve at surface (one observation). Deep problems chain through multiple lenses at deep resolution. Observation controls, not rules.

**Coverage adapts:** Blind spots create new axes. The lens system learns dimensions it didn't model.

**Staleness resolves:** System lens prunes entries that don't contribute. Provenance (WHY) prevents premature pruning.

**Cost adapts:** If framework overhead exceeds catch rate for 2+ sessions, system lens flags it. Dead weight gets retired.

**Enforcement adapts:** Hook injection is automatic. Dhyana checks fire per action. No reliance on remembering.

### 3.4 The Complete Cycle

```
OBSERVE (Lokayata — what did I directly see?)
    ↓
WHICH LENS? (catalogue-informed — known pattern match?)
    ↓
OBSERVE AT DEPTH (dharana-scoped — this project's boundaries)
    ↓
RESOLVES or CHAINS? (observation activates next lens)
    ↓
FIX + OBSERVE RESULT (Lokayata gate — both sides of boundary)
    → Works: DETACH. Ship it.
    → Fails: new observation → return to top
    ↓
CATALOGUE EVOLUTION (update hetvabhasa/vyapti/krama)
    ↓
DHARANA RE-DERIVATION (new clustering? new spans? new health?)
    ↓
SYSTEM LENS (did the framework contribute? prune dead weight)
    ↓
Next session starts sharper than the last.
```

---

## Part IV: The Decisions — Why Each Choice Was Made

### 4.1 Why Catalogues Instead of Comments or Documentation?

Comments are local — they annotate code. Documentation is external — it describes the system. Catalogues are **diagnostic tools** — they are consulted during active work to direct reasoning.

The key difference: comments say "this code does X." Catalogues say "when you see symptom Y at this boundary, the root cause is Z, and the trap is W." They're addressed to the practitioner in the moment of debugging, not to the reader understanding the code.

### 4.2 Why Four Catalogues, Not One?

Each catalogue serves a different cognitive function:
- Hetvabhasa → recognition ("I've seen this before")
- Vyapti → deduction ("this MUST hold, therefore...")
- Krama → sequencing ("this happens before that")
- Dharana → focus ("for THIS project, check HERE")

Combining them into one file would lose the functional separation. When debugging, you check hetvabhasa first (fast pattern match). When designing, you check vyapti (invariant constraints). When sequencing, you check krama. Different cognitive actions, different data structures.

### 4.3 Why ORIGIN/WHY/HOW on Every Dharana Entry?

Without provenance, entries become cargo cult. "We check this boundary" — but why? When the code changes and the boundary moves, nobody knows whether the entry is still relevant. ORIGIN tells you when and why it was created. WHY tells you what breaks without it. HOW tells you what it enables.

This also prevents the opposite failure: premature removal. Before deleting an entry, read WHY. If the condition it guards is still possible, removing it reopens the blind spot. Chesterton's fence applied to the framework.

### 4.4 Why Observation-Driven Lens Chaining Instead of Exhaustive Checks?

7 axes × all pairs = 21 combinations. All triples = 35. Exhaustive checking is useless. The observation-driven approach: each observation tells you which axis to check next. The combination that matters assembles itself from the signal. Cheap problems stay shallow. Deep problems go deep. Cost is proportional to complexity, not to framework overhead.

### 4.5 Why Detachment as a First-Class Principle?

Without detachment, depth has no termination condition. "What if there's something deeper?" is unbounded. Detachment says: when Lokayata confirms, the five-limbed argument is complete, and the fix works — stop. Going deeper without a concrete failed observation is attachment to the investigation, not service to the problem.

This prevented the opposite of the "too shallow" failure (SP8 declaring victory from the event log). "Too deep" is when you keep investigating after confirmation because the investigation feels productive. Both waste time. Detachment terminates at the right depth.

### 4.6 Why Design-Entailed Requirements as a Separate Principle?

The framework's primary principle is Lokayata — observe before acting. But some requirements are GUARANTEED by the architecture. Observing that a car needs brakes is unnecessary — physics guarantees it. Similarly, observing that accumulated state needs observability is unnecessary — the architecture guarantees it.

Applying "observe first" to logical entailments is a category error. The design-entailed principle carves out the cases where deduction is sufficient and observation would be wasted time.

### 4.7 Why a Hook Instead of Just Instructions?

Instructions in CLAUDE.md decay. The context window compresses earlier messages. Mid-session, the detailed dharana checks that were "loaded" at session start are gone — compressed to a summary or dropped entirely.

The hook is immune to context compression. It fires per-action, reads dharana from disk (not from context), and injects fresh context. The knowledge is always current, regardless of where in the session you are.

### 4.8 Why Version Control the Framework?

The system lens says "observe whether the framework is working." Without version history, there's nothing to observe. You can't diff what didn't track. You can't measure contribution over time. You can't roll back a bad principle.

Git in `~/.claude/` gives the system lens data: when entries were added, what changed between sessions, which principles were modified. The cost is one commit per session. The benefit is complete observability of the framework's own evolution.

### 4.9 Why the "Deductive Over Empirical" Principle at the Top?

Every mechanism in the framework serves one purpose: make reasoning deductive instead of empirical. Catalogues expose invariants (deductive). Dharana instantiates checks (deductive). Dhyana applies them continuously (deductive). The hook enforces them per-action (deductive). Lokayata confirms them (empirical — the final gate).

Placing this at the top makes every subsequent section understandable in context. The reader doesn't need to understand dharana or dhyana to grasp the framework — they need to understand that catalogues make the black box transparent, and everything else follows from that.

---

## Part V: What Vanilla Claude Cannot Do That This System Enables

| Capability | Vanilla Claude | With Anvi Framework |
|-----------|---------------|-------------------|
| Cross-session knowledge | Amnesic — rediscovers patterns each session | Catalogues persist. Hetvabhasa prevents re-investigation. |
| Architectural reasoning | Optimizes for smallest diff | Domain-aligned abstractions from invariant spans |
| Boundary awareness | Checks own side only | Boundary-pair observation — both sides verified |
| Multi-axis diagnosis | Single classification, one attempt | Observation-driven lens chaining — emerges from signal |
| Verification | "Looks right" (inference) | Lokayata gate — direct observation required |
| Self-correction | No feedback on own reasoning | System lens — framework observes itself |
| Composition | Individual fixes only | Composition verification — interactions checked |
| Enforcement | Instructions that decay | Hook injection per action — immune to context compression |
| Staleness detection | None | System lens pruning + dharana validation |
| Tool generation | Ad-hoc | Observation spec → decision tree → build or document blind spot |
| Structural diagnosis | Per-bug diagnosis | Organizational fatality — catalogue-diagnosed structural misalignment |
| Depth control | Unbounded investigation or premature completion | Observation-driven depth with detachment on confirmation |

---

## Part VI: The Meta-Insight

The framework itself demonstrates its own thesis.

Building it was an empirical process — we discovered each mechanism through friction:
- SP8 friction → Lokayata principle
- SP9 friction → boundary-pair observation
- SoundLayer friction → domain-aligned abstractions
- Recurrence friction → catalogues
- Context decay friction → hook injection
- Dashboard friction → design-entailed requirements

But NOW the framework is built, future work is deductive. The catalogues state what to check. Dharana instantiates where. Dhyana runs the checks continuously. The hook enforces per-action. The system lens observes itself.

The transition from empirical to deductive is itself the proof: building the framework was hard (empirical, discovery-driven). Using the framework is targeted (deductive, catalogue-driven). The cost curve flattened — not because the problems got easier, but because the accumulated knowledge made reasoning about them cheaper.

**"I don't know what I don't know" became "I know exactly what I don't know, and here's where to look."**

That's the thesis. Everything else is mechanism.

---

*Written 2026-03-31. Sonic Pi Web project, framework design session.*
*Framework repo: `~/.claude/.git` — 4 commits tracking the complete build.*
*Project dharana: `artifacts/.anvi/dharana.md` — 4 boundaries, 5 invariant spans, 4 composition pairs.*
*Active hook: `catalogue-context-injector.js` — fires on every Write|Edit.*
