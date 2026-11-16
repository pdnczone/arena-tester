'use strict';
// Tiny cookie-aware HTTP client used by the panel drivers.
const { Agent, request } = require('undici');

// Panels sit behind nginx/Cloudflare/ArvanCloud-style WAFs that answer 403 to clients without a browser-like
// User-Agent (undici sends none). Send what a browser sends; callers may still override any of it.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const browserHeaders = (base) => {
  let origin = '';
  try { origin = new URL(base).origin; } catch { /* bad URL is reported elsewhere */ }
  return { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9', 'x-requested-with': 'XMLHttpRequest', ...(origin ? { origin, referer: base + '/' } : {}) };
};
// People paste the login/dashboard address: keep only the secret base path.
const cleanBase = (u) => String(u || '').trim().replace(/[?#].*$/, '').replace(/\/(login|panel(\/.*)?)\/*$/i, '').replace(/\/+$/, '');

class HttpSession {
  constructor({ base, insecure = false, timeoutMs = 20000, headers = {} }) {
    this.base = cleanBase(base);
    this.headers = { ...browserHeaders(this.base), ...headers };
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

// Short human description of a failed response (who answered, and what they said), e.g. for a 403 page.
const blame = (r) => {
  const srv = r.headers && (r.headers.server || (r.headers['cf-ray'] ? 'cloudflare' : ''));
  const body = String(r.text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  return [srv && `server: ${srv}`, body && `"${body}"`].filter(Boolean).join(', ');
};

module.exports = { HttpSession, sleep, rand, browserHeaders, cleanBase, blame };
