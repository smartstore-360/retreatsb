// DCLM API (Google Apps Script). Deploy as Web App: Execute as ME, access ANYONE.
// Run setup() once, then change the passwords in Project Settings > Script properties.
const SS_ID = '1DV5YlX8CKKHVtcJ5sxfqWZuf_BpwALwRnj11u7qmrk8';
const TZ = 'Africa/Accra';
const CAMPS = ['Adult', 'Youth', 'Campus', 'Children'];
const H = {
  Main: ['Timestamp','Date','Full Name','Gender','Age Group','Camp','District','Location','Status','Invited By','Phone','ClientId'],
  Districts: ['District'], Locations: ['District','Location'], Messages: ['Message','Speaker'],
  Headcount: ['Timestamp','Date','Camp','Message','Male Count','Female Count','Altar Call Male','Altar Call Female','Notes','ClientId']
};
const ROUTES = {
  bootstrap: ['r', bootstrap], stats: ['r', stats], syncRegistrations: ['r', syncReg],
  addLocation: ['a', addLocation], addMessage: ['a', addMessage], analytics: ['a', analytics],
  headcounts: ['a', headcounts], syncHeadcounts: ['a', syncHC]
};

function setup() {
  PropertiesService.getScriptProperties().setProperties({ PASS_register: 'CHANGE_ME_1', PASS_admin: 'CHANGE_ME_2' });
  Object.keys(H).forEach(sheet);
}
function doGet() { return ContentService.createTextOutput('DCLM API OK'); }
function doPost(e) {
  let out;
  try {
    const d = JSON.parse(e.postData.contents), r = ROUTES[d.action];
    if (d.action === 'login') out = login(d);
    else {
      const role = CacheService.getScriptCache().get('t_' + d.token);
      if (!role) out = { success: false, code: 401 };
      else if (!r) out = { success: false, message: 'Unknown action' };
      else if (r[0] === 'a' && role !== 'admin') out = { success: false, code: 403, message: 'Admin only' };
      else out = r[1](d);
    }
  } catch (err) { out = { success: false, message: String(err) }; }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

// ---------- helpers ----------
let _ss;
function sheet(n) {
  _ss = _ss || SpreadsheetApp.openById(SS_ID);
  let s = _ss.getSheetByName(n) || _ss.insertSheet(n);
  if (s.getLastColumn() < H[n].length) {            // create or migrate (adds Phone/ClientId columns)
    s.getRange(1, 1, 1, H[n].length).setValues([H[n]]).setFontWeight('bold');
    s.setFrozenRows(1);
    if (n === 'Main') { s.getRange('B:B').setNumberFormat('@'); s.getRange('K:K').setNumberFormat('@'); }
    if (n === 'Headcount') s.getRange('B:B').setNumberFormat('@');
  }
  return s;
}
// read only the columns needed (much faster than getDataRange on big sheets)
function col(n, c, w) { const s = sheet(n), l = s.getLastRow(); return l < 2 ? [] : s.getRange(2, c, l - 1, w || 1).getValues(); }
const ymd = v => v instanceof Date ? Utilities.formatDate(v, TZ, 'yyyy-MM-dd') : String(v || '').slice(0, 10);
const str = v => { v = String(v == null ? '' : v).trim().slice(0, 200); return /^[=+\-@]/.test(v) ? "'" + v : v; };
const num = v => Math.max(0, parseInt(v) || 0);
function memo(k, ttl, fn) {
  const c = CacheService.getScriptCache(), h = c.get(k);
  if (h) return JSON.parse(h);
  const v = fn(); try { c.put(k, JSON.stringify(v), ttl); } catch (e) {} return v;
}
const bust = () => CacheService.getScriptCache().removeAll(['boot', 'stats', 'analytics']);
function locked(fn) { const l = LockService.getScriptLock(); l.waitLock(25000); try { return fn(); } finally { l.releaseLock(); } }

// ---------- auth ----------
function login(d) {
  const c = CacheService.getScriptCache(), fk = 'fail', fails = +c.get(fk) || 0;
  if (fails >= 8) return { success: false, message: 'Too many attempts. Try again in 10 minutes.' };
  const p = PropertiesService.getScriptProperties().getProperty('PASS_' + d.role);
  if (!p || p !== String(d.password)) { c.put(fk, String(fails + 1), 600); return { success: false, message: 'Invalid password for selected role' }; }
  const t = Utilities.getUuid(); c.put('t_' + t, d.role, 21600);
  return { success: true, token: t, role: d.role };
}

// ---------- reference data (one call replaces getDistricts/getLocations/getMessages) ----------
function bootstrap() {
  return memo('boot', 300, () => {
    const map = {};
    col('Districts', 1).forEach(r => { const d = String(r[0]).trim(); if (d) map[d] = map[d] || []; });
    col('Locations', 1, 2).forEach(r => {
      const d = String(r[0]).trim(), l = String(r[1]).trim();
      if (d && l) { map[d] = map[d] || []; if (!map[d].includes(l)) map[d].push(l); }
    });
    Object.values(map).forEach(a => a.sort());
    return { success: true, districts: map,
      messages: col('Messages', 1, 2).filter(r => r[0]).map(r => ({ message: String(r[0]).trim(), speaker: String(r[1] || '').trim() })) };
  });
}
function addLocation(d) {
  const dn = str(d.district), ln = str(d.location);
  if (!dn || !ln) return { success: false, message: 'Both district and location are required.' };
  return locked(() => {
    if (!col('Districts', 1).some(r => String(r[0]).trim() === dn)) sheet('Districts').appendRow([dn]);
    if (!col('Locations', 1, 2).some(r => String(r[0]).trim() === dn && String(r[1]).trim() === ln)) sheet('Locations').appendRow([dn, ln]);
    bust(); return { success: true, message: `Location '${ln}' added to district '${dn}'.` };
  });
}
function addMessage(d) {
  const m = str(d.message), sp = str(d.speaker);
  if (!m) return { success: false, message: 'Message title is required.' };
  return locked(() => {
    if (col('Messages', 1).some(r => String(r[0]).trim() === m)) return { success: false, message: 'Message already exists.' };
    sheet('Messages').appendRow([m, sp]); bust(); return { success: true, message: 'Message added.' };
  });
}

// ---------- idempotent batch writes (safe for offline retries) ----------
function appendUnique(name, idCol, records, toRow) {
  return locked(() => {
    const s = sheet(name), seen = new Set(col(name, idCol).map(r => r[0])), rows = [], acked = [];
    (records || []).slice(0, 500).forEach(r => {
      if (!r || !r.cid) return;
      acked.push(r.cid);
      if (seen.has(r.cid)) return;
      const row = toRow(r, new Date(r.ts || Date.now()));
      if (row) { seen.add(r.cid); rows.push(row); }
    });
    if (rows.length) s.getRange(s.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
    bust(); return { success: true, acked, added: rows.length };
  });
}
function syncReg(d) {
  return appendUnique('Main', 12, d.records, (r, ts) =>
    ['Male', 'Female'].includes(r.gender) && CAMPS.includes(r.camp) && str(r.fullName).length > 1
      ? [ts, ymd(r.date), str(r.fullName), r.gender, str(r.ageGroup), r.camp, str(r.district), str(r.location), str(r.status),
         str(r.invitedBy), String(r.phone || '').replace(/[^\d+ ]/g, '').slice(0, 20), r.cid] : null);
}
function syncHC(d) {
  return appendUnique('Headcount', 10, d.records, (r, ts) =>
    CAMPS.includes(r.camp) && r.message
      ? [ts, ymd(r.date), r.camp, str(r.message), num(r.maleCount), num(r.femaleCount), num(r.altarCallMale), num(r.altarCallFemale), str(r.notes), r.cid] : null);
}

// ---------- reporting: single pass, cached ----------
function stats() {
  return memo('stats', 30, () => {
    const rows = col('Main', 2, 8), t = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
    let today = 0, nc = 0, mem = 0; const camps = {}, gender = { Male: 0, Female: 0 };
    rows.forEach(r => {
      if (ymd(r[0]) === t) today++;
      if (r[7] === 'New Comer') nc++; else if (r[7] === 'Member') mem++;
      camps[r[4]] = (camps[r[4]] || 0) + 1;
      if (r[2] in gender) gender[r[2]]++;
    });
    const s = sheet('Main'), l = s.getLastRow(), n = Math.min(5, l - 1);
    const recent = n > 0 ? s.getRange(l - n + 1, 1, n, 9).getValues().reverse().map(r =>
      ({ name: r[2], district: r[6], status: r[8], time: Utilities.formatDate(new Date(r[0]), TZ, 'HH:mm') })) : [];
    return { success: true, total: rows.length, today, newComers: nc, members: mem, camps, gender, recent };
  });
}
const add = (o, c, g) => (o[c] = o[c] || [0, 0])[g]++;
function analytics() {
  return memo('analytics', 120, () => {
    const camps = {}, daily = {}, dist = {};
    col('Main', 2, 7).forEach(r => {
      const c = r[4]; if (!CAMPS.includes(c)) return;
      const g = r[2] === 'Male' ? 0 : 1, d = ymd(r[0]), ds = String(r[5]).trim();
      add(camps, c, g); add(daily[d] = daily[d] || {}, c, g);
      if (ds) add(dist[ds] = dist[ds] || {}, c, g);
    });
    return { success: true, camps,
      daily: Object.keys(daily).sort().map(k => ({ k, c: daily[k] })),
      districts: Object.keys(dist).map(k => ({ k, c: dist[k] })) };
  });
}
const tally = (o, k, m, f, am, af) => { const t = o[k] = o[k] || [0, 0, 0, 0, 0]; t[0] += m; t[1] += f; t[2] += am; t[3] += af; t[4]++; };
function headcounts(d) {            // server-side filter + pagination
  const rows = col('Headcount', 1, 9), out = [], camps = {}, msgs = {}, st = { total: 0, ac: 0, acM: 0, acF: 0 };
  const q = String(d.q || '').toLowerCase();
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i], date = ymd(r[1]);
    if (!date || !r[2] || !r[3]) continue;
    if ((d.date && date !== d.date) || (d.camp && r[2] !== d.camp) || (d.message && r[3] !== d.message)) continue;
    if (q && !(date + r[2] + r[3] + r[8]).toLowerCase().includes(q)) continue;
    const m = +r[4] || 0, f = +r[5] || 0, am = +r[6] || 0, af = +r[7] || 0;
    out.push([date, r[2], r[3], m, f, am, af, String(r[8] || '')]);
    st.total += m + f; st.ac += am + af; st.acM += am; st.acF += af;
    tally(camps, r[2], m, f, am, af); tally(msgs, r[3], m, f, am, af);
  }
  const size = Math.min(100, +d.size || 10), page = Math.max(1, +d.page || 1);
  return { success: true, total: out.length, page, size, rows: out.slice((page - 1) * size, page * size), stats: st, camps, msgs };
}
