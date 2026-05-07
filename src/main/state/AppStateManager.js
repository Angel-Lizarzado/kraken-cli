// AppStateManager — Estado global centralizado en el Main Process
// SINGLETON. Persiste en disco via electron-store (ESM).
// Broadcast a TODOS los renderers via webContents.send en cada update.
//
// Uso:
//   const { getAppStateManager } = require('./AppStateManager');
//   const appState = getAppStateManager();
//   await appState.init(); // <-- necesario una vez antes de usar
//   appState.update('extraction', { isRunning: true, currentDomain: 'foo.com' });

const { BrowserWindow } = require('electron');

// ── Referencias lazy a servicios (evita circular deps) ──
let _sshService = null;
function _getSshService() {
  if (!_sshService) {
    try {
      _sshService = require('../../services/ssh-service');
    } catch { return null; }
  }
  return _sshService;
}

let _configManager = null;
function _getConfigManager() {
  if (!_configManager) {
    try {
      _configManager = require('../../services/config-manager');
    } catch { return null; }
  }
  return _configManager;
}

// ── Schema tipado del estado global ──
// Cada módulo tiene: isRunning, currentDomain, progress, message, results, etc.

const DEFAULT_STATE = {
  // Extracción (Hostinger → respaldos locales)
  extraction: {
    isRunning: false,
    currentDomain: '',
    currentProgress: 0,
    currentMessage: '',
    totalDomains: 0,
    currentIndex: 0,
    results: [],
    domainsQueue: [],
    batchAccountName: '',
    batchCloudName: '',
    recentLogs: [],
  },

  // Deployment (respaldos locales → Plesk)
  deployment: {
    isRunning: false,
    currentDomain: '',
    currentProgress: 0,
    currentMessage: '',
    totalDomains: 0,
    currentIndex: 0,
    results: [],
    domainsQueue: [],
    batchAccountName: '',
    batchServerName: '',
    sourceAccount: '',
    sourceCloud: '',
    recentLogs: [],
  },

  // Cloudflare DNS Sync
  cloudflare: {
    isRunning: false,
    currentDomain: '',
    currentProgress: 0,
    currentMessage: '',
    totalDomains: 0,
    currentIndex: 0,
    results: [],
    domainsQueue: [],
    recentLogs: [],
  },

  // SSL Let's Encrypt via Plesk
  ssl: {
    isRunning: false,
    currentDomain: '',
    currentProgress: 0,
    currentMessage: '',
    totalDomains: 0,
    currentIndex: 0,
    results: [],
    domainsQueue: [],
    recentLogs: [],
  },

  // Malware Scanner / Validación
  malware: {
    isRunning: false,
    currentDomain: '',
    currentProgress: 0,
    currentMessage: '',
    totalDomains: 0,
    currentIndex: 0,
    results: [],
    domainsQueue: [],
    recentLogs: [],
  },

  // Estado de conexión SSH (servidores)
  sshConnection: {
    isConnected: false,
    serverId: null,
    serverName: null,
    lastChecked: null,
  },
};

// ── Volatile keys — nunca se persisten a disco ──
const VOLATILE_KEYS = ['results', 'recentLogs', 'domainsQueue', 'currentDomain', 'currentMessage', 'currentProgress', 'currentIndex', 'batchAccountName', 'batchCloudName', 'batchServerName', 'sourceAccount', 'sourceCloud'];

class AppStateManager {
  constructor() {
    this.persistStore = null;
    this.state = {
      extraction: { ...DEFAULT_STATE.extraction },
      deployment: { ...DEFAULT_STATE.deployment },
      cloudflare: { ...DEFAULT_STATE.cloudflare },
      ssl: { ...DEFAULT_STATE.ssl },
      malware: { ...DEFAULT_STATE.malware },
      sshConnection: { ...DEFAULT_STATE.sshConnection },
    };
    this._initialized = false;
    this._broadcastEnabled = true;
  }

  /**
   * Inicializa el store de persistencia.
   * DEBE llamarse una vez desde app.whenReady().
   * electron-store v9+ es ESM puro, así que lo cargamos con import() dinámico.
   */
  async init() {
    if (this._initialized) return;

    const { default: Store } = await import('electron-store');

    this.persistStore = new Store({
      name: 'app-state',
      schema: {
        extraction: { type: 'object', default: DEFAULT_STATE.extraction },
        deployment: { type: 'object', default: DEFAULT_STATE.deployment },
        cloudflare: { type: 'object', default: DEFAULT_STATE.cloudflare },
        ssl: { type: 'object', default: DEFAULT_STATE.ssl },
        malware: { type: 'object', default: DEFAULT_STATE.malware },
      },
    });

    // Restaurar solo campos no-volátiles desde disco
    // results, recentLogs, domainsQueue, currentDomain, currentMessage,
    // currentProgress, currentIndex nunca se persisten — son volátiles
    this.state = {};
    Object.keys(DEFAULT_STATE).forEach(key => {
      const persisted = this.persistStore.get(key, {});
      const defaults = { ...DEFAULT_STATE[key] };
      // Merge: persisted values for non-volatile fields, defaults for volatile fields
      this.state[key] = { ...defaults, ...persisted };
      // Ensure volatile fields always come from defaults (never from disk)
      VOLATILE_KEYS.forEach(vk => {
        if (vk in defaults) {
          this.state[key][vk] = defaults[vk];
        }
      });
    });
    // sshConnection never persists
    this.state.sshConnection = { ...DEFAULT_STATE.sshConnection };

    // Anti-Zombies: reset isRunning on all modules — processes don't survive a restart
    Object.keys(this.state).forEach(key => {
      if (this.state[key] && typeof this.state[key] === 'object') {
        this.state[key].isRunning = false;
        this.state[key].currentDomain = '';
        this.state[key].currentProgress = 0;
        this.state[key].currentMessage = '';
        // Don't clear results — user might want to see what happened before restart
      }
    });

    // Persist the cleaned state (volatile fields excluded) to prevent zombies
    if (this.persistStore) {
      Object.keys(this.state).forEach(key => {
        if (key !== 'sshConnection') {
          const persistable = { ...this.state[key] };
          VOLATILE_KEYS.forEach(vk => {
            delete persistable[vk];
          });
          this.persistStore.set(key, persistable);
        }
      });
    }

    // Inicializar estado SSH con ping real a servidores configurados
    // Fire-and-forget: un fallo en SSH no debe bloquear el arranque
    this.initializeSshStatus().catch(err => {
      console.warn('[AppState] SSH ping falló:', err.message);
    });

    this._initialized = true;
    console.log('[AppState] Store inicializado desde', this.persistStore.path, '| SSH:', this.state.sshConnection.isConnected ? 'conectado' : 'desconectado');
  }

  /**
   * Verifica conectividad SSH activa haciendo ping real a servidores configurados.
   * No asume nada basado en estado previo o conexiones en memoria.
   * Se llama automáticamente desde init(). También se puede llamar manualmente.
   */
  async initializeSshStatus() {
    try {
      const configModule = _getConfigManager();
      if (!configModule) return;
      const configManager = configModule.getConfigManager();
      await configManager.initialize();
      const config = configManager.getConfig();

      const servers = config?.destinationServers || [];
      if (servers.length === 0) {
        this.state.sshConnection = {
          isConnected: false,
          serverId: null,
          serverName: null,
          lastChecked: Date.now(),
        };
        console.log('[AppState] SSH: No hay servidores configurados, estado: desconectado');
        return;
      }

      // Try each configured server — first one to respond wins
      for (const server of servers) {
        if (!server.sshCredentials) continue;

        try {
          const sshModule = _getSshService();
          if (!sshModule) continue;
          const sshService = sshModule.getSshService();

          // Use the existing testConnection method which does connect+echo+disconnect
          const result = await sshService.testConnection(server.sshCredentials);

          if (result.connected) {
            this.state.sshConnection = {
              isConnected: true,
              serverId: server.name,
              serverName: server.name,
              lastChecked: Date.now(),
            };
            console.log(`[AppState] SSH ping exitoso a "${server.name}" — estado: CONECTADO`);
            return;
          }
        } catch (err) {
          console.warn(`[AppState] SSH ping falló para "${server.name}": ${err.message}`);
          // Continue to next server
        }
      }

      // No server responded
      this.state.sshConnection = {
        isConnected: false,
        serverId: null,
        serverName: null,
        lastChecked: Date.now(),
      };
      console.log('[AppState] SSH: Ningún servidor respondió al ping, estado: DESCONECTADO');
    } catch (err) {
      console.error('[AppState] SSH init falló:', err.message);
      this.state.sshConnection = {
        isConnected: false,
        serverId: null,
        serverName: null,
        lastChecked: Date.now(),
      };
    }
  }

  /**
   * Actualiza parcialmente el estado de un módulo.
   * Persiste en disco y broadcast a TODOS los renderers.
   */
  update(module, changes) {
    if (!this.state[module]) {
      console.warn(`[AppState] Módulo desconocido: "${module}"`);
      return;
    }

    this.state[module] = { ...this.state[module], ...changes };

    // Persistir solo campos no-volátiles
    if (this.persistStore) {
      const persistable = { ...this.state[module] };
      VOLATILE_KEYS.forEach(vk => {
        delete persistable[vk];
      });
      this.persistStore.set(module, persistable);
    }

    // Broadcast a todos los renderers vivos (throttled)
    this._broadcastThrottled();
  }

  /**
   * Reemplaza todo el estado de un módulo (útil para restore completo).
   */
  setState(module, fullState) {
    if (!this.state[module]) {
      console.warn(`[AppState] Módulo desconocido: "${module}"`);
      return;
    }

    this.state[module] = { ...fullState };
    if (this.persistStore) {
      const persistable = { ...this.state[module] };
      VOLATILE_KEYS.forEach(vk => {
        delete persistable[vk];
      });
      this.persistStore.set(module, persistable);
    }
    this._broadcastThrottled();
  }

  /**
   * Obtiene el estado completo de un módulo (copia superficial).
   */
  getState(module) {
    if (module) {
      return this.state[module] ? { ...this.state[module] } : null;
    }
    // Si no se pasa módulo, devuelve todo
    return Object.keys(this.state).reduce((acc, key) => {
      acc[key] = { ...this.state[key] };
      return acc;
    }, {});
  }

  /**
   * Resetea un módulo a su estado default.
   */
  reset(module) {
    if (!this.state[module]) {
      console.warn(`[AppState] Módulo desconocido: "${module}"`);
      return;
    }
    this.state[module] = { ...DEFAULT_STATE[module] };
    if (this.persistStore) {
      const persistable = { ...this.state[module] };
      VOLATILE_KEYS.forEach(vk => {
        delete persistable[vk];
      });
      this.persistStore.set(module, persistable);
    }
    this._broadcastThrottled();
  }

  /**
   * Resetea un módulo para una NUEVA operación.
   * A diferencia de reset(), este mantiene el módulo en estado "listo para correr"
   * pero limpia results, recentLogs, currentProgress, currentMessage, currentDomain,
   * currentIndex, totalDomains, domainsQueue.
   * Esencial para evitar acumulación entre corridas.
   */
  resetModuleState(module) {
    if (!this.state[module]) {
      console.warn(`[AppState] Módulo desconocido: "${module}"`);
      return;
    }

    const defaults = DEFAULT_STATE[module];
    // Solo reinicia los campos que corresponden a datos de corrida,
    // mantiene isRunning como está (se pondrá true después)
    this.state[module] = {
      ...this.state[module],
      currentDomain: '',
      currentProgress: 0,
      currentMessage: '',
      totalDomains: 0,
      currentIndex: 0,
      results: [],
      domainsQueue: [],
      recentLogs: [],
      batchAccountName: defaults?.batchAccountName || '',
      batchCloudName: defaults?.batchCloudName || '',
      batchServerName: defaults?.batchServerName || '',
      sourceAccount: defaults?.sourceAccount || '',
      sourceCloud: defaults?.sourceCloud || '',
    };

    // Broadcast inmediato para que la UI vea el reset
    this._broadcast();

    console.log(`[AppState] Estado de módulo "${module}" reseteado para nueva operación`);
  }

  /**
   * Resetea TODOS los módulos a estado default.
   */
  resetAll() {
    Object.keys(DEFAULT_STATE).forEach((module) => {
      this.state[module] = { ...DEFAULT_STATE[module] };
      if (this.persistStore) {
        const persistable = { ...this.state[module] };
        VOLATILE_KEYS.forEach(vk => {
          delete persistable[vk];
        });
        this.persistStore.set(module, persistable);
      }
    });
    this._broadcastThrottled();
  }

  /**
   * Obtiene el estado default para un módulo.
   */
  getDefaultState(module) {
    return DEFAULT_STATE[module] ? { ...DEFAULT_STATE[module] } : null;
  }

  /**
   * Force a full state broadcast to all renderers.
   * Used when the renderer signals it's ready (DOMContentLoaded).
   */
  broadcastFullState() {
    this._broadcast();
  }

  /**
   * Aborta la operación en curso de un módulo.
   * Fuerza isRunning=false, limpia progreso, desconecta SSH si es necesario.
   */
  abortModuleOperation(moduleId, isOperationRunningRef = null) {
    if (!this.state[moduleId]) {
      console.warn(`[AppState] Módulo desconocido para abort: "${moduleId}"`);
      return;
    }

    console.log(`[AppState] Abortando operación de módulo: ${moduleId}`);

    // Resetear estado a default limpio (sin isRunning)
    this.state[moduleId] = { ...DEFAULT_STATE[moduleId] };

    // Resetear el lock global si se pasó una referencia
    if (isOperationRunningRef && isOperationRunningRef !== null) {
      isOperationRunningRef.value = false;
    }

    // Desconectar SSH service si tiene clientes activos
    try {
      const sshModule = require('../../services/ssh-service');
      if (sshModule) {
        const sshService = sshModule.getSshService();
        if (sshService && typeof sshService.disconnectAll === 'function') {
          sshService.disconnectAll().catch(err => {
            console.warn('[AppState] Error al desconectar SSH durante abort:', err.message);
          });
        }
      }
    } catch (err) {
      console.warn('[AppState] SSH service no disponible durante abort:', err.message);
    }

    // Persistir (solo campos no-volátiles)
    if (this.persistStore) {
      const persistable = { ...this.state[moduleId] };
      VOLATILE_KEYS.forEach(vk => {
        delete persistable[vk];
      });
      this.persistStore.set(moduleId, persistable);
    }

    // Broadcast a todos los renderers
    this._broadcastThrottled();

    console.log(`[AppState] Módulo ${moduleId} abortado correctamente`);
  }

  // ── Privados ──

  _broadcast() {
    if (!this._broadcastEnabled) return;

    const payload = {};
    Object.keys(this.state).forEach((key) => {
      payload[key] = { ...this.state[key] };
    });

    try {
      BrowserWindow.getAllWindows().forEach((win) => {
        if (win && !win.isDestroyed() && win.webContents) {
          win.webContents.send('state:update', payload);
        }
      });
      this._lastBroadcast = Date.now();
    } catch (err) {
      // Silencioso — puede fallar si no hay ventanas aún
    }
  }

  /**
   * Broadcast con throttle: máximo 1 envío cada 50ms (20/segundo).
   * Acumula cambios y envía el último estado conocido.
   */
  _broadcastThrottled() {
    if (!this._broadcastEnabled) return;
    if (this._broadcastThrottled && Date.now() - this._lastBroadcast < 50) {
      // Ya enviamos hace menos de 50ms, skip
      return;
    }
    this._broadcast();
  }
}

// Singleton
let instance = null;

function getAppStateManager() {
  if (!instance) {
    instance = new AppStateManager();
  }
  return instance;
}

// ── Reference holder for the global operation lock ──
let _operationLockRef = null;

function setOperationLockRef(ref) {
  _operationLockRef = ref;
}

function getOperationLockRef() {
  return _operationLockRef;
}

module.exports = { AppStateManager, getAppStateManager, DEFAULT_STATE, setOperationLockRef, getOperationLockRef };
