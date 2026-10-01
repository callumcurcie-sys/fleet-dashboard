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
  if (!r.ok) throw new Error(`${path} -> ${r.status}: ${text.slice(0, 300)}`);
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
  '/api/drivers': () => drivers(),
  '/api/airtable': () => atLinks(),
  '/api/people': () => people(),
  '/api/maintenance': () => cached('maintenance', 600, () => azuga('/maintanance/reports/scheduledreport.json?' + new URLSearchParams({
    startTime: fmt(daysAgo(365)), endTime: fmt(daysAgo(-365)), isCount: 'false',
  }))),
  '/api/videos': q => {
    const id = q.get('vehicleId') || '';
    return cached('videos:' + id, 120, () => azuga('/eventVideos.json?videoType=eventVideo', {
      startTime: fmt(daysAgo(7)), endTime: fmt(new Date()), page: 1, limit: 25, vehiclesIds: id,
    }));
  },
};

// Same "first array we find" helper the page uses, for Azuga's varying response wrappers
const list = x => Array.isArray(x) ? x : x && typeof x === 'object' ? (Object.values(x).map(list).find(a => a.length) || []) : [];

// Edit tab -> Azuga. Azuga's update REPLACES the whole vehicle record, so we fetch the
// current record fresh, change only the edited fields, and send everything else back as-is.
const rawDrivers = () => cached('rawDrivers', 600, async () => list(await azuga('/users.json?limit=500&offset=0&userType=driver', {})));
const drivers = () => cached('drivers', 600, async () =>
  (await rawDrivers())
    .map(u => ({ id: u.id, name: [u.firstName, u.lastName].filter(Boolean).join(' ').replace(/[ .]+$/, '') }))
    .filter(u => u.id && /[a-z]/i.test(u.name))
    .sort((x, y) => x.name.localeCompare(y.name)));

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
  policy: 'fldVo5IrWedsKvumK', trucks: 'fld47HPqHRrw9GUL7', notes: 'fldSnexzpxIG22gF0' };
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
    policy: clean(r.fields[D.policy]?.name ?? r.fields[D.policy]), notes: clean(r.fields[D.notes]), truckIds: r.fields[D.trucks] || [], pic: att(r.fields[D.pic]) }));
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
    const ad = (await drivers()).find(d => normName(d.name) === normName(t.driver.name));
    if (!ad) notes.push('Driver ' + t.driver.name + ' is not set up in Azuga yet.');
    else if (ad.id !== v.userId) changes.userId = ad.id;
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
  return { connected: true, links, notInAzuga: at.trucks.filter(t => !usedIds.has(t.id)).map(t => ({ truckNo: t.truckNo, vin: t.vin, desc: [t.year, t.make, t.model].join(' ') })) };
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
  const truckLabel = Object.fromEntries(at.trucks.map(t => [t.id, (t.truckNo ? '#' + t.truckNo + ' ' : '') + [t.year, t.make, t.model].filter(Boolean).join(' ')]));
  const inAz = new Set((az || []).map(d => normName(d.name)));
  return { connected: true, azugaOk: !!az, drivers: at.drivers.filter(d => d.name).sort((a, b) => a.name.localeCompare(b.name)).map(d => ({
    id: d.id, name: d.name, license: d.license, state: d.state, policy: d.policy, notes: d.notes, pic: d.pic,
    trucks: d.truckIds.map(id => truckLabel[id]).filter(Boolean), inAzuga: inAz.has(normName(d.name)) })) };
}

const EMAIL_OK = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
async function createAzugaDriver(name, email, phone) {
  const parts = clean(name).split(/\s+/);
  if (parts.length < 2) throw new Error('Azuga needs a first and last name.');
  email = clean(email).toLowerCase();
  if (!EMAIL_OK.test(email)) throw new Error('Azuga needs a valid email address for the driver (it is their login).');
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
    firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1], userName: email, email,
    timeZone: tpl.timeZone || 'America/New_York', groupIds: [groupId], userTypeName: 'driver', emailVerification: false,
    // Random password, never shown; reset it in Azuga if the driver needs the Azuga app.
    password: 'Mp!' + require('crypto').randomBytes(12).toString('base64url') + '7a',
  };
  if (tpl.roleId) body.roleId = tpl.roleId; else body.roleName = tpl.roleName || 'Driver';
  if (digits) body.primaryContactNumber = '+1-' + digits.slice(-10);
  const r = await azuga('/user/create.json', body);
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
  if (b.addToAzuga) {  // check Azuga's requirements up front so we don't half-create
    if (name.split(' ').length < 2) throw new Error('Azuga needs a first and last name.');
    if (!EMAIL_OK.test(clean(b.email))) throw new Error('Azuga needs a valid email address for the driver (it is their login).');
  }
  const rec = await airtable(AT_DRIVERS, { method: 'POST', body: JSON.stringify({ fields, typecast: true }) });
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

async function readJson(req) {
  let s = '';
  for await (const c of req) { s += c; if (s.length > 10000) throw new Error('Request too large.'); }
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
http.createServer(async (req, res) => {
  // Browser's built-in login box. Any username works; password must match.
  const given = Buffer.from((req.headers.authorization || '').split(' ')[1] || '', 'base64').toString().split(':').slice(1).join(':');
  if (!DASHBOARD_PASSWORD || given !== DASHBOARD_PASSWORD) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Fleet Dashboard"' });
    return res.end(DASHBOARD_PASSWORD ? 'Login required' : 'Set DASHBOARD_PASSWORD to use this dashboard');
  }
  const url = new URL(req.url, 'http://x');
  const POSTS = { '/api/update': saveTruck, '/api/sync': b => syncOne(String(b.trackeeId || '')), '/api/driver/create': createDriver, '/api/driver/azuga': addDriverToAzuga };
  if (POSTS[url.pathname]) {
    // JSON-only + POST-only, so another website can't trigger a change with a plain form
    if (req.method !== 'POST' || !/application\/json/.test(req.headers['content-type'] || '')) { res.writeHead(405); return res.end(); }
    try {
      const b = await readJson(req);
      const out = await POSTS[url.pathname](b);
      res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(out));
    } catch (e) {
      console.error('Update failed:', e.message);
      res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: e.message }));
    }
  }
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
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
:root{--bg:#eef2f6;--card:#fff;--ink:#0f1b2d;--muted:#526077;--line:#e2e8f0;--navy:#0b2545;--accent:#0ea5b7;--go:#166534;--goBg:#dcfce7;--idle:#475569;--idleBg:#eef2f6;--warn:#92400e;--warnBg:#fef3c7;--bad:#b91c1c;--badBg:#fee2e2;--r:14px}
*{box-sizing:border-box}
body{margin:0;font-family:Inter,system-ui,sans-serif;background:var(--bg);color:var(--ink);font-size:14px}
header{background:var(--navy);color:#fff;padding:14px 24px;display:flex;align-items:center;gap:20px;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:17px}
.logo{width:34px;height:34px;border-radius:9px;background:var(--accent);display:grid;place-items:center;font-size:13px;font-weight:700}
.brand small{display:block;font-weight:500;font-size:12px;opacity:.7}
.search{flex:1;max-width:420px;position:relative}
.search input{width:100%;padding:10px 14px 10px 36px;border:0;border-radius:10px;font:inherit;background:rgba(255,255,255,.14);color:#fff;outline:none}
.search input::placeholder{color:rgba(255,255,255,.65)}.search input:focus{background:rgba(255,255,255,.22)}
.search svg{position:absolute;left:11px;top:50%;transform:translateY(-50%);opacity:.7}
.live{margin-left:auto;display:flex;align-items:center;gap:8px;font-size:13px;opacity:.9}
.dot{width:8px;height:8px;border-radius:50%;background:#4ade80;box-shadow:0 0 0 0 rgba(74,222,128,.7);animation:pulse 2s infinite}
@keyframes pulse{70%{box-shadow:0 0 0 8px rgba(74,222,128,0)}100%{box-shadow:0 0 0 0 rgba(74,222,128,0)}}
.tabs{display:flex;gap:4px;background:rgba(255,255,255,.1);padding:4px;border-radius:10px}
.tabs button{font:inherit;font-weight:600;font-size:13px;color:#fff;background:none;border:0;padding:7px 14px;border-radius:7px;cursor:pointer;opacity:.75}
.tabs button.on{background:#fff;color:var(--navy);opacity:1}
#vEdit,#vDrv{padding:16px 24px 24px}
#drvRows td{font-size:13px}#drvRows .sub{color:var(--muted);font-size:12px}
.azf{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}.azf input{font:inherit;font-size:13px;padding:6px 8px;border:1px solid var(--line);border-radius:7px;min-width:0;width:170px}
.ed{display:grid;grid-template-columns:320px 1fr;gap:16px;height:calc(100vh - 100px);min-height:520px}
.edl{display:flex;flex-direction:column;min-height:0}.edf{padding:12px 14px;border-bottom:1px solid var(--line);font-size:13px;color:var(--muted)}
#edList{overflow:auto;flex:1}
.eli{padding:10px 14px;border-bottom:1px solid var(--line);cursor:pointer;display:flex;justify-content:space-between;gap:8px;align-items:center}
.eli:hover{background:var(--bg)}.eli.sel{background:#e0f2f5}.eli.sel b{color:#0b4f5c}
.eli b{display:block;font-weight:600}.eli small{color:var(--muted)}
.edc{padding:22px 26px;overflow:auto}
.edh{display:flex;align-items:center;gap:12px;margin-bottom:6px}.edh h2{margin:0;font-size:20px}.edh .pos{margin-left:auto;color:var(--muted);font-size:13px}
.miss{color:var(--warn);font-size:13px;margin-bottom:12px}
fieldset{border:0;padding:0;margin:18px 0 0}legend{font-size:13px;font-weight:600;color:var(--ink);margin-bottom:8px}
.fg{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px}
.fg label{display:flex;flex-direction:column;gap:4px;font-size:12px;font-weight:600;color:var(--muted)}
.fg input,.fg select{font:inherit;font-size:14px;font-weight:400;color:var(--ink);padding:9px 11px;border:1px solid var(--line);border-radius:9px;background:#fff}
.fg input:focus,.fg select:focus{outline:2px solid var(--accent);border-color:transparent}
.fg .dirty{background:#fffbeb;border-color:#f59e0b}.fg .hint{font-weight:400}
.edb{display:flex;gap:8px;align-items:center;margin-top:24px;padding-top:16px;border-top:1px solid var(--line);flex-wrap:wrap}
.btn2{font:inherit;font-weight:600;font-size:13px;border:1px solid var(--line);background:#fff;color:var(--ink);padding:9px 14px;border-radius:9px;cursor:pointer}
.btn2.pri{background:var(--navy);color:#fff;border-color:var(--navy)}.btn2:disabled{opacity:.45;cursor:default}
#edMsg{font-size:13px;margin-left:8px}
.at{background:#f0f9fb;border:1px solid #cdeaf0;border-radius:12px;padding:12px 14px;margin-top:14px;font-size:13px}
.at.off{background:var(--bg);border-color:var(--line);color:var(--muted)}
.at h4{margin:0 0 8px;font-size:13px;font-weight:600;color:#0b4f5c}
.at .kvs{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px 14px}.at .kvs span{display:block;color:var(--muted);font-size:11px}
.docs{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}
.fromAt{align-self:flex-start;display:inline-block;font-size:10px;font-weight:700;color:#0e7490;background:#e0f2f5;border-radius:4px;padding:1px 5px;margin-left:6px}
.note{color:var(--warn);font-size:12px;margin-top:6px}
.fg label.chk{flex-direction:row;align-items:center;gap:8px;padding-top:22px}#edMsg.ok{color:var(--go)}#edMsg.bad{color:var(--bad)}
@media(max-width:900px){#vEdit,#vDrv{padding:12px 16px}#drvRows td:nth-child(3){display:none}.ed{grid-template-columns:1fr;height:auto}#edList{max-height:35vh}}
.panel{background:var(--card);border-radius:var(--r);box-shadow:0 1px 2px rgba(15,27,45,.06);overflow:auto}
.panel .intro{padding:16px 20px;border-bottom:1px solid var(--line);color:var(--muted)}.panel .intro b{color:var(--ink)}
table{width:100%;border-collapse:collapse}th{text-align:left;font-size:12px;font-weight:600;color:var(--muted);padding:10px 12px;border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:8px 12px;border-bottom:1px solid var(--line);vertical-align:top}
td input{font:inherit;width:100%;min-width:110px;padding:7px 9px;border:1px solid var(--line);border-radius:8px;background:#fff}
td input:focus{outline:2px solid var(--accent);border-color:transparent}td input.dirty{background:#fffbeb;border-color:#f59e0b}
.save{font:inherit;font-weight:600;font-size:13px;color:#fff;background:var(--navy);border:0;padding:8px 14px;border-radius:8px;cursor:pointer}.save:disabled{opacity:.5;cursor:default}
.msg{font-size:12px;margin-top:4px;max-width:220px}.msg.ok{color:var(--go)}.msg.bad{color:var(--bad)}
::selection{background:#bfe9f0;color:var(--ink)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
*{scrollbar-width:thin;scrollbar-color:#c5d0dc transparent}
.kv b,.pill,.t,td,.eli small{font-variant-numeric:tabular-nums}
.btn2:hover:not(:disabled){border-color:#c5d0dc;background:#f8fafc}.btn2.pri:hover:not(:disabled){background:#123a6b}
.btn{display:inline-flex;align-items:center;gap:6px}.ic{width:14px;height:14px;flex:none}
.sk{background:linear-gradient(90deg,#eef2f6 25%,#e3e9f0 37%,#eef2f6 63%);background-size:400% 100%;animation:sk 1.4s ease infinite;border-radius:6px;height:12px;margin:6px 0}
@keyframes sk{0%{background-position:100% 50%}100%{background-position:0 50%}}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
#err{background:var(--badBg);color:var(--bad);padding:10px 24px;display:none;font-size:13px}
.sum{display:flex;gap:8px;flex-wrap:wrap;padding:14px 24px 0}
.sum button{font:inherit;font-size:13px;display:inline-flex;align-items:center;gap:8px;background:var(--card);border:1px solid var(--line);color:var(--ink);padding:7px 12px;border-radius:999px;cursor:pointer;transition:background .15s,border-color .15s}
.sum button:hover{border-color:#c5d0dc}.sum button[aria-pressed=true]{background:var(--navy);border-color:var(--navy);color:#fff}
.sum b{font-weight:700;font-variant-numeric:tabular-nums}.sum .dot{width:8px;height:8px;border-radius:50%;animation:none;box-shadow:none}
main{display:grid;grid-template-columns:360px 1fr;gap:16px;padding:14px 24px 24px;height:calc(100vh - 130px);min-height:560px}
#list{overflow:auto;display:flex;flex-direction:column;gap:8px;padding-right:4px}
.card{background:var(--card);border-radius:var(--r);padding:12px 14px;cursor:pointer;border:2px solid transparent;display:flex;gap:12px;box-shadow:0 1px 2px rgba(15,27,45,.06);transition:border-color .15s,transform .15s}
.card:hover{border-color:var(--line)}.card.sel{border-color:var(--accent)}
.av{flex:none;width:38px;height:38px;border-radius:50%;background:#e0f2f5;color:#0e7490;display:grid;place-items:center;font-weight:600;font-size:13px}
.av.none{background:var(--idleBg);color:var(--idle)}
.ci{min-width:0;flex:1}.ci .top{display:flex;justify-content:space-between;gap:8px;align-items:center}
.ci b{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ci .d{color:var(--ink);font-size:13px;margin-top:2px}.ci .a{color:var(--muted);font-size:12px;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pill{flex:none;font-size:11px;font-weight:600;padding:3px 8px;border-radius:999px}
.pill.go{background:var(--goBg);color:var(--go)}.pill.idle{background:var(--idleBg);color:var(--idle)}
.pill.warn{background:var(--warnBg);color:var(--warn)}.pill.bad{background:var(--badBg);color:var(--bad)}
#right{display:grid;grid-template-rows:minmax(260px,52%) 1fr;gap:16px;min-height:0}
#map{border-radius:var(--r);box-shadow:0 1px 2px rgba(15,27,45,.06)}
#detail{background:var(--card);border-radius:var(--r);padding:18px 20px;overflow:auto;box-shadow:0 1px 2px rgba(15,27,45,.06)}
.empty{color:var(--muted);display:grid;place-items:center;height:100%;text-align:center}
.dh{display:flex;align-items:center;gap:14px;margin-bottom:14px}.dh h2{margin:0;font-size:18px}.dh p{margin:2px 0 0;color:var(--muted)}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:18px}
.kv{background:var(--bg);border-radius:10px;padding:10px 12px}.kv span{display:block;color:var(--muted);font-size:12px;font-weight:500}.kv b{font-weight:600;font-size:14px}
h3{font-size:14px;font-weight:600;color:var(--ink);margin:22px 0 8px}
.ev{display:flex;align-items:center;gap:12px;padding:10px 0;border-top:1px solid var(--line);flex-wrap:wrap}
.ev .t{color:var(--muted);font-size:12px;min-width:150px}.ev .clips{margin-left:auto;display:flex;gap:6px}
.btn{font:inherit;font-size:12px;font-weight:600;color:var(--navy);background:#e0f2f5;padding:5px 10px;border-radius:8px;text-decoration:none}.btn:hover{background:#c7eaf0}
.muted{color:var(--muted)}
details{margin-top:18px}summary{cursor:pointer;color:var(--muted);font-size:12px}details pre{font-size:11px;background:var(--bg);padding:10px;border-radius:8px;overflow:auto;max-height:260px}
@media(max-width:900px){.sum{padding:12px 16px 0}main{grid-template-columns:1fr;height:auto;padding:12px 16px}#list{max-height:45vh}#right{grid-template-rows:340px auto}.grid{grid-template-columns:repeat(2,1fr)}header{padding:12px 16px}.live{margin-left:auto}.search{flex-basis:100%;max-width:none;order:3}}
</style></head><body>
<header>
 <div class="brand"><div class="logo">MP</div><div>Fleet Dashboard<small>Millennial Pools</small></div></div>
 <div class="search"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input id="q" placeholder="Search vehicle or driver"></div>
 <div class="live"><span class="dot"></span><span id="upd">Connecting...</span></div>
<nav class="tabs"><button data-v="vMap" class="on">Live map</button><button data-v="vEdit">Edit vehicles</button><button data-v="vDrv">Drivers</button></nav>
</header>
<div id="err"></div>
<div id="vMap"><nav class="sum" id="sum" aria-label="Filter vehicles"></nav>
<main><div id="list"><div class="card"><div class="av none"></div><div class="ci"><div class="sk" style="width:60%"></div><div class="sk" style="width:40%"></div><div class="sk" style="width:80%"></div></div></div><div class="card"><div class="av none"></div><div class="ci"><div class="sk" style="width:60%"></div><div class="sk" style="width:40%"></div><div class="sk" style="width:80%"></div></div></div><div class="card"><div class="av none"></div><div class="ci"><div class="sk" style="width:60%"></div><div class="sk" style="width:40%"></div><div class="sk" style="width:80%"></div></div></div><div class="card"><div class="av none"></div><div class="ci"><div class="sk" style="width:60%"></div><div class="sk" style="width:40%"></div><div class="sk" style="width:80%"></div></div></div></div>
<div id="right"><div id="map"></div><div id="detail"><div class="empty">Select a vehicle to see its driver, maintenance and camera footage.</div></div></div></main></div>
<div id="vDrv" hidden><div class="panel">
 <div class="intro" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap"><div><b>Drivers</b> <span id="drvCount"></span><br>From your Airtable Drivers table. New drivers are saved to Airtable first, then added to Azuga.</div><span style="flex:1"></span><button class="btn2 pri" id="newDrvBtn">+ New driver</button></div>
 <form id="newDrv" hidden autocomplete="off" style="padding:16px 20px;border-bottom:1px solid var(--line);background:#fafcfd">
  <div class="fg">
   <label>Full name *<input name="name" maxlength="80" required></label>
   <label>License number<input name="license" maxlength="40"></label>
   <label>License state<input name="state" maxlength="20" placeholder="NJ"></label>
   <label>Insurance policy<input name="policy" maxlength="60" list="policyList"></label>
   <label>Date of birth<input name="dob" type="date"><span class="hint">Saved to Airtable only, never shown here</span></label>
   <label>Notes<input name="notes" maxlength="500"></label>
  </div>
  <fieldset><legend><label style="display:inline-flex;gap:6px;align-items:center;font-size:12px"><input type="checkbox" name="addToAzuga" checked> Also add to Azuga</label></legend>
   <div class="fg" id="azFields"><label>Email * (their Azuga login)<input name="email" type="email" maxlength="120"></label><label>Phone<input name="phone" type="tel" maxlength="20" placeholder="732-555-0100"></label></div></fieldset>
  <div class="edb"><span id="ndMsg" style="font-size:13px"></span><span style="flex:1"></span><button type="button" class="btn2" id="ndCancel">Cancel</button><button class="btn2 pri" id="ndSave">Save driver</button></div>
 </form>
 <datalist id="policyList"></datalist>
 <table><thead><tr><th>Driver</th><th>License</th><th>Insurance policy</th><th>Truck</th><th>Azuga</th></tr></thead><tbody id="drvRows"><tr><td colspan="5" class="muted">Loading...</td></tr></tbody></table>
</div></div>
<div id="vEdit" hidden><div class="ed">
 <aside class="panel edl"><div class="edf"><label><input type="checkbox" id="needs"> Only show trucks that need attention</label><div id="syncBar" style="margin-top:10px"></div></div><div id="edList"></div></aside>
 <section class="panel edc" id="edCard"><div class="empty">Pick a truck on the left to edit it.</div></section>
</div></div>
<script>
const $=id=>document.getElementById(id);
const svg=d=>'<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+d+'</svg>';
const ICON={pin:svg('<path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>'),
 file:svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>'),
 play:svg('<path d="M8 5v14l11-7z"/>'),check:svg('<path d="M5 12.5l4.5 4.5L19 7"/>')};
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>'&#'+c.charCodeAt(0)+';');
// Azuga wraps lists differently per endpoint; grab the first array we find
const list=x=>Array.isArray(x)?x:x&&typeof x==='object'?(Object.values(x).map(list).find(a=>a.length)||[]):[];
const pick=(o,...k)=>{for(const key of k)if(o&&o[key]!=null&&o[key]!=='')return o[key]};
const vid=v=>pick(v,'trackeeId','vehicleId','id');
const vname=v=>pick(v,'trackeeName','vehicleName','name')||'Vehicle';
// Unnamed drivers come through as a phone number like "9052487042 ."
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
const status=r=>moving(r)?'<span class="pill go">Moving · '+Math.round(speed(r))+' mph</span>':'<span class="pill idle">Parked</span>';
const evName=e=>String(e||'Event').replace(/^CAM_/,'').replace(/_MESSAGE$/,'').replace(/_/g,' ').toLowerCase().replace(/^./,c=>c.toUpperCase()).replace('Hard breaking','Hard braking');
const evClass=e=>/FATIGUE|DISTRACT|VIOLENT|COLLISION|PHONE|SMOK|SPEED/i.test(e)?'bad':'warn';
const links=o=>JSON.stringify(o).match(/https?:[^"\\\\]+/g)||[];
let vehicles=[],locs=[],maint=[],sel=null,markers={};
const map=L.map('map',{zoomControl:true}).setView([40.2,-74.8],8);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'&copy; OpenStreetMap',maxZoom:19}).addTo(map);
let fitted=false;

async function get(p){const r=await fetch(p);const j=await r.json();if(j.error)throw new Error(j.error);return j}
function showErr(e){$('err').style.display=e?'block':'none';$('err').textContent=e?'Problem talking to Azuga: '+e.message:''}

async function refresh(){
  try{
    const [v,l]=await Promise.all([vehicles.length?null:get('/api/vehicles'),get('/api/locations')]);
    if(v)vehicles=list(v);locs=list(l);showErr();
    $('upd').textContent='Live · updated '+new Date().toLocaleTimeString([], {hour:'numeric',minute:'2-digit'});
    render();
  }catch(e){showErr(e);$('upd').textContent='Connection problem'}
}
function all(){
  const byId={};vehicles.forEach(v=>byId[vid(v)]=v);
  return locs.length?locs.map(l=>({...byId[vid(l)],...l})):vehicles;
}
let filt='all';
const FILTERS={all:['All vehicles',()=>true,''],moving:['Moving',moving,'#16a34a'],parked:['Parked',r=>!moving(r),'#94a3b8'],nodriver:['No driver',r=>!/[a-z]/i.test(dname(r)),'#d97706']};
function rows(){
  const q=$('q').value.toLowerCase();
  return all().filter(r=>FILTERS[filt][1](r)&&(!q||(vname(r)+' '+dname(r)).toLowerCase().includes(q)))
    .sort((a,b)=>moving(b)-moving(a)||vname(a).localeCompare(vname(b)));
}
function render(){
  const a=all(),rs=rows();
  $('sum').innerHTML=Object.entries(FILTERS).map(([k,[label,fn,c]])=>'<button data-f="'+k+'" aria-pressed="'+(filt===k)+'">'+(c?'<span class="dot" style="background:'+c+'"></span>':'')+label+' <b>'+a.filter(fn).length+'</b></button>').join('');
  $('sum').querySelectorAll('button').forEach(b=>b.onclick=()=>{filt=b.dataset.f;render()});
  $('list').innerHTML=rs.length?rs.map(r=>{const d=dname(r),named=/[a-z]/i.test(d);return '<div class="card'+(sel==vid(r)?' sel':'')+'" data-id="'+esc(vid(r))+'"><div class="av'+(named?'':' none')+'">'+esc(initials(d))+'</div><div class="ci"><div class="top"><b>'+esc(vname(r))+'</b>'+status(r)+'</div><div class="d">'+(named?esc(d):'<span class="muted">No driver name'+(d?' · '+esc(d):'')+'</span>')+'</div><div class="a">'+esc(pick(r,'address','landmark')||'Location unavailable')+'</div></div></div>'}).join(''):'<div class="empty" style="padding:30px">'+(a.length?'No vehicles match. Clear the search or pick All vehicles above.':'No vehicles yet. Once Azuga reports your trucks, they appear here.')+'</div>';
  document.querySelectorAll('.card').forEach(c=>c.onclick=()=>select(c.dataset.id));
  const pts=[],shown=new Set(rs.map(vid));
  Object.entries(markers).forEach(([id,m])=>{if(!shown.has(id))map.removeLayer(m)});
  rs.forEach(r=>{const lat=+pick(r,'latitude','lat'),lng=+pick(r,'longitude','lng','lon');if(!lat||!lng)return;pts.push([lat,lng]);
    const id=vid(r),isSel=sel==id,c=moving(r)?'#16a34a':'#0b2545';
    const m=markers[id]||(markers[id]=L.circleMarker([lat,lng]).on('click',()=>select(id)));if(!map.hasLayer(m))m.addTo(map);
    m.setLatLng([lat,lng]).setStyle({radius:isSel?11:7,color:'#fff',weight:2,fillColor:isSel?'#0ea5b7':c,fillOpacity:1}).bindTooltip(esc(vname(r))+(dname(r)?' · '+esc(dname(r)):''));
    if(isSel)m.bringToFront();});
  if(!fitted&&pts.length){map.fitBounds(pts,{padding:[30,30]});fitted=true}
}
async function select(id){
  sel=id;render();const r=all().find(x=>vid(x)==id)||{};
  if(markers[id])map.setView(markers[id].getLatLng(),13);
  const d=dname(r),named=/[a-z]/i.test(d),mmy=[r.year,r.make,r.model].filter(Boolean).join(' ');
  $('detail').innerHTML='<div class="dh"><div class="av'+(named?'':' none')+'" style="width:46px;height:46px">'+esc(initials(d))+'</div><div><h2>'+esc(vname(r))+'</h2><p>'+(named?esc(d):'No driver name')+(mmy?' · '+esc(mmy):'')+'</p></div><div style="margin-left:auto">'+status(r)+'</div></div>'
   +'<div class="grid"><div class="kv"><span>Odometer</span><b>'+esc(odo(r))+'</b></div><div class="kv"><span>Speed</span><b>'+(moving(r)?Math.round(speed(r)):0)+' mph</b></div><div class="kv"><span>Group</span><b>'+esc(pick(r,'groupName')||'–')+'</b></div><div class="kv"><span>Plate</span><b>'+esc(pick(r,'licensePlate','licensePlateNo','plateNumber')||'–')+'</b></div></div>'
   +'<div class="muted" style="display:flex;gap:6px;align-items:center">'+ICON.pin+esc(pick(r,'address','landmark')||'Location unavailable')+'</div>'
   +atBox(id)
   +'<h3>Maintenance</h3><div id="m" class="muted">Loading...</div><h3>Camera events · last 7 days</h3><div id="vids" class="muted">Loading...</div>'
   +'<details><summary>All Azuga data for this vehicle</summary><pre>'+esc(JSON.stringify(r,null,2))+'</pre></details>';
  try{if(!maint.length)maint=list(await get('/api/maintenance'));
    const m=maint.filter(x=>vid(x)==id||vname(x)==vname(r));
    $('m').innerHTML=m.length?m.map(x=>{const s=String(pick(x,'status','reminderStatus')||'');return '<div class="ev"><span class="pill '+(/over/i.test(s)?'bad':/up/i.test(s)?'warn':'idle')+'">'+esc(s||'Scheduled')+'</span><b>'+esc(pick(x,'serviceType','serviceName')||'Service')+'</b><span class="t">'+esc(when(pick(x,'nextServiceDate','dueDate')))+(pick(x,'nextServiceOdometer')?' · at '+esc(pick(x,'nextServiceOdometer'))+' mi':'')+'</span></div>'}).join(''):(r.maintenanceEnabled===false?'Maintenance tracking is turned off for this vehicle in Azuga.':'No maintenance scheduled.');
  }catch(e){$('m').textContent=e.message;retry(id)}
  try{const v=list(await get('/api/videos?vehicleId='+encodeURIComponent(id)));
    $('vids').innerHTML=v.length?v.map(x=>{const e=pick(x,'eventType','eventName');const clips=links(x).filter(u=>!/thumb/i.test(u));return '<div class="ev"><span class="pill '+evClass(e)+'">'+esc(evName(e))+'</span><span class="t">'+esc(when(pick(x,'eventTime','startTime')))+'</span><span class="muted">'+esc(pick(x,'driverName')||'')+'</span><span class="clips">'+clips.map((u,i)=>'<a class="btn" target="_blank" rel="noopener" href="'+esc(u)+'">'+ICON.play+'Clip '+(i+1)+'</a>').join('')+'</span></div>'}).join(''):'No camera events in the last 7 days.';
  }catch(e){$('vids').textContent=e.message;retry(id)}
}
const retried=new Set();function retry(id){if(retried.has(id))return;retried.add(id);setTimeout(()=>{if(sel==id)select(id)},30000)}
// ---- Airtable (source of truth) ----
let AT=null;
async function loadAT(){try{AT=await get('/api/airtable')}catch(e){AT={connected:true,error:e.message,links:{}}}if(!$('vEdit').hidden)renderEdit()}
const link=id=>AT&&AT.links&&AT.links[id];
const docBtns=t=>{const d=[...t.insCard.map(f=>['Insurance card',f]),...t.files.map(f=>[f.name,f])];return d.length?'<div class="docs">'+d.map(([n,f])=>'<a class="btn" target="_blank" rel="noopener" href="'+esc(f.url)+'">'+ICON.file+esc(n)+'</a>').join('')+'</div>':'<div class="muted" style="margin-top:8px">No insurance card or files in Airtable yet.</div>'};
const drvLine=d=>d?esc(d.name)+(d.license?' · License '+esc(d.state?d.state+' ':'')+esc(d.license):''):'None';
function atBox(id){
  if(!AT)return '<div class="at off">Loading Airtable...</div>';
  if(!AT.connected)return '<div class="at off">Airtable is not connected yet.</div>';
  if(AT.error)return '<div class="at off">Airtable unavailable: '+esc(AT.error)+'</div>';
  const L=link(id);
  if(!L||!L.linked)return '<div class="at off">'+(L&&L.dupe?'Two Airtable trucks share this VIN. Fix the duplicate in Airtable to link it.':'Not linked to Airtable. This VIN is not in your Trucks table.')+'</div>';
  const t=L.truck;
  return '<div class="at"><h4>From Airtable'+(t.truckNo?' · Truck #'+esc(t.truckNo):'')+'</h4><div class="kvs">'
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
const edRows=()=>{const q=$('q').value.toLowerCase();return vehicles.filter(v=>(!q||(vname(v)+' '+dname(v)).toLowerCase().includes(q))&&(!$('needs').checked||missing(v).length||outOfSync(v))).sort((a,b)=>vname(a).localeCompare(vname(b)))};
const dirtyCount=()=>document.querySelectorAll('#edCard .dirty').length;
function renderEdit(){
  const rs=edRows();
  $('edList').innerHTML=rs.length?rs.map(v=>{const m=missing(v);return '<div class="eli'+(edSel==vid(v)?' sel':'')+'" data-id="'+esc(vid(v))+'"><div><b>'+esc(vname(v))+'</b><small>'+esc(/[a-z]/i.test(dname(v))?dname(v):'No driver')+(pick(v,'licensePlateNo','licensePlate')?' · '+esc(pick(v,'licensePlateNo','licensePlate')):'')+'</small></div>'+(outOfSync(v)?'<span class="pill warn">Sync</span>':m.length?'<span class="pill warn">Missing '+m.length+'</span>':'<span class="pill go" aria-label="Complete">'+ICON.check+'</span>')+'</div>'}).join(''):'<div class="empty" style="padding:30px">'+(vehicles.length?'No trucks match.':'Loading...')+'</div>';
  document.querySelectorAll('.eli').forEach(e=>e.onclick=()=>openEd(e.dataset.id));
  const n=vehicles.filter(outOfSync).length;
  if(!syncing)$('syncBar').innerHTML=!AT?'':!AT.connected?'<span class="muted">Airtable not connected</span>':AT.error?'<span class="muted">Airtable unavailable</span>':n?'<button class="btn2 pri" id="syncAll" style="width:100%">Sync '+n+' truck'+(n>1?'s':'')+' from Airtable → Azuga</button>':'<span style="color:var(--go)">✓ Azuga matches Airtable</span>';
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
    if(type==='driver'){const curId=v.userId||'',wantId=atWant(L,'userId'),selId=wantId||curId;const known=driverList.some(d=>d.id===curId);return '<label>'+label+'<select name="userId" data-orig="'+esc(curId)+'"'+(wantId?' class="dirty"':'')+'>'+(known?'':'<option value="'+esc(curId)+'" selected>'+esc(/[a-z]/i.test(dname(v))?dname(v):'No driver')+'</option>')+driverList.map(d=>'<option value="'+esc(d.id)+'"'+(d.id===selId?' selected':'')+'>'+esc(d.name)+'</option>').join('')+'</select>'+(wantId?'<span class="fromAt" style="align-self:flex-start">FROM AIRTABLE</span>':'')+(driverList.length?'':'<span class="hint">Could not load the driver list from Azuga.</span>')+'</label>'}
    return '<label>'+label+(fa?'<span class="fromAt">FROM AIRTABLE</span>':'')+'<input name="'+k+'" type="'+type+'" '+(opt?'maxlength="'+opt+'"':'')+' value="'+esc(cur??'')+'" data-orig="'+esc(orig??'')+'"'+(fa?' class="dirty"':'')+(k==='odometer'?' placeholder="Now: '+esc(odo(v))+'"':'')+'>'+(k==='odometer'?'<span class="hint">Leave blank to keep the current reading</span>':'')+'</label>'};
  $('edCard').innerHTML='<div class="edh"><h2>'+esc(vname(v))+'</h2><span class="pos">'+(i+1)+' of '+rs.length+'</span></div>'
   +(m.length?'<div class="miss">Missing: '+m.join(', ')+'</div>':'<div class="miss" style="color:var(--go)">All key info filled in</div>')
   +(lk?'<div class="at"><h4>Linked to Airtable'+(L.truck.truckNo?' truck #'+esc(L.truck.truckNo):'')+' · matched by '+esc(L.how)+'</h4>'
      +(Object.keys(L.changes).length?'Fields marked <span class="fromAt">FROM AIRTABLE</span> have newer info in Airtable. Click Save to update Azuga.':'Azuga matches Airtable.')
      +(L.notes||[]).map(n=>'<div class="note">'+esc(n)+'</div>').join('')+'<div style="margin-top:6px"><b>Driver in Airtable:</b> '+drvLine(L.truck.driver)+'</div>'+docBtns(L.truck)+'</div>'
     :atBox(id))
   +[...FIELDS,...(lk?[AT_FIELDS]:[])].map(([g,fs])=>'<fieldset><legend>'+g+'</legend><div class="fg">'+fs.map(input).join('')+'</div></fieldset>').join('')
   +'<div class="edb"><button class="btn2" id="edPrev"'+(i>0?'':' disabled')+'>← Previous</button><button class="btn2" id="edNext"'+(i<rs.length-1?'':' disabled')+'>Next →</button><span style="flex:1"></span><span id="edMsg"></span><button class="btn2" id="edSave">Save</button><button class="btn2 pri" id="edSaveNext">Save &amp; next →</button></div>';
  const val=el=>el.type==='checkbox'?String(el.checked):el.value;
  $('edCard').querySelectorAll('input,select').forEach(el=>el.oninput=el.onchange=()=>el.classList.toggle('dirty',val(el)!==el.dataset.orig));
  const go=d=>{const n=rs[i+d];if(n)openEd(vid(n))};
  $('edPrev').onclick=()=>go(-1);$('edNext').onclick=()=>go(1);
  $('edSave').onclick=()=>saveEd(v,0,go);$('edSaveNext').onclick=()=>saveEd(v,1,go);
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
function renderDrivers(){
  if(!PEOPLE)return;
  if(!PEOPLE.connected){$('drvRows').innerHTML='<tr><td colspan="5" class="muted">Airtable is not connected yet. Add AIRTABLE_TOKEN in Render.</td></tr>';$('newDrvBtn').disabled=true;return}
  if(PEOPLE.error){$('drvRows').innerHTML='<tr><td colspan="5" class="muted">Airtable unavailable: '+esc(PEOPLE.error)+'</td></tr>';return}
  const q=$('q').value.toLowerCase(),ds=PEOPLE.drivers.filter(d=>!q||(d.name+' '+d.trucks.join(' ')+' '+d.license).toLowerCase().includes(q));
  const missing=PEOPLE.drivers.filter(d=>!d.inAzuga).length;
  $('drvCount').innerHTML='<span class="muted">· '+PEOPLE.drivers.length+' total'+(PEOPLE.azugaOk&&missing?' · <span style="color:var(--warn)">'+missing+' not in Azuga</span>':'')+'</span>';
  $('policyList').innerHTML=[...new Set(PEOPLE.drivers.map(d=>d.policy).filter(Boolean))].map(p=>'<option value="'+esc(p)+'">').join('');
  $('drvRows').innerHTML=ds.length?ds.map(d=>'<tr data-id="'+esc(d.id)+'"><td><b>'+esc(d.name)+'</b>'+(d.notes?'<div class="sub">'+esc(d.notes)+'</div>':'')+'</td>'
    +'<td>'+(d.license?esc((d.state?d.state+' ':'')+d.license):'<span class="muted">–</span>')+(d.pic.length?'<div><a class="btn" target="_blank" rel="noopener" href="'+esc(d.pic[0].url)+'">'+ICON.file+'License photo</a></div>':'')+'</td>'
    +'<td>'+esc(d.policy||'–')+'</td><td>'+(d.trucks.length?d.trucks.map(esc).join('<br>'):'<span class="muted">None</span>')+'</td>'
    +'<td>'+(!PEOPLE.azugaOk?'<span class="muted">?</span>':d.inAzuga?'<span class="pill go">In Azuga</span>':'<span class="pill warn">Not in Azuga</span><div class="azf"><input placeholder="Email (Azuga login)" type="email" class="aze"><input placeholder="Phone" type="tel" class="azp"><button class="btn2 azgo">Add to Azuga</button></div><div class="msg"></div>')+'</td></tr>').join('')
    :'<tr><td colspan="5" class="muted">No drivers match.</td></tr>';
  document.querySelectorAll('.azgo').forEach(b=>b.onclick=async()=>{const tr=b.closest('tr'),m=tr.querySelector('.msg');b.disabled=true;m.className='msg';m.textContent='Adding to Azuga...';
    try{await post('/api/driver/azuga',{airtableId:tr.dataset.id,email:tr.querySelector('.aze').value,phone:tr.querySelector('.azp').value});driverList=null;await loadPeople()}
    catch(e){m.className='msg bad';m.textContent=e.message;b.disabled=false}});
}
$('newDrvBtn').onclick=()=>{$('newDrv').hidden=false;$('newDrv').querySelector('[name=name]').focus()};
$('ndCancel').onclick=()=>{$('newDrv').reset();$('newDrv').hidden=true;$('ndMsg').textContent=''};
$('newDrv').addToAzuga.onchange=e=>{$('azFields').hidden=!e.target.checked};
$('newDrv').onsubmit=async e=>{
  e.preventDefault();const f=$('newDrv'),m=$('ndMsg'),b=Object.fromEntries(new FormData(f));b.addToAzuga=f.addToAzuga.checked;
  if(b.addToAzuga&&!b.email){m.style.color='var(--bad)';m.textContent='Email is needed to add them to Azuga (or untick Also add to Azuga).';return}
  $('ndSave').disabled=true;m.style.color='';m.textContent='Saving...';
  try{const j=await post('/api/driver/create',b);m.style.color=j.warning?'var(--warn)':'var(--go)';m.textContent=j.warning||('Saved to '+j.saved.join(' and ')+' ✓');
    f.reset();if(!j.warning)setTimeout(()=>{f.hidden=true;m.textContent=''},2500);driverList=null;await loadPeople()}
  catch(err){m.style.color='var(--bad)';m.textContent=err.message}
  $('ndSave').disabled=false;
};
loadAT();
document.querySelectorAll('.tabs button').forEach(b=>b.onclick=()=>{
  document.querySelectorAll('.tabs button').forEach(x=>x.classList.toggle('on',x===b));
  ['vMap','vEdit','vDrv'].forEach(v=>$(v).hidden=b.dataset.v!==v);
  if(b.dataset.v==='vEdit')renderEdit();else if(b.dataset.v==='vDrv'){if(!PEOPLE)loadPeople();else renderDrivers()}else map.invalidateSize();
});
$('q').oninput=()=>{render();if(!$('vEdit').hidden)renderEdit();if(!$('vDrv').hidden)renderDrivers()};
window.addEventListener('beforeunload',e=>{if(dirtyCount())e.preventDefault()});
refresh();setInterval(refresh,30000);
</script></body></html>`;
