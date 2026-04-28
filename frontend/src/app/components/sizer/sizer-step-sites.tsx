/**
 * sizer-step-sites.tsx — Step 2: per-Site form with Users-driven ↔ Manual
 * toggle, debounced derive, "Derived" badges, Workload Details collapsible,
 * live QPS·LPS·Objects·IPs·Assets preview strip, and Clone ×N popover.
 *
 * Per UI-SPEC §5 and CONTEXT D-11..D-15:
 *   - Left column: region pill selector + flat list of sites in the selected
 *     Region (Country / City headers for orientation). Selecting a site sets
 *     `ui.selectedPath` to `site:{id}` and renders the form on the right.
 *   - Right column: site form with the following layout (top → bottom):
 *       1. Header: inline-edit name · `×multiplier` chip · `+ Clone ×N`.
 *       2. Live preview strip (sticky under header).
 *       3. Mode toggle (Users-driven / Manual).
 *       4. Users input (Users-driven only, 150ms debounce).
 *       5. Derived fields grid (2 cols) with `<DerivedBadge>` next to the
 *          label when the field is NOT overridden.
 *       6. Workload Details collapsible (closed by default).
 *   - Editing any derived field dispatches SITE_MARK_OVERRIDE (first edit
 *     only — the reducer stores `true`; subsequent edits stay overridden)
 *     plus UPDATE_SITE. The reducer's SITE_DERIVE already honours the
 *     override flags (Pitfall 8 — regression-tested in this plan's tests).
 *
 * This file is independent from the Step-1 tree. It dispatches the same
 * reducer actions (already shipped in 30-02).
 */
import {
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
} from 'react';
import { Copy } from 'lucide-react';

import { useSizer } from './sizer-state';
import type { DeriveOverrides, Region, Site } from './sizer-types';
import { UNASSIGNED_PLACEHOLDER } from './sizer-types';
import { deriveFromUsers } from './sizer-derive';

import { useDebouncedDerive } from './hooks/use-debounced-derive';
import { DerivedBadge } from './ui/derived-badge';
import { ClonePopover } from './ui/clone-popover';
import { InlineMarker } from './ui/inline-marker';
import { useActiveIssuesByPath } from './sizer-validation-banner';

import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader } from '../ui/card';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../ui/collapsible';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Slider } from '../ui/slider';
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs';
import { cn } from '../ui/utils';

// ─── Derived field registry ──────────────────────────────────────────────────
// Fields that deriveFromUsers populates AND the UI exposes as "Derived".
// `verifiedAssets` / `unverifiedAssets` are shown in the grid but NOT
// user-overridable (per sizer-derive.ts comment: they follow from `assets`
// ×/− tier.verifiedPct). Editing them dispatches UPDATE_SITE but does not
// set an override flag (no key in DeriveOverrides).

interface DerivedFieldSpec {
  key: keyof Site;
  overrideKey?: keyof DeriveOverrides;
  label: string;
  testId: string;
  step?: number;
}

const DERIVED_FIELDS: DerivedFieldSpec[] = [
  { key: 'activeIPs',       overrideKey: 'activeIPs',       label: 'Active IPs',         testId: 'activeIPs',      step: 1 },
  { key: 'qps',             overrideKey: 'qps',             label: 'QPS',                testId: 'qps',            step: 1 },
  { key: 'dnsZones',        overrideKey: 'dnsZones',        label: 'DNS Zones',          testId: 'dnsZones',       step: 1 },
  { key: 'networksPerSite', overrideKey: 'networksPerSite', label: 'Networks per Site', testId: 'networksPerSite', step: 1 },
  { key: 'assets',          overrideKey: 'assets',          label: 'Assets',             testId: 'assets',         step: 1 },
  { key: 'verifiedAssets',                                 label: 'Verified Assets',   testId: 'verifiedAssets',  step: 1 },
  { key: 'unverifiedAssets',                               label: 'Unverified Assets', testId: 'unverifiedAssets', step: 1 },
];

const WORKLOAD_FIELDS: DerivedFieldSpec[] = [
  { key: 'dnsRecords',       label: 'DNS Records',         testId: 'dnsRecords',       step: 1 },
  { key: 'dhcpScopes',       overrideKey: 'dhcpScopes',       label: 'DHCP Scopes',    testId: 'dhcpScopes',       step: 1 },
  { key: 'avgLeaseDuration', overrideKey: 'avgLeaseDuration', label: 'Avg Lease Duration (hours)', testId: 'avgLeaseDuration', step: 1 },
  { key: 'qpsPerIP',          label: 'QPS per IP',          testId: 'qpsPerIP',          step: 1 },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatInt(n: number | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return Math.round(n).toLocaleString('en-US');
}

function parseSiteSelection(path: string | null): string | null {
  if (!path) return null;
  const m = /^site:(.+)$/.exec(path);
  return m ? m[1] : null;
}

function findSiteInRegion(region: Region, siteId: string): Site | null {
  for (const country of region.countries) {
    for (const city of country.cities) {
      for (const site of city.sites) {
        if (site.id === siteId) return site;
      }
    }
  }
  return null;
}

function allSitesInRegion(region: Region): Array<{ site: Site; countryName: string; cityName: string }> {
  const out: Array<{ site: Site; countryName: string; cityName: string }> = [];
  for (const country of region.countries) {
    for (const city of country.cities) {
      for (const site of city.sites) {
        out.push({ site, countryName: country.name, cityName: city.name });
      }
    }
  }
  return out;
}

// ─── Main component ──────────────────────────────────────────────────────────

export function SizerStepSites() {
  const { state, dispatch } = useSizer();
  const regions = state.core.regions;

  // Active region: first one by default; may be switched via pills.
  const [activeRegionId, setActiveRegionId] = useState<string | null>(
    regions[0]?.id ?? null,
  );
  useEffect(() => {
    if (activeRegionId && regions.some((r) => r.id === activeRegionId)) return;
    setActiveRegionId(regions[0]?.id ?? null);
  }, [regions, activeRegionId]);

  const activeRegion = regions.find((r) => r.id === activeRegionId) ?? null;

  const selectedSiteId = parseSiteSelection(state.ui.selectedPath);
  const selectedSite = activeRegion && selectedSiteId
    ? findSiteInRegion(activeRegion, selectedSiteId)
    : null;

  const sitesInRegion = activeRegion ? allSitesInRegion(activeRegion) : [];

  // Auto-select the first site in the region if none is selected or the
  // current selection is outside the active region.
  useEffect(() => {
    if (!activeRegion) return;
    if (selectedSite) return;
    const first = sitesInRegion[0]?.site;
    if (first) {
      dispatch({ type: 'SET_SELECTED_PATH', path: `site:${first.id}` });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRegion?.id, sitesInRegion.length]);

  if (regions.length === 0) {
    return (
      <Card data-testid="sizer-step-sites">
        <CardContent className="py-12 text-center text-sm text-muted-foreground">
          No regions yet — add a Region in Step 1 first.
        </CardContent>
      </Card>
    );
  }

  return (
    <div
      className="grid gap-6 items-start lg:grid-cols-[320px_1fr]"
      data-testid="sizer-step-sites"
    >
      <section aria-label="Sites in region" className="lg:sticky lg:top-24 min-w-0">
        <Card>
          <CardHeader>
            <h2 className="text-lg font-medium">Sites</h2>
            <div className="flex flex-wrap gap-1" role="tablist" aria-label="Active region">
              {regions.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  role="tab"
                  aria-selected={r.id === activeRegionId}
                  data-testid={`sizer-sites-region-pill-${r.id}`}
                  onClick={() => setActiveRegionId(r.id)}
                  className={cn(
                    'text-xs px-2 py-1 rounded-sm border',
                    r.id === activeRegionId
                      ? 'bg-secondary border-transparent'
                      : 'bg-transparent border-input text-muted-foreground hover:bg-secondary/50',
                  )}
                >
                  {r.name}
                </button>
              ))}
            </div>
          </CardHeader>
          <CardContent>
            {/* Plain overflow-auto wrapper — Radix ScrollArea Root has no
                explicit height in this layout, so its Viewport collapsed to
                content height and the max-h cap never activated, letting an
                imported NIOS Grid (30+ sites) blow the Card open and visually
                collide with the right column on lg+ viewports. */}
            <div
              className="max-h-[60vh] lg:max-h-[calc(100vh-320px)] overflow-y-auto overflow-x-hidden"
              data-testid="sizer-sites-scroll"
            >
              {sitesInRegion.length === 0 ? (
                <p className="text-sm text-muted-foreground" data-testid="sizer-sites-empty">
                  No sites in this region yet. Use &quot;+ Add Site&quot; under any City.
                </p>
              ) : (
                <ul className="list-none m-0 p-0" data-testid="sizer-sites-list">
                  {sitesInRegion.map(({ site, countryName, cityName }) => (
                    <li key={site.id}>
                      <button
                        type="button"
                        onClick={() =>
                          dispatch({ type: 'SET_SELECTED_PATH', path: `site:${site.id}` })
                        }
                        data-testid={`sizer-sites-pick-${site.id}`}
                        className={cn(
                          'w-full text-left px-2 py-2 rounded-sm border border-transparent',
                          site.id === selectedSiteId && 'bg-secondary',
                          'hover:bg-secondary/50',
                        )}
                      >
                        <div className="text-sm font-medium truncate">{site.name}</div>
                        {(() => {
                          // Issue #31: hide quick-add (Unassigned) › (Unassigned) path
                          // segments. Sites created directly under a Region auto-attach
                          // to placeholder Country + City — those are implementation
                          // detail and shouldn't leak into the editing surface. Real
                          // named segments still render.
                          const countryReal = countryName !== UNASSIGNED_PLACEHOLDER;
                          const cityReal = cityName !== UNASSIGNED_PLACEHOLDER;
                          if (!countryReal && !cityReal) return null;
                          return (
                            <div className="text-xs text-muted-foreground truncate">
                              {countryReal && <PathFragment name={countryName} />}
                              {countryReal && cityReal && ' › '}
                              {cityReal && <PathFragment name={cityName} />}
                            </div>
                          );
                        })()}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </CardContent>
        </Card>
      </section>

      <section aria-label="Site detail" className="min-w-0">
        {selectedSite ? (
          <SiteForm site={selectedSite} />
        ) : (
          <Card>
            <CardContent className="py-12 text-center text-sm text-muted-foreground">
              Select a site on the left to edit its properties.
            </CardContent>
          </Card>
        )}
      </section>
    </div>
  );
}

function PathFragment({ name }: { name: string }) {
  const placeholder = name === UNASSIGNED_PLACEHOLDER;
  return (
    <span className={cn(placeholder && 'italic')}>{name}</span>
  );
}

// ─── Site form ───────────────────────────────────────────────────────────────

function siteTreePath(regions: Region[], siteId: string): string | null {
  for (let ri = 0; ri < regions.length; ri++) {
    const r = regions[ri];
    for (let ci = 0; ci < r.countries.length; ci++) {
      const c = r.countries[ci];
      for (let cti = 0; cti < c.cities.length; cti++) {
        const ct = c.cities[cti];
        for (let si = 0; si < ct.sites.length; si++) {
          if (ct.sites[si].id === siteId) {
            return `regions[${ri}].countries[${ci}].cities[${cti}].sites[${si}]`;
          }
        }
      }
    }
  }
  return null;
}

function SiteForm({ site }: { site: Site }) {
  const { state, dispatch } = useSizer();
  const sitePath = siteTreePath(state.core.regions, site.id);
  const issuesByPath = useActiveIssuesByPath();
  const siteIssue = sitePath ? issuesByPath.get(sitePath) : undefined;

  // Mode: default 'users' when users is set, otherwise 'manual'.
  const defaultMode: 'users' | 'manual' =
    state.ui.siteMode[site.id] ?? (site.users != null ? 'users' : 'manual');

  const overrides = state.ui.siteOverrides[site.id] ?? {};

  // Drive the debounced derive effect from the reducer's stored overrides.
  const overridesForDerive = useMemo<DeriveOverrides>(() => {
    const out: DeriveOverrides = {};
    if (overrides.activeIPs       && site.activeIPs       != null) out.activeIPs       = site.activeIPs;
    if (overrides.qps             && site.qps             != null) out.qps             = site.qps;
    if (overrides.assets          && site.assets          != null) out.assets          = site.assets;
    if (overrides.networksPerSite && site.networksPerSite != null) out.networksPerSite = site.networksPerSite;
    if (overrides.dnsZones        && site.dnsZones        != null) out.dnsZones        = site.dnsZones;
    if (overrides.dhcpScopes      && site.dhcpScopes      != null) out.dhcpScopes      = site.dhcpScopes;
    if (overrides.dhcpPct         && site.dhcpPct         != null) out.dhcpPct         = site.dhcpPct;
    if (overrides.avgLeaseDuration&& site.avgLeaseDuration!= null) out.avgLeaseDuration= site.avgLeaseDuration;
    if (overrides.lps             && site.lps             != null) out.lps             = site.lps;
    return out;
  }, [
    overrides.activeIPs, overrides.qps, overrides.assets,
    overrides.networksPerSite, overrides.dnsZones, overrides.dhcpScopes,
    overrides.dhcpPct, overrides.avgLeaseDuration, overrides.lps,
    site.activeIPs, site.qps, site.assets, site.networksPerSite,
    site.dnsZones, site.dhcpScopes, site.dhcpPct, site.avgLeaseDuration,
    site.lps,
  ]);

  // 150ms debounced derive — only fires in Users mode (we unmount the hook
  // effectively by gating users on mode).
  useDebouncedDerive(
    { id: site.id, users: defaultMode === 'users' ? site.users : undefined },
    overridesForDerive,
    dispatch,
  );

  const livePreview = useMemo(() => {
    // Preview values use current Site fields; if users is set and certain
    // fields are missing (e.g. first-mount before debounce fires), fall back
    // to a synchronous derive so the preview is never blank on initial render.
    const fallback =
      site.users != null && Number.isFinite(site.users) && site.users > 0
        ? deriveFromUsers(site.users, overridesForDerive)
        : null;
    const qps       = site.qps       ?? fallback?.qps       ?? 0;
    const lps       = site.lps       ?? fallback?.lps       ?? 0;
    const activeIPs = site.activeIPs ?? fallback?.activeIPs ?? 0;
    const assets    = site.assets    ?? fallback?.assets    ?? 0;
    // DDI Object count must match the canonical formula used by
    // calculateManagementTokens / deriveMembersFromNiosx:
    //   objectCount = dnsRecords + dhcpScopes × 2
    // NIOS Grid imports project per-member objectCount into `dnsRecords`
    // (see sizer-import.ts) so the value round-trips into this preview
    // without inflation. The previous formula `networks + zones + dhcpScopes`
    // was independent of the calc engine and showed Objects=0 for imports.
    const dnsRecords = site.dnsRecords ?? 0;
    const dhcpScopes = site.dhcpScopes ?? fallback?.dhcpScopes ?? 0;
    const objects = dnsRecords + dhcpScopes * 2;
    return { qps, lps, activeIPs, assets, objects };
  }, [site, overridesForDerive]);

  const onFieldEdit = (spec: DerivedFieldSpec, raw: string) => {
    const value = raw === '' ? undefined : Number(raw);
    if (spec.overrideKey && !overrides[spec.overrideKey]) {
      dispatch({ type: 'SITE_MARK_OVERRIDE', siteId: site.id, field: spec.overrideKey });
    }
    dispatch({
      type: 'UPDATE_SITE',
      siteId: site.id,
      patch: { [spec.key]: value } as Partial<Site>,
    });
  };

  const setMode = (mode: 'users' | 'manual') => {
    dispatch({ type: 'SITE_SET_MODE', siteId: site.id, mode });
  };

  return (
    <Card
      data-testid="sizer-site-form"
      data-sizer-path={sitePath ?? undefined}
      tabIndex={-1}
    >
      <CardHeader className="gap-3">
        <div className="flex items-center gap-3 flex-wrap">
          <Input
            aria-label="Site name"
            data-testid="sizer-site-name"
            value={site.name}
            className="max-w-xs"
            onChange={(e) =>
              dispatch({
                type: 'UPDATE_SITE',
                siteId: site.id,
                patch: { name: e.target.value },
              })
            }
          />
          <label className="inline-flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">×</span>
            <Input
              aria-label="Multiplier"
              data-testid="sizer-site-multiplier"
              type="number"
              min={1}
              value={site.multiplier}
              className="w-20"
              onChange={(e) => {
                const n = Math.max(1, Math.floor(Number(e.target.value) || 1));
                dispatch({
                  type: 'UPDATE_SITE',
                  siteId: site.id,
                  patch: { multiplier: n },
                });
              }}
            />
          </label>
          <ClonePopover siteId={site.id} siteName={site.name}>
            <Button size="sm" variant="outline" data-testid="sizer-site-clone-trigger">
              <Copy className="size-3" /> Clone ×N
            </Button>
          </ClonePopover>
          {siteIssue && <InlineMarker issue={siteIssue} />}
        </div>

        <PreviewStrip
          qps={livePreview.qps}
          lps={livePreview.lps}
          objects={livePreview.objects}
          ips={livePreview.activeIPs}
          assets={livePreview.assets}
        />

        <Tabs
          value={defaultMode}
          onValueChange={(v) => setMode(v as 'users' | 'manual')}
          data-testid="sizer-site-mode-toggle"
        >
          <TabsList>
            <TabsTrigger value="users" data-testid="sizer-site-mode-users">
              Users-driven
            </TabsTrigger>
            <TabsTrigger value="manual" data-testid="sizer-site-mode-manual">
              Manual
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </CardHeader>

      <CardContent className="flex flex-col gap-6">
        {defaultMode === 'users' && (
          <div className="flex flex-col gap-2 max-w-sm">
            <Label htmlFor={`users-${site.id}`}>Users at this site</Label>
            <Input
              id={`users-${site.id}`}
              data-testid="sizer-site-users"
              type="number"
              min={1}
              placeholder="e.g. 500"
              value={site.users ?? ''}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                const raw = e.target.value;
                const value = raw === '' ? undefined : Math.max(0, Math.floor(Number(raw) || 0));
                dispatch({
                  type: 'UPDATE_SITE',
                  siteId: site.id,
                  patch: { users: value },
                });
              }}
            />
            <p className="text-xs text-muted-foreground">
              QPS, LPS, IPs, assets, zones, and networks derive from this value.
            </p>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {DERIVED_FIELDS.map((spec) => (
            <FieldInput
              key={String(spec.key)}
              spec={spec}
              value={site[spec.key] as number | undefined}
              showDerivedBadge={
                defaultMode === 'users' &&
                (!spec.overrideKey || !overrides[spec.overrideKey])
              }
              onChange={(raw) => onFieldEdit(spec, raw)}
            />
          ))}
        </div>

        <Collapsible>
          <CollapsibleTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              data-testid="sizer-site-workload-details-toggle"
              className="self-start"
            >
              Workload Details
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent data-testid="sizer-site-workload-details">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-3">
              {WORKLOAD_FIELDS.map((spec) => (
                <FieldInput
                  key={String(spec.key)}
                  spec={spec}
                  value={site[spec.key] as number | undefined}
                  showDerivedBadge={
                    defaultMode === 'users' &&
                    !!spec.overrideKey &&
                    !overrides[spec.overrideKey]
                  }
                  onChange={(raw) => onFieldEdit(spec, raw)}
                />
              ))}
              <div className="flex flex-col gap-2">
                <Label htmlFor={`dhcpPct-${site.id}`}>
                  DHCP % of IPs
                  {defaultMode === 'users' && !overrides.dhcpPct && (
                    <span className="ml-2 inline-flex align-middle">
                      <DerivedBadge testId="sizer-site-derived-dhcpPct-badge" />
                    </span>
                  )}
                </Label>
                <Slider
                  id={`dhcpPct-${site.id}`}
                  min={0}
                  max={100}
                  step={1}
                  value={[Math.round(((site.dhcpPct ?? 0) as number) * 100)]}
                  onValueChange={([v]) => {
                    if (!overrides.dhcpPct) {
                      dispatch({ type: 'SITE_MARK_OVERRIDE', siteId: site.id, field: 'dhcpPct' });
                    }
                    dispatch({
                      type: 'UPDATE_SITE',
                      siteId: site.id,
                      patch: { dhcpPct: v / 100 },
                    });
                  }}
                  data-testid="sizer-site-dhcpPct-slider"
                />
                <span className="text-xs text-muted-foreground">
                  {Math.round(((site.dhcpPct ?? 0) as number) * 100)} %
                </span>
              </div>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Card>
  );
}

// ─── Leaf: a labelled number input with optional DerivedBadge ────────────────

interface FieldInputProps {
  spec: DerivedFieldSpec;
  value: number | undefined;
  showDerivedBadge: boolean;
  onChange: (raw: string) => void;
}

function FieldInput({ spec, value, showDerivedBadge, onChange }: FieldInputProps) {
  const id = `sizer-site-field-${spec.testId}`;
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id} className="flex items-center gap-2 flex-wrap">
        <span>{spec.label}</span>
        {showDerivedBadge && (
          <DerivedBadge testId={`sizer-site-derived-${spec.testId}-badge`} />
        )}
      </Label>
      <Input
        id={id}
        data-testid={`sizer-site-derived-${spec.testId}`}
        type="number"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

// ─── Live preview strip ──────────────────────────────────────────────────────

interface PreviewProps {
  qps: number;
  lps: number;
  objects: number;
  ips: number;
  assets: number;
}

function PreviewStrip({ qps, lps, objects, ips, assets }: PreviewProps) {
  return (
    <div
      data-testid="sizer-site-preview"
      className="flex flex-wrap gap-4 bg-secondary rounded-md px-4 py-3 text-sm"
    >
      <PreviewCell label="QPS"     value={qps}     testId="sizer-site-preview-qps" />
      <PreviewCell label="LPS"     value={lps}     testId="sizer-site-preview-lps" />
      <PreviewCell label="Objects" value={objects} testId="sizer-site-preview-objects" />
      <PreviewCell label="IPs"     value={ips}     testId="sizer-site-preview-ips" />
      <PreviewCell label="Assets"  value={assets}  testId="sizer-site-preview-assets" />
    </div>
  );
}

function PreviewCell({ label, value, testId }: { label: string; value: number; testId: string }) {
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className="text-muted-foreground">{label}</span>
      <Badge variant="outline" data-testid={testId} className="font-medium">
        {formatInt(value)}
      </Badge>
    </span>
  );
}
