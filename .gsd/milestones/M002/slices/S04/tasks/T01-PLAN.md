# T01: 12-nios-wapi-scanner-bluecat-efficientip-providers 01

**Slice:** S04 — **Milestone:** M002

## Description

Implement the NIOS WAPI live scanner that connects to a NIOS Grid Manager via REST API, auto-detects the WAPI version, fetches the capacity report, and produces FindingRows + NiosServerMetrics.

Purpose: Enable live scanning of NIOS grids without requiring a backup file export.
Output: `internal/scanner/nios/wapi.go` + `internal/scanner/nios/wapi_test.go`

## Must-Haves

- [ ] "WAPI scanner resolves NIOS API version via 4-step cascade (explicit, embedded, wapidoc, probe candidates)"
- [ ] "WAPI scanner fetches capacityreport and classifies metrics into DNS/IPAM/DHCP token categories"
- [ ] "WAPI scanner implements both Scanner and NiosResultScanner interfaces"
- [ ] "WAPI scanner produces per-member NiosServerMetric with objectCount from capacityreport"

## Files

- `internal/scanner/nios/wapi.go`
- `internal/scanner/nios/wapi_test.go`
