'use strict';

const { DICCIONARIO_DE_REGLAS } = require('./diccionario-reglas');
const { construirRecomendacion } = require('./mapa-recomendaciones');
const { leerMemoriaActualDominio } = require('./lector-estado-php');

/**
 * RESUELVE EL instanceId DE PLESK A PARTIR DEL DOMINIO
 *
 * Ejecuta "plesk ext wp-toolkit --list" y parsea la salida para encontrar
 * el ID numérico de la instalación WP asociada al dominio dado.
 *
 * @param {Function} ejecutarSSH - función async que recibe un comando string
 *                                  y devuelve { stdout, stderr }
 * @param {string} dominio       - ej. "ejemplo.com"
 * @returns {string|null}        - el ID como string, o null si no se encontró
 */
async function resolverInstanceId(ejecutarSSH, dominio) {
  const { stdout } = await ejecutarSSH('plesk ext wp-toolkit --list');

  // La salida de --list es una tabla de texto. Cada línea de datos comienza
  // con el ID numérico seguido del dominio. Buscamos la línea que contenga
  // el dominio exacto.
  //
  // Ejemplo de línea:
  // "  42   1   /httpdocs   1   true   https://ejemplo.com   Mi Sitio   6.5"
  //
  // Regex: captura el primer número de la línea que contiene el dominio
  const regexLinea = new RegExp(`^\\s*(\\d+)\\s+.*${dominio.replace('.', '\\.')}`, 'mi');
  const coincidencia = stdout.match(regexLinea);

  return coincidencia ? coincidencia[1].trim() : null;
}

/**
 * MOTOR PRINCIPAL DE DIAGNÓSTICO
 *
 * Lee las últimas líneas del error_log del dominio y retorna un payload
 * estructurado con el diagnóstico y la recomendación de mitigación.
 *
 * @param {string} stdoutDelLog   - Contenido del error_log (últimas N líneas)
 * @param {string} instanceId     - ID numérico de la instalación WP en Plesk
 * @param {string} dominio        - Nombre del dominio
 * @param {Function} ejecutarSSH  - Función para ejecutar comandos SSH
 * @returns {Object}              - Payload JSON con diagnóstico completo
 */
async function analizarYRecomendarAccion(stdoutDelLog, instanceId, dominio, ejecutarSSH, httpCode = null) {

  // ── Leer estado actual de memoria del dominio ───────────────────────────
  // Se hace siempre, no solo cuando detectamos un error de plugin.
  // Costo: 1 comando SSH adicional. Beneficio: decisiones correctas.
  const memoriaMB = await leerMemoriaActualDominio(ejecutarSSH, dominio);

  const estadoSitio = { dominio, memoriaMB };

  // ── PASO 2: Ordenar reglas por prioridad (menor número = evaluar primero) ─
  const reglasPorPrioridad = [...DICCIONARIO_DE_REGLAS].sort(
    (a, b) => a.prioridad - b.prioridad
  );

  // ── PASO 3: Evaluar cada regla contra el log y httpCode ───────────────────
  let reglaDetectada = null;
  let contextoExtraido = {};
  
  // Incluimos un mensaje falso en el log si no hay instanceId para que lo pille la regex
  const entrada = `${stdoutDelLog || ''}\n${!instanceId ? 'No se pudo resolver el instanceId de Plesk' : ''}`;

  for (const regla of reglasPorPrioridad) {
    if (regla.httpCodes && !regla.httpCodes.includes(httpCode)) continue;

    const coincidencia = entrada.match(regla.regex);

    if (coincidencia) {
      reglaDetectada = regla;
      contextoExtraido = regla.extraerContexto(coincidencia);
      break; 
    }

    if (regla.detectarPorCodigo && regla.httpCodes?.includes(httpCode)) {
      reglaDetectada = regla;
      contextoExtraido = regla.extraerContexto(['']);
      break;
    }
  }

  // ── PASO 4: Si no se detectó ninguna regla conocida ──────────────────────
  if (!reglaDetectada) {
    return {
      errorDetectado: false,
      tipo: 'DESCONOCIDO',
      culpable: null,
      accionRecomendada: 'revision_manual',
      descripcion: 'No se encontró un patrón conocido. Revisión manual requerida.',
      comandoMitigacion: null,
      riesgo: 'INDETERMINADO',
      requiereConfirmacion: true,
      metadatos: { totalLineasAnalizadas: (stdoutDelLog||'').split('\n').length, instanceId, memoriaMB },
    };
  }

  // ── PASO 5: Construir la recomendación basada en el tipo detectado ────────
  const recomendacion = construirRecomendacion(
    reglaDetectada.nombre,
    contextoExtraido,
    instanceId,
    estadoSitio   // ← NUEVO: el mapa ahora recibe el estado real del servidor
  );

  // ── PASO 6: Ensamblar y retornar el payload final ─────────────────────────
  return {
    errorDetectado: true,
    tipo: reglaDetectada.nombre,
    culpable: contextoExtraido.culpable,
    accionRecomendada: recomendacion.accionRecomendada,
    descripcion: recomendacion.descripcion,
    comandoMitigacion: recomendacion.comandoMitigacion,
    comandoAlternativo: recomendacion.comandoEscaladoSiPersiste
      || recomendacion.comandoAlternativoEliminar
      || recomendacion.comandoDiagnosticoPrevio
      || null,
    riesgo: recomendacion.riesgo,
    requiereConfirmacion: recomendacion.requiereConfirmacion,
    notaAdicional: recomendacion.notaAdicional || null,
    esAccionEscalada: recomendacion.esAccionEscalada ?? false,
    metadatos: {
      totalLineasAnalizadas: stdoutDelLog.split('\n').length,
      instanceId,
      memoriaMBActual: memoriaMB,
      ...contextoExtraido,
    },
  };
}

/**
 * Constructor de payload de error del sistema (no del sitio WP)
 * Se usa cuando falla la propia infraestructura del motor.
 */
function construirPayloadError(mensajeError) {
  return {
    errorDetectado: false,
    tipo: 'ERROR_MOTOR',
    culpable: null,
    accionRecomendada: null,
    descripcion: mensajeError,
    comandoMitigacion: null,
    riesgo: 'INDETERMINADO',
    requiereConfirmacion: true,
    metadatos: {},
  };
}

module.exports = { analizarYRecomendarAccion, resolverInstanceId };
