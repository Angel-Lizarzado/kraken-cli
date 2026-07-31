import React, { useState, useEffect, useCallback, useRef } from 'react';
import { AlertTriangle, CheckCircle, XCircle, Activity, Zap, Globe, ShieldAlert, Terminal } from 'lucide-react';

// ── Types ──────────────────────────────────────────────────────────────────────

type GlobalAction = 'repair-full' | 'mysql-optimize' | 'restart-nginx' | 'restart-apache' | 'restart-php';

interface HealthResult {
  domain: string;
  status: number | null;
  error: string | null;
  recommendation: string | null;
  comandoMitigacion?: string | null;
  diagnosticando?: boolean;
  duration?: number;
  diagnosticOutput?: string;
}

interface ActionState { running: boolean; output?: string; success?: boolean }

type ScanPhase = 'idle' | 'scanning' | 'done';

const GLOBAL_ACTIONS: Array<{ id: GlobalAction; label: string; icon: string }> = [
  { id: 'repair-full',    label: 'Repair Full (Web+FS)',        icon: '🔧' },
  { id: 'mysql-optimize', label: 'MySQL Optimize',               icon: '🗄️' },
  { id: 'restart-nginx',  label: 'Restart Nginx',                icon: '↺' },
  { id: 'restart-apache', label: 'Restart Apache',               icon: '↺' },
  { id: 'restart-php',    label: 'Restart PHP-FPM',              icon: '↺' },
];

function statusLabel(r: HealthResult): { text: string; color: string } {
  if (r.error === 'timeout')     return { text: 'Timeout',          color: '#ff5252' };
  if (r.error === 'dns')         return { text: 'DNS Fail',         color: '#a5a5a5' };
  if (r.error === 'wp-fatal')    return { text: '500 WP Fatal',     color: 'oklch(0.7 0.15 55)' }; // amber
  if (r.error === 'soft-error')  return { text: '200 Soft Error',   color: '#ffb142' };
  if (r.error)                   return { text: r.error,            color: '#ff5252' };
  if (!r.status)                 return { text: '?',                color: '#a5a5a5' };
  if (r.status < 400)            return { text: `${r.status} OK`,   color: '#33d9b2' };
  return { text: String(r.status),                                   color: '#ff5252' };
}

// ── Component ──────────────────────────────────────────────────────────────────

interface Props {
  serverName: string;
  onLog: (msg: string, type: 'info' | 'warning' | 'error' | 'success') => void;
}

export default function FleetTab({ serverName, onLog }: Props) {
  const apiRef = useRef((window as any).api);
  const krakenRef = useRef((window as any).krakenAPI);

  // Emergency global action states
  const [actionStates, setActionStates] = useState<Record<string, ActionState>>({});

  // Health scan
  const [scanPhase, setScanPhase]         = useState<ScanPhase>('idle');
  const [scanTotal, setScanTotal]         = useState(0);
  const [scanProcessed, setScanProcessed] = useState(0);
  const [healthResults, setHealthResults] = useState<HealthResult[]>([]);
  const [targetDomain, setTargetDomain]   = useState('');

  // Per-domain triage buttons
  const [triageStates, setTriageStates] = useState<Record<string, ActionState>>({});

  const [batchRunning, setBatchRunning] = useState(false);
  const [consolaLogs, setConsolaLogs]   = useState<string[]>([]);
  const consolaRef = useRef<HTMLDivElement>(null);

  // Filtros y Expansión
  const [filterText, setFilterText] = useState('');
  const [showOnlyErrors, setShowOnlyErrors] = useState(false);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

  const toggleExpand = (domain: string) => {
    setExpandedRows(prev => {
      const next = new Set(prev);
      if (next.has(domain)) next.delete(domain);
      else next.add(domain);
      return next;
    });
  };

  // Derived
  const failedSites = healthResults.filter(r => r.recommendation !== null && r.error !== 'dns');
  const okCount     = healthResults.filter(r => r.recommendation === null && r.error !== 'dns').length;

  const scanPct = scanTotal > 0 ? Math.round((scanProcessed / scanTotal) * 100) : 0;

  // Auto-scroll terminal
  useEffect(() => {
    if (consolaRef.current) {
      consolaRef.current.scrollTop = consolaRef.current.scrollHeight;
    }
  }, [consolaLogs]);

  const pushLog = (line: string) => {
    setConsolaLogs(prev => [...prev, line]);
  };

  // ── Health scan progress listener ─────────────────────────────────────────
  useEffect(() => {
    const api = apiRef.current;
    const handler = (ev: any) => {
      if (!ev) return;
      if (ev.type === 'scan-start') {
        setScanTotal(ev.total);
        setScanProcessed(0);
        setHealthResults([]);
        setConsolaLogs([]);
        return;
      }
      if (ev.type === 'domain-checked') {
        setScanProcessed(ev.processed);
        setHealthResults(prev => {
          const map = new Map(prev.map(r => [r.domain, r]));
          map.set(ev.domain, {
            domain:         ev.domain,
            status:         ev.status,
            error:          ev.error,
            recommendation: ev.recommendation,
            duration:       ev.duration,
          });
          return Array.from(map.values());
        });
        return;
      }
      if (ev.type === 'scan-done') {
        setScanPhase('done');
        pushLog(`[Escáner] Completado. ${ev.ok} OK, ${ev.failed} fallidos.`);
        return;
      }
    };
    api?.receive('fleet:health-progress', handler);
    return () => { api?.removeListener?.('fleet:health-progress', handler); };
  }, []);

  // ── Fleet domain-status listener (para UI real-time, opcional si lo usa otro lado)
  useEffect(() => {
    const api = apiRef.current;
    const handler = (ev: any) => {
      if (!ev?.domain || !ev?.status) return;
      if (ev.status === 'processing') {
        setTriageStates(prev => ({ ...prev, [ev.domain]: { running: true } }));
        return;
      }
      const succeeded = ev.status === 'ok';
      setTriageStates(prev => ({ ...prev, [ev.domain]: { running: false, success: succeeded } }));
      if (ev.rescan) {
        setHealthResults(prev => {
          const map = new Map(prev.map(r => [r.domain, r]));
          const existing = map.get(ev.domain);
          if (existing) {
            map.set(ev.domain, {
              ...existing,
              status:         ev.rescan.status,
              error:          ev.rescan.error,
              recommendation: ev.rescan.recommendation ?? null,
              duration:       ev.rescan.duration ?? existing.duration,
            });
          }
          return Array.from(map.values());
        });
      }
    };
    api?.receive('fleet:domain-status', handler);
    return () => { api?.removeListener?.('fleet:domain-status', handler); };
  }, []);

  // ── Emergency global action ───────────────────────────────────────────────
  const runGlobal = useCallback(async (actionId: GlobalAction) => {
    const api = apiRef.current;
    setActionStates(prev => ({ ...prev, [actionId]: { running: true } }));
    try {
      const res = await api?.invoke('fleet:run-action', { serverName, action: actionId });
      const success = res?.success ?? false;
      setActionStates(prev => ({ ...prev, [actionId]: { running: false, output: res?.output, success } }));
      onLog(`[Fleet] ${actionId}: ${success ? 'Completado' : `Error — ${res?.error}`}`, success ? 'success' : 'error');
    } catch (e: any) {
      setActionStates(prev => ({ ...prev, [actionId]: { running: false, output: e?.message, success: false } }));
      onLog(`[Fleet] Error en ${actionId}: ${e?.message}`, 'error');
    }
  }, [serverName, onLog]);

  // ── Start scan ────────────────────────────────────────────────────────────
  const startScan = useCallback(async () => {
    const api = apiRef.current;
    setScanPhase('scanning');
    setHealthResults([]);
    setScanTotal(0);
    setScanProcessed(0);
    setTriageStates({});
    setConsolaLogs(['[Escáner] Iniciando comprobación de salud de flota...']);
    await api?.invoke('fleet:scan-health', { serverName, targetDomain: targetDomain || undefined });
  }, [serverName, targetDomain]);

  // ── Diagnóstico Inteligente ───────────────────────────────────────────────
  const diagnosticarFlotaRota = useCallback(async (sitesToDiagnose: HealthResult[]) => {
    const kraken = krakenRef.current;
    if (!sitesToDiagnose.length) return;

    pushLog(`[Motor] Iniciando diagnóstico de ${sitesToDiagnose.length} dominios...`);
    let successCount = 0;
    let errorCount = 0;
    
    for (const site of sitesToDiagnose) {
      setHealthResults(prev => prev.map(r => r.domain === site.domain ? { ...r, diagnosticando: true } : r));
      
      try {
        const res = await apiRef.current?.invoke('fleet:diagnose-site', { serverName, dominio: site.domain, httpCode: site.status });
        
        if (res.success && res.payload) {
          successCount++;
          const { descripcion, comandoMitigacion, tipo } = res.payload;
          setHealthResults(prev => prev.map(r => r.domain === site.domain ? {
            ...r,
            diagnosticando: false,
            recommendation: descripcion || `Error detectado: ${tipo}`,
            comandoMitigacion: comandoMitigacion || null,
            diagnosticOutput: `[Éxito] ${tipo}\n${JSON.stringify(res.payload, null, 2)}`
          } : r));
        } else {
          errorCount++;
          setHealthResults(prev => prev.map(r => r.domain === site.domain ? { ...r, diagnosticando: false, diagnosticOutput: res.error } : r));
        }
      } catch (err: any) {
        errorCount++;
        setHealthResults(prev => prev.map(r => r.domain === site.domain ? { ...r, diagnosticando: false, diagnosticOutput: err.message } : r));
      }
    }
    pushLog(`[Motor] Diagnóstico finalizado. ${successCount} diagnosticados OK, ${errorCount} fallidos.`);
  }, [serverName]);

  // ── Ejecución de Mitigaciones Inteligentes ────────────────────────────────
  const runIntelligentBatch = useCallback(async () => {
    const kraken = krakenRef.current;
    const sitesToMitigate = failedSites.filter(s => s.comandoMitigacion);
    
    if (!sitesToMitigate.length || batchRunning) return;

    setBatchRunning(true);
    pushLog(`[Mitigación] Ejecutando mitigaciones en ${sitesToMitigate.length} dominios de forma secuencial...`);
    let successCount = 0;
    let errorCount = 0;

    for (const site of sitesToMitigate) {
      setTriageStates(prev => ({ ...prev, [site.domain]: { running: true } }));
      
      try {
        const res = await apiRef.current?.invoke('fleet:run-mitigation', { serverName, comandoMitigacion: site.comandoMitigacion! });
        
        if (res.success) {
          successCount++;
          setTriageStates(prev => ({ ...prev, [site.domain]: { running: false, success: true, output: res.output } }));
        } else {
          errorCount++;
          setTriageStates(prev => ({ ...prev, [site.domain]: { running: false, success: false, output: res.output } }));
        }
      } catch (err: any) {
        errorCount++;
        setTriageStates(prev => ({ ...prev, [site.domain]: { running: false, success: false, output: err.message } }));
      }
    }

    pushLog(`[Mitigación] Proceso secuencial terminado. ${successCount} success y ${errorCount} errores.`);
    setBatchRunning(false);
  }, [serverName, failedSites, batchRunning]);

  // ── Per-domain triage action (Manual) ─────────────────────────────────────
  const runManualMitigation = useCallback(async (domain: string, comando: string) => {
    setTriageStates(prev => ({ ...prev, [domain]: { running: true } }));
    pushLog(`[${domain}] Ejecutando mitigación individual...`);
    try {
      const res = await apiRef.current?.invoke('fleet:run-mitigation', { serverName, comandoMitigacion: comando });
      setTriageStates(prev => ({ ...prev, [domain]: { running: false, success: res.success } }));
      pushLog(`[${domain}] ${res.success ? '✓' : '✗'} Salida: ${res.output.slice(0, 100)}`);
    } catch (e: any) {
      setTriageStates(prev => ({ ...prev, [domain]: { running: false, success: false } }));
      pushLog(`[${domain}] Error: ${e.message}`);
    }
  }, [serverName]);


  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-5 flex flex-col h-full">

      {/* ── Acciones Globales de Emergencia ── */}
      <div className="shrink-0">
        <p className="text-xs mb-3" style={{ color: '#a5a5a5' }}>
          <Zap size={11} className="inline mr-1" style={{ color: '#ffb142' }} />
          Acciones globales en <strong>{serverName}</strong> — emergencia a nivel de servidor completo.
        </p>
        <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
          {GLOBAL_ACTIONS.map(action => {
            const state = actionStates[action.id];
            return (
              <div key={action.id} className="card p-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium truncate">{action.icon} {action.label}</span>
                  <button
                    onClick={() => runGlobal(action.id)}
                    disabled={state?.running}
                    className="btn btn--ghost text-[10px] px-2 py-1 shrink-0"
                  >
                    {state?.running
                      ? <><span className="spinner" style={{ width: 8, height: 8 }} /> En curso</>
                      : 'Ejecutar'}
                  </button>
                </div>
                {state?.output && (
                  <pre className="text-[9px] p-1.5 rounded overflow-x-auto whitespace-pre-wrap"
                    style={{
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                      backgroundColor: 'oklch(0.12 0.008 250)',
                      color: state.success ? '#33d9b2' : '#ff5252',
                      maxHeight: 60,
                    }}>
                    {state.output}
                  </pre>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Escáner de Salud con Triaje ── */}
      <div className="border-t pt-4 flex flex-col flex-1 min-h-0 border-outline-variant">
        <div className="flex items-center justify-between mb-3 shrink-0">
          <div className="flex items-center gap-2">
            <Activity size={14} className="text-tertiary" />
            <span className="text-sm font-semibold">Salud de Flota</span>
            {scanPhase === 'done' && (
              <span className="text-[10px] px-2 py-0.5 rounded-full font-mono bg-tertiary/20 text-tertiary">
                {okCount} OK · {failedSites.length} fallidos
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {scanPhase === 'done' && failedSites.length > 0 && !batchRunning && (
              <>
                <button onClick={() => diagnosticarFlotaRota(failedSites)}
                  className="btn btn--secondary text-xs flex items-center gap-1.5">
                  <Terminal size={11} />
                  Auto-Diagnosticar
                </button>
                {failedSites.some(s => s.comandoMitigacion) && (
                  <button onClick={runIntelligentBatch}
                    className="btn btn--primary text-xs flex items-center gap-1.5 bg-yellow-400 text-black">
                    <ShieldAlert size={11} />
                    Aplicar recomendaciones
                  </button>
                )}
              </>
            )}
            {batchRunning && (
              <span className="text-xs flex items-center gap-1.5" style={{ color: '#ffb142' }}>
                <span className="spinner" style={{ width: 10, height: 10 }} />
                Ejecutando mitigaciones...
              </span>
            )}
            <div className="flex items-center gap-2 border-l pl-3 ml-1 border-outline-variant">
              <input 
                type="text" 
                placeholder="Dominio individual (opcional)" 
                className="input text-xs w-48"
                value={targetDomain}
                onChange={e => setTargetDomain(e.target.value)}
                disabled={scanPhase === 'scanning' || batchRunning}
              />
              <button onClick={startScan} disabled={scanPhase === 'scanning' || batchRunning}
                className="btn btn--ghost text-xs flex items-center gap-1.5">
                {scanPhase === 'scanning'
                  ? <><span className="spinner" style={{ width: 10, height: 10 }} /> Escaneando...</>
                  : <><Globe size={12} /> {scanPhase === 'idle' ? 'Escanear' : 'Re-escanear'}</>
                }
              </button>
            </div>
          </div>
        </div>

        {/* Barra de progreso del scan */}
        {scanPhase === 'scanning' && (
          <div className="mb-3 shrink-0">
            <div className="flex justify-between text-[10px] mb-1 font-mono" style={{ color: '#a5a5a5' }}>
              <span>{scanProcessed} / {scanTotal} dominios</span>
              <span>{scanPct}%</span>
            </div>
            <div style={{ height: 4, borderRadius: 2, backgroundColor: 'rgba(255, 255, 255, 0.05)' }}>
              <div style={{
                height: '100%', borderRadius: 2, width: `${scanPct}%`,
                backgroundColor: '#34ace0', transition: 'width 250ms ease-out',
              }} />
            </div>
          </div>
        )}

        {/* Idle */}
        {scanPhase === 'idle' && (
          <div className="card p-6 flex flex-col items-center gap-3 text-center shrink-0">
            <Activity size={28} strokeWidth={1.2} style={{ color: '#a5a5a5' }} />
            <p className="text-xs" style={{ color: '#a5a5a5' }}>
              Haz clic en "Escanear" para verificar el estado HTTP de todos los dominios.<br />
              El motor de diagnóstico inteligente detectará errores y sugerirá mitigaciones en la terminal.
            </p>
          </div>
        )}

        {/* Filtros de Tabla */}
        {(scanPhase === 'scanning' || scanPhase === 'done') && healthResults.length > 0 && (
          <div className="flex items-center gap-3 mb-3 shrink-0">
            <input 
              type="text" 
              placeholder="🔍 Filtrar por dominio..." 
              className="input text-xs w-64"
              value={filterText}
              onChange={e => setFilterText(e.target.value)}
            />
            <label className="flex items-center gap-1.5 text-xs cursor-pointer" style={{ color: '#a5a5a5' }}>
              <input 
                type="checkbox" 
                checked={showOnlyErrors} 
                onChange={e => setShowOnlyErrors(e.target.checked)} 
              />
              Mostrar solo con errores / advertencias
            </label>
          </div>
        )}

        {/* Data Grid de Triaje */}
        {(scanPhase === 'scanning' || scanPhase === 'done') && healthResults.length > 0 && (
          <div className="card overflow-hidden flex flex-col flex-1 min-h-0 mb-3">
            <div className="overflow-y-auto flex-1">
              <table className="w-full text-[11px]">
                <thead style={{ position: 'sticky', top: 0, backgroundColor: 'rgba(255, 255, 255, 0.05)', zIndex: 1 }}>
                  <tr className="border-b border-outline-variant">
                    {['Dominio', 'Estado', 'Tiempo', 'Recomendación', 'Acción'].map(h => (
                      <th key={h} className="px-3 py-2 text-left font-medium"
                        style={{ color: '#a5a5a5', whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[...healthResults]
                    .filter(r => !filterText || r.domain.toLowerCase().includes(filterText.toLowerCase()))
                    .filter(r => !showOnlyErrors || (r.recommendation !== null || r.error === 'dns'))
                    .sort((a, b) => (b.recommendation ? 1 : 0) - (a.recommendation ? 1 : 0))
                    .map(row => {
                      const sl  = statusLabel(row);
                      const ts  = triageStates[row.domain];
                      const isOk = row.recommendation === null && row.error !== 'dns';
                      return (
                        <React.Fragment key={row.domain}>
                          <tr 
                            className="cursor-pointer transition-colors"
                            onClick={() => toggleExpand(row.domain)}
                            style={{ 
                              borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
                              backgroundColor: expandedRows.has(row.domain) ? 'rgba(0, 0, 0, 0.2)' : 'transparent'
                            }}
                          >
                            <td className="px-3 py-2 font-mono text-on-surface">
                              <div className="flex items-center gap-1.5">
                                {isOk
                                  ? <CheckCircle size={9} style={{ color: '#33d9b2', flexShrink: 0 }} />
                                  : row.error === 'dns'
                                    ? <AlertTriangle size={9} style={{ color: '#a5a5a5', flexShrink: 0 }} />
                                    : <XCircle size={9} style={{ color: '#ff5252', flexShrink: 0 }} />
                                }
                                {row.domain}
                              </div>
                            </td>
                            <td className="px-3 py-2 font-mono" style={{ color: sl.color }}>{sl.text}</td>
                            <td className="px-3 py-2 font-mono" style={{ color: '#a5a5a5' }}>
                              {row.duration ? `${row.duration}ms` : '—'}
                            </td>
                            <td className="px-3 py-2">
                              {row.diagnosticando ? (
                                <span className="text-[10px] flex items-center gap-1" style={{ color: '#a5a5a5' }}>
                                  <span className="spinner" style={{ width: 8, height: 8 }} /> Diagnosticando...
                                </span>
                              ) : row.comandoMitigacion ? (
                                <span className="text-[10px] block"
                                  style={{ color: '#ffb142' }}>
                                  {row.recommendation}
                                </span>
                              ) : row.recommendation ? (
                                <span className="text-[10px]" style={{ color: '#a5a5a5' }}>
                                  {row.recommendation}
                                </span>
                              ) : (
                                <span style={{ color: '#a5a5a5' }}>—</span>
                              )}
                            </td>
                            <td className="px-3 py-2" onClick={e => e.stopPropagation()}>
                              {row.comandoMitigacion && (
                                <button
                                  onClick={() => runManualMitigation(row.domain, row.comandoMitigacion!)}
                                  disabled={ts?.running || batchRunning}
                                  className="btn btn--ghost text-[10px] px-2 py-0.5"
                                  style={{
                                    borderColor: ts?.success ? '#33d9b2'
                                      : ts?.success === false ? '#ff5252'
                                      : '#ffb142',
                                    color: ts?.success ? '#33d9b2'
                                      : ts?.success === false ? '#ff5252'
                                      : '#ffb142',
                                  }}>
                                  {ts?.running ? '...' : ts?.success ? '✓' : ts?.success === false ? '✗' : '▶ Ejecutar'}
                                </button>
                              )}
                            </td>
                          </tr>
                          {expandedRows.has(row.domain) && (ts?.output || row.diagnosticOutput) && (
                            <tr className="border-b border-outline-variant">
                              <td colSpan={5} className="p-3 bg-black/20">
                                <pre className="text-[10px] font-mono whitespace-pre-wrap max-h-48 overflow-y-auto text-on-surface-variant">
                                  {ts?.output || row.diagnosticOutput}
                                </pre>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── Consola / Terminal en vivo ── */}
        <div 
          ref={consolaRef}
          className="bg-black p-3 rounded shrink-0 overflow-y-auto"
          style={{ maxHeight: 250 }}
        >
          {consolaLogs.length === 0 ? (
            <div className="text-[10px] text-green-400/50 font-mono italic">Esperando salida del motor de diagnóstico...</div>
          ) : (
            <div className="text-[10px] text-green-400 font-mono space-y-1">
              {consolaLogs.map((log, i) => (
                <div key={i} className="break-words">
                  <span className="opacity-50 mr-2">{'>'}</span>{log}
                </div>
              ))}
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
