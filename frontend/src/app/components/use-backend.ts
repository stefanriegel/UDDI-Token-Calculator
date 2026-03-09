import { useState, useEffect, useCallback } from 'react';
import { checkHealth, type HealthResponse, getBaseUrl } from './api-client';

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
