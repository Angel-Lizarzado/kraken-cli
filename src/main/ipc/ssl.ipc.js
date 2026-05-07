// IPC Handlers: SSL / Plesk Operations
// plesk:install-ssl, get-ssl-status, module:get-status (ssl case)

const { getSshService } = require('../../services/ssh-service');
const { getPleskCliService } = require('../../services/plesk-cli-service');
const { getConfigManager } = require('../../services/config-manager');
const { getAppStateManager } = require('../state/AppStateManager');
const { getStandardEmitter } = require('../../services/standard-emitter');
const { verifyKillSwitch } = require('../utils/security');
const { sanitizeDomainList } = require('./ipc-validators');

const EMIT = getStandardEmitter('ssl');

function registerSslHandlers(ipcMain, mainWindow, scope) {
  const { isOperationRunning } = scope;

  // Get current SSL state
  ipcMain.handle('get-ssl-status', async () => {
    return getAppStateManager().getState('ssl');
  });

  // Plesk Bulk SSL
  // NOTA: Usamos ipcMain.on (NO handle) porque esta operación emite streaming
  // de eventos (sync:domain-start, sync:domain-progress, ssl:log, state:update).
  // ipcMain.handle + streaming interno causa deadlock en Electron.
  ipcMain.on('plesk:install-ssl', async (event, { accountName, serverName, domains, options }) => {
    const email = (options && options.email) || 'clinmediadev@gmail.com';

    if (isOperationRunning.value) {
      event.sender.send('ssl:sync-error', { error: '[COLA] Ya hay una operacion en curso. Espere a que finalice.' });
      return;
    }

    // ⚠️ SEGURIDAD CRÍTICA: el domain se interpola directamente en un comando Plesk CLI
    // ejecutado por SSH. Un valor no sanitizado puede causar RCE en el servidor de destino.
    // Sanitizar ANTES de marcar isOperationRunning para no bloquear el semáforo ante input inválido.
    const cleanDomains = sanitizeDomainList(domains, (msg) => {
      console.warn('[SSL:plesk:install-ssl]', msg);
    });
    if (cleanDomains.length === 0) {
      event.sender.send('ssl:sync-error', {
        error: 'La lista de dominios está vacía o contiene entradas inválidas. Revise el formato de los dominios.',
      });
      return;
    }

    isOperationRunning.value = true;

    let client = null;
    try {
      await verifyKillSwitch();

      const sshService = getSshService();
      const pleskCliService = getPleskCliService();
      const configManager = getConfigManager();
      await configManager.initialize();

      const config = configManager.getConfig();
      const serverConfig = config.destinationServers?.find(s => s.name === serverName);
      if (!serverConfig) throw new Error('Server "' + serverName + '" not found');

      const appState = getAppStateManager();

      // RESET antes de correr — evita acumulación de resultados/logs de corridas anteriores
      appState.resetModuleState('ssl');

      // v1.8.3: Cargar dominios ya exitosos desde el JSON de estado (lastSslSync)
      const dominiosExitosos = new Set();
      try {
        const { getWorkspaceManager } = require('../../services/workspace-manager');
        const ws = getWorkspaceManager();
        let cloudName = '';
        const cfg = configManager.getConfig();
        const acc = cfg.accounts?.find(a => a.name === accountName);
        if (acc && acc.originClouds?.length > 0) {
          cloudName = acc.originClouds[0].name;
        }
        if (accountName && cloudName) {
          const procesados = await ws.getDominiosProcesados(accountName, cloudName);
          for (const entry of procesados) {
            const d = entry.dominio || entry;
            if (entry.lastSslSync) {
              dominiosExitosos.add(d);
            }
          }
        }
      } catch {}

      // v1.8.3: Filtrar sobre cleanDomains (ya sanitizados), no sobre el array original.
      const domainsToProcess = cleanDomains.filter(d => !dominiosExitosos.has(d));
      const skippedCount = cleanDomains.length - domainsToProcess.length;

      appState.update('ssl', {
        isRunning: true,
        currentDomain: '',
        currentProgress: 0,
        currentMessage: 'Preparando solicitud SSL...',
        totalDomains: domainsToProcess.length,
        currentIndex: 0,
        domainsQueue: domainsToProcess,
      });

      const skipMsg = skippedCount > 0 ? ` (${skippedCount} omitidos por SSL previo)` : '';
      sendSslLog(`Procesando ${domainsToProcess.length} dominios${skipMsg}...`, 'info');

      // Inyectar pending list en AppStateManager
      appState.update('ssl', {
        results: domainsToProcess.map(d => ({ domain: d, status: 'pending', message: 'En cola...' })),
      });

      event.sender.send('ssl:state-changed', appState.getState('ssl'));
      await new Promise(r => setTimeout(r, 150));

      client = await sshService.connect(serverConfig.sshCredentials, 'bulk-ssl-' + Date.now());

      // Secuencial estricto: un dominio a la vez
      for (let i = 0; i < domainsToProcess.length; i++) {
        const domain = domainsToProcess[i];

        if (mainWindow && mainWindow.webContents) {
          mainWindow.webContents.send('sync:domain-start', { phase: 'ssl', domain });
        }

        appState.update('ssl', {
          currentDomain: domain,
          currentIndex: i,
          currentMessage: '[SSL] Solicitando: ' + domain,
        });

        try {
          // v1.8.3: Si el dominio es IDN (xn--), usar el dominio original (con ñ/tildes)
          // entre comillas simples para que Plesk lo interprete correctamente.
          const pleskDomain = domain.startsWith('xn--') ? `'${domain}'` : domain;
          const sslitCommand = 'plesk ext sslit --certificate -issue -domain ' + pleskDomain +
            ' -secure-domain -secure-www -secure-webmail -secure-mail -registrationEmail ' + email;

          // Verificar registros AAAA (IPv6) que podrían causar fallo en Plesk
          try {
            const { getCloudflareApiService } = require('../../services/cloudflare-api-service');
            const cfService = getCloudflareApiService();
            await cfService.initialize();
            const zone = await cfService.getOrCreateZone(domain);
            if (zone && zone.id) {
              const records = await cfService.getDnsRecords(zone.id);
              const aaaaRecords = records.filter((r) => r.type === 'AAAA');
              if (aaaaRecords.length > 0) {
                sendSslLog('[AVISO] Detectado(s) ' + aaaaRecords.length + ' registro(s) AAAA para ' + domain +
                  '. Plesk podría fallar con IPv6. Intentando omitir...', 'warning');
              }
            }
          } catch (cfErr) {
            sendSslLog('[AVISO] No se pudo verificar registros AAAA para ' + domain + ': ' + (cfErr.message || 'error'), 'warning');
          }

          const sslitResult = await sshService.executeCommand(client, sslitCommand);

          if (sslitResult.code === 0) {
            sendSslLog('[OK] ' + domain + ': Certificado SSL emitido y asegurado (dominio, www, webmail, mail)', 'success');

            const currentState = appState.getState('ssl');
            const existingIdx = currentState.results.findIndex(r => r.domain === domain);
            const entry = { domain, status: 'success', message: 'SSL instalado correctamente' };
            if (existingIdx >= 0) {
              currentState.results[existingIdx] = entry;
            } else {
              currentState.results.push(entry);
            }
            appState.update('ssl', { results: currentState.results });
            event.sender.send('domain-process-result', { module: 'SSL', domain, status: 'success', message: 'SSL instalado correctamente' });

            // Persist timestamp
            if (accountName) {
              let cloudName = '';
              try {
                const cfg = configManager.getConfig();
                const acc = cfg.accounts?.find(a => a.name === accountName);
                if (acc && acc.originClouds?.length > 0) {
                  cloudName = acc.originClouds[0].name;
                }
              } catch {}
              if (cloudName) {
                const { getWorkspaceManager } = require('../../services/workspace-manager');
                const ws = getWorkspaceManager();
                await ws.setSslSyncTimestamp(accountName, cloudName, domain).catch(err => {
                  console.warn('[SSL] Failed to persist timestamp for ' + domain + ':', err.message);
                });
              }
            }
          } else {
            const errMsg = sslitResult.stderr || sslitResult.stdout || 'Error desconocido';
            sendSslLog('[ERROR] ' + domain + ': ' + errMsg, 'error');

            const currentState = appState.getState('ssl');
            const existingIdx = currentState.results.findIndex(r => r.domain === domain);
            const entry = { domain, status: 'error', message: errMsg };
            if (existingIdx >= 0) {
              currentState.results[existingIdx] = entry;
            } else {
              currentState.results.push(entry);
            }
            appState.update('ssl', { results: currentState.results });
            event.sender.send('domain-process-result', { module: 'SSL', domain, status: 'error', message: errMsg });
          }
        } catch (error) {
          console.error('[SSL] Fallo ' + domain + ':', error.message);
          sendSslLog('[ERROR] ' + domain + ': ' + error.message, 'error');

          const currentState = appState.getState('ssl');
          const existingIdx = currentState.results.findIndex(r => r.domain === domain);
          const entry = { domain, status: 'error', message: error.message };
          if (existingIdx >= 0) {
            currentState.results[existingIdx] = entry;
          } else {
            currentState.results.push(entry);
          }
          appState.update('ssl', { results: currentState.results });
          event.sender.send('domain-process-result', { module: 'SSL', domain, status: 'error', message: error.message });
        }

        const sslState = appState.getState('ssl');
        const lastSslEntry = sslState.results[sslState.results.length - 1];
        if (mainWindow && mainWindow.webContents) {
          mainWindow.webContents.send('sync:domain-progress', {
            phase: 'ssl',
            domain: lastSslEntry.domain,
            status: lastSslEntry.status,
            message: lastSslEntry.message,
          });
        }

        appState.update('ssl', {
          currentProgress: Math.min(Math.round(((i + 1) / domainsToProcess.length) * 100), 100),
        });
        event.sender.send('ssl:state-changed', appState.getState('ssl'));

        // Check cancellation
        if (!appState.getState('ssl').isRunning && isOperationRunning.value === false) {
          sendSslLog('[CANCELADO] Instalación SSL detenida por el usuario', 'warning');
          break;
        }
      }

      appState.update('ssl', {
        isRunning: false,
        currentProgress: 100,
        currentMessage: 'Solicitud SSL masiva finalizada',
      });
      sendSslLog('Solicitud SSL masiva finalizada', 'success');
      event.sender.send('ssl:state-changed', appState.getState('ssl'));
      event.sender.send('ssl:sync-completed', { success: true, finished: true });
    } catch (error) {
      console.error('[ERROR] Solicitud SSL fallo:', error.message);
      EMIT.error(`Solicitud SSL falló: ${error.message}`);
      sendSslLog('[ERROR] ' + error.message, 'error');
      getAppStateManager().update('ssl', { isRunning: false });
      event.sender.send('ssl:state-changed', getAppStateManager().getState('ssl'));
      event.sender.send('ssl:sync-completed', { success: false, error: error.message });
    } finally {
      isOperationRunning.value = false;
      if (client) {
        try {
          const sshService = getSshService();
          await sshService.disconnect(client);
        } catch {}
      }
    }
  });

  // SSL log helper
  function sendSslLog(message, type) {
    if (type === undefined) type = 'info';
    const appState = getAppStateManager();
    if (!message) return;
    const state = appState.getState('ssl');
    const logs = state.recentLogs || [];
    logs.push({ message: message, timestamp: Date.now() });
    if (logs.length > 50) logs.shift();
    appState.update('ssl', { recentLogs: logs });

    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('ssl:log', { message: message, type: type, timestamp: Date.now() });
    }
  }
}

module.exports = { registerSslHandlers };
