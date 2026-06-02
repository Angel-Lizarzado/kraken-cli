/**
 * @module SOURCESYNC/deployOrchestrator
 * @description Orquestador de despliegue automatizado de proyectos Next.js (Standalone) en Plesk.
 *
 * Coordina el flujo completo de configuración inicial de un dominio:
 *  1. Verificar/crear la suscripción del dominio en Plesk (cliente Dev).
 *  2. [Opcional] Vincular llave SSH Ed25519 con GitHub (solo si no está vinculado).
 *  3. Garantizar versión Node.js funcional en el dominio (con fallback a v24.15.0).
 *  4. Vincular repositorio GitHub al dominio en Plesk.
 *  5. Ejecutar el primer fetch/deploy vía `plesk ext git --fetch`.
 *
 * Emite eventos al ProgressEmitter para actualización en tiempo real de la UI.
 * El orquestador recibe una instancia NodeSSH ya conectada — no gestiona conexiones.
 *
 * Uso típico desde un IPC handler:
 *   const { orchestrarDespliegue } = require('./SOURCESYNC/deployOrchestrator');
 *   await orchestrarDespliegue(sshConectado, config, (evento) => mainWindow.webContents.send('scalify:progreso', evento));
 */

'use strict';

const axios = require('axios');
const { garantizarVersionNode } = require('./nodeManager');
const { configurarRepoEnPlesk } = require('./pleskGit');
const { ensureSubscriptionExists } = require('./domainManager');
const { getProgressEmitter } = require('../progress-emitter');

/**
 * @typedef {Object} ConfigDespliegue
 * @property {string}  domain        - Dominio Plesk a configurar (ej: "app.example.com").
 * @property {string}  httpsUrl      - URL HTTPS del repo GitHub (ej: "https://github.com/org/repo").
 * @property {string}  repoOwner     - Propietario del repositorio (ej: "acme-corp").
 * @property {string}  repoName      - Nombre del repositorio (ej: "mi-app").
 * @property {string}  githubToken   - Personal Access Token con permiso `repo`.
 * @property {boolean} [vincularGitHub=true]  - Si false, omite el paso de vinculación de llave SSH.
 * @property {string}  [rama='main'] - Rama a desplegar.
 */

/**
 * @typedef {Object} ResultadoDespliegue
 * @property {boolean} exito             - true si todos los pasos completaron sin error.
 * @property {string}  versionNode       - Versión de Node.js asignada al dominio.
 * @property {string}  urlSsh            - URL SSH final del repositorio vinculado.
 * @property {string}  llavePub          - Llave pública Ed25519 registrada en GitHub (si aplica).
 * @property {string}  [error]           - Mensaje de error si `exito` es false.
 * @property {string}  taskId            - ID de tarea del ProgressEmitter.
 */

/**
 * Orquesta el flujo completo de configuración de despliegue Next.js en Plesk.
 *
 * @param {import('node-ssh').NodeSSH} ssh  - Instancia NodeSSH ya conectada al servidor.
 * @param {ConfigDespliegue} config         - Configuración del despliegue.
 * @param {Function} [onProgreso]           - Callback adicional para eventos de progreso.
 *                                           Firma: (evento: { paso: string, progreso: number, mensaje: string }) => void
 * @returns {Promise<ResultadoDespliegue>}
 */
async function orchestrarDespliegue(ssh, config, onProgreso) {
  const {
    domain,
    httpsUrl,
    repoOwner,
    repoName,
    githubToken,
    vincularGitHub = true,
    rama = 'main',
  } = config;

  // Validar parámetros obligatorios antes de empezar
  if (!domain || !httpsUrl || !repoOwner || !repoName) {
    throw new Error(
      '[SOURCESYNC:Orquestador] Parámetros obligatorios faltantes: domain, httpsUrl, repoOwner, repoName.'
    );
  }
  if (vincularGitHub && !githubToken) {
    throw new Error(
      '[SOURCESYNC:Orquestador] githubToken es obligatorio cuando vincularGitHub=true.'
    );
  }

  // Obtener el ProgressEmitter singleton para reportar a la UI
  const emitter = getProgressEmitter();
  const taskId = emitter.createTask('SOURCESYNC-deploy', domain, `Iniciando despliegue de ${domain}...`);

  /**
   * Función auxiliar para emitir progreso tanto al ProgressEmitter como al callback externo.
   * @param {number} porcentaje
   * @param {string} paso      - Identificador del paso actual.
   * @param {string} mensaje   - Mensaje descriptivo.
   */
  const emitirProgreso = (porcentaje, paso, mensaje) => {
    emitter.emitProgress(taskId, porcentaje, mensaje);
    if (typeof onProgreso === 'function') {
      try {
        onProgreso({ paso, progreso: porcentaje, mensaje, domain, taskId });
      } catch (_) {
        // El callback no debe bloquear el flujo principal
      }
    }
  };

  let llavePub = '';
  let urlSsh = '';
  let versionNode = '';

  try {
    // ── PASO 1: Verificar / crear suscripción en Plesk ───────────────────────────
    emitirProgreso(3, 'plesk-suscripcion', `[1/5] Verificando suscripción Plesk para ${domain}...`);

    const resultadoSuscripcion = await ensureSubscriptionExists(ssh, domain);

    if (resultadoSuscripcion.status === 'created') {
      emitirProgreso(
        8,
        'plesk-suscripcion-creada',
        `[1/5] Suscripción creada y asignada a SOURCESYNC (Dev). IP detectada automáticamente.`
      );
    } else {
      emitirProgreso(
        8,
        'plesk-suscripcion-ok',
        `[1/5] ${resultadoSuscripcion.message}`
      );
    }

    // ── PASO 2: Vinculación GitHub ─────────────────────────────────────────
    // La llave SSH de Plesk se extrae en el Paso 4 (configurarRepoEnPlesk).
    // Aquí solo emitimos progreso para que la UI avance correctamente.
    emitirProgreso(
      35,
      'github-ssh-ok',
      `[2/5] Llave SSH se registrará desde Plesk en el Paso 4.`
    );

    // ── PASO 3: Garantizar versión Node.js ─────────────────────────────
    emitirProgreso(40, 'node-version', `[3/5] Configurando versión Node.js para ${domain}...`);

    versionNode = await garantizarVersionNode(ssh, domain);

    emitirProgreso(
      62,
      'node-version-ok',
      `[3/5] Node.js ${versionNode} asignado correctamente al dominio ${domain}.`
    );

    // ── PASO 4: Vincular repositorio en Plesk ──────────────────────────────
    // Plesk genera su propia llave SSH interna. configurarRepoEnPlesk:
    //  1. Hace --create con URL estándar de GitHub
    //  2. Extrae la llave con --info
    //  3. Llama a registerKeyFn para registrarla en la GitHub API
    //  4. Espera el clone real (waitForBranches)
    //  5. Configura y ejecuta el primer deploy
    emitirProgreso(67, 'plesk-git', `[4/5] Vinculando repositorio y configurando CI/CD para ${domain}...`);

    const registerKeyFn = async (pleskPublicKey) => {
      emitirProgreso(72, 'github-deploy-key', `[4/5] Registrando llave de Plesk en GitHub...`);
      try {
        await axios.post(
          `https://api.github.com/repos/${repoOwner}/${repoName}/keys`,
          {
            title: `Plesk-${domain}-${new Date().toISOString().slice(0, 10)}`,
            key: pleskPublicKey,
            read_only: true,
          },
          {
            headers: {
              Authorization: `Bearer ${githubToken}`,
              Accept: 'application/vnd.github+json',
              'X-GitHub-Api-Version': '2022-11-28',
            },
          }
        );
        console.log(`[SOURCESYNC:GitHub] Llave registrada exitosamente en GitHub.`);
      } catch (err) {
        if (err.response && err.response.status === 422) {
          // 422 = "key is already in use" — la llave ya está registrada, el clone funcionará igualmente.
          console.log(`[SOURCESYNC:GitHub] La llave ya existe en GitHub (422). Continuando...`);
        } else {
          // Cualquier otro error (401 Unauthorized, 404 Not Found, etc.) sí es crítico.
          throw err;
        }
      }
      llavePub = pleskPublicKey;
    };

    const resultadoGit = await configurarRepoEnPlesk(ssh, domain, httpsUrl, registerKeyFn, { rama });
    urlSsh = resultadoGit.urlSsh;

    emitirProgreso(
      83,
      'plesk-git-ok',
      `[4/5] Repositorio vinculado: ${urlSsh}. Deploy action: "sh ./deploy.sh".`
    );

    emitirProgreso(87, 'primer-deploy', `[5/5] Pull inicial completado. Archivos del repositorio clonados.`);

    // --- [NUEVO] Aprovisionamiento Automático de Correo ---
    try {
      emitirProgreso(95, 'correo-setup', `[6/6] Configurando buzón info@${domain}...`);
      const { asegurarBuzonInfo } = require('../mail-service');
      // En deployOrchestrator, ssh es un objeto de node-ssh
      const executeFn = async (cmd) => {
        const { stdout, stderr, code } = await ssh.execCommand(cmd);
        return { stdout, stderr };
      };
      const mailRes = await asegurarBuzonInfo(domain, executeFn);
      
      if (mailRes.exito) {
        emitirProgreso(98, 'correo-ok', `[CORREO] ${mailRes.mensaje}`);
      } else {
        emitirProgreso(98, 'correo-warn', `[CORREO-WARN] ${mailRes.mensaje}`);
      }
    } catch (err) {
      console.warn(`[SOURCESYNC:Orquestador] Error fatal en aprovisionamiento de correo para ${domain}:`, err.message);
    }

    emitirProgreso(
      100,
      'primer-deploy-ok',
      `[5/5] Despliegue completado exitosamente. Repositorio: ${urlSsh}.`
    );

    // Marcar tarea como completada en el ProgressEmitter
    emitter.completeTask(
      taskId,
      `Despliegue de ${domain} configurado. Node.js ${versionNode}. Repo: ${urlSsh}.`
    );

    return {
      exito: true,
      versionNode,
      urlSsh,
      llavePub,
      taskId,
    };
  } catch (error) {
    // Registrar el error en el ProgressEmitter (fatal=true marca la tarea como fallida)
    emitter.emitError(taskId, error, true);

    const mensajeError = error.message || String(error);

    emitirProgreso(
      emitter.getTaskInfo(taskId)?.progress ?? 0,
      'error-fatal',
      `Error fatal en despliegue de ${domain}: ${mensajeError}`
    );

    console.error(`[SOURCESYNC:Orquestador] Error durante despliegue de ${domain}:`, error);

    return {
      exito: false,
      versionNode,
      urlSsh,
      llavePub,
      error: mensajeError,
      taskId,
    };
  }
}

/**
 * Dispara únicamente el fetch de actualización en un dominio ya configurado.
 * Útil para actualizaciones subsiguientes sin reconfigurar la infraestructura.
 *
 * @param {import('node-ssh').NodeSSH} ssh - Instancia NodeSSH ya conectada.
 * @param {string} domain                  - Dominio Plesk ya configurado.
 * @returns {Promise<{ exito: boolean, salida: string, error?: string }>}
 */
async function dispararFetch(ssh, domain) {
  if (!domain) {
    throw new Error('[SOURCESYNC:Orquestador] dispararFetch: domain es obligatorio.');
  }

  console.log(`[SOURCESYNC:Orquestador] Disparando fetch para ${domain}...`);

  const { code, stdout, stderr } = await ssh.execCommand(
    `plesk ext git --fetch -domain ${domain}`
  );

  if (code !== 0) {
    const mensajeError = `Fetch falló para ${domain} (código ${code}): ${stderr || stdout}`;
    console.error(`[SOURCESYNC:Orquestador] ${mensajeError}`);
    return { exito: false, salida: stdout, error: mensajeError };
  }

  console.log(`[SOURCESYNC:Orquestador] Fetch completado para ${domain}.`);
  return { exito: true, salida: stdout };
}

module.exports = { orchestrarDespliegue, dispararFetch };

