import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { IPC_CHANNEL } from '../hooks/useIpc';
import type { ConfigData, IpcApi } from '../hooks/useIpc';

// ── Context ──
interface ConfigContextValue {
  config: ConfigData | null;
}

const ConfigContext = createContext<ConfigContextValue>({ config: null });

export const useConfig = () => useContext(ConfigContext);

// ── Constants ──
const EMPTY_CONFIG: ConfigData = {
  sshKeys: { privateKeyPath: '', publicKeyPath: '' },
  accounts: [],
  destinationServers: [],
  cloudflare: { apiToken: '', zoneId: '' },
  workspaceRoot: '',
};

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 500;

// ── Provider ──
function requireApi(): IpcApi {
  if (!(window as any).api) {
    throw new Error('IPC no disponible');
  }
  return (window as any).api;
}

/**
 * Returns true if config has meaningful content (non-empty arrays or fields).
 * Used to detect "empty but truthy" race conditions where the backend
 * responds before configManager has finished loading the file.
 */
function isEmptyConfig(cfg: ConfigData | null): boolean {
  if (!cfg) return true;
  const hasAccounts = cfg.accounts && cfg.accounts.length > 0;
  const hasServers = cfg.destinationServers && cfg.destinationServers.length > 0;
  const hasSsh = !!(cfg.sshKeys?.privateKeyPath || cfg.sshKeys?.publicKeyPath);
  const hasCloudflare = !!(cfg.cloudflare?.apiToken || cfg.cloudflare?.zoneId);
  return !(hasAccounts || hasServers || hasSsh || hasCloudflare);
}

export const ConfigProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [config, setConfig] = useState<ConfigData | null>(null);
  const hasBootedRef = useRef(false);

  const tryLoadConfig = useCallback(async (attempt: number): Promise<ConfigData | null> => {
    try {
      const api = requireApi();
      const configData = (await api.invoke(IPC_CHANNEL.CONFIG_GET)) as ConfigData | null;

      if (configData && !isEmptyConfig(configData)) {
        console.log(`[BOOT] Frontend: Recibida config inicial (intento ${attempt})`);
        return configData;
      }

      if (configData && isEmptyConfig(configData)) {
        console.log(`[BOOT] Frontend: config vacía en intento ${attempt}, reintentando...`);
      }
    } catch (error: unknown) {
      console.warn(`[BOOT] Frontend: error en intento ${attempt}:`, error instanceof Error ? error.message : String(error));
    }

    return null; // needs retry
  }, []);

  // Load config with retry + listener from ms 1
  useEffect(() => {
    let api: IpcApi | null = null;
    try {
      api = requireApi();
    } catch {
      console.warn('IPC no disponible');
      return;
    }

    // ── 1. Register listener FIRST — before any invoke ──
    const handleConfigUpdated = (...args: unknown[]) => {
      const data = args[0] as { success: boolean; config: ConfigData } | undefined;
      if (data?.success && data.config && !isEmptyConfig(data.config)) {
        if (!hasBootedRef.current) {
          console.log('[BOOT] Frontend: Recibida config inicial vía config:updated');
          hasBootedRef.current = true;
        }
        setConfig(data.config);
      }
    };

    api.receive(IPC_CHANNEL.CONFIG_UPDATED, handleConfigUpdated);

    // ── 2. Try initial invoke with retry ──
    let cancelled = false;

    async function loadWithRetry() {
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        if (cancelled) return;

        const result = await tryLoadConfig(attempt);
        if (result) {
          if (!hasBootedRef.current) {
            hasBootedRef.current = true;
          }
          setConfig(result);
          return; // success
        }

        // If not last attempt, wait and retry
        if (attempt < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        }
      }

      // All retries exhausted — fall back to empty config
      console.warn('[BOOT] Frontend: No se pudo cargar configuración tras', MAX_RETRIES, 'intentos');
      setConfig(EMPTY_CONFIG);
    }

    loadWithRetry();

    return () => {
      cancelled = true;
      if (api) {
        api.removeListener('config:updated', handleConfigUpdated);
      }
    };
  }, [tryLoadConfig]);

  return (
    <ConfigContext.Provider value={{ config }}>
      {children}
    </ConfigContext.Provider>
  );
};
