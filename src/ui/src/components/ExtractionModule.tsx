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
  logs?: { message: string; type: string; timestamp?: number; source?: string }[];
}

const ExtractionModule: React.FC<ExtractionModuleProps> = ({ onLog }) => {
  const { config, runExtractionBatch, progressEvents, getExtractionStatus, getDominiosProcesados } = useIpc();

  const [extState, setExtState] = useModuleState('extraction');
  const [includeWeb, setIncludeWeb] = useState<boolean>(true);
  const [includeEmails, setIncludeEmails] = useState<boolean>(false); // Desactivado por defecto para descargas (evita lentitud por VPN)
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
      const targetDom = (data.domain || '').trim().toLowerCase();
      setExtState(prev => {
        const currentList = prev.results || [];
        const exists = currentList.some(item => (item.domain || '').trim().toLowerCase() === targetDom);

        let nextResults;
        if (exists) {
          nextResults = currentList.map(item =>
            (item.domain || '').trim().toLowerCase() === targetDom
              ? { domain: data.domain, status: data.status as any, message: data.message }
              : item
          );
        } else {
          nextResults = [...currentList, { domain: data.domain, status: data.status as any, message: data.message }];
        }

        return { ...prev, results: nextResults };
      });
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

  const handleExtractUltraLite = useCallback(async () => {
    if (!extState.selectedAccount || !extState.selectedCloud || domains.length === 0) return;
    const selectedCloudObj = clouds.find(c => c.name === extState.selectedCloud);
    if (!selectedCloudObj?.isLinked) return;

    setExtState(prev => ({
      ...prev,
      loading: true,
      results: domains.map(d => ({ domain: d, status: 'pending' as const, message: 'En cola [Ultra-Lite]...' })),
      progress: { current: 0, total: 100 },
      statusMessage: `Iniciando extracción Ultra-Lite (${domains.length} dominio(s))...`,
    }));
    setSummary(null);
    setCurrentDomain(domains[0]);
    setStepStates(Object.fromEntries(EXTRACT_STEPS.map((s, i) => [s.id, i === 0 ? 'active' : 'pending'])));
    if (onLog) onLog(`Iniciando Ultra-Lite: ${domains.length} dominio(s)`, 'info', 'extraction', { replaceLast: true });

    try {
      const api = (window as any).api;
      if (!api) throw new Error('API no disponible');
      const result = await api.invoke('extraction:extract-ultra-lite', {
        accountName: extState.selectedAccount,
        cloudName: extState.selectedCloud,
        domains,
      }) as any;

      if (result.success) {
        const okCount = result.successCount ?? 0;
        const errCount = result.errors ?? 0;
        setSummary({ total: result.total ?? domains.length, success: okCount, errors: errCount });
        setExtState(prev => ({
          ...prev,
          progress: { current: 100, total: 100 },
          statusMessage: `Ultra-Lite finalizado: ${okCount} ok, ${errCount} errores`,
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
  }, [extState.selectedAccount, extState.selectedCloud, domains, clouds, onLog, setExtState]);

  const handleExtractEmailsOnly = useCallback(async () => {
    if (!extState.selectedAccount || !extState.selectedCloud || domains.length === 0) return;
    const selectedCloudObj = clouds.find(c => c.name === extState.selectedCloud);
    if (!selectedCloudObj?.isLinked) return;

    setExtState(prev => ({
      ...prev,
      loading: true,
      results: domains.map(d => ({ domain: d, status: 'pending' as const, message: 'En cola [Solo Correos]...' })),
      progress: { current: 0, total: 100 },
      statusMessage: `Iniciando descarga de correos (${domains.length} dominio(s))...`,
    }));
    setSummary(null);
    setCurrentDomain(domains[0]);
    if (onLog) onLog(`Iniciando Solo Correos: ${domains.length} dominio(s)`, 'info', 'extraction', { replaceLast: true });

    try {
      const api = (window as any).api;
      if (!api) throw new Error('API no disponible');

      // Pre-verificar token de Hostinger
      const tokenCheck = await api.invoke('email:get-config');
      if (!tokenCheck?.apiToken) {
        const errorMsg = 'No hay Token API de Hostinger Email configurado. Ve a Configuración e ingrésalo.';
        setExtState(prev => ({
          ...prev,
          statusMessage: `Error: ${errorMsg}`,
          results: domains.map(d => ({ domain: d, status: 'error' as const, message: errorMsg })),
        }));
        return;
      }

      const result = await api.invoke('email:download-batch', {
        accountName: extState.selectedAccount,
        cloudName: extState.selectedCloud,
        domains,
      }) as any;

      if (result.success) {
        const okCount = result.successCount ?? 0;
        const errCount = result.errors ?? 0;
        const batchResults = result.results || [];
        const mappedResults = batchResults.map((r: any) => ({
          domain: r.domain,
          status: r.success ? ('success' as const) : ('error' as const),
          message: r.message || r.error || (r.success ? 'Correos descargados' : 'Error'),
        }));

        setSummary({ total: result.total ?? domains.length, success: okCount, errors: errCount });
        setExtState(prev => ({
          ...prev,
          results: mappedResults,
          progress: { current: 100, total: 100 },
          statusMessage: `Descarga de correos finalizada: ${okCount} ok, ${errCount} errores`,
        }));
      } else {
        const errMsg = result.error || 'Error desconocido';
        setExtState(prev => ({
          ...prev,
          statusMessage: `Error: ${errMsg}`,
          results: domains.map(d => ({ domain: d, status: 'error' as const, message: errMsg })),
        }));
      }
    } catch (error: any) {
      const errMsg = error.message || 'Error en ejecución';
      setExtState(prev => ({
        ...prev,
        statusMessage: `Error crítico: ${errMsg}`,
        results: domains.map(d => ({ domain: d, status: 'error' as const, message: errMsg })),
      }));
    } finally {
      setCurrentDomain('');
      setExtState(prev => {
        const cleanResults = (prev.results || []).map((r: any) =>
          r.status === 'processing' ? { ...r, status: 'error', message: 'Cancelado/Fallido' } : r
        );
        return { ...prev, loading: false, results: cleanResults };
      });
    }
  }, [extState.selectedAccount, extState.selectedCloud, domains, clouds, onLog, setExtState]);

  const handleStartExtraction = useCallback(async () => {
    if (!includeWeb && !includeEmails) return;
    if (includeWeb && includeEmails) {
      await handleExtractUltraLite();
      await handleExtractEmailsOnly();
    } else if (includeWeb) {
      await handleExtractUltraLite();
    } else if (includeEmails) {
      await handleExtractEmailsOnly();
    }
  }, [includeWeb, includeEmails, handleExtractUltraLite, handleExtractEmailsOnly]);

  return (
    <div className="flex flex-col h-full bg-background overflow-hidden">

      {/* ── Page Header ── */}
      <div className="flex-none px-lg pt-lg pb-md">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-md">
          <div>
            <h2 className="font-display-lg text-display-lg text-secondary mb-xs">Sistema de Backups</h2>
            <p className="font-body-md text-on-surface-variant max-w-2xl">
              Extracción rápida (Ultra-Lite) y descarga de correos desde Hostinger.
            </p>
          </div>

          <div className="flex items-center gap-md shrink-0">
            {/* Checkboxes estilizados con estética industrial / OLED */}
            <div className="flex items-center gap-xs bg-surface-container-high/90 border border-outline-variant/50 rounded-lg px-md py-1.5 backdrop-blur-sm">
              <label className="flex items-center gap-2 font-label-md text-on-surface hover:text-secondary transition-colors cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={includeWeb}
                  onChange={e => setIncludeWeb(e.target.checked)}
                  className="w-4 h-4 rounded border-outline-variant bg-surface-container text-secondary focus:ring-secondary focus:ring-offset-surface cursor-pointer"
                />
                <span className="font-medium text-xs tracking-wide">Web / DB (Ultra-Lite)</span>
              </label>
              <div className="w-[1px] h-4 bg-outline-variant/40 mx-2" />
              <label className="flex items-center gap-2 font-label-md text-on-surface hover:text-secondary transition-colors cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={includeEmails}
                  onChange={e => setIncludeEmails(e.target.checked)}
                  className="w-4 h-4 rounded border-outline-variant bg-surface-container text-secondary focus:ring-secondary focus:ring-offset-surface cursor-pointer"
                />
                <span className="font-medium text-xs tracking-wide">Correos</span>
              </label>
            </div>

            {/* Botón único de Descarga */}
            <button
              onClick={handleStartExtraction}
              disabled={!canExtract || (!includeWeb && !includeEmails)}
              className={`flex items-center gap-xs px-md py-sm font-title-sm rounded transition-all active:scale-95 ${
                canExtract && (includeWeb || includeEmails)
                  ? 'bg-secondary-container text-on-secondary-container hover:brightness-110'
                  : 'bg-surface-container-highest text-outline cursor-not-allowed'
              }`}
              title="Iniciar descarga según los módulos seleccionados"
            >
              {extState.loading ? (
                <>
                  <span className="spinner text-current" />
                  Descargando...
                </>
              ) : (
                <>
                  <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                  Iniciar Descarga{domains.length > 0 ? ` (${domains.length})` : ''}
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-lg pb-lg space-y-md">

        {/* ── Selection Bar ── */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-md items-end">
          <div className="space-y-xs">
            <label className="font-label-caps text-label-caps text-outline">Cuenta Origen</label>
            <select
              value={extState.selectedAccount}
              onChange={e => handleAccountChange(e.target.value)}
              disabled={extState.loading}
              className="w-full bg-surface-container-high border-b-2 border-outline-variant border-x-0 border-t-0 text-on-surface focus:border-secondary focus:ring-0 font-body-md rounded-t px-sm py-sm disabled:opacity-50"
            >
              <option value="">Seleccionar cuenta</option>
              {accountsWithClouds.map(account => (
                <option key={account.name} value={account.name}>
                  {account.name} ({account.originClouds?.length || 0} clouds)
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-xs">
            <label className="font-label-caps text-label-caps text-outline">Cloud Origen (Hostinger)</label>
            <select
              value={extState.selectedCloud}
              onChange={e => handleCloudChange(e.target.value)}
              disabled={!extState.selectedAccount || extState.loading}
              className="w-full bg-surface-container-high border-b-2 border-outline-variant border-x-0 border-t-0 text-on-surface focus:border-secondary focus:ring-0 font-body-md rounded-t px-sm py-sm disabled:opacity-50"
            >
              <option value="">Seleccionar cloud</option>
              {clouds.map(cloud => (
                <option key={cloud.name} value={cloud.name}>
                  {cloud.name} {cloud.isLinked ? '(SSH OK)' : '(SSH pendiente)'}
                </option>
              ))}
            </select>
            {extState.selectedCloud && !linkedClouds.find(c => c.name === extState.selectedCloud) && (
              <p className="font-label-caps text-label-caps text-tertiary mt-xs">⚠ Este cloud no tiene SSH vinculado</p>
            )}
          </div>

          <div className="space-y-xs">
            <p className="font-label-caps text-label-caps text-outline">Nota</p>
            <p className="font-body-sm text-body-sm text-outline">
              <strong className="text-on-surface-variant">Ultra-Lite</strong> — solo <code className="font-code-sm text-code-sm text-secondary">uploads/</code>, <code className="font-code-sm text-code-sm text-secondary">config.json</code> y SQL crudo. Más rápido.
            </p>
          </div>
        </div>

        {/* ── Stepper ── */}
        <div className="bg-surface-container-low border border-outline-variant p-md">
          <div className="flex items-center justify-between overflow-x-auto gap-xs">
            {EXTRACT_STEPS.map((step, idx) => {
              const state = stepStates[step.id] as StepState;
              const isLast = idx === EXTRACT_STEPS.length - 1;
              return (
                <div key={step.id} className="flex items-center gap-xs shrink-0">
                  <div className="flex flex-col items-center gap-xs">
                    <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold transition-all ${
                      state === 'done'   ? 'bg-secondary text-on-secondary' :
                      state === 'active' ? 'bg-secondary-container text-on-secondary ring-2 ring-secondary ring-offset-2 ring-offset-surface-container-low' :
                                           'bg-surface-container-highest text-outline'
                    }`}>
                      {state === 'done' ? '✓' : idx + 1}
                    </div>
                    <span className={`font-label-caps text-label-caps whitespace-nowrap ${
                      state === 'done' ? 'text-secondary' :
                      state === 'active' ? 'text-on-surface' :
                                           'text-outline'
                    }`}>
                      {step.label.split(' ').slice(0, 2).join(' ')}
                    </span>
                  </div>
                  {!isLast && (
                    <div className={`h-[1px] w-8 shrink-0 mt-[-16px] ${state === 'done' ? 'bg-secondary' : 'bg-outline-variant'}`} />
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* ── Domain list + progress ── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-md">

          {/* Left: Domain textarea + progress */}
          <div className="space-y-md">
            <div className="bg-surface-container-low border border-outline-variant p-md space-y-sm">
              <div className="flex items-center justify-between">
                <span className="font-title-sm text-on-surface">Dominios a Extraer</span>
                {domains.length > 0 && (
                  <span className="font-code-sm text-code-sm text-secondary border border-secondary/30 bg-secondary-container/10 px-sm py-[2px] rounded-sm">
                    {domains.length} TOTAL
                  </span>
                )}
              </div>
              <textarea
                value={extState.domainList}
                onChange={e => setExtState(prev => ({ ...prev, domainList: e.target.value }))}
                placeholder={"ejemplo.com\notro-dominio.net\nmipagina.org"}
                className="w-full bg-surface-container border-0 border-b border-outline-variant text-on-surface font-code-md text-code-md rounded-t px-sm py-sm resize-none focus:border-secondary focus:ring-0"
                rows={8}
                disabled={extState.loading}
              />
              <p className="font-body-sm text-body-sm text-outline">
                Se cargan al seleccionar el cloud. Un dominio por línea, sin http://.
              </p>
            </div>

            {/* Progress */}
            {(extState.loading || extState.progress.current > 0) && (
              <div className="bg-surface-container-low border border-outline-variant p-md space-y-sm">
                <div className="flex justify-between items-center">
                  <span className="font-label-caps text-label-caps text-outline">Progreso</span>
                  <span className="font-code-sm text-code-sm text-secondary">{displayProgress}%</span>
                </div>
                <div className="w-full bg-surface-container-highest h-1.5 rounded-full overflow-hidden">
                  <div
                    className="bg-secondary h-full transition-all duration-500"
                    style={{ width: `${displayProgress}%` }}
                  />
                </div>
                {extState.loading && currentDomain && (
                  <div className="flex items-center gap-sm">
                    <span className="spinner text-secondary" />
                    <span className="font-code-sm text-code-sm text-on-surface-variant truncate">Extrayendo: {currentDomain}</span>
                  </div>
                )}
                <p className="font-body-sm text-body-sm text-outline truncate">{extState.statusMessage}</p>
              </div>
            )}
          </div>

          {/* Right: Results table */}
          <div className="lg:col-span-2 bg-surface-container-low border border-outline-variant flex flex-col overflow-hidden">
            <div className="bg-surface-container-high px-md py-sm flex items-center justify-between border-b border-outline-variant shrink-0">
              <span className="font-title-sm text-on-surface">Resultados de Extracción</span>
              {extState.results.length > 0 && (
                <div className="flex gap-md font-label-caps text-label-caps">
                  <span className="text-green-400">✓ {extState.results.filter((r: any) => r.status === 'success').length}</span>
                  {extState.results.filter((r: any) => r.status === 'error').length > 0 && (
                    <span className="text-error">✗ {extState.results.filter((r: any) => r.status === 'error').length}</span>
                  )}
                </div>
              )}
            </div>

            {extState.results.length === 0 ? (
              <div className="flex-1 flex items-center justify-center text-on-surface-variant font-body-md p-xl">
                <div className="text-center">
                  <svg className="w-12 h-12 mx-auto mb-sm opacity-20" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <polyline points="21 16 21 8 14 2 3 2 3 22 10 22" strokeWidth={1} />
                    <line x1="17" y1="16" x2="17" y2="22" strokeWidth={1} />
                    <line x1="13" y1="20" x2="21" y2="20" strokeWidth={1} />
                  </svg>
                  <p>Los resultados aparecerán aquí al iniciar la extracción</p>
                </div>
              </div>
            ) : (
              <div className="flex-1 overflow-auto">
                {/* Summary banner */}
                {summary && (
                  <div className={`mx-md mt-md px-md py-sm flex items-center gap-sm text-sm font-medium rounded ${
                    summary.errors === 0 ? 'bg-green-500/10 text-green-400' :
                    summary.success > 0 ? 'bg-tertiary/10 text-tertiary' :
                    'bg-error/10 text-error'
                  }`}>
                    {summary.errors === 0 ? (
                      <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><polyline points="20 6 9 17 4 12" /></svg>
                    ) : (
                      <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
                    )}
                    <span>
                      {summary.errors === 0
                        ? `${summary.success}/${summary.total} dominios extraídos correctamente`
                        : `${summary.errors}/${summary.total} con errores — ${summary.success} exitosos`
                      }
                    </span>
                  </div>
                )}
                <table className="w-full border-collapse mt-md">
                  <thead className="sticky top-0 bg-surface-container-low">
                    <tr className="text-left border-b border-outline-variant">
                      <th className="px-md py-sm font-label-caps text-label-caps text-outline uppercase">Dominio</th>
                      <th className="px-md py-sm font-label-caps text-label-caps text-outline uppercase">Estado</th>
                      <th className="px-md py-sm font-label-caps text-label-caps text-outline uppercase">Mensaje</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-outline-variant/30">
                    {extState.results.map((r: any, i: number) => {
                      const isSuccess = r.status === 'success';
                      const isError = r.status === 'error';
                      const isProcessing = r.status === 'processing' || r.status === 'downloading';

                      const dotClass = isSuccess ? 'status-dot--success' : isError ? 'status-dot--error' : isProcessing ? 'status-dot--running' : 'status-dot--pending';
                      const labelColor = isSuccess ? 'text-green-400' : isError ? 'text-error' : isProcessing ? 'text-secondary' : 'text-outline';
                      const statusLabel = isSuccess ? 'Completado' : isError ? 'Error' : isProcessing ? 'Procesando' : 'En cola';

                      return (
                        <tr key={i} className="hover:bg-surface-container-high transition-colors">
                          <td className="px-md py-sm font-code-md text-code-md text-secondary">{r.domain}</td>
                          <td className="px-md py-sm">
                            <div className="flex items-center gap-sm">
                              {isProcessing && <span className="spinner text-secondary w-3 h-3" />}
                              {!isProcessing && <div className={`status-dot ${dotClass}`} />}
                              <span className={`font-label-caps text-label-caps ${labelColor}`}>{statusLabel}</span>
                            </div>
                          </td>
                          <td className="px-md py-sm font-body-sm text-body-sm text-outline truncate max-w-[200px]">{r.message}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* Summary footer */}
            {extState.results.length > 0 && (
              <div className="border-t border-outline-variant px-md py-sm flex gap-md font-label-caps text-label-caps shrink-0 bg-surface-container-high">
                <span className="text-outline">Total: {extState.results.length}</span>
                <span className="text-green-400">Exitosos: {extState.results.filter((r: any) => r.status === 'success').length}</span>
                <span className="text-error">Fallidos: {extState.results.filter((r: any) => r.status === 'error').length}</span>
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
                extraction_log@kraken
                {extState.loading && <span className="ml-sm text-secondary animate-pulse">● LIVE</span>}
              </span>
            </div>
          </div>
          <div className="p-md font-code-md text-code-md overflow-y-auto max-h-44 space-y-[2px]">
            {extState.logs.length === 0 ? (
              <p className="text-outline italic">Esperando operaciones...</p>
            ) : (
              extState.logs.map((log: any, i: number) => {
                const ts = log.timestamp
                  ? new Date(log.timestamp).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
                  : '';
                return (
                  <p key={i} className={`flex gap-sm ${
                    log.type === 'error' ? 'text-error' :
                    log.type === 'success' ? 'text-green-400' :
                    log.type === 'warning' ? 'text-tertiary' :
                    'text-on-surface-variant'
                  }`}>
                    {ts && <span className="shrink-0 text-outline">[{ts}]</span>}
                    <span>{log.message}</span>
                  </p>
                );
              })
            )}
          </div>
        </div>

      </div>
    </div>
  );
};

export default ExtractionModule;
