import React from 'react';
import { motion } from 'framer-motion';
import { ChevronRight } from 'lucide-react';
import StatusDot from './StatusDot';
import type { Server } from '../../types/server';

interface ServerCardProps {
  server: Server;
  isSelected: boolean;
  onSelect: (server: Server) => void;
}

const ServerCard = React.memo(function ServerCard({ server, isSelected, onSelect }: ServerCardProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.15, ease: 'easeOut' }}
      className="card flex items-center gap-3 p-3 cursor-pointer"
      style={{
        height: '76px',
        borderColor: isSelected ? 'var(--color-accent)' : 'var(--border-default)',
        backgroundColor: isSelected ? 'oklch(0.22 0.05 260 / 0.3)' : 'var(--surface-base)',
        transition: 'background-color 0.15s ease, border-color 0.15s ease',
      }}
      whileHover={{ scale: 1.02 }}
      whileTap={{ scale: 0.98 }}
      onClick={() => onSelect(server)}
    >
      {/* Left: status dot + name + host */}
      <div className="min-w-0 flex-1 flex items-center gap-2">
        <StatusDot status={server.status} />
        <div className="min-w-0">
          <div className="font-display font-bold text-sm truncate">{server.name}</div>
          <div className="text-xs font-mono truncate" style={{ color: 'var(--text-muted)' }}>
            {server.sshCredentials.host}:{server.sshCredentials.port}
          </div>
        </div>
      </div>

      {/* Middle: mini progress bars */}
      <div className="flex items-center gap-2">
        {server.diagnostics ? (
          <MiniMetrics diagnostics={server.diagnostics} />
        ) : (
          <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Sin datos</span>
        )}
      </div>

      {/* Right: SSH status + chevron */}
      <div className="flex items-center gap-1.5 flex-shrink-0">
        <span
          className={`tag ${server.isLinked ? 'tag--success' : 'tag--error'} text-[10px] leading-none`}
        >
          {server.isLinked ? 'SSH' : 'No SSH'}
        </span>
        <ChevronRight size={14} style={{ color: 'var(--text-muted)' }} />
      </div>
    </motion.div>
  );
});

export default ServerCard;

// ── Mini in-bar metrics ──
interface MiniMetricsProps {
  diagnostics: NonNullable<Server['diagnostics']>;
}

const MiniMetrics = React.memo(function MiniMetrics({ diagnostics }: MiniMetricsProps) {
  const cpuPct = Math.min((diagnostics.cpu.load / (diagnostics.cpu.cores * 100)) * 100, 100);
  const ramPct = diagnostics.ram.percent;
  const diskPct = diagnostics.disk.percent;

  const bars = [
    { label: 'CPU', pct: cpuPct },
    { label: 'RAM', pct: ramPct },
    { label: 'Disco', pct: diskPct },
  ];

  return (
    <>
      {bars.map(m => {
        const fillColor = m.pct > 90 ? 'var(--color-error)' : m.pct > 70 ? 'var(--color-warning)' : 'var(--color-success)';
        return (
          <div key={m.label} className="flex flex-col items-center gap-0.5">
            <div
              style={{
                width: '40px',
                height: '4px',
                borderRadius: '2px',
                backgroundColor: 'var(--surface-overlay)',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  width: `${Math.min(m.pct, 100)}%`,
                  height: '100%',
                  borderRadius: '2px',
                  backgroundColor: fillColor,
                  transition: 'width 0.3s ease',
                }}
              />
            </div>
            <span className="text-[10px] leading-none" style={{ color: 'var(--text-muted)' }}>{m.label}</span>
          </div>
        );
      })}
    </>
  );
});
