'use strict';
// Download source for the VPN test. VPN servers fetch it from this machine.
//   GET /blob            endless stream (steady traffic mode)
//   &rate=B              send at B bytes/s: the user's line speed. Pacing at the source keeps the flow moving like
//                        a real one held back by the last mile; stopping to read on the client side instead
//                        makes the VPN chain freeze for seconds at a time and is not what real users do.
//   GET /blob?bytes=N    exactly N bytes (a photo, a page object, a video segment…). Keep-alive works, so one
//                        connection can fetch several objects in a row, like a browser or an app does.
//   GET /hold?every=S    a long-lived idle connection that gets a few hundred bytes every S seconds — the
//                        messenger / push / app keep-alive connections every phone keeps open all the time.
const http = require('http');
const crypto = require('crypto');

function startBlob(port) {
  const chunk = crypto.randomBytes(64 * 1024);
  const srv = http.createServer((req, res) => {
    req.socket.setNoDelay(true);
    if (req.url.startsWith('/hold')) {
      const m = /[?&]every=(\d+)/.exec(req.url);
      const every = Math.min(Math.max(Number(m && m[1]) || 30, 5), 300) * 1000;
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.write(chunk.subarray(0, 64));
      const timer = setInterval(() => res.write(chunk.subarray(0, 150 + Math.floor(Math.random() * 350))), every);
      req.on('close', () => clearInterval(timer));
      return;
    }
    if (!req.url.startsWith('/blob')) {
      res.writeHead(404);
      return res.end();
    }
    const m = /[?&]bytes=(\d+)/.exec(req.url);
    let left = m ? Math.min(Number(m[1]), 2e9) : Infinity;
    const rm = /[?&]rate=(\d+)/.exec(req.url);
    const rate = rm ? Math.max(1000, Number(rm[1])) : 0; // bytes/s
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store',
      ...(Number.isFinite(left) ? { 'Content-Length': String(left) } : {}),
    });
    let open = true;
    req.on('close', () => { open = false; });
    if (rate) {
      // ~20 ms worth of data per write, on a clock that does not drift: what a paced sender does
      const size = Math.min(chunk.length, Math.max(4096, Math.round(rate * 0.02)));
      let due = Date.now();
      const tick = () => {
        if (!open) return;
        if (left <= 0) return res.end();
        const part = chunk.subarray(0, Math.min(size, left));
        left -= part.length;
        due = Math.max(due + (part.length / rate) * 1000, Date.now() - 200);
        const next = () => setTimeout(tick, Math.max(0, due - Date.now()));
        if (!res.write(part)) res.once('drain', next);
        else next();
      };
      tick();
      return;
    }
    const pump = () => {
      while (open && left > 0) {
        const part = left >= chunk.length ? chunk : chunk.subarray(0, left);
        left -= part.length;
        if (!res.write(part)) return res.once('drain', pump);
      }
      if (open && left <= 0) res.end();
    };
    pump();
  });
  srv.keepAliveTimeout = 30000; // apps and browsers reuse a connection for a while
  srv.headersTimeout = 35000;
  srv.requestTimeout = 0; // /hold connections live for minutes
  srv.maxConnections = 200000;
  srv.listen(port, '0.0.0.0');
  return srv;
}

// Runs in its own process so the download source never competes with the load engine for a CPU core.
if (require.main === module) {
  startBlob(Number(process.argv[2]) || 8081);
  process.on('disconnect', () => process.exit(0));
}

module.exports = { startBlob };
