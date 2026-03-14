# T04: 09-frontend-extension-api-migration 04

**Slice:** S01 — **Milestone:** M002

## Description

Wire NIOS into the wizard: add the NIOS provider card in Step 1, render a file dropzone + member checkbox list in Step 2 when NIOS is selected, and replace the SSE scan event listener with useScanPolling in the scanning step.

Purpose: Completes Phase 9's frontend changes. The user can now select NIOS, upload a backup, choose Grid Members, and initiate a scan via the polling API — all without disrupting the existing four provider flows.
Output: Updated mock-data.ts (ProviderType + PROVIDERS extended), updated wizard.tsx (NIOS card, backup upload UI, member selection, polling scan integration).

## Must-Haves

- [ ] "NIOS Grid appears as the 5th provider card in Step 1 alongside AWS, Azure, GCP, AD"
- [ ] "When NIOS is selected and user is on Step 2, a file dropzone renders instead of a credential form"
- [ ] "After a valid backup is uploaded, a checkbox list of Grid Members (hostname + role badge) appears below the dropzone"
- [ ] "Select All / Deselect All toggle is present above the member list"
- [ ] "Next button in Step 2 is disabled until at least one Grid Member is checked"
- [ ] "All existing provider credential forms (AWS, Azure, GCP, AD) render identically to before"
- [ ] "Scanning step uses polling (useScanPolling) instead of SSE — providerScanProgress updates from poll responses"
- [ ] "demo mode mock scan still works (NIOS provider generates empty mock findings)"
- [ ] "TypeScript compiles without errors introduced by this plan"

## Files

- `frontend/src/app/components/mock-data.ts`
- `frontend/src/app/components/wizard.tsx`
