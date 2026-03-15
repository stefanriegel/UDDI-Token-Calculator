# T02: 09-frontend-extension-api-migration 02

**Slice:** S01 — **Milestone:** M002

## Description

Add two new Go backend endpoints (polling status + NIOS backup upload), delete the SSE events endpoint, add the ProviderNIOS constant and a stub NIOS scanner, and update the server router accordingly.

Purpose: Unblocks the frontend polling migration (Plan 03) and the wizard NIOS flow (Plan 04). The SSE endpoint is deleted clean — no deprecation — because the frontend will switch to polling in Plan 03 atomically within this phase.
Output: server/scan.go with two new handlers (no SSE handler), updated server/types.go, updated server/server.go router, new internal/scanner/nios/scanner.go stub, ProviderNIOS constant, updated main.go.

## Must-Haves

- [ ] "GET /api/v1/scan/{scanId}/status returns JSON with progress 0–100 per provider while scan is running"
- [ ] "GET /api/v1/scan/{scanId}/status returns status=complete once the scan finishes"
- [ ] "GET /api/v1/scan/{scanId}/events route no longer exists (deleted)"
- [ ] "POST /api/v1/providers/nios/upload accepts .tar.gz, .tgz, and .bak files up to 500MB and returns { valid, gridName, niosVersion, members[] }"
- [ ] "ProviderNIOS = 'nios' constant is declared in internal/scanner/provider.go"
- [ ] "NIOS stub scanner is registered in the orchestrator map in main.go"
- [ ] "Go tests pass after SSE handler removal"

## Files

- `internal/scanner/provider.go`
- `server/scan.go`
- `server/server.go`
- `server/types.go`
- `server/scan_test.go`
- `internal/scanner/nios/scanner.go`
