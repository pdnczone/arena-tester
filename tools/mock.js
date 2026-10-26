'use strict';
// Two fake panels (+ fake agents) with different capacities, to rehearse the dashboard without real servers.
//   node tools/mock.js        ->  A on :9201 (capacity ~400 req/s), B on :9202 (capacity ~700 req/s)
const http = require('http');

function mockPanel(port, capRps, name) {
  const hits = [];
  let rx = 0;
  const vless = Buffer.from(`vless://11111111-2222-3333-4444-555555555555@127.0.0.1:1#${name}`).toString('base64');
  const rate = () => {
    const now = Date.now();
    while (hits.length && hits[0] < now - 1000) hits.shift();
    return hits.length;
  };
  http.createServer((req, res) => {
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
  }).listen(port, () => console.log(`mock ${name} :${port} (capacity ~${capRps} req/s)`));
}

mockPanel(9201, 400, 'mock-A');
mockPanel(9202, 700, 'mock-B');
