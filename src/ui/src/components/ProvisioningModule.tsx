import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useIpc } from '../hooks/useIpc';
import { useModuleState } from '../contexts/AppStateContext';

interface SyncResult {
  domain: string;
  status: 'pending' | 'processing' | 'success' | 'error';
  message: string;
}

interface ProvisioningModuleProps {
  onLog?: (message: string, type: 'info' | 'warning' | 'error' | 'success', moduleId?: string, options?: { replaceLast?: boolean }) => void;
  logs?: { message: string; type: string; timestamp?: number; source?: string }[];
}

const ProvisioningModule: React.FC<ProvisioningModuleProps> = ({ onLog }) => {
  const { config, getDominiosProcesados } = useIpc();

  // Estados locales
  const [selectedAccount, setSelectedAccount] = useState<string>('');
  const [selectedCloud, setSelectedCloud] = useState<string>('');
  const [pleskServerName, setPleskServerName] = useState<string>('');
  const [domainsText, setDomainsText] = useState<string>('');
  const [jsonMissing, setJsonMissing] = useState<boolean>(false);
  const [isRunning, setIsRunning] = useState<boolean>(false);
  
  const [results, setResults] = useState<SyncResult[]>([]);
  const resultsRef = useRef(results);
  resultsRef.current = results;

  const [statusMessage, setStatusMessage] = useState<string>('');

  // 1. Cargar dominios del JSON cuando cambia el cloud
  useEffect(() => {
    if (!selectedAccount || !selectedCloud) {
      if (domainsText.length === 0) {
        setJsonMissing(false);
      }
      setResults([]);
      return;
    }

    let cancelled = false;
    const loadDominios = async () => {
      setJsonMissing(false);
      try {
        const res = await getDominiosProcesados(selectedAccount, selectedCloud);
        if (cancelled) return;

        if (res.success && Array.isArray(res.dominios) && res.dominios.length > 0) {
          // Mapeamos a la interfaz de resultados
          const mappedResults: SyncResult[] = res.dominios.map((d: any) => {
            const domainName = d.dominio || d.name || d;
            const isSuccess = typeof d === 'object' && d.provisioningStatus === 'success';
            const isError = typeof d === 'object' && d.provisioningStatus === 'failed';
            
            return {
              domain: domainName,
              status: isSuccess ? 'success' : (isError ? 'error' : 'pending'),
              message: isSuccess ? 'Completado' : (isError ? (d.errorReason || 'Error') : 'Pendiente')
            };
          });

          setResults(mappedResults);
          
          // Llenamos el textarea
          const dominiosRaw = res.dominios.map((d: any) => d.dominio || d.name || d).filter(Boolean);
          setDomainsText(dominiosRaw.join('\n'));
          setJsonMissing(false);

          if (onLog) onLog(`Dominios cargados para aprovisionamiento: ${mappedResults.length}`, 'info', 'provisioning');
        } else {
          setResults([]);
          setJsonMissing(true);
          if (onLog) onLog(`No se encontró dominios_procesados.json. Active modo manual.`, 'warning', 'provisioning');
        }
      } catch (error: any) {
        if (!cancelled) {
          setResults([]);
          setJsonMissing(true);
        }
        if (onLog) onLog(`Error al cargar dominios: ${error.message}. Ingrese manualmente.`, 'error', 'provisioning');
      }
    };

    loadDominios();
    return () => { cancelled = true; };
  }, [selectedAccount, selectedCloud, getDominiosProcesados, onLog]);

  // 2. Escuchar Eventos IPC del Pipeline Gray-to-Orange
  useEffect(() => {
    let api: any;
    try { api = (window as any).api; } catch { return; }
    if (!api) return;

    const handleDomainStart = (data: { phase: string; domain: string }) => {
      if (data.phase !== 'provisioning') return;
      setResults(prev => prev.map(r => 
        r.domain === data.domain ? { ...r, status: 'processing', message: 'Ejecutando pipeline...' } : r
      ));
    };

    const handleStateChanged = (state: any) => {
      if (state.results) {
        setResults(state.results);
      }
      setIsRunning(state.isRunning || false);
      if (state.currentMessage) {
        setStatusMessage(state.currentMessage);
      }
    };

    const handleSyncError = (data: { error: string }) => {
      setIsRunning(false);
      setStatusMessage(`Error fatal: ${data.error}`);
      if (onLog) onLog(`Error del pipeline: ${data.error}`, 'error', 'provisioning');
    };

    const handleLog = (data: { message: string; type: string }) => {
      if (onLog) onLog(data.message, data.type as any, 'provisioning');
    };

    api.receive('sync:domain-start', handleDomainStart);
    api.receive('provisioning:state-changed', handleStateChanged);
    api.receive('provisioning:sync-error', handleSyncError);
    api.receive('provisioning:log', handleLog);

    return () => {
      api.removeListener('sync:domain-start', handleDomainStart);
      api.removeListener('provisioning:state-changed', handleStateChanged);
      api.removeListener('provisioning:sync-error', handleSyncError);
      api.removeListener('provisioning:log', handleLog);
    };
  }, [onLog]);

  // Helpers de Configuración
  const accountsWithClouds = config?.accounts?.filter(account =>
    account.originClouds && account.originClouds.length > 0
  ) || [];

  const clouds = useMemo(() => selectedAccount
    ? config?.accounts.find(acc => acc.name === selectedAccount)?.originClouds || []
    : [], [config, selectedAccount]);

  const allPleskServers = useMemo(() =>
    (config?.destinationServers || []).filter(s => s.name !== 'Global'),
  [config]);

  // Acción: Ejecutar Pipeline
  const handleProvisionAll = useCallback(() => {
    const domains = domainsText.split('\n').map(d => d.trim()).filter(d => d.length > 0);
    if (domains.length === 0 || !pleskServerName) return;

    const selectedServer = allPleskServers.find(s => s.name === pleskServerName);
    if (!selectedServer) return;

    const pleskIp = selectedServer.sshCredentials.host;

    let api: any;
    try { api = (window as any).api; } catch { return; }
    
    setIsRunning(true);
    setStatusMessage('Iniciando pipeline maestro...');
    
    api.send('plesk:provision-domain', {
      domains,
      pleskIp,
      accountName: selectedAccount || '',
      cloudName: selectedCloud || ''
    });
  }, [domainsText, pleskServerName, selectedAccount, selectedCloud, allPleskServers]);

  const handleProvisionSingle = useCallback((domain: string) => {
    if (!pleskServerName) return;

    const selectedServer = allPleskServers.find(s => s.name === pleskServerName);
    if (!selectedServer) return;

    const pleskIp = selectedServer.sshCredentials.host;

    let api: any;
    try { api = (window as any).api; } catch { return; }
    
    setIsRunning(true);
    
    api.send('plesk:provision-domain', {
      domains: [domain],
      pleskIp,
      accountName: selectedAccount || '',
      cloudName: selectedCloud || ''
    });
  }, [pleskServerName, selectedAccount, selectedCloud, allPleskServers]);

  const canProvision = domainsText.length > 0 && !!pleskServerName && !isRunning;
  const pendingCount = results.length > 0 
    ? results.filter(r => r.status !== 'success').length 
    : domainsText.split('\n').filter(d => d.trim().length > 0).length;

  return (
    <div className="flex flex-col h-full bg-background overflow-hidden">
      
      {/* ── Page Header ── */}
      <div className="flex-none px-lg pt-lg pb-md border-b border-outline-variant/30">
        <h2 className="font-display-lg text-display-lg text-secondary mb-xs">
          Aprovisionamiento Gray-to-Orange
        </h2>
        <p className="font-body-md text-on-surface-variant max-w-2xl">
          Pipeline Unificado: DNS (Nube Gris) → Emisión SSL (HTTP-01) → Cloudflare (Nube Naranja)
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-lg pb-lg mt-md">
        <div className="max-w-6xl mx-auto space-y-lg pb-24">

          {/* ── Configuración ── */}
          <section>
            <h2 className="font-label-caps text-label-caps text-outline uppercase mb-sm">Configuración Transaccional</h2>
            <div className="bg-surface-container-low border border-outline-variant p-lg space-y-md rounded">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-md">
                
                <div className="space-y-xs">
                  <label className="font-label-caps text-label-caps text-outline">Cuenta Origen</label>
                  <select
                    value={selectedAccount}
                    onChange={e => setSelectedAccount(e.target.value)}
                    className="w-full bg-surface-container border border-outline-variant text-on-surface focus:border-secondary focus:ring-1 focus:ring-secondary font-body-md rounded px-sm py-sm"
                    disabled={isRunning}
                  >
                    <option value="">(Opcional) Seleccionar cuenta</option>
                    {accountsWithClouds.map(account => (
                      <option key={account.name} value={account.name}>
                        {account.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-xs">
                  <label className="font-label-caps text-label-caps text-outline">Cloud Origen</label>
                  <select
                    value={selectedCloud}
                    onChange={e => setSelectedCloud(e.target.value)}
                    className="w-full bg-surface-container border border-outline-variant text-on-surface focus:border-secondary focus:ring-1 focus:ring-secondary font-body-md rounded px-sm py-sm"
                    disabled={isRunning}
                  >
                    <option value="">(Opcional) Seleccionar cloud</option>
                    {clouds.map(cloud => (
                      <option key={cloud.name} value={cloud.name}>
                        {cloud.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-xs">
                  <label className="font-label-caps text-label-caps text-outline">Servidor Plesk Destino</label>
                  <select
                    value={pleskServerName}
                    onChange={e => setPleskServerName(e.target.value)}
                    className="w-full bg-surface-container border border-outline-variant text-on-surface focus:border-secondary focus:ring-1 focus:ring-secondary font-body-md rounded px-sm py-sm"
                    disabled={isRunning}
                  >
                    <option value="">Seleccionar servidor</option>
                    {allPleskServers.map(server => (
                      <option key={server.name} value={server.name}>
                        {server.name} {server.isLinked ? '(SSH OK)' : '(Sin SSH)'}
                      </option>
                    ))}
                  </select>
                </div>
                
                {/* TextArea de dominios */}
                <div className="md:col-span-3 space-y-xs">
                  <label className="font-label-caps text-label-caps text-outline flex items-center gap-xs">
                    Dominios (Modo Automático/Manual)
                    {domainsText.split('\n').filter(d => d.trim().length > 0).length > 0 && (
                      <span className="font-code-sm text-code-sm text-tertiary">
                        ({domainsText.split('\n').filter(d => d.trim().length > 0).length} dominio{domainsText.split('\n').filter(d => d.trim().length > 0).length !== 1 ? 's' : ''})
                      </span>
                    )}
                  </label>
                  <textarea
                    value={domainsText}
                    onChange={e => {
                      setDomainsText(e.target.value);
                      setJsonMissing(false);
                    }}
                    placeholder={"Pegue aquí la lista manual de dominios, uno por línea.\nejemplo.com\notro-dominio.net"}
                    className="w-full bg-surface-container border border-outline-variant text-on-surface focus:border-secondary focus:ring-1 focus:ring-secondary font-code-md rounded px-sm py-sm resize-y min-h-[6rem]"
                    rows={6}
                    disabled={isRunning}
                  />
                  {jsonMissing ? (
                    <p className="mt-1 font-body-sm text-warning animate-pulse-slow">
                      ⚠️ No se encontró dominios_procesados.json. Use el área de texto para introducirlos manualmente.
                    </p>
                  ) : (
                    <p className="mt-1 font-body-sm text-outline">
                      Se cargan automáticamente del JSON al seleccionar origen. Puede editar o pegar la lista manualmente.
                    </p>
                  )}
                </div>
              </div>
            </div>
          </section>

          {/* ── Acciones y Lista ── */}
          <section>
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-sm mb-sm">
              <h2 className="font-label-caps text-label-caps text-outline uppercase">Estado del Workspace</h2>
              
              <button
                onClick={handleProvisionAll}
                disabled={!canProvision || pendingCount === 0}
                className={`flex items-center gap-xs px-md py-sm font-title-sm rounded transition-all active:scale-95 ${(!canProvision || pendingCount === 0) ? 'bg-surface-container-highest text-outline cursor-not-allowed' : 'bg-secondary-container text-on-secondary-container hover:brightness-110'}`}
              >
                {isRunning ? (
                  <><span className="w-4 h-4 rounded-full border-2 border-outline border-t-transparent animate-spin shrink-0" /> Procesando...</>
                ) : (
                  <>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polygon points="5 3 19 12 5 21 5 3" />
                    </svg>
                    Aprovisionar Pendientes ({pendingCount})
                  </>
                )}
              </button>
            </div>

            <div className="bg-surface-container-low border border-outline-variant rounded overflow-hidden">
              {statusMessage && (
                <div className="bg-black/20 p-sm border-b border-outline-variant/30 font-code-sm text-on-surface-variant">
                  {statusMessage}
                </div>
              )}

              <div className="overflow-x-auto">
                <table className="w-full text-left font-body-sm border-collapse">
                  <thead>
                    <tr className="bg-surface-container text-outline font-label-caps text-label-caps border-b border-outline-variant/30">
                      <th className="py-sm px-md font-medium uppercase tracking-wider">Dominio</th>
                      <th className="py-sm px-md font-medium uppercase tracking-wider">Estado</th>
                      <th className="py-sm px-md font-medium uppercase tracking-wider">Mensaje</th>
                      <th className="py-sm px-md font-medium uppercase tracking-wider text-right">Acción</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-outline-variant/30">
                    {results.length === 0 && domainsText.trim().length === 0 && (
                      <tr>
                        <td colSpan={4} className="py-lg px-md text-center text-outline font-body-sm">
                          No hay dominios cargados. Selecciona una cuenta y un cloud, o introdúcelos manualmente.
                        </td>
                      </tr>
                    )}
                    {results.length === 0 && domainsText.trim().length > 0 && domainsText.split('\n').filter(d => d.trim().length > 0).map((d, i) => (
                      <tr key={i} className="hover:bg-surface-container/50 transition-colors">
                        <td className="py-sm px-md font-code-sm text-on-surface-variant">
                          {d.trim()}
                        </td>
                        <td className="py-sm px-md">
                          <div className="flex items-center gap-xs text-outline font-body-sm">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                            <span>Manual</span>
                          </div>
                        </td>
                        <td className="py-sm px-md font-body-sm text-on-surface-variant truncate max-w-[200px]">
                          Listo para aprovisionar
                        </td>
                        <td className="py-sm px-md text-right">
                          <button
                            onClick={() => handleProvisionSingle(d.trim())}
                            disabled={isRunning || !pleskServerName}
                            className="bg-surface-container-highest hover:bg-outline-variant/30 text-on-surface-variant px-sm py-1 font-label-caps text-label-caps rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            Procesar
                          </button>
                        </td>
                      </tr>
                    ))}
                    {results.map((r, i) => {
                      const isSuccess = r.status === 'success';
                      const isError = r.status === 'error';
                      const isProcessing = r.status === 'processing';
                      const isPending = r.status === 'pending';
                      
                      const statusColor = isSuccess ? 'text-green-400' : isError ? 'text-error' : isProcessing ? 'text-tertiary' : 'text-outline';
                      
                      return (
                        <tr key={i} className={`transition-colors ${isSuccess ? 'bg-green-400/5' : isError ? 'bg-error/5' : 'hover:bg-surface-container/50'}`}>
                          <td className="py-sm px-md font-code-sm text-on-surface-variant">
                            {r.domain}
                          </td>
                          <td className="py-sm px-md">
                            <div className={`flex items-center gap-xs font-body-sm ${statusColor}`}>
                              {isProcessing && <span className="w-3 h-3 rounded-full border-2 border-current border-t-transparent animate-spin shrink-0" />}
                              {isSuccess && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><polyline points="20 6 9 17 4 12" /></svg>}
                              {isError && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>}
                              {isPending && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>}
                              <span className="capitalize">{r.status}</span>
                            </div>
                          </td>
                          <td className="py-sm px-md font-body-sm text-on-surface-variant truncate max-w-[200px]" title={r.message}>
                            {r.message}
                          </td>
                          <td className="py-sm px-md text-right">
                            {r.status !== 'success' && (
                              <button
                                onClick={() => handleProvisionSingle(r.domain)}
                                disabled={isRunning || !pleskServerName}
                                className="bg-surface-container-highest hover:bg-outline-variant/30 text-on-surface-variant px-sm py-1 font-label-caps text-label-caps rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                              >
                                Procesar
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </section>

        </div>
      </div>
    </div>
  );
};

export default ProvisioningModule;
