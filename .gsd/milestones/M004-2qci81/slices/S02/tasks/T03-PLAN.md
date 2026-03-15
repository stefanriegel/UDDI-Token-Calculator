---
estimated_steps: 6
estimated_files: 4
---

# T03: Expanded Route53 scanners (health checks, traffic policies, resolver endpoints) + slice verification

**Slice:** S02 — AWS Multi-Account Org Scanning + Expanded Resources
**Milestone:** M004-2qci81

## Description

Add the remaining 3 expanded resource types: Route53 Health Checks, Route53 Traffic Policies (both global, added to `scanRoute53()`), and Route53 Resolver Endpoints (regional, separate `route53resolver` SDK service, added to `scanRegion()`). Then run full slice verification to confirm no regressions.

Route53 Resolver is a separate AWS service from Route53 — it requires its own SDK package (`github.com/aws/aws-sdk-go-v2/service/route53resolver`) and has regional endpoints (unlike Route53 which is global). Resolver may not be available in all regions — handle gracefully.

## Steps

1. Add `route53resolver` SDK dependency: `go get github.com/aws/aws-sdk-go-v2/service/route53resolver`
2. Add `scanRoute53HealthChecks` to `route53.go` — use `route53.NewListHealthChecksPaginator`, count `len(page.HealthChecks)`. Wire into `scanRoute53()` with `runResourceScan` pattern (item: `route53_health_check`, category: DDI Objects, 25 tokens/unit).
3. Add `scanRoute53TrafficPolicies` to `route53.go` — use `route53.NewListTrafficPoliciesPaginator` (or manual pagination with `TrafficPolicyIdMarker`), count `len(page.TrafficPolicySummaries)`. Wire into `scanRoute53()` with same category. Note: ListTrafficPolicies may not have a built-in paginator — check SDK and implement manual pagination if needed.
4. Add `scanResolverEndpoints` to `route53.go` (or a new `resolver.go` if cleaner) — use `route53resolver.NewFromConfig(cfg)` + `ListResolverEndpoints`. This is a regional service, so wire into `scanRegion()` in `regions.go` (not `scanRoute53`). Handle "not available in this region" errors gracefully (return 0). Item: `resolver_endpoint`, category: DDI Objects, 25 tokens/unit.
5. Write `route53_expanded_test.go` — test the 3 new scan functions with mocked interfaces. Verify correct item names and categories.
6. Run full slice verification: `go test ./... -count=1` for regression check, `go vet ./...` for static analysis. Confirm all S02 work compiles and tests pass together.

## Must-Haves

- [ ] `scanRoute53HealthChecks` counts health checks via paginator, wired into `scanRoute53()`
- [ ] `scanRoute53TrafficPolicies` counts traffic policies, wired into `scanRoute53()`
- [ ] `scanResolverEndpoints` counts resolver endpoints (regional), wired into `scanRegion()`
- [ ] Resolver endpoint scanner handles "not available" regions gracefully (returns 0)
- [ ] All use DDI Objects category with 25 tokens-per-unit
- [ ] `route53resolver` SDK dependency added to go.mod
- [ ] Full `go test ./... -count=1` passes with no regressions
- [ ] `go vet` clean on all modified packages

## Verification

- `go test ./internal/scanner/aws/... -v -count=1` — all tests pass including new Route53 expanded tests
- `go test ./... -count=1` — full suite passes (pre-existing `frontend/dist` embed excluded)
- `go vet ./internal/scanner/aws/... ./server/... ./internal/session/... ./internal/orchestrator/...` — clean

## Inputs

- `internal/scanner/aws/route53.go` — existing `scanRoute53()`, `listHostedZones()`, `countAllRecordSets()` as pattern
- `internal/scanner/aws/regions.go` — `scanRegion()` for wiring resolver endpoints
- T01 and T02 completed — org fan-out and EC2 expanded scanners already in place
- `go.mod` — may already have route53resolver if added transitively; verify before adding

## Expected Output

- `internal/scanner/aws/route53.go` — 2 new global scan functions added, wired into `scanRoute53()`
- `internal/scanner/aws/regions.go` — resolver endpoint wired into `scanRegion()`
- `internal/scanner/aws/route53_expanded_test.go` — tests for 3 new Route53 resource types
- `go.mod` / `go.sum` — `route53resolver` SDK dependency added

## Observability Impact

- **New `resource_progress` events:** 3 additional resource types emit events during scanning:
  - `route53_health_check` (global, from `scanRoute53()`)
  - `route53_traffic_policy` (global, from `scanRoute53()`)
  - `resolver_endpoint` (regional, from `scanRegion()` — one per region)
- **Inspection:** Grep SSE stream for `resource_progress` events — total distinct `Resource` values per region increases from 14 to 15 (resolver_endpoint added); global resources increase from 2 to 4 (health checks + traffic policies)
- **Failure visibility:** Resolver endpoint `resource_progress` events with `Status: "error"` in unsupported regions emit the error message; `Status: "done"` with `Count: 0` means the region has no resolver endpoints or the service returned a graceful not-available response
- **Traffic policy pagination:** Uses manual IsTruncated/marker pagination (no SDK paginator) — a bug here would show as truncated counts, visible by comparing against AWS console
