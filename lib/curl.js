'use strict';
// Turn a "Copy as cURL" command from browser DevTools into a scenario step.

function tokenize(s) {
  s = s.replace(/\\\r?\n/g, ' ').replace(/\^\r?\n/g, ' ');
  const out = [];
  const re = /\s*(?:\$'((?:[^'\\]|\\.)*)'|'([^']*)'|"((?:[^"\\]|\\.)*)"|(\S+))/gy;
  let m;
  while ((m = re.exec(s))) {
    out.push(m[1] ?? m[2] ?? (m[3] != null ? m[3].replace(/\\(["\\$`])/g, '$1') : m[4]));
  }
  return out;
}

function parseCurl(cmd) {
  const tk = tokenize(cmd.trim());
  if (tk[0] === 'curl') tk.shift();
  const step = { name: '', method: '', url: '', headers: {}, role: 'admin', expect: [200] };
  let data = null;
  for (let i = 0; i < tk.length; i++) {
    const t = tk[i];
    if (t === '-X' || t === '--request') step.method = tk[++i].toUpperCase();
    else if (t === '-H' || t === '--header') {
      const h = tk[++i];
      const c = h.indexOf(':');
      const k = h.slice(0, c).trim().toLowerCase();
      if (!['cookie', 'host', 'content-length', 'accept-encoding', 'connection'].includes(k) && !k.startsWith('sec-') && !k.startsWith(':'))
        step.headers[k] = h.slice(c + 1).trim();
    } else if (['-d', '--data', '--data-raw', '--data-binary', '--data-urlencode'].includes(t)) data = tk[++i];
    else if (t === '-b' || t === '--cookie' || t === '-u' || t === '--user') i++;
    else if (t === '--url') step.url = tk[++i];
    else if (!t.startsWith('-') && !step.url) step.url = t;
  }
  if (!step.url) throw new Error('URL not found in cURL command');
  if (data != null) {
    const ct = step.headers['content-type'] || '';
    if (ct.includes('json')) {
      try { step.json = JSON.parse(data); } catch { step.body = data; }
    } else if (ct.includes('x-www-form-urlencoded') || !ct) {
      step.form = Object.fromEntries(new URLSearchParams(data));
      delete step.headers['content-type'];
    } else step.body = data;
  }
  step.method = step.method || (data != null ? 'POST' : 'GET');
  const u = new URL(step.url);
  step.name = `${step.method} ${u.pathname}`;
  step.path = u.pathname + u.search;
  step.origin = u.origin;
  delete step.url;
  return step;
}

module.exports = { parseCurl };
