/**
 * @module scalifylabs/domainManager
 * @description Gestiona la creación automática de suscripciones en Plesk.
 *
 * Reglas de negocio (hardcoded por diseño):
 *  - El owner siempre es 'Dev' (cliente ScalifyLabs).
 *  - El plan siempre es 'Default Domain'.
 *  - Las credenciales del sistema se generan aleatoriamente (Plesk las requiere).
 *  - La IP se obtiene directamente desde la base de datos interna de Plesk.
 *
 * El módulo es idempotente: si el dominio ya existe, retorna sin error.
 */

'use strict';

const crypto = require('crypto');

/**
 * Verifica si un dominio ya existe en Plesk y, si no, crea la suscripción
 * asignada al cliente Dev bajo el plan "Default Domain".
 *
 * @param {import('node-ssh').NodeSSH} ssh - Instancia NodeSSH ya conectada al servidor.
 * @param {string} domain                  - Dominio a verificar o crear (ej: "app.example.com").
 * @returns {Promise<{ status: 'exists' | 'created', message: string }>}
 * @throws {Error} Si no se puede detectar la IP del servidor o falla la creación.
 */
async function ensureSubscriptionExists(ssh, domain) {
  // ── 1. Verificar si el dominio ya existe ──────────────────────────────────
  const { code: codeInfo } = await ssh.execCommand(`plesk bin site --info ${domain}`);

  if (codeInfo === 0) {
    return {
      status: 'exists',
      message: `El dominio ${domain} ya existe en Plesk.`,
    };
  }

  // ── 2. Detectar la IP principal desde la base de datos interna de Plesk ───
  const { stdout: ipOutput } = await ssh.execCommand(
    `plesk db -Ne "SELECT ip_address FROM IP_Addresses LIMIT 1"`
  );
  const serverIp = ipOutput.trim();

  if (!serverIp) {
    throw new Error('No se pudo detectar la IP principal de Plesk desde su base de datos.');
  }

  // ── 3. Generar credenciales de sistema aleatorias ─────────────────────────
  // Plesk requiere un usuario y contraseña de sistema para crear la suscripción.
  // Son credenciales internas de Plesk — no se exponen al usuario final.
  const safeDomainName = domain.replace(/[^a-zA-Z0-9]/g, '').substring(0, 10);
  const sysUser = `dev_${safeDomainName}_${crypto.randomBytes(2).toString('hex')}`;
  const sysPass = crypto.randomBytes(8).toString('base64').replace(/[^a-zA-Z0-9]/g, '') + 'A1!';

  // ── 4. Crear la suscripción asignada al cliente Dev ───────────────────────
  const { code: createCode, stderr } = await ssh.execCommand(
    `plesk bin subscription --create ${domain} -owner Dev -service-plan "Default Domain" -ip ${serverIp} -login ${sysUser} -passwd "${sysPass}"`
  );

  if (createCode !== 0) {
    throw new Error(
      `Fallo crítico al crear la suscripción para ${domain}: ${stderr || '(sin detalles del error)'}`
    );
  }

  return {
    status: 'created',
    message: `Suscripción ${domain} creada y asignada a ScalifyLabs (Dev).`,
  };
}

module.exports = { ensureSubscriptionExists };
