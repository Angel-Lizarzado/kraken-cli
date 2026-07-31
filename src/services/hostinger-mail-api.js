const axios = require('axios');

const PRIMARY_BASE_URL = 'https://developers.hostinger.com';
const FALLBACK_BASE_URL = 'https://api.hostinger.com';
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 KrakenOps/1.0';

/**
 * Cliente REST para la hPanel Mail API de Hostinger.
 * Docs: https://developers.hostinger.com → /api/mail/v1/
 */
class HostingerMailApi {
  constructor(apiToken) {
    this.apiToken = apiToken;
    this.baseUrl = PRIMARY_BASE_URL;
    this.createClient(this.baseUrl);
  }

  createClient(baseURL) {
    this.client = axios.create({
      baseURL,
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': DEFAULT_USER_AGENT,
      },
      timeout: 30000,
    });
  }

  /**
   * Lista todos los mail orders de la cuenta.
   * Retorna un array de orders: [{ id, domain, ... }]
   */
  async listOrders(params = { per_page: 1000 }) {
    try {
      const res = await this.client.get('/api/mail/v1/orders', { params });
      return res.data?.data || res.data || [];
    } catch (err) {
      const status = err.response?.status;
      // Si recibimos 530 u otro error de DNS/Cloudflare en la URL primaria, intentar fallback
      if ((status === 530 || !err.response) && this.baseUrl === PRIMARY_BASE_URL) {
        console.warn(`[HostingerMail] Error ${status || 'network'} en ${PRIMARY_BASE_URL}, intentando fallback a ${FALLBACK_BASE_URL}...`);
        this.baseUrl = FALLBACK_BASE_URL;
        this.createClient(this.baseUrl);
        try {
          const resFallback = await this.client.get('/api/mail/v1/orders', { params });
          return resFallback.data?.data || resFallback.data || [];
        } catch (fbErr) {
          throw new Error(`[HostingerMail] Error listando orders: ${fbErr.response?.data?.message || fbErr.message}`);
        }
      }
      throw new Error(`[HostingerMail] Error listando orders: ${err.response?.data?.message || err.message}`);
    }
  }

  /**
   * Encuentra el orderId para un dominio específico.
   * Busca en todos los orders el que contenga el dominio.
   */
  async findOrderIdForDomain(domain) {
    const normalizedDomain = domain.toLowerCase().replace(/^www\./, '').trim();

    // 1. Intentar consulta directa filtrando por el dominio específico (rápido y exacto)
    try {
      const filteredOrders = await this.listOrders({ domain: normalizedDomain, per_page: 100 });
      if (Array.isArray(filteredOrders) && filteredOrders.length > 0) {
        for (const order of filteredOrders) {
          const domainName = typeof order.domain === 'object' ? order.domain?.name : order.domain;
          const cand = (domainName || order.domain_name || order.domainName || order.name || '').toLowerCase().replace(/^www\./, '').trim();
          if (cand === normalizedDomain) {
            return order.id || order.order_id || order.orderId;
          }
        }
        if (filteredOrders[0]?.id) return filteredOrders[0].id;
      }
    } catch (_) {
      /* Continuar a búsqueda global en caché */
    }

    // 2. Fallback: Cargar todos los orders con per_page=1000 (abarcando toda la flota)
    if (!this.cachedOrders) {
      try {
        this.cachedOrders = await this.listOrders({ per_page: 1000 });
      } catch (_) {
        this.cachedOrders = [];
      }
    }

    const orders = this.cachedOrders;
    if (!Array.isArray(orders) || orders.length === 0) {
      return null;
    }

    for (const order of orders) {
      // domain puede ser un objeto { id, name } o un string directo
      const domainName = typeof order.domain === 'object' ? order.domain?.name : order.domain;
      const candidates = [
        domainName,
        order.domain_name,
        order.domainName,
        order.name,
        order.title,
      ].filter(Boolean);

      for (const cand of candidates) {
        if (typeof cand === 'string' && cand.toLowerCase().replace(/^www\./, '').trim() === normalizedDomain) {
          return order.id || order.order_id || order.orderId;
        }
      }

      if (Array.isArray(order.domains)) {
        const found = order.domains.find(d => {
          const domStr = typeof d === 'string' ? d : (d.domain?.name || d.domain || d.domain_name || d.name || '');
          return domStr.toLowerCase().replace(/^www\./, '').trim() === normalizedDomain;
        });
        if (found) return order.id || order.order_id || order.orderId;
      }
    }
    return null;
  }

  /**
   * Lista todos los mailboxes de un mail order.
   * Retorna: [{ id, address, ... }]
   */
  async listMailboxes(orderId) {
    try {
      const res = await this.client.get(`/api/mail/v1/orders/${orderId}/mailboxes`);
      return res.data?.data || res.data || [];
    } catch (err) {
      throw new Error(`[HostingerMail] Error listando mailboxes (order ${orderId}): ${err.response?.data?.message || err.message}`);
    }
  }

  /**
   * Lista los mailboxes de un dominio directamente.
   * Combina findOrderIdForDomain + listMailboxes.
   * Retorna: [{ id, address }] o [] si el dominio no tiene email.
   */
  async listMailboxesForDomain(domain) {
    const orderId = await this.findOrderIdForDomain(domain);
    if (!orderId) {
      return [];
    }
    const mailboxes = await this.listMailboxes(orderId);
    return mailboxes.map(mb => ({
      id: mb.id,
      address: mb.address || mb.email || mb.username,
      orderId,
    }));
  }

  /**
   * Resetea la contraseña de un mailbox.
   * @param {string} mailboxId
   * @param {string} newPassword
   */
  async resetMailboxPassword(mailboxId, newPassword) {
    try {
      await this.client.patch(`/api/mail/v1/mailboxes/${mailboxId}/password`, {
        password: newPassword,
      });
      return true;
    } catch (err) {
      throw new Error(`[HostingerMail] Error reseteando contraseña del mailbox ${mailboxId}: ${err.response?.data?.message || err.message}`);
    }
  }

  /**
   * Genera una contraseña temporal segura.
   */
  generateTempPassword() {
    const { randomBytes } = require('crypto');
    // 16 bytes → 22 chars base64url, siempre cumple requisitos mínimos
    const base = randomBytes(16).toString('base64').replace(/[+/=]/g, '');
    // Hostinger requiere mayúscula, minúscula, número y símbolo
    return `Krk${base.slice(0, 10)}7!`;
  }
}

module.exports = { HostingerMailApi };
