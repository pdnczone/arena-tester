'use strict';
// Endless download source for the VPN test. VPN servers fetch it from this machine.
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
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' });
    let open = true;
    req.on('close', () => { open = false; });
    const pump = () => {
      while (open) {
        if (!res.write(chunk)) return res.once('drain', pump);
      }
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
