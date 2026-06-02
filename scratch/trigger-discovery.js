const { app } = require('electron');
const { getConfigManager } = require('../src/services/config-manager');
const { obtenerVersionesPHP } = require('../src/services/version-discovery-service');

app.whenReady().then(async () => {
  console.log('[DIAGNOSTIC] Inicializando ConfigManager...');
  const cm = getConfigManager();
  await cm.initialize();
  
  console.log('[DIAGNOSTIC] Ejecutando obtenerVersionesPHP para "Plesk Production"...');
  try {
    const res = await obtenerVersionesPHP('Plesk Production');
    console.log('[DIAGNOSTIC] Resultado obtenido con éxito:', res);
  } catch (err) {
    console.error('[DIAGNOSTIC] Catch superior capturó error:', err);
  } finally {
    app.quit();
  }
});
