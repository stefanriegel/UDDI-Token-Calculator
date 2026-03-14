# T04: 10-nios-backend-scanner 04

**Slice:** S02 — **Milestone:** M002

## Description

Complete the results API extension: add the typed NiosServerMetric struct to server/types.go, replace the json.RawMessage placeholder from Plan 03 with the proper typed field, decode NiosServerMetricsJSON in HandleScanResults, and make the API-02 test go GREEN.

Purpose: Closes the loop between the NIOS scanner output and the frontend API contract (§6 of API_CONTRACT.md).
Output: Typed NiosServerMetric in types.go, HandleScanResults updated, scan_nios_test.go test passing.

## Must-Haves

- [ ] "GET /api/v1/scan/{scanId}/results returns niosServerMetrics[] alongside findings[] when NIOS was scanned"
- [ ] "niosServerMetrics array has the correct JSON shape: memberId, memberName, role, qps, lps, objectCount"
- [ ] "niosServerMetrics is omitted (not null, not empty array) when NIOS was not scanned"
- [ ] "TestHandleScanResultsNIOS passes GREEN"

## Files

- `server/types.go`
- `server/scan.go`
- `server/scan_nios_test.go`
