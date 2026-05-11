import { useState, useCallback, useEffect, useRef } from 'react';
import Layout from './components/Layout';
import Dashboard from './components/Dashboard';
import ExtractionModule from './components/ExtractionModule';
import DeploymentModule from './components/DeploymentModule';
import DnsSyncModule from './components/DnsSyncModule';
import SslModule from './components/SslModule';
import ConfigPanel from './components/ConfigPanel';
import MalwareScannerModule from './components/MalwareScannerModule';
import TerminalModule from './components/TerminalModule';
import ScalifylabsModule from './components/ScalifylabsModule';
import { ToastProvider } from './components/Toast';
import UpdateNotifier from './components/UpdateNotifier';
import { ConfigProvider } from './contexts/ConfigContext';
import { AppStateProvider } from './contexts/AppStateContext';
import { useIpc } from './hooks/useIpc';
import { useLogBuffer } from './hooks/useLogBuffer';
import type { LogLevel } from './types/ipc';

// ── IDs de módulos que se montan permanentemente ──────────────────────────────
// Cada módulo se renderiza UNA sola vez al iniciar la app y permanece montado
// en el DOM. Cambiar de pestaña solo alterna `display` via CSS, preservando
// el estado interno de React (useState, refs, timers, IPC listeners).
//
// Esto resuelve el desmontaje destructivo que causaba AnimatePresence + key={activeModule}.
const PERSISTENT_MODULE_IDS = [
  'dashboard',
  'extraction',
  'migration',
  'dns',
  'ssl',
  'config',
  'validation',
  'terminal',
  'scalifylabs',
] as const;

type ModuleId = typeof PERSISTENT_MODULE_IDS[number];

// ── Main App ──────────────────────────────────────────────────────────────────
export default function App() {
  const { isConnected, progressEvents } = useIpc();
  const [activeModule, setActiveModule] = useState<ModuleId>('dashboard');

  // Log buffer desacoplado del progress-emitter
  const { entries: logEntries, clear: clearLogs } = useLogBuffer();

  // Tracking legacy de progress events para compatibilidad con módulos antiguos
  const progressLenRef = useRef(0);
  useEffect(() => {
    if (progressEvents.length <= progressLenRef.current) return;
    progressLenRef.current = progressEvents.length;
  }, [progressEvents.length]);

  const handleModuleChange = useCallback((moduleId: string) => {
    if (PERSISTENT_MODULE_IDS.includes(moduleId as ModuleId)) {
      setActiveModule(moduleId as ModuleId);
    }
  }, []);

  // onLog: los logs ya viajan por log:batch desde el Main Process.
  // Esta función existe solo para compatibilidad de prop en módulos heredados.
  const logToConsole = useCallback((_message: string, _type: LogLevel = 'info') => {}, []);

  // Referencia para suprimir warning de isConnected sin usar (se puede usar para UI futura)
  void isConnected;

  return (
    <ConfigProvider>
      <AppStateProvider>
        <ToastProvider>
          <Layout activeModule={activeModule} onModuleChange={handleModuleChange}>
            {/* UpdateNotifier: siempre activo, escucha IPC del autoUpdater */}
            <UpdateNotifier />
            {/*
              Estrategia de persistencia: TODOS los módulos están montados simultáneamente.
              Solo el módulo activo tiene display != 'none'.
              - React mantiene todo el estado interno intacto (hooks, timers, refs).
              - Los listeners IPC siguen funcionando en segundo plano.
              - El usuario puede navegar a DNS mientras una migración corre y volver
                sin perder ni un solo log ni el progreso visual.
              - No se usa AnimatePresence/key porque eso causa remount destructivo.
              - Transición: opacity suave manejada por CSS transition en la clase
                `.module-pane` y `.module-pane--active` (ver index.css).
            */}
            <div className="relative min-h-0 flex-1 flex flex-col">

              <ModulePane id="dashboard" activeModule={activeModule}>
                <Dashboard onLog={logToConsole} />
              </ModulePane>

              <ModulePane id="extraction" activeModule={activeModule}>
                <ExtractionModule onLog={logToConsole} />
              </ModulePane>

              <ModulePane id="migration" activeModule={activeModule}>
                <DeploymentModule onLog={logToConsole} />
              </ModulePane>

              <ModulePane id="dns" activeModule={activeModule}>
                <DnsSyncModule onLog={logToConsole} />
              </ModulePane>

              <ModulePane id="ssl" activeModule={activeModule}>
                <SslModule onLog={logToConsole} />
              </ModulePane>

              <ModulePane id="config" activeModule={activeModule}>
                <ConfigPanel onLog={logToConsole} />
              </ModulePane>

              <ModulePane id="validation" activeModule={activeModule}>
                <MalwareScannerModule onLog={logToConsole} />
              </ModulePane>

              <ModulePane id="terminal" activeModule={activeModule}>
                <TerminalModule entries={logEntries} onClear={clearLogs} />
              </ModulePane>

              <ModulePane id="scalifylabs" activeModule={activeModule}>
                <ScalifylabsModule onLog={logToConsole} />
              </ModulePane>

            </div>
          </Layout>
        </ToastProvider>
      </AppStateProvider>
    </ConfigProvider>
  );
}

// ── ModulePane ─────────────────────────────────────────────────────────────────
// Wrapper que controla visibilidad. No usa conditional rendering ({condition && <C/>})
// porque eso desmonota. Usa display:none que oculta sin desmontar.
interface ModulePaneProps {
  id: string;
  activeModule: string;
  children: React.ReactNode;
}

function ModulePane({ id, activeModule, children }: ModulePaneProps) {
  const isActive = id === activeModule;
  return (
    <div
      role="tabpanel"
      aria-label={id}
      style={{
        display: isActive ? 'flex' : 'none',
        flexDirection: 'column',
        flex: 1,
        minHeight: 0,
        // Transición de opacidad al volverse visible (no al ocultarse)
        opacity: isActive ? 1 : 0,
        transition: isActive ? 'opacity 0.15s ease-out' : 'none',
      }}
    >
      {children}
    </div>
  );
}
