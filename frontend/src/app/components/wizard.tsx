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
} from 'lucide-react';
import { useBackendConnection } from './use-backend';
import {
  validateCredentials as apiValidate,
  uploadNiosBackup as apiUploadNios,
  validateBluecat as apiValidateBluecat,
  validateEfficientip as apiValidateEfficientip,
  validateNiosWapi as apiValidateNiosWapi,
  startScan as apiStartScan,
  getScanStatus as apiGetScanStatus,
  getScanResults as apiGetScanResults,
  getSessionId,
  cloneSession,
  type ScanStatusResponse,
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

type Step = 'providers' | 'credentials' | 'sources' | 'scanning' | 'results';
type SortColumn = 'provider' | 'source' | 'category' | 'item' | 'count' | 'managementTokens';
type SortDir = 'asc' | 'desc';

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
  });
  const [credentialStatus, setCredentialStatus] = useState<Record<ProviderType, 'idle' | 'validating' | 'valid' | 'error'>>({
    aws: 'idle',
    azure: 'idle',
    gcp: 'idle',
    microsoft: 'idle',
    nios: 'idle',
    bluecat: 'idle',
    efficientip: 'idle',
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
  });
  const [scanProgress, setScanProgress] = useState(0);
  const [providerScanProgress, setProviderScanProgress] = useState<Record<ProviderType, number>>({
    aws: 0, azure: 0, gcp: 0, microsoft: 0, nios: 0, bluecat: 0, efficientip: 0,
  });
  const [findings, setFindings] = useState<FindingRow[]>([]);
  const [credentialError, setCredentialError] = useState<Record<ProviderType, string>>({
    aws: '', azure: '', gcp: '', microsoft: '', nios: '', bluecat: '', efficientip: '',
  });
  const [scanError, setScanError] = useState<string>('');
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
  });
  const [sourceSearch, setSourceSearch] = useState<Record<ProviderType, string>>({
    aws: '', azure: '', gcp: '', microsoft: '', nios: '', bluecat: '', efficientip: '',
  });
  const [advancedOptions, setAdvancedOptions] = useState<Record<ProviderType, { maxWorkers: number }>>({
    aws: { maxWorkers: 0 }, azure: { maxWorkers: 0 }, gcp: { maxWorkers: 0 },
    microsoft: { maxWorkers: 0 }, nios: { maxWorkers: 0 }, bluecat: { maxWorkers: 0 }, efficientip: { maxWorkers: 0 },
  });
  // Top consumer expandable cards
  const [topDnsExpanded, setTopDnsExpanded] = useState(false);
  const [topDhcpExpanded, setTopDhcpExpanded] = useState(false);
  const [topIpExpanded, setTopIpExpanded] = useState(false);
  const [showAllHeroSources, setShowAllHeroSources] = useState(false);
  const [showAllCategorySources, setShowAllCategorySources] = useState<Record<string, boolean>>({});

  // Findings table filters & sorting
  const [findingsProviderFilter, setFindingsProviderFilter] = useState<Set<ProviderType>>(new Set());
  const [findingsCategoryFilter, setFindingsCategoryFilter] = useState<Set<TokenCategory>>(new Set());
  const [findingsSort, setFindingsSort] = useState<{ col: SortColumn; dir: SortDir } | null>(null);

  // Selection mode: 'include' = checked items will be scanned; 'exclude' = checked items will be SKIPPED
  const [selectionMode, setSelectionMode] = useState<Record<ProviderType, 'include' | 'exclude'>>({
    aws: 'include', azure: 'include', gcp: 'include', microsoft: 'include', nios: 'include', bluecat: 'include', efficientip: 'include',
  });

  // NIOS-specific state
  const [niosMode, setNiosMode] = useState<'backup' | 'wapi'>('backup');
  const [niosUploadedFile, setNiosUploadedFile] = useState<File | null>(null);
  const [niosDragOver, setNiosDragOver] = useState(false);
  // NIOS-X migration planner: which NIOS sources (grid members) to migrate, with per-member form factor
  const [niosMigrationMap, setNiosMigrationMap] = useState<Map<string, ServerFormFactor>>(new Map());
  const [memberSearchFilter, setMemberSearchFilter] = useState('');

  // Backend wiring: NIOS backup token returned from upload, and live server metrics from scan results
  const [backupToken, setBackupToken] = useState<string>('');
  const [niosServerMetrics, setNiosServerMetrics] = useState<NiosServerMetrics[]>([]);

  // Use live metrics when available from real scan, fall back to mock data in demo mode
  const effectiveNiosMetrics = niosServerMetrics.length > 0 ? niosServerMetrics : MOCK_NIOS_SERVER_METRICS;

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
      case 'credentials':
        return selectedProviders.every((p) => credentialStatus[p] === 'valid');
      case 'sources':
        return selectedProviders.some((p) =>
          getEffectiveSelectedCount(p) > 0
        );
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
    setCredentials({ aws: {}, azure: {}, gcp: {}, microsoft: {}, nios: {}, bluecat: {}, efficientip: {} });
    setCredentialStatus({ aws: 'idle', azure: 'idle', gcp: 'idle', microsoft: 'idle', nios: 'idle', bluecat: 'idle', efficientip: 'idle' });
    setSubscriptions({ aws: [], azure: [], gcp: [], microsoft: [], nios: [], bluecat: [], efficientip: [] });
    setScanProgress(0);
    setProviderScanProgress({ aws: 0, azure: 0, gcp: 0, microsoft: 0, nios: 0, bluecat: 0, efficientip: 0 });
    setFindings([]);
    setCredentialError({ aws: '', azure: '', gcp: '', microsoft: '', nios: '', bluecat: '', efficientip: '' });
    setScanError('');
    setSourceSearch({ aws: '', azure: '', gcp: '', microsoft: '', nios: '', bluecat: '', efficientip: '' });
    setSelectionMode({ aws: 'include', azure: 'include', gcp: 'include', microsoft: 'include', nios: 'include', bluecat: 'include', efficientip: 'include' });
    setNiosMode('backup');
    setNiosUploadedFile(null);
    setNiosDragOver(false);
    setNiosMigrationMap(new Map());
    setMemberSearchFilter('');
    setBackupToken('');
    setNiosServerMetrics([]);
    setFindingsProviderFilter(new Set());
    setFindingsCategoryFilter(new Set());
    setFindingsSort(null);
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
        const creds = credentials.efficientip || {};
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

          // Auto-select subscriptions for org-discovered accounts and Azure multi-subscription
          const autoSelect =
            (providerId === 'aws' && authMethod === 'org') ||
            (providerId === 'gcp' && authMethod === 'org') ||
            providerId === 'azure';

          setSubscriptions((prev) => ({
            ...prev,
            [providerId]: result.subscriptions.map((s) => ({ ...s, selected: autoSelect })),
          }));
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
    const initProgress: Record<ProviderType, number> = { aws: 0, azure: 0, gcp: 0, microsoft: 0, nios: 0, bluecat: 0, efficientip: 0 };
    setProviderScanProgress(initProgress);
    setFindings([]);

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
                })));
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

  // Export
  const totalTokens = useMemo(
    () => findings.reduce((sum, f) => sum + f.managementTokens, 0),
    [findings]
  );

  // Category subtotals for summary
  const categoryTotals = useMemo(() => {
    const totals = { 'DDI Object': 0, 'Active IP': 0, 'Asset': 0 };
    findings.forEach((f) => {
      totals[f.category] += f.managementTokens;
    });
    return totals;
  }, [findings]);

  // Filtered + sorted findings for the table
  const filteredSortedFindings = useMemo(() => {
    let rows = findings;
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
  }, [findings, findingsProviderFilter, findingsCategoryFilter, findingsSort]);

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
    const rows = findings.map(
      (f) =>
        `${PROVIDERS.find((p) => p.id === f.provider)?.name},${f.source},${f.category},${formatItemLabel(f.item)},${f.count},${f.tokensPerUnit},${f.managementTokens}`
    );
    let summary = `\n\nTotal Management Tokens,,,,,,${totalTokens}`;
    if (selectedProviders.includes('nios') && niosMigrationMap.size > 0) {
      const nf = findings.filter((f) => f.provider === 'nios');
      const nonNios = findings.filter((f) => f.provider !== 'nios').reduce((s, f) => s + f.managementTokens, 0);
      const allNios = calcNiosTokens(nf);
      const migrating = nf.filter((f) => niosMigrationMap.has(f.source)).reduce((s, f) => s + f.managementTokens, 0);
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
      const niosSources = new Set(findings.filter((f) => f.provider === 'nios').map((f) => f.source));
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
          const tier = calcServerTokenTier(m.qps, m.lps, m.objectCount, 'nios-x');
          summary += `\n${m.memberName},${m.role},NIOS-X,${m.qps},${m.lps},${m.objectCount},—,${tier.name},${tier.serverTokens}`;
        });
        // XaaS consolidated instances
        xaasInst.forEach((inst) => {
          summary += `\n--- XaaS Instance ${xaasInst.length > 1 ? inst.index + 1 : ''} (replaces ${inst.connectionsUsed} NIOS members) ---`;
          inst.members.forEach((m) => {
            summary += `\n  ${m.memberName},${m.role},XaaS (1 conn),${m.qps},${m.lps},${m.objectCount},,,(consolidated)`;
          });
          summary += `\n  AGGREGATE,,XaaS,${inst.totalQps},${inst.totalLps},${inst.totalObjects},${inst.connectionsUsed}/${inst.tier.maxConnections} conn,${inst.tier.name},${inst.totalTokens}`;
          if (inst.extraConnections > 0) {
            summary += ` (incl. ${inst.extraConnectionTokens} extra connection tokens)`;
          }
        });
        const niosXTokens = niosXMetrics.reduce((s, m) => s + calcServerTokenTier(m.qps, m.lps, m.objectCount, 'nios-x').serverTokens, 0);
        const xaasTokens = xaasInst.reduce((s, inst) => s + inst.totalTokens, 0);
        const totalST = niosXTokens + xaasTokens;
        summary += `\nTotal Allocated Server Tokens,,,,,,,,${totalST}`;
        if (hasAnyXaas) {
          summary += `\nConsolidation: ${xaasMetrics.length} NIOS members → ${xaasInst.length} XaaS instance${xaasInst.length > 1 ? 's' : ''} (${xaasMetrics.length}:${xaasInst.length} ratio)`;
        }
      }
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
    findings.forEach((f) => {
      html += `<tr><td>${PROVIDERS.find((p) => p.id === f.provider)?.name}</td><td>${f.source}</td><td>${f.category}</td><td>${formatItemLabel(f.item)}</td><td>${f.count}</td><td>${f.tokensPerUnit}</td><td>${f.managementTokens}</td></tr>`;
    });
    html += `<tr style="background:#f5f5f5;font-weight:bold"><td colspan="6">Total Management Tokens</td><td>${totalTokens.toLocaleString()}</td></tr>`;
    html += '</table>';
    if (selectedProviders.includes('nios') && niosMigrationMap.size > 0) {
      const nf = findings.filter((f) => f.provider === 'nios');
      const nonNios = findings.filter((f) => f.provider !== 'nios').reduce((s, f) => s + f.managementTokens, 0);
      const allNios = calcNiosTokens(nf);
      const migrating = nf.filter((f) => niosMigrationMap.has(f.source)).reduce((s, f) => s + f.managementTokens, 0);
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
      const niosSources = new Set(findings.filter((f) => f.provider === 'nios').map((f) => f.source));
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
          const tier = calcServerTokenTier(m.qps, m.lps, m.objectCount, 'nios-x');
          html += `<tr><td>${m.memberName}</td><td>${m.role}</td><td>NIOS-X</td><td>${m.qps.toLocaleString()}</td><td>${m.lps.toLocaleString()}</td><td>${m.objectCount.toLocaleString()}</td><td>${tier.name}</td><td style="text-align:center;font-weight:bold">${tier.serverTokens.toLocaleString()}</td></tr>`;
        });
        // XaaS consolidated instances
        xaasInst.forEach((inst) => {
          html += `<tr style="background:#f3e8ff"><td colspan="8" style="font-weight:bold;color:#6b21a8">XaaS Instance${xaasInst.length > 1 ? ' ' + (inst.index + 1) : ''} — replaces ${inst.connectionsUsed} NIOS member${inst.connectionsUsed > 1 ? 's' : ''}</td></tr>`;
          inst.members.forEach((m) => {
            html += `<tr style="background:#faf5ff"><td style="padding-left:20px">${m.memberName}</td><td>${m.role}</td><td style="color:#7c3aed">1 conn</td><td style="color:#7c3aed">${m.qps.toLocaleString()}</td><td style="color:#7c3aed">${m.lps.toLocaleString()}</td><td style="color:#7c3aed">${m.objectCount.toLocaleString()}</td><td colspan="2" style="text-align:center;color:#999">(consolidated)</td></tr>`;
          });
          html += `<tr style="background:#ede9fe"><td style="padding-left:20px;font-weight:600">Aggregate (${inst.connectionsUsed}/${inst.tier.maxConnections} connections${inst.extraConnections > 0 ? ', +' + inst.extraConnections + ' extra' : ''})</td><td style="font-weight:600">XaaS</td><td style="font-weight:600">${inst.connectionsUsed} conn</td><td style="font-weight:600">${inst.totalQps.toLocaleString()}</td><td style="font-weight:600">${inst.totalLps.toLocaleString()}</td><td style="font-weight:600">${inst.totalObjects.toLocaleString()}</td><td style="font-weight:600">${inst.tier.name}</td><td style="text-align:center;font-weight:bold;color:#6b21a8">${inst.totalTokens.toLocaleString()}${inst.extraConnectionTokens > 0 ? ' (incl. ' + inst.extraConnectionTokens.toLocaleString() + ' extra conn)' : ''}</td></tr>`;
        });
        const niosXTokens = niosXMetrics.reduce((s, m) => s + calcServerTokenTier(m.qps, m.lps, m.objectCount, 'nios-x').serverTokens, 0);
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
    html += '</body></html>';
    downloadFile(html, 'ddi-token-assessment.xls', 'application/vnd.ms-excel');
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
                  const currentAuth = provider.authMethods.find((m) => m.id === currentAuthId) || provider.authMethods[0];
                  const hasFields = currentAuth.fields.length > 0;

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
                          {provider.authMethods.map((method) => {
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
                                  <label className="block text-[12px] text-[var(--muted-foreground)] mb-1">
                                    {field.label}
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
                                  {field.helpText && (
                                    <p className="text-[11px] text-[var(--muted-foreground)] mt-1">
                                      {field.helpText}
                                    </p>
                                  )}
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
                        {status === 'error' && credentialError[provId] && (
                          <div className="mt-2 flex items-start gap-2 p-2.5 bg-red-50 rounded-lg border border-red-100">
                            <AlertCircle className="w-3.5 h-3.5 text-red-500 mt-0.5 shrink-0" />
                            <p className="text-[12px] text-red-700">{credentialError[provId]}</p>
                          </div>
                        )}
                      </div>
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
              </div>
            </div>
          )}

          {/* Step 4: Scanning */}
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
              {/* Total Management Tokens — hero card */}
              <div id="section-overview" className="bg-white rounded-xl border-2 border-[var(--infoblox-orange)]/30 p-5 mb-6">
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <div className="text-[13px] text-[var(--muted-foreground)] mb-1">Total Management Tokens</div>
                    <div className="text-[32px] text-[var(--infoblox-orange)]" style={{ fontWeight: 700 }}>
                      {totalTokens.toLocaleString()}
                    </div>
                  </div>
                  <div className="text-[11px] text-[var(--muted-foreground)] mt-1">
                    By {selectedProviders.map((p) => PROVIDERS.find((pr) => pr.id === p)!.subscriptionLabel).filter((v, i, a) => a.indexOf(v) === i).join(' / ')}
                  </div>
                </div>
                {/* Per-source contribution bars */}
                <div className="space-y-2.5">
                  {(() => {
                    const sourceMap = new Map<string, { source: string; provider: ProviderType; tokens: number }>();
                    findings.forEach((f) => {
                      const key = `${f.provider}::${f.source}`;
                      if (!sourceMap.has(key)) sourceMap.set(key, { source: f.source, provider: f.provider, tokens: 0 });
                      sourceMap.get(key)!.tokens += f.managementTokens;
                    });
                    const sources = Array.from(sourceMap.values()).sort((a, b) => b.tokens - a.tokens);
                    const HERO_LIMIT = 10;
                    const visibleSources = showAllHeroSources ? sources : sources.slice(0, HERO_LIMIT);
                    const hiddenCount = sources.length - HERO_LIMIT;
                    const heroNeedsScroll = showAllHeroSources && sources.length > 15;
                    return (
                      <>
                        <div className={heroNeedsScroll ? 'max-h-[400px] overflow-y-auto' : ''}>
                        {visibleSources.map((entry) => {
                          const provider = PROVIDERS.find((p) => p.id === entry.provider)!;
                          const pct = totalTokens > 0 ? (entry.tokens / totalTokens) * 100 : 0;
                          return (
                            <div key={`${entry.provider}-${entry.source}`} className="mb-2.5">
                              <div className="flex items-center justify-between mb-1">
                                <span className="text-[12px] flex items-center gap-1.5" style={{ fontWeight: 500 }}>
                                  <span
                                    className="inline-block w-2 h-2 rounded-full shrink-0"
                                    style={{ backgroundColor: provider.color }}
                                  />
                                  {entry.source}
                                  <span className="text-[11px] text-[var(--muted-foreground)]" style={{ fontWeight: 400 }}>
                                    {provider.name}
                                  </span>
                                </span>
                                <span className="text-[12px] tabular-nums text-[var(--muted-foreground)]">
                                  {entry.tokens.toLocaleString()} <span className="text-[11px]">({Math.round(pct)}%)</span>
                                </span>
                              </div>
                              <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                                <div
                                  className="h-full rounded-full transition-all"
                                  style={{ width: `${pct}%`, backgroundColor: provider.color }}
                                />
                              </div>
                            </div>
                          );
                        })}
                        </div>
                        {hiddenCount > 0 && (
                          <button
                            type="button"
                            onClick={() => setShowAllHeroSources((v) => !v)}
                            className="text-[12px] text-[var(--infoblox-blue)] hover:underline mt-1"
                            style={{ fontWeight: 500 }}
                          >
                            {showAllHeroSources ? 'Show less' : `Show ${hiddenCount} more sources...`}
                          </button>
                        )}
                      </>
                    );
                  })()}
                </div>
              </div>

              {/* Section jump navigation — only for NIOS scans */}
              {selectedProviders.includes('nios') && (
                <div className="sticky top-0 z-10 bg-white border-b border-[var(--border)] rounded-xl mb-6 px-4 py-2.5 flex items-center gap-2 flex-wrap">
                  {[
                    { id: 'section-overview', label: 'Overview' },
                    { id: 'section-migration-planner', label: 'Migration Planner' },
                    { id: 'section-server-tokens', label: 'Server Token Calculator' },
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
                  const items = findings.filter(card.filter);
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
                  findings.filter(f => f.category === category).forEach((f) => {
                    const key = `${f.provider}::${f.source}`;
                    if (!map.has(key)) map.set(key, { source: f.source, provider: f.provider, tokens: 0, count: 0 });
                    const e = map.get(key)!;
                    e.tokens += f.managementTokens;
                    e.count += f.count;
                  });
                  return Array.from(map.values()).sort((a, b) => b.tokens - a.tokens);
                };

                const categories: { key: TokenCategory; label: string; color: string; bgLight: string; barColor: string; textColor: string; unitLabel: string }[] = [
                  { key: 'DDI Object', label: 'DDI Objects', color: 'text-blue-600', bgLight: 'bg-blue-50', barColor: 'bg-blue-500', textColor: 'text-blue-700', unitLabel: 'objects' },
                  { key: 'Active IP', label: 'Active IPs', color: 'text-purple-600', bgLight: 'bg-purple-50', barColor: 'bg-purple-500', textColor: 'text-purple-700', unitLabel: 'IPs' },
                  { key: 'Asset', label: 'Assets', color: 'text-green-600', bgLight: 'bg-green-50', barColor: 'bg-green-500', textColor: 'text-green-700', unitLabel: 'assets' },
                ];

                return (
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
                    {categories.map((cat) => {
                      const catTokens = categoryTotals[cat.key];
                      const catCount = findings.filter(f => f.category === cat.key).reduce((s, f) => s + f.count, 0);
                      const sources = buildSourceList(cat.key);
                      const maxSourceTokens = Math.max(...sources.map(s => s.tokens), 1);

                      return (
                        <div key={cat.key} className="bg-white rounded-xl border border-[var(--border)] overflow-hidden flex flex-col">
                          {/* Category header */}
                          <div className={`px-4 py-4 border-b border-[var(--border)] ${cat.bgLight}`}>
                            <div className="text-[12px] text-[var(--muted-foreground)] mb-1">{cat.label}</div>
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
                const niosFindings = findings.filter((f) => f.provider === 'nios');
                const nonNiosTokens = findings.filter((f) => f.provider !== 'nios').reduce((s, f) => s + f.managementTokens, 0);
                // NIOS Licensing column uses NIOS ratios (50/25/13), not UDDI ratios
                const allNiosTokens = calcNiosTokens(niosFindings);
                // UDDI tokens for all NIOS findings (used in Full Migration scenario)
                const allNiosUddiTokens = niosFindings.reduce((s, f) => s + f.managementTokens, 0);

                const stayingFindings = niosFindings.filter((f) => !niosMigrationMap.has(f.source));
                const stayingTokens = calcNiosTokens(stayingFindings);
                // Migrating tokens use UDDI ratios (they move to UDDI licensing)
                const migratingTokens = niosFindings
                  .filter((f) => niosMigrationMap.has(f.source))
                  .reduce((s, f) => s + f.managementTokens, 0);

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
                    <div className="px-4 py-4">
                      <h3 className="text-[14px] font-semibold text-[var(--foreground)] mb-3">Management Tokens</h3>
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                        {[scenarioCurrent, scenarioHybrid, scenarioFull].map((scenario, idx) => {
                          const isHybrid = idx === 1;
                          const isFull = idx === 2;
                          const isActive = isHybrid ? niosMigrationMap.size > 0 && niosMigrationMap.size < niosSources.length : isFull ? niosMigrationMap.size === niosSources.length : niosMigrationMap.size === 0;
                          return (
                            <div
                              key={scenario.label}
                              className={`rounded-xl border-2 p-4 transition-colors ${
                                isActive
                                  ? 'border-[var(--infoblox-orange)] bg-orange-50/30 shadow-sm'
                                  : 'border-[var(--border)] bg-white'
                              }`}
                            >
                              <div className="flex items-center gap-2 mb-2">
                                {isActive && <span className="w-2 h-2 rounded-full bg-[var(--infoblox-orange)]" />}
                                <span className="text-[12px] uppercase tracking-wider text-[var(--muted-foreground)]" style={{ fontWeight: 600 }}>
                                  {scenario.label}
                                </span>
                              </div>
                              <div className="text-[28px] text-[var(--infoblox-orange)]" style={{ fontWeight: 700 }}>
                                {(scenario.uddiTokens + scenario.niosTokens).toLocaleString()}
                              </div>
                              <div className="text-[11px] text-[var(--muted-foreground)] mb-2">
                                Universal DDI Tokens
                              </div>
                              {scenario.niosTokens > 0 && (
                                <div className="text-[11px] space-y-0.5 mb-1">
                                  <div className="text-blue-600">
                                    {scenario.uddiTokens.toLocaleString()} on NIOS-X / Universal DDI
                                  </div>
                                  <div className="text-gray-500">
                                    {scenario.niosTokens.toLocaleString()} on NIOS Licensing
                                  </div>
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
                  </div>
                );
              })()}

              {/* Server Token Calculator — per-member QPS/LPS/Object sizing */}
              {selectedProviders.includes('nios') && (() => {
                // Only show metrics for members selected for migration
                const migratingMembers = effectiveNiosMetrics.filter((m) =>
                  niosMigrationMap.has(m.memberName)
                );
                const allMembers = effectiveNiosMetrics.filter((m) => {
                  const niosSources = new Set(
                    findings.filter((f) => f.provider === 'nios').map((f) => f.source)
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
                  return sum + calcServerTokenTier(m.qps, m.lps, m.objectCount, 'nios-x').serverTokens;
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
                  <div id="section-server-tokens" className="bg-white rounded-xl border-2 border-emerald-200 mb-6 overflow-hidden">
                    <div className="px-4 py-3 border-b border-[var(--border)] bg-emerald-50/50 flex items-center gap-2 flex-wrap">
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
                          <div className="text-[11px] uppercase tracking-wider text-[var(--muted-foreground)] mb-1" style={{ fontWeight: 600 }}>
                            Allocated Server Tokens
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
                              </span>
                            </th>
                            <th className="text-right px-3 py-2.5" style={{ fontWeight: 600 }}>
                              <span className="flex items-center justify-end gap-1">
                                <Gauge className="w-3 h-3" /> LPS
                              </span>
                            </th>
                            <th className="text-right px-3 py-2.5" style={{ fontWeight: 600 }}>Objects</th>
                            <th className="text-center px-3 py-2.5" style={{ fontWeight: 600 }}>Size</th>
                            <th className="text-center px-3 py-2.5" style={{ fontWeight: 600 }}>
                              <span className="text-emerald-700">Allocated Tokens</span>
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {/* NIOS-X members — individual rows */}
                          {niosXMembers.map((member) => {
                            const tier = calcServerTokenTier(member.qps, member.lps, member.objectCount, 'nios-x');
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
                                  {member.objectCount > 0 ? member.objectCount.toLocaleString() : <span className="text-gray-300">&mdash;</span>}
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
                                    {member.objectCount > 0 ? member.objectCount.toLocaleString() : <span className="text-gray-300">&mdash;</span>}
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

              {/* Findings table */}
              <div id="section-findings" className="bg-white rounded-xl border border-[var(--border)] mb-6 overflow-hidden">
                <div className="px-4 py-3 border-b border-[var(--border)] bg-gray-50/50 flex items-center justify-between">
                  <h3 className="text-[14px]" style={{ fontWeight: 600 }}>
                    Detailed Findings
                  </h3>
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
                          { col: 'count' as SortColumn, label: 'Count', align: 'right' },
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
                              {f.count.toLocaleString()}
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