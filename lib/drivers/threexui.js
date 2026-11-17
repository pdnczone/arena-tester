'use strict';
// 3x-ui panel driver (MHSanaei/3x-ui). Endpoint paths differ a little between versions, so every
// call tries the known variants in order. Everything it creates is tagged "arena-test".
const crypto = require('crypto');
const { HttpSession, rand, blame } = require('../http');

const TAG = 'arena-test';
const uuid = () => crypto.randomUUID();
const b64 = (s) => Buffer.from(s).toString('base64');
// REALITY needs an x25519 key pair; Xray uses unpadded base64url of the raw 32-byte keys (= JWK d / x).
const x25519 = () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
  return { priv: privateKey.export({ format: 'jwk' }).d, pub: publicKey.export({ format: 'jwk' }).x };
};
// The site REALITY borrows its TLS handshake from: must be reachable from the panel server over 443.
const REALITY_SNI = 'www.microsoft.com';
// where the server forwards the REALITY handshake to; override (host:port) for a lab without fast internet
const REALITY_TARGET = process.env.REALITY_TARGET || `${REALITY_SNI}:443`;

function makeClient(ctx, i) {
  const email = `${TAG}-${ctx.runTag}-${String(i + 1).padStart(4, '0')}`;
  const base = { limitIp: 0, totalGB: 0, expiryTime: 0, enable: true, tgId: ctx.v3 ? 0 : '', subId: rand(16), comment: '', reset: 0, email };
  if (ctx.protocol === 'vless') return { ...base, id: uuid(), flow: ctx.rk ? 'xtls-rprx-vision' : '' };
  if (ctx.protocol === 'vmess') return { ...base, id: uuid(), security: 'auto' };
  if (ctx.protocol === 'trojan') return { ...base, password: rand(12) };
  return { ...base, method: '', password: rand(16) };
}

function linkFor(ctx, c) {
  const { host: h, port, rk } = ctx;
  if (rk) return `vless://${c.id}@${h}:${port}?type=tcp&security=reality&encryption=none&flow=xtls-rprx-vision&sni=${REALITY_SNI}&fp=chrome&pbk=${rk.pub}&sid=${rk.sid}&spx=%2F#${c.email}`;
  if (ctx.protocol === 'vless') return `vless://${c.id}@${h}:${port}?type=tcp&security=none&encryption=none#${c.email}`;
  if (ctx.protocol === 'vmess') return 'vmess://' + b64(JSON.stringify({ v: '2', ps: c.email, add: h, port: String(port), id: c.id, aid: '0', scy: 'auto', net: 'tcp', type: 'none', host: '', path: '', tls: '' }));
  if (ctx.protocol === 'trojan') return `trojan://${c.password}@${h}:${port}?type=tcp&security=none#${c.email}`;
  return `ss://${b64(`chacha20-ietf-poly1305:${c.password}`)}@${h}:${port}#${c.email}`;
}

class ThreeXUI {
  constructor(t) {
    this.t = t;
    this.s = new HttpSession({ base: t.panelUrl, insecure: t.insecureTls });
    this.logged = false;
  }

  host() {
    const override = String(this.t.inboundHost || '').trim();
    if (override) return override.replace(/^\[|\]$/g, '');
    return new URL(this.t.panelUrl).hostname;
  }

  async login() {
    // load the login page first: it sets the session cookie and the CSRF token (3x-ui 3.x)
    await this.s.req('GET', '/').catch(() => {});
    const r = await this.s.req('POST', '/login', { form: { username: this.t.username, password: this.t.password } });
    if (r.status !== 200 || !r.json || !r.json.success) {
      const why = r.json && r.json.msg ? ': ' + r.json.msg : r.status >= 400 || !r.json ? ` (${blame(r)})` : '';
      const hint = r.status === 403 ? ' — blocked by a firewall/WAF or the panel IP allow-list: allow this machine\'s IP' : r.status === 404 ? ' — wrong secret path in the URL' : ' — check URL (incl. secret path), username and password';
      throw new Error(`login failed (HTTP ${r.status}${why})${hint}`);
    }
    // the session (and with it the CSRF token) is renewed on login: pick up the new token
    await this.s.req('GET', '/panel/').catch(() => {});
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
        if (r.status !== 404 && r.status !== 403) return r;
        allMissing = allMissing && true;
      }
      if (allMissing && attempt === 0) { this.logged = false; await this.login(); continue; } // session/CSRF may have expired (3x-ui answers 404 or 403)
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

  // 3x-ui 3.x keeps users in their own "clients" table (linked to inbounds). Users embedded in an inbound's settings
  // are served until the next restart and then dropped, so on 3.x they must be created through the clients API.
  async isV3() {
    if (this.v3 === undefined) {
      await this.ensure();
      const r = await this.s.req('GET', '/panel/api/clients/list').catch(() => null);
      this.v3 = !!(r && r.status === 200 && r.json && r.json.success && Array.isArray(r.json.obj));
    }
    return this.v3;
  }

  async removeTestInbounds() {
    const found = (await this.listInbounds()).filter((i) => String(i.remark || '').startsWith(TAG));
    for (const i of found) {
      await this.api([{ m: 'POST', p: `/panel/api/inbounds/del/${i.id}` }, { m: 'POST', p: `/panel/inbound/del/${i.id}` }]);
    }
    if (await this.isV3()) {
      // only our own tagged users: never "delete orphans", which would also remove the admin's detached users
      const r = await this.s.req('GET', '/panel/api/clients/list');
      const emails = ((r.json && r.json.obj) || []).map((c) => String(c.email || '')).filter((e) => e.startsWith(TAG + '-'));
      for (let i = 0; i < emails.length; i += 500) await this.s.req('POST', '/panel/api/clients/bulkDel', { json: { emails: emails.slice(i, i + 500) } });
    }
    return found.length;
  }

  // spec: { count, protocol: 'reality'|'vless'|'vmess'|'trojan'|'shadowsocks', port }
  // 'reality' = VLESS + REALITY + XTLS Vision over TCP: what most real users run, and needs no certificate.
  // Plain 'vless' (no TLS) is refused by Xray 26+ clients for public addresses.
  async provision(spec) {
    const count = Math.max(1, Math.min(2000, Number(spec.count) || 200));
    const kind = ['reality', 'vless', 'vmess', 'trojan', 'shadowsocks'].includes(spec.protocol) ? spec.protocol : 'reality';
    const protocol = kind === 'reality' ? 'vless' : kind;
    const rk = kind === 'reality' ? { ...x25519(), sid: crypto.randomBytes(8).toString('hex') } : null;
    const v3 = await this.isV3();
    await this.removeTestInbounds();
    const used = new Set((await this.listInbounds()).map((i) => Number(i.port)));
    let port = Number(spec.port) || 24443;
    for (let k = 0; used.has(port) && k < 200; k++) port++;
    if (used.has(port)) throw new Error('no free port for the test inbound');

    const mk = (i) => {
      const email = `${TAG}-${rand(6)}-${String(i + 1).padStart(4, '0')}`;
      const base = { limitIp: 0, totalGB: 0, expiryTime: 0, enable: true, tgId: v3 ? 0 : '', subId: rand(16), comment: '', reset: 0, email };
      if (protocol === 'vless') return { ...base, id: uuid(), flow: rk ? 'xtls-rprx-vision' : '' };
      if (protocol === 'vmess') return { ...base, id: uuid(), security: 'auto' };
      if (protocol === 'trojan') return { ...base, password: rand(12) };
      return { ...base, method: '', password: rand(16) };
    };
    const clients = Array.from({ length: count }, (_, i) => mk(i));
    const embedded = v3 ? [] : clients; // 3.x: users are added after the inbound exists, through the clients API
    let settings;
    if (protocol === 'vless') settings = { clients: embedded, decryption: 'none', fallbacks: [] };
    else if (protocol === 'vmess') settings = { clients: embedded };
    else if (protocol === 'trojan') settings = { clients: embedded, fallbacks: [] };
    else settings = { method: 'chacha20-ietf-poly1305', password: rand(16), network: 'tcp,udp', clients: embedded };

    const form = {
      up: '0', down: '0', total: '0', remark: TAG, enable: 'true', expiryTime: '0', listen: '', port: String(port), protocol,
      settings: JSON.stringify(settings),
      streamSettings: JSON.stringify(rk ? {
        network: 'tcp', security: 'reality', externalProxy: [],
        realitySettings: {
          show: false, xver: 0, dest: REALITY_TARGET, target: REALITY_TARGET, serverNames: [REALITY_SNI],
          privateKey: rk.priv, minClientVer: '', maxClientVer: '', maxTimediff: 0, shortIds: [rk.sid],
          settings: { publicKey: rk.pub, fingerprint: 'chrome', serverName: '', spiderX: '/' },
        },
        tcpSettings: { acceptProxyProtocol: false, header: { type: 'none' } },
      } : { network: 'tcp', security: 'none', externalProxy: [], tcpSettings: { acceptProxyProtocol: false, header: { type: 'none' } } }),
      sniffing: JSON.stringify({ enabled: false, destOverride: ['http', 'tls', 'quic', 'fakedns'], metadataOnly: false, routeOnly: false }),
      allocate: JSON.stringify({ strategy: 'always', refresh: 5, concurrency: 3 }),
    };
    const r = await this.api([{ m: 'POST', p: '/panel/api/inbounds/add' }, { m: 'POST', p: '/panel/inbound/add' }], { form });
    if (!r.json || !r.json.success) throw new Error('inbound was rejected by the panel: ' + ((r.json && r.json.msg) || `HTTP ${r.status}`));
    const inboundId = r.json.obj && r.json.obj.id;

    if (v3) {
      try {
        let created = 0;
        for (let i = 0; i < clients.length; i += 250) {
          const br = await this.s.req('POST', '/panel/api/clients/bulkCreate', { json: clients.slice(i, i + 250).map((c) => ({ client: c, inboundIds: [inboundId] })) });
          if (!br.json || !br.json.success) throw new Error((br.json && br.json.msg) || `HTTP ${br.status}`);
          created += Number(br.json.obj && br.json.obj.created) || 0;
        }
        // read back what the panel really serves, so every config we hand out is one it accepts
        const g = await this.s.req('GET', `/panel/api/inbounds/get/${inboundId}`);
        const st = g.json && g.json.obj && g.json.obj.settings;
        const live = new Set(((typeof st === 'string' ? JSON.parse(st || '{}') : st || {}).clients || []).map((c) => c.email));
        const missing = clients.filter((c) => !live.has(c.email)).length;
        if (missing) throw new Error(`${missing} of ${clients.length} test users were not attached to the inbound (created ${created})`);
      } catch (e) {
        await this.removeTestInbounds().catch(() => {});
        throw new Error('panel rejected the test users: ' + e.message);
      }
    }

    const h = this.host();
    const links = clients.map((c) => {
      if (rk) return `vless://${c.id}@${h}:${port}?type=tcp&security=reality&encryption=none&flow=xtls-rprx-vision&sni=${REALITY_SNI}&fp=chrome&pbk=${rk.pub}&sid=${rk.sid}&spx=%2F#${c.email}`;
      if (protocol === 'vless') return `vless://${c.id}@${h}:${port}?type=tcp&security=none&encryption=none#${c.email}`;
      if (protocol === 'vmess') return 'vmess://' + b64(JSON.stringify({ v: '2', ps: c.email, add: h, port: String(port), id: c.id, aid: '0', scy: 'auto', net: 'tcp', type: 'none', host: '', path: '', tls: '' }));
      if (protocol === 'trojan') return `trojan://${c.password}@${h}:${port}?type=tcp&security=none#${c.email}`;
      return `ss://${b64(`chacha20-ietf-poly1305:${c.password}`)}@${h}:${port}#${c.email}`;
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
      } else note = 'سرویس سابسکریپشن در پنل خاموش است؛ تست HTTP فقط درخواست‌های ادمین را می‌زند (برای شبیه‌سازی کاربر واقعی، Subscription را در تنظیمات 3x-ui روشن کنید)';
    } catch (e) { note = 'تنظیمات سابسکریپشن خوانده نشد: ' + e.message; }

    return { links, subscriptionUrls, note, meta: { driver: '3xui', inboundId, port, protocol: kind, count, at: Date.now() } };
  }

  // How many of our test users the panel really serves right now (0 if the test inbound is gone).
  async liveTestUsers(meta) {
    const inb = (await this.listInbounds()).find((i) => meta && Number(i.id) === Number(meta.inboundId) && String(i.remark || '').startsWith(TAG));
    if (!inb) return 0;
    if (await this.isV3()) {
      const r = await this.s.req('GET', '/panel/api/clients/list');
      return ((r.json && r.json.obj) || []).filter((c) => String(c.email || '').startsWith(TAG + '-') && (c.inboundIds || []).map(Number).includes(Number(inb.id)) && c.enable !== false).length;
    }
    const st = typeof inb.settings === 'string' ? JSON.parse(inb.settings || '{}') : inb.settings || {};
    return (st.clients || []).length;
  }

  // Real-conditions run: a fresh test inbound with NO users. Users are then created one by one with addTestUser()
  // while the test ramps, so the panel's database is under load at the same time as Xray.
  async startTestInbound(spec) {
    const kind = ['reality', 'vless', 'vmess', 'trojan', 'shadowsocks'].includes(spec.protocol) ? spec.protocol : 'reality';
    const protocol = kind === 'reality' ? 'vless' : kind;
    const rk = kind === 'reality' ? { ...x25519(), sid: crypto.randomBytes(8).toString('hex') } : null;
    const v3 = await this.isV3();
    await this.removeTestInbounds();
    const used = new Set((await this.listInbounds()).map((i) => Number(i.port)));
    let port = Number(spec.port) || 24443;
    for (let k = 0; used.has(port) && k < 200; k++) port++;
    if (used.has(port)) throw new Error('no free port for the test inbound');
    const ctx = { v3, kind, protocol, rk, port, host: this.host(), runTag: rand(6), seq: 0 };
    const empty = protocol === 'shadowsocks'
      ? { method: 'chacha20-ietf-poly1305', password: rand(16), network: 'tcp,udp', clients: [] }
      : { clients: [], ...(protocol === 'vless' ? { decryption: 'none' } : {}), ...(protocol === 'vmess' ? {} : { fallbacks: [] }) };
    const r = await this.api([{ m: 'POST', p: '/panel/api/inbounds/add' }, { m: 'POST', p: '/panel/inbound/add' }], { form: this.inboundForm(ctx, empty) });
    if (!r.json || !r.json.success) throw new Error('inbound was rejected by the panel: ' + ((r.json && r.json.msg) || `HTTP ${r.status}`));
    ctx.inboundId = r.json.obj && r.json.obj.id;
    ctx.meta = { driver: '3xui', inboundId: ctx.inboundId, port, protocol: kind, count: 0, at: Date.now(), incremental: true };
    return ctx;
  }

  // One new user on the test inbound, exactly like an admin or a sales bot would add a customer. Returns its link.
  async addTestUser(ctx) {
    const c = makeClient(ctx, ctx.seq++);
    let r;
    if (ctx.v3) r = await this.s.req('POST', '/panel/api/clients/add', { json: { client: c, inboundIds: [ctx.inboundId] } });
    else r = await this.api([{ m: 'POST', p: '/panel/api/inbounds/addClient' }, { m: 'POST', p: '/panel/inbound/addClient' }], { form: { id: String(ctx.inboundId), settings: JSON.stringify({ clients: [c] }) } });
    if (r.status === 403 || r.status === 401) { this.logged = false; await this.login(); throw new Error('session expired'); }
    if (!r.json || !r.json.success) throw new Error((r.json && r.json.msg) || `HTTP ${r.status}`);
    ctx.meta.count = ctx.seq;
    return linkFor(ctx, c);
  }

  inboundForm(ctx, settings) {
    const { rk, port, protocol } = ctx;
    return {
      up: '0', down: '0', total: '0', remark: TAG, enable: 'true', expiryTime: '0', listen: '', port: String(port), protocol,
      settings: JSON.stringify(settings),
      streamSettings: JSON.stringify(rk ? {
        network: 'tcp', security: 'reality', externalProxy: [],
        realitySettings: {
          show: false, xver: 0, dest: REALITY_TARGET, target: REALITY_TARGET, serverNames: [REALITY_SNI],
          privateKey: rk.priv, minClientVer: '', maxClientVer: '', maxTimediff: 0, shortIds: [rk.sid],
          settings: { publicKey: rk.pub, fingerprint: 'chrome', serverName: '', spiderX: '/' },
        },
        tcpSettings: { acceptProxyProtocol: false, header: { type: 'none' } },
      } : { network: 'tcp', security: 'none', externalProxy: [], tcpSettings: { acceptProxyProtocol: false, header: { type: 'none' } } }),
      sniffing: JSON.stringify({ enabled: false, destOverride: ['http', 'tls', 'quic', 'fakedns'], metadataOnly: false, routeOnly: false }),
      allocate: JSON.stringify({ strategy: 'always', refresh: 5, concurrency: 3 }),
    };
  }

  // The panel's own traffic counter for the test inbound (bytes up + down), or null if it is gone.
  async testInboundTraffic(meta) {
    const inb = (await this.listInbounds()).find((i) => meta && Number(i.id) === Number(meta.inboundId));
    return inb ? (Number(inb.up) || 0) + (Number(inb.down) || 0) : null;
  }

  async deprovision() {
    const n = await this.removeTestInbounds();
    return { removed: n };
  }

  close() { return this.s.close(); }
}

module.exports = { ThreeXUI };
