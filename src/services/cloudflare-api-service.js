const axios = require('axios');
const { domainToASCII } = require('node:url');
const { getProgressEmitter } = require('./progress-emitter');
const { getConfigManager } = require('./config-manager');

/**
 * 🔥 v1.13.0: Convierte un dominio con caracteres especiales (ñ, tildes)
 * a Punycode/ASCII usando domainToASCII de node:url (nativo, sin npm punycode).
 * Ej: 'arquitecturajareño.es' → 'xn--arquitecturajare-ubb.es'
 * Siempre retorna el dominio convertido. Si falla, retorna el original.
 */
function toPunycode(domain) {
  if (!domain || typeof domain !== 'string') return domain;
  try {
    const ascii = domainToASCII(domain);
    if (ascii !== domain) {
      console.log(`[DNS] Punycode: ${domain} → ${ascii}`);
    }
    return ascii;
  } catch {
    return domain;
  }
}

// 📋 DNS record type filtering — Cloudflare API supported and skip types
const CF_SUPPORTED_TYPES = new Set(['A','AAAA','CNAME','MX','TXT','NS','SRV','CAA','PTR','CERT','DNSKEY','DS','HTTPS','LOC','NAPTR','SMIMEA','SSHFP','SVCB','TLSA','URI']);
const CF_SKIP_RECORDS = new Set(['SOA']);

class CloudflareApiService {
  constructor() {
    this.progressEmitter = getProgressEmitter();
    this.configManager = getConfigManager();
    this.apiClient = null;
    this.zoneCache = new Map();
    // 🔥 v1.7.1: backup de zonas globales para fallback sin repetir paginación
    this._globalZonesBackup = null;
  }

  async initialize() {
    const config = await this.configManager.initialize();
    const rawToken = config.cloudflare?.apiToken;

    if (!rawToken) {
      throw new Error('Cloudflare API token not configured');
    }

    // --- 🛡️ ESCUDO DE VALIDACIÓN (Cero mutación destructiva) ---
    // Solo quitamos espacios en blanco accidentales. Si viene encriptado, lo dejamos intacto para que falle la validación.
    const cleanToken = typeof rawToken === 'string' ? rawToken.trim() : rawToken.toString('utf8').replace(/^\uFEFF/, '').replace(/^\uFFFE/, '').trim();

    // Validamos la estructura: Un token de CF estándar es alfanumérico + guiones, aprox 40 chars.
    const isValidToken = /^[A-Za-z0-9\-_]{32,64}$/.test(cleanToken);

    if (!isValidToken) {
      console.error("\n🚨 [ALERTA CRÍTICA DE SEGURIDAD] 🚨");
      console.error("El token recibido en la capa de red es inválido. Alta probabilidad de ser un Ciphertext sin desencriptar.");

      // Volcado hexadecimal para confirmar la firma de encriptación
      const hexDump = Buffer.from(rawToken).toString('hex').slice(0, 60);
      console.error(`Dump original (hex): ${hexDump}...`);

      throw new Error("Fallo Crítico: El token de Cloudflare llega encriptado o corrupto desde el ConfigManager.");
    }
    // ----------------------------------------------

    this.apiClient = axios.create({
      baseURL: 'https://api.cloudflare.com/client/v4',
      headers: {
        'Authorization': `Bearer ${cleanToken}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });

    try {
      await this.testConnection();
    } catch (error) {
      console.error('Fallo en testConnection de Cloudflare:', error.message);
      throw error;
    }
  }

  async testConnection() {
    try {
      const response = await this.apiClient.get('/user/tokens/verify');
      return {
        success: true,
        user: response.data.result,
        message: 'Cloudflare API connection successful'
      };
    } catch (error) {
      return {
        success: false,
        message: error.response?.data?.errors?.[0]?.message || error.message
      };
    }
  }

  /**
   * 🔥 v1.7.1: Obtiene TODAS las zonas del token con paginación automática.
   * Solo se llama como fallback cuando el filtro ?name= no encuentra el dominio.
   * Almacena el resultado en this._globalZonesBackup para no repetir la paginación.
   */
  async _getAllZonesWithPagination() {
    // Usar backup de sesión si ya se hizo la paginación antes
    if (this._globalZonesBackup) {
      console.log(`[CF] Usando cache global de ${this._globalZonesBackup.length} zonas (fallback)`);
      return this._globalZonesBackup;
    }

    const allZones = [];
    let page = 1;
    let totalPages = 1;
    const perPage = 50;

    while (page <= totalPages) {
      const response = await this.apiClient.get('/zones', {
        params: { per_page: perPage, page }
      });
      const result = response.data.result || [];
      allZones.push(...result);

      const info = response.data.result_info;
      if (info) {
        totalPages = Math.ceil(info.total_count / perPage);
      } else {
        break;
      }
      page++;
    }

    console.log(`[CF-SCAN] Total de zonas visibles para este Token: ${allZones.length}`);
    if (allZones.length > 0) {
      const sample = allZones.slice(0, 3).map(z => z.name);
      console.log(`[CF-DEBUG] Dominios visibles (primeros 3): ${sample.join(', ')}`);
    }

    // Guardar en backup para próximos fallbacks
    this._globalZonesBackup = allZones;
    return allZones;
  }

  async getZones(domainFilter = null) {
    try {
      console.log(`[CF-API] Consultando zonas. Filtro name: "${domainFilter}"`);

      const response = await this.apiClient.get('/zones', {
        params: {
          per_page: 50,
          ...(domainFilter && { name: domainFilter.trim() })
        }
      });

      console.log("[CF-API] Respuesta exitosa:", response.data.result);
      return response.data.result;

    } catch (error) {
      console.group("🚨 ERROR CRÍTICO CLOUDFLARE API");
      if (error.response) {
        console.log("Status:", error.response.status);
        console.log("Cuerpo del error (Data):", error.response.data);

        if (error.response.data.errors) {
          error.response.data.errors.forEach(err => {
            console.error(`Código CF: ${err.code} | Mensaje: ${err.message}`);
          });
        }
      } else {
        console.error("Error sin respuesta de servidor:", error.message);
      }
      console.groupEnd();

      const cfError = error?.response?.data?.errors?.[0];
      if (cfError) {
        throw new Error(`Cloudflare API error [${cfError.code}]: ${cfError.message}`);
      }
      throw error;
    }
  }

  /**
   * 🔥 v1.7.1: Estrategia híbrida de búsqueda de zona.
   *
   * PASO 1 (Rápido): GET /zones?name=... — camino feliz para ~85 dominios estándar.
   * PASO 2 (Fallback): Si PASO 1 da 0 resultados, usa _getAllZonesWithPagination()
   *   para barrer la lista completa y filtrar en memoria. La paginación se cachea
   *   en this._globalZonesBackup para no repetirla en fallbacks subsecuentes.
   *
   * Siempre cachea en this.zoneCache.
   * Nunca lanza throw — retorna { success: false, error } si no encuentra.
   */
  async getOrCreateZone(domain) {
    // 🛡️ Guard: null/undefined/empty/whitespace
    if (!domain || typeof domain !== 'string' || !domain.trim()) {
      return { success: false, error: 'Invalid domain' };
    }

    // 1. Limpieza inicial y extracción de Apex Domain
    let cleanDomain = domain.trim().toLowerCase().replace(/\.$/, '');
    // Strip protocol prefix and path (https://ejemplo.com/path → ejemplo.com)
    cleanDomain = cleanDomain.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
    const parts = cleanDomain.split('.');

    // Si es 'www.ejemplo.com' -> 'ejemplo.com'. Si es 'ejemplo.com' -> 'ejemplo.com'
    const apexDomain = parts.length > 2 ? parts.slice(-2).join('.') : cleanDomain;

    // 🛡️ RFC 1123 domain validation before punycode conversion
    const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
    if (!DOMAIN_RE.test(apexDomain)) {
      return { success: false, error: `Domain validation failed: ${apexDomain}` };
    }

    const punycodeApex = toPunycode(apexDomain);

    const taskId = this.progressEmitter.createTask('cloudflare-zone', punycodeApex, `Getting zone for ${punycodeApex}`);

    try {
      this.progressEmitter.emitProgress(taskId, 10, `Looking up zone for ${punycodeApex}`);

      // ── Cache check ──
      //if (this.zoneCache.has(punycodeApex)) {
      //  const cachedZone = this.zoneCache.get(punycodeApex);
      //  if (cachedZone && cachedZone.id) {
      //    this.progressEmitter.emitProgress(taskId, 30, `Found cached zone for ${punycodeApex}`);
      //    return cachedZone;
      //  }
      //}

      // ── PASO 1: Búsqueda rápida con Apex ──
      let targetZone = null;
      const fastZones = await this.getZones(punycodeApex);
      if (fastZones && fastZones.length > 0) {
        targetZone = fastZones.find(z => z.name === punycodeApex);
      }

      // ── PASO 2: Fallback (Barrido global) ──
      if (!targetZone) {
        const allZones = await this._getAllZonesWithPagination();
        targetZone = allZones.find(z =>
          z.name.toLowerCase() === punycodeApex ||
          (z.original_name && z.original_name.toLowerCase() === apexDomain)
        );
      }

      // ── Manejo de Resultado ──
      if (targetZone) {
        this.progressEmitter.emitProgress(taskId, 50, `Found existing zone for ${punycodeApex}`);
        this.zoneCache.set(punycodeApex, targetZone);
        this.progressEmitter.emitProgress(taskId, 100, `Zone ready for ${punycodeApex}`);
        this.progressEmitter.completeTask(taskId, `Zone found for ${punycodeApex}`);
        return targetZone;
      }

      // Zona no encontrada
      this.progressEmitter.emitProgress(taskId, 50, `Zone not found for ${punycodeApex}`);
      this.progressEmitter.completeTask(taskId, `Zone not found for ${punycodeApex}`);
      this.zoneCache.set(punycodeApex, { success: false, error: 'Zona no encontrada', domain: punycodeApex });
      return { success: false, error: 'Zona no encontrada en la lista global del Token', domain: punycodeApex };

    } catch (error) {
      const apiError = error?.response?.data?.errors?.[0]?.message || error.message;
      const statusCode = error?.response?.status;

      if (statusCode === 400) {
        this.progressEmitter.emitError(taskId, error, false);
        return { success: false, error: `Cloudflare 400: ${apiError} (Target: ${punycodeApex})`, domain: punycodeApex };
      }

      this.progressEmitter.emitError(taskId, error, true);
      return { success: false, error: apiError, domain: punycodeApex };
    }
  }

  async getDnsRecords(zoneId, recordFilter = null) {
    try {
      const params = {
        per_page: 100
      };

      if (recordFilter) {
        if (recordFilter.type) params.type = recordFilter.type;
        if (recordFilter.name) params.name = recordFilter.name;
        if (recordFilter.content) params.content = recordFilter.content;
      }

      const response = await this.apiClient.get(`/zones/${zoneId}/dns_records`, { params });

      return response.data.result;
    } catch (error) {
      console.error(`Failed to get DNS records for zone ${zoneId}:`, error.message);
      throw error;
    }
  }

  async createDnsRecord(zoneId, record) {
    try {
      const response = await this.apiClient.post(`/zones/${zoneId}/dns_records`, record);
      return response.data.result;
    } catch (error) {
      console.error(`Failed to create DNS record in zone ${zoneId}:`, error.message);
      throw error;
    }
  }

  async updateDnsRecord(zoneId, recordId, record) {
    try {
      const response = await this.apiClient.put(`/zones/${zoneId}/dns_records/${recordId}`, record);
      return response.data.result;
    } catch (error) {
      console.error(`Failed to update DNS record ${recordId} in zone ${zoneId}:`, error.message);
      throw error;
    }
  }

  async deleteDnsRecord(zoneId, recordId) {
    try {
      const response = await this.apiClient.delete(`/zones/${zoneId}/dns_records/${recordId}`);
      return response.data;
    } catch (error) {
      console.error(`Failed to delete DNS record ${recordId} from zone ${zoneId}:`, error.message);
      throw error;
    }
  }

  async syncDnsFromPlesk(domain, pleskDnsRecords) {
    const taskId = this.progressEmitter.createTask('cloudflare-dns-sync', domain, `Syncing DNS records for ${domain}`);

    try {
      this.progressEmitter.emitProgress(taskId, 10, `Starting DNS sync for ${domain}`);

      // Get or create zone
      const zone = await this.getOrCreateZone(domain);
      // 🔥 v1.6.9: zona no encontrada → abortar sin throw
      if (!zone.id) {
        this.progressEmitter.emitError(taskId, new Error(zone.error || 'Zone not found'), false);
        return { success: false, domain, error: zone.error || 'Zone not found', summary: { created: 0, updated: 0, skipped: 0, errors: 1, details: [] } };
      }
      this.progressEmitter.emitProgress(taskId, 30, `Zone ready, fetching existing records`);

      // Get existing Cloudflare DNS records
      const existingRecords = await this.getDnsRecords(zone.id);
      this.progressEmitter.emitProgress(taskId, 50, `Processing ${pleskDnsRecords.length} records from Plesk`);

      const results = {
        created: 0,
        updated: 0,
        skipped: 0,
        errors: 0,
        details: []
      };

      // ── Phase 1: Classify all records into create / update / skip ──
      const toCreate = [];
      const toUpdate = [];
      for (let i = 0; i < pleskDnsRecords.length; i++) {
        const pleskRecord = pleskDnsRecords[i];

        try {
          const cfRecord = this.convertToCloudflareFormat(pleskRecord);

          if (cfRecord.skip) {
            results.skipped++;
            results.details.push({
              action: 'skipped',
              type: pleskRecord.type,
              name: pleskRecord.name,
              reason: cfRecord.reason || 'Tipo no soportado'
            });
            continue;
          }

          const existingRecord = existingRecords.find(r => {
            if (r.type !== cfRecord.type || r.name !== cfRecord.name) return false;
            if (cfRecord.data) {
              return JSON.stringify(r.data) === JSON.stringify(cfRecord.data);
            }
            return r.content === cfRecord.content;
          });

          if (existingRecord) {
            if (cfRecord.data
              ? JSON.stringify(existingRecord.data) !== JSON.stringify(cfRecord.data)
              : existingRecord.content !== cfRecord.content ||
                existingRecord.ttl !== cfRecord.ttl ||
                existingRecord.proxied !== cfRecord.proxied ||
                existingRecord.priority !== cfRecord.priority) {
              toUpdate.push({ existingRecord, cfRecord, pleskRecord });
            } else {
              results.skipped++;
            }
          } else {
            toCreate.push({ cfRecord, pleskRecord });
          }
        } catch (error) {
          results.errors++;
          console.error(`Failed to process DNS record ${pleskRecord.name}:`, error.message);
          results.details.push({
            action: 'error',
            type: pleskRecord.type,
            name: pleskRecord.name,
            error: error.message
          });
        }
      }

      this.progressEmitter.emitProgress(taskId, 55,
        `Classified: ${toCreate.length} to create, ${toUpdate.length} to update, ${results.skipped} skipped`);

      // ── Phase 2: Process updates sequentially (safe) ──
      for (let i = 0; i < toUpdate.length; i++) {
        const { existingRecord, cfRecord, pleskRecord } = toUpdate[i];
        try {
          await this.updateDnsRecord(zone.id, existingRecord.id, cfRecord);
          results.updated++;
          results.details.push({
            action: 'updated',
            type: cfRecord.type,
            name: cfRecord.name,
            oldContent: existingRecord.content,
            newContent: cfRecord.content
          });
        } catch (error) {
          results.errors++;
          console.error(`Failed to update DNS record ${cfRecord.name}:`, error.message);
          results.details.push({
            action: 'error',
            type: cfRecord.type,
            name: cfRecord.name,
            error: `UPDATE failed: ${error.message}`
          });
        }
      }

      // ── Phase 3: CREATE in chunks of 10 with Promise.allSettled ──
      const BATCH_SIZE = 10;
      for (let ci = 0; ci < toCreate.length; ci += BATCH_SIZE) {
        const chunk = toCreate.slice(ci, ci + BATCH_SIZE);
        const chunkIdx = Math.floor(ci / BATCH_SIZE) + 1;
        const totalChunks = Math.ceil(toCreate.length / BATCH_SIZE);

        const settled = await Promise.allSettled(
          chunk.map(({ cfRecord }) =>
            this.createDnsRecord(zone.id, cfRecord)
          )
        );

        for (let si = 0; si < settled.length; si++) {
          const result = settled[si];
          const { cfRecord, pleskRecord } = chunk[si];

          if (result.status === 'fulfilled') {
            results.created++;
            results.details.push({
              action: 'created',
              type: cfRecord.type,
              name: cfRecord.name,
              content: cfRecord.content
            });
          } else {
            results.errors++;
            const cfErrCode = result.reason?.response?.data?.errors?.[0]?.code || '';
            const errMsg = result.reason?.message || String(result.reason);
            console.error(`Failed to create DNS record ${cfRecord.name}:`, errMsg);
            results.details.push({
              action: 'error',
              type: cfRecord.type,
              name: cfRecord.name,
              error: cfErrCode ? `[${cfErrCode}] ${errMsg}` : `CREATE failed: ${errMsg}`
            });
          }
        }

        const globalProgress = 55 + Math.round((
          (Math.min(ci + BATCH_SIZE, toCreate.length) + results.updated) /
          (toCreate.length + toUpdate.length || 1)
        ) * 40);

        this.progressEmitter.emitProgress(taskId, globalProgress,
          `Batch ${chunkIdx}/${totalChunks}: ${results.created} created so far`);
      }

      this.progressEmitter.emitProgress(taskId, 95, `Sync completed: ${results.created} created, ${results.updated} updated`);

      // Clean up records in Cloudflare that don't exist in Plesk (optional)
      // This could be configurable

      this.progressEmitter.emitProgress(taskId, 100, `DNS sync finished for ${domain}`);
      this.progressEmitter.completeTask(taskId, `DNS sync completed for ${domain}`);

      return {
        success: true,
        domain,
        zoneId: zone.id,
        zoneName: zone.name,
        summary: results,
        details: results.details
      };
    } catch (error) {
      this.progressEmitter.emitError(taskId, error, true);
      throw error;
    }
  }

  convertToCloudflareFormat(pleskRecord) {
    // Default Cloudflare record structure
    const cfRecord = {
      type: pleskRecord.type.toUpperCase(),
      name: pleskRecord.name.endsWith('.') ? pleskRecord.name : `${pleskRecord.name}.`,
      content: pleskRecord.data,
      ttl: pleskRecord.ttl || 1, // Cloudflare uses 1 for auto TTL
      proxied: true // Proxy activado (Nube Naranja) — política corporativa
    };

    // 🛡️ Type filtering — skip Cloudflare-managed or unsupported record types
    if (CF_SKIP_RECORDS.has(cfRecord.type)) {
      return { skip: true, reason: `Tipo ${cfRecord.type} gestionado por Cloudflare` };
    }
    if (!CF_SUPPORTED_TYPES.has(cfRecord.type)) {
      return { skip: true, reason: `Tipo ${cfRecord.type} no soportado en Cloudflare API` };
    }

    // Handle special cases
    if (cfRecord.type === 'A' || cfRecord.type === 'CNAME') {
      // For A and CNAME records, proxy through Cloudflare (Nube Naranja)
      // Política corporativa: todos los dominios con proxy activado
      cfRecord.proxied = true;
    }

    // Cloudflare requires TTL to be 1 or between 60 and 86400
    if (cfRecord.ttl < 60 && cfRecord.ttl !== 1) {
      cfRecord.ttl = 60;
    } else if (cfRecord.ttl > 86400) {
      cfRecord.ttl = 86400;
    }

    // Clean up content
    if (cfRecord.type === 'TXT') {
      // Ensure TXT records are properly quoted
      if (!cfRecord.content.startsWith('"') && !cfRecord.content.endsWith('"')) {
        cfRecord.content = `"${cfRecord.content}"`;
      }
    }

    // ── MX: emit priority from Plesk record (NEVER proxied) ──
    if (cfRecord.type === 'MX') {
      cfRecord.priority = parseInt(pleskRecord.priority || pleskRecord.opt, 10) || 10;
      cfRecord.proxied = false; // MX records are NOT proxiable in Cloudflare
    }

    // ── CAA: replace content with data struct (NEVER proxied) ──
    if (cfRecord.type === 'CAA') {
      const parts = (pleskRecord.opt || '0 issue ""').split(' ');
      cfRecord.data = {
        flags: parseInt(parts[0], 10) || 0,
        tag: parts[1] || 'issue',
        value: parts.slice(2).join(' ').replace(/"/g, ''),
      };
      delete cfRecord.content;
      cfRecord.proxied = false; // CAA records are NOT proxiable in Cloudflare
    }

    // ── SRV: replace content with data struct (NEVER proxied) ──
    if (cfRecord.type === 'SRV') {
      // SRV format: priority weight port target
      const srvParts = (pleskRecord.opt || '0 0 0').split(' ');
      cfRecord.data = {
        priority: parseInt(srvParts[0], 10) || 0,
        weight: parseInt(srvParts[1], 10) || 0,
        port: parseInt(srvParts[2], 10) || 0,
        target: cfRecord.content,
      };
      delete cfRecord.content;
      cfRecord.proxied = false; // SRV records are NOT proxiable in Cloudflare
    }

    return cfRecord;
  }

  async bulkUpdateDnsRecords(domain, updates) {
    const taskId = this.progressEmitter.createTask('cloudflare-bulk-update', domain, `Bulk updating DNS records for ${domain}`);

    try {
      this.progressEmitter.emitProgress(taskId, 10, `Starting bulk update for ${domain}`);

      const zone = await this.getOrCreateZone(domain);
      // 🔥 v1.6.9: zona no encontrada → abortar sin throw
      if (!zone.id) {
        this.progressEmitter.emitError(taskId, new Error(zone.error || 'Zone not found'), false);
        return { success: false, domain, error: zone.error || 'Zone not found' };
      }
      this.progressEmitter.emitProgress(taskId, 30, `Zone ready, processing ${updates.length} updates`);

      const results = [];

      for (let i = 0; i < updates.length; i++) {
        const update = updates[i];
        const progress = 30 + Math.round((i / updates.length) * 60);

        this.progressEmitter.emitProgress(
          taskId,
          progress,
          `Processing update ${i + 1}/${updates.length}: ${update.action} ${update.type} ${update.name}`
        );

        try {
          let result;

          switch (update.action) {
            case 'create':
              result = await this.createDnsRecord(zone.id, update.record);
              break;
            case 'update':
              result = await this.updateDnsRecord(zone.id, update.recordId, update.record);
              break;
            case 'delete':
              result = await this.deleteDnsRecord(zone.id, update.recordId);
              break;
            default:
              throw new Error(`Unknown action: ${update.action}`);
          }

          results.push({
            action: update.action,
            success: true,
            result: result
          });
        } catch (error) {
          results.push({
            action: update.action,
            success: false,
            error: error.message,
            record: update
          });
        }
      }

      this.progressEmitter.emitProgress(taskId, 100, `Bulk update completed for ${domain}`);
      this.progressEmitter.completeTask(taskId, `Bulk DNS update completed for ${domain}`);

      return {
        success: true,
        domain,
        zoneId: zone.id,
        results: results
      };
    } catch (error) {
      this.progressEmitter.emitError(taskId, error, true);
      throw error;
    }
  }

  /**
   * Deduplicate incoming records against existing Cloudflare records.
   * Compares type + name + content (case-insensitive) to filter records
   * that already exist in Cloudflare.
   *
   * @param {Array<{type, name, content}>} incoming - Records we want to create
   * @param {Array<{type, name, content}>} existing - Existing Cloudflare records
   * @returns {Array<{type, name, content}>} Records that don't exist yet (need creation)
   */
  deduplicateRecords(incoming, existing) {
    if (!incoming || incoming.length === 0) return [];
    if (!existing || existing.length === 0) return [...incoming];

    const existingSet = new Set(
      existing.map(r => {
        const val = r.content || JSON.stringify(r.data || '');
        return `${r.type}|${r.name}|${val}`.toLowerCase();
      })
    );
    return incoming.filter(r => {
      const val = r.content || JSON.stringify(r.data || '');
      const key = `${r.type}|${r.name}|${val}`.toLowerCase();
      return !existingSet.has(key);
    });
  }

  /**
   * Sync DNS for a single domain via Cloudflare API.
   * CLEAN & SET strategy:
   *   1. Fetch ALL existing A + AAAA records for '@' (apex) and 'www'
   *   2. DELETE them all — no matter what IP they point to
   *   3. CREATE fresh A records for '@' and 'www' pointing to pleskIp, proxied
   *   4. Purge CF cache (non-critical)
   *
   * Accepts optional callbacks { sendLog, sendStateChanged } for real-time IPC streaming.
   *
   * @param {string} domain - The domain to sync
   * @param {string} pleskIp - The target IP address
   * @param {object} [callbacks] - Optional callbacks for streaming
   * @param {function} [callbacks.sendLog] - Called with (message, type)
   * @param {function} [callbacks.sendStateChanged] - Called with (stateObject)
   * @returns {Promise<{domain, success, zoneId, error?}>}
   */
  async syncSingleDomain(domain, pleskIp, callbacks = {}) {
    const { sendLog, sendStateChanged } = callbacks;
    const log = (msg, type = 'info') => { if (sendLog) sendLog(msg, type); };
    const stateChanged = (state) => { if (sendStateChanged) sendStateChanged(state); };

    // 🔥 HARDENING v1.6.3: usar Punycode en los nombres de registro DNS también
    const punycodeDomain = toPunycode(domain);
    const wwwName = `www.${punycodeDomain}`;

    try {
      log(`Consultando zona Cloudflare para ${domain}`, 'info');

      // getOrCreateZone ya maneja punycode internamente
      const zone = await this.getOrCreateZone(punycodeDomain);

      // 🔥 v1.6.9: zona no encontrada → abortar sin throw
      if (!zone.id) {
        log(`[ERROR] Zona no encontrada para ${domain} en la cuenta de Cloudflare`, 'error');
        return { domain, success: false, error: zone.error || 'Zona no encontrada', zoneId: null };
      }

      log(`Obteniendo registros DNS existentes para ${domain}`, 'info');

      const allRecords = await this.getDnsRecords(zone.id);

      // ── Dedup: verify if desired A records already exist with correct IP and proxy ──
      const apexOk = allRecords.some(r =>
        r.type === 'A' && r.name === punycodeDomain && r.content === pleskIp && r.proxied === true
      );
      const wwwOk = allRecords.some(r =>
        r.type === 'A' && r.name === wwwName && r.content === pleskIp && r.proxied === true
      );

      if (apexOk && wwwOk) {
        log(`Registros A ya existen correctamente para ${domain} — saltando sincronización`, 'info');
        return { domain, success: true, zoneId: zone.id, skipped: true };
      }

      // ── Step 1: Find ALL A, AAAA, and CNAME records for '@' (apex) and 'www' ──
      //     Including CNAME prevents Cloudflare API Error 400 (collision) when
      //     we try to create an A record for www where a CNAME already exists.
      const recordsToDelete = allRecords.filter(r =>
        (r.type === 'A' || r.type === 'AAAA' || r.type === 'CNAME') &&
        (r.name === punycodeDomain || r.name === wwwName)
      );

      // ── Step 2: DELETE them all (sequentially to avoid race conditions) ──
      for (const rec of recordsToDelete) {
        log(`Purgando registro ${rec.type} ${rec.name}`, 'info');
        await this.deleteDnsRecord(zone.id, rec.id);
      }

      // ── Step 3: CREATE fresh A records for '@' and 'www' (proxied via Cloudflare) ──
      //     proxied: true = Nube Naranja (corporate policy: enable Cloudflare proxy)
      await this.createDnsRecord(zone.id, {
        type: 'A', name: punycodeDomain, content: pleskIp, ttl: 1, proxied: true
      });
      log(`[CF] Registro inyectado con protección de Proxy (Nube Naranja)`, 'success');
      log(`Creado registro A para ${punycodeDomain} → ${pleskIp}`, 'success');

      await this.createDnsRecord(zone.id, {
        type: 'A', name: wwwName, content: pleskIp, ttl: 1, proxied: true
      });
      log(`[CF] Registro inyectado con protección de Proxy (Nube Naranja)`, 'success');
      log(`Creado registro A para ${wwwName} → ${pleskIp}`, 'success');

      // ── Purge CF cache — failure is non-critical ──
      try {
        await this.purgeCache(zone.id, [`https://${punycodeDomain}/*`, `https://${wwwName}/*`]);
      } catch (cacheError) {
        console.warn(`[DNS] Cache purge warning for ${domain}: ${cacheError.message}`);
      }

      log(`DNS sincronizado correctamente para ${domain}`, 'success');

      return { domain, success: true, zoneId: zone.id };
    } catch (error) {
      // 🔥 HARDENING v1.6.3: si Cloudflare devuelve 400, es dominio inválido
      const is400 = error?.response?.status === 400;
      const errMsg = is400 ? `Dominio no soportado o inválido: ${domain}` : error.message;
      log(`[ERROR] ${errMsg}`, 'error');
      if (!is400) console.warn(`[DNS] Warning — Falló sincronización DNS para ${domain}: ${error.message}`);
      return { domain, success: false, error: errMsg, zoneId: null };
    }
  }

  /**
   * Sync DNS for a list of domains via Cloudflare API.
   * Delegates per-domain work to syncSingleDomain for consistency.
   *
   * NEVER throws — always returns { success: true, results, ... }.
   * Individual domain errors are reported in results[], they don't abort the batch.
   */
  async syncDomains(domains, pleskIp) {
    const results = [];

    for (const domain of domains) {
      const result = await this.syncSingleDomain(domain, pleskIp);
      results.push(result);
    }

    const successCount = results.filter(r => r.success).length;

    return {
      success: true, // Siempre true — el warning se reporta en results[]
      results,
      summary: {
        total: domains.length,
        successful: successCount,
        failed: domains.length - successCount
      }
    };
  }

  /**
   * Wait for DNS propagation by polling an external resolver with dig.
   * Runs inside the Plesk server via SSH to use its DNS resolver (not local cache).
   * @param {Object} sshClient - SSH client connected to Plesk server
   * @param {string} domain - Domain to check
   * @param {string} expectedIp - Expected A record IP
   * @param {number} maxRetries - Max polling attempts (default 12 = ~2 min)
   * @param {number} interval - Seconds between retries (default 10)
   * @returns {Promise<{ resolved: boolean, ip: string|null, attempts: number }>}
   */
  async waitForPropagation(sshClient, domain, expectedIp, maxRetries = 12, interval = 10) {
    const { getSshService } = require('./ssh-service');
    const sshService = getSshService();

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await sshService.executeCommand(
          sshClient,
          `dig +short ${domain} @1.1.1.1 2>/dev/null | head -1`
        );

        const resolved = (result.stdout || '').trim();

        if (resolved === expectedIp) {
          return { resolved: true, ip: resolved, attempts: attempt };
        }

        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, interval * 1000));
        }
      } catch {
        // Network blip, keep trying
        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, interval * 1000));
        }
      }
    }

    // Last resort: try nslookup as fallback
    try {
      const fallback = await sshService.executeCommand(
        sshClient,
        `nslookup ${domain} 2>/dev/null | grep -i "address" | tail -1 | awk '{print $2}'`
      );
      const fallbackIp = (fallback.stdout || '').trim();
      console.warn(`[DNS] Propagación lenta detectada para ${domain}. IP actual: ${fallbackIp || 'N/A'}. El sitio podría tardar unos minutos en reflejar los cambios.`);
      return { resolved: fallbackIp === expectedIp, ip: fallbackIp, attempts: maxRetries };
    } catch {
      console.warn(`[DNS] Propagación lenta detectada para ${domain}. El sitio podría tardar unos minutos en reflejar los cambios.`);
      return { resolved: false, ip: null, attempts: maxRetries };
    }
  }

  async purgeCache(zoneId, files = null) {
    try {
      const payload = files ? { files } : { purge_everything: true };

      const response = await this.apiClient.post(`/zones/${zoneId}/purge_cache`, payload);
      return response.data;
    } catch (error) {
      console.error(`Failed to purge cache for zone ${zoneId}:`, error.message);
      throw error;
    }
  }

  /**
   * 🔥 v1.8.2: Limpia registros AAAA de una zona y desactiva IPv6 en Cloudflare.
   * El PATCH /settings/ipv6 evita que Cloudflare siga anunciando direcciones
   * IPv6 que confunden a Let's Encrypt en Plesk.
   * @param {string} zoneId - Cloudflare zone ID
   * @returns {Promise<{ aaaaDeleted: number, ipv6Disabled: boolean }>}
   */
  async cleanAaaaRecords(zoneId) {
    let aaaaDeleted = 0;
    let ipv6Disabled = false;

    // 1) Eliminar registros AAAA existentes
    try {
      const records = await this.getDnsRecords(zoneId);
      const aaaaRecords = records.filter((r) => r.type === 'AAAA');
      for (const record of aaaaRecords) {
        await this.apiClient.delete(`/zones/${zoneId}/dns_records/${record.id}`);
        aaaaDeleted++;
      }
    } catch (err) {
      console.warn(`[CF] Error eliminando AAAA para zone ${zoneId}: ${err.message}`);
    }

    // 2) Desactivar IPv6 compatibility (evita que Cloudflare re-anuncie IPv6)
    try {
      await this.apiClient.patch(`/zones/${zoneId}/settings/ipv6`, { value: 'off' });
      ipv6Disabled = true;
      console.log(`[CF] IPv6 desactivado para zone ${zoneId}`);
    } catch (err) {
      console.warn(`[CF] Error desactivando IPv6 para zone ${zoneId}: ${err.message}`);
    }

    return { aaaaDeleted, ipv6Disabled };
  }

  async getAnalytics(zoneId, timeframe = 'last7days') {
    try {
      const response = await this.apiClient.get(`/zones/${zoneId}/analytics/dashboard`, {
        params: {
          since: this.getTimeframeStart(timeframe)
        }
      });
      return response.data;
    } catch (error) {
      console.error(`Failed to get analytics for zone ${zoneId}:`, error.message);
      throw error;
    }
  }

  getTimeframeStart(timeframe) {
    const now = new Date();
    let startDate = new Date();

    switch (timeframe) {
      case 'last24hours':
        startDate.setHours(now.getHours() - 24);
        break;
      case 'last7days':
        startDate.setDate(now.getDate() - 7);
        break;
      case 'last30days':
        startDate.setDate(now.getDate() - 30);
        break;
      case 'last90days':
        startDate.setDate(now.getDate() - 90);
        break;
      default:
        startDate.setDate(now.getDate() - 7);
    }

    return startDate.toISOString();
  }
}

// Singleton instance
let instance = null;

function getCloudflareApiService() {
  if (!instance) {
    instance = new CloudflareApiService();
  }
  return instance;
}

module.exports = { CloudflareApiService, getCloudflareApiService };