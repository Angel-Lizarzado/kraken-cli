'use strict';

/**
 * @file fleet.ipc.js
 * @description Handlers IPC para el Command Center — acciones de flota.
 *
 * Canales (invoke):
 *   fleet:get-log       → tail -n 500 /var/log/plesk/panel.log via SSH
 *   fleet:run-action    → ejecuta acciones de mantenimiento de flota
 *   fleet:scan-health   → HTTP HEAD scan de todos los dominios del servidor
 */

const https = require('https');
const http = require('http');
const { getConfigManager } = require('../../services/config-manager');
const { getSshService } = require('../../services/ssh-service');
const { diagnosticarSitio } = require('../../services/diagnostico-sitio');

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getConfig() {
  const mgr = getConfigManager();
  if (!mgr.getConfig()) await mgr.initialize();
  return mgr.getConfig();
}

function findServer(config, serverName) {
  const s = config.destinationServers?.find(s => s.name === serverName);
  if (!s) throw new Error(`Servidor "${serverName}" no encontrado en la configuración`);
  return s;
}

// ─── HTTP check de un dominio ─────────────────────────────────────────────────

const DNS_ERRORS = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NONAME']);

// User-Agent real de Chrome Desktop — evita que el servidor devuelva
// una página de error diferente a la que vería un usuario real.
const CHROME_UA = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  'AppleWebKit/537.36 (KHTML, like Gecko)',
  'Chrome/124.0.0.0 Safari/537.36',
].join(' ');

// Patrones de soft error: el servidor responde 200 pero el body contiene
// una página de error de Plesk, Nginx o PHP. Sin esta detección el
// escaner reporta OK cuando en realidad el sitio está caído.
//
// WP_FATAL_RE — se evalúa ANTES de SOFT_ERROR_RE. Cuando hace match, el
// error se clasifica como 'wp-fatal' y la acción recomendada es 'wp-safe-mode'
// (desactivar plugins vía WP-CLI), no un repair de Plesk.
const WP_FATAL_RE = [
  /error cr\u00edtico en esta web/i,
  /critical error on this website/i,
  /there has been a critical error/i,
  /wp-admin\/includes\/nonce\.php/i, // common WP fatal trace in body
];

const SOFT_ERROR_RE = [
  /403[\s\S]{0,30}Forbidden/i,
  /Server\s+Error/i,
  /Internal\s+Server\s+Error/i,
  /Plesk\s+Default\s+Page/i,
  /Service\s+Unavailable/i,
  /<title>[\s\S]{0,80}(error|forbidden|not\s+found|unavailable|503|502)[\s\S]{0,80}<\/title>/i,
];

// Lee hasta maxBytes del body de respuesta y destruye el socket.
// Evita descargar páginas grandes — solo necesitamos ver el <head>.
function readBodySample(res, maxBytes = 2000) {
  return new Promise((resolve) => {
    let data = '';
    const onData = (chunk) => {
      data += chunk.toString();
      if (data.length >= maxBytes) {
        res.removeListener('data', onData);
        res.destroy();
        resolve(data.slice(0, maxBytes));
      }
    };
    res.on('data', onData);
    res.on('end', () => resolve(data.slice(0, maxBytes)));
    res.on('error', () => resolve(data.slice(0, maxBytes)));
  });
}

// checkDomain: GET con User-Agent real + detección de soft errors.
// HEAD era más rápido pero ciego a páginas de error enmascaradas como 200.
// timeout: 45s — tiempo suficiente para servidores lentos sin bloquear el scan.
function checkDomain(domain, timeoutMs = 45000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tryReq = (proto) => {
      const mod = proto === 'https:' ? https : http;
      const req = mod.request(
        {
          hostname: domain, path: '/', method: 'GET', timeout: timeoutMs,
          headers: {
            'User-Agent': CHROME_UA,
            'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
          },
        },
        async (res) => {
          const status = res.statusCode;
          const duration = Date.now() - start;
          if (status === 200) {
            const body = await readBodySample(res);
            if (WP_FATAL_RE.some(re => re.test(body))) {
              // WP Fatal Error: HTTP 200 pero WordPress lanzó un error crítico.
              // Necesita desactivación de plugins, no repair de Plesk.
              resolve({ domain, status: 200, duration, error: 'wp-fatal' });
            } else if (SOFT_ERROR_RE.some(re => re.test(body))) {
              resolve({ domain, status: 200, duration, error: 'soft-error' });
            } else {
              resolve({ domain, status, duration, error: null });
            }
          } else {
            res.destroy();
            resolve({ domain, status, duration, error: null });
          }
        }
      );
      req.on('timeout', () => { req.destroy(); resolve({ domain, status: null, duration: timeoutMs, error: 'timeout' }); });
      req.on('error', (err) => {
        if (DNS_ERRORS.has(err.code)) {
          resolve({ domain, status: null, duration: Date.now() - start, error: 'dns' });
        } else if (proto === 'https:') {
          tryReq('http:');
        } else {
          resolve({ domain, status: null, duration: Date.now() - start, error: err.code || err.message });
        }
      });
      req.end();
    };
    tryReq('https:');
  });
}

// Mapea resultado HTTP → acción recomendada
// repair-full = plesk repair fs + repair web por dominio
function recommendAction(result) {
  const { status, error } = result;
  if (error === 'dns') return null;
  if (error === 'wp-fatal') return 'wp-safe-mode'; // WP fatal → desactivar plugins
  if (error === 'soft-error') return 'repair-full';  // body de error genérico
  if (error === 'timeout') return 'repair-full';
  if (status === 403) return 'repair-full';  // permisos de FS
  if (status === 500 || status === 503) return 'repair-full';
  if (status === 502) return 'restart-php';
  if (status === 504) return 'restart-nginx';
  if (status >= 400) return 'repair-full';
  return null; // 2xx/3xx = OK
}


// Semáforo simple
function createSem(max) {
  let n = 0; const q = [];
  return {
    async acquire() { if (n < max) { n++; return; } return new Promise(r => q.push(r)); },
    release() { n--; if (q.length) { n++; q.shift()(); } },
  };
}

// ─── Acciones disponibles ─────────────────────────────────────────────────────

const FLEET_ACTIONS = {
  // Reparación combinada FS+Web por dominio.
  'repair-full': {
    label: 'Plesk Repair Full (Web+FS)',
    cmd: 'plesk repair fs -y 2>&1 && plesk repair web -y 2>&1',
    cmdFn: (domain) => `plesk repair fs ${domain} -y 2>&1 && plesk repair web ${domain} -y 2>&1`,
  },

  // WP Safe Mode: desactiva todos los plugins para revivir un WP con fatal error.
  'wp-safe-mode': {
    label: 'WP Safe Mode (desactivar plugins)',
    cmd: 'echo "wp-safe-mode requiere dominio específico"',
    cmdFn: (domain) => [
      `wp plugin deactivate --all`,
      `--path=/var/www/vhosts/${domain}/httpdocs`,
      `--allow-root`,
      `2>&1`,
    ].join(' '),
  },

  'mysql-optimize': {
    label: 'MySQL Optimize (todas las DBs)',
    cmd: 'mysqlcheck --optimize --all-databases --user=admin $(cat /etc/psa/.psa.shadow | tr -d "\\n" | xargs -I{} echo "-p{}") 2>&1 | tail -n 20',
  },

  'restart-nginx': {
    label: 'Reiniciar Nginx',
    cmd: 'systemctl restart nginx 2>&1 && echo "✓ Nginx reiniciado"',
  },

  'restart-apache': {
    label: 'Reiniciar Apache',
    // Agrupamos con paréntesis para atrapar correctamente el &&
    cmd: '(systemctl restart httpd || systemctl restart apache2) 2>&1 && echo "✓ Apache reiniciado"',
  },

  'restart-php': {
    label: 'Reiniciar PHP-FPM (Todas las versiones)',
    // El wildcard * fuerza a systemd a reiniciar cualquier servicio que coincida, limpiando la caché global
    cmd: 'systemctl restart plesk-php*-fpm.service 2>&1 && echo "✓ Todos los manejadores PHP-FPM reiniciados (Memoria liberada)"',
  },
};



// ─── Registro de handlers ─────────────────────────────────────────────────────

function registerFleetHandlers(ipcMain, mainWindow) {

  const emit = (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  };

  // ── Obtener tail del panel.log ────────────────────────────────────────────
  ipcMain.handle('fleet:get-log', async (_event, { serverName, lines = 500 }) => {
    let client = null;
    try {
      const config = await getConfig();
      const server = findServer(config, serverName);
      const ssh = getSshService();
      client = await ssh.connectCached(server.sshCredentials);
      const result = await ssh.executeCommand(
        client,
        `tail -n ${lines} /var/log/plesk/panel.log 2>/dev/null || echo "[SIN LOG] /var/log/plesk/panel.log no encontrado"`,
        { timeout: 30000 }
      );
      return { success: true, log: result.stdout || '' };
    } catch (err) {
      return { success: false, error: err.message };
    } finally {
      // disconnect omitido (manejado por el pool de conexión)
    }
  });

  // ── Ejecutar acción de flota ──────────────────────────────────────────────
  ipcMain.handle('fleet:run-action', async (_event, { serverName, action }) => {
    const actionDef = FLEET_ACTIONS[action];
    if (!actionDef) return { success: false, error: `Acción desconocida: "${action}"` };
    let client = null;
    try {
      const config = await getConfig();
      const server = findServer(config, serverName);
      const ssh = getSshService();
      console.log(`[FLEET:ACTION] "${actionDef.label}" en "${serverName}"`);
      client = await ssh.connectCached(server.sshCredentials);
      const result = await ssh.executeCommand(client, actionDef.cmd, { timeoutMs: 120000 });
      return {
        success: result.code === 0 || result.code === null,
        output: result.stdout || result.stderr || '(sin salida)',
        label: actionDef.label,
      };
    } catch (err) {
      return { success: false, error: err.message, label: actionDef?.label };
    } finally {
      // disconnect omitido (manejado por el pool)
    }
  });

  // ── Smart Health Scan ─────────────────────────────────────────────────────
  // 1. Obtiene dominios activos via plesk db
  // 2. HTTP HEAD concurrente con semáforo (default 15)
  // 3. Mapea código → acción recomendada
  // 4. Emite fleet:health-progress por dominio
  ipcMain.handle('fleet:scan-health', async (_event, { serverName, targetDomain, concurrency = 15 }) => {
    let client = null;
    try {
      const config = await getConfig();
      const server = findServer(config, serverName);
      const ssh = getSshService();

      client = await ssh.connectCached(server.sshCredentials);
      
      let rawDomains = [];
      if (targetDomain && typeof targetDomain === 'string' && targetDomain.trim().length > 0) {
        rawDomains = [targetDomain.trim()];
      } else {
        const dbRes = await ssh.executeCommand(client,
          `plesk db -sNe "SELECT name FROM domains WHERE status=0 ORDER BY name"`,
          { timeoutMs: 30000 }
        );
        rawDomains = dbRes.stdout.split('\n').map(d => d.trim()).filter(Boolean);
      }
      
      // disconnect omitido (manejado por el pool)

      // Dedup via Set: Plesk puede devolver duplicados cuando un dominio tiene
      // aliases o entradas múltiples en la tabla domains. El Set elimina
      // duplicados en la fuente — sin esto el frontend recibe N eventos
      // por el mismo dominio y React lanza 90k "duplicate key" warnings.
      const domains = [...new Set(rawDomains)];
      if (!domains.length) return { success: true, results: [] };

      emit('fleet:health-progress', { type: 'scan-start', total: domains.length });

      const sem = createSem(concurrency);
      const results = [];
      let processed = 0;

      await Promise.all(domains.map(async (domain) => {
        await sem.acquire();
        try {
          const r = await checkDomain(domain);
          r.recommendation = recommendAction(r);
          results.push(r);
          processed++;
          emit('fleet:health-progress', {
            type: 'domain-checked', domain,
            status: r.status, error: r.error,
            recommendation: r.recommendation,
            processed, total: domains.length,
          });
        } finally { sem.release(); }
      }));

      const failed = results.filter(r => r.recommendation !== null && r.error !== 'dns');
      emit('fleet:health-progress', {
        type: 'scan-done', total: domains.length,
        ok: domains.length - failed.length, failed: failed.length,
      });

      return { success: true, results };

    } catch (err) {
      return { success: false, error: err.message };
    } finally {
      // disconnect omitido (manejado por el pool)
    }
  });

  // ── Deduplicated batch executor ───────────────────────────────────────────
  //
  // Payload: { serverName, sites: Array<{ domain, recommendation }> }
  //
  // Algoritmo:
  //   Phase 1 — DOMAIN_ACTIONS (repair-fs, repair-web):
  //     Agrupa dominios por acción. Para cada grupo:
  //       1. Emite fleet:domain-status { domain, status:'processing' } por cada dominio
  //       2. Ejecuta el comando Plesk UNA VEZ (Plesk repair es server-wide)
  //       3. Emite fleet:domain-status { domain, status:'ok'|'error' } por cada dominio
  //     Ejecución: for...of secuencial — NO Promise.all. plesk repair web/fs
  //     puede tardar varios minutos y ejecutarlo en paralelo tumba el servidor.
  //
  //   Phase 2 — SERVER_ACTIONS (restarts, mysql-optimize):
  //     Set deduplicado, ejecuta cada uno EXACTAMENTE UNA VEZ.
  //     Siempre DESPUÉS de domain actions para evitar double-restart.
  //
  // Canales emitidos:
  //   fleet:domain-status  { domain, status: 'processing'|'ok'|'error', action }
  //   fleet:batch-progress { type: 'phase-start', phase, label }
  //   fleet:batch-progress { type: 'action-start', action, label, domains? }
  //   fleet:batch-progress { type: 'action-done',  action, label, success, output }
  //   fleet:batch-progress { type: 'batch-done' }

  const DOMAIN_ACTIONS = new Set(['repair-fs', 'repair-web']);
  const SERVER_ACTIONS = new Set(['restart-nginx', 'restart-apache', 'restart-php', 'mysql-optimize']);

  ipcMain.handle('fleet:run-deduped-batch', async (_event, { serverName, sites }) => {
    if (!sites?.length) return { success: true, message: 'No sites provided' };

    let client = null;
    try {
      const config = await getConfig();
      const server = findServer(config, serverName);
      const ssh = getSshService();

      // Categorizar: agrupar dominios por acción solicitada
      /** @type {Map<string, string[]>} acción → lista de dominios */
      const domainActionMap = new Map();
      const serverActionSet = new Set();

      for (const { domain, recommendation } of sites) {
        if (!recommendation) continue;
        if (DOMAIN_ACTIONS.has(recommendation)) {
          const list = domainActionMap.get(recommendation) || [];
          list.push(domain);
          domainActionMap.set(recommendation, list);
        }
        if (SERVER_ACTIONS.has(recommendation)) serverActionSet.add(recommendation);
      }

      client = await ssh.connectCached(server.sshCredentials);

      // Helper: ejecuta un comando y emite progreso al acordeón.
      // Si la acción tiene cmdFn (repair-full), ejecuta POR DOMINIO secuencialmente.
      // Si tiene solo cmd (restarts), ejecuta el comando server-wide una vez.
      const runAction = async (actionId, affectedDomains = []) => {
        const def = FLEET_ACTIONS[actionId];
        if (!def) return false;

        if (def.cmdFn && affectedDomains.length > 0) {
          // ── Modo per-dominio (repair-full) ─────────────────────────────────────
          // Cada dominio tiene su propia invocación Plesk — loop for...of
          // para no sobrecargar el servidor con comandos paralelos.
          let allSuccess = true;
          for (const domain of affectedDomains) {
            emit('fleet:domain-status', { domain, status: 'processing', action: actionId });
            emit('fleet:batch-progress', {
              type: 'action-start', action: actionId,
              label: `${def.label} → ${domain}`, domain,
            });

            let repairOutput = '';
            try {
              const result = await ssh.executeCommand(client, def.cmdFn(domain), { timeout: 300000 });
              repairOutput = (result.stdout || result.stderr || '').slice(0, 200);
              const repairOk = result.code === 0 || result.code === null;
              emit('fleet:batch-progress', {
                type: 'action-done', action: actionId,
                label: `${def.label} → ${domain}`, domain,
                success: repairOk, output: repairOutput,
              });
            } catch (err) {
              const isTimeout = /timeout|ETIMEDOUT|ESOCKETTIMEDOUT/i.test(err.message || '');
              repairOutput = isTimeout
                ? 'Timeout (>5min): el servidor no respondió a tiempo'
                : (err.message || 'Error desconocido').slice(0, 200);
              emit('fleet:batch-progress', {
                type: 'action-done', action: actionId,
                label: `${def.label} → ${domain}`, domain,
                success: false, output: repairOutput,
              });
              // Loop sigue aunque el repair falle — el rescan confirmará el estado
            }

            // ── Post-repair auto-rescan ─────────────────────────────────────────
            // No confiamos en el exit code de Bash como indicador de éxito real.
            // Hacemos una segunda llamada HTTP para verificar el estado actual del sitio.
            emit('fleet:batch-progress', {
              type: 'action-start', action: 'rescan',
              label: `Re-escan → ${domain}`, domain,
            });
            let rescan;
            try {
              rescan = await checkDomain(domain);
              rescan.recommendation = recommendAction(rescan);
            } catch {
              rescan = { domain, status: null, error: 'timeout', duration: 0, recommendation: 'repair-full' };
            }

            const domainOk = rescan.error === null && rescan.status !== null && rescan.status < 400;
            const domainStatus = domainOk ? 'ok' : (rescan.error === 'timeout' ? 'timeout' : 'error');

            emit('fleet:batch-progress', {
              type: 'action-done', action: 'rescan',
              label: `Re-escan → ${domain}`, domain,
              success: domainOk,
              output: domainOk
                ? `HTTP ${rescan.status} OK — sitio restaurado ✓`
                : `HTTP ${rescan.status ?? '?'} ${rescan.error ?? ''} — aún con problemas`,
            });

            // Emitir con payload 'rescan' para que el frontend actualice
            // la columna Estado y Recomendación de la fila en tiempo real.
            emit('fleet:domain-status', {
              domain, status: domainStatus, action: actionId,
              rescan: {
                status: rescan.status,
                error: rescan.error,
                recommendation: rescan.recommendation ?? null,
                duration: rescan.duration,
              },
            });

            if (!domainOk) allSuccess = false;
          }
          return allSuccess;
        }

        // ── Modo server-wide (restarts, mysql-optimize) ─────────────────────────
        // El comando no acepta dominio — se ejecuta una sola vez para el servidor.
        for (const domain of affectedDomains) {
          emit('fleet:domain-status', { domain, status: 'processing', action: actionId });
        }
        emit('fleet:batch-progress', {
          type: 'action-start', action: actionId, label: def.label,
          domains: affectedDomains,
        });
        let success = false;
        try {
          const result = await ssh.executeCommand(client, def.cmd, { timeout: 180000 });
          success = result.code === 0 || result.code === null;
          emit('fleet:batch-progress', {
            type: 'action-done', action: actionId, label: def.label,
            success, output: (result.stdout || result.stderr || '').slice(0, 300),
          });
        } catch (err) {
          emit('fleet:batch-progress', {
            type: 'action-done', action: actionId, label: def.label,
            success: false, output: err.message,
          });
        }
        for (const domain of affectedDomains) {
          emit('fleet:domain-status', { domain, status: success ? 'ok' : 'error', action: actionId });
        }
        return success;
      };


      // ── Phase 1: Domain repairs — secuencial, con progreso por dominio ────
      if (domainActionMap.size > 0) {
        const totalDomains = [...domainActionMap.values()].reduce((n, arr) => n + arr.length, 0);
        emit('fleet:batch-progress', {
          type: 'phase-start', phase: 1,
          label: `Reparaciones de dominio (${totalDomains} sitios → ${domainActionMap.size} acciones únicas)`,
        });
        // for...of garantiza ejecución SECUENCIAL — nunca Promise.all aquí
        for (const [action, domains] of domainActionMap) {
          await runAction(action, domains);
        }
      }

      // ── Phase 2: Server-level actions — estrictamente deduplicadas ────────
      if (serverActionSet.size > 0) {
        emit('fleet:batch-progress', {
          type: 'phase-start', phase: 2,
          label: `Acciones de servidor (${serverActionSet.size} únicas, sin repetición)`,
        });
        for (const action of serverActionSet) {
          await runAction(action, []); // server-wide, sin dominios específicos
        }
      }

      emit('fleet:batch-progress', { type: 'batch-done' });
      return { success: true };

    } catch (err) {
      emit('fleet:batch-progress', { type: 'batch-error', error: err.message });
      return { success: false, error: err.message };
    } finally {
      // disconnect omitido
    }

  });

  // ── Auto-Diagnóstico Inteligente (Lectura de error_log) ──────────────────
  ipcMain.handle('fleet:diagnose-site', async (_event, { serverName, dominio, httpCode }) => {
    let client = null;
    try {
      const config = await getConfig();
      const server = findServer(config, serverName);
      const ssh = getSshService();
      client = await ssh.connectCached(server.sshCredentials);

      // Wrapper de la función de ejecución para inyectarla en el motor
      const ejecutarSSH = (comando) => ssh.executeCommand(client, comando, { timeoutMs: 30000 });

      const payload = await diagnosticarSitio(ejecutarSSH, dominio, 100, httpCode);
      return { success: true, payload };
    } catch (err) {
      return { success: false, error: err.message };
    } finally {
      // disconnect omitido
    }
  });

  // ── Ejecución de Mitigación Inteligente ──────────────────────────────────
  ipcMain.handle('fleet:run-mitigation', async (_event, { serverName, comandoMitigacion }) => {
    let client = null;
    try {
      const config = await getConfig();
      const server = findServer(config, serverName);
      const ssh = getSshService();
      client = await ssh.connectCached(server.sshCredentials);

      const result = await ssh.executeCommand(client, comandoMitigacion, { timeoutMs: 120000 });
      return {
        success: result.code === 0 || result.code === null,
        output: result.stdout || result.stderr || '(Sin salida)',
      };
    } catch (err) {
      return { success: false, output: err.message };
    } finally {
      // disconnect omitido
    }
  });
}

module.exports = { registerFleetHandlers };
