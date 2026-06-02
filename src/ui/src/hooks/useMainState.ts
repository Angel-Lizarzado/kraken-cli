import { useState, useEffect } from 'react';

// ── Types ──

export interface ModuleProcessState {
  isRunning: boolean;
  currentDomain: string;
  currentProgress: number;
  currentMessage: string;
  totalDomains: number;
  currentIndex: number;
  results: Array<{ domain: string; status: string; message: string }>;
  domainsQueue: string[];
  recentLogs: Array<{ message: string; timestamp: number }>;
}

export interface MainAppState {
  syncdns: ModuleProcessState;
  extraction: ModuleProcessState;
  deployment: ModuleProcessState;
  cloudflare: ModuleProcessState;
  ssl: ModuleProcessState;
  malware: ModuleProcessState;
  sshConnection: {
    isConnected: boolean;
    serverId: string | null;
    serverName: string | null;
    lastChecked: number | null;
  };
}

// ── Module IDs ──
const MODULE_IDS = ['syncdns', 'extraction', 'deployment', 'cloudflare', 'ssl', 'malware'] as const;
const SSH_CONNECTION_ID = 'sshConnection';

// ── Hook ──
export function useMainState() {
  const [state, setState] = useState<MainAppState | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let unsub: (() => void) | undefined;

    const init = async () => {
      try {
        // Try electronAPI first, fall back to window.api.invoke
        const electronApi = window.electronAPI;
        const legacyApi = window.api;

        const getModule = async (moduleId: string): Promise<unknown> => {
          if (electronApi && typeof electronApi.getModuleState === 'function') {
            return await electronApi.getModuleState(moduleId);
          }
          if (legacyApi && typeof legacyApi.invoke === 'function') {
            return await legacyApi.invoke('module:get-status', { moduleId });
          }
          throw new Error('IPC no disponible');
        };

        const results = await Promise.all([
          ...MODULE_IDS.map((id) => getModule(id)),
          getModule(SSH_CONNECTION_ID),
        ]);

        const mainState: MainAppState = {
          syncdns: results[0] as ModuleProcessState,
          extraction: results[1] as ModuleProcessState,
          deployment: results[2] as ModuleProcessState,
          cloudflare: results[3] as ModuleProcessState,
          ssl: results[4] as ModuleProcessState,
          malware: results[5] as ModuleProcessState,
          sshConnection: results[6] as MainAppState['sshConnection'],
        };

        setState(mainState);

        // Subscribe to real-time updates
        if (electronApi && typeof electronApi.onStateUpdate === 'function') {
          unsub = electronApi.onStateUpdate(
            (payload: unknown) => {
              setState(payload as MainAppState);
            },
          );
        } else if (legacyApi && typeof legacyApi.invoke === 'function') {
          const handler = (payload: unknown) => {
            setState(payload as MainAppState);
          };
          legacyApi.receive('state:update', handler);
          unsub = () => legacyApi.removeAllListeners('state:update');
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Error desconocido';
        setError(message);
      } finally {
        setIsLoading(false);
      }
    };

    init();

    return () => {
      if (unsub) unsub();
    };
  }, []);

  return { state, isLoading, error } as const;
}
