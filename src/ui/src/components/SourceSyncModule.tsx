import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useToast } from './Toast';

// ── Tipos ────────────────────────────────────────────────────────────────────

interface DeployStep {
  paso: string;
  progreso: number;
  mensaje: string;
  ts: number;
}

type DeployStatus = 'running' | 'success' | 'error';

interface DeployEntry {
  id: string;
  domain: string;
  serverName: string;
  startedAt: number;
  finishedAt?: number;
  steps: DeployStep[];
  status: DeployStatus;
}

interface SourceSyncModuleProps {
  onLog: (message: string, type: 'info' | 'warning' | 'error' | 'success', moduleId?: string) => void;
}

// ── Utilidades ────────────────────────────────────────────────────────────────

const GITHUB_URL_REGEX = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?$/;

function parsearUrl(url: string) {
  const m = url.trim().match(GITHUB_URL_REGEX);
  return m ? { repoOwner: m[1], repoName: m[2] } : null;
}

function tsNow(): string {
  return new Date().toTimeString().slice(0, 8);
}

function duracion(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

// ── Íconos ────────────────────────────────────────────────────────────────────

const IconRocket = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2l.55-.55" /><path d="M12 13H7" />
    <path d="M9 6.5V12" /><path d="M20.4 5.6a5.5 5.5 0 0 0-7.77 7.77L20.4 5.6z" /><path d="M13.5 12l1.5 1.5" />
  </svg>
);

const IconTerminal = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
  </svg>
);

const IconGithub = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
  </svg>
);

const IconChevron = ({ open }: { open: boolean }) => (
  <svg
    width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
    style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 150ms ease-out' }}
  >
    <polyline points="9 18 15 12 9 6" />
  </svg>
);

// ── Barra de progreso compacta ────────────────────────────────────────────────

function ProgressBar({ pct, status }: { pct: number; status: DeployStatus }) {
  const color =
    status === 'error' ? 'var(--color-error)' :
    status === 'success' ? 'var(--color-success)' :
    'var(--color-accent)';
  return (
    <div style={{ height: 3, borderRadius: 2, backgroundColor: 'var(--surface-overlay)', overflow: 'hidden', marginTop: 6 }}>
      <div style={{
        height: '100%',
        width: `${pct}%`,
        backgroundColor: color,
        transition: 'width 300ms ease-in-out',
        borderRadius: 2,
        animation: status === 'running' ? 'pulse 2s ease-in-out infinite' : 'none',
      }} />
    </div>
  );
}

// ── Acordeón de un despliegue ─────────────────────────────────────────────────

interface AccordionItemProps {
  entry: DeployEntry;
  isOpen: boolean;
  onToggle: () => void;
}

function AccordionItem({ entry, isOpen, onToggle }: AccordionItemProps) {
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen) logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [entry.steps.length, isOpen]);

  const statusColor =
    entry.status === 'error' ? 'var(--color-error)' :
    entry.status === 'success' ? 'var(--color-success)' :
    'var(--color-warning)';

  const statusLabel =
    entry.status === 'error' ? '✗ Error' :
    entry.status === 'success' ? '✓ Listo' :
    '⟳ Desplegando';

  const lastPct = entry.steps.length > 0 ? entry.steps[entry.steps.length - 1].progreso : 0;
  const elapsed = entry.finishedAt
    ? duracion(entry.finishedAt - entry.startedAt)
    : duracion(Date.now() - entry.startedAt);

  return (
    <div
      className="rounded-lg overflow-hidden"
      style={{
        border: `1px solid ${entry.status === 'running' ? 'var(--color-warning)' : entry.status === 'error' ? 'var(--color-error)' : 'var(--border-default)'}`,
        opacity: entry.status === 'error' ? 0.85 : 1,
      }}
    >
      {/* ── Cabecera del acordeón ── */}
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-3 text-left"
        style={{
          backgroundColor: 'oklch(0.15 0.01 250)',
          cursor: 'pointer',
          userSelect: 'none',
        }}
      >
        <IconChevron open={isOpen} />

        {/* Dominio */}
        <span className="font-mono text-xs font-medium flex-1 truncate" style={{ color: 'var(--text-primary)' }}>
          {entry.domain}
        </span>

        {/* Servidor */}
        <span className="text-xs hidden sm:inline" style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
          {entry.serverName}
        </span>

        {/* Tiempo */}
        <span className="text-xs" style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', minWidth: 32 }}>
          {elapsed}
        </span>

        {/* Badge de estado */}
        <span
          className="text-xs font-mono px-2 py-0.5 rounded"
          style={{
            color: statusColor,
            backgroundColor: `${statusColor}20`,
            whiteSpace: 'nowrap',
          }}
        >
          {statusLabel}
        </span>
      </button>

      {/* Barra de progreso siempre visible */}
      {entry.status === 'running' && (
        <div style={{ padding: '0 16px', backgroundColor: 'oklch(0.15 0.01 250)', paddingBottom: 8 }}>
          <ProgressBar pct={lastPct} status={entry.status} />
          <div className="text-xs mt-1" style={{ color: 'var(--color-accent)', fontFamily: 'var(--font-mono)' }}>
            {lastPct}% — {entry.steps[entry.steps.length - 1]?.mensaje || '…'}
          </div>
        </div>
      )}

      {/* ── Cuerpo: logs ── */}
      {isOpen && (
        <div
          className="overflow-y-auto scrollbar-thin"
          style={{
            maxHeight: 320,
            backgroundColor: 'oklch(0.12 0.008 250)',
            fontFamily: 'var(--font-mono)',
            fontSize: '0.7rem',
            lineHeight: 1.65,
            padding: '12px 16px',
          }}
        >
          {entry.steps.length === 0 ? (
            <span style={{ color: 'var(--text-muted)' }}>Conectando…</span>
          ) : (
            entry.steps.map((step, idx) => {
              const isError = step.paso === 'error' || step.paso === 'error-fatal';
              const isDone = step.paso === 'completado' || step.progreso >= 100;
              const color = isError ? 'var(--color-error)' : isDone ? 'var(--color-success)' : 'var(--text-secondary)';
              const tsStr = new Date(step.ts).toTimeString().slice(0, 8);
              return (
                <div key={idx} className="flex items-start gap-2" style={{ color, paddingTop: 1, paddingBottom: 1 }}>
                  <span style={{ color: 'var(--text-muted)', flexShrink: 0, userSelect: 'none' }}>[{tsStr}]</span>
                  <span style={{ wordBreak: 'break-all' }}>{step.mensaje}</span>
                </div>
              );
            })
          )}
          <div ref={logEndRef} />
        </div>
      )}
    </div>
  );
}

// ── Componente principal ──────────────────────────────────────────────────────

const SourceSyncModule: React.FC<SourceSyncModuleProps> = ({ onLog }) => {
  const toast = useToast();
  const api = (window as any).api;

  // ── Formulario ─────────────────────────────────────────────────────────────
  const [servidores, setServidores] = useState<string[]>([]);
  const [serverName, setServerName] = useState('');
  const [domain, setDomain] = useState('');
  const [httpsUrl, setHttpsUrl] = useState('');
  const [vincularGitHub, setVincularGitHub] = useState(true);

  // ── Estado de ejecución ────────────────────────────────────────────────────
  const [desplegando, setDesplegando] = useState(false);

  // ── Historial de despliegues (Terminal Accordion) ──────────────────────────
  const [deploymentLog, setDeploymentLog] = useState<DeployEntry[]>([]);
  const [openAccordions, setOpenAccordions] = useState<Set<string>>(new Set());
  const activeEntryIdRef = useRef<string | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  // ── Hidratar desde AppStateManager al montar ──────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const state = await api?.invoke('sourcesync:get-state');
        if (state?.deploymentLog?.length > 0) {
          setDeploymentLog(state.deploymentLog);
          // Abrir el más reciente automáticamente
          setOpenAccordions(new Set([state.deploymentLog[0].id]));
        }
        if (state?.isRunning && state.activeDomain) {
          setDesplegando(true);
        }
      } catch { /* silencioso */ }
    })();
  }, []);

  // ── Cargar servidores configurados ─────────────────────────────────────────
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

  // ── Escuchar config:updated ────────────────────────────────────────────────
  useEffect(() => {
    const handler = (cfg: any) => {
      if (!cfg?.config?.destinationServers) return;
      const d = cfg.config.destinationServers.map((s: any) => s.name).filter(Boolean);
      setServidores(d);
    };
    api?.receive('config:updated', handler);
    return () => api?.removeListener('config:updated', handler);
  }, []);

  // ── Cleanup al desmontar ────────────────────────────────────────────────────
  useEffect(() => {
    return () => { cleanupRef.current?.(); cleanupRef.current = null; };
  }, []);

  // ── Escuchar app:state-update para sincronizar deploymentLog ───────────────
  useEffect(() => {
    const handler = (payload: any) => {
      if (payload?.module !== 'sourcesync' || !payload?.state) return;
      const sl = payload.state;
      if (sl.deploymentLog) setDeploymentLog([...sl.deploymentLog]);
      if (typeof sl.isRunning === 'boolean') setDesplegando(sl.isRunning);
    };
    api?.receive('app:state-update', handler);
    return () => api?.removeListener('app:state-update', handler);
  }, []);

  // ── Toggle acordeón ────────────────────────────────────────────────────────
  const toggleAccordion = useCallback((id: string) => {
    setOpenAccordions(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  // ── Validación del formulario ─────────────────────────────────────────────
  const formularioValido = !!(serverName.trim() && domain.trim() && httpsUrl.trim() && parsearUrl(httpsUrl));

  // ── Iniciar despliegue ────────────────────────────────────────────────────
  const handleDesplegar = useCallback(async () => {
    if (!formularioValido || desplegando) return;

    const parsed = parsearUrl(httpsUrl);
    if (!parsed) { toast.error('URL de GitHub inválida. Formato: https://github.com/org/repo'); return; }

    const entryId = `${domain.trim()}-${Date.now()}`;
    activeEntryIdRef.current = entryId;

    // Crear entrada local inmediatamente (UI responde antes de que AppState actualice)
    const localEntry: DeployEntry = {
      id: entryId,
      domain: domain.trim(),
      serverName: serverName.trim(),
      startedAt: Date.now(),
      steps: [{ paso: 'inicio', progreso: 0, mensaje: `Iniciando despliegue de "${domain.trim()}" en servidor "${serverName.trim()}"...`, ts: Date.now() }],
      status: 'running',
    };

    setDeploymentLog(prev => [localEntry, ...prev.filter(e => e.id !== entryId)].slice(0, 20));
    setOpenAccordions(prev => new Set([entryId, ...prev]));
    setDesplegando(true);

    // Suscribir a progreso en tiempo real (enriquece la entrada local)
    if (cleanupRef.current) cleanupRef.current();

    const progressHandler = (evento: any) => {
      const step: DeployStep = {
        paso: evento.paso || '',
        progreso: evento.progreso ?? 0,
        mensaje: evento.mensaje || '',
        ts: Date.now(),
      };
      setDeploymentLog(prev => {
        const idx = prev.findIndex(e => e.id === entryId);
        if (idx === -1) return prev;
        const updated = [...prev];
        updated[idx] = { ...updated[idx], steps: [...updated[idx].steps, step] };
        return updated;
      });
    };

    api?.receive('sourcesync:progreso', progressHandler);
    cleanupRef.current = () => api?.removeListener('sourcesync:progreso', progressHandler);

    try {
      const resultado = await api?.invoke('sourcesync:deploy', {
        serverName: serverName.trim(),
        domain: domain.trim(),
        httpsUrl: httpsUrl.trim(),
        repoOwner: parsed.repoOwner,
        repoName: parsed.repoName,
        vincularGitHub,
        rama: 'main',
      });

      const finalStatus: DeployStatus = resultado?.success ? 'success' : 'error';
      const finalMsg = resultado?.success
        ? `Despliegue completado. Node.js ${resultado.versionNode}. Repo: ${resultado.urlSsh || httpsUrl}`
        : `Error: ${resultado?.error || 'Error desconocido.'}`;

      setDeploymentLog(prev => {
        const idx = prev.findIndex(e => e.id === entryId);
        if (idx === -1) return prev;
        const updated = [...prev];
        updated[idx] = {
          ...updated[idx],
          status: finalStatus,
          finishedAt: Date.now(),
          steps: [...updated[idx].steps, { paso: finalStatus, progreso: resultado?.success ? 100 : 0, mensaje: finalMsg, ts: Date.now() }],
        };
        return updated;
      });

      if (resultado?.success) {
        toast.success('Despliegue configurado correctamente.');
        onLog(`[SOURCESYNC] ${finalMsg}`, 'success', 'sourcesync');
      } else {
        toast.error(resultado?.error || 'Error en el despliegue.');
        onLog(`[SOURCESYNC] Error: ${resultado?.error}`, 'error', 'sourcesync');
      }
    } catch (err: any) {
      const errMsg = err?.message || 'Error de comunicación IPC.';
      setDeploymentLog(prev => {
        const idx = prev.findIndex(e => e.id === entryId);
        if (idx === -1) return prev;
        const updated = [...prev];
        updated[idx] = {
          ...updated[idx],
          status: 'error',
          finishedAt: Date.now(),
          steps: [...updated[idx].steps, { paso: 'error', progreso: 0, mensaje: `Error inesperado: ${errMsg}`, ts: Date.now() }],
        };
        return updated;
      });
      toast.error(errMsg);
      onLog(`[SOURCESYNC] Error inesperado: ${errMsg}`, 'error', 'sourcesync');
    } finally {
      setDesplegando(false);
      cleanupRef.current?.();
      cleanupRef.current = null;
      activeEntryIdRef.current = null;
    }
  }, [formularioValido, desplegando, serverName, domain, httpsUrl, vincularGitHub, toast, onLog]);

  // ─────────────────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">

      {/* ── Header ── */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="font-display text-xl font-bold flex items-center gap-2">
            <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 6, backgroundColor: 'var(--color-accent-bg)', color: 'var(--color-accent)' }}>
              <IconRocket />
            </span>
            SourceSync
          </h1>
          <p className="text-sm mt-0.5" style={{ color: 'var(--text-muted)' }}>
            Despliegue automatizado de proyectos Next.js (Standalone) a Plesk vía Git
          </p>
        </div>
      </div>

      {/* ── Formulario ── */}
      <section>
        <h2 className="font-display text-base font-bold mb-4">Configurar despliegue</h2>
        <div className="card p-5 space-y-4">

          {/* Servidor */}
          <div>
            <label htmlFor="sourcesync-server" className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
              Servidor Plesk destino
            </label>
            {servidores.length > 0 ? (
              <select
                id="sourcesync-server"
                value={serverName}
                onChange={e => setServerName(e.target.value)}
                disabled={desplegando}
                className="input text-sm"
                style={{ width: '100%', fontFamily: 'var(--font-mono)' }}
              >
                {servidores.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            ) : (
              <p className="text-xs py-2 px-3 rounded" style={{ color: 'var(--color-warning)', backgroundColor: 'var(--color-warning-bg)', border: '1px solid var(--color-warning)' }}>
                No hay servidores Plesk configurados. Agregue uno desde el Panel principal.
              </p>
            )}
          </div>

          {/* Dominio */}
          <div>
            <label htmlFor="sourcesync-domain" className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
              Dominio de destino
            </label>
            <input
              id="sourcesync-domain"
              type="text"
              value={domain}
              onChange={e => setDomain(e.target.value)}
              disabled={desplegando}
              placeholder="ej: app.example.com"
              className="input font-mono text-sm"
              style={{ width: '100%' }}
            />
          </div>

          {/* URL repo */}
          <div>
            <label htmlFor="sourcesync-repo" className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
              URL HTTPS del repositorio GitHub
            </label>
            <div className="flex items-center gap-2">
              <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}><IconGithub /></span>
              <input
                id="sourcesync-repo"
                type="text"
                value={httpsUrl}
                onChange={e => setHttpsUrl(e.target.value)}
                disabled={desplegando}
                placeholder="https://github.com/organización/repositorio"
                className="input font-mono text-sm flex-1"
              />
            </div>
            {httpsUrl && !parsearUrl(httpsUrl) && (
              <p className="text-xs mt-1" style={{ color: 'var(--color-error)' }}>
                URL inválida. Formato requerido: https://github.com/org/repo
              </p>
            )}
          </div>

          {/* Checkbox vincular */}
          <div className="flex items-center gap-3 py-1">
            <input
              id="sourcesync-vincular"
              type="checkbox"
              checked={vincularGitHub}
              onChange={e => setVincularGitHub(e.target.checked)}
              disabled={desplegando}
              style={{ width: 14, height: 14, flexShrink: 0, accentColor: 'var(--color-accent)', cursor: desplegando ? 'not-allowed' : 'pointer' }}
            />
            <label htmlFor="sourcesync-vincular" className="text-sm" style={{ color: 'var(--text-secondary)', cursor: desplegando ? 'not-allowed' : 'pointer' }}>
              Generar y registrar llave SSH Ed25519 en GitHub
              <span className="block text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                Desmarca si el dominio ya tiene la llave configurada
              </span>
            </label>
          </div>

          {/* Botón */}
          <div className="flex items-center gap-3 pt-1">
            <button
              id="sourcesync-btn-deploy"
              onClick={handleDesplegar}
              disabled={desplegando || !formularioValido}
              className="btn btn--primary text-xs flex items-center gap-2"
            >
              {desplegando
                ? <><span className="spinner" />Desplegando...</>
                : <><IconRocket />Iniciar Despliegue</>
              }
            </button>
            {deploymentLog.length > 0 && !desplegando && (
              <button
                onClick={() => setDeploymentLog([])}
                className="btn btn--ghost text-xs"
                style={{ color: 'var(--text-muted)' }}
              >
                Limpiar historial
              </button>
            )}
          </div>
        </div>
      </section>

      {/* ── Terminal Accordion ── */}
      {deploymentLog.length > 0 && (
        <section>
          <h2 className="font-display text-base font-bold mb-3 flex items-center gap-2">
            <span style={{ color: 'var(--text-muted)' }}><IconTerminal /></span>
            Historial de despliegues
            <span
              className="text-xs font-mono px-1.5 py-0.5 rounded"
              style={{ color: 'var(--text-muted)', backgroundColor: 'var(--surface-overlay)' }}
            >
              {deploymentLog.length}
            </span>
          </h2>
          <div className="space-y-2">
            {deploymentLog.map(entry => (
              <AccordionItem
                key={entry.id}
                entry={entry}
                isOpen={openAccordions.has(entry.id)}
                onToggle={() => toggleAccordion(entry.id)}
              />
            ))}
          </div>
        </section>
      )}

      {/* ── Nota técnica ── */}
      <section>
        <div className="p-4 rounded-lg text-xs space-y-1.5" style={{ backgroundColor: 'var(--color-info-bg)', border: '1px solid var(--color-info)', color: 'var(--text-secondary)' }}>
          <p className="font-medium" style={{ color: 'var(--color-info)' }}>Requisitos previos</p>
          <p>• El GitHub API Token debe estar configurado en <strong>Configuración → Integraciones Externas</strong>.</p>
          <p>• El repositorio debe contener <code className="font-mono px-1 rounded" style={{ backgroundColor: 'oklch(0 0 0 / 0.3)' }}>deploy.sh</code> en la raíz.</p>
          <p>• Node.js v24.15.0 se usará como fallback si las versiones LTS están deshabilitadas en Plesk.</p>
          <p>• El despliegue es idempotente: puede re-ejecutarse sin duplicar la configuración.</p>
        </div>
      </section>
    </div>
  );
};

export default SourceSyncModule;
