'use strict';
// "Servers" dialog: connect a panel, auto-create test users, install the agent with one command.
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const lines = (s) => s.split('\n').map((x) => x.trim()).filter(Boolean);
const fld = (label, name, val, type = 'text', ph = '', secret = true, extra = '') =>
  `<div class="f ${extra}"><label>${label}</label><input name="${name}" type="${type}" value="${esc(val)}" placeholder="${esc(ph)}" class="${secret ? 'secret' : ''}" autocomplete="off"></div>`;

const KIND_LABEL = { '3xui': '3x-ui', nexora: 'Nexora', custom: 'دستی / سایر پنل‌ها' };

function targetFieldset(t) {
  const h = t._has || {};
  const kind = t.kind || 'custom';
  const pv = t.provision;
  return `<fieldset data-id="${t.id}" data-kind="${kind}"><legend>سرور ${t.id}</legend>
    <label class="tgl"><input type="checkbox" name="enabled" ${t.enabled !== false ? 'checked' : ''}><span>این سرور در تست شرکت کند</span><small>برای تست فقط یک سرور، سرور دیگر را خاموش کنید</small></label>
    <div class="tbody">
    <div class="step"><b>۱</b> اتصال به پنل</div>
    <div class="row">
      ${fld('نام نمایشی', 'name', t.name, 'text', '', false)}
      <div class="f"><label>نوع پنل</label><select name="kind">${Object.entries(KIND_LABEL).map(([k, v]) => `<option value="${k}" ${k === kind ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      ${fld('آدرس پنل (با مسیر مخفی، اگر دارد)', 'panelUrl', t.panelUrl, 'text', 'http://1.2.3.4:2053/مسیر')}
      ${fld('نام کاربری ادمین', 'username', t.username)}
      ${fld('رمز عبور ادمین', 'password', '', 'password', h.password ? '•••• ذخیره شده' : '')}
      <div class="f only-nexora"><label>یا توکن API (برای حساب‌های 2FA)</label><input name="apiToken" type="password" class="secret" placeholder="${h.apiToken ? '•••• ذخیره شده' : 'اختیاری'}" autocomplete="off"></div>
      <div class="f"><label>گواهی TLS نامعتبر (self-signed)</label><select name="insecureTls"><option value="0">رد شود</option><option value="1" ${t.insecureTls ? 'selected' : ''}>قبول شود</option></select></div>
    </div>
    <div class="btns"><button type="button" data-act="connect" class="primary">اتصال و بررسی</button></div>
    <div class="testout" data-out="connect"></div>

    <div class="step only-api"><b>۲</b> کاربران تست (خودکار از طریق API پنل)</div>
    <div class="row only-api">
      ${fld('تعداد کاربر تست', 'count', (pv && pv.count) || 200, 'number', '', false)}
      <div class="f only-3xui"><label>پروتکل</label><select name="protocol">${[['vless', 'VLESS + TCP'], ['vmess', 'VMess + TCP'], ['trojan', 'Trojan + TCP'], ['shadowsocks', 'Shadowsocks']].map(([k, v]) => `<option value="${k}" ${pv && pv.protocol === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      ${fld('پورت اینباند تست', 'port', (pv && pv.port) || 24443, 'number', '', false, 'only-3xui')}
    </div>
    <div class="btns only-api">
      <button type="button" data-act="provision" class="primary">ساخت خودکار کاربران تست</button>
      <button type="button" data-act="deprovision">حذف کاربران تست از پنل</button>
    </div>
    <div class="hint only-nexora">برای Nexora باید قبلاً یک inbound (مثلاً VLESS + TCP) در پنل ساخته باشید؛ کاربران تست به آن وصل می‌شوند. روی پنل دیگر هم همین پروتکل را بسازید.</div>
    <div class="status" data-out="prov">${pv ? `✓ ${pv.count} کاربر تست ساخته شده${pv.protocol ? ' (' + pv.protocol + ')' : ''}` : 'هنوز کاربر تستی ساخته نشده'}</div>

    <div class="step"><b>۳</b> ایجنت روی سرور پنل (آمار دقیق CPU / RAM / مصرف هسته)</div>
    <div class="status" data-out="agent">${h.agent ? '✓ ایجنت متصل است' : 'ایجنت نصب نشده؛ بدون آن آمار از خود API پنل گرفته می‌شود (کم‌دقت‌تر). این دستور را روی همان سرور پنل Paste کنید:'}</div>
    <div class="cmdbox"><textarea readonly rows="2" data-cmd class="secret"></textarea><button type="button" data-act="copy">کپی</button></div>

    <details class="adv" ${kind === 'custom' ? 'open' : ''}><summary>تنظیمات پیشرفته (سناریوی دستی، لینک‌ها، ایجنت دستی)</summary>
      <div class="row">
        ${fld('اسم پروسه پنل (برای آمار جدا)', 'panelProc', t.panelProc, 'text', 'x-ui', false)}
        ${fld('اسم پروسه هسته', 'coreProc', t.coreProc, 'text', 'xray', false)}
        ${fld('آدرس ایجنت (دستی)', 'agentUrl', t.agentUrl, 'text', 'http://1.2.3.4:9100')}
        ${fld('توکن ایجنت (دستی)', 'agentToken', '', 'password', h.agentToken ? '•••• ذخیره شده' : '')}
      </div>
      <div class="row">
        <div class="f wide"><label>لینک‌های سابسکریپشن کاربران تست (هر خط یکی) ${h.subs ? `— ${h.subs} مورد ذخیره شده` : ''}</label>
          <textarea name="subscriptionUrls" class="secret" data-touched="0" placeholder="${h.subs ? 'خالی = حفظ موارد ذخیره‌شده' : 'https://panel:2096/sub/abc123'}"></textarea></div>
        <div class="f wide"><label>لینک‌های مستقیم vless:// vmess:// trojan:// ss:// hysteria2:// tuic:// ${h.links ? `— ${h.links} مورد ذخیره شده` : ''}</label>
          <textarea name="links" class="secret" data-touched="0" placeholder="${h.links ? 'خالی = حفظ موارد ذخیره‌شده' : ''}"></textarea></div>
      </div>
      <div class="f wide"><label>سناریوی درخواست‌های ادمین (JSON). role: login یک‌بار برای هر سشن، admin تکرار می‌شود</label>
        <textarea name="steps" style="min-height:130px">${esc(JSON.stringify(t.steps || [], null, 2))}</textarea>
        <div class="btns"><button type="button" data-act="preset">پیش‌فرض 3x-ui</button><button type="button" data-act="curl">+ افزودن از cURL</button></div>
        <div class="curlbox" hidden>
          <div class="hint">DevTools مرورگر ← Network ← روی درخواست راست‌کلیک ← Copy as cURL، و اینجا بچسبانید.</div>
          <textarea name="curlText" placeholder="curl 'https://…' -H '…'"></textarea>
          <div class="btns"><select name="curlRole"><option value="admin">درخواست ادمین (تکرار شود)</option><option value="login">درخواست ورود (یک‌بار)</option></select><button type="button" data-act="curlAdd">افزودن به سناریو</button></div>
        </div>
      </div>
      <div class="btns">
        <button type="button" data-act="tpanel">تست درخواست‌های سناریو</button>
        <button type="button" data-act="tlinks">تست لینک‌ها</button>
        <button type="button" data-act="tagent">تست ایجنت</button>
        <button type="button" data-act="tvpn">تست یک اتصال VPN واقعی</button>
      </div>
      <div class="testout" data-out="adv"></div>
    </details>
    </div>
  </fieldset>`;
}

async function openSettings() {
  cfg = await api('/api/config');
  const g = cfg.generator;
  const T = cfg.test;
  $('#dlgForm').innerHTML = `
    <div class="dhead"><b>سرورها</b><button type="button" id="dclose" class="plain" aria-label="بستن">✕</button></div>
    <div class="dbody">
      <fieldset id="gen"><legend>سرور سوم (همین داشبورد)</legend>
        <div class="row">
          <div class="f"><label>IP عمومی این سرور (برای تست VPN)</label><div class="inl"><input name="publicHost" class="secret" value="${esc(g.publicHost)}" placeholder="5.6.7.8"><button type="button" data-act="myip">تشخیص خودکار</button></div></div>
          ${fld('سرعت کارت شبکه این سرور (Mbps)', 'nicMbps', g.nicMbps, 'number', '', false)}
        </div>
        <details class="adv"><summary>پیشرفته</summary><div class="row">
          ${fld('پورت منبع دانلود', 'blobPort', g.blobPort, 'number', '', false)}
          ${fld('فیلتر لینک‌ها (regex)', 'filter', T.filter, 'text', '^vless://', false)}
          ${fld('تعداد سشن ادمین مشترک', 'sessions', T.sessions, 'number', '', false)}
          ${fld('درصد درخواست‌های سابسکریپشن', 'subPct', T.subPct, 'number', '', false)}
          ${fld('مکث بین درخواست‌های هر کاربر (ms)', 'thinkMs', T.thinkMs, 'number', '', false)}
        </div></details>
      </fieldset>
      ${cfg.targets.map(targetFieldset).join('')}
    </div>
    <div class="dfoot"><button type="button" id="dsave" class="primary">ذخیره و بستن</button></div>`;
  $('#dlg').showModal();
  $('#dclose').onclick = () => $('#dlg').close();
  $('#dsave').onclick = async () => { try { await saveForm(); $('#dlg').close(); await loadConfig(); paintBanners(); } catch (e) { alert(e.message); } };
  $$('#dlgForm textarea[data-touched]').forEach((ta) => ta.addEventListener('input', () => (ta.dataset.touched = '1')));
  $('#gen').onclick = async (e) => {
    if (e.target.dataset.act !== 'myip') return;
    try { $('#gen [name=publicHost]').value = (await api('/api/myip')).ip; } catch (err) { alert(err.message); }
  };
  $$('#dlgForm fieldset[data-id]').forEach(wireTarget);
}

async function saveForm() {
  const f = $('#dlgForm');
  const gv = (n) => f.elements[n];
  const body = {
    generator: { publicHost: gv('publicHost').value.trim(), blobPort: Number(gv('blobPort').value), nicMbps: Number(gv('nicMbps').value) },
    test: { filter: gv('filter').value.trim(), sessions: Number(gv('sessions').value), subPct: Number(gv('subPct').value), thinkMs: Number(gv('thinkMs').value) },
    targets: [],
  };
  $$('fieldset[data-id]', f).forEach((fs) => {
    const q = (n) => fs.querySelector(`[name=${n}]`);
    let steps;
    try { steps = JSON.parse(q('steps').value || '[]'); } catch { throw new Error('JSON سناریو در سرور ' + fs.dataset.id + ' معتبر نیست'); }
    body.targets.push({
      id: fs.dataset.id, enabled: q('enabled').checked, name: q('name').value, kind: q('kind').value, panelUrl: q('panelUrl').value.trim(), username: q('username').value,
      password: q('password').value, apiToken: q('apiToken').value, agentUrl: q('agentUrl').value.trim(), agentToken: q('agentToken').value,
      panelProc: q('panelProc').value.trim(), coreProc: q('coreProc').value.trim(), insecureTls: q('insecureTls').value === '1', steps,
      subscriptionUrls: q('subscriptionUrls').dataset.touched === '1' ? lines(q('subscriptionUrls').value) : null,
      links: q('links').dataset.touched === '1' ? lines(q('links').value) : null,
    });
  });
  if (!body.targets.some((t) => t.enabled)) throw new Error('حداقل یک سرور باید در تست شرکت کند');
  await api('/api/config', 'PUT', body);
}

function wireTarget(fs) {
  const id = fs.dataset.id;
  const q = (n) => fs.querySelector(`[name=${n}]`);
  const out = (k) => fs.querySelector(`[data-out=${k}]`);
  const show = (k, txt) => { const o = out(k); o.style.display = 'block'; o.textContent = txt; };
  const sync = () => { fs.dataset.kind = q('kind').value; fs.dataset.on = q('enabled').checked ? '1' : '0'; };
  q('kind').onchange = sync;
  q('enabled').onchange = sync;
  sync();
  api('/api/enroll-command/' + id).then((r) => { fs.querySelector('[data-cmd]').value = r.command; if (r.enrolled) out('agent').textContent = '✓ ایجنت متصل است (برای نصب دوباره همین دستور را اجرا کنید)'; }).catch(() => {});
  fs.onclick = async (e) => {
    const act = e.target.dataset.act;
    if (!act) return;
    const btn = e.target;
    try {
      if (act === 'copy') { await navigator.clipboard.writeText(fs.querySelector('[data-cmd]').value); btn.textContent = 'کپی شد ✓'; setTimeout(() => (btn.textContent = 'کپی'), 1500); return; }
      if (act === 'preset') { q('steps').value = JSON.stringify((await api('/api/preset/3xui')).steps, null, 2); return; }
      if (act === 'curl') { fs.querySelector('.curlbox').hidden = !fs.querySelector('.curlbox').hidden; return; }
      if (act === 'curlAdd') {
        const r = await api('/api/curl-import', 'POST', { id, curl: q('curlText').value, role: q('curlRole').value, panelUrl: q('panelUrl').value.trim() });
        const arr = JSON.parse(q('steps').value || '[]');
        arr.push(r.step);
        q('steps').value = JSON.stringify(arr, null, 2);
        q('curlText').value = '';
        show('adv', '✔ اضافه شد: ' + r.step.name);
        return;
      }
      const slot = { connect: 'connect', provision: 'prov', deprovision: 'prov' }[act] || 'adv';
      btn.disabled = true;
      show(slot, 'در حال انجام…');
      await saveForm();
      if (act === 'connect') {
        const r = await api('/api/connect', 'POST', { id });
        const s = r.status || {};
        show('connect', s.error ? `✓ ورود موفق بود، ولی خواندن وضعیت سرور ناموفق: ${s.error}` : `✓ متصل شد — CPU ${s.cpu ?? '؟'}٪ · RAM ${s.memPct ?? '؟'}٪ · ${s.cores ?? '؟'} هسته${s.version ? ' · نسخه ' + s.version : ''}`);
      } else if (act === 'provision') {
        const r = await api('/api/provision', 'POST', { id, count: Number(q('count').value), protocol: q('protocol').value, port: Number(q('port').value) });
        show('prov', `✓ ${r.count} کاربر تست ساخته شد${r.protocol ? ' (' + r.protocol + (r.port ? ' روی پورت ' + r.port : '') + ')' : ''}${r.note ? '\n⚠ ' + r.note : ''}`);
      } else if (act === 'deprovision') {
        const r = await api('/api/deprovision', 'POST', { id });
        show('prov', `✓ حذف شد (${r.removed} مورد)`);
      } else if (act === 'tpanel') {
        const r = await api('/api/test/panel', 'POST', { id });
        show('adv', r.results.map((x) => `${x.ok ? '✔' : '✖'} ${x.name}  ${x.status || ''} ${x.ms != null ? x.ms + 'ms' : ''} ${x.error || ''} ${x.snippet ? '\n    ' + x.snippet : ''}`).join('\n'));
      } else if (act === 'tlinks') {
        const r = await api('/api/test/links', 'POST', { id });
        show('adv', `${r.count} لینک قابل استفاده\n` + Object.entries(r.protocols).map(([k, v]) => `  ${k}: ${v}`).join('\n') + (r.errors.length ? '\n⚠ ' + r.errors.join('\n⚠ ') : ''));
      } else if (act === 'tagent') {
        const r = await api('/api/test/agent', 'POST', { id });
        show('adv', r.ok ? `✔ ایجنت جواب داد — CPU ${r.stats.cpu}%  RAM ${r.stats.memPct}%  هسته‌ها ${r.stats.cores}` : '✖ ایجنت جواب نداد (آدرس/توکن/فایروال را بررسی کنید)');
      } else if (act === 'tvpn') {
        const r = await api('/api/test/vpn', 'POST', { id });
        show('adv', r.ok ? `✔ اتصال VPN برقرار شد (${r.protocols}) — حدود ${r.mbpsApprox} Mbps، زمان اتصال ${r.ttfbMs}ms` : `✖ اتصال برقرار نشد ${r.errors.join(', ')}`);
      }
      if (['provision', 'deprovision'].includes(act)) await loadConfig();
    } catch (err) { show({ connect: 'connect', provision: 'prov', deprovision: 'prov' }[act] || 'adv', '✖ ' + err.message); } finally { btn.disabled = false; }
  };
}
$('#settingsBtn').onclick = () => openSettings().catch((e) => alert(e.message));
