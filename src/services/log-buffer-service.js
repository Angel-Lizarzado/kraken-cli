// LogBufferService — Buffer de logs para terminal, desacoplado de AppStateManager
// Acumula logs en un buffer circular. Envía por IPC sin depender del foco de ventana.
// getRecentLogs() permite que el terminal haga hydratación al montarse.

const { BrowserWindow } = require('electron');

const MAX_BUFFER = 200;
const FLUSH_INTERVAL = 250; // ms

class LogBufferService {
  constructor() {
    this.buffer = [];    // entries pending flush to renderers
    this._history = [];  // permanent history for getRecentLogs()
    this._flushTimer = null;
    this._enabled = true;
  }

  /**
   * Verifica si ALGUNA ventana de la app está enfocada.
   */
  isWindowFocused() {
    try {
      const wins = BrowserWindow.getAllWindows();
      return wins.some(win => !win.isDestroyed() && win.isFocused());
    } catch {
      return true; // asumir enfocada si falla
    }
  }

  /**
   * Agrega un log al buffer. Siempre acumula, sin importar el foco de ventana.
   */
  push(module, message, type = 'info', domain = '') {
    if (!this._enabled) return;

    const entry = {
      module,
      message,
      type,
      domain,
      timestamp: Date.now(),
    };

    this.buffer.push(entry);
    this._history.push(entry);

    if (this._history.length > MAX_BUFFER) {
      this._history.shift();
    }

    this._scheduleFlush();
  }

  /**
   * Programa el flush si no hay uno pendiente.
   */
  _scheduleFlush() {
    if (this._flushTimer) return;
    this._flushTimer = setImmediate(() => {
      this._flushTimer = null;
      this._flush();
    });
  }

  /**
   * Envía el buffer completo por IPC a todas las ventanas.
   */
  _flush() {
    if (this.buffer.length === 0) return;

    const batch = this.buffer.splice(0, this.buffer.length);

    try {
      BrowserWindow.getAllWindows().forEach(win => {
        if (win && !win.isDestroyed() && win.webContents) {
          win.webContents.send('log:batch', batch);
        }
      });
    } catch {
      // Silencioso
    }
  }

  /**
   * Habilita o deshabilita el buffer.
   */
  setEnabled(enabled) {
    this._enabled = enabled;
  }

  /**
   * Limpia el buffer.
   */
  clear() {
    this.buffer = [];
    this._history = [];
  }

  /**
   * Retorna los últimos N logs del buffer (útil para hydratación del terminal).
   * @param {number} count — cantidad de entradas a devolver (default: 50)
   * @returns {Array} — copia de las últimas N entradas
   */
  getRecentLogs(count = 50) {
    if (this._history.length === 0) return [];
    return this._history.slice(-count);
  }
}

// Singleton
let instance = null;

function getLogBufferService() {
  if (!instance) {
    instance = new LogBufferService();
  }
  return instance;
}

module.exports = { LogBufferService, getLogBufferService };
