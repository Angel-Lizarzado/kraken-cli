const keytar = require('keytar');

const SERVICE_NAME = 'kraken-cli';
const ACCOUNT_NAME = 'contrasena-maestra-correo';

/**
 * Guarda la contraseña maestra de correo de forma segura.
 * @param {string} password - Contraseña a guardar.
 * @returns {Promise<boolean>}
 */
async function guardarContrasena(password) {
  try {
    if (!password || password.length < 8) {
      throw new Error('La contraseña debe tener al menos 8 caracteres.');
    }
    await keytar.setPassword(SERVICE_NAME, ACCOUNT_NAME, password);
    return true;
  } catch (error) {
    console.error('[Keytar Service] Error al guardar la contraseña:', error.message);
    throw error;
  }
}

/**
 * Obtiene la contraseña maestra de correo.
 * @returns {Promise<string|null>} La contraseña o null si no existe.
 */
async function obtenerContrasena() {
  try {
    return await keytar.getPassword(SERVICE_NAME, ACCOUNT_NAME);
  } catch (error) {
    console.error('[Keytar Service] Error al obtener la contraseña:', error.message);
    return null;
  }
}

/**
 * Verifica si la contraseña maestra de correo existe en el sistema.
 * @returns {Promise<boolean>}
 */
async function verificarExiste() {
  try {
    const password = await obtenerContrasena();
    return password !== null;
  } catch (error) {
    return false;
  }
}

/**
 * Elimina la contraseña maestra de correo del sistema.
 * @returns {Promise<boolean>} True si fue eliminada, false si no se encontró.
 */
async function eliminarContrasena() {
  try {
    return await keytar.deletePassword(SERVICE_NAME, ACCOUNT_NAME);
  } catch (error) {
    console.error('[Keytar Service] Error al eliminar la contraseña:', error.message);
    return false;
  }
}

module.exports = {
  guardarContrasena,
  obtenerContrasena,
  verificarExiste,
  eliminarContrasena
};
