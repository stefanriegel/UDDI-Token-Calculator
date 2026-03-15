---
id: S06
parent: M004-2qci81
milestone: M004-2qci81
provides:
  - shared SupportedDNSTypes set (13 types) in cloudutil/dns.go
  - RecordTypeItem helper for canonical dns_record_* item naming
  - AWS Route53 per-type DNS record counting via countAllRecordSetsByType
  - Azure countDNS returns (int, map[string]int, error) with per-type counts
  - GCP countDNS returns (int, map[string]int, error) with per-type counts
  - extractAzureDNSType helper for Azure RecordSet.Type parsing
  - All three cloud scanners emit per-type FindingRows (dns_record_a, dns_record_cname, etc.)
requires:
  - slice: S01
    provides: CallWithBackoff retry infrastructure for DNS API calls
affects:
  - S07 (frontend will display per-type DNS items in results view)
key_files:
  - internal/cloudutil/dns.go
  - internal/cloudutil/dns_test.go
  - internal/scanner/aws/route53.go
  - internal/scanner/aws/route53_expanded_test.go
  - internal/scanner/azure/scanner.go
  - internal/scanner/azure/scanner_test.go
  - internal/scanner/gcp/dns.go
  - internal/scanner/gcp/scanner.go
  - internal/scanner/gcp/scanner_test.go
key_decisions:
  - Per-type DNS items use lowercase underscore naming (dns_record_a, dns_record_cname) matching NIOS convention
  - RecordTypeItem returns dns_record_other for empty rrtype — safety net for nil Azure Type field
  - SupportedDNSTypes extracted to cloudutil/dns.go — bluecat/efficientip can import later but S06 scope is cloud providers only
  - Azure extractAzureDNSType uses strings.LastIndex (not path.Base) for type extraction
  - Cloud scanners emit per-type FindingRows for all types (no supported/unsupported grouping unlike bluecat/efficientip)
  - Per-type DNS progress events publish one aggregate dns_record event for backward compatibility
patterns_established:
  - Per-type DNS counting pattern: countByType returns map[string]int, caller ranges over it emitting one FindingRow per non-zero type using cloudutil.RecordTypeItem
  - extractAzureDNSType helper centralizes Azure RecordSet.Type → plain type extraction
  - Backward-compatible aggregate resource_progress event alongside per-type FindingRows
observability_surfaces:
  - resource_progress event for aggregate dns_record with total count (backward-compatible)
  - Per-type FindingRows with items like dns_record_a, dns_record_cname inspectable in scan output
  - Error resource_progress events with Status "error" on countDNS failure (unchanged pattern)
  - Compile-time signature assertions catch countDNS drift at build time
drill_down_paths:
  - .gsd/milestones/M004-2qci81/slices/S06/tasks/T01-SUMMARY.md
  - .gsd/milestones/M004-2qci81/slices/S06/tasks/T02-SUMMARY.md
duration: 22m
verification_result: passed
completed_at: 2026-03-15
---

# S06: DNS Record Type Breakdown

**All three cloud scanners (AWS Route53, Azure DNS, GCP Cloud DNS) now emit per-type DNS record FindingRows (`dns_record_a`, `dns_record_aaaa`, `dns_record_cname`, etc.) with a shared 13-type `SupportedDNSTypes` set in `cloudutil/dns.go`.**

## What Happened

Created a shared DNS types package (`internal/cloudutil/dns.go`) that exports `SupportedDNSTypes` — a 13-entry map matching the canonical set from bluecat/efficientip — and `RecordTypeItem(rrtype string) string` which produces lowercase underscore-prefixed item names (`dns_record_a`, `dns_record_cname`, etc.) with `dns_record_other` as the fallback for empty input.

Applied per-type counting to all three cloud scanners:

**AWS (T01):** Replaced `countAllRecordSets` (flat total) with `countAllRecordSetsByType` returning `map[string]int` keyed by Route53 RRType. `scanRoute53` now ranges over the map emitting one FindingRow per non-zero type, plus one aggregate `resource_progress` event for backward-compatible progress reporting.

**Azure (T02):** Updated `countDNS` signature from `(int, int, error)` to `(int, map[string]int, error)`. Added `extractAzureDNSType` helper to parse the plain type from Azure's fully-qualified `RecordSet.Type` field (e.g., `"Microsoft.Network/dnsZones/A"` → `"A"`). Both public DNS and private DNS zones are handled identically.

**GCP (T02):** Updated `countDNS` signature to `(int, map[string]int, error)`. GCP's `ResourceRecordSet.Type` is already a plain uppercase string, so the loop simply increments `typeCounts[rrset.Type]++`.

All compile-time signature assertions in test files were updated to match the new `(int, map[string]int, error)` return type. The generic `dns_record` item no longer appears in any scanner output.

## Verification

- `go test ./internal/cloudutil/... -v -count=1` — 18/18 pass (5 dns + 13 existing)
- `go test ./internal/scanner/aws/... -v -count=1` — 18/18 pass (including GlobalWiring error-path)
- `go test ./internal/scanner/azure/... -v -count=1` — all pass (signature assertion + scanner tests)
- `go test ./internal/scanner/gcp/... -v -count=1` — 19/19 pass (signature assertions + scanner tests)
- `go test ./internal/... -count=1` — all 14 packages pass, no regressions
- `go vet ./internal/...` — clean
- `go test -run TestRoute53ExpandedScanners_GlobalWiring ./internal/scanner/aws/... -v -count=1` — error-path graceful degradation verified

## Requirements Advanced

- AWS-RES-01 — AWS scanner now produces per-type DNS record items instead of aggregate `dns_record`; all 19 resource types maintain correct token categories
- AZ-RES-01 — Azure scanner now produces per-type DNS record items alongside 14 resource types
- GCP-RES-01 — GCP scanner now produces per-type DNS record items alongside 13 resource types

## Requirements Validated

- none (per-type DNS breakdown is a sub-feature of existing resource scanning requirements; full validation awaits frontend display in S07)

## New Requirements Surfaced

- none

## Requirements Invalidated or Re-scoped

- none

## Deviations

- T02 used `strings.LastIndex` instead of `path.Base` for Azure type extraction (plan suggested `path.Base`). `strings.LastIndex` is more explicit and avoids importing the `path` package.

## Known Limitations

- Cloud scanners emit per-type DNS items for all types (including unsupported ones like DS, NAPTR) without supported/unsupported grouping. Bluecat and EfficientIP scanners retain their existing supported/unsupported split — unification deferred.
- Bluecat and EfficientIP scanners still use their own inline DNS type lists. Migration to shared `cloudutil.SupportedDNSTypes` is a natural follow-up but out of S06 scope.

## Follow-ups

- S07 frontend should display per-type DNS items in the results view — the data is available but not yet surfaced in the UI.
- Consider migrating bluecat/efficientip to import `cloudutil.SupportedDNSTypes` to eliminate type-list triplication.

## Files Created/Modified

- `internal/cloudutil/dns.go` — new: shared SupportedDNSTypes set (13 types) and RecordTypeItem helper
- `internal/cloudutil/dns_test.go` — new: test coverage for SupportedDNSTypes membership and RecordTypeItem formatting
- `internal/scanner/aws/route53.go` — replaced countAllRecordSets with countAllRecordSetsByType; updated scanRoute53 to emit per-type FindingRows
- `internal/scanner/aws/route53_expanded_test.go` — removed "dns_record" from existingItems in TestRoute53ExpandedScanners_NewItemNames
- `internal/scanner/azure/scanner.go` — updated countDNS to return per-type map; added extractAzureDNSType helper; updated scanSubscription to emit per-type FindingRows
- `internal/scanner/azure/scanner_test.go` — updated compile-time signature assertion for countDNS
- `internal/scanner/gcp/dns.go` — updated countDNS to return per-type map via rrset.Type iteration
- `internal/scanner/gcp/scanner.go` — updated scanOneProject DNS block to emit per-type FindingRows
- `internal/scanner/gcp/scanner_test.go` — updated three compile-time signature assertions for countDNS

## Forward Intelligence

### What the next slice should know
- All three cloud scanners now emit `dns_record_<type>` items (e.g., `dns_record_a`, `dns_record_mx`). The frontend results view in S07 should expect these item names instead of the old generic `dns_record`.
- The aggregate `resource_progress` event for `"dns_record"` still fires with the total count, so existing progress bars work unchanged.

### What's fragile
- Azure `extractAzureDNSType` assumes RecordSet.Type always has a `/` delimiter — if Azure ever changes the format, this will produce the full string as the type name. The function handles nil Type (→ "UNKNOWN") but not empty string (→ empty string, which RecordTypeItem maps to "dns_record_other").

### Authoritative diagnostics
- `FindingRow.Item` values in scan results — check for `dns_record_<lowercase_type>` pattern; absence of plain `dns_record` confirms per-type migration is complete.
- Compile-time assertions in test files — if countDNS signature changes, tests fail at compile time, not runtime.

### What assumptions changed
- Original plan assumed Azure would use `path.Base` for type extraction — `strings.LastIndex` was cleaner. No functional difference.
