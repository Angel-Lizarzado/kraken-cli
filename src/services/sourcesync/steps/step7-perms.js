'use strict';

const { createStepLogger } = require('../utils/logger');
const { TIMEOUTS } = require('../constants');
const { wpCmd } = require('../utils/wptoolkit');

async function runStep7(ctx) {
  const log = createStepLogger(ctx.emit, 7, ctx.totalSteps);
  log.info(`Aplicando permisos (644/755) y limpiando caché...`);

  await ctx.run(`
    find ${ctx.webRoot} -type f -exec chmod 644 {} \\; 2>/dev/null;
    find ${ctx.webRoot} -type d -exec chmod 755 {} \\; 2>/dev/null;
    chmod 600 ${ctx.webRoot}/wp-config.php 2>/dev/null || true
  `, { timeout: TIMEOUTS.X_LONG, allowFail: true });
  
  log.detail(`permisos 644/755 aplicados ✓`);

  const cacheFlushCmd = wpCmd(ctx.instanceId, 'cache flush', ctx.sysUser, ctx.webRoot);
  await ctx.run(cacheFlushCmd, { allowFail: true });

  const rewriteFlushCmd = wpCmd(ctx.instanceId, 'rewrite flush', ctx.sysUser, ctx.webRoot);
  await ctx.run(rewriteFlushCmd, { allowFail: true });
  
  log.success(`Permisos + caché ✓`);
}

module.exports = { runStep7 };
