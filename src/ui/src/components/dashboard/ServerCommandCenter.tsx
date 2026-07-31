import React, { useState, useEffect, useCallback, useRef } from 'react';
import { motion } from 'framer-motion';
import { ArrowLeft, X, Server, RefreshCw, AlertTriangle, CheckCircle, Info, Terminal, HardDrive, Cpu, Database, BarChart2, Wrench, Edit2, Globe, Activity, ShieldCheck, Network } from 'lucide-react';
import type { Server as ServerType } from '../../types/server';
import CmsAuditTab from './CmsAuditTab';
import FleetTab from './FleetTab';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ServerMetrics {
  ramTotalMb: number; ramUsedMb: number; ramFreeMb: number; ramPercent: number;
  cpuPercent: number;
  diskTotalMb: number; diskUsedMb: number; diskFreeMb: number; diskPercent: number;
  inodesTotal: number; inodesUsed: number; inodesPercent: number;
  load1: string; load5: string; load15: string;
  uptime: string;
  pleskVersion: string; osVersion: string; totalDomains: number;
  services: { nginx: string; apache: string; mysql: string; fail2ban: string; };
  netRxBytes: number; netTxBytes: number;
  timestamp: number;
}

interface LogEntry { raw: string; level: 'error' | 'warn' | 'info'; suggestion?: string }

interface Props {
  server: ServerType;
  onBack: () => void;
  onEdit?: () => void;
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
  const color = pct > 85 ? 'var(--color-error, #ff5252)' : pct > 65 ? 'var(--color-warning, #ffb142)' : 'oklch(0.6 0.15 250)';
  return (
    <div>
      <div className="flex justify-between text-xs mb-1 text-on-surface-variant">
        <span>{label}</span>
        <span style={{ color, fontFamily: 'ui-monospace, monospace' }}>{pct}%</span>
      </div>
      <div className="rounded-full overflow-hidden bg-white/5" style={{ height: 5 }}>
        <div style={{ width: `${pct}%`, height: '100%', backgroundColor: color, borderRadius: 3, transition: 'width 600ms ease-out' }} />
      </div>
    </div>
  );
}

function mbToGb(mb: number) { return (mb / 1024).toFixed(1) + ' GB'; }

// ── Fleet Actions Config ──────────────────────────────────────────────────────
// (Now handled inside FleetTab component)

// ── Component ─────────────────────────────────────────────────────────────────

const ServerCommandCenter: React.FC<Props> = ({ server, onBack, onEdit, onLog }) => {
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
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center justify-center w-9 h-9 rounded-lg bg-secondary/10 text-secondary">
              <Server size={18} />
            </span>
            <div>
              <h1 className="font-display text-xl font-bold">{server.name}</h1>
              <p className="text-xs font-mono text-on-surface-variant">
                {server.sshCredentials?.host} · Command Center
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {lastUpdated && (
              <span className="text-xs text-on-surface-variant">
                Actualizado {lastUpdated.toTimeString().slice(0, 8)}
              </span>
            )}
            {onEdit && (
              <button onClick={onEdit} className="btn btn--ghost p-1.5" title="Editar servidor">
                <Edit2 size={14} />
              </button>
            )}
            <button onClick={fetchMetrics} disabled={metricsLoading} className="btn btn--ghost p-1.5" title="Actualizar métricas">
              <RefreshCw size={14} className={metricsLoading ? 'animate-spin' : ''} />
            </button>
            <div className="w-px h-4 bg-outline-variant mx-1" />
            <button onClick={onBack} className="btn btn--ghost p-1.5 hover:bg-error/10 hover:text-error" title="Cerrar panel">
              <X size={16} />
            </button>
          </div>
        </div>
      </div>

      {/* ── Tabs ── */}
      <div className="flex border-b border-outline-variant">
        {([
          { id: 'vitals', label: 'Vitals',           icon: <BarChart2 size={13} /> },
          { id: 'logs',   label: `Logs${errorCount > 0 ? ` (${errorCount} errores)` : ''}`, icon: <Terminal size={13} /> },
          { id: 'fleet',  label: 'Acciones de Flota', icon: <HardDrive size={13} /> },
          { id: 'cms',    label: 'Reconstructor WP',  icon: <Wrench size={13} /> },
        ] as const).map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-xs font-medium transition-colors border-b-2 -mb-px ${
              activeTab === tab.id
                ? 'text-secondary border-secondary'
                : 'text-on-surface-variant border-transparent hover:text-on-surface'
            }`}
          >
            {tab.icon}{tab.label}
          </button>
        ))}
      </div>

      {/* ── VITALS ── */}
      <div style={{ display: activeTab === 'vitals' ? 'block' : 'none' }}>
        <div className="space-y-4">
          {metricsError && (
            <div className="p-3 rounded-lg text-xs flex items-center gap-2 bg-error/10 border border-error/30 text-error">
              <AlertTriangle size={13} />
              {metricsError}
            </div>
          )}

          {/* New: System Info & Network Row */}
          <div className="grid gap-4 mb-4" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
            {/* System Info */}
            <div className="card p-4 space-y-3">
              <div className="flex items-center gap-2 text-xs font-medium text-on-surface">
                <Server size={13} className="text-secondary" /> Información del Sistema
              </div>
              {metrics ? (
                <div className="text-xs space-y-2 text-on-surface-variant">
                  <div className="flex justify-between"><span>Sistema Operativo:</span> <span className="font-mono text-[11px]">{metrics.osVersion}</span></div>
                  <div className="flex justify-between"><span>Plesk Panel:</span> <span className="font-mono text-[11px]">{metrics.pleskVersion}</span></div>
                  <div className="flex justify-between"><span>Dominios Alojados:</span> <span className="font-mono text-[11px]">{metrics.totalDomains}</span></div>
                  <div className="flex justify-between">
                    <span>Uptime:</span>
                    <span className="font-mono text-[11px] flex items-center gap-1">
                      <CheckCircle size={10} className="text-green-400" /> {metrics.uptime}
                    </span>
                  </div>
                </div>
              ) : metricsLoading ? (
                <div className="flex justify-center py-4"><span className="spinner" /></div>
              ) : null}
            </div>

            {/* Services & Network */}
            <div className="card p-4 space-y-3">
              <div className="flex items-center gap-2 text-xs font-medium text-on-surface">
                <Activity size={13} className="text-secondary" /> Servicios y Red
              </div>
              {metrics ? (
                <div className="flex gap-6">
                  {/* Services */}
                  <div className="flex-1 space-y-1.5 text-xs text-on-surface-variant">
                    {Object.entries(metrics.services).map(([svc, status]) => (
                      <div key={svc} className="flex justify-between items-center">
                        <span className="capitalize">{svc}</span>
                        <div className="flex items-center gap-1.5">
                          <div className="rounded-full" style={{
                            width: 6, height: 6,
                            backgroundColor: status === 'active' ? '#4ade80' : status === 'unknown' ? 'oklch(0.55 0.01 250)' : 'oklch(0.6 0.2 25)'
                          }} />
                          <span className="font-mono text-[10px] uppercase">{status}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                  {/* Network */}
                  <div className="flex-1 space-y-2 text-xs border-l border-outline-variant pl-6 text-on-surface-variant">
                    <div className="flex justify-between items-center">
                      <div className="flex items-center gap-1"><Network size={11} /> Rx (Recibido)</div>
                      <span className="font-mono text-[11px]">{mbToGb(metrics.netRxBytes / 1024 / 1024)}</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <div className="flex items-center gap-1"><Network size={11} /> Tx (Enviado)</div>
                      <span className="font-mono text-[11px]">{mbToGb(metrics.netTxBytes / 1024 / 1024)}</span>
                    </div>
                  </div>
                </div>
              ) : metricsLoading ? (
                <div className="flex justify-center py-4"><span className="spinner" /></div>
              ) : null}
            </div>
          </div>

          {/* Gauges 3-col */}
          <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
            {/* CPU */}
            <div className="card p-4 space-y-3">
              <div className="flex items-center gap-2 text-xs font-medium text-on-surface">
                <Cpu size={13} className="text-secondary" /> CPU
              </div>
              {metrics ? (
                <>
                  <GaugeBar pct={Math.round(metrics.cpuPercent)} label="Uso" />
                  <div className="text-xs space-y-0.5 pt-2 font-mono text-on-surface-variant">
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
              <div className="flex items-center gap-2 text-xs font-medium text-on-surface">
                <Database size={13} className="text-secondary" /> RAM
              </div>
              {metrics ? (
                <>
                  <GaugeBar pct={metrics.ramPercent} label="Uso" />
                  <div className="text-xs space-y-0.5 pt-2 font-mono text-on-surface-variant">
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
              <div className="flex items-center gap-2 text-xs font-medium text-on-surface">
                <HardDrive size={13} className="text-secondary" /> Disco & Inodos
              </div>
              {metrics ? (
                <>
                  <GaugeBar pct={metrics.diskPercent} label="Espacio" />
                  <div className="text-[10px] mb-2 flex justify-between font-mono text-on-surface-variant">
                    <span>Libre: {mbToGb(metrics.diskFreeMb)}</span>
                    <span>Total: {mbToGb(metrics.diskTotalMb)}</span>
                  </div>
                  <GaugeBar pct={metrics.inodesPercent} label="Inodos" />
                  <div className="text-[10px] flex justify-between font-mono text-on-surface-variant">
                    <span>Usado: {metrics.inodesUsed.toLocaleString()}</span>
                    <span>Total: {metrics.inodesTotal.toLocaleString()}</span>
                  </div>
                </>
              ) : metricsLoading ? (
                <div className="flex justify-center py-4"><span className="spinner" /></div>
              ) : null}
            </div>
          </div>
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
                className={`text-xs px-2.5 py-1 rounded-md transition-all border ${
                  logFilter === f
                    ? f === 'error' ? 'bg-error/20 text-error border-error/40'
                      : f === 'warn' ? 'bg-yellow-500/20 text-yellow-400 border-yellow-500/40'
                      : 'bg-secondary/20 text-secondary border-secondary/40'
                    : 'bg-white/5 text-on-surface-variant border-outline-variant'
                }`}
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
            <div className="px-4 py-2 border-b border-outline-variant bg-surface-container-lowest flex items-center gap-2">
              <Terminal size={12} className="text-on-surface-variant" />
              <span className="text-xs font-mono text-on-surface-variant">
                /var/log/plesk/panel.log — tail -n 500
              </span>
            </div>

            {logsLoading ? (
              <div className="flex justify-center py-12"><span className="spinner" /></div>
            ) : (
              <div className="overflow-y-auto scrollbar-thin"
                style={{ maxHeight: 420, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace', fontSize: '0.7rem', lineHeight: 1.6 }}>
                {filteredLogs.length === 0 ? (
                  <div className="px-4 py-8 text-center text-xs text-on-surface-variant">
                    {logsLoaded ? 'Sin entradas para este filtro.' : 'Haz clic en "Actualizar" para cargar los logs.'}
                  </div>
                ) : (
                  filteredLogs.map((entry, idx) => {
                    const colorClass = entry.level === 'error' ? 'text-error'
                      : entry.level === 'warn' ? 'text-yellow-400'
                      : 'text-on-surface';
                    const bgClass = entry.level === 'error' ? 'bg-error/[0.07]'
                      : entry.level === 'warn' ? 'bg-yellow-500/[0.07]'
                      : '';
                    const hasSuggestion = !!entry.suggestion;
                    return (
                      <div
                        key={idx}
                        onClick={() => hasSuggestion && setSelectedEntry(selectedEntry?.raw === entry.raw ? null : entry)}
                        className={`px-4 py-1 border-b border-white/[0.04] ${colorClass} ${bgClass} ${hasSuggestion ? 'cursor-pointer' : ''}`}
                      >
                        <div className="flex items-start gap-2">
                          {hasSuggestion && <Info size={10} className="text-secondary flex-shrink-0 mt-0.5" />}
                          <span style={{ wordBreak: 'break-all' }}>{entry.raw}</span>
                        </div>
                        {selectedEntry?.raw === entry.raw && entry.suggestion && (
                          <div className="mt-1.5 ml-4 px-2 py-1.5 rounded text-[10px] bg-secondary/20 text-secondary border border-secondary/40">
                            {entry.suggestion}
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
