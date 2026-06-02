import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useIpc } from '../hooks/useIpc';
import { useToast } from './Toast';

interface ScanResult {
  workspaceRoot: string;
  accounts: Array<{
    name: string;
    clouds: Array<{ name: string; domains: string[] }>;
  }>;
}

interface LogEntry {
  id: string;
  timestamp: string;
  message: string;
  type: 'info' | 'warning' | 'error' | 'success';
}

interface ConfigPanelProps {
  onLog: (message: string, type: LogEntry['type'], moduleId?: string) => void;
}

const ConfigPanel: React.FC<ConfigPanelProps> = ({ onLog }) => {
  const { config, loadConfig, scanWorkspace, getCloudflareToken, setCloudflareToken, generateSshKey } = useIpc();
  const toast = useToast();
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [cfTokenDisplay, setCfTokenDisplay] = useState('');
  const [cfTokenInput, setCfTokenInput] = useState('');
  const [savingCfToken, setSavingCfToken] = useState(false);
  const [cfAccountIdInput, setCfAccountIdInput] = useState('');
  const [savingCfAccountId, setSavingCfAccountId] = useState(false);
  const [ghTokenDisplay, setGhTokenDisplay] = useState('');
  const [ghTokenInput, setGhTokenInput] = useState('');
  const [savingGhToken, setSavingGhToken] = useState(false);
  const [sslEmailInput, setSslEmailInput] = useState('');
  const [savingSslEmail, setSavingSslEmail] = useState(false);
  const [masterPasswordInput, setMasterPasswordInput] = useState('');
  const [hasMasterPassword, setHasMasterPassword] = useState(false);
  const [savingMasterPassword, setSavingMasterPassword] = useState(false);
  const [generatingKey, setGeneratingKey] = useState(false);
  const [workspacePath, setWorkspacePath] = useState<string>('');
  const [respaldosPath, setRespaldosPath] = useState<string>('');
  const [changingFolder, setChangingFolder] = useState(false);
  const loadedRef = useRef(false);


  const handleScan = useCallback(async () => {
    setScanning(true);
    setScanResult(null);
    try {
      const result: unknown = await scanWorkspace();
      if (typeof result === 'object' && result !== null && 'success' in result && (result as Record<string, unknown>).success) {
        setScanResult(result as unknown as ScanResult);
        await loadConfig();
        const scanData = result as unknown as ScanResult;
        const totalAccounts = scanData.accounts?.length || 0;
        const totalClouds = scanData.accounts?.reduce((t: number, a: { clouds?: Array<unknown> }) => t + (a.clouds?.length || 0), 0) || 0;
        onLog(`Escaneo completado en ${scanData.workspaceRoot}. Se han sincronizado ${totalAccounts} cuentas y ${totalClouds} clouds.`, 'success', 'config');
      } else {
        onLog(`Error al escanear workspace: ${(result as Record<string, unknown>).error ?? 'Error desconocido'}`, 'error', 'config');
      }
    } catch (err: unknown) {
      onLog(`Error al escanear workspace: ${err instanceof Error ? err.message : String(err)}`, 'error', 'config');
    } finally {
      setScanning(false);
    }
  }, [scanWorkspace, onLog, loadConfig]);

  // Load obfuscated token on mount
  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    (async () => {
      const api = (window as any).api;
      if (!api) return;
      // Cargar CF token
      const result = await getCloudflareToken();
      if (result.success) {
        setCfTokenDisplay(result.obfuscated || '');
        setCfTokenInput(result.token || '');
      }
      // Cargar GitHub token
      try {
        const api = (window as any).api;
        if (api) {
          const ghResult = await api.invoke('config:get-github-token');
          if (ghResult?.success) {
            setGhTokenDisplay(ghResult.obfuscated || '');
            setGhTokenInput(ghResult.token || '');
          }

          // Cargar SSL email
          const sslResult = await api.invoke('config:get-ssl-email');
          if (sslResult?.success) {
            setSslEmailInput(sslResult.email || '');
          }

          // Cargar existencia de Master Password
          const pwResult = await api.invoke('correo:contrasena:existe');
          if (pwResult?.exito) {
            setHasMasterPassword(pwResult.existe);
          }
          
          // Cargar Cloudflare Account ID
          const accountIdResult = await api.invoke('config:get-cloudflare-account-id');
          if (accountIdResult?.success) {
            setCfAccountIdInput(accountIdResult.accountId || '');
          }
        }
      } catch { /* silencioso */ }
      // Cargar workspace path actual
      try {
        const wpResult = await api.invoke('workspace:get-path');
        if (wpResult?.success) {
          setWorkspacePath(wpResult.workspacePath || '');
          setRespaldosPath(wpResult.respaldosPath || '');
        }
      } catch { /* silencioso */ }
    })();
  }, [getCloudflareToken]);


  const handleSaveCfToken = useCallback(async () => {
    const trimmed = cfTokenInput.trim();
    if (!trimmed) {
      onLog('No se puede guardar un token vacío. Ingrese un API Token de Cloudflare válido.', 'warning', 'config');
      return;
    }
    setSavingCfToken(true);
    try {
      const result = await setCloudflareToken(trimmed);
      if (result.success) {
        // Reload the obfuscated display
        const fresh = await getCloudflareToken();
        if (fresh.success) setCfTokenDisplay(fresh.obfuscated);
        onLog('[CONFIG] API Token de Cloudflare actualizado y encriptado.', 'success', 'config');
      } else {
        const errMsg = result.error || 'Error desconocido del backend';
        onLog(`Error al guardar token Cloudflare: ${errMsg}`, 'error', 'config');
        console.error('[CF-TOKEN-UI] Error del backend:', errMsg);
      }
    } catch (err: any) {
      const errMsg = err?.message || 'Error desconocido en la comunicación IPC';
      onLog(`Error al guardar token Cloudflare: ${errMsg}`, 'error', 'config');
      console.error('[CF-TOKEN-UI] Error en catch:', err?.stack || err);
    } finally {
      setSavingCfToken(false);
    }
  }, [cfTokenInput, setCloudflareToken, getCloudflareToken, onLog]);

  const handleSaveCfAccountId = useCallback(async () => {
    const api = (window as any).api;
    const trimmed = cfAccountIdInput.trim();
    if (!trimmed) {
      onLog('No se puede guardar un Account ID vacío.', 'warning', 'config');
      return;
    }
    setSavingCfAccountId(true);
    try {
      const result = await api?.invoke('config:set-cloudflare-account-id', { accountId: trimmed });
      if (result?.success) {
        toast.success('Cloudflare Account ID guardado.');
        onLog('[CONFIG] Cloudflare Account ID actualizado.', 'success', 'config');
      } else {
        const errMsg = result?.error || 'Error desconocido';
        onLog(`Error al guardar Account ID: ${errMsg}`, 'error', 'config');
        toast.error(errMsg);
      }
    } catch (err: any) {
      onLog(`Error al guardar Account ID: ${err?.message}`, 'error', 'config');
      toast.error(err?.message || 'Error inesperado');
    } finally {
      setSavingCfAccountId(false);
    }
  }, [cfAccountIdInput, onLog, toast]);

  const handleSaveGhToken = useCallback(async () => {
    const api = (window as any).api;
    const trimmed = ghTokenInput.trim();
    if (!trimmed) {
      onLog('No se puede guardar un token GitHub vacío.', 'warning', 'config');
      return;
    }
    setSavingGhToken(true);
    try {
      const result = await api?.invoke('config:set-github-token', { token: trimmed });
      if (result?.success) {
        const fresh = await api?.invoke('config:get-github-token');
        if (fresh?.success) setGhTokenDisplay(fresh.obfuscated || '');
        toast.success('GitHub API Token guardado.');
        onLog('[CONFIG] GitHub API Token actualizado y guardado.', 'success', 'config');
      } else {
        const errMsg = result?.error || 'Error desconocido';
        onLog(`Error al guardar GitHub token: ${errMsg}`, 'error', 'config');
        toast.error(errMsg);
      }
    } catch (err: any) {
      onLog(`Error al guardar GitHub token: ${err?.message}`, 'error', 'config');
      toast.error(err?.message || 'Error inesperado');
    } finally {
      setSavingGhToken(false);
    }
  }, [ghTokenInput, onLog, toast]);

  const handleSaveSslEmail = useCallback(async () => {
    const api = (window as any).api;
    const trimmed = sslEmailInput.trim();
    setSavingSslEmail(true);
    try {
      const result = await api?.invoke('config:set-ssl-email', { email: trimmed });
      if (result?.success) {
        toast.success('Email SSL guardado correctamente.');
        onLog('[CONFIG] Email para SSL actualizado.', 'success', 'config');
      } else {
        const errMsg = result?.error || 'Error desconocido';
        onLog(`Error al guardar Email SSL: ${errMsg}`, 'error', 'config');
        toast.error(errMsg);
      }
    } catch (err: any) {
      onLog(`Error al guardar Email SSL: ${err?.message}`, 'error', 'config');
      toast.error(err?.message || 'Error inesperado');
    } finally {
      setSavingSslEmail(false);
    }
  }, [sslEmailInput, onLog, toast]);

  const handleSaveMasterPassword = useCallback(async () => {
    const api = (window as any).api;
    const trimmed = masterPasswordInput.trim();
    if (!trimmed) {
      onLog('No se puede guardar una contraseña vacía.', 'warning', 'config');
      return;
    }
    setSavingMasterPassword(true);
    try {
      const result = await api?.invoke('correo:contrasena:guardar', { password: trimmed });
      if (result?.exito) {
        setHasMasterPassword(true);
        setMasterPasswordInput('');
        toast.success('Contraseña Maestra guardada correctamente.');
        onLog('[CONFIG] Contraseña Maestra de Correos actualizada.', 'success', 'config');
      } else {
        const errMsg = result?.error || 'Error desconocido';
        onLog(`Error al guardar Contraseña Maestra: ${errMsg}`, 'error', 'config');
        toast.error(errMsg);
      }
    } catch (err: any) {
      onLog(`Error al guardar Contraseña Maestra: ${err?.message}`, 'error', 'config');
      toast.error(err?.message || 'Error inesperado');
    } finally {
      setSavingMasterPassword(false);
    }
  }, [masterPasswordInput, onLog, toast]);

  // 🔥 HOTFIX v1.6.0: Generate ED25519 SSH key
  const handleGenerateKey = useCallback(async () => {
    setGeneratingKey(true);
    try {
      const result = await generateSshKey();
      if (result.success) {
        toast.success(`Llave generada exitosamente en ${result.path || '~/.ssh/id_ed25519'}`);
        onLog(`Llave SSH generada: ${result.path || '~/.ssh/id_ed25519'}`, 'success', 'config');
        // Auto-discovery: recargar config para que la UI detecte la nueva llave
        await loadConfig();
      } else {
        const errMsg = result.error || 'Error desconocido';
        if (errMsg.includes('YA_EXISTE')) {
          toast.info('Ya existe una llave SSH en ~/.ssh/id_ed25519. No se sobrescribe.');
          onLog('Ya existe una llave SSH. No se sobrescribe por seguridad.', 'warning', 'config');
        } else if (errMsg.includes('SSH_KEYGEN_NOT_FOUND')) {
          toast.error('ssh-keygen no está disponible. Instale OpenSSH Client.');
          onLog(`ssh-keygen no disponible: ${errMsg}`, 'error', 'config');
        } else {
          toast.error(`Error: ${errMsg}`);
          onLog(`Error al generar llave SSH: ${errMsg}`, 'error', 'config');
        }
      }
    } catch (err: any) {
      toast.error(`Error inesperado: ${err.message}`);
      onLog(`Error inesperado al generar llave SSH: ${err.message}`, 'error', 'config');
    } finally {
      setGeneratingKey(false);
    }
  }, [generateSshKey, onLog, toast, loadConfig]);

  // Abre el selector de carpeta nativo y actualiza la ruta de respaldos
  const handleChangeFolder = useCallback(async () => {
    const api = (window as any).api;
    if (!api) return;
    setChangingFolder(true);
    try {
      // Abrir el diálogo de carpeta nativo
      const dialogResult = await api.invoke('dialog:open-directory', {
        title: 'Seleccionar directorio de respaldos',
        defaultPath: workspacePath || undefined,
      });

      if (!dialogResult.success) {
        if (!dialogResult.canceled) {
          const errMsg = dialogResult.error || 'La ruta seleccionada no es válida';
          onLog(`[CONFIG] Error al seleccionar carpeta: ${errMsg}`, 'error', 'config');
          toast.error(errMsg);
        }
        return;
      }

      // Guardar la nueva ruta como workspace (respaldos se calcula automáticamente dentro)
      const setResult = await api.invoke('workspace:set-path', { workspacePath: dialogResult.path });
      if (setResult.success) {
        setWorkspacePath(setResult.workspacePath);
        // Recargar el respaldosPath actualizado
        const wpResult = await api.invoke('workspace:get-path');
        if (wpResult?.success) setRespaldosPath(wpResult.respaldosPath || '');
        onLog(`[CONFIG] Directorio de respaldos actualizado: ${setResult.workspacePath}`, 'success', 'config');
        toast.success('Directorio de respaldos actualizado correctamente.');
      } else {
        onLog(`[CONFIG] Error al guardar ruta: ${setResult.error}`, 'error', 'config');
        toast.error(`Error al guardar: ${setResult.error || 'Error desconocido'}`);
      }
    } catch (err: any) {
      onLog(`[CONFIG] Error inesperado al cambiar carpeta: ${err.message}`, 'error', 'config');
      toast.error(`Error inesperado: ${err.message}`);
    } finally {
      setChangingFolder(false);
    }
  }, [workspacePath, onLog, toast]);


  const accountCount = config?.accounts?.length || 0;
  const serverCount = config?.destinationServers?.length || 0;
  const cloudCount = config?.accounts?.reduce((t: number, a: any) => t + (a.originClouds?.length || 0), 0) || 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-xl font-bold">Configuración</h1>
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            Cuentas, servidores y estructura del workspace
          </p>
        </div>
      </div>

      <div className="flex gap-4 text-sm" style={{ color: 'var(--text-muted)' }}>
        <span>{accountCount} cuentas</span>
        <span aria-hidden="true">·</span>
        <span>{serverCount} servidores</span>
        <span aria-hidden="true">·</span>
        <span>{cloudCount} clouds</span>
      </div>

      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-display text-base font-bold">Escanear estructura local</h2>
          <button
            onClick={handleScan}
            disabled={scanning}
            className="btn btn--primary text-xs"
          >
            {scanning ? (
              <span className="flex items-center gap-2">
                <span className="spinner" />
                Escaneando...
              </span>
            ) : (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                Escanear workspace
              </>
            )}
          </button>
        </div>

        <div className="card overflow-hidden">
          <div className="px-4 py-3 text-xs" style={{ color: 'var(--text-muted)', backgroundColor: 'var(--surface-base)' }}>
            {config?.workspaceRoot
              ? `Ruta del workspace: ${config.workspaceRoot}`
              : 'No hay ruta de workspace configurada. Configure workspaceRoot en config.json.'}
          </div>

          {scanResult && (
            <div className="border-t" style={{ borderTopColor: 'var(--border-default)' }}>
              {scanResult.accounts && scanResult.accounts.length > 0 ? (
                <div className="divide-y" style={{ borderTopColor: 'var(--border-default)' }}>
                  {scanResult.accounts.map((account) => (
                    <div key={account.name} className="px-4 py-3">
                      <div className="font-medium text-sm mb-2">{account.name}</div>
                      {account.clouds && account.clouds.length > 0 ? (
                        <div className="space-y-1.5">
                          {account.clouds.map((cloud) => (
                            <div
                              key={cloud.name}
                              className="flex items-center justify-between py-1.5 px-3 rounded text-xs"
                              style={{ backgroundColor: 'var(--surface-overlay)' }}
                            >
                              <span className="font-medium">{cloud.name}</span>
                              <span style={{ color: 'var(--text-muted)' }}>
                                {cloud.domains.length} dominios
                              </span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                          Sin clouds
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="px-4 py-8 text-center text-xs" style={{ color: 'var(--text-muted)' }}>
                  No se encontraron cuentas en el workspace local.
                  <br />
                  Los respaldos deben estar en <code className="font-mono rounded px-1" style={{ backgroundColor: 'oklch(0 0 0 / 0.3)' }}>respaldos/&lt;cuenta&gt;/&lt;cloud&gt;/</code>
                </div>
              )}
            </div>
          )}
        </div>
      </section>

      <section>
        <h2 className="font-display text-base font-bold mb-4">Cuentas configuradas</h2>
        <div className="card overflow-hidden">
          {config?.accounts && config.accounts.length > 0 ? (
            <div className="divide-y" style={{ borderTopColor: 'var(--border-default)' }}>
              {config.accounts.map((account: any) => (
                <div key={account.name} className="px-4 py-3">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-sm">{account.name}</span>
                    <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      {(account.originClouds || []).length} clouds
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="px-4 py-8 text-center text-xs" style={{ color: 'var(--text-muted)' }}>
              No hay cuentas configuradas. Agregue servidores o clouds desde el Panel principal para crear la primera cuenta automáticamente.
            </div>
          )}
        </div>
      </section>

      <section>
        <h2 className="font-display text-base font-bold mb-4">Directorio de Respaldos</h2>
        <div className="card p-5">
          <div className="flex flex-col gap-3">
            <div className="flex-1">
              <p className="text-xs font-medium mb-1" style={{ color: 'var(--text-muted)' }}>
                Ruta del workspace (carpeta raíz)
              </p>
              <p
                className="text-xs font-mono truncate"
                style={{
                  color: workspacePath ? 'var(--text-secondary)' : 'var(--text-muted)',
                  padding: '6px 8px',
                  background: 'var(--surface-base)',
                  borderRadius: '4px',
                  border: '1px solid var(--border-default)',
                }}
                title={workspacePath || ''}
              >
                {workspacePath || 'No configurado'}
              </p>
            </div>

            {respaldosPath && (
              <div>
                <p className="text-xs font-medium mb-1" style={{ color: 'var(--text-muted)' }}>
                  Carpeta de respaldos detectada
                </p>
                <p
                  className="text-xs font-mono truncate"
                  style={{
                    color: 'var(--text-muted)',
                    padding: '6px 8px',
                    background: 'var(--surface-base)',
                    borderRadius: '4px',
                    border: '1px solid var(--border-default)',
                  }}
                  title={respaldosPath}
                >
                  {respaldosPath}
                </p>
                <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
                  Estructura esperada: <code className="font-mono">respaldos/&lt;cuenta&gt;/&lt;cloud&gt;/</code>
                </p>
              </div>
            )}

            <button
              onClick={handleChangeFolder}
              disabled={changingFolder}
              className="btn btn--secondary text-xs flex items-center gap-2 self-start"
            >
              {changingFolder ? (
                <><span className="spinner" /> Seleccionando...</>             
              ) : (
                <>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                  </svg>
                  Cambiar carpeta...
                </>
              )}
            </button>
          </div>
        </div>
      </section>

      {/* 🔥 HOTFIX v1.6.0: Sección de llaves SSH con botón de generación */}
      <section>
        <h2 className="font-display text-base font-bold mb-4">Llaves SSH</h2>
        <div className="card p-5">
          <div className="flex flex-col md:flex-row md:items-center gap-4">
            <div className="flex-1">
              <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                {config?.sshKeys?.publicKeyPath || config?.sshKeys?.privateKeyPath
                  ? `Llave actual: ${config.sshKeys.privateKeyPath || config.sshKeys.publicKeyPath || '~/.ssh/id_ed25519'}`
                  : 'No hay llave SSH configurada. Genere una nueva para comenzar.'}
              </p>
              <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                Se generará una llave ED25519 sin passphrase en ~/.ssh/id_ed25519
              </p>
            </div>
            <button
              onClick={handleGenerateKey}
              disabled={generatingKey}
              className="btn btn--primary text-xs flex-shrink-0"
            >
              {generatingKey ? (
                <span className="flex items-center gap-2">
                  <span className="spinner" />
                  Generando...
                </span>
              ) : (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                    <path d="M7 11V7a5 5 0 0110 0v4" />
                  </svg>
                  Generar nueva llave SSH
                </>
              )}
            </button>
          </div>
        </div>
      </section>

      <section>
        <h2 className="font-display text-base font-bold mb-4">Integraciones Externas</h2>
        <div className="card p-5 space-y-5">

          {/* ── Cloudflare API Token ── */}
          <div className="flex flex-col md:flex-row md:items-end gap-4">
            <div className="flex-1">
              <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                Cloudflare API Token
              </label>
              <input
                type="password"
                value={cfTokenInput}
                onChange={e => setCfTokenInput(e.target.value)}
                placeholder={
                  cfTokenDisplay
                    ? `Token guardado: ${cfTokenDisplay}`
                    : 'Ingrese el API Token de Cloudflare'
                }
                className="input font-mono text-xs"
                style={{ width: '100%' }}
              />
              {cfTokenDisplay && (
                <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                  Token actual: {cfTokenDisplay}
                </p>
              )}
            </div>
            <button
              onClick={handleSaveCfToken}
              disabled={savingCfToken || !cfTokenInput.trim()}
              className="btn btn--primary text-xs flex-shrink-0"
            >
              {savingCfToken ? (
                <span className="flex items-center gap-2"><span className="spinner" />Guardando...</span>
              ) : (
                'Guardar'
              )}
            </button>
          </div>

          <div className="flex flex-col md:flex-row md:items-end gap-4 mt-4">
            <div className="flex-1">
              <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                Cloudflare Account ID
                <span className="ml-2 text-xs font-normal" style={{ color: 'var(--text-muted)' }}>
                  (requerido para crear zonas nuevas)
                </span>
              </label>
              <input
                type="text"
                value={cfAccountIdInput}
                onChange={e => setCfAccountIdInput(e.target.value)}
                placeholder="Ej. 1a2b3c4d5e6f7g8h9i0j..."
                className="input font-mono text-xs"
                style={{ width: '100%' }}
              />
            </div>
            <button
              onClick={handleSaveCfAccountId}
              disabled={savingCfAccountId || !cfAccountIdInput.trim()}
              className="btn btn--primary text-xs flex-shrink-0"
            >
              {savingCfAccountId ? (
                <span className="flex items-center gap-2"><span className="spinner" />Guardando...</span>
              ) : (
                'Guardar'
              )}
            </button>
          </div>

          {/* ── Separador ── */}
          <div style={{ borderTop: '1px solid var(--border-default)' }} />

          {/* ── GitHub API Token ── */}
          <div className="flex flex-col md:flex-row md:items-end gap-4">
            <div className="flex-1">
              <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                GitHub API Token
                <span className="ml-2 text-xs font-normal" style={{ color: 'var(--text-muted)' }}>
                  (requerido por ScalifyLabs)
                </span>
              </label>
              <input
                id="config-github-token"
                type="password"
                value={ghTokenInput}
                onChange={e => setGhTokenInput(e.target.value)}
                placeholder={
                  ghTokenDisplay
                    ? `Token guardado: ${ghTokenDisplay}`
                    : 'ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
                }
                className="input font-mono text-xs"
                style={{ width: '100%' }}
              />
              {ghTokenDisplay && (
                <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                  Token actual: {ghTokenDisplay}
                </p>
              )}
              <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                Necesita scope <code className="font-mono px-1 rounded" style={{ backgroundColor: 'oklch(0 0 0 / 0.3)' }}>write:public_key</code> para registrar deploy keys en GitHub.
              </p>
            </div>
            <button
              onClick={handleSaveGhToken}
              disabled={savingGhToken || !ghTokenInput.trim()}
              className="btn btn--primary text-xs flex-shrink-0"
            >
              {savingGhToken ? (
                <span className="flex items-center gap-2"><span className="spinner" />Guardando...</span>
              ) : (
                'Guardar'
              )}
            </button>
          </div>

          {/* ── Separador ── */}
          <div style={{ borderTop: '1px solid var(--border-default)' }} />

          {/* ── Certificados SSL ── */}
          <div className="flex flex-col md:flex-row md:items-end gap-4">
            <div className="flex-1">
              <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                Email para certificados SSL
                <span className="ml-2 text-xs font-normal" style={{ color: 'var(--text-muted)' }}>
                  (alertas de caducidad de Let's Encrypt)
                </span>
              </label>
              <input
                type="email"
                value={sslEmailInput}
                onChange={e => setSslEmailInput(e.target.value)}
                placeholder="admin@ejemplo.com"
                className="input font-mono text-xs"
                style={{ width: '100%' }}
              />
              <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                Let's Encrypt enviará alertas de renovación a este correo. Requerido para emisión de certificados SSL.
              </p>
            </div>
            <button
              onClick={handleSaveSslEmail}
              disabled={savingSslEmail}
              className="btn btn--primary text-xs flex-shrink-0"
            >
              {savingSslEmail ? (
                <span className="flex items-center gap-2"><span className="spinner" />Guardando...</span>
              ) : (
                'Guardar'
              )}
            </button>
          </div>

          {/* ── Separador ── */}
          <div style={{ borderTop: '1px solid var(--border-default)' }} />

          {/* ── Contraseña Maestra de Correos ── */}
          <div className="flex flex-col md:flex-row md:items-end gap-4">
            <div className="flex-1">
              <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                Contraseña Maestra de Correos
                <span className="ml-2 text-xs font-normal" style={{ color: 'var(--text-muted)' }}>
                  (creación automática de buzones info@)
                </span>
              </label>
              <input
                type="password"
                value={masterPasswordInput}
                onChange={e => setMasterPasswordInput(e.target.value)}
                placeholder={hasMasterPassword ? "•••••••• (Contraseña almacenada en el sistema)" : "Ingrese contraseña maestra"}
                className="input font-mono text-xs"
                style={{ width: '100%' }}
              />
              {hasMasterPassword && (
                <p className="mt-1 text-xs text-emerald-400">
                  Contraseña almacenada en el sistema
                </p>
              )}
              <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                Esta contraseña se usará para crear o actualizar el correo info@dominio.com en las configuraciones automáticas. Se almacena de forma segura en el sistema.
              </p>
            </div>
            <button
              onClick={handleSaveMasterPassword}
              disabled={savingMasterPassword || !masterPasswordInput.trim()}
              className="btn btn--primary text-xs flex-shrink-0"
            >
              {savingMasterPassword ? (
                <span className="flex items-center gap-2"><span className="spinner" />Guardando...</span>
              ) : (
                'Guardar'
              )}
            </button>
          </div>

        </div>
      </section>
    </div>
  );
};

export default ConfigPanel;
