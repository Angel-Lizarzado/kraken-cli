/**
 * @module SOURCESYNC/nodeManager
 * @description Gestión resiliente de versiones de Node.js en Plesk.
 *
 * Bug conocido de Plesk (validado en producción):
 *  Las versiones LTS (20, 22) frecuentemente están instaladas pero en estado
 *  `false` (deshabilitadas) y fallan al asignarse al dominio, incluso tras
 *  intentar habilitarlas. La versión 24.15.0 es la única que funciona de forma
 *  consistente en el entorno actual.
 *
 * Estrategia de fallback:
 *  1. Intentar habilitar y usar la versión LTS más reciente disponible (20.x o 22.x).
 *  2. Si falla o permanece en estado `false`, hacer fallback automático a v24.15.0.
 *  3. Asignar la versión final al dominio.
 */

'use strict';

/** Versión de fallback garantizada que funciona en Plesk (validada en producción). */
const VERSION_FALLBACK = '24.15.0';

/** Prefijos de versiones LTS preferidas (en orden de preferencia descendente). */
const PREFIJOS_LTS = ['22.', '20.'];

/**
 * Parsea la salida de `plesk ext nodejs --versions` y devuelve un array de objetos.
 * Formato esperado de la salida:
 *   "20.20.2  false  0"
 *   "22.14.0  false  1"
 *   "24.15.0  true   2"
 *
 * @param {string} stdout - Salida cruda del comando.
 * @returns {Array<{ version: string, habilitada: boolean, indice: number }>}
 */
function parsearVersiones(stdout) {
  return stdout
    .split('\n')
    .map((linea) => linea.trim())
    .filter((linea) => linea.length > 0)
    .map((linea) => {
      const partes = linea.split(/\s+/);
      return {
        version: partes[0] || '',
        habilitada: partes[1] === 'true',
        indice: parseInt(partes[2] ?? '-1', 10),
      };
    })
    .filter((v) => v.version.match(/^\d+\.\d+\.\d+$/)); // Solo versiones semver válidas
}

/**
 * Intenta habilitar y asignar una versión de Node.js específica al dominio.
 * Devuelve true si tuvo éxito, false si falló.
 *
 * @param {import('node-ssh').NodeSSH} ssh
 * @param {string} domain
 * @param {string} version
 * @returns {Promise<boolean>}
 */
async function intentarAsignarVersion(ssh, domain, version) {
  console.log(`[SOURCESYNC:Node] Intentando asignar Node.js ${version} al dominio ${domain}...`);

  // 1. Habilitar la versión en el panel global de Plesk (no-op si ya está)
  const { code: codeHabilitar, stderr: errHabilitar } = await ssh.execCommand(
    `plesk ext nodejs --enable -version ${version}`
  );
  if (codeHabilitar !== 0) {
    console.warn(`[SOURCESYNC:Node] Advertencia al habilitar versión ${version} globalmente: ${errHabilitar}`);
    // No abortamos — puede que ya esté habilitada y Plesk devuelva non-zero igualmente
  }

  // 2. Asignar la versión al dominio
  //    Si --set-version devuelve código 0, Plesk lo confirmó. Confiamos en eso.
  const { code, stderr, stdout } = await ssh.execCommand(
    `plesk ext nodejs --set-version -domain ${domain} -version ${version}`
  );

  if (code !== 0) {
    console.warn(
      `[SOURCESYNC:Node] Fallo al asignar Node.js ${version} a ${domain} (código ${code}): ${stderr || stdout}`
    );
    return false;
  }

  console.log(`[SOURCESYNC:Node] ✓ Node.js ${version} asignado a ${domain}. Respuesta: ${stdout || '(ok)'}`);
  return true;
}

/**
 * Garantiza que el dominio Plesk tenga una versión funcional de Node.js asignada.
 *
 * Algoritmo:
 *  1. Consulta versiones instaladas.
 *  2. Busca versiones LTS (22.x, 20.x) habilitadas. Si existe una, intenta usarla.
 *  3. Si la LTS está en estado `false` o falla al asignarse, hace fallback a v24.15.0.
 *  4. Devuelve la versión finalmente asignada.
 *
 * @param {import('node-ssh').NodeSSH} ssh - Instancia NodeSSH ya conectada.
 * @param {string} domain                  - Dominio Plesk destino (ej: "app.example.com").
 * @returns {Promise<string>}              - Versión de Node.js efectivamente asignada.
 * @throws {Error}                         - Si ninguna versión puede asignarse (crítico).
 */
async function garantizarVersionNode(ssh, domain) {
  // Encender el motor Node.js para el dominio ANTES de intentar asignar versión.
  // Si ya estaba habilitado, Plesk puede devolver código no-cero — no es crítico.
  console.log(`[SOURCESYNC:Node] Encendiendo motor Node.js para ${domain}...`);
  const { code: enableCode, stderr: enableErr } = await ssh.execCommand(
    `plesk ext nodejs --enable -domain ${domain}`
  );
  if (enableCode !== 0) {
    console.warn(`[SOURCESYNC:Node] Advertencia al habilitar Node.js en ${domain}: ${enableErr}`);
  }

  console.log(`[SOURCESYNC:Node] Consultando versiones de Node.js disponibles en Plesk...`);

  const { stdout: listaRaw, code: codeLista } = await ssh.execCommand(
    'plesk ext nodejs --versions'
  );

  if (codeLista !== 0) {
    console.warn(
      `[SOURCESYNC:Node] No se pudo listar versiones de Node.js. Procediendo directo a fallback.`
    );
  }

  const versiones = parsearVersiones(listaRaw || '');
  console.log(
    `[SOURCESYNC:Node] Versiones detectadas: ${versiones.map((v) => `${v.version}(${v.habilitada ? 'ON' : 'OFF'})`).join(', ') || 'ninguna'}`
  );

  // ── Intento 1: Versión LTS preferida (22.x > 20.x) ──────────────────────
  for (const prefijo of PREFIJOS_LTS) {
    const candidatas = versiones
      .filter((v) => v.version.startsWith(prefijo))
      .sort((a, b) => {
        // Ordenar descendente por versión completa para elegir la más reciente
        return b.version.localeCompare(a.version, undefined, { numeric: true });
      });

    for (const candidata of candidatas) {
      const exito = await intentarAsignarVersion(ssh, domain, candidata.version);
      if (exito) {
        return candidata.version;
      }
    }
  }

  // ── Intento 2 (Fallback): v24.15.0 — Validada en producción ─────────────
  console.warn(
    `[SOURCESYNC:Node] Las versiones LTS fallaron o no están disponibles. ` +
    `Aplicando fallback forzado a v${VERSION_FALLBACK}...`
  );

  const exitoFallback = await intentarAsignarVersion(ssh, domain, VERSION_FALLBACK);

  if (!exitoFallback) {
    throw new Error(
      `[SOURCESYNC:Node] Fallo crítico: No se pudo asignar ninguna versión de Node.js al dominio ${domain}. ` +
      `Verificar manualmente en el panel Plesk → Extensiones → Node.js.`
    );
  }

  return VERSION_FALLBACK;
}

module.exports = { garantizarVersionNode, parsearVersiones, VERSION_FALLBACK };

