'use strict';

const { createStepLogger } = require('../utils/logger');
const { CONFIG_CONSTANTS } = require('../constants');
const { wpCmd } = require('../utils/wptoolkit');

async function runStep9(ctx) {
  const log = createStepLogger(ctx.emit, 9, ctx.totalSteps);
  log.info(`Configurando wp-config.php hardening...`);

  for (const { key, val, desc } of CONFIG_CONSTANTS) {
    const cmd = wpCmd(ctx.instanceId, `config set ${key} ${val} --raw`, ctx.sysUser, ctx.webRoot);
    const configResult = await ctx.run(cmd, { allowFail: true, timeout: 15000 });
    
    if (configResult.code === 0) {
      log.detail(`${key}=${val} ✓ (${desc})`);
    } else if (configResult.code === 3) {
      log.detail(`${key}=${val} ✓ (ya estaba configurado)`);
    } else {
      const configErr = (configResult.stderr || '').slice(0, 80);
      log.warn(`${key}: code=${configResult.code} — ${configErr || '(sin detalle)'}`);
    }
  }

  log.success(`WP Config hardening completo ✓`);
}

module.exports = { runStep9 };
