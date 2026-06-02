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

type CmsMode = 'full' | 'core-only' | 'security-only';

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

interface Props { onLog: (msg: string, type?: LogLevel) => void }

// ── Badge component ───────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: DomainEntry['status'] }) {
  const map = {
    idle:    { label: 'Pendiente', color: 'var(--text-muted)',    bg: 'var(--surface-overlay)' },
    running: { label: '⟳ Procesando', color: '#f59e0b',         bg: 'oklch(0.55 0.15 75 / 0.15)' },
    success: { label: '✓ OK',       color: 'var(--color-success)', bg: 'oklch(0.55 0.15 145 / 0.12)' },
    error:   { label: '✗ Error',    color: 'var(--color-error)',   bg: 'oklch(0.45 0.12 25 / 0.12)' },
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
  const [dryRun, setDryRun]           = useState(true);
  const [phpSwitch, setPhpSwitch]     = useState(true);
  const [servers, setServers]         = useState<string[]>([]);
  
  // Versions
  const [versionesWP, setVersionesWP] = useState<WpVersion[]>([]);
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
      setVersionesWP([]);
      return;
    }
    setIsLoadingVersions(true);
    (window as any).krakenAPI?.reconstructor?.obtenerVersiones(serverName)
      .then((res: any) => {
        if (res?.success && res.versiones) {
          setVersionesWP(res.versiones.wp || []);
          if (res.versiones.wp?.length > 0) setTargetWpVersion(res.versiones.wp[0].version);
        } else {
          setVersionesWP([]);
        }
      })
      .catch(() => {
        setVersionesWP([]);
      })
      .finally(() => {
        setIsLoadingVersions(false);
      });
  }, [serverName]);

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

  const handleStart = useCallback(async () => {
    const domains = domainsRaw.split('\n').map(d => d.trim()).filter(Boolean);
    if (!domains.length) return;
    if (!serverName) return;

    batchOwner.current = true; // Fix 4: este módulo es el dueño del batch
    setEntries(domains.map(domain => ({ domain, status: 'idle', steps: [] })));
    setOpenDomains(new Set());
    setFilterFailed(false);
    setGlobalMsg('');

    const res = await api?.invoke('cms:start-batch', {
      serverName, domains, localZipPath: localZipPath || null,
      targetPhpVersion, targetWpVersion, mode, dryRun, phpSwitch,
    });
    if (!res?.success) {
      batchOwner.current = false;
      setGlobalMsg(`Error: ${res?.error || 'No se pudo iniciar'}`);
      onLog(`[CMS] ${res?.error}`, 'error');
    }
  }, [serverName, domainsRaw, localZipPath, targetPhpVersion, targetWpVersion, mode, dryRun, phpSwitch, onLog]);

  const handleAbort = useCallback(async () => {
    await api?.invoke('cms:abort');
    setIsRunning(false);
  }, []);

  const handlePickZip = useCallback(async () => {
    const result = await api?.invoke('dialog:open-file', {
      title: 'Seleccionar ZIP de Elementor Pro',
      filters: [{ name: 'ZIP', extensions: ['zip'] }],
    });
    if (result?.filePath) setLocalZipPath(result.filePath);
  }, []);

  const exportCsv = useCallback(() => {
    const rows = ['dominio,estado,duracion_s,error'];
    entries.forEach(e => {
      rows.push([e.domain, e.status, ((e.duration || 0) / 1000).toFixed(1), e.error || ''].join(','));
    });
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `cms-report-${Date.now()}.csv`; a.click();
    URL.revokeObjectURL(url);
  }, [entries]);

  const toggleDomain = (domain: string) => {
    setOpenDomains(prev => {
      const n = new Set(prev);
      n.has(domain) ? n.delete(domain) : n.add(domain);
      return n;
    });
  };

  const domains = domainsRaw.split('\n').map(d => d.trim()).filter(Boolean);
  const visibleEntries = filterFailed ? entries.filter(e => e.status === 'error') : entries;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex-1 overflow-y-auto p-6 space-y-5">

        {/* ── Header ── */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="font-display text-xl font-bold">CMS Reconstructor</h1>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Reconstrucción industrial de WordPress — hasta 600 dominios
            </p>
          </div>
          <div className="flex items-center gap-2">
            {entries.length > 0 && (
              <button onClick={exportCsv} className="btn btn--ghost text-xs">
                Exportar CSV
              </button>
            )}
            {isRunning ? (
              <button onClick={handleAbort} className="btn text-xs font-medium"
                style={{ backgroundColor: 'var(--color-error)', color: '#fff' }}>
                ⛔ Abortar
              </button>
            ) : (
              <button onClick={handleStart} disabled={!domains.length || !serverName || isLoadingVersions}
                className="btn btn--primary text-xs font-medium">
                {isLoadingVersions ? '⏳ Cargando...' : dryRun ? '🔍 Dry Run' : '🚀 Iniciar Batch'}
              </button>
            )}
          </div>
        </div>

        {/* ── Progress dashboard (visible cuando hay entradas) ── */}
        {entries.length > 0 && (
          <div className="card p-4">
            <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
              {[
                { label: 'Total',     value: total,     color: 'var(--text-primary)' },
                { label: '✅ OK',     value: succeeded, color: 'var(--color-success)' },
                { label: '❌ Error',  value: failed,    color: 'var(--color-error)' },
                { label: '⟳ Activos',value: running,   color: '#f59e0b' },
              ].map(s => (
                <div key={s.label} className="text-center">
                  <div className="text-2xl font-bold font-mono" style={{ color: s.color }}>{s.value}</div>
                  <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{s.label}</div>
                </div>
              ))}
            </div>
            {total > 0 && (
              <div className="mt-3" style={{ height: 4, borderRadius: 2, backgroundColor: 'var(--surface-overlay)' }}>
                <div style={{
                  height: '100%', borderRadius: 2,
                  width: `${((succeeded + failed) / total) * 100}%`,
                  backgroundColor: failed > 0 ? 'var(--color-error)' : 'var(--color-success)',
                  transition: 'width 400ms ease-out',
                }} />
              </div>
            )}
            {globalMsg && (
              <p className="text-xs mt-2 font-mono" style={{ color: 'var(--text-muted)' }}>{globalMsg}</p>
            )}
          </div>
        )}

        <div className="grid gap-5" style={{ gridTemplateColumns: '340px 1fr' }}>
          {/* ── Config panel ── */}
          <div className="card p-4 space-y-4">
            <h2 className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
              Configuración
            </h2>

            {/* Servidor */}
            <div className="space-y-1">
              <label className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>Servidor</label>
              <select value={serverName} onChange={e => setServerName(e.target.value)}
                className="input text-xs w-full">
                <option value="">— Selecciona servidor —</option>
                {servers.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>

            {/* Versión WP Destino */}
            <div className="space-y-1">
              <label className="text-xs font-medium flex justify-between" style={{ color: 'var(--text-secondary)' }}>
                <span>Versión WordPress</span>
                {isLoadingVersions && <span className="animate-pulse" style={{ color: 'var(--color-accent)' }}>Cargando...</span>}
              </label>
              <select value={targetWpVersion} onChange={e => setTargetWpVersion(e.target.value)}
                className="input text-xs w-full" disabled={isLoadingVersions || versionesWP.length === 0}>
                {versionesWP.length === 0 ? (
                  <option value="">— No disponible —</option>
                ) : (
                  versionesWP.map(v => {
                    const label = `${v.version} (${v.esUltima ? 'Última / ' : ''}${v.estado.charAt(0).toUpperCase() + v.estado.slice(1)})`;
                    return <option key={v.version} value={v.version}>{label}</option>;
                  })
                )}
              </select>
            </div>

            {/* Versión PHP Destino */}
            <div className="space-y-1">
              <label className="text-xs font-medium flex justify-between" style={{ color: 'var(--text-secondary)' }}>
                <span>Versión PHP Destino</span>
              </label>
              <select value={targetPhpVersion} onChange={e => setTargetPhpVersion(e.target.value)}
                className="input text-xs w-full" disabled={isLoadingVersions}>
                {['Mantener actual', '8.1', '8.2', '8.3'].map(v => (
                  <option key={v} value={v}>{v}</option>
                ))}
              </select>
            </div>

            {/* Modo */}
            <div className="space-y-1">
              <label className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>Modo</label>
              <div className="grid gap-1" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
                {(['full', 'core-only', 'security-only'] as CmsMode[]).map(m => (
                  <button key={m} onClick={() => setMode(m)}
                    className="text-[10px] px-2 py-1.5 rounded-md transition-all"
                    style={{
                      backgroundColor: mode === m ? 'var(--color-accent-bg)' : 'var(--surface-overlay)',
                      color: mode === m ? 'var(--color-accent)' : 'var(--text-muted)',
                      border: `1px solid ${mode === m ? 'var(--color-accent)' : 'var(--border-default)'}`,
                    }}>
                    {m === 'full' ? 'Full' : m === 'core-only' ? 'Solo Core' : 'Solo Seguridad'}
                  </button>
                ))}
              </div>
            </div>

            {/* ZIP Elementor */}
            {mode === 'full' && (
              <div className="space-y-1">
                <label className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                  ZIP Elementor Pro
                </label>
                <div className="flex gap-1.5">
                  <input type="text" value={localZipPath} onChange={e => setLocalZipPath(e.target.value)}
                    placeholder="Ruta local del .zip" className="input text-[10px] flex-1 font-mono" readOnly />
                  <button onClick={handlePickZip} className="btn btn--ghost text-xs px-2">
                    📂
                  </button>
                </div>
              </div>
            )}

            {/* Opciones */}
            <div className="space-y-2 pt-1 border-t" style={{ borderColor: 'var(--border-default)' }}>
              {[
                { label: 'Dry Run (sin cambios reales)', value: dryRun, set: setDryRun },
                { label: 'PHP Switcher automático', value: phpSwitch, set: setPhpSwitch },
              ].map(opt => (
                <label key={opt.label} className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={opt.value} onChange={e => opt.set(e.target.checked)}
                    className="accent-[var(--color-accent)]" />
                  <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>{opt.label}</span>
                </label>
              ))}
            </div>
          </div>

          {/* ── Domains textarea ── */}
          <div className="card p-4 space-y-2 flex flex-col">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                Dominios ({domains.length})
              </label>
            </div>
            <textarea value={domainsRaw} onChange={e => setDomainsRaw(e.target.value)}
              placeholder={"dominio1.com\ndominio2.com\ndominio3.com"}
              className="input flex-1 text-xs font-mono resize-none"
              style={{ minHeight: 200 }} disabled={isRunning} />
          </div>
        </div>

        {/* ── Terminal Accordion ── */}
        {entries.length > 0 && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Progreso por dominio</h2>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={filterFailed} onChange={e => setFilterFailed(e.target.checked)}
                  className="accent-[var(--color-accent)]" />
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  Ver solo fallidos ({failed})
                </span>
              </label>
            </div>

            <div className="space-y-1.5">
              {visibleEntries.map(entry => (
                <div key={entry.domain} className="card overflow-hidden">
                  {/* Accordion header */}
                  <button
                    onClick={() => toggleDomain(entry.domain)}
                    className="w-full flex items-center gap-3 px-4 py-3 text-left"
                    style={{ backgroundColor: 'transparent' }}
                  >
                    <StatusBadge status={entry.status} />
                    <span className="text-xs font-mono flex-1" style={{ color: 'var(--text-primary)' }}>
                      {entry.domain}
                    </span>
                    {entry.duration && (
                      <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>
                        {(entry.duration / 1000).toFixed(1)}s
                      </span>
                    )}
                    <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>
                      {openDomains.has(entry.domain) ? '▲' : '▼'}
                    </span>
                  </button>

                  {/* Accordion body */}
                  <AnimatePresence initial={false}>
                    {openDomains.has(entry.domain) && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.15 }}
                        style={{ overflow: 'hidden' }}
                      >
                        <div className="border-t px-4 py-3 space-y-0.5"
                          style={{ borderColor: 'var(--border-default)', maxHeight: 240, overflowY: 'auto' }}>
                          {entry.steps.length === 0 ? (
                            <p className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>
                              Esperando inicio...
                            </p>
                          ) : entry.steps.map((step, i) => {
                            const color = step.level === 'error' ? 'var(--color-error)'
                              : step.level === 'success' ? 'var(--color-success)'
                              : step.level === 'warn' ? 'var(--color-warning)'
                              : 'var(--text-secondary)';
                            return (
                              <p key={i} className="text-[10px] font-mono leading-relaxed"
                                style={{ color, wordBreak: 'break-all' }}>
                                {step.msg}
                              </p>
                            );
                          })}
                          {entry.status === 'running' && (
                            <p className="text-[10px] font-mono animate-pulse" style={{ color: '#f59e0b' }}>
                              ▌ Procesando...
                            </p>
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
