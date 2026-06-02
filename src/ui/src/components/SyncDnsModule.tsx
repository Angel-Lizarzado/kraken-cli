import { useState, useEffect, useMemo, useCallback } from 'react';
import { useConfig } from '../contexts/ConfigContext';
import { useModuleState, useAppState } from '../contexts/AppStateContext';
import { useIpc } from '../hooks/useIpc';
import { useToast } from './Toast';

interface DomainOperationResult {
  domain: string;
  status: 'pending' | 'processing' | 'success' | 'error';
  message: string;
}

interface SyncDnsModuleProps {
  onLog: (msg: string, type?: 'info' | 'error' | 'success' | 'warning') => void;
}

export default function SyncDnsModule({ onLog }: SyncDnsModuleProps) {
  const { config } = useConfig();
  const [state, setSyncState] = useModuleState('syncdns');
  const { state: appState } = useAppState(); // for extraction list
  const { runSyncDnsBatch, getDominiosProcesados, loadCsvDates } = useIpc();
  const toast = useToast();

  const [localDomains, setLocalDomains] = useState<string[]>([]);
  const [domainListText, setDomainListText] = useState('');
  const [csvDates, setCsvDates] = useState<Record<string, string> | null>(null);
  const [expandedDomain, setExpandedDomain] = useState<string | null>(null);

  // Selectores de cuenta y cloud
  const accountsWithClouds = useMemo(() =>
    config?.accounts?.filter(account => account && account.name) || [],
    [config]
  );

  const clouds = useMemo(() => state.selectedAccount
    ? config?.accounts.find(acc => acc.name === state.selectedAccount)?.originClouds || []
    : [], [config, state.selectedAccount]);

  const linkedClouds = useMemo(() => clouds.filter(cloud => cloud.isLinked), [clouds]);

  const handleAccountChange = (accountName: string) => {
    setSyncState({ selectedAccount: accountName, selectedCloud: '', results: [] });
  };

  const handleCloudChange = useCallback(async (cloudName: string) => {
    setSyncState({ selectedCloud: cloudName, results: [] });
    
    if (!cloudName) {
      setLocalDomains([]);
      setDomainListText('');
      return;
    }
  }, [setSyncState]);

  // Auto-fill form from dominios_procesados.json when account/cloud changes
  useEffect(() => {
    if (state.selectedAccount && state.selectedCloud) {
      try {
        const cloudName = state.selectedCloud;
        getDominiosProcesados(state.selectedAccount, cloudName).then(result => {
          if (result.success && Array.isArray(result.dominios)) {
            const doms = result.dominios
              .map((d: any) => typeof d === 'string' ? d : d?.dominio)
              .filter((d): d is string => typeof d === 'string' && d.length > 0);
            
            if (doms.length > 0) {
              setLocalDomains(doms);
              setDomainListText(doms.join('\n'));
            } else {
              setLocalDomains([]);
              setDomainListText('');
            }
          } else {
            setLocalDomains([]);
            setDomainListText('');
          }
        }).catch(() => {
          setLocalDomains([]);
          setDomainListText('');
        });
      } catch {
        setLocalDomains([]);
        setDomainListText('');
      }
    }
  }, [state.selectedAccount, state.selectedCloud, getDominiosProcesados]);

  useEffect(() => {
    // Si la lista de extracción está llena, la heredamos (para no tener que tipear)
    // o si el usuario ha procesado un JSON previamente en el dashboard
    if (appState.modules.extraction?.domainList && localDomains.length === 0) {
      const domains = appState.modules.extraction.domainList.split('\n').map((d: string) => d.trim()).filter(Boolean);
      if (domains.length > 0) {
        setLocalDomains(domains);
        setDomainListText(domains.join('\n'));
      }
    }
  }, [appState.modules.extraction?.domainList]);

  useEffect(() => {
    let api: any = null;
    try {
      api = (window as any).electronAPI || (window as any).api;
    } catch {
      return;
    }

    if (!api) return;

    const handleStateChanged = (newState: any) => {
      if (!newState) return;
      setSyncState(prev => {
        const partial: any = {
          loading: !!newState.isRunning,
          isRunning: !!newState.isRunning,
          currentDomain: newState.currentDomain || '',
          progress: {
            current: newState.isRunning ? newState.currentProgress : 100,
            total: newState.totalDomains,
          },
          statusMessage: newState.currentMessage || '',
        };
        if (newState.results) {
          partial.results = newState.results;
        }
        return partial;
      });
    };

    const handleLog = (data: any) => {
      setSyncState(prev => ({
        logs: (() => {
          const prevLogs = prev.logs || [];
          const next = [...prevLogs, { message: data.message, type: data.type || 'info', timestamp: data.timestamp || Date.now() }];
          return next.length > 100 ? next.slice(-100) : next;
        })(),
      }));
    };

    const unsubscribeState = api.onEvent('syncdns:state-changed', handleStateChanged);
    const unsubscribeLog = api.onEvent('syncdns:log', handleLog);

    return () => {
      if (unsubscribeState) unsubscribeState();
      if (unsubscribeLog) unsubscribeLog();
    };
  }, [setSyncState]);

  const logLocal = (message: string, type: string = 'info') => {
    setSyncState(prev => ({
      logs: [...(prev.logs || []), { message, type, timestamp: Date.now() }]
    }));
  };

  const handleLoadCsv = async () => {
    const res = await loadCsvDates();
    if (res.canceled) return;
    if (res.success && res.dates) {
      setCsvDates(res.dates);
      toast.success(`CSV cargado: ${res.count} fechas extraídas`);
    } else {
      toast.error(res.error || 'Error al cargar CSV');
    }
  };

  // Handle run batch
  const handleRunBatch = async () => {
    if (!config) {
      logLocal('La configuración aún no ha cargado o está vacía.', 'error');
      return;
    }
    const cleanDomains = localDomains.map(d => d.trim()).filter(Boolean);
    if (cleanDomains.length === 0) {
      logLocal('No hay dominios para sincronizar.', 'warning');
      return;
    }
    if (!state.selectedAccount || !state.selectedCloud) {
      logLocal('Debe seleccionar una cuenta y un cloud de origen.', 'warning');
      return;
    }

    try {
      const activeCloud = config.accounts.find(a => a.name === state.selectedAccount)?.originClouds?.find(c => c.name === state.selectedCloud);
      if (!activeCloud) {
         logLocal('La cuenta cloud seleccionada no existe en la configuración.', 'error');
         return;
      }
      
      let domainsToSync = cleanDomains;
      if (csvDates) {
        const initialCount = cleanDomains.length;
        domainsToSync = cleanDomains.filter(d => csvDates[d] !== undefined);
        const filteredCount = initialCount - domainsToSync.length;
        if (filteredCount > 0) {
          logLocal(`Filtro CSV activo: Se ignorarán ${filteredCount} dominios que no están en el archivo.`, 'warning');
        }
      }

      if (domainsToSync.length === 0) {
        logLocal('Ningún dominio coincide con el CSV cargado.', 'error');
        return;
      }

      const res = await runSyncDnsBatch(
        state.selectedAccount,
        activeCloud.name,
        domainsToSync
      );

      if (res.success) {
        logLocal(`Sincronización masiva finalizada: ${res.successCount} ok, ${res.errors} errores`, 'success');
      } else {
        logLocal(`Sincronización masiva falló: ${res.error}`, 'error');
      }
      
      // Fallback: force UI state release
      setSyncState(prev => {
        const cleanResults = (prev.results || []).map((r: any) => 
          r.status === 'processing' ? { ...r, status: 'error', message: 'Cancelado/Fallido' } : r
        );
        return { ...prev, isRunning: false, results: cleanResults, currentMessage: 'Finalizado' };
      });
    } catch (err: any) {
      logLocal(`Error crítico: ${err.message}`, 'error');
      setSyncState({ isRunning: false });
    }
  };

  const handleClearResults = async () => {
    setSyncState({ results: [], logs: [] });
    onLog('Resultados limpiados.', 'info');
  };

  const getStatusBadge = (domain: string) => {
    const res = state?.results?.find((r: any) => r.domain === domain);
    if (!res) return <span className="status-badge status-badge-pending">En cola</span>;
    if (res.status === 'success') return <span className="status-badge status-badge-success">Sincronizado</span>;
    if (res.status === 'error') return <span className="status-badge status-badge-error">Error</span>;
    if (res.status === 'processing') return <span className="status-badge status-badge-progress">Sincronizando...</span>;
    return <span className="status-badge status-badge-pending">Pendiente</span>;
  };

  return (
    <div className="module-container p-6 animate-fade-in flex flex-col h-full">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="font-display text-xl font-bold">Sincronización DNS</h1>
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Fase 0: Cloudflare & DonDominio</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 flex-1 min-h-0">
        <div className="lg:col-span-1 flex flex-col gap-6">
          <div className="card p-5">
            <h2 className="font-display text-base font-bold mb-4">Control de Sincronización</h2>
            
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Cuenta</label>
                  <select
                    value={state.selectedAccount || ''}
                    onChange={e => handleAccountChange(e.target.value)}
                    className="input"
                    disabled={state?.isRunning}
                  >
                    <option value="">Seleccionar cuenta</option>
                    {accountsWithClouds.map(account => (
                      <option key={account.name} value={account.name}>
                        {account.name} ({account.originClouds?.length || 0} clouds)
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Cloud origen</label>
                  <select
                    value={state.selectedCloud || ''}
                    onChange={e => handleCloudChange(e.target.value)}
                    className="input"
                    disabled={!state.selectedAccount || state?.isRunning}
                  >
                    <option value="">Seleccionar cloud</option>
                    {clouds.map(cloud => (
                      <option key={cloud.name} value={cloud.name}>
                        {cloud.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-muted)' }}>
                  Dominios a Sincronizar ({localDomains.length})
                </label>
                <textarea
                  className="input"
                  style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8125rem', resize: 'vertical', minHeight: '6rem' }}
                  rows={6}
                  value={domainListText}
                  onChange={(e) => {
                    setDomainListText(e.target.value);
                    const lines = e.target.value.split('\n').map(d => d.trim()).filter(Boolean);
                    setLocalDomains(lines);
                  }}
                  disabled={state?.isRunning}
                  placeholder="ejemplo.com&#10;dominio.es"
                />
                <div className="flex justify-between items-center mt-2">
                  <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    Se cargan automáticamente. {csvDates && <span className="text-emerald-400">CSV cargado ({Object.keys(csvDates).length})</span>}
                  </p>
                  <button
                    onClick={handleLoadCsv}
                    disabled={state?.isRunning}
                    className="btn btn--secondary py-1 px-3 text-xs"
                    title="Carga un CSV de DonDominio para extraer las fechas de caducidad"
                  >
                    Cargar CSV
                  </button>
                </div>
              </div>

              <button 
                onClick={handleRunBatch}
                disabled={state?.isRunning || localDomains.length === 0}
                className="btn btn--primary w-full py-2.5 flex justify-center items-center gap-2"
              >
                {state?.isRunning ? (
                  <>
                    <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    Sincronizando ({localDomains.length})
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                    Iniciar sincronización ({localDomains.length > 0 ? localDomains.length : ''})
                  </>
                )}
              </button>

              <div className="flex gap-2">
                <button 
                  onClick={handleClearResults}
                  disabled={state?.isRunning || (state?.results || []).length === 0}
                  className="btn btn--secondary w-full py-2 text-xs"
                >
                  Limpiar historial
                </button>
                <button 
                  onClick={async () => {
                    const results = state?.results || [];
                    const dates = localDomains.map(domain => {
                      if (csvDates && csvDates[domain]) {
                        return csvDates[domain];
                      }
                      const res = results.find((r: any) => r.domain === domain);
                      return (res as any)?.expirationDate || 'N/A';
                    });
                    const textToCopy = dates.join('\n');
                    try {
                      await navigator.clipboard.writeText(textToCopy);
                      toast.success('Fechas de expiración copiadas al portapapeles');
                    } catch (err) {
                      try {
                        const textArea = document.createElement("textarea");
                        textArea.value = textToCopy;
                        textArea.style.position = "fixed";
                        textArea.style.top = "0";
                        textArea.style.left = "0";
                        document.body.appendChild(textArea);
                        textArea.focus();
                        textArea.select();
                        document.execCommand('copy');
                        document.body.removeChild(textArea);
                        toast.success('Fechas de expiración copiadas al portapapeles (modo seguro)');
                      } catch (fallbackErr) {
                        toast.error('Haz clic en la pantalla antes de copiar, por favor.');
                      }
                    }
                  }}
                  disabled={state?.isRunning || (state?.results || []).length === 0}
                  className="btn btn--secondary w-full py-2 text-xs"
                  title="Copia solo las fechas en el mismo orden para pegar en Sheets"
                >
                  Copiar fechas expiración
                </button>
              </div>
            </div>
          </div>

          <div className="card p-5 flex-1 min-h-[250px] flex flex-col">
            <h2 className="font-display text-base font-bold mb-4">Registro en vivo</h2>
            <div className="terminal-log flex-1">
              {state?.logs?.map((log: any, idx: number) => (
                <div key={idx} className="mb-1 leading-relaxed">
                  <span className="opacity-50 select-none mr-2">[{new Date(log.timestamp).toLocaleTimeString()}]</span>
                  <span className={
                    log.type === 'error' ? 'text-red-400 font-medium' :
                    log.type === 'success' ? 'text-emerald-400 font-medium' :
                    log.type === 'warning' ? 'text-amber-400' :
                    'text-slate-300'
                  }>
                    {log.message}
                  </span>
                </div>
              ))}
              {(!state?.logs || state.logs.length === 0) && (
                <div className="text-slate-500 italic text-center mt-4">Esperando operaciones...</div>
              )}
            </div>
          </div>
        </div>

        <div className="lg:col-span-2 card p-0 flex flex-col overflow-hidden">
          <div className="p-5 border-b flex justify-between items-center" style={{ borderBottomColor: 'var(--border-default)' }}>
            <h2 className="font-display text-base font-bold">Estado de Dominios</h2>
            {state?.isRunning && (
              <div className="flex items-center gap-2 px-3 py-1 bg-emerald-500/10 text-emerald-400 rounded-full text-xs font-medium">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                </span>
                Procesando: {state.currentDomain}
              </div>
            )}
          </div>
          
          <div className="flex-1 overflow-y-auto p-5 custom-scrollbar">
            {localDomains.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-slate-500 p-8 text-center border border-dashed border-white/10 rounded-xl">
                <svg className="w-12 h-12 mb-3 opacity-20" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
                </svg>
                <p>No hay dominios configurados.</p>
                <p className="text-xs mt-1">Ingresa los dominios en el panel izquierdo.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {localDomains.map(domain => {
                  const result = state?.results?.find((r: any) => r.domain === domain);
                  const isCurrent = state?.currentDomain === domain;
                  const isSuccess = result?.status === 'success';
                  const isExpanded = expandedDomain === domain;
                  
                  const nameserversMatch = result?.message?.match(/Configura en tu registrador: (.*)/);
                  const nameservers = nameserversMatch ? nameserversMatch[1].split(', ') : [];
                  
                  return (
                    <div 
                      key={domain} 
                      className={`flex flex-col p-3 rounded-lg border transition-colors ${isSuccess ? 'cursor-pointer hover:border-white/20' : ''} ${
                        isCurrent 
                          ? 'bg-[#1a2333] border-blue-500/30 shadow-[0_0_15px_rgba(59,130,246,0.1)]' 
                          : 'bg-[#151c28] border-white/5'
                      }`}
                      onClick={() => {
                        if (isSuccess && nameservers.length > 0) {
                          setExpandedDomain(isExpanded ? null : domain);
                        }
                      }}
                    >
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between">
                        <div className="flex items-center gap-3 mb-2 sm:mb-0">
                          {getStatusBadge(domain)}
                          <span className={`font-mono text-sm ${isCurrent ? 'text-white font-medium' : 'text-slate-300'}`}>
                            {domain}
                          </span>
                        </div>
                        <div className="text-xs text-slate-400 font-mono truncate max-w-[300px] text-right flex items-center gap-2" title={result?.message}>
                          {isSuccess && nameservers.length > 0 ? (
                            <span className="flex items-center gap-1 text-emerald-400">
                              Éxito (Click para ver DNS)
                              <svg className={`w-3 h-3 transition-transform ${isExpanded ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                              </svg>
                            </span>
                          ) : (
                            result?.message || (isCurrent ? 'Iniciando...' : '-')
                          )}
                        </div>
                      </div>

                      {isExpanded && nameservers.length > 0 && (
                        <div 
                          className="mt-4 pt-3 border-t border-white/5 flex flex-col gap-2 animate-in fade-in slide-in-from-top-2 duration-200"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div className="text-xs text-slate-400 mb-1">Nameservers asignados por Cloudflare:</div>
                          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                            <div 
                              className="bg-[#0f141f] p-3 rounded-md border border-white/5 flex justify-between items-center group cursor-pointer hover:border-white/10 transition-colors"
                              onClick={() => { navigator.clipboard.writeText(domain); toast.success('Dominio copiado'); }}
                            >
                              <div className="overflow-hidden pr-2">
                                <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1 font-bold">Dominio</div>
                                <div className="font-mono text-sm text-blue-400 truncate">{domain}</div>
                              </div>
                              <button 
                                onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(domain); toast.success('Dominio copiado'); }}
                                className="text-slate-500 hover:text-white transition-colors p-1 opacity-0 group-hover:opacity-100 flex-shrink-0"
                                title="Copiar Dominio"
                              >
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                              </button>
                            </div>
                            <div 
                              className="bg-[#0f141f] p-3 rounded-md border border-white/5 flex justify-between items-center group cursor-pointer hover:border-white/10 transition-colors"
                              onClick={() => { navigator.clipboard.writeText(nameservers[0]); toast.success('DNS 1 copiado'); }}
                            >
                              <div className="overflow-hidden pr-2">
                                <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1 font-bold">DNS 1</div>
                                <div className="font-mono text-sm text-blue-400">{nameservers[0]}</div>
                              </div>
                              <button 
                                onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(nameservers[0]); toast.success('DNS 1 copiado'); }}
                                className="text-slate-500 hover:text-white transition-colors p-1 opacity-0 group-hover:opacity-100"
                                title="Copiar"
                              >
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                              </button>
                            </div>
                            {nameservers[1] && (
                              <div 
                                className="bg-[#0f141f] p-3 rounded-md border border-white/5 flex justify-between items-center group cursor-pointer hover:border-white/10 transition-colors"
                                onClick={() => { navigator.clipboard.writeText(nameservers[1]); toast.success('DNS 2 copiado'); }}
                              >
                                <div className="overflow-hidden pr-2">
                                  <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1 font-bold">DNS 2</div>
                                  <div className="font-mono text-sm text-blue-400">{nameservers[1]}</div>
                                </div>
                                <button 
                                  onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(nameservers[1]); toast.success('DNS 2 copiado'); }}
                                  className="text-slate-500 hover:text-white transition-colors p-1 opacity-0 group-hover:opacity-100"
                                  title="Copiar"
                                >
                                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
