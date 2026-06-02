import React, { useState, useEffect, useCallback, useRef } from 'react';
import { motion } from 'framer-motion';
import { ArrowLeft, Server, RefreshCw, AlertTriangle, CheckCircle, Info, Terminal, HardDrive, Cpu, Database, BarChart2, Wrench } from 'lucide-react';
import type { Server as ServerType } from '../../types/server';
import CmsAuditTab from './CmsAuditTab';
import FleetTab from './FleetTab';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ServerMetrics {
  ramTotalMb: number; ramUsedMb: number; ramFreeMb: number; ramPercent: number;
  cpuPercent: number;
  diskTotalMb: number; diskUsedMb: number; diskFreeMb: number; diskPercent: number;
  load1: string; load5: string; load15: string;
  uptime: string;
  timestamp: number;
}

interface LogEntry { raw: string; level: 'error' | 'warn' | 'info'; suggestion?: string }

interface Props {
  server: ServerType;
  onBack: () => void;
  onLog: (msg: string, type: 'info' | 'warning' | 'error' | 'success') => void;
}

// ── Smart Log Parser ──────────────────────────────────────────────────────────

const LOG_PATTERNS: Array<{ regex: RegExp; level: 'error' | 'warn'; suggestion: string }> = [
  { regex: /acme|letsencrypt|certbot|ssl.*fail|certificate.*error/i,     level: 'error', suggestion: 'SSL/Let\'s Encrypt falló. Sugerencia: Ejecuta "Repair Web" para regenerar el certificado.' },
  { regex: /403 forbidden|permission denied/i,                           level: 'error', suggestion: 'Error 403/Permisos. Sugerencia: Ejecuta "Repair FS" para corregir permisos de archivos.' },
  { regex: /dns.*fail|name.*resolution|nxdomain/i,                       level: 'warn',  suggestion: 'Fallo de DNS. Sugerencia: Verifica la propagación DNS del dominio afectado.' },
  { regex: /mysql.*error|database.*connect|access denied for user/i,     level: 'error', suggestion: 'Error de MySQL. Sugerencia: Ejecuta "MySQL Optimize" o revisa las credenciales de la DB.' },
  { regex: /php.*error|fatal error.*php|segfault/i,                      level: 'error', suggestion: 'Error de PHP. Sugerencia: Reinicia PHP-FPM desde las acciones de flota.' },
  { regex: /nginx|apache.*error|httpd.*fail/i,                           level: 'warn',  suggestion: 'Error de servidor web. Sugerencia: Reinicia Nginx o Apache.' },
  { regex: /disk.*full|no space left|enospc/i,                           level: 'error', suggestion: '⚠ Disco lleno. Acción urgente: limpia backups o logs del servidor.' },
  { regex: /warn|warning/i,                                              level: 'warn',  suggestion: undefined as any },
  { regex: /error|fail|crit|emerg/i,                                     level: 'error', suggestion: undefined as any },
];

function parseLogs(raw: string): LogEntry[] {
  return raw
    .split('\n')
    .filter(l => l.trim())
    .map(line => {
      for (const p of LOG_PATTERNS) {
        if (p.regex.test(line)) {
          return { raw: line, level: p.level, suggestion: p.suggestion };
        }
      }
      return { raw: line, level: 'info' as const };
    });
}

// ── Gauge Bar ─────────────────────────────────────────────────────────────────

function GaugeBar({ pct, label }: { pct: number; label: string }) {
  const color = pct > 85 ? 'var(--color-error)' : pct > 65 ? 'var(--color-warning)' : 'var(--color-accent)';
  return (
    <div>
      <div className="flex justify-between text-xs mb-1" style={{ color: 'var(--text-muted)' }}>
        <span>{label}</span>
        <span style={{ color, fontFamily: 'var(--font-mono)' }}>{pct}%</span>
      </div>
      <div style={{ height: 5, borderRadius: 3, backgroundColor: 'var(--surface-overlay)', overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', backgroundColor: color, borderRadius: 3, transition: 'width 600ms ease-out' }} />
      </div>
    </div>
  );
}

function mbToGb(mb: number) { return (mb / 1024).toFixed(1) + ' GB'; }

// ── Fleet Actions Config ──────────────────────────────────────────────────────
// (Now handled inside FleetTab component)

// ── Component ─────────────────────────────────────────────────────────────────

const ServerCommandCenter: React.FC<Props> = ({ server, onBack, onLog }) => {
  const api = (window as any).api;

  // Métricas
  const [metrics, setMetrics] = useState<ServerMetrics | null>(null);
  const [metricsError, setMetricsError] = useState<string | null>(null);
  const [metricsLoading, setMetricsLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  // Logs
  const [activeTab, setActiveTab] = useState<'vitals' | 'logs' | 'fleet' | 'cms'>('vitals');
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsLoaded, setLogsLoaded] = useState(false);
  const [logFilter, setLogFilter] = useState<'all' | 'error' | 'warn'>('all');
  const [selectedEntry, setSelectedEntry] = useState<LogEntry | null>(null);

  // Fleet actions — managed by FleetTab

  // Polling
  const pollingRef = useRef(false);

  // ── Métricas on-demand + start polling ──────────────────────────────────────
  const fetchMetrics = useCallback(async () => {
    setMetricsLoading(true);
    try {
      const res = await api?.invoke('server:metrics-fetch', { serverName: server.name });
      if (res?.success) {
        setMetrics(res.metrics);
        setLastUpdated(new Date());
        setMetricsError(null);
      } else {
        setMetricsError(res?.error || 'Error al obtener métricas');
      }
    } catch (e: any) {
      setMetricsError(e?.message || 'Error IPC');
    } finally {
      setMetricsLoading(false);
    }
  }, [server.name]);

  useEffect(() => {
    // Fetch inicial
    fetchMetrics();

    // Iniciar polling en el backend (60s)
    api?.invoke('server:metrics-start', { serverName: server.name });
    pollingRef.current = true;

    // Listener para updates del polling
    const metricsHandler = (payload: any) => {
      if (payload?.serverName !== server.name) return;
      if (payload.metrics) {
        setMetrics(payload.metrics);
        setLastUpdated(new Date());
        setMetricsError(null);
      } else if (payload.error) {
        setMetricsError(payload.error);
      }
    };

    api?.receive('server:metrics-update', metricsHandler);

    return () => {
      api?.removeListener('server:metrics-update', metricsHandler);
      if (pollingRef.current) {
        api?.invoke('server:metrics-stop', { serverName: server.name }).catch(() => {});
        pollingRef.current = false;
      }
    };
  }, [server.name]);

  // ── Cargar logs ──────────────────────────────────────────────────────────────
  const fetchLogs = useCallback(async () => {
    setLogsLoading(true);
    try {
      const res = await api?.invoke('fleet:get-log', { serverName: server.name, lines: 500 });
      if (res?.success) {
        setLogEntries(parseLogs(res.log));
        setLogsLoaded(true);
      } else {
        setLogEntries([{ raw: `Error: ${res?.error || 'No se pudo obtener el log'}`, level: 'error' }]);
      }
    } catch (e: any) {
      setLogEntries([{ raw: `Error IPC: ${e?.message}`, level: 'error' }]);
    } finally {
      setLogsLoading(false);
    }
  }, [server.name]);

  // Auto-cargar logs al cambiar a la pestaña
  useEffect(() => {
    if (activeTab === 'logs' && !logsLoaded) fetchLogs();
  }, [activeTab, logsLoaded, fetchLogs]);

  const filteredLogs = logFilter === 'all' ? logEntries
    : logEntries.filter(e => e.level === logFilter);

  const errorCount = logEntries.filter(e => e.level === 'error').length;
  const warnCount  = logEntries.filter(e => e.level === 'warn').length;

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <motion.div
      initial={{ opacity: 0, x: 24 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -24 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className="space-y-5"
    >
      {/* ── Breadcrumb + Header ── */}
      <div>
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-xs mb-3 btn btn--ghost px-0"
          style={{ color: 'var(--text-muted)' }}
        >
          <ArrowLeft size={13} />
          Panel de servidores
        </button>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 36, height: 36, borderRadius: 8,
              backgroundColor: 'var(--color-accent-bg)', color: 'var(--color-accent)',
            }}>
              <Server size={18} />
            </span>
            <div>
              <h1 className="font-display text-xl font-bold">{server.name}</h1>
              <p className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
                {server.sshCredentials?.host} · Command Center
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {lastUpdated && (
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                Actualizado {lastUpdated.toTimeString().slice(0, 8)}
              </span>
            )}
            <button onClick={fetchMetrics} disabled={metricsLoading} className="btn btn--ghost p-1.5" title="Actualizar métricas">
              <RefreshCw size={14} className={metricsLoading ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>
      </div>

      {/* ── Tabs ── */}
      <div className="flex border-b" style={{ borderColor: 'var(--border-default)' }}>
        {([
          { id: 'vitals', label: 'Vitals',           icon: <BarChart2 size={13} /> },
          { id: 'logs',   label: `Logs${errorCount > 0 ? ` (${errorCount} errores)` : ''}`, icon: <Terminal size={13} /> },
          { id: 'fleet',  label: 'Acciones de Flota', icon: <HardDrive size={13} /> },
          { id: 'cms',    label: 'Reconstructor WP',  icon: <Wrench size={13} /> },
        ] as const).map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className="flex items-center gap-1.5 px-4 py-2.5 text-xs font-medium transition-colors"
            style={{
              color: activeTab === tab.id ? 'var(--color-accent)' : 'var(--text-muted)',
              borderBottom: activeTab === tab.id ? '2px solid var(--color-accent)' : '2px solid transparent',
            }}
          >
            {tab.icon}{tab.label}
          </button>
        ))}
      </div>

      {/* ── VITALS ── */}
      <div style={{ display: activeTab === 'vitals' ? 'block' : 'none' }}>
        <div className="space-y-4">
          {metricsError && (
            <div className="p-3 rounded-lg text-xs flex items-center gap-2"
              style={{ backgroundColor: 'oklch(0.45 0.12 25 / 0.12)', border: '1px solid oklch(0.45 0.12 25 / 0.3)', color: 'var(--color-error)' }}>
              <AlertTriangle size={13} />
              {metricsError}
            </div>
          )}

          {/* Gauges 3-col */}
          <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
            {/* CPU */}
            <div className="card p-4 space-y-3">
              <div className="flex items-center gap-2 text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                <Cpu size={13} style={{ color: 'var(--color-accent)' }} /> CPU
              </div>
              {metrics ? (
                <>
                  <GaugeBar pct={Math.round(metrics.cpuPercent)} label="Uso" />
                  <div className="text-xs space-y-0.5" style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                    <div>Load 1m: {metrics.load1}</div>
                    <div>Load 5m: {metrics.load5}</div>
                    <div>Load 15m: {metrics.load15}</div>
                  </div>
                </>
              ) : metricsLoading ? (
                <div className="flex justify-center py-4"><span className="spinner" /></div>
              ) : null}
            </div>

            {/* RAM */}
            <div className="card p-4 space-y-3">
              <div className="flex items-center gap-2 text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                <Database size={13} style={{ color: 'var(--color-accent)' }} /> RAM
              </div>
              {metrics ? (
                <>
                  <GaugeBar pct={metrics.ramPercent} label="Uso" />
                  <div className="text-xs space-y-0.5" style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                    <div>Usada: {mbToGb(metrics.ramUsedMb)}</div>
                    <div>Libre: {mbToGb(metrics.ramFreeMb)}</div>
                    <div>Total: {mbToGb(metrics.ramTotalMb)}</div>
                  </div>
                </>
              ) : metricsLoading ? (
                <div className="flex justify-center py-4"><span className="spinner" /></div>
              ) : null}
            </div>

            {/* Disco */}
            <div className="card p-4 space-y-3">
              <div className="flex items-center gap-2 text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                <HardDrive size={13} style={{ color: 'var(--color-accent)' }} /> Disco
              </div>
              {metrics ? (
                <>
                  <GaugeBar pct={metrics.diskPercent} label="Uso" />
                  <div className="text-xs space-y-0.5" style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                    <div>Usado: {mbToGb(metrics.diskUsedMb)}</div>
                    <div>Libre: {mbToGb(metrics.diskFreeMb)}</div>
                    <div>Total: {mbToGb(metrics.diskTotalMb)}</div>
                  </div>
                </>
              ) : metricsLoading ? (
                <div className="flex justify-center py-4"><span className="spinner" /></div>
              ) : null}
            </div>
          </div>

          {/* Uptime */}
          {metrics && (
            <div className="card px-4 py-3 flex items-center gap-3 text-xs"
              style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>
              <CheckCircle size={13} style={{ color: 'var(--color-success)' }} />
              <span>Uptime: <strong style={{ color: 'var(--text-primary)' }}>{metrics.uptime}</strong></span>
              <span style={{ color: 'var(--text-muted)' }}>· Polling automático cada 60s</span>
            </div>
          )}
        </div>
      </div>

      {/* ── LOGS ── */}
      <div style={{ display: activeTab === 'logs' ? 'block' : 'none' }}>
        <div className="space-y-3">
          {/* Controls */}
          <div className="flex items-center gap-2 flex-wrap">
            {(['all', 'error', 'warn'] as const).map(f => (
              <button
                key={f}
                onClick={() => setLogFilter(f)}
                className="text-xs px-2.5 py-1 rounded-md transition-all"
                style={{
                  backgroundColor: logFilter === f
                    ? f === 'error' ? 'oklch(0.45 0.12 25 / 0.2)' : f === 'warn' ? 'oklch(0.55 0.15 75 / 0.2)' : 'var(--color-accent-bg)'
                    : 'var(--surface-overlay)',
                  color: logFilter === f
                    ? f === 'error' ? 'var(--color-error)' : f === 'warn' ? 'var(--color-warning)' : 'var(--color-accent)'
                    : 'var(--text-muted)',
                  border: `1px solid ${logFilter === f ? 'currentColor' : 'var(--border-default)'}`,
                }}
              >
                {f === 'all' ? `Todos (${logEntries.length})` : f === 'error' ? `Errores (${errorCount})` : `Warnings (${warnCount})`}
              </button>
            ))}
            <button onClick={fetchLogs} disabled={logsLoading} className="btn btn--ghost text-xs ml-auto flex items-center gap-1">
              <RefreshCw size={11} className={logsLoading ? 'animate-spin' : ''} />
              Actualizar
            </button>
          </div>

          {/* Log viewer */}
          <div className="card overflow-hidden">
            <div className="px-4 py-2 border-b flex items-center gap-2"
              style={{ borderColor: 'var(--border-default)', backgroundColor: 'oklch(0.15 0.01 250)' }}>
              <Terminal size={12} style={{ color: 'var(--text-muted)' }} />
              <span className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
                /var/log/plesk/panel.log — tail -n 500
              </span>
            </div>

            {logsLoading ? (
              <div className="flex justify-center py-12"><span className="spinner" /></div>
            ) : (
              <div className="overflow-y-auto scrollbar-thin"
                style={{ maxHeight: 420, fontFamily: 'var(--font-mono)', fontSize: '0.7rem', lineHeight: 1.6 }}>
                {filteredLogs.length === 0 ? (
                  <div className="px-4 py-8 text-center text-xs" style={{ color: 'var(--text-muted)' }}>
                    {logsLoaded ? 'Sin entradas para este filtro.' : 'Haz clic en "Actualizar" para cargar los logs.'}
                  </div>
                ) : (
                  filteredLogs.map((entry, idx) => {
                    const color = entry.level === 'error' ? 'var(--color-error)'
                      : entry.level === 'warn' ? 'var(--color-warning)'
                      : 'var(--text-secondary)';
                    const bg = entry.level === 'error' ? 'oklch(0.45 0.12 25 / 0.07)'
                      : entry.level === 'warn' ? 'oklch(0.55 0.15 75 / 0.07)'
                      : 'transparent';
                    const hasSuggestion = !!entry.suggestion;
                    return (
                      <div
                        key={idx}
                        onClick={() => hasSuggestion && setSelectedEntry(selectedEntry?.raw === entry.raw ? null : entry)}
                        className="px-4 py-1 border-b"
                        style={{
                          color, backgroundColor: bg,
                          borderBottomColor: 'oklch(1 0 0 / 0.04)',
                          cursor: hasSuggestion ? 'pointer' : 'default',
                        }}
                      >
                        <div className="flex items-start gap-2">
                          {hasSuggestion && <Info size={10} style={{ color: 'var(--color-accent)', flexShrink: 0, marginTop: 3 }} />}
                          <span style={{ wordBreak: 'break-all' }}>{entry.raw}</span>
                        </div>
                        {selectedEntry?.raw === entry.raw && entry.suggestion && (
                          <div className="mt-1.5 ml-4 px-2 py-1.5 rounded text-[10px]"
                            style={{ backgroundColor: 'var(--color-accent-bg)', color: 'var(--color-accent)', border: '1px solid var(--color-accent)' }}>
                            💡 {entry.suggestion}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── FLEET ACTIONS (Smart Heal) ── */}
      <div style={{ display: activeTab === 'fleet' ? 'block' : 'none' }}>
        <FleetTab serverName={server.name} onLog={onLog} />
      </div>

      {/* ── CMS RECONSTRUCTOR ── */}
      <div style={{ display: activeTab === 'cms' ? 'block' : 'none' }}>
        <CmsAuditTab server={server} />
      </div>
    </motion.div>
  );
};

export default ServerCommandCenter;
