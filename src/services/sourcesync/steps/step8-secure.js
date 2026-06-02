'use strict';

const { createStepLogger } = require('../utils/logger');
const { TIMEOUTS } = require('../constants');

async function runStep8(ctx) {
  const log = createStepLogger(ctx.emit, 8, ctx.totalSteps);
  log.info(`Aplicando WP Toolkit Security Measures (--secure)...`);

  if (!ctx.instanceId) {
    log.warn(`SKIP — WP Toolkit no disponible (instanceId nulo)`);
    log.warn(`--secure: SKIP`);
    return;
  }

  const secureResult = await ctx.run(
    `plesk ext wp-toolkit --secure -instance-id ${ctx.instanceId} 2>&1`,
    { allowFail: true, timeout: TIMEOUTS.MEDIUM }
  );

  if (secureResult.code === 0) {
    log.success(`Security Measures aplicadas ✓ (PHP uploads, xmlrpc, cron)`);
  } else {
    const secureErr = (secureResult.stderr || secureResult.stdout || '').slice(0, 120);
    log.warn(`--secure code=${secureResult.code}: ${secureErr}`);
    log.warn(`Security Measures: aplicación parcial (ver warning)`);
  }
}

module.exports = { runStep8 };
