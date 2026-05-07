import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useModuleState } from '../contexts/AppStateContext';
import { useIpc } from '../hooks/useIpc';

// 🔥 v1.8.3: Parseador de errores SSL a mensajes humanos
function formatSslError(rawLog: string): { friendly: string; detail: string } {
  const lower = rawLog.toLowerCase();
  if (lower.includes('aaaa record')) {
    return {
      friendly: 'Conflicto de IPv6 detectado (Cloudflare Edge)',
      detail: rawLog,
    };
  }
  if (lower.includes('404') && (lower.includes('acme') || lower.includes('challenge'))) {
    return {
      friendly: 'El servidor no respondió al reto de validación (Propagación pendiente)',
      detail: rawLog,
    };
  }
  if (lower.includes('ratelimited') || lower.includes('rate limit') || lower.includes('too many')) {
    return {
      friendly: '⏳ Límite de Let\'s Encrypt alcanzado. Reintentar en 24h.',
      detail: rawLog,
    };
  }
  return { friendly: rawLog, detail: rawLog };
}

interface SyncResult {
  domain: string;
  status: 'pending' | 'processing' | 'success' | 'error';
  message: string;
}

interface SslModuleProps {
  onLog?: (message: string, type: 'info' | 'warning' | 'error' | 'success', moduleId?: string, options?: { replaceLast?: boolean }) => void;
}

const SslModule: React.FC<SslModuleProps> = ({ onLog }) => {
  const { config, installBulkSsl, getDominiosProcesados } = useIpc();

  const [sslState, setSslState] = useModuleState('ssl');
  const [targetServer, setTargetServer] = useState<string>('');
  // 🔥 v1.8.2: dominio cuyo detalle técnico está expandido
  const [expandedDetail, setExpandedDetail] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const userScrolledUpRef = useRef(false);
  const resultsRef = useRef(sslState.results);
  resultsRef.current = sslState.results;
  const progressRef = useRef(sslState.progress);
  progressRef.current = sslState.progress;

  // Mount effect: restore SSL state from backend (survives tab switches)
  useEffect(() => {
    let api: any;
    try {
      api = (window as any).api;
    } catch { return; }
    if (!api) return;

    (async () => {
      try {
        const state = await api.invoke('get-ssl-status');
        if (state.results && state.results.length > 0) {
          setSslState({ results: state.results });
          const okCount = state.results.filter((r: any) => r.status === 'success').length;
          const errCount = state.results.filter((r: any) => r.status === 'error').length;
          setSslState({ statusMessage: `SSL previo: ${okCount} ok, ${errCount} errores` });
        }
        if (state.isRunning) {
          setSslState({ loading: true });
          const processedTotal = state.results?.length || 0;
          const progressPct = state.totalDomains > 0
            ? Math.round((processedTotal / state.totalDomains) * 100)
            : state.currentProgress || 0;
          setSslState({ progress: { current: progressPct, total: state.totalDomains || 100 } });
          setSslState({ statusMessage: state.currentMessage || '' });
        } else if (state.results && state.results.length > 0 && !state.isRunning) {
          setSslState({ progress: { current: 100, total: 100 } });
        }
      } catch {
        // First mount — no state to restore
      }
    })();

    // No cleanup that kills processes — INMORTALES
    return () => {
      // Only remove IPC listeners, never cancel backend work
    };
  }, []);

  // Autoload: when sourceCloud changes, fetch dominios_procesados.json and fill the TextArea
  useEffect(() => {
    if (!sslState.selectedAccount || !sslState.selectedCloud) {
      setSslState({ domainList: '' });
      return;
    }

    // NO sobreescribir si el usuario aplicó un filtro manual
    if (sslState.filterApplied) return;

    let cancelled = false;
    const loadDominios = async () => {
      setSslState({ loading: true });
      try {
        const result = await getDominiosProcesados(sslState.selectedAccount, sslState.selectedCloud);
        if (cancelled) return;
        console.log('[SSL AUTOLOAD] account:', sslState.selectedAccount, '| cloud:', sslState.selectedCloud, '| result:', result);
        if (result.success && result.dominios && result.dominios.length > 0) {
          const dominios = result.dominios.map((d: any) => d.dominio || d.name || d).filter(Boolean);
          setSslState({ domainList: dominios.join('\n') });
          if (onLog) onLog(`Dominios cargados: ${dominios.length} dominio(s) desde ${sslState.selectedCloud}`, 'info', 'ssl');
        } else {
          setSslState({ domainList: '' });
          // 🔥 HOTFIX v1.5.6: mostrar ruta exacta del JSON en el log
          const pathInfo = (result as any)._sourcePath ? ` | ruta: ${(result as any)._sourcePath}` : '';
          console.log('[SSL AUTOLOAD] sin dominios — motivo:', !result.success ? 'error backend' : 'ninguno encontrado', '| _sourcePath:', (result as any)._sourcePath, '| _fileExists:', (result as any)._fileExists);
          if (onLog) onLog(`No se encontraron dominios procesados para ${sslState.selectedCloud}${pathInfo}`, 'warning', 'ssl');
        }
      } catch (error: any) {
        if (!cancelled) setSslState({ domainList: '' });
        console.error('[SSL AUTOLOAD] error:', error);
        if (onLog) onLog(`Error al cargar dominios procesados: ${error.message}`, 'error', 'ssl');
      } finally {
        if (!cancelled) setSslState({ loading: false });
      }
    };

    loadDominios();
    return () => { cancelled = true; };
  }, [sslState.selectedAccount, sslState.selectedCloud, getDominiosProcesados, onLog, setSslState]);

  const accountsWithClouds = config?.accounts?.filter(account =>
    account.originClouds && account.originClouds.length > 0
  ) || [];

  const clouds = useMemo(() => sslState.selectedAccount
    ? config?.accounts.find(acc => acc.name === sslState.selectedAccount)?.originClouds || []
    : [], [config, sslState.selectedAccount]);

  const linkedClouds = useMemo(() => clouds.filter(cloud => cloud.isLinked), [clouds]);

  // 🔥 HOTFIX v1.5.4: filtrar servidor 'Global' (no se debe mostrar nunca más)
  const allPleskServers = useMemo(() =>
    (config?.destinationServers || []).filter(s => s.name !== 'Global'),
  [config]);

  const domains = sslState.domainList.split('\n').map(d => d.trim()).filter(d => d.length > 0);

  const handleSourceAccountChange = useCallback((accountName: string) => {
    setSslState({ selectedAccount: accountName, selectedCloud: '', results: [], filterApplied: false });
  }, [setSslState]);

  const handleSourceCloudChange = useCallback((cloudName: string) => {
    setSslState({ selectedCloud: cloudName, results: [], filterApplied: false });
  }, [setSslState]);

  // Subscribe to SSL IPC events for real-time status
  useEffect(() => {
    let api: any;
    try {
      api = (window as any).api;
    } catch { return; }
    if (!api) return;

    const handleLog = (data: any) => {
      if (onLog) onLog(data.message || '', data.type || 'info', 'ssl', { replaceLast: data.replaceLast });
    };
    const handleStateChanged = (data: any) => {
      if (data?.message) {
        setSslState({ statusMessage: data.message });
        if (onLog) onLog(data.message, 'info', 'ssl', { replaceLast: true });
      }
    };

    api.receive('ssl:log', handleLog);
    api.receive('ssl:state-changed', handleStateChanged);

    const handleDomainStart = (data: { phase: string; domain: string }) => {
      if (data.phase !== 'ssl') return;
      const current = resultsRef.current;
      setSslState({
        results: current.map(r =>
          r.domain === data.domain
            ? { domain: data.domain, status: 'processing' as const, message: 'Sincronizando...' }
            : r
        ),
      });
      // NO incrementar contador aquí
    };

    const handleDomainProgress = (data: { phase: string; domain: string; status: string; message: string }) => {
      if (data.phase !== 'ssl') return;
      const current = resultsRef.current;
      const updatedResults = current.map(r =>
        r.domain === data.domain
          ? { domain: data.domain, status: data.status as SyncResult['status'], message: data.message }
          : r
      );
      // ÚNICO lugar donde se incrementa el contador — use progressRef to avoid stale closure
      const nextProgress = { current: progressRef.current.current + 1, total: progressRef.current.total };
      setSslState({ results: updatedResults, progress: nextProgress });
    };

    api.receive('sync:domain-start', handleDomainStart);
    api.receive('sync:domain-progress', handleDomainProgress);

    const handleSyncCompleted = (data: { success: boolean; finished?: boolean; error?: string }) => {
      setSslState({ loading: false });
      if (data.success) {
        const okCount = resultsRef.current.filter(r => r.status === 'success').length;
        const errCount = resultsRef.current.filter(r => r.status === 'error').length;
        const total = resultsRef.current.length;
        setSslState({ statusMessage: `SSL finalizado: ${okCount} exitosos, ${errCount} errores (${total} total)` });
        if (onLog) onLog(`Instalación SSL finalizada: ${okCount} exitosos, ${errCount} errores`, 'success', 'ssl');
      } else {
        setSslState({ statusMessage: `Error: ${data.error ?? 'Error desconocido'}` });
        if (onLog) onLog(`Error en instalación SSL: ${data.error ?? 'Error desconocido'}`, 'error', 'ssl');
      }
    };

    const handleSslSyncError = (data: { error: string }) => {
      setSslState({ loading: false });
      setSslState({ statusMessage: `Error: ${data.error}` });
      if (onLog) onLog(`Error al iniciar SSL: ${data.error}`, 'error', 'ssl');
    };
    api.receive('ssl:sync-completed', handleSyncCompleted);
    api.receive('ssl:sync-error', handleSslSyncError);
    const handleDomainProcessResult = (data: any) => {
      if (data.module !== 'SSL') return;
      setSslState({
        results: (resultsRef.current || []).map((r: any) =>
          r.domain === data.domain
            ? { domain: data.domain, status: data.status, message: data.message }
            : r
        ),
      });
    };
    api.receive('domain-process-result', handleDomainProcessResult);

    return () => {
      api.removeListener('ssl:log', handleLog);
      api.removeListener('ssl:state-changed', handleStateChanged);
      api.removeListener('sync:domain-start', handleDomainStart);
      api.removeListener('sync:domain-progress', handleDomainProgress);
      api.removeListener('ssl:sync-completed', handleSyncCompleted);
      api.removeListener('ssl:sync-error', handleSslSyncError);
      api.removeListener('domain-process-result', handleDomainProcessResult);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onLog, setSslState]);

  // 🔥 v1.8.3: Filtrar dominios success + persistencia de estado
  const handleSslAll = useCallback(() => {
    // Solo procesar dominios con status 'pending' o 'error' (saltar los 'success')
    const resultsMap = new Map(sslState.results.map(r => [r.domain, r]));
    const filteredDomains = domains.filter(d => {
      const existing = resultsMap.get(d);
      return !existing || existing.status !== 'success';
    });

    if (filteredDomains.length === 0) {
      const msg = 'Todos los dominios ya tienen SSL exitoso. No hay nada que procesar.';
      setSslState({ statusMessage: msg });
      if (onLog) onLog(msg, 'info', 'ssl');
      return;
    }
    if (!targetServer) {
      const msg = 'Seleccione un servidor Plesk destino antes de iniciar';
      setSslState({ statusMessage: msg });
      if (onLog) onLog(msg, 'warning', 'ssl');
      return;
    }

    const skippedCount = domains.length - filteredDomains.length;
    setSslState({ loading: true });
    // Pre-poblar solo los dominios a procesar en 'pending'
    const pendingResults: SyncResult[] = filteredDomains.map(d => ({ domain: d, status: 'pending' as const, message: '' }));
    setSslState({ results: pendingResults, progress: { current: 0, total: filteredDomains.length } });
    userScrolledUpRef.current = false;
    const skipMsg = skippedCount > 0 ? ` (${skippedCount} omitidos por SSL existente)` : '';
    setSslState({ statusMessage: `Solicitando Let's Encrypt SSL para ${filteredDomains.length} dominio(s)...` });
    if (onLog) onLog(`Iniciando solicitud SSL: ${filteredDomains.length} dominio(s) → ${targetServer}${skipMsg}`, 'info', 'ssl', { replaceLast: true });

    // Fire-and-forget: resultados via sync:domain-progress + state:update + ssl:sync-completed
    installBulkSsl(
      sslState.selectedAccount,
      targetServer,
      filteredDomains,
      { email: 'clinmediadev@gmail.com' }
    );
  }, [domains, sslState.results, sslState.selectedAccount, targetServer, installBulkSsl, onLog, setSslState]);

  // Smart scroll: auto-scroll solo si el usuario está cerca del fondo
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (!userScrolledUpRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [sslState.results]);

  const canRequestSsl = domains.length > 0 && !!targetServer && !sslState.loading;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-xl font-bold">SSL</h1>
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Fase 3.5: Certificados Let's Encrypt SSL</p>
      </div>

      {/* Configuración */}
      <div className="card p-5">
        <h2 className="font-display text-base font-bold mb-4">Configuración</h2>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Cuenta origen</label>
            <select
              value={sslState.selectedAccount}
              onChange={e => handleSourceAccountChange(e.target.value)}
              className="input"
            >
              <option value="">Seleccionar cuenta origen</option>
              {accountsWithClouds.map(account => (
                <option key={account.name} value={account.name}>
                  {account.name} ({account.originClouds?.length || 0} clouds)
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Cloud origen (Hostinger)</label>
            <select
              value={sslState.selectedCloud}
              onChange={e => handleSourceCloudChange(e.target.value)}
              className="input"
              disabled={!sslState.selectedAccount}
            >
              <option value="">Seleccionar cloud</option>
              {clouds.map(cloud => (
                <option key={cloud.name} value={cloud.name}>
                  {cloud.name} {cloud.isLinked ? '(SSH OK)' : '(SSH pendiente)'}
                </option>
              ))}
            </select>
            {sslState.selectedCloud && !linkedClouds.find(c => c.name === sslState.selectedCloud) && (
              <div className="mt-1.5 text-xs" style={{ color: 'var(--color-warning)' }}>
                Este cloud no tiene SSH vinculado. Vincúlelo desde el Panel primero.
              </div>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Servidor Plesk (Destino)</label>
            <select
              value={targetServer}
              onChange={e => setTargetServer(e.target.value)}
              className="input"
            >
              <option value="">Seleccionar servidor destino</option>
              {allPleskServers.map(server => (
                <option key={server.name} value={server.name}>
                  {server.name}
                </option>
              ))}
            </select>
            {allPleskServers.length === 0 && (
              <div className="mt-1.5 text-xs" style={{ color: 'var(--color-warning)' }}>
                No hay servidores configurados. Configure uno desde el Panel primero.
              </div>
            )}
          </div>

          <div className="md:col-span-2">
            <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
              Dominios
              {domains.length > 0 && (
                <span className="ml-2 font-mono text-xs" style={{ color: 'var(--text-muted)' }}>
                  ({domains.length} dominio{domains.length !== 1 ? 's' : ''})
                </span>
              )}
              {sslState.loading && sslState.results.length === 0 && (
                <span className="ml-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                  <span className="spinner" style={{ display: 'inline-block', width: 10, height: 10, borderWidth: 1.5, marginRight: 4 }} />
                  Cargando...
                </span>
              )}
            </label>
            <textarea
              value={sslState.domainList}
              onChange={e => setSslState({ domainList: e.target.value, filterApplied: true })}
              placeholder={"ejemplo.com\notro-dominio.net\nmipagina.org"}
              className="input"
              rows={6}
              style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8125rem', resize: 'vertical', minHeight: '6rem' }}
            />
            <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
              Se cargan automáticamente los dominios extraídos al seleccionar el cloud. Puede editar la lista manualmente.
            </p>
          </div>
        </div>
      </div>

      {/* Resultados SSL */}
      {sslState.results.length > 0 && (
        <div className="card p-5">
          <h2 className="font-display text-base font-bold mb-4">Resultados SSL</h2>
          <div
            ref={scrollRef}
            onScroll={() => {
              const el = scrollRef.current;
              if (!el) return;
              const threshold = 30;
              const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
              userScrolledUpRef.current = !isNearBottom;
            }}
            className="space-y-1 max-h-60 overflow-y-auto scrollbar-thin"
          >
            {sslState.results.map((r, i) => (
              <div
                key={i}
                className={`flex items-center gap-3 py-2 px-3 rounded-md text-xs ${r.status === 'processing' ? 'animate-pulse-slow' : ''}`}
                style={{
                  backgroundColor:
                    r.status === 'pending' ? 'oklch(0.5 0 0 / 0.04)' :
                    r.status === 'processing' ? 'oklch(0.5 0.1 220 / 0.08)' :
                    r.status === 'success' ? 'oklch(0.5 0.15 150 / 0.08)' :
                    'oklch(0.45 0.18 25 / 0.1)',
                  opacity: r.status === 'pending' ? 0.5 : 1,
                }}
              >
                {/* Pending icon */}
                {r.status === 'pending' && (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                    strokeLinecap="round" strokeLinejoin="round"
                    style={{ color: 'var(--text-muted)', flexShrink: 0 }}
                  >
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                )}
                {/* Processing icon */}
                {r.status === 'processing' && (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                    strokeLinecap="round" strokeLinejoin="round" className="animate-spin"
                    style={{ color: 'var(--color-info)', flexShrink: 0 }}
                  >
                    <line x1="12" y1="2" x2="12" y2="6" />
                    <line x1="12" y1="18" x2="12" y2="22" />
                    <line x1="4.93" y1="4.93" x2="7.76" y2="7.76" />
                    <line x1="16.24" y1="16.24" x2="19.07" y2="19.07" />
                    <line x1="2" y1="12" x2="6" y2="12" />
                    <line x1="18" y1="12" x2="22" y2="12" />
                    <line x1="4.93" y1="19.07" x2="7.76" y2="16.24" />
                    <line x1="16.24" y1="7.76" x2="19.07" y2="4.93" />
                  </svg>
                )}
                {/* Success icon */}
                {r.status === 'success' && (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                    strokeLinecap="round" strokeLinejoin="round"
                    style={{ color: 'var(--color-success)', flexShrink: 0 }}
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
                {/* Error icon */}
                {r.status === 'error' && (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                    strokeLinecap="round" strokeLinejoin="round"
                    style={{ color: 'var(--color-error)', flexShrink: 0 }}
                  >
                    <circle cx="12" cy="12" r="10" />
                    <line x1="15" y1="9" x2="9" y2="15" />
                    <line x1="9" y1="9" x2="15" y2="15" />
                  </svg>
                )}
                <span className="font-mono font-medium" style={{
                  color: r.status === 'pending' ? 'var(--text-muted)' : 'var(--text-secondary)'
                }}>{r.domain}</span>
                {/* 🔥 v1.8.2: mensaje humano + botón de detalle técnico */}
                {r.status === 'error' ? (
                  <div className="flex flex-col gap-1 min-w-0">
                    <span style={{ color: 'var(--color-error)' }}>
                      {formatSslError(r.message || '').friendly}
                    </span>
                    {formatSslError(r.message || '').detail !== formatSslError(r.message || '').friendly && (
                      <button
                        onClick={() => setExpandedDetail(expandedDetail === r.domain ? null : r.domain)}
                        className="text-xs underline opacity-60 hover:opacity-100 text-left"
                        style={{ color: 'var(--text-muted)' }}
                      >
                        {expandedDetail === r.domain ? 'Ocultar detalles técnicos' : 'Ver detalles técnicos'}
                      </button>
                    )}
                    {expandedDetail === r.domain && (
                      <code className="text-xs mt-1 p-2 rounded" style={{
                        backgroundColor: 'oklch(0.3 0 0 / 0.3)',
                        color: 'var(--text-muted)',
                        wordBreak: 'break-all',
                      }}>
                        {formatSslError(r.message || '').detail}
                      </code>
                    )}
                  </div>
                ) : (
                  <span style={{
                    color:
                      r.status === 'pending' ? 'var(--text-muted)' :
                      r.status === 'processing' ? 'var(--color-info)' :
                      r.status === 'success' ? 'var(--color-success)' :
                      'var(--color-error)'
                  }}>{r.message || (r.status === 'pending' ? 'Pendiente' : r.status === 'processing' ? 'Sincronizando...' : '')}</span>
                )}
              </div>
            ))}
          </div>
          <div className="mt-3 pt-3 border-t flex gap-4 text-xs" style={{ borderTopColor: 'var(--border-default)', color: 'var(--text-muted)' }}>
            <span>Total: {sslState.results.length}</span>
            <span style={{ color: 'var(--color-success)' }}>Exitosos: {sslState.results.filter(r => r.status === 'success').length}</span>
            <span style={{ color: 'var(--color-info)' }}>Pendientes: {sslState.results.filter(r => r.status === 'pending' || r.status === 'processing').length}</span>
            <span style={{ color: 'var(--color-error)' }}>Fallidos: {sslState.results.filter(r => r.status === 'error').length}</span>
          </div>
        </div>
      )}

      {/* Acciones */}
      <div className="card p-5">
        <h2 className="font-display text-base font-bold mb-4">Acciones</h2>
        <div className="flex flex-col md:flex-row gap-4">
          <button
            onClick={handleSslAll}
            disabled={!canRequestSsl}
            className="btn btn--primary"
          >
            {sslState.loading ? (
              <span className="flex items-center gap-2">
                <span className="spinner" />
                Solicitando SSL... ({sslState.progress.current} / {sslState.progress.total})
              </span>
            ) : (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
                Solicitar Let's Encrypt SSL
              </>
            )}
          </button>
        </div>
        {sslState.statusMessage && (
          <p className="mt-3 text-xs" style={{ color: 'var(--text-muted)' }}>{sslState.statusMessage}</p>
        )}
      </div>
    </div>
  );
};

export default SslModule;
