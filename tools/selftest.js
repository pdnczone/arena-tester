'use strict';
// Tiny assert-based checks for the bugs that have bitten us. Run: npm test
const assert = require('assert');
const { parseLink } = require('../lib/links');
const { Runner } = require('../lib/runner');

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log('ok  ', name); }
  catch (e) { failed++; console.error('FAIL', name, '-', e.message); }
};

check('ss link: client password only (not server:client)', () => {
  const b64 = (s) => Buffer.from(s).toString('base64');
  const bad = parseLink(`ss://${b64('chacha20-ietf-poly1305:server:client')}@1.2.3.4:1#x`);
  assert.equal(bad.password, 'server:client'); // documents the broken shape
  const good = parseLink(`ss://${b64('chacha20-ietf-poly1305:client')}@1.2.3.4:1#x`);
  assert.equal(good.method, 'chacha20-ietf-poly1305');
  assert.equal(good.password, 'client');
  // driver formula must match the good shape
  const cPass = 'clientpassYYYY';
  const built = `ss://${b64(`chacha20-ietf-poly1305:${cPass}`)}@h:24443#e`;
  assert.equal(parseLink(built).password, cPass);
});

check('vless / trojan parse', () => {
  const v = parseLink('vless://11111111-2222-3333-4444-555555555555@10.0.0.1:443?type=tcp&security=none#t');
  assert.equal(v.protocol, 'vless');
  assert.equal(v.port, 443);
  const t = parseLink('trojan://secret@10.0.0.1:443?type=tcp&security=none#t');
  assert.equal(t.protocol, 'trojan');
  assert.equal(t.password, 'secret');
});

check('breachReason uses real active, not requested users', () => {
  const r = new Runner({ get() { return { test: {}, targets: [], generator: {} }; } });
  r.p = { type: 'vpn', trafficMode: 'steady', userKbps: 2000, minUserPct: 70, maxErrPct: 2, maxP95Ms: 1500 };
  assert.equal(r.breachReason({ active: 5, userKbps: 0, errPct: 0, p95: 0, rps: 0 }), null);
  assert.match(r.breachReason({ active: 50, userKbps: 100, errPct: 0, p95: 0, rps: 0 }), /سرعت هر کاربر/);
  assert.equal(r.breachReason({ active: 50, userKbps: 1800, errPct: 0, p95: 0, rps: 0 }), null);
});

check('real traffic breaks on what users feel and on server limits', () => {
  const r = new Runner({ get() { return { test: {}, targets: [], generator: {} }; } });
  r.p = { type: 'vpn', trafficMode: 'real', userKbps: 0, minApdex: 85, maxErrPct: 2, maxP95Ms: 1500 };
  const ok = { active: 50, userKbps: 300, errPct: 0, p95: 4000, rps: 20, apdex: 95, apdexN: 80, probeP95: 400, probeN: 40, videoN: 30, stallPct: 1, memPct: 60, ct: 1000, ctMax: 7680 };
  // low average speed and a slow first byte on a paced download are normal for real users
  assert.equal(r.breachReason(ok), null);
  assert.match(r.breachReason({ ...ok, apdex: 70 }), /رضایت کاربران/);
  assert.equal(r.breachReason({ ...ok, apdex: 70, apdexN: 5 }), null); // too few to judge
  assert.match(r.breachReason({ ...ok, probeP95: 2500 }), /کند شد/);
  assert.match(r.breachReason({ ...ok, stallPct: 12 }), /ویدیو/);
  assert.match(r.breachReason({ ...ok, ct: 7500 }), /conntrack/);
  assert.match(r.breachReason({ ...ok, memPct: 97 }), /RAM/);
});

check('max mode stops only on full hardware or kernel limits, and says which', () => {
  const r = new Runner({ get() { return { test: {}, targets: [], generator: {} }; } });
  r.p = { type: 'vpn', trafficMode: 'max', userKbps: 0, minApdex: 85, maxErrPct: 2, maxP95Ms: 1500 };
  const ok = { errPct: 3, rps: 50, apdex: 60, apdexN: 80, probeP95: 3000, probeN: 40, videoN: 30, stallPct: 20, memPct: 80, cpu: 90, ct: 1000, ctMax: 262144, conns: 9000, portRange: 64512, coreFds: 20000, coreFdMax: 1048576, rx: 400, tx: 400 };
  // unhappy users alone do not stop it: the server is not full yet
  assert.equal(r.breachReason(ok), null);
  assert.equal(r.maxReason({ ...ok, cpu: 96 })[0], 'cpu');
  assert.equal(r.maxReason({ ...ok, memPct: 96 })[0], 'ram');
  assert.equal(r.maxReason({ ...ok, ct: 250000 })[0], 'conntrack');
  assert.equal(r.maxReason({ ...ok, conns: 60000 })[0], 'ports');
  assert.equal(r.maxReason({ ...ok, coreFds: 1000, coreFdMax: 1024 })[0], 'fd');
  assert.equal(r.maxReason({ ...ok, linkMbps: 1000, tx: 950 })[0], 'nic');
  assert.equal(r.maxReason({ ...ok, errPct: 40 })[0], 'errors');
  // kernel limits are reported before RAM/CPU: they are what really turns users away
  assert.equal(r.maxReason({ ...ok, ct: 250000, memPct: 97 })[0], 'conntrack');
  assert.match(r.qualityReason(ok), /کند شد/);
});

check('max mode: flat traffic while users grow is a full network', () => {
  const r = new Runner({ get() { return { test: {}, targets: [], generator: {} }; } });
  r.p = { type: 'vpn', trafficMode: 'max' };
  const s = (users, mbps, apdex, cpu = 50) => ({ users, mbps, apdex, cpu });
  assert.match(r.plateau([s(300, 800, 95), s(350, 810, 90), s(400, 805, 80)]), /شبکه/);
  assert.equal(r.plateau([s(300, 600, 95), s(350, 700, 95), s(400, 800, 95)]), null); // still growing
  assert.equal(r.plateau([s(300, 800, 95), s(350, 810, 90), s(400, 805, 80, 97)]), null); // that is the CPU
});

check('real traffic: steps are long enough for load to build up', () => {
  const seen = [];
  const store = { get() { return { test: { stepSeconds: 15, graceSec: 6, startUsers: 10, stepUsers: 10, maxUsers: 50, trafficMode: 'real' }, generator: {}, targets: [{ id: 'A', name: 'A', enabled: true, links: ['x'] }] }; } };
  const r = new Runner(store);
  r.main = async () => { seen.push({ s: r.p.stepSeconds, g: r.p.graceSec }); };
  r.start({});
  assert.deepEqual(seen[0], { s: 60, g: 20 });
});

check('startUsers clamped to maxUsers', () => {
  const calls = [];
  const store = {
    get() {
      return {
        test: { type: 'panel', mode: 'parallel', startUsers: 500, stepUsers: 50, stepSeconds: 15, maxUsers: 100, graceSec: 6, thinkMs: 1000, timeoutMs: 10000, sessions: 1, subPct: 80, maxErrPct: 2, maxP95Ms: 1500, userKbps: 0, minUserPct: 70, cooldownSec: 1, holdAfterBreakSec: 1, filter: '' },
        generator: { publicHost: '', blobPort: 8081, nicMbps: 1000 },
        targets: [{ id: 'A', name: 'A', color: '#0a84ff', kind: 'custom', enabled: true, steps: [], subscriptionUrls: ['http://127.0.0.1/x'], links: [] }],
      };
    },
  };
  const r = new Runner(store);
  r.main = async () => { calls.push({ start: r.p.startUsers, max: r.p.maxUsers }); r.setStatus('done'); };
  r.start({});
  assert.equal(calls[0].start, 100);
  assert.equal(calls[0].max, 100);
});

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log('\nall good');
