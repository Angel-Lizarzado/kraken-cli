import { Activity, RefreshCw, Clock, HardDrive, Cpu, Zap } from 'lucide-react';
import MetricsWidget from './MetricsWidget';
import QuickActions from './QuickActions';
import ProgressBar from './ProgressBar';
import { formatBytes } from './formatBytes';
import type { Server } from '../../types/server';
import type { LogLevel } from '../../types/ipc';

// ── Props ──
interface ServerDetailViewProps {
  server: Server;
  onRunDiagnostics: (serverName: string) => void;
  onLog: (message: string, type: LogLevel) => void;
  execServerCommand: (serverName: string, command: string) => Promise<{
    success: boolean;
    stdout?: string;
    stderr?: string;
    error?: string;
  }>;
  onMetricsRefresh?: (serverName: string) => void;
}

// ── Metric tile ──
interface StatTileProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  color: 'success' | 'warning' | 'error' | 'info';
}

function StatTile({ icon, label, value, color }: StatTileProps) {
  const colorVar =
    color === 'success'
      ? 'var(--color-success)'
      : color === 'warning'
        ? 'var(--color-warning)'
        : color === 'error'
          ? 'var(--color-error)'
          : 'var(--color-accent)';

  return (
    <div
      className="flex items-center gap-3 p-3 rounded-lg"
      style={{
        backgroundColor: 'var(--surface-overlay)',
        border: '1px solid var(--border-default)',
      }}
    >
      <div
        className="flex items-center justify-center rounded-lg"
        style={{
          width: '36px',
          height: '36px',
          backgroundColor: `${colorVar}15`,
          color: colorVar,
        }}
      >
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[10px] font-medium uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
          {label}
        </div>
        <div className="text-sm font-bold font-mono truncate">{value}</div>
      </div>
    </div>
  );
}

// ── Component ──
export default function ServerDetailView({
  server,
  onRunDiagnostics,
  onLog,
  execServerCommand,
  onMetricsRefresh,
}: ServerDetailViewProps) {
  // ── No diagnostics state ──
  if (!server.diagnostics) {
    return (
      <div className="text-center py-12" style={{ color: 'var(--text-muted)' }}>
        <Activity size={32} className="mx-auto mb-3 opacity-40" />
        <p className="text-sm">Sin datos de diagnóstico</p>
        <button
          onClick={() => onRunDiagnostics(server.name)}
          className="btn btn--secondary text-xs mt-4"
        >
          <RefreshCw size={12} />
          Ejecutar diagnóstico
        </button>
      </div>
    );
  }

  const { diagnostics } = server;
  const cpuPercent = Math.min(
    (diagnostics.cpu.load / (diagnostics.cpu.cores * 100)) * 100,
    100,
  );
  const ramPercent = diagnostics.ram.percent;
  const diskPercent = diagnostics.disk.percent;

  const ramBarColor: 'success' | 'warning' | 'error' =
    ramPercent > 90 ? 'error' : ramPercent > 70 ? 'warning' : 'success';
  const diskBarColor: 'success' | 'warning' | 'error' =
    diskPercent > 90 ? 'error' : diskPercent > 70 ? 'warning' : 'success';
  const cpuBarColor: 'success' | 'warning' | 'error' =
    cpuPercent > 90 ? 'error' : cpuPercent > 70 ? 'warning' : 'success';

  return (
    <div className="space-y-6">
      {/* ── SVG Gauges ── */}
      <MetricsWidget diagnostics={diagnostics} />

      {/* ── Resource bars (detailed) ── */}
      <div
        className="p-4 rounded-lg space-y-4"
        style={{ backgroundColor: 'var(--surface-overlay)', border: '1px solid var(--border-default)' }}
      >
        <h3 className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
          Recursos en detalle
        </h3>

        <div className="space-y-3">
          {/* CPU */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-medium flex items-center gap-1.5">
                <Cpu size={12} style={{ color: 'var(--color-accent)' }} />
                CPU
              </span>
              <span className="text-xs font-mono">
                {diagnostics.cpu.load.toFixed(1)} / {diagnostics.cpu.cores} cores
              </span>
            </div>
            <ProgressBar percent={cpuPercent} color={cpuBarColor} />
          </div>

          {/* RAM */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-medium flex items-center gap-1.5">
                <Zap size={12} style={{ color: 'var(--color-success)' }} />
                RAM
              </span>
              <span className="text-xs font-mono">
                {formatBytes(diagnostics.ram.used * 1024)} / {formatBytes(diagnostics.ram.total * 1024)}
              </span>
            </div>
            <ProgressBar percent={ramPercent} color={ramBarColor} />
          </div>

          {/* Disk */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-medium flex items-center gap-1.5">
                <HardDrive size={12} style={{ color: 'var(--color-warning)' }} />
                Disco
              </span>
              <span className="text-xs font-mono">
                {formatBytes(diagnostics.disk.used)} / {formatBytes(diagnostics.disk.total)}
              </span>
            </div>
            <ProgressBar percent={diskPercent} color={diskBarColor} />
          </div>
        </div>
      </div>

      {/* ── Stat tiles ── */}
      <div className="grid grid-cols-2 gap-3">
        <StatTile
          icon={<Clock size={16} />}
          label="Uptime"
          value={diagnostics.uptime}
          color="info"
        />
        <StatTile
          icon={<HardDrive size={16} />}
          label="Host"
          value={`${server.sshCredentials.host}:${server.sshCredentials.port}`}
          color="info"
        />
      </div>

      {/* ── Quick Actions ── */}
      <QuickActions server={server} onLog={onLog} execServerCommand={execServerCommand} onMetricsRefresh={onMetricsRefresh} />
    </div>
  );
}
