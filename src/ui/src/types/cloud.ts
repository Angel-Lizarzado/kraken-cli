import type { SshCredentials } from './ssh';

// ── Cloud ──
export const CLOUD_TYPE = {
  HOSTINGER: 'hostinger',
  OTHER: 'other',
} as const;

export type CloudType = (typeof CLOUD_TYPE)[keyof typeof CLOUD_TYPE];

export interface Cloud {
  name: string;
  type: CloudType;
  isLinked: boolean;
  sshCredentials: SshCredentials;
}

export interface Account {
  name: string;
  originClouds: Cloud[];
}
