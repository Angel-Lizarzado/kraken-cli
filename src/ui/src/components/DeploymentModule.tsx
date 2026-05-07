import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useIpc } from '../hooks/useIpc';
import { useModuleState } from '../contexts/AppStateContext';

interface BulkResult {
  domain: string;
  status: 'success' | 'error' | 'warning' | 'completed_with_warnings';
  message: string;
}

interface DeploymentModuleProps {
  onLog?: (message: string, type: 'info' | 'warning' | 'error' | 'success', moduleId?: string) => void;
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
  const [pleskServerName, setPleskServerName] = useState<string>('');
  const [currentDomain, setCurrentDomain] = useState<any>(null);
  const [totalDomains, setTotalDomains] = useState(0);
  // 🔥 v1.9.17: Limpieza Profunda (checkbox Tierra Quemada)
  const [forceClean, setForceClean] = useState(false);
  const [stepStates, setStepStates] = useState<Record<string, StepState>>(
    () => Object.fromEntries(DEPLOY_STEPS.map(s => [s.id, 'pending']))
  );

  const resultsRef = useRef<BulkResult[]>(depState.results as BulkResult[]);
  resultsRef.current = depState.results as BulkResult[];
  const logsRef = useRef(depState.logs);
  logsRef.current = depState.logs;

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

      setDepState(prev => ({ ...prev, ...patches }));
    };

    // --- Listen for deployment:log (real-time log messages) ---
    const handleDeploymentLog = (data: any) => {
      const message = data.message || '';
      const type = data.type || 'info';
      // Buffer de logs: replaceLast para progreso continuo (Subiendo archivos)
      const currentLogs = logsRef.current;
      const shouldReplace = message.includes('Subiendo') || message.includes('%');
      let nextLogs: typeof currentLogs;
      if (shouldReplace && currentLogs.length > 0) {
        nextLogs = [...currentLogs];
        nextLogs[nextLogs.length - 1] = { message, type, timestamp: data.timestamp || Date.now() };
      } else {
        nextLogs = [...currentLogs, { message, type, timestamp: data.timestamp || Date.now() }];
        nextLogs = nextLogs.length > 100 ? nextLogs.slice(-100) : nextLogs;
      }
      setDepState(prev => ({ ...prev, logs: nextLogs }));

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

      // Mapeo de resultados: si el log contiene [OK] o [ERROR], actualizar results en vivo
      const okMatch = message.match(/^\[OK\]\s+(\S+):\s*(.*)$/);
      const errMatch = message.match(/^\[ERROR\]\s+(\S+):\s*(.*)$/);
      if (okMatch) {
        const domain = okMatch[1];
        const detail = okMatch[2];
        const currentResults = resultsRef.current;
        const exists = currentResults.find(r => r.domain === domain);
        let nextResults: typeof currentResults;
        if (exists) {
          nextResults = currentResults.map(r => r.domain === domain ? { domain, status: 'success' as const, message: detail } : r) as typeof currentResults;
        } else {
          nextResults = [...currentResults, { domain, status: 'success' as const, message: detail }] as typeof currentResults;
        }
        setDepState(prev => ({ ...prev, results: nextResults }));
      } else if (errMatch) {
        const domain = errMatch[1];
        const detail = errMatch[2];
        const currentResults = resultsRef.current;
        const exists = currentResults.find(r => r.domain === domain);
        let nextResults: typeof currentResults;
        if (exists) {
          nextResults = currentResults.map(r => r.domain === domain ? { domain, status: 'error' as const, message: detail } : r) as typeof currentResults;
        } else {
          nextResults = [...currentResults, { domain, status: 'error' as const, message: detail }] as typeof currentResults;
        }
        setDepState(prev => ({ ...prev, results: nextResults }));
      } else {
        setDepState(prev => ({ ...prev, statusMessage: message }));
      }
    };

    api.receive('deployment:state-changed', handleStateChanged);
    api.receive('deployment:log', handleDeploymentLog);
    api.receive('domain-process-result', (data: { module: string; domain: string; status: string; message: string }) => {
      if (data.module !== 'MIGRATE') return;
      resultsRef.current = (resultsRef.current || [] as any[]).map((item: any) =>
        item.domain === data.domain
          ? { domain: data.domain, status: data.status, message: data.message }
          : item
      );
      setDepState(prev => ({ ...prev, results: resultsRef.current as any }));
    });

    // Cleanup: remove ALL listeners for deployment channels to prevent memory leaks
    return () => {
      if (api) {
        api.removeAllListeners('deployment:state-changed');
        api.removeAllListeners('deployment:log');
      }
    };
  }, []);

  // Autoload: when sourceCloud changes, fetch dominios_procesados.json and fill the TextArea
  useEffect(() => {
    if (!depState.selectedAccount || !depState.selectedCloud) {
      setDepState(prev => ({ ...prev, domainList: '' }));
      return;
    }

    let cancelled = false;
    const loadDominios = async () => {
      setDepState(prev => ({ ...prev, loading: true }));
      try {
        const result = await getDominiosProcesados(depState.selectedAccount, depState.selectedCloud);
        if (cancelled) return;
        if (result.success && result.dominios && result.dominios.length > 0) {
          const dominios = result.dominios.map((d: any) => d.dominio || d.name || d).filter(Boolean);
          setDepState(prev => ({ ...prev, domainList: dominios.join('\n') }));
        } else {
          setDepState(prev => ({ ...prev, domainList: '' }));
        }
      } catch {
        if (!cancelled) setDepState(prev => ({ ...prev, domainList: '' }));
      } finally {
        if (!cancelled) setDepState(prev => ({ ...prev, loading: false }));
      }
    };

    loadDominios();
    return () => { cancelled = true; setDepState(prev => ({ ...prev, loading: false })); };
  }, [depState.selectedAccount, depState.selectedCloud, getDominiosProcesados]);

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

  const handleSourceCloudChange = useCallback((cloudName: string) => {
    setDepState(prev => ({ ...prev, selectedCloud: cloudName, results: [] }));
  }, []);

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
      setDepState(prev => ({ ...prev, loading: false }));
    }
  }, [pleskServerName, depState.selectedAccount, depState.selectedCloud, domains, allPleskServers, runDeploymentBatch]);

  const canDeploy = pleskServerName && depState.selectedAccount && depState.selectedCloud && domains.length > 0 && !depState.loading;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-xl font-bold">Migración</h1>
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Fase 2: Transferencia y despliegue a Plesk</p>
      </div>

      {/* Configuración */}
      <div className="card p-5">
        <h2 className="font-display text-base font-bold mb-4">Configuración</h2>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Cuenta origen</label>
            <select
              value={depState.selectedAccount}
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
              value={depState.selectedCloud}
              onChange={e => handleSourceCloudChange(e.target.value)}
              className="input"
              disabled={!depState.selectedAccount}
            >
              <option value="">Seleccionar cloud</option>
              {clouds.map(cloud => (
                <option key={cloud.name} value={cloud.name}>
                  {cloud.name} {cloud.isLinked ? '(SSH OK)' : '(SSH pendiente)'}
                </option>
              ))}
            </select>
            {/* Migration no requiere SSH vinculado en el cloud — solo necesita los dominios */}
          </div>

          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Servidor Plesk (destino)</label>
            <select
              value={pleskServerName}
              onChange={e => handlePleskServerChange(e.target.value)}
              className="input"
            >
              <option value="">Seleccionar servidor Plesk</option>
              {allPleskServers.map(server => (
                <option key={server.name} value={server.name}>
                  {server.name} {server.isLinked ? '(SSH OK)' : '(SSH pendiente)'}
                </option>
              ))}
            </select>
            {pleskServerName && !allPleskServers.find(s => s.name === pleskServerName)?.isLinked && (
              <div className="mt-1.5 text-xs" style={{ color: 'var(--color-warning)' }}>
                Este servidor no tiene SSH vinculado. Vincúlelo desde el Panel primero.
              </div>
            )}
          </div>

          <div className="md:col-span-2">
            <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
              Dominios a migrar
              {domains.length > 0 && (
                <span className="ml-2 font-mono text-xs" style={{ color: 'var(--text-muted)' }}>
                  ({domains.length} dominio{domains.length !== 1 ? 's' : ''})
                </span>
              )}
              {depState.loading && (
                <span className="ml-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                  <span className="spinner" style={{ display: 'inline-block', width: 10, height: 10, borderWidth: 1.5, marginRight: 4 }} />
                  Cargando...
                </span>
              )}
            </label>
            <textarea
              value={depState.domainList}
              onChange={e => setDepState(prev => ({ ...prev, domainList: e.target.value }))}
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
        {/* 🔥 v1.9.17: Checkbox Limpieza Profunda */}
        <div className="mt-4 flex items-center gap-2">
          <input
            type="checkbox"
            id="forceClean"
            checked={forceClean}
            onChange={e => setForceClean(e.target.checked)}
            className="checkbox"
            style={{ accentColor: 'var(--color-error)' }}
          />
          <label htmlFor="forceClean" className="text-sm cursor-pointer select-none" style={{ color: 'var(--text-secondary)' }}>
            <span style={{ color: 'var(--color-error)' }}>Limpieza Profunda</span>
            {' '}(Borrar archivos y BD antes de instalar)
          </label>
        </div>
      </div>

      {/* Progreso */}
      {(depState.loading || depState.progress.current > 0) && (
        <div className="card p-5">
          <h2 className="font-display text-base font-bold mb-4">Progreso de despliegue masivo</h2>
          <div className="space-y-3">
            <div>
              <div className="flex justify-between text-xs mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                <span>{depState.statusMessage}</span>
                <span className="font-mono">{depState.progress.current}%</span>
              </div>
              <div className="bar">
                <div className="bar__fill bar__fill--accent" style={{ width: `${depState.progress.current}%` }} />
              </div>
            </div>
            {currentDomain && (
              <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                <span className="spinner" />
                <span>
                  <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold"
                    style={{
                      backgroundColor: 'oklch(0.45 0.1 220 / 0.12)',
                      color: 'oklch(0.7 0.12 220)',
                      marginRight: '6px'
                    }}>
                    {(() => {
                      const m = (depState.statusMessage || '').match(/^\[(\w+)\]/);
                      return m ? m[1] : 'PENDING';
                    })()}
                  </span>
                  <span className="font-mono" style={{ color: 'var(--text-secondary)' }}>{(currentDomain as any)?.dominio || (currentDomain as any)?.domain || currentDomain}</span>
                </span>
              </div>
            )}
            {depState.results.length > 0 && (
              <div className="pt-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
                Procesados: <span className="font-mono font-semibold">{depState.results.length}</span> de <span className="font-mono">{totalDomains}</span>
                <span className="ml-3">
                  <span style={{ color: 'var(--color-success)' }}>✓ {depState.results.filter(r => r.status === 'success').length}</span>
                  {depState.results.filter(r => r.status === 'error').length > 0 && (
                    <span className="ml-2" style={{ color: 'var(--color-error)' }}>✗ {depState.results.filter(r => r.status === 'error').length}</span>
                  )}
                  {depState.results.filter(r => r.status === 'completed_with_warnings' || r.status === 'warning').length > 0 && (
                    <span className="ml-2" style={{ color: 'var(--color-warning)' }}>⚠ {depState.results.filter(r => r.status === 'completed_with_warnings' || r.status === 'warning').length}</span>
                  )}
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Resultados — Tabla profesional */}
      {depState.results.length > 0 && (
        <div className="card p-5">
          <h2 className="font-display text-base font-bold mb-4">Resultados</h2>

          {/* Summary badge */}
          {(() => {
            const okCount = depState.results.filter(r => r.status === 'success').length;
            const errCount = depState.results.filter(r => r.status === 'error').length;
            const warnCount = depState.results.filter(r => r.status === 'completed_with_warnings' || r.status === 'warning').length;
            const perf = errCount === 0 && warnCount === 0 ? 'all-ok' : errCount > 0 ? 'has-errors' : 'has-warnings';
            return (
              <div
                className="flex items-center gap-3 px-4 py-3 rounded-md mb-4 text-sm"
                style={{
                  backgroundColor: perf === 'all-ok'
                    ? 'oklch(0.5 0.15 150 / 0.1)'
                    : perf === 'has-warnings'
                      ? 'oklch(0.5 0.12 80 / 0.1)'
                      : 'oklch(0.45 0.18 25 / 0.1)',
                  color: perf === 'all-ok'
                    ? 'var(--color-success)'
                    : perf === 'has-warnings'
                      ? 'var(--color-warning)'
                      : 'var(--color-error)',
                }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                  {perf === 'all-ok' ? (
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
                  {perf === 'all-ok'
                    ? `Todo correcto — ${okCount}/${depState.results.length} dominio(s) migrados exitosamente`
                    : perf === 'has-warnings'
                      ? `${warnCount}/${depState.results.length} dominio(s) con advertencias — ${okCount} exitosos, ${errCount} errores`
                      : `${errCount}/${depState.results.length} dominio(s) con errores — ${okCount} exitosos`
                  }
                </span>
              </div>
            );
          })()}

          {/* Tabla */}
          <div className="overflow-x-auto rounded-md border" style={{ borderColor: 'var(--border-default)' }}>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left" style={{ color: 'var(--text-muted)', backgroundColor: 'var(--surface-overlay)' }}>
                  <th className="py-2.5 px-3 font-medium">Dominio</th>
                  <th className="py-2.5 px-3 font-medium">Estado</th>
                  <th className="py-2.5 px-3 font-medium">Mensaje</th>
                </tr>
              </thead>
              <tbody>
                {depState.results.map((r, i) => (
                  <tr key={i} className="border-t" style={{ borderTopColor: 'var(--border-default)' }}>
                    <td className="py-2 px-3 font-mono" style={{ color: 'var(--text-secondary)' }}>{(r.domain as any)?.dominio || (r.domain as any)?.domain || r.domain}</td>
                    <td className="py-2 px-3">
                      <span
                        className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold"
                        style={{
                          backgroundColor:
                            r.status === 'success' ? 'oklch(0.5 0.15 150 / 0.12)' :
                              r.status === 'completed_with_warnings' || r.status === 'warning' ? 'oklch(0.5 0.12 80 / 0.12)' :
                                'oklch(0.45 0.18 25 / 0.12)',
                          color:
                            r.status === 'success' ? 'var(--color-success)' :
                              r.status === 'completed_with_warnings' || r.status === 'warning' ? 'var(--color-warning)' :
                                'var(--color-error)',
                        }}
                      >
                        {r.status === 'success' ? '✓' : r.status === 'completed_with_warnings' || r.status === 'warning' ? '⚠' : '✗'}
                        {' '}
                        {r.status === 'success' ? 'Exitoso' : r.status === 'completed_with_warnings' || r.status === 'warning' ? 'Con advertencias' : 'Error'}
                      </span>
                    </td>
                    <td className="py-2 px-3" style={{ color: 'var(--text-muted)' }}>{r.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-3 pt-3 border-t flex gap-4 text-xs" style={{ borderTopColor: 'var(--border-default)', color: 'var(--text-muted)' }}>
            <span>Total: {depState.results.length}</span>
            <span style={{ color: 'var(--color-success)' }}>Exitosos: {depState.results.filter(r => r.status === 'success').length}</span>
            {depState.results.filter(r => r.status === 'completed_with_warnings' || r.status === 'warning').length > 0 && (
              <span style={{ color: 'var(--color-warning)' }}>Con advertencias: {depState.results.filter(r => r.status === 'completed_with_warnings' || r.status === 'warning').length}</span>
            )}
            <span style={{ color: 'var(--color-error)' }}>Fallidos: {depState.results.filter(r => r.status === 'error').length}</span>
          </div>
        </div>
      )}

      {/* Terminal / Registro de Logs */}
      {depState.logs.length > 0 && (
        <div className="card p-5">
          <h2 className="font-display text-base font-bold mb-4">Registro de operaciones</h2>
          <div
            className="max-h-48 overflow-y-auto scrollbar-thin rounded-md p-3 text-xs font-mono leading-relaxed"
            style={{ backgroundColor: 'oklch(0.15 0 0)', color: 'oklch(0.7 0 0)' }}
          >
            {depState.logs.map((log, i) => {
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
            onClick={handleDeploy}
            disabled={!canDeploy}
            className="btn btn--primary"
          >
            {depState.loading ? (
              <span className="flex items-center gap-2">
                <span className="spinner" />
                Desplegando...
              </span>
            ) : (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 15 12 19 21 15" />
                  <polyline points="3 10 12 14 21 10" />
                  <polyline points="12 3 3 7 12 11 21 7 12 3" />
                </svg>
                Iniciar migración ({domains.length > 0 ? `${domains.length} dominio${domains.length !== 1 ? 's' : ''}` : ''})
              </>
            )}
          </button>
        </div>
        {depState.statusMessage && (
          <p className="mt-3 text-xs" style={{ color: 'var(--text-muted)' }}>{depState.statusMessage}</p>
        )}
      </div>
    </div>
  );
};

export default DeploymentModule;
