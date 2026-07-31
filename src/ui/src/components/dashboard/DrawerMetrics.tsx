import { useState, useEffect, useCallback, useRef } from 'react';
import { HardDrive, FolderArchive, Globe, FileText, RefreshCw } from 'lucide-react';
import ServerDetailView from './ServerDetailView';
import type { Server } from '../../types/server';
import type { LogLevel } from '../../types/ipc';

interface StorageData {
  backups: string;
  vhosts: string;
  logs: string;
  estimatedSavings: string;
}

interface DrawerMetricsProps {
  server: Server;
  onRunDiagnostics: (serverName: string) => void;
  onLog: (message: string, type: LogLevel) => void;
  execServerCommand: (serverName: string, command: string) => Promise<{ success: boolean; stdout?: string; stderr?: string; error?: string }>;
  onMetricsRefresh?: (serverName: string) => void;
  /** Callback opcional: propaga los datos de storage al padre para evitar doble IPC en DrawerDangerZone */
  onStorageLoaded?: (data: StorageData) => void;
}

export default function DrawerMetrics({ server, onRunDiagnostics, onLog, execServerCommand, onMetricsRefresh, onStorageLoaded }: DrawerMetricsProps) {
  const [storageData, setStorageData] = useState<StorageData | null>(null);
  const [loadingStorage, setLoadingStorage] = useState(false);
  const [fromCache, setFromCache] = useState(false);

  // Usamos ref para que fetchStorage NO se recree cuando onStorageLoaded cambie.
  // onStorageLoaded es un callback fire-and-forget: no debe provocar re-suscripción del effect.
  const onStorageLoadedRef = useRef(onStorageLoaded);
  useEffect(() => { onStorageLoadedRef.current = onStorageLoaded; });

  const fetchStorage = useCallback(async (forceRefresh = false) => {
    setLoadingStorage(true);
    try {
      const api = (window as any).api;
      if (!api) return;
      const result = await api.invoke('get-detailed-storage', {
        serverName: server.name,
        daysRetention: 10,
        forceRefresh,
      });
      if (result.success && result.data) {
        setStorageData(result.data);
        setFromCache(result.fromCache ?? false);
        onStorageLoadedRef.current?.(result.data);
      }
    } catch { /* silent */ } finally {
      setLoadingStorage(false);
    }
  }, [server.name]); // ← onStorageLoaded FUERA de deps: nunca debe re-disparar el fetch

  // Mount: carga normal — usa caché si existe (0ms si hay hit)
  useEffect(() => { fetchStorage(false); }, [fetchStorage]);


  const handleForceRefresh = useCallback(() => {
    fetchStorage(true);
  }, [fetchStorage]);

  return (
    <div className="space-y-6">
      <ServerDetailView
        server={server}
        onRunDiagnostics={onRunDiagnostics}
        onLog={onLog}
        execServerCommand={execServerCommand}
        onMetricsRefresh={onMetricsRefresh}
      />

      {/* ── Desglose de Almacenamiento ── */}
      <div className="bg-surface-container-low border border-outline-variant rounded p-4">
        <h3 className="font-display text-sm font-bold mb-3 flex items-center gap-2">
          <HardDrive size={14} className="text-on-surface-variant" />
          <span style={{ flex: 1 }}>Desglose de Almacenamiento</span>

          {/* Indicador de caché + botón refrescar */}
          {!loadingStorage && storageData && fromCache && (
            <span
              className="text-[10px] font-mono text-on-surface-variant"
              title="Datos servidos desde caché local (menos de 60 min de antigüedad)"
            >
              desde caché
            </span>
          )}
          <button
            onClick={handleForceRefresh}
            disabled={loadingStorage}
            className="p-1.5 rounded-md text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high transition-all"
            title="Actualizar datos en tiempo real"
            style={{ padding: '3px 6px', lineHeight: 1 }}
            aria-label="Actualizar desglose de almacenamiento"
          >
            <RefreshCw
              size={12}
              style={{
                transition: 'transform 600ms linear',
                transform: loadingStorage ? 'rotate(360deg)' : 'rotate(0deg)',
              }}
            />
          </button>
        </h3>

        {loadingStorage ? (
          <div className="flex items-center gap-2 text-xs text-on-surface-variant">
            <span className="spinner-mini" /> Consultando servidor...
          </div>
        ) : storageData ? (
          <div className="space-y-2">
            <StorageRow icon={<FolderArchive size={13} />} label="Copias de Seguridad (Plesk)" value={storageData.backups} color="#ffb142" />
            <StorageRow icon={<Globe size={13} />} label="Sitios Web de Clientes" value={storageData.vhosts} color="#34ace0" />
            <StorageRow icon={<FileText size={13} />} label="Archivos de Logs" value={storageData.logs} color="#a5a5a5" />
          </div>
        ) : (
          <p className="text-xs text-on-surface-variant">No disponible</p>
        )}
      </div>
    </div>
  );
}

function StorageRow({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: string; color: string }) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="flex items-center gap-2 text-on-surface-variant">
        <span style={{ color }}>{icon}</span>
        {label}
      </span>
      <span className="font-mono font-medium" style={{ color }}>{value}</span>
    </div>
  );
}
