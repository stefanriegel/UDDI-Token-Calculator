---
id: T03
parent: S01
milestone: M003
provides:
  - "Azure CLI (az login) authentication with credential caching"
  - "AD WinRM HTTPS transport with functional options pattern"
  - "insecureSkipVerify support for self-signed WinRM HTTPS certs"
  - "Shared listAzureSubscriptions helper (DRY refactor)"
requires: []
affects: []
key_files: []
key_decisions: []
patterns_established: []
observability_surfaces: []
drill_down_paths: []
duration: 4min
verification_result: passed
completed_at: 2026-03-14
blocker_discovered: false
---
# T03: 15-quick-win-auth-methods 02

**# Phase 15 Plan 02: Azure CLI + AD HTTPS Auth Summary**

## What Happened

# Phase 15 Plan 02: Azure CLI + AD HTTPS Auth Summary

**Azure CLI zero-field auth via az login session with LookPath pre-check, and AD WinRM HTTPS on port 5986 with functional options pattern and self-signed cert support**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-14T21:52:33Z
- **Completed:** 2026-03-14T21:56:33Z
- **Tasks:** 2
- **Files modified:** 7

## Accomplishments
- Azure CLI auth pre-checks az binary with LookPath, creates AzureCLICredential, caches in azureCredCache, lists subscriptions via shared helper
- BuildNTLMClient accepts WithHTTPS() and WithInsecureSkipVerify() functional options, HTTPS skips SPNEGO encryption
- Full options passthrough: Scan -> scanAllDCs -> scanOneDC -> BuildNTLMClient
- Session stores UseSSL and InsecureSkipVerify, orchestrator maps to credential keys, validator passes options to BuildNTLMClient

## Task Commits

Each task was committed atomically:

1. **Task 1: Azure CLI validator + scanner case** - `6134ba1` (feat)
2. **Task 2: AD WinRM HTTPS support + session/orchestrator/frontend wiring** - `2996304` (feat)

## Files Created/Modified
- `server/validate.go` - az-cli case, realAzureCLI function, listAzureSubscriptions shared helper, HTTPS options in AD validator
- `internal/scanner/azure/scanner.go` - az-cli case in buildCredential
- `internal/scanner/ad/scanner.go` - ClientOption type, WithHTTPS, WithInsecureSkipVerify, variadic BuildNTLMClient, options passthrough in scanOneDC/scanAllDCs/Scan
- `internal/scanner/ad/scanner_test.go` - Updated compile-time assertion, TestBuildNTLMClientHTTPS with HTTP/HTTPS/insecure variants
- `internal/session/session.go` - UseSSL and InsecureSkipVerify fields on ADCredentials
- `internal/orchestrator/orchestrator.go` - use_ssl and insecure_skip_verify credential mappings
- `frontend/src/app/components/mock-data.ts` - insecureSkipVerify field on powershell-remote auth method

## Decisions Made
- Extracted listAzureSubscriptions as shared helper to DRY subscription listing across browser-sso, az-cli, and service-principal auth methods
- HTTPS path uses plain NTLM auth without SPNEGO TransportDecorator -- TLS provides transport encryption, avoiding double-encryption issues on some Windows Server versions
- Functional options pattern chosen for backward compatibility -- existing callers without options continue to work unchanged

## Deviations from Plan
None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Azure CLI and AD HTTPS auth methods fully functional
- Ready for phase 16 (Azure advanced auth) or phase 17 (GCP advanced auth)
- TestValidateAzureCLI and TestBuildNTLMClientHTTPS both pass with full coverage

---
*Phase: 15-quick-win-auth-methods*
*Completed: 2026-03-14*
