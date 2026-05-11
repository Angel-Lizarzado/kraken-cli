// sql-sanitizer.js — Pre-procesamiento de SQL dumps antes de importación en Plesk
// Procesa línea por línea con readline + streams para memoria constante (O(1) RAM).
//
// Elimina / neutraliza:
//   1. DEFINER=`user`@`host` en cualquier contexto (TRIGGER, VIEW, FUNCTION, PROCEDURE, EVENT)
//   2. CREATE DATABASE y DROP DATABASE
//   3. USE `dbname`
//   4. SET @@GLOBAL / SET GLOBAL (requieren SUPER privilege)
//   5. Inline MySQL comments con DEFINER: /*!50013 DEFINER=... */
//
// Garantías:
//   - El archivo de salida es idéntico al de entrada salvo las líneas purgadas/reemplazadas.
//   - Nunca carga el archivo completo en RAM — seguro para dumps de 500 MB+.
//   - Preserva la estructura de CREATE TRIGGER/VIEW/FUNCTION sin el DEFINER.

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

// ── Patrones de líneas a eliminar completamente ──────────────────────────────

/** CREATE DATABASE / DROP DATABASE — redirigen el dump a otra DB */
const RE_CREATE_DATABASE = /^(CREATE|DROP)\s+DATABASE\b/i;

/** USE `dbname` o USE dbname — redirigen la sesión a otra DB */
const RE_USE = /^USE\s+[`"']?\w/i;

/** SET @@GLOBAL o SET GLOBAL — requieren SUPER privilege */
const RE_SET_GLOBAL = /^SET\s+(@@GLOBAL\.|GLOBAL\s)/i;

// ── Patrones de reemplazo (línea conservada, DEFINER eliminado) ───────────────

// DEFINER=`user`@`host` o DEFINER='user'@'host' en cualquier posición.
// Cubre:
//   CREATE DEFINER=`x`@`y` TRIGGER ...
//   /*!50013 DEFINER=`x`@`y` */
//   ALTER DEFINER=`x`@`y` VIEW ...
const RE_DEFINER = /\s*DEFINER\s*=\s*[`'"]?\w+[`'"]?\s*@\s*[`'"]?[\w%]+[`'"]?/gi;

// /*!50013 DEFINER=`user`@`host` */ — comentario inline de mysqldump.
// El objetivo es eliminar el comentario completo, no sólo el DEFINER.
// Ej: "/*!50013 DEFINER=`u123`@`%` */"  →  ""
const RE_DEFINER_COMMENT = /\/\*!5001[023]\s+DEFINER\s*=\s*[`'"]?\w+[`'"]?\s*@\s*[`'"]?[\w%]+[`'"]?\s*\*\//gi;

/**
 * SQL SECURITY DEFINER — las vistas/procedures con esta cláusula heredan
 * permisos del DEFINER (que no existe en Plesk). Reemplazar por SQL SECURITY INVOKER.
 */
const RE_SQL_SECURITY_DEFINER = /SQL\s+SECURITY\s+DEFINER/gi;

// ── Núcleo del sanitizador ────────────────────────────────────────────────────

/**
 * Sanitiza un archivo SQL dump línea por línea usando streams.
 *
 * @param {string} inputPath  - Ruta absoluta al archivo .sql original
 * @param {string} outputPath - Ruta absoluta al archivo .sql sanitizado (puede ser el mismo)
 * @param {object} [options]
 * @param {Function} [options.onProgress] - Callback (linesProcessed, linesRemoved) cada 10.000 líneas
 * @returns {Promise<{linesProcessed: number, linesRemoved: number, linesModified: number}>}
 */
async function sanitizeSqlDump(inputPath, outputPath, options = {}) {
  const { onProgress } = options;

  // Si outputPath === inputPath, escribir a un temp primero y luego renombrar
  const writingToSelf = path.resolve(inputPath) === path.resolve(outputPath);
  const tempPath = writingToSelf ? outputPath + '.sanitizing.tmp' : outputPath;

  const readStream = fs.createReadStream(inputPath, { encoding: 'utf8' });
  const writeStream = fs.createWriteStream(tempPath, { encoding: 'utf8' });

  const rl = readline.createInterface({ input: readStream, crlfDelay: Infinity });

  let linesProcessed = 0;
  let linesRemoved = 0;
  let linesModified = 0;

  const writePromise = new Promise((resolve, reject) => {
    writeStream.on('finish', resolve);
    writeStream.on('error', reject);
  });

  const rlPromise = new Promise((resolve, reject) => {
    rl.on('error', reject);

    rl.on('line', (line) => {
      linesProcessed++;

      // ── Líneas a eliminar completamente ──
      if (
        RE_CREATE_DATABASE.test(line) ||
        RE_USE.test(line) ||
        RE_SET_GLOBAL.test(line)
      ) {
        linesRemoved++;
        // Emitir comentario en el output para trazabilidad forense
        writeStream.write(`-- [SANITIZED] Removed: ${line.trimEnd()}\n`);
        return;
      }

      // ── Líneas a modificar (conservar, limpiar DEFINER) ──
      let modified = line;

      // 1. Eliminar comentario /*!50013 DEFINER=... */ completo
      if (RE_DEFINER_COMMENT.test(modified)) {
        modified = modified.replace(RE_DEFINER_COMMENT, '').trim();
        RE_DEFINER_COMMENT.lastIndex = 0; // reset regex state
      }

      // 2. Eliminar DEFINER=`user`@`host` en cualquier contexto restante
      if (RE_DEFINER.test(modified)) {
        modified = modified.replace(RE_DEFINER, '');
        RE_DEFINER.lastIndex = 0;
      }

      // 3. Reemplazar SQL SECURITY DEFINER → SQL SECURITY INVOKER
      if (RE_SQL_SECURITY_DEFINER.test(modified)) {
        modified = modified.replace(RE_SQL_SECURITY_DEFINER, 'SQL SECURITY INVOKER');
        RE_SQL_SECURITY_DEFINER.lastIndex = 0;
      }

      if (modified !== line) {
        linesModified++;
      }

      writeStream.write(modified + '\n');

      // Progreso cada 10.000 líneas
      if (onProgress && linesProcessed % 10000 === 0) {
        onProgress(linesProcessed, linesRemoved, linesModified);
      }
    });

    rl.on('close', () => {
      writeStream.end();
      resolve();
    });
  });

  await rlPromise;
  await writePromise;

  // Si escribimos a un temp, reemplazar el original atómicamente
  if (writingToSelf) {
    await fs.promises.rename(tempPath, outputPath);
  }

  return { linesProcessed, linesRemoved, linesModified };
}

/**
 * Sanitiza in-place: sobreescribe el archivo original con la versión limpia.
 * Alias más cómodo para el flujo de deployment.
 *
 * @param {string} sqlPath - Ruta absoluta al .sql a sanitizar
 * @param {Function} [onProgress] - Callback de progreso
 * @returns {Promise<{linesProcessed: number, linesRemoved: number, linesModified: number}>}
 */
async function sanitizeSqlInPlace(sqlPath, onProgress) {
  return sanitizeSqlDump(sqlPath, sqlPath, { onProgress });
}

module.exports = { sanitizeSqlDump, sanitizeSqlInPlace };
