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
      commandToRun = `plesk bin mail --update ${emailTarget} -passwd '${password}' -status enabled`;
      accionRes = 'actualizado';
    } else {
      commandToRun = `plesk bin mail --create ${emailTarget} -passwd '${password}' -mailbox true -status enabled`;
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

/**
 * Sube y restaura el archivo emails.tar.gz de un dominio a Plesk vía SSH.
 *
 * @param {object} params
 * @param {string} params.domain - Dominio objetivo (ej. 'ejemplo.com')
 * @param {string} params.domainPath - Ruta local del dominio en el workspace
 * @param {Function} params.executeCommandFn - (cmd) => Promise<{ stdout, stderr }>
 * @param {Function} params.sftpUploadFn - (localFile, remoteFile) => Promise<void>
 * @param {Function} [params.emitLog] - (msg, type) => void
 * @returns {Promise<{ exito: boolean, mensaje: string, skipped?: boolean }>}
 */
async function restaurarEmailsPlesk({ domain, domainPath, executeCommandFn, sftpUploadFn, emitLog = () => {} }) {
  const fs = require('fs');
  const path = require('path');

  const emailsTarLocal = path.join(domainPath, 'emails.tar.gz');
  const metaPath = path.join(domainPath, 'emails.meta.json');

  if (!fs.existsSync(emailsTarLocal)) {
    emitLog(`[EMAIL-RESTORE] No existe emails.tar.gz para ${domain}. Omitiendo restauración de correo.`, 'info');
    return { exito: true, skipped: true, mensaje: 'No hay emails.tar.gz para restaurar.' };
  }

  // Check si ya fue restaurado exitosamente en Plesk previamente
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      if (meta.pleskRestored === true) {
        const info = meta.pleskRestoredAt ? `el ${new Date(meta.pleskRestoredAt).toLocaleString()}` : 'previamente';
        emitLog(`[EMAIL-RESTORE] ✅ Correos ya restaurados en Plesk para ${domain} (${info}) — omitiendo.`, 'info');
        return { exito: true, skipped: true, mensaje: `Correos ya restaurados en Plesk (${info})` };
      }
    } catch (_) {}
  }

  emitLog(`[EMAIL-RESTORE] Archivo emails.tar.gz detectado para ${domain}. Iniciando transferencia a Plesk...`);

  const password = (await obtenerContrasena()) || 'KrkPass2026!';
  const remoteTar = `/tmp/emails_${domain}.tar.gz`;
  const remoteScript = `/tmp/restore_emails_${domain}.sh`;

  // Paso 1: Subir emails.tar.gz por SFTP
  const tarSizeMB = (fs.statSync(emailsTarLocal).size / 1024 / 1024).toFixed(2);
  emitLog(`[EMAIL-RESTORE] Subiendo emails.tar.gz (${tarSizeMB} MB) a Plesk para ${domain}...`);
  await sftpUploadFn(emailsTarLocal, remoteTar);

  // Paso 2: Crear y subir script de restauración remota
  const scriptContent = `#!/bin/bash
DOMAIN="${domain}"
MASTER_PASS="${password}"
TAR_FILE="${remoteTar}"
EXTRACT_DIR="/tmp/emails_ext_${domain}"

if [ ! -f "$TAR_FILE" ]; then
  echo "ERROR_TAR_NOT_FOUND"
  exit 1
fi

echo "Activando servicio de correo en Plesk para \$DOMAIN..."
plesk bin site -u "\$DOMAIN" -mail_service true 2>&1 || plesk bin mail --on "\$DOMAIN" 2>&1 || true

rm -rf "$EXTRACT_DIR"
mkdir -p "$EXTRACT_DIR"
tar -xzf "$TAR_FILE" -C "$EXTRACT_DIR"

echo "Contenido descomprimido en \$EXTRACT_DIR:"
ls -la "$EXTRACT_DIR"

for MB_DIR in "$EXTRACT_DIR"/*; do
  if [ -d "$MB_DIR" ]; then
    EMAIL_NAME=\$(basename "$MB_DIR")
    if [[ "\$EMAIL_NAME" != *"@"* ]]; then
      FULL_EMAIL="\${EMAIL_NAME}@\${DOMAIN}"
      MAILUSER="\$EMAIL_NAME"
    else
      FULL_EMAIL="\$EMAIL_NAME"
      MAILUSER="\${EMAIL_NAME%%@*}"
    fi

    echo "Aprovisionando buzón: \$FULL_EMAIL (usuario \$MAILUSER)..."
    plesk bin mail --info "\$FULL_EMAIL" >/dev/null 2>&1
    if [ \$? -ne 0 ]; then
      CREATE_OUT=\$(plesk bin mail --create "\$FULL_EMAIL" -passwd "\$MASTER_PASS" -mailbox true -status enabled 2>&1)
      echo "Resultado de creación \$FULL_EMAIL: \$CREATE_OUT"
    else
      echo "El buzón \$FULL_EMAIL ya existe en Plesk."
    fi

    MAILDIR_PATH="/var/qmail/mailnames/\$DOMAIN/\$MAILUSER/Maildir"
    mkdir -p "\$MAILDIR_PATH/cur" "\$MAILDIR_PATH/new" "\$MAILDIR_PATH/tmp"

    for FOLDER_DIR in "\$MB_DIR"/*; do
      if [ -d "\$FOLDER_DIR" ]; then
        FOLDER_NAME=\$(basename "\$FOLDER_DIR")
        if [ "\$FOLDER_NAME" == "INBOX" ] || [ "\$FOLDER_NAME" == "inbox" ]; then
          TARGET_DIR="\$MAILDIR_PATH/cur"
        else
          SAFE_FOLDER=\$(echo "\$FOLDER_NAME" | sed 's/^[.]*//')
          TARGET_DIR="\$MAILDIR_PATH/.\$SAFE_FOLDER/cur"
          mkdir -p "\$MAILDIR_PATH/.\$SAFE_FOLDER/cur" "\$MAILDIR_PATH/.\$SAFE_FOLDER/new" "\$MAILDIR_PATH/.\$SAFE_FOLDER/tmp"
          grep -q "^\$SAFE_FOLDER\$" "\$MAILDIR_PATH/subscriptions" 2>/dev/null || echo "\$SAFE_FOLDER" >> "\$MAILDIR_PATH/subscriptions"
        fi

        find "\$FOLDER_DIR" -type f -exec cp {} "\$TARGET_DIR/" \\; 2>/dev/null || true
      elif [ -f "\$FOLDER_DIR" ]; then
        cp "\$FOLDER_DIR" "\$MAILDIR_PATH/cur/" 2>/dev/null || true
      fi
    done

    chown -R popuser:popuser "/var/qmail/mailnames/\$DOMAIN/\$MAILUSER" 2>/dev/null || true
    chmod -R 700 "/var/qmail/mailnames/\$DOMAIN/\$MAILUSER" 2>/dev/null || true
  fi
done

echo "Ejecutando plesk repair mail \$DOMAIN..."
plesk repair mail "\$DOMAIN" -y 2>&1 || true
rm -rf "$TAR_FILE" "$EXTRACT_DIR" "${remoteScript}"
echo "RESTORE_SUCCESS"
`;

  const tempScriptPath = path.join(domainPath, `_restore_script_${domain}.sh`);
  fs.writeFileSync(tempScriptPath, scriptContent, 'utf8');

  try {
    emitLog(`[EMAIL-RESTORE] Subiendo script de restauración a Plesk para ${domain}...`);
    await sftpUploadFn(tempScriptPath, remoteScript);

    emitLog(`[EMAIL-RESTORE] Ejecutando restauración en Plesk para ${domain}...`);
    const execWithTimeout = Promise.race([
      executeCommandFn(`chmod +x ${remoteScript} && ${remoteScript}`),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Timeout: el script de restauración tardó más de 3 minutos')), 180000)
      ),
    ]);
    const res = await execWithTimeout;

    if (res && res.stdout) {
      const lines = res.stdout.split('\n').filter(l => l.trim().length > 0);
      for (const line of lines) {
        emitLog(`[PLESK-RESTORE] ${line}`);
      }
    }
    if (res && res.stderr) {
      const errLines = res.stderr.split('\n').filter(l => l.trim().length > 0);
      for (const line of errLines) {
        emitLog(`[PLESK-RESTORE][WARN] ${line}`, 'warning');
      }
    }

    if (res && res.code === 0 && (res.stdout || '').includes('RESTORE_SUCCESS')) {
      // Guardar bandera de éxito en emails.meta.json para no repetir en futuras ejecuciones
      try {
        let meta = {};
        if (fs.existsSync(metaPath)) {
          meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        }
        meta.pleskRestored = true;
        meta.pleskRestoredAt = new Date().toISOString();
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
      } catch (mErr) {
        console.warn(`[EMAIL-RESTORE] No se pudo actualizar emails.meta.json para ${domain}:`, mErr.message);
      }

      emitLog(`[EMAIL-RESTORE] ✅ Correos restaurados correctamente en Plesk para ${domain}`, 'success');
      return { exito: true, mensaje: `Correos restaurados en Plesk para ${domain}` };
    } else {
      const errDetail = (res?.stderr || res?.stdout || `Exit code ${res?.code}`).trim();
      emitLog(`[EMAIL-RESTORE][WARN] Falló la restauración de correos para ${domain}: ${errDetail}`, 'warning');
      return { exito: false, mensaje: errDetail || 'Error durante la ejecución del script de restauración' };
    }
  } catch (err) {
    emitLog(`[EMAIL-RESTORE][WARN] Falló la restauración de correos para ${domain}: ${err.message}`, 'error');
    return { exito: false, mensaje: err.message };
  } finally {
    try { fs.unlinkSync(tempScriptPath); } catch (_) {}
  }
}

module.exports = { asegurarBuzonInfo, restaurarEmailsPlesk };
