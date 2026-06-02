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
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-start justify-between">
          <div>
            <h1 className="font-display text-xl font-bold flex items-center gap-2">
              <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 6, backgroundColor: 'var(--color-error-bg)', color: 'var(--color-error)' }}>
                <IconShield />
              </span>
              Seguridad
            </h1>
            <p className="text-sm mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Administración avanzada — acceso restringido
            </p>
          </div>
        </div>

        {/* Auth card */}
        <div className="card p-6 space-y-4" style={{ maxWidth: 420, margin: '0 auto' }}>
          <div className="text-center space-y-1">
            <div style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 48, height: 48, borderRadius: 12, backgroundColor: 'var(--color-error-bg)', color: 'var(--color-error)', marginBottom: 8 }}>
              <IconShield />
            </div>
            <h2 className="font-display text-base font-bold">Autenticación requerida</h2>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              Esta sección contiene operaciones destructivas. Ingresá la contraseña de administrador para continuar.
            </p>
          </div>

          <div>
            <label htmlFor="security-password" className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
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
              className="input font-mono text-sm"
              style={{ width: '100%' }}
              autoFocus
            />
            {authError && (
              <p className="text-xs mt-1.5" style={{ color: 'var(--color-error)' }}>
                {authError}
              </p>
            )}
          </div>

          <button
            id="security-auth-btn"
            onClick={handleAuth}
            disabled={!passwordInput.trim() || validating}
            className="btn btn--primary text-sm w-full"
          >
            {validating ? <><span className="spinner" /> Verificando...</> : 'Acceder'}
          </button>
        </div>
      </div>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // ── RENDER: Panel de control ─────────────────────────────────────────────────
  // ─────────────────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="font-display text-xl font-bold flex items-center gap-2">
            <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 6, backgroundColor: 'var(--color-error-bg)', color: 'var(--color-error)' }}>
              <IconShield />
            </span>
            Seguridad
          </h1>
          <p className="text-sm mt-0.5" style={{ color: 'var(--text-muted)' }}>
            Administración avanzada — sesión activa
          </p>
        </div>
        <button
          onClick={() => {
            setAuthenticated(false);
            passwordRef.current = ''; // Limpiar en logout
          }}
          className="btn btn--ghost text-xs"
          style={{ color: 'var(--text-muted)' }}
        >
          Cerrar sesión
        </button>
      </div>

      {/* Selector de servidor */}
      <section>
        <h2 className="font-display text-base font-bold mb-3">Servidor destino</h2>
        <div className="card p-4">
          {servidores.length > 0 ? (
            <select
              value={serverName}
              onChange={e => setServerName(e.target.value)}
              className="input text-sm"
              style={{ width: '100%', fontFamily: 'var(--font-mono)' }}
            >
              {servidores.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          ) : (
            <p className="text-xs py-2 px-3 rounded" style={{ color: 'var(--color-warning)', backgroundColor: 'var(--color-warning-bg)', border: '1px solid var(--color-warning)' }}>
              No hay servidores configurados.
            </p>
          )}
        </div>
      </section>

      {/* Controles de energía */}
      <section>
        <h2 className="font-display text-base font-bold mb-3 flex items-center gap-2">
          <span style={{ color: 'var(--text-muted)' }}><IconPower /></span>
          Control de energía
        </h2>
        <div className="card p-4 space-y-3">
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            Estas acciones son inmediatas e irreversibles. El servidor tardará algunos minutos en volver a estar disponible.
          </p>
          <div className="flex items-center gap-3">
            {/* Reboot */}
            <button
              id="security-btn-reboot"
              onClick={handleReboot}
              disabled={!serverName || rebooting}
              className="btn text-xs flex items-center gap-2"
              style={{
                backgroundColor: rebootConfirm ? 'var(--color-warning)' : 'var(--color-warning-bg)',
                color: rebootConfirm ? 'var(--surface-base)' : 'var(--color-warning)',
                border: '1px solid var(--color-warning)',
              }}
            >
              {rebooting ? <><span className="spinner" />Reiniciando...</> : rebootConfirm ? 'Confirmar Reboot' : <><IconPower />Reboot</>}
            </button>
            {rebootConfirm && (
              <button onClick={() => setRebootConfirm(false)} className="btn btn--ghost text-xs" style={{ color: 'var(--text-muted)' }}>
                Cancelar
              </button>
            )}

            {/* Shutdown */}
            <button
              id="security-btn-shutdown"
              onClick={handleShutdown}
              disabled={!serverName || shuttingDown}
              className="btn text-xs flex items-center gap-2"
              style={{
                backgroundColor: shutdownConfirm ? 'var(--color-error)' : 'var(--color-error-bg)',
                color: shutdownConfirm ? 'white' : 'var(--color-error)',
                border: '1px solid var(--color-error)',
              }}
            >
              {shuttingDown ? <><span className="spinner" />Apagando...</> : shutdownConfirm ? 'Confirmar Shutdown' : <><IconPower />Shutdown</>}
            </button>
            {shutdownConfirm && (
              <button onClick={() => setShutdownConfirm(false)} className="btn btn--ghost text-xs" style={{ color: 'var(--text-muted)' }}>
                Cancelar
              </button>
            )}
          </div>
        </div>
      </section>

      {/* Credential Reset Masivo */}
      <section>
        <h2 className="font-display text-base font-bold mb-3 flex items-center gap-2">
          <span style={{ color: 'var(--text-muted)' }}><IconKey /></span>
          Reset masivo de credenciales WordPress
        </h2>
        <div className="card p-4 space-y-4">
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            Actualiza <code className="font-mono px-1 rounded" style={{ backgroundColor: 'oklch(0 0 0 / 0.3)' }}>wp_users.user_pass</code> en todas las instalaciones WordPress del servidor para el usuario especificado. Usa MD5 (estándar de WordPress).
          </p>

          <div className="grid gap-3" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <div>
              <label htmlFor="security-wp-user" className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                Usuario WordPress
              </label>
              <input
                id="security-wp-user"
                type="text"
                value={wpUsername}
                onChange={e => setWpUsername(e.target.value)}
                disabled={resetRunning}
                placeholder="dev"
                className="input font-mono text-sm"
                style={{ width: '100%' }}
              />
            </div>
            <div>
              <label htmlFor="security-wp-pass" className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                Nueva contraseña
              </label>
              <input
                id="security-wp-pass"
                type="password"
                value={wpNewPassword}
                onChange={e => setWpNewPassword(e.target.value)}
                disabled={resetRunning}
                placeholder="••••••••"
                className="input font-mono text-sm"
                style={{ width: '100%' }}
              />
            </div>
          </div>

          <button
            id="security-btn-credential-reset"
            onClick={handleCredentialReset}
            disabled={!serverName || !wpUsername || !wpNewPassword || resetRunning}
            className="btn btn--primary text-xs flex items-center gap-2"
          >
            {resetRunning
              ? <><span className="spinner" />Reseteando contraseñas...</>
              : <><IconKey />Ejecutar Reset Masivo</>
            }
          </button>

          {/* Progreso del reset */}
          {(resetProgress.length > 0 || resetResult) && (
            <div className="mt-2">
              <div
                className="rounded overflow-y-auto scrollbar-thin"
                style={{ maxHeight: 240, backgroundColor: 'oklch(0.12 0.008 250)', fontFamily: 'var(--font-mono)', fontSize: '0.7rem' }}
              >
                <div
                  className="px-3 py-2 border-b text-xs"
                  style={{ borderBottomColor: 'var(--border-default)', color: 'var(--text-muted)', backgroundColor: 'oklch(0.15 0.01 250)' }}
                >
                  Progreso del reset — {serverName}
                </div>
                <div className="p-3 space-y-0.5">
                  {resetProgress.filter(ev => ev.phase === 'done').map((ev, idx) => (
                    <div
                      key={idx}
                      style={{
                        color: ev.success ? 'var(--color-success)' : 'var(--color-error)',
                        lineHeight: 1.6,
                      }}
                    >
                      {ev.success ? '✓' : '✗'} {ev.db}
                      {!ev.success && ev.output && (
                        <span style={{ color: 'var(--color-error)', opacity: 0.7 }}> — {ev.output.slice(0, 80)}</span>
                      )}
                    </div>
                  ))}
                  {resetRunning && resetProgress.length > 0 && (
                    <div style={{ color: 'var(--color-accent)', lineHeight: 1.6 }}>
                      ⟳ Procesando... ({resetProgress.filter(e => e.phase === 'done').length}/{resetProgress[resetProgress.length - 1]?.total || '?'})
                    </div>
                  )}
                  <div ref={progressEndRef} />
                </div>
              </div>

              {/* Resumen final */}
              {resetResult && (
                <div
                  className="mt-2 px-3 py-2 rounded text-xs"
                  style={{
                    backgroundColor: resetResult.errors.length === 0 ? 'var(--color-success-bg)' : 'var(--color-warning-bg)',
                    border: `1px solid ${resetResult.errors.length === 0 ? 'var(--color-success)' : 'var(--color-warning)'}`,
                    color: resetResult.errors.length === 0 ? 'var(--color-success)' : 'var(--color-warning)',
                  }}
                >
                  Reset completado: {resetResult.updated}/{resetResult.total} bases de datos actualizadas.
                  {resetResult.errors.length > 0 && ` ${resetResult.errors.length} errores.`}
                </div>
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  );
};

export default SecurityModule;
