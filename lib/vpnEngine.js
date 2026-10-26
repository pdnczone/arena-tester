'use strict';
// VPN traffic engine: each "user" is one persistent download stream through a SOCKS port of the
// local Xray/sing-box client (one port per share link), reading an endless blob from this machine.
const { SocksClient } = require('socks');
const { Cores } = require('./cores');
const links = require('./links');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class VpnEngine {
  constructor(target, p, meter, basePort) {
    this.t = target;
    this.p = p;
    this.meter = meter;
    this.vus = [];
    this.seq = 0;
    this.connected = 0;
    this.cores = new Cores(target.id, basePort);
    this.protocols = '';
  }

  async start() {
    const { items, errors } = await links.resolveLinks(this.t, this.p.filter);
    if (!items.length) throw new Error('no usable links. ' + errors.slice(0, 2).join('; '));
    this.items = items;
    this.warn = errors.length ? errors.slice(0, 2).join('; ') : '';
    this.protocols = [...new Set(items.map((i) => links.summary(i.link)))].join(', ');
    await this.cores.start(items);
    if (!this.p.blobHost) throw new Error('blob host not set (generator public IP)');
  }

  setUsers(n) {
    while (this.vus.length < n) {
      const vu = { alive: true, id: this.seq++, sock: null };
      this.vus.push(vu);
      this.loop(vu);
    }
    while (this.vus.length > n) {
      const vu = this.vus.pop();
      vu.alive = false;
      if (vu.sock) vu.sock.destroy();
    }
  }

  users() {
    return this.vus.length;
  }

  async loop(vu) {
    await sleep(Math.random() * 1000);
    const port = this.cores.ports[vu.id % this.cores.ports.length];
    while (vu.alive) {
      await this.stream(vu, port);
      if (vu.alive) await sleep(1000);
    }
  }

  stream(vu, port) {
    const t0 = performance.now();
    const rate = this.p.userKbps * 125; // bytes/sec, 0 = unlimited
    return new Promise((resolve) => {
      let done = false;
      let gotFirst = false;
      let next = 0;
      const finish = (err) => {
        if (done) return;
        done = true;
        if (gotFirst) this.connected--;
        if (!gotFirst && vu.alive) this.meter.rec(false, null, err || 'connect');
        else if (vu.alive) this.meter.rec(false, null, 'reset');
        if (vu.sock) vu.sock.destroy();
        vu.sock = null;
        resolve();
      };
      SocksClient.createConnection({
        proxy: { host: '127.0.0.1', port, type: 5 },
        command: 'connect',
        destination: { host: this.p.blobHost, port: this.p.blobPort },
        timeout: this.p.timeoutMs,
      }).then(({ socket }) => {
        if (!vu.alive) return socket.destroy();
        vu.sock = socket;
        socket.setNoDelay(true);
        socket.on('error', (e) => finish(e.code || 'sock'));
        socket.on('close', () => finish('closed'));
        socket.setTimeout(this.p.timeoutMs, () => finish('timeout'));
        socket.write('GET /blob HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
        socket.on('data', (c) => {
          if (!gotFirst) {
            gotFirst = true;
            this.connected++;
            this.meter.rec(true, performance.now() - t0);
            next = performance.now();
          }
          this.meter.addBytes(c.length);
          if (rate > 0) {
            const now = performance.now();
            next = Math.max(next, now) + (c.length / rate) * 1000;
            const wait = next - now;
            if (wait > 30) {
              socket.pause();
              setTimeout(() => { if (!done) socket.resume(); }, wait);
            }
          }
        });
      }).catch((e) => finish(e.code || String(e.message).slice(0, 40)));
    });
  }

  activeStreams() {
    return this.connected;
  }

  async stop() {
    this.vus.forEach((v) => { v.alive = false; if (v.sock) v.sock.destroy(); });
    this.vus = [];
    this.cores.stop();
  }
}

module.exports = { VpnEngine };
