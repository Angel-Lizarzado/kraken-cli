'use strict';

/**
 * @file securityService.js
 * @description Servicio de seguridad y administración de servidores Plesk.
 *
 * Funciones:
 *   - Reboot / Shutdown del servidor via SSH
 *   - Credential Reset masivo: actualiza wp_users en todas las BDs WordPress del servidor
 *   - Autenticación basada en SHA-256 hardcoded (no depende de .env para producción)
 */

const crypto = require('crypto');

// ─── Autenticación Admin ──────────────────────────────────────────────────────
// SHA-256 de la contraseña de acceso al módulo de seguridad.
// Para cambiarla: node -e "console.log(require('crypto').createHash('sha256').update('nueva_clave').digest('hex'))"
const ADMIN_PASSWORD_HASH = 'abee141941b7ee66d820e4d9cb52dfb1153677ed3430d9d1fa1128b6ebcff523';

/**
 * Valida la contraseña del admin comparando su SHA-256 contra el hash hardcoded.
 * @param {string} password - Contraseña en texto plano ingresada por el usuario
 * @returns {boolean}
 */
function validateAdminPassword(password) {
  if (!password || typeof password !== 'string') return false;
  const hash = crypto.createHash('sha256').update(password).digest('hex');
  return hash === ADMIN_PASSWORD_HASH;
}

// ─── Controles del servidor ───────────────────────────────────────────────────

/**
 * Ejecuta un reboot del servidor.
 * ⚠️ Fire-and-forget: la conexión SSH se cierra antes de que el servidor responda.
 * @param {object} sshService
 * @param {object} sshCredentials
 */
async function rebootServer(sshService, sshCredentials) {
  let client = null;
  try {
    client = await sshService.connect(sshCredentials, `security-reboot-${Date.now()}`);
    // nohup para que el comando sobreviva el cierre de la sesión SSH
    await sshService.executeCommand(client, 'nohup shutdown -r +0 &>/dev/null &');
    console.log('[SECURITY] Reboot iniciado en el servidor.');
  } finally {
    if (client) {
      try { await sshService.disconnect(client); } catch (_) { /* no crítico */ }
    }
  }
}

/**
 * Apaga el servidor.
 * ⚠️ Igual que reboot — fire-and-forget.
 * @param {object} sshService
 * @param {object} sshCredentials
 */
async function shutdownServer(sshService, sshCredentials) {
  let client = null;
  try {
    client = await sshService.connect(sshCredentials, `security-shutdown-${Date.now()}`);
    await sshService.executeCommand(client, 'nohup shutdown -h +0 &>/dev/null &');
    console.log('[SECURITY] Shutdown iniciado en el servidor.');
  } finally {
    if (client) {
      try { await sshService.disconnect(client); } catch (_) { /* no crítico */ }
    }
  }
}

// ─── Credential Reset Masivo ──────────────────────────────────────────────────

/**
 * Script que obtiene todas las bases de datos WordPress en el servidor.
 * Detecta las BDs que tienen la tabla `wp_users` (prefijo estándar).
 */
const GET_WP_DATABASES_SCRIPT = `
mysql -uadmin -p$(cat /etc/psa/.psa.shadow 2>/dev/null) -N -e "
  SELECT table_schema
  FROM information_schema.tables
  WHERE table_name = 'wp_users'
  GROUP BY table_schema;
" 2>/dev/null
`.trim();

/**
 * Construye el script de actualización de contraseña para un usuario en múltiples BDs.
 * Usa MD5 (estándar de WordPress para contraseñas hasheadas en la BD).
 *
 * @param {string[]} databases  - Lista de nombres de BDs WordPress
 * @param {string}   username   - Login del usuario a actualizar (ej: "dev")
 * @param {string}   newPassword - Nueva contraseña en texto plano
 */
function buildPasswordResetScript(databases, username, newPassword) {
  // Escapar para prevenir SQL injection básico — valores vienen del admin autenticado
  const safeUsername = username.replace(/['"\\;]/g, '');
  const safePassword = newPassword.replace(/['"\\]/g, '');

  const statements = databases.map(db => {
    const safeDb = db.replace(/[`'"\\]/g, '');
    return (
      `mysql -uadmin -p$(cat /etc/psa/.psa.shadow 2>/dev/null) "${safeDb}" -e ` +
      `"UPDATE wp_users SET user_pass = MD5('${safePassword}') WHERE user_login = '${safeUsername}';" 2>&1`
    );
  });

  return statements.join('\n');
}

/**
 * Resetea la contraseña de un usuario en todas las instalaciones WordPress del servidor.
 *
 * @param {object}   sshService
 * @param {object}   sshCredentials
 * @param {string}   username      - Login del usuario WordPress (ej: "dev")
 * @param {string}   newPassword   - Nueva contraseña en texto plano
 * @param {Function} onProgress    - Callback({ db, success, output, index, total })
 * @returns {Promise<{ total: number, updated: number, errors: string[] }>}
 */
async function massiveCredentialReset(sshService, sshCredentials, username, newPassword, onProgress) {
  let client = null;
  const errors = [];
  let updated = 0;

  try {
    client = await sshService.connect(sshCredentials, `security-cred-reset-${Date.now()}`);

    // 1. Obtener lista de BDs WordPress
    const dbResult = await sshService.executeCommand(client, GET_WP_DATABASES_SCRIPT);
    const databases = (dbResult.stdout || '')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0 && !l.startsWith('Warning'));

    if (databases.length === 0) {
      return { total: 0, updated: 0, errors: ['No se encontraron instalaciones WordPress en el servidor.'] };
    }

    console.log(`[SECURITY] Encontradas ${databases.length} BDs WordPress. Iniciando reset para "${username}"...`);

    // 2. Reset por BD (secuencial para evitar saturar MySQL)
    for (let i = 0; i < databases.length; i++) {
      const db = databases[i];

      if (typeof onProgress === 'function') {
        onProgress({ db, index: i, total: databases.length, phase: 'resetting', success: null, output: '' });
      }

      try {
        const safeDb = db.replace(/[`'"\\]/g, '');
        const safeUser = username.replace(/['"\\;]/g, '');
        const safePass = newPassword.replace(/['"\\]/g, '');

        const cmd =
          `mysql -uadmin -p$(cat /etc/psa/.psa.shadow 2>/dev/null) "${safeDb}" -e ` +
          `"UPDATE wp_users SET user_pass = MD5('${safePass}') WHERE user_login = '${safeUser}';" 2>&1`;

        const result = await sshService.executeCommand(client, cmd);
        const output = (result.stdout || result.stderr || '').trim();
        const success = !output.toLowerCase().includes('error');

        if (success) updated++;
        else errors.push(`${db}: ${output}`);

        if (typeof onProgress === 'function') {
          onProgress({ db, index: i, total: databases.length, phase: 'done', success, output });
        }
      } catch (err) {
        errors.push(`${db}: ${err.message}`);
        if (typeof onProgress === 'function') {
          onProgress({ db, index: i, total: databases.length, phase: 'done', success: false, output: err.message });
        }
      }
    }

    return { total: databases.length, updated, errors };
  } finally {
    if (client) {
      try { await sshService.disconnect(client); } catch (_) { /* no crítico */ }
    }
  }
}

module.exports = {
  validateAdminPassword,
  rebootServer,
  shutdownServer,
  massiveCredentialReset,
};
