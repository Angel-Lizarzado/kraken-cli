'use strict';

const TIMEOUTS = {
  DEFAULT: 30000,
  MEDIUM: 60000,
  LONG: 90000,
  X_LONG: 120000,
  XX_LONG: 180000,
  XXX_LONG: 300000,
};

const CONFIG_CONSTANTS = [
  { key: 'DISALLOW_FILE_EDIT', val: 'true', desc: 'bloquea editor de temas/plugins desde admin' },
  { key: 'FORCE_SSL_ADMIN',    val: 'true', desc: 'fuerza HTTPS en admin' },
];

module.exports = {
  TIMEOUTS,
  CONFIG_CONSTANTS,
};
