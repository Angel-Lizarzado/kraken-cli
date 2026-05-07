// ── Progress Event ──
export interface ProgressEvent {
  module: string;
  domain: string;
  progress: number;
  message: string;
  timestamp: string;
  taskId?: string;
}

// ── Module Execution ──
export const MODULE_ID = {
  EXTRACTION: 'extraction',
  DEPLOYMENT: 'deployment',
} as const;

export type ModuleId = (typeof MODULE_ID)[keyof typeof MODULE_ID];

export interface ModuleExecutionOptions {
  moduleId: ModuleId;
  domain: string;
  options: {
    accountName?: string;
    cloudName?: string;
    serverName?: string;
    sourceAccount?: string;
    sourceCloud?: string;
    deploymentOptions?: Record<string, unknown>;
  };
}

// ── Module state ──
export interface ModuleState {
  isRunning: boolean;
  currentDomain: string;
  currentProgress: number;
  currentMessage: string;
  totalDomains: number;
  currentIndex: number;
}
