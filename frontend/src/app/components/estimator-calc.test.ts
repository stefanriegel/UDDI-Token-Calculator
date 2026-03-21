import { describe, it, expect } from 'vitest';
import { calcEstimator } from './estimator-calc';

describe('calcEstimator', () => {

  /**
   * Reference Case A — Small office, DNS+DHCP+IPAM, all logging enabled
   *
   * Inputs: activeIPs=1250, dhcpPct=0.80, enableIPAM=true, enableDNS=true,
   *         enableDNSProtocol=true, enableDHCP=true, enableDHCPLog=true,
   *         sites=5, networksPerSite=4
   *
   * Derivation:
   *   dynamicClients = ceil(1250 × 0.80)  = 1000
   *   staticClients  = 1250 - 1000        = 250
   *   dnsRecords     = (1000 × 4) + (250 × 2) = 4500
   *   dhcpRangeMult  = 2 (both DHCP+IPAM enabled)
   *   rawDdi         = 4500 + (4 × 5 × 2) = 4540
   *   ddiObjects     = round(4540 × 1.15) = round(5221) = 5221
   *   activeIPsOut   = 1250 + (2 × 5 × 4) = 1290
   *   discoveredAssets = 1250 (defaults to activeIPs)
   *   monthlyLogVolume > 0 (DNS+DHCP logging both on)
   */
  it('Case A — small office DNS+DHCP+logging', () => {
    const out = calcEstimator({
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
   * Reference Case B — Medium enterprise, DNS only, no reporting
   *
   * Inputs: activeIPs=5000, dhcpPct=0.80, enableIPAM=true, enableDNS=true,
   *         enableDNSProtocol=false, enableDHCP=false, enableDHCPLog=false,
   *         sites=10, networksPerSite=6
   *
   * Derivation:
   *   dynamicClients = ceil(5000 × 0.80)  = 4000
   *   staticClients  = 5000 - 4000        = 1000
   *   dnsRecords     = (4000 × 4) + (1000 × 2) = 18000
   *   dhcpRangeMult  = 0 (DHCP disabled)
   *   rawDdi         = 18000 + 0 = 18000
   *   ddiObjects     = round(18000 × 1.15) = round(20700) = 20700
   *   activeIPsOut   = 5000 + (2 × 10 × 6) = 5120
   *   discoveredAssets = 5000
   *   monthlyLogVolume = 0 (no logging)
   */
  it('Case B — medium enterprise DNS only, no logging', () => {
    const out = calcEstimator({
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
   * Reference Case C — No IPAM, DNS only
   *
   * Inputs: activeIPs=2000, dhcpPct=0.80, enableIPAM=false, enableDNS=true,
   *         enableDNSProtocol=false, enableDHCP=false, enableDHCPLog=false,
   *         sites=3, networksPerSite=4
   *
   * Derivation:
   *   dynamicClients = ceil(2000 × 0.80)  = 1600
   *   staticClients  = 2000 - 1600        = 400
   *   dnsRecords     = (1600 × 4) + (400 × 2) = 7200
   *   dhcpRangeMult  = 0 (IPAM disabled)
   *   rawDdi         = 7200
   *   ddiObjects     = round(7200 × 1.15) = round(8280) = 8280
   *   activeIPsOut   = 0 (IPAM disabled)
   *   discoveredAssets = 0 (IPAM disabled)
   *   monthlyLogVolume = 0
   */
  it('Case C — no IPAM, DNS only', () => {
    const out = calcEstimator({
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

});
