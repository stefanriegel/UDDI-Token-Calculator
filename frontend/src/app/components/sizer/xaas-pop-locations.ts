/**
 * xaas-pop-locations.ts — Static PoP list for XaaS Service Points.
 *
 * Source: status.infoblox.com (hardcoded), per
 *   docs/superpowers/specs/2026-04-23-enhanced-manual-sizer-v2-design.md
 *   §Official XaaS PoP Locations (same list as v1 spec — 9 AWS + 2 GCP).
 *
 * Single-source-of-truth frozen constant consumed by XLSX Summary sheet
 * labels (sizer-xlsx-export.ts).
 *
 * The list does NOT change at runtime — `Object.freeze` enforces immutability.
 */

export interface XaasPopLocation {
  /** Stable kebab-case id, e.g. 'aws-us-east-1'. Used for React keys + persistence. */
  id: string;
  provider: 'aws' | 'gcp';
  /** Cloud-provider region code, e.g. 'us-east-1'. */
  regionCode: string;
  /** Human-readable label, e.g. 'US East (N. Virginia)'. */
  label: string;
}

/**
 * AWS (9) + GCP (2) — verbatim from spec §Official XaaS PoP Locations.
 *
 * Order matches the spec list (AWS first, then GCP) to keep diff-noise minimal
 * if Infoblox publishes additions. `regionCode` values use canonical AWS / GCP
 * region identifiers (gcp regions inferred from the spec's geography labels).
 */
export const XAAS_POP_LOCATIONS: readonly XaasPopLocation[] = Object.freeze([
  // AWS (9)
  { id: 'aws-us-east-1', provider: 'aws', regionCode: 'us-east-1', label: 'US East (N. Virginia)' },
  { id: 'aws-us-west-2', provider: 'aws', regionCode: 'us-west-2', label: 'US West (Oregon)' },
  { id: 'aws-ca-central-1', provider: 'aws', regionCode: 'ca-central-1', label: 'Canada (Central)' },
  { id: 'aws-sa-east-1', provider: 'aws', regionCode: 'sa-east-1', label: 'South America (Sao Paulo)' },
  { id: 'aws-ap-south-1', provider: 'aws', regionCode: 'ap-south-1', label: 'Asia Pacific (Mumbai)' },
  { id: 'aws-ap-east-1', provider: 'aws', regionCode: 'ap-east-1', label: 'Asia Pacific (Hong Kong)' },
  { id: 'aws-ap-southeast-1', provider: 'aws', regionCode: 'ap-southeast-1', label: 'Asia Pacific (Singapore)' },
  { id: 'aws-eu-central-1', provider: 'aws', regionCode: 'eu-central-1', label: 'Europe (Frankfurt)' },
  { id: 'aws-eu-west-2', provider: 'aws', regionCode: 'eu-west-2', label: 'Europe (London)' },
  // GCP (2)
  { id: 'gcp-europe-west2', provider: 'gcp', regionCode: 'europe-west2', label: 'Europe (London)' },
  { id: 'gcp-us-west1', provider: 'gcp', regionCode: 'us-west1', label: 'US West (Oregon)' },
] as const);
