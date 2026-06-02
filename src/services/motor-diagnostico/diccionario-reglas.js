'use strict';

/**
 * DICCIONARIO DE REGLAS DE DETECCIÓN
 * Cada regla tiene:
 *   - nombre:      identificador único del tipo de error
 *   - regex:       expresión regular para detectar el patrón en el log
 *   - extraerContexto: función que recibe el resultado del match y devuelve
 *                  los datos adicionales necesarios para la recomendación
 *   - prioridad:   número menor = se evalúa primero (evita falsos positivos)
 */
const DICCIONARIO_DE_REGLAS = [

  // ── REGLA 0: .htaccess Corrupto ───────────────────────────────────────────
  // Cubre: "</files> without matching <files> section" o errores de sintaxis
  {
    nombre: 'htaccess_corrupto',
    prioridad: 0,
    regex: /<\/files>\s+without\s+matching\s+<files>\s+section|\.htaccess.*(?:Invalid|syntax error|pcre_compile)/i,
    extraerContexto() {
      return { culpable: 'htaccess' };
    },
  },

  // ── REGLA 1: Fatal Error causado por un Plugin ────────────────────────────
  // Patrón real del log: PHP Fatal error: Uncaught Error: Class "X" not found
  // in /var/www/vhosts/dominio/httpdocs/wp-content/plugins/PLUGIN/archivo.php
  {
    nombre: 'PLUGIN_FATAL_ERROR',
    prioridad: 1,
    regex: /PHP\s+Fatal\s+error[\s\S]*?wp-content\/plugins\/([a-z0-9_-]+)\//i,
    extraerContexto(coincidencia) {
      return {
        // Grupo 1 captura el nombre de la carpeta del plugin (ej. "cookie-notice")
        culpable: coincidencia[1] || 'desconocido',
      };
    },
  },

  // ── REGLA 2: Error de Conexión a Base de Datos ────────────────────────────
  // Cubre: "Error establishing a database connection" (WP clásico)
  // y:     "mysqli_real_connect(): (HY000/2002): Connection refused" (PHP directo)
  {
    nombre: 'ERROR_BASE_DE_DATOS',
    prioridad: 2,
    regex: /Error\s+establishing\s+a\s+database\s+connection|mysqli_real_connect\(\).*HY000|Can't\s+connect\s+to\s+(local\s+)?MySQL/i,
    extraerContexto() {
      return { culpable: 'base-de-datos' };
    },
  },

  // ── REGLA 3: Memoria PHP Exhausta ─────────────────────────────────────────
  // Cubre: "Allowed memory size of 134217728 bytes exhausted"
  {
    nombre: 'MEMORIA_EXHAUSTA',
    prioridad: 3,
    regex: /Allowed\s+memory\s+size\s+of\s+(\d+)\s+bytes\s+exhausted/i,
    extraerContexto(coincidencia) {
      // Convierte bytes a MB para la recomendación legible
      const bytesActuales = parseInt(coincidencia[1], 10);
      const mbActuales = Math.round(bytesActuales / 1024 / 1024);
      const mbRecomendado = mbActuales < 256 ? 256 : mbActuales * 2;
      return {
        culpable: 'configuracion-php',
        limiteActualMB: mbActuales,
        limiteRecomendadoMB: mbRecomendado,
      };
    },
  },

  // ── REGLA 4: Core Corrupto o Archivo Faltante del Core ───────────────────
  // Cubre: "require_once(wp-includes/functions.php): failed to open stream"
  // y:     "Failed opening required '/httpdocs/wp-login.php'"
  // NO debe confundirse con plugins (por eso excluye wp-content en el path)
  {
    nombre: 'CORE_CORRUPTO',
    prioridad: 4,
    regex: /(?:require|include)(?:_once)?\s*\(['"](wp-(?:includes|admin|login|cron|settings|trackback|comments|xmlrpc)[^'"]*)['"]\)[^:]*(?:failed to open stream|No such file)/i,
    extraerContexto(coincidencia) {
      return {
        culpable: 'wordpress-core',
        archivoAfectado: coincidencia[1] || 'wp-includes desconocido',
      };
    },
  },
];

module.exports = { DICCIONARIO_DE_REGLAS };
