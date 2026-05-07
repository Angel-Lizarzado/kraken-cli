import { useState, useEffect, useRef } from 'react';

export interface LogBufferEntry {
  id: string;
  module: string;
  message: string;
  type: 'info' | 'warning' | 'error' | 'success';
  domain: string;
  timestamp: number;
  fixable?: boolean;
  fixAction?: string;
}

const MAX_ENTRIES = 5000;

export function useLogBuffer() {
  const [entries, setEntries] = useState<LogBufferEntry[]>([]);
  const bufferRef = useRef<LogBufferEntry[]>([]);
  const rafRef = useRef<number | null>(null);
  const idCounter = useRef(0);

  // Subscribe to log:batch events
  useEffect(() => {
    let api: any;
    try {
      api = (window as any).api;
    } catch { return; }
    if (!api) return;

    // Hydrate on mount: fetch recent logs from backend
    (async () => {
      try {
        const electronApi = (window as any).electronAPI;
        const legacyApi = (window as any).api;

        let result;
        if (electronApi && typeof electronApi.invoke === 'function') {
          result = await electronApi.invoke('log:get-recent', { count: 200 });
        } else if (legacyApi && typeof legacyApi.invoke === 'function') {
          result = await legacyApi.invoke('log:get-recent', { count: 200 });
        }

        if (result && result.success && result.logs && result.logs.length > 0) {
          const normalized = result.logs.map((entry: any) => {
            const id = `lb-hydrate-${++idCounter.current}`;
            return {
              ...entry,
              id,
              type: normalizeType(entry.type || 'info'),
              timestamp: entry.timestamp ?? Date.now(),
            };
          });
          // Set hydrated entries immediately
          setEntries(normalized);
          bufferRef.current = [...normalized];
        }
      } catch {
        // Silent — no backend yet, terminal starts empty
      }
    })();

    const handler = (batch: LogBufferEntry[]) => {
      // Normalize type field — ensure it's a valid level
      const normalized = batch.map((entry) => {
        const id = `lb-${++idCounter.current}`;
        let type = normalizeType(entry.type);
        let module = entry.module;
        let message = entry.message;

        // ── @@syslog interceptor: parse structured telemetry ──
        if (typeof message === 'string' && message.startsWith('@@@syslog|')) {
          const parts = message.split('|');
          if (parts.length >= 4) {
            const parsedModule = parts[1];   // EXTRACT, MIGRATE, DNS, SSL, VALIDATOR
            const parsedLevel = parts[2];     // info, warn, error, success
            const parsedMessage = parts.slice(3).join('|'); // rest of message

            module = parsedModule;
            type = normalizeType(parsedLevel);
            message = parsedMessage;
          }
        }

        return {
          ...entry,
          id,
          type,
          module: module || entry.module,
          message,
          timestamp: entry.timestamp ?? Date.now(),
        };
      });

      bufferRef.current.push(...normalized);
      if (bufferRef.current.length > MAX_ENTRIES) {
        bufferRef.current = bufferRef.current.slice(-MAX_ENTRIES);
      }
      if (!rafRef.current) {
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = null;
          const batchToFlush = bufferRef.current.splice(0, bufferRef.current.length);
          setEntries(prev => {
            const combined = [...batchToFlush, ...prev];
            return combined.length > MAX_ENTRIES ? combined.slice(0, MAX_ENTRIES) : combined;
          });
        });
      }
    };

    // Try electronAPI first
    if ((window as any).electronAPI && typeof (window as any).electronAPI.onEvent === 'function') {
      (window as any).electronAPI.onEvent('log:batch', handler);
    } else {
      api.receive('log:batch', handler);
    }
    // No cleanup — component owns the log buffer
  }, []);

  const clear = () => {
    setEntries([]);
    bufferRef.current = [];
    idCounter.current = 0;
  };

  return { entries, clear };
}

function normalizeType(type: string): 'info' | 'warning' | 'error' | 'success' {
  if (type === 'info' || type === 'warning' || type === 'error' || type === 'success') {
    return type;
  }
  return 'info';
}
