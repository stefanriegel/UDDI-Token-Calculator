---
id: T03
parent: S02
milestone: M002
provides:
  - Real two-pass streaming Scan() in internal/scanner/nios/scanner.go replacing Phase 9 stub
  - NiosResultScanner interface in internal/scanner/provider.go (canonical definition, no import cycle)
  - Fixed server/scan.go: PROPERTY-element XML parsing, temp file upload, niosBackupTokens sync.Map, service roles
  - Fixed server/types.go: ScanProviderSpec.BackupToken, NiosUploadResponse.BackupToken, ScanResultsResponse.NiosServerMetrics
  - Session.NiosServerMetricsJSON []byte field + SetNiosServerMetricsJSON() method
  - [object Object]
requires: []
affects: []
key_files: []
key_decisions: []
patterns_established: []
observability_surfaces: []
drill_down_paths: []
duration: 35min
verification_result: passed
completed_at: 2026-03-10
blocker_discovered: false
---
# T03: 10-nios-backend-scanner 03

**# Phase 10 Plan 03: NIOS Backend Scanner Wire-Up Summary**

## What Happened

# Phase 10 Plan 03: NIOS Backend Scanner Wire-Up Summary

**Two-pass gzip+tar+XML streaming scanner with PROPERTY-element parsing, upload token handoff via sync.Map, and NiosServerMetrics propagation through session and orchestrator**

## Performance

- **Duration:** ~35 min
- **Started:** 2026-03-10T00:15:00Z
- **Completed:** 2026-03-10T00:50:00Z
- **Tasks:** 2 (Task 1 TDD GREEN, Task 2 integration)
- **Files modified:** 7

## Accomplishments
- Replaced stub Scan() with real two-pass streaming XML parser — all 5 scanner unit tests pass GREEN
- Fixed server/scan.go PROPERTY-element parsing (was looking for VALUE elements in wrong format) + service roles
- Wired upload token handoff: HandleUploadNiosBackup writes temp file, stores path in niosBackupTokens sync.Map, returns opaque token; HandleStartScan resolves via LoadAndDelete
- Propagated NiosServerMetricsJSON through Session → Orchestrator → ScanResultsResponse with zero import cycles

## Task Commits

Each task was committed atomically:

1. **Task 1: scanner.go — two-pass streaming Scan() + NiosResultScanner interface** - `033d606` (feat)
2. **Task 2: server/scan.go + types.go + session.go + orchestrator.go integration** - `47d35f3` (feat)

**Plan metadata:** (docs commit follows)

_Note: Task 1 was TDD — tests existed RED from Plan 10-01, implemented GREEN here_

## Files Created/Modified
- `internal/scanner/nios/scanner.go` - Real two-pass streaming Scan(), GetNiosServerMetricsJSON(), buildGlobalLeaseIPSet(), streamOnedbXML(), parseObjectStream()
- `internal/scanner/provider.go` - Added NiosResultScanner interface (canonical, import-cycle-safe)
- `internal/scanner/nios/roles.go` - Added ExportedExtractServiceRole() wrapper
- `server/scan.go` - Fixed parseOneDBXML (PROPERTY attrs), objectToMember (__type + service roles), HandleUploadNiosBackup (temp file + token), toOrchestratorProviders (NIOS token resolution), HandleScanResults (NiosServerMetrics field)
- `server/types.go` - ScanProviderSpec.BackupToken, NiosUploadResponse.BackupToken, ScanResultsResponse.NiosServerMetrics json.RawMessage
- `internal/session/session.go` - NiosServerMetricsJSON []byte field, SetNiosServerMetricsJSON() method
- `internal/orchestrator/orchestrator.go` - BackupPath/SelectedMembers on ScanProviderRequest, NIOS case in buildScanRequest, NiosResultScanner type-assert post-scan

## Decisions Made
- Active IPs category uses lease-only dedup set (globalLeaseIPSet) — not globalIPSet which includes fixed address, host address, and network/broadcast IPs. The test fixture confirmed: 3 active leases, total Active IPs must be <= 3.
- `defer os.Remove` is conditional: only removes files inside os.TempDir() to prevent accidental deletion of test fixtures during unit tests.
- DNS Zone FindingRow with `Item="DNS Zone"` is emitted in addition to the generic "NIOS Grid DDI Objects" row so tests can find it by Item name. Zone count is already included in gridDDI but the separate row makes it identifiable.
- `SetNiosServerMetricsJSON()` method on Session.go: the `mu` field is unexported so orchestrator.go cannot directly lock the session mutex. Added method encapsulates the lock.
- `ExportedExtractServiceRole()` wrapper: server/scan.go needs service roles from the nios package but cannot call unexported `extractServiceRole()`. Thin wrapper avoids moving the function or changing its visibility semantics.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Test fixture deleted between test runs by defer os.Remove**
- **Found during:** Task 1 (GREEN phase — TestNIOS_ActiveIPCounts failed after TestNIOS_DDIFamilyCounts passed)
- **Issue:** `defer os.Remove(backupPath)` deleted testdata/minimal.tar.gz after the first test ran it through Scan(), leaving no fixture for subsequent tests
- **Fix:** Conditional delete — only call os.Remove if backupPath is inside os.TempDir(). Test fixtures in testdata/ are preserved; production temp files in TempDir are still cleaned up
- **Files modified:** internal/scanner/nios/scanner.go
- **Verification:** All 5 tests pass sequentially without fixture regeneration between runs
- **Committed in:** 033d606 (Task 1 commit)

**2. [Rule 1 - Bug] Managed Assets loop iterated over vnodeMap keys (vnode_id strings) instead of values (hostnames)**
- **Found during:** Task 1 (TestNIOS_AssetCounts failed — 0 assets despite vnodeMap having 2 entries)
- **Issue:** `for hostname := range vnodeMap` iterates over keys ("101", "102" — vnode_id integers), not values (hostnames). selectedMembers filter then rejected them as not matching any known hostname.
- **Fix:** Changed to `for _, hostname := range vnodeMap`
- **Files modified:** internal/scanner/nios/scanner.go
- **Verification:** TestNIOS_AssetCounts passes; 2 managed asset rows emitted
- **Committed in:** 033d606 (Task 1 commit)

**3. [Rule 1 - Bug] Active IP deduplication: globalIPSet includes fixed/host/network IPs causing count > lease count**
- **Found during:** Task 1 (TestNIOS_Deduplication failed — total=7 but fixture has 3 unique active leases)
- **Issue:** The `result.globalIPSet` in countObjects() accumulates ALL IP types: active lease IPs (3), fixed address IP (1), host address IP (1), network+broadcast IPs (2). Emitting len(globalIPSet)=7 as Active IPs violated the dedup test constraint of <= 3.
- **Fix:** Added `buildGlobalLeaseIPSet()` that unions per-member leaseIPSet maps — only active lease IPs. Used this for the Active IPs FindingRow count.
- **Files modified:** internal/scanner/nios/scanner.go
- **Verification:** TestNIOS_Deduplication passes (total Active IPs = 3 <= 3)
- **Committed in:** 033d606 (Task 1 commit)

**4. [Rule 2 - Missing Critical] Added SetNiosServerMetricsJSON() method to session.go**
- **Found during:** Task 2 (orchestrator.go cannot access unexported sess.mu from outside package)
- **Issue:** Plan spec showed direct `sess.mu.Lock()` usage in orchestrator.go, but Session.mu is unexported — compile error
- **Fix:** Added `SetNiosServerMetricsJSON(data []byte)` method to Session that handles locking internally
- **Files modified:** internal/session/session.go, internal/orchestrator/orchestrator.go
- **Verification:** go build ./... succeeds
- **Committed in:** 47d35f3 (Task 2 commit)

**5. [Rule 2 - Missing Critical] Added ExportedExtractServiceRole() wrapper in roles.go**
- **Found during:** Task 2 (server/scan.go cannot call unexported extractServiceRole from nios package)
- **Issue:** Plan spec says "call extractServiceRole from the nios package" but it's unexported
- **Fix:** Added ExportedExtractServiceRole() thin wrapper in roles.go
- **Files modified:** internal/scanner/nios/roles.go, server/scan.go
- **Verification:** go build ./... succeeds; objectToMember returns GM/DNS/DHCP roles
- **Committed in:** 47d35f3 (Task 2 commit)

---

**Total deviations:** 5 auto-fixed (3 Rule 1 bugs, 2 Rule 2 missing critical)
**Impact on plan:** All auto-fixes necessary for correctness. No scope creep — all fixes directly required by plan's stated behavior.

## Issues Encountered
- Test fixture (testdata/minimal.tar.gz) was missing at start (empty testdata/ dir). Regenerated via TestGenerateMinimalFixture before running GREEN tests. This is expected — the fixture is gitignored.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- All 5 scanner unit tests pass GREEN
- go build ./... succeeds with zero errors
- server/... tests pass (scan_nios_test.go still SKIPped — resolved in Plan 04)
- NiosServerMetrics flows from scanner → orchestrator → session → results API
- Plan 10-04 can now implement: server integration tests for upload+scan flow, scan_nios_test.go SKIP removal

## Self-Check: PASSED
- All 7 key files exist on disk
- Commits 033d606 (Task 1) and 47d35f3 (Task 2) confirmed in git log

---
*Phase: 10-nios-backend-scanner*
*Completed: 2026-03-10*
