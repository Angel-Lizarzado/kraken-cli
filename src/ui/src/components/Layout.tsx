import { useState, useEffect, useRef, type ReactNode } from 'react';

// ── Navigation ──
interface NavModule {
  id: string;
  name: string;
  description: string;
}

const NAV_MODULES: readonly NavModule[] = [
  { id: 'dashboard',   name: 'Panel',        description: 'Gestión de servidores' },
  { id: 'syncdns',     name: 'Sync DNS',     description: 'Fase 0: Redirección DNS' },
  { id: 'extraction',  name: 'Extracción',   description: 'Fase 1: Backup desde Hostinger' },
  { id: 'migration',   name: 'Migración',    description: 'Fase 2: Transferencia a Plesk' },
  { id: 'provisioning', name: 'DNS -> SSL', description: 'Fase 3: Red y SSL' },
  { id: 'validation',  name: 'Validación',   description: 'Fase 4: Post-migración' },
  { id: 'sourcesync', name: 'SourceSync',   description: 'Despliegue Git a Plesk' },
  { id: 'cms',         name: 'Reconstructor', description: 'Reconstrucción WP en masa' },
  { id: 'security',    name: 'Seguridad',     description: 'Administración avanzada' },
  { id: 'config',      name: 'Configuración', description: 'Cuentas y llaves SSH' },
  { id: 'terminal',    name: 'Terminal',      description: 'Herramientas avanzadas' },
] as const;

// SVG path data for nav icons (Lucide-compatible)
const MODULE_ICONS: Record<string, string> = {
  dashboard:   'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6',
  syncdns:     'M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9',
  extraction:  'M12 4v16m8-8H4',
  migration:   'M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4',
  provisioning: 'M22 12A10 10 0 1 1 12 2a10 10 0 0 1 10 10z M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z M2 12h20',
  validation:  'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z',
  // Cohete: SourceSync
  sourcesync: 'M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2l.55-.55M15 12H7M20.4 5.6a5.5 5.5 0 0 0-7.77 7.77l7.77-7.77zM9 6.5V12M15 12l1.5 1.5',
  // Wrench: CMS Reconstructor
  cms:         'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z',
  // Escudo: Seguridad
  security:    'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  config:      'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z',
  terminal:    'M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z',
};

// ── Props ──
interface LayoutProps {
  children: ReactNode;
  activeModule: string;
  onModuleChange: (module: string) => void;
}

export default function Layout({ children, activeModule, onModuleChange }: LayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [appVersion, setAppVersion] = useState<string>('');

  useEffect(() => {
    window.electronAPI?.getAppVersion?.()
      .then((v: string) => setAppVersion(v))
      .catch(() => setAppVersion('—'));
  }, []);

  return (
    <div
      className="h-screen flex flex-col"
      style={{ backgroundColor: 'var(--surface-base)', color: 'var(--text-primary)' }}
    >
      {/* ── Top Header ── */}
      <header
        className="flex items-center justify-between px-4 py-2.5 border-b"
        style={{
          backgroundColor: 'var(--surface-raised)',
          borderBottomColor: 'var(--border-default)',
          minHeight: '48px',
        }}
      >
        <div className="flex items-center gap-3">
          <button
            onClick={() => setSidebarOpen(prev => !prev)}
            className="btn btn--ghost p-1.5"
            aria-label={sidebarOpen ? 'Cerrar sidebar' : 'Abrir sidebar'}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
          <div>
            <h1 className="font-display text-base font-bold" style={{ color: 'var(--text-primary)' }}>
              Kraken CLI
            </h1>
            <p className="text-xs leading-none" style={{ color: 'var(--text-muted)' }}>
              Centro de control de migraciones
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3" />
      </header>

      {/* ── Body: Sidebar + Main ── */}
      <div className="flex flex-1 overflow-hidden">
        {/* ── Sidebar ── */}
        {sidebarOpen && (
          <aside
            className="flex flex-col border-r"
            style={{
              width: '220px',
              backgroundColor: 'var(--surface-raised)',
              borderRightColor: 'var(--border-default)',
            }}
          >
            <nav className="flex-1 p-2 space-y-0.5 overflow-y-auto">
              {NAV_MODULES.map((mod) => {
                const isActive = activeModule === mod.id;
                return (
                  <button
                    key={mod.id}
                    onClick={() => onModuleChange(mod.id)}
                    className="w-full flex items-center gap-3 px-3 py-2 rounded-md transition-all duration-150 ease-out"
                    style={{
                      backgroundColor: isActive ? 'var(--surface-overlay)' : 'transparent',
                      color: isActive ? 'var(--color-accent)' : 'var(--text-secondary)',
                    }}
                    onMouseEnter={(e) => {
                      if (!isActive) e.currentTarget.style.backgroundColor = 'var(--surface-overlay)';
                    }}
                    onMouseLeave={(e) => {
                      if (!isActive) e.currentTarget.style.backgroundColor = 'transparent';
                    }}
                  >
                    <svg
                      width="16" height="16" viewBox="0 0 24 24"
                      fill="none" stroke="currentColor" strokeWidth="1.5"
                      strokeLinecap="round" strokeLinejoin="round"
                    >
                      <path d={MODULE_ICONS[mod.id]} />
                    </svg>
                    <div className="text-left min-w-0">
                      <div className="text-sm font-medium truncate">{mod.name}</div>
                      <div className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>
                        {mod.description}
                      </div>
                    </div>
                  </button>
                );
              })}
            </nav>

            {/* ── System Status ── */}
            <div className="px-4 py-3 border-t space-y-2" style={{ borderTopColor: 'var(--border-default)' }}>
              <div className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
                Estado del sistema
              </div>
              <div className="space-y-1.5">
                <StatusRow label="Conexión IPC" online />
                <StatusRow label="Servicio SSH" online />
                <StatusRow label="Configuración" online />
              </div>
            </div>

            {/* ── App Version + Check ── */}
            <VersionFooter appVersion={appVersion} />

            {/* ── Author Signature ── */}
            <div
              className="px-4 py-2.5 border-t"
              style={{ borderTopColor: 'var(--border-default)' }}
            >
              <button
                onClick={() => {
                  try {
                    if (window.api) window.api.invoke('shell:open-external', { url: 'https://www.linkedin.com/in/angel-lizarzado/' });
                  } catch {}
                }}
                className="flex items-center gap-2 text-xs transition-opacity duration-150 ease-out w-full"
                style={{ color: 'var(--text-muted)', opacity: 0.6 }}
                onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
                onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.6'; }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/>
                </svg>
                Desarrollado por Angel Lizarzado
              </button>
            </div>
          </aside>
        )}

        {/* ── Main Content ── */}
        <main className="flex-1 overflow-auto p-5 scrollbar-thin">
          {children}
        </main>
      </div>
    </div>
  );
}

// ── Status Row inline component ──
function StatusRow({ label, online }: { label: string; online: boolean }) {
  return (
    <div className="flex justify-between items-center text-xs" style={{ color: 'var(--text-secondary)' }}>
      <span>{label}</span>
      <span
        className="status-dot"
        style={{
          backgroundColor: online ? 'var(--color-success)' : 'var(--color-error)',
          animation: online ? 'pulse 2s ease-in-out infinite' : 'none',
        }}
      />
    </div>
  );
}

// ── Version Footer with manual check ──
function VersionFooter({ appVersion }: { appVersion: string }) {
  const [checkState, setCheckState] = useState<'idle' | 'checking' | 'up-to-date' | 'error'>('idle');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!window.electronAPI?.onEvent) return;

    const cleanNotAvailable = window.electronAPI.onEvent('updater:not-available', () => {
      setCheckState('up-to-date');
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCheckState('idle'), 4000);
    });

    const cleanChecking = window.electronAPI.onEvent('updater:checking', () => {
      setCheckState('checking');
    });

    const cleanAvailable = window.electronAPI.onEvent('updater:update-available', () => {
      setCheckState('idle'); // El UpdateNotifier se encarga de mostrar el toast
    });

    const cleanError = window.electronAPI.onEvent('updater:error', () => {
      setCheckState('error');
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCheckState('idle'), 4000);
    });

    return () => {
      cleanNotAvailable();
      cleanChecking();
      cleanAvailable();
      cleanError();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleCheck = () => {
    setCheckState('checking');
    window.electronAPI?.checkForUpdates?.();
  };

  return (
    <div
      className="px-4 py-2.5 border-t"
      style={{ borderTopColor: 'var(--border-default)' }}
    >
      <div className="flex items-center justify-between">
        <span
          className="text-xs"
          style={{
            color: 'var(--text-muted)',
            fontFamily: 'var(--font-mono, monospace)',
            letterSpacing: '0.03em',
          }}
        >
          {appVersion ? `v${appVersion}` : '...'}
        </span>
        <button
          onClick={handleCheck}
          disabled={checkState === 'checking'}
          className="text-xs transition-all duration-150 ease-out"
          style={{
            background: 'none',
            border: 'none',
            cursor: checkState === 'checking' ? 'default' : 'pointer',
            color: checkState === 'checking' ? 'var(--text-muted)' : 'var(--color-accent)',
            opacity: checkState === 'checking' ? 0.6 : 0.8,
            padding: '2px 4px',
            borderRadius: '4px',
            fontFamily: 'var(--font-body, Inter, system-ui, sans-serif)',
          }}
          onMouseEnter={(e) => {
            if (checkState !== 'checking') e.currentTarget.style.opacity = '1';
          }}
          onMouseLeave={(e) => {
            if (checkState !== 'checking') e.currentTarget.style.opacity = '0.8';
          }}
        >
          {checkState === 'checking' ? 'Buscando...' : 'Buscar actualizaciones'}
        </button>
      </div>

      {/* Feedback inline */}
      {checkState === 'up-to-date' && (
        <div
          className="text-xs mt-1.5"
          style={{
            color: 'var(--color-success)',
            animation: 'notifier-slide-in 150ms ease-out forwards',
          }}
        >
          ✓ Ya tienes la última versión
        </div>
      )}
      {checkState === 'error' && (
        <div
          className="text-xs mt-1.5"
          style={{
            color: 'var(--color-error)',
            animation: 'notifier-slide-in 150ms ease-out forwards',
          }}
        >
          ✗ Error al buscar actualizaciones
        </div>
      )}
    </div>
  );
}
