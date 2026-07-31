import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useIpc } from '../hooks/useIpc';
import { useModuleState } from '../contexts/AppStateContext';
import { Play, Square, RefreshCw, ChevronDown, ChevronRight, Check, Terminal, Mail } from 'lucide-react';

interface BulkResult {
  domain: string;
  status: 'success' | 'error' | 'warning' | 'completed_with_warnings' | 'running' | 'pending' | 'skipped' | 'processing' | 'downloading';
  message: string;
}

interface DeploymentModuleProps {
  onLog?: (message: string, type: 'info' | 'warning' | 'error' | 'success', moduleId?: string) => void;
  logs?: { message: string; type: string; timestamp?: number; source?: string }[];
}

// Stepper steps — matched by keywords in deployment:log messages
const DEPLOY_STEPS = [
  { id: 'init', label: 'Preparando entorno', keyword: 'Preparando entorno' },
  { id: 'clean_html', label: 'Eliminar index.html por defecto', keyword: 'Eliminando index.html' },
  { id: 'upload', label: 'Subir backups al servidor', keyword: 'Subiendo backups' },
  { id: 'extract', label: 'Descomprimir archivos', keyword: 'Descomprimiendo archivos' },
  { id: 'config', label: 'Inyectar wp-config.php', keyword: 'Inyectando wp-config.php' },
  { id: 'db_import', label: 'Importar base de datos', keyword: 'Importando base de datos' },
  { id: 'search_replace', label: 'Search & Replace profundo', keyword: 'Search & Replace' },
  { id: 'done', label: 'Limpieza y finalización', keyword: 'Despliegue completado' },
];

type StepState = 'pending' | 'active' | 'done';

const DeploymentModule: React.FC<DeploymentModuleProps> = ({ onLog }) => {
  const { config, runDeploymentBatch, getDominiosProcesados } = useIpc();

  const [depState, setDepState] = useModuleState('deployment');
  const [includeWeb, setIncludeWeb] = useState<boolean>(true);
  const [includeEmails, setIncludeEmails] = useState<boolean>(true); // Activado por defecto para despliegue (no usa VPN)
  const [pleskServerName, setPleskServerName] = useState<string>('');
  const [currentDomain, setCurrentDomain] = useState<any>(null);
  const [totalDomains, setTotalDomains] = useState(0);
  // 🔥 v1.9.17: Limpieza Profunda (checkbox Tierra Quemada)
  const [forceClean, setForceClean] = useState(false);
  const [stepStates, setStepStates] = useState<Record<string, StepState>>(
    () => Object.fromEntries(DEPLOY_STEPS.map(s => [s.id, 'pending']))
  );
  const [isStopping, setIsStopping] = useState(false);
  const terminalEndRef = useRef<HTMLDivElement>(null);

  const resultsRef = useRef<BulkResult[]>(depState.results as BulkResult[]);
  resultsRef.current = depState.results as BulkResult[];
  const logsRef = useRef(depState.logs);
  logsRef.current = depState.logs;

  // Auto-scroll terminal to latest log
  useEffect(() => {
    terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [depState.logs.length]);

  // Mount effect: restore deployment state from backend (persists across tab switches)
  // + subscribe to deployment:state-changed and deployment:log
  useEffect(() => {
    let api: any = null;
    try {
      api = (window as any).api;
    } catch {
      return;
    }
    if (!api) return;

    // --- Restore state from backend (survives tab switches) ---
    (async () => {
      try {
        const state = await api.invoke('get-deployment-status');
        const patches: Partial<typeof depState> = {};

        if (state.results && state.results.length > 0) {
          patches.results = state.results;
        }
        if (state.totalDomains > 0) {
          setTotalDomains(state.totalDomains);
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
          patches.progress = { current: progressPct, total: 100 };
          if (state.totalDomains > 0) {
            patches.statusMessage = state.currentDomain
              ? `Desplegando ${state.currentDomain} (${processedTotal + 1}/${state.totalDomains})...`
              : state.currentMessage || '';
          } else {
            patches.statusMessage = state.currentMessage || '';
          }
          patches.loading = true;
          if (state.batchAccountName) patches.selectedAccount = state.batchAccountName;
          if (state.sourceCloud) patches.selectedCloud = state.sourceCloud;
          if (state.batchServerName) setPleskServerName(state.batchServerName);
        } else if (state.results && state.results.length > 0 && !state.isRunning) {
          patches.progress = { current: 100, total: 100 };
          patches.statusMessage = 'Despliegue masivo finalizado';
        }

        if (Object.keys(patches).length > 0) {
          setDepState(prev => ({ ...prev, ...patches }));
        }
      } catch {
        // No state to restore — first mount
      }
    })();

    // --- Listen for deployment:state-changed (real-time batch progress) ---
    const handleStateChanged = (state: any) => {
      const patches: Partial<typeof depState> = {};

      setCurrentDomain(state.currentDomain || '');
      const processedTotal = state.results?.length || 0;
      const progressPct = state.totalDomains > 0
        ? Math.round((processedTotal / state.totalDomains) * 100)
        : state.currentProgress || 0;
      patches.progress = { current: progressPct, total: 100 };
      if (state.totalDomains > 0) {
        setTotalDomains(state.totalDomains);
        patches.statusMessage = state.currentMessage
          ? state.currentMessage
          : state.currentDomain
            ? `Desplegando ${state.currentDomain} (${processedTotal + 1}/${state.totalDomains})...`
            : '';
      } else {
        patches.statusMessage = state.currentMessage || '';
      }
      if (state.results) patches.results = state.results;
      patches.loading = !!state.isRunning;
      if (!state.isRunning && state.results?.length > 0 && state.totalDomains > 0) {
        if (state.results.length >= state.totalDomains) {
          patches.progress = { current: 100, total: 100 };
        }
      }

      if (!state.isRunning) {
        setIsStopping(false);
      }

      setDepState(prev => ({ ...prev, ...patches }));
    };

    // --- Listen for deployment:log (real-time log messages) ---
    const handleDeploymentLog = (data: any) => {
      const message = data.message || '';
      const type = data.type || 'info';
      // Buffer de logs: replaceLast para progreso continuo (Subiendo archivos)
      setDepState(prev => {
        const currentLogs = prev.logs;
        const shouldReplace = message.includes('Subiendo') || message.includes('%');
        let nextLogs: typeof currentLogs;
        
        if (shouldReplace && currentLogs.length > 0) {
          nextLogs = [...currentLogs];
          nextLogs[nextLogs.length - 1] = { message, type, timestamp: data.timestamp || Date.now() };
        } else {
          nextLogs = [...currentLogs, { message, type, timestamp: data.timestamp || Date.now() }];
          nextLogs = nextLogs.length > 150 ? nextLogs.slice(-150) : nextLogs; // Keep last 150 logs
        }
        
        return { ...prev, logs: nextLogs, statusMessage: message };
      });

      // --- Stepper update: intercept keywords to mark steps as active/done ---
      setStepStates(prev => {
        const next = { ...prev };
        // Find the step that matches this log's keyword
        const matchedIdx = DEPLOY_STEPS.findIndex(s => message.includes(s.keyword));
        if (matchedIdx >= 0) {
          // Mark matched step as done
          next[DEPLOY_STEPS[matchedIdx].id] = 'done';
          // Mark all previous steps as done (catch-up)
          for (let i = 0; i < matchedIdx; i++) {
            next[DEPLOY_STEPS[i].id] = 'done';
          }
          // The NEXT step becomes active (if it exists and isn't done yet)
          if (matchedIdx + 1 < DEPLOY_STEPS.length) {
            const nextStepId = DEPLOY_STEPS[matchedIdx + 1].id;
            if (next[nextStepId] === 'pending') {
              next[nextStepId] = 'active';
            }
          }
        }
        return next;
      });

      // Also: send to lower panel (Registro de eventos) via onLog — but the panel
      // is hidden for migration; this is a fallback for other consumers.
      if (onLog) {
        onLog(message, type, 'migration');
      }

    };

    api.receive('deployment:state-changed', handleStateChanged);
    api.receive('deployment:log', handleDeploymentLog);
    
    const handleStart = (payload: any) => {
      const domainStr = payload?.dominio || payload?.domain || payload?.domain_name || payload;
      setDepState(prev => ({
        ...prev,
        results: prev.results.map((r: any) =>
          r.domain === domainStr || r.domain === payload
            ? { ...r, status: 'running', message: 'Procesando...' }
            : r
        )
      }));
      // Reset stepper so each domain starts fresh from step 1
      setStepStates(Object.fromEntries(DEPLOY_STEPS.map(s => [s.id, 'pending'])));
    };

    const handleSuccess = (payload: any) => {
      setDepState(prev => ({
        ...prev,
        results: prev.results.map((r: any) => 
          r.domain === payload.domain 
            ? { ...r, status: payload.message?.includes('Omitido') ? 'skipped' : 'success', message: payload.message || 'Completado' } 
            : r
        )
      }));
    };

    const handleError = (payload: any) => {
      setDepState(prev => ({
        ...prev,
        results: prev.results.map((r: any) => 
          r.domain === payload.domain 
            ? { ...r, status: 'error', message: payload.message || payload.error || 'Error desconocido' } 
            : r
        )
      }));
    };

    const handleWarning = (payload: any) => {
      setDepState(prev => ({
        ...prev,
        results: prev.results.map((r: any) => 
          r.domain === payload.domain 
            ? { ...r, status: 'warning', message: payload.message || 'Faltan archivos' } 
            : r
        )
      }));
    };

    api.receive('migrate-domain-start', handleStart);
    api.receive('migrate-domain-success', handleSuccess);
    api.receive('migrate-domain-error', handleError);
    api.receive('migrate-domain-warning', handleWarning);

    // Cleanup: remove ALL listeners for deployment channels to prevent memory leaks
    return () => {
      if (api) {
        api.removeAllListeners('deployment:state-changed');
        api.removeAllListeners('deployment:log');
        api.removeAllListeners('migrate-domain-start');
        api.removeAllListeners('migrate-domain-success');
        api.removeAllListeners('migrate-domain-error');
        api.removeAllListeners('migrate-domain-warning');
      }
    };
  }, []);

  // Autoload de dominios procesados se realiza directamente en handleSourceCloudChange

  // Mostrar TODAS las cuentas que existen en config, incluso si originClouds está vacío
  const accountsWithClouds = useMemo(() =>
    config?.accounts?.filter(account => account && account.name) || [],
    [config]
  );

  const clouds = useMemo(() => depState.selectedAccount
    ? config?.accounts.find(acc => acc.name === depState.selectedAccount)?.originClouds || []
    : [], [config, depState.selectedAccount]);

  // Migration no requiere SSH vinculado en el cloud — solo el servidor Plesk necesita SSH

  // 🔥 HOTFIX v1.5.4: filtrar servidor 'Global' (no se debe mostrar nunca más)
  const allPleskServers = useMemo(() =>
    (config?.destinationServers || []).filter(s => s.name !== 'Global'),
    [config]);

  const domains = depState.domainList.split('\n').map(d => d.trim()).filter(d => d.length > 0);

  const handleSourceAccountChange = useCallback((accountName: string) => {
    setDepState(prev => ({ ...prev, selectedAccount: accountName, selectedCloud: '', results: [] }));
  }, []);

  const handleSourceCloudChange = useCallback(
    async (cloudName: string) => {
      setDepState(prev => ({ ...prev, selectedCloud: cloudName, results: [] }));

      if (!cloudName) {
        setDepState(prev => ({ ...prev, domainList: '' }));
        return;
      }

      if (depState.selectedAccount) {
        try {
          const result = await getDominiosProcesados(depState.selectedAccount, cloudName);
          if (result.success && Array.isArray(result.dominios)) {
            const dominiosText = result.dominios
              .map((d: unknown) => {
                if (typeof d === 'object' && d !== null && 'dominio' in d) {
                  const dom = (d as Record<string, unknown>).dominio;
                  return typeof dom === 'string' ? dom : '';
                }
                return '';
              })
              .filter((d): d is string => d.length > 0)
              .join('\n');

            setDepState(prev => {
              if (prev.selectedAccount === depState.selectedAccount && prev.selectedCloud === cloudName) {
                return { ...prev, domainList: dominiosText };
              }
              return prev;
            });
          } else {
            setDepState(prev => {
              if (prev.selectedAccount === depState.selectedAccount && prev.selectedCloud === cloudName) {
                return { ...prev, domainList: '' };
              }
              return prev;
            });
          }
        } catch (error) {
          console.error('Error al obtener dominios procesados:', error);
        }
      }
    },
    [depState.selectedAccount, getDominiosProcesados, setDepState]
  );

  const handlePleskServerChange = useCallback((serverName: string) => {
    setPleskServerName(serverName);
    setDepState(prev => ({ ...prev, results: [] }));
  }, []);

  const handleDeploy = useCallback(async () => {
    if (!pleskServerName || !depState.selectedAccount || !depState.selectedCloud || domains.length === 0) return;

    const selectedServerObj = allPleskServers.find(s => s.name === pleskServerName);
    if (!selectedServerObj?.isLinked) return;

    setDepState(prev => ({
      ...prev,
      loading: true,
      results: domains.map(d => ({ domain: d, status: 'pending' as const, message: 'En cola...' })),
      progress: { current: 0, total: 100 },
      statusMessage: `Iniciando despliegue masivo (${domains.length} dominio(s))...`,
    }));
    setTotalDomains(domains.length);
    setCurrentDomain(domains[0]);
    setIsStopping(false);

    try {
      const result = await runDeploymentBatch(
        depState.selectedAccount,
        pleskServerName,
        depState.selectedAccount,
        depState.selectedCloud,
        domains,
        forceClean
      );

      if (result.success) {
        const batchResults = result.results || [];
        const okCount = batchResults.filter((r: any) => r.success).length;
        const errCount = batchResults.filter((r: any) => !r.success).length;

        // Per-domain results ya vienen por deployment:log [OK]/[ERROR] y domain-process-result en tiempo real.
        // Solo actualizamos progress y statusMessage final.
        setDepState(prev => ({
          ...prev,
          progress: { current: 100, total: 100 },
          statusMessage: `Despliegue masivo finalizado: ${okCount} ok, ${errCount} errores (${domains.length} total)`,
        }));
      } else {
        setDepState(prev => ({ ...prev, statusMessage: `Error: ${result.error || 'Error desconocido'}` }));
      }
    } catch (error: any) {
      setDepState(prev => ({ ...prev, statusMessage: `Error crítico: ${error.message}` }));
    } finally {
      setCurrentDomain('');
      setDepState(prev => {
        const cleanResults = (prev.results || []).map((r: any) => 
          r.status === 'processing' ? { ...r, status: 'error', message: 'Cancelado/Fallido' } : r
        );
        return { ...prev, loading: false, results: cleanResults };
      });
      setIsStopping(false);
    }
  }, [pleskServerName, depState.selectedAccount, depState.selectedCloud, domains, allPleskServers, runDeploymentBatch, forceClean]);

  const handleDeployEmailsOnly = useCallback(async () => {
    if (!pleskServerName || !depState.selectedAccount || !depState.selectedCloud || domains.length === 0) return;

    setDepState(prev => ({
      ...prev,
      loading: true,
      results: domains.map(d => ({ domain: d, status: 'pending' as const, message: 'En cola' })),
      progress: { current: 0, total: 100 },
      statusMessage: `Iniciando restauración de correos a Plesk (${domains.length} dominio(s))...`,
    }));
    setTotalDomains(domains.length);
    setCurrentDomain(domains[0]);
    setIsStopping(false);

    try {
      const api = (window as any).api;
      if (!api) throw new Error('API no disponible');
      const result = await api.invoke('email:restore-batch', {
        serverName: pleskServerName,
        accountName: depState.selectedAccount,
        cloudName: depState.selectedCloud,
        domains,
      }) as any;

      if (result?.success) {
        const okCount = result.successCount ?? 0;
        const errCount = result.errors ?? 0;
        setDepState(prev => ({
          ...prev,
          progress: { current: 100, total: 100 },
          statusMessage: `Restauración de correos finalizada: ${okCount} ok, ${errCount} errores (${domains.length} total)`,
        }));
      } else {
        const errMsg = result?.error || 'Error desconocido';
        setDepState(prev => ({
          ...prev,
          statusMessage: `Error: ${errMsg}`,
          results: (prev.results || []).map((r: any) =>
            r.status === 'running' || r.status === 'pending' || r.status === 'processing'
              ? { ...r, status: 'error', message: errMsg }
              : r
          ),
        }));
      }
    } catch (error: any) {
      const errMsg = error.message || 'Error crítico';
      setDepState(prev => ({
        ...prev,
        statusMessage: `Error crítico: ${errMsg}`,
        results: (prev.results || []).map((r: any) =>
          r.status === 'running' || r.status === 'pending' || r.status === 'processing'
            ? { ...r, status: 'error', message: errMsg }
            : r
        ),
      }));
    } finally {
      setCurrentDomain('');
      setDepState(prev => {
        const cleanResults = (prev.results || []).map((r: any) =>
          r.status === 'processing' || r.status === 'running' || r.status === 'pending'
            ? { ...r, status: 'error', message: 'Cancelado/Fallido' }
            : r
        );
        return { ...prev, loading: false, results: cleanResults };
      });
      setIsStopping(false);
    }
  }, [pleskServerName, depState.selectedAccount, depState.selectedCloud, domains, setDepState]);

  const handleStartDeployment = useCallback(async () => {
    if (!includeWeb && !includeEmails) return;
    if (includeWeb && includeEmails) {
      await handleDeploy();
    } else if (includeWeb) {
      await handleDeploy();
    } else if (includeEmails) {
      await handleDeployEmailsOnly();
    }
  }, [includeWeb, includeEmails, handleDeploy, handleDeployEmailsOnly]);

  const canDeploy = pleskServerName && depState.selectedAccount && depState.selectedCloud && domains.length > 0 && !depState.loading;

  return (
    <div className="flex flex-col h-full bg-background overflow-hidden">

      {/* ── Page Header ── */}
      <div className="flex-none px-lg pt-lg pb-md">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-md">
          <div>
            <h2 className="font-display-lg text-display-lg text-secondary mb-xs">Hub de Migración</h2>
            <p className="font-body-md text-on-surface-variant">
              Selección masiva de dominios → transferencia y despliegue a Plesk destino.
            </p>
          </div>

          {/* Action buttons with checkboxes */}
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
                <span className="font-medium text-xs tracking-wide">Web / DB</span>
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

            {/* Botón único de Despliegue */}
            <button
              onClick={handleStartDeployment}
              disabled={!canDeploy || (!includeWeb && !includeEmails)}
              className={`flex items-center gap-xs px-md py-sm font-title-sm rounded transition-all active:scale-95 ${
                canDeploy && (includeWeb || includeEmails)
                  ? 'bg-secondary-container text-on-secondary-container hover:brightness-110'
                  : 'bg-surface-container-highest text-outline cursor-not-allowed'
              }`}
              title="Iniciar despliegue según los módulos seleccionados"
            >
              <Play size={16} />
              {depState.loading ? 'Desplegando...' : `Iniciar Despliegue${domains.length > 0 ? ` (${domains.length})` : ''}`}
            </button>

            {depState.loading && (
              <button
                onClick={() => {
                  setIsStopping(true);
                  if ((window as any).krakenAPI?.orquestador?.detener) {
                    (window as any).krakenAPI.orquestador.detener();
                  }
                }}
                disabled={isStopping}
                className="flex items-center gap-xs px-md py-sm font-title-sm bg-surface-container-highest text-error rounded border border-error/30 hover:bg-error-container/20 transition-all active:scale-95"
              >
                <Square size={16} />
                {isStopping ? 'Deteniendo...' : 'Detener'}
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-lg pb-lg space-y-md">

        {/* ── Selection Bar ── */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-md items-end">
          <div className="space-y-xs">
            <label className="font-label-caps text-label-caps text-outline">Cuenta Origen</label>
            <select
              value={depState.selectedAccount}
              onChange={e => handleSourceAccountChange(e.target.value)}
              className="w-full bg-surface-container-high border-b-2 border-outline-variant border-x-0 border-t-0 text-on-surface focus:border-secondary focus:ring-0 font-body-md rounded-t px-sm py-sm"
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
              value={depState.selectedCloud}
              onChange={e => handleSourceCloudChange(e.target.value)}
              disabled={!depState.selectedAccount}
              className="w-full bg-surface-container-high border-b-2 border-outline-variant border-x-0 border-t-0 text-on-surface focus:border-secondary focus:ring-0 font-body-md rounded-t px-sm py-sm disabled:opacity-50"
            >
              <option value="">Seleccionar cloud</option>
              {clouds.map(cloud => (
                <option key={cloud.name} value={cloud.name}>
                  {cloud.name} {cloud.isLinked ? '(SSH OK)' : '(SSH pendiente)'}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-xs">
            <label className="font-label-caps text-label-caps text-outline">Servidor Plesk (Destino)</label>
            <select
              value={pleskServerName}
              onChange={e => handlePleskServerChange(e.target.value)}
              className="w-full bg-surface-container-high border-b-2 border-outline-variant border-x-0 border-t-0 text-on-surface focus:border-secondary focus:ring-0 font-body-md rounded-t px-sm py-sm"
            >
              <option value="">Seleccionar servidor</option>
              {allPleskServers.map(server => (
                <option key={server.name} value={server.name}>
                  {server.name} {server.isLinked ? '(SSH OK)' : '(SSH pendiente)'}
                </option>
              ))}
            </select>
            {pleskServerName && !allPleskServers.find(s => s.name === pleskServerName)?.isLinked && (
              <p className="font-label-caps text-label-caps text-tertiary mt-xs">⚠ SSH pendiente de vinculación</p>
            )}
          </div>

          {/* Limpieza Profunda checkbox */}
          <div className="flex items-center gap-sm pb-sm">
            <input
              type="checkbox"
              id="forceClean"
              checked={forceClean}
              onChange={e => setForceClean(e.target.checked)}
              className="w-4 h-4 accent-error cursor-pointer"
            />
            <label htmlFor="forceClean" className="text-body-sm text-on-surface-variant cursor-pointer select-none">
              <span className="text-error">Limpieza Profunda</span>
              <span className="block text-outline font-label-caps text-label-caps">Borrar BD y archivos antes</span>
            </label>
          </div>
        </div>

        {/* ── Stepper ── */}
        <div className="bg-surface-container-low border border-outline-variant p-md">
          {/* Active domain label */}
          {depState.loading && currentDomain && (
            <div className="flex items-center gap-sm mb-sm pb-sm border-b border-outline-variant/50">
              <Terminal size={12} className="text-secondary shrink-0" />
              <span className="font-code-sm text-code-sm text-secondary truncate">
                Procesando: {(currentDomain as any)?.dominio || (currentDomain as any)?.domain || String(currentDomain)}
              </span>
              {totalDomains > 0 && (
                <span className="font-label-caps text-label-caps text-outline shrink-0 ml-auto">
                  {depState.results.filter((r: any) => r.status !== 'pending' && r.status !== 'running').length + 1}
                  /{totalDomains}
                </span>
              )}
            </div>
          )}
          {/* Stepper circles */}
          <div className="flex items-center justify-between overflow-x-auto gap-xs">
            {DEPLOY_STEPS.map((step, idx) => {
              const state = stepStates[step.id];
              const isLast = idx === DEPLOY_STEPS.length - 1;
              return (
                <div key={step.id} className="flex items-center gap-xs shrink-0">
                  <div className="flex flex-col items-center gap-xs">
                    <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold transition-all ${
                      state === 'done'   ? 'bg-secondary text-on-secondary' :
                      state === 'active' ? 'bg-secondary-container text-on-secondary ring-2 ring-secondary ring-offset-2 ring-offset-surface-container-low' :
                                           'bg-surface-container-highest text-outline'
                    }`}>
                      {state === 'done' ? <Check size={10} /> : idx + 1}
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
                <span className="font-title-sm text-on-surface">Dominios a Migrar</span>
                {domains.length > 0 && (
                  <span className="font-code-sm text-code-sm text-secondary border border-secondary/30 bg-secondary-container/10 px-sm py-[2px] rounded-sm">
                    {domains.length} TOTAL
                  </span>
                )}
              </div>
              <textarea
                value={depState.domainList}
                onChange={e => setDepState(prev => ({ ...prev, domainList: e.target.value }))}
                placeholder={"ejemplo.com\notro-dominio.net\nmipagina.org"}
                className="w-full bg-surface-container border-0 border-b border-outline-variant text-on-surface font-code-md text-code-md rounded-t px-sm py-sm resize-none focus:border-secondary focus:ring-0"
                rows={8}
                disabled={depState.loading}
              />
              <p className="font-body-sm text-body-sm text-outline">
                Se cargan automáticamente al seleccionar el cloud. Un dominio por línea.
              </p>
            </div>

            {/* Progress bar */}
            {(depState.loading || depState.progress.current > 0) && (
              <div className="bg-surface-container-low border border-outline-variant p-md space-y-sm">
                <div className="flex justify-between items-center">
                  <span className="font-label-caps text-label-caps text-outline">Progreso Total</span>
                  <span className="font-code-sm text-code-sm text-secondary">{depState.progress.current}%</span>
                </div>
                <div className="w-full bg-surface-container-highest h-1.5 rounded-full overflow-hidden">
                  <div
                    className="bg-secondary h-full transition-all duration-500"
                    style={{ width: `${depState.progress.current}%` }}
                  />
                </div>
                {currentDomain && (
                  <div className="flex items-center gap-sm">
                    <span className="spinner text-secondary" />
                    <span className="font-code-sm text-code-sm text-on-surface-variant truncate">{
                      (currentDomain as any)?.dominio || (currentDomain as any)?.domain || currentDomain
                    }</span>
                  </div>
                )}
                {depState.results.length > 0 && (
                  <div className="flex gap-md font-label-caps text-label-caps">
                    <span className="text-green-400">✓ {depState.results.filter(r => r.status === 'success').length}</span>
                    {depState.results.filter(r => r.status === 'error').length > 0 && (
                      <span className="text-error">✗ {depState.results.filter(r => r.status === 'error').length}</span>
                    )}
                    <span className="text-outline">{depState.results.length}/{totalDomains}</span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Right: Results table */}
          <div className="lg:col-span-2 bg-surface-container-low border border-outline-variant flex flex-col overflow-hidden">
            <div className="bg-surface-container-high px-md py-sm flex items-center justify-between border-b border-outline-variant shrink-0">
              <span className="font-title-sm text-on-surface">Resultados de Migración</span>
              {depState.results.length > 0 && (
                <span className="font-label-caps text-label-caps text-outline">{depState.results.length} dominios</span>
              )}
            </div>

            {depState.results.length === 0 ? (
              <div className="flex-1 flex items-center justify-center text-on-surface-variant font-body-md p-xl">
                <div className="text-center">
                  <ChevronRight size={32} className="mx-auto mb-sm opacity-20" />
                  <p>Los resultados aparecerán aquí al iniciar la migración</p>
                </div>
              </div>
            ) : (
              <div className="flex-1 overflow-auto">
                <table className="w-full border-collapse">
                  <thead className="sticky top-0 bg-surface-container-low">
                    <tr className="text-left border-b border-outline-variant">
                      <th className="p-md font-label-caps text-label-caps text-outline uppercase">Dominio</th>
                      <th className="p-md font-label-caps text-label-caps text-outline uppercase">Estado</th>
                      <th className="p-md font-label-caps text-label-caps text-outline uppercase">Mensaje</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-outline-variant/30">
                    {depState.results.map((r, i) => {
                      const domainStr = (r.domain as any)?.dominio || (r.domain as any)?.domain || r.domain;
                      const dotClass =
                        r.status === 'success' ? 'status-dot--success' :
                        r.status === 'running' ? 'status-dot--running' :
                        r.status === 'error' ? 'status-dot--error' :
                        r.status === 'completed_with_warnings' || r.status === 'warning' ? 'status-dot--warning' :
                        'status-dot--pending';
                      const labelColor =
                        r.status === 'success' ? 'text-green-400' :
                        r.status === 'error' ? 'text-error' :
                        r.status === 'completed_with_warnings' || r.status === 'warning' ? 'text-tertiary' :
                        'text-outline';
                      const statusLabel =
                        r.status === 'success' ? 'Completado' :
                        r.status === 'running' ? 'Procesando' :
                        r.status === 'error' ? 'Error' :
                        r.status === 'skipped' ? 'Omitido' :
                        r.status === 'completed_with_warnings' || r.status === 'warning' ? 'Con advertencias' :
                        'En cola';
                      return (
                        <tr key={i} className="hover:bg-surface-container-high transition-colors">
                          <td className="p-md font-code-md text-code-md text-secondary">{domainStr}</td>
                          <td className="p-md">
                            <div className="flex items-center gap-sm">
                              <div className={`status-dot ${dotClass}`} />
                              <span className={`font-label-caps text-label-caps ${labelColor}`}>{statusLabel}</span>
                            </div>
                          </td>
                          <td className="p-md font-body-sm text-body-sm text-outline truncate max-w-[280px]">{r.message}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* Summary footer */}
            {depState.results.length > 0 && (
              <div className="border-t border-outline-variant px-md py-sm flex gap-md font-label-caps text-label-caps shrink-0 bg-surface-container-high">
                <span className="text-outline">Total: {depState.results.length}</span>
                <span className="text-green-400">Exitosos: {depState.results.filter(r => r.status === 'success').length}</span>
                {depState.results.filter(r => r.status === 'completed_with_warnings' || r.status === 'warning').length > 0 && (
                  <span className="text-tertiary">Advertencias: {depState.results.filter(r => r.status === 'completed_with_warnings' || r.status === 'warning').length}</span>
                )}
                <span className="text-error">Errores: {depState.results.filter(r => r.status === 'error').length}</span>
              </div>
            )}
          </div>
        </div>

        {/* ── Integrated Terminal ── */}
        <div className="bg-black border border-outline-variant flex flex-col relative scanline-effect overflow-hidden">
          {/* Terminal header */}
          <div className="bg-surface-container px-md py-xs flex items-center justify-between border-b border-outline-variant shrink-0">
            <div className="flex items-center gap-sm">
              <div className="flex gap-1.5">
                <div className="w-2 h-2 rounded-full bg-error/40" />
                <div className="w-2 h-2 rounded-full bg-tertiary/40" />
                <div className="w-2 h-2 rounded-full bg-green-500/40" />
              </div>
              <span className="font-code-sm text-code-sm text-outline ml-md uppercase tracking-widest">
                deployment_log@kraken
                {depState.loading && <span className="ml-sm text-secondary animate-pulse">● LIVE</span>}
              </span>
            </div>
            <RefreshCw size={14} className="text-outline hover:text-on-surface cursor-pointer" />
          </div>

          {/* Log content */}
          <div className="p-md font-code-md text-code-md overflow-y-auto max-h-52 space-y-[2px]">
            {depState.logs.length === 0 ? (
              <p className="text-outline italic">Esperando operaciones...</p>
            ) : (
              depState.logs.map((log, i) => {
                const ts = log.timestamp
                  ? new Date(log.timestamp).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
                  : '';
                const colorClass =
                  log.type === 'error' ? 'text-error' :
                  log.type === 'success' ? 'text-green-400' :
                  log.type === 'warning' ? 'text-tertiary' :
                  'text-on-surface-variant';
                return (
                  <p key={i} className={`flex gap-sm ${colorClass}`}>
                    {ts && <span className="shrink-0 text-outline">[{ts}]</span>}
                    <span>{log.message}</span>
                  </p>
                );
              })
            )}
            {depState.loading && (
              <p className="inline-block w-2 h-4 bg-secondary ml-xs align-middle animate-pulse" />
            )}
            {/* Auto-scroll anchor */}
            <div ref={terminalEndRef} />
          </div>
        </div>

      </div>
    </div>
  );
};

export default DeploymentModule;
