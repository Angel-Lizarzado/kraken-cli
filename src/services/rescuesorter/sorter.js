const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const zlib = require('zlib');
const tar = require('tar');
const readline = require('readline');
const { pipeline } = require('stream/promises');
const { spawn, execSync } = require('child_process');

async function forceDeleteFile(domainPath, fileName, onLog) {
  const filePath = path.join(domainPath, fileName);
  try {
    // 1. Verificamos si realmente existe leyendo la carpeta (ignora problemas de permisos de stat)
    let filesInDir = await fsPromises.readdir(domainPath).catch(() => []);
    if (!filesInDir.includes(fileName)) {
      return; // No existe, así que no logueamos nada
    }

    try {
      await fsPromises.chmod(filePath, 0o666).catch(() => {});
      await fsPromises.rm(filePath, { force: true, recursive: true });
    } catch (err) {
      try {
        execSync(`del /F /A /Q "${filePath}"`, { stdio: 'ignore' });
      } catch (cmdErr) {
        throw new Error(`Node: ${err.message} | CMD: ${cmdErr.message}`);
      }
    }

    // 2. Volvemos a leer la carpeta para confirmar que se fue
    filesInDir = await fsPromises.readdir(domainPath).catch(() => []);
    if (!filesInDir.includes(fileName)) {
      if (onLog) onLog(`  → Eliminado archivo suelto: ${fileName}`, 'info');
    } else {
      if (onLog) onLog(`  → Falló al eliminar ${fileName}: Sigue existiendo en el directorio`, 'warning');
    }
  } catch (error) {
    if (onLog) onLog(`  → Falló al eliminar ${fileName} (Error: ${error.message})`, 'warning');
  }
}

// ================================================================
// HELPERS: Extracción Nativa y Parseo SQL
// ================================================================

/**
 * Usa tar nativo (Windows) para listar y extraer directorios específicos (uploads/plugins).
 * Evita bloqueos de memoria (OOM) en Node con archivos de 60GB+.
 */
async function extractNative(tarPath, destDir, onLog) {
  return new Promise((resolve, reject) => {
    onLog(`  [NATIVO] Inspeccionando ${path.basename(tarPath)}...`, 'info');
    
    const listProc = spawn('tar', ['-tf', tarPath]);
    let uploadsPath = null;
    let pluginsPath = null;
    let hasConfig = false;
    let hasWpAdmin = false;

    const rl = readline.createInterface({
      input: listProc.stdout,
      crlfDelay: Infinity
    });

    rl.on('line', (line) => {
      if (!uploadsPath && line.includes('wp-content/uploads/')) {
        uploadsPath = line.substring(0, line.indexOf('wp-content/uploads/') + 19);
      }
      if (!pluginsPath && line.includes('wp-content/plugins/')) {
        pluginsPath = line.substring(0, line.indexOf('wp-content/plugins/') + 19);
      }
      if (!hasConfig && (line === 'config.json' || line.endsWith('/config.json'))) {
        hasConfig = true;
      }
      if (!hasWpAdmin && line.includes('wp-admin/')) {
        hasWpAdmin = true;
      }

      if (uploadsPath && pluginsPath && hasConfig && hasWpAdmin) {
        try { listProc.kill('SIGKILL'); } catch {}
      }
    });

    listProc.on('close', () => {
      if (hasConfig && !hasWpAdmin) {
        onLog(`  [SKIP] El archivo ya es Ultra-Lite.`, 'info');
        return resolve({ isUltraLite: true });
      }

      const pathsToExtract = [];
      if (uploadsPath) pathsToExtract.push(uploadsPath);
      if (pluginsPath) pathsToExtract.push(pluginsPath);

      if (pathsToExtract.length === 0) {
        onLog(`  [WARN] No se encontraron uploads ni plugins en el tar.`, 'warning');
        return resolve({ isUltraLite: false, success: false });
      }

      onLog(`  [NATIVO] Extrayendo directorios encontrados...`, 'info');
      fs.mkdirSync(destDir, { recursive: true });
      const extProc = spawn('tar', ['-xzf', tarPath, '-C', destDir, ...pathsToExtract]);
      
      extProc.on('close', (code) => {
        if (code === 0) {
          resolve({ isUltraLite: false, success: true });
        } else {
          onLog(`  [ERROR] tar nativo falló con código ${code}.`, 'error');
          resolve({ isUltraLite: false, success: false });
        }
      });
      extProc.on('error', (err) => {
        onLog(`  [ERROR] tar nativo extrayendo: ${err.message}`, 'error');
        resolve({ isUltraLite: false, success: false });
      });
    });

    listProc.on('error', (err) => {
      onLog(`  [ERROR] tar nativo listando: ${err.message}`, 'error');
      resolve({ isUltraLite: false, success: false });
    });
  });
}

/**
 * Global cancellation flag para extracción masiva
 */
let isMassiveExtractionCancelled = false;

function cancelMassiveExtraction() {
  isMassiveExtractionCancelled = true;
}

/**
 * Extrae dominios masivos desde un tar de 60GB+ directamente sin crear carpetas temporales.
 */
async function extractMassiveNative(tarPath, destDir, onLog) {
  isMassiveExtractionCancelled = false;
  return new Promise((resolve, reject) => {
    onLog(`[NATIVO] Iniciando extracción masiva directa: ${path.basename(tarPath)}`, 'info');
    fs.mkdirSync(destDir, { recursive: true });

    // tar -xkvf archivo.tar.gz -C destino --strip-components=1 domains
    // -x: extraer
    // -k: keep old files (no sobreescribir)
    // -v: verbose para ver progreso
    // -f: archivo
    // --strip-components=1: elimina la carpeta "domains" de la ruta extraída
    const extProc = spawn('tar', [
      '-xkvf', tarPath, 
      '-C', destDir, 
      '--strip-components=1', 
      'domains'
    ]);

    // Para evitar saturar el canal de logs, usamos un throttle simple o mostramos dominios
    let currentDomain = '';

    const rlStdout = readline.createInterface({ input: extProc.stdout, crlfDelay: Infinity });
    const rlStderr = readline.createInterface({ input: extProc.stderr, crlfDelay: Infinity });

    rlStdout.on('line', (line) => {
      // El output de bsdtar suele ser "x ruta/del/archivo"
      // Si procesa "x domains/dominio.com/wp-content/...", podemos extraer el dominio
      const match = line.match(/^x\s+domains\/([^\/]+)\//);
      if (match) {
        const domain = match[1];
        if (domain !== currentDomain) {
          currentDomain = domain;
          onLog(`[PROGRESO] Extrayendo dominio: ${domain}`, 'info');
        }
      }

      // Check cancellation
      if (isMassiveExtractionCancelled) {
        try { extProc.kill('SIGKILL'); } catch {}
      }
    });

    rlStderr.on('line', (line) => {
      // Ignoramos warnings de "already exists" porque usamos -k
      if (!line.includes('already exists') && !line.includes('Can\'t replace existing')) {
        // onLog(`[TAR-MSG] ${line}`, 'warning');
      }
    });

    extProc.on('close', (code) => {
      if (isMassiveExtractionCancelled) {
        onLog(`[CANCELADO] La extracción masiva fue cancelada por el usuario.`, 'warning');
        return resolve({ success: false, cancelled: true });
      }

      if (code === 0) {
        onLog(`[NATIVO] Extracción masiva completada con éxito.`, 'success');
        resolve({ success: true, cancelled: false });
      } else {
        onLog(`[ERROR] La extracción finalizó con código de advertencia/error: ${code}. (Revisa si faltó espacio)`, 'warning');
        resolve({ success: false, cancelled: false });
      }
    });

    extProc.on('error', (err) => {
      onLog(`[ERROR] Error crítico al ejecutar tar: ${err.message}`, 'error');
      reject(err);
    });
  });
}

/**
 * Lee un .sql línea por línea para extraer table_prefix y tema activo
 * sin cargar el archivo completo en RAM.
 * @param {string} sqlPath - Ruta al archivo .sql
 * @returns {Promise<{ prefix: string, theme: string }>}
 */
async function parseSqlForMeta(sqlPath) {
  return new Promise((resolve) => {
    let prefix = 'wp_';
    let theme = null;
    let found = 0;

    const readStream = fs.createReadStream(sqlPath, { encoding: 'utf8' });
    const rl = readline.createInterface({
      input: readStream,
      crlfDelay: Infinity,
    });

    rl.on('line', (line) => {
      // Detectar prefix desde nombre de tabla: CREATE TABLE `wp_options`
      if (!prefix || prefix === 'wp_') {
        const prefixMatch = line.match(/CREATE TABLE `([a-zA-Z0-9_]+?)options`/i);
        if (prefixMatch) {
          prefix = prefixMatch[1];
          found++;
        }
      }

      // Detectar tema activo desde INSERT en wp_options
      if (!theme) {
        // Formato típico: ('template','hello-elementor',...)
        const themeMatch = line.match(/'template',\s*'([^']+)'/);
        if (themeMatch) {
          theme = themeMatch[1].trim();
          found++;
        }
      }

      // Si encontramos ambos, cerramos el stream para ahorrar tiempo
      if (found >= 2) {
        rl.close();
        readStream.destroy();
        rl.removeAllListeners();
      }
    });

    rl.on('close', () => {
      readStream.destroy();
      resolve({ prefix, theme: theme || 'hello-elementor' });
    });
    rl.on('error', () => {
      readStream.destroy();
      resolve({ prefix, theme: 'hello-elementor' });
    });
  });
}

/**
 * Lee un archivo .sql y elimina líneas de DEFINER y CREATE TRIGGER
 * que bloquean la importación en Plesk/MySQL restringido.
 * Guarda el original como {dominio}-hostinger.sql y escribe el limpio como {dominio}.sql
 * @param {string} rawSqlPath - Ruta al SQL crudo
 * @param {string} cleanSqlPath - Ruta de destino del SQL saneado
 */
async function sanitizeSql(rawSqlPath, cleanSqlPath) {
  const TRIGGER_PATTERNS = [
    /^\/\*!50003 CREATE\*\//,
    /^\/\*!50017 DEFINER/,
    /DEFINER\s*=\s*`[^`]*`@`[^`]*`/,
    /^\/\*!50013 DEFINER/,
    /^SET @OLD_/,
    /^\/\*\s*!50003 TRIGGER/,
  ];

  return new Promise((resolve, reject) => {
    const writeStream = fs.createWriteStream(cleanSqlPath, { encoding: 'utf8' });
    writeStream.write('SET FOREIGN_KEY_CHECKS=0;\n');

    const readStream = fs.createReadStream(rawSqlPath, { encoding: 'utf8' });
    const rl = readline.createInterface({
      input: readStream,
      crlfDelay: Infinity,
    });

    rl.on('line', (line) => {
      const shouldSkip = TRIGGER_PATTERNS.some(pattern => pattern.test(line));
      if (!shouldSkip) {
        writeStream.write(line + '\n');
      }
    });

    rl.on('close', () => {
      readStream.destroy();
      writeStream.write('SET FOREIGN_KEY_CHECKS=1;\n');
      writeStream.end();
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });

    rl.on('error', (err) => {
      readStream.destroy();
      reject(err);
    });
  });
}

/**
 * Escanea la carpeta de plugins de WordPress y retorna un array de nombres.
 * @param {string} pluginsPath - Ruta a wp-content/plugins/
 * @returns {Promise<string[]>}
 */
async function scanPlugins(pluginsPath) {
  try {
    const entries = await fsPromises.readdir(pluginsPath, { withFileTypes: true });
    return entries
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .filter(name => name !== '.' && name !== '..');
  } catch {
    return [];
  }
}

// ================================================================
// ESCENARIO A: Backup Legacy (ya empaquetado como dominio.tar.gz + dominio.sql)
// ================================================================

/**
 * Procesa un dominio con formato legacy (tar.gz + sql ya presentes en la carpeta del dominio).
 * No toca la lógica de extracción actual — solo aplica la "dieta" al .tar.gz existente.
 */
async function processDietLegacy(domainSourcePath, domainDestPath, dominio, onLog) {
  const tempDir = path.join(domainSourcePath, `_krk_diet_${Date.now()}`);

  try {
    const tarPath = path.join(domainSourcePath, `${dominio}.tar.gz`);
    const tarAltPath = path.join(domainSourcePath, `${dominio}.tar`);
    const sqlPath = path.join(domainSourcePath, `${dominio}.sql`);

    // ── Skip si ya es Ultra-Lite Y extracción optimizada ──
    const actualTar = fs.existsSync(tarPath) ? tarPath : tarAltPath;
    if (fs.existsSync(actualTar)) {
      const nativeResult = await extractNative(actualTar, tempDir, onLog);
      
      if (nativeResult.isUltraLite) {
        onLog(`  [SKIP] ${dominio} ya está en formato Ultra-Lite. Limpiando sobrantes...`, 'info');
        const filesToClean = [`${dominio}.sql`, `${dominio}-hostinger.sql`, 'wp-config.php', dominio];
        if (fs.existsSync(path.join(domainSourcePath, `${dominio}.tar.gz`))) {
          filesToClean.push(`${dominio}.tar`);
        }
        for (const file of filesToClean) {
          await forceDeleteFile(domainSourcePath, file, onLog);
        }
        
        // Mover el archivo si el destino es distinto
        if (domainSourcePath !== domainDestPath) {
          await fsPromises.mkdir(domainDestPath, { recursive: true });
          const srcTar = path.join(domainSourcePath, `${dominio}.tar.gz`);
          const dstTar = path.join(domainDestPath, `${dominio}.tar.gz`);
          if (fs.existsSync(srcTar)) {
            await fsPromises.rename(srcTar, dstTar);
            await fsPromises.rm(domainSourcePath, { recursive: true, force: true });
          }
        }

        return false;
      }
      if (!nativeResult.success) {
        onLog(`  [ERROR] No se pudieron extraer los directorios críticos de ${actualTar}`, 'error');
        // Si no pudo extraer nativamente, cancelamos para no colapsar la app con node-tar
        return false;
      }
    } else {
      onLog(`  [SKIP] No se encontró ${dominio}.tar.gz o ${dominio}.tar. Omitiendo.`, 'warning');
      return false;
    }

    const hasSql = fs.existsSync(sqlPath);
    if (!hasSql) {
      onLog(`  [SKIP] No se encontró ${dominio}.sql. Omitiendo.`, 'warning');
      return false;
    }

    // Buscar carpeta wp-content dentro del extraído
    let wpContentPath = path.join(tempDir, 'wp-content');
    if (!fs.existsSync(wpContentPath)) {
      const altWpContent = path.join(tempDir, 'public_html', 'wp-content');
      if (fs.existsSync(altWpContent)) {
        wpContentPath = altWpContent;
        onLog(`  → wp-content detectado dentro de public_html/`, 'info');
      } else {
        onLog(`  [WARN] No se encontró carpeta wp-content en el backup.`, 'warning');
      }
    }
    const pluginsPath = path.join(wpContentPath, 'plugins');

    // Parsear meta del SQL original
    onLog(`  Extrayendo prefix y tema desde SQL...`, 'info');
    const { prefix, theme } = await parseSqlForMeta(sqlPath);
    onLog(`  → Prefix: ${prefix} | Tema: ${theme}`, 'info');

    // Escanear plugins
    const plugins = await scanPlugins(pluginsPath);
    onLog(`  → Plugins encontrados: ${plugins.length}`, 'info');

    // Generar config.json
    const configJson = { db_prefix: prefix, theme, plugins };
    await fsPromises.writeFile(
      path.join(domainSourcePath, 'config.json'),
      JSON.stringify(configJson, null, 2),
      'utf8'
    );

    // SQL: se queda como {dominio}.sql (crudo, sin sanitizar aquí)
    // Limpiar cualquier -hostinger.sql residual que pudiera existir.
    const residualHostinger = path.join(domainSourcePath, `${dominio}-hostinger.sql`);
    if (fs.existsSync(residualHostinger)) {
      await fsPromises.unlink(residualHostinger).catch(() => {});
      onLog(`  → Eliminado residual: ${dominio}-hostinger.sql`, 'info');
    }

    // Re-empaquetar: uploads/ + config.json + {dominio}.sql (sin wp-config.php)
    onLog(`  Reempaquetando como Ultra-Lite (uploads + config + sql)...`, 'info');
    const uploadsInTemp = path.join(wpContentPath, 'uploads');

    const filesToPack = ['config.json', `${dominio}.sql`];

    // Copiar uploads a nivel del domainSourcePath para incluir en el tar
    const uploadsDestPath = path.join(domainSourcePath, 'uploads');
    if (fs.existsSync(uploadsInTemp)) {
      await fsPromises.cp(uploadsInTemp, uploadsDestPath, { recursive: true });
      filesToPack.push('uploads');
    }

    const finalTarPath = path.join(domainSourcePath, `${dominio}.tar.gz.new`);
    await tar.c({ gzip: true, file: finalTarPath, cwd: domainSourcePath, strict: false }, filesToPack);

    // Limpiar uploads temporales de domainSourcePath
    if (fs.existsSync(uploadsDestPath)) {
      await fsPromises.rm(uploadsDestPath, { recursive: true, force: true });
    }

    // Reemplazar el tar original con el nuevo
    await fsPromises.unlink(actualTar);
    
    const finalDestination = path.join(domainDestPath, `${dominio}.tar.gz`);
    
    // Mover si el destino es distinto o solo renombrar si es el mismo
    if (domainSourcePath !== domainDestPath) {
      await fsPromises.mkdir(domainDestPath, { recursive: true });
      await fsPromises.rename(finalTarPath, finalDestination);
      await fsPromises.rm(domainSourcePath, { recursive: true, force: true });
    } else {
      await fsPromises.rename(finalTarPath, finalDestination);
    }

    // Cleanup de archivos que ya están dentro del tar (solo si no borramos ya el sourcePath completo)
    if (domainSourcePath === domainDestPath) {
      const wpConfigLoose = path.join(domainSourcePath, 'wp-config.php');
      if (fs.existsSync(wpConfigLoose)) {
        await fsPromises.unlink(wpConfigLoose).catch(() => {});
        onLog(`  → wp-config.php eliminado (prefix ya en config.json).`, 'info');
      }

      await fsPromises.unlink(path.join(domainSourcePath, 'config.json')).catch(() => {});
      await fsPromises.unlink(path.join(domainSourcePath, `${dominio}.sql`)).catch(() => {});
    }

    onLog(`  ✓ Legacy diet completado para ${dominio}`, 'success');
    return true;

  } finally {
    if (fs.existsSync(tempDir)) {
      await fsPromises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

// ================================================================
// ESCENARIO B: Backup Raw (public_html descomprimido + db/ con .sql.gz)
// ================================================================

/**
 * Procesa un dominio con formato Raw de Hostinger:
 * cloud/{dominio}/public_html/ y cloud/db/*.sql.gz
 */
async function processDietRaw(domainSourcePath, domainDestPath, dominio, dbSourcePath, dbFiles, onLog) {
  let wpConfigPath = path.join(domainSourcePath, 'public_html', 'wp-config.php');
  let isRootExtraction = false;

  // ── Skip si ya es Ultra-Lite (tiene config.json Y NO tiene wp-admin) ──
  const existingTar = path.join(domainSourcePath, `${dominio}.tar.gz`);
  if (fs.existsSync(existingTar)) {
    try {
      let hasConfig = false;
      let hasWpAdmin = false;
      await tar.t({ file: existingTar, onentry: (entry) => {
        if (entry.path === 'config.json' || entry.path.endsWith('/config.json')) hasConfig = true;
        if (entry.path.includes('wp-admin/')) hasWpAdmin = true;
      }});
      if (hasConfig && !hasWpAdmin) {
        onLog(`  [SKIP] ${dominio} ya está en formato Ultra-Lite. Limpiando sobrantes...`, 'info');
        const filesToClean = [`${dominio}.sql`, `${dominio}-hostinger.sql`, 'wp-config.php', dominio, 'public_html'];
        if (fs.existsSync(path.join(domainSourcePath, `${dominio}.tar.gz`))) {
          filesToClean.push(`${dominio}.tar`);
        }
        for (const file of filesToClean) {
          await forceDeleteFile(domainSourcePath, file, onLog);
        }
        
        // Mover el archivo si el destPath es distinto
        if (domainSourcePath !== domainDestPath) {
          await fsPromises.mkdir(domainDestPath, { recursive: true });
          const srcTar = path.join(domainSourcePath, `${dominio}.tar.gz`);
          const dstTar = path.join(domainDestPath, `${dominio}.tar.gz`);
          if (fs.existsSync(srcTar)) {
            await fsPromises.rename(srcTar, dstTar);
            await fsPromises.rm(domainSourcePath, { recursive: true, force: true });
          }
        }
        return false;
      }
    } catch { /* continuar */ }
  }

  if (!fs.existsSync(wpConfigPath)) {
    wpConfigPath = path.join(domainSourcePath, 'wp-config.php');
    if (fs.existsSync(wpConfigPath)) {
      isRootExtraction = true;
    } else {
      onLog(`  [SKIP] No se encontró wp-config.php para ${dominio}.`, 'warning');
      return false;
    }
  }

  // 1. Extraer DB_NAME y table_prefix del wp-config.php
  const wpConfigContent = await fsPromises.readFile(wpConfigPath, 'utf8');
  const dbMatch = wpConfigContent.match(/define\(\s*['"]DB_NAME['"]\s*,\s*['"]([^'"]+)['"]\s*\)/i);
  const prefixMatch = wpConfigContent.match(/\$table_prefix\s*=\s*['"]([^'"]+)['"]/i);

  if (!dbMatch) {
    onLog(`  [SKIP] No se pudo leer DB_NAME del wp-config.php de ${dominio}.`, 'warning');
    return false;
  }

  const dbName = dbMatch[1];
  const prefix = prefixMatch ? prefixMatch[1] : 'wp_';
  onLog(`  → DB_NAME: ${dbName} | Prefix: ${prefix} | RootExt: ${isRootExtraction}`, 'info');

  // 2. Buscar el archivo SQL correspondiente en db/
  const matchedDbFile = dbFiles.find(f => f.includes(dbName));
  if (!matchedDbFile) {
    onLog(`  [ERROR] No se encontró archivo SQL para DB: ${dbName}`, 'error');
    return false;
  }

  onLog(`  → Match SQL: ${matchedDbFile}`, 'info');

  // 3. Descomprimir el SQL crudo → {dominio}.sql directamente
  const rawSqlPath = path.join(domainSourcePath, `${dominio}.sql`);
  const dbFilePath = path.join(dbSourcePath, matchedDbFile);

  if (matchedDbFile.endsWith('.gz')) {
    await pipeline(
      fs.createReadStream(dbFilePath),
      zlib.createGunzip(),
      fs.createWriteStream(rawSqlPath)
    );
  } else {
    await fsPromises.copyFile(dbFilePath, rawSqlPath);
  }

  // Limpiar cualquier -hostinger.sql residual
  const residualHostinger = path.join(domainSourcePath, `${dominio}-hostinger.sql`);
  if (fs.existsSync(residualHostinger)) {
    await fsPromises.unlink(residualHostinger).catch(() => {});
  }

  // 4. Parsear meta del SQL (prefix via CREATE TABLE, tema via INSERT wp_options)
  onLog(`  Extrayendo tema activo desde SQL...`, 'info');
  const { theme } = await parseSqlForMeta(rawSqlPath);
  onLog(`  → Tema: ${theme}`, 'info');

  // 5. Escanear plugins y construir config.json
  const wpContentPath = isRootExtraction
    ? path.join(domainSourcePath, 'wp-content')
    : path.join(domainSourcePath, 'public_html', 'wp-content');
    
  const pluginsPath = path.join(wpContentPath, 'plugins');
  const plugins = await scanPlugins(pluginsPath);
  onLog(`  → Plugins: ${plugins.length} encontrados`, 'info');

  const configJson = { db_prefix: prefix, theme, plugins };
  await fsPromises.writeFile(
    path.join(domainSourcePath, 'config.json'),
    JSON.stringify(configJson, null, 2),
    'utf8'
  );

  // 6. Empaquetar: uploads/ + config.json + {dominio}.sql (sin wp-config.php)
  onLog(`  Comprimiendo uploads + config + sql en Ultra-Lite tar.gz...`, 'info');
  const uploadsSourcePath = path.join(wpContentPath, 'uploads');

  const filesToPack = ['config.json', `${dominio}.sql`];

  const uploadsDestPath = path.join(domainSourcePath, 'uploads');
  if (fs.existsSync(uploadsSourcePath)) {
    await fsPromises.cp(uploadsSourcePath, uploadsDestPath, { recursive: true });
    filesToPack.push('uploads');
  }

  const finalTarPath = path.join(domainSourcePath, `${dominio}.tar.gz`);
  await tar.c({ gzip: true, file: finalTarPath, cwd: domainSourcePath, strict: false }, filesToPack);

  // 7. Cleanup
  if (fs.existsSync(uploadsDestPath)) {
    await fsPromises.rm(uploadsDestPath, { recursive: true, force: true });
  }

  if (isRootExtraction) {
    // Eliminar todo el contenido suelto de la raíz excepto tar
    const items = await fsPromises.readdir(domainSourcePath);
    for (const item of items) {
      if (item !== `${dominio}.tar.gz`) {
        await forceDeleteFile(domainSourcePath, item, null);
      }
    }
  } else {
    await forceDeleteFile(domainSourcePath, 'public_html', null);
    await forceDeleteFile(domainSourcePath, 'DO_NOT_UPLOAD_HERE', null);
    await forceDeleteFile(domainSourcePath, 'wp-config.php', null);
    await forceDeleteFile(domainSourcePath, 'config.json', null);
    // Nota: el sql original suelto ya fue empaquetado, si lo queremos mantener suelto NO lo borramos.
    // En diet, actualmente se borra el sql suelto porque va dentro del tar:
    await forceDeleteFile(domainSourcePath, `${dominio}.sql`, null);
  }

  // Mover el archivo final si el destino es diferente
  if (domainSourcePath !== domainDestPath) {
    await fsPromises.mkdir(domainDestPath, { recursive: true });
    const srcTar = path.join(domainSourcePath, `${dominio}.tar.gz`);
    const dstTar = path.join(domainDestPath, `${dominio}.tar.gz`);
    if (fs.existsSync(srcTar)) {
      await fsPromises.rename(srcTar, dstTar);
      await fsPromises.rm(domainSourcePath, { recursive: true, force: true });
    }
  }

  // El sql.gz de la carpeta db se elimina SOLO si todo salió bien
  await fsPromises.unlink(dbFilePath).catch(() => {});

  onLog(`  ✓ Raw diet completado para ${dominio}`, 'success');
  return true;
}

/**
 * Organiza un dominio crudo, manteniendo el WordPress COMPLETO.
 * Crea el {dominio}.tar.gz con todo adentro, extrae el SQL, y borra los sueltos.
 */
async function processOrganizarRaw(domainSourcePath, domainDestPath, dominio, dbSourcePath, dbFiles, onLog) {
  let wpConfigPath = path.join(domainSourcePath, 'public_html', 'wp-config.php');
  let isRootExtraction = false;

  if (!fs.existsSync(wpConfigPath)) {
    wpConfigPath = path.join(domainSourcePath, 'wp-config.php');
    if (fs.existsSync(wpConfigPath)) {
      isRootExtraction = true;
    } else {
      onLog(`  [SKIP] No se encontró wp-config.php para ${dominio}.`, 'warning');
      return false;
    }
  }

  // 1. Extraer DB_NAME del wp-config.php
  const wpConfigContent = await fsPromises.readFile(wpConfigPath, 'utf8');
  const dbMatch = wpConfigContent.match(/define\(\s*['"]DB_NAME['"]\s*,\s*['"]([^'"]+)['"]\s*\)/i);

  if (!dbMatch) {
    onLog(`  [SKIP] No se pudo leer DB_NAME del wp-config.php de ${dominio}.`, 'warning');
    return false;
  }
  const dbName = dbMatch[1];
  onLog(`  → DB_NAME: ${dbName} | RootExt: ${isRootExtraction}`, 'info');

  // 2. Buscar el archivo SQL
  const matchedDbFile = dbFiles.find(f => f.includes(dbName));
  if (!matchedDbFile) {
    onLog(`  [ERROR] No se encontró archivo SQL para DB: ${dbName}`, 'error');
    return false;
  }
  onLog(`  → Match SQL: ${matchedDbFile}`, 'info');

  // 3. Descomprimir el SQL crudo
  const rawSqlPath = path.join(domainSourcePath, `${dominio}.sql`);
  const dbFilePath = path.join(dbSourcePath, matchedDbFile);

  if (matchedDbFile.endsWith('.gz')) {
    await pipeline(
      fs.createReadStream(dbFilePath),
      zlib.createGunzip(),
      fs.createWriteStream(rawSqlPath)
    );
  } else {
    await fsPromises.copyFile(dbFilePath, rawSqlPath);
  }

  // Limpiar -hostinger
  const residualHostinger = path.join(domainSourcePath, `${dominio}-hostinger.sql`);
  if (fs.existsSync(residualHostinger)) {
    await fsPromises.unlink(residualHostinger).catch(() => {});
  }

  // 4. Empaquetar TODO el directorio en {dominio}.tar.gz
  onLog(`  Comprimiendo WordPress COMPLETO en tar.gz... esto tomará tiempo.`, 'info');
  
  // Reunimos todos los archivos/carpetas a empaquetar
  const itemsToPack = await fsPromises.readdir(domainSourcePath);
  const filesToPack = itemsToPack.filter(item => item !== `${dominio}.tar.gz`);

  const finalTarPath = path.join(domainSourcePath, `${dominio}.tar.gz`);
  await tar.c({ gzip: true, file: finalTarPath, cwd: domainSourcePath, strict: false }, filesToPack);

  // 5. Cleanup: Borramos todos los archivos sueltos excepto el tar.gz
  onLog(`  Limpiando archivos sueltos...`, 'info');
  for (const item of itemsToPack) {
    if (item !== `${dominio}.tar.gz`) {
      await forceDeleteFile(domainSourcePath, item, null);
    }
  }

  // Mover el archivo final si el destino es diferente
  if (domainSourcePath !== domainDestPath) {
    await fsPromises.mkdir(domainDestPath, { recursive: true });
    const srcTar = path.join(domainSourcePath, `${dominio}.tar.gz`);
    const dstTar = path.join(domainDestPath, `${dominio}.tar.gz`);
    if (fs.existsSync(srcTar)) {
      await fsPromises.rename(srcTar, dstTar);
      await fsPromises.rm(domainSourcePath, { recursive: true, force: true });
    }
  }

  // El sql.gz original se elimina si todo salió bien
  await fsPromises.unlink(dbFilePath).catch(() => {});

  onLog(`  ✓ Organización Full completada para ${dominio}`, 'success');
  return true;
}

// ================================================================
// FUNCIÓN PRINCIPAL: Organizador Rescue Original (Escenario B en-masa)
// ================================================================

/**
 * Procesa la carpeta in-place asumiendo que el sourcePath es "cloud/db"
 * y que las webs están un nivel más arriba "cloud/{dominio}/public_html/".
 */
async function processRescueFolder(sourcePath, onLog) {
  try {
    const cloudPath = path.resolve(sourcePath, '..');

    const statDb = await fsPromises.stat(sourcePath);
    if (!statDb.isDirectory()) throw new Error(`La ruta seleccionada no es un directorio: ${sourcePath}`);

    const dbFiles = (await fsPromises.readdir(sourcePath)).filter(f => f.endsWith('.sql.gz') || f.endsWith('.sql'));
    onLog(`Detectados ${dbFiles.length} archivos de base de datos en la carpeta seleccionada.`, 'info');

    let domainsParentPath = cloudPath;
    let hasDomainsSubfolder = false;
    
    // Si existe una carpeta "domains" junto a "db", procesaremos los dominios que están adentro
    const potentialDomainsPath = path.join(cloudPath, 'domains');
    if (fs.existsSync(potentialDomainsPath) && fs.statSync(potentialDomainsPath).isDirectory()) {
      domainsParentPath = potentialDomainsPath;
      hasDomainsSubfolder = true;
      onLog(`📁 Detectada subcarpeta "domains/". Los sitios se empaquetarán en la raíz del Cloud.`, 'info');
    }

    const items = await fsPromises.readdir(domainsParentPath, { withFileTypes: true });
    const dominios = items
      .filter(item => item.isDirectory() && path.join(domainsParentPath, item.name) !== path.resolve(sourcePath))
      .map(item => item.name);

    onLog(`Se encontraron ${dominios.length} carpetas de dominios en ${domainsParentPath}.`, 'info');

    let organizedCount = 0;

    for (const dominio of dominios) {
      onLog(`--- Procesando: ${dominio} ---`, 'info');

      const domainSourcePath = path.join(domainsParentPath, dominio);
      const domainDestPath = path.join(cloudPath, dominio); // Siempre a la raíz del cloud

      // processOrganizarRaw ahora necesita sourceDir y destDir si son distintos
      const result = await processOrganizarRaw(domainSourcePath, domainDestPath, dominio, sourcePath, dbFiles, onLog);
      if (result) {
        await registrarDominioProcesado(cloudPath, dominio);
        organizedCount++;
        onLog(`🎉 ${dominio} estructurado completamente.`, 'success');
      }
    }

    // Si usamos la subcarpeta domains, limpiarla si quedó vacía (o si borramos todos sus subdirectorios)
    if (hasDomainsSubfolder) {
      try {
        const remaining = await fsPromises.readdir(domainsParentPath);
        if (remaining.length === 0) {
          await fsPromises.rm(domainsParentPath, { recursive: true, force: true });
          onLog(`🧹 Carpeta "domains/" eliminada por limpieza final.`, 'info');
        }
      } catch (e) {}
    }

    onLog(`\nOrganización finalizada. Total exitosos: ${organizedCount}.`, 'info');
    return { success: true, organizedCount };
  } catch (error) {
    onLog(`Error fatal organizando carpeta: ${error.message}`, 'error');
    throw error;
  }
}

// ================================================================
// FUNCIÓN: Diet Mode (aplica dieta a un Cloud completo)
// Detecta automáticamente escenario A (legacy) o B (raw) por dominio
// ================================================================

/**
 * Aplica el "Modo Diet Ultra-Lite" a todos los dominios de un cloud.
 * Recibe la ruta raíz del cloud (no la carpeta db/).
 * @param {string} cloudPath - Ruta al directorio del cloud (ej: .../cuenta/cloud1/)
 * @param {string|null} dbFolderPath - Ruta a la carpeta de db/ (opcional, para escenario B)
 * @param {Function} onLog
 */
async function applyDietMode(cloudPath, dbFolderPath, onLog) {
  try {
    let domainsParentPath = cloudPath;
    let hasDomainsSubfolder = false;
    
    // Si existe una carpeta "domains" en la raíz del cloud, procesaremos los dominios que están adentro
    const potentialDomainsPath = path.join(cloudPath, 'domains');
    if (fs.existsSync(potentialDomainsPath) && fs.statSync(potentialDomainsPath).isDirectory()) {
      domainsParentPath = potentialDomainsPath;
      hasDomainsSubfolder = true;
      onLog(`📁 Detectada subcarpeta "domains/". Los sitios se empaquetarán en la raíz del Cloud.`, 'info');
    }

    const items = await fsPromises.readdir(domainsParentPath, { withFileTypes: true });
    const dominios = items
      .filter(item => item.isDirectory())
      .filter(item => {
        if (!dbFolderPath) return true;
        return path.join(domainsParentPath, item.name) !== path.resolve(dbFolderPath);
      })
      .map(item => item.name);

    onLog(`🗂 Cloud: ${cloudPath}`, 'info');
    onLog(`📦 Dominios encontrados: ${dominios.length} en ${domainsParentPath}`, 'info');

    let processed = 0;
    let skipped = 0;

    // Cargar dbFiles si hay carpeta db
    let dbFiles = [];
    if (dbFolderPath && fs.existsSync(dbFolderPath)) {
      dbFiles = (await fsPromises.readdir(dbFolderPath))
        .filter(f => f.endsWith('.sql.gz') || f.endsWith('.sql'));
      onLog(`🗄 Archivos SQL en db/: ${dbFiles.length}`, 'info');
    }

    for (const dominio of dominios) {
      onLog(`\n--- [DIET] ${dominio} ---`, 'info');
      
      const domainSourcePath = path.join(domainsParentPath, dominio);
      const domainDestPath = path.join(cloudPath, dominio);

      // Detectar escenario en la fuente (domainSourcePath)
      const hasPublicHtml = fs.existsSync(path.join(domainSourcePath, 'public_html'));
      const hasRootWpConfig = fs.existsSync(path.join(domainSourcePath, 'wp-config.php'));
      const hasLegacyTar = fs.existsSync(path.join(domainSourcePath, `${dominio}.tar.gz`)) ||
                           fs.existsSync(path.join(domainSourcePath, `${dominio}.tar`));
      const hasLegacySql = fs.existsSync(path.join(domainSourcePath, `${dominio}.sql`));

      try {
        let result = false;

        if ((hasPublicHtml || hasRootWpConfig) && dbFolderPath && !hasLegacyTar) {
          // Escenario B: raw con public_html o archivos WP sueltos en la raíz
          onLog(`  Escenario: Raw (Extracción WP + db/)`, 'info');
          result = await processDietRaw(domainSourcePath, domainDestPath, dominio, dbFolderPath, dbFiles, onLog);
        } else if (hasLegacyTar && hasLegacySql) {
          // Si tiene config.json suelto, es Escenario C: Loose Ultra-Lite
          if (fs.existsSync(path.join(domainSourcePath, 'config.json'))) {
            onLog(`  Escenario: Loose Ultra-Lite (archivos sueltos)`, 'info');
            result = await processDietLoose(domainSourcePath, domainDestPath, dominio, onLog);
          } else {
            // Escenario A: legacy tar.gz + sql (sin config.json previo)
            onLog(`  Escenario: Legacy (${dominio}.tar.gz + .sql)`, 'info');
            result = await processDietLegacy(domainSourcePath, domainDestPath, dominio, onLog);
          }
        } else if (hasLegacyTar && !hasLegacySql) {
          // Puede ser ya Ultra-Lite empaquetado sin .sql suelto → verificar config.json en tar
          try {
            let hasConfig = false;
            let hasWpAdmin = false;
            await tar.t({ file: path.join(domainSourcePath, `${dominio}.tar.gz`), onentry: (e) => {
              if (e.path === 'config.json' || e.path.endsWith('/config.json')) hasConfig = true;
              if (e.path.includes('wp-admin/')) hasWpAdmin = true;
            }});
            if (hasConfig && !hasWpAdmin) {
              onLog(`  [SKIP] ${dominio} ya está en formato Ultra-Lite. Limpiando sobrantes...`, 'info');
              
              const filesToClean = [`${dominio}.sql`, `${dominio}-hostinger.sql`, 'wp-config.php', dominio];
              if (fs.existsSync(path.join(domainSourcePath, `${dominio}.tar.gz`))) {
                filesToClean.push(`${dominio}.tar`);
              }
              
              const allFilesInDir = await fsPromises.readdir(domainSourcePath);
              onLog(`  [DEBUG] Archivos reales en carpeta: ${allFilesInDir.join(', ')}`, 'info');

              for (const file of filesToClean) {
                await forceDeleteFile(domainSourcePath, file, onLog);
              }
              
              // Si todo está ok, movemos el tar.gz al destPath si son distintos
              if (domainSourcePath !== domainDestPath) {
                 const srcTar = path.join(domainSourcePath, `${dominio}.tar.gz`);
                 const dstTar = path.join(domainDestPath, `${dominio}.tar.gz`);
                 if (fs.existsSync(srcTar)) {
                   await fsPromises.rename(srcTar, dstTar);
                   // Eliminamos el sourceDir
                   await fsPromises.rm(domainSourcePath, { recursive: true, force: true });
                 }
              }

              skipped++;
              continue;
            }
          } catch { /* no se puede leer el tar */ }
          onLog(`  [SKIP] No se reconoció el escenario para ${dominio}.`, 'warning');
          skipped++;
          continue;
        } else {
          onLog(`  [SKIP] No se reconoció el escenario para ${dominio}.`, 'warning');
          skipped++;
          continue;
        }

        if (result) {
          await registrarDominioProcesado(cloudPath, dominio);
          processed++;
        }
      } catch (error) {
        onLog(`  [ERROR] Falló al procesar ${dominio}: ${error.message}`, 'error');
      }
    }

    // Limpiar carpeta domains si quedó vacía
    if (hasDomainsSubfolder) {
      try {
        const remaining = await fsPromises.readdir(domainsParentPath);
        if (remaining.length === 0) {
          await fsPromises.rm(domainsParentPath, { recursive: true, force: true });
          onLog(`🧹 Carpeta "domains/" eliminada por limpieza final.`, 'info');
        }
      } catch (e) {}
    }

    onLog(`\n=== Fin del proceso DIET ===`, 'info');
    onLog(`Procesados con éxito: ${processed}`, 'success');
    onLog(`Omitidos o ya listos: ${skipped}`, 'warning');
    
    return { success: true, processed, skipped };
  } catch (error) {
    onLog(`Error fatal en Diet Mode: ${error.message}`, 'error');
    throw error;
  }
}

// ================================================================
// ESCENARIO C: Loose Ultra-Lite (config.json ya existe suelto)
// ================================================================

/**
 * Empaqueta un dominio que ya tiene la data extraída pero suelta:
 * - config.json (suelto)
 * - {dominio}.sql (suelto)
 * - {dominio}.tar.gz (que contiene uploads/ o wp-content/uploads/)
 */
async function processDietLoose(domainSourcePath, domainDestPath, dominio, onLog) {
  const tarGzPath = path.join(domainSourcePath, `${dominio}.tar.gz`);
  const tarAltPath = path.join(domainSourcePath, `${dominio}.tar`);
  const tarPath = fs.existsSync(tarGzPath) ? tarGzPath : tarAltPath;
  
  try {
    // 1. Verificar qué hay dentro del tar actual
    let hasConfigInside = false;
    if (fs.existsSync(tarPath)) {
      try {
        await tar.t({ file: tarPath, onentry: (e) => {
          if (e.path === 'config.json' || e.path.endsWith('/config.json')) hasConfigInside = true;
        }});
      } catch (_) {}
    }

    if (hasConfigInside) {
      onLog(`  [CLEANUP] El tar ya contiene todo. Borrando duplicados sueltos...`, 'info');
      
      const filesToDelete = [
        'config.json',
        `${dominio}.sql`,
        `${dominio}-hostinger.sql`,
        'wp-config.php',
        dominio
      ];
      if (fs.existsSync(path.join(domainSourcePath, `${dominio}.tar.gz`))) {
        filesToDelete.push(`${dominio}.tar`);
      }

      for (const file of filesToDelete) {
        await forceDeleteFile(domainSourcePath, file, onLog);
      }
      
      // Mover el archivo si el destino es distinto
      if (domainSourcePath !== domainDestPath) {
        await fsPromises.mkdir(domainDestPath, { recursive: true });
        const srcTar = path.join(domainSourcePath, `${dominio}.tar.gz`);
        const dstTar = path.join(domainDestPath, `${dominio}.tar.gz`);
        if (fs.existsSync(srcTar)) {
          await fsPromises.rename(srcTar, dstTar);
          await fsPromises.rm(domainSourcePath, { recursive: true, force: true });
        }
      }
      
      onLog(`  ✓ Limpieza completada.`, 'success');
      return true;
    }

    // 2. Si no lo tiene adentro, empaquetar
    const tempDir = path.join(domainSourcePath, 'diet_temp_loose');
    onLog(`  Empaquetando desde archivos sueltos Ultra-Lite...`, 'info');
    await fsPromises.mkdir(tempDir, { recursive: true });

    // Descomprimir el tar existente para extraer la carpeta uploads/
    onLog(`  Extrayendo uploads/ del tar.gz existente...`, 'info');
    if (fs.existsSync(tarPath)) {
      await tar.x({ 
        file: tarPath, 
        cwd: tempDir, 
        strict: false,
        filter: (p) => p.includes('uploads/')
      });
    }

    // Buscar dónde está uploads
    let uploadsInTemp = path.join(tempDir, 'uploads');
    if (!fs.existsSync(uploadsInTemp)) {
       uploadsInTemp = path.join(tempDir, 'wp-content', 'uploads');
    }
    if (!fs.existsSync(uploadsInTemp)) {
       uploadsInTemp = path.join(tempDir, 'public_html', 'wp-content', 'uploads');
    }

    const filesToPack = ['config.json', `${dominio}.sql`];
    const uploadsDestPath = path.join(domainSourcePath, 'uploads');

    if (fs.existsSync(uploadsInTemp)) {
      await fsPromises.cp(uploadsInTemp, uploadsDestPath, { recursive: true });
      filesToPack.push('uploads');
    } else {
      onLog(`  [WARN] No se encontró carpeta uploads en el tar existente.`, 'warning');
    }

    const finalTarPath = path.join(domainSourcePath, `${dominio}.tar.gz.new`);
    await tar.c({ gzip: true, file: finalTarPath, cwd: domainSourcePath, strict: false }, filesToPack);

    // Limpiar uploads extraído
    if (fs.existsSync(uploadsDestPath)) {
      await fsPromises.rm(uploadsDestPath, { recursive: true, force: true });
    }

    // Limpiar temp
    await fsPromises.rm(tempDir, { recursive: true, force: true }).catch(() => {});

    // Reemplazar el tar original con el nuevo tar.gz
    const finalDestination = path.join(domainDestPath, `${dominio}.tar.gz`);
    if (fs.existsSync(tarPath)) await fsPromises.unlink(tarPath).catch(() => {});
    
    // Mover si el destino es distinto o solo renombrar si es el mismo
    if (domainSourcePath !== domainDestPath) {
      await fsPromises.mkdir(domainDestPath, { recursive: true });
      await fsPromises.rename(finalTarPath, finalDestination);
      await fsPromises.rm(domainSourcePath, { recursive: true, force: true });
    } else {
      await fsPromises.rename(finalTarPath, finalDestination);
    }

    // Borrar sueltos (solo si no borramos ya el sourcePath completo)
    if (domainSourcePath === domainDestPath) {
      const wpConfigLoose = path.join(domainSourcePath, 'wp-config.php');
      if (fs.existsSync(wpConfigLoose)) await fsPromises.unlink(wpConfigLoose).catch(() => {});
      
      const residualHostinger = path.join(domainSourcePath, `${dominio}-hostinger.sql`);
      if (fs.existsSync(residualHostinger)) await fsPromises.unlink(residualHostinger).catch(() => {});
      
      await fsPromises.unlink(path.join(domainSourcePath, 'config.json')).catch(() => {});
      await fsPromises.unlink(path.join(domainSourcePath, `${dominio}.sql`)).catch(() => {});
    }

    onLog(`  ✓ Loose diet completado para ${dominio}`, 'success');
    return true;

  } finally {
    const tempDir = path.join(domainSourcePath, 'diet_temp_loose');
    if (fs.existsSync(tempDir)) {
      await fsPromises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

// ================================================================
// HELPER: Escritura atómica en dominios_procesados.json
// ================================================================

async function registrarDominioProcesado(cloudPath, dominio) {
  const jsonPath = path.join(cloudPath, 'dominios_procesados.json');
  const tmpPath = jsonPath + '.tmp';

  let dominios = [];
  try {
    if (fs.existsSync(jsonPath)) {
      const data = await fsPromises.readFile(jsonPath, 'utf8');
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) dominios = parsed;
    }
  } catch { /* ignora y crea nuevo array */ }

  dominios = dominios.map(item => {
    if (typeof item === 'string') return { dominio: item };
    return item;
  }).filter(Boolean);

  const idx = dominios.findIndex(d => d.dominio === dominio);
  const now = new Date().toISOString();

  const entry = {
    dominio,
    extractionStatus: 'success',
    errorReason: null,
    lastExtractionRun: now,
  };

  if (idx >= 0) {
    dominios[idx] = { ...dominios[idx], ...entry };
  } else {
    dominios.push(entry);
  }

  const fd = fs.openSync(tmpPath, 'w');
  fs.writeFileSync(fd, JSON.stringify(dominios, null, 2), 'utf8');
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmpPath, jsonPath);
}

module.exports = { processRescueFolder, applyDietMode, extractMassiveNative, cancelMassiveExtraction };
