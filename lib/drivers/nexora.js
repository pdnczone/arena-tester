'use strict';
// Nexora panel driver, written from Nexora's public OpenAPI description (docs.nexora-panel.org):
//   auth    POST /api/login {username,password} -> cookie "nexora_session"   or   Authorization: Bearer <API token>
//   users   POST /api/v1/users/generate {count,pattern,...} (max 500/call), POST /api/v1/users/bulk/delete {ids}
//   info    GET  /api/panel/info, GET /api/v1/inbounds
// Users get the panel's existing inbounds (allTemplates), so create the inbound once in the panel UI.
const { HttpSession, rand } = require('../http');

const PREFIX = 'arena-test';

class Nexora {
  constructor(t) {
    this.t = t;
    this.s = new HttpSession({ base: t.panelUrl, insecure: t.insecureTls, headers: t.apiToken ? { authorization: 'Bearer ' + t.apiToken } : {} });
    this.logged = !!t.apiToken;
  }

  async login() {
    if (this.t.apiToken) { this.logged = true; return; }
    const r = await this.s.req('POST', '/api/login', { json: { username: this.t.username, password: this.t.password } });
    if (r.status !== 200) throw new Error(`login failed (HTTP ${r.status}${r.json && r.json.error ? ': ' + r.json.error : ''}) — check URL (incl. base path), username and password, or use an API token`);
    if (r.json && r.json.pending) throw new Error('this account needs 2FA — create an API token (Settings → Tokens) with users:read/users:write and paste it instead of a password');
    this.logged = true;
  }

  async ensure() {
    if (!this.logged) await this.login();
  }

  async call(method, path, opts) {
    await this.ensure();
    let r = await this.s.req(method, path, opts);
    if ((r.status === 401 || r.status === 403) && !this.t.apiToken) { await this.login(); r = await this.s.req(method, path, opts); }
    if (r.status === 429) throw new Error('rate limited by the panel (429) — wait a minute or raise the token rate limit');
    return r;
  }

  async status() {
    const r = await this.call('GET', '/api/panel/info');
    if (r.status !== 200 || !r.json) throw new Error(`status unavailable (HTTP ${r.status}) — the account/token needs admin (sudo) rights for /api/panel/info`);
    const o = r.json;
    const cores = o.num_cpu || null;
    const total = o.sys_mem_total || 0;
    return {
      cpu: cores && o.load_avg_1 != null ? Math.min(100, Math.round((o.load_avg_1 / cores) * 1000) / 10) : null, // approximation from load average
      cores,
      memPct: total ? Math.round((o.sys_mem_used / total) * 1000) / 10 : null,
      memUsedMB: total ? Math.round(o.sys_mem_used / 1048576) : null,
      memTotalMB: total ? Math.round(total / 1048576) : null,
      rx: null, tx: null, tcp: null, load: o.load_avg_1 ?? null,
      panelMem: o.mem_sys ? Math.round(o.mem_sys / 1048576) : null,
      version: o.version || null,
    };
  }

  async inbounds() {
    const r = await this.call('GET', '/api/v1/inbounds?limit=1000');
    if (r.status !== 200) throw new Error(`could not list inbounds (HTTP ${r.status})`);
    return Array.isArray(r.json) ? r.json : (r.json && r.json.items) || [];
  }

  async removeTestUsers(ids) {
    let removed = 0;
    for (let i = 0; i < ids.length; i += 1000) {
      const r = await this.call('POST', '/api/v1/users/bulk/delete', { json: { ids: ids.slice(i, i + 1000) } });
      if (r.status === 200 && r.json && r.json.affected != null) removed += r.json.affected;
    }
    return removed;
  }

  // spec: { count }
  async provision(spec) {
    const count = Math.max(1, Math.min(2000, Number(spec.count) || 200));
    const ib = await this.inbounds();
    if (!ib.length) throw new Error('Nexora has no inbound yet — create one inbound (e.g. VLESS + TCP) in the panel once, then run this again');
    if (this.t.provision && this.t.provision.ids && this.t.provision.ids.length) await this.removeTestUsers(this.t.provision.ids).catch(() => {});

    const run = rand(4);
    const created = [];
    for (let done = 0; done < count; done += 500) {
      const n = Math.min(500, count - done);
      const r = await this.call('POST', '/api/v1/users/generate', {
        json: { count: n, pattern: `${PREFIX}-${run}-{nnn}`, start: done, enable: true, allTemplates: true, volume: 0, expiry: 0, desc: 'created by arena-tester' },
      });
      if (r.status === 402) throw new Error('user limit of your Nexora licence reached (free tier: 25 users) — lower the user count');
      if (r.status !== 200 || !r.json) throw new Error(`user creation failed (HTTP ${r.status}${r.json && r.json.error ? ': ' + r.json.error : ''})`);
      created.push(...(r.json.created || []));
      if (r.json.error) throw new Error(r.json.error);
    }
    if (!created.length) throw new Error('the panel created no users');
    const subscriptionUrls = created.map((u) => u.subUrl).filter(Boolean);
    return {
      links: [],
      subscriptionUrls,
      note: subscriptionUrls.length ? '' : 'users were created but the panel returned no subUrl; open a user in the panel and check the subscription settings',
      meta: { driver: 'nexora', ids: created.map((u) => u.id).filter((x) => x != null), count: created.length, inbounds: ib.length, at: Date.now() },
    };
  }

  async deprovision() {
    const ids = (this.t.provision && this.t.provision.ids) || [];
    return { removed: ids.length ? await this.removeTestUsers(ids) : 0 };
  }

  close() { return this.s.close(); }
}

module.exports = { Nexora };
