'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { WebSocketServer } = require('ws');
const { Store } = require('./lib/config');
const { Runner } = require('./lib/runner');
const { PanelEngine } = require('./lib/panelEngine');
const { VpnEngine } = require('./lib/vpnEngine');
const { Meter } = require('./lib/meter');
const { fork } = require('child_process');
const { parseCurl } = require('./lib/curl');
const { preset3xui } = require('./lib/config');
const links = require('./lib/links');
const { pollAgent } = require('./lib/agentClient');

const PORT = Number(process.env.PORT) || 8080;
const PASSWORD = process.env.DASH_PASSWORD || '';
const store = new Store();
const runner = new Runner(store);

const crypto = require('crypto');
const wsTokens = new Set();
const cookieOf = (h, n) => ((h || '').split(';').map((s) => s.trim()).find((s) => s.startsWith(n + '=')) || '').slice(n.length + 1);
const app = express();
app.use(express.json({ limit: '2mb' }));

const authorized = (header) => {
  if (!PASSWORD) return true;
  const m = /^Basic (.+)$/.exec(header || '');
  if (!m) return false;
  const [, pass = ''] = Buffer.from(m[1], 'base64').toString().split(/:(.*)/s);
  return pass === PASSWORD;
};
app.use((req, res, next) => {
  if (authorized(req.headers.authorization)) {
    // browsers do not always forward Basic credentials on the websocket upgrade: give them a cookie too
    if (PASSWORD && !wsTokens.has(cookieOf(req.headers.cookie, 'vb_ws'))) {
      const t = crypto.randomBytes(16).toString('hex');
      wsTokens.add(t);
      res.setHeader('Set-Cookie', `vb_ws=${t}; HttpOnly; SameSite=Strict; Path=/`);
    }
    return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="vpn-bench"').status(401).end('auth required');
});
app.use(express.static(path.join(__dirname, 'public')));

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(400).json({ error: e.message }));

app.get('/api/config', (req, res) => res.json(store.masked()));
app.put('/api/config', wrap((req, res) => {
  if (runner.isRunning()) throw new Error('stop the running test first');
  store.update(req.body);
  res.json(store.masked());
}));
app.get('/api/state', (req, res) => res.json(runner.snapshot()));
app.post('/api/start', wrap((req, res) => {
  runner.start(req.body || {});
  res.json({ ok: true });
}));
app.post('/api/stop', (req, res) => {
  runner.stop();
  res.json({ ok: true });
});
app.get('/api/report.json', (req, res) => res.attachment('report.json').json(runner.report()));
app.get('/api/report.csv', (req, res) => {
  const r = runner.report();
  const rows = ['target,step,users,rps,err_pct,p95_ms,mbps,user_kbps,cpu,mem_pct,panel_cpu,core_cpu,ok'];
  for (const [id, t] of Object.entries(r.targets))
    for (const s of t.steps) rows.push([t.name, s.step, s.users, s.rps, s.errPct, s.p95, s.mbps, s.userKbps, s.cpu ?? '', s.memPct ?? '', s.panelCpu ?? '', s.coreCpu ?? '', s.ok].join(','));
  res.attachment('report.csv').type('text/csv').send(rows.join('\n'));
});

// Import "Copy as cURL" from DevTools as a scenario step of target :id.
app.post('/api/curl-import', wrap((req, res) => {
  const t = store.get().targets.find((x) => x.id === req.body.id);
  if (!t) throw new Error('unknown target');
  const step = parseCurl(req.body.curl);
  if (req.body.role) step.role = req.body.role;
  const origin = step.origin;
  delete step.origin;
  let base = null;
  try { base = new URL(req.body.panelUrl || t.panelUrl); } catch { /* panelUrl not set */ }
  if (base && base.origin === origin) {
    const prefix = base.pathname.replace(/\/+$/, '');
    if (prefix && step.path.startsWith(prefix)) step.path = step.path.slice(prefix.length) || '/';
  } else {
    step.url = origin + step.path; // different host/port (e.g. subscription server)
    delete step.path;
  }
  if (step.path) step.name = `${step.method} ${step.path}`;
  if (step.role === 'login') {
    // never store the pasted credentials: use the target's own username/password
    const tpl = (o) => { if (!o) return; for (const k of Object.keys(o)) { if (/^(user(name)?|email|login)$/i.test(k)) o[k] = '{{username}}'; else if (/^pass(word)?$/i.test(k)) o[k] = '{{password}}'; } };
    tpl(step.form);
    tpl(step.json);
  }
  res.json({ step });
}));
app.get('/api/preset/3xui', (req, res) => res.json({ steps: preset3xui() }));

// "Test this target": run every scenario step once against the real panel.
app.post('/api/test/panel', wrap(async (req, res) => {
  const t = store.get().targets.find((x) => x.id === req.body.id);
  if (!t) throw new Error('unknown target');
  const p = { ...store.get().test, timeoutMs: 8000, sessions: 1 };
  const eng = new PanelEngine(t, p, new Meter());
  const out = [];
  try {
    const sess = await eng.login();
    out.push({ name: 'login', ok: true, status: 200 });
    for (const s of (t.steps || []).filter((x) => x.role !== 'login')) {
      const r = await eng.exec(s, sess, { count: false });
      out.push({ name: s.name, ok: r.ok, status: r.status, ms: Math.round(r.ms), error: r.error, snippet: r.snippet });
    }
    for (const u of (t.subscriptionUrls || []).slice(0, 1)) {
      const r = await eng.exec({ url: u, expect: [200], extract: { _: '_' } }, { jar: new Map(), vars: {} }, { count: false });
      out.push({ name: 'subscription', ok: r.ok, status: r.status, ms: Math.round(r.ms), error: r.error });
    }
  } catch (e) {
    out.push({ name: 'login', ok: false, error: e.message });
  } finally {
    await eng.stop();
  }
  res.json({ results: out });
}));

app.post('/api/test/links', wrap(async (req, res) => {
  const t = store.get().targets.find((x) => x.id === req.body.id);
  if (!t) throw new Error('unknown target');
  const { items, errors } = await links.resolveLinks(t, store.get().test.filter);
  const by = {};
  items.forEach((i) => { const k = links.summary(i.link); by[k] = (by[k] || 0) + 1; });
  res.json({ count: items.length, protocols: by, errors: errors.slice(0, 3) });
}));

app.post('/api/test/vpn', wrap(async (req, res) => {
  const cfg = store.get();
  const t = cfg.targets.find((x) => x.id === req.body.id);
  if (!t) throw new Error('unknown target');
  const p = { ...cfg.test, blobHost: cfg.generator.publicHost, blobPort: cfg.generator.blobPort, userKbps: 0, timeoutMs: 8000 };
  const meter = new Meter();
  const eng = new VpnEngine({ ...t, links: [...(t.links || [])], subscriptionUrls: (t.subscriptionUrls || []).slice(0, 1) }, p, meter, 29000);
  try {
    await eng.start();
    eng.setUsers(1);
    await new Promise((r) => setTimeout(r, 4500));
    const m = meter.tick();
    const bytes = meter.totalBytes;
    res.json({ ok: eng.activeStreams() > 0, protocols: eng.protocols, mbpsApprox: Math.round(((bytes * 8) / 3.5 / 1e6) * 10) / 10, ttfbMs: Math.round(m.p50 || 0), errors: meter.topErrors() });
  } finally {
    await eng.stop();
  }
}));

app.post('/api/test/agent', wrap(async (req, res) => {
  const t = store.get().targets.find((x) => x.id === req.body.id);
  if (!t) throw new Error('unknown target');
  const a = await pollAgent(t);
  res.json({ ok: !!a, stats: a });
}));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', verifyClient: (info) => authorized(info.req.headers.authorization) || wsTokens.has(cookieOf(info.req.headers.cookie, 'vb_ws')) });
const send = (ws, obj) => ws.readyState === 1 && ws.send(JSON.stringify(obj));
const broadcast = (obj) => wss.clients.forEach((ws) => send(ws, obj));
wss.on('connection', (ws) => send(ws, { type: 'snapshot', state: runner.snapshot() }));
runner.on('snapshot', (state) => broadcast({ type: 'snapshot', state }));
runner.on('tick', (p) => broadcast({ type: 'tick', ...p }));
runner.on('step', (p) => broadcast({ type: 'step', ...p }));
runner.on('event', (ev) => broadcast({ type: 'event', ev }));
runner.on('target', (p) => broadcast({ type: 'target', ...p }));
runner.on('status', (s) => broadcast({ type: 'status', status: s }));
runner.on('done', (state) => {
  try {
    fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
    fs.writeFileSync(path.join(__dirname, 'data', 'last-report.json'), JSON.stringify(runner.report()));
  } catch { /* ignore */ }
  broadcast({ type: 'snapshot', state });
});

const blob = fork(path.join(__dirname, 'lib', 'blob.js'), [String(Number(store.get().generator.blobPort) || 8081)]);
process.on('exit', () => blob.kill());
['SIGINT', 'SIGTERM'].forEach((sig) => process.on(sig, () => process.exit(0)));
server.listen(PORT, '0.0.0.0', () => {
  console.log(`vpn-bench dashboard:  http://localhost:${PORT}${PASSWORD ? '  (password protected)' : '  (NO password — set DASH_PASSWORD)'}`);
});
