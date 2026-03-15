# S06: DNS Record Type Breakdown

**Goal:** All three cloud scanners (AWS Route53, Azure DNS, GCP Cloud DNS) emit per-type DNS record FindingRows (`dns_record_a`, `dns_record_aaaa`, `dns_record_cname`, etc.) instead of a single generic `dns_record` row — with a shared `SupportedDNSTypes` set in `cloudutil/dns.go`.
**Demo:** `go test ./internal/... -count=1` passes; AWS/Azure/GCP tests verify per-type DNS items; no `dns_record` (generic) items remain in scanner output.

## Must-Haves

- `internal/cloudutil/dns.go` exports `SupportedDNSTypes` (13-type set) and `RecordTypeItem(rrtype string) string` (returns `dns_record_a` etc., `dns_record_other` for unknown)
- AWS `countAllRecordSets` replaced with `countAllRecordSetsByType` returning `map[string]int`
- `scanRoute53` emits one `FindingRow` per record type (zero-count rows omitted)
- Azure `countDNS` returns `(zones int, typeCounts map[string]int, err error)` with type extracted from `RecordSet.Type` suffix
- GCP `countDNS` returns `(zoneCount int, typeCounts map[string]int, err error)` using `ResourceRecordSet.Type` directly
- All compile-time signature assertions updated in azure/gcp test files
- AWS route53 expanded test updated — no more `dns_record` in item names
- `cloudutil/dns_test.go` covers `SupportedDNSTypes` membership and `RecordTypeItem` formatting
- Item naming uses lowercase with underscore (`dns_record_a`, not `dns_record_A`) matching NIOS convention

## Verification

- `go test ./internal/cloudutil/... -v -count=1` — dns.go tests pass (SupportedDNSTypes + RecordTypeItem)
- `go test ./internal/scanner/aws/... -v -count=1` — route53 tests pass with per-type items
- `go test ./internal/scanner/azure/... -v -count=1` — countDNS signature assertion compiles; scanner test passes
- `go test ./internal/scanner/gcp/... -v -count=1` — countDNS signature assertion compiles; scanner test passes
- `go test ./... -count=1` — full suite passes (no regressions)
- `go vet ./...` — no issues
- `go test -run TestRoute53ExpandedScanners_GlobalWiring ./internal/scanner/aws/... -v -count=1` — error-path test passes (verifies graceful degradation with no credentials)

## Tasks

- [x] **T01: Shared DNS types helper + AWS Route53 per-type breakdown** `est:30m`
  - Why: Establishes the shared `SupportedDNSTypes` set (eliminates triplication across bluecat/efficientip/cloudutil) and the `RecordTypeItem` naming helper, then applies per-type counting to the simplest scanner (AWS) to prove the pattern.
  - Files: `internal/cloudutil/dns.go`, `internal/cloudutil/dns_test.go`, `internal/scanner/aws/route53.go`, `internal/scanner/aws/route53_expanded_test.go`
  - Do: (1) Create `dns.go` with `SupportedDNSTypes` map (13 types from bluecat) and `RecordTypeItem(rrtype)` that lowercases and prefixes with `dns_record_`. (2) Add `dns_test.go` testing all 13 supported types, unknown→`dns_record_other`, case normalization. (3) Replace `countAllRecordSets` with `countAllRecordSetsByType` returning `map[string]int` keyed by RRType string. (4) Update `scanRoute53` to loop over per-type map emitting one FindingRow per type, keeping dns_zone unchanged. (5) Update `route53_expanded_test.go` item name list — remove `dns_record`, verify `dns_zone` still present.
  - Verify: `go test ./internal/cloudutil/... -v -count=1 && go test ./internal/scanner/aws/... -v -count=1`
  - Done when: `countAllRecordSetsByType` compiles and is called by `scanRoute53`; per-type FindingRows emitted; all AWS tests pass

- [x] **T02: Azure + GCP per-type DNS breakdown + test updates** `est:30m`
  - Why: Applies the same per-type pattern to Azure and GCP scanners, completing the slice. Both scanners have a `countDNS` function with `(int, int, error)` signature that must change to `(int, map[string]int, error)`, and both have compile-time assertions in tests that must be updated.
  - Files: `internal/scanner/azure/scanner.go`, `internal/scanner/azure/scanner_test.go`, `internal/scanner/gcp/dns.go`, `internal/scanner/gcp/scanner.go`, `internal/scanner/gcp/scanner_test.go`
  - Do: (1) Azure: update `countDNS` to accumulate `map[string]int` per type — extract type via `path.Base(*rs.Type)` for public DNS, same for private DNS; nil-check `Type` field, classify nil as `"UNKNOWN"`. (2) Update `scanSubscription` call site to loop over typeCounts map emitting per-type FindingRows (skip zero-count). (3) GCP: update `countDNS` to accumulate `map[string]int` using `ResourceRecordSet.Type` directly (already uppercase). (4) Update `scanOneProject` DNS block to loop over typeCounts map emitting per-type FindingRows. (5) Update compile-time assertions in both test files to `(int, map[string]int, error)`.
  - Verify: `go test ./internal/scanner/azure/... -v -count=1 && go test ./internal/scanner/gcp/... -v -count=1 && go test ./... -count=1`
  - Done when: Both scanners emit per-type DNS FindingRows; all compile-time assertions pass; full test suite green

## Observability / Diagnostics

- **Per-type `resource_progress` events:** Each scanner emits one `resource_progress` event per DNS record type (e.g., `dns_record_a`, `dns_record_cname`) with individual counts. A single aggregate `resource_progress` event for `"dns_record"` with the total count is also emitted for backward-compatible progress reporting.
- **Error visibility:** If `countAllRecordSetsByType` (AWS), `countDNS` (Azure/GCP) fails, the scanner publishes a `resource_progress` event with `Status: "error"` and the error message — same pattern as before, unchanged.
- **Zero-count suppression:** Record types with zero count are silently omitted from FindingRows. This is inspectable by checking the returned findings slice length.
- **`RecordTypeItem` determinism:** The helper is a pure function — given any non-empty string it returns `"dns_record_" + lowercase(input)`, given empty string returns `"dns_record_other"`. No runtime state, no failure mode.
- **Failure-path test:** `TestRoute53ExpandedScanners_GlobalWiring` exercises the error path (no-credentials config) and verifies graceful degradation — health_check and traffic_policy rows still appear even when DNS API calls error.

## Files Likely Touched

- `internal/cloudutil/dns.go` (new)
- `internal/cloudutil/dns_test.go` (new)
- `internal/scanner/aws/route53.go`
- `internal/scanner/aws/route53_expanded_test.go`
- `internal/scanner/azure/scanner.go`
- `internal/scanner/azure/scanner_test.go`
- `internal/scanner/gcp/dns.go`
- `internal/scanner/gcp/scanner.go`
- `internal/scanner/gcp/scanner_test.go`
