/**
 * sizer-session-export.ts — Save Session (JSON snapshot) + Download CSV
 * helpers for the Sizer report flow.
 *
 * Save Session writes the full SizerFullState plus a small envelope so the
 * blob is self-describing if the file is ever round-tripped back through an
 * import path. CSV mirrors the report's main sections — totals, per-Site
 * breakdown, NIOS-X systems, and XaaS service points.
 */
import type { SizerFullState } from './sizer-state';
import type { Site } from './sizer-types';
import {
  resolveOverheads,
  calculateManagementTokens,
  calculateServerTokens,
  calculateReportingTokens,
  calculateSecurityTokens,
} from './sizer-calc';

const SESSION_FORMAT = 'sizer-session-v1';

export interface SizerSessionEnvelope {
  _format: typeof SESSION_FORMAT;
  exportedAt: string;
  state: SizerFullState;
}

export function buildSizerSessionJson(state: SizerFullState): string {
  const envelope: SizerSessionEnvelope = {
    _format: SESSION_FORMAT,
    exportedAt: new Date().toISOString(),
    state,
  };
  return JSON.stringify(envelope, null, 2);
}

function csvCell(v: unknown): string {
  if (v === undefined || v === null) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(',');
}

function siteCsvRows(state: SizerFullState): string[] {
  const rows: string[] = [];
  rows.push(
    csvRow([
      'Region',
      'RegionType',
      'Country',
      'City',
      'Site',
      'Multiplier',
      'Users',
      'ActiveIPs',
      'QPS',
      'LPS',
      'Assets',
      'VerifiedAssets',
      'UnverifiedAssets',
      'DhcpPct',
      'DnsZones',
      'NetworksPerSite',
      'DnsRecords',
      'DhcpScopes',
    ]),
  );
  for (const r of state.core.regions) {
    for (const co of r.countries) {
      for (const ci of co.cities) {
        for (const s of ci.sites) {
          rows.push(
            csvRow([
              r.name,
              r.type,
              co.name,
              ci.name,
              s.name,
              s.multiplier,
              s.users,
              s.activeIPs,
              s.qps,
              s.lps,
              s.assets,
              s.verifiedAssets,
              s.unverifiedAssets,
              s.dhcpPct,
              s.dnsZones,
              s.networksPerSite,
              s.dnsRecords,
              s.dhcpScopes,
            ]),
          );
        }
      }
    }
  }
  return rows;
}

function flattenSites(state: SizerFullState): Site[] {
  const out: Site[] = [];
  for (const r of state.core.regions) {
    for (const co of r.countries) {
      for (const ci of co.cities) {
        for (const s of ci.sites) out.push(s);
      }
    }
  }
  return out;
}

export function buildSizerCsv(state: SizerFullState): string {
  const ovh = resolveOverheads(state.core);
  const allSites = flattenSites(state);
  const g = state.core.globalSettings;
  const reportingToggles = {
    csp: !!g.reportingCsp,
    s3: !!g.reportingS3,
    cdc: !!g.reportingCdc,
    dnsEnabled: !!g.dnsLoggingEnabled,
    dhcpEnabled: !!g.dhcpLoggingEnabled,
  };
  const mgmt = calculateManagementTokens(allSites, ovh.mgmt);
  const server = calculateServerTokens(
    state.core.infrastructure.niosx,
    state.core.infrastructure.xaas,
    ovh.server,
  );
  const reporting = calculateReportingTokens(allSites, ovh.reporting, reportingToggles);
  const security = calculateSecurityTokens(state.core.security, ovh.security);
  const growth = g.growthBuffer ?? 0;
  const totalWithGrowth = Math.ceil((mgmt + server + reporting + security) * (1 + growth));

  const lines: string[] = [];
  lines.push('Sizer Report');
  lines.push(csvRow(['Generated', new Date().toISOString()]));
  lines.push('');

  lines.push('Totals');
  lines.push(csvRow(['Category', 'Tokens']));
  lines.push(csvRow(['Management', mgmt]));
  lines.push(csvRow(['Server', server]));
  lines.push(csvRow(['Reporting', reporting]));
  lines.push(csvRow(['Security', security]));
  lines.push(csvRow(['Growth Buffer (%)', Math.round(growth * 100)]));
  lines.push(csvRow(['Total (with growth)', totalWithGrowth]));
  lines.push('');

  lines.push('Sites');
  lines.push(...siteCsvRows(state));
  lines.push('');

  lines.push('NIOS-X Systems');
  lines.push(csvRow(['Name', 'SiteId', 'FormFactor', 'Tier', 'TierManual']));
  for (const n of state.core.infrastructure.niosx) {
    lines.push(csvRow([n.name, n.siteId, n.formFactor, n.tierName, n.tierManual ? 'yes' : '']));
  }
  lines.push('');

  lines.push('XaaS Service Points');
  lines.push(csvRow(['Name', 'RegionId', 'Tier', 'Connections', 'Connectivity', 'PoP', 'ConnectedSites']));
  for (const x of state.core.infrastructure.xaas) {
    lines.push(
      csvRow([
        x.name,
        x.regionId,
        x.tierName,
        x.connections,
        x.connectivity,
        x.popLocation,
        x.connectedSiteIds.join('|'),
      ]),
    );
  }

  return lines.join('\n');
}
