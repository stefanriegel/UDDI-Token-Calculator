# S04: Nios Wapi Scanner Bluecat Efficientip Providers

**Goal:** Implement the NIOS WAPI live scanner that connects to a NIOS Grid Manager via REST API, auto-detects the WAPI version, fetches the capacity report, and produces FindingRows + NiosServerMetrics.
**Demo:** Implement the NIOS WAPI live scanner that connects to a NIOS Grid Manager via REST API, auto-detects the WAPI version, fetches the capacity report, and produces FindingRows + NiosServerMetrics.

## Must-Haves


## Tasks

- [x] **T01: 12-nios-wapi-scanner-bluecat-efficientip-providers 01** `est:4min`
  - Implement the NIOS WAPI live scanner that connects to a NIOS Grid Manager via REST API, auto-detects the WAPI version, fetches the capacity report, and produces FindingRows + NiosServerMetrics.

Purpose: Enable live scanning of NIOS grids without requiring a backup file export.
Output: `internal/scanner/nios/wapi.go` + `internal/scanner/nios/wapi_test.go`
- [x] **T02: 12-nios-wapi-scanner-bluecat-efficientip-providers 02** `est:3min`
  - Implement the Bluecat DDI provider scanner that authenticates (v2/v1 fallback), collects DNS + IPAM + DHCP objects, and returns FindingRows mapped to token categories.

Purpose: Add Bluecat Address Manager as a supported DDI provider for token estimation.
Output: `internal/scanner/bluecat/scanner.go` + `internal/scanner/bluecat/scanner_test.go`
- [x] **T03: 12-nios-wapi-scanner-bluecat-efficientip-providers 03** `est:3min`
  - Implement the EfficientIP DDI provider scanner that authenticates (Basic/native fallback), collects DNS + IPAM + DHCP objects with optional site filtering, and returns FindingRows mapped to token categories.

Purpose: Add EfficientIP SOLIDserver as a supported DDI provider for token estimation.
Output: `internal/scanner/efficientip/scanner.go` + `internal/scanner/efficientip/scanner_test.go`
- [x] **T04: 12-nios-wapi-scanner-bluecat-efficientip-providers 04** `est:4min`
  - Wire all three new providers (NIOS WAPI, Bluecat, EfficientIP) into the backend: session credential types, validate endpoints, orchestrator registration, scan routing, and Excel export tabs.

Purpose: Connect the standalone scanner implementations to the HTTP API and scan lifecycle.
Output: Modified backend files enabling end-to-end scan flow for all three new providers.
- [x] **T05: 12-nios-wapi-scanner-bluecat-efficientip-providers 05** `est:7min`
  - Add frontend support for all three new providers: NIOS dual-mode toggle (backup vs WAPI), Bluecat and EfficientIP provider cards with credential forms, TLS skip-verify checkbox, and API client functions.

Purpose: Users can configure and scan NIOS via live API, Bluecat, and EfficientIP from the wizard UI.
Output: Updated frontend files with new provider flows.
- [x] **T06: 12-nios-wapi-scanner-bluecat-efficientip-providers 06**
  - Human verification checkpoint: visually confirm all new provider UI elements render correctly and existing providers are unaffected.

Purpose: Catch visual/UX issues that automated tests cannot detect.
Output: Human approval or issue list.

## Files Likely Touched

- `internal/scanner/nios/wapi.go`
- `internal/scanner/nios/wapi_test.go`
- `internal/scanner/bluecat/scanner.go`
- `internal/scanner/bluecat/scanner_test.go`
- `internal/scanner/efficientip/scanner.go`
- `internal/scanner/efficientip/scanner_test.go`
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
- `frontend/src/app/components/mock-data.ts`
- `frontend/src/app/components/api-client.ts`
- `frontend/src/app/components/wizard.tsx`
- `frontend/src/assets/logos/bluecat.svg`
- `frontend/src/assets/logos/efficientip.svg`
