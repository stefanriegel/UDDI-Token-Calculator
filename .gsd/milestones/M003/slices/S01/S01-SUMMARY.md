---
id: S01
parent: M003
milestone: M003
provides:
  - "Failing test stubs for 5 new auth method behaviors (Wave 0 / Nyquist compliance)"
  - "Verification targets for plans 15-01 (AWS profile, assume_role) and 15-02 (Azure CLI, AD HTTPS)"
  - "AWS CLI Profile authentication via named ~/.aws/credentials profiles"
  - "AWS Assume Role authentication with auto-refreshing credentials"
  - "Session SourceProfile and ExternalID fields for cross-account role assumption"
  - "Orchestrator source_profile/external_id credential mappings to scanner"
  - "Azure CLI (az login) authentication with credential caching"
  - "AD WinRM HTTPS transport with functional options pattern"
  - "insecureSkipVerify support for self-signed WinRM HTTPS certs"
  - "Shared listAzureSubscriptions helper (DRY refactor)"
requires: []
affects: []
key_files: []
key_decisions:
  - "TestValidateAzureCLI checks for service-principal fallthrough (tenantId/clientId/clientSecret error) to catch az-cli not having its own case"
  - "TestBuildNTLMClientHTTPS passes as HTTP baseline with TODO slot for HTTPS options after 15-02"
  - "Assume-role uses source profile (not access keys) for base credentials, matching AWS CLI convention"
  - "AssumeRoleProvider with CredentialsCache replaces static one-time STS call for auto-refresh during long scans"
  - "Empty profile/sourceProfile defaults to 'default' matching AWS CLI behavior"
  - "ExternalID omitted from STS call when empty (not sent as empty string)"
  - "Extract listAzureSubscriptions as shared helper for DRY across browser-sso, az-cli, service-principal"
  - "HTTPS path skips SPNEGO message-level encryption (TLS provides transport security)"
  - "Functional options pattern for backward-compatible variadic BuildNTLMClient signature"
patterns_established:
  - "Wave 0 stubs: use real validators (not stubs) so tests exercise actual dispatch paths"
  - "Profile-based auth: LoadDefaultConfig with WithSharedConfigProfile for named profile resolution"
  - "Auto-refresh credentials: stscreds.AssumeRoleProvider wrapped in aws.NewCredentialsCache"
  - "ClientOption functional options: use WithHTTPS() and WithInsecureSkipVerify() for WinRM transport config"
  - "Azure auth credential caching: all interactive methods cache in azureCredCache with nanosecond key"
observability_surfaces: []
drill_down_paths: []
duration: 4min
verification_result: passed
completed_at: 2026-03-14
blocker_discovered: false
---
# S01: Quick Win Auth Methods

**# Phase 15 Plan 00: Wave 0 Test Stubs Summary**

## What Happened

# Phase 15 Plan 00: Wave 0 Test Stubs Summary

**5 failing test stubs across 3 files for AWS profile, AWS assume_role, Azure CLI, AWS buildConfig assume_role, and AD HTTPS -- Nyquist verification targets for plans 15-01 and 15-02**

## Performance

- **Duration:** 3 min
- **Started:** 2026-03-14T21:40:26Z
- **Completed:** 2026-03-14T21:43:53Z
- **Tasks:** 1
- **Files modified:** 3

## Accomplishments
- 5 test functions added that compile against current codebase and fail with clear messages
- TestValidateAWSProfile fails: profile returns "Coming soon"
- TestValidateAWSAssumeRole fails: assume_role returns "Coming soon" (both subtests)
- TestValidateAzureCLI fails: az-cli falls through to service-principal validation
- TestBuildConfigAssumeRole fails: expects source_profile but old code reads access_key_id
- TestBuildNTLMClientHTTPS passes: HTTP baseline with TODO for HTTPS options

## Task Commits

Each task was committed atomically:

1. **Task 1: Create failing test stubs for all 5 auth method behaviors** - `73b3bb0` (test)

## Files Created/Modified
- `server/validate_test.go` - TestValidateAWSProfile, TestValidateAWSAssumeRole, TestValidateAzureCLI
- `internal/scanner/aws/scanner_test.go` - TestBuildConfigAssumeRole (+ context import)
- `internal/scanner/ad/scanner_test.go` - TestBuildNTLMClientHTTPS

## Decisions Made
- TestValidateAzureCLI: added check for service-principal fallthrough error (tenantId/clientId/clientSecret) because az-cli is not in the switch statement -- it falls through to the default path rather than returning "Coming soon" or "unknown"
- TestBuildNTLMClientHTTPS: tests HTTP baseline only (current 3-arg signature) with TODO comments for HTTPS options that plan 15-02 will add

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] TestValidateAzureCLI false-pass fixed**
- **Found during:** Task 1 (test verification)
- **Issue:** Original test only checked for "Coming soon" and "unknown" strings, but az-cli falls through to service-principal validation returning "tenantId, clientId, and clientSecret are required" -- neither trigger matched, so test falsely passed
- **Fix:** Added check for service-principal field names (tenantId/clientId/clientSecret) in error message to detect the fallthrough
- **Files modified:** server/validate_test.go
- **Verification:** Test now correctly fails with clear message about fallthrough
- **Committed in:** 73b3bb0

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** Essential for test correctness. Without this fix the test would pass despite az-cli not being implemented.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- All 5 test stubs ready as verification targets for plans 15-01 and 15-02
- Plan 15-01 should make TestValidateAWSProfile, TestValidateAWSAssumeRole, and TestBuildConfigAssumeRole pass
- Plan 15-02 should make TestValidateAzureCLI pass and update TestBuildNTLMClientHTTPS for HTTPS options

---
*Phase: 15-quick-win-auth-methods*
*Completed: 2026-03-14*

# Phase 15 Plan 01: AWS CLI Profile and Assume Role Authentication Summary

**AWS CLI Profile and Assume Role validators with auto-refreshing AssumeRoleProvider credentials for long multi-region scans**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-14T21:46:31Z
- **Completed:** 2026-03-14T21:50:21Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments
- Implemented AWS CLI Profile validator: authenticates via named profile, calls STS GetCallerIdentity, returns account ID
- Implemented AWS Assume Role validator: source profile + STS AssumeRole with optional ExternalID, returns target account ID
- Refactored scanner assume-role from static one-time STS credentials to stscreds.AssumeRoleProvider with CredentialsCache for auto-refresh
- Added SourceProfile and ExternalID session fields with orchestrator-to-scanner credential mappings

## Task Commits

Each task was committed atomically:

1. **Task 1: Add session fields + orchestrator mappings + AWS CLI Profile validator** - `58cfd02` (feat)
2. **Task 2: Refactor AWS scanner assume-role to AssumeRoleProvider with CredentialsCache** - `09af030` (feat)

## Files Created/Modified
- `server/validate.go` - Profile and assume-role validator cases, parseAccountFromARN helper, storeCredentials SourceProfile/ExternalID
- `internal/session/session.go` - SourceProfile and ExternalID fields on AWSCredentials
- `internal/orchestrator/orchestrator.go` - source_profile and external_id credential mappings in buildScanRequest
- `internal/scanner/aws/scanner.go` - AssumeRoleProvider with CredentialsCache replacing static credentials
- `internal/scanner/aws/scanner_test.go` - Temporary AWS credentials file for CI-compatible TestBuildConfigAssumeRole

## Decisions Made
- Assume-role uses source profile (not access keys) for base credentials, matching AWS CLI source_profile convention
- AssumeRoleProvider with CredentialsCache replaces static one-time STS call -- auto-refreshes 5 minutes before expiry
- Empty profile/sourceProfile defaults to "default" matching AWS CLI behavior
- ExternalID omitted from STS call when empty (not sent as empty string)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added temporary AWS credentials file for TestBuildConfigAssumeRole**
- **Found during:** Task 2 (scanner assume-role refactor)
- **Issue:** TestBuildConfigAssumeRole failed because LoadDefaultConfig with WithSharedConfigProfile("default") errors when no ~/.aws/credentials file exists
- **Fix:** Created temporary credentials file with dummy keys in test, set AWS_SHARED_CREDENTIALS_FILE and AWS_CONFIG_FILE env vars
- **Files modified:** internal/scanner/aws/scanner_test.go
- **Verification:** TestBuildConfigAssumeRole passes
- **Committed in:** 09af030 (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Auto-fix necessary for test to pass in environments without AWS credentials. No scope creep.

## Issues Encountered
- Pre-existing TestValidateAzureCLI failure (Wave 0 stub for plan 15-02) -- confirmed unrelated to this plan's changes

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Profile and assume-role auth methods fully operational in validator and scanner
- Plan 15-02 (Azure Device Code + AD Kerberos) can proceed independently
- Frontend AWS credential forms already support profile and assume-role field inputs

---
*Phase: 15-quick-win-auth-methods*
*Completed: 2026-03-14*

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
