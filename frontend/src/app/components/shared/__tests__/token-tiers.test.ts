import { describe, it, expect } from 'vitest';

import {
  SERVER_TOKEN_TIERS,
  pickServerTier,
} from '../token-tiers';

describe('pickServerTier', () => {
  it('returns the smallest 2XS tier for tiny load', () => {
    expect(pickServerTier(100, 1, 100).name).toBe('2XS');
  });

  it('bumps to XS when QPS exceeds 2XS maxQps (5,000)', () => {
    expect(pickServerTier(5_001, 1, 100).name).toBe('XS');
  });

  it('bumps to S when LPS exceeds XS maxLps (150)', () => {
    expect(pickServerTier(8_000, 151, 100).name).toBe('S');
  });

  it('bumps to M when objects exceed S maxObjects (29,000)', () => {
    expect(pickServerTier(8_000, 100, 30_000).name).toBe('M');
  });

  it('bumps to L when QPS exceeds M maxQps (40,000)', () => {
    expect(pickServerTier(50_000, 200, 50_000).name).toBe('L');
  });

  it('bumps to XL when LPS exceeds L maxLps (400)', () => {
    expect(pickServerTier(60_000, 500, 50_000).name).toBe('XL');
  });

  it('returns the largest tier (XL) when load exceeds every option', () => {
    expect(pickServerTier(999_999, 9_999, 9_999_999).name).toBe('XL');
  });

  it('respects the strictest of the three dimensions', () => {
    // qps fits 2XS, lps fits 2XS, objects (200_000) fits L (440_000) but
    // exceeds M (110_000) — must bump to L.
    expect(pickServerTier(100, 1, 200_000).name).toBe('L');
  });

  it('handles all-zero load with the smallest tier', () => {
    expect(pickServerTier(0, 0, 0).name).toBe('2XS');
  });

  it('accepts a custom tier table override', () => {
    const customTable = SERVER_TOKEN_TIERS.slice(2); // [S, M, L, XL] only
    expect(pickServerTier(100, 1, 100, customTable).name).toBe('S');
  });
});
