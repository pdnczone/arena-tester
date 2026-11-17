'use strict';
// Orchestrates a run: ramps virtual users on each target, polls agents, detects the breaking point.
const { EventEmitter } = require('events');
const { Meter } = require('./meter');
const { PanelEngine } = require('./panelEngine');
const { VpnEngine } = require('./vpnEngine');
const { pollAgent } = require('./agentClient');
const { panelStats, getDriver } = require('./drivers');
const fmtGB = (b) => (b >= 1e9 ? (b / 1e9).toFixed(2) + ' GB' : Math.round(b / 1e6) + ' MB');
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
    p.minApdex = Number(p.minApdex) || 85;
    p.confirmSec = p.confirmSec == null ? 120 : Number(p.confirmSec);
    p.connsPerUser = Math.min(1000, Math.max(1, Number(p.connsPerUser) || 100));
    if (p.trafficMode !== 'steady') {
      // real users need time to settle: background connections open, activities run for minutes, sockets and
      // conntrack entries pile up. Shorter steps measure a server that has not felt the load yet.
      p.stepSeconds = Math.max(60, Number(p.stepSeconds) || 60);
      p.graceSec = Math.max(Number(p.graceSec) || 0, 20);
    }
    p.stepUsers = Math.max(1, p.stepUsers);
    p.stepSeconds = Math.max(3, p.stepSeconds);
    p.maxUsers = Math.max(1, p.maxUsers);
    p.startUsers = Math.min(Math.max(1, p.startUsers), p.maxUsers);
    p.graceSec = Math.min(p.graceSec, p.stepSeconds - 1);
    p.type = 'vpn';
    p.blobHost = cfg.generator.publicHost;
    p.nicMbps = Number(cfg.generator.nicMbps) || 1000;
    p.blobPort = Number(cfg.generator.blobPort) || 8081;
    const enabled = cfg.targets.filter((t) => t.enabled !== false);
    if (!enabled.length) throw new Error('هیچ سروری برای تست روشن نیست');
    // A server can take part when the dashboard can create test users on it (panel connected) or it already
    // has configs; for the HTTP test a panel URL with a scenario is enough. Others are skipped, not failed.
    const usable = (t) => !!getDriver(t) || (t.links || []).length > 0 || (t.subscriptionUrls || []).length > 0
      || (p.type !== 'vpn' && !!t.panelUrl && (t.steps || []).length > 0);
    const targets = enabled.filter(usable);
    const skipped = enabled.filter((t) => !usable(t));
    if (!targets.length) {
      throw new Error(`هیچ سروری آماده‌ی تست نیست: ${skipped.map((t) => t.name).join('، ')} — در «سرورها» آدرس و ورود پنل را بدهید یا دستور افزودن سرور را روی آن اجرا کنید`);
    }

    this.stopFlag = false;
    this.ctx = {}; // per-target live test-inbound context (users created during this run)
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
    for (const t of skipped) this.push('warn', `${t.name} تنظیم نشده و از این تست کنار گذاشته شد`, t.id);
    if (local.get().portClash) this.push('warn', 'بازه‌ی پورت‌های خروجی سرور داشبورد پورت‌های 20000 به بالا را هم شامل می‌شود که کلاینت‌های محلی تست روی آن‌ها باز می‌شوند؛ روی همین سرور بزنید: sysctl -w net.ipv4.ip_local_reserved_ports=20000-29999');
    // panels route private addresses to "blocked" by default (3x-ui: geoip:private): every test connection would fail
    if (/^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(p.blobHost || '') && targets.some((t) => t.kind === '3xui'))
      this.push('warn', `آدرس داشبورد (${p.blobHost}) خصوصی است؛ 3x-ui به‌طور پیش‌فرض اتصال به IPهای خصوصی را می‌بندد (در تنظیمات Xray: قانون routing با geoip:private → blocked، و finalRules روی outbound «direct»). اگر همه‌ی اتصال‌ها خطا داد، هر دو را در پنل بردارید یا داشبورد را روی IP عمومی بگذارید`);
    const phases = p.mode === 'parallel' ? [targets] : targets.map((t) => [t]);
    this.main(phases).catch((e) => {
      this.push('error', 'خطای داخلی: ' + e.message);
      this.setStatus('done');
    });
    return this.state;
  }

  stop() {
    if (!this.isRunning()) return;
    this.stopFlag = true;
    this.setStatus('stopping');
  }

  // Real-conditions setup: make sure every server has its own test users + configs on the panel before the
  // ramp starts (one config per simulated user, up to the driver limit). Existing ones are reused.
  async prepare(phases) {
    const p = this.p;
    const need = Math.min(2000, Math.max(1, p.maxUsers));
    await Promise.all(phases.flat().map(async (t) => {
      const d = getDriver(t);
      if (!d || this.stopFlag) return; // manual links / subscriptions only, or the run was stopped
      const pv = t.provision;
      if (d.startTestInbound) {
        const st0 = this.state.targets[t.id];
        st0.status = 'preparing';
        this.emit('target', { id: t.id, status: st0.status });
        try {
          const proto = pv && pv.protocol && pv.protocol !== 'vless' ? pv.protocol : 'reality';
          const ctx = await d.startTestInbound({ protocol: proto, port: (pv && pv.port) || 24443 });
          this.ctx = this.ctx || {};
          this.ctx[t.id] = { d, ctx };
          this.store.setProvision(t.id, { links: [], subscriptionUrls: [], meta: ctx.meta });
          Object.assign(t, this.store.target(t.id));
          this.push('ok', `${t.name}: اینباند تست ساخته شد (${ctx.kind} روی پورت ${ctx.port}) — کاربران حین تست، هم‌زمان با بالا رفتن پله‌ها، یکی‌یکی روی پنل ساخته می‌شوند`, t.id);
        } catch (e) {
          this.push('error', `${t.name}: ساخت اینباند تست ناموفق بود — ${e.message}`, t.id);
        }
        st0.status = 'waiting';
        this.emit('target', { id: t.id, status: st0.status });
        return;
      }
      const have = p.type === 'vpn' ? (t.links || []).length : (t.subscriptionUrls || []).length + (t.links || []).length;
      // plain VLESS (no TLS) cannot be used by current Xray clients: upgrade those to REALITY
      const proto = !pv || !pv.protocol || pv.protocol === 'vless' ? (t.kind === '3xui' ? 'reality' : pv && pv.protocol) : pv.protocol;
      let fresh = have && pv && pv.count >= need && pv.protocol === proto;
      if (fresh && d.liveTestUsers) {
        // the panel may have dropped them (restart, manual delete, old 3x-ui 3.x setup): check before trusting them
        const live = await d.liveTestUsers(pv).catch(() => null);
        if (live !== null && live < Math.min(need, pv.count)) {
          this.push('warn', `${t.name}: فقط ${live} از ${pv.count} کاربر تست روی پنل فعال است؛ دوباره ساخته می‌شوند`, t.id);
          fresh = false;
        }
      }
      if (fresh) return;
      const st = this.state.targets[t.id];
      st.status = 'preparing';
      this.emit('target', { id: t.id, status: st.status });
      this.push('ok', `در حال ساخت ${need} کاربر و کانفیگ تست روی ${t.name}…`, t.id);
      try {
        const r = await d.provision({ count: need, protocol: proto, port: (pv && pv.port) || 24443 });
        this.store.setProvision(t.id, r);
        Object.assign(t, this.store.target(t.id));
        this.push('ok', `${t.name}: ${r.meta.count} کاربر تست ساخته شد (${r.meta.protocol || ''}${r.meta.port ? ' روی پورت ' + r.meta.port : ''})`, t.id);
        if (r.note) this.push('warn', `${t.name}: ${r.note}`, t.id);
      } catch (e) {
        // keep going with what the server already has; the engine reports if that is not enough
        this.push(have ? 'warn' : 'error', `${t.name}: ساخت کاربران تست ناموفق بود — ${e.message}`, t.id);
      }
      st.status = 'waiting';
      this.emit('target', { id: t.id, status: st.status });
    }));
  }

  async main(phases) {
    await this.prepare(phases);
    if (this.stopFlag) return this.finish();
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
      const live = this.ctx && this.ctx[t.id];
      if (live && p.type === 'vpn') engine.provider = { add: () => live.d.addTestUser(live.ctx), label: live.ctx.kind };
      else if (this.ctx && this.ctx[t.id] === undefined && getDriver(t) && getDriver(t).startTestInbound) {
        // the test inbound could not be created: do not fall back to old configs that may not exist any more
        st.status = 'error';
        this.push('error', `${t.name}: بدون اینباند تست نمی‌شود تست گرفت`, t.id);
        return;
      }
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
      // proof that the traffic really goes through the panel's test inbound: its own counter, before vs after
      const drv = p.type === 'vpn' && t.provision ? getDriver(t) : null;
      const before = drv && drv.testInboundTraffic ? await drv.testInboundTraffic(t.provision).catch(() => null) : null;
      if (drv && before === null) this.push('warn', `${t.name}: اینباند تست روی پنل پیدا نشد؛ ترافیک از اینباند ساخته‌شده عبور نمی‌کند`, t.id);
      if (engine.warn) this.push('warn', `${t.name}: ${engine.warn}`, t.id);
      st.status = 'running';
      rts.push({ t, st, meter, engine, drv, before, t0: 0, breach: 0, genHot: 0, stepIdx: -1, stepStart: 0, brokeAtT: null });
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
            const flat = p.trafficMode === 'max' && rt.stepIdx >= 0 && this.plateau(st.steps);
            if (flat) {
              this.breakAt(rt, st.steps[st.steps.length - 1].users, tSec, flat, 'nic');
              st.steps[st.steps.length - 1].ok = false;
              return;
            }
            rt.stepIdx = stepIdx;
            rt.stepStart = stepIdx * p.stepSeconds;
          }
          if (stepIdx > lastStep) {
            this.closeStep(rt);
            st.status = 'finished';
            this.push('ok', `${st.name} تا سقف ${p.maxUsers} کاربر بدون شکست دوام آورد`, st.id);
            this.endTarget(rt);
            return;
          }
          st.users = Math.min(p.maxUsers, p.startUsers + stepIdx * p.stepUsers);
          rt.engine.setUsers(st.users);
        } else if (!rt.confirm && tSec - rt.brokeAtT >= p.holdAfterBreakSec) {
          this.closeStep(rt);
          st.status = 'finished';
          this.endTarget(rt);
          return;
        }

        const m = rt.meter.tick();
        const a = agents[i];
        st.active = p.type === 'vpn' ? rt.engine.activeStreams() : st.users;
        const pt = {
          t: tSec, users: st.status === 'broken' ? rt.engine.users() : st.users, active: st.active, step: rt.confirm ? -2 : rt.stepIdx, confirm: !!rt.confirm,
          rps: m.ops, okOps: m.okOps, errPct: r1(m.errPct), p50: Math.round(m.p50), p95: Math.round(m.p95),
          mbps: r1(m.mbps), userKbps: p.type === 'vpn' && st.active > 0 ? Math.round((m.mbps * 1000) / st.active) : 0,
          qualityPct: m.qualityPct, qN: m.qN,
          apdex: m.apdex, apdexN: m.apdexN, apdexBy: m.apdexBy, stallPct: m.stallPct, videoN: m.videoN,
          probeP50: m.probeP50, probeP95: m.probeP95, probeN: m.probeN, conns: rt.engine.openConns ? rt.engine.openConns() : null,
          created: rt.engine.created ? rt.engine.created() : null, dbP95: m.dbP95, dbAvg: m.dbAvg, dbFailPct: m.dbFailPct, dbN: m.dbN, dbOk: m.dbOk, dbFail: m.dbFail, busy: p.type === 'vpn' && rt.engine.busy ? rt.engine.busy() : null,
          cpu: a ? a.cpu : null, memPct: a ? a.memPct : null, rx: a ? a.rx : null, tx: a ? a.tx : null, tcp: a ? a.tcp : null,
          panelCpu: a ? a.panelCpu : null, panelMem: a ? a.panelMem : null, coreCpu: a ? a.coreCpu : null, coreMem: a ? a.coreMem : null,
          cores: a ? a.cores : null, memTotalMB: a ? a.memTotalMB : null, genCpu: gen.cpu, genTx: gen.txMbps, genRx: gen.rxMbps, genLag: gen.lagMs, agent: !!a,
          ct: a ? a.ct : null, ctMax: a ? a.ctMax : null, swapMB: a ? a.swapMB : null,
          coreFds: a ? a.coreFds : null, coreFdMax: a ? a.coreFdMax : null, portRange: a ? a.portRange : null, linkMbps: a ? a.linkMbps : null,
          load: a ? a.load : null,
        };
        // the VPN core restarting or the kernel killing a process for memory drops every user at once
        if (a && a.coreStart) {
          if (rt.coreStart && a.coreStart !== rt.coreStart) this.push('warn', `${st.name}: هسته‌ی Xray در ${pt.users} کاربر ری‌استارت شد — همه‌ی اتصال‌ها قطع شدند`, st.id);
          rt.coreStart = a.coreStart;
        }
        let oomNow = false;
        if (a && a.oom != null) {
          oomNow = rt.oom != null && a.oom > rt.oom;
          rt.oom = a.oom;
        }
        const nicHot = Math.max(gen.txMbps || 0, gen.rxMbps || 0) > p.nicMbps * 0.85;
        const lagHot = gen.lagMs > 250;
        // the tester's own kernel: its conntrack table, and one local port per connection to the panel's one port
        const ctHot = gen.ctMax && gen.ct / gen.ctMax >= 0.9;
        const portHot = gen.portRange && pt.conns && pt.conns >= gen.portRange * 0.9;
        rt.genHot = gen.cpu > 85 || nicHot || lagHot || ctHot || portHot ? rt.genHot + 1 : 0;
        pt.genLimited = rt.genHot >= 3;
        if (pt.genLimited && !this.state.warnings.includes('gen')) {
          this.state.warnings.push('gen');
          this.push('warn', ctHot ? `جدول conntrack سرور داشبورد پر شده (${gen.ct} از ${gen.ctMax})؛ محدودیت از خود تست‌کننده است، نه پنل`
            : portHot ? `پورت‌های محلی سرور داشبورد برای اتصال به پنل تمام شد (${pt.conns} اتصال از ${gen.portRange})؛ محدودیت از خود تست‌کننده است، نه پنل`
            : lagHot && !nicHot && gen.cpu <= 85 ? `برنامه‌ی تست روی سرور داشبورد عقب افتاده (تأخیر داخلی ${gen.lagMs} ms)؛ ممکن است نتیجه را همین سرور محدود کرده باشد، نه پنل` : nicHot ? `کارت شبکه‌ی سرور داشبورد بالای ۸۵٪ از ${p.nicMbps} Mbps است؛ نتیجه را شبکه‌ی همین سرور محدود کرده، نه پنل` : `CPU سرور داشبورد ${gen.cpu}٪ است؛ ممکن است نتیجه را همین سرور محدود کرده باشد، نه پنل`);
        }
        st.series.push(pt);
        st.errors = m.errors;
        st.totalGB = r1(m.totalGB * 10) / 10;

        const real = p.trafficMode !== 'steady';
        // the local client for new users would not start: a problem of this machine, never the panel's
        if (st.status === 'running' && rt.engine.clientFail) {
          this.closeStep(rt);
          st.status = 'finished';
          st.genStop = { users: st.users };
          this.push('warn', `${st.name}: کلاینت محلی برای کاربران تازه روی سرور داشبورد بالا نیامد (${rt.engine.clientFail})؛ تست در ${rt.engine.vus.length} کاربر آنلاین متوقف شد و این محدودیتِ تست‌کننده است، نه پنل`, st.id);
          this.endTarget(rt);
          return;
        }
        // the tester itself is at its limit: whatever happens from here says nothing true about the panel
        if (real && st.status === 'running' && rt.genHot >= 10) {
          this.closeStep(rt);
          st.status = 'finished';
          st.genStop = { users: st.users };
          this.push('warn', `${st.name}: سرور داشبورد (تست‌کننده) در ${st.users} کاربر به سقف خودش رسید؛ پنل تا اینجا مشکلی نداشت، ولی سقف واقعی‌اش بالاتر است و با این سرور تست قابل اندازه‌گیری نیست. برای ادامه، داشبورد را روی سرور قوی‌تری نصب کنید.`, st.id);
          this.endTarget(rt);
          return;
        }

        // max mode: CPU counts as full only when it stays there (10 s average), not on one busy second
        const max = p.trafficMode === 'max';
        if (max) {
          rt.cpuWin = [...(rt.cpuWin || []).slice(-9), pt.cpu || 0];
          rt.coreRestarted = rt.coreRestarted || (a && a.coreStart && rt.coreStart0 && a.coreStart !== rt.coreStart0);
          if (a && a.coreStart && !rt.coreStart0) rt.coreStart0 = a.coreStart;
        }
        const chk = max ? { ...pt, cpu: rt.cpuWin.length >= 10 ? Math.round(avg(rt.cpuWin)) : 0, crashed: rt.coreRestarted } : pt;
        if (st.status === 'running' && (oomNow || tSec - rt.stepStart >= p.graceSec)) {
          let why = oomNow ? 'کرنل به خاطر کمبود RAM یک پروسه را کشت (OOM)' : this.breachReason(chk);
          rt.breach = why ? rt.breach + 1 : 0;
          pt.breach = !!why;
          if (rt.breach >= (oomNow ? 1 : real ? 5 : 3)) {
            if (rt.genHot) why += ' (سرور داشبورد هم زیر فشار بود)';
            const mr = max && (oomNow ? ['ram'] : this.maxReason(chk));
            this.breakAt(rt, pt.users, tSec, why, mr ? mr[0] : null);
            // confirm: go back to the last step that held and keep it for a while; a real capacity has to hold
            const lastOk = [...st.steps].reverse().find((x) => x.ok && x.users < pt.users && !x.genLimited);
            if (real && !max && lastOk && p.confirmSec > 0) {
              this.closeStep(rt);
              rt.confirm = { users: lastOk.users, from: tSec, round: 1 };
              rt.breach = 0;
              st.users = lastOk.users;
              rt.engine.setUsers(lastOk.users);
              this.push('ok', `${st.name}: برای تأیید ظرفیت به ${lastOk.users} کاربر برمی‌گردد و ${Math.round(p.confirmSec / 60)} دقیقه نگه می‌دارد`, st.id);
            }
          }
        } else if (st.status === 'broken' && rt.confirm) {
          const c = rt.confirm;
          if (tSec - c.from >= 30) { // the 30 s windows have forgotten the overloaded step
            const why = oomNow ? 'OOM' : this.breachReason(pt);
            rt.breach = why ? rt.breach + 1 : 0;
            pt.breach = !!why;
            if (rt.breach >= 5) {
              const lower = c.users - p.stepUsers;
              this.push('warn', `${st.name}: در ${c.users} کاربر هم پایدار نماند — ${why}`, st.id);
              if (c.round < 3 && lower > 0) {
                rt.confirm = { users: lower, from: tSec, round: c.round + 1 };
                rt.breach = 0;
                st.users = lower;
                rt.engine.setUsers(lower);
              } else {
                c.failed = true;
                st.status = 'finished';
                this.endTarget(rt);
                return;
              }
            }
          }
          if (st.status === 'broken' && tSec - rt.confirm.from >= p.confirmSec) {
            st.status = 'finished';
            this.push('ok', `${st.name}: ظرفیت ${rt.confirm.users} کاربر هم‌زمان تأیید شد — ${Math.round(p.confirmSec / 60)} دقیقه بدون مشکل ماند`, st.id);
            this.endTarget(rt);
            return;
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
      if (rt.engine.links && rt.engine.links.length && this.ctx && this.ctx[rt.t.id]) {
        const meta = { ...this.ctx[rt.t.id].ctx.meta, count: rt.engine.links.length };
        this.store.setProvision(rt.t.id, { links: rt.engine.links, subscriptionUrls: [], meta });
        Object.assign(rt.t, this.store.target(rt.t.id));
        const m = rt.meter;
        this.push('ok', `${rt.t.name}: ${m.dbOk} کاربر حین تست روی پنل ساخته شد${m.dbFail ? `، ${m.dbFail} بار ساخت کاربر خطا داد` : ''}`, rt.t.id);
      }
      if (rt.drv && rt.before !== null) this.proveInbound(rt);
    }
  }

  // 3x-ui adds up inbound traffic every ~10 s: read the counter a little after the run and report it.
  proveInbound(rt) {
    const sent = rt.meter.totalBytes;
    setTimeout(async () => {
      const after = await rt.drv.testInboundTraffic(rt.t.provision).catch(() => null);
      if (after === null) return;
      const passed = Math.max(0, after - rt.before);
      const port = rt.t.provision && rt.t.provision.port;
      if (passed > 0) this.push('ok', `${rt.t.name}: ${fmtGB(passed)} ترافیک از اینباند تست پنل (پورت ${port}) عبور کرد — طبق شمارنده‌ی خود پنل؛ داشبورد ${fmtGB(sent)} دریافت کرد`, rt.t.id);
      else this.push('warn', `${rt.t.name}: شمارنده‌ی اینباند تست پنل تغییری نکرد؛ ترافیک از اینباند ساخته‌شده عبور نکرده`, rt.t.id);
    }, 15000);
  }

  breakAt(rt, users, tSec, why, key) {
    const st = rt.st;
    st.status = 'broken';
    rt.brokeAtT = tSec;
    rt.satKey = key;
    st.brokeAt = { users, t: tSec, reason: why, key };
    this.push('break', this.p.trafficMode === 'max' ? `${st.name} در ${users} کاربر به سقف رسید — ${why}` : `${st.name} در ${users} کاربر از کار افتاد — ${why}`, st.id, { users });
    if (/conntrack/.test(why)) this.push('warn', `${st.name}: این سقفِ تنظیم کرنل است، نه CPU یا RAM. روی سرور بزنید: sysctl -w net.netfilter.nf_conntrack_max=262144 net.netfilter.nf_conntrack_tcp_timeout_time_wait=30 (برای دائمی شدن در /etc/sysctl.conf هم بنویسید) و دوباره تست بگیرید`, st.id);
    if (key === 'ports') this.push('warn', `${st.name}: این سقفِ تنظیم کرنل است، نه CPU یا RAM. روی سرور بزنید: sysctl -w net.ipv4.ip_local_port_range="1024 65535" و دوباره تست بگیرید`, st.id);
    if (key === 'fd') this.push('warn', `${st.name}: این سقفِ تنظیم سرویس است، نه CPU یا RAM. در سرویس x-ui مقدار LimitNOFILE را بالا ببرید (مثلاً 1048576) و دوباره تست بگیرید`, st.id);
  }

  // Max mode: the server is done when a resource is full, or when it turns connections away for any reason.
  // Kernel settings (conntrack, ports, open files) are told apart from hardware: they can be raised.
  maxReason(x) {
    if (x.crashed) return ['crash', 'هسته‌ی Xray از کار افتاد و دوباره بالا آمد'];
    if (x.ctMax && x.ct / x.ctMax >= 0.95) return ['conntrack', `جدول conntrack سرور پر شد (${x.ct} از ${x.ctMax}) — اتصال‌های جدید دور ریخته می‌شوند`];
    if (x.coreFdMax && x.coreFds / x.coreFdMax >= 0.9) return ['fd', `Xray به سقف فایل‌های باز رسید (${x.coreFds} از ${x.coreFdMax})`];
    if (x.portRange && x.conns && x.conns >= x.portRange * 0.9) return ['ports', `پورت‌های محلی سرور برای اتصال‌های خروجی تمام شد (${x.conns} اتصال از ${x.portRange})`];
    if (x.memPct >= 95) return ['ram', `RAM سرور پر شد (${x.memPct}٪)`];
    if (x.cpu >= 95) return ['cpu', `CPU سرور به ${x.cpu}٪ رسید و همان‌جا ماند`];
    if (x.linkMbps && Math.max(x.rx || 0, x.tx || 0) >= x.linkMbps * 0.9) return ['nic', `کارت شبکه‌ی سرور پر شد (${Math.round(Math.max(x.rx, x.tx))} از ${x.linkMbps} Mbps)`];
    if (x.errPct > 20 && x.rps >= 5) return ['errors', `سرور ${x.errPct}٪ اتصال‌ها را رد کرد`];
    return null;
  }

  // What users feel: a tiny request on a new connection, everything they do, and video.
  qualityReason(x) {
    const p = this.p;
    if (x.probeN >= 10 && x.probeP95 > p.maxP95Ms) return `VPN کند شد: پاسخ درخواست کوچک (p95) ${x.probeP95} ms > ${p.maxP95Ms} ms`;
    if (x.apdexN >= 20 && x.apdex != null && x.apdex < p.minApdex) return `رضایت کاربران ${x.apdex}٪ < ${p.minApdex}٪`;
    if (x.videoN >= 10 && x.stallPct > 5) return `ویدیو در ${x.stallPct}٪ تکه‌ها گیر کرد`;
    return null;
  }

  // Max mode: the network is full when users keep growing but the traffic does not, and users feel it.
  plateau(steps) {
    const c = steps[steps.length - 1];
    const b = steps[steps.length - 2];
    if (!c || !b || c.mbps < 50 || (c.cpu != null && c.cpu >= 90)) return null;
    const a = [...steps].reverse().find((x) => x.users <= c.users / 1.25);
    if (!a || a === b || a.apdex == null || c.apdex == null) return null;
    if (b.mbps < a.mbps * 1.05 && c.mbps < a.mbps * 1.05 && c.apdex < a.apdex)
      return `شبکه‌ی سرور بیشتر از حدود ${Math.round(Math.max(a.mbps, b.mbps, c.mbps))} Mbps نکشید: کاربران از ${a.users} به ${c.users} رسیدند ولی ترافیک بالا نرفت`;
    return null;
  }

  breachReason(pt) {
    const p = this.p;
    if (p.type === 'vpn' && p.trafficMode === 'max') { const r = this.maxReason(pt); return r ? r[1] : null; }
    if (pt.errPct > p.maxErrPct && pt.rps >= 5) return `خطا ${pt.errPct}٪ > ${p.maxErrPct}٪`;
    if (pt.dbN >= 5 && pt.dbFailPct > 20) return `ساخت کاربر روی پنل ${pt.dbFailPct}٪ خطا داد`;
    if (p.type === 'vpn' && p.trafficMode !== 'steady') {
      // the server itself: a full conntrack table drops new connections, a full RAM is an OOM a moment away
      if (pt.ctMax && pt.ct / pt.ctMax >= 0.95) return `جدول conntrack سرور پر شد (${pt.ct} از ${pt.ctMax}) — اتصال‌های جدید دور ریخته می‌شوند`;
      if (pt.memPct >= 95) return `RAM سرور پر شد (${pt.memPct}٪)`;
      return this.qualityReason(pt);
    }
    if (pt.p95 > p.maxP95Ms) return `تأخیر p95 ${pt.p95} ms > ${p.maxP95Ms} ms`;
    if (p.type === 'vpn' && p.userKbps > 0 && pt.active >= 10 && pt.userKbps < (p.userKbps * p.minUserPct) / 100)
      return `سرعت هر کاربر ${pt.userKbps} kbps < ${Math.round((p.userKbps * p.minUserPct) / 100)} kbps`;
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
      qualityPct: f('qualityPct').length ? Math.round(median(f('qualityPct'))) : null,
      dbP95: f('dbP95').length ? Math.round(median(f('dbP95'))) : null,
      created: f('created').length ? Math.max(...f('created')) : null,
      apdex: f('apdex').length ? Math.round(median(f('apdex'))) : null,
      probeP95: f('probeP95').length ? Math.round(median(f('probeP95'))) : null,
      stallPct: f('stallPct').length ? Math.round(avg(f('stallPct'))) : null,
      conns: f('conns').length ? Math.max(...f('conns')) : null,
      tcp: f('tcp').length ? Math.max(...f('tcp')) : null,
      ct: f('ct').length ? Math.max(...f('ct')) : null,
      ctMax: f('ctMax').length ? Math.max(...f('ctMax')) : null,
      genLag: f('genLag').length ? Math.max(...f('genLag')) : null, // worst hiccup of the tester itself in this step
      rx: f('rx').length ? r1(avg(f('rx'))) : null, tx: f('tx').length ? r1(avg(f('tx'))) : null,
      coreFds: f('coreFds').length ? Math.max(...f('coreFds')) : null,
    };
    const activeAvg = Math.round(avg(f('active')));
    const x = {
      errPct: sum.errPct, rps: sum.rps, p95: sum.p95, active: activeAvg, userKbps: sum.userKbps, qualityPct: sum.qualityPct, qN: sum.qualityPct == null ? 0 : 99,
      apdex: sum.apdex, apdexN: sum.apdex == null ? 0 : 99, probeP95: sum.probeP95, probeN: sum.probeP95 == null ? 0 : 99,
      stallPct: sum.stallPct, videoN: f('videoN').length ? Math.max(...f('videoN')) : 0, memPct: sum.memPct, ct: sum.ct, ctMax: sum.ctMax,
      cpu: sum.cpu, rx: sum.rx, tx: sum.tx, conns: sum.conns, coreFds: sum.coreFds, coreFdMax: Math.max(0, ...f('coreFdMax')) || null,
      portRange: Math.max(0, ...f('portRange')) || null, linkMbps: Math.max(0, ...f('linkMbps')) || null,
    };
    sum.ok = !this.breachReason(x);
    if (p.trafficMode === 'max') sum.qualityOk = !this.qualityReason(x);
    rt.st.steps.push(sum);
    this.emit('step', { id: rt.st.id, step: sum });
  }

  endTarget(rt) {
    const st = rt.st;
    rt.engine.stop().catch(() => {});
    let capacity = 0;
    for (const s of st.steps) {
      if (!s.ok || (st.brokeAt && s.users >= st.brokeAt.users) || (st.genStop && s.genLimited)) break;
      capacity = s.users;
    }
    // a capacity that was held for minutes after the break, or the step below it when that did not hold either
    const c = rt.confirm;
    if (c) capacity = c.failed ? Math.max(0, c.users - this.p.stepUsers) : c.users;
    const reachedMax = st.status === 'finished' && !st.brokeAt && capacity >= this.p.maxUsers;
    // max mode: also the last step where users were still happy, on the way to the hardware limit
    let qualityCap = null;
    if (this.p.trafficMode === 'max') {
      qualityCap = 0;
      for (const s of st.steps) { if (!s.qualityOk || s.users > capacity) break; qualityCap = s.users; }
    }
    const s = st.series;
    const mx = (k) => Math.max(0, ...s.map((x) => x[k] || 0));
    st.result = {
      capacity, brokeAt: st.brokeAt ? st.brokeAt.users : null, reason: st.brokeAt ? st.brokeAt.reason : null, reachedMax,
      confirmed: c ? !c.failed : null, limitedBy: st.genStop ? 'generator' : null, peakConns: mx('conns'), peakCt: mx('ct'), ctMax: mx('ctMax') || null,
      saturated: st.genStop ? null : rt.satKey || null, qualityCap, peakNet: Math.max(mx('rx'), mx('tx')),
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
      const score = (t) => (t.result.reachedMax ? this.p.maxUsers + 1 : t.result.capacity);
      const lastP95 = (t) => (t.steps.length ? t.steps[t.steps.length - 1].p95 : 0);
      const [a, b] = [...ts].sort((x, y) => score(y) - score(x) || lastP95(x) - lastP95(y)); // best first
      if (score(a) === score(b)) {
        const pa = lastP95(a);
        const pb = lastP95(b);
        this.state.winner = Math.abs(pa - pb) < 0.1 * Math.max(pa, pb, 1) ? 'tie' : a.id;
      } else this.state.winner = a.id;
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
