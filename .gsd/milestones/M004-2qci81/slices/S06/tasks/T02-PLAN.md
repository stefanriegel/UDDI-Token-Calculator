---
estimated_steps: 5
estimated_files: 5
---

# T02: Azure + GCP per-type DNS breakdown + test updates

**Slice:** S06 — DNS Record Type Breakdown
**Milestone:** M004-2qci81

## Description

Apply the per-type DNS counting pattern (established in T01) to Azure and GCP scanners. Both have a `countDNS` function with signature `(int, int, error)` that changes to `(int, map[string]int, error)`. Both have compile-time signature assertions in test files that must be updated. The Azure scanner requires extracting the record type from the `RecordSet.Type` field suffix (e.g., `"Microsoft.Network/dnsZones/A"` → `"A"`). GCP's `ResourceRecordSet.Type` is already a plain uppercase string.

## Steps

1. **Azure `countDNS` update** (`internal/scanner/azure/scanner.go`): Change return signature from `(zones, records int, err error)` to `(zones int, typeCounts map[string]int, err error)`. Initialize `typeCounts = make(map[string]int)`. For each public DNS `RecordSet`: nil-check `rs.Type`, extract type suffix via the last `/` separator (e.g., `"Microsoft.Network/dnsZones/A"` → `"A"`), increment `typeCounts[extracted]++`. Same for private DNS records (`"Microsoft.Network/privateDnsZones/A"` → `"A"`). If `rs.Type` is nil, use `"UNKNOWN"`.
2. **Azure call site update** (`internal/scanner/azure/scanner.go`): In `scanSubscription`, replace the `zoneCount, recordCount, err := countDNS(...)` call. Keep zone handling identical. Replace the single `dns_record` FindingRow emission with a loop over `typeCounts`: for each `(rrtype, count)` where `count > 0`, emit a FindingRow with `Item: cloudutil.RecordTypeItem(rrtype)`. Publish one aggregate `resource_progress` event with sum of all type counts for backward-compatible progress reporting. Import `cloudutil` package.
3. **GCP `countDNS` update** (`internal/scanner/gcp/dns.go`): Change return signature from `(zoneCount, recordCount int, err error)` to `(zoneCount int, typeCounts map[string]int, err error)`. Initialize `typeCounts = make(map[string]int)`. In the record set enumeration loop, replace `recordCount += len(page.Rrsets)` with a range over `page.Rrsets` incrementing `typeCounts[rrset.Type]++`.
4. **GCP call site update** (`internal/scanner/gcp/scanner.go`): In `scanOneProject`'s DNS block, replace `zoneCount, recordCount, dnsErr := countDNS(...)` with `zoneCount, typeCounts, dnsErr := countDNS(...)`. Keep zone FindingRow emission unchanged. Replace single `dns_record` FindingRow with a loop over `typeCounts`: for each `(rrtype, count)` where `count > 0`, emit a FindingRow with `Item: cloudutil.RecordTypeItem(rrtype)`. Publish one aggregate event for backward-compatible progress. Import `cloudutil` package.
5. **Test updates**: (a) `internal/scanner/azure/scanner_test.go`: change compile-time assertion for `countDNS` from `(int, int, error)` to `(int, map[string]int, error)`. (b) `internal/scanner/gcp/scanner_test.go`: change compile-time assertion for `countDNS` from `(int, int, error)` to `(int, map[string]int, error)`.

## Must-Haves

- [ ] Azure `countDNS` returns `(int, map[string]int, error)` with per-type counts
- [ ] Azure type extraction handles both public (`dnsZones/A`) and private (`privateDnsZones/A`) format
- [ ] Azure nil `RecordSet.Type` classified as `"UNKNOWN"` (not panic)
- [ ] GCP `countDNS` returns `(int, map[string]int, error)` with per-type counts
- [ ] Both scanners emit per-type FindingRows using `cloudutil.RecordTypeItem`
- [ ] Zero-count record types are not emitted
- [ ] Compile-time signature assertions updated and compiling
- [ ] Full test suite passes — no regressions

## Verification

- `go test ./internal/scanner/azure/... -v -count=1` — passes (signature assertion + scanner tests)
- `go test ./internal/scanner/gcp/... -v -count=1` — passes (signature assertion + scanner tests)
- `go test ./... -count=1` — full suite green
- `go vet ./...` — no issues

## Inputs

- `internal/cloudutil/dns.go` — `RecordTypeItem` helper from T01
- `internal/scanner/azure/scanner.go:673` — current `countDNS` with `(int, int, error)` signature
- `internal/scanner/gcp/dns.go:18` — current `countDNS` with `(int, int, error)` signature
- `internal/scanner/gcp/scanner.go:212` — DNS block in `scanOneProject`

## Expected Output

- `internal/scanner/azure/scanner.go` — per-type DNS counting and FindingRow emission
- `internal/scanner/azure/scanner_test.go` — updated compile-time assertion
- `internal/scanner/gcp/dns.go` — per-type DNS counting
- `internal/scanner/gcp/scanner.go` — per-type FindingRow emission
- `internal/scanner/gcp/scanner_test.go` — updated compile-time assertion

## Observability Impact

- **Azure `resource_progress` events:** The `dns_record` event now reports an aggregate total (sum of all type counts) — same shape, backward-compatible. No per-type events are emitted (only per-type FindingRows).
- **GCP `resource_progress` events:** Same as Azure — aggregate total in a single `dns_record` event, unchanged shape.
- **FindingRow items:** Both scanners now emit per-type items (e.g. `dns_record_a`, `dns_record_cname`) instead of a single `dns_record`. Inspect `FindingRow.Item` values to verify per-type breakdown.
- **Azure type extraction:** The `extractAzureDNSType` helper logs no errors — nil `RecordSet.Type` silently maps to `"UNKNOWN"` (producing `dns_record_unknown` via RecordTypeItem).
- **Error paths unchanged:** On `countDNS` failure, the error `resource_progress` event is emitted with `Status: "error"` exactly as before. No DNS FindingRows are produced on error (Azure) or only partial data is emitted (GCP, where per-zone errors are non-fatal).
- **Failure inspection:** Compile-time signature assertions in test files ensure `countDNS` signatures stay correct — a signature drift causes a build failure, not a runtime error.
