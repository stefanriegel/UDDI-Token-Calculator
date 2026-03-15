# S01: Frontend Extension Api Migration

**Goal:** Replace the App.
**Demo:** Replace the App.

## Must-Haves


## Tasks

- [x] **T01: 09-frontend-extension-api-migration 01** `est:12min`
  - Replace the App.tsx version badge with a page title; swap the Google Fonts CDN import in fonts.css with a system font stack; copy all new SVG logos and data files from the Figma Make export into the frontend asset tree.

Purpose: Eliminates external network requests (critical for air-gapped .exe deployment), adds the Infoblox branding, and stages the NIOS and Infoblox logos that later plans and Phase 11 will reference.
Output: Updated App.tsx, updated fonts.css, 6 SVG logo files in two locations, 2 CSV imports, 3 PNG assets.
- [x] **T02: 09-frontend-extension-api-migration 02** `est:15min`
  - Add two new Go backend endpoints (polling status + NIOS backup upload), delete the SSE events endpoint, add the ProviderNIOS constant and a stub NIOS scanner, and update the server router accordingly.

Purpose: Unblocks the frontend polling migration (Plan 03) and the wizard NIOS flow (Plan 04). The SSE endpoint is deleted clean — no deprecation — because the frontend will switch to polling in Plan 03 atomically within this phase.
Output: server/scan.go with two new handlers (no SSE handler), updated server/types.go, updated server/server.go router, new internal/scanner/nios/scanner.go stub, ProviderNIOS constant, updated main.go.
- [x] **T03: 09-frontend-extension-api-migration 03**
  - Migrate api-client.ts from SSE (EventSource) to polling: remove startScanEvents/ScanEventType/ScanEvent, add getScanStatus() and uploadNiosBackup() with their response types. Replace the SSE subscription pattern in use-backend.ts with a useScanPolling() hook using setInterval.

Purpose: Completes the SSE→polling cutover on the frontend side. Plan 02 already deleted the SSE backend endpoint; this plan deletes the matching client code and adds the polling client. Plan 04 (wizard.tsx) will import useScanPolling and the new api-client functions.
Output: Updated api-client.ts (merge strategy — existing functions preserved, SSE section replaced), new useScanPolling hook in use-backend.ts.
- [x] **T04: 09-frontend-extension-api-migration 04** `est:12min`
  - Wire NIOS into the wizard: add the NIOS provider card in Step 1, render a file dropzone + member checkbox list in Step 2 when NIOS is selected, and replace the SSE scan event listener with useScanPolling in the scanning step.

Purpose: Completes Phase 9's frontend changes. The user can now select NIOS, upload a backup, choose Grid Members, and initiate a scan via the polling API — all without disrupting the existing four provider flows.
Output: Updated mock-data.ts (ProviderType + PROVIDERS extended), updated wizard.tsx (NIOS card, backup upload UI, member selection, polling scan integration).
- [x] **T05: 09-frontend-extension-api-migration 05** `est:5min`
  - Human verification of all Phase 9 changes: NIOS provider card, backup upload flow, member selection, polling scan progress, asset changes, and existing provider regression check.

Purpose: Phase 9 touches 2000+ line wizard.tsx, removes SSE, and adds an entirely new provider flow. Visual and functional verification by a human ensures the changes work end-to-end before Phase 10 builds on top.
Output: Human approval (or issue report) that unlocks Phase 10 planning.

## Files Likely Touched

- `frontend/src/app/App.tsx`
- `frontend/src/styles/fonts.css`
- `frontend/src/assets/logos/aws.svg`
- `frontend/src/assets/logos/azure.svg`
- `frontend/src/assets/logos/gcp.svg`
- `frontend/src/assets/logos/infoblox.svg`
- `frontend/src/assets/logos/microsoft.svg`
- `frontend/src/assets/logos/nios-grid.svg`
- `frontend/public/logos/aws.svg`
- `frontend/public/logos/azure.svg`
- `frontend/public/logos/gcp.svg`
- `frontend/public/logos/infoblox.svg`
- `frontend/public/logos/microsoft.svg`
- `frontend/public/logos/nios-grid.svg`
- `frontend/src/assets/079fcfba112ad121bfe5a3d9a05e870a29f204a8.png`
- `frontend/src/assets/99901e992f364f959d82921f44f23059d857441b.png`
- `frontend/src/assets/e70ef6ed461d7655f9e7d5443d0b7d8cd4e309d9.png`
- `frontend/src/imports/performance-specs.csv`
- `frontend/src/imports/performance-metrics.csv`
- `internal/scanner/provider.go`
- `server/scan.go`
- `server/server.go`
- `server/types.go`
- `server/scan_test.go`
- `internal/scanner/nios/scanner.go`
- `frontend/src/app/components/api-client.ts`
- `frontend/src/app/components/use-backend.ts`
- `frontend/src/app/components/mock-data.ts`
- `frontend/src/app/components/wizard.tsx`
