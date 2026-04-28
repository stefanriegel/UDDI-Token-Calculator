/**
 * sizer-types.ts — Dependency-free type library for the Sizer core.
 *
 * Transcribed verbatim from the v2 spec §Data Model in
 * `docs/superpowers/specs/2026-04-23-enhanced-manual-sizer-v2-design.md`.
 *
 * Per Phase 29 CONTEXT decisions:
 *   - D-04: Nested tree (Region → Country → City → Site), UUIDs, children embedded.
 *   - D-06: `(Unassigned)` Country and City placeholders are real nodes with a stable
 *           sentinel name — not synthesized at render time.
 *   - D-09: `DeriveOverrides` is a dedicated type containing only derivable fields;
 *           it is NOT `Partial<Site>`.
 *   - D-16: `Issue` shape is exact and used by `sizer-validate.ts` (plan 29-05).
 *
 * This file is pure declarations — the only runtime export is the
 * `UNASSIGNED_PLACEHOLDER` sentinel constant. Validation logic lives in
 * `sizer-validate.ts` (D-13); calc logic lives in `sizer-calc.ts`.
 */

import type { ServerFormFactor } from '../shared/token-tiers';

// ─── Sentinels ─────────────────────────────────────────────────────────────────

/**
 * Stable sentinel name for `(Unassigned)` Country and City nodes.
 * Per D-06: these placeholders exist as real nodes in the tree so the Phase 30
 * UI, clipboard JSON, and scan-import merge logic can all address them uniformly.
 */
export const UNASSIGNED_PLACEHOLDER = '(Unassigned)' as const;

// ─── Tree — D-04 (spec §Data Model) ────────────────────────────────────────────

/**
 * Root of the Sizer state tree. Per spec §Data Model.
 *
 * `infrastructure` is REQUIRED (not optional) per plan-check B-3 so that the
 * validator (plan 29-05) and calc engine (plan 29-04) can reference
 * `state.infrastructure.niosx` / `state.infrastructure.xaas` without
 * optional-chaining. Phase 30 factories default both arrays to `[]`.
 */
export interface SizerState {
  regions: Region[];
  globalSettings: GlobalSettings;
  security: SecurityInputs;
  /**
   * D-08 / plan-check B-3: explicit infrastructure field gives the validator
   * (29-05) and calc (29-04) a well-typed home for NIOS-X systems and XaaS
   * service points. Phase 30+ UI persists these here.
   */
  infrastructure: {
    niosx: NiosXSystem[];
    xaas: XaasServicePoint[];
  };
}

/** D-04 / spec §Data Model — top-level geo/cloud grouping. */
export interface Region {
  /** `crypto.randomUUID()` — generated at Phase 30 factory time. */
  id: string;
  name: string;
  /** Per SIZER-01: enum of supported deployment substrates. */
  type: 'on-premises' | 'aws' | 'azure' | 'gcp';
  /**
   * When `true` for a cloud Region, DNS objects are satisfied by the cloud
   * provider's native DNS and are excluded from Sizer management totals.
   */
  cloudNativeDns: boolean;
  countries: Country[];
}

/** D-04 / spec §Data Model — second tree level. */
export interface Country {
  id: string;
  /** May equal `UNASSIGNED_PLACEHOLDER` per D-06. */
  name: string;
  cities: City[];
}

/** D-04 / spec §Data Model — third tree level. */
export interface City {
  id: string;
  /** May equal `UNASSIGNED_PLACEHOLDER` per D-06. */
  name: string;
  sites: Site[];
}

/**
 * D-04 / spec §Data Model — leaf node, the unit of sizing.
 *
 * Invariant (validated in `sizer-validate.ts` per D-14): `users` OR `activeIPs`
 * must be defined. Derive engine (plan 29-03) populates the remaining fields
 * from `users` plus any per-field `DeriveOverrides`.
 *
 * Per RESEARCH open Q2 (RESOLVED → stored-and-overridable): `assets`,
 * `verifiedAssets`, `unverifiedAssets` are stored on the Site so the derive
 * engine can populate them and the calc engine can read them without
 * re-deriving on each call.
 */
export interface Site {
  id: string;
  name: string;
  /** Clone count N — the Site is treated as N identical sites at calc time. */
  multiplier: number;
  users?: number;
  activeIPs?: number;
  qps?: number;
  lps?: number;
  /** Stored-and-overridable per RESEARCH open Q2. */
  assets?: number;
  verifiedAssets?: number;
  unverifiedAssets?: number;
  dhcpPct?: number;
  dnsZones?: number;
  networksPerSite?: number;
  dnsRecords?: number;
  dhcpScopes?: number;
  avgLeaseDuration?: number;
  qpsPerIP?: number;
}

// ─── NIOS-X & XaaS — consumed by calc + validator ──────────────────────────────

/**
 * A NIOS-X physical/virtual appliance assigned to a Site. Shape is the minimum
 * required by plan 29-04 calc and plan 29-05 validator; Phase 30+ UI may extend.
 */
export interface NiosXSystem {
  id: string;
  name: string;
  /** FK into a Site — validator flags orphans. */
  siteId: string;
  /** Per D-10: `ServerFormFactor` owned by `shared/token-tiers.ts`. */
  formFactor: ServerFormFactor;
  /** Key into `SERVER_TOKEN_TIERS` (e.g. '2XS', 'XS', 'S', 'M', 'L', 'XL'). */
  tierName: string;
  /**
   * When `true`, the user has explicitly picked a tier; auto-derive in Step 3
   * leaves it alone. When `undefined`/`false`, the row auto-derives `tierName`
   * from the assigned Site's QPS/LPS/Object load.
   */
  tierManual?: boolean;
  /**
   * Issue #10: pass-through workload metrics captured at NIOS → Sizer import
   * time. Site fields (`activeIPs`, `dnsRecords`, `qps`, `lps`) only round-trip
   * a subset; this object preserves the rest so `deriveMembersFromNiosx` can
   * surface them in the Sizer-mode planner / member-detail cards. Optional —
   * green-field Sizer flows leave it undefined and per-member cards fall back
   * to the synthesized defaults.
   */
  importedMetrics?: NiosImportedMetrics;
}

/**
 * Workload metrics captured from a NIOS scan at import time and tunneled
 * through the Sizer's NiosXSystem so the report surface (planner / member
 * details) can render them without re-fetching scan state.
 *
 * Mirrors the subset of `NiosServerMetrics` (`../nios-calc.ts`) that isn't
 * representable on the Sizer Site shape.
 */
export interface NiosImportedMetrics {
  role?: string;
  model?: string;
  platform?: string;
  managedIPCount?: number;
  staticHosts?: number;
  dynamicHosts?: number;
  dhcpUtilization?: number;
  licenses?: Record<string, boolean>;
}

/**
 * Connectivity option between a Site and its XaaS service point.
 * - `vpn`  → IPsec VPN (universal, default)
 * - `tgw`  → AWS Transit Gateway (AWS-only)
 *
 * Drives the Connectivity Select in the XaaS card UI.
 */
export type XaasConnectivity = 'vpn' | 'tgw';

/**
 * A XaaS (BloxOne DDI-as-a-Service) service point attached to a Region.
 * Validator (plan 29-05) uses `connectedSiteIds` for SITE_UNASSIGNED and
 * `connections` + `tierName` → XAAS_TOKEN_TIERS lookup for XAAS_OVER_CONNECTIONS.
 */
export interface XaasServicePoint {
  id: string;
  name: string;
  /** FK into a Region — validator flags orphans. */
  regionId: string;
  /** Key into `XAAS_TOKEN_TIERS` (e.g. 'S', 'M', 'L', 'XL'). */
  tierName: string;
  /** Connections in use; compared to `tier.maxConnections` (D-15 warning). */
  connections: number;
  /** Sites served by this service point; empty → SITE_UNASSIGNED. */
  connectedSiteIds: string[];
  /** Site→XaaS link type. Defaults to `'vpn'` for new + imported service points. */
  connectivity: XaasConnectivity;
  /**
   * Stable id from `XAAS_POP_LOCATIONS`. Identifies the Infoblox PoP this
   * service point lives in (e.g. `'aws-us-east-1'`). Defaults to the first
   * AWS PoP for new + imported service points.
   */
  popLocation: string;
}

// ─── Security — spec §Security Tokens ──────────────────────────────────────────

/** Security-related inputs feeding `calculateSecurityTokens` (plan 29-04). */
export interface SecurityInputs {
  securityEnabled: boolean;
  socInsightsEnabled: boolean;
  /** Threat Defense verified assets — per spec §Security Tokens. */
  tdVerifiedAssets: number;
  /** Threat Defense unverified assets. */
  tdUnverifiedAssets: number;
  dossierQueriesPerDay: number;
  lookalikeDomainsMentioned: number;
}

// ─── Global settings — D-07 per-category overhead fallback ─────────────────────

/**
 * Global knobs applied across all Regions. Per D-07: when
 * `growthBufferAdvanced === false`, each `*Overhead` field falls back to
 * `growthBuffer`. `resolveOverheads` (in `sizer-calc.ts`) encapsulates this.
 */
export interface GlobalSettings {
  /** Fraction in [0, 1], applied as (1 + growthBuffer) multiplier. */
  growthBuffer: number;
  /**
   * When `false`, per-category overheads fall back to `growthBuffer`.
   * When `true`, per-category overheads are used directly (still falling
   * back to `growthBuffer` if `undefined`).
   */
  growthBufferAdvanced: boolean;
  mgmtOverhead?: number;
  serverOverhead?: number;
  reportingOverhead?: number;
  securityOverhead?: number;
  // ─ Reporting destination toggles (spec §Reporting) ─
  reportingCsp?: boolean;
  reportingS3?: boolean;
  reportingCdc?: boolean;
  // ─ Logging toggles (spec §Reporting) ─
  dnsLoggingEnabled?: boolean;
  dhcpLoggingEnabled?: boolean;
}

// ─── Derive — D-09 dedicated type ──────────────────────────────────────────────

/**
 * Fields that `deriveFromUsers(users, overrides?)` (plan 29-03) accepts as
 * per-field overrides. Per D-09 this is a dedicated type, NOT `Partial<Site>`,
 * because only a subset of Site fields are derivable. Per-field overrides
 * always win over computed values.
 */
export interface DeriveOverrides {
  activeIPs?: number;
  qps?: number;
  assets?: number;
  networksPerSite?: number;
  dnsZones?: number;
  dhcpScopes?: number;
  dhcpPct?: number;
  avgLeaseDuration?: number;
  lps?: number;
}

// ─── Validation — D-16 exact shape ─────────────────────────────────────────────

/**
 * D-16 exact shape. `path` is a dot-path into `SizerState`
 * (e.g. `"regions[0].countries[1].sites[0]"`) so the Phase 30 UI can
 * scroll/highlight the offending node.
 */
export interface Issue {
  /** Stable machine-readable code (e.g. `"SITE_MISSING_SEED"`). */
  code: string;
  severity: 'error' | 'warning';
  /** Dot-path into `SizerState` — e.g. `"regions[0].countries[1].sites[0]"`. */
  path: string;
  /** Human-readable English message; UI may localize at presentation time. */
  message: string;
}

/*
 * ─── Usage example (documentation only — not runtime code) ────────────────────
 *
 * A minimal valid SizerState with a single on-premises Region containing
 * (Unassigned) Country + City placeholders and one Site seeded by `users`:
 *
 *   const state: SizerState = {
 *     regions: [
 *       {
 *         id: crypto.randomUUID(),
 *         name: 'NA',
 *         type: 'on-premises',
 *         cloudNativeDns: false,
 *         countries: [
 *           {
 *             id: crypto.randomUUID(),
 *             name: UNASSIGNED_PLACEHOLDER,
 *             cities: [
 *               {
 *                 id: crypto.randomUUID(),
 *                 name: UNASSIGNED_PLACEHOLDER,
 *                 sites: [
 *                   {
 *                     id: crypto.randomUUID(),
 *                     name: 'HQ',
 *                     multiplier: 1,
 *                     users: 1500,
 *                   },
 *                 ],
 *               },
 *             ],
 *           },
 *         ],
 *       },
 *     ],
 *     globalSettings: {
 *       growthBuffer: 0.2,
 *       growthBufferAdvanced: false,
 *     },
 *     security: {
 *       securityEnabled: false,
 *       socInsightsEnabled: false,
 *       tdVerifiedAssets: 0,
 *       tdUnverifiedAssets: 0,
 *       dossierQueriesPerDay: 0,
 *       lookalikeDomainsMentioned: 0,
 *     },
 *     infrastructure: {
 *       niosx: [],
 *       xaas: [],
 *     },
 *   };
 */
