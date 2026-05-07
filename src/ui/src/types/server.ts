import type { SshCredentials } from './ssh';

// ── Branded ID ──
export type ServerId = string & { readonly __brand: 'ServerId' };

// ── Status ──
export const SERVER_STATUS = {
  ONLINE: 'online',
  OFFLINE: 'offline',
  UNKNOWN: 'unknown',
} as const;

export type ServerStatus = (typeof SERVER_STATUS)[keyof typeof SERVER_STATUS];

// ── Diagnostics ──
export interface RamInfo {
  used: number;
  total: number;
  percent: number;
}

export interface DiskInfo {
  used: number;
  total: number;
  percent: number;
}

export interface CpuInfo {
  load: number;
  cores: number;
}

export interface ServerDiagnostics {
  ram: RamInfo;
  disk: DiskInfo;
  cpu: CpuInfo;
  uptime: string;
}

// ── Server ──
export const SERVER_TYPE = {
  PLESK: 'plesk',
  HOSTINGER: 'hostinger',
  OTHER: 'other',
} as const;

export type ServerType = (typeof SERVER_TYPE)[keyof typeof SERVER_TYPE];

export interface Server {
  name: string;
  type: ServerType;
  isLinked: boolean;
  sshCredentials: SshCredentials;
  pleskCliPath?: string;
  status: ServerStatus;
  diagnostics?: ServerDiagnostics;
}

// ── Quick actions ──
export const MAINTENANCE_ACTION = {
  CLEAR_CACHE: 'clear-cache',
  RESTART: 'restart',
  SHUTDOWN: 'shutdown',
} as const;

export type MaintenanceAction = (typeof MAINTENANCE_ACTION)[keyof typeof MAINTENANCE_ACTION];

// ── Quick action commands ──
export interface QuickAction {
  label: string;
  command: string;
}

export const QUICK_ACTIONS: readonly QuickAction[] = [
  { label: 'Limpiar Caché RAM', command: 'sync; echo 3 > /proc/sys/vm/drop_caches' },
  { label: 'Reiniciar PHP', command: 'plesk sbin servicemng --restart --services=php-fpm' },
  { label: 'Reiniciar Nginx', command: 'plesk sbin servicemng --restart --services=nginx' },
] as const;
