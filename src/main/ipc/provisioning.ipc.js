const { getCloudflareApiService } = require('../../services/cloudflare-api-service');
const { getSshService } = require('../../services/ssh-service');
const { getWorkspaceManager } = require('../../services/workspace-manager');
const { getAppStateManager } = require('../state/AppStateManager');
const { getConfigManager } = require('../../services/config-manager');
const { sanitizeDomainList } = require('./ipc-validators');

function registerProvisioningHandlers(ipcMain, mainWindow, scope) {
  const { isOperationRunning } = scope;

  function sendLog(message, type = 'info') {
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('provisioning:log', { message, type, timestamp: new Date().toISOString() });
    }
  }

  ipcMain.on('plesk:provision-domain', async (event, { domains, pleskIp, accountName, cloudName }) => {
    if (isOperationRunning.value) {
      event.sender.send('provisioning:sync-error', { error: '[COLA] Ya hay una operacion en curso. Espere a que finalice.' });
      return;
    }

    const cleanDomains = sanitizeDomainList(domains, (msg) => console.warn('[Provisioning]', msg));
    if (cleanDomains.length === 0) {
      event.sender.send('provisioning:sync-error', { error: 'La lista de dominios está vacía.' });
      return;
    }

    isOperationRunning.value = true;
    const appState = getAppStateManager();
    appState.resetModuleState('provisioning');

    try {
      const configManager = getConfigManager();
      await configManager.initialize();
      const globalConfig = configManager.getConfig() || {};
      
      const cfToken = globalConfig.cloudflare?.apiToken || globalConfig.cloudflareApiToken;
      if (!cfToken) throw new Error('Credenciales de Cloudflare no configuradas');

      const cloudflareApiService = getCloudflareApiService();
      await cloudflareApiService.initialize(cfToken);

      const selectedServer = globalConfig.destinationServers?.find(s => s.sshCredentials?.host === pleskIp);
      if (!selectedServer || !selectedServer.sshCredentials) {
        throw new Error('Credenciales SSH del servidor Plesk no encontradas en la configuración');
      }

      const sshService = getSshService();
      sendLog('[SSH] Conectando al servidor Plesk...', 'info');
      const client = await sshService.connect(selectedServer.sshCredentials, selectedServer.name);

      const workspaceManager = getWorkspaceManager();
      await workspaceManager.initialize();
      
      const { syncDnsRecords } = require('../../services/dns-service');

      appState.update('provisioning', {
        isRunning: true,
        totalDomains: cleanDomains.length,
        currentProgress: 0,
        results: cleanDomains.map(d => ({ domain: d, status: 'pending', message: 'En cola...' }))
      });
      event.sender.send('provisioning:state-changed', appState.getState('provisioning'));

      for (let i = 0; i < cleanDomains.length; i++) {
        const domain = cleanDomains[i];
        
        if (mainWindow && mainWindow.webContents) {
          mainWindow.webContents.send('sync:domain-start', { phase: 'provisioning', domain });
        }

        appState.update('provisioning', { currentDomain: domain, currentIndex: i });

        const updateDomainState = (status, message) => {
          const st = appState.getState('provisioning');
          const idx = st.results.findIndex(r => r.domain === domain);
          if (idx >= 0) st.results[idx] = { domain, status, message };
          appState.update('provisioning', { results: st.results });
          event.sender.send('provisioning:state-changed', appState.getState('provisioning'));
        };

        try {
          // ── FASE 0: Evaluación de Estado (Workspace) ──
          let shouldSkip = false;
          if (accountName && cloudName) {
            try {
              const dominiosList = await workspaceManager.getDominiosProcesados(accountName, cloudName);
              const found = dominiosList.find(d => {
                const dName = typeof d === 'string' ? d : (d.dominio || d.name || '');
                return dName === domain;
              });
              if (found && typeof found === 'object' && found.provisioningStatus === 'success') {
                shouldSkip = true;
              }
            } catch (e) {}
          }

          if (shouldSkip) {
            sendLog(`[SKIP] Dominio ${domain} ya provisionado exitosamente en corrida anterior.`, 'info');
            updateDomainState('success', 'Saltado (ya provisionado)');
            continue;
          }

          sendLog(`[START] Iniciando Pipeline Transaccional Gray-to-Orange para ${domain}`, 'info');

          // ── FASE 1: Red en Nube Gris (DNS) ──
          sendLog(`[DNS] Resolviendo zona y forzando Nube Gris (proxied: false)...`, 'info');
          const punycodeDomain = require('node:url').domainToASCII(domain);
          const zone = await cloudflareApiService.getOrCreateZone(punycodeDomain);
          if (!zone || !zone.id) throw new Error(zone.error || 'Zona CF no encontrada');

          // syncDnsRecords se encarga de purgar AAAA y CNAMEs conflictivos, 
          // y pasamos "false" explicitamente como argumento de proxied.
          const syncResults = await syncDnsRecords(zone.id, punycodeDomain, pleskIp, false);
          for (const res of syncResults) {
             if (res.action === 'update' || res.action === 'create') {
                sendLog(`[DNS] ${res.name} inyectado hacia ${pleskIp} (Proxy: OFF)`, 'success');
             }
          }

          // Pausa asíncrona de seguridad para propagación DNS (10 segundos)
          sendLog('[DNS] Esperando 10 segundos para propagación perimetral (Nube Gris) antes de emitir SSL...', 'info');
          updateDomainState('processing', 'Esperando propagación DNS (10s)...');
          await new Promise(resolve => setTimeout(resolve, 10000));

          // ── FASE 2: Emisión SSL (Plesk CLI) ──
          updateDomainState('processing', 'Emitiendo certificado SSL...');
          sendLog(`[SSL] Ejecutando Pre-Flight Check en la DB de Plesk...`, 'info');
          if (/[;&|`'"$]/.test(domain)) {
            throw new Error('Formato de dominio inválido (Anti-Inyección)');
          }
          const checkDomainCmd = `plesk db -Ne "SELECT id FROM domains WHERE name='${domain}'"`;
          const checkResult = await sshService.executeCommand(client, checkDomainCmd);
          if (checkResult.code !== 0 || !checkResult.stdout || checkResult.stdout.trim() === '') {
             throw new Error('Dominio no encontrado físicamente en Plesk (Fail-Fast).');
          }

          const email = globalConfig.letsEncryptEmail || 'admin@clinmedia.com';
          const pleskDomain = domain.startsWith('xn--') ? `'${domain}'` : domain;
          const sslitCommand = `plesk ext sslit --certificate -issue -domain ${pleskDomain} -secure-domain -secure-www -secure-webmail -secure-mail -registrationEmail ${email}`;
          
          sendLog(`[SSL] Emitiendo certificado Let's Encrypt HTTP-01...`, 'info');
          const sslResult = await sshService.executeCommand(client, sslitCommand);
          if (sslResult.code !== 0) {
             throw new Error(sslResult.stderr || sslResult.stdout || 'Fallo crítico en emisión SSL');
          }
          sendLog(`[SSL] Certificado validado e instalado correctamente en Plesk.`, 'success');

          // ── FASE 3: Activación de Escudos (Nube Naranja) ──
          sendLog(`[SHIELDS] SSL validado. Elevando escudos (Nube Naranja) para @ y www...`, 'info');
          
          // Re-obtener los registros A creados para actualizarlos a proxied: true
          const records = await cloudflareApiService.getDnsRecords(zone.id, { type: 'A' });
          for (const rec of records) {
             if (rec.name === punycodeDomain || rec.name === `www.${punycodeDomain}`) {
                await cloudflareApiService.updateDnsRecord(zone.id, rec.id, {
                   type: 'A',
                   name: rec.name,
                   content: rec.content,
                   ttl: 1,
                   proxied: true
                });
                sendLog(`[SHIELDS] Escudos activados para ${rec.name}`, 'success');
             }
          }

          // ── FASE 4: Persistencia (Commit) ──
          if (accountName && cloudName) {
            try {
              await workspaceManager.updateDominiosProcesados(accountName, cloudName, [{
                dominio: domain,
                provisioningStatus: 'success',
                errorReason: null,
                lastProvisioningRun: new Date().toISOString()
              }]);
            } catch (err) {
              console.warn('[Commit] Error guardando estado:', err.message);
            }
          }

          updateDomainState('success', 'Pipeline Completado');
          sendLog(`[DONE] ${domain} 100% securizado y bajo proxy.`, 'success');

        } catch (domainError) {
          sendLog(`[ERROR FATAL] ${domainError.message}`, 'error');
          updateDomainState('error', domainError.message);

          if (accountName && cloudName) {
            try {
              await workspaceManager.updateDominiosProcesados(accountName, cloudName, [{
                dominio: domain,
                provisioningStatus: 'failed',
                errorReason: domainError.message,
                lastProvisioningRun: new Date().toISOString()
              }]);
            } catch (err) {}
          }
        } finally {
          appState.update('provisioning', {
            currentProgress: Math.min(Math.round(((i + 1) / cleanDomains.length) * 100), 100)
          });
          event.sender.send('provisioning:state-changed', appState.getState('provisioning'));
        }
      }

    } catch (globalError) {
      event.sender.send('provisioning:sync-error', { error: globalError.message });
    } finally {
      const sshService = getSshService();
      if (typeof client !== 'undefined') {
         await sshService.disconnect(client).catch(() => {});
      }
      isOperationRunning.value = false;
      appState.update('provisioning', { isRunning: false });
      event.sender.send('provisioning:state-changed', appState.getState('provisioning'));
    }
  });
}

module.exports = { registerProvisioningHandlers };
