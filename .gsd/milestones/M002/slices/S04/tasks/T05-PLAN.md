# T05: 12-nios-wapi-scanner-bluecat-efficientip-providers 05

**Slice:** S04 — **Milestone:** M002

## Description

Add frontend support for all three new providers: NIOS dual-mode toggle (backup vs WAPI), Bluecat and EfficientIP provider cards with credential forms, TLS skip-verify checkbox, and API client functions.

Purpose: Users can configure and scan NIOS via live API, Bluecat, and EfficientIP from the wizard UI.
Output: Updated frontend files with new provider flows.

## Must-Haves

- [ ] "NIOS provider card shows a toggle between Upload Backup and Live API modes"
- [ ] "In WAPI mode, NIOS credential form shows URL + username + password + optional version + skip TLS checkbox"
- [ ] "Bluecat and EfficientIP provider cards appear in Step 1 with correct logos"
- [ ] "Bluecat credential form shows URL + username + password + Validate button + optional advanced section for config IDs"
- [ ] "EfficientIP credential form shows URL + username + password + Validate button + optional advanced section for site IDs"
- [ ] "All three new providers show Skip TLS checkbox with amber warning text"
- [ ] "Toggle switching clears stale state (backupToken, selectedMembers, credentialStatus)"
- [ ] "All four NIOS panels (Top Consumer Cards, Migration Planner, Server Token Calculator, XaaS Consolidation) display data when WAPI mode was used"

## Files

- `frontend/src/app/components/mock-data.ts`
- `frontend/src/app/components/api-client.ts`
- `frontend/src/app/components/wizard.tsx`
- `frontend/src/assets/logos/bluecat.svg`
- `frontend/src/assets/logos/efficientip.svg`
