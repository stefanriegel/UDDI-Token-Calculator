# Phase 14: Phase 11 Verification + Traceability Cleanup - Research

**Researched:** 2026-03-13
**Domain:** Verification, documentation cleanup, tech debt
**Confidence:** HIGH

## Summary

Phase 14 is a non-code-heavy phase focused on four deliverables: (1) creating Phase 11's VERIFICATION.md for FE-03 through FE-06, (2) auditing and updating the full REQUIREMENTS.md traceability table, (3) fixing stale SSE references in Go code, and (4) investigating the NIOS subscription ID round-trip. The source files are well-understood from code inspection. The nios-calc files live at `frontend/src/app/components/nios-calc.ts` and `frontend/src/app/components/nios-calc.test.ts` (not `lib/` as originally assumed in some Phase 11 docs). There are 9 vitest tests covering the calc functions. The stale SSE comment is confirmed at `server/types.go:36` and is the only SSE reference remaining in Go code.

**Primary recommendation:** Single plan with four sequential tasks: run vitest, write VERIFICATION.md, update REQUIREMENTS.md traceability, fix stale comment + investigate subscription round-trip.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Code inspection of wizard.tsx and nios-calc.ts -- no Playwright or manual testing
- Run vitest and include pass/fail counts as evidence for FE-05/FE-06 calc logic
- VERIFICATION.md format: pass/fail per requirement + file:line evidence + one-liner confirming logic matches success criteria
- Verify code as-shipped -- do not note the skipped plan 04 (human checkpoint) gap
- Phase 11 plans 01-03 + quick task bug fixes are the verification baseline
- NIOS subscription ID round-trip: investigate and fix (not document-only)
- Trace the full flow: upload response -> subscriptions['nios'] -> scan request selectedMembers
- Also verify WAPI mode: validate endpoint -> subscriptions -> scan request
- Full audit of all 28 requirements in REQUIREMENTS.md traceability table -- not just FE-03-FE-06
- Fix any stale statuses found (not just what success criteria lists)
- Update ROADMAP.md progress table (Phase 11 status, Phase 14 plan count)
- Fix stale SSE comment at server/types.go:36 ("/events" reference)
- Grep for additional stale SSE/EventSource references in Go code and fix any found
- Keep cleanup focused -- no general refactoring beyond stale SSE refs

### Claude's Discretion
- Exact VERIFICATION.md structure and section ordering
- Whether to split into multiple plans or single plan
- How to organize the traceability audit findings

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| FE-03 | Results step shows Top Consumer Cards (DNS, DHCP, IP/Network -- expandable, top 5 per category, client-side only) | wizard.tsx:1941-2030 implements three expandable consumer cards with regex-based filtering; state at lines 225-227 |
| FE-04 | Results step shows NIOS-X Migration Planner (3-scenario comparison: Current/Hybrid/Full UDDI) when NIOS was scanned | wizard.tsx:2412-2620 implements planner with member selector, per-member form factor, three scenario comparison |
| FE-05 | Results step shows Server Token Calculator (per-member form factor selection: NIOS-X vs XaaS) when NIOS was scanned | wizard.tsx:2625-2900+ implements calculator using calcServerTokenTier from nios-calc.ts; 7 vitest tests cover tier selection |
| FE-06 | Results step shows XaaS Consolidation panel (bin-packing with S/M/L/XL tiers, connection limits, extra connections at 100 tokens each) | wizard.tsx:2644-2660 calls consolidateXaasInstances from nios-calc.ts; 8 vitest tests cover bin-packing and extra connections |
</phase_requirements>

## Standard Stack

Not applicable -- this phase does not introduce new libraries. Existing tools used:

| Tool | Version | Purpose |
|------|---------|---------|
| vitest | ^4.0.18 | Run nios-calc test suite for evidence |
| grep/search | - | Find stale SSE references in Go code |

**Test command:** `cd frontend && npx vitest run`

## Architecture Patterns

### VERIFICATION.md Format

Follow the established pattern from Phase 10 VERIFICATION.md (`.planning/phases/10-nios-backend-scanner/10-VERIFICATION.md`):

```
---
phase: 11-frontend-nios-features
verified: [timestamp]
status: passed|failed
score: X/Y must-haves verified
re_verification: false
gaps: []
---

# Phase 11: Frontend NIOS Features Verification Report

## Goal Achievement
### Observable Truths
| # | Truth | Status | Evidence |

### Requirements Coverage
| Requirement | Source Plan | Description | Status | Evidence |

### Gaps Summary
```

Prior verification reports exist for Phases 9, 10, 12, and 13 -- all follow this format.

### Traceability Table Pattern

REQUIREMENTS.md uses this format:
```markdown
| Requirement | Phase | Status |
|-------------|-------|--------|
| FE-03 | Phase 14 | Pending |
```

Status values: "Complete" or "Pending". Phase 14 needs to flip FE-03/FE-04/FE-05/FE-06 from "Pending" to "Complete" and update Phase column from "Phase 14" to "Phase 11" (since they were implemented in Phase 11, verified in Phase 14).

### Current Traceability Issues Found

From REQUIREMENTS.md inspection:
1. FE-03 through FE-06 show "Phase 14" and "Pending" -- should be "Phase 11" and "Complete" after verification
2. All other requirements already show "Complete" -- no other stale statuses detected in the 28-entry table
3. The "last updated" footer references Phase 12 additions -- should be updated to reflect Phase 14 audit

## Don't Hand-Roll

Not applicable for this phase -- no new code beyond trivial comment fixes.

## Common Pitfalls

### Pitfall 1: File Path Mismatch for nios-calc
**What goes wrong:** Phase 11 plans reference `frontend/src/app/lib/nios-calc.ts` but actual path is `frontend/src/app/components/nios-calc.ts`
**How to avoid:** Use actual paths confirmed by grep in all VERIFICATION.md evidence references

### Pitfall 2: Subscription ID Round-Trip Confusion
**What goes wrong:** The subscriptions array `id` field uses synthetic IDs (`nios-0`, `nios-1`) while `selectedMembers` uses actual hostnames extracted from `name` field
**How to avoid:** The backend uses `selectedMembers` (hostnames) not `subscriptions` (synthetic IDs) for NIOS member filtering -- both backup and WAPI modes set `SelectedMembers` via lines 565-567. The `subscriptions` field carries the synthetic IDs but is not used for NIOS member selection on the backend. This is actually correct behavior -- verify and document it.

### Pitfall 3: Forgetting ROADMAP.md Update
**What goes wrong:** ROADMAP.md shows Phase 11 as "In Progress" (3/4 plans) and Phase 14 as "0/0 plans"
**How to avoid:** Update Phase 11 status to reflect that plan 04 was a human checkpoint (skipped by design), and update Phase 14 plan count

## Code Examples

### Stale SSE Reference (to fix)

```go
// server/types.go:36 (CURRENT - stale)
// The scanId equals the sessionId -- callers use it for /events and /results.

// FIXED:
// The scanId equals the sessionId -- callers use it for /status and /results.
```

This is the only stale SSE reference in Go server code. Grep for `SSE|EventSource|/events` in `server/` returns only this one hit.

### NIOS Subscription Round-Trip Flow

**Backup mode (wizard.tsx:369-382):**
1. Upload response returns `members[].hostname` and `members[].role`
2. Subscriptions populated: `{ id: 'nios-0', name: 'hostname (role)', selected: true }`
3. Scan request: `subscriptions` = `['nios-0', 'nios-1', ...]` (synthetic IDs from getEffectiveSelected)
4. Scan request: `selectedMembers` = `['hostname1', 'hostname2', ...]` (extracted from name, role suffix stripped)
5. Backend `toOrchestratorProviders` (scan.go:498): uses `s.SelectedMembers` for member filtering

**WAPI mode (wizard.tsx:387-400):**
- Identical subscription population pattern with `nios-${i}` IDs
- Same selectedMembers extraction at scan time

**Assessment:** The `subscriptions` field carries synthetic IDs which are unused by the NIOS backend. The `selectedMembers` field carries the actual hostnames. This works correctly because the backend (orchestrator.go:267) copies `SelectedMembers` into `req.Subscriptions` for WAPI mode, and uses `selected_members` credential for backup mode (orchestrator.go:272). The round-trip is functional.

### Vitest Evidence

Test file: `frontend/src/app/components/nios-calc.test.ts`
- 7 tests for `calcServerTokenTier` (tier selection logic for FE-05)
- 8 tests for `consolidateXaasInstances` (bin-packing logic for FE-06)
- Total: 15 tests covering the pure calculation functions

Command: `cd frontend && npx vitest run src/app/components/nios-calc.test.ts`

## State of the Art

Not applicable -- no library ecosystem changes affect this phase.

## Open Questions

1. **Phase 11 plan 04 (human checkpoint) was never executed**
   - What we know: Plans 01-03 were executed, plan 04 was a human verification checkpoint that was skipped
   - What's unclear: Nothing -- CONTEXT.md explicitly says "do not note the skipped plan 04 gap"
   - Recommendation: Verify plans 01-03 output only, mark Phase 11 as complete (3/3 implemented plans)

2. **NIOS subscription synthetic IDs in scan request**
   - What we know: The `subscriptions` array in the scan request carries `nios-0`, `nios-1` etc. The backend does not use these for NIOS -- it uses `selectedMembers` instead
   - What's unclear: Whether the synthetic IDs cause any issues on the backend (they are passed to `Subscriptions` field in orchestrator)
   - Recommendation: Investigate whether `Subscriptions` field is used in NIOS scan path. If unused, document as working-as-designed. If problematic, fix by using hostnames as IDs.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest ^4.0.18 |
| Config file | frontend/package.json ("test": "vitest run") |
| Quick run command | `cd frontend && npx vitest run src/app/components/nios-calc.test.ts` |
| Full suite command | `cd frontend && npx vitest run` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| FE-03 | Top Consumer Cards render with regex filtering | code-inspection | N/A (UI rendering, no unit test) | N/A |
| FE-04 | Migration Planner 3-scenario comparison | code-inspection | N/A (UI rendering) | N/A |
| FE-05 | Server Token Calculator tier selection | unit | `cd frontend && npx vitest run src/app/components/nios-calc.test.ts` | Yes |
| FE-06 | XaaS Consolidation bin-packing | unit | `cd frontend && npx vitest run src/app/components/nios-calc.test.ts` | Yes |

### Sampling Rate
- **Per task commit:** `cd frontend && npx vitest run src/app/components/nios-calc.test.ts`
- **Per wave merge:** `cd frontend && npx vitest run`
- **Phase gate:** Full suite green before verify

### Wave 0 Gaps
None -- existing test infrastructure covers all phase requirements. No new tests needed; this phase verifies existing code.

## Sources

### Primary (HIGH confidence)
- Direct code inspection of `frontend/src/app/components/wizard.tsx` (3000+ lines)
- Direct code inspection of `frontend/src/app/components/nios-calc.ts` (249 lines)
- Direct code inspection of `frontend/src/app/components/nios-calc.test.ts` (169 lines)
- Direct code inspection of `server/types.go` (stale comment at line 36)
- Direct code inspection of `server/scan.go` (subscription round-trip)
- Direct code inspection of `internal/orchestrator/orchestrator.go` (SelectedMembers usage)
- Existing VERIFICATION.md files for Phases 9, 10, 12, 13 (format reference)
- REQUIREMENTS.md traceability table (28 entries audited)
- ROADMAP.md progress table (current state inspected)

### Secondary (MEDIUM confidence)
- Grep search of `server/` for SSE/EventSource/events references (only 1 hit confirmed)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - no new libraries
- Architecture: HIGH - follows established VERIFICATION.md pattern from 4 prior phases
- Pitfalls: HIGH - all code paths inspected directly
- Subscription round-trip: HIGH - full flow traced through 4 files

**Research date:** 2026-03-13
**Valid until:** 2026-04-13 (stable -- no external dependencies)