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
    };
  }
}

module.exports = { Meter };
