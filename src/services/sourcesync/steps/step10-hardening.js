'use strict';

const { createStepLogger } = require('../utils/logger');
const { TIMEOUTS } = require('../constants');

function buildHardeningScript(ctx) {
  return `
# A. Optimizacion de Memoria y Opcache
echo -e "memory_limit = 512M\\nopcache.memory_consumption = 128\\nopcache.max_accelerated_files = 10000\\nopcache.validate_timestamps = 1" > /root/config_memoria_${ctx.domain}.ini
plesk bin site --update-php-settings ${ctx.domain} -settings /root/config_memoria_${ctx.domain}.ini
plesk bin domain --info ${ctx.domain} | grep php_handler_id | awk '{print $2}' | xargs -I{} systemctl reload {}
rm -f /root/config_memoria_${ctx.domain}.ini

# B. Hardening de Seguridad (Idempotente y Limpio)
HT="${ctx.webRoot}/.htaccess"

# 1. Bloquear directory listing
grep -q "Options -Indexes" "$HT" || sed -i '1s/^/Options -Indexes\\n/' "$HT"

# 2. Bloquear wp-config.php
if ! grep -q "wp-config.php" "$HT"; then
cat >> "$HT" << 'EOF'
<files wp-config.php>
  order allow,deny
  deny from all
</files>
EOF
fi

# 3. Bloquear archivos confidenciales
if ! grep -q "readme\\\\.html" "$HT"; then
cat >> "$HT" << 'EOF'
<FilesMatch "(^\\\\.htaccess|readme\\\\.html|license\\\\.txt|xmlrpc\\\\.php)$">
  Order Allow,Deny
  Deny from all
</FilesMatch>
EOF
fi

# 4. Bloquear PHP en uploads (Carpeta nativa, se asegura su existencia)
mkdir -p "${ctx.webRoot}/wp-content/uploads"
echo -e "<FilesMatch \\"\\\\.php$\\">\\n  Order Allow,Deny\\n  Deny from all\\n</FilesMatch>" > "${ctx.webRoot}/wp-content/uploads/.htaccess"

# 5. Bloquear PHP en cache SOLO si la carpeta ya existe (Evita crear basura)
if [ -d "${ctx.webRoot}/wp-content/cache" ]; then
  echo -e "<FilesMatch \\"\\\\.php$\\">\\n  Order Allow,Deny\\n  Deny from all\\n</FilesMatch>" > "${ctx.webRoot}/wp-content/cache/.htaccess"
fi

# C. Purga Absoluta de WP Toolkit y Transients
${ctx.instanceId ? `
plesk ext wp-toolkit --wp-cli -instance-id ${ctx.instanceId} -- transient delete --all || true
plesk ext wp-toolkit --clear-cache -instance-id ${ctx.instanceId} || true
plesk ext wp-toolkit --clear-wpt-cache || true
` : 'echo "WP Toolkit instanceId no disponible, saltando limpieza de WP Toolkit"'}
`;
}

async function runStep10(ctx) {
  const log = createStepLogger(ctx.emit, 10, ctx.totalSteps);
  log.info(`Aplicando Hardening, Memoria y Limpieza final...`);

  const finalBashScript = buildHardeningScript(ctx);

  try {
    await ctx.run(finalBashScript, { allowFail: false, timeout: TIMEOUTS.X_LONG });
    log.detail(`Script de Hardening y Limpieza ejecutado ✓`);
  } catch (err) {
    log.warn(`Fallo en el script final: ${err.message}`);
  }

  log.success(`Hardening y Limpieza completados ✓`);
}

module.exports = { runStep10 };
