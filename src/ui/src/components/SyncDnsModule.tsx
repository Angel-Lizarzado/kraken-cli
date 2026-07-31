import React, { useState, useEffect, useMemo, useCallback, Fragment } from 'react';
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
  logs?: { message: string; type: string; timestamp?: number; source?: string }[];
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
    let cloudName = '';
    
    try {
      if (state.selectedAccount && state.selectedCloud) {
        const activeCloud = config.accounts.find(a => a.name === state.selectedAccount)?.originClouds?.find(c => c.name === state.selectedCloud);
        if (!activeCloud) {
           logLocal('La cuenta cloud seleccionada no existe en la configuración.', 'error');
           return;
        }
        cloudName = activeCloud.name;
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
        state.selectedAccount || '',
        cloudName || '',
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
    <div className="flex flex-col h-full bg-background overflow-hidden">

      {/* ── Page Header ── */}
      <div className="flex-none px-lg pt-lg pb-md">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-md">
          <div>
            <h2 className="font-display-lg text-display-lg text-secondary mb-xs">Configuración Post-Migración</h2>
            <p className="font-body-md text-on-surface-variant max-w-2xl">
              Sincronización DNS vía Cloudflare y DonDominio. Verificación de propagación y gestión de registros por dominio.
            </p>
          </div>
          <div className="flex gap-sm shrink-0">
            <button
              onClick={handleRunBatch}
              disabled={state?.isRunning || localDomains.length === 0}
              className={`flex items-center gap-xs px-md py-sm font-title-sm rounded transition-all active:scale-95 ${
                !state?.isRunning && localDomains.length > 0
                  ? 'bg-secondary-container text-on-secondary-container hover:brightness-110'
                  : 'bg-surface-container-highest text-outline cursor-not-allowed'
              }`}
            >
              {state?.isRunning ? (
                <>
                  <span className="spinner text-current" />
                  Sincronizando ({localDomains.length})
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  Iniciar Sincronización{localDomains.length > 0 ? ` (${localDomains.length})` : ''}
                </>
              )}
            </button>
            <button
              onClick={handleClearResults}
              disabled={state?.isRunning || (state?.results || []).length === 0}
              className="flex items-center gap-xs px-md py-sm font-title-sm bg-surface-container-highest text-on-surface-variant rounded border border-outline-variant hover:bg-surface-bright transition-all active:scale-95 disabled:opacity-50"
            >
              Limpiar
            </button>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-lg pb-lg space-y-md">

        {/* ── Selection Bar ── */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-md items-end">
          <div className="space-y-xs">
            <label className="font-label-caps text-label-caps text-outline">Cuenta (Opcional)</label>
            <select
              value={state.selectedAccount || ''}
              onChange={e => handleAccountChange(e.target.value)}
              disabled={state?.isRunning}
              className="w-full bg-surface-container-high border-b-2 border-outline-variant border-x-0 border-t-0 text-on-surface focus:border-secondary focus:ring-0 font-body-md rounded-t px-sm py-sm disabled:opacity-50"
            >
              <option value="">(Opcional) Seleccionar cuenta</option>
              {accountsWithClouds.map(account => (
                <option key={account.name} value={account.name}>
                  {account.name} ({account.originClouds?.length || 0} clouds)
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-xs">
            <label className="font-label-caps text-label-caps text-outline">Cloud Origen (Opcional)</label>
            <select
              value={state.selectedCloud || ''}
              onChange={e => handleCloudChange(e.target.value)}
              disabled={!state.selectedAccount || state?.isRunning}
              className="w-full bg-surface-container-high border-b-2 border-outline-variant border-x-0 border-t-0 text-on-surface focus:border-secondary focus:ring-0 font-body-md rounded-t px-sm py-sm disabled:opacity-50"
            >
              <option value="">(Opcional) Seleccionar cloud</option>
              {clouds.map(cloud => (
                <option key={cloud.name} value={cloud.name}>{cloud.name}</option>
              ))}
            </select>
          </div>

          <div className="flex gap-sm pb-xs">
            <button
              onClick={handleLoadCsv}
              disabled={state?.isRunning}
              className="flex-1 flex items-center justify-center gap-xs px-md py-sm font-label-caps text-label-caps bg-surface-container-high border border-outline-variant text-on-surface hover:bg-surface-bright transition-all rounded disabled:opacity-50"
            >
              Cargar CSV DonDominio
            </button>
            {csvDates && (
              <span className="flex items-center text-green-400 font-label-caps text-label-caps whitespace-nowrap">
                <span className="w-2 h-2 rounded-full bg-green-500 mr-xs" />
                {Object.keys(csvDates).length} fechas
              </span>
            )}
          </div>
        </div>

        {/* ── Domain list (textarea) + progress ── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-md">

          {/* Left: Domain textarea */}
          <div className="space-y-md">
            <div className="bg-surface-container-low border border-outline-variant p-md space-y-sm">
              <div className="flex items-center justify-between">
                <span className="font-title-sm text-on-surface">Dominios a Sincronizar</span>
                {localDomains.length > 0 && (
                  <span className="font-code-sm text-code-sm text-secondary border border-secondary/30 bg-secondary-container/10 px-sm py-[2px] rounded-sm">
                    {localDomains.length} TOTAL
                  </span>
                )}
              </div>
              <textarea
                className="w-full bg-surface-container border-0 border-b border-outline-variant text-on-surface font-code-md text-code-md rounded-t px-sm py-sm resize-none focus:border-secondary focus:ring-0"
                rows={10}
                value={domainListText}
                onChange={(e) => {
                  setDomainListText(e.target.value);
                  const lines = e.target.value.split('\n').map(d => d.trim()).filter(Boolean);
                  setLocalDomains(lines);
                }}
                disabled={state?.isRunning}
                placeholder="ejemplo.com&#10;dominio.es"
              />
              <p className="font-body-sm text-body-sm text-outline">
                Se cargan automáticamente al seleccionar el cloud.
              </p>
            </div>

            {/* Running indicator */}
            {state?.isRunning && (
              <div className="bg-surface-container-low border border-secondary/30 p-md flex items-center gap-sm">
                <span className="spinner text-secondary" />
                <div>
                  <p className="font-label-caps text-label-caps text-secondary">PROCESANDO</p>
                  <p className="font-code-sm text-code-sm text-on-surface-variant truncate">{state.currentDomain}</p>
                </div>
              </div>
            )}

            {/* Copy dates button */}
            <button
              onClick={async () => {
                const results = state?.results || [];
                const dates = localDomains.map(domain => {
                  if (csvDates && csvDates[domain]) return csvDates[domain];
                  const res = results.find((r: any) => r.domain === domain);
                  return (res as any)?.expirationDate || 'N/A';
                });
                try {
                  await navigator.clipboard.writeText(dates.join('\n'));
                  toast.success('Fechas copiadas al portapapeles');
                } catch {
                  toast.error('Haz clic en la pantalla antes de copiar');
                }
              }}
              disabled={state?.isRunning || (state?.results || []).length === 0}
              className="w-full px-md py-sm font-label-caps text-label-caps bg-surface-container-high border border-outline-variant text-on-surface-variant hover:bg-surface-bright transition-all rounded disabled:opacity-50"
            >
              Copiar Fechas de Expiración
            </button>
          </div>

          {/* Right: Domain status table */}
          <div className="lg:col-span-2 bg-surface-container-low border border-outline-variant flex flex-col overflow-hidden">
            <div className="bg-surface-container-high px-md py-sm flex items-center justify-between border-b border-outline-variant shrink-0">
              <span className="font-title-sm text-on-surface">Estado de Dominios</span>
              {state?.isRunning && (
                <div className="flex items-center gap-xs text-secondary font-label-caps text-label-caps">
                  <span className="w-2 h-2 rounded-full bg-secondary animate-pulse" />
                  EN VIVO
                </div>
              )}
            </div>

            {localDomains.length === 0 ? (
              <div className="flex-1 flex items-center justify-center text-on-surface-variant p-xl">
                <div className="text-center">
                  <svg className="w-12 h-12 mx-auto mb-sm opacity-20" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
                  </svg>
                  <p className="font-body-md">Ingresa los dominios en el panel izquierdo</p>
                </div>
              </div>
            ) : (
              <div className="flex-1 overflow-auto">
                <table className="w-full border-collapse">
                  <thead className="sticky top-0 bg-surface-container-low">
                    <tr className="text-left border-b border-outline-variant">
                      <th className="px-md py-sm font-label-caps text-label-caps text-outline uppercase">Dominio</th>
                      <th className="px-md py-sm font-label-caps text-label-caps text-outline uppercase">Estado</th>
                      <th className="px-md py-sm font-label-caps text-label-caps text-outline uppercase">Detalle</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-outline-variant/30">
                    {localDomains.map(domain => {
                      const result = state?.results?.find((r: any) => r.domain === domain);
                      const isCurrent = state?.currentDomain === domain;
                      const status = result?.status;

                      const dotClass =
                        status === 'success' ? 'status-dot--success' :
                        status === 'error' ? 'status-dot--error' :
                        status === 'processing' ? 'status-dot--running' :
                        isCurrent ? 'status-dot--running' :
                        'status-dot--pending';

                      const statusLabel =
                        status === 'success' ? 'Sincronizado' :
                        status === 'error' ? 'Error' :
                        status === 'processing' || isCurrent ? 'Sincronizando...' :
                        'Pendiente';

                      const labelColor =
                        status === 'success' ? 'text-green-400' :
                        status === 'error' ? 'text-error' :
                        status === 'processing' || isCurrent ? 'text-secondary' :
                        'text-outline';

                      const nameserversMatch = result?.message?.match(/Configura en tu registrador: (.*)/);
                      const nameservers = nameserversMatch ? nameserversMatch[1].split(', ') : [];

                      return (
                        <Fragment key={domain}>
                          <tr
                            className={`hover:bg-surface-container-high transition-colors cursor-pointer ${isCurrent ? 'bg-secondary-container/5' : ''} ${expandedDomain === domain ? 'bg-surface-container-high' : ''}`}
                            onClick={() => setExpandedDomain(expandedDomain === domain ? null : domain)}
                          >
                            <td className="px-md py-sm font-code-md text-code-md text-on-surface">{domain}</td>
                            <td className="px-md py-sm">
                              <div className="flex items-center gap-sm">
                                <div className={`status-dot ${dotClass}`} />
                                <span className={`font-label-caps text-label-caps ${labelColor}`}>{statusLabel}</span>
                              </div>
                            </td>
                            <td className="px-md py-sm font-body-sm text-body-sm text-outline">
                              {status === 'success' && nameservers.length > 0 ? (
                                <span className="text-secondary font-label-caps text-label-caps">
                                  {expandedDomain === domain ? '▲ Ocultar DNS' : '▼ Ver DNS'}
                                </span>
                              ) : (
                                <span className="truncate max-w-[200px] block">{result?.message || (isCurrent ? 'Iniciando...' : '—')}</span>
                              )}
                            </td>
                          </tr>
                          {expandedDomain === domain && nameservers.length > 0 && (
                            <tr>
                              <td colSpan={3} className="p-0 border-0">
                                <div className="bg-surface-container-lowest border-y border-outline-variant p-md space-y-sm">
                                  <p className="font-label-caps text-label-caps text-outline mb-sm">NAMESERVERS — {domain}</p>
                                  <div className="grid grid-cols-1 md:grid-cols-3 gap-sm">
                                    {[{ label: 'Dominio', value: domain }, ...nameservers.map((ns: string, i: number) => ({ label: `DNS ${i + 1}`, value: ns }))].map(({ label, value }) => (
                                      <div
                                        key={label}
                                        className="bg-surface-container p-sm border border-outline-variant rounded flex items-center justify-between group cursor-pointer hover:border-secondary/40 transition-colors"
                                        onClick={() => { navigator.clipboard.writeText(value); toast.success(`${label} copiado`); }}
                                      >
                                        <div>
                                          <p className="font-label-caps text-label-caps text-outline">{label}</p>
                                          <p className="font-code-sm text-code-sm text-secondary">{value}</p>
                                        </div>
                                        <svg className="w-3 h-3 text-outline opacity-0 group-hover:opacity-100 transition-opacity shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                                        </svg>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* ── Integrated Terminal ── */}
        <div className="bg-black border border-outline-variant flex flex-col relative scanline-effect overflow-hidden">
          <div className="bg-surface-container px-md py-xs flex items-center justify-between border-b border-outline-variant shrink-0">
            <div className="flex items-center gap-sm">
              <div className="flex gap-1.5">
                <div className="w-2 h-2 rounded-full bg-error/40" />
                <div className="w-2 h-2 rounded-full bg-tertiary/40" />
                <div className="w-2 h-2 rounded-full bg-green-500/40" />
              </div>
              <span className="font-code-sm text-code-sm text-outline ml-md uppercase tracking-widest">
                syncdns_log@kraken
                {state?.isRunning && <span className="ml-sm text-secondary animate-pulse">● LIVE</span>}
              </span>
            </div>
          </div>

          <div className="p-md font-code-md text-code-md overflow-y-auto max-h-40 space-y-[2px]">
            {(!state?.logs || state.logs.length === 0) ? (
              <p className="text-outline italic">Esperando operaciones...</p>
            ) : (
              state.logs.map((log: any, idx: number) => (
                <p key={idx} className={`flex gap-sm ${
                  log.type === 'error' ? 'text-error' :
                  log.type === 'success' ? 'text-green-400' :
                  log.type === 'warning' ? 'text-tertiary' :
                  'text-on-surface-variant'
                }`}>
                  <span className="shrink-0 text-outline">[{new Date(log.timestamp).toLocaleTimeString()}]</span>
                  <span>{log.message}</span>
                </p>
              ))
            )}
          </div>
        </div>

      </div>
    </div>
  );
}

