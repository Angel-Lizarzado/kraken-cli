'use strict';

const { analizarYRecomendarAccion, resolverInstanceId } = require('./motor-diagnostico');

/**
 * PUNTO DE ENTRADA DEL DIAGNÓSTICO
 * Orquesta: leer el log → resolver instanceId → analizar → retornar payload
 *
 * @param {Function} ejecutarSSH - función async (comando: string) => { stdout, stderr }
 * @param {string}   dominio     - ej. "ejemplo.com"
 * @param {number}   ultimasLineas - cuántas líneas del log leer (default: 100)
 */
async function diagnosticarSitio(ejecutarSSH, dominio, ultimasLineas = 50, httpCode = null) {
  // Paso A: Leer las últimas N líneas del error_log del dominio
  // "tail -n" es eficiente: no carga todo el archivo en memoria
  const rutaLog = `/var/www/vhosts/${dominio}/logs/error_log`;
  const comandoLectura = `tail -n ${ultimasLineas} "${rutaLog}" 2>&1`;

  let stdoutDelLog;
  try {
    const resultado = await ejecutarSSH(comandoLectura);
    stdoutDelLog = resultado.stdout;

    // Si el log no existe, stderr contendrá "No such file or directory"
    if (!stdoutDelLog || stdoutDelLog.includes('No such file or directory')) {
      stdoutDelLog = ''; // En vez de retornar aquí, permitimos evaluar por httpCode
    }
  } catch (errSSH) {
    stdoutDelLog = ''; // Falló log, pero igual evaluamos httpCode
  }

  // Paso B: Resolver el instanceId de Plesk para este dominio
  let instanceId = null;
  try {
    instanceId = await resolverInstanceId(ejecutarSSH, dominio);
  } catch (err) {
    console.warn(`[Motor] No se pudo obtener el instanceId de ${dominio}: ${err.message}`);
  }

  // Paso C: Ejecutar el motor de diagnóstico
  const payload = await analizarYRecomendarAccion(stdoutDelLog, instanceId, dominio, ejecutarSSH, httpCode);

  return payload;
}

module.exports = { diagnosticarSitio };
