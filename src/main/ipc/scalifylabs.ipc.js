'use strict';

/**
 * @file scalifylabs.ipc.js
 * @description Handlers IPC para el módulo ScalifyLabs.
 *
 * Canales:
 *  - scalify:deploy          (invoke) → Inicia el despliegue completo orquestado.
 *  - config:get-github-token (invoke) → Devuelve el token GitHub guardado (obfuscado).
 *  - config:set-github-token (invoke) → Persiste el token GitHub en config.
 *
 * Evento emitido al renderer:
 *  - scalify:progreso        (send)   → Actualizaciones de progreso en tiempo real.
 */

const { getConfigManager } = require('../../services/config-manager');
const { orchestrarDespliegue } = require('../../services/scalifylabs/deployOrchestrator');

// ─── Helper: config garantizada ──────────────────────────────────────────────
async function getConfig() {
  const mgr = getConfigManager();
  if (!mgr.getConfig()) await mgr.initialize();
  return mgr.getConfig();
}

// ─── Helper: buscar servidor destino por nombre ───────────────────────────────
function encontrarServidorDestino(config, serverName) {
  const servidor = config.destinationServers?.find(s => s.name === serverName);
  if (!servidor) {
    throw new Error(`Servidor destino "${serverName}" no encontrado en la configuración.`);
  }
  return servidor;
}

// ─────────────────────────────────────────────────────────────────────────────
function registerScalifylabsHandlers(ipcMain, mainWindow) {

  // ── Obtener GitHub Token (obfuscado para UI) ──────────────────────────────
  ipcMain.handle('config:get-github-token', async () => {
    try {
      const config = await getConfig();
      const raw = config?.github?.apiToken || '';
      if (!raw) return { success: true, token: '', obfuscated: '' };

      const obfuscated = raw.length > 8
        ? raw.slice(0, 4) + '****' + raw.slice(-4)
        : '****';
      return { success: true, token: raw, obfuscated };
    } catch (error) {
      console.error('[SCALIFY:IPC] Error al leer GitHub token:', error.message);
      return { success: false, error: error.message, token: '', obfuscated: '' };
    }
  });

  // ── Guardar GitHub Token ───────────────────────────────────────────────────
  ipcMain.handle('config:set-github-token', async (event, { token }) => {
    try {
      if (!token || typeof token !== 'string' || !token.trim()) {
        return { success: false, error: 'El token de GitHub no puede estar vacío.' };
      }

      const mgr = getConfigManager();
      await mgr.initialize();
      const cfg = mgr.getConfig();
      cfg.github = cfg.github || {};
      cfg.github.apiToken = token.trim();
      await mgr.saveConfig();

      console.log('[SCALIFY:IPC] GitHub API Token guardado correctamente.');

      // Notificar UI del cambio de config
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('config:updated', {
          success: true,
          config: mgr.getConfig(),
        });
      }

      return { success: true };
    } catch (error) {
      console.error('[SCALIFY:IPC] Error al guardar GitHub token:', error.message);
      return { success: false, error: error.message };
    }
  });

  // ── Iniciar despliegue ScalifyLabs ────────────────────────────────────────
  ipcMain.handle('scalify:deploy', async (event, params) => {
    const {
      serverName,   // Nombre del servidor destino configurado en la app
      domain,       // Dominio Plesk a configurar
      httpsUrl,     // URL HTTPS del repositorio GitHub
      repoOwner,    // Propietario del repo
      repoName,     // Nombre del repo
      vincularGitHub = true,  // Si false, omite la vinculación de llave SSH
      rama = 'main',
    } = params || {};

    // Validar parámetros obligatorios
    if (!serverName || !domain || !httpsUrl || !repoOwner || !repoName) {
      return {
        success: false,
        error: 'Parámetros obligatorios faltantes: serverName, domain, httpsUrl, repoOwner, repoName.',
      };
    }

    let ssh = null;
    try {
      // Recuperar configuración del servidor y el token de GitHub
      const config = await getConfig();
      const servidorConfig = encontrarServidorDestino(config, serverName);
      const githubToken = config?.github?.apiToken || '';

      if (vincularGitHub && !githubToken) {
        return {
          success: false,
          error: 'No hay un GitHub API Token configurado. Ve a Configuración → Integraciones Externas para guardarlo.',
        };
      }

      // Notificar inicio al renderer
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('scalify:progreso', {
          paso: 'inicio',
          progreso: 0,
          mensaje: `[SCALIFY] Conectando a ${servidorConfig.sshCredentials?.host || serverName}...`,
          domain,
        });
      }

      // ── Conexión SSH (reutilizando resolución de llaves de ssh-service) ──
      const { NodeSSH } = require('node-ssh');
      const { getSshService } = require('../../services/ssh-service');
      ssh = new NodeSSH();

      const creds = servidorConfig.sshCredentials || {};
      const sshSvc = getSshService();

      // Resolver la llave privada con la misma cadena que usan Migración/DNS/SSL:
      //   1. creds.privateKey (contenido PEM directo)
      //   2. creds.privateKeyPath / creds.keyPath (ruta explícita del servidor)
      //   3. config.sshKeys.privateKeyPath (ruta global de la app)
      //   4. Auto-detect en ~/.ssh/ (id_rsa, id_ed25519, etc.)
      const resolvedKey = sshSvc._resolvePrivateKey({
        privateKey: creds.privateKey,
        privateKeyPath: creds.privateKeyPath || creds.keyPath,
      });

      const sshOptions = {
        host: creds.host,
        port: creds.port || 22,
        username: creds.username || 'root',
        readyTimeout: 20000,
        keepaliveInterval: 10000,
      };

      if (resolvedKey) {
        sshOptions.privateKey = resolvedKey;
        console.log(`[SCALIFY:SSH] Llave privada resuelta (${resolvedKey.substring(0, 30)}...)`);
      } else if (creds.password) {
        sshOptions.password = creds.password;
        console.log('[SCALIFY:SSH] Usando autenticación por password');
      } else {
        throw new Error(
          'No se encontró llave SSH ni password. Verifica que exista una llave privada en ' +
          'la configuración del servidor o en Configuración → Llaves SSH.'
        );
      }

      if (creds.passphrase) {
        sshOptions.passphrase = creds.passphrase;
      }

      console.log(`[SCALIFY:SSH] Conectando a ${sshOptions.host}:${sshOptions.port} como "${sshOptions.username}"...`);
      await ssh.connect(sshOptions);
      console.log(`[SCALIFY:IPC] Conexión SSH establecida con "${serverName}". Iniciando orquestación...`);

      // Construir callback de progreso que emite al renderer en tiempo real
      const onProgreso = (evento) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('scalify:progreso', evento);
        }
      };

      // Ejecutar el orquestador completo
      const resultado = await orchestrarDespliegue(
        ssh,
        { domain, httpsUrl, repoOwner, repoName, githubToken, vincularGitHub, rama },
        onProgreso
      );

      return {
        success: resultado.exito,
        versionNode: resultado.versionNode,
        urlSsh: resultado.urlSsh,
        llavePub: resultado.llavePub,
        error: resultado.error,
        taskId: resultado.taskId,
      };

    } catch (error) {
      console.error('[SCALIFY:IPC] Error en scalify:deploy:', error.message);

      // Notificar error al renderer
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('scalify:progreso', {
          paso: 'error-fatal',
          progreso: 0,
          mensaje: `[ERROR] ${error.message}`,
          domain,
        });
      }

      return { success: false, error: error.message };
    } finally {
      // Siempre cerrar la conexión SSH al terminar
      if (ssh) {
        try { ssh.dispose(); } catch (_) { /* no crítico */ }
      }
    }
  });
}

module.exports = { registerScalifylabsHandlers };
