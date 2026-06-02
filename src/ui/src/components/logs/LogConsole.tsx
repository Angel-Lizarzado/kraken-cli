import React, { useRef, useCallback, useMemo, useState, type UIEventHandler, type ErrorInfo } from 'react';
import { VariableSizeList as List, type ListOnItemsRenderedProps } from 'react-window';
import { AlertCircle, AlertTriangle, Info, CheckCircle, X, Terminal, Wrench, ChevronDown, ChevronRight, Layers } from 'lucide-react';
import type { LogBufferEntry } from '../../hooks/useLogBuffer';

interface LogConsoleProps {
  entries: LogBufferEntry[];
  onClear: () => void;
  onFixAction?: (entry: LogBufferEntry) => void;
  maxHeight?: number;
  rowHeight?: number;
}

// ── Error boundary ────────────────────────────────────────────────────────────
interface ErrorBoundaryState { hasError: boolean; errorMessage: string; }
class ReactWindowErrorBoundary extends React.Component<
  { children: React.ReactNode; maxHeight: number }, ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode; maxHeight: number }) {
    super(props);
    this.state = { hasError: false, errorMessage: '' };
  }
  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, errorMessage: `${error.name}: ${error.message}` };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ERROR BOUNDARY] react-window crash:', error.message, info.componentStack);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="flex items-center justify-center flex-col gap-2 px-4"
          style={{ height: `${this.props.maxHeight}px`, color: 'var(--text-muted)', fontSize: '12px' }}>
          <Terminal size={20} className="opacity-30" />
          <p>Error al renderizar la lista virtualizada</p>
          <p className="font-mono text-[10px]" style={{ color: 'var(--color-error)', maxWidth: '400px', wordBreak: 'break-word' }}>
            {this.state.errorMessage}
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}

function safeEntries(arr: LogBufferEntry[] | null | undefined): LogBufferEntry[] {
  return Array.isArray(arr) ? arr : [];
}

// ── Colores por módulo ─────────────────────────────────────────────────────────
const MODULE_COLORS: Record<string, { bg: string; text: string }> = {
  system:     { bg: 'oklch(0.25 0.01 260 / 0.5)',  text: '#9ca3af' },
  extraction: { bg: 'oklch(0.3 0.08 280 / 0.35)',  text: '#c084fc' },
  extract:    { bg: 'oklch(0.3 0.08 280 / 0.35)',  text: '#c084fc' },
  deployment: { bg: 'oklch(0.3 0.08 45 / 0.35)',   text: '#fbbf24' },
  migrate:    { bg: 'oklch(0.3 0.08 45 / 0.35)',   text: '#fbbf24' },
  dns:        { bg: 'oklch(0.3 0.08 200 / 0.35)',  text: '#22d3ee' },
  cloudflare: { bg: 'oklch(0.3 0.08 210 / 0.35)',  text: '#38bdf8' },
  ssl:        { bg: 'oklch(0.3 0.08 150 / 0.35)',  text: '#34d399' },
  scanner:    { bg: 'oklch(0.3 0.08 15 / 0.35)',   text: '#f87171' },
  validator:  { bg: 'oklch(0.3 0.08 15 / 0.35)',   text: '#f87171' },
  ssh:        { bg: 'oklch(0.25 0.04 120 / 0.35)', text: '#a3e635' },
  plesk:      { bg: 'oklch(0.3 0.06 300 / 0.35)',  text: '#e879f9' },
};
function getModuleColor(module: string) {
  return MODULE_COLORS[(module || '').toLowerCase()] ?? { bg: 'oklch(0.25 0.01 260 / 0.4)', text: '#6b7280' };
}

const LEVEL_CONFIG: Record<LogBufferEntry['type'], { icon: React.ReactNode; badgeBg: string; badgeText: string; rowBg: string; label: string }> = {
  error:   { icon: <AlertCircle size={12} />,   badgeBg: 'rgba(239,68,68,0.18)',   badgeText: '#ef4444', rowBg: 'oklch(0.35 0.12 25 / 0.08)',  label: 'ERROR' },
  warning: { icon: <AlertTriangle size={12} />, badgeBg: 'rgba(234,179,8,0.18)',   badgeText: '#eab308', rowBg: 'oklch(0.45 0.12 85 / 0.06)',  label: 'WARN'  },
  info:    { icon: <Info size={12} />,          badgeBg: 'rgba(59,130,246,0.18)',  badgeText: '#60a5fa', rowBg: 'transparent',                 label: 'INFO'  },
  success: { icon: <CheckCircle size={12} />,   badgeBg: 'rgba(34,197,94,0.18)',   badgeText: '#22c55e', rowBg: 'oklch(0.4 0.12 150 / 0.06)',  label: 'OK'    },
};
function getLevelConfig(level: LogBufferEntry['type']) {
  return LEVEL_CONFIG[level] ?? LEVEL_CONFIG.info;
}

// ── Vista plana: fila individual ──────────────────────────────────────────────
interface LogRowProps {
  entry: LogBufferEntry;
  style: React.CSSProperties;
  isExpanded: boolean;
  onToggleExpand: (id: string) => void;
  onFix: (entry: LogBufferEntry) => void;
  onFilterDomain?: (domain: string) => void;
}
const LogRow = ({ entry, style, isExpanded, onToggleExpand, onFix, onFilterDomain }: LogRowProps) => {
  const cfg = getLevelConfig(entry.type);
  const modColor = useMemo(() => getModuleColor(entry.module), [entry.module]);
  const time = useMemo(() => {
    try { return new Date(entry.timestamp).toLocaleTimeString('es-SV', { hour12: false }); }
    catch { return String(entry.timestamp); }
  }, [entry.timestamp]);

  return (
    <div style={{ ...style, overflow: 'hidden', zIndex: isExpanded ? 10 : 1 }}>
      <div
        className="flex items-start gap-2 px-3 py-1.5 cursor-pointer select-none"
        style={{ backgroundColor: isExpanded ? 'oklch(0.22 0.01 250 / 0.5)' : cfg.rowBg, borderBottom: '1px solid oklch(0.18 0.005 250)', minHeight: '28px' }}
        onClick={() => onToggleExpand(entry.id)}
      >
        <span style={{ padding: '1px 6px', borderRadius: '3px', fontSize: '10px', lineHeight: '18px', backgroundColor: cfg.badgeBg, color: cfg.badgeText, minWidth: '48px' }} className="flex items-center gap-1 font-bold shrink-0">
          {cfg.icon}{cfg.label}
        </span>
        <span className="font-mono shrink-0" style={{ fontSize: '11px', color: 'var(--text-muted)', width: '70px' }}>{time}</span>
        <span className="shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide"
          style={{ backgroundColor: modColor.bg, color: modColor.text, maxWidth: '90px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {entry.module}
        </span>
        <span className="flex-1 truncate text-xs" style={{ color: 'var(--text-primary)' }}>{entry.message}</span>
        {entry.fixable && (
          <button onClick={(e) => { e.stopPropagation(); onFix(entry); }}
            className="flex items-center gap-1 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium"
            style={{ backgroundColor: 'oklch(0.45 0.15 35 / 0.2)', color: 'var(--color-error)', border: '1px solid oklch(0.45 0.15 35 / 0.3)' }}>
            <Wrench size={10} />Fix
          </button>
        )}
        {entry.domain && (
          <span className="shrink-0 rounded px-1 py-0.5 text-[9px] font-mono cursor-pointer hover:opacity-80 transition-opacity"
            onClick={(e) => { e.stopPropagation(); onFilterDomain?.(entry.domain!); }}
            style={{ backgroundColor: 'oklch(0.3 0.02 260 / 0.4)', color: 'var(--text-muted)' }}>
            {entry.domain}
          </span>
        )}
      </div>
      {isExpanded && entry.message.length > 80 && (
        <div className="px-3 py-2 text-xs leading-relaxed font-mono"
          style={{ 
            display: 'block',
            position: 'relative',
            height: 'calc(100% - 28px)',
            overflowY: 'auto',
            backgroundColor: 'var(--bg-default, #111827)', 
            color: 'var(--text-secondary)', 
            borderBottom: '1px solid oklch(0.18 0.005 250)', 
            whiteSpace: 'pre-wrap', 
            wordBreak: 'break-word' 
          }}>
          {entry.message}
        </div>
      )}
    </div>
  );
};

// ── Vista agrupada por dominio ─────────────────────────────────────────────────
interface DomainGroup {
  domain: string;
  entries: LogBufferEntry[];
  hasError: boolean;
  hasWarning: boolean;
  latestMessage: string;
  latestType: LogBufferEntry['type'];
  module: string;
}

function buildDomainGroups(entries: LogBufferEntry[]): DomainGroup[] {
  const map = new Map<string, DomainGroup>();
  for (const entry of entries) {
    const key = entry.domain || '(sistema)';
    const existing = map.get(key);
    if (existing) {
      existing.entries.push(entry);
      existing.latestMessage = entry.message;
      existing.latestType = entry.type;
      if (entry.type === 'error') existing.hasError = true;
      if (entry.type === 'warning') existing.hasWarning = true;
    } else {
      map.set(key, {
        domain: key,
        entries: [entry],
        hasError: entry.type === 'error',
        hasWarning: entry.type === 'warning',
        latestMessage: entry.message,
        latestType: entry.type,
        module: entry.module,
      });
    }
  }
  return Array.from(map.values());
}

interface DomainGroupRowProps {
  group: DomainGroup;
  isOpen: boolean;
  onToggle: (domain: string) => void;
}
function DomainGroupRow({ group, isOpen, onToggle }: DomainGroupRowProps) {
  const modColor = getModuleColor(group.module);
  const statusColor = group.hasError ? '#ef4444' : group.hasWarning ? '#eab308' : '#22c55e';

  return (
    <div style={{ borderBottom: '1px solid oklch(0.18 0.005 250)' }}>
      {/* Cabecera del grupo — siempre visible */}
      <div
        className="flex items-center gap-2 px-3 py-2 cursor-pointer select-none"
        style={{ backgroundColor: isOpen ? 'oklch(0.2 0.01 250 / 0.8)' : 'oklch(0.16 0.008 250)' }}
        onClick={() => onToggle(group.domain)}
      >
        {isOpen ? <ChevronDown size={12} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                : <ChevronRight size={12} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />}

        {/* Dot de estado */}
        <span style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: statusColor, flexShrink: 0, boxShadow: `0 0 4px ${statusColor}` }} />

        {/* Dominio */}
        <span className="font-mono text-xs font-semibold flex-1 truncate" style={{ color: 'var(--text-primary)' }}>
          {group.domain}
        </span>

        {/* Badge de módulo */}
        <span className="shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase"
          style={{ backgroundColor: modColor.bg, color: modColor.text }}>
          {group.module}
        </span>

        {/* Contador de logs */}
        <span className="text-[10px] shrink-0" style={{ color: 'var(--text-muted)' }}>
          {group.entries.length} eventos
        </span>
      </div>

      {/* Logs internos — acordeón con scroll independiente */}
      {isOpen && (
        <div
          style={{
            // FIX CSS: overflow-y:auto + max-height acotado evita que el contenido
            // expandido desborde el contenedor padre y rompa el layout.
            // min-height:0 es crítico en flex containers para que el overflow funcione.
            maxHeight: '240px',
            minHeight: 0,
            overflowY: 'auto',
            backgroundColor: 'oklch(0.12 0.005 250)',
          }}
        >
          {group.entries.map(entry => {
            const cfg = getLevelConfig(entry.type);
            const time = (() => {
              try { return new Date(entry.timestamp).toLocaleTimeString('es-SV', { hour12: false }); }
              catch { return ''; }
            })();
            return (
              <div key={entry.id}
                className="flex items-start gap-2 px-4 py-1"
                style={{ borderBottom: '1px solid oklch(0.15 0.005 250)', backgroundColor: cfg.rowBg, minHeight: '24px' }}>
                <span style={{ fontSize: '10px', color: cfg.badgeText, flexShrink: 0, width: '36px' }}>{cfg.label}</span>
                <span className="font-mono shrink-0" style={{ fontSize: '10px', color: 'var(--text-muted)', width: '64px' }}>{time}</span>
                <span className="text-[11px]" style={{ color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {entry.message}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Componente principal ──────────────────────────────────────────────────────
export default function LogConsole({
  entries: rawEntries,
  onClear,
  onFixAction,
  maxHeight = 400,
  rowHeight = 28,
}: LogConsoleProps) {
  const entries = safeEntries(rawEntries);
  const listRef = useRef<List | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [autoScroll, setAutoScroll] = useState(true);
  // 'flat' = vista plana (comportamiento original), 'domain' = agrupada por dominio
  const [viewMode, setViewMode] = useState<'flat' | 'domain'>('flat');
  const [openDomains, setOpenDomains] = useState<Set<string>>(new Set());
  const [filtroDominio, setFiltroDominio] = useState<string | null>(null);

  // Filtrar logs si hay filtro activo
  const visibleEntries = useMemo(() => {
    let filtered = entries;
    if (filtroDominio) {
      filtered = filtered.filter(e => e.domain === filtroDominio);
    }
    return filtered;
  }, [entries, filtroDominio]);

  // ── Vista agrupada ──────────────────────────────────────────────────────────
  const domainGroups = useMemo(() => buildDomainGroups(visibleEntries), [visibleEntries]);

  const toggleDomain = useCallback((domain: string) => {
    setOpenDomains(prev => {
      const next = new Set(prev);
      next.has(domain) ? next.delete(domain) : next.add(domain);
      return next;
    });
  }, []);

  // ── Vista plana: expansión de fila ─────────────────────────────────────────
  const toggleExpand = useCallback((id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  // FIX: getItemSize correctamente diferencia fila normal vs expandida.
  // El bug anterior: expandedExtraHeight era fijo (36px) pero el contenido
  // real podía necesitar más. Ahora calculamos aprox. por longitud de mensaje.
  const getItemSize = useCallback(
    (index: number) => {
      const entry = visibleEntries[index];
      if (!entry) return rowHeight;
      if (expandedIds.has(entry.id) && entry.message.length > 80) {
        // ~12px por línea, ~60 chars por línea → número de líneas estimadas
        const estimatedLines = Math.ceil(entry.message.length / 60);
        return rowHeight + Math.min(estimatedLines * 16 + 12, 200); // cap a 200px extra
      }
      return rowHeight;
    },
    [visibleEntries, expandedIds, rowHeight],
  );

  // Remeasure cuando cambia expandedIds
  const prevExpandedRef = useRef<Set<string>>(new Set());
  if (expandedIds !== prevExpandedRef.current) {
    prevExpandedRef.current = expandedIds;
    for (let i = 0; i < visibleEntries.length; i++) {
      const entry = visibleEntries[i];
      if (!entry) continue;
      const wasExpanded = prevExpandedRef.current.has(entry.id);
      const isExpanded = expandedIds.has(entry.id);
      if (wasExpanded !== isExpanded) {
        queueMicrotask(() => { listRef.current?.resetAfterIndex(i); });
        break;
      }
    }
  }

  const handleScroll = useCallback<UIEventHandler<HTMLDivElement>>((event) => {
    const target = event?.currentTarget;
    if (target && typeof target.scrollTop === 'number' && target.scrollTop < 50) {
      setAutoScroll(true);
    }
  }, []);

  const handleItemsRendered = useCallback(
    ({ visibleStopIndex }: ListOnItemsRenderedProps) => {
      if (autoScroll && visibleStopIndex < 5 && listRef.current) {
        listRef.current.scrollTo(0);
      }
    },
    [autoScroll],
  );

  const Row = useCallback(
    ({ index, style, data }: { index: number; style: React.CSSProperties; data: LogBufferEntry[] }) => {
      const entry = (data || [])[index];
      if (!entry) {
        return (
          <div style={style}>
            <div className="flex items-start gap-2 px-3 py-1.5" style={{ minHeight: '28px', borderBottom: '1px solid oklch(0.18 0.005 250)' }}>
              <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>—</span>
            </div>
          </div>
        );
      }
      return (
        <LogRow entry={entry} style={style}
          isExpanded={expandedIds.has(entry.id)}
          onToggleExpand={toggleExpand}
          onFix={(e) => onFixAction?.(e)}
          onFilterDomain={setFiltroDominio}
        />
      );
    },
    [expandedIds, toggleExpand, onFixAction, setFiltroDominio],
  );

  const errorCount   = useMemo(() => visibleEntries.filter(e => e.type === 'error').length,   [visibleEntries]);
  const warningCount = useMemo(() => visibleEntries.filter(e => e.type === 'warning').length, [visibleEntries]);

  return (
    <div className="rounded-lg overflow-hidden"
      style={{ border: '1px solid var(--border-default)', backgroundColor: 'oklch(0.14 0.005 250)' }}>

      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-2"
        style={{ backgroundColor: 'oklch(0.1 0.005 250)', borderBottom: '1px solid oklch(0.2 0.008 250)' }}>
        <div className="flex items-center gap-3">
          <Terminal size={14} style={{ color: 'var(--text-muted)' }} />
          <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Consola</span>
          <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{visibleEntries.length} eventos</span>
          {errorCount > 0 && <span className="text-[10px]" style={{ color: '#ef4444' }}>{errorCount} errores</span>}
          {warningCount > 0 && <span className="text-[10px]" style={{ color: '#eab308' }}>{warningCount} advertencias</span>}
        </div>

        <div className="flex items-center gap-2">
          {filtroDominio && (
            <button onClick={() => setFiltroDominio(null)}
              className="text-[10px] px-2 py-0.5 rounded flex items-center gap-1 font-semibold"
              style={{
                backgroundColor: 'oklch(0.45 0.18 25 / 0.15)',
                color: 'var(--color-error)',
                border: '1px solid oklch(0.45 0.18 25 / 0.3)',
              }}>
              <X size={10} /> Quitar Filtro ({filtroDominio})
            </button>
          )}

          {/* Toggle de vista */}
          <button
            onClick={() => setViewMode(v => v === 'flat' ? 'domain' : 'flat')}
            className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded"
            style={{
              backgroundColor: viewMode === 'domain' ? 'oklch(0.3 0.06 200 / 0.4)' : 'oklch(0.3 0.03 260 / 0.4)',
              color: viewMode === 'domain' ? '#22d3ee' : 'var(--text-muted)',
              border: '1px solid oklch(0.25 0.01 260 / 0.3)',
            }}
            title="Alternar entre vista plana y agrupada por dominio"
          >
            <Layers size={10} />
            {viewMode === 'domain' ? 'Por dominio' : 'Plana'}
          </button>

          {viewMode === 'flat' && (
            <button onClick={() => setAutoScroll(!autoScroll)}
              className="text-[10px] px-2 py-0.5 rounded"
              style={{
                backgroundColor: autoScroll ? 'oklch(0.3 0.03 260 / 0.4)' : 'transparent',
                color: autoScroll ? 'var(--color-accent)' : 'var(--text-muted)',
                border: '1px solid oklch(0.25 0.01 260 / 0.3)',
              }}>
              Auto-scroll {autoScroll ? 'ON' : 'OFF'}
            </button>
          )}

          <button onClick={onClear} className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded"
            style={{ color: 'var(--text-muted)', border: '1px solid oklch(0.25 0.01 260 / 0.3)' }}>
            <X size={10} />Limpiar
          </button>
        </div>
      </div>

      {/* Cuerpo */}
      {visibleEntries.length === 0 ? (
        <div className="flex items-center justify-center" style={{ height: `${maxHeight}px`, color: 'var(--text-muted)', fontSize: '12px' }}>
          <div className="text-center">
            <Terminal size={24} className="mx-auto mb-2 opacity-30" />
            <p>{filtroDominio ? `No hay eventos para ${filtroDominio}` : 'Consola vacía. Los eventos aparecerán aquí durante la ejecución de módulos.'}</p>
          </div>
        </div>
      ) : viewMode === 'domain' ? (
        /* Vista agrupada por dominio (acordeón, sin virtualización — grupos son pocos) */
        <div style={{ maxHeight: `${maxHeight}px`, overflowY: 'auto', minHeight: 0 }}>
          {domainGroups.map(group => (
            <DomainGroupRow
              key={group.domain}
              group={group}
              isOpen={openDomains.has(group.domain)}
              onToggle={toggleDomain}
            />
          ))}
        </div>
      ) : (
        /* Vista plana virtualizada (react-window) */
        <ReactWindowErrorBoundary maxHeight={maxHeight}>
          <List
            ref={listRef}
            height={maxHeight}
            itemCount={visibleEntries.length}
            itemSize={getItemSize}
            width="100%"
            onScroll={handleScroll}
            onItemsRendered={handleItemsRendered}
            overscanCount={10}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            {...({ children: Row, itemData: visibleEntries } as any)}
          />
        </ReactWindowErrorBoundary>
      )}
    </div>
  );
}

export type { LogBufferEntry };
