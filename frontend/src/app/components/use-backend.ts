import { useState, useEffect, useCallback, useRef } from 'react';
import {
  checkHealth,
  type HealthResponse,
  getBaseUrl,
  getScanStatus,
  type ScanStatusResponse,
  checkForUpdate,
  applySelfUpdate,
  restartApp,
  type UpdateCheckResponse,
} from './api-client';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

export type UpdateStatus = 'idle' | 'checking' | 'updating' | 'done' | 'restarting' | 'error';

interface BackendState {
  status: ConnectionStatus;
  health: HealthResponse | null;
  baseUrl: string;
  isDemo: boolean;
  retry: () => void;
  updateInfo: UpdateCheckResponse | null;
  updateStatus: UpdateStatus;
  updateError: string | null;
  checkUpdate: () => void;
  applyUpdate: () => void;
  restartAfterUpdate: () => void;
}

export function useBackendConnection(): BackendState {
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResponse | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>('idle');
  const [updateError, setUpdateError] = useState<string | null>(null);
  const updateCheckedRef = useRef(false);

  const doCheckUpdate = useCallback(async () => {
    setUpdateStatus('checking');
    setUpdateError(null);
    try {
      const info = await checkForUpdate();
      setUpdateInfo(info);
      setUpdateStatus('idle');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Update check failed';
      setUpdateError(msg);
      setUpdateStatus('error');
    }
  }, []);

  const doApplyUpdate = useCallback(async () => {
    setUpdateStatus('updating');
    setUpdateError(null);
    try {
      const result = await applySelfUpdate();
      if (result.success) {
        setUpdateStatus('done');
      } else {
        setUpdateError(result.error || 'Update failed');
        setUpdateStatus('error');
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Self-update failed';
      setUpdateError(msg);
      setUpdateStatus('error');
    }
  }, []);

  const doRestart = useCallback(async () => {
    setUpdateStatus('restarting');
    setUpdateError(null);
    try {
      await restartApp();
    } catch {
      // Expected — the server shuts down so the request may fail
    }
    // Poll health endpoint until the new process is up, then reload
    const maxAttempts = 30; // 15 seconds
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(r => setTimeout(r, 500));
      try {
        await checkHealth();
        // Server is back — reload the page to pick up any new frontend assets
        window.location.reload();
        return;
      } catch {
        // Not ready yet, keep polling
      }
    }
    // If we get here, the server didn't come back
    setUpdateError('Server did not restart in time. Please relaunch the application manually.');
    setUpdateStatus('error');
  }, []);

  const ping = useCallback(async () => {
    try {
      const h = await checkHealth();
      setHealth(h);
      setStatus('connected');
    } catch {
      setStatus('disconnected');
      setHealth(null);
    }
  }, []);

  useEffect(() => {
    ping();
    const id = setInterval(ping, 8000);
    return () => clearInterval(id);
  }, [ping]);

  // Trigger one-time update check after first successful connection
  useEffect(() => {
    if (status === 'connected' && !updateCheckedRef.current) {
      updateCheckedRef.current = true;
      doCheckUpdate();
    }
  }, [status, doCheckUpdate]);

  return {
    status,
    health,
    baseUrl: getBaseUrl(),
    isDemo: status !== 'connected',
    retry: ping,
    updateInfo,
    updateStatus,
    updateError,
    checkUpdate: doCheckUpdate,
    applyUpdate: doApplyUpdate,
    restartAfterUpdate: doRestart,
  };
}

// ─── Scan Polling ──────────────────────────────────────────────────────────────

export interface ScanPollingCallbacks {
  onStatus: (status: ScanStatusResponse) => void;
  onComplete: () => void;
  onError: (message: string) => void;
}

/**
 * useScanPolling — polls GET /api/v1/scan/{scanId}/status every 1.5 seconds.
 * Stops automatically when status === 'complete' or on unmount.
 * Call with scanId='' (empty string) to disable polling.
 */
export function useScanPolling(scanId: string, callbacks: ScanPollingCallbacks): void {
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks; // keep callbacks fresh without restarting effect

  useEffect(() => {
    if (!scanId) return;

    let stopped = false;

    const id = setInterval(async () => {
      try {
        const status = await getScanStatus(scanId);
        if (stopped) return;
        callbacksRef.current.onStatus(status);
        if (status.status === 'complete') {
          stopped = true;
          clearInterval(id);
          callbacksRef.current.onComplete();
        }
      } catch (err: unknown) {
        if (stopped) return;
        const msg = err instanceof Error ? err.message : 'Polling error';
        callbacksRef.current.onError(msg);
      }
    }, 1500);

    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [scanId]);
}
