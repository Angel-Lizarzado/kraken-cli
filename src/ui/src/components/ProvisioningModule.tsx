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
    if (domains.length === 0 || !pleskServerName || !selectedAccount || !selectedCloud) return;

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
      accountName: selectedAccount,
      cloudName: selectedCloud
    });
  }, [domainsText, pleskServerName, selectedAccount, selectedCloud, allPleskServers]);

  const handleProvisionSingle = useCallback((domain: string) => {
    if (!pleskServerName || !selectedAccount || !selectedCloud) return;

    const selectedServer = allPleskServers.find(s => s.name === pleskServerName);
    if (!selectedServer) return;

    const pleskIp = selectedServer.sshCredentials.host;

    let api: any;
    try { api = (window as any).api; } catch { return; }
    
    setIsRunning(true);
    
    api.send('plesk:provision-domain', {
      domains: [domain],
      pleskIp,
      accountName: selectedAccount,
      cloudName: selectedCloud
    });
  }, [pleskServerName, selectedAccount, selectedCloud, allPleskServers]);

  const canProvision = domainsText.length > 0 && !!pleskServerName && !!selectedAccount && !!selectedCloud && !isRunning;
  const pendingCount = results.length > 0 
    ? results.filter(r => r.status !== 'success').length 
    : domainsText.split('\n').filter(d => d.trim().length > 0).length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-xl font-bold">Aprovisionamiento Gray-to-Orange</h1>
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          Pipeline Unificado: DNS (Nube Gris) → Emisión SSL (HTTP-01) → Cloudflare (Nube Naranja)
        </p>
      </div>

      {/* Configuración */}
      <div className="card p-5">
        <h2 className="font-display text-base font-bold mb-4">Configuración Transaccional</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Cuenta Origen</label>
            <select
              value={selectedAccount}
              onChange={e => setSelectedAccount(e.target.value)}
              className="input"
              disabled={isRunning}
            >
              <option value="">Seleccionar cuenta</option>
              {accountsWithClouds.map(account => (
                <option key={account.name} value={account.name}>
                  {account.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Cloud Origen</label>
            <select
              value={selectedCloud}
              onChange={e => setSelectedCloud(e.target.value)}
              className="input"
              disabled={!selectedAccount || isRunning}
            >
              <option value="">Seleccionar cloud</option>
              {clouds.map(cloud => (
                <option key={cloud.name} value={cloud.name}>
                  {cloud.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Servidor Plesk Destino</label>
            <select
              value={pleskServerName}
              onChange={e => setPleskServerName(e.target.value)}
              className="input"
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
          <div className="md:col-span-3">
            <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
              Dominios (Modo Automático/Manual)
              {domainsText.split('\n').filter(d => d.trim().length > 0).length > 0 && (
                <span className="ml-2 font-mono text-xs" style={{ color: 'var(--text-muted)' }}>
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
              className="input"
              rows={6}
              disabled={isRunning}
              style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8125rem', resize: 'vertical', minHeight: '6rem' }}
            />
            {jsonMissing ? (
              <p className="mt-1.5 text-xs font-semibold animate-pulse-slow" style={{ color: 'var(--color-warning)' }}>
                ⚠️ No se encontró dominios_procesados.json. Use el área de texto para introducirlos manualmente.
              </p>
            ) : (
              <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                Se cargan automáticamente del JSON al seleccionar origen. Puede editar o pegar la lista manualmente.
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Acciones y Lista */}
      <div className="card p-5">
        <div className="flex justify-between items-center mb-4">
          <h2 className="font-display text-base font-bold">Estado del Workspace</h2>
          <button
            onClick={handleProvisionAll}
            disabled={!canProvision || pendingCount === 0}
            className="btn btn--primary"
          >
            {isRunning ? (
              <span className="flex items-center gap-2">
                <span className="spinner" /> Procesando...
              </span>
            ) : (
              <span className="flex items-center gap-2">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="5 3 19 12 5 21 5 3" />
                </svg>
                Aprovisionar Pendientes ({pendingCount})
              </span>
            )}
          </button>
        </div>

        {statusMessage && (
          <div className="mb-4 text-xs p-2 rounded" style={{ backgroundColor: 'oklch(0.5 0 0 / 0.05)', color: 'var(--text-secondary)' }}>
            {statusMessage}
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left" style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border-default)' }}>
                <th className="pb-2 pr-3 font-medium">Dominio</th>
                <th className="pb-2 pr-3 font-medium">Estado</th>
                <th className="pb-2 pr-3 font-medium">Mensaje</th>
                <th className="pb-2 pr-3 font-medium text-right">Acción</th>
              </tr>
            </thead>
            <tbody>
              {results.length === 0 && domainsText.trim().length === 0 && (
                <tr>
                  <td colSpan={4} className="py-4 text-center" style={{ color: 'var(--text-muted)' }}>
                    No hay dominios cargados. Selecciona una cuenta y un cloud, o introdúcelos manualmente.
                  </td>
                </tr>
              )}
              {results.length === 0 && domainsText.trim().length > 0 && domainsText.split('\n').filter(d => d.trim().length > 0).map((d, i) => (
                <tr key={i} className="border-t transition-colors hover:bg-[oklch(0.5_0_0_/_0.02)]" style={{ borderTopColor: 'var(--border-default)' }}>
                  <td className="py-2 pr-3 font-mono" style={{ color: 'var(--text-secondary)' }}>
                    {d.trim()}
                  </td>
                  <td className="py-2 pr-3">
                    <div className="flex items-center gap-1.5" style={{ color: 'var(--text-muted)' }}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                      <span>Manual</span>
                    </div>
                  </td>
                  <td className="py-2 pr-3 truncate max-w-[200px]" style={{ color: 'var(--text-secondary)' }}>
                    Listo para aprovisionar
                  </td>
                  <td className="py-2 pr-3 text-right">
                    <button
                      onClick={() => handleProvisionSingle(d.trim())}
                      disabled={isRunning || !pleskServerName}
                      className="btn btn--secondary px-2 py-1 text-[10px]"
                    >
                      Procesar
                    </button>
                  </td>
                </tr>
              ))}
              {results.map((r, i) => (
                <tr key={i} className="border-t transition-colors hover:bg-[oklch(0.5_0_0_/_0.02)]" style={{ borderTopColor: 'var(--border-default)' }}>
                  <td className="py-2 pr-3 font-mono" style={{ color: 'var(--text-secondary)' }}>
                    {r.domain}
                  </td>
                  <td className="py-2 pr-3">
                    <div className="flex items-center gap-1.5" style={{
                      color:
                        r.status === 'success' ? 'var(--color-success)' :
                        r.status === 'error' ? 'var(--color-error)' :
                        r.status === 'processing' ? 'var(--color-info)' :
                        'var(--text-muted)'
                    }}>
                      {r.status === 'processing' && <span className="spinner" style={{ width: 12, height: 12, borderWidth: 1.5 }} />}
                      {r.status === 'success' && (
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                      )}
                      {r.status === 'error' && (
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
                      )}
                      {r.status === 'pending' && (
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                      )}
                      <span className="capitalize">{r.status}</span>
                    </div>
                  </td>
                  <td className="py-2 pr-3 truncate max-w-[200px]" style={{ color: 'var(--text-secondary)' }} title={r.message}>
                    {r.message}
                  </td>
                  <td className="py-2 pr-3 text-right">
                    <button
                      onClick={() => handleProvisionSingle(r.domain)}
                      disabled={isRunning || r.status === 'success' || !pleskServerName}
                      className="btn btn--secondary px-2 py-1 text-[10px]"
                      style={{ opacity: r.status === 'success' ? 0 : 1 }}
                    >
                      Procesar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default ProvisioningModule;
