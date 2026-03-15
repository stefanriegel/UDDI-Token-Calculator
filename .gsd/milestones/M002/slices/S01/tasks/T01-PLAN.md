# T01: 09-frontend-extension-api-migration 01

**Slice:** S01 — **Milestone:** M002

## Description

Replace the App.tsx version badge with a page title; swap the Google Fonts CDN import in fonts.css with a system font stack; copy all new SVG logos and data files from the Figma Make export into the frontend asset tree.

Purpose: Eliminates external network requests (critical for air-gapped .exe deployment), adds the Infoblox branding, and stages the NIOS and Infoblox logos that later plans and Phase 11 will reference.
Output: Updated App.tsx, updated fonts.css, 6 SVG logo files in two locations, 2 CSV imports, 3 PNG assets.

## Must-Haves

- [ ] "App.tsx renders without a version badge in the footer — no /api/v1/version fetch"
- [ ] "Page title in browser tab reads 'Infoblox Universal DDI Token Assessment'"
- [ ] "fonts.css contains no Google Fonts CDN import — system font stack only"
- [ ] "SVG logos for all 6 providers (aws, azure, gcp, infoblox, microsoft, nios-grid) exist in both frontend/src/assets/logos/ and frontend/public/logos/"
- [ ] "performance-specs.csv and performance-metrics.csv exist in frontend/src/imports/"
- [ ] "Three PNG assets from Figma export exist in frontend/src/assets/"

## Files

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
