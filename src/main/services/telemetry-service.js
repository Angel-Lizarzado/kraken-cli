'use strict';

const os = require('os');
const { machineIdSync } = require('node-machine-id');

/**
 * Genera un payload de telemetría con datos del entorno local.
 * Capa 1 — Cryptographic Capability Decryption (CCD).
 *
 * IMPORTANTE: machine_id se retorna sin hashear para que el
 * Worker de Cloudflare pueda derivar la llave AES correcta.
 *
 * @returns {{ machine_id: string, os_username: string, hostname: string, timestamp: string }}
 */
function collectTelemetry() {
  const machine_id = machineIdSync({ original: true }); // sin hashear
  const os_username = os.userInfo().username;
  const hostname = os.hostname();
  const timestamp = new Date().toISOString();

  return { machine_id, os_username, hostname, timestamp };
}

module.exports = { collectTelemetry };
