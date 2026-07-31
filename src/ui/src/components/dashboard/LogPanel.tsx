import { useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import { ChevronRight, ChevronDown, RefreshCw } from 'lucide-react';

// ── Parsed log entry ──
interface ParsedLogEntry {
  timestamp: string;
  level: string;
  module: string;
  message: string;
}

function parseLogs(raw: string): ParsedLogEntry[] {
  const logPattern = /^\[(.*?)\]\s+\S+\s+([A-Z]+)\s+\[(.*?)\]\s+(.*)/;
  const entries: ParsedLogEntry[] = [];
  let current: ParsedLogEntry | null = null;

  for (const line of raw.split('\n')) {
    const match = line.match(logPattern);
    if (match) {
      if (current) entries.push(current);
      current = {
        timestamp: match[1],
        level: match[2],
        module: match[3],
        message: match[4],
      };
    } else if (current && line.trim()) {
      current.message += '\n' + line;
    }
  }
  if (current) entries.push(current);
  return entries;
}

const BADGE_COLORS: Record<string, { bg: string; text: string }> = {
  ERROR: { bg: 'oklch(0.45 0.12 25 / 0.18)', text: 'oklch(0.6 0.2 25)' },
  WARN:  { bg: 'oklch(0.55 0.15 75 / 0.18)', text: 'oklch(0.7 0.18 75)' },
  INFO:  { bg: 'oklch(0.5 0.1 250 / 0.18)', text: 'oklch(0.65 0.12 250)' },
};

const DEFAULT_BADGE = { bg: 'oklch(0.45 0.01 250 / 0.18)', text: 'oklch(0.55 0.01 250)' };

// ── Props ──
interface LogPanelProps {
  logs: string | null;
  loading: boolean;
  onRefresh: () => void;
}

export default function LogPanel({ logs, loading, onRefresh }: LogPanelProps) {
  const [expandedLog, setExpandedLog] = useState<number | null>(null);

  const toggleExpand = useCallback((index: number) => {
    setExpandedLog(prev => (prev === index ? null : index));
  }, []);

  const entries = logs ? parseLogs(logs) : [];

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-on-surface-variant">
          Últimas 50 líneas — /var/log/plesk/panel.log
        </span>
        <button onClick={onRefresh} className="btn btn--secondary text-xs" disabled={loading}>
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          {loading ? 'Cargando...' : 'Refrescar'}
        </button>
      </div>

      {/* Content */}
      {loading ? (
        <div className="rounded-lg p-3 font-mono text-xs bg-surface-container text-on-surface-variant" style={{ minHeight: '200px' }}>
          Cargando logs...
        </div>
      ) : logs ? (
        <div
          className="rounded-lg overflow-auto scrollbar-thin bg-surface-container"
          style={{ maxHeight: 'calc(100vh - 320px)', minHeight: '200px' }}
        >
          <div className="space-y-px">
            {entries.map((entry, i) => {
              const isOpen = expandedLog === i;
              const bc = BADGE_COLORS[entry.level] || DEFAULT_BADGE;

              return (
                <motion.div key={i} initial={false}>
                  <div
                    className="flex items-center gap-2 px-3 py-2 cursor-pointer select-none"
                    style={{
                      borderBottom: '1px solid oklch(0.22 0.008 250)',
                      transition: 'background-color 150ms ease-out',
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'oklch(0.22 0.01 250 / 0.4)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
                    onClick={() => toggleExpand(i)}
                  >
                    <span
                      style={{
                        display: 'inline-block',
                        padding: '1px 7px',
                        borderRadius: '4px',
                        fontSize: '10px',
                        fontWeight: 700,
                        lineHeight: '18px',
                        backgroundColor: bc.bg,
                        color: bc.text,
                        flexShrink: 0,
                      }}
                    >
                      {entry.level}
                    </span>
                    <span
                      className="truncate text-xs text-on-surface-variant"
                      style={{ flex: '0 0 130px', minWidth: 0 }}
                    >
                      {entry.timestamp}
                    </span>
                    <span
                      className="truncate text-xs text-on-surface"
                      style={{ flex: '1 1 auto', minWidth: 0 }}
                    >
                      {entry.module}
                    </span>
                    {isOpen ? (
                      <ChevronDown size={14} className="text-on-surface-variant flex-shrink-0" />
                    ) : (
                      <ChevronRight size={14} className="text-on-surface-variant flex-shrink-0" />
                    )}
                  </div>
                  {isOpen && (
                    <div
                      className="px-3 py-2 text-xs leading-relaxed text-on-surface"
                      style={{
                        backgroundColor: 'oklch(0 0 0 / 0.35)',
                        borderBottom: '1px solid oklch(0.22 0.008 250)',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                      }}
                    >
                      {entry.message}
                    </div>
                  )}
                </motion.div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="rounded-lg p-3 font-mono text-xs bg-surface-container text-on-surface-variant" style={{ minHeight: '200px' }}>
          Presione "Refrescar" para cargar los logs del servidor.
        </div>
      )}
    </div>
  );
}
