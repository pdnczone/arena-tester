'use strict';
// VPN traffic engine. Every simulated user is tied to one test config (= one user on the panel's test inbound) and
// all its traffic goes through that config: local Xray/sing-box SOCKS port -> panel inbound -> back to this machine.
//   real   (default): each user is a phone: its own line speed, background connections that stay open, and
//                     activities like a person (messenger, Instagram, browsing, video, downloads) — see realLoop.
//   steady:           each user is one endless download at the configured speed (old behaviour).
const { SocksClient } = require('socks');
const { Cores } = require('./cores');
const links = require('./links');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uni = (a, b) => a + Math.random() * (b - a);
const logUni = (a, b) => Math.exp(uni(Math.log(a), Math.log(b))); // sizes: many small, few large
const MB = 1e6;
const sum = (a) => a.reduce((x, y) => x + y, 0);

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

// One connection of a user through their own config, reused for several requests (HTTP keep-alive), like an app
// or a browser does. get(bytes) fetches one object and resolves { ok, ms, err } — ms includes connecting when
// the connection had to be opened first.
class Conn {
  constructor(engine, vu) {
    this.e = engine;
    this.vu = vu;
    this.sock = null;
    this.cur = null;
  }

  async get(bytes) {
    for (let attempt = 0; ; attempt++) {
      const reused = !!this.sock;
      const r = await this.once(bytes);
      if (r.ok || !this.vu.alive) return r;
      // the server had just closed this idle connection: open a new one, like a browser does, not an error
      if (reused && !r.first && attempt === 0) continue;
      this.e.meter.rec(false, null, r.err);
      return r;
    }
  }

  once(bytes) {
    const t0 = performance.now();
    return new Promise((resolve) => {
      const go = () => {
        this.cur = { resolve, bytes, got: 0, hdr: Buffer.alloc(0), t0, first: 0 };
        this.sock.write(`GET /blob?bytes=${bytes} HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n`);
      };
      if (this.sock) return go();
      SocksClient.createConnection({
        proxy: { host: '127.0.0.1', port: this.vu.port, type: 5 },
        command: 'connect',
        destination: { host: this.e.p.blobHost, port: this.e.p.blobPort },
        timeout: this.e.p.timeoutMs,
      }).then(({ socket }) => {
        if (!this.vu.alive || this.closed) { socket.destroy(); return resolve({ ok: false, err: 'stopped', ms: 0 }); }
        this.sock = socket;
        this.e.track(this.vu, socket);
        socket.setNoDelay(true);
        socket.setTimeout(this.e.p.timeoutMs, () => { if (socket === this.sock) this.cur ? this.fail('timeout') : this.drop(); });
        socket.on('data', (c) => { if (socket === this.sock) this.onData(c); });
        socket.on('error', (e) => { if (socket === this.sock) this.fail(e.code || 'sock'); });
        socket.on('close', () => { if (socket === this.sock) this.fail(this.cur && this.cur.first ? 'reset' : 'closed'); });
        go();
      }).catch((e) => resolve({ ok: false, err: e.code || String(e.message).slice(0, 40), ms: performance.now() - t0 }));
    });
  }

  onData(c) {
    const r = this.cur;
    if (!r) return;
    this.e.meter.addBytes(c.length);
    if (!r.first) {
      r.first = performance.now();
      this.e.meter.rec(true, r.first - r.t0);
    }
    if (r.hdr) {
      r.hdr = Buffer.concat([r.hdr, c]);
      const i = r.hdr.indexOf('\r\n\r\n');
      if (i < 0) { if (r.hdr.length > 8192) this.fail('bad reply'); return; }
      c = r.hdr.subarray(i + 4);
      r.hdr = null;
    }
    r.got += c.length;
    if (this.sock) this.e.pace(this.vu, this.sock, c.length);
    if (r.got >= r.bytes) {
      this.cur = null;
      r.resolve({ ok: true, ms: performance.now() - r.t0 });
    }
  }

  fail(err) {
    const r = this.cur;
    this.drop();
    if (!r) return;
    this.cur = null;
    r.resolve({ ok: false, err, first: r.first, ms: performance.now() - r.t0 });
  }

  drop() {
    const s = this.sock;
    this.sock = null;
    if (s) s.destroy();
  }

  close() {
    this.closed = true;
    this.drop();
  }
}

class VpnEngine {
  constructor(target, p, meter, basePort) {
    this.t = target;
    this.p = p;
    this.meter = meter;
    this.vus = [];
    this.seq = 0;
    this.connected = 0;
    this.open = 0; // sockets open through the VPN (real traffic)
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
      while (this.vus.length > n) this.kill(this.vus.pop());
      if (!this.growing) this.growing = this.grow().finally(() => { this.growing = null; });
      return;
    }
    while (this.vus.length < n) {
      const vu = { alive: true, id: this.seq++, sock: null, socks: new Set() };
      this.vus.push(vu);
      this.loop(vu);
    }
    while (this.vus.length > n) this.kill(this.vus.pop());
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
        const vu = { alive: true, id, sock: null, socks: new Set(), port: this.cores.ports[this.vus.length % this.cores.ports.length] };
        this.vus.push(vu);
        this.loop(vu);
      }
      if (this.meter.dbFailStreak >= 20) return;
    }
  }

  created() {
    return this.links.length;
  }

  // ---------- real traffic: every user is a phone ----------
  // - background: 3–8 connections that stay open for minutes (messengers, push, app keep-alives) and get a few
  //   hundred bytes now and then; apps reopen them every few minutes. This is what fills Xray's memory, the
  //   server's socket table and conntrack with real users, even when they move almost no data.
  // - foreground: what the person is doing right now (messenger, Instagram, browsing, video, a download) with
  //   parallel and reused connections like a real app or browser, and pauses in between.
  // - every 20–40 s a tiny request on a fresh connection: how fast the VPN feels (connect + handshake + reply).
  // Everything the user does is scored like Apdex: satisfied (1), tolerable (0.5) or frustrated (0).
  async realLoop(vu) {
    const cap = this.p.userKbps > 0 ? this.p.userKbps * 125 : 0; // bytes/s
    // this person's line: random up to the cap; with no cap a realistic spread of 4–30 Mbps (mobile / home)
    vu.rate = cap ? cap * uni(0.25, 1) : logUni(4, 30) * 125000;
    vu.next = 0;
    vu.holdsOpen = 0;
    if (!vu.port) vu.port = this.cores.ports[vu.id % this.cores.ports.length];
    await sleep(Math.random() * 5000);
    if (!vu.alive) return;
    const holds = 3 + Math.floor(Math.random() * 6);
    for (let i = 0; i < holds; i++) this.holdLoop(vu, i * 700 + Math.random() * 3000);
    this.probeLoop(vu);
    while (vu.alive) {
      const act = pickActivity();
      const until = Date.now() + uni(30, 180) * 1000;
      try { await this.activity(vu, act, until); } catch { await sleep(1000); }
    }
  }

  async activity(vu, act, until) {
    const live = () => vu.alive && Date.now() < until;
    if (act === 'chat') {
      // text goes over the held connections; now and then a photo, voice note or sticker from the media server
      while (live()) {
        await sleep(uni(5, 40) * 1000);
        if (!live() || Math.random() > 0.35) continue;
        const bytes = logUni(30e3, 1.5e6);
        this.score(vu, 'chat', await this.fetch(vu, [bytes], 1), bytes, 2000);
      }
    } else if (act === 'social') {
      const conns = [new Conn(this, vu), new Conn(this, vu)]; // the app keeps its CDN connections
      try {
        while (live()) {
          if (Math.random() < 0.55) {
            const items = Array.from({ length: 3 + Math.floor(Math.random() * 6) }, () => logUni(60e3, 500e3));
            this.score(vu, 'social', await this.fetchOn(conns, items), sum(items), 2500);
            await sleep(uni(3, 12) * 1000);
          } else {
            const reel = logUni(0.8e6, 4e6);
            this.score(vu, 'social', await this.fetchOn([conns[0]], [reel]), reel, 2500);
            await sleep(uni(6, 25) * 1000);
          }
        }
      } finally { conns.forEach((c) => c.close()); }
    } else if (act === 'web') {
      while (live()) {
        // one page: 15–45 objects from 4–10 hosts, fetched in parallel, several per connection
        const items = Array.from({ length: 15 + Math.floor(Math.random() * 31) }, () => logUni(2e3, 250e3));
        this.score(vu, 'web', await this.fetch(vu, items, 4 + Math.floor(Math.random() * 7)), sum(items), 3000);
        await sleep(uni(8, 40) * 1000);
      }
    } else if (act === 'video') {
      // the player picks a quality the line can carry, buffers 3 segments, then fetches one 4 s segment every 4 s
      const c = new Conn(this, vu);
      const rate = Math.min(logUni(1.5, 6) * 125000, vu.rate * 0.75);
      let n = 0;
      try {
        while (live()) {
          const t0 = Date.now();
          const r = await c.get(Math.round(rate * 4 * uni(0.85, 1.15)));
          if (!vu.alive) break;
          // on time = smooth; up to 1.5x = the buffer hides it; slower or failed = the video stalls
          this.meter.recEvent('video', !r.ok ? 0 : r.ms <= 4000 ? 1 : r.ms <= 6000 ? 0.5 : 0);
          if (!r.ok) await sleep(2000);
          if (++n > 3) await sleep(Math.max(0, 4000 - (Date.now() - t0)));
        }
      } finally { c.close(); }
    } else {
      const bytes = logUni(10e6, 150e6);
      const r = await this.fetch(vu, [bytes], 1);
      if (vu.alive) {
        const ratio = r.ok ? bytes / (r.ms / 1000) / vu.rate : 0; // share of the line speed the download got
        this.meter.recEvent('download', ratio >= 0.5 ? 1 : ratio >= 0.2 ? 0.5 : 0);
      }
      await sleep(uni(5, 20) * 1000);
    }
  }

  // Apdex for one thing the user did: what their own line needs for it anyway, plus the wait people accept.
  score(vu, kind, r, bytes, baseMs) {
    if (!vu.alive) return;
    if (!r.ok) return this.meter.recEvent(kind, 0);
    const T = baseMs + (bytes / vu.rate) * 1000 * 1.3;
    this.meter.recEvent(kind, r.ms <= T ? 1 : r.ms <= 4 * T ? 0.5 : 0);
  }

  // Fetch objects over the given connections in parallel, several per connection (keep-alive).
  async fetchOn(conns, sizes) {
    const t0 = performance.now();
    const lanes = conns.map(() => []);
    sizes.forEach((b, i) => lanes[i % conns.length].push(Math.max(500, Math.round(b))));
    let ok = true;
    let err = null;
    await Promise.all(lanes.map(async (lane, i) => {
      for (const b of lane) {
        if (!ok) return;
        const r = await conns[i].get(b);
        if (!r.ok) { ok = false; err = r.err; }
      }
    }));
    return { ok, err, ms: performance.now() - t0 };
  }

  async fetch(vu, sizes, parallel) {
    const conns = Array.from({ length: Math.max(1, Math.min(parallel, sizes.length)) }, () => new Conn(this, vu));
    try { return await this.fetchOn(conns, sizes); } finally { conns.forEach((c) => c.close()); }
  }

  // All of a user's connections share one line: pause a socket when the user is ahead of their line speed.
  pace(vu, sock, n) {
    const now = performance.now();
    vu.next = Math.max(vu.next, now) + (n / vu.rate) * 1000;
    const wait = vu.next - now;
    if (wait > 30 && !sock.isPaused()) {
      sock.pause();
      setTimeout(() => { if (!sock.destroyed) sock.resume(); }, wait);
    }
  }

  async holdLoop(vu, delay) {
    await sleep(delay);
    while (vu.alive) {
      const ok = await this.hold(vu, uni(120, 600) * 1000);
      if (vu.alive && !ok) await sleep(uni(2, 5) * 1000); // dropped: the app reconnects
    }
  }

  // One background connection: open, receive a little every 20–60 s, close after `life` ms like apps do.
  hold(vu, life) {
    const every = Math.round(uni(20, 60));
    const t0 = performance.now();
    return new Promise((resolve) => {
      let sock = null;
      let done = false;
      let first = false;
      let timer = null;
      const end = (ok, err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (sock) sock.destroy();
        if (!ok && vu.alive) this.meter.rec(false, null, err);
        resolve(ok);
      };
      SocksClient.createConnection({
        proxy: { host: '127.0.0.1', port: vu.port, type: 5 },
        command: 'connect',
        destination: { host: this.p.blobHost, port: this.p.blobPort },
        timeout: this.p.timeoutMs,
      }).then(({ socket }) => {
        sock = socket;
        if (!vu.alive || done) return end(true);
        this.track(vu, socket);
        socket.on('close', () => { if (first) vu.holdsOpen--; end(false, first ? 'idle-drop' : 'closed'); });
        socket.on('error', (e) => end(false, first ? 'idle-drop' : e.code || 'sock'));
        socket.setTimeout((every + 25) * 1000, () => end(false, first ? 'idle-timeout' : 'timeout'));
        socket.on('data', (c) => {
          this.meter.addBytes(c.length);
          if (first) return;
          first = true;
          vu.holdsOpen++;
          this.meter.rec(true, performance.now() - t0);
          timer = setTimeout(() => end(true), life);
        });
        socket.write(`GET /hold?every=${every} HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n`);
      }).catch((e) => end(false, e.code || String(e.message).slice(0, 40)));
    });
  }

  async probeLoop(vu) {
    await sleep(uni(2, 20) * 1000);
    while (vu.alive) {
      const c = new Conn(this, vu);
      const r = await c.get(1000);
      c.close();
      if (!vu.alive) return;
      this.meter.recProbe(r.ok ? r.ms : this.p.timeoutMs); // a failed one counts as the slowest possible
      await sleep(uni(20, 40) * 1000);
    }
  }

  track(vu, socket) {
    vu.socks.add(socket);
    this.open++;
    socket.once('close', () => { this.open--; vu.socks.delete(socket); });
  }

  kill(vu) {
    vu.alive = false;
    if (vu.sock) vu.sock.destroy();
    for (const s of vu.socks) s.destroy();
  }

  // real traffic: connections this machine has open through the VPN right now
  openConns() {
    return this.open;
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

  // steady: open download streams. real: users with at least one background connection open (online).
  activeStreams() {
    return this.real ? this.vus.filter((v) => v.holdsOpen > 0).length : this.connected;
  }

  busy() {
    return this.real ? this.open : this.connected;
  }

  async stop() {
    this.stopped = true;
    this.vus.forEach((v) => this.kill(v));
    this.vus = [];
    this.cores.stop();
  }
}

module.exports = { VpnEngine };
