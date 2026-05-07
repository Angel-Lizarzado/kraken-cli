import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useIpc, CloudflareZoneInfo } from '../hooks/useIpc';
import { useModuleState } from '../contexts/AppStateContext';

interface SyncResult {
  domain: string;
  status: 'pending' | 'processing' | 'success' | 'error';
  message: string;
}

interface DnsSyncModuleProps {
  onLog?: (message: string, type: 'info' | 'warning' | 'error' | 'success', moduleId?: string, options?: { replaceLast?: boolean }) => void;
}

const DnsSyncModule: React.FC<DnsSyncModuleProps> = ({ onLog }) => {
  const { config, getCloudflareZones, syncCloudflareDns, getDominiosProcesados } = useIpc();

  const [pleskServerName, setPleskServerName] = useState<string>('');
  const [dnsState, setDnsState] = useModuleState('dns');
  const scrollRef = useRef<HTMLDivElement>(null);
  const userScrolledUpRef = useRef(false);
  const resultsRef = useRef(dnsState.results);
  const progressRef = useRef(dnsState.progress);
  // Keep refs in sync for stale-closure-safe callbacks
  resultsRef.current = dnsState.results;
  progressRef.current = dnsState.progress;

  // Mount effect: restore cloudflare DNS state from backend + subscribe to events
  useEffect(() => {
    let api: any;
    try {
      api = (window as any).api;
    } catch { return; }
    if (!api) return;

    // 🔥 v1.14: Reset stale loading flag on mount (could be left true from previous unmount)
    if (dnsState.loading && !dnsState.results.length) {
      setDnsState({ loading: false });
    }

    // Restore state from backend (survives tab switches)
    // 🔥 v1.7.1: NO pisar loading a true si ya lo setearon (autoload se ejecuta antes)
    (async () => {
      try {
        const state = await api.invoke('get-cloudflare-status');
        if (state.results && state.results.length > 0) {
          setDnsState({ results: state.results });
          const okCount = state.results.filter((r: any) => r.status === 'success').length;
          const errCount = state.results.filter((r: any) => r.status === 'error').length;
          setDnsState({ statusMessage: `Sincronización previa: ${okCount} ok, ${errCount} errores` });
        }
        if (state.isRunning) {
          setDnsState({ loading: true });
          const processedTotal = state.results?.length || 0;
          const progressPct = state.totalDomains > 0
            ? Math.round((processedTotal / state.totalDomains) * 100)
            : state.currentProgress || 0;
          setDnsState({ progress: { current: progressPct, total: state.totalDomains || 100 } });
          setDnsState({ statusMessage: state.currentMessage || '' });
        } else if (state.results && state.results.length > 0 && !state.isRunning) {
          setDnsState({ progress: { current: 100, total: 100 } });
        }
        // 🔥 v1.7.1: si NO hay proceso corriendo y NO hay results, asegurar loading=false
        if (!state.isRunning && (!state.results || state.results.length === 0)) {
          setDnsState({ loading: false });
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
    if (!dnsState.selectedAccount || !dnsState.selectedCloud) {
      setDnsState({ domainList: '' });
      return;
    }

    // NO sobreescribir si el usuario aplicó un filtro manual
    if (dnsState.filterApplied) return;

    let cancelled = false;
    const loadDominios = async () => {
      setDnsState({ loading: true });
      try {
        const result = await getDominiosProcesados(dnsState.selectedAccount, dnsState.selectedCloud);
        if (cancelled) return;
        console.log('[DNS AUTOLOAD] account:', dnsState.selectedAccount, '| cloud:', dnsState.selectedCloud, '| result:', result);
        if (result.success && Array.isArray(result.dominios) && result.dominios.length > 0) {
          const dominios = result.dominios.map((d: any) => d.dominio || d.name || d).filter(Boolean);
          setDnsState({ domainList: dominios.join('\n') });
          if (onLog) onLog(`Dominios cargados: ${dominios.length} dominio(s) desde ${dnsState.selectedCloud}`, 'info', 'dns');
        } else {
          setDnsState({ domainList: '' });
          const reason = !result.success ? 'error de backend' : !Array.isArray(result.dominios) ? 'formato inválido' : 'ninguno encontrado';
          // 🔥 HOTFIX v1.5.6: mostrar ruta exacta del JSON en el log
          const pathInfo = (result as any)._sourcePath ? ` | ruta: ${(result as any)._sourcePath}` : '';
          console.log('[DNS AUTOLOAD] sin dominios — motivo:', reason, '| _sourcePath:', (result as any)._sourcePath, '| _fileExists:', (result as any)._fileExists);
          if (onLog) onLog(`No se encontraron dominios procesados para ${dnsState.selectedCloud} (${reason})${pathInfo}`, 'warning', 'dns');
        }
      } catch (error: any) {
        if (!cancelled) setDnsState({ domainList: '' });
        console.error('[DNS AUTOLOAD] error:', error);
        if (onLog) onLog(`Error al cargar dominios procesados: ${error.message}`, 'error', 'dns');
      } finally {
        setDnsState({ loading: false });
      }
    };

    loadDominios();
    return () => { cancelled = true; setDnsState({ loading: false }); };
  }, [dnsState.selectedAccount, dnsState.selectedCloud, getDominiosProcesados]);

  const accountsWithClouds = config?.accounts?.filter(account =>
    account.originClouds && account.originClouds.length > 0
  ) || [];

  const clouds = useMemo(() => dnsState.selectedAccount
    ? config?.accounts.find(acc => acc.name === dnsState.selectedAccount)?.originClouds || []
    : [], [config, dnsState.selectedAccount]);

  const linkedClouds = useMemo(() => clouds.filter(cloud => cloud.isLinked), [clouds]);

  // 🔥 HOTFIX v1.5.4: filtrar servidor 'Global' (no se debe mostrar nunca más)
  const allPleskServers = useMemo(() =>
    (config?.destinationServers || []).filter(s => s.name !== 'Global'),
  [config]);

  const domains = dnsState.domainList.split('\n').map(d => d.trim()).filter(d => d.length > 0);

  // Subscribe to sync events for real-time 1x1 updates
  // Uses refs for current state to avoid stale closures (mount-only deps)
  useEffect(() => {
    let api: any;
    try {
      api = (window as any).api;
    } catch { return; }
    if (!api) return;

    const handleDomainStart = (data: { phase: string; domain: string }) => {
      if (data.phase !== 'dns') return;
      const updated = resultsRef.current.map(r =>
        r.domain === data.domain
          ? { domain: data.domain, status: 'processing' as const, message: 'Sincronizando...' }
          : r
      );
      resultsRef.current = updated;
      setDnsState({ results: updated });
    };

    const handleDomainProgress = (data: { phase: string; domain: string; status: string; message: string }) => {
      if (data.phase !== 'dns') return;
      const updated = resultsRef.current.map(r =>
        r.domain === data.domain
          ? { domain: data.domain, status: data.status as SyncResult['status'], message: data.message }
          : r
      );
      resultsRef.current = updated;
      const newProgress = { ...progressRef.current, current: progressRef.current.current + 1 };
      progressRef.current = newProgress;
      setDnsState({ results: updated, progress: newProgress });
    };

    const handleSyncCompleted = (data: { success: boolean; finished?: boolean; error?: string }) => {
      setDnsState({ loading: false });
      if (data.success) {
        const okCount = resultsRef.current.filter(r => r.status === 'success').length;
        const errCount = resultsRef.current.filter(r => r.status === 'error').length;
        const total = resultsRef.current.length;
        setDnsState({ statusMessage: `Sincronización finalizada: ${okCount} exitosos, ${errCount} errores (${total} total)` });
        if (onLog) onLog(`Sincronización finalizada: ${okCount} exitosos, ${errCount} errores`, 'success', 'dns');
      } else {
        setDnsState({ statusMessage: `Error: ${data.error ?? 'Error desconocido'}` });
        if (onLog) onLog(`Error en sincronización DNS: ${data.error ?? 'Error desconocido'}`, 'error', 'dns');
      }
    };

    const handleSyncError = (data: { error: string }) => {
      setDnsState({ loading: false });
      setDnsState({ statusMessage: `Error: ${data.error}` });
      if (onLog) onLog(`Error al iniciar sincronización: ${data.error}`, 'error', 'dns');
    };
    api.receive('sync:domain-start', handleDomainStart);
    api.receive('sync:domain-progress', handleDomainProgress);
    api.receive('cloudflare:sync-completed', handleSyncCompleted);
    api.receive('cloudflare:sync-error', handleSyncError);
    const handleDomainProcessResult = (data: any) => {
      if (data.module !== 'DNS') return;
      resultsRef.current = resultsRef.current.map((r: any) =>
        r.domain === data.domain
          ? { domain: data.domain, status: data.status, message: data.message }
          : r
      );
      setDnsState({ results: resultsRef.current });
    };
    api.receive('domain-process-result', handleDomainProcessResult);
    return () => {
      api.removeListener('sync:domain-start', handleDomainStart);
      api.removeListener('sync:domain-progress', handleDomainProgress);
      api.removeListener('cloudflare:sync-completed', handleSyncCompleted);
      api.removeListener('cloudflare:sync-error', handleSyncError);
      api.removeListener('domain-process-result', handleDomainProcessResult);
    };
  }, [onLog]);

  const handleSourceAccountChange = useCallback((accountName: string) => {
    setDnsState({ selectedAccount: accountName, selectedCloud: '', results: [], zones: [], filterApplied: false });
  }, []);

  const handleSourceCloudChange = useCallback((cloudName: string) => {
    setDnsState({ selectedCloud: cloudName, results: [], filterApplied: false });
  }, []);

  const handlePleskServerChange = useCallback((serverName: string) => {
    setPleskServerName(serverName);
    setDnsState({ results: [] });
  }, []);

  // Validate Cloudflare is configured
  const cfConfigured = useMemo(() => !!(config?.cloudflare?.apiToken), [config]);

  const handleLoadZones = useCallback(async () => {
    if (domains.length === 0) return;
    if (!cfConfigured) {
      const msg = 'Cloudflare no configurado — configure el API Token en Configuración primero';
      setDnsState({ statusMessage: msg });
      if (onLog) onLog(msg, 'warning', 'dns');
      return;
    }
    // 🔥 v1.6.5: reset total antes de escanear — limpia resultados anteriores para permitir escaneo desde cero
    setDnsState({ loading: false, results: [], zones: [], statusMessage: '' });
    setDnsState({ loading: true, statusMessage: `Consultando estado Cloudflare para ${domains.length} dominio(s)...` });
    if (onLog) onLog(`Consultando estado Cloudflare para ${domains.length} dominio(s)`, 'info', 'dns', { replaceLast: true });
    setDnsState({ zones: [] });
    try {
      const raw: unknown = await getCloudflareZones(domains, dnsState.selectedAccount, dnsState.selectedCloud);
      const zonesData = raw as { zones: CloudflareZoneInfo[] } | CloudflareZoneInfo[];
      if (zonesData && !Array.isArray(zonesData) && zonesData.zones) {
        setDnsState({ zones: zonesData.zones, statusMessage: `Estado Cloudflare cargado: ${zonesData.zones.length} zona(s)` });
        if (onLog) onLog(`Estado Cloudflare cargado: ${zonesData.zones.length} zona(s)`, 'success', 'dns');
      } else if (Array.isArray(zonesData)) {
        setDnsState({ zones: zonesData, statusMessage: `Estado Cloudflare cargado: ${zonesData.length} zona(s)` });
        if (onLog) onLog(`Estado Cloudflare cargado: ${zonesData.length} zona(s)`, 'success', 'dns');
      } else {
        setDnsState({ statusMessage: 'No se encontraron zonas para los dominios especificados' });
      }
    } catch (error: unknown) {
      setDnsState({ statusMessage: `Error al cargar estado Cloudflare: ${error instanceof Error ? error.message : String(error)}` });
      if (onLog) onLog(`Error al cargar zonas Cloudflare: ${error instanceof Error ? error.message : String(error)}`, 'error', 'dns');
    } finally {
      setDnsState({ loading: false });
    }
  }, [domains, dnsState.selectedAccount, dnsState.selectedCloud, getCloudflareZones, onLog, cfConfigured]);

  const handleSyncAll = useCallback(async () => {
    if (domains.length === 0 || !pleskServerName) return;

    const selectedServer = allPleskServers.find(s => s.name === pleskServerName);
    if (!selectedServer) return;
    const pleskIp = selectedServer.sshCredentials.host;

    // ── Filtrar dominios que ya están correctos ──
    let domainsToSync = domains;
    if (dnsState.zones && dnsState.zones.length > 0) {
      const zoneMap = new Map(dnsState.zones.map(z => [z.domain, z]));
      const filtered = domains.filter(domain => {
        const zone = zoneMap.get(domain);
        if (!zone) return true; // sin datos → procesar
        if (zone.error) return true; // error → procesar
        if (!zone.aRecord) return true; // sin registro A → procesar
        if (zone.aRecord.ip !== pleskIp) return true; // IP incorrecta → procesar
        // Zona activa, A record apuntando al Plesk correcto → SALTAR
        if (zone.zoneStatus === 'active' && zone.aRecord.ip === pleskIp && zone.aRecord.proxied) {
          return false;
        }
        return true;
      });

      if (filtered.length < domains.length) {
        const skipped = domains.length - filtered.length;
        setDnsState({ statusMessage: `Filtrando ${skipped} dominio(s) ya correctos. Procesando ${filtered.length}...` });
        if (onLog) onLog(`${skipped} dominio(s) omitidos (ya activos con IP correcta). Procesando ${filtered.length}...`, 'info', 'dns');
        domainsToSync = filtered;
      }
    }

    if (domainsToSync.length === 0) {
      setDnsState({ statusMessage: 'Todos los dominios ya están sincronizados correctamente' });
      if (onLog) onLog('Todos los dominios ya están sincronizados correctamente', 'success', 'dns');
      return;
    }

    const initialResults = domainsToSync.map(d => ({ domain: d, status: 'pending' as const, message: '' }));
    resultsRef.current = initialResults;
    const initialProgress = { current: 0, total: domainsToSync.length };
    progressRef.current = initialProgress;

    setDnsState({ loading: true, results: initialResults, progress: initialProgress, statusMessage: `Sincronizando DNS para ${domainsToSync.length} dominio(s)...` });
    userScrolledUpRef.current = false;
    if (onLog) onLog(`Iniciando sincronización DNS: ${domainsToSync.length} dominio(s) → ${pleskIp}`, 'info', 'dns', { replaceLast: true });

    // Fire-and-forget: resultados via sync:domain-progress + state:update + cloudflare:sync-completed
    syncCloudflareDns(domainsToSync, pleskIp, dnsState.selectedAccount, dnsState.selectedCloud);
  }, [domains, pleskServerName, allPleskServers, syncCloudflareDns, dnsState.selectedAccount, dnsState.selectedCloud, dnsState.zones, onLog, setDnsState]);

  // Smart scroll: auto-scroll solo si el usuario está cerca del fondo
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (!userScrolledUpRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [dnsState.results]);

  // 🔥 v1.7.1: canSync se desbloquea si hay resultados (éxito o error) o zonas cargadas
  const canLoadZones = domains.length > 0 && !dnsState.loading;
  const hasResultsOrZones = dnsState.results.length > 0 || (dnsState.zones?.length ?? 0) > 0;
  const canSync = domains.length > 0 && pleskServerName && (!dnsState.loading || hasResultsOrZones);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-xl font-bold">DNS Sync</h1>
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Fase 3: Sincronización de DNS con Cloudflare</p>
      </div>

      {/* Configuración */}
      <div className="card p-5">
        <h2 className="font-display text-base font-bold mb-4">Configuración</h2>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Cuenta origen</label>
            <select
              value={dnsState.selectedAccount}
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
              value={dnsState.selectedCloud}
              onChange={e => handleSourceCloudChange(e.target.value)}
              className="input"
              disabled={!dnsState.selectedAccount}
            >
              <option value="">Seleccionar cloud</option>
              {clouds.map(cloud => (
                <option key={cloud.name} value={cloud.name}>
                  {cloud.name} {cloud.isLinked ? '(SSH OK)' : '(SSH pendiente)'}
                </option>
              ))}
            </select>
            {dnsState.selectedCloud && !linkedClouds.find(c => c.name === dnsState.selectedCloud) && (
              <div className="mt-1.5 text-xs" style={{ color: 'var(--color-warning)' }}>
                Este cloud no tiene SSH vinculado. Vincúlelo desde el Panel primero.
              </div>
            )}
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
              Dominios a sincronizar
              {domains.length > 0 && (
                <span className="ml-2 font-mono text-xs" style={{ color: 'var(--text-muted)' }}>
                  ({domains.length} dominio{domains.length !== 1 ? 's' : ''})
                </span>
              )}
              {dnsState.loading && (
                <span className="ml-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                  <span className="spinner" style={{ display: 'inline-block', width: 10, height: 10, borderWidth: 1.5, marginRight: 4 }} />
                  Cargando...
                </span>
              )}
            </label>
            <textarea
              value={dnsState.domainList}
              onChange={e => setDnsState({ domainList: e.target.value, filterApplied: true })}
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

      {/* Estado Cloudflare */}
      {dnsState.zones && dnsState.zones.length > 0 && (
        <div className="card p-5">
          <h2 className="font-display text-base font-bold mb-4">Estado Cloudflare</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left" style={{ color: 'var(--text-muted)' }}>
                  <th className="pb-2 pr-3 font-medium">Dominio</th>
                  <th className="pb-2 pr-3 font-medium">IP Cloudflare</th>
                  <th className="pb-2 pr-3 font-medium">Proxy</th>
                  <th className="pb-2 pr-3 font-medium">Estado</th>
                  <th className="pb-2 pr-3 font-medium">Última Sincronización</th>
                </tr>
              </thead>
              <tbody>
                {dnsState.zones.map((zone, i) => (
                  <tr key={i} className="border-t" style={{ borderTopColor: 'var(--border-default)' }}>
                    <td className="py-2 pr-3 font-mono" style={{ color: 'var(--text-secondary)' }}>{zone.domain}</td>
                    <td className="py-2 pr-3 font-mono" style={{ color: 'var(--text-secondary)' }}>{zone.aRecord?.ip || '—'}</td>
                    <td className="py-2 pr-3">
                      {zone.aRecord ? (
                        zone.aRecord.proxied ? (
                          <span className="flex items-center gap-1" style={{ color: 'var(--color-success)' }}>
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                            Sí
                          </span>
                        ) : (
                          <span className="flex items-center gap-1" style={{ color: 'var(--color-error)' }}>
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <circle cx="12" cy="12" r="10" />
                              <line x1="15" y1="9" x2="9" y2="15" />
                              <line x1="9" y1="9" x2="15" y2="15" />
                            </svg>
                            No
                          </span>
                        )
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      {zone.error ? (
                        <span className="inline-flex items-center gap-1" style={{ color: 'var(--color-error)' }}>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="12" cy="12" r="10" />
                            <line x1="15" y1="9" x2="9" y2="15" />
                            <line x1="9" y1="9" x2="15" y2="15" />
                          </svg>
                          Error
                        </span>
                      ) : !zone.aRecord ? (
                        <span className="inline-flex items-center gap-1" style={{ color: 'var(--color-warning)' }}>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="12" cy="12" r="10" />
                            <line x1="12" y1="8" x2="12" y2="12" />
                            <line x1="12" y1="16" x2="12.01" y2="16" />
                          </svg>
                          Sin registro A
                        </span>
                      ) : (
                        <span
                          className="inline-flex items-center gap-1"
                          style={{
                            color: zone.zoneStatus === 'active' ? 'var(--color-success)' :
                                   'var(--color-warning)',
                          }}
                        >
                          {zone.zoneStatus === 'active' ? (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                          ) : (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <circle cx="12" cy="12" r="10" />
                              <line x1="12" y1="8" x2="12" y2="12" />
                              <line x1="12" y1="16" x2="12.01" y2="16" />
                            </svg>
                          )}
                          {zone.zoneStatus === 'active' ? 'Activa' : zone.zoneStatus}
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-3" style={{ color: 'var(--text-muted)' }}>
                      {zone.lastCloudflareSync ? new Date(zone.lastCloudflareSync).toLocaleString('es-AR') : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Sync Results */}
      {dnsState.results.length > 0 && (
        <div className="card p-5">
          <h2 className="font-display text-base font-bold mb-4">Resultados de sincronización</h2>
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
            {dnsState.results.map((r, i) => (
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
                <span style={{
                  color:
                    r.status === 'pending' ? 'var(--text-muted)' :
                    r.status === 'processing' ? 'var(--color-info)' :
                    r.status === 'success' ? 'var(--color-success)' :
                    'var(--color-error)'
                }}>{r.message || (r.status === 'pending' ? 'Pendiente' : r.status === 'processing' ? 'Sincronizando...' : '')}</span>
              </div>
            ))}
          </div>
          <div className="mt-3 pt-3 border-t flex gap-4 text-xs" style={{ borderTopColor: 'var(--border-default)', color: 'var(--text-muted)' }}>
            <span>Total: {dnsState.results.length}</span>
            <span style={{ color: 'var(--color-success)' }}>Exitosos: {dnsState.results.filter(r => r.status === 'success').length}</span>
            <span style={{ color: 'var(--color-info)' }}>Pendientes: {dnsState.results.filter(r => r.status === 'pending' || r.status === 'processing').length}</span>
            <span style={{ color: 'var(--color-error)' }}>Fallidos: {dnsState.results.filter(r => r.status === 'error').length}</span>
          </div>
        </div>
      )}

      {/* Acciones */}
      <div className="card p-5">
        <h2 className="font-display text-base font-bold mb-4">Acciones</h2>
        <div className="flex flex-col md:flex-row gap-4">
          <button
            onClick={handleLoadZones}
            disabled={!canLoadZones}
            className="btn btn--primary"
          >
            {dnsState.loading && !dnsState.results.length ? (
              <span className="flex items-center gap-2">
                <span className="spinner" />
                Consultando...
              </span>
            ) : (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>
                Cargar estado Cloudflare
              </>
            )}
          </button>
          <button
            onClick={handleSyncAll}
            disabled={!canSync}
            className="btn btn--primary"
          >
            {dnsState.loading && dnsState.results.length > 0 ? (
              <span className="flex items-center gap-2">
                <span className="spinner" />
                Sincronizando... ({dnsState.progress.current} / {dnsState.progress.total})
              </span>
            ) : (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="23 4 23 10 17 10" />
                  <polyline points="1 20 1 14 7 14" />
                  <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                </svg>
                Sincronizar todo con Cloudflare
              </>
            )}
          </button>
        </div>
        {dnsState.statusMessage && (
          <p className="mt-3 text-xs" style={{ color: 'var(--text-muted)' }}>{dnsState.statusMessage}</p>
        )}
      </div>
    </div>
  );
};

export default DnsSyncModule;
