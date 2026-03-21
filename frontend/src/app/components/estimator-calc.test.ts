import { describe, it, expect } from 'vitest';
import { calcEstimator, EstimatorDefaults, type ServerEntry } from './estimator-calc';

describe('calcEstimator', () => {

  /**
   * Reference Case A - Small office, DNS+DHCP+IPAM, all logging enabled
   *
   * Inputs: activeIPs=1250, dhcpPct=0.80, enableIPAM=true, enableDNS=true,
   *         enableDNSProtocol=true, enableDHCP=true, enableDHCPLog=true,
   *         sites=5, networksPerSite=4
   *
   * Derivation:
   *   dynamicClients = ceil(1250 x 0.80)  = 1000
   *   staticClients  = 1250 - 1000        = 250
   *   dnsRecords     = (1000 x 4) + (250 x 2) = 4500
   *   dhcpRangeMult  = 2 (both DHCP+IPAM enabled)
   *   rawDdi         = 4500 + (4 x 5 x 2) = 4540
   *   ddiObjects     = round(4540 x 1.15) = round(5221) = 5221
   *   activeIPsOut   = 1250 + (2 x 5 x 4) = 1290
   *   discoveredAssets = 1250 (defaults to activeIPs)
   *   monthlyLogVolume > 0 (DNS+DHCP logging both on)
   */
  it('Case A - small office DNS+DHCP+logging', () => {
    const out = calcEstimator({
      ...EstimatorDefaults,
      activeIPs: 1250,
      dhcpPct: 0.80,
      enableIPAM: true,
      enableDNS: true,
      enableDNSProtocol: true,
      enableDHCP: true,
      enableDHCPLog: true,
      sites: 5,
      networksPerSite: 4,
    });

    expect(out.ddiObjects).toBe(5221);
    expect(out.activeIPs).toBe(1290);
    expect(out.discoveredAssets).toBe(1250);
    expect(out.monthlyLogVolume).toBeGreaterThan(0);
  });

  /**
   * Reference Case B - Medium enterprise, DNS only, no reporting
   */
  it('Case B - medium enterprise DNS only, no logging', () => {
    const out = calcEstimator({
      ...EstimatorDefaults,
      activeIPs: 5000,
      dhcpPct: 0.80,
      enableIPAM: true,
      enableDNS: true,
      enableDNSProtocol: false,
      enableDHCP: false,
      enableDHCPLog: false,
      sites: 10,
      networksPerSite: 6,
    });

    expect(out.ddiObjects).toBe(20700);
    expect(out.activeIPs).toBe(5120);
    expect(out.discoveredAssets).toBe(5000);
    expect(out.monthlyLogVolume).toBe(0);
  });

  /**
   * Reference Case C - No IPAM, DNS only
   */
  it('Case C - no IPAM, DNS only', () => {
    const out = calcEstimator({
      ...EstimatorDefaults,
      activeIPs: 2000,
      dhcpPct: 0.80,
      enableIPAM: false,
      enableDNS: true,
      enableDNSProtocol: false,
      enableDHCP: false,
      enableDHCPLog: false,
      sites: 3,
      networksPerSite: 4,
    });

    expect(out.ddiObjects).toBe(8280);
    expect(out.activeIPs).toBe(0);
    expect(out.discoveredAssets).toBe(0);
    expect(out.monthlyLogVolume).toBe(0);
  });

  /**
   * Reference Case D - 4 identical NIOS-X servers, M tier
   *
   * Each server: qps=35000, lps=250, objects=80000 -> M tier (880 tokens)
   * Total: 880 x 4 = 3520
   */
  it('Case D - 4 NIOS-X servers, M tier server tokens', () => {
    const servers: ServerEntry[] = Array.from({ length: 4 }, (_, i) => ({
      name: `Server ${i + 1}`,
      formFactor: 'nios-x' as const,
      qps: 35000,
      lps: 250,
      objects: 80000,
    }));

    const out = calcEstimator({
      ...EstimatorDefaults,
      serverEntries: servers,
    });

    expect(out.serverTokens).toBe(3520);
    expect(out.serverTokenDetails).toHaveLength(4);
    expect(out.serverTokenDetails[0].tierName).toBe('M');
    expect(out.serverTokenDetails[0].serverTokens).toBe(880);
    // Management tokens should still be calculated normally
    expect(out.ddiObjects).toBeGreaterThan(0);
  });

  /**
   * Reference Case E - 2 identical XaaS instances, S tier
   *
   * Each server: qps=15000, lps=100, objects=20000 -> S tier (2400 tokens)
   * 2 XaaS entries consolidate: aggregate qps=30000, lps=200, objects=40000
   * -> fits M tier (maxQps=40000, maxLps=300, maxObjects=110000)
   *    with 2 connections, M maxConnections=20, so M tier
   * M tier = 4100 tokens for consolidated instance
   */
  it('Case E - 2 XaaS entries consolidated', () => {
    const servers: ServerEntry[] = [
      { name: 'XaaS-1', formFactor: 'nios-xaas', qps: 15000, lps: 100, objects: 20000 },
      { name: 'XaaS-2', formFactor: 'nios-xaas', qps: 15000, lps: 100, objects: 20000 },
    ];

    const out = calcEstimator({
      ...EstimatorDefaults,
      serverEntries: servers,
    });

    // Consolidated: aggregate fits S tier (qps=30000 > S max 20000, so M tier)
    // M tier = 4100 tokens, 2 connections within M's 20 limit
    expect(out.serverTokens).toBe(4100);
    expect(out.serverTokenDetails).toHaveLength(2);
  });

  /**
   * Reference Case F - No servers, no server tokens
   */
  it('Case F - empty entries, no server tokens', () => {
    const out = calcEstimator({
      ...EstimatorDefaults,
      serverEntries: [],
    });

    expect(out.serverTokens).toBe(0);
    expect(out.serverTokenDetails).toHaveLength(0);
  });

  /**
   * Case G - Mixed form factors: 2 NIOS-X + 1 XaaS
   *
   * NIOS-X #1: qps=5000, lps=75, objects=3000 -> 2XS tier (130 tokens)
   * NIOS-X #2: qps=40000, lps=300, objects=110000 -> M tier (880 tokens)
   * XaaS #1:   qps=15000, lps=100, objects=20000 -> S tier (2400 tokens, single instance)
   * Total: 130 + 880 + 2400 = 3410
   */
  it('Case G - mixed NIOS-X and XaaS form factors', () => {
    const servers: ServerEntry[] = [
      { name: 'Branch DNS', formFactor: 'nios-x', qps: 5000, lps: 75, objects: 3000 },
      { name: 'Campus DNS', formFactor: 'nios-x', qps: 40000, lps: 300, objects: 110000 },
      { name: 'Cloud Instance', formFactor: 'nios-xaas', qps: 15000, lps: 100, objects: 20000 },
    ];

    const out = calcEstimator({
      ...EstimatorDefaults,
      serverEntries: servers,
    });

    expect(out.serverTokens).toBe(130 + 880 + 2400);
    expect(out.serverTokenDetails).toHaveLength(3);

    const niosXDetails = out.serverTokenDetails.filter(d => d.formFactor === 'nios-x');
    const xaasDetails = out.serverTokenDetails.filter(d => d.formFactor === 'nios-xaas');
    expect(niosXDetails).toHaveLength(2);
    expect(xaasDetails).toHaveLength(1);

    expect(niosXDetails[0].tierName).toBe('2XS');
    expect(niosXDetails[1].tierName).toBe('M');
    expect(xaasDetails[0].tierName).toBe('S');
  });

  /**
   * Case H - Different-sized NIOS-X servers
   *
   * Validates that each server is sized independently (not averaged).
   * Server 1: qps=5000, lps=50, objects=1000 -> 2XS (130)
   * Server 2: qps=70000, lps=400, objects=440000 -> L (1900)
   * Total: 130 + 1900 = 2030
   */
  it('Case H - different-sized NIOS-X servers sized independently', () => {
    const servers: ServerEntry[] = [
      { name: 'Small Branch', formFactor: 'nios-x', qps: 5000, lps: 50, objects: 1000 },
      { name: 'Data Center', formFactor: 'nios-x', qps: 70000, lps: 400, objects: 440000 },
    ];

    const out = calcEstimator({
      ...EstimatorDefaults,
      serverEntries: servers,
    });

    expect(out.serverTokens).toBe(2030);
    expect(out.serverTokenDetails[0].tierName).toBe('2XS');
    expect(out.serverTokenDetails[0].serverTokens).toBe(130);
    expect(out.serverTokenDetails[1].tierName).toBe('L');
    expect(out.serverTokenDetails[1].serverTokens).toBe(1900);
  });

  /**
   * Case I - serverTokenDetails includes correct input metrics
   */
  it('Case I - details include input QPS/LPS/objects', () => {
    const out = calcEstimator({
      ...EstimatorDefaults,
      serverEntries: [
        { name: 'Test', formFactor: 'nios-x', qps: 12345, lps: 67, objects: 8900 },
      ],
    });

    expect(out.serverTokenDetails).toHaveLength(1);
    expect(out.serverTokenDetails[0].qps).toBe(12345);
    expect(out.serverTokenDetails[0].lps).toBe(67);
    expect(out.serverTokenDetails[0].objects).toBe(8900);
    expect(out.serverTokenDetails[0].name).toBe('Test');
  });

});
