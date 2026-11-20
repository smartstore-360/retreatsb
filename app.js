const API_KEY = 'dclm_api';   // server URL comes from config.js
let API = (window.DCLM_API || '').trim() || localStorage.getItem(API_KEY) || '';
const CAMPS = ['Adult', 'Youth', 'Campus', 'Children'];
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => new Date().toLocaleDateString('en-CA');
const debounce = (f, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => f(...a), ms); }; };
let S = JSON.parse(localStorage.getItem('dclm_s') || 'null'), boot = { districts: {}, messages: [] }, hcPage = 1, hcPages = 1, syncing = false, role = 'register';

// ---------- IndexedDB: offline queue (q) + cached responses (kv) ----------
const db = new Promise((res, rej) => {
  const r = indexedDB.open('dclm', 1);
  r.onupgradeneeded = () => { r.result.createObjectStore('q', { keyPath: 'cid' }); r.result.createObjectStore('kv'); };
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
const tx = async (s, m, f) => { const d = await db; return new Promise((res, rej) => { const t = d.transaction(s, m), o = f(t.objectStore(s)); t.oncomplete = () => res(o && o.result); t.onerror = () => rej(t.error); }); };
const kv = { get: k => tx('kv', 'readonly', s => s.get(k)), set: (k, v) => tx('kv', 'readwrite', s => s.put(v, k)), clear: () => tx('kv', 'readwrite', s => s.clear()) };
const q = { all: () => tx('q', 'readonly', s => s.getAll()), put: r => tx('q', 'readwrite', s => s.put(r)), del: k => tx('q', 'readwrite', s => s.delete(k)) };


// ---------- charts (dependency-free SVG, works offline) ----------
const COL = ['#6366f1', '#10b981', '#f59e0b', '#ec4899', '#38bdf8'], NONE = '<p class="empty">No data yet</p>';
const legend = items => `<div class="legend">${items.map((n, i) => `<span><i class="sw" style="background:${COL[i % 5]}"></i>${esc(n)}</span>`).join('')}</div>`;
function donut(items) {
  const t = items.reduce((a, i) => a + i[1], 0); if (!t) return NONE;
  let a = -Math.PI / 2; const R = 80, r = 50, p = (g, d) => [100 + d * Math.cos(g), 100 + d * Math.sin(g)];
  const arcs = items.map(([l, v], i) => {
    if (!v) return ''; const f = v / t, b = a + f * 2 * Math.PI - (f === 1 ? .0001 : 0);
    const [x1, y1] = p(a, R), [x2, y2] = p(b, R), [x3, y3] = p(b, r), [x4, y4] = p(a, r), big = f > .5 ? 1 : 0; a += f * 2 * Math.PI;
    return `<path d="M${x1} ${y1}A${R} ${R} 0 ${big} 1 ${x2} ${y2}L${x3} ${y3}A${r} ${r} 0 ${big} 0 ${x4} ${y4}Z" fill="${COL[i % 5]}"><title>${esc(l)}: ${v}</title></path>`;
  }).join('');
  return `<div class="donut"><svg viewBox="0 0 200 200">${arcs}<text x="100" y="102" text-anchor="middle" fill="#fff" font-size="26" font-weight="700">${t}</text><text x="100" y="120" text-anchor="middle" fill="#94a3b8" font-size="11">Total</text></svg><ul>${items.map(([l, v], i) => `<li><i class="sw" style="background:${COL[i % 5]}"></i>${esc(l)}<b>${v}</b></li>`).join('')}</ul></div>`;
}
function bars(labels, series, stacked) {
  if (!labels.length) return NONE;
  const n = labels.length, W = Math.max(320, n * (stacked ? 44 : 26 * series.length + 14) + 40), Ht = 230, pl = 32, pb = 56, pt = 10, ph = Ht - pt - pb;
  const max = Math.max(1, ...labels.map((_, i) => stacked ? series.reduce((a, s) => a + s.data[i], 0) : Math.max(...series.map(s => s.data[i]))));
  const y = v => pt + ph - v / max * ph, bw = (W - pl) / n; let g = '';
  for (let k = 0; k <= 4; k++) { const v = Math.round(max * k / 4), yy = y(v); g += `<line x1="${pl}" x2="${W}" y1="${yy}" y2="${yy}" stroke="#334155"/><text x="${pl - 4}" y="${yy + 3}" text-anchor="end" fill="#94a3b8" font-size="9">${v}</text>`; }
  labels.forEach((l, i) => {
    const x0 = pl + i * bw + bw * .12, w = bw * .76; let acc = 0;
    series.forEach((s, j) => {
      const v = s.data[i], t = `<title>${esc(s.name)}: ${v}</title>`;
      if (stacked) { const y1 = y(acc + v); g += `<rect x="${x0}" y="${y1}" width="${w}" height="${y(acc) - y1}" fill="${COL[j % 5]}">${t}</rect>`; acc += v; }
      else { const ww = w / series.length; g += `<rect x="${x0 + j * ww}" y="${y(v)}" width="${ww - 2}" height="${pt + ph - y(v)}" fill="${COL[j % 5]}" rx="2">${t}</rect>`; }
    });
    const cx = x0 + w / 2; g += `<text x="${cx}" y="${pt + ph + 14}" text-anchor="end" fill="#cbd5e1" font-size="10" transform="rotate(-35 ${cx} ${pt + ph + 14})">${esc(String(l).length > 12 ? String(l).slice(0, 11) + '…' : l)}</text>`;
  });
  return `<div class="tw"><svg viewBox="0 0 ${W} ${Ht}" style="min-width:${W}px;width:100%">${g}</svg></div>${legend(series.map(s => s.name))}`;
}
const hbars = items => { if (!items.length) return NONE; const m = Math.max(1, ...items.map(i => i[1])); return `<div class="hb">${items.map(([l, v]) => `<div><span title="${esc(l)}">${esc(l)}</span><div class="bar"><i style="width:${v / m * 100}%"></i></div><b>${v}</b></div>`).join('')}</div>`; };

// ---------- retreat programs (date ranges) + organisation name: from the server, cached for offline ----------
let cfg = { org: 'DCLM', programs: [] }, pid = localStorage.getItem('dclm_pid') || '';
const cur = () => cfg.programs.find(p => p.id === pid);
const fmtD = d => new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const fmtRange = p => p ? `${fmtD(p.start)} – ${fmtD(p.end)}` : '';
const chk = d => { const p = cur(); if (!p) return 'No retreat program selected. An admin must create one in the Programs tab.'; if (d < p.start || d > p.end) return `Date must be within ${fmtRange(p)}`; };
function pickDefault() {
  if (cur()) return;
  const t = today(), ps = cfg.programs, now = ps.find(x => x.start <= t && t <= x.end), up = ps.filter(x => x.start > t).sort((a, b) => a.start < b.start ? -1 : 1)[0];
  pid = (now || up || ps[0] || {}).id || '';
}
function setDateLimits() {
  const p = cur(); ['date', 'hDate', 'fDate', 'bDate'].forEach(id => { $(id).min = p?.start || ''; $(id).max = p?.end || ''; });
  ['date', 'hDate', 'bDate'].forEach(id => { const el = $(id), t = today(); if (p && (!el.value || el.value < p.start || el.value > p.end)) el.value = t < p.start ? p.start : t > p.end ? p.end : t; });
}
function applyCfg(c) {
  if (c && c.programs) cfg = c; pickDefault();
  const p = cur(), v = { org: cfg.org, event: p?.name || '', theme: p?.theme || '', dates: fmtRange(p) };
  document.querySelectorAll('[data-c]').forEach(e => { const t = v[e.dataset.c] || ''; e.textContent = t; e.hidden = !t && e.dataset.c !== 'org'; });
  document.querySelectorAll('[data-logo]').forEach(e => { e.textContent = ''; const im = new Image(); im.alt = ''; im.src = cfg.logo || 'logo.png'; im.onerror = () => { e.textContent = e.dataset.logo; }; e.appendChild(im); });
  document.title = (cfg.org || 'DCLM') + ' Registration System';
  const t = today(), grp = { Current: [], Upcoming: [], Past: [] };
  cfg.programs.forEach(x => (x.end < t ? grp.Past : x.start > t ? grp.Upcoming : grp.Current).push(x));
  $('progSel').innerHTML = cfg.programs.length ? Object.entries(grp).filter(([, a]) => a.length).map(([g, a]) => `<optgroup label="${g === 'Past' ? 'Past programs' : g}">${a.map(x => `<option value="${esc(x.id)}">${esc(x.name)} · ${esc(fmtRange(x))}</option>`).join('')}</optgroup>`).join('') : '<option value="">No program</option>';
  const past = p && p.end < t; $('pbanner').hidden = !past; $('pbanner').textContent = past ? `📁 Viewing a past program (ended ${fmtD(p.end)}). Use the selector at the top to switch.` : '';
  $('progSel').value = pid; setDateLimits();
}
async function fetchCfg() { try { const j = await api('config'); if (j.success) { localStorage.setItem('dclm_cfg2', JSON.stringify(j.config)); applyCfg(j.config); } } catch (e) { } }
function renderProgs() {
  $('progList').innerHTML = cfg.programs.length ? cfg.programs.map(p => `<div class="item"><b>${esc(p.name)}</b>${p.id === pid ? ' <span class="tag">Selected</span>' : ''}<br><small>${esc(fmtRange(p))}</small><small>${esc(p.theme)}</small><br><button class="btn" data-edit="${esc(p.id)}">Edit</button></div>`).join('') : '<div class="alert warning">No retreat program yet. Add one below to start registering.</div>';
}
const clearProgForm = () => { $('progForm').reset(); $('pId').value = ''; $('pStart').value = today(); $('pEnd').min = today(); };   // a new program starts today by default
function fillCfgForm() { $('cOrg').value = cfg.org || ''; renderProgs(); if (!$('pId').value && !$('pName').value) clearProgForm(); }
async function saveCfg(action, payload) {
  try {
    const j = await api(action, payload); flash('setMsg', j.message, j.success ? 'success' : 'error');
    if (j.success) { localStorage.setItem('dclm_cfg2', JSON.stringify(j.config)); applyCfg(j.config); fillCfgForm(); if (action === 'saveProgram') clearProgForm(); loadBoot(); }
  } catch (err) { flash('setMsg', 'Saving needs an internet connection.', 'error'); }
}
$('progList').onclick = e => { const id = e.target.dataset.edit; if (!id) return; const p = cfg.programs.find(x => x.id === id); $('pId').value = id; $('pName').value = p.name; $('pTheme').value = p.theme; $('pStart').value = p.start; $('pEnd').value = p.end; $('pName').focus(); };
$('progForm').onsubmit = e => { e.preventDefault(); saveCfg('saveProgram', { id: $('pId').value, name: $('pName').value.trim(), theme: $('pTheme').value.trim(), start: $('pStart').value, end: $('pEnd').value }); };
$('orgForm').onsubmit = e => { e.preventDefault(); saveCfg('saveOrg', { org: $('cOrg').value.trim() }); };
$('pClear').onclick = clearProgForm;
$('pStart').onchange = () => { $('pEnd').min = $('pStart').value; };
async function logoFromFile(f) {     // shrink to a small image that fits in one sheet cell
  if (!f.type.startsWith('image/')) throw new Error('Please choose an image file.');
  const bmp = await createImageBitmap(f);
  for (const [size, type, qual] of [[256, 'image/png'], [192, 'image/png'], [256, 'image/jpeg', .85], [192, 'image/jpeg', .8], [128, 'image/jpeg', .75]]) {
    const k = Math.min(1, size / Math.max(bmp.width, bmp.height)), c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
    const x = c.getContext('2d'); if (type === 'image/jpeg') { x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); }
    x.drawImage(bmp, 0, 0, c.width, c.height); const u = c.toDataURL(type, qual); if (u.length <= 46000) return u;
  }
  throw new Error('Image is too detailed. Please use a simpler logo.');
}
$('logoFile').onchange = async e => { const f = e.target.files[0]; e.target.value = ''; if (!f) return; try { await saveCfg('saveLogo', { logo: await logoFromFile(f) }); } catch (err) { flash('setMsg', err.message, 'error'); } };
$('logoDel').onclick = () => saveCfg('saveLogo', { logo: '' });
$('pwForm').onsubmit = async e => {
  e.preventDefault(); $('content').scrollTo(0, 0); const np = $('pwNew').value;
  if (np !== $('pwNew2').value) return flash('setMsg', 'New passwords do not match', 'error');
  try {
    const j = await api('changePassword', { role: $('pwRole').value, current: $('pwCur').value, password: np });
    flash('setMsg', j.message, j.success ? 'success' : 'error');
    if (j.success) { $('pwForm').reset(); if (j.token) { S.token = j.token; localStorage.setItem('dclm_s', JSON.stringify(S)); } }
  } catch (err) { flash('setMsg', 'Changing a password needs an internet connection.', 'error'); }
};
$('progSel').onchange = () => { pid = $('progSel').value; localStorage.setItem('dclm_pid', pid); hcPage = 1; applyCfg(); loadBoot(); showTab(document.querySelector('.tab.on').dataset.tab); };
applyCfg(JSON.parse(localStorage.getItem('dclm_cfg2') || 'null')); fetchCfg();

// ---------- API ----------
async function api(action, data = {}) {
  if (!API) throw new Error('API URL not set');
  const c = new AbortController(), t = setTimeout(() => c.abort(), 30000);
  try {
    const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ action, token: S?.token, pid, ...data }), signal: c.signal });
    const j = await r.json();
    if (j.code === 401) { logout(); throw new Error('Session expired. Please log in again.'); }
    return j;
  } finally { clearTimeout(t); }
}
async function load(key, action, data) {   // network first, fall back to last cached copy (per program)
  key = pid + ':' + key;
  try {
    const j = await api(action, data);
    if (!j.success) throw Object.assign(new Error(j.message || 'Request failed'), { server: true });
    await kv.set(key, j); return j;
  } catch (e) { if (e.server) throw e; const c = await kv.get(key); if (c) return { ...c, stale: true }; throw e; }
}
const flash = (id, msg, type = 'success') => { const el = $(id); el.innerHTML = `<div class="alert ${type}">${esc(msg)}</div>`; setTimeout(() => el.innerHTML = '', 5000); };

// ---------- sync (idempotent: server dedupes by cid) ----------
async function badge() {
  const n = (await q.all()).length, on = navigator.onLine;
  $('sync').textContent = (on ? '● Online' : '○ Offline') + (n ? ` · ${n} pending` : '');
  $('sync').className = on && !n ? '' : 'off';
}
async function sync() {
  if (syncing || !navigator.onLine || !S) return;
  syncing = true;
  try {
    for (const [type, action] of [['reg', 'syncRegistrations'], ['hc', 'syncHeadcounts'], ['bp', 'syncBaptisms']])
      for (;;) {
        const b = (await q.all()).filter(i => i.type === type).slice(0, 200);
        if (!b.length) break;
        const j = await api(action, { records: b.map(i => i.data) });
        if (!j.success || !j.acked.length) break;
        if (j.rejected?.length) flash('dashMsg', `${j.rejected.length} record(s) rejected: date outside the program's range`, 'error');
        for (const id of j.acked) await q.del(id);
        if (type === 'reg') dash();
      }
  } catch (e) { /* retry later */ } finally { syncing = false; badge(); }
}

// ---------- auth / shell ----------
async function doLogin() {
  const pw = $('pw').value.trim(); if (!pw) return flash('authMsg', 'Please enter password', 'error');
  if (!API) {     // only shown when config.js is empty (e.g. it was overwritten by an upload)
    const u = $('srvUrl').value.trim();
    if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(u)) { $('srvBox').hidden = false; return flash('authMsg', 'Server URL is not set. Paste your Apps Script /exec URL above, then sign in.', 'error'); }
    API = u; localStorage.setItem(API_KEY, u);
  }
  $('loginBtn').disabled = true; $('loginBtn').firstChild.textContent = 'Signing in…';
  try {
    const j = await api('login', { role, password: pw });
    if (!j.success) return flash('authMsg', j.message, 'error');
    S = { token: j.token, role: j.role, ts: Date.now() }; localStorage.setItem('dclm_s', JSON.stringify(S)); enter();
  } catch (e) {
    console.error('Login failed:', e);
    flash('authMsg', !API ? 'Server URL not set. The administrator must set it in config.js.'
      : e.name === 'SyntaxError' ? 'The server did not return valid data. In Apps Script, deploy as Web App with access set to "Anyone", and use the /exec URL.'
      : e.name === 'AbortError' ? 'The server took too long to respond. Try again.'
      : !navigator.onLine ? 'You are offline. The first login needs a connection.'
      : `Could not reach the server. Check the API URL and that the web app is deployed for "Anyone". (${e.message || e})`, 'error');
  }
  finally { $('loginBtn').disabled = false; $('loginBtn').firstChild.textContent = 'Sign in'; }
}
async function logout() {
  S = null; localStorage.removeItem('dclm_s'); $('pw').value = ''; $('app').hidden = true; $('auth').hidden = false;
  if (!(await q.all()).length) await kv.clear();      // keep cache only if unsynced data remains
}
function enter() {
  $('auth').hidden = true; $('app').hidden = false;
  const admin = S.role === 'admin';
  $('roleLbl').textContent = admin ? 'Administrator' : 'Registration Officer';
  document.querySelectorAll('.adm').forEach(e => e.style.display = admin ? '' : 'none');
  setDateLimits(); fetchCfg();
  showTab('dashboard'); loadBoot(); badge(); sync();
}
function showTab(t) {
  if (S?.role !== 'admin' && ['districts', 'analytics', 'headcount', 'settings'].includes(t)) return;
  document.querySelectorAll('.tab').forEach(e => e.classList.toggle('on', e.dataset.tab === t));
  document.querySelectorAll('.pane').forEach(e => e.classList.toggle('on', e.id === t));
  $('content').scrollTo(0, 0);
  ({ dashboard: dash, analytics: () => { analytics(); insLoad(); }, headcount: () => { hcLoad(); bpLoad(); }, districts: renderDistricts, settings: fillCfgForm })[t]?.();
}

// ---------- rendering ----------
const tbl = (h, r, foot) => `<table><thead><tr>${h.map(x => `<th>${esc(x)}</th>`).join('')}</tr></thead><tbody>${r.map(x => `<tr>${x.map(v => `<td>${esc(v)}</td>`).join('')}</tr>`).join('')}${foot ? `<tr class="tot">${foot.map(v => `<td>${esc(v)}</td>`).join('')}</tr>` : ''}</tbody></table>`;
const stale = j => j.stale ? '<div class="alert warning">Offline: showing last saved data</div>' : '';

async function dash() {
  try {
    const j = await load('stats', 'stats'), pend = (await q.all()).filter(i => i.type === 'reg' && i.data.pid === pid).length;
    $('tTotal').textContent = j.total + pend; $('tToday').textContent = j.today; $('tNew').textContent = j.newComers; $('tMem').textContent = j.members;
    $('dashMsg').innerHTML = stale(j);
    $('chCamp').innerHTML = donut(CAMPS.map(c => [c, j.camps[c] || 0])); $('chGender').innerHTML = donut([['Male', j.gender.Male], ['Female', j.gender.Female]]);
    $('recent').innerHTML = j.recent.length ? j.recent.map(r => `<div class="item"><b>${esc(r.name)}</b><br><small>${esc(r.district)}</small><small>${esc(r.status)}</small><small>${esc(r.time)}</small></div>`).join('') : '<div class="alert">No recent registrations</div>';
  } catch (e) { flash('dashMsg', e.server ? e.message : 'No data yet. Connect once to load.', 'warning'); }
}
async function loadBoot() {
  try { boot = await load('boot', 'bootstrap'); } catch (e) { return; }
  const d = $('district'), cur = d.value;
  d.innerHTML = '<option value="">Select District</option>' + Object.keys(boot.districts).sort().map(x => `<option>${esc(x)}</option>`).join('');
  d.value = cur; fillLocations();
  const opts = boot.messages.map(m => `<option value="${esc(m.message)}">${esc(m.speaker ? `${m.message} (${m.speaker})` : m.message)}</option>`).join('');
  $('hMsg').innerHTML = '<option value="">Select Message</option>' + opts; $('fMsg').innerHTML = '<option value="">All Messages</option>' + opts;
  renderDistricts();
}
function fillLocations() {
  const l = $('location'), a = boot.districts[$('district').value];
  l.innerHTML = a ? '<option value="">Select Location</option>' + a.map(x => `<option>${esc(x)}</option>`).join('') : '<option value="">Select District First</option>';
  l.disabled = !a;
}
function renderDistricts() {
  const k = Object.keys(boot.districts).sort();
  $('distList').innerHTML = k.length ? k.map(d => `<div class="item"><b>${esc(d)}</b> <small>${boot.districts[d].length} location(s)</small><div>${boot.districts[d].map(l => `<span class="tag">${esc(l)}</span>`).join('')}</div></div>`).join('') : '<div class="alert">No districts yet.</div>';
}
const campCells = c => { let m = 0, f = 0; const out = CAMPS.flatMap(k => { const [a, b] = c[k] || [0, 0]; m += a; f += b; return [a, b, a + b]; }); return [...out, m + f]; };
async function analytics() {
  try {
    const j = await load('analytics', 'analytics');
    let M = 0, F = 0;
    $('anCamp').innerHTML = stale(j) + tbl(['Camp', 'Male', 'Female', 'Total'], CAMPS.map(c => { const [m, f] = j.camps[c] || [0, 0]; M += m; F += f; return [c, m, f, m + f]; }), ['Grand Total', M, F, M + F]);
    const hd = CAMPS.flatMap(c => [c + ' M', c + ' F', c + ' T']).concat('Total');
    const foot = rows => rows.length ? ['Grand Total', ...rows[0].slice(1).map((_, i) => rows.reduce((a, r) => a + r[i + 1], 0))] : null;
    const dr = j.daily.map(d => [d.k, ...campCells(d.c)]), ds = j.districts.map(d => [d.k, ...campCells(d.c)]).sort((a, b) => b.at(-1) - a.at(-1));
    $('anDaily').innerHTML = tbl(['Date', ...hd], dr, foot(dr));
    $('anDist').innerHTML = tbl(['District', ...hd], ds, foot(ds));
    const sum = a => (a || [0, 0])[0] + (a || [0, 0])[1];
    $('chDaily').innerHTML = bars(j.daily.map(d => d.k), CAMPS.map(k => ({ name: k, data: j.daily.map(d => sum(d.c[k])) })), true);
    $('chCampGender').innerHTML = bars(CAMPS, [{ name: 'Male', data: CAMPS.map(c => (j.camps[c] || [0, 0])[0]) }, { name: 'Female', data: CAMPS.map(c => (j.camps[c] || [0, 0])[1]) }], false);
    $('chDist').innerHTML = hbars(ds.slice(0, 10).map(r => [r[0], r.at(-1)]));
    const AGES = ['3–5', '6–9', '10–12', '13–19', '20–29', '30–39', '40–49', '50–59', '60+'], ag = j.ages || {}, labs = [...AGES, ...Object.keys(ag).filter(k => !AGES.includes(k))];
    $('chAge').innerHTML = labs.some(a => ag[a]) ? bars(labs, [{ name: 'Male', data: labs.map(a => (ag[a] || [0, 0])[0]) }, { name: 'Female', data: labs.map(a => (ag[a] || [0, 0])[1]) }], false) : NONE;
  } catch (e) { flash('anMsg', e.server ? e.message : 'Analytics unavailable offline until loaded once.', 'warning'); }
}
const hcFilters = () => ({ date: $('fDate').value, camp: $('fCamp').value, message: $('fMsg').value, q: $('fQ').value.trim(), page: hcPage, size: 10 });
async function hcLoad() {
  try {
    const f = hcFilters(), j = await load('hc:' + JSON.stringify(f), 'headcounts', f);
    hcPages = Math.max(1, Math.ceil(j.total / j.size)); $('pg').textContent = `Page ${j.page} of ${hcPages} (${j.total})`;
    $('prev').disabled = j.page <= 1; $('next').disabled = j.page >= hcPages;
    $('hcTable').innerHTML = stale(j) + tbl(['Date', 'Camp', 'Message', 'Male', 'Female', 'Total', 'Altar M', 'Altar F', 'Notes'], j.rows.map(r => [r[0], r[1], r[2], r[3], r[4], r[3] + r[4], r[5], r[6], r[7]]));
    const s = j.stats;
    $('hcStats').innerHTML = [['Total Attendance', s.total], ['Total Altar Calls', s.ac], ['Altar Male', s.acM], ['Altar Female', s.acF]].map(([l, v]) => `<div><b>${v}</b>${l}</div>`).join('');
    const rows = o => Object.entries(o).map(([k, v]) => [k, v[0], v[1], v[0] + v[1], v[2], v[3], v[2] + v[3], v[4]]);
    const hd = ['Name', 'Male', 'Female', 'Total', 'Altar M', 'Altar F', 'Altar T', 'Records'];
    $('hcCamps').innerHTML = tbl(hd, rows(j.camps)); $('hcMsgs').innerHTML = tbl(hd, rows(j.msgs));
  } catch (e) { flash('hcMsg', e.server ? e.message : 'Headcount history unavailable offline until loaded once.', 'warning'); }
}

// ---------- forms ----------
async function submitReg(e) {
  e.preventDefault();
  const v = id => $(id).value.trim(), st = v('status');
  const bad = chk(v('date')); if (bad) return flash('regMsg', bad, 'error');
  if (st === 'New Comer' && !v('invitedBy')) return flash('regMsg', 'Please specify who invited the new comer', 'error');
  const data = { cid: crypto.randomUUID(), pid, ts: Date.now(), date: v('date'), fullName: v('fullName'), gender: v('gender'), ageGroup: v('ageGroup'), camp: v('camp'), district: v('district'), location: v('location'), status: st, invitedBy: st === 'New Comer' ? v('invitedBy') : '', phone: v('phone') };
  $('fullName').focus();   // focus synchronously, inside the tap/submit gesture: mobile browsers ignore focus() after an await
  await q.put({ cid: data.cid, type: 'reg', data });          // always saved locally first
  $('regForm').reset(); setDateLimits(); fillLocations(); $('invBox').hidden = true;
  $('fullName').focus();
  flash('regMsg', navigator.onLine ? 'Registration saved' : 'Saved offline. Will sync when online.');
  badge(); sync();
}
async function submitHc(e) {
  e.preventDefault();
  const bad = chk($('hDate').value); if (bad) return flash('hcMsg', bad, 'error');
  const n = id => parseInt($(id).value) || 0, data = { cid: crypto.randomUUID(), pid, ts: Date.now(), date: $('hDate').value, camp: $('hCamp').value, message: $('hMsg').value, maleCount: n('hM'), femaleCount: n('hF'), altarCallMale: n('aM'), altarCallFemale: n('aF'), notes: $('hNotes').value.trim() };
  await q.put({ cid: data.cid, type: 'hc', data });
  $('hcForm').reset(); setDateLimits(); calc();
  flash('hcMsg', navigator.onLine ? 'Headcount saved' : 'Saved offline. Will sync when online.'); badge(); await sync(); hcLoad();
}
async function adminPost(action, data, form, msg) {
  try {
    const j = await api(action, data);
    flash(msg, j.message, j.success ? 'success' : 'error');
    if (j.success) { $(form).reset(); await loadBoot(); }
  } catch (e) { flash(msg, 'This action needs an internet connection.', 'error'); }
}
const calc = () => { $('hT').value = (+$('hM').value || 0) + (+$('hF').value || 0); $('aT').value = (+$('aM').value || 0) + (+$('aF').value || 0); };

// ---------- wiring ----------
document.querySelectorAll('input[name=role]').forEach(r => r.onchange = () => { role = r.value; $('pw').focus(); });
document.querySelectorAll('.tab').forEach(t => t.onclick = () => showTab(t.dataset.tab));
$('loginForm').onsubmit = e => { e.preventDefault(); doLogin(); };
$('eye').onclick = () => { const p = $('pw'); p.type = p.type === 'password' ? 'text' : 'password'; $('eye').style.opacity = p.type === 'text' ? 1 : .6; };
$('logout').onclick = logout;
$('status').onchange = () => $('invBox').hidden = $('status').value !== 'New Comer';
$('district').onchange = fillLocations;
$('regForm').onsubmit = submitReg; $('hcForm').onsubmit = submitHc;
// ---------- insights: funnel, altar-call rate per message, comparison with the previous program ----------
const METRICS = [['registered', 'Registrations'], ['newComers', 'New comers'], ['attendance', 'Attendance (sum of headcounts)'], ['altar', 'Altar calls'], ['baptized', 'Baptized']];
function funnel(st) {
  const top = Math.max(1, ...st.map(s => s[1]));
  return `<div>${st.map(([l, v], i) => `<div class="fs"><div class="fb" style="width:${Math.min(100, Math.max(8, v / top * 100))}%;background:${COL[i % 5]}"><b>${v}</b></div><span>${esc(l)}${i ? ` · ${st[i - 1][1] ? Math.round(v / st[i - 1][1] * 100) : 0}% of ${esc(st[i - 1][0])}` : ''}</span></div>`).join('')}</div>`;
}
async function insLoad() {
  try {
    const j = await load('ins', 'insights'), c = j.cur, rate = m => m.attendance ? m.altar / m.attendance * 100 : -1;
    $('insFunnel').innerHTML = stale(j) + funnel([['Registered', c.registered], ['Altar calls', c.altar], ['Baptized', c.baptized]]);
    $('insMsgs').innerHTML = j.messages.length ? tbl(['Message', 'Attendance', 'Altar calls', 'Rate'], j.messages.slice().sort((a, b) => rate(b) - rate(a)).map(m => [m.name, m.attendance, m.altar, m.attendance ? rate(m).toFixed(1) + '%' : '–'])) : NONE;
    $('insCmp').innerHTML = !j.prev ? '<div class="alert">No earlier program to compare with yet.</div>'
      : '<div class="tw">' + tbl(['Metric', j.prevName, cur()?.name || 'This program', 'Change'], METRICS.map(([k, l]) => { const a = j.prev[k], b = c[k]; return [l, a, b, a ? `${b >= a ? '▲' : '▼'} ${Math.abs(Math.round((b - a) / a * 100))}%` : b ? 'new' : '–']; })) + '</div>';
  } catch (e) { flash('anMsg', e.server ? e.message : 'Insights unavailable offline until loaded once.', 'warning'); }
}

// ---------- export to CSV (opens in Excel) ----------
const csv = rows => rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
async function exportCsv(kind) {
  const p = cur(); if (!p) return flash('exMsg', 'Select a program first', 'error');
  try {
    let off = 0, header = [], rows = [];
    for (;;) { const j = await api('exportData', { kind, offset: off }); if (!j.success) throw new Error(j.message); header = j.header; rows.push(...j.rows); if (j.next == null) break; off = j.next; }
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['\ufeff' + csv([header, ...rows])], { type: 'text/csv;charset=utf-8' }));
    a.download = `${p.name.replace(/[^\w-]+/g, '_')}-${kind}.csv`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    flash('exMsg', `${rows.length} row(s) exported`);
  } catch (e) { flash('exMsg', navigator.onLine ? 'Export failed: ' + e.message : 'Exporting needs an internet connection.', 'error'); }
}
document.querySelectorAll('[data-exp]').forEach(b => b.onclick = async () => { b.disabled = true; await exportCsv(b.dataset.exp); b.disabled = false; });
const calcB = () => { $('bT').value = (+$('bM').value || 0) + (+$('bF').value || 0); };
['bM', 'bF'].forEach(id => $(id).oninput = calcB);
async function bpLoad() {
  try {
    const j = await load('bp', 'baptisms'), t = j.totals;
    $('bpStats').innerHTML = [['Male Baptized', t.male], ['Female Baptized', t.female], ['Total Baptized', t.total]].map(([l, v]) => `<div><b>${v}</b>${l}</div>`).join('');
    $('bpTable').innerHTML = stale(j) + tbl(['Date', 'Male', 'Female', 'Total', 'Notes'], j.rows.map(r => [r[0], r[1], r[2], r[1] + r[2], r[3]]), j.rows.length ? ['Grand Total', t.male, t.female, t.total, ''] : null);
  } catch (e) { flash('bpMsg', e.server ? e.message : 'Baptism records unavailable offline until loaded once.', 'warning'); }
}
$('bpForm').onsubmit = async e => {
  e.preventDefault();
  const bad = chk($('bDate').value); if (bad) return flash('bpMsg', bad, 'error');
  const n = id => parseInt($(id).value) || 0, m = n('bM'), f = n('bF');
  if (m + f < 1) return flash('bpMsg', 'Enter at least one person baptized.', 'error');
  const data = { cid: crypto.randomUUID(), pid, ts: Date.now(), date: $('bDate').value, male: m, female: f, notes: $('bNotes').value.trim() };
  await q.put({ cid: data.cid, type: 'bp', data });
  $('bpForm').reset(); setDateLimits(); calcB();
  flash('bpMsg', navigator.onLine ? 'Baptism recorded' : 'Saved offline. Will sync when online.'); badge(); await sync(); bpLoad();
};
$('locForm').onsubmit = e => { e.preventDefault(); adminPost('addLocation', { district: $('newDistrict').value, location: $('newLocation').value }, 'locForm', 'distMsg'); };
$('msgForm').onsubmit = e => { e.preventDefault(); adminPost('addMessage', { message: $('newMessage').value, speaker: $('speaker').value }, 'msgForm', 'hcMsg'); };
['hM', 'hF', 'aM', 'aF'].forEach(id => $(id).oninput = calc);
const refilter = () => { hcPage = 1; hcLoad(); };
['fDate', 'fCamp', 'fMsg'].forEach(id => $(id).onchange = refilter); $('fQ').oninput = debounce(refilter, 350);
$('fClear').onclick = () => { ['fDate', 'fCamp', 'fMsg', 'fQ'].forEach(id => $(id).value = ''); refilter(); };
$('prev').onclick = () => { hcPage--; hcLoad(); }; $('next').onclick = () => { hcPage++; hcLoad(); };
addEventListener('online', () => { badge(); sync(); loadBoot(); }); addEventListener('offline', badge);
setInterval(() => { sync(); if (S && $('dashboard').classList.contains('on') && !document.hidden) dash(); }, 30000);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
if (S && Date.now() - S.ts < 8 * 3600e3) enter(); else if (S) logout();
