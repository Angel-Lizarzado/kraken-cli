const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const { getConfigManager } = require('./config-manager');
const { getLogBufferService } = require('./log-buffer-service');

class WorkspaceManager {
  constructor() {
    this.configManager = getConfigManager();
    this.config = null;
    this.workspaceRoot = null;
    // 🔥 HARDENING v1.6.3: cache en memoria — leer JSON UNA SOLA VEZ por cuenta/cloud
    this._dominiosCache = new Map(); // key: "accountName/cloudName" -> { data, timestamp }
    this._cacheTtlMs = 30000; // 30s de cache
  }

  /**
   * 🔥 HARDENING v1.6.3: Invalida la cache de dominios procesados.
   * Útil después de escribir en updateDominiosProcesados.
   */
  _invalidateDominiosCache(accountName, cloudName) {
    const key = `${accountName}/${cloudName}`;
    this._dominiosCache.delete(key);
  }

  async initialize() {
    this.config = await this.configManager.initialize();

    // ── Resolución dinámica del workspace ──
    // configManager.getWorkspacePath() resuelve en orden:
    //   1) CLINMEDIA_OPS_PATH env var
    //   2) config.workspaceRoot (electron-store, configurable desde UI)
    //   3) Fallback inteligente (D:\Centro de Control, C:\Centro de Control)
    //   4) Fallback legacy (junto al ejecutable)
    this.workspaceRoot = this.configManager.getWorkspacePath();
    const respaldosPath = this.configManager.getRespaldosPath();

    try {
      await fsPromises.access(respaldosPath);
    } catch {
      console.log(`[WORKSPACE] Esperando estructura en: ${respaldosPath}`);
    }

    console.log(`[WORKSPACE] Workspace root: ${this.workspaceRoot}`);
    return this.workspaceRoot;
  }

  async ensureDirectoryExists(dirPath) {
    try {
      await fsPromises.access(dirPath);
    } catch (error) {
      await fsPromises.mkdir(dirPath, { recursive: true });
      console.log(`Created directory: ${dirPath}`);
    }
  }

  async createAccountFolder(accountName) {
    await this.initializeIfNeeded();
    const accountPath = this._safePath(accountName);
    await this.ensureDirectoryExists(accountPath);
    return accountPath;
  }

  async createDomainFolder(accountName, cloudName, domain) {
    await this.initializeIfNeeded();

    const domainPath = this.getDomainPath(accountName, cloudName, domain);
    await this.ensureDirectoryExists(domainPath);

    return domainPath;
  }

  async createCloudFolder(accountName, cloudName) {
    await this.initializeIfNeeded();
    const cloudPath = this.getCloudPath(accountName, cloudName);
    await this.ensureDirectoryExists(cloudPath);
    return cloudPath;
  }

  /**
   * Construye un path seguro dentro del workspace, con validación anti-traversal.
   * @param {...string} segments — segmentos relativos al respaldos/
   * @returns {string} — path absoluto resuelto y validado
   */
  _safePath(...segments) {
    const relPath = path.join(...segments);
    return this.configManager.assertPathInsideWorkspace(relPath);
  }

  getDomainPath(accountName, cloudName, domain) {
    return this._safePath(accountName, cloudName, domain);
  }

  getCloudPath(accountName, cloudName) {
    return this._safePath(accountName, cloudName);
  }

  async updateDominiosProcesados(accountName, cloudName, domains) {
    await this.initializeIfNeeded();

    const cloudPath = this.getCloudPath(accountName, cloudName);
    await this.ensureDirectoryExists(cloudPath);

    const jsonPath = path.join(cloudPath, 'dominios_procesados.json');

    // 🔥 HOTFIX v1.5.6: normalizar TODOS los items a objetos { dominio, ... }
    // antes de mergear. Esto evita corrupción del JSON por tipos mezclados.
    const normalize = (item) => {
      if (typeof item === 'string') return { dominio: item };
      if (item && typeof item === 'object' && item.dominio) return item;
      return null;
    };

    let existingDomains = [];
    try {
      const data = await fsPromises.readFile(jsonPath, 'utf8');
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) {
        existingDomains = parsed.map(normalize).filter(Boolean);
      }
    } catch (error) {
      console.warn(`[WORKSPACE] Error al leer dominios_procesados.json existente, empezando fresco: ${error.message}`);
    }

    // Normalizar domains entrantes
    const normalizedDomains = domains.map(normalize).filter(Boolean);

    // Merge usando Map con dominio como clave única (permite actualizar metadatos)
    const domainMap = new Map();
    for (const d of [...existingDomains, ...normalizedDomains]) {
      const key = d.dominio;
      if (!domainMap.has(key)) {
        domainMap.set(key, { ...d });
      } else {
        // Si ya existe, fusionar metadatos (no sobrescribir datos previos)
        domainMap.set(key, { ...domainMap.get(key), ...d });
      }
    }

    const mergedDomains = Array.from(domainMap.values());

    // 🔥 v1.8.2: escritura atómica para evitar corrupción por crash
    await this._atomicWriteJson(jsonPath, mergedDomains);

    this._invalidateDominiosCache(accountName, cloudName);

    return mergedDomains;
  }

  async getDominiosProcesados(accountName, cloudName) {
    await this.initializeIfNeeded();

    // 🔥 HARDENING v1.6.3: cache singleton — leer disco UNA SOLA VEZ cada 30s
    const cacheKey = `${accountName}/${cloudName}`;
    const cached = this._dominiosCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < this._cacheTtlMs) {
      return cached.data;
    }

    const cloudPath = this.getCloudPath(accountName, cloudName);
    const jsonPath = path.join(cloudPath, 'dominios_procesados.json');

    try {
      const raw = await fsPromises.readFile(jsonPath, 'utf8');
      if (!raw || raw.trim().length === 0) {
        const empty = [];
        this._dominiosCache.set(cacheKey, { data: empty, timestamp: Date.now() });
        return empty;
      }
      const parsed = JSON.parse(raw);

      if (!Array.isArray(parsed)) {
        const empty = [];
        this._dominiosCache.set(cacheKey, { data: empty, timestamp: Date.now() });
        return empty;
      }

      // Normalizar TODOS los items a objetos { dominio, ... }
      const normalized = parsed
        .map((item) => {
          if (typeof item === 'string') return { dominio: item };
          if (item && typeof item === 'object' && item.dominio) return item;
          return null;
        })
        .filter(Boolean);

      this._dominiosCache.set(cacheKey, { data: normalized, timestamp: Date.now() });
      return normalized;
    } catch (error) {
      const empty = [];
      this._dominiosCache.set(cacheKey, { data: empty, timestamp: Date.now() });
      return empty;
    }
  }

  /**
   * 🔥 v1.8.2: escritura atómica con temp file para evitar corrupción por crash.
   */
  async _atomicWriteJson(jsonPath, data) {
    const tmpPath = jsonPath + '.tmp';
    await fsPromises.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf8');
    await fsPromises.rename(tmpPath, jsonPath);
  }

  async setCloudflareSyncTimestamp(accountName, cloudName, domain) {
    await this.initializeIfNeeded();

    const cloudPath = this.getCloudPath(accountName, cloudName);
    await this.ensureDirectoryExists(cloudPath);

    const jsonPath = path.join(cloudPath, 'dominios_procesados.json');

    let dominios = [];
    try {
      const data = await fsPromises.readFile(jsonPath, 'utf8');
      dominios = JSON.parse(data);
      if (!Array.isArray(dominios)) return;
    } catch {
      return;
    }

    const now = new Date().toISOString();
    let found = false;

    for (const entry of dominios) {
      const entryDomain = typeof entry === 'string' ? entry : (entry.dominio || entry.name || '');
      if (entryDomain === domain) {
        if (typeof entry === 'string') {
          const idx = dominios.indexOf(entry);
          dominios[idx] = { dominio: domain, lastCloudflareSync: now };
        } else {
          entry.lastCloudflareSync = now;
        }
        found = true;
        break;
      }
    }

    if (!found) {
      dominios.push({ dominio: domain, lastCloudflareSync: now });
    }

    await this._atomicWriteJson(jsonPath, dominios);
    this._invalidateDominiosCache(accountName, cloudName);
  }

  async setSslSyncTimestamp(accountName, cloudName, domain) {
    await this.initializeIfNeeded();

    const cloudPath = this.getCloudPath(accountName, cloudName);
    await this.ensureDirectoryExists(cloudPath);

    const jsonPath = path.join(cloudPath, 'dominios_procesados.json');

    let dominios = [];
    try {
      const data = await fsPromises.readFile(jsonPath, 'utf8');
      dominios = JSON.parse(data);
      if (!Array.isArray(dominios)) return;
    } catch {
      return;
    }

    const now = new Date().toISOString();
    let found = false;

    for (const entry of dominios) {
      const entryDomain = typeof entry === 'string' ? entry : (entry.dominio || entry.name || '');
      if (entryDomain === domain) {
        if (typeof entry === 'string') {
          const idx = dominios.indexOf(entry);
          dominios[idx] = { dominio: domain, lastSslSync: now };
        } else {
          entry.lastSslSync = now;
        }
        found = true;
        break;
      }
    }

    if (!found) {
      dominios.push({ dominio: domain, lastSslSync: now });
    }

    await this._atomicWriteJson(jsonPath, dominios);
    this._invalidateDominiosCache(accountName, cloudName);
  }

  async checkExtractionStatus(accountName, cloudName, domain) {
    await this.initializeIfNeeded();

    const domainPath = this.getDomainPath(accountName, cloudName, domain);

    try {
      await fsPromises.access(domainPath);
    } catch {
      return {
        extracted: false,
        filesExist: false,
        dbExists: false,
        wpConfigExists: false,
        domainPath: null
      };
    }

    let filesExist = false;
    let dbExists = false;
    let wpConfigExists = false;

    try {
      const items = await fsPromises.readdir(domainPath);
      filesExist = items.some(item => item.endsWith('.tar') || item.endsWith('.zip'));
      dbExists = items.some(item => item.endsWith('.sql'));
      wpConfigExists = items.some(item => item === 'wp-config.php');
    } catch {
    }

    return {
      extracted: filesExist || dbExists,
      filesExist,
      dbExists,
      wpConfigExists,
      domainPath
    };
  }

  async scanDomainsFromFolders(accountName, cloudName) {
    await this.initializeIfNeeded();

    const cloudPath = this.getCloudPath(accountName, cloudName);

    try {
      const items = await fsPromises.readdir(cloudPath, { withFileTypes: true });
      const domains = items
        .filter(item => item.isDirectory())
        .map(item => item.name);

      return domains;
    } catch (error) {
      // Cloud path doesn't exist
      return [];
    }
  }

  async createTempWorkspace(taskId) {
    await this.initializeIfNeeded();

    const tempPath = this.configManager.assertPathInsideWorkspace(
      path.join('temp', taskId)
    );
    await this.ensureDirectoryExists(tempPath);

    // Create logs subdirectory
    const logsPath = path.join(tempPath, 'logs');
    await this.ensureDirectoryExists(logsPath);

    return tempPath;
  }

  async cleanupTempWorkspace(taskId) {
    await this.initializeIfNeeded();

    const tempPath = this.configManager.assertPathInsideWorkspace(
      path.join('temp', taskId)
    );

    try {
      await fsPromises.rm(tempPath, { recursive: true, force: true });
      console.log(`Cleaned up temp workspace: ${tempPath}`);
    } catch (error) {
      console.warn(`Failed to cleanup temp workspace ${tempPath}:`, error.message);
    }
  }

  async getWorkspaceStats() {
    await this.initializeIfNeeded();

    const respaldosPath = this.configManager.getRespaldosPath();
    const wsRoot = this.configManager.getWorkspacePath();

    try {
      const accounts = await this.scanDirectoryStructure(respaldosPath);

      return {
        workspaceRoot: wsRoot,
        accounts: accounts,
        totalSize: await this.calculateDirectorySize(wsRoot)
      };
    } catch (error) {
      console.warn('Could not calculate workspace stats:', error.message);
      return {
        workspaceRoot: wsRoot,
        accounts: [],
        totalSize: 0
      };
    }
  }

  async scanDirectoryStructure(dirPath) {
    try {
      const items = await fsPromises.readdir(dirPath, { withFileTypes: true });
      const structure = [];

      for (const item of items) {
        if (item.isDirectory()) {
          const subPath = path.join(dirPath, item.name);
          const subItems = await fsPromises.readdir(subPath, { withFileTypes: true });

          const clouds = subItems
            .filter(subItem => subItem.isDirectory())
            .map(subItem => ({
              name: subItem.name,
              path: path.join(subPath, subItem.name),
              domains: [] // Would need recursive scan for domains
            }));

          structure.push({
            name: item.name,
            path: subPath,
            clouds: clouds
          });
        }
      }

      return structure;
    } catch (error) {
      return [];
    }
  }

  async calculateDirectorySize(dirPath) {
    let totalSize = 0;

    const calculate = async (currentPath) => {
      try {
        const items = await fsPromises.readdir(currentPath, { withFileTypes: true });

        for (const item of items) {
          const itemPath = path.join(currentPath, item.name);

          if (item.isDirectory()) {
            await calculate(itemPath);
          } else if (item.isFile()) {
            try {
              const stats = await fsPromises.stat(itemPath);
              totalSize += stats.size;
            } catch (error) {
              // Skip files we can't stat
            }
          }
        }
      } catch (error) {
        // Skip directories we can't read
      }
    };

    await calculate(dirPath);
    return totalSize;
  }

  async initializeIfNeeded() {
    if (!this.workspaceRoot) {
      await this.initialize();
    }
  }

  getWorkspaceRoot() {
    return this.configManager.getWorkspacePath();
  }

  async scanWorkspace() {
    await this.initializeIfNeeded();

    const wsRoot = this.configManager.getWorkspacePath();
    const respaldoPathCalculado = this.configManager.getRespaldosPath();

    // ── Resolución robusta de la ruta de escaneo ──────────────────────────────
    // Problema: si el usuario configuró workspaceRoot apuntando DIRECTAMENTE a
    // la carpeta "respaldos", entonces getRespaldosPath() devuelve
    // "respaldos/respaldos" que no existe.
    // Solución: probar ambas rutas y usar la que exista en disco.
    let respaldoPath = respaldoPathCalculado;
    const existeCalculada = await fsPromises.access(respaldoPathCalculado).then(() => true).catch(() => false);
    const existeRaiz = await fsPromises.access(wsRoot).then(() => true).catch(() => false);

    if (!existeCalculada && existeRaiz) {
      console.warn(`[WORKSPACE] ⚠️  getRespaldosPath() (${respaldoPathCalculado}) no existe en disco.`);
      console.warn(`[WORKSPACE] ⚠️  Usando workspaceRoot directamente: ${wsRoot}`);
      console.warn(`[WORKSPACE] ⚠️  Causa probable: workspaceRoot ya apunta a la carpeta "respaldos".`);
      console.warn(`[WORKSPACE] ⚠️  Corrección permanente: cambia workspaceRoot al PADRE de "respaldos".`);
      respaldoPath = wsRoot;
    } else if (!existeCalculada && !existeRaiz) {
      console.error(`[WORKSPACE] ❌ Ninguna ruta existe en disco:`);
      console.error(`[WORKSPACE]    - Calculada: ${respaldoPathCalculado}`);
      console.error(`[WORKSPACE]    - WorkspaceRoot: ${wsRoot}`);
      return { workspaceRoot: wsRoot, accounts: [] };
    }

    console.log(`[WORKSPACE] Iniciando escaneo en: ${respaldoPath}`);
    const discovered = [];

    try {
      // ── Nivel 1: Cuentas (hostinger1, hostinger2...) ──────────────────────
      const entradas = await fsPromises.readdir(respaldoPath, { withFileTypes: true });
      console.log(`[WORKSPACE] Nivel 1 — entradas en ${respaldoPath}: ${entradas.length} items`);

      for (const accountDir of entradas) {
        // withFileTypes puede devolver false para junction points de Windows.
        // Usamos stat() como fallback para detectar directorios reales.
        let esDirectorio = accountDir.isDirectory();
        if (!esDirectorio) {
          try {
            const stat = await fsPromises.stat(path.join(respaldoPath, accountDir.name));
            esDirectorio = stat.isDirectory();
            if (esDirectorio) {
              console.log(`[WORKSPACE]   [symlink/junction] ${accountDir.name} detectado como directorio vía stat()`);
            }
          } catch { /* sin acceso — ignorar */ }
        }
        if (!esDirectorio) {
          console.log(`[WORKSPACE]   [saltado] ${accountDir.name} — no es directorio`);
          continue;
        }

        const accountPath = path.join(respaldoPath, accountDir.name);
        console.log(`[WORKSPACE]   [cuenta] ${accountDir.name} → ${accountPath}`);
        const clouds = [];

        // ── Nivel 2: Clouds (cloud1, cloud2...) ────────────────────────────
        let cloudEntradas = [];
        try {
          cloudEntradas = await fsPromises.readdir(accountPath, { withFileTypes: true });
        } catch (err) {
          console.error(`[WORKSPACE]   ❌ No se pudo leer la cuenta "${accountDir.name}": ${err.message}`);
          continue;
        }
        console.log(`[WORKSPACE]   Nivel 2 — ${accountDir.name}: ${cloudEntradas.length} items`);

        for (const cloudDir of cloudEntradas) {
          let esCloud = cloudDir.isDirectory();
          if (!esCloud) {
            try {
              const stat = await fsPromises.stat(path.join(accountPath, cloudDir.name));
              esCloud = stat.isDirectory();
            } catch { /* sin acceso — ignorar */ }
          }
          if (!esCloud) continue;

          const cloudPath = path.join(accountPath, cloudDir.name);

          // ── Nivel 3: Dominios (dominio.es...) ──────────────────────────
          let domainEntradas = [];
          try {
            domainEntradas = await fsPromises.readdir(cloudPath, { withFileTypes: true });
          } catch (err) {
            console.error(`[WORKSPACE]     ❌ No se pudo leer el cloud "${cloudDir.name}": ${err.message}`);
            continue;
          }

          const domains = [];
          for (const item of domainEntradas) {
            let esDominio = item.isDirectory();
            if (!esDominio) {
              try {
                const stat = await fsPromises.stat(path.join(cloudPath, item.name));
                esDominio = stat.isDirectory();
              } catch { /* sin acceso — ignorar */ }
            }
            if (esDominio) domains.push(item.name);
          }

          console.log(`[WORKSPACE]     [cloud] ${cloudDir.name} → ${domains.length} dominios: [${domains.join(', ')}]`);

          if (domains.length > 0) {
            clouds.push({ name: cloudDir.name, domains });
          }
        }

        if (clouds.length > 0) {
          discovered.push({ name: accountDir.name, clouds });
        } else {
          console.log(`[WORKSPACE]   ⚠️  Cuenta "${accountDir.name}" omitida — sin clouds con dominios`);
        }
      }

      console.log(`[WORKSPACE] ✅ Escaneo finalizado. Cuentas encontradas: ${discovered.length}`);

    } catch (error) {
      console.error('[WORKSPACE] ❌ Error crítico en el escaneo:', error.code, error.message);
      console.error('[WORKSPACE]    Ruta intentada:', respaldoPath);
    }

    return { workspaceRoot: wsRoot, accounts: discovered };
  }
}


// Singleton instance
let instance = null;

function getWorkspaceManager() {
  if (!instance) {
    instance = new WorkspaceManager();
  }
  return instance;
}

module.exports = { WorkspaceManager, getWorkspaceManager };