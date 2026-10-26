'use strict';
// 3x-ui panel driver (MHSanaei/3x-ui). Endpoint paths differ a little between versions, so every
// call tries the known variants in order. Everything it creates is tagged "arena-test".
const crypto = require('crypto');
const { HttpSession, rand } = require('../http');

const TAG = 'arena-test';
const uuid = () => crypto.randomUUID();
const b64 = (s) => Buffer.from(s).toString('base64');

class ThreeXUI {
  constructor(t) {
    this.t = t;
    this.s = new HttpSession({ base: t.panelUrl, insecure: t.insecureTls });
    this.logged = false;
  }

  host() {
    return new URL(this.t.panelUrl).hostname;
  }

  async login() {
    const r = await this.s.req('POST', '/login', { form: { username: this.t.username, password: this.t.password } });
    if (r.status !== 200 || !r.json || !r.json.success) {
      throw new Error(`login failed (HTTP ${r.status}${r.json && r.json.msg ? ': ' + r.json.msg : ''}) — check URL (incl. secret path), username and password`);
    }
    this.logged = true;
  }

  async ensure() {
    if (!this.logged) await this.login();
  }

  // Try each {m, p} until one does not answer 404. A 404 after login means "no such route in this version".
  async api(variants, opts) {
    await this.ensure();
    for (let attempt = 0; attempt < 2; attempt++) {
      let allMissing = true;
      for (const v of variants) {
        const r = await this.s.req(v.m, v.p, opts);
        if (r.status !== 404) return r;
        allMissing = allMissing && true;
      }
      if (allMissing && attempt === 0) { this.logged = false; await this.login(); continue; } // session may have expired (3x-ui answers 404 when logged out)
    }
    throw new Error(`endpoint not found: ${variants[0].p} — this 3x-ui version is not supported by the driver`);
  }

  async listInbounds() {
    const r = await this.api([{ m: 'GET', p: '/panel/api/inbounds/list' }, { m: 'POST', p: '/panel/inbound/list' }]);
    if (!r.json || r.json.success === false) throw new Error('could not list inbounds: ' + (r.json && r.json.msg));
    return r.json.obj || [];
  }

  async status() {
    const r = await this.api([
      { m: 'GET', p: '/panel/api/server/status' },
      { m: 'POST', p: '/server/status' },
      { m: 'POST', p: '/panel/api/server/status' },
    ]);
    const o = r.json && r.json.obj;
    if (!o) throw new Error('status endpoint returned no data');
    const mem = o.mem || {};
    const net = o.netIO || {};
    return {
      cpu: typeof o.cpu === 'number' ? Math.round(o.cpu * 10) / 10 : null,
      cores: o.logicalPro || o.cpuCores || null,
      memPct: mem.total ? Math.round((mem.current / mem.total) * 1000) / 10 : null,
      memUsedMB: mem.total ? Math.round(mem.current / 1048576) : null,
      memTotalMB: mem.total ? Math.round(mem.total / 1048576) : null,
      rx: net.down != null ? Math.round(((net.down * 8) / 1e6) * 100) / 100 : null,
      tx: net.up != null ? Math.round(((net.up * 8) / 1e6) * 100) / 100 : null,
      tcp: o.tcpCount ?? null,
      load: Array.isArray(o.loads) ? o.loads[0] : null,
      panelMem: o.appStats && o.appStats.mem ? Math.round(o.appStats.mem / 1048576) : null,
      xray: o.xray ? o.xray.state : null,
      version: o.xray ? o.xray.version : null,
    };
  }

  async removeTestInbounds() {
    const found = (await this.listInbounds()).filter((i) => String(i.remark || '').startsWith(TAG));
    for (const i of found) {
      await this.api([{ m: 'POST', p: `/panel/api/inbounds/del/${i.id}` }, { m: 'POST', p: `/panel/inbound/del/${i.id}` }]);
    }
    return found.length;
  }

  // spec: { count, protocol: 'vless'|'vmess'|'trojan'|'shadowsocks', port }
  async provision(spec) {
    const count = Math.max(1, Math.min(2000, Number(spec.count) || 200));
    const protocol = ['vless', 'vmess', 'trojan', 'shadowsocks'].includes(spec.protocol) ? spec.protocol : 'vless';
    await this.removeTestInbounds();
    const used = new Set((await this.listInbounds()).map((i) => Number(i.port)));
    let port = Number(spec.port) || 24443;
    for (let k = 0; used.has(port) && k < 200; k++) port++;
    if (used.has(port)) throw new Error('no free port for the test inbound');

    const mk = (i) => {
      const email = `${TAG}-${rand(6)}-${String(i + 1).padStart(4, '0')}`;
      const base = { limitIp: 0, totalGB: 0, expiryTime: 0, enable: true, tgId: '', subId: rand(16), comment: '', reset: 0, email };
      if (protocol === 'vless') return { ...base, id: uuid(), flow: '' };
      if (protocol === 'vmess') return { ...base, id: uuid(), security: 'auto' };
      if (protocol === 'trojan') return { ...base, password: rand(12) };
      return { ...base, method: '', password: rand(16) };
    };
    const clients = Array.from({ length: count }, (_, i) => mk(i));
    let settings;
    if (protocol === 'vless') settings = { clients, decryption: 'none', fallbacks: [] };
    else if (protocol === 'vmess') settings = { clients };
    else if (protocol === 'trojan') settings = { clients, fallbacks: [] };
    else settings = { method: 'chacha20-ietf-poly1305', password: rand(16), network: 'tcp,udp', clients };

    const form = {
      up: '0', down: '0', total: '0', remark: TAG, enable: 'true', expiryTime: '0', listen: '', port: String(port), protocol,
      settings: JSON.stringify(settings),
      streamSettings: JSON.stringify({ network: 'tcp', security: 'none', externalProxy: [], tcpSettings: { acceptProxyProtocol: false, header: { type: 'none' } } }),
      sniffing: JSON.stringify({ enabled: false, destOverride: ['http', 'tls', 'quic', 'fakedns'], metadataOnly: false, routeOnly: false }),
      allocate: JSON.stringify({ strategy: 'always', refresh: 5, concurrency: 3 }),
    };
    const r = await this.api([{ m: 'POST', p: '/panel/api/inbounds/add' }, { m: 'POST', p: '/panel/inbound/add' }], { form });
    if (!r.json || !r.json.success) throw new Error('inbound was rejected by the panel: ' + ((r.json && r.json.msg) || `HTTP ${r.status}`));
    const inboundId = r.json.obj && r.json.obj.id;

    const h = this.host();
    const links = clients.map((c) => {
      if (protocol === 'vless') return `vless://${c.id}@${h}:${port}?type=tcp&security=none&encryption=none#${c.email}`;
      if (protocol === 'vmess') return 'vmess://' + b64(JSON.stringify({ v: '2', ps: c.email, add: h, port: String(port), id: c.id, aid: '0', scy: 'auto', net: 'tcp', type: 'none', host: '', path: '', tls: '' }));
      if (protocol === 'trojan') return `trojan://${c.password}@${h}:${port}?type=tcp&security=none#${c.email}`;
      return `ss://${b64(`chacha20-ietf-poly1305:${settings.password}:${c.password}`)}@${h}:${port}#${c.email}`;
    });

    let subscriptionUrls = [];
    let note = '';
    try {
      const sr = await this.api([{ m: 'POST', p: '/panel/setting/all' }, { m: 'GET', p: '/panel/setting/all' }]);
      const o = sr.json && sr.json.obj;
      if (o && o.subEnable) {
        const scheme = o.subCertFile ? 'https' : 'http';
        const sh = o.subDomain || h;
        subscriptionUrls = clients.slice(0, 100).map((c) => `${scheme}://${sh}:${o.subPort}${o.subPath || '/sub/'}${c.subId}`);
      } else note = 'subscription service is disabled in the panel, so the HTTP test will use admin API calls only';
    } catch (e) { note = 'could not read subscription settings: ' + e.message; }

    return { links, subscriptionUrls, note, meta: { driver: '3xui', inboundId, port, protocol, count, at: Date.now() } };
  }

  async deprovision() {
    const n = await this.removeTestInbounds();
    return { removed: n };
  }

  close() { return this.s.close(); }
}

module.exports = { ThreeXUI };
