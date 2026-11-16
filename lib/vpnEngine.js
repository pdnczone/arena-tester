'use strict';
// VPN traffic engine. Every simulated user is tied to one test config (= one user on the panel's test inbound) and
// all its traffic goes through that config: local Xray/sing-box SOCKS port -> panel inbound -> back to this machine.
//   real   (default): each user has its own line speed and moves between activities like a person does —
//                     messenger, Instagram, browsing, video, big downloads — with pauses in between.
//   steady:           each user is one endless download at the configured speed (old behaviour).
const { SocksClient } = require('socks');
const { Cores } = require('./cores');
const links = require('./links');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uni = (a, b) => a + Math.random() * (b - a);
const logUni = (a, b) => Math.exp(uni(Math.log(a), Math.log(b))); // sizes: many small, few large
const MB = 1e6;

// What a real user does, and how much of the user base is doing it at a given moment.
const ACTIVITIES = [
  { k: 'chat', w: 25 }, // Telegram / WhatsApp: tiny bursts
  { k: 'social', w: 30 }, // Instagram: photos and reels
  { k: 'web', w: 15 }, // pages, then reading
  { k: 'video', w: 20 }, // YouTube: buffered segments at a fixed quality
  { k: 'download', w: 10 }, // a file, as fast as the line allows
];
const pickActivity = () => {
  let r = Math.random() * ACTIVITIES.reduce((a, x) => a + x.w, 0);
  for (const x of ACTIVITIES) { r -= x.w; if (r <= 0) return x.k; }
  return 'social';
};

class VpnEngine {
  constructor(target, p, meter, basePort) {
    this.t = target;
    this.p = p;
    this.meter = meter;
    this.vus = [];
    this.seq = 0;
    this.connected = 0;
    this.real = p.trafficMode !== 'steady';
    // provider = { add(): Promise<shareLink>, label } when users are created on the panel during the test
    this.provider = null;
    this.links = [];
    this.want = 0;
    this.growing = null;
    this.cores = new Cores(target.id, basePort);
    this.protocols = '';
  }

  async start() {
    if (this.provider) {
      if (!this.p.blobHost) throw new Error('blob host not set (generator public IP)');
      this.protocols = this.provider.label || '';
      this.cores.ports = [];
      return;
    }
    const { items, errors } = await links.resolveLinks(this.t, this.p.filter);
    if (!items.length) throw new Error('no usable links. ' + errors.slice(0, 2).join('; '));
    this.items = items;
    this.warn = errors.length ? errors.slice(0, 2).join('; ') : '';
    this.protocols = [...new Set(items.map((i) => links.summary(i.link)))].join(', ');
    await this.cores.start(items);
    if (!this.p.blobHost) throw new Error('blob host not set (generator public IP)');
  }

  setUsers(n) {
    if (this.provider) {
      this.want = n;
      while (this.vus.length > n) { const vu = this.vus.pop(); vu.alive = false; if (vu.sock) vu.sock.destroy(); }
      if (!this.growing) this.growing = this.grow().finally(() => { this.growing = null; });
      return;
    }
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
    return this.provider ? Math.max(this.vus.length, this.want) : this.vus.length;
  }

  // Bring the number of real panel users up to `want`: create them one by one on the panel (the database work an
  // admin or sales bot causes), then start one local client for the new configs and let those users go online.
  async grow() {
    const LIMIT = 2000; // one config per user up to here; above it users share configs
    while (!this.stopped && this.vus.length < this.want) {
      const target = Math.min(this.want, LIMIT);
      const fresh = [];
      while (!this.stopped && this.links.length + fresh.length < target) {
        const t0 = performance.now();
        try {
          const raw = await this.provider.add();
          this.meter.recDb(true, performance.now() - t0);
          fresh.push(raw);
        } catch (e) {
          this.meter.recDb(false, performance.now() - t0, String(e.message || e).slice(0, 60));
          await sleep(500);
          if (this.meter.dbFailStreak >= 20) break; // the panel cannot create users right now: stop hammering
        }
      }
      if (this.stopped) return;
      if (fresh.length) {
        const items = fresh.map((raw) => ({ raw, link: links.parseLink(raw) }));
        try {
          await this.cores.add(items);
          this.links.push(...fresh);
        } catch (e) {
          this.meter.rec(false, null, 'local client: ' + String(e.message).slice(0, 50));
          return;
        }
      }
      if (!this.cores.ports.length) return;
      // a user only goes online once its own config exists on the panel (configs are shared only above LIMIT)
      const online = this.links.length >= LIMIT ? this.want : Math.min(this.want, this.links.length);
      while (this.vus.length < online) {
        const id = this.seq++;
        const vu = { alive: true, id, sock: null, port: this.cores.ports[this.vus.length % this.cores.ports.length] };
        this.vus.push(vu);
        this.loop(vu);
      }
      if (this.meter.dbFailStreak >= 20) return;
    }
  }

  created() {
    return this.links.length;
  }

  // ---------- real traffic ----------
  async realLoop(vu) {
    const cap = this.p.userKbps > 0 ? this.p.userKbps * 125 : 0; // bytes/s, 0 = no cap
    vu.line = cap ? cap * uni(0.25, 1) : 0; // this person's own connection speed
    if (!vu.port) vu.port = this.cores.ports[vu.id % this.cores.ports.length];
    await sleep(Math.random() * 3000);
    while (vu.alive) {
      const act = pickActivity();
      const until = Date.now() + uni(30, 180) * 1000;
      vu.videoRate = logUni(1.5 * MB, 8 * MB) / 8; // bytes/s of the stream quality, if they watch video
      let seg = 0;
      while (vu.alive && Date.now() < until) {
        if (act === 'chat') {
          await this.transfer(vu, logUni(5e3, 80e3));
          await sleep(uni(5, 30) * 1000);
        } else if (act === 'social') {
          await this.transfer(vu, logUni(0.3 * MB, 2.5 * MB));
          await sleep(uni(2, 10) * 1000);
        } else if (act === 'web') {
          await this.transfer(vu, logUni(0.5 * MB, 3 * MB));
          await sleep(uni(5, 25) * 1000);
        } else if (act === 'video') {
          // a player buffers a few segments quickly, then fetches one 4 s segment every 4 s
          const t0 = Date.now();
          const need = Math.min(vu.videoRate, vu.line || Infinity);
          await this.transfer(vu, vu.videoRate * 4 * uni(0.9, 1.1), need);
          if (++seg > 3) await sleep(Math.max(0, 4000 - (Date.now() - t0)));
        } else {
          await this.transfer(vu, logUni(20 * MB, 300 * MB));
          await sleep(uni(5, 20) * 1000);
        }
      }
    }
  }

  // One request through this user's own config: connect, receive `bytes`, close. Records time to first byte,
  // errors, and for transfers of 1 MB+ how close the speed came to what this user should get.
  transfer(vu, bytes, needRate) {
    bytes = Math.max(1000, Math.round(bytes));
    const rate = vu.line; // pace to the user's line speed (0 = as fast as possible)
    const t0 = performance.now();
    return new Promise((resolve) => {
      let done = false;
      let got = 0;
      let tFirst = 0;
      let next = 0;
      let sock = null;
      const finish = (err) => {
        if (done) return;
        done = true;
        if (tFirst) this.connected--;
        if (sock) sock.destroy();
        vu.sock = null;
        if (!vu.alive) return resolve();
        if (got >= bytes) {
          vu.online = true;
          const secs = (performance.now() - tFirst) / 1000;
          const expect = needRate || rate;
          if (bytes >= MB && expect && secs > 0) this.meter.recQuality(Math.min(1, bytes / secs / expect));
        } else {
          vu.online = false;
          this.meter.rec(false, null, err || (tFirst ? 'reset' : 'connect'));
        }
        resolve();
      };
      SocksClient.createConnection({
        proxy: { host: '127.0.0.1', port: vu.port, type: 5 },
        command: 'connect',
        destination: { host: this.p.blobHost, port: this.p.blobPort },
        timeout: this.p.timeoutMs,
      }).then(({ socket }) => {
        sock = socket;
        if (!vu.alive) return finish();
        vu.sock = socket;
        socket.setNoDelay(true);
        socket.on('error', (e) => finish(e.code || 'sock'));
        socket.on('close', () => finish(got >= bytes ? null : 'closed'));
        socket.setTimeout(this.p.timeoutMs, () => finish('timeout'));
        socket.write(`GET /blob?bytes=${bytes} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
        let header = true;
        socket.on('data', (c) => {
          if (!tFirst) {
            tFirst = performance.now();
            this.connected++;
            this.meter.rec(true, tFirst - t0);
            next = tFirst;
          }
          this.meter.addBytes(c.length);
          if (header) {
            const i = c.indexOf('\r\n\r\n');
            if (i < 0) return;
            header = false;
            c = c.subarray(i + 4);
          }
          got += c.length;
          if (got >= bytes) return finish();
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

  // ---------- steady traffic ----------
  async loop(vu) {
    if (this.real) return this.realLoop(vu);
    await sleep(Math.random() * 1000);
    const port = vu.port || this.cores.ports[vu.id % this.cores.ports.length];
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
        if (!vu.alive) { socket.destroy(); return resolve(); }
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

  // steady: open download streams. real: users whose last request went through (online), like "connected users".
  activeStreams() {
    return this.real ? this.vus.filter((v) => v.online).length : this.connected;
  }

  // transfers in flight right now (real mode): how many users are actually pulling data this second
  busy() {
    return this.connected;
  }

  async stop() {
    this.stopped = true;
    this.vus.forEach((v) => { v.alive = false; if (v.sock) v.sock.destroy(); });
    this.vus = [];
    this.cores.stop();
  }
}

module.exports = { VpnEngine };
