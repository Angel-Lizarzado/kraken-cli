const { contextBridge, ipcRenderer } = require('electron');

// ── Canal whitelists (single source of truth) ──
const SEND_CHANNELS = [
  'module:execute',
  'module:cancel',
  'config:save',
  'config:load',
  'server:maintenance',
  'progress:subscribe',
  'progress:unsubscribe',
  'cloudflare:sync-domains',
  'plesk:install-ssl',
  'plesk:provision-domain',
  // ── Auto-updater commands (renderer → main) ──
  'updater:quit-and-install',
  'updater:check-manually',
  // ── App lifecycle ──
  'app:frontend-ready',
];

const RECEIVE_CHANNELS = [
  'state:update',
  'app:state-update',
  'cloudflare:log',
  'cloudflare:state-changed',
  'deployment:log',
  'deployment:state-changed',
  'migrate-domain-start',
  'migrate-domain-success',
  'migrate-domain-error',
  'migrate-domain-warning',
  'module:progress',
  'module:completed',
  'module:error',
  'config:loaded',
  'config:saved',
  'config:updated',
  'ssh:key-injected',
  'server:maintenance-completed',
  'workspace:scanned',
  'progress:update',
  'extraction:state-changed',
  'extraction:log',
  'ssl:log',
  'ssl:state-changed',
  'sync:domain-start',
  'sync:domain-progress',
  'provisioning:state-changed',
  'provisioning:log',
  'provisioning:sync-error',
  'cloudflare:sync-completed',
  'cloudflare:sync-error',
  'ssl:sync-completed',
  'ssl:sync-error',
  'syncdns:state-changed',
  'syncdns:log',
  'log:batch',
  'scanner:clean-progress',
  'health:progress',
  'domain-process-result',
  // ── Auto-updater events (main → renderer) ──
  'updater:checking',
  'updater:update-available',
  'updater:download-progress',
  'updater:update-downloaded',
  'updater:not-available',
  'updater:error',
  // ── ScalifyLabs: progreso en tiempo real (main → renderer) ──
  'scalify:progreso',
  // ── Command Center & Fleet ──
  'server:metrics-update',
  'fleet:health-progress',
  'fleet:domain-status',
  // ── CMS Reconstructor ──
  'cms:progress',
  'cms:audit-progress',
  // ── Rescue Sorter ──
  'rescuesorter:progress',
  // ── Security ──
  'security:credential-progress',
  // ── Drive ──
  'drive:sync-complete',
  'drive:log',
  // ── Email ──
  'email:log',
];

const INVOKE_CHANNELS = [
  'config:get',
  'config:validate',
  'workspace:get-structure',
  'workspace:create-domain-folder',
  'workspace:get-dominios-procesados',
  'workspace:update-dominios-procesados',
  'workspace:create-cloud-folder',
  'workspace:scan',
  'workspace:scan-domains',
  'module:get-status',
  'sourcesync:get-state',
  'sourcesync:deploy',
  'get-deployment-status',
  'get-cloudflare-status',
  'get-ssl-status',
  'get-extraction-status',
  'drive:stop-sync',
  'ssh:test-connection',
  'server:test-connection',
  'ssh:inject-key',
  'ssh:generate-key',
  'server:diagnostics',
  'cloudflare:get-zones',
  'cloudflare:clean-aaaa',
  'config:get-cloudflare-token',
  'config:set-cloudflare-token',
  'config:get-cloudflare-account-id',
  'config:set-cloudflare-account-id',
  'config:get-google-drive',
  'config:set-drive-root',
  'config:select-drive-credentials',
  'drive:start-sync',
  'drive:check-auth',
  'drive:start-auth',
  'drive:logout',
  // 'plesk:install-ssl' movido a SEND_CHANNELS (usa ipcMain.on, no handle)
  'extraction:check-status',
  'extraction:run-batch',
  'extraction:extract-ultra-lite',
  'deployment:check-status',
  'deployment:run-batch',
  'syncdns:run-batch',
  'syncdns:load-csv',
  'deployment:get-processed-list',
  'module:clear-results',
  'utils:lookup-host',
  'server:tail-log',
  'server:exec-command',
  'check-ssh-status',
  'server:check-connection',
  'shell:open-external',
  'deployment:progress',
  'log:get-recent',
  'logs:get-all',
  'scanner:run-audit',
  'scanner:run-clean',
  'scanner:run-harden',
  'scanner:init-pending',
  'scanner:finish',
  'purge-plesk-backups',
  'get-detailed-storage',
  'dialog:open-directory',
  'dialog:open-file',
  'workspace:set-path',
  'workspace:get-path',
  'server:delete',
  'app:get-version',
  'health:check-mass',
  'health:cancel',
  'config:get-ssl-email',
  'config:set-ssl-email',
  'correo:contrasena:guardar',
  'correo:contrasena:existe',
  'correo:contrasena:eliminar',
  // ── ScalifyLabs ──
  'scalify:deploy',
  'config:get-github-token',
  'config:set-github-token',
  // ── Command Center & Fleet ──
  'server:metrics-fetch',
  'server:metrics-start',
  'server:metrics-stop',
  'fleet:scan-health',
  'fleet:run-action',
  'fleet:get-log',
  'fleet:diagnose-site',
  'fleet:run-mitigation',
  // ── CMS Reconstructor ──
  'cms:get-state',
  'cms:audit-server',
  'cms:start-batch',
  'cms:abort',
  'reconstructor:obtener-versiones',
  // ── Rescue Sorter ──
  'rescuesorter:process',
  'rescuesorter:diet-mode',
  'rescuesorter:extract-massive-tar',
  'rescuesorter:cancel-massive-tar',
  // ── Extracción Ultra-Lite ──
  'extraction:extract-ultra-lite',
  // ── Elementor Pro ──
  'config:get-elementor-pro',
  'config:set-elementor-pro',
  // ── Server management ──
  'server:edit',
  'server:resolve-ip',
  // ── Security ──
  'security:validate-password',
  'security:reboot',
  'security:shutdown',
  'security:credential-reset',
  // ── Email / Hostinger Mail ──
  'email:get-config',
  'email:set-config',
  'email:download-domain',
  'email:download-batch',
  'email:restore-batch',
];

// ── Helper: typed invoke with whitelist validation ──
function safeInvoke(channel, data) {
  if (INVOKE_CHANNELS.includes(channel)) {
    return ipcRenderer.invoke(channel, data);
  }
  console.warn(`Attempted to invoke on invalid channel: ${channel}`);
  return Promise.reject(new Error(`Invalid channel: ${channel}`));
}

// ── Helper: safe receive with cleanup return ──
function safeReceive(channel, cb) {
  if (RECEIVE_CHANNELS.includes(channel)) {
    const handler = (_event, ...args) => cb(...args);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  }
  console.warn(`Attempted to receive on invalid channel: ${channel}`);
  return () => { };
}

// ── Expose legacy window.api (backward compatible) ──
contextBridge.exposeInMainWorld('api', {
  // Send methods (renderer → main)
  send: (channel, data) => {
    if (SEND_CHANNELS.includes(channel)) {
      ipcRenderer.send(channel, data);
    } else {
      console.warn(`Attempted to send on invalid channel: ${channel}`);
    }
  },

  // Receive methods (main → renderer)
  receive: (channel, func) => {
    if (RECEIVE_CHANNELS.includes(channel)) {
      // Deliberately strip event as it includes `sender`
      const handler = (event, ...args) => func(...args);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    } else {
      console.warn(`Attempted to receive on invalid channel: ${channel}`);
      return () => {};
    }
  },

  // Remove listener
  removeListener: (channel, func) => {
    if (RECEIVE_CHANNELS.includes(channel)) {
      ipcRenderer.removeListener(channel, func);
    } else {
      console.warn(`Attempted to remove listener from invalid channel: ${channel}`);
    }
  },

  // Remove all listeners for a channel
  removeAllListeners: (channel) => {
    if (RECEIVE_CHANNELS.includes(channel)) {
      ipcRenderer.removeAllListeners(channel);
    } else {
      console.warn(`Attempted to remove all listeners from invalid channel: ${channel}`);
    }
  },

  // Invoke methods (renderer → main → renderer with response)
  invoke: (channel, data) => {
    return safeInvoke(channel, data);
  }
});

// ── Expose typed window.electronAPI (preferred API) ──
contextBridge.exposeInMainWorld('electronAPI', {
  // ── State subscriptions ──
  /** Subscribe to full state updates from AppStateManager. Returns cleanup function. */
  onStateUpdate: (cb) => {
    return safeReceive('state:update', cb);
  },

  // ── Domain-specific queries ──
  /** Check if SSH connection is active. */
  checkSshStatus: () => {
    return safeInvoke('check-ssh-status');
  },

  /** Get current state for a specific module. */
  getModuleState: (moduleId) => {
    return safeInvoke('module:get-status', { moduleId });
  },

  /** Get full app config. */
  getConfig: () => {
    return safeInvoke('config:get');
  },

  /** Sync Cloudflare DNS records. */
  syncCloudflareDns: (params) => {
    return safeInvoke('cloudflare:sync-domains', params);
  },

  /** Install bulk SSL certificates via Plesk. */
  installBulkSsl: (params) => {
    return safeInvoke('plesk:install-ssl', params);
  },

  // ── Generic (for backward compat and untyped use) ──
  /** Get current app version. */
  getAppVersion: () => {
    return safeInvoke('app:get-version');
  },

  /** Signal main process that frontend listeners are ready. */
  notifyFrontendReady: () => {
    if (SEND_CHANNELS.includes('app:frontend-ready')) {
      ipcRenderer.send('app:frontend-ready');
    }
  },

  /** Trigger manual update check. */
  checkForUpdates: () => {
    if (SEND_CHANNELS.includes('updater:check-manually')) {
      ipcRenderer.send('updater:check-manually');
    }
  },

  /** Subscribe to any whitelisted receive channel. Returns cleanup function. */
  onEvent: (channel, cb) => {
    return safeReceive(channel, cb);
  },

  /** Generic invoke for untyped channels. */
  invoke: (channel, data) => {
    return safeInvoke(channel, data);
  }
});

// Log that preload script has loaded
console.log('Preload script loaded: window.api + window.electronAPI are available');