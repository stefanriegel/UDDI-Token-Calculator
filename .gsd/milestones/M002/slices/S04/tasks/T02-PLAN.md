# T02: 12-nios-wapi-scanner-bluecat-efficientip-providers 02

**Slice:** S04 — **Milestone:** M002

## Description

Implement the Bluecat DDI provider scanner that authenticates (v2/v1 fallback), collects DNS + IPAM + DHCP objects, and returns FindingRows mapped to token categories.

Purpose: Add Bluecat Address Manager as a supported DDI provider for token estimation.
Output: `internal/scanner/bluecat/scanner.go` + `internal/scanner/bluecat/scanner_test.go`

## Must-Haves

- [ ] "Bluecat scanner authenticates via v2 API first, falls back to v1 on failure"
- [ ] "Bluecat scanner counts DNS views, zones, records (supported/unsupported split), IP blocks, networks, addresses, DHCP ranges"
- [ ] "Bluecat scanner paginates all v2 endpoints correctly and handles v1 getEntities fallback"
- [ ] "Bluecat scanner supports optional configuration ID filtering"

## Files

- `internal/scanner/bluecat/scanner.go`
- `internal/scanner/bluecat/scanner_test.go`
