---
id: T01
parent: S06
milestone: M004-2qci81
provides:
  - shared SupportedDNSTypes set (13 types) in cloudutil/dns.go
  - RecordTypeItem helper for canonical dns_record_* item naming
  - AWS Route53 per-type DNS record counting and FindingRow emission
key_files:
  - internal/cloudutil/dns.go
  - internal/cloudutil/dns_test.go
  - internal/scanner/aws/route53.go
  - internal/scanner/aws/route53_expanded_test.go
key_decisions:
  - RecordTypeItem returns dns_record_other for empty input, but unknown non-empty types still produce dns_record_<lowercase> (not "other") — keeps the helper simple and forward-compatible
patterns_established:
  - Per-type DNS counting pattern: countByType returns map[string]int, caller ranges over it emitting one FindingRow per non-zero type using cloudutil.RecordTypeItem
  - Backward-compatible aggregate resource_progress event with total count for "dns_record"
observability_surfaces:
  - resource_progress events per aggregate dns_record (total count, backward compat)
  - Per-type FindingRows with item names like dns_record_a, dns_record_cname inspectable in scan output
  - Error-path: resource_progress event with Status "error" when API call fails
duration: 12m
verification_result: passed
completed_at: 2026-03-15
blocker_discovered: false
---

# T01: Shared DNS types helper + AWS Route53 per-type breakdown

**Created `cloudutil/dns.go` with canonical 13-type `SupportedDNSTypes` set and `RecordTypeItem` helper; replaced AWS `countAllRecordSets` with `countAllRecordSetsByType` returning `map[string]int`; `scanRoute53` now emits per-type FindingRows.**

## What Happened

1. Created `internal/cloudutil/dns.go` exporting `SupportedDNSTypes` (13-entry map matching bluecat/efficientip) and `RecordTypeItem(rrtype string) string` that returns `"dns_record_" + strings.ToLower(rrtype)` or `"dns_record_other"` for empty input.
2. Created `internal/cloudutil/dns_test.go` with tests for all 13 supported types, unknown type passthrough, empty→other, and exact count assertion.
3. Replaced `countAllRecordSets(ctx, cfg, zoneIDs) (int, error)` with `countAllRecordSetsByType(ctx, cfg, zoneIDs) (map[string]int, error)` — accumulates `counts[string(rrs.Type)]++` per record set.
4. Updated `scanRoute53` DNS record block: calls `countAllRecordSetsByType`, ranges over map emitting one FindingRow per non-zero type using `cloudutil.RecordTypeItem(rrtype)`. Publishes one aggregate `resource_progress` event for `"dns_record"` with total count for backward compatibility.
5. Removed `"dns_record"` from `existingItems` in `TestRoute53ExpandedScanners_NewItemNames` since the generic item no longer exists.

## Verification

- `go test ./internal/cloudutil/... -v -count=1` — all 18 tests pass (5 dns + 13 existing)
- `go test ./internal/scanner/aws/... -v -count=1` — all 18 tests pass including GlobalWiring error-path test
- `go vet ./internal/cloudutil/ ./internal/scanner/aws/` — no issues
- `go test ./internal/... -count=1` — all internal packages pass (14 packages ok)
- `go test -run TestRoute53ExpandedScanners_GlobalWiring ./internal/scanner/aws/... -v -count=1` — error-path test passes

### Slice-level verification status (T01 of 2):
- ✅ `go test ./internal/cloudutil/... -v -count=1` — passes
- ✅ `go test ./internal/scanner/aws/... -v -count=1` — passes
- ⏳ `go test ./internal/scanner/azure/... -v -count=1` — T02 scope
- ⏳ `go test ./internal/scanner/gcp/... -v -count=1` — T02 scope
- ✅ `go test ./internal/... -count=1` — passes (all internal)
- ✅ `go vet ./internal/...` — passes
- ✅ Error-path test (GlobalWiring) — passes

## Diagnostics

- Inspect per-type DNS items by checking `FindingRow.Item` values from `scanRoute53` — each matches `dns_record_<lowercase_type>`.
- The aggregate `resource_progress` event for `"dns_record"` reports total count across all types.
- On API error, a `resource_progress` event with `Status: "error"` is emitted and no DNS FindingRows are produced.

## Deviations

None.

## Known Issues

- Pre-existing: `go test ./...` root package fails due to missing `frontend/dist` embed directory — unrelated to this slice.

## Files Created/Modified

- `internal/cloudutil/dns.go` — new: shared SupportedDNSTypes set (13 types) and RecordTypeItem helper
- `internal/cloudutil/dns_test.go` — new: test coverage for SupportedDNSTypes membership, RecordTypeItem formatting
- `internal/scanner/aws/route53.go` — replaced countAllRecordSets with countAllRecordSetsByType; updated scanRoute53 to emit per-type FindingRows
- `internal/scanner/aws/route53_expanded_test.go` — removed "dns_record" from existingItems in TestRoute53ExpandedScanners_NewItemNames
- `.gsd/milestones/M004-2qci81/slices/S06/S06-PLAN.md` — added Observability / Diagnostics section and error-path verification step
- `.gsd/milestones/M004-2qci81/slices/S06/tasks/T01-PLAN.md` — added Observability Impact section
