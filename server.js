// Millennial Pools fleet dashboard. One file, no installs: `node server.js`
// Needs Replit Secrets (or env vars): AZUGA_USERNAME, AZUGA_PASSWORD
const http = require('http');
const { AZUGA_USERNAME, AZUGA_PASSWORD, PORT = 3000 } = process.env;
const API = 'https://services.azuga.com/azuga-ws-oauth/v3';

let token, tokenExp = 0;
async function getToken() {
  if (token && Date.now() < tokenExp) return token;
  const r = await fetch('https://auth.azuga.com/azuga-as/oauth2/login/oauthtoken.json?loginType=1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userName: AZUGA_USERNAME, password: AZUGA_PASSWORD, clientId: '5decccae0a214939a77411a77eeff8fc' }),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.data?.access_token) throw new Error('Azuga login failed. Check AZUGA_USERNAME / AZUGA_PASSWORD in Secrets. ' + JSON.stringify(j).slice(0, 200));
  token = j.data.access_token;
  tokenExp = Date.now() + ((j.data.expires_in || 86400) - 3600) * 1000;
  return token;
}

// Azuga answers success with error: null OR error: [] -- only a non-empty error is a real failure.
const azErr = r => { const e = r && r.error; return e && !(Array.isArray(e) && !e.length) ? e : null; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function azuga(path, body = {}, method = 'POST', attempt = 1) {
  const r = await fetch(path.startsWith('https://') ? path : API + path, {
    method,
    headers: { Authorization: 'Bearer ' + (await getToken()), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (r.status === 401) { token = null; if (attempt < 2) return azuga(path, body, method, 3); }  // expired login: log in again and retry once
  if (r.status === 429) {
    // Per-minute limit: wait it out and retry (15s, then 30s) before giving up.
    if (attempt < 3) { await sleep(15000 * attempt); return azuga(path, body, method, attempt + 1); }
    throw new Error('Azuga is limiting requests right now. Try again in a minute.');
  }
  if (!r.ok) {
    // Show Azuga's own words ("Password length must be...") instead of raw JSON
    let msg; try { const j = JSON.parse(text); msg = [].concat(j.error || j.message || []).map(e => e && (e.message || e)).filter(Boolean).join('; '); } catch {}
    throw new Error(msg || `${path} -> ${r.status}: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : {};
}

// Azuga wants 'YYYY-MM-DD hh:mm:ss AM'
// ponytail: uses server clock timezone (UTC on Replit); fine for day-level windows
function fmt(d) {
  const p = n => String(n).padStart(2, '0');
  const h = d.getHours() % 12 || 12;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(h)}:${p(d.getMinutes())}:${p(d.getSeconds())} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
}
const daysAgo = n => new Date(Date.now() - n * 864e5);

// Azuga rate-limits per minute, so every viewer shares one copy of each answer.
// Concurrent asks share one request; if Azuga errors, the last good answer is served.
const cache = new Map();
// Slow Azuga/Ramp roll-ups: kept in Airtable ("Dashboard cache") so a restart still has the last good copy,
// and served straight away when old while a fresh copy is fetched behind the scenes.
const KEEP = new Set(['scores', 'ramp', 'trips']);
function cached(key, ttlSec, fn) {
  const c = cache.get(key) || {};
  if (c.data !== undefined && Date.now() - c.t < ttlSec * 1000) return Promise.resolve(c.data);
  const stale = KEEP.has(key) && c.data !== undefined;
  if (!c.p) c.p = fn()
    .then(d => { c.data = d; c.t = Date.now(); if (KEEP.has(key)) saveSnap(key, d); return d; })
    .catch(e => { if (c.data !== undefined) return c.data; throw e; })
    .finally(() => { c.p = null; });
  cache.set(key, c);
  if (stale) { c.p.catch(() => {}); return Promise.resolve(c.data); }
  return c.p;
}

const routes = {
  '/api/vehicles': () => cached('vehicles', 600, () => azuga('/trackees.json?limit=100&offset=0')),
  '/api/locations': () => cached('locations', 30, () => azuga('/vehicles/latestlocation', {})),
  '/api/drivers': () => driverGroups(),
  '/api/airtable': () => atLinks(),
  '/api/people': () => people(),
  '/api/sync/status': async () => ({ running: SYNC.running, last: SYNC.last, log: SYNC.log.slice(0, 20), imported: AIRTABLE_TOKEN ? (await atData()).trucks.some(t => t.snap) || (await atData()).drivers.some(d => d.snap) : false }),
  '/api/maintenance': () => cached('maintenance', 600, () => azuga('/maintanance/reports/scheduledreport.json?' + new URLSearchParams({
    startTime: fmt(daysAgo(365)), endTime: fmt(daysAgo(-365)), isCount: 'false',
  }))),
  '/api/ramp': async q => { const r = await rampFor(q.get('name') || '');   // plus miles driven, for gas per mile
    if (r.person && r.person.gas > 0) { const az = await azugaScore(q.get('vehicleId') || '', q.get('name') || '').catch(e => { r.milesError = e.message; return null; });
      if (!az && !r.milesError) r.milesError = 'Azuga has no miles for this driver in the last 30 days.';
      if (az && az.miles > 50) r.gasPerMile = { miles: az.miles, perMile: r.person.gas / az.miles, max: GAS_PER_MILE_MAX, points: GAS_POINTS }; }
    r.mpg = await mpgFor(q.get('name') || '', r.person).catch(() => null);
    r.flags = [];
    if (r.person && dupeName(r.person.name) !== dupeName(q.get('name') || '')) r.flags.push('Matched to "' + r.person.name + '" in Ramp because the names are close, not identical. If that is a different person, these numbers are not this driver\'s.');
    if (r.person && r.person.otherN && r.person.gasN === 0) r.flags.push('No gas found, only other purchases. If this driver buys gas, it may be filed under a category or store name the site does not recognise as gas.');
    if (r.gasPerMile) r.gasPerMile.flags = ['Miles come from Azuga for this driver; gas comes from Ramp. If the driver used more than one truck or paid for someone else\'s gas, this can be off.'];
    return r; },
  // Breadcrumbs: where one truck has been (Azuga's breadcrumb report), oldest first
  '/api/trail': async q => { const id = String(q.get('vehicleId') || ''), date = q.get('date'), hours = Math.min(72, Math.max(1, +q.get('hours') || 24));
    if (!id) throw new Error('Pick a truck.');
    if (date) { if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Bad date.'); const d = etDay(new Date(date + 'T16:00:00Z')); return { date, points: await trailRange(id, d.start, d.end, true) }; }
    return { hours, points: await trailRange(id, new Date(Date.now() - hours * 36e5), new Date(), false) };
  },
  // How long a tech spent at each pool on a given day: POM's schedule + the truck's breadcrumbs
  '/api/visits': async q => { const date = q.get('date') || etDay().ymd;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Bad date.');
    if (!clean(process.env.POM_API_KEY)) return { connected: false };
    return { connected: true, ...(await visitsFor(q.get('name') || '', date)) }; },
  '/api/pom/route': async q => { if (!clean(process.env.POM_API_KEY)) return { connected: false };
    const name = q.get('name') || ''; return { connected: true, day: etDay().ymd, ...(name ? await pomStopsFor(name) : {}) }; },
  '/api/pom/board': async q => { if (!clean(process.env.POM_API_KEY)) return { connected: false };
    const date = q.get('date') || etDay().ymd;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Bad date.');
    const { start, end } = etDay(new Date(date + 'T16:00:00Z')), by = {};
    // pinned appointments come back from other days too; keep only this day's
    (await pomDay(date)).map(pomStop).filter(s => { const t = Date.parse(s.time); return t >= +start && t <= +end; })
      .sort((a, b) => Date.parse(a.time) - Date.parse(b.time)).forEach(s => (by[s.tech] = by[s.tech] || []).push(s));
    const td = await truckDrivers().catch(() => ({})), drivers = Object.keys(td).filter(v => td[v]).map(v => ({ name: td[v], v }));
    const techs = Object.entries(by).filter(([n]) => n).map(([name, stops]) => { const m = rampMatch(drivers, name);
      return { name, truck: m ? m.v : null, driver: m ? m.name : null, total: stops.length, done: stops.filter(s => s.done).length, stops }; });
    return { connected: true, date, today: date === etDay().ymd, techs }; },   // stops with no tech are ignored
  '/api/pom/stops': async () => { if (!clean(process.env.POM_API_KEY)) return { connected: false };
    return { connected: true, day: etDay().ymd, stops: (await pomToday()).map(pomStop).filter(s => s.tech && s.lat && s.lng) }; },
  '/api/pom/debug': async () => { const { start, end } = etDay();   // behind the dashboard login: what POM sends back, for setting this up
    try { const all = await pomToday(); return { auth: pomAuth, day: etDay().ymd, start, end, count: all.length, techs: [...new Set(all.map(a => pomStop(a).tech))], statuses: [...new Set(all.map(a => a.status + ' / ' + (a.serviceStatus && a.serviceStatus.name)))], sample: all.slice(0, 2) }; }
    catch (e) { return { error: e.message }; } },
  '/api/score/status': () => ({ jobs: WARM, events: Object.keys(EVA.ev).length, weeksBackfilled: EVA.weeks, miles: !!(cache.get('scores') || {}).data }),
  '/api/score': q => scoreFor(q.get('vehicleId') || '', q.get('name') || ''),
  '/api/videos': q => {
    const id = q.get('vehicleId') || '';
    const body = { startTime: fmt(daysAgo(7)), endTime: fmt(new Date()), page: 1, limit: 100, ...(id ? { vehiclesIds: id } : {}) };
    return cached('videos:' + id, id ? 120 : 300, async () => {
      let ev = [];  // all pages, so older clips in the week aren't cut off
      for (let page = 1; page <= (id ? 5 : 15); page++) { const p = list(await azuga('/eventVideos.json?videoType=eventVideo', { ...body, page })); ev = ev.concat(p); if (p.length < body.limit) break; }
      // Clips someone asked the camera for (from this dashboard or Azuga's site)
      let rq = []; try { rq = list(await azuga('/eventVideos.json?videoType=requestedVideo', body)).map(x => ({ ...x, eventType: x.eventType || 'Requested clip', requested: true })); } catch (e) { console.error('Requested videos:', e.message); }
      const t = x => +(x.eventTime || x.startTime || 0) || Date.parse(x.eventTime || x.startTime) || 0;
      if (!id) addEvents(ev);   // feeds the driver-score archive
      return [...rq, ...ev].sort((a, b) => t(b) - t(a));
    });
  },
};

// Same "first array we find" helper the page uses, for Azuga's varying response wrappers
const list = x => Array.isArray(x) ? x : x && typeof x === 'object' ? (Object.values(x).map(list).find(a => a.length) || []) : [];

// Edit tab -> Azuga. Azuga's update REPLACES the whole vehicle record, so we fetch the
// current record fresh, change only the edited fields, and send everything else back as-is.
const rawDrivers = () => cached('rawDrivers', 600, async () => list(await azuga('/users.json?limit=500&offset=0&userType=driver', {})));
const drivers = () => cached('drivers', 600, async () =>
  (await rawDrivers())
    .map(u => {
      const strs = Object.values(u).filter(v => typeof v === 'string');
      return { id: u.id, name: [u.firstName, u.lastName].filter(Boolean).join(' ').replace(/[ .]+$/, ''),
        email: u.email || strs.find(v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) || '',
        phone: strs.find(v => /^\+?[\d\s().-]{10,}$/.test(v) && v.replace(/\D/g, '').length >= 10) || '' };
    })
    .filter(u => u.id && /[a-z]/i.test(u.name))
    .sort((x, y) => x.name.localeCompare(y.name)));

// Azuga can hold several logins for one person. Group them by name; the "main" login is the one
// already used on the most trucks (ties: the first listed). The dropdown shows one entry per person.
async function driverGroups() {
  const [ds, vs] = await Promise.all([drivers(), routes['/api/vehicles']().then(list).catch(() => [])]);
  const uses = {}; vs.forEach(v => v.userId && (uses[v.userId] = (uses[v.userId] || 0) + 1));
  const g = {};
  ds.forEach(d => (g[d.name.toLowerCase().replace(/\s+/g, ' ')] = g[d.name.toLowerCase().replace(/\s+/g, ' ')] || []).push({ ...d, trucks: uses[d.id] || 0 }));
  return Object.values(g).map(acc => { acc.sort((a, b) => b.trucks - a.trucks); return { id: acc[0].id, name: acc[0].name, ids: acc.map(a => a.id), accounts: acc }; })
    .sort((a, b) => a.name.localeCompare(b.name));
}

const OWNERSHIP = ['Company', 'Employee', 'Leased', 'Rental'];
const text = (v, max, label) => {
  const t = String(v ?? '').trim();
  if (t.length > max) throw new Error(label + ' must be ' + max + ' characters or fewer.');
  return t;
};

// Edit tab -> Azuga. Azuga's update REPLACES the whole vehicle record, so we fetch the
// current record fresh, change only the edited fields, and send everything else back as-is.
// Short-lived shared copy of the vehicle list. After each save we patch our copy in place,
// so it never goes stale from our own edits and a bulk sync makes one list call, not one per truck.
// ponytail: a change made on Azuga's own site in the last 60s could be overwritten; shrink the 60 if that bites.
const freshVehicles = async () => list(await cached('fresh', 60, () => azuga('/trackees.json?limit=100&offset=0')));

// Validates the edits and builds the full record to send. Throws on bad input, writes nothing.
async function buildUpdate(b, vs) {
  const id = String(b.trackeeId || '');
  const cur = (vs || await freshVehicles()).find(v => v.trackeeId === id);
  if (!cur) throw new Error('Vehicle not found in Azuga.');
  const body = { ...cur }, changed = [];
  const set = (k, v, label) => { body[k] = v; changed.push(label); };
  if ('name' in b) { const n = text(b.name, 100, 'Name'); if (!n) throw new Error('Name is required.'); set('name', n, 'name'); }
  if ('make' in b) set('make', text(b.make, 50, 'Make'), 'make');
  if ('model' in b) set('model', text(b.model, 50, 'Model'), 'model');
  if ('year' in b) {
    const y = Number(b.year);
    if (!Number.isInteger(y) || y < 1980 || y > new Date().getFullYear() + 2) throw new Error('Year must be a real model year.');
    set('year', y, 'year');
  }
  if ('licensePlateNo' in b) {
    const v = text(b.licensePlateNo, 20, 'Plate').toUpperCase();
    if (!/^[A-Z0-9 -]*$/.test(v)) throw new Error('Plate can only use letters, numbers, spaces and dashes.');
    set('licensePlateNo', v, 'plate');
  }
  if ('vin' in b) {
    const v = text(b.vin, 17, 'VIN').toUpperCase();
    if (v && !/^[A-HJ-NPR-Z0-9]{17}$/.test(v)) throw new Error('VIN must be 17 letters/numbers (no I, O or Q).');
    set('vin', v, 'VIN');
  }
  if ('assetno' in b) {
    const v = b.assetno === '' ? null : Number(b.assetno);
    if (v !== null && (!Number.isInteger(v) || v < 0)) throw new Error('Asset number must be a whole number.');
    set('assetno', v, 'asset number');
  }
  if ('ownership' in b) {
    if (!OWNERSHIP.includes(b.ownership)) throw new Error('Ownership must be one of: ' + OWNERSHIP.join(', ') + '.');
    set('ownership', b.ownership, 'ownership');
  }
  if ('odometer' in b) {
    const o = Number(b.odometer);
    if (!Number.isInteger(o) || o < 0 || o > 2000000) throw new Error('Odometer must be a whole number of miles.');
    body.odometerReading = o; set('currentOdometerReading', o, 'odometer=' + o);
  }
  if ('userId' in b && !b.userId) {   // no driver: trucks without one simply have no userId in Azuga
    delete body.userId; delete body.userName; delete body.userFirstName; delete body.userLastName; changed.push('driver removed');
  } else if ('userId' in b) {
    const d = (await drivers()).find(d => d.id === b.userId);
    if (!d) throw new Error('Pick a driver from the list.');
    body.userName = d.name; set('userId', d.id, 'driver=' + d.name);
  }
  return { id, cur, body, changed };
}

async function sendUpdate({ id, cur, body, changed }) {
  if (!changed.length) throw new Error('Nothing to change.');
  const r = await azuga('/trackees/' + encodeURIComponent(id) + '.json', body, 'PUT');
  if (azErr(r)) throw new Error('Azuga rejected the change: ' + JSON.stringify(azErr(r)).slice(0, 200));
  const mine = list(cache.get('fresh')?.data).find(v => v.trackeeId === id);
  if (mine) Object.assign(mine, body);
  cache.delete('vehicles'); cache.delete('locations');
  console.log(new Date().toISOString(), 'Azuga updated', cur.name, '->', changed.join(', '));
  return changed;
}

// ---------------- Airtable (the source of truth) ----------------
const { AIRTABLE_TOKEN } = process.env;
const AT_BASE = 'appxOcqhRSdoWgHE3', AT_TRUCKS = 'tbl3aU0dRPvn79Ba1', AT_DRIVERS = 'tbl9oEuseNwk23jdg';
const F = { vin: 'fldT4fSSnXnZuj2Jr', year: 'fldqjqyAK1ZJfn0oT', make: 'fldOhan3is4yEhucl', model: 'fldM01jCShSILujYB',
  truckNo: 'fldYmYqWTfoYoRvjB', policy: 'fldWlS28YbpsipR7r', driver: 'fldEO66ezgMWnguAu', plate: 'fldLGLwnLOAfpw88W',
  insCard: 'fldH0Pe6EKyQEBmMR', files: 'fldS5YJgDrLDbxSiK', regRenew: 'fldjFFBZ0UoO4SUXV', ezpass: 'fld1utE81nDdDiqgi', active: 'fldBpQ0MA5cD9YJ06', snap: 'fldOaFfl7ZzS72xLK' };
// Drivers. Date of birth is only ever written (new driver form), never read or shown.
const D = { name: 'fldMrVtrXN6WDaOjj', license: 'fldcSIYqy5FCEC0Xn', state: 'fld1NdVP4v6QcckK2', pic: 'fldZeCHS22kI7Ythi',
  policy: 'fldVo5IrWedsKvumK', trucks: 'fld47HPqHRrw9GUL7', notes: 'fldSnexzpxIG22gF0', status: 'fldVuSDYSZVHk0fWN',
  phone: 'fldNxN3OyrU3TFAjQ', azId: 'fldgBxpfEnLCwdIzS', snap: 'fldhuLqirXbDaAy89' };
const D_DOB = 'fldFMJ06wrdGolZkS';

async function airtable(path, opt = {}) {
  if (!AIRTABLE_TOKEN) throw new Error('Airtable is not connected yet (add AIRTABLE_TOKEN in Render).');
  const r = await fetch('https://api.airtable.com/v0/' + AT_BASE + '/' + path, { ...opt, headers: { Authorization: 'Bearer ' + AIRTABLE_TOKEN, 'Content-Type': 'application/json' } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Airtable ' + r.status + ': ' + String(j.error?.message || j.error?.type || j.error || 'error').slice(0, 200));
  return j;
}
async function atAll(table, fields) {
  let out = [], offset;
  do {
    const q = new URLSearchParams({ returnFieldsByFieldId: 'true', pageSize: '100' });
    fields.forEach(f => q.append('fields[]', f));
    if (offset) q.set('offset', offset);
    const j = await airtable(table + '?' + q);
    out = out.concat(j.records); offset = j.offset;
  } while (offset);
  return out;
}
const clean = v => String(v ?? '').trim();
const normVin = v => clean(v).toUpperCase().replace(/\s+/g, '');
const normName = v => clean(v).toLowerCase().replace(/\s+/g, ' ');
const normPlate = v => clean(v).toUpperCase().replace(/\s+/g, '');
const PLATE_OK = /^[A-Z0-9]{2,8}$/;  // real plates; skips notes like "HALDEMAN FORD" or "Not registered yet"

const parseSnap = v => { try { const o = JSON.parse(v || ''); return o && typeof o === 'object' ? o : null; } catch { return null; } };
const atData = () => cached('airtable', 60, async () => {
  const [trucks, drv] = await Promise.all([atAll(AT_TRUCKS, Object.values(F)), atAll(AT_DRIVERS, Object.values(D))]);
  const att = a => (a || []).map(x => ({ name: x.filename, url: x.url, type: x.type, thumb: x.thumbnails?.small?.url }));
  const drivers = drv.map(r => ({ id: r.id, name: clean(r.fields[D.name]), license: clean(r.fields[D.license]), state: clean(r.fields[D.state]),
    policy: clean(r.fields[D.policy]?.name ?? r.fields[D.policy]), notes: clean(r.fields[D.notes]), truckIds: r.fields[D.trucks] || [], pic: att(r.fields[D.pic]),
    status: clean(r.fields[D.status]?.name ?? r.fields[D.status]) || 'Active',
    phone: clean(r.fields[D.phone]), azId: clean(r.fields[D.azId]), snap: parseSnap(r.fields[D.snap]) }));
  const byId = Object.fromEntries(drivers.map(d => [d.id, d]));
  return {
    drivers,
    trucks: trucks.map(r => { const f = r.fields; return {
      id: r.id, vin: normVin(f[F.vin]), year: clean(f[F.year]), make: clean(f[F.make]), model: clean(f[F.model]),
      truckNo: clean(f[F.truckNo]), policy: clean(f[F.policy]?.name ?? f[F.policy]), plate: clean(f[F.plate]),
      regRenew: clean(f[F.regRenew]), ezpass: clean(f[F.ezpass]), active: !!f[F.active],
      driver: (f[F.driver] || []).map(id => byId[id]).filter(Boolean)[0] || null, snap: parseSnap(f[F.snap]),
      insCard: att(f[F.insCard]), files: att(f[F.files]),
    }; }),
  };
});

// True when two strings differ by at most one inserted/deleted/changed character (VIN typos).
function near(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, e = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++e > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return e + (a.length - i) + (b.length - j) <= 1;
}
// Link Azuga vehicles to Airtable trucks: exact VIN first, then a unique one-typo VIN match.
function matchAll(vs, trucks) {
  const byVin = {}, used = new Set(), m = {};
  trucks.forEach(t => { if (t.vin) (byVin[t.vin] = byVin[t.vin] || []).push(t); });
  vs.forEach(v => {
    const hit = byVin[normVin(v.vin)];
    if (hit && hit.length === 1) { m[v.trackeeId] = { truck: hit[0], how: 'VIN' }; used.add(hit[0].id); }
    else if (hit) m[v.trackeeId] = { dupe: true };
  });
  vs.forEach(v => {
    const vin = normVin(v.vin);
    if (m[v.trackeeId] || vin.length < 16) return;
    const c = trucks.filter(t => !used.has(t.id) && t.vin && near(vin, t.vin));
    if (c.length === 1) { m[v.trackeeId] = { truck: c[0], how: 'VIN (one typo apart)' }; used.add(c[0].id); }
  });
  return m;
}
// What Azuga should change to match Airtable.
async function diffFor(v, t) {
  const changes = {}, notes = [];
  if (t.vin && /^[A-HJ-NPR-Z0-9]{17}$/.test(t.vin) && t.vin !== normVin(v.vin)) changes.vin = t.vin;
  const p = normPlate(t.plate);
  if (p && !PLATE_OK.test(p)) notes.push('Airtable plate "' + t.plate + '" is not a plate number, so it was not sent to Azuga.');
  else if (p && p !== normPlate(v.licensePlateNo)) changes.licensePlateNo = p;
  const y = Number(t.year);
  if (Number.isInteger(y) && y >= 1980 && y !== Number(v.year)) changes.year = y;
  if (t.make && t.make.toLowerCase() !== clean(v.make).toLowerCase()) changes.make = t.make;
  if (t.model && t.model.toLowerCase() !== clean(v.model).toLowerCase()) changes.model = t.model;
  if (t.driver) {
    const ad = (await driverGroups()).find(d => normName(d.name) === normName(t.driver.name));
    if (!ad) notes.push('Driver ' + t.driver.name + ' is not set up in Azuga yet.');
    else if (!ad.ids.includes(v.userId)) changes.userId = ad.id;
  }
  return { changes, notes };
}
async function atLinks() {
  if (!AIRTABLE_TOKEN) return { connected: false };
  const [vs, at] = await Promise.all([routes['/api/vehicles']().then(list), atData()]);
  const m = matchAll(vs, at.trucks), links = {};
  for (const v of vs) {
    const x = m[v.trackeeId];
    if (!x) links[v.trackeeId] = { linked: false };
    else if (x.dupe) links[v.trackeeId] = { linked: false, dupe: true };
    else links[v.trackeeId] = { linked: true, how: x.how, truck: x.truck, ...(await diffFor(v, x.truck)) };
  }
  const usedIds = new Set(Object.values(m).filter(x => x.truck).map(x => x.truck.id));
  const vinCount = {}; at.trucks.forEach(t => t.vin && (vinCount[t.vin] = (vinCount[t.vin] || 0) + 1));
  return { connected: true, links, notInAzuga: at.trucks.filter(t => !usedIds.has(t.id)).map(t => ({ id: t.id, truckNo: t.truckNo, vin: t.vin,
    vinOk: /^[A-HJ-NPR-Z0-9]{17}$/.test(t.vin), dupVin: vinCount[t.vin] > 1, desc: [t.year, t.make, t.model].filter(Boolean).join(' ') })) };
}

// Edit tab save: Airtable first (it's the master), then Azuga.
const SHARED = { vin: F.vin, licensePlateNo: F.plate, year: F.year, make: F.make, model: F.model };
const AT_ONLY = { truckNo: [F.truckNo, 30], policy: [F.policy, 60], regRenew: [F.regRenew, 40], ezpass: [F.ezpass, 40] };
const AZ_KEYS = ['name', 'make', 'model', 'year', 'licensePlateNo', 'vin', 'assetno', 'ownership', 'odometer', 'userId'];
async function saveTruck(b) {
  const az = { trackeeId: b.trackeeId }, notes = [], saved = [];
  AZ_KEYS.forEach(k => { if (k in b) az[k] = b[k]; });
  const azuga = Object.keys(az).length > 1 ? await buildUpdate(az) : null;  // validates before anything is written
  const fields = {};
  for (const k in AT_ONLY) if (k in b) fields[AT_ONLY[k][0]] = text(b[k], AT_ONLY[k][1], k);
  if ('active' in b) fields[F.active] = b.active === true;
  const wantsAt = Object.keys(fields).length > 0;
  if (AIRTABLE_TOKEN) {
    const L = (await atLinks()).links[b.trackeeId];
    if (L && L.linked) {
      if (azuga) for (const k in SHARED) if (k in az) fields[SHARED[k]] = String(azuga.body[k] ?? '');
      if (azuga && 'userId' in az) {
        const name = azuga.body.userName, atd = (await atData()).drivers.find(d => normName(d.name) === normName(name));
        if (atd) fields[F.driver] = [atd.id]; else notes.push(name + ' is not in the Airtable Drivers table, so Airtable\'s driver was left as is.');
      }
      if (Object.keys(fields).length) {
        await airtable(AT_TRUCKS + '/' + L.truck.id, { method: 'PATCH', body: JSON.stringify({ fields, typecast: true }) });
        cache.delete('airtable'); saved.push('Airtable');
        console.log(new Date().toISOString(), 'Airtable updated truck', L.truck.truckNo || L.truck.vin, Object.keys(fields).length, 'fields');
      }
    } else if (wantsAt) throw new Error('This truck is not linked to an Airtable record (its VIN is not in Airtable), so Airtable fields can not be saved.');
  } else if (wantsAt) throw new Error('Airtable is not connected yet.');
  if (azuga) { await sendUpdate(azuga); saved.push('Azuga'); }
  if (!saved.length) throw new Error('Nothing to change.');
  return { ok: true, saved, notes };
}

// ---------------- Drivers tab ----------------
async function people() {
  if (!AIRTABLE_TOKEN) return { connected: false };
  const [at, az] = await Promise.all([atData(), drivers().catch(() => null)]);
  const truckLabel = Object.fromEntries(at.trucks.map(t => [t.id, (t.truckNo ? '#' + t.truckNo.split(/[ ~(]/)[0] + ' ' : '') + [t.year, t.make, t.model].filter(Boolean).join(' ')]));
  const inAz = new Set((az || []).map(d => dupeName(d.name)));
  const named = at.drivers.filter(d => d.name);
  return { connected: true, azugaOk: !!az, dupes: dupeGroups(named), allTrucks: at.trucks.map(t => ({ id: t.id, label: truckLabel[t.id] })).sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true })),
    blank: at.drivers.filter(d => !d.name).map(d => ({ id: d.id, license: d.license, policy: d.policy, trucks: d.truckIds.map(id => truckLabel[id]).filter(Boolean) })),
    drivers: named.sort((a, b) => a.name.localeCompare(b.name)).map(d => ({
    id: d.id, name: d.name, license: d.license, state: d.state, policy: d.policy, notes: d.notes, pic: d.pic, status: d.status,
    trucks: d.truckIds.map(id => truckLabel[id]).filter(Boolean), truckIds: d.truckIds, inAzuga: inAz.has(dupeName(d.name)) })) };
}

// Same person entered twice: same name (ignoring case, dots, Jr/Sr) or same license number.
const dupeName = n => normName(n).replace(/[.,']/g, '').replace(/\s+(jr|sr|ii|iii|iv)$/, '');
const dupeLic = l => clean(l).toUpperCase().replace(/[^A-Z0-9]/g, '');
function dupeGroups(ds) {
  const parent = {}, find = x => parent[x] === x ? x : (parent[x] = find(parent[x]));
  ds.forEach(d => parent[d.id] = d.id);
  const seen = {};
  ds.forEach(d => ['n:' + dupeName(d.name), dupeLic(d.license).length >= 5 && 'l:' + dupeLic(d.license)].filter(Boolean).forEach(k => {
    if (seen[k]) parent[find(d.id)] = find(seen[k]); else seen[k] = d.id;
  }));
  const groups = {};
  ds.forEach(d => (groups[find(d.id)] = groups[find(d.id)] || []).push(d.id));
  return Object.values(groups).filter(g => g.length > 1);
}

// Merge duplicates into one record: copy trucks and any missing details onto the keeper, then delete the extras.
async function mergeDrivers(b) {
  const at = await atData(), byId = Object.fromEntries(at.drivers.map(d => [d.id, d]));
  const keep = byId[b.keepId], remove = (b.removeIds || []).map(id => byId[id]);
  if (!keep || !remove.length || remove.some(r => !r)) throw new Error('Those drivers were not found. Refresh and try again.');
  const group = dupeGroups(at.drivers.filter(d => d.name)).find(g => g.includes(keep.id));
  if (!group || remove.some(r => !group.includes(r.id) || r.id === keep.id)) throw new Error('Only records flagged as duplicates of each other can be merged.');
  const fields = { [D.trucks]: [...new Set([keep, ...remove].flatMap(d => d.truckIds))] };
  for (const k of ['license', 'state', 'policy', 'notes']) if (!keep[k]) { const v = remove.map(r => r[k]).find(Boolean); if (v) fields[D[k]] = v; }
  // Keep the Azuga link, or the two-way sync would add the deleted record straight back
  if (!keep.azId) { const r = remove.find(r => r.azId); if (r) { fields[D.azId] = r.azId; if (r.snap) fields[D.snap] = JSON.stringify(r.snap); } }
  if (!keep.phone) { const v = remove.map(r => r.phone).find(Boolean); if (v) fields[D.phone] = v; }
  if (!keep.pic.length) { const pics = remove.flatMap(r => r.pic); if (pics.length) fields[D.pic] = pics.map(p => ({ url: p.url, filename: p.name })); }
  await airtable(AT_DRIVERS + '/' + keep.id, { method: 'PATCH', body: JSON.stringify({ fields, typecast: true }) });
  await airtable(AT_DRIVERS + '?' + remove.map(r => 'records[]=' + r.id).join('&'), { method: 'DELETE' });
  cache.delete('airtable');
  console.log(new Date().toISOString(), 'Merged drivers into', keep.name, '- removed', remove.length);
  return { ok: true, kept: keep.name, removed: remove.length };
}

// Mark drivers Active / Inactive in Airtable (10 records per request is Airtable's limit).
async function setDriverStatus(b) {
  const status = b.status === 'Inactive' ? 'Inactive' : b.status === 'Active' ? 'Active' : null;
  if (!status) throw new Error('Status must be Active or Inactive.');
  const known = new Set((await atData()).drivers.map(d => d.id)), ids = [...new Set(b.ids || [])];
  if (!ids.length || ids.some(id => !known.has(id))) throw new Error('Some of those drivers were not found. Refresh and try again.');
  for (let i = 0; i < ids.length; i += 10)
    await airtable(AT_DRIVERS, { method: 'PATCH', body: JSON.stringify({ records: ids.slice(i, i + 10).map(id => ({ id, fields: { [D.status]: status } })) }) });
  cache.delete('airtable');
  console.log(new Date().toISOString(), 'Marked', ids.length, 'driver(s)', status);
  return { ok: true, count: ids.length, status };
}

// Only records with no name can be deleted outright (leftover blank rows).
// Delete a driver everywhere: every Azuga login they have, then the Airtable record.
// Both sides go, or the two-way sync would just add them back. Azuga first: if it refuses, nothing is deleted.
async function deleteDriver(b) {
  const at = await atData(), d = at.drivers.find(x => x.id === b.id);
  if (!d) throw new Error('Driver not found in Airtable. Refresh and try again.');
  if (normName(b.confirmName) !== normName(d.name)) throw new Error('Type the driver\'s name exactly to confirm.');
  for (let i = 0; SYNC.running && i < 120; i++) await sleep(1000);   // let a running sync finish first
  if (SYNC.running) throw new Error('A sync is still running. Try again in a minute.');
  SYNC.running = true;   // keeps the 5-minute sync from re-adding them halfway through
  try {
    const azp = await azPeopleList(true);
    const az = azp.find(p => d.azId && p.ids.includes(d.azId)) || (at.drivers.filter(x => normName(x.name) === normName(d.name)).length === 1 ? azp.find(p => normName(p.name) === normName(d.name)) : null);
    for (const id of az ? az.ids : []) {
      const r = await azuga('/users/' + encodeURIComponent(id) + '.json', {}, 'DELETE');
      if (azErr(r)) throw new Error('Azuga would not delete ' + d.name + ': ' + JSON.stringify(azErr(r)).slice(0, 200));
      await sleep(800);
    }
    await airtable(AT_DRIVERS + '?records[]=' + d.id, { method: 'DELETE' });
    cache.delete('airtable'); cache.delete('rawDrivers'); cache.delete('drivers'); cache.delete('vehicles');
    logSync('Deleted ' + d.name + ' from Airtable' + (az ? ' and Azuga (' + az.ids.length + ' login' + (az.ids.length > 1 ? 's' : '') + ')' : ''));
    return { ok: true, azuga: az ? az.ids.length : 0 };
  } finally { SYNC.running = false; }
}

async function deleteBlankDriver(b) {
  const d = (await atData()).drivers.find(d => d.id === b.id);
  if (!d) throw new Error('Record not found. Refresh and try again.');
  if (d.name) throw new Error('Only blank, unnamed records can be deleted here.');
  await airtable(AT_DRIVERS + '?records[]=' + d.id, { method: 'DELETE' });
  cache.delete('airtable');
  console.log(new Date().toISOString(), 'Deleted blank driver record', d.id);
  return { ok: true };
}

const EMAIL_OK = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Azuga requires an email login for every driver. When none is given we make a unique one from the
// office inbox with a "+" tag (callum+jane.doe@...), so Azuga mail about drivers lands with the office.
const DRIVER_EMAIL = process.env.DRIVER_EMAIL || 'callum@millennialpools.com';
function driverEmail(name) {
  const [local, domain] = DRIVER_EMAIL.split('@');
  const tag = clean(name).toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '').slice(0, 40) || 'driver';
  return local + '+' + tag + '@' + domain;
}
async function createAzugaDriver(name, email, phone) {
  const parts = clean(name).split(/\s+/);
  if (!parts[0]) throw new Error('Driver needs a name.');
  if (parts.length < 2) parts.push('.');  // Azuga needs a last name; it already uses "." for single names
  // Every driver gets the office email. Azuga's login name must be unique, so that stays a tagged version.
  email = clean(email).toLowerCase() || DRIVER_EMAIL;
  if (!EMAIL_OK.test(email)) throw new Error('That email address does not look right.');
  const login = driverEmail(name);
  if ((await drivers()).some(d => dupeName(d.name) === dupeName(name))) throw new Error(name + ' is already a driver in Azuga.');
  const digits = clean(phone).replace(/\D/g, '');
  if (digits && digits.length !== 10 && !(digits.length === 11 && digits[0] === '1')) throw new Error('Phone must be a 10-digit US number.');
  // Copy role, time zone and group from an existing Azuga driver so new ones are set up the same way.
  const tpl = (await rawDrivers())[0] || {};
  const vs = list(await routes['/api/vehicles']());
  const counts = {}; vs.forEach(v => v.groupId && (counts[v.groupId] = (counts[v.groupId] || 0) + 1));
  const groupId = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  if (!groupId) throw new Error('Could not find your Azuga group.');
  const body = {
    firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1], userName: login, email,
    timeZone: tpl.timeZone || 'US/Eastern',   // Azuga's own zone names; it rejects 'America/New_York'
    groupIds: [groupId], userTypeName: 'driver', emailVerification: false,
    // Random password, never shown; reset it in Azuga if the driver needs the Azuga app.
    // Azuga caps passwords at 15 characters: 14 here, with upper, lower, digit and symbol
    password: 'Mp!' + require('crypto').randomBytes(9).toString('base64url').slice(0, 9) + '7a',
  };
  if (tpl.roleId) body.roleId = tpl.roleId; else body.roleName = tpl.roleName || 'Driver';
  if (digits) body.primaryContactNumber = '+1-' + digits.slice(-10);
  let r = await azuga('/user/create.json', body);
  // If Azuga won't let two drivers share an email, fall back to the tagged one (still delivered to the same inbox).
  if (azErr(r) && /email/i.test(JSON.stringify(azErr(r))) && body.email !== login) { body.email = login; r = await azuga('/user/create.json', body); }
  if (azErr(r)) throw new Error('Azuga rejected the new driver: ' + JSON.stringify(azErr(r)).slice(0, 200));
  cache.delete('rawDrivers'); cache.delete('drivers');
  console.log(new Date().toISOString(), 'Azuga driver created', name);
  return r && r.data;
}

async function createDriver(b) {
  const name = text(b.name, 80, 'Name').replace(/\s+/g, ' ');
  if (!name) throw new Error('Driver name is required.');
  if (b.dob && !/^\d{4}-\d{2}-\d{2}$/.test(b.dob)) throw new Error('Date of birth must be a date.');
  if ((await atData()).drivers.some(d => normName(d.name) === normName(name))) throw new Error(name + ' is already in Airtable.');
  const fields = { [D.name]: name };
  const opt = { license: [D.license, 40], state: [D.state, 20], policy: [D.policy, 60], notes: [D.notes, 500] };
  for (const k in opt) if (clean(b[k])) fields[opt[k][0]] = text(b[k], opt[k][1], k);
  if (b.dob) fields[D_DOB] = b.dob;
  if (b.addToAzuga && clean(b.email) && !EMAIL_OK.test(clean(b.email))) throw new Error('That email address does not look right.');
  const photo = okPhoto(b.photo) ? b.photo : null;
  if (b.photo && !photo) throw new Error('The license photo must be a JPG, PNG or WEBP under 5 MB.');
  const rec = await airtable(AT_DRIVERS, { method: 'POST', body: JSON.stringify({ fields, typecast: true }) });
  if (photo) try { await uploadLicense(rec.id, name, photo); } catch (e) { console.error(e.message); }
  cache.delete('airtable');
  console.log(new Date().toISOString(), 'Airtable driver created', name);
  const saved = ['Airtable'];
  if (b.addToAzuga) {
    try { await createAzugaDriver(name, b.email, b.phone); saved.push('Azuga'); }
    catch (e) { return { ok: true, saved, warning: 'Saved to Airtable, but Azuga said: ' + e.message + ' Use "Add to Azuga" to try again.' }; }
  }
  return { ok: true, saved, id: rec.id };
}

// License photo goes straight into the record's License Picture field
async function uploadLicense(recId, name, photo) {
  const up = await fetch('https://content.airtable.com/v0/' + AT_BASE + '/' + recId + '/' + D.pic + '/uploadAttachment', {
    method: 'POST', headers: { Authorization: 'Bearer ' + AIRTABLE_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ contentType: photo.type, file: photo.data, filename: (name.replace(/[^a-z0-9]+/gi, '-') || 'driver') + '-license.jpg' }) });
  if (!up.ok) throw new Error('License photo upload failed (' + up.status + ').');
}
const okPhoto = p => p && /^image\/(jpeg|png|webp)$/.test(p.type) && typeof p.data === 'string' && p.data.length < 7e6;

async function updateDriver(b) {
  const at = await atData(), d = at.drivers.find(x => x.id === b.id);
  if (!d) throw new Error('Driver not found in Airtable. Refresh and try again.');
  const name = text(b.name, 80, 'Name').replace(/\s+/g, ' ');
  if (!name) throw new Error('Driver name is required.');
  if (at.drivers.some(x => x.id !== d.id && normName(x.name) === normName(name))) throw new Error('Another driver is already called ' + name + '.');
  if (b.dob && !/^\d{4}-\d{2}-\d{2}$/.test(b.dob)) throw new Error('Date of birth must be a date.');
  if (b.photo && !okPhoto(b.photo)) throw new Error('The license photo must be a JPG, PNG or WEBP under 5 MB.');
  const fields = { [D.name]: name };
  const opt = { license: 40, state: 20, policy: 60, notes: 500 };
  for (const k in opt) fields[D[k]] = text(b[k], opt[k], k) || null;  // blank clears it
  if (b.status === 'Active' || b.status === 'Inactive') fields[D.status] = b.status;
  if (Array.isArray(b.truckIds)) {
    const known = new Set(at.trucks.map(t => t.id)), ids = [...new Set(b.truckIds)];
    if (ids.some(id => !known.has(id))) throw new Error('One of those trucks is not in Airtable. Refresh and try again.');
    fields[D.trucks] = ids;
  }
  if (b.dob) fields[D_DOB] = b.dob;
  await airtable(AT_DRIVERS, { method: 'PATCH', body: JSON.stringify({ records: [{ id: d.id, fields }], typecast: true }) });
  if (b.photo) await uploadLicense(d.id, name, b.photo);
  cache.delete('airtable');
  console.log(new Date().toISOString(), 'Airtable driver updated', name);
  // Push to Azuga right away instead of waiting for the 5-minute sync
  try { const r = await reconcile(); return { ok: true, synced: true, notes: r.notes.filter(n => n.startsWith(name)) }; }
  catch (e) { return { ok: true, warning: 'Saved to Airtable. Azuga will be updated by the next automatic sync (' + e.message + ')' }; }
}

async function addDriverToAzuga(b) {
  const d = (await atData()).drivers.find(d => d.id === b.airtableId);
  if (!d) throw new Error('Driver not found in Airtable.');
  await createAzugaDriver(d.name, b.email, b.phone);
  return { ok: true, saved: ['Azuga'] };
}

// Push Airtable's values into Azuga for one truck.
async function syncOne(id) {
  const [vs, at] = await Promise.all([freshVehicles(), atData()]);
  const x = matchAll(vs, at.trucks)[id];
  if (!x || !x.truck) return { ok: true, skipped: 'Not linked to Airtable.' };
  const v = vs.find(v => v.trackeeId === id), d = await diffFor(v, x.truck);
  if (!Object.keys(d.changes).length) return { ok: true, skipped: 'Already matches Airtable.', notes: d.notes };
  const changed = await sendUpdate(await buildUpdate({ trackeeId: id, ...d.changes }, vs));
  return { ok: true, changed, notes: d.notes };
}

// ---- Last good copies, saved in Airtable's "Dashboard cache" table ----
const SNAP_TABLE = 'tblP2fdHIgRfQ5ALr', SNAP = { key: 'fldeMXs698nXAekLG', data: 'fldTJNze6zLAMfX9C', saved: 'fldSbBLNW7Wx0PZeK' };
function saveSnap(key, d, raw) {
  const json = raw ? d : JSON.stringify(d);
  if (!AIRTABLE_TOKEN) return;
  if (json.length > 95000) return console.error('Not saving', key, '- too big for Airtable (' + json.length + ' chars)');   // long text holds 100k
  airtable(SNAP_TABLE, { method: 'PATCH', body: JSON.stringify({ performUpsert: { fieldsToMergeOn: [SNAP.key] }, typecast: true,
    records: [{ fields: { [SNAP.key]: key, [SNAP.data]: json, [SNAP.saved]: new Date().toISOString() } }] }) })
    .catch(e => console.error('Saving', key, 'failed:', e.message));
}
async function loadSnaps() {
  const chunks = {};
  for (const r of await atAll(SNAP_TABLE, Object.values(SNAP))) {
    const key = r.fields[SNAP.key], c = cache.get(key) || {};
    if (key === 'events' || /^events#/.test(key)) { chunks[key] = r.fields[SNAP.data] || ''; continue; }
    if (!KEEP.has(key) || c.data !== undefined) continue;
    try { c.data = JSON.parse(r.fields[SNAP.data]); c.t = Date.parse(r.fields[SNAP.saved]) || 0; cache.set(key, c); } catch {}
  }
  try {
    const n = +chunks['events#n'] || 0, json = n ? Array.from({ length: n }, (_, i) => chunks['events#' + i] || '').join('') : chunks.events;
    if (json) { const a = unpackEvents(json); addEvents(a.list); EVA.weeks = [...new Set(EVA.weeks.concat(a.weeks))]; EVA.empty = Math.max(EVA.empty, a.empty); evaDirty = false; }
  } catch (e) { console.error('Saved camera history unreadable:', e.message); }
}
if (process.argv[2] !== 'test' && AIRTABLE_TOKEN) loadSnaps().then(() => console.log('Loaded last saved scores / Ramp spend')).catch(e => console.error('Loading saved copies failed:', e.message));

// ---------------- Azuga Driver Score (0-100, last 30 days) ----------------
// Azuga's own Scores report: an overall score plus a sub-score per behaviour and the event counts behind it.
const azIso = d => d.toISOString();   // Azuga's example: 2022-10-16T04:00:00.000Z
const scoreRows = () => cached('scores', 1800, async () => list(await azuga('https://services.azuga.com/reports/v3/reports/score?appId=FLEET',
  { startDate: azIso(daysAgo(30)), endDate: azIso(new Date()), browserTimezone: 'US/Eastern', reportFilter: 'default', index: 0, size: 500, desc: false, filter: { orFilter: {}, matchFilter: {} } }))
  .map(r => ({ userId: r.userId, firstName: r.firstName, lastName: r.lastName, vehicleId: r.vehicleId, score: r.score, distanceTravelled: r.distanceTravelled })));
const SCORE_PARTS = [   // [label, sub-score field, count field, what the count means]
  ['Phone use', 'distractedDrivingScore', 'distractedDrivingCount', 'distraction'],
  ['Speeding', 'speedingScore', 'overSpeedingCount', 'speeding'],
  ['Braking', 'brakingScore', 'hardBrakingCount', 'hard brake'],
  ['Acceleration', 'accelerationScore', 'hardAccelarationCount', 'hard start'],
  ['Cornering', 'corneringScore', 'corneringEventCount', 'sharp turn'],
  ['Idling', 'idlingScore', 'idlingEventCount', 'long idle'],
  ['Seatbelt', 'seatBeltScore', null, '']];
// Azuga's own score for this driver (or null), shown alongside ours for reference
async function azugaScore(vehicleId, name) {
  if (!(cache.get('scores') || {}).data) throw new Error('Miles not collected from Azuga yet' + (WARM.miles && WARM.miles.error ? ' (last try: ' + WARM.miles.error + ')' : ''));
  const rows = await scoreRows(), ids = new Set();
  if (name) (await driverGroups()).filter(g => dupeName(g.name) === dupeName(name)).forEach(g => g.ids.forEach(i => ids.add(String(i))));
  const nm = r => dupeName([r.firstName, r.lastName].filter(Boolean).join(' '));
  let mine = rows.filter(r => ids.has(String(r.userId)));
  if (!mine.length && name) mine = rows.filter(r => nm(r) === dupeName(name));
  if (!mine.length) mine = rows.filter(r => String(r.vehicleId) === String(vehicleId));
  const num = v => (v === null || v === undefined || v === '' || isNaN(+v)) ? null : +v;
  const r = mine.filter(x => num(x.score) !== null).sort((a, b) => (+b.distanceTravelled || 0) - (+a.distanceTravelled || 0))[0];
  return r ? { score: Math.round(+r.score), miles: mine.reduce((t, x) => t + (num(x.distanceTravelled) || 0), 0) } : null;
}

// ---------------- Millennial driver score: 100 minus points for camera events (last 30 days) ----------------
// Points per event, worst first. Anything else the camera flags costs 2; camera/system notices cost nothing.
const EVENT_POINTS = [
  ['Hard-core braking', /hard\s*-?\s*core\s*br[ae]a?k/, 10],
  ['Hard braking', /(hard|harsh)\s*br[ae]a?k/, 8],
  ['Critical distance', /critical\s*distance/, 8],
  ['Tailgating', /tailgat|following\s*distance/, 7],
  ['Violent turn', /violent\s*turn|harsh\s*turn|sharp\s*turn|corner/, 7],
  ['Rolling stop', /rolling\s*stop|stop\s*sign/, 6],
  ['Phone use', /phone|cell|distract/, 6],
  [null, /disconnect|tamper|power|obstruct|camera\s*(off|blocked)|sd\s*card|heartbeat/, 0]];
const REPEAT_DAYS = 3, REPEAT_POINTS = 5;          // same kind of event on 3+ different days: extra 5 off
const GAS_PER_MILE_MAX = 0.5, GAS_POINTS = 10;      // pickups run ~$0.20/mi; over $0.50/mi gets flagged
const eventKind = code => { const t = String(code || '').replace(/^CAM_/, '').replace(/_MESSAGE$/, '').replace(/_/g, ' ').toLowerCase();
  const hit = EVENT_POINTS.find(([, re]) => re.test(t));
  return hit ? { label: hit[0], pts: hit[2] } : { label: t.replace(/^./, c => c.toUpperCase()) || 'Other event', pts: 2 }; };
// 30 days of camera events, kept as an archive instead of one big Azuga pull (Azuga rate-limits that):
// every time the map fetches the fleet's last 7 days we add them in, and a slow backfill fetches the older weeks once.
// The archive is saved in "Dashboard cache" so it survives restarts.
const evTime = x => x.t || +(x.eventTime || x.startTime) || Date.parse(x.eventTime || x.startTime) || 0;
const EVA = { ev: {}, weeks: [], empty: 0 };   // ev: key -> trimmed event; weeks: older weeks backfilled (1 = 7-14 days ago ...); empty: run of empty weeks
let evaDirty = false;
function addEvents(list) {
  const old = Date.now() - 2 * 365 * 864e5; let changed = false;   // all time (anything older than 2 years is dropped)
  for (const x of list) {
    const t = evTime(x); if (!t || t < old || x.requested) continue;
    const k = [x.vehicleId, t, x.eventType].join('|');
    if (!EVA.ev[k]) { EVA.ev[k] = { vehicleId: x.vehicleId, t, eventType: x.eventType, firstName: x.firstName, lastName: x.lastName, driverName: x.driverName }; changed = true; }
  }
  for (const k in EVA.ev) if (EVA.ev[k].t < old) { delete EVA.ev[k]; changed = true; }
  if (changed) { evaDirty = true; cache.delete('fleetLost'); }
}
const events30 = async () => Object.values(EVA.ev);
// Saved compactly and split over several Airtable cells (each holds 100k characters)
function packEvents() {
  const vs = [], ty = [], nm = [], ix = (a, v) => { let i = a.indexOf(v); if (i < 0) { a.push(v); i = a.length - 1; } return i; };
  const e = Object.values(EVA.ev).map(x => [ix(vs, x.vehicleId), Math.round(x.t / 1000), ix(ty, x.eventType), ix(nm, [x.firstName || '', x.lastName || '', x.driverName || ''].join('|'))]);
  return JSON.stringify({ vs, ty, nm, e, weeks: EVA.weeks, empty: EVA.empty });
}
function unpackEvents(json) {
  const a = JSON.parse(json);
  if (a.ev) return { list: Object.values(a.ev), weeks: a.weeks || [], empty: 0 };   // older format
  return { weeks: a.weeks || [], empty: a.empty || 0, list: a.e.map(([v, t, y, n]) => { const [f, l, d] = (a.nm[n] || '||').split('|');
    return { vehicleId: a.vs[v], eventTime: t * 1000, eventType: a.ty[y], firstName: f, lastName: l, driverName: d }; }) };
}
function saveEvents() {
  const json = packEvents(), parts = [];
  for (let i = 0; i < json.length; i += 90000) parts.push(json.slice(i, i + 90000));
  parts.forEach((p, i) => saveSnap('events#' + i, p, true));
  saveSnap('events#n', String(parts.length), true);
}
setInterval(() => { if (evaDirty) { evaDirty = false; saveEvents(); } }, 5 * 60e3);   // save at most every 5 min
const backfillDone = () => EVA.empty >= 3 || EVA.weeks.length >= 52;
async function backfillWeek() {   // one older week per run, gently
  if (backfillDone()) return;
  let w = 1; while (EVA.weeks.includes(w)) w++;
  let got = 0;
  for (let page = 1; page <= 10; page++) {
    const p = list(await azuga('/eventVideos.json?videoType=eventVideo', { startTime: fmt(daysAgo(7 * (w + 1))), endTime: fmt(daysAgo(7 * w)), limit: 100, page }));
    addEvents(p); got += p.length; if (p.length < 100) break; await sleep(20000);
  }
  EVA.weeks.push(w); EVA.empty = got ? 0 : EVA.empty + 1; evaDirty = true;
}
const WARM = {};   // background job results, shown at /api/score/status
const HISTORY = { since: Date.now(), months: 1 };   // how far back the camera history goes
const CAP_EVENTS = 3;   // each kind of event counts at most 3 times (phone use: max -18), so one bad habit can't zero the score
// Points lost by every driver in the fleet (camera events, last 30 days), for capping and ranking
// Who an alert counts against: the truck's driver as Airtable has it (what the dashboard shows), else Azuga's
// assigned driver, else the name the camera stamped. The camera stamp is often wrong (a camera can be registered
// to someone else's login), so it is only the last resort.
const truckDrivers = () => cached('truckDrivers', 300, async () => {
  const [vs, at] = await Promise.all([routes['/api/vehicles']().then(list).catch(() => []), AIRTABLE_TOKEN ? atLinks().catch(() => ({ links: {} })) : { links: {} }]);
  const m = {};
  vs.forEach(v => { const L = at.links && at.links[v.trackeeId];
    m[v.trackeeId] = (L && L.linked && L.truck.driver && L.truck.driver.name) || v.userName || [v.userFirstName, v.userLastName].filter(Boolean).join(' '); });
  return m;
});
const camName = x => [x.firstName, x.lastName].filter(Boolean).join(' ').replace(/[ .]+$/, '') || x.driverName || '';
const eventOwner = (x, td) => clean(td[x.vehicleId]) || camName(x);
const fleetLost = () => cached('fleetLost', 300, async () => {
  const [evs, td] = await Promise.all([events30(), truckDrivers()]);
  const ppl = {};
  for (const x of evs) {
    const who = eventOwner(x, td), key = dupeName(who), k = eventKind(x.eventType);
    if (!key || !k.pts) continue;
    const pr = ppl[key] = ppl[key] || { name: who, by: {} };
    const b = pr.by[k.label] = pr.by[k.label] || { label: k.label, count: 0, each: k.pts, days: new Set() };
    const t = x.t || evTime(x);
    b.count++; if (t) b.days.add(new Date(t).toLocaleDateString('en-US', { timeZone: 'America/New_York' }));
  }
  // All time: each kind of alert counts up to 3 times per month of history, and each 3 days it happened on is a repeat (+5), up to once a month
  const oldest = evs.reduce((m, x) => Math.min(m, x.t || evTime(x) || Date.now()), Date.now()), months = Math.max(1, Math.ceil((Date.now() - oldest) / (30 * 864e5)));
  HISTORY.since = oldest; HISTORY.months = months;
  for (const pr of Object.values(ppl)) {
    pr.items = Object.values(pr.by).map(b => { const it = { label: b.label, count: b.count, each: b.each, days: b.days.size, cap: CAP_EVENTS * months, points: b.each * Math.min(b.count, CAP_EVENTS * months) };
      const reps = Math.min(months, Math.floor(it.days / REPEAT_DAYS)); if (reps) { it.points += REPEAT_POINTS * reps; it.repeat = reps; } return it; }).sort((a, b) => b.points - a.points);
    pr.lost = pr.items.reduce((t, b) => t + b.points, 0); delete pr.by;
  }
  return ppl;
});
async function scoreFor(vehicleId, name) {
  if (!Object.keys(EVA.ev).length && !EVA.weeks.length) throw new Error('Still collecting camera events from Azuga. Check back in a few minutes.');
  const ppl = await fleetLost();
  if (!name) { const v = list(await routes['/api/vehicles']()).find(x => x.trackeeId === vehicleId) || {}; name = v.userName || ''; }
  const me = ppl[dupeName(name)] || { items: [], lost: 0 };
  let azugaError = null;
  const az = await azugaScore(vehicleId, name).catch(e => { azugaError = e.message; return null; });
  let gas = null;   // Ramp gas vs miles driven
  if (name && az && az.miles > 50) try {
    const r = await rampFor(name);
    if (r.person && r.person.gas > 0) { const per = r.person.gas / az.miles; gas = { spend: r.person.gas, miles: az.miles, perMile: per, points: per > GAS_PER_MILE_MAX ? GAS_POINTS : 0 }; }
  } catch {}
  const lost = me.lost + (gas ? gas.points : 0);
  // Scored against the fleet: no points lost = 100, the worst driver this month = 40, everyone else in between
  const all = Object.values(ppl).map(p => p.lost), worst = Math.max(lost, ...all, 1);
  const score = Math.round(100 - 60 * lost / worst);
  const rank = 1 + all.filter(x => x < me.lost).length;
  const flags = [];
  { const td = await truckDrivers(), evs = await events30(), other = {};
    evs.filter(x => dupeName(eventOwner(x, td)) === dupeName(name)).forEach(x => { const c = camName(x); if (c && dupeName(c) !== dupeName(name)) other[c] = (other[c] || 0) + 1; });
    const n = Object.values(other).reduce((t, v) => t + v, 0);
    if (n) flags.push(n + ' of these alerts were stamped by the camera as ' + Object.keys(other).slice(0, 3).join(', ') + '. They count for ' + name + ' because Airtable lists them as the driver of that truck. If someone else was driving that day, the score is too low.'); }
  if (!backfillDone()) flags.push('Older camera history is still loading from Azuga, so this score may change over the next couple of hours.');
  if (gas && gas.points) flags.push('The gas-per-mile penalty uses Ramp gas spending, which can include gas for other trucks, equipment or gas cans.');
  return { found: true, flags, since: HISTORY.since, months: HISTORY.months, backfilling: !backfillDone(), score, rank, of: all.length + (ppl[dupeName(name)] ? 0 : 1), items: me.items, lost, gas, azuga: az && az.score, miles: az && az.miles, azugaError };
}
// ---------------- Miles per gallon from Azuga trip reports (last 30 days) ----------------
// Each trip reports its distance (km) and the fuel the engine used. When a truck doesn't report fuel,
// MPG is estimated from the driver's Ramp gas spending at GAS_PRICE dollars a gallon (default $4.30).
const GAS_PRICE = +process.env.GAS_PRICE || 4.3;   // NJ average, Oct 2026 (AAA)
const tripTotals = () => cached('trips', 3600, async () => {
  // A week at a time with the same request shape Azuga's own Scores report accepts (one 30-day ask gave Azuga a server error)
  const by = {};
  for (let w = 0; w < 5; w++) {
    for (let page = 0; page < 20; page++) {
      const rows = list(await azuga('https://services.azuga.com/reports/v3/reports/trip?appId=FLEET', { startDate: azIso(daysAgo(Math.min(30, 7 * (w + 1)))), endDate: azIso(daysAgo(7 * w)),
        browserTimezone: 'US/Eastern', reportFilter: 'trips_Default', index: page, size: 200, desc: false, filter: { orFilter: {}, matchFilter: {} } }));
      for (const r of rows) { const v = by[r.vehicleId] = by[r.vehicleId] || { km: 0, fuel: 0, trips: 0 }; v.km += +r.tripDistance || 0; v.fuel += +r.fuelConsumed || 0; v.trips++; }
      if (rows.length < 200) break; await sleep(15000);
    }
    await sleep(5000);
  }
  return by;
});
function withFlags(m, trucks) {
  const f = [];
  if (m.source === 'ramp') f.push('Estimated: this truck does not report its own fuel use, so gallons are guessed from Ramp gas spending at $' + m.price.toFixed(2) + '/gal. Gas bought for other trucks, equipment or cans, or at pricier stations, makes this look worse than it is.');
  if (m.litres) f.push('Azuga reported this truck\'s fuel in an unclear unit; it was read as litres because gallons gave an impossible MPG.');
  if (m.mpg < 10 || m.mpg > 35) f.push(m.mpg.toFixed(1) + ' mpg is unusual for a pickup (most get 15-25). Check for a fuel-sensor glitch or gas bought for another vehicle.');
  if (trucks.length > 1) f.push('Combines ' + trucks.length + ' trucks this driver is listed on in Airtable.');
  m.flags = f; return m;
}
async function mpgFor(name, rampPerson) {
  if (!name) return null;
  const trips = (cache.get('trips') || {}).data || {};   // filled by the background job; clicks never wait on Azuga for this
  const td = await truckDrivers(), mine = Object.keys(trips).filter(v => dupeName(td[v] || '') === dupeName(name));
  const km = mine.reduce((t, v) => t + trips[v].km, 0), fuel = mine.reduce((t, v) => t + trips[v].fuel, 0);
  let miles = km * 0.621371;
  if (miles < 20) {   // no trip data: use the miles from Azuga's Scores report and estimate gallons from Ramp
    const az = await azugaScore('', name).catch(() => null);
    if (!az || !(az.miles > 20) || !rampPerson || !(rampPerson.gas > 0)) return null;
    const g = rampPerson.gas / GAS_PRICE, m = az.miles / g;
    return m >= 4 && m <= 60 ? withFlags({ mpg: m, miles: az.miles, gallons: g, source: 'ramp', price: GAS_PRICE }, []) : null;
  }
  const ok = m => m >= 4 && m <= 60;
  if (fuel > 0) {   // Azuga's fuel figure: gallons, or litres on some devices
    if (ok(miles / fuel)) return withFlags({ mpg: miles / fuel, miles, gallons: fuel, source: 'azuga' }, mine);
    if (ok(miles / (fuel / 3.78541))) return withFlags({ mpg: miles / (fuel / 3.78541), miles, gallons: fuel / 3.78541, source: 'azuga', litres: true }, mine);
  }
  if (rampPerson && rampPerson.gas > 0) { const g = rampPerson.gas / GAS_PRICE, m = miles / g; if (ok(m)) return withFlags({ mpg: m, miles, gallons: g, source: 'ramp', price: GAS_PRICE }, mine); }
  return null;
}

// ---------------- Breadcrumbs (Azuga) and time spent at each pool ----------------
async function trailRange(id, start, end, past) {
  const key = 'trail:' + id + ':' + Math.round(+start / 6e4) + ':' + (past ? Math.round(+end / 6e4) : 'now');
  return cached(key, past ? 6 * 3600 : 120, async () => {
    let pts = [];
    for (let page = 0; page < 6; page++) {
      const rows = list(await azuga('https://services.azuga.com/reports/v3/reports/breadcrumb?appId=FLEET', { startDate: azIso(start), endDate: azIso(end), browserTimezone: 'US/Eastern',
        index: page, size: 1000, desc: false, sortField: 'locationTimeInDTZ', filter: { orFilter: { vehicleId: [id] } } }));
      pts = pts.concat(rows); if (rows.length < 1000) break; await sleep(1500);
    }
    const t = x => { const v = x.locationTime ?? x.locationTimeInDTZ ?? x.time; return typeof v === 'number' ? v : Date.parse(v) || 0; };
    return pts.map(x => ({ lat: +x.latitude, lng: +x.longitude, t: t(x), mph: Math.round((+x.obdSpeed || +x.speed || 0) * 0.621371), addr: clean(x.address), ev: clean(x.eventName) }))
      .filter(p => p.lat && p.lng && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180).sort((a, b) => a.t - b.t);
  });
}
const miles = (a, b) => { const R = 3958.8, r = Math.PI / 180, dl = (b.lat - a.lat) * r, dn = (b.lng - a.lng) * r;
  return 2 * R * Math.asin(Math.sqrt(Math.sin(dl / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dn / 2) ** 2)); };
// POM addresses are sometimes off (or have no map pin), so: look close first (~500 ft), then widen (~0.3 mi),
// then fall back to Azuga's own street address for each breadcrumb (same street, house number within 100).
const AT_POOL_MI = [0.1, 0.3];
const SUFFIX = { road: 'rd', street: 'st', avenue: 'ave', av: 'ave', drive: 'dr', lane: 'ln', court: 'ct', place: 'pl', boulevard: 'blvd', circle: 'cir', terrace: 'ter', parkway: 'pkwy', highway: 'hwy', route: 'rt' };
const streetOf = a => { const m = String(a || '').toLowerCase().split(',')[0].replace(/[.#]/g, '').match(/^(\d+)[a-z]?\s+(.+)$/);
  return m ? { n: +m[1], st: m[2].split(/\s+/).map(w => SUFFIX[w] || w).join(' ') } : null; };
// Arrived = the first ignition-off (or first stop) at the property; left = the last breadcrumb there before driving away.
function visitAt(stop, pts) {
  const home = streetOf(stop.address), tests = [];
  if (stop.lat && stop.lng) for (const r of AT_POOL_MI) tests.push({ at: p => miles(p, stop) <= r, how: r > AT_POOL_MI[0] ? 'wide' : '' });
  if (home) tests.push({ at: p => { const x = streetOf(p.addr); return x && x.st === home.st && Math.abs(x.n - home.n) <= 100; }, how: 'addr' });
  for (const { at, how } of tests) {
    const runs = []; let run = null;
    for (const p of pts) { if (at(p)) { if (!run) runs.push(run = []); run.push(p); } else run = null; }
    const real = runs.filter(x => x[x.length - 1].t - x[0].t >= 2 * 60e3);
    if (!real.length) continue;
    const best = real.sort((a, b) => (b[b.length - 1].t - b[0].t) - (a[a.length - 1].t - a[0].t))[0];
    const off = best.find(p => /ignition\s*off|engine\s*off|stop/i.test(p.ev)) || best.find(p => p.mph === 0) || best[0];
    const leave = best[best.length - 1].t;
    const ft = stop.lat && stop.lng ? Math.round(Math.min(...best.map(p => miles(p, stop))) * 5280) : null;
    const kind = how === 'wide' && ft <= AT_POOL_MI[0] * 5280 ? '' : how;   // parked close, just stepped out of the small circle for a bit
    return { arrive: off.t, leave, mins: Math.max(0, Math.round((leave - off.t) / 6e4)), visits: real.length, ft, how: kind, wide: !!kind, parkedAt: off.addr, lat: off.lat, lng: off.lng };
  }
  return null;
}
async function visitsFor(name, ymd) {
  const { tech, stops } = await pomStopsFor(name, ymd);
  if (!tech) return { tech: null, date: ymd, stops: [] };
  const td = await truckDrivers(), trucks = Object.keys(td).filter(v => dupeName(td[v] || '') === dupeName(name));
  const d = etDay(new Date(ymd + 'T16:00:00Z')), past = ymd !== etDay().ymd;
  let pts = [];
  for (const v of trucks) pts = pts.concat(await trailRange(v, d.start, past ? d.end : new Date(), past).catch(() => []));
  pts.sort((a, b) => a.t - b.t);
  return { tech, date: ymd, trucks, points: pts.length, stops: stops.map(s => ({ ...s, visit: visitAt(s, pts) })) };
}

// ---------------- Pool Office Manager: today's pool stops for each tech ----------------
// Read-only. POM_API_KEY lives in Render. POM's backend is GraphQL; these are the same queries POM's own schedule uses.
const POM_GQL = process.env.POM_API_URL || 'https://backend.poolservicemanager.com/graphql';
let pomAuth = null;   // which header style POM accepted
async function pom(query, variables) {
  const key = clean(process.env.POM_API_KEY);
  if (!key) throw new Error('Pool Office Manager is not connected (add POM_API_KEY in Render).');
  const styles = pomAuth ? [pomAuth] : ['bearer', 'x-api-key', 'both'];
  let last = '';
  for (const st of styles) {
    const h = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (st !== 'x-api-key') h.Authorization = 'Bearer ' + key;
    if (st !== 'bearer') h['x-api-key'] = key;
    const r = await fetch(POM_GQL, { method: 'POST', headers: h, body: JSON.stringify({ query, variables }) });
    const j = await r.json().catch(() => ({}));
    const err = (j.errors || []).map(e => e.message).join('; ');
    if (r.ok && j.data && !/unauth|forbidden|not authenticated|invalid.*(key|token)/i.test(err)) { pomAuth = st; if (err) console.error('POM partial:', err); return j.data; }
    last = r.status + ' ' + (err || JSON.stringify(j).slice(0, 160));
    if (pomAuth) break;
  }
  throw new Error('Pool Office Manager said: ' + last);
}
const POM_STOP_FIELDS = `id date duration status pinned primaryWorker { id firstName lastName } workers { id firstName lastName primary }
  serviceType { id display } serviceStatus { id name } customer { id firstName lastName streetAddress city state zipCode latitude longitude }`;
// Midnight-to-midnight today in New Jersey time
function etDay(d = new Date()) {
  const ymd = d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const off = -parseInt((new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' }).formatToParts(new Date(ymd + 'T12:00:00Z')).find(x => x.type === 'timeZoneName') || {}).value.replace('GMT', '') || '-5', 10);   // hours behind UTC: 4 or 5
  const start = new Date(ymd + 'T00:00:00Z'); start.setUTCHours(off);
  return { ymd, start, end: new Date(+start + 864e5 - 1) };
}
const pomToday = () => pomDay(etDay().ymd);
const pomDay = ymd => cached('pom:' + ymd, ymd === etDay().ymd ? 120 : 3600, async () => {   // past days don't change much
  const { start, end } = etDay(new Date(ymd + 'T16:00:00Z')), out = [];
  let after = null;
  for (let page = 0; page < 10; page++) {
    const d = await pom(`query($selector: AppointmentsV2Selector, $first: Int, $after: String) { infiniteAppointmentsV2(selector: $selector, first: $first, after: $after) {
      edges { node { ${POM_STOP_FIELDS} } } pageInfo { endCursor hasNextPage } } }`,
      { selector: { startDate: start.toISOString(), endDate: end.toISOString(), includePinned: true }, first: 200, after });
    const c = d.infiniteAppointmentsV2 || {};
    (c.edges || []).forEach(e => e && e.node && out.push(e.node));
    if (!c.pageInfo || !c.pageInfo.hasNextPage) break;
    after = c.pageInfo.endCursor;
  }
  return out;
});
const pomDone = a => /complet|done|finish|serviced|closed/i.test(String(a.status || '') + ' ' + (a.serviceStatus && a.serviceStatus.name || ''));
const pomStop = a => { const c = a.customer || {}, w = a.primaryWorker || (a.workers || []).find(x => x.primary) || (a.workers || [])[0] || {};
  return { id: a.id, time: a.date, mins: a.duration, status: a.status, serviceStatus: a.serviceStatus && a.serviceStatus.name, done: pomDone(a),
    type: a.serviceType && a.serviceType.display, tech: [w.firstName, w.lastName].filter(Boolean).join(' '),
    customer: [c.firstName, c.lastName].filter(Boolean).join(' '), address: [c.streetAddress, c.city, c.state].filter(Boolean).join(', '),
    lat: +c.latitude || null, lng: +c.longitude || null }; };
// Tech names in POM may be spelled a little differently from Airtable (DiMaio / Dimeo): same matching rules as Ramp
async function pomStopsFor(name, ymd) {
  const stops = (await (ymd ? pomDay(ymd) : pomToday())).map(pomStop), techs = [...new Set(stops.map(s => s.tech).filter(Boolean))].map(n => ({ name: n }));
  const m = rampMatch(techs, name) || techs.find(t => { const a = dupeName(t.name).split(' '), b = dupeName(name).split(' ');
    return a[0] && b[0] && a[0].slice(0, 3) === b[0].slice(0, 3) && near(a[a.length - 1], b[b.length - 1]); });
  return { tech: m ? m.name : null, stops: m ? stops.filter(s => s.tech === m.name).sort((x, y) => Date.parse(x.time) - Date.parse(y.time)) : [] };
}

// ---------------- Ramp: each driver's card spend over the last 30 days ----------------
// Needs RAMP_CLIENT_ID / RAMP_CLIENT_SECRET (a Ramp developer app with transactions:read, reimbursements:read, users:read) in Render.
const { RAMP_CLIENT_ID, RAMP_CLIENT_SECRET } = process.env;
let rampTok, rampExp = 0, rampScopes = '';
// Asks for all three permissions; if the Ramp app wasn't given one, falls back to fewer so the box still works.
const RAMP_SCOPES = ['transactions:read reimbursements:read users:read', 'transactions:read reimbursements:read', 'transactions:read'];
async function rampLogin() {
  let last = '';
  for (const scope of RAMP_SCOPES) {
    const r = await fetch('https://api.ramp.com/developer/v1/token', { method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(clean(RAMP_CLIENT_ID) + ':' + clean(RAMP_CLIENT_SECRET)).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope }).toString() });
    const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch {}
    if (j.access_token) { rampTok = j.access_token; rampExp = Date.now() + ((j.expires_in || 3600) - 300) * 1000; rampScopes = scope; return; }
    last = r.status + ' ' + (j.error_description || j.error || t).toString().slice(0, 160);
    if (r.status === 401) break;   // wrong ID/secret: fewer permissions won't help
  }
  throw new Error('Ramp login failed (' + last + '). ' + (/^401/.test(last) ? 'Check RAMP_CLIENT_ID and RAMP_CLIENT_SECRET in Render.' : 'Check the Ramp app has the transactions:read permission.'));
}
async function ramp(url) {
  if (!rampTok || Date.now() > rampExp) await rampLogin();
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + rampTok, Accept: 'application/json' } });
  if (r.status === 401 || r.status === 403) rampTok = null;   // log in again next time (picks up permissions added in Ramp)
  if (!r.ok) throw new Error('Ramp ' + r.status + ' on ' + new URL(url).pathname.split('/').pop() + ': ' + (await r.text()).slice(0, 160));
  return r.json();
}
const isGas = t => t.sk_category_id === 18 || /fuel|gas/i.test(t.sk_category_name || '');   // Ramp's "Fuel and Gas" category
// Reimbursements carry no category, so gas is spotted by the merchant or memo ("Wawa", memo "Gas")
const GAS_WORDS = /\bgas\b|fuel|fill[\s-]?ups?\b|wawa|sunoco|shell|exxon|mobil|\bbp\b|speedway|valero|citgo|lukoil|gulf|getty|royal farms|sheetz|quick ?chek|costco gas/i;
async function rampAll(path, q) {   // every page of a Ramp list
  let url = 'https://api.ramp.com/developer/v1/' + path + '?' + new URLSearchParams({ page_size: '100', ...q }), out = [], pages = 0;
  while (url && pages++ < 50) { const j = await ramp(url); out = out.concat(j.data || []); url = j.page && j.page.next; }
  return out;
}
const rampSpend = () => cached('ramp', 900, async () => {
  const since = new Date(Date.now() - 30 * 864e5), by = {};
  // Strictly the last 30 days by the date of the purchase itself (Ramp's from_date is checked again here)
  const add = (name, amt, gas, when) => { name = clean(name); const t = Date.parse(when || ''); if (!name || !amt || !(t >= +since)) return;
    const p = by[normName(name)] = by[normName(name)] || { name, gas: 0, other: 0, gasN: 0, otherN: 0, daily: Array(30).fill(0) };
    if (gas) { p.gas += amt; p.gasN++; p.daily[Math.min(29, Math.max(0, 29 - Math.floor((Date.now() - t) / 864e5)))] += amt; } else { p.other += amt; p.otherN++; } };
  const money = a => typeof a === 'number' ? a : Number(a && a.amount) / 100 || 0;
  for (const t of await rampAll('transactions', { from_date: since.toISOString() })) {
    if (/DECLINED|ERROR/i.test(t.state || '')) continue;
    const h = t.card_holder || {};
    add([h.first_name, h.last_name].filter(Boolean).join(' '), money(t.amount), isGas(t), t.user_transaction_time || t.settlement_date || t.created_at);
  }
  // Out-of-pocket gas is a big share, so reimbursements count too (skipped if the Ramp app can't read them)
  if (/reimbursements/.test(rampScopes)) try {
    const users = Object.fromEntries((/users/.test(rampScopes) ? await rampAll('users', {}).catch(() => []) : []).map(u => [u.id, [u.first_name, u.last_name].filter(Boolean).join(' ')]));
    for (const r of await rampAll('reimbursements', { from_date: since.toISOString() })) {
      if (/REJECT|CANCEL|DRAFT/i.test(r.state || r.status || '')) continue;
      add(users[r.user_id] || r.user_full_name || '', money(r.amount), GAS_WORDS.test((r.merchant || r.merchant_name || '') + ' ' + (r.memo || '')), r.transaction_date || r.created_at);
    }
  } catch (e) { console.error('Ramp reimbursements:', e.message); }
  return { since: since.toISOString(), people: Object.values(by), scopes: rampScopes, v: 2 };
});
// Ramp names don't always match Airtable ("Josh" vs "Joshua", "Aidan" vs "Aiden", "Jostin Acosta" vs "Jostin Acosta Palacios"):
// exact name first, else the one cardholder with the same (or one-letter-off) last name and a matching first name.
const NICK = [['jack', 'john'], ['jim', 'james'], ['bill', 'william'], ['bob', 'robert'], ['mike', 'michael'], ['tony', 'anthony'], ['nate', 'nathaniel'], ['chris', 'christian']];
const sameFirst = (a, b) => a.slice(0, 3) === b.slice(0, 3) || NICK.some(([x, y]) => (a === x && b === y) || (a === y && b === x));
function rampMatch(people, name) {
  const want = normName(name).replace(/[.,]/g, '').replace(/\s+(jr|sr|ii|iii|iv)$/, ''), w = want.split(' ');
  const exact = people.find(p => normName(p.name) === want);
  if (exact || w.length < 2) return exact || null;
  const hits = people.filter(p => { const t = normName(p.name).split(' '), last = t[t.length - 1];
    return t.length > 1 && sameFirst(w[0], t[0]) && w.slice(1).some(x => x === last || (x.length >= 4 && near(x, last))); });
  return hits.length === 1 ? hits[0] : null;
}
async function rampFor(name) {
  if (!RAMP_CLIENT_ID || !RAMP_CLIENT_SECRET) return { connected: false };
  const c = cache.get('ramp'); if (c && c.data && c.data.v !== 2) cache.delete('ramp');   // old saved copy: refetch
  const d = await rampSpend(), p = name ? rampMatch(d.people, name) : null;
  return { connected: true, since: d.since, until: new Date().toISOString(), person: p, cardOnly: !/reimbursements/.test(d.scopes || '') };
}

// ================= Two-way sync: Azuga <-> Airtable =================
// Azuga doesn't record when something was edited, so each Airtable record keeps a "Sync snapshot"
// of the values both sides last agreed on. Whichever side no longer matches its snapshot is the one
// that changed, and its value is copied to the other side. Both changed in the same window: Airtable wins.
// A blank in Azuga never erases Airtable. VIN is the truck link key, so it is not synced here.
const digits10 = v => { const d = clean(v).replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : ''; };
const lc = v => clean(v).toLowerCase();
const TRUCK_SYNC = {   // key: [Azuga value, Airtable value, compare form]
  plate: [v => normPlate(v.licensePlateNo), t => normPlate(t.plate), x => x],
  year: [v => (Number(v.year) ? String(Number(v.year)) : ''), t => (Number(t.year) ? String(Number(t.year)) : ''), x => x],
  make: [v => clean(v.make), t => t.make, lc],
  model: [v => clean(v.model), t => t.model, lc],
};
const DRIVER_SYNC = { name: n => dupeName(n), phone: digits10, license: x => clean(x).toUpperCase().replace(/[\s-]/g, ''), state: x => clean(x).toUpperCase() };
// 'same' | 'toAt' (Azuga changed) | 'toAz' (Airtable changed)
function decide(a, t, base, norm) {
  const na = norm(a), nt = norm(t), nb = base == null ? undefined : norm(base);
  if (na === nt) return 'same';
  if (!na) return nt ? 'toAz' : 'same';   // Azuga blank: never erase Airtable; fill Azuga from it
  if (nb === undefined) return nt ? 'toAz' : 'toAt';  // no history: Airtable wins, but fill its blanks
  if (nt === nb) return 'toAt';
  return 'toAz';                           // Airtable changed (or both did: Airtable wins)
}
// Azuga drivers, one entry per person (the login used on the most trucks), with their raw record.
async function azPeopleList(fresh) {
  if (fresh) { cache.delete('rawDrivers'); cache.delete('drivers'); }
  const [raw, groups] = await Promise.all([rawDrivers(), driverGroups()]);
  const byId = Object.fromEntries(raw.map(u => [u.id, u]));
  return groups.map(g => {
    const u = byId[g.id] || {}, has = k => Object.prototype.hasOwnProperty.call(u, k);
    return { id: g.id, ids: g.ids, name: g.name, raw: u,
      phone: digits10(u.primaryContactNumber || u.phoneNumber || u.phone || u.mobileNumber),
      license: has('licenseNumber') ? clean(u.licenseNumber) : null,          // null = Azuga does not report it
      state: has('licenseIssuedState') ? clean(u.licenseIssuedState) : null };
  });
}
const splitName = n => { const p = clean(n).split(/\s+/); if (p.length < 2) p.push('.'); return { firstName: p.slice(0, -1).join(' '), lastName: p[p.length - 1] }; };
// Same change on every Azuga login the person has, so duplicate logins stay grouped as one person.
async function pushDriverToAzuga(az, vals, vs) {
  for (const id of az.ids) {
    const veh = vs.find(v => v.userId === id);
    const body = { userId: id, vehicleId: veh ? veh.trackeeId : '' };
    if ('name' in vals) Object.assign(body, splitName(vals.name));
    if ('phone' in vals && vals.phone) body.primaryContactNumber = '+1-' + vals.phone;
    const r = await azuga('/user/update.json', body, 'PATCH');
    if (azErr(r)) throw new Error('Azuga rejected the driver update: ' + JSON.stringify(azErr(r)).slice(0, 200));
    if (az.ids.length > 1) await sleep(800);
  }
}
const SYNC = { running: false, last: null, log: [] };
const logSync = (what) => { SYNC.log.unshift({ at: Date.now(), what }); SYNC.log.length = Math.min(SYNC.log.length, 60); console.log(new Date().toISOString(), 'SYNC', what); };
const atBatch = async (table, records, method = 'PATCH') => { for (let i = 0; i < records.length; i += 10) await airtable(table, { method, body: JSON.stringify({ records: records.slice(i, i + 10), typecast: true }) }); };

// One pass. mode 'import' = Azuga overwrites Airtable (the one-time first copy); otherwise two-way.
async function reconcile(mode) {
  if (!AIRTABLE_TOKEN) throw new Error('Airtable is not connected.');
  if (SYNC.running) throw new Error('A sync is already running. Try again in a minute.');
  SYNC.running = true;
  const res = { toAirtable: 0, toAzuga: 0, created: 0, notes: [], backup: [] };
  try {
    cache.delete('airtable'); cache.delete('fresh');
    const [at, vs, azp] = await Promise.all([atData(), freshVehicles(), azPeopleList(true)]);
    const imported = mode === 'import' || at.trucks.some(t => t.snap) || at.drivers.some(d => d.snap);
    if (!imported) { res.notes.push('Waiting for the first copy from Azuga.'); return res; }
    const imp = mode === 'import';

    // ---- Drivers: link each Azuga person to one Airtable record (by Azuga ID, else by unique name)
    const atPatch = [], atCreate = [];
    const byAzId = {}, linked = new Set(); at.drivers.forEach(d => d.azId && (byAzId[d.azId] = d));
    for (const az of azp) {
      let d = az.ids.map(i => byAzId[i]).find(Boolean);
      if (!d) {
        const same = at.drivers.filter(x => dupeName(x.name) === dupeName(az.name));
        if (same.length > 1) { res.notes.push(az.name + ' appears ' + same.length + ' times in Airtable; merge the duplicates in the Drivers tab so it can sync.'); continue; }
        d = same[0];
      }
      const azVals = { name: az.name, phone: az.phone, license: az.license, state: az.state };
      if (!d) {   // Azuga driver missing from Airtable: add them
        const f = { [D.name]: az.name, [D.azId]: az.id, [D.status]: 'Active' }, snap = { name: az.name };
        for (const k of ['phone', 'license', 'state']) if (azVals[k]) { f[D[k]] = azVals[k]; snap[k] = azVals[k]; }
        f[D.snap] = JSON.stringify(snap); atCreate.push({ fields: f }); res.created++; logSync('Added ' + az.name + ' to Airtable from Azuga'); continue;
      }
      linked.add(d.id);
      const f = {}, snap = { ...(d.snap || {}) }, toAz = {};
      if (d.azId !== az.id) f[D.azId] = az.id;
      for (const k in DRIVER_SYNC) {
        if (azVals[k] === null) continue;                       // Azuga does not report this field
        const a = azVals[k], t = k === 'phone' ? digits10(d.phone) : d[k];
        const how = imp ? (DRIVER_SYNC[k](a) && DRIVER_SYNC[k](a) !== DRIVER_SYNC[k](t) ? 'toAt' : 'same') : decide(a, t, d.snap ? d.snap[k] : undefined, DRIVER_SYNC[k]);
        if (how === 'toAt') { f[D[k]] = a; snap[k] = a; res.backup.push({ table: 'Drivers', id: d.id, who: d.name, field: k, was: t, now: a }); logSync(d.name + ': ' + k + ' "' + (t || '') + '" → "' + a + '" (from Azuga)'); }
        else if (how === 'toAz') { if (k !== 'license' && k !== 'state') toAz[k] = t; }   // Azuga won't take a license without issue/expiry dates, so licenses only flow Azuga → Airtable
        else if (DRIVER_SYNC[k](a) === DRIVER_SYNC[k](t)) snap[k] = t;
      }
      if (Object.keys(toAz).length) {
        try { await pushDriverToAzuga(az, toAz, vs); Object.assign(snap, toAz); res.toAzuga++; logSync(d.name + ': sent ' + Object.keys(toAz).join(', ') + ' to Azuga'); await sleep(1500); }
        catch (e) { res.notes.push(d.name + ': ' + e.message); }
      }
      if (JSON.stringify(snap) !== JSON.stringify(d.snap || {})) f[D.snap] = JSON.stringify(snap);
      if (Object.keys(f).length) { atPatch.push({ id: d.id, fields: f }); if (Object.keys(f).some(k => k !== D.snap && k !== D.azId)) res.toAirtable++; }
    }
    // Everyone active in Airtable gets an Azuga driver login (the next pass links the new login by name)
    const azNames = new Set(azp.map(p => dupeName(p.name)));
    let added = 0;
    for (const d of at.drivers) {
      if (!d.name || d.status === 'Inactive' || d.policy === 'Inactive' || linked.has(d.id) || azNames.has(dupeName(d.name))) continue;
      if (at.drivers.filter(x => dupeName(x.name) === dupeName(d.name)).length > 1) continue;  // duplicates: already noted above
      if (added >= 10) { res.notes.push('More drivers still need adding to Azuga; the next sync will continue.'); break; }
      try {
        await createAzugaDriver(d.name, '', digits10(d.phone)); added++; res.toAzuga++; azNames.add(dupeName(d.name));
        if (d.azId) atPatch.push({ id: d.id, fields: { [D.azId]: null } });   // old login was removed from Azuga
        logSync('Added ' + d.name + ' to Azuga as a driver'); await sleep(2000);
      } catch (e) { res.notes.push(d.name + ': could not add to Azuga (' + e.message + ')'); }
    }
    await atBatch(AT_DRIVERS, atPatch); if (atCreate.length) await atBatch(AT_DRIVERS, atCreate, 'POST');
    if (atPatch.length || atCreate.length) cache.delete('airtable');
    const at2 = atPatch.length || atCreate.length ? await atData() : at;
    const drvByAz = {}; at2.drivers.forEach(d => d.azId && (drvByAz[d.azId] = d));
    const primary = {}; azp.forEach(p => p.ids.forEach(i => (primary[i] = p.id)));

    // ---- Trucks (matched by VIN)
    const m = matchAll(vs, at2.trucks), tPatch = [];
    for (const v of vs) {
      const x = m[v.trackeeId]; if (!x || !x.truck) continue;
      const t = at2.trucks.find(y => y.id === x.truck.id), f = {}, snap = { ...(t.snap || {}) }, toAz = {}, after = {};
      for (const k in TRUCK_SYNC) {
        const [ga, gt, norm] = TRUCK_SYNC[k], a = ga(v), tv = gt(t);
        const how = imp ? (a && norm(a) !== norm(tv) ? 'toAt' : 'same') : decide(a, tv, t.snap ? t.snap[k] : undefined, norm);
        after[k] = how === 'toAt' ? a : tv || a;   // value once this sync is done
        if (how === 'toAt') { f[{ plate: F.plate, year: F.year, make: F.make, model: F.model }[k]] = a; snap[k] = a; res.backup.push({ table: 'Trucks', id: t.id, who: t.truckNo || t.vin, field: k, was: tv, now: a }); logSync('Truck ' + (t.truckNo || v.name) + ': ' + k + ' "' + (tv || '') + '" → "' + a + '" (from Azuga)'); }
        else if (how === 'toAz') {
          if (k === 'plate' && !PLATE_OK.test(tv)) res.notes.push('Truck ' + (t.truckNo || v.name) + ': Airtable plate "' + t.plate + '" is not a plate number, so it was not sent to Azuga.');
          else toAz[{ plate: 'licensePlateNo', year: 'year', make: 'make', model: 'model' }[k]] = tv;
        } else if (norm(a) === norm(tv)) snap[k] = tv;
      }
      // Assigned driver, compared as the person's main Azuga login
      const aD = primary[v.userId] || '', tD = t.driver && t.driver.azId ? primary[t.driver.azId] || '' : '';
      const dHow = imp ? (aD && aD !== tD ? 'toAt' : 'same') : decide(aD, tD, t.snap ? t.snap.driver : undefined, x => x);
      if (dHow === 'toAt') {
        const d = drvByAz[aD];
        if (d) { f[F.driver] = [d.id]; snap.driver = aD; res.backup.push({ table: 'Trucks', id: t.id, who: t.truckNo || t.vin, field: 'driver', was: t.driver ? t.driver.name : '', now: d.name }); logSync('Truck ' + (t.truckNo || v.name) + ': driver → ' + d.name + ' (from Azuga)'); }
        else res.notes.push('Truck ' + (t.truckNo || v.name) + ': its Azuga driver ' + ((azp.find(p => p.id === aD) || {}).name || '') + ' is not linked to an Airtable driver yet.');
      } else if (dHow === 'toAz') {
        if (tD) toAz.userId = tD; else if (t.driver) res.notes.push('Truck ' + (t.truckNo || v.name) + ': ' + t.driver.name + ' is not in Azuga yet.'); else toAz.userId = '';   // removed in Airtable
      } else if (aD === tD) snap.driver = aD;
      // Every truck is named "<year> <model> <driver>" in Azuga, e.g. "2026 Maverick Adam Salem"
      {
        const azName = (azp.find(p => p.id === aD) || {}).name || '';
        const who = dHow === 'toAt' ? ((drvByAz[aD] || {}).name || azName) : t.driver ? t.driver.name : dHow === 'toAz' ? '' : azName;   // the driver after this sync
        const want = [Number(after.year) || '', clean(after.model).replace(/\s+/g, ' '), clean(who)].filter(Boolean).join(' ');
        // Azuga names must be unique. If another truck still has this name (two trucks swapping drivers),
        // park this one on "<name> (2)" so the other can move; the next sync gives it the real name.
        const taken = vs.some(o => o.trackeeId !== v.trackeeId && lc(o.name) === lc(want));
        const target = taken ? want + ' (2)' : want;
        if (clean(v.name) !== target && !(taken && clean(v.name).startsWith(want))) toAz.name = target;
      }
      if (Object.keys(toAz).length) {
        const oldName = clean(v.name);
        try { await sendUpdate(await buildUpdate({ trackeeId: v.trackeeId, ...toAz }, vs)); if (toAz.name) logSync('Renamed "' + oldName + '" → "' + toAz.name + '" in Azuga'); if ('userId' in toAz && !toAz.userId) logSync('Truck ' + (toAz.name || v.name) + ': driver removed in Azuga (none in Airtable)'); if (toAz.userId) logSync('Truck ' + (t.truckNo || toAz.name || v.name) + ': driver sent to Azuga'); Object.assign(snap, Object.fromEntries(Object.entries(toAz).map(([k, val]) => [{ licensePlateNo: 'plate', userId: 'driver' }[k] || k, String(val)]))); res.toAzuga++; await sleep(1500); }
        catch (e) { res.notes.push('Truck ' + (t.truckNo || v.name) + ': ' + e.message); }
      }
      if (JSON.stringify(snap) !== JSON.stringify(t.snap || {})) f[F.snap] = JSON.stringify(snap);
      if (Object.keys(f).length) { tPatch.push({ id: t.id, fields: f }); if (Object.keys(f).some(k => k !== F.snap)) res.toAirtable++; }
    }
    await atBatch(AT_TRUCKS, tPatch);
    cache.delete('airtable'); cache.delete('vehicles');
    return res;
  } finally {
    SYNC.running = false;
    SYNC.last = { at: Date.now(), mode: mode || 'auto', toAirtable: res.toAirtable, toAzuga: res.toAzuga, created: res.created, notes: res.notes.slice(0, 30) };
  }
}
// Every 5 minutes while the server is awake
const autoSync = () => reconcile().catch(e => { if (!/already running/.test(e.message)) { SYNC.last = { at: Date.now(), error: e.message }; console.error('Sync failed:', e.message); } });
// Driver scores: build them in the background (after the first sync settles) so clicking a truck never waits on Azuga
// Each job runs on its own: after a success again in 31 min (just past the 30-min cache), after a failure in 3 min.
if (process.argv[2] !== 'test') {
  const job = (name, fn) => { const run = () => fn().then(() => { WARM[name] = { ok: new Date().toISOString() }; setTimeout(run, 31 * 60e3); },
    e => { WARM[name] = { error: e.message, at: new Date().toISOString() }; console.error('Score warm-up', name + ':', e.message); setTimeout(run, 3 * 60e3); }); return run; };
  setTimeout(job('miles', scoreRows), 90e3); setTimeout(job('trips', tripTotals), 2 * 60e3);
  const week = () => routes['/api/videos'](new URLSearchParams()).then(() => setTimeout(week, 10 * 60e3), () => setTimeout(week, 3 * 60e3));
  setTimeout(week, 45e3);
  const back = () => backfillWeek().then(() => { WARM.backfill = { ok: new Date().toISOString(), weeksBack: EVA.weeks.length, done: backfillDone() }; if (!backfillDone()) setTimeout(back, 2 * 60e3); },
    e => { WARM.backfill = { error: e.message, at: new Date().toISOString() }; setTimeout(back, 5 * 60e3); });
  setTimeout(back, 4 * 60e3);
}
if (process.argv[2] !== 'test' && AIRTABLE_TOKEN) { setTimeout(autoSync, 30e3); setInterval(autoSync, 5 * 60e3); }   // first pass soon after a restart/wake-up

async function readJson(req, max = 10000) {
  const parts = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > max) throw new Error('Request too large.'); parts.push(c); }
  return JSON.parse(Buffer.concat(parts).toString('utf8') || '{}');
}

if (process.argv[2] === 'test') {
  const s = fmt(new Date(2026, 0, 5, 13, 7, 9));
  if (s !== '2026-01-05 01:07:09 PM') throw new Error('fmt broken: ' + s);
  if (fmt(new Date(2026, 0, 5, 0, 0, 0)) !== '2026-01-05 12:00:00 AM') throw new Error('fmt midnight broken');
  (async () => {
    let calls = 0;
    const ok = () => (calls++, Promise.resolve('fresh'));
    await Promise.all([cached('t', 60, ok), cached('t', 60, ok)]);
    if (calls !== 1) throw new Error('cache did not share concurrent calls');
    cache.get('t').t = 0; // expire it
    const stale = await cached('t', 60, () => Promise.reject(new Error('429')));
    if (stale !== 'fresh') throw new Error('cache did not fall back to last good answer');
    await cached('x', 60, () => Promise.reject(new Error('boom'))).then(() => { throw new Error('should fail'); }, e => { if (e.message !== 'boom') throw e; });
    console.log('ok');
    process.exit(0);
  })();
} else {

const { DASHBOARD_PASSWORD } = process.env;

// ================= Driver score reports + share links =================
// A share link is signed with the dashboard password (or SHARE_SECRET), so anyone with the link can view that one
// read-only report without logging in, and nobody can make a link to anything else. Links expire after 30 days;
// changing the password cancels every link ever shared.
const crypto = require('crypto');
const SHARE_DAYS = 30;
const shareKey = () => process.env.SHARE_SECRET || DASHBOARD_PASSWORD || '';
const signShare = obj => { const b = Buffer.from(JSON.stringify({ ...obj, x: Date.now() + SHARE_DAYS * 864e5 })).toString('base64url');
  return b + '.' + crypto.createHmac('sha256', shareKey()).update(b).digest('base64url').slice(0, 32); };
function readShare(tok) {
  const [b, sig] = String(tok || '').split('.');
  if (!b || !sig || !shareKey()) return null;
  const good = crypto.createHmac('sha256', shareKey()).update(b).digest('base64url').slice(0, 32);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  try { const o = JSON.parse(Buffer.from(b, 'base64url').toString()); return o.x > Date.now() ? o : null; } catch { return null; }
}
const H = v => String(v ?? '').replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';');
const usd = n => '$' + (+n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const grade = n => n >= 85 ? 'good' : n >= 70 ? 'ok' : 'bad';
const WHY = { 'Phone use': 'using a phone while driving', 'Hard-core braking': 'emergency-level braking', 'Hard braking': 'braking hard (often following too closely or not looking ahead)',
  'Critical distance': 'getting dangerously close to the vehicle in front', 'Tailgating': 'following too closely', 'Violent turn': 'taking turns too sharply', 'Rolling stop': 'rolling through stop signs instead of stopping' };
const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
// Plain-English reason for the score
function describe(r, name, of) {
  const first = String(name).split(' ')[0];
  const label = r.score >= 85 ? 'a good score' : r.score >= 70 ? 'a score that needs attention' : 'a poor score';
  const out = [first + ' scored ' + r.score + '/100, ' + label + (of > 1 ? ' (#' + r.rank + ' of ' + of + ' drivers).' : '.')];
  const items = r.items || [];
  if (!items.length && !(r.gas && r.gas.points)) { out.push('No safety alerts from the truck camera so far.'); return out.join(' '); }
  const [top, ...rest] = items;
  if (top) out.push('Most points were lost to ' + (WHY[top.label] || top.label.toLowerCase()) + ': ' + plural(top.count, 'alert') +
    (top.days > 1 ? ' on ' + top.days + ' different days' : '') + (top.repeat ? ', which makes it a repeat habit' : '') + '.');
  const more = rest.slice(0, 3).map(x => plural(x.count, x.label.toLowerCase() + ' alert'));
  if (more.length) out.push(first + ' also had ' + (more.length > 1 ? more.slice(0, -1).join(', ') + ' and ' + more.slice(-1) : more[0]) + '.');
  if (r.gas && r.gas.points) out.push('Gas spending was ' + usd(r.gas.perMile) + ' per mile (' + usd(r.gas.spend) + ' for ' + Math.round(r.gas.miles) + ' miles), above the ' + usd(GAS_PER_MILE_MAX) + ' limit; worth checking the fuel receipts.');
  return out.join(' ');
}
// Clip and photo links for one camera alert (same fields the dashboard uses)
function camMedia(x) {
  const videos = (x.videoLinks || []).flat().filter(v => v && v.videoLink).map(v => ({ name: v.videoName || (v.videoIndex === 2 ? 'Driver facing' : 'Road facing'), url: v.videoLink, poster: v.thumbnailLink || '' }));
  const snaps = (x.snapshotLinks || []).flat().filter(p => p && p.snapshotLink).map(p => ({ name: p.snapshotName || (p.snapshotIndex === 2 ? 'Driver facing' : 'Road facing'), url: p.snapshotLink }));
  snaps.sort((a, b) => /road/i.test(b.name) - /road/i.test(a.name));
  return videos.length || snaps.length ? { videos, snaps } : null;
}
// One driver's full picture
async function driverReport(name) {
  const r = await scoreFor('', name);
  const ppl = await people().catch(() => null), d = ppl && ppl.drivers ? ppl.drivers.find(x => dupeName(x.name) === dupeName(name)) : null;
  const ramp = await rampFor(name).catch(() => null);
  const td = await truckDrivers();
  const evs = (await events30()).filter(x => dupeName(eventOwner(x, td)) === dupeName(name))
    .sort((a, b) => b.t - a.t).slice(0, 15);
  const fleet = await fleetReport().catch(() => null), me = fleet && fleet.find(x => dupeName(x.name) === dupeName(name));   // rank against the same list as the fleet report
  if (me) r.rank = me.r.rank;
  const recent = list(await routes['/api/videos'](new URLSearchParams()).catch(() => [])), byKey = {};
  recent.forEach(x => { byKey[[x.vehicleId, evTime(x), x.eventType].join('|')] = x; });
  const mpg = await mpgFor(name, ramp && ramp.person).catch(() => null);
  return { mpg, name: d ? d.name : name, trucks: d ? d.trucks : [], score: r, why: describe(r, d ? d.name : name, me ? fleet.length : r.of), ramp: ramp && ramp.person,
    events: evs.map(x => { const full = byKey[[x.vehicleId, x.t, x.eventType].join('|')];
      return { t: x.t, kind: eventKind(x.eventType).label || 'Camera notice', media: full ? camMedia(full) : null, where: full ? clean(full.address || full.location || '') : '' }; }) };
}
// Everyone: active Airtable drivers plus anyone with camera alerts
async function fleetReport() {
  const ppl = await people().catch(() => ({ drivers: [] })), lost = await fleetLost();
  const names = new Map();
  (ppl.drivers || []).filter(d => d.status !== 'Inactive').forEach(d => names.set(dupeName(d.name), d));
  Object.values(lost).forEach(p => { if (!names.has(dupeName(p.name))) names.set(dupeName(p.name), { name: p.name, trucks: [] }); });
  const rows = [];
  for (const d of names.values()) { const r = await scoreFor('', d.name).catch(() => null);
    if (r) { const rp = await rampFor(d.name).catch(() => null); rows.push({ name: d.name, trucks: d.trucks || [], r, mpg: await mpgFor(d.name, rp && rp.person).catch(() => null) }); } }
  rows.sort((a, b) => a.r.score - b.r.score || a.name.localeCompare(b.name));
  rows.forEach(x => { x.r.rank = 1 + rows.filter(y => y.r.score > x.r.score).length; x.why = describe(x.r, x.name, rows.length); });
  return rows;
}
const REPORT_CSS = `*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a;background:#eef6f9}
.wrap{max-width:900px;margin:0 auto;padding:24px 16px 48px}.top{display:flex;align-items:center;gap:12px;margin-bottom:18px}.logo{width:40px;height:40px;border-radius:10px;background:linear-gradient(135deg,#0891b2,#0e7490);display:grid;place-items:center;color:#fff;font-weight:800}
.top h1{font-size:20px;margin:0}.top p{margin:0;color:#64748b;font-size:13px}.card{background:#fff;border-radius:16px;padding:20px;box-shadow:0 2px 10px rgba(15,23,42,.06);margin-bottom:16px;overflow-x:auto}
.score{display:inline-flex;align-items:baseline;gap:2px;font-weight:800;font-size:44px;line-height:1;padding:12px 18px;border-radius:14px}.score i{font-size:16px;font-style:normal;opacity:.6}
.good{background:#dcfce7;color:#15803d}.ok{background:#ffedd5;color:#c2410c}.bad{background:#fee2e2;color:#b91c1c}
.pill{display:inline-block;font-weight:700;font-size:13px;padding:3px 10px;border-radius:999px;min-width:46px;text-align:center}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:9px 8px;border-bottom:1px solid #e2e8f0;vertical-align:top}th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#64748b}
.why{color:#334155}.muted{color:#64748b;font-size:13px}.head{display:flex;gap:18px;align-items:center;flex-wrap:wrap}.head h2{margin:0;font-size:24px}
.flag{display:inline-grid;place-items:center;width:15px;height:15px;margin-left:5px;border-radius:50%;background:#fff7ed;color:#ea580c;font-size:9px;font-weight:700;cursor:help;vertical-align:middle;box-shadow:0 0 0 1px #fdba74;position:relative}
.flag:hover::after,.flag:focus::after{content:attr(data-tip);position:absolute;z-index:9;left:50%;bottom:calc(100% + 8px);transform:translateX(-50%);width:260px;background:#0f172a;color:#f8fafc;font-size:12px;font-weight:500;line-height:1.45;padding:8px 10px;border-radius:8px;white-space:pre-line;text-align:left}
.caps{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px}.caps figure{margin:0;background:#f1f5f9;border-radius:12px;overflow:hidden}
.caps video,.caps img{display:block;width:100%;aspect-ratio:16/9;object-fit:cover;background:#0f172a}.caps figcaption{padding:8px 10px;font-size:13px;display:grid;gap:2px}.caps figcaption span{color:#64748b;font-size:12px}
.ramp{background:#121212;color:#f4f4ef;border-radius:14px;padding:14px;display:grid;grid-template-columns:1fr 1fr;gap:10px}.ramp div{background:#1d1d1d;border-radius:10px;padding:10px 12px}.ramp .g{background:#e4f222;color:#111}.ramp b{display:block;font-size:22px}
.share{display:flex;gap:8px;flex-wrap:wrap;align-items:center;background:#ecfeff;border:1px solid #a5f3fc;border-radius:12px;padding:12px;margin-bottom:16px}.share input{flex:1;min-width:220px;font:inherit;font-size:13px;padding:8px;border:1px solid #cbd5e1;border-radius:8px}
button{font:inherit;font-weight:600;border:0;border-radius:8px;padding:8px 14px;background:#0e7490;color:#fff;cursor:pointer}button.alt{background:#e2e8f0;color:#0f172a}a{color:#0e7490}
@media print{.share{display:none}body{background:#fff}.card{box-shadow:none;border:1px solid #e2e8f0}}`;
const asOf = () => new Date().toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' });
function pageShell(title, body, shareUrl) {
  const share = shareUrl ? `<div class="share"><b>Share this report</b><input id="sl" readonly value="${H(shareUrl)}"><button onclick="navigator.clipboard.writeText(document.getElementById('sl').value);this.textContent='Copied'">Copy link</button><button class="alt" onclick="print()">Print / PDF</button><span class="muted">Anyone with the link can view it for ${SHARE_DAYS} days. No login needed.</span></div>` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${H(title)}</title><style>${REPORT_CSS}</style></head><body><div class="wrap">
<div class="top"><div class="logo">MP</div><div><h1>${H(title)}</h1><p>Millennial Pools fleet · score covers all camera history${HISTORY.since < Date.now() - 864e5 ? ' since ' + H(new Date(HISTORY.since).toLocaleDateString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium' })) : ''} · spend and mpg: last 30 days · as of ${H(asOf())}</p></div></div>${share}${body}
<p class="muted">Score: starts at 100 and loses points for truck camera alerts over all time (each kind counted up to 3 times per month of history, +5 for every 3 days it happens on) and for gas over ${usd(GAS_PER_MILE_MAX)} a mile. 100 = no points lost, 40 = worst in the fleet.</p></div></body></html>`;
}
const rflag = t => t && t.length ? `<span class="flag" tabindex="0" data-tip="${H([].concat(t).join('\n\n'))}">⚑</span>` : '';
const mpgLine = m => m ? `<p><b style="font-size:20px">${m.mpg.toFixed(1)} mpg${rflag(m.flags)}</b> <span class="muted">over ${Math.round(m.miles).toLocaleString()} miles in the last 30 days · ${m.source === 'azuga' ? 'from the truck’s fuel data' : 'estimated from Ramp gas at ' + usd(m.price) + '/gal'}</span></p>` : '';
function capsHtml(events, via) {
  const caps = events.filter(e => e.media).slice(0, 12);
  if (!caps.length) return '';
  const when = t => new Date(t).toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' });
  return `<div class="card"><h3 style="margin-top:0">Camera captures</h3><div class="caps">${caps.map(e => {
    const v = e.media.videos[0], shots = e.media.snaps;
    const main = v ? `<video controls preload="none" playsinline ${v.poster ? `poster="${H(via(v.poster))}"` : ''} src="${H(via(v.url))}"></video>`
      : `<a href="${H(via(shots[0].url))}" target="_blank" rel="noopener"><img loading="lazy" alt="${H(e.kind)} photo" src="${H(via(shots[0].url))}"></a>`;
    const more = (v ? shots : shots.slice(1)).slice(0, 3).map(p => `<a href="${H(via(p.url))}" target="_blank" rel="noopener">${H(p.name)}</a>`).join(' · ');
    return `<figure>${main}<figcaption><b>${H(e.kind)}</b><span>${H(when(e.t))}${e.where ? ' · ' + H(e.where) : ''}</span>${more ? `<span>${more}</span>` : ''}</figcaption></figure>`; }).join('')}</div>
<p class="muted">Clips and photos stay available from Azuga for about a week.</p></div>`;
}
function driverHtml(d, shareUrl, via) {
  const r = d.score, sc = `<span class="score ${grade(r.score)}">${r.score}<i>/100</i>${rflag(r.flags)}</span>`;
  const rows = (r.items || []).map(x => `<tr><td>${H(x.label)}</td><td>${x.count}${x.count > x.cap ? ` <span class="muted">(${x.cap} counted)</span>` : ''}</td><td>${x.days}</td><td>−${x.points}${x.repeat ? ' <span class="muted">incl. repeat</span>' : ''}</td></tr>`).join('')
    + (r.gas && r.gas.points ? `<tr><td>Gas per mile</td><td>${usd(r.gas.perMile)}/mi</td><td>–</td><td>−${r.gas.points}</td></tr>` : '');
  const g = d.ramp ? `<div class="card"><h3 style="margin-top:0">Ramp spend</h3><div class="ramp"><div class="g">Gas<b>${usd(d.ramp.gas)}</b>${plural(d.ramp.gasN, 'fill-up')}</div><div>Everything else<b>${usd(d.ramp.other)}</b>${plural(d.ramp.otherN, 'purchase')}</div></div>${r.gas ? `<p class="muted">${usd(r.gas.perMile)} per mile over ${Math.round(r.gas.miles)} miles driven.</p>` : ''}${mpgLine(d.mpg)}</div>` : (d.mpg ? `<div class="card">${mpgLine(d.mpg)}</div>` : '');
  const ev = d.events.length ? `<div class="card"><h3 style="margin-top:0">Recent camera alerts</h3><table><tr><th>When</th><th>Alert</th></tr>${d.events.map(e => `<tr><td>${H(new Date(e.t).toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' }))}</td><td>${H(e.kind)}</td></tr>`).join('')}</table></div>` : '';
  return pageShell(d.name + ' · driver report', `<div class="card"><div class="head">${sc}<div><h2>${H(d.name)}</h2><div class="muted">${H((d.trucks || []).join(', ') || 'No truck assigned')}${r.azuga != null ? ' · Azuga score ' + r.azuga : ''}</div></div></div>
<p class="why">${H(d.why)}</p>${rows ? `<table><tr><th>What</th><th>Count</th><th>Days</th><th>Points</th></tr>${rows}</table>` : ''}</div>${capsHtml(d.events, via)}${g}${ev}`, shareUrl);
}
function fleetHtml(rows, shareUrl, link) {
  const avg = rows.length ? Math.round(rows.reduce((t, x) => t + x.r.score, 0) / rows.length) : 0, low = rows.filter(x => x.r.score < 70).length;
  const body = `<div class="card"><div class="head"><span class="score ${grade(avg)}">${avg}<i>avg</i></span><div><h2>${rows.length} drivers</h2><div class="muted">${low} below 70 · lowest first</div></div></div></div>
<div class="card"><table><tr><th>Score</th><th>Driver</th><th>Why</th></tr>${rows.map(x => `<tr><td><span class="pill ${grade(x.r.score)}">${x.r.score}</span>${rflag(x.r.flags)}</td><td><b>${link ? `<a href="${H(link(x.name))}">${H(x.name)}</a>` : H(x.name)}</b><div class="muted">${H((x.trucks || []).join(', '))}</div>${x.mpg ? `<div class="muted"><b>${x.mpg.mpg.toFixed(1)} mpg</b>${rflag(x.mpg.flags)}</div>` : ''}</td><td class="why">${H(x.why)}</td></tr>`).join('')}</table></div>`;
  return pageShell('Driver score report', body, shareUrl);
}
// Every driver's score in one small call (for the chips on truck cards and in the Drivers list)
routes['/api/scores'] = () => cached('scoresAll', 300, async () => { if (!Object.keys(EVA.ev).length) return {};
  return Object.fromEntries((await fleetReport()).map(x => [dupeName(x.name), x.r.score])); });
async function serveReport(res, kind, name, base, publicView, tok) {
  const send = h => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' }); res.end(h); };
  try {
    const share = o => base + '/r/' + signShare(o);
    const via = u => publicView ? '/r/' + tok + '/m?u=' + encodeURIComponent(u) : '/api/media?u=' + encodeURIComponent(u);
    if (kind === 'driver') return send(driverHtml(await driverReport(name), publicView ? null : share({ k: 'd', n: name }), via));
    const rows = await fleetReport();
    return send(fleetHtml(rows, publicView ? null : share({ k: 'f' }), n => publicView ? share({ k: 'd', n }) : '/report?driver=' + encodeURIComponent(n)));
  } catch (e) { res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(pageShell('Report not ready', `<div class="card">${H(e.message)}</div>`)); }
}
// Azuga's camera storage only serves files to pages on azuga.com, so the server fetches them
// and passes them through. Locked to Azuga's recording bucket so it can't fetch anything else.
async function media(u, req, res) {
  let src; try { src = new URL(u); } catch { res.writeHead(400); return res.end(); }
  if (src.protocol !== 'https:' || !/^azuga-vmx-recording\.s3[\w.-]*\.amazonaws\.com$/.test(src.hostname)) { res.writeHead(403); return res.end(); }
  try {
    const h = { Referer: 'https://fleet-app.azuga.com/' };
    if (req.headers.range) h.Range = req.headers.range;  // lets videos seek
    const r = await fetch(src, { headers: h });
    const out = { 'Cache-Control': 'private, max-age=86400' };
    for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges']) if (r.headers.get(k)) out[k] = r.headers.get(k);
    res.writeHead(r.status, out);
    if (!r.body) return res.end();
    require('stream').Readable.fromWeb(r.body).on('error', () => res.destroy()).pipe(res);
  } catch (e) { console.error('Media failed:', e.message); res.writeHead(502); res.end(); }
}

http.createServer(async (req, res) => {
  const base = (req.headers['x-forwarded-proto'] || 'http') + '://' + (req.headers.host || 'localhost');
  if (req.url.startsWith('/r/')) {   // shared report: no login, but only with a valid signed link
    const [tok, sub] = req.url.slice(3).split('?')[0].split('/'), o = readShare(tok);
    if (!o) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('This report link is invalid or has expired. Ask for a new one.'); }
    if (sub === 'm') return media(new URL(req.url, 'http://x').searchParams.get('u'), req, res);   // camera clip/photo for this shared report (Azuga's bucket only)
    return serveReport(res, o.k === 'd' ? 'driver' : 'fleet', o.n, base, true, tok);
  }
  // Browser's built-in login box. Any username works; password must match.
  const given = Buffer.from((req.headers.authorization || '').split(' ')[1] || '', 'base64').toString().split(':').slice(1).join(':');
  if (!DASHBOARD_PASSWORD || given !== DASHBOARD_PASSWORD) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Fleet Dashboard"' });
    return res.end(DASHBOARD_PASSWORD ? 'Login required' : 'Set DASHBOARD_PASSWORD to use this dashboard');
  }
  const url = new URL(req.url, 'http://x');
  const POSTS = { '/api/sync/import': b => { if (b.confirm !== 'COPY') throw new Error('Confirmation missing.'); return reconcile('import'); }, '/api/sync/now': () => reconcile(), '/api/update': saveTruck, '/api/sync': b => syncOne(String(b.trackeeId || '')), '/api/driver/create': createDriver, '/api/driver/update': updateDriver, '/api/driver/remove': deleteDriver, '/api/driver/azuga': addDriverToAzuga, '/api/driver/merge': mergeDrivers, '/api/driver/delete': deleteBlankDriver, '/api/driver/status': setDriverStatus };
  if (POSTS[url.pathname]) {
    // JSON-only + POST-only, so another website can't trigger a change with a plain form
    if (req.method !== 'POST' || !/application\/json/.test(req.headers['content-type'] || '')) { res.writeHead(405); return res.end(); }
    try {
      const b = await readJson(req, /^\/api\/driver\/(create|update)$/.test(url.pathname) ? 8e6 : 10000);  // room for a license photo
      const out = await POSTS[url.pathname](b);
      res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(out));
    } catch (e) {
      console.error('Update failed:', e.message);
      res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: e.message }));
    }
  }
  if (url.pathname === '/api/media') return media(url.searchParams.get('u'), req, res);
  if (url.pathname === '/report') return serveReport(res, url.searchParams.get('driver') ? 'driver' : 'fleet', url.searchParams.get('driver'), base, false);
  const route = routes[url.pathname];
  if (!route) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(PAGE); }
  try {
    const data = await route(url.searchParams);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  } catch (e) {
    console.error(e.message);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}).listen(PORT, () => console.log('Fleet dashboard running on port ' + PORT));
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fleet Dashboard · Millennial Pools</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<link rel="stylesheet" href="https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css">
<script src="https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js"></script>
<style>
/* Millennial Pools fleet. Deep water + pool cyan on a warm deck. */
:root{
 --deck:#f4f1ea;--deck2:#ebe6db;--card:#fff;--line:#e4ded2;--line2:#d6cfc1;
 --ink:#10222e;--ink2:#3d4f5c;--muted:#5c6b75;
 --deep:#0a2c40;--deep2:#103a52;--pool:#0b7f9e;--poolInk:#075a71;--shallow:#e2f3f7;--shallow2:#c9e8f0;
 --go:#166534;--goDot:#16a34a;--goBg:#dcf5e3;--idle:#475569;--idleDot:#64748b;--idleBg:#eef0f0;
 --warn:#8a4b06;--warnDot:#d97706;--warnBg:#fdf0d5;--bad:#a1231f;--badBg:#fde4e1;
 --r:12px;--sh:0 1px 2px rgba(16,34,46,.06),0 1px 1px rgba(16,34,46,.04)}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;font-family:Figtree,system-ui,sans-serif;background:var(--deck);color:var(--ink);font-size:14px;line-height:1.45}
::selection{background:var(--shallow2);color:var(--ink)}
:focus-visible{outline:2px solid var(--pool);outline-offset:2px;border-radius:4px}
*{scrollbar-width:thin;scrollbar-color:var(--line2) transparent}
[hidden]{display:none!important}
.muted{color:var(--muted)}
.kv b,.pill,.t,td,.eli small,.sum b,.num{font-variant-numeric:tabular-nums}

/* Header */
header{background:var(--deep);color:#fff;padding:12px 24px;display:flex;align-items:center;gap:20px;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:11px;font-weight:700;font-size:16px;letter-spacing:-.01em}
.logo{width:34px;height:34px;border-radius:10px;background:var(--pool);display:grid;place-items:center}
.logo svg{width:22px;height:22px}
.brand small{display:block;font-weight:500;font-size:12px;color:#9cc3d3;letter-spacing:0}
.live{margin-left:auto;display:flex;align-items:center;gap:8px;font-size:13px;color:#cfe3ec}
.live .dot{width:8px;height:8px;border-radius:50%;background:#4ade80;box-shadow:0 0 0 0 rgba(74,222,128,.6);animation:pulse 2.4s ease-out infinite}
.live.down .dot{background:#f59e0b;animation:none}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(74,222,128,.55)}80%,100%{box-shadow:0 0 0 7px rgba(74,222,128,0)}}
.tabs{display:flex;gap:2px;background:var(--deep2);padding:3px;border-radius:10px}
.tabs button{font:inherit;font-weight:600;font-size:13px;color:#cfe3ec;background:none;border:0;padding:7px 14px;border-radius:8px;cursor:pointer;transition:background .15s,color .15s}
.tabs button:hover{color:#fff}.tabs button.on{background:#fff;color:var(--deep)}
#err{background:var(--badBg);color:var(--bad);padding:10px 24px;font-size:13px}
#err:empty{display:none}

/* Toolbar: search + filters */
.bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:14px 24px 0}
.search{position:relative;flex:0 1 320px;min-width:200px}
.search input{width:100%;font:inherit;padding:8px 12px 8px 34px;border:1px solid var(--line2);border-radius:9px;background:var(--card);color:var(--ink);outline:none;transition:border-color .15s,box-shadow .15s}
.search input:focus{border-color:var(--pool);box-shadow:0 0 0 3px var(--shallow2)}
.search svg{position:absolute;left:11px;top:50%;transform:translateY(-50%);color:var(--muted)}
.sum{display:flex;gap:6px;flex-wrap:wrap}
.sum button{font:inherit;font-size:13px;display:inline-flex;align-items:center;gap:7px;background:transparent;border:1px solid transparent;color:var(--ink2);padding:6px 11px;border-radius:999px;cursor:pointer;transition:background .15s,border-color .15s}
.sum button:hover{background:var(--deck2)}
.sum button[aria-pressed=true]{background:var(--card);border-color:var(--line2);color:var(--ink);box-shadow:var(--sh)}
.sum b{font-weight:700;color:var(--ink)}
.sum .dot{width:8px;height:8px;border-radius:50%}

/* Live map layout */
main{display:grid;grid-template-columns:390px 1fr;gap:14px;padding:12px 24px 24px;height:calc(100vh - 126px);min-height:560px}
#list{overflow:auto;background:var(--card);border-radius:var(--r);box-shadow:var(--sh)}
.card{display:flex;gap:11px;align-items:flex-start;padding:12px 14px;border-bottom:1px solid var(--line);cursor:pointer;transition:background .12s}
.card:last-child{border-bottom:0}.card:hover{background:#faf8f4}
.card.sel{background:var(--shallow)}
.av{flex:none;width:34px;height:34px;border-radius:50%;background:var(--shallow);color:var(--poolInk);display:grid;place-items:center;font-weight:700;font-size:12px}
.av.none{background:var(--deck2);color:var(--muted)}.av.none svg{width:17px;height:17px}

.ci{min-width:0;flex:1}
.ci .top{display:flex;justify-content:space-between;gap:8px;align-items:center}
.ci b{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mk{flex:none;display:inline-block;font-size:10.5px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;border-radius:5px;padding:2px 6px;margin-right:6px;vertical-align:1px;line-height:1.3;box-shadow:inset 0 -1px 0 rgba(0,0,0,.15);transition:transform .2s}
.card:hover .mk{transform:translateY(-1px) rotate(-2deg)}
.mk-ford{background:#1d4ed8;color:#fff}.mk-chevy{background:#eab308;color:#3b2f04}.mk-gmc{background:#b91c1c;color:#fff}.mk-nissan{background:#334155;color:#fff}
.mk-toyota{background:#e11d48;color:#fff}.mk-ram{background:#111827;color:#fff}.mk-honda{background:#64748b;color:#fff}.mk-jeep{background:#3f6212;color:#fff}.mk-other{background:var(--deck2);color:var(--ink2)}
.tno{flex:none;font-size:11px;font-weight:700;color:var(--poolInk);background:var(--shallow);border-radius:5px;padding:1px 6px;margin-right:6px}
.card.sel .tno{background:#fff}
.ci .d{font-size:13px;margin-top:1px;color:var(--ink2)}
.azn{display:block;font-size:11px;color:var(--muted);font-weight:400;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ci .a{color:var(--muted);font-size:12px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pill{flex:none;display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:600;padding:2px 9px;border-radius:999px;white-space:nowrap}
.pill.go{background:var(--goBg);color:var(--go)}.pill.idle{background:var(--idleBg);color:var(--idle)}
.pill.warn{background:var(--warnBg);color:var(--warn)}.pill.bad{background:var(--badBg);color:var(--bad)}
.pill .ic{width:12px;height:12px}
#right{display:grid;grid-template-rows:1fr;gap:14px;min-height:0}
#right.open{grid-template-columns:minmax(300px,34%) 1fr;grid-template-rows:minmax(240px,40%) 1fr;grid-template-areas:"donut map" "cams detail"}
#right:not(.open) #detail,#right:not(.open) .pane{display:none}
#right:not(.open) .bigbtn{display:none}
#right.open.min-cams{grid-template-areas:"donut map" "detail detail"}#right.open.min-donut{grid-template-areas:"map map" "cams detail"}#right.open.min-donut.min-cams{grid-template-areas:"map map" "detail detail"}#right.min-cams #cams,#right.min-cams .minb[data-min=cams],#right.min-donut #donut,#right.min-donut .minb[data-min=donut],main.min-list #list,main.min-list>.minb{display:none}main>#list{grid-area:1/1}main>#right{grid-area:1/2}main.min-list>#right{grid-area:1/1}main.min-list{grid-template-columns:1fr}.minb{z-index:5;justify-self:end;align-self:start;margin:8px 8px 0 0;width:26px;height:26px;border:0;border-radius:8px;background:var(--card);color:var(--muted);box-shadow:0 1px 3px rgba(15,23,42,.18);font:700 16px/1 system-ui;cursor:pointer;display:grid;place-items:center;transition:background .15s,color .15s,transform .15s}.minb:hover,.minb:focus-visible{background:#0c4a6e;color:#fff;transform:scale(1.08)}#right:not(.open) .minb{display:none}#dock{position:fixed;right:24px;bottom:18px;z-index:900;display:flex;gap:6px;padding:6px;border-radius:999px;background:rgba(12,74,110,.88);backdrop-filter:blur(8px);box-shadow:0 8px 24px rgba(12,74,110,.35);animation:dockin .35s cubic-bezier(.2,.8,.2,1)}#dock[hidden]{display:none}#dock button{border:0;border-radius:999px;padding:6px 12px;background:rgba(255,255,255,.14);color:#fff;font:600 12.5px system-ui;cursor:pointer;transition:background .15s}#dock button:hover,#dock button:focus-visible{background:rgba(255,255,255,.3)}@keyframes dockin{from{opacity:0;transform:translateY(16px)}}#donut .ph,#cams .ph{padding-right:30px}@media(max-width:900px){.minb{display:none!important}main>#list,main>#right{grid-area:auto!important}}
#right.open.big{grid-template-columns:1fr;grid-template-rows:1fr;grid-template-areas:"map"}#right.open.big>:not(#map){display:none}
#right.open #map{grid-area:map}#donut{grid-area:donut}#cams{grid-area:cams}#detail{grid-area:detail}
.pane{background:var(--card);border-radius:var(--r);box-shadow:var(--sh);padding:16px 18px;overflow:auto;min-height:0}
#cams h3{margin-top:0}#cams .evth{width:72px;height:44px}
#donut{display:flex;flex-direction:column}.dbody{flex:1;display:flex;gap:18px;align-items:center;min-height:0}#donut svg{flex:0 0 150px;width:150px}#donut .leg{flex:1;min-width:0}
#donut .arc{cursor:pointer;transition:opacity .15s}#donut .arc.dim{opacity:.18}
#donut .dn{font-size:30px;font-weight:700;text-anchor:middle;fill:var(--deep)}#donut .dl{font-size:12px;text-anchor:middle;fill:var(--muted)}
.leg{list-style:none;margin:0;padding:0}.leg button{display:grid;grid-template-columns:10px 1fr auto 34px;gap:8px;align-items:center;width:100%;min-height:30px;border:0;background:none;font:inherit;font-size:12.5px;text-align:left;padding:2px 6px;border-radius:7px;cursor:pointer;color:inherit}
.leg button:hover,.leg button.on{background:var(--shallow)}.leg button.dim{opacity:.45}.leg i{width:10px;height:10px;border-radius:3px}.leg em{font-style:normal;color:var(--muted);text-align:right}
.leg span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dclose{margin-left:8px;font:inherit;font-size:20px;line-height:1;color:var(--muted);background:none;border:0;cursor:pointer;padding:4px 8px;border-radius:8px}.dclose:hover{background:var(--deck)}
#map{border-radius:var(--r);box-shadow:var(--sh);background:#dfe7e6}
.leaflet-tile-pane{filter:saturate(1.05) contrast(1.02)}
#map{position:relative}
/* Truck pins: number labels, colored by status */
.tm{background:none;border:0}
.pin{position:absolute;left:0;top:0;transform:translate(-50%,-50%);display:grid;place-items:center;min-width:26px;height:26px;padding:0 6px;border-radius:13px;font:700 12px/1 Figtree,system-ui,sans-serif;color:#fff;background:var(--deep);border:2px solid #fff;box-shadow:0 2px 6px rgba(10,44,64,.35);white-space:nowrap;transition:transform .15s}
.pin svg{width:14px;height:14px}
.pin.mv{background:#16a34a}
.pin.mv::after{content:'';position:absolute;inset:-2px;border-radius:inherit;border:2px solid #16a34a;animation:ripple 2.2s cubic-bezier(.2,.7,.3,1) infinite}
.pin.sel{background:var(--pool);transform:translate(-50%,-50%) scale(1.25);z-index:2}
.tm:hover .pin{transform:translate(-50%,-50%) scale(1.12)}
/* Grouped trucks: a count bubble that splits apart as you zoom in */
.clu{position:absolute;left:0;top:0;transform:translate(-50%,-50%);display:grid;place-items:center;width:36px;height:36px;border-radius:50%;font:800 13px/1 Figtree,system-ui,sans-serif;color:#fff;background:var(--deep2);border:3px solid #fff;box-shadow:0 2px 8px rgba(10,44,64,.35);cursor:pointer;transition:transform .15s}
.clu.mv{box-shadow:0 0 0 3px #16a34a,0 2px 8px rgba(10,44,64,.35)}
.tm:hover .clu{transform:translate(-50%,-50%) scale(1.1)}
.legend{background:#fff;border-radius:10px;box-shadow:0 2px 8px rgba(16,34,46,.15);padding:8px 10px;font:12px/1.3 Figtree,system-ui,sans-serif;color:var(--ink2);display:flex;gap:12px;align-items:center}
.legend i{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:5px;vertical-align:-1px;border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.08)}
.legend button{font:inherit;font-weight:600;color:var(--poolInk);background:var(--shallow);border:0;border-radius:7px;padding:4px 9px;cursor:pointer}
.legend button:hover{background:var(--shallow2)}
.leaflet-container{font:inherit}
.leaflet-tooltip{font:inherit;font-size:12px;border-radius:7px;border:0;box-shadow:0 2px 8px rgba(16,34,46,.18)}
/* The one flourish: moving trucks ripple like a disturbance on water */
@keyframes ripple{0%{transform:scale(1);opacity:.9}100%{transform:scale(2.3);opacity:0}}
#detail{background:var(--card);border-radius:var(--r);padding:20px 22px;overflow:auto;box-shadow:var(--sh)}
.empty{color:var(--muted);display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;text-align:center;padding:24px;gap:4px}
.empty b{color:var(--ink);font-size:15px}
.dh{display:flex;align-items:center;gap:13px;margin-bottom:14px}
.dh h2{margin:0;font-size:19px;font-weight:700;letter-spacing:-.01em;display:flex;align-items:center;gap:8px}
.dh p{margin:2px 0 0;color:var(--muted)}
.grid{display:grid;grid-template-columns:repeat(4,1fr);border:1px solid var(--line);border-radius:10px;margin-bottom:12px}
.kv{padding:10px 14px;border-left:1px solid var(--line)}.kv:first-child{border-left:0}
.kv span{display:block;color:var(--muted);font-size:12px}.kv b{font-weight:600;font-size:15px}
.addr{display:flex;gap:6px;align-items:center;color:var(--ink2)}
h3{font-size:14px;font-weight:700;color:var(--ink);margin:22px 0 4px}
.ev{display:flex;align-items:center;gap:12px;padding:9px 0;border-top:1px solid var(--line);flex-wrap:wrap}
.ev:first-of-type{border-top:0}
.ev .t{color:var(--muted);font-size:13px;min-width:140px}.ev .clips{margin-left:auto;display:flex;gap:6px}
.evb{width:100%;font:inherit;text-align:left;background:none;border:0;border-top:1px solid var(--line);cursor:pointer;color:inherit;padding:10px 6px;border-radius:8px;flex-wrap:nowrap}
.ev.evb:first-of-type{border-top:0}.evb:hover:not(:disabled){background:#faf8f4}.evb:disabled{cursor:default}
.evth{position:relative;flex:none;width:96px;height:54px;border-radius:7px;overflow:hidden;background:var(--deck2);display:grid;place-items:center;font-size:11px;color:var(--muted)}
.evth img{width:100%;height:100%;object-fit:cover}
.evth i{position:absolute;inset:0;display:grid;place-items:center;background:rgba(10,44,64,.35);color:#fff}.evth i svg{width:22px;height:22px}
.evi{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1}.evi .pill{align-self:flex-start}
.evgo{flex:none;font-size:13px;font-weight:600;color:var(--poolInk)}
dialog#drvEd{border:0;border-radius:16px;padding:22px;width:min(760px,94vw);max-height:92vh;box-shadow:0 20px 60px rgba(10,44,64,.4);background:var(--card)}
dialog#drvEd::backdrop{background:rgba(10,30,45,.55)}#drvEd .fg .wide{grid-column:1/-1}
.deTrucks{margin-top:16px}.deth{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px}.deth input{font:inherit;font-size:13px;padding:6px 10px;border:1px solid var(--line2);border-radius:8px;width:200px}
#deTl{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:4px;max-height:180px;overflow:auto;border:1px solid var(--line);border-radius:10px;padding:8px}
#deTl label{display:flex;gap:8px;align-items:center;font-size:13px;padding:5px 6px;border-radius:7px;cursor:pointer}#deTl label:hover{background:var(--deck)}#deTl label.on{background:var(--shallow);font-weight:600}
.btn2.danger{color:var(--bad);border-color:#efc4bf;background:#fff}.btn2.danger:hover{background:var(--badBg)}
.btn2.dangerpri{background:var(--bad);color:#fff;border-color:var(--bad)}.btn2.dangerpri:disabled{opacity:.45;cursor:default}
.dedz{margin-top:14px;background:var(--badBg);border-radius:12px;padding:14px 16px;font-size:13px}.dedz b{color:var(--bad)}.dedz p{margin:4px 0 10px;color:var(--ink2)}
.dedz label{display:flex;flex-direction:column;gap:4px;font-weight:600;margin-bottom:10px}.dedz input{font:inherit;padding:8px 10px;border:1px solid #efc4bf;border-radius:8px;max-width:320px}
.deph{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:14px;font-size:13px}#dePrev{height:54px;border-radius:6px}
.rrow .edbtn{margin-right:12px}.rn b.nm{cursor:pointer}.rn b.nm:hover{color:var(--poolInk);text-decoration:underline}
dialog#media{border:0;border-radius:16px;padding:0;width:min(1000px,94vw);max-height:92vh;box-shadow:0 20px 60px rgba(10,44,64,.4);background:var(--card)}
dialog#media::backdrop{background:rgba(10,30,45,.6)}
#mbody{padding:18px 20px 20px}
.mhead{display:flex;align-items:flex-start;gap:12px;margin-bottom:12px}.mhead>div{flex:1}.mhead h3{margin:6px 0 2px;font-size:16px}.mhead p{margin:0;font-size:13px}
.mgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px}
.mgrid figure{margin:0}.mgrid img,.mgrid video{width:100%;border-radius:10px;background:#000;display:block;max-height:60vh;object-fit:contain}
.mgrid figcaption{font-size:12px;color:var(--muted);margin-top:5px}
.btn{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:12px;font-weight:600;color:var(--poolInk);background:var(--shallow);padding:5px 10px;border-radius:8px;text-decoration:none;transition:background .15s}
.btn:hover{background:var(--shallow2)}.ic{width:14px;height:14px;flex:none}
details{margin-top:22px}summary{cursor:pointer;color:var(--muted);font-size:12px}
details pre{font-size:11px;background:var(--deck);padding:10px;border-radius:8px;overflow:auto;max-height:260px}
.sk{background:linear-gradient(90deg,var(--deck) 25%,var(--deck2) 37%,var(--deck) 63%);background-size:400% 100%;animation:sk 1.4s ease infinite;border-radius:6px;height:11px;margin:6px 0}
@keyframes sk{0%{background-position:100% 50%}100%{background-position:0 50%}}

/* Airtable box */
.at{background:var(--shallow);border-radius:10px;padding:13px 15px;margin-top:14px;font-size:13px;color:var(--ink2)}
.at.off{background:var(--deck);color:var(--muted)}
.at h4{margin:0 0 9px;font-size:13px;font-weight:700;color:var(--poolInk)}
.at .kvs{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px 16px}
.at .kvs span{display:block;color:var(--muted);font-size:12px}.at .kvs div{color:var(--ink)}
.docs{display:flex;gap:6px;flex-wrap:wrap;margin-top:11px}.at .btn{background:#fff}.at .btn:hover{background:var(--shallow2)}
.lnk{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
.lnk select{font:inherit;flex:1 1 260px;padding:9px 11px;border:1px solid var(--line2);border-radius:9px;background:#fff;color:var(--ink)}
.fromAt{align-self:flex-start;display:inline-block;font-size:11px;font-weight:700;color:var(--poolInk);background:var(--shallow);border-radius:5px;padding:1px 6px;margin-left:6px}
.note{color:var(--warn);font-size:12px;margin-top:6px}

/* Panels, edit tab, drivers tab */
#vEdit,#vDrv{padding:14px 24px 24px}#vDrv{max-width:1240px;margin:0 auto}body[data-v=vDrv] .bar{max-width:1240px;margin:0 auto}
.panel{background:var(--card);border-radius:var(--r);box-shadow:var(--sh);overflow:auto}
.panel .intro{padding:16px 20px;border-bottom:1px solid var(--line);color:var(--muted)}.panel .intro b{color:var(--ink);font-size:15px}
.ed{display:grid;grid-template-columns:320px 1fr;gap:14px;height:calc(100vh - 140px);min-height:520px}
.edl{display:flex;flex-direction:column;min-height:0}
.edf{padding:12px 14px;border-bottom:1px solid var(--line);font-size:13px;color:var(--ink2)}
#edList{overflow:auto;flex:1}
.eli{padding:10px 14px;border-bottom:1px solid var(--line);cursor:pointer;display:flex;justify-content:space-between;gap:8px;align-items:center;transition:background .12s}
.eli:hover{background:#faf8f4}.eli.sel{background:var(--shallow)}.eli.sel b{color:var(--poolInk)}
.eli b{display:block;font-weight:600}.eli small{color:var(--muted)}
.edc{padding:22px 26px;overflow:auto}
.edh{display:flex;align-items:center;gap:12px;margin-bottom:4px}.edh h2{margin:0;font-size:20px;letter-spacing:-.01em}
.edh .pos{margin-left:auto;color:var(--muted);font-size:13px}
.miss{color:var(--warn);font-size:13px;margin-bottom:10px}
fieldset{border:0;padding:0;margin:20px 0 0}legend{font-size:14px;font-weight:700;color:var(--ink);margin-bottom:8px;padding:0}
.fg{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px}
.fg label{display:flex;flex-direction:column;gap:4px;font-size:12px;font-weight:600;color:var(--ink2)}
.fg input,.fg select{font:inherit;font-size:14px;font-weight:400;color:var(--ink);padding:9px 11px;border:1px solid var(--line2);border-radius:9px;background:#fff;transition:border-color .15s,box-shadow .15s}
.fg input:focus,.fg select:focus{outline:none;border-color:var(--pool);box-shadow:0 0 0 3px var(--shallow2)}
.fg input::placeholder{color:#8a969d}
.fg .dirty{background:#fffaeb;border-color:#e9b949}
.bang{display:inline-grid;place-items:center;flex:none;width:18px;height:18px;border-radius:50%;background:var(--warnBg);color:var(--warn);font-weight:800;font-size:12px;line-height:1;vertical-align:-3px;margin-left:6px}
.fg .need{border-color:#e9b949}
.fg label{position:relative}.fg label>.bang{position:absolute;right:10px;top:31px;margin:0;pointer-events:none}.fg label:has(select)>.bang{right:32px}.fg .hint{font-weight:400;color:var(--muted)}
.fg label.chk{flex-direction:row;align-items:center;gap:8px;padding-top:22px}
input[type=checkbox]{accent-color:var(--pool);width:15px;height:15px}
.edb{display:flex;gap:8px;align-items:center;margin-top:24px;padding-top:16px;border-top:1px solid var(--line);flex-wrap:wrap}
.btn2{font:inherit;font-weight:600;font-size:13px;border:1px solid var(--line2);background:#fff;color:var(--ink);padding:8px 14px;border-radius:9px;cursor:pointer;transition:background .15s,border-color .15s}
.btn2:hover:not(:disabled){background:var(--deck)}
.btn2.pri{background:var(--deep);color:#fff;border-color:var(--deep)}.btn2.pri:hover:not(:disabled){background:var(--deep2)}
.btn2:disabled{opacity:.45;cursor:default}
#edMsg{font-size:13px;margin-left:8px}#edMsg.ok{color:var(--go)}#edMsg.bad{color:var(--bad)}
table{width:100%;border-collapse:collapse}
th{text-align:left;font-size:12px;font-weight:600;color:var(--muted);padding:10px 14px;border-bottom:1px solid var(--line);white-space:nowrap;background:#fbfaf7}
td{padding:10px 14px;border-bottom:1px solid var(--line);vertical-align:top}
tbody tr:hover td{background:#fcfbf8}
/* Driver roster: one calm list */
.vopt{position:relative;margin-left:auto}body[data-v=vEdit] .vopt,body[data-v=vDrv] .vopt{display:none}
#voBtn{font:inherit;font-size:13px;font-weight:600;display:inline-flex;align-items:center;gap:7px;background:var(--card);border:1px solid var(--line2);color:var(--ink);padding:7px 12px;border-radius:999px;cursor:pointer;transition:transform .15s,box-shadow .15s}
#voBtn:hover{box-shadow:0 4px 14px -6px rgba(10,44,64,.35);transform:translateY(-1px)}
.vohid{font-size:11px;font-weight:700;background:var(--warnBg);color:var(--warn);border-radius:999px;padding:1px 7px}
.vopop{position:absolute;right:0;top:calc(100% + 8px);z-index:1200;width:290px;background:var(--card);border-radius:14px;padding:14px 16px;box-shadow:0 18px 40px -12px rgba(10,44,64,.4),0 0 0 1px rgba(10,44,64,.06);display:flex;flex-direction:column;gap:8px;font-size:13px;transform-origin:top right;animation:pop .18s cubic-bezier(.2,.9,.3,1.2)}
.vopop b{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-top:4px}.vopop label{display:flex;gap:8px;align-items:center;cursor:pointer}
.vopop select{font:inherit;padding:7px 9px;border:1px solid var(--line2);border-radius:8px;background:#fff}.vopop .link{align-self:flex-start;font-size:12px}
@keyframes pop{from{opacity:0;transform:scale(.92) translateY(-4px)}}
/* ---- Personality: things arrive, respond and breathe ---- */
header{position:relative;overflow:hidden}
.hwave{position:absolute;left:0;bottom:-1px;width:100%;height:58px;z-index:0;fill:rgba(20,163,199,.26);pointer-events:none}
@keyframes wave{to{transform:translateX(-50%)}}
.logo{animation:bob 4s ease-in-out infinite}@keyframes bob{50%{transform:translateY(-2px) rotate(-3deg)}}
.tabs button{transition:background .2s,color .2s,transform .15s}.tabs button:active{transform:scale(.95)}
.card.rise{animation:rise .45s cubic-bezier(.2,.8,.2,1) both;animation-delay:calc(var(--i) * 35ms)}
@keyframes rise{from{opacity:0;transform:translateY(10px)}}
.card{transition:background .15s,transform .15s,box-shadow .15s}.card:hover{transform:translateX(3px)}
.card .av{transition:transform .25s cubic-bezier(.2,.9,.3,1.4)}.card:hover .av{transform:scale(1.12) rotate(-6deg)}
.card.sel::before{animation:grow .3s ease-out}@keyframes grow{from{transform:scaleY(0)}}
.pill.go{position:relative;padding-left:20px}.pill.go::before{content:'';position:absolute;left:8px;top:50%;width:7px;height:7px;margin-top:-3.5px;border-radius:50%;background:var(--goDot);animation:pulse 1.8s ease-out infinite}
#right.open .pane,#right.open #detail{animation:rise .4s cubic-bezier(.2,.8,.2,1) both}
#right.open #donut{animation-delay:.03s}#right.open #cams{animation-delay:.09s}#right.open #detail{animation-delay:.14s}
#donut .arc{animation:arcin .6s cubic-bezier(.2,.8,.2,1) both;animation-delay:var(--d)}@keyframes arcin{from{opacity:0;stroke-width:6}}
#donut svg{animation:spinin .7s cubic-bezier(.2,.8,.2,1)}@keyframes spinin{from{transform:rotate(-40deg) scale(.85);opacity:0}}
.evb{animation:rise .35s ease-out both}.evb:nth-child(2){animation-delay:.04s}.evb:nth-child(3){animation-delay:.08s}.evb:nth-child(4){animation-delay:.12s}.evb:nth-child(n+5){animation-delay:.16s}
.evth img{transition:transform .35s}.evb:hover .evth img{transform:scale(1.08)}
.kv b{display:inline-block;animation:rise .4s ease-out both;animation-delay:.2s}
.tm.drop .pin{animation:drop .5s cubic-bezier(.2,.9,.3,1.3) both}@keyframes drop{from{opacity:0;transform:translate(-50%,-160%)}}
.btn2,.btn,.legend button,.sbar button{transition:transform .12s,box-shadow .15s,background .15s}.btn2:active,.btn:active,.legend button:active,.sbar button:active{transform:scale(.96)}
.btn2.pri:hover{box-shadow:0 6px 18px -8px rgba(10,44,64,.6);transform:translateY(-1px)}
.rrow{transition:background .15s}.rrow:hover .mav{transform:scale(1.1) rotate(-6deg)}.mav{transition:transform .25s cubic-bezier(.2,.9,.3,1.4)}
#vMap,#vEdit,#vDrv{animation:fadein .3s ease-out}@keyframes fadein{from{opacity:0}}
dialog[open]{animation:pop .22s cubic-bezier(.2,.9,.3,1.2)}
@media (prefers-reduced-motion:reduce){.hwave,.logo,.card.rise,.pill.go::before,#right.open .pane,#right.open #detail,#donut .arc,#donut svg,.evb,.kv b,.tm.drop .pin,#vMap,#vEdit,#vDrv,dialog[open],.vopop{animation:none!important}.card:hover,.card:hover .av,.rrow:hover .mav{transform:none}}
.office{position:absolute;left:0;top:0;transform:translate(-50%,-50%);display:flex;align-items:center;gap:4px;height:28px;padding:0 9px 0 7px;border-radius:14px;background:#fff;border:2px solid #c2410c;box-shadow:0 2px 6px rgba(16,34,46,.2);color:#9a3412;font:700 12px/1 Figtree,system-ui,sans-serif;white-space:nowrap;cursor:pointer;transition:transform .15s}
.office svg{width:15px;height:15px;stroke:#c2410c}.office.mv{border-color:#16a34a}
.office.empty{height:24px;width:24px;padding:0;justify-content:center;opacity:.85}.office.empty svg{width:13px;height:13px}
.tm:hover .office{transform:translate(-50%,-50%) scale(1.06)}
.toast{position:fixed;right:20px;bottom:20px;z-index:9999;max-width:380px;background:var(--deep);color:#fff;padding:12px 16px;border-radius:12px;box-shadow:0 10px 30px rgba(10,44,64,.35);font-size:13px;animation:tin .2s ease-out}
.toast.bad{background:var(--bad)}@keyframes tin{from{opacity:0;transform:translateY(8px)}}@media (prefers-reduced-motion:reduce){.toast{animation:none}}
.syncp{margin:0 0 12px}.syncp:empty{display:none}.syncp.sm{margin:10px 0 0;font-size:12px}
.sbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;background:var(--card);border-radius:10px;box-shadow:var(--sh);padding:9px 14px;font-size:13px}
.sbar .sd{width:8px;height:8px;border-radius:50%;background:var(--goDot)}.sbar.bad .sd{background:var(--warnDot)}.sbar .sp{flex:1}
.sbar button{font:inherit;font-size:12px;font-weight:600;color:var(--poolInk);background:var(--shallow);border:0;border-radius:7px;padding:5px 10px;cursor:pointer}.sbar button:disabled{opacity:.6;cursor:default}
.slog{margin:6px 0 0;padding:10px 14px;background:var(--card);border-radius:10px;box-shadow:var(--sh);font-size:12.5px;list-style:none;max-height:220px;overflow:auto}.slog li{padding:3px 0;border-bottom:1px solid var(--line)}.slog li:last-child{border:0}.slog time{color:var(--muted);margin-right:8px}.slog .n{color:var(--warn)}
.simp{background:var(--warnBg);border-radius:12px;padding:14px 16px;font-size:13px;display:flex;gap:14px;align-items:center;flex-wrap:wrap}.simp p{margin:2px 0 0;flex:1 1 380px;color:var(--ink2)}.simp b{color:var(--warn)}
.syncp.sm .sbar{box-shadow:none;background:var(--deck);padding:7px 10px}.syncp.sm .slog{display:none}
.crewhead{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px}
.crewhead h2{margin:0;font-size:20px;font-weight:700;letter-spacing:-.01em}.crewhead p{margin:2px 0 0;font-size:13px}
.nd{padding:18px 20px;margin-bottom:12px}
.scan{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:14px;padding-bottom:14px;border-bottom:1px solid var(--line)}
.scan label{display:inline-flex;align-items:center;cursor:pointer}.scan .hint{font-size:12px;color:var(--muted)}
#frontPrev{height:44px;border-radius:6px;border:1px solid var(--line2)}
.roster{max-width:none}
.rrow{display:grid;grid-template-columns:18px 36px minmax(200px,1fr) minmax(180px,.9fr) 170px;gap:14px;align-items:center;padding:11px 18px;border-bottom:1px solid var(--line)}
.rrow:last-child{border-bottom:0}.rrow:hover{background:#fcfbf8}
.rrow.off{opacity:.55}.rrow.off:hover{opacity:.8}
.mav{width:36px;height:36px;border-radius:50%;display:grid;place-items:center;font-weight:700;font-size:12px;background:var(--shallow);color:var(--poolInk)}
.rn{min-width:0}.rn b{display:block;font-weight:600}.nolic{font-style:normal;color:var(--warn);font-weight:600}.rn>span{display:block;font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rt{font-size:13px;color:var(--ink2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.rt.none{color:var(--muted)}
.rs{font-size:13px;text-align:right;white-space:nowrap}
.inaz{color:var(--go);display:inline-flex;align-items:center;gap:6px}.inaz::before{content:'';width:7px;height:7px;border-radius:50%;background:var(--goDot)}
.tag{font-size:11px;font-weight:600;color:var(--muted);border:1px solid var(--line2);border-radius:5px;padding:0 5px;margin-left:6px;vertical-align:1px}
.link{font:inherit;font-size:13px;font-weight:600;color:var(--poolInk);background:none;border:0;padding:0;cursor:pointer;text-decoration:underline;text-underline-offset:3px;text-decoration-color:var(--shallow2)}
.link:hover{text-decoration-color:currentColor}
.rrow .azf{grid-column:3/-1;margin:2px 0 4px;display:flex;gap:6px;flex-wrap:wrap}
.rrow .azf input{flex:1 1 160px;width:auto}
.addrow{display:flex;align-items:center;gap:10px;width:100%;padding:13px 18px;font:inherit;font-weight:600;color:var(--poolInk);background:none;border:0;cursor:pointer;text-align:left}
.addrow:hover{background:var(--shallow)}.addrow .mav{background:none;border:1.5px dashed var(--shallow2);font-size:18px;font-weight:500}
.dup{background:var(--warnBg);border-radius:var(--r);padding:14px 18px;margin-bottom:12px;color:var(--ink2);font-size:13px}
.dup h4{margin:0 0 4px;font-size:14px;color:var(--warn)}
.dupg{background:#fff;border-radius:10px;padding:10px 12px;margin-top:10px}
.dupg label{display:flex;gap:8px;align-items:baseline;padding:4px 0;cursor:pointer}.dupg label span{color:var(--muted)}
.dupg .edb{margin-top:8px;padding-top:8px;border-top:1px solid var(--line)}
@media(max-width:700px){.rrow{grid-template-columns:18px 36px minmax(0,1fr) auto;row-gap:2px}.rt{grid-column:3/-1;grid-row:2;font-size:12px}.rs{grid-row:1;grid-column:4}.rrow .azf{grid-row:3}}
.rrow.picked{background:var(--shallow)}.rrow.picked.off{opacity:.8}
.selbar{position:sticky;bottom:16px;z-index:5;margin:12px auto 0;max-width:640px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;background:var(--deep);color:#fff;border-radius:12px;padding:10px 14px;box-shadow:0 8px 24px rgba(10,44,64,.3)}
.selbar b{font-weight:700}.selbar .btn2{background:#fff;border-color:#fff}.selbar .link{color:#cfe3ec}.selbar .msg{color:#fde68a}
.azf{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
.azf input{font:inherit;font-size:13px;padding:6px 8px;border:1px solid var(--line2);border-radius:7px;min-width:0;width:170px}
.msg{font-size:12px;margin-top:4px;max-width:240px}.msg.ok{color:var(--go)}.msg.bad{color:var(--bad)}

/* ---- Polish: clearer surfaces, one header style, stronger numbers ---- */
:root{--sh:0 0 0 1px rgba(16,34,46,.06),0 1px 2px rgba(16,34,46,.05),0 4px 14px -6px rgba(16,34,46,.10)}
header{background:linear-gradient(180deg,#0c3550 0%,var(--deep) 100%);box-shadow:inset 0 -1px 0 rgba(255,255,255,.06)}
.logo{background:linear-gradient(135deg,#14a3c7,var(--pool));box-shadow:inset 0 1px 0 rgba(255,255,255,.25)}
.ph{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin:0 0 10px;padding-bottom:9px;border-bottom:1px solid var(--line)}
.ph h3{margin:0;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--ink2)}
.ph span{font-size:12px;color:var(--muted)}.ph .link{font-size:12px}
.card{position:relative}
.card.sel::before{content:'';position:absolute;left:0;top:8px;bottom:8px;width:3px;border-radius:0 3px 3px 0;background:var(--pool)}
.card:focus-visible{outline-offset:-2px}
.grid{border:1px solid var(--line);gap:1px;overflow:hidden;padding:0;background:var(--line)}
#detail h3{font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--ink2);margin:22px 0 6px}
.kv{background:#fff;border-left:0!important;border-top:0!important;padding:11px 14px}
.kv span{font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase}.kv b{font-size:17px;font-weight:700;letter-spacing:-.01em}
.evb{border-top:0;padding:8px;margin:2px 0;transition:background .12s}.evb+.evb{box-shadow:0 -1px 0 var(--line)}
.evb:hover{background:var(--shallow)}.evb:hover .evgo{text-decoration:underline}
#cams .evth{width:88px;height:52px;border-radius:8px;box-shadow:inset 0 0 0 1px rgba(0,0,0,.06)}
.dh h2{font-size:21px}
.sum button[aria-pressed=true]{box-shadow:0 0 0 1px var(--line2),0 1px 2px rgba(16,34,46,.06)}
@media (prefers-reduced-motion:reduce){.evb,.card{transition:none}}
/* ---- Colour: a brighter poolside palette ---- */
:root{--deck:#eef6f7;--deck2:#e1eef0;--line:#dbe7ea;--line2:#c8dbe0;--pool:#0891b2;--poolInk:#0e7490;--shallow:#cff4fb;--shallow2:#a5e8f5;
 --coral:#f97362;--coralBg:#ffe8e4;--sun:#f59e0b;--sunBg:#fff3d6;--grape:#8b5cf6;--grapeBg:#efe8ff;--leaf:#16a34a;--leafBg:#dcfce7}
body{background:radial-gradient(1200px 600px at 100% -10%,#d3f3f8 0%,transparent 60%),radial-gradient(900px 500px at -10% 110%,#fdeee0 0%,transparent 55%),var(--deck);background-attachment:fixed}
header{background:linear-gradient(110deg,#082a3d 0%,#0b4a63 55%,#0e7490 100%)}
.hwave{fill:rgba(103,232,249,.28)}
header{padding-bottom:34px}
header>.brand,header>.live,header>.tabs{position:relative;z-index:3}
.hwave.front{z-index:2;fill:rgba(103,232,249,.38)}
#floaty{position:absolute;left:0;right:0;bottom:-1px;height:58px;z-index:1;pointer-events:none}
.fl{position:absolute;left:0;top:0;height:52px;will-change:transform;transform-origin:50% 85%;filter:drop-shadow(0 3px 2px rgba(3,30,45,.35))}
.grid:has(.kscore){grid-template-columns:repeat(5,1fr)}.kv.kscore{background:#f1f5f9}.kscore span{color:#475569}.kscore b i{font-style:normal;font-size:12px;font-weight:600;opacity:.6;margin-left:2px}
.kscore small{display:block;font-size:11.5px;color:#64748b;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.kv.kscore{min-width:0;cursor:help}.kscore.good{background:#dcfce7}.kscore.good span,.kscore.good b{color:#15803d}
.kscore.ok{background:#ffedd5}.kscore.ok span,.kscore.ok b{color:#c2410c}.kscore.bad{background:#fee2e2}.kscore.bad span,.kscore.bad b{color:#b91c1c}
@media (max-width:900px){.grid:has(.kscore){grid-template-columns:repeat(2,1fr)}.kv.kscore{grid-column:span 2}}
.trk{display:inline-block;background:#ffedd5;color:#c2410c;border:1px solid #fdba74;font-weight:700;font-size:11.5px;padding:1px 8px;border-radius:999px;letter-spacing:.01em}
.tabs a.reptab{font-weight:600;font-size:13px;color:#e4f222;text-decoration:none;padding:7px 14px;border-radius:8px}.tabs a.reptab:hover{background:rgba(255,255,255,.12)}
.repbtn{margin-left:8px;font-size:12.5px;font-weight:600;color:#0e7490;background:#ecfeff;border:1px solid #a5f3fc;border-radius:8px;padding:5px 10px;text-decoration:none;white-space:nowrap}.repbtn:hover{background:#cffafe}
.ramp{margin:12px 0;padding:12px 14px;border-radius:14px;background:#121212;color:#f4f4ef;box-shadow:0 6px 18px rgba(0,0,0,.18)}.ramp:empty{display:none}
.ramp h4{margin:0 0 10px;font-size:13px;font-weight:600;color:#d6d6cf;display:flex;align-items:center;gap:8px}.ramp .rtag{background:#e4f222;color:#111;font-weight:800;border-radius:6px;padding:2px 8px;font-size:12px}
.rgrid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.rgrid>div{background:#1d1d1d;border-radius:10px;padding:10px 12px}.rgrid span{display:block;font-size:12px;color:#a3a39b}
.rgrid b{display:block;font-size:22px;line-height:1.25;color:#fff;font-variant-numeric:tabular-nums}.rgrid .rgas{background:#e4f222;color:#111}.rgrid .rgas span,.rgrid .rgas i{color:#3a3d00}.rgrid .rgas b{color:#111}
.rgrid i{font-style:normal;font-size:12px;color:#a3a39b}.ramp .rmile{margin-top:10px;padding:9px 12px;border-radius:10px;background:#1d1d1d;display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px}.ramp .rmile b{color:#e4f222;font-size:16px}.ramp .rmile span{color:#d6d6cf;font-size:12.5px}.ramp .rmile em{font-style:normal;font-size:12px;color:#86efac;margin-left:auto}.ramp .rmile.bad em{color:#fca5a5}.ramp .rmile.bad b{color:#fca5a5}
.ramp .rmile.mpg b{color:#7dd3fc}.ramp .rmile.mpg em{color:#a3a39b}
.ramp .rmuted{font-size:12.5px;color:#a3a39b;margin-top:6px}.ramp .sk{background:#2a2a2a}
.fl.flip .bob{transform:scaleX(-1)}.fl.flip .nf{transform:scaleX(-1);transform-box:fill-box;transform-origin:center}
.fl::after{content:'';position:absolute;left:6%;right:6%;bottom:16%;height:8px;border-radius:50%;border:2px solid rgba(207,250,254,.7);animation:ripple2 2.8s ease-out infinite;z-index:-1}
@keyframes ripple2{0%{transform:scale(.7);opacity:.9}100%{transform:scale(1.25);opacity:0}}
.fl .bob{height:100%}.fl svg{height:100%;width:auto;display:block;overflow:visible}
@keyframes drift{from{transform:translateX(-110px)}to{transform:translateX(var(--x))}}
@keyframes float{0%,100%{transform:translateY(0) rotate(-4deg)}50%{transform:translateY(-5px) rotate(4deg)}}
@media (prefers-reduced-motion:reduce){#floaty,.hwave.front{display:none}}
.logo{background:linear-gradient(135deg,#22d3ee,#0891b2 60%,#0e7490)}
.tabs{background:rgba(255,255,255,.1)}.tabs button:hover:not(.on){background:rgba(255,255,255,.12)}
.tabs button.on{background:#fff;color:#0b4a63;box-shadow:0 4px 14px -6px rgba(0,0,0,.4)}
.live .dot{background:#4ade80}
/* filter chips light up in their own colour */
.sum button[data-f=all][aria-pressed=true]{background:#0b4a63;border-color:#0b4a63;color:#fff}.sum button[data-f=all][aria-pressed=true] b{color:#fff}
.sum button[data-f=moving][aria-pressed=true]{background:var(--leafBg);border-color:#86efac}
.sum button[data-f=parked][aria-pressed=true]{background:#e2e8f0;border-color:#cbd5e1}
.sum button[data-f=nodriver][aria-pressed=true]{background:var(--sunBg);border-color:#fcd34d}
.sum button:hover{background:rgba(255,255,255,.7)}
/* list: status stripe on each truck */
.card{border-left:4px solid transparent}.card:has(.pill.go){border-left-color:var(--leaf)}.card.sel{background:linear-gradient(90deg,var(--shallow) 0%,#effbfd 100%)}
.card:hover{background:#f3fbfc}.card.sel::before{display:none}.card.sel{border-left-color:var(--pool)}
/* section headers get their own accent */
.ph{border-bottom:2px solid var(--line)}.ph h3{display:flex;align-items:center;gap:8px}.ph h3::before{content:'';width:9px;height:9px;border-radius:3px;background:var(--pool)}
#donut .ph h3::before{background:var(--coral)}#cams .ph h3::before{background:var(--grape)}
#detail h3{display:flex;align-items:center;gap:8px}#detail h3::before{content:'';width:9px;height:9px;border-radius:3px;background:var(--sun)}
/* stat tiles: one colour each */
.grid{background:transparent;border:0;gap:8px}
.kv{border-radius:12px;padding:12px 14px}
.kv:nth-child(1){background:#e0f2fe}.kv:nth-child(1) span{color:#0369a1}
.kv:nth-child(2){background:var(--leafBg)}.kv:nth-child(2) span{color:#15803d}
.kv:nth-child(3){background:var(--grapeBg)}.kv:nth-child(3) span{color:#6d28d9}
.kv:nth-child(4){background:var(--sunBg)}.kv:nth-child(4) span{color:#b45309}
.at{background:linear-gradient(135deg,#e0f7fb,#ecfeff);border:1px solid #bdeef7}
/* buttons */
.btn2.pri{background:linear-gradient(135deg,#0891b2,#0e7490);border-color:#0e7490}.btn2.pri:hover:not(:disabled){background:linear-gradient(135deg,#06b6d4,#0891b2)}
.legend button,.sbar button,.btn{background:var(--shallow);color:var(--poolInk)}.legend button:hover,.sbar button:hover{background:var(--shallow2)}
#voBtn{border-color:var(--shallow2)}#voBtn:hover{background:#f0fdff}
/* pills a touch stronger */
.pill.go{background:#bbf7d0;color:#14532d}.pill.idle{background:#e2e8f0;color:#334155}.pill.warn{background:#fde68a;color:#78350f}.pill.bad{background:#fecdd3;color:#9f1239}
/* map pins: parked trucks in deep teal, the selected one in coral */
.pin{background:#0b4a63}.pin.sel{background:var(--coral)}.clu{background:linear-gradient(135deg,#0e7490,#0b4a63)}
/* drivers tab */
.crewhead h2{background:linear-gradient(90deg,#0b4a63,#0891b2);-webkit-background-clip:text;background-clip:text;color:transparent}
#dsum button[aria-pressed=true]{background:#0b4a63;color:#fff;border-color:#0b4a63}#dsum button[aria-pressed=true] b{color:#fff}
.rrow:hover{background:#f3fbfc}.rrow.picked{background:var(--shallow)}
.panel,.pane,#detail,#list,.camcard{box-shadow:0 0 0 1px rgba(14,116,144,.08),0 1px 2px rgba(16,34,46,.05),0 8px 24px -12px rgba(14,116,144,.25)}
@media(max-width:900px){
 .legend>span{display:none}
 header{padding:12px 16px}.bar{padding:12px 16px 0}.search{flex:1 1 100%}
 main{grid-template-columns:1fr;height:auto;padding:12px 16px}#list{max-height:45vh}#right,#right.open{grid-template-columns:1fr;grid-template-rows:auto;grid-template-areas:none}#right>*{grid-area:auto!important}#map{height:300px}#right.big #map{height:70vh}#detail{order:1}#donut{order:2}#cams{order:3}#donut{flex-wrap:wrap;justify-content:center}
 .grid{grid-template-columns:repeat(2,1fr)}.kv:nth-child(3){border-left:0}.kv:nth-child(n+3){border-top:1px solid var(--line)}
 #vEdit,#vDrv{padding:12px 16px}.ed{grid-template-columns:1fr;height:auto}#edList{max-height:35vh}#drvRows td:nth-child(3){display:none}
}
@media (pointer:coarse),(max-width:700px){
 .sum button,.tabs button,.btn2,.legend button,.addrow,.search input,.lnk select,.fg input,.fg select{min-height:44px}
 .btn,.link,.azbtn{min-height:44px;display:inline-flex;align-items:center}
 .pick,input[type=checkbox]{width:22px;height:22px}
 .card{padding:14px}.eli{padding:13px 14px}
 .leaflet-control-zoom a{width:40px!important;height:40px!important;line-height:40px!important;font-size:20px!important}
 .dclose{min-width:44px;min-height:44px}
}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}

/* ===== v5 polish: pool-light header, glassy panels, livelier controls ===== */
:root{--r:16px;--sh:0 0 0 1px rgba(14,116,144,.07),0 2px 4px rgba(8,42,61,.04),0 12px 28px -12px rgba(8,42,61,.18)}
body{background:radial-gradient(1100px 520px at 100% -8%,#cdf1f8 0%,transparent 60%),radial-gradient(900px 480px at -8% 108%,#fde9d6 0%,transparent 55%),
 linear-gradient(rgba(14,116,144,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(14,116,144,.035) 1px,transparent 1px),var(--deck);
 background-size:auto,auto,26px 26px,26px 26px,auto;background-attachment:fixed}
header{background:radial-gradient(700px 160px at 18% -40%,rgba(103,232,249,.28),transparent 70%),linear-gradient(110deg,#06253a 0%,#0a4660 50%,#0e7490 100%)}
.caus{position:absolute;left:0;right:0;bottom:0;height:64px;pointer-events:none;z-index:0;mix-blend-mode:soft-light;opacity:.4;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='520' height='260'%3E%3Cfilter id='c' x='0' y='0' width='100%25' height='100%25'%3E%3CfeTurbulence type='turbulence' baseFrequency='0.016 0.032' numOctaves='1' seed='7' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 0.75  0 0 0 0 0.97  0 0 0 0 1  -22 0 0 0 2.1'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23c)'/%3E%3C/svg%3E"),url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='520' height='260'%3E%3Cfilter id='c' x='0' y='0' width='100%25' height='100%25'%3E%3CfeTurbulence type='turbulence' baseFrequency='0.016 0.032' numOctaves='1' seed='23' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 0.75  0 0 0 0 0.97  0 0 0 0 1  -22 0 0 0 2.1'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23c)'/%3E%3C/svg%3E");
 background-size:520px 260px,700px 350px;animation:caus 38s linear infinite;-webkit-mask:linear-gradient(180deg,transparent,#000 55%);mask:linear-gradient(180deg,transparent,#000 55%)}
@keyframes caus{to{background-position:520px 130px,-700px -175px}}
.logo{position:relative;box-shadow:0 0 0 1px rgba(255,255,255,.18),0 6px 18px -4px rgba(34,211,238,.55);overflow:hidden}
.logo::after{content:'';position:absolute;inset:-40%;background:linear-gradient(115deg,transparent 40%,rgba(255,255,255,.55) 50%,transparent 60%);animation:shine 7s ease-in-out infinite}
@keyframes shine{0%,70%{transform:translateX(-60%)}85%,100%{transform:translateX(60%)}}
.brand{letter-spacing:-.01em;text-shadow:0 1px 10px rgba(0,0,0,.25)}
.tabs{position:relative;background:rgba(3,23,36,.38);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);box-shadow:inset 0 0 0 1px rgba(255,255,255,.08)}
.tabs button{position:relative;z-index:1}.tabs button.on{background:transparent!important;color:var(--deep)}
.tabind{position:absolute;top:3px;bottom:3px;left:0;width:0;border-radius:8px;background:#fff;box-shadow:0 4px 14px -4px rgba(0,0,0,.35);transition:left .35s cubic-bezier(.3,1.3,.5,1),width .35s cubic-bezier(.3,1.3,.5,1);z-index:0}
.live{background:rgba(3,23,36,.3);padding:5px 11px;border-radius:999px;box-shadow:inset 0 0 0 1px rgba(255,255,255,.08)}
.panel{border-radius:18px;background:rgba(255,255,255,.92);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);transition:box-shadow .25s,transform .25s}
.panel:hover{box-shadow:0 0 0 1px rgba(14,116,144,.1),0 4px 8px rgba(8,42,61,.05),0 18px 36px -14px rgba(8,42,61,.24)}
.ph h3::before{width:10px;height:10px;border-radius:50%;box-shadow:0 0 0 3px rgba(8,145,178,.15)}
.search{border-radius:12px;transition:box-shadow .2s}.search:focus-within{box-shadow:0 0 0 3px rgba(34,211,238,.35),var(--sh)}
.sum button[aria-pressed=true]{background:linear-gradient(135deg,#0a4660,#0e7490);color:#fff;border-color:transparent;box-shadow:0 6px 16px -6px rgba(14,116,144,.7)}
.sum button[aria-pressed=true] b{color:#fff}
.btn2{transition:transform .15s,box-shadow .2s,background .15s}.btn2:hover{transform:translateY(-1px);box-shadow:0 6px 14px -8px rgba(8,42,61,.45)}.btn2:active{transform:translateY(0) scale(.98)}
.btn2.pri{background:linear-gradient(135deg,#0891b2,#0e7490);border-color:transparent;color:#fff;box-shadow:0 6px 16px -8px rgba(14,116,144,.9)}
.card{border-radius:12px;margin:4px 6px;border-bottom:0}.card:hover{background:#f3fbfd}.card.sel{box-shadow:inset 0 0 0 1px rgba(8,145,178,.25),0 6px 18px -10px rgba(8,145,178,.6)}
.av,.mav{box-shadow:0 0 0 2px #fff,0 0 0 3.5px rgba(8,145,178,.18)}
.kv{transition:transform .2s}.kv:hover{transform:translateY(-2px)}
#map,.leaflet-container{border-radius:18px}
.leaflet-control-zoom a{border-radius:10px!important;margin:3px;box-shadow:var(--sh)}
.sk{background:linear-gradient(90deg,#e6f3f6 25%,#f6fcfd 37%,#e6f3f6 63%);background-size:400% 100%}
::-webkit-scrollbar{width:10px;height:10px}::-webkit-scrollbar-thumb{background:rgba(14,116,144,.25);border-radius:10px;border:3px solid transparent;background-clip:padding-box}::-webkit-scrollbar-thumb:hover{background-color:rgba(14,116,144,.45)}
/* floaters: shadow, reflection, wake rings, sun glints, droplets */
#floaty{overflow:visible}
.fl{pointer-events:auto;cursor:pointer}.fl::after{display:none}
.fl .bob{position:relative;z-index:1;transition:filter .2s}.fl:hover .bob{filter:brightness(1.08) drop-shadow(0 0 6px rgba(255,255,255,.5))}
.fsh{position:absolute;left:14%;right:14%;bottom:18%;height:18%;border-radius:50%;background:radial-gradient(ellipse,rgba(2,24,38,.45),transparent 70%);filter:blur(2px);opacity:calc(1 - var(--lift,0)*.7);transform:scale(calc(1 + var(--lift,0)*.4))}
.frf{position:absolute;left:0;right:0;top:100%;height:100%;transform:scaleY(-.5);transform-origin:top;opacity:.2;filter:blur(1.2px) saturate(1.3);-webkit-mask:linear-gradient(180deg,#000,transparent 75%);mask:linear-gradient(180deg,#000,transparent 75%);pointer-events:none}
.fl.flip .frf>svg{transform:scaleX(-1)}.frf svg{height:100%;width:auto;display:block}
#floaty i{position:absolute;pointer-events:none;display:block}
#floaty .rp{width:34px;height:7px;margin:-3.5px 0 0 -17px;border-radius:50%;border:1.5px solid rgba(224,247,255,.6);animation:rp 1.6s ease-out forwards}
#floaty .rp.big{width:46px;height:10px;margin:-5px 0 0 -23px;border-width:2px}
@keyframes rp{from{transform:scale(.35);opacity:.95}to{transform:scale(2.3);opacity:0}}
#floaty .gl{width:10px;height:10px;margin:-5px;animation:gl 1.5s ease-in-out forwards;background:radial-gradient(circle,#fff 0 16%,rgba(255,255,255,0) 58%)}
#floaty .gl::before,#floaty .gl::after{content:'';position:absolute;left:50%;top:50%;width:14px;height:1.3px;margin:-.65px 0 0 -7px;background:linear-gradient(90deg,transparent,#fff,transparent)}#floaty .gl::after{transform:rotate(90deg)}
@keyframes gl{0%{opacity:0;transform:scale(.3)}40%{opacity:.95;transform:scale(1)}100%{opacity:0;transform:scale(.4) translateX(8px)}}
#floaty .drop{width:4px;height:5px;margin:-2px;border-radius:50% 50% 50% 50%/60% 60% 40% 40%;background:#e0f7ff;box-shadow:0 0 3px rgba(255,255,255,.8);animation:drop .75s cubic-bezier(.2,.7,.4,1) both}
@keyframes drop{0%{transform:translate(0,0);opacity:1}45%{transform:translate(calc(var(--dx)*.6),calc(var(--up)*-1))}100%{transform:translate(var(--dx),8px);opacity:0}}
@media (prefers-reduced-motion:reduce){.caus,.logo::after{animation:none}.tabind{transition:none}}

/* filter chips: chunky, count in a bubble */
.sum button{background:rgba(255,255,255,.7);border:1px solid rgba(14,116,144,.12);padding:6px 6px 6px 12px;font-weight:600;transition:transform .15s,background .15s,box-shadow .2s}
.sum button:hover{transform:translateY(-1px);background:#fff}.sum button b{min-width:22px;padding:1px 7px;border-radius:999px;background:var(--deck2);text-align:center}
.sum button[aria-pressed=true] b{background:rgba(255,255,255,.22)}
.card{margin:3px 5px}
/* sky follows the time of day */
header[data-sky=dawn]{background:radial-gradient(600px 160px at 80% -30%,rgba(253,186,116,.45),transparent 70%),linear-gradient(110deg,#1e3a5f 0%,#3b6b8c 50%,#0e7490 100%)}
header[data-sky=dusk]{background:radial-gradient(700px 180px at 85% -20%,rgba(251,146,60,.55),transparent 70%),radial-gradient(500px 140px at 50% -40%,rgba(244,114,182,.35),transparent 70%),linear-gradient(110deg,#2a1b4a 0%,#5b2a5c 45%,#0e7490 100%)}
header[data-sky=night]{background:radial-gradient(1.2px 1.2px at 12% 22%,#fff 50%,transparent 51%),radial-gradient(1px 1px at 27% 58%,#e0f2fe 50%,transparent 51%),radial-gradient(1.4px 1.4px at 41% 18%,#fff 50%,transparent 51%),radial-gradient(1px 1px at 58% 40%,#fff 50%,transparent 51%),radial-gradient(1.3px 1.3px at 66% 14%,#e0f2fe 50%,transparent 51%),radial-gradient(1px 1px at 77% 46%,#fff 50%,transparent 51%),radial-gradient(1.2px 1.2px at 88% 24%,#fff 50%,transparent 51%),radial-gradient(1px 1px at 34% 36%,#fff 50%,transparent 51%),linear-gradient(110deg,#030b1a 0%,#0a1f3a 55%,#0b4a63 100%)}
header[data-sky=night] .caus{opacity:.25}header[data-sky=night]::before{content:'';position:absolute;right:30%;top:10px;width:22px;height:22px;border-radius:50%;box-shadow:-6px 3px 0 0 #fef3c7;filter:drop-shadow(0 0 6px rgba(254,243,199,.6));pointer-events:none;z-index:0}

input:focus-visible,select:focus-visible,textarea:focus-visible{outline:none;border-color:#22d3ee!important;box-shadow:0 0 0 3px rgba(34,211,238,.35)}
.flag{display:inline-grid;place-items:center;width:15px;height:15px;margin-left:5px;border-radius:50%;background:#fff7ed;color:#ea580c;font-size:9px;font-style:normal;font-weight:700;line-height:1;cursor:help;vertical-align:middle;box-shadow:0 0 0 1px #fdba74;letter-spacing:0;text-transform:none}
.flag:hover,.flag:focus{background:#ffedd5;outline:none;box-shadow:0 0 0 2px #fb923c}
#fltip{position:fixed;z-index:9999;background:#0f172a;color:#f8fafc;font-size:12.5px;line-height:1.45;padding:9px 11px;border-radius:9px;box-shadow:0 10px 30px -8px rgba(0,0,0,.45);white-space:pre-line;pointer-events:none}
.kscore b{white-space:nowrap}.kscore small .flag{margin:0 2px 0 0;width:14px;height:14px}

/* driver score chips + ring */
.schip{display:inline-block;margin-left:6px;min-width:24px;padding:0 6px;border-radius:999px;font-size:11px;font-weight:800;line-height:17px;text-align:center;vertical-align:1px;letter-spacing:0}
.schip.good{background:#dcfce7;color:#15803d}.schip.ok{background:#ffedd5;color:#c2410c}.schip.bad{background:#fee2e2;color:#b91c1c;box-shadow:0 0 0 0 rgba(239,68,68,.5);animation:schip 2.4s ease-out infinite}
@keyframes schip{0%{box-shadow:0 0 0 0 rgba(239,68,68,.45)}70%,100%{box-shadow:0 0 0 6px rgba(239,68,68,0)}}
.kscore b{display:flex;align-items:center;gap:6px}.kscore .ring{width:30px;height:30px;transform:rotate(-90deg);flex:none}
.kscore .ring circle{fill:none;stroke-width:4;stroke:currentColor;opacity:.18}.kscore .ring .fill{opacity:1;stroke-linecap:round;stroke-dasharray:var(--v) 100;animation:ring 1s cubic-bezier(.3,.9,.3,1) both}
@keyframes ring{from{stroke-dasharray:0 100}}
@media (prefers-reduced-motion:reduce){.schip.bad,.kscore .ring .fill{animation:none}}

/* list section headers when sorted moving / parked / no tracker */
.lgrp{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:8px;margin:0;padding:8px 14px 6px;font-size:11px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:#475569;background:linear-gradient(180deg,rgba(255,255,255,.97) 70%,rgba(255,255,255,0))}
.lgrp::before{content:'';width:8px;height:8px;border-radius:50%;background:#64748b}.lgrp b{margin-left:auto;font-size:11px;padding:0 7px;border-radius:999px;background:#eef2f6;color:#475569}
.lgrp.g0{color:#15803d}.lgrp.g0::before{background:#22c55e;box-shadow:0 0 0 3px rgba(34,197,94,.2);animation:schip 2s ease-out infinite}.lgrp.g0 b{background:#dcfce7;color:#15803d}
.lgrp.g2{color:#c2410c}.lgrp.g2::before{background:#f97316}.lgrp.g2 b{background:#ffedd5;color:#c2410c}

.ramp .rdates{margin-left:auto;font-size:11.5px;font-weight:600;color:#d9f99d;background:rgba(228,242,34,.12);border:1px solid rgba(228,242,34,.3);padding:2px 9px;border-radius:999px}
.rgrid .rgas{position:relative}.rgas .spark{position:absolute;right:12px;top:12px;width:42%;height:30px;fill:#3a3d00;opacity:.75}
.kv.kscore{position:relative}.kscore>span .flag{position:absolute;top:9px;right:9px;margin:0}
.mgauge{position:relative;display:inline-block;width:90px;height:7px;border-radius:99px;background:rgba(255,255,255,.12);overflow:hidden;align-self:center}.mgauge i{position:absolute;inset:0 auto 0 0;border-radius:99px;animation:mg .9s cubic-bezier(.3,.9,.3,1) both}.mgauge u{position:absolute;top:0;bottom:0;left:50%;width:33%;border-left:1px dashed rgba(255,255,255,.35);border-right:1px dashed rgba(255,255,255,.35)}@keyframes mg{from{width:0}}

/* Pool Office Manager: route list + pool pins */
.pom{margin:12px 0;padding:12px 14px;border-radius:14px;background:linear-gradient(180deg,#ecfeff,#f0f9ff);box-shadow:inset 0 0 0 1px #bae6fd}
.pom h4{margin:0 0 8px;font-size:13px;display:flex;align-items:center;gap:8px;color:#0c4a6e}.pom .ptag{background:#0369a1;color:#fff;font-weight:800;border-radius:6px;padding:2px 7px;font-size:11px}
.pom .pcount{margin-left:auto;font-weight:700;color:#0369a1}.pbar{height:8px;border-radius:99px;background:#e0f2fe;overflow:hidden;margin-bottom:8px}.pbar i{display:block;height:100%;background:linear-gradient(90deg,#22d3ee,#0ea5e9);border-radius:99px;animation:mg 1s cubic-bezier(.3,.9,.3,1) both}
.plist{list-style:none;margin:0;padding:0;max-height:260px;overflow:auto}.plist li{display:flex;align-items:center;gap:10px;padding:7px 6px;border-radius:9px;cursor:pointer}.plist li:hover{background:rgba(14,165,233,.08)}
.plist .pn{flex:none;width:22px;height:22px;border-radius:50%;display:grid;place-items:center;font-size:11px;font-weight:800;background:#fff;color:#0369a1;box-shadow:inset 0 0 0 1.5px #7dd3fc}
.plist li.done .pn{background:#22c55e;color:#fff;box-shadow:none}.plist li div{flex:1;min-width:0}.plist li b{display:block;font-size:13px}.plist li span{display:block;font-size:12px;color:#64748b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.plist li em{font-style:normal;font-size:12px;font-weight:600;color:#0369a1;text-align:right}.plist li.done em{color:#15803d}.plist li em small{display:block;font-weight:500;color:#94a3b8}
.poolpin span{display:grid;place-items:center;width:22px;height:16px;border-radius:6px;background:linear-gradient(180deg,#67e8f9,#0891b2);border:2px solid #fff;box-shadow:0 2px 6px rgba(8,51,68,.35);font-size:10px;color:#fff;font-weight:800;position:relative;overflow:hidden}
.poolpin span::after{content:'';position:absolute;left:-4px;right:-4px;top:4px;height:3px;border-radius:50%;border-top:1.5px solid rgba(255,255,255,.7)}
.poolpin.done span{background:linear-gradient(180deg,#86efac,#16a34a)}.poolpin.done span::after{display:none}

/* breadcrumb trail controls */
.trailbar{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:10px 0 2px;font-size:12.5px}.trailbar>span{font-weight:700;color:#334155;margin-right:2px}
.trailbar button{font:inherit;font-size:12px;font-weight:600;border:1px solid #cbd5e1;background:#fff;color:#334155;padding:4px 10px;border-radius:999px;cursor:pointer;transition:all .15s}
.trailbar button:hover{border-color:#0891b2;color:#0e7490}.trailbar button.on{background:linear-gradient(135deg,#0891b2,#0e7490);border-color:transparent;color:#fff;box-shadow:0 4px 10px -4px rgba(14,116,144,.7)}
.trailbar em{flex-basis:100%;font-style:normal;color:#64748b;font-size:12px}.trailbar em b{color:#0f172a}
.tlegend{margin-left:10px;white-space:nowrap}.tlegend i{display:inline-block;width:14px;height:4px;border-radius:2px;margin:0 3px 2px 6px;vertical-align:middle}

/* look back at a day: date picker, time-at-pool, day timeline */
.pom .pdate{margin-left:6px}.pom .pdate input{font:inherit;font-size:12px;font-weight:600;color:#0369a1;border:1px solid #bae6fd;background:#fff;border-radius:8px;padding:2px 6px;cursor:pointer}
.pom.loading{opacity:.55;transition:opacity .2s}.psum{font-size:12.5px;color:#0c4a6e;margin:2px 0 6px}.psum b{font-size:14px}
.ptl{position:relative;height:16px;margin:4px 0 18px;border-radius:6px;background:repeating-linear-gradient(90deg,#e0f2fe 0 10%,#f0f9ff 10% 20%)}
.ptl i{position:absolute;top:2px;bottom:2px;border-radius:4px;background:linear-gradient(180deg,#38bdf8,#0284c7);box-shadow:0 0 0 1px #fff;cursor:help}.ptl i:hover{background:#0c4a6e}
.ptl span{position:absolute;top:18px;font-size:10.5px;color:#64748b}.ptl span:last-child{right:0}
.plist .pvisit{color:#0369a1!important;font-weight:600}.plist .pvisit.none{color:#94a3b8!important;font-weight:500}
.plist .pfar{display:inline-block;margin-left:4px;padding:0 6px;border-radius:9px;background:#fff7ed;color:#c2410c;font-size:11px;font-weight:600}.plist .vmins{display:block;font-size:13px;color:#0c4a6e}.plist .vmins.short{color:#dc2626}.plist .vmins.long{color:#c2410c}

/* ===== v9: brighter pool, colour per panel, text that fits, more motion ===== */
:root{--c-list:#0891b2;--c-donut:#f97316;--c-cams:#8b5cf6;--c-detail:#ec4899}
body::before{content:'';position:fixed;inset:-5%;z-index:-1;pointer-events:none;background:radial-gradient(38vw 38vw at 8% 92%,rgba(34,211,238,.22),transparent 62%),radial-gradient(34vw 34vw at 96% 72%,rgba(244,114,182,.14),transparent 62%),radial-gradient(30vw 30vw at 55% 8%,rgba(163,230,53,.12),transparent 62%);animation:wash 26s ease-in-out infinite alternate}
@keyframes wash{to{transform:translate(-3%,-2%) scale(1.06)}}
header{padding-bottom:80px}
#floaty,.hwave{height:84px}.hwave{fill:rgba(34,211,238,.5)}.hwave.front{fill:rgba(125,240,255,.42)}
.caus{height:44px;opacity:.5}
header::after{content:'';position:absolute;left:0;right:0;bottom:0;height:6px;z-index:3;background:repeating-linear-gradient(90deg,#f6efe2 0 46px,#ebe0cc 46px 48px);box-shadow:0 -2px 6px rgba(3,30,45,.25)}
.fl .bob{filter:saturate(1.18) contrast(1.04)}.fl.lane0{z-index:1;opacity:.93}.fl.lane1{z-index:2}
#list{--c:var(--c-list)}#donut{--c:var(--c-donut)}#cams{--c:var(--c-cams)}#detail{--c:var(--c-detail)}
#list,.pane,#detail{box-shadow:inset 0 3px 0 var(--c),var(--sh)}
.ph h3::before{background:var(--c,var(--pool))!important;box-shadow:0 0 0 3px color-mix(in srgb,var(--c,var(--pool)) 22%,transparent)!important}
.ph{flex-wrap:wrap;align-items:center;row-gap:2px}.ph h3{white-space:nowrap}.ph>span{font-size:12px;min-width:0}
.ci .top b{white-space:normal;text-overflow:clip;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;line-height:1.25}
.card{transition:transform .2s cubic-bezier(.2,.8,.2,1),box-shadow .2s,background .15s}.card:hover{transform:translateY(-2px);box-shadow:0 10px 22px -14px rgba(8,145,178,.65)}
#donut svg{flex:0 0 128px;width:128px;animation:dspin .9s cubic-bezier(.2,.8,.2,1) both}@keyframes dspin{from{transform:rotate(-120deg) scale(.6);opacity:0}}
#donut .leg span{white-space:normal;overflow:visible;text-overflow:clip;line-height:1.2}
.kv span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.kv b{white-space:nowrap;font-size:clamp(15px,1.3vw,20px)}
.pill.go{background-image:linear-gradient(110deg,transparent 35%,rgba(255,255,255,.75) 50%,transparent 65%);background-size:260% 100%;animation:shim 2.8s linear infinite}
@keyframes shim{from{background-position:130% 0}to{background-position:-130% 0}}
.evgo{font-size:12px;padding:4px 10px;border-radius:999px;background:#ede9fe;color:#6d28d9;transition:background .15s,color .15s}.evb:hover .evgo{background:#8b5cf6;color:#fff;text-decoration:none!important}
.evb{position:relative}.evgo{position:absolute;right:8px;top:10px}
.grid:has(.kscore){grid-template-columns:1fr 1fr .8fr .8fr 1.35fr}.kscore span{padding-right:18px}
.panel.edl,.panel.roster{box-shadow:inset 0 3px 0 var(--c-list),var(--sh)}.panel.edc{box-shadow:inset 0 3px 0 var(--c-detail),var(--sh)}
@media(max-width:900px){header{padding-bottom:60px}}
button:not(:disabled):active,.repbtn:active{transform:scale(.97)}
@media (prefers-reduced-motion:reduce){body::before,.pill.go,#donut svg{animation:none!important}.card:hover{transform:none}}

/* ===== Pools + Cameras tabs ===== */
#vPom,#vCam{padding:14px 24px 24px;max-width:1240px;margin:0 auto;animation:fadein .3s ease-out}
body[data-v=vPom] .vopt,body[data-v=vCam] .vopt{display:none}body[data-v=vPom] .bar,body[data-v=vCam] .bar{max-width:1240px;margin:0 auto}
.pbdate{display:flex;align-items:center;gap:8px;font-weight:600;font-size:13px;color:var(--ink2)}.pbdate input,#camDrv{font:inherit;padding:7px 10px;border:1px solid var(--line2);border-radius:10px;background:#fff}
.pbs{display:flex;align-items:center;gap:28px;flex-wrap:wrap;background:linear-gradient(110deg,#0a4660,#0e7490 60%,#14b8a6);color:#fff;border-radius:18px;padding:16px 24px;margin-bottom:14px;box-shadow:0 14px 30px -18px rgba(8,74,99,.8)}
.pbs>div{display:flex;flex-direction:column}.pbs b{font-size:26px;line-height:1.1;font-variant-numeric:tabular-nums}.pbs span{font-size:12.5px;opacity:.85}
.pbring{position:relative;width:64px;height:64px}.pbring svg{width:64px;height:64px;transform:rotate(-90deg)}.pbring circle{fill:none;stroke:rgba(255,255,255,.22);stroke-width:3.4}.pbring .fill{stroke:#a3e635;stroke-linecap:round;stroke-dasharray:var(--v) 100;animation:ringin 1s cubic-bezier(.2,.8,.2,1)}
@keyframes ringin{from{stroke-dasharray:0 100}}.pbring b{position:absolute;inset:0;display:grid;place-items:center;font-size:15px}
.tgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px}
.tcard{background:var(--card);border-radius:16px;padding:14px 16px;box-shadow:inset 0 3px 0 var(--c-list),var(--sh);animation:rise .4s cubic-bezier(.2,.8,.2,1) both;animation-delay:calc(var(--i,0)*35ms);transition:transform .2s,box-shadow .2s}
.tcard:hover{transform:translateY(-2px)}.tcard.fin{box-shadow:inset 0 3px 0 #22c55e,var(--sh)}.tcard.un{box-shadow:inset 0 3px 0 #f59e0b,var(--sh)}
.tcard .th{display:flex;align-items:center;gap:10px}.tcard .th>div:nth-child(2){flex:1;min-width:0}.tcard .th b{display:block;font-size:15px}
.tchip{font:inherit;font-size:12px;font-weight:600;color:var(--poolInk);background:var(--shallow);border:0;border-radius:999px;padding:2px 9px 2px 3px;margin-top:3px;cursor:pointer;display:inline-flex;align-items:center;gap:5px}.tchip:hover{background:var(--shallow2)}
.tpct{font-size:20px;font-weight:800;color:var(--poolInk);font-variant-numeric:tabular-nums}.tcard.fin .tpct{color:#16a34a;font-size:15px}
.pbar{height:8px;border-radius:99px;background:#e2f3f6;margin:12px 0 8px;overflow:hidden}.pbar i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,#22d3ee,#0891b2);animation:barin .9s cubic-bezier(.2,.8,.2,1) both}.tcard.fin .pbar i{background:linear-gradient(90deg,#86efac,#16a34a)}
@keyframes barin{from{width:0}}
.tmeta{font-size:12.5px;color:var(--muted)}.tmeta b{color:var(--ink)}
.tnext{margin-top:10px;padding:9px 12px;border-radius:12px;background:#f0fdff;border:1px solid #cffafe}.tnext span{display:block;font-size:10.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#0891b2}.tnext b{display:block;font-size:14px}.tnext small{color:var(--muted)}
.tnext.fin{background:#f0fdf4;border-color:#bbf7d0}.tnext.fin span{color:#16a34a}
.tcard details{margin-top:8px}.tcard summary{cursor:pointer;font-size:12.5px;font-weight:600;color:var(--poolInk)}
.tstops{list-style:none;margin:8px 0 0;padding:0;max-height:260px;overflow:auto}.tstops li{display:flex;gap:9px;align-items:flex-start;padding:6px 0;border-top:1px solid var(--line);font-size:13px}
.tstops i{flex:none;width:18px;height:18px;border-radius:50%;border:2px solid #cbd5e1;display:grid;place-items:center;font-size:11px;font-style:normal;color:#fff;margin-top:1px}.tstops li.done i{background:#22c55e;border-color:#22c55e}
.tstops span{flex:1;min-width:0}.tstops b{display:block;font-weight:600}.tstops small{color:var(--muted)}.tstops em{font-style:normal;font-size:12px;color:var(--muted);white-space:nowrap}.tstops li.done b{color:var(--muted)}
.ctypes{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px}.cchip{font:inherit;font-size:13px;font-weight:600;border:1px solid var(--line2);background:#fff;border-radius:999px;padding:6px 12px;cursor:pointer;transition:transform .15s,box-shadow .15s}
.cchip:hover{transform:translateY(-1px)}.cchip b{margin-left:4px;opacity:.7}.cchip.on{box-shadow:0 0 0 2px var(--ink);border-color:transparent}.cchip:not(.pill).on{background:var(--deep);color:#fff}
.cgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:12px}
.cgrid .evb{background:var(--card);box-shadow:inset 0 3px 0 var(--c-cams),var(--sh)!important;border-radius:14px;padding:12px;margin:0}.evtruck{color:var(--ink2);font-weight:600}.cgrid .evgo{position:static;align-self:center;white-space:nowrap}
@media(max-width:900px){#vPom,#vCam{padding:12px 16px}.tgrid,.cgrid{grid-template-columns:1fr}}

/* ===== v10: bubbles rising, shimmering name ===== */
#bubbles{position:fixed;inset:0;z-index:-1;pointer-events:none;overflow:hidden}
#bubbles i{position:absolute;bottom:-40px;border-radius:50%;background:radial-gradient(circle at 32% 30%,rgba(255,255,255,.95) 0 14%,rgba(165,243,252,.35) 40%,rgba(8,145,178,.12) 70%);box-shadow:inset 0 0 0 1px rgba(8,145,178,.25);animation:bub linear infinite}
@keyframes bub{0%{transform:translate(0,0)}25%{transform:translate(14px,-25vh)}50%{transform:translate(-10px,-50vh)}75%{transform:translate(12px,-75vh)}100%{transform:translate(0,-110vh)}}
.brand>div:last-child{background:linear-gradient(90deg,#fff 0%,#a5f3fc 30%,#fff 45%,#fde68a 60%,#fff 75%);background-size:300% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;animation:namesh 7s ease-in-out infinite}
.brand>div:last-child small{-webkit-text-fill-color:#a5f3fc;color:#a5f3fc}
.brand>div:last-child{text-shadow:none;filter:drop-shadow(0 1px 6px rgba(0,0,0,.3))}@keyframes namesh{0%,100%{background-position:0 0}50%{background-position:100% 0}}
@media (prefers-reduced-motion:reduce){#bubbles,.brand>div:last-child{animation:none!important}#bubbles{display:none}}

/* Cameras tab: day groups, big photo cards */
.cgrid{display:block}.cday{margin-bottom:22px}.cday h3{display:flex;align-items:baseline;gap:10px;margin:0 0 10px;font-size:16px;font-weight:700;color:var(--ink)}.cday h3 span{font-size:12.5px;font-weight:500;color:var(--muted)}
.cdgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px}
.ccard{font:inherit;text-align:left;color:inherit;border:0;padding:0;background:var(--card);border-radius:16px;overflow:hidden;cursor:pointer;box-shadow:var(--sh);transition:transform .2s cubic-bezier(.2,.8,.2,1),box-shadow .2s;animation:rise .35s ease-out both}
.ccard:hover,.ccard:focus-visible{transform:translateY(-3px);box-shadow:0 18px 32px -18px rgba(76,29,149,.55),var(--sh)}
.cmedia{position:relative;height:168px;display:flex;gap:2px;background:#0f172a}.cmedia figure{position:relative;flex:1;margin:0;overflow:hidden}
.cmedia img{width:100%;height:100%;object-fit:cover;display:block;transition:transform .4s}.ccard:hover .cmedia img{transform:scale(1.05)}
.cmedia figcaption{position:absolute;left:6px;bottom:6px;font-size:10.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:#fff;background:rgba(15,23,42,.6);padding:2px 7px;border-radius:6px}
.cmedia>.pill{position:absolute;left:10px;top:10px;box-shadow:0 2px 8px rgba(0,0,0,.25)}
.cplay{position:absolute;right:10px;top:10px;display:inline-flex;align-items:center;gap:4px;font-size:12px;font-weight:700;color:#fff;background:rgba(124,58,237,.9);padding:3px 9px 3px 6px;border-radius:999px}.cplay svg{width:14px;height:14px}
.cnone{flex:1;display:grid;place-items:center;color:#94a3b8;font-size:13px;background:repeating-linear-gradient(135deg,#1e293b 0 12px,#243247 12px 24px)}
.cprev{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;background:#000;z-index:1}
.cbody{padding:11px 14px 13px}.cbody>div{display:flex;align-items:center;gap:6px}.cbody b{font-size:15px}.cbody em{margin-left:auto;font-style:normal;font-size:13px;font-weight:600;color:var(--ink2);font-variant-numeric:tabular-nums}
.cbody small{display:block;margin-top:2px;color:var(--muted);font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
@media(max-width:900px){.cdgrid{grid-template-columns:1fr}}

/* ===== v11: a sun (or moon) that travels across the header sky ===== */
header[data-sky=night]::before{display:none}
.sun{position:absolute;z-index:0;width:34px;height:34px;margin-left:-17px;border-radius:50%;pointer-events:none;background:radial-gradient(circle at 40% 38%,#fffbe8,#fde047 45%,#f59e0b);box-shadow:0 0 22px 8px rgba(253,224,71,.55),0 0 70px 26px rgba(253,186,116,.28);transition:left 2s,top 2s}
.sun i{position:absolute;inset:-16px;border-radius:50%;background:repeating-conic-gradient(rgba(254,240,138,.55) 0 6deg,transparent 6deg 30deg);-webkit-mask:radial-gradient(circle,transparent 46%,#000 48%,transparent 72%);mask:radial-gradient(circle,transparent 46%,#000 48%,transparent 72%);animation:rays 24s linear infinite}
@keyframes rays{to{transform:rotate(360deg)}}
header[data-sky=dawn] .sun,header[data-sky=dusk] .sun{background:radial-gradient(circle at 40% 38%,#fff1e0,#fb923c 50%,#e11d48);box-shadow:0 0 26px 10px rgba(251,146,60,.55),0 0 90px 34px rgba(244,114,182,.3)}
.sun.moon{width:26px;height:26px;margin-left:-13px;background:radial-gradient(circle at 38% 36%,#fffef5,#fef3c7 55%,#e5d9b0);box-shadow:0 0 18px 4px rgba(254,243,199,.4)}.sun.moon i{display:none}
.sun.moon::after{content:'';position:absolute;width:7px;height:7px;left:13px;top:8px;border-radius:50%;background:rgba(180,160,110,.35);box-shadow:-6px 7px 0 -1px rgba(180,160,110,.3)}
@media (prefers-reduced-motion:reduce){.sun i{animation:none}}
@media(max-width:900px){.sun{display:none}}
</style></head><body>
<header>
 <div class="caus" aria-hidden="true"></div>
 <svg class="hwave" viewBox="0 0 1200 24" preserveAspectRatio="none" aria-hidden="true"><path d="M0 14 Q 75 0 150 14 T 300 14 T 450 14 T 600 14 T 750 14 T 900 14 T 1050 14 T 1200 14 T 1350 14 T 1500 14 T 1650 14 T 1800 14 T 1950 14 T 2100 14 T 2250 14 T 2400 14 V24 H0Z"/></svg>
 <div class="sun" aria-hidden="true"><i></i></div>
 <div id="floaty" aria-hidden="true"></div>
 <svg class="hwave front" viewBox="0 0 1200 24" preserveAspectRatio="none" aria-hidden="true"><path d="M0 14 Q 75 0 150 14 T 300 14 T 450 14 T 600 14 T 750 14 T 900 14 T 1050 14 T 1200 14 T 1350 14 T 1500 14 T 1650 14 T 1800 14 T 1950 14 T 2100 14 T 2250 14 T 2400 14 V24 H0Z"/></svg>
 <div class="brand"><div class="logo"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M3 9c1.5 1.3 3 1.3 4.5 0s3-1.3 4.5 0 3 1.3 4.5 0 3-1.3 4.5 0"/><path d="M3 15c1.5 1.3 3 1.3 4.5 0s3-1.3 4.5 0 3 1.3 4.5 0 3-1.3 4.5 0" opacity=".6"/></svg></div><div>Millennial Pools<small>Fleet</small></div></div>
 <div class="live" id="live"><span class="dot"></span><span id="upd">Connecting to Azuga...</span></div>
 <nav class="tabs"><span class="tabind" aria-hidden="true"></span><button data-v="vMap" class="on">Live map</button><button data-v="vEdit">Edit vehicles</button><button data-v="vDrv">Drivers</button><button data-v="vPom">Pools</button><button data-v="vCam">Cameras</button><a class="reptab" href="/report" target="_blank" rel="noopener">Score report</a></nav>
</header>
<div class="bar"><div class="search"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input id="q" placeholder="Search trucks or drivers" aria-label="Search trucks or drivers"></div><nav class="sum" id="sum" aria-label="Filter vehicles"></nav>
 <div class="vopt"><button id="voBtn" aria-expanded="false" aria-controls="voPop"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4"/></svg>View<span id="voHid"></span></button>
  <div id="voPop" class="vopop" hidden>
   <b>Show on the map</b>
   <label><input type="checkbox" data-o="hideNoDriver"> Hide trucks with no driver in Airtable</label>
   <label><input type="checkbox" data-o="hideUnlinked"> Hide trackers not in Airtable</label>
   <label><input type="checkbox" data-o="hideNoLoc"> Hide trucks with no location</label>
   <b>Sort the list</b>
   <select id="voSort"><option value="moving">Moving, parked, then no tracker</option><option value="number">Truck number</option><option value="driver">Driver name</option><option value="recent">Most recently active</option></select>
   <button class="link" id="voReset">Show everything</button>
  </div></div></div>
<div id="err"></div>
<dialog id="media" aria-label="Camera event"><div id="mbody"></div></dialog>
<dialog id="drvEd" aria-label="Edit driver"><form id="drvForm" autocomplete="off">
 <div class="mhead"><div><h3 id="deTitle" style="margin:0">Edit driver</h3><p class="muted" style="margin:2px 0 0">Saves to Airtable and Azuga</p></div><button type="button" class="dclose" id="deClose" aria-label="Close">×</button></div>
 <div class="fg">
  <label>Full name *<input name="name" maxlength="80" required></label>
  <label>License number<input name="license" maxlength="40"></label>
  <label>License state<input name="state" maxlength="20" placeholder="NJ"></label>
  <label>Insurance policy<input name="policy" maxlength="60" list="policyList"></label>
  <label>Status<select name="status"><option>Active</option><option>Inactive</option></select></label>
  <label>Date of birth<input name="dob" type="date"><span class="hint">Leave blank to keep what Airtable has</span></label>
  <label class="wide">Notes<input name="notes" maxlength="500"></label>
 </div>
 <div class="deTrucks"><div class="deth"><b>Trucks</b><input type="search" id="deTq" placeholder="Find a truck" aria-label="Find a truck"></div><div id="deTl"></div></div>
 <div class="deph"><span id="dePic"></span><label class="btn2"><input type="file" accept="image/*" capture="environment" id="dePhoto" hidden>Replace license photo</label><img id="dePrev" alt="" hidden></div>
 <div class="edb"><button type="button" class="btn2 danger" id="deDel">Delete driver</button><span id="deMsg" style="font-size:13px"></span><span style="flex:1"></span><button type="button" class="btn2" id="deCancel">Cancel</button><button class="btn2 pri" id="deSave">Save changes</button></div>
 <div class="dedz" id="deDz" hidden>
  <b>Delete <span id="deDzName"></span> from Airtable and Azuga?</b>
  <p>This removes their Airtable record and every Azuga login they have, and can't be undone. Azuga doesn't say what happens to a deleted driver's trip and camera history, so if you may need it, or they might come back, set Status to Inactive instead.</p>
  <label>Type their name to confirm<input id="deDzIn" autocomplete="off"></label>
  <div class="edb" style="border:0;padding:0;margin:0"><span style="flex:1"></span><button type="button" class="btn2" id="deDzNo">Keep driver</button><button type="button" class="btn2 dangerpri" id="deDzYes" disabled>Delete for good</button></div>
 </div>
</form></dialog>
<div id="vMap">
<main><div id="list"><div class="card"><div class="av none"></div><div class="ci"><div class="sk" style="width:60%"></div><div class="sk" style="width:40%"></div><div class="sk" style="width:80%"></div></div></div><div class="card"><div class="av none"></div><div class="ci"><div class="sk" style="width:60%"></div><div class="sk" style="width:40%"></div><div class="sk" style="width:80%"></div></div></div><div class="card"><div class="av none"></div><div class="ci"><div class="sk" style="width:60%"></div><div class="sk" style="width:40%"></div><div class="sk" style="width:80%"></div></div></div><div class="card"><div class="av none"></div><div class="ci"><div class="sk" style="width:60%"></div><div class="sk" style="width:40%"></div><div class="sk" style="width:80%"></div></div></div></div>
<button type="button" class="minb" data-min="list" style="grid-area:1/1" title="Minimize truck list" aria-label="Minimize truck list">–</button><div id="right"><button type="button" class="minb" data-min="donut" style="grid-area:donut" title="Minimize events chart" aria-label="Minimize events chart">–</button><button type="button" class="minb" data-min="cams" style="grid-area:cams" title="Minimize camera events" aria-label="Minimize camera events">–</button><div id="donut" class="pane"></div><div id="map"></div><div id="cams" class="pane"><div class="ph"><h3>Camera events</h3><span id="camN">last 7 days</span></div><div id="vids"></div></div><div id="detail"></div></div></main><div id="dock" hidden role="toolbar" aria-label="Minimized panels"></div></div>
<div id="vDrv" hidden>
 <div class="crewhead">
  <div><h2>Your crew</h2><p id="drvCount" class="muted">Loading drivers from Airtable...</p></div>
  <span style="flex:1"></span>
  <nav class="sum" id="dsum" aria-label="Filter drivers"></nav>
  <button class="btn2 pri" id="newDrvBtn">+ Add driver</button>
 </div>
 <form id="newDrv" hidden autocomplete="off" class="panel nd">
  <h3 style="margin:0 0 6px">Add a driver</h3>
  <div class="scan">
   <label class="btn2"><input type="file" accept="image/*" capture="environment" id="scanBack" hidden>Scan back of license</label>
   <label class="btn2"><input type="file" accept="image/*" capture="environment" id="scanFront" hidden>Add photo of front</label>
   <img id="frontPrev" alt="" hidden>
   <span id="scanMsg" class="hint">Scan the barcode on the back to fill in name, license number, state and birthday.</span>
  </div>
  <div class="fg">
   <label>Full name *<input name="name" maxlength="80" required></label>
   <label>License number<input name="license" maxlength="40"></label>
   <label>License state<input name="state" maxlength="20" placeholder="NJ"></label>
   <label>Insurance policy<input name="policy" maxlength="60" list="policyList"></label>
   <label>Date of birth<input name="dob" type="date"><span class="hint">Saved to Airtable only, never shown here</span></label>
   <label>Notes<input name="notes" maxlength="500"></label>
  </div>
  <fieldset><legend><label style="display:inline-flex;gap:6px;align-items:center;font-size:12px"><input type="checkbox" name="addToAzuga" checked> Also add to Azuga</label></legend>
   <div class="fg" id="azFields"><label>Email (optional)<input name="email" type="email" maxlength="120"><span class="hint">Leave blank and we make one from the office inbox</span></label><label>Phone (optional)<input name="phone" type="tel" maxlength="20" placeholder="732-555-0100"></label></div></fieldset>
  <div class="edb"><span id="ndMsg" style="font-size:13px"></span><span style="flex:1"></span><button type="button" class="btn2" id="ndCancel">Cancel</button><button class="btn2 pri" id="ndSave">Save driver</button></div>
 </form>
 <datalist id="policyList"></datalist>
 <div class="syncp" id="syncD"></div>
 <div id="dupes"></div>
 <div class="panel roster" id="drvRows"><div class="rrow"><div class="mav sk" style="height:36px;width:36px;border-radius:50%"></div><div style="flex:1"><div class="sk" style="width:30%"></div><div class="sk" style="width:20%"></div></div></div><div class="rrow"><div class="mav sk" style="height:36px;width:36px;border-radius:50%"></div><div style="flex:1"><div class="sk" style="width:30%"></div><div class="sk" style="width:20%"></div></div></div><div class="rrow"><div class="mav sk" style="height:36px;width:36px;border-radius:50%"></div><div style="flex:1"><div class="sk" style="width:30%"></div><div class="sk" style="width:20%"></div></div></div><div class="rrow"><div class="mav sk" style="height:36px;width:36px;border-radius:50%"></div><div style="flex:1"><div class="sk" style="width:30%"></div><div class="sk" style="width:20%"></div></div></div><div class="rrow"><div class="mav sk" style="height:36px;width:36px;border-radius:50%"></div><div style="flex:1"><div class="sk" style="width:30%"></div><div class="sk" style="width:20%"></div></div></div><div class="rrow"><div class="mav sk" style="height:36px;width:36px;border-radius:50%"></div><div style="flex:1"><div class="sk" style="width:30%"></div><div class="sk" style="width:20%"></div></div></div></div>
</div>
<div id="vPom" hidden>
 <div class="crewhead"><div><h2>Pool routes</h2><p id="pbCount" class="muted">Loading today&rsquo;s schedule from Pool Office Manager...</p></div><span style="flex:1"></span>
  <label class="pbdate">Day <input type="date" id="pbDate"></label></div>
 <div id="pbSum"></div><div id="pbList" class="tgrid"></div>
</div>
<div id="vCam" hidden>
 <div class="crewhead"><div><h2>Camera events</h2><p id="camCount" class="muted">Loading the last 7 days from Azuga...</p></div><span style="flex:1"></span>
  <select id="camDrv" aria-label="Filter by driver"><option value="">All drivers</option></select></div>
 <div id="camTypes" class="ctypes"></div><div id="cgrid" class="cgrid"></div>
</div>
<div id="vEdit" hidden><div class="ed">
 <aside class="panel edl"><div class="edf"><label><input type="checkbox" id="needs"> Only show trucks that need attention</label><div id="syncBar" style="margin-top:10px"></div><div class="syncp sm" id="syncE"></div></div><div id="edList"></div></aside>
 <section class="panel edc" id="edCard"><div class="empty">Pick a truck on the left to edit it.</div></section>
</div></div>
<script>
const $=id=>document.getElementById(id);
const svg=d=>'<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+d+'</svg>';
const ICON={pin:svg('<path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>'),
 file:svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>'),
 play:svg('<path d="M8 5v14l11-7z"/>'),
 truck:svg('<path d="M3 7h11v9H3z"/><path d="M14 10h4l3 3v3h-7"/><circle cx="7" cy="17.5" r="1.6"/><circle cx="17" cy="17.5" r="1.6"/>'),check:svg('<path d="M5 12.5l4.5 4.5L19 7"/>')};
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>'&#'+c.charCodeAt(0)+';');
// Azuga wraps lists differently per endpoint; grab the first array we find
const list=x=>Array.isArray(x)?x:x&&typeof x==='object'?(Object.values(x).map(list).find(a=>a.length)||[]):[];
const pick=(o,...k)=>{for(const key of k)if(o&&o[key]!=null&&o[key]!=='')return o[key]};
const vid=v=>pick(v,'trackeeId','vehicleId','id');
const vname=v=>pick(v,'trackeeName','vehicleName','name')||'Vehicle';
// Clean name from Airtable when linked ("2009 Chevrolet Colorado"); Azuga's own name otherwise
const atTitle=id=>{const L=link(id);if(!L||!L.linked)return '';const t=L.truck;return [t.year,t.make,t.model].map(x=>String(x||'').trim()).filter(Boolean).join(' ')};
const title=r=>atTitle(vid(r))||(/^\\d+$/.test(vname(r))?'Unnamed tracker '+vname(r):vname(r));
const azSub=r=>{const t=atTitle(vid(r));return t&&t.toLowerCase()!==vname(r).toLowerCase()?'<small class="azn">Azuga: '+esc(vname(r))+'</small>':''};
// Unnamed drivers come through as a phone number like "9052487042 ."
// Driver shown on the map: Azuga's, or Airtable's when Azuga has none
// Airtable's Current Driver wins (it's the master); Azuga's driver only when the truck isn't linked or has none there
// Linked trucks: Airtable's Current Driver only (blank = no driver). Unlinked: Azuga's, ignoring device placeholders like "9012302049 ."
const who=r=>{const L=link(vid(r));if(L&&L.linked)return L.truck.driver?L.truck.driver.name:'';const d=dname(r);return /[a-z]/i.test(d)?d:''};
const dname=v=>{const n=String(pick(v,'driverName','userName','driverFullName')||[v.driverFirstName,v.driverLastName].filter(Boolean).join(' ')).replace(/[ .]+$/,'').trim();return n};
const initials=n=>/[a-z]/i.test(n)?n.split(/ +/).map(w=>w[0]).slice(0,2).join('').toUpperCase():'?';
// Azuga sends several odometers: prefer the truck's own reading, then Azuga's current estimate.
// (vehicleDeviceOdoReading is the reading at tracker install, so it's stale.)
const odo=r=>{const v=(r.odo_support&&+r.vehicleSupportedOdoValue)||+r.vehicleDeviceCurrentodoReading||+r.totalDistanceTravelled||+r.odometerReading;return v>0?Math.round(v).toLocaleString()+' mi'+(r.odo_support?'':' (Azuga estimate)'):'Not reported yet'};
const when=t=>+t>1e11?new Date(+t).toLocaleString([], {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):(t||'');
// Azuga sends km/h unless a unit field says miles; convert to mph
const speed=r=>{const s=+pick(r,'speed')||0;return /mi|mph/i.test(String(pick(r,'speedUnit','speedUom','unitOfMeasure','distanceUnit')||''))?s:s*0.621371};
// Old (stored) locations and finished trips keep their last speed, so don't count them as moving
const moving=r=>speed(r)>0&&r.storedLocation!==true&&!/stop|end|park|idle|off/i.test(String(pick(r,'tripState','tripStatus')||''));
const status=r=>moving(r)?'<span class="pill go">'+Math.round(speed(r))+' mph</span>':'<span class="pill idle">Parked</span>';
// Make tag: a coloured name chip per brand (plain text, not the manufacturers' logos)
const MAKES={ford:['Ford','mk-ford'],chevrolet:['Chevy','mk-chevy'],chevy:['Chevy','mk-chevy'],gmc:['GMC','mk-gmc'],nissan:['Nissan','mk-nissan'],toyota:['Toyota','mk-toyota'],ram:['Ram','mk-ram'],dodge:['Dodge','mk-ram'],honda:['Honda','mk-honda'],jeep:['Jeep','mk-jeep']};
const makeTag=id=>{const L=link(id),v=all().find(x=>vid(x)==id)||vehicles.find(x=>vid(x)==id)||{};const m=clean0((L&&L.linked&&L.truck.make)||v.make).toLowerCase();if(!m)return '';const k=MAKES[m.split(' ')[0]];return '<span class="mk '+(k?k[1]:'mk-other')+'">'+esc(k?k[0]:m.replace(/^./,c=>c.toUpperCase()))+'</span>'};
const clean0=v=>String(v??'').trim();
// In the list the make tag already names the brand, so drop it from the title ("2022 Chevrolet Colorado" -> "2022 Colorado")
const shortTitle=r=>{const t=title(r),L=link(vid(r)),m=clean0((L&&L.linked&&L.truck.make)||r.make).toLowerCase();if(!m||!makeTag(vid(r)))return t;const s2=t.split(' ').filter(w=>w.toLowerCase()!==m).join(' ');return s2||t};
const tno=id=>{const L=link(id);return (L&&L.linked&&L.truck.truckNo?'<span class="tno">#'+esc(L.truck.truckNo.split(/[ ~(]/)[0])+'</span>':'')+makeTag(id)};
// Every person gets their own colour, the same everywhere (picked from their name)
const PCOL=[['#dbeafe','#1e40af'],['#dcfce7','#166534'],['#fef3c7','#92400e'],['#fce7f3','#9d174d'],['#ede9fe','#5b21b6'],['#ffedd5','#9a3412'],['#cffafe','#155e75'],['#fee2e2','#991b1b'],['#e0e7ff','#3730a3'],['#ecfccb','#3f6212'],['#f5d0fe','#86198f'],['#ccfbf1','#115e59']];
const pcol=n=>{let h=0;for(const c of String(n).toLowerCase().replace(/[^a-z]/g,''))h=(h*31+c.charCodeAt(0))>>>0;const [bg,fg]=PCOL[h%PCOL.length];return 'background:'+bg+';color:'+fg};
const avatar=(d,big)=>{const named=/[a-z]/i.test(d);return '<div class="av'+(named?'':' none')+'" style="'+(named?pcol(d)+';':'')+(big?'width:44px;height:44px;font-size:14px':'')+'">'+(named?esc(initials(d)):ICON.truck)+'</div>'};
const evName=e=>String(e||'Event').replace(/^CAM_/,'').replace(/_MESSAGE$/,'').replace(/_/g,' ').toLowerCase().replace(/^./,c=>c.toUpperCase()).replace('Hard breaking','Hard braking').replace('Real time disconnect event','Camera disconnected');
const evClass=e=>/FATIGUE|DISTRACT|VIOLENT|COLLISION|PHONE|SMOK|SPEED/i.test(e)?'bad':'warn';
const links=o=>JSON.stringify(o).match(/https?:[^"\\\\]+/g)||[];
let vehicles=[],locs=[],maint=null,sel=null,markers={};
const map=L.map('map',{zoomControl:true}).setView([40.2,-74.8],8);
// Humanitarian OSM style: brighter parks, water and roads. Falls back to standard OSM if its server struggles.
let tileErrs=0;const osm=()=>L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'&copy; OpenStreetMap',maxZoom:19});
const hot=L.tileLayer('https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png',{subdomains:'abc',attribution:'&copy; OpenStreetMap, tiles by HOT',maxZoom:19}).addTo(map);
hot.on('tileerror',()=>{if(++tileErrs===6){map.removeLayer(hot);osm().addTo(map)}});
const Legend=L.Control.extend({onAdd(){const d=L.DomUtil.create('div','legend');d.innerHTML='<span><i style="background:#16a34a"></i>Moving</span><span><i style="background:#0a2c40"></i>Parked</span><span><i style="background:#fff;border:2px solid #c2410c;border-radius:3px;box-shadow:none"></i>Office</span><button type="button">Show all trucks</button><button type="button" class="bigbtn" aria-pressed="false">Bigger map</button>';L.DomEvent.disableClickPropagation(d);d.querySelector('button').onclick=fitAll;d.querySelector('.bigbtn').onclick=()=>bigMap(!$('right').classList.contains('big'));return d}});
const MINS={list:'Truck list',donut:'Events chart',cams:'Camera events'};function applyMin(){const m=OPTS.min||[];document.querySelector('main').classList.toggle('min-list',m.includes('list'));['donut','cams'].forEach(k=>$('right').classList.toggle('min-'+k,m.includes(k)));const d=$('dock');d.hidden=!m.length;d.innerHTML=m.map(k=>'<button type="button" data-k="'+k+'" title="Show '+MINS[k].toLowerCase()+' again">+ '+MINS[k]+'</button>').join('');setTimeout(()=>map.invalidateSize(),0)}function setMin(k,on){const m=(OPTS.min||[]).filter(x=>x!==k);if(on)m.push(k);OPTS.min=m;saveOpts();applyMin()}document.addEventListener('click',e=>{const b=e.target.closest('.minb');if(b)return setMin(b.dataset.min,true);const c=e.target.closest('#dock button');if(c)setMin(c.dataset.k,false)});function bigMap(on){$('right').classList.toggle('big',on);const b=document.querySelector('.bigbtn');if(b){b.textContent=on?'Smaller map':'Bigger map';b.setAttribute('aria-pressed',on)}setTimeout(()=>{map.invalidateSize();const m=sel&&markers[sel];if(m)map.panTo(m.getLatLng(),{animate:false})},0)}
new Legend({position:'topright'}).addTo(map);
// Nearby trucks merge into one numbered bubble; trucks parked on the same spot fan out when clicked
const cluster=L.markerClusterGroup({showCoverageOnHover:false,maxClusterRadius:42,spiderfyOnMaxZoom:true,
  iconCreateFunction:c=>{const ms=c.getAllChildMarkers();return L.divIcon({className:'tm',html:'<span class="clu'+(ms.some(m=>m._mv)?' mv':'')+'">'+ms.length+'</span>',iconSize:[0,0]})}});
map.addLayer(cluster);
// The yard: 1041 Glassboro Rd (Rt 322), Williamstown. Trucks parked there group under a red office marker.
const OFFICE=[39.6900,-75.0243],OFFICE_M=250;
const atOffice=(lat,lng)=>map.distance([lat,lng],OFFICE)<OFFICE_M;
const OFFICE_SVG='<svg viewBox="0 0 24 24" fill="none" stroke="#c2410c" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 21V8l8-5 8 5v13"/><path d="M9 21v-6h6v6"/><path d="M9 10h.01M15 10h.01"/></svg>';
const officeGroup=L.markerClusterGroup({showCoverageOnHover:false,maxClusterRadius:200,spiderfyOnMaxZoom:true,zoomToBoundsOnClick:false,
  iconCreateFunction:c=>{const ms=c.getAllChildMarkers();return L.divIcon({className:'tm',html:'<span class="office'+(ms.some(m=>m._mv)?' mv':'')+'">'+OFFICE_SVG+'<b>'+ms.length+'</b></span>',iconSize:[0,0]})}});
officeGroup.on('clusterclick',e=>e.layer.spiderfy());
officeGroup.on('clustermouseover',e=>e.layer.bindTooltip('Office · '+e.layer.getChildCount()+' trucks in the yard · click to see them',{direction:'top',offset:[0,-20]}).openTooltip());
map.addLayer(officeGroup);
const officePin=L.marker(OFFICE,{icon:L.divIcon({className:'tm',html:'<span class="office empty">'+OFFICE_SVG+'</span>',iconSize:[0,0]}),keyboard:false,zIndexOffset:-100}).bindTooltip('Office · 1041 Glassboro Rd',{direction:'top',offset:[0,-16]});
let lastPts=[];function fitAll(){if(lastPts.length)map.fitBounds(lastPts,{paddingTopLeft:[40,80],paddingBottomRight:[40,40],maxZoom:13})}
let fitted=false;

async function get(p){const r=await fetch(p);const j=await r.json();if(j.error)throw new Error(j.error);return j}
function showErr(e){$('err').textContent=e?'Azuga is not answering right now ('+e.message+'). Showing the last data we have.':''}

async function refresh(){
  try{
    const [v,l]=await Promise.all([vehicles.length?null:get('/api/vehicles'),get('/api/locations')]);
    if(v)vehicles=list(v);locs=list(l);showErr();
    $('upd').textContent='Live · '+new Date().toLocaleTimeString([], {hour:'numeric',minute:'2-digit'});$('live').classList.remove('down');
  }catch(e){showErr(e);$('upd').textContent='Reconnecting...';$('live').classList.add('down')}
  // A drawing problem is not Azuga's fault: rebuild the map pins quietly instead of showing the Azuga banner
  try{render()}catch(e){console.error('Map redraw failed, rebuilding pins:',e);
    try{cluster.clearLayers();officeGroup.clearLayers()}catch(_){}Object.keys(markers).forEach(k=>delete markers[k]);
    try{render()}catch(e2){console.error('Map redraw failed again:',e2)}}
}
function all(){
  const byId={};vehicles.forEach(v=>byId[vid(v)]=v);
  return locs.length?locs.map(l=>({...byId[vid(l)],...l})):vehicles;
}
let filt='all';
// View options (kept per browser). Trucks with no driver are hidden unless you ask for them.
const OPT_DEF={hideNoDriver:true,hideUnlinked:false,hideNoLoc:false,sort:'moving'};
let OPTS={...OPT_DEF};try{Object.assign(OPTS,JSON.parse(localStorage.getItem('fleetView')||'{}'))}catch(e){}
if(!OPTS.sortV2){OPTS.sort='moving';OPTS.sortV2=1;try{localStorage.setItem('fleetView',JSON.stringify(OPTS))}catch(e){}}   // new default for everyone, once
const saveOpts=()=>{try{localStorage.setItem('fleetView',JSON.stringify(OPTS))}catch(e){}};applyMin();
const hasDriver=r=>/[a-z]/i.test(who(r)),hasLoc=r=>+pick(r,'latitude','lat')&&+pick(r,'longitude','lng','lon');
const hiddenBy=r=>(OPTS.hideNoDriver&&!hasDriver(r))||(OPTS.hideUnlinked&&!(link(vid(r))||{}).linked)||(OPTS.hideNoLoc&&!hasLoc(r));
const visible=()=>all().filter(r=>!hiddenBy(r));
const tnum=r=>{const L=link(vid(r)),n=L&&L.linked&&parseInt(L.truck.truckNo);return isNaN(n)||!n?1e9:n};
// Moving trucks first, then parked trucks whose tracker is reporting, then trucks with no tracker signal
const tracked=r=>!!pick(r,'address','landmark'),grp=r=>moving(r)?0:tracked(r)?1:2,GRP=['Moving','Parked','Tracker unavailable'];
const SORTS={moving:(a,b)=>grp(a)-grp(b)||(grp(a)===0?speed(b)-speed(a):0)||title(a).localeCompare(title(b)),number:(a,b)=>tnum(a)-tnum(b)||title(a).localeCompare(title(b)),
  driver:(a,b)=>(who(a)||'~').localeCompare(who(b)||'~'),recent:(a,b)=>(+b.lastContactDate||0)-(+a.lastContactDate||0)};
function drawOpts(){document.querySelectorAll('#voPop [data-o]').forEach(c=>c.checked=!!OPTS[c.dataset.o]);$('voSort').value=OPTS.sort;
  const n=all().filter(hiddenBy).length;$('voHid').textContent=n?n+' hidden':'';$('voHid').className=n?'vohid':''}
$('voBtn').onclick=e=>{e.stopPropagation();const p=$('voPop');p.hidden=!p.hidden;$('voBtn').setAttribute('aria-expanded',!p.hidden);drawOpts()};
document.addEventListener('click',e=>{if(!e.target.closest('.vopt'))$('voPop').hidden=true});
$('voPop').onchange=e=>{const c=e.target;if(c.dataset.o)OPTS[c.dataset.o]=c.checked;if(c.id==='voSort')OPTS.sort=c.value;saveOpts();render()};
$('voReset').onclick=()=>{OPTS={...OPT_DEF,hideNoDriver:false};saveOpts();render()};
const FILTERS={all:['All trucks',()=>true,''],moving:['Moving',moving,'var(--goDot)'],parked:['Parked',r=>!moving(r),'var(--idleDot)'],nodriver:['No driver',r=>!/[a-z]/i.test(who(r)),'var(--warnDot)']};
function rows(){
  const q=$('q').value.toLowerCase();
  // Picking "No driver" (or searching) always shows those trucks, even when the view hides them
  return (filt==='nodriver'||q?all():visible()).filter(r=>FILTERS[filt][1](r)&&(!q||(title(r)+' '+vname(r)+' '+who(r)).toLowerCase().includes(q)))
    .sort(SORTS[OPTS.sort]||SORTS.moving);
}
let listSig='',countWas={};
// Numbers roll up to their new value instead of snapping
function countUp(el,from,to){if(from===to||matchMedia('(prefers-reduced-motion: reduce)').matches){el.textContent=to;return}
  const t0=performance.now(),d=600;const step=t=>{const k=Math.min(1,(t-t0)/d),e=1-Math.pow(1-k,3);el.textContent=Math.round(from+(to-from)*e);if(k<1)requestAnimationFrame(step)};requestAnimationFrame(step)}
function render(){
  const a=visible(),rs=rows();
  $('sum').innerHTML=Object.entries(FILTERS).map(([k,[label,fn,c]])=>'<button data-f="'+k+'" aria-pressed="'+(filt===k)+'">'+(c?'<span class="dot" style="background:'+c+'"></span>':'')+label+' <b data-n="'+(k==='nodriver'?all():a).filter(fn).length+'">'+(countWas[k]??0)+'</b></button>').join('');
  $('sum').querySelectorAll('b[data-n]').forEach((b,i)=>{const k=Object.keys(FILTERS)[i];countUp(b,countWas[k]??0,+b.dataset.n);countWas[k]=+b.dataset.n});
  drawOpts();
  $('sum').querySelectorAll('button').forEach(b=>b.onclick=()=>{filt=b.dataset.f;render()});
  const emptyMsg=!a.length?'<b>No trucks yet</b>Once Azuga reports your trucks, they show up here.'
    :filt==='moving'&&!$('q').value?'<b>Every truck is parked</b>Nothing on the road right now.'
    :filt==='nodriver'&&!$('q').value?'<b>Every truck has a driver</b>Nice and tidy.'
    :'<b>No matches</b>Try a different search, or pick All trucks above.';
  const sig=rs.map(vid).join(),fresh=sig!==listSig;listSig=sig;
  const gcount=[0,0,0];rs.forEach(r=>gcount[grp(r)]++);const byGrp=(OPTS.sort||'moving')==='moving';
  $('list').innerHTML=rs.length?rs.map((r,i)=>{const d=who(r),named=/[a-z]/i.test(d),g=grp(r);return (byGrp&&(i===0||grp(rs[i-1])!==g)?'<div class="lgrp g'+g+'"><span>'+GRP[g]+'</span><b>'+gcount[g]+'</b></div>':'')+'<div class="card'+(sel==vid(r)?' sel':'')+(fresh?' rise':'')+'" style="--i:'+Math.min(i,14)+'" data-id="'+esc(vid(r))+'" tabindex="0" role="button">'+avatar(d)+'<div class="ci"><div class="top"><b>'+tno(vid(r))+esc(shortTitle(r))+'</b>'+status(r)+'</div><div class="d">'+(named?esc(d)+scoreChip(d):'<span class="muted">No driver assigned</span>')+'</div><div class="a">'+(pick(r,'address','landmark')?esc(pick(r,'address','landmark')):'<span class="trk">Tracker unavailable</span>')+'</div></div></div>'}).join(''):'<div class="empty">'+emptyMsg+'</div>';
  document.querySelectorAll('.card').forEach(c=>c.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();select(c.dataset.id)}});
  document.querySelectorAll('.card').forEach(c=>c.onclick=()=>select(c.dataset.id));
  const pts=[],shown=new Set(rs.map(vid));
  Object.entries(markers).forEach(([id,m])=>{if(!shown.has(id)){cluster.removeLayer(m);officeGroup.removeLayer(m)}});let nOffice=0;
  rs.forEach(r=>{const lat=+pick(r,'latitude','lat'),lng=+pick(r,'longitude','lng','lon');if(!lat||!lng)return;pts.push([lat,lng]);
    const id=vid(r),isSel=sel==id,mv=moving(r),L2=link(id),num=L2&&L2.linked&&L2.truck.truckNo?L2.truck.truckNo.split(/[ ~(]/)[0]:'';
    const label=num||(/[a-z]/i.test(who(r))?initials(who(r)):'')||ICON.truck;
    const html='<span class="pin'+(mv?' mv':'')+(isSel?' sel':'')+'">'+(num||!/</.test(label)?esc(label):label)+'</span>';
    // A marker that moves is taken out of its cluster group, moved, then put back: moving it while clustered can crash the cluster plugin
    const home=atOffice(lat,lng)?officeGroup:cluster,away=home===cluster?officeGroup:cluster;if(home===officeGroup)nOffice++;
    let m=markers[id];
    try{
      if(!m)m=markers[id]=L.marker([lat,lng],{icon:L.divIcon({className:'tm drop',html,iconSize:[0,0]}),keyboard:false}).on('click',()=>select(id));
      const ll=m.getLatLng(),movedTo=ll.lat!==lat||ll.lng!==lng;
      if(away.hasLayer(m))away.removeLayer(m);
      if(movedTo&&home.hasLayer(m))home.removeLayer(m);
      if(movedTo)m.setLatLng([lat,lng]);
      if(!home.hasLayer(m))home.addLayer(m);
    }catch(e){   // the cluster plugin lost track of this marker: start it fresh
      try{cluster.removeLayer(m);officeGroup.removeLayer(m)}catch(_){}
      m=markers[id]=L.marker([lat,lng],{icon:L.divIcon({className:'tm',html,iconSize:[0,0]}),keyboard:false}).on('click',()=>select(id));m._html=html;home.addLayer(m)}
    m._mv=mv;
    if(m._html!==html){m.setIcon(L.divIcon({className:'tm',html,iconSize:[0,0]}));m._html=html}
    m.setZIndexOffset(isSel?1000:mv?500:0).bindTooltip(esc(title(r))+(/[a-z]/i.test(who(r))?' · '+esc(who(r)):'')+(mv?' · '+Math.round(speed(r))+' mph':''),{direction:'top',offset:[0,-14]});
  });
  try{cluster.refreshClusters();officeGroup.refreshClusters()}catch(e){console.warn('cluster refresh',e)}
  if(nOffice<2&&!map.hasLayer(officePin))officePin.addTo(map);else if(nOffice>=2&&map.hasLayer(officePin))map.removeLayer(officePin);   // landmark when the yard is (nearly) empty
  lastPts=pts;if(!fitted&&pts.length){fitAll();fitted=true}
}
async function select(id){
  sel=id;$('right').classList.add('open');setTimeout(()=>map.invalidateSize(),0);render();const r=all().find(x=>vid(x)==id)||{};
  const mk=markers[id];if(mk)map.setView(mk.getLatLng(),Math.max(map.getZoom(),15),{animate:false});  // one jump; the step-by-step cluster zoom felt slow
  const d=who(r),named=/[a-z]/i.test(d),mmy=[r.year,r.make,r.model].filter(Boolean).join(' ');
  $('detail').innerHTML='<div class="dh">'+avatar(d,1)+'<div><h2>'+tno(id)+esc(title(r))+'</h2>'+azSub(r)+'<p>'+(named?esc(d):'No driver assigned')+(()=>{const az=dname(r),L=link(id),n=s=>String(s||'').toLowerCase().replace(/[^a-z]/g,'');return L&&L.linked&&named&&/[a-z]/i.test(az)&&n(az)!==n(d)?flag('Azuga has '+az+' assigned to this truck, but Airtable says '+d+'. The site goes by Airtable; the next sync should update Azuga.'):''})()+(mmy&&!title(r).includes(mmy)?' · '+esc(mmy):'')+'</p></div><div style="margin-left:auto;display:flex;align-items:center">'+status(r)+(named?'<a class="repbtn" href="/report?driver='+encodeURIComponent(d)+'" target="_blank" rel="noopener">Driver report</a>':'')+'<button class="dclose" id="dclose" aria-label="Close details">×</button></div></div>'
   +'<div class="grid"><div class="kv"><span>Odometer</span><b>'+esc(odo(r))+'</b></div><div class="kv"><span>Speed</span><b>'+(moving(r)?Math.round(speed(r)):0)+' mph</b></div><div class="kv"><span>Group</span><b>'+esc(pick(r,'groupName')||'–')+'</b></div><div class="kv"><span>Plate</span><b>'+esc(pick(r,'licensePlate','licensePlateNo','plateNumber')||'–')+'</b></div><div class="kv kscore" id="kscore"><span>Driver score</span><b>…</b><small></small></div></div>'
   +'<div class="addr">'+ICON.pin+(pick(r,'address','landmark')?esc(pick(r,'address','landmark')):'<span class="trk">Tracker unavailable</span> <span class="muted">No location from Azuga for this truck right now.</span>')+'</div>'
   +'<div class="trailbar"><span>Where it\u2019s been</span>'+[['0','Off'],['6','6 h'],['24','24 h'],['72','3 days']].map(([h,l])=>'<button data-h="'+h+'"'+(h==='0'?' class="on"':'')+'>'+l+'</button>').join('')+'<em id="trailInfo"></em></div>'
   +'<div id="pomBox" class="pom" hidden></div>'
   +'<div id="rampBox" class="ramp"></div>'
   +atBox(id)
   +'<h3>Maintenance</h3><div id="m"><div class="sk" style="width:55%"></div></div>'
   +'<details><summary>All Azuga data for this vehicle</summary><pre>'+esc(JSON.stringify(r,null,2))+'</pre></details>';
  rampBox(id,named?d:'');scoreTile(id,named?d:'');pomBox(id,named?d:'');clearTrail();
  document.querySelectorAll('.trailbar button').forEach(b=>b.onclick=()=>{document.querySelectorAll('.trailbar button').forEach(x=>x.classList.toggle('on',x===b));+b.dataset.h?showTrail(id,+b.dataset.h):clearTrail()});
  try{if(!maint)maint=list(await get('/api/maintenance'));if(sel!=id)return;
    const m=maint.filter(x=>vid(x)==id||vname(x)==vname(r));
    $('m').innerHTML=m.length?m.map(x=>{const s=String(pick(x,'status','reminderStatus')||'');return '<div class="ev"><span class="pill '+(/over/i.test(s)?'bad':/up/i.test(s)?'warn':'idle')+'">'+esc(s||'Scheduled')+'</span><b>'+esc(pick(x,'serviceType','serviceName')||'Service')+'</b><span class="t">'+esc(when(pick(x,'nextServiceDate','dueDate')))+(pick(x,'nextServiceOdometer')?' · at '+esc(pick(x,'nextServiceOdometer'))+' mi':'')+'</span></div>'}).join(''):'<span class="muted">'+(r.maintenanceEnabled===false?'Maintenance tracking is off for this truck in Azuga.':'Nothing due.')+'</span>';
  }catch(e){if(sel!=id)return;$('m').innerHTML='<span class="muted">'+esc(e.message)+'</span>';retry(id)}
  $('vids').innerHTML='<div class="sk" style="width:70%"></div><div class="sk" style="width:50%"></div>';$('donut').innerHTML='<div class="sk" style="width:60%"></div>';
  try{const v=(await fleetVids()).filter(x=>x.vehicleId==id);if(sel!=id)return;
    TRUCKV=v;camType='';drawCams();
  }catch(e){if(sel!=id)return;$('vids').innerHTML='<span class="muted">'+esc(e.message)+'</span>';$('donut').innerHTML='';retry(id)}
}
function closeDetail(){clearTrail();sel=null;$('right').classList.remove('open','big');const bb=document.querySelector('.bigbtn');if(bb){bb.textContent='Bigger map';bb.setAttribute('aria-pressed',false)}setTimeout(()=>map.invalidateSize(),0);render()}
document.addEventListener('click',e=>{if(e.target.id==='dclose')closeDetail()});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('media').open&&sel&&!$('vMap').hidden)closeDetail()});
// Camera events: Azuga gives video links when a clip has uploaded, otherwise still photos from both cameras
let VIDS=[];
// Azuga stamps each event with whoever it had assigned at the time, and that can't be changed afterwards.
// Show the truck's current driver (Airtable), plus Azuga's stamp when it differs.
function evDriver(x){const az=[x.firstName,x.lastName].filter(Boolean).join(' ').replace(/[ .]+$/,'')||pick(x,'driverName')||'';
  const r=all().find(v=>vid(v)==(x.vehicleId||sel)),cur=r?who(r):'',real=/[a-z]/i.test(cur)?cur:/[a-z]/i.test(az)?az:'';
  const n=s=>String(s||'').toLowerCase().replace(/[^a-z]/g,'');return {name:real,azuga:/[a-z]/i.test(az)&&n(az)!==n(real)?az:''}}
function evRow(x,i,truck){const e=pick(x,'eventType','eventName'),md=evMedia(x),th=md.videos[0]&&md.videos[0].poster||md.snaps[0]&&md.snaps[0].url;
      const D=evDriver(x),drv=D.name;
      return '<button class="ev evb" data-i="'+i+'"'+'>'
        +(th?'<span class="evth"><img src="'+esc(th)+'" alt="" loading="lazy">'+(md.videos.length?'<i>'+ICON.play+'</i>':'')+'</span>':'<span class="evth none">'+(x.requested?'Waiting':'No media')+'</span>')
        +'<span class="evi">'+'<span class="pill '+evClass(e)+'">'+esc(evName(e))+'</span><span class="t">'+esc(when(pick(x,'eventTime','startTime')))+(drv?' · '+esc(drv):'')+(D.azuga?flag('The camera stamped this alert with '+D.azuga+', but Airtable lists '+(D.name||'someone else')+' as this truck\u2019s driver. The dashboard and score go by Airtable. If '+D.azuga+' was really driving, it belongs to them.'):'')+'</span>'
        +'<span class="muted" style="font-size:12px">'+(truck?'<b class="evtruck">'+esc(truck)+'</b> · ':'')+esc(pick(x,'address')||'')+'</span>'+'</span>'
        +'<span class="evgo">'+(md.videos.length?'Watch':md.snaps.length?'View photos':x.requested?'Waiting on camera':'')+'</span></button>'}
// ---- Selected truck: circle graph of its camera events; clicking a slice filters the list ----
let TRUCKV=[],camType='';
const CAMCOL=['#2a78d6','#eb6834','#1baf7a','#eda100','#e87ba4','#008300'],CAMOTHER='#8a9aa6';
function camGroups(v){const c={};v.forEach(x=>{const t=evName(pick(x,'eventType','eventName'));c[t]=(c[t]||0)+1});
  const g=Object.entries(c).sort((a,b)=>b[1]-a[1]),top=g.slice(0,6).map(([t,n],k)=>({t,n,col:CAMCOL[k]})),rest=g.slice(6);
  if(rest.length)top.push({t:'Other',n:rest.reduce((a,b)=>a+b[1],0),col:CAMOTHER,others:rest.map(r=>r[0])});return top}
function drawCams(){const v=TRUCKV,ev=v.filter(x=>!x.requested),g=camGroups(ev),tot=ev.length,R=70,C=2*Math.PI*R;let off=0;
  const arcs=g.map((x,ai)=>{const len=x.n/tot*C,a='<circle style="--d:'+ai*70+'ms" class="arc'+(camType&&camType!==x.t?' dim':'')+'" data-t="'+esc(x.t)+'" r="'+R+'" cx="90" cy="90" fill="none" stroke="'+x.col+'" stroke-width="26" stroke-dasharray="'+Math.max(len-(g.length>1?2:0),.5)+' '+C+'" stroke-dashoffset="'+(-off)+'"><title>'+esc(x.t)+': '+x.n+' ('+Math.round(x.n/tot*100)+'%)</title></circle>';off+=len;return a}).join('');
  const tr=all().find(x=>vid(x)==sel)||{},hasCam=!!(tr.safetyCam||tr.safetyCamSerialNumber);$('donut').innerHTML='<div class="ph"><h3>Events by type</h3><span>'+(camType?'Showing '+esc(camType.toLowerCase())+' · <button class="link" data-t="'+esc(camType)+'">show all</button>':'last 7 days · tap to filter')+'</span></div>'+(tot?'<div class="dbody"><svg viewBox="0 0 180 180" role="img" aria-label="Camera events by type"><g transform="rotate(-90 90 90)">'+arcs+'</g><text x="90" y="88" class="dn" id="dnN">'+tot+'</text><text x="90" y="108" class="dl">events, 7 days</text></svg>'
    +'<ul class="leg">'+g.map(x=>'<li><button data-t="'+esc(x.t)+'" class="'+(camType===x.t?'on':camType?'dim':'')+'"><i style="background:'+x.col+'"></i><span>'+esc(x.t)+'</span><b>'+x.n+'</b><em>'+Math.round(x.n/tot*100)+'%</em></button></li>').join('')+'</ul></div>'
    :'<div class="empty">'+(hasCam?'<b>No camera events this week</b>Camera '+esc(tr.safetyCam||tr.safetyCamSerialNumber)+' is installed. Safe driving.':'<b>No camera on this truck</b>Azuga has no SafetyCam linked to it.')+'</div>');
  if($('dnN')&&!camType)countUp($('dnN'),0,tot);
  const oth=(g.find(x=>x.t==='Other')||{}).others||[];
  VIDS=v.filter(x=>{const t=evName(pick(x,'eventType','eventName'));return !camType||t===camType||(camType==='Other'&&oth.includes(t))});
  $('camN').textContent=VIDS.length+' event'+(VIDS.length==1?'':'s')+(camType?' · '+camType.toLowerCase():' · last 7 days');$('vids').innerHTML=VIDS.length?VIDS.map((x,i)=>evRow(x,i)).join(''):'<span class="muted">'+(hasCam?'Nothing recorded in the last 7 days.':'No camera installed.')+'</span>'}
document.addEventListener('click',e=>{const t=e.target.closest('#donut [data-t]');if(t){camType=camType===t.dataset.t?'':t.dataset.t;drawCams()}});
function evMedia(x){
  const videos=(x.videoLinks||[]).flat().filter(v=>v&&v.videoLink).map(v=>({name:v.videoName||(v.videoIndex===2?'Driver facing':'Road facing'),url:v.videoLink,poster:v.thumbnailLink||''}));
  const snaps=(x.snapshotLinks||[]).flat().filter(s=>s&&s.snapshotLink).map(s=>({name:s.snapshotName||(s.snapshotIndex===2?'Driver facing':'Road facing'),url:s.snapshotLink}));
  const via=u=>'/api/media?u='+encodeURIComponent(u);
  videos.forEach(v=>{v.url=via(v.url);if(v.poster)v.poster=via(v.poster)});snaps.forEach(s=>s.url=via(s.url));
  snaps.sort((a,b)=>/road/i.test(b.name)-/road/i.test(a.name));
  return {videos,snaps};
}
function openMedia(i){
  const x=VIDS[i];if(!x)return;const md=evMedia(x),e=pick(x,'eventType','eventName'),D=evDriver(x),drv=D.name;
  $('mbody').innerHTML='<div class="mhead"><div><span class="pill '+evClass(e)+'">'+esc(evName(e))+'</span><h3>'+esc(when(pick(x,'eventTime','startTime')))+(drv?' · '+esc(drv):'')+'</h3><p class="muted">'+esc(pick(x,'address')||'')+(x.speed?' · '+Math.round(x.speed*0.621371)+' mph':'')+(D.azuga?' · Azuga recorded: '+esc(D.azuga):'')+'</p></div><button class="dclose" id="mclose" aria-label="Close">×</button></div>'
   +'<div class="mgrid">'+(md.videos.length?md.videos.map(v=>'<figure><video src="'+esc(v.url)+'" controls playsinline preload="metadata"'+(v.poster?' poster="'+esc(v.poster)+'"':'')+'></video><figcaption>'+esc(v.name)+' · <a href="'+esc(v.url)+'" target="_blank" rel="noopener">Open in new tab</a></figcaption></figure>').join('')
     :md.snaps.map(s=>'<figure><img src="'+esc(s.url)+'" alt="'+esc(s.name)+'"><figcaption>'+esc(s.name)+'</figcaption></figure>').join(''))+'</div>'
   +(md.videos.length?'':x.requested?'<p class="muted" style="margin:10px 0 0;font-size:13px">Clip requested. The camera uploads it the next time the truck is on; it will play here once it arrives.</p>':'<p class="muted" style="margin:10px 0 0;font-size:13px">'+(md.snaps.length?'Azuga only has photos for this event, no video clip.':'Azuga has no photos or video for this event.')+'</p>');
  $('media').showModal();const v=$('mbody').querySelector('video');if(v)v.play().catch(()=>{});
}
document.addEventListener('click',e=>{const b=e.target.closest('.evb');if(b&&!b.disabled)openMedia(+b.dataset.i);if(e.target.id==='mclose'||e.target.id==='media')closeMedia()});
function closeMedia(){$('media').close()}
$('media').addEventListener('close',()=>$('mbody').querySelectorAll('video').forEach(v=>v.pause()));
const retried=new Set();function retry(id){if(retried.has(id))return;retried.add(id);setTimeout(()=>{if(sel==id)select(id)},30000)}
// ---- Airtable (source of truth) ----
let AT=null;
async function loadAT(){try{AT=await get('/api/airtable')}catch(e){AT={connected:true,error:e.message,links:{}}}if(!$('vEdit').hidden)renderEdit();if(vehicles.length||locs.length)render()}
const link=id=>AT&&AT.links&&AT.links[id];
const docBtns=t=>{const d=[...t.insCard.map(f=>['Insurance card',f]),...t.files.map(f=>[f.name,f])];return d.length?'<div class="docs">'+d.map(([n,f])=>'<a class="btn" target="_blank" rel="noopener" href="'+esc(f.url)+'">'+ICON.file+esc(n)+'</a>').join('')+'</div>':'<div class="muted" style="margin-top:8px">No insurance card or other files in Airtable yet.</div>'};
const drvLine=d=>d?esc(d.name)+(d.license?' · License '+esc(d.state?d.state+' ':'')+esc(d.license):''):'None';
// Unlinked tracker: pick its Airtable truck and we copy that truck's VIN into Azuga, so they match from now on
function linkBox(v){
  if(!AT||!AT.connected||AT.error||!AT.notInAzuga)return atBox(vid(v));
  const L=link(vid(v)),opts=AT.notInAzuga.slice().sort((a,b)=>(parseInt(a.truckNo)||999)-(parseInt(b.truckNo)||999)||a.desc.localeCompare(b.desc));
  return '<div class="at off"><b style="color:var(--ink)">Not linked to Airtable</b>'+(L&&L.dupe?' (two Airtable trucks share this VIN)':'')+'<br>Pick the Airtable truck this tracker is in. Its VIN is copied to Azuga, and they stay linked from then on.'
   +'<div class="lnk"><select id="lnkSel"><option value="">Choose an Airtable truck...</option>'+opts.map(t=>{const ok=t.vinOk&&!t.dupVin;return '<option value="'+esc(t.vin)+'"'+(ok?'':' disabled')+'>'+esc((t.truckNo?'#'+t.truckNo.split(/[ ~(]/)[0]+' ':'')+(t.desc||'Truck'))+(ok?'':t.vinOk?' (VIN shared with another truck)':' (no valid VIN in Airtable)')+'</option>'}).join('')+'</select><button class="btn2 pri" id="lnkGo">Link</button></div><div class="note" id="lnkMsg"></div></div>';
}
document.addEventListener('click',async e=>{
  if(e.target.id!=='lnkGo')return;
  const vin=$('lnkSel').value,v=vehicles.find(x=>vid(x)==edSel),m=$('lnkMsg');
  if(!vin){m.textContent='Choose a truck first.';return}
  const label=$('lnkSel').options[$('lnkSel').selectedIndex].text;
  if(!confirm('Link '+vname(v)+' to Airtable truck '+label+'?\\n\\nThis sets the VIN in Azuga to '+vin+'.'))return;
  e.target.disabled=true;m.style.color='';m.textContent='Linking...';
  try{await post('/api/update',{trackeeId:vid(v),vin});vehicles=list(await get('/api/vehicles'));await loadAT();openEd(vid(v))}
  catch(err){m.style.color='var(--bad)';m.textContent=err.message;e.target.disabled=false}
});
function atBox(id){
  if(!AT)return '<div class="at off">Loading Airtable...</div>';
  if(!AT.connected)return '<div class="at off">Airtable is not connected yet.</div>';
  if(AT.error)return '<div class="at off">Airtable unavailable: '+esc(AT.error)+'</div>';
  const L=link(id);
  if(!L||!L.linked)return '<div class="at off">'+(L&&L.dupe?'Two Airtable trucks share this VIN. Fix the duplicate in Airtable to link it.':'Not linked to Airtable. This VIN is not in your Trucks table.')+'</div>';
  const t=L.truck;
  return '<div class="at"><h4>Paperwork from Airtable</h4><div class="kvs">'
   +'<div><span>Driver</span>'+drvLine(t.driver)+'</div><div><span>Plate</span>'+esc(t.plate||'–')+'</div><div><span>Insurance policy</span>'+esc(t.policy||'–')+'</div>'
   +'<div><span>Reg. renewal #</span>'+esc(t.regRenew||'–')+'</div><div><span>EZ Pass</span>'+esc(t.ezpass||'–')+'</div><div><span>VIN</span>'+esc(t.vin||'–')+'</div></div>'+docBtns(t)
   +(Object.keys(L.changes||{}).length?'<div class="note">Azuga is out of date for this truck. Open it in Edit vehicles to sync.</div>':'')+'</div>';
}

// ---- Edit tab: one truck at a time ----
const FIELDS=[
 ['Basics',[['name','Vehicle name','text',100],['make','Make','text',50],['model','Model','text',50],['year','Year','number']]],
 ['Registration',[['licensePlateNo','License plate','text',20],['vin','VIN','text',17],['assetno','Asset / truck number','number'],['ownership','Ownership','select',['Company','Employee','Leased','Rental']]]],
 ['Driver & mileage',[['userId','Assigned driver','driver'],['odometer','Odometer (miles)','number']]]];
const AT_FIELDS=['Airtable only',[['truckNo','Truck number','text',30],['policy','Insurance policy','text',60],['regRenew','Registration renewal #','text',40],['ezpass','EZ Pass','text',40],['active','Active in Azuga','check']]];
const PLATE_OK=/^[A-Z0-9]{2,8}$/;
// The value Airtable says a shared field should have (or undefined if Airtable has nothing usable)
function atWant(L,k){if(!L||!L.linked)return;const c=L.changes||{};return k in c?c[k]:undefined}
let edSel=null,driverList=null;
const vval=(v,k)=>k==='licensePlateNo'?pick(v,'licensePlateNo','licensePlate'):k==='odometer'?'':k==='name'?vname(v):v[k];
const missing=v=>[!v.vin&&'VIN',!pick(v,'licensePlateNo','licensePlate')&&'plate',!/[a-z]/i.test(dname(v))&&'driver'].filter(Boolean);
const outOfSync=v=>{const L=link(vid(v));return !!(L&&L.linked&&Object.keys(L.changes||{}).length)};
const bareTracker=v=>/^\\d+$/.test(vname(v))&&!v.vin;
const edRows=()=>{const q=$('q').value.toLowerCase();return vehicles.filter(v=>(!q||(title(v)+' '+vname(v)+' '+dname(v)).toLowerCase().includes(q))&&(!$('needs').checked||missing(v).length||outOfSync(v))).sort((a,b)=>bareTracker(a)-bareTracker(b)||title(a).localeCompare(title(b)))};
const dirtyCount=()=>document.querySelectorAll('#edCard .dirty').length;
function renderEdit(){
  const rs=edRows();
  $('edList').innerHTML=rs.length?rs.map(v=>{const m=missing(v);return '<div class="eli'+(edSel==vid(v)?' sel':'')+'" data-id="'+esc(vid(v))+'"><div><b>'+tno(vid(v))+esc(title(v))+'</b>'+azSub(v)+'<small>'+esc(/[a-z]/i.test(dname(v))?dname(v):'No driver')+(pick(v,'licensePlateNo','licensePlate')?' · '+esc(pick(v,'licensePlateNo','licensePlate')):'')+'</small></div>'+(outOfSync(v)?'<span class="pill warn">Sync</span>':m.length?'<span class="bang" title="Missing '+m.join(', ')+'" aria-label="Missing '+m.join(', ')+'">!</span>':'')+'</div>'}).join(''):'<div class="empty" style="padding:30px">'+(vehicles.length?'No trucks match.':'Loading...')+'</div>';
  document.querySelectorAll('.eli').forEach(e=>e.onclick=()=>openEd(e.dataset.id));
  const n=vehicles.filter(outOfSync).length;
  if(!syncing)$('syncBar').innerHTML=!AT?'':!AT.connected?'<span class="muted">Airtable not connected</span>':AT.error?'<span class="muted">Airtable unavailable</span>':n?'<button class="btn2 pri" id="syncAll" style="width:100%">Sync '+n+' truck'+(n>1?'s':'')+' from Airtable → Azuga</button>':'<span style="color:var(--go);display:inline-flex;gap:6px;align-items:center">'+ICON.check+'Azuga matches Airtable</span>';
  if($('syncAll'))$('syncAll').onclick=syncAll;
  if(!edSel&&rs.length)openEd(vid(rs[0]));
}
let syncing=false;
async function syncAll(){
  const todo=vehicles.filter(outOfSync);
  if(!confirm('Update '+todo.length+' trucks in Azuga to match Airtable?\\n\\n'+todo.map(v=>vname(v)+': '+Object.keys(link(vid(v)).changes).join(', ')).join('\\n')))return;
  syncing=true;let ok=0;const bad=[];
  for(let i=0;i<todo.length;i++){
    $('syncBar').innerHTML='<span class="muted">Syncing '+(i+1)+' of '+todo.length+': '+esc(vname(todo[i]))+'...</span>';
    for(let tries=1;;tries++){
      try{await post('/api/sync',{trackeeId:vid(todo[i])});ok++;break}
      catch(e){
        if(/limiting/i.test(e.message)&&tries<2){$('syncBar').innerHTML='<span class="muted">Azuga asked us to slow down. Waiting 60 seconds, then continuing...</span>';await new Promise(r=>setTimeout(r,60000));continue}
        bad.push(vname(todo[i])+': '+e.message);break}
    }
    await new Promise(r=>setTimeout(r,5000)); // stay under Azuga's per-minute limit
  }
  syncing=false;vehicles=list(await get('/api/vehicles'));await loadAT();renderEdit();
  $('syncBar').insertAdjacentHTML('afterbegin','<div style="margin-bottom:8px;color:'+(bad.length?'var(--bad)':'var(--go)')+'">Synced '+ok+' of '+todo.length+'.'+(bad.length?' Problems:<br>'+bad.map(esc).join('<br>'):'')+'</div>');
}
async function openEd(id){
  if(edSel&&edSel!=id&&dirtyCount()&&!confirm('You have unsaved changes on this truck. Discard them?'))return;
  edSel=id;renderEdit();const v=vehicles.find(x=>vid(x)==id);if(!v)return;
  const rs=edRows(),i=rs.findIndex(x=>vid(x)==id),m=missing(v);
  if(!driverList)try{driverList=list(await get('/api/drivers'))}catch(e){driverList=[]}
  const L=link(id),lk=L&&L.linked;
  const input=([k,label,type,opt])=>{let cur=vval(v,k);const orig=cur;
    if(type==='check'){const on=lk&&L.truck.active;return '<label class="chk"><input type="checkbox" name="'+k+'" data-orig="'+on+'"'+(on?' checked':'')+'> '+label+'</label>'}
    if(lk&&k in AT_ONLY_KEYS){cur=L.truck[k]||'';return '<label>'+label+'<input name="'+k+'" type="text" maxlength="'+opt+'" value="'+esc(cur)+'" data-orig="'+esc(cur)+'"></label>'}
    const want=atWant(L,k);const fa=want!==undefined&&k!=='userId';
    if(fa)cur=want;
    if(type==='select')return '<label>'+label+'<select name="'+k+'" data-orig="'+esc(cur||'')+'"><option value="">–</option>'+opt.map(o=>'<option'+(o===cur?' selected':'')+'>'+o+'</option>').join('')+'</select></label>';
    if(type==='driver'){const curId=v.userId||'',wantId=atWant(L,'userId'),curG=driverList.find(d=>d.ids.includes(curId)),selId=wantId||curId;const known=!!curG;return '<label>'+label+'<select name="userId" data-orig="'+esc(curId)+'"'+(wantId?' class="dirty"':'')+'>'+(known?'':'<option value="'+esc(curId)+'" selected>'+esc(/[a-z]/i.test(dname(v))?dname(v):'No driver')+'</option>')+driverList.map(d=>{const val=d===curG?curId:d.id;return '<option value="'+esc(val)+'"'+(val===selId?' selected':'')+'>'+esc(d.name)+'</option>'}).join('')+'</select>'+(wantId?'<span class="fromAt" style="align-self:flex-start">FROM AIRTABLE</span>':'')+(driverList.length?'':'<span class="hint">Could not load the driver list from Azuga.</span>')+'</label>'}
    return '<label>'+label+(fa?'<span class="fromAt">FROM AIRTABLE</span>':'')+'<input name="'+k+'" type="'+type+'" '+(opt?'maxlength="'+opt+'"':'')+' value="'+esc(cur??'')+'" data-orig="'+esc(orig??'')+'"'+(fa?' class="dirty"':'')+(k==='odometer'?' placeholder="Now: '+esc(odo(v))+'"':'')+'>'+(k==='odometer'?'<span class="hint">Leave blank to keep the current reading</span>':'')+'</label>'};
  $('edCard').innerHTML='<div class="edh"><div><h2>'+tno(vid(v))+esc(title(v))+'</h2>'+azSub(v)+'</div><span class="pos">'+(i+1)+' of '+rs.length+'</span></div>'

   +(lk?'<div class="at"><h4>Linked to Airtable'+(L.truck.truckNo?' truck #'+esc(L.truck.truckNo):'')+' · matched by '+esc(L.how)+'</h4>'
      +(Object.keys(L.changes).length?'Fields marked <span class="fromAt">FROM AIRTABLE</span> have newer info in Airtable. Click Save to update Azuga.':'Azuga matches Airtable.')
      +(L.notes||[]).map(n=>'<div class="note">'+esc(n)+'</div>').join('')+'<div style="margin-top:6px"><b>Driver in Airtable:</b> '+drvLine(L.truck.driver)+'</div>'+docBtns(L.truck)+'</div>'
     :linkBox(v))
   +[...FIELDS,...(lk?[AT_FIELDS]:[])].map(([g,fs])=>'<fieldset><legend>'+g+'</legend><div class="fg">'+fs.map(input).join('')+'</div></fieldset>').join('')
   +'<div class="edb"><button class="btn2" id="edPrev"'+(i>0?'':' disabled')+'>← Previous</button><button class="btn2" id="edNext"'+(i<rs.length-1?'':' disabled')+'>Next →</button><span style="flex:1"></span><span id="edMsg"></span><button class="btn2" id="edSave">Save</button><button class="btn2 pri" id="edSaveNext">Save &amp; next →</button></div>';
  const val=el=>el.type==='checkbox'?String(el.checked):el.value;
  $('edCard').querySelectorAll('input,select').forEach(el=>el.oninput=el.onchange=()=>{el.classList.toggle('dirty',val(el)!==el.dataset.orig);markNeed(el)});
  $('edCard').querySelectorAll('[name=vin],[name=licensePlateNo],[name=userId]').forEach(markNeed);
  const go=d=>{const n=rs[i+d];if(n)openEd(vid(n))};
  $('edPrev').onclick=()=>go(-1);$('edNext').onclick=()=>go(1);
  $('edSave').onclick=()=>saveEd(v,0,go);$('edSaveNext').onclick=()=>saveEd(v,1,go);
}
// Empty VIN, plate or driver gets an "!" on its box
function markNeed(el){
  if(!['vin','licensePlateNo','userId'].includes(el.name))return;
  const empty=el.name==='userId'?!/[a-z]/i.test(el.options[el.selectedIndex]?.text.replace('No driver','')||''):!el.value.trim();
  el.classList.toggle('need',empty);const lab=el.closest('label');let b=lab.querySelector('.bang');
  if(empty&&!b){b=document.createElement('span');b.className='bang';b.textContent='!';b.title='Missing';lab.firstChild.after(b)}else if(!empty&&b)b.remove();
}
async function saveEd(v,thenNext,go){
  const msg=$('edMsg'),body={trackeeId:vid(v)},lines=[];
  document.querySelectorAll('#edCard .dirty').forEach(el=>{const lbl=([...el.closest('label').childNodes].find(n=>n.nodeType===3&&n.textContent.trim())||{textContent:''}).textContent.trim();
    body[el.name]=el.type==='checkbox'?el.checked:el.type==='number'&&el.value!==''?Number(el.value):el.value;
    lines.push(lbl+': '+(el.type==='checkbox'?(el.checked?'Yes':'No'):el.tagName==='SELECT'?el.options[el.selectedIndex].text:el.value))});
  if(!lines.length){if(thenNext)return go(1);msg.className='';msg.textContent='Nothing changed.';return}
  if(!confirm('Save '+vname(v)+'?'+(AT&&AT.connected?' (Airtable first, then Azuga)':'')+'\\n\\n'+lines.join('\\n')))return;
  document.querySelectorAll('#edCard button').forEach(b=>b.disabled=true);msg.className='';msg.textContent='Saving...';
  try{const r=await fetch('/api/update',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const j=await r.json();if(j.error)throw new Error(j.error);
    vehicles=list(await get('/api/vehicles'));await loadAT();
    const doneMsg='Saved to '+j.saved.join(' and ')+' ✓'+(j.notes&&j.notes.length?' · '+j.notes.join(' '):'');
    document.querySelectorAll('#edCard .dirty').forEach(el=>el.classList.remove('dirty'));
    if(thenNext)go(1);else openEd(vid(v)).then(()=>{$('edMsg').className='ok';$('edMsg').textContent=doneMsg});
  }catch(err){msg.className='bad';msg.textContent=err.message;document.querySelectorAll('#edCard button').forEach(b=>b.disabled=false)}
}
$('needs').onchange=renderEdit;
const AT_ONLY_KEYS={truckNo:1,policy:1,regRenew:1,ezpass:1};

// ---- Drivers tab ----
let PEOPLE=null;
// ---- Azuga <-> Airtable sync status (Drivers + Edit vehicles tabs) ----
let SYNCST=null,syncOpen=false;
const ago=t=>{const m=Math.round((Date.now()-t)/6e4);return m<1?'just now':m<60?m+' min ago':Math.round(m/60)+' h ago'};
async function loadSync(){try{SYNCST=await get('/api/sync/status')}catch(e){SYNCST=null}drawSync()}
function drawSync(){const S=SYNCST;let h='';
  if(S&&!S.imported)h='<div class="simp"><div style="flex:1 1 380px"><b>Azuga and Airtable are not linked yet</b><p>First copy: the Azuga values replace the Airtable values for driver names, phones, license numbers and states, and truck plates, years, makes, models and drivers. Drivers only in Azuga get added to Airtable. A backup of the old Airtable values downloads first. After that, changes on either side sync every 5 minutes.</p></div><button class="btn2 pri" id="syncImp">Copy everything from Azuga</button></div>';
  else if(S){const L=S.last||{},n=(L.notes||[]).length;
    h='<div class="sbar'+(L.error?' bad':'')+'"><span class="sd"></span><span class="sp">'+(S.running?'Syncing with Azuga...':L.error?'Last sync failed: '+esc(L.error):L.at?'Synced with Azuga '+ago(L.at)+(L.toAirtable||L.toAzuga||L.created?' · '+[L.toAirtable&&L.toAirtable+' to Airtable',L.toAzuga&&L.toAzuga+' to Azuga',L.created&&L.created+' new'].filter(Boolean).join(', '):' · everything matches'):'Syncs with Azuga every 5 minutes')+(n?' · '+n+' need'+(n>1?'':'s')+' attention':'')+'</span>'
     +'<button id="syncLog">'+(syncOpen?'Hide details':'Details')+'</button><button id="syncNow"'+(S.running?' disabled':'')+'>Sync now</button></div>'
     +(syncOpen?'<ul class="slog">'+(L.notes||[]).map(x=>'<li class="n">'+esc(x)+'</li>').join('')+((S.log||[]).map(x=>'<li><time>'+ago(x.at)+'</time>'+esc(x.what)+'</li>').join('')||'<li class="muted">No changes yet.</li>')+'</ul>':'')}
  ['syncD','syncE'].forEach(id=>{if($(id))$(id).innerHTML=h});
  document.querySelectorAll('#syncNow').forEach(b=>b.onclick=()=>runSync('/api/sync/now',{}));
  document.querySelectorAll('#syncLog').forEach(b=>b.onclick=()=>{syncOpen=!syncOpen;drawSync()});
  document.querySelectorAll('#syncImp').forEach(b=>b.onclick=()=>{if(confirm('Copy everything from Azuga into Airtable?\\n\\nThe Azuga values will replace what Airtable has for driver names, phones and licenses, and truck plates, years, makes, models and drivers. A backup file of the old values downloads when it finishes.'))runSync('/api/sync/import',{confirm:'COPY'})})}
async function runSync(url,body){document.querySelectorAll('#syncNow,#syncImp').forEach(b=>{b.disabled=true;b.textContent='Syncing...'});
  try{const r=await post(url,body);
    if(r.backup&&r.backup.length){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(r.backup,null,2)],{type:'application/json'}));a.download='airtable-backup-'+new Date().toISOString().slice(0,16).replace(':','')+'.json';document.body.appendChild(a);a.click();a.remove()}
    syncOpen=!!(r.notes&&r.notes.length);driverList=null;await Promise.all([loadSync(),loadPeople(),loadAT()]);vehicles=list(await get('/api/vehicles'));render()}
  catch(e){toast(e.message,'bad');loadSync()}}
setInterval(()=>{if(!$('vDrv').hidden||!$('vEdit').hidden)loadSync()},60e3);
// ---- Pool party in the header: one floater at a time drifts across on the wave ----
const FLOATS={
 flamingo:{h:56,svg:'<svg viewBox="0 0 104 72"><defs><linearGradient id="fgR" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffa6d0"/><stop offset=".6" stop-color="#f0609c"/><stop offset="1" stop-color="#c93a74"/></linearGradient><radialGradient id="fgS" cx=".38" cy=".32" r=".75"><stop offset="0" stop-color="#f6d2b4"/><stop offset=".65" stop-color="#e2a982"/><stop offset="1" stop-color="#bf7f58"/></radialGradient><linearGradient id="fgN" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ff9ecb"/><stop offset="1" stop-color="#ea4f8f"/></linearGradient></defs>'
  +'<ellipse cx="48" cy="56" rx="36" ry="11.5" fill="url(#fgR)" stroke="#0b2533" stroke-opacity=".5" stroke-width="1.3"/><ellipse cx="48" cy="54" rx="21" ry="5.4" fill="#5d1435" opacity=".55"/>'
  +''
  +'<path d="M33 31Q25 36 23 44L21 50" stroke="#0b2533" stroke-opacity=".5" stroke-width="7.6" fill="none" stroke-linecap="round"/><path d="M33 31Q25 36 23 44L21 50" stroke="#dda07a" stroke-width="6" fill="none" stroke-linecap="round"/><ellipse cx="20.5" cy="51.5" rx="3.4" ry="2.4" fill="#dda07a" stroke="#0b2533" stroke-opacity=".5" stroke-width="1.3"/><path d="M31 36Q29 28 37 27H55Q63 28 62 36Q67 45 61 52H31Q25 45 31 36Z" fill="url(#fgS)" stroke="#0b2533" stroke-opacity=".5" stroke-width="1.3"/><path d="M35 34.5q3.5 4.5 8.5 2M48.5 36.5q5 2.5 8.5-2" stroke="#b47550" stroke-width="1" fill="none" opacity=".7"/><circle cx="39.5" cy="36" r=".7" fill="#b47550"/><circle cx="52.5" cy="36" r=".7" fill="#b47550"/><path d="M41 32.5l1 1.5M44 32l.6 1.6M47 32.4l-.4 1.6M50 32l-.8 1.5M45.6 37.6l.4 1.4M46.4 40.6l.3 1.2M43 35l.5 1.2M49 35l-.4 1.2" stroke="#9ca3af" stroke-width=".8" stroke-linecap="round"/><ellipse cx="42" cy="43" rx="7" ry="4" fill="#fff" opacity=".16"/><path d="M33 48q13 5 26 0" stroke="#b47550" stroke-width="1.2" fill="none" opacity=".6"/><ellipse cx="46.5" cy="45" rx=".9" ry="1.3" fill="#9a5f3c"/><path d="M30 50q16 5.5 32 0v3.4q-16 5.5-32 0z" fill="#dc2626"/><path d="M34 52v3M40 53.3v3M46 53.8v3M52 53.3v3M58 52v3" stroke="#fff" stroke-width="1.5"/><path d="M59 31Q66 40 70 35" stroke="#0b2533" stroke-opacity=".5" stroke-width="7.6" fill="none" stroke-linecap="round"/><path d="M59 31Q66 40 70 35" stroke="#dda07a" stroke-width="6" fill="none" stroke-linecap="round"/><path d="M70 23l5 12h-8.5z" fill="#e0f2fe" stroke="#0b2533" stroke-opacity=".5" stroke-width="1.3"/><path d="M68 28.5h6.4" stroke="#fb923c" stroke-width="3"/><circle cx="71" cy="31" r="1.3" fill="#dc2626"/><path d="M73 24l4-9" stroke="#92400e" stroke-width="1.2"/><path d="M73 17l9 2.5-7.5 4z" fill="#22c55e" stroke="#0b2533" stroke-opacity=".5" stroke-width="1.3"/><ellipse cx="70.5" cy="34" rx="3" ry="2.6" fill="#dda07a" stroke="#0b2533" stroke-opacity=".5" stroke-width="1.3"/><path d="M42 24h8v6q-4 2-8 0z" fill="#b47550"/><ellipse cx="37.4" cy="19" rx="1.7" ry="2.6" fill="#dda07a" stroke="#0b2533" stroke-opacity=".5" stroke-width="1.3"/><ellipse cx="54.6" cy="19" rx="1.7" ry="2.6" fill="#dda07a" stroke="#0b2533" stroke-opacity=".5" stroke-width="1.3"/><ellipse cx="46" cy="18" rx="8.6" ry="9.8" fill="url(#fgS)" stroke="#0b2533" stroke-opacity=".5" stroke-width="1.3"/><ellipse cx="44" cy="10.6" rx="3.6" ry="1.8" fill="#fff" opacity=".35"/><path d="M37.8 12.5q-1.2 5 1 9.5M54.2 12.5q1.2 5-1 9.5" stroke="#d4d4d8" stroke-width="2.6" fill="none" stroke-linecap="round"/><path d="M42 11.8q4-1 8 0M42.8 13.5q3.2-.8 6.4 0" stroke="#b47550" stroke-width=".7" fill="none" opacity=".7"/><path d="M39.5 15.4q2.7-1.4 5.4-.2M47.1 15.2q2.7-1.2 5.4.2" stroke="#e5e7eb" stroke-width="1.7" fill="none" stroke-linecap="round"/><path d="M39.2 16.6h5.8v2.8a2.2 2.2 0 0 1-2.2 2.2h-1.4a2.2 2.2 0 0 1-2.2-2.2zM47 16.6h5.8v2.8a2.2 2.2 0 0 1-2.2 2.2h-1.4a2.2 2.2 0 0 1-2.2-2.2z" fill="#111827"/><path d="M45 17.3h2M39.2 17l-1.6-.6M52.8 17l1.6-.6" stroke="#111827" stroke-width="1.1"/><path d="M40.3 17.8h2M48.1 17.8h2" stroke="#7dd3fc" stroke-width=".9" stroke-linecap="round"/><path d="M46 20q-1.7 3.4.2 4q1.3.3 1.9-.5" stroke="#b47550" stroke-width=".9" fill="none"/><ellipse cx="46.6" cy="23" rx="1.4" ry="1" fill="#e9a786"/><path d="M42.3 25.3q1.8-1.8 3.9-.9q2.1-.9 3.9.9q-1.6 1.2-3.9.4q-2.3.8-3.9-.4z" fill="#e5e7eb" stroke="#9ca3af" stroke-width=".5"/><path d="M44.4 26.9q1.8.9 3.6 0" stroke="#7c2d12" stroke-width="1" fill="none" stroke-linecap="round"/><path d="M39.6 24.5q1.4 4.4 6.4 4.8q5-.4 6.4-4.8" stroke="#b47550" stroke-width=".8" fill="none" opacity=".6"/>'
  +'<path d="M79 52C90 40 76 30 83 17" stroke="url(#fgN)" stroke-width="7.5" fill="none" stroke-linecap="round"/><path d="M80 48C87 40 79 32 83 22" stroke="#fff" stroke-width="1.6" opacity=".45" fill="none" stroke-linecap="round"/>'
  +'<ellipse cx="84.5" cy="14.5" rx="7" ry="6" fill="#ffa6d0" stroke="#0b2533" stroke-opacity=".5" stroke-width="1.3"/><path d="M90 12.6l8 3.4-7 3.6z" fill="#fde68a" stroke="#0b2533" stroke-opacity=".5" stroke-width="1.3"/><path d="M94.5 14.5l3.5 1.5-3.4 1.7z" fill="#111827"/><circle cx="85.8" cy="12.8" r="1.6" fill="#111827"/><circle cx="86.3" cy="12.3" r=".5" fill="#fff"/><path d="M80 9q3-4 6-1" stroke="#ea4f8f" stroke-width="1.6" fill="none"/>'
  +'<path d="M12 56a36 11.5 0 0 0 72 0" fill="url(#fgR)" stroke="#0b2533" stroke-opacity=".5" stroke-width="1.3"/><path d="M24 65l3-7.5M48 68v-8.5M72 65l-3-7.5" stroke="#fff" stroke-width="3.4" opacity=".9" stroke-linecap="round"/><path d="M18 54q9-6.5 18-7.5" stroke="#fff" stroke-width="2.2" opacity=".6" fill="none" stroke-linecap="round"/>'
  +'<ellipse cx="67" cy="58" rx="4" ry="2.6" fill="url(#fgS)" stroke="#0b2533" stroke-opacity=".5" stroke-width="1.3"/><ellipse cx="74" cy="56.5" rx="4" ry="2.6" fill="url(#fgS)" stroke="#0b2533" stroke-opacity=".5" stroke-width="1.3"/></svg>'},
 bread:{h:46,svg:'<svg viewBox="0 0 84 62"><defs><linearGradient id="brC" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e09a47"/><stop offset="1" stop-color="#97561c"/></linearGradient><radialGradient id="brI" cx=".45" cy=".38" r=".8"><stop offset="0" stop-color="#fff6dc"/><stop offset="1" stop-color="#eccd8f"/></radialGradient><linearGradient id="brB" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff7b0"/><stop offset="1" stop-color="#fcd34d"/></linearGradient></defs><g transform="rotate(-8 42 38)">'
  +'<path d="M12 54V31C12 13 27 9 34 16C39 5 59 5 61 17C73 10 81 21 75 32V54Z" fill="url(#brC)" stroke="#0b2533" stroke-opacity=".5" stroke-width="1.3"/>'
  +'<path d="M16.8 54V32C16.8 19.5 28 16.5 34 22.5C38.5 13 56 13 57 22.5C65.5 17 73 23.5 70.4 33V54Z" fill="url(#brI)"/>'
  +'<g fill="#dfbd7f" opacity=".9"><ellipse cx="27" cy="35" rx="1.9" ry="1.2"/><ellipse cx="44" cy="30" rx="1.6" ry="1"/><ellipse cx="53" cy="44" rx="2" ry="1.2"/><ellipse cx="34" cy="47" rx="1.4" ry=".9"/><ellipse cx="23" cy="47" rx="1.2" ry=".8"/><ellipse cx="62" cy="34" rx="1.2" ry=".8"/></g>'
  +'<path d="M33 30l13-3 4 9-13 3z" fill="url(#brB)" stroke="#0b2533" stroke-opacity=".5" stroke-width="1.3"/><path d="M37 38q1 5-1 7q3-1 3-6" fill="#fde68a"/><path d="M36 31.5l7-1.6" stroke="#fff" stroke-width="1.4" opacity=".8" stroke-linecap="round"/>'
  +'<path d="M24 22q9-7 16-1" stroke="#fff" stroke-width="2.3" opacity=".6" fill="none" stroke-linecap="round"/></g></svg>'},
 floater:{h:50,svg:'<svg viewBox="0 0 88 64"><defs><linearGradient id="flJ" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#60a5fa"/><stop offset=".45" stop-color="#2563eb"/><stop offset="1" stop-color="#1e3a8a"/></linearGradient><linearGradient id="flB" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ffffff"/><stop offset=".55" stop-color="#e8ebf0"/><stop offset="1" stop-color="#aab2be"/></linearGradient></defs>'
  +'<g transform="rotate(-24 27 32)"><rect x="8" y="15" width="31" height="33" rx="6.5" fill="url(#flJ)" stroke="#0b2533" stroke-opacity=".5" stroke-width="1.3"/><path d="M10 26h27" stroke="#1e40af" stroke-width="1.4" opacity=".6"/><rect x="14" y="7" width="12.5" height="10" rx="2.6" fill="#1e40af" stroke="#0b2533" stroke-opacity=".5" stroke-width="1.3"/><path d="M16.5 9v6M19.7 9v6M23 9v6" stroke="#60a5fa" stroke-width="1.1"/>'
  +'<path d="M33 18h4.5a3.2 3.2 0 0 1 3.2 3.2v8.6a3.2 3.2 0 0 1-3.2 3.2H33" fill="none" stroke="#1e3a8a" stroke-width="3.2"/><rect x="14" y="30" width="17" height="11" rx="1.6" fill="#fff" opacity=".95"/><rect x="14" y="30" width="17" height="3" rx="1" fill="#facc15"/><path d="M16.5 36h12M16.5 38.6h8" stroke="#94a3b8" stroke-width="1.2"/><path d="M12.3 19v25" stroke="#bfdbfe" stroke-width="2.6" opacity=".75" stroke-linecap="round"/></g>'
  +'<rect x="44" y="26" width="33" height="29" rx="3.6" fill="url(#flB)" stroke="#0b2533" stroke-opacity=".5" stroke-width="1.3"/><path d="M44 35h33" stroke="#cbd5e1" stroke-width="1.7"/><rect x="44" y="43" width="33" height="6" fill="#f97316"/><text class="nf" x="60.5" y="47.8" font-size="4.6" font-weight="900" fill="#fff" text-anchor="middle" font-family="sans-serif">TABS</text>'
  +'<ellipse cx="60.5" cy="26" rx="16.5" ry="5.2" fill="#f8fafc" stroke="#0b2533" stroke-opacity=".5" stroke-width="1.3"/><ellipse cx="60.5" cy="26" rx="11.5" ry="3.3" fill="none" stroke="#cbd5e1" stroke-width="1.2"/><ellipse cx="60.5" cy="26" rx="6" ry="1.8" fill="none" stroke="#dbe2ea" stroke-width="1"/><circle cx="60.5" cy="26" r="2.4" fill="#94a3b8"/><path d="M45 28q15.5-19 31 0" fill="none" stroke="#64748b" stroke-width="1.3"/>'
  +'<path d="M34 38l13-4.2M36 46l12-2.2" stroke="#111827" stroke-width="2.8" stroke-linecap="round"/><rect x="45.5" y="31.5" width="3.6" height="3.6" rx=".8" fill="#111827" transform="rotate(-18 47 33)"/><rect x="46.6" y="42" width="3.6" height="3.6" rx=".8" fill="#111827"/><path d="M48.6 31.5l3-3.4M49.8 43l3.6 1" stroke="#111827" stroke-width="1.6" stroke-linecap="round"/>'
  +'<path d="M49 31v20" stroke="#fff" stroke-width="2.2" opacity=".75"/><circle cx="40" cy="20" r="1.3" fill="#bae6fd"/><circle cx="43" cy="16" r=".9" fill="#bae6fd"/></svg>'},
 goose:{h:50,svg:'<svg viewBox="0 0 90 64"><defs><linearGradient id="gsB" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#a39079"/><stop offset="1" stop-color="#6a5c4b"/></linearGradient><linearGradient id="gsN" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#2e2e2e"/><stop offset="1" stop-color="#0c0c0c"/></linearGradient></defs>'
  +'<path d="M18 43l-12-6.5 2 6.5-4.5 3.4 6.6 1.1z" fill="#1c1c1c" stroke="#0b2533" stroke-opacity=".5" stroke-width="1.3"/><ellipse cx="40" cy="45" rx="25.5" ry="12.5" fill="url(#gsB)" stroke="#0b2533" stroke-opacity=".5" stroke-width="1.3"/><ellipse cx="43" cy="51.5" rx="20" ry="6" fill="#f4efe5"/><ellipse cx="36" cy="40" rx="9" ry="3" fill="#fff" opacity=".18"/>'
  +'<path d="M22 42q15-14 33 0q-16 10-33 0z" fill="#594c3f" stroke="#0b2533" stroke-opacity=".5" stroke-width="1.3"/><path d="M27 42q4.5-3.4 9 0M33.5 41q4.5-3.4 9 0M40 41q4.5-3.4 9 0M30 45.5q4-2.6 8 0M37 45q4-2.6 8 0" stroke="#cdbfac" stroke-width="1.05" fill="none"/>'
  +'<path d="M59 42C65.5 31 62 19 66.5 10" stroke="url(#gsN)" stroke-width="7" fill="none" stroke-linecap="round"/><path d="M60 40.5q4-2.2 5.2-6.5" stroke="#f4efe5" stroke-width="2.2" fill="none" opacity=".95"/>'
  +'<ellipse cx="69.5" cy="9.5" rx="8" ry="5.3" fill="#111" stroke="#0b2533" stroke-opacity=".5" stroke-width="1.3"/><path d="M63.6 11.6q4.4 4.8 10.3 1.6" stroke="#fff" stroke-width="3.3" fill="none" stroke-linecap="round"/>'
  +'<path d="M76.2 6.6l8.4 2.2-8.2 1.6z" fill="#1a1a1a"/><path d="M76.4 11l7.6 1.4-7.4 1.8z" fill="#1a1a1a"/><path d="M77 9.7l4 .6" stroke="#f472b6" stroke-width="1.4"/>'
  +'<circle cx="71" cy="7.4" r="1.6" fill="#fff"/><circle cx="71.4" cy="7.6" r=".8" fill="#111"/><path d="M68.6 4.6l4.4 1.6" stroke="#fff" stroke-width="1.1" stroke-linecap="round"/>'
  +'<path d="M86 5l3-2M87 9.5h3.4M86 13.5l3 2" stroke="#e0f2fe" stroke-width="1.3" stroke-linecap="round"/></svg>'},
 truck:{h:50,svg:'<svg viewBox="0 0 100 64"><defs><linearGradient id="tkB" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#d5dfe8"/></linearGradient><linearGradient id="tkW" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#c7ecff"/><stop offset="1" stop-color="#38bdf8"/></linearGradient></defs>'
  +'<path d="M8 17h40M10 17v9M46 17v9" stroke="#64748b" stroke-width="2" stroke-linecap="round"/><path d="M6 15l38 5" stroke="#facc15" stroke-width="2.6" stroke-linecap="round"/><path d="M44 20l5 3" stroke="#facc15" stroke-width="2.6" stroke-linecap="round"/><path d="M47 22q5-1 6 4q-5 1-6-4z" fill="none" stroke="#475569" stroke-width="1.2"/>'
  +'<path d="M6 30h46v-9h14l13 13v13H6z" fill="url(#tkB)" stroke="#0b2533" stroke-opacity=".5" stroke-width="1.3"/><path d="M55 23.5h10l10.5 10.5H55z" fill="url(#tkW)" stroke="#0b2533" stroke-opacity=".5" stroke-width="1.3"/><path d="M63 24.5l-4.5 6.8M67 26.5l-3 4.4" stroke="#fff" stroke-width="1.7" opacity=".75" stroke-linecap="round"/>'
  +'<path d="M52.5 30v17M64 34.5h4" stroke="#94a3b8" stroke-width="1.1"/><rect x="6" y="37" width="73" height="4.4" fill="#0891b2"/><rect x="6" y="30" width="44" height="2.6" fill="#cbd5e1"/><circle cx="20" cy="33.5" r="3.6" fill="none" stroke="#0e7490" stroke-width="1.8"/><circle cx="20" cy="33.5" r="1.4" fill="#0e7490"/>'
  +'<rect x="76.5" y="35" width="4.6" height="4.4" rx="1.3" fill="#fde047" stroke="#0b2533" stroke-opacity=".5" stroke-width="1.3"/><path d="M81 37.2l9-2v4.4z" fill="#fde047" opacity=".3"/><rect x="77" y="43" width="6" height="3.4" rx="1.2" fill="#cbd5e1" stroke="#0b2533" stroke-opacity=".5" stroke-width="1.3"/>'
  +'<text class="nf" x="34" y="36.2" font-size="5.3" font-weight="900" fill="#0e7490" font-family="sans-serif" text-anchor="middle">MILLENNIAL</text>'
  +'<circle cx="21" cy="48" r="8" fill="#111827" stroke="#0b2533" stroke-opacity=".5" stroke-width="1.3"/><circle cx="21" cy="48" r="3.8" fill="#d1d5db"/><circle cx="21" cy="48" r="1.4" fill="#6b7280"/><circle cx="64" cy="48" r="8" fill="#111827" stroke="#0b2533" stroke-opacity=".5" stroke-width="1.3"/><circle cx="64" cy="48" r="3.8" fill="#d1d5db"/><circle cx="64" cy="48" r="1.4" fill="#6b7280"/></svg>'},
 ball:{h:40,spin:1,sink:.36,svg:'<svg viewBox="0 0 60 60"><defs><radialGradient id="bbS" cx=".35" cy=".3" r=".75"><stop offset="0" stop-color="#fff" stop-opacity=".85"/><stop offset=".35" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#0b2533" stop-opacity=".28"/></radialGradient></defs>'
  +'<g class="bspin" style="transform-origin:30px 30px"><circle cx="30" cy="30" r="27" fill="#fff"/>'
  +'<path d="M30 3A27 27 0 0 1 53.4 16.5L30 30z" fill="#ef4444"/><path d="M53.4 16.5A27 27 0 0 1 53.4 43.5L30 30z" fill="#fff"/><path d="M53.4 43.5A27 27 0 0 1 30 57L30 30z" fill="#2563eb"/>'
  +'<path d="M30 57A27 27 0 0 1 6.6 43.5L30 30z" fill="#fff"/><path d="M6.6 43.5A27 27 0 0 1 6.6 16.5L30 30z" fill="#facc15"/><path d="M6.6 16.5A27 27 0 0 1 30 3L30 30z" fill="#fff"/>'
  +'<circle cx="30" cy="30" r="5" fill="#fff" stroke="#e2e8f0"/></g><circle cx="30" cy="30" r="27" fill="url(#bbS)" stroke="#0b2533" stroke-opacity=".5" stroke-width="1.3"/></svg>'},
 noodle:{h:20,sink:.5,svg:'<svg viewBox="0 0 150 30"><defs><linearGradient id="ndG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#86efac"/><stop offset=".55" stop-color="#22c55e"/><stop offset="1" stop-color="#15803d"/></linearGradient></defs>'
  +'<path d="M8 16C40 6 110 6 142 16a8 8 0 0 1-4 12C108 20 42 20 12 28A8 8 0 0 1 8 16z" fill="url(#ndG)" stroke="#0b2533" stroke-opacity=".5" stroke-width="1.3"/>'
  +'<ellipse cx="9" cy="22" rx="4" ry="6" fill="#bbf7d0" stroke="#0b2533" stroke-opacity=".5" stroke-width="1.3"/><ellipse cx="9" cy="22" rx="1.6" ry="2.6" fill="#15803d"/>'
  +'<path d="M24 14C55 8 100 8 128 13" stroke="#fff" stroke-width="2.4" opacity=".55" fill="none" stroke-linecap="round"/>'
  +'<path d="M38 12v9M58 10v9M78 10v9M98 10v9M118 11v9" stroke="#16a34a" stroke-width="1" opacity=".5"/></svg>'},
 duck:{h:44,sink:.3,svg:'<svg viewBox="0 0 80 66"><defs><radialGradient id="dkB" cx=".4" cy=".35" r=".8"><stop offset="0" stop-color="#fff59d"/><stop offset=".55" stop-color="#facc15"/><stop offset="1" stop-color="#d99a06"/></radialGradient></defs>'
  +'<path d="M8 40c0-12 14-18 30-16c4-12 22-14 28-3c4 7 0 14-6 17c8 1 12 6 10 14c-3 9-16 12-32 12C18 64 8 54 8 40z" fill="url(#dkB)" stroke="#0b2533" stroke-opacity=".5" stroke-width="1.3"/>'
  +'<path d="M8 40c-3-4-3-10 1-12c1 5 4 8 8 9z" fill="#facc15" stroke="#0b2533" stroke-opacity=".5" stroke-width="1.3"/>'
  +'<path d="M66 30c6-1 11 1 12 4c-3 3-8 4-13 2z" fill="#fb923c" stroke="#0b2533" stroke-opacity=".5" stroke-width="1.3"/><path d="M66 33.5c4 .3 8 .1 11.5-.3" stroke="#c2410c" stroke-width="1" fill="none"/>'
  +'<circle cx="58" cy="25" r="3.2" fill="#111827"/><circle cx="59.1" cy="23.9" r="1.1" fill="#fff"/><path d="M53 19q5-4 10-1" stroke="#b45309" stroke-width="1.2" fill="none" stroke-linecap="round" opacity=".6"/>'
  +'<path d="M24 42q10 10 24 2q-4 9-14 9q-8 0-10-11z" fill="#eab308" stroke="#a16207" stroke-opacity=".6" stroke-width="1"/>'
  +'<path d="M16 34q8-8 18-8" stroke="#fff" stroke-width="3" opacity=".75" fill="none" stroke-linecap="round"/><ellipse cx="40" cy="58" rx="22" ry="3" fill="#fff" opacity=".18"/></svg>'},
 tube:{h:30,sink:.42,svg:'<svg viewBox="0 0 96 46"><defs><linearGradient id="tbS" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#0b2533" stop-opacity=".3"/></linearGradient></defs>'
  +'<ellipse cx="48" cy="24" rx="44" ry="19" fill="#fff" stroke="#0b2533" stroke-opacity=".5" stroke-width="1.3"/>'
  +'<ellipse cx="48" cy="24" rx="33" ry="13.5" fill="none" stroke="#ef4444" stroke-width="11" stroke-dasharray="17.5 17.5"/>'
  +'<ellipse cx="48" cy="24" rx="44" ry="19" fill="url(#tbS)"/>'
  +'<ellipse cx="48" cy="21" rx="19" ry="6.5" fill="#0e7490" stroke="#0b2533" stroke-opacity=".45" stroke-width="1.2"/><ellipse cx="48" cy="22.5" rx="15" ry="4" fill="#22d3ee" opacity=".55"/>'
  +'<path d="M12 18q14-12 40-12" stroke="#fff" stroke-width="3" opacity=".85" fill="none" stroke-linecap="round"/></svg>'},
 donut:{h:38,sink:.42,svg:'<svg viewBox="0 0 80 50"><defs><linearGradient id="dnG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fbcfe8"/><stop offset="1" stop-color="#ec4899"/></linearGradient><linearGradient id="dnB" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fcd9a8"/><stop offset="1" stop-color="#d9893c"/></linearGradient></defs>'
  +'<ellipse cx="40" cy="28" rx="36" ry="17" fill="url(#dnB)" stroke="#0b2533" stroke-opacity=".5" stroke-width="1.3"/><path d="M5 24c4-12 66-12 70 0c2 7-6 6-9 9c-5 4-10-1-14 3c-6 4-12-2-17 2c-5 3-10-3-15 0c-5 2-12-3-14-4c-2-2-2-6-1-10z" fill="url(#dnG)"/>'
  +'<ellipse cx="40" cy="25" rx="12" ry="5" fill="#0e7490" opacity=".7"/><ellipse cx="40" cy="24" rx="12" ry="5" fill="none" stroke="#9d174d" stroke-opacity=".35"/>'
  +'<g stroke-width="2.2" stroke-linecap="round"><path d="M16 20l3-2" stroke="#facc15"/><path d="M26 15l3 1" stroke="#22d3ee"/><path d="M52 15l3-1" stroke="#a3e635"/><path d="M62 21l2 3" stroke="#fff"/><path d="M20 30l3 1" stroke="#a78bfa"/><path d="M58 30l-3 2" stroke="#facc15"/><path d="M40 13l2 2" stroke="#fff"/></g>'
  +'<path d="M12 21c8-7 22-9 30-9" stroke="#fff" stroke-width="2" opacity=".6" fill="none" stroke-linecap="round"/></svg>'}};
// The water is drawn every frame from two moving sine waves, so a floater can sit exactly on the surface
// at its spot and tilt with the slope. One floater at a time, from either side of the pool.
const WV={H:84,W:0,t:0,last:0,fls:[null,null],next:[performance.now()+1500,performance.now()+7000],lastKey:''};
const backY=(x,t)=>WV.H*0.5+5.5*Math.sin(x/42-t*0.9)+2.6*Math.sin(x/17.5+t*1.35);
const frontY=(x,t)=>WV.H*0.62+3.6*Math.sin(x/33+t*1.1)+1.8*Math.sin(x/14-t*1.7);
// far lane rides the back wave (smaller, slower); near lane rides the front wave (bigger, in front)
const LANES=[{y:backY,s:.85,v:1},{y:frontY,s:1.15,v:1.25}];
function wavePath(fn,t){let d='M0 '+WV.H;for(let x=0;x<=WV.W+12;x+=12)d+=' L'+x+' '+fn(x,t).toFixed(1);return d+' L'+(WV.W+12)+' '+WV.H+' Z'}
function sizeWaves(){const h=document.querySelector('header');WV.W=h?h.clientWidth:1200;document.querySelectorAll('.hwave').forEach(s=>s.setAttribute('viewBox','0 0 '+WV.W+' '+WV.H))}
function spawnFloat(now,li){const box=$('floaty');if(!box)return;const busy=WV.fls.filter(Boolean).map(f=>f.k),keys=Object.keys(FLOATS).filter(k=>k!==WV.lastKey&&!busy.includes(k)),k=keys[Math.floor(Math.random()*keys.length)];WV.lastKey=k;
  const L=LANES[li],other=WV.fls[1-li],F=FLOATS[k],h=Math.round(F.h*L.s),dir=other?other.dir:(Math.random()<.5?1:-1),el=document.createElement('div');el.className='fl lane'+li+(dir<0?' flip':'');el.style.height=h+'px';el.title='Splash!';
  el.innerHTML='<div class="fsh"></div><div class="bob">'+F.svg+'</div><div class="frf" aria-hidden="true">'+F.svg.split('id="').join('id="r'+li).split('url(#').join('url(#r'+li)+'</div>';box.appendChild(el);
  const w=el.offsetWidth||80,f={el,k,dir,w,h,li,x:dir>0?-w-10:WV.W+10,speed:WV.W/(30+Math.random()*12)*L.v,roll:Math.random()*6,sink:h*(F.sink||0.3),hop:0,rip:0,spin:F.spin?el.querySelectorAll('.bspin'):null,dist:0};WV.fls[li]=f;
  el.onclick=()=>{if(WV.fls[li]!==f)return;f.hop=1;f.speed*=1.6;splash(f.x+f.w/2,L.y(f.x+f.w/2,WV.t),9)}}
// water effects: rings behind the floater, sun glints on the surface, droplets when it's poked
function fx(cls,x,y,life,style){const box=$('floaty');if(!box||box.childElementCount>40)return;const e=document.createElement('i');e.className=cls;e.style.left=x.toFixed(1)+'px';e.style.top=y.toFixed(1)+'px';if(style)e.style.cssText+=style;box.appendChild(e);setTimeout(()=>e.remove(),life)}
function splash(x,y,n){for(let i=0;i<n;i++)fx('drop',x+(Math.random()-.5)*20,y,800,'--dx:'+((Math.random()-.5)*46).toFixed(0)+'px;--up:'+(10+Math.random()*16).toFixed(0)+'px;animation-delay:'+(i*12)+'ms');fx('rp big',x,y+2,1700)}
let glintAt=0;
function waveTick(now){const dt=Math.min(.05,(now-(WV.last||now))/1000);WV.last=now;WV.t+=dt;
  const ps=document.querySelectorAll('.hwave path');if(ps[0])ps[0].setAttribute('d',wavePath(backY,WV.t));if(ps[1])ps[1].setAttribute('d',wavePath(frontY,WV.t));
  if(now>glintAt&&!document.hidden){glintAt=now+260+Math.random()*420;const gx=Math.random()*WV.W;fx('gl',gx,backY(gx,WV.t)+1.5,1500)}
  WV.fls.forEach((f,li)=>{const Y=LANES[li].y;
  if(f){f.x+=f.dir*f.speed*dt;const cx=f.x+f.w/2,y=Y(cx,WV.t),slope=(Y(cx+6,WV.t)-Y(cx-6,WV.t))/12;
    if(f.hop>0){f.hop=Math.max(0,f.hop-dt*1.7);if(!f.hop){f.speed/=1.6;splash(cx,y,5)}}
    const lift=f.hop?Math.sin(f.hop*Math.PI)*16:0,bob=Math.sin(WV.t*2.2+f.roll)*1.4;
    const ang=Math.atan(slope)*57.3*0.85+Math.sin(WV.t*1.6+f.roll)*2.5+(f.hop?f.dir*Math.sin(f.hop*Math.PI*2)*8:0);
    f.el.style.transform='translate('+f.x.toFixed(1)+'px,'+(y-f.h+f.sink-lift+bob).toFixed(1)+'px) rotate('+ang.toFixed(2)+'deg)';
    f.el.style.setProperty('--lift',(lift/16).toFixed(2));
    if(f.spin){f.dist+=f.speed*dt;const a=(f.dist/(f.h*0.45)*57.3).toFixed(1);f.spin.forEach(g=>g.style.transform='rotate('+a+'deg)')}   // rolls as it goes
    if(now>f.rip&&!f.hop){f.rip=now+380;const tx=f.dir>0?f.x+f.w*0.18:f.x+f.w*0.82;fx('rp',tx,Y(tx,WV.t)+2,1600)}
    if(f.x<-f.w-40||f.x>WV.W+40){f.el.remove();WV.fls[li]=null;WV.next[li]=now+3000+Math.random()*(li?16000:9000)}}
  else if(now>WV.next[li]&&!document.hidden)spawnFloat(now,li)});
  requestAnimationFrame(waveTick)}
// numbers count up when a truck is opened
let cuSel=null;new MutationObserver(()=>{if(sel===cuSel||matchMedia('(prefers-reduced-motion: reduce)').matches)return;cuSel=sel;
  $('detail').querySelectorAll('.kv b').forEach(b=>{const m=b.textContent.match(/^([\d,]+)(.*)$/);if(!m)return;const n=+m[1].replace(/,/g,''),rest=m[2],t0=performance.now();if(!n)return;
    const step=t=>{const k=Math.min(1,(t-t0)/800),v=Math.round(n*(1-Math.pow(1-k,3)));b.textContent=v.toLocaleString()+rest;if(k<1)requestAnimationFrame(step)};requestAnimationFrame(step)})}).observe($('detail'),{childList:true});
sizeWaves();addEventListener('resize',sizeWaves);
if(matchMedia('(prefers-reduced-motion: reduce)').matches){const ps=document.querySelectorAll('.hwave path');if(ps[0])ps[0].setAttribute('d',wavePath(backY,0));if(ps[1])ps[1].setAttribute('d',wavePath(frontY,0))}
else requestAnimationFrame(waveTick);
// ---- Self-cleaning page: notices fade, messages clear, data refreshes, idle page reloads ----
// Azuga Driver Score tile: score out of 100, colored, plus the behaviour costing the most points
async function scoreTile(id,name){const el=$('kscore');if(!el)return;const b=el.querySelector('b'),sm=el.querySelector('small');let r;
  try{r=await get('/api/score?vehicleId='+encodeURIComponent(id)+'&name='+encodeURIComponent(name||''))}catch(e){if(sel==id){b.textContent='–';sm.textContent=/collecting/i.test(e.message)?'Collecting data…':'Score unavailable';el.title=e.message}return}
  if(sel!=id)return;
  el.classList.add(r.score>=85?'good':r.score>=70?'ok':'bad');b.innerHTML='<svg class="ring" viewBox="0 0 36 36" aria-hidden="true"><circle cx="18" cy="18" r="15.9" pathLength="100"/><circle class="fill" cx="18" cy="18" r="15.9" pathLength="100" style="--v:'+r.score+'"/></svg>'+r.score+'<i>/100</i>';
  const top=r.items[0],gasBad=r.gas&&r.gas.points;
  sm.textContent='#'+r.rank+' of '+r.of+(top?' · '+top.label:gasBad?' · gas/mile':' · no events');const lab=el.querySelector('span');if(lab){const old=lab.querySelector('.flag');if(old)old.remove();if(r.flags&&r.flags.length)lab.insertAdjacentHTML('beforeend',flag(r.flags))}
  const money=n=>'$'+n.toFixed(2);
  el.title=['Driver score, all time'+(r.since?' since '+new Date(r.since).toLocaleDateString():'')+(r.backfilling?' (older history still loading)':'')+': #'+r.rank+' of '+r.of+' drivers','100 = no points lost, 40 = worst in the fleet. Each event type counts up to 3 times per month of history.',''].concat(
    r.items.map(x=>x.label+' ×'+x.count+(x.count>x.cap?' (counted '+x.cap+')':'')+(x.repeat?', '+x.days+' days (repeat +'+5*x.repeat+')':'')+': -'+x.points),
    r.gas?['Gas '+money(r.gas.spend)+' for '+Math.round(r.gas.miles)+' mi = '+money(r.gas.perMile)+'/mi'+(r.gas.points?': -'+r.gas.points:' (ok)')]:[],
    r.azuga!=null?['Azuga score: '+r.azuga]:[]).join('\\n')}
// Every driver's score, for the little chips on truck cards and in the Drivers list
let SCORES={};const scoreChip=n=>{const v=SCORES[String(n||'').toLowerCase().replace(/[.,']/g,'').split(' ').filter(Boolean).join(' ')];return v==null?'':'<span class="schip '+(v>=85?'good':v>=70?'ok':'bad')+'" title="Driver score">'+v+'</span>'};
async function loadScores(){try{SCORES=await get('/api/scores');if(vehicles.length||locs.length)render();if(!$('vDrv').hidden&&PEOPLE)renderDrivers()}catch(e){}}
setTimeout(loadScores,1500);setInterval(loadScores,5*60e3);
// 30 little bars, one per day, showing when gas was bought
const spark=d=>{if(!d||!d.length)return '';const m=Math.max(...d,1);return '<svg class="spark" viewBox="0 0 90 22" preserveAspectRatio="none" aria-label="Gas by day, last 30 days">'+d.map((v,i)=>'<rect x="'+(i*3)+'" y="'+(22-Math.max(v?2:0.6,v/m*22)).toFixed(1)+'" width="2" height="'+Math.max(v?2:0.6,v/m*22).toFixed(1)+'" rx=".6"'+(v?'':' opacity=".25"')+'><title>'+(v?'$'+v.toFixed(0):'none')+'</title></rect>').join('')+'</svg>'};
// Pool Office Manager: the driver's pools for today, in order, done or not
let POMSTOPS=null;
async function pomBox(id,name,date){const el=$('pomBox');if(!el)return;if(!name){el.hidden=true;return}
  const today=new Date().toLocaleDateString('en-CA',{timeZone:'America/New_York'});date=date||today;const isToday=date===today;
  const fd=d=>new Date(d+'T12:00:00').toLocaleDateString([], {weekday:'short',month:'short',day:'numeric'}),t=x=>x?new Date(x).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'}):'';
  const head=right=>'<h4><span class="ptag">POM</span>'+(isToday?'Today’s pools':'Pools on '+fd(date))+'<label class="pdate" title="Look back at another day"><input type="date" id="pomDate" value="'+date+'" max="'+today+'"></label>'+(right||'')+'</h4>';
  const bind=()=>{const inp=$('pomDate');if(inp)inp.onchange=()=>{const v=inp.value||today;pomBox(id,name,v);if(v!==today)showTrail(id,0,v);else{clearTrail();document.querySelectorAll('.trailbar button').forEach(x=>x.classList.toggle('on',x.dataset.h==='0'))}}};
  if(!el.hidden)el.classList.add('loading');
  let r;try{r=await get('/api/visits?name='+encodeURIComponent(name)+'&date='+date)}catch(e){if(sel!=id)return;el.classList.remove('loading');el.hidden=false;el.innerHTML=head()+'<div class="muted">Could not load: '+esc(e.message)+'</div>';bind();return}
  if(sel!=id||!r.connected)return;el.classList.remove('loading');el.hidden=false;
  if(!r.tech){el.innerHTML=head()+'<div class="muted">No pools on '+esc(name.split(' ')[0])+'’s route in Pool Office Manager '+(isToday?'today':'that day')+'.</div>';bind();return}
  const st=r.stops,done=st.filter(s=>s.done).length,pct=st.length?Math.round(done/st.length*100):0,vis=st.filter(s=>s.visit),tot=vis.reduce((a,s)=>a+s.visit.mins,0);
  // day timeline: one block per property visit
  let tl='';if(vis.length){const a=Math.min(...vis.map(s=>s.visit.arrive)),b=Math.max(...vis.map(s=>s.visit.leave)),span=Math.max(b-a,1);
    tl='<div class="ptl" aria-label="Time at each pool">'+vis.map(s=>'<i style="left:'+((s.visit.arrive-a)/span*100).toFixed(2)+'%;width:'+Math.max(1.2,(s.visit.leave-s.visit.arrive)/span*100).toFixed(2)+'%" title="'+esc(s.customer)+': '+s.visit.mins+' min ('+t(s.visit.arrive)+' - '+t(s.visit.leave)+')"></i>').join('')+'<span>'+t(a)+'</span><span>'+t(b)+'</span></div>'}
  el.innerHTML=head('<span class="pcount">'+done+' of '+st.length+' done</span>')+'<div class="pbar"><i style="width:'+pct+'%"></i></div>'
   +(vis.length?'<div class="psum"><b>'+Math.floor(tot/60)+'h '+(tot%60)+'m</b> at pools · '+vis.length+' of '+st.length+' visits found in the truck’s breadcrumbs</div>'+tl:(r.points?'':'<div class="muted" style="font-size:12px">No breadcrumbs from the truck '+(isToday?'yet today':'that day')+', so time on site can’t be measured.</div>'))
   +(r.tech.toLowerCase()!==name.toLowerCase()?'<div class="muted" style="font-size:12px;margin:4px 0">Shown as '+esc(r.tech)+' in Pool Office Manager</div>':'')
   +'<ol class="plist">'+st.map((s,i)=>'<li class="'+(s.done?'done':'')+'" data-i="'+i+'"><span class="pn">'+(s.done?'✓':i+1)+'</span><div><b>'+esc(s.customer||'Customer')+'</b><span>'+esc(s.address||'No address')+'</span>'
     +(s.visit?'<span class="pvisit">Arrived '+t(s.visit.arrive)+' · left '+t(s.visit.leave)+(s.visit.visits>1?' · came back '+(s.visit.visits-1)+'×':'')+(s.visit.how==='wide'?' <span class="pfar">parked ~'+(s.visit.ft>=1000?(s.visit.ft/5280).toFixed(2)+' mi':s.visit.ft+' ft')+' away</span>'+flag('The truck never stopped within 500 ft of the address in Pool Office Manager, so this visit was matched from up to 0.3 mi away. The address in POM may be off, or this could be a neighbouring stop.'):s.visit.how==='addr'?' <span class="pfar">matched by street</span>'+flag('Matched by street address instead of map position: the truck stopped at '+(s.visit.parkedAt||'a nearby number on the same street')+'. '+(s.lat?'POM\\'s map pin for this pool is more than 0.3 mi away, so the pin is probably wrong.':'POM has no map pin for this pool.')):'')+'</span>':(!isToday||s.done?'<span class="pvisit none">Truck not seen at this address</span>':''))+'</div>'
     +'<em>'+(s.visit?'<strong class="vmins'+(s.visit.mins<5?' short':s.visit.mins>60?' long':'')+'">'+s.visit.mins+' min</strong>':'')+(s.done?'Done':esc(String(s.serviceStatus||s.status||'To do').toLowerCase().split('_').join(' ').replace(/^./,c=>c.toUpperCase())))+(s.time?'<small>Scheduled '+t(s.time)+'</small>':'')+'</em></li>').join('')+'</ol>';
  bind();POMDAY=isToday?null:st;
  el.querySelectorAll('.plist li').forEach(li=>li.onclick=()=>{const s=st[+li.dataset.i];if(s.lat&&s.lng){map.setView([s.lat,s.lng],17);showPools()}})}
let POMDAY=null;
// Pools on the map once you zoom in: every tech's stops for today
const poolLayer=L.layerGroup();
const poolIcon=s=>L.divIcon({className:'poolpin'+(s.done?' done':''),html:'<span>'+(s.done?'\u2713':'')+'</span>',iconSize:[22,16],iconAnchor:[11,8]});
async function loadPools(){try{const r=await get('/api/pom/stops');if(!r.connected)return;POMSTOPS=r.stops;showPools()}catch(e){}}
function showPools(){if(!POMSTOPS)return;const on=map.getZoom()>=13;if(on&&!map.hasLayer(poolLayer)){poolLayer.addTo(map)}else if(!on&&map.hasLayer(poolLayer)){map.removeLayer(poolLayer);return}
  poolLayer.clearLayers();POMSTOPS.forEach(s=>L.marker([s.lat,s.lng],{icon:poolIcon(s),keyboard:false,zIndexOffset:-500}).bindTooltip('<b>'+esc(s.customer||'Pool')+'</b><br>'+esc(s.address)+'<br>'+esc(s.tech||'')+' · '+(s.done?'Done':'Not done yet'),{direction:'top',offset:[0,-8]}).addTo(poolLayer))}
map.on('zoomend',showPools);setTimeout(loadPools,2000);setInterval(loadPools,3*60e3);
// Breadcrumb trail: colored by speed, dots where it started and where it is now, small stops where it sat 10+ minutes
const trailLayer=L.layerGroup();
function clearTrail(){trailLayer.clearLayers();if(map.hasLayer(trailLayer))map.removeLayer(trailLayer);const i=$('trailInfo');if(i)i.textContent=''}
const spdColor=m=>m<1?'#94a3b8':m<30?'#22c55e':m<50?'#84cc16':m<65?'#f59e0b':'#ef4444';
const hav=(a,b)=>{const R=3958.8,r=Math.PI/180,dl=(b.lat-a.lat)*r,dn=(b.lng-a.lng)*r,x=Math.sin(dl/2)**2+Math.cos(a.lat*r)*Math.cos(b.lat*r)*Math.sin(dn/2)**2;return 2*R*Math.asin(Math.sqrt(x))};
async function showTrail(id,h,date){const info=$('trailInfo');clearTrail();if(info)info.textContent='Loading...';let r;
  if(date)document.querySelectorAll('.trailbar button').forEach(x=>x.classList.remove('on'));
  try{r=await get('/api/trail?vehicleId='+encodeURIComponent(id)+(date?'&date='+date:'&hours='+h))}catch(e){if(info&&sel==id)info.textContent='Azuga trail unavailable: '+e.message;return}
  if(sel!=id)return;const p=r.points;if(!p.length){info.textContent=date?'No breadcrumbs for this truck on '+date+'.':'No movement recorded in that time.';return}
  const tm=t=>new Date(t).toLocaleString([], {weekday:'short',hour:'numeric',minute:'2-digit'});
  let run=[p[0]],col=spdColor(p[0].mph),miles=0;
  const flush=()=>{if(run.length>1){L.polyline(run.map(x=>[x.lat,x.lng]),{color:'#0b2533',weight:7,opacity:.25}).addTo(trailLayer);L.polyline(run.map(x=>[x.lat,x.lng]),{color:col,weight:4,opacity:.95,lineCap:'round'}).addTo(trailLayer)}};
  for(let i=1;i<p.length;i++){const d=hav(p[i-1],p[i]);if(d<200)miles+=d;const c=spdColor(p[i].mph);run.push(p[i]);if(c!==col||d>5){flush();run=[p[i]];col=c}}flush();
  for(let i=1;i<p.length;i++){const gap=p[i].t-p[i-1].t;if(gap>=10*60e3&&hav(p[i-1],p[i])<0.2)L.circleMarker([p[i].lat,p[i].lng],{radius:5,color:'#fff',weight:2,fillColor:'#6366f1',fillOpacity:1}).bindTooltip('Stopped '+Math.round(gap/60e3)+' min<br>'+tm(p[i-1].t)+(p[i].addr?'<br>'+esc(p[i].addr):''),{direction:'top'}).addTo(trailLayer)}
  const dot=(x,c,label)=>L.circleMarker([x.lat,x.lng],{radius:7,color:'#fff',weight:2.5,fillColor:c,fillOpacity:1}).bindTooltip(label+' · '+tm(x.t)+(x.addr?'<br>'+esc(x.addr):''),{direction:'top'}).addTo(trailLayer);
  dot(p[0],'#0ea5e9','Start');dot(p[p.length-1],'#0f172a',date?'Last':'Latest');
  if(date&&POMDAY)POMDAY.map(s=>s.lat&&s.lng?s:s.visit&&s.visit.lat?{...s,lat:s.visit.lat,lng:s.visit.lng}:null).filter(Boolean).forEach(s=>L.marker([s.lat,s.lng],{icon:poolIcon(s),zIndexOffset:500}).bindTooltip('<b>'+esc(s.customer||'Pool')+'</b><br>'+esc(s.address)+'<br>'+(s.visit?s.visit.mins+' min on site':'Truck not seen here'),{direction:'top',offset:[0,-8]}).addTo(trailLayer));
  trailLayer.addTo(map);map.fitBounds(L.latLngBounds(p.map(x=>[x.lat,x.lng])),{paddingTopLeft:[40,90],paddingBottomRight:[40,40],maxZoom:15});
  info.innerHTML=(date?'<b>'+date+'</b> · ':'')+'<b>'+Math.round(miles)+' mi</b> · '+p.length+' points · '+(date?'from ':'since ')+tm(p[0].t)+'<span class="tlegend"><i style="background:#22c55e"></i>&lt;30 <i style="background:#84cc16"></i>30-50 <i style="background:#f59e0b"></i>50-65 <i style="background:#ef4444"></i>65+ mph</span>'}
// Small flag for numbers that might be wrong; hover or tap shows why
const flag=t=>t&&t.length?'<span class="flag" tabindex="0" role="img" aria-label="Possible data issue" data-tip="'+esc([].concat(t).join('\\n\\n'))+'">⚑</span>':'';
(function(){let tip;const show=e=>{const f=e.target.closest&&e.target.closest('.flag');if(!f)return;if(!tip){tip=document.createElement('div');tip.id='fltip';document.body.appendChild(tip)}
  tip.textContent=f.dataset.tip;tip.hidden=false;const r=f.getBoundingClientRect(),w=Math.min(280,innerWidth-16);tip.style.maxWidth=w+'px';
  const tw=tip.offsetWidth,th=tip.offsetHeight;let x=Math.max(8,Math.min(innerWidth-tw-8,r.left+r.width/2-tw/2)),y=r.top-th-8;if(y<8)y=r.bottom+8;tip.style.left=x+'px';tip.style.top=y+'px'};
  const hide=e=>{const f=e.target.closest&&e.target.closest('.flag');if(f&&tip)tip.hidden=true};
  document.addEventListener('mouseover',show);document.addEventListener('focusin',show);document.addEventListener('mouseout',hide);document.addEventListener('focusout',hide)})();
// Driver's Ramp spend (cards + reimbursements), last 30 days: gas vs everything else
async function rampBox(id,name){const el=$('rampBox');if(!el)return;if(!name){el.hidden=true;return}
  let head='<h4><span class="rtag">Ramp</span>'+esc(name)+'</h4>';const usd=n=>n.toLocaleString('en-US',{style:'currency',currency:'USD'});
  el.innerHTML=head+'<div class="sk" style="width:60%"></div>';let r;
  try{r=await get('/api/ramp?name='+encodeURIComponent(name)+'&vehicleId='+encodeURIComponent(id))}catch(e){if(sel==id)el.innerHTML=head+'<div class="rmuted">Ramp is not answering right now: '+esc(e.message)+'</div>';return}
  if(sel!=id)return;
  if(r.since){const f=d=>new Date(d).toLocaleDateString([], {month:'short',day:'numeric'});head=head.replace('</h4>','<span class="rdates">'+f(r.since)+' – '+f(r.until||Date.now())+'</span></h4>')}
  if(r.flags&&r.flags.length)head=head.replace('</h4>',flag(r.flags)+'</h4>');
  if(!r.connected){el.innerHTML=head+'<div class="rmuted">Ramp is not connected yet.</div>'+(r.mpg?'<div class="rmile mpg"><b>'+r.mpg.mpg.toFixed(1)+' mpg'+flag(r.mpg.flags)+'</b><span>'+Math.round(r.mpg.miles).toLocaleString()+' miles in 30 days</span></div>':'');return}
  const mpgH=(r.mpg?'<div class="rmile mpg"><b>'+r.mpg.mpg.toFixed(1)+' mpg'+flag(r.mpg.flags)+'</b><span class="mgauge" title="Pickups usually get 15-25 mpg"><i style="width:'+Math.min(100,r.mpg.mpg/30*100).toFixed(0)+'%;background:'+(r.mpg.mpg<12?'#f87171':r.mpg.mpg<16?'#fbbf24':'#4ade80')+'"></i><u></u></span><span>'+Math.round(r.mpg.miles).toLocaleString()+' miles in 30 days</span><em>'+(r.mpg.source==='azuga'?'From the truck\u2019s fuel data':'Estimate: Ramp gas at $'+r.mpg.price.toFixed(2)+'/gal')+'</em></div>':'');
  const p=r.person;if(!p){el.innerHTML=head+'<div class="rmuted">No Ramp spend found under this name.</div>'+mpgH;return}
  el.innerHTML=head+'<div class="rgrid"><div class="rgas"><span>Gas</span>'+spark(p.daily)+'<b>'+usd(p.gas)+'</b><i>'+p.gasN+(p.gasN===1?' fill-up':' fill-ups')+'</i></div><div><span>Everything else</span><b>'+usd(p.other)+'</b><i>'+p.otherN+(p.otherN===1?' purchase':' purchases')+'</i></div></div>'
   +(r.gasPerMile?(g=>'<div class="rmile'+(g.perMile>g.max?' bad':'')+'"><b>'+usd(g.perMile)+' per mile'+flag(g.flags)+'</b><span>'+usd(p.gas)+' of gas ÷ '+Math.round(g.miles).toLocaleString()+' miles driven</span><em>'+(g.perMile>g.max?'Over the '+usd(g.max)+'/mile limit · −'+g.points+' on driver score':'Normal (limit '+usd(g.max)+'/mile)')+'</em></div>')(r.gasPerMile):'')
   +mpgH
   +(p.name.toLowerCase()!==name.toLowerCase()?'<div class="rmuted">Shown as '+esc(p.name)+' in Ramp</div>':'')+(r.cardOnly?'<div class="rmuted">Card spend only. Give the Ramp app the reimbursements:read permission to include reimbursed gas.</div>':'')}
function toast(msg,kind){let t=$('toast');if(!t){t=document.createElement('div');t.id='toast';t.setAttribute('role','status');document.body.appendChild(t)}
  t.className='toast '+(kind||'');t.textContent=msg;t.hidden=false;clearTimeout(t._h);t._h=setTimeout(()=>t.hidden=true,7000)}
const MSG_IDS=['edMsg','ndMsg','deMsg','scanMsg'],msgAt={};
new MutationObserver(()=>MSG_IDS.forEach(id=>{const e=$(id);if(e&&e.textContent&&!msgAt[id])msgAt[id]=Date.now();if(e&&!e.textContent)delete msgAt[id]})).observe(document.body,{subtree:true,childList:true,characterData:true});
setInterval(()=>MSG_IDS.forEach(id=>{const e=$(id);if(e&&msgAt[id]&&Date.now()-msgAt[id]>9000){e.textContent='';e.style.color='';delete msgAt[id]}}),2000);
let lastAct=Date.now(),hiddenAt=0;['pointerdown','keydown','wheel','touchstart'].forEach(ev=>addEventListener(ev,()=>lastAct=Date.now(),{passive:true}));
const busy=()=>document.querySelector('dialog[open]')||document.querySelector('#edCard .dirty')||($('newDrv')&&!$('newDrv').hidden)||(SYNCST&&SYNCST.running);
const freshen=()=>{if(busy())return;if(!$('vDrv').hidden){driverList=null;loadPeople();loadSync()}else if(!$('vEdit').hidden){loadAT();loadSync()}else loadAT()};   // map tab: pick up Airtable driver changes
setInterval(freshen,120e3);
setInterval(()=>{if(Date.now()-lastAct>10*60e3&&!busy())location.reload()},60e3);
document.addEventListener('visibilitychange',()=>{if(document.hidden)hiddenAt=Date.now();else if(hiddenAt&&Date.now()-hiddenAt>10*60e3&&!busy())location.reload();else freshen()});
let peopleAt=0;async function loadPeople(){try{PEOPLE=await get('/api/people');peopleAt=Date.now()}catch(e){PEOPLE={connected:true,error:e.message,drivers:[]}}renderDrivers()}
const post=async(u,b)=>{const r=await fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});const j=await r.json();if(j.error)throw new Error(j.error);return j};
let dfilt='all';
// The Airtable Status field decides (blank counts as Active).
const inactive=d=>d.status==='Inactive';
const picked=new Set();
const DF={all:['Everyone',()=>true],truck:['On a truck',d=>d.trucks.length],free:['No truck',d=>!d.trucks.length&&!inactive(d)],noaz:['Not in Azuga',d=>PEOPLE&&PEOPLE.azugaOk&&!d.inAzuga&&!inactive(d)],off:['Inactive',inactive]};
function renderDupes(){
  const P=PEOPLE,by=Object.fromEntries(P.drivers.map(d=>[d.id,d])),groups=(P.dupes||[]).map(g=>g.map(id=>by[id]).filter(Boolean)).filter(g=>g.length>1),blank=P.blank||[];
  if(!groups.length&&!blank.length){$('dupes').innerHTML='';return}
  const line=d=>[d.license&&((d.state?d.state+' ':'')+d.license),d.trucks.join(', '),d.policy].filter(Boolean).join(' · ')||'No details';
  $('dupes').innerHTML='<div class="dup">'+(groups.length?'<h4>'+groups.length+' possible duplicate'+(groups.length>1?'s':'')+'</h4>Pick the record to keep. Its trucks and any missing details are copied over from the others, then the extras are deleted from Airtable.'
    +groups.map((g,i)=>'<div class="dupg" data-g="'+i+'">'+g.map((d,j)=>'<label><input type="radio" name="keep'+i+'" value="'+esc(d.id)+'"'+(j===0?' checked':'')+'><b>'+esc(d.name)+'</b><span>'+esc(line(d))+'</span></label>').join('')
      +'<div class="edb"><span class="msg"></span><span style="flex:1"></span><button class="btn2 pri mergeGo">Merge and delete extras</button></div></div>').join(''):'')
    +(blank.length?'<h4 style="margin-top:'+(groups.length?'14px':'0')+'">'+blank.length+' blank record'+(blank.length>1?'s':'')+'</h4>These have no name in Airtable.'
    +blank.map(d=>'<div class="dupg" data-id="'+esc(d.id)+'" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><span>'+esc([d.license,d.policy,d.trucks.join(', ')].filter(Boolean).join(' · ')||'Empty')+'</span><span style="flex:1"></span><span class="msg"></span><button class="btn2 delBlank">Delete</button></div>').join(''):'')
+'</div>';
  document.querySelectorAll('.mergeGo').forEach(b=>b.onclick=async()=>{const box=b.closest('.dupg'),g=groups[box.dataset.g],keep=box.querySelector('input:checked').value,rm=g.filter(d=>d.id!==keep),m=box.querySelector('.msg');
    if(!confirm('Keep '+by[keep].name+' and delete '+rm.length+' duplicate'+(rm.length>1?'s':'')+' from Airtable?\\n\\nTrucks and missing details are copied to the kept record first. This can not be undone.'))return;
    b.disabled=true;m.textContent='Merging...';try{await post('/api/driver/merge',{keepId:keep,removeIds:rm.map(d=>d.id)});await loadPeople()}catch(e){m.className='msg bad';m.textContent=e.message;b.disabled=false}});
  document.querySelectorAll('.delBlank').forEach(b=>b.onclick=async()=>{const box=b.closest('.dupg'),m=box.querySelector('.msg');
    if(!confirm('Delete this blank record from Airtable? This can not be undone.'))return;
    b.disabled=true;try{await post('/api/driver/delete',{id:box.dataset.id});await loadPeople()}catch(e){m.className='msg bad';m.textContent=e.message;b.disabled=false}});
}
function renderSelbar(){
  let bar=$('selbar');
  if(!picked.size){if(bar)bar.remove();return}
  if(!bar){bar=document.createElement('div');bar.id='selbar';bar.className='selbar';$('vDrv').appendChild(bar)}
  const ds=PEOPLE.drivers.filter(d=>picked.has(d.id)),anyOn=ds.some(d=>!inactive(d)),anyOff=ds.some(inactive);
  bar.innerHTML='<b>'+picked.size+' selected</b><span style="flex:1"></span><span class="msg"></span>'+(anyOn?'<button class="btn2" data-s="Inactive">Make inactive</button>':'')+(anyOff?'<button class="btn2" data-s="Active">Make active</button>':'')+'<button class="link" id="selClear">Clear</button>';
  $('selClear').onclick=()=>{picked.clear();renderDrivers()};
  bar.querySelectorAll('[data-s]').forEach(b=>b.onclick=async()=>{const st=b.dataset.s,ids=ds.filter(d=>st==='Inactive'?!inactive(d):inactive(d)).map(d=>d.id),m=bar.querySelector('.msg');
    if(!confirm('Mark '+ids.length+' driver'+(ids.length>1?'s':'')+' '+st.toLowerCase()+' in Airtable?'))return;
    bar.querySelectorAll('button').forEach(x=>x.disabled=true);m.textContent='Saving...';
    try{await post('/api/driver/status',{ids,status:st});picked.clear();await loadPeople()}
    catch(e){m.textContent=e.message;bar.querySelectorAll('button').forEach(x=>x.disabled=false)}});
}
async function addAllToAzuga(){
  const todo=PEOPLE.drivers.filter(DF.noaz[1]);
  if(!confirm('Add '+todo.length+' drivers to Azuga?\\n\\n'+todo.map(d=>d.name).join(', ')))return;
  const bad=[];
  for(let i=0;i<todo.length;i++){
    $('drvCount').textContent='Adding '+(i+1)+' of '+todo.length+' to Azuga: '+todo[i].name+'...';
    try{await post('/api/driver/azuga',{airtableId:todo[i].id})}catch(e){bad.push(todo[i].name+': '+e.message)}
    await new Promise(r=>setTimeout(r,4000)); // stay under Azuga's per-minute limit
  }
  driverList=null;await loadPeople();
  if(bad.length)alertBox('Some drivers were not added:\\n'+bad.join('\\n'));
}
const alertBox=t=>{$('dupes').insertAdjacentHTML('afterbegin','<div class="dup"><h4>Heads up</h4>'+esc(t).replace(/\\n/g,'<br>')+'</div>')};
function renderDrivers(){
  if(!PEOPLE)return;
  if(!PEOPLE.connected){$('drvRows').innerHTML='<div class="empty"><b>Airtable is not connected yet</b>Add AIRTABLE_TOKEN in Render to see your drivers here.</div>';$('newDrvBtn').disabled=true;$('drvCount').textContent='';return}
  if(PEOPLE.error){$('drvRows').innerHTML='<div class="empty"><b>Airtable is not answering</b>'+esc(PEOPLE.error)+'</div>';return}
  const all=PEOPLE.drivers,on=all.filter(d=>d.trucks.length).length,miss=all.filter(DF.noaz[1]).length;
  $('drvCount').innerHTML=all.length+' drivers · '+on+' on a truck'+(miss?' · '+miss+' not in Azuga yet <button class="link" id="addAllAz">Add all '+miss+' to Azuga</button>':'');
  if($('addAllAz'))$('addAllAz').onclick=addAllToAzuga;
  $('dsum').innerHTML=Object.entries(DF).map(([k,[l,fn]])=>'<button data-f="'+k+'" aria-pressed="'+(dfilt===k)+'">'+l+' <b>'+all.filter(fn).length+'</b></button>').join('');
  $('dsum').querySelectorAll('button').forEach(b=>b.onclick=()=>{dfilt=b.dataset.f;renderDrivers()});
  $('policyList').innerHTML=[...new Set(all.map(d=>d.policy).filter(Boolean))].map(p=>'<option value="'+esc(p)+'">').join('');
  renderDupes();
  const q=$('q').value.toLowerCase(),ds=all.filter(d=>DF[dfilt][1](d)&&(!q||(d.name+' '+d.trucks.join(' ')+' '+d.license).toLowerCase().includes(q)))
    .sort((a,b)=>inactive(a)-inactive(b)||a.name.localeCompare(b.name));
  [...picked].forEach(id=>{if(!all.some(d=>d.id===id))picked.delete(id)});
  $('drvRows').innerHTML=(ds.length?ds.map(d=>'<div class="rrow'+(inactive(d)?' off':'')+(picked.has(d.id)?' picked':'')+'" data-id="'+esc(d.id)+'"><input type="checkbox" class="pick" aria-label="Select '+esc(d.name)+'"'+(picked.has(d.id)?' checked':'')+'><div class="mav" style="'+pcol(d.name)+'">'+esc(initials(d.name))+'</div>'
    +'<div class="rn"><b class="nm">'+esc(d.name)+scoreChip(d.name)+(inactive(d)?'<span class="tag">Inactive</span>':'')+'</b><span>'+(!d.license&&!inactive(d)?'<em class="nolic">No license #</em>'+(d.policy?' · ':''):'')+esc([d.license&&((d.state?d.state+' ':'')+d.license),!inactive(d)&&d.policy].filter(Boolean).join(' · '))+(d.notes?' · '+esc(d.notes):'')+'</span></div>'
    +'<div class="rt'+(d.trucks.length?'':' none')+'">'+(d.trucks.length?d.trucks.map(esc).join(', '):'No truck')+'</div>'
    +'<div class="rs"><button class="link edbtn">Edit</button>'+(!PEOPLE.azugaOk||inactive(d)?'':d.inAzuga?'<span class="inaz">In Azuga</span>':'<button class="link azbtn">Add to Azuga</button>')+'</div>'
    +'</div>').join('')
    :'<div class="empty" style="padding:36px"><b>'+(dfilt==='noaz'&&!q?'Everyone is in Azuga':'No drivers match')+'</b>'+(dfilt==='noaz'&&!q?'The whole crew can be assigned to trucks.':'Try a different search or filter.')+'</div>')
    +'<button class="addrow" id="addRow"><span class="mav">+</span>Add a driver</button>';
  $('addRow').onclick=()=>$('newDrvBtn').click();
  document.querySelectorAll('.pick').forEach(c=>c.onchange=()=>{const id=c.closest('.rrow').dataset.id;c.checked?picked.add(id):picked.delete(id);c.closest('.rrow').classList.toggle('picked',c.checked);renderSelbar()});
  renderSelbar();
  document.querySelectorAll('.edbtn,.rn b.nm').forEach(b=>b.onclick=async()=>{const id=b.closest('.rrow').dataset.id;if(Date.now()-peopleAt>60e3)await loadPeople();openDrv(id)});
  document.querySelectorAll('.azbtn').forEach(b=>b.onclick=async()=>{const t=b.closest('.rrow');b.disabled=true;b.textContent='Adding...';
    try{await post('/api/driver/azuga',{airtableId:t.dataset.id});driverList=null;await loadPeople()}
    catch(e){b.disabled=false;b.textContent='Try again';b.title=e.message;t.querySelector('.rn>span').textContent='Azuga said: '+e.message}});
}
$('newDrvBtn').onclick=()=>{$('newDrv').hidden=false;$('newDrv').scrollIntoView({block:'nearest'});$('newDrv').querySelector('[name=name]').focus()};
$('ndCancel').onclick=()=>{frontPhoto=null;$('frontPrev').hidden=true;$('newDrv').reset();$('newDrv').hidden=true;$('ndMsg').textContent=''};
$('newDrv').addToAzuga.onchange=e=>{$('azFields').hidden=!e.target.checked};
// ---- License scan: the barcode on the back of every US license holds name, number, state and birthday
let frontPhoto=null;
const loadJs=src=>new Promise((ok,no)=>{if(document.querySelector('script[src="'+src+'"]'))return ok();const t=document.createElement('script');t.src=src;t.onload=ok;t.onerror=()=>no(new Error('Could not load the barcode reader.'));document.head.appendChild(t)});
const titleCase=t=>String(t||'').toLowerCase().replace(/(^|[ '-])[a-z]/g,c=>c.toUpperCase());
function aamva(raw){
  const NL=String.fromCharCode(10),txt=raw.split(String.fromCharCode(13)).join(NL).split(String.fromCharCode(30)).join(NL),f={};
  txt.split(NL).forEach(line=>{let L=line.trim();const i=L.indexOf('DLDAQ');if(i>=0)L=L.slice(i+2);const k=L.slice(0,3);if(/^D[A-Z]{2}$/.test(k)&&!(k in f))f[k]=L.slice(3).trim()});
  let first=f.DAC||f.DCT||'',last=f.DCS||f.DAB||'';
  if(!first&&f.DAA){const p=f.DAA.split(',');last=p[0];first=p[1]||''}
  let dob=f.DBB||'';
  if(/^[0-9]{8}$/.test(dob))dob=+dob.slice(0,2)>12?dob.slice(0,4)+'-'+dob.slice(4,6)+'-'+dob.slice(6):dob.slice(4)+'-'+dob.slice(0,2)+'-'+dob.slice(2,4);else dob='';
  return {name:titleCase((first.split(' ')[0]+' '+last).trim()),license:f.DAQ||'',state:f.DAJ||'',dob};
}
const shrink=(file,max)=>new Promise((ok,no)=>{const img=new Image();img.onload=()=>{const k=Math.min(1,max/Math.max(img.width,img.height)),c=document.createElement('canvas');c.width=Math.round(img.width*k);c.height=Math.round(img.height*k);const g=c.getContext('2d');g.fillStyle='#fff';g.fillRect(0,0,c.width,c.height);g.drawImage(img,0,0,c.width,c.height);ok(c)};img.onerror=()=>no(new Error('That file is not an image.'));img.src=URL.createObjectURL(file)});
$('scanBack').onchange=async e=>{
  const file=e.target.files[0],m=$('scanMsg'),f=$('newDrv');if(!file)return;
  m.style.color='';m.textContent='Reading the barcode...';
  try{
    await loadJs('https://unpkg.com/@zxing/library@0.21.3/umd/index.min.js');
    const hints=new Map([[ZXing.DecodeHintType.POSSIBLE_FORMATS,[ZXing.BarcodeFormat.PDF_417]],[ZXing.DecodeHintType.TRY_HARDER,true]]);
    const reader=new ZXing.BrowserMultiFormatReader(hints);let text=null;
    for(const size of [2400,1600,3200]){try{const c=await shrink(file,size);text=(await reader.decodeFromImageUrl(c.toDataURL('image/png'))).getText();break}catch(err){}}
    if(!text)throw new Error('Could not read the barcode. Try a closer, sharper photo of the back, with no glare.');
    const d=aamva(text);if(!d.license&&!d.name)throw new Error('That barcode is not a driver license.');
    [['name',d.name],['license',d.license],['state',d.state],['dob',d.dob]].forEach(([k,v])=>{if(v)f.querySelector('[name='+k+']').value=v});
    m.style.color='var(--go)';m.textContent='Filled in from the license. Check it looks right.';
  }catch(err){m.style.color='var(--bad)';m.textContent=err.message}
  e.target.value='';
};
$('scanFront').onchange=async e=>{
  const file=e.target.files[0];if(!file)return;
  try{const c=await shrink(file,1600),url=c.toDataURL('image/jpeg',.85);frontPhoto={type:'image/jpeg',data:url.split(',')[1]};$('frontPrev').src=url;$('frontPrev').hidden=false}
  catch(err){$('scanMsg').style.color='var(--bad)';$('scanMsg').textContent=err.message}
};
// ---- Edit a driver ----
let deId=null,dePhoto=null,deSel=new Set();
function deTrucks(){const q=$('deTq').value.trim().toLowerCase();
  $('deTl').innerHTML=(PEOPLE.allTrucks||[]).filter(t=>!q||t.label.toLowerCase().includes(q)||deSel.has(t.id)).map(t=>'<label class="'+(deSel.has(t.id)?'on':'')+'"><input type="checkbox" value="'+esc(t.id)+'"'+(deSel.has(t.id)?' checked':'')+'>'+esc(t.label)+'</label>').join('')||'<span class="muted">No trucks match.</span>'}
function openDrv(id){const d=PEOPLE.drivers.find(x=>x.id===id);if(!d)return;deId=id;dePhoto=null;deSel=new Set(d.truckIds||[]);const f=$('drvForm');f.reset();
  for(const k of ['name','license','state','policy','notes'])f[k].value=d[k]||'';f.status.value=d.status==='Inactive'?'Inactive':'Active';
  $('deTitle').textContent='Edit '+d.name;$('deDz').hidden=true;$('deDzYes').textContent='Delete for good';$('deTq').value='';deTrucks();$('dePrev').hidden=true;$('deMsg').textContent='';$('deSave').disabled=false;
  $('dePic').innerHTML=d.pic&&d.pic.length?'<a class="btn" target="_blank" rel="noopener" href="'+esc(d.pic[0].url)+'">'+ICON.file+'Current license photo</a>':'<span class="muted">No license photo yet</span>';
  $('drvEd').showModal()}
$('deTq').oninput=deTrucks;
$('deDel').onclick=()=>{const d=PEOPLE.drivers.find(x=>x.id===deId);$('deDzName').textContent=d.name;$('deDzIn').value='';$('deDzYes').disabled=true;$('deDz').hidden=false;$('deDzIn').focus()};
$('deDzNo').onclick=()=>{$('deDz').hidden=true};
$('deDzIn').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();if(!$('deDzYes').disabled)$('deDzYes').click()}};
$('deDzIn').oninput=()=>{const d=PEOPLE.drivers.find(x=>x.id===deId);$('deDzYes').disabled=$('deDzIn').value.trim().toLowerCase().split(' ').filter(Boolean).join(' ')!==d.name.trim().toLowerCase().split(' ').filter(Boolean).join(' ')};
$('deDzYes').onclick=async()=>{const b=$('deDzYes'),m=$('deMsg');b.disabled=true;b.textContent='Deleting...';
  try{const r=await post('/api/driver/remove',{id:deId,confirmName:$('deDzIn').value});m.style.color='var(--go)';m.textContent='Deleted'+(r.azuga?' from Airtable and Azuga.':' from Airtable (they were not in Azuga).');driverList=null;await loadPeople();loadSync();setTimeout(()=>$('drvEd').close(),900)}
  catch(err){b.disabled=false;b.textContent='Delete for good';m.style.color='var(--bad)';m.textContent=err.message}};
$('deTl').onchange=e=>{const c=e.target;c.checked?deSel.add(c.value):deSel.delete(c.value);c.closest('label').classList.toggle('on',c.checked)};
$('dePhoto').onchange=async e=>{const file=e.target.files[0];if(!file)return;try{const c=await shrink(file,1600),url=c.toDataURL('image/jpeg',.85);dePhoto={type:'image/jpeg',data:url.split(',')[1]};$('dePrev').src=url;$('dePrev').hidden=false}catch(err){$('deMsg').style.color='var(--bad)';$('deMsg').textContent=err.message}};
$('deCancel').onclick=$('deClose').onclick=()=>$('drvEd').close();
$('drvEd').onclick=e=>{if(e.target.id==='drvEd')$('drvEd').close()};
$('drvForm').onsubmit=async e=>{e.preventDefault();const f=$('drvForm'),m=$('deMsg'),b=Object.fromEntries(new FormData(f));b.id=deId;b.truckIds=[...deSel];if(dePhoto)b.photo=dePhoto;
  $('deSave').disabled=true;m.style.color='';m.textContent='Saving to Airtable...';
  try{const r=await post('/api/driver/update',b);m.style.color=r.warning?'var(--warn)':'var(--go)';m.textContent=r.warning||(r.synced?'Saved to Airtable and Azuga.':'Saved.');loadSync();driverList=null;await loadPeople();loadAT();if(!r.warning)setTimeout(()=>$('drvEd').close(),900)}
  catch(err){$('deSave').disabled=false;m.style.color='var(--bad)';m.textContent=err.message}};
$('newDrv').onsubmit=async e=>{
  e.preventDefault();const f=$('newDrv'),m=$('ndMsg'),b=Object.fromEntries(new FormData(f));b.addToAzuga=f.addToAzuga.checked;if(frontPhoto)b.photo=frontPhoto;
  $('ndSave').disabled=true;m.style.color='';m.textContent='Saving...';
  try{const j=await post('/api/driver/create',b);m.style.color=j.warning?'var(--warn)':'var(--go)';m.textContent=j.warning||('Saved to '+j.saved.join(' and ')+' ✓');
    f.reset();frontPhoto=null;$('frontPrev').hidden=true;if(!j.warning)setTimeout(()=>{f.hidden=true;m.textContent=''},2500);driverList=null;await loadPeople()}
  catch(err){m.style.color='var(--bad)';m.textContent=err.message}
  $('ndSave').disabled=false;
};
loadAT();
// One fleet-wide camera download (refreshed every 5 min) instead of several Azuga calls per truck click,
// which tripped Azuga's per-minute limit and made clicks wait.
let FV=null,FVat=0;
function fleetVids(){if(FV&&Date.now()-FVat<3e5)return FV;FVat=Date.now();const p=get('/api/videos').then(list);if(!FV)FV=p;p.then(()=>{FV=p},()=>{if(FV===p)FV=null;FVat=0});return FV}  // stale copy keeps serving while it refreshes
fleetVids();
// sky colour by time of day (dawn, day, dusk, night)
function sky(){const d=new Date(),h=d.getHours(),hd=document.querySelector('header');if(!hd)return;hd.dataset.sky=h>=5&&h<8?'dawn':h<17&&h>=8?'day':h>=17&&h<20?'dusk':'night';
  // the sun rises at 6 and sets at 20 on an arc across the sky; at night the moon takes the same path
  const m=h*60+d.getMinutes(),day=m>=360&&m<1200,f=day?(m-360)/840:((m-1200+1440)%1440)/600,sn=hd.querySelector('.sun');
  if(sn){sn.style.left=(6+Math.min(1,f)*80).toFixed(1)+'%';sn.style.top=(62-Math.sin(Math.min(1,f)*Math.PI)*50).toFixed(1)+'px';sn.classList.toggle('moon',!day)}}
sky();setInterval(sky,10*60e3);
// ---- Pools tab: every tech's POM route for the day, with progress ----
let POMB=null,pomTimer=null;
const hm=t=>t?new Date(t).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}):'';
async function loadPomBoard(){const d=$('pbDate');if(!d.value){d.value=new Date().toLocaleDateString('en-CA');d.max=d.value}
  clearTimeout(pomTimer);if(!POMB)$('pbList').innerHTML='<div class="tcard"><div class="sk" style="width:60%"></div><div class="sk" style="width:80%"></div></div>'.repeat(3);
  try{POMB=await get('/api/pom/board?date='+d.value);renderPom()}catch(e){$('pbList').innerHTML='<div class="empty">'+esc(e.message)+'</div>'}
  if(POMB&&POMB.today)pomTimer=setTimeout(()=>{if(!$('vPom').hidden)loadPomBoard()},120e3)}
$('pbDate').onchange=()=>{POMB=null;loadPomBoard()};
function stopLi(s){return '<li class="'+(s.done?'done':'')+'"><i>'+(s.done?'✓':'')+'</i><span><b>'+esc(s.customer||'Pool')+'</b><small>'+esc(s.address)+'</small></span><em>'+hm(s.time)+'</em></li>'}
function renderPom(){const r=POMB;if(!r)return;
  if(!r.connected){$('pbCount').textContent='Pool Office Manager is not connected (add POM_API_KEY in Render).';$('pbSum').innerHTML=$('pbList').innerHTML='';return}
  const q=$('q').value.trim().toLowerCase(),hit=t=>!q||t.name.toLowerCase().includes(q)||t.stops.some(s=>(s.customer+' '+s.address).toLowerCase().includes(q));
  const T=r.techs.filter(hit).sort((a,b)=>(a.done===a.total)-(b.done===b.total)||a.done/a.total-b.done/b.total||a.name.localeCompare(b.name));
  const tot=r.techs.reduce((a,t)=>a+t.total,0),done=r.techs.reduce((a,t)=>a+t.done,0),pct=tot?Math.round(done/tot*100):0;
  $('pbCount').textContent=r.techs.length+' techs · '+tot+' pools scheduled'+(r.today?' · updates every 2 minutes':'');
  $('pbSum').innerHTML='<div class="pbs"><div class="pbring" style="--v:'+pct+'"><svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="15.9" pathLength="100"/><circle class="fill" cx="18" cy="18" r="15.9" pathLength="100"/></svg><b>'+pct+'%</b></div>'
    +'<div><b>'+done+'</b><span>done</span></div><div><b>'+(tot-done)+'</b><span>to go</span></div><div><b>'+r.techs.filter(t=>t.done<t.total).length+'</b><span>techs still on route</span></div><div><b>'+r.techs.filter(t=>t.total&&t.done===t.total).length+'</b><span>finished</span></div></div>';
  $('pbList').innerHTML=(T.length?T.map((t,i)=>{const p=Math.round(t.done/t.total*100),nx=t.stops.find(s=>!s.done),last=[...t.stops].reverse().find(s=>s.done),fin=t.done===t.total;
    return '<div class="tcard'+(fin?' fin':'')+'" style="--i:'+Math.min(i,12)+'"><div class="th">'+avatar(t.driver||t.name)+'<div><b>'+esc(t.name)+'</b>'
      +(t.truck?'<button class="tchip" data-truck="'+esc(t.truck)+'">'+tno(t.truck)+'Show on map</button>':'<small class="muted">No truck matched in Airtable</small>')+'</div><span class="tpct">'+(fin?'Done':p+'%')+'</span></div>'
      +'<div class="pbar"><i style="width:'+p+'%"></i></div><div class="tmeta"><b>'+t.done+' of '+t.total+'</b> pools done'+(last?' · last at '+esc(last.customer||'a pool'):'')+'</div>'
      +(nx?'<div class="tnext"><span>Next</span><b>'+esc(nx.customer||'Pool')+'</b><small>'+esc(nx.address)+(nx.time?' · '+hm(nx.time):'')+'</small></div>':'<div class="tnext fin"><span>All done</span><b>Route finished</b></div>')
      +'<details><summary>All '+t.total+' stops</summary><ol class="tstops">'+t.stops.map(stopLi).join('')+'</ol></details></div>'}).join(''):'<div class="empty">'+(q?'No techs match your search.':'No pools scheduled for this day.')+'</div>')}
document.addEventListener('click',e=>{const b=e.target.closest('.tchip');if(!b)return;document.querySelector('.tabs button[data-v=vMap]').click();select(b.dataset.truck)});
// ---- Cameras tab: every camera event in the fleet, filter by type and driver ----
let CAMALL=[],camTabType='';
async function loadCamTab(){if(!CAMALL.length)$('cgrid').innerHTML='<div class="sk" style="width:60%"></div><div class="sk" style="width:40%"></div>';
  try{CAMALL=await fleetVids();renderCamTab()}catch(e){$('cgrid').innerHTML='<div class="empty">'+esc(e.message)+'</div>'}}
$('camDrv').onchange=()=>renderCamTab();
function renderCamTab(){const ev=CAMALL,q=$('q').value.trim().toLowerCase(),dv=$('camDrv').value;
  const truckOf=x=>{const r=all().find(v=>vid(v)==x.vehicleId);return r?title(r):''};
  const drivers=[...new Set(ev.map(x=>evDriver(x).name).filter(Boolean))].sort();
  $('camDrv').innerHTML='<option value="">All drivers</option>'+drivers.map(d=>'<option'+(d===dv?' selected':'')+'>'+esc(d)+'</option>').join('');
  const byDrv=ev.filter(x=>!dv||evDriver(x).name===dv),c={};byDrv.forEach(x=>{const t=evName(pick(x,'eventType','eventName'));c[t]=(c[t]||0)+1});
  if(camTabType&&!c[camTabType])camTabType='';
  $('camTypes').innerHTML='<button class="cchip'+(camTabType?'':' on')+'" data-ct="">All <b>'+byDrv.length+'</b></button>'+Object.entries(c).sort((a,b)=>b[1]-a[1]).map(([t,n])=>'<button class="cchip pill '+evClass(t)+(camTabType===t?' on':'')+'" data-ct="'+esc(t)+'">'+esc(t)+' <b>'+n+'</b></button>').join('');
  VIDS=byDrv.filter(x=>(!camTabType||evName(pick(x,'eventType','eventName'))===camTabType)&&(!q||(evDriver(x).name+' '+truckOf(x)+' '+evName(pick(x,'eventType','eventName'))+' '+(pick(x,'address')||'')).toLowerCase().includes(q)));
  $('camCount').textContent=ev.length+' events across the fleet · last 7 days';
  // grouped by day, newest first; each card shows the photos big so you can tell what it is before opening it
  const tOf=x=>{const v=pick(x,'eventTime','startTime');return +v||Date.parse(v)||0},dayKey=t=>new Date(t).toLocaleDateString('en-CA');
  const today=dayKey(Date.now()),yest=dayKey(Date.now()-864e5),groups=[];
  VIDS.forEach((x,i)=>{const k=dayKey(tOf(x)),g=groups[groups.length-1];if(g&&g.k===k)g.items.push(i);else groups.push({k,items:[i]})});
  $('cgrid').innerHTML=groups.length?groups.map(g=>'<section class="cday"><h3>'+(g.k===today?'Today':g.k===yest?'Yesterday':new Date(g.k+'T12:00').toLocaleDateString([],{weekday:'long',month:'short',day:'numeric'}))+'<span>'+g.items.length+' event'+(g.items.length>1?'s':'')+'</span></h3><div class="cdgrid">'+g.items.map(i=>camCard(VIDS[i],i,truckOf(VIDS[i]),tOf(VIDS[i]))).join('')+'</div></section>').join(''):'<div class="empty">No camera events match.</div>'}
function camCard(x,i,truck,t){const e=pick(x,'eventType','eventName'),md=evMedia(x),D=evDriver(x);
  const pics=md.snaps.length?md.snaps.slice(0,2):md.videos.filter(v=>v.poster).slice(0,2).map(v=>({name:v.name,url:v.poster}));
  return '<button class="ccard" data-i="'+i+'"'+(md.videos[0]?' data-vid="'+esc(md.videos[0].url)+'"':'')+'><div class="cmedia n'+pics.length+'">'
    +(pics.length?pics.map(p=>'<figure><img src="'+esc(p.url)+'" alt="'+esc(p.name)+' camera" loading="lazy"><figcaption>'+(/driver/i.test(p.name)?'Driver':'Road')+'</figcaption></figure>').join(''):'<div class="cnone">'+(x.requested?'Waiting on the camera to upload':'No photos for this event')+'</div>')
    +'<span class="pill '+evClass(e)+'">'+esc(evName(e))+'</span>'+(md.videos.length?'<span class="cplay">'+ICON.play+' Video</span>':'')+'</div>'
    +'<div class="cbody"><div><b>'+esc(D.name||'Unknown driver')+'</b>'+(D.azuga?flag('The camera stamped this alert with '+D.azuga+', but Airtable lists '+(D.name||'someone else')+' as this truck’s driver.'):'')+'<em>'+(t?new Date(t).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}):'')+'</em></div>'
    +'<small>'+(truck?esc(truck)+' · ':'')+esc(pick(x,'address')||'')+'</small></div></button>'}
// open on click; hovering a card with video plays it silently so you can see what happened
document.addEventListener('click',e=>{const c=e.target.closest('.ccard');if(c)openMedia(+c.dataset.i)});
document.addEventListener('mouseover',e=>{const c=e.target.closest('.ccard[data-vid]');if(!c||c.querySelector('video')||matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  const v=document.createElement('video');v.src=c.dataset.vid;v.muted=v.loop=v.playsInline=true;v.autoplay=true;v.className='cprev';c.querySelector('.cmedia').appendChild(v);
  c.addEventListener('mouseleave',()=>v.remove(),{once:true})});
document.addEventListener('click',e=>{const b=e.target.closest('.cchip');if(!b)return;camTabType=b.dataset.ct;renderCamTab()});
// a few bubbles drifting up behind the page
(()=>{const b=document.createElement('div');b.id='bubbles';b.setAttribute('aria-hidden','true');for(let k=0;k<14;k++){const i=document.createElement('i'),z=8+Math.random()*22;i.style.cssText='left:'+(Math.random()*100).toFixed(1)+'%;width:'+z+'px;height:'+z+'px;animation-duration:'+(14+Math.random()*16).toFixed(1)+'s;animation-delay:-'+(Math.random()*30).toFixed(1)+'s';b.appendChild(i)}document.body.appendChild(b)})();
// sliding white pill behind the active tab
function moveTab(){const b=document.querySelector('.tabs button.on'),i=document.querySelector('.tabind');if(b&&i){i.style.left=b.offsetLeft+'px';i.style.width=b.offsetWidth+'px'}}
addEventListener('resize',moveTab);(document.fonts&&document.fonts.ready||Promise.resolve()).then(moveTab);setTimeout(moveTab,50);
document.querySelectorAll('.tabs button').forEach(b=>b.onclick=()=>{
  document.querySelectorAll('.tabs button').forEach(x=>x.classList.toggle('on',x===b));moveTab();
  ['vMap','vEdit','vDrv','vPom','vCam'].forEach(v=>$(v).hidden=b.dataset.v!==v);if(b.dataset.v==='vPom')loadPomBoard();if(b.dataset.v==='vCam')loadCamTab();if(b.dataset.v==='vMap'&&sel&&TRUCKV.length)drawCams();document.body.dataset.v=b.dataset.v;$('sum').hidden=b.dataset.v!=='vMap';
  if(b.dataset.v!=='vMap')loadSync();if(b.dataset.v==='vEdit')renderEdit();else if(b.dataset.v==='vDrv'){if(!PEOPLE)loadPeople();else renderDrivers()}else map.invalidateSize();
});
$('q').oninput=()=>{render();if(!$('vEdit').hidden)renderEdit();if(!$('vDrv').hidden)renderDrivers();if(!$('vPom').hidden)renderPom();if(!$('vCam').hidden)renderCamTab();};
window.addEventListener('beforeunload',e=>{if(dirtyCount())e.preventDefault()});
refresh();setInterval(refresh,30000);
</script></body></html>`;
