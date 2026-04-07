/**
 * API Client for ddi-scanner.exe
 *
 * When the Go binary serves both the SPA and API on the same port,
 * we use same-origin relative URLs (/api/v1/...).
 *
 * During Vite dev mode, the dev server proxy (configured in vite.config.ts)
 * forwards /api requests to http://localhost:8080, so relative URLs work
 * in both production and development.
 *
 * If the Go EXE is running on a different host/port, call setBaseUrl()
 * to override.
 */

const API_PREFIX = '/api/v1';

// Default: same-origin (empty string = relative to current origin)
let baseUrl = '';

/**
 * Override the API base URL.
 * Examples:
 *   setBaseUrl('http://10.0.0.5:8080')   // remote Go instance
 *   setBaseUrl('')                         // same-origin (default)
 */
export function setBaseUrl(url: string) {
  baseUrl = url.replace(/\/+$/, '');
}

export function getBaseUrl() {
  return baseUrl || window.location.origin;
}

function apiUrl(path: string) {
  return `${baseUrl}${API_PREFIX}${path}`;
}

// ─── Health ────────────────────────────────────────────────────────────────────

export interface HealthResponse {
  status: 'ok' | 'degraded' | 'error';
  version: string;
  /** runtime.GOOS from the backend binary — e.g. "windows", "darwin", "linux" */
  platform?: string;
}

export async function checkHealth(): Promise<HealthResponse> {
  const res = await fetch(apiUrl('/health'), { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
  return res.json();
}

// ─── Credential Validation ─────────────────────────────────────────────────────

export interface SubscriptionItem {
  id: string;
  name: string;
}

export interface ValidateResponse {
  valid: boolean;
  error?: string;
  subscriptions: SubscriptionItem[];
  deviceCodeMessage?: string;
}

export async function validateCredentials(
  provider: string,
  authMethod: string,
  credentials: Record<string, string>,
  forestIndex?: number,
): Promise<ValidateResponse> {
  const res = await fetch(apiUrl(`/providers/${provider}/validate`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ authMethod, credentials, ...(forestIndex !== undefined && forestIndex > 0 ? { forestIndex } : {}) }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Validation failed: ${res.status}`);
  }
  return res.json();
}

// ─── Provider-specific Validation ────────────────────────────────────────────

export interface BluecatValidateResponse {
  valid: boolean;
  error?: string;
  apiVersion?: string;      // "v1" or "v2"
  subscriptions: SubscriptionItem[];
}

export async function validateBluecat(credentials: Record<string, string>): Promise<BluecatValidateResponse> {
  const res = await fetch(apiUrl('/providers/bluecat/validate'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ authMethod: 'credentials', credentials }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `BlueCat validation failed: ${res.status}`);
  }
  return res.json();
}

export interface EfficientipValidateResponse {
  valid: boolean;
  error?: string;
  authMode?: string;        // "basic" or "native"
  subscriptions: SubscriptionItem[];
}

export async function validateEfficientip(credentials: Record<string, string>): Promise<EfficientipValidateResponse> {
  const { authMethod, api_version, ...rest } = credentials;
  const res = await fetch(apiUrl('/providers/efficientip/validate'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      authMethod: authMethod || 'credentials',
      api_version: api_version || 'legacy',
      credentials: rest,
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `EfficientIP validation failed: ${res.status}`);
  }
  return res.json();
}

export interface NiosWapiValidateResponse {
  valid: boolean;
  error?: string;
  wapiVersion?: string;
  members: NiosGridMember[];
}

export async function validateNiosWapi(credentials: Record<string, string>): Promise<NiosWapiValidateResponse> {
  const res = await fetch(apiUrl('/providers/nios/validate'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ authMethod: 'wapi', credentials }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `NIOS WAPI validation failed: ${res.status}`);
  }
  return res.json();
}

// ─── Session ───────────────────────────────────────────────────────────────────

/**
 * Read the session ID from the httpOnly "ddi_session" cookie.
 * Note: httpOnly cookies are NOT readable from JS — the backend sets a
 * separate readable "ddi_session_id" cookie for client use, or we read
 * from the validate response. If the cookie is httpOnly, this returns ''.
 * The backend accepts an empty sessionId and resolves it from the cookie.
 */
export function getSessionId(): string {
  const match = document.cookie.match(/(?:^|;\s*)ddi_session=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

// ─── Session Clone ─────────────────────────────────────────────────────────────

export interface CloneSessionResponse {
  sessionId: string;
}

/**
 * Clone the current session on the backend, preserving all credentials.
 * The server reads the ddi_session cookie automatically (no body needed)
 * and sets a new ddi_session cookie in the response.
 *
 * Use this before re-scanning so SSO/browser-OAuth providers do not trigger
 * a second browser popup — their live token objects are shared between the
 * old and new sessions.
 */
export async function cloneSession(): Promise<CloneSessionResponse> {
  const res = await fetch(apiUrl('/session/clone'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `Clone session failed: ${res.status}`);
  }
  return res.json();
}

// ─── AD Forest Discovery ───────────────────────────────────────────────────────

export interface ADDiscoveredServer {
  hostname: string;
  ip?: string;
  domain?: string;
  roles: string[]; // e.g. ["DC", "DNS"] or ["DHCP"]
}

export interface ADDiscoverResponse {
  forestName?: string;
  domainControllers: ADDiscoveredServer[];
  dhcpServers: ADDiscoveredServer[];
  errors?: string[];
}

/**
 * Probe the AD forest via a seed DC and return all domain controllers and
 * DHCP servers discovered.  Credentials are NOT stored server-side by this
 * endpoint — the seed host must already be in the validated session.
 */
export async function discoverADServers(
  authMethod: string,
  credentials: Record<string, string>,
): Promise<ADDiscoverResponse> {
  const res = await fetch(apiUrl('/providers/ad/discover'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ authMethod, credentials }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `AD discover failed: ${res.status}`);
  }
  return res.json();
}

// ─── Scan ──────────────────────────────────────────────────────────────────────

export interface ScanRequest {
  sessionId: string; // from "ddi_session" cookie — credentials NOT re-sent
  providers: {
    provider: string;
    subscriptions: string[];
    selectionMode: 'include' | 'exclude';
    backupToken?: string;       // NIOS only: opaque token from /providers/nios/upload
    selectedMembers?: string[]; // NIOS only: hostnames selected in Sources step
    mode?: 'backup' | 'wapi';  // NIOS only: scan mode
    maxWorkers?: number;        // max concurrent workers (0 = provider default)
    requestTimeout?: number;    // per-request timeout in seconds (0 = provider default)
  }[];
}

export interface ScanStartResponse {
  scanId: string;
}

export async function startScan(request: ScanRequest): Promise<ScanStartResponse> {
  const res = await fetch(apiUrl('/scan'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Scan start failed: ${res.status}`);
  }
  return res.json();
}

// ─── Scan Status (Polling) ─────────────────────────────────────────────────────

export interface ProviderScanStatus {
  provider: string;
  progress: number;    // 0–100
  status: string;      // "pending" | "running" | "complete" | "error"
  itemsFound: number;
}

export interface ScanStatusResponse {
  scanId: string;
  status: 'running' | 'complete';
  progress: number;    // 0–100
  providers: ProviderScanStatus[];
}

export async function getScanStatus(scanId: string): Promise<ScanStatusResponse> {
  const res = await fetch(apiUrl(`/scan/${scanId}/status`));
  if (!res.ok) throw new Error(`Status fetch failed: ${res.status}`);
  return res.json();
}

// ─── NIOS ──────────────────────────────────────────────────────────────────────

export interface NiosGridMember {
  hostname: string;
  role: string;        // "Master" | "Candidate" | "Regular"
}

export interface NiosUploadResponse {
  valid: boolean;
  error?: string;
  gridName?: string;
  niosVersion?: string;
  members: NiosGridMember[];
  backupToken?: string;
}

export async function uploadNiosBackup(file: File): Promise<NiosUploadResponse> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(apiUrl('/providers/nios/upload'), {
    method: 'POST',
    body: form,
    // no Content-Type header — browser sets multipart boundary automatically
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `Upload failed: ${res.status}`);
  }
  return res.json();
}

export interface EfficientIPUploadResponse {
  valid: boolean;
  error?: string;
  backupToken?: string;
}

export async function uploadEfficientipBackup(file: File): Promise<EfficientIPUploadResponse> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(apiUrl('/providers/efficientip/upload'), {
    method: 'POST',
    body: form,
    // no Content-Type header — browser sets multipart boundary automatically
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `Upload failed: ${res.status}`);
  }
  return res.json();
}

// ─── Update Check ─────────────────────────────────────────────────────────────

export interface UpdateCheckResponse {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  releaseURL?: string;
  releaseNotes?: string;
  downloadURL?: string;
  dockerMode?: boolean;
}

export interface SelfUpdateResponse {
  success: boolean;
  error?: string;
  message?: string;
  restartPending?: boolean;
  /** Set when the binary is managed by an external package manager (e.g. "homebrew"). */
  managedBy?: string;
}

export async function checkForUpdate(): Promise<UpdateCheckResponse> {
  const res = await fetch(apiUrl('/update/check'), { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Update check failed: ${res.status}`);
  return res.json();
}

export async function applySelfUpdate(): Promise<SelfUpdateResponse> {
  const res = await fetch(apiUrl('/update/apply'), { method: 'POST', signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`Self-update failed: ${res.status}`);
  return res.json();
}

export async function restartApp(): Promise<{ success: boolean; error?: string }> {
  const res = await fetch(apiUrl('/update/restart'), { method: 'POST', signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Restart request failed: ${res.status}`);
  return res.json();
}

// ─── Scan Results ──────────────────────────────────────────────────────────────

export interface NiosServerMetricAPI {
  memberId: string;
  memberName: string;
  role: string;   // loose type — backend sends plain string
  qps: number;
  lps: number;
  objectCount: number;
  activeIPCount: number;
  model: string;
  platform: string;
  managedIPCount: number;
  staticHosts: number;
  dynamicHosts: number;
  dhcpUtilization: number;  // scaled integer, 268 = 26.8%
  licenses?: Record<string, boolean>;
}

export interface NiosGridFeaturesAPI {
  dnameRecords: boolean;
  dnsAnycast: boolean;
  captivePortal: boolean;
  dhcpv6: boolean;
  ntpServer: boolean;
  dataConnector: boolean;
}

export interface NiosGridLicensesAPI {
  types: string[];
}

export interface DHCPOptionFlagAPI {
  network: string;
  optionNumber: number;
  optionName: string;
  optionType: string;
  flag: 'VALIDATION_NEEDED' | 'CHECK_GUARDRAILS';
  member: string;
}

export interface HostRouteFlagAPI {
  network: string;
  member: string;
}

export interface NiosMigrationFlagsAPI {
  dhcpOptions: DHCPOptionFlagAPI[];
  hostRoutes: HostRouteFlagAPI[];
}

export interface ADServerMetricAPI {
  hostname: string;
  dnsObjects: number;
  dhcpObjects: number;
  dhcpObjectsWithOverhead: number;
  qps: number;
  lps: number;
  tier: string;
  serverTokens: number;
}

export interface FindingRowAPI {
  provider: string;
  source: string;
  region: string; // cloud region (e.g. "us-east-1"); empty string for global resources
  category: 'DDI Objects' | 'Active IPs' | 'Managed Assets';
  item: string;
  count: number;
  tokensPerUnit: number;
  managementTokens: number;
}

export interface ScanResultsResponse {
  scanId: string;
  completedAt: string;
  status: 'running' | 'complete';
  totalManagementTokens: number;
  ddiTokens: number;
  ipTokens: number;
  assetTokens: number;
  findings: FindingRowAPI[];
  errors: { provider: string; resource: string; message: string }[];
  niosServerMetrics?: NiosServerMetricAPI[];
  adServerMetrics?: ADServerMetricAPI[];
  niosGridFeatures?: NiosGridFeaturesAPI;
  niosGridLicenses?: NiosGridLicensesAPI;
  niosMigrationFlags?: NiosMigrationFlagsAPI;
}

export async function getScanResults(scanId: string): Promise<ScanResultsResponse> {
  const res = await fetch(apiUrl(`/scan/${scanId}/results`));
  if (!res.ok) throw new Error(`Results fetch failed: ${res.status}`);
  return res.json();
}

// ─── Excel Export ──────────────────────────────────────────────────────────────

/** Optional payload for POST /api/v1/scan/{scanId}/export (RES-15). */
export interface ExportRequest {
  /** Per-member appliance variant index, keyed by NIOS member ID. */
  variantOverrides?: Record<string, number>;
}

/**
 * POST /api/v1/scan/{scanId}/export.
 *
 * Returns a Blob of the .xlsx workbook. The caller is responsible for
 * triggering a browser download via a temporary <a> tag + object URL.
 *
 * `variantOverrides` is a plain object keyed by NIOS member ID mapping to
 * the chosen appliance variant index. Pass `undefined` or `{}` to use
 * each ApplianceSpec's default variant. Implements RES-15.
 */
export async function downloadExcelExport(
  scanId: string,
  variantOverrides?: Record<string, number>,
): Promise<Blob> {
  const body: ExportRequest = {};
  if (variantOverrides && Object.keys(variantOverrides).length > 0) {
    body.variantOverrides = variantOverrides;
  }
  const res = await fetch(apiUrl(`/scan/${encodeURIComponent(scanId)}/export`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `Export failed: ${res.status}`);
  }
  return res.blob();
}
