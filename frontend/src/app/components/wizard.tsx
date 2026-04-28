import { useState, useMemo, useRef, useEffect, useCallback, Fragment } from 'react';
import {
  CheckCircle2,
  Circle,
  ChevronRight,
  ChevronLeft,
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  Loader2,
  Download,
  FileSpreadsheet,
  RotateCcw,
  WifiOff,
  Check,
  AlertCircle,
  Info,
  HelpCircle,
  Globe,
  Search,
  Minus,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Upload,
  ArrowRightLeft,
  Activity,
  Gauge,
  Heart,
  Github,
  X,
  Plus,
  Shield,
  ArrowUpCircle,
  Pencil,
  Undo2,
  Workflow,
} from 'lucide-react';
import { ImportConfirmDialog } from './sizer/import-confirm-dialog';
import { importFromScan, mergeFullState, countTreeEntities } from './sizer/sizer-import';
import { STORAGE_KEY, SIZER_IMPORT_BADGE_KEY, SizerProvider, SizerDispatchBridge, loadPersisted, initialSizerState, type SizerAction } from './sizer/sizer-state';
import type { Dispatch } from 'react';
import { Tooltip, TooltipTrigger, TooltipContent } from './ui/tooltip';
import { PlatformBadge } from './ui/platform-badge';
import { useBackendConnection } from './use-backend';
import {
  validateCredentials as apiValidate,
  uploadNiosBackup as apiUploadNios,
  uploadNiosQPS as apiUploadNiosQPS,
  uploadEfficientipBackup,
  validateBluecat as apiValidateBluecat,
  validateEfficientip as apiValidateEfficientip,
  validateNiosWapi as apiValidateNiosWapi,
  discoverADServers as apiDiscoverADServers,
  startScan as apiStartScan,
  getScanStatus as apiGetScanStatus,
  getScanResults as apiGetScanResults,
  downloadExcelExport,
  getSessionId,
  cloneSession,
  type ScanStatusResponse,
  type ADDiscoveredServer,
  type ADServerMetricAPI,
  type NiosGridFeaturesAPI,
  type NiosGridLicensesAPI,
  type NiosMigrationFlagsAPI,
  type NiosQPSMember,
} from './api-client';
import {
  PROVIDERS,
  MOCK_SUBSCRIPTIONS,
  generateMockFindings,
  TOKEN_RATES,
  MOCK_NIOS_SERVER_METRICS,
  calcServerTokenTier,
  consolidateXaasInstances,
  calcNiosTokens,
  calcUddiTokensAggregated,
  NIOS_GRID_LOGO,
  INFOBLOX_LOGO,
  PROVIDER_LOGOS,
  XAAS_EXTRA_CONNECTION_COST,
  BACKEND_PROVIDER_ID,
  toFrontendProvider,
  toFrontendCategory,
  type ProviderType,
  type FindingRow,
  type TokenCategory,
  type NiosServerMetrics,
  type ServerFormFactor,
  type ConsolidatedXaasInstance,
} from './mock-data';
import { SERVER_TOKEN_TIERS, XAAS_TOKEN_TIERS } from './nios-calc';
import { calcEstimator, calcReportingTokens, computeEstimatorWarnings, REPORTING_DESTINATIONS, EstimatorDefaults, type EstimatorInputs, type ReportingDestinationInput, type ReportingDestinationResult, type ServerEntry, type ServerTokenDetail } from './estimator-calc';
import {
  calcMemberSavings,
  calcFleetSavings,
  type AppliancePlatform,
} from './resource-savings';
import { ResourceSavingsTile } from './resource-savings-tile';
import { MemberResourceSavings } from './member-resource-savings';
import { FleetSavingsTotals } from './fleet-savings-totals';
import { exportSession, importSession, mergeFindings, type SessionSnapshot } from './session-io';
import { OutlineNav } from './ui/outline-nav';
import { SizerWizard } from './sizer/sizer-wizard';
import { SizerResultsView } from './sizer/sizer-results-view';
import { ResultsSurface } from './results/results-surface';
type Step = 'providers' | 'credentials' | 'sources' | 'scanning' | 'results';
type SortColumn = 'provider' | 'source' | 'category' | 'item' | 'count' | 'managementTokens' | 'uddiTokens';
type SortDir = 'asc' | 'desc';

/** Effective object count for server token tier sizing: DDI objects + Active IPs (DHCP). */
function serverSizingObjects(m: NiosServerMetrics): number {
  return m.objectCount + (m.activeIPCount ?? 0);
}

/** Apply server metric overrides (QPS/LPS/Objects) to a member for tier calculation. */
function applyServerOverrides(
  m: NiosServerMetrics,
  overrides: Record<string, { qps?: number; lps?: number; objects?: number }>
): { qps: number; lps: number; objects: number } {
  const ov = overrides[m.memberId];
  return {
    qps: ov?.qps ?? m.qps,
    lps: ov?.lps ?? m.lps,
    objects: ov?.objects ?? serverSizingObjects(m),
  };
}

/** Apply server metric overrides to an AD DC for tier calculation. */
function applyADServerOverrides(
  m: ADServerMetricAPI,
  overrides: Record<string, { qps?: number; lps?: number; objects?: number }>
): { qps: number; lps: number; objects: number } {
  const ov = overrides[m.hostname];
  return {
    qps: ov?.qps ?? m.qps,
    lps: ov?.lps ?? m.lps,
    objects: ov?.objects ?? (m.dnsObjects + m.dhcpObjectsWithOverhead),
  };
}

/**
 * Detect infrastructure-only GM/GMC members that have no DNS/DHCP workload.
 * These members are replaced by the UDDI Portal and don't need NIOS-X licensing.
 * GM/GMC members WITH DNS/DHCP workload (non-zero QPS, LPS, or objects) are
 * normal migration candidates.
 */
function isInfraOnlyMember(m: NiosServerMetrics): boolean {
  return (m.role === 'GM' || m.role === 'GMC') &&
    m.qps === 0 && m.lps === 0 && m.objectCount === 0 && (m.activeIPCount ?? 0) === 0;
}

const STEPS: { id: Step; label: string }[] = [
  { id: 'providers', label: 'Select Providers' },
  { id: 'credentials', label: 'Credentials' },
  { id: 'sources', label: 'Select Sources' },
  { id: 'scanning', label: 'Scan' },
  { id: 'results', label: 'Results & Export' },
];

/** Format raw item identifiers for display. Converts `dns_record_a` → `DNS Record (A)`, etc. */
function formatItemLabel(item: string): string {
  if (item.startsWith('dns_record_')) {
    const suffix = item.slice('dns_record_'.length);
    return `DNS Record (${suffix.toUpperCase()})`;
  }
  return item;
}

// ─── ScenarioPlannerCards ─────────────────────────────────────────────────────
// Shared scenario comparison card row used by every migration planner section.
// Renders three cards (Current / Hybrid / Full) in a consistent layout.
//
// Usage (add a new connector):
//   1. Compute three scenario values: { label, primaryValue, subLines?, desc }
//   2. Determine isActive for each scenario based on the connector's migration map
//   3. Render <ScenarioPlannerCards title="..." color="orange|blue" ... />
//
// Template for a new connector planner section:
//   const scenarioCurrent = { label: 'Current',        primaryValue: 0,             desc: '...' };
//   const scenarioHybrid  = { label: 'Hybrid',         primaryValue: hybridTokens,  desc: '...' };
//   const scenarioFull    = { label: 'Full Migration',  primaryValue: fullTokens,    desc: '...' };
//   const isActive = (idx: number) => idx === 0 ? mapSize === 0 : idx === 1 ? mapSize > 0 && mapSize < total : mapSize === total;
//   <ScenarioPlannerCards title="Management Tokens" unit="Management Tokens" color="orange"
//     scenarios={[scenarioCurrent, scenarioHybrid, scenarioFull]}
//     isActive={isActive} />
//   <ScenarioPlannerCards title="Server Tokens" unit="Server Tokens" color="blue"
//     scenarios={[scenarioCurrent, scenarioHybrid, scenarioFull]}
//     isActive={isActive} />

interface ScenarioCard {
  label: string;
  /** The main large number displayed on the card. */
  primaryValue: number;
  /** Optional sub-lines shown below the primary value (e.g. UDDI vs NIOS licensing split). */
  subLines?: { text: string; color: string }[];
  desc: string;
}

function ScenarioPlannerCards({
  title,
  unit,
  color,
  scenarios,
  isActive,
}: {
  title: string;
  unit: string;
  color: 'orange' | 'blue';
  scenarios: ScenarioCard[];
  isActive: (idx: number) => boolean;
}) {
  const activeBorder  = color === 'orange' ? 'border-[var(--infoblox-orange)]' : 'border-blue-500';
  const activeBg      = color === 'orange' ? 'bg-orange-50/30'                 : 'bg-blue-50/30';
  const activeDot     = color === 'orange' ? 'bg-[var(--infoblox-orange)]'     : 'bg-blue-500';
  const activeNumber  = color === 'orange' ? 'text-[var(--infoblox-orange)]'   : 'text-blue-700';

  return (
    <div className="px-4 py-4 border-t border-[var(--border)]">
      <h3 className="text-[14px] font-semibold text-[var(--foreground)] mb-3">{title}</h3>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {scenarios.map((scenario, idx) => {
          const active = isActive(idx);
          return (
            <div
              key={scenario.label}
              className={`rounded-xl border-2 p-4 transition-colors ${
                active ? `${activeBorder} ${activeBg} shadow-sm` : 'border-[var(--border)] bg-white'
              }`}
            >
              <div className="flex items-center gap-2 mb-2">
                {active && <span className={`w-2 h-2 rounded-full ${activeDot}`} />}
                <span className="text-[12px] uppercase tracking-wider text-[var(--muted-foreground)]" style={{ fontWeight: 600 }}>
                  {scenario.label}
                </span>
              </div>
              <div className={`text-[28px] ${activeNumber}`} style={{ fontWeight: 700 }}>
                {scenario.primaryValue.toLocaleString()}
              </div>
              <div className="text-[11px] text-[var(--muted-foreground)] mb-2">{unit}</div>
              {scenario.subLines && scenario.subLines.length > 0 && (
                <div className="text-[11px] space-y-0.5 mb-1">
                  {scenario.subLines.map((line, i) => (
                    <div key={i} style={{ color: line.color }}>{line.text}</div>
                  ))}
                </div>
              )}
              <p className="text-[11px] text-[var(--muted-foreground)] border-t border-[var(--border)] pt-2 mt-2">
                {scenario.desc}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
// ─────────────────────────────────────────────────────────────────────────────


/** Small info icon that shows a tooltip on hover. Use next to labels that need extra explanation. */
function FieldTooltip({ text, side = 'top' }: { text: string; side?: 'top' | 'right' | 'bottom' | 'left' }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          tabIndex={-1}
          className="inline-flex items-center justify-center text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors cursor-help focus:outline-none"
          aria-label={text}
        >
          <HelpCircle className="w-3.5 h-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side={side} className="max-w-[260px] text-[12px] leading-relaxed">
        {text}
      </TooltipContent>
    </Tooltip>
  );
}

/** Inline component: add/remove list for server addresses (replaces comma-separated text input). */
function ServerListInput({
  servers,
  onChange,
  placeholder,
}: {
  servers: string[];
  onChange: (servers: string[]) => void;
  placeholder: string;
}) {
  const [draft, setDraft] = useState('');

  const addServer = () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    // Split on commas in case user pastes a comma-separated list
    const newEntries = trimmed.split(',').map((s) => s.trim()).filter(Boolean);
    const unique = newEntries.filter((s) => !servers.includes(s));
    if (unique.length > 0) {
      onChange([...servers, ...unique]);
    }
    setDraft('');
  };

  const removeServer = (index: number) => {
    onChange(servers.filter((_, i) => i !== index));
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addServer();
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <input
          type="text"
          placeholder={placeholder}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          className="flex-1 px-3 py-2 bg-[var(--input-background)] border border-[var(--border)] rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-[var(--infoblox-blue)]/30 focus:border-[var(--infoblox-blue)]"
        />
        <button
          type="button"
          onClick={addServer}
          disabled={!draft.trim()}
          className="flex items-center gap-1 px-3 py-2 bg-[var(--infoblox-blue)] text-white text-[13px] font-medium rounded-lg hover:bg-[var(--infoblox-blue)]/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          Add
        </button>
      </div>
      {servers.length > 0 && (
        <ul className="space-y-1">
          {servers.map((server, i) => (
            <li
              key={`${server}-${i}`}
              className="flex items-center justify-between px-3 py-1.5 bg-[var(--input-background)] border border-[var(--border)] rounded-lg text-[13px]"
            >
              <span className="truncate">{server}</span>
              <button
                type="button"
                onClick={() => removeServer(i)}
                className="ml-2 flex-shrink-0 text-[var(--muted-foreground)] hover:text-red-500 transition-colors"
                aria-label={`Remove ${server}`}
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Wizard() {
  const backend = useBackendConnection();
  const [currentStep, setCurrentStep] = useState<Step>('providers');
  const currentIndex = STEPS.findIndex((s) => s.id === currentStep);

  // Live SizerProvider dispatch bridge — wizard.tsx sits OUTSIDE the
  // <SizerProvider> it mounts, so we can't call useSizer() here. The
  // <SizerDispatchBridge/> child writes the live `dispatch` into this ref,
  // letting handleSizerImportConfirm dispatch IMPORT_SCAN against the
  // long-lived provider (commit c54da81 hoisted the provider to wizard root,
  // so it no longer re-mounts on route changes — sessionStorage alone is
  // not observed).
  const sizerDispatchRef = useRef<Dispatch<SizerAction> | null>(null);

  // State
  const [selectedProviders, setSelectedProviders] = useState<ProviderType[]>([]);
  const isNiosOnly = selectedProviders.length === 1 && selectedProviders[0] === 'nios';
  const isEstimatorOnly = selectedProviders.length === 1 && selectedProviders[0] === 'estimator';
  const [credentials, setCredentials] = useState<Record<ProviderType, Record<string, string>>>({
    aws: {},
    azure: {},
    gcp: {},
    microsoft: {},
    nios: {},
    bluecat: {},
    efficientip: {},
    estimator: {},
  });
  const [credentialStatus, setCredentialStatus] = useState<Record<ProviderType, 'idle' | 'validating' | 'valid' | 'error'>>({
    aws: 'idle',
    azure: 'idle',
    gcp: 'idle',
    microsoft: 'idle',
    nios: 'idle',
    bluecat: 'idle',
    efficientip: 'idle',
    estimator: 'idle',
  });
  const [subscriptions, setSubscriptions] = useState<
    Record<ProviderType, { id: string; name: string; selected: boolean }[]>
  >({
    aws: [],
    azure: [],
    gcp: [],
    microsoft: [],
    nios: [],
    bluecat: [],
    efficientip: [],
    estimator: [],
  });
  const [scanProgress, setScanProgress] = useState(0);
  const [providerScanProgress, setProviderScanProgress] = useState<Record<ProviderType, number>>({
    aws: 0, azure: 0, gcp: 0, microsoft: 0, nios: 0, bluecat: 0, efficientip: 0, estimator: 0,
  });
  const [findings, setFindings] = useState<FindingRow[]>([]);
  // Backend-computed aggregate token values (authoritative source when no count overrides are active).
  // These come from the API ScanResultsResponse and reflect correct aggregate-then-divide math.
  const [backendTokenAggregates, setBackendTokenAggregates] = useState<{
    ddiTokens: number; ipTokens: number; assetTokens: number;
  } | null>(null);
  // Manual count overrides (issue #28): keyed by "provider::source::item", value is the user-entered count.
  // When set, the override replaces the original count and recalculates managementTokens.
  const [countOverrides, setCountOverrides] = useState<Record<string, number>>({});
  // Which finding row is currently being edited (click-to-edit count cell)
  const [editingFindingKey, setEditingFindingKey] = useState<string | null>(null);
  const [editingCountValue, setEditingCountValue] = useState<string>('');
  // Server metric overrides (QPS/LPS/Objects): keyed by memberId (NIOS) or hostname (AD)
  const [serverMetricOverrides, setServerMetricOverrides] = useState<
    Record<string, { qps?: number; lps?: number; objects?: number }>
  >({});
  const [editingServerMetric, setEditingServerMetric] = useState<{ memberId: string; field: 'qps' | 'lps' | 'objects' } | null>(null);
  const [editingServerValue, setEditingServerValue] = useState('');
  const [credentialError, setCredentialError] = useState<Record<ProviderType, string>>({
    aws: '', azure: '', gcp: '', microsoft: '', nios: '', bluecat: '', efficientip: '', estimator: '',
  });
  const [deviceCodeMessage, setDeviceCodeMessage] = useState<string>('');
  const [scanError, setScanError] = useState<string>('');
  const [importError, setImportError] = useState<string>('');
  const [importedProviders, setImportedProviders] = useState<Set<ProviderType>>(new Set());
  const [liveScannedProviders, setLiveScannedProviders] = useState<Set<ProviderType>>(new Set());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scanIntervalsRef = useRef<ReturnType<typeof setInterval>[]>([]);
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});
  const [dockerCopied, setDockerCopied] = useState(false);
  const [selectedAuthMethod, setSelectedAuthMethod] = useState<Record<ProviderType, string>>({
    aws: 'sso',
    azure: 'browser-sso',
    gcp: 'browser-oauth',
    microsoft: 'kerberos',
    nios: 'backup-upload',
    bluecat: 'credentials',
    efficientip: 'credentials',
    estimator: '',
  });
  const [sourceSearch, setSourceSearch] = useState<Record<ProviderType, string>>({
    aws: '', azure: '', gcp: '', microsoft: '', nios: '', bluecat: '', efficientip: '', estimator: '',
  });
  const [advancedOptions, setAdvancedOptions] = useState<Record<ProviderType, { maxWorkers: number }>>({
    aws: { maxWorkers: 0 }, azure: { maxWorkers: 0 }, gcp: { maxWorkers: 0 },
    microsoft: { maxWorkers: 0 }, nios: { maxWorkers: 0 }, bluecat: { maxWorkers: 0 }, efficientip: { maxWorkers: 0 }, estimator: { maxWorkers: 0 },
  });
  // Top consumer expandable cards
  const [topDnsExpanded, setTopDnsExpanded] = useState(false);
  const [topDhcpExpanded, setTopDhcpExpanded] = useState(false);
  const [topIpExpanded, setTopIpExpanded] = useState(false);
  const [showAllHeroSources, setShowAllHeroSources] = useState(false);
  const [heroCollapsed, setHeroCollapsed] = useState(true);
  const [findingsCollapsed, setFindingsCollapsed] = useState(true);
  const [showAllCategorySources, setShowAllCategorySources] = useState<Record<string, boolean>>({});

  // Findings table filters & sorting
  const [findingsProviderFilter, setFindingsProviderFilter] = useState<Set<ProviderType>>(new Set());
  const [findingsCategoryFilter, setFindingsCategoryFilter] = useState<Set<TokenCategory>>(new Set());
  const [findingsSort, setFindingsSort] = useState<{ col: SortColumn; dir: SortDir } | null>(null);

  // Selection mode: 'include' = checked items will be scanned; 'exclude' = checked items will be SKIPPED
  const [selectionMode, setSelectionMode] = useState<Record<ProviderType, 'include' | 'exclude'>>({
    aws: 'include', azure: 'include', gcp: 'include', microsoft: 'include', nios: 'include', bluecat: 'include', efficientip: 'include', estimator: 'include',
  });

  // ── Manual Estimator state (S02) ───────────────────────────────────────────
  const [estimatorAnswers, setEstimatorAnswers] = useState<EstimatorInputs>({ ...EstimatorDefaults });
  const [estimatorMonthlyLogVolume, setEstimatorMonthlyLogVolume] = useState<number>(0);
  const [estimatorServerTokens, setEstimatorServerTokens] = useState<number>(0);
  const [estimatorServerDetails, setEstimatorServerDetails] = useState<ServerTokenDetail[]>([]);

  // ── Reporting destination toggle state ──────────────────────────────────────
  const [reportingDestEnabled, setReportingDestEnabled] = useState<Record<string, boolean>>(
    () => Object.fromEntries(REPORTING_DESTINATIONS.map(d => [d.id, true]))
  );
  const [reportingDestEvents, setReportingDestEvents] = useState<Record<string, number>>(
    () => Object.fromEntries(REPORTING_DESTINATIONS.map(d => [d.id, 0]))
  );
  // Track whether the user manually typed an Ecosystem event count
  const ecosystemManualOverride = useRef(false);

  // ── Growth buffer & BOM state (S03) ───────────────────────────────────────
  const [growthBufferPct, setGrowthBufferPct] = useState<number>(0.20);
  const [serverGrowthBufferPct, setServerGrowthBufferPct] = useState<number>(0.20);
  const [bomCopied, setBomCopied] = useState(false);

  // NIOS-specific state
  const [efficientipAPIVersion, setEfficientipAPIVersion] = useState<'legacy' | 'v2'>('legacy');
  const [niosMode, setNiosMode] = useState<'backup' | 'wapi'>('backup');
  const [niosUploadedFile, setNiosUploadedFile] = useState<File | null>(null);
  const [niosDragOver, setNiosDragOver] = useState(false);
  // EfficientIP backup mode state
  const [efficientipMode, setEfficientipMode] = useState<'api' | 'backup'>('api');
  const [efficientipUploadedFile, setEfficientipUploadedFile] = useState<File | null>(null);
  const [efficientipDragOver, setEfficientipDragOver] = useState(false);
  const [efficientipBackupToken, setEfficientipBackupToken] = useState<string>('');
  // NIOS-X migration planner: which NIOS sources (grid members) to migrate, with per-member form factor
  const [niosMigrationMap, setNiosMigrationMap] = useState<Map<string, ServerFormFactor>>(new Map());
  const [memberSearchFilter, setMemberSearchFilter] = useState('');
  const [memberDetailsOpen, setMemberDetailsOpen] = useState(false);
  const [memberDetailsSearch, setMemberDetailsSearch] = useState('');
  const [adMigrationMap, setAdMigrationMap] = useState<Map<string, ServerFormFactor>>(new Map());
  const [adMemberSearchFilter, setAdMemberSearchFilter] = useState('');

  // Backend wiring: NIOS backup token returned from upload, and live server metrics from scan results
  const [backupToken, setBackupToken] = useState<string>('');
  // QPS upload state
  const [niosQPSFile, setNiosQPSFile] = useState<File | null>(null);
  const [niosQPSDragOver, setNiosQPSDragOver] = useState(false);
  const [qpsToken, setQpsToken] = useState<string>('');
  const [qpsMembers, setQpsMembers] = useState<NiosQPSMember[]>([]);
  const [qpsUploading, setQpsUploading] = useState(false);
  const [qpsError, setQpsError] = useState<string>('');
  const [niosServerMetrics, setNiosServerMetrics] = useState<NiosServerMetrics[]>([]);
  const [niosGridFeatures, setNiosGridFeatures] = useState<NiosGridFeaturesAPI | null>(null);
  const [niosGridLicenses, setNiosGridLicenses] = useState<NiosGridLicensesAPI | null>(null);
  const [niosMigrationFlags, setNiosMigrationFlags] = useState<NiosMigrationFlagsAPI | null>(null);
  const [gridFeaturesOpen, setGridFeaturesOpen] = useState(false);
  const [migrationFlagsOpen, setMigrationFlagsOpen] = useState(false);
  const [showGridMemberDetails, setShowGridMemberDetails] = useState(false);
  const [gridMemberDetailSearch, setGridMemberDetailSearch] = useState('');

  // ── Resource Savings (Phase 27 — v3.2 RES-06..RES-11) ────────────────────
  // Per-member variant override map: memberId → variantIndex.
  // Resets on new scan. Drives live recompute of resource savings.
  const [variantOverrides, setVariantOverrides] = useState<Map<string, number>>(new Map());

  // Backend scan ID — captured after a successful live scan so the Download
  // XLSX button can call the real backend exporter (RES-15). Null in demo /
  // imported-session mode, in which case the legacy client-side HTML export
  // is used as a fallback.
  const [backendScanId, setBackendScanId] = useState<string | null>(null);

  // AD server metrics for migration planner
  const [adServerMetrics, setAdServerMetrics] = useState<ADServerMetricAPI[]>([]);

  // AD forest discovery state
  const [adDiscovering, setAdDiscovering] = useState(false);
  const [adDiscoveryResult, setAdDiscoveryResult] = useState<{
    forestName?: string;
    domainControllers: ADDiscoveredServer[];
    dhcpServers: ADDiscoveredServer[];
    errors?: string[];
  } | null>(null);
  const [adDiscoveryDismissed, setAdDiscoveryDismissed] = useState(false);

  // Additional AD forests (beyond the primary forest in credentials.microsoft).
  // Each entry is a separate forest with its own credential set and validation state.
  type ADForestEntry = {
    id: string; // stable local ID (e.g. "forest-1")
    authMethod: string;
    credentials: Record<string, string>;
    status: 'idle' | 'validating' | 'valid' | 'error';
    error: string;
    subscriptions: { id: string; name: string; selected: boolean }[];
  };
  const [adForests, setAdForests] = useState<ADForestEntry[]>([]);

  // Use live metrics when available from real scan, fall back to mock data in demo mode
  const effectiveNiosMetrics = niosServerMetrics.length > 0 ? niosServerMetrics : MOCK_NIOS_SERVER_METRICS;

  // AD server metrics: use live data when available, mock data in demo mode when microsoft is selected
  const MOCK_AD_SERVER_METRICS: ADServerMetricAPI[] = [
    { hostname: 'DC01', dnsObjects: 1250, dhcpObjects: 340, dhcpObjectsWithOverhead: 408, qps: 2800, lps: 45, tier: '2XS', serverTokens: 130 },
    { hostname: 'DC02', dnsObjects: 8500, dhcpObjects: 1200, dhcpObjectsWithOverhead: 1440, qps: 12000, lps: 120, tier: 'XS', serverTokens: 250 },
    { hostname: 'DC03', dnsObjects: 25000, dhcpObjects: 8000, dhcpObjectsWithOverhead: 9600, qps: 35000, lps: 250, tier: 'M', serverTokens: 880 },
  ];
  const effectiveADMetrics = adServerMetrics.length > 0 ? adServerMetrics : (backend.isDemo && selectedProviders.includes('microsoft') ? MOCK_AD_SERVER_METRICS : []);

  // ── Resource Savings (Phase 27 — v3.2 RES-06..RES-11) ────────────────────
  // Compute per-member and fleet savings at the top-level component scope so
  // they can be referenced from anywhere in render. Mirrors the
  // `displayMembers` selection logic used by the Grid Member Details block
  // (migrating-members preferred, otherwise all migrateable members).
  const resourceSavingsDisplayMembers = useMemo(() => {
    const migrating = effectiveNiosMetrics.filter(
      (m) => niosMigrationMap.has(m.memberName) && !isInfraOnlyMember(m)
    );
    const all = effectiveNiosMetrics.filter((m) => !isInfraOnlyMember(m));
    return migrating.length > 0 ? migrating : all;
  }, [effectiveNiosMetrics, niosMigrationMap]);

  const memberSavings = useMemo(() => {
    return resourceSavingsDisplayMembers.map((m) => {
      const ff: ServerFormFactor = niosMigrationMap.get(m.memberName) || 'nios-x';
      const eff = applyServerOverrides(m, serverMetricOverrides);
      const tier = calcServerTokenTier(eff.qps, eff.lps, eff.objects, ff);
      const input = {
        memberId: m.memberId,
        memberName: m.memberName,
        model: m.model || '',
        platform: ((m.platform || 'Physical') as AppliancePlatform),
      };
      const override = variantOverrides.get(m.memberId);
      return calcMemberSavings(input, tier, ff, override);
    });
  }, [resourceSavingsDisplayMembers, niosMigrationMap, variantOverrides, serverMetricOverrides]);

  const fleetSavings = useMemo(() => calcFleetSavings(memberSavings), [memberSavings]);

  // Outline nav sections — dynamic based on active providers
  const outlineSections = useMemo(() => {
    const sections: Array<{ id: string; label: string }> = [
      { id: 'section-overview', label: 'Overview' },
      { id: 'section-bom', label: 'Token Breakdown' },
    ];
    if (selectedProviders.includes('nios')) {
      sections.push({ id: 'section-migration-planner', label: 'Migration Planner' });
      sections.push({ id: 'section-member-details', label: 'Member Details' });
    }
    if (selectedProviders.includes('microsoft') && effectiveADMetrics.length > 0) {
      sections.push({ id: 'section-ad-migration', label: 'AD Migration' });
    }
    sections.push({ id: 'section-findings', label: 'Detailed Findings' });
    sections.push({ id: 'section-export', label: 'Export' });
    return sections;
  }, [selectedProviders, effectiveADMetrics]);

  const outlineExpandHandlers = useMemo(() => {
    const handlers: Record<string, () => void> = {};
    handlers['section-member-details'] = () => {
      if (!showGridMemberDetails) setShowGridMemberDetails(true);
    };
    return handlers;
  }, [showGridMemberDetails]);

  // Helper: render provider icon (uses real cloud logos for all providers)
  const ProviderIconEl = ({ id, className }: { id: ProviderType; className?: string; color?: string }) => {
    return <img src={PROVIDER_LOGOS[id]} alt={PROVIDERS.find(p => p.id === id)?.name || id} className={`${className || 'w-5 h-5'} rounded object-contain`} />;
  };

  // Compute effective selection (what actually gets scanned) based on mode
  const getEffectiveSelected = useCallback((provId: ProviderType): Set<string> => {
    const subs = subscriptions[provId] || [];
    const mode = selectionMode[provId];
    if (mode === 'include') {
      return new Set(subs.filter((s) => s.selected).map((s) => s.id));
    } else {
      // exclude mode: everything NOT checked gets scanned
      return new Set(subs.filter((s) => !s.selected).map((s) => s.id));
    }
  }, [subscriptions, selectionMode]);

  const getEffectiveSelectedCount = useCallback((provId: ProviderType): number => {
    return getEffectiveSelected(provId).size;
  }, [getEffectiveSelected]);

  // Navigation
  const canGoNext = (): boolean => {
    switch (currentStep) {
      case 'providers':
        return selectedProviders.length > 0;
      case 'credentials': {
        const primaryValid = selectedProviders.every((p) => credentialStatus[p] === 'valid');
        // All additional AD forests must also be validated (or removed) before proceeding.
        const forestsValid = adForests.every((f) => f.status === 'valid');
        return primaryValid && forestsValid;
      }
      case 'sources':
        return selectedProviders.some((p) =>
          getEffectiveSelectedCount(p) > 0
        ) || adForests.some((f) => f.subscriptions.some((s) => s.selected)) || selectedProviders.includes('estimator');
      case 'scanning':
        return scanProgress >= 100;
      default:
        return false;
    }
  };

  const goNext = () => {
    const nextIndex = currentIndex + 1;
    if (nextIndex < STEPS.length) {
      const nextStep = STEPS[nextIndex].id;
      // Estimator skips Sources + Scan — Sizer state drives the report
      // directly via <SizerResultsView /> (Sizer Step 5 retired 2026-04-26).
      if (nextStep === 'sources' && selectedProviders.includes('estimator')) {
        setCurrentStep('results');
        return;
      }
      if (nextStep === 'scanning') {
        startScan();
      }
      setCurrentStep(nextStep);
    }
  };

  const goBack = () => {
    if (currentIndex > 0) {
      // Clean up scan intervals if leaving the scanning step
      if (currentStep === 'scanning') {
        clearScanIntervals();
      }
      setCurrentStep(STEPS[currentIndex - 1].id);
    }
  };

  // Phase 32 D-03/D-18/Pitfall 10: write merged + badge BEFORE route flip.
  const handleSizerImportConfirm = () => {
    const existing = loadPersisted() ?? initialSizerState();
    const incoming = importFromScan(findings, niosServerMetrics, adServerMetrics);
    const merged = mergeFullState(existing, incoming);
    // Route to whichever step contains the freshly-imported data:
    //   • Regions present → Step 2 (Sites) so user can attach users / sites.
    //   • Only NIOS-X (e.g. Grid backup flow with no cloud/AD findings)
    //     → Step 3 (Infrastructure) where NIOS-X members live.
    //   • Otherwise → Step 1 (Regions) so user can start the hierarchy.
    const hasRegions = merged.core.regions.length > 0;
    const hasNiosx = merged.core.infrastructure.niosx.length > 0;
    const landingStep: 1 | 2 | 3 = hasRegions ? 2 : hasNiosx ? 3 : 1;
    merged.ui = { ...merged.ui, activeStep: landingStep };
    const b = countTreeEntities(existing);
    const a = countTreeEntities(merged);
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
      sessionStorage.setItem(
        SIZER_IMPORT_BADGE_KEY,
        JSON.stringify({ regions: a.regions - b.regions, sites: a.sites - b.sites, niosx: a.niosx - b.niosx }),
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[sizer] persist failed; aborting', err);
      return;
    }
    // Dispatch into the LIVE SizerProvider so the import is observed by the
    // long-lived in-memory state (since c54da81 the provider does not re-mount
    // on route changes and never re-reads sessionStorage). IMPORT_SCAN delegates
    // to mergeFullState(state, payload), so passing `incoming` against live
    // state produces the same result as the `merged` tree above.
    const sizerDispatch = sizerDispatchRef.current;
    if (sizerDispatch) {
      sizerDispatch({ type: 'IMPORT_SCAN', payload: incoming });
      sizerDispatch({ type: 'SET_ACTIVE_STEP', step: landingStep });
    } else {
      // eslint-disable-next-line no-console
      console.warn('[sizer] dispatch ref empty; live provider not updated');
    }
    setSelectedProviders(['estimator']); // Pitfall 2
    setCurrentStep('credentials');
    // Issue #21: results-page scroll persists across route flip; reset so
    // imported Sizer view opens at top instead of mid-page.
    if (typeof window !== 'undefined') {
      window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    }
  };

  const restart = () => {
    clearScanIntervals();
    setCurrentStep('providers');
    setSelectedProviders([]);
    setCredentials({ aws: {}, azure: {}, gcp: {}, microsoft: {}, nios: {}, bluecat: {}, efficientip: {}, estimator: {} });
    setCredentialStatus({ aws: 'idle', azure: 'idle', gcp: 'idle', microsoft: 'idle', nios: 'idle', bluecat: 'idle', efficientip: 'idle', estimator: 'idle' });
    setSubscriptions({ aws: [], azure: [], gcp: [], microsoft: [], nios: [], bluecat: [], efficientip: [], estimator: [] });
    setScanProgress(0);
    setProviderScanProgress({ aws: 0, azure: 0, gcp: 0, microsoft: 0, nios: 0, bluecat: 0, efficientip: 0, estimator: 0 });
    setFindings([]);
    setBackendTokenAggregates(null);
    setCountOverrides({});
    setImportedProviders(new Set());
    setLiveScannedProviders(new Set());
    setCredentialError({ aws: '', azure: '', gcp: '', microsoft: '', nios: '', bluecat: '', efficientip: '', estimator: '' });
    setScanError('');
    setSourceSearch({ aws: '', azure: '', gcp: '', microsoft: '', nios: '', bluecat: '', efficientip: '', estimator: '' });
    setSelectionMode({ aws: 'include', azure: 'include', gcp: 'include', microsoft: 'include', nios: 'include', bluecat: 'include', efficientip: 'include', estimator: 'include' });
    setNiosMode('backup');
    setNiosUploadedFile(null);
    setNiosDragOver(false);
    setNiosMigrationMap(new Map());
    setVariantOverrides(new Map());
    setMemberSearchFilter('');
    setBackupToken('');
    setNiosQPSFile(null);
    setNiosQPSDragOver(false);
    setQpsToken('');
    setQpsMembers([]);
    setQpsUploading(false);
    setQpsError('');
    setEfficientipMode('api');
    setEfficientipUploadedFile(null);
    setEfficientipBackupToken('');
    setNiosServerMetrics([]);
    setShowGridMemberDetails(false);
    setGridMemberDetailSearch('');
    setAdDiscoveryResult(null);
    setAdDiscoveryDismissed(false);
    setAdForests([]);
    setFindingsProviderFilter(new Set());
    setFindingsCategoryFilter(new Set());
    setFindingsSort(null);
    setEstimatorAnswers({ ...EstimatorDefaults });
    setEstimatorMonthlyLogVolume(0);
    setEstimatorServerTokens(0);
    setEstimatorServerDetails([]);
    setGrowthBufferPct(0.20);
    setServerGrowthBufferPct(0.20);
    setBomCopied(false);
    setServerMetricOverrides({});
    setEditingServerMetric(null);
    setEditingServerValue('');
  };

  // Provider toggle
  const toggleProvider = (id: ProviderType) => {
    setSelectedProviders((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]
    );
    // Reset credential status for toggled provider
    setCredentialStatus((prev) => ({ ...prev, [id]: 'idle' }));
    setSubscriptions((prev) => ({ ...prev, [id]: [] }));
  };

  // AD forest discovery: runs automatically after the microsoft provider validates.
  // Uses the first server in the current credentials list as the seed DC.
  const triggerADDiscovery = useCallback(async () => {
    if (backend.isDemo) return; // no-op in demo mode
    const authMethod = selectedAuthMethod.microsoft;
    const creds = credentials.microsoft || {};
    // Kerberos uses a different auth flow that doesn't support discovery via NTLM WinRM
    if (authMethod === 'kerberos') return;
    setAdDiscovering(true);
    setAdDiscoveryResult(null);
    setAdDiscoveryDismissed(false);
    try {
      const result = await apiDiscoverADServers(authMethod, creds);
      // Only surface if we found additional servers beyond what the user already entered
      const existingServers = new Set(
        (creds.servers || '').split(',').map((s: string) => s.trim().toLowerCase()).filter(Boolean)
      );
      const newDCs = result.domainControllers.filter(
        (dc) => !existingServers.has(dc.hostname.toLowerCase()) &&
                !existingServers.has((dc.ip || '').toLowerCase())
      );
      const newDHCP = result.dhcpServers.filter(
        (s) => !existingServers.has(s.hostname.toLowerCase()) &&
               !existingServers.has((s.ip || '').toLowerCase())
      );
      if (newDCs.length > 0 || newDHCP.length > 0) {
        setAdDiscoveryResult({
          forestName: result.forestName,
          domainControllers: newDCs,
          dhcpServers: newDHCP,
          errors: result.errors,
        });
      }
    } catch {
      // Discovery is best-effort; silently ignore errors
    } finally {
      setAdDiscovering(false);
    }
  }, [backend.isDemo, selectedAuthMethod, credentials]);

  // Validate credentials — uses real API when connected, mock when in demo mode
  const validateCredential = useCallback(async (providerId: ProviderType) => {
    setCredentialStatus((prev) => ({ ...prev, [providerId]: 'validating' }));
    setCredentialError((prev) => ({ ...prev, [providerId]: '' }));

    if (backend.isDemo) {
      // Demo mode: simulate with mock data
      setTimeout(() => {
        setCredentialStatus((prev) => ({ ...prev, [providerId]: 'valid' }));
        setSubscriptions((prev) => ({
          ...prev,
          [providerId]: MOCK_SUBSCRIPTIONS[providerId].map((s) => ({ ...s })),
        }));
      }, 1200);
      return;
    }

    // Real API call — dispatch per provider/mode
    try {
      if (providerId === 'nios' && niosMode === 'backup' && niosUploadedFile) {
        // NIOS Backup upload
        const result = await apiUploadNios(niosUploadedFile);
        if (result.valid) {
          setCredentialStatus((prev) => ({ ...prev, nios: 'valid' }));
          if (result.backupToken) setBackupToken(result.backupToken);
          setSubscriptions((prev) => ({
            ...prev,
            nios: result.members.map((m, i) => ({
              id: `nios-${i}`,
              name: `${m.hostname} (${m.role})`,
              selected: true,
            })),
          }));
        } else {
          setCredentialStatus((prev) => ({ ...prev, nios: 'error' }));
          setCredentialError((prev) => ({ ...prev, nios: result.error || 'Failed to parse backup' }));
        }
      } else if (providerId === 'nios' && niosMode === 'wapi') {
        // NIOS WAPI live API
        const creds = credentials.nios || {};
        const result = await apiValidateNiosWapi(creds);
        if (result.valid) {
          setCredentialStatus((prev) => ({ ...prev, nios: 'valid' }));
          setSubscriptions((prev) => ({
            ...prev,
            nios: result.members.map((m, i) => ({
              id: `nios-${i}`,
              name: `${m.hostname} (${m.role})`,
              selected: true,
            })),
          }));
        } else {
          setCredentialStatus((prev) => ({ ...prev, nios: 'error' }));
          setCredentialError((prev) => ({ ...prev, nios: result.error || 'WAPI validation failed' }));
        }
      } else if (providerId === 'bluecat') {
        // BlueCat API
        const creds = credentials.bluecat || {};
        const result = await apiValidateBluecat(creds);
        if (result.valid) {
          setCredentialStatus((prev) => ({ ...prev, bluecat: 'valid' }));
          setSubscriptions((prev) => ({
            ...prev,
            bluecat: result.subscriptions.map((s) => ({ ...s, selected: true })),
          }));
        } else {
          setCredentialStatus((prev) => ({ ...prev, bluecat: 'error' }));
          setCredentialError((prev) => ({ ...prev, bluecat: result.error || 'Validation failed' }));
        }
      } else if (providerId === 'efficientip' && efficientipMode === 'backup' && efficientipUploadedFile) {
        // EfficientIP Backup upload
        setCredentialStatus((prev) => ({ ...prev, efficientip: 'validating' }));
        try {
          const result = await uploadEfficientipBackup(efficientipUploadedFile);
          if (result.backupToken) {
            setEfficientipBackupToken(result.backupToken);
            setSubscriptions((prev) => ({ ...prev, efficientip: [{ id: 'backup', name: 'Backup file', selected: true }] }));
            setCredentialStatus((prev) => ({ ...prev, efficientip: 'valid' }));
          } else {
            setCredentialError((prev) => ({ ...prev, efficientip: result.error || 'Upload failed' }));
            setCredentialStatus((prev) => ({ ...prev, efficientip: 'error' }));
          }
        } catch (err) {
          setCredentialError((prev) => ({ ...prev, efficientip: (err as Error).message }));
          setCredentialStatus((prev) => ({ ...prev, efficientip: 'error' }));
        }
        return;
      } else if (providerId === 'efficientip') {
        // EfficientIP API
        const authMethod = selectedAuthMethod['efficientip'] || 'credentials';
        const creds = {
          ...(credentials.efficientip || {}),
          authMethod,
          api_version: efficientipAPIVersion,
        };
        const result = await apiValidateEfficientip(creds);
        if (result.valid) {
          setCredentialStatus((prev) => ({ ...prev, efficientip: 'valid' }));
          setSubscriptions((prev) => ({
            ...prev,
            efficientip: result.subscriptions.map((s) => ({ ...s, selected: true })),
          }));
        } else {
          setCredentialStatus((prev) => ({ ...prev, efficientip: 'error' }));
          setCredentialError((prev) => ({ ...prev, efficientip: result.error || 'Validation failed' }));
        }
      } else {
        // Generic provider validation (AWS, Azure, GCP, MS DHCP/DNS)
        const backendId = BACKEND_PROVIDER_ID[providerId];
        const authMethod = selectedAuthMethod[providerId];
        const creds = { ...(credentials[providerId] || {}) };

        // AWS org mode: inject orgEnabled flag required by backend contract
        if (providerId === 'aws' && authMethod === 'org') {
          creds.orgEnabled = 'true';
        }

        const result = await apiValidate(backendId, authMethod, creds);
        if (result.valid) {
          setCredentialStatus((prev) => ({ ...prev, [providerId]: 'valid' }));

          // Surface the device code message if the backend returned one (Azure device-code flow).
          if (result.deviceCodeMessage) {
            setDeviceCodeMessage(result.deviceCodeMessage);
          }

          // Auto-select subscriptions for org-discovered accounts, Azure multi-subscription,
          // and AD — DCs are explicitly added by the user so all should be scanned by default.
          const autoSelect =
            (providerId === 'aws' && authMethod === 'org') ||
            (providerId === 'gcp' && authMethod === 'org') ||
            providerId === 'azure' ||
            providerId === 'microsoft';

          setSubscriptions((prev) => ({
            ...prev,
            [providerId]: result.subscriptions.map((s) => ({ ...s, selected: autoSelect })),
          }));

          // After MS DHCP/DNS validates, probe the forest for additional servers
          if (providerId === 'microsoft') {
            triggerADDiscovery();
          }
        } else {
          setCredentialStatus((prev) => ({ ...prev, [providerId]: 'error' }));
          setCredentialError((prev) => ({ ...prev, [providerId]: result.error || 'Validation failed' }));
        }
      }
    } catch (err: any) {
      setCredentialStatus((prev) => ({ ...prev, [providerId]: 'error' }));
      setCredentialError((prev) => ({
        ...prev,
        [providerId]: err?.message || 'Connection error -- is the backend running?',
      }));
    }
  }, [backend.isDemo, selectedAuthMethod, credentials, niosUploadedFile, niosMode]);

  // Validate an additional AD forest by its local array index (0-based in adForests,
  // mapped to forestIndex=index+1 for the backend).
  const validateAdForest = useCallback(async (forestLocalIdx: number) => {
    setAdForests((prev) => prev.map((f, i) =>
      i === forestLocalIdx ? { ...f, status: 'validating', error: '' } : f,
    ));
    const forest = adForests[forestLocalIdx];
    if (!forest) return;
    try {
      const result = await apiValidate('ad', forest.authMethod, forest.credentials, forestLocalIdx + 1);
      if (result.valid) {
        setAdForests((prev) => prev.map((f, i) =>
          i === forestLocalIdx
            ? { ...f, status: 'valid', error: '', subscriptions: result.subscriptions.map((s) => ({ ...s, selected: true })) }
            : f,
        ));
      } else {
        setAdForests((prev) => prev.map((f, i) =>
          i === forestLocalIdx ? { ...f, status: 'error', error: result.error || 'Validation failed' } : f,
        ));
      }
    } catch (err: any) {
      setAdForests((prev) => prev.map((f, i) =>
        i === forestLocalIdx ? { ...f, status: 'error', error: err?.message || 'Connection error' } : f,
      ));
    }
  }, [adForests]);

  // Auto-parse NIOS backup when file is selected/dropped (backup mode only)
  useEffect(() => {
    if (niosMode === 'backup' && niosUploadedFile && credentialStatus.nios !== 'validating' && credentialStatus.nios !== 'valid') {
      validateCredential('nios');
    }
  }, [niosUploadedFile, niosMode]);

  // Auto-parse EfficientIP backup when file is selected/dropped (backup mode only)
  useEffect(() => {
    if (efficientipMode === 'backup' && efficientipUploadedFile &&
        credentialStatus.efficientip !== 'validating' && credentialStatus.efficientip !== 'valid') {
      validateCredential('efficientip');
    }
  }, [efficientipUploadedFile, efficientipMode]);

  // Toggle subscription selection
  const toggleSubscription = (providerId: ProviderType, subId: string) => {
    setSubscriptions((prev) => ({
      ...prev,
      [providerId]: prev[providerId].map((s) =>
        s.id === subId ? { ...s, selected: !s.selected } : s
      ),
    }));
  };

  // Clean up scan intervals on unmount or when navigating away
  const clearScanIntervals = useCallback(() => {
    scanIntervalsRef.current.forEach((id) => clearInterval(id));
    scanIntervalsRef.current = [];
  }, []);

  useEffect(() => {
    return () => clearScanIntervals();
  }, [clearScanIntervals]);

  // Start scan — uses real API when connected, mock when in demo mode
  const startScan = useCallback(() => {
    clearScanIntervals();
    setScanProgress(0);
    setScanError('');
    const initProgress: Record<ProviderType, number> = { aws: 0, azure: 0, gcp: 0, microsoft: 0, nios: 0, bluecat: 0, efficientip: 0, estimator: 0 };
    setProviderScanProgress(initProgress);
    setFindings([]);
    setBackendTokenAggregates(null);
    setCountOverrides((prev) => {
      const liveSet = new Set(selectedProviders);
      const next: Record<string, number> = {};
      for (const [key, val] of Object.entries(prev)) {
        const keyProvider = key.split('::')[0] as ProviderType;
        if (importedProviders.has(keyProvider) && !liveSet.has(keyProvider)) {
          next[key] = val;
        }
      }
      return next;
    });

    // ── Manual Estimator short-circuit (no API call) ───────────────────────
    if (selectedProviders.includes('estimator')) {
      const out = calcEstimator(estimatorAnswers);
      const estimatorFindings: FindingRow[] = [];
      if (out.ddiObjects > 0) estimatorFindings.push({
        provider: 'estimator', source: 'Manual Estimator', region: '',
        category: 'DDI Object', item: 'Estimated DDI Objects', count: out.ddiObjects,
        tokensPerUnit: TOKEN_RATES['DDI Object'], managementTokens: Math.ceil(out.ddiObjects / TOKEN_RATES['DDI Object']),
      });
      if (out.activeIPs > 0) estimatorFindings.push({
        provider: 'estimator', source: 'Manual Estimator', region: '',
        category: 'Active IP', item: 'Estimated Active IPs', count: out.activeIPs,
        tokensPerUnit: TOKEN_RATES['Active IP'], managementTokens: Math.ceil(out.activeIPs / TOKEN_RATES['Active IP']),
      });
      if (out.discoveredAssets > 0) estimatorFindings.push({
        provider: 'estimator', source: 'Manual Estimator', region: '',
        category: 'Asset', item: 'Estimated Assets', count: out.discoveredAssets,
        tokensPerUnit: TOKEN_RATES['Asset'], managementTokens: Math.ceil(out.discoveredAssets / TOKEN_RATES['Asset']),
      });
      setFindings(mergeFindings(findings, importedProviders, estimatorFindings, ['estimator']));
      setLiveScannedProviders(new Set<ProviderType>(['estimator']));
      setEstimatorMonthlyLogVolume(out.monthlyLogVolume);
      setEstimatorServerTokens(out.serverTokens);
      setEstimatorServerDetails(out.serverTokenDetails);
      setScanProgress(100);
      setProviderScanProgress(prev => ({ ...prev, estimator: 100 }));
      return;
    }

    if (backend.isDemo) {
      // Demo mode: simulate parallel scanning with mock data
      const providerProgress: Record<string, number> = {};
      const providerDone: Record<string, boolean> = {};
      const providerFindings: Record<string, FindingRow[]> = {};
      selectedProviders.forEach((p) => {
        providerProgress[p] = 0;
        providerDone[p] = false;
      });

      selectedProviders.forEach((provId) => {
        const tickMs = 250 + Math.random() * 250;
        const interval = setInterval(() => {
          providerProgress[provId] += Math.random() * 18 + 7;
          if (providerProgress[provId] >= 100) {
            providerProgress[provId] = 100;
            providerDone[provId] = true;
            clearInterval(interval);
            providerFindings[provId] = generateMockFindings([provId as ProviderType]);
          }

          setProviderScanProgress((prev) => ({
            ...prev,
            [provId]: Math.min(100, Math.round(providerProgress[provId])),
          }));

          const avg = selectedProviders.reduce((s, p) => s + (providerProgress[p] ?? 0), 0) / selectedProviders.length;
          setScanProgress(Math.min(100, Math.round(avg)));

          if (selectedProviders.every((p) => providerDone[p])) {
            const merged: FindingRow[] = [];
            selectedProviders.forEach((p) => {
              if (providerFindings[p]) merged.push(...providerFindings[p]);
            });
            setFindings(mergeFindings(findings, importedProviders, merged, selectedProviders));
            setLiveScannedProviders(new Set(selectedProviders));
            setScanProgress(100);
          }
        }, tickMs);
        scanIntervalsRef.current.push(interval);
      });
      return;
    }

    // Real API: start scan then poll status
    (async () => {
      try {
        const sessionId = getSessionId();
        const scanReq = {
          sessionId,
          providers: selectedProviders.map((provId) => {
            const backendId = BACKEND_PROVIDER_ID[provId];
            const entry: {
              provider: string;
              subscriptions: string[];
              selectionMode: 'include' | 'exclude';
              backupToken?: string;
              qpsToken?: string;
              selectedMembers?: string[];
              mode?: 'backup' | 'wapi';
              maxWorkers?: number;
              adForestSubscriptions?: { forestIndex: number; subscriptions: string[] }[];
            } = {
              provider: backendId,
              subscriptions: Array.from(getEffectiveSelected(provId)),
              selectionMode: selectionMode[provId],
            };
            // Max workers concurrency control
            const mw = advancedOptions[provId]?.maxWorkers;
            if (mw && mw > 0) {
              entry.maxWorkers = mw;
            }
            // AD multi-forest: attach per-forest subscriptions so backend can route correctly
            if (provId === 'microsoft' && adForests.length > 0) {
              const forestSubs: { forestIndex: number; subscriptions: string[] }[] = [
                { forestIndex: 0, subscriptions: Array.from(getEffectiveSelected(provId)) },
                ...adForests.map((f, i) => ({
                  forestIndex: i + 1,
                  subscriptions: f.subscriptions.filter((s) => s.selected).map((s) => s.id),
                })),
              ];
              entry.adForestSubscriptions = forestSubs;
            }
            // NIOS-specific fields
            if (provId === 'nios') {
              entry.mode = niosMode;
              if (niosMode === 'backup') {
                entry.backupToken = backupToken;
              }
              if (qpsToken) {
                entry.qpsToken = qpsToken;
              }
              // Extract hostnames from subscription names (format: "hostname (role)")
              entry.selectedMembers = (subscriptions.nios || [])
                .filter((s) => s.selected)
                .map((s) => s.name.replace(/\s*\(.*\)$/, ''));
            }
            // EfficientIP-specific fields
            if (provId === 'efficientip' && efficientipMode === 'backup') {
              entry.mode = 'backup';
              entry.backupToken = efficientipBackupToken;
            }
            return entry;
          }),
        };
        const { scanId } = await apiStartScan(scanReq);
        setBackendScanId(scanId);

        // Poll scan status
        const pollInterval = setInterval(async () => {
          try {
            const status: ScanStatusResponse = await apiGetScanStatus(scanId);
            setScanProgress(status.progress);
            status.providers.forEach((ps) => {
              setProviderScanProgress((prev) => ({
                ...prev,
                [toFrontendProvider(ps.provider)]: ps.progress,
              }));
            });

            if (status.status === 'complete') {
              clearInterval(pollInterval);
              const results = await apiGetScanResults(scanId);
              const mapped: FindingRow[] = results.findings.map((f) => ({
                provider: toFrontendProvider(f.provider),
                source: f.source,
                region: f.region,
                category: toFrontendCategory(f.category),
                item: f.item,
                count: f.count,
                tokensPerUnit: f.tokensPerUnit,
                managementTokens: f.managementTokens,
              }));
              setFindings(mergeFindings(findings, importedProviders, mapped, selectedProviders));
              setLiveScannedProviders(new Set(selectedProviders));
              setScanProgress(100);
              // Store backend-computed aggregate tokens (authoritative source)
              setBackendTokenAggregates({
                ddiTokens: results.ddiTokens ?? 0,
                ipTokens: results.ipTokens ?? 0,
                assetTokens: results.assetTokens ?? 0,
              });
              // Store NIOS server metrics from live scan results
              if (results.niosServerMetrics && results.niosServerMetrics.length > 0) {
                setNiosServerMetrics(results.niosServerMetrics.map((m) => ({
                  memberId: m.memberId,
                  memberName: m.memberName,
                  role: m.role as NiosServerMetrics['role'],
                  qps: m.qps,
                  lps: m.lps,
                  objectCount: m.objectCount,
                  activeIPCount: m.activeIPCount ?? 0,
                  model: m.model ?? '',
                  platform: m.platform ?? '',
                  managedIPCount: m.managedIPCount ?? 0,
                  staticHosts: m.staticHosts ?? 0,
                  dynamicHosts: m.dynamicHosts ?? 0,
                  dhcpUtilization: m.dhcpUtilization ?? 0,
                  licenses: m.licenses ?? {},
                })));
              }
              if (results.niosGridFeatures) {
                setNiosGridFeatures(results.niosGridFeatures);
              }
              if (results.niosGridLicenses) {
                setNiosGridLicenses(results.niosGridLicenses);
              }
              if (results.niosMigrationFlags) {
                setNiosMigrationFlags(results.niosMigrationFlags);
              }
              // Store AD server metrics from live scan results
              if (results.adServerMetrics && results.adServerMetrics.length > 0) {
                setAdServerMetrics(results.adServerMetrics);
              }
            }
          } catch {
            clearInterval(pollInterval);
            setScanError('Lost connection to backend during scan.');
          }
        }, 1500);
        scanIntervalsRef.current.push(pollInterval);
      } catch (err: any) {
        setScanError(err?.message || 'Failed to start scan');
      }
    })();
  }, [backend.isDemo, selectedProviders, selectedAuthMethod, credentials, selectionMode, clearScanIntervals, getEffectiveSelected, backupToken, subscriptions, findings, importedProviders]);

  // ── Manual count overrides ─────────────────────────────────────────────────
  // Build a unique key for each finding row to identify it in the overrides map.
  const findingKey = useCallback((f: FindingRow) => `${f.provider}::${f.source}::${f.item}`, []);

  // effectiveFindings applies count overrides and recalculates managementTokens.
  const effectiveFindings = useMemo(() => {
    if (Object.keys(countOverrides).length === 0) return findings;
    return findings.map((f) => {
      const key = findingKey(f);
      if (key in countOverrides) {
        const newCount = countOverrides[key];
        const newTokens = f.tokensPerUnit > 0 ? Math.ceil(newCount / f.tokensPerUnit) : 0;
        return { ...f, count: newCount, managementTokens: newTokens };
      }
      return f;
    });
  }, [findings, countOverrides, findingKey]);

  // Export
  const rawTotalTokens = useMemo(
    () => effectiveFindings.reduce((sum, f) => sum + f.managementTokens, 0),
    [effectiveFindings]
  );

  // UDDI per-row total: recalculates every row at UDDI rates (25/13/3)
  const uddiPerRowTotal = useMemo(
    () => effectiveFindings.reduce((sum, f) => sum + Math.ceil(f.count / TOKEN_RATES[f.category as TokenCategory]), 0),
    [effectiveFindings]
  );

  const totalTokens = useMemo(() => {
    // Backend is the authoritative source for aggregate token calculations.
    // Only recalculate from effectiveFindings when count overrides are active,
    // using aggregate-then-divide (sum counts first, single ceiling division
    // per category+rate group) to avoid rounding inflation.
    const hasOverrides = Object.keys(countOverrides).length > 0;

    let raw: number;
    if (!hasOverrides && backendTokenAggregates) {
      // Primary path: use backend-computed aggregate values directly
      raw = backendTokenAggregates.ddiTokens + backendTokenAggregates.ipTokens + backendTokenAggregates.assetTokens;
    } else {
      // Fallback path: aggregate-then-divide on effectiveFindings (for count overrides)
      const groups: Record<string, Record<number, number>> = {};
      effectiveFindings.forEach((f) => {
        if (!groups[f.category]) groups[f.category] = {};
        const rate = f.tokensPerUnit || 1;
        groups[f.category][rate] = (groups[f.category][rate] || 0) + f.count;
      });
      raw = 0;
      for (const cat of Object.values(groups)) {
        for (const [rate, count] of Object.entries(cat)) {
          raw += Math.ceil(count / Number(rate));
        }
      }
    }
    return Math.ceil(raw * (1 + growthBufferPct));
  }, [effectiveFindings, growthBufferPct, countOverrides, backendTokenAggregates]);

  // Ecosystem event count syncs to 40% of monthly log volume unless user has manually overridden it
  useEffect(() => {
    if (!ecosystemManualOverride.current) {
      const ecosystemDest = REPORTING_DESTINATIONS.find(d => d.id === 'ecosystem');
      if (ecosystemDest) {
        const liveVol = calcEstimator(estimatorAnswers).monthlyLogVolume;
        setReportingDestEvents(prev => ({
          ...prev,
          [ecosystemDest.id]: Math.round(liveVol * 0.4),
        }));
      }
    }
  }, [estimatorAnswers]);

  // Reporting tokens: per-destination totals via calcReportingTokens.
  // Uses liveLogVolume (computed directly from estimatorAnswers) so the destinations
  // table and BOM pack count update in real time as the user changes inputs, without
  // waiting for the scan step to set estimatorMonthlyLogVolume.
  const liveLogVolume = useMemo(() => calcEstimator(estimatorAnswers).monthlyLogVolume, [estimatorAnswers]);

  const reportingBreakdown = useMemo((): ReportingDestinationResult[] => {
    if (liveLogVolume <= 0) return [];
    const inputs: ReportingDestinationInput[] = REPORTING_DESTINATIONS.map(d => ({
      destinationId: d.id,
      events: reportingDestEvents[d.id] ?? 0,
      enabled: reportingDestEnabled[d.id] ?? true,
    }));
    return calcReportingTokens(inputs, growthBufferPct).breakdown;
  }, [liveLogVolume, reportingDestEnabled, reportingDestEvents, growthBufferPct]);

  const reportingTokens = useMemo(() => {
    if (liveLogVolume <= 0) return 0;
    const inputs: ReportingDestinationInput[] = REPORTING_DESTINATIONS.map(d => ({
      destinationId: d.id,
      events: reportingDestEvents[d.id] ?? 0,
      enabled: reportingDestEnabled[d.id] ?? true,
    }));
    return calcReportingTokens(inputs, growthBufferPct).total;
  }, [liveLogVolume, reportingDestEnabled, reportingDestEvents, growthBufferPct]);

  // Validation warnings for the Manual Sizing Estimator (non-blocking advisory).
  // Gated on 'estimator' being an active provider to avoid unnecessary computation.
  // An empty array means no banner is shown in the UI.
  const estimatorWarnings = useMemo(
    () =>
      selectedProviders.includes('estimator')
        ? computeEstimatorWarnings(estimatorAnswers, growthBufferPct)
        : [],
    [estimatorAnswers, growthBufferPct, selectedProviders],
  );

  // Category subtotals for summary
  const categoryTotals = useMemo(() => {
    const hasOverrides = Object.keys(countOverrides).length > 0;

    if (!hasOverrides && backendTokenAggregates) {
      // Primary path: use backend-computed category aggregates directly
      return {
        'DDI Object': backendTokenAggregates.ddiTokens,
        'Active IP': backendTokenAggregates.ipTokens,
        'Asset': backendTokenAggregates.assetTokens,
      };
    }

    // Fallback path: aggregate-then-divide per category (for count overrides)
    const totals: Record<string, number> = { 'DDI Object': 0, 'Active IP': 0, 'Asset': 0 };
    const groups: Record<string, Record<number, number>> = {};
    effectiveFindings.forEach((f) => {
      if (!groups[f.category]) groups[f.category] = {};
      const rate = f.tokensPerUnit || 1;
      groups[f.category][rate] = (groups[f.category][rate] || 0) + f.count;
    });
    for (const [cat, rates] of Object.entries(groups)) {
      totals[cat] = 0;
      for (const [rate, count] of Object.entries(rates)) {
        totals[cat] += Math.ceil(count / Number(rate));
      }
    }
    return totals;
  }, [effectiveFindings, countOverrides, backendTokenAggregates]);

  // Migration-map-aware server token count for SKU widget and exports.
  // When a migration map is set, computes XaaS-consolidated tokens for XaaS DCs
  // and NIOS-X tier tokens for NIOS-X DCs. Falls back to raw serverTokens when
  // no migration selections have been made (full-environment baseline).
  const totalServerTokens = useMemo(() => {
    const niosTokens = selectedProviders.includes('nios')
      ? effectiveNiosMetrics.filter(m => !isInfraOnlyMember(m)).reduce((s, m) => {
          const eff = applyServerOverrides(m, serverMetricOverrides);
          return s + calcServerTokenTier(eff.qps, eff.lps, eff.objects, 'nios-x').serverTokens;
        }, 0)
      : 0;

    let adTokens = 0;
    if (selectedProviders.includes('microsoft') && effectiveADMetrics.length > 0) {
      if (adMigrationMap.size > 0) {
        // Use the same logic as the AD Server Token Calculator panel:
        // split selected DCs by form factor, consolidate XaaS instances.
        const selectedDcs = effectiveADMetrics.filter(m => adMigrationMap.has(m.hostname));
        const niosXDcs = selectedDcs.filter(m => adMigrationMap.get(m.hostname) !== 'nios-xaas');
        const xaasDcs  = selectedDcs.filter(m => adMigrationMap.get(m.hostname) === 'nios-xaas');
        const niosXTokens = niosXDcs.reduce((s, m) => {
          const eff = applyADServerOverrides(m, serverMetricOverrides);
          return s + calcServerTokenTier(eff.qps, eff.lps, eff.objects, 'nios-x').serverTokens;
        }, 0);
        const xaasInstances = consolidateXaasInstances(xaasDcs.map(m => {
          const eff = applyADServerOverrides(m, serverMetricOverrides);
          return {
            memberId: m.hostname, memberName: m.hostname, role: 'DC',
            qps: eff.qps, lps: eff.lps, objectCount: eff.objects, activeIPCount: 0,
            managedIPCount: 0, staticHosts: 0, dynamicHosts: 0, dhcpUtilization: 0, licenses: {},
          };
        }));
        const xaasTokens = xaasInstances.reduce((s, inst) => s + inst.totalTokens, 0);
        adTokens = niosXTokens + xaasTokens;
      } else {
        // No migration selections yet — show full-environment baseline.
        adTokens = effectiveADMetrics.reduce((s, m) => {
          const eff = applyADServerOverrides(m, serverMetricOverrides);
          return s + calcServerTokenTier(eff.qps, eff.lps, eff.objects, 'nios-x').serverTokens;
        }, 0);
      }
    }

    const raw = niosTokens + adTokens + estimatorServerTokens;
    return Math.ceil(raw * (1 + serverGrowthBufferPct));
  }, [effectiveNiosMetrics, effectiveADMetrics, adMigrationMap, selectedProviders, estimatorServerTokens, serverGrowthBufferPct, serverMetricOverrides]);

  const hasServerMetrics = (selectedProviders.includes('nios') && effectiveNiosMetrics.length > 0)
    || (selectedProviders.includes('microsoft') && effectiveADMetrics.length > 0)
    || estimatorServerTokens > 0;

  // Hybrid-scenario totals — only meaningful when a migration map has selections.
  // Uses the same logic as the Migration Planner scenario cards.
  const hybridScenario = useMemo(() => {
    const hasNiosSelections = selectedProviders.includes('nios') && niosMigrationMap.size > 0;
    const hasAdSelections   = selectedProviders.includes('microsoft') && adMigrationMap.size > 0;
    if (!hasNiosSelections && !hasAdSelections) return null;

    // ── Management tokens (aggregate-then-divide to match hero card) ─────
    let hybridMgmt = 0;   // UDDI portion (growth buffer applies)
    let stayingMgmt = 0;  // NIOS licensing portion for non-migrating members (no growth buffer)
    // Non-NIOS findings always count at full management token value
    hybridMgmt += calcUddiTokensAggregated(effectiveFindings.filter(f => f.provider !== 'nios'));
    if (hasNiosSelections) {
      const nf = effectiveFindings.filter(f => f.provider === 'nios');
      // Migrating members → UDDI native rates (25/13/3), aggregate-then-divide
      hybridMgmt += calcUddiTokensAggregated(nf.filter(f => niosMigrationMap.has(f.source)));
      // Staying members → NIOS licensing tokens (separate from UDDI, no growth buffer)
      stayingMgmt = calcNiosTokens(nf.filter(f => !niosMigrationMap.has(f.source)));
    } else if (selectedProviders.includes('nios')) {
      // No NIOS selections → treat all NIOS as migrated (full universal DDI baseline at native rates)
      hybridMgmt += calcUddiTokensAggregated(effectiveFindings.filter(f => f.provider === 'nios'));
    }

    // ── Server tokens ──────────────────────────────────────────────────────
    let hybridSrv = 0;
    if (hasNiosSelections) {
      // Exclude infra-only GM/GMC from server token calculations (replaced by UDDI Portal)
      const selected = effectiveNiosMetrics.filter(m => niosMigrationMap.has(m.memberName) && !isInfraOnlyMember(m));
      const niosX = selected.filter(m => niosMigrationMap.get(m.memberName) !== 'nios-xaas');
      const xaas  = selected.filter(m => niosMigrationMap.get(m.memberName) === 'nios-xaas');
      hybridSrv += niosX.reduce((s, m) => {
        const eff = applyServerOverrides(m, serverMetricOverrides);
        return s + calcServerTokenTier(eff.qps, eff.lps, eff.objects, 'nios-x').serverTokens;
      }, 0);
      const xaasInst = consolidateXaasInstances(xaas.map(m => {
        const eff = applyServerOverrides(m, serverMetricOverrides);
        return {
          memberId: m.memberName, memberName: m.memberName, role: 'GM',
          qps: eff.qps, lps: eff.lps, objectCount: eff.objects, activeIPCount: 0,
          managedIPCount: 0, staticHosts: 0, dynamicHosts: 0, dhcpUtilization: 0, licenses: {},
        };
      }));
      hybridSrv += xaasInst.reduce((s, inst) => s + inst.totalTokens, 0);
    }
    if (hasAdSelections) {
      const selectedDcs = effectiveADMetrics.filter(m => adMigrationMap.has(m.hostname));
      const niosXDcs = selectedDcs.filter(m => adMigrationMap.get(m.hostname) !== 'nios-xaas');
      const xaasDcs  = selectedDcs.filter(m => adMigrationMap.get(m.hostname) === 'nios-xaas');
      hybridSrv += niosXDcs.reduce((s, m) => {
        const eff = applyADServerOverrides(m, serverMetricOverrides);
        return s + calcServerTokenTier(eff.qps, eff.lps, eff.objects, 'nios-x').serverTokens;
      }, 0);
      const xaasInst = consolidateXaasInstances(xaasDcs.map(m => {
        const eff = applyADServerOverrides(m, serverMetricOverrides);
        return {
          memberId: m.hostname, memberName: m.hostname, role: 'DC',
          qps: eff.qps, lps: eff.lps, objectCount: eff.objects, activeIPCount: 0,
          managedIPCount: 0, staticHosts: 0, dynamicHosts: 0, dhcpUtilization: 0, licenses: {},
        };
      }));
      hybridSrv += xaasInst.reduce((s, inst) => s + inst.totalTokens, 0);
    }

    const selectionCount = niosMigrationMap.size + adMigrationMap.size;
    // Growth buffer applies to UDDI portion only; NIOS staying tokens are added separately
    // (matches scenario card: applyGrowth(nonNios + migrating) + stayingTokens)
    return { mgmt: Math.ceil(hybridMgmt * (1 + growthBufferPct)) + stayingMgmt, srv: Math.ceil(hybridSrv * (1 + serverGrowthBufferPct)), selectionCount };
  }, [effectiveFindings, effectiveNiosMetrics, effectiveADMetrics, niosMigrationMap, adMigrationMap, selectedProviders, growthBufferPct, serverGrowthBufferPct, serverMetricOverrides]);

  // Filtered + sorted findings for the table
  const filteredSortedFindings = useMemo(() => {
    let rows = effectiveFindings;
    // Filter by provider
    if (findingsProviderFilter.size > 0) {
      rows = rows.filter((f) => findingsProviderFilter.has(f.provider));
    }
    // Filter by category
    if (findingsCategoryFilter.size > 0) {
      rows = rows.filter((f) => findingsCategoryFilter.has(f.category));
    }
    // Sort
    if (findingsSort) {
      const { col, dir } = findingsSort;
      const mult = dir === 'asc' ? 1 : -1;
      rows = [...rows].sort((a, b) => {
        let va: string | number;
        let vb: string | number;
        switch (col) {
          case 'provider':
            va = PROVIDERS.find((p) => p.id === a.provider)?.name ?? a.provider;
            vb = PROVIDERS.find((p) => p.id === b.provider)?.name ?? b.provider;
            break;
          case 'source': va = a.source; vb = b.source; break;
          case 'category': va = a.category; vb = b.category; break;
          case 'item': va = a.item; vb = b.item; break;
          case 'count': va = a.count; vb = b.count; break;
          case 'managementTokens': va = a.managementTokens; vb = b.managementTokens; break;
          case 'uddiTokens':
            va = Math.ceil(a.count / TOKEN_RATES[a.category as TokenCategory]);
            vb = Math.ceil(b.count / TOKEN_RATES[b.category as TokenCategory]);
            break;
          default: return 0;
        }
        if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * mult;
        return String(va).localeCompare(String(vb)) * mult;
      });
    }
    return rows;
  }, [effectiveFindings, findingsProviderFilter, findingsCategoryFilter, findingsSort]);

  const filteredTokenTotal = useMemo(
    () => filteredSortedFindings.reduce((sum, f) => sum + f.managementTokens, 0),
    [filteredSortedFindings]
  );

  const toggleFindingsSort = (col: SortColumn) => {
    setFindingsSort((prev) => {
      if (prev?.col === col) {
        if (prev.dir === 'asc') return { col, dir: 'desc' };
        return null; // third click clears sort
      }
      return { col, dir: 'asc' };
    });
  };

  const toggleProviderFilter = (provId: ProviderType) => {
    setFindingsProviderFilter((prev) => {
      const next = new Set(prev);
      if (next.has(provId)) next.delete(provId); else next.add(provId);
      return next;
    });
  };

  const toggleCategoryFilter = (cat: TokenCategory) => {
    setFindingsCategoryFilter((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat); else next.add(cat);
      return next;
    });
  };

  const exportCSV = () => {
    const header = 'Provider,Source,Token Category,Item,Count,Tokens/Unit,Management Tokens';
    const rows = effectiveFindings.map(
      (f) =>
        `${PROVIDERS.find((p) => p.id === f.provider)?.name},${f.source},${f.category},${formatItemLabel(f.item)},${f.count},${f.tokensPerUnit},${f.managementTokens}`
    );
    let summary = `\n\nTotal Management Tokens,,,,,,${totalTokens}`;
    if (selectedProviders.includes('nios') && niosMigrationMap.size > 0) {
      const nf = effectiveFindings.filter((f) => f.provider === 'nios');
      const nonNios = calcUddiTokensAggregated(effectiveFindings.filter((f) => f.provider !== 'nios'));
      const allNios = calcNiosTokens(nf);
      const migrating = calcUddiTokensAggregated(nf.filter((f) => niosMigrationMap.has(f.source)));
      const stayingNios = calcNiosTokens(nf.filter((f) => !niosMigrationMap.has(f.source)));
      const allNiosUddi = calcUddiTokensAggregated(nf);
      const csvGrowth = (v: number) => Math.ceil(v * (1 + growthBufferPct));
      summary += `\n\nNIOS-X Migration Planner`;
      summary += `\nScenario,UDDI Tokens,NIOS Licensing Tokens`;
      summary += `\nCurrent (NIOS Only),${csvGrowth(nonNios)},${allNios}`;
      summary += `\nHybrid (${niosMigrationMap.size} members migrated),${csvGrowth(nonNios + migrating)},${stayingNios}`;
      summary += `\nFull Universal DDI,${csvGrowth(nonNios + allNiosUddi)},0`;
      summary += `\n\nMembers migrated:`;
      niosMigrationMap.forEach((ff, src) => { summary += `\n,${src},${ff === 'nios-xaas' ? 'XaaS' : 'NIOS-X'}`; });
    }
    if (selectedProviders.includes('nios')) {
      const niosSources = new Set(effectiveFindings.filter((f) => f.provider === 'nios').map((f) => f.source));
      // Exclude infrastructure-only GM/GMC from server token exports — they're replaced by UDDI Portal
      const metricsToExport = (niosMigrationMap.size > 0
        ? effectiveNiosMetrics.filter((m) => niosMigrationMap.has(m.memberName))
        : effectiveNiosMetrics.filter((m) => niosSources.has(m.memberName))
      ).filter(m => !isInfraOnlyMember(m));
      if (metricsToExport.length > 0) {
        const niosXMetrics = metricsToExport.filter((m) => (niosMigrationMap.get(m.memberName) || 'nios-x') === 'nios-x');
        const xaasMetrics = metricsToExport.filter((m) => niosMigrationMap.get(m.memberName) === 'nios-xaas');
        const xaasInst = consolidateXaasInstances(xaasMetrics.map(m => {
          const eff = applyServerOverrides(m, serverMetricOverrides);
          return eff.qps !== m.qps || eff.lps !== m.lps || eff.objects !== serverSizingObjects(m)
            ? { ...m, qps: eff.qps, lps: eff.lps, objectCount: eff.objects, activeIPCount: 0 }
            : m;
        }));
        const hasAnyXaas = xaasMetrics.length > 0;
        summary += `\n\nServer Token Calculator`;
        summary += `\nGrid Member,Role,Form Factor,QPS (Peak),LPS (Peak),Objects,Connections,Server Size,Allocated Tokens`;
        // NIOS-X individual members
        niosXMetrics.forEach((m) => {
          const eff = applyServerOverrides(m, serverMetricOverrides);
          const tier = calcServerTokenTier(eff.qps, eff.lps, eff.objects, 'nios-x');
          summary += `\n${m.memberName},${m.role},NIOS-X,${eff.qps},${eff.lps},${eff.objects},—,${tier.name},${tier.serverTokens}`;
        });
        // XaaS consolidated instances
        xaasInst.forEach((inst) => {
          summary += `\n--- XaaS Instance ${xaasInst.length > 1 ? inst.index + 1 : ''} (replaces ${inst.connectionsUsed} NIOS members) ---`;
          inst.members.forEach((m) => {
            const eff = applyServerOverrides(m, serverMetricOverrides);
            summary += `\n  ${m.memberName},${m.role},XaaS (1 conn),${eff.qps},${eff.lps},${eff.objects},,,(consolidated)`;
          });
          summary += `\n  AGGREGATE,,XaaS,${inst.totalQps},${inst.totalLps},${inst.totalObjects},${inst.connectionsUsed}/${inst.tier.maxConnections} conn,${inst.tier.name},${inst.totalTokens}`;
          if (inst.extraConnections > 0) {
            summary += ` (incl. ${inst.extraConnectionTokens} extra connection tokens)`;
          }
        });
        const niosXTokens = niosXMetrics.reduce((s, m) => {
          const eff = applyServerOverrides(m, serverMetricOverrides);
          return s + calcServerTokenTier(eff.qps, eff.lps, eff.objects, 'nios-x').serverTokens;
        }, 0);
        const xaasTokens = xaasInst.reduce((s, inst) => s + inst.totalTokens, 0);
        const totalST = niosXTokens + xaasTokens;
        summary += `\nTotal Allocated Server Tokens,,,,,,,,${totalST}`;
        if (hasAnyXaas) {
          summary += `\nConsolidation: ${xaasMetrics.length} NIOS members → ${xaasInst.length} XaaS instance${xaasInst.length > 1 ? 's' : ''} (${xaasMetrics.length}:${xaasInst.length} ratio)`;
        }
      }
    }
    // AD Server Token Calculator CSV section
    if (selectedProviders.includes('microsoft') && effectiveADMetrics.length > 0) {
      const toNiosMetrics = (m: ADServerMetricAPI): NiosServerMetrics => {
        const eff = applyADServerOverrides(m, serverMetricOverrides);
        return {
          memberId: m.hostname, memberName: m.hostname, role: 'DC',
          qps: eff.qps, lps: eff.lps, objectCount: eff.objects, activeIPCount: 0,
          managedIPCount: 0, staticHosts: 0, dynamicHosts: 0, dhcpUtilization: 0, licenses: {},
        };
      };
      const metricsToExport = adMigrationMap.size > 0
        ? effectiveADMetrics.filter(m => adMigrationMap.has(m.hostname))
        : effectiveADMetrics;
      if (metricsToExport.length > 0) {
        const niosXDcs = metricsToExport.filter(m => (adMigrationMap.get(m.hostname) || 'nios-x') === 'nios-x');
        const xaasDcs = metricsToExport.filter(m => adMigrationMap.get(m.hostname) === 'nios-xaas');
        const xaasInst = consolidateXaasInstances(xaasDcs.map(toNiosMetrics));
        const hasAnyXaas = xaasDcs.length > 0;
        summary += `\n\nAD Server Token Calculator`;
        summary += `\nHostname,Role,Form Factor,QPS (Peak),LPS (Peak),Objects,Connections,Server Size,Allocated Tokens`;
        niosXDcs.forEach(m => {
          const eff = applyADServerOverrides(m, serverMetricOverrides);
          const tier = calcServerTokenTier(eff.qps, eff.lps, eff.objects, 'nios-x');
          summary += `\n${m.hostname},DC,NIOS-X,${eff.qps},${eff.lps},${eff.objects},—,${tier.name},${tier.serverTokens}`;
        });
        xaasInst.forEach(inst => {
          summary += `\n--- XaaS Instance ${xaasInst.length > 1 ? inst.index + 1 : ''} (replaces ${inst.connectionsUsed} DCs) ---`;
          inst.members.forEach(mem => {
            summary += `\n  ${mem.memberName},DC,XaaS (1 conn),${mem.qps},${mem.lps},${mem.objectCount},,,(consolidated)`;
          });
          summary += `\n  AGGREGATE,,XaaS,${inst.totalQps},${inst.totalLps},${inst.totalObjects},${inst.connectionsUsed}/${inst.tier.maxConnections} conn,${inst.tier.name},${inst.totalTokens}`;
          if (inst.extraConnections > 0) {
            summary += ` (incl. ${inst.extraConnectionTokens} extra connection tokens)`;
          }
        });
        const adNiosXTokens = niosXDcs.reduce((s, m) => {
          const eff = applyADServerOverrides(m, serverMetricOverrides);
          return s + calcServerTokenTier(eff.qps, eff.lps, eff.objects, 'nios-x').serverTokens;
        }, 0);
        const adXaasTokens = xaasInst.reduce((s, inst) => s + inst.totalTokens, 0);
        const adTotalST = adNiosXTokens + adXaasTokens;
        summary += `\nTotal AD Allocated Server Tokens,,,,,,,,${adTotalST}`;
        if (hasAnyXaas) {
          summary += `\nConsolidation: ${xaasDcs.length} DCs → ${xaasInst.length} XaaS instance${xaasInst.length > 1 ? 's' : ''} (${xaasDcs.length}:${xaasInst.length} ratio)`;
        }
      }
    }
    summary += `\n\nRecommended SKUs`;
    summary += `\nSKU Code,Description,Pack Count`;
    summary += `\nMgmt Growth Buffer,${Math.round(growthBufferPct * 100)}%`;
    if (hasServerMetrics) summary += `\nServer Growth Buffer,${Math.round(serverGrowthBufferPct * 100)}%`;
    summary += `\nIB-TOKENS-UDDI-MGMT-1000,Management Token Pack (1000 tokens),${Math.ceil(totalTokens / 1000)}`;
    if (hasServerMetrics) {
      summary += `\nIB-TOKENS-UDDI-SERV-500,Server Token Pack (500 tokens),${Math.ceil(totalServerTokens / 500)}`;
    }
    if (reportingTokens > 0) {
      summary += `\nIB-TOKENS-REPORTING-40,Reporting Token Pack (40 tokens),${Math.ceil(reportingTokens / 40)}`;
    }
    const csv = [header, ...rows].join('\n') + summary;
    downloadFile(csv, 'ddi-token-assessment.csv', 'text/csv');
  };

  // Shared helper for export functions: get the right metrics source
  const getExportMetrics = () => effectiveNiosMetrics;

  const exportExcel = () => {
    // Generate a simple HTML table that Excel can open
    let html = '<html><head><meta charset="UTF-8"></head><body>';
    html += '<h2>Infoblox Universal DDI - Management Token Assessment</h2>';
    html += `<p>Generated: ${new Date().toLocaleString()}</p>`;
    html += '<table border="1" cellpadding="4" cellspacing="0">';
    html += '<tr style="background:#002B49;color:white"><th>Provider</th><th>Source</th><th>Token Category</th><th>Item</th><th>Count</th><th>Tokens/Unit</th><th>Management Tokens</th></tr>';
    effectiveFindings.forEach((f) => {
      html += `<tr><td>${PROVIDERS.find((p) => p.id === f.provider)?.name}</td><td>${f.source}</td><td>${f.category}</td><td>${formatItemLabel(f.item)}</td><td>${f.count}</td><td>${f.tokensPerUnit}</td><td>${f.managementTokens}</td></tr>`;
    });
    html += `<tr style="background:#f5f5f5;font-weight:bold"><td colspan="6">Total Management Tokens</td><td>${totalTokens.toLocaleString()}</td></tr>`;
    html += '</table>';
    if (selectedProviders.includes('nios') && niosMigrationMap.size > 0) {
      const nf = effectiveFindings.filter((f) => f.provider === 'nios');
      const nonNios = calcUddiTokensAggregated(effectiveFindings.filter((f) => f.provider !== 'nios'));
      const allNios = calcNiosTokens(nf);
      const migrating = calcUddiTokensAggregated(nf.filter((f) => niosMigrationMap.has(f.source)));
      const allNiosUddi = calcUddiTokensAggregated(nf);
      const stayingNios = calcNiosTokens(nf.filter((f) => !niosMigrationMap.has(f.source)));
      const xlGrowth = (v: number) => Math.ceil(v * (1 + growthBufferPct));
      html += '<br/><h3>NIOS-X Migration Planner</h3>';
      html += '<table border="1" cellpadding="4" cellspacing="0">';
      html += '<tr style="background:#002B49;color:white"><th>Scenario</th><th>UDDI Tokens</th><th>NIOS Licensing</th></tr>';
      html += `<tr><td>Current (NIOS Only)</td><td>${xlGrowth(nonNios).toLocaleString()}</td><td>${allNios.toLocaleString()}</td></tr>`;
      html += `<tr style="background:#FFF3E0"><td>Hybrid (${niosMigrationMap.size} members migrated)</td><td><b>${xlGrowth(nonNios + migrating).toLocaleString()}</b></td><td>${stayingNios.toLocaleString()}</td></tr>`;
      html += `<tr><td>Full Universal DDI</td><td><b>${xlGrowth(nonNios + allNiosUddi).toLocaleString()}</b></td><td>0</td></tr>`;
      html += '</table>';
      html += '<br/><p><b>Members migrated:</b></p><ul>';
      niosMigrationMap.forEach((ff, src) => { html += `<li>${src} → ${ff === 'nios-xaas' ? 'NIOS-X as a Service' : 'NIOS-X'}</li>`; });
      html += '</ul>';
    }
    if (selectedProviders.includes('nios')) {
      const niosSources = new Set(effectiveFindings.filter((f) => f.provider === 'nios').map((f) => f.source));
      // Exclude infrastructure-only GM/GMC from server token exports — they're replaced by UDDI Portal
      const metricsToExport = (niosMigrationMap.size > 0
        ? effectiveNiosMetrics.filter((m) => niosMigrationMap.has(m.memberName))
        : effectiveNiosMetrics.filter((m) => niosSources.has(m.memberName))
      ).filter(m => !isInfraOnlyMember(m));
      if (metricsToExport.length > 0) {
        const niosXMetrics = metricsToExport.filter((m) => (niosMigrationMap.get(m.memberName) || 'nios-x') === 'nios-x');
        const xaasMetrics = metricsToExport.filter((m) => niosMigrationMap.get(m.memberName) === 'nios-xaas');
        const xaasInst = consolidateXaasInstances(xaasMetrics.map(m => {
          const eff = applyServerOverrides(m, serverMetricOverrides);
          return eff.qps !== m.qps || eff.lps !== m.lps || eff.objects !== serverSizingObjects(m)
            ? { ...m, qps: eff.qps, lps: eff.lps, objectCount: eff.objects, activeIPCount: 0 }
            : m;
        }));
        const hasAnyXaas = xaasMetrics.length > 0;
        html += `<br/><h3>Server Token Calculator</h3>`;
        html += '<table border="1" cellpadding="4" cellspacing="0">';
        html += `<tr style="background:#065f46;color:white"><th>Grid Member</th><th>Role</th><th>Form Factor</th><th>QPS (Peak)</th><th>LPS (Peak)</th><th>Objects</th><th>Size</th><th>Allocated Tokens</th></tr>`;
        // NIOS-X individual members
        niosXMetrics.forEach((m) => {
          const eff = applyServerOverrides(m, serverMetricOverrides);
          const tier = calcServerTokenTier(eff.qps, eff.lps, eff.objects, 'nios-x');
          html += `<tr><td>${m.memberName}</td><td>${m.role}</td><td>NIOS-X</td><td>${eff.qps.toLocaleString()}</td><td>${eff.lps.toLocaleString()}</td><td>${eff.objects.toLocaleString()}</td><td>${tier.name}</td><td style="text-align:center;font-weight:bold">${tier.serverTokens.toLocaleString()}</td></tr>`;
        });
        // XaaS consolidated instances
        xaasInst.forEach((inst) => {
          html += `<tr style="background:#f3e8ff"><td colspan="8" style="font-weight:bold;color:#6b21a8">XaaS Instance${xaasInst.length > 1 ? ' ' + (inst.index + 1) : ''} — replaces ${inst.connectionsUsed} NIOS member${inst.connectionsUsed > 1 ? 's' : ''}</td></tr>`;
          inst.members.forEach((m) => {
            const mEff = applyServerOverrides(m, serverMetricOverrides);
            html += `<tr style="background:#faf5ff"><td style="padding-left:20px">${m.memberName}</td><td>${m.role}</td><td style="color:#7c3aed">1 conn</td><td style="color:#7c3aed">${mEff.qps.toLocaleString()}</td><td style="color:#7c3aed">${mEff.lps.toLocaleString()}</td><td style="color:#7c3aed">${mEff.objects.toLocaleString()}</td><td colspan="2" style="text-align:center;color:#999">(consolidated)</td></tr>`;
          });
          html += `<tr style="background:#ede9fe"><td style="padding-left:20px;font-weight:600">Aggregate (${inst.connectionsUsed}/${inst.tier.maxConnections} connections${inst.extraConnections > 0 ? ', +' + inst.extraConnections + ' extra' : ''})</td><td style="font-weight:600">XaaS</td><td style="font-weight:600">${inst.connectionsUsed} conn</td><td style="font-weight:600">${inst.totalQps.toLocaleString()}</td><td style="font-weight:600">${inst.totalLps.toLocaleString()}</td><td style="font-weight:600">${inst.totalObjects.toLocaleString()}</td><td style="font-weight:600">${inst.tier.name}</td><td style="text-align:center;font-weight:bold;color:#6b21a8">${inst.totalTokens.toLocaleString()}${inst.extraConnectionTokens > 0 ? ' (incl. ' + inst.extraConnectionTokens.toLocaleString() + ' extra conn)' : ''}</td></tr>`;
        });
        const niosXTokens = niosXMetrics.reduce((s, m) => {
          const eff = applyServerOverrides(m, serverMetricOverrides);
          return s + calcServerTokenTier(eff.qps, eff.lps, eff.objects, 'nios-x').serverTokens;
        }, 0);
        const xaasTokens = xaasInst.reduce((s, inst) => s + inst.totalTokens, 0);
        const totalST = niosXTokens + xaasTokens;
        html += `<tr style="background:#ecfdf5;font-weight:bold"><td colspan="7">Total Allocated Server Tokens</td><td style="text-align:center">${totalST.toLocaleString()}</td></tr>`;
        html += '</table>';
        if (hasAnyXaas) {
          html += `<p><b>Consolidation:</b> ${xaasMetrics.length} NIOS member${xaasMetrics.length > 1 ? 's' : ''} \u2192 ${xaasInst.length} XaaS instance${xaasInst.length > 1 ? 's' : ''} (${xaasMetrics.length}:${xaasInst.length} ratio). Each connection replaces 1 NIOS member or branch office appliance.</p>`;
          html += '<p><i>Note: Up to 400 additional connections can be added per XaaS instance at 100 tokens each.</i></p>';
        }
      }
    }
    // AD Server Token Calculator HTML section
    if (selectedProviders.includes('microsoft') && effectiveADMetrics.length > 0) {
      const toNiosMetrics = (m: ADServerMetricAPI): NiosServerMetrics => {
        const eff = applyADServerOverrides(m, serverMetricOverrides);
        return {
          memberId: m.hostname, memberName: m.hostname, role: 'DC',
          qps: eff.qps, lps: eff.lps, objectCount: eff.objects, activeIPCount: 0,
          managedIPCount: 0, staticHosts: 0, dynamicHosts: 0, dhcpUtilization: 0, licenses: {},
        };
      };
      const metricsToExport = adMigrationMap.size > 0
        ? effectiveADMetrics.filter(m => adMigrationMap.has(m.hostname))
        : effectiveADMetrics;
      if (metricsToExport.length > 0) {
        const niosXDcs = metricsToExport.filter(m => (adMigrationMap.get(m.hostname) || 'nios-x') === 'nios-x');
        const xaasDcs = metricsToExport.filter(m => adMigrationMap.get(m.hostname) === 'nios-xaas');
        const xaasInst = consolidateXaasInstances(xaasDcs.map(toNiosMetrics));
        const hasAnyXaas = xaasDcs.length > 0;
        html += `<br/><h3>AD Server Token Calculator</h3>`;
        html += '<table border="1" cellpadding="4" cellspacing="0">';
        html += `<tr style="background:#1e40af;color:white"><th>Hostname</th><th>Role</th><th>Form Factor</th><th>QPS (Peak)</th><th>LPS (Peak)</th><th>Objects</th><th>Size</th><th>Allocated Tokens</th></tr>`;
        niosXDcs.forEach(m => {
          const eff = applyADServerOverrides(m, serverMetricOverrides);
          const tier = calcServerTokenTier(eff.qps, eff.lps, eff.objects, 'nios-x');
          html += `<tr><td>${m.hostname}</td><td>DC</td><td>NIOS-X</td><td>${eff.qps.toLocaleString()}</td><td>${eff.lps.toLocaleString()}</td><td>${eff.objects.toLocaleString()}</td><td>${tier.name}</td><td style="text-align:center;font-weight:bold">${tier.serverTokens.toLocaleString()}</td></tr>`;
        });
        xaasInst.forEach(inst => {
          html += `<tr style="background:#f3e8ff"><td colspan="8" style="font-weight:bold;color:#6b21a8">XaaS Instance${xaasInst.length > 1 ? ' ' + (inst.index + 1) : ''} — replaces ${inst.connectionsUsed} DC${inst.connectionsUsed > 1 ? 's' : ''}</td></tr>`;
          inst.members.forEach(mem => {
            html += `<tr style="background:#faf5ff"><td style="padding-left:20px">${mem.memberName}</td><td>DC</td><td style="color:#7c3aed">1 conn</td><td style="color:#7c3aed">${mem.qps.toLocaleString()}</td><td style="color:#7c3aed">${mem.lps.toLocaleString()}</td><td style="color:#7c3aed">${mem.objectCount.toLocaleString()}</td><td colspan="2" style="text-align:center;color:#999">(consolidated)</td></tr>`;
          });
          html += `<tr style="background:#ede9fe"><td style="padding-left:20px;font-weight:600">Aggregate (${inst.connectionsUsed}/${inst.tier.maxConnections} connections${inst.extraConnections > 0 ? ', +' + inst.extraConnections + ' extra' : ''})</td><td style="font-weight:600">XaaS</td><td style="font-weight:600">${inst.connectionsUsed} conn</td><td style="font-weight:600">${inst.totalQps.toLocaleString()}</td><td style="font-weight:600">${inst.totalLps.toLocaleString()}</td><td style="font-weight:600">${inst.totalObjects.toLocaleString()}</td><td style="font-weight:600">${inst.tier.name}</td><td style="text-align:center;font-weight:bold;color:#6b21a8">${inst.totalTokens.toLocaleString()}${inst.extraConnectionTokens > 0 ? ' (incl. ' + inst.extraConnectionTokens.toLocaleString() + ' extra conn)' : ''}</td></tr>`;
        });
        const adNiosXTokens = niosXDcs.reduce((s, m) => {
          const eff = applyADServerOverrides(m, serverMetricOverrides);
          return s + calcServerTokenTier(eff.qps, eff.lps, eff.objects, 'nios-x').serverTokens;
        }, 0);
        const adXaasTokens = xaasInst.reduce((s, inst) => s + inst.totalTokens, 0);
        const adTotalST = adNiosXTokens + adXaasTokens;
        html += `<tr style="background:#dbeafe;font-weight:bold"><td colspan="7">Total AD Allocated Server Tokens</td><td style="text-align:center">${adTotalST.toLocaleString()}</td></tr>`;
        html += '</table>';
        if (hasAnyXaas) {
          html += `<p><b>Consolidation:</b> ${xaasDcs.length} DC${xaasDcs.length > 1 ? 's' : ''} → ${xaasInst.length} XaaS instance${xaasInst.length > 1 ? 's' : ''} (${xaasDcs.length}:${xaasInst.length} ratio).</p>`;
        }
      }
    }
    html += '<h3 style="margin-top:20px">Recommended SKUs</h3>';
    html += `<p>Mgmt Growth Buffer: ${Math.round(growthBufferPct * 100)}%${hasServerMetrics ? ` | Server Growth Buffer: ${Math.round(serverGrowthBufferPct * 100)}%` : ''}</p>`;
    html += '<table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse">';
    html += '<tr style="background:#002B49;color:white;font-weight:bold"><td>SKU Code</td><td>Description</td><td>Pack Count</td></tr>';
    html += `<tr><td>IB-TOKENS-UDDI-MGMT-1000</td><td>Management Token Pack (1000 tokens)</td><td style="text-align:center;font-weight:bold">${Math.ceil(totalTokens / 1000).toLocaleString()}</td></tr>`;
    if (hasServerMetrics) {
      html += `<tr><td>IB-TOKENS-UDDI-SERV-500</td><td>Server Token Pack (500 tokens)</td><td style="text-align:center;font-weight:bold">${Math.ceil(totalServerTokens / 500).toLocaleString()}</td></tr>`;
    }
    if (reportingTokens > 0) {
      html += `<tr><td>IB-TOKENS-REPORTING-40</td><td>Reporting Token Pack (40 tokens)</td><td style="text-align:center;font-weight:bold">${Math.ceil(reportingTokens / 40).toLocaleString()}</td></tr>`;
    }
    html += '</table>';

    html += '</body></html>';
    downloadFile(html, 'ddi-token-assessment.xls', 'application/vnd.ms-excel');
  };

  // Download XLSX via the real backend exporter (RES-15). Falls back to the
  // legacy client-side HTML export when no backend scan ID is available
  // (demo mode, imported sessions). Sends the user's variant overrides so
  // the Resource Savings sheet reflects per-member appliance choices.
  const downloadXlsxFromBackend = async () => {
    if (!backendScanId) {
      exportExcel();
      return;
    }
    try {
      const overrides = Object.fromEntries(variantOverrides);
      const blob = await downloadExcelExport(backendScanId, overrides);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const date = new Date().toISOString().slice(0, 10);
      a.download = `ddi-token-assessment-${date}.xlsx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Backend export failed, falling back to client export:', err);
      exportExcel();
    }
  };

  const saveSession = () => {
    const date = new Date().toISOString().slice(0, 10);
    const json = exportSession(
      {
        selectedProviders,
        findings,
        countOverrides,
        niosMigrationMap,
        adMigrationMap,
        niosServerMetrics,
        adServerMetrics,
        estimatorAnswers,
        growthBufferPct,
        serverGrowthBufferPct,
        reportingDestEnabled,
        reportingDestEvents,
        serverMetricOverrides,
      },
      backend.health?.version ?? 'dev'
    );
    downloadFile(json, `ddi-session-${date}.json`, 'application/json');
  };

  const restoreSession = (snapshot: SessionSnapshot) => {
    restart();
    setSelectedProviders(snapshot.selectedProviders);
    setImportedProviders(new Set(snapshot.selectedProviders));
    setFindings(snapshot.findings);
    setCountOverrides(snapshot.countOverrides);
    setNiosMigrationMap(new Map(Object.entries(snapshot.niosMigrationMap)));
    setAdMigrationMap(new Map(Object.entries(snapshot.adMigrationMap)));
    setNiosServerMetrics(snapshot.niosServerMetrics.map((m) => ({
      ...m,
      model: m.model ?? '',
      platform: m.platform ?? '',
    })));
    setAdServerMetrics(snapshot.adServerMetrics);
    setEstimatorAnswers(snapshot.estimatorAnswers);
    setGrowthBufferPct(snapshot.growthBufferPct);
    setServerGrowthBufferPct(snapshot.serverGrowthBufferPct ?? 0.20);
    setReportingDestEnabled(snapshot.reportingDestEnabled);
    setReportingDestEvents(snapshot.reportingDestEvents);
    setServerMetricOverrides(snapshot.serverMetricOverrides ?? {});
    // Recompute derived estimator state so server tokens display correctly
    const out = calcEstimator(snapshot.estimatorAnswers);
    setEstimatorMonthlyLogVolume(out.monthlyLogVolume);
    setEstimatorServerTokens(out.serverTokens);
    setEstimatorServerDetails(out.serverTokenDetails);
    setCurrentStep('results');
  };

  const downloadFile = (content: string, filename: string, type: string) => {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <SizerProvider>
    <SizerDispatchBridge dispatchRef={sizerDispatchRef} />
    <div className="min-h-screen bg-[var(--background)] flex flex-col">
      {/* Header */}
      <header className="bg-[var(--infoblox-navy)] text-white">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            {/* Infoblox logo */}
            <img
              src={INFOBLOX_LOGO}
              alt="Infoblox"
              className="h-7 sm:h-8 shrink-0 object-contain"
            />
            <div className="h-6 w-px bg-white/25 hidden sm:block" />
            <div className="hidden sm:block">
              <div className="text-[12px] text-white/70 tracking-wider uppercase">
                Universal DDI Token Assessment
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {backend.isDemo ? (
              <div className="flex items-center gap-1.5 px-2.5 py-1 bg-amber-500/20 border border-amber-500/30 rounded-full text-[11px] text-amber-300">
                <WifiOff className="w-3 h-3" />
                <span className="hidden sm:inline">Demo Mode</span>
              </div>
            ) : (
              <div className="flex items-center gap-1.5 px-2.5 py-1 bg-green-500/20 border border-green-500/30 rounded-full text-[11px] text-green-300">
                <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                <span className="hidden sm:inline">Connected v{backend.health?.version?.replace(/^v/, '')}</span>
              </div>
            )}
            {backend.updateStatus === 'done' ? (
              <button
                onClick={backend.restartAfterUpdate}
                className="flex items-center gap-1.5 px-2.5 py-1 bg-green-500/20 border border-green-500/30 rounded-full text-[11px] text-green-300 hover:bg-green-500/30 transition-colors cursor-pointer"
              >
                <RotateCcw className="w-3 h-3" />
                <span className="hidden sm:inline">Restart Now</span>
              </button>
            ) : backend.updateStatus === 'restarting' ? (
              <div className="flex items-center gap-1.5 px-2.5 py-1 bg-blue-500/20 border border-blue-500/30 rounded-full text-[11px] text-blue-300">
                <Loader2 className="w-3 h-3 animate-spin" />
                <span className="hidden sm:inline">Restarting...</span>
              </div>
            ) : backend.updateStatus === 'error' ? (
              <div className="flex items-center gap-1.5 px-2.5 py-1 bg-red-500/20 border border-red-500/30 rounded-full text-[11px] text-red-300">
                <ArrowUpCircle className="w-3 h-3" />
                <span className="hidden sm:inline">{backend.updateError || 'Update failed'}</span>
              </div>
            ) : backend.updateInfo?.updateAvailable && backend.updateInfo?.dockerMode ? (
              <div
                role="button"
                tabIndex={0}
                onClick={() => {
                  navigator.clipboard.writeText('docker compose pull && docker compose up -d');
                  setDockerCopied(true);
                  setTimeout(() => setDockerCopied(false), 2000);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    navigator.clipboard.writeText('docker compose pull && docker compose up -d');
                    setDockerCopied(true);
                    setTimeout(() => setDockerCopied(false), 2000);
                  }
                }}
                className="flex items-center gap-1.5 px-2.5 py-1 bg-blue-500/20 border border-blue-500/30 rounded-full text-[11px] text-blue-300 hover:bg-blue-500/30 transition-colors cursor-pointer"
                title="Click to copy: docker compose pull && docker compose up -d"
              >
                <ArrowUpCircle className="w-3 h-3" />
                <span className="hidden sm:inline">{dockerCopied ? 'Copied!' : `${backend.updateInfo.latestVersion} available`}</span>
              </div>
            ) : backend.updateInfo?.updateAvailable ? (
              <button
                onClick={backend.applyUpdate}
                disabled={backend.updateStatus === 'updating'}
                className="flex items-center gap-1.5 px-2.5 py-1 bg-blue-500/20 border border-blue-500/30 rounded-full text-[11px] text-blue-300 hover:bg-blue-500/30 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-wait"
              >
                <ArrowUpCircle className="w-3 h-3" />
                <span className="hidden sm:inline">
                  {backend.updateStatus === 'updating' ? 'Updating...' : `Update to ${backend.updateInfo.latestVersion}`}
                </span>
              </button>
            ) : backend.updateInfo && !backend.updateInfo.updateAvailable ? (
              <div className="flex items-center gap-1.5 px-2.5 py-1 bg-green-500/10 border border-green-500/20 rounded-full text-[11px] text-green-400">
                <CheckCircle2 className="w-3 h-3" />
                <span className="hidden sm:inline">Up to date</span>
              </div>
            ) : null}
          </div>
        </div>
      </header>

      {/* Demo banner */}
      {backend.isDemo && (
        <div className="bg-amber-50 border-b border-amber-200 text-amber-800 text-center py-2 px-4 text-[12px] flex items-center justify-center gap-2">
          <Info className="w-3.5 h-3.5 shrink-0" />
          <span>
            Go backend not detected. Showing demo data. Start{' '}
            <code className="bg-amber-200/60 px-1 rounded text-[11px]">ddi-scanner.exe</code>{' '}
            to scan real infrastructure.
          </span>
          <button
            onClick={backend.retry}
            className="ml-1 px-2 py-0.5 bg-amber-200 hover:bg-amber-300 rounded text-[11px] transition-colors"
            style={{ fontWeight: 600 }}
          >
            Retry
          </button>
        </div>
      )}

      {/* Stepper — hidden in Sizer mode; SizerWizard owns its own 4-step stepper (issue #26) */}
      {!(isEstimatorOnly && currentStep === 'credentials') && (
      <div className="bg-white border-b border-[var(--border)]">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4">
          <div className="flex items-center justify-between">
            {STEPS.map((step, i) => {
              const isCompleted = i < currentIndex;
              const isCurrent = i === currentIndex;
              return (
                <div key={step.id} className="flex items-center flex-1 last:flex-none">
                  <div className="flex items-center gap-2">
                    <div
                      className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 transition-colors ${
                        isCompleted
                          ? 'bg-[var(--infoblox-green)] text-white'
                          : isCurrent
                            ? 'bg-[var(--infoblox-orange)] text-white'
                            : 'bg-gray-200 text-gray-400'
                      }`}
                    >
                      {isCompleted ? (
                        <CheckCircle2 className="w-4 h-4" />
                      ) : (
                        <span className="text-[12px]" style={{ fontWeight: 600 }}>
                          {i + 1}
                        </span>
                      )}
                    </div>
                    <span
                      className={`text-[13px] hidden sm:block ${
                        isCurrent
                          ? 'text-[var(--foreground)]'
                          : isCompleted
                            ? 'text-emerald-700'
                            : 'text-gray-600'
                      }`}
                      style={{ fontWeight: isCurrent ? 600 : 400 }}
                    >
                      {step.id === 'credentials' && isEstimatorOnly ? 'Manual Sizing' : step.id === 'credentials' && isNiosOnly && niosMode === 'backup' ? 'Upload Backup' : step.label}
                    </span>
                  </div>
                  {i < STEPS.length - 1 && (
                    <div
                      className={`flex-1 h-[2px] mx-3 rounded ${
                        isCompleted ? 'bg-[var(--infoblox-green)]' : 'bg-gray-200'
                      }`}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      )}

      {/* Content */}
      <div className="flex-1">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6">
          {/* Step 1: Select Providers */}
          {currentStep === 'providers' && (
            <div>
              <h2 className="text-[18px] mb-1" style={{ fontWeight: 600 }}>
                Which infrastructure do you want to scan?
              </h2>
              <p className="text-[13px] text-[var(--muted-foreground)] mb-6">
                Select one or more cloud providers or on-prem servers. Each will be scanned in parallel.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {PROVIDERS.map((provider) => {
                  const selected = selectedProviders.includes(provider.id);
                  return (
                    <button
                      key={provider.id}
                      onClick={() => toggleProvider(provider.id)}
                      className={`text-left p-4 rounded-xl border-2 transition-all ${
                        selected
                          ? 'border-[var(--infoblox-orange)] bg-orange-50/50 shadow-sm'
                          : 'border-[var(--border)] bg-white hover:border-gray-300'
                      }`}
                    >
                      <div className="flex items-start gap-3">
                        <div
                          className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
                          style={{ backgroundColor: `${provider.color}15` }}
                        >
                          <ProviderIconEl id={provider.id} className="w-5 h-5" color={provider.color} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-[14px]" style={{ fontWeight: 600 }}>
                              {provider.fullName}
                            </span>
                          </div>
                          <p className="text-[12px] text-[var(--muted-foreground)] mt-0.5">
                            {provider.description}
                          </p>
                        </div>
                        <div
                          className={`w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
                            selected
                              ? 'bg-[var(--infoblox-orange)] border-[var(--infoblox-orange)]'
                              : 'border-gray-300'
                          }`}
                        >
                          {selected && <Check className="w-3 h-3 text-white" />}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
              {/* Load Session */}
              <div className="mt-4">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".json"
                  className="hidden"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    e.target.value = '';
                    try {
                      const snapshot = await importSession(file);
                      setImportError('');
                      restoreSession(snapshot);
                    } catch (err) {
                      setImportError(err instanceof Error ? err.message : 'Failed to load session file.');
                    }
                  }}
                />
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="flex items-center gap-2 px-4 py-2.5 text-[13px] rounded-xl border border-[var(--border)] bg-white hover:bg-gray-50 transition-colors"
                  style={{ fontWeight: 500 }}
                >
                  <Upload className="w-4 h-4" />
                  Load Session
                </button>
                {importError && (
                  <div className="mt-2 flex items-start gap-2 p-3 bg-red-50 rounded-lg border border-red-200">
                    <AlertCircle className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
                    <p className="text-[13px] text-red-700">{importError}</p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Step 2: Credentials */}
          {currentStep === 'credentials' && (
            <div>
              {!isEstimatorOnly && (
                <>
                  <h2 className="text-[18px] mb-1" style={{ fontWeight: 600 }}>
                    {isNiosOnly && niosMode === 'backup' ? 'Upload NIOS Grid Backup' : 'Choose authentication method'}
                  </h2>
                  <p className="text-[13px] text-[var(--muted-foreground)] mb-6">
                    {isNiosOnly && niosMode === 'backup'
                      ? 'Upload a NIOS Grid backup file (.tar.gz, .tgz, .bak) or onedb.xml exported from the Grid Master.'
                      : 'Configure credentials for each selected provider. Credentials are sent only to your local Go backend — never to external servers.'}
                  </p>
                </>
              )}
              <div className="space-y-4">
                {selectedProviders.map((provId) => {
                  const provider = PROVIDERS.find((p) => p.id === provId)!;
                  const status = credentialStatus[provId];
                  const currentAuthId = selectedAuthMethod[provId];
                  const platform = backend.health?.platform;
                  const availableAuthMethods = provider.authMethods.filter(
                    (m) => !m.windowsOnly || platform === 'windows'
                  );
                  const currentAuth = availableAuthMethods.find((m) => m.id === currentAuthId) || availableAuthMethods[0];
                  const hasFields = currentAuth ? currentAuth.fields.length > 0 : false;

                  // ── Manual Estimator: mount standalone Sizer wizard (Phase 30) ──
                  if (provId === 'estimator') {
                    // Auto-mark as valid so the outer scan wizard's Next button
                    // enables. Preserved render-phase shim from pre-Phase 30 UX
                    // (see 30-01-AUDIT §2 / RESEARCH Pitfall 1).
                    if (credentialStatus['estimator'] !== 'valid') {
                      setCredentialStatus(prev => ({ ...prev, estimator: 'valid' }));
                    }
                    return (
                      <SizerWizard
                        key={provId}
                        onAdvance={() => goNext()}
                        onRetreat={() => goBack()}
                      />
                    );
                  }

                  return (
                    <div
                      key={provId}
                      className="bg-white rounded-xl border border-[var(--border)] overflow-hidden"
                    >
                      {/* Provider header */}
                      <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border)] bg-gray-50/50">
                        <div
                          className="w-8 h-8 rounded-lg flex items-center justify-center"
                          style={{ backgroundColor: `${provider.color}15` }}
                        >
                          <ProviderIconEl id={provId} className="w-4 h-4" color={provider.color} />
                        </div>
                        <span className="text-[14px]" style={{ fontWeight: 600 }}>
                          {provider.fullName}
                        </span>
                        {status === 'valid' && (
                          <span className="ml-auto flex items-center gap-1 text-[12px] text-green-600">
                            <CheckCircle2 className="w-3.5 h-3.5" /> Verified
                          </span>
                        )}
                        {status === 'error' && (
                          <span className="ml-auto flex items-center gap-1 text-[12px] text-red-600">
                            <AlertCircle className="w-3.5 h-3.5" /> Failed
                          </span>
                        )}
                      </div>

                      {/* Auth method selector */}
                      <div className="px-4 pt-4 pb-2">
                        <label className="block text-[12px] text-[var(--muted-foreground)] mb-2" style={{ fontWeight: 500 }}>
                          Authentication Method
                        </label>
                        <div className="flex flex-wrap gap-1.5">
                          {availableAuthMethods.map((method) => {
                            const isSelected = currentAuthId === method.id;
                            return (
                              <button
                                key={method.id}
                                onClick={() => {
                                  setSelectedAuthMethod((prev) => ({ ...prev, [provId]: method.id }));
                                  // Reset status when switching auth method
                                  if (status === 'valid' || status === 'error') {
                                    setCredentialStatus((prev) => ({ ...prev, [provId]: 'idle' }));
                                  }
                                  // NIOS mode toggle: clear stale state when switching between backup and WAPI
                                  if (provId === 'nios') {
                                    const newMode = method.id === 'wapi' ? 'wapi' : 'backup';
                                    setNiosMode(newMode as 'backup' | 'wapi');
                                    setBackupToken('');
                                    setNiosUploadedFile(null);
                                    setSubscriptions((prev) => ({ ...prev, nios: [] }));
                                    setCredentialStatus((prev) => ({ ...prev, nios: 'idle' }));
                                    setCredentialError((prev) => ({ ...prev, nios: '' }));
                                  }
                                  // EfficientIP mode toggle: clear stale state when switching between backup and API
                                  if (provId === 'efficientip') {
                                    const newMode = method.id === 'backup-upload' ? 'backup' : 'api';
                                    setEfficientipMode(newMode);
                                    setEfficientipBackupToken('');
                                    setEfficientipUploadedFile(null);
                                    setSubscriptions((prev) => ({ ...prev, efficientip: [] }));
                                    setCredentialStatus((prev) => ({ ...prev, efficientip: 'idle' }));
                                    setCredentialError((prev) => ({ ...prev, efficientip: '' }));
                                  }
                                }}
                                className={`px-3 py-1.5 rounded-lg text-[12px] transition-all border ${
                                  isSelected
                                    ? 'bg-[var(--infoblox-navy)] text-white border-[var(--infoblox-navy)]'
                                    : 'bg-white text-[var(--foreground)] border-[var(--border)] hover:border-gray-400'
                                }`}
                                style={{ fontWeight: isSelected ? 600 : 400 }}
                              >
                                {method.name}
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      {/* Auth method description & fields */}
                      <div className="px-4 pb-4 pt-2">
                        <div className="flex items-start gap-2 mb-3 p-2.5 bg-blue-50 rounded-lg border border-blue-100">
                          <Info className="w-3.5 h-3.5 text-blue-500 mt-0.5 shrink-0" />
                          <p className="text-[12px] text-blue-700">
                            {currentAuth.description}
                          </p>
                        </div>

                        {/* NIOS backup mode: file upload dropzone */}
                        {provId === 'nios' && niosMode === 'backup' ? (
                          <div>
                            <div
                              onDragOver={(e) => { e.preventDefault(); setNiosDragOver(true); }}
                              onDragLeave={() => setNiosDragOver(false)}
                              onDrop={(e) => {
                                e.preventDefault();
                                setNiosDragOver(false);
                                const file = e.dataTransfer.files?.[0];
                                if (file && (file.name.endsWith('.tar.gz') || file.name.endsWith('.tgz') || file.name.endsWith('.bak') || file.name.endsWith('.xml'))) {
                                  setNiosUploadedFile(file);
                                }
                              }}
                              className={`relative border-2 border-dashed rounded-xl p-8 text-center transition-colors ${
                                niosDragOver
                                  ? 'border-[var(--infoblox-orange)] bg-orange-50/50'
                                  : status === 'validating'
                                    ? 'border-[var(--infoblox-orange)] bg-orange-50/30'
                                    : status === 'valid'
                                      ? 'border-green-400 bg-green-50/50'
                                      : status === 'error'
                                        ? 'border-red-400 bg-red-50/50'
                                        : niosUploadedFile
                                          ? 'border-[var(--infoblox-orange)] bg-orange-50/30'
                                          : 'border-gray-300 hover:border-gray-400'
                              }`}
                            >
                              {status === 'validating' && niosUploadedFile ? (
                                <div className="flex flex-col items-center gap-2">
                                  <div className="w-10 h-10 rounded-full bg-orange-100 flex items-center justify-center">
                                    <Loader2 className="w-5 h-5 text-[var(--infoblox-orange)] animate-spin" />
                                  </div>
                                  <div>
                                    <p className="text-[13px]" style={{ fontWeight: 600 }}>Parsing {niosUploadedFile.name}...</p>
                                    <p className="text-[11px] text-[var(--muted-foreground)]">
                                      Extracting Grid Members and DDI configuration
                                    </p>
                                  </div>
                                </div>
                              ) : status === 'valid' && niosUploadedFile ? (
                                <div className="flex flex-col items-center gap-2">
                                  <div className="w-10 h-10 rounded-full bg-green-100 flex items-center justify-center">
                                    <CheckCircle2 className="w-5 h-5 text-green-600" />
                                  </div>
                                  <div>
                                    <p className="text-[13px]" style={{ fontWeight: 600 }}>{niosUploadedFile.name}</p>
                                    <p className="text-[11px] text-[var(--muted-foreground)]">
                                      {(niosUploadedFile.size / 1024 / 1024).toFixed(1)} MB — {subscriptions.nios.length} Grid Member{subscriptions.nios.length !== 1 ? 's' : ''} found
                                    </p>
                                  </div>
                                  <button
                                    onClick={() => {
                                      setNiosUploadedFile(null);
                                      setCredentialStatus((prev) => ({ ...prev, nios: 'idle' }));
                                      setSubscriptions((prev) => ({ ...prev, nios: [] }));
                                    }}
                                    className="text-[12px] text-red-500 hover:text-red-700 underline"
                                  >
                                    Remove file
                                  </button>
                                </div>
                              ) : status === 'error' && niosUploadedFile ? (
                                <div className="flex flex-col items-center gap-2">
                                  <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center">
                                    <AlertCircle className="w-5 h-5 text-red-500" />
                                  </div>
                                  <div>
                                    <p className="text-[13px]" style={{ fontWeight: 600 }}>{niosUploadedFile.name}</p>
                                    <p className="text-[11px] text-red-600">
                                      {credentialError.nios || 'Failed to parse backup'}
                                    </p>
                                  </div>
                                  <button
                                    onClick={() => {
                                      setNiosUploadedFile(null);
                                      setCredentialStatus((prev) => ({ ...prev, nios: 'idle' }));
                                      setCredentialError((prev) => ({ ...prev, nios: '' }));
                                      setSubscriptions((prev) => ({ ...prev, nios: [] }));
                                    }}
                                    className="text-[12px] text-[var(--infoblox-orange)] hover:underline"
                                  >
                                    Try a different file
                                  </button>
                                </div>
                              ) : (
                                <div className="flex flex-col items-center gap-2">
                                  <div className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center">
                                    <Upload className="w-5 h-5 text-gray-400" />
                                  </div>
                                  <div>
                                    <p className="text-[13px]" style={{ fontWeight: 500 }}>
                                      Drop your NIOS backup here, or{' '}
                                      <label className="text-[var(--infoblox-orange)] hover:underline cursor-pointer">
                                        browse
                                        <input
                                          type="file"
                                          accept=".tar.gz,.tgz,.bak,.xml"
                                          className="hidden"
                                          onChange={(e) => {
                                            const file = e.target.files?.[0];
                                            if (file) setNiosUploadedFile(file);
                                          }}
                                        />
                                      </label>
                                    </p>
                                    <p className="text-[11px] text-[var(--muted-foreground)] mt-1">
                                      Accepts .tar.gz, .tgz, .bak, or .xml (onedb.xml) files
                                    </p>
                                  </div>
                                </div>
                              )}
                            </div>

                            {/* Optional QPS upload zone — shown after backup succeeds */}
                            {status === 'valid' && niosUploadedFile && (
                              <div className="mt-3">
                                <div
                                  onDragOver={(e) => { e.preventDefault(); setNiosQPSDragOver(true); }}
                                  onDragLeave={() => setNiosQPSDragOver(false)}
                                  onDrop={(e) => {
                                    e.preventDefault();
                                    setNiosQPSDragOver(false);
                                    const file = e.dataTransfer.files?.[0];
                                    if (file && file.name.endsWith('.xml')) {
                                      setNiosQPSFile(file);
                                      setQpsError('');
                                      setQpsUploading(true);
                                      apiUploadNiosQPS(file).then((res) => {
                                        if (res.valid && res.qpsToken) {
                                          setQpsToken(res.qpsToken);
                                          setQpsMembers(res.members);
                                        } else {
                                          setQpsError(res.error || 'Failed to parse QPS data');
                                        }
                                      }).catch((err) => {
                                        setQpsError(err.message || 'QPS upload failed');
                                      }).finally(() => setQpsUploading(false));
                                    }
                                  }}
                                  className={`relative border-2 border-dashed rounded-xl p-5 text-center transition-colors ${
                                    niosQPSDragOver
                                      ? 'border-blue-400 bg-blue-50/50'
                                      : qpsUploading
                                        ? 'border-blue-300 bg-blue-50/30'
                                        : qpsToken
                                          ? 'border-green-400 bg-green-50/50'
                                          : qpsError
                                            ? 'border-red-400 bg-red-50/50'
                                            : 'border-gray-200 hover:border-gray-300 bg-gray-50/30'
                                  }`}
                                >
                                  {qpsUploading ? (
                                    <div className="flex items-center justify-center gap-2">
                                      <Loader2 className="w-4 h-4 text-blue-500 animate-spin" />
                                      <span className="text-[12px] text-blue-600">Parsing QPS data...</span>
                                    </div>
                                  ) : qpsToken ? (
                                    <div className="flex items-center justify-center gap-2">
                                      <CheckCircle2 className="w-4 h-4 text-green-600" />
                                      <span className="text-[12px] text-green-700">
                                        QPS data loaded: {qpsMembers.length} member{qpsMembers.length !== 1 ? 's' : ''}
                                      </span>
                                      <button
                                        onClick={() => {
                                          setNiosQPSFile(null);
                                          setQpsToken('');
                                          setQpsMembers([]);
                                          setQpsError('');
                                        }}
                                        className="text-[11px] text-red-500 hover:text-red-700 underline ml-2"
                                      >
                                        Remove
                                      </button>
                                    </div>
                                  ) : qpsError ? (
                                    <div className="flex flex-col items-center gap-1">
                                      <div className="flex items-center gap-2">
                                        <AlertCircle className="w-4 h-4 text-red-500" />
                                        <span className="text-[12px] text-red-600">{qpsError}</span>
                                      </div>
                                      <button
                                        onClick={() => {
                                          setNiosQPSFile(null);
                                          setQpsError('');
                                        }}
                                        className="text-[11px] text-[var(--infoblox-orange)] hover:underline"
                                      >
                                        Try again
                                      </button>
                                    </div>
                                  ) : (
                                    <div className="flex flex-col items-center gap-1">
                                      <p className="text-[12px] text-gray-500" style={{ fontWeight: 500 }}>
                                        Optional: Upload DNS QPS Data (Splunk XML){' '}
                                        <label className="text-[var(--infoblox-orange)] hover:underline cursor-pointer">
                                          browse
                                          <input
                                            type="file"
                                            accept=".xml"
                                            className="hidden"
                                            onChange={(e) => {
                                              const file = e.target.files?.[0];
                                              if (file) {
                                                setNiosQPSFile(file);
                                                setQpsError('');
                                                setQpsUploading(true);
                                                apiUploadNiosQPS(file).then((res) => {
                                                  if (res.valid && res.qpsToken) {
                                                    setQpsToken(res.qpsToken);
                                                    setQpsMembers(res.members);
                                                  } else {
                                                    setQpsError(res.error || 'Failed to parse QPS data');
                                                  }
                                                }).catch((err) => {
                                                  setQpsError(err.message || 'QPS upload failed');
                                                }).finally(() => setQpsUploading(false));
                                              }
                                            }}
                                          />
                                        </label>
                                      </p>
                                      <p className="text-[10px] text-gray-400">
                                        Enhances tier calculations with real DNS query rates
                                      </p>
                                    </div>
                                  )}
                                </div>
                              </div>
                            )}
                          </div>
                        ) : provId === 'efficientip' && efficientipMode === 'backup' ? (
                          <div>
                            <div
                              onDragOver={(e) => { e.preventDefault(); setEfficientipDragOver(true); }}
                              onDragLeave={() => setEfficientipDragOver(false)}
                              onDrop={(e) => {
                                e.preventDefault();
                                setEfficientipDragOver(false);
                                const file = e.dataTransfer.files?.[0];
                                if (file && file.name.endsWith('.gz')) {
                                  setEfficientipUploadedFile(file);
                                }
                              }}
                              className={`relative border-2 border-dashed rounded-xl p-8 text-center transition-colors ${
                                efficientipDragOver
                                  ? 'border-[var(--infoblox-orange)] bg-orange-50/50'
                                  : status === 'validating'
                                    ? 'border-[var(--infoblox-orange)] bg-orange-50/30'
                                    : status === 'valid'
                                      ? 'border-green-400 bg-green-50/50'
                                      : status === 'error'
                                        ? 'border-red-400 bg-red-50/50'
                                        : efficientipUploadedFile
                                          ? 'border-[var(--infoblox-orange)] bg-orange-50/30'
                                          : 'border-gray-300 hover:border-gray-400'
                              }`}
                            >
                              {status === 'validating' && efficientipUploadedFile ? (
                                <div className="flex flex-col items-center gap-2">
                                  <div className="w-10 h-10 rounded-full bg-orange-100 flex items-center justify-center">
                                    <Loader2 className="w-5 h-5 text-[var(--infoblox-orange)] animate-spin" />
                                  </div>
                                  <div>
                                    <p className="text-[13px]" style={{ fontWeight: 600 }}>Parsing backup...</p>
                                    <p className="text-[11px] text-[var(--muted-foreground)]">
                                      {efficientipUploadedFile.name}
                                    </p>
                                  </div>
                                </div>
                              ) : status === 'valid' && efficientipUploadedFile ? (
                                <div className="flex flex-col items-center gap-2">
                                  <div className="w-10 h-10 rounded-full bg-green-100 flex items-center justify-center">
                                    <CheckCircle2 className="w-5 h-5 text-green-600" />
                                  </div>
                                  <div>
                                    <p className="text-[13px]" style={{ fontWeight: 600 }}>{efficientipUploadedFile.name}</p>
                                    <p className="text-[11px] text-[var(--muted-foreground)]">
                                      {(efficientipUploadedFile.size / 1024 / 1024).toFixed(1)} MB &mdash; Backup ready
                                    </p>
                                  </div>
                                  <button
                                    onClick={() => {
                                      setEfficientipUploadedFile(null);
                                      setEfficientipBackupToken('');
                                      setCredentialStatus((prev) => ({ ...prev, efficientip: 'idle' }));
                                      setSubscriptions((prev) => ({ ...prev, efficientip: [] }));
                                    }}
                                    className="text-[12px] text-red-500 hover:text-red-700 underline"
                                  >
                                    Remove file
                                  </button>
                                </div>
                              ) : status === 'error' && efficientipUploadedFile ? (
                                <div className="flex flex-col items-center gap-2">
                                  <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center">
                                    <AlertCircle className="w-5 h-5 text-red-500" />
                                  </div>
                                  <div>
                                    <p className="text-[13px]" style={{ fontWeight: 600 }}>{efficientipUploadedFile.name}</p>
                                    <p className="text-[11px] text-red-600">
                                      {credentialError.efficientip || 'Upload failed'}
                                    </p>
                                  </div>
                                  <button
                                    onClick={() => {
                                      setEfficientipUploadedFile(null);
                                      setEfficientipBackupToken('');
                                      setCredentialStatus((prev) => ({ ...prev, efficientip: 'idle' }));
                                      setCredentialError((prev) => ({ ...prev, efficientip: '' }));
                                    }}
                                    className="text-[12px] text-[var(--infoblox-orange)] hover:underline"
                                  >
                                    Try a different file
                                  </button>
                                </div>
                              ) : (
                                <div className="flex flex-col items-center gap-2">
                                  <div className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center">
                                    <Upload className="w-5 h-5 text-gray-400" />
                                  </div>
                                  <div>
                                    <p className="text-[13px]" style={{ fontWeight: 500 }}>
                                      Drop .gz backup file here or click to browse
                                    </p>
                                    <p className="text-[11px] text-[var(--muted-foreground)] mt-1">
                                      Accepts SOLIDserver .gz backup export files
                                    </p>
                                  </div>
                                  <label className="text-[12px] text-[var(--infoblox-orange)] hover:underline cursor-pointer">
                                    Browse
                                    <input
                                      type="file"
                                      accept=".gz"
                                      className="hidden"
                                      onChange={(e) => {
                                        const file = e.target.files?.[0];
                                        if (file) setEfficientipUploadedFile(file);
                                      }}
                                    />
                                  </label>
                                </div>
                              )}
                            </div>
                          </div>
                        ) : hasFields ? (
                          <div className="space-y-3">
                            {currentAuth.fields.map((field) => {
                              const fieldKey = `${provId}-${currentAuthId}-${field.key}`;
                              const isSecret = field.secret;
                              const isVisible = showSecrets[fieldKey];
                              return (
                                <div key={field.key}>
                                  <label className="flex items-center gap-1.5 text-[12px] text-[var(--muted-foreground)] mb-1">
                                    {field.label}
                                    {field.helpText && <FieldTooltip text={field.helpText} />}
                                  </label>
                                  <div className="relative">
                                    {field.serverList ? (
                                      <ServerListInput
                                        servers={(credentials[provId]?.[field.key] || '').split(',').map((s: string) => s.trim()).filter(Boolean)}
                                        onChange={(list) =>
                                          setCredentials((prev) => ({
                                            ...prev,
                                            [provId]: {
                                              ...prev[provId],
                                              [field.key]: list.join(', '),
                                            },
                                          }))
                                        }
                                        placeholder={field.placeholder}
                                      />
                                    ) : field.type === 'file' ? (
                                      <div className="flex flex-col gap-1">
                                        <input
                                          type="file"
                                          accept=".pem,.crt,.key"
                                          onChange={(e) => {
                                            const file = e.target.files?.[0];
                                            if (file) {
                                              const reader = new FileReader();
                                              reader.onload = () => {
                                                const content = reader.result as string;
                                                setCredentials((prev) => ({
                                                  ...prev,
                                                  [provId]: {
                                                    ...prev[provId],
                                                    [field.key]: content,
                                                  },
                                                }));
                                              };
                                              reader.onerror = () => {
                                                setCredentialError((prev) => ({
                                                  ...prev,
                                                  [provId]: `Failed to read file: ${file.name}`,
                                                }));
                                              };
                                              reader.readAsText(file);
                                            }
                                          }}
                                          className="w-full px-3 py-2 bg-[var(--input-background)] border border-[var(--border)] rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-[var(--infoblox-blue)]/30 focus:border-[var(--infoblox-blue)] file:mr-3 file:py-1 file:px-3 file:rounded-md file:border-0 file:text-[12px] file:bg-[var(--infoblox-navy)] file:text-white file:cursor-pointer"
                                        />
                                        {credentials[provId]?.[field.key] && (
                                          <span className="text-[11px] text-green-600 flex items-center gap-1">
                                            <CheckCircle2 className="w-3 h-3" /> File loaded
                                          </span>
                                        )}
                                      </div>
                                    ) : field.multiline ? (
                                      <textarea
                                        placeholder={field.placeholder}
                                        value={credentials[provId]?.[field.key] || ''}
                                        onChange={(e) =>
                                          setCredentials((prev) => ({
                                            ...prev,
                                            [provId]: {
                                              ...prev[provId],
                                              [field.key]: e.target.value,
                                            },
                                          }))
                                        }
                                        rows={4}
                                        className="w-full px-3 py-2 bg-[var(--input-background)] border border-[var(--border)] rounded-lg text-[13px] font-mono focus:outline-none focus:ring-2 focus:ring-[var(--infoblox-blue)]/30 focus:border-[var(--infoblox-blue)] resize-none"
                                      />
                                    ) : (
                                      <input
                                        type={isSecret && !isVisible ? 'password' : 'text'}
                                        placeholder={field.placeholder}
                                        value={credentials[provId]?.[field.key] || ''}
                                        onChange={(e) =>
                                          setCredentials((prev) => ({
                                            ...prev,
                                            [provId]: {
                                              ...prev[provId],
                                              [field.key]: e.target.value,
                                            },
                                          }))
                                        }
                                        className="w-full px-3 py-2 bg-[var(--input-background)] border border-[var(--border)] rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-[var(--infoblox-blue)]/30 focus:border-[var(--infoblox-blue)]"
                                      />
                                    )}
                                    {isSecret && !field.multiline && !field.serverList && (
                                      <button
                                        type="button"
                                        onClick={() =>
                                          setShowSecrets((prev) => ({
                                            ...prev,
                                            [fieldKey]: !prev[fieldKey],
                                          }))
                                        }
                                        className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                                      >
                                        {isVisible ? (
                                          <EyeOff className="w-4 h-4" />
                                        ) : (
                                          <Eye className="w-4 h-4" />
                                        )}
                                      </button>
                                    )}
                                  </div>
                                </div>
                              );
                            })}

                            {/* TLS skip-verify checkbox — shown for NIOS WAPI, Bluecat, EfficientIP */}
                            {(provId === 'bluecat' || (provId === 'efficientip' && efficientipMode !== 'backup') || (provId === 'nios' && niosMode === 'wapi')) && (
                              <div className="mt-1">
                                <label className="flex items-start gap-2 cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={credentials[provId]?.skip_tls === 'true'}
                                    onChange={(e) =>
                                      setCredentials((prev) => ({
                                        ...prev,
                                        [provId]: {
                                          ...prev[provId],
                                          skip_tls: e.target.checked ? 'true' : '',
                                        },
                                      }))
                                    }
                                    className="mt-0.5 rounded border-[var(--border)] text-[var(--infoblox-orange)] focus:ring-[var(--infoblox-orange)]"
                                  />
                                  <div>
                                    <span className="text-[12px] text-[var(--foreground)]" style={{ fontWeight: 500 }}>
                                      Skip TLS certificate verification
                                    </span>
                                    {credentials[provId]?.skip_tls === 'true' && (
                                      <p className="text-[11px] text-amber-600 mt-0.5 flex items-center gap-1">
                                        <Shield className="w-3 h-3" />
                                        Connections will not be verified. Use only for trusted self-signed deployments.
                                      </p>
                                    )}
                                  </div>
                                </label>
                              </div>
                            )}

                            {/* WinRM transport security — shown for Microsoft DHCP & DNS (NTLM, Kerberos) */}
                            {provId === 'microsoft' && (selectedAuthMethod.microsoft === 'ntlm' || selectedAuthMethod.microsoft === 'kerberos') && (
                              <div className="mt-2 space-y-2">
                                <label className="flex items-start gap-2 cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={credentials.microsoft?.useSSL === 'true'}
                                    onChange={(e) =>
                                      setCredentials((prev) => ({
                                        ...prev,
                                        microsoft: {
                                          ...prev.microsoft,
                                          useSSL: e.target.checked ? 'true' : '',
                                          ...(e.target.checked ? {} : { insecureSkipVerify: '' }),
                                        },
                                      }))
                                    }
                                    className="mt-0.5 rounded border-[var(--border)] text-[var(--infoblox-blue)] focus:ring-[var(--infoblox-blue)]"
                                  />
                                  <div>
                                    <span className="text-[12px] text-[var(--foreground)]" style={{ fontWeight: 500 }}>
                                      Use HTTPS transport (port 5986)
                                    </span>
                                    <p className="text-[11px] text-[var(--muted-foreground)] mt-0.5">
                                      Encrypts the entire WinRM session with TLS — recommended for production environments
                                    </p>
                                  </div>
                                </label>

                                {credentials.microsoft?.useSSL === 'true' && (
                                  <label className="flex items-start gap-2 cursor-pointer pl-5">
                                    <input
                                      type="checkbox"
                                      checked={credentials.microsoft?.insecureSkipVerify === 'true'}
                                      onChange={(e) =>
                                        setCredentials((prev) => ({
                                          ...prev,
                                          microsoft: {
                                            ...prev.microsoft,
                                            insecureSkipVerify: e.target.checked ? 'true' : '',
                                          },
                                        }))
                                      }
                                      className="mt-0.5 rounded border-[var(--border)] text-[var(--infoblox-orange)] focus:ring-[var(--infoblox-orange)]"
                                    />
                                    <div>
                                      <span className="text-[12px] text-[var(--foreground)]" style={{ fontWeight: 500 }}>
                                        Allow untrusted certificates
                                      </span>
                                      {credentials.microsoft?.insecureSkipVerify === 'true' && (
                                        <p className="text-[11px] text-amber-600 mt-0.5 flex items-center gap-1">
                                          <Shield className="w-3 h-3" />
                                          TLS certificate validation is disabled. Use only with self-signed certificates.
                                        </p>
                                      )}
                                    </div>
                                  </label>
                                )}

                                {credentials.microsoft?.useSSL !== 'true' && (
                                  <div className="flex items-start gap-2 px-3 py-2 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/50 rounded-lg">
                                    <Shield className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" />
                                    <div>
                                      <p className="text-[12px] text-amber-800 dark:text-amber-300" style={{ fontWeight: 500 }}>
                                        Security notice
                                      </p>
                                      <p className="text-[11px] text-amber-700 dark:text-amber-400 mt-0.5">
                                        Without HTTPS, WinRM uses NTLM message-level encryption (HTTP port 5985). While credentials are not sent in cleartext, NTLM authentication tokens can be intercepted and relayed by attackers on the network.
                                        Enable HTTPS for full TLS transport encryption.
                                      </p>
                                    </div>
                                  </div>
                                )}
                              </div>
                            )}

                            {/* Advanced section — Bluecat: Configuration IDs */}
                            {provId === 'bluecat' && (
                              <details className="mt-2">
                                <summary className="text-[12px] text-[var(--muted-foreground)] cursor-pointer hover:text-[var(--foreground)] select-none" style={{ fontWeight: 500 }}>
                                  Advanced Options
                                </summary>
                                <div className="mt-2 pl-1">
                                  <label className="block text-[12px] text-[var(--muted-foreground)] mb-1">
                                    Configuration IDs
                                  </label>
                                  <input
                                    type="text"
                                    placeholder="Leave empty to scan all configurations"
                                    value={credentials.bluecat?.configuration_ids || ''}
                                    onChange={(e) =>
                                      setCredentials((prev) => ({
                                        ...prev,
                                        bluecat: { ...prev.bluecat, configuration_ids: e.target.value },
                                      }))
                                    }
                                    className="w-full px-3 py-2 bg-[var(--input-background)] border border-[var(--border)] rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-[var(--infoblox-blue)]/30 focus:border-[var(--infoblox-blue)]"
                                  />
                                  <p className="text-[11px] text-[var(--muted-foreground)] mt-1">
                                    Comma-separated list of configuration IDs to restrict scanning scope
                                  </p>
                                </div>
                              </details>
                            )}

                            {/* Advanced section — EfficientIP: Site IDs */}
                            {provId === 'efficientip' && efficientipMode !== 'backup' && (
                              <details className="mt-2">
                                <summary className="text-[12px] text-[var(--muted-foreground)] cursor-pointer hover:text-[var(--foreground)] select-none" style={{ fontWeight: 500 }}>
                                  Advanced Options
                                </summary>
                                <div className="mt-2 pl-1">
                                  <label className="block text-[12px] text-[var(--muted-foreground)] mb-1">
                                    Site IDs
                                  </label>
                                  <input
                                    type="text"
                                    placeholder="Leave empty to scan all sites"
                                    value={credentials.efficientip?.site_ids || ''}
                                    onChange={(e) =>
                                      setCredentials((prev) => ({
                                        ...prev,
                                        efficientip: { ...prev.efficientip, site_ids: e.target.value },
                                      }))
                                    }
                                    className="w-full px-3 py-2 bg-[var(--input-background)] border border-[var(--border)] rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-[var(--infoblox-blue)]/30 focus:border-[var(--infoblox-blue)]"
                                  />
                                  <p className="text-[11px] text-[var(--muted-foreground)] mt-1">
                                    Comma-separated list of site IDs to restrict scanning scope
                                  </p>
                                  <label className="block text-[12px] text-[var(--muted-foreground)] mb-1 mt-3">
                                    API Version
                                  </label>
                                  <div className="flex gap-3">
                                    {(['legacy', 'v2'] as const).map((v) => (
                                      <label key={v} className="flex items-center gap-1.5 text-[12px] cursor-pointer">
                                        <input
                                          type="radio"
                                          name="efficientip-api-version"
                                          value={v}
                                          checked={efficientipAPIVersion === v}
                                          onChange={() => setEfficientipAPIVersion(v)}
                                        />
                                        {v === 'legacy' ? 'Legacy (/rest/)' : 'API v2.0 (/api/v2.0/)'}
                                      </label>
                                    ))}
                                  </div>
                                  <p className="text-[11px] text-[var(--muted-foreground)] mt-1">
                                    Choose the API version that matches your SOLIDserver deployment
                                  </p>
                                </div>
                              </details>
                            )}

                            {/* Advanced section — Microsoft AD: Event Log Time Window */}
                            {provId === 'microsoft' && (
                              <details className="mt-2">
                                <summary className="text-[12px] text-[var(--muted-foreground)] cursor-pointer hover:text-[var(--foreground)] select-none" style={{ fontWeight: 500 }}>
                                  Advanced Options
                                </summary>
                                <div className="mt-2 pl-1">
                                  <label className="block text-[12px] text-[var(--muted-foreground)] mb-1">
                                    Event Log Time Window
                                  </label>
                                  <select
                                    value={credentials.microsoft?.eventLogWindowHours || '72'}
                                    onChange={(e) =>
                                      setCredentials((prev) => ({
                                        ...prev,
                                        microsoft: { ...prev.microsoft, eventLogWindowHours: e.target.value },
                                      }))
                                    }
                                    className="w-full px-3 py-2 bg-[var(--input-background)] border border-[var(--border)] rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-[var(--infoblox-blue)]/30 focus:border-[var(--infoblox-blue)]"
                                  >
                                    <option value="1">Last 1 hour</option>
                                    <option value="24">Last 24 hours</option>
                                    <option value="72">Last 72 hours (default)</option>
                                    <option value="168">Last 7 days</option>
                                  </select>
                                  <p className="text-[11px] text-[var(--muted-foreground)] mt-1">
                                    How far back to read DNS/DHCP event logs for QPS/LPS calculation. Longer windows give more accurate averages but take longer to process.
                                  </p>
                                </div>
                              </details>
                            )}

                            {/* Advanced section — Cloud providers: Max Workers */}
                            {(provId === 'aws' || provId === 'azure' || provId === 'gcp') && (
                              <details className="mt-2">
                                <summary className="text-[12px] text-[var(--muted-foreground)] cursor-pointer hover:text-[var(--foreground)] select-none" style={{ fontWeight: 500 }}>
                                  Advanced Options
                                </summary>
                                <div className="mt-2 pl-1">
                                  <label className="block text-[12px] text-[var(--muted-foreground)] mb-1">
                                    Max Concurrent Workers
                                  </label>
                                  <input
                                    type="number"
                                    min={0}
                                    max={100}
                                    placeholder="0"
                                    value={advancedOptions[provId]?.maxWorkers || ''}
                                    onChange={(e) =>
                                      setAdvancedOptions((prev) => ({
                                        ...prev,
                                        [provId]: { ...prev[provId], maxWorkers: parseInt(e.target.value) || 0 },
                                      }))
                                    }
                                    className="w-full px-3 py-2 bg-[var(--input-background)] border border-[var(--border)] rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-[var(--infoblox-blue)]/30 focus:border-[var(--infoblox-blue)]"
                                  />
                                  <p className="text-[11px] text-[var(--muted-foreground)] mt-1">
                                    0 = use provider default
                                  </p>
                                </div>
                              </details>
                            )}
                          </div>
                        ) : (
                          <div className="py-2 px-3 bg-green-50 rounded-lg border border-green-100 mb-3">
                            <p className="text-[12px] text-green-700">
                              No credentials needed — the scanner will use your existing session. Click the button below to verify access.
                            </p>
                          </div>
                        )}

                        {/* Action button */}
                        {(() => {
                          const isNiosBackup = provId === 'nios' && niosMode === 'backup';
                          return (
                            <button
                              onClick={() => {
                                if (isNiosBackup) {
                                  const input = document.querySelector('input[accept=".tar.gz,.tgz,.bak,.xml"]') as HTMLInputElement;
                                  if (input) input.click();
                                } else {
                                  validateCredential(provId);
                                }
                              }}
                              disabled={status === 'validating' || status === 'valid'}
                              className={`mt-3 px-4 py-2 rounded-lg text-[13px] transition-colors flex items-center gap-2 ${
                                status === 'valid'
                                  ? 'bg-green-100 text-green-700 cursor-default'
                                  : status === 'validating'
                                    ? 'bg-gray-100 text-gray-500 cursor-wait'
                                    : status === 'error'
                                      ? 'bg-red-600 text-white hover:bg-red-700'
                                      : 'bg-[var(--infoblox-navy)] text-white hover:bg-[var(--infoblox-navy)]/90'
                              }`}
                              style={{ fontWeight: 500 }}
                            >
                              {status === 'validating' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                              {status === 'valid' && <CheckCircle2 className="w-3.5 h-3.5" />}
                              {status === 'error' && <AlertCircle className="w-3.5 h-3.5" />}
                              {status === 'validating'
                                ? (isNiosBackup ? 'Parsing Backup...' : (hasFields ? 'Validating...' : 'Authenticating...'))
                                : status === 'valid'
                                  ? 'Verified'
                                  : status === 'error'
                                    ? 'Retry'
                                    : isNiosBackup
                                      ? 'Grid Backup Upload'
                                      : (hasFields ? 'Validate & Connect' : 'Authenticate via Browser')}
                              {status === 'idle' && !hasFields && !isNiosBackup && <Globe className="w-3.5 h-3.5" />}
                              {status === 'idle' && isNiosBackup && <Upload className="w-3.5 h-3.5" />}
                            </button>
                          );
                        })()}
                        {status === 'validating' && currentAuthId === 'browser-oauth' && (
                          <div className="mt-2 flex items-center gap-2 p-2.5 bg-blue-50 rounded-lg border border-blue-100">
                            <Loader2 className="w-3.5 h-3.5 text-blue-500 animate-spin shrink-0" />
                            <p className="text-[12px] text-blue-700">Waiting for browser consent in your default browser...</p>
                          </div>
                        )}
                        {deviceCodeMessage && currentAuthId === 'device-code' && (
                          <div className="mt-2 p-2.5 bg-blue-50 rounded-lg border border-blue-100">
                            <p className="text-[12px] text-blue-700 font-mono whitespace-pre-wrap">{deviceCodeMessage}</p>
                          </div>
                        )}
                        {status === 'error' && credentialError[provId] && (
                          <div className="mt-2 flex items-start gap-2 p-2.5 bg-red-50 rounded-lg border border-red-100">
                            <AlertCircle className="w-3.5 h-3.5 text-red-500 mt-0.5 shrink-0" />
                            <p className="text-[12px] text-red-700">{credentialError[provId]}</p>
                          </div>
                        )}

                        {/* AD Forest Discovery panel — shown after microsoft validates */}
                        {provId === 'microsoft' && status === 'valid' && !adDiscoveryDismissed && (
                          <div className="mt-3">
                            {adDiscovering && (
                              <div className="flex items-center gap-2 p-2.5 bg-blue-50 rounded-lg border border-blue-100 text-[12px] text-blue-700">
                                <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                                Scanning forest for additional domain controllers and DHCP servers…
                              </div>
                            )}
                            {!adDiscovering && adDiscoveryResult && (adDiscoveryResult.domainControllers.length > 0 || adDiscoveryResult.dhcpServers.length > 0) && (
                              <div className="p-3 bg-green-50 rounded-lg border border-green-200">
                                <div className="flex items-start justify-between gap-2 mb-2">
                                  <div className="flex items-center gap-1.5">
                                    <Globe className="w-3.5 h-3.5 text-green-700 shrink-0" />
                                    <span className="text-[12px] text-green-800" style={{ fontWeight: 600 }}>
                                      {adDiscoveryResult.forestName
                                        ? `Forest "${adDiscoveryResult.forestName}" discovered`
                                        : 'Additional AD servers discovered'}
                                    </span>
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() => setAdDiscoveryDismissed(true)}
                                    className="text-green-600 hover:text-green-800 flex-shrink-0"
                                    aria-label="Dismiss"
                                  >
                                    <X className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                                <p className="text-[11px] text-green-700 mb-2">
                                  The following servers were found in the forest but are not yet in your server list. Click <strong>Add All</strong> or pick individual servers to include them.
                                </p>
                                {/* DC list */}
                                {adDiscoveryResult.domainControllers.length > 0 && (
                                  <div className="mb-1.5">
                                    <p className="text-[11px] text-green-700 mb-1" style={{ fontWeight: 600 }}>Domain Controllers / DNS Servers</p>
                                    <ul className="space-y-1">
                                      {adDiscoveryResult.domainControllers.map((dc) => (
                                        <li key={dc.hostname} className="flex items-center justify-between px-2 py-1 bg-white/70 rounded border border-green-200 text-[11px]">
                                          <div>
                                            <span className="font-medium">{dc.hostname}</span>
                                            {dc.ip && <span className="text-green-600 ml-1">({dc.ip})</span>}
                                            {dc.domain && <span className="text-green-500 ml-1">· {dc.domain}</span>}
                                            <span className="ml-1.5 text-[10px] text-white bg-green-600 rounded px-1 py-0.5">{dc.roles.join(' · ')}</span>
                                          </div>
                                          <button
                                            type="button"
                                            onClick={() => {
                                              const existing = (credentials.microsoft?.servers || '').split(',').map((s: string) => s.trim()).filter(Boolean);
                                              // Prefer IP as the connection address — FQDNs from discovery
                                              // resolve to internal IPs and may not be reachable externally.
                                              // If the IP is already in the server list (user entered it), skip
                                              // adding this DC entirely — it's already covered.
                                              const connectAddr = dc.ip || dc.hostname;
                                              const alreadyCovered =
                                                existing.some((s) => s.toLowerCase() === connectAddr.toLowerCase()) ||
                                                existing.some((s) => s.toLowerCase() === dc.hostname.toLowerCase()) ||
                                                (dc.ip !== '' && existing.some((s) => s === dc.ip));
                                              if (!alreadyCovered) {
                                                setCredentials((prev) => ({
                                                  ...prev,
                                                  microsoft: { ...prev.microsoft, servers: [...existing, connectAddr].join(',') },
                                                }));
                                              }
                                              // Also add to subscriptions — use connectAddr as ID so
                                              // the scanner can match it against dc.inputHost.
                                              setSubscriptions((prev) => {
                                                const subs = prev.microsoft || [];
                                                if (subs.some((s) => s.id.toLowerCase() === connectAddr.toLowerCase())) return prev;
                                                const label = dc.ip ? `${dc.hostname} (${dc.ip})` : dc.hostname;
                                                return { ...prev, microsoft: [...subs, { id: connectAddr, name: label, selected: true }] };
                                              });
                                              setAdDiscoveryResult((prev) => prev ? {
                                                ...prev,
                                                domainControllers: prev.domainControllers.filter((d) => d.hostname !== dc.hostname),
                                              } : null);
                                            }}
                                            className="ml-2 px-2 py-0.5 bg-green-600 hover:bg-green-700 text-white text-[10px] rounded transition-colors"
                                          >
                                            Add
                                          </button>
                                        </li>
                                      ))}
                                    </ul>
                                  </div>
                                )}
                                {/* DHCP list */}
                                {adDiscoveryResult.dhcpServers.length > 0 && (
                                  <div className="mb-1.5">
                                    <p className="text-[11px] text-green-700 mb-1" style={{ fontWeight: 600 }}>DHCP Servers (non-DC)</p>
                                    <ul className="space-y-1">
                                      {adDiscoveryResult.dhcpServers.map((s) => (
                                        <li key={s.hostname} className="flex items-center justify-between px-2 py-1 bg-white/70 rounded border border-green-200 text-[11px]">
                                          <div>
                                            <span className="font-medium">{s.hostname}</span>
                                            {s.ip && <span className="text-green-600 ml-1">({s.ip})</span>}
                                            <span className="ml-1.5 text-[10px] text-white bg-amber-600 rounded px-1 py-0.5">DHCP</span>
                                          </div>
                                          <button
                                            type="button"
                                            onClick={() => {
                                              const existing = (credentials.microsoft?.servers || '').split(',').map((s2: string) => s2.trim()).filter(Boolean);
                                              // Prefer IP as the connection address (same as DC Add logic).
                                              const connectAddr = s.ip || s.hostname;
                                              const alreadyCovered =
                                                existing.some((e) => e.toLowerCase() === connectAddr.toLowerCase()) ||
                                                existing.some((e) => e.toLowerCase() === s.hostname.toLowerCase()) ||
                                                (s.ip !== '' && existing.some((e) => e === s.ip));
                                              if (!alreadyCovered) {
                                                setCredentials((prev) => ({
                                                  ...prev,
                                                  microsoft: { ...prev.microsoft, servers: [...existing, connectAddr].join(',') },
                                                }));
                                              }
                                              // Also add to subscriptions — use connectAddr as ID.
                                              setSubscriptions((prev) => {
                                                const subs = prev.microsoft || [];
                                                if (subs.some((sub) => sub.id.toLowerCase() === connectAddr.toLowerCase())) return prev;
                                                const label = s.ip ? `${s.hostname} (${s.ip})` : s.hostname;
                                                return { ...prev, microsoft: [...subs, { id: connectAddr, name: label, selected: true }] };
                                              });
                                              setAdDiscoveryResult((prev) => prev ? {
                                                ...prev,
                                                dhcpServers: prev.dhcpServers.filter((d) => d.hostname !== s.hostname),
                                              } : null);
                                            }}
                                            className="ml-2 px-2 py-0.5 bg-amber-600 hover:bg-amber-700 text-white text-[10px] rounded transition-colors"
                                          >
                                            Add
                                          </button>
                                        </li>
                                      ))}
                                    </ul>
                                  </div>
                                )}
                                {/* Add All button */}
                                <button
                                  type="button"
                                  onClick={() => {
                                    const existing = (credentials.microsoft?.servers || '').split(',').map((s: string) => s.trim()).filter(Boolean);
                                    // Build a list of {connectAddr, srv} pairs — prefer IP over hostname
                                    // so discovered DCs are reachable even when FQDNs resolve to internal IPs.
                                    // Skip any entry whose IP or hostname is already in the server list.
                                    const allDiscovered = [
                                      ...adDiscoveryResult!.domainControllers,
                                      ...adDiscoveryResult!.dhcpServers,
                                    ];
                                    const toAddEntries = allDiscovered
                                      .map((d) => ({ srv: d, connectAddr: d.ip || d.hostname }))
                                      .filter(({ srv, connectAddr }) =>
                                        !existing.some((e) => e.toLowerCase() === connectAddr.toLowerCase()) &&
                                        !existing.some((e) => e.toLowerCase() === srv.hostname.toLowerCase()),
                                      );
                                    const newAddrs = toAddEntries.map(({ connectAddr }) => connectAddr);
                                    if (newAddrs.length > 0) {
                                      setCredentials((prev) => ({
                                        ...prev,
                                        microsoft: { ...prev.microsoft, servers: [...existing, ...newAddrs].join(',') },
                                      }));
                                    }
                                    // Add to subscriptions — id = connectAddr so scanner filter matches.
                                    setSubscriptions((prev) => {
                                      const existingSubs = prev.microsoft || [];
                                      const existingIds = new Set(existingSubs.map((s) => s.id.toLowerCase()));
                                      const newSubs = toAddEntries
                                        .filter(({ connectAddr }) => !existingIds.has(connectAddr.toLowerCase()))
                                        .map(({ srv, connectAddr }) => {
                                          const label = srv.ip ? `${srv.hostname} (${srv.ip})` : srv.hostname;
                                          return { id: connectAddr, name: label, selected: true };
                                        });
                                      return { ...prev, microsoft: [...existingSubs, ...newSubs] };
                                    });
                                    setAdDiscoveryDismissed(true);
                                  }}
                                  className="w-full mt-1 py-1.5 bg-green-600 hover:bg-green-700 text-white text-[12px] font-medium rounded-lg transition-colors"
                                >
                                  Add All ({adDiscoveryResult.domainControllers.length + adDiscoveryResult.dhcpServers.length} servers)
                                </button>
                                {adDiscoveryResult.errors && adDiscoveryResult.errors.length > 0 && (
                                  <p className="mt-1 text-[10px] text-amber-700">
                                    ⚠ Partial discovery: {adDiscoveryResult.errors.join('; ')}
                                  </p>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </div>

                      {/* Add Forest — shown when microsoft primary is validated */}
                      {provId === 'microsoft' && status === 'valid' && (
                        <div className="mt-3">
                          {/* Existing additional forests */}
                          {adForests.map((forest, forestIdx) => {
                            const microsoftProvider = PROVIDERS.find((p) => p.id === 'microsoft')!;
                            const forestAuthMethod = forest.authMethod || 'ntlm';
                            const forestAuthDef = microsoftProvider.authMethods.find((m) => m.id === forestAuthMethod) || microsoftProvider.authMethods[1];
                            return (
                              <div key={forest.id} className="mb-3 p-3 bg-[var(--surface-2)] rounded-xl border border-[var(--border)]">
                                <div className="flex items-center justify-between mb-2">
                                  <span className="text-[12px] font-semibold text-[var(--foreground)]">
                                    Forest {forestIdx + 2}
                                    {forest.credentials.servers ? ` — ${forest.credentials.servers.split(',')[0].trim()}` : ''}
                                  </span>
                                  <div className="flex items-center gap-2">
                                    {forest.status === 'valid' && (
                                      <span className="text-[10px] text-green-600 font-medium flex items-center gap-1">
                                        <CheckCircle2 className="w-3 h-3" /> Valid
                                      </span>
                                    )}
                                    {forest.status === 'error' && (
                                      <span className="text-[10px] text-red-500 font-medium flex items-center gap-1">
                                        <AlertCircle className="w-3 h-3" /> Error
                                      </span>
                                    )}
                                    <button
                                      type="button"
                                      onClick={() => setAdForests((prev) => prev.filter((_, i) => i !== forestIdx))}
                                      className="text-[var(--muted-foreground)] hover:text-red-500 transition-colors"
                                      aria-label="Remove forest"
                                    >
                                      <X className="w-3.5 h-3.5" />
                                    </button>
                                  </div>
                                </div>
                                {/* Auth method selector for this forest */}
                                <div className="mb-2">
                                  <label className="block text-[11px] text-[var(--muted-foreground)] mb-1">Auth Method</label>
                                  <select
                                    value={forestAuthMethod}
                                    onChange={(e) => setAdForests((prev) => prev.map((f, i) =>
                                      i === forestIdx ? { ...f, authMethod: e.target.value, credentials: {}, status: 'idle', error: '', subscriptions: [] } : f
                                    ))}
                                    className="w-full px-2 py-1.5 bg-[var(--input-background)] border border-[var(--border)] rounded-lg text-[12px] focus:outline-none"
                                  >
                                    {microsoftProvider.authMethods
                                      .filter((m) => !m.windowsOnly)
                                      .map((m) => (
                                        <option key={m.id} value={m.id}>{m.name}</option>
                                      ))}
                                  </select>
                                </div>
                                {/* Credential fields */}
                                {forestAuthDef.fields.map((field) => (
                                  <div key={field.key} className="mb-2">
                                    <label className="block text-[11px] text-[var(--muted-foreground)] mb-1">{field.label}</label>
                                    {field.serverList ? (
                                      <ServerListInput
                                        servers={(forest.credentials[field.key] || '').split(',').map((s: string) => s.trim()).filter(Boolean)}
                                        onChange={(list) => setAdForests((prev) => prev.map((f, i) =>
                                          i === forestIdx ? { ...f, credentials: { ...f.credentials, [field.key]: list.join(', ') }, status: 'idle' } : f
                                        ))}
                                        placeholder={field.placeholder}
                                      />
                                    ) : (
                                      <input
                                        type={field.secret ? 'password' : 'text'}
                                        placeholder={field.placeholder}
                                        value={forest.credentials[field.key] || ''}
                                        onChange={(e) => setAdForests((prev) => prev.map((f, i) =>
                                          i === forestIdx ? { ...f, credentials: { ...f.credentials, [field.key]: e.target.value }, status: 'idle' } : f
                                        ))}
                                        className="w-full px-3 py-2 bg-[var(--input-background)] border border-[var(--border)] rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--infoblox-blue)]/30 focus:border-[var(--infoblox-blue)]"
                                      />
                                    )}
                                  </div>
                                ))}
                                {forest.error && (
                                  <p className="text-[11px] text-red-500 mb-2">{forest.error}</p>
                                )}
                                <button
                                  type="button"
                                  disabled={forest.status === 'validating'}
                                  onClick={() => validateAdForest(forestIdx)}
                                  className="flex items-center gap-1.5 px-3 py-1.5 bg-[var(--infoblox-blue)] text-white text-[12px] font-medium rounded-lg hover:bg-[var(--infoblox-blue)]/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                                >
                                  {forest.status === 'validating' ? (
                                    <><Loader2 className="w-3 h-3 animate-spin" /> Validating…</>
                                  ) : (
                                    'Validate Forest'
                                  )}
                                </button>
                              </div>
                            );
                          })}
                          {/* Add Forest button */}
                          <button
                            type="button"
                            onClick={() => setAdForests((prev) => [
                              ...prev,
                              { id: `forest-${Date.now()}`, authMethod: 'ntlm', credentials: {}, status: 'idle', error: '', subscriptions: [] },
                            ])}
                            className="flex items-center gap-1.5 px-3 py-1.5 border border-dashed border-[var(--border)] text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:border-[var(--infoblox-blue)] text-[12px] rounded-lg transition-colors"
                          >
                            <Plus className="w-3.5 h-3.5" />
                            Add Forest (different credentials)
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Step 3: Select Sources */}
          {currentStep === 'sources' && (
            <div>
              <h2 className="text-[18px] mb-1" style={{ fontWeight: 600 }}>
                Select which sources to scan
              </h2>
              <p className="text-[13px] text-[var(--muted-foreground)] mb-6">
                Choose the accounts, subscriptions, or servers to include in the assessment.
              </p>
              <div className="space-y-4">
                {selectedProviders.map((provId) => {
                  const provider = PROVIDERS.find((p) => p.id === provId)!;
                  const subs = subscriptions[provId] || [];
                  const mode = selectionMode[provId];
                  const isExcludeMode = mode === 'exclude';
                  // In include mode: checked = will scan. In exclude mode: checked = will SKIP.
                  const checkedCount = subs.filter((s) => s.selected).length;
                  const effectiveCount = getEffectiveSelectedCount(provId);
                  const searchTerm = sourceSearch[provId]?.toLowerCase() || '';
                  const filteredSubs = subs.filter((sub) =>
                    sub.name.toLowerCase().includes(searchTerm)
                  );
                  const filteredCheckedCount = filteredSubs.filter((s) => s.selected).length;
                  const allFilteredChecked = filteredSubs.length > 0 && filteredCheckedCount === filteredSubs.length;
                  const someFilteredChecked = filteredCheckedCount > 0 && !allFilteredChecked;

                  const selectAllFiltered = () => {
                    const filteredIds = new Set(filteredSubs.map((s) => s.id));
                    setSubscriptions((prev) => ({
                      ...prev,
                      [provId]: prev[provId].map((s) =>
                        filteredIds.has(s.id) ? { ...s, selected: true } : s
                      ),
                    }));
                  };

                  const deselectAllFiltered = () => {
                    const filteredIds = new Set(filteredSubs.map((s) => s.id));
                    setSubscriptions((prev) => ({
                      ...prev,
                      [provId]: prev[provId].map((s) =>
                        filteredIds.has(s.id) ? { ...s, selected: false } : s
                      ),
                    }));
                  };

                  const toggleAllFiltered = () => {
                    if (allFilteredChecked) {
                      deselectAllFiltered();
                    } else {
                      selectAllFiltered();
                    }
                  };

                  // Switch between include ↔ exclude mode
                  const switchMode = (newMode: 'include' | 'exclude') => {
                    if (newMode === mode) return;
                    // When switching modes, reset all checkboxes:
                    // Include→Exclude: clear all (= scan everything, exclude nothing)
                    // Exclude→Include: clear all (= scan nothing, user picks)
                    setSubscriptions((prev) => ({
                      ...prev,
                      [provId]: prev[provId].map((s) => ({ ...s, selected: false })),
                    }));
                    setSelectionMode((prev) => ({ ...prev, [provId]: newMode }));
                  };

                  return (
                    <div
                      key={provId}
                      className="bg-white rounded-xl border border-[var(--border)] overflow-hidden"
                    >
                      {/* Provider header with effective scan count */}
                      <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border)] bg-gray-50/50">
                        <div
                          className="w-8 h-8 rounded-lg flex items-center justify-center"
                          style={{ backgroundColor: `${provider.color}15` }}
                        >
                          <ProviderIconEl id={provId} className="w-4 h-4" color={provider.color} />
                        </div>
                        <span className="text-[14px]" style={{ fontWeight: 600 }}>
                          {provider.name} {provider.subscriptionLabel}
                        </span>
                        <span className="ml-auto flex items-center gap-2">
                          {effectiveCount > 0 && (
                            <span
                              className="px-2 py-0.5 rounded-full text-[11px] text-white"
                              style={{ backgroundColor: 'var(--infoblox-orange)', fontWeight: 600 }}
                            >
                              {effectiveCount}
                            </span>
                          )}
                          <span className="text-[12px] text-[var(--muted-foreground)]">
                            {effectiveCount} of {subs.length} will be scanned
                          </span>
                        </span>
                      </div>

                      {/* Mode toggle: Include / Exclude */}
                      <div className="px-3 pt-3 pb-1">
                        <div className="flex items-center gap-1 p-1 bg-gray-100 rounded-lg w-fit mb-2">
                          <button
                            onClick={() => switchMode('include')}
                            className={`px-3 py-1.5 rounded-md text-[12px] transition-all ${
                              !isExcludeMode
                                ? 'bg-white text-[var(--foreground)] shadow-sm'
                                : 'text-[var(--muted-foreground)] hover:text-[var(--foreground)]'
                            }`}
                            style={{ fontWeight: !isExcludeMode ? 600 : 400 }}
                          >
                            <span className="flex items-center gap-1.5">
                              <Check className="w-3 h-3" />
                              Include selected
                            </span>
                          </button>
                          <button
                            onClick={() => switchMode('exclude')}
                            className={`px-3 py-1.5 rounded-md text-[12px] transition-all ${
                              isExcludeMode
                                ? 'bg-white text-[var(--foreground)] shadow-sm'
                                : 'text-[var(--muted-foreground)] hover:text-[var(--foreground)]'
                            }`}
                            style={{ fontWeight: isExcludeMode ? 600 : 400 }}
                          >
                            <span className="flex items-center gap-1.5">
                              <Minus className="w-3 h-3" />
                              Exclude selected
                            </span>
                          </button>
                        </div>
                        <p className="text-[11px] text-[var(--muted-foreground)] mb-2">
                          {isExcludeMode
                            ? `All ${subs.length} will be scanned except the ${checkedCount} checked below.`
                            : checkedCount === 0
                              ? `Check the ${provider.subscriptionLabel.toLowerCase()} you want to scan.`
                              : `${checkedCount} of ${subs.length} checked — only these will be scanned.`
                          }
                        </p>
                      </div>

                      {/* Toolbar: search + bulk actions */}
                      <div className="px-3 pb-1 flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                        {/* Search */}
                        <div className="relative flex-1">
                          <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                          <input
                            type="text"
                            placeholder={`Search ${subs.length} ${provider.subscriptionLabel.toLowerCase()}...`}
                            value={sourceSearch[provId]}
                            onChange={(e) => setSourceSearch((prev) => ({ ...prev, [provId]: e.target.value }))}
                            className="w-full pl-9 pr-3 py-2 bg-[var(--input-background)] border border-[var(--border)] rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-[var(--infoblox-blue)]/30 focus:border-[var(--infoblox-blue)]"
                          />
                          {sourceSearch[provId] && (
                            <button
                              onClick={() => setSourceSearch((prev) => ({ ...prev, [provId]: '' }))}
                              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-[12px]"
                            >
                              ✕
                            </button>
                          )}
                        </div>
                        {/* Bulk actions */}
                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            onClick={toggleAllFiltered}
                            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-[12px] border border-[var(--border)] hover:bg-gray-50 transition-colors"
                            style={{ fontWeight: 500 }}
                            title={allFilteredChecked
                              ? (isExcludeMode ? 'Un-exclude all visible' : 'Deselect all visible')
                              : (isExcludeMode ? 'Exclude all visible' : 'Select all visible')
                            }
                          >
                            <div
                              className={`w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
                                allFilteredChecked
                                  ? (isExcludeMode
                                      ? 'bg-red-500 border-red-500'
                                      : 'bg-[var(--infoblox-orange)] border-[var(--infoblox-orange)]')
                                  : someFilteredChecked
                                    ? (isExcludeMode
                                        ? 'bg-red-500/60 border-red-500'
                                        : 'bg-[var(--infoblox-orange)]/60 border-[var(--infoblox-orange)]')
                                    : 'border-gray-300'
                              }`}
                            >
                              {allFilteredChecked && <Check className="w-2.5 h-2.5 text-white" />}
                              {someFilteredChecked && !allFilteredChecked && <Minus className="w-2.5 h-2.5 text-white" />}
                            </div>
                            {searchTerm
                              ? `All ${filteredSubs.length} visible`
                              : (isExcludeMode ? 'Exclude All' : 'Select All')
                            }
                          </button>
                          {checkedCount > 0 && (
                            <button
                              onClick={() => {
                                setSubscriptions((prev) => ({
                                  ...prev,
                                  [provId]: prev[provId].map((s) => ({ ...s, selected: false })),
                                }));
                              }}
                              className={`px-3 py-2 rounded-lg text-[12px] border transition-colors ${
                                isExcludeMode
                                  ? 'text-blue-600 border-blue-200 hover:bg-blue-50'
                                  : 'text-red-600 border-red-200 hover:bg-red-50'
                              }`}
                              style={{ fontWeight: 500 }}
                            >
                              {isExcludeMode ? 'Clear Exclusions' : 'Clear All'}
                            </button>
                          )}
                        </div>
                      </div>

                      {/* Showing X of Y when filtered */}
                      {searchTerm && (
                        <div className="px-3 py-1.5 text-[11px] text-[var(--muted-foreground)]">
                          Showing {filteredSubs.length} of {subs.length} {provider.subscriptionLabel.toLowerCase()}
                          {filteredCheckedCount > 0 && ` · ${filteredCheckedCount} ${isExcludeMode ? 'excluded' : 'selected'} in view`}
                        </div>
                      )}

                      {/* Scrollable list */}
                      <div
                        className="p-2 overflow-y-auto"
                        style={{ maxHeight: subs.length > 10 ? '400px' : undefined }}
                      >
                        {filteredSubs.length === 0 ? (
                          <div className="text-center py-8 text-[13px] text-[var(--muted-foreground)]">
                            No {provider.subscriptionLabel.toLowerCase()} match &ldquo;{sourceSearch[provId]}&rdquo;
                          </div>
                        ) : (
                          filteredSubs.map((sub) => {
                            const isChecked = sub.selected;
                            // Visual distinction: in exclude mode, checked = red strikethrough
                            return (
                              <button
                                key={sub.id}
                                onClick={() => toggleSubscription(provId, sub.id)}
                                className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-colors ${
                                  isChecked
                                    ? (isExcludeMode ? 'bg-red-50/70' : 'bg-orange-50/70')
                                    : 'hover:bg-gray-50'
                                }`}
                              >
                                <div
                                  className={`w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
                                    isChecked
                                      ? (isExcludeMode
                                          ? 'bg-red-500 border-red-500'
                                          : 'bg-[var(--infoblox-orange)] border-[var(--infoblox-orange)]')
                                      : 'border-gray-300'
                                  }`}
                                >
                                  {isChecked && (isExcludeMode
                                    ? <Minus className="w-3 h-3 text-white" />
                                    : <Check className="w-3 h-3 text-white" />
                                  )}
                                </div>
                                <span className={`text-[13px] truncate ${
                                  isChecked && isExcludeMode ? 'line-through text-[var(--muted-foreground)]' : ''
                                }`}>
                                  {sub.name}
                                </span>
                                {isChecked && isExcludeMode && (
                                  <span className="ml-auto text-[10px] text-red-500 shrink-0" style={{ fontWeight: 500 }}>
                                    EXCLUDED
                                  </span>
                                )}
                              </button>
                            );
                          })
                        )}
                      </div>

                      {/* Footer summary */}
                      {subs.length > 20 && (
                        <div className="px-4 py-2 border-t border-[var(--border)] bg-gray-50/50 text-[11px] text-[var(--muted-foreground)] flex items-center justify-between">
                          <span>
                            {subs.length} total {provider.subscriptionLabel.toLowerCase()}
                          </span>
                          <span style={{ fontWeight: 500 }}>
                            {isExcludeMode && checkedCount > 0
                              ? <span>{effectiveCount} will be scanned <span className="text-red-500">({checkedCount} excluded)</span></span>
                              : <span>{effectiveCount} selected for scan</span>
                            }
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })}

                {/* Additional AD Forests — shown in sources step when forests are validated */}
                {selectedProviders.includes('microsoft') && adForests.filter((f) => f.status === 'valid').map((forest, forestIdx) => (
                  <div key={forest.id} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
                    <div className="px-4 py-3 border-b border-[var(--border)] bg-[var(--surface-2)] flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <ProviderIconEl id="microsoft" className="w-4 h-4" />
                        <span className="text-[13px] font-semibold">
                          MS DHCP/DNS — Forest {forestIdx + 2}
                          {forest.credentials.servers ? ` (${forest.credentials.servers.split(',')[0].trim()})` : ''}
                        </span>
                      </div>
                      <span className="text-[11px] text-[var(--muted-foreground)]">
                        {forest.subscriptions.filter((s) => s.selected).length} selected
                      </span>
                    </div>
                    <div className="divide-y divide-[var(--border)] max-h-64 overflow-y-auto">
                      {forest.subscriptions.map((sub) => (
                        <button
                          key={sub.id}
                          type="button"
                          onClick={() => setAdForests((prev) => prev.map((f, i) =>
                            i === forestIdx
                              ? { ...f, subscriptions: f.subscriptions.map((s) => s.id === sub.id ? { ...s, selected: !s.selected } : s) }
                              : f
                          ))}
                          className={`w-full flex items-center gap-3 px-4 py-2.5 hover:bg-[var(--surface-2)] transition-colors text-left ${sub.selected ? 'bg-[var(--infoblox-blue)]/5' : ''}`}
                        >
                          <div className={`w-4 h-4 rounded border-2 flex-shrink-0 flex items-center justify-center ${sub.selected ? 'bg-[var(--infoblox-blue)] border-[var(--infoblox-blue)]' : 'border-[var(--border)]'}`}>
                            {sub.selected && <Check className="w-2.5 h-2.5 text-white" />}
                          </div>
                          <span className="text-[13px] truncate">{sub.name}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {currentStep === 'scanning' && (
            <div className="flex flex-col items-center justify-center py-12">
              <div className="w-full max-w-md">
                {scanProgress < 100 ? (
                  <div>
                    <div className="flex items-center justify-center mb-6">
                      <div className="relative">
                        <div className="w-20 h-20 rounded-full border-4 border-gray-200" />
                        <svg className="absolute inset-0 w-20 h-20 -rotate-90" viewBox="0 0 80 80">
                          <circle
                            cx="40"
                            cy="40"
                            r="36"
                            fill="none"
                            stroke="var(--infoblox-orange)"
                            strokeWidth="4"
                            strokeDasharray={`${(scanProgress / 100) * 226} 226`}
                            strokeLinecap="round"
                          />
                        </svg>
                        <div className="absolute inset-0 flex items-center justify-center text-[16px]" style={{ fontWeight: 600 }}>
                          {scanProgress}%
                        </div>
                      </div>
                    </div>
                    <h3 className="text-center text-[16px] mb-2" style={{ fontWeight: 600 }}>
                      Scanning {selectedProviders.length > 1 ? `${selectedProviders.length} providers in parallel` : 'your infrastructure'}...
                    </h3>
                    <p className="text-center text-[13px] text-[var(--muted-foreground)] mb-6">
                      Discovering DNS zones, DHCP scopes, and IP allocations
                    </p>
                    {/* Provider progress */}
                    <div className="space-y-2">
                      {selectedProviders.map((provId) => {
                        const provider = PROVIDERS.find((p) => p.id === provId)!;
                        const provProgress = providerScanProgress[provId] ?? 0;
                        return (
                          <div key={provId} className="flex items-center gap-3">
                            <span className="text-[12px] w-20 text-right text-[var(--muted-foreground)]">
                              {provider.name}
                            </span>
                            <div className="flex-1 h-2 bg-gray-200 rounded-full overflow-hidden">
                              <div
                                className="h-full rounded-full transition-all duration-300"
                                style={{
                                  width: `${provProgress}%`,
                                  backgroundColor: provider.color,
                                }}
                              />
                            </div>
                            {provProgress >= 100 && (
                              <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0" />
                            )}
                            {provProgress < 100 && provProgress > 0 && (
                              <Loader2 className="w-4 h-4 text-gray-400 animate-spin shrink-0" />
                            )}
                            {provProgress <= 0 && (
                              <Circle className="w-4 h-4 text-gray-300 shrink-0" />
                            )}
                          </div>
                        );
                      })}
                    </div>
                    {scanError && (
                      <div className="mt-4 flex items-start gap-2 p-3 bg-red-50 rounded-lg border border-red-200">
                        <AlertCircle className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
                        <div>
                          <p className="text-[13px] text-red-700" style={{ fontWeight: 500 }}>{scanError}</p>
                          <button
                            onClick={startScan}
                            className="mt-1 text-[12px] text-red-600 underline hover:text-red-800"
                          >
                            Retry scan
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="text-center">
                    <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-green-100 flex items-center justify-center">
                      <CheckCircle2 className="w-8 h-8 text-green-600" />
                    </div>
                    <h3 className="text-[16px] mb-2" style={{ fontWeight: 600 }}>
                      Scan Complete
                    </h3>
                    <p className="text-[13px] text-[var(--muted-foreground)]">
                      Found {findings.length} line items across{' '}
                      {selectedProviders.length} provider{selectedProviders.length > 1 ? 's' : ''}.
                      Click Next to view results and export.
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}

        </div>
          {/* Step 5: Results & Export */}
          {currentStep === 'results' && isEstimatorOnly && (
            <SizerResultsView onResetNavigate={restart} />
          )}
          {currentStep === 'results' && !isEstimatorOnly && (
            <ResultsSurface
              mode="scan"
              wizardBag={{
                mode: 'scan',
                findings,
                effectiveFindings,
                filteredSortedFindings,
                filteredTokenTotal,
                rawTotalTokens,
                uddiPerRowTotal,
                totalTokens,
                totalServerTokens,
                reportingTokens,
                hasServerMetrics,
                categoryTotals,
                hybridScenario,
                selectedProviders,
                growthBufferPct,
                setGrowthBufferPct,
                serverGrowthBufferPct,
                setServerGrowthBufferPct,
                importedProviders,
                liveScannedProviders,
                isEstimatorOnly,
                heroCollapsed,
                setHeroCollapsed,
                showAllHeroSources,
                setShowAllHeroSources,
                showAllCategorySources,
                setShowAllCategorySources,
                bomCopied,
                setBomCopied,
                topDnsExpanded,
                setTopDnsExpanded,
                topDhcpExpanded,
                setTopDhcpExpanded,
                topIpExpanded,
                setTopIpExpanded,
                niosServerMetrics,
                effectiveNiosMetrics,
                niosMigrationMap,
                setNiosMigrationMap,
                memberSearchFilter,
                setMemberSearchFilter,
                showGridMemberDetails,
                setShowGridMemberDetails,
                gridMemberDetailSearch,
                setGridMemberDetailSearch,
                niosGridFeatures,
                niosGridLicenses,
                niosMigrationFlags,
                gridFeaturesOpen,
                setGridFeaturesOpen,
                migrationFlagsOpen,
                setMigrationFlagsOpen,
                memberSavings,
                fleetSavings,
                variantOverrides,
                setVariantOverrides,
                adServerMetrics,
                effectiveADMetrics,
                adMigrationMap,
                setAdMigrationMap,
                adMemberSearchFilter,
                setAdMemberSearchFilter,
                countOverrides,
                setCountOverrides,
                editingFindingKey,
                setEditingFindingKey,
                editingCountValue,
                setEditingCountValue,
                serverMetricOverrides,
                setServerMetricOverrides,
                editingServerMetric,
                setEditingServerMetric,
                editingServerValue,
                setEditingServerValue,
                findingsCollapsed,
                setFindingsCollapsed,
                findingsProviderFilter,
                setFindingsProviderFilter,
                findingsCategoryFilter,
                setFindingsCategoryFilter,
                findingsSort,
                setFindingsSort,
                findingKey,
                exportCSV,
                downloadXlsxFromBackend,
                saveSession,
                restart,
                setCurrentStep,
                handleSizerImportConfirm,
                credentials,
                outlineSections,
              }}
            />
          )}
      </div>

      {/* Bottom navigation — hidden in Sizer mode; SizerWizard owns its own Back/Next */}
      {currentStep !== 'results' && !(isEstimatorOnly && currentStep === 'credentials') && (
        <div className="bg-white border-t border-[var(--border)] shrink-0">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
            <button
              onClick={goBack}
              disabled={currentIndex === 0}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-[13px] transition-colors ${
                currentIndex === 0
                  ? 'text-gray-300 cursor-not-allowed'
                  : 'text-[var(--foreground)] hover:bg-gray-100'
              }`}
              style={{ fontWeight: 500 }}
            >
              <ChevronLeft className="w-4 h-4" />
              Back
            </button>
            <button
              onClick={goNext}
              disabled={!canGoNext()}
              className={`flex items-center gap-2 px-6 py-2.5 rounded-lg text-[13px] transition-colors ${
                canGoNext()
                  ? 'bg-[var(--infoblox-orange)] text-white hover:bg-[var(--infoblox-orange)]/90 shadow-sm'
                  : 'bg-gray-200 text-gray-400 cursor-not-allowed'
              }`}
              style={{ fontWeight: 600 }}
            >
              {currentStep === 'scanning' ? 'View Results' : 'Next'}
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Footer */}
      <footer className="bg-[var(--infoblox-navy)] text-white/50 shrink-0 mt-auto">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-3 flex flex-col sm:flex-row items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-[11px]">
            <span>Made with</span>
            <Heart className="w-3 h-3 text-red-400 fill-red-400" />
            <span>by</span>
            <a
              href="https://github.com/stefanriegel"
              target="_blank"
              rel="noopener noreferrer"
              className="text-white/80 hover:text-white transition-colors underline underline-offset-2 decoration-white/30 hover:decoration-white/60"
              style={{ fontWeight: 500 }}
            >
              Stefan Riegel
            </a>
          </div>
          <a
            href="https://github.com/stefanriegel"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-[11px] text-white/70 hover:text-white transition-colors"
          >
            <Github className="w-3.5 h-3.5" />
            <span>github.com/stefanriegel</span>
          </a>
        </div>
      </footer>
    </div>
    </SizerProvider>
  );
}