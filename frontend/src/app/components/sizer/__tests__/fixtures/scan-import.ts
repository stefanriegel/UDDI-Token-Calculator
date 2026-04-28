// Canonical scan-import fixtures for Phase 32 (R-05).
//
// One FindingRow[] per provider keyed for reuse across plans 32-02 and 32-04
// tests. Hand-crafted to exercise:
//   - 2 distinct cloud regions per cloud provider (validates D-07 (Source × Region) granularity)
//   - 1 source with multiple categories (validates Σ Count aggregation for activeIPs in D-08)
//   - AD findings include both Active IP and Asset rows (validates D-10 + Pitfall 9)
//   - NIOS findings is an empty list (D-04: NIOS uses metrics, not findings)
//
// Token math is intentionally simplified (tokensPerUnit / managementTokens are
// indicative only); these fixtures are for import / merge logic, not for
// validating calculator output.

import type { FindingRow } from '../../../mock-data';
import type { NiosServerMetricAPI, ADServerMetricAPI } from '../../../api-client';

// ─── AWS ─────────────────────────────────────────────────────────────────────
// Source A ("123456789012") spans us-east-1 + us-west-2 (D-07 case)
// us-east-1 has both DDI Object + Active IP rows (D-08 sum case)
export const awsFindings: FindingRow[] = [
  { provider: 'aws', source: '123456789012', region: 'us-east-1',
    category: 'DDI Object', item: 'VPCs', count: 4,
    tokensPerUnit: 25, managementTokens: 1 },
  { provider: 'aws', source: '123456789012', region: 'us-east-1',
    category: 'Active IP', item: 'EC2 Instance IPs', count: 130,
    tokensPerUnit: 13, managementTokens: 10 },
  { provider: 'aws', source: '123456789012', region: 'us-east-1',
    category: 'Active IP', item: 'NAT Gateway IPs', count: 39,
    tokensPerUnit: 13, managementTokens: 3 },
  { provider: 'aws', source: '123456789012', region: 'us-west-2',
    category: 'DDI Object', item: 'VPCs', count: 2,
    tokensPerUnit: 25, managementTokens: 1 },
  { provider: 'aws', source: '123456789012', region: 'us-west-2',
    category: 'Active IP', item: 'EC2 Instance IPs', count: 65,
    tokensPerUnit: 13, managementTokens: 5 },
];

// ─── Azure ───────────────────────────────────────────────────────────────────
// Subscription S spans eastus + westeurope
export const azureFindings: FindingRow[] = [
  { provider: 'azure', source: 'sub-prod-01', region: 'eastus',
    category: 'DDI Object', item: 'vNets', count: 3,
    tokensPerUnit: 25, managementTokens: 1 },
  { provider: 'azure', source: 'sub-prod-01', region: 'eastus',
    category: 'Active IP', item: 'VM IPs', count: 78,
    tokensPerUnit: 13, managementTokens: 6 },
  { provider: 'azure', source: 'sub-prod-01', region: 'westeurope',
    category: 'DDI Object', item: 'vNets', count: 2,
    tokensPerUnit: 25, managementTokens: 1 },
  { provider: 'azure', source: 'sub-prod-01', region: 'westeurope',
    category: 'Active IP', item: 'VM IPs', count: 26,
    tokensPerUnit: 13, managementTokens: 2 },
];

// ─── GCP ─────────────────────────────────────────────────────────────────────
// Project P spans us-central1 + europe-west1
export const gcpFindings: FindingRow[] = [
  { provider: 'gcp', source: 'gcp-prod-01', region: 'us-central1',
    category: 'DDI Object', item: 'VPC Networks', count: 2,
    tokensPerUnit: 25, managementTokens: 1 },
  { provider: 'gcp', source: 'gcp-prod-01', region: 'us-central1',
    category: 'Active IP', item: 'Compute Instance IPs', count: 52,
    tokensPerUnit: 13, managementTokens: 4 },
  { provider: 'gcp', source: 'gcp-prod-01', region: 'europe-west1',
    category: 'DDI Object', item: 'VPC Networks', count: 1,
    tokensPerUnit: 25, managementTokens: 1 },
  { provider: 'gcp', source: 'gcp-prod-01', region: 'europe-west1',
    category: 'Active IP', item: 'Compute Instance IPs', count: 13,
    tokensPerUnit: 13, managementTokens: 1 },
];

// ─── AD (Microsoft) ──────────────────────────────────────────────────────────
// One domain, both Active IP + Asset rows (D-10 + Pitfall 9)
// region is empty (on-prem)
export const adFindings: FindingRow[] = [
  { provider: 'microsoft', source: 'corp.example.com', region: '',
    category: 'DDI Object', item: 'DNS Resource Records', count: 1500,
    tokensPerUnit: 25, managementTokens: 60 },
  { provider: 'microsoft', source: 'corp.example.com', region: '',
    category: 'Active IP', item: 'DHCP Active Leases', count: 260,
    tokensPerUnit: 13, managementTokens: 20 },
  { provider: 'microsoft', source: 'corp.example.com', region: '',
    category: 'Asset', item: 'Entra Users', count: 1200,
    tokensPerUnit: 3, managementTokens: 400 },
];

// ─── NIOS ────────────────────────────────────────────────────────────────────
// D-04: NIOS uses metrics, not findings — exported as empty list to assert
// downstream importers tolerate the empty case.
export const niosFindings: FindingRow[] = [];

// ─── NIOS server metrics (sidecar) ───────────────────────────────────────────
// 3 members: GM + 2 grid members. Used by importNios (D-04 / D-05).
export const niosMetrics: NiosServerMetricAPI[] = [
  {
    memberId: 'gm-01',
    memberName: 'infoblox-gm.corp.example.com',
    role: 'Grid Master',
    qps: 1200,
    lps: 240,
    objectCount: 18420,
    activeIPCount: 12480,
    model: 'IB-4030',
    platform: 'physical',
    managedIPCount: 18420,
    staticHosts: 3245,
    dynamicHosts: 12480,
    dhcpUtilization: 268,
    licenses: { dns: true, dhcp: true, ipam: true },
  },
  {
    memberId: 'mem-east-01',
    memberName: 'dns-east-01.corp.example.com',
    role: 'Member',
    qps: 800,
    lps: 0,
    objectCount: 8420,
    activeIPCount: 1680,
    model: 'IB-2225',
    platform: 'virtual',
    managedIPCount: 8420,
    staticHosts: 1680,
    dynamicHosts: 0,
    dhcpUtilization: 0,
    licenses: { dns: true },
  },
  {
    memberId: 'mem-west-01',
    memberName: 'dhcp-west-01.corp.example.com',
    role: 'Member',
    qps: 0,
    lps: 320,
    objectCount: 2960,
    activeIPCount: 5140,
    model: 'IB-825',
    platform: 'virtual',
    managedIPCount: 2960,
    staticHosts: 720,
    dynamicHosts: 5140,
    dhcpUtilization: 412,
    licenses: { dhcp: true },
  },
];

// ─── AD server metrics (sidecar) ─────────────────────────────────────────────
// 2 hostnames; preferred over adFindings counts when present (D-10).
export const adMetrics: ADServerMetricAPI[] = [
  {
    hostname: 'DC01.corp.example.com',
    dnsObjects: 4567,
    dhcpObjects: 821,
    dhcpObjectsWithOverhead: 1067,
    qps: 320,
    lps: 95,
    tier: 'M',
    serverTokens: 14,
  },
  {
    hostname: 'DC02.corp.example.com',
    dnsObjects: 1240,
    dhcpObjects: 312,
    dhcpObjectsWithOverhead: 405,
    qps: 110,
    lps: 38,
    tier: 'S',
    serverTokens: 6,
  },
];

// ─── Mixed (cross-provider) ──────────────────────────────────────────────────
export const mixedFindings: FindingRow[] = [
  ...awsFindings,
  ...azureFindings,
  ...gcpFindings,
  ...adFindings,
  ...niosFindings,
];
