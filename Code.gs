// DCLM API (Google Apps Script). Deploy as Web App: Execute as ME, access ANYONE.
// Run setup() once, then change the passwords in Project Settings > Script properties.
const SS_ID = '1DV5YlX8CKKHVtcJ5sxfqWZuf_BpwALwRnj11u7qmrk8';
const TZ = 'Africa/Accra';
const CAMPS = ['Adult', 'Youth', 'Campus', 'Children'];
const H = {
  Main: ['Timestamp','Date','Full Name','Gender','Age Group','Camp','District','Location','Status','Invited By','Phone','ClientId'],
  Districts: ['District'], Locations: ['District','Location'], Messages: ['Message','Speaker','Program'],
  Programs: ['Id','Name','Theme','Start','End'],
  Settings: ['Key','Value'],
  Baptisms: ['Timestamp','Date','Male','Female','Notes','ClientId'],
  Headcount: ['Timestamp','Date','Camp','Message','Male Count','Female Count','Altar Call Male','Altar Call Female','Notes','ClientId']
};
const ROUTES = {
  bootstrap: ['r', bootstrap], stats: ['r', stats], syncRegistrations: ['r', syncReg],
  addLocation: ['a', addLocation], addMessage: ['a', addMessage], analytics: ['a', analytics],
  headcounts: ['a', headcounts], syncHeadcounts: ['a', syncHC], changePassword: ['a', changePassword], saveLogo: ['a', saveLogo], baptisms: ['a', baptisms], insights: ['a', insights], exportData: ['a', exportData], syncBaptisms: ['a', syncBP], saveOrg: ['a', saveOrg], saveProgram: ['a', saveProgram]
};

function setup() {
  const P = PropertiesService.getScriptProperties();
  [['register', 'CHANGE_ME_1'], ['admin', 'CHANGE_ME_2']].forEach(([r, pw]) => { if (!P.getProperty('HASH_' + r) && !P.getProperty('PASS_' + r)) setPass(r, pw); });
  Object.keys(H).forEach(sheet);
}
// Emergency reset if the admin password is forgotten: edit the values, run this once in the editor, then remove them.
function resetPasswords() { setPass('admin', 'CHANGE_ME_2'); setPass('register', 'CHANGE_ME_1'); }
function doGet() { return ContentService.createTextOutput('DCLM API OK'); }
function doPost(e) {
  let out;
  try {
    const d = JSON.parse(e.postData.contents), r = ROUTES[d.action];
    if (d.action === 'login') out = login(d);
    else if (d.action === 'config') out = getConfig();   // public: needed on the login screen
    else {
      const role = sessionRole(d.token);
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
    if (n === 'Headcount' || n === 'Baptisms') s.getRange('B:B').setNumberFormat('@');
    if (n === 'Programs') s.getRange('D:E').setNumberFormat('@');
  }
  return s;
}
// read only the columns needed (much faster than getDataRange on big sheets)
function col(n, c, w) { const s = sheet(n), l = s.getLastRow(); return l < 2 ? [] : s.getRange(2, c, l - 1, w || 1).getValues(); }
const ymd = v => v instanceof Date ? Utilities.formatDate(v, TZ, 'yyyy-MM-dd') : String(v || '').slice(0, 10);
const str = v => { v = String(v == null ? '' : v).trim().slice(0, 200); return /^[=+\-@]/.test(v) ? "'" + v : v; };
const num = v => Math.max(0, parseInt(v) || 0);
const ver = () => CacheService.getScriptCache().get('ver') || '0';
function memo(k, ttl, fn) {            // cache keys carry a version, so bust() invalidates everything at once
  const c = CacheService.getScriptCache(), key = k + ':' + ver(), h = c.get(key);
  if (h) return JSON.parse(h);
  const v = fn(); try { c.put(key, JSON.stringify(v), ttl); } catch (e) {} return v;
}
const bust = () => CacheService.getScriptCache().put('ver', String(Date.now()), 21600);
function locked(fn) { const l = LockService.getScriptLock(); l.waitLock(25000); try { return fn(); } finally { l.releaseLock(); } }

// ---------- auth ----------
function login(d) {
  const c = CacheService.getScriptCache(), fk = 'fail', fails = +c.get(fk) || 0;
  if (fails >= 8) return { success: false, message: 'Too many attempts. Try again in 10 minutes.' };
  if (!['register', 'admin'].includes(d.role) || !checkPass(d.role, String(d.password || ''))) { c.put(fk, String(fails + 1), 600); return { success: false, message: 'Invalid password for selected role' }; }
  return { success: true, token: newToken(d.role), role: d.role };
}

// ---------- passwords: stored as salted SHA-256 hashes; changing one signs out that role's other sessions ----------
const props = () => PropertiesService.getScriptProperties();
const sha = s => Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s));
function setPass(role, pw) {
  const P = props(), salt = Utilities.getUuid();
  P.setProperties({ ['SALT_' + role]: salt, ['HASH_' + role]: sha(salt + pw), ['EPOCH_' + role]: Utilities.getUuid() });
  P.deleteProperty('PASS_' + role);
}
function checkPass(role, pw) {
  const P = props(), h = P.getProperty('HASH_' + role);
  if (h) return sha(P.getProperty('SALT_' + role) + pw) === h;
  const legacy = P.getProperty('PASS_' + role); return !!legacy && legacy === pw;   // plain value set by hand in Script properties
}
function newToken(role) {
  const t = Utilities.getUuid();
  CacheService.getScriptCache().put('t_' + t, role + '|' + (props().getProperty('EPOCH_' + role) || ''), 21600);
  return t;
}
function sessionRole(token) {
  const v = CacheService.getScriptCache().get('t_' + token); if (!v) return null;
  const [role, ep] = v.split('|');
  return (ep || '') === (props().getProperty('EPOCH_' + role) || '') ? role : null;
}
function changePassword(d) {
  const role = d.role === 'register' ? 'register' : 'admin', pw = String(d.password || ''), c = CacheService.getScriptCache(), fails = +c.get('fail') || 0;
  if (fails >= 8) return { success: false, message: 'Too many attempts. Try again in 10 minutes.' };
  if (pw.length < 6) return { success: false, message: 'New password must be at least 6 characters.' };
  if (!checkPass('admin', String(d.current || ''))) { c.put('fail', String(fails + 1), 600); return { success: false, message: 'Your current admin password is incorrect.' }; }
  setPass(role, pw);
  const out = { success: true, message: (role === 'admin' ? 'Administrator' : 'Registration Officer') + ' password changed. Other signed-in devices for that role must log in again.' };
  if (role === 'admin') out.token = newToken('admin');          // keep this admin signed in
  return out;
}

// ---------- retreat programs (each has a date range) + organisation name ----------
function getConfig() {
  return memo('cfg', 300, () => {
    let org = 'DCLM', logo = '';
    col('Settings', 1, 2).forEach(r => { if (r[0] === 'org' && r[1]) org = String(r[1]); if (r[0] === 'logo') logo = String(r[1] || ''); });
    const programs = col('Programs', 1, 5).filter(r => r[0]).map(r =>
      ({ id: String(r[0]), name: String(r[1]), theme: String(r[2] || ''), start: ymd(r[3]), end: ymd(r[4]) }))
      .sort((a, b) => a.start < b.start ? 1 : -1);
    return { success: true, config: { org, logo, programs } };
  });
}
const programsById = () => { const m = {}; getConfig().config.programs.forEach(p => m[p.id] = p); return m; };
function prog(d) {
  const p = programsById()[d.pid];
  if (!p) throw new Error('No retreat program selected. An admin must create one in the Programs tab.');
  return p;
}
const inR = (p, d) => d >= p.start && d <= p.end;
function setSetting(k, v) {
  const s = sheet('Settings'), l = s.getLastRow(), keys = l > 1 ? s.getRange(2, 1, l - 1, 1).getValues().map(r => r[0]) : [], i = keys.indexOf(k);
  if (i >= 0) s.getRange(i + 2, 2).setValue(v); else s.appendRow([k, v]);
}
function saveOrg(d) {
  return locked(() => { setSetting('org', str(d.org) || 'DCLM'); bust(); return { success: true, message: 'Saved.', config: getConfig().config }; });
}
function saveLogo(d) {               // the browser shrinks the image first; a sheet cell holds at most 50,000 characters
  const l = String(d.logo || '');
  if (l && !(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+\/=]+$/.test(l) && l.length <= 48000)) return { success: false, message: 'Invalid or too large image.' };
  return locked(() => { setSetting('logo', l); bust(); return { success: true, message: l ? 'Logo saved.' : 'Logo removed.', config: getConfig().config }; });
}
function saveProgram(d) {
  const name = str(d.name), theme = str(d.theme), start = ymd(d.start), end = ymd(d.end), re = /^\d{4}-\d{2}-\d{2}$/;
  if (!name || !re.test(start) || !re.test(end)) return { success: false, message: 'Name, start date and end date are required.' };
  if (start > end) return { success: false, message: 'End date must not be before the start date.' };
  return locked(() => {
    const id = d.id || '', clash = getConfig().config.programs.find(p => p.id !== id && start <= p.end && p.start <= end);
    if (clash) return { success: false, message: `Dates overlap with "${clash.name}" (${clash.start} to ${clash.end}).` };
    const s = sheet('Programs'), l = s.getLastRow(), ids = l > 1 ? s.getRange(2, 1, l - 1, 1).getValues().map(r => String(r[0])) : [], i = ids.indexOf(id);
    if (id && i < 0) return { success: false, message: 'Program not found.' };
    const nid = id || Utilities.getUuid().slice(0, 8);
    if (i >= 0) s.getRange(i + 2, 2, 1, 4).setValues([[name, theme, start, end]]); else s.appendRow([nid, name, theme, start, end]);
    bust(); return { success: true, message: 'Program saved.', config: getConfig().config, id: nid };
  });
}

// ---------- reference data (one call replaces getDistricts/getLocations/getMessages) ----------
function bootstrap(d) {
  return memo('boot:' + d.pid, 300, () => {
    const map = {};
    col('Districts', 1).forEach(r => { const d = String(r[0]).trim(); if (d) map[d] = map[d] || []; });
    col('Locations', 1, 2).forEach(r => {
      const d = String(r[0]).trim(), l = String(r[1]).trim();
      if (d && l) { map[d] = map[d] || []; if (!map[d].includes(l)) map[d].push(l); }
    });
    Object.values(map).forEach(a => a.sort());
    return { success: true, districts: map,
      messages: col('Messages', 1, 3).filter(r => r[0] && (!r[2] || r[2] === d.pid)).map(r => ({ message: String(r[0]).trim(), speaker: String(r[1] || '').trim() })) };
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
  const m = str(d.message), sp = str(d.speaker); prog(d);
  if (!m) return { success: false, message: 'Message title is required.' };
  return locked(() => {
    if (col('Messages', 1, 3).some(r => String(r[0]).trim() === m && String(r[2] || '') === d.pid)) return { success: false, message: 'Message already exists.' };
    sheet('Messages').appendRow([m, sp, d.pid]); bust(); return { success: true, message: 'Message added.' };
  });
}

// ---------- idempotent batch writes (safe for offline retries; each record must fall inside its program's dates) ----------
function appendUnique(name, idCol, records, toRow) {
  const P = programsById();
  return locked(() => {
    const s = sheet(name), seen = new Set(col(name, idCol).map(r => r[0])), rows = [], acked = [], rejected = [];
    (records || []).slice(0, 500).forEach(r => {
      if (!r || !r.cid) return;
      acked.push(r.cid);
      if (seen.has(r.cid)) return;
      const p = P[r.pid], row = p && inR(p, ymd(r.date)) ? toRow(r, new Date(r.ts || Date.now())) : null;
      if (row) { seen.add(r.cid); rows.push(row); } else rejected.push(r.cid);
    });
    if (rows.length) s.getRange(s.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
    bust(); return { success: true, acked, rejected, added: rows.length };
  });
}
function syncReg(d) {
  return appendUnique('Main', 12, d.records, (r, ts) =>
    ['Male', 'Female'].includes(r.gender) && CAMPS.includes(r.camp) && str(r.fullName).length > 1
      ? [ts, ymd(r.date), str(r.fullName), r.gender, str(r.ageGroup), r.camp, str(r.district), str(r.location), str(r.status),
         str(r.invitedBy), String(r.phone || '').replace(/[^\d+ ]/g, '').slice(0, 20), r.cid] : null);
}
function syncBP(d) {
  return appendUnique('Baptisms', 6, d.records, (r, ts) =>
    num(r.male) + num(r.female) > 0 ? [ts, ymd(r.date), num(r.male), num(r.female), str(r.notes), r.cid] : null);
}
function syncHC(d) {
  return appendUnique('Headcount', 10, d.records, (r, ts) =>
    CAMPS.includes(r.camp) && r.message
      ? [ts, ymd(r.date), r.camp, str(r.message), num(r.maleCount), num(r.femaleCount), num(r.altarCallMale), num(r.altarCallFemale), str(r.notes), r.cid] : null);
}

// ---------- reporting: single pass, cached, limited to the selected program's date range ----------
function stats(req) {
  const p = prog(req);
  return memo('stats:' + p.id, 30, () => {
    const rows = col('Main', 2, 8), t = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
    let total = 0, today = 0, nc = 0, mem = 0; const camps = {}, gender = { Male: 0, Female: 0 }, idx = [];
    rows.forEach((r, i) => {
      const dt = ymd(r[0]); if (!inR(p, dt)) return;
      total++; idx.push(i);
      if (dt === t) today++;
      if (r[7] === 'New Comer') nc++; else if (r[7] === 'Member') mem++;
      camps[r[4]] = (camps[r[4]] || 0) + 1;
      if (r[2] in gender) gender[r[2]]++;
    });
    const s = sheet('Main');
    const recent = idx.slice(-5).reverse().map(i => {
      const r = s.getRange(i + 2, 1, 1, 9).getValues()[0];
      return { name: r[2], district: r[6], status: r[8], time: Utilities.formatDate(new Date(r[0]), TZ, 'HH:mm') };
    });
    return { success: true, total, today, newComers: nc, members: mem, camps, gender, recent };
  });
}
const add = (o, c, g) => (o[c] = o[c] || [0, 0])[g]++;
function analytics(req) {
  const p = prog(req);
  return memo('analytics:' + p.id, 120, () => {
    const camps = {}, daily = {}, dist = {}, ages = {};
    col('Main', 2, 7).forEach(r => {
      const c = r[4], d = ymd(r[0]); if (!CAMPS.includes(c) || !inR(p, d)) return;
      const g = r[2] === 'Male' ? 0 : 1, ds = String(r[5]).trim();
      add(camps, c, g); add(daily[d] = daily[d] || {}, c, g);
      const ag = String(r[3]).trim(); if (ag) add(ages, ag, g);
      if (ds) add(dist[ds] = dist[ds] || {}, c, g);
    });
    return { success: true, camps, ages,
      daily: Object.keys(daily).sort().map(k => ({ k, c: daily[k] })),
      districts: Object.keys(dist).map(k => ({ k, c: dist[k] })) };
  });
}
const tally = (o, k, m, f, am, af) => { const t = o[k] = o[k] || [0, 0, 0, 0, 0]; t[0] += m; t[1] += f; t[2] += am; t[3] += af; t[4]++; };
function headcounts(d) {            // server-side filter + pagination
  const p = prog(d), rows = col('Headcount', 1, 9), out = [], camps = {}, msgs = {}, st = { total: 0, ac: 0, acM: 0, acF: 0 };
  const q = String(d.q || '').toLowerCase();
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i], date = ymd(r[1]);
    if (!date || !r[2] || !r[3] || !inR(p, date)) continue;
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

// ---------- baptism of converts: entries summed by gender and total, limited to the program's dates ----------
function baptisms(d) {
  const p = prog(d), rows = [], t = { male: 0, female: 0, total: 0 };
  col('Baptisms', 1, 5).forEach(r => {
    const dt = ymd(r[1]); if (!dt || !inR(p, dt)) return;
    const m = +r[2] || 0, f = +r[3] || 0; t.male += m; t.female += f; t.total += m + f;
    rows.push([dt, m, f, String(r[4] || '')]);
  });
  rows.sort((a, b) => a[0] < b[0] ? 1 : -1);
  return { success: true, totals: t, rows: rows.slice(0, 200) };
}

// ---------- insights: outreach funnel, altar-call rate per message, comparison with the previous program ----------
function insights(d) {
  const p = prog(d), prev = getConfig().config.programs.filter(x => x.start < p.start).sort((a, b) => a.start < b.start ? 1 : -1)[0] || null;
  return memo('ins:' + p.id, 120, () => {
    const main = col('Main', 2, 8), hc = col('Headcount', 1, 9), bp = col('Baptisms', 1, 5);
    const M = pr => {
      const m = { registered: 0, newComers: 0, attendance: 0, altar: 0, baptized: 0 };
      main.forEach(r => { if (inR(pr, ymd(r[0]))) { m.registered++; if (r[7] === 'New Comer') m.newComers++; } });
      hc.forEach(r => { if (r[2] && r[3] && inR(pr, ymd(r[1]))) { m.attendance += (+r[4] || 0) + (+r[5] || 0); m.altar += (+r[6] || 0) + (+r[7] || 0); } });
      bp.forEach(r => { if (inR(pr, ymd(r[1]))) m.baptized += (+r[2] || 0) + (+r[3] || 0); });
      return m;
    };
    const msgs = {};
    hc.forEach(r => {
      if (!r[2] || !r[3] || !inR(p, ymd(r[1]))) return;
      const t = msgs[r[3]] = msgs[r[3]] || [0, 0]; t[0] += (+r[4] || 0) + (+r[5] || 0); t[1] += (+r[6] || 0) + (+r[7] || 0);
    });
    return { success: true, cur: M(p), prev: prev ? M(prev) : null, prevName: prev ? prev.name : '',
      messages: Object.keys(msgs).map(k => ({ name: k, attendance: msgs[k][0], altar: msgs[k][1] })) };
  });
}

// ---------- export (paged, so large programs do not hit response limits) ----------
function exportData(d) {
  const p = prog(d), off = +d.offset || 0, LIM = 20000, ts = v => v instanceof Date ? Utilities.formatDate(v, TZ, 'yyyy-MM-dd HH:mm') : String(v || '');
  let name, width, header, map;
  if (d.kind === 'registrations') {
    name = 'Main'; width = 11; header = ['Date', 'Full Name', 'Gender', 'Age Group', 'Camp', 'District', 'Location', 'Status', 'Invited By', 'Phone', 'Registered At'];
    map = r => [ymd(r[1]), r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10] ? '="' + String(r[10]).replace(/"/g, '') + '"' : '', ts(r[0])];   // ="..." keeps the leading 0 in Excel
  } else if (d.kind === 'headcount') {
    name = 'Headcount'; width = 9; header = ['Date', 'Camp', 'Message', 'Male', 'Female', 'Total', 'Altar Call Male', 'Altar Call Female', 'Altar Call Total', 'Notes'];
    map = r => [ymd(r[1]), r[2], r[3], +r[4] || 0, +r[5] || 0, (+r[4] || 0) + (+r[5] || 0), +r[6] || 0, +r[7] || 0, (+r[6] || 0) + (+r[7] || 0), r[8]];
  } else if (d.kind === 'baptisms') {
    name = 'Baptisms'; width = 5; header = ['Date', 'Male', 'Female', 'Total', 'Notes'];
    map = r => [ymd(r[1]), +r[2] || 0, +r[3] || 0, (+r[2] || 0) + (+r[3] || 0), r[4]];
  } else return { success: false, message: 'Unknown export type.' };
  const out = []; col(name, 1, width).forEach(r => { if (inR(p, ymd(r[1]))) out.push(map(r)); });
  return { success: true, header, total: out.length, rows: out.slice(off, off + LIM), next: off + LIM < out.length ? off + LIM : null };
}
