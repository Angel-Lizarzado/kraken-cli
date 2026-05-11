// Health Check Service — Mass domain health scanner
// Concurrency-controlled HTTP HEAD requests with configurable parallelism.
// Uses native Node.js https/http modules — zero external dependencies.

const https = require('https');
const http  = require('http');
const { URL } = require('url');

// ── Constants ──

const MAX_CONCURRENCY = 15;
const TIMEOUT_MS      = 15000;
const USER_AGENT      = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// DNS error codes that indicate the domain doesn't resolve
const DNS_ERROR_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'EAI_FAIL',
  'EAI_NODATA',
  'EAI_NONAME',
]);

// ── Semaphore for controlled concurrency ──

class Semaphore {
  constructor(max) {
    this.max = max;
    this.current = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    return new Promise(resolve => this.queue.push(resolve));
  }

  release() {
    this.current--;
    if (this.queue.length > 0) {
      this.current++;
      const next = this.queue.shift();
      next();
    }
  }
}

/**
 * Check a single domain's health via HTTP HEAD.
 * Attempts HTTPS first; falls back to HTTP on connection refusal.
 * @param {string} domain - Domain name (without protocol)
 * @returns {Promise<{domain: string, status: string, code: number|null, message: string, time: number}>}
 */
function checkDomain(domain) {
  return new Promise(resolve => {
    const start = Date.now();

    const tryRequest = (protocol, url) => {
      const mod = protocol === 'https:' ? https : http;
      const parsedUrl = new URL(url);

      const req = mod.request(
        {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || (protocol === 'https:' ? 443 : 80),
          path: parsedUrl.pathname,
          method: 'HEAD',
          timeout: TIMEOUT_MS,
          headers: { 'User-Agent': USER_AGENT },
          // Don't reject self-signed certs (many Plesk servers use them)
          rejectUnauthorized: false,
        },
        (res) => {
          const code = res.statusCode;
          const elapsed = Date.now() - start;

          // Consume response to free socket
          res.resume();

          let status = 'ok';
          if (code >= 500)      status = 'error';
          else if (code >= 400) status = 'warning';
          else if (code >= 300) status = 'redirect';

          resolve({
            domain,
            status,
            code,
            message: `${code} ${res.statusMessage || ''}`.trim(),
            time: elapsed,
          });
        },
      );

      req.on('timeout', () => {
        req.destroy();
        resolve({
          domain,
          status: 'error',
          code: null,
          message: 'Timeout (>15s)',
          time: Date.now() - start,
        });
      });

      req.on('error', (err) => {
        const elapsed = Date.now() - start;
        const errCode = err.code || '';

        // DNS resolution failure
        if (DNS_ERROR_CODES.has(errCode)) {
          resolve({
            domain,
            status: 'dns',
            code: null,
            message: `DNS: ${errCode}`,
            time: elapsed,
          });
          return;
        }

        // HTTPS refused → fallback to HTTP (only once)
        if (protocol === 'https:' && (errCode === 'ECONNREFUSED' || errCode === 'ECONNRESET')) {
          tryRequest('http:', `http://${domain}`);
          return;
        }

        resolve({
          domain,
          status: 'error',
          code: null,
          message: err.message || 'Error de conexión',
          time: elapsed,
        });
      });

      req.end();
    };

    // Start with HTTPS
    tryRequest('https:', `https://${domain}`);
  });
}

/**
 * Run mass health check on an array of domains.
 * @param {string[]} domains - List of domain names
 * @param {object} options
 * @param {(progress: {current: number, total: number, domain: string, result: object}) => void} options.onProgress
 * @param {AbortSignal} [options.signal] - AbortSignal to cancel the scan
 * @returns {Promise<object[]>} Array of results
 */
async function runHealthCheck(domains, { onProgress, signal } = {}) {
  const semaphore = new Semaphore(MAX_CONCURRENCY);
  const results = [];
  let completed = 0;

  const tasks = domains.map(async (domain) => {
    // Check cancellation before acquiring semaphore
    if (signal?.aborted) return null;

    await semaphore.acquire();
    try {
      // Check cancellation again after acquiring
      if (signal?.aborted) return null;

      const result = await checkDomain(domain);
      completed++;
      results.push(result);

      if (onProgress) {
        onProgress({
          current: completed,
          total: domains.length,
          domain,
          result,
        });
      }

      return result;
    } finally {
      semaphore.release();
    }
  });

  await Promise.allSettled(tasks);
  return results;
}

module.exports = { runHealthCheck, checkDomain };
