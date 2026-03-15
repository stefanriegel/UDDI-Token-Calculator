---
estimated_steps: 5
estimated_files: 6
---

# T02: Thread MaxWorkers/RequestTimeout through scan pipeline and wire Semaphore into AWS

**Slice:** S01 — Retry/Backoff Infrastructure + Configurable Scan Parameters
**Milestone:** M004-2qci81

## Description

Add `MaxWorkers` and `RequestTimeout` fields to the scan request chain (frontend → HTTP handler → orchestrator → scanner) so downstream slices can configure concurrency and timeouts from the API. Replace the raw buffered channel in AWS `scanAllRegions` with the `cloudutil.Semaphore` to prove the extraction works in production code.

## Steps

1. Add fields to `scanner.ScanRequest` (`internal/scanner/provider.go`):
   - `MaxWorkers int` — max concurrent workers (0 = use provider default)
   - `RequestTimeout int` — per-request timeout in seconds (0 = use provider default, 30s)
   - Add doc comments explaining the zero-means-default semantics

2. Add fields to `orchestrator.ScanProviderRequest` (`internal/orchestrator/orchestrator.go`):
   - `MaxWorkers int` and `RequestTimeout int` with same semantics
   - Update `buildScanRequest()` to copy `p.MaxWorkers` and `p.RequestTimeout` into the `scanner.ScanRequest`

3. Add fields to `server.ScanProviderSpec` (`server/types.go`):
   - `MaxWorkers int \`json:"maxWorkers,omitempty"\`` 
   - `RequestTimeout int \`json:"requestTimeout,omitempty"\``
   - Update `toOrchestratorProviders()` in `server/scan.go` to copy `s.MaxWorkers` and `s.RequestTimeout` into the `orchestrator.ScanProviderRequest`

4. Update AWS `scanAllRegions` (`internal/scanner/aws/regions.go`):
   - Import `cloudutil` package
   - Change `scanAllRegions` signature to accept a `maxWorkers int` parameter
   - If `maxWorkers <= 0`, use `maxConcurrentRegions` (5) as default
   - Replace `sem := make(chan struct{}, maxConcurrentRegions)` with `sem := cloudutil.NewSemaphore(maxWorkers)`
   - Replace `select { case sem <- struct{}{}: ... }` with `if err := sem.Acquire(ctx); err != nil { return }`
   - Replace `defer func() { <-sem }()` with `defer sem.Release()`
   - Update caller in `aws/scanner.go` to pass `req.MaxWorkers` to `scanAllRegions`

5. Add `maxWorkers?` and `requestTimeout?` to frontend `ScanRequest` type (`frontend/src/app/components/api-client.ts`):
   - `maxWorkers?: number;`
   - `requestTimeout?: number;`
   - These are optional — the frontend doesn't send them yet (S07 will add UI controls), but the type is ready

## Must-Haves

- [ ] `ScanRequest.MaxWorkers` and `ScanRequest.RequestTimeout` added with doc comments
- [ ] `ScanProviderRequest.MaxWorkers` and `ScanProviderRequest.RequestTimeout` added
- [ ] `ScanProviderSpec` JSON fields use `omitempty` for backward compatibility
- [ ] `toOrchestratorProviders()` copies both new fields
- [ ] `buildScanRequest()` copies both new fields
- [ ] AWS `scanAllRegions` uses `cloudutil.Semaphore` instead of raw channel
- [ ] `maxWorkers=0` defaults to `maxConcurrentRegions` (5) — no panic
- [ ] Frontend `ScanRequest` type includes optional fields
- [ ] All existing tests pass with no regressions

## Verification

- `go test ./... -count=1` — full test suite passes
- `cd frontend && npx tsc --noEmit` — frontend compiles with new fields
- `go vet ./...` — no vet warnings

## Observability Impact

- Signals added/changed: `MaxWorkers` and `RequestTimeout` are now visible in the `ScanRequest` struct — downstream scanners can log these values when starting a scan
- How a future agent inspects this: grep for `MaxWorkers` or `RequestTimeout` in scan request construction
- Failure state exposed: `MaxWorkers=0` silently defaults rather than panicking — this is the expected behavior

## Inputs

- `internal/cloudutil/semaphore.go` — `NewSemaphore`, `Acquire`, `Release` from T01
- `internal/scanner/provider.go` — existing `ScanRequest` struct
- `internal/orchestrator/orchestrator.go` — existing `ScanProviderRequest` and `buildScanRequest()`
- `server/types.go` — existing `ScanProviderSpec`
- `server/scan.go` — existing `toOrchestratorProviders()`
- `internal/scanner/aws/regions.go` — existing `scanAllRegions` with raw channel semaphore
- `frontend/src/app/components/api-client.ts` — existing `ScanRequest` type

## Expected Output

- `internal/scanner/provider.go` — `ScanRequest` with `MaxWorkers` and `RequestTimeout` fields
- `internal/orchestrator/orchestrator.go` — `ScanProviderRequest` with new fields; `buildScanRequest()` copies them
- `server/types.go` — `ScanProviderSpec` with JSON-tagged fields
- `server/scan.go` — `toOrchestratorProviders()` copies new fields
- `internal/scanner/aws/regions.go` — uses `cloudutil.Semaphore`; accepts `maxWorkers` param
- `frontend/src/app/components/api-client.ts` — `ScanRequest` with optional `maxWorkers` and `requestTimeout`
