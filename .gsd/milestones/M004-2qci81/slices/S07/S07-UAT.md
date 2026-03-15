# S07: Frontend UI Extensions for Multi-Account Scanning — UAT

**Milestone:** M004-2qci81
**Written:** 2026-03-15

## UAT Type

- UAT mode: mixed (artifact-driven for build/type checks + human-experience for UI rendering and interaction)
- Why this mode is sufficient: This is a frontend-only slice — all backend APIs are already validated in S02/S03/S04/S06. Frontend correctness is verified by type checking + build + manual UI interaction.

## Preconditions

- `cd frontend && pnpm install` completed successfully
- `cd frontend && npx vite build` passes (1741 modules)
- `cd frontend && npx tsc --noEmit` shows only pre-existing shadcn errors (calendar.tsx, chart.tsx, resizable.tsx)
- Backend binary compiled and running on localhost (for live validation tests)

## Smoke Test

Open the frontend in browser. Navigate to Credentials step. Select AWS → verify "Org Scanning (AWS Organizations)" appears as an auth method option. Select it → verify 4 fields render (Access Key ID, Secret Access Key, Region, Org Role Name).

## Test Cases

### 1. AWS Org Auth Method Renders Correctly

1. Open frontend in browser, navigate to Credentials step
2. Select AWS provider
3. Look for "Org Scanning" auth method pill
4. Click "Org Scanning"
5. **Expected:** Four fields render:
   - Access Key ID (masked input with eye toggle)
   - Secret Access Key (masked input with eye toggle)
   - Region (text input with help text about defaulting to us-east-1)
   - Org Role Name (text input with help text about the cross-account role)

### 2. GCP Org Auth Method Renders Correctly

1. Select GCP provider in Credentials step
2. Click "Org Scanning" auth method pill
3. **Expected:** Two fields render:
   - Organization ID (text input with help text)
   - Service Account JSON (multiline textarea)

### 3. AWS Org Injects orgEnabled into Validate Request

1. Open browser DevTools → Network tab
2. Select AWS → Org Scanning auth method
3. Enter test credentials (any values) and trigger validation
4. Inspect the POST request to `/api/aws/validate`
5. **Expected:** Request body contains `"orgEnabled": "true"` as a string field alongside the credential fields

### 4. AWS Org Discovered Accounts Auto-Selected

1. With a running backend, enter valid AWS org credentials
2. Trigger validation — backend returns discovered accounts as SubscriptionItems
3. Navigate to Sources step
4. **Expected:** All discovered account checkboxes are pre-checked (selected: true)

### 5. GCP Org Discovered Projects Auto-Selected

1. With a running backend, enter valid GCP org credentials (org ID + SA JSON)
2. Trigger validation — backend returns discovered projects as SubscriptionItems
3. Navigate to Sources step
4. **Expected:** All discovered project checkboxes are pre-checked (selected: true)

### 6. Azure Subscriptions Auto-Selected

1. Enter valid Azure credentials (any auth method)
2. Trigger validation — backend returns tenant subscriptions
3. Navigate to Sources step
4. **Expected:** All Azure subscription checkboxes are pre-checked (selected: true)

### 7. Non-Org AWS/GCP Subscriptions NOT Auto-Selected

1. Select AWS → Access Keys (not org mode) and validate
2. Navigate to Sources step
3. **Expected:** Subscriptions/regions are NOT pre-checked (selected: false)
4. Repeat for GCP → Service Account (not org mode)
5. **Expected:** Projects are NOT pre-checked (selected: false)

### 8. DNS Per-Type Labels Display Correctly

1. Run a scan against a cloud provider with DNS zones (or use mock data containing `dns_record_a`, `dns_record_cname`, `dns_record_mx` items)
2. Navigate to Results step
3. Look at the results table and Top Consumer cards
4. **Expected:**
   - `dns_record_a` displays as "DNS Record (A)"
   - `dns_record_aaaa` displays as "DNS Record (AAAA)"
   - `dns_record_cname` displays as "DNS Record (CNAME)"
   - `dns_record_mx` displays as "DNS Record (MX)"
   - Non-DNS items (e.g., "VPCs", "subnets") display unchanged

### 9. DNS Labels in CSV/HTML Export

1. After a scan with DNS per-type items, export as CSV
2. Open the CSV file
3. **Expected:** Item column shows "DNS Record (A)" etc., not raw `dns_record_a`
4. Export as HTML and open
5. **Expected:** Same formatted labels in HTML table

### 10. MaxWorkers Advanced Options Renders for Cloud Providers

1. Select AWS in Credentials step
2. Look for "Advanced Options" collapsed section below the credential fields
3. Click to expand
4. **Expected:** Number input for "Max Workers" with help text about concurrency; default value is empty/0
5. Repeat for Azure and GCP
6. **Expected:** Same Advanced Options section appears for both
7. Verify it does NOT appear for NIOS, Bluecat, EfficientIP, or AD providers

### 11. MaxWorkers Wired to Scan Request

1. Open browser DevTools → Network tab
2. Set Max Workers to 10 for AWS in Advanced Options
3. Start a scan
4. Inspect the POST request to scan endpoint
5. **Expected:** Request body includes `"maxWorkers": 10` in the AWS provider spec
6. Set Max Workers back to 0 (or empty)
7. Start another scan
8. **Expected:** maxWorkers is either 0 or omitted from the request body

### 12. Existing Auth Methods Unaffected

1. Select AWS → Access Keys — verify fields render as before
2. Select AWS → SSO — verify fields render as before
3. Select AWS → CLI Profile — verify fields render as before
4. Select AWS → Assume Role — verify fields render as before
5. Select Azure → Service Principal — verify fields render as before
6. Select GCP → Service Account — verify fields render as before
7. **Expected:** All existing auth methods render and function identically to pre-S07 behavior

## Edge Cases

### AWS Org with Empty Optional Fields

1. Select AWS → Org Scanning
2. Fill only Access Key ID and Secret Access Key (leave Region and Org Role Name empty)
3. Trigger validation
4. **Expected:** Validation proceeds — Region defaults to us-east-1 on backend, orgRoleName is optional. No frontend error for empty optional fields.

### MaxWorkers with Invalid Input

1. Expand Advanced Options for AWS
2. Enter a negative number (-1) in Max Workers
3. **Expected:** HTML number input prevents negative values (min=0 attribute) or value is treated as 0

### GCP SA JSON Multiline Input

1. Select GCP → Org Scanning
2. Paste a multi-line JSON blob into Service Account JSON textarea
3. **Expected:** Textarea accepts and displays multi-line content correctly; no truncation or formatting issues

### DNS Items Without dns_record_ Prefix

1. Verify that non-DNS items like "VPCs", "subnets", "ec2_instances" pass through formatItemLabel unchanged
2. **Expected:** No transformation applied — items display as their raw string

## Failure Signals

- AWS Org Scanning auth method pill missing from AWS provider card
- GCP Org Scanning auth method pill missing from GCP provider card
- `orgEnabled` field absent from AWS org validate request body in Network tab
- Subscriptions NOT pre-checked after org mode validation (checkboxes unchecked)
- DNS items showing raw `dns_record_a` instead of "DNS Record (A)" in results
- Advanced Options section missing for cloud providers
- maxWorkers not appearing in scan request body when set to non-zero
- Any new TypeScript errors in wizard.tsx, mock-data.ts, or api-client.ts
- Vite build failure

## Requirements Proved By This UAT

- AWS-ORG-01 — Frontend org credential form renders correctly and injects orgEnabled for backend contract (test cases 1, 3, 4)
- GCP-ORG-01 — Frontend org credential form renders correctly with orgId + SA JSON (test cases 2, 5)
- DNS-TYPE-01 — Frontend displays per-type DNS labels in results, CSV, and HTML export (test cases 8, 9)

## Not Proven By This UAT

- End-to-end multi-account scanning (requires live AWS org credentials) — backend verified in S02
- End-to-end multi-project GCP scanning (requires live GCP org SA) — backend verified in S04
- Checkpoint/resume behavior — verified in S05
- Retry/backoff under throttle — verified in S01
- Azure expanded resource types — verified in S03
- Actual DNS per-type counts from live cloud zones — verified in S06

## Notes for Tester

- Mock data does not include `dns_record_*` items, so test case 8 requires a real backend scan or manual injection of mock data with DNS per-type items. The `formatItemLabel` logic can be verified in browser console: copy the function and test with `formatItemLabel('dns_record_a')`.
- The Bluecat and EfficientIP providers already have Advanced Options sections (for configuration IDs / site IDs) — the new cloud provider Advanced Options follow the same UI pattern.
- The five pending auth method frontend forms (AZ-AUTH-01, AZ-AUTH-03, AD-AUTH-01, GCP-AUTH-01, GCP-AUTH-02) are NOT part of this slice — they remain active requirements for a future milestone.
