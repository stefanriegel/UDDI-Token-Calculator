---
id: T01
parent: S07
milestone: M004-2qci81
provides:
  - AWS org auth method with accessKeyId, secretAccessKey, region, orgRoleName fields
  - GCP org auth method with orgId, serviceAccountJson fields
  - orgEnabled injection into AWS org credential dict before apiValidate
  - Auto-select logic for org-discovered subscriptions (AWS org, GCP org, Azure)
key_files:
  - frontend/src/app/components/mock-data.ts
  - frontend/src/app/components/wizard.tsx
key_decisions:
  - Auto-select uses a boolean flag (autoSelect) computed from providerId+authMethod rather than separate code paths per provider
patterns_established:
  - Credential dict shallow-cloned before mutation to avoid React state corruption
observability_surfaces:
  - Browser DevTools Network tab shows orgEnabled in AWS org validate POST body
  - Credential step UI renders new Org Scanning auth method pills for AWS and GCP
  - Sources step shows all checkboxes pre-checked for org/Azure paths
duration: 8m
verification_result: passed
completed_at: 2026-03-15
blocker_discovered: false
---

# T01: Add org auth methods, wire validate routing, and auto-select org-discovered subscriptions

**Added AWS and GCP org auth methods, wired `orgEnabled: "true"` injection for AWS org mode, and auto-selected org-discovered/Azure subscriptions.**

## What Happened

1. Added AWS `"org"` auth method to `PROVIDERS[0].authMethods` in `mock-data.ts` with 4 fields: `accessKeyId`, `secretAccessKey` (secret), `region` (with helpText), and `orgRoleName` (with helpText). Positioned after `assume-role`.

2. Added GCP `"org"` auth method to `PROVIDERS[2].authMethods` in `mock-data.ts` with 2 fields: `orgId` (with helpText) and `serviceAccountJson` (multiline). Positioned after `workload-identity`.

3. In `wizard.tsx` `validateCredential()` generic cloud branch, added `orgEnabled: "true"` injection into a shallow-cloned credentials dict when `providerId === 'aws' && authMethod === 'org'`. The clone avoids mutating React state directly.

4. Changed subscription auto-select: computed `autoSelect` boolean from `(aws+org) || (gcp+org) || azure`, then used `selected: autoSelect` in the subscription mapping. Non-org AWS, non-org GCP, and Microsoft keep `selected: false`.

5. Confirmed existing `MOCK_SUBSCRIPTIONS.aws` (185 entries) works for org mode demo — no new mock data needed.

## Verification

- `cd frontend && npx tsc --noEmit` — only pre-existing shadcn errors (calendar, chart, resizable); no new errors ✅
- `grep -c "id: 'org'" frontend/src/app/components/mock-data.ts` → `2` ✅
- `grep 'orgEnabled' frontend/src/app/components/wizard.tsx` → shows `creds.orgEnabled = 'true'` ✅
- `grep 'selected: autoSelect' frontend/src/app/components/wizard.tsx` → appears in validate handler ✅

### Slice-level verification (partial — T01 is intermediate):
- ✅ `grep -c 'orgEnabled.*true' wizard.tsx` → 1
- ✅ `grep -c "id: 'org'" mock-data.ts` → 2
- ❌ `grep -c 'formatItemLabel' wizard.tsx` → 0 (T02 work)
- ❌ `grep -c 'maxWorkers' wizard.tsx` → 0 (T02 work)

## Diagnostics

- **orgEnabled injection**: Inspect browser DevTools → Network → POST to `/api/aws/validate` when using "Org Scanning" auth method. Request body should include `orgEnabled: "true"`.
- **Auto-select**: After validation succeeds for AWS org / GCP org / Azure, navigate to Sources step. All subscription checkboxes should be pre-checked.
- **Auth method rendering**: In Credentials step, AWS shows "Org Scanning (AWS Organizations)" pill; GCP shows "Org Scanning (GCP Organization)" pill.

## Deviations

None. Implementation followed the task plan exactly.

## Known Issues

None.

## Files Created/Modified

- `frontend/src/app/components/mock-data.ts` — Added AWS org auth method (4 fields) and GCP org auth method (2 fields)
- `frontend/src/app/components/wizard.tsx` — Added orgEnabled injection + auto-select logic in validateCredential() generic cloud branch
- `.gsd/milestones/M004-2qci81/slices/S07/S07-PLAN.md` — Added Observability / Diagnostics section (pre-flight fix)
- `.gsd/milestones/M004-2qci81/slices/S07/tasks/T01-PLAN.md` — Added Observability Impact section (pre-flight fix)
