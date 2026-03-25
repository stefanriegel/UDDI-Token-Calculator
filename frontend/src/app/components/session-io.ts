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
  };
  return JSON.stringify(snapshot, null, 2);
}
