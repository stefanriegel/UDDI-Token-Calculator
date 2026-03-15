# S01: Retry/Backoff Infrastructure + Configurable Scan Parameters — Research

**Date:** 2026-03-15

## Summary

S01 delivers three foundational capabilities: (1) a generic retry/backoff wrapper in a new `internal/cloudutil` package, (2) a configurable concurrency semaphore, and (3) new `MaxWorkers`/`RequestTimeout` fields threaded from the frontend API through the HTTP handler → orchestrator → scanner interface. All six downstream slices (S02–S07) depend on these primitives.

The codebase already has two independent retry/backoff implementations — `bluecat/scanner.go` `doRequest()` and `efficientip/scanner.go` `doWithRetry()` — both handling 429 + 500/502/503/504 with exponential backoff and `Retry-After` header parsing. AWS uses the SDK's built-in adaptive retry (5 attempts). Azure and GCP SDK clients have their own internal retry pipelines. The gap is: there's no shared retry wrapper for non-SDK HTTP calls or for wrapping arbitrary `func() error` calls (needed for org-level fan-out pacing in S02–S04), and there's no way to configure concurrency limits or timeouts from the API or UI.

The primary recommendation is to build `internal/cloudutil/retry.go` with a generic `CallWithBackoff[T](ctx, fn, opts)` that replaces the duplicated patterns, and `internal/cloudutil/semaphore.go` as a thin wrapper around a buffered channel (matching the existing `maxConcurrentRegions` pattern in `aws/regions.go`). Then thread `MaxWorkers` and `RequestTimeout` through `scanner.ScanRequest`, `orchestrator.ScanProviderRequest`, `server.ScanProviderSpec`, and the frontend `ScanRequest` type. Bluecat and EfficientIP can optionally be refactored to use the shared retry — but that's a nice-to-have in S01 scope, not required.

## Recommendation

**Approach:** Build two small, focused utilities in `internal/cloudutil/` and thread two new fields through the scan request chain.

1. **`retry.go`** — Generic `CallWithBackoff[T any](ctx context.Context, fn func() (T, error), opts BackoffOptions) (T, error)` with configurable max retries (default 3), base delay (default 1s), max delay (default 30s), full jitter, retryable-error classifier (default: HTTP 429 + 500/502/503/504), and `Retry-After` header respect. Emits a `scanner.Event{Type: "retry"}` via optional publish callback so the frontend can show retry progress.

2. **`semaphore.go`** — `Semaphore` struct wrapping a buffered `chan struct{}` with `Acquire(ctx)` / `Release()`. Replace the raw `sem := make(chan struct{}, maxConcurrentRegions)` in `aws/regions.go` with this. S02–S04 use it for account/subscription/project fan-out.

3. **Field threading** — Add `MaxWorkers int` and `RequestTimeout int` (seconds) to `scanner.ScanRequest`, `orchestrator.ScanProviderRequest`, `server.ScanProviderSpec`, and the frontend `ScanRequest` type. Provide sensible defaults (MaxWorkers=5 for AWS, 10 for Azure, 10 for GCP; RequestTimeout=30s). The orchestrator passes these through to each scanner via `buildScanRequest()`.

**Why this approach:** It's the minimum viable infrastructure that unblocks all six downstream slices without over-engineering. The generics-based `CallWithBackoff[T]` avoids interface{} boxing and is type-safe at call sites. The semaphore is just the existing pattern extracted. The field threading is mechanical but necessary — every downstream slice needs these parameters.

## Don't Hand-Roll

| Problem | Existing Solution | Why Use It |
|---------|------------------|------------|
| AWS API retry/throttle | AWS SDK v2 adaptive retry mode | Already configured (`RetryModeAdaptive`, 5 attempts); don't add custom retry on top of SDK calls |
| Azure API retry/throttle | azcore pipeline retry policy | Built into every ARM client; handles 429 + Retry-After natively |
| GCP API retry | google-api-go-client transport retry | Built into `option.WithHTTPClient`; handles 429/503 internally |
| Jitter algorithm | `math/rand` + formula | Use `crypto/rand` or `math/rand/v2` for jitter (Go 1.25 has `math/rand/v2`) |

## Existing Code and Patterns

- `internal/scanner/bluecat/scanner.go:69-109` — `doRequest()` retry loop with exponential backoff, `Retry-After` parsing, retryStatuses map. **Duplication target** — can migrate to shared `CallWithBackoff` but not required in S01.
- `internal/scanner/efficientip/scanner.go:252-288` — `doWithRetry()` nearly identical pattern. **Second duplication target.**
- `internal/scanner/aws/regions.go:14` — `maxConcurrentRegions = 5` hardcoded const + buffered channel semaphore pattern (lines 47-81). **The exact pattern to extract into `cloudutil/semaphore.go`.**
- `internal/scanner/aws/scanner.go:89-91` — AWS SDK retry config (`RetryModeAdaptive`, 5 attempts). **Don't add additional retry on top of this.**
- `internal/scanner/provider.go:26-46` — `ScanRequest` struct where `MaxWorkers` and `RequestTimeout` fields will be added.
- `internal/orchestrator/orchestrator.go:22-38` — `ScanProviderRequest` struct where `MaxWorkers` and `RequestTimeout` fields will be added.
- `server/types.go:23-33` — `ScanProviderSpec` struct where `maxWorkers` and `requestTimeout` JSON fields will be added.
- `server/scan.go:505-533` — `toOrchestratorProviders()` where new fields get copied through.
- `internal/orchestrator/orchestrator.go:205-312` — `buildScanRequest()` where new fields get threaded into `scanner.ScanRequest`.
- `frontend/src/app/components/api-client.ts:186-196` — Frontend `ScanRequest` type where `maxWorkers?` and `requestTimeout?` fields will be added.
- `internal/scanner/gcp/scanner.go:89-107` — `wrapGCPError()` extracts HTTP status from `googleapi.Error`. **Useful pattern for building a retryable-error classifier for GCP.**
- `internal/broker/broker.go:11-19` — `broker.Event` with Type/Provider/Resource/Message fields. Retry events will flow through this same mechanism.

## Constraints

- **CGO_ENABLED=0 mandatory** — no cgo-dependent rate-limit libraries (e.g., no `go-rate` variants that use cgo). All retry/semaphore code must be pure Go.
- **Go 1.25.6** — can use generics (`CallWithBackoff[T]`), `math/rand/v2`, and all modern stdlib features.
- **SDK retry layers already present** — AWS (adaptive, 5 attempts), Azure (azcore pipeline), GCP (transport retry). The shared `CallWithBackoff` is for wrapping non-SDK HTTP calls and for fan-out pacing, NOT for double-retrying SDK calls.
- **`scanner.Scanner` interface must remain backward compatible** — Scan() signature doesn't change. New fields are on `ScanRequest` (additive).
- **`ScanProviderSpec` JSON tags must be backward compatible** — use `omitempty` on new fields so old clients that don't send them still work.
- **Default values needed** — MaxWorkers=0 means "use provider default" (AWS=5, Azure=10, GCP=10). RequestTimeout=0 means "use provider default" (30s).
- **Existing tests must pass** — no regressions in NIOS, AD, Bluecat, EfficientIP, or cloud provider test suites.

## Common Pitfalls

- **Double-retrying SDK calls** — If we wrap AWS SDK calls in `CallWithBackoff`, they'll retry 5×3=15 times (SDK retry × our retry). Only wrap non-SDK calls and fan-out orchestration. The cloud provider SDKs already handle 429/5xx internally.
- **No jitter = thundering herd** — Pure exponential backoff without jitter causes all concurrent goroutines to retry at the same instant, making throttling worse. Must use full jitter: `sleep = random(0, min(max_delay, base * 2^attempt))`.
- **Blocking on `time.Sleep` ignores context cancellation** — Must use `select` with `time.After` and `ctx.Done()` so cancelled scans don't hang in backoff sleep.
- **`Retry-After` header can be a date, not just seconds** — The EfficientIP `parseRetryAfter` only handles integer seconds. AWS/Azure/GCP SDKs handle dates internally, so this is only a concern for non-SDK HTTP calls (Bluecat, EfficientIP). For S01, integer-seconds parsing is sufficient.
- **MaxWorkers=0 must not panic** — `make(chan struct{}, 0)` creates an unbuffered channel, which would deadlock. Default to provider-specific value when 0.
- **Semaphore must respect context** — `Acquire()` must use `select { case sem <- struct{}{}: case <-ctx.Done(): }` exactly like the existing AWS pattern.

## Open Risks

- **Retry event visibility in frontend** — S01 publishes `scanner.Event{Type: "retry"}` events but the frontend polling endpoint doesn't surface individual events — it only returns progress percentages. Retry events will be visible in the broker's SSE stream (not currently consumed by the frontend) and useful for debugging. Frontend retry visibility may need work in S07.
- **Azure ARM cross-subscription rate coordination** — Azure's per-principal throttle bucket (250 tokens, 25/sec refill) means a global semaphore across subscriptions is needed, not per-subscription. The shared `Semaphore` supports this, but the coordination point is in S03 scope, not S01. S01 just provides the primitive.
- **Bluecat/EfficientIP migration is optional** — Refactoring existing `doRequest`/`doWithRetry` to use the shared `CallWithBackoff` is clean-up work. It's safe to defer to avoid scope creep — those scanners already work and their retry logic is tested.
- **Scanner.Event type extensions** — Adding `Type: "retry"` is a new event type. The frontend ignores unknown event types (it only reacts to `resource_progress`, `provider_start`, `provider_complete`, `error`, `scan_complete`), so this is safe. But downstream slices may want more retry metadata (attempt number, backoff delay) — the Event struct may need extension later.

## Skills Discovered

| Technology | Skill | Status |
|------------|-------|--------|
| Go retry/backoff | bobmatnyc/claude-mpm-skills@golang-http-frameworks | available but not relevant (HTTP frameworks, not retry) |
| Go resilience patterns | yonatangross/orchestkit@resilience-patterns | available but low installs (17), pattern is simple enough to implement directly |
| Go concurrency | none found | standard library `chan`/`sync` sufficient |

## Sources

- Bluecat doRequest retry pattern (source: `internal/scanner/bluecat/scanner.go:69-109`)
- EfficientIP doWithRetry pattern (source: `internal/scanner/efficientip/scanner.go:252-288`)
- AWS semaphore pattern (source: `internal/scanner/aws/regions.go:47-81`)
- AWS SDK adaptive retry (source: `internal/scanner/aws/scanner.go:89-91`)
- cloud-object-counter `_call_with_backoff` reference (source: M004 context doc)
- GCP error wrapping pattern (source: `internal/scanner/gcp/scanner.go:89-107`)

## Requirements Coverage

| Requirement | This Slice Role | Key Insight |
|-------------|----------------|-------------|
| R043 — Retry with exponential backoff | **Primary owner** | Generic `CallWithBackoff[T]` with jitter, 429+5xx classification, `Retry-After` respect. Cloud SDKs already retry internally — this wraps non-SDK calls and fan-out orchestration. |
| R046 — Configurable concurrency limits | **Primary owner** | `MaxWorkers` field threaded from API → orchestrator → scanner. `Semaphore` primitive with context-aware acquire. Provider defaults: AWS=5, Azure=10, GCP=10. |
| R047 — Configurable request timeouts | **Primary owner** | `RequestTimeout` field threaded identically. Provider default: 30s. Applied as `http.Client.Timeout` or `context.WithTimeout` at call sites in downstream slices. |
| R040 — AWS multi-account org scanning | Supporting | Retry + concurrency infrastructure used by S02's org fan-out |
| R041 — Azure multi-subscription scanning | Supporting | Retry + concurrency infrastructure used by S03's subscription fan-out |
| R042 — GCP multi-project scanning | Supporting | Retry + concurrency infrastructure used by S04's project fan-out |
| R044 — Checkpoint/resume | Supporting | Checkpoint wraps around the retry-aware scan loop (S05 scope) |
