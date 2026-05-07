// dns-service.js — Bypass silencioso de Cloudflare para obtener IP real del servidor
// v1.20.16: Stealth resolver — no emite logs a la UI, solo devuelve IP + hostname

const dns = require('dns');

// Rangos de IPs de Cloudflare (https://www.cloudflare.com/ips/)
// Bloque /24 común para proxied zones
const CLOUDFLARE_RANGES = [
  '173.245.48.', '103.21.244.', '103.22.200.', '103.31.4.',
  '141.101.64.', '108.162.192.', '190.93.240.', '188.114.96.',
  '197.234.240.', '198.41.128.', '162.158.0.', '104.16.',
  '104.24.', '172.64.', '131.0.72.',
];

// Subdominios comunes que suelen NO estar proxied por Cloudflare
const BYPASS_SUBDOMAINS = ['ftp', 'mail', 'cpanel', 'webmail', 'direct', 'cpcalendars', 'cpcontacts'];

function isCloudflareIp(ip) {
  return CLOUDFLARE_RANGES.some(range => ip.startsWith(range));
}

async function resolveIp(host) {
  try {
    const ips = await dns.promises.resolve4(host);
    return ips[0] || null;
  } catch {
    return null;
  }
}

async function resolveHostname(ip) {
  try {
    const names = await dns.promises.reverse(ip);
    return names[0] || null;
  } catch {
    return null;
  }
}

/**
 * Resuelve la IP real de un dominio saltándose el proxy de Cloudflare.
 *
 * 1. Resuelve el dominio base.
 * 2. Si la IP pertenece a Cloudflare, prueba subdominios comunes
 *    (ftp, mail, cpanel, etc.) que suelen estar desproxied.
 * 3. Devuelve { ip, hostname } o null si no pudo resolver.
 *
 * @param {string} domain - Dominio base (ej: midominio.com)
 * @returns {Promise<{ ip: string, hostname: string } | null>}
 */
async function resolveRealIp(domain) {
  // 1) Probar el dominio base directamente
  const baseIp = await resolveIp(domain);
  if (baseIp && !isCloudflareIp(baseIp)) {
    const hostname = await resolveHostname(baseIp);
    return { ip: baseIp, hostname: hostname || '' };
  }

  // 2) Está detrás de Cloudflare — probar subdominios comunes de bypass
  for (const sub of BYPASS_SUBDOMAINS) {
    const subDomain = sub + '.' + domain;
    const ip = await resolveIp(subDomain);
    if (ip && !isCloudflareIp(ip)) {
      const hostname = await resolveHostname(ip);
      return { ip, hostname: hostname || '' };
    }
  }

  // 3) No se pudo bypassear Cloudflare
  return null;
}

module.exports = { resolveRealIp, isCloudflareIp };
