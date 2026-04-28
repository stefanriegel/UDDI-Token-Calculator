// session-io.ts -- Session export serialization
// Zero React/DOM imports; pure TypeScript so this module is testable with vitest without jsdom.

import type { ProviderType, FindingRow, NiosServerMetrics, ServerFormFactor } from './mock-data';
import type { EstimatorInputs } from './estimator-calc';
import type { ADServerMetricAPI } from './api-client';

/** Bump this integer whenever the SessionSnapshot schema changes in a breaking way. */
export const SESSION_FORMAT_VERSION = 1;

/**
 * The serialized shape written to disk.
 * Both migration maps are stored as plain objects because JSON.stringify
 * on a Map produces "{}" -- callers must pass Maps; exportSession converts them.
 */
export interface SessionSnapshot {
  version: number;
  exportedAt: string;
  toolVersion: string;
  selectedProviders: ProviderType[];
  findings: FindingRow[];
  countOverrides: Record<string, number>;
  niosMigrationMap: Record<string, ServerFormFactor>;
  adMigrationMap: Record<string, ServerFormFactor>;
  niosServerMetrics: NiosServerMetrics[];
  adServerMetrics: ADServerMetricAPI[];
  estimatorAnswers: EstimatorInputs;
  growthBufferPct: number;
  reportingDestEnabled: Record<string, boolean>;
  reportingDestEvents: Record<string, number>;
  serverMetricOverrides?: Record<string, { qps?: number; lps?: number; objects?: number }>;
}

/**
 * What callers (wizard.tsx) pass in.
 * Uses Map for the two migration maps (matching wizard state) so callers
 * pass their Maps directly without manual conversion.
 */
export interface SessionExportInput {
  selectedProviders: ProviderType[];
  findings: FindingRow[];
  countOverrides: Record<string, number>;
  niosMigrationMap: Map<string, ServerFormFactor>;
  adMigrationMap: Map<string, ServerFormFactor>;
  niosServerMetrics: NiosServerMetrics[];
  adServerMetrics: ADServerMetricAPI[];
  estimatorAnswers: EstimatorInputs;
  growthBufferPct: number;
  reportingDestEnabled: Record<string, boolean>;
  reportingDestEvents: Record<string, number>;
  serverMetricOverrides?: Record<string, { qps?: number; lps?: number; objects?: number }>;
}

/**
 * Assemble a SessionSnapshot and return it as a pretty-printed JSON string.
 *
 * Maps are converted with Object.fromEntries so they round-trip correctly.
 */
export function exportSession(input: SessionExportInput, toolVersion: string): string {
  const snapshot: SessionSnapshot = {
    version: SESSION_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    toolVersion,
    selectedProviders: input.selectedProviders,
    findings: input.findings,
    countOverrides: input.countOverrides,
    niosMigrationMap: Object.fromEntries(input.niosMigrationMap),
    adMigrationMap: Object.fromEntries(input.adMigrationMap),
    niosServerMetrics: input.niosServerMetrics,
    adServerMetrics: input.adServerMetrics,
    estimatorAnswers: input.estimatorAnswers,
    growthBufferPct: input.growthBufferPct,
    reportingDestEnabled: input.reportingDestEnabled,
    reportingDestEvents: input.reportingDestEvents,
    serverMetricOverrides: input.serverMetricOverrides,
  };
  return JSON.stringify(snapshot, null, 2);
}

// ---------------------------------------------------------------------------
// Import-side: validation and deserialization
// ---------------------------------------------------------------------------

/**
 * Result of a schema validation check.
 * `valid: true` means the data can safely be cast to SessionSnapshot.
 * `valid: false` carries a user-readable `error` string suitable for display in the UI.
 */
export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validate that `data` conforms to the SessionSnapshot schema.
 *
 * Checks are ordered from coarse (type) to fine (field presence/type) so the
 * first failing check produces the most actionable error message.
 */
export function validateSessionSchema(data: unknown): ValidationResult {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { valid: false, error: 'Not a valid session file.' };
  }
  const d = data as Record<string, unknown>;
  if (typeof d.version !== 'number') {
    return { valid: false, error: 'Session file is missing a version field.' };
  }
  if (d.version !== SESSION_FORMAT_VERSION) {
    return { valid: false, error: 'Incompatible session version. Please export a new session from the current tool version.' };
  }
  if (!Array.isArray(d.findings)) {
    return { valid: false, error: 'Session file is missing findings data.' };
  }
  if (!Array.isArray(d.selectedProviders)) {
    return { valid: false, error: 'Session file is missing provider list.' };
  }
  if (typeof d.estimatorAnswers !== 'object' || d.estimatorAnswers === null || Array.isArray(d.estimatorAnswers)) {
    return { valid: false, error: 'Session file is missing estimator configuration.' };
  }
  return { valid: true };
}

/**
 * Read a `.json` File, parse it, validate its schema, and return the
 * deserialized SessionSnapshot — or reject with a user-readable error.
 *
 * Uses the modern `file.text()` API (Node 20+ / all current browsers).
 * Does NOT use FileReader.
 */
export async function importSession(file: File): Promise<SessionSnapshot> {
  let parsed: unknown;
  try {
    const text = await file.text();
    parsed = JSON.parse(text);
  } catch {
    throw new Error('File is not valid JSON.');
  }
  const result = validateSessionSchema(parsed);
  if (!result.valid) {
    throw new Error(result.error);
  }
  return parsed as SessionSnapshot;
}

/**
 * Merge imported findings with live scan findings using a live-wins-per-provider strategy.
 *
 * Retained rows: imported findings whose provider is in `importedProviders` AND
 * whose provider is NOT in `liveProviders` (i.e., the provider was not re-scanned live).
 * All live findings are always included.
 *
 * @param importedFindings - All findings from the previously imported session.
 * @param importedProviders - Set of provider IDs that came from the imported session.
 * @param liveFindings - Findings produced by the most recent live scan.
 * @param liveProviders - Provider IDs that participated in the most recent live scan.
 * @returns Merged findings: retained imported rows first, then all live rows.
 */
export function mergeFindings(
  importedFindings: FindingRow[],
  importedProviders: Set<ProviderType>,
  liveFindings: FindingRow[],
  liveProviders: ProviderType[]
): FindingRow[] {
  const liveSet = new Set(liveProviders);
  const retained = importedFindings.filter(
    (f) => importedProviders.has(f.provider) && !liveSet.has(f.provider)
  );
  return [...retained, ...liveFindings];
}
