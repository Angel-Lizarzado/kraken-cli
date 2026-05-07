// IPC Handlers: Module Status Queries (shared across modules)
// module:get-status - dispatches to the right module state

const { getAppStateManager } = require('../state/AppStateManager');

function registerModuleStatusHandlers(ipcMain) {
  // Module status query
  ipcMain.handle('module:get-status', async (event, { moduleId }) => {
    const appState = getAppStateManager();
    if (moduleId === 'extraction') {
      return appState.getState('extraction');
    }
    if (moduleId === 'deployment') {
      return appState.getState('deployment');
    }
    if (moduleId === 'cloudflare') {
      return appState.getState('cloudflare');
    }
    if (moduleId === 'ssl') {
      return appState.getState('ssl');
    }
    return { isRunning: false };
  });
}

module.exports = { registerModuleStatusHandlers };
