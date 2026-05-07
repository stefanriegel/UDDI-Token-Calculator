import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  VNIOS_SPECS,
  lookupApplianceSpec,
  calcMemberSavings,
  calcFleetSavings,
  canonicalVnioSpecsJSON,
  computeVnioSpecsHash,
  parseTierVCPU,
  parseTierRamGB,
  type MemberInput,
  type MemberSavings,
} from './resource-savings';
import { SERVER_TOKEN_TIERS } from './nios-calc';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const tier2XS = SERVER_TOKEN_TIERS[0]; // 2XS — 3 vCPU / 4 GB
const tierM = SERVER_TOKEN_TIERS[3];   // M   — 4 vCPU / 32 GB

describe('VNIOS_SPECS table', () => {
  it('contains the expected total row count (≥38)', () => {
    expect(VNIOS_SPECS.length).toBeGreaterThanOrEqual(38);
  });

  it('contains all 8 X5/VMware models', () => {
    const x5vm = VNIOS_SPECS.filter(s => s.generation === 'X5' && s.platform === 'VMware');
    expect(x5vm).toHaveLength(8);
  });

  it('contains all 5 X5/Azure models', () => {
    expect(VNIOS_SPECS.filter(s => s.generation === 'X5' && s.platform === 'Azure')).toHaveLength(5);
  });

  it('contains all 5 X5/AWS models', () => {
    expect(VNIOS_SPECS.filter(s => s.generation === 'X5' && s.platform === 'AWS')).toHaveLength(5);
  });

  it('contains all 5 X5/GCP models', () => {
    expect(VNIOS_SPECS.filter(s => s.generation === 'X5' && s.platform === 'GCP')).toHaveLength(5);
  });

  it('contains all 5 X6/VMware models', () => {
    expect(VNIOS_SPECS.filter(s => s.generation === 'X6' && s.platform === 'VMware')).toHaveLength(5);
  });

  it('contains all 5 X6/Azure models', () => {
    expect(VNIOS_SPECS.filter(s => s.generation === 'X6' && s.platform === 'Azure')).toHaveLength(5);
  });

  it('contains all 5 X6/AWS models', () => {
    expect(VNIOS_SPECS.filter(s => s.generation === 'X6' && s.platform === 'AWS')).toHaveLength(5);
  });

  it('contains all 5 X6/GCP models', () => {
    expect(VNIOS_SPECS.filter(s => s.generation === 'X6' && s.platform === 'GCP')).toHaveLength(5);
  });

  it('contains at least one Physical row (IB-4030)', () => {
    const phys = VNIOS_SPECS.filter(s => s.generation === 'Physical');
    expect(phys.length).toBeGreaterThanOrEqual(1);
    expect(phys.find(s => s.model === 'IB-4030')).toBeDefined();
  });

  it('marks IB-V815, IB-V1415, IB-V2215 as vmwareOnly', () => {
    const vmwareOnly = VNIOS_SPECS.filter(s => s.vmwareOnly === true);
    expect(vmwareOnly).toHaveLength(3);
    expect(vmwareOnly.map(s => s.model).sort()).toEqual(['IB-V1415', 'IB-V2215', 'IB-V815']);
  });
});

describe('lookupApplianceSpec', () => {
  it('returns IB-V2326/VMware with 2 variants — Small (12/128) default + Large (20/192)', () => {
    const spec = lookupApplianceSpec('IB-V2326', 'VMware');
    expect(spec).not.toBeNull();
    expect(spec!.variants).toHaveLength(2);
    expect(spec!.defaultVariantIndex).toBe(0);
    expect(spec!.variants[0]).toMatchObject({ configName: 'Small', vCPU: 12, ramGB: 128 });
    expect(spec!.variants[1]).toMatchObject({ configName: 'Large', vCPU: 20, ramGB: 192 });
  });

  it('returns IB-V2225/AWS with 3 variants (r6i 8/64, m5 8/32, r4 8/61)', () => {
    const spec = lookupApplianceSpec('IB-V2225', 'AWS');
    expect(spec).not.toBeNull();
    expect(spec!.variants).toHaveLength(3);
    expect(spec!.variants[0]).toMatchObject({ configName: 'r6i', vCPU: 8, ramGB: 64 });
    expect(spec!.variants[1]).toMatchObject({ configName: 'm5',  vCPU: 8, ramGB: 32 });
    expect(spec!.variants[2]).toMatchObject({ configName: 'r4',  vCPU: 8, ramGB: 61 });
  });

  it('returns IB-V926/GCP with 3 variants (Small 8/16, Medium 8/32, Large 8/64)', () => {
    const spec = lookupApplianceSpec('IB-V926', 'GCP');
    expect(spec).not.toBeNull();
    expect(spec!.variants).toHaveLength(3);
    expect(spec!.variants[0]).toMatchObject({ configName: 'Small',  vCPU: 8, ramGB: 16 });
    expect(spec!.variants[1]).toMatchObject({ configName: 'Medium', vCPU: 8, ramGB: 32 });
    expect(spec!.variants[2]).toMatchObject({ configName: 'Large',  vCPU: 8, ramGB: 64 });
  });

  it('returns IB-V2215/VMware with vmwareOnly=true', () => {
    const spec = lookupApplianceSpec('IB-V2215', 'VMware');
    expect(spec).not.toBeNull();
    expect(spec!.vmwareOnly).toBe(true);
  });

  it('returns null for IB-V2215 on Azure (VMware-only)', () => {
    expect(lookupApplianceSpec('IB-V2215', 'Azure')).toBeNull();
  });

  it('returns null for IB-V1415 on AWS (X5 VMware-only)', () => {
    expect(lookupApplianceSpec('IB-V1415', 'AWS')).toBeNull();
  });

  it('returns null for unknown model', () => {
    expect(lookupApplianceSpec('IB-Unknown-9999', 'VMware')).toBeNull();
  });

  it('returns IB-4030 with generation=Physical, platform=Physical', () => {
    const spec = lookupApplianceSpec('IB-4030', 'Physical');
    expect(spec).not.toBeNull();
    expect(spec!.generation).toBe('Physical');
    expect(spec!.platform).toBe('Physical');
  });
});

describe('calcMemberSavings', () => {
  const member = (model: string, platform: any, id = 'm1', name = 'm1'): MemberInput => ({
    memberId: id, memberName: name, model, platform,
  });

  it('Test 1: VMware X5 IB-V2225 → NIOS-X 2XS exact deltas (8/64 → 3/4)', () => {
    const out = calcMemberSavings(member('IB-V2225', 'VMware'), tier2XS, 'nios-x');
    expect(out.oldVCPU).toBe(8);
    expect(out.oldRamGB).toBe(64);
    expect(out.newVCPU).toBe(3);
    expect(out.newRamGB).toBe(4);
    expect(out.deltaVCPU).toBe(-5);
    expect(out.deltaRamGB).toBe(-60);
    expect(out.physicalDecommission).toBe(false);
    expect(out.fullyManaged).toBe(false);
  });

  it('Test 2: XaaS target — IB-V2326 VMware (12/128) → 0/0, fullyManaged=true', () => {
    const out = calcMemberSavings(member('IB-V2326', 'VMware'), tier2XS, 'nios-xaas');
    expect(out.oldVCPU).toBe(12);
    expect(out.oldRamGB).toBe(128);
    expect(out.newVCPU).toBe(0);
    expect(out.newRamGB).toBe(0);
    expect(out.deltaVCPU).toBe(-12);
    expect(out.deltaRamGB).toBe(-128);
    expect(out.fullyManaged).toBe(true);
  });

  it('Test 3: physical decommission — IB-4030 → physicalDecommission=true', () => {
    const out = calcMemberSavings(member('IB-4030', 'Physical'), tier2XS, 'nios-x');
    expect(out.physicalDecommission).toBe(true);
    expect(out.oldGeneration).toBe('Physical');
  });

  it('Test 4: AWS variant override — IB-V2225 AWS variantIdx=2 (r4) → 8/61', () => {
    const out = calcMemberSavings(member('IB-V2225', 'AWS'), tier2XS, 'nios-x', 2);
    expect(out.oldVCPU).toBe(8);
    expect(out.oldRamGB).toBe(61);
    expect(out.oldVariantIndex).toBe(2);
  });

  it('Test 5: AWS default variant — IB-V2225 AWS undefined → r6i (8/64)', () => {
    const out = calcMemberSavings(member('IB-V2225', 'AWS'), tier2XS, 'nios-x');
    expect(out.oldVCPU).toBe(8);
    expect(out.oldRamGB).toBe(64);
    expect(out.oldVariantIndex).toBe(0);
  });

  it('Test 6: unknown model → lookupMissing=true', () => {
    const out = calcMemberSavings(member('IB-DOESNTEXIST', 'VMware'), tier2XS, 'nios-x');
    expect(out.lookupMissing).toBe(true);
    expect(out.invalidPlatformForModel).toBe(false);
    expect(out.oldVCPU).toBe(0);
    expect(out.oldRamGB).toBe(0);
    expect(out.deltaVCPU).toBe(0);
    expect(out.deltaRamGB).toBe(0);
  });

  it('Test 7: VMware-only on cloud — IB-V2215 / Azure → invalidPlatformForModel=true', () => {
    const out = calcMemberSavings(member('IB-V2215', 'Azure'), tier2XS, 'nios-x');
    expect(out.invalidPlatformForModel).toBe(true);
    expect(out.lookupMissing).toBe(false);
  });

  it('Test 8: empty model string → lookupMissing=true, all zeros', () => {
    const out = calcMemberSavings(member('', 'VMware'), tier2XS, 'nios-x');
    expect(out.lookupMissing).toBe(true);
    expect(out.oldVCPU).toBe(0);
    expect(out.oldRamGB).toBe(0);
    expect(out.deltaVCPU).toBe(0);
    expect(out.deltaRamGB).toBe(0);
  });
});

describe('calcFleetSavings', () => {
  const mk = (input: MemberInput, ff: 'nios-x' | 'nios-xaas', variantIdx?: number): MemberSavings =>
    calcMemberSavings(input, tier2XS, ff, variantIdx);

  it('Test 9: mixed fleet — 2 NIOS-X + 1 XaaS + 1 physical-to-NIOS-X + 1 unknown', () => {
    const fleet: MemberSavings[] = [
      mk({ memberId: 'a', memberName: 'a', model: 'IB-V2225', platform: 'VMware' }, 'nios-x'),
      mk({ memberId: 'b', memberName: 'b', model: 'IB-V1425', platform: 'VMware' }, 'nios-x'),
      mk({ memberId: 'c', memberName: 'c', model: 'IB-V2326', platform: 'VMware' }, 'nios-xaas'),
      mk({ memberId: 'd', memberName: 'd', model: 'IB-4030',  platform: 'Physical' }, 'nios-x'),
      mk({ memberId: 'e', memberName: 'e', model: 'IB-NOPE',  platform: 'VMware' }, 'nios-x'),
    ];
    const out = calcFleetSavings(fleet);
    expect(out.memberCount).toBe(5);
    // Physical members are tracked via physicalUnitsRetired only and are NOT
    // added to niosX/xaas sub-totals (hardware ≠ virtual compute).
    expect(out.niosXSavings.memberCount).toBe(2);
    expect(out.xaasSavings.memberCount).toBe(1);
    expect(out.physicalUnitsRetired).toBe(1);
    expect(out.unknownModels).toHaveLength(1);
    // totalDeltaVCPU is sum of valid virtual members only (excludes unknown
    // AND physical — physical hardware doesn't have vCPU).
    const expectedDelta =
      (3 - 8) + (3 - 4) + (0 - 12); // V2225 + V1425 + V2326-xaas (no IB-4030)
    expect(out.totalDeltaVCPU).toBe(expectedDelta);
  });

  it('Test 10: empty fleet returns zeros, not NaN', () => {
    const out = calcFleetSavings([]);
    expect(out.memberCount).toBe(0);
    expect(out.totalOldVCPU).toBe(0);
    expect(out.totalOldRamGB).toBe(0);
    expect(out.totalNewVCPU).toBe(0);
    expect(out.totalNewRamGB).toBe(0);
    expect(out.totalDeltaVCPU).toBe(0);
    expect(out.totalDeltaRamGB).toBe(0);
    expect(Number.isNaN(out.totalDeltaVCPU)).toBe(false);
    expect(out.niosXSavings).toEqual({ vCPU: 0, ramGB: 0, memberCount: 0 });
    expect(out.xaasSavings).toEqual({ vCPU: 0, ramGB: 0, memberCount: 0 });
    expect(out.physicalUnitsRetired).toBe(0);
    expect(out.unknownModels).toEqual([]);
    expect(out.invalidCombinations).toEqual([]);
  });

  it('Test 11: niosXSavings.vCPU + xaasSavings.vCPU = totalDeltaVCPU', () => {
    const fleet: MemberSavings[] = [
      mk({ memberId: 'a', memberName: 'a', model: 'IB-V2225', platform: 'VMware' }, 'nios-x'),
      mk({ memberId: 'b', memberName: 'b', model: 'IB-V2326', platform: 'VMware' }, 'nios-xaas'),
      mk({ memberId: 'c', memberName: 'c', model: 'IB-V1425', platform: 'Azure' }, 'nios-x'),
    ];
    const out = calcFleetSavings(fleet);
    expect(out.niosXSavings.vCPU + out.xaasSavings.vCPU).toBe(out.totalDeltaVCPU);
    expect(out.niosXSavings.ramGB + out.xaasSavings.ramGB).toBe(out.totalDeltaRamGB);
  });

  it('Test 12: invalid combinations list — IB-V2215/Azure flagged', () => {
    const fleet: MemberSavings[] = [
      mk({ memberId: 'x', memberName: 'x', model: 'IB-V2215', platform: 'Azure' }, 'nios-x'),
    ];
    const out = calcFleetSavings(fleet);
    expect(out.invalidCombinations).toHaveLength(1);
    expect(out.invalidCombinations[0]).toEqual({ model: 'IB-V2215', platform: 'Azure' });
  });
});

describe('lookupApplianceSpec parity', () => {
  it('Test 13: every VNIOS_SPECS row is reachable via lookupApplianceSpec', () => {
    for (const row of VNIOS_SPECS) {
      const found = lookupApplianceSpec(row.model, row.platform);
      expect(found).toBe(row);
    }
  });
});

describe('canonicalVnioSpecsJSON + computeVnioSpecsHash', () => {
  it('Test 14: canonicalVnioSpecsJSON is byte-stable across calls', () => {
    const a = canonicalVnioSpecsJSON();
    const b = canonicalVnioSpecsJSON();
    expect(a).toBe(b);
  });

  it('Test 15: keys appear in alphabetical order in serialized output', () => {
    const json = canonicalVnioSpecsJSON([VNIOS_SPECS[0]]);
    // Spec keys: defaultVariantIndex, generation, model, platform, variants, vmwareOnly
    // First spec is IB-V815/X5/VMware which has vmwareOnly=true.
    const idxDefault = json.indexOf('"defaultVariantIndex"');
    const idxGen = json.indexOf('"generation"');
    const idxModel = json.indexOf('"model"');
    const idxPlat = json.indexOf('"platform"');
    const idxVars = json.indexOf('"variants"');
    const idxVmware = json.indexOf('"vmwareOnly"');
    expect(idxDefault).toBeGreaterThanOrEqual(0);
    expect(idxDefault).toBeLessThan(idxGen);
    expect(idxGen).toBeLessThan(idxModel);
    expect(idxModel).toBeLessThan(idxPlat);
    expect(idxPlat).toBeLessThan(idxVars);
    expect(idxVars).toBeLessThan(idxVmware);
    // Variant keys: configName, ramGB, vCPU (no instanceType in IB-V815 row)
    const idxConfig = json.indexOf('"configName"');
    const idxRam = json.indexOf('"ramGB"');
    const idxVCPU = json.indexOf('"vCPU"');
    expect(idxConfig).toBeLessThan(idxRam);
    expect(idxRam).toBeLessThan(idxVCPU);
  });

  it('Test 16: computeVnioSpecsHash returns 64-char lowercase hex', async () => {
    const hash = await computeVnioSpecsHash();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    // Stability: same input → same hash.
    const hash2 = await computeVnioSpecsHash();
    expect(hash).toBe(hash2);
  });
});

describe('parseTier helpers', () => {
  it('parseTierVCPU parses "3 Core" → 3 and "16 Core" → 16', () => {
    expect(parseTierVCPU(SERVER_TOKEN_TIERS[0])).toBe(3);
    expect(parseTierVCPU(SERVER_TOKEN_TIERS[4])).toBe(16);
  });

  it('parseTierRamGB parses "4 GB" → 4 and "32 GB" → 32', () => {
    expect(parseTierRamGB(SERVER_TOKEN_TIERS[0])).toBe(4);
    expect(parseTierRamGB(tierM)).toBe(32);
  });
});

describe('VNIOS_SPECS canonical hash drift protection', () => {
  it('VNIOS_SPECS hash matches committed file (internal/calculator/vnios_specs.sha256)', async () => {
    // frontend/src/app/components/ → project root is 4 levels up.
    const hashFilePath = resolve(
      __dirname,
      '../../../../internal/calculator/vnios_specs.sha256',
    );
    const fileHash = readFileSync(hashFilePath, 'utf8').trim();
    const computed = await computeVnioSpecsHash();
    expect(
      computed,
      `VNIOS_SPECS hash drift:\n  file=${fileHash} (${hashFilePath})\n  computed=${computed}\n  run 'make verify-vnios-specs' to investigate`,
    ).toBe(fileHash);
  });
});

describe('Lookup fallbacks (added 2026-04-07 for v3.2.1)', () => {
  const baseTier = SERVER_TOKEN_TIERS.find((t) => t.name === 'M')!;
  const baseInput = (model: string, platform: AppliancePlatform) => ({
    memberId: 'm', memberName: 'm', model, platform,
  });

  describe('Trinzic physical family fallback', () => {
    const cases: Array<[string, number, number]> = [
      ['IB-4030', 8, 32],   // explicit placeholder row in VNIOS_SPECS
      ['IB-4010', 16, 128], // family fallback (2 RU)
      ['TE-4020', 16, 128],
      ['T-4030', 16, 128],
      ['IB-2210', 12, 64],
      ['TE-2225', 12, 64],
      ['IB-1410', 4, 16],   // 1 RU families
      ['TE-1420', 4, 16],
      ['T-1810', 4, 16],
      ['IB-815', 4, 16],
      ['TE-825', 4, 16],
    ];
    it.each(cases)('%s resolves to vCPU=%i ramGB=%i', (model, vcpu, ram) => {
      const out = calcMemberSavings(baseInput(model, 'Physical'), baseTier, 'nios-x');
      expect(out.lookupMissing).toBe(false);
      expect(out.invalidPlatformForModel).toBe(false);
      expect(out.oldVCPU).toBe(vcpu);
      expect(out.oldRamGB).toBe(ram);
      expect(out.physicalDecommission).toBe(true);
    });
  });

  describe('AWS legacy alias (IB-V*15 → IB-V*25)', () => {
    const cases: Array<[string, number, number]> = [
      ['IB-V815', 2, 16],   // r6i AWS default
      ['IB-V1415', 4, 32],
      ['IB-V2215', 8, 64],
    ];
    it.each(cases)('%s on AWS aliases to sibling', (legacy, vcpu, ram) => {
      const out = calcMemberSavings(baseInput(legacy, 'AWS'), baseTier, 'nios-x');
      expect(out.lookupMissing).toBe(false);
      expect(out.invalidPlatformForModel).toBe(false);
      expect(out.oldVCPU).toBe(vcpu);
      expect(out.oldRamGB).toBe(ram);
      expect(out.oldModel).toBe(legacy); // original name preserved
    });
  });
});
