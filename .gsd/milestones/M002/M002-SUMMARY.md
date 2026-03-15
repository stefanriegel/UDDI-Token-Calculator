# M002: NIOS Grid Integration + Frontend Overhaul (Phases 9-14) — SHIPPED 2026-03-13

## What Happened

Extended the token calculator with NIOS Grid backup parsing, live NIOS WAPI scanning, Bluecat and EfficientIP DDI provider support, and a major frontend overhaul matching the Figma Make redesign. Migrated from SSE to polling, added NIOS result panels (Top Consumer Cards, Migration Planner, Server Token Calculator, XaaS Consolidation), and integrated three new DDI vendor scanners.

## Key Deliverables

- **Frontend Extension + API Migration (S01):** SSE→polling migration, NIOS provider card, backup upload flow, system fonts replacing CDN
- **NIOS Backend Scanner (S02):** Streaming XML parser for onedb.xml, grid member role detection, DDI object counting, DHCP lease dedup, per-member NiosServerMetrics
- **Frontend NIOS Features (S03):** Top Consumer Cards, NIOS-X Migration Planner (3-scenario), Server Token Calculator, XaaS Consolidation with bin-packing
- **NIOS WAPI + Bluecat + EfficientIP (S04):** Live NIOS WAPI scanner with 4-step version cascade, Bluecat v2/v1 auth cascade, EfficientIP Basic/native auth cascade, all wired end-to-end
- **Credential Wiring Fix (S05):** Fixed credential key name mismatches for Bluecat/EfficientIP validate endpoints
- **Verification + Traceability (S06):** Phase 11 verification, requirement traceability, test suite validation

## Stats

- 6 phases (9-14), 21 plans across 4 days
- Added 3 new DDI vendor integrations (NIOS WAPI, Bluecat, EfficientIP)
- Frontend redesign matching Figma Make specifications

## Shipped

2026-03-13
