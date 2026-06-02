const { obtenerContrasena } = require('./keytar-service');
const logger = require('./log-buffer-service').getLogBufferService();

/**
 * Asegura la creación o actualización de la cuenta info@dominio.com en Plesk.
 * @param {string} dominio - Dominio objetivo (ej. 'ejemplo.com').
 * @param {Function} executeCommandFn - Función asíncrona que ejecuta un comando SSH y retorna { stdout, stderr }.
 * @returns {Promise<{exito: boolean, accion: string, mensaje: string}>}
 */
async function asegurarBuzonInfo(dominio, executeCommandFn) {
  try {
    const password = await obtenerContrasena();
    if (!password) {
      return { exito: false, accion: 'omitido', mensaje: 'No hay contraseña maestra configurada.' };
    }

    const emailTarget = `info@${dominio}`;

    // Paso 1: Verificar si el correo ya existe
    const cmdCheck = `plesk bin mail --info ${emailTarget}`;
    let checkResult;
    try {
      checkResult = await executeCommandFn(cmdCheck);
    } catch (e) {
      // Si el comando falla, asumiremos que no existe
      checkResult = { stdout: '', stderr: e.message || '' };
    }

    const stderrLower = (checkResult.stderr || '').toLowerCase();
    const stdoutLower = (checkResult.stdout || '').toLowerCase();
    const existe = !stderrLower.includes('does not exist') && stdoutLower.includes('mailbox');

    let commandToRun;
    let accionRes;

    if (existe) {
      commandToRun = `plesk bin mail --update ${emailTarget} -passwd '${password}' -enabled true`;
      accionRes = 'actualizado';
    } else {
      commandToRun = `plesk bin mail --create ${emailTarget} -passwd '${password}' -mailbox true -enabled true`;
      accionRes = 'creado';
    }

    // Paso 2: Ejecutar el comando para crear o actualizar
    const actionResult = await executeCommandFn(commandToRun);
    
    // plesk bin mail envía warnings por stderr a veces, pero consideramos fallo si hay "exit code" o error grave.
    // Confiaremos en que el executeCommandFn lance excepción si es un error fatal, o revisaremos stderr.
    if (actionResult.stderr && actionResult.stderr.trim().length > 0 && actionResult.stderr.toLowerCase().includes('error')) {
      throw new Error(`Error de Plesk: ${actionResult.stderr.trim()}`);
    }

    return { 
      exito: true, 
      accion: accionRes, 
      mensaje: `Buzón ${emailTarget} ${accionRes} correctamente.` 
    };

  } catch (error) {
    const errorMsg = error.message || String(error);
    return { 
      exito: false, 
      accion: 'error', 
      mensaje: `Error al configurar buzón para ${dominio}: ${errorMsg}` 
    };
  }
}

module.exports = { asegurarBuzonInfo };
