'use strict';

const { createStepLogger } = require('../utils/logger');
const { TIMEOUTS } = require('../constants');
const { extractInstanceId, wpCmd } = require('../utils/wptoolkit');

async function runStep4(ctx, wpVersion) {
  const log = createStepLogger(ctx.emit, 4, ctx.totalSteps);
  log.info(`Reinstalando WordPress ${wpVersion}...`);

  const dlCmd = wpCmd(null, `core download --version=${wpVersion} --force --skip-content`, ctx.sysUser, ctx.webRoot);
  await ctx.run(dlCmd, { timeout: TIMEOUTS.XX_LONG });
  log.detail(`WordPress ${wpVersion} descargado ✓`);

  const domainIdResult = await ctx.run(
    `plesk db -sNe "SELECT id FROM domains WHERE name='${ctx.domain}'" 2>/dev/null`,
    { allowFail: true, timeout: 15000 }
  );
  const domainId = (domainIdResult.stdout || '').trim();

  let instanceId = null;

  if (!domainId || !/^\d+$/.test(domainId)) {
    log.warn(`Dominio no encontrado en BD de Plesk (domain_id='${domainId}') — registro WP Toolkit omitido`);
  } else {
    log.detail(`domain_id en Plesk: ${domainId}`);

    await ctx.run(
      `plesk ext wp-toolkit --unregister -domain-id ${domainId} 2>/dev/null || true`,
      { allowFail: true, timeout: TIMEOUTS.DEFAULT }
    );
    log.detail(`instancia anterior des-registrada de WP Toolkit ✓`);

    const registerResult = await ctx.run(
      `plesk ext wp-toolkit --register -domain-id ${domainId} -wp-path ${ctx.webRoot} 2>&1`,
      { allowFail: true, timeout: TIMEOUTS.MEDIUM }
    );
    const registerOut = (registerResult.stdout || registerResult.stderr || '').trim();
    instanceId = extractInstanceId(registerOut);

    if (instanceId) {
      log.detail(`re-registrado en WP Toolkit — instance-id: ${instanceId} ✓`);
    } else {
      const listResult = await ctx.run(
        `plesk ext wp-toolkit --list 2>/dev/null | grep -w '${ctx.domain}' | awk '{print $1}' | head -1`,
        { allowFail: true, timeout: 15000 }
      );
      const listId = (listResult.stdout || '').trim();
      if (listId && /^\d+$/.test(listId)) {
        instanceId = listId;
        log.detail(`instance-id via --list: ${instanceId}`);
      } else {
        log.warn(`No se pudo resolver instance-id — usando wp-cli nativo como fallback`);
      }
    }
  }

  log.success(`WP ${wpVersion} instalado + WP Toolkit ${instanceId ? `registrado (id:${instanceId})` : 'SKIP (no disponible)'} ✓`);

  // Guardamos instanceId en ctx para los pasos siguientes
  ctx.instanceId = instanceId;
}

module.exports = { runStep4 };
