// IPC Handlers: Deployment Operations
// get-deployment-status, deployment:run-batch, deployment:check-status
// deployment:get-processed-list, module:get-status (deployment case)

const { getDeploymentService } = require('../../services/deployment-service');
const { getProgressEmitter } = require('../../services/progress-emitter');
const { getWorkspaceManager } = require('../../services/workspace-manager');
const { getConfigManager } = require('../../services/config-manager');
const { getSshService } = require('../../services/ssh-service');
const { getAppStateManager } = require('../state/AppStateManager');
const { getStandardEmitter } = require('../../services/standard-emitter');
const { verifyKillSwitch } = require('../utils/security');
const { sanitizeDomain, sanitizeDomainList } = require('./ipc-validators');

const EMIT = getStandardEmitter('deployment');

function registerDeploymentHandlers(ipcMain, mainWindow, scope) {
  const { isOperationRunning } = scope;

  // Get current deployment state (for UI restoration on mount)
  ipcMain.handle('get-deployment-status', async () => {
    return getAppStateManager().getState('deployment');
  });

  // Get processed domains list
  ipcMain.handle('deployment:get-processed-list', async (event, { accountName, cloudName }) => {
    try {
      const workspaceManager = getWorkspaceManager();
      await workspaceManager.initialize();
      const dominios = await workspaceManager.getDominiosProcesados(accountName, cloudName);

      const cloudPath = workspaceManager.getCloudPath(accountName, cloudName);
      const jsonPath = require('path').join(cloudPath, 'dominios_procesados.json');
      const fs = require('fs');

      return {
        success: true,
        dominios,
        _sourcePath: jsonPath,
        _fileExists: fs.existsSync(jsonPath),
      };
    } catch (error) {
      return { success: false, error: error.message, dominios: [] };
    }
  });

  // Run batch deployment
  ipcMain.handle('deployment:run-batch', async (event, { accountName, serverName, sourceAccount, sourceCloud, manualList, forceClean }) => {
    if (isOperationRunning.value) {
      return { success: false, error: '[COLA] Ya hay una operacion en curso. Espere a que finalice.' };
    }

    // Sanitizar la lista de dominios antes de iniciar.
    // manualList se pasa al deploymentService que interpola dominios en comandos SSH.
    const cleanList = sanitizeDomainList(manualList, (msg) => console.warn('[Deployment:run-batch]', msg));
    if (cleanList.length === 0) {
      return { success: false, error: 'La lista de dominios está vacía o contiene entradas inválidas.' };
    }

    isOperationRunning.value = true;

    try {
      // Dead Man's Switch: Fail-Close estricto
      await verifyKillSwitch();

      const deploymentService = getDeploymentService();
      const progressEmitter = getProgressEmitter();
      const appState = getAppStateManager();

      // RESET antes de correr — evita acumulación de resultados/logs de corridas anteriores
      appState.resetModuleState('deployment');

      appState.update('deployment', {
        isRunning: true,
        currentDomain: '',
        currentProgress: 0,
        currentMessage: 'Preparando lote de despliegue...',
        batchAccountName: accountName,
        batchServerName: serverName,
        sourceAccount: sourceAccount,
        sourceCloud: sourceCloud,
      });

      sendDeploymentLog('Preparando lote de despliegue...', 'info');
      event.sender.send('deployment:state-changed', appState.getState('deployment'));

      // Inyectar pending list en AppStateManager
      appState.update('deployment', {
        results: cleanList.map(d => ({ domain: d, status: 'pending', message: 'En cola...' })),
      });
      await new Promise(r => setTimeout(r, 150));

      const result = await deploymentService.deployBatch(
        accountName, serverName, sourceAccount, sourceCloud, 'deployment-batch-' + Date.now(), cleanList,
        (msg, type) => {
          sendDeploymentLog(msg, type);
          // Per-domain streaming: detect domain completion logs
          const okMatch = msg.match(/^\[OK\]\s+(.+?):/);
          const errMatch = msg.match(/^\[ERROR\]\s+(.+?):/);
          if (okMatch) {
            event.sender.send('domain-process-result', { module: 'MIGRATE', domain: okMatch[1], status: 'success', message: 'Despliegue completado' });
          } else if (errMatch) {
            const rest = msg.substring(msg.indexOf(':', msg.indexOf(']') + 1) + 1).trim();
            event.sender.send('domain-process-result', { module: 'MIGRATE', domain: errMatch[1], status: 'error', message: rest || 'Error durante el despliegue' });
          }
        },
        forceClean
      );

      // Map results to deployment state
      if (result.results) {
        const mappedResults = result.results.map(r => ({
          domain: r.domain,
          status: r.status,
          message: r.status === 'success' ? 'Despliegue completado' :
                   r.status === 'completed_with_warnings' ? (r.errorDetails || 'Completado con advertencias') :
                   (r.errorDetails || r.error || 'Error desconocido')
        }));
        appState.update('deployment', { results: mappedResults });
      }

      appState.update('deployment', {
        isRunning: false,
        currentMessage: 'Despliegue masivo finalizado',
      });
      sendDeploymentLog('Despliegue masivo finalizado', 'success');
      event.sender.send('deployment:state-changed', appState.getState('deployment'));

      return result;
    } catch (error) {
      console.error('[ERROR] Batch de despliegue fallo:', error.message);
      EMIT.error(`Despliegue falló: ${error.message}`);
      sendDeploymentLog('[ERROR] ' + error.message, 'error');
      getAppStateManager().update('deployment', { isRunning: false, currentMessage: 'Error: ' + error.message });
      event.sender.send('deployment:state-changed', getAppStateManager().getState('deployment'));
      return { success: false, error: error.message };
    } finally {
      isOperationRunning.value = false;
    }
  });

  // Check deployment status for a domain
  ipcMain.handle('deployment:check-status', async (event, { accountName, serverName, domain }) => {
    try {
      // Sanitizar domain antes de interpolarlo en el comando SSH.
      // Sin esto: 'plesk bin domain --info evil.com; rm -rf /' es RCE directo.
      let cleanDomain;
      try {
        cleanDomain = sanitizeDomain(domain);
      } catch (validationError) {
        return { success: false, error: `Dominio inválido: ${validationError.message}`, status: null };
      }

      const sshService = getSshService();
      const configManager = getConfigManager();
      await configManager.initialize();

      const config = configManager.getConfig();
      const serverConfig = config.destinationServers?.find(s => s.name === serverName);
      if (!serverConfig) throw new Error('Server "' + serverName + '" not found');

      const client = await sshService.connect(serverConfig.sshCredentials, 'check-deploy-' + Date.now());
      try {
        const checkResult = await sshService.executeCommand(
          client,
          'plesk bin domain --info ' + cleanDomain + ' 2>/dev/null || echo "DOMAIN_NOT_FOUND"'
        );

        const domainExists = !checkResult.stdout.includes('DOMAIN_NOT_FOUND');

        return {
          success: true,
          status: {
            deployed: domainExists,
            domainExists: domainExists,
            documentRoot: domainExists ? '/var/www/vhosts/' + cleanDomain + '/httpdocs' : null
          }
        };
      } finally {
        await sshService.disconnect(client);
      }
    } catch (error) {
      console.error('Failed to check deployment status:', error);
      return { success: false, error: error.message, status: null };
    }
  });

  // Deployment log helper
  function sendDeploymentLog(message, type) {
    if (type === undefined) type = 'info';
    const appState = getAppStateManager();
    if (!message) return;
    const state = appState.getState('deployment');
    const logs = state.recentLogs || [];
    const isUpload = message.startsWith('Subiendo:');
    if (isUpload) {
      let replaced = false;
      for (let i = logs.length - 1; i >= 0; i--) {
        if (logs[i].message.startsWith('Subiendo:')) {
          logs[i] = { message: message, timestamp: Date.now() };
          replaced = true;
          break;
        }
      }
      if (!replaced) {
        logs.push({ message: message, timestamp: Date.now() });
      }
    } else {
      logs.push({ message: message, timestamp: Date.now() });
    }
    if (logs.length > 50) logs.shift();
    appState.update('deployment', { recentLogs: logs });

    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('deployment:log', { message: message, type: type, timestamp: Date.now() });
    }
  }
}

module.exports = { registerDeploymentHandlers };
