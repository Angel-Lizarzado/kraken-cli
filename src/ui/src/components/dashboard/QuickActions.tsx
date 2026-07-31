import { useCallback, useState } from 'react';
import type { LogLevel } from '../../types/ipc';
import { QUICK_ACTIONS } from '../../types/server';
import type { Server } from '../../types/server';
import { useToast } from '../Toast';

interface QuickActionsProps {
  server: Server;
  onLog: (message: string, type: LogLevel) => void;
  execServerCommand: (
    serverName: string,
    command: string,
  ) => Promise<{
    success: boolean;
    stdout?: string;
    stderr?: string;
    error?: string;
  }>;
  onMetricsRefresh?: (serverName: string) => void;
}

export default function QuickActions({
  server,
  onLog,
  execServerCommand,
  onMetricsRefresh,
}: QuickActionsProps) {
  const [loadingLabel, setLoadingLabel] = useState<string | null>(null);
  const toast = useToast();

  const handleAction = useCallback(
    async (label: string, command: string) => {
      if (loadingLabel !== null) return; // prevent double-click
      setLoadingLabel(label);
      onLog(`Ejecutando: ${label}...`, 'info');
      try {
        const res = await execServerCommand(server.name, command);
        if (res.success) {
          onLog(`${label} completado`, 'success');
          toast.success(`${label} completado`);
          if (onMetricsRefresh) onMetricsRefresh(server.name);
        } else {
          const errMsg = `Error en ${label}: ${res.error}`;
          onLog(errMsg, 'error');
          toast.error(errMsg);
        }
      } catch (err: unknown) {
        const msg =
          err instanceof Error ? err.message : 'Error desconocido';
        const errMsg = `Error en ${label}: ${msg}`;
        onLog(errMsg, 'error');
        toast.error(errMsg);
      } finally {
        setLoadingLabel(null);
      }
    },
    [server.name, onLog, execServerCommand, toast, loadingLabel],
  );

  return (
    <div>
      <div
        className="text-xs font-medium mb-2 text-on-surface-variant"
      >
        Acciones Rápidas
      </div>
      <div className="flex gap-2 flex-wrap">
        {QUICK_ACTIONS.map((action) => {
          const isLoading = loadingLabel === action.label;
          return (
            <button
              key={action.label}
              onClick={() => handleAction(action.label, action.command)}
              disabled={isLoading || loadingLabel !== null}
              className="btn btn--secondary text-xs"
              style={
                isLoading
                  ? { opacity: 0.6, cursor: 'not-allowed' }
                  : undefined
              }
            >
              {isLoading ? (
                <>
                  <span className="spinner-mini" />
                  Ejecutando...
                </>
              ) : (
                action.label
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
