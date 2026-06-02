// ssl-service.js — Batch SSL con Pre-Flight Guardian
// v2.0.0: Pre-Flight Check antes de cada dominio + abort inmediato ante LE rate limit.
// Evita el bloqueo de 7 días de la IP del servidor ante rate limit de Let's Encrypt.

const axios = require('axios');
const https = require('https');
const { getPleskCliService, LeRateLimitError } = require('./plesk-cli-service');

// Códigos de error de Cloudflare proxy — indican que el origen no responde
const CF_PROXY_ERROR_CODES = new Set([521, 522, 523, 524, 525, 526, 527, 530]);

// Timeout para Pre-Flight Check (8 segundos)
const PREFLIGHT_TIMEOUT_MS = 8000;

// Agent HTTPS que acepta certificados inválidos — obligatorio porque si
// Cloudflare hace 301 → HTTPS, el certificado local será inválido y Axios
// lanzaría un error de firma, abortando un chequeo que en realidad era exitoso.
const insecureAgent = new https.Agent({ rejectUnauthorized: false });

/**
 * Pre-Flight Check: verifica que el origen responde antes de intentar SSL.
 *
 * Hace GET a http://dominio.com/.well-known/acme-challenge/test
 * con validateStatus: () => true — acepta CUALQUIER código HTTP porque
 * un 404 confirma que el origen responde (ACME challenge path no existe aún).
 *
 * Solo falla ante:
 *   - Códigos Cloudflare proxy: 521-527, 530
 *   - Errores de red: ECONNREFUSED, ENOTFOUND, timeout (8s)
 *
 * @param {string} domain - Dominio a verificar
 * @returns {Promise<{pass: boolean, reason?: string}>}
 */
async function preFlightCheck(domain) {
  try {
    const response = await axios.get(
      `http://${domain}/.well-known/acme-challenge/test`,
      {
        timeout: PREFLIGHT_TIMEOUT_MS,
        validateStatus: () => true, // Acepta cualquier HTTP status
        httpsAgent: insecureAgent, // Acepta certificados inválidos en redirects 301→HTTPS
        maxRedirects: 3,
      }
    );

    // Verificar si es un error de proxy de Cloudflare
    if (CF_PROXY_ERROR_CODES.has(response.status)) {
      return {
        pass: false,
        reason: `Cloudflare proxy error ${response.status}: origen no responde`,
      };
    }

    // Cualquier otro código (200, 301, 403, 404, 500...) confirma que el origen está vivo
    return { pass: true };
  } catch (error) {
    // Errores de red: ECONNREFUSED, ENOTFOUND, ETIMEDOUT, etc.
    const code = error.code || '';
    const message = error.message || '';
    return {
      pass: false,
      reason: `Red: ${code || message}`,
    };
  }
}

/**
 * Procesa un batch de dominios para emisión SSL con Pre-Flight Guardian.
 *
 * Para cada dominio:
 *   1. Pre-Flight Check — verifica que el origen responde
 *   2. issueSslCertificate() — emite certificado vía sslit
 *
 * Abort inmediato: si issueSslCertificate() lanza LeRateLimitError,
 * el batch se aborta y los dominios pendientes se marcan aborted_by_rate_limit.
 * Esto evita el bloqueo de 7 días de la IP del servidor.
 *
 * @param {Object} client - SSH client conectado al servidor Plesk
 * @param {string[]} domains - Lista de dominios a procesar
 * @returns {Promise<Array<{domain: string, status: string, detail?: string}>>}
 */
async function processSslBatch(client, domains) {
  const pleskService = getPleskCliService();
  const results = [];
  let aborted = false;

  for (let i = 0; i < domains.length; i++) {
    const domain = domains[i];

    // Si el batch fue abortado por rate limit, marcar pendientes
    if (aborted) {
      results.push({
        domain,
        status: 'aborted_by_rate_limit',
        detail: 'Batch abortado: Let\'s Encrypt rate limit detectado en dominio anterior',
      });
      continue;
    }

    // ── Pre-Flight Check ──
    const preflight = await preFlightCheck(domain);
    if (!preflight.pass) {
      console.warn(`[SSL] Pre-Flight FAIL para ${domain}: ${preflight.reason}`);
      results.push({
        domain,
        status: 'preflight_fail',
        detail: preflight.reason,
      });
      continue; // Error aislado, no cancela el batch
    }

    // ── Issue SSL Certificate ──
    try {
      await pleskService.issueSslCertificate(client, domain);
      console.log(`[SSL] ✅ ${domain}: Certificado emitido`);
      results.push({ domain, status: 'success' });
    } catch (error) {
      if (error instanceof LeRateLimitError) {
        // ABORT INMEDIATO — proteger la IP del servidor
        console.error(`[SSL] 🚨 RATE LIMIT LE — Abortando batch en dominio ${domain}`);
        results.push({
          domain,
          status: 'rate_limited',
          detail: error.message,
        });
        aborted = true;
        // Los dominios restantes se marcarán aborted_by_rate_limit en el loop
      } else {
        // Error individual — continuar con el siguiente dominio
        console.error(`[SSL] ❌ ${domain}: ${error.message}`);
        results.push({
          domain,
          status: 'error',
          detail: error.message,
        });
      }
    }
  }

  // ── Resumen por console.table ──
  const summary = {};
  for (const r of results) {
    summary[r.status] = (summary[r.status] || 0) + 1;
  }
  console.log('\n[SSL] Resumen del batch:');
  console.table(summary);

  const problemDomains = results.filter(r => r.status !== 'success');
  if (problemDomains.length > 0) {
    console.log('\n[SSL] Dominios con problemas:');
    for (const p of problemDomains) {
      console.log(`  - ${p.domain} [${p.status}]: ${p.detail || 'sin detalle'}`);
    }
  }

  return results;
}

module.exports = { processSslBatch, preFlightCheck };
