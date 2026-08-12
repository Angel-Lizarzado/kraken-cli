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
    let localTempDomainPath = null;
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

      // ---- CONFIGURAR RUTAS LOCALES TEMPORALES ----
      const tempDownloadDir = this.configManager.getTempDownloadPath();
      localTempDomainPath = path.join(tempDownloadDir, `extract-${Date.now()}-${safeDomain}`);
      await fsp.mkdir(localTempDomainPath, { recursive: true });

      const localSqlPath = path.join(localTempDomainPath, `${safeDomain}.sql`);
      const localGzPath = path.join(localTempDomainPath, `${safeDomain}.tar.gz`);
      
      const tempLogsPath = path.join(localTempDomainPath, 'logs');
      await fsp.mkdir(tempLogsPath, { recursive: true });

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

      let tempRemotePath = null;
      let tempFolderName = null;

      try {
        const crypto = require('crypto');
        const token = crypto.randomBytes(5).toString('hex');
        tempFolderName = `krk_temp_${token}`;
        tempRemotePath = `${remotePath}/${tempFolderName}`;

        // ---- 1.3 LIMPIEZA PREVENTIVA (PRE-FLIGHT) ----
        this.emitLog(taskId, domain, 18, `[FS] Ejecutando limpieza preventiva en el servidor remoto...`);
        try {
          const preflightCmd = `find "${remotePath}" -maxdepth 1 -name 'krk_temp_*' -type d -exec rm -rf {} +`;
          await this.execWithTimeout(sshClient, preflightCmd);
        } catch (preflightErr) {
          console.warn(`[PRE-FLIGHT-WARNING] No se pudo limpiar carpetas residuales en ${domain}: ${preflightErr.message}`);
        }

        // ---- 1.5 CONFIGURAR LÍMITES DE MEMORIA REMOTOS ----
        this.emitLog(taskId, domain, 20, `[FS] Configurando límites de memoria en wp-config.php (remoto)...`);
        const { performance } = require('node:perf_hooks');
        const sedStart = performance.now();
        const sedCmd = `cd "${remotePath}" && sed -i "/WP_MEMORY_LIMIT/d" wp-config.php && sed -i "/WP_MAX_MEMORY_LIMIT/d" wp-config.php && sed -i "/'ABSPATH'/i define('WP_MEMORY_LIMIT', '512M');\\ndefine('WP_MAX_MEMORY_LIMIT', '1024M');" wp-config.php`;
        
        let remoteWpConfigSuccess = false;
        try {
          const sedResult = await this.execWithTimeout(sshClient, sedCmd);
          const sedDuration = performance.now() - sedStart;
          console.log(`[PERFORMANCE] Edición de wp-config.php remota (sed): ${sedDuration.toFixed(2)} ms (Exit Code: ${sedResult.code})`);
          if (sedResult.code === 0) {
            remoteWpConfigSuccess = true;
            wpConfigExtracted = true;
            wpConfigModified = true;
            this.emitLog(taskId, domain, 22, `[FS] wp-config.php remoto modificado (sed: ${sedDuration.toFixed(2)} ms)`);
          } else {
            console.warn(`[WP-CONFIG-WARN] sed falló con código ${sedResult.code}: ${sedResult.stderr}`);
          }
        } catch (sedErr) {
          console.warn(`[WP-CONFIG-WARN] sed falló: ${sedErr.message}`);
        }

        this.emitLog(taskId, domain, 25, `[SSH] Creando directorio temporal remoto...`);
        await this.execWithTimeout(sshClient, `mkdir -p "${tempRemotePath}"`);

        // ---- 3. FASE 2: EMPAQUETADO REMOTO ----
        this.emitLog(taskId, domain, 30, `Paso 1: Comprimiendo archivos en Hostinger...`);
        const remoteGzPath = `${tempRemotePath}/${safeDomain}.tar.gz`;
        const tarCmd = `tar -czf "${remoteGzPath}" -C "${remotePath}" --exclude='krk_temp_*' --exclude='.git*' --exclude='.DS_Store' --exclude='.Trash*' --exclude='.tmp*' --exclude='wp-content/cache/*' --exclude='wp-content/uploads/cache/*' .`;
        const tarResult = await this.execWithTimeout(sshClient, tarCmd);
        if (tarResult.code !== 0) {
          throw new Error(`[TAR] Falló compresión remota: ${tarResult.stderr || tarResult.stdout}`);
        }

        // ---- 4. BASE DE DATOS DUMP ----
        let remoteSqlPath = null;
        if (dbName) {
          this.emitLog(taskId, domain, 50, `[DB] Dumpeando base de datos ${dbName}...`);
          remoteSqlPath = `${tempRemotePath}/${safeDomain}.sql`;
          const escapedPass = dbPass.replace(/'/g, "'\\''");
          const dumpCmd = `mysqldump --no-tablespaces --default-character-set=utf8mb4 -u ${dbUser} -p'${escapedPass}' ${dbName} > "${remoteSqlPath}"`;
          const dumpResult = await this.execWithTimeout(sshClient, dumpCmd);
          if (dumpResult.code !== 0 || (dumpResult.stderr && dumpResult.stderr.trim().length > 0)) {
            throw new Error(`[DB] mysqldump falló: ${dumpResult.stderr || dumpResult.stdout}`);
          }
        }

        // ---- 5. FASE 3: EXTRACCIÓN DE ALTA VELOCIDAD (HTTP) ----
        this.emitLog(taskId, domain, 60, `Paso 2: Iniciando descargas de alta velocidad vía HTTP...`);
        
        // Descargar Tarball
        const tarUrl = `https://${domain}/${tempFolderName}/${safeDomain}.tar.gz`;
        const maxAttempts = 3;
        let tarDownloadSuccess = false;
        let tarAttempts = 0;

        while (!tarDownloadSuccess && tarAttempts < maxAttempts) {
          try {
            await this.downloadFileViaHttp(tarUrl, localGzPath, (received, total, pct, msg) => {
              const mapped = 60 + Math.round(pct * 0.20);
              this.emitLog(taskId, domain, mapped, msg || `[FS] Descargando archivos... ${pct}%`, { consoleThrottleKey: `download-${localGzPath}` });
            });
            tarDownloadSuccess = true;
          } catch (downloadError) {
            tarAttempts++;
            if (tarAttempts < maxAttempts) {
              console.warn(`[DOWNLOAD-RETRY] Intento de descarga de archivos ${tarAttempts}/${maxAttempts} falló para ${domain}. Reintentando HTTP en 10s...`);
              this.emitLog(taskId, domain, 60, `[WARNING] Descarga falló (Intento ${tarAttempts}/${maxAttempts}). Reintentando en 10s...`);
              
              await new Promise(resolve => setTimeout(resolve, 10000));
              
              // Asegurarse de que el comando de compresión remota se lanzó correctamente
              this.emitLog(taskId, domain, 60, `[SSH] Verificando integridad del archivo remoto comprimido...`);
              const testFileCmd = `test -f "${remoteGzPath}" && du -b "${remoteGzPath}" | cut -f1 || echo "NOT_FOUND"`;
              try {
                const fileCheckResult = await this.execWithTimeout(sshClient, testFileCmd);
                const output = (fileCheckResult.stdout || '').trim();
                
                if (output === 'NOT_FOUND' || parseInt(output, 10) === 0) {
                  console.warn(`[DOWNLOAD-RETRY] Archivo comprimido remoto no encontrado o vacío. Volviendo a comprimir...`);
                  this.emitLog(taskId, domain, 30, `[SSH] Regenerando archivo comprimido en Hostinger...`);
                  const retryTarResult = await this.execWithTimeout(sshClient, tarCmd);
                  if (retryTarResult.code !== 0) {
                    throw new Error(`[TAR] Falló la compresión remota en reintento: ${retryTarResult.stderr || retryTarResult.stdout}`);
                  }
                } else {
                  console.log(`[DOWNLOAD-RETRY] Archivo comprimido remoto verificado con éxito (${(parseInt(output, 10) / 1024 / 1024).toFixed(2)} MB).`);
                }
              } catch (checkErr) {
                console.warn(`[DOWNLOAD-RETRY] Error verificando/regenerando archivo remoto: ${checkErr.message}. Intentando relanzar compresión...`);
                await this.execWithTimeout(sshClient, tarCmd).catch(() => {});
              }
            } else {
              // Ha fallado 3 veces. Cambiamos a SFTP.
              console.log(`[DOWNLOAD-SFTP-FALLBACK] HTTP falló 3 veces. Cambiando a canal seguro SFTP/SCP para ${domain}...`);
              this.emitLog(taskId, domain, 60, `[SFTP] Canal HTTP bloqueado o fallido. Iniciando transferencia segura por túnel SFTP...`);
              
              try {
                await this.downloadFileViaSftp(sshClient, remoteGzPath, localGzPath, (received, total, pct, msg) => {
                  const mapped = 60 + Math.round(pct * 0.20);
                  this.emitLog(taskId, domain, mapped, msg || `[SFTP] Descargando archivos... ${pct}%`, { consoleThrottleKey: `download-${localGzPath}` });
                });
                tarDownloadSuccess = true;
              } catch (sftpError) {
                try { fsSync.unlinkSync(localGzPath); } catch (_) {}
                throw new Error(`Error en descarga SFTP tras fallo HTTP: ${sftpError.message}`);
              }
            }
          }
        }

        const filesSize = await this.getFileSize(localGzPath);
        if (filesSize === 0) {
          try { fsSync.unlinkSync(localGzPath); } catch (_) {}
          throw new Error(`[ERROR] Archivo descargado vacío: ${localGzPath}`);
        }
        const localTarPath = localGzPath;

        // Descargar SQL
        let dbSize = 0;
        if (dbName && remoteSqlPath) {
          this.emitLog(taskId, domain, 80, `Paso 3: Descargando base de datos por HTTP...`);
          const sqlUrl = `https://${domain}/${tempFolderName}/${safeDomain}.sql`;
          let sqlDownloadSuccess = false;
          let sqlAttempts = 0;

          while (!sqlDownloadSuccess && sqlAttempts < maxAttempts) {
            try {
              await this.downloadFileViaHttp(sqlUrl, localSqlPath, (received, total, pct, msg) => {
                const mapped = 80 + Math.round(pct * 0.10);
                this.emitLog(taskId, domain, mapped, msg || `[DB] Descargando base de datos... ${pct}%`, { consoleThrottleKey: `download-${localSqlPath}` });
              });
              sqlDownloadSuccess = true;
            } catch (downloadError) {
              sqlAttempts++;
              if (sqlAttempts < maxAttempts) {
                console.warn(`[DOWNLOAD-RETRY] Intento de descarga de BD ${sqlAttempts}/${maxAttempts} falló para ${domain}. Reintentando HTTP en 10s...`);
                this.emitLog(taskId, domain, 80, `[WARNING] Descarga de BD falló (Intento ${sqlAttempts}/${maxAttempts}). Reintentando en 10s...`);
                
                await new Promise(resolve => setTimeout(resolve, 10000));
                
                // Asegurarse de que el archivo SQL remoto exista y no esté vacío
                this.emitLog(taskId, domain, 80, `[SSH] Verificando integridad del volcado SQL remoto...`);
                const testSqlCmd = `test -f "${remoteSqlPath}" && du -b "${remoteSqlPath}" | cut -f1 || echo "NOT_FOUND"`;
                try {
                  const sqlCheckResult = await this.execWithTimeout(sshClient, testSqlCmd);
                  const output = (sqlCheckResult.stdout || '').trim();
                  
                  if (output === 'NOT_FOUND' || parseInt(output, 10) === 0) {
                    console.warn(`[DOWNLOAD-RETRY] Volcado SQL remoto no encontrado o vacío. Regenerando mysqldump...`);
                    this.emitLog(taskId, domain, 50, `[DB] Volviendo a exportar la base de datos...`);
                    const escapedPass = dbPass.replace(/'/g, "'\\''");
                    const dumpCmd = `mysqldump --no-tablespaces --default-character-set=utf8mb4 -u ${dbUser} -p'${escapedPass}' ${dbName} > "${remoteSqlPath}"`;
                    const dumpResult = await this.execWithTimeout(sshClient, dumpCmd);
                    if (dumpResult.code !== 0) {
                      throw new Error(`[DB] mysqldump falló en reintento: ${dumpResult.stderr || dumpResult.stdout}`);
                    }
                  } else {
                    console.log(`[DOWNLOAD-RETRY] Volcado SQL remoto verificado con éxito (${(parseInt(output, 10) / 1024 / 1024).toFixed(2)} MB).`);
                  }
                } catch (checkErr) {
                  console.warn(`[DOWNLOAD-RETRY] Error verificando/regenerando SQL remoto: ${checkErr.message}.`);
                }
              } else {
                // Ha fallado 3 veces. Cambiamos a SFTP.
                console.log(`[DOWNLOAD-SFTP-FALLBACK] HTTP de SQL falló 3 veces. Cambiando a canal seguro SFTP/SCP para ${domain}...`);
                this.emitLog(taskId, domain, 80, `[SFTP] Canal HTTP bloqueado o fallido. Iniciando transferencia de base de datos por SFTP...`);
                
                try {
                  await this.downloadFileViaSftp(sshClient, remoteSqlPath, localSqlPath, (received, total, pct, msg) => {
                    const mapped = 80 + Math.round(pct * 0.10);
                    this.emitLog(taskId, domain, mapped, msg || `[SFTP] Descargando base de datos... ${pct}%`, { consoleThrottleKey: `download-${localSqlPath}` });
                  });
                  sqlDownloadSuccess = true;
                } catch (sftpError) {
                  try { fsSync.unlinkSync(localSqlPath); } catch (_) {}
                  throw new Error(`Error en descarga SFTP de base de datos tras fallo HTTP: ${sftpError.message}`);
                }
              }
            }
          }

          dbSize = await this.getFileSize(localSqlPath);
          if (dbSize === 0) {
            try { fsSync.unlinkSync(localSqlPath); } catch (_) {}
            throw new Error(`[ERROR] SQL descargado vacío: ${localSqlPath}`);
          }
        }

        // ---- 5. POST-PROCESADO: MEMORIA WP (local tar.gz) ----
        this.emitLog(taskId, domain, 90, `[FS] Procesando wp-config.php (límites de memoria)...`);
        try {
          const { performance } = require('node:perf_hooks');
          const localInjectStart = performance.now();
          const modified = await this.injectMemoryLimitsFromTar(localTarPath, localTempDomainPath, configContent);
          const localInjectDuration = performance.now() - localInjectStart;
          console.log(`[PERFORMANCE] Edición e inyección local de wp-config.php: ${localInjectDuration.toFixed(2)} ms`);
          if (modified) {
            wpConfigExtracted = true;
            wpConfigModified = true;
            this.emitLog(taskId, domain, 92, `[FS] wp-config.php local guardado — memory_limit: 512M/1024M (${localInjectDuration.toFixed(2)} ms)`);
          }
        } catch (e) {
          this.emitLog(taskId, domain, 92, `[FS] No se pudo modificar wp-config.php localmente: ${e.message}`);
        }

        // ---- 5.5 MOVER CARPETA COMPLETA AL ALMACENAMIENTO DE DESTINO ----
        this.emitLog(taskId, domain, 95, `[FS] Trasladando respaldos al almacenamiento de destino...`);
        const finalDomainPath = await this.workspaceManager.createDomainFolder(accountName, cloudName, safeDomain);
        
        // Mover los archivos de la carpeta temporal local a la carpeta de destino
        const tempFiles = await fsp.readdir(localTempDomainPath);
        for (const file of tempFiles) {
          const srcFile = path.join(localTempDomainPath, file);
          const destFile = path.join(finalDomainPath, file);
          if (file === 'logs') {
            // Mover logs
            const finalLogsPath = path.join(finalDomainPath, 'logs');
            await this.workspaceManager.ensureDirectoryExists(finalLogsPath);
            const logFiles = await fsp.readdir(srcFile);
            for (const logFile of logFiles) {
              await this.moveFileToDestination(path.join(srcFile, logFile), path.join(finalLogsPath, logFile), () => {
                // Progreso silencioso para logs pequeños
              });
            }
          } else {
            await this.moveFileToDestination(srcFile, destFile, (moved, total, pct, msg) => {
              // Reportar progreso del traslado de archivos grandes a la UI
              const mapped = 95 + Math.round(pct * 0.04);
              this.emitLog(taskId, domain, mapped, msg, { consoleThrottleKey: `move-${destFile}` });
            });
          }
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
          filesPath: path.join(finalDomainPath, `${safeDomain}.tar.gz`),
          dbPath: dbName && remoteSqlPath ? path.join(finalDomainPath, `${safeDomain}.sql`) : null,
          filesSize,
          dbSize,
          totalSize,
          duration,
          avgSpeed,
          wpConfigExtracted,
          wpConfigModified,
          wpConfigPath: wpConfigExtracted ? path.join(finalDomainPath, 'wp-config.php') : null,
          metrics: {
            filesSizeMB: (filesSize / 1024 / 1024).toFixed(2),
            dbSizeMB: (dbSize / 1024 / 1024).toFixed(2),
            totalSizeMB: (totalSize / 1024 / 1024).toFixed(2),
            durationSeconds: duration.toFixed(2),
            speedMBps: avgSpeed
          }
        };

      } finally {
        // ---- FASE 5: LIMPIEZA CRÍTICA (Fail-Safe) ----
        if (sshClient && tempRemotePath) {
          try {
            console.log(`[CLEANUP] Eliminando directorio temporal remoto: ${tempRemotePath}`);
            await this.execWithTimeout(sshClient, `rm -rf "${tempRemotePath}"`);
          } catch (cleanupError) {
            const errorMsg = `[BASURA RESIDUAL] No se pudo eliminar la carpeta temporal ${tempRemotePath} en ${domain}: ${cleanupError.message}`;
            console.error(errorMsg);
            this.emitLog(taskId, domain, 99, `[CLEANUP-ERROR] ${errorMsg}`);
            try {
              const finalDomainPath = this.workspaceManager.getDomainPath(accountName, cloudName, safeDomain);
              const finalLogsPath = path.join(finalDomainPath, 'logs');
              await this.workspaceManager.ensureDirectoryExists(finalLogsPath);
              const logFile = path.join(finalLogsPath, 'cleanup_errors.log');
              fsSync.appendFileSync(logFile, `[${new Date().toISOString()}] ${errorMsg}\n`, 'utf8');
            } catch (fsLogErr) {
              console.error(`[FS-LOG-ERROR] No se pudo escribir log de limpieza local: ${fsLogErr.message}`);
            }
          }
        }
      }

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
      // Limpiar directorio temporal local en el almacenamiento temporal
      if (localTempDomainPath) {
        try {
          const fsSync = require('fs');
          if (fsSync.existsSync(localTempDomainPath)) {
            fsSync.rmSync(localTempDomainPath, { recursive: true, force: true });
          }
        } catch (_) {}
      }
    }
  }

  // ================================================================
  // MÉTODO: extractWordPressUltraLite
  // Extrae SOLO lo necesario desde Hostinger:
  //   1. wp-content/uploads/ (comprimido como uploads.tar.gz en temp remoto)
  //   2. DB dump CRUDO — sin limpiar (seguridad de integridad del cloud)
  //   3. config.json (prefix, theme, plugins — generado remotamente)
  //
  // La limpieza de la DB ocurre en el despliegue (Plesk), nunca aquí.
  //
  // Resultado final local:
  //   {cloud}/{dominio}/{dominio}.tar.gz
  //   Dentro del tar: uploads/ + config.json + {dominio}.sql
  // ================================================================

  async extractWordPressUltraLite(accountName, cloudName, domain, taskId) {
    const startTime = Date.now();
    let sshClient = null;
    let localTempDomainPath = null;

    try {
      const safeDomain = this.getSafeDomainPath(domain);
      if (safeDomain !== domain) {
        this.emitLog(taskId, domain, 0, `[IDN] Dominio internacional: ${domain} → ${safeDomain}`);
      }

      const config = this.configManager.getConfig();
      const account = config.accounts.find(acc => acc.name === accountName);
      if (!account) throw new Error(`Cuenta "${accountName}" no encontrada`);

      const cloud = account.originClouds.find(c => c.name === cloudName);
      if (!cloud) throw new Error(`Cloud "${cloudName}" no encontrado en cuenta "${accountName}"`);
      if (!cloud.isLinked) throw new Error(`Cloud "${cloudName}" no tiene SSH vinculado`);

      // ── Skip si ya está en formato Ultra-Lite ──
      try {
        const existingDomainPath = this.workspaceManager.getDomainPath(accountName, cloudName, safeDomain);
        if (existingDomainPath) {
          const existingTar = path.join(existingDomainPath, `${safeDomain}.tar.gz`);
          if (fsSync.existsSync(existingTar)) {
            let hasConfig = false;
            await tar.t({ file: existingTar, onentry: (entry) => {
              if (entry.path === 'config.json' || entry.path.endsWith('/config.json')) hasConfig = true;
            }}).catch(() => {});
            if (hasConfig) {
              this.emitLog(taskId, domain, 100, `[SKIP] ${domain} ya está en formato Ultra-Lite.`);
              this.progressEmitter.emitProgress({ taskId, module: 'extraction', domain, progress: 100, message: `[SKIP] ${domain} ya procesado.` });
              return { success: true, accountName, cloudName, domain, skipped: true, tarPath: existingTar };
            }
            // Limpiar residuos del proceso anterior aunque no sea Ultra-Lite
            const wpConfigLoose = path.join(existingDomainPath, 'wp-config.php');
            const residualHostinger = path.join(existingDomainPath, `${safeDomain}-hostinger.sql`);
            if (fsSync.existsSync(wpConfigLoose)) {
              try { await fsp.unlink(wpConfigLoose); } catch (_) {}
              this.emitLog(taskId, domain, 1, `[CLEAN] wp-config.php residual eliminado.`);
            }
            if (fsSync.existsSync(residualHostinger)) {
              try { await fsp.unlink(residualHostinger); } catch (_) {}
            }
          }
        }
      } catch (_) { /* si falla la verificación, continuar con la extracción */ }

      this.emitLog(taskId, domain, 1, `[ULTRA-LITE] Iniciando extracción quirúrgica: ${domain}`);

      await this.validateCloudConnection(cloud, accountName, cloudName, taskId);

      const sshCredentials = { ...cloud.sshCredentials };
      if (!sshCredentials.privateKey) {
        const cfg = this.configManager.getConfig();
        const keyPath = cfg?.sshKeys?.privateKeyPath || '~/.ssh/id_rsa';
        const resolvedPath = this.resolvePrivateKeyPath(keyPath);
        try { sshCredentials.privateKey = fsSync.readFileSync(resolvedPath, 'utf8'); } catch (_) {}
      }

      try {
        sshClient = await this.sshService.connect(sshCredentials, `extraction-lite-${taskId}`);
      } catch (connectError) {
        const msg = connectError.message || '';
        if (msg.includes('All configured authentication methods failed')) {
          throw new Error(`[SSH] Error de autenticación. Verifique la llave SSH para ${sshCredentials.host}.`);
        }
        throw new Error(`[SSH] Error de conexión: ${msg}`);
      }

      // ── Rutas locales temporales ──
      const tempDownloadDir = this.configManager.getTempDownloadPath();
      localTempDomainPath = path.join(tempDownloadDir, `ulite-${Date.now()}-${safeDomain}`);
      await fsp.mkdir(localTempDomainPath, { recursive: true });

      // ── Detectar ruta remota ──
      this.emitLog(taskId, domain, 10, `[FS] Localizando WordPress en el servidor...`);
      const whoamiResult = await this.execWithTimeout(sshClient, 'whoami');
      const pwdResult = await this.execWithTimeout(sshClient, 'pwd');
      const sshUser = whoamiResult.stdout.trim();
      const currentPwd = pwdResult.stdout.trim();
      const remotePath = await this.resolveWordPressPath(sshClient, safeDomain, sshUser, currentPwd);
      this.emitLog(taskId, domain, 12, `[FS] WordPress encontrado en: ${remotePath}`);

      // ── Leer wp-config.php ──
      this.emitLog(taskId, domain, 15, `[WP] Leyendo wp-config.php...`);
      const cfgResult = await this.execWithTimeout(sshClient, `cat "${remotePath}/wp-config.php"`);
      if (cfgResult.code !== 0) throw new Error(`[WP] No se pudo leer wp-config.php: ${cfgResult.stderr}`);
      const configContent = cfgResult.stdout;

      let dbName = null, dbUser = null, dbPass = null, dbPrefix = 'wp_';
      for (const line of configContent.split('\n')) {
        const t = line.trim();
        if (t.startsWith('//') || t.startsWith('#') || t.startsWith('/*')) continue;
        const nameMatch  = t.match(/define\s*\(\s*['"]DB_NAME['"]\s*,\s*['"]([^'"]+)['"]\s*\)/);
        const userMatch  = t.match(/define\s*\(\s*['"]DB_USER['"]\s*,\s*['"]([^'"]+)['"]\s*\)/);
        const passMatch  = t.match(/define\s*\(\s*['"]DB_PASSWORD['"]\s*,\s*['"]([^'"]+)['"]\s*\)/);
        const prefixMatch = t.match(/\$table_prefix\s*=\s*['"]([^'"]+)['"]/);
        if (nameMatch)  dbName   = nameMatch[1];
        if (userMatch)  dbUser   = userMatch[1];
        if (passMatch)  dbPass   = passMatch[1];
        if (prefixMatch) dbPrefix = prefixMatch[1];
      }
      if (!dbName) throw new Error(`[WP] No se pudo extraer DB_NAME de wp-config.php`);
      this.emitLog(taskId, domain, 18, `[WP] DB: ${dbName} | Prefix: ${dbPrefix}`);

      // ── Carpeta temporal remota ──
      const crypto = require('crypto');
      const token = crypto.randomBytes(5).toString('hex');
      const tempFolderName = `krk_ulite_${token}`;
      const tempRemotePath = `${remotePath}/${tempFolderName}`;

      await this.execWithTimeout(sshClient, `find "${remotePath}" -maxdepth 1 -name 'krk_ulite_*' -type d -exec rm -rf {} + 2>/dev/null || true`);
      await this.execWithTimeout(sshClient, `mkdir -p "${tempRemotePath}"`);

      // ── PASO 1: Escanear plugins y tema activo ──
      this.emitLog(taskId, domain, 20, `[CONFIG] Escaneando plugins y tema activo...`);
      const escapedPass = dbPass.replace(/'/g, "'\\''");
      const themeCmd = `mysql -u${dbUser} -p'${escapedPass}' ${dbName} -Nse "SELECT option_value FROM ${dbPrefix}options WHERE option_name='template' LIMIT 1;" 2>/dev/null`;
      const themeResult = await this.execWithTimeout(sshClient, themeCmd);
      const theme = (themeResult.stdout || 'hello-elementor').trim().split('\n')[0] || 'hello-elementor';

      const pluginsCmd = `ls -1 "${remotePath}/wp-content/plugins/" 2>/dev/null || echo ""`;
      const pluginsResult = await this.execWithTimeout(sshClient, pluginsCmd);
      const plugins = (pluginsResult.stdout || '').split('\n').map(p => p.trim()).filter(p => p && p !== 'index.php');

      // ── PASO 2: Generar config.json remoto ──
      const configJson = JSON.stringify({ db_prefix: dbPrefix, theme, plugins }, null, 2);
      // Escribir vía heredoc para evitar problemas de quoting
      await this.execWithTimeout(sshClient,
        `printf '%s' '${configJson.replace(/'/g, "'\\''")}' > "${tempRemotePath}/config.json"`
      );
      this.emitLog(taskId, domain, 25, `[CONFIG] config.json generado (${plugins.length} plugins, tema: ${theme})`);

      // ── PASO 3: Comprimir uploads en el servidor ──
      this.emitLog(taskId, domain, 30, `[TAR] Comprimiendo uploads/...`);
      const remoteUploadsTar = `${tempRemotePath}/uploads.tar.gz`;
      const uploadsPath = `${remotePath}/wp-content/uploads`;
      const uploadsCheck = await this.execWithTimeout(sshClient, `test -d "${uploadsPath}" && echo "OK" || echo "MISSING"`);

      if ((uploadsCheck.stdout || '').trim() === 'OK') {
        const tarResult = await this.execWithTimeout(sshClient,
          `tar -czf "${remoteUploadsTar}" -C "${remotePath}/wp-content" uploads 2>/dev/null`
        );
        if (tarResult.code !== 0) {
          this.emitLog(taskId, domain, 32, `[TAR-WARN] Error leve comprimiendo uploads: ${(tarResult.stderr || '').substring(0, 100)}`);
        }
      } else {
        this.emitLog(taskId, domain, 32, `[WARN] No hay carpeta uploads/ — creando archivo vacío`);
        await this.execWithTimeout(sshClient,
          `mkdir -p "${uploadsPath}" && tar -czf "${remoteUploadsTar}" -C "${remotePath}/wp-content" uploads`
        );
      }

      // ── PASO 4: Dump DB crudo ──
      this.emitLog(taskId, domain, 45, `[DB] Dumpeando ${dbName} (sin modificar — integridad garantizada)...`);
      const remoteSqlPath = `${tempRemotePath}/${safeDomain}.sql`;
      const dumpCmd = `mysqldump --no-tablespaces --default-character-set=utf8mb4 -u${dbUser} -p'${escapedPass}' ${dbName} > "${remoteSqlPath}"`;
      const dumpResult = await this.execWithTimeout(sshClient, dumpCmd);
      if (dumpResult.code !== 0) throw new Error(`[DB] mysqldump falló: ${dumpResult.stderr || dumpResult.stdout}`);
      this.emitLog(taskId, domain, 55, `[DB] Dump completado.`);

      // ── PASO 5: Descargar los 3 archivos ──
      const localUploadsTar  = path.join(localTempDomainPath, 'uploads.tar.gz');
      const localSqlPath     = path.join(localTempDomainPath, `${safeDomain}.sql`);
      const localConfigJson  = path.join(localTempDomainPath, 'config.json');
      const maxAttempts = 3;

      // uploads.tar.gz
      this.emitLog(taskId, domain, 60, `[DOWNLOAD] Descargando uploads...`);
      const uploadsUrl = `https://${domain}/${tempFolderName}/uploads.tar.gz`;
      let uploadsDone = false;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          await this.downloadFileViaHttp(uploadsUrl, localUploadsTar, (r, t, pct) => {
            this.emitLog(taskId, domain, 60 + Math.round(pct * 0.10), `[HTTP] uploads ${pct}%`, { consoleThrottleKey: `ul-${domain}` });
          });
          uploadsDone = true; break;
        } catch (e) {
          if (attempt === maxAttempts) {
            this.emitLog(taskId, domain, 60, `[SFTP] HTTP falló, usando SFTP para uploads...`);
            await this.downloadFileViaSftp(sshClient, remoteUploadsTar, localUploadsTar, (r, t, pct) => {
              this.emitLog(taskId, domain, 60 + Math.round(pct * 0.10), `[SFTP] uploads ${pct}%`, { consoleThrottleKey: `ul-sftp-${domain}` });
            });
            uploadsDone = true;
          } else { await new Promise(r => setTimeout(r, 8000)); }
        }
      }

      // SQL
      this.emitLog(taskId, domain, 72, `[DOWNLOAD] Descargando base de datos...`);
      const sqlUrl = `https://${domain}/${tempFolderName}/${safeDomain}.sql`;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          await this.downloadFileViaHttp(sqlUrl, localSqlPath, (r, t, pct) => {
            this.emitLog(taskId, domain, 72 + Math.round(pct * 0.15), `[HTTP] DB ${pct}%`, { consoleThrottleKey: `sql-${domain}` });
          });
          break;
        } catch (e) {
          if (attempt === maxAttempts) {
            this.emitLog(taskId, domain, 72, `[SFTP] HTTP falló, usando SFTP para SQL...`);
            await this.downloadFileViaSftp(sshClient, remoteSqlPath, localSqlPath, (r, t, pct) => {
              this.emitLog(taskId, domain, 72 + Math.round(pct * 0.15), `[SFTP] DB ${pct}%`, { consoleThrottleKey: `sql-sftp-${domain}` });
            });
          } else { await new Promise(r => setTimeout(r, 8000)); }
        }
      }

      // config.json
      const configUrl = `https://${domain}/${tempFolderName}/config.json`;
      try {
        await this.downloadFileViaHttp(configUrl, localConfigJson);
      } catch {
        await this.downloadFileViaSftp(sshClient, `${tempRemotePath}/config.json`, localConfigJson);
      }

      // ── Validar SQL ──
      const sqlSize = await this.getFileSize(localSqlPath);
      if (sqlSize === 0) throw new Error(`[DB] SQL descargado vacío para ${domain}`);
      const uploadsSize = await this.getFileSize(localUploadsTar);

      // ── PASO 6: Empaquetar uploads.tar.gz + sql + config en {dominio}.tar.gz ──
      // IMPORTANTE: NO descomprimimos uploads.tar.gz — lo incluimos tal cual en el paquete final.
      // Descomprimir 1GB+ para recomprimir es O(n) innecesario y causa hangs de horas.
      this.emitLog(taskId, domain, 90, `[PACK] Armando paquete Ultra-Lite...`);

      // Crear carpeta destino definitiva
      const finalDomainPath = await this.workspaceManager.createDomainFolder(accountName, cloudName, safeDomain);

      const finalTarPath = path.join(finalDomainPath, `${safeDomain}.tar.gz`);

      // Colectar items del temp: uploads.tar.gz (sin extraer) + config.json + {dominio}.sql
      const tempContents = await fsp.readdir(localTempDomainPath);
      const itemsToInclude = tempContents.filter(f => f !== 'logs');

      await tar.c(
        { gzip: true, file: finalTarPath, cwd: localTempDomainPath, strict: false },
        itemsToInclude
      );

      const finalSize = await this.getFileSize(finalTarPath);
      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      this.emitLog(taskId, domain, 98, `[PACK] ${safeDomain}.tar.gz → ${(finalSize / 1024 / 1024).toFixed(2)} MB`);

      // Registro en dominios_procesados.json
      await this.workspaceManager.updateDominiosProcesados(accountName, cloudName, [domain]);

      this.emitLog(taskId, domain, 100, `[✅ ULTRA-LITE] ${domain} listo en ${duration}s — ${(finalSize / 1024 / 1024).toFixed(2)} MB`);

      // ── PASO 7: Descarga de emails ──
      try {
        // Opción A: Extraer correos gratuitos directamente desde el disco del Hosting Web vía SSH (~/mail/dominio)
        const mailCheckCmd = `test -d "$HOME/mail/${domain}" && echo "OK" || (test -d "$HOME/mail/${safeDomain}" && echo "OK" || echo "MISSING")`;
        const mailCheck = await this.execWithTimeout(sshClient, mailCheckCmd);

        let sshMailExtracted = false;
        if ((mailCheck.stdout || '').trim() === 'OK') {
          this.emitLog(taskId, domain, 90, `[EMAIL-SSH] Carpeta de correo detectada en Hosting Web. Comprimiendo buzones...`);
          const remoteEmailTar = `${tempRemotePath}/emails.tar.gz`;
          const tarEmailRes = await this.execWithTimeout(sshClient,
            `tar -czf "${remoteEmailTar}" -C "$HOME/mail" "${domain}" 2>/dev/null || tar -czf "${remoteEmailTar}" -C "$HOME/mail" "${safeDomain}" 2>/dev/null`
          );
          if (tarEmailRes.code === 0) {
            const localEmailsTar = path.join(finalDomainPath, 'emails.tar.gz');
            await this.sshService.downloadFile(sshClient, remoteEmailTar, localEmailsTar);
            this.emitLog(taskId, domain, 95, `[EMAIL-SSH] ✅ emails.tar.gz extraído directamente desde el Hosting Web.`, 'success');
            sshMailExtracted = true;
          }
        }

        // Opción B: Si no se extrajo por SSH y hay API Token de Hostinger Email Pro, consultar API
        if (!sshMailExtracted) {
          const mailApiToken = this.configManager.getConfig()?.hostingerMail?.apiToken;
          if (mailApiToken) {
            this.emitLog(taskId, domain, 99, `[EMAIL] Verificando buzones en Hostinger Email API para ${domain}...`);
            const { downloadEmailsForDomain } = require('../main/ipc/email.ipc');
            const emailResult = await downloadEmailsForDomain(
              domain,
              finalDomainPath,
              mailApiToken,
              (msg, type) => this.emitLog(taskId, domain, 99, msg)
            );
            if (emailResult.success && !emailResult.skipped) {
              this.emitLog(taskId, domain, 99, `[EMAIL] ✅ ${emailResult.totalMessages} correos guardados en emails.tar.gz`, 'success');
            }
          }
        }
      } catch (emailErr) {
        // El error de email NO cancela el backup de WordPress
        this.emitLog(taskId, domain, 99, `[EMAIL][WARN] No se pudieron descargar correos: ${emailErr.message}`, 'warning');
      }

      return {
        success: true,
        accountName,
        cloudName,
        domain,
        tarPath: finalTarPath,
        finalSize,
        duration,
        metrics: {
          uploadsSizeMB: (uploadsSize / 1024 / 1024).toFixed(2),
          sqlSizeMB: (sqlSize / 1024 / 1024).toFixed(2),
          finalSizeMB: (finalSize / 1024 / 1024).toFixed(2),
          durationSeconds: duration,
          plugins: plugins.length,
          theme,
        },
      };


    } catch (error) {
      this.progressEmitter.emitProgress({
        taskId, module: 'extraction', domain, progress: 0,
        message: `[ERROR] ${error.message}`,
      });
      throw error;
    } finally {
      // ── Limpieza remota ──
      if (sshClient) {
        try { sshClient.end(); } catch (_) {}
      }
      // ── Limpieza local temporal ──
      if (localTempDomainPath) {
        try {
          if (fsSync.existsSync(localTempDomainPath)) {
            fsSync.rmSync(localTempDomainPath, { recursive: true, force: true });
          }
        } catch (_) {}
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
   * Inject memory limits into wp-config.php locally.
   * Bypasses local tar extraction/compression to avoid PCIe bus starvation.
   * @param {string} localTarPath - Path to the local .tar.gz (kept for compatibility)
   * @param {string} domainPath - Destination folder to write the local wp-config.php
   * @param {string} configContent - Original content of wp-config.php
   * @returns {Promise<boolean>} true if wp-config.php was modified and written successfully
   */
  async injectMemoryLimitsFromTar(localTarPath, domainPath, configContent) {
    if (!configContent) {
      console.warn('[WP-CONFIG] No se recibió el contenido original para procesar localmente.');
      return false;
    }

    try {
      const stopMarker = "/* That's all, stop editing!";
      let localWpConfigContent = configContent;

      // Limpiamos los límites de memoria existentes si los hubiera para evitar duplicados
      localWpConfigContent = localWpConfigContent.replace(/define\s*\(\s*['"]WP_MEMORY_LIMIT['"]\s*,\s*[^)]+\)\s*;?/g, '');
      localWpConfigContent = localWpConfigContent.replace(/define\s*\(\s*['"]WP_MAX_MEMORY_LIMIT['"]\s*,\s*[^)]+\)\s*;?/g, '');

      let stopIdx = localWpConfigContent.indexOf(stopMarker);
      if (stopIdx === -1) {
        // Fallback al ABSPATH si no se encuentra el stopMarker estándar de WP
        const abspathMarker = "if ( ! defined( 'ABSPATH' ) )";
        stopIdx = localWpConfigContent.indexOf(abspathMarker);
      }

      if (stopIdx !== -1) {
        localWpConfigContent = localWpConfigContent.slice(0, stopIdx) + 
          `define('WP_MEMORY_LIMIT', '512M');\ndefine('WP_MAX_MEMORY_LIMIT', '1024M');\n\n` + 
          localWpConfigContent.slice(stopIdx);
      } else {
        // Fallback final: al final del archivo
        localWpConfigContent += `\ndefine('WP_MEMORY_LIMIT', '512M');\ndefine('WP_MAX_MEMORY_LIMIT', '1024M');\n`;
      }

      const localWpConfigPath = path.join(domainPath, 'wp-config.php');
      await fsp.writeFile(localWpConfigPath, localWpConfigContent, 'utf8');
      return true;
    } catch (error) {
      console.error(`[WP-CONFIG] Error al escribir wp-config.php local: ${error.message}`);
      return false;
    }
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

  emitLog(taskId, domain, progress, message, options = {}) {
    process.nextTick(() => {
      this.progressEmitter.emitProgress(taskId, progress, message, options);
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

      let isUltraLite = false;
      if (filesExist && !dbExist && filesGz) {
        const tar = require('tar');
        try {
          await tar.t({ file: filesGzPath, onentry: (entry) => {
            if (entry.path === 'config.json' || entry.path.endsWith('/config.json')) isUltraLite = true;
          }});
        } catch (_) {}
      }

      console.log(`[FORCE]   Resultado: archivos=${filesExist} sql=${dbExist} ultraLite=${isUltraLite}`);

      const extracted = (filesExist && dbExist) || isUltraLite;

      return { extracted, filesExist, dbExist: dbExist || isUltraLite, isUltraLite, wpConfigExists, domainPath, filesPath };
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

  async downloadFileViaHttp(url, localPath, onProgress) {
    const axios = require('axios');
    const https = require('https');
    const fs = require('fs');
    const stream = require('stream');
    const { pipeline } = require('stream/promises');

    const agent = new https.Agent({ rejectUnauthorized: false });
    
    // Obtener el directorio temporal en el almacenamiento local
    const tempDir = this.configManager.getTempDownloadPath();
    await fsp.mkdir(tempDir, { recursive: true });
    
    const filename = path.basename(localPath);
    const tempFilePath = path.join(tempDir, `download-${Date.now()}-${filename}`);

    let response;
    try {
      response = await axios({
        method: 'get',
        url,
        responseType: 'stream',
        httpsAgent: agent,
        timeout: 300000 // 5 minutos de timeout
      });
    } catch (err) {
      if (url.startsWith('https://')) {
        const httpUrl = url.replace('https://', 'http://');
        console.warn(`[HTTP-BYPASS] Falló HTTPS, reintentando con HTTP: ${httpUrl}`);
        response = await axios({
          method: 'get',
          url: httpUrl,
          responseType: 'stream',
          timeout: 300000
        });
      } else {
        throw err;
      }
    }

    if (response.status >= 400) {
      throw new Error(`HTTP Error ${response.status}: ${response.statusText}`);
    }

    const totalBytes = parseInt(response.headers['content-length'], 10) || 0;
    let receivedBytes = 0;
    const startTime = Date.now();
    let lastEmit = 0;

    const progressTracker = new stream.Transform({
      transform(chunk, _encoding, callback) {
        receivedBytes += chunk.length;
        const now = Date.now();
        if (now - lastEmit >= 500) {
          lastEmit = now;
          const pct = totalBytes > 0 ? Math.round((receivedBytes / totalBytes) * 100) : 0;
          const elapsed = (now - startTime) / 1000;
          const transferredMb = receivedBytes / 1024 / 1024;
          const totalMb = totalBytes / 1024 / 1024;
          const speed = elapsed > 0 ? (transferredMb / elapsed) : 0;
          const msg = totalBytes > 0
            ? `Descargando: ${transferredMb.toFixed(2)} MB / ${totalMb.toFixed(2)} MB (${speed.toFixed(2)} MB/s)`
            : `Descargando: ${transferredMb.toFixed(2)} MB (${speed.toFixed(2)} MB/s)`;
          if (onProgress) {
            onProgress(receivedBytes, totalBytes, pct, msg);
          }
        }
        callback(null, chunk);
      }
    });

    const writer = fs.createWriteStream(tempFilePath);

    try {
      // stream.pipeline maneja backpressure y cleanup automáticamente
      await pipeline(response.data, progressTracker, writer);
      
      // Mover el archivo descargado desde la carpeta temporal de staging a la ruta intermedia local
      await this.moveFileToDestination(tempFilePath, localPath, onProgress);
    } catch (err) {
      // Limpieza del archivo temporal ante fallos
      try {
        if (fsSync.existsSync(tempFilePath)) {
          fsSync.unlinkSync(tempFilePath);
        }
      } catch (_) {}
      throw err;
    }
  }

  /**
   * Descarga un archivo directamente usando SFTP sobre el túnel SSH establecido,
   * con soporte de progreso en tiempo real y alta velocidad multicanal.
   */
  async downloadFileViaSftp(sshClient, remotePath, localPath, onProgress) {
    return this.sshService.downloadFileWithProgress(sshClient, remotePath, localPath, onProgress);
  }

  /**
   * Mueve un archivo desde el almacenamiento local temporal al destino final.
   * Usa rename() nativo si es el mismo volumen. Si detecta EXDEV (volúmenes distintos),
   * realiza la copia física secuencial utilizando pipeline de streams y reporta progreso en tiempo real.
   */
  async moveFileToDestination(tempPath, destPath, onProgress) {
    const fs = require('fs');
    const fsp = require('fs').promises;
    const stream = require('stream');
    const { pipeline } = require('stream/promises');

    await fsp.mkdir(path.dirname(destPath), { recursive: true });

    try {
      // Intentar rename atómico nativo primero
      await fsp.rename(tempPath, destPath);
      return;
    } catch (renameError) {
      if (renameError.code !== 'EXDEV') {
        throw renameError;
      }
      console.log(`[FS-MOVE] Enlace entre volúmenes detectado (EXDEV). Iniciando traslado mediante copia: ${tempPath} -> ${destPath}`);
    }

    // Fallback: copia con pipeline de streams y reporte de progreso
    const stat = await fsp.stat(tempPath);
    const totalBytes = stat.size;
    let movedBytes = 0;
    const startTime = Date.now();
    let lastEmit = 0;

    const readStream = fs.createReadStream(tempPath);
    const writeStream = fs.createWriteStream(destPath);

    const progressTracker = new stream.Transform({
      transform(chunk, _encoding, callback) {
        movedBytes += chunk.length;
        const now = Date.now();
        if (now - lastEmit >= 500) {
          lastEmit = now;
          const pct = totalBytes > 0 ? Math.round((movedBytes / totalBytes) * 100) : 0;
          const elapsed = (now - startTime) / 1000;
          const transferredMb = movedBytes / 1024 / 1024;
          const totalMb = totalBytes / 1024 / 1024;
          const speed = elapsed > 0 ? (transferredMb / elapsed) : 0;
          const msg = totalBytes > 0
            ? `Trasladando al almacenamiento de destino: ${transferredMb.toFixed(2)} MB / ${totalMb.toFixed(2)} MB (${speed.toFixed(2)} MB/s)`
            : `Trasladando al almacenamiento de destino: ${transferredMb.toFixed(2)} MB (${speed.toFixed(2)} MB/s)`;
          
          if (onProgress) {
            onProgress(movedBytes, totalBytes, pct, msg);
          }
        }
        callback(null, chunk);
      }
    });

    try {
      await pipeline(readStream, progressTracker, writeStream);
    } catch (copyErr) {
      // Limpieza de destino parcial si falla la copia
      try {
        if (fsSync.existsSync(destPath)) {
          fsSync.unlinkSync(destPath);
        }
      } catch (_) {}
      throw copyErr;
    }

    // Limpieza de temporal de staging
    try {
      await fsp.unlink(tempPath);
    } catch (cleanupErr) {
      console.warn(`[TRASLADO-WARNING] No se pudo eliminar el archivo temporal de staging: ${cleanupErr.message}`);
    }
  }
}

let _instance = null;
function getExtractionService() {
  if (!_instance) _instance = new ExtractionService();
  return _instance;
}
module.exports = { ExtractionService, getExtractionService };
