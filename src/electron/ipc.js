// IPC Channel Definitions and Handlers — Orchestrator
// This file is the ORCHESTRATOR that imports and registers all modular IPC handlers.
// Each handler file exports registerXxxHandlers(ipcMain, mainWindow, scope).
// Shared state (operation lock, progress subscribers) is passed via scope.

const { getProgressEmitter } = require('../services/progress-emitter');
const { getSshService } = require('../services/ssh-service');

// ── Shared Infrastructure ──

// Global operation lock — prevents SSH collisions on Hostinger
const isOperationRunning = { value: false };

// Progress subscribers
const progressSubscribers = new Set();

// Scope object passed to all handler registrars
const scope = {
  isOperationRunning,
  progressSubscribers,
};

// Wire the operation lock ref into AppStateManager for the abort/kill-switch
const { setOperationLockRef } = require('../main/state/AppStateManager');
setOperationLockRef(scope.isOperationRunning);

// ── Handler Registrars ──

const { registerConfigHandlers } = require('../main/ipc/config.ipc');
const { registerSshHandlers } = require('../main/ipc/ssh.ipc');
const { registerExtractionHandlers } = require('../main/ipc/extraction.ipc');
const { registerDeploymentHandlers } = require('../main/ipc/deployment.ipc');
const { registerModuleExecHandlers } = require('../main/ipc/module-exec.ipc');
const { registerModuleStatusHandlers } = require('../main/ipc/module-status.ipc');
const { registerCloudflareHandlers } = require('../main/ipc/cloudflare.ipc');
const { registerSslHandlers } = require('../main/ipc/ssl.ipc');
const { registerWorkspaceHandlers } = require('../main/ipc/workspace.ipc');
const { registerUtilsHandlers } = require('../main/ipc/utils.ipc');
const { registerScannerHandlers } = require('../main/ipc/scanner.ipc');

// ── Initialize IPC Handlers ──

function initializeIpcHandlers(ipcMain, mainWindow) {
  // Lazy-init progress emitter only when first handler that needs it is registered
  // (the utils handler uses it for progress:subscribe/unsubscribe)

  // Log hydration handler — terminal requests initial logs on mount
  const { getLogBufferService } = require('../services/log-buffer-service');
  ipcMain.handle('log:get-recent', async (event, { count = 50 } = {}) => {
    try {
      const logService = getLogBufferService();
      return { success: true, logs: logService.getRecentLogs(count) };
    } catch (err) {
      return { success: false, error: err.message, logs: [] };
    }
  });

  // Alias: full history hydration (count=200) for terminal first mount
  ipcMain.handle('logs:get-all', async () => {
    try {
      const logService = getLogBufferService();
      return { success: true, logs: logService.getRecentLogs(200) };
    } catch (err) {
      return { success: false, error: err.message, logs: [] };
    }
  });

  registerConfigHandlers(ipcMain, mainWindow, scope);
  registerSshHandlers(ipcMain, mainWindow, scope);
  registerExtractionHandlers(ipcMain, mainWindow, scope);
  registerDeploymentHandlers(ipcMain, mainWindow, scope);
  registerModuleExecHandlers(ipcMain, mainWindow, scope);
  registerModuleStatusHandlers(ipcMain, mainWindow, scope);
  registerCloudflareHandlers(ipcMain, mainWindow, scope);
  registerSslHandlers(ipcMain, mainWindow, scope);
  registerWorkspaceHandlers(ipcMain, mainWindow, scope);
  registerUtilsHandlers(ipcMain, mainWindow, scope);
  registerScannerHandlers(ipcMain, mainWindow, scope);
}

// ── Cleanup ──

function cleanup() {
  const progressEmitter = getProgressEmitter();

  progressSubscribers.forEach(handler => {
    if (progressEmitter) {
      progressEmitter.off('progress', handler);
    }
  });
  progressSubscribers.clear();

  const sshService = getSshService();
  if (sshService) {
    sshService.disconnectAll();
  }
}

// ── Exports ──

function isTaskRunning() {
  return isOperationRunning.value;
}

module.exports = {
  initializeIpcHandlers,
  cleanup,
  isTaskRunning
};
