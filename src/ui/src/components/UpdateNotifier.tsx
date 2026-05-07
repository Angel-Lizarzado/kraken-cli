import { useState, useEffect, useCallback, useRef } from 'react';

// ── Types ──────────────────────────────────────────────────────────────────────

type UpdateState =
  | { phase: 'idle' }
  | { phase: 'available'; version: string }
  | { phase: 'downloading'; percent: number }
  | { phase: 'ready'; version: string };

// ── UpdateNotifier ─────────────────────────────────────────────────────────────
// Escucha los tres eventos IPC del autoUpdater y presenta:
//   - Toast discreto (no bloqueante) para available + downloading
//   - Modal centrado para ready (con opción de instalar o posponer)

export default function UpdateNotifier() {
  const [update, setUpdate] = useState<UpdateState>({ phase: 'idle' });
  const [toastVisible, setToastVisible] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

    // ── update-available ──────────────────────────────────────────────────────
    const cleanAvailable = window.electronAPI.onEvent(
      'updater:update-available',
      (payload: { version: string }) => {
        setUpdate({ phase: 'available', version: payload.version });
        setDismissed(false);
        showToast();
        scheduleToastHide(8000);
      }
    );

    // ── download-progress ─────────────────────────────────────────────────────
    const cleanProgress = window.electronAPI.onEvent(
      'updater:download-progress',
      (payload: { percent: number }) => {
        setUpdate((prev) => ({
          phase: 'downloading',
          percent: payload.percent,
          // conserva versión si ya la teníamos
          ...(prev.phase === 'available' || prev.phase === 'downloading'
            ? {}
            : {}),
        }));
        showToast();
        // No auto-ocultar mientras descarga
        if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      }
    );

    // ── update-downloaded ─────────────────────────────────────────────────────
    const cleanDownloaded = window.electronAPI.onEvent(
      'updater:update-downloaded',
      (payload: { version: string }) => {
        setUpdate({ phase: 'ready', version: payload.version });
        setDismissed(false);
        setToastVisible(false);
        if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      }
    );

    return () => {
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
            backgroundColor: 'var(--surface-overlay)',
            border: '1px solid var(--border-default)',
            borderRadius: '8px',
            padding: '12px 14px',
            minWidth: '260px',
            maxWidth: '320px',
            animation: 'notifier-slide-in 150ms ease-out forwards',
          }}
        >
          {/* Header row */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span
              style={{
                fontFamily: 'var(--font-body, Inter, system-ui, sans-serif)',
                fontSize: '0.75rem',
                fontWeight: 600,
                color: 'var(--text-primary)',
                letterSpacing: '0.02em',
              }}
            >
              {update.phase === 'available'
                ? `Actualización disponible — v${update.version}`
                : 'Descargando actualización...'}
            </span>
            <button
              onClick={handleDismissToast}
              aria-label="Cerrar notificación"
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--text-muted)',
                fontSize: '0.75rem',
                lineHeight: 1,
                padding: '2px 4px',
                borderRadius: '4px',
                transition: 'color 150ms ease-out',
              }}
            >
              ✕
            </button>
          </div>

          {/* Mensaje secundario */}
          <span
            style={{
              fontFamily: 'var(--font-body, Inter, system-ui, sans-serif)',
              fontSize: '0.75rem',
              color: 'var(--text-secondary)',
            }}
          >
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
                backgroundColor: 'var(--surface-base)',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  height: '100%',
                  width: `${update.percent}%`,
                  backgroundColor:
                    update.percent >= 90
                      ? 'var(--color-warning)'
                      : 'var(--color-accent)',
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
                backgroundColor: 'var(--surface-raised)',
                border: '1px solid var(--border-hover)',
                borderRadius: '8px',
                boxShadow: '0 25px 50px -12px rgba(0,0,0,0.6)',
                width: '100%',
                maxWidth: '420px',
                display: 'flex',
                flexDirection: 'column',
                gap: '0',
              }}
            >
              {/* Header */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '16px 20px',
                  borderBottom: '1px solid var(--border-default)',
                }}
              >
                <h2
                  id="updater-modal-title"
                  style={{
                    margin: 0,
                    fontFamily: 'var(--font-display, Satoshi, system-ui, sans-serif)',
                    fontSize: '0.875rem',
                    fontWeight: 600,
                    color: 'var(--text-primary)',
                  }}
                >
                  Nueva versión lista — v{update.version}
                </h2>
                <button
                  onClick={handleDismissModal}
                  aria-label="Posponer actualización"
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    color: 'var(--text-muted)',
                    fontSize: '0.875rem',
                    lineHeight: 1,
                    padding: '4px 6px',
                    borderRadius: '4px',
                    transition: 'color 150ms ease-out',
                  }}
                >
                  ✕
                </button>
              </div>

              {/* Body */}
              <div style={{ padding: '20px' }}>
                <p
                  id="updater-modal-desc"
                  style={{
                    margin: 0,
                    fontFamily: 'var(--font-body, Inter, system-ui, sans-serif)',
                    fontSize: '0.875rem',
                    lineHeight: 1.6,
                    color: 'var(--text-secondary)',
                  }}
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
                  borderTop: '1px solid var(--border-default)',
                }}
              >
                <button
                  onClick={handleDismissModal}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '6px 12px',
                    borderRadius: '6px',
                    fontSize: '0.75rem',
                    fontWeight: 500,
                    fontFamily: 'var(--font-body, Inter, system-ui, sans-serif)',
                    cursor: 'pointer',
                    transition: 'all 150ms ease-out',
                    background: 'transparent',
                    color: 'var(--text-secondary)',
                    border: '1px solid var(--border-default)',
                  }}
                >
                  Más tarde
                </button>
                <button
                  onClick={handleInstall}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '6px 14px',
                    borderRadius: '6px',
                    fontSize: '0.75rem',
                    fontWeight: 500,
                    fontFamily: 'var(--font-body, Inter, system-ui, sans-serif)',
                    cursor: 'pointer',
                    transition: 'all 150ms ease-out',
                    background: 'var(--color-accent)',
                    color: '#fff',
                    border: 'none',
                  }}
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
