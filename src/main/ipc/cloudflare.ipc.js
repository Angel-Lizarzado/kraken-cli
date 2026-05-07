// IPC Handlers: Cloudflare DNS Operations
// cloudflare:get-zones, cloudflare:sync-domains, get-cloudflare-status
// module:get-status (cloudflare case)

const { getCloudflareApiService } = require('../../services/cloudflare-api-service');
const { getConfigManager } = require('../../services/config-manager');
const { getWorkspaceManager } = require('../../services/workspace-manager');
const { getAppStateManager } = require('../state/AppStateManager');
const { getStandardEmitter } = require('../../services/standard-emitter');
const { verifyKillSwitch } = require('../utils/security');
const { sanitizeDomain, sanitizeDomainList } = require('./ipc-validators');

const EMIT = getStandardEmitter('cloudflare');

function registerCloudflareHandlers(ipcMain, mainWindow, scope) {
  const { isOperationRunning } = scope;

  // Get current cloudflare state
  ipcMain.handle('get-cloudflare-status', async () => {
    return getAppStateManager().getState('cloudflare');
  });

  // Cloudflare: list zones and their A records
  ipcMain.handle('cloudflare:get-zones', async (event, { domains, accountName, cloudName }) => {
    try {
      // Sanitizar lista completa antes de cualquier operación de red.
      // Dominios inválidos se descartan con log; si la lista queda vacía, retorna error.
      const cleanDomains = sanitizeDomainList(domains, (msg) => console.warn('[Cloudflare:get-zones]', msg));
      if (cleanDomains.length === 0) {
        return { success: false, error: 'La lista de dominios está vacía o contiene entradas inválidas.' };
      }

      const cloudflareApiService = getCloudflareApiService();
      const configManager = getConfigManager();
      await configManager.initialize();
      await cloudflareApiService.initialize();

      const workspaceManager = getWorkspaceManager();
      await workspaceManager.initialize();

      const results = [];
      for (const domain of cleanDomains) {
        try {
          const zone = await cloudflareApiService.getOrCreateZone(domain);
          const records = await cloudflareApiService.getDnsRecords(zone.id);
          const aRecord = records.find(r => r.type === 'A' && r.name === domain);
          const cnameRecord = records.find(r => r.type === 'CNAME' && r.name === 'www.' + domain);
          let lastCloudflareSync = null;
          if (accountName && cloudName) {
            try {
              const dominios = await workspaceManager.getDominiosProcesados(accountName, cloudName);
              const foundEntry = dominios.find(d => {
                const dName = typeof d === 'string' ? d : (d.dominio || d.name || '');
                return dName === domain;
              });
              if (foundEntry && typeof foundEntry === 'object' && foundEntry.lastCloudflareSync) {
                lastCloudflareSync = foundEntry.lastCloudflareSync;
              }
            } catch (e) {
              // Silently fail
            }
          }
          results.push({
            domain: domain,
            zoneName: zone.name,
            zoneStatus: zone.status,
            aRecord: aRecord ? { ip: aRecord.content, proxied: aRecord.proxied, ttl: aRecord.ttl } : null,
            cnameRecord: cnameRecord ? { target: cnameRecord.content, proxied: cnameRecord.proxied } : null,
            lastCloudflareSync: lastCloudflareSync,
          });
        } catch (domainError) {
          results.push({ domain: domain, zoneName: null, zoneStatus: 'error', aRecord: null, cnameRecord: null, error: domainError.message });
        }
      }
      return { success: true, zones: results };
    } catch (error) {
      console.error('Cloudflare get zones failed:', error);
      return { success: false, error: error.message };
    }
  });

  // Cloudflare Bulk DNS Sync
  // NOTA: Usamos ipcMain.on (NO handle) porque esta operación emite streaming
  // de eventos (sync:domain-start, sync:domain-progress, cloudflare:log, state:update).
  // ipcMain.handle + streaming interno causa deadlock en Electron.
  ipcMain.on('cloudflare:sync-domains', async (event, { domains, pleskIp, accountName, cloudName }) => {
    if (isOperationRunning.value) {
      event.sender.send('cloudflare:sync-error', { error: '[COLA] Ya hay una operacion en curso. Espere a que finalice.' });
      return;
    }

    // Sanitizar antes de marcar operación como running para no bloquear el semáforo.
    const cleanDomains = sanitizeDomainList(domains, (msg) => console.warn('[Cloudflare:sync]', msg));
    if (cleanDomains.length === 0) {
      event.sender.send('cloudflare:sync-error', { error: 'La lista de dominios está vacía o contiene entradas inválidas.' });
      return;
    }

    isOperationRunning.value = true;

    try {
      await verifyKillSwitch();

      const cloudflareApiService = getCloudflareApiService();
      const configManager = getConfigManager();
      await configManager.initialize();
      await cloudflareApiService.initialize();
      const workspaceManager = getWorkspaceManager();
      await workspaceManager.initialize();

      const appState = getAppStateManager();

      // RESET antes de correr — evita acumulación de resultados/logs de corridas anteriores
      appState.resetModuleState('cloudflare');

      appState.update('cloudflare', {
        isRunning: true,
        currentDomain: '',
        currentProgress: 0,
        currentMessage: 'Preparando sincronizacion DNS...',
        totalDomains: cleanDomains.length,
        currentIndex: 0,
        domainsQueue: cleanDomains,
      });

      EMIT.info(`Procesando ${cleanDomains.length} dominios...`);
      sendCloudflareLog(`Procesando ${cleanDomains.length} dominios...`, 'info');

      appState.update('cloudflare', {
        results: cleanDomains.map(d => ({ domain: d, status: 'pending', message: 'En cola...' })),
      });
      event.sender.send('cloudflare:state-changed', appState.getState('cloudflare'));
      await new Promise(r => setTimeout(r, 150));

      // ── Secuencial estricto: un dominio a la vez ──
      for (let i = 0; i < cleanDomains.length; i++) {
        const domain = cleanDomains[i];

        if (mainWindow && mainWindow.webContents) {
          mainWindow.webContents.send('sync:domain-start', { phase: 'dns', domain });
        }

        appState.update('cloudflare', {
          currentDomain: domain,
          currentIndex: i,
          currentMessage: '[DNS] Sincronizando: ' + domain,
        });

        const logCallback = (message, type) => sendCloudflareLog(message, type);
        const stateCallback = (stateOverrides) => {
          if (stateOverrides) {
            const current = appState.getState('cloudflare');
            appState.update('cloudflare', Object.assign({}, current, stateOverrides));
          }
          event.sender.send('cloudflare:state-changed', appState.getState('cloudflare'));
        };

        try {
          const result = await cloudflareApiService.syncSingleDomain(domain, pleskIp, {
            sendLog: logCallback,
            sendStateChanged: stateCallback,
          });

          if (result.success) {
            const currentState = appState.getState('cloudflare');
            const existingIdx = currentState.results.findIndex(r => r.domain === domain);
            const entry = { domain, status: 'success', message: 'DNS sincronizado correctamente' };
            if (existingIdx >= 0) {
              currentState.results[existingIdx] = entry;
            } else {
              currentState.results.push(entry);
            }
            appState.update('cloudflare', { results: currentState.results });
            sendCloudflareLog('[OK] ' + domain + ': DNS sincronizado correctamente', 'success');
            if (accountName && cloudName) {
              await workspaceManager.setCloudflareSyncTimestamp(accountName, cloudName, domain).catch(err => {
                console.warn('[DNS] Failed to persist timestamp for ' + domain + ':', err.message);
              });
            }
          } else {
            const currentState = appState.getState('cloudflare');
            const existingIdx = currentState.results.findIndex(r => r.domain === domain);
            const entry = { domain, status: 'error', message: result.error || 'Error desconocido' };
            if (existingIdx >= 0) {
              currentState.results[existingIdx] = entry;
            } else {
              currentState.results.push(entry);
            }
            appState.update('cloudflare', { results: currentState.results });
            sendCloudflareLog('[ERROR] ' + domain + ': ' + (result.error || 'Error desconocido'), 'error');
          }
        } catch (error) {
          console.error('[DNS] Fallo ' + domain + ':', error.message);
          const currentState = appState.getState('cloudflare');
          const existingIdx = currentState.results.findIndex(r => r.domain === domain);
          const entry = { domain, status: 'error', message: error.message };
          if (existingIdx >= 0) {
            currentState.results[existingIdx] = entry;
          } else {
            currentState.results.push(entry);
          }
          appState.update('cloudflare', { results: currentState.results });
          sendCloudflareLog('[ERROR] ' + domain + ': ' + error.message, 'error');
        }

        const cfState = appState.getState('cloudflare');
        const lastEntry = cfState.results[cfState.results.length - 1];
        if (mainWindow && mainWindow.webContents) {
          mainWindow.webContents.send('sync:domain-progress', {
            phase: 'dns',
            domain: lastEntry.domain,
            status: lastEntry.status,
            message: lastEntry.message,
          });
          mainWindow.webContents.send('domain-process-result', {
            module: 'DNS',
            domain: lastEntry.domain,
            status: lastEntry.status,
            message: lastEntry.message,
          });
        }

        appState.update('cloudflare', {
          currentProgress: Math.round(((i + 1) / cleanDomains.length) * 100),
        });
        event.sender.send('cloudflare:state-changed', appState.getState('cloudflare'));

        // Check cancellation
        if (!appState.getState('cloudflare').isRunning && isOperationRunning.value === false) {
          sendCloudflareLog('[CANCELADO] Sincronización DNS detenida por el usuario', 'warning');
          break;
        }
      }

      appState.update('cloudflare', {
        isRunning: false,
        currentProgress: 100,
        currentMessage: 'Sincronizacion DNS finalizada',
      });
      EMIT.success('Sincronización DNS finalizada');
      sendCloudflareLog('Sincronizacion DNS finalizada', 'success');
      event.sender.send('cloudflare:state-changed', appState.getState('cloudflare'));
      event.sender.send('cloudflare:sync-completed', { success: true, finished: true });
    } catch (error) {
      console.error('[ERROR] Sincronizacion DNS fallo:', error.message);
      EMIT.error(`Sincronización falló: ${error.message}`);
      sendCloudflareLog('[ERROR] ' + error.message, 'error');
      getAppStateManager().update('cloudflare', { isRunning: false });
      event.sender.send('cloudflare:state-changed', getAppStateManager().getState('cloudflare'));
      event.sender.send('cloudflare:sync-completed', { success: false, error: error.message });
    } finally {
      isOperationRunning.value = false;
    }
  });

  // Clean AAAA (IPv6) records for given domains
  // 🔥 v1.8.2: Limpieza de AAAA + desactivación IPv6 en Cloudflare
  ipcMain.handle('cloudflare:clean-aaaa', async (event, { domains }) => {
    try {
      const cleanDomains = sanitizeDomainList(domains, (msg) => console.warn('[Cloudflare:clean-aaaa]', msg));
      if (cleanDomains.length === 0) {
        return { success: false, error: 'La lista de dominios está vacía o contiene entradas inválidas.' };
      }

      const cloudflareApiService = getCloudflareApiService();
      const configManager = getConfigManager();
      await configManager.initialize();
      await cloudflareApiService.initialize();

      let cleaned = 0;
      let ipv6DisabledCount = 0;
      let skipped = 0;
      const errors = [];

      for (const domain of cleanDomains) {
        try {
          const result = await Promise.race([
            (async () => {
              const zone = await cloudflareApiService.getOrCreateZone(domain);
              if (!zone || !zone.id) { skipped++; return; }

              // Usar el nuevo método que limpia AAAA + desactiva IPv6
              const cleanResult = await cloudflareApiService.cleanAaaaRecords(zone.id);
              cleaned += cleanResult.aaaaDeleted;
              if (cleanResult.ipv6Disabled) ipv6DisabledCount++;
              if (cleanResult.aaaaDeleted === 0) skipped++;
            })(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout 10s')), 10000)),
          ]);
        } catch (err) {
          errors.push(`${domain}: ${err.message}`);
        }
      }

      return {
        success: true,
        cleaned,
        ipv6Disabled: ipv6DisabledCount,
        skipped,
        errors: errors.length > 0 ? errors : undefined,
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Cloudflare log helper
  function sendCloudflareLog(message, type) {
    if (type === undefined) type = 'info';
    const appState = getAppStateManager();
    if (!message) return;
    const state = appState.getState('cloudflare');
    const logs = state.recentLogs || [];
    logs.push({ message: message, timestamp: Date.now() });
    if (logs.length > 50) logs.shift();
    appState.update('cloudflare', { recentLogs: logs });

    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('cloudflare:log', { message: message, type: type, timestamp: Date.now() });
    }
  }
}

module.exports = { registerCloudflareHandlers };
