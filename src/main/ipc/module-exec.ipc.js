// IPC Handlers: Module Execution (shared infrastructure)
// module:execute (both extraction and deployment), module:cancel
// Handles the operation lock and progress emitter lifecycle

const { getProgressEmitter } = require('../../services/progress-emitter');
const { getAppStateManager } = require('../state/AppStateManager');

function registerModuleExecHandlers(ipcMain, mainWindow, scope) {
  const { isOperationRunning } = scope;

  // Helper: execute extraction
  const executeExtraction = async (domain, options, taskId, scopeRef) => {
    const { getExtractionService } = require('../../services/extraction-service');
    const extractionService = getExtractionService();

    if (!options.accountName || !options.cloudName) {
      throw new Error('Extraction requires accountName and cloudName in options');
    }

    const result = await extractionService.extractWordPress(
      options.accountName,
      options.cloudName,
      domain,
      taskId
    );

    return result;
  };

  // Helper: execute deployment
  const executeDeployment = async (domain, options, taskId, scopeRef) => {
    const { getDeploymentService } = require('../../services/deployment-service');
    const deploymentService = getDeploymentService();

    if (!options.serverName || !options.sourceAccount || !options.sourceCloud) {
      throw new Error('Deployment requires serverName, sourceAccount, and sourceCloud in options');
    }

    const result = await deploymentService.deployWordPress(
      options.accountName || '',
      options.serverName,
      domain,
      options.sourceAccount,
      options.sourceCloud,
      taskId,
      options.deploymentOptions || {}
    );

    return result;
  };

  // Module Execute
  ipcMain.on('module:execute', async (event, { moduleId, domain, options }) => {
    const appState = getAppStateManager();
    const progressEmitter = getProgressEmitter();

    if (isOperationRunning.value) {
      mainWindow.webContents.send('module:error', {
        module: moduleId,
        domain,
        error: '[COLA] Ya hay una operación en curso. Espere a que finalice antes de iniciar otra.'
      });
      return;
    }
    isOperationRunning.value = true;

    try {
      const moduleLabel = moduleId === 'extraction' ? '[EXTRACCIÓN]' : '[DEPLOY]';
      const taskId = progressEmitter.createTask(moduleId, domain, `${moduleLabel} Iniciando: ${domain}`);

      // RESET antes de correr — evita acumulación
      appState.resetModuleState(moduleId);

      appState.update(moduleId, {
        isRunning: true,
        currentDomain: domain,
        currentProgress: 0,
        currentMessage: `${moduleLabel} Iniciando: ${domain}`,
        totalDomains: options.totalDomains || 0,
        currentIndex: options.domainIndex || 0,
      });

      event.sender.send(`${moduleId}:state-changed`, appState.getState(moduleId));

      const progressHandler = (progressData) => {
        // Solo procesar eventos de nuestro módulo
        if (progressData.module !== moduleId) return;

        // Actualizar estado en memoria (no enviamos module:progress duplicado —
        // el frontend ya recibe state:update via appState.update + _broadcast)
        appState.update(moduleId, {
          currentDomain: progressData.domain || domain,
          currentProgress: progressData.progress ?? 0,
          currentMessage: progressData.message || '',
        });
      };

      progressEmitter.on('progress', progressHandler);
      scope.progressSubscribers.add(progressHandler);

      let result;

      switch (moduleId) {
        case 'extraction':
          result = await executeExtraction(domain, options, taskId, scope);
          break;

        case 'deployment':
          result = await executeDeployment(domain, options, taskId, scope);
          break;

        default:
          throw new Error(`Unknown module: ${moduleId}`);
      }

      progressEmitter.off('progress', progressHandler);
      scope.progressSubscribers.delete(progressHandler);

      const completionPayload = {
        taskId,
        module: moduleId,
        domain,
        success: true,
        result
      };

      const state = appState.getState(moduleId);
      state.results.push(completionPayload);
      appState.update(moduleId, { results: state.results });

      mainWindow.webContents.send('module:completed', completionPayload);
      event.sender.send(`${moduleId}:state-changed`, appState.getState(moduleId));

    } catch (error) {
      console.error('[ERROR] Ejecución de módulo fallida:', error.message);
      scope.progressSubscribers.forEach(handler => {
        const emitter = getProgressEmitter();
        emitter.off('progress', handler);
      });
      scope.progressSubscribers.clear();

      const errorPayload = {
        module: moduleId,
        domain,
        error: error.message,
        success: false
      };

      const state = getAppStateManager().getState(moduleId);
      state.results.push(errorPayload);
      getAppStateManager().update(moduleId, { results: state.results });

      mainWindow.webContents.send('module:error', errorPayload);
      event.sender.send(`${moduleId}:state-changed`, getAppStateManager().getState(moduleId));
    } finally {
      isOperationRunning.value = false;
      getAppStateManager().update(moduleId, { isRunning: false });
    }
  });

  // Module Cancel
  ipcMain.on('module:cancel', (event, { moduleId }) => {
    const moduleLabel = moduleId || 'unknown';
    console.log(`[CANCEL] Solicitada cancelación de módulo: ${moduleLabel}`);

    const appState = getAppStateManager();

    // Mapear moduleIds de frontend a backend keys
    const moduleKeyMap = {
      extraction: 'extraction',
      deployment: 'deployment',
      dns: 'cloudflare',
      ssl: 'ssl',
    };

    const stateKey = moduleKeyMap[moduleId] || moduleId;

    // Cancelar tareas activas en el progress emitter
    const progressEmitter = getProgressEmitter();
    const activeTasks = progressEmitter.getActiveTasks();
    activeTasks.forEach(task => {
      if (task.module === stateKey || task.module === moduleId) {
        progressEmitter.cancelTask(task.taskId, `Cancelado por usuario: ${moduleLabel}`);
      }
    });

    // Limpiar subscribers del scope
    scope.progressSubscribers.forEach(handler => {
      progressEmitter.off('progress', handler);
    });
    scope.progressSubscribers.clear();

    // Abortar la operación en AppStateManager
    appState.abortModuleOperation(stateKey, scope.isOperationRunning);

    // Notificar al frontend
    try {
      mainWindow.webContents.send('module:error', {
        module: moduleId,
        error: `[CANCELADO] Operación de ${moduleLabel} detenida por el usuario.`
      });
    } catch (e) {
      // Ventana puede no estar disponible
    }
  });
}

module.exports = { registerModuleExecHandlers };
