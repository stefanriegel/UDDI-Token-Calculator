# S07: Frontend UI Extensions for Multi-Account Scanning — Research

**Date:** 2026-03-15

## Summary

S07 is a pure-frontend slice that wires the three backend multi-account scanning pipelines (AWS org, Azure multi-subscription, GCP multi-project) into the wizard UI. The backend is 100% complete — S02 added AWS org discovery, S03 Azure multi-subscription fan-out, S04 GCP org discovery. S07 adds the credential fields, validate-call routing, and scan-request generation that expose these capabilities to users.

The work is surgical: `mock-data.ts` gets a new "Org Scanning" auth method for AWS and GCP (with required credential fields), `wizard.tsx` gets a special-case validate handler for AWS org mode (to inject `orgEnabled: "true"`) and source auto-select logic for org-discovered accounts/projects, and `api-client.ts` needs no new functions (the existing `validateCredentials` covers org modes). Azure requires no new auth method — every existing Azure auth method already returns all accessible subscriptions via `listAzureSubscriptions`; the "all subscriptions auto-selected" UX already works with the existing flow.

The key surprise: AWS org mode requires the frontend to pass `orgEnabled: "true"` in the credentials dict (not just use auth_method "org"), because `storeCredentials` in `validate.go` reads `creds["orgEnabled"] == "true"` to set `sess.AWS.OrgEnabled`. This is the session flag the orchestrator propagates to `org_enabled = "true"` in the scan request, which the scanner checks to activate org fan-out. If `orgEnabled` is omitted, the scanner falls back to single-account mode silently.

DNS per-type items (`dns_record_a`, `dns_record_cname`, etc.) from S06 flow naturally through the existing results table and Top Consumer DNS card filter (`/dns|zone/i.test(f.item)`) with no changes needed — the items contain "dns" and match the existing regex.

## Recommendation

Implement S07 in two tasks:

**T01 — Auth method additions and validate routing** (mock-data.ts + wizard.tsx validation):
1. Add AWS `"org"` auth method to `PROVIDERS.aws.authMethods` in `mock-data.ts` with fields: `accessKeyId` (secret), `secretAccessKey` (secret), `region` (optional), `orgRoleName` (optional, default "OrganizationAccountAccessRole")
2. Add GCP `"org"` auth method to `PROVIDERS.gcp.authMethods` with fields: `orgId`, `serviceAccountJson` (multiline)
3. In `wizard.tsx` `validateCredential()`, add a special case for AWS org auth method that injects `orgEnabled: "true"` into the credentials dict before calling `apiValidate`
4. Org-discovered subscriptions auto-select all items (like NIOS/Bluecat/EfficientIP) rather than `selected: false` (like the existing generic cloud flow)

**T02 — DNS per-type display enhancements + scan progress improvements**:
1. The results table already shows `f.item` as-is — `dns_record_a` will display literally. Consider adding a human-readable label map for display (e.g. `dns_record_a` → `DNS Record (A)`)
2. The scanning step shows per-provider progress bars — consider adding a sub-status line showing "Scanning account X of Y" using `account_progress`/`subscription_progress`/`project_progress` events from the polling response (if the backend exposes them in status)
3. Add concurrency controls (`maxWorkers`) to the credentials step UI as an optional "Advanced" section (collapsed by default) — already wired through `ScanRequest.providers[].maxWorkers` in `api-client.ts`

## Don't Hand-Roll

| Problem | Existing Solution | Why Use It |
|---------|------------------|------------|
| Org account auto-selection | `result.subscriptions.map(s => ({...s, selected: true}))` pattern from NIOS/Bluecat/EfficientIP | Org-discovered accounts should all be pre-selected, not `selected: false` like the generic cloud flow |
| Credential field rendering | Generic `currentAuth.fields.map()` in credentials step already handles text, password, multiline | All new org fields use the same pattern — just add them to `AuthMethod.fields` in `mock-data.ts` |
| Validate API call | `apiValidate(backendId, authMethod, creds)` already handles arbitrary provider/method/creds | No new API client function needed for org modes |
| TLS skip checkbox | Existing `(provId === 'bluecat' \|\| ...)` pattern | Not needed for org modes — don't add |

## Existing Code and Patterns

- `frontend/src/app/components/mock-data.ts` — `PROVIDERS` array defines all auth methods and their fields. Adding org auth methods here automatically wires them into the credential form renderer in `wizard.tsx` (no template changes needed for basic fields).

- `frontend/src/app/components/wizard.tsx:437–457` — `validateCredential()` generic cloud branch: `apiValidate(backendId, authMethod, creds)` + `result.subscriptions.map(s => ({...s, selected: false}))`. The AWS org case needs a one-line override to inject `orgEnabled: "true"` and use `selected: true` for auto-select.

- `frontend/src/app/components/wizard.tsx:550–575` — `startScan()` constructs `ScanProviderSpec.subscriptions` from `getEffectiveSelected(provId)`. No changes needed — org accounts are just subscription IDs flowing through the existing mechanism.

- `frontend/src/app/components/api-client.ts:ScanRequest` — Already has `maxWorkers?: number` and `requestTimeout?: number` in the provider entry type. Frontend just needs to populate them if the user sets them.

- `frontend/src/app/components/wizard.tsx:2022–2024` — Top Consumer DNS card filter: `(f) => /dns|zone/i.test(f.item)`. Already matches `dns_record_a`, `dns_record_cname`, etc. from S06.

- `frontend/src/app/components/wizard.tsx:2021–2113` — Top Consumer Cards use `f.item` directly for labeling. Per-type DNS items will show as `dns_record_a`, `dns_record_cname`, etc. Optional: add a display-name map.

## Constraints

- **AWS org credential flow**: Frontend MUST send `orgEnabled: "true"` in the credentials dict when auth_method is `"org"`. This is because `storeCredentials` reads `creds["orgEnabled"] == "true"` to set `sess.AWS.OrgEnabled`. If omitted, the orchestrator never sets `org_enabled = "true"` in the scanner request and org fan-out is silently skipped.

- **GCP org requires `orgId` + `serviceAccountJson`**: The `realGCPOrgValidator` in `validate.go` validates both fields before calling `DiscoverProjects`. The frontend must send both in the credentials dict.

- **AWS org auth method fields**: Backend's `realAWSOrgValidator` reads `accessKeyId`, `secretAccessKey`, `region`, `sessionToken`. Role name (`orgRoleName`) is stored in session via `storeCredentials` → `sess.AWS.OrgRoleName` and then propagated by orchestrator as `org_role_name`. The scanner defaults `orgRoleName` to `"OrganizationAccountAccessRole"` if empty.

- **Azure has no new auth method needed**: All existing Azure auth methods (browser-sso, device-code, service-principal, certificate, az-cli) already call `listAzureSubscriptions` and return all tenant subscriptions as `SubscriptionItems`. The wizard's generic validation path already handles this. The only UX change is that Azure now auto-selects discovered subscriptions (they return many, so the current `selected: false` default means nothing gets scanned).

- **GCP org dispatches via len(Subscriptions) > 1**: The GCP scanner activates multi-project mode when more than 1 subscription ID is provided (not via an `org_enabled` flag). So when the user selects multiple GCP projects in the Sources step, the fan-out happens automatically.

- **Pre-existing TS errors are only in shadcn components** (calendar.tsx, chart.tsx, resizable.tsx) — all new code must be clean (no new TS errors in wizard.tsx, api-client.ts, mock-data.ts, use-backend.ts).

- **No CDN/external fonts/images** — all existing assets are local; S07 must not add external dependencies.

- **CGO_ENABLED=0 constraint applies to backend only** — frontend has no such constraint.

## Common Pitfalls

- **Missing `orgEnabled: "true"` in credentials dict** — The most critical bug risk. If the wizard sends `authMethod: "org"` but forgets `credentials.orgEnabled = "true"`, the org mode silently degrades to single-account scanning. Must be explicitly injected in the validate handler and NOT relied on from form fields (users shouldn't see or set this flag).

- **Selected: false for org-discovered accounts** — The generic cloud validate path sets `selected: false` (matching Azure/GCP's "choose what to scan" UX). For org-discovered accounts, all accounts should be pre-selected (`selected: true`) because the whole point of org mode is to scan everything. Treat like NIOS/Bluecat/EfficientIP which also auto-select all.

- **GCP org mode `serviceAccountJson` is a multiline textarea** — The credential field must use `multiline: true` in the `AuthMethod.fields` definition to render as a `<textarea>`. Without this, the JSON key paste won't work.

- **Azure subscriptions not selected** — Currently all Azure/GCP/AWS subscriptions from generic validate use `selected: false`. For Azure in particular, after adding multi-subscription backend support, the Sources step is confusing when all subscriptions start unchecked and the user must manually select 50+. Consider auto-selecting all for cloud providers by default (or keep existing behavior and note it in UX).

- **OrgRoleName field key spelling** — Backend reads `creds["orgRoleName"]` (camelCase). The credential field `key` in mock-data.ts must exactly match: `{ key: 'orgRoleName', ... }`.

- **GCP orgId field key** — Backend reads `creds["orgId"]` (camelCase). Field key must be `orgId` (not `org_id` or `orgID`).

- **DNS item display in results table** — `f.item` for per-type DNS records will show as `dns_record_a`, `dns_record_cname`, etc. This is raw backend naming (see DECISIONS: "Per-type DNS items use lowercase underscore naming"). Consider adding a `formatItemLabel(item: string)` helper that converts `dns_record_a` → `DNS Record (A)`, `dns_record_cname` → `DNS Record (CNAME)` etc. for display. Optional but improves readability.

- **Auth method state reset on switch** — The existing pattern in `wizard.tsx` resets `credentialStatus` when switching auth methods. The org method doesn't need special handling here — it follows the same pattern.

## Open Risks

- **Azure auto-select behavior** — Current generic validate uses `selected: false`. Now that Azure returns all subscriptions (potentially 100+), users will see a huge list with nothing selected and need to manually check items. Consider changing to `selected: true` for Azure as well. This changes UX but reduces friction. Low risk to change — existing tests don't cover frontend UX state.

- **DNS per-type item display** — Backend items like `dns_record_a` show literally in the results table. S07 scope says "Frontend display of per-type breakdown pending S07" (from DNS-TYPE-01 requirement). A simple string formatting function covers this cleanly.

- **Scan progress for multi-account** — The `account_progress`, `subscription_progress`, `project_progress` events are published by the scanner but the frontend polling (`getScanStatus`) only returns aggregate provider progress (0–100%). If richer per-account visibility is needed in the scanning step, it would require backend changes to expose per-account progress in the status response — this is out of S07 scope (backend-only change). S07 can show "Scanning N accounts..." as a static label based on the count of selected subscriptions.

- **Max workers UI friction** — Adding a concurrency control to credentials step is optional per slice boundary. Backend already supports `maxWorkers` in scan request. A simple "Advanced Options" `<details>` section with a number input (default 0 = use provider default) is low-friction and follows the Bluecat/EfficientIP advanced section pattern.

- **Browser-oauth GCP org incompatibility** — GCP org mode requires a service account JSON with org-level permissions. Browser-oauth and ADC auth methods don't expose `orgId`, so they can't use org discovery. The new `"org"` auth method is the only path to GCP org mode.

## Skills Discovered

| Technology | Skill | Status |
|------------|-------|--------|
| React/TypeScript | (built-in knowledge sufficient) | N/A |
| Tailwind CSS | (built-in knowledge sufficient) | N/A |

## Key Backend Contract Details

### AWS Org Mode Validate
```
POST /api/v1/providers/aws/validate
{
  "authMethod": "org",
  "credentials": {
    "accessKeyId": "AKIA...",
    "secretAccessKey": "...",
    "region": "us-east-1",         // optional, defaults to us-east-1
    "orgRoleName": "OrgRole",      // optional, defaults to OrganizationAccountAccessRole
    "orgEnabled": "true"           // CRITICAL: must be sent explicitly
  }
}
→ { valid: true, subscriptions: [{id: "123456789012", name: "Prod – Core Platform"}, ...] }
```

### GCP Org Mode Validate
```
POST /api/v1/providers/gcp/validate
{
  "authMethod": "org",
  "credentials": {
    "orgId": "123456789",           // GCP organization ID (numeric)
    "serviceAccountJson": "{ ... }" // full JSON key contents
  }
}
→ { valid: true, subscriptions: [{id: "my-project-id", name: "My Project"}, ...] }
```

### Azure — No new auth method
All existing Azure auth methods already return `subscriptions: [...]`. No API change.

### Scan Request — org accounts flow as subscriptions
```
POST /api/v1/scan
{
  providers: [{
    provider: "aws",
    subscriptions: ["112233445566", "223344556677", ...],  // account IDs from org discovery
    selectionMode: "include"
  }]
}
```
AWS scanner activates org fan-out when `org_enabled == "true"` (from session) AND subscriptions list is provided. The subscriptions are account IDs that the scanner uses for AssumeRole targeting.

**Important architectural detail (verified from source):**

- **AWS org mode** (`scanOrg`): does NOT filter by `req.Subscriptions`. It discovers and scans ALL org accounts via `DiscoverAccounts`. The account IDs returned by the validate endpoint and displayed in the Sources step are for UX informational purposes only — the Sources step checkboxes have no effect on which accounts are actually scanned. `req.Subscriptions` is not read in `scanOrg`. This means S07 should either: (a) skip the Sources step for AWS org mode entirely, or (b) show the account list as read-only/informational without checkboxes, or (c) keep checkboxes for UX familiarity but document that all accounts are scanned. Simplest: auto-select all and make clear in UI that org mode scans all discovered accounts.

- **GCP multi-project**: scanner dispatches to `scanAllProjects` when `len(req.Subscriptions) > 1`. Selected project IDs from Sources step flow as `req.Subscriptions` and ARE used by `scanAllProjects(ctx, ts, req.Subscriptions, ...)`. So GCP subscription selection IS meaningful.

- **Azure multi-subscription**: `scanAllSubscriptions(ctx, cred, subscriptions, ...)` uses the subscription IDs from `req.Subscriptions`. So Azure subscription selection IS meaningful.

## Sources

- `server/validate.go` — `realAWSOrgValidator`, `realGCPOrgValidator`, `storeCredentials` (lines 214–300, 503–680, 930–980)
- `internal/scanner/aws/scanner.go` — `Scan()` org dispatch, `scanOrg()` (lines 45–130)
- `internal/scanner/azure/scanner.go` — `Scan()`, `scanAllSubscriptions()` (lines 27–100)
- `internal/scanner/gcp/scanner.go` — `Scan()`, `buildTokenSource` org case (lines 470–500)
- `internal/orchestrator/orchestrator.go` — `buildScanRequest` credential threading (lines 210–280)
- `frontend/src/app/components/mock-data.ts` — `PROVIDERS` definition with all auth methods
- `frontend/src/app/components/wizard.tsx` — `validateCredential()`, `startScan()`, credential form renderer
- `frontend/src/app/components/api-client.ts` — `validateCredentials`, `startScan`, `ScanRequest` type
