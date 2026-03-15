# S06: DNS Record Type Breakdown — Research

**Date:** 2026-03-15

## Summary

S06 replaces the single generic `dns_record` `FindingRow.Item` across all three cloud scanners (AWS Route53, Azure DNS, GCP Cloud DNS) with per-type items (`dns_record_A`, `dns_record_AAAA`, `dns_record_CNAME`, etc.) and a supported/unsupported split. A shared `internal/cloudutil/dns.go` file will hold the canonical `SupportedDNSTypes` set (already duplicated in bluecat and efficientip scanners) to eliminate the triplication.

All three cloud APIs return the record type as a trivially accessible field on the record object — no additional API calls are needed. The main design tension is the **signature change for `countDNS`** in both Azure and GCP: callers currently expect `(int, int, error)` (zones, records) and tests compile-time assert that signature. S06 must either extend the return signature or replace the total-count pattern with a per-type map. Given the scanner-level block structure (GCP/Azure both inline the DNS counting with manual event publishing), the cleanest approach is to return a per-type map and let the caller emit one `FindingRow` per type.

The token math is unaffected: per-type rows all use `CategoryDDIObjects` / `TokensPerDDIObject`, and the calculator's `Calculate()` sums all DDI rows before dividing — so splitting one `dns_record` row into twelve `dns_record_A`…`dns_record_other` rows does not change the token result.

The frontend's Top Consumer Cards DNS filter uses the regex `/dns|zone/i.test(f.item)`, which already matches all `dns_record_*` item names — no frontend changes required for correctness.

## Recommendation

**Add `internal/cloudutil/dns.go` first, then update each scanner in dependency order (AWS → Azure → GCP), updating tests at each step.** Do not change the `countAllRecordSets` + `countDNS` function names — create new per-type variants alongside or as replacements, and update the scanner blocks that use them.

Specifically:
1. **`internal/cloudutil/dns.go`** — export `SupportedDNSTypes map[string]struct{}` (the 13-type set already present in bluecat and efficientip), and `RecordTypeItem(rrtype string) string` helper that produces `dns_record_A`, `dns_record_AAAA`, etc. (lowercased) with `dns_record_other` fallback.
2. **`internal/scanner/aws/route53.go`** — replace `countAllRecordSets` (returns int) with `countAllRecordSetsByType` (returns `map[string]int` keyed by RRType string). Emit one `FindingRow` per type in `scanRoute53`. Keep `dns_zone` row unchanged.
3. **`internal/scanner/azure/scanner.go`** — update `countDNS` to return `(zones int, typeCounts map[string]int, err error)`. Extract type from `RecordSet.Type` suffix (e.g. `"Microsoft.Network/dnsZones/A"` → `"A"`). Same for private DNS. Emit one `FindingRow` per type.
4. **`internal/scanner/gcp/dns.go`** — update `countDNS` to return `(zones int, typeCounts map[string]int, err error)`. `ResourceRecordSet.Type` is already a plain uppercase string like `"A"`. Emit one `FindingRow` per type.
5. **Tests** — update compile-time signature assertions; add per-type unit tests for each scanner.

## Don't Hand-Roll

| Problem | Existing Solution | Why Use It |
|---------|------------------|------------|
| Supported DNS type set | `bluecat.supportedDNSRecordTypes` and `efficientip.supportedDNSRecordTypes` (identical 13-type maps) | Extract to `cloudutil.SupportedDNSTypes` to eliminate triplication — both existing scanners can import it |
| Per-type item name formatting | New `cloudutil.RecordTypeItem(t string) string` | Single place to enforce `dns_record_a` naming convention (lowercase, underscore) |
| Token calculation | Existing `calculator.Calculate()` | Already sums all DDI rows before dividing — no change needed |
| Retry wrapping | `cloudutil.CallWithBackoff` | AWS `countAllRecordSetsByType` should wrap each zone's `ListResourceRecordSets` paginator call |

## Existing Code and Patterns

- `internal/scanner/bluecat/scanner.go:27` — `supportedDNSRecordTypes` map with 13 types (A, AAAA, CNAME, MX, TXT, CAA, SRV, SVCB, HTTPS, PTR, NS, SOA, NAPTR). **Exactly the same map exists verbatim in efficientip/scanner.go.** This is the source of truth for `cloudutil/dns.go`.
- `internal/scanner/bluecat/scanner.go:387` — `collectDNS` splits records at collection time, produces `"BlueCat DNS Records (Supported Types)"` and `"BlueCat DNS Records (Unsupported Types)"` FindingRows. S06 uses a per-type breakdown (not just supported/unsupported split) for cloud providers — this is a different output shape.
- `internal/scanner/aws/route53.go:55` — `countAllRecordSets` iterates `ListResourceRecordSets` pages and sums `len(page.ResourceRecordSets)`. Each `ResourceRecordSet` has a `Type route53types.RRType` field (string enum: `"A"`, `"AAAA"`, `"CNAME"`, `"MX"`, `"TXT"`, `"NS"`, `"SOA"`, `"SRV"`, `"SPF"`, `"PTR"`, `"CAA"`, `"DS"`, `"TLSA"`, `"SSHFP"`, `"SVCB"`, `"HTTPS"`, `"NAPTR"`). Switch from counting `len(page.ResourceRecordSets)` to maintaining a `map[string]int` keyed by `string(rrs.Type)`.
- `internal/scanner/azure/scanner.go:347` — `countDNS` function with signature `(ctx, cred, subID) (zones, records int, err)`. Its caller in `scanSubscription` uses `zoneCount, recordCount`. Changing the second return to `map[string]int` requires updating the call site and the two FindingRow construction blocks.
- `internal/scanner/azure/scanner.go:355` — Azure `RecordSet.Type` is `*string` with value `"Microsoft.Network/dnsZones/A"` (confirmed from SDK example tests). Extract type by `path.Base(*rs.Type)` or `strings.ToUpper(s[strings.LastIndex(s,"/")+1:])`.
- `internal/scanner/azure/scanner.go:391` — Private DNS `RecordSet.Type` is `"Microsoft.Network/privateDnsZones/A"` — same extraction pattern.
- `internal/scanner/gcp/dns.go:18` — `countDNS` function with signature `(ctx, ts, projectID) (zoneCount, recordCount int, err)`. Its caller in `gcp/scanner.go:212` uses the two-int return inline. `ResourceRecordSet.Type` (from `google.golang.org/api/dns/v1`) is a plain uppercase string like `"A"` — no prefix stripping needed.
- `internal/scanner/gcp/scanner.go:218` — The DNS inline block manually emits events and constructs FindingRows. It will need updating to loop over the per-type map.
- `internal/scanner/nios/families.go:9` — NIOS already uses `dns_record_a`, `dns_record_aaaa` etc. as family constants (all lowercase). Cloud scanners should use the same naming convention for UI consistency: `dns_record_a`, not `dns_record_A`.
- `internal/scanner/nios/scanner.go:409` — `familyDisplayNames` maps `dns_record_a` → `"DNS A Records"`. Cloud scanners don't need display names in `FindingRow.Item` — keep items as `dns_record_a` (matching NIOS convention).
- `internal/scanner/aws/route53_expanded_test.go` — Test verifies `scanRoute53` produces `route53_health_check` and `route53_traffic_policy` items. It checks for `dns_zone` and `dns_record` items by reference. After S06, the test will need to check for `dns_record_a`, `dns_record_aaaa`, etc. (or the test's `wantItems` map needs updating).
- `internal/scanner/azure/scanner_test.go:31` — Compile-time assertion: `var _ func(context.Context, azcore.TokenCredential, string) (int, int, error) = countDNS`. **Must be updated to the new signature.**
- `internal/scanner/gcp/scanner_test.go:30` — Compile-time assertion: `var _ func(context.Context, oauth2.TokenSource, string) (int, int, error) = countDNS`. **Must be updated to the new signature.**
- `server/scan.go:543` — `aggregateFindings` merges rows with the same `(provider, source, item)` key. Per-type rows with distinct item names will NOT be merged — correct behavior for multi-account scans.
- `frontend/src/app/components/wizard.tsx:2024` — DNS filter: `filter: (f) => /dns|zone/i.test(f.item) && !/unsupported/i.test(f.item)`. Items like `dns_record_a` match `/dns/i` → no frontend changes needed.

## Constraints

- **CGO_ENABLED=0** — no new dependencies allowed; `path` and `strings` are stdlib. No issue.
- **Signature change breakage** — `countDNS` in both Azure and GCP changes second return from `int` to `map[string]int`. All callers (only `scanSubscription` / `scanOneProject`) must be updated. The compile-time assertions in test files will catch missed updates at build time.
- **AWS pagination inside zone loop** — `countAllRecordSets` already iterates per-zone inside a loop. The per-type variant must also iterate per-page within each zone, maintaining the same error-continue behavior (skip this zone on error, continue counting others).
- **Azure type extraction** — `RecordSet.Type` is a `*string`. Must nil-check before dereferencing. When nil, classify as `"UNKNOWN"` and route to unsupported.
- **GCP type field** — `ResourceRecordSet.Type` is a plain `string` in the REST/JSON library (`google.golang.org/api/dns/v1`), not an enum. Already uppercase. Simple to use directly.
- **Calculator math** — `Calculate()` sums all DDI rows then does a single ceiling division. Splitting `dns_record` into N per-type rows doesn't change the token result — **no token math change needed**.
- **bluecat and efficientip scanners** — They use their own local `supportedDNSRecordTypes`. After S06 adds `cloudutil.SupportedDNSTypes`, those local vars can be replaced with the shared constant. However, the roadmap says S06 scope is AWS/Azure/GCP cloud providers only; bluecat/efficientip migration is a nice-to-have cleanup.
- **Azure SOA/NS records** — Azure DNS always includes SOA and NS records per zone. These will be counted as `dns_record_soa` and `dns_record_ns` — correct behavior (both are in `SupportedDNSTypes`).
- **Item naming convention** — Use lowercase with underscore: `dns_record_a`, not `dns_record_A`. Matches NIOS `NiosFamilyDNSRecordA = "dns_record_a"` convention.

## Common Pitfalls

- **Nil pointer on Azure Type field** — `RecordSet.Type` is `*string`. Always check for nil before extracting suffix. Use a helper function.
- **Map nil initialization** — Return `map[string]int{}` (empty map, not nil) from `countDNS`-equivalent functions. Callers that range over nil maps are safe in Go, but callers that check `len()` expect a non-nil result.
- **Azure "unsupported" count in aggregation** — Unlike bluecat/efficientip which emit two rows (`"Supported Types"` / `"Unsupported Types"`), cloud scanners should emit per-type rows — `dns_record_ds`, `dns_record_sshfp` etc. for unsupported types, and omit zero-count rows. This avoids polluting results with empty rows.
- **Route53 pagination wrapping** — `countAllRecordSets` currently does per-zone pagination inside the loop. S06 should keep the same loop structure, just accumulating into a `map[string]int` instead of a `total int`. Each page's `ResourceRecordSets` has a `.Type` field already.
- **Breaking the existing aws test** — `TestRoute53ExpandedScanners_GlobalWiring` currently checks for presence of `dns_zone` and `dns_record` items. After S06, there will be per-type items instead of `dns_record`. This test's `findingMap` check must be updated.
- **GCP DNS mock in tests** — `countDNS` in GCP is tested via compile-time signature assertion only (`TestCountDNSZones_Stub`, `TestCountDNSRecords_Stub`). After changing the signature, these stubs need to be updated to assert `(int, map[string]int, error)`.
- **Emission of zero-count rows** — Don't emit `FindingRow` entries with `Count: 0`. Callers currently use `if zones > 0` guards. For per-type map iteration, only emit rows where `count > 0`.

## Open Risks

- **AWS Route53 SPF/DS/TLSA/SSHFP records in real environments** — These are valid Route53 RRTypes but rare. The per-type breakdown will produce rows like `dns_record_ds` with small counts. They should be included, not silently dropped.
- **Azure private DNS record type availability** — Private DNS supports only A, AAAA, CNAME, MX, PTR, SOA, SRV, TXT (8 types, no CAA/NS). The extraction logic is the same, but the type space is narrower. No special handling needed — just emit whatever types appear.
- **GCP internal/private zone records** — GCP private zones can have records of any standard type. The `countDNS` function already counts both public and private zones without filtering. Per-type counting works the same way.
- **Aggregation of per-type rows across accounts** — In multi-account AWS scanning, `aggregateFindings` in `server/scan.go` merges rows by `(provider, source, item)`. With per-type rows, `source` is the account ID and `item` is `dns_record_a` — so rows from different accounts for the same type will NOT be merged (different `source`). This is correct — each account shows its own per-type breakdown. Multi-account totals appear correctly in `Calculate()` since all `CategoryDDIObjects` rows are summed.

## Skills Discovered

| Technology | Skill | Status |
|------------|-------|--------|
| Go / AWS SDK v2 | — | none needed (well-understood) |
| Azure SDK for Go | — | none needed (well-understood) |
| GCP Go client libraries | — | none needed (well-understood) |

## Implementation Plan (for Planning phase)

### Files to create
- `internal/cloudutil/dns.go` — `SupportedDNSTypes map[string]struct{}` (13 types), `RecordTypeItem(rrtype string) string` (returns `"dns_record_a"` etc., `"dns_record_other"` for unknown)

### Files to update
- `internal/scanner/aws/route53.go` — Replace `countAllRecordSets` with `countAllRecordSetsByType` returning `map[string]int`; update `scanRoute53` to emit per-type FindingRows
- `internal/scanner/azure/scanner.go` — Update `countDNS` signature to `(zones int, typeCounts map[string]int, err error)`; update `scanSubscription` call site
- `internal/scanner/gcp/dns.go` — Update `countDNS` signature to `(zoneCount int, typeCounts map[string]int, err error)`
- `internal/scanner/gcp/scanner.go` — Update the inline DNS block in `scanOneProject` to loop over per-type map
- `internal/scanner/aws/route53_expanded_test.go` — Update item name assertions (no more `dns_record`)
- `internal/scanner/azure/scanner_test.go` — Update `countDNS` compile-time signature assertion
- `internal/scanner/gcp/scanner_test.go` — Update `countDNS` compile-time signature assertions

### New test files
- `internal/cloudutil/dns_test.go` — Tests for `SupportedDNSTypes` membership and `RecordTypeItem` formatting
- `internal/scanner/aws/route53_dns_breakdown_test.go` (or add to `route53_expanded_test.go`) — Test `countAllRecordSetsByType` with mocked pages; test `scanRoute53` produces per-type FindingRows
- `internal/scanner/azure/dns_breakdown_test.go` — Test `countDNS` new signature with type extraction helper; test type extraction from `"Microsoft.Network/dnsZones/A"` format
- `internal/scanner/gcp/dns_breakdown_test.go` — Test `countDNS` new signature with mocked ResourceRecordSets; test type pass-through

## Sources

- AWS Route53 `RRType` enum — `github.com/aws/aws-sdk-go-v2/service/route53@v1.62.4/types/enums.go`; values: SOA, A, TXT, NS, CNAME, MX, NAPTR, PTR, SRV, SPF, AAAA, CAA, DS, TLSA, SSHFP, SVCB, HTTPS
- Azure DNS `RecordSet.Type` format — `github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/dns/armdns@v1.2.0/recordsets_client_example_test.go`; format: `"Microsoft.Network/dnsZones/A"`
- Azure Private DNS `RecordSet.Type` format — `armprivatedns@v*/recordsets_client_example_test.go`; format: `"Microsoft.Network/privateDnsZones/A"`
- GCP `ResourceRecordSet.Type` — `google.golang.org/api@v0.271.0/dns/v1/dns-gen.go`; plain uppercase string e.g. `"A"`, `"AAAA"`
- NIOS naming convention — `internal/scanner/nios/families.go`; `dns_record_a`, `dns_record_aaaa` etc.
- `SupportedDNSTypes` set — `internal/scanner/bluecat/scanner.go:27` and `internal/scanner/efficientip/scanner.go:32` (identical): A, AAAA, CNAME, MX, TXT, CAA, SRV, SVCB, HTTPS, PTR, NS, SOA, NAPTR
- Frontend DNS filter regex — `frontend/src/app/components/wizard.tsx:2024`; `/dns|zone/i.test(f.item)` — matches all `dns_record_*` names automatically
