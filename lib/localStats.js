'use strict';
// Stats of the machine running vpn-bench (the load generator, "server 3").
const os = require('os');
const fs = require('fs');
const { monitorEventLoopDelay } = require('perf_hooks');

// How late this process's own timers fire (p99 ms). Node runs on one core: when this grows, the tester itself is
// saturated even if the machine's total CPU looks fine on a multi-core server.
const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();

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

// The tester's own kernel limits: its conntrack table, and the local ports for connections to the panel (every
// connection from this machine to the panel's one port needs its own local port).
const readNum = (f) => { try { return fs.readFileSync(f, 'utf8').trim().split(/\s+/).map(Number); } catch { return null; } };
const range = readNum('/proc/sys/net/ipv4/ip_local_port_range');
const portRange = range ? range[1] - range[0] + 1 : null;
// local client SOCKS ports start at 20000: outgoing connections must not take them first
const reserved = (() => { try { return fs.readFileSync('/proc/sys/net/ipv4/ip_local_reserved_ports', 'utf8').trim(); } catch { return ''; } })();
const portClash = !!range && range[0] <= 29999 && !/(^|,)\s*20000-/.test(reserved);

setInterval(() => {
  const now = Date.now();
  const ct = readNum('/proc/sys/net/netfilter/nf_conntrack_count');
  const ctMax = readNum('/proc/sys/net/netfilter/nf_conntrack_max');
  const dt = (now - prevAt) / 1000;
  const c = snapCpu();
  const n = readNet();
  last = {
    cores: os.cpus().length,
    cpu: Math.round((1 - (c.idle - prevCpu.idle) / Math.max(c.total - prevCpu.total, 1)) * 1000) / 10,
    memPct: Math.round((1 - os.freemem() / os.totalmem()) * 1000) / 10,
    rxMbps: n && prevNet ? Math.round(((n.rx - prevNet.rx) * 8) / dt / 1e4) / 100 : null,
    txMbps: n && prevNet ? Math.round(((n.tx - prevNet.tx) * 8) / dt / 1e4) / 100 : null,
    lagMs: Math.round(loopDelay.percentile(99) / 1e6),
    ct: ct ? ct[0] : null, ctMax: ctMax ? ctMax[0] : null, portRange, portClash,
  };
  loopDelay.reset();
  prevCpu = c;
  prevNet = n;
  prevAt = now;
}, 1000).unref();

module.exports = { get: () => last };
