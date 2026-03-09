import { useState, useEffect, useCallback, useRef } from 'react';
import { checkHealth, type HealthResponse, getBaseUrl, getScanStatus, type ScanStatusResponse } from './api-client';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

interface BackendState {
  status: ConnectionStatus;
  health: HealthResponse | null;
  baseUrl: string;
  isDemo: boolean;
  retry: () => void;
}

export function useBackendConnection(): BackendState {
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [health, setHealth] = useState<HealthResponse | null>(null);

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

  return {
    status,
    health,
    baseUrl: getBaseUrl(),
    isDemo: status !== 'connected',
    retry: ping,
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
