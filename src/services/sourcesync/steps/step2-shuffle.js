'use strict';

const { createStepLogger } = require('../utils/logger');
const { wpCmd } = require('../utils/wptoolkit');

async function runStep2(ctx) {
  const log = createStepLogger(ctx.emit, 2, ctx.totalSteps);
  log.info(`Regenerando security salts...`);

  const shuffleCmd = wpCmd(null, 'config shuffle-salts', ctx.sysUser, ctx.webRoot);
  await ctx.run(shuffleCmd);

  log.success(`Salts regenerados ✓`);
}

module.exports = { runStep2 };
