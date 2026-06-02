// dns-service.js — Idempotent DNS sync: GET→PUT/POST
// v2.0.0: Lee zona completa paginada, construye índice O(1), aplica solo cambios necesarios.
// El orquestador de 90 sitios puede llamarlo en paralelo sin escrituras duplicadas.

const { getCloudflareApiService } = require('./cloudflare-api-service');

/**
 * Sincroniza registros DNS de un dominio en Cloudflare de forma idempotente.
 *
 * Flujo:
 *   1. getAllDnsRecords() — zona completa paginada
 *   2. Construye índice fqdn → record para lookups O(1)
 *   3. Para cada nombre (@, www, webmail, mail):
 *      - IP correcta → SKIP (cero requests)
 *      - IP diferente → PUT (update)
 *      - No existe    → POST (create)
 *
 * @param {string} zoneId    - Cloudflare zone ID
 * @param {string} domain    - Dominio base (ej: ejemplo.com)
 * @param {string} serverIp  - IP destino del servidor Plesk
 * @param {boolean} proxied  - Activar proxy de Cloudflare (Nube Naranja)
 * @returns {Promise<Array<{name: string, action: string, detail?: string}>>}
 */
async function syncDnsRecords(zoneId, domain, serverIp, proxied = false) {
  const cfService = getCloudflareApiService();

  // 1. Leer zona completa (paginación automática garantiza >100 registros)
  const allRecords = await cfService.getAllDnsRecords(zoneId);

  // 1.5. PURGA ESTRICTA DE IPv6 (AAAA)
  // Plesk falla la emisión de SSL si detecta registros AAAA en Cloudflare pero opera en IPv4.
  for (const record of allRecords) {
    if (record.type === 'AAAA') {
      console.log(`[PURGE] Eliminando registro AAAA obsoleto en ${record.name}`);
      try {
        await cfService.deleteDnsRecord(zoneId, record.id);
      } catch (err) {
        console.warn(`[PURGE] Error al eliminar AAAA en ${record.name}:`, err.message);
      }
    }
  }

  // 2. Construir índice fqdn → record para lookups O(1)
  // Clave: "type|fqdn" para evitar colisiones entre A y CNAME del mismo nombre
  const recordIndex = new Map();
  for (const record of allRecords) {
    const key = `A|${record.name}`;
    if (record.type === 'A') {
      recordIndex.set(key, record);
    }
  }

  // 3. Definir los nombres objetivo
  // '@' se mapea al dominio base, el resto son subdominios
  const targets = [
    { label: '@', fqdn: domain },
    { label: 'www', fqdn: `www.${domain}` },
    { label: 'webmail', fqdn: `webmail.${domain}` },
    { label: 'mail', fqdn: `mail.${domain}` },
  ];

  const results = [];

  // 4. Evaluar y aplicar cambios idempotentes
  for (const target of targets) {
    const key = `A|${target.fqdn}`;
    const existing = recordIndex.get(key);

    // ── CHEQUEO DE COLISIÓN (CNAME vs A) ──
    const cnameConflict = allRecords.find(r => r.name === target.fqdn && r.type === 'CNAME');
    if (cnameConflict) {
      console.log(`[PURGE] Eliminando CNAME conflictivo en ${target.fqdn} para hacer espacio al registro A.`);
      try {
        await cfService.deleteDnsRecord(zoneId, cnameConflict.id);
      } catch (err) {
        console.warn(`[PURGE] Error al eliminar CNAME conflictivo en ${target.fqdn}:`, err.message);
      }
    }

    // REGLA CRÍTICA DE ARQUITECTURA:
    // Los registros de correo NUNCA deben usar la nube naranja de Cloudflare, 
    // de lo contrario, Let's Encrypt y los puertos SMTP/IMAP/POP3 fallarán.
    const isMailTarget = target.label === 'mail' || target.label === 'webmail';
    const finalProxiedState = isMailTarget ? false : proxied;

    if (existing) {
      const isIpDifferent = existing.content !== serverIp;
      const isProxyDifferent = !!existing.proxied !== !!finalProxiedState;

      // Si la IP y el estado del proxy ya coinciden exactamente, saltamos
      if (!isIpDifferent && !isProxyDifferent) {
        console.log(`[DNS] SKIP ${target.fqdn} — IP y Proxy ya están correctos`);
        results.push({ name: target.fqdn, action: 'skip' });
        continue;
      }

      // Si la IP es distinta o el estado del proxy es distinto, actualizamos
      console.log(`[DNS] UPDATE ${target.fqdn}: ${existing.content} → ${serverIp} (proxied: ${finalProxiedState})`);
      try {
        await cfService.updateDnsRecord(zoneId, existing.id, {
          type: 'A',
          name: target.fqdn,
          content: serverIp,
          ttl: 1,
          proxied: finalProxiedState,
        });
        results.push({
          name: target.fqdn,
          action: 'update',
          detail: `${existing.content} → ${serverIp} (Proxy: ${finalProxiedState})`,
        });
      } catch (updateError) {
        const isCollision = updateError.message.includes('81058') || 
                            (updateError.response?.data?.errors?.some(e => e.code === 81058));
        if (isCollision) {
          console.log(`[PURGE] Registro redundante eliminado por colisión (81058) en ${target.fqdn}.`);
          await cfService.deleteDnsRecord(zoneId, existing.id);
          results.push({
            name: target.fqdn,
            action: 'update',
            detail: `Purgado por colisión (81058)`,
          });
        } else {
          throw updateError;
        }
      }
    } else {
      // No existe → POST (create)
      console.log(`[DNS] CREATE ${target.fqdn} → ${serverIp} (proxied: ${finalProxiedState})`);
      await cfService.createDnsRecord(zoneId, {
        type: 'A',
        name: target.fqdn,
        content: serverIp,
        ttl: 1,
        proxied: finalProxiedState,
      });
      results.push({ name: target.fqdn, action: 'create' });
    }
  }

  return results;
}

module.exports = { syncDnsRecords };
