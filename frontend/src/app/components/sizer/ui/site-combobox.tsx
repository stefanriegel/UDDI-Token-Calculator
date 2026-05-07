/**
 * site-combobox.tsx — reusable 4-level indented site picker used by Step 3
 * (Infrastructure Placement) and later by Phases 31/32.
 *
 * Behavior per plan 30-05 Task 1 / UI-SPEC §6.1 / CONTEXT D-16 + D-17:
 *   - Shadcn `<Command>` inside `<Popover>`.
 *   - Options flattened from Region → Country → City → Site, each rendered as
 *     a single row indented by depth (`pl-{level*4}`).
 *   - `(Unassigned)` Country/City containers are hidden from the picker so the
 *     Region → Site quick-add flow does not leak placeholder rungs into the UI.
 *     Their descendant Sites remain selectable and visually re-parented under
 *     the Region heading. Real (named) Country/City containers still render
 *     and are non-selectable. (Issue #29)
 *   - Typeahead filters by any path segment (region / country / city / site).
 *   - Single-mode: click selects a site id, popover closes, trigger shows the
 *     site's path with `(Unassigned)` segments collapsed
 *     ("EU / DE / Berlin / Site-A", or "EU / Site-A" when only Region+Site
 *     are real).
 *   - Multi-mode: each row has an aria-checkbox; trigger shows "{n} sites".
 *
 * Discriminated-union props ensure callers pick exactly one of single/multi.
 */
import * as React from 'react';
import { Check } from 'lucide-react';

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '../../ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover';
import { Button } from '../../ui/button';
import { cn } from '../../ui/utils';
import { UNASSIGNED_PLACEHOLDER, type Region } from '../sizer-types';

// ─── Public props (discriminated union) ───────────────────────────────────────

interface BaseProps {
  regions: Region[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

interface SingleProps extends BaseProps {
  mode?: 'single';
  value: string | null;
  onChange: (v: string | null) => void;
}

interface MultiProps extends BaseProps {
  mode: 'multi';
  values: string[];
  onChange: (v: string[]) => void;
}

export type SiteComboboxProps = SingleProps | MultiProps;

// ─── Flattening ───────────────────────────────────────────────────────────────

interface FlatRow {
  kind: 'region' | 'country' | 'city' | 'site';
  id: string;
  regionId: string;
  regionName: string;
  /** Tree depth, 1=Region … 4=Site. Drives indent. */
  level: 1 | 2 | 3 | 4;
  name: string;
  /** Site path for filter/display, '' for non-sites. e.g. "EU / DE / Berlin / Site-A" */
  path: string;
}

function buildSitePath(
  regionName: string,
  countryName: string,
  cityName: string,
  siteName: string,
): string {
  const segs = [regionName, countryName, cityName, siteName].filter(
    (s) => s !== UNASSIGNED_PLACEHOLDER,
  );
  return segs.join(' / ');
}

function flatten(regions: Region[]): FlatRow[] {
  const rows: FlatRow[] = [];
  for (const r of regions) {
    rows.push({
      kind: 'region',
      id: r.id,
      regionId: r.id,
      regionName: r.name,
      level: 1,
      name: r.name,
      path: '',
    });
    for (const c of r.countries) {
      const countryUnassigned = c.name === UNASSIGNED_PLACEHOLDER;
      if (!countryUnassigned) {
        rows.push({
          kind: 'country',
          id: c.id,
          regionId: r.id,
          regionName: r.name,
          level: 2,
          name: c.name,
          path: '',
        });
      }
      for (const ct of c.cities) {
        const cityUnassigned = ct.name === UNASSIGNED_PLACEHOLDER;
        if (!cityUnassigned) {
          // Promote real City rows to level 2 when their parent Country is
          // unassigned (so the indent matches the visible hierarchy).
          rows.push({
            kind: 'city',
            id: ct.id,
            regionId: r.id,
            regionName: r.name,
            level: countryUnassigned ? 2 : 3,
            name: ct.name,
            path: '',
          });
        }
        for (const s of ct.sites) {
          // Site indent collapses one level for each unassigned ancestor so the
          // visible tree looks intentional after `(Unassigned)` rows are hidden.
          let level: 1 | 2 | 3 | 4 = 4;
          if (countryUnassigned && cityUnassigned) level = 2;
          else if (countryUnassigned || cityUnassigned) level = 3;
          rows.push({
            kind: 'site',
            id: s.id,
            regionId: r.id,
            regionName: r.name,
            level,
            name: s.name,
            path: buildSitePath(r.name, c.name, ct.name, s.name),
          });
        }
      }
    }
  }
  return rows;
}

function indentClass(level: 1 | 2 | 3 | 4): string {
  // Use pl-{level*4} per UI-SPEC §6.1.
  switch (level) {
    case 1:
      return 'pl-4';
    case 2:
      return 'pl-8';
    case 3:
      return 'pl-12';
    case 4:
      return 'pl-16';
  }
}

function findSitePath(regions: Region[], siteId: string): string | null {
  for (const r of regions) {
    for (const c of r.countries) {
      for (const ct of c.cities) {
        for (const s of ct.sites) {
          if (s.id === siteId) return buildSitePath(r.name, c.name, ct.name, s.name);
        }
      }
    }
  }
  return null;
}

function findSiteName(regions: Region[], siteId: string): string | null {
  for (const r of regions) {
    for (const c of r.countries) {
      for (const ct of c.cities) {
        for (const s of ct.sites) {
          if (s.id === siteId) return s.name;
        }
      }
    }
  }
  return null;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function SiteCombobox(props: SiteComboboxProps) {
  const { regions, placeholder, disabled, className } = props;
  const isMulti = props.mode === 'multi';
  const [open, setOpen] = React.useState(false);

  const flat = React.useMemo(() => flatten(regions), [regions]);
  // Group rows by region for render: [{ regionId, regionName, rows: FlatRow[] }]
  const grouped = React.useMemo(() => {
    const groups: Array<{ regionId: string; regionName: string; rows: FlatRow[] }> = [];
    for (const row of flat) {
      if (row.kind === 'region') {
        groups.push({ regionId: row.regionId, regionName: row.regionName, rows: [] });
      } else {
        groups[groups.length - 1]?.rows.push(row);
      }
    }
    return groups;
  }, [flat]);

  // Trigger label
  let triggerLabel: React.ReactNode;
  if (isMulti) {
    const vs = (props as MultiProps).values;
    if (vs.length === 0) {
      triggerLabel = <span className="text-muted-foreground">{placeholder ?? 'Select sites…'}</span>;
    } else {
      const firstName = findSiteName(regions, vs[0]) ?? '';
      triggerLabel = (
        <span>
          {vs.length} {vs.length === 1 ? 'site' : 'sites'}
          {firstName ? <span className="text-muted-foreground"> · {firstName}</span> : null}
        </span>
      );
    }
  } else {
    const v = (props as SingleProps).value;
    if (!v) {
      triggerLabel = <span className="text-muted-foreground">{placeholder ?? 'Select site…'}</span>;
    } else {
      const path = findSitePath(regions, v);
      triggerLabel = <span className="truncate">{path ?? v}</span>;
    }
  }

  const selectedSet = React.useMemo(() => {
    if (isMulti) return new Set((props as MultiProps).values);
    const single = (props as SingleProps).value;
    return new Set(single ? [single] : []);
  }, [isMulti, props]);

  const handleSelect = (siteId: string) => {
    if (isMulti) {
      const cur = new Set((props as MultiProps).values);
      if (cur.has(siteId)) cur.delete(siteId);
      else cur.add(siteId);
      (props as MultiProps).onChange(Array.from(cur));
    } else {
      (props as SingleProps).onChange(siteId);
      setOpen(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={isMulti ? 'Select sites' : 'Select site'}
          disabled={disabled}
          className={cn('w-full justify-between font-normal', className)}
        >
          {triggerLabel}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[360px] p-0" align="start">
        <Command
          // Custom filter: match on the combined searchable string we supply as `value`.
          filter={(value, search) => {
            const hay = value.toLowerCase();
            const needle = search.toLowerCase().trim();
            if (!needle) return 1;
            return hay.includes(needle) ? 1 : 0;
          }}
        >
          <CommandInput placeholder="Search sites…" />
          <CommandList>
            <CommandEmpty>No sites found.</CommandEmpty>
            {grouped.map((group) => (
              <CommandGroup key={group.regionId} heading={group.regionName}>
                {group.rows.map((row) => {
                  const selectable = row.kind === 'site';
                  const selected = selectable && selectedSet.has(row.id);
                  const searchableValue = `${group.regionName} ${row.name} ${row.path}`;
                  if (!selectable) {
                    // Container rows (country/city) — rendered as non-interactive labels.
                    return (
                      <div
                        key={row.id}
                        data-testid={`sizer-site-combobox-label-${row.id}`}
                        className={cn('flex items-center text-sm py-1', indentClass(row.level))}
                        aria-hidden="true"
                      >
                        {row.name}
                      </div>
                    );
                  }
                  return (
                    <CommandItem
                      key={row.id}
                      value={searchableValue}
                      data-testid={`sizer-site-combobox-option-${row.id}`}
                      onSelect={() => handleSelect(row.id)}
                      className={cn(indentClass(row.level))}
                    >
                      {isMulti ? (
                        <span
                          role="checkbox"
                          aria-checked={selected}
                          className={cn(
                            'mr-2 flex size-4 items-center justify-center rounded-[4px] border',
                            selected ? 'bg-primary text-primary-foreground border-primary' : 'bg-input-background',
                          )}
                        >
                          {selected && <Check className="size-3" />}
                        </span>
                      ) : (
                        <Check
                          className={cn('mr-2 size-4', selected ? 'opacity-100' : 'opacity-0')}
                        />
                      )}
                      <span>{row.name}</span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
