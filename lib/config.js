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
    if (dirty) this.save();
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
    c.targets.forEach((t) => {
      t._has = { password: !!t.password, agentToken: !!t.agentToken, apiToken: !!t.apiToken, links: t.links.length, subs: t.subscriptionUrls.length, agent: !!t.agentUrl };
      if (t.provision) t.provision = { ...t.provision, ids: undefined };
      delete t.enrollToken;
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
        if (k === 'id' || k === '_has' || k === 'enrollToken' || k === 'provision') continue;
        if (SECRET.includes(k) && !v) continue;
        if ((k === 'links' || k === 'subscriptionUrls') && v == null) continue;
        cur[k] = v;
      }
    }
    this.save();
  }
}

module.exports = { Store, preset3xui };
