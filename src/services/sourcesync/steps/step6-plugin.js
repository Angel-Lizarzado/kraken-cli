'use strict';

const { createStepLogger } = require('../utils/logger');
const { TIMEOUTS } = require('../constants');

async function runStep6(ctx, elementorZipPath) {
  const log = createStepLogger(ctx.emit, 6, ctx.totalSteps);

  if (!elementorZipPath) {
    log.warn(`SKIP: No se proveyó ZIP de Plugin`);
    return;
  }

  log.info(`Extrayendo Plugin genéricamente...`);

  // Detect folder name from zip, unzip, chown, and activate.
  const p6ExtCmd = [
    `PLUGIN_DIR=$(unzip -Z1 "${elementorZipPath}" | head -n 1 | awk -F/ '{print $1}')`,
    `echo "DETECTED_PLUGIN:$PLUGIN_DIR"`,
    `unzip -o -q "${elementorZipPath}" -d "${ctx.webRoot}/wp-content/plugins/"`,
    `chown -R ${ctx.sysUser}:psacln "${ctx.webRoot}/wp-content/plugins/$PLUGIN_DIR"`,
    `su -l ${ctx.sysUser} -s /bin/bash -c "cd ${ctx.webRoot} && /usr/local/bin/wp plugin activate $PLUGIN_DIR --skip-plugins" || echo "WP_ACTIVATE_FAILED"`
  ].join(' && ');

  const result = await ctx.run(p6ExtCmd, { timeout: TIMEOUTS.LONG, allowFail: true });

  if (result.code !== 0) {
    throw new Error(`Falló la extracción del Plugin: ${result.stderr || result.stdout}`);
  }

  const out = result.stdout || '';
  const match = out.match(/DETECTED_PLUGIN:(.+)/);
  const pluginDir = match ? match[1].trim() : 'desconocido';

  if (out.includes('WP_ACTIVATE_FAILED')) {
    log.warn(`Plugin '${pluginDir}' extraído, pero requiere activación manual.`);
  } else {
    log.success(`Plugin '${pluginDir}' extraído y activado ✓`);
  }
}

module.exports = { runStep6 };
