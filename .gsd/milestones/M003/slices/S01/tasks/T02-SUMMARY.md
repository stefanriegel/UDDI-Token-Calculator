---
id: T02
parent: S01
milestone: M003
provides:
  - "AWS CLI Profile authentication via named ~/.aws/credentials profiles"
  - "AWS Assume Role authentication with auto-refreshing credentials"
  - "Session SourceProfile and ExternalID fields for cross-account role assumption"
  - "Orchestrator source_profile/external_id credential mappings to scanner"
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
# T02: 15-quick-win-auth-methods 01

**# Phase 15 Plan 01: AWS CLI Profile and Assume Role Authentication Summary**

## What Happened

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
