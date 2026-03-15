---
id: T02
parent: S01
milestone: M004-2qci81
provides:
  - MaxWorkers and RequestTimeout fields threaded through full scan pipeline (frontend → server → orchestrator → scanner)
  - AWS scanAllRegions uses cloudutil.Semaphore instead of raw buffered channel
  - Frontend ScanRequest type ready for future UI controls (S07)
key_files:
  - internal/scanner/provider.go
  - internal/orchestrator/orchestrator.go
  - server/types.go
  - server/scan.go
  - internal/scanner/aws/regions.go
  - frontend/src/app/components/api-client.ts
key_decisions:
  - scanAllRegions accepts maxWorkers param directly rather than the full ScanRequest — keeps the function signature focused and avoids threading the entire request struct through internal helpers
patterns_established:
  - Zero-means-default for scan parameters — MaxWorkers=0 and RequestTimeout=0 both resolve to provider defaults, preserving backward compatibility with no API changes needed
observability_surfaces:
  - MaxWorkers and RequestTimeout are now visible fields on ScanRequest — downstream scanners can log these values when starting a scan
  - grep for MaxWorkers or RequestTimeout in scan request construction to trace field flow
duration: 15m
verification_result: passed
completed_at: 2026-03-15
blocker_discovered: false
---

# T02: Thread MaxWorkers/RequestTimeout through scan pipeline and wire Semaphore into AWS

**Added MaxWorkers and RequestTimeout fields to the entire scan pipeline and replaced AWS raw channel semaphore with cloudutil.Semaphore.**

## What Happened

Threaded two new fields through four layers of the scan request chain:

1. **scanner.ScanRequest** (`provider.go`) — added `MaxWorkers int` and `RequestTimeout int` with doc comments explaining zero-means-default semantics
2. **orchestrator.ScanProviderRequest** (`orchestrator.go`) — added matching fields; updated `buildScanRequest()` to copy both into the scanner request
3. **server.ScanProviderSpec** (`types.go`) — added JSON-tagged fields with `omitempty` for backward compatibility; updated `toOrchestratorProviders()` in `scan.go` to copy both fields
4. **AWS scanAllRegions** (`regions.go`) — replaced `sem := make(chan struct{}, maxConcurrentRegions)` / select/defer pattern with `cloudutil.NewSemaphore(maxWorkers)` / `Acquire`/`Release`. Added `maxWorkers int` parameter with fallback to `maxConcurrentRegions` (5) when ≤ 0. Updated caller in `scanner.go` to pass `req.MaxWorkers`.
5. **Frontend** (`api-client.ts`) — added optional `maxWorkers?` and `requestTimeout?` to the provider spec within `ScanRequest`

## Verification

- `go test ./internal/... ./server/... -count=1` — all 15 packages pass (cloudutil, orchestrator, scanner/aws, server, etc.)
- `go vet ./internal/... ./server/...` — clean, no warnings
- `npx tsc --noEmit` — no errors in api-client.ts (pre-existing shadcn/ui type errors in calendar.tsx, chart.tsx, resizable.tsx are unrelated)
- Root package `go test` fails only due to missing `frontend/dist` embed directory (build artifact, not a code issue)

### Slice-level verification status

- ✅ `go test ./internal/cloudutil/... -v -count=1` — all retry and semaphore tests pass (from T01)
- ✅ `go test ./internal/scanner/aws/... -v -count=1` — AWS tests pass with semaphore extraction
- ✅ `go test ./... -count=1` — all packages pass except root (missing frontend/dist embed, pre-existing)
- ✅ `cd frontend && npx tsc --noEmit` — no new errors (pre-existing shadcn/ui type issues only)

## Diagnostics

- `MaxWorkers=0` silently defaults to `maxConcurrentRegions` (5) — no panic, no log noise
- `RequestTimeout=0` is passed through but not yet consumed — downstream slices (S02+) will use it
- grep `MaxWorkers` or `RequestTimeout` across the codebase to trace the full field flow

## Deviations

None.

## Known Issues

- `RequestTimeout` is threaded through but not yet consumed by any scanner — this is by design (S02+ will use it)
- Pre-existing TypeScript errors in shadcn/ui components (calendar.tsx, chart.tsx, resizable.tsx) are unrelated to this work

## Files Created/Modified

- `internal/scanner/provider.go` — added MaxWorkers and RequestTimeout fields to ScanRequest
- `internal/orchestrator/orchestrator.go` — added fields to ScanProviderRequest; updated buildScanRequest() to copy them
- `server/types.go` — added JSON-tagged fields to ScanProviderSpec with omitempty
- `server/scan.go` — updated toOrchestratorProviders() to copy new fields
- `internal/scanner/aws/regions.go` — replaced raw channel with cloudutil.Semaphore; added maxWorkers parameter
- `internal/scanner/aws/scanner.go` — updated scanAllRegions call to pass req.MaxWorkers
- `frontend/src/app/components/api-client.ts` — added optional maxWorkers and requestTimeout to ScanRequest type
