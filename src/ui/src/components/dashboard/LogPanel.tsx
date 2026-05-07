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
  ERROR: { bg: 'rgba(239,68,68,0.18)', text: '#ef4444' },
  WARN:  { bg: 'rgba(234,179,8,0.18)', text: '#eab308' },
  INFO:  { bg: 'rgba(59,130,246,0.18)', text: '#60a5fa' },
};

const DEFAULT_BADGE = { bg: 'rgba(100,116,139,0.18)', text: '#94a3b8' };

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
        <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
          Últimas 50 líneas — /var/log/plesk/panel.log
        </span>
        <button onClick={onRefresh} className="btn btn--secondary text-xs" disabled={loading}>
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          {loading ? 'Cargando...' : 'Refrescar'}
        </button>
      </div>

      {/* Content */}
      {loading ? (
        <div
          className="rounded-lg p-3 font-mono text-xs"
          style={{
            backgroundColor: 'var(--surface-overlay)',
            minHeight: '200px',
            color: 'var(--text-muted)',
          }}
        >
          Cargando logs...
        </div>
      ) : logs ? (
        <div
          className="rounded-lg overflow-auto scrollbar-thin"
          style={{
            backgroundColor: 'var(--surface-overlay)',
            maxHeight: 'calc(100vh - 320px)',
            minHeight: '200px',
          }}
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
                      className="truncate text-xs"
                      style={{ color: 'var(--text-muted)', flex: '0 0 130px', minWidth: 0 }}
                    >
                      {entry.timestamp}
                    </span>
                    <span
                      className="truncate text-xs"
                      style={{ color: 'var(--text-secondary)', flex: '1 1 auto', minWidth: 0 }}
                    >
                      {entry.module}
                    </span>
                    {isOpen ? (
                      <ChevronDown size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                    ) : (
                      <ChevronRight size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                    )}
                  </div>
                  {isOpen && (
                    <div
                      className="px-3 py-2 text-xs leading-relaxed"
                      style={{
                        backgroundColor: 'oklch(0 0 0 / 0.35)',
                        color: 'var(--text-primary)',
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
        <div
          className="rounded-lg p-3 font-mono text-xs"
          style={{
            backgroundColor: 'var(--surface-overlay)',
            minHeight: '200px',
            color: 'var(--text-muted)',
          }}
        >
          Presione "Refrescar" para cargar los logs del servidor.
        </div>
      )}
    </div>
  );
}
