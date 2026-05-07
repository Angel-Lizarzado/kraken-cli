const fsp = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const tar = require('tar');
const { getSshService } = require('./ssh-service');
const { getWorkspaceManager } = require('./workspace-manager');
const { getProgressEmitter } = require('./progress-emitter');
const { getConfigManager } = require('./config-manager');

const COMMAND_TIMEOUT = 600000; // 10 minutes per remote command

class ExtractionService {
  constructor() {
    this.sshService = getSshService();
    this.workspaceManager = getWorkspaceManager();
    this.progressEmitter = getProgressEmitter();
    this.configManager = getConfigManager();
    this._validatedClouds = new Set();
  }

  async extractWordPress(accountName, cloudName, domain, taskId) {
    const startTime = Date.now();
    let sshClient = null;
    let wpConfigExtracted = false;
    let wpConfigModified = false;

    try {
      // Convertir dominios internacionales a Punycode (IDN) para compatibilidad SSH
      const safeDomain = this.getSafeDomainPath(domain);
      if (safeDomain !== domain) {
        console.log(`[IDN] Dominio internacional detectado: ${domain} -> ${safeDomain}`);
        this.progressEmitter.emitProgress({
          taskId,
          module: 'extraction',
          domain,
          progress: 0,
          message: `[INFO] Dominio internacional detectado. Traduciendo a formato Punycode para compatibilidad...`
        });
      }

      const config = this.configManager.getConfig();
      const account = config.accounts.find(acc => acc.name === accountName);
      if (!account) throw new Error(`Cuenta "${accountName}" no encontrada`);

      const cloud = account.originClouds.find(c => c.name === cloudName);
      if (!cloud) throw new Error(`Cloud "${cloudName}" no encontrado en cuenta "${accountName}"`);
      if (!cloud.isLinked) throw new Error(`Cloud "${cloudName}" no tiene SSH vinculado`);

      this.emitLog(taskId, domain, 1, `[EXTRACCIÓN] Iniciando: ${domain}`);

      await this.validateCloudConnection(cloud, accountName, cloudName, taskId);

      const sshCredentials = { ...cloud.sshCredentials };
      if (!sshCredentials.privateKey) {
        const cfg = this.configManager.getConfig();
        const keyPath = cfg?.sshKeys?.privateKeyPath || '~/.ssh/id_rsa';
        const resolvedPath = this.resolvePrivateKeyPath(keyPath);
        try {
          sshCredentials.privateKey = fsSync.readFileSync(resolvedPath, 'utf8');
        } catch (e) {
          console.warn(`[SSH] No se pudo leer llave privada: ${e.message}`);
        }
      }

      try {
        sshClient = await this.sshService.connect(sshCredentials, `extraction-${taskId}`);
      } catch (connectError) {
        const msg = connectError.message || '';
        if (msg.includes('All configured authentication methods failed')) {
          const hasKey = !!sshCredentials.privateKey;
          if (!hasKey) {
            throw new Error(
              `[SSH] Error de autenticación: No se encontró llave privada. ` +
              `Verifique ~/.ssh/id_rsa o sshKeys.privateKeyPath.`
            );
          }
          throw new Error(
            `[SSH] Error de autenticación (${sshCredentials.host}): ` +
            `El servidor rechazó la llave SSH. Inyecte la llave pública desde el panel.`
          );
        }
        if (msg.includes('Timed out') || msg.includes('handshake')) {
          throw new Error(
            `[SSH] Timeout conectando a ${sshCredentials.host}:${sshCredentials.port}. ` +
            `Verifique conectividad y puerto.`
          );
        }
        throw new Error(`[SSH] Error de conexión: ${msg}`);
      }

      const domainPath = await this.workspaceManager.createDomainFolder(accountName, cloudName, safeDomain);
      const logsPath = path.join(domainPath, 'logs');
      await this.workspaceManager.ensureDirectoryExists(logsPath);

      const localSqlPath = path.join(domainPath, `${safeDomain}.sql`);

      // ---- 1. DETECTAR RUTA REMOTA ----
      this.emitLog(taskId, domain, 10, `[FS] Detectando ruta de WordPress en Hostinger...`);

      const whoamiResult = await this.execWithTimeout(sshClient, 'whoami');
      const pwdResult = await this.execWithTimeout(sshClient, 'pwd');
      const sshWhoami = whoamiResult.stdout.trim();
      const currentPwd = pwdResult.stdout.trim();

      const remotePath = await this.resolveWordPressPath(sshClient, safeDomain, sshCredentials.username, currentPwd);

      // ---- 2. LEER WP-CONFIG Y EXTRAER CREDENCIALES ----
      const wpConfigRemote = `${remotePath}/wp-config.php`;
      const cfgResult = await this.execWithTimeout(sshClient, `cat ${wpConfigRemote}`);

      if (cfgResult.code !== 0) {
        throw new Error(`[WP] No se pudo leer wp-config.php en ${wpConfigRemote}: ${cfgResult.stderr}`);
      }

      const configContent = cfgResult.stdout;
      let dbName = null;
      let dbUser = null;
      let dbPass = null;

      // Parse wp-config.php for DB credentials — supports single and double quotes
      const lines = configContent.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        // Skip comments
        if (trimmed.startsWith('//') || trimmed.startsWith('#')) continue;
        if (trimmed.startsWith('/*') || trimmed.startsWith('*')) continue;

        const nameMatch = trimmed.match(/define\s*\(\s*['"]DB_NAME['"]\s*,\s*['"]([^'"]+)['"]\s*\)/);
        const userMatch = trimmed.match(/define\s*\(\s*['"]DB_USER['"]\s*,\s*['"]([^'"]+)['"]\s*\)/);
        const passMatch = trimmed.match(/define\s*\(\s*['"]DB_PASSWORD['"]\s*,\s*['"]([^'"]+)['"]\s*\)/);

        if (nameMatch) dbName = nameMatch[1];
        if (userMatch) dbUser = userMatch[1];
        if (passMatch) dbPass = passMatch[1];
      }

      // ---- 3. COMPRIMIR Y DESCARGAR ARCHIVOS (streaming, gzip) ----
      this.emitLog(taskId, domain, 30, `Paso 1: Comprimiendo y descargando desde Hostinger (gzip, streaming)...`);

      const localGzPath = path.join(domainPath, `${safeDomain}.tar.gz`);

      try {
        await this.sshService.streamRemoteCompress(
          sshClient, remotePath, localGzPath,
          (received, total, pct, msg) => {
            const mapped = 30 + Math.round(pct * 0.30);
            this.emitLog(taskId, domain, mapped, msg || `[FS] Descargando... ${pct}%`);
          }
        );
      } catch (downloadError) {
        try { fsSync.unlinkSync(localGzPath); } catch (_) {}
        throw downloadError;
      }

      const filesSize = await this.getFileSize(localGzPath);
      if (filesSize === 0) {
        try { fsSync.unlinkSync(localGzPath); } catch (_) {}
        throw new Error(`[ERROR] Archivo descargado vacío: ${localGzPath}`);
      }
      // Keep backward compat: set localTarPath to the gz path so .tar references still work
      const localTarPath = localGzPath;

      // ---- 4. EXPORTAR Y DESCARGAR BASE DE DATOS ----
      let dbSize = 0;
      if (dbName) {
        this.emitLog(taskId, domain, 55, `[DB] Dumpeando ${dbName}...`);

        const sqlName = `${safeDomain}.sql`;
        const remoteSqlPath = sqlName;
        const escapedPass = dbPass.replace(/'/g, "'\\''");
        const dumpCmd = `mysqldump --no-tablespaces --default-character-set=utf8mb4 -u ${dbUser} -p'${escapedPass}' ${dbName} > ${remoteSqlPath}`;

        const dumpResult = await this.execWithTimeout(sshClient, dumpCmd);
        if (dumpResult.code !== 0 || (dumpResult.stderr && dumpResult.stderr.trim().length > 0)) {
          throw new Error(`[DB] mysqldump falló: ${dumpResult.stderr || dumpResult.stdout}`);
        }

        this.emitLog(taskId, domain, 65, `Paso 3: Exportación SQL terminada. Iniciando descarga...`);
        const sqlDownloadStart = Date.now();
        try {
          await this.sshService.downloadFileWithProgress(
            sshClient, remoteSqlPath, localSqlPath,
            (received, total, pct, msg) => {
              const mapped = 65 + Math.round(pct * 0.15);
              this.emitLog(taskId, domain, mapped, msg || `[DB] Descargando SQL... ${pct}%`);
            }
          );
        } catch (downloadError) {
          try { fsSync.unlinkSync(localSqlPath); } catch (_) {}
          throw downloadError;
        }
        const sqlDownloadEnd = Date.now();
        const sqlDownloadTime = (sqlDownloadEnd - sqlDownloadStart) / 1000;
        dbSize = await this.getFileSize(localSqlPath);
        if (dbSize === 0) {
          try { fsSync.unlinkSync(localSqlPath); } catch (_) {}
          throw new Error(`[ERROR] SQL descargado vacío: ${localSqlPath}`);
        }

        await this.execWithTimeout(sshClient, `rm -f ${remoteSqlPath}`);
      }

      // ---- 5. POST-PROCESADO: MEMORIA WP (local tar.gz) ----
      this.emitLog(taskId, domain, 80, `[FS] Procesando wp-config.php (límites de memoria)...`);

      try {
        const modified = await this.injectMemoryLimitsFromTar(localTarPath, domainPath);
        if (modified) {
          wpConfigExtracted = true;
          wpConfigModified = true;
          this.emitLog(taskId, domain, 82, `[FS] wp-config.php modificado — memory_limit: 512M/1024M`);
        }
      } catch (e) {
        this.emitLog(taskId, domain, 82, `[FS] No se pudo modificar wp-config.php: ${e.message}`);
      }

      // ---- 6. REGISTRO Y MÉTRICAS ----
      const totalSize = filesSize + dbSize;
      await this.workspaceManager.updateDominiosProcesados(accountName, cloudName, [domain]);

      const endTime = Date.now();
      const duration = (endTime - startTime) / 1000;
      const avgSpeed = totalSize > 0 ? (totalSize / duration / 1024 / 1024).toFixed(2) : 0;

      this.emitLog(taskId, domain, 100,
        `[ÉXITO] Extracción completada. Total: ${(totalSize / 1024 / 1024).toFixed(2)} MB, Velocidad: ${avgSpeed} MB/s`
      );

      return {
        success: true,
        accountName,
        cloudName,
        domain,
        filesPath: localTarPath,
        dbPath: localSqlPath,
        filesSize,
        dbSize,
        totalSize,
        duration,
        avgSpeed,
        wpConfigExtracted,
        wpConfigModified,
        wpConfigPath: wpConfigExtracted ? path.join(domainPath, 'wp-config.php') : null,
        metrics: {
          filesSizeMB: (filesSize / 1024 / 1024).toFixed(2),
          dbSizeMB: (dbSize / 1024 / 1024).toFixed(2),
          totalSizeMB: (totalSize / 1024 / 1024).toFixed(2),
          durationSeconds: duration.toFixed(2),
          speedMBps: avgSpeed
        }
      };

    } catch (error) {
      this.progressEmitter.emitProgress({
        taskId,
        module: 'extraction',
        domain,
        progress: 0,
        message: `[ERROR] ${error.message}`
      });
      throw error;
    } finally {
      if (sshClient) {
        try { sshClient.end(); } catch (e) { /* ignore */ }
      }
    }
  }

  /**
   * Look up the WordPress installation path on the remote server.
   * Prioritizes domain-specific paths for multi-site hosting (Hostinger).
   */
  async resolveWordPressPath(sshClient, safeDomain, sshUser, currentPwd) {
    // Try common paths for Hostinger
    const domainPaths = [
      `${currentPwd}/domains/${safeDomain}/public_html`,
      `${currentPwd}/domains/${safeDomain}/htdocs`,
      `${currentPwd}/domains/${safeDomain}`,
      `${currentPwd}/public_html`,
      `/home/${sshUser}/domains/${safeDomain}/public_html`,
      `/home/${sshUser}/domains/${safeDomain}/htdocs`,
      `/home/${sshUser}/public_html`,
      `/var/www/${safeDomain}/public_html`,
      `/var/www/html`,
      currentPwd
    ];

    for (const candidatePath of domainPaths) {
      try {
        const testResult = await this.execWithTimeout(sshClient,
          `test -f "${candidatePath}/wp-config.php" && echo "EXISTS" || echo "NOT_FOUND"`
        );
        const output = (testResult.stdout || '').trim();
        if (output === 'EXISTS') {
          console.log(`[WP-PATH] WordPress encontrado en: ${candidatePath}`);
          return candidatePath;
        }
      } catch (e) {
        // Path not accessible, try next
      }
    }

    // Fallback: search for wp-config.php in the filesystem (limited depth)
    try {
      const findResult = await this.execWithTimeout(sshClient, `find ${currentPwd} -maxdepth 4 -name wp-config.php -type f 2>/dev/null | head -1`);
      const foundPath = (findResult.stdout || '').trim();
      if (foundPath) {
        const wpDir = path.dirname(foundPath);
        console.log(`[WP-PATH] WordPress encontrado (fallback find) en: ${wpDir}`);
        return wpDir;
      }
    } catch (e) { /* ignore */ }

    throw new Error(`[WP] No se pudo encontrar wp-config.php en ningún path conocido para el dominio "${safeDomain}".`);
  }

  /**
   * Validate that an SSH connection to the origin cloud is viable.
   * Caches validated clouds to avoid redundant checks.
   */
  async validateCloudConnection(cloud, accountName, cloudName, taskId) {
    const cacheKey = `${accountName}:${cloudName}`;
    if (this._validatedClouds.has(cacheKey)) return;

    this.emitLog(taskId, cloudName, 2, `[SSH] Validando conexión con ${cloud.sshCredentials?.host || '???'}...`);

    const sshCredentials = { ...cloud.sshCredentials };
    if (!sshCredentials.privateKey) {
      const cfg = this.configManager.getConfig();
      const keyPath = cfg?.sshKeys?.privateKeyPath || '~/.ssh/id_rsa';
      const resolvedPath = this.resolvePrivateKeyPath(keyPath);
      try {
        sshCredentials.privateKey = fsSync.readFileSync(resolvedPath, 'utf8');
      } catch (e) {
        console.warn(`[SSH] No se pudo leer llave privada para validación: ${e.message}`);
      }
    }

    const testClient = await this.sshService.connect(sshCredentials, `validation-${taskId}`);
    try {
      const { stdout } = await this.execWithTimeout(testClient, 'whoami');
      this.emitLog(taskId, cloudName, 2, `[SSH] Conectado como: ${(stdout || '').trim()}`);
      this._validatedClouds.add(cacheKey);
    } finally {
      try { testClient.end(); } catch (e) { /* ignore */ }
    }
  }

  /**
   * Resolve the private key path, expanding ~ to the user's home directory.
   */
  resolvePrivateKeyPath(keyPath) {
    if (!keyPath) return null;
    const resolved = keyPath.replace(/^~/, process.env.HOME || process.env.USERPROFILE || '');
    return fsSync.existsSync(resolved) ? resolved : null;
  }

  /**
   * Execute a remote command via SSH with timeout.
   */
  async execWithTimeout(sshClient, command) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`[SSH] Timeout ejecutando: ${command.substring(0, 100)}`));
      }, COMMAND_TIMEOUT);

      sshClient.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(timer);
          return reject(err);
        }
        let stdout = '';
        let stderr = '';

        stream.on('data', (data) => { stdout += data.toString(); });
        stream.stderr.on('data', (data) => { stderr += data.toString(); });

        stream.on('close', (code) => {
          clearTimeout(timer);
          resolve({ code, stdout, stderr });
        });

        stream.on('error', (streamErr) => {
          clearTimeout(timer);
          reject(streamErr);
        });
      });
    });
  }

  /**
   * Get file size in bytes.
   */
  async getFileSize(filePath) {
    try {
      const stat = await fsp.stat(filePath);
      return stat.size;
    } catch {
      return 0;
    }
  }

  /**
   * Inject memory limits into wp-config.php inside a tar archive (gzip or plain).
   * @param {string} localTarPath - Path to the .tar or .tar.gz file
   * @param {string} domainPath - Domain output directory
   * @returns {Promise<boolean>} true if wp-config.php was found and modified
   */
  async injectMemoryLimitsFromTar(localTarPath, domainPath) {
    const fs = require('fs');
    const tar = require('tar');
    const os = require('os');
    const path = require('path');

    const isGz = localTarPath.endsWith('.tar.gz');
    const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-memory-'));

    try {
      await tar.x({
        file: localTarPath,
        cwd: extractDir,
        gzip: isGz
      });

      // Find wp-config.php in extracted files
      const wpConfigPath = this.findFileRecursive(extractDir, 'wp-config.php');
      if (!wpConfigPath) {
        return false; // Not found, nothing to inject
      }

      const wpContent = fs.readFileSync(wpConfigPath, 'utf8');

      // Calculate current memory limits
      const currentMemory = (wpContent.match(/define\s*\(\s*['"]WP_MEMORY_LIMIT['"]\s*,\s*['"](\d+[MG])['"]\s*\)/) || [])[1];
      const currentMaxMemory = (wpContent.match(/define\s*\(\s*['"]WP_MAX_MEMORY_LIMIT['"]\s*,\s*['"](\d+[MG])['"]\s*\)/) || [])[1];

      // Only inject if less than 512M
      const needsMemory = !currentMemory || this.parseMemoryLimit(currentMemory) < 512;
      const needsMaxMemory = !currentMaxMemory || this.parseMemoryLimit(currentMaxMemory) < 1024;

      if (!needsMemory && !needsMaxMemory) {
        return false; // Already sufficient
      }

      // Inject BEFORE the "/* That's all, stop editing!" line
      const stopMarker = "/* That's all, stop editing!";
      const stopIndex = wpContent.indexOf(stopMarker);
      if (stopIndex === -1) {
        return false;
      }

      let injections = '';
      if (needsMemory) {
        injections += `define('WP_MEMORY_LIMIT', '512M');\n`;
      }
      if (needsMaxMemory) {
        injections += `define('WP_MAX_MEMORY_LIMIT', '1024M');\n`;
      }

      const modifiedContent = wpContent.slice(0, stopIndex) + injections + '\n' + wpContent.slice(stopIndex);
      fs.writeFileSync(wpConfigPath, modifiedContent, 'utf8');

      // Re-pack the archive
      // Remove old archive, re-create with modified wp-config.php
      fs.unlinkSync(localTarPath);

      await tar.c({
        file: localTarPath,
        cwd: extractDir,
        gzip: isGz
      }, ['.']);

      return true;
    } catch (error) {
      console.error(`[TAR] Error modificando wp-config.php: ${error.message}`);
      return false;
    } finally {
      try {
        fs.rmSync(extractDir, { recursive: true });
      } catch (_) {}
    }
  }

  /**
   * Recursively find a file in a directory tree.
   */
  findFileRecursive(dir, filename) {
    const fs = require('fs');
    const path = require('path');

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = this.findFileRecursive(fullPath, filename);
        if (found) return found;
      } else if (entry.name === filename) {
        return fullPath;
      }
    }
    return null;
  }

  /**
   * Parse memory limit like '128M' or '256M' to MB integer.
   */
  parseMemoryLimit(value) {
    if (!value) return 0;
    const match = value.match(/^(\d+)([MG])$/);
    if (!match) return 0;
    const num = parseInt(match[1], 10);
    return match[2] === 'G' ? num * 1024 : num;
  }

  /**
   * Convert an internationalized domain name to Punycode (ASCII-compatible encoding).
   * Uses Node.js URL parser which handles IDN via built-in ICU.
   */
  getSafeDomainPath(rawDomain) {
    try {
      const url = new URL('http://' + rawDomain.toLowerCase().trim());
      return url.hostname;
    } catch {
      return rawDomain.toLowerCase().trim();
    }
  }

  emitLog(taskId, domain, progress, message) {
    process.nextTick(() => {
      this.progressEmitter.emitProgress(taskId, progress, message);
    });
  }

  /**
   * Check extraction status for a given domain.
   * Uses safeDomain (Punycode) for ALL file lookups — folder, .tar.gz, .sql.
   */
  async getExtractionStatus(accountName, cloudName, domain) {
    const safeDomain = this.getSafeDomainPath(domain);
    const domainPath = this.workspaceManager.getDomainPath(accountName, cloudName, safeDomain);

    const filesTarPath = path.join(domainPath, `${safeDomain}.tar`);
    const filesGzPath = path.join(domainPath, `${safeDomain}.tar.gz`);
    const dbPath = path.join(domainPath, `${safeDomain}.sql`);
    const wpConfigPath = path.join(domainPath, 'wp-config.php');

    // Siempre mostrar contenido de la carpeta (para debugging)
    try {
      const dirContent = fsSync.readdirSync(domainPath);
      console.log(`[FORCE]   Contenido de carpeta:`, dirContent);
    } catch (_) {
      console.log(`[FORCE]   (carpeta no existe — se creará en la próxima extracción)`);
    }

    try {
      const [filesTar, filesGz, dbExist, wpConfigExists] = await Promise.all([
        this.fileExists(filesTarPath),
        this.fileExists(filesGzPath),
        this.fileExists(dbPath),
        this.fileExists(wpConfigPath)
      ]);

      const filesExist = filesTar || filesGz;
      const filesPath = filesGz ? filesGzPath : filesTarPath;

      console.log(`[FORCE]   Resultado: archivos=${filesExist} sql=${dbExist}`);

      return { extracted: filesExist && dbExist, filesExist, dbExist, wpConfigExists, domainPath, filesPath };
    } catch (error) {
      console.log(`[FORCE]   ⚠️  Excepción: ${error.message}`);
      return { extracted: false, filesExist: false, dbExist: false, wpConfigExists: false, domainPath: null, filesPath: null };
    }
  }

  async fileExists(filePath) {
    try {
      await fsp.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}

let _instance = null;
function getExtractionService() {
  if (!_instance) _instance = new ExtractionService();
  return _instance;
}
module.exports = { ExtractionService, getExtractionService };
