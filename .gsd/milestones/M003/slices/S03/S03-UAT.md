# S03: GCP Advanced Auth — UAT

**Milestone:** M003
**Written:** 2026-03-14

## UAT Type

- UAT mode: mixed (artifact-driven unit tests + live-runtime for browser OAuth)
- Why this mode is sufficient: Browser OAuth requires real browser interaction for full validation; WIF requires a real external identity provider. Unit tests cover all structural validation, dispatch routing, and session storage. Live-runtime testing needed only for the interactive consent flow and real WIF token exchange.

## Preconditions

- Go 1.24+ installed
- Project compiles cleanly (`go build ./...`)
- For live browser-oauth testing: GCP project with OAuth 2.0 client credentials (Web application type with `http://127.0.0.1/callback` authorized redirect URI pattern)
- For live WIF testing: GCP project with Workload Identity Pool and Provider configured, WIF configuration JSON file downloaded

## Smoke Test

Run `go test ./server/ -run "GCPBrowserOAuth|GCPWorkloadIdentity" -v` — all 8 tests pass in <2 seconds.

## Test Cases

### 1. Browser OAuth — Missing Credentials Rejected

1. POST `/api/v1/providers/gcp/validate` with `authMethod: "browser-oauth"` and empty credentials
2. **Expected:** 200 response, `valid: false`, error mentions "clientId and clientSecret are required"

### 2. Browser OAuth — Does Not Fall Through to Service Account

1. POST `/api/v1/providers/gcp/validate` with `authMethod: "browser-oauth"` and only `clientId` (no `clientSecret`)
2. **Expected:** 200 response, `valid: false`, error mentions "clientSecret", does NOT mention "serviceAccountJson"

### 3. Browser OAuth — Live Consent Flow (manual)

1. Start the application (`go run .`)
2. Select GCP provider, choose "Browser OAuth" auth method
3. Enter valid OAuth client ID and secret from GCP Console
4. Click Validate
5. **Expected:** System browser opens Google consent page. After granting access, browser shows "Authentication successful". Application shows list of accessible GCP projects.

### 4. Workload Identity — Missing JSON Rejected

1. POST `/api/v1/providers/gcp/validate` with `authMethod: "workload-identity"` and empty credentials
2. **Expected:** 200 response, `valid: false`, error mentions "workloadIdentityJson is required"

### 5. Workload Identity — Wrong JSON Type Rejected

1. POST `/api/v1/providers/gcp/validate` with `authMethod: "workload-identity"` and `workloadIdentityJson: '{"type":"service_account","project_id":"x"}'`
2. **Expected:** 200 response, `valid: false`, error mentions `expected type "external_account"`

### 6. Workload Identity — Invalid JSON Rejected

1. POST `/api/v1/providers/gcp/validate` with `authMethod: "workload-identity"` and `workloadIdentityJson: '{not valid json}'`
2. **Expected:** 200 response, `valid: false`, error mentions "invalid"

### 7. Workload Identity — Does Not Fall Through to Service Account

1. POST `/api/v1/providers/gcp/validate` with `authMethod: "workload-identity"` and empty credentials
2. **Expected:** Error mentions "workloadIdentityJson", does NOT mention "serviceAccountJson"

### 8. Workload Identity — Session Storage

1. POST `/api/v1/providers/gcp/validate` with `authMethod: "workload-identity"`, valid-shaped `workloadIdentityJson` (stub validator), and `projectId: "my-project"`
2. **Expected:** Session GCP credentials contain `AuthMethod: "workload-identity"`, `WorkloadIdentityJSON` populated, `ProjectID: "my-project"`

### 9. Browser OAuth — Session Storage

1. POST `/api/v1/providers/gcp/validate` with `authMethod: "browser-oauth"`, `clientId` and `clientSecret` (stub validator)
2. **Expected:** Session GCP credentials contain `AuthMethod: "browser-oauth"`

### 10. Scanner — Browser OAuth Without Cached Token Source

1. Call `buildTokenSource` with `auth_method: "browser-oauth"` and nil cached token source
2. **Expected:** Error mentioning "browser-oauth" and "re-validate", does NOT mention "service_account_json"

### 11. Scanner — Workload Identity Without Cached Token Source or JSON

1. Call `buildTokenSource` with `auth_method: "workload-identity"` and nil cached token source and empty `workload_identity_json`
2. **Expected:** Error mentioning "workload_identity_json"

### 12. Existing Auth Methods Unaffected

1. Run `go test ./... -timeout 120s`
2. **Expected:** All existing tests pass — service-account, ADC, and all other provider auth methods work exactly as before

## Edge Cases

### Browser OAuth Timeout

1. Start browser OAuth flow but do NOT complete consent in browser
2. **Expected:** After 120 seconds, validator returns error "timed out waiting for browser consent"

### WIF with Service Account Impersonation URL

1. Provide WIF JSON containing `service_account_impersonation_url` with format `...serviceAccounts/sa@myproject.iam.gserviceaccount.com:generateAccessToken`
2. **Expected:** Validator extracts "myproject" as project ID from the URL when project listing API fails

### WIF Without Project ID Fallback

1. Provide valid WIF JSON (type=external_account) without SA impersonation URL and without projectId in credentials, and the project listing API returns 403
2. **Expected:** Validator returns error "unable to determine project ID"

## Failure Signals

- Any test in `go test ./server/ -run "GCPBrowserOAuth|GCPWorkloadIdentity"` fails
- Browser OAuth validator falls through to service-account path (error mentions "serviceAccountJson")
- Workload Identity validator falls through to service-account path
- Any error message contains "Coming soon"
- Session GCP credentials missing WorkloadIdentityJSON after workload-identity validation
- Scanner buildTokenSource returns service-account errors for browser-oauth or workload-identity auth methods
- Existing tests fail after changes

## Requirements Proved By This UAT

- GCP-AUTH-01 — Backend validator with localhost redirect, token exchange, project listing, and credential caching (test cases 1-3, 9-10)
- GCP-AUTH-02 — Backend validator with structural validation, native WIF support, project ID extraction, and credential caching (test cases 4-8, 11)

## Not Proven By This UAT

- Frontend GCP credential forms for browser-oauth and workload-identity (not built yet)
- Live WIF token exchange with real external identity provider (requires infrastructure)
- Live browser OAuth with real GCP consent (test case 3 is manual, not automated)
- Scanner actually completing a full GCP scan using browser-oauth or WIF credentials (requires real cloud resources)

## Notes for Tester

- Test cases 1-2, 4-11 are all automated via `go test` and run in <2 seconds
- Test case 3 requires real GCP OAuth credentials — skip if not available, the structural tests are sufficient for CI
- Test case 12 takes ~50 seconds due to the NIOS parser tests
- The `BuildTokenSourceForTest` function in `internal/scanner/gcp/testing.go` is intentionally exported (not in _test.go) because the server test package needs cross-package access
