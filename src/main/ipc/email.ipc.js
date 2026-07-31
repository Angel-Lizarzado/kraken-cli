const { getConfigManager } = require('../../services/config-manager');
const { HostingerMailApi } = require('../../services/hostinger-mail-api');
const { ImapDownloader } = require('../../services/imap-downloader');
const path = require('path');
const fsp = require('fs').promises;
const fs = require('fs');

/**
 * Registra los handlers IPC para el módulo de email.
 *
 * Canales:
 *   email:get-config          → Devuelve el token guardado (obfuscado)
 *   email:set-config          → Guarda el API token (encriptado)
 *   email:download-domain     → Descarga emails de un dominio específico
 */
const { getWorkspaceManager } = require('../../services/workspace-manager');
const { getAppStateManager } = require('../state/AppStateManager');

/**
 * Registra los handlers IPC para el módulo de email.
 *
 * Canales:
 *   email:get-config          → Devuelve el token guardado (obfuscado)
 *   email:set-config          → Guarda el API token (encriptado)
 *   email:download-domain     → Descarga emails de un dominio específico
 *   email:download-batch      → Descarga emails de un lote de dominios
 */
function registerEmailHandlers(ipcMain, mainWindow) {
  const configManager = getConfigManager();

  // ── GET config ──────────────────────────────────────────────────────────────
  ipcMain.handle('email:get-config', async () => {
    try {
      const cfg = configManager.getConfig();
      const raw = cfg?.hostingerMail?.apiToken || '';
      const obfuscated = raw.length > 8
        ? raw.slice(0, 4) + '****' + raw.slice(-4)
        : raw.length > 0 ? '****' : '';
      return { success: true, apiToken: raw, obfuscated };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ── SET config ──────────────────────────────────────────────────────────────
  ipcMain.handle('email:set-config', async (_event, { apiToken }) => {
    try {
      const cfg = configManager.getConfig();
      if (!cfg.hostingerMail) cfg.hostingerMail = {};
      cfg.hostingerMail.apiToken = (apiToken || '').trim();
      await configManager.saveConfig();
      mainWindow.webContents.send('config:updated', { success: true, config: configManager.getConfig() });
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ── Download emails for a specific domain ───────────────────────────────────
  ipcMain.handle('email:download-domain', async (_event, { domain, destPath, accountName, cloudName }) => {
    try {
      const cfg = configManager.getConfig();
      const apiToken = cfg?.hostingerMail?.apiToken;
      if (!apiToken) {
        return { success: false, error: 'No hay API token de Hostinger configurado. Ve a Configuración para ingresarlo.' };
      }
      if (!domain) {
        return { success: false, error: 'Se requiere el dominio.' };
      }

      let finalDestPath = destPath;
      if (!finalDestPath && accountName && cloudName) {
        const workspaceManager = getWorkspaceManager();
        finalDestPath = await workspaceManager.createDomainFolder(accountName, cloudName, domain);
      }

      if (!finalDestPath) {
        return { success: false, error: 'Se requiere la ruta de destino o la cuenta/cloud.' };
      }

      const emit = (msg, type = 'info') => {
        mainWindow.webContents.send('extraction:log', { domain, message: msg, type });
        mainWindow.webContents.send('email:log', { domain, msg, type });
      };

      const result = await downloadEmailsForDomain(domain, finalDestPath, apiToken, emit);
      return result;
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ── Download emails for a batch of domains ──────────────────────────────────
  ipcMain.handle('email:download-batch', async (_event, { accountName, cloudName, domains }) => {
    try {
      const cfg = configManager.getConfig();
      const apiToken = cfg?.hostingerMail?.apiToken;
      if (!apiToken) {
        return { success: false, error: 'No hay API token de Hostinger configurado. Ve a Configuración para ingresarlo.' };
      }
      if (!domains || !Array.isArray(domains) || domains.length === 0) {
        return { success: false, error: 'No hay dominios seleccionados.' };
      }

      const workspaceManager = getWorkspaceManager();
      const mailApi = new HostingerMailApi(apiToken);
      const { getAppStateManager } = require('../state/AppStateManager');
      const { getSshService } = require('../../services/ssh-service');
      const appState = getAppStateManager();
      const fs = require('fs');

      let successCount = 0;
      let errorsCount = 0;
      const results = [];

      const initialResults = domains.map(d => ({ domain: d, status: 'pending', message: 'En cola [Solo Correos]...' }));
      appState.update('extraction', {
        isRunning: true,
        currentDomain: domains[0],
        currentIndex: 0,
        totalDomains: domains.length,
        currentProgress: 0,
        currentMessage: `[CORREOS] Descargando correos para ${domains.length} dominios...`,
        results: initialResults,
      });
      mainWindow.webContents.send('extraction:state-changed', appState.getState('extraction'));

      const mainEmit = (msg, type = 'info') => {
        mainWindow.webContents.send('extraction:log', { message: msg, type });
      };



      mainEmit('[EMAIL] Consultando lista global de órdenes de correo en Hostinger API...');
      let orders = [];
      try {
        orders = await mailApi.listOrders({ per_page: 1000 });
        mainEmit(`[EMAIL] ${orders.length} paquete(s) de correo recuperado(s) de Hostinger API.`);
      } catch (err) {
        const is403 = err.message.includes('403');
        const reason = is403 
          ? 'El API Token de Hostinger no tiene permisos de Email API (HTTP 403) o expiro'
          : err.message;
        mainEmit(`[EMAIL][WARN] No se pudo consultar API de Hostinger: ${reason}`, 'warning');
      }

      // Mapa para búsqueda instantánea en memoria
      // NOTA: La API devuelve domain como OBJETO { id, name }, no como string
      const orderMap = new Map();
      for (const order of orders) {
        const orderId = order.id || order.order_id || order.orderId;
        // domain puede ser un objeto { id, name } o un string
        const domainName = typeof order.domain === 'object' ? order.domain?.name : order.domain;
        const candidates = [domainName, order.domain_name, order.domainName, order.name, order.title].filter(Boolean);
        for (const c of candidates) {
          if (typeof c === 'string') orderMap.set(c.toLowerCase().replace(/^www\./, '').trim(), orderId);
        }
        if (Array.isArray(order.domains)) {
          for (const d of order.domains) {
            const domStr = typeof d === 'string' ? d : (d.domain?.name || d.domain || d.domain_name || d.name || '');
            if (domStr) orderMap.set(domStr.toLowerCase().replace(/^www\./, '').trim(), orderId);
          }
        }
      }

      for (const [i, domain] of domains.entries()) {
          const normDom = domain.toLowerCase().replace(/^www\./, '').trim();
          const safeDomain = domain.replace(/[^a-zA-Z0-9.-]/g, '_');
          const prebuiltOrderId = orderMap.get(normDom) || null;

          const emit = (msg, type = 'info') => {
            mainWindow.webContents.send('extraction:log', { domain, message: msg, type });
            mainWindow.webContents.send('email:log', { domain, msg, type });
          };

          const currentList = appState.getState('extraction').results || [];
          const procResults = currentList.map(r => r.domain === domain ? { ...r, status: 'processing', message: 'Procesando correos...' } : r);

          appState.update('extraction', {
            isRunning: true,
            currentDomain: domain,
            currentIndex: i,
            totalDomains: domains.length,
            currentProgress: Math.round(((i + 1) / domains.length) * 100),
            currentMessage: `[CORREOS] (${i + 1}/${domains.length}) Procesando ${domain}...`,
            results: procResults,
          });

          mainWindow.webContents.send('extraction:state-changed', appState.getState('extraction'));
          mainWindow.webContents.send('domain-process-result', {
            module: 'EXTRACT',
            domain,
            status: 'processing',
            message: `Procesando correos...`,
          });

          await new Promise(resolve => setTimeout(resolve, 30));

          const finalDomainPath = await workspaceManager.createDomainFolder(accountName, cloudName, domain);

          // ── Resume: verificar si la descarga previa fue completa ──
          const existingTar = path.join(finalDomainPath, 'emails.tar.gz');
          const metaPath = path.join(finalDomainPath, 'emails.meta.json');
          if (fs.existsSync(existingTar)) {
            let isComplete = false;
            let metaInfo = '';
            try {
              const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
              if (meta.complete === true) {
                isComplete = true;
                metaInfo = `${meta.downloaded}/${meta.expected} msgs, ${meta.sizeMB} MB`;
              } else {
                metaInfo = `incompleta: ${meta.downloaded}/${meta.expected} msgs`;
              }
            } catch (_) {
              // Sin meta.json → descarga antigua sin tracking → asumir completa para no repetir
              isComplete = true;
              const stats = fs.statSync(existingTar);
              metaInfo = `${(stats.size / 1024 / 1024).toFixed(2)} MB (sin meta)`;
            }

            if (isComplete) {
              const skipMsg = `✅ Correos ya descargados (${metaInfo}) — omitido`;
              emit(`[EMAIL] ${domain}: ${skipMsg}`);
              successCount++;
              results.push({ domain, success: true, message: skipMsg });
              const doneList = appState.getState('extraction').results || [];
              const updatedDoneList = doneList.map(r => r.domain === domain ? { domain, status: 'success', message: skipMsg } : r);
              appState.update('extraction', { results: updatedDoneList });
              mainWindow.webContents.send('domain-process-result', { module: 'EXTRACT', domain, status: 'success', message: skipMsg });
              continue;
            } else {
              // Descarga incompleta → eliminar el tar anterior y reintentar
              emit(`[EMAIL] ${domain}: descarga previa incompleta (${metaInfo}) — reintentando...`, 'warning');
              try { fs.rmSync(existingTar); } catch (_) {}
              try { fs.rmSync(metaPath); } catch (_) {}
            }
          }

          // ── Descargar correos vía Hostinger Email API + IMAP ──
          try {
            const result = await downloadEmailsForDomain(domain, finalDomainPath, apiToken, emit, prebuiltOrderId, mailApi);
            const isOk = result.success;
            const msg = isOk 
              ? (result.skipped ? `Sin correos (${result.reason || 'Sin buzones'})` : `✅ ${result.totalMessages} correos (${result.sizeMB || 0} MB)`)
              : (result.error || 'Error en descarga');

            if (isOk) successCount++; else errorsCount++;
            results.push({ domain, success: isOk, message: msg });

            const doneList = appState.getState('extraction').results || [];
            const updatedDoneList = doneList.map(r => r.domain === domain ? { domain, status: isOk ? 'success' : 'error', message: msg } : r);

            appState.update('extraction', { results: updatedDoneList });
            mainWindow.webContents.send('domain-process-result', {
              module: 'EXTRACT',
              domain,
              status: isOk ? 'success' : 'error',
              message: msg,
            });
          } catch (err) {
            errorsCount++;
            const errMsg = err.message || 'Error en descarga';
            emit(`[EMAIL][ERROR] ${domain}: ${errMsg}`, 'error');
            results.push({ domain, success: false, error: errMsg });

            const doneList = appState.getState('extraction').results || [];
            const updatedDoneList = doneList.map(r => r.domain === domain ? { domain, status: 'error', message: errMsg } : r);

            appState.update('extraction', { results: updatedDoneList });
            mainWindow.webContents.send('domain-process-result', {
              module: 'EXTRACT',
              domain,
              status: 'error',
              message: errMsg,
            });
          }
        }

      appState.update('extraction', {
        isRunning: false,
        currentDomain: '',
        currentIndex: domains.length,
        currentProgress: 100,
        currentMessage: `Descarga de correos finalizada: ${successCount} ok, ${errorsCount} errores`,
      });

      mainWindow.webContents.send('extraction:state-changed', appState.getState('extraction'));

      return { success: true, total: domains.length, successCount, errors: errorsCount, results };
    } catch (err) {
      appState.update('extraction', {
        isRunning: false,
        currentDomain: '',
        currentMessage: `Error en descarga de correos: ${err.message}`,
      });
      mainWindow.webContents.send('extraction:state-changed', appState.getState('extraction'));
      return { success: false, error: err.message };
    } finally {
      appState.update('extraction', { isRunning: false, currentProgress: 100 });
      mainWindow.webContents.send('extraction:state-changed', appState.getState('extraction'));
    }
  });

  // ── Restore emails for a batch of domains to Plesk ───────────────────────────
  ipcMain.handle('email:restore-batch', async (_event, { serverName, accountName, cloudName, domains }) => {
    const { getSshService } = require('../../services/ssh-service');
    const { restaurarEmailsPlesk } = require('../../services/mail-service');
    const appState = getAppStateManager();

    if (!serverName) return { success: false, error: 'Se requiere seleccionar el servidor Plesk de destino.' };
    if (!domains || !Array.isArray(domains) || domains.length === 0) {
      return { success: false, error: 'No hay dominios seleccionados.' };
    }

    await configManager.initialize();
    const serverConfig = configManager.getDestinationServer(serverName);
    if (!serverConfig) return { success: false, error: `El servidor ${serverName} no existe en la configuración.` };

    const sshService = getSshService();
    let sshClient = null;

    mainWindow.webContents.send('deployment:log', {
      message: `[EMAIL-RESTORE] Conectando por SSH a servidor Plesk "${serverName}"...`,
      type: 'info',
    });

    try {
      sshClient = await sshService.connect(serverConfig.sshCredentials, `email-restore-${Date.now()}`);
      mainWindow.webContents.send('deployment:log', {
        message: `[EMAIL-RESTORE] Conexión SSH establecida con ${serverName}.`,
        type: 'success',
      });
    } catch (connErr) {
      const errMsg = `Fallo de conexión SSH con ${serverName}: ${connErr.message}`;
      mainWindow.webContents.send('deployment:log', { message: `[EMAIL-RESTORE] ${errMsg}`, type: 'error' });
      for (const domain of domains) {
        mainWindow.webContents.send('migrate-domain-error', { domain, message: errMsg });
        mainWindow.webContents.send('domain-process-result', { module: 'DEPLOY', domain, status: 'error', message: errMsg });
      }
      return { success: false, error: errMsg };
    }

    try {
      const workspaceManager = getWorkspaceManager();
      let successCount = 0;
      let errorsCount = 0;
      const results = [];

      // Inicializar estado de despliegue en AppStateManager con todos los dominios en 'pending'
      const initialResults = domains.map(d => ({ domain: d, status: 'pending', message: 'En cola' }));
      appState.update('deployment', {
        isRunning: true,
        totalDomains: domains.length,
        currentIndex: 0,
        currentProgress: 0,
        currentDomain: domains[0],
        statusMessage: `Iniciando restauración de correos (${domains.length} dominio(s))...`,
        results: initialResults,
      });
      mainWindow.webContents.send('deployment:state-changed', appState.getState('deployment'));

      for (const [i, domain] of domains.entries()) {
        const emit = (msg, type = 'info') => {
          mainWindow.webContents.send('deployment:log', { domain, message: msg, type });
          mainWindow.webContents.send('email:log', { domain, msg, type });
        };

        // Actualizar el dominio activo a 'running' en AppStateManager
        const currentSt = appState.getState('deployment') || {};
        const runResults = Array.isArray(currentSt.results) ? [...currentSt.results] : initialResults;
        const runIdx = runResults.findIndex(r => r.domain === domain);
        if (runIdx >= 0) {
          runResults[runIdx] = { domain, status: 'running', message: 'Procesando...' };
        }

        appState.update('deployment', {
          currentDomain: domain,
          currentIndex: i,
          currentProgress: Math.round((i / domains.length) * 100),
          statusMessage: `Restaurando correos (${i + 1}/${domains.length}): ${domain}...`,
          results: runResults,
        });

        mainWindow.webContents.send('deployment:state-changed', appState.getState('deployment'));
        mainWindow.webContents.send('migrate-domain-start', { domain });
        mainWindow.webContents.send('domain-process-result', {
          module: 'DEPLOY',
          domain,
          status: 'processing',
          message: 'Restaurando correos en Plesk...',
        });

        try {
          const domainPath = workspaceManager.getDomainPath(accountName, cloudName, domain);
          emit(`[EMAIL-RESTORE] (${i + 1}/${domains.length}) Procesando restauración para ${domain}...`);

          const executeFn = async (cmd) => await sshService.executeCommand(sshClient, cmd);
          const sftpUploadFn = async (localFile, remoteFile) => await sshService.uploadFile(sshClient, localFile, remoteFile);

          const result = await restaurarEmailsPlesk({
            domain,
            domainPath,
            executeCommandFn: executeFn,
            sftpUploadFn,
            emitLog: emit,
          });

          const stAfter = appState.getState('deployment') || {};
          const resResults = Array.isArray(stAfter.results) ? [...stAfter.results] : [];
          const resIdx = resResults.findIndex(r => r.domain === domain);

          if (result.exito) {
            successCount++;
            const isAlreadyRestored = result.mensaje && result.mensaje.includes('ya restaurados');
            const msg = isAlreadyRestored
              ? `✅ ${result.mensaje}`
              : (result.skipped ? 'Omitido (sin emails.tar.gz)' : `✅ ${result.mensaje}`);
            const resStatus = (isAlreadyRestored || !result.skipped) ? 'success' : 'skipped';
            results.push({ domain, success: true, message: msg });

            if (resIdx >= 0) resResults[resIdx] = { domain, status: resStatus, message: msg };
            appState.update('deployment', {
              currentProgress: Math.round(((i + 1) / domains.length) * 100),
              results: resResults,
            });
            mainWindow.webContents.send('deployment:state-changed', appState.getState('deployment'));
            mainWindow.webContents.send('migrate-domain-success', { domain, message: msg });
            mainWindow.webContents.send('domain-process-result', { module: 'DEPLOY', domain, status: 'success', message: msg });
          } else {
            errorsCount++;
            results.push({ domain, success: false, error: result.mensaje });

            if (resIdx >= 0) resResults[resIdx] = { domain, status: 'error', message: result.mensaje };
            appState.update('deployment', {
              currentProgress: Math.round(((i + 1) / domains.length) * 100),
              results: resResults,
            });
            mainWindow.webContents.send('deployment:state-changed', appState.getState('deployment'));
            mainWindow.webContents.send('migrate-domain-error', { domain, message: result.mensaje });
            mainWindow.webContents.send('domain-process-result', { module: 'DEPLOY', domain, status: 'error', message: result.mensaje });
          }
        } catch (err) {
          errorsCount++;
          const errMsg = err.message || 'Error desconocido';
          emit(`[EMAIL-RESTORE][ERROR] ${domain}: ${errMsg}`, 'error');
          results.push({ domain, success: false, error: errMsg });

          const stErr = appState.getState('deployment') || {};
          const errResults = Array.isArray(stErr.results) ? [...stErr.results] : [];
          const errIdx = errResults.findIndex(r => r.domain === domain);
          if (errIdx >= 0) errResults[errIdx] = { domain, status: 'error', message: errMsg };
          appState.update('deployment', {
            currentProgress: Math.round(((i + 1) / domains.length) * 100),
            results: errResults,
          });
          mainWindow.webContents.send('deployment:state-changed', appState.getState('deployment'));
          mainWindow.webContents.send('migrate-domain-error', { domain, message: errMsg });
          mainWindow.webContents.send('domain-process-result', { module: 'DEPLOY', domain, status: 'error', message: errMsg });
        }
      }

      return { success: true, total: domains.length, successCount, errors: errorsCount, results };
    } catch (err) {
      return { success: false, error: err.message };
    } finally {
      appState.update('deployment', { isRunning: false, currentProgress: 100 });
      mainWindow.webContents.send('deployment:state-changed', appState.getState('deployment'));
      if (sshClient) {
        try { sshService.disconnect(sshClient); } catch (_) {}
      }
    }
  });
}

/**
 * Descarga todos los emails de un dominio y los guarda como emails.tar.gz en destPath.
 * Esta función es exportada para ser usada también desde extraction-service.
 *
 * @param {string} domain
 * @param {string} destPath - Carpeta destino (donde ya vive el .tar.gz de WordPress)
 * @param {string} apiToken - hPanel API token
 * @param {function} emit - logger callback
 * @returns {Promise<{ success: boolean, skipped?: boolean, emailsTarPath?: string, error?: string }>}
 */
async function downloadEmailsForDomain(domain, destPath, apiToken, emit = () => {}, prebuiltOrderId = null, existingMailApi = null) {
  const mailApi = existingMailApi || new HostingerMailApi(apiToken);
  const downloader = new ImapDownloader();

  let orderId = prebuiltOrderId;
  if (!orderId) {
    emit(`[EMAIL] Consultando hPanel API para ${domain}...`);
    try {
      orderId = await mailApi.findOrderIdForDomain(domain);
    } catch (err) {
      emit(`[EMAIL][ERROR] Error al consultar API de Hostinger: ${err.message}`, 'error');
      throw new Error(`API Hostinger: ${err.message}`);
    }
  }

  if (!orderId) {
    emit(`[EMAIL] No se encontró paquete de email activo en Hostinger para ${domain}.`, 'warning');
    return { success: true, skipped: true, reason: 'Sin plan de email en Hostinger' };
  }

  emit(`[EMAIL] Order ID ${orderId} encontrado. Obteniendo buzones...`);
  let mailboxes;
  try {
    mailboxes = await mailApi.listMailboxes(orderId);
  } catch (err) {
    emit(`[EMAIL][ERROR] Error obteniendo buzones (order ${orderId}): ${err.message}`, 'error');
    throw new Error(`Error buzones: ${err.message}`);
  }

  if (!mailboxes || mailboxes.length === 0) {
    emit(`[EMAIL] 0 buzones creados en Hostinger para ${domain}.`, 'info');
    return { success: true, skipped: true, reason: 'Sin buzones de correo' };
  }

  const formattedList = mailboxes.map(m => m.address || m.email || m.username).filter(Boolean);
  emit(`[EMAIL] ${mailboxes.length} buzón(es) detectado(s): ${formattedList.join(', ')}`);

  const tempEmailsPath = path.join(destPath, '_email_temp');
  await fsp.mkdir(tempEmailsPath, { recursive: true });

  let totalMessages = 0;

  for (const mailbox of mailboxes) {
    const address = mailbox.address || mailbox.email || mailbox.username;
    const mbId = mailbox.id || mailbox.mailbox_id;
    const tempPassword = mailApi.generateTempPassword();

    try {
      emit(`[EMAIL] Generando clave temporal para ${address}...`);
      await mailApi.resetMailboxPassword(mbId, tempPassword);

      const accountDest = path.join(tempEmailsPath, address);
      emit(`[EMAIL] Descargando correos IMAP de ${address}...`);

      const { totalMessages: count } = await downloader.downloadAll(
        { user: address, password: tempPassword },
        accountDest,
        emit
      );
      totalMessages += count;

      emit(`[EMAIL] ${address}: ${count} mensajes descargados.`, 'success');
    } catch (mbErr) {
      emit(`[EMAIL][WARN] Fallo en buzón ${address}: ${mbErr.message}`, 'warning');
    }
  }

  const emailsTarPath = path.join(destPath, 'emails.tar.gz');

  if (totalMessages === 0) {
    emit(`[EMAIL] Todos los buzones de ${domain} estaban vacíos.`, 'info');
    try { fs.rmSync(tempEmailsPath, { recursive: true, force: true }); } catch (_) {}
    return { success: true, skipped: true, reason: 'Buzones vacíos (0 mensajes)' };
  }

  // Contar cuántos .eml se descargaron realmente (para detectar lotes fallidos)
  // Estructura: tempEmailsPath / address / INBOX / 1.eml  (3 niveles)
  let expectedTotal = 0;
  let downloadedTotal = 0;
  try {
    const countEmls = async (dir, depth = 0) => {
      const entries = await fsp.readdir(dir);
      let count = 0;
      for (const entry of entries) {
        const entryPath = path.join(dir, entry);
        const stat = await fsp.stat(entryPath);
        if (stat.isDirectory() && depth < 3) {
          count += await countEmls(entryPath, depth + 1);
        } else if (entry.endsWith('.eml')) {
          count++;
        }
      }
      return count;
    };
    downloadedTotal = await countEmls(tempEmailsPath);
  } catch (_) {}
  expectedTotal = totalMessages; // totalMessages = suma de counts por folder reportados por IMAP

  emit(`[EMAIL] Empaquetando ${downloadedTotal} correos en emails.tar.gz...`);
  const size = await downloader.compress(tempEmailsPath, emailsTarPath);
  const sizeMB = (size / 1024 / 1024).toFixed(2);

  // Escribir meta de completitud
  const isComplete = downloadedTotal >= expectedTotal;
  const metaPath = path.join(destPath, 'emails.meta.json');
  try {
    await fsp.writeFile(metaPath, JSON.stringify({
      complete: isComplete,
      expected: expectedTotal,
      downloaded: downloadedTotal,
      sizeMB,
      timestamp: new Date().toISOString(),
    }, null, 2));
  } catch (_) {}

  if (!isComplete) {
    emit(`[EMAIL] ⚠️ emails.tar.gz parcial (${downloadedTotal}/${expectedTotal} msgs, ${sizeMB} MB) — se reintentará en la próxima ejecución`, 'warning');
  } else {
    emit(`[EMAIL] ✅ emails.tar.gz listo (${sizeMB} MB, ${downloadedTotal} msgs)`, 'success');
  }

  try { fs.rmSync(tempEmailsPath, { recursive: true, force: true }); } catch (_) {}

  return { success: true, emailsTarPath, totalMessages: downloadedTotal, sizeMB };
}

module.exports = { registerEmailHandlers, downloadEmailsForDomain };
