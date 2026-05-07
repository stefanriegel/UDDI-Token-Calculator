/**
 * sizer-validate.ts — Pure validator for `SizerState`.
 *
 * Per Phase 29 CONTEXT decisions:
 *   - D-13: Validator is a standalone module. Calc functions do NOT call
 *           validate(); they trust incoming state. Validator also does NOT
 *           import from `sizer-calc.ts`.
 *   - D-14: Errors block save/export (SITE_MISSING_USERS_AND_IPS,
 *           REGION_EMPTY_WHEN_OTHERS_POPULATED, SECURITY_ENABLED_ZERO_ASSETS,
 *           STATE_EMPTY).
 *   - D-15: Warnings render as a non-blocking banner (XAAS_OVER_CONNECTIONS,
 *           SITE_UNASSIGNED, LPS_OUT_OF_RANGE, OBJECT_COUNT_MISMATCH,
 *           REGION_EMPTY_OTHERWISE).
 *   - D-16: Every `Issue` has `{ code, severity, path, message }` with a
 *           dot-path into state (e.g. `regions[0].countries[1].sites[2]`).
 *
 * Empty-state guard (RESEARCH Pitfall 7): when `state.regions.length === 0`
 * we emit a single `STATE_EMPTY` error and skip the tree walk so we don't
 * double-fire "empty region" codes on a fresh state.
 *
 * Reading `XAAS_TOKEN_TIERS` from the shared tiers module is allowed per
 * plan 29-05 guidance — the validator is not a calc function; it may
 * consult shared lookup constants to decide whether a `connections` count
 * exceeds the selected tier's `maxConnections` cap.
 */

import type {
  SizerState,
  Region,
  Country,
  City,
  Site,
  Issue,
} from './sizer-types';
import { XAAS_TOKEN_TIERS } from '../shared/token-tiers';

// ─── Stable machine-readable codes ─────────────────────────────────────────────

export const VALIDATION_CODES = Object.freeze({
  // Errors (D-14) — block save/export.
  SITE_MISSING_USERS_AND_IPS: 'site/missing-users-and-ips',
  REGION_EMPTY_WHEN_OTHERS_POPULATED: 'region/empty-when-others-populated',
  SECURITY_ENABLED_ZERO_ASSETS: 'security/enabled-zero-assets',
  STATE_EMPTY: 'state/empty',
  // Warnings (D-15) — render as banner, non-blocking.
  XAAS_OVER_CONNECTIONS: 'xaas/over-connections',
  SITE_UNASSIGNED: 'site/unassigned-to-xaas-and-niosx',
  LPS_OUT_OF_RANGE: 'site/lps-out-of-range',
  OBJECT_COUNT_MISMATCH: 'server/object-count-mismatch',
  /** Pitfall-7 disambiguation: empty region in otherwise-empty state. */
  REGION_EMPTY_OTHERWISE: 'region/empty',
} as const);

// ─── Helpers ───────────────────────────────────────────────────────────────────

function makeIssue(
  code: string,
  severity: Issue['severity'],
  path: string,
  message: string,
): Issue {
  return { code, severity, path, message };
}

/**
 * Walks the tree yielding `{ site, path }` tuples where `path` is a stable
 * dot-path into `state` (e.g. `regions[0].countries[1].cities[0].sites[2]`).
 */
function* walkSites(
  state: SizerState,
): Generator<{ region: Region; country: Country; city: City; site: Site; path: string }> {
  for (let ri = 0; ri < state.regions.length; ri++) {
    const region = state.regions[ri];
    for (let ci = 0; ci < region.countries.length; ci++) {
      const country = region.countries[ci];
      for (let cti = 0; cti < country.cities.length; cti++) {
        const city = country.cities[cti];
        for (let si = 0; si < city.sites.length; si++) {
          const site = city.sites[si];
          yield {
            region,
            country,
            city,
            site,
            path: `regions[${ri}].countries[${ci}].cities[${cti}].sites[${si}]`,
          };
        }
      }
    }
  }
}

function regionHasAnySite(region: Region): boolean {
  return region.countries.some((c) => c.cities.some((ct) => ct.sites.length > 0));
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Validate a `SizerState` and return its `{ errors, warnings }` partition.
 *
 * Pure — no I/O, no throws, no mutation. Safe to call on every keystroke
 * in the Phase 30 UI.
 */
export function validate(state: SizerState): {
  errors: Issue[];
  warnings: Issue[];
} {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];

  // Empty-state guard (Pitfall 7): emit STATE_EMPTY and skip the tree walk.
  if (state.regions.length === 0) {
    errors.push(
      makeIssue(
        VALIDATION_CODES.STATE_EMPTY,
        'error',
        '',
        'State has no regions. Add at least one Region with a Site to size.',
      ),
    );
    // Security check still applies even in an empty state.
    pushSecurityIssue(state, errors);
    return { errors, warnings };
  }

  const anyRegionHasSite = state.regions.some(regionHasAnySite);

  // Region-level check: empty regions disambiguate to error vs warning via
  // anyRegionHasSite (Pitfall 7).
  for (let ri = 0; ri < state.regions.length; ri++) {
    const region = state.regions[ri];
    if (regionHasAnySite(region)) continue;
    const path = `regions[${ri}]`;
    if (anyRegionHasSite) {
      errors.push(
        makeIssue(
          VALIDATION_CODES.REGION_EMPTY_WHEN_OTHERS_POPULATED,
          'error',
          path,
          `Region "${region.name}" has no Sites while other Regions do. Add a Site or remove the Region.`,
        ),
      );
    } else {
      warnings.push(
        makeIssue(
          VALIDATION_CODES.REGION_EMPTY_OTHERWISE,
          'warning',
          path,
          `Region "${region.name}" has no Sites yet.`,
        ),
      );
    }
  }

  // Per-site checks.
  const { niosx, xaas } = state.infrastructure;
  // When no infra exists at all, the global OBJECT_COUNT_MISMATCH warning
  // below covers the same condition — suppress per-site SITE_UNASSIGNED to
  // avoid redundant warnings (issue #18).
  const noInfra = niosx.length === 0 && xaas.length === 0;
  for (const { site, path } of walkSites(state)) {
    // Error: SIZER-03 invariant — users OR activeIPs must be defined.
    if (site.users == null && site.activeIPs == null) {
      errors.push(
        makeIssue(
          VALIDATION_CODES.SITE_MISSING_USERS_AND_IPS,
          'error',
          path,
          `Site "${site.name}" has neither users nor activeIPs set. One of the two is required to size.`,
        ),
      );
    }

    // Warning: derived lps outside [1, 10000].
    if (site.lps != null && (site.lps < 1 || site.lps > 10000)) {
      warnings.push(
        makeIssue(
          VALIDATION_CODES.LPS_OUT_OF_RANGE,
          'warning',
          path,
          `Site "${site.name}" lps=${site.lps} is outside the expected range [1, 10000].`,
        ),
      );
    }

    // Warning: site not assigned to any XaaS or NIOS-X.
    const assignedToNiosx = niosx.some((n) => n.siteId === site.id);
    const assignedToXaas = xaas.some((x) => x.connectedSiteIds.includes(site.id));
    if (!noInfra && !assignedToNiosx && !assignedToXaas) {
      warnings.push(
        makeIssue(
          VALIDATION_CODES.SITE_UNASSIGNED,
          'warning',
          path,
          `Site "${site.name}" is not assigned to any NIOS-X system or XaaS service point.`,
        ),
      );
    }
  }

  // XaaS service point checks.
  for (let xi = 0; xi < xaas.length; xi++) {
    const sp = xaas[xi];
    const tier = XAAS_TOKEN_TIERS.find((t) => t.name === sp.tierName);
    // Unknown tier → upstream data bug, not a validation concern; skip.
    if (!tier || tier.maxConnections == null) continue;
    if (sp.connections > tier.maxConnections) {
      warnings.push(
        makeIssue(
          VALIDATION_CODES.XAAS_OVER_CONNECTIONS,
          'warning',
          `infrastructure.xaas[${xi}]`,
          `XaaS service point "${sp.name}" has ${sp.connections} connections, exceeding the ${tier.name} tier cap of ${tier.maxConnections}.`,
        ),
      );
    }
  }

  // OBJECT_COUNT_MISMATCH (lightweight per CONTEXT.md Deferred Ideas W-2):
  // if Sites exist but zero NIOS-X + zero XaaS overall, Server tokens would be
  // 0 while Sites demand capacity. Full Σ(activeIPs × multiplier) vs combined
  // tier capacity math is deferred to Phase 31 (Results).
  if (anyRegionHasSite && niosx.length === 0 && xaas.length === 0) {
    warnings.push(
      makeIssue(
        VALIDATION_CODES.OBJECT_COUNT_MISMATCH,
        'warning',
        'infrastructure',
        'Sites exist but no NIOS-X systems or XaaS service points are configured; Server tokens will be zero.',
      ),
    );
  }

  pushSecurityIssue(state, errors);

  return { errors, warnings };
}

function pushSecurityIssue(state: SizerState, errors: Issue[]): void {
  const { securityEnabled, tdVerifiedAssets, tdUnverifiedAssets } = state.security;
  if (securityEnabled && tdVerifiedAssets + tdUnverifiedAssets === 0) {
    errors.push(
      makeIssue(
        VALIDATION_CODES.SECURITY_ENABLED_ZERO_ASSETS,
        'error',
        'security',
        'Security is enabled but Threat Defense verified+unverified assets sum to 0.',
      ),
    );
  }
}
