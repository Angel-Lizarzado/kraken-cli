'use strict';

const { createStepLogger } = require('../utils/logger');
const { StepError } = require('../utils/errors');
const { wpCmd } = require('../utils/wptoolkit');

async function runStep1(ctx) {
  const log = createStepLogger(ctx.emit, 1, ctx.totalSteps);
  log.info(`Verificando entorno — usuario: ${ctx.sysUser} | webRoot: ${ctx.webRoot}`);

  const whichResult = await ctx.run(
    `which wp 2>/dev/null || ls /usr/local/bin/wp 2>/dev/null || echo "WP_NOT_FOUND"`,
    { allowFail: true }
  );
  const whichOut = (whichResult.stdout || '').trim();
  if (whichOut === 'WP_NOT_FOUND' || whichOut === '') {
    throw new StepError(1, `wp-cli no encontrado. Instala wp-cli globalmente.`);
  }
  log.detail(`wp-cli: ${whichOut.split('\n')[0].trim()} (CRLF normalizado ✓)`);

  const wpVersionCmd = wpCmd(null, 'cli version', ctx.sysUser, ctx.webRoot);
  const checkResult = await ctx.run(wpVersionCmd, { allowFail: true });
  const checkCode = checkResult.code;
  const checkOut = (checkResult.stdout || '').trim();
  const checkErr = (checkResult.stderr || '').trim();
  log.detail(`wp cli version → code=${checkCode} | ${checkOut.slice(0, 60) || checkErr.slice(0, 60) || '(sin output)'}`);

  if (checkCode !== 0 && checkCode !== null) {
    throw new StepError(1, `wp-cli no ejecutable como "${ctx.sysUser}" (code=${checkCode}). stderr: ${checkErr || '(vacío)'}`);
  }
  if ((checkOut + checkErr).toLowerCase().includes('command not found')) {
    throw new StepError(1, `wp-cli: command not found como "${ctx.sysUser}". stderr: ${checkErr}`);
  }

  const wpIsInstalledCmd = wpCmd(null, 'core is-installed', ctx.sysUser, ctx.webRoot);
  const wpCheck = await ctx.run(wpIsInstalledCmd, { allowFail: true });
  const wpCode = wpCheck.code;
  const wpStderr = (wpCheck.stderr || '').trim();
  const wpStdout = (wpCheck.stdout || '').trim();
  log.detail(`wp core is-installed → code=${wpCode}${wpStderr ? ` | ${wpStderr.slice(0, 100)}` : ''}`);

  if (wpCode !== 0) {
    throw new StepError(1, `WordPress NO instalado en ${ctx.webRoot} (code=${wpCode}). stderr: ${wpStderr || '(vacío)'}. stdout: ${wpStdout || '(vacío)'}`);
  }
  log.success(`WP-CLI ✓ — WordPress instalado ✓`);
}

module.exports = { runStep1 };
