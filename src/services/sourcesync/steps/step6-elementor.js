'use strict';

const { createStepLogger } = require('../utils/logger');
const { TIMEOUTS } = require('../constants');

async function runStep6(ctx, elementorZipPath) {
  const log = createStepLogger(ctx.emit, 6, ctx.totalSteps);

  if (!elementorZipPath) {
    log.warn(`SKIP: No se proveyó ZIP de Elementor Pro`);
    return;
  }

  log.info(`Extrayendo Elementor Pro nativamente (unzip destructivo)...`);

  const p6ExtCmd = [
    `unzip -o -q "${elementorZipPath}" -d "${ctx.webRoot}/wp-content/plugins/"`,
    `chown -R ${ctx.sysUser}:psacln "${ctx.webRoot}/wp-content/plugins/elementor-pro"`
  ].join(' && ');

  await ctx.run(p6ExtCmd, { timeout: TIMEOUTS.LONG });
  log.detail(`unzip y chown completado ✓`);

  log.info(`Activando Elementor Pro...`);
  await ctx.run(`su -l ${ctx.sysUser} -s /bin/bash -c "cd ${ctx.webRoot} && /usr/local/bin/wp plugin activate elementor-pro --skip-plugins"`, { timeout: TIMEOUTS.MEDIUM });
  
  log.success(`Elementor Pro instalado y activado ✓`);
}

module.exports = { runStep6 };
