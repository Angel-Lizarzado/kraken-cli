import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useIpc } from '../hooks/useIpc';
import { useModuleState } from '../contexts/AppStateContext';

interface BulkResult {
  domain: string;
  status: 'success' | 'error' | 'pending' | 'processing' | 'downloading';
  message: string;
}

// Stepper steps — matched by keywords in extraction:log messages
const EXTRACT_STEPS = [
  { id: 'ssh',       label: 'Conexión SSH a Hostinger',         keyword: '[SSH]' },
  { id: 'detect',    label: 'Detectar ruta WordPress',           keyword: '[FS]' },
  { id: 'compress',  label: 'Comprimir archivos en servidor',    keyword: 'Comprimiendo' },
  { id: 'download',  label: 'Descargar backups a local',         keyword: 'Descargando' },
  { id: 'db',        label: 'Exportar y descargar base de datos', keyword: '[DB]' },
  { id: 'wpconfig',  label: 'Modificar wp-config.php (límites)',  keyword: 'wp-config' },
  { id: 'register',  label: 'Actualizar registro procesados',    keyword: 'registro' },
  { id: 'done',      label: 'Limpieza y finalización',           keyword: '[OK]' },
];

type StepState = 'pending' | 'active' | 'done';

interface ExtractionModuleProps {
  onLog?: (message: string, type: 'info' | 'warning' | 'error' | 'success', moduleId?: string, options?: { replaceLast?: boolean }) => void;
}

const ExtractionModule: React.FC<ExtractionModuleProps> = ({ onLog }) => {
  const { config, runExtractionBatch, progressEvents, getExtractionStatus, getDominiosProcesados } = useIpc();

  const [extState, setExtState] = useModuleState('extraction');
  const [currentDomain, setCurrentDomain] = useState<string>('');
  const [summary, setSummary] = useState<{ total: number; success: number; errors: number } | null>(null);
  const [stepStates, setStepStates] = useState<Record<string, StepState>>(
    () => Object.fromEntries(EXTRACT_STEPS.map(s => [s.id, 'pending']))
  );

  const logsRef = useRef(extState.logs);
  logsRef.current = extState.logs;
  const resultsRef = useRef(extState.results);
  resultsRef.current = extState.results;

  const currentEvent = useMemo(() => {
    if (!currentDomain) return null;
    return progressEvents.find(e => e.domain === currentDomain && e.module === 'extraction') || null;
  }, [progressEvents, currentDomain]);

  const currentStepProgress = currentEvent?.progress ?? 0;
  const currentMessage = currentEvent?.message ?? '';

  // If batch finished (not running + have results), force bar to 100%
  const batchCompleted = !extState.loading && extState.results.length > 0 && extState.progress.current < 100;
  const displayProgress = batchCompleted ? 100 : extState.progress.current;

  // Mount effect: restore extraction state from backend + subscribe to IPC events
  useEffect(() => {
    let api: any = null;
    try {
      api = (window as any).api;
    } catch {
      return;
    }
    if (!api) return;

    // --- Restore state from backend ---
    (async () => {
      try {
        const state = await api.invoke('get-extraction-status');
        const patches: Partial<import('../contexts/AppStateContext').ModuleOperationState> = {};

        if (state.results && state.results.length > 0) {
          patches.results = state.results;
          const okCount = state.results.filter((r: any) => r.status === 'success').length;
          const errCount = state.results.filter((r: any) => r.status === 'error').length;
          setSummary({
            total: state.results.length,
            success: okCount,
            errors: errCount,
          });
        }
        if (state.recentLogs && state.recentLogs.length > 0) {
          patches.logs = state.recentLogs;
        }
        if (state.isRunning) {
          setCurrentDomain(state.currentDomain || '');
          const processedTotal = state.results?.length || 0;
          const progressPct = state.totalDomains > 0
            ? Math.round((processedTotal / state.totalDomains) * 100)
            : state.currentProgress || 0;
          patches.progress = { current: progressPct, total: state.totalDomains || 100 };
          if (state.totalDomains > 0) {
            patches.statusMessage = state.currentDomain
              ? `Extrayendo ${state.currentDomain} (${processedTotal + 1}/${state.totalDomains})...`
              : state.currentMessage || '';
          } else {
            patches.statusMessage = state.currentMessage || '';
          }
          patches.loading = true;
          if (state.batchAccountName) patches.selectedAccount = state.batchAccountName;
          if (state.batchCloudName) patches.selectedCloud = state.batchCloudName;
          setStepStates(prev => ({ ...prev, ssh: 'active' }));
        } else if (state.results && state.results.length > 0 && !state.isRunning) {
          // Batch already finished — show 100% and summary
          patches.progress = { current: 100, total: 100 };
          patches.statusMessage = 'Extracción masiva finalizada';
        }

        if (Object.keys(patches).length > 0) {
          setExtState(patches);
        }
      } catch {
        // No state to restore — first mount
      }
    })();

    // --- Listen for extraction:state-changed ---
    const handleStateChanged = (state: any) => {
      const patches: Partial<import('../contexts/AppStateContext').ModuleOperationState> = {};

      setCurrentDomain(state.isRunning ? (state.currentDomain || '') : '');
      patches.progress = { current: state.currentProgress || 0, total: state.totalDomains || 100 };
      if (state.totalDomains > 0) {
        patches.statusMessage = state.currentDomain
          ? `Extrayendo ${state.currentDomain} (${(state.currentIndex || 0) + 1}/${state.totalDomains})...`
          : state.currentMessage || '';
      } else {
        patches.statusMessage = state.currentMessage || '';
      }
      if (state.results) patches.results = state.results;
      patches.loading = !!state.isRunning;
      if (!state.isRunning && state.results?.length > 0 && state.totalDomains > 0) {
        if (state.results.length >= state.totalDomains) {
          patches.progress = { current: 100, total: state.totalDomains };
        }
      }

      setExtState(patches);
    };

    // --- Listen for extraction:log ---
    const handleExtractionLog = (data: any) => {
      const message = data.message || '';
      const type = data.type || 'info';

      // Buffer de logs: replaceLast para Descargando (evita spam en UI)
      setExtState(prev => ({
        ...prev,
        logs: (() => {
          const prevLogs = prev.logs || [];
          const shouldReplace = message.includes('Descargando') || message.includes('Trasladando') || message.includes('%');
          if (shouldReplace && prevLogs.length > 0) {
            const next = [...prevLogs];
            next[next.length - 1] = { message, type, timestamp: data.timestamp || Date.now() };
            return next;
          }
          const next = [...prevLogs, { message, type, timestamp: data.timestamp || Date.now() }];
          return next.length > 100 ? next.slice(-100) : next;
        })(),
      }));

      // --- Stepper update ---
      setStepStates(prev => {
        const next = { ...prev };
        const matchedIdx = EXTRACT_STEPS.findIndex(s => message.includes(s.keyword));
        if (matchedIdx >= 0) {
          next[EXTRACT_STEPS[matchedIdx].id] = 'done';
          for (let i = 0; i < matchedIdx; i++) {
            next[EXTRACT_STEPS[i].id] = 'done';
          }
          if (matchedIdx + 1 < EXTRACT_STEPS.length) {
            const nextStepId = EXTRACT_STEPS[matchedIdx + 1].id;
            if (next[nextStepId] === 'pending') {
              next[nextStepId] = 'active';
            }
          }
        }
        return next;
      });

      // Forward legacy — ya no pinta en Layout, pero se mantiene por si algún módulo lo escucha
      if (onLog) {
        const shouldReplace = message.includes('Descargando') || message.includes('Trasladando') || message.includes('%');
        onLog(message, type, 'extraction', shouldReplace ? { replaceLast: true } : undefined);
      }
    };

    const handleDomainResult = (data: { module: string; domain: string; status: string; message: string }) => {
      if (data.module !== 'EXTRACT') return;
      setExtState(prev => ({
        ...prev,
        results: (prev.results || []).map(item =>
          item.domain === data.domain
            ? { domain: data.domain, status: data.status as any, message: data.message }
            : item
        ),
      }));
    };

    api.receive('extraction:state-changed', handleStateChanged);
    api.receive('extraction:log', handleExtractionLog);
    api.receive('domain-process-result', handleDomainResult);

    return () => {
      if (api) {
        api.removeAllListeners('extraction:state-changed');
        api.removeAllListeners('extraction:log');
        api.removeAllListeners('domain-process-result');
      }
    };
  }, [onLog, getExtractionStatus, setExtState]);

  // Mostrar TODAS las cuentas que existen en config, incluso si originClouds está vacío (workspace:scan puede no poblarlo)
  const accountsWithClouds = useMemo(() =>
    config?.accounts?.filter(account => account && account.name) || [],
    [config]
  );

  const clouds = useMemo(() => extState.selectedAccount
    ? config?.accounts.find(acc => acc.name === extState.selectedAccount)?.originClouds || []
    : [], [config, extState.selectedAccount]);

  const linkedClouds = useMemo(() => clouds.filter(cloud => cloud.isLinked), [clouds]);

  const domains = extState.domainList.split('\n').map(d => d.trim()).filter(d => d.length > 0);

  const handleAccountChange = useCallback((accountName: string) => {
    setExtState(prev => ({ ...prev, selectedAccount: accountName, selectedCloud: '', results: [] }));
  }, [setExtState]);

  const handleCloudChange = useCallback(
    async (cloudName: string) => {
      setExtState(prev => ({ ...prev, selectedCloud: cloudName, results: [] }));

      if (!cloudName) {
        setExtState(prev => ({ ...prev, domainList: '' }));
        return;
      }

      if (extState.selectedAccount) {
        try {
          const result = await getDominiosProcesados(extState.selectedAccount, cloudName);
          if (result.success && Array.isArray(result.dominios)) {
            const domainsText = result.dominios
              .map((d: unknown) => {
                if (typeof d === 'object' && d !== null && 'dominio' in d) {
                  const dom = (d as Record<string, unknown>).dominio;
                  return typeof dom === 'string' ? dom : '';
                }
                return '';
              })
              .filter((d): d is string => d.length > 0)
              .join('\n');

            setExtState(prev => {
              if (prev.selectedAccount === extState.selectedAccount && prev.selectedCloud === cloudName) {
                return { ...prev, domainList: domainsText };
              }
              return prev;
            });
          }
        } catch (error) {
          console.error('Error al obtener dominios procesados:', error);
        }
      }
    },
    [extState.selectedAccount, getDominiosProcesados, setExtState]
  );

  const handleExtract = useCallback(async () => {
    if (!extState.selectedAccount || !extState.selectedCloud || domains.length === 0) return;

    const selectedCloudObj = clouds.find(c => c.name === extState.selectedCloud);
    if (!selectedCloudObj?.isLinked) return;

    setExtState(prev => ({
      ...prev,
      loading: true,
      results: domains.map(d => ({ domain: d, status: 'pending' as const, message: 'En cola...' })),
      progress: { current: 0, total: 100 },
      statusMessage: `Iniciando extracción masiva (${domains.length} dominio(s))...`,
    }));
    setSummary(null);
    setCurrentDomain(domains[0]);
    setStepStates(Object.fromEntries(EXTRACT_STEPS.map((s, i) => [s.id, i === 0 ? 'active' : 'pending'])));
    if (onLog) onLog(`Iniciando extracción masiva: ${domains.length} dominio(s)`, 'info', 'extraction', { replaceLast: true });

    try {
      const result = await runExtractionBatch(extState.selectedAccount, extState.selectedCloud, domains);

      if (result.success) {
        const batchResults = result.results || [];
        const okCount = batchResults.filter((r: any) => r.success).length;
        const errCount = batchResults.filter((r: any) => !r.success).length;
        setSummary({ total: batchResults.length, success: okCount, errors: errCount });

        // Per-domain results ya vienen por domain-process-result en tiempo real.
        // Solo actualizamos progress y statusMessage final.
        setExtState(prev => ({
          ...prev,
          progress: { current: 100, total: 100 },
          statusMessage: `Extracción masiva finalizada: ${okCount} ok, ${errCount} errores (${batchResults.length} total)`,
        }));
      } else {
        setExtState(prev => ({ ...prev, statusMessage: `Error: ${result.error || 'Error desconocido'}` }));
      }
    } catch (error: any) {
      setExtState(prev => ({ ...prev, statusMessage: `Error crítico: ${error.message}` }));
    } finally {
      setCurrentDomain('');
      setExtState(prev => {
        const cleanResults = (prev.results || []).map((r: any) => 
          r.status === 'processing' ? { ...r, status: 'error', message: 'Cancelado/Fallido' } : r
        );
        return { ...prev, loading: false, results: cleanResults };
      });
    }
  }, [extState.selectedAccount, extState.selectedCloud, domains, clouds, runExtractionBatch, onLog, setExtState]);

  const canExtract = extState.selectedAccount && extState.selectedCloud && domains.length > 0 && !extState.loading;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-xl font-bold">Extracción</h1>
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Fase 1: Backup y extracción desde Hostinger</p>
      </div>

      {/* Configuración */}
      <div className="card p-5">
        <h2 className="font-display text-base font-bold mb-4">Configuración</h2>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Cuenta</label>
            <select
              value={extState.selectedAccount}
              onChange={e => handleAccountChange(e.target.value)}
              className="input"
              disabled={extState.loading}
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
            <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Cloud origen (Hostinger)</label>
            <select
              value={extState.selectedCloud}
              onChange={e => handleCloudChange(e.target.value)}
              className="input"
              disabled={!extState.selectedAccount || extState.loading}
            >
              <option value="">Seleccionar cloud</option>
              {clouds.map(cloud => (
                <option key={cloud.name} value={cloud.name}>
                  {cloud.name} {cloud.isLinked ? '(SSH OK)' : '(SSH pendiente)'}
                </option>
              ))}
            </select>
            {extState.selectedCloud && !linkedClouds.find(c => c.name === extState.selectedCloud) && (
              <div className="mt-1.5 text-xs" style={{ color: 'var(--color-warning)' }}>
                Este cloud no tiene SSH vinculado. Vincúlelo desde el Panel primero.
              </div>
            )}
          </div>

          <div className="md:col-span-2">
            <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
              Dominios a extraer
              {domains.length > 0 && (
                <span className="ml-2 font-mono text-xs" style={{ color: 'var(--text-muted)' }}>
                  ({domains.length} dominio{domains.length !== 1 ? 's' : ''})
                </span>
              )}
            </label>
            <textarea
              value={extState.domainList}
              onChange={e => setExtState(prev => ({ ...prev, domainList: e.target.value }))}
              placeholder={"ejemplo.com\notro-dominio.net\nmipagina.org"}
              className="input"
              rows={6}
              disabled={extState.loading}
              style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8125rem', resize: 'vertical', minHeight: '6rem' }}
            />
            <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
              Ingrese un dominio por línea, tal como aparece en Hostinger (sin http://)
            </p>
          </div>
        </div>
      </div>

      {/* Progreso */}
      {(extState.loading || extState.progress.current > 0) && (
        <div className="card p-5">
          <h2 className="font-display text-base font-bold mb-4">Progreso de extracción masiva</h2>
          <div className="space-y-3">
            <div>
              <div className="flex justify-between text-xs mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                <span>{extState.statusMessage}</span>
                <span className="font-mono">{displayProgress}%</span>
              </div>
              <div className="bar">
                <div className="bar__fill bar__fill--accent" style={{ width: `${displayProgress}%` }} />
              </div>
            </div>
            {extState.loading && currentDomain && (
              <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                <span className="spinner" />
                <span>Extrayendo: <span className="font-mono" style={{ color: 'var(--text-secondary)' }}>{currentDomain}</span></span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Resultados */}
      {extState.results.length > 0 && (
        <div className="card p-5">
          <h2 className="font-display text-base font-bold mb-4">Resultados</h2>

          {/* Summary badge */}
          {summary && (
            <div
              className="flex items-center gap-3 px-4 py-3 rounded-md mb-4 text-sm"
              style={{
                backgroundColor: summary.errors === 0
                  ? 'oklch(0.5 0.15 150 / 0.1)'
                  : summary.success > 0
                    ? 'oklch(0.5 0.12 80 / 0.1)'
                    : 'oklch(0.45 0.18 25 / 0.1)',
                color: summary.errors === 0
                  ? 'var(--color-success)'
                  : summary.success > 0
                    ? 'var(--color-warning)'
                    : 'var(--color-error)',
              }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                {summary.errors === 0 ? (
                  <polyline points="20 6 9 17 4 12" />
                ) : (
                  <>
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </>
                )}
              </svg>
              <span className="font-medium">
                {summary.errors === 0
                  ? `Todo correcto — ${summary.success}/${summary.total} dominios extraídos exitosamente`
                  : `${summary.errors}/${summary.total} dominio(s) con errores — ${summary.success} exitosos`
                }
              </span>
            </div>
          )}

          <div className="space-y-1 max-h-60 overflow-y-auto scrollbar-thin">
            {extState.results.map((r, i) => {
              const isSuccess = r.status === 'success';
              const isError = r.status === 'error';
              const isProcessing = r.status === 'processing' || r.status === 'downloading';
              const isPending = r.status === 'pending';

              let bgColor = 'oklch(0.5 0 0 / 0.02)';
              let textColor = 'var(--text-muted)';
              
              if (isSuccess) {
                bgColor = 'oklch(0.5 0.15 150 / 0.08)';
                textColor = 'var(--color-success)';
              } else if (isError) {
                bgColor = 'oklch(0.45 0.18 25 / 0.1)';
                textColor = 'var(--color-error)';
              } else if (isProcessing) {
                bgColor = 'oklch(0.6 0.12 200 / 0.08)'; // Light blue
                textColor = 'var(--color-info)'; // info color (blue/cyan)
              }

              return (
                <div
                  key={i}
                  className="flex items-center gap-3 py-2 px-3 rounded-md text-xs"
                  style={{ backgroundColor: bgColor }}
                >
                  {isProcessing && <span className="spinner" style={{ width: 12, height: 12, borderWidth: 1.5, flexShrink: 0 }} />}
                  {isSuccess && (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--color-success)', flexShrink: 0 }}>
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                  {isError && (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--color-error)', flexShrink: 0 }}>
                      <circle cx="12" cy="12" r="10" />
                      <line x1="15" y1="9" x2="9" y2="15" />
                      <line x1="9" y1="9" x2="15" y2="15" />
                    </svg>
                  )}
                  {isPending && (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--text-muted)', flexShrink: 0 }}>
                      <circle cx="12" cy="12" r="10" />
                      <line x1="12" y1="8" x2="12" y2="12" />
                      <line x1="12" y1="16" x2="12.01" y2="16" />
                    </svg>
                  )}
                  <span className="font-mono font-medium" style={{ color: 'var(--text-secondary)' }}>{r.domain}</span>
                  <span style={{ color: textColor }}>{r.message}</span>
                </div>
              );
            })}
          </div>
          <div className="mt-3 pt-3 border-t flex gap-4 text-xs" style={{ borderTopColor: 'var(--border-default)', color: 'var(--text-muted)' }}>
            <span>Total: {extState.results.length}</span>
            <span style={{ color: 'var(--color-success)' }}>Exitosos: {extState.results.filter(r => r.status === 'success').length}</span>
            <span style={{ color: 'var(--color-error)' }}>Fallidos: {extState.results.filter(r => r.status === 'error').length}</span>
          </div>
        </div>
      )}

      {/* Terminal / Registro de Logs */}
      {extState.logs.length > 0 && (
        <div className="card p-5">
          <h2 className="font-display text-base font-bold mb-4">Registro de operaciones</h2>
          <div
            className="max-h-48 overflow-y-auto scrollbar-thin rounded-md p-3 text-xs font-mono leading-relaxed"
            style={{ backgroundColor: 'oklch(0.15 0 0)', color: 'oklch(0.7 0 0)' }}
          >
            {extState.logs.map((log, i) => {
              const ts = log.timestamp
                ? new Date(log.timestamp).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
                : '';
              return (
                <div
                  key={i}
                  className="flex gap-2"
                  style={{
                    color: log.type === 'error' ? 'var(--color-error)' :
                           log.type === 'success' ? 'var(--color-success)' :
                           log.type === 'warning' ? 'var(--color-warning)' :
                           'oklch(0.7 0 0)'
                  }}
                >
                  {ts && <span className="shrink-0" style={{ color: 'oklch(0.5 0 0)' }}>{ts}</span>}
                  <span>{log.message}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Acción */}
      <div className="card p-5">
        <h2 className="font-display text-base font-bold mb-4">Acciones</h2>
        <div className="flex flex-col md:flex-row gap-4">
          <button
            onClick={handleExtract}
            disabled={!canExtract}
            className="btn btn--primary"
          >
            {extState.loading ? (
              <span className="flex items-center gap-2">
                <span className="spinner" />
                Extrayendo...
              </span>
            ) : (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="21 16 21 8 14 2 3 2 3 22 10 22" />
                  <line x1="17" y1="16" x2="17" y2="22" />
                  <line x1="13" y1="20" x2="21" y2="20" />
                </svg>
                Iniciar extracción ({domains.length > 0 ? `${domains.length} dominio${domains.length !== 1 ? 's' : ''}` : ''})
              </>
            )}
          </button>
        </div>
        {extState.statusMessage && (
          <p className="mt-3 text-xs" style={{ color: 'var(--text-muted)' }}>{extState.statusMessage}</p>
        )}
      </div>
    </div>
  );
};

export default ExtractionModule;
