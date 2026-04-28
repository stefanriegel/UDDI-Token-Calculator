/**
 * sizer-state.ts — Reducer + Context + sessionStorage Provider (Phase 30).
 *
 * Per CONTEXT decisions:
 *   - D-01: useReducer + React Context; typed actions; testable in isolation.
 *   - D-02: sessionStorage under single key `ddi_sizer_state_v1`; hydrate on
 *           mount via useReducer init arg (Pitfall 3); debounced 300ms writes;
 *           pagehide flush (Pitfall 2).
 *   - D-03: No new runtime deps. Plain spread for every reducer case.
 *   - D-09: ADD_SITE under a Region auto-creates (Unassigned) Country + City.
 *   - D-15: CLONE_SITE names clones "{orig} (2)", "(3)", ... and inherits
 *           overrides.
 *   - D-20 / W-3: SECURITY_RECALC_FROM_SITES sums Σ verified / Σ unverified
 *           from the current state and sets the auto-filled flag.
 *   - D-30: Reducer is pure; every action covered by unit tests.
 *   - Pitfall 8: SITE_DERIVE skips any field flagged in ui.siteOverrides[siteId].
 *
 * Consumers in this phase: sizer-wizard.tsx (Plan 30-03+). Later plans dispatch
 * actions; this file never imports from sizer-derive/calc/validate to keep the
 * reducer a pure UI-state machine.
 */

import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useReducer,
  useRef,
  type Dispatch,
  type ReactNode,
} from 'react';
import {
  UNASSIGNED_PLACEHOLDER,
  type City,
  type Country,
  type DeriveOverrides,
  type GlobalSettings,
  type NiosXSystem,
  type Region,
  type SecurityInputs,
  type Site,
  type SizerState,
  type XaasServicePoint,
} from './sizer-types';
import { mergeFullState } from './sizer-import';

// ─── UI slice ─────────────────────────────────────────────────────────────────

export interface SizerUI {
  activeStep: 1 | 2 | 3 | 4;
  selectedPath: string | null;
  siteMode: Record<string, 'users' | 'manual'>;
  siteOverrides: Record<string, Partial<Record<keyof DeriveOverrides, true>>>;
  expandedNodes: Record<string, boolean>;
  dismissedCodes: string[];
  sectionsOpen: { modules: boolean; growth: boolean; security: boolean };
  growthBufferAdvanced: boolean;
  securityAutoFilled: { tdVerifiedAssets: boolean; tdUnverifiedAssets: boolean };
  /** Schema version for sessionStorage blob. Bump when shape changes. */
  _v: 1;
}

export interface SizerFullState {
  core: SizerState;
  ui: SizerUI;
}

// ─── Actions (discriminated union) ────────────────────────────────────────────
// Hooks for future undo/redo (Pitfall 8-style action granularity preserved)

export type SizerAction =
  // Hierarchy
  | { type: 'ADD_REGION' }
  | { type: 'UPDATE_REGION'; regionId: string; patch: Partial<Region> }
  | { type: 'DELETE_REGION'; regionId: string }
  | { type: 'ADD_COUNTRY'; regionId: string }
  | { type: 'UPDATE_COUNTRY'; countryId: string; patch: { name?: string } }
  | { type: 'DELETE_COUNTRY'; countryId: string }
  | { type: 'ADD_CITY'; countryId: string }
  | { type: 'UPDATE_CITY'; cityId: string; patch: { name?: string } }
  | { type: 'DELETE_CITY'; cityId: string }
  // Sites
  | { type: 'ADD_SITE'; parentCityId?: string; parentRegionId?: string }
  | { type: 'UPDATE_SITE'; siteId: string; patch: Partial<Site> }
  | { type: 'DELETE_SITE'; siteId: string }
  | { type: 'CLONE_SITE'; siteId: string; count: number }
  | { type: 'SITE_DERIVE'; siteId: string; derived: Partial<Site> }
  | { type: 'SITE_SET_MODE'; siteId: string; mode: 'users' | 'manual' }
  | { type: 'SITE_MARK_OVERRIDE'; siteId: string; field: keyof DeriveOverrides }
  | { type: 'SITE_CLEAR_OVERRIDE'; siteId: string; field: keyof DeriveOverrides }
  // Infrastructure
  | { type: 'ADD_NIOSX' }
  | { type: 'UPDATE_NIOSX'; id: string; patch: Partial<NiosXSystem> }
  | { type: 'DELETE_NIOSX'; id: string }
  | { type: 'ADD_XAAS'; regionId: string }
  | { type: 'UPDATE_XAAS'; id: string; patch: Partial<XaasServicePoint> }
  | { type: 'DELETE_XAAS'; id: string }
  // Settings
  | { type: 'SET_GROWTH_BUFFER'; value: number }
  | { type: 'SET_OVERHEAD'; category: 'mgmt' | 'server' | 'reporting' | 'security'; value?: number }
  | { type: 'TOGGLE_GROWTH_ADVANCED' }
  | { type: 'SET_MODULE_TOGGLE'; key: keyof GlobalSettings; value: boolean }
  | { type: 'SET_SECURITY'; patch: Partial<SecurityInputs> }
  | { type: 'SECURITY_RECALC_FROM_SITES' }
  // UI-only
  | { type: 'SET_ACTIVE_STEP'; step: 1 | 2 | 3 | 4 }
  | { type: 'SET_SELECTED_PATH'; path: string | null }
  | { type: 'TOGGLE_NODE_EXPANDED'; nodeId: string }
  | { type: 'TOGGLE_SECTION'; section: 'modules' | 'growth' | 'security' }
  | { type: 'DISMISS_ISSUE'; code: string }
  | { type: 'UNDISMISS_ISSUE'; code: string }
  | { type: 'RESET_STATE' }
  // Phase 32 — Scan import bridge (D-16 / D-17)
  | { type: 'IMPORT_SCAN'; payload: SizerFullState }
  | { type: 'HYDRATE'; state: SizerFullState }
  | { type: 'RESET' };

// ─── Persistence ──────────────────────────────────────────────────────────────

export const STORAGE_KEY = 'ddi_sizer_state_v1';
// Phase 32 D-18: ephemeral sessionStorage key for the post-import status badge.
// Written by wizard.tsx in handleSizerImportConfirm and consumed (then cleared)
// by sizer-step-regions.tsx on its first mount after the route flip.
export const SIZER_IMPORT_BADGE_KEY = 'ddi_sizer_import_badge_v1';
const CURRENT_VERSION = 1 as const;

export function newId(): string {
  // crypto.randomUUID is Baseline 2022; jsdom (Node 18+) provides it.
  // Fallback for environments lacking it (shouldn't happen in our targets).
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function initialSizerState(): SizerFullState {
  return {
    core: {
      regions: [],
      globalSettings: {
        growthBuffer: 0.2,
        growthBufferAdvanced: false,
      },
      security: {
        securityEnabled: false,
        socInsightsEnabled: false,
        tdVerifiedAssets: 0,
        tdUnverifiedAssets: 0,
        dossierQueriesPerDay: 0,
        lookalikeDomainsMentioned: 0,
      },
      infrastructure: { niosx: [], xaas: [] },
    },
    ui: {
      activeStep: 1,
      selectedPath: null,
      siteMode: {},
      siteOverrides: {},
      expandedNodes: {},
      dismissedCodes: [],
      sectionsOpen: { modules: true, growth: true, security: true },
      growthBufferAdvanced: false,
      securityAutoFilled: { tdVerifiedAssets: false, tdUnverifiedAssets: false },
      _v: CURRENT_VERSION,
    },
  };
}

export function loadPersisted(): SizerFullState | null {
  try {
    if (typeof sessionStorage === 'undefined') return null;
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.ui?._v !== CURRENT_VERSION) {
      // Schema bump: discard + clear so stale blobs don't accumulate.
      try {
        sessionStorage.removeItem(STORAGE_KEY);
      } catch {
        /* ignore */
      }
      // eslint-disable-next-line no-console
      console.info('[sizer] persisted state schema mismatch; starting fresh');
      return null;
    }
    if (!Array.isArray(parsed?.core?.regions)) {
      try {
        sessionStorage.removeItem(STORAGE_KEY);
      } catch {
        /* ignore */
      }
      return null;
    }
    // Drop legacy excalidrawOverrides field if present (removed 2026-04-25).
    if (parsed.ui && 'excalidrawOverrides' in parsed.ui) {
      delete parsed.ui.excalidrawOverrides;
    }
    // Clamp legacy activeStep=5 (Sizer Step 5 retired 2026-04-26 — outer
    // wizard's Results & Export now hosts the report).
    if (parsed.ui && parsed.ui.activeStep === 5) {
      parsed.ui.activeStep = 4;
    }
    return parsed as SizerFullState;
  } catch (err) {
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line no-console
    console.warn('[sizer] failed to hydrate sessionStorage', err);
    return null;
  }
}

// ─── Immutable tree helpers ───────────────────────────────────────────────────

function mapRegions(
  state: SizerFullState,
  fn: (r: Region, idx: number) => Region,
): SizerFullState {
  return { ...state, core: { ...state.core, regions: state.core.regions.map(fn) } };
}

function mapCountryInRegion(r: Region, countryId: string, fn: (c: Country) => Country): Region {
  return {
    ...r,
    countries: r.countries.map((c) => (c.id === countryId ? fn(c) : c)),
  };
}

function mapCityInCountry(c: Country, cityId: string, fn: (ct: City) => City): Country {
  return {
    ...c,
    cities: c.cities.map((ct) => (ct.id === cityId ? fn(ct) : ct)),
  };
}

function findSiteContext(
  state: SizerFullState,
  siteId: string,
): { regionIdx: number; countryIdx: number; cityIdx: number; siteIdx: number } | null {
  for (let r = 0; r < state.core.regions.length; r++) {
    const region = state.core.regions[r];
    for (let co = 0; co < region.countries.length; co++) {
      const country = region.countries[co];
      for (let ci = 0; ci < country.cities.length; ci++) {
        const city = country.cities[ci];
        for (let s = 0; s < city.sites.length; s++) {
          if (city.sites[s].id === siteId) {
            return { regionIdx: r, countryIdx: co, cityIdx: ci, siteIdx: s };
          }
        }
      }
    }
  }
  return null;
}

function updateSite(
  state: SizerFullState,
  siteId: string,
  fn: (s: Site) => Site,
): SizerFullState {
  const ctx = findSiteContext(state, siteId);
  if (!ctx) return state;
  return mapRegions(state, (region, rIdx) => {
    if (rIdx !== ctx.regionIdx) return region;
    return {
      ...region,
      countries: region.countries.map((country, cIdx) => {
        if (cIdx !== ctx.countryIdx) return country;
        return {
          ...country,
          cities: country.cities.map((city, ciIdx) => {
            if (ciIdx !== ctx.cityIdx) return city;
            return {
              ...city,
              sites: city.sites.map((s) => (s.id === siteId ? fn(s) : s)),
            };
          }),
        };
      }),
    };
  });
}

// mapRegions overload supporting idx — inline here to avoid shape churn:
// (TypeScript rejects multiple overload implementations in a simple fn; we
// reimplement above with a manual loop. Keep helper minimal.)
function allSites(state: SizerFullState): Site[] {
  const out: Site[] = [];
  for (const r of state.core.regions) {
    for (const c of r.countries) {
      for (const ct of c.cities) {
        for (const s of ct.sites) out.push(s);
      }
    }
  }
  return out;
}

function defaultSite(): Site {
  return {
    id: newId(),
    name: 'Site 1',
    multiplier: 1,
    users: 500,
  };
}

// Auto-increment site name as "Site N" where N = (total existing sites) + 1.
// User-facing intent: adding the second site labels it "Site 2", third "Site 3", etc.
function nextSiteName(state: SizerFullState): string {
  return `Site ${allSites(state).length + 1}`;
}

// Match Site numbering for Region/Country/City — adding the second Region
// labels it "Region 2", third "Region 3", etc. Counts are global to mirror
// nextSiteName so users get a predictable monotonic sequence regardless of
// where in the tree the new node lands.
function nextRegionName(state: SizerFullState): string {
  return `Region ${state.core.regions.length + 1}`;
}

function nextCountryName(state: SizerFullState): string {
  let total = 0;
  for (const r of state.core.regions) total += r.countries.length;
  return `Country ${total + 1}`;
}

function nextCityName(state: SizerFullState): string {
  let total = 0;
  for (const r of state.core.regions) {
    for (const c of r.countries) total += c.cities.length;
  }
  return `City ${total + 1}`;
}

function defaultRegion(name: string): Region {
  return {
    id: newId(),
    name,
    type: 'on-premises',
    cloudNativeDns: false,
    countries: [],
  };
}

function unassignedCountry(): Country {
  return { id: newId(), name: UNASSIGNED_PLACEHOLDER, cities: [unassignedCity()] };
}

function unassignedCity(): City {
  return { id: newId(), name: UNASSIGNED_PLACEHOLDER, sites: [] };
}

// ─── Reducer ──────────────────────────────────────────────────────────────────

export function sizerReducer(state: SizerFullState, action: SizerAction): SizerFullState {
  switch (action.type) {
    case 'ADD_REGION': {
      // Selection is set atomically with the new region so the detail pane
      // re-renders RegionForm bound to the new id on the very next render.
      // Without this, the auto-select effect in <SizerStepRegions/> runs one
      // tick later, and any UPDATE_REGION dispatched in the same microtask
      // (e.g. controlled-input fill in a test or fast type-ahead) targets the
      // previously selected region and silently overwrites the wrong name.
      const region = defaultRegion(nextRegionName(state));
      return {
        ...state,
        core: {
          ...state.core,
          regions: [...state.core.regions, region],
        },
        ui: {
          ...state.ui,
          selectedPath: `region:${region.id}`,
        },
      };
    }

    case 'UPDATE_REGION':
      return mapRegions(state, (r) =>
        r.id === action.regionId ? { ...r, ...action.patch } : r,
      );

    case 'DELETE_REGION':
      return {
        ...state,
        core: {
          ...state.core,
          regions: state.core.regions.filter((r) => r.id !== action.regionId),
        },
      };

    case 'ADD_COUNTRY': {
      const name = nextCountryName(state);
      return mapRegions(state, (r) =>
        r.id === action.regionId
          ? { ...r, countries: [...r.countries, { id: newId(), name, cities: [] }] }
          : r,
      );
    }

    case 'UPDATE_COUNTRY':
      return mapRegions(state, (r) => ({
        ...r,
        countries: r.countries.map((c) =>
          c.id === action.countryId ? { ...c, ...action.patch } : c,
        ),
      }));

    case 'DELETE_COUNTRY':
      return mapRegions(state, (r) => ({
        ...r,
        countries: r.countries.filter((c) => c.id !== action.countryId),
      }));

    case 'ADD_CITY': {
      const name = nextCityName(state);
      return mapRegions(state, (r) => ({
        ...r,
        countries: r.countries.map((c) =>
          c.id === action.countryId
            ? { ...c, cities: [...c.cities, { id: newId(), name, sites: [] }] }
            : c,
        ),
      }));
    }

    case 'UPDATE_CITY':
      return mapRegions(state, (r) => ({
        ...r,
        countries: r.countries.map((c) => mapCityInCountry(c, action.cityId, (ct) => ({ ...ct, ...action.patch }))),
      }));

    case 'DELETE_CITY':
      return mapRegions(state, (r) => ({
        ...r,
        countries: r.countries.map((c) => ({
          ...c,
          cities: c.cities.filter((ct) => ct.id !== action.cityId),
        })),
      }));

    case 'ADD_SITE': {
      const newSite = { ...defaultSite(), name: nextSiteName(state) };
      if (action.parentCityId) {
        return mapRegions(state, (r) => ({
          ...r,
          countries: r.countries.map((c) => ({
            ...c,
            cities: c.cities.map((ct) =>
              ct.id === action.parentCityId ? { ...ct, sites: [...ct.sites, newSite] } : ct,
            ),
          })),
        }));
      }
      if (action.parentRegionId) {
        // D-09: auto-create (Unassigned) Country + City if Region is empty
        return mapRegions(state, (r) => {
          if (r.id !== action.parentRegionId) return r;
          if (r.countries.length === 0) {
            const country = unassignedCountry();
            country.cities[0].sites = [newSite];
            return { ...r, countries: [country] };
          }
          // Region already has countries — pick first, ensure it has a city
          const [first, ...rest] = r.countries;
          let cities = first.cities;
          if (cities.length === 0) {
            cities = [{ ...unassignedCity(), sites: [newSite] }];
          } else {
            cities = [{ ...cities[0], sites: [...cities[0].sites, newSite] }, ...cities.slice(1)];
          }
          return { ...r, countries: [{ ...first, cities }, ...rest] };
        });
      }
      return state;
    }

    case 'UPDATE_SITE':
      return updateSite(state, action.siteId, (s) => ({ ...s, ...action.patch }));

    case 'DELETE_SITE':
      return mapRegions(state, (r) => ({
        ...r,
        countries: r.countries.map((c) => ({
          ...c,
          cities: c.cities.map((ct) => ({
            ...ct,
            sites: ct.sites.filter((s) => s.id !== action.siteId),
          })),
        })),
      }));

    case 'CLONE_SITE': {
      const ctx = findSiteContext(state, action.siteId);
      if (!ctx) return state;
      const orig = state.core.regions[ctx.regionIdx].countries[ctx.countryIdx].cities[ctx.cityIdx].sites[ctx.siteIdx];
      const count = Math.max(1, Math.min(50, Math.floor(action.count)));
      const clones: Site[] = [];
      const cloneOverrides: Record<string, Partial<Record<keyof DeriveOverrides, true>>> = {};
      for (let i = 0; i < count; i++) {
        const cloneId = newId();
        clones.push({ ...orig, id: cloneId, name: `${orig.name} (${i + 2})` });
        const origOverride = state.ui.siteOverrides[orig.id];
        if (origOverride) cloneOverrides[cloneId] = { ...origOverride };
      }
      let next = mapRegions(state, (r, rIdx) => {
        if (rIdx !== ctx.regionIdx) return r;
        return {
          ...r,
          countries: r.countries.map((c, cIdx) => {
            if (cIdx !== ctx.countryIdx) return c;
            return {
              ...c,
              cities: c.cities.map((ct, ciIdx) => {
                if (ciIdx !== ctx.cityIdx) return ct;
                return { ...ct, sites: [...ct.sites, ...clones] };
              }),
            };
          }),
        };
      });
      next = {
        ...next,
        ui: {
          ...next.ui,
          siteOverrides: { ...next.ui.siteOverrides, ...cloneOverrides },
        },
      };
      return next;
    }

    case 'SITE_DERIVE': {
      // Pitfall 8: skip any field with an override flag set for this site.
      const overrides = state.ui.siteOverrides[action.siteId] ?? {};
      const filtered: Partial<Site> = {};
      for (const [k, v] of Object.entries(action.derived)) {
        if (!(overrides as Record<string, unknown>)[k]) {
          (filtered as Record<string, unknown>)[k] = v;
        }
      }
      return updateSite(state, action.siteId, (s) => ({ ...s, ...filtered }));
    }

    case 'SITE_SET_MODE':
      return {
        ...state,
        ui: { ...state.ui, siteMode: { ...state.ui.siteMode, [action.siteId]: action.mode } },
      };

    case 'SITE_MARK_OVERRIDE':
      return {
        ...state,
        ui: {
          ...state.ui,
          siteOverrides: {
            ...state.ui.siteOverrides,
            [action.siteId]: { ...state.ui.siteOverrides[action.siteId], [action.field]: true },
          },
        },
      };

    case 'SITE_CLEAR_OVERRIDE': {
      const cur = { ...(state.ui.siteOverrides[action.siteId] ?? {}) };
      delete cur[action.field];
      return {
        ...state,
        ui: { ...state.ui, siteOverrides: { ...state.ui.siteOverrides, [action.siteId]: cur } },
      };
    }

    case 'ADD_NIOSX': {
      // Issue #12: members downstream are keyed by name (Map<string,...>,
      // Set dedupe). Default-incrementing the suffix here prevents two new
      // entries colliding into a single planner row before the user renames.
      const existing = state.core.infrastructure.niosx;
      const used = new Set(existing.map((n) => n.name));
      let n = existing.length + 1;
      let name = `New NIOS-X ${n}`;
      while (used.has(name)) {
        n += 1;
        name = `New NIOS-X ${n}`;
      }
      return {
        ...state,
        core: {
          ...state.core,
          infrastructure: {
            ...state.core.infrastructure,
            niosx: [
              ...existing,
              { id: newId(), name, siteId: '', formFactor: 'nios-x', tierName: 'M' },
            ],
          },
        },
      };
    }

    case 'UPDATE_NIOSX':
      return {
        ...state,
        core: {
          ...state.core,
          infrastructure: {
            ...state.core.infrastructure,
            niosx: state.core.infrastructure.niosx.map((n) =>
              n.id === action.id ? { ...n, ...action.patch } : n,
            ),
          },
        },
      };

    case 'DELETE_NIOSX':
      return {
        ...state,
        core: {
          ...state.core,
          infrastructure: {
            ...state.core.infrastructure,
            niosx: state.core.infrastructure.niosx.filter((n) => n.id !== action.id),
          },
        },
      };

    case 'ADD_XAAS':
      return {
        ...state,
        core: {
          ...state.core,
          infrastructure: {
            ...state.core.infrastructure,
            xaas: [
              ...state.core.infrastructure.xaas,
              {
                id: newId(),
                name: 'New Service Point',
                regionId: action.regionId,
                tierName: 'M',
                connections: 0,
                connectedSiteIds: [],
                connectivity: 'vpn',
                popLocation: 'aws-us-east-1',
              },
            ],
          },
        },
      };

    case 'UPDATE_XAAS':
      return {
        ...state,
        core: {
          ...state.core,
          infrastructure: {
            ...state.core.infrastructure,
            xaas: state.core.infrastructure.xaas.map((x) =>
              x.id === action.id ? { ...x, ...action.patch } : x,
            ),
          },
        },
      };

    case 'DELETE_XAAS':
      return {
        ...state,
        core: {
          ...state.core,
          infrastructure: {
            ...state.core.infrastructure,
            xaas: state.core.infrastructure.xaas.filter((x) => x.id !== action.id),
          },
        },
      };

    case 'SET_GROWTH_BUFFER':
      return {
        ...state,
        core: {
          ...state.core,
          globalSettings: { ...state.core.globalSettings, growthBuffer: action.value },
        },
      };

    case 'SET_OVERHEAD': {
      const key = `${action.category}Overhead` as
        | 'mgmtOverhead'
        | 'serverOverhead'
        | 'reportingOverhead'
        | 'securityOverhead';
      return {
        ...state,
        core: {
          ...state.core,
          globalSettings: { ...state.core.globalSettings, [key]: action.value },
        },
      };
    }

    case 'TOGGLE_GROWTH_ADVANCED': {
      const next = !state.ui.growthBufferAdvanced;
      return {
        ...state,
        core: {
          ...state.core,
          globalSettings: { ...state.core.globalSettings, growthBufferAdvanced: next },
        },
        ui: { ...state.ui, growthBufferAdvanced: next },
      };
    }

    case 'SET_MODULE_TOGGLE':
      return {
        ...state,
        core: {
          ...state.core,
          globalSettings: { ...state.core.globalSettings, [action.key]: action.value },
        },
      };

    case 'SET_SECURITY': {
      const autoFilled = { ...state.ui.securityAutoFilled };
      if ('tdVerifiedAssets' in action.patch) autoFilled.tdVerifiedAssets = false;
      if ('tdUnverifiedAssets' in action.patch) autoFilled.tdUnverifiedAssets = false;
      return {
        ...state,
        core: { ...state.core, security: { ...state.core.security, ...action.patch } },
        ui: { ...state.ui, securityAutoFilled: autoFilled },
      };
    }

    case 'SECURITY_RECALC_FROM_SITES': {
      let verified = 0;
      let unverified = 0;
      for (const s of allSites(state)) {
        const mult = s.multiplier ?? 1;
        verified += (s.verifiedAssets ?? 0) * mult;
        unverified += (s.unverifiedAssets ?? 0) * mult;
      }
      return {
        ...state,
        core: {
          ...state.core,
          security: {
            ...state.core.security,
            tdVerifiedAssets: verified,
            tdUnverifiedAssets: unverified,
          },
        },
        ui: {
          ...state.ui,
          securityAutoFilled: { tdVerifiedAssets: true, tdUnverifiedAssets: true },
        },
      };
    }

    case 'SET_ACTIVE_STEP':
      return { ...state, ui: { ...state.ui, activeStep: action.step } };

    case 'SET_SELECTED_PATH':
      return { ...state, ui: { ...state.ui, selectedPath: action.path } };

    case 'TOGGLE_NODE_EXPANDED':
      return {
        ...state,
        ui: {
          ...state.ui,
          expandedNodes: {
            ...state.ui.expandedNodes,
            [action.nodeId]: !state.ui.expandedNodes[action.nodeId],
          },
        },
      };

    case 'TOGGLE_SECTION':
      return {
        ...state,
        ui: {
          ...state.ui,
          sectionsOpen: {
            ...state.ui.sectionsOpen,
            [action.section]: !state.ui.sectionsOpen[action.section],
          },
        },
      };

    case 'DISMISS_ISSUE':
      if (state.ui.dismissedCodes.includes(action.code)) return state;
      return {
        ...state,
        ui: { ...state.ui, dismissedCodes: [...state.ui.dismissedCodes, action.code] },
      };

    case 'UNDISMISS_ISSUE':
      return {
        ...state,
        ui: {
          ...state.ui,
          dismissedCodes: state.ui.dismissedCodes.filter((c) => c !== action.code),
        },
      };

    case 'HYDRATE':
      return action.state;

    case 'RESET':
    case 'RESET_STATE':
      return initialSizerState();

    // Phase 32 — Scan import bridge (D-16): pure delegation to mergeFullState.
    //
    // IMPORTANT (2026-04-28): this action MUST be dispatched against the live
    // reducer for the import bridge to work. Writing the merged tree to
    // sessionStorage is no longer sufficient — since commit c54da81 hoisted
    // <SizerProvider> to the wizard root, the provider does not re-mount on
    // route changes and never re-reads sessionStorage. See
    // wizard.tsx#handleSizerImportConfirm for the dispatch site.
    case 'IMPORT_SCAN':
      return mergeFullState(state, action.payload);

    default: {
      // Exhaustiveness guard.
      const _exhaustive: never = action;
      void _exhaustive;
      return state;
    }
  }
}

// ─── Context + Provider ───────────────────────────────────────────────────────

interface SizerContextValue {
  state: SizerFullState;
  dispatch: Dispatch<SizerAction>;
}

const SizerContext = createContext<SizerContextValue | null>(null);

export function useSizer(): SizerContextValue {
  const ctx = useContext(SizerContext);
  if (!ctx) throw new Error('useSizer must be used inside <SizerProvider>');
  return ctx;
}

/**
 * SizerDispatchBridge — exposes the live SizerProvider `dispatch` via a ref so
 * a parent component (e.g. wizard.tsx, which sits OUTSIDE the provider it
 * mounts) can dispatch actions without using the `useSizer()` hook.
 *
 * Mount this immediately inside <SizerProvider> and pass a ref. The bridge
 * renders nothing; it only writes `dispatch` into the ref on every render so
 * callers always see the current dispatcher.
 *
 * Used by handleSizerImportConfirm to dispatch IMPORT_SCAN against the live
 * provider after commit c54da81 hoisted SizerProvider to the wizard root.
 */
export function SizerDispatchBridge({
  dispatchRef,
}: {
  dispatchRef: { current: Dispatch<SizerAction> | null };
}) {
  const { dispatch } = useSizer();
  dispatchRef.current = dispatch;
  return null;
}

export function SizerProvider({ children }: { children: ReactNode }) {
  // Issue #30: if a parent SizerProvider is already mounted (e.g. wizard.tsx
  // wraps the whole shell in one), nested SizerProvider instances inside
  // <SizerWizard/> and <SizerResultsView/> become pass-throughs. This avoids
  // an unmount→remount race during the credentials→results route flip where
  // the new provider's useReducer init reads sessionStorage *before* the old
  // provider's cleanup effect flushes the latest state, dropping all the
  // user just configured (Region, Site, NIOS-X assignment).
  const parent = useContext(SizerContext);
  if (parent) {
    return createElement(SizerContext.Provider, { value: parent }, children);
  }
  return createElement(RootSizerProvider, null, children);
}

function RootSizerProvider({ children }: { children: ReactNode }) {
  // Pitfall 3: init arg runs exactly once even under StrictMode double-mount.
  const [state, dispatch] = useReducer(
    sizerReducer,
    undefined,
    () => loadPersisted() ?? initialSizerState(),
  );

  // Debounced persist (300ms). Latest state held in ref so unmount-flush
  // and pagehide-flush always see the most recent value without re-binding
  // listeners on every dispatch.
  const stateRef = useRef(state);
  stateRef.current = state;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(stateRef.current));
      } catch (err) {
        // Best-effort; QuotaExceededError etc. are swallowed.
        // eslint-disable-next-line no-console
        console.warn('[sizer] failed to persist', err);
      }
      timerRef.current = null;
    }, 300);
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [state]);

  // Issue #4: flush on unmount so a route handoff (e.g. wizard → results view)
  // that swaps the SizerProvider tree before the 300ms debounce fires does not
  // drop the freshly-entered state. The next provider hydrates from
  // sessionStorage in its useReducer init, so the write must complete before
  // unmount tears this provider down.
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(stateRef.current));
      } catch {
        /* ignore */
      }
    };
  }, []);

  // Pitfall 2: flush on pagehide so tab-switch/close preserves unsaved edits.
  useEffect(() => {
    const flush = () => {
      try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(stateRef.current));
      } catch {
        /* ignore */
      }
    };
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, []);

  return createElement(SizerContext.Provider, { value: { state, dispatch } }, children);
}
