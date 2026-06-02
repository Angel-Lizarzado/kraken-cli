import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, Play, Square, CheckCircle, XCircle, AlertTriangle, ChevronDown } from 'lucide-react';

// ── Types ──────────────────────────────────────────────────────────────────────
interface AuditEntry {
  domain: string;
  isWp: boolean | null;
  wpVersion?: string;
  checksumOk?: boolean;
  pluginCount?: number;
  phpHandler?: string;
  error?: string;
}

interface DomainReconEntry {
  domain: string;
  status: 'idle' | 'running' | 'success' | 'error';
  steps: Array<{ msg: string; level: string }>;
  error?: string;
}

type CmsMode = 'full' | 'core-only' | 'security-only';
type Phase = 'idle' | 'auditing' | 'results' | 'rebuilding';

interface PhpVersion {
  version: string;
  idCrudo: string;
  etiqueta?: string;
  etiquetaCompleta?: string;
  esUltima?: boolean;
}

interface AuditProgress {
  type: string;
  msg?: string;
  total?: number;
  processed?: number;
  domain?: string;
  isWp?: boolean;
  wpVersion?: string;
  checksumOk?: boolean;
  pluginCount?: number;
  phpHandler?: string;
  error?: string;
  results?: AuditEntry[];
}

interface CmsProgress {
  type: string;
  domain?: string;
  msg?: string;
  level?: string;
  success?: boolean;
  duration?: number;
}

interface Props {
  server: any;
}

// ── Component ──────────────────────────────────────────────────────────────────
export default function CmsAuditTab({ server }: Props) {
  const api = (window as any).api;

  // Audit state
  const [phase, setPhase] = useState<Phase>('idle');
  const [auditResults, setAuditResults] = useState<AuditEntry[]>([]);
  const [auditMsg, setAuditMsg] = useState('');
  const [auditTotal, setAuditTotal] = useState(0);
  const [auditProcessed, setAuditProcessed] = useState(0);

  // Selection
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Rebuild config
  const [mode, setMode] = useState<CmsMode>('full');
  const [targetPhpVersion, setTargetPhpVersion] = useState('');
  const [localZipPath, setLocalZipPath] = useState('');
  const [dryRun, setDryRun] = useState(false);
  const [versionesPHP, setVersionesPHP] = useState<PhpVersion[]>([]);
  const [isLoadingVersions, setIsLoadingVersions] = useState(false);
  const [errorConexion, setErrorConexion] = useState<string | null>(null);

  // Rebuild progress
  const [reconEntries, setReconEntries] = useState<DomainReconEntry[]>([]);
  const [openDomains, setOpenDomains] = useState<Set<string>>(new Set());

  // Filter
  const [filterIssues, setFilterIssues] = useState(false);
  const [filterText, setFilterText] = useState('');

  // Derived
  const wpSites = auditResults.filter(r => r.isWp);
  const issueCount = wpSites.filter(r => !r.checksumOk || (r.pluginCount ?? 0) > 0 || r.error).length;
  const reconSucceeded = reconEntries.filter(e => e.status === 'success').length;
  const reconFailed = reconEntries.filter(e => e.status === 'error').length;

  // Filtered table rows
  const visibleRows = auditResults.filter(r => {
    if (!r.isWp) return false;
    if (filterText && !r.domain.includes(filterText)) return false;
    if (filterIssues && r.checksumOk && (r.pluginCount ?? 0) === 0 && !r.error) return false;
    return true;
  });

  // Audit progress listener
  useEffect(() => {
    const handler = (ev: AuditProgress) => {
      if (!ev) return;
      if (ev.type === 'audit-start') { setAuditMsg(ev.msg || ''); return; }
      if (ev.type === 'audit-domains-found') { setAuditTotal(ev.total || 0); setAuditMsg(ev.msg || ''); return; }
      if (ev.type === 'domain-audited') {
        setAuditProcessed(ev.processed || 0);
        if (ev.isWp !== false && ev.domain) {
          setAuditResults(prev => {
            const entry: AuditEntry = {
              domain: ev.domain!,
              isWp: ev.isWp ?? null,
              wpVersion: ev.wpVersion,
              checksumOk: ev.checksumOk,
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
        setPhase('results');
        setAuditMsg(ev.msg || '');
        if (ev.results) setAuditResults(ev.results.filter(r => r.isWp));
        return;
      }
      if (ev.type === 'audit-error') { setPhase('results'); setAuditMsg(`Error: ${ev.msg}`); return; }
    };
    api?.receive('cms:audit-progress', handler);
    return () => { api?.removeListener?.('cms:audit-progress', handler); };
  }, []);

  // Fetch PHP versions when server changes
  useEffect(() => {
    if (!server) {
      setVersionesPHP([]);
      setErrorConexion(null);
      setIsLoadingVersions(false);
      return;
    }

    console.log('[SSH RECONSTRUCT] Enviando configuración completa:', server);

    setVersionesPHP([]);
    setErrorConexion(null);
    setIsLoadingVersions(true);

    (window as any).krakenAPI?.php?.obtenerVersiones(server)
      .then((respuesta: any) => {
        if (!respuesta || respuesta.exito === false) {
          throw new Error(respuesta?.error || 'El servidor reportó un error al escanear versiones de PHP.');
        }

        const listaPHP = respuesta.versiones || [];
        if (listaPHP.length > 0) {
          // Filtrar cualquier duplicado manual de 'Mantener actual' que venga del backend
          const filtrado = listaPHP.filter((v: any) => v.version !== 'Mantener actual' && v.idCrudo !== 'Mantener actual');
          setVersionesPHP(filtrado);
        } else {
          throw new Error('No se detectaron versiones de PHP habilitadas en el servidor.');
        }
      })
      .catch((err: any) => {
        const mensajeError = err.message || 'Error de conexión con el canal IPC del backend';
        setErrorConexion(mensajeError);
        setVersionesPHP([]);
        console.error('[FRONTEND IPC ERROR]:', err);
      })
      .finally(() => setIsLoadingVersions(false));
  }, [server]);

  // Recon progress listener
  useEffect(() => {
    const handler = (ev: CmsProgress) => {
      if (!ev || !ev.domain) return;
      if (ev.type === 'domain-start') {
        setOpenDomains(prev => new Set([...prev, ev.domain!]));
        setReconEntries(prev => {
          const exists = prev.find(e => e.domain === ev.domain);
          if (exists) return prev.map(e => e.domain === ev.domain ? { ...e, status: 'running', steps: [] } : e);
          return [...prev, { domain: ev.domain!, status: 'running', steps: [] }];
        });
        return;
      }
      if (ev.type === 'upload-start' || ev.type === 'upload-done') {
        // Mostrar como un "dominio falso" para que el usuario vea el progreso del ZIP
        const uploadKey = '__upload_elementor__';
        setOpenDomains(prev => new Set([...prev, uploadKey]));
        setReconEntries(prev => {
          const exists = prev.find(e => e.domain === uploadKey);
          const stepMsg = { msg: ev.msg || 'Subiendo Elementor...', level: ev.level || 'info' };
          
          if (exists) {
            return prev.map(e => e.domain === uploadKey 
              ? { ...e, status: ev.type === 'upload-done' ? 'success' : 'running', steps: [...e.steps, stepMsg] } 
              : e);
          }
          return [{ domain: uploadKey, status: ev.type === 'upload-done' ? 'success' : 'running', steps: [stepMsg] }, ...prev];
        });
        return;
      }
      if (ev.type === 'domain-step') {
        setReconEntries(prev => prev.map(e =>
          e.domain === ev.domain ? { ...e, steps: [...e.steps, { msg: ev.msg || '', level: ev.level || 'info' }] } : e
        ));
        return;
      }
      if (ev.type === 'domain-done') {
        setReconEntries(prev => prev.map(e => e.domain === ev.domain ? { ...e, status: 'success' } : e));
        setOpenDomains(prev => { const n = new Set(prev); n.delete(ev.domain!); return n; });
        // Actualización optimista: Mutar el auditResults local para que la fila desaparezca si se filtra por "problemas"
        setAuditResults(prev => prev.map(r => 
          r.domain === ev.domain ? { ...r, checksumOk: true, pluginCount: 0, error: undefined } : r
        ));
        return;
      }
      if (ev.type === 'domain-error') {
        setReconEntries(prev => prev.map(e => e.domain === ev.domain ? { ...e, status: 'error', error: ev.msg } : e));
        return;
      }
      if (ev.type === 'batch-done') { setPhase('results'); return; }
    };
    api?.receive('cms:progress', handler);
    return () => { api?.removeListener?.('cms:progress', handler); };
  }, []);

  const handleAudit = useCallback(async () => {
    if (!server) return;
    setPhase('auditing');
    setAuditResults([]);
    setAuditProcessed(0);
    setAuditTotal(0);
    setSelected(new Set());
    setReconEntries([]);
    await api?.invoke('cms:audit-server', { serverName: server.name });
  }, [server]);

  const handleAbort = useCallback(async () => {
    await api?.invoke('cms:abort');
    setPhase('results');
  }, []);

  const handlePickZip = useCallback(async () => {
    const res = await api?.invoke('dialog:open-file', {
      title: 'Seleccionar ZIP de Elementor Pro',
      filters: [{ name: 'ZIP', extensions: ['zip'] }],
    });
    if (res?.filePath) setLocalZipPath(res.filePath);
  }, []);

  const handleStartRecon = useCallback(async () => {
    if (!selected.size || phase === 'rebuilding' || !server) return;
    const domains = [...selected];
    setReconEntries(domains.map(d => ({ domain: d, status: 'idle', steps: [] })));
    setOpenDomains(new Set());
    setPhase('rebuilding');
    await api?.invoke('cms:start-batch', {
      serverName: server.name, domains, localZipPath: localZipPath || null,
      targetPhpVersion, mode, dryRun,
    });
  }, [selected, server, localZipPath, targetPhpVersion, mode, dryRun, phase]);

  const toggleAll = () => {
    if (selected.size === visibleRows.length) setSelected(new Set());
    else setSelected(new Set(visibleRows.map(r => r.domain)));
  };

  const toggleDomain = (domain: string) => {
    setOpenDomains(prev => { const n = new Set(prev); n.has(domain) ? n.delete(domain) : n.add(domain); return n; });
  };

  const auditPct = auditTotal > 0 ? Math.round((auditProcessed / auditTotal) * 100) : 0;

  // ── IDLE: pantalla de inicio ────────────────────────────────────────────────
  if (phase === 'idle') {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-5 py-16">
        <div style={{ color: 'var(--text-muted)' }}>
          <Search size={40} strokeWidth={1.2} />
        </div>
        <div className="text-center">
          <h3 className="font-semibold text-sm">Auditoría de Flota WordPress</h3>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
            Detecta todos los sitios WP en <strong>{server?.name}</strong> y audita su estado de integridad, plugins y PHP.
          </p>
        </div>
        <button onClick={handleAudit} disabled={!server}
          className="btn btn--primary flex items-center gap-2">
          <Search size={14} /> Escanear Flota WordPress
        </button>
      </div>
    );
  }

  // ── AUDITING: progreso del escaneo ─────────────────────────────────────────
  if (phase === 'auditing') {
    return (
      <div className="flex flex-col gap-4 p-6">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold">Auditando flota...</h3>
            <p className="text-xs mt-0.5 font-mono" style={{ color: 'var(--text-muted)' }}>{auditMsg}</p>
          </div>
          <button onClick={handleAbort} className="btn text-xs flex items-center gap-1.5"
            style={{ backgroundColor: 'var(--color-error)', color: '#fff' }}>
            <Square size={11} /> Abortar
          </button>
        </div>

        {/* Barra global */}
        <div>
          <div className="flex justify-between text-[10px] mb-1.5 font-mono" style={{ color: 'var(--text-muted)' }}>
            <span>{auditProcessed} / {auditTotal || '?'} dominios</span>
            <span>{auditPct}%</span>
          </div>
          <div style={{ height: 6, borderRadius: 3, backgroundColor: 'var(--surface-overlay)' }}>
            <div style={{
              height: '100%', borderRadius: 3,
              width: `${auditTotal > 0 ? auditPct : 30}%`,
              backgroundColor: 'var(--color-accent)',
              transition: 'width 300ms ease-out',
              animation: auditTotal === 0 ? 'pulse 1.5s ease infinite' : undefined,
            }} />
          </div>
        </div>

        {/* Live feed: últimos dominios detectados */}
        {auditResults.length > 0 && (
          <div className="card p-3 space-y-0.5" style={{ maxHeight: 200, overflowY: 'auto' }}>
            {[...auditResults].reverse().slice(0, 20).map(r => (
              <div key={r.domain} className="flex items-center gap-2 text-[10px] font-mono">
                {r.error ? <XCircle size={10} style={{ color: 'var(--color-error)' }} /> : <CheckCircle size={10} style={{ color: 'var(--color-success)' }} />}
                <span style={{ color: 'var(--text-secondary)' }}>{r.domain}</span>
                {r.wpVersion && <span style={{ color: 'var(--text-muted)' }}>WP {r.wpVersion}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ── RESULTS / REBUILDING ────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-4 p-4 overflow-y-auto h-full">

      {/* Stats bar */}
      <div className="flex items-center gap-4 flex-wrap">
        {[
          { label: 'WP encontrados', value: wpSites.length, color: 'var(--text-primary)' },
          { label: 'Con problemas', value: issueCount, color: 'var(--color-error)' },
          { label: 'Seleccionados', value: selected.size, color: 'var(--color-accent)' },
        ].map(s => (
          <div key={s.label} className="flex items-center gap-2">
            <span className="text-xl font-bold font-mono" style={{ color: s.color }}>{s.value}</span>
            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{s.label}</span>
          </div>
        ))}
        <div className="ml-auto flex items-center gap-2">
          <button onClick={handleAudit} className="btn btn--ghost text-xs flex items-center gap-1">
            <Search size={12} /> Re-escanear
          </button>
        </div>
      </div>

      {/* Filter bar */}
      <div className="flex items-center gap-2">
        <input value={filterText} onChange={e => setFilterText(e.target.value)}
          placeholder="Filtrar dominios..." className="input text-xs flex-1" />
        <label className="flex items-center gap-1.5 text-xs cursor-pointer" style={{ color: 'var(--text-secondary)' }}>
          <input type="checkbox" checked={filterIssues} onChange={e => setFilterIssues(e.target.checked)} />
          Solo con problemas
        </label>
      </div>

      {/* Data grid */}
      <div className="card overflow-auto" style={{ maxHeight: 300 }}>
        <table className="w-full text-[11px]">
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border-default)' }}>
              <th className="px-3 py-2 text-left w-8">
                <input type="checkbox"
                  checked={selected.size > 0 && selected.size === visibleRows.length}
                  onChange={toggleAll} />
              </th>
              {['Dominio', 'WP Ver.', 'Checksums', 'Plugins', 'PHP'].map(h => (
                <th key={h} className="px-3 py-2 text-left font-medium"
                  style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map(row => {
              const hasIssue = !row.checksumOk || (row.pluginCount ?? 0) > 0 || !!row.error;
              return (
                <tr key={row.domain}
                  onClick={() => setSelected(prev => {
                    const n = new Set(prev);
                    n.has(row.domain) ? n.delete(row.domain) : n.add(row.domain);
                    return n;
                  })}
                  style={{
                    borderBottom: '1px solid var(--border-default)',
                    backgroundColor: selected.has(row.domain) ? 'var(--color-accent-bg)' : 'transparent',
                    cursor: 'pointer',
                  }}
                >
                  <td className="px-3 py-2">
                    <input type="checkbox" checked={selected.has(row.domain)} readOnly />
                  </td>
                  <td className="px-3 py-2 font-mono" style={{ color: 'var(--text-primary)' }}>
                    {row.domain}
                    {hasIssue && <AlertTriangle size={9} className="inline ml-1.5" style={{ color: 'var(--color-warning)' }} />}
                  </td>
                  <td className="px-3 py-2 font-mono" style={{ color: 'var(--text-secondary)' }}>
                    {row.wpVersion || '?'}
                  </td>
                  <td className="px-3 py-2">
                    {row.checksumOk
                      ? <CheckCircle size={12} style={{ color: 'var(--color-success)' }} />
                      : <XCircle size={12} style={{ color: 'var(--color-error)' }} />}
                  </td>
                  <td className="px-3 py-2 font-mono" style={{ color: (row.pluginCount ?? 0) > 0 ? 'var(--color-warning)' : 'var(--text-muted)' }}>
                    {row.pluginCount ?? 0}
                  </td>
                  <td className="px-3 py-2 font-mono" style={{ color: 'var(--text-muted)' }}>
                    {row.phpHandler ? row.phpHandler.replace(/.*plesk-php|\/php.*/, '').trim() : '?'}
                  </td>
                </tr>
              );
            })}
            {visibleRows.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-8 text-center text-xs" style={{ color: 'var(--text-muted)' }}>
                Sin resultados
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Rebuild panel — visible cuando hay selección */}
      {selected.size > 0 && phase !== 'rebuilding' && (
        <div className="card p-4">
          <h4 className="text-xs font-semibold mb-3">
            Reconstrucción — {selected.size} sitio{selected.size !== 1 ? 's' : ''}
          </h4>
          <div className="grid gap-3" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
            <div>
              <label className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Modo</label>
              <select value={mode} onChange={e => setMode(e.target.value as CmsMode)} className="input text-xs w-full mt-1">
                <option value="full">Full (WP + Elementor)</option>
                <option value="core-only">Solo Core WP</option>
                <option value="security-only">Solo Seguridad</option>
              </select>
            </div>
            <div>
              <label className="text-[10px] flex justify-between" style={{ color: 'var(--text-muted)' }}>
                <span>Versión PHP Destino</span>
                {isLoadingVersions ? (
                  <span className="animate-pulse" style={{ color: 'var(--color-accent)' }}>Cargando versiones...</span>
                ) : errorConexion ? (
                  <span style={{ color: 'var(--color-error)' }}>No se pudieron obtener versiones</span>
                ) : null}
              </label>
              <select value={targetPhpVersion} onChange={e => setTargetPhpVersion(e.target.value)}
                className="input text-xs w-full mt-1" disabled={isLoadingVersions || versionesPHP.length === 0}>
                <option value="">Mantener actual</option>
                {versionesPHP.map(manejador => (
                  <option key={manejador.version} value={manejador.idCrudo}>
                    PHP {manejador.version} — {manejador.etiquetaCompleta}
                  </option>
                ))}
              </select>
            </div>
            {mode === 'full' && (
              <div>
                <label className="text-[10px]" style={{ color: 'var(--text-muted)' }}>ZIP Elementor Pro</label>
                <div className="flex gap-1 mt-1">
                  <input value={localZipPath} readOnly placeholder="Seleccionar .zip"
                    className="input text-[10px] flex-1 font-mono" />
                  <button onClick={handlePickZip} className="btn btn--ghost text-xs px-2">📂</button>
                </div>
              </div>
            )}
          </div>
          <div className="flex items-center gap-4 mt-3">
            <label className="flex items-center gap-1.5 text-xs cursor-pointer">
              <input type="checkbox" checked={dryRun} onChange={e => setDryRun(e.target.checked)} />
              <span style={{ color: 'var(--text-secondary)' }}>Dry Run (sin cambios reales)</span>
            </label>
            <button onClick={handleStartRecon} className="btn btn--primary text-xs ml-auto flex items-center gap-1.5">
              <Play size={11} /> {dryRun ? 'Dry Run' : 'Ejecutar Reconstrucción'}
            </button>
          </div>
        </div>
      )}

      {/* Recon progress when rebuilding */}
      {phase === 'rebuilding' && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-semibold">
              Reconstrucción en curso — {reconSucceeded} OK / {reconFailed} error / {reconEntries.length} total
            </h4>
            <button onClick={handleAbort} className="btn text-xs flex items-center gap-1"
              style={{ backgroundColor: 'var(--color-error)', color: '#fff' }}>
              <Square size={10} /> Abortar
            </button>
          </div>
          {reconEntries.map(entry => (
            <div key={entry.domain} className="card overflow-hidden">
              <button onClick={() => toggleDomain(entry.domain)}
                className="w-full flex items-center gap-3 px-3 py-2 text-left">
                {entry.status === 'success' && <CheckCircle size={11} style={{ color: 'var(--color-success)' }} />}
                {entry.status === 'error' && <XCircle size={11} style={{ color: 'var(--color-error)' }} />}
                {entry.status === 'running' && <div className="w-2.5 h-2.5 rounded-full animate-pulse" style={{ backgroundColor: '#f59e0b' }} />}
                {entry.status === 'idle' && <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: 'var(--text-muted)' }} />}
                <span className="text-[11px] font-mono flex-1" style={{ color: 'var(--text-primary)' }}>{entry.domain}</span>
                <ChevronDown size={12} style={{ color: 'var(--text-muted)', transform: openDomains.has(entry.domain) ? 'rotate(180deg)' : 'none', transition: 'transform 150ms' }} />
              </button>
              <AnimatePresence initial={false}>
                {openDomains.has(entry.domain) && (
                  <motion.div initial={{ height: 0 }} animate={{ height: 'auto' }} exit={{ height: 0 }}
                    transition={{ duration: 0.12 }} style={{ overflow: 'hidden' }}>
                    <div className="border-t px-3 py-2 space-y-0.5" style={{ borderColor: 'var(--border-default)', maxHeight: 160, overflowY: 'auto' }}>
                      {entry.steps.map((s, i) => (
                        <p key={i} className="text-[10px] font-mono" style={{
                          color: s.level === 'error' ? 'var(--color-error)'
                            : s.level === 'success' ? 'var(--color-success)'
                              : 'var(--text-secondary)',
                        }}>{s.msg}</p>
                      ))}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
