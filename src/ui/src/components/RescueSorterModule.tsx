import { useState, useEffect, useRef } from 'react';

interface SorterLog {
  id: string;
  timestamp: number;
  message: string;
  type: 'info' | 'success' | 'warning' | 'error';
}

type Mode = 'organizar' | 'diet' | 'massivetar';

interface RescueSorterModuleProps {
  logs?: { message: string; type: string; timestamp?: number; source?: string }[];
}

export default function RescueSorterModule({ logs: _logs }: RescueSorterModuleProps = {}) {
  const [mode, setMode] = useState<Mode>('organizar');

  // Modo Organizar
  const [dbFolderPath, setDbFolderPath] = useState<string>('');

  // Modo Diet
  const [cloudPath, setCloudPath] = useState<string>('');
  const [dietDbPath, setDietDbPath] = useState<string>('');

  // Extractor Masivo
  const [massiveTarPath, setMassiveTarPath] = useState<string>('');
  const [massiveDestPath, setMassiveDestPath] = useState<string>('');

  const [isProcessing, setIsProcessing] = useState(false);
  const [logs, setLogs] = useState<SorterLog[]>([]);
  const logsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  useEffect(() => {
    if (!window.api) return;
    const cleanup = window.api.receive('rescuesorter:progress', (data: any) => {
      setLogs(prev => [...prev, {
        id: Math.random().toString(36).substring(7),
        timestamp: Date.now(),
        message: data.message,
        type: data.type as SorterLog['type'],
      }]);
    });
    return () => {
      if (typeof cleanup === 'function') cleanup();
    };
  }, []);

  const addLog = (message: string, type: SorterLog['type'] = 'info') => {
    setLogs(prev => [...prev, {
      id: Math.random().toString(36).substring(7),
      timestamp: Date.now(),
      message,
      type,
    }]);
  };

  const selectFolder = async (title: string): Promise<string | null> => {
    if (!window.api) return null;
    try {
      const result = await window.api.invoke('dialog:open-directory', { title }) as any;
      if (result?.success && result.path) return result.path;
    } catch { /* ignore */ }
    return null;
  };

  // ── Modo Organizar ──────────────────────────────────────────────
  const handleProcess = async () => {
    if (!dbFolderPath || !window.api) return;
    setIsProcessing(true);
    setLogs([]);
    try {
      const result = await window.api.invoke('rescuesorter:process', { sourcePath: dbFolderPath }) as any;
      if (result.success) {
        addLog(`Proceso completado. Dominios organizados: ${result.organizedCount}`, 'success');
      } else {
        addLog(`Error en el proceso: ${result.error}`, 'error');
      }
    } catch (err: any) {
      addLog(`Fallo catastrófico: ${err.message}`, 'error');
    } finally {
      setIsProcessing(false);
    }
  };

  // ── Modo Diet ──────────────────────────────────────────────────
  const handleDietProcess = async () => {
    if (!cloudPath || !window.api) return;
    setIsProcessing(true);
    setLogs([]);
    try {
      const result = await window.api.invoke('rescuesorter:diet-mode', {
        cloudPath,
        dbFolderPath: dietDbPath || null,
      }) as any;
      if (result.success) {
        addLog(`✅ Diet completado — Procesados: ${result.processed} | Omitidos: ${result.skipped}`, 'success');
      } else {
        addLog(`Error: ${result.error}`, 'error');
      }
    } catch (err: any) {
      addLog(`Fallo catastrófico: ${err.message}`, 'error');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleMassiveExtract = async () => {
    if (!massiveTarPath || !massiveDestPath || !window.api) return;
    setIsProcessing(true);
    setLogs([]);
    try {
      const result = await window.api.invoke('rescuesorter:extract-massive-tar', {
        tarPath: massiveTarPath,
        destDir: massiveDestPath,
      }) as any;
      if (result.success) {
        addLog(`✅ Extracción Masiva completada con éxito.`, 'success');
      } else if (result.cancelled) {
        addLog(`⚠️ Extracción cancelada por el usuario.`, 'warning');
      } else {
        addLog(`❌ Error en extracción: ${result.error || 'Código de error desconocido'}`, 'error');
      }
    } catch (err: any) {
      addLog(`Fallo catastrófico: ${err.message}`, 'error');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleCancelMassive = async () => {
    if (!window.api || !isProcessing) return;
    addLog(`⏳ Solicitando cancelación...`, 'warning');
    await window.api.invoke('rescuesorter:cancel-massive-tar');
  };

  const canRunOrganizar = !!dbFolderPath && !isProcessing;
  const canRunDiet = !!cloudPath && !isProcessing;
  const canRunMassive = !!massiveTarPath && !!massiveDestPath && !isProcessing;

  const selectFile = async (title: string, filters: any[]): Promise<string | null> => {
    if (!window.api) return null;
    try {
      const result = await window.api.invoke('dialog:open-file', { title, filters }) as any;
      if (result?.success) return result.filePath || result.path;
    } catch { /* ignore */ }
    return null;
  };

  return (
    <div className="flex flex-col h-full bg-background overflow-hidden">
      
      {/* ── Page Header ── */}
      <div className="flex-none px-lg pt-lg pb-md border-b border-outline-variant/30">
        <h2 className="font-display-lg text-display-lg text-secondary mb-xs">
          Organizador de Rescate (Hostinger)
        </h2>
        <p className="font-body-md text-on-surface-variant max-w-2xl">
          Organiza, aplica la dieta Ultra-Lite o extrae masivamente backups gigantes de Hostinger.
        </p>
      </div>

      {/* ── Tabs de modo ── */}
      <div className="flex-none px-lg py-md border-b border-outline-variant/30 bg-surface-container-low">
        <div className="flex gap-sm">
          {(['organizar', 'diet', 'massivetar'] as Mode[]).map(m => (
            <button
              key={m}
              onClick={() => { setMode(m); setLogs([]); }}
              disabled={isProcessing}
              className={`font-label-caps text-label-caps px-md py-sm rounded border transition-all ${
                mode === m
                  ? 'bg-secondary-container/20 text-secondary border-secondary/50'
                  : 'bg-surface-container text-outline border-outline-variant hover:border-outline'
              }`}
            >
              {m === 'organizar' ? '📁 Organizar' : m === 'diet' ? '🥗 Modo Diet' : '📦 Extractor Masivo'}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 flex flex-col min-h-0">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-lg p-lg flex-1 min-h-0">
          
          {/* ── Panel de controles (Columna Izquierda) ── */}
          <div className="flex flex-col h-full">
            <div className="bg-surface-container-low border border-outline-variant p-lg rounded flex-1 flex flex-col h-full">
              {mode === 'organizar' ? (
                <div className="flex flex-col h-full">
                  <p className="font-body-md text-on-surface-variant mb-md">
                    Seleccioná la carpeta <strong>db/</strong> que contiene los .sql.gz. Kraken escaneará
                    los dominios un nivel más arriba y emparejará cada web con su base de datos.
                  </p>
                  <div className="space-y-xs mt-auto pb-lg">
                    <label className="font-label-caps text-label-caps text-outline">Carpeta DB/</label>
                    <div className="flex items-center gap-sm">
                      <button onClick={async () => { const p = await selectFolder('Seleccionar carpeta db/'); if (p) setDbFolderPath(p); }} disabled={isProcessing} className="px-md py-sm bg-surface-container-highest border border-outline-variant rounded hover:bg-surface-bright transition-colors text-on-surface-variant shrink-0 font-label-caps text-label-caps">
                        Seleccionar
                      </button>
                      <span className="flex-1 px-sm py-sm font-code-md text-code-md truncate rounded bg-surface-container border border-outline-variant" style={{ color: dbFolderPath ? 'var(--color-on-surface)' : 'var(--color-outline)' }}>
                        {dbFolderPath || 'Ninguna carpeta seleccionada...'}
                      </span>
                    </div>
                  </div>
                  <div className="flex justify-end pt-md border-t border-outline-variant/30 mt-auto shrink-0">
                    <button onClick={handleProcess} disabled={!canRunOrganizar} className={`flex items-center gap-xs px-xl py-sm font-title-sm rounded transition-all active:scale-95 ${canRunOrganizar ? 'bg-secondary-container text-on-secondary-container hover:brightness-110' : 'bg-surface-container-highest text-outline cursor-not-allowed'}`}>
                      {isProcessing ? <><span className="w-4 h-4 rounded-full border-2 border-outline border-t-transparent animate-spin shrink-0" />Procesando...</> : 'Iniciar Organización'}
                    </button>
                  </div>
                </div>
              ) : mode === 'diet' ? (
                <div className="flex flex-col h-full">
                  <p className="font-body-md text-on-surface-variant mb-md">
                    Seleccioná la carpeta raíz del <strong>Cloud</strong>. Kraken detectará automáticamente
                    si cada dominio es <strong>Legacy</strong> (.tar.gz + .sql) o <strong>Raw</strong>
                    (public_html + db/) y aplicará la dieta correspondiente.
                  </p>

                  <div className="space-y-md mt-auto pb-lg">
                    {/* Carpeta Cloud */}
                    <div className="space-y-xs">
                      <label className="font-label-caps text-label-caps text-outline">Carpeta Cloud</label>
                      <div className="flex items-center gap-sm">
                        <button onClick={async () => { const p = await selectFolder('Seleccionar carpeta del Cloud'); if (p) setCloudPath(p); }} disabled={isProcessing} className="px-md py-sm bg-surface-container-highest border border-outline-variant rounded hover:bg-surface-bright transition-colors text-on-surface-variant shrink-0 font-label-caps text-label-caps whitespace-nowrap">
                          📂 Seleccionar
                        </button>
                        <span className="flex-1 px-sm py-sm font-code-md text-code-md truncate rounded bg-surface-container border border-outline-variant" style={{ color: cloudPath ? 'var(--color-on-surface)' : 'var(--color-outline)' }}>
                          {cloudPath || 'Ninguna carpeta seleccionada...'}
                        </span>
                      </div>
                    </div>

                    {/* Carpeta db/ (opcional para escenario Raw) */}
                    <div className="space-y-xs">
                      <label className="font-label-caps text-label-caps text-outline">Carpeta db/ (opcional para Raw)</label>
                      <div className="flex items-center gap-sm">
                        <button onClick={async () => { const p = await selectFolder('Seleccionar carpeta db/ (opcional, solo si hay public_html)'); if (p) setDietDbPath(p); }} disabled={isProcessing} className="px-md py-sm bg-surface-container-highest border border-outline-variant rounded hover:bg-surface-bright transition-colors text-on-surface-variant shrink-0 font-label-caps text-label-caps whitespace-nowrap">
                          🗄 Seleccionar
                        </button>
                        <span className="flex-1 px-sm py-sm font-code-md text-code-md truncate rounded bg-surface-container border border-outline-variant" style={{ color: dietDbPath ? 'var(--color-on-surface)' : 'var(--color-outline)' }}>
                          {dietDbPath || 'No seleccionada'}
                        </span>
                        {dietDbPath && (
                          <button onClick={() => setDietDbPath('')} disabled={isProcessing} className="p-sm bg-surface-container-highest rounded border border-outline-variant hover:bg-error/20 hover:text-error transition-colors shrink-0">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="bg-surface-container-lowest border border-outline-variant p-sm rounded font-body-sm text-on-surface-variant space-y-xs">
                      <div><strong className="text-on-surface">Escenario Legacy</strong> — Detectado cuando hay <code>{'{dominio}.tar.gz'}</code> + <code>{'{dominio}.sql'}</code>. Solo requiere la carpeta Cloud.</div>
                      <div><strong className="text-on-surface">Escenario Raw</strong> — Detectado cuando hay <code>public_html/</code>. Requiere también la carpeta <code>db/</code> con los .sql.gz.</div>
                    </div>
                  </div>

                  <div className="flex justify-end pt-md border-t border-outline-variant/30 mt-auto shrink-0">
                    <button onClick={handleDietProcess} disabled={!canRunDiet} className={`flex items-center gap-xs px-xl py-sm font-title-sm rounded transition-all active:scale-95 ${canRunDiet ? 'bg-secondary-container text-on-secondary-container hover:brightness-110' : 'bg-surface-container-highest text-outline cursor-not-allowed'}`}>
                      {isProcessing ? <><span className="w-4 h-4 rounded-full border-2 border-outline border-t-transparent animate-spin shrink-0" />Aplicando...</> : '🥗 Aplicar Dieta Ultra-Lite'}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col h-full">
                  <p className="font-body-md text-on-surface-variant mb-md">
                    Selecciona un archivo <strong>.tar.gz gigante</strong> (ej. 60GB+) y una carpeta destino.
                    El proceso extraerá directamente usando <code>tar</code> nativo, saltándose archivos que ya existan. 
                    Ideal para retomar descargas o extracciones rotas.
                  </p>

                  <div className="space-y-md mt-auto pb-lg">
                    {/* Archivo TarMasivo */}
                    <div className="space-y-xs">
                      <label className="font-label-caps text-label-caps text-outline">Archivo .tar.gz</label>
                      <div className="flex items-center gap-sm">
                        <button onClick={async () => { const p = await selectFile('Seleccionar archivo .tar.gz', [{ name: 'Tarball Gzip', extensions: ['tar.gz', 'tar', 'tgz'] }]); if (p) setMassiveTarPath(p); }} disabled={isProcessing} className="px-md py-sm bg-surface-container-highest border border-outline-variant rounded hover:bg-surface-bright transition-colors text-on-surface-variant shrink-0 font-label-caps text-label-caps whitespace-nowrap">
                          📦 Seleccionar
                        </button>
                        <span className="flex-1 px-sm py-sm font-code-md text-code-md truncate rounded bg-surface-container border border-outline-variant" style={{ color: massiveTarPath ? 'var(--color-on-surface)' : 'var(--color-outline)' }}>
                          {massiveTarPath || 'Ningún archivo tar.gz seleccionado...'}
                        </span>
                      </div>
                    </div>

                    {/* Carpeta Destino */}
                    <div className="space-y-xs">
                      <label className="font-label-caps text-label-caps text-outline">Carpeta Destino</label>
                      <div className="flex items-center gap-sm">
                        <button onClick={async () => { const p = await selectFolder('Seleccionar carpeta destino para extracción'); if (p) setMassiveDestPath(p); }} disabled={isProcessing} className="px-md py-sm bg-surface-container-highest border border-outline-variant rounded hover:bg-surface-bright transition-colors text-on-surface-variant shrink-0 font-label-caps text-label-caps whitespace-nowrap">
                          📂 Seleccionar
                        </button>
                        <span className="flex-1 px-sm py-sm font-code-md text-code-md truncate rounded bg-surface-container border border-outline-variant" style={{ color: massiveDestPath ? 'var(--color-on-surface)' : 'var(--color-outline)' }}>
                          {massiveDestPath || 'Ninguna carpeta seleccionada...'}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="flex justify-end gap-md pt-md border-t border-outline-variant/30 mt-auto shrink-0">
                    {isProcessing && (
                      <button onClick={handleCancelMassive} className="px-lg py-sm font-title-sm bg-error/20 text-error hover:bg-error/30 rounded border border-error/50 transition-all active:scale-95">
                        Cancelar
                      </button>
                    )}
                    <button onClick={handleMassiveExtract} disabled={!canRunMassive} className={`flex items-center gap-xs px-xl py-sm font-title-sm rounded transition-all active:scale-95 ${canRunMassive ? 'bg-secondary-container text-on-secondary-container hover:brightness-110' : 'bg-surface-container-highest text-outline cursor-not-allowed'}`}>
                      {isProcessing ? <><span className="w-4 h-4 rounded-full border-2 border-outline border-t-transparent animate-spin shrink-0" />Extrayendo...</> : '📦 Iniciar Extracción Masiva'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* ── Terminal de logs (Columna Derecha) ── */}
          <div className="flex flex-col h-full bg-surface-container-low border border-outline-variant rounded min-h-[400px]">
            <div className="bg-surface-container-high px-md py-sm flex items-center justify-between border-b border-outline-variant shrink-0">
              <span className="font-label-caps text-label-caps text-outline uppercase tracking-wider">
                Registro de Operaciones
              </span>
            </div>
            <div className="flex-1 overflow-auto p-md space-y-1 bg-black font-code-sm text-code-sm scanline-effect">
              {logs.length === 0 ? (
                <div className="text-outline italic">Esperando inicio de operación...</div>
              ) : (
                logs.map(log => {
                  let colorClass = 'text-on-surface-variant';
                  if (log.type === 'success') colorClass = 'text-green-400';
                  if (log.type === 'error')   colorClass = 'text-error';
                  if (log.type === 'warning') colorClass = 'text-tertiary';
                  const time = new Date(log.timestamp).toLocaleTimeString('es-ES', { hour12: false });
                  return (
                    <div key={log.id} className={colorClass}>
                      <span className="text-outline mr-2 select-none">[{time}]</span>
                      <span className="break-all">{log.message}</span>
                    </div>
                  );
                })
              )}
              <div ref={logsEndRef} />
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
