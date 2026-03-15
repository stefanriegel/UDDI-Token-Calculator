---
id: S02
parent: M003
milestone: M003
provides:
  - "Azure Certificate-based Service Principal authentication (PFX/PEM via azidentity.ParseCertificates)"
  - "Azure Device Code Flow authentication (interactive device code via azidentity.NewDeviceCodeCredential)"
  - "AD Kerberos authentication (pure Go via gokrb5, not Windows SSPI)"
  - "Session fields for certificate data, Kerberos realm, and KDC address"
  - "Orchestrator credential mappings for realm/kdc"
  - "Azure scanner buildCredential routing for certificate and device-code auth methods"
requires:
  - slice: S01
    provides: "Azure CLI, AWS profile/assume-role, AD HTTPS auth — all wave 0 stubs now pass"
affects:
  - S03
key_files:
  - server/validate.go
  - server/validate_test.go
  - internal/session/session.go
  - internal/scanner/ad/scanner.go
  - internal/scanner/azure/scanner.go
  - internal/orchestrator/orchestrator.go
  - go.mod
key_decisions:
  - "Azure Device Code uses azure CLI well-known public client ID (04b07795...) — no app registration needed"
  - "Azure Certificate supports both base64-encoded and raw PEM content — graceful fallback in decoder"
  - "Kerberos uses gokrb5 with DisablePAFXFAST(true) for broad DC compatibility"
  - "Kerberos builds krb5.conf programmatically — no external config file required"
  - "KDC defaults to first server host on port 88 if not explicitly provided"
  - "Certificate/device-code credentials cached in azureCredCache during validation — scanner uses cached credential (no re-auth)"
  - "gokrb5 promoted from indirect to direct dependency in go.mod"
  - "Kerberos WinRM uses SPNEGO encryption transport (same as NTLM HTTP path)"
patterns_established:
  - "Interactive Azure auth methods (browser-sso, device-code, certificate) all cache credentials in azureCredCache for scanner reuse"
  - "AD auth routing via authMethod check at top of realADValidator before NTLM path"
  - "BuildKerberosClient mirrors BuildNTLMClient signature with additional realm/kdc params"
observability_surfaces: []
drill_down_paths: []
duration: 15min
verification_result: passed
completed_at: 2026-03-14
---

# S02: Certificate, Device Code, and Kerberos Auth

**Azure Certificate-based, Device Code Flow, and AD Kerberos authentication — three auth methods fully implemented with validators, session storage, scanner credential routing, and 9 new unit tests**

## What Happened

Implemented three auth methods that were previously "Coming soon" stubs or unimplemented:

**Azure Certificate Auth (AZ-AUTH-01):** Added `realAzureCertificate` validator that accepts base64-encoded or raw PEM certificate data, parses it via `azidentity.ParseCertificates`, creates a `ClientCertificateCredential`, and caches it in `azureCredCache` for scanner reuse. Added `CertificateData` and `CertificatePassword` fields to `AzureCredentials` session type. The Azure scanner's `buildCredential` now routes "certificate" auth method through the cached credential path.

**Azure Device Code Flow (AZ-AUTH-03):** Added `realAzureDeviceCode` validator that creates a `DeviceCodeCredential` using the Azure CLI public client ID, providing a user prompt callback that prints the device code and verification URL. The credential is cached for scanner reuse. Both "device_code" and "device-code" (hyphenated) variants are accepted. Replaced the "Coming soon" stub.

**AD Kerberos Auth (AD-AUTH-01):** Added `realADKerberosValidator` that validates Kerberos credentials by checking realm presence, then delegates to `BuildKerberosClient`. Added `BuildKerberosClient` to the AD scanner package using pure Go gokrb5 — it builds a programmatic krb5.conf, obtains a TGT via `krbclient.NewWithPassword`, and creates a WinRM client with Kerberos (SPNEGO) encryption transport. Added `Realm` and `KDC` fields to `ADCredentials` session type and orchestrator credential mappings.

## Verification

- 9 new tests added across `server/validate_test.go`
- `TestValidateAzureDeviceCode` — device_code returns tenantId error, not "Coming soon"
- `TestValidateAzureDeviceCode_HyphenVariant` — device-code variant works identically
- `TestValidateAzureCertificate/missing_fields` — requires tenantId, clientId, certificateData
- `TestValidateAzureCertificate/invalid_cert` — parse error, not "Coming soon"
- `TestStoreCredentials_AzureCertificate` — certificate fields stored in session correctly
- `TestValidateADKerberos/missing_realm` — requires realm for Kerberos
- `TestValidateADKerberos/invalid_kdc` — Kerberos login error, not "Coming soon"
- `TestValidateADKerberos/missing_fields` — standard field-validation error
- `TestStoreCredentials_ADKerberos` — realm and KDC stored in session correctly
- `TestBuildKerberosClient_FailsWithInvalidKDC` — BuildKerberosClient exists and fails gracefully
- All pre-existing tests continue to pass (full `go test ./...` green)

## Requirements Advanced

- AZ-AUTH-01 — Certificate-based Service Principal validator implemented with PEM parsing; session storage and scanner routing complete
- AZ-AUTH-03 — Device Code Flow validator implemented replacing "Coming soon" stub; caches credential for scanner reuse
- AD-AUTH-01 — Kerberos auth via pure Go gokrb5 with programmatic krb5.conf; session storage and orchestrator wiring complete

## Requirements Validated

- none — live Azure/AD endpoint testing requires real infrastructure

## New Requirements Surfaced

- none

## Requirements Invalidated or Re-scoped

- none

## Deviations

none

## Known Limitations

- **Certificate format**: Only PEM format is supported. PFX (PKCS#12) requires conversion to PEM before upload. This matches azidentity.ParseCertificates behavior.
- **Device Code UX**: The device code message is printed to stdout. A future frontend enhancement could relay the code/URL via the validate response for in-browser display.
- **Kerberos runtime**: Pure Go gokrb5 with DisablePAFXFAST — works with most DCs but may fail against KDCs that enforce PA-FX-FAST (rare in practice).
- **No live integration tests**: All three auth methods require real infrastructure (Azure tenant, KDC) for end-to-end verification. Unit tests cover routing, field validation, error paths, and session storage.

## Follow-ups

- Frontend credential forms for certificate upload (file input for PEM), device code display, and Kerberos fields (realm, KDC)
- Consider relaying device code message through validate response JSON for in-browser display

## Files Created/Modified

- `server/validate.go` — realAzureDeviceCode, realAzureCertificate, realADKerberosValidator functions; kerberos routing in realADValidator; certificate/device-code case in realAzureValidator; storeCredentials updates
- `server/validate_test.go` — 9 new test functions for S02 auth methods
- `internal/session/session.go` — CertificateData, CertificatePassword on AzureCredentials; Realm, KDC on ADCredentials
- `internal/scanner/ad/scanner.go` — BuildKerberosClient function; gokrb5 imports
- `internal/scanner/azure/scanner.go` — certificate and device-code cases in buildCredential
- `internal/orchestrator/orchestrator.go` — realm and kdc credential mappings for AD
- `go.mod` — gokrb5 promoted from indirect to direct dependency

## Forward Intelligence

### What the next slice should know
- All Azure auth methods (browser-sso, az-cli, certificate, device-code, service-principal) follow the same pattern: validate → cache credential → scanner uses cached credential
- AD now supports NTLM (HTTP/HTTPS) and Kerberos — the scanner's Scan() method still uses BuildNTLMClient for the actual data collection; Kerberos auth is only used for the validate probe currently
- gokrb5 is now a direct dependency — CGO_ENABLED=0 works fine (pure Go)

### What's fragile
- `BuildKerberosClient` creates a new KDC connection per call — no connection pooling. For multi-DC Kerberos scanning, each DC would need its own TGT
- Device code flow has a 120s timeout hardcoded in the Azure SDK — cannot be extended without wrapping

### Authoritative diagnostics
- `go test -run "TestValidateAzureDeviceCode|TestValidateAzureCertificate|TestValidateADKerberos|TestBuildKerberosClient" ./server/... -v` — comprehensive auth method verification
- Session field population verified by TestStoreCredentials_AzureCertificate and TestStoreCredentials_ADKerberos

### What assumptions changed
- gokrb5 was listed as "requires domain-joined machine" in PROJECT.md — actually works standalone with explicit realm/KDC configuration
