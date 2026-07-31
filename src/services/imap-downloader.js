const Imap = require('imap');
const fsp = require('fs').promises;
const fs = require('fs');
const path = require('path');
const tar = require('tar');

// Hostinger Email IMAP server settings
const HOSTINGER_IMAP = {
  host: 'imap.hostinger.com',
  port: 993,
  tls: true,
};

const BATCH_SIZE = 50;          // Mensajes por lote
const BATCH_TIMEOUT_MS = 90000; // 90s máximo por lote antes de abandonarlo

/**
 * Descarga todos los correos de una cuenta de email via IMAP
 * y los guarda como archivos .eml en localDestPath.
 *
 * Descarga en lotes de BATCH_SIZE para tolerar conexiones lentas o VPN inestable.
 * Cada lote tiene un timeout de BATCH_TIMEOUT_MS para evitar bloqueos indefinidos.
 */
class ImapDownloader {
  /**
   * Descarga todos los correos de una cuenta.
   *
   * @param {object} credentials - { user, password, host?, port?, tls? }
   * @param {string} localDestPath - Carpeta local donde guardar los .eml
   * @param {function} onLog - (msg, type) => void
   * @returns {Promise<{ totalMessages: number, folders: string[] }>}
   */
  async downloadAll(credentials, localDestPath, onLog = () => {}) {
    const log = (msg, type = 'info') => {
      console.log(`[IMAP-DL] ${msg}`);
      onLog(msg, type);
    };

    await fsp.mkdir(localDestPath, { recursive: true });

    return new Promise((resolve, reject) => {
      const imap = new Imap({
        user: credentials.user,
        password: credentials.password,
        host: credentials.host || HOSTINGER_IMAP.host,
        port: credentials.port || HOSTINGER_IMAP.port,
        tls: credentials.tls !== undefined ? credentials.tls : HOSTINGER_IMAP.tls,
        tlsOptions: { rejectUnauthorized: false },
        connTimeout: 30000,
        authTimeout: 15000,
        socketTimeout: 120000, // 2 min sin datos → desconectar
      });

      const totalMessages = { count: 0 };
      const folders = [];

      // Helper: cierra la sesión con timeout de 8s por si el LOGOUT nunca llega (VPN inestable)
      const endSession = () => {
        const killTimer = setTimeout(() => {
          try { imap.destroy(); } catch (_) {}
        }, 8000);
        imap.once('end', () => clearTimeout(killTimer));
        imap.once('close', () => clearTimeout(killTimer));
        try { imap.end(); } catch (_) { clearTimeout(killTimer); }
      };

      imap.once('ready', () => {
        log(`Conectado al servidor IMAP para ${credentials.user}`);
        this._downloadAllBoxes(imap, localDestPath, log, totalMessages, folders)
          .then(() => { endSession(); })
          .catch((err) => { endSession(); reject(err); });
      });

      imap.once('end', () => {
        log(`Sesión IMAP finalizada. ${totalMessages.count} mensajes en ${folders.length} carpetas.`);
        resolve({ totalMessages: totalMessages.count, folders });
      });

      imap.once('close', (hadError) => {
        // Fallback: si el socket cierra sin emitir 'end' (raro pero posible)
        resolve({ totalMessages: totalMessages.count, folders });
      });

      imap.once('error', (err) => {
        reject(new Error(`Error IMAP: ${err.message}`));
      });

      imap.connect();
    });
  }

  /**
   * Itera todas las carpetas IMAP y descarga los mensajes.
   */
  async _downloadAllBoxes(imap, destPath, log, totalMessages, folders) {
    const boxList = await this._getBoxes(imap);
    const flatBoxes = this._flattenBoxes(boxList);

    for (const boxPath of flatBoxes) {
      try {
        const count = await this._downloadBox(imap, boxPath, destPath, log);
        if (count > 0) {
          totalMessages.count += count;
          folders.push(boxPath);
        }
      } catch (err) {
        log(`  [WARN] Error en carpeta "${boxPath}": ${err.message}`, 'warning');
      }
    }
  }

  /**
   * Obtiene la lista de buzones IMAP.
   */
  _getBoxes(imap) {
    return new Promise((resolve, reject) => {
      imap.getBoxes((err, boxes) => {
        if (err) return reject(err);
        resolve(boxes);
      });
    });
  }

  /**
   * Aplana el árbol de buzones IMAP en un array de paths.
   */
  _flattenBoxes(boxes, prefix = '') {
    const result = [];
    for (const name of Object.keys(boxes || {})) {
      const fullPath = prefix ? `${prefix}${boxes[name].delimiter || '/'}${name}` : name;
      result.push(fullPath);
      if (boxes[name].children) {
        result.push(...this._flattenBoxes(boxes[name].children, fullPath));
      }
    }
    return result;
  }

  /**
   * Descarga todos los mensajes de una carpeta IMAP en lotes de BATCH_SIZE.
   * Si un lote se cuelga más de BATCH_TIMEOUT_MS, lo abandona y continúa con el siguiente.
   *
   * @returns {Promise<number>} - número de mensajes descargados
   */
  _downloadBox(imap, boxPath, destPath, log) {
    return new Promise((resolve, reject) => {
      imap.openBox(boxPath, true /* readonly */, async (err, box) => {
        if (err) return resolve(0); // Carpeta inaccesible → saltar

        const messageCount = box.messages?.total || 0;
        if (messageCount === 0) return resolve(0);

        log(`  [${boxPath}] ${messageCount} mensajes...`);

        const safeFolderName = boxPath.replace(/[/\\:*?"<>|]/g, '_');
        const folderPath = path.join(destPath, safeFolderName);
        await fsp.mkdir(folderPath, { recursive: true });

        let downloaded = 0;

        // Iterar en lotes: 1-50, 51-100, …
        for (let start = 1; start <= messageCount; start += BATCH_SIZE) {
          const end = Math.min(start + BATCH_SIZE - 1, messageCount);
          const range = `${start}:${end}`;

          try {
            const batchCount = await this._fetchBatch(imap, range, folderPath, boxPath, log);
            downloaded += batchCount;
          } catch (batchErr) {
            log(`  [WARN] Lote ${range} fallido en "${boxPath}": ${batchErr.message}`, 'warning');
            // Continuar con el siguiente lote aunque éste falle
          }
        }

        log(`  [${boxPath}] ${downloaded}/${messageCount} mensajes descargados.`);
        resolve(downloaded);
      });
    });
  }

  /**
   * Descarga un rango de mensajes seq con timeout de seguridad.
   * Si la conexión se cuelga, resuelve con lo descargado hasta ese momento.
   */
  _fetchBatch(imap, range, folderPath, boxPath, log) {
    return new Promise((resolve) => {
      let settled = false;
      let batchCount = 0;
      const writePromises = [];

      // Timeout de seguridad: si el lote no termina en BATCH_TIMEOUT_MS, continuar
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          log(`  [WARN] Timeout lote ${range} en "${boxPath}" (${batchCount} descargados) — continuando`, 'warning');
          resolve(batchCount);
        }
      }, BATCH_TIMEOUT_MS);

      const fetch = imap.seq.fetch(range, { bodies: '', struct: false });

      fetch.on('message', (msg, seqno) => {
        const chunks = [];
        msg.on('body', (stream) => {
          stream.on('data', (chunk) => chunks.push(chunk));
          stream.once('end', () => {
            const emlPath = path.join(folderPath, `${seqno}.eml`);
            const content = Buffer.concat(chunks);
            writePromises.push(
              fsp.writeFile(emlPath, content)
                .then(() => { batchCount++; })
                .catch(() => {})
            );
          });
        });
      });

      fetch.once('error', (fetchErr) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          log(`  [WARN] Error fetch lote ${range}: ${fetchErr.message}`, 'warning');
          resolve(batchCount);
        }
      });

      fetch.once('end', async () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          try { await Promise.all(writePromises); } catch (_) {}
          resolve(batchCount);
        }
      });
    });
  }

  /**
   * Comprime la carpeta de emails descargados en un .tar.gz.
   *
   * @param {string} sourcePath - Carpeta con subcarpetas por mailbox
   * @param {string} outputTarPath - Ruta de salida emails.tar.gz
   * @returns {Promise<number>} - tamaño en bytes
   */
  async compress(sourcePath, outputTarPath) {
    const entries = await fsp.readdir(sourcePath);
    if (entries.length === 0) {
      throw new Error('No hay emails descargados para comprimir.');
    }

    await tar.c(
      { gzip: true, file: outputTarPath, cwd: sourcePath, strict: false },
      entries
    );

    const stats = await fsp.stat(outputTarPath);
    return stats.size;
  }
}

module.exports = { ImapDownloader };
