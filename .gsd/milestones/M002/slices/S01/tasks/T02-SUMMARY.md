---
id: T02
parent: S01
milestone: M002
provides:
  - "ProviderNIOS = 'nios' constant in internal/scanner/provider.go"
  - "Stub NIOS scanner at internal/scanner/nios/scanner.go (registered in orchestrator)"
  - "GET /api/v1/scan/{scanId}/status polling endpoint (replaces SSE)"
  - "POST /api/v1/providers/nios/upload multipart endpoint (parses onedb.xml from .tar.gz/.tgz/.bak)"
  - "SSE endpoint GET /api/v1/scan/{scanId}/events removed"
requires: []
affects: []
key_files: []
key_decisions: []
patterns_established: []
observability_surfaces: []
drill_down_paths: []
duration: 15min
verification_result: passed
completed_at: 2026-03-09
blocker_discovered: false
---
# T02: 09-frontend-extension-api-migration 02

**# Phase 9 Plan 02: Backend API Migration Summary**

## What Happened

# Phase 9 Plan 02: Backend API Migration Summary

**SSE endpoint removed, polling GET /status + NIOS multipart upload POST added; ProviderNIOS constant and stub scanner registered in orchestrator**

## Performance

- **Duration:** 15 min
- **Started:** 2026-03-09T23:40:00Z
- **Completed:** 2026-03-09T23:55:00Z
- **Tasks:** 2
- **Files modified:** 6 (+ 1 created)

## Accomplishments

- Deleted SSE event-streaming handler (HandleScanEvents) and its 3 tests — no deprecation, clean cut
- Added GET /api/v1/scan/{scanId}/status polling endpoint returning {status, progress, providers[]} JSON
- Added POST /api/v1/providers/nios/upload: parses .tar.gz/.tgz/.bak NIOS backup, extracts Grid Member hostnames and roles from onedb.xml via streaming XML decoder
- Declared ProviderNIOS = "nios" constant and created stub NIOS scanner registered in orchestrator map
- All existing tests pass; 2 new status endpoint tests added

## Task Commits

Each task was committed atomically:

1. **Task 1: Add ProviderNIOS constant and NIOS stub scanner** - `cc986ce` (feat)
2. **Task 2: Add polling status endpoint and NIOS upload endpoint; remove SSE** - `c56d51f` (feat)

**Plan metadata:** (docs commit follows)

## Files Created/Modified

- `internal/scanner/nios/scanner.go` - Stub NIOS scanner implementing scanner.Scanner (returns empty findings)
- `internal/scanner/provider.go` - Added ProviderNIOS = "nios" constant
- `main.go` - Registered niosscanner.New() in orchestrator map
- `server/types.go` - Added ScanStatusResponse, ProviderScanStatus, NiosGridMember, NiosUploadResponse
- `server/scan.go` - Deleted HandleScanEvents; added HandleGetScanStatus + HandleUploadNiosBackup + XML parsing helpers
- `server/server.go` - Removed /events route; added /status and /providers/nios/upload routes; updated log suppression
- `server/scan_test.go` - Removed 3 SSE tests; added TestHandleGetScanStatus_Running + TestHandleGetScanStatus_NotFound

## Decisions Made

- SSE endpoint cut clean — no deprecation, because Plan 03 ships the polling client atomically in the same phase
- HandleUploadNiosBackup is a package-level function (not a method on ScanHandler) since it has no dependency on the session store or orchestrator
- Log suppression middleware updated to suppress /status instead of /events (polling fires every 1.5s)
- Providers slice in ScanStatusResponse is empty []ProviderScanStatus for Phase 9; Phase 10 populates it with per-member granularity

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- GET /api/v1/scan/{scanId}/status is live — Plan 03 (frontend polling migration) can replace SSE calls
- POST /api/v1/providers/nios/upload is live — Plan 04 (NIOS wizard) can send backup files
- ProviderNIOS constant is available — frontend can pass "nios" as a provider name in scan requests
- NIOS stub scanner is wired — orchestrator will run it silently (empty results) until Phase 10 fills in real parsing

---
*Phase: 09-frontend-extension-api-migration*
*Completed: 2026-03-09*

## Self-Check: PASSED

All created files exist on disk. Both task commits (cc986ce, c56d51f) verified in git log.
