'use strict';

/**
 * @file step6-plugins.js
 * @description Gestión completa de plugins WP por dominio:
 *   1. Elementor Pro (desde ruta remota pre-subida + licencia desde config)
 *   2. ZIP adicional opcional (cualquier plugin)
 *   3. Lista negra: desactivar plugins conflictivos (sin eliminarlos)
 */

const { createStepLogger } = require('../utils/logger');
const { TIMEOUTS } = require('../constants');

/** Slugs que deben quedar desactivados tras la reconstrucción. */
const BLACKLIST_SLUGS = [
  'all-in-one-wp-migration',
  'gdpr-cookie-compliance',
  'litespeed-cache',
];

/**
 * Instala (unzip + chown + wp activate) un ZIP remoto en el servidor.
 * @param {object} ctx
 * @param {string} remoteZipPath  - ruta absoluta del zip en el servidor
 * @param {string} [pluginLabel]  - nombre legible para los logs
 * @param {object} [log]
 * @returns {Promise<string>} - nombre del directorio del plugin detectado
 */
async function installZip(ctx, remoteZipPath, pluginLabel = 'Plugin', log) {
  const cmd = [
    // Detectar carpeta del plugin dentro del zip
    `PLUGIN_DIR=$(unzip -Z1 "${remoteZipPath}" 2>/dev/null | head -n 1 | awk -F/ '{print $1}')`,
    `echo "DETECTED:$PLUGIN_DIR"`,
    // Extraer en plugins/
    `unzip -o -q "${remoteZipPath}" -d "${ctx.webRoot}/wp-content/plugins/" 2>&1`,
    // Ownership correcto
    `chown -R ${ctx.sysUser}:psacln "${ctx.webRoot}/wp-content/plugins/$PLUGIN_DIR" 2>/dev/null || true`,
    // Activar
    `su -l ${ctx.sysUser} -s /bin/bash -c "cd ${ctx.webRoot} && /usr/local/bin/wp plugin activate $PLUGIN_DIR --allow-root 2>&1" || echo "WP_ACTIVATE_FAILED"`,
  ].join(' && ');

  const result = await ctx.run(cmd, { timeout: TIMEOUTS.LONG, allowFail: true });
  const out = result.stdout || '';

  const match = out.match(/DETECTED:(.+)/);
  const pluginDir = match ? match[1].trim() : 'desconocido';

  if (out.includes('WP_ACTIVATE_FAILED')) {
    log.warn(`${pluginLabel} '${pluginDir}' extraído — requiere activación manual`);
  } else {
    log.success(`${pluginLabel} '${pluginDir}' instalado y activado ✓`);
  }

  return pluginDir;
}

/**
 * Activa la licencia de Elementor Pro via WP-CLI.
 * @param {object} ctx
 * @param {string} licenseKey
 * @param {object} log
 */
async function activateElementorLicense(ctx, licenseKey, log) {
  const cmd = `su -l ${ctx.sysUser} -s /bin/bash -c `
    + `"cd ${ctx.webRoot} && /usr/local/bin/wp elementor-pro license activate ${licenseKey} --allow-root 2>&1"`;

  const result = await ctx.run(cmd, { timeout: TIMEOUTS.DEFAULT, allowFail: true });
  const out = (result.stdout || result.stderr || '').trim().slice(0, 120);

  if (result.code === 0 || out.toLowerCase().includes('success')) {
    log.success(`Licencia Elementor Pro activada ✓`);
  } else {
    log.warn(`Licencia Elementor Pro — respuesta: ${out || '(sin output)'}`);
  }
}

/**
 * Desactiva plugins de la lista negra (no los elimina).
 * @param {object} ctx
 * @param {object} log
 */
async function applyBlacklist(ctx, log) {
  log.info(`Lista negra: verificando ${BLACKLIST_SLUGS.length} plugins conflictivos...`);

  for (const slug of BLACKLIST_SLUGS) {
    // Verificar si está instalado
    const checkCmd = `su -l ${ctx.sysUser} -s /bin/bash -c `
      + `"cd ${ctx.webRoot} && /usr/local/bin/wp plugin is-installed ${slug} --allow-root 2>&1"`;

    const checkRes = await ctx.run(checkCmd, { allowFail: true, timeout: 15000 });

    if (checkRes.code !== 0) {
      // No instalado — omitir silenciosamente
      continue;
    }

    // Está instalado — desactivar (sin importar si ya estaba inactivo)
    const deactivateCmd = `su -l ${ctx.sysUser} -s /bin/bash -c `
      + `"cd ${ctx.webRoot} && /usr/local/bin/wp plugin deactivate ${slug} --allow-root 2>&1"`;

    const deactRes = await ctx.run(deactivateCmd, { allowFail: true, timeout: 15000 });
    const out = (deactRes.stdout || '').trim().slice(0, 80);

    if (deactRes.code === 0 || out.includes('already inactive') || out.includes('Plugin deactivated')) {
      log.detail(`[blacklist] ${slug} → desactivado ✓`);
    } else {
      log.warn(`[blacklist] ${slug} → ${out || 'no se pudo desactivar'}`);
    }
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

/**
 * @param {object} ctx
 * @param {object} opts
 * @param {string}  [opts.elementorZipRemotePath] - ruta remota del zip de Elementor Pro
 * @param {string}  [opts.elementorLicenseKey]    - clave de licencia EP
 * @param {string}  [opts.extraZipRemotePath]     - ruta remota de un ZIP adicional
 */
async function runStep6(ctx, {
  elementorZipRemotePath = null,
  elementorLicenseKey    = null,
  extraZipRemotePath     = null,
} = {}) {
  const log = createStepLogger(ctx.emit, 6, ctx.totalSteps);

  const hasElementor = !!elementorZipRemotePath;
  const hasExtra     = !!extraZipRemotePath;

  if (!hasElementor && !hasExtra) {
    log.warn(`SKIP: No hay ZIPs de plugins para instalar`);
    // Igual aplicamos la lista negra
    await applyBlacklist(ctx, log);
    return;
  }

  // ── 1. Elementor Pro ────────────────────────────────────────────────────────
  if (hasElementor) {
    log.info(`Instalando Elementor Pro desde ZIP remoto...`);
    await installZip(ctx, elementorZipRemotePath, 'Elementor Pro', log);

    if (elementorLicenseKey) {
      await activateElementorLicense(ctx, elementorLicenseKey, log);
    }
  }

  // ── 2. Plugin adicional ─────────────────────────────────────────────────────
  if (hasExtra) {
    log.info(`Instalando plugin adicional desde ZIP remoto...`);
    await installZip(ctx, extraZipRemotePath, 'Plugin adicional', log);
  }

  // ── 3. Lista negra ──────────────────────────────────────────────────────────
  await applyBlacklist(ctx, log);

  log.success(`Plugins completados ✓`);
}

module.exports = { runStep6, BLACKLIST_SLUGS };
