const fs = require('fs');
const path = require('path');
const readline = require('readline');
const zlib = require('zlib');
const tar = require('tar');
const { pipeline } = require('stream/promises');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const question = (query, defaultVal = '') => new Promise(resolve => {
  rl.question(`${query}${defaultVal ? ` [${defaultVal}]` : ''}: `, (answer) => {
    resolve(answer.trim() || defaultVal);
  });
});

async function main() {
  console.log('\n=============================================');
  console.log('🚀 Hostinger Backup Parser & Matcher');
  console.log('=============================================\n');

  const defaultWorkspace = path.join(__dirname, '..', 'Workspace-Raiz');
  
  const rawWebs = await question('1. Ruta de webs descomprimidas (carpetas de dominios)');
  if (!fs.existsSync(rawWebs)) {
    console.error('❌ La ruta de webs no existe.');
    process.exit(1);
  }

  const rawDbs = await question('2. Ruta de bases de datos (.sql.gz)');
  if (!fs.existsSync(rawDbs)) {
    console.error('❌ La ruta de bases de datos no existe.');
    process.exit(1);
  }

  const baseWorkspace = await question('3. Ruta Workspace Base', defaultWorkspace);
  const cuenta = await question('4. Nombre de la Cuenta (ej: clinmedia)');
  const cloud = await question('5. Nombre del Cloud (ej: cloud9)');

  const outDir = path.join(baseWorkspace, cuenta, cloud);
  if (!fs.existsSync(outDir)) {
    console.log(`\nCreando directorio destino: ${outDir}`);
    fs.mkdirSync(outDir, { recursive: true });
  }

  const dominiosProcesadosPath = path.join(outDir, 'dominios_procesados.txt');
  
  // Leer dominios crudos
  const items = fs.readdirSync(rawWebs);
  const dominios = items.filter(i => {
    const stat = fs.statSync(path.join(rawWebs, i));
    return stat.isDirectory();
  });

  console.log(`\n🔍 Se encontraron ${dominios.length} dominios en la ruta base.`);

  // Leer lista de BDs
  const dbFiles = fs.readdirSync(rawDbs).filter(f => f.endsWith('.sql.gz'));
  console.log(`🔍 Se encontraron ${dbFiles.length} archivos .sql.gz.`);

  let successCount = 0;
  let warnCount = 0;

  console.log('\nEmpezando procesamiento (esto puede tomar varios minutos)...\n');

  for (const dominio of dominios) {
    console.log(`\n▶ Procesando dominio: ${dominio}`);
    
    const domainRawPath = path.join(rawWebs, dominio);
    const publicHtmlPath = path.join(domainRawPath, 'public_html');
    const wpConfigPath = path.join(publicHtmlPath, 'wp-config.php');

    if (!fs.existsSync(publicHtmlPath)) {
      console.log(`   ⚠️ No se encontró public_html para ${dominio}. Saltando.`);
      warnCount++;
      continue;
    }

    if (!fs.existsSync(wpConfigPath)) {
      console.log(`   ⚠️ No se encontró wp-config.php en public_html para ${dominio}. Saltando.`);
      warnCount++;
      continue;
    }

    // 1. Extraer DB_NAME
    const wpConfigContent = fs.readFileSync(wpConfigPath, 'utf8');
    const dbMatch = wpConfigContent.match(/define\(\s*['"]DB_NAME['"]\s*,\s*['"]([^'"]+)['"]\s*\);/i);
    
    if (!dbMatch || !dbMatch[1]) {
      console.log(`   ⚠️ No se pudo extraer DB_NAME del wp-config.php de ${dominio}. Saltando.`);
      warnCount++;
      continue;
    }

    const dbName = dbMatch[1];
    console.log(`   ✓ DB detectada en wp-config: ${dbName}`);

    // 2. Buscar archivo .sql.gz
    const matchedDbFile = dbFiles.find(f => f.includes(dbName));
    if (!matchedDbFile) {
      console.log(`   ⚠️ NO SE ENCONTRÓ ninguna base de datos para ${dbName} en la carpeta de BDs.`);
      warnCount++;
      continue;
    }

    console.log(`   ✓ Match con archivo DB: ${matchedDbFile}`);

    // 3. Preparar directorios de salida
    const domainOutDir = path.join(outDir, dominio);
    if (!fs.existsSync(domainOutDir)) {
      fs.mkdirSync(domainOutDir, { recursive: true });
    }

    // 4. Descomprimir DB
    const dbSourcePath = path.join(rawDbs, matchedDbFile);
    const dbDestPath = path.join(domainOutDir, `${dominio}.sql`);
    
    console.log(`   ⏳ Descomprimiendo base de datos a ${dominio}.sql...`);
    try {
      const readStream = fs.createReadStream(dbSourcePath);
      const writeStream = fs.createWriteStream(dbDestPath);
      const unzip = zlib.createGunzip();
      await pipeline(readStream, unzip, writeStream);
      console.log(`   ✓ DB extraída con éxito.`);
    } catch (err) {
      console.error(`   ❌ Error extrayendo BD para ${dominio}:`, err.message);
      warnCount++;
      continue;
    }

    // 5. Comprimir public_html
    const tarDestPath = path.join(domainOutDir, `${dominio}.tar.gz`);
    console.log(`   ⏳ Comprimiendo public_html a ${dominio}.tar.gz...`);
    try {
      await tar.c(
        {
          gzip: true,
          file: tarDestPath,
          cwd: publicHtmlPath // Usamos el interior de public_html como raiz
        },
        ['.'] // Todo el contenido
      );
      console.log(`   ✓ Web comprimida con éxito.`);
    } catch (err) {
      console.error(`   ❌ Error comprimiendo web para ${dominio}:`, err.message);
      warnCount++;
      continue;
    }

    // 6. Registrar en dominios_procesados.txt
    fs.appendFileSync(dominiosProcesadosPath, `${dominio}\n`);
    successCount++;
    console.log(`   🎉 ${dominio} completado.`);
  }

  console.log('\n=============================================');
  console.log(`✅ Proceso finalizado. Éxitos: ${successCount} | Advertencias: ${warnCount}`);
  console.log(`📂 Resultados en: ${outDir}`);
  console.log(`📝 Registro guardado en: ${dominiosProcesadosPath}`);
  console.log('=============================================\n');

  rl.close();
}

main().catch(err => {
  console.error('Error fatal:', err);
  rl.close();
  process.exit(1);
});
