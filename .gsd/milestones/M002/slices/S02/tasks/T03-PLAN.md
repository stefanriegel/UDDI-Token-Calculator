# T03: 10-nios-backend-scanner 03

**Slice:** S02 — **Milestone:** M002

## Description

Wire the production NIOS scanner: replace the stub Scan() with two-pass streaming XML parse, fix the upload handler (PROPERTY element parsing + temp file write + service roles), store selectedMembers, and propagate NiosServerMetrics through session and orchestrator.

Purpose: This is the core implementation wave — all five scanner unit tests should turn GREEN after this plan.
Output: Real scanner.go, fixed server/scan.go, updated server/types.go, session.go and orchestrator.go.

## Must-Haves

- [ ] "NIOS scanner reads backup_path from Credentials, streams gzip+tar, two-pass parses onedb.xml using PROPERTY elements (not VALUE elements)"
- [ ] "Grid-level DDI objects are attributed to the GM member; per-member Active IPs via vnode_id"
- [ ] "Scanner implements NiosResultScanner interface — GetNiosServerMetricsJSON() returns JSON-encoded per-member metrics"
- [ ] "HandleUploadNiosBackup writes temp file to os.TempDir(), stores path in niosBackupTokens sync.Map keyed by a UUID token, returns service-based roles (GM/DNS/DHCP not Master/Candidate/Regular)"
- [ ] "HandleStartScan resolves BackupToken from ScanProviderSpec via niosBackupTokens, stores path as Credentials[backup_path], stores selectedMembers as Credentials[selected_members]"
- [ ] "Orchestrator type-asserts NIOS scanner result to NiosResultScanner, stores NiosServerMetricsJSON in session"
- [ ] "Temp file is deleted after scan completes via defer in Scan()"

## Files

- `internal/scanner/nios/scanner.go`
- `server/scan.go`
- `server/types.go`
- `internal/session/session.go`
- `internal/orchestrator/orchestrator.go`
