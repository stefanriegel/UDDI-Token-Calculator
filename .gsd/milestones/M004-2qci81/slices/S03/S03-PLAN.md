# S03: Azure Parallel Multi-Subscription + Expanded Resources

**Goal:** Azure scanning fans out across all tenant subscriptions in parallel with configurable concurrency and covers 7 additional resource types matching the cloud-object-counter crosswalk.
**Demo:** A multi-subscription Azure tenant scan completes with `subscription_progress` events per subscription, results include public IPs, NAT gateways, firewalls, private endpoints, route tables, LB frontend IPs, and VNet gateway IPs alongside existing resource types.

## Must-Haves

- `Scan()` fans out `scanSubscription()` calls concurrently using `cloudutil.Semaphore` (default 5, configurable via `req.MaxWorkers`)
- Per-subscription `subscription_progress` events (scanning/complete/error) matching AWS `account_progress` pattern
- Per-subscription failure is non-fatal — warning event published, other subscriptions continue
- Same `azcore.TokenCredential` reused across all subscriptions (no per-subscription credential exchange)
- 7 new resource count functions: `countPublicIPs`, `countNATGateways`, `countAzureFirewalls`, `countPrivateEndpoints`, `countRouteTables`, LB frontend IP extraction from existing `countLBsAndGateways`, `countVNetGatewayIPs` with per-RG iteration
- Each new resource type emits correct `resource_progress` events and `FindingRow` with proper token category
- VNet gateway RG iteration uses RG names extracted from VNet resource IDs (no `armresources` dependency)
- All existing Azure tests pass; new tests cover fan-out behavior and expanded resource signatures

## Proof Level

- This slice proves: integration (parallel fan-out with semaphore) + contract (new resource scanner signatures and categories)
- Real runtime required: no (Azure SDK mocked via interface patterns / compile-time assertions)
- Human/UAT required: no

## Verification

- `go test ./internal/scanner/azure/... -v -count=1` — all pass including new fan-out and expanded resource tests
- `go test ./... -count=1` — all packages pass (excluding pre-existing `frontend/dist` embed error)
- `go vet ./internal/scanner/azure/...` — clean

## Observability / Diagnostics

- Runtime signals: `scanner.Event{Type: "subscription_progress"}` with Status scanning/complete/error per subscription
- Inspection surfaces: `subscription_progress` events visible in scan status polling response
- Failure visibility: per-subscription errors include subscription ID + display name + error in event Message
- Redaction constraints: none (no secrets in subscription IDs/names)

## Integration Closure

- Upstream surfaces consumed: `cloudutil.Semaphore` (S01), `cloudutil.NewSemaphore()` + `Acquire`/`Release` pattern, `scanner.ScanRequest.MaxWorkers`
- New wiring introduced in this slice: `scanAllSubscriptions()` method in Azure scanner, 7 new count functions wired into `scanSubscription()`
- What remains before the milestone is truly usable end-to-end: S07 frontend for Azure subscription discovery UI, S06 for DNS record type breakdown

## Tasks

- [x] **T01: Multi-subscription parallel fan-out with subscription_progress events** `est:45m`
  - Why: Converts sequential subscription loop to parallel fan-out — delivers R041, R042, R043 for Azure
  - Files: `internal/scanner/azure/scanner.go`, `internal/scanner/azure/scanner_test.go`
  - Do: Extract `scanAllSubscriptions()` method following AWS `scanOrg()` pattern — `Semaphore` + `WaitGroup` + `mu.Lock()` for result aggregation. Default concurrency 5 via `maxConcurrentSubscriptions` const. Emit `subscription_progress` events (scanning/complete/error). Per-subscription failures publish warning and continue. Move subscription display-name resolution inside goroutine or keep shared map. Update `Scan()` to call `scanAllSubscriptions()` always (single sub is just parallelism=1). Add test for fan-out: mock `scanSubscription` indirectly by testing the goroutine dispatch + result aggregation + error tolerance pattern.
  - Verify: `go test ./internal/scanner/azure/... -v -count=1` passes; `go vet ./internal/scanner/azure/...` clean
  - Done when: `Scan()` dispatches subscriptions through semaphore, emits per-subscription progress events, and tolerates per-subscription failures

- [x] **T02: 7 expanded resource scanners wired into scanSubscription** `est:45m`
  - Why: Delivers R048 expanded resource coverage for Azure — matches cloud-object-counter crosswalk
  - Files: `internal/scanner/azure/scanner.go`, `internal/scanner/azure/scanner_test.go`
  - Do: Add 5 new standalone count functions (`countPublicIPs`, `countNATGateways`, `countAzureFirewalls`, `countPrivateEndpoints`, `countRouteTables`) using `NewListAllPager`/`NewListBySubscriptionPager`. Refactor `countLBsAndGateways` → return `(lbs, gateways, lbFrontendIPs, error)` counting `FrontendIPConfigurations`. Add `countVNetGatewayIPs(ctx, cred, subID, vnetFindings)` that extracts unique RG names from VNet IDs via `resourceGroupFromID`, lists VNet gateways per-RG, counts gateway objects + their IP configurations. Wire all into `scanSubscription()` with FindingRow emission + resource_progress events using correct token categories (DDI Objects: public IPs, route tables; Active IPs: LB frontend IPs, VNet gateway IPs; Managed Assets: NAT gateways, firewalls, private endpoints, VNet gateways). Update test file: compile-time signature assertions for new functions, test for VNet gateway RG extraction logic.
  - Verify: `go test ./internal/scanner/azure/... -v -count=1` passes; `go test ./... -count=1` passes; `go vet ./internal/scanner/azure/...` clean
  - Done when: `scanSubscription()` emits 7 new resource types with correct categories, VNet gateway per-RG iteration uses RG names from VNet IDs, all tests pass

## Files Likely Touched

- `internal/scanner/azure/scanner.go`
- `internal/scanner/azure/scanner_test.go`
