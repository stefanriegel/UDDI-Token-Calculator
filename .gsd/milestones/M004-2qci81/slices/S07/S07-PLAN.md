# S07: Frontend UI Extensions for Multi-Account Scanning

**Goal:** Credential forms support AWS org mode (with orgEnabled injection), GCP org mode (with orgId + SA JSON), and auto-select for org-discovered accounts/subscriptions — all wired to backend multi-account scanning endpoints from S02/S03/S04.
**Demo:** User selects AWS → Org Scanning auth method → enters access keys + optional role name → validates → backend returns discovered accounts pre-selected. Same for GCP → Org Scanning with orgId + SA JSON. Azure subscriptions auto-selected after validation. DNS per-type items (`dns_record_a`, etc.) display with human-readable labels.

## Must-Haves

- AWS `"org"` auth method in `PROVIDERS.aws.authMethods` with fields: `accessKeyId` (secret), `secretAccessKey` (secret), `region` (optional), `orgRoleName` (optional)
- `orgEnabled: "true"` injected into credentials dict when AWS auth method is `"org"` before calling `apiValidate` — this is the critical backend contract requirement
- GCP `"org"` auth method with fields: `orgId`, `serviceAccountJson` (multiline)
- Org-discovered subscriptions auto-selected (`selected: true`) for AWS org, GCP org, and Azure
- DNS per-type items (`dns_record_a`, `dns_record_cname`, etc.) display as human-readable labels (`DNS Record (A)`, `DNS Record (CNAME)`, etc.)
- `maxWorkers` configurable via optional Advanced Options section in credentials step
- No new TypeScript errors in wizard.tsx, mock-data.ts, or api-client.ts
- All existing auth methods and providers unaffected

## Verification

- `cd frontend && npx tsc --noEmit` — only pre-existing shadcn errors (calendar, chart, resizable); no new errors in wizard.tsx, mock-data.ts, api-client.ts
- `cd frontend && npx vite build` — build succeeds without errors
- Manual grep verification: `grep -c 'orgEnabled.*true' frontend/src/app/components/wizard.tsx` returns ≥ 1
- Manual grep verification: `grep -c "id: 'org'" frontend/src/app/components/mock-data.ts` returns 2 (AWS + GCP)
- Manual grep verification: `grep -c 'formatItemLabel' frontend/src/app/components/wizard.tsx` returns ≥ 1
- Manual grep verification: `grep -c 'maxWorkers' frontend/src/app/components/wizard.tsx` returns ≥ 1

## Tasks

- [x] **T01: Add org auth methods, wire validate routing, and auto-select org-discovered subscriptions** `est:25m`
  - Why: Core slice functionality — enables users to authenticate with AWS org and GCP org modes, ensures `orgEnabled: "true"` is injected for the AWS backend contract, and auto-selects discovered accounts
  - Files: `frontend/src/app/components/mock-data.ts`, `frontend/src/app/components/wizard.tsx`
  - Do: (1) Add AWS `"org"` auth method to `PROVIDERS.aws.authMethods` with accessKeyId, secretAccessKey, region, orgRoleName fields. (2) Add GCP `"org"` auth method to `PROVIDERS.gcp.authMethods` with orgId and serviceAccountJson (multiline) fields. (3) In `wizard.tsx` `validateCredential()` generic cloud branch, add special case: when `providerId === 'aws' && authMethod === 'org'`, inject `orgEnabled: "true"` into the credentials dict before calling `apiValidate`. (4) For AWS org and GCP org auth methods, use `selected: true` instead of `selected: false` when mapping validate response subscriptions. (5) Change Azure generic validate to also use `selected: true` (all Azure subscriptions now auto-selected since multi-subscription scanning is available). (6) Key spelling must match backend exactly: `orgEnabled`, `orgRoleName`, `orgId`, `serviceAccountJson`.
  - Verify: `cd frontend && npx tsc --noEmit` — no new errors; `grep 'orgEnabled' frontend/src/app/components/wizard.tsx` shows injection
  - Done when: AWS org and GCP org auth methods render in credential forms; AWS org injects `orgEnabled: "true"`; org-discovered and Azure subscriptions auto-selected

- [x] **T02: Add DNS per-type label formatting, maxWorkers Advanced Options, and verify build** `est:20m`
  - Why: Polish per-type DNS display from S06, expose concurrency configuration already supported by backend, and verify full build
  - Files: `frontend/src/app/components/wizard.tsx`
  - Do: (1) Add `formatItemLabel(item: string)` helper in wizard.tsx that converts `dns_record_a` → `DNS Record (A)`, `dns_record_aaaa` → `DNS Record (AAAA)`, etc. using regex on `dns_record_` prefix; passes through all other items unchanged. (2) Apply `formatItemLabel()` to all `f.item` display points: Top Consumer card tables, results table, CSV/HTML export. (3) Add optional "Advanced Options" `<details>` section in the credentials step for cloud providers (AWS/Azure/GCP) with a maxWorkers number input, collapsed by default. Wire the value through to `startScan()` via `ScanProviderSpec.maxWorkers`. (4) Run `npx tsc --noEmit` and `npx vite build` to verify no regressions.
  - Verify: `cd frontend && npx vite build` succeeds; `grep 'formatItemLabel' frontend/src/app/components/wizard.tsx` returns matches; `grep 'maxWorkers' frontend/src/app/components/wizard.tsx` returns matches
  - Done when: DNS per-type items display with human-readable labels; maxWorkers input available under Advanced Options; frontend builds cleanly

## Files Likely Touched

- `frontend/src/app/components/mock-data.ts`
- `frontend/src/app/components/wizard.tsx`

## Observability / Diagnostics

### Runtime Signals
- **`orgEnabled` injection**: When AWS org auth method is selected and credentials validated, `orgEnabled: "true"` is injected into the credentials dict before the API call. Visible in browser DevTools Network tab as part of the `/api/validate` POST body.
- **Auto-select behavior**: Org-discovered subscriptions (AWS org, GCP org) and Azure subscriptions arrive with `selected: true` — observable in the Sources step UI (all checkboxes checked by default).
- **Auth method rendering**: AWS and GCP provider cards show the new "Org Scanning" auth method pill. Visible in the Credentials step UI.

### Inspection Surfaces
- Browser DevTools → Network → POST to `/api/{provider}/validate` — inspect request body for `orgEnabled` field presence.
- React DevTools → Wizard component state → `subscriptions` state shows `selected` values per provider.
- Browser console: credential validation errors surface via `setCredentialError()` state and render in the UI.

### Failure Visibility
- Invalid org credentials → `credentialStatus[provider]` transitions to `'error'` with message displayed below the credential form.
- Missing `orgEnabled` injection → backend returns error for org mode scans (missing required field), visible as validation failure in UI.
- TypeScript errors → CI/build pipeline catches via `npx tsc --noEmit`.

### Redaction Constraints
- `secretAccessKey` field is marked `secret: true` — rendered with masked input toggle (Eye/EyeOff).
- `serviceAccountJson` is multiline but not marked secret — it's a JSON key blob, displayed as-is in textarea.
- Credentials are never logged to console; only sent to local backend.
