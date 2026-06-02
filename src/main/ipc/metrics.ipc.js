'use strict';

/**
 * @file metrics.ipc.js
 * @description Handlers IPC para métricas del servidor en tiempo real.
 *
 * Canales (invoke):
 *   server:metrics-fetch   → Obtiene métricas una vez (on-demand)
 *   server:metrics-start   → Inicia polling automático (60s interval)
 *   server:metrics-stop    → Detiene el polling del servidor especificado
 *
 * Canales (send → renderer):
 *   server:metrics-update  → Push de métricas en cada ciclo de polling
 */

const { getConfigManager } = require('../../services/config-manager');
const { getSshService }    = require('../../services/ssh-service');
const { fetchServerMetrics } = require('../../services/health/serverMetricsService');

// ── Polling state: un intervalo por servidor activo ──────────────────────────
// Map<serverName, NodeJS.Timeout>
const _activePolls = new Map();

const POLL_INTERVAL_MS = 60 * 1000; // 60 segundos

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

// ─── Registro de handlers ─────────────────────────────────────────────────────

function registerMetricsHandlers(ipcMain, mainWindow) {

  // ── Fetch puntual (on-demand, sin polling) ────────────────────────────────
  ipcMain.handle('server:metrics-fetch', async (_event, { serverName }) => {
    try {
      const config = await getConfig();
      const serverConfig = findDestinationServer(config, serverName);
      const sshService = getSshService();

      const metrics = await fetchServerMetrics(
        sshService,
        serverConfig.sshCredentials,
        serverName
      );

      return { success: true, metrics };
    } catch (error) {
      console.error(`[METRICS] Error al obtener métricas de "${serverName}":`, error.message);
      return { success: false, error: error.message };
    }
  });

  // ── Iniciar polling automático (60s) ──────────────────────────────────────
  ipcMain.handle('server:metrics-start', async (_event, { serverName }) => {
    // Evitar doble polling para el mismo servidor
    if (_activePolls.has(serverName)) {
      return { success: true, message: `Polling ya activo para "${serverName}".` };
    }

    const runPoll = async () => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        // Ventana cerrada → limpiar
        clearInterval(_activePolls.get(serverName));
        _activePolls.delete(serverName);
        return;
      }

      try {
        const config = await getConfig();
        const serverConfig = findDestinationServer(config, serverName);
        const sshService = getSshService();

        const metrics = await fetchServerMetrics(
          sshService,
          serverConfig.sshCredentials,
          serverName
        );

        if (!mainWindow.isDestroyed()) {
          mainWindow.webContents.send('server:metrics-update', { serverName, metrics });
        }
      } catch (error) {
        console.warn(`[METRICS:POLL] Error para "${serverName}":`, error.message);
        if (!mainWindow.isDestroyed()) {
          mainWindow.webContents.send('server:metrics-update', {
            serverName,
            metrics: null,
            error: error.message,
          });
        }
      }
    };

    // Primera medición inmediata
    runPoll();

    // Polling periódico
    const intervalId = setInterval(runPoll, POLL_INTERVAL_MS);
    _activePolls.set(serverName, intervalId);

    console.log(`[METRICS] Polling iniciado para "${serverName}" (intervalo: ${POLL_INTERVAL_MS / 1000}s)`);
    return { success: true };
  });

  // ── Detener polling ───────────────────────────────────────────────────────
  ipcMain.handle('server:metrics-stop', async (_event, { serverName }) => {
    const intervalId = _activePolls.get(serverName);
    if (intervalId) {
      clearInterval(intervalId);
      _activePolls.delete(serverName);
      console.log(`[METRICS] Polling detenido para "${serverName}"`);
    }
    return { success: true };
  });
}

// ── Limpieza global al cerrar la app ─────────────────────────────────────────
function stopAllPolls() {
  for (const [serverName, intervalId] of _activePolls.entries()) {
    clearInterval(intervalId);
    console.log(`[METRICS] Polling limpiado para "${serverName}" (cierre de app)`);
  }
  _activePolls.clear();
}

module.exports = { registerMetricsHandlers, stopAllPolls };
