import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useToast } from './Toast';

interface LogEntry {
  timestamp: string;
  paso: string;
  progreso: number;
  mensaje: string;
  domain?: string;
}

interface ScalifylabsModuleProps {
  onLog: (message: string, type: 'info' | 'warning' | 'error' | 'success', moduleId?: string) => void;
}

// ── Ícono de cohete (SVG inline Lucide-compatible) ────────────────────────────
const IconRocket = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2l.55-.55" />
    <path d="M12 13H7" />
    <path d="M15 12l-8.5 8.5" />
    <path d="M9 6.5V12" />
    <path d="M20.4 5.6a5.5 5.5 0 0 0-7.77 7.77L20.4 5.6z" />
    <path d="M13.5 12l1.5 1.5" />
  </svg>
);

const IconTerminal = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="4 17 10 11 4 5" />
    <line x1="12" y1="19" x2="20" y2="19" />
  </svg>
);

const IconGithub = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
  </svg>
);

const GITHUB_URL_REGEX = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?$/;

// ── Derivar owner y repo de la URL HTTPS ────────────────────────────────────
function parsearUrlGithub(url: string): { repoOwner: string; repoName: string } | null {
  const match = url.trim().match(GITHUB_URL_REGEX);
  if (!match) return null;
  return { repoOwner: match[1], repoName: match[2] };
}

// ── Formatear timestamp HH:MM:SS ────────────────────────────────────────────
function ts(): string {
  return new Date().toTimeString().slice(0, 8);
}

// ── Color semántico para el porcentaje de progreso ──────────────────────────
function colorProgreso(pct: number): string {
  if (pct >= 100) return 'var(--color-success)';
  if (pct > 0)    return 'var(--color-accent)';
  return 'var(--text-muted)';
}

// ── Componente principal ─────────────────────────────────────────────────────
const ScalifylabsModule: React.FC<ScalifylabsModuleProps> = ({ onLog }) => {
  const toast = useToast();
  const api = (window as any).api;

  // ── Formulario ─────────────────────────────────────────────────────────────
  const [servidores, setServidores] = useState<string[]>([]);
  const [serverName, setServerName]   = useState('');
  const [domain, setDomain]           = useState('');
  const [httpsUrl, setHttpsUrl]       = useState('');
  const [vincularGitHub, setVincularGitHub] = useState(true);

  // ── Estado de ejecución ────────────────────────────────────────────────────
  const [desplegando, setDesplegando] = useState(false);
  const [progreso, setProgreso]       = useState(0);

  // ── Consola de logs ────────────────────────────────────────────────────────
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const logEndRef = useRef<HTMLDivElement>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  // ── Cargar lista de servidores destino configurados ────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const cfg = await api?.invoke('config:get');
        const destinos: string[] = (cfg?.destinationServers || []).map((s: any) => s.name).filter(Boolean);
        setServidores(destinos);
        if (destinos.length > 0 && !serverName) setServerName(destinos[0]);
      } catch { /* silencioso */ }
    })();
  }, []);

  // ── Escuchar config:updated para refrescar la lista de servidores ──────────
  useEffect(() => {
    const handler = (cfg: any) => {
      if (!cfg?.config?.destinationServers) return;
      const destinos = cfg.config.destinationServers.map((s: any) => s.name).filter(Boolean);
      setServidores(destinos);
    };
    api?.receive('config:updated', handler);
    return () => api?.removeListener('config:updated', handler);
  }, []);

  // ── Auto-scroll de la consola de logs ─────────────────────────────────────
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logEntries]);

  // ── Cleanup del listener IPC al desmontar ─────────────────────────────────
  useEffect(() => {
    return () => {
      if (cleanupRef.current) {
        cleanupRef.current();
        cleanupRef.current = null;
      }
    };
  }, []);

  // ── Agregar entrada a la consola ──────────────────────────────────────────
  const agregarLog = useCallback((entrada: Omit<LogEntry, 'timestamp'>) => {
    setLogEntries(prev => [...prev, { ...entrada, timestamp: ts() }]);
  }, []);

  // ── Limpiar consola ────────────────────────────────────────────────────────
  const limpiarLogs = useCallback(() => {
    setLogEntries([]);
    setProgreso(0);
  }, []);

  // ── Validar formulario ────────────────────────────────────────────────────
  const formularioValido = serverName.trim() && domain.trim() && httpsUrl.trim() && parsearUrlGithub(httpsUrl);

  // ── Handler: iniciar despliegue ───────────────────────────────────────────
  const handleDesplegar = useCallback(async () => {
    if (!formularioValido || desplegando) return;

    const parsed = parsearUrlGithub(httpsUrl);
    if (!parsed) {
      toast.error('URL de GitHub inválida. Usa el formato: https://github.com/org/repo');
      return;
    }

    limpiarLogs();
    setDesplegando(true);
    setProgreso(0);

    agregarLog({
      paso: 'inicio',
      progreso: 0,
      mensaje: `Iniciando despliegue de "${domain}" en servidor "${serverName}"...`,
    });

    // ── Suscribir al canal de progreso en tiempo real ───────────────────────
    if (cleanupRef.current) cleanupRef.current();

    const progressHandler = (evento: any) => {
      const { paso = '', progreso: pct = 0, mensaje = '' } = evento || {};
      setProgreso(pct);
      agregarLog({ paso, progreso: pct, mensaje });
    };

    api?.receive('scalify:progreso', progressHandler);
    cleanupRef.current = () => api?.removeListener('scalify:progreso', progressHandler);

    try {
      const resultado = await api?.invoke('scalify:deploy', {
        serverName: serverName.trim(),
        domain: domain.trim(),
        httpsUrl: httpsUrl.trim(),
        repoOwner: parsed.repoOwner,
        repoName: parsed.repoName,
        vincularGitHub,
        rama: 'main',
      });

      if (resultado?.success) {
        setProgreso(100);
        const msg = `Despliegue completado. Node.js ${resultado.versionNode}. Repo: ${resultado.urlSsh || httpsUrl}`;
        agregarLog({ paso: 'completado', progreso: 100, mensaje: msg });
        toast.success('Despliegue configurado correctamente.');
        onLog(`[SCALIFY] ${msg}`, 'success', 'scalifylabs');
      } else {
        const errMsg = resultado?.error || 'Error desconocido en el despliegue.';
        agregarLog({ paso: 'error', progreso: progreso, mensaje: `Error: ${errMsg}` });
        toast.error(`Error: ${errMsg}`);
        onLog(`[SCALIFY] Error: ${errMsg}`, 'error', 'scalifylabs');
      }
    } catch (err: any) {
      const errMsg = err?.message || 'Error de comunicación IPC.';
      agregarLog({ paso: 'error', progreso: 0, mensaje: `Error inesperado: ${errMsg}` });
      toast.error(errMsg);
      onLog(`[SCALIFY] Error inesperado: ${errMsg}`, 'error', 'scalifylabs');
    } finally {
      setDesplegando(false);
      // Limpiar listener de progreso
      if (cleanupRef.current) {
        cleanupRef.current();
        cleanupRef.current = null;
      }
    }
  }, [formularioValido, desplegando, serverName, domain, httpsUrl, vincularGitHub, agregarLog, limpiarLogs, toast, onLog]);

  // ─────────────────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="font-display text-xl font-bold flex items-center gap-2">
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 28,
                height: 28,
                borderRadius: 6,
                backgroundColor: 'var(--color-accent-bg)',
                color: 'var(--color-accent)',
              }}
            >
              <IconRocket />
            </span>
            ScalifyLabs
          </h1>
          <p className="text-sm mt-0.5" style={{ color: 'var(--text-muted)' }}>
            Despliegue automatizado de proyectos Next.js (Standalone) a Plesk vía GitHub
          </p>
        </div>
      </div>

      {/* ── Formulario de despliegue ────────────────────────────────────────── */}
      <section>
        <h2 className="font-display text-base font-bold mb-4">Configurar despliegue</h2>
        <div className="card p-5 space-y-4">

          {/* Servidor destino */}
          <div>
            <label
              htmlFor="scalify-server"
              className="block text-sm font-medium mb-1.5"
              style={{ color: 'var(--text-secondary)' }}
            >
              Servidor Plesk destino
            </label>
            {servidores.length > 0 ? (
              <select
                id="scalify-server"
                value={serverName}
                onChange={e => setServerName(e.target.value)}
                disabled={desplegando}
                className="input text-sm"
                style={{ width: '100%', fontFamily: 'var(--font-mono)' }}
              >
                {servidores.map(s => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            ) : (
              <p className="text-xs py-2 px-3 rounded" style={{ color: 'var(--color-warning)', backgroundColor: 'var(--color-warning-bg)', border: '1px solid var(--color-warning)' }}>
                No hay servidores Plesk configurados. Agregue uno desde el Panel principal.
              </p>
            )}
          </div>

          {/* Dominio de destino */}
          <div>
            <label
              htmlFor="scalify-domain"
              className="block text-sm font-medium mb-1.5"
              style={{ color: 'var(--text-secondary)' }}
            >
              Dominio de destino
            </label>
            <input
              id="scalify-domain"
              type="text"
              value={domain}
              onChange={e => setDomain(e.target.value)}
              disabled={desplegando}
              placeholder="ej: app.example.com"
              className="input font-mono text-sm"
              style={{ width: '100%' }}
            />
          </div>

          {/* URL del repositorio */}
          <div>
            <label
              htmlFor="scalify-repo"
              className="block text-sm font-medium mb-1.5"
              style={{ color: 'var(--text-secondary)' }}
            >
              URL HTTPS del repositorio GitHub
            </label>
            <div className="flex items-center gap-2">
              <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}><IconGithub /></span>
              <input
                id="scalify-repo"
                type="text"
                value={httpsUrl}
                onChange={e => setHttpsUrl(e.target.value)}
                disabled={desplegando}
                placeholder="https://github.com/organización/repositorio"
                className="input font-mono text-sm flex-1"
              />
            </div>
            {httpsUrl && !parsearUrlGithub(httpsUrl) && (
              <p className="text-xs mt-1" style={{ color: 'var(--color-error)' }}>
                URL inválida. Formato requerido: https://github.com/org/repo
              </p>
            )}
          </div>

          {/* Opción: vincular GitHub */}
          <div className="flex items-center gap-3 py-1">
            <input
              id="scalify-vincular"
              type="checkbox"
              checked={vincularGitHub}
              onChange={e => setVincularGitHub(e.target.checked)}
              disabled={desplegando}
              style={{
                width: 14, height: 14, flexShrink: 0,
                accentColor: 'var(--color-accent)',
                cursor: desplegando ? 'not-allowed' : 'pointer',
              }}
            />
            <label
              htmlFor="scalify-vincular"
              className="text-sm"
              style={{
                color: 'var(--text-secondary)',
                cursor: desplegando ? 'not-allowed' : 'pointer',
              }}
            >
              Generar y registrar llave SSH Ed25519 en GitHub
              <span className="block text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                Desmarca si el dominio ya tiene la llave configurada
              </span>
            </label>
          </div>

          {/* ── Barra de progreso ─────────────────────────────────────────── */}
          {desplegando && (
            <div>
              <div
                className="text-xs mb-1.5 flex justify-between"
                style={{ color: 'var(--text-muted)' }}
              >
                <span>Progreso del despliegue</span>
                <span style={{ color: colorProgreso(progreso), fontFamily: 'var(--font-mono)' }}>
                  {progreso}%
                </span>
              </div>
              <div
                style={{
                  height: 4,
                  borderRadius: 2,
                  backgroundColor: 'var(--surface-overlay)',
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    height: '100%',
                    width: `${progreso}%`,
                    backgroundColor: colorProgreso(progreso),
                    transition: 'width 300ms ease-in-out',
                    borderRadius: 2,
                  }}
                />
              </div>
            </div>
          )}

          {/* ── Botón iniciar ────────────────────────────────────────────── */}
          <div className="flex items-center gap-3 pt-1">
            <button
              id="scalify-btn-deploy"
              onClick={handleDesplegar}
              disabled={desplegando || !formularioValido}
              className="btn btn--primary text-xs flex items-center gap-2"
            >
              {desplegando ? (
                <>
                  <span className="spinner" />
                  Desplegando...
                </>
              ) : (
                <>
                  <IconRocket />
                  Iniciar Despliegue
                </>
              )}
            </button>

            {logEntries.length > 0 && !desplegando && (
              <button
                onClick={limpiarLogs}
                className="btn btn--ghost text-xs"
                style={{ color: 'var(--text-muted)' }}
              >
                Limpiar consola
              </button>
            )}
          </div>
        </div>
      </section>

      {/* ── Consola de logs ─────────────────────────────────────────────────── */}
      {logEntries.length > 0 && (
        <section>
          <h2 className="font-display text-base font-bold mb-3 flex items-center gap-2">
            <span style={{ color: 'var(--text-muted)' }}><IconTerminal /></span>
            Consola de despliegue
          </h2>
          <div
            className="card overflow-hidden"
            style={{ backgroundColor: 'oklch(0.12 0.008 250)' }}
          >
            {/* ── Barra de título estilo terminal ─────────────────────────── */}
            <div
              className="flex items-center justify-between px-4 py-2 border-b"
              style={{
                borderBottomColor: 'var(--border-default)',
                backgroundColor: 'oklch(0.15 0.01 250)',
              }}
            >
              <span className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
                scalifylabs — {domain || 'deploy'}
              </span>
              <span
                className="text-xs font-mono"
                style={{ color: progreso >= 100 ? 'var(--color-success)' : desplegando ? 'var(--color-warning)' : 'var(--text-muted)' }}
              >
                {progreso >= 100 ? '● completado' : desplegando ? '● corriendo' : '● inactivo'}
              </span>
            </div>

            {/* ── Cuerpo de la consola ─────────────────────────────────────── */}
            <div
              className="p-4 overflow-y-auto scrollbar-thin"
              style={{ maxHeight: 340, minHeight: 120, fontFamily: 'var(--font-mono)', fontSize: '0.75rem', lineHeight: '1.6' }}
            >
              {logEntries.map((entry, idx) => (
                <div
                  key={idx}
                  className="flex items-start gap-2"
                  style={{
                    paddingTop: 1,
                    paddingBottom: 1,
                    color: entry.paso === 'error' || entry.paso === 'error-fatal'
                      ? 'var(--color-error)'
                      : entry.paso === 'completado'
                      ? 'var(--color-success)'
                      : entry.progreso >= 100
                      ? 'var(--color-success)'
                      : 'var(--text-secondary)',
                  }}
                >
                  <span style={{ color: 'var(--text-muted)', flexShrink: 0, userSelect: 'none' }}>
                    [{entry.timestamp}]
                  </span>
                  <span style={{ wordBreak: 'break-all' }}>{entry.mensaje}</span>
                </div>
              ))}
              <div ref={logEndRef} />
            </div>
          </div>
        </section>
      )}

      {/* ── Nota técnica ─────────────────────────────────────────────────────── */}
      <section>
        <div
          className="p-4 rounded-lg text-xs space-y-1.5"
          style={{
            backgroundColor: 'var(--color-info-bg)',
            border: '1px solid var(--color-info)',
            color: 'var(--text-secondary)',
          }}
        >
          <p className="font-medium" style={{ color: 'var(--color-info)' }}>
            Requisitos previos
          </p>
          <p>• El GitHub API Token debe estar configurado en <strong>Configuración → Integraciones Externas</strong>.</p>
          <p>• El repositorio debe contener un archivo <code className="font-mono px-1 rounded" style={{ backgroundColor: 'oklch(0 0 0 / 0.3)' }}>deploy.sh</code> en la raíz (ejecutado automáticamente por Plesk).</p>
          <p>• Node.js v24.15.0 se usará como fallback si las versiones LTS (20/22) están deshabilitadas en Plesk.</p>
          <p>• El despliegue es idempotente: puede re-ejecutarse sin duplicar la configuración.</p>
        </div>
      </section>
    </div>
  );
};

export default ScalifylabsModule;
