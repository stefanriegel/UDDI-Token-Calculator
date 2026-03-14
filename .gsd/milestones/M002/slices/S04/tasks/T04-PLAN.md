# T04: 12-nios-wapi-scanner-bluecat-efficientip-providers 04

**Slice:** S04 — **Milestone:** M002

## Description

Wire all three new providers (NIOS WAPI, Bluecat, EfficientIP) into the backend: session credential types, validate endpoints, orchestrator registration, scan routing, and Excel export tabs.

Purpose: Connect the standalone scanner implementations to the HTTP API and scan lifecycle.
Output: Modified backend files enabling end-to-end scan flow for all three new providers.

## Must-Haves

- [ ] "NIOS WAPI mode uses single 'nios' provider with mode dispatch in orchestrator"
- [ ] "Bluecat and EfficientIP validate endpoints test connectivity and return detected API/auth version"
- [ ] "All three new providers are registered in the orchestrator and callable via POST /api/v1/scan"
- [ ] "NIOS WAPI validate discovers Grid Members and returns them as SubscriptionItems"
- [ ] "Excel export includes per-provider tabs for Bluecat and EfficientIP"
- [ ] "WAPI scanner GetNiosServerMetricsJSON() output is returned in GET /api/v1/scan/{id}/results as niosServerMetrics"

## Files

- `internal/scanner/provider.go`
- `internal/session/session.go`
- `internal/orchestrator/orchestrator.go`
- `internal/exporter/exporter.go`
- `server/types.go`
- `server/validate.go`
- `server/scan.go`
- `server/server.go`
- `server/export.go`
- `main.go`
