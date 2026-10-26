'use strict';
// Orchestrates a run: ramps virtual users on each target, polls agents, detects the breaking point.
const { EventEmitter } = require('events');
const { Meter } = require('./meter');
const { PanelEngine } = require('./panelEngine');
const { VpnEngine } = require('./vpnEngine');
const { pollAgent } = require('./agentClient');
const { panelStats } = require('./drivers');
const local = require('./localStats');

// Server stats: the agent when installed, otherwise the panel's own API (cached, polled at most every 2 s).
const pollStats = async (t) => (t.agentUrl ? pollAgent(t) : panelStats(t));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};
const r1 = (n) => Math.round(n * 10) / 10;

class Runner extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.state = { status: 'idle', targets: {}, warnings: [], events: [] };
    this.stopFlag = false;
  }

  snapshot() {
    return this.state;
  }

  isRunning() {
    return ['starting', 'running', 'cooldown', 'stopping'].includes(this.state.status);
  }

  push(kind, text, id, extra = {}) {
    const ev = { at: Date.now(), kind, text, id, ...extra };
    this.state.events.push(ev);
    this.emit('event', ev);
  }

  setStatus(s) {
    this.state.status = s;
    this.emit('status', s);
  }

  start(overrides = {}) {
    if (this.isRunning()) throw new Error('a test is already running');
    const cfg = this.store.get();
    const p = { ...cfg.test, ...overrides };
    for (const k of ['startUsers', 'stepUsers', 'stepSeconds', 'maxUsers', 'graceSec', 'thinkMs', 'timeoutMs', 'sessions', 'subPct', 'maxErrPct', 'maxP95Ms', 'userKbps', 'minUserPct', 'cooldownSec', 'holdAfterBreakSec'])
      p[k] = Number(p[k]);
    p.stepUsers = Math.max(1, p.stepUsers);
    p.stepSeconds = Math.max(3, p.stepSeconds);
    p.graceSec = Math.min(p.graceSec, p.stepSeconds - 1);
    p.blobHost = cfg.generator.publicHost;
    p.nicMbps = Number(cfg.generator.nicMbps) || 1000;
    p.blobPort = Number(cfg.generator.blobPort) || 8081;
    const targets = cfg.targets.filter((t) => t.enabled !== false);
    if (!targets.length) throw new Error('no enabled target');

    this.stopFlag = false;
    this.p = p;
    this.state = {
      status: 'starting', type: p.type, mode: p.mode, params: p, startedAt: Date.now(), phase: 0,
      warnings: [], events: [], gen: null, winner: null,
      targets: Object.fromEntries(targets.map((t, i) => [t.id, {
        id: t.id, name: t.name, color: t.color, kind: t.kind, status: 'waiting', users: 0, active: 0, protocol: '',
        series: [], steps: [], result: null, error: null, brokeAt: null, errors: [], idx: i,
      }])),
    };
    this.emit('snapshot', this.state);
    const phases = p.mode === 'parallel' ? [targets] : targets.map((t) => [t]);
    this.main(phases).catch((e) => {
      this.push('error', 'internal error: ' + e.message);
      this.setStatus('done');
    });
    return this.state;
  }

  stop() {
    if (!this.isRunning()) return;
    this.stopFlag = true;
    this.setStatus('stopping');
  }

  async main(phases) {
    for (let i = 0; i < phases.length && !this.stopFlag; i++) {
      this.state.phase = i;
      await this.runPhase(phases[i]);
      if (i < phases.length - 1 && !this.stopFlag) await this.cooldown(phases[i], this.p.cooldownSec);
    }
    this.finish();
  }

  async runPhase(phase) {
    const p = this.p;
    const rts = [];
    const basePort = 20000;
    await Promise.all(phase.map(async (t, i) => {
      const st = this.state.targets[t.id];
      const meter = new Meter();
      const engine = p.type === 'vpn' ? new VpnEngine(t, p, meter, basePort + st.idx * 4000) : new PanelEngine(t, p, meter);
      try {
        await engine.start();
      } catch (e) {
        st.status = 'error';
        st.error = e.message;
        this.push('error', `${t.name}: ${e.message}`, t.id);
        await engine.stop().catch(() => {});
        return;
      }
      st.protocol = engine.protocols || '';
      if (engine.warn) this.push('warn', `${t.name}: ${engine.warn}`, t.id);
      st.status = 'running';
      rts.push({ t, st, meter, engine, t0: 0, breach: 0, genHot: 0, stepIdx: -1, stepStart: 0, brokeAtT: null });
    }));
    if (!rts.length || this.stopFlag) {
      for (const rt of rts) await rt.engine.stop();
      return;
    }
    this.setStatus('running');
    const T0 = Date.now();
    rts.forEach((rt) => (rt.t0 = T0));
    const lastStep = Math.ceil((p.maxUsers - p.startUsers) / p.stepUsers);
    let tick = 0;

    while (!this.stopFlag && rts.some((rt) => rt.st.status === 'running' || rt.st.status === 'broken')) {
      tick++;
      const wait = T0 + tick * 1000 - Date.now();
      if (wait > 0) await sleep(wait);
      const tSec = tick;
      const [gen, ...agents] = await Promise.all([Promise.resolve(local.get()), ...rts.map((rt) => pollStats(rt.t))]);
      this.state.gen = gen;

      rts.forEach((rt, i) => {
        const st = rt.st;
        if (st.status !== 'running' && st.status !== 'broken') return;
        const stepIdx = Math.floor((tSec - 1) / p.stepSeconds);
        if (st.status === 'running') {
          if (stepIdx !== rt.stepIdx) {
            if (rt.stepIdx >= 0) this.closeStep(rt);
            rt.stepIdx = stepIdx;
            rt.stepStart = stepIdx * p.stepSeconds;
          }
          if (stepIdx > lastStep) {
            this.closeStep(rt);
            st.status = 'finished';
            this.push('ok', `${st.name}: reached ${p.maxUsers} users without breaking`, st.id);
            this.endTarget(rt);
            return;
          }
          st.users = Math.min(p.maxUsers, p.startUsers + stepIdx * p.stepUsers);
          rt.engine.setUsers(st.users);
        } else if (tSec - rt.brokeAtT >= p.holdAfterBreakSec) {
          this.closeStep(rt);
          st.status = 'finished';
          this.endTarget(rt);
          return;
        }

        const m = rt.meter.tick();
        const a = agents[i];
        st.active = p.type === 'vpn' ? rt.engine.activeStreams() : st.users;
        const pt = {
          t: tSec, users: st.status === 'broken' ? rt.engine.users() : st.users, active: st.active, step: rt.stepIdx,
          rps: m.ops, okOps: m.okOps, errPct: r1(m.errPct), p50: Math.round(m.p50), p95: Math.round(m.p95),
          mbps: r1(m.mbps), userKbps: p.type === 'vpn' && st.active > 0 ? Math.round((m.mbps * 1000) / st.active) : 0,
          cpu: a ? a.cpu : null, memPct: a ? a.memPct : null, rx: a ? a.rx : null, tx: a ? a.tx : null, tcp: a ? a.tcp : null,
          panelCpu: a ? a.panelCpu : null, panelMem: a ? a.panelMem : null, coreCpu: a ? a.coreCpu : null, coreMem: a ? a.coreMem : null,
          cores: a ? a.cores : null, memTotalMB: a ? a.memTotalMB : null, genCpu: gen.cpu, genTx: gen.txMbps, genRx: gen.rxMbps, agent: !!a,
        };
        const nicHot = Math.max(gen.txMbps || 0, gen.rxMbps || 0) > p.nicMbps * 0.85;
        rt.genHot = gen.cpu > 85 || nicHot ? rt.genHot + 1 : 0;
        pt.genLimited = rt.genHot >= 3;
        if (pt.genLimited && !this.state.warnings.includes('gen')) {
          this.state.warnings.push('gen');
          this.push('warn', nicHot ? `Load generator network card is above 85% of ${p.nicMbps} Mbps — the result is limited by this machine's NIC, not by the panels` : `Load generator CPU is ${gen.cpu}% — results may be limited by this machine, not by the panels`);
        }
        st.series.push(pt);
        st.errors = m.errors;
        st.totalGB = r1(m.totalGB * 10) / 10;

        if (st.status === 'running' && tSec - rt.stepStart >= p.graceSec) {
          const why = this.breachReason(pt);
          rt.breach = why ? rt.breach + 1 : 0;
          pt.breach = !!why;
          if (rt.breach >= 3) {
            st.status = 'broken';
            rt.brokeAtT = tSec;
            st.brokeAt = { users: pt.users, t: tSec, reason: why };
            this.push('break', `${st.name} broke at ${pt.users} users — ${why}`, st.id, { users: pt.users });
          }
        }
      });
      this.emit('tick', this.tickPayload(rts));
    }
    for (const rt of rts) {
      if (rt.st.status === 'running' || rt.st.status === 'broken') {
        this.closeStep(rt);
        rt.st.status = this.stopFlag ? 'stopped' : 'finished';
        this.endTarget(rt);
      }
      await rt.engine.stop();
    }
  }

  breachReason(pt) {
    const p = this.p;
    if (pt.errPct > p.maxErrPct && pt.rps >= 5) return `error rate ${pt.errPct}% > ${p.maxErrPct}%`;
    if (pt.p95 > p.maxP95Ms) return `p95 latency ${pt.p95} ms > ${p.maxP95Ms} ms`;
    if (p.type === 'vpn' && p.userKbps > 0 && pt.active >= 10 && pt.userKbps < (p.userKbps * p.minUserPct) / 100)
      return `per-user speed ${pt.userKbps} kbps < ${Math.round((p.userKbps * p.minUserPct) / 100)} kbps`;
    return null;
  }

  closeStep(rt) {
    const p = this.p;
    const pts = rt.st.series.filter((x) => x.step === rt.stepIdx && x.t - rt.stepStart >= p.graceSec);
    if (!pts.length || rt.st.steps.some((s) => s.step === rt.stepIdx)) return;
    const f = (k) => pts.map((x) => x[k]).filter((v) => v != null);
    const sum = {
      step: rt.stepIdx, users: pts[pts.length - 1].users, rps: r1(avg(f('rps'))), errPct: r1(avg(f('errPct'))),
      p95: Math.round(median(f('p95'))), mbps: r1(avg(f('mbps'))), userKbps: Math.round(avg(f('userKbps'))),
      cpu: f('cpu').length ? r1(avg(f('cpu'))) : null, memPct: f('memPct').length ? r1(avg(f('memPct'))) : null,
      panelCpu: f('panelCpu').length ? r1(avg(f('panelCpu'))) : null, coreCpu: f('coreCpu').length ? r1(avg(f('coreCpu'))) : null,
      panelMem: f('panelMem').length ? r1(avg(f('panelMem'))) : null, coreMem: f('coreMem').length ? r1(avg(f('coreMem'))) : null,
      genLimited: pts.some((x) => x.genLimited),
    };
    sum.ok = !this.breachReason({ errPct: sum.errPct, rps: sum.rps, p95: sum.p95, active: sum.users, userKbps: sum.userKbps });
    rt.st.steps.push(sum);
    this.emit('step', { id: rt.st.id, step: sum });
  }

  endTarget(rt) {
    const st = rt.st;
    rt.engine.stop().catch(() => {});
    let capacity = 0;
    for (const s of st.steps) {
      if (!s.ok || (st.brokeAt && s.users >= st.brokeAt.users)) break;
      capacity = s.users;
    }
    const reachedMax = st.status === 'finished' && !st.brokeAt && capacity >= this.p.maxUsers;
    const s = st.series;
    const mx = (k) => Math.max(0, ...s.map((x) => x[k] || 0));
    st.result = {
      capacity, brokeAt: st.brokeAt ? st.brokeAt.users : null, reason: st.brokeAt ? st.brokeAt.reason : null, reachedMax,
      peakRps: mx('rps'), peakMbps: mx('mbps'), peakCpu: mx('cpu'), peakMem: mx('memPct'), peakP95: mx('p95'),
      peakTcp: mx('tcp'),
      coreCpuPer100Mbps: (() => {
        const ss = st.steps.filter((x) => x.mbps > 10 && x.coreCpu != null);
        return ss.length ? r1(avg(ss.map((x) => (x.coreCpu / x.mbps) * 100))) : null;
      })(), totalGB: st.totalGB || 0, genLimited: st.steps.some((x) => x.genLimited),
    };
    this.emit('target', { id: st.id, status: st.status, result: st.result });
  }

  async cooldown(phase, sec) {
    this.setStatus('cooldown');
    const p = this.p;
    for (let i = 1; i <= sec && !this.stopFlag; i++) {
      await sleep(1000);
      this.state.cooldownLeft = sec - i;
      const gen = local.get();
      const agents = await Promise.all(phase.map((t) => pollStats(t)));
      phase.forEach((t, k) => {
        const a = agents[k];
        const st = this.state.targets[t.id];
        if (!st || !a) return;
        const last = st.series[st.series.length - 1];
        st.series.push({ t: (last ? last.t : 0) + 1, users: 0, active: 0, step: -1, rps: 0, okOps: 0, errPct: 0, p50: 0, p95: 0, mbps: 0, userKbps: 0, cpu: a.cpu, memPct: a.memPct, rx: a.rx, tx: a.tx, tcp: a.tcp, panelCpu: a.panelCpu, panelMem: a.panelMem, coreCpu: a.coreCpu, coreMem: a.coreMem, genCpu: gen.cpu, cooling: true });
      });
      this.emit('tick', { status: 'cooldown', cooldownLeft: sec - i, gen, targets: Object.fromEntries(phase.map((t) => [t.id, { status: this.state.targets[t.id].status, point: this.state.targets[t.id].series.slice(-1)[0] }])) });
    }
    this.state.cooldownLeft = 0;
    this.setStatus('running');
  }

  tickPayload(rts) {
    return {
      status: this.state.status, gen: this.state.gen, warnings: this.state.warnings,
      targets: Object.fromEntries(rts.map((rt) => [rt.st.id, {
        status: rt.st.status, users: rt.st.users, active: rt.st.active, point: rt.st.series[rt.st.series.length - 1],
        errors: rt.st.errors, totalGB: rt.st.totalGB, protocol: rt.st.protocol, brokeAt: rt.st.brokeAt,
      }])),
    };
  }

  finish() {
    const ts = Object.values(this.state.targets).filter((t) => t.result);
    if (ts.length >= 2) {
      const [a, b] = ts;
      const score = (t) => (t.result.reachedMax ? this.p.maxUsers + 1 : t.result.capacity);
      if (score(a) === score(b)) {
        const pa = a.steps.length ? a.steps[a.steps.length - 1].p95 : 0;
        const pb = b.steps.length ? b.steps[b.steps.length - 1].p95 : 0;
        this.state.winner = Math.abs(pa - pb) < 0.1 * Math.max(pa, pb, 1) ? 'tie' : pa < pb ? a.id : b.id;
      } else this.state.winner = score(a) > score(b) ? a.id : b.id;
    }
    this.setStatus(this.stopFlag ? 'stopped' : 'done');
    this.emit('done', this.state);
  }

  report() {
    const s = this.state;
    return {
      startedAt: s.startedAt, type: s.type, mode: s.mode, params: { ...s.params, blobHost: undefined }, winner: s.winner,
      targets: Object.fromEntries(Object.values(s.targets).map((t) => [t.id, { name: t.name, protocol: t.protocol, result: t.result, steps: t.steps, series: t.series }])),
    };
  }
}

module.exports = { Runner };
