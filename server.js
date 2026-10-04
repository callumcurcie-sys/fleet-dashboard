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
  '/api/sync/status': async () => ({ running: SYNC.running, last: SYNC.last, log: SYNC.log.slice(0, 20), imported: AIRTABLE_TOKEN ? (await atData()).trucks.some(t => t.snap) || (await atData()).drivers.some(d => d.snap) : false }),
  '/api/maintenance': () => cached('maintenance', 600, () => azuga('/maintanance/reports/scheduledreport.json?' + new URLSearchParams({
    startTime: fmt(daysAgo(365)), endTime: fmt(daysAgo(-365)), isCount: 'false',
  }))),
  '/api/ramp': q => rampFor(q.get('name') || ''),
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
  if (r.status === 401) rampTok = null;
  if (!r.ok) throw new Error('Ramp ' + r.status + ' on ' + new URL(url).pathname.split('/').pop() + ': ' + (await r.text()).slice(0, 160));
  return r.json();
}
const isGas = t => t.sk_category_id === 18 || /fuel|gas/i.test(t.sk_category_name || '');   // Ramp's "Fuel and Gas" category
// Reimbursements carry no category, so gas is spotted by the merchant or memo ("Wawa", memo "Gas")
const GAS_WORDS = /\bgas\b|fuel|wawa|sunoco|shell|exxon|mobil|\bbp\b|speedway|valero|citgo|lukoil|gulf|getty|royal farms|sheetz|quick ?chek|costco gas/i;
async function rampAll(path, q) {   // every page of a Ramp list
  let url = 'https://api.ramp.com/developer/v1/' + path + '?' + new URLSearchParams({ page_size: '100', ...q }), out = [], pages = 0;
  while (url && pages++ < 50) { const j = await ramp(url); out = out.concat(j.data || []); url = j.page && j.page.next; }
  return out;
}
const rampSpend = () => cached('ramp', 900, async () => {
  const since = new Date(Date.now() - 30 * 864e5), by = {};
  const add = (name, amt, gas) => { name = clean(name); if (!name || !amt) return;
    const p = by[normName(name)] = by[normName(name)] || { name, gas: 0, other: 0, gasN: 0, otherN: 0 };
    if (gas) { p.gas += amt; p.gasN++; } else { p.other += amt; p.otherN++; } };
  const money = a => typeof a === 'number' ? a : Number(a && a.amount) / 100 || 0;
  for (const t of await rampAll('transactions', { from_date: since.toISOString() })) {
    if (/DECLINED|ERROR/i.test(t.state || '')) continue;
    const h = t.card_holder || {};
    add([h.first_name, h.last_name].filter(Boolean).join(' '), money(t.amount), isGas(t));
  }
  // Out-of-pocket gas is a big share, so reimbursements count too (skipped if the Ramp app can't read them)
  if (/reimbursements/.test(rampScopes)) try {
    const users = Object.fromEntries((/users/.test(rampScopes) ? await rampAll('users', {}).catch(() => []) : []).map(u => [u.id, [u.first_name, u.last_name].filter(Boolean).join(' ')]));
    for (const r of await rampAll('reimbursements', { from_date: since.toISOString() })) {
      if (/REJECT|CANCEL|DRAFT/i.test(r.state || r.status || '') || Date.parse(r.transaction_date || r.created_at) < +since) continue;
      add(users[r.user_id] || r.user_full_name || '', money(r.amount), GAS_WORDS.test((r.merchant || r.merchant_name || '') + ' ' + (r.memo || '')));
    }
  } catch (e) { console.error('Ramp reimbursements:', e.message); }
  return { since: since.toISOString(), people: Object.values(by), scopes: rampScopes };
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
  const d = await rampSpend(), p = name ? rampMatch(d.people, name) : null;
  return { connected: true, since: d.since, person: p };
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
.ramp{margin:12px 0;padding:12px 14px;border-radius:14px;background:#121212;color:#f4f4ef;box-shadow:0 6px 18px rgba(0,0,0,.18)}.ramp:empty{display:none}
.ramp h4{margin:0 0 10px;font-size:13px;font-weight:600;color:#d6d6cf;display:flex;align-items:center;gap:8px}.ramp .rtag{background:#e4f222;color:#111;font-weight:800;border-radius:6px;padding:2px 8px;font-size:12px}
.rgrid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.rgrid>div{background:#1d1d1d;border-radius:10px;padding:10px 12px}.rgrid span{display:block;font-size:12px;color:#a3a39b}
.rgrid b{display:block;font-size:22px;line-height:1.25;color:#fff;font-variant-numeric:tabular-nums}.rgrid .rgas{background:#e4f222;color:#111}.rgrid .rgas span,.rgrid .rgas i{color:#3a3d00}.rgrid .rgas b{color:#111}
.rgrid i{font-style:normal;font-size:12px;color:#a3a39b}.ramp .rmuted{font-size:12.5px;color:#a3a39b;margin-top:6px}.ramp .sk{background:#2a2a2a}
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
</style></head><body>
<header>
 <svg class="hwave" viewBox="0 0 1200 24" preserveAspectRatio="none" aria-hidden="true"><path d="M0 14 Q 75 0 150 14 T 300 14 T 450 14 T 600 14 T 750 14 T 900 14 T 1050 14 T 1200 14 T 1350 14 T 1500 14 T 1650 14 T 1800 14 T 1950 14 T 2100 14 T 2250 14 T 2400 14 V24 H0Z"/></svg>
 <div id="floaty" aria-hidden="true"></div>
 <svg class="hwave front" viewBox="0 0 1200 24" preserveAspectRatio="none" aria-hidden="true"><path d="M0 14 Q 75 0 150 14 T 300 14 T 450 14 T 600 14 T 750 14 T 900 14 T 1050 14 T 1200 14 T 1350 14 T 1500 14 T 1650 14 T 1800 14 T 1950 14 T 2100 14 T 2250 14 T 2400 14 V24 H0Z"/></svg>
 <div class="brand"><div class="logo"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M3 9c1.5 1.3 3 1.3 4.5 0s3-1.3 4.5 0 3 1.3 4.5 0 3-1.3 4.5 0"/><path d="M3 15c1.5 1.3 3 1.3 4.5 0s3-1.3 4.5 0 3 1.3 4.5 0 3-1.3 4.5 0" opacity=".6"/></svg></div><div>Millennial Pools<small>Fleet</small></div></div>
 <div class="live" id="live"><span class="dot"></span><span id="upd">Connecting to Azuga...</span></div>
 <nav class="tabs"><button data-v="vMap" class="on">Live map</button><button data-v="vEdit">Edit vehicles</button><button data-v="vDrv">Drivers</button></nav>
</header>
<div class="bar"><div class="search"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input id="q" placeholder="Search trucks or drivers" aria-label="Search trucks or drivers"></div><nav class="sum" id="sum" aria-label="Filter vehicles"></nav>
 <div class="vopt"><button id="voBtn" aria-expanded="false" aria-controls="voPop"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4"/></svg>View<span id="voHid"></span></button>
  <div id="voPop" class="vopop" hidden>
   <b>Show on the map</b>
   <label><input type="checkbox" data-o="hideNoDriver"> Hide trucks with no driver in Airtable</label>
   <label><input type="checkbox" data-o="hideUnlinked"> Hide trackers not in Airtable</label>
   <label><input type="checkbox" data-o="hideNoLoc"> Hide trucks with no location</label>
   <b>Sort the list</b>
   <select id="voSort"><option value="moving">Moving first</option><option value="number">Truck number</option><option value="driver">Driver name</option><option value="recent">Most recently active</option></select>
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
<div id="right"><div id="donut" class="pane"></div><div id="map"></div><div id="cams" class="pane"><div class="ph"><h3>Camera events</h3><span id="camN">last 7 days</span></div><div id="vids"></div></div><div id="detail"></div></div></main></div>
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
function bigMap(on){$('right').classList.toggle('big',on);const b=document.querySelector('.bigbtn');if(b){b.textContent=on?'Smaller map':'Bigger map';b.setAttribute('aria-pressed',on)}setTimeout(()=>{map.invalidateSize();const m=sel&&markers[sel];if(m)map.panTo(m.getLatLng(),{animate:false})},0)}
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
    render();
  }catch(e){showErr(e);$('upd').textContent='Reconnecting...';$('live').classList.add('down')}
}
function all(){
  const byId={};vehicles.forEach(v=>byId[vid(v)]=v);
  return locs.length?locs.map(l=>({...byId[vid(l)],...l})):vehicles;
}
let filt='all';
// View options (kept per browser). Trucks with no driver are hidden unless you ask for them.
const OPT_DEF={hideNoDriver:true,hideUnlinked:false,hideNoLoc:false,sort:'moving'};
let OPTS={...OPT_DEF};try{Object.assign(OPTS,JSON.parse(localStorage.getItem('fleetView')||'{}'))}catch(e){}
const saveOpts=()=>{try{localStorage.setItem('fleetView',JSON.stringify(OPTS))}catch(e){}};
const hasDriver=r=>/[a-z]/i.test(who(r)),hasLoc=r=>+pick(r,'latitude','lat')&&+pick(r,'longitude','lng','lon');
const hiddenBy=r=>(OPTS.hideNoDriver&&!hasDriver(r))||(OPTS.hideUnlinked&&!(link(vid(r))||{}).linked)||(OPTS.hideNoLoc&&!hasLoc(r));
const visible=()=>all().filter(r=>!hiddenBy(r));
const tnum=r=>{const L=link(vid(r)),n=L&&L.linked&&parseInt(L.truck.truckNo);return isNaN(n)||!n?1e9:n};
const SORTS={moving:(a,b)=>moving(b)-moving(a)||title(a).localeCompare(title(b)),number:(a,b)=>tnum(a)-tnum(b)||title(a).localeCompare(title(b)),
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
  $('list').innerHTML=rs.length?rs.map((r,i)=>{const d=who(r),named=/[a-z]/i.test(d);return '<div class="card'+(sel==vid(r)?' sel':'')+(fresh?' rise':'')+'" style="--i:'+Math.min(i,14)+'" data-id="'+esc(vid(r))+'" tabindex="0" role="button">'+avatar(d)+'<div class="ci"><div class="top"><b>'+tno(vid(r))+esc(shortTitle(r))+'</b>'+status(r)+'</div>'+azSub(r)+'<div class="d">'+(named?esc(d):'<span class="muted">No driver assigned</span>')+'</div><div class="a">'+esc(pick(r,'address','landmark')||'Location unavailable')+'</div></div></div>'}).join(''):'<div class="empty">'+emptyMsg+'</div>';
  document.querySelectorAll('.card').forEach(c=>c.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();select(c.dataset.id)}});
  document.querySelectorAll('.card').forEach(c=>c.onclick=()=>select(c.dataset.id));
  const pts=[],shown=new Set(rs.map(vid));
  Object.entries(markers).forEach(([id,m])=>{if(!shown.has(id)){cluster.removeLayer(m);officeGroup.removeLayer(m)}});let nOffice=0;
  rs.forEach(r=>{const lat=+pick(r,'latitude','lat'),lng=+pick(r,'longitude','lng','lon');if(!lat||!lng)return;pts.push([lat,lng]);
    const id=vid(r),isSel=sel==id,mv=moving(r),L2=link(id),num=L2&&L2.linked&&L2.truck.truckNo?L2.truck.truckNo.split(/[ ~(]/)[0]:'';
    const label=num||(/[a-z]/i.test(who(r))?initials(who(r)):'')||ICON.truck;
    const html='<span class="pin'+(mv?' mv':'')+(isSel?' sel':'')+'">'+(num||!/</.test(label)?esc(label):label)+'</span>';
    const isNew=!markers[id],m=markers[id]||(markers[id]=L.marker([lat,lng],{icon:L.divIcon({className:'tm drop',html,iconSize:[0,0]}),keyboard:false}).on('click',()=>select(id)));m._mv=mv;const home=atOffice(lat,lng)?officeGroup:cluster,away=home===cluster?officeGroup:cluster;if(home===officeGroup)nOffice++;if(away.hasLayer(m))away.removeLayer(m);if(!home.hasLayer(m))home.addLayer(m);
    if(m._html!==html){m.setIcon(L.divIcon({className:'tm',html,iconSize:[0,0]}));m._html=html}
    m.setLatLng([lat,lng]).setZIndexOffset(isSel?1000:mv?500:0).bindTooltip(esc(title(r))+(/[a-z]/i.test(who(r))?' · '+esc(who(r)):'')+(mv?' · '+Math.round(speed(r))+' mph':''),{direction:'top',offset:[0,-14]});
  });
  cluster.refreshClusters();officeGroup.refreshClusters();
  if(nOffice<2&&!map.hasLayer(officePin))officePin.addTo(map);else if(nOffice>=2&&map.hasLayer(officePin))map.removeLayer(officePin);   // landmark when the yard is (nearly) empty
  lastPts=pts;if(!fitted&&pts.length){fitAll();fitted=true}
}
async function select(id){
  sel=id;$('right').classList.add('open');setTimeout(()=>map.invalidateSize(),0);render();const r=all().find(x=>vid(x)==id)||{};
  const mk=markers[id];if(mk)map.setView(mk.getLatLng(),Math.max(map.getZoom(),15),{animate:false});  // one jump; the step-by-step cluster zoom felt slow
  const d=who(r),named=/[a-z]/i.test(d),mmy=[r.year,r.make,r.model].filter(Boolean).join(' ');
  $('detail').innerHTML='<div class="dh">'+avatar(d,1)+'<div><h2>'+tno(id)+esc(title(r))+'</h2>'+azSub(r)+'<p>'+(named?esc(d):'No driver assigned')+(mmy&&!title(r).includes(mmy)?' · '+esc(mmy):'')+'</p></div><div style="margin-left:auto;display:flex;align-items:center">'+status(r)+'<button class="dclose" id="dclose" aria-label="Close details">×</button></div></div>'
   +'<div class="grid"><div class="kv"><span>Odometer</span><b>'+esc(odo(r))+'</b></div><div class="kv"><span>Speed</span><b>'+(moving(r)?Math.round(speed(r)):0)+' mph</b></div><div class="kv"><span>Group</span><b>'+esc(pick(r,'groupName')||'–')+'</b></div><div class="kv"><span>Plate</span><b>'+esc(pick(r,'licensePlate','licensePlateNo','plateNumber')||'–')+'</b></div></div>'
   +'<div class="addr">'+ICON.pin+esc(pick(r,'address','landmark')||'Location unavailable')+'</div>'
   +'<div id="rampBox" class="ramp"></div>'
   +atBox(id)
   +'<h3>Maintenance</h3><div id="m"><div class="sk" style="width:55%"></div></div>'
   +'<details><summary>All Azuga data for this vehicle</summary><pre>'+esc(JSON.stringify(r,null,2))+'</pre></details>';
  rampBox(id,named?d:'');
  try{if(!maint)maint=list(await get('/api/maintenance'));if(sel!=id)return;
    const m=maint.filter(x=>vid(x)==id||vname(x)==vname(r));
    $('m').innerHTML=m.length?m.map(x=>{const s=String(pick(x,'status','reminderStatus')||'');return '<div class="ev"><span class="pill '+(/over/i.test(s)?'bad':/up/i.test(s)?'warn':'idle')+'">'+esc(s||'Scheduled')+'</span><b>'+esc(pick(x,'serviceType','serviceName')||'Service')+'</b><span class="t">'+esc(when(pick(x,'nextServiceDate','dueDate')))+(pick(x,'nextServiceOdometer')?' · at '+esc(pick(x,'nextServiceOdometer'))+' mi':'')+'</span></div>'}).join(''):'<span class="muted">'+(r.maintenanceEnabled===false?'Maintenance tracking is off for this truck in Azuga.':'Nothing due.')+'</span>';
  }catch(e){if(sel!=id)return;$('m').innerHTML='<span class="muted">'+esc(e.message)+'</span>';retry(id)}
  $('vids').innerHTML='<div class="sk" style="width:70%"></div><div class="sk" style="width:50%"></div>';$('donut').innerHTML='<div class="sk" style="width:60%"></div>';
  try{const v=(await fleetVids()).filter(x=>x.vehicleId==id);if(sel!=id)return;
    TRUCKV=v;camType='';drawCams();
  }catch(e){if(sel!=id)return;$('vids').innerHTML='<span class="muted">'+esc(e.message)+'</span>';$('donut').innerHTML='';retry(id)}
}
function closeDetail(){sel=null;$('right').classList.remove('open','big');const bb=document.querySelector('.bigbtn');if(bb){bb.textContent='Bigger map';bb.setAttribute('aria-pressed',false)}setTimeout(()=>map.invalidateSize(),0);render()}
document.addEventListener('click',e=>{if(e.target.id==='dclose')closeDetail()});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('media').open&&sel&&!$('vMap').hidden)closeDetail()});
// Camera events: Azuga gives video links when a clip has uploaded, otherwise still photos from both cameras
let VIDS=[];
// Azuga stamps each event with whoever it had assigned at the time, and that can't be changed afterwards.
// Show the truck's current driver (Airtable), plus Azuga's stamp when it differs.
function evDriver(x){const az=[x.firstName,x.lastName].filter(Boolean).join(' ').replace(/[ .]+$/,'')||pick(x,'driverName')||'';
  const r=all().find(v=>vid(v)==(x.vehicleId||sel)),cur=r?who(r):'',real=/[a-z]/i.test(cur)?cur:/[a-z]/i.test(az)?az:'';
  const n=s=>String(s||'').toLowerCase().replace(/[^a-z]/g,'');return {name:real,azuga:/[a-z]/i.test(az)&&n(az)!==n(real)?az:''}}
function evRow(x,i){const e=pick(x,'eventType','eventName'),md=evMedia(x),th=md.videos[0]&&md.videos[0].poster||md.snaps[0]&&md.snaps[0].url;
      const D=evDriver(x),drv=D.name;
      return '<button class="ev evb" data-i="'+i+'"'+'>'
        +(th?'<span class="evth"><img src="'+esc(th)+'" alt="" loading="lazy">'+(md.videos.length?'<i>'+ICON.play+'</i>':'')+'</span>':'<span class="evth none">'+(x.requested?'Waiting':'No media')+'</span>')
        +'<span class="evi">'+'<span class="pill '+evClass(e)+'">'+esc(evName(e))+'</span><span class="t">'+esc(when(pick(x,'eventTime','startTime')))+(drv?' · '+esc(drv):'')+'</span>'
        +'<span class="muted" style="font-size:12px">'+esc(pick(x,'address')||'')+'</span>'+(D.azuga?'<span class="muted" style="font-size:11px">Azuga recorded: '+esc(D.azuga)+'</span>':'')+'</span>'
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
  +'<circle cx="21" cy="48" r="8" fill="#111827" stroke="#0b2533" stroke-opacity=".5" stroke-width="1.3"/><circle cx="21" cy="48" r="3.8" fill="#d1d5db"/><circle cx="21" cy="48" r="1.4" fill="#6b7280"/><circle cx="64" cy="48" r="8" fill="#111827" stroke="#0b2533" stroke-opacity=".5" stroke-width="1.3"/><circle cx="64" cy="48" r="3.8" fill="#d1d5db"/><circle cx="64" cy="48" r="1.4" fill="#6b7280"/></svg>'}};
// The water is drawn every frame from two moving sine waves, so a floater can sit exactly on the surface
// at its spot and tilt with the slope. One floater at a time, from either side of the pool.
const WV={H:58,W:0,t:0,last:0,fl:null,next:performance.now()+2500,lastKey:''};
const backY=(x,t)=>WV.H*0.46+5.5*Math.sin(x/42-t*0.9)+2.6*Math.sin(x/17.5+t*1.35);
const frontY=(x,t)=>WV.H*0.6+3.6*Math.sin(x/33+t*1.1)+1.8*Math.sin(x/14-t*1.7);
function wavePath(fn,t){let d='M0 '+WV.H;for(let x=0;x<=WV.W+12;x+=12)d+=' L'+x+' '+fn(x,t).toFixed(1);return d+' L'+(WV.W+12)+' '+WV.H+' Z'}
function sizeWaves(){const h=document.querySelector('header');WV.W=h?h.clientWidth:1200;document.querySelectorAll('.hwave').forEach(s=>s.setAttribute('viewBox','0 0 '+WV.W+' '+WV.H))}
function spawnFloat(now){const box=$('floaty');if(!box)return;const keys=Object.keys(FLOATS).filter(k=>k!==WV.lastKey),k=keys[Math.floor(Math.random()*keys.length)];WV.lastKey=k;
  const dir=Math.random()<.5?1:-1,el=document.createElement('div');el.className='fl'+(dir<0?' flip':'');el.style.height=FLOATS[k].h+'px';el.innerHTML='<div class="bob">'+FLOATS[k].svg+'</div>';box.appendChild(el);
  const w=el.offsetWidth||80;WV.fl={el,dir,w,h:FLOATS[k].h,x:dir>0?-w-10:WV.W+10,speed:WV.W/(24+Math.random()*12),roll:Math.random()*6,sink:FLOATS[k].h*0.3}}
function waveTick(now){const dt=Math.min(.05,(now-(WV.last||now))/1000);WV.last=now;WV.t+=dt;
  const ps=document.querySelectorAll('.hwave path');if(ps[0])ps[0].setAttribute('d',wavePath(backY,WV.t));if(ps[1])ps[1].setAttribute('d',wavePath(frontY,WV.t));
  const f=WV.fl;
  if(f){f.x+=f.dir*f.speed*dt;const cx=f.x+f.w/2,y=backY(cx,WV.t),slope=(backY(cx+6,WV.t)-backY(cx-6,WV.t))/12,ang=Math.atan(slope)*57.3*0.85+Math.sin(WV.t*1.6+f.roll)*2.5;
    f.el.style.transform='translate('+f.x.toFixed(1)+'px,'+(y-f.h+f.sink).toFixed(1)+'px) rotate('+ang.toFixed(2)+'deg)';
    if(f.x<-f.w-40||f.x>WV.W+40){f.el.remove();WV.fl=null;WV.next=now+5000+Math.random()*15000}}
  else if(now>WV.next&&!document.hidden)spawnFloat(now);
  requestAnimationFrame(waveTick)}
sizeWaves();addEventListener('resize',sizeWaves);
if(matchMedia('(prefers-reduced-motion: reduce)').matches){const ps=document.querySelectorAll('.hwave path');if(ps[0])ps[0].setAttribute('d',wavePath(backY,0));if(ps[1])ps[1].setAttribute('d',wavePath(frontY,0))}
else requestAnimationFrame(waveTick);
// ---- Self-cleaning page: notices fade, messages clear, data refreshes, idle page reloads ----
// Driver's Ramp spend (cards + reimbursements), last 30 days: gas vs everything else
async function rampBox(id,name){const el=$('rampBox');if(!el)return;if(!name){el.hidden=true;return}
  const head='<h4><span class="rtag">Ramp</span>'+esc(name)+' · last 30 days</h4>',usd=n=>n.toLocaleString('en-US',{style:'currency',currency:'USD'});
  el.innerHTML=head+'<div class="sk" style="width:60%"></div>';let r;
  try{r=await get('/api/ramp?name='+encodeURIComponent(name))}catch(e){if(sel==id)el.innerHTML=head+'<div class="rmuted">Ramp is not answering right now: '+esc(e.message)+'</div>';return}
  if(sel!=id)return;
  if(!r.connected){el.innerHTML=head+'<div class="rmuted">Ramp is not connected yet.</div>';return}
  const p=r.person;if(!p){el.innerHTML=head+'<div class="rmuted">No Ramp spend found under this name.</div>';return}
  el.innerHTML=head+'<div class="rgrid"><div class="rgas"><span>Gas</span><b>'+usd(p.gas)+'</b><i>'+p.gasN+(p.gasN===1?' fill-up':' fill-ups')+'</i></div><div><span>Everything else</span><b>'+usd(p.other)+'</b><i>'+p.otherN+(p.otherN===1?' purchase':' purchases')+'</i></div></div>'
   +(p.name.toLowerCase()!==name.toLowerCase()?'<div class="rmuted">Shown as '+esc(p.name)+' in Ramp</div>':'')}
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
    +'<div class="rn"><b class="nm">'+esc(d.name)+(inactive(d)?'<span class="tag">Inactive</span>':'')+'</b><span>'+(!d.license&&!inactive(d)?'<em class="nolic">No license #</em>'+(d.policy?' · ':''):'')+esc([d.license&&((d.state?d.state+' ':'')+d.license),!inactive(d)&&d.policy].filter(Boolean).join(' · '))+(d.notes?' · '+esc(d.notes):'')+'</span></div>'
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
document.querySelectorAll('.tabs button').forEach(b=>b.onclick=()=>{
  document.querySelectorAll('.tabs button').forEach(x=>x.classList.toggle('on',x===b));
  ['vMap','vEdit','vDrv'].forEach(v=>$(v).hidden=b.dataset.v!==v);document.body.dataset.v=b.dataset.v;$('sum').hidden=b.dataset.v!=='vMap';
  if(b.dataset.v!=='vMap')loadSync();if(b.dataset.v==='vEdit')renderEdit();else if(b.dataset.v==='vDrv'){if(!PEOPLE)loadPeople();else renderDrivers()}else map.invalidateSize();
});
$('q').oninput=()=>{render();if(!$('vEdit').hidden)renderEdit();if(!$('vDrv').hidden)renderDrivers();};
window.addEventListener('beforeunload',e=>{if(dirtyCount())e.preventDefault()});
refresh();setInterval(refresh,30000);
</script></body></html>`;
