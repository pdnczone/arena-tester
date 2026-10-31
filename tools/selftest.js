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
  r.p = { type: 'vpn', userKbps: 2000, minUserPct: 70, maxErrPct: 2, maxP95Ms: 1500 };
  assert.equal(r.breachReason({ active: 5, userKbps: 0, errPct: 0, p95: 0, rps: 0 }), null);
  assert.match(r.breachReason({ active: 50, userKbps: 100, errPct: 0, p95: 0, rps: 0 }), /per-user speed/);
  assert.equal(r.breachReason({ active: 50, userKbps: 1800, errPct: 0, p95: 0, rps: 0 }), null);
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
