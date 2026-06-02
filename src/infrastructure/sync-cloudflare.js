const fs = require('fs');
const path = require('path');
const { getConfigManager } = require('../services/config-manager');
const { CloudflareClient, DonDominioClient, withRetry } = require('./infrastructure-clients');
const whois = require('whois-json');

async function getExpirationFromRdap(domain) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`https://rdap.org/domain/${domain}`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = await res.json();
    const events = Array.isArray(data?.events) ? data.events : [];
    const match = events.find(e => /expir|renew|expiry/i.test(e.eventAction || ''));
    return match?.eventDate || null;
  } catch {
    return null;
  }
}

async function getExpirationFromWhois(domain) {
  try {
    const res = await Promise.race([
      whois(domain),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
    ]);
    return res.registrarRegistrationExpirationDate || res.registryExpiryDate || res.expirationDate || res.expires || res.expiryDate || null;
  } catch {
    return null;
  }
}

async function getExpirationDate(domain) {
  try {
    let dateStr = await getExpirationFromRdap(domain);
    if (!dateStr) {
      dateStr = await getExpirationFromWhois(domain);
    }
    
    if (!dateStr) return 'N/A';

    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return 'N/A';

    return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
  } catch {
    return 'Error';
  }
}

function normalizeDomain(domain) {
  return String(domain || '')
    .trim()
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '');
}

async function syncDomain(rawDomain) {
  const domain = normalizeDomain(rawDomain);
  const configManager = getConfigManager();
  const config = configManager.getConfig();
  const workspacePath = configManager.getWorkspacePath();

  // Validate configuration using ConfigManager values
  const missing = [];
  if (!config.cloudflare?.apiToken) missing.push('Cloudflare API Token');
  if (!config.cloudflare?.accountId) missing.push('Cloudflare Account ID');

  if (missing.length > 0) {
    return { success: false, error: `Configuración incompleta: Faltan credenciales para ${missing.join(', ')}` };
  }

  const cloudflare = new CloudflareClient({
    baseUrl: 'https://api.cloudflare.com/client/v4',
    apiToken: config.cloudflare.apiToken,
    accountId: config.cloudflare.accountId,
    timeoutMs: 30000
  });

  // Setup logging: logs/dns/[dominio].log
  const logsDir = path.join(workspacePath, 'logs', 'dns');
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }
  const logFile = path.join(logsDir, `${domain}.log`);
  
  const log = (msg) => {
    const timestamp = new Date().toISOString();
    const entry = `[${timestamp}] ${msg}\n`;
    fs.appendFileSync(logFile, entry);
  };

  const { getStandardEmitter } = require('../services/standard-emitter');
  const EMIT = getStandardEmitter('syncdns');
  
  log(`--- Iniciando sincronización DNS para ${domain} ---`);
  EMIT.info(`[TRACE] Entrando a syncDomain para ${domain}`);

  try {
    EMIT.info(`[TRACE] Verificando/creando zona en Cloudflare para ${domain}...`);
    log(`Verificando/creando zona en Cloudflare...`);
    const zoneOutcome = await withRetry(
      async () => {
        EMIT.info(`[TRACE] Llamando a cloudflare.ensureZone(${domain})...`);
        const res = await cloudflare.ensureZone(domain);
        EMIT.info(`[TRACE] Respondió cloudflare.ensureZone(${domain})`);
        return res;
      },
      `Cloudflare ensureZone ${domain}`
    );

    EMIT.info(`[TRACE] ensureZone completado con éxito para ${domain}`);
    log(`[OK] Zona en Cloudflare lista. Creada ahora: ${zoneOutcome.created ? 'Sí' : 'No'} (ZoneID: ${zoneOutcome.zone.id})`);

    const nameservers = zoneOutcome.nameservers || [];
    if (!Array.isArray(nameservers) || nameservers.length < 2) {
      EMIT.error(`[TRACE] Cloudflare no devolvió nameservers válidos para ${domain}`, domain);
      throw new Error(`Cloudflare no devolvió nameservers válidos.`);
    }

    const nsMessage = `Configura en tu registrador: ${nameservers.join(', ')}`;
    log(`[INFO] ${nsMessage}`);
    log(`--- Sincronización DNS completada con éxito ---`);
    EMIT.info(`[TRACE] syncDomain completado exitosamente para ${domain}`);
    
    // Ejecutar WHOIS de forma no bloqueante antes de retornar
    // Si falla, el catch interno devolverá 'Error' o 'N/A'
    EMIT.info(`[TRACE] Obteniendo fecha de expiración para ${domain}...`);
    const expDate = await getExpirationDate(domain);
    EMIT.info(`[TRACE] Fecha de expiración para ${domain}: ${expDate}`);

    return { success: true, message: nsMessage, expirationDate: expDate };

  } catch (error) {
    EMIT.error(`[TRACE] Falló syncDomain para ${domain}: ${error.message}`, domain);
    log(`[ERROR FATAL] Falló la sincronización DNS: ${error.message}`);
    const expDate = await getExpirationDate(domain);
    return { success: false, error: error.message, expirationDate: expDate };
  }
}

module.exports = {
  syncDomain,
  normalizeDomain
};
