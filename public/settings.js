'use strict';
// Settings dialog (forms stay textual: they are configuration, not the dashboard).
/* ---------------- settings dialog ---------------- */
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const fld = (label, name, val, type = 'text', ph = '', secret = true) =>
  `<div class="f"><label>${label}</label><input name="${name}" type="${type}" value="${esc(val)}" placeholder="${esc(ph)}" class="${secret ? 'secret' : ''}" autocomplete="off"></div>`;

function targetFieldset(t) {
  const h = t._has || {};
  return `<fieldset data-id="${t.id}"><legend style="color:${t.color}">پنل ${t.id}: ${esc(t.name)}</legend>
    <div class="row">
      ${fld('نام نمایشی', 'name', t.name, 'text', '', false)}
      ${fld('آدرس پنل (با مسیر مخفی اگر دارد)', 'panelUrl', t.panelUrl, 'text', 'http://1.2.3.4:2053/secretpath')}
      ${fld('نام کاربری ادمین', 'username', t.username)}
      ${fld('رمز عبور ادمین', 'password', '', 'password', h.password ? '•••• ذخیره شده — برای تغییر تایپ کنید' : '')}
    </div>
    <div class="row">
      ${fld('آدرس ایجنت (روی سرور این پنل)', 'agentUrl', t.agentUrl, 'text', 'http://1.2.3.4:9100')}
      ${fld('توکن ایجنت', 'agentToken', '', 'password', h.agentToken ? '•••• ذخیره شده' : '')}
      ${fld('اسم پروسه پنل (برای آمار جدا)', 'panelProc', t.panelProc, 'text', 'x-ui', false)}
      ${fld('اسم پروسه هسته', 'coreProc', t.coreProc, 'text', 'xray', false)}
      <div class="f"><label>گواهی TLS نامعتبر مجاز؟</label><select name="insecureTls"><option value="0">خیر</option><option value="1" ${t.insecureTls ? 'selected' : ''}>بله (self-signed)</option></select></div>
    </div>
    <div class="row">
      <div class="f wide"><label>لینک‌های سابسکریپشن کاربران تست (هر خط یکی) ${h.subs ? `— ${h.subs} مورد ذخیره شده` : ''}</label>
        <textarea name="subscriptionUrls" class="secret" data-touched="0" placeholder="${h.subs ? 'برای حفظ موارد ذخیره‌شده خالی بگذارید؛ برای جایگزینی لینک‌های جدید را بچسبانید' : 'https://panel:2096/sub/abc123'}"></textarea></div>
      <div class="f wide"><label>یا لینک‌های مستقیم کانفیگ vless:// vmess:// trojan:// ss:// hysteria2:// tuic:// ${h.links ? `— ${h.links} مورد ذخیره شده` : ''}</label>
        <textarea name="links" class="secret" data-touched="0" placeholder="${h.links ? 'خالی = حفظ موارد ذخیره‌شده' : ''}"></textarea></div>
    </div>
    <div class="f wide"><label>سناریوی درخواست‌های ادمین (JSON). role: login یک‌بار برای هر سشن، admin تکرار می‌شود</label>
      <textarea name="steps" style="min-height:150px">${esc(JSON.stringify(t.steps || [], null, 2))}</textarea>
      <div class="btns">
        <button type="button" data-act="preset">پیش‌فرض 3x-ui</button>
        <button type="button" data-act="curl">+ افزودن از cURL</button>
      </div>
      <div class="curlbox" hidden>
        <div class="hint">در مرورگر: DevTools ← Network ← روی درخواست راست‌کلیک ← Copy ← Copy as cURL، و اینجا بچسبانید. اول ورود (login)، بعد لیست کاربران و ...</div>
        <textarea name="curlText" placeholder="curl 'https://…' -H '…'"></textarea>
        <div class="btns"><select name="curlRole"><option value="admin">درخواست ادمین (تکرار شود)</option><option value="login">درخواست ورود (یک‌بار)</option></select><button type="button" data-act="curlAdd">افزودن به سناریو</button></div>
      </div>
    </div>
    <div class="btns">
      <button type="button" data-act="tpanel">تست درخواست‌های پنل</button>
      <button type="button" data-act="tlinks">تست لینک‌ها/سابسکریپشن</button>
      <button type="button" data-act="tagent">تست ایجنت</button>
      <button type="button" data-act="tvpn">تست یک اتصال VPN واقعی</button>
    </div>
    <div class="testout"></div>
  </fieldset>`;
}

async function openSettings() {
  cfg = await api('/api/config');
  const g = cfg.generator;
  const T = cfg.test;
  $('#dlgForm').innerHTML = `
    <div class="dhead"><b>تنظیمات</b><button type="button" id="dclose" class="ghost">بستن ✕</button></div>
    <div class="dbody">
      <fieldset id="gen"><legend>سرور سوم (مولد بار — همین برنامه)</legend>
        <div class="row">
          ${fld('IP عمومی این سرور (برای تست VPN لازم است)', 'publicHost', g.publicHost, 'text', '5.6.7.8')}
          ${fld('پورت منبع دانلود', 'blobPort', g.blobPort, 'number', '', false)}
          ${fld('سرعت کارت شبکه این سرور (Mbps)', 'nicMbps', g.nicMbps, 'number', '', false)}
          ${fld('فیلتر لینک‌ها (regex، اختیاری)', 'filter', T.filter, 'text', '^vless://.*security=reality', false)}
          ${fld('تعداد سشن ادمین مشترک', 'sessions', T.sessions, 'number', '', false)}
          ${fld('درصد درخواست‌های سابسکریپشن (بقیه ادمین)', 'subPct', T.subPct, 'number', '', false)}
          ${fld('مکث بین درخواست‌های هر کاربر (ms)', 'thinkMs', T.thinkMs, 'number', '', false)}
        </div>
        <div class="hint">پورت منبع دانلود باید در فایروال سرور سوم باز باشد. سرورهای VPN از آن دانلود می‌کنند.</div>
      </fieldset>
      ${cfg.targets.map(targetFieldset).join('')}
    </div>
    <div class="dfoot"><button type="button" id="dsave" class="primary">ذخیره</button></div>`;
  $('#dlg').showModal();
  $('#dclose').onclick = () => $('#dlg').close();
  $('#dsave').onclick = async () => { try { await saveForm(); $('#dlg').close(); await loadConfig(); } catch (e) { alert(e.message); } };
  $$('#dlgForm textarea[data-touched]').forEach((ta) => ta.addEventListener('input', () => (ta.dataset.touched = '1')));
  $$('#dlgForm fieldset[data-id]').forEach(wireTarget);
}

const lines = (s) => s.split('\n').map((x) => x.trim()).filter(Boolean);

async function saveForm() {
  const f = $('#dlgForm');
  const gv = (n, root = f) => root.elements[n];
  const body = {
    generator: { publicHost: gv('publicHost').value.trim(), blobPort: Number(gv('blobPort').value), nicMbps: Number(gv('nicMbps').value) },
    test: { filter: gv('filter').value.trim(), sessions: Number(gv('sessions').value), subPct: Number(gv('subPct').value), thinkMs: Number(gv('thinkMs').value) },
    targets: [],
  };
  $$('fieldset[data-id]', f).forEach((fs) => {
    const q = (n) => fs.querySelector(`[name=${n}]`);
    let steps;
    try { steps = JSON.parse(q('steps').value || '[]'); } catch { throw new Error('JSON سناریو در پنل ' + fs.dataset.id + ' معتبر نیست'); }
    const t = {
      id: fs.dataset.id, name: q('name').value, panelUrl: q('panelUrl').value.trim(), username: q('username').value,
      password: q('password').value, agentUrl: q('agentUrl').value.trim(), agentToken: q('agentToken').value, panelProc: q('panelProc').value.trim(),
      coreProc: q('coreProc').value.trim(), insecureTls: q('insecureTls').value === '1', steps,
      subscriptionUrls: q('subscriptionUrls').dataset.touched === '1' ? lines(q('subscriptionUrls').value) : null,
      links: q('links').dataset.touched === '1' ? lines(q('links').value) : null,
    };
    body.targets.push(t);
  });
  await api('/api/config', 'PUT', body);
}

function wireTarget(fs) {
  const id = fs.dataset.id;
  const out = $('.testout', fs);
  const show = (txt) => { out.style.display = 'block'; out.textContent = txt; };
  const steps = () => fs.querySelector('[name=steps]');
  fs.onclick = async (e) => {
    const act = e.target.dataset.act;
    if (!act) return;
    try {
      if (act === 'preset') { steps().value = JSON.stringify((await api('/api/preset/3xui')).steps, null, 2); return; }
      if (act === 'curl') { $('.curlbox', fs).hidden = !$('.curlbox', fs).hidden; return; }
      if (act === 'curlAdd') {
        const r = await api('/api/curl-import', 'POST', { id, curl: fs.querySelector('[name=curlText]').value, role: fs.querySelector('[name=curlRole]').value, panelUrl: fs.querySelector('[name=panelUrl]').value.trim() });
        const arr = JSON.parse(steps().value || '[]');
        arr.push(r.step);
        steps().value = JSON.stringify(arr, null, 2);
        fs.querySelector('[name=curlText]').value = '';
        show('✔ اضافه شد: ' + r.step.name);
        return;
      }
      show('در حال تست…');
      await saveForm();
      if (act === 'tpanel') {
        const r = await api('/api/test/panel', 'POST', { id });
        show(r.results.map((x) => `${x.ok ? '✔' : '✖'} ${x.name}  ${x.status || ''} ${x.ms != null ? x.ms + 'ms' : ''} ${x.error || ''} ${x.snippet ? '\n    ' + x.snippet : ''}`).join('\n') + '\n\n(اگر ✖ شد: مسیر یا متد یا نسخه پنل را در سناریو اصلاح کنید)');
      } else if (act === 'tlinks') {
        const r = await api('/api/test/links', 'POST', { id });
        show(`${r.count} لینک قابل استفاده\n` + Object.entries(r.protocols).map(([k, v]) => `  ${k}: ${v}`).join('\n') + (r.errors.length ? '\n⚠ ' + r.errors.join('\n⚠ ') : ''));
      } else if (act === 'tagent') {
        const r = await api('/api/test/agent', 'POST', { id });
        show(r.ok ? `✔ ایجنت جواب داد — CPU ${r.stats.cpu}%  RAM ${r.stats.memPct}%  هسته‌ها ${r.stats.cores}` : '✖ ایجنت جواب نداد (آدرس/توکن/فایروال را بررسی کنید)');
      } else if (act === 'tvpn') {
        const r = await api('/api/test/vpn', 'POST', { id });
        show(r.ok ? `✔ اتصال VPN برقرار شد (${r.protocols}) — حدود ${r.mbpsApprox} Mbps، زمان اتصال ${r.ttfbMs}ms` : `✖ اتصال برقرار نشد ${r.errors.join(', ')}`);
      }
    } catch (err) { show('✖ ' + err.message); }
  };
}
$('#settingsBtn').onclick = () => openSettings().catch((e) => alert(e.message));

