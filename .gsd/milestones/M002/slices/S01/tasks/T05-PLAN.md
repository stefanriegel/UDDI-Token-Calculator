# T05: 09-frontend-extension-api-migration 05

**Slice:** S01 — **Milestone:** M002

## Description

Human verification of all Phase 9 changes: NIOS provider card, backup upload flow, member selection, polling scan progress, asset changes, and existing provider regression check.

Purpose: Phase 9 touches 2000+ line wizard.tsx, removes SSE, and adds an entirely new provider flow. Visual and functional verification by a human ensures the changes work end-to-end before Phase 10 builds on top.
Output: Human approval (or issue report) that unlocks Phase 10 planning.

## Must-Haves

- [ ] "All 5 phase success criteria are verified by a human using the running application"
- [ ] "Existing provider flows (AWS, Azure, GCP, AD) have not regressed"
- [ ] "NIOS card is visible and functional in Step 1"
- [ ] "Scanning uses polling — no EventSource network connections observed"
