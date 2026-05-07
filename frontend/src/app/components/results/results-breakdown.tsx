/**
 * results-breakdown.tsx — Sizer-only Region/Country/City/Site breakdown table.
 *
 * Phase 34 Plan 05 — REQ-01 (hierarchical table with per-level token
 * contribution) and REQ-05 (click-to-edit per-Site cells dispatching via
 * `onSiteEdit`). Pure presentation: props in / callbacks out. NEVER imports
 * from the Sizer hook or any Sizer reducer — wiring happens in Wave 4 (Plan 06).
 *
 * Decisions:
 *   - D-06: Click-to-edit affordance — read mode plain text; click swaps to
 *     <Input type="number"> with Save/Cancel buttons.
 *   - D-08: Editable Site fields = activeIPs / users / qps / lps. Validation
 *     rejects non-integer / negative / NaN.
 *   - D-10: Default expansion — Regions + Countries visible; Cities collapsed.
 *   - D-11: Aggregate-then-divide on roll-ups: ceil(sumLeafCount / divisor).
 *     NEVER sum pre-divided leaf tokens.
 *   - D-13: Section id `section-breakdown` preserved verbatim for OutlineNav.
 *   - One-cell-at-a-time editing enforced via `useState<{siteId, field}|null>`
 *     at table level (UI-SPEC Interaction Contract).
 *
 * Two-weight typography ramp: 400 on Site (leaf) rows, 600 on non-leaf rows.
 * Indent step 16px per nesting level (`pl-0/4/8/12`).
 */

import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Check, ChevronDown, ChevronRight, X } from 'lucide-react';

import type { City, Country, Region, Site } from '../sizer/sizer-types';
import { UNASSIGNED_PLACEHOLDER } from '../sizer/sizer-types';
import { Badge } from '../ui/badge';
import { cn } from '../ui/utils';

// ─── Public types ────────────────────────────────────────────────────────────

export type EditableSiteField = 'activeIPs' | 'users' | 'qps' | 'lps';

export interface ResultsBreakdownProps {
  mode: 'sizer';
  regions: Region[];
  /** Token divisors for aggregate-then-divide roll-ups (D-11). */
  tokensPerActiveIP: number;
  tokensPerUser: number;
  tokensPerQps: number;
  tokensPerLps: number;
  /** Edit dispatch — parent owns the reducer (Wave 4 wiring). */
  onSiteEdit: (siteId: string, patch: Partial<Site>) => void;
}

// ─── Numeric formatting ──────────────────────────────────────────────────────

const NUMBER_FMT = new Intl.NumberFormat('en-US');
function fmt(n: number): string {
  return NUMBER_FMT.format(n);
}

// ─── Aggregation helpers (D-11) ──────────────────────────────────────────────

interface MetricSums {
  activeIPs: number;
  users: number;
  qps: number;
  lps: number;
  siteCount: number;
}

function multiplied(value: number | undefined, multiplier: number): number {
  return (value ?? 0) * Math.max(1, multiplier);
}

function sumSites(sites: Site[]): MetricSums {
  return sites.reduce<MetricSums>(
    (acc, s) => {
      acc.activeIPs += multiplied(s.activeIPs, s.multiplier);
      acc.users += multiplied(s.users, s.multiplier);
      acc.qps += multiplied(s.qps, s.multiplier);
      acc.lps += multiplied(s.lps, s.multiplier);
      acc.siteCount += Math.max(1, s.multiplier);
      return acc;
    },
    { activeIPs: 0, users: 0, qps: 0, lps: 0, siteCount: 0 },
  );
}

function sumCities(cities: City[]): MetricSums {
  const acc: MetricSums = { activeIPs: 0, users: 0, qps: 0, lps: 0, siteCount: 0 };
  for (const c of cities) {
    const s = sumSites(c.sites);
    acc.activeIPs += s.activeIPs;
    acc.users += s.users;
    acc.qps += s.qps;
    acc.lps += s.lps;
    acc.siteCount += s.siteCount;
  }
  return acc;
}

function sumCountries(countries: Country[]): MetricSums {
  const acc: MetricSums = { activeIPs: 0, users: 0, qps: 0, lps: 0, siteCount: 0 };
  for (const c of countries) {
    const s = sumCities(c.cities);
    acc.activeIPs += s.activeIPs;
    acc.users += s.users;
    acc.qps += s.qps;
    acc.lps += s.lps;
    acc.siteCount += s.siteCount;
  }
  return acc;
}

function rollupTokens(
  sums: MetricSums,
  divisors: Pick<
    ResultsBreakdownProps,
    'tokensPerActiveIP' | 'tokensPerUser' | 'tokensPerQps' | 'tokensPerLps'
  >,
): number {
  // Aggregate-then-divide per metric, then sum the per-metric token totals.
  const ip = divisors.tokensPerActiveIP > 0
    ? Math.ceil(sums.activeIPs / divisors.tokensPerActiveIP)
    : 0;
  const us = divisors.tokensPerUser > 0
    ? Math.ceil(sums.users / divisors.tokensPerUser)
    : 0;
  const qp = divisors.tokensPerQps > 0
    ? Math.ceil(sums.qps / divisors.tokensPerQps)
    : 0;
  const lp = divisors.tokensPerLps > 0
    ? Math.ceil(sums.lps / divisors.tokensPerLps)
    : 0;
  return ip + us + qp + lp;
}

function siteLeafTokens(
  s: Site,
  divisors: Pick<
    ResultsBreakdownProps,
    'tokensPerActiveIP' | 'tokensPerUser' | 'tokensPerQps' | 'tokensPerLps'
  >,
): number {
  // Leaf rows show the per-Site token contribution computed from the same
  // aggregate-then-divide formula applied to the Site's own metrics. This
  // is the per-Site contribution; it does NOT pre-divide and roll-up
  // (which would violate D-11 at non-leaf levels).
  return rollupTokens(sumSites([s]), divisors);
}

// ─── Validation ──────────────────────────────────────────────────────────────

const VALIDATION_ERROR = 'Must be a non-negative whole number.' as const;

function validateNonNegativeInteger(raw: string): {
  ok: boolean;
  value: number;
} {
  if (raw.trim() === '') return { ok: false, value: 0 };
  // Reject anything that doesn't match a non-negative integer literal.
  if (!/^\d+$/.test(raw.trim())) return { ok: false, value: 0 };
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    return { ok: false, value: 0 };
  }
  return { ok: true, value: n };
}

// ─── EditableNumberCell (internal — un-exported) ─────────────────────────────

interface EditableNumberCellProps {
  value: number;
  onSave: (next: number) => void; // parent dispatches; we just notify on Enter/Save
  ariaLabel: string;
  isEditing: boolean;
  onBeginEdit: () => void;
  onEndEdit: () => void;
  testId: string;
}

function EditableNumberCell({
  value,
  onSave,
  ariaLabel,
  isEditing,
  onBeginEdit,
  onEndEdit,
  testId,
}: EditableNumberCellProps) {
  const [draft, setDraft] = useState<string>(String(value));
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const cellRef = useRef<HTMLTableCellElement | null>(null);

  // Reset draft + error each time we enter edit mode.
  useEffect(() => {
    if (isEditing) {
      setDraft(String(value));
      setError(null);
    }
  }, [isEditing, value]);

  // Focus + select once the input is mounted (synchronously after render so
  // userEvent under jsdom sees focus before the next assertion).
  useEffect(() => {
    if (isEditing) {
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.select();
      }
    }
  }, [isEditing]);

  function attemptSave() {
    const v = validateNonNegativeInteger(draft);
    if (!v.ok) {
      setError(VALIDATION_ERROR);
      return;
    }
    onSave(v.value);
    onEndEdit();
  }

  function cancel() {
    setError(null);
    onEndEdit();
  }

  // Blur outside the cell while editing = cancel.
  function handleBlur(e: React.FocusEvent<HTMLDivElement>) {
    if (!isEditing) return;
    const next = e.relatedTarget as Node | null;
    if (cellRef.current && next && cellRef.current.contains(next)) {
      // Focus moved to an internal element (Save / Cancel button) — stay.
      return;
    }
    cancel();
  }

  if (!isEditing) {
    return (
      <td
        ref={cellRef}
        data-testid={testId}
        className={cn(
          'px-4 py-2 text-right tabular-nums min-h-7',
          'group/cell cursor-text',
          'hover:bg-[var(--secondary)]/60',
        )}
        onClick={onBeginEdit}
      >
        <span
          className={cn(
            'inline-block min-w-0',
            'group-hover/row:border-b group-hover/row:border-dashed group-hover/row:border-[var(--muted-foreground)]/40',
          )}
          aria-label={ariaLabel}
        >
          {fmt(value)}
        </span>
      </td>
    );
  }

  return (
    <td
      ref={cellRef}
      data-testid={testId}
      className="px-4 py-2 text-right tabular-nums"
      onBlur={handleBlur}
    >
      <div className="flex items-center justify-end gap-1">
        <input
          ref={inputRef}
          type="number"
          inputMode="numeric"
          aria-label={ariaLabel}
          aria-invalid={error ? true : undefined}
          data-slot="input"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              attemptSave();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              cancel();
            }
          }}
          className={cn(
            'h-7 w-20 rounded-md border border-input bg-input-background px-2 py-1 text-sm text-right tabular-nums outline-none',
            'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]',
            error && 'border-[var(--destructive)]',
          )}
        />
        <button
          type="button"
          aria-label="Save change"
          onClick={attemptSave}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-input bg-background text-foreground hover:bg-[var(--secondary)]/60"
        >
          <Check className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label="Cancel edit"
          onClick={cancel}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-input bg-background text-foreground hover:bg-[var(--secondary)]/60"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {error && (
        <div
          className="mt-1 text-[12px] text-[var(--destructive)] text-right"
          role="alert"
        >
          {error}
        </div>
      )}
    </td>
  );
}

// ─── Row helpers ─────────────────────────────────────────────────────────────

interface ChevronToggleProps {
  expanded: boolean;
  onClick: () => void;
  label: string;
}

function ChevronToggle({ expanded, onClick, label }: ChevronToggleProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={expanded}
      aria-label={`Toggle ${label}`}
      className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-[var(--secondary)]/60"
    >
      {expanded ? (
        <ChevronDown className="h-3.5 w-3.5" />
      ) : (
        <ChevronRight className="h-3.5 w-3.5" />
      )}
    </button>
  );
}

interface NonLeafRowProps {
  testId: string;
  indentClass: string;
  expanded: boolean;
  onToggle: () => void;
  label: string;
  badge?: ReactNode;
  sums: MetricSums;
  tokens: number;
}

function NonLeafRow({
  testId,
  indentClass,
  expanded,
  onToggle,
  label,
  badge,
  sums,
  tokens,
}: NonLeafRowProps) {
  return (
    <tr
      data-testid={testId}
      className="border-t border-border font-semibold text-sm hover:bg-[var(--secondary)]/40 group/row"
    >
      <td className={cn('px-4 py-2', indentClass)}>
        <span className="inline-flex items-center gap-2">
          <ChevronToggle expanded={expanded} onClick={onToggle} label={label} />
          <span>{label}</span>
          {badge}
        </span>
      </td>
      <td className="px-4 py-2 text-right tabular-nums">{fmt(sums.activeIPs)}</td>
      <td className="px-4 py-2 text-right tabular-nums">{fmt(sums.users)}</td>
      <td className="px-4 py-2 text-right tabular-nums">{fmt(sums.qps)}</td>
      <td className="px-4 py-2 text-right tabular-nums">{fmt(sums.lps)}</td>
      <td
        data-testid="breakdown-tokens"
        className="px-4 py-2 text-right tabular-nums"
      >
        {fmt(tokens)}
      </td>
    </tr>
  );
}

// ─── ResultsBreakdown ────────────────────────────────────────────────────────

type EditState = { siteId: string; field: EditableSiteField } | null;

export function ResultsBreakdown({
  regions,
  tokensPerActiveIP,
  tokensPerUser,
  tokensPerQps,
  tokensPerLps,
  onSiteEdit,
}: ResultsBreakdownProps) {
  // Default expansion (D-10, revised for issue #15): Regions + Countries +
  // Cities all open by default so Site names are visible without an extra
  // click. Sizer wizards routinely auto-create `(Unassigned)` Country/City
  // placeholders (D-09) when users add Sites directly under a Region — with
  // Cities collapsed the breakdown showed only the placeholders and hid the
  // actual Site names.
  const [openRegions, setOpenRegions] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(regions.map((r) => [r.id, true])),
  );
  const [openCountries, setOpenCountries] = useState<Record<string, boolean>>(
    () => {
      const map: Record<string, boolean> = {};
      for (const r of regions) for (const c of r.countries) map[c.id] = true;
      return map;
    },
  );
  const [openCities, setOpenCities] = useState<Record<string, boolean>>(() => {
    const map: Record<string, boolean> = {};
    for (const r of regions)
      for (const c of r.countries)
        for (const ci of c.cities) map[ci.id] = true;
    return map;
  });

  // Edit state — one cell at a time.
  const [edit, setEdit] = useState<EditState>(null);

  const divisors = {
    tokensPerActiveIP,
    tokensPerUser,
    tokensPerQps,
    tokensPerLps,
  };

  const toggle = (
    setter: React.Dispatch<React.SetStateAction<Record<string, boolean>>>,
    id: string,
    defaultOpen: boolean,
  ) => {
    setter((prev) => {
      const cur = prev[id] ?? defaultOpen;
      return { ...prev, [id]: !cur };
    });
  };

  function handleSave(siteId: string, field: EditableSiteField, next: number) {
    onSiteEdit(siteId, { [field]: next } as Partial<Site>);
  }

  function isEditing(siteId: string, field: EditableSiteField): boolean {
    return edit?.siteId === siteId && edit?.field === field;
  }

  function beginEdit(siteId: string, field: EditableSiteField) {
    setEdit({ siteId, field });
  }

  function endEdit() {
    setEdit(null);
  }

  if (regions.length === 0) {
    // eslint-disable-next-line no-console
    console.warn('[ResultsBreakdown] regions is empty — section omitted');
    return null;
  }

  return (
    <section
      id="section-breakdown"
      data-testid="results-breakdown"
      className="scroll-mt-6 mb-8"
    >
      <header className="mb-3">
        <h2 className="text-lg font-semibold">Breakdown by Region</h2>
        <p className="text-sm text-muted-foreground">
          Tokens contributed by each Region, Country, City, and Site.
        </p>
      </header>

      <div className="rounded-md border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-[var(--secondary)]/40 text-left">
            <tr>
              <th className="px-4 py-2 font-semibold">Location</th>
              <th className="px-4 py-2 font-semibold text-right">Active IPs</th>
              <th className="px-4 py-2 font-semibold text-right">Users</th>
              <th className="px-4 py-2 font-semibold text-right">QPS</th>
              <th className="px-4 py-2 font-semibold text-right">LPS</th>
              <th className="px-4 py-2 font-semibold text-right">Tokens</th>
            </tr>
          </thead>
          <tbody>
            {regions.map((region, regionIdx) => {
              const regionExpanded = openRegions[region.id] ?? true;
              // Issue #16: regions whose name still equals the wizard's
              // default placeholder ("New Region") shouldn't surface that
              // label in the report — fall back to a numbered label so the
              // hierarchy reads cleanly even when the user never renamed
              // the Region in Step 1. State stays untouched (rename still
              // wins; this is display-only).
              const regionLabel =
                region.name.trim() === '' || region.name === 'New Region'
                  ? `Region ${regionIdx + 1}`
                  : region.name;
              const regionSums = sumCountries(region.countries);
              const regionTokens = rollupTokens(regionSums, divisors);
              const siteCount = regionSums.siteCount;
              const siteBadge = (
                <Badge variant="outline" className="text-[11px] font-semibold">
                  {siteCount === 1 ? '1 site' : `${fmt(siteCount)} sites`}
                </Badge>
              );

              const renderSite = (s: Site, indentClass: string) => {
                const leafTokens = siteLeafTokens(s, divisors);
                return (
                  <tr
                    key={s.id}
                    data-testid={`breakdown-row-${s.id}`}
                    className="border-t border-border text-sm font-normal hover:bg-[var(--secondary)]/40 group/row"
                  >
                    <td className={cn('px-4 py-2', indentClass)}>{s.name}</td>
                    <EditableNumberCell
                      testId={`breakdown-cell-${s.id}-activeIPs`}
                      ariaLabel={`Edit Active IPs for ${s.name}`}
                      value={s.activeIPs ?? 0}
                      isEditing={isEditing(s.id, 'activeIPs')}
                      onBeginEdit={() => beginEdit(s.id, 'activeIPs')}
                      onEndEdit={endEdit}
                      onSave={(n) => handleSave(s.id, 'activeIPs', n)}
                    />
                    <EditableNumberCell
                      testId={`breakdown-cell-${s.id}-users`}
                      ariaLabel={`Edit Users for ${s.name}`}
                      value={s.users ?? 0}
                      isEditing={isEditing(s.id, 'users')}
                      onBeginEdit={() => beginEdit(s.id, 'users')}
                      onEndEdit={endEdit}
                      onSave={(n) => handleSave(s.id, 'users', n)}
                    />
                    <EditableNumberCell
                      testId={`breakdown-cell-${s.id}-qps`}
                      ariaLabel={`Edit QPS for ${s.name}`}
                      value={s.qps ?? 0}
                      isEditing={isEditing(s.id, 'qps')}
                      onBeginEdit={() => beginEdit(s.id, 'qps')}
                      onEndEdit={endEdit}
                      onSave={(n) => handleSave(s.id, 'qps', n)}
                    />
                    <EditableNumberCell
                      testId={`breakdown-cell-${s.id}-lps`}
                      ariaLabel={`Edit LPS for ${s.name}`}
                      value={s.lps ?? 0}
                      isEditing={isEditing(s.id, 'lps')}
                      onBeginEdit={() => beginEdit(s.id, 'lps')}
                      onEndEdit={endEdit}
                      onSave={(n) => handleSave(s.id, 'lps', n)}
                    />
                    <td
                      data-testid="breakdown-tokens"
                      className="px-4 py-2 text-right tabular-nums"
                    >
                      {fmt(leafTokens)}
                    </td>
                  </tr>
                );
              };

              // Phantom-passthrough rendering (issue #16): `(Unassigned)`
              // Country/City rows are auto-created scaffolding (D-09), not
              // user-meaningful hierarchy. Skip the placeholder NonLeafRow
              // and render its descendants at the parent's child indent so
              // the report reflects the entered structure exactly. Aggregates
              // on the surviving parent rows already include all descendants.
              const renderCity = (city: City, cityIndent: string, siteIndent: string) => {
                const isPhantom = city.name === UNASSIGNED_PLACEHOLDER;
                if (isPhantom) {
                  return (
                    <Fragment key={city.id}>
                      {city.sites.map((s) => renderSite(s, cityIndent))}
                    </Fragment>
                  );
                }
                const cityExpanded = openCities[city.id] ?? true;
                const citySums = sumSites(city.sites);
                const cityTokens = rollupTokens(citySums, divisors);
                return (
                  <Fragment key={city.id}>
                    <NonLeafRow
                      testId={`breakdown-row-${city.id}`}
                      indentClass={cityIndent}
                      expanded={cityExpanded}
                      onToggle={() => toggle(setOpenCities, city.id, true)}
                      label={city.name}
                      sums={citySums}
                      tokens={cityTokens}
                    />
                    {cityExpanded && city.sites.map((s) => renderSite(s, siteIndent))}
                  </Fragment>
                );
              };

              const renderCountry = (country: Country, countryIndent: string, cityIndent: string, siteIndent: string) => {
                const isPhantom = country.name === UNASSIGNED_PLACEHOLDER;
                if (isPhantom) {
                  return (
                    <Fragment key={country.id}>
                      {country.cities.map((city) =>
                        renderCity(city, countryIndent, cityIndent),
                      )}
                    </Fragment>
                  );
                }
                const countryExpanded = openCountries[country.id] ?? true;
                const countrySums = sumCities(country.cities);
                const countryTokens = rollupTokens(countrySums, divisors);
                return (
                  <Fragment key={country.id}>
                    <NonLeafRow
                      testId={`breakdown-row-${country.id}`}
                      indentClass={countryIndent}
                      expanded={countryExpanded}
                      onToggle={() => toggle(setOpenCountries, country.id, true)}
                      label={country.name}
                      sums={countrySums}
                      tokens={countryTokens}
                    />
                    {countryExpanded &&
                      country.cities.map((city) => renderCity(city, cityIndent, siteIndent))}
                  </Fragment>
                );
              };

              return (
                <Fragment key={region.id}>
                  <NonLeafRow
                    testId={`breakdown-row-${region.id}`}
                    indentClass="pl-0"
                    expanded={regionExpanded}
                    onToggle={() => toggle(setOpenRegions, region.id, true)}
                    label={regionLabel}
                    badge={siteBadge}
                    sums={regionSums}
                    tokens={regionTokens}
                  />

                  {regionExpanded &&
                    region.countries.map((country) =>
                      renderCountry(country, 'pl-4', 'pl-8', 'pl-12'),
                    )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
