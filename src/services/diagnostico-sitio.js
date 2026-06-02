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
async function diagnosticarSitio(ejecutarSSH, dominio, ultimasLineas = 50) {
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
      return {
        errorDetectado: false,
        tipo: 'LOG_NO_ENCONTRADO',
        descripcion: `No se encontró el archivo de log en ${rutaLog}`,
        accionRecomendada: 'verificar_ruta_log',
        comandoMitigacion: null,
      };
    }
  } catch (errSSH) {
    return {
      errorDetectado: false,
      tipo: 'ERROR_CONEXION_SSH',
      descripcion: `Fallo al leer el log vía SSH: ${errSSH.message}`,
      accionRecomendada: null,
      comandoMitigacion: null,
    };
  }

  // Paso B: Resolver el instanceId de Plesk para este dominio
  const instanceId = await resolverInstanceId(ejecutarSSH, dominio);

  // Paso C: Ejecutar el motor de diagnóstico
  const payload = await analizarYRecomendarAccion(stdoutDelLog, instanceId, dominio, ejecutarSSH);

  return payload;
}

module.exports = { diagnosticarSitio };
