'use strict';

/**
 * @file healService.js
 * @description Servicio de reparación profunda de dominios Plesk via SSH.
 *
 * Ejecuta `plesk repair fs` y `plesk repair web` sobre dominios con fallos,
 * y reporta el resultado de cada reparación de forma granular.
 */

// ─── Comandos de reparación ───────────────────────────────────────────────────

/**
 * Repara el filesystem y la configuración web de un dominio en Plesk.
 *
 * @param {object} sshService - Instancia del servicio SSH
 * @param {object} client     - Conexión SSH activa
 * @param {string} domain     - Dominio a reparar
 * @returns {Promise<{ domain: string, fsOk: boolean, webOk: boolean, fsOutput: string, webOutput: string }>}
 */
async function repairDomain(sshService, client, domain) {
  console.log(`[HEAL] Reparando dominio: ${domain}`);

  let fsOutput = '';
  let webOutput = '';
  let fsOk = false;
  let webOk = false;

  // Paso 1: Reparar filesystem
  try {
    const fsResult = await sshService.executeCommand(
      client,
      `plesk repair fs "${domain}" -y 2>&1`
    );
    fsOutput = (fsResult.stdout || fsResult.stderr || '').trim();
    fsOk = !fsOutput.toLowerCase().includes('error') && !fsOutput.toLowerCase().includes('failed');
    console.log(`[HEAL] fs repair ${domain}: ${fsOk ? 'OK' : 'WARN'}`);
  } catch (err) {
    fsOutput = err.message;
    console.warn(`[HEAL] fs repair ${domain} falló:`, err.message);
  }

  // Paso 2: Reparar configuración web
  try {
    const webResult = await sshService.executeCommand(
      client,
      `plesk repair web "${domain}" -y 2>&1`
    );
    webOutput = (webResult.stdout || webResult.stderr || '').trim();
    webOk = !webOutput.toLowerCase().includes('error') && !webOutput.toLowerCase().includes('failed');
    console.log(`[HEAL] web repair ${domain}: ${webOk ? 'OK' : 'WARN'}`);
  } catch (err) {
    webOutput = err.message;
    console.warn(`[HEAL] web repair ${domain} falló:`, err.message);
  }

  return { domain, fsOk, webOk, fsOutput, webOutput };
}

/**
 * Repara múltiples dominios en secuencia, reportando cada uno via callback.
 *
 * @param {object}   sshService    - Instancia del servicio SSH
 * @param {object}   sshCredentials
 * @param {string[]} domains       - Lista de dominios a reparar
 * @param {Function} onProgress    - Callback({ domain, index, total, result })
 * @returns {Promise<Array>} - Array de resultados por dominio
 */
async function repairDomains(sshService, sshCredentials, domains, onProgress) {
  const results = [];
  let client = null;

  try {
    client = await sshService.connect(sshCredentials, `heal-${Date.now()}`);

    for (let i = 0; i < domains.length; i++) {
      const domain = domains[i];

      if (typeof onProgress === 'function') {
        onProgress({
          domain,
          index: i,
          total: domains.length,
          phase: 'repairing',
          progress: Math.round((i / domains.length) * 100),
        });
      }

      const result = await repairDomain(sshService, client, domain);
      results.push(result);

      if (typeof onProgress === 'function') {
        onProgress({
          domain,
          index: i,
          total: domains.length,
          phase: 'done',
          progress: Math.round(((i + 1) / domains.length) * 100),
          result,
        });
      }
    }
  } finally {
    if (client) {
      try { await sshService.disconnect(client); } catch (_) { /* no crítico */ }
    }
  }

  return results;
}

module.exports = { repairDomain, repairDomains };
