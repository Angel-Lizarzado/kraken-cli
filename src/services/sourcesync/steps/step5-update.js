'use strict';

const { createStepLogger } = require('../utils/logger');
const { TIMEOUTS } = require('../constants');

async function runStep5(ctx) {
  const log = createStepLogger(ctx.emit, 5, ctx.totalSteps);
  log.info(`Actualizando Core, Plugins y Temas (Purga Agresiva)...`);

  if (ctx.instanceId) {
    const p5Cmds = [
      `plesk ext wp-toolkit --wp-cli -instance-id ${ctx.instanceId} -- core update`,
      `plesk ext wp-toolkit --wp-cli -instance-id ${ctx.instanceId} -- core update-db`,
      `plesk ext wp-toolkit --wp-cli -instance-id ${ctx.instanceId} -- plugin update --all`,
      `plesk ext wp-toolkit --wp-cli -instance-id ${ctx.instanceId} -- theme update --all`,
      `plesk ext wp-toolkit --wp-cli -instance-id ${ctx.instanceId} -- theme delete $(plesk ext wp-toolkit --wp-cli -instance-id ${ctx.instanceId} -- theme list --status=inactive --field=name) > /dev/null 2>&1 || true`,
      `plesk ext wp-toolkit --clear-cache -instance-id ${ctx.instanceId} > /dev/null 2>&1 || true`
    ].join(' && ');

    const updRes = await ctx.run(p5Cmds, { allowFail: true, timeout: TIMEOUTS.XXX_LONG });
    log.detail(`Purga Toolkit → code=${updRes.code}`);
  } else {
    const p5Fallback = `su -l ${ctx.sysUser} -s /bin/bash -c "cd ${ctx.webRoot} && /usr/local/bin/wp core update && /usr/local/bin/wp core update-db && /usr/local/bin/wp plugin update --all && /usr/local/bin/wp theme update --all && /usr/local/bin/wp theme delete $(/usr/local/bin/wp theme list --status=inactive --field=name) > /dev/null 2>&1 || true"`;
    const updRes = await ctx.run(p5Fallback, { allowFail: true, timeout: TIMEOUTS.XXX_LONG });
    log.detail(`Purga Nativa → code=${updRes.code}`);
  }

  log.success(`Actualización Agresiva y Purga completadas ✓`);
}

module.exports = { runStep5 };
