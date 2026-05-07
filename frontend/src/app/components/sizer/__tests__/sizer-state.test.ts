/**
 * sizer-state.test.ts — Reducer + Context + sessionStorage harness tests (D-30).
 *
 * Covers:
 *   - every SizerAction at least once
 *   - ADD_SITE under a Region auto-creates (Unassigned) Country + City (D-09)
 *   - CLONE_SITE produces named clones (D-15)
 *   - SITE_DERIVE respects per-field override flags (Pitfall 8)
 *   - SECURITY_RECALC_FROM_SITES sums from current state (D-20, plan-check W-3)
 *   - sessionStorage hydrate: bad JSON / version mismatch / bad shape → fallback
 *   - useSizer() outside provider throws
 *   - SizerProvider hydration runs once under StrictMode (Pitfall 3)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, render } from '@testing-library/react';
import { StrictMode, createElement, useEffect } from 'react';
import {
  sizerReducer,
  initialSizerState,
  SizerProvider,
  useSizer,
  STORAGE_KEY,
  type SizerFullState,
  type SizerAction,
} from '../sizer-state';
import { UNASSIGNED_PLACEHOLDER } from '../sizer-types';
import { importFromScan, mergeFullState } from '../sizer-import';
import {
  awsFindings,
  azureFindings,
  gcpFindings,
  adFindings,
  niosMetrics,
  adMetrics,
  mixedFindings,
} from './fixtures/scan-import';

function seedRegion(state: SizerFullState = initialSizerState()): {
  state: SizerFullState;
  regionId: string;
} {
  const next = sizerReducer(state, { type: 'ADD_REGION' });
  return { state: next, regionId: next.core.regions[0].id };
}

function seedSite(): { state: SizerFullState; regionId: string; siteId: string } {
  const { state: s1, regionId } = seedRegion();
  const s2 = sizerReducer(s1, { type: 'ADD_SITE', parentRegionId: regionId });
  const siteId = s2.core.regions[0].countries[0].cities[0].sites[0].id;
  return { state: s2, regionId, siteId };
}

describe('sizerReducer — hierarchy', () => {
  it('ADD_REGION appends a region with UUID, on-premises default, empty countries', () => {
    const next = sizerReducer(initialSizerState(), { type: 'ADD_REGION' });
    expect(next.core.regions).toHaveLength(1);
    expect(next.core.regions[0].type).toBe('on-premises');
    expect(next.core.regions[0].cloudNativeDns).toBe(false);
    expect(next.core.regions[0].countries).toEqual([]);
    expect(next.core.regions[0].id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('ADD_REGION atomically selects the new region (issue #17)', () => {
    const s1 = sizerReducer(initialSizerState(), { type: 'ADD_REGION' });
    expect(s1.ui.selectedPath).toBe(`region:${s1.core.regions[0].id}`);
    const s2 = sizerReducer(s1, { type: 'ADD_REGION' });
    expect(s2.core.regions).toHaveLength(2);
    expect(s2.ui.selectedPath).toBe(`region:${s2.core.regions[1].id}`);
  });

  it('UPDATE_REGION applies patch immutably', () => {
    const { state, regionId } = seedRegion();
    const next = sizerReducer(state, {
      type: 'UPDATE_REGION',
      regionId,
      patch: { name: 'EU', type: 'aws', cloudNativeDns: true },
    });
    expect(next.core.regions[0].name).toBe('EU');
    expect(next.core.regions[0].type).toBe('aws');
    expect(next.core.regions[0].cloudNativeDns).toBe(true);
    expect(next).not.toBe(state);
    expect(next.core.regions[0]).not.toBe(state.core.regions[0]);
  });

  it('DELETE_REGION removes region', () => {
    const { state, regionId } = seedRegion();
    const next = sizerReducer(state, { type: 'DELETE_REGION', regionId });
    expect(next.core.regions).toHaveLength(0);
  });

  it('ADD_COUNTRY / UPDATE_COUNTRY / DELETE_COUNTRY', () => {
    const { state, regionId } = seedRegion();
    const s2 = sizerReducer(state, { type: 'ADD_COUNTRY', regionId });
    expect(s2.core.regions[0].countries).toHaveLength(1);
    const countryId = s2.core.regions[0].countries[0].id;
    const s3 = sizerReducer(s2, { type: 'UPDATE_COUNTRY', countryId, patch: { name: 'Germany' } });
    expect(s3.core.regions[0].countries[0].name).toBe('Germany');
    const s4 = sizerReducer(s3, { type: 'DELETE_COUNTRY', countryId });
    expect(s4.core.regions[0].countries).toHaveLength(0);
  });

  it('ADD_CITY / UPDATE_CITY / DELETE_CITY', () => {
    const { state, regionId } = seedRegion();
    const s2 = sizerReducer(state, { type: 'ADD_COUNTRY', regionId });
    const countryId = s2.core.regions[0].countries[0].id;
    const s3 = sizerReducer(s2, { type: 'ADD_CITY', countryId });
    expect(s3.core.regions[0].countries[0].cities).toHaveLength(1);
    const cityId = s3.core.regions[0].countries[0].cities[0].id;
    const s4 = sizerReducer(s3, { type: 'UPDATE_CITY', cityId, patch: { name: 'Berlin' } });
    expect(s4.core.regions[0].countries[0].cities[0].name).toBe('Berlin');
    const s5 = sizerReducer(s4, { type: 'DELETE_CITY', cityId });
    expect(s5.core.regions[0].countries[0].cities).toHaveLength(0);
  });
});

describe('sizerReducer — sites', () => {
  it('ADD_SITE under a Region auto-creates (Unassigned) Country + City (D-09)', () => {
    const { state, regionId } = seedRegion();
    const next = sizerReducer(state, { type: 'ADD_SITE', parentRegionId: regionId });
    expect(next.core.regions[0].countries).toHaveLength(1);
    expect(next.core.regions[0].countries[0].name).toBe(UNASSIGNED_PLACEHOLDER);
    expect(next.core.regions[0].countries[0].cities).toHaveLength(1);
    expect(next.core.regions[0].countries[0].cities[0].name).toBe(UNASSIGNED_PLACEHOLDER);
    expect(next.core.regions[0].countries[0].cities[0].sites).toHaveLength(1);
    const site = next.core.regions[0].countries[0].cities[0].sites[0];
    expect(site.users).toBe(500);
    expect(site.multiplier).toBe(1);
  });

  it('ADD_SITE with parentCityId appends directly', () => {
    const { state, regionId } = seedRegion();
    const s2 = sizerReducer(state, { type: 'ADD_COUNTRY', regionId });
    const countryId = s2.core.regions[0].countries[0].id;
    const s3 = sizerReducer(s2, { type: 'ADD_CITY', countryId });
    const cityId = s3.core.regions[0].countries[0].cities[0].id;
    const s4 = sizerReducer(s3, { type: 'ADD_SITE', parentCityId: cityId });
    expect(s4.core.regions[0].countries[0].cities[0].sites).toHaveLength(1);
  });

  it('ADD_SITE auto-increments name as "Site 1", "Site 2", "Site 3"', () => {
    const { state: s0, regionId } = seedRegion();
    const s1 = sizerReducer(s0, { type: 'ADD_SITE', parentRegionId: regionId });
    const s2 = sizerReducer(s1, { type: 'ADD_SITE', parentRegionId: regionId });
    const s3 = sizerReducer(s2, { type: 'ADD_SITE', parentRegionId: regionId });
    const sites = s3.core.regions[0].countries[0].cities[0].sites;
    expect(sites.map((x) => x.name)).toEqual(['Site 1', 'Site 2', 'Site 3']);
  });

  it('ADD_SITE numbers by total site count, even when prior sites were renamed', () => {
    const { state: s0, regionId } = seedRegion();
    const s1 = sizerReducer(s0, { type: 'ADD_SITE', parentRegionId: regionId });
    const siteId = s1.core.regions[0].countries[0].cities[0].sites[0].id;
    const s2 = sizerReducer(s1, { type: 'UPDATE_SITE', siteId, patch: { name: 'HQ' } });
    const s3 = sizerReducer(s2, { type: 'ADD_SITE', parentRegionId: regionId });
    const names = s3.core.regions[0].countries[0].cities[0].sites.map((x) => x.name);
    expect(names).toEqual(['HQ', 'Site 2']);
  });

  it('UPDATE_SITE + DELETE_SITE', () => {
    const { state, siteId } = seedSite();
    const s2 = sizerReducer(state, { type: 'UPDATE_SITE', siteId, patch: { name: 'HQ', users: 1500 } });
    expect(s2.core.regions[0].countries[0].cities[0].sites[0].name).toBe('HQ');
    expect(s2.core.regions[0].countries[0].cities[0].sites[0].users).toBe(1500);
    const s3 = sizerReducer(s2, { type: 'DELETE_SITE', siteId });
    expect(s3.core.regions[0].countries[0].cities[0].sites).toHaveLength(0);
  });

  it('CLONE_SITE(id, 3) creates 3 clones named "(2)", "(3)", "(4)"', () => {
    const { state, siteId } = seedSite();
    const s2 = sizerReducer(state, { type: 'UPDATE_SITE', siteId, patch: { name: 'Alpha' } });
    const s3 = sizerReducer(s2, { type: 'CLONE_SITE', siteId, count: 3 });
    const sites = s3.core.regions[0].countries[0].cities[0].sites;
    expect(sites).toHaveLength(4);
    expect(sites[0].name).toBe('Alpha');
    expect(sites[1].name).toBe('Alpha (2)');
    expect(sites[2].name).toBe('Alpha (3)');
    expect(sites[3].name).toBe('Alpha (4)');
    // Clones have distinct IDs
    const ids = new Set(sites.map((s) => s.id));
    expect(ids.size).toBe(4);
  });

  it('CLONE_SITE inherits override flags (D-15)', () => {
    const { state, siteId } = seedSite();
    const s2 = sizerReducer(state, { type: 'SITE_MARK_OVERRIDE', siteId, field: 'qps' });
    const s3 = sizerReducer(s2, { type: 'CLONE_SITE', siteId, count: 1 });
    const sites = s3.core.regions[0].countries[0].cities[0].sites;
    const cloneId = sites[1].id;
    expect(s3.ui.siteOverrides[cloneId]?.qps).toBe(true);
  });

  it('SITE_DERIVE writes derived fields onto the Site', () => {
    const { state, siteId } = seedSite();
    const next = sizerReducer(state, {
      type: 'SITE_DERIVE',
      siteId,
      derived: { qps: 4800, activeIPs: 2250, lps: 10 },
    });
    const site = next.core.regions[0].countries[0].cities[0].sites[0];
    expect(site.qps).toBe(4800);
    expect(site.activeIPs).toBe(2250);
    expect(site.lps).toBe(10);
  });

  it('SITE_DERIVE does NOT overwrite fields flagged as overridden (Pitfall 8)', () => {
    const { state, siteId } = seedSite();
    const s1 = sizerReducer(state, { type: 'UPDATE_SITE', siteId, patch: { qps: 9999 } });
    const s2 = sizerReducer(s1, { type: 'SITE_MARK_OVERRIDE', siteId, field: 'qps' });
    const s3 = sizerReducer(s2, {
      type: 'SITE_DERIVE',
      siteId,
      derived: { qps: 4800, activeIPs: 2250 },
    });
    const site = s3.core.regions[0].countries[0].cities[0].sites[0];
    expect(site.qps).toBe(9999); // override preserved
    expect(site.activeIPs).toBe(2250); // non-overridden applied
  });

  it('SITE_SET_MODE / SITE_MARK_OVERRIDE / SITE_CLEAR_OVERRIDE', () => {
    const { state, siteId } = seedSite();
    const s1 = sizerReducer(state, { type: 'SITE_SET_MODE', siteId, mode: 'manual' });
    expect(s1.ui.siteMode[siteId]).toBe('manual');
    const s2 = sizerReducer(s1, { type: 'SITE_MARK_OVERRIDE', siteId, field: 'qps' });
    expect(s2.ui.siteOverrides[siteId]?.qps).toBe(true);
    const s3 = sizerReducer(s2, { type: 'SITE_CLEAR_OVERRIDE', siteId, field: 'qps' });
    expect(s3.ui.siteOverrides[siteId]?.qps).toBeUndefined();
  });
});

describe('sizerReducer — infrastructure', () => {
  it('ADD_NIOSX / UPDATE_NIOSX / DELETE_NIOSX', () => {
    const { state, siteId } = seedSite();
    const s1 = sizerReducer(state, { type: 'ADD_NIOSX' });
    expect(s1.core.infrastructure.niosx).toHaveLength(1);
    const id = s1.core.infrastructure.niosx[0].id;
    const s2 = sizerReducer(s1, {
      type: 'UPDATE_NIOSX',
      id,
      patch: { name: 'ns1', siteId, tierName: 'M' },
    });
    expect(s2.core.infrastructure.niosx[0].name).toBe('ns1');
    expect(s2.core.infrastructure.niosx[0].siteId).toBe(siteId);
    const s3 = sizerReducer(s2, { type: 'DELETE_NIOSX', id });
    expect(s3.core.infrastructure.niosx).toHaveLength(0);
  });

  it('ADD_XAAS(regionId) / UPDATE_XAAS / DELETE_XAAS', () => {
    const { state, regionId } = seedRegion();
    const s1 = sizerReducer(state, { type: 'ADD_XAAS', regionId });
    expect(s1.core.infrastructure.xaas).toHaveLength(1);
    expect(s1.core.infrastructure.xaas[0].regionId).toBe(regionId);
    const id = s1.core.infrastructure.xaas[0].id;
    const s2 = sizerReducer(s1, { type: 'UPDATE_XAAS', id, patch: { connections: 75, tierName: 'M' } });
    expect(s2.core.infrastructure.xaas[0].connections).toBe(75);
    const s3 = sizerReducer(s2, { type: 'DELETE_XAAS', id });
    expect(s3.core.infrastructure.xaas).toHaveLength(0);
  });
});

describe('sizerReducer — settings', () => {
  it('SET_GROWTH_BUFFER / SET_OVERHEAD / TOGGLE_GROWTH_ADVANCED', () => {
    const s1 = sizerReducer(initialSizerState(), { type: 'SET_GROWTH_BUFFER', value: 0.3 });
    expect(s1.core.globalSettings.growthBuffer).toBe(0.3);
    const s2 = sizerReducer(s1, { type: 'SET_OVERHEAD', category: 'mgmt', value: 0.25 });
    expect(s2.core.globalSettings.mgmtOverhead).toBe(0.25);
    const s3 = sizerReducer(s2, { type: 'SET_OVERHEAD', category: 'server', value: undefined });
    expect(s3.core.globalSettings.serverOverhead).toBeUndefined();
    const s4 = sizerReducer(s3, { type: 'TOGGLE_GROWTH_ADVANCED' });
    expect(s4.ui.growthBufferAdvanced).toBe(!s3.ui.growthBufferAdvanced);
    expect(s4.core.globalSettings.growthBufferAdvanced).toBe(!s3.core.globalSettings.growthBufferAdvanced);
  });

  it('SET_MODULE_TOGGLE writes to globalSettings', () => {
    const next = sizerReducer(initialSizerState(), {
      type: 'SET_MODULE_TOGGLE',
      key: 'dnsLoggingEnabled',
      value: true,
    });
    expect(next.core.globalSettings.dnsLoggingEnabled).toBe(true);
  });

  it('SET_SECURITY merges patch and clears auto-filled flags on manual edit', () => {
    const s0 = {
      ...initialSizerState(),
      ui: {
        ...initialSizerState().ui,
        securityAutoFilled: { tdVerifiedAssets: true, tdUnverifiedAssets: true },
      },
    };
    const s1 = sizerReducer(s0, { type: 'SET_SECURITY', patch: { tdVerifiedAssets: 42 } });
    expect(s1.core.security.tdVerifiedAssets).toBe(42);
    expect(s1.ui.securityAutoFilled.tdVerifiedAssets).toBe(false);
    expect(s1.ui.securityAutoFilled.tdUnverifiedAssets).toBe(true);
  });

  it('SECURITY_RECALC_FROM_SITES sums verified/unverified from sites (D-20 / W-3)', () => {
    const { state, siteId } = seedSite();
    const s1 = sizerReducer(state, {
      type: 'UPDATE_SITE',
      siteId,
      patch: { verifiedAssets: 100, unverifiedAssets: 400 },
    });
    // Clone so we have two sites summing up
    const s2 = sizerReducer(s1, { type: 'CLONE_SITE', siteId, count: 1 });
    const cloneId = s2.core.regions[0].countries[0].cities[0].sites[1].id;
    const s3 = sizerReducer(s2, {
      type: 'UPDATE_SITE',
      siteId: cloneId,
      patch: { verifiedAssets: 50, unverifiedAssets: 150 },
    });
    const s4 = sizerReducer(s3, { type: 'SECURITY_RECALC_FROM_SITES' });
    expect(s4.core.security.tdVerifiedAssets).toBe(150);
    expect(s4.core.security.tdUnverifiedAssets).toBe(550);
    expect(s4.ui.securityAutoFilled.tdVerifiedAssets).toBe(true);
    expect(s4.ui.securityAutoFilled.tdUnverifiedAssets).toBe(true);
  });
});

describe('sizerReducer — UI-only', () => {
  it('SET_ACTIVE_STEP / SET_SELECTED_PATH', () => {
    const s1 = sizerReducer(initialSizerState(), { type: 'SET_ACTIVE_STEP', step: 3 });
    expect(s1.ui.activeStep).toBe(3);
    const s2 = sizerReducer(s1, { type: 'SET_SELECTED_PATH', path: 'regions[0]' });
    expect(s2.ui.selectedPath).toBe('regions[0]');
  });

  it('TOGGLE_NODE_EXPANDED flips boolean', () => {
    const s1 = sizerReducer(initialSizerState(), { type: 'TOGGLE_NODE_EXPANDED', nodeId: 'abc' });
    expect(s1.ui.expandedNodes.abc).toBe(true);
    const s2 = sizerReducer(s1, { type: 'TOGGLE_NODE_EXPANDED', nodeId: 'abc' });
    expect(s2.ui.expandedNodes.abc).toBe(false);
  });

  it('TOGGLE_SECTION flips sections', () => {
    const init = initialSizerState();
    const s1 = sizerReducer(init, { type: 'TOGGLE_SECTION', section: 'security' });
    expect(s1.ui.sectionsOpen.security).toBe(!init.ui.sectionsOpen.security);
  });

  it('DISMISS_ISSUE / UNDISMISS_ISSUE', () => {
    const s1 = sizerReducer(initialSizerState(), { type: 'DISMISS_ISSUE', code: 'XAAS_OVER' });
    expect(s1.ui.dismissedCodes).toContain('XAAS_OVER');
    // Idempotent
    const s2 = sizerReducer(s1, { type: 'DISMISS_ISSUE', code: 'XAAS_OVER' });
    expect(s2.ui.dismissedCodes.filter((c) => c === 'XAAS_OVER')).toHaveLength(1);
    const s3 = sizerReducer(s2, { type: 'UNDISMISS_ISSUE', code: 'XAAS_OVER' });
    expect(s3.ui.dismissedCodes).not.toContain('XAAS_OVER');
  });

  it('HYDRATE replaces state', () => {
    const { state } = seedSite();
    const next = sizerReducer(initialSizerState(), { type: 'HYDRATE', state });
    expect(next).toBe(state);
  });

  it('RESET returns initialSizerState()', () => {
    const { state } = seedSite();
    const next = sizerReducer(state, { type: 'RESET' });
    expect(next.core.regions).toHaveLength(0);
    expect(next.ui.activeStep).toBe(1);
  });
});

describe('RESET_STATE', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('CURRENT_VERSION is still 1', () => {
    expect(initialSizerState().ui._v).toBe(1);
  });

  it('RESET_STATE returns initialSizerState() (deep equal)', () => {
    const { state } = seedSite();
    const next = sizerReducer(state, { type: 'RESET_STATE' });
    expect(next).toEqual(initialSizerState());
  });

  it('existing RESET action still works (alias for RESET_STATE)', () => {
    const { state } = seedSite();
    const next = sizerReducer(state, { type: 'RESET' });
    expect(next).toEqual(initialSizerState());
  });

  it('loadPersisted strips legacy ui.excalidrawOverrides from old blobs', () => {
    const legacy = initialSizerState();
    const legacyBlob = JSON.parse(JSON.stringify(legacy));
    legacyBlob.ui.excalidrawOverrides = { 'site-abc': { x: 1, y: 2 } };
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(legacyBlob));
    const { result } = renderHook(() => useSizer(), { wrapper: SizerProvider });
    expect('excalidrawOverrides' in result.current.state.ui).toBe(false);
  });
});

describe('sessionStorage hydration', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it('bad JSON → returns initial state without throwing', async () => {
    sessionStorage.setItem(STORAGE_KEY, '{not json');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = renderHook(() => useSizer(), { wrapper: SizerProvider });
    expect(result.current.state.core.regions).toHaveLength(0);
    expect(result.current.state.ui._v).toBe(1);
  });

  it('version mismatch (_v !== 1) → fallback to initial state', () => {
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ core: { regions: [] }, ui: { _v: 0 } }),
    );
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { result } = renderHook(() => useSizer(), { wrapper: SizerProvider });
    expect(result.current.state.ui._v).toBe(1);
    expect(result.current.state.core.regions).toHaveLength(0);
  });

  it('invalid shape (core.regions not an array) → fallback', () => {
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ core: { regions: 'nope' }, ui: { _v: 1 } }),
    );
    const { result } = renderHook(() => useSizer(), { wrapper: SizerProvider });
    expect(result.current.state.core.regions).toHaveLength(0);
  });

  it('valid blob → hydrates', () => {
    const { state } = seedSite();
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    const { result } = renderHook(() => useSizer(), { wrapper: SizerProvider });
    expect(result.current.state.core.regions).toHaveLength(1);
    expect(result.current.state.core.regions[0].countries[0].cities[0].sites).toHaveLength(1);
  });

  it('hydrates correctly under StrictMode double-mount (Pitfall 3)', () => {
    // StrictMode double-invokes the reducer init arg; what matters is that the
    // hydrated state is idempotent & identical — no side effects leak.
    const { state } = seedSite();
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    const { result } = renderHook(() => useSizer(), {
      wrapper: ({ children }) =>
        createElement(StrictMode, null, createElement(SizerProvider, null, children)),
    });
    expect(result.current.state.core.regions).toHaveLength(1);
    expect(result.current.state.core.regions[0].countries[0].cities[0].sites).toHaveLength(1);
  });
});

describe('SizerProvider — persistence', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounced persist writes after 300ms of idle', () => {
    const { result } = renderHook(() => useSizer(), { wrapper: SizerProvider });
    act(() => {
      result.current.dispatch({ type: 'ADD_REGION' });
    });
    // Before debounce window
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    act(() => {
      vi.advanceTimersByTime(300);
    });
    const raw = sessionStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.core.regions).toHaveLength(1);
    expect(parsed.ui._v).toBe(1);
  });
});

describe('useSizer outside provider', () => {
  it('throws helpful error', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => renderHook(() => useSizer())).toThrow(/SizerProvider/);
  });
});

describe('unmount flushes pending state (issue #4)', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('SizerProvider unmount flushes state synchronously even when 300ms debounce has not fired', () => {
    const { result, unmount } = renderHook(() => useSizer(), { wrapper: SizerProvider });
    act(() => {
      result.current.dispatch({ type: 'ADD_REGION' });
    });
    // Simulate fast wizard→results handoff: provider unmounts before debounce window.
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    unmount();
    const raw = sessionStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!).core.regions).toHaveLength(1);
  });
});

describe('pagehide flushes state (Pitfall 2)', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('fires pagehide → syncs to sessionStorage immediately', () => {
    const { result } = renderHook(() => useSizer(), { wrapper: SizerProvider });
    act(() => {
      result.current.dispatch({ type: 'ADD_REGION' });
    });
    // Dispatch pagehide synchronously — should flush without debounce
    window.dispatchEvent(new Event('pagehide'));
    const raw = sessionStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!).core.regions).toHaveLength(1);
  });
});

// ─── Phase 32: IMPORT_SCAN reducer action (D-16, D-17) ───────────────────────

describe('IMPORT_SCAN', () => {
  it('dispatching IMPORT_SCAN against a baseline equals mergeFullState(state, payload)', () => {
    const baseline = initialSizerState();
    const incoming = importFromScan(mixedFindings, niosMetrics, adMetrics);

    const viaReducer = sizerReducer(baseline, { type: 'IMPORT_SCAN', payload: incoming });
    const viaMerge = mergeFullState(baseline, incoming);

    // Same shape — reducer is a one-line delegation per D-16
    expect(viaReducer).toEqual(viaMerge);
    // Tree fields populated from incoming
    expect(viaReducer.core.regions.length).toBe(incoming.core.regions.length);
    expect(viaReducer.core.infrastructure.niosx.length).toBe(
      incoming.core.infrastructure.niosx.length,
    );
    // ui slice referentially preserved (D-13)
    expect(viaReducer.ui).toBe(baseline.ui);
    expect(viaReducer.core.globalSettings).toBe(baseline.core.globalSettings);
    expect(viaReducer.core.security).toBe(baseline.core.security);
  });

  it('is idempotent — dispatching IMPORT_SCAN twice with the same payload equals one dispatch (D-14)', () => {
    const baseline = initialSizerState();
    const incoming = importFromScan(
      [...awsFindings, ...azureFindings, ...gcpFindings, ...adFindings],
      niosMetrics,
      adMetrics,
    );

    const once = sizerReducer(baseline, { type: 'IMPORT_SCAN', payload: incoming });
    const twice = sizerReducer(once, { type: 'IMPORT_SCAN', payload: incoming });

    expect(twice).toEqual(once);
    expect(twice.core.regions.length).toBe(once.core.regions.length);
    expect(twice.core.infrastructure.niosx.length).toBe(once.core.infrastructure.niosx.length);
  });

  it('IMPORT_SCAN with an empty incoming (initialSizerState) leaves the existing tree structurally unchanged', () => {
    // Build a non-empty baseline first
    const seeded1 = sizerReducer(initialSizerState(), { type: 'ADD_REGION' });
    const regionId = seeded1.core.regions[0].id;
    const seeded2 = sizerReducer(seeded1, { type: 'ADD_SITE', parentRegionId: regionId });

    const empty = initialSizerState();
    const merged = sizerReducer(seeded2, { type: 'IMPORT_SCAN', payload: empty });

    // Tree fields are equal in shape — additive merge over empty is a no-op
    expect(merged.core.regions).toEqual(seeded2.core.regions);
    expect(merged.core.infrastructure.niosx).toEqual(seeded2.core.infrastructure.niosx);
    // Untouched slices preserved referentially
    expect(merged.ui).toBe(seeded2.ui);
    expect(merged.core.globalSettings).toBe(seeded2.core.globalSettings);
    expect(merged.core.security).toBe(seeded2.core.security);
  });
});
