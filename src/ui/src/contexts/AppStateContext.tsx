import { createContext, useContext, useReducer, useCallback, useEffect, useRef, type Dispatch } from 'react';
import { useMainState, type ModuleProcessState } from '../hooks/useMainState';

// ── Types ──

export interface ModuleOperationState {
  statusMessage: string;
  results: Array<{ domain: string; status: string; message: string }>;
  progress: { current: number; total: number };
  loading: boolean;
  logs: Array<{ message: string; type: string; timestamp: number }>;
  selectedAccount: string;
  selectedCloud: string;
  domainList: string;
  filterApplied: boolean;
  zones?: Array<{ domain: string; zoneName: string | null; zoneStatus: string; aRecord: { ip: string; proxied: boolean; ttl: number } | null; cnameRecord: { target: string; proxied: boolean } | null; error?: string; lastCloudflareSync?: string }>;
  isRunning?: boolean;
}

export interface ServerStatusData {
  isLinked: boolean;
  status: 'online' | 'offline' | 'unknown';
  diagnostics?: {
    ram: { used: number; total: number; percent: number };
    disk: { used: number; total: number; percent: number };
    cpu: { load: number; cores: number };
    uptime: string;
  };
}

export interface AppState {
  modules: Record<string, ModuleOperationState>;
  serverStatuses: Record<string, ServerStatusData>;
}

// ── Constants ──

const DEFAULT_MODULE_STATE: ModuleOperationState = {
  statusMessage: '',
  results: [],
  progress: { current: 0, total: 0 },
  loading: false,
  logs: [],
  selectedAccount: '',
  selectedCloud: '',
  domainList: '',
  filterApplied: false,
  zones: [],
};

const INITIAL_STATE: AppState = {
  modules: {},
  serverStatuses: {},
};

// ── Actions ──

type AppStateAction =
  | { type: 'SET_MODULE_STATE'; moduleId: string; partial: Partial<ModuleOperationState> }
  | { type: 'CLEAR_MODULE_STATE'; moduleId: string }
  | { type: 'SET_SERVER_STATUS'; serverName: string; status: ServerStatusData };

// ── Reducer ──

function appStateReducer(state: AppState, action: AppStateAction): AppState {
  switch (action.type) {
    case 'SET_MODULE_STATE': {
      const current = state.modules[action.moduleId] ?? DEFAULT_MODULE_STATE;
      return {
        ...state,
        modules: {
          ...state.modules,
          [action.moduleId]: { ...current, ...action.partial },
        },
      };
    }
    case 'CLEAR_MODULE_STATE': {
      const next = { ...state.modules };
      delete next[action.moduleId];
      return {
        ...state,
        modules: next,
      };
    }
    case 'SET_SERVER_STATUS': {
      return {
        ...state,
        serverStatuses: {
          ...state.serverStatuses,
          [action.serverName]: action.status,
        },
      };
    }
    default:
      return state;
  }
}

// ── Context ──

interface AppStateContextValue {
  state: AppState;
  dispatch: Dispatch<AppStateAction>;
}

const AppStateContext = createContext<AppStateContextValue | null>(null);

// ── Provider ──

export const AppStateProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [state, dispatch] = useReducer(appStateReducer, INITIAL_STATE);
  const { state: mainState } = useMainState();

  // Hydrate from Main process on mount + updates
  useEffect(() => {
    if (!mainState) return;

    const moduleMap: Record<string, string> = {
      extraction: 'extraction',
      deployment: 'deployment',
      cloudflare: 'dns',
      ssl: 'ssl',
      malware: 'validation',
    };

    for (const [moduleKey, moduleState] of Object.entries(mainState)) {
      const ms = moduleState as ModuleProcessState;
      const ctxModuleId = moduleMap[moduleKey];
      if (!ctxModuleId) continue;

      const hasResults = ms.results && ms.results.length > 0;
      if (ms.isRunning || hasResults) {
        const partial: Partial<ModuleOperationState> = {
          loading: !!ms.isRunning,
          progress: {
            current: ms.isRunning ? ms.currentProgress : 100,
            total: ms.totalDomains,
          },
          statusMessage: ms.currentMessage || '',
        };

        // 🔥 v1.14: solo inyectar results si Main realmente los tiene.
        // Si no (resetModuleState acaba de borrarlos), preservar la pending list
        // que el frontend ya asignó en el reducer (handleSyncAll).
        if (hasResults) {
          partial.results = ms.results.map((r) => ({
            domain: r.domain,
            status: r.status,
            message: r.message,
          }));
        }

        dispatch({
          type: 'SET_MODULE_STATE',
          moduleId: ctxModuleId,
          partial,
        });
      } else {
        // 🔥 HARDENING v1.6.3: módulo idle sin resultados → forzar UI a estado inicial
        // Esto asegura que labels y botones vuelvan a estado original ("Consultar estado Cloudflare")
        dispatch({
          type: 'SET_MODULE_STATE',
          moduleId: ctxModuleId,
          partial: {
            loading: false,
            progress: { current: 0, total: 0 },
            statusMessage: '',
            results: [],
          },
        });
      }
    }
  }, [mainState]);

  return (
    <AppStateContext.Provider value={{ state, dispatch }}>
      {children}
    </AppStateContext.Provider>
  );
};

// ── Hooks ──

function useAppStateContext(): AppStateContextValue {
  const ctx = useContext(AppStateContext);
  if (!ctx) {
    throw new Error('useAppStateContext must be used within an AppStateProvider');
  }
  return ctx;
}

/**
 * Access the full AppState and raw dispatch. Use this only in rare cases
 * where you need cross-module state management. Prefer useModuleState.
 */
export function useAppState(): {
  state: AppState;
  setModuleState: (moduleId: string, partial: Partial<ModuleOperationState>) => void;
  clearModuleState: (moduleId: string) => void;
  setServerStatus: (serverName: string, status: ServerStatusData) => void;
} {
  const { state, dispatch } = useAppStateContext();

  const setModuleState = useCallback(
    (moduleId: string, partial: Partial<ModuleOperationState>) => {
      dispatch({ type: 'SET_MODULE_STATE', moduleId, partial });
    },
    [dispatch],
  );

  const clearModuleState = useCallback(
    (moduleId: string) => {
      dispatch({ type: 'CLEAR_MODULE_STATE', moduleId });
    },
    [dispatch],
  );

  const setServerStatus = useCallback(
    (serverName: string, status: ServerStatusData) => {
      dispatch({ type: 'SET_SERVER_STATUS', serverName, status });
    },
    [dispatch],
  );

  return { state, setModuleState, clearModuleState, setServerStatus };
}

/**
 * Primary API for modules. Returns [state, setPartial] — like useState
 * but persists across mounts/unmounts.
 *
 * @example
 * ```ts
 * const [dnsState, setDnsState] = useModuleState('dns');
 * setDnsState({ loading: true, statusMessage: 'Sincronizando dominios...' });
 * ```
 */
export function useModuleState(
  moduleId: string,
): [ModuleOperationState, (partialOrFn: Partial<ModuleOperationState> | ((prev: ModuleOperationState) => Partial<ModuleOperationState>)) => void] {
  const { state, dispatch } = useAppStateContext();

  const moduleState: ModuleOperationState =
    state.modules[moduleId] ?? DEFAULT_MODULE_STATE;

  const modulesRef = useRef(state.modules);
  modulesRef.current = state.modules;

  const setPartial = useCallback(
    (partialOrFn: Partial<ModuleOperationState> | ((prev: ModuleOperationState) => Partial<ModuleOperationState>)) => {
      const current = modulesRef.current[moduleId] ?? DEFAULT_MODULE_STATE;
      const partial = typeof partialOrFn === 'function'
        ? partialOrFn(current)
        : partialOrFn;
      dispatch({ type: 'SET_MODULE_STATE', moduleId, partial });
    },
    [dispatch, moduleId],
  );

  return [moduleState, setPartial];
}
