import { useState, useRef, useCallback, useEffect } from 'react';

// ── Types ──
export interface ThrottledLogEntry {
  id: string;
  timestamp: string;
  level: 'info' | 'warning' | 'error' | 'success';
  message: string;
  module: string;
  domain?: string;
  fixable?: boolean;
  fixAction?: string;
}

export interface RawLogEvent {
  message: string;
  type: string;
  module?: string;
  domain?: string;
  timestamp?: string;
  fixable?: boolean;
  fixAction?: string;
}

const MAX_LOG_ENTRIES = 5000;
const THROTTLE_MS = 16; // ~60fps — one frame budget

// ── Hook ──
export function useLogThrottle() {
  const [entries, setEntries] = useState<ThrottledLogEntry[]>([]);
  const bufferRef = useRef<RawLogEvent[]>([]);
  const rafRef = useRef<number | null>(null);
  const idCounter = useRef(0);

  const flushBuffer = useCallback(() => {
    const batch = bufferRef.current;
    bufferRef.current = [];
    rafRef.current = null;

    if (batch.length === 0) return;

    const newEntries: ThrottledLogEntry[] = batch.map((evt) => ({
      id: `log-${++idCounter.current}`,
      timestamp: evt.timestamp || new Date().toISOString(),
      level: validateLogLevel(evt.type),
      message: evt.message,
      module: evt.module || 'system',
      domain: evt.domain,
      fixable: evt.fixable,
      fixAction: evt.fixAction,
    }));

    setEntries((prev) => {
      const combined = [...newEntries, ...prev];
      return combined.length > MAX_LOG_ENTRIES
        ? combined.slice(0, MAX_LOG_ENTRIES)
        : combined;
    });
  }, []);

  const push = useCallback(
    (event: RawLogEvent) => {
      bufferRef.current.push(event);

      if (!rafRef.current) {
        rafRef.current = requestAnimationFrame(flushBuffer);
      }
    },
    [flushBuffer],
  );

  // Cleanup RAF on unmount
  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, []);

  const clear = useCallback(() => {
    setEntries([]);
    bufferRef.current = [];
    idCounter.current = 0;
  }, []);

  return { entries, push, clear } as const;
}

// ── Helpers ──
function validateLogLevel(type: string): ThrottledLogEntry['level'] {
  if (type === 'info' || type === 'warning' || type === 'error' || type === 'success') {
    return type;
  }
  return 'info';
}
