// src/main/ipc/ipc-validators.js
// Validadores y sanitizadores compartidos entre handlers IPC.
// Sin dependencias externas — solo lógica pura Node.js.

'use strict';

// ── Sanitizador de nombre de dominio ──────────────────────────────────────────
// Acepta dominios con labels separados por puntos, opcionalmente con wildcard (*.)
// al inicio. Rechaza (lanza Error) cualquier input que no sea un FQDN limpio.
//
// Ejemplos válidos  : 'example.com', 'sub.example.com', '*.example.com'
// Ejemplos inválidos: '../etc/passwd', 'ex;rm -rf', 'ex ample.com'
//
// Por qué importa: el dominio se interpola en comandos Plesk CLI y en consultas
// DNS. Un valor como "evil.com && rm -rf /var/www" rompe ambos contextos.

const DOMAIN_LABEL    = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;
const WILDCARD_PREFIX = /^\*\./;

/**
 * @param {unknown} input
 * @returns {string} Dominio limpio, en minúsculas, sin trailing dot.
 * @throws {Error} Si el input no es un FQDN válido.
 */
function sanitizeDomain(input) {
  if (typeof input !== 'string') {
    throw new Error(`El dominio debe ser un string, recibido: ${typeof input}`);
  }

  // Eliminar espacios y trailing dot (como en "example.com.")
  let domain = input.trim().toLowerCase().replace(/\.$/, '');

  if (!domain) {
    throw new Error('El dominio no puede estar vacío');
  }

  // Soporte Nativo IDN (Punycode): convertir "arquitecturajareño.es" -> "xn--arquitecturajareo-rxb.es"
  domain = require('node:url').domainToASCII(domain);

  // Permitir wildcard solo al inicio: *.example.com
  const isWildcard = WILDCARD_PREFIX.test(domain);
  const toValidate  = isWildcard ? domain.slice(2) : domain;

  const labels = toValidate.split('.');

  if (labels.length < 2) {
    throw new Error(`Dominio inválido (debe tener al menos dos labels): "${domain}"`);
  }

  for (const label of labels) {
    if (!DOMAIN_LABEL.test(label)) {
      throw new Error(`Label de dominio inválido: "${label}" en "${domain}"`);
    }
  }

  return isWildcard ? `*.${toValidate}` : domain;
}

/**
 * Sanitiza un array de dominios. Descarta entradas inválidas y las loguea.
 * Útil para procesar la lista completa de un módulo.
 *
 * @param {unknown[]} domains
 * @param {(msg: string) => void} [log] - Función de log opcional para avisar de rechazos
 * @returns {string[]} Array de dominios limpios
 */
function sanitizeDomainList(domains, log) {
  if (!Array.isArray(domains)) return [];

  const clean = [];
  for (const raw of domains) {
    try {
      clean.push(sanitizeDomain(raw));
    } catch (err) {
      if (typeof log === 'function') {
        log(`[VALIDACIÓN] Dominio descartado: ${err.message}`);
      }
    }
  }
  return clean;
}

/**
 * Sanitiza un entero positivo. Útil para parámetros numéricos en comandos SSH
 * (días de retención, puerto, conteo de registros).
 *
 * @param {unknown} value
 * @param {number} defaultValue
 * @returns {number}
 */
function sanitizePositiveInt(value, defaultValue) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : defaultValue;
}

module.exports = { sanitizeDomain, sanitizeDomainList, sanitizePositiveInt };
