---
estimated_steps: 5
estimated_files: 4
---

# T01: Shared DNS types helper + AWS Route53 per-type breakdown

**Slice:** S06 — DNS Record Type Breakdown
**Milestone:** M004-2qci81

## Description

Create the shared `internal/cloudutil/dns.go` with the canonical `SupportedDNSTypes` set (13 types currently duplicated in bluecat and efficientip) and a `RecordTypeItem` helper for consistent item naming. Then apply per-type DNS counting to AWS Route53 — the simplest of the three cloud scanners since `countAllRecordSets` is a standalone function with no signature consumers outside `scanRoute53`.

## Steps

1. Create `internal/cloudutil/dns.go` exporting:
   - `SupportedDNSTypes map[string]struct{}` with the 13 types: A, AAAA, CNAME, MX, TXT, CAA, SRV, SVCB, HTTPS, PTR, NS, SOA, NAPTR
   - `RecordTypeItem(rrtype string) string` that returns `"dns_record_" + strings.ToLower(rrtype)` — or `"dns_record_other"` when rrtype is empty
2. Create `internal/cloudutil/dns_test.go` testing:
   - All 13 supported types produce correct lowercase items (e.g., `RecordTypeItem("A")` → `"dns_record_a"`)
   - Unknown type (e.g., `"DS"`) maps to `"dns_record_ds"` (still valid item, just not in SupportedDNSTypes)
   - Empty string → `"dns_record_other"`
   - `SupportedDNSTypes` has exactly 13 entries
3. In `internal/scanner/aws/route53.go`: replace `countAllRecordSets(ctx, cfg, zoneIDs) (int, error)` with `countAllRecordSetsByType(ctx, cfg, zoneIDs) (map[string]int, error)`. Loop structure stays the same — accumulate `counts[string(rrs.Type)]++` instead of `total += len(page.ResourceRecordSets)`. Return `map[string]int{}` (not nil) on empty.
4. Update `scanRoute53` DNS record block: call `countAllRecordSetsByType`, then range over the returned map emitting one FindingRow per type using `cloudutil.RecordTypeItem(rrtype)` as the item name. Skip zero-count entries. Publish one aggregate `resource_progress` event for `"dns_record"` with total count (sum of map values) for backward-compatible progress reporting. Keep `dns_zone` block unchanged.
5. Update `internal/scanner/aws/route53_expanded_test.go`: remove `"dns_record"` from `existingItems` slice in `TestRoute53ExpandedScanners_NewItemNames`. The `wantItems` map in `TestRoute53ExpandedScanners_GlobalWiring` only checks for `route53_health_check` and `route53_traffic_policy` — no change needed there since dns items are checked separately.

## Must-Haves

- [ ] `SupportedDNSTypes` has exactly 13 entries matching bluecat/efficientip
- [ ] `RecordTypeItem` produces lowercase `dns_record_*` names
- [ ] `countAllRecordSetsByType` replaces `countAllRecordSets` — old function removed
- [ ] `scanRoute53` emits per-type FindingRows (not one aggregate `dns_record`)
- [ ] Zero-count record types are not emitted as FindingRows
- [ ] All AWS tests pass

## Verification

- `go test ./internal/cloudutil/... -v -count=1` — dns_test.go passes
- `go test ./internal/scanner/aws/... -v -count=1` — all existing + new tests pass
- `go vet ./internal/cloudutil/ ./internal/scanner/aws/` — no issues

## Inputs

- `internal/scanner/bluecat/scanner.go:27` — source of truth for 13 supported DNS types
- `internal/scanner/aws/route53.go` — current `countAllRecordSets` and `scanRoute53`
- `internal/scanner/aws/route53_expanded_test.go` — existing test assertions to update

## Expected Output

- `internal/cloudutil/dns.go` — shared DNS type set + item naming helper
- `internal/cloudutil/dns_test.go` — test coverage for dns.go
- `internal/scanner/aws/route53.go` — per-type counting and FindingRow emission
- `internal/scanner/aws/route53_expanded_test.go` — updated item name assertions

## Observability Impact

- **Signal change:** `scanRoute53` previously emitted one `FindingRow` with `Item: "dns_record"` and one `resource_progress` event for `"dns_record"`. After this task, it emits N FindingRows (one per non-zero record type, e.g., `dns_record_a`, `dns_record_cname`) plus one aggregate `resource_progress` event for `"dns_record"` with total count (backward compat).
- **Inspection:** A future agent can verify per-type breakdown by checking the `Item` field of FindingRows returned by `scanRoute53` — each should match `dns_record_<lowercase_type>`.
- **Failure visibility:** Error path unchanged — a `resource_progress` event with `Status: "error"` is emitted if the API call fails, and no DNS FindingRows are produced. `TestRoute53ExpandedScanners_GlobalWiring` validates this graceful degradation.
