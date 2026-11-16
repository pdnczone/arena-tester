'use strict';
// Per-target rolling metrics. tick() is called once per second.

class Meter {
  constructor() {
    this.reset();
  }

  reset() {
    this.cur = { ok: 0, fail: 0, lat: [], bytes: 0 };
    this.win = [];
    this.totalBytes = 0;
    this.totalOps = 0;
    this.totalFail = 0;
    this.errors = {};
    this.q = []; // [time, ratio] speed quality of finished transfers (real traffic)
    this.db = []; // [time, ok, ms] user creations on the panel (its database at work)
    this.dbOk = 0;
    this.dbFail = 0;
    this.dbFailStreak = 0;
    this.ev = []; // [time, kind, score] what users did (real traffic): 1 satisfied, 0.5 tolerable, 0 frustrated
    this.pr = []; // [time, ms] tiny request on a fresh connection: how fast the VPN feels
  }

  recEvent(kind, score) {
    this.ev.push([Date.now(), kind, score]);
  }

  recProbe(ms) {
    this.pr.push([Date.now(), ms]);
  }

  recDb(ok, ms, err) {
    this.db.push([Date.now(), ok, ms]);
    if (ok) { this.dbOk++; this.dbFailStreak = 0; } else {
      this.dbFail++;
      this.dbFailStreak++;
      const k = 'ساخت کاربر: ' + (err || 'error');
      this.errors[k] = (this.errors[k] || 0) + 1;
    }
  }

  // ratio = speed this transfer got / speed the user should get (1 = full speed). Kept for 15 s.
  recQuality(r) {
    this.q.push([Date.now(), r]);
  }

  rec(ok, ms, err) {
    if (ok) this.cur.ok++;
    else {
      this.cur.fail++;
      this.totalFail++;
      if (err) this.errors[err] = (this.errors[err] || 0) + 1;
    }
    this.totalOps++;
    if (ms != null && this.cur.lat.length < 20000) this.cur.lat.push(ms);
  }

  addBytes(n) {
    this.cur.bytes += n;
    this.totalBytes += n;
  }

  topErrors(n = 3) {
    return Object.entries(this.errors)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([k, v]) => `${k} ×${v}`);
  }

  tick() {
    const c = this.cur;
    this.cur = { ok: 0, fail: 0, lat: [], bytes: 0 };
    this.win.push(c);
    if (this.win.length > 3) this.win.shift();
    let ok = 0;
    let fail = 0;
    const lat = [];
    for (const w of this.win) {
      ok += w.ok;
      fail += w.fail;
      for (const l of w.lat) lat.push(l);
    }
    lat.sort((a, b) => a - b);
    const q = (p) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * p))] : 0);
    const winOps = ok + fail;
    const cut = Date.now() - 15000;
    while (this.q.length && this.q[0][0] < cut) this.q.shift();
    const qs = this.q.map((x) => x[1]).sort((a, b) => a - b);
    while (this.db.length && this.db[0][0] < cut) this.db.shift();
    const dbMs = this.db.filter((x) => x[1]).map((x) => x[2]).sort((a, b) => a - b);
    const dbBad = this.db.filter((x) => !x[1]).length;
    // what users feel, over the last 30 s (activities take seconds to minutes, so a longer window than errors)
    const cut30 = Date.now() - 30000;
    while (this.ev.length && this.ev[0][0] < cut30) this.ev.shift();
    while (this.pr.length && this.pr[0][0] < cut30) this.pr.shift();
    const kinds = {};
    for (const [, k, v] of this.ev) { const o = (kinds[k] = kinds[k] || { n: 0, s: 0 }); o.n++; o.s += v; }
    const vid = this.ev.filter((x) => x[1] === 'video');
    const pms = this.pr.map((x) => x[1]).sort((a, b) => a - b);
    const pq = (f) => (pms.length ? Math.round(pms[Math.min(pms.length - 1, Math.floor(pms.length * f))]) : null);
    return {
      ops: c.ok + c.fail,
      okOps: c.ok,
      failOps: c.fail,
      winOps,
      errPct: winOps ? (fail / winOps) * 100 : 0,
      p50: q(0.5),
      p95: q(0.95),
      mbps: (c.bytes * 8) / 1e6,
      totalGB: this.totalBytes / 1e9,
      errors: this.topErrors(),
      qualityPct: qs.length ? Math.round(qs[Math.floor(qs.length / 2)] * 100) : null,
      qN: qs.length,
      dbN: this.db.length, // user creations in the last 15 s
      dbP95: dbMs.length ? Math.round(dbMs[Math.min(dbMs.length - 1, Math.floor(dbMs.length * 0.95))]) : null,
      dbAvg: dbMs.length ? Math.round(dbMs.reduce((a, b) => a + b, 0) / dbMs.length) : null,
      dbFailPct: this.db.length ? Math.round((dbBad / this.db.length) * 100) : 0,
      apdexN: this.ev.length,
      apdex: this.ev.length ? Math.round((this.ev.reduce((a, x) => a + x[2], 0) / this.ev.length) * 100) : null,
      apdexBy: Object.fromEntries(Object.entries(kinds).map(([k, o]) => [k, Math.round((o.s / o.n) * 100)])),
      videoN: vid.length,
      stallPct: vid.length ? Math.round((vid.filter((x) => x[2] === 0).length / vid.length) * 100) : 0,
      probeN: pms.length,
      probeP50: pq(0.5),
      probeP95: pq(0.95),
      dbOk: this.dbOk,
      dbFail: this.dbFail,
    };
  }
}

module.exports = { Meter };
