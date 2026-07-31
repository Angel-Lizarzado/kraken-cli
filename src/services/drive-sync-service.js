const fs = require('fs');
const path = require('path');
const { getDriveService } = require('./drive-service');
const { getBackupPacker } = require('./backup-packer');
const { getConfigManager } = require('./config-manager');
const { getWorkspaceManager } = require('./workspace-manager');
const { getProgressEmitter } = require('./progress-emitter');

class DriveSyncService {
  constructor() {
    this.driveService = getDriveService();
    this.packer = getBackupPacker();
    this.configManager = getConfigManager();
    this.workspaceManager = getWorkspaceManager();
    this.progressEmitter = getProgressEmitter();
    this.abortarSolicitado = false;
  }
  
  solicitarParada() {
    this.abortarSolicitado = true;
  }

  async _initDrive() {
    const config = this.configManager.getConfig();
    const driveConfig = config.googleDrive;
    if (!driveConfig || !driveConfig.credentialsPath || !driveConfig.rootFolderId) {
      throw new Error('Google Drive no está configurado. Por favor ingresa el archivo credentials.json y el ID de la carpeta en Configuración.');
    }
    await this.driveService.authenticate(driveConfig.credentialsPath);
    return driveConfig.rootFolderId;
  }

  async syncBatch(accountName, cloudName, domainsToSync, emitLog = null) {
    this.abortarSolicitado = false;
    const rootId = await this._initDrive();
    
    const taskId = `drivesync-${Date.now()}`;
    const log = (msg, type = 'info') => {
      console.log(`[DRIVE-SYNC] ${msg}`);
      if (emitLog) emitLog(msg, type);
    };

    // 1. Recopilar la lista de tareas: [{ accountName, cloudName, domainName }]
    let syncTasks = [];

    if (!accountName || !cloudName) {
      log('No se especificó cuenta/cloud. Escaneando carpetas en disco...', 'info');
      const config = this.configManager.getConfig();
      if (config && config.accounts) {
        for (const acc of config.accounts) {
          if (!acc.originClouds) continue;
          for (const cloud of acc.originClouds) {
            try {
              const cloudPath = this.workspaceManager.getCloudPath(acc.name, cloud.name);
              if (!fs.existsSync(cloudPath)) continue;
              const entries = fs.readdirSync(cloudPath, { withFileTypes: true });
              for (const entry of entries) {
                // Solo carpetas de dominio (ignorar archivos json, logs, etc.)
                if (!entry.isDirectory()) continue;
                syncTasks.push({
                  accountName: acc.name,
                  cloudName: cloud.name,
                  domainName: entry.name
                });
              }
            } catch (err) {
              log(`Error escaneando disco para ${acc.name}/${cloud.name}: ${err.message}`, 'error');
            }
          }
        }
      }
    } else {
      let dominios = domainsToSync;
      if (!dominios || dominios.length === 0) {
        dominios = await this.workspaceManager.getDominiosProcesados(accountName, cloudName) || [];
      }
      for (const d of dominios) {
        syncTasks.push({
          accountName,
          cloudName,
          domainName: typeof d === 'string' ? d : (d.domain || d.dominio)
        });
      }
    }

    if (syncTasks.length === 0) {
      throw new Error('No hay dominios para sincronizar.');
    }

    log(`Se encontraron ${syncTasks.length} dominios para sincronizar.`, 'info');

    let successCount = 0;
    
    for (const [i, task] of syncTasks.entries()) {
      if (this.abortarSolicitado) {
        log('Sincronización abortada por el usuario.', 'warning');
        break;
      }
      
      const { accountName: currentAccount, cloudName: currentCloud, domainName } = task;
      const baseProgress = Math.round((i / syncTasks.length) * 100);
      
      this.progressEmitter.emitProgress({
        taskId,
        module: 'drive',
        domain: domainName,
        progress: baseProgress,
        message: `Sincronizando ${i + 1}/${syncTasks.length}...`
      });

      try {
        const domainPath = path.join(this.workspaceManager.getCloudPath(currentAccount, currentCloud), domainName);
        if (!fs.existsSync(domainPath)) {
           log(`Omitiendo ${domainName}: carpeta no encontrada en disco local.`, 'warning');
           continue;
        }

        // 1. Resolver estructura de carpetas en Google Drive
        log(`Resolviendo carpetas en Google Drive para ${domainName}...`);
        const targetFolderId = await this.driveService.resolvePath(rootId, [currentAccount, currentCloud, domainName]);

        // 2. Empaquetar Ultra-Lite
        log(`Empaquetando ${domainName} (Ultra-Lite)...`, 'info');
        const tarPath = await this.packer.buildUltraLite(domainPath, emitLog);
        const fileName = path.basename(tarPath);
        
        // 3. Verificar si ya existe en Drive para saltar la subida
        const alreadyExists = await this.driveService.fileExists(fileName, targetFolderId);
        
        if (alreadyExists) {
          log(`El archivo ${fileName} ya existe en Google Drive. Omitiendo subida.`, 'success');
        } else {
          // Subir
          log(`Iniciando subida de ${fileName} a Drive...`);
          await this.driveService.uploadFile(tarPath, targetFolderId, (pct) => {
            this.progressEmitter.emitProgress({
              taskId,
              module: 'drive',
              domain: domainName,
              progress: baseProgress + Math.round(pct * (1 / syncTasks.length)),
              message: `Subiendo a Drive: ${pct}%`
            });
          });
          log(`Subida de ${fileName} a Drive completada con éxito.`, 'success');
        }
        
        // 4. Limpieza total local para liberar espacio
        log(`Limpiando todos los backups y archivos locales de ${domainName}...`);
        if (fs.existsSync(domainPath)) {
          fs.rmSync(domainPath, { recursive: true, force: true });
        }
        successCount++;
        
      } catch (err) {
        log(`Error sincronizando ${domainName}: ${err.message}`, 'error');
      }
    }
    
    this.progressEmitter.emitProgress({
      taskId,
      module: 'drive',
      domain: 'batch',
      progress: 100,
      message: `Sincronización completada. ${successCount}/${syncTasks.length} subidos.`
    });
    
    return { success: true, count: successCount };
  }
}

let instance = null;
function getDriveSyncService() {
  if (!instance) {
    instance = new DriveSyncService();
  }
  return instance;
}

module.exports = {
  getDriveSyncService,
  DriveSyncService
};
