---
id: M003
provides:
  - "All 9 previously unimplemented auth methods now have working backend validators, session storage, orchestrator wiring, and scanner credential routing"
  - "AWS CLI Profile authentication via named ~/.aws/credentials profiles"
  - "AWS Assume Role with auto-refreshing AssumeRoleProvider credentials"
  - "Azure CLI (az login) authentication with LookPath pre-check"
  - "Azure Certificate-based Service Principal authentication (PEM via azidentity.ParseCertificates)"
  - "Azure Device Code Flow authentication (interactive device code via azidentity.NewDeviceCodeCredential)"
  - "AD Kerberos authentication (pure Go gokrb5, no domain-joined machine required)"
  - "AD WinRM HTTPS transport with functional options pattern and self-signed cert support"
  - "GCP Browser OAuth via localhost redirect server with CSRF protection"
  - "GCP Workload Identity Federation via external_account JSON configuration"
  - "Shared listAzureSubscriptions helper (DRY refactor)"
key_decisions:
  - "Assume-role uses source profile (not access keys) for base credentials, matching AWS CLI convention"
  - "AssumeRoleProvider with CredentialsCache replaces static one-time STS call for auto-refresh during long scans"
  - "Azure Device Code uses azure CLI well-known public client ID (04b07795...) — no app registration needed"
  - "AD Kerberos uses gokrb5 with DisablePAFXFAST(true) for broad DC compatibility — does not require domain-joined machine"
  - "Kerberos builds krb5.conf programmatically — no external config file required"
  - "HTTPS path skips SPNEGO message-level encryption (TLS provides transport security)"
  - "Functional options pattern for backward-compatible variadic BuildNTLMClient signature"
  - "GCP Browser OAuth uses net.Listen on 127.0.0.1:0 for ephemeral port — no port conflict"
  - "GCP WIF uses google.CredentialsFromJSON which natively handles external_account type — no custom token exchange"
  - "WIF project ID fallback chain: list projects API → SA impersonation URL parsing → user-provided projectId"
  - "Scanner buildTokenSource routes browser-oauth through same cached path as ADC"
  - "Certificate/device-code/browser-oauth credentials cached during validation — scanner uses cached credential (no re-auth)"
patterns_established:
  - "Wave 0 stubs: use real validators (not stubs) so tests exercise actual dispatch paths"
  - "Profile-based auth: LoadDefaultConfig with WithSharedConfigProfile for named profile resolution"
  - "Auto-refresh credentials: stscreds.AssumeRoleProvider wrapped in aws.NewCredentialsCache"
  - "ClientOption functional options: use WithHTTPS() and WithInsecureSkipVerify() for WinRM transport config"
  - "Interactive auth methods (browser-sso, device-code, certificate, browser-oauth) all cache credentials for scanner reuse"
  - "AD auth routing via authMethod check at top of realADValidator before NTLM path"
  - "GCP auth methods follow same caching pattern as Azure: validate caches, scanner reuses"
  - "Browser-based OAuth for GCP uses localhost redirect (same as Azure browser-sso pattern)"
observability_surfaces:
  - none
requirement_outcomes:
  - id: AWS-AUTH-01
    from_status: active
    to_status: validated
    proof: "TestValidateAWSProfile passes — profile validator calls STS GetCallerIdentity, returns account ID. Implemented in S01 plan 15-01."
  - id: AWS-AUTH-02
    from_status: active
    to_status: validated
    proof: "TestValidateAWSAssumeRole and TestBuildConfigAssumeRole pass — AssumeRoleProvider with CredentialsCache for auto-refresh. Implemented in S01 plan 15-01."
  - id: AZ-AUTH-02
    from_status: active
    to_status: validated
    proof: "TestValidateAzureCLI passes — az-cli case with LookPath pre-check, AzureCLICredential, subscription listing. Implemented in S01 plan 15-02."
  - id: AD-AUTH-02
    from_status: active
    to_status: validated
    proof: "TestBuildNTLMClientHTTPS passes with HTTP/HTTPS/insecure variants — functional options WithHTTPS() and WithInsecureSkipVerify(). Implemented in S01 plan 15-02."
duration: 29min
verification_result: passed
completed_at: 2026-03-14
---

# M003: Auth Method Completion

**All 9 previously unimplemented auth methods across AWS, Azure, GCP, and AD now have working backend validators with session storage, orchestrator wiring, scanner credential routing, and 30+ unit tests — eliminating all "Coming soon" stubs and silent fallthrough errors.**

## What Happened

M003 delivered backend implementations for every auth method that was previously a stub, a silent mismatch, or a confusing fallthrough error. The work split across three slices by risk and dependency order.

**S01 (Quick Wins)** tackled the five simplest auth methods. Wave 0 test stubs were created first as Nyquist verification targets — each test exercised the real validator dispatch so it would fail clearly until the implementation landed. Plan 15-01 implemented AWS CLI Profile (named profile from `~/.aws/credentials` via `LoadDefaultConfig`) and Assume Role (STS `AssumeRoleProvider` with `CredentialsCache` for auto-refresh during long multi-region scans). Plan 15-02 implemented Azure CLI (`az login` with `LookPath` pre-check and `AzureCLICredential`) and AD WinRM HTTPS (functional options pattern for backward-compatible `BuildNTLMClient` signature with `WithHTTPS()` and `WithInsecureSkipVerify()`). A shared `listAzureSubscriptions` helper was extracted to DRY subscription listing across browser-sso, az-cli, and service-principal paths.

**S02 (Certificate, Device Code, Kerberos)** added three auth methods requiring new SDK integrations. Azure Certificate-based auth parses PEM certificates via `azidentity.ParseCertificates` and creates a `ClientCertificateCredential`. Azure Device Code Flow uses the well-known Azure CLI public client ID so no app registration is needed. AD Kerberos uses pure Go `gokrb5` with programmatic `krb5.conf` generation — no domain-joined machine required, correcting a prior assumption in PROJECT.md. All three cache credentials during validation for scanner reuse.

**S03 (GCP Advanced)** completed the auth matrix with GCP Browser OAuth (localhost redirect server with CSRF state token, 120s timeout, token source caching) and Workload Identity Federation (structural validation of `external_account` JSON, native `google.CredentialsFromJSON` handling, 3-step project ID fallback). The scanner's `buildTokenSource` was updated with explicit routing for all four GCP auth methods.

## Cross-Slice Verification

**Milestone vision: "Implement or gracefully handle all 9 unimplemented auth methods — eliminating silent mismatches, confusing fall-through errors, and 'Coming soon' stubs."**

Verified by running `go test ./...` — all 15 packages pass with 0 failures. Specific auth method verification:

| Auth Method | Verification | Evidence |
|---|---|---|
| AWS CLI Profile | TestValidateAWSProfile passes — no longer returns "Coming soon" | S01 plan 15-01 |
| AWS Assume Role | TestValidateAWSAssumeRole (2 subtests), TestBuildConfigAssumeRole pass | S01 plan 15-01 |
| Azure CLI | TestValidateAzureCLI passes — no longer falls through to service-principal | S01 plan 15-02 |
| Azure Certificate | TestValidateAzureCertificate (2 subtests), TestStoreCredentials_AzureCertificate pass | S02 |
| Azure Device Code | TestValidateAzureDeviceCode, TestValidateAzureDeviceCode_HyphenVariant pass | S02 |
| AD Kerberos | TestValidateADKerberos (3 subtests), TestStoreCredentials_ADKerberos, TestBuildKerberosClient pass | S02 |
| AD WinRM HTTPS | TestBuildNTLMClientHTTPS passes with HTTP/HTTPS/insecure variants | S01 plan 15-02 |
| GCP Browser OAuth | TestGCPBrowserOAuth (field validation, dispatch routing) passes | S03 |
| GCP Workload Identity | TestGCPWorkloadIdentity (structural validation, session storage) passes | S03 |

All 9 `case` branches exist in `server/validate.go` — no auth method falls through to a default/error path or returns "Coming soon."

**Definition of done:**
- All 3 slices marked `[x]` in roadmap ✓
- All 3 slice summaries exist (S01-SUMMARY.md, S02-SUMMARY.md, S03-SUMMARY.md) ✓
- Cross-slice integration: S02/S03 auth methods follow the same caching and routing patterns established in S01 ✓
- Full test suite green (`go test ./...` — 15 packages, 0 failures) ✓

## Requirement Changes

- AWS-AUTH-01: active → validated — TestValidateAWSProfile passes, profile validator implemented with named profile resolution
- AWS-AUTH-02: active → validated — TestValidateAWSAssumeRole and TestBuildConfigAssumeRole pass, AssumeRoleProvider with auto-refresh
- AZ-AUTH-02: active → validated — TestValidateAzureCLI passes, az-cli case with LookPath pre-check
- AD-AUTH-02: active → validated — TestBuildNTLMClientHTTPS passes, functional options for HTTPS/insecure

**Remaining active (backend complete, frontend forms pending):**
- AZ-AUTH-01: stays active — backend certificate auth complete, frontend upload form not yet built
- AZ-AUTH-03: stays active — backend device code complete, frontend display not yet built
- AD-AUTH-01: stays active — backend Kerberos auth complete, frontend credential form not yet built
- GCP-AUTH-01: stays active — backend browser-oauth complete, frontend OAuth form not yet built
- GCP-AUTH-02: stays active — backend WIF complete, frontend JSON upload form not yet built

## Forward Intelligence

### What the next milestone should know
- All backend auth methods are complete. The remaining gap is frontend credential forms for 5 auth methods (AZ-AUTH-01, AZ-AUTH-03, AD-AUTH-01, GCP-AUTH-01, GCP-AUTH-02). The existing frontend already has form inputs for AWS profile and assume-role.
- The `mock-data.ts` file in the frontend defines the auth method options shown in the UI — new form fields need to be wired into `wizard.tsx` credential step.
- gokrb5 is now a direct dependency. CGO_ENABLED=0 works fine (pure Go).

### What's fragile
- Browser OAuth test coverage is structural only — the localhost redirect flow cannot be tested without a real browser. Manual testing required if OAuth exchange logic changes.
- WIF project ID extraction from SA impersonation URL uses string parsing — if Google changes the URL format, the fallback chain handles it gracefully but extracted project ID would be empty.
- `BuildKerberosClient` creates a new KDC connection per call — no connection pooling. For multi-DC Kerberos scanning, each DC would need its own TGT.
- Device code flow has a 120s timeout hardcoded in the Azure SDK — cannot be extended without wrapping.

### Authoritative diagnostics
- `go test ./server/ -run "TestValidateAWS|TestValidateAzure|TestValidateAD|TestGCP|TestBuildTokenSource|TestStoreCredentials" -v` — comprehensive auth method verification across all providers
- `go test ./internal/scanner/ad/ -run "TestBuildNTLMClientHTTPS|TestBuildKerberosClient" -v` — scanner-level auth verification
- `go test ./internal/scanner/aws/ -run "TestBuildConfigAssumeRole" -v` — AWS scanner assume-role verification

### What assumptions changed
- gokrb5 was listed as requiring a domain-joined machine in PROJECT.md — actually works standalone with explicit realm/KDC configuration
- Azure Certificate was listed as needing PFX support — azidentity.ParseCertificates only handles PEM; PFX requires conversion (documented as known limitation)

## Files Created/Modified

- `server/validate.go` — 9 new validator functions/cases for all auth methods; storeCredentials updates; listAzureSubscriptions shared helper
- `server/validate_test.go` — 30+ test functions covering all 9 auth methods
- `internal/session/session.go` — SourceProfile, ExternalID, CertificateData, CertificatePassword, Realm, KDC, UseSSL, InsecureSkipVerify, WorkloadIdentityJSON fields
- `internal/scanner/aws/scanner.go` — AssumeRoleProvider with CredentialsCache
- `internal/scanner/aws/scanner_test.go` — TestBuildConfigAssumeRole with temp credentials
- `internal/scanner/ad/scanner.go` — ClientOption functional options, WithHTTPS, WithInsecureSkipVerify, BuildKerberosClient
- `internal/scanner/ad/scanner_test.go` — TestBuildNTLMClientHTTPS, TestBuildKerberosClient
- `internal/scanner/azure/scanner.go` — certificate, device-code, az-cli cases in buildCredential
- `internal/scanner/gcp/scanner.go` — browser-oauth and workload-identity routing in buildTokenSource
- `internal/scanner/gcp/testing.go` — BuildTokenSourceForTest export
- `internal/orchestrator/orchestrator.go` — source_profile, external_id, use_ssl, insecure_skip_verify, realm, kdc, workload_identity_json mappings
- `frontend/src/app/components/mock-data.ts` — insecureSkipVerify field
- `go.mod` — gokrb5 promoted to direct dependency
