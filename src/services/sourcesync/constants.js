'use strict';

const TIMEOUTS = {
  DEFAULT: 120000,    // 2 min
  MEDIUM: 300000,     // 5 min
  LONG: 600000,       // 10 min
  X_LONG: 1200000,    // 20 min
  XX_LONG: 1800000,   // 30 min
  XXX_LONG: 3600000,  // 60 min
};

const CONFIG_CONSTANTS = [
  { key: 'DISALLOW_FILE_EDIT', val: 'true', desc: 'bloquea editor de temas/plugins desde admin' },
  { key: 'FORCE_SSL_ADMIN',    val: 'true', desc: 'fuerza HTTPS en admin' },
];

module.exports = {
  TIMEOUTS,
  CONFIG_CONSTANTS,
};
