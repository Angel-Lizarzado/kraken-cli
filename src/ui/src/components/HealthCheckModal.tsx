import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Copy, Check, Search, AlertTriangle, Globe, Wifi, WifiOff } from 'lucide-react';

// ── Types ──

interface HealthResult {
  domain: string;
  status: 'ok' | 'redirect' | 'warning' | 'error' | 'dns';
  code: number | null;
  message: string;
  time: number;
}

interface HealthProgress {
  current: number;
  total: number;
  domain: string;
  result: HealthResult | null;
  phase: 'starting' | 'scanning';
}

type FilterMode = 'all' | 'ok' | 'warning' | 'error' | 'dns';

interface HealthCheckModalProps {
  isOpen: boolean;
  onClose: () => void;
  serverName: string;
  onLog: (message: string, type: 'info' | 'warning' | 'error' | 'success') => void;
}

// ── Component ──

const HealthCheckModal: React.FC<HealthCheckModalProps> = ({
  isOpen,
  onClose,
  serverName,
  onLog,
}) => {
  const [phase, setPhase] = useState<'idle' | 'scanning' | 'done'>('idle');
  const [results, setResults] = useState<HealthResult[]>([]);
  const [progress, setProgress] = useState<{ current: number; total: number }>({ current: 0, total: 0 });
  const [filter, setFilter] = useState<FilterMode>('all');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const scanStartRef = useRef<number>(0);
  const [elapsedTime, setElapsedTime] = useState(0);

  // Timer for elapsed time
  useEffect(() => {
    if (phase !== 'scanning') return;
    const interval = setInterval(() => {
      setElapsedTime(Math.floor((Date.now() - scanStartRef.current) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [phase]);

  // Listen for progress events
  useEffect(() => {
    if (!isOpen) return;
    const api = (window as any).api;
    if (!api) return;

    const handler = (...args: unknown[]) => {
      const data = args[0] as HealthProgress;
      if (!data) return;

      setProgress({ current: data.current, total: data.total });

      if (data.result) {
        setResults(prev => [...prev, data.result!]);
      }
    };

    api.receive('health:progress', handler);
    return () => {
      api.removeListener('health:progress', handler);
    };
  }, [isOpen]);

  // Start scan
  const startScan = useCallback(async () => {
    const api = (window as any).api;
    if (!api) return;

    setPhase('scanning');
    setResults([]);
    setProgress({ current: 0, total: 0 });
    setError(null);
    setFilter('all');
    setSearchTerm('');
    scanStartRef.current = Date.now();

    try {
      const response = await api.invoke('health:check-mass', { serverName }) as {
        success: boolean;
        results?: HealthResult[];
        error?: string;
      };

      if (response.success) {
        // Results already populated via progress events, but ensure final sync
        if (response.results) {
          setResults(response.results);
        }
        setPhase('done');
        onLog(`Health check completado: ${response.results?.length || 0} dominios escaneados.`, 'success');
      } else {
        setError(response.error || 'Error desconocido');
        setPhase('done');
        onLog(`Health check fallido: ${response.error}`, 'error');
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error desconocido';
      setError(message);
      setPhase('done');
      onLog(`Health check fallido: ${message}`, 'error');
    }
  }, [serverName, onLog]);

  // Cancel scan
  const cancelScan = useCallback(async () => {
    const api = (window as any).api;
    if (!api) return;

    try {
      await api.invoke('health:cancel');
    } catch { /* silent */ }
    setPhase('done');
  }, []);

  // Handle close — cancel if scanning
  const handleClose = useCallback(() => {
    if (phase === 'scanning') {
      cancelScan();
    }
    onClose();
    // Reset state after animation
    setTimeout(() => {
      setPhase('idle');
      setResults([]);
      setProgress({ current: 0, total: 0 });
      setError(null);
      setFilter('all');
      setSearchTerm('');
    }, 200);
  }, [phase, cancelScan, onClose]);

  // Auto-start on open
  useEffect(() => {
    if (isOpen && phase === 'idle') {
      startScan();
    }
  }, [isOpen, phase, startScan]);

  // ── Derived data ──

  const counts = useMemo(() => {
    const c = { ok: 0, redirect: 0, warning: 0, error: 0, dns: 0 };
    for (const r of results) {
      if (r.status === 'ok') c.ok++;
      else if (r.status === 'redirect') c.redirect++;
      else if (r.status === 'warning') c.warning++;
      else if (r.status === 'error') c.error++;
      else if (r.status === 'dns') c.dns++;
    }
    return c;
  }, [results]);

  const filtered = useMemo(() => {
    let list = results;
    if (filter === 'ok') list = results.filter(r => r.status === 'ok' || r.status === 'redirect');
    else if (filter === 'warning') list = results.filter(r => r.status === 'warning');
    else if (filter === 'error') list = results.filter(r => r.status === 'error');
    else if (filter === 'dns') list = results.filter(r => r.status === 'dns');

    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      list = list.filter(r => r.domain.toLowerCase().includes(term));
    }

    return list;
  }, [results, filter, searchTerm]);

  const criticalDomains = useMemo(
    () => results.filter(r => r.status === 'error' || r.status === 'dns'),
    [results],
  );

  // Copy failed domains
  const copyFailed = useCallback(async () => {
    const text = criticalDomains.map(r => `${r.domain} — ${r.message}`).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* fallback */ }
  }, [criticalDomains]);

  if (!isOpen) return null;

  const pct = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Overlay */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50"
            style={{ backgroundColor: 'oklch(0 0 0 / 0.6)' }}
            onClick={handleClose}
          />
          {/* Modal */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            className="fixed inset-4 z-50 m-auto flex flex-col"
            style={{
              maxWidth: '900px',
              maxHeight: '85vh',
              backgroundColor: 'var(--surface-raised)',
              border: '1px solid var(--border-default)',
              borderRadius: '12px',
              boxShadow: '0 24px 48px oklch(0 0 0 / 0.4)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div
              className="flex items-center justify-between px-5 py-4 border-b"
              style={{ borderColor: 'var(--border-default)' }}
            >
              <div className="flex items-center gap-2.5">
                <Globe size={18} style={{ color: 'var(--color-accent)' }} />
                <div>
                  <h2 className="font-display font-bold text-base">Monitor de Salud</h2>
                  <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    {serverName} · {phase === 'scanning'
                      ? `Escaneando ${progress.current}/${progress.total}...`
                      : phase === 'done'
                        ? `${results.length} dominios escaneados`
                        : 'Preparando...'}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {phase === 'scanning' && (
                  <button
                    onClick={cancelScan}
                    className="btn text-xs"
                    style={{
                      backgroundColor: 'oklch(0.45 0.12 25 / 0.2)',
                      color: 'var(--color-error)',
                      border: '1px solid oklch(0.45 0.12 25 / 0.25)',
                    }}
                  >
                    Cancelar
                  </button>
                )}
                {phase === 'done' && (
                  <button onClick={startScan} className="btn btn--primary text-xs">
                    Repetir escaneo
                  </button>
                )}
                <button onClick={handleClose} className="btn btn--ghost p-1.5">
                  <X size={16} />
                </button>
              </div>
            </div>

            {/* Progress bar (scanning) */}
            {phase === 'scanning' && (
              <div className="px-5 py-3" style={{ borderBottom: '1px solid var(--border-default)' }}>
                <div className="flex items-center justify-between text-xs mb-1.5">
                  <span style={{ color: 'var(--text-secondary)' }}>
                    Procesando {progress.current} de {progress.total} dominios
                  </span>
                  <span className="font-mono" style={{ color: 'var(--text-muted)' }}>
                    {pct}% · {elapsedTime}s
                  </span>
                </div>
                <div
                  style={{
                    height: '4px',
                    borderRadius: '2px',
                    backgroundColor: 'var(--surface-overlay)',
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      width: `${pct}%`,
                      height: '100%',
                      borderRadius: '2px',
                      backgroundColor: 'var(--color-accent)',
                      transition: 'width 0.3s ease',
                    }}
                  />
                </div>
              </div>
            )}

            {/* Summary counters */}
            {results.length > 0 && (
              <div
                className="px-5 py-3 flex gap-3 flex-wrap"
                style={{ borderBottom: '1px solid var(--border-default)' }}
              >
                <CounterPill
                  label="OK"
                  count={counts.ok + counts.redirect}
                  color="var(--color-success)"
                  active={filter === 'ok'}
                  onClick={() => setFilter(f => f === 'ok' ? 'all' : 'ok')}
                />
                <CounterPill
                  label="Advertencia"
                  count={counts.warning}
                  color="var(--color-warning)"
                  active={filter === 'warning'}
                  onClick={() => setFilter(f => f === 'warning' ? 'all' : 'warning')}
                />
                <CounterPill
                  label="Error"
                  count={counts.error}
                  color="var(--color-error)"
                  active={filter === 'error'}
                  onClick={() => setFilter(f => f === 'error' ? 'all' : 'error')}
                />
                <CounterPill
                  label="DNS"
                  count={counts.dns}
                  color="oklch(0.65 0.18 290)"
                  active={filter === 'dns'}
                  onClick={() => setFilter(f => f === 'dns' ? 'all' : 'dns')}
                />

                {/* Search */}
                <div className="flex-1 min-w-[180px]">
                  <div
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs"
                    style={{
                      backgroundColor: 'var(--surface-overlay)',
                      border: '1px solid var(--border-default)',
                    }}
                  >
                    <Search size={12} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                    <input
                      type="text"
                      placeholder="Buscar dominio..."
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                      className="bg-transparent outline-none flex-1 text-xs"
                      style={{ color: 'var(--text-primary)', border: 'none' }}
                    />
                  </div>
                </div>
              </div>
            )}

            {/* Critical section */}
            {phase === 'done' && criticalDomains.length > 0 && filter === 'all' && (
              <div
                className="mx-5 mt-3 p-3 rounded-lg"
                style={{
                  backgroundColor: 'oklch(0.45 0.12 25 / 0.1)',
                  border: '1px solid oklch(0.45 0.12 25 / 0.2)',
                }}
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-1.5 text-xs font-medium" style={{ color: 'var(--color-error)' }}>
                    <AlertTriangle size={13} />
                    {criticalDomains.length} dominio{criticalDomains.length !== 1 ? 's' : ''} con problemas
                  </div>
                  <button
                    onClick={copyFailed}
                    className="flex items-center gap-1 text-xs btn btn--ghost"
                    style={{
                      color: copied ? 'var(--color-success)' : 'var(--text-muted)',
                      padding: '3px 8px',
                    }}
                  >
                    {copied ? <Check size={12} /> : <Copy size={12} />}
                    {copied ? 'Copiado' : 'Copiar lista'}
                  </button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {criticalDomains.slice(0, 12).map(r => (
                    <span
                      key={r.domain}
                      className="text-[10px] font-mono px-1.5 py-0.5 rounded"
                      style={{
                        backgroundColor: r.status === 'dns'
                          ? 'oklch(0.65 0.18 290 / 0.15)'
                          : 'oklch(0.45 0.12 25 / 0.15)',
                        color: r.status === 'dns'
                          ? 'oklch(0.75 0.15 290)'
                          : 'var(--color-error)',
                      }}
                    >
                      {r.domain}
                    </span>
                  ))}
                  {criticalDomains.length > 12 && (
                    <span className="text-[10px] py-0.5" style={{ color: 'var(--text-muted)' }}>
                      +{criticalDomains.length - 12} más
                    </span>
                  )}
                </div>
              </div>
            )}

            {/* Error message */}
            {error && results.length === 0 && (
              <div className="px-5 py-8 text-center">
                <AlertTriangle size={32} className="mx-auto mb-3" style={{ color: 'var(--color-error)' }} />
                <p className="text-sm" style={{ color: 'var(--color-error)' }}>{error}</p>
              </div>
            )}

            {/* Results list */}
            <div className="flex-1 overflow-y-auto px-5 py-3">
              {filtered.length === 0 && results.length > 0 && (
                <div className="text-center py-8">
                  <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    No hay resultados para este filtro.
                  </p>
                </div>
              )}
              <div className="space-y-1">
                {filtered.map((r) => (
                  <ResultRow key={r.domain} result={r} />
                ))}
              </div>
            </div>

            {/* Footer */}
            {phase === 'done' && results.length > 0 && (
              <div
                className="px-5 py-2.5 text-xs border-t flex items-center justify-between"
                style={{
                  borderColor: 'var(--border-default)',
                  color: 'var(--text-muted)',
                  backgroundColor: 'var(--surface-base)',
                  borderRadius: '0 0 12px 12px',
                }}
              >
                <span>
                  {results.length} dominios · {counts.ok + counts.redirect} OK · {counts.error + counts.dns} con errores
                </span>
                <span className="font-mono">
                  {elapsedTime}s total
                </span>
              </div>
            )}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
};

export default HealthCheckModal;

// ── Sub-components ──

interface CounterPillProps {
  label: string;
  count: number;
  color: string;
  active: boolean;
  onClick: () => void;
}

const CounterPill = React.memo(function CounterPill({ label, count, color, active, onClick }: CounterPillProps) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs transition-all duration-100"
      style={{
        backgroundColor: active ? `${color}20` : 'var(--surface-overlay)',
        border: `1px solid ${active ? color : 'var(--border-default)'}`,
        color: active ? color : 'var(--text-secondary)',
        cursor: 'pointer',
      }}
    >
      <span
        style={{
          width: '8px',
          height: '8px',
          borderRadius: '50%',
          backgroundColor: color,
          opacity: count > 0 ? 1 : 0.3,
        }}
      />
      <span className="font-medium">{count}</span>
      <span>{label}</span>
    </button>
  );
});

const ResultRow = React.memo(function ResultRow({ result }: { result: HealthResult }) {
  const statusConfig = {
    ok:       { icon: Wifi,       color: 'var(--color-success)', bg: 'oklch(0.55 0.15 145 / 0.1)' },
    redirect: { icon: Wifi,       color: 'var(--color-info)',    bg: 'oklch(0.55 0.15 230 / 0.1)' },
    warning:  { icon: AlertTriangle, color: 'var(--color-warning)', bg: 'oklch(0.55 0.15 75 / 0.1)' },
    error:    { icon: WifiOff,    color: 'var(--color-error)',   bg: 'oklch(0.45 0.12 25 / 0.1)' },
    dns:      { icon: Globe,      color: 'oklch(0.75 0.15 290)', bg: 'oklch(0.65 0.18 290 / 0.1)' },
  } as const;

  const cfg = statusConfig[result.status] || statusConfig.error;
  const Icon = cfg.icon;

  return (
    <div
      className="flex items-center gap-2.5 px-3 py-2 rounded-md text-xs"
      style={{ backgroundColor: cfg.bg }}
    >
      <Icon size={13} style={{ color: cfg.color, flexShrink: 0 }} />
      <span className="font-mono flex-1 truncate" style={{ color: 'var(--text-primary)' }}>
        {result.domain}
      </span>
      <span className="font-mono" style={{ color: cfg.color, minWidth: '60px', textAlign: 'right' }}>
        {result.code ? `${result.code}` : result.message}
      </span>
      <span className="font-mono" style={{ color: 'var(--text-muted)', minWidth: '45px', textAlign: 'right' }}>
        {result.time}ms
      </span>
    </div>
  );
});
