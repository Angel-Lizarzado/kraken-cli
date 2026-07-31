const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execSync } = require('child_process');

class BackupPacker {
  async parseSqlForMeta(sqlPath) {
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
        if (!prefix || prefix === 'wp_') {
          const prefixMatch = line.match(/CREATE TABLE `?([a-zA-Z0-9_]+)options`?/i);
          if (prefixMatch) {
            prefix = prefixMatch[1];
            found++;
          }
        }

        if (!theme) {
          const themeMatch = line.match(/'template',\s*'([^']+)'/);
          if (themeMatch) {
            theme = themeMatch[1].trim();
            found++;
          }
        }

        if (found >= 2) {
          rl.close();
          readStream.destroy();
          rl.removeAllListeners();
        }
      });

      rl.on('close', () => resolve({ prefix, theme }));
    });
  }

  scanPlugins(pluginsPath) {
    if (!fs.existsSync(pluginsPath)) return [];
    const items = fs.readdirSync(pluginsPath);
    const plugins = [];
    for (const item of items) {
      const itemPath = path.join(pluginsPath, item);
      if (fs.statSync(itemPath).isDirectory()) {
        plugins.push(item);
      }
    }
    return plugins;
  }

  async buildUltraLite(domainPath, emitLog = null) {
    const log = (msg) => {
      console.log(msg);
      if (emitLog) emitLog(msg, 'info');
    };
    
    log(`[PACKER] Procesando carpeta para Ultra-Lite: ${domainPath}`);
    
    if (!fs.existsSync(domainPath)) {
      throw new Error(`La carpeta no existe: ${domainPath}`);
    }

    const domainName = path.basename(domainPath);
    const tarName = `${domainName}.tar.gz`;
    const finalTarPath = path.join(domainPath, tarName);
    const markerPath = path.join(domainPath, '.ultralite_built');

    // 1. Si existe el paquete y también el marcador, es nuestro ultralite. Omitimos compresión.
    if (fs.existsSync(finalTarPath) && fs.existsSync(markerPath)) {
      log(`[PACKER] El paquete ultralite ${tarName} ya existe. Omitiendo compresión.`);
      return finalTarPath;
    }

    // 2. Si existe un dominio.tar.gz PERO no hay marcador, podría ser el backup pesado (Full) o un ultralite hecho por Rescue Mode.
    if (fs.existsSync(finalTarPath) && !fs.existsSync(markerPath)) {
      let isAlreadyUltralite = false;
      try {
        const output = execSync(`tar -tf "${tarName}"`, { cwd: domainPath, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
        if (output.includes('config.json')) {
          isAlreadyUltralite = true;
        }
      } catch (err) { }

      if (isAlreadyUltralite) {
        log(`[PACKER] Se detectó un paquete ultralite antiguo (modo rescue). Creando marcador y omitiendo compresión.`);
        fs.writeFileSync(markerPath, '1');
        return finalTarPath;
      }
    }

    // A este punto, necesitamos reconstruir.
    const files = fs.readdirSync(domainPath);
    const sqlFile = files.find(f => f.endsWith('.sql'));
    
    if (!sqlFile) {
      throw new Error(`No se encontró ningún archivo .sql en ${domainPath}`);
    }

    const sqlPath = path.join(domainPath, sqlFile);
    let wpContentPath = path.join(domainPath, 'wp-content');
    
    if (!fs.existsSync(wpContentPath)) {
      const publicHtmlContent = path.join(domainPath, 'public_html', 'wp-content');
      if (fs.existsSync(publicHtmlContent)) {
        wpContentPath = publicHtmlContent;
      } else {
        throw new Error(`No se encontró wp-content ni public_html/wp-content en ${domainPath}`);
      }
    }

    log(`[1/4] Analizando SQL para extraer prefix y tema... (${sqlFile})`);
    const { prefix, theme } = await this.parseSqlForMeta(sqlPath);
    log(`      -> Prefix: ${prefix} | Tema: ${theme}`);

    log(`[2/4] Escaneando plugins...`);
    const pluginsPath = path.join(wpContentPath, 'plugins');
    const plugins = this.scanPlugins(pluginsPath);
    log(`      -> ${plugins.length} plugins detectados.`);

    log(`[3/4] Generando config.json...`);
    const config = {
      db_prefix: prefix,
      theme: theme,
      plugins: plugins
    };
    const configPath = path.join(domainPath, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    const fullTarPath = path.join(domainPath, `${domainName}-full.tar.gz`);

    if (fs.existsSync(finalTarPath) && !fs.existsSync(markerPath)) {
      log(`[PACKER] Se detectó un backup original pesado. Renombrando a ${domainName}-full.tar.gz`);
      fs.renameSync(finalTarPath, fullTarPath);
    }

    log(`[4/4] Empaquetando Ultra-Lite (.tar.gz)...`);
    const uploadsPath = path.join(wpContentPath, 'uploads');
    const tempUploadsPath = path.join(domainPath, 'uploads');
    let uploadsWasCopied = false;
    
    if (fs.existsSync(uploadsPath) && uploadsPath !== tempUploadsPath) {
      fs.cpSync(uploadsPath, tempUploadsPath, { recursive: true });
      uploadsWasCopied = true;
    }

    // Variables ya declaradas arriba
    
    try {
      const filesToCompress = ['config.json', sqlFile];
      if (fs.existsSync(tempUploadsPath)) filesToCompress.push('uploads');
      
      const command = `tar -czf "${tarName}" ${filesToCompress.map(f => `"${f}"`).join(' ')}`;
      execSync(command, { cwd: domainPath, stdio: 'inherit' });
      log(`[OK] Paquete creado exitosamente: ${tarName}`);
      
      // Crear marcador de ultralite
      fs.writeFileSync(markerPath, '1');

      // Limpieza (SOLO si nosotros hicimos la copia temporal)
      if (uploadsWasCopied && fs.existsSync(tempUploadsPath)) {
        fs.rmSync(tempUploadsPath, { recursive: true, force: true });
      }
      
      return finalTarPath;
    } catch (err) {
      throw new Error(`Falló la compresión tar: ${err.message}`);
    }
  }
}

let instance = null;
function getBackupPacker() {
  if (!instance) {
    instance = new BackupPacker();
  }
  return instance;
}

module.exports = {
  getBackupPacker,
  BackupPacker
};
