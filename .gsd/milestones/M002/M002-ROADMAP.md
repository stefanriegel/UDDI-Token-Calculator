# M002: NIOS Grid Integration + Frontend Overhaul (Phases 9-14) — SHIPPED 2026-03-13

**Vision:** Extend the token calculator with NIOS Grid backup parsing, live NIOS WAPI scanning, Bluecat and EfficientIP DDI provider support, and a Figma Make frontend redesign with NIOS result panels.

## Success Criteria


## Slices

- [x] **S01: Frontend Extension Api Migration** `risk:medium` `depends:[]`
  > After this: Replace the App.
- [x] **S02: Nios Backend Scanner** `risk:medium` `depends:[S01]`
  > After this: Create the Wave 0 test infrastructure for Phase 10.
- [x] **S03: Frontend Nios Features** `risk:medium` `depends:[S02]`
  > After this: Install vitest test infrastructure, create nios-calc.
- [x] **S04: Nios Wapi Scanner Bluecat Efficientip Providers** `risk:medium` `depends:[S03]`
  > After this: Implement the NIOS WAPI live scanner that connects to a NIOS Grid Manager via REST API, auto-detects the WAPI version, fetches the capacity report, and produces FindingRows + NiosServerMetrics.
- [x] **S05: Fix Bluecat Efficientip Credential Wiring** `risk:medium` `depends:[S04]`
  > After this: Fix credential key name mismatches in server/validate.
- [x] **S06: Phase11 Verification Traceability Cleanup** `risk:medium` `depends:[S05]`
  > After this: Create Phase 11's VERIFICATION.
