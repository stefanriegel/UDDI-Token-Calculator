---
id: T01
parent: S01
milestone: M003
provides:
  - "Failing test stubs for 5 new auth method behaviors (Wave 0 / Nyquist compliance)"
  - "Verification targets for plans 15-01 (AWS profile, assume_role) and 15-02 (Azure CLI, AD HTTPS)"
requires: []
affects: []
key_files: []
key_decisions: []
patterns_established: []
observability_surfaces: []
drill_down_paths: []
duration: 3min
verification_result: passed
completed_at: 2026-03-14
blocker_discovered: false
---
# T01: 15-quick-win-auth-methods 00

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
