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
        className="p-4 rounded-lg bg-error/10 border border-error/20"
      >
        <h3 className="font-display font-bold text-sm mb-1 text-error">
          Zona de Peligro
        </h3>
        <p className="text-xs text-on-surface-variant">
          Estas acciones son irreversibles. Escriba el nombre del servidor para habilitarlas.
        </p>
      </div>

      {/* Confirmation input */}
      <div>
        <label className="text-xs font-medium mb-1.5 block text-on-surface-variant">
          Escriba <code className="font-mono rounded px-1 bg-black/30">{server.name}</code> para confirmar:
        </label>
        <input
          type="text"
          value={dangerConfirmInput}
          onChange={e => setDangerConfirmInput(e.target.value)}
          placeholder={server.name}
          className="w-full bg-background border border-outline-variant rounded px-3 py-1.5 text-sm text-on-surface font-mono focus:border-error focus:ring-1 focus:ring-error transition-all"
        />
      </div>

      {/* ── Limpieza de Backups Locales de Plesk ── */}
      {onPurgeBackups && (
        <div
          className="p-4 rounded-lg bg-yellow-500/10 border border-yellow-500/20"
        >
          <h4 className="font-display font-bold text-xs mb-2 flex items-center gap-2 text-yellow-400">
            <Database size={14} />
            Limpieza de Backups Locales de Plesk
          </h4>
          <p className="text-[11px] mb-3 text-on-surface-variant">
            Elimina backups antiguos de Plesk en /var/lib/psa/dumps/ según los días de retención.
          </p>

          <label className="text-[11px] font-medium mb-1 block text-on-surface-variant">
            Días de retención:
          </label>
          <select
            value={daysRetention}
            onChange={e => setDaysRetention(Number(e.target.value))}
            className="w-full bg-background border border-outline-variant rounded px-3 py-1.5 text-xs text-on-surface mb-3 focus:border-tertiary focus:ring-1 focus:ring-tertiary transition-all"
            disabled={purging}
          >
            {RETENTION_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>

          {/* Estimación dinámica */}
          <div
            className="mb-3 p-2.5 rounded text-xs bg-surface-container border border-outline-variant text-on-surface-variant"
          >
            {loadingEstimation ? (
              <span className="flex items-center gap-2 text-on-surface-variant">
                <span className="spinner-mini" /> Calculando...
              </span>
            ) : (
              <>
                👉 Selección actual: Se eliminarán aproximadamente{' '}
                <strong className="text-yellow-400">{estimatedSavings}</strong>{' '}
                de datos viejos en tu servidor.
              </>
            )}
          </div>

          <button
            onClick={handlePurgeBackups}
            disabled={!isConfirmed || purging}
            className={`w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-title-sm rounded border transition-all ${isConfirmed ? 'bg-error/20 text-error border-error/30 hover:bg-error/30' : 'bg-surface-container text-on-surface-variant border-outline-variant opacity-50'}`}
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
          className={`w-full flex items-center justify-center gap-2 px-4 py-2 text-sm font-title-sm rounded border transition-all ${isConfirmed ? 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30 hover:bg-yellow-500/30' : 'bg-surface-container text-on-surface-variant border-outline-variant opacity-50'}`}
        >
          <Power size={14} />
          Reiniciar Servidor
        </button>
        <button
          onClick={() => handleAction('shutdown')}
          disabled={!isConfirmed}
          className={`w-full flex items-center justify-center gap-2 px-4 py-2 text-sm font-title-sm rounded transition-all ${isConfirmed ? 'bg-error text-white hover:brightness-110' : 'bg-surface-container text-on-surface-variant opacity-50 cursor-not-allowed'}`}
        >
          <PowerOff size={14} />
          Apagar Servidor
        </button>
      </div>
    </div>
  );
}
