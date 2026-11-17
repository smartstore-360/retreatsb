const API = 'PASTE_YOUR_WEB_APP_URL_HERE';   // Apps Script deployment URL (ends in /exec)
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

// ---------- API ----------
async function api(action, data = {}) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), 30000);
  try {
    const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ action, token: S?.token, ...data }), signal: c.signal });
    const j = await r.json();
    if (j.code === 401) { logout(); throw new Error('Session expired. Please log in again.'); }
    return j;
  } finally { clearTimeout(t); }
}
async function load(key, action, data) {   // network first, fall back to last cached copy
  try { const j = await api(action, data); if (j.success) await kv.set(key, j); return j; }
  catch (e) { const c = await kv.get(key); if (c) return { ...c, stale: true }; throw e; }
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
    for (const [type, action] of [['reg', 'syncRegistrations'], ['hc', 'syncHeadcounts']])
      for (;;) {
        const b = (await q.all()).filter(i => i.type === type).slice(0, 200);
        if (!b.length) break;
        const j = await api(action, { records: b.map(i => i.data) });
        if (!j.success || !j.acked.length) break;
        for (const id of j.acked) await q.del(id);
        if (type === 'reg') dash();
      }
  } catch (e) { /* retry later */ } finally { syncing = false; badge(); }
}

// ---------- auth / shell ----------
async function doLogin() {
  const pw = $('pw').value.trim(); if (!pw) return flash('authMsg', 'Please enter password', 'error');
  $('loginBtn').disabled = true; $('loginBtn').firstChild.textContent = 'Signing in…';
  try {
    const j = await api('login', { role, password: pw });
    if (!j.success) return flash('authMsg', j.message, 'error');
    S = { token: j.token, role: j.role, ts: Date.now() }; localStorage.setItem('dclm_s', JSON.stringify(S)); enter();
  } catch (e) { flash('authMsg', 'Network error. First login needs a connection.', 'error'); }
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
  $('date').value = $('hDate').value = today();
  showTab('dashboard'); loadBoot(); badge(); sync();
}
function showTab(t) {
  if (S?.role !== 'admin' && ['districts', 'analytics', 'headcount'].includes(t)) return;
  document.querySelectorAll('.tab').forEach(e => e.classList.toggle('on', e.dataset.tab === t));
  document.querySelectorAll('.pane').forEach(e => e.classList.toggle('on', e.id === t));
  $('side').classList.remove('open');
  ({ dashboard: dash, analytics: analytics, headcount: hcLoad, districts: renderDistricts })[t]?.();
}

// ---------- rendering ----------
const tbl = (h, r, foot) => `<table><thead><tr>${h.map(x => `<th>${esc(x)}</th>`).join('')}</tr></thead><tbody>${r.map(x => `<tr>${x.map(v => `<td>${esc(v)}</td>`).join('')}</tr>`).join('')}${foot ? `<tr class="tot">${foot.map(v => `<td>${esc(v)}</td>`).join('')}</tr>` : ''}</tbody></table>`;
const stale = j => j.stale ? '<div class="alert warning">Offline: showing last saved data</div>' : '';

async function dash() {
  try {
    const j = await load('stats', 'stats'), pend = (await q.all()).filter(i => i.type === 'reg').length;
    $('tTotal').textContent = j.total + pend; $('tToday').textContent = j.today; $('tNew').textContent = j.newComers; $('tMem').textContent = j.members;
    $('dashMsg').innerHTML = stale(j);
    $('recent').innerHTML = j.recent.length ? j.recent.map(r => `<div class="item"><b>${esc(r.name)}</b><br><small>${esc(r.district)}</small><small>${esc(r.status)}</small><small>${esc(r.time)}</small></div>`).join('') : '<div class="alert">No recent registrations</div>';
  } catch (e) { flash('dashMsg', 'No data yet. Connect once to load.', 'warning'); }
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
    $('anDaily').innerHTML = tbl(['Date', ...hd], j.daily.map(d => [d.k, ...campCells(d.c)]));
    $('anDist').innerHTML = tbl(['District', ...hd], j.districts.map(d => [d.k, ...campCells(d.c)]).sort((a, b) => b.at(-1) - a.at(-1)));
  } catch (e) { flash('hcMsg', 'Analytics unavailable offline until loaded once.', 'warning'); }
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
  } catch (e) { flash('hcMsg', 'Headcount history unavailable offline until loaded once.', 'warning'); }
}

// ---------- forms ----------
async function submitReg(e) {
  e.preventDefault();
  const v = id => $(id).value.trim(), st = v('status');
  if (st === 'New Comer' && !v('invitedBy')) return flash('regMsg', 'Please specify who invited the new comer', 'error');
  const data = { cid: crypto.randomUUID(), ts: Date.now(), date: v('date'), fullName: v('fullName'), gender: v('gender'), ageGroup: v('ageGroup'), camp: v('camp'), district: v('district'), location: v('location'), status: st, invitedBy: st === 'New Comer' ? v('invitedBy') : '', phone: v('phone') };
  await q.put({ cid: data.cid, type: 'reg', data });          // always saved locally first
  $('regForm').reset(); $('date').value = today(); fillLocations(); $('invBox').hidden = true;
  flash('regMsg', navigator.onLine ? 'Registration saved' : 'Saved offline. Will sync when online.');
  badge(); sync();
}
async function submitHc(e) {
  e.preventDefault();
  const n = id => parseInt($(id).value) || 0, data = { cid: crypto.randomUUID(), ts: Date.now(), date: $('hDate').value, camp: $('hCamp').value, message: $('hMsg').value, maleCount: n('hM'), femaleCount: n('hF'), altarCallMale: n('aM'), altarCallFemale: n('aF'), notes: $('hNotes').value.trim() };
  await q.put({ cid: data.cid, type: 'hc', data });
  $('hcForm').reset(); $('hDate').value = today(); calc();
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
document.querySelectorAll('.rb').forEach(b => b.onclick = () => { document.querySelectorAll('.rb').forEach(x => x.classList.remove('on')); b.classList.add('on'); role = b.dataset.role; $('pw').focus(); });
document.querySelectorAll('.tab').forEach(t => t.onclick = () => showTab(t.dataset.tab));
$('loginForm').onsubmit = e => { e.preventDefault(); doLogin(); };
$('eye').onclick = () => { const p = $('pw'); p.type = p.type === 'password' ? 'text' : 'password'; $('eye').style.opacity = p.type === 'text' ? 1 : .6; };
$('logout').onclick = logout; $('menu').onclick = () => $('side').classList.toggle('open');
$('status').onchange = () => $('invBox').hidden = $('status').value !== 'New Comer';
$('district').onchange = fillLocations;
$('regForm').onsubmit = submitReg; $('hcForm').onsubmit = submitHc;
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
