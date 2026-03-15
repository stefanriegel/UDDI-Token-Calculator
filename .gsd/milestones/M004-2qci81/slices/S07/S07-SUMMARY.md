---
id: S07
parent: M004-2qci81
milestone: M004-2qci81
provides:
  - AWS org auth method with accessKeyId, secretAccessKey, region, orgRoleName fields
  - GCP org auth method with orgId, serviceAccountJson fields
  - orgEnabled injection into AWS org credential dict before apiValidate
  - Auto-select logic for org-discovered subscriptions (AWS org, GCP org, Azure)
  - formatItemLabel helper for DNS per-type label formatting (dns_record_a → DNS Record (A))
  - maxWorkers Advanced Options UI for cloud providers (AWS, Azure, GCP)
requires:
  - slice: S02
    provides: AWS org discovery validate endpoint returning SubscriptionItems
  - slice: S03
    provides: Azure subscription discovery validate endpoint returning SubscriptionItems
  - slice: S04
    provides: GCP project discovery validate endpoint returning SubscriptionItems
  - slice: S06
    provides: Per-type DNS items (dns_record_a, dns_record_cname, etc.)
affects: []
key_files:
  - frontend/src/app/components/mock-data.ts
  - frontend/src/app/components/wizard.tsx
key_decisions:
  - "orgEnabled: 'true' injected programmatically in wizard.tsx validateCredential() — not a form field"
  - "Azure subscriptions changed to selected: true after validate — multi-subscription scanning available since S03"
  - "Org-discovered accounts/projects use selected: true matching NIOS/Bluecat/EfficientIP auto-select pattern"
  - "formatItemLabel converts dns_record_X → 'DNS Record (X)' — applied to all f.item rendering + export points"
  - "maxWorkers exposed via <details> Advanced Options following existing Bluecat/EfficientIP pattern — 0 means provider default"
  - "Credential dict shallow-cloned before mutation to avoid React state corruption"
  - "Auto-select uses boolean flag (autoSelect) computed from providerId+authMethod rather than separate code paths"
patterns_established:
  - Cloud provider Advanced Options use same details/summary CSS pattern as Bluecat/EfficientIP
  - Org auth methods follow same field definition pattern in mock-data.ts as all other auth methods
observability_surfaces:
  - Browser DevTools Network tab shows orgEnabled in AWS org validate POST body
  - Credential step UI renders new Org Scanning auth method pills for AWS and GCP
  - Sources step shows all checkboxes pre-checked for org/Azure paths
  - Browser DevTools Network → POST /scan → providers[].maxWorkers field when non-zero
  - Results table and top consumer cards show formatted DNS labels
drill_down_paths:
  - .gsd/milestones/M004-2qci81/slices/S07/tasks/T01-SUMMARY.md
  - .gsd/milestones/M004-2qci81/slices/S07/tasks/T02-SUMMARY.md
duration: 23m
verification_result: passed
completed_at: 2026-03-15
---

# S07: Frontend UI Extensions for Multi-Account Scanning

**Added AWS/GCP org auth methods with orgEnabled injection, auto-selected org-discovered subscriptions, DNS per-type label formatting, and maxWorkers concurrency control — completing the frontend for enterprise-scale multi-account scanning.**

## What Happened

Added two new org-mode auth methods (AWS + GCP) to the frontend credential forms, wired the critical `orgEnabled: "true"` backend contract injection for AWS org mode, and set org-discovered and Azure subscriptions to auto-select. Then added human-readable DNS per-type label formatting for the S06 backend output and exposed the S01 maxWorkers concurrency parameter via an Advanced Options UI section.

**T01 (8min):** Added AWS "Org Scanning" auth method to `mock-data.ts` with 4 fields (accessKeyId, secretAccessKey/secret, region, orgRoleName) and GCP "Org Scanning" with 2 fields (orgId, serviceAccountJson/multiline). In `wizard.tsx`, injected `orgEnabled: "true"` into a shallow-cloned credentials dict when AWS org mode is selected, satisfying the backend contract. Changed subscription auto-select: computed `autoSelect` from `(aws+org) || (gcp+org) || azure`, used in subscription mapping. Azure changed from `selected: false` to `selected: true` since multi-subscription scanning is now available via S03.

**T02 (15min):** Added `formatItemLabel()` module-level helper that detects `dns_record_` prefix and converts to `DNS Record (X)` format, applied to 4 display points (top consumer cards, results table, CSV export, HTML export). Added `advancedOptions` state with maxWorkers per provider, rendered as `<details>` Advanced Options sections matching the existing Bluecat/EfficientIP pattern. Wired maxWorkers into `startScan()` — non-zero values included in scan request. Fixed pre-existing peer dep issue (react/react-dom) and verified clean build.

## Verification

- `npx tsc --noEmit` — only pre-existing shadcn errors (calendar, chart, resizable); no new errors in wizard.tsx, mock-data.ts, api-client.ts ✅
- `npx vite build` — success (1741 modules) ✅
- `grep -c 'orgEnabled.*true' wizard.tsx` → 1 ✅
- `grep -c "id: 'org'" mock-data.ts` → 2 (AWS + GCP) ✅
- `grep -c 'formatItemLabel' wizard.tsx` → 5 ✅
- `grep -c 'maxWorkers' wizard.tsx` → 8 ✅

## Requirements Advanced

- AWS-ORG-01 — Frontend org credential form now complete; end-to-end flow from UI → org discovery → multi-account scan is fully wired
- GCP-ORG-01 — Frontend org credential form now complete; end-to-end flow from UI → project discovery → multi-project scan is fully wired
- DNS-TYPE-01 — Frontend now displays per-type DNS labels (`DNS Record (A)`, `DNS Record (CNAME)`, etc.) in results, CSV, and HTML export

## Requirements Validated

- none — AWS-ORG-01, GCP-ORG-01, and DNS-TYPE-01 need live backend testing to validate; this slice proves frontend correctness only

## New Requirements Surfaced

- none

## Requirements Invalidated or Re-scoped

- none

## Deviations

- Pre-existing: react/react-dom not installed as peer deps; fixed by `pnpm install` during T02 to unblock vite build.

## Known Limitations

- Mock data lacks `dns_record_*` items — formatItemLabel formatting only visible with real S06 backend data. Logic verified via console evaluation.
- Five auth methods still need frontend forms (AZ-AUTH-01, AZ-AUTH-03, AD-AUTH-01, GCP-AUTH-01, GCP-AUTH-02) — not in M004 scope.

## Follow-ups

- none

## Files Created/Modified

- `frontend/src/app/components/mock-data.ts` — Added AWS org auth method (4 fields) and GCP org auth method (2 fields)
- `frontend/src/app/components/wizard.tsx` — Added orgEnabled injection, auto-select logic, formatItemLabel helper (4 call sites), advancedOptions state + UI + startScan wiring

## Forward Intelligence

### What the next slice should know
- M004-2qci81 is now complete — all 7 slices delivered. No downstream slices remain in this milestone.

### What's fragile
- `formatItemLabel` relies on exact `dns_record_` prefix convention from S06 backend — if backend changes item naming, labels break silently (passthrough to raw item string).
- `orgEnabled` injection is a string `"true"` not boolean `true` — backend reads `creds["orgEnabled"] == "true"` as string comparison.

### Authoritative diagnostics
- Browser DevTools → Network → POST `/api/aws/validate` with org auth method — check for `orgEnabled: "true"` in request body.
- Sources step after org validation — all checkboxes should be pre-checked.

### What assumptions changed
- Azure subscriptions were previously `selected: false` requiring manual selection — changed to `selected: true` since multi-subscription scanning (S03) makes manual 50+ selection poor UX.
