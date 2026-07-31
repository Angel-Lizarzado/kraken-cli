/**
 * @module SOURCESYNC/pleskGit
 * @description Vinculación de repositorios GitHub en dominios Plesk.
 *
 * Arquitectura v5 — 8 Pasos (probada en producción):
 *  1. Limpiar estado previo (idempotente)
 *  2. Registrar repo en Plesk (obtener llave SSH del --info)
 *  3. Registrar llave en GitHub + 15s propagación
 *  4. Clone manual bare como usuario de la suscripción (su -s /bin/bash)
 *  5. Configurar CI/CD en Plesk (deployment-mode manual, deploy.sh)
 *  6. Primer deploy vía Plesk (--deploy)
 *  7. Bootstrap garantizado: sh ./deploy.sh directamente en httpdocs
 *  8. Activar auto-deploy para futuros pushes
 *
 * Interfaz pública:
 *   configurarRepoEnPlesk(ssh, domain, httpsUrl, registerKeyFn, opciones)
 *
 * registerKeyFn es un callback que recibe la llave pública y la registra
 * en GitHub. La lógica de la API la maneja deployOrchestrator.js.
 */

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────────────────
const REPO_NAME             = 'github-repo';
const TARGET_BRANCH         = 'main';
const DEPLOY_ACTION         = 'sh ../kraken-deploy.sh';
const KEY_PROPAGATION_MS    = 15_000;

// ─────────────────────────────────────────────────────────────────────────────
// HELPER — wrapper de execCommand con error automático
// ─────────────────────────────────────────────────────────────────────────────
async function run(ssh, cmd, { allowFail = false } = {}) {
  const { stdout, stderr, code } = await ssh.execCommand(cmd);
  if (code !== 0 && !allowFail) {
    throw new Error(
      `[SOURCESYNC:Git] CMD FAILED (exit ${code})\n` +
      `  CMD: ${cmd}\n` +
      `  ERR: ${stderr || stdout}`
    );
  }
  return { stdout: (stdout || '').trim(), stderr: (stderr || '').trim(), code };
}

const wait = (ms) => new Promise((res) => setTimeout(res, ms));

// ─────────────────────────────────────────────────────────────────────────────
// TRANSFORMACIÓN DE URL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Transforma una URL de GitHub (HTTPS o SSH) a formato SSH estándar.
 *
 * @param {string} url
 * @returns {{ urlSsh: string, owner: string, repo: string }}
 */
function transformarUrlSsh(url) {
  if (!url || typeof url !== 'string') {
    throw new Error(`[SOURCESYNC:Git] URL inválida: ${JSON.stringify(url)}`);
  }

  const clean = url.trim().replace(/\/$/, '').replace(/\.git$/, '');
  const afterHost = clean.split(/github\.com[:/]/i).pop();

  if (!afterHost || !afterHost.includes('/')) {
    throw new Error(
      `[SOURCESYNC:Git] URL no reconocida: "${url}". ` +
      `Formato esperado: https://github.com/owner/repo`
    );
  }

  const parts = afterHost.split('/');
  const owner = parts[0];
  const repo  = parts[1];

  if (!owner || !repo) {
    throw new Error(`[SOURCESYNC:Git] No se pudo extraer owner/repo de: "${url}"`);
  }

  const urlSsh = `git@github.com:${owner}/${repo}.git`;
  console.log(`[SOURCESYNC:Git] URL transformada: "${url}" → "${urlSsh}"`);
  return { urlSsh, owner, repo };
}

// ─────────────────────────────────────────────────────────────────────────────
// PASO 1 — Limpiar estado previo (idempotente)
// ─────────────────────────────────────────────────────────────────────────────
async function cleanPreviousState(ssh, domain) {
  console.log(`[SOURCESYNC:Git] [1/8] Limpiando estado previo...`);

  await run(ssh,
    `plesk ext git --remove -domain ${domain} -name "${REPO_NAME}" 2>/dev/null || plesk ext git --delete -domain ${domain} -name "${REPO_NAME}" 2>/dev/null || true`,
    { allowFail: true }
  );
  await run(ssh,
    `rm -f /var/www/vhosts/${domain}/httpdocs/index.html`,
    { allowFail: true }
  );
  await run(ssh,
    `rm -rf /var/www/vhosts/${domain}/httpdocs/.git`,
    { allowFail: true }
  );
  await run(ssh,
    `rm -rf /var/www/vhosts/${domain}/git/${REPO_NAME}`,
    { allowFail: true }
  );

  console.log(`[SOURCESYNC:Git] Limpieza completada.`);
}

// ─────────────────────────────────────────────────────────────────────────────
// PASO 2 — Registrar repo en Plesk y extraer llave SSH del --info
// ─────────────────────────────────────────────────────────────────────────────
async function registerRepoInPlesk(ssh, domain, sshUrl) {
  console.log(`[SOURCESYNC:Git] [2/8] Registrando repo en Plesk para obtener llave SSH...`);

  await run(ssh,
    `plesk ext git --create -domain ${domain} -name "${REPO_NAME}" -url "${sshUrl}" -type remote`
  );

  // Extraer la llave SSH del --info (método primario para este Plesk)
  const { stdout: infoOut } = await run(ssh,
    `plesk ext git --info -domain ${domain} -name "${REPO_NAME}"`
  );

  const keyMatch = infoOut.match(/SSH public key:\s*(ssh-\S+\s+\S+(?:\s+\S+)?)/i);
  if (keyMatch) {
    const key = keyMatch[1].trim();
    console.log(`[SOURCESYNC:Git] Llave SSH obtenida del --info: ${key.substring(0, 40)}...`);
    return key;
  }

  // Fallback: --get-public-key
  console.warn(`[SOURCESYNC:Git] --info no retornó llave. Intentando --get-public-key...`);
  const { stdout: pkOut } = await run(ssh,
    `plesk ext git --get-public-key -domain ${domain}`,
    { allowFail: true }
  );

  const pkMatch = (pkOut || '').match(/(ssh-\S+\s+\S+)/);
  if (pkMatch) {
    const key = pkMatch[1].trim();
    console.log(`[SOURCESYNC:Git] Llave SSH obtenida del --get-public-key: ${key.substring(0, 40)}...`);
    return key;
  }

  throw new Error(
    `[SOURCESYNC:Git] No se pudo obtener la llave SSH de Plesk para ${domain}.\n` +
    `Output --info: ${infoOut.substring(0, 400)}`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PASO 3 — Registrar llave en GitHub + esperar propagación
// Delegado al callback registerKeyFn que provee deployOrchestrator.js
// ─────────────────────────────────────────────────────────────────────────────
async function registerKeyInGitHub(pleskPublicKey, registerKeyFn) {
  console.log(`[SOURCESYNC:Git] [3/8] Registrando deploy key en GitHub...`);

  if (typeof registerKeyFn === 'function') {
    await registerKeyFn(pleskPublicKey);
  }

  console.log(`[SOURCESYNC:Git] Esperando ${KEY_PROPAGATION_MS / 1000}s para propagación en GitHub...`);
  await wait(KEY_PROPAGATION_MS);
}

// ─────────────────────────────────────────────────────────────────────────────
// PASO 4 — Clone manual bare como usuario de la suscripción
// Usa `su -s /bin/bash` para que git use las llaves SSH del usuario correcto.
// ─────────────────────────────────────────────────────────────────────────────
async function manualBareClone(ssh, domain, sshUrl) {
  console.log(`[SOURCESYNC:Git] [4/8] Ejecutando clone manual como usuario de la suscripción...`);

  const bareRepoPath = `/var/www/vhosts/${domain}/git/${REPO_NAME}`;

  // Detectar el usuario del sistema que Plesk asigna al dominio
  const { stdout: sysUserOut } = await run(ssh,
    `stat -c '%U' /var/www/vhosts/${domain}/httpdocs 2>/dev/null || ` +
    `stat -c '%U' /var/www/vhosts/${domain}`
  );
  const subscriptionUser = sysUserOut.trim() || 'root';
  console.log(`[SOURCESYNC:Git] Usuario de suscripción: ${subscriptionUser}`);

  // Doble check: aniquilar la carpeta completa antes del clone.
  // Git falla con exit 128 si el directorio existe (aunque esté vacío).
  // rm -rf del path completo es la única garantía — el glob de contenido no basta.
  await run(ssh, `rm -rf "${bareRepoPath}"`, { allowFail: true });


  // Clone bare como el usuario de la suscripción usando su -s /bin/bash
  // GIT_SSH_COMMAND fuerza el no-interactive SSH
  const sshOpts = `ssh -o StrictHostKeyChecking=no -o BatchMode=yes`;
  const cloneCmd =
    `su -s /bin/bash -c ` +
    `"GIT_SSH_COMMAND='${sshOpts}' git clone --bare '${sshUrl}' '${bareRepoPath}'" ` +
    subscriptionUser;

  const { code: cloneCode, stderr: cloneErr, stdout: cloneOut } = await ssh.execCommand(cloneCmd);

  if (cloneCode !== 0) {
    // Fallback: intentar como root si su falla (permisos de sudoers variables)
    console.warn(
      `[SOURCESYNC:Git] Clone como ${subscriptionUser} falló (${cloneCode}): ${cloneErr}. ` +
      `Intentando como root...`
    );
    await run(ssh,
      `GIT_SSH_COMMAND='${sshOpts}' git clone --bare "${sshUrl}" "${bareRepoPath}"`
    );
    await run(ssh, `chown -R ${subscriptionUser}:psacln "${bareRepoPath}"`);
  }

  // Verificar que el clone tiene contenido real
  const { stdout: headContent } = await run(ssh, `cat "${bareRepoPath}/HEAD"`);
  if (!headContent.includes('ref:')) {
    throw new Error(
      `[SOURCESYNC:Git] Clone incompleto para ${domain}. HEAD contiene: ${headContent}`
    );
  }

  console.log(`[SOURCESYNC:Git] Clone verificado. HEAD: ${headContent}`);
  await run(ssh, `chmod -R 755 "${bareRepoPath}"`);
}

// ─────────────────────────────────────────────────────────────────────────────
// PASO 4.5 — Inyectar kraken-deploy.sh seguro
// ─────────────────────────────────────────────────────────────────────────────
async function injectKrakenDeployScript(ssh, domain, versionNode = '24.15.0') {
  console.log(`[SOURCESYNC:Git] [4.5/8] Inyectando kraken-deploy.sh en la raíz del dominio...`);

  const majorVersion = versionNode.split('.')[0] || '24';

  // Para evitar problemas de escape en Bash/SSH, encodeamos el script en base64
  // NOTA: Usamos \\s para que en JavaScript se pase \s a la expresión regular de Node
  const scriptContent = `#!/bin/bash
set -e

DOMAIN="\$1"
if [ -z "\$DOMAIN" ]; then
  DOMAIN=\$(basename \$(dirname \$(pwd)))
fi

HTTPDOCS="/var/www/vhosts/\$DOMAIN/httpdocs"

echo "[Kraken Deploy] Iniciando deploy maestro para \$DOMAIN"
cd "\$HTTPDOCS"

# 1. PATH Node.js (Plesk Node ${majorVersion}.x)
export PATH=/opt/plesk/node/${majorVersion}/bin:\$PATH

# 2. Inyectar output: standalone en Next.js
node -e "
const fs = require('fs');
const files = ['next.config.js', 'next.config.mjs'];
let found = false;

for (const f of files) {
  if (fs.existsSync(f)) {
    found = true;
    let content = fs.readFileSync(f, 'utf8');
    if (!content.includes('standalone')) {
      console.log('[Kraken Deploy] Inyectando output: standalone en ' + f);
      // Inyectar en const nextConfig = { o module.exports = { o export default {
      content = content.replace(/(const\\s+nextConfig\\s*=\\s*\\{)/, '\\$1\\n  output: \\\\'standalone\\\\',');
      content = content.replace(/(module\\.exports\\s*=\\s*\\{)/, '\\$1\\n  output: \\\\'standalone\\\\',');
      content = content.replace(/(export\\s+default\\s+\\{)/, '\\$1\\n  output: \\\\'standalone\\\\',');
      fs.writeFileSync(f, content);
    } else {
      console.log('[Kraken Deploy] ' + f + ' ya contiene output: standalone');
    }
    break;
  }
}

if (!found) {
  console.log('[Kraken Deploy] WARN: No se encontró next.config.js/mjs. Si es Next.js, deberia existir.');
}
"

# 3. NPM
echo "[Kraken Deploy] Instalando dependencias..."
npm install

echo "[Kraken Deploy] Compilando Next.js (Standalone)..."
npm run build

# 4. Mover standalone
if [ -d ".next/standalone" ]; then
  echo "[Kraken Deploy] Moviendo standalone a root..."
  cp -r .next/standalone/. ./
  
  if [ -f "server.js" ]; then
    mv server.js app.js
    echo "[Kraken Deploy] Renombrado server.js -> app.js para Plesk Passenger"
  fi
else
  echo "[Kraken Deploy] WARN: .next/standalone no encontrado. ¿El build falló o no es Next.js?"
fi

# 5. Sincronizar estáticos
mkdir -p .next/static
if [ -d ".next/static" ]; then
  echo "[Kraken Deploy] Sincronizando .next/static..."
  rsync -a .next/static/ public/_next/static/ || cp -r .next/static/* public/_next/static/ 2>/dev/null || true
fi

# 6. Permisos (detecta usuario dinámicamente)
SYSUSER=\$(stat -c '%U' "\$HTTPDOCS")
echo "[Kraken Deploy] Ajustando permisos para el usuario: \$SYSUSER"
chown -R "\$SYSUSER:psacln" "\$HTTPDOCS"
# ¡CRÍTICO! La carpeta httpdocs DEBE pertenecer al grupo psaserv para que Apache/Nginx pueda entrar
chown "\$SYSUSER:psaserv" "\$HTTPDOCS"

# 7. Reiniciar Passenger
mkdir -p tmp
touch tmp/restart.txt
echo "[Kraken Deploy] Passenger reiniciado."

echo "[Kraken Deploy] ¡Deploy exitoso para \$DOMAIN!"
`;

  const base64Script = Buffer.from(scriptContent).toString('base64');
  const targetPath = `/var/www/vhosts/${domain}/kraken-deploy.sh`;

  await run(ssh, `echo "${base64Script}" | base64 --decode > "${targetPath}"`);
  await run(ssh, `chmod +x "${targetPath}"`);
  
  // Establecer permisos para el usuario de la suscripción
  const { stdout: sysUserOut } = await run(ssh, `stat -c '%U' /var/www/vhosts/${domain}`);
  const subscriptionUser = sysUserOut.trim() || 'root';
  await run(ssh, `chown ${subscriptionUser}:psacln "${targetPath}"`, { allowFail: true });
  console.log(`[SOURCESYNC:Git] kraken-deploy.sh inyectado exitosamente.`);
}

// ─────────────────────────────────────────────────────────────────────────────
// PASO 5 — Configurar CI/CD en Plesk (modo manual + deploy.sh)
// ─────────────────────────────────────────────────────────────────────────────
async function configureCICD(ssh, domain) {
  console.log(`[SOURCESYNC:Git] [5/8] Configurando CI/CD en Plesk...`);

  await run(ssh,
    `plesk ext git --update` +
    ` -domain ${domain}` +
    ` -name "${REPO_NAME}"` +
    ` -deployment-mode manual` +
    ` -branch "${TARGET_BRANCH}"` +
    ` -actions "${DEPLOY_ACTION}"` +
    ` -run-actions true`
  );

  console.log(`[SOURCESYNC:Git] CI/CD configurado (rama: ${TARGET_BRANCH}, acción: ${DEPLOY_ACTION}).`);
}

// ─────────────────────────────────────────────────────────────────────────────
// PASO 6 — Primer deploy vía Plesk (--deploy)
// ─────────────────────────────────────────────────────────────────────────────
async function firstPleskDeploy(ssh, domain) {
  console.log(`[SOURCESYNC:Git] [6/8] Ejecutando primer deploy vía Plesk...`);

  const { code, stderr } = await ssh.execCommand(
    `plesk ext git --deploy -domain ${domain} -name "${REPO_NAME}"`
  );

  if (code !== 0) {
    console.warn(
      `[SOURCESYNC:Git] --deploy devolvió code ${code}: ${stderr}. ` +
      `Continuando — bootstrap manual garantiza el arranque.`
    );
  } else {
    console.log(`[SOURCESYNC:Git] Plesk deploy completado.`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PASO 6.5 — Node.js Bootstrap
// Habilita Node.js y establece npm como package manager
// Es vital ejecutar esto antes de que deploy.sh intente hacer 'npm install'
// ─────────────────────────────────────────────────────────────────────────────
async function provisionNodeJS(ssh, domain) {
  console.log(`[SOURCESYNC:Git] [6.5/8] Aprovisionando entorno Node.js en Plesk...`);

  await run(ssh, `plesk ext nodejs --enable -domain "${domain}"`, { allowFail: true });
  await run(ssh, `plesk ext nodejs --app-root httpdocs --startup-file app.js -domain "${domain}"`, { allowFail: true });

  console.log(`[SOURCESYNC:Git] Reconfigurando el servidor web para inyectar Passenger...`);
  await run(ssh, `plesk sbin httpdmng --reconfigure-domain "${domain}"`, { allowFail: true });

  console.log(`[SOURCESYNC:Git] Motor Node.js activado y configurado ✓`);
}

// ─────────────────────────────────────────────────────────────────────────────
// PASO 7 — Bootstrap garantizado: sh ../kraken-deploy.sh directo en httpdocs
// Cubre el caso donde Plesk no dispara las additional actions en el primer deploy.
// ─────────────────────────────────────────────────────────────────────────────
async function forceBootstrapDeploy(ssh, domain) {
  console.log(`[SOURCESYNC:Git] [7/8] Ejecutando kraken-deploy.sh directamente (bootstrap garantizado)...`);

  const httpdocs = `/var/www/vhosts/${domain}/httpdocs`;

  const { code, stdout, stderr } = await ssh.execCommand(
    `cd "${httpdocs}" && bash ../kraken-deploy.sh "${domain}" 2>&1`
  );

  if (stdout) console.log(`[SOURCESYNC:Git] kraken-deploy.sh output:\n${stdout}`);

  if (code !== 0) {
    throw new Error(
      `[SOURCESYNC:Git] kraken-deploy.sh falló con exit ${code} para ${domain}:\n${stderr || stdout}`
    );
  }

  console.log(`[SOURCESYNC:Git] Bootstrap deploy completado.`);
}

// ─────────────────────────────────────────────────────────────────────────────
// PASO 8 — Activar auto-deploy para futuros pushes
// ─────────────────────────────────────────────────────────────────────────────
async function enableAutoDeployMode(ssh, domain) {
  console.log(`[SOURCESYNC:Git] [8/8] Activando auto-deploy para futuros pushes...`);

  const { code, stderr, stdout } = await ssh.execCommand(
    `plesk ext git --update` +
    ` -domain ${domain}` +
    ` -name "${REPO_NAME}"` +
    ` -deployment-mode auto`
  );

  if (code !== 0) {
    console.warn(
      `[SOURCESYNC:Git] No se pudo activar auto-deploy (${code}): ${stderr || stdout}. ` +
      `El sitio está desplegado pero futuros push requerirán deploy manual.`
    );
  } else {
    console.log(`[SOURCESYNC:Git] Auto-deploy activado. ✅`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ORQUESTADOR PRINCIPAL — API pública del módulo
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Configura y despliega un repo de GitHub en un dominio Plesk existente.
 *
 * @param {import('node-ssh').NodeSSH} ssh
 * @param {string}   domain         - Dominio ya creado en Plesk
 * @param {string}   httpsUrl       - 'https://github.com/org/repo'
 * @param {Function} registerKeyFn  - async (publicKey: string) => void (maneja la API de GitHub)
 * @param {object}   [opciones={}]
 * @returns {Promise<{ urlSsh: string, pleskPublicKey: string }>}
 */
async function configurarRepoEnPlesk(ssh, domain, httpsUrl, registerKeyFn, opciones = {}) {
  // Sanitizar antes de cualquier operación: elimina Zero Width Space y caracteres
  // Unicode invisibles (\u200B–\u200D, \uFEFF) que rompen rutas SSH y stat.
  const d = domain.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  if (d !== domain) {
    console.warn(`[SOURCESYNC:Git] Dominio sanitizado: "${domain}" → "${d}"`);
  }

  const { urlSsh } = transformarUrlSsh(httpsUrl);

  await cleanPreviousState(ssh, d);

  const pleskPublicKey = await registerRepoInPlesk(ssh, d, urlSsh);

  await registerKeyInGitHub(pleskPublicKey, registerKeyFn);

  await manualBareClone(ssh, d, urlSsh);

  await injectKrakenDeployScript(ssh, d, opciones.versionNode);

  await configureCICD(ssh, d);

  await firstPleskDeploy(ssh, d);

  await provisionNodeJS(ssh, d);

  await forceBootstrapDeploy(ssh, d);

  await enableAutoDeployMode(ssh, d);

  return { urlSsh, pleskPublicKey };
}

module.exports = { configurarRepoEnPlesk, transformarUrlSsh };

