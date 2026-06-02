'use strict';

const { createStepLogger } = require('../utils/logger');
const { StepError } = require('../utils/errors');

async function runStep0(ctx, targetPhpVersion) {
  const log = createStepLogger(ctx.emit, 0, ctx.totalSteps);

  if (targetPhpVersion === 'Mantener actual') {
    return;
  }

  let phpHandlerId = targetPhpVersion;
  if (targetPhpVersion.startsWith('plesk-php')) {
    phpHandlerId = targetPhpVersion.endsWith('-fpm') ? targetPhpVersion : `${targetPhpVersion}-fpm`;
  } else {
    const phpNum = targetPhpVersion.replace('.', ''); // ej: '8.2' -> '82'
    phpHandlerId = `plesk-php${phpNum}-fpm`;
  }

  log.info(`Configurando PHP a la versión ${targetPhpVersion} (handler: ${phpHandlerId})...`);

  if (ctx.dryRun) {
    log.detail(`[DRY RUN] Simulado cambio a PHP ${targetPhpVersion} (handler: ${phpHandlerId})`);
    return;
  }

  const phpCmd = `plesk bin site -u "${ctx.domain}" -php_handler_id ${phpHandlerId} 2>&1`;
  const phpRes = await ctx.run(phpCmd, { allowFail: true });

  if (phpRes.code === 0) {
    log.detail(`PHP Handler cambiado a ${phpHandlerId} ✓`, 'success');
  } else {
    log.warn(`Fallo al cambiar PHP. El handler podría no estar instalado. code=${phpRes.code}`);
  }
}

module.exports = { runStep0 };
