'use strict';
// Stand-in for xray/sing-box so the VPN test can be rehearsed on a laptop with no real servers:
// reads the generated config and exposes plain SOCKS5 (direct connect) on every inbound port.
//   XRAY_BIN=$PWD/tools/fake-xray.sh node server.js
const net = require('net');
const fs = require('fs');

if (process.argv.includes('-test')) process.exit(0);
const cfg = JSON.parse(fs.readFileSync(process.argv[process.argv.length - 1], 'utf8'));
const ports = (cfg.inbounds || []).map((i) => i.port || i.listen_port);

function serve(port) {
  net.createServer((c) => {
    c.setNoDelay(true);
    c.once('data', () => {
      c.write(Buffer.from([5, 0]));
      c.once('data', (req) => {
        let host;
        let off;
        if (req[3] === 1) { host = [...req.subarray(4, 8)].join('.'); off = 8; }
        else if (req[3] === 3) { host = req.subarray(5, 5 + req[4]).toString(); off = 5 + req[4]; }
        else return c.destroy();
        const dport = req.readUInt16BE(off);
        const up = net.connect(dport, host, () => {
          up.setNoDelay(true);
          c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          c.pipe(up);
          up.pipe(c);
        });
        up.on('error', () => c.destroy());
        c.on('error', () => up.destroy());
        c.on('close', () => up.destroy());
      });
    });
    c.on('error', () => {});
  }).listen(port, '127.0.0.1');
}
ports.forEach(serve);
