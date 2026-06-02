'use strict';

/**
 * @file security.ipc.js
 * @description Handlers IPC para el módulo de Seguridad (Admin Access).
 *
 * Canales (invoke):
 *   security:validate-password    → Valida la contraseña de acceso al módulo
 *   security:reboot               → Reinicia el servidor
 *   security:shutdown             → Apaga el servidor
 *   security:credential-reset     → Reset masivo de contraseñas WordPress
 *
 * Canales (send → renderer):
 *   security:credential-progress  → Progreso del reset por base de datos
 */

const { getConfigManager } = require('../../services/config-manager');
const { getSshService }    = require('../../services/ssh-service');
const {
  validateAdminPassword,
  rebootServer,
  shutdownServer,
  massiveCredentialReset,
} = require('../../services/security/securityService');

// ─── Helper ───────────────────────────────────────────────────────────────────

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

// ─── Registro ─────────────────────────────────────────────────────────────────

function registerSecurityHandlers(ipcMain, mainWindow) {

  // ── Validación de contraseña admin ────────────────────────────────────────
  ipcMain.handle('security:validate-password', async (_event, { password }) => {
    const valid = validateAdminPassword(password);
    if (!valid) {
      console.warn('[SECURITY] Intento de acceso con contraseña incorrecta.');
    }
    return { success: valid };
  });

  // ── Reboot del servidor ───────────────────────────────────────────────────
  ipcMain.handle('security:reboot', async (_event, { serverName, password }) => {
    if (!validateAdminPassword(password)) {
      return { success: false, error: 'Contraseña de administrador incorrecta.' };
    }

    try {
      const config = await getConfig();
      const serverConfig = findDestinationServer(config, serverName);
      const sshService = getSshService();

      await rebootServer(sshService, serverConfig.sshCredentials);
      console.log(`[SECURITY] Reboot ejecutado en "${serverName}".`);
      return { success: true };
    } catch (error) {
      console.error('[SECURITY] Error en reboot:', error.message);
      return { success: false, error: error.message };
    }
  });

  // ── Shutdown del servidor ─────────────────────────────────────────────────
  ipcMain.handle('security:shutdown', async (_event, { serverName, password }) => {
    if (!validateAdminPassword(password)) {
      return { success: false, error: 'Contraseña de administrador incorrecta.' };
    }

    try {
      const config = await getConfig();
      const serverConfig = findDestinationServer(config, serverName);
      const sshService = getSshService();

      await shutdownServer(sshService, serverConfig.sshCredentials);
      console.log(`[SECURITY] Shutdown ejecutado en "${serverName}".`);
      return { success: true };
    } catch (error) {
      console.error('[SECURITY] Error en shutdown:', error.message);
      return { success: false, error: error.message };
    }
  });

  // ── Reset masivo de contraseñas ───────────────────────────────────────────
  ipcMain.handle('security:credential-reset', async (_event, { serverName, password, username, newPassword }) => {
    if (!validateAdminPassword(password)) {
      return { success: false, error: 'Contraseña de administrador incorrecta.' };
    }

    if (!username || !newPassword) {
      return { success: false, error: 'Usuario y nueva contraseña son obligatorios.' };
    }

    try {
      const config = await getConfig();
      const serverConfig = findDestinationServer(config, serverName);
      const sshService = getSshService();

      const onProgress = (progressData) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('security:credential-progress', progressData);
        }
      };

      const result = await massiveCredentialReset(
        sshService,
        serverConfig.sshCredentials,
        username,
        newPassword,
        onProgress
      );

      return {
        success: true,
        total: result.total,
        updated: result.updated,
        errors: result.errors,
      };
    } catch (error) {
      console.error('[SECURITY] Error en credential reset:', error.message);
      return { success: false, error: error.message };
    }
  });
}

module.exports = { registerSecurityHandlers };
