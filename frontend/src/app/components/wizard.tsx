import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
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
} from 'lucide-react';
import { Tooltip, TooltipTrigger, TooltipContent } from './ui/tooltip';
import { useBackendConnection } from './use-backend';
import {
  validateCredentials as apiValidate,
  uploadNiosBackup as apiUploadNios,
  validateBluecat as apiValidateBluecat,
  validateEfficientip as apiValidateEfficientip,
  validateNiosWapi as apiValidateNiosWapi,
  discoverADServers as apiDiscoverADServers,
  startScan as apiStartScan,
  getScanStatus as apiGetScanStatus,
  getScanResults as apiGetScanResults,
  getSessionId,
  cloneSession,
  type ScanStatusResponse,
  type ADDiscoveredServer,
  type ADServerMetricAPI,
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
import { calcEstimator, calcReportingTokens, computeEstimatorWarnings, REPORTING_DESTINATIONS, EstimatorDefaults, type EstimatorInputs, type ReportingDestinationInput, type ReportingDestinationResult, type ServerEntry, type ServerTokenDetail } from './estimator-calc';
import { exportSession, importSession, type SessionSnapshot } from './session-io';
type Step = 'providers' | 'credentials' | 'sources' | 'scanning' | 'results';
type SortColumn = 'provider' | 'source' | 'category' | 'item' | 'count' | 'managementTokens';
type SortDir = 'asc' | 'desc';

/** Effective object count for server token tier sizing: DDI objects + Active IPs (DHCP). */
function serverSizingObjects(m: NiosServerMetrics): number {
  return m.objectCount + (m.activeIPCount ?? 0);
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

  // State
  const [selectedProviders, setSelectedProviders] = useState<ProviderType[]>([]);
  const isNiosOnly = selectedProviders.length === 1 && selectedProviders[0] === 'nios';
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
  // Manual count overrides (issue #28): keyed by "provider::source::item", value is the user-entered count.
  // When set, the override replaces the original count and recalculates managementTokens.
  const [countOverrides, setCountOverrides] = useState<Record<string, number>>({});
  // Which finding row is currently being edited (click-to-edit count cell)
  const [editingFindingKey, setEditingFindingKey] = useState<string | null>(null);
  const [editingCountValue, setEditingCountValue] = useState<string>('');
  const [credentialError, setCredentialError] = useState<Record<ProviderType, string>>({
    aws: '', azure: '', gcp: '', microsoft: '', nios: '', bluecat: '', efficientip: '', estimator: '',
  });
  const [deviceCodeMessage, setDeviceCodeMessage] = useState<string>('');
  const [scanError, setScanError] = useState<string>('');
  const [importError, setImportError] = useState<string>('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scanIntervalsRef = useRef<ReturnType<typeof setInterval>[]>([]);
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});
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
  const [bomCopied, setBomCopied] = useState(false);

  // NIOS-specific state
  const [efficientipAPIVersion, setEfficientipAPIVersion] = useState<'legacy' | 'v2'>('legacy');
  const [niosMode, setNiosMode] = useState<'backup' | 'wapi'>('backup');
  const [niosUploadedFile, setNiosUploadedFile] = useState<File | null>(null);
  const [niosDragOver, setNiosDragOver] = useState(false);
  // NIOS-X migration planner: which NIOS sources (grid members) to migrate, with per-member form factor
  const [niosMigrationMap, setNiosMigrationMap] = useState<Map<string, ServerFormFactor>>(new Map());
  const [memberSearchFilter, setMemberSearchFilter] = useState('');
  const [adMigrationMap, setAdMigrationMap] = useState<Map<string, ServerFormFactor>>(new Map());
  const [adMemberSearchFilter, setAdMemberSearchFilter] = useState('');

  // Backend wiring: NIOS backup token returned from upload, and live server metrics from scan results
  const [backupToken, setBackupToken] = useState<string>('');
  const [niosServerMetrics, setNiosServerMetrics] = useState<NiosServerMetrics[]>([]);

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
      // Estimator skips the sources step — jump straight to scanning
      if (nextStep === 'sources' && selectedProviders.includes('estimator')) {
        setCurrentStep('scanning');
        startScan();
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
    setCountOverrides({});
    setCredentialError({ aws: '', azure: '', gcp: '', microsoft: '', nios: '', bluecat: '', efficientip: '', estimator: '' });
    setScanError('');
    setSourceSearch({ aws: '', azure: '', gcp: '', microsoft: '', nios: '', bluecat: '', efficientip: '', estimator: '' });
    setSelectionMode({ aws: 'include', azure: 'include', gcp: 'include', microsoft: 'include', nios: 'include', bluecat: 'include', efficientip: 'include', estimator: 'include' });
    setNiosMode('backup');
    setNiosUploadedFile(null);
    setNiosDragOver(false);
    setNiosMigrationMap(new Map());
    setMemberSearchFilter('');
    setBackupToken('');
    setNiosServerMetrics([]);
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
    setBomCopied(false);
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
    setCountOverrides({});

    // ── Manual Estimator short-circuit (no API call) ───────────────────────
    if (selectedProviders.includes('estimator')) {
      const out = calcEstimator(estimatorAnswers);
      const estimatorFindings: FindingRow[] = [];
      if (out.ddiObjects > 0) estimatorFindings.push({
        provider: 'estimator', source: 'Manual Estimator',
        category: 'DDI Object', item: 'Estimated DDI Objects', count: out.ddiObjects,
        tokensPerUnit: TOKEN_RATES['DDI Object'], managementTokens: Math.ceil(out.ddiObjects / TOKEN_RATES['DDI Object']),
      });
      if (out.activeIPs > 0) estimatorFindings.push({
        provider: 'estimator', source: 'Manual Estimator',
        category: 'Active IP', item: 'Estimated Active IPs', count: out.activeIPs,
        tokensPerUnit: TOKEN_RATES['Active IP'], managementTokens: Math.ceil(out.activeIPs / TOKEN_RATES['Active IP']),
      });
      if (out.discoveredAssets > 0) estimatorFindings.push({
        provider: 'estimator', source: 'Manual Estimator',
        category: 'Asset', item: 'Estimated Assets', count: out.discoveredAssets,
        tokensPerUnit: TOKEN_RATES['Asset'], managementTokens: Math.ceil(out.discoveredAssets / TOKEN_RATES['Asset']),
      });
      setFindings(estimatorFindings);
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
            setFindings(merged);
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
              // Extract hostnames from subscription names (format: "hostname (role)")
              entry.selectedMembers = (subscriptions.nios || [])
                .filter((s) => s.selected)
                .map((s) => s.name.replace(/\s*\(.*\)$/, ''));
            }
            return entry;
          }),
        };
        const { scanId } = await apiStartScan(scanReq);

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
                category: toFrontendCategory(f.category),
                item: f.item,
                count: f.count,
                tokensPerUnit: f.tokensPerUnit,
                managementTokens: f.managementTokens,
              }));
              setFindings(mapped);
              setScanProgress(100);
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
                })));
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
  }, [backend.isDemo, selectedProviders, selectedAuthMethod, credentials, selectionMode, clearScanIntervals, getEffectiveSelected, backupToken, subscriptions]);

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
  const totalTokens = useMemo(
    () => {
      const raw = effectiveFindings.reduce((sum, f) => sum + f.managementTokens, 0);
      return Math.ceil(raw * (1 + growthBufferPct));
    },
    [effectiveFindings, growthBufferPct]
  );

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
    const totals = { 'DDI Object': 0, 'Active IP': 0, 'Asset': 0 };
    effectiveFindings.forEach((f) => {
      totals[f.category] += f.managementTokens;
    });
    return totals;
  }, [effectiveFindings]);

  // Migration-map-aware server token count for SKU widget and exports.
  // When a migration map is set, computes XaaS-consolidated tokens for XaaS DCs
  // and NIOS-X tier tokens for NIOS-X DCs. Falls back to raw serverTokens when
  // no migration selections have been made (full-environment baseline).
  const totalServerTokens = useMemo(() => {
    const niosTokens = selectedProviders.includes('nios')
      ? effectiveNiosMetrics.reduce((s, m) =>
          s + calcServerTokenTier(m.qps, m.lps, serverSizingObjects(m), 'nios-x').serverTokens, 0)
      : 0;

    let adTokens = 0;
    if (selectedProviders.includes('microsoft') && effectiveADMetrics.length > 0) {
      if (adMigrationMap.size > 0) {
        // Use the same logic as the AD Server Token Calculator panel:
        // split selected DCs by form factor, consolidate XaaS instances.
        const selectedDcs = effectiveADMetrics.filter(m => adMigrationMap.has(m.hostname));
        const niosXDcs = selectedDcs.filter(m => adMigrationMap.get(m.hostname) !== 'nios-xaas');
        const xaasDcs  = selectedDcs.filter(m => adMigrationMap.get(m.hostname) === 'nios-xaas');
        const niosXTokens = niosXDcs.reduce((s, m) =>
          s + calcServerTokenTier(m.qps, m.lps, m.dnsObjects + m.dhcpObjectsWithOverhead, 'nios-x').serverTokens, 0);
        const xaasInstances = consolidateXaasInstances(xaasDcs.map(m => ({
          memberId: m.hostname, memberName: m.hostname, role: 'DC',
          qps: m.qps, lps: m.lps, objectCount: m.dnsObjects + m.dhcpObjectsWithOverhead, activeIPCount: 0,
        })));
        const xaasTokens = xaasInstances.reduce((s, inst) => s + inst.totalTokens, 0);
        adTokens = niosXTokens + xaasTokens;
      } else {
        // No migration selections yet — show full-environment baseline.
        adTokens = effectiveADMetrics.reduce((s, m) => s + m.serverTokens, 0);
      }
    }

    return niosTokens + adTokens + estimatorServerTokens;
  }, [effectiveNiosMetrics, effectiveADMetrics, adMigrationMap, selectedProviders, estimatorServerTokens]);

  const hasServerMetrics = (selectedProviders.includes('nios') && effectiveNiosMetrics.length > 0)
    || (selectedProviders.includes('microsoft') && effectiveADMetrics.length > 0)
    || estimatorServerTokens > 0;

  // Hybrid-scenario totals — only meaningful when a migration map has selections.
  // Uses the same logic as the Migration Planner scenario cards.
  const hybridScenario = useMemo(() => {
    const hasNiosSelections = selectedProviders.includes('nios') && niosMigrationMap.size > 0;
    const hasAdSelections   = selectedProviders.includes('microsoft') && adMigrationMap.size > 0;
    if (!hasNiosSelections && !hasAdSelections) return null;

    // ── Management tokens ──────────────────────────────────────────────────
    let hybridMgmt = 0;
    // Non-NIOS findings always count at full management token value
    hybridMgmt += effectiveFindings.filter(f => f.provider !== 'nios').reduce((s, f) => s + f.managementTokens, 0);
    if (hasNiosSelections) {
      const nf = effectiveFindings.filter(f => f.provider === 'nios');
      // Migrating members → UDDI native rates (25/13/3), recalculated from raw counts
      hybridMgmt += nf
        .filter(f => niosMigrationMap.has(f.source))
        .reduce((s, f) => s + Math.ceil(f.count / TOKEN_RATES[f.category as keyof typeof TOKEN_RATES || 'DDI Object']), 0);
      // Staying members → NIOS licensing (no UDDI mgmt tokens)
    } else if (selectedProviders.includes('nios')) {
      // No NIOS selections → treat all NIOS as migrated (full universal DDI baseline at native rates)
      hybridMgmt += effectiveFindings
        .filter(f => f.provider === 'nios')
        .reduce((s, f) => s + Math.ceil(f.count / (TOKEN_RATES[f.category as keyof typeof TOKEN_RATES] ?? 25)), 0);
    }

    // ── Server tokens ──────────────────────────────────────────────────────
    let hybridSrv = 0;
    if (hasNiosSelections) {
      const selected = effectiveNiosMetrics.filter(m => niosMigrationMap.has(m.memberName));
      const niosX = selected.filter(m => niosMigrationMap.get(m.memberName) !== 'nios-xaas');
      const xaas  = selected.filter(m => niosMigrationMap.get(m.memberName) === 'nios-xaas');
      hybridSrv += niosX.reduce((s, m) => s + calcServerTokenTier(m.qps, m.lps, serverSizingObjects(m), 'nios-x').serverTokens, 0);
      const xaasInst = consolidateXaasInstances(xaas.map(m => ({
        memberId: m.memberName, memberName: m.memberName, role: 'GM',
        qps: m.qps, lps: m.lps, objectCount: serverSizingObjects(m), activeIPCount: 0,
      })));
      hybridSrv += xaasInst.reduce((s, inst) => s + inst.totalTokens, 0);
    }
    if (hasAdSelections) {
      const selectedDcs = effectiveADMetrics.filter(m => adMigrationMap.has(m.hostname));
      const niosXDcs = selectedDcs.filter(m => adMigrationMap.get(m.hostname) !== 'nios-xaas');
      const xaasDcs  = selectedDcs.filter(m => adMigrationMap.get(m.hostname) === 'nios-xaas');
      hybridSrv += niosXDcs.reduce((s, m) =>
        s + calcServerTokenTier(m.qps, m.lps, m.dnsObjects + m.dhcpObjectsWithOverhead, 'nios-x').serverTokens, 0);
      const xaasInst = consolidateXaasInstances(xaasDcs.map(m => ({
        memberId: m.hostname, memberName: m.hostname, role: 'DC',
        qps: m.qps, lps: m.lps, objectCount: m.dnsObjects + m.dhcpObjectsWithOverhead, activeIPCount: 0,
      })));
      hybridSrv += xaasInst.reduce((s, inst) => s + inst.totalTokens, 0);
    }

    const selectionCount = niosMigrationMap.size + adMigrationMap.size;
    return { mgmt: hybridMgmt, srv: hybridSrv, selectionCount };
  }, [effectiveFindings, effectiveNiosMetrics, effectiveADMetrics, niosMigrationMap, adMigrationMap, selectedProviders]);

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
      const nonNios = effectiveFindings.filter((f) => f.provider !== 'nios').reduce((s, f) => s + f.managementTokens, 0);
      const allNios = calcNiosTokens(nf);
      const migrating = nf.filter((f) => niosMigrationMap.has(f.source)).reduce((s, f) => s + Math.ceil(f.count / (TOKEN_RATES[f.category as keyof typeof TOKEN_RATES] ?? 25)), 0);
      const stayingNios = calcNiosTokens(nf.filter((f) => !niosMigrationMap.has(f.source)));
      summary += `\n\nNIOS-X Migration Planner`;
      summary += `\nScenario,UDDI Tokens,NIOS Licensing Tokens`;
      summary += `\nCurrent (NIOS Only),${nonNios},${allNios}`;
      summary += `\nHybrid (${niosMigrationMap.size} members migrated),${nonNios + migrating},${stayingNios}`;
      summary += `\nFull Universal DDI,${nonNios + nf.reduce((s, f) => s + f.managementTokens, 0)},0`;
      summary += `\n\nMembers migrated:`;
      niosMigrationMap.forEach((ff, src) => { summary += `\n,${src},${ff === 'nios-xaas' ? 'XaaS' : 'NIOS-X'}`; });
    }
    if (selectedProviders.includes('nios')) {
      const niosSources = new Set(effectiveFindings.filter((f) => f.provider === 'nios').map((f) => f.source));
      const metricsToExport = niosMigrationMap.size > 0
        ? effectiveNiosMetrics.filter((m) => niosMigrationMap.has(m.memberName))
        : effectiveNiosMetrics.filter((m) => niosSources.has(m.memberName));
      if (metricsToExport.length > 0) {
        const niosXMetrics = metricsToExport.filter((m) => (niosMigrationMap.get(m.memberName) || 'nios-x') === 'nios-x');
        const xaasMetrics = metricsToExport.filter((m) => niosMigrationMap.get(m.memberName) === 'nios-xaas');
        const xaasInst = consolidateXaasInstances(xaasMetrics);
        const hasAnyXaas = xaasMetrics.length > 0;
        summary += `\n\nServer Token Calculator`;
        summary += `\nGrid Member,Role,Form Factor,QPS (Peak),LPS (Peak),Objects,Connections,Server Size,Allocated Tokens`;
        // NIOS-X individual members
        niosXMetrics.forEach((m) => {
          const tier = calcServerTokenTier(m.qps, m.lps, serverSizingObjects(m), 'nios-x');
          summary += `\n${m.memberName},${m.role},NIOS-X,${m.qps},${m.lps},${serverSizingObjects(m)},—,${tier.name},${tier.serverTokens}`;
        });
        // XaaS consolidated instances
        xaasInst.forEach((inst) => {
          summary += `\n--- XaaS Instance ${xaasInst.length > 1 ? inst.index + 1 : ''} (replaces ${inst.connectionsUsed} NIOS members) ---`;
          inst.members.forEach((m) => {
            summary += `\n  ${m.memberName},${m.role},XaaS (1 conn),${m.qps},${m.lps},${serverSizingObjects(m)},,,(consolidated)`;
          });
          summary += `\n  AGGREGATE,,XaaS,${inst.totalQps},${inst.totalLps},${inst.totalObjects},${inst.connectionsUsed}/${inst.tier.maxConnections} conn,${inst.tier.name},${inst.totalTokens}`;
          if (inst.extraConnections > 0) {
            summary += ` (incl. ${inst.extraConnectionTokens} extra connection tokens)`;
          }
        });
        const niosXTokens = niosXMetrics.reduce((s, m) => s + calcServerTokenTier(m.qps, m.lps, serverSizingObjects(m), 'nios-x').serverTokens, 0);
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
      const toNiosMetrics = (m: ADServerMetricAPI): NiosServerMetrics => ({
        memberId: m.hostname, memberName: m.hostname, role: 'DC',
        qps: m.qps, lps: m.lps, objectCount: m.dnsObjects + m.dhcpObjectsWithOverhead, activeIPCount: 0,
      });
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
          const objCount = m.dnsObjects + m.dhcpObjectsWithOverhead;
          const tier = calcServerTokenTier(m.qps, m.lps, objCount, 'nios-x');
          summary += `\n${m.hostname},DC,NIOS-X,${m.qps},${m.lps},${objCount},—,${tier.name},${tier.serverTokens}`;
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
        const adNiosXTokens = niosXDcs.reduce((s, m) => s + calcServerTokenTier(m.qps, m.lps, m.dnsObjects + m.dhcpObjectsWithOverhead, 'nios-x').serverTokens, 0);
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
    summary += `\nGrowth Buffer,${Math.round(growthBufferPct * 100)}%`;
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
      const nonNios = effectiveFindings.filter((f) => f.provider !== 'nios').reduce((s, f) => s + f.managementTokens, 0);
      const allNios = calcNiosTokens(nf);
      const migrating = nf.filter((f) => niosMigrationMap.has(f.source)).reduce((s, f) => s + Math.ceil(f.count / (TOKEN_RATES[f.category as keyof typeof TOKEN_RATES] ?? 25)), 0);
      const stayingNios = calcNiosTokens(nf.filter((f) => !niosMigrationMap.has(f.source)));
      html += '<br/><h3>NIOS-X Migration Planner</h3>';
      html += '<table border="1" cellpadding="4" cellspacing="0">';
      html += '<tr style="background:#002B49;color:white"><th>Scenario</th><th>UDDI Tokens</th><th>NIOS Licensing</th></tr>';
      html += `<tr><td>Current (NIOS Only)</td><td>${nonNios.toLocaleString()}</td><td>${allNios.toLocaleString()}</td></tr>`;
      html += `<tr style="background:#FFF3E0"><td>Hybrid (${niosMigrationMap.size} members migrated)</td><td><b>${(nonNios + migrating).toLocaleString()}</b></td><td>${stayingNios.toLocaleString()}</td></tr>`;
      html += `<tr><td>Full Universal DDI</td><td><b>${(nonNios + nf.reduce((s, f) => s + f.managementTokens, 0)).toLocaleString()}</b></td><td>0</td></tr>`;
      html += '</table>';
      html += '<br/><p><b>Members migrated:</b></p><ul>';
      niosMigrationMap.forEach((ff, src) => { html += `<li>${src} → ${ff === 'nios-xaas' ? 'NIOS-X as a Service' : 'NIOS-X'}</li>`; });
      html += '</ul>';
    }
    if (selectedProviders.includes('nios')) {
      const niosSources = new Set(effectiveFindings.filter((f) => f.provider === 'nios').map((f) => f.source));
      const metricsToExport = niosMigrationMap.size > 0
        ? effectiveNiosMetrics.filter((m) => niosMigrationMap.has(m.memberName))
        : effectiveNiosMetrics.filter((m) => niosSources.has(m.memberName));
      if (metricsToExport.length > 0) {
        const niosXMetrics = metricsToExport.filter((m) => (niosMigrationMap.get(m.memberName) || 'nios-x') === 'nios-x');
        const xaasMetrics = metricsToExport.filter((m) => niosMigrationMap.get(m.memberName) === 'nios-xaas');
        const xaasInst = consolidateXaasInstances(xaasMetrics);
        const hasAnyXaas = xaasMetrics.length > 0;
        html += `<br/><h3>Server Token Calculator</h3>`;
        html += '<table border="1" cellpadding="4" cellspacing="0">';
        html += `<tr style="background:#065f46;color:white"><th>Grid Member</th><th>Role</th><th>Form Factor</th><th>QPS (Peak)</th><th>LPS (Peak)</th><th>Objects</th><th>Size</th><th>Allocated Tokens</th></tr>`;
        // NIOS-X individual members
        niosXMetrics.forEach((m) => {
          const tier = calcServerTokenTier(m.qps, m.lps, serverSizingObjects(m), 'nios-x');
          html += `<tr><td>${m.memberName}</td><td>${m.role}</td><td>NIOS-X</td><td>${m.qps.toLocaleString()}</td><td>${m.lps.toLocaleString()}</td><td>${serverSizingObjects(m).toLocaleString()}</td><td>${tier.name}</td><td style="text-align:center;font-weight:bold">${tier.serverTokens.toLocaleString()}</td></tr>`;
        });
        // XaaS consolidated instances
        xaasInst.forEach((inst) => {
          html += `<tr style="background:#f3e8ff"><td colspan="8" style="font-weight:bold;color:#6b21a8">XaaS Instance${xaasInst.length > 1 ? ' ' + (inst.index + 1) : ''} — replaces ${inst.connectionsUsed} NIOS member${inst.connectionsUsed > 1 ? 's' : ''}</td></tr>`;
          inst.members.forEach((m) => {
            html += `<tr style="background:#faf5ff"><td style="padding-left:20px">${m.memberName}</td><td>${m.role}</td><td style="color:#7c3aed">1 conn</td><td style="color:#7c3aed">${m.qps.toLocaleString()}</td><td style="color:#7c3aed">${m.lps.toLocaleString()}</td><td style="color:#7c3aed">${serverSizingObjects(m).toLocaleString()}</td><td colspan="2" style="text-align:center;color:#999">(consolidated)</td></tr>`;
          });
          html += `<tr style="background:#ede9fe"><td style="padding-left:20px;font-weight:600">Aggregate (${inst.connectionsUsed}/${inst.tier.maxConnections} connections${inst.extraConnections > 0 ? ', +' + inst.extraConnections + ' extra' : ''})</td><td style="font-weight:600">XaaS</td><td style="font-weight:600">${inst.connectionsUsed} conn</td><td style="font-weight:600">${inst.totalQps.toLocaleString()}</td><td style="font-weight:600">${inst.totalLps.toLocaleString()}</td><td style="font-weight:600">${inst.totalObjects.toLocaleString()}</td><td style="font-weight:600">${inst.tier.name}</td><td style="text-align:center;font-weight:bold;color:#6b21a8">${inst.totalTokens.toLocaleString()}${inst.extraConnectionTokens > 0 ? ' (incl. ' + inst.extraConnectionTokens.toLocaleString() + ' extra conn)' : ''}</td></tr>`;
        });
        const niosXTokens = niosXMetrics.reduce((s, m) => s + calcServerTokenTier(m.qps, m.lps, serverSizingObjects(m), 'nios-x').serverTokens, 0);
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
      const toNiosMetrics = (m: ADServerMetricAPI): NiosServerMetrics => ({
        memberId: m.hostname, memberName: m.hostname, role: 'DC',
        qps: m.qps, lps: m.lps, objectCount: m.dnsObjects + m.dhcpObjectsWithOverhead, activeIPCount: 0,
      });
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
          const objCount = m.dnsObjects + m.dhcpObjectsWithOverhead;
          const tier = calcServerTokenTier(m.qps, m.lps, objCount, 'nios-x');
          html += `<tr><td>${m.hostname}</td><td>DC</td><td>NIOS-X</td><td>${m.qps.toLocaleString()}</td><td>${m.lps.toLocaleString()}</td><td>${objCount.toLocaleString()}</td><td>${tier.name}</td><td style="text-align:center;font-weight:bold">${tier.serverTokens.toLocaleString()}</td></tr>`;
        });
        xaasInst.forEach(inst => {
          html += `<tr style="background:#f3e8ff"><td colspan="8" style="font-weight:bold;color:#6b21a8">XaaS Instance${xaasInst.length > 1 ? ' ' + (inst.index + 1) : ''} — replaces ${inst.connectionsUsed} DC${inst.connectionsUsed > 1 ? 's' : ''}</td></tr>`;
          inst.members.forEach(mem => {
            html += `<tr style="background:#faf5ff"><td style="padding-left:20px">${mem.memberName}</td><td>DC</td><td style="color:#7c3aed">1 conn</td><td style="color:#7c3aed">${mem.qps.toLocaleString()}</td><td style="color:#7c3aed">${mem.lps.toLocaleString()}</td><td style="color:#7c3aed">${mem.objectCount.toLocaleString()}</td><td colspan="2" style="text-align:center;color:#999">(consolidated)</td></tr>`;
          });
          html += `<tr style="background:#ede9fe"><td style="padding-left:20px;font-weight:600">Aggregate (${inst.connectionsUsed}/${inst.tier.maxConnections} connections${inst.extraConnections > 0 ? ', +' + inst.extraConnections + ' extra' : ''})</td><td style="font-weight:600">XaaS</td><td style="font-weight:600">${inst.connectionsUsed} conn</td><td style="font-weight:600">${inst.totalQps.toLocaleString()}</td><td style="font-weight:600">${inst.totalLps.toLocaleString()}</td><td style="font-weight:600">${inst.totalObjects.toLocaleString()}</td><td style="font-weight:600">${inst.tier.name}</td><td style="text-align:center;font-weight:bold;color:#6b21a8">${inst.totalTokens.toLocaleString()}${inst.extraConnectionTokens > 0 ? ' (incl. ' + inst.extraConnectionTokens.toLocaleString() + ' extra conn)' : ''}</td></tr>`;
        });
        const adNiosXTokens = niosXDcs.reduce((s, m) => s + calcServerTokenTier(m.qps, m.lps, m.dnsObjects + m.dhcpObjectsWithOverhead, 'nios-x').serverTokens, 0);
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
    html += `<p>Growth Buffer: ${Math.round(growthBufferPct * 100)}%</p>`;
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
        reportingDestEnabled,
        reportingDestEvents,
      },
      backend.health?.version ?? 'dev'
    );
    downloadFile(json, `ddi-session-${date}.json`, 'application/json');
  };

  const restoreSession = (snapshot: SessionSnapshot) => {
    restart();
    setSelectedProviders(snapshot.selectedProviders);
    setFindings(snapshot.findings);
    setCountOverrides(snapshot.countOverrides);
    setNiosMigrationMap(new Map(Object.entries(snapshot.niosMigrationMap)));
    setAdMigrationMap(new Map(Object.entries(snapshot.adMigrationMap)));
    setNiosServerMetrics(snapshot.niosServerMetrics);
    setAdServerMetrics(snapshot.adServerMetrics);
    setEstimatorAnswers(snapshot.estimatorAnswers);
    setGrowthBufferPct(snapshot.growthBufferPct);
    setReportingDestEnabled(snapshot.reportingDestEnabled);
    setReportingDestEvents(snapshot.reportingDestEvents);
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
                <span className="hidden sm:inline">Connected v{backend.health?.version}</span>
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

      {/* Stepper */}
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
                            ? 'text-[var(--infoblox-green)]'
                            : 'text-gray-400'
                      }`}
                      style={{ fontWeight: isCurrent ? 600 : 400 }}
                    >
                      {step.id === 'credentials' && isNiosOnly && niosMode === 'backup' ? 'Upload Backup' : step.label}
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

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
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
              <h2 className="text-[18px] mb-1" style={{ fontWeight: 600 }}>
                {isNiosOnly && niosMode === 'backup' ? 'Upload NIOS Grid Backup' : 'Choose authentication method'}
              </h2>
              <p className="text-[13px] text-[var(--muted-foreground)] mb-6">
                {isNiosOnly && niosMode === 'backup'
                  ? 'Upload a NIOS Grid backup file (.tar.gz, .tgz, .bak) or onedb.xml exported from the Grid Master.'
                  : 'Configure credentials for each selected provider. Credentials are sent only to your local Go backend — never to external servers.'}
              </p>
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

                  // ── Manual Estimator: show questionnaire instead of credentials ──
                  if (provId === 'estimator') {
                    // Auto-mark as valid so Next is enabled
                    if (credentialStatus['estimator'] !== 'valid') {
                      setCredentialStatus(prev => ({ ...prev, estimator: 'valid' }));
                    }
                    return (
                      <div key={provId} className="bg-white rounded-xl border border-[var(--border)] overflow-hidden">
                        <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border)] bg-gray-50/50">
                          <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ backgroundColor: '#00A5E515' }}>
                            <ProviderIconEl id={provId} className="w-4 h-4" color="#00A5E5" />
                          </div>
                          <span className="text-[14px]" style={{ fontWeight: 600 }}>Manual Sizing Estimator</span>
                          <span className="ml-auto flex items-center gap-1 text-[12px] text-green-600">
                            <CheckCircle2 className="w-3.5 h-3.5" /> Ready
                          </span>
                        </div>
                        <div className="px-4 py-4 space-y-4">
                          <p className="text-[13px] text-[var(--muted-foreground)]">
                            Enter your environment size. Tokens are calculated instantly - no connection required.
                          </p>
                          <div className="grid grid-cols-2 gap-4">
                            <div>
                              <label className="flex items-center gap-1 text-[12px] text-[var(--muted-foreground)] mb-1" style={{ fontWeight: 500 }}>
                                Active IP Addresses
                                <FieldTooltip text="Total number of IP addresses actively in use in your environment. This is the primary sizing input - it drives DNS record counts, DHCP client counts, and IPAM object totals." side="right" />
                              </label>
                              <input
                                type="number" min={1}
                                className="w-full border border-[var(--border)] rounded-lg px-3 py-2 text-[13px] focus:outline-none focus:ring-1 focus:ring-[var(--infoblox-orange)]"
                                value={estimatorAnswers.activeIPs}
                                onChange={e => setEstimatorAnswers(prev => ({ ...prev, activeIPs: Math.max(1, parseInt(e.target.value) || 1) }))}
                              />
                            </div>
                            <div>
                              <label className="flex items-center gap-1 text-[12px] text-[var(--muted-foreground)] mb-1" style={{ fontWeight: 500 }}>
                                DHCP % (0-100)
                                <FieldTooltip text="Percentage of active IPs assigned dynamically via DHCP. The remainder are static. Typical environments: 70-85% DHCP. Affects DNS record counts and log volume." side="right" />
                              </label>
                              <input
                                type="number" min={0} max={100}
                                className="w-full border border-[var(--border)] rounded-lg px-3 py-2 text-[13px] focus:outline-none focus:ring-1 focus:ring-[var(--infoblox-orange)]"
                                value={Math.round(estimatorAnswers.dhcpPct * 100)}
                                onChange={e => setEstimatorAnswers(prev => ({ ...prev, dhcpPct: Math.min(1, Math.max(0, (parseInt(e.target.value) || 0) / 100)) }))}
                              />
                            </div>
                            <div>
                              <label className="flex items-center gap-1 text-[12px] text-[var(--muted-foreground)] mb-1" style={{ fontWeight: 500 }}>
                                Number of Sites
                                <FieldTooltip text="Number of physical locations, branches, or data centres. Each site contributes DHCP scope objects and discovered assets to the DDI object count." side="right" />
                              </label>
                              <input
                                type="number" min={1}
                                className="w-full border border-[var(--border)] rounded-lg px-3 py-2 text-[13px] focus:outline-none focus:ring-1 focus:ring-[var(--infoblox-orange)]"
                                value={estimatorAnswers.sites}
                                onChange={e => setEstimatorAnswers(prev => ({ ...prev, sites: Math.max(1, parseInt(e.target.value) || 1) }))}
                              />
                            </div>
                            <div>
                              <label className="flex items-center gap-1 text-[12px] text-[var(--muted-foreground)] mb-1" style={{ fontWeight: 500 }}>
                                Networks per Site
                                <FieldTooltip text="Average number of IP subnets or VLANs per site. Used to estimate DHCP scope and range objects. Typical branch: 2-6 networks; large campus: 10-20+." side="right" />
                              </label>
                              <input
                                type="number" min={1}
                                className="w-full border border-[var(--border)] rounded-lg px-3 py-2 text-[13px] focus:outline-none focus:ring-1 focus:ring-[var(--infoblox-orange)]"
                                value={estimatorAnswers.networksPerSite}
                                onChange={e => setEstimatorAnswers(prev => ({ ...prev, networksPerSite: Math.max(1, parseInt(e.target.value) || 1) }))}
                              />
                            </div>
                          </div>
                          <div className="grid grid-cols-2 gap-x-6 gap-y-2 pt-1">
                            {[
                              { key: 'enableIPAM' as const, label: 'IPAM Module', tooltip: 'Include IP Address Management. Enables active IP counting, asset discovery, and subnet/network object tracking. Disable only if you are sizing DNS/DHCP only.' },
                              { key: 'enableDNS' as const, label: 'DNS Management', tooltip: 'Include DNS zone and record management. Contributes DNS resource records to the DDI object count. Required for most Universal DDI deployments.' },
                              { key: 'enableDHCP' as const, label: 'DHCP Management', tooltip: 'Include DHCP scope and range management. Each network gets a scope object plus HA/failover range objects (2x multiplier). Disable if using external DHCP only.' },
                              { key: 'enableDNSProtocol' as const, label: 'DNS Protocol Logging', tooltip: 'Enable DNS query logging to BloxOne Threat Defense or reporting. Generates high log volume (QPD x active IPs). Drives Reporting Token (IB-TOKENS-REPORTING-40) requirements.' },
                              { key: 'enableDHCPLog' as const, label: 'DHCP Lease Logging', tooltip: 'Enable DHCP lease event logging. Generates log volume based on lease churn rate. Together with DNS protocol logging this determines your Reporting Token needs.' },
                            ].map(({ key, label, tooltip }) => (
                              <label key={key} className="flex items-center gap-2 text-[13px] cursor-pointer select-none">
                                <input
                                  type="checkbox"
                                  className="w-4 h-4 accent-[var(--infoblox-orange)]"
                                  checked={estimatorAnswers[key] as boolean}
                                  onChange={e => setEstimatorAnswers(prev => ({ ...prev, [key]: e.target.checked }))}
                                />
                                {label}
                                <FieldTooltip text={tooltip} side="right" />
                              </label>
                            ))}
                          </div>
                          {/* Reporting Destinations table -- shown when log volume is non-zero */}
                          {liveLogVolume > 0 && (
                            <div className="border-t border-[var(--border)] pt-3 mt-1">
                              <p className="text-[12px] text-[var(--muted-foreground)] flex items-center gap-1 mb-2" style={{ fontWeight: 600 }}>
                                Reporting Destinations
                                <FieldTooltip text="Select which destinations receive your log data. Each enabled destination consumes reporting tokens independently. Local Syslog is display-only and never consumes tokens." side="right" />
                              </p>
                              <table className="w-full text-[12px]">
                                <thead>
                                  <tr className="text-[var(--muted-foreground)] border-b border-[var(--border)]">
                                    <th className="pb-1 text-left w-6"></th>
                                    <th className="pb-1 text-left">Destination</th>
                                    <th className="pb-1 text-right pr-2">Events/Month</th>
                                    <th className="pb-1 text-right">Tokens</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {REPORTING_DESTINATIONS.map(dest => {
                                    const enabled = reportingDestEnabled[dest.id] ?? true;
                                    const events = reportingDestEvents[dest.id] ?? 0;
                                    const destResult = reportingBreakdown.find(r => r.destinationId === dest.id);
                                    const tokens = dest.isDisplayOnly ? 0 : (destResult?.tokens ?? 0);
                                    const ecosystemDefault = Math.round(liveLogVolume * 0.4);
                                    return (
                                      <tr key={dest.id} className="border-b border-[var(--border)]/50 last:border-0">
                                        <td className="py-1.5">
                                          <input
                                            type="checkbox"
                                            className="w-3.5 h-3.5 accent-[var(--infoblox-orange)]"
                                            checked={enabled}
                                            onChange={e => setReportingDestEnabled(prev => ({ ...prev, [dest.id]: e.target.checked }))}
                                          />
                                        </td>
                                        <td className="py-1.5">
                                          <span className={enabled ? '' : 'text-[var(--muted-foreground)]'}>{dest.label}</span>
                                          {dest.isDisplayOnly && (
                                            <span className="ml-1 text-[10px] text-[var(--muted-foreground)]">(display only)</span>
                                          )}
                                        </td>
                                        <td className="py-1.5 pr-2 text-right">
                                          <div className="flex flex-col items-end gap-0.5">
                                            <input
                                              type="number"
                                              min={0}
                                              className="w-28 border border-[var(--border)] rounded px-2 py-0.5 text-right text-[11px] focus:outline-none focus:ring-1 focus:ring-[var(--infoblox-orange)]"
                                              value={events}
                                              onChange={e => {
                                                const val = Math.max(0, parseInt(e.target.value) || 0);
                                                if (dest.id === 'ecosystem') {
                                                  ecosystemManualOverride.current = val !== ecosystemDefault;
                                                }
                                                setReportingDestEvents(prev => ({ ...prev, [dest.id]: val }));
                                              }}
                                            />
                                            {dest.id === 'ecosystem' && (
                                              <span className="text-[10px] text-[var(--muted-foreground)]">default: 40% of log volume</span>
                                            )}
                                          </div>
                                        </td>
                                        <td className="py-1.5 text-right tabular-nums" style={{ fontWeight: enabled ? 600 : 400, color: enabled ? undefined : 'var(--muted-foreground)' }}>
                                          {enabled ? tokens.toLocaleString() : '0'}
                                        </td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                          )}
                          {/* Server Sizing (optional) - granular per-server entries */}
                          <div className="border-t border-[var(--border)] pt-3 mt-1">
                            <div className="flex items-center justify-between mb-2">
                              <p className="text-[12px] text-[var(--muted-foreground)] flex items-center gap-1" style={{ fontWeight: 600 }}>
                                Server Sizing (optional)
                                <FieldTooltip text="Add individual NIOS-X appliances or XaaS instances with different sizes. Each server is sized independently based on its QPS, LPS, and object count. XaaS entries are consolidated into shared instances automatically." side="right" />
                              </p>
                              <button
                                type="button"
                                onClick={() => setEstimatorAnswers(prev => ({
                                  ...prev,
                                  serverEntries: [...prev.serverEntries, { name: `Server ${prev.serverEntries.length + 1}`, formFactor: 'nios-x', qps: 0, lps: 0, objects: 0 }],
                                }))}
                                className="flex items-center gap-1 px-2.5 py-1 bg-[var(--infoblox-blue)] text-white text-[11px] font-medium rounded-lg hover:bg-[var(--infoblox-blue)]/90 transition-colors"
                              >
                                <Plus className="w-3 h-3" />
                                Add Server
                              </button>
                            </div>
                            {estimatorAnswers.serverEntries.length > 0 && (
                              <div className="space-y-2">
                                {estimatorAnswers.serverEntries.map((entry, idx) => {
                                  const tier = calcServerTokenTier(entry.qps, entry.lps, entry.objects, entry.formFactor);
                                  return (
                                    <div key={idx} className="border border-[var(--border)] rounded-lg p-3 bg-[var(--input-background)]/30">
                                      <div className="flex items-center gap-2 mb-2">
                                        <input
                                          type="text"
                                          className="flex-1 border border-[var(--border)] rounded-lg px-2.5 py-1.5 text-[12px] font-medium focus:outline-none focus:ring-1 focus:ring-[var(--infoblox-orange)]"
                                          value={entry.name}
                                          onChange={e => setEstimatorAnswers(prev => ({
                                            ...prev,
                                            serverEntries: prev.serverEntries.map((s, i) => i === idx ? { ...s, name: e.target.value } : s),
                                          }))}
                                          placeholder="Server name"
                                        />
                                        <select
                                          className="border border-[var(--border)] rounded-lg px-2.5 py-1.5 text-[12px] focus:outline-none focus:ring-1 focus:ring-[var(--infoblox-orange)] bg-white"
                                          value={entry.formFactor}
                                          onChange={e => setEstimatorAnswers(prev => ({
                                            ...prev,
                                            serverEntries: prev.serverEntries.map((s, i) => i === idx ? { ...s, formFactor: e.target.value as ServerFormFactor } : s),
                                          }))}
                                        >
                                          <option value="nios-x">NIOS-X</option>
                                          <option value="nios-xaas">XaaS</option>
                                        </select>
                                        <button
                                          type="button"
                                          onClick={() => setEstimatorAnswers(prev => ({
                                            ...prev,
                                            serverEntries: prev.serverEntries.filter((_, i) => i !== idx),
                                          }))}
                                          className="flex-shrink-0 text-[var(--muted-foreground)] hover:text-red-500 transition-colors p-1"
                                          aria-label={`Remove ${entry.name}`}
                                        >
                                          <X className="w-3.5 h-3.5" />
                                        </button>
                                      </div>
                                      <div className="grid grid-cols-3 gap-3">
                                        <div>
                                          <label className="text-[11px] text-[var(--muted-foreground)] mb-0.5 block">QPS</label>
                                          <input
                                            type="number" min={0}
                                            className="w-full border border-[var(--border)] rounded-lg px-2.5 py-1.5 text-[12px] focus:outline-none focus:ring-1 focus:ring-[var(--infoblox-orange)]"
                                            value={entry.qps}
                                            onChange={e => setEstimatorAnswers(prev => ({
                                              ...prev,
                                              serverEntries: prev.serverEntries.map((s, i) => i === idx ? { ...s, qps: Math.max(0, parseInt(e.target.value) || 0) } : s),
                                            }))}
                                          />
                                        </div>
                                        <div>
                                          <label className="text-[11px] text-[var(--muted-foreground)] mb-0.5 block">LPS</label>
                                          <input
                                            type="number" min={0}
                                            className="w-full border border-[var(--border)] rounded-lg px-2.5 py-1.5 text-[12px] focus:outline-none focus:ring-1 focus:ring-[var(--infoblox-orange)]"
                                            value={entry.lps}
                                            onChange={e => setEstimatorAnswers(prev => ({
                                              ...prev,
                                              serverEntries: prev.serverEntries.map((s, i) => i === idx ? { ...s, lps: Math.max(0, parseInt(e.target.value) || 0) } : s),
                                            }))}
                                          />
                                        </div>
                                        <div>
                                          <label className="text-[11px] text-[var(--muted-foreground)] mb-0.5 block">Objects</label>
                                          <input
                                            type="number" min={0}
                                            className="w-full border border-[var(--border)] rounded-lg px-2.5 py-1.5 text-[12px] focus:outline-none focus:ring-1 focus:ring-[var(--infoblox-orange)]"
                                            value={entry.objects}
                                            onChange={e => setEstimatorAnswers(prev => ({
                                              ...prev,
                                              serverEntries: prev.serverEntries.map((s, i) => i === idx ? { ...s, objects: Math.max(0, parseInt(e.target.value) || 0) } : s),
                                            }))}
                                          />
                                        </div>
                                      </div>
                                      {/* Live tier readout per server */}
                                      <div className="mt-2 px-2.5 py-1.5 bg-blue-50/60 rounded-lg text-[11px] text-blue-800 flex items-center justify-between">
                                        <span>
                                          Tier: <span style={{ fontWeight: 600 }}>{tier.name}</span>
                                          {entry.formFactor === 'nios-xaas' && <span className="text-blue-600 ml-1">(XaaS, consolidated at scan)</span>}
                                        </span>
                                        {entry.formFactor === 'nios-x' && tier.discAssets > 0 && (
                                          <span className="text-blue-600 text-[10px]">Disc Assets: {tier.discAssets.toLocaleString()}</span>
                                        )}
                                        <span style={{ fontWeight: 600 }}>
                                          {tier.serverTokens.toLocaleString()} tokens
                                        </span>
                                      </div>
                                    </div>
                                  );
                                })}
                                {/* Totals summary */}
                                {(() => {
                                  const out = calcEstimator(estimatorAnswers);
                                  return (
                                    <div className="px-3 py-2 bg-blue-50/80 rounded-lg text-[12px] text-blue-800 flex items-center justify-between" style={{ fontWeight: 600 }}>
                                      <span>{estimatorAnswers.serverEntries.length} server{estimatorAnswers.serverEntries.length !== 1 ? 's' : ''}</span>
                                      <span>Total: {out.serverTokens.toLocaleString()} server tokens ({Math.ceil(out.serverTokens / 500)} SERV-500 packs)</span>
                                    </div>
                                  );
                                })()}
                              </div>
                            )}
                          </div>
                        </div>
                      {/* Validation warning banner — advisory only, never blocks submission */}
                      {estimatorWarnings.length > 0 && (
                        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 mx-4 mb-4">
                          <p className="text-[12px] text-amber-800 font-medium mb-1.5">Sizing Notes</p>
                          <ul className="space-y-1">
                            {estimatorWarnings.map((w, i) => (
                              <li key={i} className="flex items-start gap-1.5 text-[12px] text-amber-700">
                                <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-amber-500" />
                                <span>{w}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      </div>
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
                            {(provId === 'bluecat' || provId === 'efficientip' || (provId === 'nios' && niosMode === 'wapi')) && (
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
                            {provId === 'efficientip' && (
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

          {/* Step 5: Results & Export */}
          {currentStep === 'results' && (
            <div>
              {/* ── Hero summary card ───────────────────────────────────── */}
              <div id="section-overview" className="bg-white rounded-xl border-2 border-[var(--infoblox-orange)]/30 p-5 mb-6">

                {/* Always-visible header: both totals + single toggle */}
                <button
                  type="button"
                  onClick={() => setHeroCollapsed(v => !v)}
                  className="w-full text-left"
                >
                  <div className={`grid gap-6 ${hasServerMetrics ? 'grid-cols-2' : 'grid-cols-1'}`}>
                    {/* Management total */}
                    <div>
                      <div className="flex items-center gap-1.5 text-[13px] text-[var(--muted-foreground)] mb-1">
                        Total Management Tokens
                        <FieldTooltip text="Management tokens cover DDI Objects (1 token per 25 objects), Active IPs (1 token per 13 IPs), and Managed Assets (1 token per 3 assets). Pack size: 1,000 tokens. Growth buffer is included. Source: NOTES tab rows 12-20." side="right" />
                      </div>
                      <div className="text-[32px] text-[var(--infoblox-orange)]" style={{ fontWeight: 700 }}>
                        {totalTokens.toLocaleString()}
                        {Object.keys(countOverrides).length > 0 && (
                          <span className="ml-2 text-[11px] font-medium text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full border border-amber-200 align-middle">
                            <Pencil className="w-3 h-3 inline -mt-0.5 mr-0.5" />adjusted
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-1">
                        <span className="font-mono text-[11px] bg-orange-50 text-orange-800 px-2 py-0.5 rounded border border-orange-200">IB-TOKENS-UDDI-MGMT-1000</span>
                        <span className="text-[12px] font-semibold text-[var(--infoblox-orange)]">× {Math.ceil(totalTokens / 1000).toLocaleString()} pack{Math.ceil(totalTokens / 1000) !== 1 ? 's' : ''}</span>
                      </div>
                      {hybridScenario && (
                        <div className="mt-2 pt-2 border-t border-orange-100">
                          <div className="text-[11px] text-[var(--muted-foreground)] mb-0.5">
                            Hybrid scenario <span className="text-orange-600">({hybridScenario.selectionCount} selected)</span>
                          </div>
                          <div className="text-[22px] text-orange-400" style={{ fontWeight: 700, lineHeight: 1.1 }}>
                            {hybridScenario.mgmt.toLocaleString()}
                          </div>
                          <div className="flex items-center gap-2 mt-0.5">
                            <span className="font-mono text-[10px] bg-orange-50 text-orange-700 px-1.5 py-0.5 rounded border border-orange-200">IB-TOKENS-UDDI-MGMT-1000</span>
                            <span className="text-[11px] font-semibold text-orange-400">× {Math.ceil(hybridScenario.mgmt / 1000).toLocaleString()} pack{Math.ceil(hybridScenario.mgmt / 1000) !== 1 ? 's' : ''}</span>
                          </div>
                        </div>
                      )}
                    </div>
                    {/* Server total */}
                    {hasServerMetrics && (
                      <div className="border-l border-[var(--border)] pl-6">
                        <div className="flex items-center gap-1.5 text-[13px] text-[var(--muted-foreground)] mb-1">
                          Total Server Tokens
                          <FieldTooltip text="Server tokens (IB-TOKENS-UDDI-SERV-500) cover NIOS-X appliances and XaaS instances sized by QPS, LPS, and object count. Tier capacities range from 2XS (130 tokens) to XL (2,700 tokens) for NIOS-X. Separate from management tokens. No growth buffer applied. Source: NOTES tab rows 21-30." side="right" />
                        </div>
                        <div className="text-[32px] text-blue-700" style={{ fontWeight: 700 }}>
                          {totalServerTokens.toLocaleString()}
                        </div>
                        <div className="flex items-center gap-2 mt-1">
                          <span className="font-mono text-[11px] bg-blue-50 text-blue-800 px-2 py-0.5 rounded border border-blue-200">IB-TOKENS-UDDI-SERV-500</span>
                          <span className="text-[12px] font-semibold text-blue-700">× {Math.ceil(totalServerTokens / 500).toLocaleString()} pack{Math.ceil(totalServerTokens / 500) !== 1 ? 's' : ''}</span>
                        </div>
                        {hybridScenario && (
                          <div className="mt-2 pt-2 border-t border-blue-100">
                            <div className="text-[11px] text-[var(--muted-foreground)] mb-0.5">
                              Hybrid scenario <span className="text-blue-500">({hybridScenario.selectionCount} selected)</span>
                            </div>
                            <div className="text-[22px] text-blue-400" style={{ fontWeight: 700, lineHeight: 1.1 }}>
                              {hybridScenario.srv.toLocaleString()}
                            </div>
                            <div className="flex items-center gap-2 mt-0.5">
                              <span className="font-mono text-[10px] bg-blue-50 text-blue-700 px-1.5 py-0.5 rounded border border-blue-200">IB-TOKENS-UDDI-SERV-500</span>
                              <span className="text-[11px] font-semibold text-blue-400">× {Math.ceil(hybridScenario.srv / 500).toLocaleString()} pack{Math.ceil(hybridScenario.srv / 500) !== 1 ? 's' : ''}</span>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  {/* Expand/collapse hint */}
                  <div className="flex items-center gap-1 mt-3 text-[11px] text-[var(--muted-foreground)]">
                    <ChevronDown className={`w-3.5 h-3.5 transition-transform ${heroCollapsed ? '' : 'rotate-180'}`} />
                    {heroCollapsed ? 'Show breakdown by source' : 'Hide breakdown'}
                  </div>
                </button>

                {/* Expandable: per-source bars for both columns */}
                {!heroCollapsed && (
                  <div className={`mt-4 pt-4 border-t border-[var(--border)] grid gap-6 ${hasServerMetrics ? 'grid-cols-2' : 'grid-cols-1'}`}>

                    {/* Management breakdown */}
                    <div>
                      <div className="text-[11px] font-semibold text-[var(--muted-foreground)] mb-3 uppercase tracking-wider">By Source — Management</div>
                      <div className="space-y-2.5">
                        {(() => {
                          const sourceMap = new Map<string, { source: string; provider: ProviderType; tokens: number }>();
                          effectiveFindings.forEach((f) => {
                            const key = `${f.provider}::${f.source}`;
                            if (!sourceMap.has(key)) sourceMap.set(key, { source: f.source, provider: f.provider, tokens: 0 });
                            sourceMap.get(key)!.tokens += f.managementTokens;
                          });
                          const sources = Array.from(sourceMap.values()).sort((a, b) => b.tokens - a.tokens);
                          const LIMIT = 10;
                          const visible = showAllHeroSources ? sources : sources.slice(0, LIMIT);
                          const hidden = sources.length - LIMIT;
                          const needsScroll = showAllHeroSources && sources.length > 15;
                          return (
                            <>
                              <div className={needsScroll ? 'max-h-[400px] overflow-y-auto' : ''}>
                                {visible.map((entry) => {
                                  const provider = PROVIDERS.find((p) => p.id === entry.provider)!;
                                  const pct = totalTokens > 0 ? (entry.tokens / totalTokens) * 100 : 0;
                                  return (
                                    <div key={`${entry.provider}-${entry.source}`} className="mb-2.5">
                                      <div className="flex items-center justify-between mb-1">
                                        <span className="text-[12px] flex items-center gap-1.5" style={{ fontWeight: 500 }}>
                                          <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: provider.color }} />
                                          {entry.source}
                                          <span className="text-[11px] text-[var(--muted-foreground)]" style={{ fontWeight: 400 }}>{provider.name}</span>
                                        </span>
                                        <span className="text-[12px] tabular-nums text-[var(--muted-foreground)]">
                                          {entry.tokens.toLocaleString()} <span className="text-[11px]">({Math.round(pct)}%)</span>
                                        </span>
                                      </div>
                                      <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                                        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: provider.color }} />
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                              {hidden > 0 && (
                                <button type="button" onClick={(e) => { e.stopPropagation(); setShowAllHeroSources(v => !v); }}
                                  className="text-[12px] text-[var(--infoblox-blue)] hover:underline mt-1" style={{ fontWeight: 500 }}>
                                  {showAllHeroSources ? 'Show less' : `Show ${hidden} more sources...`}
                                </button>
                              )}
                            </>
                          );
                        })()}
                      </div>
                    </div>

                    {/* Server breakdown */}
                    {hasServerMetrics && (() => {
                      const srvSources: { label: string; color: string; tokens: number }[] = [];
                      if (selectedProviders.includes('nios') && effectiveNiosMetrics.length > 0) {
                        effectiveNiosMetrics.forEach(m => {
                          const t = calcServerTokenTier(m.qps, m.lps, serverSizingObjects(m), 'nios-x').serverTokens;
                          if (t > 0) srvSources.push({ label: m.memberName, color: '#00a5e5', tokens: t });
                        });
                      }
                      if (selectedProviders.includes('microsoft') && effectiveADMetrics.length > 0) {
                        const dcs = adMigrationMap.size > 0
                          ? effectiveADMetrics.filter(m => adMigrationMap.has(m.hostname))
                          : effectiveADMetrics;
                        dcs.forEach(m => {
                          const t = calcServerTokenTier(m.qps, m.lps, m.dnsObjects + m.dhcpObjectsWithOverhead, 'nios-x').serverTokens;
                          if (t > 0) srvSources.push({ label: m.hostname, color: '#0078d4', tokens: t });
                        });
                      }
                      srvSources.sort((a, b) => b.tokens - a.tokens);
                      const LIMIT = 10;
                      const visible = srvSources.slice(0, LIMIT);
                      const hidden = srvSources.length - LIMIT;
                      return (
                        <div className="border-l border-[var(--border)] pl-6">
                          <div className="text-[11px] font-semibold text-[var(--muted-foreground)] mb-3 uppercase tracking-wider">By Source — Server</div>
                          <div className="space-y-2.5">
                            {srvSources.length === 0 ? (
                              <div className="text-[12px] text-[var(--muted-foreground)]">No server metrics available.</div>
                            ) : (
                              <>
                                {visible.map((entry) => {
                                  const pct = totalServerTokens > 0 ? (entry.tokens / totalServerTokens) * 100 : 0;
                                  return (
                                    <div key={entry.label} className="mb-2.5">
                                      <div className="flex items-center justify-between mb-1">
                                        <span className="text-[12px] flex items-center gap-1.5" style={{ fontWeight: 500 }}>
                                          <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: entry.color }} />
                                          {entry.label}
                                        </span>
                                        <span className="text-[12px] tabular-nums text-[var(--muted-foreground)]">
                                          {entry.tokens.toLocaleString()} <span className="text-[11px]">({Math.round(pct)}%)</span>
                                        </span>
                                      </div>
                                      <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                                        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: entry.color }} />
                                      </div>
                                    </div>
                                  );
                                })}
                                {hidden > 0 && (
                                  <div className="text-[12px] text-[var(--muted-foreground)] mt-1">+{hidden} more sources</div>
                                )}
                              </>
                            )}
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                )}
              </div>{/* end hero card */}

              {/* ── Growth buffer + BOM panel (S03) ────────────────────── */}
              <div id="section-bom" className="bg-white rounded-xl border border-[var(--border)] p-5 mb-6">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h3 className="text-[15px]" style={{ fontWeight: 600 }}>Bill of Materials</h3>
                    <p className="text-[12px] text-[var(--muted-foreground)] mt-0.5">Copy-paste ready SKU list for quoting</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <label className="flex items-center gap-2 text-[13px]">
                      <span className="text-[var(--muted-foreground)]" style={{ fontWeight: 500 }}>Growth Buffer</span>
                      <FieldTooltip text="Additional capacity added on top of the calculated token requirement to account for environment growth. Applied to management and reporting tokens before pack rounding. Default 20% is typical for a 1-year planning horizon." side="left" />
                      <div className="flex items-center border border-[var(--border)] rounded-lg overflow-hidden">
                        <input
                          type="number" min={0} max={100} step={5}
                          className="w-16 px-2 py-1.5 text-[13px] text-right focus:outline-none focus:ring-1 focus:ring-[var(--infoblox-orange)]"
                          value={Math.round(growthBufferPct * 100)}
                          onChange={e => setGrowthBufferPct(Math.min(1, Math.max(0, (parseInt(e.target.value) || 0) / 100)))}
                        />
                        <span className="px-2 py-1.5 bg-gray-50 text-[13px] text-[var(--muted-foreground)] border-l border-[var(--border)]">%</span>
                      </div>
                    </label>
                    <button
                      type="button"
                      onClick={() => {
                        const mgmtPacks = Math.ceil(totalTokens / 1000);
                        const servPacks = hasServerMetrics ? Math.ceil(totalServerTokens / 500) : 0;
                        const rptPacks = reportingTokens > 0 ? Math.ceil(reportingTokens / 40) : 0;
                        const lines = [
                          `SKU Code\tDescription\tPack Count`,
                          `IB-TOKENS-UDDI-MGMT-1000\tManagement Token Pack (1000 tokens)\t${mgmtPacks}`,
                          ...(servPacks > 0 ? [`IB-TOKENS-UDDI-SERV-500\tServer Token Pack (500 tokens)\t${servPacks}`] : []),
                          ...(rptPacks > 0 ? [`IB-TOKENS-REPORTING-40\tReporting Token Pack (40 tokens)\t${rptPacks}`] : []),
                        ];
                        navigator.clipboard.writeText(lines.join('\n')).then(() => {
                          setBomCopied(true);
                          setTimeout(() => setBomCopied(false), 2000);
                        });
                      }}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] border transition-colors ${bomCopied ? 'bg-green-50 border-green-300 text-green-700' : 'bg-white border-[var(--border)] hover:bg-gray-50'}`}
                      style={{ fontWeight: 500 }}
                    >
                      {bomCopied ? <><Check className="w-3.5 h-3.5" /> Copied!</> : <><Download className="w-3.5 h-3.5" /> Copy BOM</>}
                    </button>
                  </div>
                </div>
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="border-b border-[var(--border)]">
                      <th className="text-left py-2 text-[var(--muted-foreground)] text-[12px]" style={{ fontWeight: 500 }}>SKU Code</th>
                      <th className="text-left py-2 text-[var(--muted-foreground)] text-[12px]" style={{ fontWeight: 500 }}>Description</th>
                      <th className="text-right py-2 text-[var(--muted-foreground)] text-[12px]" style={{ fontWeight: 500 }}>Pack Count</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-b border-[var(--border)]/50">
                      <td className="py-2.5 font-mono text-[12px] text-orange-800">IB-TOKENS-UDDI-MGMT-1000</td>
                      <td className="py-2.5 text-[var(--muted-foreground)]">
                        <span className="flex items-center gap-1">
                          Management Token Pack (1000 tokens)
                          <FieldTooltip text="Covers DDI Objects, Active IPs, and Managed Assets. Pack size: 1000 tokens. Count = ceil(total management tokens / 1000). Growth buffer already included." side="top" />
                        </span>
                      </td>
                      <td className="py-2.5 text-right tabular-nums" style={{ fontWeight: 600 }}>{Math.ceil(totalTokens / 1000).toLocaleString()}</td>
                    </tr>
                    {hasServerMetrics && (
                      <tr className="border-b border-[var(--border)]/50">
                        <td className="py-2.5 font-mono text-[12px] text-blue-800">IB-TOKENS-UDDI-SERV-500</td>
                        <td className="py-2.5 text-[var(--muted-foreground)]">
                          <span className="flex items-center gap-1">
                            Server Token Pack (500 tokens)
                            <FieldTooltip text="Server tokens (IB-TOKENS-UDDI-SERV-500) cover NIOS-X appliances and XaaS instances sized by QPS, LPS, and object count. Tier capacities range from 2XS (130 tokens) to XL (2,700 tokens) for NIOS-X. Separate from management tokens. No growth buffer applied. Source: NOTES tab rows 21-30." side="top" />
                          </span>
                        </td>
                        <td className="py-2.5 text-right tabular-nums" style={{ fontWeight: 600 }}>{Math.ceil(totalServerTokens / 500).toLocaleString()}</td>
                      </tr>
                    )}
                    {reportingTokens > 0 && (
                      <tr>
                        <td className="py-2.5 font-mono text-[12px] text-purple-800">IB-TOKENS-REPORTING-40</td>
                        <td className="py-2.5 text-[var(--muted-foreground)]">
                          <span className="flex items-center gap-1">
                            Reporting Token Pack (40 tokens)
                            <FieldTooltip text="Reporting tokens (IB-TOKENS-REPORTING-40) cover DNS protocol and DHCP lease log forwarding. Rate: CSP=80 tokens per 10M events, S3 Bucket=40, Ecosystem (CDC)=40. Local Syslog is display-only and contributes 0 tokens. Ecosystem receives 40% of total log volume by default. Growth buffer is applied. Source: NOTES tab rows 31-44." side="top" />
                          </span>
                        </td>
                        <td className="py-2.5 text-right tabular-nums" style={{ fontWeight: 600 }}>{Math.ceil(reportingTokens / 40).toLocaleString()}</td>
                      </tr>
                    )}
                  </tbody>
                </table>
                {growthBufferPct > 0 && (
                  <p className="text-[11px] text-[var(--muted-foreground)] mt-3">
                    Includes {Math.round(growthBufferPct * 100)}% growth buffer applied to management{reportingTokens > 0 ? ' and reporting' : ''} tokens.
                  </p>
                )}
              </div>

              {/* Section jump navigation — only for NIOS scans */}
              {(selectedProviders.includes('nios') || (selectedProviders.includes('microsoft') && effectiveADMetrics.length > 0)) && (
                <div className="sticky top-0 z-10 bg-white border-b border-[var(--border)] rounded-xl mb-6 px-4 py-2.5 flex items-center gap-2 flex-wrap">
                  {[
                    ...(selectedProviders.includes('nios') ? [
                      { id: 'section-overview', label: 'Overview' },
                      { id: 'section-migration-planner', label: 'Migration Planner' },
                    ] : []),
                    ...(selectedProviders.includes('microsoft') && effectiveADMetrics.length > 0 ? [
                      { id: 'section-ad-migration', label: 'AD Migration Planner' },
                    ] : []),
                    { id: 'section-findings', label: 'Detailed Findings' },
                    { id: 'section-export', label: 'Export' },
                  ].map((nav) => (
                    <button
                      key={nav.id}
                      type="button"
                      onClick={() => document.getElementById(nav.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                      className="text-[12px] px-3 py-1.5 rounded-full border border-[var(--border)] hover:bg-gray-50 hover:border-[var(--infoblox-blue)] transition-colors"
                      style={{ fontWeight: 500 }}
                    >
                      {nav.label}
                    </button>
                  ))}
                </div>
              )}

              {/* Top Consumer Cards — DNS, DHCP, IP */}
              {(() => {
                const consumerCards: {
                  key: string;
                  label: string;
                  filter: (f: typeof findings[0]) => boolean;
                  expanded: boolean;
                  toggle: () => void;
                  icon: typeof Globe;
                  iconBg: string;
                  iconColor: string;
                  barColor: string;
                }[] = [
                  {
                    key: 'dns',
                    label: 'Top 5 DNS Consumers',
                    filter: (f) => /dns|zone/i.test(f.item) && !/unsupported/i.test(f.item),
                    expanded: topDnsExpanded,
                    toggle: () => setTopDnsExpanded((v) => !v),
                    icon: Globe,
                    iconBg: 'bg-blue-50',
                    iconColor: 'text-blue-600',
                    barColor: 'bg-blue-500',
                  },
                  {
                    key: 'dhcp',
                    label: 'Top 5 DHCP Consumers',
                    filter: (f) => /dhcp|scope|lease|range|reservation/i.test(f.item) && !/unsupported/i.test(f.item),
                    expanded: topDhcpExpanded,
                    toggle: () => setTopDhcpExpanded((v) => !v),
                    icon: Activity,
                    iconBg: 'bg-purple-50',
                    iconColor: 'text-purple-600',
                    barColor: 'bg-purple-500',
                  },
                  {
                    key: 'ip',
                    label: 'Top 5 IP / Network Consumers',
                    filter: (f) => /ip|subnet|network|cidr|address|vnet|vpc/i.test(f.item) && !/dhcp|dns|unsupported/i.test(f.item),
                    expanded: topIpExpanded,
                    toggle: () => setTopIpExpanded((v) => !v),
                    icon: Gauge,
                    iconBg: 'bg-green-50',
                    iconColor: 'text-green-600',
                    barColor: 'bg-green-500',
                  },
                ];

                const visibleCards = consumerCards.filter((card) => {
                  const items = effectiveFindings.filter(card.filter);
                  return items.length > 0;
                });

                if (visibleCards.length === 0) return null;

                return (
                  <div className="grid grid-cols-1 gap-4 mb-6">
                    {visibleCards.map((card) => {
                      const topItems = findings
                        .filter(card.filter)
                        .sort((a, b) => b.managementTokens - a.managementTokens)
                        .slice(0, 5);
                      const totalCardTokens = topItems.reduce((s, f) => s + f.managementTokens, 0);
                      const IconComp = card.icon;
                      return (
                        <div key={card.key} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                          <button
                            type="button"
                            className="w-full flex items-center justify-between px-5 py-3.5 hover:bg-gray-50 transition-colors text-left"
                            onClick={card.toggle}
                          >
                            <div className="flex items-center gap-2.5">
                              <div className={`w-8 h-8 rounded-lg ${card.iconBg} flex items-center justify-center`}>
                                <IconComp className={`w-4 h-4 ${card.iconColor}`} />
                              </div>
                              <div>
                                <div className="text-[13px]" style={{ fontWeight: 600 }}>{card.label}</div>
                                <div className="text-[11px] text-[var(--muted-foreground)]">
                                  {totalCardTokens.toLocaleString()} tokens across {topItems.length} items
                                </div>
                              </div>
                            </div>
                            {card.expanded
                              ? <ChevronUp className="w-4 h-4 text-gray-400" />
                              : <ChevronDown className="w-4 h-4 text-gray-400" />
                            }
                          </button>
                          {card.expanded && (
                            <div className="px-5 pb-4 border-t border-gray-100">
                              <table className="w-full text-[12px] mt-3">
                                <thead>
                                  <tr className="text-[11px] text-[var(--muted-foreground)]">
                                    <th className="text-left pb-2 pr-3" style={{ fontWeight: 500 }}>Source</th>
                                    <th className="text-left pb-2 pr-3" style={{ fontWeight: 500 }}>Item</th>
                                    <th className="text-right pb-2 pr-3" style={{ fontWeight: 500 }}>Count</th>
                                    <th className="text-right pb-2" style={{ fontWeight: 500 }}>Tokens</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {topItems.map((f, idx) => {
                                    const provider = PROVIDERS.find((p) => p.id === f.provider)!;
                                    const pct = totalCardTokens > 0 ? (f.managementTokens / totalCardTokens) * 100 : 0;
                                    return (
                                      <tr key={`${card.key}-top-${idx}`} className="border-t border-gray-50">
                                        <td className="py-2 pr-3">
                                          <div className="flex items-center gap-1.5">
                                            <span
                                              className="inline-block w-2 h-2 rounded-full shrink-0"
                                              style={{ backgroundColor: provider.color }}
                                            />
                                            <span className="truncate max-w-[220px]">{f.source}</span>
                                          </div>
                                        </td>
                                        <td className="py-2 pr-3">{formatItemLabel(f.item)}</td>
                                        <td className="py-2 pr-3 text-right tabular-nums">{f.count.toLocaleString()}</td>
                                        <td className="py-2 text-right">
                                          <div className="flex items-center justify-end gap-2">
                                            <div className="w-16 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                                              <div
                                                className={`h-full rounded-full ${card.barColor}`}
                                                style={{ width: `${pct}%` }}
                                              />
                                            </div>
                                            <span className="tabular-nums" style={{ fontWeight: 500 }}>{f.managementTokens.toLocaleString()}</span>
                                          </div>
                                        </td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })()}

              {/* 3 category columns with per-source breakdown */}
              {(() => {
                // Build per-source data for each category
                const sourceLabel = selectedProviders.map((p) => PROVIDERS.find((pr) => pr.id === p)!.subscriptionLabel).filter((v, i, a) => a.indexOf(v) === i).join(' / ');

                type SourceEntry = { source: string; provider: ProviderType; tokens: number; count: number };
                const buildSourceList = (category: TokenCategory): SourceEntry[] => {
                  const map = new Map<string, SourceEntry>();
                  effectiveFindings.filter(f => f.category === category).forEach((f) => {
                    const key = `${f.provider}::${f.source}`;
                    if (!map.has(key)) map.set(key, { source: f.source, provider: f.provider, tokens: 0, count: 0 });
                    const e = map.get(key)!;
                    e.tokens += f.managementTokens;
                    e.count += f.count;
                  });
                  return Array.from(map.values()).sort((a, b) => b.tokens - a.tokens);
                };

                const categories: { key: TokenCategory; label: string; color: string; bgLight: string; barColor: string; textColor: string; unitLabel: string; tooltip: string }[] = [
                  { key: 'DDI Object', label: 'DDI Objects', color: 'text-blue-600', bgLight: 'bg-blue-50', barColor: 'bg-blue-500', textColor: 'text-blue-700', unitLabel: 'objects', tooltip: 'DNS zones, DNS records, DHCP scopes, and IPAM networks — each counts as one DDI object. Rate: 1 management token per 25 DDI objects.' },
                  { key: 'Active IP', label: 'Active IPs', color: 'text-purple-600', bgLight: 'bg-purple-50', barColor: 'bg-purple-500', textColor: 'text-purple-700', unitLabel: 'IPs', tooltip: 'Active DHCP leases and statically-assigned IP addresses. Rate: 1 management token per 13 active IPs.' },
                  { key: 'Asset', label: 'Managed Assets', color: 'text-green-600', bgLight: 'bg-green-50', barColor: 'bg-green-500', textColor: 'text-green-700', unitLabel: 'assets', tooltip: 'VMs, EC2 instances, container nodes, AD computers, and other managed endpoints. Rate: 1 management token per 3 managed assets.' },
                ];

                return (
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
                    {categories.map((cat) => {
                      const catTokens = categoryTotals[cat.key];
                      const catCount = effectiveFindings.filter(f => f.category === cat.key).reduce((s, f) => s + f.count, 0);
                      const sources = buildSourceList(cat.key);
                      const maxSourceTokens = Math.max(...sources.map(s => s.tokens), 1);

                      return (
                        <div key={cat.key} className="bg-white rounded-xl border border-[var(--border)] overflow-hidden flex flex-col">
                          {/* Category header */}
                          <div className={`px-4 py-4 border-b border-[var(--border)] ${cat.bgLight}`}>
                            <div className="flex items-center gap-1 text-[12px] text-[var(--muted-foreground)] mb-1">
                              {cat.label}
                              <FieldTooltip text={cat.tooltip} side="top" />
                            </div>
                            <div className={`text-[24px] ${cat.color}`} style={{ fontWeight: 700 }}>
                              {catTokens.toLocaleString()}
                              <span className="text-[12px] text-[var(--muted-foreground)] ml-1.5" style={{ fontWeight: 400 }}>tokens</span>
                            </div>
                            <div className="text-[11px] text-[var(--muted-foreground)]">
                              {catCount.toLocaleString()} {cat.unitLabel} (1 token per {TOKEN_RATES[cat.key]})
                            </div>
                          </div>

                          {/* Per-source breakdown */}
                          <div className="px-4 py-3 flex-1">
                            <div className="text-[11px] text-[var(--muted-foreground)] mb-2 uppercase tracking-wider" style={{ fontWeight: 500 }}>
                              By {sourceLabel}
                            </div>
                            <div className="space-y-3">
                              {(() => {
                                const CAT_LIMIT = 5;
                                const showAll = showAllCategorySources[cat.key] || false;
                                const visible = showAll ? sources : sources.slice(0, CAT_LIMIT);
                                const catHidden = sources.length - CAT_LIMIT;
                                const needsScroll = showAll && sources.length > 10;
                                return (
                                  <div className={needsScroll ? 'max-h-[300px] overflow-y-auto' : ''}>
                                    {visible.map((entry) => {
                                      const provider = PROVIDERS.find((p) => p.id === entry.provider)!;
                                      const pct = maxSourceTokens > 0 ? (entry.tokens / maxSourceTokens) * 100 : 0;
                                      return (
                                        <div key={`${entry.provider}-${entry.source}`}>
                                          <div className="flex items-center justify-between mb-1">
                                            <span className="text-[12px] flex items-center gap-1.5 min-w-0" style={{ fontWeight: 500 }}>
                                              <span
                                                className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
                                                style={{ backgroundColor: provider.color }}
                                              />
                                              <span className="truncate">{entry.source}</span>
                                            </span>
                                            <span className="text-[12px] tabular-nums shrink-0 ml-2" style={{ fontWeight: 600 }}>
                                              {entry.tokens.toLocaleString()}
                                            </span>
                                          </div>
                                          <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                                            <div
                                              className={`h-full rounded-full transition-all ${cat.barColor}`}
                                              style={{ width: `${pct}%` }}
                                            />
                                          </div>
                                          <div className="text-[10px] text-[var(--muted-foreground)] mt-0.5 tabular-nums">
                                            {entry.count.toLocaleString()} {cat.unitLabel}
                                          </div>
                                        </div>
                                      );
                                    })}
                                    {catHidden > 0 && (
                                      <button
                                        type="button"
                                        onClick={() => setShowAllCategorySources((prev) => ({ ...prev, [cat.key]: !showAll }))}
                                        className="text-[11px] text-[var(--infoblox-blue)] hover:underline"
                                        style={{ fontWeight: 500 }}
                                      >
                                        {showAll ? 'Show less' : `+${catHidden} more`}
                                      </button>
                                    )}
                                  </div>
                                );
                              })()}
                              {sources.length === 0 && (
                                <div className="text-[12px] text-[var(--muted-foreground)] italic py-2">
                                  No {cat.unitLabel} found
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}

              {/* NIOS-X Migration Planner — only shown when NIOS is among selected providers */}
              {selectedProviders.includes('nios') && (() => {
                // Collect unique NIOS sources (grid members)
                const niosSources = Array.from(
                  new Map(
                    findings
                      .filter((f) => f.provider === 'nios')
                      .map((f) => [f.source, f.source])
                  ).keys()
                );

                const toggleMigration = (source: string) => {
                  setNiosMigrationMap((prev) => {
                    const next = new Map(prev);
                    if (next.has(source)) next.delete(source); else next.set(source, 'nios-x');
                    return next;
                  });
                };

                const setMemberFormFactor = (source: string, ff: ServerFormFactor) => {
                  setNiosMigrationMap((prev) => {
                    const next = new Map(prev);
                    next.set(source, ff);
                    return next;
                  });
                };

                // Filter sources by search term
                const filteredSources = memberSearchFilter
                  ? niosSources.filter(s => s.toLowerCase().includes(memberSearchFilter.toLowerCase()))
                  : niosSources;

                const toggleAllMigration = () => {
                  const targets = memberSearchFilter ? filteredSources : niosSources;
                  const allTargetsMigrated = targets.every(s => niosMigrationMap.has(s));
                  if (allTargetsMigrated) {
                    setNiosMigrationMap(prev => {
                      const next = new Map(prev);
                      targets.forEach(s => next.delete(s));
                      return next;
                    });
                  } else {
                    setNiosMigrationMap(prev => {
                      const next = new Map(prev);
                      targets.forEach(s => next.set(s, next.get(s) || 'nios-x'));
                      return next;
                    });
                  }
                };

                // Compute tokens by scenario
                const niosFindings = effectiveFindings.filter((f) => f.provider === 'nios');
                const nonNiosTokens = effectiveFindings.filter((f) => f.provider !== 'nios').reduce((s, f) => s + f.managementTokens, 0);
                // NIOS Licensing column uses NIOS ratios (50/25/13), not UDDI ratios
                const allNiosTokens = calcNiosTokens(niosFindings);
                // UDDI tokens for all NIOS findings (used in Full Migration scenario) — native rates
                const allNiosUddiTokens = niosFindings.reduce((s, f) => s + Math.ceil(f.count / (TOKEN_RATES[f.category as keyof typeof TOKEN_RATES] ?? 25)), 0);

                const stayingFindings = niosFindings.filter((f) => !niosMigrationMap.has(f.source));
                const stayingTokens = calcNiosTokens(stayingFindings);
                // Migrating tokens use UDDI native rates (they move to UDDI licensing)
                const migratingTokens = niosFindings
                  .filter((f) => niosMigrationMap.has(f.source))
                  .reduce((s, f) => s + Math.ceil(f.count / (TOKEN_RATES[f.category as keyof typeof TOKEN_RATES] ?? 25)), 0);

                const niosXCount = Array.from(niosMigrationMap.values()).filter(v => v === 'nios-x').length;
                const xaasCount = Array.from(niosMigrationMap.values()).filter(v => v === 'nios-xaas').length;
                const hybridDesc = niosMigrationMap.size > 0
                  ? `${niosMigrationMap.size} of ${niosSources.length} members migrated${niosXCount > 0 && xaasCount > 0 ? ` (${niosXCount} NIOS-X, ${xaasCount} XaaS)` : niosXCount > 0 ? ' to NIOS-X' : ' to XaaS'}. Remaining stay on NIOS licensing.`
                  : `Select members to migrate. Remaining stay on NIOS licensing.`;

                // Scenarios
                const scenarioCurrent = { label: 'Current (NIOS Only)', niosTokens: 0, uddiTokens: nonNiosTokens, desc: 'Only cloud/MS sources need UDDI tokens. NIOS stays on traditional licensing.' };
                const scenarioHybrid = { label: 'Hybrid', niosTokens: stayingTokens, uddiTokens: nonNiosTokens + migratingTokens, desc: hybridDesc };
                const scenarioFull = { label: 'Full Universal DDI', niosTokens: 0, uddiTokens: nonNiosTokens + allNiosUddiTokens, desc: 'All NIOS members migrated to Universal DDI. Everything on Universal DDI licensing.' };

                return (
                  <div id="section-migration-planner" className="bg-white rounded-xl border-2 border-[var(--infoblox-blue)]/30 mb-6 overflow-hidden">
                    <div className="px-4 py-3 border-b border-[var(--border)] bg-blue-50/50 flex items-center gap-2">
                      <img src={NIOS_GRID_LOGO} alt="NIOS Grid" className="w-5 h-5 rounded" />
                      <ArrowRightLeft className="w-4 h-4 text-[var(--infoblox-blue)]" />
                      <h3 className="text-[14px]" style={{ fontWeight: 600 }}>
                        NIOS-X Migration Planner
                      </h3>
                      <span className="ml-auto text-[11px] text-[var(--muted-foreground)]">
                        Select grid members &amp; target form factor
                      </span>
                    </div>

                    {/* Member selector */}
                    <div className="px-4 py-3 border-b border-[var(--border)]">
                      {/* Search filter */}
                      <div className="relative mb-2">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
                        <input
                          type="text"
                          placeholder="Filter members..."
                          value={memberSearchFilter}
                          onChange={(e) => setMemberSearchFilter(e.target.value)}
                          className="w-full pl-8 pr-3 py-2 text-[12px] rounded-lg border border-[var(--border)] focus:outline-none focus:ring-1 focus:ring-[var(--infoblox-blue)] focus:border-[var(--infoblox-blue)]"
                        />
                      </div>
                      <div className="flex items-center gap-2 mb-3">
                        <button
                          onClick={toggleAllMigration}
                          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12px] border border-[var(--border)] hover:bg-gray-50 transition-colors"
                          style={{ fontWeight: 500 }}
                        >
                          {(() => {
                            const targets = memberSearchFilter ? filteredSources : niosSources;
                            const allTargetsMigrated = targets.length > 0 && targets.every(s => niosMigrationMap.has(s));
                            const someTargetsMigrated = targets.some(s => niosMigrationMap.has(s));
                            return (
                              <>
                                <div className={`w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
                                  allTargetsMigrated
                                    ? 'bg-[var(--infoblox-blue)] border-[var(--infoblox-blue)]'
                                    : someTargetsMigrated
                                      ? 'bg-[var(--infoblox-blue)]/60 border-[var(--infoblox-blue)]'
                                      : 'border-gray-300'
                                }`}>
                                  {allTargetsMigrated && <Check className="w-2.5 h-2.5 text-white" />}
                                  {someTargetsMigrated && !allTargetsMigrated && <Minus className="w-2.5 h-2.5 text-white" />}
                                </div>
                                {allTargetsMigrated ? 'Deselect All' : 'Migrate All'}
                              </>
                            );
                          })()}
                        </button>
                        <span className="text-[11px] text-[var(--muted-foreground)]">
                          {memberSearchFilter
                            ? `${filteredSources.length} of ${niosSources.length} members`
                            : `${niosMigrationMap.size} of ${niosSources.length} members selected`}
                          {niosMigrationMap.size > 0 && !memberSearchFilter && (() => {
                            const nx = Array.from(niosMigrationMap.values()).filter(v => v === 'nios-x').length;
                            const xs = Array.from(niosMigrationMap.values()).filter(v => v === 'nios-xaas').length;
                            if (nx > 0 && xs > 0) return ` (${nx} NIOS-X, ${xs} XaaS)`;
                            if (xs > 0) return ` (${xs} XaaS)`;
                            return ` (${nx} NIOS-X)`;
                          })()}
                        </span>
                      </div>
                      <div className="max-h-[320px] overflow-y-auto border-t border-b border-gray-100">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 py-1">
                        {filteredSources.map((source) => {
                          const isMigrating = niosMigrationMap.has(source);
                          const memberFF = niosMigrationMap.get(source) || 'nios-x';
                          const sourceTokens = niosFindings.filter((f) => f.source === source).reduce((s, f) => s + f.managementTokens, 0);
                          return (
                            <div
                              key={source}
                              className={`flex items-center gap-2.5 px-3 py-2 rounded-lg transition-colors ${
                                isMigrating
                                  ? memberFF === 'nios-xaas'
                                    ? 'bg-purple-50 border border-purple-200'
                                    : 'bg-blue-50 border border-blue-200'
                                  : 'border border-[var(--border)] hover:bg-gray-50'
                              }`}
                            >
                              <button
                                onClick={() => toggleMigration(source)}
                                className="flex items-center gap-0 shrink-0"
                              >
                                <div className={`w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
                                  isMigrating
                                    ? memberFF === 'nios-xaas'
                                      ? 'bg-purple-600 border-purple-600'
                                      : 'bg-[var(--infoblox-blue)] border-[var(--infoblox-blue)]'
                                    : 'border-gray-300'
                                }`}>
                                  {isMigrating && <Check className="w-3 h-3 text-white" />}
                                </div>
                              </button>
                              <div className="flex-1 min-w-0">
                                <div className="text-[12px] truncate" style={{ fontWeight: 500 }}>{source}</div>
                                <div className="text-[10px] text-[var(--muted-foreground)]">{sourceTokens.toLocaleString()} tokens</div>
                              </div>
                              {isMigrating && (
                                <div className="flex items-center bg-white rounded-md border border-gray-200 p-0.5 shrink-0">
                                  <button
                                    onClick={() => setMemberFormFactor(source, 'nios-x')}
                                    className={`px-2 py-0.5 rounded text-[9px] transition-all ${
                                      memberFF === 'nios-x'
                                        ? 'bg-[var(--infoblox-navy)] text-white shadow-sm'
                                        : 'text-gray-400 hover:text-gray-600'
                                    }`}
                                    style={{ fontWeight: 600 }}
                                  >
                                    NIOS-X
                                  </button>
                                  <button
                                    onClick={() => setMemberFormFactor(source, 'nios-xaas')}
                                    className={`px-2 py-0.5 rounded text-[9px] transition-all ${
                                      memberFF === 'nios-xaas'
                                        ? 'bg-purple-600 text-white shadow-sm'
                                        : 'text-gray-400 hover:text-gray-600'
                                    }`}
                                    style={{ fontWeight: 600 }}
                                  >
                                    XaaS
                                  </button>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                      </div>
                    </div>

                    {/* Scenario comparison cards */}
                    {(() => {
                      const niosIsActive = (idx: number) =>
                        idx === 0 ? niosMigrationMap.size === 0
                        : idx === 1 ? niosMigrationMap.size > 0 && niosMigrationMap.size < niosSources.length
                        : niosMigrationMap.size === niosSources.length;

                      // Management Token scenarios
                      const mgmtScenarios: ScenarioCard[] = [
                        {
                          label: 'Current (NIOS Only)',
                          primaryValue: nonNiosTokens,
                          desc: 'Only cloud/MS sources need UDDI tokens. NIOS stays on traditional licensing.',
                        },
                        {
                          label: 'Hybrid',
                          primaryValue: nonNiosTokens + migratingTokens + stayingTokens,
                          subLines: stayingTokens > 0 ? [
                            { text: `${(nonNiosTokens + migratingTokens).toLocaleString()} on NIOS-X / Universal DDI`, color: '#0078d4' },
                            { text: `${stayingTokens.toLocaleString()} on NIOS Licensing`, color: '#6b7280' },
                          ] : [],
                          desc: hybridDesc,
                        },
                        {
                          label: 'Full Universal DDI',
                          primaryValue: nonNiosTokens + allNiosUddiTokens,
                          desc: 'All NIOS members migrated to Universal DDI. Everything on Universal DDI licensing.',
                        },
                      ];

                      // Server Token scenarios — compute per-scenario using migration map
                      const calcNiosServerScenario = (members: typeof effectiveNiosMetrics) => {
                        const niosXMems = members.filter(m => (niosMigrationMap.get(m.memberName) || 'nios-x') !== 'nios-xaas');
                        const xaasMems  = members.filter(m => niosMigrationMap.get(m.memberName) === 'nios-xaas');
                        const nxTok = niosXMems.reduce((s, m) => s + calcServerTokenTier(m.qps, m.lps, serverSizingObjects(m), 'nios-x').serverTokens, 0);
                        const xaasInst = consolidateXaasInstances(xaasMems);
                        return nxTok + xaasInst.reduce((s, inst) => s + inst.totalTokens, 0);
                      };
                      // Full: all members → NIOS-X baseline
                      const fullSrvTokens = effectiveNiosMetrics.reduce(
                        (s, m) => s + calcServerTokenTier(m.qps, m.lps, serverSizingObjects(m), 'nios-x').serverTokens, 0);
                      const hybridSrvTokens = effectiveNiosMetrics.filter(m => niosMigrationMap.has(m.memberName)).length > 0
                        ? calcNiosServerScenario(effectiveNiosMetrics.filter(m => niosMigrationMap.has(m.memberName)))
                        : 0;

                      const srvScenarios: ScenarioCard[] = [
                        { label: 'Current (NIOS Only)', primaryValue: 0,               desc: 'NIOS stays on traditional licensing. No NIOS-X server tokens required.' },
                        { label: 'Hybrid',              primaryValue: hybridSrvTokens,  desc: hybridDesc },
                        { label: 'Full Universal DDI',  primaryValue: fullSrvTokens,    desc: 'All members migrated. Server tokens cover every NIOS-X appliance or XaaS instance.' },
                      ];

                      return (
                        <>
                          <ScenarioPlannerCards
                            title="Management Tokens"
                            unit="Universal DDI Tokens"
                            color="orange"
                            scenarios={mgmtScenarios}
                            isActive={niosIsActive}
                          />
                          {effectiveNiosMetrics.length > 0 && (
                            <ScenarioPlannerCards
                              title="Server Tokens"
                              unit="Server Tokens (IB-TOKENS-UDDI-SERV-500)"
                              color="blue"
                              scenarios={srvScenarios}
                              isActive={niosIsActive}
                            />
                          )}
                        </>
                      );
                    })()}

                    {/* Server Token Calculator — inline within Migration Planner */}
                    {effectiveNiosMetrics.length > 0 && (() => {
                      // Only show metrics for members selected for migration
                      const migratingMembers = effectiveNiosMetrics.filter((m) =>
                        niosMigrationMap.has(m.memberName)
                      );
                      const allMembers = effectiveNiosMetrics.filter((m) => {
                        const niosSources = new Set(
                          effectiveFindings.filter((f) => f.provider === 'nios').map((f) => f.source)
                        );
                        return niosSources.has(m.memberName);
                      });

                      const displayMembers = migratingMembers.length > 0 ? migratingMembers : allMembers;

                // Per-member form factor helper
                const getMemberFF = (memberName: string): ServerFormFactor =>
                  niosMigrationMap.get(memberName) || 'nios-x';

                const hasAnyXaas = displayMembers.some((m) => getMemberFF(m.memberName) === 'nios-xaas');
                const xaasMembers = displayMembers.filter((m) => getMemberFF(m.memberName) === 'nios-xaas');
                const niosXMembers = displayMembers.filter((m) => getMemberFF(m.memberName) === 'nios-x');
                const niosXMemberCount = niosXMembers.length;
                const xaasMemberCount = xaasMembers.length;

                // Consolidate XaaS members into instances (1 instance can replace many NIOS members)
                const xaasInstances = consolidateXaasInstances(xaasMembers);
                const totalXaasTokens = xaasInstances.reduce((s, inst) => s + inst.totalTokens, 0);

                // NIOS-X tokens (individual per member)
                const niosXTokens = niosXMembers.reduce((sum, m) => {
                  return sum + calcServerTokenTier(m.qps, m.lps, serverSizingObjects(m), 'nios-x').serverTokens;
                }, 0);

                const totalServerTokens = niosXTokens + totalXaasTokens;
                const totalNiosReplaced = xaasMembers.length; // 1 connection per NIOS member replaced

                      const roleColors: Record<string, string> = {
                        GM: '#002B49',
                        GMC: '#1a4a6e',
                        DNS: '#0078d4',
                        DHCP: '#00a5e5',
                        'DNS/DHCP': '#005a9e',
                        IPAM: '#7fba00',
                        Reporting: '#8b8b8b',
                      };

                      const tierColorClass = (name: string) =>
                        name === 'XL' ? 'bg-red-100 text-red-700' :
                        name === 'L' ? 'bg-orange-100 text-orange-700' :
                        name === 'M' ? 'bg-yellow-100 text-yellow-700' :
                        name === 'S' ? 'bg-green-100 text-green-700' :
                        name === 'XS' ? 'bg-sky-100 text-sky-700' :
                        'bg-gray-100 text-gray-700';

                      return (
                        <div id="section-server-tokens" className="border-t border-emerald-200 bg-emerald-50/20">
                          <div className="px-4 py-3 border-b border-emerald-200 bg-emerald-50/50 flex items-center gap-2 flex-wrap">
                      <img src={NIOS_GRID_LOGO} alt="NIOS Grid" className="w-5 h-5 rounded" />
                      <h3 className="text-[14px]" style={{ fontWeight: 600 }}>
                        Server Token Calculator
                      </h3>

                      <span className="ml-auto text-[11px] text-[var(--muted-foreground)]">
                        {migratingMembers.length > 0
                          ? `${migratingMembers.length} member${migratingMembers.length > 1 ? 's' : ''} selected${niosXMemberCount > 0 && xaasMemberCount > 0 ? ` (${niosXMemberCount} NIOS-X, ${xaasMemberCount} XaaS)` : niosXMemberCount > 0 ? ' \u2192 NIOS-X' : ' \u2192 XaaS'}`
                          : `${allMembers.length} grid member${allMembers.length > 1 ? 's' : ''} detected`}
                      </span>
                    </div>

                    {/* Summary hero */}
                    <div className="px-4 py-4 border-b border-[var(--border)] bg-gradient-to-r from-emerald-50/80 to-white">
                      <div className={`grid ${hasAnyXaas ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-1 sm:grid-cols-2'} gap-4`}>
                        <div>
                          <div className="flex items-center gap-1 text-[11px] uppercase tracking-wider text-[var(--muted-foreground)] mb-1" style={{ fontWeight: 600 }}>
                            Allocated Server Tokens
                            <FieldTooltip text="Server tokens (IB-TOKENS-UDDI-SERV-500) are needed for each NIOS-X appliance or XaaS instance based on its performance tier. This is separate from management tokens." side="top" />
                          </div>
                          <div className="text-[28px] text-emerald-700" style={{ fontWeight: 700 }}>
                            {totalServerTokens.toLocaleString()}
                          </div>
                          <div className="text-[10px] text-[var(--muted-foreground)]">
                            {niosXMemberCount > 0 && `${niosXTokens.toLocaleString()} NIOS-X`}
                            {niosXMemberCount > 0 && xaasMemberCount > 0 && ' + '}
                            {xaasMemberCount > 0 && `${totalXaasTokens.toLocaleString()} XaaS`}
                          </div>
                        </div>
                        <div>
                          <div className="text-[11px] uppercase tracking-wider text-[var(--muted-foreground)] mb-1" style={{ fontWeight: 600 }}>
                            NIOS Members
                          </div>
                          <div className="text-[22px] text-[var(--foreground)]" style={{ fontWeight: 600 }}>
                            {displayMembers.length}
                          </div>
                          <div className="text-[10px] text-[var(--muted-foreground)]">
                            {niosXMemberCount > 0 && `${niosXMemberCount} \u2192 NIOS-X`}
                            {niosXMemberCount > 0 && xaasMembers.length > 0 && ' \u00b7 '}
                            {xaasMembers.length > 0 && `${xaasMembers.length} \u2192 XaaS`}
                          </div>
                        </div>
                        {hasAnyXaas && ([
                            <div key="xaas-inst-summary">
                              <div className="text-[11px] uppercase tracking-wider text-[var(--muted-foreground)] mb-1" style={{ fontWeight: 600 }}>
                                XaaS Instances
                              </div>
                              <div className="text-[22px] text-purple-700" style={{ fontWeight: 600 }}>
                                {xaasInstances.length}
                              </div>
                              <div className="text-[10px] text-[var(--muted-foreground)]">
                                replacing {totalNiosReplaced} NIOS member{totalNiosReplaced > 1 ? 's' : ''}
                              </div>
                            </div>,
                            <div key="xaas-consol-ratio">
                              <div className="text-[11px] uppercase tracking-wider text-[var(--muted-foreground)] mb-1" style={{ fontWeight: 600 }}>
                                Consolidation Ratio
                              </div>
                              <div className="text-[22px] text-purple-700" style={{ fontWeight: 600 }}>
                                {totalNiosReplaced}:{xaasInstances.length}
                              </div>
                              <div className="text-[10px] text-[var(--muted-foreground)]">
                                {totalNiosReplaced} NIOS \u2192 {xaasInstances.length} XaaS instance{xaasInstances.length > 1 ? 's' : ''}
                              </div>
                            </div>
                        ])}
                      </div>
                      {hasAnyXaas && (
                        <div className="mt-3 flex flex-col gap-1.5">
                          <div className="flex items-start gap-1.5 text-[10px] text-purple-700 bg-purple-50 rounded-lg px-3 py-1.5 border border-purple-200">
                            <Info className="w-3 h-3 mt-0.5 shrink-0" />
                            <span>
                              <b>{xaasMembers.length} NIOS member{xaasMembers.length > 1 ? 's' : ''}</b> consolidated into <b>{xaasInstances.length} XaaS instance{xaasInstances.length > 1 ? 's' : ''}</b>.
                              {' '}Each XaaS instance uses aggregate QPS/LPS/Objects to determine the T-shirt size.
                              {' '}1 connection = 1 NIOS member replaced.
                            </span>
                          </div>
                          {xaasInstances.some(inst => inst.extraConnections > 0) && (
                            <div className="flex items-start gap-1.5 text-[10px] text-amber-700 bg-amber-50 rounded-lg px-3 py-1.5 border border-amber-200">
                              <Info className="w-3 h-3 mt-0.5 shrink-0" />
                              <span>
                                Some instances need extra connections beyond the included tier limit (+{XAAS_EXTRA_CONNECTION_COST} tokens each, up to 400 extra per instance).
                              </span>
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Per-member table */}
                    <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
                      <table className="w-full text-[12px]">
                        <thead className="sticky top-0 z-10">
                          <tr className="border-b border-[var(--border)] bg-gray-50">
                            <th className="text-left px-4 py-2.5" style={{ fontWeight: 600 }}>Grid Member</th>
                            <th className="text-center px-3 py-2.5" style={{ fontWeight: 600 }}>Role</th>
                            <th className="text-center px-3 py-2.5" style={{ fontWeight: 600 }}>Target</th>
                            <th className="text-right px-3 py-2.5" style={{ fontWeight: 600 }}>
                              <span className="flex items-center justify-end gap-1">
                                <Activity className="w-3 h-3" /> QPS
                                <FieldTooltip text="Queries per second — DNS query rate observed on this member. Used with LPS and object count to size the NIOS-X appliance tier." side="top" />
                              </span>
                            </th>
                            <th className="text-right px-3 py-2.5" style={{ fontWeight: 600 }}>
                              <span className="flex items-center justify-end gap-1">
                                <Gauge className="w-3 h-3" /> LPS
                                <FieldTooltip text="Leases per second — DHCP lease rate. High LPS drives appliance tier up independently of QPS." side="top" />
                              </span>
                            </th>
                            <th className="text-right px-3 py-2.5" style={{ fontWeight: 600 }}>Objects</th>
                            <th className="text-center px-3 py-2.5" style={{ fontWeight: 600 }}>
                              <span className="flex items-center justify-center gap-1">
                                Size
                                <FieldTooltip text="NIOS-X appliance T-shirt size (2XS → XL) determined by the highest of QPS, LPS, and object thresholds. Each tier has a fixed server token cost." side="top" />
                              </span>
                            </th>
                            <th className="text-center px-3 py-2.5" style={{ fontWeight: 600 }}>
                              <span className="text-emerald-700">Allocated Tokens</span>
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {/* NIOS-X members — individual rows */}
                          {niosXMembers.map((member) => {
                            const tier = calcServerTokenTier(member.qps, member.lps, serverSizingObjects(member), 'nios-x');
                            return (
                              <tr key={member.memberId} className="border-b border-[var(--border)] hover:bg-gray-50/50 transition-colors">
                                <td className="px-4 py-2.5">
                                  <div className="truncate max-w-[260px]" style={{ fontWeight: 500 }}>{member.memberName}</div>
                                </td>
                                <td className="text-center px-3 py-2.5">
                                  <span
                                    className="inline-block px-2 py-0.5 rounded text-[10px] text-white"
                                    style={{ fontWeight: 600, backgroundColor: roleColors[member.role] || '#666' }}
                                  >
                                    {member.role}
                                  </span>
                                </td>
                                <td className="text-center px-3 py-2.5">
                                  <span className="inline-block px-2 py-0.5 rounded text-[10px] bg-blue-100 text-blue-700" style={{ fontWeight: 600 }}>
                                    NIOS-X
                                  </span>
                                </td>
                                <td className="text-right px-3 py-2.5 tabular-nums">
                                  {member.qps > 0 ? member.qps.toLocaleString() : <span className="text-gray-300">&mdash;</span>}
                                </td>
                                <td className="text-right px-3 py-2.5 tabular-nums">
                                  {member.lps > 0 ? member.lps.toLocaleString() : <span className="text-gray-300">&mdash;</span>}
                                </td>
                                <td className="text-right px-3 py-2.5 tabular-nums">
                                  {serverSizingObjects(member) > 0 ? serverSizingObjects(member).toLocaleString() : <span className="text-gray-300">&mdash;</span>}
                                </td>
                                <td className="text-center px-3 py-2.5">
                                  <span className={`inline-block px-2 py-0.5 rounded text-[10px] ${tierColorClass(tier.name)}`} style={{ fontWeight: 600 }}>
                                    {tier.name}
                                  </span>
                                </td>
                                <td className="text-center px-3 py-2.5">
                                  <span className="inline-flex items-center justify-center min-w-[36px] h-7 px-1.5 rounded-full bg-emerald-100 text-emerald-700 text-[12px]" style={{ fontWeight: 700 }}>
                                    {tier.serverTokens.toLocaleString()}
                                  </span>
                                </td>
                              </tr>
                            );
                          })}

                        </tbody>
                          {/* XaaS consolidated instances */}
                          {xaasInstances.map((inst) => (
                            <tbody key={`xaas-inst-${inst.index}`}>
                              {/* Instance header row */}
                              <tr className="bg-purple-50 border-b border-purple-200">
                                <td className="px-4 py-2 text-[11px] text-purple-800" style={{ fontWeight: 700 }} colSpan={8}>
                                  <div className="flex items-center gap-2">
                                    <span className="inline-flex items-center gap-1.5">
                                      <span className="inline-block w-2.5 h-2.5 rounded-full bg-purple-500" />
                                      XaaS Instance {xaasInstances.length > 1 ? inst.index + 1 : ''}
                                    </span>
                                    <span className="text-purple-500" style={{ fontWeight: 400 }}>—</span>
                                    <span className="text-purple-600" style={{ fontWeight: 500 }}>
                                      replaces {inst.connectionsUsed} NIOS member{inst.connectionsUsed > 1 ? 's' : ''}
                                    </span>
                                    <span className="ml-auto flex items-center gap-2">
                                      <span className={`inline-block px-2 py-0.5 rounded text-[10px] ${tierColorClass(inst.tier.name)}`} style={{ fontWeight: 600 }}>
                                        {inst.tier.name}
                                      </span>
                                      <span className="inline-flex items-center justify-center min-w-[36px] h-6 px-1.5 rounded-full bg-purple-200 text-purple-800 text-[11px]" style={{ fontWeight: 700 }}>
                                        {inst.totalTokens.toLocaleString()}
                                      </span>
                                    </span>
                                  </div>
                                </td>
                              </tr>
                              {/* Individual member rows within this instance */}
                              {inst.members.map((member) => (
                                <tr key={member.memberId} className="border-b border-purple-100 hover:bg-purple-50/30 transition-colors">
                                  <td className="pl-8 pr-4 py-2">
                                    <div className="truncate max-w-[240px] text-[11px] text-purple-700" style={{ fontWeight: 500 }}>{member.memberName}</div>
                                  </td>
                                  <td className="text-center px-3 py-2">
                                    <span
                                      className="inline-block px-2 py-0.5 rounded text-[10px] text-white"
                                      style={{ fontWeight: 600, backgroundColor: roleColors[member.role] || '#666' }}
                                    >
                                      {member.role}
                                    </span>
                                  </td>
                                  <td className="text-center px-3 py-2">
                                    <span className="inline-block px-2 py-0.5 rounded text-[9px] bg-purple-100 text-purple-600" style={{ fontWeight: 500 }}>
                                      1 conn
                                    </span>
                                  </td>
                                  <td className="text-right px-3 py-2 tabular-nums text-[11px] text-purple-600">
                                    {member.qps > 0 ? member.qps.toLocaleString() : <span className="text-gray-300">&mdash;</span>}
                                  </td>
                                  <td className="text-right px-3 py-2 tabular-nums text-[11px] text-purple-600">
                                    {member.lps > 0 ? member.lps.toLocaleString() : <span className="text-gray-300">&mdash;</span>}
                                  </td>
                                  <td className="text-right px-3 py-2 tabular-nums text-[11px] text-purple-600">
                                    {serverSizingObjects(member) > 0 ? serverSizingObjects(member).toLocaleString() : <span className="text-gray-300">&mdash;</span>}
                                  </td>
                                  <td className="text-center px-3 py-2" colSpan={2}>
                                    <span className="text-[10px] text-gray-400">(consolidated)</span>
                                  </td>
                                </tr>
                              ))}
                              {/* Consolidated aggregate row */}
                              <tr className="border-b border-purple-300 bg-purple-50/80">
                                <td className="pl-8 pr-4 py-2 text-[11px] text-purple-800" style={{ fontWeight: 600 }}>
                                  Aggregate ({inst.connectionsUsed} connection{inst.connectionsUsed > 1 ? 's' : ''} used / {inst.tier.maxConnections} included)
                                  {inst.extraConnections > 0 && (
                                    <span className="text-amber-600 ml-1">+{inst.extraConnections} extra</span>
                                  )}
                                </td>
                                <td className="text-center px-3 py-2">
                                  <span className="inline-block px-2 py-0.5 rounded text-[10px] bg-purple-100 text-purple-700" style={{ fontWeight: 600 }}>
                                    XaaS
                                  </span>
                                </td>
                                <td className="text-center px-3 py-2 text-[10px] text-purple-700" style={{ fontWeight: 600 }}>
                                  {inst.connectionsUsed} conn
                                </td>
                                <td className="text-right px-3 py-2 tabular-nums text-purple-800" style={{ fontWeight: 600 }}>
                                  {inst.totalQps > 0 ? inst.totalQps.toLocaleString() : <span className="text-gray-300">&mdash;</span>}
                                </td>
                                <td className="text-right px-3 py-2 tabular-nums text-purple-800" style={{ fontWeight: 600 }}>
                                  {inst.totalLps > 0 ? inst.totalLps.toLocaleString() : <span className="text-gray-300">&mdash;</span>}
                                </td>
                                <td className="text-right px-3 py-2 tabular-nums text-purple-800" style={{ fontWeight: 600 }}>
                                  {inst.totalObjects > 0 ? inst.totalObjects.toLocaleString() : <span className="text-gray-300">&mdash;</span>}
                                </td>
                                <td className="text-center px-3 py-2">
                                  <span className={`inline-block px-2 py-0.5 rounded text-[10px] ${tierColorClass(inst.tier.name)}`} style={{ fontWeight: 600 }}>
                                    {inst.tier.name}
                                  </span>
                                </td>
                                <td className="text-center px-3 py-2">
                                  <span className="inline-flex items-center justify-center min-w-[36px] h-7 px-1.5 rounded-full bg-purple-200 text-purple-800 text-[12px]" style={{ fontWeight: 700 }}>
                                    {inst.totalTokens.toLocaleString()}
                                  </span>
                                  {inst.extraConnectionTokens > 0 && (
                                    <div className="text-[9px] text-amber-600 mt-0.5">
                                      incl. {inst.extraConnectionTokens.toLocaleString()} extra conn
                                    </div>
                                  )}
                                </td>
                              </tr>
                            </tbody>
                          ))}
                        <tfoot className="sticky bottom-0 z-10">
                          <tr className="bg-emerald-50">
                            <td className="px-4 py-2.5 text-[12px]" style={{ fontWeight: 700 }} colSpan={7}>
                              Total Allocated Server Tokens
                              {hasAnyXaas && (
                                <span className="text-[10px] text-[var(--muted-foreground)] ml-2" style={{ fontWeight: 400 }}>
                                  ({niosXMemberCount > 0 ? `${niosXMemberCount} NIOS-X` : ''}{niosXMemberCount > 0 && xaasInstances.length > 0 ? ' + ' : ''}{xaasInstances.length > 0 ? `${xaasInstances.length} XaaS instance${xaasInstances.length > 1 ? 's' : ''} replacing ${totalNiosReplaced} members` : ''})
                                </span>
                              )}
                            </td>
                            <td className="text-center px-3 py-2.5">
                              <span className="inline-flex items-center justify-center min-w-[40px] h-8 px-2 rounded-full bg-emerald-600 text-white text-[14px]" style={{ fontWeight: 700 }}>
                                {totalServerTokens.toLocaleString()}
                              </span>
                            </td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>


                        </div>
                      );
                    })()}
                  </div>
                );
              })()}

              {/* AD Migration Planner — interactive, mirrors NIOS Grid Migration Planner */}
              {selectedProviders.includes('microsoft') && effectiveADMetrics.length > 0 && (() => {
                const adHostnames = effectiveADMetrics.map(m => m.hostname);

                const toggleAdMigration = (hostname: string) => {
                  setAdMigrationMap((prev) => {
                    const next = new Map(prev);
                    if (next.has(hostname)) next.delete(hostname); else next.set(hostname, 'nios-x');
                    return next;
                  });
                };

                const setAdFormFactor = (hostname: string, ff: ServerFormFactor) => {
                  setAdMigrationMap((prev) => {
                    const next = new Map(prev);
                    next.set(hostname, ff);
                    return next;
                  });
                };

                const filteredADHosts = adMemberSearchFilter
                  ? adHostnames.filter(h => h.toLowerCase().includes(adMemberSearchFilter.toLowerCase()))
                  : adHostnames;

                const toggleAllAdMigration = () => {
                  const targets = adMemberSearchFilter ? filteredADHosts : adHostnames;
                  const allTargetsMigrated = targets.every(h => adMigrationMap.has(h));
                  if (allTargetsMigrated) {
                    setAdMigrationMap(prev => {
                      const next = new Map(prev);
                      targets.forEach(h => next.delete(h));
                      return next;
                    });
                  } else {
                    setAdMigrationMap(prev => {
                      const next = new Map(prev);
                      targets.forEach(h => next.set(h, next.get(h) || 'nios-x'));
                      return next;
                    });
                  }
                };

                // Scenario token calculations — migration-map-aware, XaaS-consolidated.
                // Helper: compute tokens for a set of DCs respecting their form factor.
                const calcAdScenarioTokens = (dcs: typeof effectiveADMetrics) => {
                  if (dcs.length === 0) return 0;
                  const niosXDcs = dcs.filter(m => adMigrationMap.get(m.hostname) !== 'nios-xaas');
                  const xaasDcs  = dcs.filter(m => adMigrationMap.get(m.hostname) === 'nios-xaas');
                  const niosXTok = niosXDcs.reduce((s, m) =>
                    s + calcServerTokenTier(m.qps, m.lps, m.dnsObjects + m.dhcpObjectsWithOverhead, 'nios-x').serverTokens, 0);
                  const xaasInst = consolidateXaasInstances(xaasDcs.map(m => ({
                    memberId: m.hostname, memberName: m.hostname, role: 'DC',
                    qps: m.qps, lps: m.lps, objectCount: m.dnsObjects + m.dhcpObjectsWithOverhead, activeIPCount: 0,
                  })));
                  return niosXTok + xaasInst.reduce((s, inst) => s + inst.totalTokens, 0);
                };

                // Full Migration: all DCs default to NIOS-X when no map entry exists.
                // We simulate "all migrated to NIOS-X" for the baseline full scenario.
                const fullMigrationTokens = effectiveADMetrics.reduce((s, m) =>
                  s + calcServerTokenTier(m.qps, m.lps, m.dnsObjects + m.dhcpObjectsWithOverhead, 'nios-x').serverTokens, 0);

                // Hybrid: only selected DCs, using their actual form factor.
                const hybridServerTokens = calcAdScenarioTokens(
                  effectiveADMetrics.filter(m => adMigrationMap.has(m.hostname))
                );

                const adNiosXCount = Array.from(adMigrationMap.values()).filter(v => v === 'nios-x').length;
                const adXaasCount = Array.from(adMigrationMap.values()).filter(v => v === 'nios-xaas').length;

                const scenarioCurrent = { label: 'Current', tokens: 0, desc: 'All DCs remain on Windows DNS/DHCP licensing. No NIOS-X server tokens required.' };
                const scenarioHybrid = {
                  label: 'Hybrid',
                  tokens: hybridServerTokens,
                  desc: adMigrationMap.size > 0
                    ? `${adMigrationMap.size} of ${adHostnames.length} DCs migrated${adNiosXCount > 0 && adXaasCount > 0 ? ` (${adNiosXCount} NIOS-X, ${adXaasCount} XaaS)` : adNiosXCount > 0 ? ' to NIOS-X' : ' to XaaS'}. Remainder stay on Windows.`
                    : 'Select DCs to migrate. Remainder stay on Windows licensing.'
                };
                const scenarioFull = { label: 'Full Migration', tokens: fullMigrationTokens, desc: `All ${adHostnames.length} DCs migrated to NIOS-X for unified DDI management.` };

                const tierColors: Record<string, string> = {
                  '2XS': 'bg-gray-100 text-gray-700',
                  'XS': 'bg-sky-100 text-sky-700',
                  'S': 'bg-green-100 text-green-700',
                  'M': 'bg-yellow-100 text-yellow-700',
                  'L': 'bg-orange-100 text-orange-700',
                  'XL': 'bg-red-100 text-red-700',
                };

                return (
                  <div id="section-ad-migration" className="bg-white rounded-xl border-2 border-[var(--infoblox-blue)]/30 mb-6 overflow-hidden">
                    <div className="px-4 py-3 border-b border-[var(--border)] bg-gradient-to-r from-blue-50 to-indigo-50 flex items-center gap-2">
                      <span className="text-[var(--infoblox-blue)] text-[16px]">📊</span>
                      <ArrowRightLeft className="w-4 h-4 text-[var(--infoblox-blue)]" />
                      <h3 className="text-[14px]" style={{ fontWeight: 600 }}>
                        AD Migration Planner
                      </h3>
                      <span className="ml-auto text-[11px] text-[var(--muted-foreground)]">
                        Select domain controllers &amp; target form factor
                      </span>
                    </div>

                    {/* DC selector */}
                    <div className="px-4 py-3 border-b border-[var(--border)]">
                      {/* Search filter */}
                      <div className="relative mb-2">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
                        <input
                          type="text"
                          placeholder="Filter domain controllers..."
                          value={adMemberSearchFilter}
                          onChange={(e) => setAdMemberSearchFilter(e.target.value)}
                          className="w-full pl-8 pr-3 py-2 text-[12px] rounded-lg border border-[var(--border)] focus:outline-none focus:ring-1 focus:ring-[var(--infoblox-blue)] focus:border-[var(--infoblox-blue)]"
                        />
                      </div>
                      <div className="flex items-center gap-2 mb-3">
                        <button
                          onClick={toggleAllAdMigration}
                          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12px] border border-[var(--border)] hover:bg-gray-50 transition-colors"
                          style={{ fontWeight: 500 }}
                        >
                          {(() => {
                            const targets = adMemberSearchFilter ? filteredADHosts : adHostnames;
                            const allTargetsMigrated = targets.length > 0 && targets.every(h => adMigrationMap.has(h));
                            const someTargetsMigrated = targets.some(h => adMigrationMap.has(h));
                            return (
                              <>
                                <div className={`w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
                                  allTargetsMigrated
                                    ? 'bg-[var(--infoblox-blue)] border-[var(--infoblox-blue)]'
                                    : someTargetsMigrated
                                      ? 'bg-[var(--infoblox-blue)]/60 border-[var(--infoblox-blue)]'
                                      : 'border-gray-300'
                                }`}>
                                  {allTargetsMigrated && <Check className="w-2.5 h-2.5 text-white" />}
                                  {someTargetsMigrated && !allTargetsMigrated && <Minus className="w-2.5 h-2.5 text-white" />}
                                </div>
                                {allTargetsMigrated ? 'Deselect All' : 'Migrate All'}
                              </>
                            );
                          })()}
                        </button>
                        <span className="text-[11px] text-[var(--muted-foreground)]">
                          {adMemberSearchFilter
                            ? `${filteredADHosts.length} of ${adHostnames.length} DCs`
                            : `${adMigrationMap.size} of ${adHostnames.length} DCs selected`}
                          {adMigrationMap.size > 0 && !adMemberSearchFilter && (() => {
                            if (adNiosXCount > 0 && adXaasCount > 0) return ` (${adNiosXCount} NIOS-X, ${adXaasCount} XaaS)`;
                            if (adXaasCount > 0) return ` (${adXaasCount} XaaS)`;
                            return ` (${adNiosXCount} NIOS-X)`;
                          })()}
                        </span>
                      </div>
                      <div className="max-h-[320px] overflow-y-auto border-t border-b border-gray-100">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 py-1">
                          {filteredADHosts.map((hostname) => {
                            const m = effectiveADMetrics.find(met => met.hostname === hostname)!;
                            const isMigrating = adMigrationMap.has(hostname);
                            const dcFF = adMigrationMap.get(hostname) || 'nios-x';
                            return (
                              <div
                                key={hostname}
                                className={`flex items-center gap-2.5 px-3 py-2 rounded-lg transition-colors ${
                                  isMigrating
                                    ? dcFF === 'nios-xaas'
                                      ? 'bg-purple-50 border border-purple-200'
                                      : 'bg-blue-50 border border-blue-200'
                                    : 'border border-[var(--border)] hover:bg-gray-50'
                                }`}
                              >
                                <button
                                  onClick={() => toggleAdMigration(hostname)}
                                  className="flex items-center gap-0 shrink-0"
                                >
                                  <div className={`w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
                                    isMigrating
                                      ? dcFF === 'nios-xaas'
                                        ? 'bg-purple-600 border-purple-600'
                                        : 'bg-[var(--infoblox-blue)] border-[var(--infoblox-blue)]'
                                      : 'border-gray-300'
                                  }`}>
                                    {isMigrating && <Check className="w-3 h-3 text-white" />}
                                  </div>
                                </button>
                                <div className="flex-1 min-w-0">
                                  <div className="text-[12px] truncate" style={{ fontWeight: 500 }}>{hostname}</div>
                                  <div className="text-[10px] text-[var(--muted-foreground)] flex items-center gap-2">
                                    <span>{m.qps.toLocaleString()} QPS</span>
                                    <span>{m.lps.toLocaleString()} LPS</span>
                                    <span className={`inline-block px-1.5 py-0 rounded-full text-[9px] ${tierColors[m.tier] || 'bg-gray-100 text-gray-700'}`} style={{ fontWeight: 600 }}>{m.tier}</span>
                                    <span>{m.serverTokens.toLocaleString()} tokens</span>
                                  </div>
                                </div>
                                {isMigrating && (
                                  <div className="flex items-center bg-white rounded-md border border-gray-200 p-0.5 shrink-0">
                                    <button
                                      onClick={() => setAdFormFactor(hostname, 'nios-x')}
                                      className={`px-2 py-0.5 rounded text-[9px] transition-all ${
                                        dcFF === 'nios-x'
                                          ? 'bg-[var(--infoblox-navy)] text-white shadow-sm'
                                          : 'text-gray-400 hover:text-gray-600'
                                      }`}
                                      style={{ fontWeight: 600 }}
                                    >
                                      NIOS-X
                                    </button>
                                    <button
                                      onClick={() => setAdFormFactor(hostname, 'nios-xaas')}
                                      className={`px-2 py-0.5 rounded text-[9px] transition-all ${
                                        dcFF === 'nios-xaas'
                                          ? 'bg-purple-600 text-white shadow-sm'
                                          : 'text-gray-400 hover:text-gray-600'
                                      }`}
                                      style={{ fontWeight: 600 }}
                                    >
                                      XaaS
                                    </button>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>

                    {/* Scenario comparison cards */}
                    {(() => {
                      const adIsActive = (idx: number) =>
                        idx === 0 ? adMigrationMap.size === 0
                        : idx === 1 ? adMigrationMap.size > 0 && adMigrationMap.size < adHostnames.length
                        : adMigrationMap.size === adHostnames.length;

                      // Server Token scenarios — already computed above
                      const adSrvScenarios: ScenarioCard[] = [
                        { label: 'Current',        primaryValue: 0,                  desc: 'All DCs remain on Windows DNS/DHCP licensing. No NIOS-X server tokens required.' },
                        { label: 'Hybrid',         primaryValue: hybridServerTokens, desc: scenarioHybrid.desc },
                        { label: 'Full Migration', primaryValue: fullMigrationTokens, desc: `All ${adHostnames.length} DCs migrated to NIOS-X for unified DDI management.` },
                      ];

                      // Management token note — AD management tokens are constant across all migration scenarios
                      const adMgmtTotal = effectiveFindings.filter(f => (f.provider as string) === 'ad').reduce((s, f) => s + f.managementTokens, 0);
                      const nonAdTokens = effectiveFindings.filter(f => (f.provider as string) !== 'ad').reduce((s, f) => s + f.managementTokens, 0);

                      return (
                        <>
                          {/* Management token note — same value across all scenarios, no row needed */}
                          <div className="px-4 py-3 border-b border-[var(--border)] bg-orange-50/40 flex items-center gap-3">
                            <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-orange-700" style={{ fontWeight: 700 }}>
                              <span className="w-2 h-2 rounded-full bg-orange-500 shrink-0" />
                              Management Tokens
                            </div>
                            <div className="text-[22px] text-orange-600" style={{ fontWeight: 700 }}>{(nonAdTokens + adMgmtTotal).toLocaleString()}</div>
                            <div className="text-[11px] text-[var(--muted-foreground)] leading-tight">
                              Management tokens count the same across all migration scenarios —
                              DDI objects (users, computers, IPs) exist regardless of whether DCs run on Windows or NIOS-X.
                            </div>
                          </div>
                          <ScenarioPlannerCards
                            title="Server Tokens"
                            unit="Server Tokens (IB-TOKENS-UDDI-SERV-500)"
                            color="blue"
                            scenarios={adSrvScenarios}
                            isActive={adIsActive}
                          />
                        </>
                      );
                    })()}

                    {/* Knowledge Worker / Computer / Static IP summary */}
                    <div className="px-4 pb-4">
                      <div className="grid grid-cols-3 gap-4">
                        {(() => {
                          const kwCount = effectiveFindings.filter(f => f.item === 'user_account' && (f.provider as string) === 'ad').reduce((s, f) => s + f.count, 0);
                          const compCount = effectiveFindings.filter(f => f.item === 'computer_count' && (f.provider as string) === 'ad').reduce((s, f) => s + f.count, 0);
                          const staticCount = effectiveFindings.filter(f => f.item === 'static_ip_count' && (f.provider as string) === 'ad').reduce((s, f) => s + f.count, 0);
                          return [
                            { label: 'Knowledge Workers', value: kwCount, icon: '👥', desc: 'AD User Accounts' },
                            { label: 'Computer Inventory', value: compCount, icon: '💻', desc: 'Managed Assets' },
                            { label: 'Static IPs', value: staticCount, icon: '🌐', desc: 'Active IPs' },
                          ].map((metric, i) => (
                            <div key={i} className="bg-gray-50 rounded-lg p-3 text-center">
                              <div className="text-[20px]">{metric.icon}</div>
                              <div className="text-[20px] mt-1" style={{ fontWeight: 700 }}>{metric.value.toLocaleString()}</div>
                              <div className="text-[12px]" style={{ fontWeight: 600 }}>{metric.label}</div>
                              <div className="text-[11px] text-[var(--muted-foreground)]">{metric.desc}</div>
                            </div>
                          ));
                        })()}
                      </div>
                    </div>

                    {/* AD Server Token Calculator — inline within AD Migration Planner */}
                    {effectiveADMetrics.length > 0 && (() => {
                      const toNiosMetrics = (m: ADServerMetricAPI): NiosServerMetrics => ({
                        memberId: m.hostname,
                        memberName: m.hostname,
                        role: 'DC',
                        qps: m.qps,
                        lps: m.lps,
                        objectCount: m.dnsObjects + m.dhcpObjectsWithOverhead,
                        activeIPCount: 0,
                      });

                      const displayMembers = adMigrationMap.size > 0
                        ? effectiveADMetrics.filter(m => adMigrationMap.has(m.hostname))
                        : effectiveADMetrics;

                      const getDcFF = (hostname: string): ServerFormFactor =>
                        adMigrationMap.get(hostname) || 'nios-x';

                      const hasAnyXaas = displayMembers.some(m => getDcFF(m.hostname) === 'nios-xaas');
                      const xaasDcs = displayMembers.filter(m => getDcFF(m.hostname) === 'nios-xaas');
                      const niosXDcs = displayMembers.filter(m => getDcFF(m.hostname) === 'nios-x');
                      const niosXDcCount = niosXDcs.length;
                      const xaasDcCount = xaasDcs.length;

                      const xaasInstances = consolidateXaasInstances(xaasDcs.map(toNiosMetrics));
                      const totalXaasTokens = xaasInstances.reduce((s, inst) => s + inst.totalTokens, 0);

                      const niosXTokens = niosXDcs.reduce((sum, m) => {
                        return sum + calcServerTokenTier(m.qps, m.lps, m.dnsObjects + m.dhcpObjectsWithOverhead, 'nios-x').serverTokens;
                      }, 0);

                      const totalServerTokens = niosXTokens + totalXaasTokens;
                      const totalDcsReplaced = xaasDcs.length;

                      const tierColorClass = (name: string) =>
                        name === 'XL' ? 'bg-red-100 text-red-700' :
                        name === 'L' ? 'bg-orange-100 text-orange-700' :
                        name === 'M' ? 'bg-yellow-100 text-yellow-700' :
                        name === 'S' ? 'bg-green-100 text-green-700' :
                        name === 'XS' ? 'bg-sky-100 text-sky-700' :
                        'bg-gray-100 text-gray-700';

                      return (
                        <div id="section-ad-server-tokens" className="border-t border-blue-200 bg-blue-50/10">
                          <div className="px-4 py-3 border-b border-blue-200 bg-blue-50/50 flex items-center gap-2 flex-wrap">
                      <ProviderIconEl id="microsoft" className="w-5 h-5" />
                      <h3 className="text-[14px]" style={{ fontWeight: 600 }}>
                        AD Server Token Calculator
                      </h3>
                      <span className="ml-auto text-[11px] text-[var(--muted-foreground)]">
                        {adMigrationMap.size > 0
                          ? `${displayMembers.length} DC${displayMembers.length > 1 ? 's' : ''} selected${niosXDcCount > 0 && xaasDcCount > 0 ? ` (${niosXDcCount} NIOS-X, ${xaasDcCount} XaaS)` : niosXDcCount > 0 ? ' → NIOS-X' : ' → XaaS'}`
                          : `${effectiveADMetrics.length} DC${effectiveADMetrics.length > 1 ? 's' : ''} detected`}
                      </span>
                    </div>

                    {/* Summary hero */}
                    <div className="px-4 py-4 border-b border-[var(--border)] bg-gradient-to-r from-blue-50/80 to-white">
                      <div className={`grid ${hasAnyXaas ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-1 sm:grid-cols-2'} gap-4`}>
                        <div>
                          <div className="flex items-center gap-1 text-[11px] uppercase tracking-wider text-[var(--muted-foreground)] mb-1" style={{ fontWeight: 600 }}>
                            Allocated Server Tokens
                            <FieldTooltip text="Server tokens (IB-TOKENS-UDDI-SERV-500) are needed for each NIOS-X appliance or XaaS instance based on its performance tier. This is separate from management tokens." side="top" />
                          </div>
                          <div className="text-[28px] text-blue-700" style={{ fontWeight: 700 }}>
                            {totalServerTokens.toLocaleString()}
                          </div>
                          <div className="text-[10px] text-[var(--muted-foreground)]">
                            {niosXDcCount > 0 && `${niosXTokens.toLocaleString()} NIOS-X`}
                            {niosXDcCount > 0 && xaasDcCount > 0 && ' + '}
                            {xaasDcCount > 0 && `${totalXaasTokens.toLocaleString()} XaaS`}
                          </div>
                        </div>
                        <div>
                          <div className="text-[11px] uppercase tracking-wider text-[var(--muted-foreground)] mb-1" style={{ fontWeight: 600 }}>
                            Domain Controllers
                          </div>
                          <div className="text-[22px] text-[var(--foreground)]" style={{ fontWeight: 600 }}>
                            {displayMembers.length}
                          </div>
                          <div className="text-[10px] text-[var(--muted-foreground)]">
                            {niosXDcCount > 0 && `${niosXDcCount} → NIOS-X`}
                            {niosXDcCount > 0 && xaasDcs.length > 0 && ' · '}
                            {xaasDcs.length > 0 && `${xaasDcs.length} → XaaS`}
                          </div>
                        </div>
                        {hasAnyXaas && ([
                          <div key="xaas-inst-summary">
                            <div className="text-[11px] uppercase tracking-wider text-[var(--muted-foreground)] mb-1" style={{ fontWeight: 600 }}>
                              XaaS Instances
                            </div>
                            <div className="text-[22px] text-purple-700" style={{ fontWeight: 600 }}>
                              {xaasInstances.length}
                            </div>
                            <div className="text-[10px] text-[var(--muted-foreground)]">
                              replacing {totalDcsReplaced} DC{totalDcsReplaced > 1 ? 's' : ''}
                            </div>
                          </div>,
                          <div key="xaas-consol-ratio">
                            <div className="text-[11px] uppercase tracking-wider text-[var(--muted-foreground)] mb-1" style={{ fontWeight: 600 }}>
                              Consolidation Ratio
                            </div>
                            <div className="text-[22px] text-purple-700" style={{ fontWeight: 600 }}>
                              {totalDcsReplaced}:{xaasInstances.length}
                            </div>
                            <div className="text-[10px] text-[var(--muted-foreground)]">
                              {totalDcsReplaced} DC{totalDcsReplaced > 1 ? 's' : ''} → {xaasInstances.length} XaaS instance{xaasInstances.length > 1 ? 's' : ''}
                            </div>
                          </div>
                        ])}
                      </div>
                      {hasAnyXaas && (
                        <div className="mt-3 flex flex-col gap-1.5">
                          <div className="flex items-start gap-1.5 text-[10px] text-purple-700 bg-purple-50 rounded-lg px-3 py-1.5 border border-purple-200">
                            <Info className="w-3 h-3 mt-0.5 shrink-0" />
                            <span>
                              <b>{xaasDcs.length} DC{xaasDcs.length > 1 ? 's' : ''}</b> consolidated into <b>{xaasInstances.length} XaaS instance{xaasInstances.length > 1 ? 's' : ''}</b>.
                              {' '}Each XaaS instance uses aggregate QPS/LPS/Objects to determine the T-shirt size.
                              {' '}1 connection = 1 DC replaced.
                            </span>
                          </div>
                          {xaasInstances.some(inst => inst.extraConnections > 0) && (
                            <div className="flex items-start gap-1.5 text-[10px] text-amber-700 bg-amber-50 rounded-lg px-3 py-1.5 border border-amber-200">
                              <Info className="w-3 h-3 mt-0.5 shrink-0" />
                              <span>
                                Some instances need extra connections beyond the included tier limit (+{XAAS_EXTRA_CONNECTION_COST} tokens each, up to 400 extra per instance).
                              </span>
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Per-DC table */}
                    <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
                      <table className="w-full text-[12px]">
                        <thead className="sticky top-0 z-10">
                          <tr className="border-b border-[var(--border)] bg-gray-50">
                            <th className="text-left px-4 py-2.5" style={{ fontWeight: 600 }}>Hostname</th>
                            <th className="text-center px-3 py-2.5" style={{ fontWeight: 600 }}>Role</th>
                            <th className="text-center px-3 py-2.5" style={{ fontWeight: 600 }}>Target</th>
                            <th className="text-right px-3 py-2.5" style={{ fontWeight: 600 }}>
                              <span className="flex items-center justify-end gap-1">
                                <Activity className="w-3 h-3" /> QPS
                                <FieldTooltip text="Queries per second — DNS query rate observed on this DC. Used with LPS and object count to size the NIOS-X appliance tier." side="top" />
                              </span>
                            </th>
                            <th className="text-right px-3 py-2.5" style={{ fontWeight: 600 }}>
                              <span className="flex items-center justify-end gap-1">
                                <Gauge className="w-3 h-3" /> LPS
                                <FieldTooltip text="Leases per second — DHCP lease rate on this DC. High LPS drives appliance tier up independently of QPS." side="top" />
                              </span>
                            </th>
                            <th className="text-right px-3 py-2.5" style={{ fontWeight: 600 }}>Objects</th>
                            <th className="text-center px-3 py-2.5" style={{ fontWeight: 600 }}>
                              <span className="flex items-center justify-center gap-1">
                                Size
                                <FieldTooltip text="NIOS-X appliance T-shirt size (2XS → XL) determined by the highest of QPS, LPS, and object thresholds. Each tier has a fixed server token cost." side="top" />
                              </span>
                            </th>
                            <th className="text-center px-3 py-2.5" style={{ fontWeight: 600 }}>
                              <span className="text-blue-700">Allocated Tokens</span>
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {/* NIOS-X DCs — individual rows */}
                          {niosXDcs.map((dc) => {
                            const objCount = dc.dnsObjects + dc.dhcpObjectsWithOverhead;
                            const tier = calcServerTokenTier(dc.qps, dc.lps, objCount, 'nios-x');
                            return (
                              <tr key={dc.hostname} className="border-b border-[var(--border)] hover:bg-gray-50/50 transition-colors">
                                <td className="px-4 py-2.5">
                                  <div className="truncate max-w-[260px]" style={{ fontWeight: 500 }}>{dc.hostname}</div>
                                </td>
                                <td className="text-center px-3 py-2.5">
                                  <span className="inline-block px-2 py-0.5 rounded text-[10px] bg-blue-100 text-blue-700" style={{ fontWeight: 600 }}>
                                    DC
                                  </span>
                                </td>
                                <td className="text-center px-3 py-2.5">
                                  <span className="inline-block px-2 py-0.5 rounded text-[10px] bg-blue-100 text-blue-700" style={{ fontWeight: 600 }}>
                                    NIOS-X
                                  </span>
                                </td>
                                <td className="text-right px-3 py-2.5 tabular-nums">
                                  {dc.qps > 0 ? dc.qps.toLocaleString() : <span className="text-gray-300">&mdash;</span>}
                                </td>
                                <td className="text-right px-3 py-2.5 tabular-nums">
                                  {dc.lps > 0 ? dc.lps.toLocaleString() : <span className="text-gray-300">&mdash;</span>}
                                </td>
                                <td className="text-right px-3 py-2.5 tabular-nums">
                                  {objCount > 0 ? objCount.toLocaleString() : <span className="text-gray-300">&mdash;</span>}
                                </td>
                                <td className="text-center px-3 py-2.5">
                                  <span className={`inline-block px-2 py-0.5 rounded text-[10px] ${tierColorClass(tier.name)}`} style={{ fontWeight: 600 }}>
                                    {tier.name}
                                  </span>
                                </td>
                                <td className="text-center px-3 py-2.5">
                                  <span className="inline-flex items-center justify-center min-w-[36px] h-7 px-1.5 rounded-full bg-blue-100 text-blue-700 text-[12px]" style={{ fontWeight: 700 }}>
                                    {tier.serverTokens.toLocaleString()}
                                  </span>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                          {/* XaaS consolidated instances */}
                          {xaasInstances.map((inst) => (
                            <tbody key={`ad-xaas-inst-${inst.index}`}>
                              {/* Instance header row */}
                              <tr className="bg-purple-50 border-b border-purple-200">
                                <td className="px-4 py-2 text-[11px] text-purple-800" style={{ fontWeight: 700 }} colSpan={8}>
                                  <div className="flex items-center gap-2">
                                    <span className="inline-flex items-center gap-1.5">
                                      <span className="inline-block w-2.5 h-2.5 rounded-full bg-purple-500" />
                                      XaaS Instance {xaasInstances.length > 1 ? inst.index + 1 : ''}
                                    </span>
                                    <span className="text-purple-500" style={{ fontWeight: 400 }}>—</span>
                                    <span className="text-purple-600" style={{ fontWeight: 500 }}>
                                      replaces {inst.connectionsUsed} DC{inst.connectionsUsed > 1 ? 's' : ''}
                                    </span>
                                    <span className="ml-auto flex items-center gap-2">
                                      <span className={`inline-block px-2 py-0.5 rounded text-[10px] ${tierColorClass(inst.tier.name)}`} style={{ fontWeight: 600 }}>
                                        {inst.tier.name}
                                      </span>
                                      <span className="inline-flex items-center justify-center min-w-[36px] h-6 px-1.5 rounded-full bg-purple-200 text-purple-800 text-[11px]" style={{ fontWeight: 700 }}>
                                        {inst.totalTokens.toLocaleString()}
                                      </span>
                                    </span>
                                  </div>
                                </td>
                              </tr>
                              {/* Individual DC rows within this instance */}
                              {inst.members.map((member) => (
                                <tr key={member.memberId} className="border-b border-purple-100 hover:bg-purple-50/30 transition-colors">
                                  <td className="pl-8 pr-4 py-2">
                                    <div className="truncate max-w-[240px] text-[11px] text-purple-700" style={{ fontWeight: 500 }}>{member.memberName}</div>
                                  </td>
                                  <td className="text-center px-3 py-2">
                                    <span className="inline-block px-2 py-0.5 rounded text-[10px] bg-blue-100 text-blue-700" style={{ fontWeight: 600 }}>
                                      DC
                                    </span>
                                  </td>
                                  <td className="text-center px-3 py-2">
                                    <span className="inline-block px-2 py-0.5 rounded text-[9px] bg-purple-100 text-purple-600" style={{ fontWeight: 500 }}>
                                      1 conn
                                    </span>
                                  </td>
                                  <td className="text-right px-3 py-2 tabular-nums text-[11px] text-purple-600">
                                    {member.qps > 0 ? member.qps.toLocaleString() : <span className="text-gray-300">&mdash;</span>}
                                  </td>
                                  <td className="text-right px-3 py-2 tabular-nums text-[11px] text-purple-600">
                                    {member.lps > 0 ? member.lps.toLocaleString() : <span className="text-gray-300">&mdash;</span>}
                                  </td>
                                  <td className="text-right px-3 py-2 tabular-nums text-[11px] text-purple-600">
                                    {serverSizingObjects(member) > 0 ? serverSizingObjects(member).toLocaleString() : <span className="text-gray-300">&mdash;</span>}
                                  </td>
                                  <td className="text-center px-3 py-2" colSpan={2}>
                                    <span className="text-[10px] text-gray-400">(consolidated)</span>
                                  </td>
                                </tr>
                              ))}
                              {/* Consolidated aggregate row */}
                              <tr className="border-b border-purple-300 bg-purple-50/80">
                                <td className="pl-8 pr-4 py-2 text-[11px] text-purple-800" style={{ fontWeight: 600 }}>
                                  Aggregate ({inst.connectionsUsed} connection{inst.connectionsUsed > 1 ? 's' : ''} used / {inst.tier.maxConnections} included)
                                  {inst.extraConnections > 0 && (
                                    <span className="text-amber-600 ml-1">+{inst.extraConnections} extra</span>
                                  )}
                                </td>
                                <td className="text-center px-3 py-2">
                                  <span className="inline-block px-2 py-0.5 rounded text-[10px] bg-purple-100 text-purple-700" style={{ fontWeight: 600 }}>
                                    XaaS
                                  </span>
                                </td>
                                <td className="text-center px-3 py-2 text-[10px] text-purple-700" style={{ fontWeight: 600 }}>
                                  {inst.connectionsUsed} conn
                                </td>
                                <td className="text-right px-3 py-2 tabular-nums text-purple-800" style={{ fontWeight: 600 }}>
                                  {inst.totalQps > 0 ? inst.totalQps.toLocaleString() : <span className="text-gray-300">&mdash;</span>}
                                </td>
                                <td className="text-right px-3 py-2 tabular-nums text-purple-800" style={{ fontWeight: 600 }}>
                                  {inst.totalLps > 0 ? inst.totalLps.toLocaleString() : <span className="text-gray-300">&mdash;</span>}
                                </td>
                                <td className="text-right px-3 py-2 tabular-nums text-purple-800" style={{ fontWeight: 600 }}>
                                  {inst.totalObjects > 0 ? inst.totalObjects.toLocaleString() : <span className="text-gray-300">&mdash;</span>}
                                </td>
                                <td className="text-center px-3 py-2">
                                  <span className={`inline-block px-2 py-0.5 rounded text-[10px] ${tierColorClass(inst.tier.name)}`} style={{ fontWeight: 600 }}>
                                    {inst.tier.name}
                                  </span>
                                </td>
                                <td className="text-center px-3 py-2">
                                  <span className="inline-flex items-center justify-center min-w-[36px] h-7 px-1.5 rounded-full bg-purple-200 text-purple-800 text-[12px]" style={{ fontWeight: 700 }}>
                                    {inst.totalTokens.toLocaleString()}
                                  </span>
                                  {inst.extraConnectionTokens > 0 && (
                                    <div className="text-[9px] text-amber-600 mt-0.5">
                                      incl. {inst.extraConnectionTokens.toLocaleString()} extra conn
                                    </div>
                                  )}
                                </td>
                              </tr>
                            </tbody>
                          ))}
                        <tfoot className="sticky bottom-0 z-10">
                          <tr className="bg-blue-50">
                            <td className="px-4 py-2.5 text-[12px]" style={{ fontWeight: 700 }} colSpan={7}>
                              Total Allocated Server Tokens
                              {hasAnyXaas && (
                                <span className="text-[10px] text-[var(--muted-foreground)] ml-2" style={{ fontWeight: 400 }}>
                                  ({niosXDcCount > 0 ? `${niosXDcCount} NIOS-X` : ''}{niosXDcCount > 0 && xaasInstances.length > 0 ? ' + ' : ''}{xaasInstances.length > 0 ? `${xaasInstances.length} XaaS instance${xaasInstances.length > 1 ? 's' : ''} replacing ${totalDcsReplaced} DCs` : ''})
                                </span>
                              )}
                            </td>
                            <td className="text-center px-3 py-2.5">
                              <span className="inline-flex items-center justify-center min-w-[40px] h-8 px-2 rounded-full bg-blue-600 text-white text-[14px]" style={{ fontWeight: 700 }}>
                                {totalServerTokens.toLocaleString()}
                              </span>
                            </td>
                          </tr>
                        </tfoot>
                      </table>
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                );
              })()}

              {/* Findings table */}
              <div id="section-findings" className="bg-white rounded-xl border border-[var(--border)] mb-6 overflow-hidden">
                <div className="px-4 py-3 border-b border-[var(--border)] bg-gray-50/50 flex items-center justify-between">
                  <h3 className="text-[14px]" style={{ fontWeight: 600 }}>
                    Detailed Findings
                  </h3>
                  <div className="flex items-center gap-3">
                    {Object.keys(countOverrides).length > 0 && (
                      <button
                        onClick={() => setCountOverrides({})}
                        className="text-[12px] text-amber-600 hover:underline flex items-center gap-1"
                        style={{ fontWeight: 500 }}
                      >
                        <Undo2 className="w-3 h-3" />
                        Reset {Object.keys(countOverrides).length} manual adjustment{Object.keys(countOverrides).length !== 1 ? 's' : ''}
                      </button>
                    )}
                    {(findingsProviderFilter.size > 0 || findingsCategoryFilter.size > 0) && (
                      <button
                        onClick={() => { setFindingsProviderFilter(new Set()); setFindingsCategoryFilter(new Set()); }}
                        className="text-[12px] text-[var(--infoblox-orange)] hover:underline"
                        style={{ fontWeight: 500 }}
                      >
                        Clear all filters
                      </button>
                    )}
                  </div>
                </div>
                {/* Editable counts tip — shown until first override is made */}
                {Object.keys(countOverrides).length === 0 && findings.length > 0 && (
                  <div className="px-4 py-2 bg-blue-50/60 border-b border-blue-100 flex items-center gap-2 text-[12px] text-blue-700">
                    <Pencil className="w-3.5 h-3.5 shrink-0 opacity-70" />
                    <span>Click any value in the <span style={{ fontWeight: 600 }}>Count</span> column to adjust it. Token totals recalculate instantly.</span>
                  </div>
                )}

                {/* Quick filters */}
                <div className="px-4 py-3 border-b border-[var(--border)] flex flex-col gap-2.5">
                  {/* Provider filter */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[11px] text-[var(--muted-foreground)] uppercase tracking-wider shrink-0 w-16" style={{ fontWeight: 600 }}>
                      Provider
                    </span>
                    {selectedProviders.map((provId) => {
                      const provider = PROVIDERS.find((p) => p.id === provId)!;
                      const isActive = findingsProviderFilter.size === 0 || findingsProviderFilter.has(provId);
                      const isExplicit = findingsProviderFilter.has(provId);
                      return (
                        <button
                          key={provId}
                          onClick={() => toggleProviderFilter(provId)}
                          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12px] border transition-colors ${
                            isExplicit
                              ? 'border-[var(--infoblox-navy)] bg-[var(--infoblox-navy)] text-white'
                              : findingsProviderFilter.size === 0
                                ? 'border-[var(--border)] bg-white text-[var(--foreground)] hover:border-gray-400'
                                : 'border-[var(--border)] bg-white text-[var(--muted-foreground)] hover:border-gray-400 opacity-50'
                          }`}
                          style={{ fontWeight: isExplicit ? 600 : 400 }}
                        >
                          <span
                            className="w-2 h-2 rounded-full shrink-0"
                            style={{ backgroundColor: provider.color }}
                          />
                          {provider.name}
                          {isExplicit && (
                            <span className="text-[10px] ml-0.5 opacity-80">
                              ({findings.filter(f => f.provider === provId).length})
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                  {/* Category filter */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[11px] text-[var(--muted-foreground)] uppercase tracking-wider shrink-0 w-16" style={{ fontWeight: 600 }}>
                      Category
                    </span>
                    {([
                      { key: 'DDI Object' as TokenCategory, label: 'DDI Objects', color: 'blue' },
                      { key: 'Active IP' as TokenCategory, label: 'Active IPs', color: 'purple' },
                      { key: 'Asset' as TokenCategory, label: 'Assets', color: 'green' },
                    ]).map((cat) => {
                      const isExplicit = findingsCategoryFilter.has(cat.key);
                      const colorClasses = {
                        active: {
                          blue: 'border-blue-600 bg-blue-600 text-white',
                          purple: 'border-purple-600 bg-purple-600 text-white',
                          green: 'border-green-600 bg-green-600 text-white',
                        },
                        inactive: 'border-[var(--border)] bg-white hover:border-gray-400',
                      };
                      return (
                        <button
                          key={cat.key}
                          onClick={() => toggleCategoryFilter(cat.key)}
                          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12px] border transition-colors ${
                            isExplicit
                              ? colorClasses.active[cat.color as keyof typeof colorClasses.active]
                              : `${colorClasses.inactive} ${findingsCategoryFilter.size > 0 ? 'text-[var(--muted-foreground)] opacity-50' : 'text-[var(--foreground)]'}`
                          }`}
                          style={{ fontWeight: isExplicit ? 600 : 400 }}
                        >
                          {cat.label}
                          {isExplicit && (
                            <span className="text-[10px] ml-0.5 opacity-80">
                              ({findings.filter(f => f.category === cat.key).length})
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Filter summary */}
                {(findingsProviderFilter.size > 0 || findingsCategoryFilter.size > 0) && (
                  <div className="px-4 py-2 bg-blue-50/50 border-b border-[var(--border)] text-[12px] text-[var(--muted-foreground)]">
                    Showing {filteredSortedFindings.length} of {findings.length} rows · {filteredTokenTotal.toLocaleString()} of {totalTokens.toLocaleString()} tokens
                  </div>
                )}

                <div className="overflow-x-auto">
                  <table className="w-full text-[13px]">
                    <thead>
                      <tr className="border-b border-[var(--border)] text-left text-[var(--muted-foreground)]">
                        {([
                          { col: 'provider' as SortColumn, label: 'Provider', align: 'left' },
                          { col: 'source' as SortColumn, label: 'Source', align: 'left' },
                          { col: 'category' as SortColumn, label: 'Token Category', align: 'left' },
                          { col: 'item' as SortColumn, label: 'Item', align: 'left' },
                          { col: 'count' as SortColumn, label: 'Count', align: 'right', editHint: true },
                          { col: 'managementTokens' as SortColumn, label: 'Mgmt Tokens', align: 'right' },
                        ]).map((header) => {
                          const isSorted = findingsSort?.col === header.col;
                          const SortIcon = isSorted
                            ? (findingsSort!.dir === 'asc' ? ArrowUp : ArrowDown)
                            : ArrowUpDown;
                          return (
                            <th
                              key={header.col}
                              className={`px-4 py-2.5 ${header.align === 'right' ? 'text-right' : ''}`}
                              style={{ fontWeight: 500 }}
                            >
                              <button
                                onClick={() => toggleFindingsSort(header.col)}
                                className={`inline-flex items-center gap-1 hover:text-[var(--foreground)] transition-colors group ${
                                  isSorted ? 'text-[var(--foreground)]' : ''
                                }`}
                              >
                                {header.label}
                                {'editHint' in header && header.editHint && (
                                  <span className="inline-flex items-center gap-0.5 text-[10px] font-normal normal-case ml-0.5 text-[var(--infoblox-blue)] opacity-75">
                                    <Pencil className="w-2.5 h-2.5" />editable
                                  </span>
                                )}
                                <SortIcon className={`w-3 h-3 shrink-0 transition-opacity ${
                                  isSorted ? 'opacity-100' : 'opacity-0 group-hover:opacity-50'
                                }`} />
                              </button>
                            </th>
                          );
                        })}
                      </tr>
                    </thead>
                    <tbody>
                      {filteredSortedFindings.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="px-4 py-8 text-center text-[var(--muted-foreground)]">
                            No findings match the current filters.
                          </td>
                        </tr>
                      ) : (
                        filteredSortedFindings.map((f, i) => (
                          <tr
                            key={`${f.provider}-${f.item}-${i}`}
                            className="border-b border-[var(--border)] last:border-0 hover:bg-gray-50/50"
                          >
                            <td className="px-4 py-2.5">
                              <span
                                className="inline-block w-2 h-2 rounded-full mr-2"
                                style={{
                                  backgroundColor: PROVIDERS.find((p) => p.id === f.provider)
                                    ?.color,
                                }}
                              />
                              {PROVIDERS.find((p) => p.id === f.provider)?.name}
                            </td>
                            <td className="px-4 py-2.5 text-[var(--muted-foreground)] max-w-[200px] truncate" title={f.source}>{f.source}</td>
                            <td className="px-4 py-2.5">
                              <span
                                className={`px-2 py-0.5 rounded-full text-[11px] ${
                                  f.category === 'DDI Object'
                                    ? 'bg-blue-100 text-blue-700'
                                    : f.category === 'Active IP'
                                      ? 'bg-purple-100 text-purple-700'
                                      : 'bg-green-100 text-green-700'
                                }`}
                                style={{ fontWeight: 500 }}
                              >
                                {f.category}
                              </span>
                            </td>
                            <td className="px-4 py-2.5">{formatItemLabel(f.item)}</td>
                            <td className="px-4 py-2.5 text-right tabular-nums whitespace-nowrap min-w-[80px]">
                              {(() => {
                                const key = findingKey(f);
                                const isEditing = editingFindingKey === key;
                                const hasOverride = key in countOverrides;
                                const originalCount = findings.find(
                                  (orig) => findingKey(orig) === key
                                )?.count ?? f.count;

                                if (isEditing) {
                                  return (
                                    <input
                                      type="number"
                                      min="0"
                                      autoFocus
                                      value={editingCountValue}
                                      onChange={(e) => setEditingCountValue(e.target.value)}
                                      onBlur={() => {
                                        const parsed = parseInt(editingCountValue, 10);
                                        if (!isNaN(parsed) && parsed >= 0 && parsed !== originalCount) {
                                          setCountOverrides((prev) => ({ ...prev, [key]: parsed }));
                                        } else if (parsed === originalCount) {
                                          // Reset to original — remove override
                                          setCountOverrides((prev) => {
                                            const next = { ...prev };
                                            delete next[key];
                                            return next;
                                          });
                                        }
                                        setEditingFindingKey(null);
                                      }}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                                        if (e.key === 'Escape') { setEditingFindingKey(null); }
                                      }}
                                      className="w-[90px] px-2 py-0.5 text-right text-[13px] bg-[var(--input-background)] border border-[var(--infoblox-blue)] rounded focus:outline-none focus:ring-2 focus:ring-[var(--infoblox-blue)]/30 tabular-nums"
                                    />
                                  );
                                }

                                return (
                                  <span className="inline-flex items-center gap-1 group">
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setEditingFindingKey(key);
                                        setEditingCountValue(String(f.count));
                                      }}
                                      className="hover:text-[var(--infoblox-blue)] transition-colors inline-flex items-center gap-1 border-b border-dashed border-[var(--muted-foreground)]/30 hover:border-[var(--infoblox-blue)] pb-px"
                                      title="Click to adjust count"
                                    >
                                      {f.count.toLocaleString()}
                                      <Pencil className="w-3 h-3 opacity-20 group-hover:opacity-70 transition-opacity" />
                                    </button>
                                    {hasOverride && (
                                      <span className="inline-flex items-center gap-0.5">
                                        <span className="text-[10px] text-[var(--muted-foreground)] line-through" title={`Original: ${originalCount.toLocaleString()}`}>
                                          {originalCount.toLocaleString()}
                                        </span>
                                        <button
                                          type="button"
                                          onClick={() => setCountOverrides((prev) => {
                                            const next = { ...prev };
                                            delete next[key];
                                            return next;
                                          })}
                                          className="text-[var(--muted-foreground)] hover:text-[var(--infoblox-orange)] transition-colors"
                                          title="Reset to original value"
                                        >
                                          <Undo2 className="w-3 h-3" />
                                        </button>
                                      </span>
                                    )}
                                  </span>
                                );
                              })()}
                            </td>
                            <td className="px-4 py-2.5 text-right tabular-nums whitespace-nowrap min-w-[100px]" style={{ fontWeight: 600 }}>
                              {f.managementTokens.toLocaleString()}
                            </td>
                          </tr>
                        ))
                      )}
                      <tr className="bg-gray-50">
                        <td
                          colSpan={5}
                          className="px-4 py-3 text-right"
                          style={{ fontWeight: 600 }}
                        >
                          {(findingsProviderFilter.size > 0 || findingsCategoryFilter.size > 0)
                            ? 'Filtered Total'
                            : 'Total Management Tokens'
                          }
                        </td>
                        <td
                          className="px-4 py-3 text-right text-[var(--infoblox-orange)]"
                          style={{ fontWeight: 700 }}
                        >
                          {(findingsProviderFilter.size > 0 || findingsCategoryFilter.size > 0)
                            ? filteredTokenTotal.toLocaleString()
                            : totalTokens.toLocaleString()
                          }
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Export buttons */}
              <div id="section-export" className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
                <button
                  onClick={exportCSV}
                  className="flex items-center justify-center gap-2 px-5 py-3 bg-[var(--infoblox-navy)] text-white rounded-xl hover:bg-[var(--infoblox-navy)]/90 transition-colors"
                  style={{ fontWeight: 500 }}
                >
                  <Download className="w-4 h-4" />
                  Download CSV
                </button>
                <button
                  onClick={exportExcel}
                  className="flex items-center justify-center gap-2 px-5 py-3 bg-[var(--infoblox-green)] text-white rounded-xl hover:bg-[var(--infoblox-green)]/90 transition-colors"
                  style={{ fontWeight: 500 }}
                >
                  <FileSpreadsheet className="w-4 h-4" />
                  Download XLSX
                </button>
                <button
                  onClick={saveSession}
                  className="flex items-center justify-center gap-2 px-5 py-3 bg-[var(--infoblox-navy)] text-white rounded-xl hover:bg-[var(--infoblox-navy)]/90 transition-colors opacity-80"
                  style={{ fontWeight: 500 }}
                >
                  <Download className="w-4 h-4" />
                  Save Session
                </button>
                <button
                  onClick={restart}
                  className="flex items-center justify-center gap-2 px-5 py-3 bg-white border border-[var(--border)] text-[var(--foreground)] rounded-xl hover:bg-gray-50 transition-colors"
                  style={{ fontWeight: 500 }}
                >
                  <RotateCcw className="w-4 h-4" />
                  Start Over
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Bottom navigation */}
      {currentStep !== 'results' && (
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
            className="flex items-center gap-1.5 text-[11px] text-white/40 hover:text-white/70 transition-colors"
          >
            <Github className="w-3.5 h-3.5" />
            <span>github.com/stefanriegel</span>
          </a>
        </div>
      </footer>
    </div>
  );
}