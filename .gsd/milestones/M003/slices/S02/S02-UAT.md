# S02: Certificate, Device Code, and Kerberos Auth — UAT

**Milestone:** M003
**Written:** 2026-03-14

## UAT Type

- UAT mode: mixed (artifact-driven unit tests + live-runtime for real infrastructure)
- Why this mode is sufficient: Unit tests verify routing, field validation, error messages, and session storage. Live testing requires Azure tenant and AD domain controller access.

## Preconditions

- Go 1.24+ installed
- Project builds cleanly: `go build ./...`
- All tests pass: `go test ./...`
- For live tests: Azure AD tenant with a certificate-registered Service Principal, a Windows DC with Kerberos enabled

## Smoke Test

```bash
go test -run "TestValidateAzureDeviceCode|TestValidateAzureCertificate|TestValidateADKerberos" ./server/... -v -count=1
```
All 8+ tests (including subtests) pass — confirms certificate, device code, and Kerberos auth methods are implemented and not "Coming soon" stubs.

## Test Cases

### 1. Azure Device Code — No Longer "Coming Soon"

1. Run: `go test -run TestValidateAzureDeviceCode$ ./server/... -v`
2. Observe: Test passes — sends authMethod="device_code" with empty credentials
3. **Expected:** Error mentions "tenantId" (field validation), NOT "Coming soon" or "clientSecret"

### 2. Azure Device Code — Hyphenated Variant

1. Run: `go test -run TestValidateAzureDeviceCode_HyphenVariant ./server/... -v`
2. **Expected:** authMethod="device-code" accepted identically to "device_code" — no "Coming soon"

### 3. Azure Certificate — Missing Fields

1. Run: `go test -run TestValidateAzureCertificate/missing_fields ./server/... -v`
2. **Expected:** Error mentions "certificateData" — clear field validation, not fallthrough to service-principal

### 4. Azure Certificate — Invalid Certificate Data

1. Run: `go test -run TestValidateAzureCertificate/invalid_cert ./server/... -v`
2. **Expected:** Error mentions "certificate" or "parse" — actual parse attempt, not a stub

### 5. Azure Certificate — Session Storage

1. Run: `go test -run TestStoreCredentials_AzureCertificate ./server/... -v`
2. **Expected:** Session stores AuthMethod="certificate", TenantID, ClientID, CertificateData (base64), CertificatePassword

### 6. AD Kerberos — Missing Realm

1. Run: `go test -run TestValidateADKerberos/missing_realm ./server/... -v`
2. **Expected:** Error mentions "realm" — Kerberos-specific validation, not NTLM fallback

### 7. AD Kerberos — Invalid KDC

1. Run: `go test -run TestValidateADKerberos/invalid_kdc ./server/... -v`
2. **Expected:** Error mentions "kerberos" (case-insensitive) — actual KDC connection attempt, not stub

### 8. AD Kerberos — Missing Basic Fields

1. Run: `go test -run TestValidateADKerberos/missing_fields ./server/... -v`
2. **Expected:** Error mentions "required" — standard field validation fires before Kerberos-specific logic

### 9. AD Kerberos — Session Storage

1. Run: `go test -run TestStoreCredentials_ADKerberos ./server/... -v`
2. **Expected:** Session stores AuthMethod="kerberos", Realm="CORP.EXAMPLE.COM", KDC="dc01.corp.example.com:88"

### 10. BuildKerberosClient Signature and Graceful Failure

1. Run: `go test -run TestBuildKerberosClient_FailsWithInvalidKDC ./server/... -v`
2. **Expected:** BuildKerberosClient exists with (host, user, pass, realm, kdc, ...opts) signature; returns kerberos-related error for unreachable KDC

### 11. Pre-existing Tests Unaffected

1. Run: `go test ./... -count=1`
2. **Expected:** All packages pass — no regressions in AWS, Azure (browser-sso, az-cli, service-principal), GCP, AD (NTLM), Bluecat, EfficientIP, NIOS

## Edge Cases

### Device Code Both Variants

1. POST `/api/v1/providers/azure/validate` with authMethod="device_code" → gets tenantId error
2. POST `/api/v1/providers/azure/validate` with authMethod="device-code" → gets same tenantId error
3. **Expected:** Both variants route to the same realAzureDeviceCode handler

### Certificate Raw PEM vs Base64

1. POST with certificateData as raw PEM text (starts with "-----BEGIN")
2. POST with certificateData as base64-encoded PEM
3. **Expected:** Both are accepted — base64 decode attempted first, raw fallback on decode error

### Kerberos Default KDC

1. POST `/api/v1/providers/ad/validate` with authMethod="kerberos", realm="CORP.COM", server="dc01.corp.com", kdc="" (empty)
2. **Expected:** KDC defaults to "dc01.corp.com:88" — validator still attempts Kerberos login

### Certificate Falls Through to Parse Error, Not Service-Principal

1. POST with authMethod="certificate", tenantId+clientId set, certificateData="garbage"
2. **Expected:** Error says "failed to parse certificate", NOT "tenantId, clientId, and clientSecret are required"

## Failure Signals

- Any test containing "Coming soon" in error output — auth method not implemented
- Any test where device_code/certificate falls through to service-principal path (error mentions clientSecret)
- Kerberos test that returns "unknown" auth method — routing not added
- Pre-existing tests fail after changes — regression in existing auth methods
- BuildKerberosClient not found at compile time — import or export issue

## Requirements Proved By This UAT

- AZ-AUTH-01 — Certificate validator accepts PEM data, parses certificates, creates credential, stores in session
- AZ-AUTH-03 — Device code validator replaces "Coming soon", requires tenantId, creates DeviceCodeCredential
- AD-AUTH-01 — Kerberos validator requires realm/KDC, uses pure Go gokrb5, builds SPNEGO WinRM client

## Not Proven By This UAT

- End-to-end Azure Certificate authentication against a real Azure AD tenant
- End-to-end Device Code flow with actual browser interaction and token exchange
- End-to-end Kerberos authentication against a real Windows DC/KDC
- Scanner data collection using Kerberos-authenticated WinRM sessions (validate probe only)
- Frontend UI for certificate upload, device code display, or Kerberos credential forms

## Notes for Tester

- Device code flow requires user interaction (browser approval) — cannot be fully automated in CI
- Certificate auth requires a real PFX/PEM file from an Azure Service Principal — generate with `openssl` or Azure Portal
- Kerberos auth requires a Windows DC with Kerberos enabled and port 88 accessible — test in lab environment
- All unit tests are deterministic and can run in any CI environment (no external dependencies)
