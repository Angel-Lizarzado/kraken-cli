'use strict';

const { createStepLogger } = require('../utils/logger');
const { TIMEOUTS } = require('../constants');

async function runStep3(ctx) {
  const log = createStepLogger(ctx.emit, 3, ctx.totalSteps);
  log.info(`Limpieza atómica de raíz (Scorched Earth)...`);
  log.detail(`find -mindepth 1 -maxdepth 1 ! wp-config ! .htaccess ! wp-content`);

  await ctx.run(
    `find ${ctx.webRoot} -mindepth 1 -maxdepth 1 ! -name 'wp-config.php' ! -name '.htaccess' ! -name 'wp-content' -exec rm -rf {} +`,
    { allowFail: true, timeout: TIMEOUTS.MEDIUM }
  );

  log.success(`Scorched Earth ✓ (raíz limpia, incluye archivos ocultos)`);
}

module.exports = { runStep3 };
