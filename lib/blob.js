'use strict';
// Download source for the VPN test. VPN servers fetch it from this machine.
//   GET /blob            endless stream (steady traffic mode)
//   GET /blob?bytes=N    exactly N bytes, then the response ends (one "real" transfer: a photo, a page, a video segment…)
const http = require('http');
const crypto = require('crypto');

function startBlob(port) {
  const chunk = crypto.randomBytes(64 * 1024);
  const srv = http.createServer((req, res) => {
    if (!req.url.startsWith('/blob')) {
      res.writeHead(404);
      return res.end();
    }
    req.socket.setNoDelay(true);
    const m = /[?&]bytes=(\d+)/.exec(req.url);
    let left = m ? Math.min(Number(m[1]), 2e9) : Infinity;
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store',
      ...(Number.isFinite(left) ? { 'Content-Length': String(left) } : {}),
    });
    let open = true;
    req.on('close', () => { open = false; });
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
  srv.keepAliveTimeout = 0;
  srv.listen(port, '0.0.0.0');
  return srv;
}

// Runs in its own process so the download source never competes with the load engine for a CPU core.
if (require.main === module) {
  startBlob(Number(process.argv[2]) || 8081);
  process.on('disconnect', () => process.exit(0));
}

module.exports = { startBlob };
