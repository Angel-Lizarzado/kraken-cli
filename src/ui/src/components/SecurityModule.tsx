import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useToast } from './Toast';

// ── Tipos ────────────────────────────────────────────────────────────────────

interface CredentialProgressEvent {
  db: string;
  index: number;
  total: number;
  phase: 'resetting' | 'done';
  success: boolean | null;
  output: string;
}

interface SecurityModuleProps {
  onLog: (message: string, type: 'info' | 'warning' | 'error' | 'success', moduleId?: string) => void;
  logs?: { message: string; type: string; timestamp?: number; source?: string }[];
}

// ── Iconos ────────────────────────────────────────────────────────────────────

const IconShield = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
  </svg>
);

const IconPower = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
    <line x1="12" y1="2" x2="12" y2="12" />
  </svg>
);

const IconKey = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
  </svg>
);

// ── Componente principal ──────────────────────────────────────────────────────

const SecurityModule: React.FC<SecurityModuleProps> = ({ onLog }) => {
  const toast = useToast();
  const api = (window as any).api;

  // ── Estado de auth ──────────────────────────────────────────────────────────
  const [authenticated, setAuthenticated] = useState(false);
  const [passwordInput, setPasswordInput] = useState('');
  const [authError, setAuthError] = useState('');
  const [validating, setValidating] = useState(false);
  // Contraseña autenticada en ref — no en state (evita DevTools exposure y re-renders)
  const passwordRef = useRef<string>('');

  // ── Selección de servidor ──────────────────────────────────────────────────
  const [servidores, setServidores] = useState<string[]>([]);
  const [serverName, setServerName] = useState('');

  // ── Estado de operaciones ─────────────────────────────────────────────────
  const [rebootConfirm, setRebootConfirm] = useState(false);
  const [shutdownConfirm, setShutdownConfirm] = useState(false);
  const [rebooting, setRebooting] = useState(false);
  const [shuttingDown, setShuttingDown] = useState(false);

  // ── Credential reset ─────────────────────────────────────────────────────
  const [wpUsername, setWpUsername] = useState('dev');
  const [wpNewPassword, setWpNewPassword] = useState('');
  const [resetRunning, setResetRunning] = useState(false);
  const [resetProgress, setResetProgress] = useState<CredentialProgressEvent[]>([]);
  const [resetResult, setResetResult] = useState<{ total: number; updated: number; errors: string[] } | null>(null);
  const progressEndRef = useRef<HTMLDivElement>(null);

  // ── Cargar servidores ──────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const cfg = await api?.invoke('config:get');
        const destinos: string[] = (cfg?.destinationServers || []).map((s: any) => s.name).filter(Boolean);
        setServidores(destinos);
        if (destinos.length > 0) setServerName(destinos[0]);
      } catch { /* silencioso */ }
    })();
  }, []);

  // ── Escuchar progreso de credential reset ─────────────────────────────────
  useEffect(() => {
    if (!authenticated) return;

    const handler = (ev: CredentialProgressEvent) => {
      setResetProgress(prev => [...prev, ev]);
      progressEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    };

    api?.receive('security:credential-progress', handler);
    return () => api?.removeListener('security:credential-progress', handler);
  }, [authenticated]);

  // ── Autenticación ──────────────────────────────────────────────────────────
  const handleAuth = useCallback(async () => {
    if (!passwordInput.trim() || validating) return;
    setValidating(true);
    setAuthError('');

    try {
      const result = await api?.invoke('security:validate-password', { password: passwordInput });
      if (result?.success) {
        passwordRef.current = passwordInput; // Guardar para operaciones subsiguientes
        setAuthenticated(true);
        setPasswordInput('');
        toast.success('Acceso autorizado.');
      } else {
        setAuthError('Contraseña incorrecta. Acceso denegado.');
        setPasswordInput('');
      }
    } catch (err: any) {
      setAuthError('Error de comunicación con el módulo de seguridad.');
    } finally {
      setValidating(false);
    }
  }, [passwordInput, validating, api, toast]);

  // ── Reboot ─────────────────────────────────────────────────────────────────
  const handleReboot = useCallback(async () => {
    if (!serverName || rebooting) return;
    if (!rebootConfirm) { setRebootConfirm(true); return; }

    setRebooting(true);
    setRebootConfirm(false);
    try {
      const result = await api?.invoke('security:reboot', { serverName, password: passwordRef.current });
      if (result?.success) {
        toast.success(`Reboot iniciado en "${serverName}".`);
        onLog(`[SECURITY] Reboot ejecutado en "${serverName}".`, 'warning', 'security');
      } else {
        toast.error(result?.error || 'Error al reiniciar el servidor.');
      }
    } catch (err: any) {
      toast.error(err?.message || 'Error IPC.');
    } finally {
      setRebooting(false);
    }
  }, [serverName, rebooting, rebootConfirm, api, toast, onLog]);

  // ── Shutdown ──────────────────────────────────────────────────────────────
  const handleShutdown = useCallback(async () => {
    if (!serverName || shuttingDown) return;
    if (!shutdownConfirm) { setShutdownConfirm(true); return; }

    setShuttingDown(true);
    setShutdownConfirm(false);
    try {
      const result = await api?.invoke('security:shutdown', { serverName, password: passwordRef.current });
      if (result?.success) {
        toast.success(`Shutdown iniciado en "${serverName}".`);
        onLog(`[SECURITY] Shutdown ejecutado en "${serverName}".`, 'warning', 'security');
      } else {
        toast.error(result?.error || 'Error al apagar el servidor.');
      }
    } catch (err: any) {
      toast.error(err?.message || 'Error IPC.');
    } finally {
      setShuttingDown(false);
    }
  }, [serverName, shuttingDown, shutdownConfirm, api, toast, onLog]);

  // ── Credential Reset ──────────────────────────────────────────────────────
  const handleCredentialReset = useCallback(async () => {
    if (!serverName || !wpUsername || !wpNewPassword || resetRunning) return;

    setResetRunning(true);
    setResetProgress([]);
    setResetResult(null);

    try {
      const result = await api?.invoke('security:credential-reset', {
        serverName,
        password: passwordRef.current,
        username: wpUsername,
        newPassword: wpNewPassword,
      });

      if (result?.success) {
        setResetResult({ total: result.total, updated: result.updated, errors: result.errors || [] });
        toast.success(`Reset completado: ${result.updated}/${result.total} bases de datos actualizadas.`);
        onLog(`[SECURITY] Credential reset: ${result.updated}/${result.total} BDs actualizadas.`, 'success', 'security');
      } else {
        toast.error(result?.error || 'Error en el reset masivo.');
        onLog(`[SECURITY] Error en credential reset: ${result?.error}`, 'error', 'security');
      }
    } catch (err: any) {
      toast.error(err?.message || 'Error IPC.');
    } finally {
      setResetRunning(false);
    }
  }, [serverName, wpUsername, wpNewPassword, resetRunning, api, toast, onLog]);

  // ─────────────────────────────────────────────────────────────────────────────
  // ── RENDER: Password Gate ────────────────────────────────────────────────────
  // ─────────────────────────────────────────────────────────────────────────────
  if (!authenticated) {
    return (
      <div className="flex flex-col h-full bg-background overflow-hidden">
        {/* ── Page Header ── */}
        <div className="flex-none px-lg pt-lg pb-md border-b border-outline-variant/30">
          <h2 className="font-display-lg text-display-lg text-secondary mb-xs flex items-center gap-sm">
            <span className="flex items-center justify-center w-8 h-8 rounded bg-error/10 text-error">
              <IconShield />
            </span>
            Seguridad
          </h2>
          <p className="font-body-md text-on-surface-variant max-w-2xl">
            Administración avanzada — acceso restringido
          </p>
        </div>

        <div className="flex-1 overflow-y-auto px-lg pb-lg mt-md flex flex-col justify-center items-center">
          {/* Auth card */}
          <div className="bg-surface-container-low border border-outline-variant p-xl rounded-md w-full max-w-md shadow-2xl">
            <div className="text-center space-y-xs mb-lg">
              <div className="mx-auto flex items-center justify-center w-12 h-12 rounded-lg bg-error/10 text-error mb-sm">
                <IconShield />
              </div>
              <h2 className="font-label-caps text-label-caps text-on-surface uppercase">Autenticación requerida</h2>
              <p className="font-body-sm text-on-surface-variant">
                Esta sección contiene operaciones destructivas. Ingresá la contraseña de administrador para continuar.
              </p>
            </div>

            <div className="space-y-sm">
              <label htmlFor="security-password" className="font-label-caps text-label-caps text-outline block">
                Contraseña de administrador
              </label>
              <input
                id="security-password"
                type="password"
                value={passwordInput}
                onChange={e => setPasswordInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleAuth()}
                disabled={validating}
                placeholder="••••••••••"
                className="w-full bg-surface-container border border-outline-variant text-on-surface focus:border-secondary focus:ring-1 focus:ring-secondary font-code-md rounded px-md py-sm transition-all text-center tracking-widest"
                autoFocus
              />
              {authError && (
                <p className="font-body-sm text-error text-center mt-xs animate-pulse-slow">
                  {authError}
                </p>
              )}
            </div>

            <button
              id="security-auth-btn"
              onClick={handleAuth}
              disabled={!passwordInput.trim() || validating}
              className={`mt-md w-full flex items-center justify-center gap-xs px-md py-sm font-title-sm rounded transition-all active:scale-95 ${(!passwordInput.trim() || validating) ? 'bg-surface-container-highest text-outline cursor-not-allowed' : 'bg-error text-white hover:bg-error/90 shadow-[0_0_15px_rgba(255,107,107,0.3)]'}`}
            >
              {validating ? <><span className="w-4 h-4 rounded-full border-2 border-white/50 border-t-white animate-spin shrink-0" /> Verificando...</> : 'Acceder'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // ── RENDER: Panel de control ─────────────────────────────────────────────────
  // ─────────────────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full bg-background overflow-hidden">
      {/* ── Page Header ── */}
      <div className="flex-none px-lg pt-lg pb-md border-b border-outline-variant/30 flex items-start justify-between">
        <div>
          <h2 className="font-display-lg text-display-lg text-secondary mb-xs flex items-center gap-sm">
            <span className="flex items-center justify-center w-8 h-8 rounded bg-error/10 text-error">
              <IconShield />
            </span>
            Seguridad
          </h2>
          <p className="font-body-md text-on-surface-variant max-w-2xl">
            Administración avanzada — sesión activa
          </p>
        </div>
        <button
          onClick={() => {
            setAuthenticated(false);
            passwordRef.current = ''; // Limpiar en logout
          }}
          className="font-label-caps text-label-caps text-outline hover:text-on-surface transition-colors uppercase"
        >
          Cerrar sesión
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-lg pb-lg mt-md">
        <div className="max-w-4xl mx-auto space-y-lg pb-24">

          {/* Selector de servidor */}
          <section>
            <h2 className="font-label-caps text-label-caps text-outline uppercase mb-sm">Servidor destino</h2>
            <div className="bg-surface-container-low border border-outline-variant p-md rounded">
              {servidores.length > 0 ? (
                <select
                  value={serverName}
                  onChange={e => setServerName(e.target.value)}
                  className="w-full bg-surface-container border border-outline-variant text-on-surface focus:border-secondary focus:ring-1 focus:ring-secondary font-code-md rounded px-sm py-sm"
                >
                  {servidores.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              ) : (
                <p className="font-body-sm text-warning bg-warning/10 border border-warning/20 py-sm px-md rounded">
                  No hay servidores configurados.
                </p>
              )}
            </div>
          </section>

          {/* Controles de energía */}
          <section>
            <h2 className="font-label-caps text-label-caps text-outline uppercase mb-sm flex items-center gap-xs">
              <span className="text-outline"><IconPower /></span>
              Control de energía
            </h2>
            <div className="bg-surface-container-low border border-outline-variant p-md rounded space-y-md">
              <p className="font-body-sm text-outline border-l-2 border-warning/50 pl-sm">
                Estas acciones son inmediatas e irreversibles. El servidor tardará algunos minutos en volver a estar disponible.
              </p>
              <div className="flex flex-wrap items-center gap-md">
                {/* Reboot */}
                <div className="flex items-center gap-sm">
                  <button
                    id="security-btn-reboot"
                    onClick={handleReboot}
                    disabled={!serverName || rebooting}
                    className={`flex items-center gap-xs px-md py-sm font-label-caps text-label-caps rounded transition-all active:scale-95 border ${rebootConfirm ? 'bg-warning text-black border-warning shadow-[0_0_15px_rgba(255,204,0,0.3)]' : 'bg-warning/10 text-warning border-warning/30 hover:bg-warning/20'} ${rebooting || !serverName ? 'opacity-50 cursor-not-allowed hover:bg-warning/10' : ''}`}
                  >
                    {rebooting ? <><span className="w-3 h-3 rounded-full border-2 border-current border-t-transparent animate-spin shrink-0" />Reiniciando...</> : rebootConfirm ? 'Confirmar Reboot' : <><IconPower />Reboot</>}
                  </button>
                  {rebootConfirm && (
                    <button onClick={() => setRebootConfirm(false)} className="font-label-caps text-label-caps text-outline hover:text-on-surface transition-colors uppercase">
                      Cancelar
                    </button>
                  )}
                </div>

                {/* Shutdown */}
                <div className="flex items-center gap-sm">
                  <button
                    id="security-btn-shutdown"
                    onClick={handleShutdown}
                    disabled={!serverName || shuttingDown}
                    className={`flex items-center gap-xs px-md py-sm font-label-caps text-label-caps rounded transition-all active:scale-95 border ${shutdownConfirm ? 'bg-error text-white border-error shadow-[0_0_15px_rgba(255,107,107,0.3)]' : 'bg-error/10 text-error border-error/30 hover:bg-error/20'} ${shuttingDown || !serverName ? 'opacity-50 cursor-not-allowed hover:bg-error/10' : ''}`}
                  >
                    {shuttingDown ? <><span className="w-3 h-3 rounded-full border-2 border-current border-t-transparent animate-spin shrink-0" />Apagando...</> : shutdownConfirm ? 'Confirmar Shutdown' : <><IconPower />Shutdown</>}
                  </button>
                  {shutdownConfirm && (
                    <button onClick={() => setShutdownConfirm(false)} className="font-label-caps text-label-caps text-outline hover:text-on-surface transition-colors uppercase">
                      Cancelar
                    </button>
                  )}
                </div>
              </div>
            </div>
          </section>

          {/* Credential Reset Masivo */}
          <section>
            <h2 className="font-label-caps text-label-caps text-outline uppercase mb-sm flex items-center gap-xs">
              <span className="text-outline"><IconKey /></span>
              Reset masivo de credenciales WordPress
            </h2>
            <div className="bg-surface-container-low border border-outline-variant p-md rounded space-y-md">
              <p className="font-body-sm text-outline border-l-2 border-error/50 pl-sm">
                Actualiza <code className="font-code-sm text-on-surface-variant bg-surface-container px-1 py-px rounded">wp_users.user_pass</code> en todas las instalaciones WordPress del servidor para el usuario especificado. Usa MD5 (estándar de WordPress).
              </p>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-md">
                <div className="space-y-xs">
                  <label htmlFor="security-wp-user" className="font-label-caps text-label-caps text-outline block">
                    Usuario WordPress
                  </label>
                  <input
                    id="security-wp-user"
                    type="text"
                    value={wpUsername}
                    onChange={e => setWpUsername(e.target.value)}
                    disabled={resetRunning}
                    placeholder="dev"
                    className="w-full bg-surface-container border border-outline-variant text-on-surface focus:border-error focus:ring-1 focus:ring-error font-code-md rounded px-sm py-sm"
                  />
                </div>
                <div className="space-y-xs">
                  <label htmlFor="security-wp-pass" className="font-label-caps text-label-caps text-outline block">
                    Nueva contraseña
                  </label>
                  <input
                    id="security-wp-pass"
                    type="password"
                    value={wpNewPassword}
                    onChange={e => setWpNewPassword(e.target.value)}
                    disabled={resetRunning}
                    placeholder="••••••••"
                    className="w-full bg-surface-container border border-outline-variant text-on-surface focus:border-error focus:ring-1 focus:ring-error font-code-md rounded px-sm py-sm tracking-widest"
                  />
                </div>
              </div>

              <button
                id="security-btn-credential-reset"
                onClick={handleCredentialReset}
                disabled={!serverName || !wpUsername || !wpNewPassword || resetRunning}
                className={`flex items-center gap-xs px-md py-sm font-title-sm rounded transition-all active:scale-95 ${(!serverName || !wpUsername || !wpNewPassword || resetRunning) ? 'bg-surface-container-highest text-outline cursor-not-allowed' : 'bg-error text-white hover:bg-error/90 shadow-[0_0_15px_rgba(255,107,107,0.3)]'}`}
              >
                {resetRunning
                  ? <><span className="w-4 h-4 rounded-full border-2 border-white/50 border-t-white animate-spin shrink-0" />Reseteando contraseñas...</>
                  : <><IconKey />Ejecutar Reset Masivo</>
                }
              </button>

              {/* Progreso del reset */}
              {(resetProgress.length > 0 || resetResult) && (
                <div className="mt-md border-t border-outline-variant/30 pt-md">
                  <div className="bg-black/40 border border-outline-variant/30 rounded flex flex-col h-[240px]">
                    <div className="flex-none px-sm py-xs bg-surface-container border-b border-outline-variant/30 font-label-caps text-label-caps text-outline flex items-center justify-between">
                      <span>Progreso del reset — {serverName}</span>
                      {resetRunning && <span className="flex items-center gap-1 text-tertiary"><span className="w-2 h-2 rounded-full bg-tertiary animate-pulse" />Procesando</span>}
                    </div>
                    <div className="flex-1 overflow-y-auto p-sm space-y-1 font-code-sm text-code-sm scrollbar-thin">
                      {resetProgress.filter(ev => ev.phase === 'done').map((ev, idx) => (
                        <div
                          key={idx}
                          className={ev.success ? 'text-green-400' : 'text-error'}
                        >
                          <span className="mr-2">{ev.success ? '✓' : '✗'}</span>{ev.db}
                          {!ev.success && ev.output && (
                            <span className="opacity-70"> — {ev.output.slice(0, 80)}</span>
                          )}
                        </div>
                      ))}
                      {resetRunning && resetProgress.length > 0 && (
                        <div className="text-tertiary animate-pulse">
                          ⟳ Procesando... ({resetProgress.filter(e => e.phase === 'done').length}/{resetProgress[resetProgress.length - 1]?.total || '?'})
                        </div>
                      )}
                      <div ref={progressEndRef} />
                    </div>
                  </div>

                  {/* Resumen final */}
                  {resetResult && (
                    <div
                      className={`mt-sm px-sm py-sm rounded border font-code-sm text-code-sm ${
                        resetResult.errors.length === 0 
                          ? 'bg-green-400/10 border-green-400/30 text-green-400' 
                          : 'bg-warning/10 border-warning/30 text-warning'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        {resetResult.errors.length === 0 ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="20 6 9 17 4 12" /></svg> : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>}
                        <span>
                          Reset completado: <strong>{resetResult.updated}</strong> de <strong>{resetResult.total}</strong> bases de datos actualizadas.
                          {resetResult.errors.length > 0 && ` ${resetResult.errors.length} errores.`}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
};

export default SecurityModule;
