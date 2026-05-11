// IPC Handlers: Mass Health Check
// Canales: health:check-mass, health:cancel
// Emite: health:progress (real-time updates)

const { getConfigManager } = require('../../services/config-manager');
const { getSshService }    = require('../../services/ssh-service');
const { runHealthCheck }   = require('../../services/health-service');

// ── Helpers ──

async function getConfig() {
  const mgr = getConfigManager();
  if (!mgr.getConfig()) await mgr.initialize();
  return mgr.getConfig();
}

function findDestinationServer(config, serverName) {
  const server = config.destinationServers?.find(s => s.name === serverName);
  if (!server) throw new Error(`Servidor "${serverName}" no encontrado en la configuración`);
  return server;
}

// ── Active scan state (one scan at a time) ──

let activeAbort = null;

// ── Registration ──

function registerHealthHandlers(ipcMain, mainWindow) {
  /**
   * health:check-mass — Start a mass health check for a server's domains.
   * Input: { serverName: string, domains?: string[] }
   *   - If domains is provided, checks those specific domains.
   *   - If not, SSHs into the server and runs `plesk bin site --list` to get all domains.
   * Output: { success: boolean, results: HealthResult[], error?: string }
   */
  ipcMain.handle('health:check-mass', async (event, { serverName, domains }) => {
    // Cancel any previous scan
    if (activeAbort) {
      activeAbort.abort();
      activeAbort = null;
    }

    const controller = new AbortController();
    activeAbort = controller;

    try {
      let domainList = domains;

      // If no domain list provided, fetch from server via SSH + Plesk CLI
      if (!domainList || domainList.length === 0) {
        const config = await getConfig();
        const serverConfig = findDestinationServer(config, serverName);
        const sshService = getSshService();

        let client = null;
        try {
          client = await sshService.connect(serverConfig.sshCredentials, `health-list-${serverName}`);
          const result = await sshService.executeCommand(client, 'plesk bin site --list 2>/dev/null');
          const stdout = (result.stdout || '').trim();

          if (!stdout) {
            return { success: false, error: 'No se encontraron dominios en el servidor.' };
          }

          domainList = stdout
            .split('\n')
            .map(d => d.trim())
            .filter(d => d.length > 0 && d.includes('.'));
        } finally {
          if (client) {
            try { await sshService.disconnect(client); } catch (_) { }
          }
        }
      }

      if (domainList.length === 0) {
        return { success: false, error: 'Lista de dominios vacía.' };
      }

      // Emit initial count
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('health:progress', {
          current: 0,
          total: domainList.length,
          domain: '',
          result: null,
          phase: 'starting',
        });
      }

      const results = await runHealthCheck(domainList, {
        signal: controller.signal,
        onProgress: (progress) => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('health:progress', {
              ...progress,
              phase: 'scanning',
            });
          }
        },
      });

      // Clean up
      if (activeAbort === controller) activeAbort = null;

      return { success: true, results };
    } catch (error) {
      if (activeAbort === controller) activeAbort = null;

      if (error.name === 'AbortError' || controller.signal.aborted) {
        return { success: false, error: 'Escaneo cancelado por el usuario.' };
      }

      console.error('[HEALTH] Error en health check masivo:', error.message);
      return { success: false, error: error.message };
    }
  });

  /**
   * health:cancel — Cancel an active health check scan.
   */
  ipcMain.handle('health:cancel', async () => {
    if (activeAbort) {
      activeAbort.abort();
      activeAbort = null;
      return { success: true, message: 'Escaneo cancelado.' };
    }
    return { success: true, message: 'No hay escaneo activo.' };
  });
}

module.exports = { registerHealthHandlers };
