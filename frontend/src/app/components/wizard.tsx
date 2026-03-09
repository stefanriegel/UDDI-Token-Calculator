import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import {
  Shield,
  CheckCircle2,
  Circle,
  ChevronRight,
  ChevronLeft,
  Cloud,
  Server,
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
} from 'lucide-react';
import { useBackendConnection } from './use-backend';
import {
  validateCredentials as apiValidate,
  startScan as apiStartScan,
  startScanEvents,
  getScanResults as apiGetScanResults,
  getSessionId,
  type ScanResultsResponse,
} from './api-client';
import {
  PROVIDERS,
  MOCK_SUBSCRIPTIONS,
  generateMockFindings,
  TOKEN_RATES,
  type ProviderType,
  type FindingRow,
  type TokenCategory,
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

export function Wizard() {
  const backend = useBackendConnection();
  const [currentStep, setCurrentStep] = useState<Step>('providers');
  const currentIndex = STEPS.findIndex((s) => s.id === currentStep);

  // State
  const [selectedProviders, setSelectedProviders] = useState<ProviderType[]>([]);
  const [credentials, setCredentials] = useState<Record<ProviderType, Record<string, string>>>({
    aws: {},
    azure: {},
    gcp: {},
    microsoft: {},
  });
  const [credentialStatus, setCredentialStatus] = useState<Record<ProviderType, 'idle' | 'validating' | 'valid' | 'error'>>({
    aws: 'idle',
    azure: 'idle',
    gcp: 'idle',
    microsoft: 'idle',
  });
  const [subscriptions, setSubscriptions] = useState<
    Record<ProviderType, { id: string; name: string; selected: boolean }[]>
  >({
    aws: [],
    azure: [],
    gcp: [],
    microsoft: [],
  });
  const [scanProgress, setScanProgress] = useState(0);
  const [providerScanProgress, setProviderScanProgress] = useState<Record<ProviderType, number>>({
    aws: 0, azure: 0, gcp: 0, microsoft: 0,
  });
  const [findings, setFindings] = useState<FindingRow[]>([]);
  const [scanResults, setScanResults] = useState<ScanResultsResponse | null>(null);
  const [providerErrors, setProviderErrors] = useState<{ provider: string; resource: string; message: string }[]>([]);
  const [credentialError, setCredentialError] = useState<Record<ProviderType, string>>({
    aws: '', azure: '', gcp: '', microsoft: '',
  });
  const [scanError, setScanError] = useState<string>('');
  const [scanId, setScanId] = useState<string>('');
  const scanIntervalsRef = useRef<ReturnType<typeof setInterval>[]>([]);
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});
  const [selectedAuthMethod, setSelectedAuthMethod] = useState<Record<ProviderType, string>>({
    aws: 'access-key',
    azure: 'service-principal',
    gcp: 'service-account',
    microsoft: 'ntlm',
  });
  const [sourceSearch, setSourceSearch] = useState<Record<ProviderType, string>>({
    aws: '', azure: '', gcp: '', microsoft: '',
  });
  // Findings table filters & sorting
  const [findingsProviderFilter, setFindingsProviderFilter] = useState<Set<ProviderType>>(new Set());
  const [findingsCategoryFilter, setFindingsCategoryFilter] = useState<Set<TokenCategory>>(new Set());
  const [findingsSort, setFindingsSort] = useState<{ col: SortColumn; dir: SortDir } | null>(null);

  // Selection mode: 'include' = checked items will be scanned; 'exclude' = checked items will be SKIPPED
  const [selectionMode, setSelectionMode] = useState<Record<ProviderType, 'include' | 'exclude'>>({
    aws: 'include', azure: 'include', gcp: 'include', microsoft: 'include',
  });

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
    setCredentials({ aws: {}, azure: {}, gcp: {}, microsoft: {} });
    setCredentialStatus({ aws: 'idle', azure: 'idle', gcp: 'idle', microsoft: 'idle' });
    setSubscriptions({ aws: [], azure: [], gcp: [], microsoft: [] });
    setScanProgress(0);
    setProviderScanProgress({ aws: 0, azure: 0, gcp: 0, microsoft: 0 });
    setFindings([]);
    setScanResults(null);
    setProviderErrors([]);
    setCredentialError({ aws: '', azure: '', gcp: '', microsoft: '' });
    setScanError('');
    setScanId('');
    setSourceSearch({ aws: '', azure: '', gcp: '', microsoft: '' });
    setSelectionMode({ aws: 'include', azure: 'include', gcp: 'include', microsoft: 'include' });
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

    // Real API call
    try {
      const authMethod = selectedAuthMethod[providerId];
      const creds = credentials[providerId] || {};
      const result = await apiValidate(providerId, authMethod, creds);
      if (result.valid) {
        setCredentialStatus((prev) => ({ ...prev, [providerId]: 'valid' }));
        setSubscriptions((prev) => ({
          ...prev,
          [providerId]: result.subscriptions.map((s) => ({ ...s, selected: false })),
        }));
      } else {
        setCredentialStatus((prev) => ({ ...prev, [providerId]: 'error' }));
        setCredentialError((prev) => ({ ...prev, [providerId]: result.error || 'Validation failed' }));
      }
    } catch (err: any) {
      setCredentialStatus((prev) => ({ ...prev, [providerId]: 'error' }));
      setCredentialError((prev) => ({
        ...prev,
        [providerId]: err?.message || 'Connection error — is the backend running?',
      }));
    }
  }, [backend.isDemo, selectedAuthMethod, credentials]);

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

  // SSE scan event listener — wires EventSource to scan progress state
  useEffect(() => {
    if (!scanId) return;

    // Track resource-level progress per provider (count resources done)
    const providerResourcesDone: Record<string, number> = {};

    const stopEvents = startScanEvents(
      scanId,
      (event) => {
        if (event.type === 'resource_progress' && event.provider) {
          providerResourcesDone[event.provider] = (providerResourcesDone[event.provider] ?? 0) + 1;
          // Show indeterminate progress: increment by small amount per resource
          setProviderScanProgress((prev) => {
            const cur = prev[event.provider as ProviderType] ?? 0;
            return { ...prev, [event.provider as ProviderType]: Math.min(95, cur + 10) };
          });
          // Overall progress = average of all selected provider progresses
          setScanProgress((prev) => Math.min(95, prev + Math.floor(5 / selectedProviders.length)));
        } else if (event.type === 'provider_complete' && event.provider) {
          setProviderScanProgress((prev) => ({
            ...prev,
            [event.provider as ProviderType]: 100,
          }));
        } else if (event.type === 'scan_complete') {
          setScanProgress(100);
          // Fetch final results
          apiGetScanResults(scanId).then((results) => {
            setScanResults(results);
            setProviderErrors(results.errors ?? []);
            const mapped: FindingRow[] = results.findings.map((f) => ({
              provider: f.provider as ProviderType,
              source: f.source,
              category: f.category as import('./mock-data').TokenCategory,
              item: f.item,
              count: f.count,
              tokensPerUnit: f.tokensPerUnit,
              managementTokens: f.managementTokens,
            }));
            setFindings(mapped);
          }).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : 'Failed to load results';
            setScanError(msg);
          });
        } else if (event.type === 'error') {
          if (event.provider && event.resource && event.message) {
            setProviderErrors((prev) => [
              ...prev,
              { provider: event.provider!, resource: event.resource!, message: event.message! },
            ]);
          }
        }
      },
      () => {
        // SSE connection error — only show if scan not yet complete
        setScanProgress((prev) => {
          if (prev < 100) {
            setScanError('Lost connection to backend during scan.');
          }
          return prev;
        });
      },
    );

    return stopEvents;
  }, [scanId, selectedProviders]);

  // Start scan — uses real API when connected, mock when in demo mode
  const startScan = useCallback(() => {
    clearScanIntervals();
    setScanProgress(0);
    setScanError('');
    const initProgress: Record<ProviderType, number> = { aws: 0, azure: 0, gcp: 0, microsoft: 0 };
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

    // Real API: start scan then stream events via SSE
    (async () => {
      try {
        const sessionId = getSessionId();
        const scanReq = {
          sessionId,
          providers: selectedProviders.map((provId) => ({
            provider: provId,
            subscriptions: Array.from(getEffectiveSelected(provId)),
            selectionMode: selectionMode[provId],
          })),
        };
        const { scanId: newScanId } = await apiStartScan(scanReq);
        setScanId(newScanId);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Failed to start scan';
        setScanError(msg);
      }
    })();
  }, [backend.isDemo, selectedProviders, selectionMode, clearScanIntervals, getEffectiveSelected]);

  // Export
  const totalTokens = useMemo(
    () => findings.reduce((sum, f) => sum + f.managementTokens, 0),
    [findings]
  );

  // Category subtotals for summary
  const categoryTotals = useMemo(() => {
    const totals: Record<import('./mock-data').TokenCategory, number> = {
      'DDI Objects': 0,
      'Active IPs': 0,
      'Managed Assets': 0,
    };
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
        `${PROVIDERS.find((p) => p.id === f.provider)?.name},${f.source},${f.category},${f.item},${f.count},${f.tokensPerUnit},${f.managementTokens}`
    );
    const summary = `\n\nTotal Management Tokens,,,,,,${totalTokens}`;
    const csv = [header, ...rows].join('\n') + summary;
    downloadFile(csv, 'ddi-token-assessment.csv', 'text/csv');
  };

  const exportExcel = () => {
    // Generate a simple HTML table that Excel can open
    let html = '<html><head><meta charset="UTF-8"></head><body>';
    html += '<h2>Infoblox Universal DDI - Management Token Assessment</h2>';
    html += `<p>Generated: ${new Date().toLocaleString()}</p>`;
    html += '<table border="1" cellpadding="4" cellspacing="0">';
    html += '<tr style="background:#002B49;color:white"><th>Provider</th><th>Source</th><th>Token Category</th><th>Item</th><th>Count</th><th>Tokens/Unit</th><th>Management Tokens</th></tr>';
    findings.forEach((f) => {
      html += `<tr><td>${PROVIDERS.find((p) => p.id === f.provider)?.name}</td><td>${f.source}</td><td>${f.category}</td><td>${f.item}</td><td>${f.count}</td><td>${f.tokensPerUnit}</td><td>${f.managementTokens}</td></tr>`;
    });
    html += `<tr style="background:#f5f5f5;font-weight:bold"><td colspan="6">Total Management Tokens</td><td>${totalTokens.toLocaleString()}</td></tr>`;
    html += '</table></body></html>';
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
        <div className="max-w-4xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            {/* Inline Infoblox logo — no external URL dependency */}
            <div className="w-8 h-8 rounded bg-white/10 flex items-center justify-center shrink-0">
              <svg viewBox="0 0 32 32" className="w-5 h-5" fill="none">
                <rect x="2" y="2" width="28" height="28" rx="4" fill="#F37021" />
                <rect x="7" y="7" width="7" height="7" rx="1" fill="white" />
                <rect x="18" y="7" width="7" height="7" rx="1" fill="white" opacity="0.7" />
                <rect x="7" y="18" width="7" height="7" rx="1" fill="white" opacity="0.7" />
                <rect x="18" y="18" width="7" height="7" rx="1" fill="white" opacity="0.4" />
              </svg>
            </div>
            <div>
              <div className="text-[15px] tracking-wide" style={{ fontWeight: 600 }}>
                INFOBLOX
              </div>
              <div className="text-[11px] text-white/60 tracking-wider uppercase">
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
        <div className="max-w-4xl mx-auto px-4 sm:px-6 py-4">
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
                      {step.label}
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
        <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6">
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
                  const Icon = provider.id === 'microsoft' ? Server : Cloud;
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
                          <Icon className="w-5 h-5" style={{ color: provider.color }} />
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
                Choose authentication method
              </h2>
              <p className="text-[13px] text-[var(--muted-foreground)] mb-6">
                Configure credentials for each selected provider. Credentials are sent only to your local Go backend — never to external servers.
              </p>
              <div className="space-y-4">
                {selectedProviders.map((provId) => {
                  const provider = PROVIDERS.find((p) => p.id === provId)!;
                  const status = credentialStatus[provId];
                  const Icon = provId === 'microsoft' ? Server : Cloud;
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
                          <Icon className="w-4 h-4" style={{ color: provider.color }} />
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
                            // Methods not yet implemented in the Go backend are disabled
                            const COMING_SOON: Record<ProviderType, string[]> = {
                              aws: ['sso', 'profile', 'assume-role'],
                              azure: ['browser-sso', 'device-code', 'certificate', 'az-cli'],
                              gcp: ['browser-oauth', 'adc', 'workload-identity'],
                              microsoft: ['kerberos', 'powershell-remote'],
                            };
                            const isComingSoon = COMING_SOON[provId]?.includes(method.id) ?? false;
                            return (
                              <button
                                key={method.id}
                                disabled={isComingSoon}
                                onClick={() => {
                                  if (isComingSoon) return;
                                  setSelectedAuthMethod((prev) => ({ ...prev, [provId]: method.id }));
                                  // Reset status when switching auth method
                                  if (status === 'valid' || status === 'error') {
                                    setCredentialStatus((prev) => ({ ...prev, [provId]: 'idle' }));
                                  }
                                }}
                                title={isComingSoon ? 'Coming soon' : undefined}
                                className={`px-3 py-1.5 rounded-lg text-[12px] transition-all border ${
                                  isComingSoon
                                    ? 'opacity-40 cursor-not-allowed bg-white text-[var(--muted-foreground)] border-[var(--border)]'
                                    : isSelected
                                      ? 'bg-[var(--infoblox-navy)] text-white border-[var(--infoblox-navy)]'
                                      : 'bg-white text-[var(--foreground)] border-[var(--border)] hover:border-gray-400'
                                }`}
                                style={{ fontWeight: isSelected && !isComingSoon ? 600 : 400 }}
                              >
                                {method.name}
                                {isComingSoon && (
                                  <span className="ml-1 text-[10px] opacity-70">(Coming soon)</span>
                                )}
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

                        {hasFields ? (
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
                                    {field.multiline ? (
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
                                    {isSecret && !field.multiline && (
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
                          </div>
                        ) : (
                          <div className="py-2 px-3 bg-green-50 rounded-lg border border-green-100 mb-3">
                            <p className="text-[12px] text-green-700">
                              No credentials needed — the scanner will use your existing session. Click the button below to verify access.
                            </p>
                          </div>
                        )}

                        <button
                          onClick={() => validateCredential(provId)}
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
                            ? (hasFields ? 'Validating...' : 'Authenticating...')
                            : status === 'valid'
                              ? 'Verified'
                              : status === 'error'
                                ? 'Retry'
                                : (hasFields ? 'Validate & Connect' : 'Authenticate via Browser')}
                          {status === 'idle' && !hasFields && <Globe className="w-3.5 h-3.5" />}
                        </button>
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
                  const Icon = provId === 'microsoft' ? Server : Cloud;
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
                          <Icon className="w-4 h-4" style={{ color: provider.color }} />
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
                              ? <>{effectiveCount} will be scanned <span className="text-red-500">({checkedCount} excluded)</span></>
                              : <>{effectiveCount} selected for scan</>
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
                  <>
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
                  </>
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
              <div className="bg-white rounded-xl border-2 border-[var(--infoblox-orange)]/30 p-5 mb-6">
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
                    return sources.map((entry) => {
                      const provider = PROVIDERS.find((p) => p.id === entry.provider)!;
                      const pct = totalTokens > 0 ? (entry.tokens / totalTokens) * 100 : 0;
                      return (
                        <div key={`${entry.provider}-${entry.source}`}>
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
                    });
                  })()}
                </div>
              </div>

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
                  { key: 'DDI Objects', label: 'DDI Objects', color: 'text-blue-600', bgLight: 'bg-blue-50', barColor: 'bg-blue-500', textColor: 'text-blue-700', unitLabel: 'objects' },
                  { key: 'Active IPs', label: 'Active IPs', color: 'text-purple-600', bgLight: 'bg-purple-50', barColor: 'bg-purple-500', textColor: 'text-purple-700', unitLabel: 'IPs' },
                  { key: 'Managed Assets', label: 'Managed Assets', color: 'text-green-600', bgLight: 'bg-green-50', barColor: 'bg-green-500', textColor: 'text-green-700', unitLabel: 'assets' },
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
                              {sources.map((entry) => {
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

              {/* Token formula summary — shows backend-computed values when available, or computed from findings */}
              {(() => {
                const ddiTokens = scanResults?.ddiTokens ?? categoryTotals['DDI Objects'];
                const ipTokens = scanResults?.ipTokens ?? categoryTotals['Active IPs'];
                const assetTokens = scanResults?.assetTokens ?? categoryTotals['Managed Assets'];
                const grandTotal = scanResults?.totalManagementTokens ?? totalTokens;
                const ddiCount = findings.filter(f => f.category === 'DDI Objects').reduce((s, f) => s + f.count, 0);
                const ipCount = findings.filter(f => f.category === 'Active IPs').reduce((s, f) => s + f.count, 0);
                const assetCount = findings.filter(f => f.category === 'Managed Assets').reduce((s, f) => s + f.count, 0);
                return (
                  <div className="bg-white rounded-xl border border-[var(--border)] p-4 mb-4 overflow-hidden">
                    <div className="text-[12px] text-[var(--muted-foreground)] mb-3 uppercase tracking-wider" style={{ fontWeight: 600 }}>
                      Token Formula (Grand Total = max of three categories)
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-[13px]">
                      <div className="bg-blue-50 rounded-lg p-3 border border-blue-100">
                        <div className="text-[11px] text-blue-600 mb-1" style={{ fontWeight: 500 }}>DDI Objects</div>
                        <div className="text-[18px] text-blue-700" style={{ fontWeight: 700 }}>{ddiTokens.toLocaleString()}</div>
                        <div className="text-[11px] text-[var(--muted-foreground)]">{ddiCount.toLocaleString()} objects ÷ 25</div>
                      </div>
                      <div className="bg-purple-50 rounded-lg p-3 border border-purple-100">
                        <div className="text-[11px] text-purple-600 mb-1" style={{ fontWeight: 500 }}>Active IPs</div>
                        <div className="text-[18px] text-purple-700" style={{ fontWeight: 700 }}>{ipTokens.toLocaleString()}</div>
                        <div className="text-[11px] text-[var(--muted-foreground)]">{ipCount.toLocaleString()} IPs ÷ 13</div>
                      </div>
                      <div className="bg-green-50 rounded-lg p-3 border border-green-100">
                        <div className="text-[11px] text-green-600 mb-1" style={{ fontWeight: 500 }}>Managed Assets</div>
                        <div className="text-[18px] text-green-700" style={{ fontWeight: 700 }}>{assetTokens.toLocaleString()}</div>
                        <div className="text-[11px] text-[var(--muted-foreground)]">{assetCount.toLocaleString()} assets ÷ 3</div>
                      </div>
                      <div className="bg-orange-50 rounded-lg p-3 border border-orange-100">
                        <div className="text-[11px] text-[var(--infoblox-orange)] mb-1" style={{ fontWeight: 500 }}>Grand Total</div>
                        <div className="text-[18px] text-[var(--infoblox-orange)]" style={{ fontWeight: 700 }}>{grandTotal.toLocaleString()}</div>
                        <div className="text-[11px] text-[var(--muted-foreground)]">= max of above</div>
                      </div>
                    </div>
                  </div>
                );
              })()}

              {/* Provider errors (if any) */}
              {providerErrors.length > 0 && (
                <div className="bg-white rounded-xl border border-red-200 p-4 mb-4 overflow-hidden">
                  <div className="flex items-center gap-2 mb-3">
                    <AlertCircle className="w-4 h-4 text-red-500 shrink-0" />
                    <div className="text-[13px] text-red-700" style={{ fontWeight: 600 }}>
                      {providerErrors.length} scan error{providerErrors.length !== 1 ? 's' : ''} (partial results shown above)
                    </div>
                  </div>
                  <div className="space-y-2">
                    {providerErrors.map((e, i) => (
                      <div key={i} className="flex items-start gap-2 p-2.5 bg-red-50 rounded-lg">
                        <div className="flex-1 min-w-0">
                          <div className="text-[11px] text-red-700" style={{ fontWeight: 600 }}>
                            {e.provider} / {e.resource}
                          </div>
                          <div className="text-[11px] text-red-600">{e.message}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Findings table */}
              <div className="bg-white rounded-xl border border-[var(--border)] mb-6 overflow-hidden">
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
                      { key: 'DDI Objects' as TokenCategory, label: 'DDI Objects', color: 'blue' },
                      { key: 'Active IPs' as TokenCategory, label: 'Active IPs', color: 'purple' },
                      { key: 'Managed Assets' as TokenCategory, label: 'Managed Assets', color: 'green' },
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
                          { col: 'count' as SortColumn, label: 'Object Count', align: 'right' },
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
                            <td className="px-4 py-2.5 text-[var(--muted-foreground)]">{f.source}</td>
                            <td className="px-4 py-2.5">
                              <span
                                className={`px-2 py-0.5 rounded-full text-[11px] ${
                                  f.category === 'DDI Objects'
                                    ? 'bg-blue-100 text-blue-700'
                                    : f.category === 'Active IPs'
                                      ? 'bg-purple-100 text-purple-700'
                                      : 'bg-green-100 text-green-700'
                                }`}
                                style={{ fontWeight: 500 }}
                              >
                                {f.category}
                              </span>
                            </td>
                            <td className="px-4 py-2.5">{f.item}</td>
                            <td className="px-4 py-2.5 text-right tabular-nums">
                              {f.count.toLocaleString()}
                            </td>
                            <td className="px-4 py-2.5 text-right tabular-nums" style={{ fontWeight: 600 }}>
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
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
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
                  Download Excel
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
          <div className="max-w-4xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
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
    </div>
  );
}