import { describe, it, expect } from 'vitest';
import { exportSession, SESSION_FORMAT_VERSION, type SessionExportInput } from './session-io';
import { EstimatorDefaults } from './estimator-calc';

// Minimal base input shared across tests.
const baseInput: SessionExportInput = {
  selectedProviders: [],
  findings: [],
  countOverrides: {},
  niosMigrationMap: new Map(),
  adMigrationMap: new Map(),
  niosServerMetrics: [],
  adServerMetrics: [],
  estimatorAnswers: { ...EstimatorDefaults },
  growthBufferPct: 0.2,
  reportingDestEnabled: {},
  reportingDestEvents: {},
};

describe('exportSession', () => {
  it('returns a string that parses as valid JSON', () => {
    const result = exportSession({ ...baseInput }, '1.0.0');
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it('parsed output has version === SESSION_FORMAT_VERSION', () => {
    const result = exportSession({ ...baseInput }, '1.0.0');
    const parsed = JSON.parse(result);
    expect(parsed.version).toBe(SESSION_FORMAT_VERSION);
  });

  it('niosMigrationMap serializes as a plain object with the correct value', () => {
    const map = new Map<string, 'nios-x' | 'nios-xaas'>();
    map.set('server-01', 'nios-x');
    const result = exportSession({ ...baseInput, niosMigrationMap: map }, '1.0.0');
    const parsed = JSON.parse(result);
    expect(typeof parsed.niosMigrationMap).toBe('object');
    expect(parsed.niosMigrationMap['server-01']).toBe('nios-x');
  });

  it('exportedAt is a non-empty ISO string that constructs a valid Date', () => {
    const result = exportSession({ ...baseInput }, '1.0.0');
    const parsed = JSON.parse(result);
    expect(typeof parsed.exportedAt).toBe('string');
    expect(parsed.exportedAt.length).toBeGreaterThan(0);
    expect(() => new Date(parsed.exportedAt)).not.toThrow();
    expect(new Date(parsed.exportedAt).toString()).not.toBe('Invalid Date');
  });

  it('toolVersion field equals the value passed in', () => {
    const result = exportSession({ ...baseInput }, 'v2.5.0');
    const parsed = JSON.parse(result);
    expect(parsed.toolVersion).toBe('v2.5.0');
  });

  it('empty state (empty arrays, empty Maps, empty objects) serializes without throwing', () => {
    expect(() => {
      const result = exportSession({ ...baseInput }, 'dev');
      JSON.parse(result);
    }).not.toThrow();
  });
});
