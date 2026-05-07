// IPC Handlers: Malware Scanner (audit + clean)
// v1.20.1: isProtected + scanner:run-harden para proteger dominios limpios
// scanner:run-audit, scanner:run-clean, scanner:run-harden

const { getSshService } = require('../../services/ssh-service');
const { getConfigManager } = require('../../services/config-manager');
const { runAudit, runClean, runHarden } = require('../../services/audit-service');
const { getStandardEmitter } = require('../../services/standard-emitter');
const { getAppStateManager } = require('../state/AppStateManager');

const EMIT = getStandardEmitter('scanner');

// Hook names de WordPress que son legítimos
const WP_SAFE_CRON_PREFIXES = [
  'wp_', 'wp_version', 'wp_update', 'wp_scheduled', 'wp_privacy',
  'publish_', 'transition_', 'delete_', 'trash_', 'untrash_',
  'auto_core_update', 'recovery_mode', 'wp_maybe_auto_update',
  'wp_https_detection', 'wp_site_health', 'action_scheduler',
  'woocommerce_', 'elementor_', 'wordfence_', 'aios_', 'aiowps_',
  'jetpack_', 'rank_math', 'yoast_', 'akismet_', 'wpseo_',
];

/**
 * Filtra admins fantasma: excluye dev, administrador y el base del dominio.
 * Si un admin protegido tiene +20 posts, se agrega a protectedAdminWarnings
 * con sus 5 posts más recientes (LIFO) para revisión forense.
 * @param {Array} admins - Lista de admins desde WP-CLI
 * @param {string} domain - Dominio auditado
 * @param {Array<{id: number, login: string, count: number}>} [adminPostCounts] - Conteo de posts por admin
 * @param {Array<{post_author: string, post_title: string, post_date: string}>} [recentPosts] - Últimos 100 posts del sitio
 * @returns {{ ghostAdmins: Array, protectedWarnings: Array }}
 */
function filterGhostAdmins(admins, domain, adminPostCounts, recentPosts) {
  const result = { ghostAdmins: [], protectedWarnings: [] };
  if (!Array.isArray(admins) || admins.length === 0) return result;

  const baseDomain = domain.split('.')[0];
  const safeLogins = new Set(['dev', 'administrador', baseDomain]);

  // Mapa de conteo de posts: id -> count
  const postCountMap = new Map();
  if (Array.isArray(adminPostCounts)) {
    adminPostCounts.forEach(a => postCountMap.set(a.id, a.count));
  }

  for (const admin of admins) {
    if (safeLogins.has(admin.user_login)) {
      const count = postCountMap.get(admin.ID) || 0;
      if (count > 20) {
        // Filtra posts recientes de este admin (LIFO: ya vienen ordenados DESC por fecha)
        const adminIdStr = String(admin.ID);
        const latestPosts = (Array.isArray(recentPosts) ? recentPosts : [])
          .filter(p => String(p.post_author) === adminIdStr)
          .slice(0, 5)
          .map(p => ({ title: p.post_title, date: p.post_date }));

        result.protectedWarnings.push({
          ID: admin.ID,
          user_login: admin.user_login,
          user_email: admin.user_email,
          postCount: count,
          latestPosts,
        });
      }
    } else {
      result.ghostAdmins.push(admin);
    }
  }

  return result;
}

/**
 * Filtra crons sospechosos:
 * - Nombres tipo MD5 (32 caracteres hex)
 * - Nombres muy largos (> 80 chars)
 * - Nombres que NO empiecen con ningún prefijo seguro
 */
function filterSuspiciousCrons(crons) {
  if (!Array.isArray(crons) || crons.length === 0) return [];
  const md5Regex = /^[a-f0-9]{32}$/;

  const scored = crons.map(cron => {
    const hook = cron.hook || '';
    let suspicion = 0;

    // MD5 hash como nombre
    if (md5Regex.test(hook)) suspicion += 3;
    // Muy largo
    if (hook.length > 80) suspicion += 2;
    // No coincide con prefijos seguros
    const hasSafePrefix = WP_SAFE_CRON_PREFIXES.some(p => hook.startsWith(p));
    if (!hasSafePrefix) suspicion += 1;

    return { ...cron, _suspicion: suspicion };
  });

  return scored
    .filter(c => c._suspicion > 0)
    .sort((a, b) => b._suspicion - a._suspicion)
    .slice(0, 10)
    .map(({ _suspicion, ...rest }) => rest); // quita el score interno
}

function registerScannerHandlers(ipcMain, mainWindow, scope) {
  const { isOperationRunning } = scope;

  /**
   * scanner:init-pending — Frontend notifica al backend los dominios que va a procesar.
   * Así AppStateManager.malware tiene la lista completa desde el inicio y la hidratación
   * no sobreescribe con resultados parciales.
   */
  ipcMain.handle('scanner:init-pending', async (event, { domains }) => {
    const appState = getAppStateManager();
    appState.update('malware', {
      isRunning: true,
      results: domains.map(d => ({ domain: d, status: 'pending', message: 'En cola...' })),
    });
    return { success: true };
  });

  /**
   * scanner:finish — Frontend notifica que terminó de procesar todos los dominios.
   */
  ipcMain.handle('scanner:finish', async () => {
    getAppStateManager().update('malware', { isRunning: false });
    return { success: true };
  });

  /**
   * scanner:run-audit — Run a read-only audit on a single domain.
   * Returns enriched result with ghostAdmins, suspiciousCrons, htaccessLines.
   */
  ipcMain.handle('scanner:run-audit', async (event, { domain, serverName }) => {
    try {
      const configManager = getConfigManager();
      await configManager.initialize();
      const config = configManager.getConfig();
      const serverConfig = config.destinationServers?.find(s => s.name === serverName);
      if (!serverConfig) {
        return { domain, error: `Server "${serverName}" not found` };
      }

      const sshService = getSshService();
      const client = await sshService.connect(serverConfig.sshCredentials, `audit-${domain}-${Date.now()}`);
      try {
        EMIT.info(`Iniciando auditoría para ${domain}`, domain);
        const result = await runAudit(client, domain);
        EMIT.log(result.risk > 0 ? 'warn' : 'success', `Riesgo: ${result.risk || 0}`, domain);

        // Filtrado inteligente en Node.js
        const filtered = filterGhostAdmins(result.raw_admins, domain, result.adminPostCounts, result.recentPosts);
        result.ghostAdmins = filtered.ghostAdmins;
        result.protectedWarnings = filtered.protectedWarnings;
        result.suspiciousCrons = filterSuspiciousCrons(result.raw_crons);
        result.htaccessLines = result.htaccess_raw
          ? result.htaccess_raw.split('\n').filter(Boolean)
          : [];

        // Limpia los campos raw
        delete result.raw_admins;
        delete result.raw_crons;
        delete result.htaccess_raw;
        delete result.adminPostCounts;
        delete result.recentPosts;

        // ── Persistir en estado global ──
        const appState = getAppStateManager();
        const current = appState.getState('malware');
        const existing = (current.results || []).filter(r => r.domain !== domain);
        existing.push({ domain, status: result.risk > 0 ? 'infected' : 'clean', message: result.error || `Riesgo: ${result.risk || 0}` });
        appState.update('malware', { results: existing });

        return result;
      } finally {
        await sshService.disconnect(client);
      }
    } catch (error) {
      EMIT.error(`Auditoría falló: ${error.message}`, domain);
      return { domain, error: error.message };
    }
  });

  /**
   * scanner:run-clean — Run clean on a single domain after audit found infection.
   */
  ipcMain.handle('scanner:run-clean', async (event, { domain, serverName, ghostAdminsConfig }) => {
    try {
      const configManager = getConfigManager();
      await configManager.initialize();
      const config = configManager.getConfig();
      const serverConfig = config.destinationServers?.find(s => s.name === serverName);
      if (!serverConfig) {
        return { domain, error: `Server "${serverName}" not found` };
      }

      const sshService = getSshService();
      const client = await sshService.connect(serverConfig.sshCredentials, `clean-${domain}-${Date.now()}`);
      try {
        EMIT.info(`Iniciando limpieza para ${domain}`, domain);
        const onProgress = (payload) => {
          EMIT.info(payload.msg, domain);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('scanner:clean-progress', { domain, step: payload.step, msg: payload.msg });
          }
        };
        const result = await runClean(client, domain, ghostAdminsConfig || [], onProgress);
        EMIT.log(result.success ? 'success' : 'error', result.success ? 'Limpieza completada' : (result.error || 'Falló'), domain);

        // ── Persistir en estado global ──
        const appState = getAppStateManager();
        const current = appState.getState('malware');
        const existing = (current.results || []).filter(r => r.domain !== domain);
        existing.push({ domain, status: result.success ? 'cleaned' : 'infected', message: result.error || 'Limpiado' });
        appState.update('malware', { results: existing });

        return result;
      } finally {
        await sshService.disconnect(client);
      }
    } catch (error) {
      EMIT.error(`Limpieza falló: ${error.message}`, domain);
      return { domain, error: error.message };
    }
  });

  /**
   * scanner:run-harden — Apply hardening only (no clean) on a domain.
   * Streams progress via scanner:clean-progress.
   */
  ipcMain.handle('scanner:run-harden', async (event, { domain, serverName }) => {
    try {
      const configManager = getConfigManager();
      await configManager.initialize();
      const config = configManager.getConfig();
      const serverConfig = config.destinationServers?.find(s => s.name === serverName);
      if (!serverConfig) {
        return { domain, error: `Server "${serverName}" not found` };
      }

      const sshService = getSshService();
      const client = await sshService.connect(serverConfig.sshCredentials, `harden-${domain}-${Date.now()}`);
      try {
        EMIT.info(`Iniciando protección para ${domain}`, domain);
        const onProgress = (payload) => {
          EMIT.info(payload.msg, domain);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('scanner:clean-progress', { domain, step: payload.step, msg: payload.msg });
          }
        };
        const result = await runHarden(client, domain, onProgress);
        EMIT.success(`Protección completada`, domain);

        // ── Persistir en estado global ──
        const appState = getAppStateManager();
        const current = appState.getState('malware');
        const existing = (current.results || []).filter(r => r.domain !== domain);
        existing.push({ domain, status: result.success ? 'clean' : 'error', message: result.error || 'Protegido', isProtected: true });
        appState.update('malware', { results: existing });

        return result;
      } finally {
        await sshService.disconnect(client);
      }
    } catch (error) {
      EMIT.error(`Protección falló: ${error.message}`, domain);
      return { domain, error: error.message };
    }
  });
}

module.exports = { registerScannerHandlers };
