---
id: T02
parent: S06
milestone: M004-2qci81
provides:
  - Azure countDNS returns (int, map[string]int, error) with per-type DNS record counts
  - GCP countDNS returns (int, map[string]int, error) with per-type DNS record counts
  - extractAzureDNSType helper for Azure RecordSet.Type → plain type string
  - Both scanners emit per-type FindingRows via cloudutil.RecordTypeItem
key_files:
  - internal/scanner/azure/scanner.go
  - internal/scanner/gcp/dns.go
  - internal/scanner/gcp/scanner.go
  - internal/scanner/azure/scanner_test.go
  - internal/scanner/gcp/scanner_test.go
key_decisions:
  - Used strings.LastIndex for Azure type extraction (not path.Base) — no path import needed and handles both public/private DNS format identically
  - Azure nil RecordSet.Type maps to "UNKNOWN" (producing dns_record_unknown via RecordTypeItem) — consistent with T01 pattern where empty string → dns_record_other
  - GCP on-error path emits no per-type FindingRows (guarded by dnsErr == nil check) — only aggregate error event
patterns_established:
  - extractAzureDNSType helper centralizes Azure RecordSet.Type → plain type extraction for both public and private DNS zones
observability_surfaces:
  - resource_progress event for dns_record with aggregate total (backward-compatible)
  - Per-type FindingRow items (dns_record_a, dns_record_cname, etc.) inspectable in scanner output
  - Error resource_progress events unchanged — Status "error" on countDNS failure
  - Compile-time signature assertions catch signature drift at build time
duration: 10m
verification_result: passed
completed_at: 2026-03-15
blocker_discovered: false
---

# T02: Azure + GCP per-type DNS breakdown + test updates

**Applied per-type DNS counting pattern to Azure and GCP scanners with `extractAzureDNSType` helper and updated compile-time signature assertions**

## What Happened

Updated both Azure and GCP `countDNS` functions from `(int, int, error)` to `(int, map[string]int, error)` return signature, accumulating per-type DNS record counts instead of a flat total.

Azure required a new `extractAzureDNSType` helper to parse the record type from Azure's fully-qualified `RecordSet.Type` field (e.g. `"Microsoft.Network/dnsZones/A"` → `"A"`). Uses `strings.LastIndex` to extract the suffix after the last `/`. Nil `Type` pointers map to `"UNKNOWN"` to prevent panics. Both public DNS (`armdns`) and private DNS (`armprivatedns`) record sets are handled identically.

GCP was simpler — `ResourceRecordSet.Type` is already a plain uppercase string (`"A"`, `"CNAME"`, etc.), so the loop just increments `typeCounts[rrset.Type]++`.

Both call sites (`scanSubscription` for Azure, `scanOneProject` for GCP) now emit one FindingRow per non-zero record type using `cloudutil.RecordTypeItem(rrtype)`, plus one aggregate `resource_progress` event with the total count for backward compatibility.

All three compile-time signature assertions in test files (1 in azure, 3 in gcp) updated to `(int, map[string]int, error)`.

## Verification

- `go vet ./internal/scanner/azure/... ./internal/scanner/gcp/... ./internal/cloudutil/...` — clean
- `go test ./internal/scanner/azure/... -v -count=1` — PASS (signature assertion + all scanner tests)
- `go test ./internal/scanner/gcp/... -v -count=1` — PASS (signature assertion + all scanner tests)
- `go test ./internal/cloudutil/... -v -count=1` — PASS (dns.go tests)
- `go test ./internal/scanner/aws/... -v -count=1` — PASS (including TestRoute53ExpandedScanners_GlobalWiring error-path test)
- `go test ./... -count=1` — all `internal/...` packages pass; only failure is pre-existing top-level embed.go (frontend/dist not found, unrelated)

### Slice-level verification status (T02 is final task):
- ✅ `go test ./internal/cloudutil/... -v -count=1` — pass
- ✅ `go test ./internal/scanner/aws/... -v -count=1` — pass
- ✅ `go test ./internal/scanner/azure/... -v -count=1` — pass
- ✅ `go test ./internal/scanner/gcp/... -v -count=1` — pass
- ✅ `go test ./... -count=1` — all internal packages pass (top-level embed issue pre-existing)
- ✅ `go vet ./internal/...` — clean
- ✅ `go test -run TestRoute53ExpandedScanners_GlobalWiring ./internal/scanner/aws/... -v -count=1` — pass

## Diagnostics

- Inspect per-type DNS items by checking `FindingRow.Item` values from Azure/GCP scanners — each matches `dns_record_<lowercase_type>`.
- Azure type extraction: `extractAzureDNSType` is a pure function — test by inspecting its output for known Azure type strings.
- The aggregate `resource_progress` event for `"dns_record"` reports total count across all types for backward-compatible progress.
- On API error, a `resource_progress` event with `Status: "error"` is emitted and no per-type DNS FindingRows are produced.

## Deviations

- Used `strings.LastIndex` instead of `path.Base` for Azure type extraction (plan suggested `path.Base`). `strings.LastIndex` is more explicit and avoids importing the `path` package for a single-use case.

## Known Issues

None.

## Files Created/Modified

- `internal/scanner/azure/scanner.go` — Updated `countDNS` to return `(int, map[string]int, error)` with per-type counts; added `extractAzureDNSType` helper; updated `scanSubscription` call site to emit per-type FindingRows; added `strings` import
- `internal/scanner/azure/scanner_test.go` — Updated compile-time signature assertion for `countDNS` to `(int, map[string]int, error)`
- `internal/scanner/gcp/dns.go` — Updated `countDNS` to return `(int, map[string]int, error)` with per-type counts via `rrset.Type` iteration
- `internal/scanner/gcp/scanner.go` — Updated `scanOneProject` DNS block to emit per-type FindingRows with aggregate progress event
- `internal/scanner/gcp/scanner_test.go` — Updated all three compile-time signature assertions for `countDNS` to `(int, map[string]int, error)`
- `.gsd/milestones/M004-2qci81/slices/S06/tasks/T02-PLAN.md` — Added Observability Impact section (pre-flight fix)
