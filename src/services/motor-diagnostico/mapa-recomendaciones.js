'use strict';

// ─── UMBRALES DE NEGOCIO ───────────────────────────────────────────────────
// Centralizar los umbrales aquí facilita ajustarlos sin tocar la lógica.
const UMBRAL_MEMORIA_MINIMA_MB = 256; // Por debajo de esto → subir primero
const OBJETIVO_MEMORIA_MB = 512; // Valor al que subiremos si está bajo
const UMBRAL_MEMORIA_SUFICIENTE = 512; // Por encima de esto → memoria NO es el problema

// ─── PLUGINS CONSIDERADOS "ESENCIALES" ────────────────────────────────────
// Para estos plugins, el motor NUNCA recomendará desactivar como primer paso,
// sin importar el estado de la memoria. Agrega los que uses en tus clientes.
const PLUGINS_ESENCIALES = new Set([
  'elementor',
  'elementor-pro',
  'woocommerce',
  'woocommerce-payments',
  'yoast-seo',
  'wordfence',
  'wpml',
  'acf',            // Advanced Custom Fields
  'advanced-custom-fields',
  'contact-form-7',
]);

/**
 * GENERADOR DE RECOMENDACIÓN PARA PLUGIN_FATAL_ERROR
 *
 * Implementa la jerarquía de cascada:
 *   Nivel 1 → Si memoria < UMBRAL_MEMORIA_MINIMA_MB:  subir memoria
 *   Nivel 2 → Si plugin es esencial + memoria OK:     subir memoria igualmente
 *   Nivel 3 → Si memoria ya es suficiente:            desactivar plugin
 *
 * @param {Object} contexto       - { culpable: 'nombre-plugin' }
 * @param {string} dominio        - ej. "ejemplo.com"
 * @param {string} instanceId     - ID de instalación WP en Plesk
 * @param {number|null} memoriaMB - Límite actual en MB, o null si no se pudo leer
 * @returns {Object}              - Objeto de recomendación completo
 */
function recomendacionPluginFatalError(contexto, dominio, instanceId, memoriaMB) {
  const { culpable } = contexto;
  const esPluginEsencial = PLUGINS_ESENCIALES.has(culpable);

  // ── NIVEL 1: Memoria desconocida o por debajo del umbral mínimo ───────────
  // Si no pudimos leer la memoria, asumimos que es baja (conservador y seguro)
  const memoriaEsBaja = memoriaMB === null || memoriaMB < UMBRAL_MEMORIA_MINIMA_MB;

  if (memoriaEsBaja) {
    return construirAccionMemoria({
      dominio,
      instanceId,
      culpable,
      memoriaMBActual: memoriaMB,
      razon: memoriaMB === null
        ? 'No se pudo leer el límite de memoria actual. Se aplica corrección preventiva.'
        : `Límite de memoria actual (${memoriaMB}MB) está por debajo del mínimo recomendado (${UMBRAL_MEMORIA_MINIMA_MB}MB).`,
    });
  }

  // ── NIVEL 2: Memoria entre 256MB y 512MB con plugin esencial ─────────────
  // Aunque está sobre el umbral mínimo, si el plugin es esencial y la memoria
  // no ha llegado a 512MB, todavía puede ser el problema.
  const memoriaBajoObjetivo = memoriaMB < UMBRAL_MEMORIA_SUFICIENTE;

  if (esPluginEsencial && memoriaBajoObjetivo) {
    return construirAccionMemoria({
      dominio,
      instanceId,
      culpable,
      memoriaMBActual: memoriaMB,
      razon: `"${culpable}" es un plugin esencial que requiere ≥${OBJETIVO_MEMORIA_MB}MB. ` +
        `Memoria actual: ${memoriaMB}MB. Se sube antes de considerar desactivar.`,
    });
  }

  // ── NIVEL 3: Memoria suficiente (≥512MB) o plugin no esencial ─────────────
  // La memoria ya es adecuada. El plugin es genuinamente el problema.
  return construirAccionDesactivarPlugin({
    dominio,
    instanceId,
    culpable,
    esPluginEsencial,
    memoriaMBActual: memoriaMB,
  });
}

// ─── CONSTRUCTORES DE ACCIONES ─────────────────────────────────────────────

function construirAccionMemoria({ dominio, instanceId, culpable, memoriaMBActual, razon }) {
  // Obtenemos el ID del handler de forma segura
  const comandoObtenerHandler = `plesk bin domain --info ${dominio} | grep php_handler_id | awk '{print $2}'`;

  // Construimos el comando de reload usando la variable
  const comandoReload = `${comandoObtenerHandler} | xargs -I{} systemctl reload {}`;

  return {
    accionRecomendada: 'ajuste_memoria_php',
    descripcion: razon,

    // CORRECCIÓN: Sintaxis segura para Plesk (sin corchetes raros)
    comandoMitigacion: `plesk bin php_settings -u ${dominio} -settings memory_limit=${OBJETIVO_MEMORIA_MB}M`,

    // AHORA SÍ estamos usando la variable comandoReload declarada arriba
    comandoReloadFPM: comandoReload,

    // Fallback de seguridad
    comandoReloadFPMAlt: `systemctl reload plesk-php*-fpm.service`,

    comandoEscaladoSiPersiste: `plesk ext wp-toolkit --wp-cli -instance-id ${instanceId} -- plugin deactivate ${culpable} --skip-plugins`,
    contextoPlugin: culpable,
    esAccionEscalada: false,
    riesgo: 'BAJO',
    requiereConfirmacion: false,
    notaAdicional: `Memoria actual detectada: ${memoriaMBActual ?? 'no disponible'}MB → Se ajustará a: ${OBJETIVO_MEMORIA_MB}MB.`,
  };
}

function construirAccionDesactivarPlugin({ dominio, instanceId, culpable, esPluginEsencial, memoriaMBActual }) {
  return {
    accionRecomendada: 'plugin_desactivar',
    descripcion: `Memoria actual (${memoriaMBActual}MB) es suficiente. ` +
      `El plugin "${culpable}" es la causa directa del error. ` +
      (esPluginEsencial
        ? `⚠️ ATENCIÓN: "${culpable}" es un plugin esencial. Notificar al cliente antes de proceder.`
        : 'Se puede desactivar de forma segura.'),
    // --skip-plugins: evita cargar otros plugins al ejecutar el comando,
    // crítico si el plugin culpable rompe el bootstrap de WordPress
    comandoMitigacion:
      `plesk ext wp-toolkit --wp-cli -instance-id ${instanceId} -- plugin deactivate ${culpable} --skip-plugins`,
    // Opción nuclear: solo si desactivar no es suficiente o el plugin no carga WP-CLI
    comandoAlternativoEliminar:
      `plesk ext wp-toolkit --wp-cli -instance-id ${instanceId} -- plugin delete ${culpable} --skip-plugins`,
    esAccionEscalada: true,
    riesgo: esPluginEsencial ? 'ALTO' : 'BAJO',
    requiereConfirmacion: esPluginEsencial,
    notaAdicional: esPluginEsencial
      ? `Este plugin puede ser requerido para el funcionamiento del sitio. Coordinar con el cliente.`
      : null,
  };
}

// ─── MAPA PRINCIPAL ────────────────────────────────────────────────────────

/**
 * Punto de entrada del mapa de recomendaciones.
 * Recibe el tipo de error y el contexto completo del sitio.
 */
function construirRecomendacion(tipoError, contexto, instanceId, estadoSitio = {}) {
  const { dominio, memoriaMB } = estadoSitio;

  const MAPA = {

    htaccess_corrupto: () => ({
      accionRecomendada: 'restaurar_htaccess',
      descripcion: 'Archivo .htaccess corrupto por error de sintaxis.',
      comandoMitigacion:
`mv /var/www/vhosts/${dominio}/httpdocs/.htaccess /var/www/vhosts/${dominio}/httpdocs/.htaccess.bak 2>/dev/null || true
cat << 'EOF' > /var/www/vhosts/${dominio}/httpdocs/.htaccess
# BEGIN WordPress
<IfModule mod_rewrite.c>
RewriteEngine On
RewriteRule .* - [E=HTTP_AUTHORIZATION:%{HTTP:Authorization}]
RewriteBase /
RewriteRule ^index\\.php$ - [L]
RewriteCond %{REQUEST_FILENAME} !-f
RewriteCond %{REQUEST_FILENAME} !-d
RewriteRule . /index.php [L]
</IfModule>
# END WordPress
EOF
plesk repair fs -y -vhosts ${dominio}`,
      riesgo: 'MEDIO',
      requiereConfirmacion: false,
    }),

    PLUGIN_FATAL_ERROR: () =>
      recomendacionPluginFatalError(contexto, dominio, instanceId, memoriaMB ?? null),

    ERROR_BASE_DE_DATOS: () => ({
      accionRecomendada: 'reparar_base_de_datos',
      descripcion: 'WordPress no puede conectarse a MySQL. Se intentará reparar las tablas.',
      comandoMitigacion:
        `plesk ext wp-toolkit --wp-cli -instance-id ${instanceId} -- db repair`,
      comandoDiagnosticoPrevio:
        `plesk ext wp-toolkit --wp-cli -instance-id ${instanceId} -- db check`,
      riesgo: 'MEDIO',
      requiereConfirmacion: true,
      notaAdicional: 'Si db repair falla, verificar estado MySQL: systemctl status mariadb',
    }),

    MEMORIA_EXHAUSTA: () => ({
      accionRecomendada: 'ajuste_memoria_php',
      descripcion: `Límite de memoria PHP detectado en el log: ${contexto.limiteActualMB}MB.`,
      comandoMitigacion:
        `plesk bin domain --update ${dominio} -php_settings "memory_limit=${contexto.limiteRecomendadoMB}M"`,
      comandoReloadFPM:
        `plesk bin domain --info ${dominio} | grep php_handler_id | awk '{print $2}' | xargs -I{} systemctl reload {}`,
      riesgo: 'BAJO',
      requiereConfirmacion: false,
      notaAdicional: `${contexto.limiteActualMB}MB → ${contexto.limiteRecomendadoMB}MB`,
    }),

    CORE_CORRUPTO: () => ({
      accionRecomendada: 'reparar_core_wordpress',
      descripcion: `Archivo del core corrupto: "${contexto.archivoAfectado}". wp-content NO se modificará.`,
      comandoMitigacion:
        `plesk ext wp-toolkit --wp-cli -instance-id ${instanceId} -- core download --skip-content --force`,
      comandoVerificacionPrevia:
        `plesk ext wp-toolkit --wp-cli -instance-id ${instanceId} -- core verify-checksums`,
      riesgo: 'MEDIO',
      requiereConfirmacion: true,
      notaAdicional: 'Equivale al "Repair Full" pero SOLO toca el core. wp-content intacto.',
    }),
  };

  const generador = MAPA[tipoError];
  return generador ? generador() : null;
}

module.exports = { construirRecomendacion };
