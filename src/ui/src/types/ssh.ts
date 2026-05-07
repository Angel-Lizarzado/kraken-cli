// ── SSH Credentials ──
export interface SshCredentials {
  host: string;
  port: number;
  username: string;
  privateKey?: string;
}

// ── SSH Key injection ──
export interface SshKeyResult {
  success: boolean;
  error?: string;
}

export interface SshConnectionTestResult {
  success: boolean;
  connected: boolean;
  error?: string;
}

export interface ServerCommandResult {
  success: boolean;
  stdout?: string;
  stderr?: string;
  error?: string;
}

export interface TailLogResult {
  success: boolean;
  log?: string;
  error?: string;
}
