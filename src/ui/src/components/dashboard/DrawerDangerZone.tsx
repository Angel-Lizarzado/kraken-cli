import { useState, useCallback, useEffect } from 'react';
import { Power, PowerOff, Trash2, Database } from 'lucide-react';
import type { Server, MaintenanceAction } from '../../types/server';

const RETENTION_OPTIONS = [
  { value: 3,  label: '3 días (Retención Crítica / Espacio Mínimo)' },
  { value: 5,  label: '5 días (Retención Ajustada)' },
  { value: 10, label: '10 días (Recomendado / Default)' },
  { value: 15, label: '15 días (Seguridad Extendida)' },
  { value: 30, label: '30 días (Histórico Completo)' },
];

interface DrawerDangerZoneProps {
  server: Server;
  onMaintenanceAction: (serverName: string, action: MaintenanceAction) => void;
  onPurgeBackups?: (serverName: string, daysRetention: number) => Promise<{ success: boolean; message?: string; error?: string }>;
  onMetricsRefresh?: (serverName: string) => void;
  /** Estimación inicial (vendrá de DrawerMetrics para evitar doble llamada SSH en mount) */
  initialEstimatedSavings?: string;
}

export default function DrawerDangerZone({
  server,
  onMaintenanceAction,
  onPurgeBackups,
  onMetricsRefresh,
  initialEstimatedSavings,
}: DrawerDangerZoneProps) {
  const [dangerConfirmInput, setDangerConfirmInput] = useState('');
  const [daysRetention, setDaysRetention] = useState(10);
  const [purging, setPurging] = useState(false);
  // Inicializamos con el valor que nos pasa DrawerMetrics (ya calculado)
  // para evitar una segunda conexión SSH al mismo servidor en el mount.
  const [estimatedSavings, setEstimatedSavings] = useState(initialEstimatedSavings ?? '—');
  const [loadingEstimation, setLoadingEstimation] = useState(!initialEstimatedSavings);

  // Se activa cuando el usuario cambia los días de retención.
  // En el mount no corre si ya tenemos el valor inicial del padre.
  // forceRefresh: true — el usuario eligió activamente un período distinto,
  // necesita datos reales del servidor (no la caché de otra consulta).
  const fetchEstimation = useCallback(async (days: number, forceRefresh = true) => {
    setLoadingEstimation(true);
    try {
      const api = (window as any).api;
      if (!api) { setLoadingEstimation(false); return; }
      const result = await api.invoke('get-detailed-storage', {
        serverName: server.name,
        daysRetention: days,
        forceRefresh,
      });
      if (result.success && result.data) {
        setEstimatedSavings(result.data.estimatedSavings);
      } else {
        setEstimatedSavings('—');
      }
    } catch {
      setEstimatedSavings('—');
    } finally {
      setLoadingEstimation(false);
    }
  }, [server.name]);


  // Solo corre si aún no tenemos estimación o cuando cambia la retención
  const isFirstRender = useState(true);
  useEffect(() => {
    if (isFirstRender[0]) {
      isFirstRender[1](false);
      // Si ya teníamos el valor inicial, no repetimos la llamada
      if (initialEstimatedSavings !== undefined) {
        setLoadingEstimation(false);
        return;
      }
    }
    fetchEstimation(daysRetention);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [daysRetention]);

  const handleAction = useCallback((action: MaintenanceAction) => {
    onMaintenanceAction(server.name, action);
  }, [server.name, onMaintenanceAction]);

  const handlePurgeBackups = useCallback(async () => {
    if (!onPurgeBackups || purging) return;
    setPurging(true);
    try {
      await onPurgeBackups(server.name, daysRetention);
      if (onMetricsRefresh) onMetricsRefresh(server.name);
      fetchEstimation(daysRetention);
    } finally {
      setPurging(false);
    }
  }, [server.name, daysRetention, onPurgeBackups, onMetricsRefresh, fetchEstimation, purging]);

  const isConfirmed = dangerConfirmInput === server.name;

  return (
    <div className="space-y-6">
      {/* Warning banner */}
      <div
        className="p-4 rounded-lg"
        style={{
          backgroundColor: 'oklch(0.45 0.18 25 / 0.1)',
          border: '1px solid oklch(0.45 0.18 25 / 0.2)',
        }}
      >
        <h3 className="font-display font-bold text-sm mb-1" style={{ color: 'var(--color-error)' }}>
          Zona de Peligro
        </h3>
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          Estas acciones son irreversibles. Escriba el nombre del servidor para habilitarlas.
        </p>
      </div>

      {/* Confirmation input */}
      <div>
        <label className="text-xs font-medium mb-1.5 block" style={{ color: 'var(--text-muted)' }}>
          Escriba <code className="font-mono rounded px-1" style={{ backgroundColor: 'var(--surface-overlay)' }}>{server.name}</code> para confirmar:
        </label>
        <input
          type="text"
          value={dangerConfirmInput}
          onChange={e => setDangerConfirmInput(e.target.value)}
          placeholder={server.name}
          className="input input--mono"
        />
      </div>

      {/* ── Limpieza de Backups Locales de Plesk ── */}
      {onPurgeBackups && (
        <div
          className="p-4 rounded-lg"
          style={{
            backgroundColor: 'oklch(0.4 0.08 35 / 0.08)',
            border: '1px solid oklch(0.4 0.08 35 / 0.15)',
          }}
        >
          <h4 className="font-display font-bold text-xs mb-2 flex items-center gap-2" style={{ color: 'var(--color-warning)' }}>
            <Database size={14} />
            Limpieza de Backups Locales de Plesk
          </h4>
          <p className="text-[11px] mb-3" style={{ color: 'var(--text-muted)' }}>
            Elimina backups antiguos de Plesk en /var/lib/psa/dumps/ según los días de retención.
          </p>

          <label className="text-[11px] font-medium mb-1 block" style={{ color: 'var(--text-muted)' }}>
            Días de retención:
          </label>
          <select
            value={daysRetention}
            onChange={e => setDaysRetention(Number(e.target.value))}
            className="input mb-3 text-xs"
            disabled={purging}
          >
            {RETENTION_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>

          {/* Estimación dinámica */}
          <div
            className="mb-3 p-2.5 rounded text-xs"
            style={{
              backgroundColor: 'oklch(0.3 0.03 260 / 0.3)',
              border: '1px solid oklch(0.3 0.03 260 / 0.25)',
              color: 'var(--text-secondary)',
            }}
          >
            {loadingEstimation ? (
              <span className="flex items-center gap-2" style={{ color: 'var(--text-muted)' }}>
                <span className="spinner-mini" /> Calculando...
              </span>
            ) : (
              <>
                👉 Selección actual: Se eliminarán aproximadamente{' '}
                <strong style={{ color: 'var(--color-warning)' }}>{estimatedSavings}</strong>{' '}
                de datos viejos en tu servidor.
              </>
            )}
          </div>

          <button
            onClick={handlePurgeBackups}
            disabled={!isConfirmed || purging}
            className="btn w-full flex items-center justify-center gap-2 text-xs"
            style={{
              backgroundColor: 'oklch(0.45 0.18 35 / 0.15)',
              color: isConfirmed ? 'var(--color-error)' : 'var(--text-muted)',
              border: '1px solid oklch(0.45 0.18 35 / 0.25)',
              opacity: isConfirmed ? 1 : 0.5,
            }}
          >
            {purging ? (
              <><span className="spinner-mini" /> Purgando backups...</>
            ) : (
              <><Trash2 size={14} /> Ejecutar Purga de Disco</>
            )}
          </button>
        </div>
      )}

      {/* Action buttons */}
      <div className="space-y-3">
        <button
          onClick={() => handleAction('restart')}
          disabled={!isConfirmed}
          className="btn w-full flex items-center justify-center gap-2 text-sm"
          style={{
            backgroundColor: 'oklch(0.55 0.15 75 / 0.15)',
            color: isConfirmed ? 'var(--color-warning)' : 'var(--text-muted)',
            border: '1px solid oklch(0.55 0.15 75 / 0.2)',
            opacity: isConfirmed ? 1 : 0.5,
          }}
        >
          <Power size={14} />
          Reiniciar Servidor
        </button>
        <button
          onClick={() => handleAction('shutdown')}
          disabled={!isConfirmed}
          className="btn btn--danger w-full flex items-center justify-center gap-2 text-sm"
          style={{ opacity: isConfirmed ? 1 : 0.5 }}
        >
          <PowerOff size={14} />
          Apagar Servidor
        </button>
      </div>
    </div>
  );
}
