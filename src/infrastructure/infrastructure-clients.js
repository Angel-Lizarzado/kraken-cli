// Use global fetch provided by Node 18 / Electron 28

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function withRetry(fn, label, retries = 2, delayMs = 1500) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      console.log(`[TRACE] withRetry ${label} intento ${attempt}`);
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        console.warn(`[retry] ${label} intento ${attempt + 1} falló: ${error.message}`);
        await sleep(delayMs * (attempt + 1));
      }
    }
  }

  throw lastError;
}

class CloudflareClient {
  constructor(config) {
    this.baseUrl = config.baseUrl;
    this.apiToken = config.apiToken;
    this.accountId = config.accountId;
    this.timeoutMs = config.timeoutMs;
  }

  get headers() {
    return {
      'Authorization': `Bearer ${this.apiToken}`,
      'Content-Type': 'application/json',
    };
  }

  async listZonesByName(domain) {
    const url = new URL(`${this.baseUrl}/zones`);
    url.searchParams.set('name', domain);
    url.searchParams.set('status', 'active,pending,initializing,moved');
    url.searchParams.set('page', '1');
    url.searchParams.set('per_page', '50');
    url.searchParams.set('match', 'all');

    const response = await requestWithTimeout(url.toString(), {
      method: 'GET',
      headers: this.headers,
    }, this.timeoutMs);

    const data = await response.json();

    if (!response.ok || !data.success) {
      throw new Error(`Cloudflare listZones error: ${JSON.stringify(data.errors || data)}`);
    }

    return data.result || [];
  }

  async getZone(domain) {
    const zones = await this.listZonesByName(domain);
    return zones.find(z => z.name?.toLowerCase() === domain.toLowerCase()) || null;
  }

  async createZone(domain) {
    if (!this.accountId) {
      throw new Error("Missing Cloudflare Account ID to create a new zone.");
    }
    const payload = {
      account: { id: this.accountId },
      name: domain,
      type: 'full',
    };

    const response = await requestWithTimeout(`${this.baseUrl}/zones`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(payload),
    }, this.timeoutMs);

    const data = await response.json();

    if (!response.ok || !data.success) {
      throw new Error(`Cloudflare createZone error: ${JSON.stringify(data.errors || data)}`);
    }

    return data.result;
  }

  async ensureZone(domain) {
    const existing = await this.getZone(domain);
    if (existing) {
      return {
        created: false,
        zone: existing,
        nameservers: existing.name_servers || [],
      };
    }

    const created = await this.createZone(domain);
    return {
      created: true,
      zone: created,
      nameservers: created.name_servers || [],
    };
  }
}

module.exports = {
  CloudflareClient,
  withRetry,
  requestWithTimeout
};
