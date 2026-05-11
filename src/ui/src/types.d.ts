// Legacy type declarations for Electron API — new types are in types/
import type { IpcApi } from './types/ipc';

// ── Typed electronAPI (preferred bridge) ──
export interface ElectronApi {
  onStateUpdate: (cb: (state: unknown) => void) => () => void;
  checkSshStatus: () => Promise<{
    connected: boolean;
    serverId: string | null;
    serverName: string | null;
  }>;
  getModuleState: (moduleId: string) => Promise<unknown>;
  getConfig: () => Promise<unknown>;
  syncCloudflareDns: (params: {
    domains: string[];
    pleskIp: string;
    accountName?: string;
    cloudName?: string;
  }) => Promise<{ success: boolean; results?: Array<{ domain: string; success: boolean }>; error?: string }>;
  installBulkSsl: (params: {
    accountName: string;
    serverName: string;
    domains: string[];
    options?: { email?: string; webroot?: string };
  }) => Promise<unknown>;
  onEvent: (channel: string, cb: (...args: unknown[]) => void) => () => void;
  invoke: (channel: string, data?: unknown) => Promise<unknown>;
  getAppVersion: () => Promise<string>;
  notifyFrontendReady: () => void;
  checkForUpdates: () => void;
}

declare global {
  interface Window {
    api: IpcApi;
    electronAPI?: ElectronApi;
  }
}

export {};
