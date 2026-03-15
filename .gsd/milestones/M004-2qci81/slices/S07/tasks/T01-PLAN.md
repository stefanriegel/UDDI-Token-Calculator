---
estimated_steps: 6
estimated_files: 2
---

# T01: Add org auth methods, wire validate routing, and auto-select org-discovered subscriptions

**Slice:** S07 — Frontend UI Extensions for Multi-Account Scanning
**Milestone:** M004-2qci81

## Description

Add AWS and GCP "Org Scanning" auth methods to the provider definitions and wire the critical `orgEnabled: "true"` credential injection for AWS org mode. Change subscription auto-selection behavior so org-discovered accounts and Azure subscriptions are pre-selected.

## Steps

1. In `mock-data.ts`, add AWS `"org"` auth method to `PROVIDERS[0].authMethods` (after assume-role) with fields:
   - `accessKeyId` (label: "Access Key ID", placeholder: "AKIA...", not secret)
   - `secretAccessKey` (label: "Secret Access Key", secret: true)
   - `region` (label: "Default Region", placeholder: "us-east-1", helpText: "Optional — defaults to us-east-1")
   - `orgRoleName` (label: "Org Role Name", placeholder: "OrganizationAccountAccessRole", helpText: "IAM role name assumed in each child account")

2. In `mock-data.ts`, add GCP `"org"` auth method to `PROVIDERS[2].authMethods` (after workload-identity) with fields:
   - `orgId` (label: "Organization ID", placeholder: "123456789", helpText: "GCP organization ID (numeric)")
   - `serviceAccountJson` (label: "Service Account Key", placeholder: "Paste JSON key with org-level permissions", multiline: true)

3. In `wizard.tsx` `validateCredential()` generic cloud branch (the `else` block handling AWS/Azure/GCP/Microsoft), add a special case before `apiValidate` call: if `providerId === 'aws' && authMethod === 'org'`, inject `creds.orgEnabled = 'true'` into the credentials dict.

4. In the same generic cloud branch, change subscription auto-select: when `providerId === 'aws' && authMethod === 'org'`, or `providerId === 'gcp' && authMethod === 'org'`, or `providerId === 'azure'`, map subscriptions with `selected: true` instead of `selected: false`. Keep `selected: false` for other providers (single-account AWS, GCP non-org, Microsoft).

5. In `mock-data.ts`, add mock subscriptions note: the existing `MOCK_SUBSCRIPTIONS.aws` data works for org mode demo (shows 185 accounts — appropriate for org discovery). No new mock data needed.

6. Verify: `cd frontend && npx tsc --noEmit` produces only pre-existing shadcn errors. Grep confirms `orgEnabled` injection exists.

## Must-Haves

- [ ] AWS org auth method has id `"org"` with exactly 4 fields: accessKeyId, secretAccessKey, region, orgRoleName
- [ ] GCP org auth method has id `"org"` with exactly 2 fields: orgId, serviceAccountJson (multiline: true)
- [ ] `orgEnabled: "true"` injected into credentials dict for AWS org mode before apiValidate call
- [ ] Org-discovered subscriptions use `selected: true` (AWS org, GCP org)
- [ ] Azure subscriptions use `selected: true` (multi-subscription support now available)
- [ ] Field keys match backend exactly: `orgRoleName` (camelCase), `orgId` (camelCase), `serviceAccountJson`
- [ ] No new TypeScript errors

## Verification

- `cd frontend && npx tsc --noEmit` — only pre-existing shadcn errors
- `grep -c "id: 'org'" frontend/src/app/components/mock-data.ts` returns 2
- `grep 'orgEnabled' frontend/src/app/components/wizard.tsx` shows `creds.orgEnabled = 'true'` or equivalent
- `grep "selected: true" frontend/src/app/components/wizard.tsx` appears in the validate handler for org/Azure paths

## Inputs

- `frontend/src/app/components/mock-data.ts` — existing PROVIDERS array with auth methods for AWS, Azure, GCP
- `frontend/src/app/components/wizard.tsx` — existing `validateCredential()` with generic cloud branch at ~line 437
- S07-RESEARCH.md — backend contract: AWS org requires `orgEnabled: "true"` in credentials, GCP org requires `orgId` + `serviceAccountJson`
- S02/S03/S04 summaries — validate endpoints return SubscriptionItems for org-discovered accounts

## Expected Output

- `frontend/src/app/components/mock-data.ts` — 2 new auth methods added (AWS org, GCP org)
- `frontend/src/app/components/wizard.tsx` — `validateCredential()` updated with orgEnabled injection + auto-select logic for org modes and Azure

## Observability Impact

### Signals Changed
- **New auth method options**: AWS provider card now shows 5 auth methods (was 4), GCP shows 5 (was 4). Visually verifiable in the credential step.
- **`orgEnabled` field in API requests**: When AWS org auth method is used, the `/api/aws/validate` POST body includes `orgEnabled: "true"`. This field did not exist before.
- **Subscription auto-selection behavior**: Previously all generic provider subscriptions arrived with `selected: false`. Now AWS org, GCP org, and Azure subscriptions arrive with `selected: true`.

### How to Inspect
- `grep -c "id: 'org'" frontend/src/app/components/mock-data.ts` → should return `2`
- `grep 'orgEnabled' frontend/src/app/components/wizard.tsx` → shows injection line
- Browser DevTools Network tab: validate call for AWS org mode includes `orgEnabled` in request body
- React component state: `subscriptions[provider]` entries show `selected: true` for org/Azure paths

### Failure State Visibility
- Missing org auth method → users cannot select "Org Scanning" in the auth method picker → immediate visual signal
- Missing `orgEnabled` injection → backend rejects AWS org validation with error message displayed in credential form
