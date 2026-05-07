// IPC Handlers: Extraction Operations
// get-extraction-status, module:clear-results, extraction:run-batch, extraction:check-status
// module:get-status (extraction case)

const { getExtractionService } = require('../../services/extraction-service');
const { getProgressEmitter } = require('../../services/progress-emitter');
const { getWorkspaceManager } = require('../../services/workspace-manager');
const { getAppStateManager } = require('../state/AppStateManager');
const { getConfigManager } = require('../../services/config-manager');
const { getStandardEmitter } = require('../../services/standard-emitter');
const { verifyKillSwitch } = require('../utils/security');

const EMIT = getStandardEmitter('extraction');

function registerExtractionHandlers(ipcMain, mainWindow, scope) {
  const { isOperationRunning } = scope;

  // Get current extraction state (for UI restoration on mount)
  ipcMain.handle('get-extraction-status', async () => {
    return getAppStateManager().getState('extraction');
  });

  // Clear extraction results
  ipcMain.handle('module:clear-results', async () => {
    const appState = getAppStateManager();
    const state = appState.getState('extraction');
    state.results = [];
    appState.update('extraction', { results: [] });
    return { success: true };
  });

  // Run batch extraction
  ipcMain.handle('extraction:run-batch', async (event, { accountName, cloudName, domains }) => {
    if (isOperationRunning.value) {
      return { success: false, error: '[COLA] Ya hay una operación en curso. Espere a que finalice.' };
    }
    isOperationRunning.value = true;

    try {
      // ── Dead Man's Switch: Fail-Close estricto ──
      await verifyKillSwitch();

      const extractionService = getExtractionService();
      const progressEmitter = getProgressEmitter();
      const appState = getAppStateManager();

      // RESET antes de correr — evita acumulación de resultados/logs de corridas anteriores
      appState.resetModuleState('extraction');

      appState.update('extraction', {
        isRunning: true,
        currentDomain: '',
        currentProgress: 0,
        currentMessage: 'Preparando lote de extracción...',
        totalDomains: domains.length,
        currentIndex: 0,
        domainsQueue: domains,
        batchAccountName: accountName,
        batchCloudName: cloudName,
      });

      EMIT.info(`Preparando lote de ${domains.length} dominios...`);
    sendExtractionLog('Preparando lote de extracción...', 'info');

      // ── Inyectar pending list en AppStateManager ──
      appState.update('extraction', {
        results: domains.map(d => ({ domain: d, status: 'pending', message: 'En cola...' })),
      });
      event.sender.send('extraction:state-changed', appState.getState('extraction'));
      await new Promise(r => setTimeout(r, 150));

      const batchResults = [];

      for (let i = 0; i < domains.length; i++) {
        const domain = domains[i];

        appState.update('extraction', {
          currentDomain: domain,
          currentIndex: i,
          currentProgress: Math.round((i / domains.length) * 100),
          currentMessage: `[EXTRACCIÓN] Iniciando: ${domain}`,
        });
        sendExtractionLog(`[EXTRACCIÓN] Iniciando: ${domain}`, 'info');
        event.sender.send('extraction:state-changed', appState.getState('extraction'));

        const taskId = progressEmitter.createTask('extraction', domain, `[EXTRACCIÓN] Iniciando: ${domain}`);

        const progressHandler = (progressData) => {
          if (progressData.domain === domain) {
            appState.update('extraction', {
              currentProgress: progressData.progress ?? 0,
              currentMessage: progressData.message || '',
            });
            sendExtractionLog(progressData.message || '', progressData.progress === 100 ? 'success' : 'info');
            event.sender.send('extraction:state-changed', appState.getState('extraction'));
          }
        };

        progressEmitter.on('progress', progressHandler);

        try {
          const result = await extractionService.extractWordPress(accountName, cloudName, domain, taskId);
          batchResults.push({ domain, success: true, result });

          const state = appState.getState('extraction');
          state.results.push({ domain, status: 'success', message: 'Extracción completada' });
          appState.update('extraction', { results: state.results });
          sendExtractionLog(`[OK] ${domain}: Extracción completada`, 'success');
          event.sender.send('domain-process-result', { module: 'EXTRACT', domain, status: 'success', message: 'Extracción completada' });
        } catch (error) {
          console.error(`[EXTRACCIÓN] Falló ${domain}:`, error.message);
          EMIT.error(`Falló ${domain}: ${error.message}`, domain);
          batchResults.push({ domain, success: false, error: error.message });

          const state = appState.getState('extraction');
          state.results.push({ domain, status: 'error', message: error.message });
          appState.update('extraction', { results: state.results });
          sendExtractionLog(`[ERROR] ${domain}: ${error.message}`, 'error');
          event.sender.send('domain-process-result', { module: 'EXTRACT', domain, status: 'error', message: error.message });
        } finally {
          progressEmitter.off('progress', progressHandler);
        }

        event.sender.send('extraction:state-changed', appState.getState('extraction'));
      }

      appState.update('extraction', {
        isRunning: false,
        currentProgress: 100,
        currentMessage: 'Extracción masiva finalizada',
      });
      sendExtractionLog('Extracción masiva finalizada', 'success');
      event.sender.send('extraction:state-changed', appState.getState('extraction'));

      const successCount = batchResults.filter(r => r.success).length;
      return {
        success: true,
        results: batchResults,
        total: batchResults.length,
        successCount,
        errors: batchResults.length - successCount,
      };
    } catch (error) {
      console.error('[ERROR] Batch de extracción falló:', error.message);
      EMIT.error(`Batch de extracción falló: ${error.message}`);
      getAppStateManager().update('extraction', { isRunning: false });
      event.sender.send('extraction:state-changed', getAppStateManager().getState('extraction'));
      return { success: false, error: error.message };
    } finally {
      isOperationRunning.value = false;
    }
  });

  // Check extraction status for a domain
  ipcMain.handle('extraction:check-status', async (event, { accountName, cloudName, domain }) => {
    try {
      const workspaceManager = getWorkspaceManager();
      await workspaceManager.initialize();
      const status = await workspaceManager.checkExtractionStatus(accountName, cloudName, domain);
      return { success: true, status };
    } catch (error) {
      console.error('Failed to check extraction status:', error);
      return { success: false, error: error.message };
    }
  });

  // Extract-specific log helpers
  function sendExtractionLog(message, type = 'info') {
    const appState = getAppStateManager();
    if (!message) return;
    const state = appState.getState('extraction');
    const logs = state.recentLogs || [];
    const isDownload = message.startsWith('Descargando:');
    if (isDownload) {
      let replaced = false;
      for (let i = logs.length - 1; i >= 0; i--) {
        if (logs[i].message.startsWith('Descargando:')) {
          logs[i] = { message, timestamp: Date.now() };
          replaced = true;
          break;
        }
      }
      if (!replaced) {
        logs.push({ message, timestamp: Date.now() });
      }
    } else {
      logs.push({ message, timestamp: Date.now() });
    }
    if (logs.length > 50) logs.shift();
    appState.update('extraction', { recentLogs: logs });

    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('extraction:log', { message, type, timestamp: Date.now() });
    }
  }
}

module.exports = { registerExtractionHandlers };
