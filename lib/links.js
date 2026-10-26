'use strict';
// Share-link parsing + conversion to Xray / sing-box outbounds, and subscription fetching.
const { fetch } = require('undici');

const SCHEMES = ['vless', 'vmess', 'trojan', 'ss', 'hysteria2', 'hy2', 'tuic'];

function b64decode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64').toString('utf8');
}

function parseLink(raw) {
  raw = raw.trim();
  const m = /^([a-z0-9]+):\/\//i.exec(raw);
  if (!m) throw new Error('not a link');
  let scheme = m[1].toLowerCase();
  if (scheme === 'hy2') scheme = 'hysteria2';
  if (!SCHEMES.includes(scheme)) throw new Error('unsupported scheme ' + scheme);

  if (scheme === 'vmess') {
    const j = JSON.parse(b64decode(raw.slice(8)));
    return {
      protocol: 'vmess', name: j.ps || '', host: j.add, port: Number(j.port), id: j.id,
      aid: Number(j.aid || 0), scy: j.scy || 'auto', net: j.net || 'tcp', headerType: j.type || 'none',
      hostHeader: j.host || '', path: j.path || '', security: j.tls === 'tls' ? 'tls' : 'none',
      sni: j.sni || j.host || '', alpn: j.alpn || '', fp: j.fp || '', serviceName: j.path || '',
    };
  }

  if (scheme === 'ss') {
    // ss://base64(method:pass)@host:port#name  or  ss://base64(method:pass@host:port)#name
    const hash = raw.indexOf('#');
    const name = hash >= 0 ? decodeURIComponent(raw.slice(hash + 1)) : '';
    let body = raw.slice(5, hash >= 0 ? hash : undefined);
    body = body.split('?')[0];
    let userinfo;
    let hostport;
    if (body.includes('@')) {
      const at = body.lastIndexOf('@');
      userinfo = body.slice(0, at);
      hostport = body.slice(at + 1);
      if (!userinfo.includes(':')) userinfo = b64decode(userinfo);
      else userinfo = decodeURIComponent(userinfo);
    } else {
      const dec = b64decode(body);
      const at = dec.lastIndexOf('@');
      userinfo = dec.slice(0, at);
      hostport = dec.slice(at + 1);
    }
    const ci = userinfo.indexOf(':');
    const hp = hostport.lastIndexOf(':');
    return {
      protocol: 'ss', name, method: userinfo.slice(0, ci), password: userinfo.slice(ci + 1),
      host: hostport.slice(0, hp), port: Number(hostport.slice(hp + 1)), net: 'tcp', security: 'none',
    };
  }

  const u = new URL(raw);
  const q = (k, d = '') => u.searchParams.get(k) ?? d;
  const base = {
    protocol: scheme, name: decodeURIComponent(u.hash.slice(1)),
    host: u.hostname.replace(/^\[|\]$/g, ''), port: Number(u.port),
    id: decodeURIComponent(u.username), password: decodeURIComponent(u.username),
    net: q('type', 'tcp'), security: q('security', scheme === 'trojan' ? 'tls' : 'none'),
    sni: q('sni') || q('peer'), fp: q('fp'), alpn: q('alpn'), flow: q('flow'), pbk: q('pbk'),
    sid: q('sid'), spx: q('spx'), headerType: q('headerType', 'none'), hostHeader: q('host'),
    path: q('path'), serviceName: q('serviceName'), mode: q('mode'),
    insecure: q('allowInsecure') === '1' || q('insecure') === '1',
  };
  if (scheme === 'hysteria2') {
    base.password = decodeURIComponent(u.username + (u.password ? ':' + u.password : ''));
    base.obfs = q('obfs');
    base.obfsPassword = q('obfs-password');
  }
  if (scheme === 'tuic') {
    base.id = decodeURIComponent(u.username);
    base.password = decodeURIComponent(u.password);
    base.congestion = q('congestion_control', 'bbr');
    base.udpRelay = q('udp_relay_mode', 'native');
  }
  return base;
}

function xrayStream(l) {
  const s = { network: l.net === 'h2' ? 'http' : l.net };
  if (s.network === 'ws') s.wsSettings = { path: l.path || '/', headers: l.hostHeader ? { Host: l.hostHeader } : {} };
  else if (s.network === 'grpc') s.grpcSettings = { serviceName: l.serviceName || l.path || '', multiMode: l.mode === 'multi' };
  else if (s.network === 'httpupgrade') s.httpupgradeSettings = { path: l.path || '/', host: l.hostHeader || '' };
  else if (s.network === 'xhttp' || s.network === 'splithttp')
    s.xhttpSettings = { path: l.path || '/', host: l.hostHeader || '', mode: l.mode || 'auto' };
  else if (s.network === 'http') s.httpSettings = { path: l.path || '/', host: l.hostHeader ? [l.hostHeader] : [] };
  else if (s.network === 'tcp' && l.headerType === 'http')
    s.tcpSettings = { header: { type: 'http', request: { path: [l.path || '/'], headers: { Host: l.hostHeader ? [l.hostHeader] : [] } } } };
  if (l.security === 'tls') {
    s.security = 'tls';
    s.tlsSettings = {
      serverName: l.sni || l.hostHeader || l.host, allowInsecure: true,
      ...(l.fp ? { fingerprint: l.fp } : {}), ...(l.alpn ? { alpn: l.alpn.split(',') } : {}),
    };
  } else if (l.security === 'reality') {
    s.security = 'reality';
    s.realitySettings = {
      serverName: l.sni, fingerprint: l.fp || 'chrome', publicKey: l.pbk, shortId: l.sid || '', spiderX: l.spx || '',
    };
  }
  return s;
}

function toXray(l, tag) {
  const out = { tag, streamSettings: xrayStream(l) };
  if (l.protocol === 'vless') {
    out.protocol = 'vless';
    out.settings = { vnext: [{ address: l.host, port: l.port, users: [{ id: l.id, encryption: 'none', ...(l.flow ? { flow: l.flow } : {}) }] }] };
  } else if (l.protocol === 'vmess') {
    out.protocol = 'vmess';
    out.settings = { vnext: [{ address: l.host, port: l.port, users: [{ id: l.id, alterId: l.aid || 0, security: l.scy || 'auto' }] }] };
  } else if (l.protocol === 'trojan') {
    out.protocol = 'trojan';
    out.settings = { servers: [{ address: l.host, port: l.port, password: l.password }] };
  } else if (l.protocol === 'ss') {
    out.protocol = 'shadowsocks';
    out.settings = { servers: [{ address: l.host, port: l.port, method: l.method, password: l.password }] };
  } else throw new Error('xray cannot do ' + l.protocol);
  return out;
}

function toSingbox(l, tag) {
  const tls = { enabled: true, server_name: l.sni || l.host, insecure: true, ...(l.alpn ? { alpn: l.alpn.split(',') } : {}) };
  if (l.protocol === 'hysteria2') {
    return {
      type: 'hysteria2', tag, server: l.host, server_port: l.port, password: l.password, tls,
      ...(l.obfs ? { obfs: { type: l.obfs, password: l.obfsPassword } } : {}),
    };
  }
  if (l.protocol === 'tuic') {
    return {
      type: 'tuic', tag, server: l.host, server_port: l.port, uuid: l.id, password: l.password,
      congestion_control: l.congestion, udp_relay_mode: l.udpRelay, tls,
    };
  }
  throw new Error('sing-box converter only handles hysteria2/tuic here');
}

const coreFor = (l) => (l.protocol === 'hysteria2' || l.protocol === 'tuic' ? 'singbox' : 'xray');

function summary(l) {
  return `${l.protocol}+${l.net || 'udp'}${l.security && l.security !== 'none' ? '+' + l.security : ''}`;
}

// Subscription body -> list of raw links (base64 or plain, one per line).
function extractLinks(body) {
  let text = body.trim();
  if (!/:\/\//.test(text.split('\n')[0] || '')) {
    try { text = b64decode(text); } catch { /* keep */ }
  }
  return text.split(/\r?\n/).map((s) => s.trim()).filter((s) => SCHEMES.some((p) => s.toLowerCase().startsWith(p + '://')));
}

async function fetchSubscription(url, insecure) {
  const { Agent } = require('undici');
  const res = await fetch(url, {
    headers: { 'User-Agent': 'v2rayN/6.0' },
    signal: AbortSignal.timeout(15000),
    dispatcher: new Agent({ connect: { rejectUnauthorized: !insecure } }),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const links = extractLinks(await res.text());
  if (!links.length) throw new Error('no links found (unsupported subscription format?)');
  return links;
}

// Resolve all links of a target: direct links + subscription URLs, filtered by regex.
async function resolveLinks(target, filter) {
  const raw = [...(target.links || [])];
  const errors = [];
  const subs = raw.length ? [] : (target.subscriptionUrls || []).slice(0, 1000);
  for (let i = 0; i < subs.length; i += 20) {
    await Promise.all(subs.slice(i, i + 20).map(async (u) => {
      try { raw.push(...(await fetchSubscription(u, target.insecureTls))); } catch (e) { if (errors.length < 5) errors.push(`${u.slice(0, 40)}…: ${e.message}`); }
    }));
  }
  const re = filter ? new RegExp(filter, 'i') : null;
  const out = [];
  for (const r of raw) {
    if (re && !re.test(r)) continue;
    try { out.push({ raw: r, link: parseLink(r) }); } catch (e) { errors.push(`${r.slice(0, 30)}…: ${e.message}`); }
  }
  return { items: out, errors };
}

module.exports = { parseLink, toXray, toSingbox, coreFor, summary, extractLinks, fetchSubscription, resolveLinks };
