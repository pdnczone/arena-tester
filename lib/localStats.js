'use strict';
// Stats of the machine running vpn-bench (the load generator, "server 3").
const os = require('os');
const fs = require('fs');

let prevCpu = snapCpu();
let prevNet = readNet();
let prevAt = Date.now();
let last = { cpu: 0, memPct: 0, rxMbps: 0, txMbps: 0, cores: os.cpus().length };

function snapCpu() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    for (const k of Object.keys(c.times)) total += c.times[k];
    idle += c.times.idle;
  }
  return { idle, total };
}

function readNet() {
  try {
    let rx = 0;
    let tx = 0;
    for (const line of fs.readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2)) {
      if (!line.includes(':')) continue;
      const [name, data] = line.split(':');
      const n = name.trim();
      if (n === 'lo' || /^(docker|veth|br-)/.test(n)) continue;
      const c = data.trim().split(/\s+/);
      rx += Number(c[0]);
      tx += Number(c[8]);
    }
    return { rx, tx };
  } catch {
    return null;
  }
}

setInterval(() => {
  const now = Date.now();
  const dt = (now - prevAt) / 1000;
  const c = snapCpu();
  const n = readNet();
  last = {
    cores: os.cpus().length,
    cpu: Math.round((1 - (c.idle - prevCpu.idle) / Math.max(c.total - prevCpu.total, 1)) * 1000) / 10,
    memPct: Math.round((1 - os.freemem() / os.totalmem()) * 1000) / 10,
    rxMbps: n && prevNet ? Math.round(((n.rx - prevNet.rx) * 8) / dt / 1e4) / 100 : null,
    txMbps: n && prevNet ? Math.round(((n.tx - prevNet.tx) * 8) / dt / 1e4) / 100 : null,
  };
  prevCpu = c;
  prevNet = n;
  prevAt = now;
}, 1000).unref();

module.exports = { get: () => last };
