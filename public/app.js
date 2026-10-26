'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const fmt = (n, d = 0) => (n == null || Number.isNaN(n) ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d }));
const api = async (url, method = 'GET', body) => {
  const r = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
};
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));

/* ---------------- theme (tokens come from CSS so light/dark stay in one place) ---------------- */
let TH = {};
function loadTheme() {
  const cs = getComputedStyle(document.documentElement);
  const g = (n) => cs.getPropertyValue(n).trim();
  TH = { p: [g('--p1'), g('--p2')], ok: g('--ok'), warn: g('--warn'), bad: g('--bad'), idle: g('--idle'), l1: g('--l1'), l2: g('--l2'), l3: g('--l3'), sep: g('--sep'), fill: g('--fill') };
  Chart.defaults.font.size = 12;
  Chart.defaults.font.family = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Arabic", system-ui, Tahoma, sans-serif';
  Chart.defaults.color = TH.l2;
}

/* ---------------- icons ---------------- */
const ICON = {
  cpu: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3"/>',
  ram: '<rect x="2" y="7" width="20" height="10" rx="1"/><path d="M6 11v2M10 11v2M14 11v2M18 11v2M6 17v3M10 17v3M14 17v3M18 17v3"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  alert: '<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  bolt: '<path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>',
  crown: '<path d="M3 19h18M4 19L2 7l5 4 5-7 5 7 5-4-2 12z"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  play: '<path d="M6 4l14 8-14 8z" fill="currentColor"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor"/>',
  rec: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4" fill="currentColor"/>',
  server: '<rect x="2" y="3" width="20" height="8" rx="2"/><rect x="2" y="13" width="20" height="8" rx="2"/><path d="M6 7h.01M6 17h.01"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  flag: '<path d="M4 22V4M4 4h14l-3 4 3 4H4"/>',
  trend: '<path d="M3 17l6-6 4 4 8-8M15 7h6v6"/>',
  hourglass: '<path d="M6 2h12M6 22h12M7 2v4a5 5 0 0 0 10 0V2M7 22v-4a5 5 0 0 1 10 0v4"/>',
  swords: '<path d="M14.5 17.5L3 6V3h3l11.5 11.5M13 19l6-6M16 16l4 4M19 21l2-2M9.5 6.5L21 18v3h-3L6.5 9.5"/>',
  par: '<path d="M3 8h16M3 16h16M15 4l4 4-4 4M15 12l4 4-4 4"/>',
  seq: '<path d="M2 12h8M6 8l4 4-4 4M14 12h8M18 8l4 4-4 4"/>',
  check: '<circle cx="12" cy="12" r="10"/><path d="M8 12l3 3 5-6"/>',
  xoct: '<polygon points="7.9 2 16.1 2 22 7.9 22 16.1 16.1 22 7.9 22 2 16.1 2 7.9"/><path d="M15 9l-6 6M9 9l6 6"/>',
  minus: '<circle cx="12" cy="12" r="10"/><path d="M8 12h8"/>',
  down: '<path d="M12 4v14M6 13l6 6 6-6"/>',
};
const ic = (n) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICON[n]}</svg>`;

/* ---------------- state ---------------- */
let cfg = null;
let S = null;
let ui = { type: 'panel', mode: 'parallel' };
let ctl = { startUsers: 50, stepUsers: 50, stepSeconds: 15, maxUsers: 2000, maxErrPct: 2, maxP95Ms: 1500, userKbps: 2000 };
const cards = {};
const lanes = {};
const cmp = {};
let thrRef = 1;
const isRunning = () => S && ['starting', 'running', 'cooldown', 'stopping'].includes(S.status);
const isVpn = () => (S && S.type ? S.type : ui.type) === 'vpn';
const P = () => ({ minUserPct: 70, ...ctl, ...(S && S.params ? S.params : {}) });
const last = (t) => (t.series && t.series.length ? t.series[t.series.length - 1] : null);
const thrOf = (p) => (p ? (isVpn() ? p.mbps : p.rps) : 0);
const idxOf = (id) => Math.max(0, Object.keys(S.targets).indexOf(id));
const tcol = (id) => TH.p[idxOf(id) % 2];
const cvar = (id) => `var(--p${(idxOf(id) % 2) + 1})`;
const lvColor = (lv) => TH[lv] || TH.idle;

/* ---------------- toolbar ---------------- */
function initStatic() {
  $('#brand').innerHTML = ic('swords');
  $('#typeSeg [data-v=panel] .gi').innerHTML = ic('globe');
  $('#typeSeg [data-v=vpn] .gi').innerHTML = ic('shield');
  $('#modeSeg [data-v=parallel] .gi').innerHTML = ic('par');
  $('#modeSeg [data-v=sequential] .gi').innerHTML = ic('seq');
  $('#setupBtn').innerHTML = ic('sliders') + '<span>تنظیم تست</span>';
  $('#settingsBtn').innerHTML = ic('server') + '<span>سرورها</span>';
  $('#recBtn').innerHTML = ic('rec') + '<span>ضبط</span>';
  ['p95', 'err', 'cpu', 'thr'].forEach((k, i) => { $('#ic_' + k).innerHTML = ic(['clock', 'alert', 'cpu', 'activity'][i]); });
}
function applyType() {
  document.body.classList.toggle('vpn', ui.type === 'vpn');
  $$('#typeSeg button').forEach((b) => b.setAttribute('aria-checked', b.dataset.v === ui.type));
  $$('#modeSeg button').forEach((b) => b.setAttribute('aria-checked', b.dataset.v === ui.mode));
  $('#t_p95').textContent = ui.type === 'vpn' ? 'زمان برقراری اتصال (p95)' : 'تأخیر پاسخ (p95)';
  $('#t_thr').textContent = ui.type === 'vpn' ? 'پهنای باند کل (Mbps)' : 'توان عملیاتی (درخواست/ثانیه)';
}
$('#typeSeg').onclick = (e) => {
  const b = e.target.closest('button');
  if (!b || isRunning()) return;
  ui.type = b.dataset.v;
  ui.mode = ui.type === 'vpn' ? 'sequential' : 'parallel';
  applyType();
  if (S && !isRunning()) rebuild();
};
$('#modeSeg').onclick = (e) => {
  const b = e.target.closest('button');
  if (!b || isRunning()) return;
  ui.mode = b.dataset.v;
  applyType();
};
$('#recBtn').onclick = () => {
  const on = document.body.classList.toggle('rec');
  $('#recBtn').setAttribute('aria-pressed', on);
};

/* ---------------- websocket ---------------- */
function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onmessage = (m) => handle(JSON.parse(m.data));
  ws.onclose = () => setTimeout(connect, 1500);
}

function handle(m) {
  if (m.type === 'snapshot') {
    S = m.state;
    if (S.params) Object.keys(ctl).forEach((k) => { if (S.params[k] != null) ctl[k] = S.params[k]; });
    if (S.type) { ui.type = S.type; ui.mode = S.mode; }
    applyType();
    rebuild();
  } else if (m.type === 'tick' && S) {
    S.status = m.status;
    S.warnings = m.warnings || S.warnings;
    S.lastTickAt = Date.now();
    for (const [id, d] of Object.entries(m.targets)) {
      const t = S.targets[id];
      if (!t) continue;
      Object.assign(t, { status: d.status, users: d.users ?? t.users, active: d.active ?? t.active, errors: d.errors || t.errors, totalGB: d.totalGB ?? t.totalGB, protocol: d.protocol || t.protocol, brokeAt: d.brokeAt || t.brokeAt });
      if (d.point) { t.series.push(d.point); pushPoint(id, d.point); }
      thrRef = Math.max(thrRef, thrOf(d.point));
      paintCard(id);
    }
    paintTop();
    paintRace();
  } else if (m.type === 'step' && S) {
    S.targets[m.id].steps.push(m.step);
    paintRace();
    paintCompare();
  } else if (m.type === 'target' && S) {
    Object.assign(S.targets[m.id], { status: m.status, result: m.result });
    paintCard(m.id);
    paintRace();
    paintPeaks();
  } else if (m.type === 'status' && S) {
    S.status = m.status;
    paintTop();
  } else if (m.type === 'event' && S) {
    S.events.push(m.ev);
    onEvent(m.ev);
    paintBanners();
  }
}

function onEvent(ev) {
  if (ev.kind === 'break') {
    const t = S.targets[ev.id];
    toast('break', 'xoct', `<b>${t.name}</b> در ${fmt(ev.users)} کاربر از کار افتاد`);
  } else if (ev.kind === 'warn') toast('warn', 'alert', ev.text);
  else if (ev.kind === 'error') toast('error', 'alert', ev.text);
  else if (ev.kind === 'ok') toast('ok', 'check', ev.text);
}
function toast(kind, icon, html) {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.innerHTML = ic(icon) + `<div>${html}</div>`;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 7000);
}

/* ---------------- health ---------------- */
function healthOf(t) {
  const p = last(t);
  const X = P();
  if (t.status === 'broken' || t.status === 'error') return 'bad';
  if (t.status === 'waiting' || t.status === 'stopped' || !p) return 'idle';
  if (t.status === 'finished') return t.brokeAt ? 'bad' : 'ok';
  let r = Math.max(p.p95 / X.maxP95Ms, p.errPct / X.maxErrPct);
  if (isVpn() && X.userKbps > 0 && p.active >= 10) r = Math.max(r, ((X.userKbps * X.minUserPct) / 100) / Math.max(p.userKbps, 1));
  return r >= 1 ? 'bad' : r >= 0.5 ? 'warn' : 'ok';
}
function pillOf(t, h) {
  if (t.status === 'error') return ['xoct', 'خطا در راه‌اندازی'];
  if (t.status === 'waiting') return ['minus', 'در انتظار نوبت'];
  if (t.status === 'stopped') return ['minus', 'متوقف شد'];
  if (t.status === 'finished') return t.brokeAt ? ['xoct', 'از کار افتاد'] : ['check', 'تا سقف دوام آورد'];
  if (h === 'bad') return ['xoct', 'از کار افتاد'];
  if (h === 'warn') return ['alert', 'افت کیفیت'];
  if (h === 'ok') return ['check', 'پایدار'];
  return ['minus', 'در حال آماده‌سازی'];
}
function stableUsers(t) {
  let cap = 0;
  for (const s of t.steps) { if (!s.ok || (t.brokeAt && s.users >= t.brokeAt.users)) break; cap = s.users; }
  return cap;
}

/* ---------------- top bar ---------------- */
function paintTop() {
  if (!S) return;
  const run = isRunning();
  const b = $('#startBtn');
  b.innerHTML = ic(run ? 'stop' : 'play') + `<span>${run ? 'توقف' : 'شروع تست'}</span>`;
  b.setAttribute('aria-label', run ? 'توقف تست' : 'شروع تست');
  document.body.classList.toggle('locked', run);
  $('#settingsBtn').disabled = run;
  $('#setupBtn').disabled = run;
  const ts = Object.values(S.targets);
  let prog = 0;
  if (ts.length) {
    const X = P();
    const total = (Math.ceil((X.maxUsers - X.startUsers) / X.stepUsers) + 1) * X.stepSeconds;
    prog = ts.reduce((a, t) => a + (['finished', 'broken', 'stopped', 'error'].includes(t.status) ? 1 : t.status === 'waiting' ? 0 : clamp((last(t) ? last(t).t : 0) / total)), 0) / ts.length;
  }
  if (['done', 'stopped'].includes(S.status)) prog = 1;
  $('#ring').style.strokeDashoffset = 69.1 * (1 - prog);
  $('.progress').setAttribute('aria-valuenow', Math.round(prog * 100));
  const secs = S.startedAt ? Math.floor(((run ? Date.now() : S.lastTickAt || Date.now()) - S.startedAt) / 1000) : 0;
  $('#clock').textContent = `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
}
setInterval(() => { if (S && isRunning()) paintTop(); }, 1000);

function paintBanners() {
  if (!S) return;
  const out = [];
  if (S.warnings && S.warnings.includes('gen')) out.push(['', 'CPU یا کارت شبکه‌ی سرور سوم (مولد بار) بالای ۸۵٪ رفته؛ نتیجه محدودیت خود سرور سوم است، نه پنل‌ها.']);
  const protos = Object.values(S.targets).map((t) => t.protocol).filter(Boolean);
  if (S.type === 'vpn' && new Set(protos).size > 1) out.push(['', 'پروتکل/ترنسپورت دو پنل یکی نیست (' + protos.join(' ≠ ') + ')؛ مقایسه عادلانه نیست.']);
  for (const e of S.events.filter((x) => x.kind === 'error')) out.push(['err', e.text]);
  $('#banners').innerHTML = out.map(([c, t]) => `<div class="banner ${c}">${ic('alert')}<span>${t}</span></div>`).join('');
}

/* ---------------- race ---------------- */
function buildRace() {
  const box = $('#race');
  Object.keys(lanes).forEach((k) => delete lanes[k]);
  box.innerHTML = `<div class="sh"><h2>مسابقه‌ی ظرفیت</h2><div class="keys">
      <span class="k-ok">${ic('check')}<b>پله‌ی سالم</b></span><span class="k-bad">${ic('xoct')}<b>نقطه‌ی شکست</b></span>
      <span>${ic('down')}ظرفیت پایدار</span><span style="color:#d99a00">${ic('crown')}<b style="color:var(--l2)">برنده</b></span></div></div>
    <div id="lanes"></div><div class="foot" id="verdict" style="padding:6px 0 8px"></div>`;
  Object.values(S.targets).forEach((t) => {
    const el = document.createElement('div');
    el.className = 'lane idle';
    el.style.setProperty('--c', cvar(t.id));
    el.innerHTML = `<div class="who"><i></i><span>${t.name}</span></div><div class="track"><div class="fill"></div><div class="segs"></div></div><div class="val"><span class="tab">0</span><small>کاربر</small></div>`;
    $('#lanes', box).appendChild(el);
    lanes[t.id] = { el, track: $('.track', el), fill: $('.fill', el), segs: $('.segs', el), val: $('.val .tab', el) };
  });
}

function paintRace() {
  if (!S) return;
  const X = P();
  const pct = (u) => clamp(u / X.maxUsers) * 100;
  Object.values(S.targets).forEach((t) => {
    const l = lanes[t.id];
    if (!l) return;
    const p = last(t);
    const u = p ? p.users : 0;
    l.fill.style.width = pct(u) + '%';
    l.val.textContent = fmt(u);
    l.el.classList.toggle('idle', t.status === 'waiting');
    l.el.classList.toggle('loser', !!S.winner && S.winner !== t.id && S.winner !== 'tie');
    let prev = 0;
    l.segs.innerHTML = t.steps.map((s) => { const w = pct(s.users - prev); prev = s.users; return `<i class="${s.ok ? 'ok' : 'fail'}" style="width:calc(${w}% - 1px)"></i>`; }).join('');
    $$('.pin', l.track).forEach((m) => m.remove());
    if (t.brokeAt) l.track.insertAdjacentHTML('beforeend', `<span class="pin crack" style="left:${pct(t.brokeAt.users)}%" title="نقطه‌ی شکست">${ic('xoct')}</span>`);
    const cap = t.result ? t.result.capacity : stableUsers(t);
    if (t.status !== 'waiting' && cap > 0 && (t.result || t.brokeAt)) l.track.insertAdjacentHTML('beforeend', `<span class="pin cap" style="left:${pct(cap)}%" title="ظرفیت پایدار">${ic('down')}</span>`);
    if (S.winner === t.id) l.track.insertAdjacentHTML('beforeend', `<span class="pin crown" style="left:${pct(t.result ? (t.result.reachedMax ? X.maxUsers : t.result.capacity) : u)}%" title="برنده">${ic('crown')}</span>`);
  });
  const v = $('#verdict');
  const T = Object.values(S.targets).filter((t) => t.result);
  if (S.winner && T.length > 1) {
    const cap = (t) => `${t.result.reachedMax ? '≥ ' : ''}${fmt(t.result.capacity)}`;
    const line = T.map((t) => `${t.name}: ${cap(t)} کاربر`).join('  ·  ');
    v.textContent = (S.winner === 'tie' ? 'نتیجه: مساوی' : `برنده: ${S.targets[S.winner].name}`) + ' — ظرفیت پایدار ' + line;
  } else v.textContent = '';
}

/* ---------------- gauges ---------------- */
const GAUGES = [
  { k: 'cpu', icon: 'cpu', label: 'CPU سرور' },
  { k: 'ram', icon: 'ram', label: 'RAM سرور' },
  { k: 'lat', icon: 'clock', label: 'تأخیر (p95)', limit: true },
  { k: 'err', icon: 'alert', label: 'خطا', limit: true },
  { k: 'thr', icon: 'activity', label: '' },
  { k: 'spd', icon: 'bolt', label: 'سرعت هر کاربر', vpn: true },
];
const gaugeHtml = (g) => `<div class="g c-none" data-k="${g.k}"><div class="ring"><svg class="r" viewBox="0 0 64 64" aria-hidden="true"><circle class="bgr" cx="32" cy="32" r="26"/><circle class="fgr" cx="32" cy="32" r="26"/>${g.limit ? '<line class="tk" x1="53.7" y1="28.6" x2="61.6" y2="27.3"/>' : ''}</svg><span class="gi">${ic(g.icon)}</span></div><div class="gv"><span class="gx"></span><span class="gt">—</span></div><div class="gl">${g.label}</div></div>`;
function setGauge(card, k, frac, level, text) {
  const g = $(`.g[data-k=${k}]`, card);
  if (!g) return;
  frac = clamp(frac);
  $('.fgr', g).style.strokeDasharray = `${(frac * 122.52).toFixed(1)} 163.36`;
  g.className = 'g c-' + (level === 'idle' ? 'none' : level);
  $('.gx', g).innerHTML = level === 'bad' ? ic('xoct') : level === 'warn' ? ic('alert') : '';
  $('.gt', g).textContent = text;
}

/* ---------------- dot field ---------------- */
const COLS = 40;
const ROWS = 5;
const N = COLS * ROWS;
class Field {
  constructor(cv) { this.cv = cv; this.lit = 0; this.okTo = N; this.color = '#888'; this.born = new Array(N).fill(0); this.prev = 0; }
  draw(now) {
    const dpr = window.devicePixelRatio || 1;
    const w = this.cv.clientWidth; const h = this.cv.clientHeight;
    if (!w) return;
    if (this.cv.width !== Math.round(w * dpr)) { this.cv.width = Math.round(w * dpr); this.cv.height = Math.round(h * dpr); }
    const g = this.cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    if (this.lit > this.prev) for (let k = this.prev; k < this.lit; k++) this.born[k] = now;
    this.prev = this.lit;
    const cw = w / COLS; const ch = h / ROWS; const r = Math.min(cw, ch) * 0.3;
    for (let k = 0; k < N; k++) {
      const col = Math.floor(k / ROWS); const row = ROWS - 1 - (k % ROWS);
      const lit = k < this.lit;
      g.globalAlpha = lit ? clamp(0.35 + (now - this.born[k]) / 250, 0.35, 1) : 1;
      g.beginPath();
      g.arc(col * cw + cw / 2, row * ch + ch / 2, lit ? r : r * 0.62, 0, 6.2832);
      g.fillStyle = lit ? (k >= this.okTo ? TH.bad : this.color) : TH.fill;
      g.fill();
    }
    g.globalAlpha = 1;
  }
}
function frame(now) {
  for (const c of Object.values(cards)) c.field.draw(now);
  requestAnimationFrame(frame);
}

/* ---------------- target cards ---------------- */
const KEYS = (id) => `<span><i style="background:${cvar(id)}"></i>تأخیر</span><span><i style="background:var(--bad)"></i>خطا</span><span><i style="background:var(--l2)"></i>CPU سرور</span><span><i style="background:var(--l3)"></i>کاربر</span><span><i style="background:transparent;border-top:2px dashed var(--l3);height:0"></i>حد مجاز</span>`;

function buildCard(t) {
  const el = document.createElement('div');
  el.className = 'tcard';
  el.setAttribute('role', 'group');
  el.setAttribute('aria-label', t.name);
  el.style.setProperty('--c', cvar(t.id));
  el.innerHTML = `
    <div class="chead"><i class="dot"></i><h2>${t.name}</h2><span class="proto"></span><span class="pill" role="status"></span></div>
    <div class="kpis">
      <div class="kpi"><span class="big" id="users">0</span><span class="lbl">${ic('users')}<span id="ulbl"></span></span></div>
      <div class="kpi"><span class="mid" id="thr">0</span><span class="lbl">${ic('activity')}<span id="tlbl"></span></span></div>
      <div class="kpi fin" id="fin" hidden><span class="mid" id="capv">0</span><span class="lbl">${ic('down')}ظرفیت پایدار</span></div>
    </div>
    <div class="field"><canvas role="img"></canvas></div>
    <div class="fcap"><span><i style="background:var(--c)"></i>کاربران در محدوده‌ی پایدار</span><span><i style="background:var(--bad)"></i>بالاتر از ظرفیت پایدار</span><span class="tab" id="unit"></span></div>
    <div class="gauges">${GAUGES.map(gaugeHtml).join('')}</div>
    <div class="split">
      <div class="sbar" data-k="cpu"><span>CPU</span><div class="tr"><i class="p"></i><i class="k"></i><i class="o"></i></div></div>
      <div class="sbar" data-k="ram"><span>RAM</span><div class="tr"><i class="p"></i><i class="k"></i><i class="o"></i></div></div>
      <div class="fcap legend"><span><i style="background:var(--c)"></i>پروسه‌ی پنل <b class="tab" id="lp"></b></span><span><i style="background:var(--l1)"></i>هسته (Xray) <b class="tab" id="lk"></b></span><span><i style="background:var(--l3)"></i>سایر</span></div>
    </div>
    <div class="pulse"><div class="ph"><b>فشار نسبت به حد مجاز</b><div class="keys">${KEYS(t.id)}</div></div><div class="cv"><canvas role="img" aria-label="نمودار فشار ${t.name} نسبت به حد مجاز"></canvas></div></div>
    <div class="errs"></div>`;
  $('#arena').appendChild(el);
  const col = tcol(t.id);
  const field = new Field($('.field canvas', el));
  field.color = col;
  const chart = new Chart($('.pulse canvas', el), {
    type: 'line',
    data: { datasets: [
      { label: 'users', data: [], borderColor: TH.l3, backgroundColor: TH.fill, fill: true, stepped: true, borderWidth: 1, order: 5 },
      { label: 'cpu', data: [], borderColor: TH.l2, order: 4 },
      { label: 'latency', data: [], borderColor: col, order: 2 },
      { label: 'errors', data: [], borderColor: TH.bad, order: 1 },
      { label: 'limit', data: [], borderColor: TH.l3, borderDash: [5, 4], borderWidth: 1, order: 6 },
    ] },
    options: { parsing: false, animation: false, responsive: true, maintainAspectRatio: false, normalized: true,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      elements: { point: { radius: 0 }, line: { borderWidth: 2, tension: 0.25 } },
      scales: { x: { type: 'linear', display: false }, y: { display: false, min: 0, suggestedMax: 130 } } },
  });
  cards[t.id] = { el, field, chart, t };
}

function pushPoint(id, p, bulk) {
  const c = cards[id];
  if (!c) return;
  const X = P();
  const d = c.chart.data.datasets;
  d[0].data.push({ x: p.t, y: (p.users / X.maxUsers) * 100 });
  d[1].data.push({ x: p.t, y: p.cpu });
  d[2].data.push({ x: p.t, y: (p.p95 / X.maxP95Ms) * 100 });
  d[3].data.push({ x: p.t, y: (p.errPct / X.maxErrPct) * 100 });
  d[4].data = [{ x: 0, y: 100 }, { x: p.t, y: 100 }];
  if (!bulk) c.chart.update('none');
}

function paintCard(id) {
  const c = cards[id];
  if (!c) return;
  const t = S.targets[id];
  const el = c.el;
  const p = last(t) || {};
  const X = P();
  const vpn = isVpn();
  const h = healthOf(t);
  const [pi, pt] = pillOf(t, h);
  const pill = $('.pill', el);
  pill.style.setProperty('--s', lvColor(h));
  pill.innerHTML = ic(pi) + `<span>${pt}</span>`;
  el.classList.toggle('bad', h === 'bad');
  el.style.opacity = t.status === 'waiting' ? 0.6 : 1;
  $('.proto', el).textContent = t.protocol || '';
  $('.proto', el).style.display = t.protocol ? '' : 'none';
  $('#users', el).textContent = fmt(p.users ?? t.users ?? 0);
  $('#ulbl', el).textContent = vpn ? 'کاربر متصل (همزمان)' : 'کاربر مجازی';
  const thr = thrOf(p);
  $('#thr', el).textContent = vpn ? fmt(thr, 1) : fmt(thr);
  $('#tlbl', el).textContent = vpn ? 'Mbps پهنای باند' : 'درخواست در ثانیه';
  const fin = $('#fin', el);
  fin.hidden = !t.result;
  if (t.result) $('#capv', el).textContent = (t.result.reachedMax ? '≥ ' : '') + fmt(t.result.capacity);
  // dot field
  const unit = Math.max(1, Math.round(X.maxUsers / N));
  $('#unit', el).textContent = `هر نقطه ≈ ${fmt(unit)} کاربر`;
  c.field.lit = p.users ? Math.max(1, Math.round((p.users / X.maxUsers) * N)) : 0;
  c.field.okTo = t.brokeAt ? Math.round((stableUsers(t) / X.maxUsers) * N) : N;
  $('canvas', $('.field', el)).setAttribute('aria-label', `${t.name}: ${fmt(p.users || 0)} کاربر`);
  // gauges
  const lvLoad = (v) => (v >= 90 ? 'bad' : v >= 70 ? 'warn' : 'ok');
  const lvLim = (r) => (r >= 1 ? 'bad' : r >= 0.5 ? 'warn' : 'ok');
  const has = p.cpu != null;
  setGauge(el, 'cpu', has ? p.cpu / 100 : 0, has ? lvLoad(p.cpu) : 'idle', has ? fmt(p.cpu) + '%' : 'بدون ایجنت');
  setGauge(el, 'ram', p.memPct != null ? p.memPct / 100 : 0, p.memPct != null ? lvLoad(p.memPct) : 'idle', p.memPct != null ? fmt(p.memPct) + '%' : 'بدون ایجنت');
  const rl = (p.p95 || 0) / X.maxP95Ms;
  setGauge(el, 'lat', rl / 1.25, p.p95 == null ? 'idle' : lvLim(rl), p.p95 == null ? '—' : fmt(p.p95) + ' ms');
  const re = (p.errPct || 0) / X.maxErrPct;
  setGauge(el, 'err', re / 1.25, p.p95 == null ? 'idle' : lvLim(re), p.p95 == null ? '—' : fmt(p.errPct, 1) + '%');
  const thrG = $('.g[data-k=thr]', el);
  $('.gl', thrG).textContent = vpn ? 'پهنای باند' : 'درخواست/ثانیه';
  setGauge(el, 'thr', thr / Math.max(thrRef, 1), p.p95 == null ? 'idle' : 'neutral', p.p95 == null ? '—' : vpn ? fmt(thr, 1) + ' Mbps' : fmt(thr) + ' rps');
  const sg = $('.g[data-k=spd]', el);
  sg.style.display = vpn && X.userKbps > 0 ? '' : 'none';
  if (vpn && X.userKbps > 0) {
    const need = (X.userKbps * X.minUserPct) / 100;
    const enough = p.active >= 10;
    setGauge(el, 'spd', (p.userKbps || 0) / X.userKbps, enough ? (p.userKbps < need ? 'bad' : p.userKbps < X.userKbps * 0.9 ? 'warn' : 'ok') : 'idle', enough ? fmt(p.userKbps) + ' kbps' : '—');
  }
  // process split
  const cores = p.cores || 1;
  const tot = (p.cpu || 0) / 100;
  const pc = p.panelCpu != null ? p.panelCpu / cores / 100 : 0;
  const kc = p.coreCpu != null ? p.coreCpu / cores / 100 : 0;
  const cpuBar = $('.sbar[data-k=cpu]', el);
  $('.p', cpuBar).style.width = pc * 100 + '%';
  $('.k', cpuBar).style.width = kc * 100 + '%';
  $('.o', cpuBar).style.width = clamp(tot - pc - kc) * 100 + '%';
  const mt = p.memTotalMB || 0;
  const pm = mt && p.panelMem != null ? p.panelMem / mt : 0;
  const km = mt && p.coreMem != null ? p.coreMem / mt : 0;
  const ramBar = $('.sbar[data-k=ram]', el);
  $('.p', ramBar).style.width = pm * 100 + '%';
  $('.k', ramBar).style.width = km * 100 + '%';
  $('.o', ramBar).style.width = clamp((p.memPct || 0) / 100 - pm - km) * 100 + '%';
  $('#lp', el).textContent = p.panelCpu != null ? `${fmt(pc * 100, 1)}%` : '';
  $('#lk', el).textContent = p.coreCpu != null ? `${fmt(kc * 100, 1)}%` : '';
  $('.errs', el).innerHTML = (t.errors || []).map((e) => `<span>${e}</span>`).join('');
}

/* ---------------- compare ---------------- */
function mkCmp(id, key) {
  cmp[key] = new Chart($(id), {
    type: 'line', data: { datasets: [] },
    options: { parsing: false, animation: false, responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { color: TH.l2, usePointStyle: true, boxWidth: 8, font: { size: 12 } } } },
      elements: { point: { radius: 3.5 }, line: { borderWidth: 2.5, tension: 0.2 } },
      scales: {
        x: { type: 'linear', ticks: { color: TH.l2, maxTicksLimit: 8 }, grid: { color: TH.sep }, title: { display: true, text: 'تعداد کاربر', color: TH.l2 } },
        y: { beginAtZero: true, ticks: { color: TH.l2, maxTicksLimit: 5 }, grid: { color: TH.sep } } },
    },
  });
}
function rebuildCompare() {
  Object.values(cmp).forEach((c) => c.destroy());
  mkCmp('#cmp_p95', 'p95'); mkCmp('#cmp_err', 'err'); mkCmp('#cmp_cpu', 'cpu'); mkCmp('#cmp_thr', 'thr');
  paintCompare();
}
function paintCompare() {
  const vpn = isVpn();
  const keys = { p95: (s) => s.p95, err: (s) => s.errPct, cpu: (s) => s.cpu, thr: (s) => (vpn ? s.mbps : s.rps) };
  for (const [k, f] of Object.entries(keys)) {
    cmp[k].data.datasets = Object.values(S.targets).map((t) => ({
      label: t.name, borderColor: tcol(t.id), backgroundColor: tcol(t.id),
      data: t.steps.filter((s) => f(s) != null).map((s) => ({ x: s.users, y: f(s) })),
    }));
    cmp[k].update('none');
  }
}

const PEAKS = [
  { k: 'peakCpu', icon: 'cpu', title: 'بیشترین CPU سرور', norm: 100, unit: '%' },
  { k: 'peakMem', icon: 'ram', title: 'بیشترین RAM سرور', norm: 100, unit: '%' },
  { k: 'thr', icon: 'activity', title: () => (isVpn() ? 'بیشترین پهنای باند' : 'بیشترین درخواست در ثانیه'), unit: () => (isVpn() ? ' Mbps' : '') },
  { k: 'peakTcp', icon: 'link', title: 'بیشترین اتصال TCP', unit: '' },
];
function buildPeaks() {
  $('#peaks').innerHTML = PEAKS.map((r) => `<div class="peak" data-k="${r.k}"><h3>${ic(r.icon)}${typeof r.title === 'function' ? r.title() : r.title}</h3>${Object.values(S.targets).map((t) => `<div class="prow" data-id="${t.id}"><span class="pn"><i style="background:${cvar(t.id)}"></i>${t.name}</span><div class="pbar"><i style="background:${cvar(t.id)}"></i></div><span class="pv">—</span></div>`).join('')}</div>`).join('');
}
function paintPeaks() {
  const T = Object.values(S.targets).filter((t) => t.result);
  PEAKS.forEach((r) => {
    const val = (t) => (r.k === 'thr' ? (isVpn() ? t.result.peakMbps : t.result.peakRps) : t.result[r.k]);
    const unit = typeof r.unit === 'function' ? r.unit() : r.unit;
    const mx = r.norm || Math.max(1, ...T.map(val));
    T.forEach((t) => {
      const row = $(`.peak[data-k=${r.k}] .prow[data-id=${t.id}]`);
      if (!row) return;
      $('.pbar i', row).style.width = clamp(val(t) / mx) * 100 + '%';
      $('.pv', row).textContent = fmt(val(t), 1) + unit;
    });
  });
}

/* ---------------- (re)build ---------------- */
function rebuild() {
  $('#arena').innerHTML = '';
  Object.keys(cards).forEach((k) => { cards[k].chart.destroy(); delete cards[k]; });
  if (!S.targets || !Object.keys(S.targets).length) {
    const base = cfg ? cfg.targets.filter((t) => t.enabled !== false) : [];
    S.targets = Object.fromEntries(base.map((t) => [t.id, { ...t, series: [], steps: [], status: 'waiting', users: 0, errors: [], protocol: '' }]));
  }
  thrRef = 1;
  Object.values(S.targets).forEach((t) => t.series.forEach((p) => { thrRef = Math.max(thrRef, thrOf(p)); }));
  buildRace();
  Object.values(S.targets).forEach(buildCard);
  Object.values(S.targets).forEach((t) => {
    t.series.forEach((p) => pushPoint(t.id, p, true));
    cards[t.id].chart.update('none');
    paintCard(t.id);
  });
  if (!isRunning() && S.startedAt && !S.lastTickAt) {
    const mx = Math.max(0, ...Object.values(S.targets).map((t) => (last(t) ? last(t).t : 0)));
    S.lastTickAt = S.startedAt + mx * 1000;
  }
  buildPeaks();
  rebuildCompare();
  paintRace(); paintPeaks(); paintTop(); paintBanners();
}

/* ---------------- start / stop ---------------- */
$('#startBtn').onclick = async () => {
  try {
    if (isRunning()) return await api('/api/stop', 'POST');
    const t = { type: ui.type, mode: ui.mode, ...ctl };
    await api('/api/config', 'PUT', { test: t });
    await api('/api/start', 'POST', t);
  } catch (e) { toast('error', 'alert', e.message); }
};

/* ---------------- test setup (sliders) ---------------- */
const SLIDERS = [
  ['startUsers', 'users', 1, 2000, 10, 'شروع از چند کاربر', ''],
  ['stepUsers', 'trend', 1, 1000, 1, 'افزایش هر پله (کاربر)', ''],
  ['stepSeconds', 'clock', 5, 60, 1, 'مدت هر پله', ' ثانیه'],
  ['maxUsers', 'flag', 100, 20000, 100, 'سقف کاربر', ''],
  ['maxErrPct', 'alert', 0.5, 20, 0.5, 'حداکثر خطای مجاز', '%'],
  ['maxP95Ms', 'hourglass', 100, 5000, 50, 'حداکثر تأخیر مجاز (p95)', ' ms'],
  ['userKbps', 'bolt', 0, 10000, 64, 'سرعت هر کاربر در تست VPN (۰ = نامحدود)', ' kbps'],
];
function drawRamp() {
  const n = Math.min(60, Math.ceil((ctl.maxUsers - ctl.startUsers) / ctl.stepUsers) + 1);
  $('#rampPrev').innerHTML = Array.from({ length: Math.max(1, n) }, (_, i) => `<i style="height:${clamp((ctl.startUsers + (i * (ctl.maxUsers - ctl.startUsers)) / Math.max(1, n - 1)) / ctl.maxUsers) * 100}%"></i>`).join('');
}
function openSetup() {
  $('#setupBody').innerHTML = `<div class="foot" style="margin-bottom:6px">شکل پله‌ها (هر ستون یک پله)</div><div class="ramp" id="rampPrev"></div>` +
    SLIDERS.map(([k, icn, min, max, step, label, unit]) => `<div class="sl"><div class="sr">${ic(icn)}<span>${label}</span><output data-u="${unit}">${ctl[k]}${unit}</output></div><input type="range" data-k="${k}" min="${min}" max="${max}" step="${step}" value="${ctl[k]}" aria-label="${label}"></div>`).join('');
  drawRamp();
  $$('#setupBody input[type=range]').forEach((r) => {
    r.oninput = () => { ctl[r.dataset.k] = Number(r.value); const o = r.previousElementSibling.querySelector('output'); o.textContent = r.value + o.dataset.u; drawRamp(); };
  });
  $('#setup').showModal();
}
$('#setupBtn').onclick = openSetup;
$('#setupClose').onclick = () => $('#setup').close();

/* ---------------- boot ---------------- */
async function loadConfig() {
  cfg = await api('/api/config');
  Object.keys(ctl).forEach((k) => { if (cfg.test[k] != null) ctl[k] = cfg.test[k]; });
  if (!isRunning() && !(S && S.type)) { ui.type = cfg.test.type; ui.mode = cfg.test.mode; }
  applyType();
  if (S && !isRunning() && !Object.values(S.targets).some((t) => t.series.length)) { S.targets = {}; rebuild(); }
}

(async () => {
  loadTheme();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { loadTheme(); if (S) rebuild(); });
  initStatic();
  await loadConfig();
  S = { status: 'idle', targets: {}, events: [], warnings: [] };
  rebuild();
  connect();
  requestAnimationFrame(frame);
})();
