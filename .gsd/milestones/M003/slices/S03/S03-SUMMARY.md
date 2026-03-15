---
id: S03
parent: M003
milestone: M003
provides:
  - "GCP Browser OAuth authentication via localhost redirect server with CSRF protection"
  - "GCP Workload Identity Federation authentication via external_account JSON configuration"
  - "Session WorkloadIdentityJSON field for WIF credential storage"
  - "Orchestrator workload_identity_json credential mapping to scanner"
  - "Scanner buildTokenSource routing for browser-oauth and workload-identity auth methods"
  - "Token source caching for both new auth methods (scanner reuse, no re-auth)"
requires:
  - slice: S02
    provides: "Certificate, Device Code, and Kerberos auth — established interactive credential caching pattern"
affects: []
key_files:
  - server/validate.go
  - server/validate_test.go
  - internal/session/session.go
  - internal/scanner/gcp/scanner.go
  - internal/scanner/gcp/testing.go
  - internal/orchestrator/orchestrator.go
key_decisions:
  - "Browser OAuth uses net.Listen on 127.0.0.1:0 for ephemeral port — no port conflict, no firewall issues"
  - "Browser OAuth uses golang.org/x/oauth2 Config with google.Endpoint — same SDK stack, no new dependencies"
  - "CSRF state token uses nanosecond timestamp (gcpoauth-{ns}) — sufficient for single-user localhost flow"
  - "Browser OAuth 120s timeout matches AWS SSO timeout for consistent UX"
  - "WIF structural validation checks type=external_account before calling google.CredentialsFromJSON — clear error for wrong JSON type"
  - "WIF project ID extraction parses SA impersonation URL (@PROJECT.iam.gserviceaccount.com) as fallback when project listing fails"
  - "WIF fallback chain: list projects API → SA impersonation URL parsing → user-provided projectId credential"
  - "Scanner buildTokenSource uses switch statement for all four auth methods — no fallthrough, explicit routing"
  - "Browser-oauth and ADC share cached token source path in scanner (both require re-validate if cache miss)"
  - "BuildTokenSourceForTest exported in testing.go (not _test.go) for cross-package test access from server_test"
patterns_established:
  - "GCP auth methods follow same caching pattern as Azure: validate caches token source, scanner reuses via CachedGCPTokenSource"
  - "Browser-based OAuth for GCP uses localhost redirect (same as Azure browser-sso pattern)"
  - "WIF config JSON validated structurally before SDK parsing — consistent with service-account type check"
observability_surfaces: []
drill_down_paths: []
duration: 10min
verification_result: passed
completed_at: 2026-03-14
---

# S03: GCP Advanced Auth

**GCP Browser OAuth and Workload Identity Federation auth methods implemented end-to-end — validator, session, orchestrator, scanner all wired.**

## What Happened

Added two new GCP authentication methods to complete the GCP auth matrix:

**Browser OAuth (GCP-AUTH-01):** Implemented `realGCPBrowserOAuth` validator that starts a localhost redirect HTTP server on an ephemeral port, generates a CSRF state token, opens the system browser for Google OAuth consent, waits up to 120 seconds for the authorization code callback, exchanges it for tokens, and lists accessible GCP projects via Cloud Resource Manager API. The token source is cached in `gcpTokenCache` for scanner reuse — same pattern as Azure browser-SSO.

**Workload Identity Federation (GCP-AUTH-02):** Implemented `realGCPWorkloadIdentity` validator that accepts a WIF configuration JSON file (type `external_account`), performs structural validation, and uses `google.CredentialsFromJSON` which natively handles the external_account type including token exchange and optional service account impersonation. Project ID resolution uses a 3-step fallback: list projects API → parse SA email from impersonation URL → user-supplied projectId.

**Scanner integration:** Updated `buildTokenSource` to route `browser-oauth` through the cached token source path (same as `adc`) and `workload-identity` through either cached or direct WIF JSON parsing. Added `WorkloadIdentityJSON` to `GCPCredentials` in session, and `workload_identity_json` mapping in the orchestrator.

**10 new tests** verify: field validation for missing credentials, dispatch routing (not falling through to service-account), structural WIF JSON validation (wrong type, invalid JSON), session credential storage, and scanner token source error paths.

## Verification

- All 10 new GCP auth tests pass (browser-oauth field validation, WIF structural checks, session storage, scanner routing)
- Full test suite passes: 15 packages, 0 failures
- Clean compile: `go build ./...` succeeds with no warnings
- Existing GCP tests (countGCPInstanceIPs, wrapGCPError, signature assertions) unchanged and passing

## Requirements Advanced

- GCP-AUTH-01 — Backend validator, session storage, orchestrator wiring, and scanner integration complete. Frontend OAuth credential form pending.
- GCP-AUTH-02 — Backend validator with WIF JSON validation, session storage, orchestrator wiring, and scanner integration complete. Frontend WIF upload form pending.

## Requirements Validated

- none — frontend forms needed for full end-to-end validation

## New Requirements Surfaced

- none

## Requirements Invalidated or Re-scoped

- none

## Deviations

none — the slice plan was empty (no tasks, no must-haves), so implementation was driven directly from the requirements (GCP-AUTH-01, GCP-AUTH-02) following established patterns from S01 and S02.

## Known Limitations

- Browser OAuth requires user to provide OAuth client ID and secret (created in GCP Console) — not a zero-config flow like ADC
- WIF token exchange depends on the external identity provider being reachable from the machine running the scanner
- Frontend forms for both auth methods not yet built — backend-only in this slice
- Browser OAuth test coverage is structural (field validation, dispatch routing) — live browser consent flow cannot be unit-tested

## Follow-ups

- Frontend credential forms for browser-oauth (client ID + secret inputs) and workload-identity (JSON file upload)
- All 9 auth methods across all providers now have backend implementations — M003 auth completion can be considered done pending frontend forms

## Files Created/Modified

- `server/validate.go` — added realGCPBrowserOAuth, realGCPWorkloadIdentity validators; updated realGCPValidator switch; added net import; updated storeCredentials for GCP
- `server/validate_test.go` — 10 new tests for GCP browser-oauth and workload-identity
- `internal/session/session.go` — added WorkloadIdentityJSON field to GCPCredentials
- `internal/scanner/gcp/scanner.go` — updated buildTokenSource for browser-oauth and workload-identity routing
- `internal/scanner/gcp/testing.go` — BuildTokenSourceForTest export for cross-package tests
- `internal/orchestrator/orchestrator.go` — added workload_identity_json credential mapping

## Forward Intelligence

### What the next slice should know
- All 9 backend auth methods are now implemented across all providers (AWS: access_key, sso, profile, assume_role; Azure: service-principal, browser-sso, az-cli, device_code, certificate; GCP: service-account, adc, browser-oauth, workload-identity; AD: ntlm, kerberos)
- Frontend forms are the remaining gap — backend is feature-complete for auth

### What's fragile
- Browser OAuth test coverage is structural only — the localhost redirect flow cannot be tested without a real browser interaction. If the OAuth exchange logic changes, manual testing is required.
- WIF project ID extraction from SA impersonation URL uses string parsing — if Google changes the URL format, the fallback chain handles it but the extracted project ID would be empty.

### Authoritative diagnostics
- `go test ./server/ -run "GCPBrowserOAuth|GCPWorkloadIdentity"` — 8 tests proving validator dispatch and field validation
- `go test ./server/ -run "BuildTokenSource"` — 2 tests proving scanner token source routing

### What assumptions changed
- none — patterns established in S01/S02 applied cleanly to GCP
