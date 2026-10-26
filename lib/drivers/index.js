'use strict';
const { ThreeXUI } = require('./threexui');
const { Nexora } = require('./nexora');

const KINDS = { '3xui': ThreeXUI, nexora: Nexora };
const cache = new Map();

const sig = (t) => [t.kind, t.panelUrl, t.username, t.password, t.apiToken, t.insecureTls].join('|');

// One driver (= one logged-in session) per target; rebuilt when the connection settings change.
function getDriver(t) {
  const K = KINDS[t.kind];
  if (!K || !t.panelUrl || !(t.apiToken || (t.username && t.password))) return null;
  const c = cache.get(t.id);
  if (c && c.sig === sig(t)) return c.d;
  if (c) c.d.close();
  const d = new K(t);
  cache.set(t.id, { sig: sig(t), d });
  return d;
}

// Stats straight from the panel API (used when no agent is installed). Cached: never poll the panel faster than 2 s.
const statCache = new Map();
async function panelStats(t) {
  const d = getDriver(t);
  if (!d) return null;
  const c = statCache.get(t.id) || { at: 0, v: null, busy: false };
  statCache.set(t.id, c);
  if (!c.busy && Date.now() - c.at > 2000) {
    c.busy = true;
    d.status().then((v) => { c.v = v; c.at = Date.now(); }).catch(() => { c.at = Date.now(); }).finally(() => { c.busy = false; });
  }
  return c.v;
}

module.exports = { getDriver, panelStats, KINDS: Object.keys(KINDS) };
