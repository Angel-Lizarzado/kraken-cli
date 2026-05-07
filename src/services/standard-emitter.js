// StandardEmitter — Telemetría unificada para todos los módulos
// Formato: @@@syslog|<MODULE_ID>|<LEVEL>|<MESSAGE>
// Emite por stdout (para scripts Bash) y log-buffer-service (para Terminal UI)

const SYSLOG_PREFIX = '@@@syslog|';

const MODULE_IDS = {
  extraction: 'EXTRACT',
  deployment: 'MIGRATE',
  cloudflare: 'DNS',
  ssl: 'SSL',
  scanner: 'VALIDATOR',
};

const LEVELS = ['info', 'warn', 'error', 'success'];

class StandardEmitter {
  constructor(moduleKey) {
    this.moduleId = MODULE_IDS[moduleKey] || moduleKey.toUpperCase();
    this._logBuffer = null;
  }

  _getLogBuffer() {
    if (!this._logBuffer) {
      try {
        this._logBuffer = require('./log-buffer-service').getLogBufferService();
      } catch { this._logBuffer = null; }
    }
    return this._logBuffer;
  }

  /**
   * Emite un log formateado al sistema.
   * @param {string} level - 'info' | 'warn' | 'error' | 'success'
   * @param {string} message - Mensaje descriptivo
   * @param {string} [domain] - Dominio asociado (opcional)
   */
  emit(level, message, domain = '') {
    const lvl = LEVELS.includes(level) ? level : 'info';
    const formatted = `${SYSLOG_PREFIX}${this.moduleId}|${lvl}|${message}`;

    // stdout para scripts Bash que capturen output
    process.stdout.write(formatted + '\n');

    // log-buffer-service para Terminal UI
    const buf = this._getLogBuffer();
    if (buf && typeof buf.push === 'function') {
      buf.push(this.moduleId.toLowerCase(), message, lvl, domain);
    }
  }

  info(message, domain)  { this.emit('info', message, domain); }
  warn(message, domain)  { this.emit('warn', message, domain); }
  error(message, domain) { this.emit('error', message, domain); }
  success(message, domain) { this.emit('success', message, domain); }

  /**
   * Helper: emite un log y también ejecuta console.log para DevTools.
   */
  log(level, message, domain) {
    console.log(`[${this.moduleId}] ${message}`);
    this.emit(level, message, domain);
  }
}

// Singleton instances por módulo
const _emitters = {};

function getStandardEmitter(moduleKey) {
  if (!_emitters[moduleKey]) {
    _emitters[moduleKey] = new StandardEmitter(moduleKey);
  }
  return _emitters[moduleKey];
}

module.exports = { StandardEmitter, getStandardEmitter, MODULE_IDS, SYSLOG_PREFIX };
