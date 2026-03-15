# S06: DNS Record Type Breakdown — UAT

**Milestone:** M004-2qci81
**Written:** 2026-03-15

## UAT Type

- UAT mode: artifact-driven
- Why this mode is sufficient: This slice modifies backend scanner output only (no UI, no API changes). Verification is fully covered by examining `FindingRow.Item` values in test output and compile-time signature assertions. No live cloud credentials needed — mock-based tests validate the per-type counting logic.

## Preconditions

- Go 1.24+ installed (`go version`)
- Repository checked out at post-S06 commit
- No cloud credentials required (all tests use mocks/stubs)

## Smoke Test

Run `go test ./internal/cloudutil/... ./internal/scanner/aws/... ./internal/scanner/azure/... ./internal/scanner/gcp/... -count=1` — all packages pass with zero failures.

## Test Cases

### 1. Shared DNS types helper produces correct item names

1. Run `go test ./internal/cloudutil/... -v -run TestRecordTypeItem -count=1`
2. Observe test output for all 13 supported types (A, AAAA, CNAME, MX, TXT, SRV, NS, SOA, PTR, CAA, DS, NAPTR, SPF)
3. **Expected:** Each type maps to `dns_record_<lowercase>` (e.g., `"AAAA"` → `"dns_record_aaaa"`, `"SRV"` → `"dns_record_srv"`). Unknown type `"CUSTOM"` maps to `"dns_record_custom"`. Empty string maps to `"dns_record_other"`.

### 2. SupportedDNSTypes contains exactly 13 types

1. Run `go test ./internal/cloudutil/... -v -run TestSupportedDNSTypes -count=1`
2. **Expected:** `SupportedDNSTypes` map has exactly 13 entries. All 13 canonical types (A, AAAA, CNAME, MX, TXT, SRV, NS, SOA, PTR, CAA, DS, NAPTR, SPF) are present.

### 3. AWS Route53 emits per-type DNS FindingRows

1. Run `go test ./internal/scanner/aws/... -v -run TestRoute53ExpandedScanners_NewItemNames -count=1`
2. Inspect the item name list in the test
3. **Expected:** Item list includes `dns_zone` but does NOT include generic `dns_record`. Per-type items like `dns_record_a`, `dns_record_cname` are emitted by `scanRoute53` when corresponding records exist in mock data.

### 4. AWS Route53 error-path graceful degradation

1. Run `go test -run TestRoute53ExpandedScanners_GlobalWiring ./internal/scanner/aws/... -v -count=1`
2. **Expected:** Test passes. When Route53 API calls fail (no credentials), `health_check` and `traffic_policy` rows still appear. DNS FindingRows are omitted (not errored). A `resource_progress` event with `Status: "error"` is published for the DNS failure.

### 5. Azure countDNS returns per-type map

1. Run `go test ./internal/scanner/azure/... -v -count=1`
2. **Expected:** All tests pass. Compile-time signature assertion for `countDNS` verifies return type is `(int, map[string]int, error)`. If signature drifts, tests fail at compile time.

### 6. GCP countDNS returns per-type map

1. Run `go test ./internal/scanner/gcp/... -v -count=1`
2. **Expected:** All tests pass. Three compile-time signature assertions for `countDNS` verify return type is `(int, map[string]int, error)`.

### 7. No regressions across full test suite

1. Run `go test ./internal/... -count=1`
2. **Expected:** All 14 internal packages pass. No NIOS, AD, Bluecat, EfficientIP, or calculator test failures. Only the pre-existing top-level embed.go failure (missing `frontend/dist`) is acceptable.

### 8. No vet issues

1. Run `go vet ./internal/...`
2. **Expected:** Clean output (no issues).

## Edge Cases

### Empty RecordSet.Type in Azure

1. Examine `extractAzureDNSType` behavior when `RecordSet.Type` is nil
2. **Expected:** Nil `Type` pointer maps to `"UNKNOWN"`, which `RecordTypeItem` converts to `"dns_record_unknown"`. No nil pointer dereference.

### Zero-count DNS record types

1. In any scanner, when a zone has records of types A and CNAME but not MX
2. **Expected:** Only `dns_record_a` and `dns_record_cname` FindingRows are emitted. No `dns_record_mx` row with count 0 — zero-count types are silently omitted.

### Unknown/non-standard DNS record type

1. If a cloud provider returns a record type not in SupportedDNSTypes (e.g., "HTTPS", "SVCB")
2. **Expected:** `RecordTypeItem` still produces `dns_record_https` or `dns_record_svcb` — unknown types pass through with lowercase normalization, they are NOT mapped to "other". Only empty string maps to "other".

### Case normalization

1. Cloud API returns type as "Cname" (mixed case) or "cname" (lowercase)
2. **Expected:** `RecordTypeItem` normalizes to `dns_record_cname` regardless of input casing.

## Failure Signals

- Any `dns_record` (without type suffix) appearing in FindingRow.Item values — indicates per-type migration is incomplete
- Compile-time errors in azure/scanner_test.go or gcp/scanner_test.go — indicates countDNS signature mismatch
- `TestRoute53ExpandedScanners_NewItemNames` failure — indicates "dns_record" still in expected item list
- Any panic in Azure scanner — likely nil RecordSet.Type not handled

## Requirements Proved By This UAT

- AWS-RES-01 — AWS scanner per-type DNS items verified via TestRoute53ExpandedScanners_NewItemNames
- AZ-RES-01 — Azure scanner per-type DNS items verified via compile-time assertion and scanner tests
- GCP-RES-01 — GCP scanner per-type DNS items verified via compile-time assertions and scanner tests

## Not Proven By This UAT

- Frontend display of per-type DNS items — S07 scope
- Supported/unsupported DNS type grouping in results UI — deferred (cloud scanners emit all types without grouping)
- Real cloud API responses with per-type counting — tests use mocks; live validation requires cloud credentials

## Notes for Tester

- The `SupportedDNSTypes` set (13 types) matches the canonical set from Bluecat/EfficientIP scanners. It is informational for cloud scanners — cloud scanners emit all types, not just supported ones.
- The pre-existing `go test ./...` failure at the root package (missing `frontend/dist` embed directory) is unrelated to this slice. All `./internal/...` tests must pass.
- GCP tests may take ~2s due to SDK initialization — this is normal.
