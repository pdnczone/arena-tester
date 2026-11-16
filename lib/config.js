'use strict';
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'config.json');

const preset3xui = () => [
  { name: 'ورود', role: 'login', method: 'POST', path: '/login', form: { username: '{{username}}', password: '{{password}}' }, expect: [200], expectBody: '"success":true' },
  { name: 'لیست inboundها', role: 'admin', method: 'GET', path: '/panel/api/inbounds/list', expect: [200] },
  { name: 'وضعیت سرور', role: 'admin', method: 'POST', path: '/server/status', expect: [200] },
];

const newTarget = (id, name, color, kind, panelProc, steps) => ({
  id, name, color, kind, enabled: true,
  panelUrl: '', inboundHost: '', username: '', password: '', apiToken: '', insecureTls: false, provision: null,
  steps, subscriptionUrls: [], links: [],
  agentUrl: '', agentToken: '', panelProc, coreProc: 'xray',
});

const defaults = () => ({
  generator: { publicHost: '', blobPort: 8081, nicMbps: 1000 },
  test: {
    type: 'panel', mode: 'parallel',
    startUsers: 50, stepUsers: 50, stepSeconds: 15, maxUsers: 2000, graceSec: 6,
    thinkMs: 1000, timeoutMs: 10000, sessions: 5, subPct: 80,
    maxErrPct: 2, maxP95Ms: 1500, userKbps: 2000, minUserPct: 70,
    filter: '', cooldownSec: 20, holdAfterBreakSec: 6,
  },
  targets: [
    newTarget('A', '3x-ui', '#0a84ff', '3xui', 'x-ui', preset3xui()),
    newTarget('B', 'Nexora', '#bf5af2', 'nexora', 'nexora-panel', []),
  ],
});

const PALETTE = ['#0a84ff', '#bf5af2', '#ff9f0a', '#30d158', '#ff375f', '#64d2ff', '#ffd60a', '#ac8e68'];
const SECRET = ['password', 'agentToken', 'apiToken'];

class Store {
  constructor() {
    this.cfg = defaults();
    try {
      const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      this.cfg = { ...this.cfg, ...saved, test: { ...this.cfg.test, ...saved.test }, generator: { ...this.cfg.generator, ...saved.generator } };
    } catch { /* first run */ }
    let dirty = false;
    for (const t of this.cfg.targets) {
      if (!t.enrollToken) { t.enrollToken = crypto.randomBytes(12).toString('hex'); dirty = true; }
      if (t.apiToken === undefined) t.apiToken = '';
    }
    if (!this.cfg.joinToken) { this.cfg.joinToken = crypto.randomBytes(16).toString('hex'); dirty = true; }
    if (dirty) this.save();
  }

  // One shared "join" token: any server that runs the dashboard's install command registers itself as a new target.
  // Re-running on the same machine (same machineId) updates that target instead of adding another.
  enrollJoin(info) {
    const kind = ['3xui', 'nexora'].includes(info.kind) ? info.kind : 'custom';
    const str = (v, n = 200) => String(v ?? '').slice(0, n);
    const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ''; } };
    const agentHost = hostOf(info.agentUrl);
    let t = info.machineId ? this.cfg.targets.find((x) => x.machineId === str(info.machineId, 64)) : null;
    // a server that was set up by hand earlier (same agent address) is adopted, not duplicated
    if (!t && agentHost) t = this.cfg.targets.find((x) => !x.machineId && hostOf(x.agentUrl) === agentHost);
    if (t && !t.machineId) t.machineId = str(info.machineId, 64);
    const created = !t;
    if (!t) {
      const n = this.cfg.targets.filter((x) => x.machineId).length;
      let id = 'S' + (n + 1);
      while (this.target(id)) id = 'S' + (Number(id.slice(1)) + 1);
      t = newTarget(id, str(info.hostname, 40) || id, PALETTE[n % PALETTE.length], kind, '', kind === '3xui' ? preset3xui() : []);
      t.enrollToken = crypto.randomBytes(12).toString('hex');
      t.machineId = str(info.machineId, 64);
      // drop the untouched factory placeholders (never configured by the user) once real servers start joining
      this.cfg.targets = this.cfg.targets.filter((x) => x.panelUrl || x.agentUrl || x.username || x.machineId);
      this.cfg.targets.push(t);
    }
    if (info.kind) t.kind = kind;
    t.agentUrl = str(info.agentUrl);
    t.agentToken = str(info.agentToken);
    if (info.panelProc) t.panelProc = str(info.panelProc, 40);
    if (info.coreProc) t.coreProc = str(info.coreProc, 40);
    if (info.panelUrl && !t.panelUrl) t.panelUrl = str(info.panelUrl);
    if (info.username && !t.username) t.username = str(info.username, 80);
    if (info.password && !t.password) t.password = str(info.password, 120);
    if (kind === '3xui' && !(t.steps || []).length) t.steps = preset3xui();
    this.save();
    return { t, created };
  }

  removeTarget(id) {
    if (this.cfg.targets.length <= 1) throw new Error('حداقل یک سرور باید بماند');
    const i = this.cfg.targets.findIndex((x) => x.id === id);
    if (i < 0) throw new Error('unknown target');
    this.cfg.targets.splice(i, 1);
    this.save();
  }

  get() {
    return this.cfg;
  }

  save() {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(this.cfg, null, 2), { mode: 0o600 });
  }

  // Secrets never leave the server: the UI only sees what is stored, not the values.
  masked() {
    const c = JSON.parse(JSON.stringify(this.cfg));
    delete c.joinToken;
    c.targets.forEach((t) => {
      t._has = { password: !!t.password, agentToken: !!t.agentToken, apiToken: !!t.apiToken, links: t.links.length, subs: t.subscriptionUrls.length, agent: !!t.agentUrl };
      if (t.provision) t.provision = { ...t.provision, ids: undefined };
      delete t.enrollToken;
      delete t.machineId;
      SECRET.forEach((k) => (t[k] = ''));
      t.links = null;
      t.subscriptionUrls = null;
    });
    return c;
  }

  target(id) {
    return this.cfg.targets.find((x) => x.id === id);
  }

  setProvision(id, r) {
    const t = this.target(id);
    t.links = r.links;
    t.subscriptionUrls = r.subscriptionUrls;
    t.provision = r.meta;
    this.save();
  }

  clearProvision(id) {
    const t = this.target(id);
    t.links = [];
    t.subscriptionUrls = [];
    t.provision = null;
    this.save();
  }

  // null / '' = keep stored value, array = replace
  update(inc) {
    if (inc.generator) this.cfg.generator = { ...this.cfg.generator, ...inc.generator };
    if (inc.test) this.cfg.test = { ...this.cfg.test, ...inc.test };
    for (const t of inc.targets || []) {
      const cur = this.cfg.targets.find((x) => x.id === t.id);
      if (!cur) continue;
      for (const [k, v] of Object.entries(t)) {
        if (k === 'id' || k === '_has' || k === 'enrollToken' || k === 'machineId' || k === 'provision') continue;
        if (SECRET.includes(k) && !v) continue;
        if ((k === 'links' || k === 'subscriptionUrls') && v == null) continue;
        cur[k] = v;
      }
    }
    this.save();
  }
}

module.exports = { Store, preset3xui };
