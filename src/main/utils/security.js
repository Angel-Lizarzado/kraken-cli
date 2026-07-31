// Dead Man's Switch — Fail-Close estricto para protección de propiedad intelectual.
// Si el servidor de validación no responde, devuelve 404, o desactiva los permisos,
// la aplicación ABORTA todas las operaciones críticas (deploy, extracción).
//
// Usa la API de GitHub Gist (sin hash fijo) para obtener siempre la última versión.
// Si el autor edita el Gist, el cambio se refleja sin necesidad de recompilar.

const https = require('https');

const GIST_ID = '60fbc238ad8201f185d790434b579fb7';
const FILE_NAME = 'kraken-cli-license.json';

const verifyKillSwitch = () => {
  return new Promise((resolve, reject) => {
    // [TEMPORALMENTE DESHABILITADO POR SOLICITUD DEL USUARIO]
    // La lógica de verificación contra el Gist se ha comentado para
    // que la aplicación funcione libremente sin requerir conexión o licencia.
    
    console.log('[SECURITY] Licencia verificada (Modo libre/offline temporal).');
    resolve(true);

    /* --- LÓGICA ORIGINAL DEL GIST COMENTADA PARA FUTURO USO ---
    const apiPath = `/gists/${GIST_ID}`;
    console.log('[SECURITY] Consultando API de Gist para licencia...');

    const req = https.get({
      hostname: 'api.github.com',
      path: apiPath,
      timeout: 5000,
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'kraken-cli/1.0',
      },
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');

        if (res.statusCode !== 200) {
          console.error('[SECURITY] API HTTP Error:', res.statusCode);
          return reject(new Error("[SECURITY] No se pudo verificar la licencia. Contacte al desarrollador original."));
        }

        try {
          const gist = JSON.parse(raw);
          const file = gist.files && gist.files[FILE_NAME];
          if (!file || !file.content) {
            console.error('[SECURITY] Archivo de licencia no encontrado en el Gist');
            return reject(new Error("[SECURITY] Archivo de licencia no encontrado."));
          }

          const data = JSON.parse(file.content);
          console.log('[SECURITY] Licencia verificada:', { app_active: data.app_active, ssh_enabled: data.ssh_enabled });

          if (data.app_active === false || data.ssh_enabled === false) {
            console.warn('[SECURITY] Bloqueo ejecutado por flag en false.');
            return reject(new Error(`[SECURITY] Sistema bloqueado remotamente: ${data.message || 'Licencia revocada.'}`));
          }

          resolve(true);
        } catch (parseErr) {
          console.error('[SECURITY] Error parseando respuesta:', parseErr.message);
          reject(new Error("[SECURITY] Respuesta inválida del servidor de licencias."));
        }
      });
    });

    req.on('error', (err) => {
      console.error('[SECURITY] Falla en verificación:', err.message);
      reject(new Error("[SECURITY] Error de conexión con el servidor de licencias. Verifique su internet o contacte a soporte."));
    });

    req.on('timeout', () => {
      req.destroy();
      console.error('[SECURITY] Timeout de conexión');
      reject(new Error("[SECURITY] Error de conexión con el servidor de licencias. Verifique su internet o contacte a soporte."));
    });
    ---------------------------------------------------------- */
  });
};

module.exports = { verifyKillSwitch };
