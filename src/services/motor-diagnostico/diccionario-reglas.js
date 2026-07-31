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

  {
    nombre: 'htaccess_corrupto',
    prioridad: 0,
    regex: /<\/files>\s+without\s+matching\s+<files>\s+section|\.htaccess.*(?:Invalid|syntax error|pcre_compile)/i,
    extraerContexto() {
      return { culpable: 'htaccess' };
    },
  },

  {
    nombre: 'PLUGIN_FATAL_ERROR',
    prioridad: 1,
    regex: /PHP\s+Fatal\s+error[\s\S]*?wp-content\/plugins\/([a-z0-9_-]+)\//i,
    extraerContexto(coincidencia) {
      return { culpable: coincidencia[1] || 'desconocido' };
    },
  },

  {
    nombre: 'ERROR_BASE_DE_DATOS',
    prioridad: 2,
    regex: /Error\s+establishing\s+a\s+database\s+connection|mysqli_real_connect\(\).*HY000|Can't\s+connect\s+to\s+(local\s+)?MySQL/i,
    extraerContexto() {
      return { culpable: 'base-de-datos' };
    },
  },

  {
    nombre: 'MEMORIA_EXHAUSTA',
    prioridad: 3,
    regex: /Allowed\s+memory\s+size\s+of\s+(\d+)\s+bytes\s+exhausted/i,
    extraerContexto(coincidencia) {
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

  {
    nombre: 'CORE_CORRUPTO',
    prioridad: 4,
    regex: /(?:require|include)(?:_once)?\s*\(['"](wp-(?:includes|admin|login|cron|settings|trackback|comments|xmlrpc)[^'"]*)['"]\)[^:]*(?:failed to open stream|No such file)/i,
    extraerContexto(coincidencia) {
      return {
        culpable: 'wordpress-core',
        archivoAfectado: coincidencia[1] || 'wp-core desconocido',
      };
    },
  },

  {
    nombre: 'PERMISOS_INCORRECTOS',
    prioridad: 5,
    httpCodes: [403],
    regex: /Permission\s+denied|AH00035:\s+access\s+to\s+.*denied|client\s+denied\s+by\s+server\s+configuration/i,
    extraerContexto(coincidencia) {
      const pathMatch = coincidencia[0].match(/access\s+to\s+([^\s"]+)/i);
      return {
        culpable: 'permisos-filesystem',
        rutaAfectada: pathMatch ? pathMatch[1] : 'httpdocs',
      };
    },
  },

  {
    nombre: 'MODSECURITY_BLOQUEO',
    prioridad: 6,
    httpCodes: [403],
    regex: /ModSecurity[:\s].*\[id\s+"(\d+)"\]|ModSecurity:\s+Access\s+denied\s+with\s+code\s+403/i,
    extraerContexto(coincidencia) {
      const reglaId = coincidencia[1] || null;
      return {
        culpable: 'modsecurity',
        reglaId,
        esReglaConocida: ['218500', '340162', '200003'].includes(reglaId),
      };
    },
  },

  {
    nombre: 'SIN_ARCHIVO_INDICE',
    prioridad: 7,
    httpCodes: [403],
    regex: /Directory\s+index\s+forbidden|No\s+directory\s+index\s+file\s+found|AH01276:.*directory\s+index\s+of/i,
    extraerContexto() {
      return { culpable: 'directorio-sin-indice' };
    },
  },

  {
    nombre: 'IP_BLOQUEADA_FIREWALL',
    prioridad: 8,
    httpCodes: [403],
    regex: /fail2ban|plesk.*firewall.*block|iptables.*REJECT|UFW\s+BLOCK/i,
    extraerContexto(coincidencia) {
      const ipMatch = coincidencia[0].match(/(\d{1,3}(?:\.\d{1,3}){3})/);
      return {
        culpable: 'firewall-ip-bloqueada',
        ipBloqueada: ipMatch ? ipMatch[1] : null,
      };
    },
  },

  {
    nombre: 'CLOUDFLARE_TIMEOUT_522',
    prioridad: 9,
    httpCodes: [522],
    regex: /cloudflare.*522|Error\s+522|Connection\s+timed\s+out.*cloudflare|Ray\s+ID.*522/i,
    extraerContexto() {
      return {
        culpable: 'cloudflare-origin-timeout',
        posiblesCausas: ['servidor_sobrecargado', 'firewall_bloquea_cloudflare', 'ip_cloudflare_no_whitelisted'],
      };
    },
    detectarPorCodigo: true,
  },

  {
    nombre: 'SERVIDOR_INALCANZABLE_522',
    prioridad: 10,
    httpCodes: [522],
    regex: /Connection\s+refused|ECONNREFUSED|connect\(\)\s+to.*failed.*Connection\s+refused|upstream\s+timed\s+out/i,
    extraerContexto() {
      return { culpable: 'servidor-inalcanzable' };
    },
    detectarPorCodigo: true,
  },

  {
    nombre: 'PLESK_INSTANCE_NO_RESUELTA',
    prioridad: 11,
    httpCodes: [500, 428, null],
    regex: /No\s+se\s+pudo\s+resolver\s+el\s+instanceId|instanceId.*not\s+found|wp.toolkit.*instance.*not\s+registered/i,
    extraerContexto() {
      return { culpable: 'wptoolkit-instancia-no-registrada' };
    },
  },

  {
    nombre: 'DISCO_LLENO',
    prioridad: 12,
    httpCodes: [500],
    regex: /No\s+space\s+left\s+on\s+device|disk\s+quota\s+exceeded|ENOSPC/i,
    extraerContexto() {
      return { culpable: 'disco-lleno' };
    },
  },

  {
    nombre: 'PHP_FPM_CAIDO',
    prioridad: 13,
    httpCodes: [500],
    regex: /connect\(\)\s+to\s+unix:.*php.*fpm.*failed|php-fpm.*is\s+not\s+running|AH01079.*failed/i,
    extraerContexto(coincidencia) {
      const socketMatch = coincidencia[0].match(/unix:([^\s]+\.sock)/i);
      return {
        culpable: 'php-fpm-caido',
        socketFPM: socketMatch ? socketMatch[1] : null,
      };
    },
  },
];

module.exports = { DICCIONARIO_DE_REGLAS };
