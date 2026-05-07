// IPC Handlers: Workspace Operations
// workspace:get-stats, workspace:scan-domains, workspace:scan
// workspace:create-domain-folder, workspace:get-dominios-procesados
// workspace:create-account-folder, workspace:create-cloud-folder
// workspace:update-dominios-procesados

const { getWorkspaceManager } = require('../../services/workspace-manager');
const { getConfigManager } = require('../../services/config-manager');

function registerWorkspaceHandlers(ipcMain, mainWindow) {
  // Get workspace stats
  ipcMain.handle('workspace:get-stats', async () => {
    const workspaceManager = getWorkspaceManager();
    await workspaceManager.initialize();
    return workspaceManager.getWorkspaceStats();
  });

  // Scan domains from folders
  ipcMain.handle('workspace:scan-domains', async (event, { accountName, cloudName }) => {
    try {
      const workspaceManager = getWorkspaceManager();
      await workspaceManager.initialize();
      const domains = await workspaceManager.scanDomainsFromFolders(accountName, cloudName);
      return {
        success: true,
        account: accountName,
        cloud: cloudName,
        domains: domains
      };
    } catch (error) {
      console.error('Error scanning workspace:', error);
      return {
        success: false,
        error: error.message
      };
    }
  });

  // Workspace: scan local respaldos directory structure
  ipcMain.handle('workspace:scan', async () => {
    try {
      const workspaceManager = getWorkspaceManager();
      await workspaceManager.initialize();
      const configManager = getConfigManager();

      // 🔥 v1.20.13: detectar si el workspace apunta a resources/ (deriva del ASAR)
      if (configManager.isWorkspacePathInvalid()) {
        const { dialog } = require('electron');
        const result = await dialog.showOpenDialog(mainWindow, {
          title: 'Seleccionar carpeta de trabajo (Workspace)',
          message: 'La ruta actual apunta a recursos internos de la aplicación. Por favor selecciona la carpeta donde están tus proyectos (respaldos).',
          properties: ['openDirectory'],
        });
        if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
          return { success: false, error: 'Operación cancelada por el usuario. Selecciona un directorio de trabajo válido.' };
        }
        const selectedPath = result.filePaths[0];
        // Validar que no sea resources/ o app.asar
        const lowerPath = selectedPath.toLowerCase();
        if (lowerPath.includes('resources') || lowerPath.includes('app.asar')) {
          return { success: false, error: 'La ruta seleccionada es inválida (contiene resources/ o app.asar). Elige un directorio de trabajo real.' };
        }
        configManager.setWorkspacePath(selectedPath);
        await configManager.saveConfig();
        workspaceManager._workspaceRoot = null; // forzar re-inicialización
        await workspaceManager.initialize();
      }

      // 1. Scan folders on disk
      const result = await workspaceManager.scanWorkspace();

      // 2. Integrate discoveries into config
      const config = configManager.getConfig() || { sshKeys: {}, accounts: [], cloudflare: { apiToken: '', zoneId: '' }, workspaceRoot: '' };

      for (const discoveredAccount of result.accounts || []) {
        let configAccount = config.accounts.find(a => a.name === discoveredAccount.name);

        if (!configAccount) {
          configAccount = {
            name: discoveredAccount.name,
            originClouds: []
          };
          config.accounts.push(configAccount);
        }

        for (const discoveredCloud of discoveredAccount.clouds || []) {
          const exists = configAccount.originClouds.some(c => c.name === discoveredCloud.name);
          if (!exists) {
            configAccount.originClouds.push({
              name: discoveredCloud.name,
              type: 'hostinger',
              isLinked: false,
              sshCredentials: {
                host: '',
                port: 65002,
                username: ''
              }
            });
          }
        }
      }

      // 3. Persist the merged config
      await configManager.saveConfig();

      // 4. Push fresh config to UI
      const freshConfig = configManager.getConfig();
      if (freshConfig) {
        mainWindow.webContents.send('config:loaded', { success: true, config: freshConfig });
        mainWindow.webContents.send('config:updated', { success: true, config: freshConfig });
      }

      const totalAccounts = result.accounts?.length || 0;
      const totalClouds = result.accounts?.reduce((t, a) => t + (a.clouds?.length || 0), 0) || 0;
      mainWindow.webContents.send('workspace:scanned', {
        workspaceRoot: result.workspaceRoot,
        accounts: totalAccounts,
        clouds: totalClouds,
        message: 'Escaneo completado en ' + result.workspaceRoot + '. Se han sincronizado ' + totalAccounts + ' cuentas y ' + totalClouds + ' clouds.'
      });

      return { success: true, ...result };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Create domain folder
  ipcMain.handle('workspace:create-domain-folder', async (event, { accountName, cloudName, domain }) => {
    try {
      const workspaceManager = getWorkspaceManager();
      await workspaceManager.initialize();
      const path = await workspaceManager.createDomainFolder(accountName, cloudName, domain);
      return { success: true, path: path };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Get processed dominios
  ipcMain.handle('workspace:get-dominios-procesados', async (event, { accountName, cloudName }) => {
    try {
      const workspaceManager = getWorkspaceManager();
      await workspaceManager.initialize();
      const dominios = await workspaceManager.getDominiosProcesados(accountName, cloudName);
      return { success: true, dominios: dominios };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Create account folder
  ipcMain.handle('workspace:create-account-folder', async (event, { accountName }) => {
    try {
      const workspaceManager = getWorkspaceManager();
      await workspaceManager.initialize();
      const path = await workspaceManager.createAccountFolder(accountName);
      return { success: true, path: path };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Create cloud folder
  ipcMain.handle('workspace:create-cloud-folder', async (event, { accountName, cloudName }) => {
    try {
      const workspaceManager = getWorkspaceManager();
      await workspaceManager.initialize();
      const path = await workspaceManager.createCloudFolder(accountName, cloudName);
      return { success: true, path: path };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Update dominios procesados
  ipcMain.handle('workspace:update-dominios-procesados', async (event, { accountName, cloudName, domains }) => {
    try {
      const workspaceManager = getWorkspaceManager();
      await workspaceManager.initialize();
      const updated = await workspaceManager.updateDominiosProcesados(accountName, cloudName, domains);
      return { success: true, dominios: updated };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // ── Selector de carpeta nativo ───────────────────────────────────────────────
  // Abre el diálogo de selección de carpeta del sistema operativo.
  // Retorna { success: true, path: string } o { success: false, canceled: true }.
  // Usado desde ConfigPanel para cambiar el workspace de respaldos sin editar JSON.
  ipcMain.handle('dialog:open-directory', async (_event, { title, defaultPath } = {}) => {
    const { dialog } = require('electron');
    const result = await dialog.showOpenDialog(mainWindow, {
      title: title || 'Seleccionar carpeta de respaldos',
      defaultPath: defaultPath || undefined,
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Seleccionar',
    });

    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return { success: false, canceled: true };
    }

    const selected = result.filePaths[0];

    // Rechazar rutas internas del ejecutable/ASAR para evitar corrupción
    const lower = selected.toLowerCase();
    if (lower.includes('resources') || lower.includes('app.asar')) {
      return {
        success: false,
        canceled: false,
        error: 'La ruta seleccionada es inválida (apunta a recursos internos de la aplicación).',
      };
    }

    return { success: true, path: selected };
  });
}

module.exports = { registerWorkspaceHandlers };
