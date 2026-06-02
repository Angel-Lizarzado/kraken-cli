// IPC Handlers: Sync DNS Operations
// module:clear-results, syncdns:run-batch

const { getAppStateManager } = require('../state/AppStateManager');
const { getStandardEmitter } = require('../../services/standard-emitter');
const { verifyKillSwitch } = require('../utils/security');
const { getWorkspaceManager } = require('../../services/workspace-manager');
const { syncDomain } = require('../../infrastructure/sync-cloudflare');
const fs = require('fs/promises');
const { dialog } = require('electron');
const { parse } = require('csv-parse/sync');

const EMIT = getStandardEmitter('syncdns');
let isSyncing = false;

function registerSyncDnsHandlers(ipcMain, mainWindow, scope) {
  const { isOperationRunning } = scope;

  // Run batch Sync DNS
  ipcMain.removeHandler('syncdns:run-batch');
  ipcMain.handle('syncdns:run-batch', async (event, { accountName, cloudName, domains }) => {
    if (isSyncing || isOperationRunning.value) {
      return { success: false, error: '[COLA] Ya hay una operación en curso. Espere a que finalice.' };
    }
    isSyncing = true;
    isOperationRunning.value = true;

    try {
      await verifyKillSwitch();

      const appState = getAppStateManager();
      const workspaceManager = getWorkspaceManager();
      await workspaceManager.initialize();

      appState.resetModuleState('syncdns');

      appState.update('syncdns', {
        isRunning: true,
        currentDomain: '',
        currentProgress: 0,
        currentMessage: 'Preparando lote de sincronización DNS...',
        totalDomains: domains.length,
        currentIndex: 0,
        domainsQueue: domains,
        batchAccountName: accountName,
        batchCloudName: cloudName,
        results: domains.map(d => ({ domain: d, status: 'pending', message: 'En cola...' })),
      });

      EMIT.info(`Preparando lote de ${domains.length} dominios para Sync DNS...`);
      sendSyncDnsLog('Preparando lote de sincronización...', 'info');
      event.sender.send('syncdns:state-changed', appState.getState('syncdns'));
      await new Promise(r => setTimeout(r, 150));

      const batchResults = [];

      const updateDomainState = (domain, status, message, expirationDate) => {
        const st = appState.getState('syncdns');
        if (st && Array.isArray(st.results)) {
          const idx = st.results.findIndex(r => r.domain === domain);
          if (idx >= 0) {
            st.results[idx] = { domain, status, message, expirationDate };
          } else {
            st.results.push({ domain, status, message, expirationDate });
          }
          appState.update('syncdns', { results: st.results });
        }
        event.sender.send('syncdns:state-changed', appState.getState('syncdns'));
        event.sender.send('domain-process-result', { module: 'SYNCDNS', domain, status, message, expirationDate });
      };

      for (let i = 0; i < domains.length; i++) {
        const domain = domains[i];

        appState.update('syncdns', {
          currentDomain: domain,
          currentIndex: i,
          currentProgress: Math.round((i / domains.length) * 100),
          currentMessage: `[SYNC DNS] Iniciando: ${domain}`,
        });
        sendSyncDnsLog(`[SYNC DNS] Iniciando: ${domain}`, 'info');
        event.sender.send('syncdns:state-changed', appState.getState('syncdns'));

        updateDomainState(domain, 'processing', 'Sincronizando DNS...');

        try {
          const syncResult = await syncDomain(domain);
          
          if (!syncResult.success) {
            const err = new Error(syncResult.error);
            err.expirationDate = syncResult.expirationDate;
            throw err;
          }

          const successMsg = syncResult.message || 'Sincronización exitosa';
          sendSyncDnsLog(`[OK] ${domain}: ${successMsg}`, 'success');
          updateDomainState(domain, 'success', successMsg, syncResult.expirationDate);
          batchResults.push({ domain, success: true, expirationDate: syncResult.expirationDate });

          // Note: We don't mark extractionStatus='success' here, as this is just DNS sync.
          // But we could save a `dnsSyncStatus` in dominios_procesados.json in the future if needed.

        } catch (error) {
          console.error(`[SYNC DNS] Falló ${domain}:`, error.message);
          EMIT.error(`Falló ${domain}: ${error.message}`, domain);
          sendSyncDnsLog(`[ERROR] ${domain}: ${error.message}`, 'error');
          updateDomainState(domain, 'error', error.message, error.expirationDate || 'N/A');
          batchResults.push({ domain, success: false, error: error.message, expirationDate: error.expirationDate || 'N/A' });
        }

        event.sender.send('syncdns:state-changed', appState.getState('syncdns'));
      }

      appState.update('syncdns', {
        isRunning: false,
        currentDomain: '',
        currentProgress: 100,
        currentMessage: 'Sincronización masiva finalizada',
      });
      sendSyncDnsLog('Sincronización masiva finalizada', 'success');
      event.sender.send('syncdns:state-changed', appState.getState('syncdns'));

      const successCount = batchResults.filter(r => r.success).length;
      return {
        success: true,
        results: batchResults,
        total: batchResults.length,
        successCount,
        errors: batchResults.length - successCount,
      };
    } catch (error) {
      console.error('[ERROR] Batch de Sync DNS falló:', error.message);
      EMIT.error(`Batch de Sync DNS falló: ${error.message}`);
      getAppStateManager().update('syncdns', { isRunning: false });
      event.sender.send('syncdns:state-changed', getAppStateManager().getState('syncdns'));
      return { success: false, error: error.message };
    } finally {
      isSyncing = false;
      isOperationRunning.value = false;
    }
  });

  function sendSyncDnsLog(message, type = 'info') {
    const appState = getAppStateManager();
    if (!message) return;
    const state = appState.getState('syncdns');
    const logs = state.recentLogs || [];
    logs.push({ message, timestamp: Date.now() });
    if (logs.length > 50) logs.shift();
    appState.update('syncdns', { recentLogs: logs });

    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('syncdns:log', { message, type, timestamp: Date.now() });
    }
  }
  function normalizeHeader(value) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
  }

  function findBestColumn(headers, candidates) {
    const normalizedMap = new Map(headers.map(h => [h, normalizeHeader(h)]));
    for (const candidate of candidates) {
      const found = headers.find(h => normalizedMap.get(h) === candidate);
      if (found) return found;
    }
    for (const candidate of candidates) {
      const found = headers.find(h => normalizedMap.get(h).includes(candidate));
      if (found) return found;
    }
    return null;
  }

  function normalizeDomain(value) {
    return String(value || '').trim().toLowerCase()
      .replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  }

  ipcMain.removeHandler('syncdns:load-csv');
  ipcMain.handle('syncdns:load-csv', async (event) => {
    try {
      const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
        title: 'Seleccionar archivo CSV de DonDominio',
        filters: [{ name: 'CSV Files', extensions: ['csv'] }],
        properties: ['openFile']
      });

      if (canceled || filePaths.length === 0) {
        return { success: true, canceled: true };
      }

      const raw = await fs.readFile(filePaths[0], 'utf8');
      const records = parse(raw, {
        columns: true,
        skip_empty_lines: true,
        relax_column_count: true,
        bom: true,
        delimiter: [',', ';'] // auto-detect
      });

      if (!records.length) {
        return { success: false, error: 'El archivo CSV está vacío.' };
      }

      const headers = Object.keys(records[0] || {});
      const domainColumn = findBestColumn(headers, [
        'domain', 'dominio', 'nombre_dominio', 'domain_name', 'host', 'name'
      ]);

      const expiryColumn = findBestColumn(headers, [
        'expiry_date', 'expiration_date', 'expire_date', 'fecha_caducidad',
        'fecha_expiracion', 'caducidad', 'expiracion', 'vencimiento',
        'renewal_date', 'expires', 'expiry', 'expiration'
      ]);

      if (!domainColumn || !expiryColumn) {
        return { success: false, error: 'No se encontraron las columnas de Dominio y Expiración en el CSV.' };
      }

      const parsedDates = {};
      let count = 0;

      for (const row of records) {
        const domain = normalizeDomain(row[domainColumn]);
        if (!domain) continue;
        const expiration = String(row[expiryColumn] || '').trim();
        parsedDates[domain] = expiration;
        count++;
      }

      return { success: true, count, dates: parsedDates };

    } catch (error) {
      console.error('[ERROR] Error procesando CSV:', error);
      return { success: false, error: error.message };
    }
  });
}

module.exports = { registerSyncDnsHandlers };
