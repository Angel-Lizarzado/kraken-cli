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

  // Get Cloudflare Account ID
  ipcMain.handle('config:get-cloudflare-account-id', async () => {
    try {
      let configManager = getConfigManager();
      await configManager.initialize();
      const cfg = configManager.getConfig();
      const raw = cfg?.cloudflare?.accountId || '';
      return { success: true, accountId: raw };
    } catch (error) {
      console.error('Error getting Cloudflare account ID:', error);
      return { success: false, error: error.message, accountId: '' };
    }
  });

  // Set Cloudflare Account ID
  ipcMain.handle('config:set-cloudflare-account-id', async (event, { accountId }) => {
    try {
      if (!accountId || typeof accountId !== 'string' || !accountId.trim()) {
        return { success: false, error: 'Account ID inválido: debe ser un string no vacío' };
      }
      let configManager = getConfigManager();
      await configManager.initialize();
      const cfg = configManager.getConfig();
      cfg.cloudflare = cfg.cloudflare || { apiToken: '', accountId: '' };
      cfg.cloudflare.accountId = accountId.trim();
      await configManager.saveConfig();

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('config:updated', {
          success: true,
          config: configManager.getConfig(),
        });
      }

      return { success: true };
    } catch (error) {
      console.error('[CF-TOKEN] Error setting Cloudflare account ID:', error);
      return { success: false, error: error.message || 'Error desconocido' };
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
  // Eliminar servidor destino
  ipcMain.handle('server:delete', async (event, { serverName }) => {
    try {
      if (!serverName || typeof serverName !== 'string' || !serverName.trim()) {
        return { success: false, error: 'Nombre de servidor inválido' };
      }

      const configManager = getConfigManager();
      await configManager.initialize();
      const cfg = configManager.getConfig();

      const antes = (cfg.destinationServers || []).length;
      cfg.destinationServers = (cfg.destinationServers || []).filter(
        s => s.name !== serverName.trim()
      );
      const despues = cfg.destinationServers.length;

      if (antes === despues) {
        return { success: false, error: `Servidor "${serverName}" no encontrado en la configuración` };
      }

      await configManager.saveConfig();
      console.log(`[CONFIG] Servidor "${serverName}" eliminado correctamente.`);

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('config:updated', {
          success: true,
          config: configManager.getConfig(),
        });
      }

      return { success: true };
    } catch (error) {
      console.error('[CONFIG] Error al eliminar servidor:', error);
      return { success: false, error: error.message };
    }
  });

  // ── SSL Email ──

  // Get current SSL email
  ipcMain.handle('config:get-ssl-email', async () => {
    try {
      const configManager = getConfigManager();
      await configManager.initialize();
      const cfg = configManager.getConfig();
      return { success: true, email: cfg?.sslEmail || '' };
    } catch (error) {
      console.error('[CONFIG] Error al leer sslEmail:', error);
      return { success: false, error: error.message, email: '' };
    }
  });

  // Set SSL email
  ipcMain.handle('config:set-ssl-email', async (event, { email }) => {
    try {
      if (typeof email !== 'string') {
        return { success: false, error: 'El email debe ser un string.' };
      }

      const configManager = getConfigManager();
      await configManager.initialize();
      const cfg = configManager.getConfig();

      // Allow empty string to clear the email
      cfg.sslEmail = email.trim();
      await configManager.saveConfig();

      console.log(`[CONFIG] SSL email actualizado: ${cfg.sslEmail || '(vacío)'}`);

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('config:updated', {
          success: true,
          config: configManager.getConfig(),
        });
      }

      return { success: true };
    } catch (error) {
      console.error('[CONFIG] Error al guardar sslEmail:', error);
      return { success: false, error: error.message };
    }
  });
  
  // ── Correo Automático ────────────────────────────────────────────────────────
  ipcMain.handle('correo:contrasena:guardar', async (event, { password }) => {
    try {
      const { guardarContrasena } = require('../../services/keytar-service');
      await guardarContrasena(password);
      return { exito: true, mensaje: 'Contraseña maestra guardada correctamente.' };
    } catch (error) {
      return { exito: false, error: error.message };
    }
  });

  ipcMain.handle('correo:contrasena:existe', async () => {
    try {
      const { verificarExiste } = require('../../services/keytar-service');
      const existe = await verificarExiste();
      return { exito: true, existe };
    } catch (error) {
      return { exito: false, error: error.message };
    }
  });

  ipcMain.handle('correo:contrasena:eliminar', async () => {
    try {
      const { eliminarContrasena } = require('../../services/keytar-service');
      await eliminarContrasena();
      return { exito: true, mensaje: 'Contraseña maestra eliminada correctamente.' };
    } catch (error) {
      return { exito: false, error: error.message };
    }
  });
  // Get Google Drive Config
  ipcMain.handle('config:get-google-drive', async () => {
    try {
      const { getConfigManager } = require('../../services/config-manager');
      let configManager = getConfigManager();
      await configManager.initialize();
      const cfg = configManager.getConfig();
      return { success: true, googleDrive: cfg?.googleDrive || { credentialsPath: '', rootFolderId: '' } };
    } catch (error) {
      console.error('Error getting Google Drive config:', error);
      return { success: false, error: error.message };
    }
  });

  // Set Google Drive Root Folder ID
  ipcMain.handle('config:set-drive-root', async (event, { rootFolderId }) => {
    try {
      const { getConfigManager } = require('../../services/config-manager');
      let configManager = getConfigManager();
      await configManager.initialize();
      const cfg = configManager.getConfig();
      if (!cfg.googleDrive) cfg.googleDrive = { credentialsPath: '', rootFolderId: '' };
      cfg.googleDrive.rootFolderId = rootFolderId;
      await configManager.updateConfig(cfg);
      return { success: true };
    } catch (error) {
      console.error('Error saving Drive Root Folder:', error);
      return { success: false, error: error.message };
    }
  });

  // Select Drive Credentials JSON
  ipcMain.handle('config:select-drive-credentials', async () => {
    try {
      const { dialog } = require('electron');
      const { getConfigManager } = require('../../services/config-manager');
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Seleccionar archivo credentials.json',
        properties: ['openFile'],
        filters: [{ name: 'JSON', extensions: ['json'] }]
      });

      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, error: 'canceled' };
      }

      const filePath = result.filePaths[0];
      
      let configManager = getConfigManager();
      await configManager.initialize();
      const cfg = configManager.getConfig();
      if (!cfg.googleDrive) cfg.googleDrive = { credentialsPath: '', rootFolderId: '' };
      cfg.googleDrive.credentialsPath = filePath;
      await configManager.updateConfig(cfg);
      
      return { success: true, path: filePath };
    } catch (error) {
      console.error('Error selecting Drive credentials:', error);
      return { success: false, error: error.message };
    }
  });

  // Start Drive Sync (Manual)
  ipcMain.handle('drive:start-sync', async (event, { accountName, cloudName, dominios }) => {
    try {
      const { getDriveSyncService } = require('../../services/drive-sync-service');
      const driveSync = getDriveSyncService();
      
      // Async no bloqueante
      setTimeout(async () => {
        try {
          const log = (msg, type) => {
             if (!event.sender.isDestroyed()) {
               event.sender.send('drive:log', { msg, type });
             }
          };
          await driveSync.syncBatch(accountName, cloudName, dominios, log);
          if (!event.sender.isDestroyed()) {
            event.sender.send('drive:sync-complete', { success: true });
          }
        } catch (err) {
          if (!event.sender.isDestroyed()) {
            event.sender.send('drive:sync-complete', { success: false, error: err.message });
          }
        }
      }, 100);

      return { success: true };
    } catch (error) {
      console.error('Error starting Drive sync:', error);
      return { success: false, error: error.message };
    }
  });

  // Stop Drive Sync
  ipcMain.handle('drive:stop-sync', async () => {
    try {
      const { getDriveSyncService } = require('../../services/drive-sync-service');
      const driveSync = getDriveSyncService();
      driveSync.solicitarParada();
      return { success: true };
    } catch (error) {
      console.error('Error stopping Drive sync:', error);
      return { success: false, error: error.message };
    }
  });

  // OAuth2 Check Auth
  ipcMain.handle('drive:check-auth', async (event, credentialsPath) => {
    try {
      if (!credentialsPath) return { success: true, authenticated: false };
      
      const { getDriveService } = require('../../services/drive-service');
      const authOk = await getDriveService().checkAuth(credentialsPath);
      return { success: true, authenticated: authOk };
    } catch (e) { return { success: false, error: e.message }; }
  });

  // OAuth2 Logout
  ipcMain.handle('drive:logout', async (event, credentialsPath) => {
    try {
      const { getDriveService } = require('../../services/drive-service');
      getDriveService().logout(credentialsPath);
      return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
  });

  // OAuth2 Start Auth
  ipcMain.handle('drive:start-auth', async (event, credentialsPath) => {
    return new Promise((resolve) => {
      try {
        if (!credentialsPath) {
          resolve({ success: false, error: 'No se ha seleccionado el archivo de credenciales.' });
          return;
        }
        const { getDriveService } = require('../../services/drive-service');
        const driveService = getDriveService();
        const url = driveService.getAuthUrl(credentialsPath);
        
        const { shell } = require('electron');
        shell.openExternal(url);

        const http = require('http');
        const fs = require('fs');
        const port = 3000;
        
        const server = http.createServer(async (req, res) => {
          try {
            const reqUrl = new URL(req.url, `http://127.0.0.1:${port}`);
            if (reqUrl.pathname === '/') {
              const code = reqUrl.searchParams.get('code');
              if (code) {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end('<h1>Autenticación Exitosa</h1><p>Ya puedes volver a Kraken. Puedes cerrar esta pestaña.</p><script>window.close()</script>');
                server.close();
                await driveService.authorizeWithCode(credentialsPath, code);
                resolve({ success: true });
              } else {
                res.writeHead(400, { 'Content-Type': 'text/plain' });
                res.end('Falta el código de autorización.');
                server.close();
                resolve({ success: false, error: 'Código no encontrado en la URL.' });
              }
            }
          } catch(err) {
             res.writeHead(500, { 'Content-Type': 'text/plain' });
             res.end('Error interno.');
             server.close();
             resolve({ success: false, error: err.message });
          }
        });

        server.listen(port, '127.0.0.1', () => {
          console.log(`[DRIVE] Esperando callback OAuth en http://127.0.0.1:${port}/`);
        });

        server.on('error', (err) => {
          resolve({ success: false, error: 'No se pudo iniciar el servidor local (¿puerto ocupado?): ' + err.message });
        });
        
      } catch (e) {
        resolve({ success: false, error: e.message });
      }
    });
  });
}

module.exports = { registerConfigHandlers };
