import { useState, useEffect, useCallback, useRef } from 'react';

// ── Types ──────────────────────────────────────────────────────────────────────

type UpdateState =
  | { phase: 'idle' }
  | { phase: 'available'; version: string }
  | { phase: 'downloading'; percent: number }
  | { phase: 'ready'; version: string };

// ── UpdateNotifier ─────────────────────────────────────────────────────────────
// Escucha los eventos IPC del autoUpdater y presenta:
//   - Toast discreto (no bloqueante) para available + downloading
//   - Modal centrado para ready (con opción de instalar o posponer)
//   - [DEBUG] Logs en consola para TODOS los eventos del updater

export default function UpdateNotifier() {
  const [update, setUpdate] = useState<UpdateState>({ phase: 'idle' });
  const [toastVisible, setToastVisible] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const readyFired = useRef(false);

  const showToast = useCallback(() => {
    setToastVisible(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
  }, []);

  const scheduleToastHide = useCallback((ms = 6000) => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setToastVisible(false), ms);
  }, []);

  useEffect(() => {
    if (!window.electronAPI?.onEvent) return;

    // ── [DEBUG] Listeners para TODOS los eventos del updater ────────────────
    const cleanChecking = window.electronAPI.onEvent(
      'updater:checking',
      (payload: any) => {
        console.log('[DEBUG-UPDATER] ▶ checking-for-update', payload);
      }
    );

    const cleanNotAvailable = window.electronAPI.onEvent(
      'updater:not-available',
      (payload: any) => {
        console.log('[DEBUG-UPDATER] ✓ update-not-available', payload);
      }
    );

    const cleanError = window.electronAPI.onEvent(
      'updater:error',
      (payload: any) => {
        console.error('[DEBUG-UPDATER] ✗ error', payload);
      }
    );

    // ── update-available ──────────────────────────────────────────────────────
    const cleanAvailable = window.electronAPI.onEvent(
      'updater:update-available',
      (payload: any) => {
        console.log('[DEBUG-UPDATER] ⬇ update-available', payload);
        setUpdate({ phase: 'available', version: payload.version });
        setDismissed(false);
        showToast();
        scheduleToastHide(8000);
      }
    );

    // ── download-progress ─────────────────────────────────────────────────────
    const cleanProgress = window.electronAPI.onEvent(
      'updater:download-progress',
      (payload: any) => {
        console.log('[DEBUG-UPDATER] ⏳ download-progress', payload);
        setUpdate({
          phase: 'downloading',
          percent: payload.percent,
        });
        showToast();
        // No auto-ocultar mientras descarga
        if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      }
    );

    // ── update-downloaded ─────────────────────────────────────────────────────
    const cleanDownloaded = window.electronAPI.onEvent(
      'updater:update-downloaded',
      (payload: any) => {
        console.log('[DEBUG-UPDATER] ✔ update-downloaded', payload);
        setUpdate({ phase: 'ready', version: payload.version });
        setDismissed(false);
        setToastVisible(false);
        if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      }
    );

    // ── Señal al Main Process: el frontend ya tiene listeners activos ──────
    // Esto resuelve la race condition: el chequeo de actualizaciones
    // se dispara SOLO después de que este efecto se ejecuta.
    if (!readyFired.current) {
      readyFired.current = true;
      console.log('[DEBUG-UPDATER] Enviando app:frontend-ready al Main Process...');
      window.electronAPI.notifyFrontendReady?.();
    }

    return () => {
      cleanChecking();
      cleanNotAvailable();
      cleanError();
      cleanAvailable();
      cleanProgress();
      cleanDownloaded();
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, [showToast, scheduleToastHide]);

  const handleInstall = useCallback(() => {
    window.api?.send('updater:quit-and-install', undefined);
  }, []);

  const handleDismissModal = useCallback(() => {
    setDismissed(true);
  }, []);

  const handleDismissToast = useCallback(() => {
    setToastVisible(false);
  }, []);

  // Modal: solo cuando está ready Y no fue pospuesto
  const showModal = update.phase === 'ready' && !dismissed;

  // Toast: solo fases non-ready
  const showToastBar =
    toastVisible &&
    (update.phase === 'available' || update.phase === 'downloading');

  if (!showModal && !showToastBar) return null;

  return (
    <>
      {/* ── Toast discreto (bottom-right) ─────────────────────────────────── */}
      {showToastBar && (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: 'fixed',
            bottom: '24px',
            right: '24px',
            zIndex: 9000,
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            borderRadius: '8px',
            padding: '12px 14px',
            minWidth: '260px',
            maxWidth: '320px',
            animation: 'notifier-slide-in 150ms ease-out forwards',
          }}
          className="bg-surface-container border border-outline-variant"
        >
          {/* Header row */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span
              className="text-xs font-semibold text-on-surface"
              style={{ letterSpacing: '0.02em' }}
            >
              {update.phase === 'available'
                ? `Actualización disponible — v${update.version}`
                : 'Descargando actualización...'}
            </span>
            <button
              onClick={handleDismissToast}
              aria-label="Cerrar notificación"
              className="text-on-surface-variant hover:text-on-surface transition-colors text-xs"
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                lineHeight: 1,
                padding: '2px 4px',
                borderRadius: '4px',
              }}
            >
              ✕
            </button>
          </div>

          {/* Mensaje secundario */}
          <span className="text-xs text-on-surface-variant">
            {update.phase === 'available'
              ? 'Se está descargando en segundo plano.'
              : `Progreso: ${update.percent}%`}
          </span>

          {/* Barra de progreso (solo en fase downloading) */}
          {update.phase === 'downloading' && (
            <div
              style={{
                height: '4px',
                borderRadius: '2px',
                overflow: 'hidden',
              }}
              className="bg-surface-container-low"
            >
              <div
                style={{
                  height: '100%',
                  width: `${update.percent}%`,
                  backgroundColor: update.percent >= 90 ? 'oklch(0.7 0.18 75)' : 'oklch(0.6 0.15 250)',
                  transition: 'width 300ms ease-in-out',
                }}
              />
            </div>
          )}
        </div>
      )}

      {/* ── Modal de instalación (bloqueante con scrim) ──────────────────────── */}
      {showModal && update.phase === 'ready' && (
        <>
          {/* Scrim */}
          <div
            aria-hidden="true"
            onClick={handleDismissModal}
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 9998,
              backgroundColor: 'oklch(0 0 0 / 0.6)',
            }}
          />

          {/* Dialog */}
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="updater-modal-title"
            aria-describedby="updater-modal-desc"
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 9999,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '24px',
              pointerEvents: 'none',
            }}
          >
            <div
              style={{
                pointerEvents: 'all',
                borderRadius: '8px',
                boxShadow: '0 25px 50px -12px rgba(0,0,0,0.6)',
                width: '100%',
                maxWidth: '420px',
                display: 'flex',
                flexDirection: 'column',
                gap: '0',
              }}
              className="bg-surface-container-low border border-outline-variant"
            >
              {/* Header */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '16px 20px',
                }}
                className="border-b border-outline-variant"
              >
                <h2
                  id="updater-modal-title"
                  className="text-sm font-semibold text-on-surface"
                  style={{ margin: 0 }}
                >
                  Nueva versión lista — v{update.version}
                </h2>
                <button
                  onClick={handleDismissModal}
                  aria-label="Posponer actualización"
                  className="text-on-surface-variant hover:text-on-surface transition-colors"
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    fontSize: '0.875rem',
                    lineHeight: 1,
                    padding: '4px 6px',
                    borderRadius: '4px',
                  }}
                >
                  ✕
                </button>
              </div>

              {/* Body */}
              <div style={{ padding: '20px' }}>
                <p
                  id="updater-modal-desc"
                  className="text-sm text-on-surface-variant"
                  style={{ margin: 0, lineHeight: 1.6 }}
                >
                  La actualización se descargó correctamente. La aplicación se
                  reiniciará para aplicar los cambios.
                </p>
              </div>

              {/* Footer */}
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'flex-end',
                  gap: '8px',
                  padding: '12px 20px 16px',
                }}
                className="border-t border-outline-variant"
              >
                <button
                  onClick={handleDismissModal}
                  className="btn btn--secondary text-xs"
                >
                  Más tarde
                </button>
                <button
                  onClick={handleInstall}
                  className="btn btn--primary text-xs"
                >
                  Instalar ahora
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Keyframe para slide-in del toast */}
      <style>{`
        @keyframes notifier-slide-in {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </>
  );
}
