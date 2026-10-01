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
  const r = await fetch(API + path, {
    method,
    headers: { Authorization: 'Bearer ' + (await getToken()), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (r.status === 401) token = null; // force re-login next time
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
  return JSON.parse(text);
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
function cached(key, ttlSec, fn) {
  const c = cache.get(key) || {};
  if (c.data !== undefined && Date.now() - c.t < ttlSec * 1000) return Promise.resolve(c.data);
  if (!c.p) c.p = fn()
    .then(d => { c.data = d; c.t = Date.now(); return d; })
    .catch(e => { if (c.data !== undefined) return c.data; throw e; })
    .finally(() => { c.p = null; });
  cache.set(key, c);
  return c.p;
}

const routes = {
  '/api/vehicles': () => cached('vehicles', 600, () => azuga('/trackees.json?limit=100&offset=0')),
  '/api/locations': () => cached('locations', 30, () => azuga('/vehicles/latestlocation', {})),
  '/api/drivers': () => driverGroups(),
  '/api/airtable': () => atLinks(),
  '/api/people': () => people(),
  '/api/maintenance': () => cached('maintenance', 600, () => azuga('/maintanance/reports/scheduledreport.json?' + new URLSearchParams({
    startTime: fmt(daysAgo(365)), endTime: fmt(daysAgo(-365)), isCount: 'false',
  }))),
  '/api/videos': q => {
    const id = q.get('vehicleId') || '';
    const body = { startTime: fmt(daysAgo(7)), endTime: fmt(new Date()), page: 1, limit: 100, ...(id ? { vehiclesIds: id } : {}) };
    return cached('videos:' + id, id ? 120 : 300, async () => {
      let ev = [];  // all pages, so older clips in the week aren't cut off
      for (let page = 1; page <= (id ? 5 : 15); page++) { const p = list(await azuga('/eventVideos.json?videoType=eventVideo', { ...body, page })); ev = ev.concat(p); if (p.length < body.limit) break; }
      // Clips someone asked the camera for (from this dashboard or Azuga's site)
      let rq = []; try { rq = list(await azuga('/eventVideos.json?videoType=requestedVideo', body)).map(x => ({ ...x, eventType: x.eventType || 'Requested clip', requested: true })); } catch (e) { console.error('Requested videos:', e.message); }
      const t = x => +(x.eventTime || x.startTime || 0) || Date.parse(x.eventTime || x.startTime) || 0;
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
  if ('userId' in b) {
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
  insCard: 'fldH0Pe6EKyQEBmMR', files: 'fldS5YJgDrLDbxSiK', regRenew: 'fldjFFBZ0UoO4SUXV', ezpass: 'fld1utE81nDdDiqgi', active: 'fldBpQ0MA5cD9YJ06' };
// Drivers. Date of birth is only ever written (new driver form), never read or shown.
const D = { name: 'fldMrVtrXN6WDaOjj', license: 'fldcSIYqy5FCEC0Xn', state: 'fld1NdVP4v6QcckK2', pic: 'fldZeCHS22kI7Ythi',
  policy: 'fldVo5IrWedsKvumK', trucks: 'fld47HPqHRrw9GUL7', notes: 'fldSnexzpxIG22gF0', status: 'fldVuSDYSZVHk0fWN' };
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

const atData = () => cached('airtable', 120, async () => {
  const [trucks, drv] = await Promise.all([atAll(AT_TRUCKS, Object.values(F)), atAll(AT_DRIVERS, Object.values(D))]);
  const att = a => (a || []).map(x => ({ name: x.filename, url: x.url, type: x.type, thumb: x.thumbnails?.small?.url }));
  const drivers = drv.map(r => ({ id: r.id, name: clean(r.fields[D.name]), license: clean(r.fields[D.license]), state: clean(r.fields[D.state]),
    policy: clean(r.fields[D.policy]?.name ?? r.fields[D.policy]), notes: clean(r.fields[D.notes]), truckIds: r.fields[D.trucks] || [], pic: att(r.fields[D.pic]),
    status: clean(r.fields[D.status]?.name ?? r.fields[D.status]) || 'Active' }));
  const byId = Object.fromEntries(drivers.map(d => [d.id, d]));
  return {
    drivers,
    trucks: trucks.map(r => { const f = r.fields; return {
      id: r.id, vin: normVin(f[F.vin]), year: clean(f[F.year]), make: clean(f[F.make]), model: clean(f[F.model]),
      truckNo: clean(f[F.truckNo]), policy: clean(f[F.policy]?.name ?? f[F.policy]), plate: clean(f[F.plate]),
      regRenew: clean(f[F.regRenew]), ezpass: clean(f[F.ezpass]), active: !!f[F.active],
      driver: (f[F.driver] || []).map(id => byId[id]).filter(Boolean)[0] || null,
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
  const inAz = new Set((az || []).map(d => normName(d.name)));
  const named = at.drivers.filter(d => d.name);
  return { connected: true, azugaOk: !!az, dupes: dupeGroups(named),
    blank: at.drivers.filter(d => !d.name).map(d => ({ id: d.id, license: d.license, policy: d.policy, trucks: d.truckIds.map(id => truckLabel[id]).filter(Boolean) })),
    drivers: named.sort((a, b) => a.name.localeCompare(b.name)).map(d => ({
    id: d.id, name: d.name, license: d.license, state: d.state, policy: d.policy, notes: d.notes, pic: d.pic, status: d.status,
    trucks: d.truckIds.map(id => truckLabel[id]).filter(Boolean), inAzuga: inAz.has(normName(d.name)) })) };
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
  if ((await drivers()).some(d => normName(d.name) === normName(name))) throw new Error(name + ' is already a driver in Azuga.');
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
    timeZone: tpl.timeZone || 'America/New_York', groupIds: [groupId], userTypeName: 'driver', emailVerification: false,
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
  const photo = b.photo && /^image\/(jpeg|png|webp)$/.test(b.photo.type) && typeof b.photo.data === 'string' && b.photo.data.length < 7e6 ? b.photo : null;
  if (b.photo && !photo) throw new Error('The license photo must be a JPG, PNG or WEBP under 5 MB.');
  const rec = await airtable(AT_DRIVERS, { method: 'POST', body: JSON.stringify({ fields, typecast: true }) });
  if (photo) {
    // Airtable's direct upload: the image goes straight into the License Picture field of the new record
    const up = await fetch('https://content.airtable.com/v0/' + AT_BASE + '/' + rec.id + '/' + D.pic + '/uploadAttachment', {
      method: 'POST', headers: { Authorization: 'Bearer ' + AIRTABLE_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contentType: photo.type, file: photo.data, filename: (name.replace(/[^a-z0-9]+/gi, '-') || 'driver') + '-license.jpg' }) });
    if (!up.ok) console.error('License photo upload failed:', up.status, (await up.text()).slice(0, 200));
  }
  cache.delete('airtable');
  console.log(new Date().toISOString(), 'Airtable driver created', name);
  const saved = ['Airtable'];
  if (b.addToAzuga) {
    try { await createAzugaDriver(name, b.email, b.phone); saved.push('Azuga'); }
    catch (e) { return { ok: true, saved, warning: 'Saved to Airtable, but Azuga said: ' + e.message + ' Use "Add to Azuga" to try again.' }; }
  }
  return { ok: true, saved, id: rec.id };
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

async function readJson(req, max = 10000) {
  let s = '';
  for await (const c of req) { s += c; if (s.length > max) throw new Error('Request too large.'); }
  return JSON.parse(s || '{}');
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
  // Browser's built-in login box. Any username works; password must match.
  const given = Buffer.from((req.headers.authorization || '').split(' ')[1] || '', 'base64').toString().split(':').slice(1).join(':');
  if (!DASHBOARD_PASSWORD || given !== DASHBOARD_PASSWORD) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Fleet Dashboard"' });
    return res.end(DASHBOARD_PASSWORD ? 'Login required' : 'Set DASHBOARD_PASSWORD to use this dashboard');
  }
  const url = new URL(req.url, 'http://x');
  const POSTS = { '/api/update': saveTruck, '/api/sync': b => syncOne(String(b.trackeeId || '')), '/api/driver/create': createDriver, '/api/driver/azuga': addDriverToAzuga, '/api/driver/merge': mergeDrivers, '/api/driver/delete': deleteBlankDriver, '/api/driver/status': setDriverStatus };
  if (POSTS[url.pathname]) {
    // JSON-only + POST-only, so another website can't trigger a change with a plain form
    if (req.method !== 'POST' || !/application\/json/.test(req.headers['content-type'] || '')) { res.writeHead(405); return res.end(); }
    try {
      const b = await readJson(req, url.pathname === '/api/driver/create' ? 8e6 : 10000);  // room for a license photo
      const out = await POSTS[url.pathname](b);
      res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(out));
    } catch (e) {
      console.error('Update failed:', e.message);
      res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: e.message }));
    }
  }
  if (url.pathname === '/api/media') return media(url.searchParams.get('u'), req, res);
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
main{display:grid;grid-template-columns:350px 1fr;gap:14px;padding:12px 24px 24px;height:calc(100vh - 126px);min-height:560px}
#list{overflow:auto;background:var(--card);border-radius:var(--r);box-shadow:var(--sh)}
.card{display:flex;gap:11px;align-items:flex-start;padding:12px 14px;border-bottom:1px solid var(--line);cursor:pointer;transition:background .12s}
.card:last-child{border-bottom:0}.card:hover{background:#faf8f4}
.card.sel{background:var(--shallow)}
.av{flex:none;width:34px;height:34px;border-radius:50%;background:var(--shallow);color:var(--poolInk);display:grid;place-items:center;font-weight:700;font-size:12px}
.av.none{background:var(--deck2);color:var(--muted)}.av.none svg{width:17px;height:17px}
.card.sel .av{background:#fff}
.ci{min-width:0;flex:1}
.ci .top{display:flex;justify-content:space-between;gap:8px;align-items:center}
.ci b{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
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
#right.open #map{grid-area:map}#donut{grid-area:donut}#cams{grid-area:cams}#detail{grid-area:detail}
.pane{background:var(--card);border-radius:var(--r);box-shadow:var(--sh);padding:16px 18px;overflow:auto;min-height:0}
#cams h3{margin-top:0}#cams .evth{width:72px;height:44px}
#donut{display:flex;gap:14px;align-items:center}#donut svg{flex:0 0 140px;width:140px}#donut .leg{flex:1;min-width:0}
#donut .arc{cursor:pointer;transition:opacity .15s}#donut .arc.dim{opacity:.18}
#donut .dn{font-size:30px;font-weight:700;text-anchor:middle;fill:var(--deep)}#donut .dl{font-size:12px;text-anchor:middle;fill:var(--muted)}
.leg{list-style:none;margin:0;padding:0}.leg button{display:grid;grid-template-columns:10px 1fr auto 34px;gap:8px;align-items:center;width:100%;min-height:30px;border:0;background:none;font:inherit;font-size:12.5px;text-align:left;padding:2px 6px;border-radius:7px;cursor:pointer;color:inherit}
.leg button:hover,.leg button.on{background:var(--shallow)}.leg button.dim{opacity:.45}.leg i{width:10px;height:10px;border-radius:3px}.leg em{font-style:normal;color:var(--muted);text-align:right}
.leg span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dclose{margin-left:8px;font:inherit;font-size:20px;line-height:1;color:var(--muted);background:none;border:0;cursor:pointer;padding:4px 8px;border-radius:8px}.dclose:hover{background:var(--deck)}
#map{border-radius:var(--r);box-shadow:var(--sh);background:#dfe7e6}
.leaflet-tile-pane{filter:saturate(.55) sepia(.08) brightness(1.03) contrast(.96)}
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
#vEdit,#vDrv{padding:14px 24px 24px}
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
.crewhead{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px}
.crewhead h2{margin:0;font-size:20px;font-weight:700;letter-spacing:-.01em}.crewhead p{margin:2px 0 0;font-size:13px}
.nd{padding:18px 20px;margin-bottom:12px}
.scan{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:14px;padding-bottom:14px;border-bottom:1px solid var(--line)}
.scan label{display:inline-flex;align-items:center;cursor:pointer}.scan .hint{font-size:12px;color:var(--muted)}
#frontPrev{height:44px;border-radius:6px;border:1px solid var(--line2)}
.roster{max-width:1100px}
.rrow{display:grid;grid-template-columns:18px 36px minmax(200px,1fr) minmax(180px,.9fr) 130px;gap:14px;align-items:center;padding:11px 18px;border-bottom:1px solid var(--line)}
.rrow:last-child{border-bottom:0}.rrow:hover{background:#fcfbf8}
.rrow.off{opacity:.55}.rrow.off:hover{opacity:.8}
.mav{width:36px;height:36px;border-radius:50%;display:grid;place-items:center;font-weight:700;font-size:12px;background:var(--shallow);color:var(--poolInk)}
.rn{min-width:0}.rn b{display:block;font-weight:600}.rn span{display:block;font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
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

@media(max-width:900px){
 header{padding:12px 16px}.bar{padding:12px 16px 0}.search{flex:1 1 100%}
 main{grid-template-columns:1fr;height:auto;padding:12px 16px}#list{max-height:45vh}#right,#right.open{grid-template-columns:1fr;grid-template-rows:auto;grid-template-areas:none}#right>*{grid-area:auto!important}#map{height:300px}#detail{order:1}#donut{order:2}#cams{order:3}#donut{flex-wrap:wrap;justify-content:center}
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
</style></head><body>
<header>
 <div class="brand"><div class="logo"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M3 9c1.5 1.3 3 1.3 4.5 0s3-1.3 4.5 0 3 1.3 4.5 0 3-1.3 4.5 0"/><path d="M3 15c1.5 1.3 3 1.3 4.5 0s3-1.3 4.5 0 3 1.3 4.5 0 3-1.3 4.5 0" opacity=".6"/></svg></div><div>Millennial Pools<small>Fleet</small></div></div>
 <div class="live" id="live"><span class="dot"></span><span id="upd">Connecting to Azuga...</span></div>
 <nav class="tabs"><button data-v="vMap" class="on">Live map</button><button data-v="vEdit">Edit vehicles</button><button data-v="vDrv">Drivers</button></nav>
</header>
<div class="bar"><div class="search"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input id="q" placeholder="Search trucks or drivers" aria-label="Search trucks or drivers"></div><nav class="sum" id="sum" aria-label="Filter vehicles"></nav></div>
<div id="err"></div>
<dialog id="media" aria-label="Camera event"><div id="mbody"></div></dialog>
<div id="vMap">
<main><div id="list"><div class="card"><div class="av none"></div><div class="ci"><div class="sk" style="width:60%"></div><div class="sk" style="width:40%"></div><div class="sk" style="width:80%"></div></div></div><div class="card"><div class="av none"></div><div class="ci"><div class="sk" style="width:60%"></div><div class="sk" style="width:40%"></div><div class="sk" style="width:80%"></div></div></div><div class="card"><div class="av none"></div><div class="ci"><div class="sk" style="width:60%"></div><div class="sk" style="width:40%"></div><div class="sk" style="width:80%"></div></div></div><div class="card"><div class="av none"></div><div class="ci"><div class="sk" style="width:60%"></div><div class="sk" style="width:40%"></div><div class="sk" style="width:80%"></div></div></div></div>
<div id="right"><div id="donut" class="pane"></div><div id="map"></div><div id="cams" class="pane"><h3>Camera events, last 7 days</h3><div id="vids"></div></div><div id="detail"></div></div></main></div>
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
 <div id="dupes"></div>
 <div class="panel roster" id="drvRows"><div class="rrow"><div class="mav sk" style="height:36px;width:36px;border-radius:50%"></div><div style="flex:1"><div class="sk" style="width:30%"></div><div class="sk" style="width:20%"></div></div></div><div class="rrow"><div class="mav sk" style="height:36px;width:36px;border-radius:50%"></div><div style="flex:1"><div class="sk" style="width:30%"></div><div class="sk" style="width:20%"></div></div></div><div class="rrow"><div class="mav sk" style="height:36px;width:36px;border-radius:50%"></div><div style="flex:1"><div class="sk" style="width:30%"></div><div class="sk" style="width:20%"></div></div></div><div class="rrow"><div class="mav sk" style="height:36px;width:36px;border-radius:50%"></div><div style="flex:1"><div class="sk" style="width:30%"></div><div class="sk" style="width:20%"></div></div></div><div class="rrow"><div class="mav sk" style="height:36px;width:36px;border-radius:50%"></div><div style="flex:1"><div class="sk" style="width:30%"></div><div class="sk" style="width:20%"></div></div></div><div class="rrow"><div class="mav sk" style="height:36px;width:36px;border-radius:50%"></div><div style="flex:1"><div class="sk" style="width:30%"></div><div class="sk" style="width:20%"></div></div></div></div>
</div>
<div id="vEdit" hidden><div class="ed">
 <aside class="panel edl"><div class="edf"><label><input type="checkbox" id="needs"> Only show trucks that need attention</label><div id="syncBar" style="margin-top:10px"></div></div><div id="edList"></div></aside>
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
const title=r=>atTitle(vid(r))||vname(r);
const azSub=r=>{const t=atTitle(vid(r));return t&&t.toLowerCase()!==vname(r).toLowerCase()?'<small class="azn">Azuga: '+esc(vname(r))+'</small>':''};
// Unnamed drivers come through as a phone number like "9052487042 ."
// Driver shown on the map: Azuga's, or Airtable's when Azuga has none
const who=r=>{const d=dname(r);if(/[a-z]/i.test(d))return d;const L=link(vid(r));return L&&L.linked&&L.truck.driver?L.truck.driver.name:d};
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
const tno=id=>{const L=link(id);return L&&L.linked&&L.truck.truckNo?'<span class="tno">#'+esc(L.truck.truckNo.split(/[ ~(]/)[0])+'</span>':''};
const avatar=(d,big)=>{const named=/[a-z]/i.test(d);return '<div class="av'+(named?'':' none')+'"'+(big?' style="width:44px;height:44px;font-size:14px"':'')+'>'+(named?esc(initials(d)):ICON.truck)+'</div>'};
const evName=e=>String(e||'Event').replace(/^CAM_/,'').replace(/_MESSAGE$/,'').replace(/_/g,' ').toLowerCase().replace(/^./,c=>c.toUpperCase()).replace('Hard breaking','Hard braking');
const evClass=e=>/FATIGUE|DISTRACT|VIOLENT|COLLISION|PHONE|SMOK|SPEED/i.test(e)?'bad':'warn';
const links=o=>JSON.stringify(o).match(/https?:[^"\\\\]+/g)||[];
let vehicles=[],locs=[],maint=null,sel=null,markers={};
const map=L.map('map',{zoomControl:true}).setView([40.2,-74.8],8);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'&copy; OpenStreetMap',maxZoom:19}).addTo(map);
const Legend=L.Control.extend({onAdd(){const d=L.DomUtil.create('div','legend');d.innerHTML='<span><i style="background:#16a34a"></i>Moving</span><span><i style="background:#0a2c40"></i>Parked</span><button type="button">Show all trucks</button>';L.DomEvent.disableClickPropagation(d);d.querySelector('button').onclick=fitAll;return d}});
new Legend({position:'topright'}).addTo(map);
// Nearby trucks merge into one numbered bubble; trucks parked on the same spot fan out when clicked
const cluster=L.markerClusterGroup({showCoverageOnHover:false,maxClusterRadius:42,spiderfyOnMaxZoom:true,
  iconCreateFunction:c=>{const ms=c.getAllChildMarkers();return L.divIcon({className:'tm',html:'<span class="clu'+(ms.some(m=>m._mv)?' mv':'')+'">'+ms.length+'</span>',iconSize:[0,0]})}});
map.addLayer(cluster);
let lastPts=[];function fitAll(){if(lastPts.length)map.fitBounds(lastPts,{paddingTopLeft:[40,80],paddingBottomRight:[40,40],maxZoom:13})}
let fitted=false;

async function get(p){const r=await fetch(p);const j=await r.json();if(j.error)throw new Error(j.error);return j}
function showErr(e){$('err').textContent=e?'Azuga is not answering right now ('+e.message+'). Showing the last data we have.':''}

async function refresh(){
  try{
    const [v,l]=await Promise.all([vehicles.length?null:get('/api/vehicles'),get('/api/locations')]);
    if(v)vehicles=list(v);locs=list(l);showErr();
    $('upd').textContent='Live · '+new Date().toLocaleTimeString([], {hour:'numeric',minute:'2-digit'});$('live').classList.remove('down');
    render();
  }catch(e){showErr(e);$('upd').textContent='Reconnecting...';$('live').classList.add('down')}
}
function all(){
  const byId={};vehicles.forEach(v=>byId[vid(v)]=v);
  return locs.length?locs.map(l=>({...byId[vid(l)],...l})):vehicles;
}
let filt='all';
const FILTERS={all:['All trucks',()=>true,''],moving:['Moving',moving,'var(--goDot)'],parked:['Parked',r=>!moving(r),'var(--idleDot)'],nodriver:['No driver',r=>!/[a-z]/i.test(who(r)),'var(--warnDot)']};
function rows(){
  const q=$('q').value.toLowerCase();
  return all().filter(r=>FILTERS[filt][1](r)&&(!q||(title(r)+' '+vname(r)+' '+who(r)).toLowerCase().includes(q)))
    .sort((a,b)=>moving(b)-moving(a)||title(a).localeCompare(title(b)));
}
function render(){
  const a=all(),rs=rows();
  $('sum').innerHTML=Object.entries(FILTERS).map(([k,[label,fn,c]])=>'<button data-f="'+k+'" aria-pressed="'+(filt===k)+'">'+(c?'<span class="dot" style="background:'+c+'"></span>':'')+label+' <b>'+a.filter(fn).length+'</b></button>').join('');
  $('sum').querySelectorAll('button').forEach(b=>b.onclick=()=>{filt=b.dataset.f;render()});
  const emptyMsg=!a.length?'<b>No trucks yet</b>Once Azuga reports your trucks, they show up here.'
    :filt==='moving'&&!$('q').value?'<b>Every truck is parked</b>Nothing on the road right now.'
    :filt==='nodriver'&&!$('q').value?'<b>Every truck has a driver</b>Nice and tidy.'
    :'<b>No matches</b>Try a different search, or pick All trucks above.';
  $('list').innerHTML=rs.length?rs.map(r=>{const d=who(r),named=/[a-z]/i.test(d);return '<div class="card'+(sel==vid(r)?' sel':'')+'" data-id="'+esc(vid(r))+'" tabindex="0" role="button">'+avatar(d)+'<div class="ci"><div class="top"><b>'+tno(vid(r))+esc(title(r))+'</b>'+status(r)+'</div>'+azSub(r)+'<div class="d">'+(named?esc(d):'<span class="muted">No driver assigned</span>')+'</div><div class="a">'+esc(pick(r,'address','landmark')||'Location unavailable')+'</div></div></div>'}).join(''):'<div class="empty">'+emptyMsg+'</div>';
  document.querySelectorAll('.card').forEach(c=>c.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();select(c.dataset.id)}});
  document.querySelectorAll('.card').forEach(c=>c.onclick=()=>select(c.dataset.id));
  const pts=[],shown=new Set(rs.map(vid));
  Object.entries(markers).forEach(([id,m])=>{if(!shown.has(id)&&cluster.hasLayer(m))cluster.removeLayer(m)});
  rs.forEach(r=>{const lat=+pick(r,'latitude','lat'),lng=+pick(r,'longitude','lng','lon');if(!lat||!lng)return;pts.push([lat,lng]);
    const id=vid(r),isSel=sel==id,mv=moving(r),L2=link(id),num=L2&&L2.linked&&L2.truck.truckNo?L2.truck.truckNo.split(/[ ~(]/)[0]:'';
    const label=num||(/[a-z]/i.test(who(r))?initials(who(r)):'')||ICON.truck;
    const html='<span class="pin'+(mv?' mv':'')+(isSel?' sel':'')+'">'+(num||!/</.test(label)?esc(label):label)+'</span>';
    const m=markers[id]||(markers[id]=L.marker([lat,lng],{icon:L.divIcon({className:'tm',html,iconSize:[0,0]}),keyboard:false}).on('click',()=>select(id)));m._mv=mv;if(!cluster.hasLayer(m))cluster.addLayer(m);
    if(m._html!==html){m.setIcon(L.divIcon({className:'tm',html,iconSize:[0,0]}));m._html=html}
    m.setLatLng([lat,lng]).setZIndexOffset(isSel?1000:mv?500:0).bindTooltip(esc(title(r))+(/[a-z]/i.test(who(r))?' · '+esc(who(r)):'')+(mv?' · '+Math.round(speed(r))+' mph':''),{direction:'top',offset:[0,-14]});
  });
  cluster.refreshClusters();
  lastPts=pts;if(!fitted&&pts.length){fitAll();fitted=true}
}
async function select(id){
  sel=id;$('right').classList.add('open');setTimeout(()=>map.invalidateSize(),0);render();const r=all().find(x=>vid(x)==id)||{};
  const mk=markers[id];if(mk)map.setView(mk.getLatLng(),Math.max(map.getZoom(),15),{animate:false});  // one jump; the step-by-step cluster zoom felt slow
  const d=who(r),named=/[a-z]/i.test(d),mmy=[r.year,r.make,r.model].filter(Boolean).join(' ');
  $('detail').innerHTML='<div class="dh">'+avatar(d,1)+'<div><h2>'+tno(id)+esc(title(r))+'</h2>'+azSub(r)+'<p>'+(named?esc(d):'No driver assigned')+(mmy?' · '+esc(mmy):'')+'</p></div><div style="margin-left:auto;display:flex;align-items:center">'+status(r)+'<button class="dclose" id="dclose" aria-label="Close details">×</button></div></div>'
   +'<div class="grid"><div class="kv"><span>Odometer</span><b>'+esc(odo(r))+'</b></div><div class="kv"><span>Speed</span><b>'+(moving(r)?Math.round(speed(r)):0)+' mph</b></div><div class="kv"><span>Group</span><b>'+esc(pick(r,'groupName')||'–')+'</b></div><div class="kv"><span>Plate</span><b>'+esc(pick(r,'licensePlate','licensePlateNo','plateNumber')||'–')+'</b></div></div>'
   +'<div class="addr">'+ICON.pin+esc(pick(r,'address','landmark')||'Location unavailable')+'</div>'
   +atBox(id)
   +'<h3>Maintenance</h3><div id="m"><div class="sk" style="width:55%"></div></div>'
   +'<details><summary>All Azuga data for this vehicle</summary><pre>'+esc(JSON.stringify(r,null,2))+'</pre></details>';
  try{if(!maint)maint=list(await get('/api/maintenance'));
    const m=maint.filter(x=>vid(x)==id||vname(x)==vname(r));
    $('m').innerHTML=m.length?m.map(x=>{const s=String(pick(x,'status','reminderStatus')||'');return '<div class="ev"><span class="pill '+(/over/i.test(s)?'bad':/up/i.test(s)?'warn':'idle')+'">'+esc(s||'Scheduled')+'</span><b>'+esc(pick(x,'serviceType','serviceName')||'Service')+'</b><span class="t">'+esc(when(pick(x,'nextServiceDate','dueDate')))+(pick(x,'nextServiceOdometer')?' · at '+esc(pick(x,'nextServiceOdometer'))+' mi':'')+'</span></div>'}).join(''):'<span class="muted">'+(r.maintenanceEnabled===false?'Maintenance tracking is off for this truck in Azuga.':'Nothing due.')+'</span>';
  }catch(e){$('m').innerHTML='<span class="muted">'+esc(e.message)+'</span>';retry(id)}
  $('vids').innerHTML='<div class="sk" style="width:70%"></div><div class="sk" style="width:50%"></div>';$('donut').innerHTML='<div class="sk" style="width:60%"></div>';
  try{const v=(await fleetVids()).filter(x=>x.vehicleId==id);if(sel!=id)return;
    TRUCKV=v;camType='';drawCams();
  }catch(e){if(sel!=id)return;$('vids').innerHTML='<span class="muted">'+esc(e.message)+'</span>';$('donut').innerHTML='';retry(id)}
}
function closeDetail(){sel=null;$('right').classList.remove('open');setTimeout(()=>map.invalidateSize(),0);render()}
document.addEventListener('click',e=>{if(e.target.id==='dclose')closeDetail()});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('media').open&&sel&&!$('vMap').hidden)closeDetail()});
// Camera events: Azuga gives video links when a clip has uploaded, otherwise still photos from both cameras
let VIDS=[];
function evRow(x,i){const e=pick(x,'eventType','eventName'),md=evMedia(x),th=md.videos[0]&&md.videos[0].poster||md.snaps[0]&&md.snaps[0].url;
      const drv=[x.firstName,x.lastName].filter(Boolean).join(' ')||pick(x,'driverName')||'';
      return '<button class="ev evb" data-i="'+i+'"'+'>'
        +(th?'<span class="evth"><img src="'+esc(th)+'" alt="" loading="lazy">'+(md.videos.length?'<i>'+ICON.play+'</i>':'')+'</span>':'<span class="evth none">'+(x.requested?'Waiting':'No media')+'</span>')
        +'<span class="evi">'+'<span class="pill '+evClass(e)+'">'+esc(evName(e))+'</span><span class="t">'+esc(when(pick(x,'eventTime','startTime')))+(drv?' · '+esc(drv):'')+'</span>'
        +'<span class="muted" style="font-size:12px">'+esc(pick(x,'address')||'')+'</span></span>'
        +'<span class="evgo">'+(md.videos.length?'Watch':md.snaps.length?'View photos':x.requested?'Waiting on camera':'')+'</span></button>'}
// ---- Selected truck: circle graph of its camera events; clicking a slice filters the list ----
let TRUCKV=[],camType='';
const CAMCOL=['#2a78d6','#eb6834','#1baf7a','#eda100','#e87ba4','#008300'],CAMOTHER='#8a9aa6';
function camGroups(v){const c={};v.forEach(x=>{const t=evName(pick(x,'eventType','eventName'));c[t]=(c[t]||0)+1});
  const g=Object.entries(c).sort((a,b)=>b[1]-a[1]),top=g.slice(0,6).map(([t,n],k)=>({t,n,col:CAMCOL[k]})),rest=g.slice(6);
  if(rest.length)top.push({t:'Other',n:rest.reduce((a,b)=>a+b[1],0),col:CAMOTHER,others:rest.map(r=>r[0])});return top}
function drawCams(){const v=TRUCKV,g=camGroups(v),tot=v.length,R=70,C=2*Math.PI*R;let off=0;
  const arcs=g.map(x=>{const len=x.n/tot*C,a='<circle class="arc'+(camType&&camType!==x.t?' dim':'')+'" data-t="'+esc(x.t)+'" r="'+R+'" cx="90" cy="90" fill="none" stroke="'+x.col+'" stroke-width="26" stroke-dasharray="'+Math.max(len-(g.length>1?2:0),.5)+' '+C+'" stroke-dashoffset="'+(-off)+'"><title>'+esc(x.t)+': '+x.n+' ('+Math.round(x.n/tot*100)+'%)</title></circle>';off+=len;return a}).join('');
  $('donut').innerHTML=tot?'<svg viewBox="0 0 180 180" role="img" aria-label="Camera events by type"><g transform="rotate(-90 90 90)">'+arcs+'</g><text x="90" y="88" class="dn">'+tot+'</text><text x="90" y="108" class="dl">events, 7 days</text></svg>'
    +'<ul class="leg">'+g.map(x=>'<li><button data-t="'+esc(x.t)+'" class="'+(camType===x.t?'on':camType?'dim':'')+'"><i style="background:'+x.col+'"></i><span>'+esc(x.t)+'</span><b>'+x.n+'</b><em>'+Math.round(x.n/tot*100)+'%</em></button></li>').join('')+'</ul>'
    :'<p class="muted" style="margin:auto">No camera events this week. Safe driving.</p>';
  const oth=(g.find(x=>x.t==='Other')||{}).others||[];
  VIDS=v.filter(x=>{const t=evName(pick(x,'eventType','eventName'));return !camType||t===camType||(camType==='Other'&&oth.includes(t))});
  $('vids').innerHTML=VIDS.length?VIDS.map((x,i)=>evRow(x,i)).join(''):'<span class="muted">No camera events this week.</span>'}
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
  const x=VIDS[i];if(!x)return;const md=evMedia(x),e=pick(x,'eventType','eventName'),drv=[x.firstName,x.lastName].filter(Boolean).join(' ');
  $('mbody').innerHTML='<div class="mhead"><div><span class="pill '+evClass(e)+'">'+esc(evName(e))+'</span><h3>'+esc(when(pick(x,'eventTime','startTime')))+(drv?' · '+esc(drv):'')+'</h3><p class="muted">'+esc(pick(x,'address')||'')+(x.speed?' · '+Math.round(x.speed*0.621371)+' mph':'')+'</p></div><button class="dclose" id="mclose" aria-label="Close">×</button></div>'
   +'<div class="mgrid">'+(md.videos.length?md.videos.map(v=>'<figure><video src="'+esc(v.url)+'" controls playsinline preload="metadata"'+(v.poster?' poster="'+esc(v.poster)+'"':'')+'></video><figcaption>'+esc(v.name)+' · <a href="'+esc(v.url)+'" target="_blank" rel="noopener">Open in new tab</a></figcaption></figure>').join('')
     :md.snaps.map(s=>'<figure><img src="'+esc(s.url)+'" alt="'+esc(s.name)+'"><figcaption>'+esc(s.name)+'</figcaption></figure>').join(''))+'</div>'
   +(md.videos.length?'':x.requested?'<p class="muted" style="margin:10px 0 0;font-size:13px">Clip requested. The camera uploads it the next time the truck is on; it will play here once it arrives.</p>':'<p class="muted" style="margin:10px 0 0;font-size:13px">'+(md.snaps.length?'Azuga only has photos for this event, no video clip.':'Azuga has no photos or video for this event.')+'</p>');
  $('media').showModal();const v=$('mbody').querySelector('video');if(v)v.play().catch(()=>{});
}
document.addEventListener('click',e=>{const b=e.target.closest('.evb');if(b&&!b.disabled)openMedia(+b.dataset.i);if(e.target.id==='mclose'||e.target.id==='media')closeMedia()});
function closeMedia(){$('mbody').querySelectorAll('video').forEach(v=>v.pause());$('media').close()}
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
setInterval(loadAT,120000);

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
const bareTracker=v=>/^\d+$/.test(vname(v))&&!v.vin;
const edRows=()=>{const q=$('q').value.toLowerCase();return vehicles.filter(v=>(!q||(title(v)+' '+vname(v)+' '+dname(v)).toLowerCase().includes(q))&&(!$('needs').checked||missing(v).length||outOfSync(v))).sort((a,b)=>bareTracker(a)-bareTracker(b)||title(a).localeCompare(title(b)))};
const dirtyCount=()=>document.querySelectorAll('#edCard .dirty').length;
function renderEdit(){
  const rs=edRows();
  $('edList').innerHTML=rs.length?rs.map(v=>{const m=missing(v);return '<div class="eli'+(edSel==vid(v)?' sel':'')+'" data-id="'+esc(vid(v))+'"><div><b>'+tno(vid(v))+esc(title(v))+'</b>'+azSub(v)+'<small>'+esc(/[a-z]/i.test(dname(v))?dname(v):'No driver')+(pick(v,'licensePlateNo','licensePlate')?' · '+esc(pick(v,'licensePlateNo','licensePlate')):'')+'</small></div>'+(outOfSync(v)?'<span class="pill warn">Sync</span>':m.length?'<span class="bang" title="Missing '+m.join(', ')+'" aria-label="Missing '+m.join(', ')+'">!</span>':'')+'</div>'}).join(''):'<div class="empty" style="padding:30px">'+(vehicles.length?'No trucks match.':'Loading...')+'</div>';
  document.querySelectorAll('.eli').forEach(e=>e.onclick=()=>openEd(e.dataset.id));
  const n=vehicles.filter(outOfSync).length;
  if(!syncing)$('syncBar').innerHTML=!AT?'':!AT.connected?'<span class="muted">Airtable not connected</span>':AT.error?'<span class="muted">Airtable unavailable</span>':n?'<button class="btn2 pri" id="syncAll" style="width:100%">Sync '+n+' truck'+(n>1?'s':'')+' from Airtable → Azuga</button>':'<span style="color:var(--go);display:inline-flex;gap:6px;align-items:center">'+ICON.check+'Azuga matches Airtable</span>';
  if($('syncAll'))$('syncAll').onclick=syncAll;
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
  document.querySelectorAll('#edCard .dirty').forEach(el=>{const lbl=el.closest('label').firstChild.textContent.trim();
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
async function loadPeople(){try{PEOPLE=await get('/api/people')}catch(e){PEOPLE={connected:true,error:e.message,drivers:[]}}renderDrivers()}
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
  $('drvRows').innerHTML=(ds.length?ds.map(d=>'<div class="rrow'+(inactive(d)?' off':'')+(picked.has(d.id)?' picked':'')+'" data-id="'+esc(d.id)+'"><input type="checkbox" class="pick" aria-label="Select '+esc(d.name)+'"'+(picked.has(d.id)?' checked':'')+'><div class="mav">'+esc(initials(d.name))+'</div>'
    +'<div class="rn"><b>'+esc(d.name)+(inactive(d)?'<span class="tag">Inactive</span>':!d.license?'<span class="bang" title="No license on file">!</span>':'')+'</b><span>'+esc([d.license&&((d.state?d.state+' ':'')+d.license),!inactive(d)&&d.policy].filter(Boolean).join(' · ')||'No license on file')+(d.notes?' · '+esc(d.notes):'')+'</span></div>'
    +'<div class="rt'+(d.trucks.length?'':' none')+'">'+(d.trucks.length?d.trucks.map(esc).join(', '):'No truck')+'</div>'
    +'<div class="rs">'+(!PEOPLE.azugaOk||inactive(d)?'':d.inAzuga?'<span class="inaz">In Azuga</span>':'<button class="link azbtn">Add to Azuga</button>')+'</div>'
    +'</div>').join('')
    :'<div class="empty" style="padding:36px"><b>'+(dfilt==='noaz'&&!q?'Everyone is in Azuga':'No drivers match')+'</b>'+(dfilt==='noaz'&&!q?'The whole crew can be assigned to trucks.':'Try a different search or filter.')+'</div>')
    +'<button class="addrow" id="addRow"><span class="mav">+</span>Add a driver</button>';
  $('addRow').onclick=()=>$('newDrvBtn').click();
  document.querySelectorAll('.pick').forEach(c=>c.onchange=()=>{const id=c.closest('.rrow').dataset.id;c.checked?picked.add(id):picked.delete(id);c.closest('.rrow').classList.toggle('picked',c.checked);renderSelbar()});
  renderSelbar();
  document.querySelectorAll('.azbtn').forEach(b=>b.onclick=async()=>{const t=b.closest('.rrow');b.disabled=true;b.textContent='Adding...';
    try{await post('/api/driver/azuga',{airtableId:t.dataset.id});driverList=null;await loadPeople()}
    catch(e){b.disabled=false;b.textContent='Try again';b.title=e.message;t.querySelector('.rn span').textContent='Azuga said: '+e.message}});
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
document.querySelectorAll('.tabs button').forEach(b=>b.onclick=()=>{
  document.querySelectorAll('.tabs button').forEach(x=>x.classList.toggle('on',x===b));
  ['vMap','vEdit','vDrv'].forEach(v=>$(v).hidden=b.dataset.v!==v);$('sum').hidden=b.dataset.v!=='vMap';
  if(b.dataset.v==='vEdit')renderEdit();else if(b.dataset.v==='vDrv'){if(!PEOPLE)loadPeople();else renderDrivers()}else map.invalidateSize();
});
$('q').oninput=()=>{render();if(!$('vEdit').hidden)renderEdit();if(!$('vDrv').hidden)renderDrivers();};
window.addEventListener('beforeunload',e=>{if(dirtyCount())e.preventDefault()});
refresh();setInterval(refresh,30000);
</script></body></html>`;
