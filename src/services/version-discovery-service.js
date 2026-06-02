const axios = require('axios');
const sshService = require('./ssh-service').getSshService();
const configManager = require('./config-manager').getConfigManager();

/**
 * Obtiene las últimas 5 versiones de WordPress usando la API oficial.
 * Ordena de mayor a menor y etiqueta la más reciente como "esUltima".
 * @returns {Promise<Array<{version: string, estado: string, esUltima?: boolean}>>}
 */
async function obtenerVersionesWP() {
  try {
    const response = await axios.get('https://api.wordpress.org/core/stable-check/1.0/', {
      timeout: 5000,
    });
    
    const data = response.data;
    if (!data || typeof data !== 'object') {
      return [];
    }

    // Convertir a array de objetos
    const versiones = Object.entries(data).map(([version, estado]) => ({
      version,
      estado: estado === 'stable' ? 'estable' : estado === 'insecure' ? 'insegura' : estado
    }));

    // Función auxiliar para comparar versiones semánticas (ej: 6.5.2 > 6.4.3)
    const compararVersiones = (a, b) => {
      const partsA = a.split('.').map(Number);
      const partsB = b.split('.').map(Number);
      const len = Math.max(partsA.length, partsB.length);
      for (let i = 0; i < len; i++) {
        const numA = partsA[i] || 0;
        const numB = partsB[i] || 0;
        if (numA > numB) return -1;
        if (numA < numB) return 1;
      }
      return 0;
    };

    versiones.sort((a, b) => compararVersiones(a.version, b.version));

    // Tomar solo las top 5
    const top5 = versiones.slice(0, 5);
    if (top5.length > 0) {
      top5[0].esUltima = true;
    }

    return top5;
  } catch (error) {
    console.error('[Discovery] Error obteniendo versiones de WP:', error.message);
    return []; // Retornar array vacío en caso de fallo para no romper la UI
  }
}

/**
 * Helper interno para ejecutar un comando SSH de forma segura con configuración de servidor
 * @param {Object|string} configuracionSSH - Servidor o nombre del mismo
 * @param {string} comando - Comando a ejecutar
 * @returns {Promise<{stdout: string, stderr: string, code: number|null}>}
 */
async function ejecutarComandoSSH(configuracionSSH, comando) {
  let configuracionServidor = configuracionSSH;
  
  if (typeof configuracionSSH === 'string') {
    const config = configManager.getConfig();
    configuracionServidor = config.destinationServers?.find(servidor => servidor.name === configuracionSSH);
  }
  
  if (!configuracionServidor || !configuracionServidor.sshCredentials) {
    throw new Error('Servidor no proporcionado o sin credenciales SSH válidas en la configuración');
  }

  let clienteSSH = null;
  try {
    const identificadorTarea = `php-discovery-${Date.now()}`;
    clienteSSH = await sshService.connect(configuracionServidor.sshCredentials, identificadorTarea);
    
    console.log(`[BACKEND SSH] Intentando comando: ${comando}`);
    let resultado = await sshService.executeCommand(clienteSSH, comando);
    
    // Si el comando falló o retornó un código de error, intentamos con sudo
    if (!resultado || (resultado.code !== 0 && resultado.code !== null)) {
      console.warn(`[BACKEND SSH] El comando falló con código ${resultado?.code}. Intentando con sudo...`);
      const comandoSudo = `sudo ${comando}`;
      const resultadoSudo = await sshService.executeCommand(clienteSSH, comandoSudo);
      
      if (resultadoSudo && (resultadoSudo.code === 0 || resultadoSudo.stdout)) {
        return resultadoSudo;
      }
    }
    
    return resultado;
  } finally {
    if (clienteSSH) {
      clienteSSH.end();
    }
  }
}

/**
 * Obtiene las últimas 5 versiones de PHP disponibles en el servidor Plesk ejecutando comandos por SSH.
 * @param {Object|string} configuracionSSH - Objeto de configuración del servidor o string con el nombre
 * @returns {Promise<{exito: boolean, error: string|null, totalDetectadas: number, versiones: Array<{version: string, idCrudo: string, etiqueta: string, etiquetaCompleta: string, esUltima: boolean}>}>}
 */
async function obtenerVersionesPHP(configuracionSSH) {
  try {
    console.log('[BACKEND SSH] Conectando al servidor para escanear manejadores PHP...');
    
    // Ejecutar comando usando la ruta absoluta de Plesk
    let resultado = await ejecutarComandoSSH(configuracionSSH, '/usr/local/psa/bin/php_handler --list');
    
    if (!resultado || !resultado.stdout) {
      // Fallback a comando plano por si la ruta absoluta varía o no está en esa ubicación estándar
      console.log('[BACKEND SSH] La ruta absoluta falló. Intentando fallback con comando corto plesk bin...');
      resultado = await ejecutarComandoSSH(configuracionSSH, 'plesk bin php_handler --list');
    }

    if (!resultado || !resultado.stdout) {
      throw new Error('El servidor no retornó ninguna respuesta por SSH.');
    }

    // Limpiar secuencias de escape ANSI de la terminal
    const stdoutLimpio = resultado.stdout.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{4,}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
    const lineas = stdoutLimpio.split('\n');
    const manejadoresDetectados = [];

    // Expresión regular robusta recomendada
    const regexManejador = /(plesk-php\d+|custom-php\d+|\w+-php\d+\.?\d*)[^\d]+(\d+\.\d+\.\d+|\d+\.\d+).*enabled/;

    for (const linea of lineas) {
      const coincidencia = linea.match(regexManejador);
      if (coincidencia) {
        const idCrudo = coincidencia[1].trim();
        const versionTexto = coincidencia[2].trim();

        if (!manejadoresDetectados.some(m => m.version === versionTexto)) {
          manejadoresDetectados.push({
            idCrudo: idCrudo,
            version: versionTexto
          });
        }
      }
    }

    if (manejadoresDetectados.length === 0) {
      console.warn('[BACKEND] Salida original del comando para depuración:', resultado.stdout);
      throw new Error('No se pudo parsear ninguna versión de PHP activa. Revisa el formato de la tabla.');
    }

    // Ordenamiento numérico estricto por segmentos (Mayor a Menor)
    manejadoresDetectados.sort((a, b) => {
      const partesA = a.version.split('.').map(Number);
      const partesB = b.version.split('.').map(Number);
      for (let i = 0; i < Math.max(partesA.length, partesB.length); i++) {
        const numA = partesA[i] || 0;
        const numB = partesB[i] || 0;
        if (numB !== numA) return numB - numA;
      }
      return 0;
    });

    // Tomar el top 5 y aplicar las reglas de negocio semánticas
    const top5 = manejadoresDetectados.slice(0, 5).map((manejador, indice) => {
      let etiqueta = '';
      let esUltima = false;
      const versionMayor = parseInt(manejador.version.split('.')[0], 10);
      const versionMenor = parseInt(manejador.version.split('.')[1], 10);

      if (indice === 0) {
        etiqueta = 'Última en servidor · Estable';
        esUltima = true;
      } else if (versionMayor === 8 && versionMenor >= 1) {
        etiqueta = 'Estable';
      } else if (versionMayor === 8 && versionMenor === 0) {
        etiqueta = 'Fin de Vida';
      } else {
        etiqueta = 'Obsoleta / Insegura';
      }

      return {
        idCrudo: manejador.idCrudo,
        version: manejador.version,
        etiquetaCompleta: etiqueta,
        esUltima: esUltima
      };
    });

    console.log('[LIVE PLESK PHP DUMP EXCELENTE]:', top5);
    return { exito: true, error: null, totalDetectadas: top5.length, versiones: top5 };

  } catch (error) {
    console.error('[FALLO CRÍTICO SSH PLESK EN BACKEND]:', error.message);
    return { exito: false, error: error.message, versiones: [] };
  }
}

module.exports = { obtenerVersionesWP, obtenerVersionesPHP };
