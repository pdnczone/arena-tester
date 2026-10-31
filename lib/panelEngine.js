'use strict';
// HTTP load engine against a panel: subscription fetches (end users) + admin API calls (shared sessions).
const { Agent, request } = require('undici');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const render = (s, vars) => (typeof s === 'string' ? s.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '') : s);

function jsonPath(obj, p) {
  return p.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

function joinUrl(base, p) {
  return base.replace(/\/+$/, '') + '/' + String(p || '').replace(/^\/+/, '');
}

function cookieHeader(jar) {
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

function storeCookies(jar, res) {
  let sc = res.headers['set-cookie'];
  if (!sc) return;
  if (!Array.isArray(sc)) sc = [sc];
  for (const c of sc) {
    const [kv] = c.split(';');
    const i = kv.indexOf('=');
    if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
  }
}

class PanelEngine {
  constructor(target, p, meter) {
    this.t = target;
    this.p = p;
    this.meter = meter;
    this.vus = [];
    this.seq = 0;
    this.sessions = [];
    this.agent = new Agent({
      pipelining: 1,
      keepAliveTimeout: 30000,
      headersTimeout: p.timeoutMs,
      bodyTimeout: p.timeoutMs,
      connect: { rejectUnauthorized: !target.insecureTls, timeout: p.timeoutMs },
    });
  }

  async exec(step, sess, { count } = {}) {
    const vars = sess.vars;
    const url = step.url ? render(step.url, vars) : joinUrl(this.t.panelUrl, render(step.path, vars));
    const headers = {};
    for (const [k, v] of Object.entries(step.headers || {})) headers[k.toLowerCase()] = render(v, vars);
    if (sess.jar.size) headers.cookie = cookieHeader(sess.jar);
    let body;
    if (step.form) {
      body = new URLSearchParams(Object.fromEntries(Object.entries(step.form).map(([k, v]) => [k, render(v, vars)]))).toString();
      headers['content-type'] = headers['content-type'] || 'application/x-www-form-urlencoded';
    } else if (step.json !== undefined) {
      body = render(JSON.stringify(step.json), vars);
      headers['content-type'] = headers['content-type'] || 'application/json';
    } else if (step.body) body = render(step.body, vars);

    const t0 = performance.now();
    try {
      const res = await request(url, { method: step.method || 'GET', headers, body, dispatcher: this.agent });
      const chunks = [];
      let bytes = 0;
      const keep = !!step.extract || !!step.expectBody;
      for await (const c of res.body) {
        bytes += c.length;
        if (keep) chunks.push(c);
      }
      const ms = performance.now() - t0;
      const text = keep ? Buffer.concat(chunks).toString() : '';
      let ok = (step.expect || [200]).includes(res.statusCode);
      let bodyMiss = false;
      if (ok && step.expectBody && !text.replace(/\s+/g, '').includes(String(step.expectBody).replace(/\s+/g, ''))) {
        ok = false;
        bodyMiss = true;
      }
      storeCookies(sess.jar, res);
      if (step.extract && ok) {
        try {
          const j = JSON.parse(text);
          for (const [k, p] of Object.entries(step.extract)) sess.vars[k] = jsonPath(j, p);
        } catch { /* ignore */ }
      }
      if (count !== false) {
        this.meter.addBytes(bytes);
        this.meter.rec(ok, ms, ok ? null : bodyMiss ? 'body mismatch' : 'HTTP ' + res.statusCode);
      }
      return { ok, status: res.statusCode, ms, bytes, snippet: text.slice(0, 200) };
    } catch (e) {
      const ms = performance.now() - t0;
      if (count !== false) this.meter.rec(false, ms, e.code || e.name || 'ERR');
      return { ok: false, status: 0, ms, error: e.code || e.message };
    }
  }

  async login() {
    const sess = { jar: new Map(), vars: { username: this.t.username, password: this.t.password } };
    const step = (this.t.steps || []).find((s) => s.role === 'login');
    if (!step) return sess;
    const r = await this.exec(step, sess, { count: false });
    if (!r.ok) throw new Error(`login failed (${r.status || r.error}) ${r.snippet || ''}`.trim());
    return sess;
  }

  async start() {
    const n = Math.max(1, this.p.sessions);
    for (let i = 0; i < n; i++) this.sessions.push(await this.login());
    const admin = (this.t.steps || []).filter((s) => s.role !== 'login');
    const hasSub = (this.t.subscriptionUrls || []).length > 0;
    this.mix = [];
    if (hasSub) this.mix.push({ w: admin.length ? this.p.subPct : 100, kind: 'sub' });
    admin.forEach((s) => this.mix.push({ w: (admin.length ? (100 - (hasSub ? this.p.subPct : 0)) / admin.length : 0) * (s.weight || 1), kind: 'step', step: s }));
    if (!this.mix.length) throw new Error('no scenario: add subscription URLs or admin steps');
    this.mixTotal = this.mix.reduce((a, m) => a + m.w, 0);
  }

  pick() {
    let r = Math.random() * this.mixTotal;
    for (const m of this.mix) { r -= m.w; if (r <= 0) return m; }
    return this.mix[this.mix.length - 1];
  }

  setUsers(n) {
    while (this.vus.length < n) {
      const vu = { alive: true, id: this.seq++ };
      this.vus.push(vu);
      this.loop(vu);
    }
    while (this.vus.length > n) this.vus.pop().alive = false;
  }

  users() {
    return this.vus.length;
  }

  async loop(vu) {
    await sleep(Math.random() * 800);
    // per-VU jar copy so parallel admin calls do not race on one shared cookie Map
    const base = this.sessions[vu.id % this.sessions.length];
    const sess = { jar: new Map(base.jar), vars: { ...base.vars } };
    const subs = this.t.subscriptionUrls || [];
    while (vu.alive) {
      const m = this.pick();
      if (m.kind === 'sub') {
        await this.exec({ url: subs[Math.floor(Math.random() * subs.length)], method: 'GET', expect: [200] }, { jar: new Map(), vars: {} });
      } else {
        await this.exec(m.step, sess);
      }
      await sleep(this.p.thinkMs * (0.5 + Math.random()));
    }
  }

  async stop() {
    this.vus.forEach((v) => (v.alive = false));
    this.vus = [];
    await this.agent.close().catch(() => {});
  }
}

module.exports = { PanelEngine };
