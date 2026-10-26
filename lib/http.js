'use strict';
// Tiny cookie-aware HTTP client used by the panel drivers.
const { Agent, request } = require('undici');

class HttpSession {
  constructor({ base, insecure = false, timeoutMs = 20000, headers = {} }) {
    this.base = String(base || '').replace(/\/+$/, '');
    this.headers = headers;
    this.jar = new Map();
    this.agent = new Agent({
      connect: { rejectUnauthorized: !insecure, timeout: timeoutMs },
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });
  }

  async req(method, path, { form, json, headers = {} } = {}) {
    if (!this.base) throw new Error('panel URL is empty');
    const h = { ...this.headers, ...headers };
    let body;
    if (form) {
      body = new URLSearchParams(form).toString();
      h['content-type'] = 'application/x-www-form-urlencoded';
    } else if (json !== undefined) {
      body = JSON.stringify(json);
      h['content-type'] = 'application/json';
    }
    if (this.jar.size) h.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    h.accept = 'application/json, text/plain, */*';
    const res = await request(this.base + path, { method, headers: h, body, dispatcher: this.agent });
    const text = await res.body.text();
    let sc = res.headers['set-cookie'];
    if (sc) {
      if (!Array.isArray(sc)) sc = [sc];
      for (const c of sc) {
        const [kv] = c.split(';');
        const i = kv.indexOf('=');
        if (i > 0) this.jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
      }
    }
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.statusCode, json: parsed, text, headers: res.headers };
  }

  close() {
    return this.agent.close().catch(() => {});
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (n = 8) => require('crypto').randomBytes(n).toString('hex').slice(0, n);

module.exports = { HttpSession, sleep, rand };
