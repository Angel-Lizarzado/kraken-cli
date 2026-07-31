import { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { LogLevel } from '../types/ipc';

// ── Types ─────────────────────────────────────────────────────────────────────

interface DomainEntry {
  domain: string;
  status: 'idle' | 'running' | 'success' | 'error';
  steps: Array<{ msg: string; level: string }>;
  error?: string;
  duration?: number;
}

type CmsMode = 'full' | 'core-only' | 'security-only' | 'solo-plugin';

interface WpVersion { version: string; estado: string; esUltima?: boolean; }

interface CmsProgress {
  type: string;
  domain?: string;
  msg?: string;
  level?: string;
  success?: boolean;
  duration?: number;
  total?: number;
}

interface Props {
  onLog: (msg: string, type?: LogLevel) => void;
  logs?: { message: string; type: string; timestamp?: number; source?: string }[];
}

// ── Badge component ───────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: DomainEntry['status'] }) {
  const map = {
    idle:    { label: 'Pendiente', color: '#a5a5a5',    bg: 'rgba(255, 255, 255, 0.05)' },
    running: { label: '⟳ Procesando', color: '#f59e0b',         bg: 'oklch(0.55 0.15 75 / 0.15)' },
    success: { label: '✓ OK',       color: '#33d9b2', bg: 'oklch(0.55 0.15 145 / 0.12)' },
    error:   { label: '✗ Error',    color: '#ff5252',   bg: 'oklch(0.45 0.12 25 / 0.12)' },
  };
  const s = map[status];
  return (
    <span className="text-[10px] font-mono px-2 py-0.5 rounded-full"
      style={{ color: s.color, backgroundColor: s.bg, border: `1px solid ${s.color}30` }}>
      {s.label}
    </span>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function CmsReconstructorModule({ onLog }: Props) {
  const api = (window as any).api;

  // Config
  const [serverName, setServerName]   = useState('');
  const [domainsRaw, setDomainsRaw]   = useState('');
  const [localZipPath, setLocalZipPath] = useState('');
  const [targetPhpVersion, setTargetPhpVersion] = useState('Mantener actual');
  const [targetWpVersion, setTargetWpVersion]   = useState('');
  const [mode, setMode]               = useState<CmsMode>('full');
  const [dryRun, setDryRun]           = useState(false);
  const [phpSwitch, setPhpSwitch]     = useState(false);
  const [servers, setServers]         = useState<string[]>([]);
  
  // Audit Table State
  const [auditPhase, setAuditPhase]   = useState<'idle' | 'auditing' | 'results'>('idle');
  const [auditResults, setAuditResults] = useState<any[]>([]);
  const [selectedDomains, setSelectedDomains] = useState<Set<string>>(new Set());
  const [auditMsg, setAuditMsg]       = useState('');
  
  // Versions
  const [versionesPHP, setVersionesPHP] = useState<any[]>([]);
  const [isLoadingVersions, setIsLoadingVersions] = useState(false);

  // Runtime
  const [isRunning, setIsRunning]     = useState(false);
  const [entries, setEntries]         = useState<DomainEntry[]>([]);
  const [openDomains, setOpenDomains] = useState<Set<string>>(new Set());
  const [filterFailed, setFilterFailed] = useState(false);
  const [globalMsg, setGlobalMsg]     = useState('');

  // Stats
  const succeeded = entries.filter(e => e.status === 'success').length;
  const failed    = entries.filter(e => e.status === 'error').length;
  const running   = entries.filter(e => e.status === 'running').length;
  const total     = entries.length;
  const visibleEntries = filterFailed ? entries.filter(e => e.status === 'error') : entries;

  // Hydrate servers list from config
  useEffect(() => {
    api?.invoke('config:get').then((cfg: any) => {
      if (cfg?.destinationServers) {
        setServers(cfg.destinationServers.map((s: any) => s.name));
        if (cfg.destinationServers.length > 0) setServerName(cfg.destinationServers[0].name);
      }
    }).catch(() => {});

    // Hydrate persisted state
    api?.invoke('cms:get-state').then((res: any) => {
      if (!res?.state) return;
      const s = res.state;
      if (s.history?.length > 0) {
        setEntries(s.history.map((h: any) => ({
          domain: h.domain,
          status: h.status === 'success' ? 'success' : 'error',
          steps: h.error ? [{ msg: h.error, level: 'error' }] : [],
          error: h.error,
          duration: h.duration,
        })));
      }
      if (s.isRunning) setIsRunning(true);
    }).catch(() => {});
  }, []);

  // Hydrate versions when server changes
  useEffect(() => {
    if (!serverName) {
      setVersionesPHP([]);
      return;
    }
    setIsLoadingVersions(true);
    api?.invoke('reconstructor:obtener-versiones', { serverName })
      .then((res: any) => {
        if (res?.success && res.versiones?.php?.exito) {
          setVersionesPHP(res.versiones.php.versiones || []);
          if (res.versiones.php.versiones?.length > 0) {
            setTargetPhpVersion(res.versiones.php.versiones[0].idCrudo);
          }
        } else {
          setVersionesPHP([]);
        }
      })
      .catch(() => {
        setVersionesPHP([]);
      })
      .finally(() => {
        setIsLoadingVersions(false);
      });
  }, [serverName]);

  // Fix 4.5: Prevenir duplicado de eventos de auditoría
  const auditOwner = useRef(false);

  // Audit Progress Listener
  useEffect(() => {
    const handler = (ev: any) => {
      if (!auditOwner.current) return;
      if (!ev) return;
      if (ev.type === 'audit-start') { setAuditMsg(ev.msg || ''); return; }
      if (ev.type === 'audit-domains-found') { setAuditMsg(ev.msg || ''); return; }
      if (ev.type === 'domain-audited') {
        if (ev.isWp !== false && ev.domain) {
          setAuditResults(prev => {
            const entry = {
              domain: ev.domain,
              wpVersion: ev.wpVersion,
              pluginCount: ev.pluginCount,
              phpHandler: ev.phpHandler,
              error: ev.error,
            };
            const idx = prev.findIndex(r => r.domain === ev.domain);
            if (idx >= 0) { const n = [...prev]; n[idx] = entry; return n; }
            return [...prev, entry];
          });
        }
        return;
      }
      if (ev.type === 'audit-done') {
        setAuditPhase('results');
        setAuditMsg(ev.msg || '');
        if (ev.results) setAuditResults(ev.results.filter((r: any) => r.isWp));
        auditOwner.current = false;
        return;
      }
      if (ev.type === 'audit-error') { 
        setAuditPhase('results'); 
        setAuditMsg(`Error: ${ev.msg}`); 
        auditOwner.current = false;
        return; 
      }
    };
    api?.receive('cms:audit-progress', handler);
    return () => { api?.removeListener?.('cms:audit-progress', handler); };
  }, []);

  // Fix 4: Prevenir duplicado de eventos cuando CmsAuditTab está activo.
  // Este módulo solo procesa eventos si FUE ÉL quien inició el batch.
  const batchOwner = useRef(false);

  // cms:progress listener
  useEffect(() => {
    const handler = (event: CmsProgress) => {
      // Ignorar eventos si el batch fue iniciado por CmsAuditTab, no por este módulo
      if (!batchOwner.current) return;
      if (!event) return;

      if (event.type === 'batch-start') {
        setGlobalMsg(event.msg || '');
        setIsRunning(true);
        return;
      }
      if (event.type === 'batch-done') {
        setGlobalMsg(event.msg || '');
        setIsRunning(false);
        batchOwner.current = false; // liberar ownership
        return;
      }
      if (event.type === 'php-switch') {
        setGlobalMsg(event.msg || '');
        return;
      }
      
      if (event.type === 'upload-start' || event.type === 'upload-done') {
        const uploadKey = '__upload_elementor__';
        setOpenDomains(prev => new Set([...prev, uploadKey]));
        setEntries(prev => {
          const exists = prev.find(e => e.domain === uploadKey);
          const stepMsg = { msg: event.msg || 'Subiendo Elementor...', level: event.level || 'info' };
          
          if (exists) {
            return prev.map(e => e.domain === uploadKey 
              ? { ...e, status: event.type === 'upload-done' ? 'success' : 'running', steps: [...e.steps, stepMsg] } 
              : e);
          }
          return [{ domain: uploadKey, status: event.type === 'upload-done' ? 'success' : 'running', steps: [stepMsg] }, ...prev];
        });
        setGlobalMsg(event.msg || '');
        return;
      }

      const domain = event.domain;
      if (!domain) return;

      if (event.type === 'domain-start') {
        setOpenDomains(prev => new Set([...prev, domain]));
        setEntries(prev => {
          const exists = prev.find(e => e.domain === domain);
          if (exists) return prev.map(e => e.domain === domain ? { ...e, status: 'running', steps: [] } : e);
          return [...prev, { domain, status: 'running', steps: [] }];
        });
        return;
      }

      if (event.type === 'domain-step') {
        setEntries(prev => prev.map(e =>
          e.domain === domain
            ? { ...e, steps: [...e.steps, { msg: event.msg || '', level: event.level || 'info' }] }
            : e
        ));
        return;
      }

      if (event.type === 'domain-done') {
        setEntries(prev => prev.map(e =>
          e.domain === domain
            ? { ...e, status: 'success', duration: event.duration }
            : e
        ));
        setOpenDomains(prev => { const n = new Set(prev); n.delete(domain); return n; });
        return;
      }

      if (event.type === 'domain-error') {
        setEntries(prev => prev.map(e =>
          e.domain === domain
            ? { ...e, status: 'error', error: event.msg, duration: event.duration }
            : e
        ));
        return;
      }
    };

    api?.receive('cms:progress', handler);
    return () => { api?.removeListener('cms:progress', handler); };
  }, []);

  // ── Actions ───────────────────────────────────────────────────────────────

  const handleAudit = useCallback(async () => {
    if (!serverName) return;
    auditOwner.current = true;
    setAuditPhase('auditing');
    setAuditResults([]);
    setSelectedDomains(new Set());
    setAuditMsg('');
    await api?.invoke('cms:audit-server', { serverName });
  }, [serverName]);

  const handleStart = useCallback(async () => {
    const domains = [...selectedDomains];
    if (!domains.length) return;
    if (!serverName) return;

    batchOwner.current = true; // Fix 4: este módulo es el dueño del batch
    setEntries(domains.map(domain => ({ domain, status: 'idle', steps: [] })));
    setOpenDomains(new Set());
    setFilterFailed(false);
    setGlobalMsg('');

    const res = await api?.invoke('cms:start-batch', {
      serverName, domains, localZipPath: localZipPath || null,
      targetPhpVersion, mode, dryRun, phpSwitch,
    });
    if (!res?.success) {
      batchOwner.current = false;
      setGlobalMsg(`Error: ${res?.error || 'No se pudo iniciar'}`);
      onLog(`[CMS] ${res?.error}`, 'error');
    }
  }, [serverName, selectedDomains, localZipPath, targetPhpVersion, mode, dryRun, phpSwitch, onLog]);

  const handleAbort = useCallback(async () => {
    await api?.invoke('cms:abort');
    setIsRunning(false);
    if (auditPhase === 'auditing') {
      setAuditPhase('results');
      setAuditMsg('⛔ Auditoría abortada por el usuario.');
    }
  }, []);

  const handlePickZip = useCallback(async () => {
    const result = await api?.invoke('dialog:open-file', {
      title: 'Seleccionar ZIP Plugin',
      filters: [{ name: 'ZIP', extensions: ['zip'] }],
    });
    if (result?.filePath) setLocalZipPath(result.filePath);
  }, []);

  const toggleDomain = useCallback((domain: string) => {
    setOpenDomains(prev => {
      const next = new Set(prev);
      if (next.has(domain)) next.delete(domain);
      else next.add(domain);
      return next;
    });
  }, []);

  const exportCsv = useCallback(() => {
    const rows = ['dominio,estado,duracion_s,error'];
    entries.forEach(e => {
      rows.push([e.domain, e.status, ((e.duration || 0) / 1000).toFixed(1), e.error || ''].join(','));
    });
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cms-reconstructor-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [entries]);

  return (
    <div className="flex flex-col h-full bg-background overflow-hidden">
      
      {/* ── Page Header ── */}
      <div className="flex-none px-lg pt-lg pb-md">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-md">
          <div>
            <h2 className="font-display-lg text-display-lg text-secondary mb-xs">CMS Reconstructor</h2>
            <p className="font-body-md text-on-surface-variant max-w-2xl">
              Reconstrucción industrial de WordPress — hasta 600 dominios. Modo Core, Seguridad o Full.
            </p>
          </div>
          <div className="flex gap-sm shrink-0">
            {entries.length > 0 && (
              <button onClick={exportCsv} className="flex items-center gap-xs px-md py-sm font-label-caps text-label-caps bg-surface-container-highest text-on-surface-variant rounded border border-outline-variant hover:bg-surface-bright transition-all active:scale-95">
                Exportar CSV
              </button>
            )}
            {isRunning || auditPhase === 'auditing' ? (
              <button onClick={handleAbort} className="flex items-center gap-xs px-md py-sm font-title-sm bg-error/20 text-error hover:bg-error/30 rounded border border-error/50 transition-all active:scale-95">
                ⛔ Abortar
              </button>
            ) : (
              <button onClick={handleStart} disabled={!selectedDomains.size || !serverName || isLoadingVersions}
                className={`flex items-center gap-xs px-md py-sm font-title-sm rounded transition-all active:scale-95 ${
                  selectedDomains.size && serverName && !isLoadingVersions
                    ? 'bg-secondary-container text-on-secondary-container hover:brightness-110'
                    : 'bg-surface-container-highest text-outline cursor-not-allowed'
                }`}>
                {isLoadingVersions ? '⏳ Cargando...' : '🚀 Iniciar Reconstrucción'}
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-lg pb-lg space-y-md">

        {/* ── Progress Dashboard ── */}
        {entries.length > 0 && (
          <div className="bg-surface-container-low border border-outline-variant p-md">
            <div className="grid grid-cols-4 gap-md text-center">
              <div>
                <div className="font-display text-2xl text-on-surface">{total}</div>
                <div className="font-label-caps text-label-caps text-outline mt-xs">TOTAL</div>
              </div>
              <div>
                <div className="font-display text-2xl text-green-400">{succeeded}</div>
                <div className="font-label-caps text-label-caps text-outline mt-xs">OK</div>
              </div>
              <div>
                <div className="font-display text-2xl text-error">{failed}</div>
                <div className="font-label-caps text-label-caps text-outline mt-xs">ERROR</div>
              </div>
              <div>
                <div className="font-display text-2xl text-secondary">{running}</div>
                <div className="font-label-caps text-label-caps text-outline mt-xs">ACTIVOS</div>
              </div>
            </div>
            {total > 0 && (
              <div className="mt-md w-full bg-surface-container-highest h-1.5 rounded-full overflow-hidden">
                <div className="h-full transition-all duration-500"
                  style={{
                    width: `${((succeeded + failed) / total) * 100}%`,
                    backgroundColor: failed > 0 ? '#ff5252' : '#33d9b2',
                  }} />
              </div>
            )}
            {globalMsg && (
              <p className="font-code-sm text-code-sm text-outline mt-sm text-center">{globalMsg}</p>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-[340px_1fr] gap-md">
          {/* ── Config Panel ── */}
          <div className="bg-surface-container-low border border-outline-variant p-md space-y-md h-fit">
            <h2 className="font-label-caps text-label-caps text-outline uppercase">Configuración</h2>

            {/* Servidor */}
            <div className="space-y-xs">
              <label className="font-label-caps text-label-caps text-outline">Servidor Plesk</label>
              <select value={serverName} onChange={e => setServerName(e.target.value)}
                className="w-full bg-surface-container border border-outline-variant text-on-surface focus:border-secondary focus:ring-1 focus:ring-secondary font-body-md rounded px-sm py-sm">
                <option value="">— Selecciona servidor —</option>
                {servers.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>

            {/* Versión PHP Destino */}
            <div className="space-y-xs">
              <label className="font-label-caps text-label-caps text-outline flex justify-between">
                <span>Versión PHP Destino</span>
                {isLoadingVersions && <span className="animate-pulse text-secondary">Cargando...</span>}
              </label>
              <select value={targetPhpVersion} onChange={e => setTargetPhpVersion(e.target.value)}
                className="w-full bg-surface-container border border-outline-variant text-on-surface focus:border-secondary focus:ring-1 focus:ring-secondary font-body-md rounded px-sm py-sm disabled:opacity-50"
                disabled={isLoadingVersions || versionesPHP.length === 0}>
                {versionesPHP.length === 0 ? (
                  <option value="Mantener actual">Mantener actual</option>
                ) : (
                  <>
                    <option value="Mantener actual">Mantener actual</option>
                    {versionesPHP.map(v => (
                      <option key={v.idCrudo} value={v.idCrudo}>
                        {v.version} — {v.etiquetaCompleta}
                      </option>
                    ))}
                  </>
                )}
              </select>
            </div>

            {/* Modo */}
            <div className="space-y-xs">
              <label className="font-label-caps text-label-caps text-outline">Modo</label>
              <div className="grid grid-cols-2 gap-sm">
                {(['full', 'core-only', 'security-only', 'solo-plugin'] as CmsMode[]).map(m => (
                  <button key={m} onClick={() => setMode(m)}
                    className={`font-label-caps text-[10px] px-sm py-sm rounded border transition-all ${
                      mode === m
                        ? 'bg-secondary-container/20 text-secondary border-secondary/50'
                        : 'bg-surface-container text-outline border-outline-variant hover:border-outline'
                    }`}>
                    {m === 'full' ? 'Full' : m === 'core-only' ? 'Solo Core' : m === 'security-only' ? 'Seguridad' : 'Plugin'}
                  </button>
                ))}
              </div>
            </div>

            {/* ZIP Plugin */}
            {(mode === 'full' || mode === 'solo-plugin') && (
              <div className="space-y-xs">
                <label className="font-label-caps text-label-caps text-outline">ZIP Plugin</label>
                <div className="flex gap-sm">
                  <input type="text" value={localZipPath} onChange={e => setLocalZipPath(e.target.value)}
                    placeholder="Ruta local del .zip" className="w-full bg-surface-container border border-outline-variant text-on-surface font-code-sm px-sm py-sm rounded" readOnly />
                  <button onClick={handlePickZip} className="px-sm py-sm bg-surface-container-highest border border-outline-variant rounded hover:bg-surface-bright transition-colors text-on-surface-variant">
                    <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" /></svg>
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* ── Domains Table / Audit ── */}
          <div className="bg-surface-container-low border border-outline-variant flex flex-col min-h-[300px]">
            <div className="bg-surface-container-high px-md py-sm flex items-center justify-between border-b border-outline-variant shrink-0">
              <span className="font-label-caps text-label-caps text-on-surface">
                Dominios WP: {auditResults.length} / Sel: {selectedDomains.size}
              </span>
              <button onClick={handleAudit} disabled={!serverName || auditPhase === 'auditing'}
                className="flex items-center gap-xs px-sm py-1 font-label-caps text-label-caps bg-surface-container-highest text-on-surface-variant rounded border border-outline-variant hover:bg-surface-bright transition-all disabled:opacity-50">
                {auditPhase === 'auditing' ? '⏳ Auditando...' : '🔍 Auditar Servidor'}
              </button>
            </div>
            
            <div className="flex-1 overflow-auto">
              <table className="w-full border-collapse">
                <thead className="sticky top-0 bg-surface-container-low border-b border-outline-variant">
                  <tr className="text-left">
                    <th className="px-md py-sm w-12">
                      <input type="checkbox"
                        className="accent-secondary"
                        checked={auditResults.length > 0 && selectedDomains.size === auditResults.length}
                        onChange={() => {
                          if (selectedDomains.size === auditResults.length) setSelectedDomains(new Set());
                          else setSelectedDomains(new Set(auditResults.map(r => r.domain)));
                        }} />
                    </th>
                    <th className="px-md py-sm font-label-caps text-label-caps text-outline uppercase">Dominio</th>
                    <th className="px-md py-sm font-label-caps text-label-caps text-outline uppercase">WP Ver.</th>
                    <th className="px-md py-sm font-label-caps text-label-caps text-outline uppercase">Plugins</th>
                    <th className="px-md py-sm font-label-caps text-label-caps text-outline uppercase">PHP</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-outline-variant/30">
                  {auditResults.map(row => (
                    <tr key={row.domain}
                      onClick={() => {
                        const n = new Set(selectedDomains);
                        n.has(row.domain) ? n.delete(row.domain) : n.add(row.domain);
                        setSelectedDomains(n);
                      }}
                      className={`hover:bg-surface-container-high transition-colors cursor-pointer ${
                        selectedDomains.has(row.domain) ? 'bg-secondary-container/5' : ''
                      }`}>
                      <td className="px-md py-sm">
                        <input type="checkbox" className="accent-secondary" checked={selectedDomains.has(row.domain)} readOnly />
                      </td>
                      <td className="px-md py-sm font-code-md text-code-md text-on-surface">
                        {row.domain}
                      </td>
                      <td className="px-md py-sm font-code-sm text-code-sm text-on-surface-variant">
                        {row.wpVersion || '?'}
                      </td>
                      <td className="px-md py-sm font-code-sm text-code-sm text-on-surface-variant">
                        {row.pluginCount ?? '?'}
                      </td>
                      <td className="px-md py-sm font-code-sm text-code-sm text-outline">
                        {row.phpHandler ? row.phpHandler.replace(/.*plesk-php|\/php.*/, '').trim() : '?'}
                      </td>
                    </tr>
                  ))}
                  {auditResults.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-md py-xl text-center text-on-surface-variant font-body-sm">
                        {auditPhase === 'idle' ? 'Haz clic en Auditar Servidor para cargar dominios de Plesk' : 'Sin dominios compatibles'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {auditMsg && (
              <div className="bg-surface-container-lowest border-t border-outline-variant px-md py-sm">
                <p className="font-code-sm text-code-sm text-outline truncate">{auditMsg}</p>
              </div>
            )}
          </div>
        </div>

        {/* ── Terminal Accordion (Per Domain Logs) ── */}
        {entries.length > 0 && (
          <div className="bg-surface-container-low border border-outline-variant flex flex-col">
            <div className="bg-surface-container-high px-md py-sm flex items-center justify-between border-b border-outline-variant shrink-0">
              <span className="font-title-sm text-on-surface">Progreso por dominio</span>
              <label className="flex items-center gap-sm cursor-pointer">
                <input type="checkbox" checked={filterFailed} onChange={e => setFilterFailed(e.target.checked)}
                  className="accent-secondary" />
                <span className="font-label-caps text-label-caps text-outline">
                  Ver solo fallidos ({failed})
                </span>
              </label>
            </div>
            
            <div className="divide-y divide-outline-variant/30">
              {visibleEntries.map(entry => (
                <div key={entry.domain} className="bg-surface-container-lowest">
                  {/* Accordion header */}
                  <button
                    onClick={() => toggleDomain(entry.domain)}
                    className="w-full flex items-center gap-md px-md py-sm text-left hover:bg-surface-container-high transition-colors"
                  >
                    <StatusBadge status={entry.status} />
                    <span className="font-code-md text-code-md text-on-surface flex-1">
                      {entry.domain}
                    </span>
                    {entry.duration && (
                      <span className="font-code-sm text-code-sm text-outline">
                        {(entry.duration / 1000).toFixed(1)}s
                      </span>
                    )}
                    <span className="text-outline text-[10px]">
                      {openDomains.has(entry.domain) ? '▲' : '▼'}
                    </span>
                  </button>

                  {/* Accordion body (Terminal for this domain) */}
                  <AnimatePresence initial={false}>
                    {openDomains.has(entry.domain) && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.15 }}
                        className="overflow-hidden"
                      >
                        <div className="bg-black border-t border-outline-variant/50 p-md font-code-sm text-code-sm overflow-y-auto max-h-60 space-y-[2px] scanline-effect">
                          {entry.steps.length === 0 ? (
                            <p className="text-outline italic">Esperando inicio...</p>
                          ) : entry.steps.map((step, i) => {
                            const colorClass = 
                              step.level === 'error' ? 'text-error' :
                              step.level === 'success' ? 'text-green-400' :
                              step.level === 'warn' ? 'text-tertiary' :
                              'text-on-surface-variant';
                            return (
                              <p key={i} className={`leading-relaxed break-all ${colorClass}`}>
                                {step.msg}
                              </p>
                            );
                          })}
                          {entry.status === 'running' && (
                            <p className="text-secondary animate-pulse mt-sm">▌ Procesando...</p>
                          )}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              ))}
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
