// IPC Handlers: Utilities
// services:initialize, uuid:generate, uuid:generate-task-id, uuid:generate-script-name
// utils:lookup-host, shell:open-external, progress:subscribe, progress:unsubscribe

const { shell } = require('electron');
const { getConfigManager } = require('../../services/config-manager');
const { getWorkspaceManager } = require('../../services/workspace-manager');
const { getSshService } = require('../../services/ssh-service');
const { getProgressEmitter } = require('../../services/progress-emitter');
const { getPleskCliService } = require('../../services/plesk-cli-service');
const { getCloudflareApiService } = require('../../services/cloudflare-api-service');
const UuidUtil = require('../../services/uuid-util');

function registerUtilsHandlers(ipcMain, mainWindow, scope) {
  const { progressEmitter, progressSubscribers } = scope;

  // Service Initialization
  ipcMain.handle('services:initialize', async () => {
    try {
      const configManager = getConfigManager();
      await configManager.initialize();

      const workspaceManager = getWorkspaceManager();
      await workspaceManager.initialize();

      const emitter = getProgressEmitter();
      emitter.setupIpcForwarding(ipcMain, mainWindow);

      getSshService();
      getPleskCliService();
      getCloudflareApiService();

      return { success: true, message: 'Services initialized successfully' };
    } catch (error) {
      console.error('Failed to initialize services:', error);
      return { success: false, error: error.message };
    }
  });

  // UUID Utilities
  ipcMain.handle('uuid:generate', () => {
    return UuidUtil.generate();
  });

  ipcMain.handle('uuid:generate-task-id', () => {
    return UuidUtil.generateTaskId();
  });

  ipcMain.handle('uuid:generate-script-name', (event, originalName) => {
    return UuidUtil.generateScriptName(originalName);
  });

  // DNS Lookup
  ipcMain.handle('utils:lookup-host', async (event, { domain }) => {
    const dns = require('dns');
    try {
      const ips = await dns.promises.resolve4(domain);
      const ip = ips[0];
      let hostName;
      try {
        const hostNames = await dns.promises.reverse(ip);
        hostName = hostNames[0] || null;
      } catch {
        hostName = null;
      }
      return { success: true, ip, hostName };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Open external URL in default browser
  ipcMain.handle('shell:open-external', async (event, { url }) => {
    try {
      if (typeof url !== 'string' || (!url.startsWith('https://') && !url.startsWith('http://'))) {
        return { success: false, error: 'URL inválida' };
      }
      await shell.openExternal(url);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Progress Management
  ipcMain.on('progress:subscribe', (event) => {
    const progressHandler = (progressData) => {
      mainWindow.webContents.send('progress:update', progressData);
    };

    if (progressEmitter) {
      progressEmitter.on('progress', progressHandler);
      progressSubscribers.add(progressHandler);
    }
  });

  ipcMain.on('progress:unsubscribe', (event) => {
    progressSubscribers.forEach(handler => {
      if (progressEmitter) {
        progressEmitter.off('progress', handler);
      }
    });
    progressSubscribers.clear();
  });
}

module.exports = { registerUtilsHandlers };
