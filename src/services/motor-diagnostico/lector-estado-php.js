'use strict';

/**
 * Lee el memory_limit actual configurado en Plesk para un dominio específico.
 * Usa la misma función ejecutarSSH que ya tienes en el sistema.
 *
 * Retorna el límite en MB como número entero, o null si no puede leerlo.
 */
async function leerMemoriaActualDominio(ejecutarSSH, dominio) {
  // El comando lee la configuración PHP del dominio directamente desde Plesk
  // La salida incluye líneas como: memory_limit: 128M
  const comando = `plesk bin domain --info ${dominio} | grep memory_limit`;

  try {
    const { stdout } = await ejecutarSSH(comando);

    // Regex: captura el número antes de M o G
    // Ej: "memory_limit: 256M" → captura "256"
    const coincidencia = stdout.match(/memory_limit[:\s]+(\d+)(M|G)/i);

    if (!coincidencia) return null;

    const valor = parseInt(coincidencia[1], 10);
    const unidad = coincidencia[2].toUpperCase();

    // Normalizar todo a MB para comparaciones uniformes
    return unidad === 'G' ? valor * 1024 : valor;

  } catch {
    return null; // Si falla la lectura, la cascada asumirá que memoria es baja
  }
}

module.exports = { leerMemoriaActualDominio };
