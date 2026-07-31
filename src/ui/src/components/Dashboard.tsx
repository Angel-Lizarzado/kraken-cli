import { useState, useEffect, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Activity, Server, X, ChevronRight, HeartPulse } from 'lucide-react';

import type { Server as ServerType, MaintenanceAction } from '../types/server';
import type { Cloud, Account } from '../types/cloud';
import type { LogLevel } from '../types/ipc';
import { useIpc } from '../hooks/useIpc';

import ServerGrid from './dashboard/ServerGrid';
import ServerFormModal from './ServerFormModal';
import LookupBar from './dashboard/LookupBar';
import DrawerMetrics from './dashboard/DrawerMetrics';
import DrawerLogs from './dashboard/DrawerLogs';
import DrawerDangerZone from './dashboard/DrawerDangerZone';
import ConfirmDialog from './dashboard/ConfirmDialog';
import HealthCheckModal from './HealthCheckModal';
import ServerCommandCenter from './dashboard/ServerCommandCenter';

// ── Props ──
interface DashboardProps {
  onServerSelect?: (server: ServerType) => void;
  onCloudSelect?: (cloud: { name: string; type: string; isLinked: boolean; sshCredentials: { host: string; port: number; username: string } }) => void;
  onLinkSSH?: (type: 'server' | 'cloud', name: string) => void;
  onRunDiagnostics?: (serverName: string) => void;
  onMaintenanceAction?: (serverName: string, action: string) => void;
  onLog: (message: string, type: 'info' | 'warning' | 'error' | 'success') => void;
}

// ── Component ──
const Dashboard: React.FC<DashboardProps> = ({
  onServerSelect = () => { },
  onCloudSelect = () => { },
  onLinkSSH = () => { },
  onRunDiagnostics = () => { },
  onMaintenanceAction = () => { },
  onLog,
}) => {
  // ── IPC ──
  const {
    config,
    injectSshKey,
    injectKeyWithCredentials,
    runServerDiagnostics,
    performMaintenance,
    saveConfig,
    loadConfig,
    testConnection,
    createAccountFolder,
    createCloudFolder,
    lookupHost,
    tailServerLog,
    execServerCommand,
  } = useIpc();

  // ── Eliminar servidor ──
  const handleDeleteServer = useCallback(
    async (serverName: string) => {
      const api = (window as any).api;
      if (!api) return;
      const result = await api.invoke('server:delete', { serverName });
      if (!result.success) {
        onLog(`Error al eliminar "${serverName}": ${result.error}`, 'error');
        return;
      }
      // Cerrar drawer si el servidor eliminado estaba seleccionado
      setSelectedServer((prev) => (prev?.name === serverName ? null : prev));
      onLog(`Servidor "${serverName}" eliminado correctamente.`, 'success');
      // config:updated broadcast del backend actualiza el árbol automáticamente
    },
    [onLog],
  );

  // ── State ──
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [servers, setServers] = useState<ServerType[]>([]);
  const [selectedServer, setSelectedServer] = useState<ServerType | null>(null);
  const [loading, setLoading] = useState(true);
  const [showConfirmDialog, setShowConfirmDialog] = useState<{ action: string; serverName: string } | null>(null);
  const [refreshingDiagnostics, setRefreshingDiagnostics] = useState<string[]>([]);

  const [formModal, setFormModal] = useState<{
    isOpen: boolean;
    targetType: 'server' | 'cloud';
    editData?: { accountName?: string; itemName: string };
  }>({ isOpen: false, targetType: 'server' });

  const [drawerTab, setDrawerTab] = useState<'Métricas' | 'Logs' | 'Danger Zone'>('Métricas');
  const [serverLogs, setServerLogs] = useState<string | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);
  // Caché de storageData por servidor para evitar doble llamada SSH
  const [storageCache, setStorageCache] = useState<Record<string, { estimatedSavings: string }>>({});
  const [healthCheckServer, setHealthCheckServer] = useState<string | null>(null);
  // ── Command Center: servidor activo en vista de detalle ──
  const [commandServer, setCommandServer] = useState<ServerType | null>(null);

  // ── Derived ──
  const totalServers = servers.length;
  const totalClouds = useMemo(
    () => accounts.reduce((t, a) => t + (a.originClouds || []).length, 0),
    [accounts],
  );

  // ── Lookup handler ──
  const handleLookup = useCallback(
    async (domain: string) => {
      return lookupHost(domain);
    },
    [lookupHost],
  );

  // ── Server log refresh ──
  const handleRefreshLogs = useCallback(async () => {
    const server = selectedServer;
    if (!server) return;
    setLogsLoading(true);
    try {
      const res = await tailServerLog(server.name);
      if (res.success && res.log) {
        setServerLogs(res.log);
      } else {
        setServerLogs(
          `[${new Date().toISOString()}] ERROR: ${res.error || 'No se pudieron obtener los logs'}\n` +
          `[${new Date().toISOString()}] Verifique que el servidor esté online y el path /var/log/plesk/panel.log exista.`,
        );
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error desconocido';
      setServerLogs(
        `[${new Date().toISOString()}] ERROR: ${message}\n` +
        `[${new Date().toISOString()}] Verifique que el servidor esté online y el SSH esté configurado.`,
      );
    } finally {
      setLogsLoading(false);
    }
  }, [selectedServer, tailServerLog]);

  // ── Modal handlers ──
  const openAddForm = useCallback((type: 'server' | 'cloud') => {
    setFormModal({ isOpen: true, targetType: type });
  }, []);

  const openEditForm = useCallback(
    (type: 'server' | 'cloud', accountName: string | undefined, itemName: string) => {
      const editData = accountName ? { accountName, itemName } : { itemName };
      setFormModal({ isOpen: true, targetType: type, editData });
    },
    [],
  );

  // ── Modal save ──
  const handleModalSave = useCallback(
    async (payload: any): Promise<boolean> => {
      if (!config) return false;

      try {
        if (payload.targetType === 'server') {
          const updatedServers = JSON.parse(JSON.stringify(config.destinationServers || []));

          const pleskPort = payload.formData.port || 22;
          const serverItem = {
            name: payload.formData.name,
            type: 'plesk' as const,
            isLinked: payload.isLinked,
            sshCredentials: {
              host: payload.formData.host,
              port: pleskPort,
              username: payload.formData.username,
            },
            pleskCliPath: '/usr/local/psa/bin',
          };

          if (payload.editData) {
            const idx = updatedServers.findIndex((s: any) => s.name === payload.editData.itemName);
            if (idx >= 0) updatedServers[idx] = serverItem;
          } else {
            updatedServers.push(serverItem);
          }

          await saveConfig({ destinationServers: updatedServers } as any);
          await loadConfig();
          onLog(`Servidor "${payload.formData.name}" guardado correctamente.`, 'success');
          return true;
        }

        const cloudPort = 65002;
        const targetAccountName = payload.formData.associatedAccount;
        if (!targetAccountName) {
          onLog('Debe especificar una cuenta para el cloud.', 'error');
          return false;
        }

        const updatedAccounts = JSON.parse(JSON.stringify(config.accounts || []));

        let accountIndex = updatedAccounts.findIndex((a: any) => a.name === targetAccountName);
        if (accountIndex === -1) {
          updatedAccounts.push({ name: targetAccountName, originClouds: [] });
          accountIndex = updatedAccounts.length - 1;
          onLog(`Cuenta "${targetAccountName}" creada automáticamente.`, 'info');
        }

        const cloudItem = {
          name: payload.formData.name,
          type: 'hostinger' as const,
          isLinked: payload.isLinked,
          sshCredentials: {
            host: payload.formData.host,
            port: cloudPort,
            username: payload.formData.username,
          },
        };

        if (payload.editData) {
          const idx = updatedAccounts[accountIndex].originClouds.findIndex(
            (c: any) => c.name === payload.editData.itemName,
          );
          if (idx >= 0) updatedAccounts[accountIndex].originClouds[idx] = cloudItem;
        } else {
          updatedAccounts[accountIndex].originClouds.push(cloudItem);
        }

        try {
          if (payload.editData === null) {
            await createAccountFolder(targetAccountName);
            onLog(`Carpeta en disco creada para cuenta "${targetAccountName}".`, 'info');
          }
          await createCloudFolder(targetAccountName, payload.formData.name);
        } catch (folderError: any) {
          onLog(`No se pudo crear la carpeta en disco: ${folderError.message}`, 'warning');
        }

        await saveConfig({ accounts: updatedAccounts } as any);
        await loadConfig();
        onLog(`Cloud "${payload.formData.name}" guardado correctamente en cuenta "${targetAccountName}".`, 'success');

        return true;
      } catch (error: any) {
        onLog(`Error al guardar: ${error.message}`, 'error');
        return false;
      }
    },
    [config, saveConfig, loadConfig, onLog, createAccountFolder, createCloudFolder],
  );

  // ── Modal delete ──
  const handleModalDelete = useCallback(async () => {
    if (!formModal.editData || !config) return;
    const { itemName, accountName } = formModal.editData;

    if (window.confirm(`¿Eliminar definitivamente "${itemName}"? Esta acción no se puede deshacer.`)) {
      if (formModal.targetType === 'server') {
        await handleDeleteServer(itemName);
      } else {
        const updatedAccounts = JSON.parse(JSON.stringify(config.accounts || []));
        const accountIndex = updatedAccounts.findIndex((a: any) => a.name === accountName);
        if (accountIndex >= 0) {
          updatedAccounts[accountIndex].originClouds = updatedAccounts[accountIndex].originClouds.filter(
            (c: any) => c.name !== itemName
          );
          await saveConfig({ accounts: updatedAccounts } as any);
          await loadConfig();
          onLog(`Cloud "${itemName}" eliminado correctamente.`, 'success');
        }
      }
      setFormModal({ isOpen: false, targetType: 'server' });
    }
  }, [formModal, config, handleDeleteServer, saveConfig, loadConfig, onLog]);

  // ── Inject key helper ──
  const handleInjectKey = useCallback(
    async (
      creds: { host: string; port: number; username: string },
      password: string,
    ): Promise<{ success: boolean; error?: string }> => {
      try {
        const result = await injectKeyWithCredentials(creds, password);
        return result;
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    },
    [injectKeyWithCredentials],
  );

  // ── Diagnostics loader ──
  const loadServerDiagnostics = useCallback(
    async (serverName: string) => {
      try {
        setRefreshingDiagnostics((prev) => [...prev, serverName]);
        const diagnostics = await runServerDiagnostics('', serverName);
        setServers((prev) =>
          prev.map((s) =>
            s.name === serverName ? { ...s, status: 'online', diagnostics } : s,
          ),
        );
      } catch {
        setServers((prev) =>
          prev.map((s) =>
            s.name === serverName ? { ...s, status: 'offline', diagnostics: undefined } : s,
          ),
        );
      } finally {
        setRefreshingDiagnostics((prev) => prev.filter((name) => name !== serverName));
      }
    },
    [runServerDiagnostics],
  );

  // ── Incremental config sync ──
  // Cuando config cambia (ej. se agrega un servidor), hacemos merge:
  // - Servidores existentes: preservan status/diagnostics (NO parpadeo)
  // - Servidores nuevos: se inicializan con status='unknown' y se les corre diagnóstico
  useEffect(() => {
    try {
      const mappedAccounts: Account[] = (config?.accounts || []).map((account) => ({
        name: account.name || 'Sin nombre',
        originClouds: (account.originClouds || []).map((cloud) => ({
          name: cloud.name,
          type: cloud.type as 'hostinger' | 'other',
          isLinked: cloud.isLinked || false,
          sshCredentials: cloud.sshCredentials,
        })),
      }));

      // 🔥 HOTFIX v1.5.4: filtrar servidor 'Global'
      const incomingServers = (config?.destinationServers || []).filter(s => s.name !== 'Global');

      setServers((prev) => {
        // Indexar servidores anteriores por nombre para O(1) lookup
        const prevByName = new Map(prev.map(s => [s.name, s]));

        const merged: ServerType[] = incomingServers.map((server) => {
          const existing = prevByName.get(server.name);
          if (existing) {
            // Servidor existente → preservar telemetría, actualizar solo config
            return {
              ...existing,
              // Actualizar propiedades de configuración que pudieron cambiar
              type: server.type as 'plesk' | 'hostinger' | 'other',
              isLinked: server.isLinked || false,
              sshCredentials: server.sshCredentials,
              pleskCliPath: server.pleskCliPath,
            };
          }
          // Servidor nuevo → inicializar limpio
          return {
            name: server.name,
            type: server.type as 'plesk' | 'hostinger' | 'other',
            isLinked: server.isLinked || false,
            sshCredentials: server.sshCredentials,
            pleskCliPath: server.pleskCliPath,
            status: 'unknown' as const,
            diagnostics: undefined,
          };
        });

        // Identificar servidores nuevos que necesitan diagnóstico
        const newLinkedServers = merged.filter(
          s => s.isLinked && !prevByName.has(s.name),
        );

        // Disparar diagnóstico solo para los NUEVOS (async, no bloqueante)
        if (newLinkedServers.length > 0) {
          Promise.all(
            newLinkedServers.map(s => loadServerDiagnostics(s.name)),
          ).catch(err => console.error('Error en diagnóstico de servidores nuevos:', err));
        }

        return merged;
      });

      setAccounts(mappedAccounts);
      setLoading(false);
    } catch (error) {
      console.error('Error al cargar configuración en Dashboard:', error);
      setAccounts([]);
      setServers([]);
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config]);

  // ── Handlers ──
  const handleServerSelect = useCallback(
    (server: ServerType) => {
      // Opción A: mutar la vista al Command Center del servidor
      setCommandServer(server);
      setSelectedServer(null); // cerrar drawer si estaba abierto
      onServerSelect(server);
    },
    [onServerSelect],
  );

  const closeDrawer = useCallback(() => {
    setSelectedServer(null);
  }, []);

  const handleLinkSSH = useCallback(
    async (type: 'server' | 'cloud', name: string) => {
      try {
        if (type === 'server') {
          const server = servers.find((s) => s.name === name);
          if (!server) throw new Error('Servidor no encontrado');
          await injectSshKey('', name, type);
          onLinkSSH(type, name);
          setServers((prev) =>
            prev.map((s) => (s.name === name ? { ...s, isLinked: true } : s)),
          );
        } else {
          const account = accounts.find((acc) =>
            (acc.originClouds || []).some((c) => c.name === name),
          );
          if (!account) throw new Error('Cuenta no encontrada');
          await injectSshKey(account.name, name, type);
          onLinkSSH(type, name);
          setAccounts((prev) =>
            prev.map((acc) =>
              acc.name === account.name
                ? {
                  ...acc,
                  originClouds: acc.originClouds.map((c) =>
                    c.name === name ? { ...c, isLinked: true } : c,
                  ),
                }
                : acc,
            ),
          );
        }
      } catch (error) {
        onLinkSSH(type, name);
      }
    },
    [accounts, servers, injectSshKey, onLinkSSH],
  );

  const handleRunDiagnostics = useCallback(
    async (serverName: string) => {
      const server = servers.find((s) => s.name === serverName);
      if (!server) return;
      await loadServerDiagnostics(serverName);
      onRunDiagnostics(serverName);
    },
    [servers, loadServerDiagnostics, onRunDiagnostics],
  );

  const performMaintenanceAction = useCallback(
    async (serverName: string, action: MaintenanceAction) => {
      const server = servers.find((s) => s.name === serverName);
      if (!server) return;
      try {
        await performMaintenance('', serverName, action);
        onMaintenanceAction(serverName, action);
      } catch {
        onMaintenanceAction(serverName, action);
      }
    },
    [servers, performMaintenance, onMaintenanceAction],
  );

  const handleMaintenanceAction = useCallback(
    async (serverName: string, action: MaintenanceAction) => {
      try {
        await performMaintenanceAction(serverName, action);
        // Refresh metrics after maintenance action
        loadServerDiagnostics(serverName);
      } catch { /* handled in performMaintenanceAction */ }
    },
    [performMaintenanceAction, loadServerDiagnostics],
  );

  const handlePurgeBackups = useCallback(
    async (serverName: string, daysRetention: number) => {
      try {
        const api = (window as any).api;
        if (!api) throw new Error('IPC no disponible');
        const result = await api.invoke('purge-plesk-backups', { serverName, daysRetention });
        if (result.success) {
          onLog(`[PURGE] Backups de Plesk eliminados (>${daysRetention} días)`, 'success');
          return result;
        }
        throw new Error(result.error || 'Error desconocido');
      } catch (err: any) {
        onLog(`[PURGE] Error: ${err.message}`, 'error');
        throw err;
      }
    },
    [onLog],
  );

  const confirmShutdown = useCallback(() => {
    if (showConfirmDialog) {
      performMaintenanceAction(showConfirmDialog.serverName, showConfirmDialog.action as MaintenanceAction);
      setShowConfirmDialog(null);
    }
  }, [showConfirmDialog, performMaintenanceAction]);

  // ── Loading state ──
  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="spinner mx-auto" />
          <p className="mt-4 text-sm" >
            Cargando configuración...
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full overflow-hidden bg-background">
      {/* ── Left Master Panel (Lista) ── */}
      <div 
        className={`flex-shrink-0 flex flex-col h-full overflow-y-auto border-r transition-[width,background-color] duration-300 ease-in-out ${commandServer ? 'w-[360px] bg-surface-container-lowest' : 'w-full bg-background'}`}
        
      >
        <div className={`p-6 space-y-6 ${commandServer ? 'opacity-90 scale-[0.98] origin-top' : ''} transition-[opacity,transform] duration-300`}>
          {/* ── Header ── */}
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <h1 className="font-display text-xl font-bold">Panel de servidores</h1>
              {!commandServer && (
                <p className="text-sm text-on-surface-variant" >
                  Gestión de servidores Plesk y clouds Hostinger
                </p>
              )}
            </div>
            {!commandServer && <LookupBar onLookup={handleLookup} />}
          </div>

          {/* ── Quick Stats ── */}
          {!commandServer && (
            <div className="flex gap-4 text-sm text-on-surface-variant" >
              <span>{totalServers} servidores configurados</span>
              <span aria-hidden="true">·</span>
              <span>{totalClouds} clouds configurados</span>
            </div>
          )}

          {/* ── Servers Section ── */}
          <section>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-display text-base font-bold">Servidores destino (Plesk)</h2>
              <button onClick={() => openAddForm('server')} className="px-3 py-1.5 bg-secondary text-on-secondary rounded flex items-center font-title-sm hover:brightness-110 transition-all">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                {!commandServer && <span className="ml-1">Agregar servidor</span>}
              </button>
            </div>

            <ServerGrid
              servers={servers}
              selectedServer={commandServer}
              onSelectServer={handleServerSelect}
              compact={!!commandServer}
            />
          </section>

          {/* ── Clouds Section ── */}
          {!commandServer && (
            <section>
              <div className="flex items-center justify-between mb-4">
                <h2 className="font-display text-base font-bold">Clouds origen (Hostinger)</h2>
                <button onClick={() => openAddForm('cloud')} className="px-3 py-1.5 bg-secondary text-on-secondary rounded flex items-center font-title-sm hover:brightness-110 transition-all">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                  Agregar cloud
                </button>
              </div>

              <div className="bg-surface-container-low border border-outline-variant rounded overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr
                        className="border-b text-xs font-medium text-on-surface-variant border-b border-outline-variant/50"
                      >
                        <th className="text-left py-3 px-4 font-medium">Nombre</th>
                        <th className="text-left py-3 px-4 font-medium">Host</th>
                        <th className="text-left py-3 px-4 font-medium">SSH</th>
                        <th className="text-left py-3 px-4 font-medium">Acciones</th>
                      </tr>
                    </thead>
                    <tbody>
                      {accounts.map((account) =>
                        (account.originClouds || []).map((cloud) => (
                          <tr
                            key={`${account.name}-${cloud.name}`}
                            className="border-b transition-colors duration-150 ease-out border-b border-outline-variant/30 hover:bg-surface-container-high transition-colors"
                          >
                            <td className="py-3 px-4">
                              <div className="font-medium">{cloud.name}</div>
                              <div className="text-xs" >
                                {account.name}
                              </div>
                            </td>
                            <td className="py-3 px-4">
                              <div className="font-mono text-xs">
                                {cloud.sshCredentials.host}:{cloud.sshCredentials.port}
                              </div>
                              <div className="text-xs" >
                                Usuario: {cloud.sshCredentials.username}
                              </div>
                            </td>
                            <td className="py-3 px-4">
                              <span className={`tag ${cloud.isLinked ? 'tag--success' : 'tag--error'}`}>
                                {cloud.isLinked ? 'Conectado' : 'Desconectado'}
                              </span>
                            </td>
                            <td className="py-3 px-4">
                              <div className="flex gap-2">
                                <button
                                  onClick={() => openEditForm('cloud', account.name, cloud.name)}
                                  className="px-3 py-1.5 text-on-surface-variant hover:text-on-surface hover:bg-surface-container rounded transition-all font-title-sm text-xs"
                                >
                                  Editar
                                </button>
                                {!cloud.isLinked && (
                                  <button
                                    onClick={() => handleLinkSSH('cloud', cloud.name)}
                                    className="btn text-xs px-3 py-1.5 text-xs font-title-sm rounded bg-tertiary/20 text-tertiary border border-tertiary/30 hover:bg-tertiary/30 transition-all"
                                  >
                                    Vincular SSH
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        )),
                      )}
                    </tbody>
                  </table>
                </div>
                <div
                  className="px-4 py-3 text-xs bg-surface-container-lowest text-on-surface-variant"
                >
                  Los clouds Hostinger son entidades de configuración. Se usan como origen de datos en el módulo
                  de extracción.
                </div>
              </div>
            </section>
          )}
        </div>
      </div>

      {/* ── Right Detail Panel (Command Center Drawer) ── */}
      <AnimatePresence>
        {commandServer && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="absolute inset-0 z-40 bg-black/60 backdrop-blur-sm"
              onClick={() => setCommandServer(null)}
            />
            <motion.div
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 200 }}
              className="absolute top-0 right-0 h-full shadow-2xl flex flex-col overflow-y-auto z-50 w-[90%] max-w-[1200px] bg-background border-l border-outline-variant p-lg"
            >
              <ServerCommandCenter
                key={`cc-${commandServer.name}`}
                server={commandServer}
                onBack={() => setCommandServer(null)}
                onEdit={() => openEditForm('server', undefined, commandServer.name)}
                onLog={onLog}
              />
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* ── Shutdown Confirmation ── */}
      {showConfirmDialog && (
        <ConfirmDialog
          serverName={showConfirmDialog.serverName}
          onConfirm={confirmShutdown}
          onCancel={() => setShowConfirmDialog(null)}
        />
      )}

      {/* ── Server Form Modal ── */}
      <ServerFormModal
        isOpen={formModal.isOpen}
        onClose={() => setFormModal({ isOpen: false, targetType: 'server' })}
        targetType={formModal.targetType}
        editData={formModal.editData}
        accounts={accounts}
        onSave={handleModalSave}
        onDelete={formModal.editData ? handleModalDelete : undefined}
        testConnection={testConnection}
        onInjectKey={handleInjectKey}
        onLog={onLog}
        publicKeyPath={config?.sshKeys?.publicKeyPath}
      />

      {/* ── Health Check Modal ── */}
      <HealthCheckModal
        isOpen={healthCheckServer !== null}
        onClose={() => setHealthCheckServer(null)}
        serverName={healthCheckServer || ''}
        onLog={onLog}
      />
    </div>
  );
};

export default Dashboard;
