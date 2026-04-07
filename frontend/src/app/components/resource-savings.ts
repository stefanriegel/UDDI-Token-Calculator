/**
 * resource-savings.ts — vNIOS appliance specs + resource savings calculations.
 *
 * Pure data + pure computation. No React imports. No side effects. All functions
 * are deterministic and stateless. Used by wizard.tsx (Phase 27) for the
 * Migration Planner Resource Savings panel and headline tile, and mirrored by
 * `internal/calculator/vnios_specs.go` for Excel export (Phase 28).
 *
 * Source of truth: docs/superpowers/specs/2026-04-07-resource-savings-design.md §4.
 * vNIOS X5/X6 vCPU/RAM values captured 2026-04-07 from docs.infoblox.com vNIOS spec pages.
 *
 * The TS and Go modules are kept in lockstep via SHA256 of canonical JSON
 * (`computeVnioSpecsHash`) — see `vnios_specs.sha256` and `make verify-vnios-specs`.
 */

import { SERVER_TOKEN_TIERS, type ServerTokenTier, type ServerFormFactor } from './nios-calc';

// ─── Types ─────────────────────────────────────────────────────────────────────

export type ApplianceGeneration = 'X5' | 'X6' | 'Physical';
export type AppliancePlatform = 'VMware' | 'Azure' | 'AWS' | 'GCP' | 'Physical';

export interface ApplianceVariant {
  /** 'Standard' | 'Small' | 'Medium' | 'Large' | 'r6i' | 'm5' | 'r4' */
  configName: string;
  vCPU: number;
  ramGB: number;
  /** e.g. 'r6i.2xlarge', 'Standard_E16s_v5 / v3', 'n4-highmem-8' */
  instanceType?: string;
  /** Regional fallback for AWS (restricted regions) */
  instanceTypeAlt?: string;
}

export interface ApplianceSpec {
  model: string;
  generation: ApplianceGeneration;
  platform: AppliancePlatform;
  variants: ApplianceVariant[];
  /** Typically 0 (Small / r6i / Standard) */
  defaultVariantIndex: number;
  /** Marker for IB-V815 / IB-V1415 / IB-V2215 (X5 VMware-only models) */
  vmwareOnly?: boolean;
}

/** Input shape for `calcMemberSavings`. Distinct from `MemberSavings` output. */
export interface MemberInput {
  memberId: string;
  memberName: string;
  model: string;
  platform: AppliancePlatform;
}

export interface MemberSavings {
  memberId: string;
  memberName: string;
  // Before
  oldModel: string;
  oldPlatform: AppliancePlatform;
  oldGeneration: ApplianceGeneration;
  oldSpec: ApplianceSpec | null;
  oldVariantIndex: number;
  oldVCPU: number;
  oldRamGB: number;
  // After
  targetFormFactor: ServerFormFactor;
  newTierName: string;
  newVCPU: number;
  newRamGB: number;
  // Delta (negative = savings)
  deltaVCPU: number;
  deltaRamGB: number;
  // Flags
  physicalDecommission: boolean;
  fullyManaged: boolean;
  lookupMissing: boolean;
  invalidPlatformForModel: boolean;
}

export interface FleetSavings {
  memberCount: number;
  totalOldVCPU: number;
  totalOldRamGB: number;
  totalNewVCPU: number;
  totalNewRamGB: number;
  totalDeltaVCPU: number;
  totalDeltaRamGB: number;
  niosXSavings: { vCPU: number; ramGB: number; memberCount: number };
  xaasSavings: { vCPU: number; ramGB: number; memberCount: number };
  physicalUnitsRetired: number;
  unknownModels: string[];
  invalidCombinations: { model: string; platform: string }[];
}

// ─── VNIOS_SPECS lookup table ─────────────────────────────────────────────────
// Source: docs.infoblox.com vNIOS Appliance Specifications, captured 2026-04-07.
// All vCPU/RAM values verbatim from design spec §4.
//
// Single-variant rows use configName 'Standard'. Multi-variant rows use the
// design spec's documented variant labels (Small/Medium/Large for X6,
// r6i/m5/r4 for X5 AWS).
//
// X5 VMware-only models (IB-V815, IB-V1415, IB-V2215) have `vmwareOnly: true`
// and NO cloud-platform rows. `lookupApplianceSpec` returns null for those
// (model, cloud-platform) combos and `calcMemberSavings` flags them as
// `invalidPlatformForModel`.

export const VNIOS_SPECS: ApplianceSpec[] = [
  // ─── X5 / VMware (8 models, 1 'Standard' variant each) ───────────────────
  { model: 'IB-V815',  generation: 'X5', platform: 'VMware', defaultVariantIndex: 0, vmwareOnly: true,
    variants: [{ configName: 'Standard', vCPU: 2,  ramGB: 16  }] },
  { model: 'IB-V825',  generation: 'X5', platform: 'VMware', defaultVariantIndex: 0,
    variants: [{ configName: 'Standard', vCPU: 2,  ramGB: 16  }] },
  { model: 'IB-V1415', generation: 'X5', platform: 'VMware', defaultVariantIndex: 0, vmwareOnly: true,
    variants: [{ configName: 'Standard', vCPU: 4,  ramGB: 32  }] },
  { model: 'IB-V1425', generation: 'X5', platform: 'VMware', defaultVariantIndex: 0,
    variants: [{ configName: 'Standard', vCPU: 4,  ramGB: 32  }] },
  { model: 'IB-V2215', generation: 'X5', platform: 'VMware', defaultVariantIndex: 0, vmwareOnly: true,
    variants: [{ configName: 'Standard', vCPU: 8,  ramGB: 64  }] },
  { model: 'IB-V2225', generation: 'X5', platform: 'VMware', defaultVariantIndex: 0,
    variants: [{ configName: 'Standard', vCPU: 8,  ramGB: 64  }] },
  { model: 'IB-V4015', generation: 'X5', platform: 'VMware', defaultVariantIndex: 0,
    variants: [{ configName: 'Standard', vCPU: 14, ramGB: 128 }] },
  { model: 'IB-V4025', generation: 'X5', platform: 'VMware', defaultVariantIndex: 0,
    variants: [{ configName: 'Standard', vCPU: 14, ramGB: 128 }] },

  // ─── X5 / Azure (5 models, 1 variant each) ───────────────────────────────
  { model: 'IB-V825',  generation: 'X5', platform: 'Azure', defaultVariantIndex: 0,
    variants: [{ configName: 'Standard', vCPU: 2,  ramGB: 14,  instanceType: 'Standard DS11 v2' }] },
  { model: 'IB-V1425', generation: 'X5', platform: 'Azure', defaultVariantIndex: 0,
    variants: [{ configName: 'Standard', vCPU: 4,  ramGB: 28,  instanceType: 'Standard DS12 v2' }] },
  { model: 'IB-V2225', generation: 'X5', platform: 'Azure', defaultVariantIndex: 0,
    variants: [{ configName: 'Standard', vCPU: 8,  ramGB: 56,  instanceType: 'Standard DS13 v2' }] },
  { model: 'IB-V4015', generation: 'X5', platform: 'Azure', defaultVariantIndex: 0,
    variants: [{ configName: 'Standard', vCPU: 16, ramGB: 112, instanceType: 'Standard DS14_v2' }] },
  { model: 'IB-V4025', generation: 'X5', platform: 'Azure', defaultVariantIndex: 0,
    variants: [{ configName: 'Standard', vCPU: 16, ramGB: 112, instanceType: 'Standard DS14_v2' }] },

  // ─── X5 / AWS (5 models × 3 variants: r6i default, m5, r4) ───────────────
  { model: 'IB-V825', generation: 'X5', platform: 'AWS', defaultVariantIndex: 0,
    variants: [
      { configName: 'r6i', vCPU: 2, ramGB: 16,    instanceType: 'r6i.large', instanceTypeAlt: 'r6i.large' },
      { configName: 'm5',  vCPU: 2, ramGB: 8,     instanceType: 'm5.large',  instanceTypeAlt: 'm5.large'  },
      { configName: 'r4',  vCPU: 2, ramGB: 15.25, instanceType: 'r4.large',  instanceTypeAlt: 'i3.large'  },
    ] },
  { model: 'IB-V1425', generation: 'X5', platform: 'AWS', defaultVariantIndex: 0,
    variants: [
      { configName: 'r6i', vCPU: 4, ramGB: 32,   instanceType: 'r6i.xlarge', instanceTypeAlt: 'r6i.xlarge' },
      { configName: 'm5',  vCPU: 4, ramGB: 16,   instanceType: 'm5.xlarge',  instanceTypeAlt: 'm5.xlarge'  },
      { configName: 'r4',  vCPU: 4, ramGB: 30.5, instanceType: 'r4.xlarge',  instanceTypeAlt: 'd2.xlarge / i3.xlarge' },
    ] },
  { model: 'IB-V2225', generation: 'X5', platform: 'AWS', defaultVariantIndex: 0,
    variants: [
      { configName: 'r6i', vCPU: 8, ramGB: 64, instanceType: 'r6i.2xlarge', instanceTypeAlt: 'r6i.2xlarge' },
      { configName: 'm5',  vCPU: 8, ramGB: 32, instanceType: 'm5.2xlarge',  instanceTypeAlt: 'm5.2xlarge'  },
      { configName: 'r4',  vCPU: 8, ramGB: 61, instanceType: 'r4.2xlarge',  instanceTypeAlt: 'd2.2xlarge / i3.2xlarge' },
    ] },
  { model: 'IB-V4015', generation: 'X5', platform: 'AWS', defaultVariantIndex: 0,
    variants: [
      { configName: 'r6i', vCPU: 16, ramGB: 128, instanceType: 'r6i.4xlarge', instanceTypeAlt: 'r6i.4xlarge' },
      { configName: 'm5',  vCPU: 16, ramGB: 64,  instanceType: 'm5.4xlarge',  instanceTypeAlt: 'm5.4xlarge'  },
      { configName: 'r4',  vCPU: 16, ramGB: 122, instanceType: 'r4.4xlarge',  instanceTypeAlt: 'd2.4xlarge / i3.4xlarge' },
    ] },
  { model: 'IB-V4025', generation: 'X5', platform: 'AWS', defaultVariantIndex: 0,
    variants: [
      { configName: 'r6i', vCPU: 16, ramGB: 128, instanceType: 'r6i.4xlarge', instanceTypeAlt: 'r6i.4xlarge' },
      { configName: 'm5',  vCPU: 16, ramGB: 64,  instanceType: 'm5.4xlarge',  instanceTypeAlt: 'm5.4xlarge'  },
      { configName: 'r4',  vCPU: 16, ramGB: 122, instanceType: 'r4.4xlarge',  instanceTypeAlt: 'd2.4xlarge / i3.4xlarge' },
    ] },

  // ─── X5 / GCP (5 models, 1 variant each) ─────────────────────────────────
  { model: 'IB-V825',  generation: 'X5', platform: 'GCP', defaultVariantIndex: 0,
    variants: [{ configName: 'Standard', vCPU: 2,  ramGB: 16,  instanceType: 'n1-highmem-2'  }] },
  { model: 'IB-V1425', generation: 'X5', platform: 'GCP', defaultVariantIndex: 0,
    variants: [{ configName: 'Standard', vCPU: 4,  ramGB: 32,  instanceType: 'n1-highmem-4'  }] },
  { model: 'IB-V2225', generation: 'X5', platform: 'GCP', defaultVariantIndex: 0,
    variants: [{ configName: 'Standard', vCPU: 8,  ramGB: 64,  instanceType: 'n1-highmem-8'  }] },
  { model: 'IB-V4015', generation: 'X5', platform: 'GCP', defaultVariantIndex: 0,
    variants: [{ configName: 'Standard', vCPU: 16, ramGB: 128, instanceType: 'n1-highmem-16' }] },
  { model: 'IB-V4025', generation: 'X5', platform: 'GCP', defaultVariantIndex: 0,
    variants: [{ configName: 'Standard', vCPU: 16, ramGB: 128, instanceType: 'n1-highmem-16' }] },

  // ─── X6 / VMware (5 models × 2 variants: Small default, Large) ──────────
  { model: 'IB-V926',  generation: 'X6', platform: 'VMware', defaultVariantIndex: 0,
    variants: [
      { configName: 'Small', vCPU: 4, ramGB: 32 },
      { configName: 'Large', vCPU: 8, ramGB: 32 },
    ] },
  { model: 'IB-V1516', generation: 'X6', platform: 'VMware', defaultVariantIndex: 0,
    variants: [
      { configName: 'Small', vCPU: 6,  ramGB: 64 },
      { configName: 'Large', vCPU: 12, ramGB: 64 },
    ] },
  { model: 'IB-V1526', generation: 'X6', platform: 'VMware', defaultVariantIndex: 0,
    variants: [
      { configName: 'Small', vCPU: 8,  ramGB: 64 },
      { configName: 'Large', vCPU: 16, ramGB: 64 },
    ] },
  { model: 'IB-V2326', generation: 'X6', platform: 'VMware', defaultVariantIndex: 0,
    variants: [
      { configName: 'Small', vCPU: 12, ramGB: 128 },
      { configName: 'Large', vCPU: 20, ramGB: 192 },
    ] },
  { model: 'IB-V4126', generation: 'X6', platform: 'VMware', defaultVariantIndex: 0,
    variants: [
      { configName: 'Small', vCPU: 16, ramGB: 256 },
      { configName: 'Large', vCPU: 32, ramGB: 384 },
    ] },

  // ─── X6 / Azure (5 models, 1 variant; instanceType encodes "v3 / v5") ───
  { model: 'IB-V926',  generation: 'X6', platform: 'Azure', defaultVariantIndex: 0,
    variants: [{ configName: 'Standard', vCPU: 4,  ramGB: 32,  instanceType: 'Standard_E4s_v3 / Standard_E4s_v5'   }] },
  { model: 'IB-V1516', generation: 'X6', platform: 'Azure', defaultVariantIndex: 0,
    variants: [{ configName: 'Standard', vCPU: 8,  ramGB: 64,  instanceType: 'Standard_E8s_v3 / Standard_E8s_v5'   }] },
  { model: 'IB-V1526', generation: 'X6', platform: 'Azure', defaultVariantIndex: 0,
    variants: [{ configName: 'Standard', vCPU: 16, ramGB: 128, instanceType: 'Standard_E16s_v3 / Standard_E16s_v5' }] },
  { model: 'IB-V2326', generation: 'X6', platform: 'Azure', defaultVariantIndex: 0,
    variants: [{ configName: 'Standard', vCPU: 20, ramGB: 160, instanceType: 'Standard_E20s_v3 / Standard_E20s_v5' }] },
  { model: 'IB-V4126', generation: 'X6', platform: 'Azure', defaultVariantIndex: 0,
    variants: [{ configName: 'Standard', vCPU: 32, ramGB: 256, instanceType: 'Standard_E32s_v3 / Standard_E32s_v5' }] },

  // ─── X6 / AWS (5 models × 2 variants: Small default, Large) ─────────────
  { model: 'IB-V926',  generation: 'X6', platform: 'AWS', defaultVariantIndex: 0,
    variants: [
      { configName: 'Small', vCPU: 4, ramGB: 32, instanceType: 'r6i.xlarge / r7i.xlarge' },
      { configName: 'Large', vCPU: 8, ramGB: 32, instanceType: 'm6i.2xlarge / m7i.2xlarge', instanceTypeAlt: 'm5.2xlarge' },
    ] },
  { model: 'IB-V1516', generation: 'X6', platform: 'AWS', defaultVariantIndex: 0,
    variants: [
      { configName: 'Small', vCPU: 8,  ramGB: 64, instanceType: 'r6i.2xlarge / r7i.2xlarge' },
      { configName: 'Large', vCPU: 16, ramGB: 64, instanceType: 'm6i.4xlarge / m7i.4xlarge', instanceTypeAlt: 'm5.4xlarge' },
    ] },
  { model: 'IB-V1526', generation: 'X6', platform: 'AWS', defaultVariantIndex: 0,
    variants: [
      { configName: 'Small', vCPU: 16, ramGB: 64,  instanceType: 'm6i.4xlarge / m7i.4xlarge' },
      { configName: 'Large', vCPU: 16, ramGB: 128, instanceType: 'r6i.4xlarge / r7i.4xlarge', instanceTypeAlt: 'r5d.4xlarge' },
    ] },
  { model: 'IB-V2326', generation: 'X6', platform: 'AWS', defaultVariantIndex: 0,
    variants: [
      { configName: 'Small', vCPU: 32, ramGB: 128, instanceType: 'm6i.8xlarge / m7i.8xlarge' },
      { configName: 'Large', vCPU: 32, ramGB: 256, instanceType: 'r6i.8xlarge / r7i.8xlarge', instanceTypeAlt: 'r5d.8xlarge' },
    ] },
  { model: 'IB-V4126', generation: 'X6', platform: 'AWS', defaultVariantIndex: 0,
    variants: [
      { configName: 'Small', vCPU: 32, ramGB: 256, instanceType: 'r6i.8xlarge / r7i.8xlarge' },
      { configName: 'Large', vCPU: 48, ramGB: 384, instanceType: 'r6i.12xlarge / r7i.12xlarge', instanceTypeAlt: 'r5d.12xlarge' },
    ] },

  // ─── X6 / GCP (5 models × 3 variants: Small default, Medium, Large) ─────
  { model: 'IB-V926',  generation: 'X6', platform: 'GCP', defaultVariantIndex: 0,
    variants: [
      { configName: 'Small',  vCPU: 8, ramGB: 16, instanceType: 'n4-highcpu-8'  },
      { configName: 'Medium', vCPU: 8, ramGB: 32, instanceType: 'n4-standard-8' },
      { configName: 'Large',  vCPU: 8, ramGB: 64, instanceType: 'n4-highmem-8'  },
    ] },
  { model: 'IB-V1516', generation: 'X6', platform: 'GCP', defaultVariantIndex: 0,
    variants: [
      { configName: 'Small',  vCPU: 16, ramGB: 32,  instanceType: 'n4-highcpu-16'  },
      { configName: 'Medium', vCPU: 16, ramGB: 64,  instanceType: 'n4-standard-16' },
      { configName: 'Large',  vCPU: 16, ramGB: 128, instanceType: 'n4-highmem-16'  },
    ] },
  { model: 'IB-V1526', generation: 'X6', platform: 'GCP', defaultVariantIndex: 0,
    variants: [
      { configName: 'Small',  vCPU: 16, ramGB: 64,  instanceType: 'n4-standard-16' },
      { configName: 'Medium', vCPU: 16, ramGB: 128, instanceType: 'n4-highmem-16'  },
      { configName: 'Large',  vCPU: 32, ramGB: 64,  instanceType: 'n4-highcpu-32'  },
    ] },
  { model: 'IB-V2326', generation: 'X6', platform: 'GCP', defaultVariantIndex: 0,
    variants: [
      { configName: 'Small',  vCPU: 32, ramGB: 64,  instanceType: 'n4-highcpu-32'  },
      { configName: 'Medium', vCPU: 32, ramGB: 128, instanceType: 'n4-standard-32' },
      { configName: 'Large',  vCPU: 32, ramGB: 256, instanceType: 'n4-highmem-32'  },
    ] },
  { model: 'IB-V4126', generation: 'X6', platform: 'GCP', defaultVariantIndex: 0,
    variants: [
      { configName: 'Small',  vCPU: 64, ramGB: 512, instanceType: 'n4-standard-64' },
      { configName: 'Medium', vCPU: 80, ramGB: 160, instanceType: 'n4-standard-80' },
      { configName: 'Large',  vCPU: 80, ramGB: 320, instanceType: 'n4-standard-80' },
    ] },

  // ─── Physical (Trinzic chassis) ──────────────────────────────────────────
  // TODO: verify IB-4030 specs against Trinzic datasheet (placeholder values).
  // Additional physical models added as encountered in scanner test data.
  { model: 'IB-4030', generation: 'Physical', platform: 'Physical', defaultVariantIndex: 0,
    variants: [{ configName: 'Standard', vCPU: 8, ramGB: 32 }] },
];

// ─── Lookup ────────────────────────────────────────────────────────────────────

/**
 * Linear search for an exact (model, platform) match in VNIOS_SPECS.
 * Returns null if no row exists.
 *
 * VMware-only X5 models (IB-V815, IB-V1415, IB-V2215) only have a VMware row;
 * cloud-platform lookups for those models return null. The caller distinguishes
 * "unknown model" from "VMware-only on cloud" by checking whether any row
 * exists for the model on a different platform — see `calcMemberSavings`.
 */
export function lookupApplianceSpec(model: string, platform: AppliancePlatform): ApplianceSpec | null {
  for (const spec of VNIOS_SPECS) {
    if (spec.model === model && spec.platform === platform) return spec;
  }
  return null;
}

/** Returns true iff at least one VNIOS_SPECS row exists for `model` on any platform. */
function modelExistsOnAnyPlatform(model: string): boolean {
  for (const spec of VNIOS_SPECS) {
    if (spec.model === model) return true;
  }
  return false;
}

// ─── Tier parsing helpers ──────────────────────────────────────────────────────

/**
 * Parse `ServerTokenTier.cpu` (e.g. '3 Core', '16 Core', '24 Core') to a number.
 * Used by `calcMemberSavings` for the NIOS-X "after" side.
 */
export function parseTierVCPU(tier: ServerTokenTier): number {
  const match = tier.cpu.match(/(\d+(?:\.\d+)?)/);
  return match ? parseFloat(match[1]) : 0;
}

/**
 * Parse `ServerTokenTier.ram` (e.g. '4 GB', '32 GB') to a number of GB.
 * Used by `calcMemberSavings` for the NIOS-X "after" side.
 */
export function parseTierRamGB(tier: ServerTokenTier): number {
  const match = tier.ram.match(/(\d+(?:\.\d+)?)/);
  return match ? parseFloat(match[1]) : 0;
}

// ─── Calc functions ────────────────────────────────────────────────────────────

/**
 * Compute per-member resource savings from migrating an existing NIOS appliance
 * to a target NIOS-X tier or NIOS-XaaS.
 *
 * Semantics (design spec §4, §7; CONTEXT.md D-15..D-19, D-21):
 * - `variantIdx` is optional; if absent, uses `spec.defaultVariantIndex`.
 * - NIOS-XaaS targets always produce newVCPU=0, newRamGB=0, fullyManaged=true.
 * - `physicalDecommission = (oldGeneration === 'Physical')`.
 * - Empty model string → lookupMissing=true, all old/delta values 0.
 * - Unknown model (non-empty) → lookupMissing=true, all old/delta values 0.
 * - VMware-only X5 model on cloud platform → invalidPlatformForModel=true,
 *   all old/delta values 0.
 */
export function calcMemberSavings(
  member: MemberInput,
  tier: ServerTokenTier,
  formFactor: ServerFormFactor,
  variantIdx?: number,
): MemberSavings {
  const isXaas = formFactor === 'nios-xaas';
  const newVCPU = isXaas ? 0 : parseTierVCPU(tier);
  const newRamGB = isXaas ? 0 : parseTierRamGB(tier);

  // Empty model — sentinel, excluded silently.
  if (member.model === '') {
    return {
      memberId: member.memberId,
      memberName: member.memberName,
      oldModel: '',
      oldPlatform: member.platform,
      oldGeneration: 'Physical', // placeholder; not meaningful when lookupMissing
      oldSpec: null,
      oldVariantIndex: 0,
      oldVCPU: 0,
      oldRamGB: 0,
      targetFormFactor: formFactor,
      newTierName: tier.name,
      newVCPU: 0,
      newRamGB: 0,
      deltaVCPU: 0,
      deltaRamGB: 0,
      physicalDecommission: false,
      fullyManaged: isXaas,
      lookupMissing: true,
      invalidPlatformForModel: false,
    };
  }

  const spec = lookupApplianceSpec(member.model, member.platform);

  if (spec === null) {
    // Distinguish "unknown model" from "VMware-only model on cloud platform".
    const knownElsewhere = modelExistsOnAnyPlatform(member.model);
    return {
      memberId: member.memberId,
      memberName: member.memberName,
      oldModel: member.model,
      oldPlatform: member.platform,
      oldGeneration: 'Physical', // placeholder
      oldSpec: null,
      oldVariantIndex: 0,
      oldVCPU: 0,
      oldRamGB: 0,
      targetFormFactor: formFactor,
      newTierName: tier.name,
      newVCPU: 0,
      newRamGB: 0,
      deltaVCPU: 0,
      deltaRamGB: 0,
      physicalDecommission: false,
      fullyManaged: isXaas,
      lookupMissing: !knownElsewhere,
      invalidPlatformForModel: knownElsewhere,
    };
  }

  const idx = variantIdx ?? spec.defaultVariantIndex;
  const variant = spec.variants[idx] ?? spec.variants[spec.defaultVariantIndex];
  const oldVCPU = variant.vCPU;
  const oldRamGB = variant.ramGB;

  return {
    memberId: member.memberId,
    memberName: member.memberName,
    oldModel: member.model,
    oldPlatform: member.platform,
    oldGeneration: spec.generation,
    oldSpec: spec,
    oldVariantIndex: idx,
    oldVCPU,
    oldRamGB,
    targetFormFactor: formFactor,
    newTierName: tier.name,
    newVCPU,
    newRamGB,
    deltaVCPU: newVCPU - oldVCPU,
    deltaRamGB: newRamGB - oldRamGB,
    physicalDecommission: spec.generation === 'Physical',
    fullyManaged: isXaas,
    lookupMissing: false,
    invalidPlatformForModel: false,
  };
}

/**
 * Aggregate per-member savings into fleet totals.
 *
 * Semantics (design spec §4, §7; CONTEXT.md D-20, D-21):
 * - Members with `lookupMissing` are excluded from totals; their identifier
 *   (memberName or memberId or model) is added to `unknownModels[]`.
 * - Members with `invalidPlatformForModel` are excluded from totals;
 *   `{model, platform}` is added to `invalidCombinations[]`.
 * - Otherwise: oldVCPU/oldRamGB/newVCPU/newRamGB/deltaVCPU/deltaRamGB are
 *   summed into the fleet totals AND into the niosX or xaas sub-bucket.
 * - `physicalDecommission` members increment `physicalUnitsRetired`.
 * - `memberCount = members.length` (includes excluded members).
 * - Empty fleet returns zeros (not NaN).
 */
export function calcFleetSavings(members: MemberSavings[]): FleetSavings {
  const result: FleetSavings = {
    memberCount: members.length,
    totalOldVCPU: 0,
    totalOldRamGB: 0,
    totalNewVCPU: 0,
    totalNewRamGB: 0,
    totalDeltaVCPU: 0,
    totalDeltaRamGB: 0,
    niosXSavings: { vCPU: 0, ramGB: 0, memberCount: 0 },
    xaasSavings: { vCPU: 0, ramGB: 0, memberCount: 0 },
    physicalUnitsRetired: 0,
    unknownModels: [],
    invalidCombinations: [],
  };

  for (const m of members) {
    if (m.lookupMissing) {
      const label = m.oldModel !== '' ? m.oldModel : (m.memberName || m.memberId || '(unnamed)');
      result.unknownModels.push(label);
      continue;
    }
    if (m.invalidPlatformForModel) {
      result.invalidCombinations.push({ model: m.oldModel, platform: m.oldPlatform });
      continue;
    }

    result.totalOldVCPU += m.oldVCPU;
    result.totalOldRamGB += m.oldRamGB;
    result.totalNewVCPU += m.newVCPU;
    result.totalNewRamGB += m.newRamGB;
    result.totalDeltaVCPU += m.deltaVCPU;
    result.totalDeltaRamGB += m.deltaRamGB;

    if (m.physicalDecommission) {
      result.physicalUnitsRetired += 1;
    }

    if (m.fullyManaged) {
      result.xaasSavings.vCPU += m.deltaVCPU;
      result.xaasSavings.ramGB += m.deltaRamGB;
      result.xaasSavings.memberCount += 1;
    } else {
      result.niosXSavings.vCPU += m.deltaVCPU;
      result.niosXSavings.ramGB += m.deltaRamGB;
      result.niosXSavings.memberCount += 1;
    }
  }

  return result;
}

// ─── Canonical JSON + SHA256 (drift protection) ────────────────────────────────
// Per CONTEXT.md D-10: TS uses a custom serializer with sorted keys and stable
// field ordering. The Go side (Phase 26-02) mirrors this byte-for-byte. Both
// test suites assert against the committed `vnios_specs.sha256` value.

const SPEC_KEY_ORDER: ReadonlyArray<keyof ApplianceSpec> = [
  'defaultVariantIndex',
  'generation',
  'model',
  'platform',
  'variants',
  'vmwareOnly',
];

const VARIANT_KEY_ORDER: ReadonlyArray<keyof ApplianceVariant> = [
  'configName',
  'instanceType',
  'instanceTypeAlt',
  'ramGB',
  'vCPU',
];

function serializePrimitive(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  throw new Error(`canonicalVnioSpecsJSON: unsupported primitive type ${typeof value}`);
}

function serializeVariant(v: ApplianceVariant): string {
  const parts: string[] = [];
  for (const key of VARIANT_KEY_ORDER) {
    const val = v[key];
    if (val === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${serializePrimitive(val)}`);
  }
  return `{${parts.join(',')}}`;
}

function serializeSpec(s: ApplianceSpec): string {
  const parts: string[] = [];
  for (const key of SPEC_KEY_ORDER) {
    const val = s[key];
    if (val === undefined) continue;
    if (key === 'variants') {
      const arr = (val as ApplianceVariant[]).map(serializeVariant).join(',');
      parts.push(`${JSON.stringify(key)}:[${arr}]`);
    } else {
      parts.push(`${JSON.stringify(key)}:${serializePrimitive(val)}`);
    }
  }
  return `{${parts.join(',')}}`;
}

/**
 * Custom serializer producing canonical JSON for `VNIOS_SPECS`.
 *
 * Object keys appear in fixed alphabetical order (per `SPEC_KEY_ORDER` and
 * `VARIANT_KEY_ORDER`). Undefined fields are omitted entirely (no
 * `"vmwareOnly":undefined`). No whitespace. Array element order is preserved.
 *
 * Output is byte-identical to the Go-side canonical JSON (Phase 26-02).
 */
export function canonicalVnioSpecsJSON(specs: ApplianceSpec[] = VNIOS_SPECS): string {
  return `[${specs.map(serializeSpec).join(',')}]`;
}

/**
 * SHA256 hex digest of `canonicalVnioSpecsJSON(specs)`.
 *
 * Uses the Web Crypto API (`globalThis.crypto.subtle.digest`) which is
 * available in modern browsers AND Node 18+ (vitest's node environment).
 * Returns a 64-character lowercase hex string. The committed
 * `vnios_specs.sha256` file MUST match this value; both TS and Go test
 * suites enforce parity.
 */
export async function computeVnioSpecsHash(specs: ApplianceSpec[] = VNIOS_SPECS): Promise<string> {
  const json = canonicalVnioSpecsJSON(specs);
  const bytes = new TextEncoder().encode(json);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  const view = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < view.length; i++) {
    hex += view[i].toString(16).padStart(2, '0');
  }
  return hex;
}
