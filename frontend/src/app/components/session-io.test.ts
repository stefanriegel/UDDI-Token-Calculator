import { describe, it, expect } from 'vitest';
import {
  exportSession,
  importSession,
  validateSessionSchema,
  SESSION_FORMAT_VERSION,
  type SessionExportInput,
  type SessionSnapshot,
} from './session-io';
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

// ---------------------------------------------------------------------------
// validateSessionSchema
// ---------------------------------------------------------------------------

describe('validateSessionSchema', () => {
  // Helper: build a valid snapshot object from exportSession output.
  const validSnapshot = (): SessionSnapshot =>
    JSON.parse(exportSession({ ...baseInput }, '1.0.0')) as SessionSnapshot;

  it('returns { valid: true } for a well-formed snapshot', () => {
    const result = validateSessionSchema(validSnapshot());
    expect(result).toEqual({ valid: true });
  });

  it('returns { valid: false } with "Not a valid session file." for null', () => {
    const result = validateSessionSchema(null);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Not a valid session file.');
  });

  it('returns { valid: false } with "Not a valid session file." for an array', () => {
    const result = validateSessionSchema([1, 2, 3]);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Not a valid session file.');
  });

  it('returns { valid: false } with missing-version error when version field is absent', () => {
    const snapshot = validSnapshot();
    const { version: _removed, ...withoutVersion } = snapshot;
    const result = validateSessionSchema(withoutVersion);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Session file is missing a version field.');
  });

  it('returns { valid: false } with incompatibility message for a wrong version number', () => {
    const snapshot = { ...validSnapshot(), version: SESSION_FORMAT_VERSION + 1 };
    const result = validateSessionSchema(snapshot);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Incompatible session version');
  });

  it('returns { valid: false } with missing-findings error when findings is not an array', () => {
    const snapshot = { ...validSnapshot(), findings: 'oops' };
    const result = validateSessionSchema(snapshot);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Session file is missing findings data.');
  });

  it('returns { valid: false } with missing-providers error when selectedProviders is not an array', () => {
    const snapshot = { ...validSnapshot(), selectedProviders: null };
    const result = validateSessionSchema(snapshot);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Session file is missing provider list.');
  });

  it('returns { valid: false } with missing-estimator error when estimatorAnswers is not an object', () => {
    const snapshot = { ...validSnapshot(), estimatorAnswers: 'bad' };
    const result = validateSessionSchema(snapshot);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Session file is missing estimator configuration.');
  });
});

// ---------------------------------------------------------------------------
// importSession
// ---------------------------------------------------------------------------

describe('importSession', () => {
  // Node 20+ ships File globally; no jsdom needed.
  const makeFile = (content: string) =>
    new File([content], 'test.json', { type: 'application/json' });

  it('resolves with a valid SessionSnapshot for a round-tripped exportSession output', async () => {
    const jsonString = exportSession({ ...baseInput }, '1.0.0');
    const file = makeFile(jsonString);
    const result = await importSession(file);
    expect(result.version).toBe(SESSION_FORMAT_VERSION);
    expect(Array.isArray(result.findings)).toBe(true);
    expect(Array.isArray(result.selectedProviders)).toBe(true);
  });

  it('rejects with "File is not valid JSON." for non-JSON content', async () => {
    const file = makeFile('this is not JSON {{ broken');
    await expect(importSession(file)).rejects.toThrow('File is not valid JSON.');
  });
});
