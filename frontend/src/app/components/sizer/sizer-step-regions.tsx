/**
 * sizer-step-regions.tsx — Step 1: Regions / Countries / Cities / Sites tree
 * UI with inline "+ Add" affordances per level, recursive TreeNode rendering,
 * detail pane on the right, and empty state.
 *
 * Per UI-SPEC §4 and CONTEXT D-07..D-10:
 *   - Two-column grid on lg+ (360px tree + detail), single column below.
 *   - Custom WAI-ARIA tree keyboard: Arrow nav over visible rows, Home/End,
 *     Enter selects, Space toggles collapse, Delete opens AlertDialog.
 *   - (Unassigned) Country / City rendered verbatim italic muted via
 *     UnassignedLabel.
 *   - ADD_SITE at Region level dispatches with parentRegionId → reducer
 *     auto-creates (Unassigned) Country + City per D-09.
 *   - Selection lives in `ui.selectedPath`; tree expand/collapse per node in
 *     `ui.expandedNodes`.
 *   - Breadcrumbs derived from selectedPath display verbatim names including
 *     UNASSIGNED_PLACEHOLDER.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import {
  Building2,
  Flag,
  Globe2,
  MapPin,
  Plus,
  Trash2,
} from 'lucide-react';

import { Button } from '../ui/button';
import { Card, CardContent, CardHeader } from '../ui/card';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { ScrollArea } from '../ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { Switch } from '../ui/switch';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog';
import { cn } from '../ui/utils';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbSeparator,
} from '../ui/breadcrumb';

import { useSizer, SIZER_IMPORT_BADGE_KEY } from './sizer-state';
import type { Region, Country, City, Site } from './sizer-types';
import { UNASSIGNED_PLACEHOLDER } from './sizer-types';
import { TreeNode, type TreeLevel } from './tree/tree-node';
import { UnassignedLabel } from './tree/unassigned-label';
import { InlineMarker } from './ui/inline-marker';
import { useActiveIssuesByPath } from './sizer-validation-banner';
import type { Issue } from './sizer-types';

// ─── Selected path encoding ───────────────────────────────────────────────────
// We encode selectedPath as "region:{id}" | "country:{id}" | "city:{id}" |
// "site:{id}" so the detail pane can pick the right form without walking.

type SelectedKind = 'region' | 'country' | 'city' | 'site';

interface ParsedSelection {
  kind: SelectedKind;
  id: string;
}

function parseSelection(path: string | null): ParsedSelection | null {
  if (!path) return null;
  const m = /^(region|country|city|site):(.+)$/.exec(path);
  if (!m) return null;
  return { kind: m[1] as SelectedKind, id: m[2] };
}

function encodeSelection(kind: SelectedKind, id: string): string {
  return `${kind}:${id}`;
}

// ─── Flat visible row list for keyboard nav ───────────────────────────────────

interface FlatRow {
  nodeId: string;
  kind: SelectedKind;
  level: TreeLevel;
  /** Parent node id at the next higher level (for ArrowLeft→parent). */
  parentNodeId: string | null;
  /** True if the node has children AND is currently expanded. */
  expanded: boolean;
  /** True if the node has children at all. */
  hasChildren: boolean;
}

/**
 * Nodes default to expanded when no explicit entry exists in `expandedNodes`.
 * Toggling a node stores `false`; toggling again stores `true`. This keeps
 * newly-created auto-(Unassigned) Country + City visible by default (D-09).
 */
function isExpanded(expandedNodes: Record<string, boolean>, id: string): boolean {
  return expandedNodes[id] !== false;
}

function flattenVisible(
  regions: Region[],
  expandedNodes: Record<string, boolean>,
): FlatRow[] {
  const rows: FlatRow[] = [];
  for (const r of regions) {
    const rExpanded = isExpanded(expandedNodes, r.id);
    rows.push({
      nodeId: r.id,
      kind: 'region',
      level: 1,
      parentNodeId: null,
      expanded: rExpanded,
      hasChildren: r.countries.length > 0,
    });
    if (!rExpanded) continue;
    for (const c of r.countries) {
      const cExpanded = isExpanded(expandedNodes, c.id);
      rows.push({
        nodeId: c.id,
        kind: 'country',
        level: 2,
        parentNodeId: r.id,
        expanded: cExpanded,
        hasChildren: c.cities.length > 0,
      });
      if (!cExpanded) continue;
      for (const ct of c.cities) {
        const ctExpanded = isExpanded(expandedNodes, ct.id);
        rows.push({
          nodeId: ct.id,
          kind: 'city',
          level: 3,
          parentNodeId: c.id,
          expanded: ctExpanded,
          hasChildren: ct.sites.length > 0,
        });
        if (!ctExpanded) continue;
        for (const s of ct.sites) {
          rows.push({
            nodeId: s.id,
            kind: 'site',
            level: 4,
            parentNodeId: ct.id,
            expanded: false,
            hasChildren: false,
          });
        }
      }
    }
  }
  return rows;
}

// ─── Main component ───────────────────────────────────────────────────────────

export function SizerStepRegions() {
  const { state, dispatch } = useSizer();
  const regions = state.core.regions;
  const expandedNodes = state.ui.expandedNodes;
  const selection = parseSelection(state.ui.selectedPath);

  const flatRows = useMemo(
    () => flattenVisible(regions, expandedNodes),
    [regions, expandedNodes],
  );

  // ─ Delete confirmation state ─
  const [deleteTarget, setDeleteTarget] = useState<ParsedSelection | null>(null);

  // ─ Phase 32 D-18: post-import status badge ─
  const [importBadge, setImportBadge] = useState<
    { regions: number; sites: number; niosx: number } | null
  >(null);
  useEffect(() => {
    let raw: string | null = null;
    try {
      raw = sessionStorage.getItem(SIZER_IMPORT_BADGE_KEY);
    } catch {
      return;
    }
    if (!raw) return;
    try {
      sessionStorage.removeItem(SIZER_IMPORT_BADGE_KEY);
    } catch {
      /* ignore */
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      !Number.isFinite((parsed as { regions: unknown }).regions) ||
      !Number.isFinite((parsed as { sites: unknown }).sites) ||
      !Number.isFinite((parsed as { niosx: unknown }).niosx)
    ) {
      return;
    }
    setImportBadge(parsed as { regions: number; sites: number; niosx: number });
    const timer = setTimeout(() => setImportBadge(null), 4000);
    return () => clearTimeout(timer);
  }, []);

  // No explicit auto-expand needed: `isExpanded()` defaults to true when no
  // entry exists in `expandedNodes`, so newly created Region / Country / City
  // nodes (including D-09 auto-(Unassigned) containers) are visible without
  // needing a follow-up dispatch.

  // ─ Selection helpers ─
  const select = useCallback(
    (kind: SelectedKind, id: string) => {
      dispatch({ type: 'SET_SELECTED_PATH', path: encodeSelection(kind, id) });
    },
    [dispatch],
  );

  const toggleExpanded = useCallback(
    (id: string) => {
      // `expandedNodes[id]` may be undefined (default-expanded). TOGGLE on
      // undefined stores `true` (no visible change). To get a real flip we
      // need two dispatches in that case.
      const entry = expandedNodes[id];
      if (entry === undefined) {
        // Currently visually expanded → we want to collapse. TOGGLE twice:
        // undefined → true → false.
        dispatch({ type: 'TOGGLE_NODE_EXPANDED', nodeId: id });
        dispatch({ type: 'TOGGLE_NODE_EXPANDED', nodeId: id });
      } else {
        dispatch({ type: 'TOGGLE_NODE_EXPANDED', nodeId: id });
      }
    },
    [dispatch, expandedNodes],
  );

  // ─ Container keyboard handler (WAI-ARIA tree pattern) ─
  const onTreeKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (flatRows.length === 0) return;
      const currentIdx = selection
        ? flatRows.findIndex((r) => r.nodeId === selection.id)
        : -1;

      const moveTo = (idx: number) => {
        const row = flatRows[idx];
        if (!row) return;
        select(row.kind, row.nodeId);
      };

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          moveTo(Math.min(flatRows.length - 1, Math.max(0, currentIdx + 1)));
          break;
        case 'ArrowUp':
          e.preventDefault();
          moveTo(Math.max(0, currentIdx - 1));
          break;
        case 'Home':
          e.preventDefault();
          moveTo(0);
          break;
        case 'End':
          e.preventDefault();
          moveTo(flatRows.length - 1);
          break;
        case 'ArrowRight': {
          if (currentIdx < 0) return;
          const row = flatRows[currentIdx];
          e.preventDefault();
          if (row.hasChildren && !row.expanded) {
            toggleExpanded(row.nodeId);
          } else if (row.expanded) {
            moveTo(currentIdx + 1);
          }
          break;
        }
        case 'ArrowLeft': {
          if (currentIdx < 0) return;
          const row = flatRows[currentIdx];
          e.preventDefault();
          if (row.expanded) {
            toggleExpanded(row.nodeId);
          } else if (row.parentNodeId) {
            const parentIdx = flatRows.findIndex((r) => r.nodeId === row.parentNodeId);
            if (parentIdx >= 0) moveTo(parentIdx);
          }
          break;
        }
        case ' ':
        case 'Space': {
          if (currentIdx < 0) return;
          const row = flatRows[currentIdx];
          if (row.hasChildren) {
            e.preventDefault();
            toggleExpanded(row.nodeId);
          }
          break;
        }
        case 'Delete':
        case 'Backspace': {
          if (currentIdx < 0) return;
          const row = flatRows[currentIdx];
          if (row.kind === 'region') {
            e.preventDefault();
            setDeleteTarget({ kind: 'region', id: row.nodeId });
          }
          break;
        }
      }
    },
    [flatRows, selection, select, toggleExpanded],
  );

  // ─ Add-region CTA (used in both header and empty state) ─
  const handleAddRegion = () => {
    dispatch({ type: 'ADD_REGION' });
  };

  // Auto-select the newly added region when region count grows.
  const prevRegionIds = useRef<string[]>(regions.map((r) => r.id));
  useEffect(() => {
    const prev = new Set(prevRegionIds.current);
    const added = regions.find((r) => !prev.has(r.id));
    if (added) {
      select('region', added.id);
    }
    prevRegionIds.current = regions.map((r) => r.id);
  }, [regions, select]);

  return (
    <div className="grid gap-6 lg:grid-cols-[360px_1fr]" data-testid="sizer-step-regions">
      <section aria-label="Hierarchy">
        <Card>
          <CardHeader className="flex-row items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <h2 className="text-lg font-medium">Hierarchy</h2>
              {importBadge ? (
                <span
                  data-testid="sizer-import-badge"
                  className="text-xs text-muted-foreground truncate"
                  role="status"
                  aria-live="polite"
                >
                  Imported {importBadge.regions} Regions, {importBadge.sites} Sites, {importBadge.niosx} NIOS-X systems into the Sizer.
                </span>
              ) : null}
            </div>
            <Button
              size="sm"
              onClick={handleAddRegion}
              data-testid="sizer-tree-add-region"
            >
              <Plus className="size-3" /> Region
            </Button>
          </CardHeader>
          <CardContent>
            {regions.length === 0 ? (
              <EmptyState onAdd={handleAddRegion} />
            ) : (
              <ScrollArea className="max-h-[calc(100vh-260px)]">
                <div
                  onKeyDown={onTreeKeyDown}
                  tabIndex={0}
                  className="focus-visible:outline-none"
                >
                  <ul
                    role="tree"
                    aria-label="Regions, Countries, Cities, Sites"
                    data-testid="sizer-tree"
                    className="list-none m-0 p-0"
                  >
                    {regions.map((region, ri) => (
                      <RegionRow
                        key={region.id}
                        region={region}
                        regionIndex={ri}
                        expandedNodes={expandedNodes}
                        selectedId={selection?.id ?? null}
                        onSelect={select}
                        onToggle={toggleExpanded}
                        onDelete={(kind, id) => setDeleteTarget({ kind, id })}
                      />
                    ))}
                  </ul>
                </div>
              </ScrollArea>
            )}
          </CardContent>
        </Card>
      </section>

      <section aria-label="Detail">
        <DetailPane />
      </section>

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent data-testid="sizer-delete-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleteTarget?.kind === 'region' && 'Delete region?'}
              {deleteTarget?.kind === 'country' && 'Delete country?'}
              {deleteTarget?.kind === 'city' && 'Delete city?'}
              {deleteTarget?.kind === 'site' && 'Delete site?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              This removes the selected node and all its descendants. This
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="sizer-delete-dialog-confirm"
              onClick={() => {
                if (!deleteTarget) return;
                if (deleteTarget.kind === 'region') {
                  dispatch({ type: 'DELETE_REGION', regionId: deleteTarget.id });
                } else if (deleteTarget.kind === 'country') {
                  dispatch({ type: 'DELETE_COUNTRY', countryId: deleteTarget.id });
                } else if (deleteTarget.kind === 'city') {
                  dispatch({ type: 'DELETE_CITY', cityId: deleteTarget.id });
                } else if (deleteTarget.kind === 'site') {
                  dispatch({ type: 'DELETE_SITE', siteId: deleteTarget.id });
                }
                dispatch({ type: 'SET_SELECTED_PATH', path: null });
                setDeleteTarget(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div
      className="flex flex-col items-center justify-center text-center py-8 gap-3"
      data-testid="sizer-empty-state"
    >
      <Globe2 className="size-16 text-muted-foreground" aria-hidden="true" />
      <h3 className="text-lg font-medium">Start your hierarchy</h3>
      <p className="text-sm text-muted-foreground max-w-xs">
        Add your first Region to begin sizing. Regions group countries, cities,
        and sites by geography or cloud substrate.
      </p>
      <Button size="lg" onClick={onAdd} data-testid="sizer-empty-add-region">
        <Plus className="size-3" /> Add first Region
      </Button>
    </div>
  );
}

// ─── Row renderers ────────────────────────────────────────────────────────────

interface RowCommonProps {
  expandedNodes: Record<string, boolean>;
  selectedId: string | null;
  onSelect: (kind: SelectedKind, id: string) => void;
  onToggle: (id: string) => void;
  onDelete: (kind: SelectedKind, id: string) => void;
}

function RegionRow({
  region,
  regionIndex,
  ...p
}: { region: Region; regionIndex: number } & RowCommonProps) {
  const { dispatch } = useSizer();
  const expanded = isExpanded(p.expandedNodes, region.id);
  const issuesByPath = useActiveIssuesByPath();
  const regionPath = `regions[${regionIndex}]`;
  const regionIssue: Issue | undefined = issuesByPath.get(regionPath);
  return (
    <TreeNode
      id={region.id}
      level={1}
      expanded={expanded}
      selected={p.selectedId === region.id}
      onToggle={() => p.onToggle(region.id)}
      onSelect={() => p.onSelect('region', region.id)}
      label={
        <span
          className="inline-flex items-center gap-2 min-w-0"
          data-sizer-path={regionPath}
          tabIndex={-1}
        >
          <Globe2 className="size-4 text-muted-foreground shrink-0" aria-hidden="true" />
          <span className="font-medium truncate">{region.name}</span>
          <RegionTypePill region={region} />
          {regionIssue && <InlineMarker issue={regionIssue} />}
        </span>
      }
      rightSlot={
        <button
          type="button"
          aria-label="Delete region"
          data-testid={`sizer-tree-delete-${region.id}`}
          onClick={(e) => {
            e.stopPropagation();
            p.onDelete('region', region.id);
          }}
          className="p-1 rounded hover:bg-black/5"
        >
          <Trash2 className="size-3 text-muted-foreground" aria-hidden="true" />
        </button>
      }
    >
      {region.countries.map((country, ci) => (
        <CountryRow
          key={country.id}
          country={country}
          regionId={region.id}
          regionIndex={regionIndex}
          countryIndex={ci}
          {...p}
        />
      ))}
      <li className="list-none">
        <button
          type="button"
          data-testid={`sizer-tree-add-country-${region.id}`}
          onClick={(e) => {
            e.stopPropagation();
            dispatch({ type: 'ADD_COUNTRY', regionId: region.id });
          }}
          className="ml-8 my-1 text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
        >
          <Plus className="size-3" /> Add Country
        </button>
      </li>
      <li className="list-none">
        <button
          type="button"
          data-testid={`sizer-tree-add-site-under-region-${region.id}`}
          onClick={(e) => {
            e.stopPropagation();
            dispatch({ type: 'ADD_SITE', parentRegionId: region.id });
          }}
          className="ml-8 my-1 text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
        >
          <Plus className="size-3" /> Add Site
        </button>
      </li>
    </TreeNode>
  );
}

function CountryRow({
  country,
  regionId: _regionId,
  regionIndex,
  countryIndex,
  ...p
}: {
  country: Country;
  regionId: string;
  regionIndex: number;
  countryIndex: number;
} & RowCommonProps) {
  const { dispatch } = useSizer();
  const expanded = isExpanded(p.expandedNodes, country.id);
  return (
    <TreeNode
      id={country.id}
      level={2}
      expanded={expanded}
      selected={p.selectedId === country.id}
      onToggle={() => p.onToggle(country.id)}
      onSelect={() => p.onSelect('country', country.id)}
      label={
        <>
          <Flag className="size-4 text-muted-foreground shrink-0" aria-hidden="true" />
          <UnassignedLabel nodeKind="country" nodeId={country.id} name={country.name} />
        </>
      }
      rightSlot={
        <button
          type="button"
          aria-label="Delete country"
          data-testid={`sizer-tree-delete-${country.id}`}
          onClick={(e) => {
            e.stopPropagation();
            p.onDelete('country', country.id);
          }}
          className="p-1 rounded hover:bg-black/5"
        >
          <Trash2 className="size-3 text-muted-foreground" aria-hidden="true" />
        </button>
      }
    >
      {country.cities.map((city, cti) => (
        <CityRow
          key={city.id}
          city={city}
          countryId={country.id}
          regionIndex={regionIndex}
          countryIndex={countryIndex}
          cityIndex={cti}
          {...p}
        />
      ))}
      <li className="list-none">
        <button
          type="button"
          data-testid={`sizer-tree-add-city-${country.id}`}
          onClick={(e) => {
            e.stopPropagation();
            dispatch({ type: 'ADD_CITY', countryId: country.id });
          }}
          className="ml-12 my-1 text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
        >
          <Plus className="size-3" /> Add City
        </button>
      </li>
    </TreeNode>
  );
}

function CityRow({
  city,
  countryId: _countryId,
  regionIndex,
  countryIndex,
  cityIndex,
  ...p
}: {
  city: City;
  countryId: string;
  regionIndex: number;
  countryIndex: number;
  cityIndex: number;
} & RowCommonProps) {
  const { dispatch } = useSizer();
  const expanded = isExpanded(p.expandedNodes, city.id);
  return (
    <TreeNode
      id={city.id}
      level={3}
      expanded={expanded}
      selected={p.selectedId === city.id}
      onToggle={() => p.onToggle(city.id)}
      onSelect={() => p.onSelect('city', city.id)}
      label={
        <>
          <Building2 className="size-4 text-muted-foreground shrink-0" aria-hidden="true" />
          <UnassignedLabel nodeKind="city" nodeId={city.id} name={city.name} />
        </>
      }
      rightSlot={
        <button
          type="button"
          aria-label="Delete city"
          data-testid={`sizer-tree-delete-${city.id}`}
          onClick={(e) => {
            e.stopPropagation();
            p.onDelete('city', city.id);
          }}
          className="p-1 rounded hover:bg-black/5"
        >
          <Trash2 className="size-3 text-muted-foreground" aria-hidden="true" />
        </button>
      }
    >
      {city.sites.map((site, si) => (
        <SiteRow
          key={site.id}
          site={site}
          cityId={city.id}
          sitePath={`regions[${regionIndex}].countries[${countryIndex}].cities[${cityIndex}].sites[${si}]`}
          {...p}
        />
      ))}
      <li className="list-none">
        <button
          type="button"
          data-testid={`sizer-tree-add-site-${city.id}`}
          onClick={(e) => {
            e.stopPropagation();
            dispatch({ type: 'ADD_SITE', parentCityId: city.id });
          }}
          className="ml-16 my-1 text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
        >
          <Plus className="size-3" /> Add Site
        </button>
      </li>
    </TreeNode>
  );
}

function SiteRow({
  site,
  cityId: _cityId,
  sitePath,
  ...p
}: { site: Site; cityId: string; sitePath: string } & RowCommonProps) {
  const issuesByPath = useActiveIssuesByPath();
  const issue = issuesByPath.get(sitePath);
  return (
    <TreeNode
      id={site.id}
      level={4}
      isLeaf
      expanded={false}
      selected={p.selectedId === site.id}
      onToggle={() => {}}
      onSelect={() => p.onSelect('site', site.id)}
      label={
        <span
          className="inline-flex items-center gap-2 min-w-0"
          data-sizer-path={sitePath}
          tabIndex={-1}
        >
          <MapPin className="size-4 text-muted-foreground shrink-0" aria-hidden="true" />
          <span className="truncate">{site.name}</span>
          {site.multiplier > 1 && (
            <span className="text-xs text-muted-foreground">×{site.multiplier}</span>
          )}
          {issue && <InlineMarker issue={issue} />}
        </span>
      }
      rightSlot={
        <button
          type="button"
          aria-label="Delete site"
          data-testid={`sizer-tree-delete-${site.id}`}
          onClick={(e) => {
            e.stopPropagation();
            p.onDelete('site', site.id);
          }}
          className="p-1 rounded hover:bg-black/5"
        >
          <Trash2 className="size-3 text-muted-foreground" aria-hidden="true" />
        </button>
      }
    />
  );
}

// ─── Detail pane ──────────────────────────────────────────────────────────────

function DetailPane() {
  const { state } = useSizer();
  const selection = parseSelection(state.ui.selectedPath);

  const { crumbs, content } = useMemo(() => {
    if (!selection) return { crumbs: [], content: null as React.ReactNode };
    for (const region of state.core.regions) {
      if (selection.kind === 'region' && region.id === selection.id) {
        return {
          crumbs: [region.name],
          content: <RegionForm region={region} /> as React.ReactNode,
        };
      }
      for (const country of region.countries) {
        if (selection.kind === 'country' && country.id === selection.id) {
          return {
            crumbs: [region.name, country.name],
            content: <CountryForm country={country} /> as React.ReactNode,
          };
        }
        for (const city of country.cities) {
          if (selection.kind === 'city' && city.id === selection.id) {
            return {
              crumbs: [region.name, country.name, city.name],
              content: <CityForm city={city} /> as React.ReactNode,
            };
          }
          for (const site of city.sites) {
            if (selection.kind === 'site' && site.id === selection.id) {
              return {
                crumbs: [region.name, country.name, city.name, site.name],
                content: <SiteInfo /> as React.ReactNode,
              };
            }
          }
        }
      }
    }
    return { crumbs: [], content: null as React.ReactNode };
  }, [selection, state.core.regions]);

  if (!selection || !content) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-sm text-muted-foreground">
          Select a node in the tree to edit its properties.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <Breadcrumb data-testid="sizer-detail-breadcrumbs">
          <BreadcrumbList>
            {crumbs.map((c, i) => (
              <span key={`${i}-${c}`} className="inline-flex items-center">
                {i > 0 && <BreadcrumbSeparator />}
                <BreadcrumbItem
                  className={cn(c === UNASSIGNED_PLACEHOLDER && 'italic text-muted-foreground')}
                >
                  {c}
                </BreadcrumbItem>
              </span>
            ))}
          </BreadcrumbList>
        </Breadcrumb>
      </CardHeader>
      <CardContent>{content}</CardContent>
    </Card>
  );
}

function RegionForm({ region }: { region: Region }) {
  const { dispatch } = useSizer();
  return (
    <form className="flex flex-col gap-4" data-testid="sizer-region-form" onSubmit={(e) => e.preventDefault()}>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`region-name-${region.id}`}>Name</Label>
        <Input
          id={`region-name-${region.id}`}
          data-testid="sizer-region-name"
          value={region.name}
          onChange={(e) =>
            dispatch({
              type: 'UPDATE_REGION',
              regionId: region.id,
              patch: { name: e.target.value },
            })
          }
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label>Type</Label>
        <Select
          value={region.type}
          onValueChange={(v) =>
            dispatch({
              type: 'UPDATE_REGION',
              regionId: region.id,
              patch: { type: v as Region['type'] },
            })
          }
        >
          <SelectTrigger data-testid="sizer-region-type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="on-premises">On-Premises</SelectItem>
            <SelectItem value="aws">AWS</SelectItem>
            <SelectItem value="azure">Azure</SelectItem>
            <SelectItem value="gcp">GCP</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {region.type !== 'on-premises' && (
        <div className="flex items-center justify-between gap-2">
          <div>
            <Label htmlFor={`region-cnd-${region.id}`}>Cloud-native DNS</Label>
            <p className="text-xs text-muted-foreground">
              When on, cloud-native DNS objects are excluded from management totals.
            </p>
          </div>
          <Switch
            id={`region-cnd-${region.id}`}
            data-testid="sizer-region-cloud-native-dns"
            checked={region.cloudNativeDns}
            onCheckedChange={(v) =>
              dispatch({
                type: 'UPDATE_REGION',
                regionId: region.id,
                patch: { cloudNativeDns: v },
              })
            }
          />
        </div>
      )}
    </form>
  );
}

function CountryForm({ country }: { country: Country }) {
  const { dispatch } = useSizer();
  return (
    <form className="flex flex-col gap-4" data-testid="sizer-country-form" onSubmit={(e) => e.preventDefault()}>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`country-name-${country.id}`}>Name</Label>
        <Input
          id={`country-name-${country.id}`}
          data-testid="sizer-country-name"
          value={country.name}
          onChange={(e) =>
            dispatch({
              type: 'UPDATE_COUNTRY',
              countryId: country.id,
              patch: { name: e.target.value },
            })
          }
        />
      </div>
    </form>
  );
}

function CityForm({ city }: { city: City }) {
  const { dispatch } = useSizer();
  return (
    <form className="flex flex-col gap-4" data-testid="sizer-city-form" onSubmit={(e) => e.preventDefault()}>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`city-name-${city.id}`}>Name</Label>
        <Input
          id={`city-name-${city.id}`}
          data-testid="sizer-city-name"
          value={city.name}
          onChange={(e) =>
            dispatch({
              type: 'UPDATE_CITY',
              cityId: city.id,
              patch: { name: e.target.value },
            })
          }
        />
      </div>
    </form>
  );
}

function SiteInfo() {
  return (
    <p className="text-sm text-muted-foreground" data-testid="sizer-site-info">
      Site details are edited in Step 2 — Sites.
    </p>
  );
}

const REGION_TYPE_LABEL: Record<Region['type'], string> = {
  'on-premises': 'On-Prem',
  aws: 'AWS',
  azure: 'Azure',
  gcp: 'GCP',
};

function RegionTypePill({ region }: { region: Region }) {
  const { dispatch } = useSizer();
  return (
    <span
      className="shrink-0"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <Select
        value={region.type}
        onValueChange={(v) =>
          dispatch({
            type: 'UPDATE_REGION',
            regionId: region.id,
            patch: { type: v as Region['type'] },
          })
        }
      >
        <SelectTrigger
          data-testid={`sizer-region-type-pill-${region.id}`}
          aria-label={`Region type: ${REGION_TYPE_LABEL[region.type]}. Click to change.`}
          className="h-6 px-2 py-0 text-xs gap-1 rounded-full border-dashed text-muted-foreground hover:text-foreground hover:bg-black/5 [&>svg]:size-3"
        >
          <SelectValue>{REGION_TYPE_LABEL[region.type]}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="on-premises">On-Premises</SelectItem>
          <SelectItem value="aws">AWS</SelectItem>
          <SelectItem value="azure">Azure</SelectItem>
          <SelectItem value="gcp">GCP</SelectItem>
        </SelectContent>
      </Select>
    </span>
  );
}
