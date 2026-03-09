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
}

export async function validateCredentials(
  provider: string,
  authMethod: string,
  credentials: Record<string, string>,
): Promise<ValidateResponse> {
  const res = await fetch(apiUrl(`/providers/${provider}/validate`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ authMethod, credentials }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Validation failed: ${res.status}`);
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

// ─── Scan ──────────────────────────────────────────────────────────────────────

export interface ScanRequest {
  sessionId: string; // from "ddi_session" cookie — credentials NOT re-sent
  providers: {
    provider: string;
    subscriptions: string[];
    selectionMode: 'include' | 'exclude';
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

// ─── Scan Results ──────────────────────────────────────────────────────────────

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
}

export async function getScanResults(scanId: string): Promise<ScanResultsResponse> {
  const res = await fetch(apiUrl(`/scan/${scanId}/results`));
  if (!res.ok) throw new Error(`Results fetch failed: ${res.status}`);
  return res.json();
}
