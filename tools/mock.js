'use strict';
// Two fake panels (+ fake agents) with different capacities, to rehearse the dashboard without real servers.
//   node tools/mock.js        ->  A on :9201 (capacity ~400 req/s), B on :9202 (capacity ~700 req/s)
const http = require('http');

// Fake management APIs shaped like 3x-ui (kind '3xui') and Nexora (kind 'nexora'), so provisioning can be rehearsed.
function mockApi(kind, port) {
  const inbounds = [];
  const users = [];
  let seq = 1;
  const sub = (id) => `http://127.0.0.1:${port}/sub/${id}`;
  return (req, body, send) => {
    const u = req.url.split('?')[0];
    if (kind === '3xui') {
      if (req.method === 'POST' && u === '/login') { const f = new URLSearchParams(body); return send(f.get('password') ? 200 : 401, { success: !!f.get('password') }, 'session=abc; Path=/'); }
      if (u === '/panel/api/inbounds/list') return send(200, { success: true, obj: inbounds });
      if (req.method === 'POST' && u === '/panel/api/inbounds/add') {
        const f = new URLSearchParams(body); const id = seq++;
        inbounds.push({ id, port: Number(f.get('port')), remark: f.get('remark'), protocol: f.get('protocol'), settings: f.get('settings') });
        return send(200, { success: true, obj: { id } });
      }
      let m = /^\/panel\/api\/inbounds\/del\/(\d+)$/.exec(u);
      if (m) { const i = inbounds.findIndex((x) => x.id === Number(m[1])); if (i >= 0) inbounds.splice(i, 1); return send(200, { success: true }); }
      if (u === '/panel/api/server/status') return send(200, { success: true, obj: { cpu: 12.5, logicalPro: 2, mem: { current: 1.2e9, total: 4e9 }, netIO: { up: 125000, down: 250000 }, tcpCount: 321, loads: [0.4, 0.3, 0.2], appStats: { mem: 90e6 }, xray: { state: 'running', version: '1.8.24' } } });
      if (u === '/panel/setting/all') return send(200, { success: true, obj: { subEnable: true, subPort: port, subPath: '/sub/', subDomain: '127.0.0.1' } });
      if (u.startsWith('/sub/')) return null;
    } else {
      if (req.method === 'POST' && u === '/api/login') { const j = JSON.parse(body || '{}'); return send(j.password ? 200 : 401, j.password ? { id: 1 } : { error: 'bad credentials' }, 'nexora_session=xyz; Path=/'); }
      if (u === '/api/v1/inbounds') return send(200, { items: [{ id: 1, type: 'vless', tag: 'in1' }], total: 1, limit: 1000, offset: 0 });
      if (u === '/api/v1/nodes') return send(200, { items: [{ id: 1, name: 'local', status: 'connected', enabled: true, templateId: 1, up: Date.now() * 1000, down: Date.now() * 2000, coreVersion: '1.0', live: { connections: 77, host: { memTotal: 4e9, memUsed: 1.6e9, load1: 0.7 } } }], total: 1 });
      if (u === '/api/nodes/1/info') return send(200, { num_cpu: 2 });
      if (u === '/api/panel/info') return send(200, { version: '0.0.3', num_cpu: 2, sys_mem_total: 4e9, sys_mem_used: 1.5e9, load_avg_1: 0.5, mem_sys: 60e6 });
      if (req.method === 'POST' && u === '/api/v1/users/generate') {
        const j = JSON.parse(body); const created = [];
        for (let i = 0; i < j.count; i++) { const id = seq++; const tok = 'tok' + id; users.push(id); created.push({ id, name: j.pattern.replace('{nnn}', String(j.start + i).padStart(3, '0')), subUrl: sub(tok) }); }
        return send(200, { created, skipped: [], room: -1 });
      }
      if (req.method === 'POST' && u === '/api/v1/users/bulk/delete') { const j = JSON.parse(body); return send(200, { op: 'delete', matched: j.ids.length, affected: j.ids.length, blocked: 0, failed: 0 }); }
      if (u.startsWith('/sub/')) return null;
    }
    return null;
  };
}

function mockPanel(port, capRps, name, kind) {
  const api = mockApi(kind, port);
  const hits = [];
  let rx = 0;
  const vless = Buffer.from(`vless://11111111-2222-3333-4444-555555555555@127.0.0.1:1#${name}`).toString('base64');
  const rate = () => {
    const now = Date.now();
    while (hits.length && hits[0] < now - 1000) hits.shift();
    return hits.length;
  };
  http.createServer((req, res) => {
    if (req.method === 'POST' || req.url.startsWith('/panel/') || req.url.startsWith('/api/')) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const send = (code, obj, cookie) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); if (cookie) res.setHeader('Set-Cookie', cookie); res.end(JSON.stringify(obj)); return true; };
        if (!api(req, body, send)) handle(req, res);
      });
      return;
    }
    handle(req, res);
  }).listen(port, () => console.log(`mock ${name} :${port} (${kind} API, capacity ~${capRps} req/s)`));

  function handle(req, res) {
    if (req.url.startsWith('/stats')) {
      const util = Math.min(1.2, rate() / capRps);
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({
        cpu: Math.min(100, util * 88 + Math.random() * 4), memPct: 30 + util * 25, memUsedMB: 1200, memTotalMB: 4096,
        rxMbps: rate() * 0.02, txMbps: rate() * 0.15, load1: util * 2, cores: 2, tcp_inuse: rate() * 2,
        panel: { cpu: util * 60, rssMB: 180 + util * 80 }, core: { cpu: util * 25, rssMB: 120 },
      }));
    }
    hits.push(Date.now());
    const util = rate() / capRps;
    const lat = 12 + (util < 0.97 ? (20 * util) / (1 - util) : 3000) + Math.random() * 8;
    const fail = util > 1.05 && Math.random() < Math.min(0.7, (util - 1.05) * 2);
    setTimeout(() => {
      if (fail) { res.statusCode = 503; return res.end('busy'); }
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/login') res.setHeader('Set-Cookie', 'session=abc123; Path=/');
      if (req.url.startsWith('/sub/')) return res.end(vless);
      res.end(JSON.stringify({ success: true, obj: [] }));
    }, Math.min(lat, 9000));
  }
}

mockPanel(9201, 400, 'mock-A', '3xui');
mockPanel(9202, 700, 'mock-B', 'nexora');
