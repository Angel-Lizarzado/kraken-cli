// IPC Handlers: Config Management
// config:get, config:validate, config:save, config:load
// config:get-cloudflare-token, config:set-cloudflare-token
// workspace:get-path, workspace:set-path

const fs = require('fs');
const path = require('path');
const { getConfigManager } = require('../../services/config-manager');
const { getLogBufferService } = require('../../services/log-buffer-service');

function registerConfigHandlers(ipcMain, mainWindow) {
  // Get config
  ipcMain.handle('config:get', async () => {
    let configManager = getConfigManager();
    await configManager.initialize();
    const cfg = configManager.getConfig();
    console.log('[BOOT] Backend: Config cargada y lista');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('config:updated', { success: true, config: cfg });
    }
    return cfg;
  });

  // Validate config
  ipcMain.handle('config:validate', async (event, config) => {
    const errors = [];

    if (config.accounts) {
      config.accounts.forEach((account, index) => {
        if (!account.name) {
          errors.push(`Account ${index + 1} must have a name`);
        }
      });
    }

    if (config.destinationServers) {
      config.destinationServers.forEach((server, index) => {
        if (!server.name) {
          errors.push(`Destination server ${index + 1} must have a name`);
        }
      });
    }

    return { valid: errors.length === 0, errors };
  });

  // Save config
  ipcMain.on('config:save', async (event, config) => {
    try {
      let configManager = getConfigManager();
      await configManager.initialize();

      await configManager.updateConfig(config);
      const freshConfig = configManager.getConfig();
      mainWindow.webContents.send('config:saved', { success: true });
      if (freshConfig) {
        mainWindow.webContents.send('config:updated', { success: true, config: freshConfig });
      }
    } catch (error) {
      console.error('Error saving config:', error);
      mainWindow.webContents.send('config:saved', {
        success: false,
        error: error.message
      });
    }
  });

  // Load config
  ipcMain.on('config:load', async (event) => {
    try {
      let configManager = getConfigManager();
      await configManager.initialize();

      const config = configManager.getConfig();
      mainWindow.webContents.send('config:loaded', { success: true, config });
      mainWindow.webContents.send('config:updated', { success: true, config });
    } catch (error) {
      console.error('Error loading config:', error);
      mainWindow.webContents.send('config:loaded', {
        success: false,
        error: error.message
      });
    }
  });

  // Get Cloudflare token (obfuscated for UI)
  ipcMain.handle('config:get-cloudflare-token', async () => {
    try {
      let configManager = getConfigManager();
      await configManager.initialize();
      const cfg = configManager.getConfig();
      const raw = cfg?.cloudflare?.apiToken || '';
      if (!raw) return { success: true, token: '', obfuscated: '' };
      const obfuscated = raw.length > 8
        ? raw.slice(0, 2) + '****' + raw.slice(-4)
        : '****';
      return { success: true, token: raw, obfuscated };
    } catch (error) {
      console.error('Error getting Cloudflare token:', error);
      return { success: false, error: error.message, token: '', obfuscated: '' };
    }
  });

  // Set Cloudflare token
  ipcMain.handle('config:set-cloudflare-token', async (event, { token }) => {
    try {
      if (!token || typeof token !== 'string' || !token.trim()) {
        return { success: false, error: 'Token inválido: debe ser un string no vacío' };
      }
      let configManager = getConfigManager();
      await configManager.initialize();
      const cfg = configManager.getConfig();
      cfg.cloudflare = cfg.cloudflare || { apiToken: '', zoneId: '' };
      cfg.cloudflare.apiToken = token.trim();
      await configManager.saveConfig();

      // 🔥 v1.14: Notificar UI en vivo que la config cambió — para que DNSSyncModule
      // detecte el nuevo token sin necesidad de reiniciar la app.
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('config:updated', {
          success: true,
          config: configManager.getConfig(),
        });
      }

      return { success: true };
    } catch (error) {
      console.error('[CF-TOKEN] Error setting Cloudflare token:', error);
      if (error instanceof Error) {
        console.error('[CF-TOKEN] Stack:', error.stack);
      }
      return { success: false, error: error.message || 'Error desconocido al guardar token' };
    }
  });

  // ── Workspace Path ──

  // Get current workspace path (resolved dynamically)
  ipcMain.handle('workspace:get-path', async () => {
    try {
      const configManager = getConfigManager();
      await configManager.initialize();
      const workspacePath = configManager.getWorkspacePath();
      const respaldosPath = configManager.getRespaldosPath();
      const logBuffer = getLogBufferService();
      logBuffer.push('system', `[INFO] Workspace detectado en: ${workspacePath}`, 'info', '');
      return {
        success: true,
        workspacePath,
        respaldosPath,
        configWorkspaceRoot: configManager.getConfig()?.workspaceRoot || '',
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Set workspace path (persisted to electron-store)
  ipcMain.handle('workspace:set-path', async (event, { workspacePath }) => {
    try {
      if (!workspacePath || typeof workspacePath !== 'string' || !workspacePath.trim()) {
        return { success: false, error: 'La ruta del workspace no puede estar vacía' };
      }

      const configManager = getConfigManager();
      await configManager.initialize();

      // Validar que la ruta exista en disco (opcional: crearla si no existe)
      const resolved = path.resolve(workspacePath.trim());
      if (!fs.existsSync(resolved)) {
        fs.mkdirSync(resolved, { recursive: true });
        console.log(`[WORKSPACE] Directorio creado: ${resolved}`);
      }

      // Validar que sea un directorio
      const stat = fs.statSync(resolved);
      if (!stat.isDirectory()) {
        return { success: false, error: `"${resolved}" no es un directorio` };
      }

      configManager.setWorkspacePath(resolved);
      await configManager.saveConfig();

      const logBuffer = getLogBufferService();
      logBuffer.push('system', `[INFO] Workspace reconfigurado a: ${resolved}`, 'info', '');

      // Notificar a la UI del cambio
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('config:updated', {
          success: true,
          config: configManager.getConfig(),
        });
      }

      return { success: true, workspacePath: resolved };
    } catch (error) {
      console.error('[WORKSPACE] Error al configurar workspace path:', error);
      return { success: false, error: error.message };
    }
  });
}

module.exports = { registerConfigHandlers };
