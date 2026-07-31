'use strict';

/**
 * @file serverMetricsService.js
 * @description Servicio de métricas en tiempo real para servidores Plesk via SSH.
 *
 * Obtiene RAM, CPU, Disco y carga del sistema en una sola conexión SSH.
 * Diseñado para polling on-demand (no mantiene conexión permanente).
 */

// ─── Comandos SSH de métricas (optimizados para Linux/Plesk) ─────────────────

/**
 * Un único script bash que obtiene todas las métricas en una sola llamada SSH.
 * Separamos con delimitadores para parseo robusto.
 */
const METRICS_SCRIPT = `
echo "===RAM===";
free -m | awk 'NR==2{printf "%d %d %d", $2, $3, $4}';
echo "";
echo "===CPU===";
top -bn1 | grep -E "^(%Cpu|Cpu)" | awk '{
  for(i=1;i<=NF;i++) {
    if($i ~ /us,/) { gsub(/,/,"",$i); us=$i }
    if($i ~ /sy,/) { gsub(/,/,"",$i); sy=$i }
  }
  printf "%.1f", us+sy
}' 2>/dev/null || \
  cat /proc/stat | awk 'NR==1{idle=$5; total=$2+$3+$4+$5+$6+$7+$8; printf "%.1f", (total-idle)/total*100}';
echo "";
echo "===DISK===";
df -BM / | awk 'NR==2{gsub(/M/,"",$2); gsub(/M/,"",$3); gsub(/M/,"",$4); printf "%s %s %s", $2, $3, $4}';
echo "";
echo "===INODES===";
df -i / | awk 'NR==2{printf "%s %s %s", $2, $3, $4}';
echo "";
echo "===LOAD===";
cat /proc/loadavg | awk '{printf "%s %s %s", $1, $2, $3}';
echo "";
echo "===UPTIME===";
uptime -p 2>/dev/null || uptime | awk -F'up ' '{split($2,a,","); printf "%s", a[1]}';
echo "";
echo "===PLESK===";
plesk -v 2>/dev/null | grep -i "Product version" | awk -F':' '{print $2}' | xargs || echo "Unknown";
echo "";
echo "===OS===";
cat /etc/os-release 2>/dev/null | awk -F= '/^PRETTY_NAME/ {gsub(/"/,"",$2); print $2}' || echo "Unknown";
echo "";
echo "===DOMAINS===";
plesk db -Ne "SELECT count(*) FROM domains;" 2>/dev/null || echo "0";
echo "";
echo "===SERVICES===";
for s in mariadb mysql nginx httpd sw-engine fail2ban; do echo -n "$s:"$(systemctl is-active $s 2>/dev/null || echo "unknown")" "; done;
echo "";
echo "===NETWORK===";
cat /proc/net/dev | awk 'NR>2 && $1 !~ /^lo:/ {rx+=$2; tx+=$10} END {printf "%s %s", rx, tx}' || echo "0 0";
echo "";
`.trim();

// ─── Parser de la salida del script ──────────────────────────────────────────

/**
 * @typedef {Object} ServerMetrics
 * @property {number}  ramTotalMb    - RAM total en MB
 * @property {number}  ramUsedMb     - RAM usada en MB
 * @property {number}  ramFreeMb     - RAM libre en MB
 * @property {number}  ramPercent    - % de uso de RAM (0-100)
 * @property {number}  cpuPercent    - % de uso de CPU (0-100)
 * @property {number}  diskTotalMb   - Disco total en MB
 * @property {number}  diskUsedMb    - Disco usado en MB
 * @property {number}  diskFreeMb    - Disco libre en MB
 * @property {number}  diskPercent   - % de uso de disco (0-100)
 * @property {string}  load1         - Carga 1 minuto
 * @property {string}  load5         - Carga 5 minutos
 * @property {string}  load15        - Carga 15 minutos
 * @property {string}  uptime        - Tiempo activo del servidor
 * @property {number}  inodesTotal   - Total inodos
 * @property {number}  inodesUsed    - Inodos usados
 * @property {number}  inodesPercent - % uso inodos
 * @property {string}  pleskVersion  - Versión de Plesk
 * @property {string}  osVersion     - Versión del SO
 * @property {number}  totalDomains  - Dominios alojados
 * @property {Object}  services      - Estado de servicios (nginx, apache, mysql, fail2ban)
 * @property {number}  netRxBytes    - Bytes recibidos (acumulado)
 * @property {number}  netTxBytes    - Bytes enviados (acumulado)
 * @property {number}  timestamp     - Unix timestamp de la medición
 */

/**
 * Parsea la salida del METRICS_SCRIPT en un objeto de métricas tipado.
 * @param {string} raw - stdout del script
 * @returns {ServerMetrics}
 */
function parseMetrics(raw) {
  const sections = {};
  let current = null;
  const lines = raw.split('\n');

  for (const line of lines) {
    const marker = line.match(/^===(\w+)===/);
    if (marker) {
      current = marker[1];
      sections[current] = '';
    } else if (current && line.trim()) {
      sections[current] = (sections[current] + ' ' + line.trim()).trim();
    }
  }

  // RAM: "total used free" en MB
  const ramParts = (sections.RAM || '').split(' ').map(Number);
  const ramTotal = ramParts[0] || 0;
  const ramUsed  = ramParts[1] || 0;
  const ramFree  = ramParts[2] || 0;
  const ramPercent = ramTotal > 0 ? Math.round((ramUsed / ramTotal) * 100) : 0;

  // CPU: valor float
  const cpuPercent = parseFloat(sections.CPU || '0') || 0;

  // Disco: "total used free" en MB (sin la letra M)
  const diskParts = (sections.DISK || '').split(' ').map(Number);
  const diskTotal   = diskParts[0] || 0;
  const diskUsed    = diskParts[1] || 0;
  const diskFree    = diskParts[2] || 0;
  const diskPercent = diskTotal > 0 ? Math.round((diskUsed / diskTotal) * 100) : 0;

  // Inodos: "total used free"
  const inodesParts = (sections.INODES || '').split(' ').map(Number);
  const inodesTotal   = inodesParts[0] || 0;
  const inodesUsed    = inodesParts[1] || 0;
  const inodesPercent = inodesTotal > 0 ? Math.round((inodesUsed / inodesTotal) * 100) : 0;

  // Load averages
  const loadParts = (sections.LOAD || '').split(' ');
  const load1  = loadParts[0] || '—';
  const load5  = loadParts[1] || '—';
  const load15 = loadParts[2] || '—';

  // Uptime
  const uptime = sections.UPTIME || '—';

  // Additional info
  const pleskVersion = sections.PLESK || 'Unknown';
  const osVersion = sections.OS || 'Unknown';
  const totalDomains = parseInt(sections.DOMAINS || '0', 10) || 0;

  // Network
  const netParts = (sections.NETWORK || '').split(' ').map(Number);
  const netRxBytes = netParts[0] || 0;
  const netTxBytes = netParts[1] || 0;

  // Services
  const svcRaw = sections.SERVICES || '';
  const services = {
    nginx: 'unknown',
    apache: 'unknown',
    mysql: 'unknown',
    fail2ban: 'unknown',
  };
  
  svcRaw.split(' ').forEach(pair => {
    const [name, status] = pair.split(':');
    if (!name || !status) return;
    if (name === 'mariadb' || name === 'mysql') {
      if (status === 'active') services.mysql = 'active';
      else if (services.mysql !== 'active' && status !== 'unknown') services.mysql = status;
    }
    else if (name === 'httpd') services.apache = status;
    else if (services[name] !== undefined) services[name] = status;
  });

  return {
    ramTotalMb: ramTotal,
    ramUsedMb: ramUsed,
    ramFreeMb: ramFree,
    ramPercent,
    cpuPercent: Math.round(cpuPercent * 10) / 10,
    diskTotalMb: diskTotal,
    diskUsedMb: diskUsed,
    diskFreeMb: diskFree,
    diskPercent,
    inodesTotal,
    inodesUsed,
    inodesPercent,
    load1,
    load5,
    load15,
    uptime,
    pleskVersion,
    osVersion,
    totalDomains,
    services,
    netRxBytes,
    netTxBytes,
    timestamp: Date.now(),
  };
}

// ─── API pública ──────────────────────────────────────────────────────────────

/**
 * Obtiene métricas del servidor via SSH en una sola conexión.
 *
 * @param {import('../../services/ssh-service').SshService} sshService
 * @param {object} sshCredentials
 * @param {string} serverName - Solo para label en logs
 * @returns {Promise<ServerMetrics>}
 */
async function fetchServerMetrics(sshService, sshCredentials, serverName) {
  let client = null;
  try {
    client = await sshService.connect(sshCredentials, `metrics-${serverName}-${Date.now()}`);
    const result = await sshService.executeCommand(client, METRICS_SCRIPT);
    const raw = (result.stdout || '').trim();

    if (!raw) {
      throw new Error('El servidor no devolvió datos de métricas.');
    }

    return parseMetrics(raw);
  } finally {
    if (client) {
      try { await sshService.disconnect(client); } catch (_) { /* no crítico */ }
    }
  }
}

module.exports = { fetchServerMetrics };
