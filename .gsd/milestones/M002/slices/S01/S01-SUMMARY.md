---
id: S01
parent: M002
milestone: M002
provides:
  - System font stack in fonts.css (zero CDN requests)
  - App.tsx with page title and inline SVG favicon, no version fetch
  - 6 provider SVG logos in frontend/src/assets/logos/ (bundled)
  - 6 provider SVG logos in frontend/public/logos/ (static served)
  - 3 PNG assets from Figma export in frontend/src/assets/
  - performance-specs.csv and performance-metrics.csv in frontend/src/imports/
  - "ProviderNIOS = 'nios' constant in internal/scanner/provider.go"
  - "Stub NIOS scanner at internal/scanner/nios/scanner.go (registered in orchestrator)"
  - "GET /api/v1/scan/{scanId}/status polling endpoint (replaces SSE)"
  - "POST /api/v1/providers/nios/upload multipart endpoint (parses onedb.xml from .tar.gz/.tgz/.bak)"
  - "SSE endpoint GET /api/v1/scan/{scanId}/events removed"
  - "NIOS provider card as 5th option in Step 1 alongside AWS, Azure, GCP, AD"
  - "File dropzone in Step 2 for NIOS with idle/uploading/done/error states"
  - "Grid Member checkbox list with Select All/Deselect All toggle after successful upload"
  - "Next button in Step 2 gated on niosSelectedMembers.size > 0"
  - "niosSelectedMembers passed as subscriptions array in startScan request body"
  - "ProviderType union extended to include 'nios'; PROVIDERS array has NIOS entry with isFileUpload:true"
  - Human-verified confirmation that all Phase 9 changes are functional end-to-end
requires: []
affects: []
key_files: []
key_decisions:
  - "document.title assigned at module level — never changes so no useEffect needed"
  - "Inline SVG favicon encoded as data URI — zero external network request"
  - "frontend/public/ created as Vite static root for logos served at runtime URL path /logos/"
  - "CSV files copied verbatim from Figma export — Phase 11 parses them directly"
  - "SSE endpoint deleted without deprecation period — polling client ships atomically in Plan 03"
  - "HandleUploadNiosBackup is a standalone function (not on ScanHandler) since it needs no orchestrator/store"
  - "Polling log suppression filter changed from /events suffix to /status suffix"
  - "Per-provider progress in ScanStatusResponse.Providers is empty slice for Phase 9; Phase 10 populates it"
  - "NIOS backup parsing uses streaming XML token decoder (not DOM) to handle large onedb.xml files"
  - "NIOS credential step uses early-return branch based on provider.isFileUpload — keeps existing four provider flows unchanged"
  - "canGoNext credentials case updated: NIOS requires credentialStatus='valid' AND niosSelectedMembers.size>0 (upload + member selection both required)"
  - "handleNiosFileChange sets credentialStatus.nios='valid' on success — reuses existing Next button gate without special-casing"
  - "startScan NIOS subscriptions = Array.from(niosSelectedMembers); selectionMode fixed to 'include'"
  - "Phase 9 accepted as complete after human confirmed: NIOS card, file upload, member selection, polling, no regressions, no CDN requests"
patterns_established:
  - "Zero-network-request pattern: all fonts, icons, and assets either bundled or inline"
  - "Dual-location logos: src/assets/logos/ for Vite import, public/logos/ for URL-based access"
  - "Stub scanner pattern: nios.New() returns zero-value struct satisfying scanner.Scanner, Scan() returns empty slice"
  - "Role detection from onedb.xml: is_grid_master=true -> Master, is_candidate_master=true -> Candidate, else Regular"
  - "isFileUpload?: boolean on ProviderOption: opt-in flag enables file upload rendering path without structural change to wizard"
  - "Verification-only plan: Task 1 builds and starts, Task 2 is human-verify gate"
observability_surfaces: []
drill_down_paths: []
duration: 5min
verification_result: passed
completed_at: 2026-03-10
blocker_discovered: false
---
# S01: Frontend Extension Api Migration

**# Phase 9 Plan 01: Frontend Shell Cleanup + Asset Staging Summary**

## What Happened

# Phase 9 Plan 01: Frontend Shell Cleanup + Asset Staging Summary

**System font stack replacing Google Fonts CDN in fonts.css, version badge removed from App.tsx with page title and inline SVG favicon added, all 6 provider logos and NIOS performance CSV data staged from Figma export**

## Performance

- **Duration:** ~12 min
- **Started:** 2026-03-09T22:45:00Z
- **Completed:** 2026-03-09T22:57:00Z
- **Tasks:** 2
- **Files modified:** 19 (2 modified, 17 created)

## Accomplishments

- Eliminated all external network requests from frontend: no Google Fonts CDN, no /api/v1/version fetch
- Added NIOS Grid provider logo (nios-grid.svg) in both bundled and static-served locations, ready for Phase 11 provider card
- Staged performance-specs.csv and performance-metrics.csv into frontend/src/imports/ for Phase 11 XaaS panels
- Created frontend/public/ directory as Vite static root — provider logos now accessible at /logos/*.svg URLs at runtime

## Task Commits

Each task was committed atomically:

1. **Task 1: Replace App.tsx and fonts.css** - `5ba8155` (feat)
2. **Task 2: Copy Figma export assets into frontend** - `35d58b4` (feat)

**Plan metadata:** (docs commit follows)

## Files Created/Modified

- `frontend/src/app/App.tsx` - Removed VersionInfo, version fetch, version footer; set document.title; added inline SVG favicon
- `frontend/src/styles/fonts.css` - Replaced Google Fonts @import with system font stack comment + body rule
- `frontend/src/assets/logos/*.svg` - 6 provider logos (aws, azure, gcp, infoblox, microsoft, nios-grid) for Vite bundling
- `frontend/public/logos/*.svg` - Same 6 logos as static assets served by Vite dev server and Go embed.FS at /logos/
- `frontend/src/assets/*.png` - 3 PNG image assets from Figma Make export
- `frontend/src/imports/performance-specs.csv` - NIOS Grid form factor performance spec table
- `frontend/src/imports/performance-metrics.csv` - NIOS Grid XaaS capacity metrics table

## Decisions Made

- `document.title` assigned at module level (not in useEffect) since the title never changes — simpler and slightly faster
- Inline SVG favicon encoded as `data:image/svg+xml` URI — no favicon.ico file needed, no external request
- `frontend/public/` directory created as Vite's static root so logos are accessible via URL path without bundling (needed for `<img src="/logos/aws.svg">` patterns in Phase 11)
- CSV files copied verbatim from Figma export; Phase 11 will parse them with a CSV reader

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- App shell is clean: no version endpoint dependency, no CDN dependency — ready for NIOS provider card addition in 09-02
- All logos present in both locations — Phase 11 provider card and branding panels can reference them immediately
- CSV performance data staged — Phase 11 Server Token Calculator and XaaS Consolidation panels can import them
- No blockers

## Self-Check: PASSED

All created files exist on disk. Both task commits verified in git log.

---
*Phase: 09-frontend-extension-api-migration*
*Completed: 2026-03-09*

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

# Phase 09 Plan 03: API Client SSE-to-Polling Migration Summary

**One-liner:** Frontend SSE client replaced with polling — getScanStatus + uploadNiosBackup added to api-client.ts, useScanPolling hook added to use-backend.ts, wizard.tsx migrated from startScanEvents to useScanPolling.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Migrate api-client.ts — remove SSE, add polling types and functions | cec00a0 | frontend/src/app/components/api-client.ts |
| 2 | Add useScanPolling hook to use-backend.ts | 9501ee9 | frontend/src/app/components/use-backend.ts, frontend/src/app/components/wizard.tsx |

## What Was Built

### api-client.ts changes (merge strategy)

**Removed (SSE section):**
- `ScanEventType` type union
- `ScanEvent` interface
- `startScanEvents()` function

**Added (Scan Status polling section):**
- `ProviderScanStatus` interface (provider, progress 0-100, status string, itemsFound)
- `ScanStatusResponse` interface (scanId, status 'running'|'complete', progress, providers array)
- `getScanStatus(scanId)` — GET `/api/v1/scan/{scanId}/status`, throws on non-ok

**Added (NIOS section):**
- `NiosGridMember` interface (hostname, role)
- `NiosUploadResponse` interface (valid, error?, gridName?, niosVersion?, members)
- `uploadNiosBackup(file)` — POST `/api/v1/providers/nios/upload` as multipart/form-data

All pre-existing exports preserved: setBaseUrl, getBaseUrl, checkHealth, validateCredentials, getSessionId, cloneSession, startScan, getScanResults.

### use-backend.ts changes

Added below the existing `useBackendConnection` hook:
- `ScanPollingCallbacks` interface (onStatus, onComplete, onError)
- `useScanPolling(scanId, callbacks)` hook using setInterval at 1500ms
  - Uses `useRef` for callbacks — stable reference without restarting effect
  - `stopped` flag prevents state updates after interval is cleared
  - Clears interval and calls `onComplete()` when `status === 'complete'`
  - Cleans up on unmount or scanId change

### wizard.tsx fix (deviation)

wizard.tsx imported `startScanEvents` which no longer exists — TypeScript compilation failed. Auto-fixed under Rule 1 (bug caused by current task's changes):
- Updated import: removed `startScanEvents`, added `useScanPolling` from use-backend
- Replaced the 60-line SSE `useEffect` block with `useScanPolling` hook call
- Per-provider progress now comes from `ScanStatusResponse.providers` array (populated in Phase 10)
- onComplete fetches final results via `apiGetScanResults` (same as SSE scan_complete handler)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed TypeScript compilation failure caused by removed SSE import in wizard.tsx**
- **Found during:** Task 2 verification (npx tsc --noEmit)
- **Issue:** wizard.tsx imported `startScanEvents` from api-client.ts; removing it caused TS2305 error
- **Fix:** Updated wizard.tsx imports (remove startScanEvents, add useScanPolling from use-backend); replaced SSE useEffect block with useScanPolling hook call using polling response shape
- **Files modified:** frontend/src/app/components/wizard.tsx
- **Commit:** 9501ee9

## Verification

- `grep -c "startScanEvents" api-client.ts` → 0 (SSE fully removed)
- `grep "getScanStatus|uploadNiosBackup" api-client.ts` → both functions present
- `grep "useScanPolling" use-backend.ts` → hook exported
- `npx tsc --noEmit` → exits 0, no errors

## Self-Check: PASSED

Files exist:
- frontend/src/app/components/api-client.ts — FOUND
- frontend/src/app/components/use-backend.ts — FOUND
- frontend/src/app/components/wizard.tsx — FOUND

Commits exist:
- cec00a0 — feat(09-03): migrate api-client.ts from SSE to polling
- 9501ee9 — feat(09-03): add useScanPolling hook to use-backend.ts; fix wizard.tsx

# Phase 9 Plan 04: Frontend NIOS Integration Summary

**NIOS provider card + backup upload flow + Grid Member checkbox selection wired into the wizard with polling scan progress, extending all four existing provider flows without regression.**

## Performance

- **Duration:** 12 min
- **Started:** 2026-03-10T00:00:00Z
- **Completed:** 2026-03-10T00:12:00Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments

- Extended `ProviderType` union with `'nios'` and `ProviderOption` interface with `isFileUpload?: boolean`; added NIOS entry to `PROVIDERS` array
- Added NIOS Step 2 UI: file dropzone with four upload states (idle/uploading/done/error), Grid Member checkbox list with Select All/Deselect All, and role badges (Master/Candidate/Member)
- All existing AWS, Azure, GCP, AD credential forms unchanged; NIOS uses early-return branch before standard credential card rendering
- `useScanPolling` already present from Plan 03; no SSE code remains in wizard.tsx

## Task Commits

1. **Task 1: Extend mock-data.ts with NIOS provider definition** - `2d5ffb3` (feat)
2. **Task 2: Update wizard.tsx — NIOS card, upload flow, member selection, polling** - `6aae4ee` (feat)

## Files Created/Modified

- `frontend/src/app/components/mock-data.ts` — ProviderType extended with 'nios'; ProviderOption gets isFileUpload?: boolean; PROVIDERS array gets NIOS entry; MOCK_SUBSCRIPTIONS and generateMockFindings data object get nios key
- `frontend/src/app/components/wizard.tsx` — All ProviderType-keyed useState initializers extended with nios; NIOS state slots added; handleNiosFileChange handler; early-return NIOS UI in credentials map; canGoNext credentials case updated; startScan extended with niosSelectedMembers; restart() and rescan() reset nios state

## Decisions Made

- NIOS credential step uses early-return branch based on `provider.isFileUpload` — keeps the existing four provider flows completely unchanged and avoids deep nesting
- `handleNiosFileChange` sets `credentialStatus.nios = 'valid'` on successful upload — reuses the existing Next button gate without special-casing the NIOS provider
- `canGoNext` credentials case: NIOS requires both `credentialStatus['nios'] === 'valid'` AND `niosSelectedMembers.size > 0` — upload success alone is insufficient if all members are deselected

## Deviations from Plan

None — plan executed exactly as written. The `useScanPolling` call was already present from Plan 03 (the SSE block was removed during that execution as noted in STATE.md decisions), so the "replace SSE useEffect" step was already done. The demo-mode guard (`backend.isDemo ? '' : scanId`) was also already in place. No additional work was required.

## Issues Encountered

None — TypeScript compiled without errors on first attempt; build passed immediately.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- Phase 9 frontend changes are complete: App.tsx, fonts.css, assets (Plan 01), api-client.ts + use-backend.ts (Plans 02/03), and wizard.tsx + mock-data.ts (Plan 04)
- Phase 10 (NIOS Backend Scanner) can now implement `POST /api/v1/providers/nios/upload` and `GET /api/v1/scan/{scanId}/status` with per-member DDI counts — frontend is ready to consume both endpoints
- The `niosSelectedMembers` array is passed as `subscriptions` in the scan request; Phase 10 backend reads them to filter which Grid Members to scan

---
*Phase: 09-frontend-extension-api-migration*
*Completed: 2026-03-10*

# Phase 9 Plan 05: Human Verification Summary

**Human-verified end-to-end acceptance of Phase 9: NIOS card, backup upload, member selection, polling scan progress, and zero regressions in AWS/Azure/GCP/AD flows**

## Performance

- **Duration:** ~5 min
- **Started:** 2026-03-10T08:00:00Z
- **Completed:** 2026-03-10T08:05:00Z
- **Tasks:** 2
- **Files modified:** 0 (verification only)

## Accomplishments

- Frontend built successfully (pnpm build exits 0)
- Go binary starts and serves the application at 127.0.0.1:{port}
- Human confirmed all Phase 9 checklist items passed:
  - Page title "Infoblox Universal DDI Token Assessment" correct
  - Zero requests to fonts.googleapis.com in Network tab
  - NIOS Grid Backup card visible as 5th provider in Step 1
  - File upload dropzone appears when NIOS selected in Step 2
  - Member list with checkboxes, hostname, and role badges renders after upload
  - Select All / Deselect All toggle functional
  - Next button correctly gated on member selection
  - AWS credential form unchanged (no regression)
  - Polling requests to /api/v1/scan/{id}/status appear every ~1.5s; no SSE requests
  - No version badge in footer

## Task Commits

Each task was committed atomically:

1. **Task 1: Build and start the application for verification** - `281222a` (chore)
2. **Task 2: Human verification approved** - `3f851f0` (chore)

**Plan metadata:** _(recorded in final docs commit)_

## Files Created/Modified

None — this plan was verification-only.

## Decisions Made

None — followed plan as specified. Human approval granted without issues.

## Deviations from Plan

None — plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

Phase 9 is complete and human-verified. Phase 10 (NIOS Backend Scanner) can begin:
- POST /api/v1/providers/nios/upload stub is live and returns NiosUploadResponse
- Polling endpoint GET /api/v1/scan/{scanId}/status is live
- wizard.tsx NIOS branch is in place and expects niosServerMetrics in scan results
- Phase 10 implements the actual onedb.xml parsing from tar.gz/.tgz/.bak archives

---
*Phase: 09-frontend-extension-api-migration*
*Completed: 2026-03-10*
