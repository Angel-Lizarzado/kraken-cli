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
      style={{ height: '76px' }}
      className={`flex items-center gap-3 p-3 cursor-pointer rounded border transition-colors ${isSelected ? 'border-tertiary bg-tertiary/10' : 'border-outline-variant bg-surface-container-low hover:bg-surface-container-high'}`}
      whileHover={{ scale: 1.02 }}
      whileTap={{ scale: 0.98 }}
      onClick={() => onSelect(server)}
    >
      {/* Left: status dot + name + host */}
      <div className="min-w-0 flex-1 flex items-center gap-2">
        <StatusDot status={server.status} />
        <div className="min-w-0">
          <div className="font-display font-bold text-sm truncate">{server.name}</div>
          <div className="text-xs font-mono truncate text-on-surface-variant">
            {server.sshCredentials.host}:{server.sshCredentials.port}
          </div>
        </div>
      </div>

      {/* Middle: mini progress bars */}
      <div className="flex items-center gap-2">
        {server.diagnostics ? (
          <MiniMetrics diagnostics={server.diagnostics} />
        ) : (
          <span className="text-[10px] text-on-surface-variant">Sin datos</span>
        )}
      </div>

      {/* Right: SSH status + chevron */}
      <div className="flex items-center gap-1.5 flex-shrink-0">
        <span
          className={`px-2 py-0.5 rounded text-[10px] uppercase font-bold leading-none ${server.isLinked ? 'bg-green-500/10 text-green-400' : 'bg-error/10 text-error'}`}
        >
          {server.isLinked ? 'SSH' : 'No SSH'}
        </span>
        <ChevronRight size={14} className="text-on-surface-variant" />
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
        const fillColor = m.pct > 90 ? '#ff5252' : m.pct > 70 ? '#ffb142' : '#33d9b2';
        return (
          <div key={m.label} className="flex flex-col items-center gap-0.5">
            <div
              style={{
                width: '40px',
                height: '4px',
                borderRadius: '2px',
                backgroundColor: 'rgba(255, 255, 255, 0.05)',
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
            <span className="text-[10px] leading-none text-on-surface-variant">{m.label}</span>
          </div>
        );
      })}
    </>
  );
});
