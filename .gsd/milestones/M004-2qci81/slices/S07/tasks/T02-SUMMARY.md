---
id: T02
parent: S07
milestone: M004-2qci81
provides:
  - formatItemLabel helper for DNS per-type label formatting
  - maxWorkers Advanced Options UI for cloud providers (AWS, Azure, GCP)
  - maxWorkers wired into startScan API call
key_files:
  - frontend/src/app/components/wizard.tsx
key_decisions:
  - maxWorkers defaults to 0 (provider default); only non-zero values are sent in scan request
  - formatItemLabel placed as module-level function for reuse in both render and export code paths
patterns_established:
  - Cloud provider Advanced Options use same details/summary CSS pattern as Bluecat/EfficientIP
observability_surfaces:
  - Browser DevTools Network → POST /scan → providers[].maxWorkers field when non-zero
  - UI results table and top consumer cards show formatted DNS labels
  - CSV/HTML exports include formatted DNS labels
duration: 15m
verification_result: passed
completed_at: 2026-03-15
blocker_discovered: false
---

# T02: Add DNS per-type label formatting, maxWorkers Advanced Options, and verify build

**Added `formatItemLabel()` helper transforming `dns_record_*` → `DNS Record (X)` across all display/export points, and exposed maxWorkers concurrency control via Advanced Options for cloud providers.**

## What Happened

1. Added `formatItemLabel(item)` module-level helper. Detects `dns_record_` prefix, extracts suffix, uppercases it, returns `DNS Record (${suffix})`. All other items pass through unchanged.
2. Applied `formatItemLabel()` to 4 display points: top consumer card table rows, main results table, CSV export, HTML export.
3. Added `advancedOptions` state with maxWorkers per provider (default 0). Added `<details>` Advanced Options for AWS/Azure/GCP with number input and help text, matching Bluecat/EfficientIP pattern.
4. Wired maxWorkers into `startScan()` — non-zero values included in scan request.
5. Fixed pre-existing dep issue: react/react-dom were optional peer deps but not installed. Ran `pnpm install` to resolve.
6. Build verified clean.

## Verification

- `grep -c 'formatItemLabel'` → **5** (1 def + 4 call sites) ✅
- `grep 'maxWorkers'` → state + type + wiring + input + setter ✅
- `npx tsc --noEmit` → only pre-existing shadcn errors ✅
- `npx vite build` → success (1741 modules) ✅
- Browser: Advanced Options renders for AWS, expands correctly ✅
- Browser: Results table items pass through unchanged for non-DNS ✅
- formatItemLabel logic verified: `dns_record_a`→`DNS Record (A)`, `VPCs`→`VPCs` ✅
- All slice-level grep checks pass ✅

## Diagnostics

- DNS label formatting visible in results table rows with `dns_record_*` items and in CSV/HTML exports.
- maxWorkers: set non-zero value, inspect Network → POST `/scan` → `providers[].maxWorkers`.
- Advanced Options UI: Credentials step for cloud providers shows collapsed `<details>`.

## Deviations

- Pre-existing: react/react-dom not installed (optional peer deps), causing vite build failure. Fixed by pnpm install.

## Known Issues

- Mock data lacks `dns_record_*` items; formatting only visible with real backend data from S06. Logic verified via console evaluation.

## Files Created/Modified

- `frontend/src/app/components/wizard.tsx` — Added formatItemLabel, applied to 4 display points, added advancedOptions state + UI + startScan wiring
- `.gsd/milestones/M004-2qci81/slices/S07/tasks/T02-PLAN.md` — Added Observability Impact section
