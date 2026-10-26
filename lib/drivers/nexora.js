'use strict';
// Nexora panel driver, written from Nexora's public OpenAPI description (docs.nexora-panel.org):
//   auth    POST /api/login {username,password} -> cookie "nexora_session"   or   Authorization: Bearer <API token>
//   users   POST /api/v1/users/generate {count,pattern,...} (max 500/call), POST /api/v1/users/bulk/delete {ids}
//   info    GET  /api/panel/info, GET /api/v1/inbounds
//   nodes   GET  /api/v1/nodes (live host stats, cumulative up/down bytes), GET /api/nodes/{id}/info (num_cpu)
// Users get every template (allTemplates). An inbound only serves traffic when a template carries it AND a
// connected node runs that template, so this must be set up once in the panel UI (the inbound config keys are not
// part of Nexora's public docs, which is why the driver does not create inbounds itself).
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

  async nodes() {
    const r = await this.call('GET', '/api/v1/nodes?limit=1000');
    if (r.status !== 200) return [];
    return Array.isArray(r.json) ? r.json : (r.json && r.json.items) || [];
  }

  // The machine that carries the traffic is the node, so its host stats are what we want. CPU % is not exposed by
  // Nexora (only load average), and throughput is derived from the node's cumulative up/down byte counters.
  async status() {
    const nodes = await this.nodes();
    const n = nodes.find((x) => x.enabled !== false && x.status === 'connected' && x.live && x.live.host) || nodes.find((x) => x.live && x.live.host);
    if (n) {
      const h = n.live.host;
      if (!this.cores || this.coresNode !== n.id) {
        const ir = await this.call('GET', `/api/nodes/${n.id}/info`).catch(() => null);
        this.cores = (ir && ir.json && ir.json.num_cpu) || null;
        this.coresNode = n.id;
      }
      const now = Date.now();
      let rx = null;
      let tx = null;
      if (this.prev && this.prev.id === n.id && now > this.prev.at) {
        const dt = (now - this.prev.at) / 1000;
        rx = Math.round((((n.down - this.prev.down) * 8) / dt / 1e6) * 100) / 100;
        tx = Math.round((((n.up - this.prev.up) * 8) / dt / 1e6) * 100) / 100;
      }
      this.prev = { id: n.id, at: now, up: n.up, down: n.down };
      return {
        cpu: this.cores && h.load1 != null ? Math.min(100, Math.round((h.load1 / this.cores) * 1000) / 10) : null, // approximation from load average
        cores: this.cores,
        memPct: h.memTotal ? Math.round((h.memUsed / h.memTotal) * 1000) / 10 : null,
        memUsedMB: h.memTotal ? Math.round(h.memUsed / 1048576) : null,
        memTotalMB: h.memTotal ? Math.round(h.memTotal / 1048576) : null,
        rx, tx, tcp: n.live.connections ?? null, load: h.load1 ?? null, node: n.name, nodeStatus: n.status, version: n.coreVersion || null,
      };
    }
    // no node reporting: fall back to the panel machine (needs an admin/sudo account or token)
    const r = await this.call('GET', '/api/panel/info');
    if (r.status !== 200 || !r.json) throw new Error(`status unavailable (HTTP ${r.status}) — the account/token needs admin rights (nodes:read / sudo)`);
    const o = r.json;
    const cores = o.num_cpu || null;
    const total = o.sys_mem_total || 0;
    return {
      cpu: cores && o.load_avg_1 != null ? Math.min(100, Math.round((o.load_avg_1 / cores) * 1000) / 10) : null,
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
    const nodes = await this.nodes();
    const live = nodes.filter((n) => n.status === 'connected' && n.templateId != null);
    if (!live.length) throw new Error(nodes.length
      ? 'no connected Nexora node runs a template yet — in the panel: put the inbound in a template and assign that template to the node'
      : 'Nexora has no node yet — add a node (or the local node) and give it a template that contains the inbound');
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
    const subscriptionUrls = created.map((u) => u.subUrl).filter(Boolean).map((u) => u + (u.includes('?') ? '&' : '?') + 'format=plain');
    return {
      links: [],
      subscriptionUrls,
      note: subscriptionUrls.length ? '' : 'users were created but the panel returned no subUrl; open a user in the panel and check the subscription settings',
      meta: { driver: 'nexora', ids: created.map((u) => u.id).filter((x) => x != null), count: created.length, inbounds: ib.length, nodes: live.length, at: Date.now() },
    };
  }

  async deprovision() {
    const ids = (this.t.provision && this.t.provision.ids) || [];
    return { removed: ids.length ? await this.removeTestUsers(ids) : 0 };
  }

  close() { return this.s.close(); }
}

module.exports = { Nexora };
