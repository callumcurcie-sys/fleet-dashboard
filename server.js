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
const KEEP = new Set(['scores', 'ramp', 'trips', 'chkAuto', 'mail', 'swaps', 'drvHist2', 'swapReq', 'rampRepairs', 'rampItems', 'gasRx', 'rampOv', 'upkeep', 'gasChk2', 'geo', 'camSync', 'visDays2']);
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
    (await pomDay(date)).map(pomStop).filter(s => { const t = Date.parse(s.time); return !pomCheckup(s) && t >= +start && t <= +end; })
      .sort((a, b) => Date.parse(a.time) - Date.parse(b.time)).forEach(s => (by[s.tech] = by[s.tech] || []).push(s));
    const td = await truckDrivers().catch(() => ({})), drivers = Object.keys(td).filter(v => td[v]).map(v => ({ name: td[v], v }));
    const techs = Object.entries(by).filter(([n]) => n).map(([name, stops]) => { const m = matchPerson(drivers, name);
      return { name, truck: m ? m.v : null, driver: m ? m.name : null, total: stops.length, done: stops.filter(s => s.done).length, stops }; });
    return { connected: true, date, today: date === etDay().ymd, techs }; },   // stops with no tech are ignored
  '/api/pom/checkups': async q => { if (!clean(process.env.POM_API_KEY)) return { connected: false };
    const weeks = Math.max(1, Math.min(12, +q.get('weeks') || 8)), anchor = etDay().end, list = [];
    for (let w = 0; w < weeks; w++) {
      const end = new Date(+anchor - w * 7 * 864e5), start = new Date(+end - 7 * 864e5 + 1);
      const rows = await cached('pomwk:' + start.toISOString().slice(0, 10), w ? 6 * 3600 : 120, () => pomRange(start, end));
      rows.map(pomStop).filter(s => s.tech && pomCheckup(s)).forEach(s => list.push(s));
    }
    // plus next week's, so someone who was just given a check-up shows up straight away
    const now = new Date(), seenIds = new Set(list.map(s => s.ruleId + '|' + s.time));
    (await cached('pomahead', 120, () => pomRange(now, new Date(+now + 15 * 864e5)))).map(pomStop)
      .filter(s => s.tech && pomCheckup(s) && Date.parse(s.time) < +now + 8 * 864e5 && !seenIds.has(s.ruleId + '|' + s.time)).forEach(s => list.push(s));
    const td = await truckDrivers().catch(() => ({})), drivers = Object.keys(td).filter(v => td[v]).map(v => ({ name: td[v], v })), trucks = {};
    const custIds = [...new Set(list.map(s => s.customerId).filter(Boolean))], svcs = [];
    for (const c of custIds) svcs.push(...await pomServices(c).catch(e => { console.error('POM services:', e.message); return []; }));
    const svcName = v => { const w = (v.workers || []).find(x => x.primary) || (v.workers || [])[0]; return w && w.user ? [w.user.firstName, w.user.lastName].filter(Boolean).join(' ') : ''; };
    list.forEach(s => { const day = etDay(new Date(s.time)).ymd, ai = v => v.appointmentIdentifier || {}, hit = svcs.find(v => (s.id && ai(v).id === s.id) || (s.ruleId && ai(v).recurringRuleId === s.ruleId && Date.parse(ai(v).recurringDate) === Date.parse(s.rdate || s.time)))
      || svcs.find(v => svcName(v) === s.tech && etDay(new Date(v.startTime)).ymd === day);
      if (hit) { s.service = hit.id; s.done = true; } });
    const at = await atData().catch(() => ({ drivers: [] })), people = at.drivers.filter(d => d.name && d.status !== 'Inactive'), roles = {}, phones = {}, emails = {}, seen = new Set();
    // Inactive in Airtable = gone from the check-up grid and the reminder emails, even with old POM check-ups on record
    const gone = at.drivers.filter(d => d.name && d.status === 'Inactive'), isGone = n => !matchPerson(people, n) && !!matchPerson(gone, n);
    for (let i = list.length - 1; i >= 0; i--) if (isGone(list[i].tech)) list.splice(i, 1);
    [...new Set(list.map(s => s.tech))].forEach(n => { const m = matchPerson(drivers, n), p = matchPerson(people, n); trucks[n] = m ? m.v : null; roles[n] = p ? p.role : ''; phones[n] = p ? p.phone : ''; emails[n] = p ? p.email : ''; if (p) seen.add(p.id); });
    // Techs, tech assistants and auditors submit the weekly truck form; owners, district, regional and staffers don't
    const missing = people.filter(d => CHECKUP_ROLES.includes(d.role) && !seen.has(d.id)).map(d => ({ name: d.name, role: d.role }));
    return { connected: true, now: Date.now(), today: etDay().ymd, weeks, checkups: list.sort((a, b) => Date.parse(b.time) - Date.parse(a.time)), trucks, roles, phones, emails, missing }; },
  // Read by the iMessage script on the Mac: who hasn't done this week's check-up yet, with the text to send them
  '/api/texts/missed-checkups': async () => {
    const d = await routes['/api/pom/checkups'](new URLSearchParams('weeks=1'));
    if (!d.connected) return { connected: false, texts: [] };
    const now = Date.now(), wd = (['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short' })) + 6) % 7;
    const monday = +etDay().start - wd * 864e5, texts = [], skipped = [], seen = new Set(), users = await pomUsers().catch(() => null);
    d.checkups.filter(c => !c.done && Date.parse(c.time) >= monday && Date.parse(c.time) < now && CHECKUP_ROLES.includes(d.roles[c.tech])).forEach(c => {
      if (seen.has(c.tech)) return; seen.add(c.tech);
      const ph = String(d.phones[c.tech] || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, ''), u = users && matchPerson(users, c.tech), em = (d.emails || {})[c.tech] || (u && u.email) || '', email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em) ? em : '';
      if (ph.length !== 10 && !email) return skipped.push({ name: c.tech, why: 'No phone or email in Airtable' });
      const day = new Date(c.time).toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'long', month: 'short', day: 'numeric' }), first = c.tech.split(' ')[0];
      texts.push({ name: c.tech, phone: ph.length === 10 ? '+1' + ph : '', email, message: 'Hi ' + first + ', reminder: your weekly truck check-up for ' + day + " hasn't been submitted in POM yet. Please fill it out today. Thanks!",
        subject: 'Truck check-up missed: ' + day + '. Please submit today',
        body: 'Hi ' + first + ',\n\nYour weekly truck check-up for ' + day + " hasn't been submitted in Pool Office Manager yet. Please open the POM app and complete your Truck Check-Up as soon as possible.\n\nNot submitting your truck check-up can hurt your bonus for the week.\n\nYou'll keep getting this reminder until it's submitted.\n\nThanks,\nMillennial Pools" });
    });
    console.log(new Date().toISOString(), 'Missed check-up texts requested:', texts.map(t => t.name).join(', ') || 'none');
    return { connected: true, texts, skipped }; },
  '/api/pom/probe': async () => { if (!clean(process.env.POM_API_KEY)) return { connected: false };
    const out = {}, tryIt = async (k, q, v) => { try { out[k] = await pom(q, v); } catch (e) { out[k] = { error: e.message }; } };
    await tryIt('needs', 'mutation($data: CreateAppointmentRecurringRuleInput!) { createAppointmentRecurringRule(data: $data) { id } }', { data: {} });
    await tryIt('unknown', 'mutation($data: CreateAppointmentRecurringRuleInput!) { createAppointmentRecurringRule(data: $data) { id } }', { data: { zzzNotAField: 1 } });
    await tryIt('users', 'query { infiniteUsers(first: 50) { edges { node { id firstName lastName isActive } } pageInfo { hasNextPage } } }');
    await tryIt('usersPlain', 'query { infiniteUsers { edges { node { id firstName lastName } } } }');
    const { start } = etDay(), from = new Date(+start - 8 * 864e5);
    await tryIt('rules', `query($s: AppointmentsV2Selector) { infiniteAppointmentsV2(selector: $s, first: 200) { edges { node { id date duration recurringRuleId recurringDate
      recurringRule { id rruleString startDate endDate } serviceType { id display } customer { id firstName lastName } primaryWorker { id firstName lastName } } } } }`,
      { s: { startDate: from.toISOString(), endDate: new Date(+start + 864e5).toISOString(), includePinned: true } });
    if (out.rules && out.rules.infiniteAppointmentsV2) out.rules = out.rules.infiniteAppointmentsV2.edges.map(e => e.node).filter(n => pomCheckup({ type: n.serviceType && n.serviceType.display, customer: [n.customer && n.customer.firstName, n.customer && n.customer.lastName].join(' ') }));
    const cid = Array.isArray(out.rules) && out.rules[0] && out.rules[0].customer && out.rules[0].customer.id;
    if (cid) await tryIt('services', `query($c: String!) { infiniteServices(selector: {filters: {customerId: {equals: $c}}}, first: 3, sort: {field: startTime, order: DESC}) { edges { node { ${POM_SVC_FIELDS} } } } }`, { c: cid });
    return out; },
  '/api/pom/checkup-plan': () => checkupPlan(),
  '/api/truck/swaps': () => swapLog(),
  '/api/purchases': () => purchases(),
  '/api/ramp/overview': () => RAMP_CLIENT_ID && RAMP_CLIENT_SECRET ? rampOverview() : { connected: false },
  '/api/truck/requests': () => swapReqs(),
  '/api/truck/history': q => truckHistory(q),
  '/api/mail/status': () => { const st = mailState(); return { ready: mailReady(), from: mailFrom(), auto: !!st.auto, week: st.week, sent: st.sent || [], bounced: st.bounced || [], bounceErr: st.bounceErr || '', sms: !!st.sms, smsReady: !!TXT_KEY(), svc: !!(st.svc && st.svc.on), svcToday: st.svc && st.svc.day === etDay().ymd ? Object.keys(st.svc.sent || {}).length : 0, eod: !!(st.eod && st.eod.on), eodToday: st.eod && st.eod.day === etDay().ymd ? (st.eod.sent || []) : null, texted: st.texted && st.texted.day === new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) ? st.texted.names : [] }; },
  '/api/repairs': async () => { if (!AIRTABLE_TOKEN) return { connected: false };
    const at = await atData(), ramp = RAMP_CLIENT_ID && RAMP_CLIENT_SECRET ? await rampRepairs().catch(e => ({ error: e.message })) : null;
    return { connected: true, ramp, trucks: at.trucks.map(t => ({ id: t.id, truckNo: t.truckNo, desc: [t.year, t.make, t.model].filter(Boolean).join(' '),
      driver: t.driver ? t.driver.name : '', notes: t.notes })) }; },
  '/api/pom/stops': async () => { if (!clean(process.env.POM_API_KEY)) return { connected: false };
    return { connected: true, day: etDay().ymd, stops: (await withCoords((await pomToday()).map(pomStop).filter(s => s.tech && !pomCheckup(s)))).filter(s => s.lat && s.lng) }; },
  '/api/pom/debug': async () => { const { start, end } = etDay();   // behind the dashboard login: what POM sends back, for setting this up
    try { const all = await pomToday(); return { auth: pomAuth, day: etDay().ymd, start, end, count: all.length, techs: [...new Set(all.map(a => pomStop(a).tech))], statuses: [...new Set(all.map(a => a.status + ' / ' + (a.serviceStatus && a.serviceStatus.name)))], sample: all.slice(0, 2) }; }
    catch (e) { return { error: e.message }; } },
  '/api/score/status': () => ({ jobs: WARM, events: Object.keys(EVA.ev).length, weeksBackfilled: EVA.weeks, miles: !!(cache.get('scores') || {}).data }),
  '/api/score': q => scoreFor(q.get('vehicleId') || '', q.get('name') || ''),
  // Older footage for the Cameras tab, one week at a time (w=1 is 7-14 days ago). Only events whose clip or photos Azuga still has.
  '/api/videos/week': q => {
    const w = Math.max(1, Math.min(104, parseInt(q.get('w')) || 1)), body = { startTime: fmt(daysAgo(7 * (w + 1))), endTime: fmt(daysAgo(7 * w)), page: 1, limit: 100 };
    return cached('vidwk:' + w + ':' + new Date().toISOString().slice(0, 10), 6 * 3600, async () => {
      let ev = [];
      for (let page = 1; page <= 15; page++) { const p = list(await azuga('/eventVideos.json?videoType=eventVideo', { ...body, page })); ev = ev.concat(p); if (p.length < body.limit) break; await sleep(400); }
      addEvents(ev);
      const kept = ev.filter(x => camMedia(x));
      return { w, from: body.startTime, total: ev.length, events: kept };
    });
  },
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
    const o = Math.round(Number(String(b.odometer).replace(/[,\s]|mi$/gi, '')));
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
  if (mine) { Object.assign(mine, body); if (body.odometerReading != null) { mine.vehicleDeviceCurrentodoReading = body.odometerReading; mine.odoSource = 'User input'; } }
  cache.delete('vehicles'); cache.delete('locations');
  console.log(new Date().toISOString(), 'Azuga updated', cur.name, '->', changed.join(', '));
  return changed;
}

// ---------------- Airtable (the source of truth) ----------------
const { AIRTABLE_TOKEN } = process.env;
const AT_BASE = 'appxOcqhRSdoWgHE3', AT_TRUCKS = 'tbl3aU0dRPvn79Ba1', AT_DRIVERS = 'tbl9oEuseNwk23jdg';
const F = { vin: 'fldT4fSSnXnZuj2Jr', year: 'fldqjqyAK1ZJfn0oT', make: 'fldOhan3is4yEhucl', model: 'fldM01jCShSILujYB',
  truckNo: 'fldYmYqWTfoYoRvjB', policy: 'fldWlS28YbpsipR7r', driver: 'fldEO66ezgMWnguAu', plate: 'fldLGLwnLOAfpw88W',
  insCard: 'fldH0Pe6EKyQEBmMR', files: 'fldS5YJgDrLDbxSiK', regRenew: 'fldjFFBZ0UoO4SUXV', ezpass: 'fld1utE81nDdDiqgi', active: 'fldBpQ0MA5cD9YJ06', snap: 'fldOaFfl7ZzS72xLK', notes: 'fldkWorOJHdYaLCy5', oilDate: 'fldGdTd6Vk2w7lyrn', oilMiles: 'fldKXcXo3MPHkkfC4', insExp: 'fldITfdiPBIa3oMd8', regExp: 'fldjZ4AIbigbm6PPX', hasTracker: 'fld9r34OVpY2kPEom' };
// Drivers. Date of birth is only ever written (new driver form), never read or shown.
const D = { name: 'fldMrVtrXN6WDaOjj', license: 'fldcSIYqy5FCEC0Xn', state: 'fld1NdVP4v6QcckK2', pic: 'fldZeCHS22kI7Ythi',
  policy: 'fldVo5IrWedsKvumK', trucks: 'fld47HPqHRrw9GUL7', notes: 'fldSnexzpxIG22gF0', status: 'fldVuSDYSZVHk0fWN',
  phone: 'fldNxN3OyrU3TFAjQ', azId: 'fldgBxpfEnLCwdIzS', snap: 'fldhuLqirXbDaAy89', role: 'fld2dWRGDGFmhpbDt', email: 'fldqh3XV7jAkxuLPe' };
const ROLES = ['Tech', 'Tech assistant', 'District', 'Regional', 'Owner', 'Auditor', 'Staffer'], CHECKUP_ROLES = ['Tech', 'Tech assistant', 'Auditor'];
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
    status: clean(r.fields[D.status]?.name ?? r.fields[D.status]) || 'Active', role: clean(r.fields[D.role]?.name ?? r.fields[D.role]),
    phone: clean(r.fields[D.phone]), email: clean(r.fields[D.email] || ''), azId: clean(r.fields[D.azId]), snap: parseSnap(r.fields[D.snap]) }));
  const byId = Object.fromEntries(drivers.map(d => [d.id, d]));
  return {
    drivers,
    trucks: trucks.map(r => { const f = r.fields; return {
      id: r.id, vin: normVin(f[F.vin]), year: clean(f[F.year]), make: clean(f[F.make]), model: clean(f[F.model]),
      truckNo: clean(f[F.truckNo]), policy: clean(f[F.policy]?.name ?? f[F.policy]), plate: clean(f[F.plate]),
      regRenew: clean(f[F.regRenew]), ezpass: clean(f[F.ezpass]), active: !!f[F.active],
      driver: (f[F.driver] || []).map(id => byId[id]).filter(Boolean)[0] || null, snap: parseSnap(f[F.snap]),
      insCard: att(f[F.insCard]), files: att(f[F.files]), notes: String(f[F.notes] || ''), oilDate: f[F.oilDate] || '', oilMiles: f[F.oilMiles] || null, insExp: f[F.insExp] || '', regExp: f[F.regExp] || '', hasTracker: !!f[F.hasTracker],
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
    vinOk: /^[A-HJ-NPR-Z0-9]{17}$/.test(t.vin), dupVin: vinCount[t.vin] > 1, desc: [t.year, t.make, t.model].filter(Boolean).join(' '),
    plate: t.plate, active: t.active, driverName: t.driver ? t.driver.name : '', notes: t.notes, oilDate: t.oilDate, oilMiles: t.oilMiles })) };
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
    id: d.id, name: d.name, license: d.license, state: d.state, policy: d.policy, notes: d.notes, pic: d.pic, status: d.status, role: d.role, email: d.email, phone: d.phone,
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
// Email / phone typed in the Drivers tab: blank clears, otherwise checked and tidied ("609-555-1234" -> "(609) 555-1234")
const contactFields = b => { const f = {};
  if ('email' in b) { const e = clean(b.email).toLowerCase(); if (e && !EMAIL_OK.test(e)) throw new Error('That email address does not look right.'); f[D.email] = e || null; }
  if ('phone' in b) { const d = clean(b.phone).replace(/\D/g, '').replace(/^1(?=\d{10}$)/, ''); if (d && d.length !== 10) throw new Error('Phone number needs 10 digits.'); f[D.phone] = d ? '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6) : null; }
  return f; };
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
  Object.assign(fields, Object.fromEntries(Object.entries(contactFields(b)).filter(([, v]) => v)));
  if (b.dob) fields[D_DOB] = b.dob;
  if (clean(b.role)) { if (!ROLES.includes(b.role)) throw new Error('Pick a role from the list.'); fields[D.role] = b.role; }
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

// Truck notes: one line per note, newest first, e.g. "Oct 7, 2026 · From Jack Henry's check-up (Sep 24): Rear brakes replaced"
async function addTruckNote(b) {
  const at = await atData(), t = at.trucks.find(x => x.id === String(b.truckId || ''));
  if (!t) throw new Error('That truck is not in Airtable. Refresh and try again.');
  const txt = text(b.text, 500, 'Note').replace(/\s+/g, ' ');
  if (!txt) throw new Error('Write a note first.');
  const src = clean(b.source).replace(/\s+/g, ' ').slice(0, 120);
  const ymd = /^\d{4}-\d{2}-\d{2}$/.test(b.day || '') ? b.day : '';
  const day = ymd ? new Date(ymd + 'T12:00:00').toLocaleDateString('en-US', { dateStyle: 'medium' }) : new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium' });
  const when = l => { const m = /^([A-Z][a-z]{2} \d{1,2}, \d{4}) · /.exec(l); return m ? Date.parse(m[1]) : 0 };
  const notes = [day + ' · ' + (src ? src + ': ' : '') + txt].concat(t.notes ? t.notes.split('\n') : [])
    .map((l, i) => [l, i]).sort((a, b) => when(b[0]) - when(a[0]) || a[1] - b[1]).map(x => x[0]).join('\n').slice(0, 90000);
  const fields = { [F.notes]: notes };
  const today = ymd || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }), oil = oilFrom(txt, today);
  if (oil && (!t.oilDate || oil.date >= t.oilDate)) { fields[F.oilDate] = oil.date; if (oil.miles) fields[F.oilMiles] = oil.miles; }
  await airtable(AT_TRUCKS, { method: 'PATCH', body: JSON.stringify({ records: [{ id: t.id, fields }] }) });
  cache.delete('airtable');
  console.log(new Date().toISOString(), 'Truck note added', t.truckNo || t.id, fields[F.oilDate] ? 'oil change ' + fields[F.oilDate] : '');
  return { ok: true, notes, oil: fields[F.oilDate] ? oil : null };
}
// "Oil changed 10/3 at 184,300 mi" -> { date: '2026-10-03', miles: 184300 }. No date in the text = the day the note was written.
const MON = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
function oilFrom(txt, today) {
  if (!/\boil\b/i.test(txt) || !/chang|service|swap|\bdone\b|replac/i.test(txt) || /\b(due|needs?|overdue|soon|light)\b/i.test(txt)) return null;
  const ymd = (y, m, d) => { if (m < 1 || m > 12 || d < 1 || d > 31) return null; const Y = y == null ? +today.slice(0, 4) : y < 100 ? 2000 + y : y;
    let v = Y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0'); if (y == null && v > today) v = (Y - 1) + v.slice(4); return v };
  let date = null, m;
  if ((m = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(txt))) date = ymd(m[3] == null ? null : +m[3], +m[1], +m[2]);
  else if ((m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? (\d{1,2})(?:st|nd|rd|th)?(?:,? (\d{4}))?\b/i.exec(txt))) date = ymd(m[3] == null ? null : +m[3], MON.indexOf(m[1].toLowerCase()) + 1, +m[2]);
  else if (/\byesterday\b/i.test(txt)) date = new Date(Date.parse(today) - 864e5).toISOString().slice(0, 10);
  if (!date || date > today) date = today;
  const rest = txt.replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, ' ').replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d{1,2}(?:,? \d{4})?/gi, ' ');
  const mm = /(\bat\s*)?\b(\d{1,3}(?:,\d{3})+|\d{3,7}(?:\.\d)?)\s*(k\b|mi\b|miles\b)?/i.exec(rest);
  let miles = null;
  if (mm && (mm[1] || mm[3])) miles = Math.round(/^k/i.test(mm[3] || '') ? parseFloat(mm[2].replace(/,/g, '')) * 1000 : +mm[2].replace(/,/g, ''));
  if (miles != null && (miles < 1000 || miles > 2e6)) miles = null;
  return { date, miles };
}
// Invoice from the Repairs tab (often a phone photo): the photo goes into the truck's files, the details into its notes
async function addRepair(b) {
  const at = await atData(), t = at.trucks.find(x => x.id === String(b.truckId || ''));
  if (!t) throw new Error('Pick the truck this invoice is for.');
  const ymd = /^\d{4}-\d{2}-\d{2}$/.test(b.date || '') && b.date <= new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) ? b.date : new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const shop = clean(b.shop).replace(/[:·\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Shop';
  const work = clean(b.work).replace(/\s+/g, ' ').trim().replace(/\.+$/, '').slice(0, 300);
  const raw = String(b.total ?? '').replace(/[$,\s]/g, ''), total = raw === '' ? null : Number(raw);
  if (total !== null && !(total >= 0 && total < 1e6)) throw new Error('Total should be a dollar amount, like 249.99.');
  const photos = invPhotos(b), photo = photos.length > 0;
  if (!photo && !work) throw new Error('Take a photo or write what was done.');
  for (const [i, ph] of photos.entries()) {
    const up = await fetch('https://content.airtable.com/v0/' + AT_BASE + '/' + t.id + '/' + F.files + '/uploadAttachment', {
      method: 'POST', headers: { Authorization: 'Bearer ' + AIRTABLE_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contentType: ph.type, file: ph.data, filename: 'invoice-' + ymd + '-' + (shop.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'shop') + (photos.length > 1 ? '-p' + (i + 1) : '') + '.jpg' }) });
    if (!up.ok) throw new Error('Could not save photo ' + (i + 1) + ' to Airtable (' + up.status + '). Try again.');
  }
  const amt = total === null ? 'Total not entered' : total === 0 ? 'No charge shown' : 'Total $' + total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const r = await addTruckNote({ truckId: t.id, day: ymd, source: 'From ' + shop + (b.estimate === true ? ' estimate' : ' invoice'), text: (work || 'Invoice photo added, details to fill in') + '. ' + amt });
  console.log(new Date().toISOString(), 'Invoice added', t.truckNo || t.id, shop, amt, photos.length + ' photo(s)');
  return r;
}
// An invoice can be several photos (pages, or front and back). Claude reads them together and fills in the form.
const invPhotos = b => [...(Array.isArray(b.photos) ? b.photos : []), b.photo].filter(okPhoto).slice(0, 10);
async function readInvoice(b) {
  const photos = invPhotos(b); if (!photos.length) throw new Error('Add a photo of the invoice first.');
  if (!AI_KEY()) return { ai: false };
  const a = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': AI_KEY(), 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: AI_MODEL, max_tokens: 900, messages: [{ role: 'user', content: [...photos.map(p => ({ type: 'image', source: { type: 'base64', media_type: p.type, data: p.data } })), { type: 'text', text:
      'These photos are all one vehicle repair invoice, receipt or estimate (several pages or angles of the same document). Reply with JSON only, no other text: '
      + '{"shop":"business name","date":"YYYY-MM-DD","total":0.00,"work":"short plain list of the work done, e.g. Oil change, front brake pads and rotors, new serpentine belt","estimate":false,"vin":"","plate":"","mileage":0}. '
      + 'total is the final amount due or paid, with tax. estimate is true only if it says estimate or quote. mileage is the odometer reading printed on it. Leave out part numbers, prices and labor codes from work. Use "" or 0 for anything not printed.' }] }] }) });
  const j = await a.json().catch(() => ({}));
  if (!a.ok) throw new Error('Claude could not read it (' + a.status + '): ' + String((j.error && j.error.message) || '').slice(0, 120));
  const txt = ((j.content || []).find(c => c.type === 'text') || {}).text || '', m = txt.match(/\{[\s\S]*\}/);
  let o = {}; try { o = m ? JSON.parse(m[0]) : {}; } catch { }
  const at = await atData(), vin = normVin(o.vin || ''), plate = clean(o.plate || '').toUpperCase().replace(/[\s-]/g, '');
  const t = (vin.length >= 6 && at.trucks.find(x => x.vin && (x.vin === vin || x.vin.endsWith(vin.slice(-8)))))
    || (plate.length >= 4 && at.trucks.find(x => x.plate && x.plate.toUpperCase().replace(/[\s-]/g, '') === plate));
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }), miles = Math.round(+o.mileage || 0);
  let work = clean(o.work || '').replace(/\s+/g, ' ').replace(/\.+$/, '').slice(0, 260);
  if (work && miles > 100 && miles < 2e6) work += ' at ' + miles.toLocaleString('en-US') + ' mi';   // lets the oil-change log pick up the mileage
  return { ai: true, pages: photos.length, shop: clean(o.shop || '').slice(0, 60), date: /^\d{4}-\d{2}-\d{2}$/.test(o.date || '') && o.date <= today ? o.date : '',
    total: +o.total > 0 ? Math.round(o.total * 100) / 100 : '', work, estimate: o.estimate === true, truckId: t ? t.id : '' };
}
async function deleteTruckNote(b) {
  const at = await atData(), t = at.trucks.find(x => x.id === String(b.truckId || ''));
  if (!t) throw new Error('That truck is not in Airtable. Refresh and try again.');
  const lines = t.notes.split('\n'), i = lines.indexOf(String(b.line || ''));
  if (i < 0) throw new Error('That note was already changed or removed. Refresh to see the latest.');
  lines.splice(i, 1); const notes = lines.join('\n');
  await airtable(AT_TRUCKS, { method: 'PATCH', body: JSON.stringify({ records: [{ id: t.id, fields: { [F.notes]: notes || null } }] }) });
  cache.delete('airtable'); console.log(new Date().toISOString(), 'Truck note deleted', t.truckNo || t.id);
  return { ok: true, notes };
}
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
  Object.assign(fields, contactFields(b));
  if (b.status === 'Active' || b.status === 'Inactive') fields[D.status] = b.status;
  if ('role' in b) { if (b.role && !ROLES.includes(b.role)) throw new Error('Pick a role from the list.'); fields[D.role] = b.role || null; }
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
  if ('role' in b || b.status) setTimeout(autoCheckups, 5000);   // roles drive the POM truck check-up
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
// Past drivers per truck: Azuga's Scores report month by month for the last 12 months shows who drove each
// tracker and how far. Sticker sign-ins (truckSwap) add to it from now on. Trucks with no tracker only have sign-ins.
const drvHistory = () => cached('drvHist2', 12 * 3600, async () => {
  const by = { _tot: {} };   // trackeeId -> { nameKey: { name, from, to, miles, mo: { monthsAgo: miles } } }; _tot: trackeeId -> all miles
  for (let m = 0; m < 12; m++) {
    const start = daysAgo(30 * (m + 1)), end = daysAgo(30 * m);
    const rows = list(await azuga('https://services.azuga.com/reports/v3/reports/score?appId=FLEET', { startDate: azIso(start), endDate: azIso(end), browserTimezone: 'US/Eastern', reportFilter: 'default', index: 0, size: 500, desc: false, filter: { orFilter: {}, matchFilter: {} } }));
    for (const r of rows) {
      const name = [r.firstName, r.lastName].filter(Boolean).join(' ').replace(/[ .]+$/, ''), mi = +r.distanceTravelled || 0;
      if (!r.vehicleId || mi < 1) continue;
      by._tot[r.vehicleId] = (by._tot[r.vehicleId] || 0) + mi;
      if (!/[a-z]/i.test(name)) continue;   // Azuga shows a number when nobody was logged in
      const tv = by[r.vehicleId] = by[r.vehicleId] || {}, h = tv[dupeName(name)] = tv[dupeName(name)] || { name, from: +start, to: +end, miles: 0, mo: {} };
      h.from = Math.min(h.from, +start); h.to = Math.max(h.to, +end); h.miles += mi; h.mo[m] = (h.mo[m] || 0) + mi;
    }
    await sleep(1500);
  }
  return by;
});
async function truckHistory(q) {
  const v = clean(q.get('v')), tid = clean(q.get('t')), out = {};
  const add = (name, from, to, extra) => { const k = dupeName(name); if (!k) return; const h = out[k] = out[k] || { name, from, to, miles: 0, signIns: 0 };
    h.from = Math.min(h.from, from); h.to = Math.max(h.to, to); Object.keys(extra).forEach(x => h[x] += extra[x]); };
  if (v) Object.values((await drvHistory())[v] || {}).forEach(h => add(h.name, h.from, h.to, { miles: Math.round(h.miles) }));
  const yr = Date.now() - 365 * 864e5;
  if (tid) swapLog().filter(x => x.tid === tid && x.at > yr).forEach(x => add(x.who, x.at, x.at, { signIns: x.out ? 0 : 1 }));
  const t = tid && (await atData()).trucks.find(x => x.id === tid), now = t && t.driver ? dupeName(t.driver.name) : '';
  if (now) add(t.driver.name, Date.now(), Date.now(), {});
  return Object.entries(out).map(([k, h]) => ({ ...h, now: k === now })).sort((a, b) => b.now - a.now || b.to - a.to);
}
if (process.argv[2] !== 'test') setTimeout(() => drvHistory().catch(e => console.error('Driver history:', e.message)), 5 * 60e3);
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
  const [vs, at, ad] = await Promise.all([routes['/api/vehicles']().then(list).catch(() => []), AIRTABLE_TOKEN ? atLinks().catch(() => ({ links: {} })) : { links: {} }, AIRTABLE_TOKEN ? atData().catch(() => ({ trucks: [] })) : { trucks: [] }]);
  const m = {};
  vs.forEach(v => { const L = at.links && at.links[v.trackeeId];
    const hand = !(L && L.linked) && (((cache.get('camSync') || {}).data || {}).manual || {})[v.trackeeId], ht = hand && ad.trucks.find(t => t.id === hand);   // camera given a truck by hand in Airtable
    m[v.trackeeId] = (L && L.linked && L.truck.driver && L.truck.driver.name) || (ht && ht.driver && ht.driver.name) || v.userName || [v.userFirstName, v.userLastName].filter(Boolean).join(' '); });
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
const AT_POOL_MI = [0.1, 0.3, +process.env.POOL_WIDE_MI || 0.75];   // big sites (schools, apartment complexes) park far from the address pin: last ring needs a real stop
const SUFFIX = { road: 'rd', street: 'st', avenue: 'ave', av: 'ave', drive: 'dr', lane: 'ln', court: 'ct', place: 'pl', boulevard: 'blvd', circle: 'cir', terrace: 'ter', parkway: 'pkwy', highway: 'hwy', route: 'rt' };
const streetOf = a => { const m = String(a || '').toLowerCase().split(',')[0].replace(/[.#]/g, '').match(/^(\d+)[a-z]?\s+(.+)$/);
  return m ? { n: +m[1], st: m[2].split(/\s+/).map(w => SUFFIX[w] || w).join(' ') } : null; };
// Arrived = the first ignition-off (or first stop) at the property; left = the last breadcrumb there before driving away.
function visitAt(stop, pts) {
  const home = streetOf(stop.address), tests = [];
  if (stop.lat && stop.lng) AT_POOL_MI.forEach((r, i) => tests.push({ at: p => miles(p, stop) <= r, how: r > AT_POOL_MI[0] ? 'wide' : '', far: i === AT_POOL_MI.length - 1 }));
  if (home) tests.push({ at: p => { const x = streetOf(p.addr); return x && x.st === home.st && Math.abs(x.n - home.n) <= 100; }, how: 'addr' });
  for (const { at, how, far } of tests) {
    const runs = []; let run = null;
    for (const p of pts) { if (at(p)) { if (!run) runs.push(run = []); run.push(p); } else run = null; }
    const real = runs.filter(x => x[x.length - 1].t - x[0].t >= (far ? 5 : 2) * 60e3 && (!far || x.some(p => p.mph === 0 || /ignition\s*off|engine\s*off|stop/i.test(p.ev))));
    if (!real.length) continue;
    const best = real.sort((a, b) => (b[b.length - 1].t - b[0].t) - (a[a.length - 1].t - a[0].t))[0];
    const off = best.find(p => /ignition\s*off|engine\s*off|stop/i.test(p.ev)) || best.find(p => p.mph === 0) || best[0];
    const leave = best[best.length - 1].t;
    const ft = stop.lat && stop.lng ? Math.round(Math.min(...best.map(p => miles(p, stop))) * 5280) : null;
    const kind = how === 'wide' && ft <= AT_POOL_MI[0] * 5280 ? '' : how;   // parked close, just stepped out of the small circle for a bit
    return { away: pts.some(p => p.t > leave + 60e3), arrive: off.t, leave, mins: Math.max(0, Math.round((leave - off.t) / 6e4)), visits: real.length, ft, how: kind, wide: !!kind, parkedAt: off.addr, lat: off.lat, lng: off.lng };
  }
  return null;
}
// POM has no map pin for some properties (GCIT): look the street address up once (OpenStreetMap) and keep it
const NOM = q => fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=' + encodeURIComponent(q), { headers: { 'User-Agent': 'MillennialPools-FleetDashboard/1.0' } })
  .then(r => r.ok ? r.json() : []).then(j => j[0] ? { lat: +j[0].lat, lng: +j[0].lon } : null).catch(() => null);
const ABBR = { rd: 'Road', st: 'Street', ave: 'Avenue', av: 'Avenue', dr: 'Drive', ln: 'Lane', blvd: 'Boulevard', ct: 'Court', pl: 'Place', pkwy: 'Parkway', hwy: 'Highway', cir: 'Circle', ter: 'Terrace', tpke: 'Turnpike' };
async function geoAddr(a, name) {
  const g = (cache.get('geo') || {}).data || {}, k = 'addr:' + clean(a).toLowerCase();
  if (k in g) return g[k];
  const parts = clean(a).split(',').map(x => x.trim()), street = (parts[0] || '').replace(/\b([A-Za-z]+)\.?$/, (m, w) => ABBR[w.toLowerCase()] || w), state = parts[parts.length - 1] || 'NJ';
  // OpenStreetMap misses some spellings ("Rd", a mailing town like Sewell): try the address a few ways, then the property's name
  const tries = [a, street + ', ' + state + ', USA', [street, ...parts.slice(1)].join(', '), name ? name + ', ' + state : ''].filter((q, i, l) => q && l.indexOf(q) === i);
  let hit = null;
  for (const q of tries) { await sleep(1100); hit = await NOM(q); if (hit) break; }   // one lookup a second
  g[k] = hit; cache.set('geo', { data: g, t: Date.now() }); saveSnap('geo', g); return hit;
}
async function withCoords(stops) {
  for (const s of stops) if ((!s.lat || !s.lng) && s.address) { const c = await geoAddr(s.address, s.customer); if (c) { s.lat = c.lat; s.lng = c.lng; s.geo = true; } }
  return stops;
}
async function visitsFor(name, ymd) {
  const { tech, stops } = await pomStopsFor(name, ymd); await withCoords(stops);
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
    const why = e => { const x = e.extensions || {}, o = x.originalError || x.exception || x.response || {}, m = [].concat(o.message || x.message || []).filter(v => v && v !== e.message);
      return e.message + (m.length ? ' (' + m.join(', ') + ')' : x.code && x.code !== 'BAD_REQUEST' ? ' (' + x.code + ')' : ''); };
    const err = (j.errors || []).map(why).join('; ');
    if (err && /^\s*mutation/.test(query)) { console.error('POM write refused:', err, JSON.stringify(j.errors).slice(0, 800)); throw new Error('Pool Office Manager said: ' + err); }
    if (r.ok && j.data && !/unauth|forbidden|not authenticated|invalid.*(key|token)/i.test(err)) { pomAuth = st; if (err) console.error('POM partial:', err); return j.data; }
    last = r.status + ' ' + (err || JSON.stringify(j).slice(0, 160));
    if (pomAuth) break;
  }
  throw new Error('Pool Office Manager said: ' + last);
}
const POM_STOP_FIELDS = `id date duration status pinned recurringRuleId recurringDate recurringRule { id rruleString } primaryWorker { id firstName lastName } workers { id firstName lastName primary }
  serviceType { id display } serviceStatus { id name } customer { id firstName lastName streetAddress city state zipCode latitude longitude }`;
// Midnight-to-midnight today in New Jersey time
function etDay(d = new Date()) {
  const ymd = d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const off = -parseInt((new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' }).formatToParts(new Date(ymd + 'T12:00:00Z')).find(x => x.type === 'timeZoneName') || {}).value.replace('GMT', '') || '-5', 10);   // hours behind UTC: 4 or 5
  const start = new Date(ymd + 'T00:00:00Z'); start.setUTCHours(off);
  return { ymd, start, end: new Date(+start + 864e5 - 1) };
}
const pomToday = () => pomDay(etDay().ymd);
async function pomRange(start, end) {
  const out = []; let after = null;
  for (let page = 0; page < 15; page++) {
    const d = await pom(`query($selector: AppointmentsV2Selector, $first: Int, $after: String) { infiniteAppointmentsV2(selector: $selector, first: $first, after: $after) {
      edges { node { ${POM_STOP_FIELDS} } } pageInfo { endCursor hasNextPage } } }`,
      { selector: { startDate: start.toISOString(), endDate: end.toISOString(), includePinned: true }, first: 200, after });
    const c = d.infiniteAppointmentsV2 || {};
    (c.edges || []).forEach(e => e && e.node && out.push(e.node));
    if (!c.pageInfo || !c.pageInfo.hasNextPage) break;
    after = c.pageInfo.endCursor;
  }
  return out;
}
const pomDay = ymd => cached('pom:' + ymd, ymd === etDay().ymd ? 120 : 3600, () => { const { start, end } = etDay(new Date(ymd + 'T16:00:00Z')); return pomRange(start, end); });   // past days don't change much
// A submitted check-up is a POM "service" (the form the tech fills in), linked back to its appointment
const POM_SVC_FIELDS = `id startTime endTime internalNotes customerNotes createdAt
  workers { primary user { id firstName lastName } } type { id display }
  appointmentIdentifier { id recurringRuleId recurringDate }
  pictures { id description createdAt file { id url } }
  media { id description mediaType createdAt customServiceReportFieldLabel file { id url thumbnails { thumbnail450Url thumbnail900Url } } }
  customServiceReport { id name }
  customFields { id value customField { id name type } newCustomField { id name type } }`;
const pomServices = customerId => cached('pomsvc:' + customerId, 120, async () => { const out = []; let after = null;   // POM pages at 50
  for (let i = 0; i < 10; i++) {
    const d = await pom(`query($c: String!, $a: String) { infiniteServices(selector: {filters: {customerId: {equals: $c}}}, first: 50, after: $a, sort: {field: startTime, order: DESC}) { edges { node { ${POM_SVC_FIELDS} } } pageInfo { endCursor hasNextPage } } }`, { c: customerId, a: after });
    const c = d.infiniteServices || {}; (c.edges || []).forEach(e => e && e.node && out.push(e.node));
    if (!c.pageInfo || !c.pageInfo.hasNextPage || out.length >= 300) break; after = c.pageInfo.endCursor; }
  return out; });
const pomService = async id => { const d = await pom(`query($id: ID!) { infiniteServices(selector: {filters: {id: {equals: $id}}}) { edges { node { ${POM_SVC_FIELDS} customer { id firstName lastName } } } } }`, { id });
  return (((d.infiniteServices || {}).edges || [])[0] || {}).node || null; };
// Weekly truck check-ups live in POM as appointments ("Truck Check-Up" for "Trucks Submissions"); they aren't pool visits
const pomCheckup = s => /truck\s*(check|submission|inspection)/i.test((s.type || '') + ' ' + (s.customer || ''));
const pomDone = a => /complet|done|finish|serviced|closed/i.test(String(a.status || '') + ' ' + (a.serviceStatus && a.serviceStatus.name || ''));
// POM, Azuga and Airtable spell some names differently ("Jostin Acosto" / "Jostin Acosta Palacios", "Andrew Morgan" / "Andrew Louis Morgan Jr")
const nameToks = n => dupeName(n).split(' ').filter(w => w && !/^(jr|sr|ii|iii|iv)$/.test(w));
const sameName = (a, b) => { const x = nameToks(a), y = nameToks(b); if (!x.length || !y.length || x[0].slice(0, 3) !== y[0].slice(0, 3)) return false;
  return x.slice(1).some(w => y.slice(1).some(v => v === w || (w.length > 3 && near(w, v)))); };
const matchPerson = (list, n) => rampMatch(list, n) || list.find(d => sameName(d.name, n));
const pomStop = a => { const c = a.customer || {}, w = a.primaryWorker || (a.workers || []).find(x => x.primary) || (a.workers || [])[0] || {};
  return { id: a.id, ruleId: a.recurringRuleId || null, rdate: a.recurringDate || null, rrule: a.recurringRule && a.recurringRule.rruleString || '', workerId: w.id || null, serviceTypeId: a.serviceType && a.serviceType.id || null, time: a.date, mins: a.duration, status: a.status, serviceStatus: a.serviceStatus && a.serviceStatus.name, done: pomDone(a),
    type: a.serviceType && a.serviceType.display, tech: [w.firstName, w.lastName].filter(Boolean).join(' '),
    customerId: c.id || null, customer: [c.firstName, c.lastName].filter(Boolean).join(' '), address: [c.streetAddress, c.city, c.state].filter(Boolean).join(', '),
    lat: +c.latitude || null, lng: +c.longitude || null }; };
// Tech names in POM may be spelled a little differently from Airtable (DiMaio / Dimeo): same matching rules as Ramp
async function pomStopsFor(name, ymd) {
  const stops = (await (ymd ? pomDay(ymd) : pomToday())).map(pomStop).filter(s => !pomCheckup(s)), techs = [...new Set(stops.map(s => s.tech).filter(Boolean))].map(n => ({ name: n }));
  const m = rampMatch(techs, name) || techs.find(t => { const a = dupeName(t.name).split(' '), b = dupeName(name).split(' ');
    return a[0] && b[0] && a[0].slice(0, 3) === b[0].slice(0, 3) && near(a[a.length - 1], b[b.length - 1]); });
  return { tech: m ? m.name : null, stops: m ? stops.filter(s => s.tech === m.name).sort((x, y) => Date.parse(x.time) - Date.parse(y.time)) : [] };
}


// ---------------- Keep the weekly truck check-up in POM in line with Airtable roles ----------------
// Techs, tech assistants and auditors get a "Truck Check-Up" for "Trucks Submissions" every Monday at 9 AM (New Jersey time).
// Changing someone to another role (or inactive) stops theirs from the next Monday on; past weeks and submissions stay.
// Anyone with no role set is left alone. Field names below are the ones POM's own schedule uses.
const CHK_HOUR = 9;
function nextMonday9(after = new Date()) {   // the first Monday 9:00 AM New Jersey time after `after` (no clock change happens on a Monday morning)
  for (let i = 0; i < 9; i++) { const d = etDay(new Date(+after + i * 864e5)), t = new Date(+d.start + CHK_HOUR * 36e5);
    if (new Date(d.ymd + 'T12:00:00Z').getUTCDay() === 1 && t > after) return t; }
}
const chkRrule = t => { const ymd = etDay(t).ymd.replace(/-/g, ''); return 'DTSTART;TZID=US/Eastern:' + ymd + 'T' + String(CHK_HOUR).padStart(2, '0') + '0000\nRRULE:FREQ=WEEKLY;WKST=MO;BYDAY=MO;BYHOUR=' + CHK_HOUR + ';BYMINUTE=0;BYSECOND=0'; };
const ruleHour = r => { const m = /BYHOUR=(\d+)/.exec(r || ''); return m ? +m[1] : null; };
// POM user ids (a new appointment's workers are users; the ids on existing appointments belong to the appointment's worker links)
let pomUserEmail = true;
const pomUsers = () => cached('pomusers', 3600, async () => { const out = []; let after = null;
  for (let i = 0; i < 20; i++) { let d;
    try { d = await pom('query($a: String) { infiniteUsers(first: 50, after: $a) { edges { node { id firstName lastName isActive' + (pomUserEmail ? ' email' : '') + ' } } pageInfo { endCursor hasNextPage } } }', { a: after }); }
    catch (e) { if (!pomUserEmail) throw e; pomUserEmail = false; console.log('POM users: email not readable with this API key, using Airtable emails'); out.length = 0; after = null; i = -1; continue; }
    const c = d.infiniteUsers || {}; (c.edges || []).forEach(e => e && e.node && out.push(e.node)); if (!c.pageInfo || !c.pageInfo.hasNextPage) break; after = c.pageInfo.endCursor; }
  return out.filter(u => u.isActive !== false).map(u => ({ id: u.id, name: [u.firstName, u.lastName].filter(Boolean).join(' '), email: clean(u.email || '') })); });
async function checkupPlan() {
  if (!clean(process.env.POM_API_KEY)) return { connected: false };
  const now = new Date(), anchor = etDay().end, appts = [];
  for (let w = 0; w < 4; w++) { const end = new Date(+anchor - w * 7 * 864e5), start = new Date(+end - 7 * 864e5 + 1);   // same weeks the check-ups tab reads
    appts.push(...(await cached('pomwk:' + start.toISOString().slice(0, 10), w ? 6 * 3600 : 120, () => pomRange(start, end))).map(pomStop)); }
  const ahead = (await cached('pomahead', 120, () => pomRange(now, new Date(+now + 15 * 864e5)))).map(pomStop);
  const users = await pomUsers().catch(e => { console.error('POM users:', e.message); return null; });
  const userOf = n => users && rampMatch(users, n), workers = {};
  [...appts, ...ahead].forEach(s => { if (s.tech) workers[s.tech] = (userOf(s.tech) || {}).id || null; });
  (users || []).forEach(u => { if (!(u.name in workers)) workers[u.name] = u.id; });
  const chk = [...appts, ...ahead].filter(s => pomCheckup(s)), sample = chk.find(s => s.customerId && s.serviceTypeId);
  const rules = {}; ahead.filter(s => pomCheckup(s) && s.ruleId).sort((a, b) => Date.parse(a.time) - Date.parse(b.time))
    .forEach(s => { if (!rules[s.ruleId]) rules[s.ruleId] = { ruleId: s.ruleId, tech: s.tech, workerId: s.tech ? workers[s.tech] : null, next: s, hour: ruleHour(s.rrule) }; });
  const at = await atData(), people = at.drivers.filter(d => d.name), byTech = {};
  Object.values(rules).forEach(r => { (byTech[r.tech] = byTech[r.tech] || []).push(r); });
  const techNames = Object.keys(workers).map(name => ({ name }));
  const ops = [], start = nextMonday9(now);
  for (const d of people) {
    const needs = d.status !== 'Inactive' && CHECKUP_ROLES.includes(d.role), notNeeded = d.status === 'Inactive' || (d.role && !CHECKUP_ROLES.includes(d.role));
    const m = rampMatch(techNames, d.name), tech = m && m.name, mine = tech ? byTech[tech] || [] : [];
    if (needs && !mine.length) ops.push(tech && workers[tech] ? { op: 'create', key: 'c:' + tech, name: d.name, tech, workerId: workers[tech], role: d.role, when: start }
      : { op: 'none', key: 'n:' + d.name, name: d.name, role: d.role, why: users ? 'Not found in POM. Their name must match a POM user.' : 'POM\u2019s user list could not be read, so the site can\u2019t look them up.' });
    if (notNeeded) mine.forEach(r => ops.push({ op: 'remove', key: 'r:' + r.ruleId, name: d.name, tech, ruleId: r.ruleId, next: r.next.rdate || r.next.time, role: d.status === 'Inactive' ? 'Inactive' : d.role }));
  }
  const removing = new Set(ops.filter(o => o.op === 'remove').map(o => o.ruleId));
  Object.values(rules).filter(r => !removing.has(r.ruleId) && r.hour !== CHK_HOUR).forEach(r => {   // move everyone else's to Monday 9 AM
    const from = [...ahead].filter(s => s.ruleId === r.ruleId && Date.parse(s.time) >= +start - 864e5).sort((a, b) => Date.parse(a.time) - Date.parse(b.time))[0];
    if (from && r.workerId) ops.push({ op: 'move', key: 'm:' + r.ruleId, name: r.tech, tech: r.tech, ruleId: r.ruleId, workerId: r.workerId, from: from.rdate || from.time, hour: r.hour, when: start }); });
  return { connected: true, usersOk: !!users, auto: !!((cache.get('chkAuto') || {}).data || {}).on, customer: sample && sample.customerId, serviceType: sample && sample.serviceTypeId, start, ops };
}
// Same request POM's own Create Appointment form sends for a weekly appointment (copied from the form, Oct 2026)
const POM_RULE_CREATE = 'mutation($data: CreateAppointmentV2Input!) { createAppointmentV2(data: $data) { id date recurringRuleId } }';
const POM_NOT_BILLED = 'cm6g17pzh000d55eg870dfx5p';   // this account's "Not Billed" billing status, as the form sends it
const POM_RULE_STOP = 'mutation($id: ID!, $from: AppointmentIdentifierInput, $all: Boolean) { stopAppointmentRecurringRule(appointmentRecurringRuleId: $id, appointmentIdentifier: $from, applyToSeries: $all) { id endDate } }';
// One-time check-up on a given Monday (9 AM Eastern) for every Tech / Tech assistant / Auditor who doesn't already have one that day.
// dryRun lists who would get one without touching POM.
const etAt = (ymd, h) => { const g = new Date(ymd + 'T' + String(h).padStart(2, '0') + ':00:00Z');
  const off = new Date(g.toLocaleString('en-US', { timeZone: 'America/New_York' })) - new Date(g.toLocaleString('en-US', { timeZone: 'UTC' })); return new Date(+g - off); };
async function oneOffCheckups(b) {
  const ymd = String(b.date || ''); if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) throw new Error('Pick a date.');
  const plan = await checkupPlan(); if (!plan.connected) throw new Error('Pool Office Manager is not connected.');
  if (!plan.customer || !plan.serviceType) throw new Error('Could not find an existing truck check-up in POM to copy the customer and service type from.');
  const when = etAt(ymd, CHK_HOUR), at = await atData(), users = await pomUsers();
  const wk0 = etAt(ymd, 0), day = await pomRange(wk0, new Date(+wk0 + 7 * 864e5 - 1)), has = day.map(pomStop).filter(pomCheckup).map(x => x.tech);   // any check-up that week counts
  const people = at.drivers.filter(d => d.name && d.status !== 'Inactive' && CHECKUP_ROLES.includes(d.role)), out = { date: ymd, create: [], skip: [], done: [], failed: [] };
  for (const d of people) {
    if (has.some(n => sameName(n, d.name) || dupeName(n) === dupeName(d.name))) { out.skip.push({ name: d.name, why: 'already has one that week' }); continue; }
    const u = matchPerson(users, d.name); if (!u) { out.skip.push({ name: d.name, why: 'no POM user' }); continue; }
    out.create.push({ name: d.name, workerId: u.id });
  }
  if (b.dryRun !== false) return out;
  if (b.confirm !== 'CREATE') throw new Error('Confirmation missing.');
  for (const c of out.create) {
    try { await pom(POM_RULE_CREATE, { data: { customer: plan.customer, serviceType: plan.serviceType, color: '#87cbf7', duration: 60, primaryWorker: c.workerId, workers: [c.workerId], inventoryItems: [],
      billingStatus: POM_NOT_BILLED, notes: '', privateNotes: '', customDescription: '', servicePrice: 0, serviceQuantity: 1, date: when.toISOString(), appointmentQueue: null, project: null, priority: 'MEDIUM', linkedServiceId: null } });
      out.done.push(c.name); }
    catch (e) { out.failed.push({ name: c.name, error: e.message }); if (!out.done.length) break; }   // first one fails: stop, nothing half-done
  }
  [...cache.keys()].filter(k => /^pomwk:|^pomahead$|^pomday/.test(k)).forEach(k => cache.delete(k));
  console.log(new Date().toISOString(), 'One-time check-ups for', ymd, '- created:', out.done.join(', ') || 'none', out.failed.length ? '- failed: ' + out.failed.length : '');
  return out;
}
async function applyCheckups(keys) {
  const plan = await checkupPlan(); if (!plan.connected) throw new Error('Pool Office Manager is not connected.');
  if (!plan.customer || !plan.serviceType) throw new Error('Could not find an existing truck check-up in POM to copy the customer and service type from.');
  const todo = plan.ops.filter(o => o.op !== 'none' && (keys === 'all' || keys.includes(o.key))), done = [], failed = [];
  const create = (workerId, when) => pom(POM_RULE_CREATE, { data: { customer: plan.customer, serviceType: plan.serviceType, color: '#87cbf7', duration: 60,
    primaryWorker: workerId, workers: [workerId], inventoryItems: [], billingStatus: POM_NOT_BILLED, notes: '', privateNotes: '', customDescription: '', servicePrice: 0, serviceQuantity: 1,
    date: when.toISOString(), appointmentQueue: null, project: null, priority: 'MEDIUM', linkedServiceId: null,
    recurrence: { rrule: 'FREQ=WEEKLY;WKST=MO;BYDAY=MO;BYHOUR=' + CHK_HOUR + ';BYMINUTE=0;BYSECOND=0', timeZone: 'US/Eastern' } } });
  const stop = (ruleId, from) => pom(POM_RULE_STOP, { id: ruleId, from: { id: null, recurringRuleId: ruleId, recurringDate: from }, all: true });
  for (const o of todo) {
    try {
      if ((o.op === 'create' || o.op === 'move') && !o.workerId) throw new Error('No POM worker on this check-up, so it was left as it is.');
      if (o.op === 'create') await create(o.workerId, new Date(o.when));
      if (o.op === 'remove') await stop(o.ruleId, o.next);
      if (o.op === 'move') { await create(o.workerId, new Date(o.when)); await stop(o.ruleId, o.from); }   // new one first: a failure never leaves someone without a check-up
      done.push(o); console.log(new Date().toISOString(), 'POM check-up', o.op, o.name);
    } catch (e) { failed.push({ ...o, error: e.message }); console.error('POM check-up', o.op, o.name, 'failed:', e.message);
      if (keys === 'all') { failed.push(...todo.slice(todo.indexOf(o) + 1).map(x => ({ ...x, error: 'Not tried: stopped after the first error.' }))); break; } }
  }
  [...cache.keys()].filter(k => /^pom/.test(k)).forEach(k => cache.delete(k));   // re-read POM next time
  return { done, failed };
}
// ---------------- Email: missed truck check-ups, sent from the dashboard ----------------
// Needs SMTP_USER (the sending address) and SMTP_PASS (for Gmail / Google Workspace: an App Password) in Render.
// SMTP_HOST defaults to smtp.gmail.com (port 465, TLS). No passwords in this file.
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com', SMTP_USER = clean(process.env.SMTP_USER || ''), SMTP_PASS = String(process.env.SMTP_PASS || '').replace(/\s+/g, '');
// Outlook / Microsoft 365 (preferred, since Microsoft is turning off password SMTP): an Entra app with the Mail.Send
// application permission. Set MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET and MAIL_FROM (e.g. contact@millennialpools.com).
const MS = { tenant: clean(process.env.MS_TENANT_ID || ''), id: clean(process.env.MS_CLIENT_ID || ''), secret: String(process.env.MS_CLIENT_SECRET || '').trim(), from: clean(process.env.MAIL_FROM || '') };
const msReady = () => !!(MS.tenant && MS.id && MS.secret && MS.from);
let msTok = null, msExp = 0;
async function msLogin() {
    const r = await fetch('https://login.microsoftonline.com/' + encodeURIComponent(MS.tenant) + '/oauth2/v2.0/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: MS.id, client_secret: MS.secret, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }) });
    const j = await r.json().catch(() => ({}));
    if (!j.access_token) throw new Error('Microsoft sign-in failed: ' + (j.error_description || j.error || r.status).toString().split('\r')[0].slice(0, 200));
    msTok = j.access_token; msExp = Date.now() + ((j.expires_in || 3600) - 300) * 1000;
}
async function graphSend(to, subject, text, files) {
  if (!msTok || Date.now() > msExp) await msLogin();
  const r = await fetch('https://graph.microsoft.com/v1.0/users/' + encodeURIComponent(MS.from) + '/sendMail', { method: 'POST', headers: { Authorization: 'Bearer ' + msTok, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { subject, body: { contentType: 'Text', content: text }, toRecipients: [{ emailAddress: { address: to } }],
      ...(files && files.length ? { attachments: files.map(f => ({ '@odata.type': '#microsoft.graph.fileAttachment', name: f.name, contentType: f.type || 'application/octet-stream', contentBytes: f.data })) } : {}) }, saveToSentItems: true }) });
  if (r.status === 401 || r.status === 403) msTok = null;   // new sign-in next time, so a just-granted permission is picked up
  if (!r.ok) { const t = await r.text(); throw new Error('Outlook would not send (' + r.status + '): ' + (/Authorization_RequestDenied|ErrorAccessDenied|403/.test(t + r.status) ? 'the app needs the Mail.Send application permission with admin consent.' : t.slice(0, 200))); }
}
const mailFrom = () => msReady() ? MS.from : SMTP_USER;
const mailReady = () => msReady() || !!(SMTP_USER && SMTP_PASS);
function sendMail(to, subject, text, files) { return msReady() ? graphSend(to, subject, text, files) : smtpSend(to, subject, text); }   // attachments: Outlook only
function smtpSend(to, subject, text) {
  if (!mailReady()) return Promise.reject(new Error('Email is not set up yet: add the Outlook settings (MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, MAIL_FROM) in Render.'));
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(to)) return Promise.reject(new Error('Bad email address: ' + to));
  const b64 = v => Buffer.from(v, 'utf8').toString('base64'), hdr = v => /^[\x20-\x7e]*$/.test(v) ? v : '=?UTF-8?B?' + b64(v) + '?=';
  const msg = ['From: ' + hdr('Millennial Pools Fleet') + ' <' + SMTP_USER + '>', 'To: <' + to + '>', 'Subject: ' + hdr(subject), 'Date: ' + new Date().toUTCString(),
    'Message-ID: <' + Date.now() + '.' + Math.random().toString(36).slice(2) + '@fleet-dashboard>', 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '',
    b64(text.replace(/\r?\n/g, '\r\n')).replace(/.{76}/g, '$&\r\n')].join('\r\n');
  const steps = [[220], ['EHLO fleet-dashboard', 250], ['AUTH LOGIN', 334], [b64(SMTP_USER), 334], [b64(SMTP_PASS), 235], ['MAIL FROM:<' + SMTP_USER + '>', 250], ['RCPT TO:<' + to + '>', 250], ['DATA', 354], [msg + '\r\n.', 250], ['QUIT', 221]];
  return new Promise((ok, no) => {
    const s = require('tls').connect(465, SMTP_HOST, { servername: SMTP_HOST }); let buf = '', i = 0, done = false;
    const fail = e => { if (done) return; done = true; s.destroy(); no(e); };
    s.setTimeout(20000, () => fail(new Error('Email server did not answer.')));
    s.on('error', e => fail(new Error('Email server: ' + e.message)));
    s.on('data', d => { buf += d; const lines = buf.split('\r\n'); buf = lines.pop();
      for (const l of lines) { if (!/^\d{3} /.test(l)) continue;   // wait for the last line of a multi-line reply
        const code = +l.slice(0, 3), want = steps[i][steps[i].length - 1];
        if (code !== want) return fail(new Error(i === 4 ? 'The email login was refused. Check SMTP_USER and SMTP_PASS (use a Gmail App Password).' : 'Email server said: ' + l));
        if (++i >= steps.length) { done = true; s.end(); return ok(); }
        s.write(steps[i][0] + '\r\n'); } });
  });
}
const swapLog = () => (cache.get('swaps') || {}).data || [];   // truck sticker sign-ins, newest first
const swapReqs = () => (cache.get('swapReq') || {}).data || [];   // sign-in requests waiting for the office
const saveReqs = l => { cache.set('swapReq', { data: l, t: Date.now() }); saveSnap('swapReq', l); };
const mailState = () => (cache.get('mail') || {}).data || { auto: false, week: '', sent: [] };
const saveMail = d => { cache.set('mail', { data: d, t: Date.now() }); saveSnap('mail', d); };
// Reminder times (Eastern): Mon-Wed at noon, Thu-Sun at 9 AM and 3 PM. Each run emails everyone who still hasn't
// submitted this week's check-up; it stops for a person once they submit. Only the latest due time runs, once.
// Bounces: Outlook drops an "Undeliverable" notice in contact@'s inbox. Those addresses are never emailed again.
// Reading the inbox needs the Mail.Read application permission (with admin consent) on the same Entra app.
async function checkBounces(st) {
  st.bounced = st.bounced || [];
  if (!msReady()) return st.bounced;
  try {
    if (!msTok || Date.now() > msExp) await msLogin();
    const r = await fetch('https://graph.microsoft.com/v1.0/users/' + encodeURIComponent(MS.from) + "/messages?$search=%22subject:Undeliverable%22&$select=subject,bodyPreview&$top=100", { headers: { Authorization: 'Bearer ' + msTok } });
    if (!r.ok) { if (r.status === 401 || r.status === 403) msTok = null; st.bounceErr = r.status === 403 ? 'Add the Mail.Read application permission so bounced emails are caught.' : 'Could not check for bounces (' + r.status + ').'; return st.bounced; }
    st.bounceErr = '';
    for (const m of (await r.json()).value || []) {
      if (!/check-up missed/i.test(m.subject || '')) continue;
      const a = ((m.bodyPreview || '').match(/message to (\S+@\S+?) (?:couldn|could not|wasn)/i) || [])[1];
      if (a && !st.bounced.includes(a.toLowerCase())) { st.bounced.push(a.toLowerCase()); console.log(new Date().toISOString(), 'Bounced, will not email again:', a); }
    }
  } catch (e) { console.error('Bounce check:', e.message); }
  return st.bounced;
}
// ---- Texts (Textedly). Key in Render as TEXTEDLY_API_KEY. Check-up reminder texts go once a day per person (the Bronze plan has 1,000 texts a month).
const TXT_KEY = () => clean(process.env.TEXTEDLY_API_KEY), TXT_BASE = clean(process.env.TEXTEDLY_BASE) || 'https://application.textedly.com/api-v2/v1';
const TXT_FROM = () => '+1' + (clean(process.env.TEXTEDLY_FROM) || '8777939510').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');   // the account's main number in Textedly
async function sendText(to, message) {
  if (!TXT_KEY()) throw new Error('Add TEXTEDLY_API_KEY in Render first.');
  if (!/^\+1\d{10}$/.test(to)) throw new Error('Not a US mobile number: ' + to);
  const r = await fetch(TXT_BASE + '/messages', { method: 'POST', headers: { Authorization: 'Bearer ' + TXT_KEY(), 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ to, from: TXT_FROM(), message: message.slice(0, 600) }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Textedly ' + r.status + ': ' + String(j.message || j.error || j.detail || JSON.stringify(j)).slice(0, 200));
  return j;
}
async function textMissed(force) {   // one text per person per day, the first reminder slot of the day
  const st = mailState(), day = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }), sent = [], failed = [];
  st.texted = st.texted && st.texted.day === day ? st.texted : { day, names: [] };
  for (const t of (await routes['/api/texts/missed-checkups']()).texts || []) {
    if (!t.phone || st.texted.names.includes(t.name)) continue;
    try { await sendText(t.phone, t.message); st.texted.names.push(t.name); sent.push(t.name); console.log(new Date().toISOString(), 'Check-up text sent to', t.name); }
    catch (e) { failed.push({ name: t.name, error: e.message }); console.error('Check-up text to', t.name, 'failed:', e.message); }
    await sleep(200);
  }
  saveMail(st); return { sent, failed };
}
async function textTest() {
  const at = await atData(), d = at.drivers.find(x => dupeName(x.name) === dupeName('Callum Curcie')), ph = String((d && d.phone) || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  if (ph.length !== 10) throw new Error('No phone number for Callum Curcie in the Drivers table in Airtable.');
  await sendText('+1' + ph, 'Test from the Millennial Pools fleet dashboard. Check-up reminder texts are working.');
  return { to: '(***) ***-' + ph.slice(-4) };
}
// ---- Service report reminder: after a tech's truck leaves a pool (Azuga GPS) and the POM service still isn't completed, email them once
const SVC_WAIT_MIN = +process.env.SVC_REMINDER_MIN || 20;   // minutes after leaving before the reminder goes out
const svcText = (tech, s) => { const first = tech.split(' ')[0], t = new Date(s.visit.leave).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
  return { subject: 'Submit your POM report: ' + (s.customer || 'pool') + ' (left ' + t + ')',
    body: 'Hi ' + first + ',\n\nYou left ' + (s.customer || 'a pool') + (s.address ? ' (' + s.address + ')' : '') + ' at ' + t + ", but the service hasn't been submitted in Pool Office Manager yet.\n\nPlease open the POM app and complete it now while it's fresh.\n\nThanks,\nMillennial Pools" }; };
async function svcCheck(dry) {
  const st = mailState(), day = etDay().ymd, sv = st.svc = st.svc && st.svc.day === day ? { ...st.svc } : { on: !!(st.svc && st.svc.on), day, sent: {} }, out = [];
  if (!dry && (!sv.on || !mailReady())) return out;
  const stops = (await pomToday()).map(pomStop).filter(x => !pomCheckup(x) && x.tech), techs = [...new Set(stops.filter(x => !x.done).map(x => x.tech))];
  const at = await atData().catch(() => ({ drivers: [] })), users = await pomUsers().catch(() => []), bad = (st.bounced || []);
  for (const tech of techs) {
    const v = await visitsFor(tech, day).catch(() => null); if (!v || !v.trucks || !v.trucks.length) continue;
    const d = matchPerson(at.drivers.filter(x => x.status !== 'Inactive'), tech), u = matchPerson(users, tech), email = (d && d.email) || (u && u.email) || '';
    for (const s of v.stops) {
      if (s.done || !s.visit || !s.visit.away || sv.sent[s.id] || Date.now() - s.visit.leave < SVC_WAIT_MIN * 6e4 || Date.now() - s.visit.leave > 4 * 3600e3) continue;
      out.push({ tech, email, customer: s.customer, left: s.visit.leave, id: s.id });
      if (dry || !email || bad.includes(email.toLowerCase())) continue;
      const m = svcText(tech, s);
      try { await sendMail(email, m.subject, m.body); sv.sent[s.id] = Date.now(); console.log(new Date().toISOString(), 'Service report reminder sent to', tech, 'for', s.customer); }
      catch (e) { console.error('Service reminder to', tech, 'failed:', e.message); }
    }
    await sleep(500);
  }
  if (!dry) saveMail(st);
  return out;
}
if (process.argv[2] !== 'test') setInterval(() => { const h = +new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }); if (h >= 7 && h < 21) svcCheck().catch(e => console.error('Service reminders:', e.message)); }, 15 * 60e3);
async function svcTest() {
  const at = await atData(), me = at.drivers.find(d => dupeName(d.name) === dupeName('Callum Curcie')), to = (me && me.email) || 'callum@millennialpools.com', list = await svcCheck(true), x = list[0];
  const m = x ? svcText(x.tech, { customer: x.customer, address: '', visit: { leave: x.left } }) : svcText('Callum Curcie', { customer: 'Sunset Village Pool', address: '1 Main St, Williamstown, NJ', visit: { leave: Date.now() - 25 * 6e4 } });
  await sendMail(to, 'SAMPLE · ' + m.subject, m.body + '\n\n(Sample. ' + (list.length ? list.length + ' tech' + (list.length > 1 ? 's' : '') + ' would get one right now: ' + list.map(y => y.tech + ' (' + y.customer + ')').join(', ') : 'Nobody would get one right now.') + ')');
  return { to, waiting: list.map(y => ({ tech: y.tech, customer: y.customer, email: !!y.email })) };
}
// ---- End of day: each tech with services still not submitted in POM today gets one email listing them
const EOD_HOUR = +process.env.EOD_REMINDER_HOUR || 18;   // 6 PM New Jersey time
async function eodCheck(dry) {
  const st = mailState(), day = etDay().ymd, out = [];
  st.eod = st.eod && typeof st.eod === 'object' ? st.eod : { on: false };
  if (!dry && (!st.eod.on || !mailReady() || st.eod.day === day)) return out;
  const stops = (await pomToday()).map(pomStop).filter(x => !pomCheckup(x) && x.tech && !x.done && Date.parse(x.time) < Date.now());
  const at = await atData().catch(() => ({ drivers: [] })), users = await pomUsers().catch(() => []), bad = st.bounced || [];
  const tm = t => new Date(t).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
  for (const tech of [...new Set(stops.map(x => x.tech))]) {
    const mine = stops.filter(x => x.tech === tech), v = await visitsFor(tech, day).catch(() => null), vis = Object.fromEntries(((v && v.stops) || []).map(x => [x.id, x.visit]));
    const d = matchPerson(at.drivers.filter(x => x.status !== 'Inactive'), tech), u = matchPerson(users, tech), email = (d && d.email) || (u && u.email) || '';
    const lines = mine.map(x => { const w = vis[x.id]; return '• ' + (x.customer || 'Pool') + (x.address ? ', ' + x.address : '') + (w ? '  (you were there ' + tm(w.arrive) + '–' + tm(w.leave) + ')' : ''); });
    const first = tech.split(' ')[0], n = mine.length;
    out.push({ tech, email, n, subject: n + ' POM service' + (n > 1 ? 's' : '') + ' not submitted today', body: 'Hi ' + first + ',\n\nThese services from today still haven\'t been submitted in Pool Office Manager:\n\n' + lines.join('\n') + '\n\nPlease open the POM app and complete ' + (n > 1 ? 'them' : 'it') + ' tonight. If you didn\'t get to a pool, let your regional know.\n\nThanks,\nMillennial Pools' });
    await sleep(300);
  }
  if (dry) return out;
  for (const m of out) { if (!m.email || bad.includes(m.email.toLowerCase())) continue;
    try { await sendMail(m.email, m.subject, m.body); console.log(new Date().toISOString(), 'End-of-day POM email sent to', m.tech, '(' + m.n + ')'); } catch (e) { console.error('End-of-day email to', m.tech, 'failed:', e.message); } }
  st.eod.day = day; st.eod.sent = out.filter(m => m.email).map(m => m.tech); saveMail(st);
  return out;
}
if (process.argv[2] !== 'test') setInterval(() => { const h = +new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }); if (h >= EOD_HOUR && h < 23) eodCheck().catch(e => console.error('End-of-day POM emails:', e.message)); }, 10 * 60e3);
async function eodTest() {
  const at = await atData(), me = at.drivers.find(d => dupeName(d.name) === dupeName('Callum Curcie')), to = (me && me.email) || 'callum@millennialpools.com', list = await eodCheck(true);
  const m = list[0] || { subject: '2 POM services not submitted today', body: 'Hi Callum,\n\nThese services from today still haven\'t been submitted in Pool Office Manager:\n\n• Sunset Village Pool, 1 Main St  (you were there 1:10 PM–1:42 PM)\n• Oak Ridge HOA, 2 Oak Ave\n\nPlease open the POM app and complete them tonight.\n\nThanks,\nMillennial Pools' };
  await sendMail(to, 'SAMPLE · ' + m.subject, m.body + '\n\n(Sample' + (list[0] ? ' of ' + list[0].tech + '’s email' : '') + '. Right now ' + (list.length ? list.length + ' tech' + (list.length > 1 ? 's' : '') + ' have unsubmitted services: ' + list.map(x => x.tech + ' (' + x.n + ')').join(', ') : 'nobody has unsubmitted services') + '.)');
  return { to, waiting: list.map(x => ({ tech: x.tech, n: x.n, email: !!x.email })) };
}
const MAIL_SLOTS = d => d >= 1 && d <= 3 ? [12] : [9, 15];
async function autoMail() {
  const st = mailState(); if (!(st.auto && mailReady()) && !(st.sms && TXT_KEY())) return;
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })), wd = et.getDay(), h = et.getHours();
  const due = MAIL_SLOTS(wd).filter(x => x <= h).pop(); if (due == null) return;
  const mon = new Date(et); mon.setDate(mon.getDate() - ((wd + 6) % 7)); const week = mon.toLocaleDateString('en-CA');
  const slot = et.toLocaleDateString('en-CA') + ' ' + due;
  if (st.week !== week) { st.week = week; st.sent = []; st.slots = {}; }
  st.slots = st.slots || {}; if (st.slots[slot]) return;
  if (st.auto && mailReady()) try { const r = await routes['/api/texts/missed-checkups'](), done = [], bad = await checkBounces(st);
    for (const t of r.texts || []) { if (!t.email || bad.includes(t.email.toLowerCase())) continue;
      try { await sendMail(t.email, t.subject, t.body); done.push(t.name); if (!st.sent.includes(t.name)) st.sent.push(t.name); console.log(new Date().toISOString(), 'Check-up email sent to', t.name); }
      catch (e) { console.error('Check-up email to', t.name, 'failed:', e.message); } }
    st.slots[slot] = done; saveMail(st);
  } catch (e) { console.error('Check-up emails:', e.message); }
  if (st.sms && TXT_KEY()) { await textMissed().catch(e => console.error('Check-up texts:', e.message)); const m = mailState(); m.slots = m.slots || {}; m.slots[slot] = m.slots[slot] || []; saveMail(m); }
}
// Send a round right now (button on the Check-ups tab), counted as the current reminder time
async function mailNow() {
  if (!mailReady()) throw new Error('Email is not set up yet.');
  const r = await routes['/api/texts/missed-checkups'](), st = mailState(), sent = [], failed = [], bad = await checkBounces(st);
  for (const t of r.texts || []) { if (!t.email) continue;
    if (bad.includes(t.email.toLowerCase())) { failed.push({ name: t.name, error: 'email bounced before, not sent' }); continue; }
    try { await sendMail(t.email, t.subject, t.body); sent.push(t.name); } catch (e) { failed.push({ name: t.name, error: e.message }); } }
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })), mon = new Date(et); mon.setDate(mon.getDate() - ((et.getDay() + 6) % 7));
  const week = mon.toLocaleDateString('en-CA'); if (st.week !== week) { st.week = week; st.sent = []; st.slots = {}; }
  sent.forEach(n => { if (!st.sent.includes(n)) st.sent.push(n); });
  const due = MAIL_SLOTS(et.getDay()).filter(x => x <= et.getHours()).pop(); if (due != null) { st.slots = st.slots || {}; st.slots[et.toLocaleDateString('en-CA') + ' ' + due] = sent; }
  saveMail(st); console.log(new Date().toISOString(), 'Check-up emails sent now:', sent.join(', ') || 'none');
  return { sent, failed, noEmail: (r.texts || []).filter(t => !t.email).map(t => t.name) };
}
if (process.argv[2] !== 'test') setInterval(autoMail, 10 * 60e3);
async function mailTest() {
  const at = await atData(), d = at.drivers.find(x => dupeName(x.name) === dupeName('Callum Curcie'));
  const users = d && d.email ? [] : await pomUsers().catch(() => []), u = users.find(x => dupeName(x.name) === dupeName('Callum Curcie'));
  const me = { email: (d && d.email) || (u && u.email) || '' };
  if (!me.email) throw new Error('Could not find an email for Callum Curcie (Drivers table in Airtable).');
  const monday = new Date(); monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const day = monday.toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'long', month: 'short', day: 'numeric' });
  await sendMail(me.email, 'TEST · Truck check-up missed: ' + day + '. Please submit today', 'Hi Callum,\n\nYour weekly truck check-up for ' + day + " hasn't been submitted in Pool Office Manager yet. Please open the POM app and complete your Truck Check-Up as soon as possible.\n\nNot submitting your truck check-up can hurt your bonus for the week.\n\nYou'll keep getting this reminder until it's submitted.\n\nThanks,\nMillennial Pools\n\n(This is a test from the fleet dashboard. The real emails go to each tech who misses their check-up.)");
  console.log(new Date().toISOString(), 'Test check-up email sent to Callum');
  return { ok: true, to: me.email };
}
async function autoCheckups() { if (!((cache.get('chkAuto') || {}).data || {}).on) return; try { const r = await applyCheckups('all'); if (r.done.length || r.failed.length) console.log('Check-up sync:', r.done.length, 'done,', r.failed.length, 'failed'); } catch (e) { console.error('Check-up sync failed:', e.message); } }
if (process.argv[2] !== 'test') setInterval(autoCheckups, 60 * 60e3);

// ---------------- Ramp: each driver's card spend over the last 30 days ----------------
// Needs RAMP_CLIENT_ID / RAMP_CLIENT_SECRET (a Ramp developer app with transactions:read, reimbursements:read, users:read) in Render.
const { RAMP_CLIENT_ID, RAMP_CLIENT_SECRET } = process.env;
let rampTok, rampExp = 0, rampScopes = '';
// Asks for all three permissions; if the Ramp app wasn't given one, falls back to fewer so the box still works.
const RAMP_SCOPES = ['transactions:read reimbursements:read users:read receipts:read', 'transactions:read reimbursements:read users:read', 'transactions:read reimbursements:read', 'transactions:read'];
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
// Ramp card payments to mechanics, tire and tow shops (or with a truck-repair memo), for the Repairs tab.
// Car washes and tire air don't count. Truck: from the memo ("truck 1", "#13") or else the cardholder's own truck in Airtable.
const REPAIR_MCC = new Set(['7538', '7531', '7549', '5532', '7534', '7535', '5533']);
const REPAIR_WORDS = /\b(truck|vehicle|oil change|brakes?|tires?|tow(ing)?|mechanic|alignment|transmission|inspection|battery|muffler|exhaust|radiator|alternator|starter)\b/i;
const AUTO_SHOP = /auto|repair|motor|tire|lube|valvoline|vioc|jiffy|midas|meineke|pep boys|firestone|goodyear|towing|transmission|brake|muffler/i;
const rampRepairs = () => cached('rampRepairs', 3600, async () => {
  const since = new Date(Date.now() - 400 * 864e5), at = await atData(), out = [];
  const money = a => typeof a === 'number' ? a : Number(a && a.amount) / 100 || 0;
  const drivers = at.trucks.filter(t => t.driver && !['District', 'Regional', 'Owner', 'Staffer'].includes(t.driver.role)).map(t => ({ name: t.driver.name, t }));
  const truckFor = (memo, who) => { const m = /\btruck\s*#?\s*(\d{1,2})\b|#\s?(\d{1,2})\b/i.exec(memo || '');
    if (m) { const n = m[1] || m[2], t = at.trucks.find(x => parseInt(x.truckNo) === +n); if (t) return { truckId: t.id, how: 'memo' }; }
    const d = who && matchPerson(drivers, who); return d ? { truckId: d.t.id, how: 'driver' } : { truckId: null, how: '' }; };
  for (const t of await rampAll('transactions', { from_date: since.toISOString() })) {
    if (/DECLINED|ERROR/i.test(t.state || '')) continue;
    const merchant = clean(t.merchant_name || (t.merchant_descriptor || '')), memo = clean(t.memo || ''), amt = money(t.amount), cat = String(t.sk_category_name || '');
    const mcc = String(t.merchant_category_code || (t.merchant_data && t.merchant_data.mcc) || '');
    const carSvc = /car service|automotive|auto repair/i.test(cat) || REPAIR_MCC.has(mcc);
    if (!(amt >= 10) || !(carSvc || (REPAIR_WORDS.test(memo) && AUTO_SHOP.test(merchant)))) continue;
    if (/wash/i.test(merchant + ' ' + memo) && !/oil|repair|brake|tire|service/i.test(memo)) continue;
    if (/anti-?\s?freeze/i.test(merchant + ' ' + memo) && !/truck|vehicle|van|car\b|ranger|maverick|colorado|silverado|canyon|frontier|f-?150/i.test(memo)) continue;   // pool antifreeze
    const h = t.card_holder || {}, who = [h.first_name, h.last_name].filter(Boolean).join(' ');
    out.push({ id: t.id, date: (t.user_transaction_time || t.settlement_date || '').slice(0, 10), amount: amt, merchant, memo, who, ...truckFor(memo, who),
      link: 'https://app.ramp.com/business-overview/transactions/' + t.id });
  }
  return out;
});
// ---------------- Purchases: hardware-store receipts from Ramp, read line by line ----------------
// Each receipt on a Home Depot / Lowe's / Harbor Freight / Amazon... card purchase is read once by Claude
// (ANTHROPIC_API_KEY in Render; the Ramp app needs receipts:read). Every line becomes a row in Airtable's
// "Ramp items" table with a link to the item and a Status (Out / Returned / Used up) for season-end returns.
const AT_ITEMS = 'tbl6f6FmKPRdie2uK', IT = { item: 'fldfmOGrz3tAqyezP', txn: 'fldXZEoseMTikTgag', date: 'fld2WjFbXDZhqOBda', store: 'fldHsRbMDA1cR2bkp', person: 'fldwyvwcJAb8F0iGw',
  memo: 'fldPRjPJD6cvCmvGp', sku: 'fldJrAoNyn1x1b6OM', qty: 'fldV9CKeJD8cH3G7F', price: 'fldbu8c7CM3UAOCbF', link: 'fldf5PvAkxMQh33f3', ramp: 'fld9AX1cKax6Ol5Na', status: 'fldKj2OZkOHoPF9qF', notes: 'fldO2GBAIjZlFhnqo' };
const HW_STORE = /home ?depot|lowe'?s|harbor ?freight|amazon|amzn|tractor supply|\bace\b|menards|northern tool|grainger|true value|leslie'?s|pinch a penny|sherwin|walmart|target|costco|sam'?s club|staples|best buy|autozone|advance auto|o'?reilly|napa/i;
const ITEMS_SINCE = process.env.ITEMS_SINCE || '2026-03-01';
const AI_KEY = () => clean(process.env.ANTHROPIC_API_KEY || ''), AI_MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5';
// Product link for a receipt line. Checked on homedepot.com: a real barcode (UPC/EAN with a valid check digit),
// internet # or store SKU opens the exact product page; a misread barcode finds 0 results and receipt abbreviations
// ("2PC PLI MIL") find junk. So: good barcode/item # -> search by it; else the item name; abbreviations -> Google.
const gtinOk = c => { if (!/^(\d{8}|\d{12,14})$/.test(c)) return false;   // barcode check digit
  const d = c.split('').reverse().map(Number), sum = d.slice(1).reduce((t, x, i) => t + x * (i % 2 ? 1 : 3), 0); return (10 - sum % 10) % 10 === d[0]; };
const itemLink = (store, sku, name) => {
  const st = String(store || ''), c = String(sku || '').replace(/[\s-]/g, ''), n = clean(name).replace(/\(.*?\)/g, '').replace(/^Home Depot item \d+$/, '').trim();
  const code = gtinOk(c) ? c : '', cryptic = !n || !/\s/.test(n) || n === n.toUpperCase() && n.replace(/[^A-Z]/g, '').length < n.length * 0.6 || /^[A-Z0-9 /#"'.\-]+$/.test(n) && n.split(/\s+/).every(w => w.length <= 5);
  const q = encodeURIComponent(n), g = 'https://www.google.com/search?q=' + encodeURIComponent(st + ' ' + (n || '') + (c ? ' ' + c : ''));
  if (/amazon|amzn/i.test(st)) return /^B0[A-Z0-9]{8}$/.test(sku || '') ? 'https://www.amazon.com/dp/' + sku : 'https://www.amazon.com/s?k=' + q;
  if (/home ?depot/i.test(st)) return code || /^(\d{6}|[1-3]\d{8,9})$/.test(c) ? 'https://www.homedepot.com/s/' + (code || c) : cryptic ? g : 'https://www.homedepot.com/s/' + q;
  if (/lowe/i.test(st)) return /^\d{4,7}$/.test(c) || code ? 'https://www.lowes.com/search?searchTerm=' + (code || c) : cryptic ? g : 'https://www.lowes.com/search?searchTerm=' + q;
  if (/harbor/i.test(st)) return /^\d{5}$/.test(c) ? 'https://www.harborfreight.com/search?q=' + c : 'https://www.harborfreight.com/search?q=' + q;
  if (/walmart/i.test(st)) return code ? 'https://www.walmart.com/search?q=' + code : cryptic ? g : 'https://www.walmart.com/search?q=' + q;
  if (/tractor/i.test(st)) return cryptic ? g : 'https://www.tractorsupply.com/tsc/search/' + q;
  return cryptic || !n ? g : 'https://www.google.com/search?q=' + encodeURIComponent(st + ' ' + n);
};
const itemsState = () => (cache.get('rampItems') || {}).data || { done: {} };
const saveItemsState = d => { cache.set('rampItems', { data: d, t: Date.now() }); saveSnap('rampItems', d); };
const hwPurchases = () => cached('hwTx', 1800, async () => {
  const money = a => typeof a === 'number' ? a : Number(a && a.amount) / 100 || 0;
  return (await rampAll('transactions', { from_date: new Date(ITEMS_SINCE).toISOString() })).filter(t => !/DECLINED|ERROR/i.test(t.state || '') && HW_STORE.test(t.merchant_name || t.merchant_descriptor || ''))
    .map(t => { const h = t.card_holder || {}; return { id: t.id, date: (t.user_transaction_time || t.settlement_date || '').slice(0, 10), store: clean(t.merchant_name || t.merchant_descriptor),
      who: [h.first_name, h.last_name].filter(Boolean).join(' '), memo: clean(t.memo || ''), amount: money(t.amount), receipts: t.receipts || [], link: 'https://app.ramp.com/business-overview/transactions/' + t.id }; });
});
async function readReceipt(id, gas) {
  const r = await ramp('https://api.ramp.com/developer/v1/receipts/' + encodeURIComponent(id));
  if (!r.receipt_url) throw new Error('Ramp gave no file for receipt ' + id);
  const f = await fetch(r.receipt_url); if (!f.ok) throw new Error('Receipt download ' + f.status);
  let type = (f.headers.get('content-type') || '').split(';')[0].toLowerCase(); const buf = Buffer.from(await f.arrayBuffer());
  if (!/^image\/(jpeg|png|gif|webp)$|^application\/pdf$/.test(type)) type = buf.slice(0, 4).toString() === '%PDF' ? 'application/pdf' : buf[0] === 0x89 ? 'image/png' : buf[0] === 0xff ? 'image/jpeg' : type;
  if (!/^image\/(jpeg|png|gif|webp)$|^application\/pdf$/.test(type)) throw new Error('Receipt file type ' + (type || 'unknown') + ' cannot be read');
  const part = { type: type === 'application/pdf' ? 'document' : 'image', source: { type: 'base64', media_type: type, data: buf.toString('base64') } };
  const a = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': AI_KEY(), 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: AI_MODEL, max_tokens: 2500, messages: [{ role: 'user', content: [part, { type: 'text', text:
      gas ? 'This is a gas station / fuel receipt. Reply with JSON only, no other text: {"gallons":0.000,"price_per_gallon":0.000,"grade":"regular|plus|premium|diesel|"}. Use 0 or "" for anything not printed.' : 'This is a store receipt or order confirmation. List every item bought. Reply with JSON only, no other text: {"store":"store name","items":[{"name":"brand and product spelled out the way a shopper would search for it, e.g. Husky 16 in. Groove Pliers, not the receipt abbreviation","sku":"the store SKU / item number / model number / Amazon ASIN printed for that line, else empty","qty":1,"price":0.00}]}. price is the line total in dollars. Leave out tax, subtotals, totals, discounts, bag fees, rewards and payment lines. If it is not a receipt, reply {"store":"","items":[]}.' }] }] }) });
  const j = await a.json().catch(() => ({}));
  if (!a.ok) { const e = new Error('Claude ' + a.status + ': ' + String((j.error && j.error.message) || '').slice(0, 160)); e.fatal = a.status === 401 || a.status === 403 || a.status === 400 && /credit|billing/i.test(e.message); throw e; }
  const txt = ((j.content || []).find(c => c.type === 'text') || {}).text || '', m = txt.match(/\{[\s\S]*\}/);
  const out = m ? JSON.parse(m[0]) : { items: [] };
  if (gas) return [Math.round((+out.gallons || 0) * 1000) / 1000, Math.round((+out.price_per_gallon || 0) * 1000) / 1000, String(out.grade || '').toLowerCase().slice(0, 1)];
  return (out.items || []).filter(x => x && x.name).slice(0, 80).map(x => ({ name: clean(x.name).slice(0, 200), sku: clean(x.sku).replace(/\s+/g, '').slice(0, 40), qty: Math.max(1, Math.round(+x.qty || 1)), price: Math.round((+x.price || 0) * 100) / 100 }));
}
async function saveItems(t, lines, st) {
  const recs = lines.map(x => ({ fields: { [IT.item]: x.name, [IT.txn]: t.id, [IT.date]: t.date || null, [IT.store]: t.store, [IT.person]: t.who, [IT.memo]: t.memo, [IT.sku]: x.sku,
    [IT.qty]: x.qty, [IT.price]: x.price, [IT.link]: itemLink(t.store, x.sku, x.name), [IT.ramp]: t.link, [IT.status]: 'Out' } }));
  for (let i = 0; i < recs.length; i += 10) await airtable(AT_ITEMS, { method: 'POST', body: JSON.stringify({ records: recs.slice(i, i + 10), typecast: true }) });
  st.done[t.id] = recs.length || 'none'; return recs.length;
}
// Reading by hand (until ANTHROPIC_API_KEY is set): /receipts shows the waiting receipts, and the items read
// from them are saved with POST /api/purchase/items (or /api/purchase/gas for fuel receipts).
async function saveItemsByHand(b) {
  const t = (await hwPurchases()).find(x => x.id === String(b.txn || ''));
  if (!t) throw new Error('Not a hardware-store purchase: ' + b.txn);
  const st = itemsState(); if (st.done[t.id] && !b.again) throw new Error('This receipt was already read.');
  const lines = (Array.isArray(b.items) ? b.items : []).filter(x => x && x.name).slice(0, 80).map(x => ({ name: clean(x.name).slice(0, 200), sku: clean(x.sku || '').replace(/\s+/g, '').slice(0, 40), qty: Math.max(1, Math.round(+x.qty || 1)), price: Math.round((+x.price || 0) * 100) / 100 }));
  const n = await saveItems(t, lines, st); saveItemsState(st); cache.delete('itemsAT');
  console.log(new Date().toISOString(), 'Receipt read by hand:', t.store, t.date, t.who, n, 'items'); return { ok: true, n };
}
async function saveGasByHand(b) {
  const t = (await rampYear()).card.find(x => x.id === String(b.txn || '') && x.gas); if (!t) throw new Error('Not a gas purchase: ' + b.txn);
  const gx = gasRx(); gx[t.id.slice(0, 10)] = [Math.round((+b.gal || 0) * 1000) / 1000, Math.round((+b.ppg || 0) * 1000) / 1000, String(b.grade || '').toLowerCase().slice(0, 1)];
  cache.set('gasRx', { data: gx, t: Date.now() }); saveSnap('gasRx', gx); cache.delete('rampOv'); return { ok: true };
}
async function receiptFile(id, res) {
  if (!/^[0-9a-f-]{36}$/i.test(id || '')) { res.writeHead(400); return res.end(); }
  try { const r = await ramp('https://api.ramp.com/developer/v1/receipts/' + id), f = await fetch(r.receipt_url);
    res.writeHead(f.status, { 'Content-Type': f.headers.get('content-type') || 'application/octet-stream', 'Cache-Control': 'private, max-age=3600' }); res.end(Buffer.from(await f.arrayBuffer())); }
  catch (e) { res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end(e.message); }
}
async function receiptsPage(gas) {
  const h = v => String(v ?? '').replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';');
  const st = itemsState(), gx = gasRx();
  const list = gas ? (await rampYear()).card.filter(t => t.gas && t.receipts.length && !(t.id.slice(0, 10) in gx)).map(t => ({ ...t, date: t.at.slice(0, 10), store: t.merchant }))
    : (await hwPurchases()).filter(t => t.receipts.length && !st.done[t.id]);
  const show = list.slice(0, 8);
  return '<!doctype html><html><head><meta charset="utf-8"><title>Receipts to read</title><style>body{font-family:system-ui,Arial,sans-serif;background:#f1f5f9;margin:0;padding:16px}h1{font-size:18px;margin:0 0 12px}.r{background:#fff;border-radius:12px;padding:12px;margin-bottom:16px}.r b{font-size:15px}.r code{font-size:12px;color:#475569}.r img,.r object{display:block;max-width:900px;width:100%;margin-top:8px;border:1px solid #e2e8f0}</style></head><body>'
    + '<h1>' + list.length + ' ' + (gas ? 'gas' : 'hardware-store') + ' receipts waiting · showing ' + show.length + '</h1>'
    + show.map(t => '<div class="r" data-txn="' + h(t.id) + '"><b>' + h(t.store) + ' · ' + h(t.who) + ' · ' + h(t.date) + ' · ' + '$' + (+t.amount || 0).toFixed(2) + '</b><br><code>' + h(t.id) + '</code>' + (t.memo ? '<div>' + h(t.memo) + '</div>' : '')
      + t.receipts.slice(0, 3).map(r => '<object data="/api/purchase/receipt?id=' + h(r) + '"><img src="/api/purchase/receipt?id=' + h(r) + '" alt="receipt"></object>').join('') + '</div>').join('') + '</body></html>';
}
let itemsBusy = false;
async function readReceipts(max = 15) {
  if (itemsBusy) return { busy: true };
  const st = itemsState();
  if (!AI_KEY()) return { ...st, manual: true };   // read by hand on /receipts until the key is added
  itemsBusy = true; let n = 0, made = 0;
  try {
    const todo = (await hwPurchases()).filter(t => t.receipts.length && !st.done[t.id]);
    for (const t of todo) {
      if (n >= max) break; n++;
      try {
        let lines = [];
        for (const rid of t.receipts.slice(0, 4)) lines = lines.concat(await readReceipt(rid));
        made += await saveItems(t, lines, st); st.err = '';
      } catch (e) {
        if (e.fatal || /Ramp 40[13]/.test(e.message)) { st.err = /Ramp 40[13]/.test(e.message) ? 'The Ramp app needs the receipts:read permission.' : e.message; break; }
        console.error('Receipt for', t.store, t.date, t.who, 'failed:', e.message); st.done[t.id] = 'err: ' + e.message.slice(0, 80);
      }
      await sleep(400);
    }
    // then gas receipts (gallons, price per gallon, grade), last 12 months
    if (!st.err && n < max) {
      const gx = gasRx(), gas = (await rampYear()).card.filter(t => t.gas && t.receipts.length && !(t.id.slice(0, 10) in gx));
      for (const t of gas) { if (n >= max) break; n++;
        try { gx[t.id.slice(0, 10)] = await readReceipt(t.receipts[0], true); }
        catch (e) { if (e.fatal || /Ramp 40[13]/.test(e.message)) { st.err = /Ramp 40[13]/.test(e.message) ? 'The Ramp app needs the receipts:read permission.' : e.message; break; } gx[t.id.slice(0, 10)] = 0; }
        await sleep(300); }
      cache.set('gasRx', { data: gx, t: Date.now() }); saveSnap('gasRx', gx); cache.delete('rampOv');
    }
  } catch (e) { st.err = e.message; console.error('Reading receipts:', e.message); }
  finally { itemsBusy = false; }
  st.last = Date.now(); saveItemsState(st); cache.delete('itemsAT');
  if (made) console.log(new Date().toISOString(), 'Receipts read:', n, 'purchases,', made, 'items');
  return { ...st, read: n, items: made };
}
if (process.argv[2] !== 'test') { setTimeout(() => readReceipts().catch(() => {}), 3 * 60e3); setInterval(() => readReceipts().catch(() => {}), 20 * 60e3); }
async function purchases() {
  if (!RAMP_CLIENT_ID || !RAMP_CLIENT_SECRET) return { connected: false };
  const st = itemsState(), [tx, recs] = await Promise.all([hwPurchases(), cached('itemsAT', 60, () => atAll(AT_ITEMS, Object.values(IT)))]);
  const items = recs.map(r => { const f = r.fields; return { id: r.id, name: clean(f[IT.item]), txn: clean(f[IT.txn]), date: clean(f[IT.date]), store: clean(f[IT.store]), who: clean(f[IT.person]), memo: clean(f[IT.memo]),
    sku: clean(f[IT.sku]), qty: f[IT.qty] || 1, price: f[IT.price] || 0, link: itemLink(f[IT.store], clean(f[IT.sku]), clean(f[IT.item])), ramp: clean(f[IT.ramp]), status: clean(f[IT.status]?.name ?? f[IT.status]) || 'Out', notes: clean(f[IT.notes]) }; });
  const txns = tx.map(t => ({ ...t, state: st.done[t.id] ? (String(st.done[t.id]).startsWith('err') ? 'error' : 'read') : t.receipts.length ? 'waiting' : 'noReceipt', err: String(st.done[t.id] || '').startsWith('err') ? String(st.done[t.id]).slice(5) : '' }));
  return { connected: true, ai: !!AI_KEY(), err: st.err || '', last: st.last || 0, busy: itemsBusy, since: ITEMS_SINCE, items, txns };
}
async function setItemStatus(b) {
  const status = ['Out', 'Returned', 'Used up'].includes(b.status) ? b.status : null, ids = (Array.isArray(b.ids) ? b.ids : []).map(String).filter(x => /^rec\w{14}$/.test(x)).slice(0, 200);
  if (!status || !ids.length) throw new Error('Pick items and a status.');
  for (let i = 0; i < ids.length; i += 10) await airtable(AT_ITEMS, { method: 'PATCH', body: JSON.stringify({ records: ids.slice(i, i + 10).map(id => ({ id, fields: { [IT.status]: status } })), typecast: true }) });
  cache.delete('itemsAT'); console.log(new Date().toISOString(), 'Purchases:', ids.length, 'items →', status);
  return { ok: true, n: ids.length };
}
// ---------------- Ramp tab: the last 12 months of card spend and reimbursements ----------------
const gasRx = () => (cache.get('gasRx') || {}).data || {};   // first 10 chars of a Ramp id -> [gallons, $/gal, grade] (0 = unreadable)
// Where a card purchase happened: Ramp's merchant location if it sends one, else the "CITY ST" at the end of the card descriptor
const stationLoc = t => { const l = t.merchant_location || (t.merchant_data && (t.merchant_data.location || t.merchant_data)) || {};
  const city = clean(l.city || l.locality), state = clean(l.state || l.region || l.state_code), zip = clean(l.postal_code || l.zip || l.postcode).slice(0, 5);
  if (city || zip) return { city, state, zip };
  const m = /\s([A-Z][A-Z .'-]{2,24}?)\s+([A-Z]{2})\s*$/.exec(clean(t.merchant_descriptor).toUpperCase());
  return m ? { city: m[1].trim(), state: m[2], zip: '' } : null; };
const rampYear = () => cached('rampYear', 3600, async () => {
  const since = new Date(Date.now() - 365 * 864e5), money = a => typeof a === 'number' ? a : Number(a && a.amount) / 100 || 0;
  const card = (await rampAll('transactions', { from_date: since.toISOString() })).filter(t => !/DECLINED|ERROR/i.test(t.state || '')).map(t => { const h = t.card_holder || {};
    return { id: t.id, at: t.user_transaction_time || t.settlement_date || '', who: [h.first_name, h.last_name].filter(Boolean).join(' '), merchant: clean(t.merchant_name || t.merchant_descriptor), cat: clean(t.sk_category_name) || 'Other',
      amount: money(t.amount), gas: isGas(t), receipts: t.receipts || [], memo: clean(t.memo || ''), loc: stationLoc(t) }; });
  let reimb = [];
  if (/reimbursements/.test(rampScopes)) try {
    const users = Object.fromEntries((/users/.test(rampScopes) ? await rampAll('users', {}).catch(() => []) : []).map(u => [u.id, [u.first_name, u.last_name].filter(Boolean).join(' ')]));
    reimb = (await rampAll('reimbursements', { from_date: since.toISOString() })).filter(r => !/REJECT|CANCEL|DRAFT/i.test(r.state || r.status || '')).map(r => ({ id: r.id, at: r.transaction_date || r.created_at || '',
      who: users[r.user_id] || r.user_full_name || '', merchant: clean(r.merchant || r.merchant_name) || 'Reimbursement', cat: 'Reimbursement', amount: money(r.amount),
      gas: GAS_WORDS.test((r.merchant || r.merchant_name || '') + ' ' + (r.memo || '')), receipts: [], memo: clean(r.memo || ''), reimb: true }));
  } catch (e) { console.error('Ramp reimbursements:', e.message); }
  return { since: since.toISOString(), card, reimb };
});
const rampOverview = () => cached('rampOv', 3600, async () => {
  const y = await rampYear(), gx = gasRx(), all = y.card.concat(y.reimb).filter(t => t.amount > 0 && t.at);
  const et = t => new Date(new Date(t.at).toLocaleString('en-US', { timeZone: 'America/New_York' })), mk = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  const months = {}, cats = {}, merch = {}, ppl = {}, stations = {}, gp = {}, flags = [], sameDay = {};
  for (let i = 11; i >= 0; i--) { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i); months[mk(d)] = { k: mk(d), gas: 0, other: 0, gal: 0, ppgSum: 0, ppgN: 0 }; }
  let gal = 0, ppgS = 0, ppgN = 0, prem = 0, read = 0, noRc = 0, noRcAmt = 0;
  for (const t of all) {
    const d = et(t), m = months[mk(d)], who = t.who || 'Unknown';
    if (m) m[t.gas ? 'gas' : 'other'] += t.amount;
    const pp = ppl[who] = ppl[who] || { name: who, total: 0, gas: 0, n: 0, noRc: 0 }; pp.total += t.amount; pp.n++; if (t.gas) pp.gas += t.amount;
    if (!t.reimb && !t.receipts.length) { noRc++; noRcAmt += t.amount; pp.noRc++; }
    if (!t.gas) { (cats[t.cat] = cats[t.cat] || { name: t.cat, total: 0, n: 0 }).total += t.amount; cats[t.cat].n++; (merch[t.merchant] = merch[t.merchant] || { name: t.merchant, total: 0, n: 0 }).total += t.amount; merch[t.merchant].n++; continue; }
    const g = gp[who] = gp[who] || { name: who, total: 0, n: 0, gal: 0, wk: 0, late: 0, big: 0 }; g.total += t.amount; g.n++;
    (stations[t.merchant] = stations[t.merchant] || { name: t.merchant, total: 0, n: 0 }).total += t.amount; stations[t.merchant].n++;
    const rx = gx[t.id.slice(0, 10)];
    if (rx) { read++; if (rx[0] > 0) { gal += rx[0]; g.gal += rx[0]; if (m) m.gal += rx[0]; } if (rx[1] > 2 && rx[1] < 9) { ppgS += rx[1]; ppgN++; if (m) { m.ppgSum += rx[1]; m.ppgN++; } } if (rx[2] === 'p') prem++; }
    // worth a look: weekends, before 5 AM / after 9 PM, over $120 at once, a 2nd fill-up the same day, premium fuel
    const why = [], dow = d.getDay(), hr = d.getHours(), day = who + '|' + d.toDateString();
    if (dow === 0 || dow === 6) { why.push('weekend'); g.wk++; }
    if (/T\d/.test(t.at) && (hr < 5 || hr >= 21)) { why.push(d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })); g.late++; }
    if (t.amount > 120) { why.push('over $120'); g.big++; }
    if (sameDay[day]) why.push('2nd fill-up that day'); sameDay[day] = 1;
    if (rx && rx[2] === 'p') why.push('premium fuel');
    if (why.length) flags.push({ who, date: mk(d) + '-' + String(d.getDate()).padStart(2, '0'), amount: t.amount, merchant: t.merchant, why: why.join(', '), link: t.reimb ? '' : 'https://app.ramp.com/business-overview/transactions/' + t.id });
  }
  const top = (o, n) => Object.values(o).sort((a, b) => b.total - a.total).slice(0, n);
  const gasT = all.filter(t => t.gas), gasCard = gasT.filter(t => !t.reimb);
  return { since: y.since, months: Object.values(months).map(m => ({ k: m.k, gas: m.gas, other: m.other, gal: Math.round(m.gal), ppg: m.ppgN ? m.ppgSum / m.ppgN : 0 })),
    total: all.reduce((a, t) => a + t.amount, 0), n: all.length, noRc, noRcAmt, cats: top(cats, 10), merchants: top(merch, 12), people: top(ppl, 60),
    gas: { total: gasT.reduce((a, t) => a + t.amount, 0), n: gasT.length, reimb: gasT.filter(t => t.reimb).reduce((a, t) => a + t.amount, 0), gal: Math.round(gal), ppg: ppgN ? ppgS / ppgN : 0, prem,
      withRc: gasCard.filter(t => t.receipts.length).length, read, card: gasCard.length, people: top(gp, 60), stations: top(stations, 8), flags: flags.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 80) } };
});
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
const signShare = (obj, days = SHARE_DAYS) => { const b = Buffer.from(JSON.stringify({ ...obj, x: Date.now() + days * 864e5 })).toString('base64url');
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
// The "Vehicle notes" box on a check-up: pick the truck, write what was done, it's added to the truck in Airtable
function truckNotesCard(trucks, truck, who, v, when) {
  const label = t => [t.truckNo && '#' + t.truckNo.split(/[ ~(]/)[0], t.year, t.make, t.model].filter(Boolean).join(' ') || 'Truck';
  const issue = (v.customFields || []).map(c => ({ n: ((c.newCustomField || c.customField || {}).name || ''), v: clean(c.value) })).find(x => /issue|problem|damage|repair/i.test(x.n));
  const pre = issue && issue.v && !/^(none|no|n\/a|na|nothing|-)$/i.test(issue.v) ? issue.v : '';
  const day = new Date(v.endTime || v.startTime || Date.now()).toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' });
  const src = who + '’s check-up (' + day + ')';
  const old = truck && truck.notes ? truck.notes.split('\n').filter(Boolean) : [];
  return `<div class="card" id="vn"><h3 style="margin-top:0">Vehicle notes</h3>
<p class="muted" style="margin-top:-4px">Saved to the truck in Airtable and shown in Edit vehicles. Use it for maintenance done, things to fix, or updates.</p>
<label style="display:block;font-size:12px;font-weight:600;color:#64748b;margin-bottom:4px">Truck</label>
<select id="vnTruck" style="font:inherit;padding:8px 10px;border:1px solid #cbd5e1;border-radius:10px;margin-bottom:10px;min-width:260px">${truck ? '' : '<option value="">Pick a truck</option>'}${trucks.slice().sort((a, b) => label(a).localeCompare(label(b), undefined, { numeric: true })).map(t => `<option value="${H(t.id)}"${truck && t.id === truck.id ? ' selected' : ''}>${H(label(t))}</option>`).join('')}</select>
<textarea id="vnText" rows="3" maxlength="500" placeholder="e.g. Rear brakes replaced, oil changed at 184,300 mi" style="display:block;width:100%;box-sizing:border-box;font:inherit;padding:10px 12px;border:1px solid #cbd5e1;border-radius:12px">${H(pre)}</textarea>
${pre ? '<p class="muted" style="font-size:12.5px;margin:6px 0 0">Filled in from their answer about issues with the truck. Edit it before saving.</p>' : ''}
<button id="vnSave" style="margin-top:10px;font:inherit;font-weight:700;color:#fff;background:#0891b2;border:0;border-radius:10px;padding:9px 16px;cursor:pointer">Save note to truck</button> <span id="vnMsg" class="muted"></span>
<ul id="vnList" class="vnl" style="margin-top:14px"></ul></div>
<style>.vnl{list-style:none;margin:10px 0 0;padding:0;display:flex;flex-direction:column;gap:8px}
.vnl li{position:relative;background:#fff;border:1px solid #e2e8f0;border-left:4px solid #22d3ee;border-radius:12px;padding:9px 40px 9px 12px;font-size:13.5px;line-height:1.4;animation:vnin .3s ease-out both}
.vnl li.chk{border-left-color:#f59e0b}.vnl li.oil{border-left-color:#16a34a}.vnl li.oil .vnd{color:#15803d;background:#dcfce7}.vnl .vnd{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.03em;color:#0e7490;background:#cffafe;border-radius:6px;padding:1px 7px;margin-right:6px}
.vnl li.chk .vnd{color:#b45309;background:#fef3c7}.vnl .vns{font-size:11.5px;font-weight:600;color:#64748b}.vnl .vnt{display:block;margin-top:3px;color:#0f172a}
.vnl .vnx{position:absolute;right:8px;top:8px;border:0;background:none;color:#94a3b8;font:inherit;font-size:16px;font-weight:700;line-height:1;width:24px;height:24px;border-radius:7px;cursor:pointer;transition:background .15s,color .15s}
.vnl .vnx:hover{background:#fee2e2;color:#dc2626}.vnl .vnx.sure{width:auto;padding:0 8px;font-size:12px;background:#dc2626;color:#fff}
@keyframes vnin{from{opacity:0;transform:translateY(4px)}}</style>
<script>function vnLi(line,tid){const m=/^([A-Z][a-z]{2} \\d{1,2}, \\d{4}) · (?:(From [^:]+): )?([\\s\\S]*)$/.exec(line),e=s=>String(s).replace(/[&<>"']/g,c=>'&#'+c.charCodeAt(0)+';');
  return '<li class="'+(/\\boil\\b/i.test(line)&&/chang|service|swap|replac/i.test(line)?'oil':m&&m[2]?'chk':'')+'">'+(m?'<span class="vnd">'+e(m[1])+'</span>'+(m[2]?'<span class="vns">'+e(m[2])+'</span>':'')+'<span class="vnt">'+e(m[3])+'</span>':'<span class="vnt">'+e(line)+'</span>')
    +'<button class="vnx" title="Delete this note" aria-label="Delete this note" data-vndel="'+e(tid)+'" data-line="'+e(line)+'">×</button></li>'}

const trucks=${JSON.stringify(Object.fromEntries(trucks.map(t => [t.id, t.notes || ''])))};
const list=()=>{vnList.innerHTML=(trucks[vnTruck.value]||'').split('\\n').filter(Boolean).map(x=>vnLi(x,vnTruck.value)).join('')};
vnTruck.onchange=list;list();
vnList.onclick=async e=>{const b=e.target.closest('[data-vndel]');if(!b)return;if(!b.classList.contains('sure')){b.classList.add('sure');b.textContent='Delete?';setTimeout(()=>{if(b.isConnected){b.classList.remove('sure');b.textContent='×'}},3000);return}
  b.disabled=true;try{const r=await fetch('/api/truck/note-delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({truckId:b.dataset.vndel,line:b.dataset.line})}),j=await r.json();if(!r.ok)throw new Error(j.error||'Could not delete');trucks[b.dataset.vndel]=j.notes;list();vnMsg.textContent='Note deleted'}catch(err){vnMsg.textContent=err.message;b.disabled=false}};
vnSave.onclick=async()=>{if(!vnTruck.value){vnMsg.textContent='Pick the truck first.';return}vnSave.disabled=true;vnMsg.textContent='Saving...';
  try{const r=await fetch('/api/truck/note',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({truckId:vnTruck.value,text:vnText.value,source:${JSON.stringify('From ' + src)}})}),j=await r.json();
    if(!r.ok)throw new Error(j.error||'Could not save');trucks[vnTruck.value]=j.notes;list();vnText.value='';vnMsg.textContent=j.oil?'Saved ✓ Oil change logged for '+j.oil.date+(j.oil.miles?' at '+j.oil.miles.toLocaleString()+' mi':''):'Saved to the truck ✓'}
  catch(e){vnMsg.textContent=e.message}vnSave.disabled=false};
</script>`;
}
// One submitted truck check-up, laid out like the score reports (logged-in only)
async function serveCheckup(res, id) {
  const send = (code, h) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' }); res.end(h); };
  const shell = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${H(title)}</title><style>${REPORT_CSS}
.ans{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px}.ans div{background:#f8fafc;border-radius:12px;padding:10px 14px}.ans span{display:block;font-size:12px;color:#64748b;font-weight:600}.ans b{font-size:16px}
.yes{color:#15803d}.no{color:#dc2626}.pws{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}.pw{border-radius:14px;padding:14px 16px;border:2px solid #e2e8f0;background:#f8fafc}.pw.reg{background:#eff6ff}.pw.ins{background:#f5f3ff}.pw-h{display:flex;align-items:center;gap:8px;font-weight:800;font-size:13px;text-transform:uppercase;letter-spacing:.05em;color:#334155}.pw-i{font-size:18px}.pw-d{font-size:22px;font-weight:800;margin:6px 0 2px}.pw-s{font-weight:700;font-size:13.5px}.pw.good{border-color:#86efac}.pw.good .pw-s{color:#15803d}.pw.warn{border-color:#fdba74}.pw.warn .pw-s{color:#c2410c}.pw.bad{border-color:#ef4444;background:#fef2f2}.pw.bad .pw-s{color:#b91c1c}.pw.none .pw-s{color:#64748b}.pw-w{margin-top:8px;font-size:12.5px;color:#92400e;background:#fffbeb;border-radius:8px;padding:6px 8px}.pics{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}.pics figure{margin:0;background:#f1f5f9;border-radius:12px;overflow:hidden}.pics img{width:100%;height:180px;object-fit:cover;display:block}.pics figcaption{padding:8px 10px;font-size:12.5px;color:#475569}</style></head>
<body><div class="wrap"><div class="top"><div class="logo">MP</div><div><h1>${H(title)}</h1><p>Millennial Pools fleet · weekly truck check-up from Pool Office Manager</p></div></div>${body}</div></body></html>`;
  try {
    if (!clean(process.env.POM_API_KEY)) return send(503, shell('Check-up', '<div class="card">Pool Office Manager is not connected.</div>'));
    const v = await pomService(String(id || '').slice(0, 60));
    if (!v) return send(404, shell('Check-up not found', '<div class="card">POM has no submission with that id. It may have been deleted.</div>'));
    const w = (v.workers || []).find(x => x.primary) || (v.workers || [])[0], who = w && w.user ? [w.user.firstName, w.user.lastName].filter(Boolean).join(' ') : 'Unknown';
    const when = t => t ? new Date(t).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
    const at = await atData().catch(() => ({ trucks: [] })), tm = rampMatch(at.trucks.filter(t => t.driver && t.driver.name).map(t => ({ name: t.driver.name, t })), who), truck = tm ? tm.t : null;
    const val = (f, x) => { const t = String((f && f.type) || '').toLowerCase(), raw = x == null ? '' : String(x);
      if (/bool|check/.test(t) || /^(true|false)$/i.test(raw)) return /^(true|yes|1)$/i.test(raw) ? '<b class="yes">✓ Yes</b>' : '<b class="no">✕ No</b>';
      if (/^\d{4}-\d{2}-\d{2}T/.test(raw) && !isNaN(Date.parse(raw))) return '<b>' + H(new Date(raw).toLocaleDateString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium' })) + '</b>';
      return raw ? '<b>' + H(raw) + '</b>' : '<b class="muted">–</b>'; };
    const pics = [...(v.media || []).filter(x => x.file && x.file.url && !/video/i.test(x.mediaType || '')).map(x => ({ url: (x.file.thumbnails && x.file.thumbnails.thumbnail900Url) || x.file.url, full: x.file.url, cap: x.customServiceReportFieldLabel || x.description || '' })),
      ...(v.pictures || []).filter(x => x.file && x.file.url).map(x => ({ url: x.file.url, full: x.file.url, cap: x.description || '' }))]
      .filter((x, i, a) => a.findIndex(y => y.full.split('/').pop() === x.full.split('/').pop()) === i);   // POM lists each photo twice (media + pictures)
    const shown = new Set(pics.map(x => x.cap.toLowerCase()));
    const ans = (v.customFields || []).map(c => { const f = c.newCustomField || c.customField || {}; if (!f.name || shown.has(f.name.toLowerCase()) || /regist|insur/i.test(f.name)) return '';   // photo questions appear with their photo below; paperwork has its own card
      return '<div><span>' + H(f.name) + '</span>' + val(f, c.value) + '</div>'; }).join('');
    const notes = [v.customerNotes, v.internalNotes].filter(x => clean(x));
    // Registration and insurance side by side, each with its own status, so an expired one can't be missed
    const A = ansOf(v), sub = Date.parse(v.endTime || v.startTime || v.createdAt) || Date.now(), rg = ymdOf(ansGet(A, /regist/i)), ic = ymdOf(ansGet(A, /insur/i));
    const box = (label, icon, dt, chk, cls) => { const left = dt ? Math.round((Date.parse(dt + 'T12:00') - Date.now()) / 864e5) : null;
      const st = left === null ? ['none', 'Not filled in'] : left < 0 ? ['bad', 'EXPIRED ' + (-left) + ' days ago'] : left <= 30 ? ['warn', 'Expires in ' + left + ' days'] : ['good', 'Valid · ' + (left >= 60 ? Math.round(left / 30.4) + ' months left' : left + ' days left')];
      return '<div class="pw ' + cls + ' ' + st[0] + '"><div class="pw-h"><span class="pw-i">' + icon + '</span>' + label + '</div><div class="pw-d">' + (dt ? H(new Date(dt + 'T12:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })) : '–') + '</div><div class="pw-s">' + st[1] + '</div>'
        + (chk && chk.warn.length ? '<div class="pw-w">⚠ ' + H(chk.warn.join('; ')) + '</div>' : '') + '</div>'; };
    const paper = (rg || ic || Object.keys(A).some(n => /regist|insur/i.test(n))) ? '<div class="card"><h3 style="margin-top:0">Paperwork the tech entered</h3><div class="pws">'
      + box('Registration', '🪪', rg, paperCheck(rg, ic, 'reg', sub), 'reg') + box('Insurance card', '🛡️', ic, paperCheck(ic, rg, 'ins', sub), 'ins') + '</div></div>' : '';
    const body = `<div class="card"><div class="head"><span class="score good" style="font-size:20px">✓<i>done</i></span><div><h2>${H(who)}</h2><div class="muted">Submitted ${H(when(v.endTime || v.startTime || v.createdAt))}${truck ? ' · ' + H([truck.truckNo && '#' + truck.truckNo.split(/[ ~(]/)[0], truck.year, truck.make, truck.model].filter(Boolean).join(' ')) : ''}${v.customServiceReport && v.customServiceReport.name ? ' · ' + H(v.customServiceReport.name) : ''}</div></div></div></div>`
      + paper + `<div class="card"><h3 style="margin-top:0">Answers</h3>${ans ? '<div class="ans">' + ans + '</div>' : '<p class="muted">No form answers on this submission.</p>'}</div>`
      + `<div class="card"><h3 style="margin-top:0">Photos</h3>${pics.length ? '<div class="pics">' + pics.map(x => `<figure><a href="${H(x.full)}" target="_blank" rel="noopener"><img src="${H(x.url)}" alt="${H(x.cap || 'Check-up photo')}" loading="lazy"></a>${x.cap ? '<figcaption>' + H(x.cap) + '</figcaption>' : ''}</figure>`).join('') + '</div>' : '<p class="muted">No photos were added.</p>'}</div>`
      + (notes.length ? `<div class="card"><h3 style="margin-top:0">Notes</h3>${notes.map(n => '<p>' + H(n) + '</p>').join('')}</div>` : '')
      + truckNotesCard(at.trucks, truck, who, v, when);
    return send(200, shell('Truck check-up · ' + who, body));
  } catch (e) { return send(503, shell('Check-up', '<div class="card">Could not load this check-up from Pool Office Manager: ' + H(e.message) + '</div>')); }
}
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
// Shared invoice upload page (/r/<token> with k:'i'): anyone with the link can add an invoice to a truck, nothing else
const INVOICE_PAGE_JS = String.raw`
const $=id=>document.getElementById(id);let photos=[],readN=0;
const shrink=(file,max)=>new Promise((ok,no)=>{const img=new Image();img.onload=()=>{const k=Math.min(1,max/Math.max(img.width,img.height)),c=document.createElement('canvas');c.width=Math.round(img.width*k);c.height=Math.round(img.height*k);const g=c.getContext('2d');g.fillStyle='#fff';g.fillRect(0,0,c.width,c.height);g.drawImage(img,0,0,c.width,c.height);ok(c)};img.onerror=()=>no(new Error('That file is not an image.'));img.src=URL.createObjectURL(file)});
$('date').value=new Date().toLocaleDateString('en-CA');$('date').max=$('date').value;
const touched=new Set();['truck','date','shop','tot','work','est'].forEach(i=>$(i).addEventListener('input',()=>touched.add(i)));
function thumbs(){$('thumbs').innerHTML=photos.map((p,i)=>'<figure><img src="data:image/jpeg;base64,'+p.data+'" alt="Page '+(i+1)+'"><button type="button" data-rm="'+i+'" aria-label="Remove page '+(i+1)+'">×</button><figcaption>Page '+(i+1)+'</figcaption></figure>').join('');
  $('camt').textContent=photos.length?'➕ Add another page':'📷 Add photos of the invoice';$('camh').textContent=photos.length?photos.length+' photo'+(photos.length>1?'s':'')+' · add every page':'All pages: front, back, extra sheets'}
$('thumbs').onclick=e=>{const b=e.target.closest('[data-rm]');if(!b)return;photos.splice(+b.dataset.rm,1);thumbs();if(photos.length)readAI();else $('ai').hidden=true};
async function readAI(){const n=++readN,ai=$('ai');ai.hidden=false;ai.className='ai busy';ai.textContent='✨ Reading the invoice...';
  try{const r=await fetch(location.pathname.replace(/\/$/,'')+'/read',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({photos})}),j=await r.json();if(n!==readN)return;
    if(!r.ok)throw new Error(j.error||'Could not read it');if(!j.ai){ai.className='ai';ai.textContent='Fill in the details below (automatic reading is not set up yet).';return}
    const set=(id,v)=>{if(v!==''&&v!=null&&!touched.has(id)){$(id).value=v;$(id).classList.add('filled')}};
    set('shop',j.shop);set('date',j.date);set('tot',j.total);set('work',j.work);if(j.truckId&&!touched.has('truck')){$('truck').value=j.truckId;$('truck').classList.add('filled')}if(!touched.has('est'))$('est').checked=!!j.estimate;
    ai.className='ai ok';ai.textContent='✨ Filled in from '+(j.pages>1?'the '+j.pages+' photos':'the photo')+'. Check it over, then save.'+(j.truckId?'':' Pick the truck.')}
  catch(err){if(n===readN){ai.className='ai';ai.textContent='Could not read it automatically ('+err.message+'). Fill in the details below.'}}}
$('cam').onchange=async e=>{const fs=[...e.target.files].slice(0,10-photos.length);e.target.value='';if(!fs.length)return;
  for(const f of fs){try{const c=await shrink(f,1600);photos.push({type:'image/jpeg',data:c.toDataURL('image/jpeg',.8).split(',')[1]})}catch(err){$('msg').textContent='Could not read one of those photos.'}}
  thumbs();readAI()};
$('save').onclick=async()=>{const m=$('msg');m.className='msg';m.textContent='';
  if(!$('truck').value){m.textContent='Pick the truck first.';return}if(!photos.length&&!$('work').value.trim()){m.textContent='Take a photo or write what was done.';return}
  $('save').disabled=true;$('save').textContent='Saving...';
  try{const r=await fetch(location.pathname.replace(/\/$/,'')+'/add',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({truckId:$('truck').value,date:$('date').value,shop:$('shop').value,total:$('tot').value,work:$('work').value,estimate:$('est').checked,photos})}),j=await r.json();
    if(!r.ok)throw new Error(j.error||'Could not save');
    m.className='msg ok';m.textContent='Saved. Thank you! You can add another one.';photos=[];readN++;thumbs();$('ai').hidden=true;touched.clear();['shop','tot','work'].forEach(i=>{$(i).value='';$(i).classList.remove('filled')});$('truck').classList.remove('filled');$('est').checked=false;scrollTo({top:0,behavior:'smooth'})}
  catch(err){m.textContent=err.message}$('save').disabled=false;$('save').textContent='Save invoice'};`;
function invoicePage(trucks) {
  const opts = trucks.slice().sort((a, b) => (parseInt(a.truckNo) || 999) - (parseInt(b.truckNo) || 999))
    .map(t => '<option value="' + H(t.id) + '">' + H((t.truckNo ? '#' + t.truckNo.split(/[ ~(]/)[0] + ' ' : '') + [t.year, t.make, t.model].filter(Boolean).join(' ') + (t.driver ? ' · ' + t.driver.name : '')) + '</option>').join('');
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Add a truck invoice · Millennial Pools</title><style>'
    + 'body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:linear-gradient(180deg,#0a4660 0,#0e7490 180px,#f0f9fb 180px);color:#0f172a;min-height:100vh}'
    + '.w{max-width:520px;margin:0 auto;padding:22px 16px 40px}h1{color:#fff;font-size:22px;margin:0 0 4px}.sub{color:#cffafe;font-size:14px;margin:0 0 18px}'
    + '.card{background:#fff;border-radius:18px;padding:16px;box-shadow:0 14px 34px -18px rgba(8,74,99,.6)}'
    + '.cam{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;min-height:140px;border:2px dashed #67e8f9;border-radius:14px;background:#ecfeff;color:#0e7490;font-weight:700;cursor:pointer;padding:10px;text-align:center;font-size:16px}'
    + '.cam input{position:absolute;width:1px;height:1px;opacity:0}.cam small{font-weight:500;font-size:12.5px;color:#0e7490}'
    + '#thumbs{display:grid;grid-template-columns:repeat(auto-fill,minmax(92px,1fr));gap:8px;margin-top:10px}#thumbs:empty{display:none}#thumbs figure{margin:0;position:relative}#thumbs img{width:100%;height:110px;object-fit:cover;border-radius:10px;display:block;border:1px solid #cbd5e1}'
    + '#thumbs figcaption{font-size:11.5px;color:#64748b;text-align:center;margin-top:2px}#thumbs button{position:absolute;top:4px;right:4px;width:26px;min-height:26px;height:26px;border-radius:50%;padding:0;font-size:16px;line-height:1;background:rgba(15,23,42,.75)}'
    + '.ai{margin-top:12px;padding:10px 12px;border-radius:11px;font-size:13.5px;background:#f1f5f9;color:#334155}.ai.busy{background:#ecfeff;color:#0e7490}.ai.ok{background:#f0fdf4;color:#15803d;font-weight:600}'
    + '.filled{border-color:#86efac!important;background:#f7fef9!important}'
    + 'label{display:flex;flex-direction:column;gap:5px;font-size:13px;font-weight:700;color:#475569;margin-top:12px}input,select{font:inherit;font-size:16px;font-weight:400;padding:11px;border:1px solid #cbd5e1;border-radius:11px;min-height:46px;box-sizing:border-box;width:100%;background:#fff;color:#0f172a}'
    + '.chk{flex-direction:row;align-items:center;gap:10px;font-weight:600}.chk input{width:22px;min-height:22px}.hint{font-size:12.5px;color:#64748b;margin:12px 0}'
    + 'button{width:100%;font:inherit;font-size:17px;font-weight:800;color:#fff;background:linear-gradient(135deg,#0891b2,#0e7490);border:0;border-radius:13px;min-height:52px;cursor:pointer}button:disabled{opacity:.6}'
    + '.msg{margin-top:10px;font-size:14px;color:#b45309;min-height:20px}.msg.ok{color:#15803d;font-weight:700}</style></head><body><div class="w">'
    + '<h1>Add a truck invoice</h1><p class="sub">Millennial Pools · photos go straight to the truck’s file</p><div class="card">'
    + '<label class="cam" style="margin:0"><input type="file" accept="image/*" multiple id="cam"><span id="camt">📷 Add photos of the invoice</span><small id="camh">All pages: front, back, extra sheets</small></label><div id="thumbs"></div><div class="ai" id="ai" hidden></div>'
    + '<label>Truck<select id="truck"><option value="">Pick the truck...</option>' + opts + '</select></label>'
    + '<label>Date<input type="date" id="date"></label><label>Shop<input id="shop" maxlength="60" placeholder="e.g. Steve’s Auto Body"></label>'
    + '<label>Total<input id="tot" inputmode="decimal" placeholder="$0.00"></label><label>Work done<input id="work" maxlength="300" placeholder="e.g. Oil change, front brake pads"></label>'
    + '<label class="chk"><input type="checkbox" id="est"> This is an estimate, not a final invoice</label>'
    + '<p class="hint">Add the photos and the details fill in on their own. Check them before saving.</p><button id="save">Save invoice</button><div class="msg" id="msg"></div></div></div><script>' + INVOICE_PAGE_JS + '</script></body></html>';
}
// ---------------- Truck sign-in stickers (QR code in every truck) ----------------
// One QR code for every truck, pointing at one sign-in / sign-out page (/r/<token>). A driver picks their name and a
// truck. Signing OUT happens right away; signing IN is only a request until someone approves it on the dashboard
// (Edit vehicles). Approving does the swap: Airtable's Driver field, then Azuga's driver if the truck has a tracker.
// Stickers are signed with SHARE_SECRET (or the dashboard password): changing that voids every sticker.
const STICKER_DAYS = 3650;
const truckLabelOf = t => (t.truckNo ? '#' + t.truckNo.split(/[ ~(]/)[0] + ' ' : '') + ([t.year, t.make, t.model].filter(Boolean).join(' ') || 'Truck');
const swapDrivers = at => at.drivers.filter(d => d.name && d.status !== 'Inactive').sort((a, b) => a.name.localeCompare(b.name));
async function truckSwap(truckId, b, out) {
  const at = await atData(), t = at.trucks.find(x => x.id === truckId);
  if (!t) throw new Error('This truck is no longer in the system. Tell the office.');
  const d = swapDrivers(at).find(x => x.id === String(b.driverId || ''));
  if (!d) throw new Error('Pick your name first.');
  const patch = (id, fields) => airtable(AT_TRUCKS + '/' + id, { method: 'PATCH', body: JSON.stringify({ fields }) });
  const left = [];
  if (out) {
    if (!t.driver || t.driver.id !== d.id) throw new Error('You are not signed into this truck.');
    await patch(t.id, { [F.driver]: [] });
  } else {
    // Rule: one person per truck, one truck per person. A taken truck has to be signed out first (or changed on the dashboard).
    if (t.driver && t.driver.id !== d.id) throw new Error(t.driver.name + ' is signed into this truck. They need to sign out of it first, or ask the office to switch it.');
    for (const o of at.trucks) if (o.id !== t.id && o.driver && o.driver.id === d.id) { await patch(o.id, { [F.driver]: [] }); left.push(truckLabelOf(o)); }
    if (!t.driver || t.driver.id !== d.id) await patch(t.id, { [F.driver]: [d.id] });
  }
  cache.delete('airtable'); cache.delete('truckDrivers');
  let azuga = '';
  if (!out) try {
    const vs = await freshVehicles(), m = matchAll(vs, (await atData()).trucks), id = Object.keys(m).find(k => m[k].truck && m[k].truck.id === t.id);
    if (id) { const r = await syncOne(id); if (!r.skipped) azuga = 'Azuga updated too.'; }
  } catch (e) { azuga = 'Azuga was not updated (' + e.message + ').'; console.error('Truck sign-in, Azuga:', e.message); }
  const was = t.driver && t.driver.id !== d.id ? t.driver.name : '';
  const log = [{ at: Date.now(), who: d.name, tid: t.id, truck: truckLabelOf(t), out: !!out, was, left, ok: b.approvedBy || '' }, ...swapLog()].slice(0, 200);
  cache.set('swaps', { data: log, t: Date.now() }); saveSnap('swaps', log);
  console.log(new Date().toISOString(), 'Truck', out ? 'sign-out:' : 'sign-in:', d.name, truckLabelOf(t), left.length ? '(left ' + left.join(', ') + ')' : '');
  return { ok: true, truck: truckLabelOf(t), who: d.name, out: !!out, was, left, azuga };
}
// Driver asks to sign into a truck. One open request per driver; the truck has to be free (one person per truck).
async function requestSignIn(b) {
  const at = await atData(), d = swapDrivers(at).find(x => x.id === String(b.driverId || '')), t = at.trucks.find(x => x.id === String(b.truckId || ''));
  if (!d) throw new Error('Pick your name first.');
  if (!t) throw new Error('Pick a truck.');
  if (t.driver && t.driver.id === d.id) throw new Error('You are already signed into ' + truckLabelOf(t) + '.');
  if (t.driver) throw new Error(t.driver.name + ' is signed into ' + truckLabelOf(t) + '. They need to sign out of it first.');
  const r = { id: crypto.randomBytes(6).toString('hex'), at: Date.now(), driverId: d.id, who: d.name, truckId: t.id, truck: truckLabelOf(t) };
  saveReqs([r, ...swapReqs().filter(x => x.driverId !== d.id)].slice(0, 100));
  console.log(new Date().toISOString(), 'Truck sign-in requested:', d.name, r.truck);
  return { ok: true, truck: r.truck };
}
async function signOutSelf(b) {
  const at = await atData(), d = swapDrivers(at).find(x => x.id === String(b.driverId || ''));
  if (!d) throw new Error('Pick your name first.');
  const t = at.trucks.find(x => x.driver && x.driver.id === d.id);
  if (!t) throw new Error('You are not signed into a truck.');
  return truckSwap(t.id, { driverId: d.id }, true);
}
// Dashboard: approve (does the swap) or deny a request
async function decideRequest(b) {
  const r = swapReqs().find(x => x.id === String(b.id || ''));
  if (!r) throw new Error('That request is gone (already handled?).');
  let out = { ok: true, denied: true };
  if (b.approve === true) out = await truckSwap(r.truckId, { driverId: r.driverId, approvedBy: 'office' }, false);
  else { const log = [{ at: Date.now(), who: r.who, tid: r.truckId, truck: r.truck, denied: true, left: [] }, ...swapLog()].slice(0, 200); cache.set('swaps', { data: log, t: Date.now() }); saveSnap('swaps', log); }
  saveReqs(swapReqs().filter(x => x.id !== r.id));
  console.log(new Date().toISOString(), 'Truck sign-in', b.approve === true ? 'approved:' : 'denied:', r.who, r.truck);
  return out;
}
const SIGN_PAGE_JS = `const $=i=>document.getElementById(i),me=$('me'),tr=$('tr'),msg=$('msg');
try{const s=localStorage.getItem('mp_me');if(s&&D[s])me.value=s}catch(e){}
function paint(){const d=D[me.value];$('cur').hidden=!d;if(!d)return;
  $('curT').textContent=d.truck||'No truck';$('out').hidden=!d.truck;$('pend').hidden=!d.pending;$('pendT').textContent=d.pending||''}
me.onchange=()=>{try{localStorage.setItem('mp_me',me.value)}catch(e){}msg.textContent='';paint()};paint();
async function go(kind,body){if(!me.value){msg.className='msg';msg.textContent='Pick your name first.';return}msg.className='msg';msg.textContent='Sending...';
  document.querySelectorAll('button').forEach(b=>b.disabled=true);
  try{const r=await fetch(location.pathname.replace(/\\/$/,'')+'/'+kind,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({driverId:me.value},body))});const j=await r.json();if(!r.ok)throw new Error(j.error||'Could not send');
    const d=D[me.value];msg.className='msg ok';
    if(kind==='out'){msg.textContent='Signed out of '+j.truck+'.';d.truck=''}else{msg.textContent='Request sent for '+j.truck+'. You are signed in once the office approves it.';d.pending=j.truck}paint()}
  catch(e){msg.textContent=e.message}document.querySelectorAll('button').forEach(b=>b.disabled=false)}
$('in').onclick=()=>{if(!tr.value){msg.className='msg';msg.textContent='Pick a truck.';return}go('request',{truckId:tr.value})};$('out').onclick=()=>go('out',{});`;
const MINI_CSS = 'body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:linear-gradient(180deg,#0a4660 0,#0e7490 200px,#f0f9fb 200px);color:#0f172a;min-height:100vh}'
  + '.w{max-width:480px;margin:0 auto;padding:22px 16px 40px}h1{color:#fff;font-size:26px;margin:0 0 2px}.sub{color:#cffafe;font-size:14px;margin:0 0 18px}'
  + '.card{background:#fff;border-radius:18px;padding:18px;box-shadow:0 14px 34px -18px rgba(8,74,99,.6)}.cur{background:#f0f9ff;border-radius:12px;padding:12px;margin:0 0 6px}.cur p{margin:0;font-size:13px;color:#475569}.cur b{display:block;font-size:20px;color:#0f172a;margin:2px 0 10px}'
  + 'label{display:flex;flex-direction:column;gap:6px;font-size:13px;font-weight:700;color:#475569;margin:16px 0}select{font:inherit;font-size:17px;padding:12px;border:1px solid #cbd5e1;border-radius:12px;min-height:50px;background:#fff;color:#0f172a}'
  + 'button{width:100%;font:inherit;font-size:18px;font-weight:800;color:#fff;background:linear-gradient(135deg,#0891b2,#0e7490);border:0;border-radius:14px;min-height:54px;cursor:pointer}button:disabled{opacity:.6}#out{background:#fff;color:#b91c1c;border:2px solid #fecaca;min-height:46px;font-size:16px}'
  + '.pend{background:#fef3c7;color:#92400e;border-radius:10px;padding:8px 10px;font-size:14px;font-weight:700;margin:10px 0 0}.msg{margin-top:12px;font-size:15px;color:#b45309;min-height:20px}.msg.ok{color:#15803d;font-weight:700}';
function signPage(at) {
  const ds = swapDrivers(at), reqs = swapReqs();
  const D = Object.fromEntries(ds.map(d => { const t = at.trucks.find(x => x.driver && x.driver.id === d.id), r = reqs.find(x => x.driverId === d.id);
    return [d.id, { truck: t ? truckLabelOf(t) : '', pending: r ? r.truck : '' }]; }));
  const ts = at.trucks.slice().sort((a, b) => (b.active - a.active) || (parseInt(a.truckNo) || 999) - (parseInt(b.truckNo) || 999));
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Truck sign in / out · Millennial Pools</title><style>' + MINI_CSS + '</style></head><body><div class="w">'
    + '<h1>Truck sign in / out</h1><p class="sub">Millennial Pools</p><div class="card">'
    + '<label style="margin-top:0">Who are you?<select id="me"><option value="">Pick your name...</option>' + ds.map(d => '<option value="' + H(d.id) + '">' + H(d.name) + '</option>').join('') + '</select></label>'
    + '<div class="cur" id="cur" hidden><p>Your truck now</p><b id="curT"></b><button id="out" hidden>Sign out of it</button><div class="pend" id="pend" hidden>Waiting for the office to approve: <span id="pendT"></span></div></div>'
    + '<label>Truck you want to sign into<select id="tr"><option value="">Pick a truck...</option>' + ts.map(t => '<option value="' + H(t.id) + '"' + (t.driver ? ' disabled' : '') + '>' + H(truckLabelOf(t) + (t.driver ? ' · ' + t.driver.name : t.active ? '' : ' (inactive)')) + '</option>').join('') + '</select></label>'
    + '<button id="in">Request sign in</button><div class="msg" id="msg"></div>'
    + '<p style="font-size:12.5px;color:#64748b;margin:14px 0 0">One person per truck: a truck with someone in it is greyed out until they sign out. The office approves each sign in, then you are moved off your old truck. Your phone remembers your name.</p></div></div>'
    + '<script>const D=' + JSON.stringify(D).replace(/</g, '\\u003c') + ';' + SIGN_PAGE_JS + '</script></body></html>';
}
// Two label sheets. Every sticker is the same QR code.
// round: 1.5" circles, 20 per letter sheet (4 x 5), same positions as the "Matt Stickers" label sheet.
// uline3: Uline S-21909 weather-resistant 3 x 3" vinyl, 6 per sheet (2 x 3); centres measured from Uline's PDF template.
const STICKERS_JS = `const n=document.getElementById('n'),sh=document.getElementById('sh'),pages=document.getElementById('pages');
const SHEETS={round:{per:20,pos:k=>[0.5+2*(k%4),0.751+2*Math.floor(k/4)],cls:'rc'},
 uline3:{per:6,pos:k=>[[2.694,5.847][k%2]-1.5,[2.368,5.507,8.66][Math.floor(k/2)]-1.5],cls:'sq'}};
function draw(){const S=SHEETS[sh.value]||SHEETS.round,c=Math.max(1,Math.min(200,+n.value||S.per));pages.innerHTML='';
  for(let p=0;p<Math.ceil(c/S.per);p++){const pg=document.createElement('div');pg.className='pg';
    for(let k=0;k<Math.min(S.per,c-p*S.per);k++){const e=document.createElement('div'),q=document.createElement('div'),xy=S.pos(k);e.className=S.cls;e.style.left=xy[0]+'in';e.style.top=xy[1]+'in';
      if(S.cls==='sq'){e.innerHTML='<b>Millennial Pools</b>';e.appendChild(q);e.insertAdjacentHTML('beforeend','<span>Scan to sign in / out of this truck</span>')}else e.appendChild(q);
      new QRCode(q,{text:U,width:400,height:400,correctLevel:QRCode.CorrectLevel.Q});pg.appendChild(e)}
    pages.appendChild(pg)}}
sh.onchange=()=>{n.value=(SHEETS[sh.value]||SHEETS.round).per;draw()};n.oninput=draw;draw();`;
function stickersPage(at, base) {
  const u = base + '/r/' + signShare({ k: 's' }, STICKER_DAYS);
  return '<!doctype html><html><head><meta charset="utf-8"><title>Truck QR stickers</title><style>'
    + 'body{margin:0;font-family:Arial,Helvetica,sans-serif;background:#e2e8f0;color:#0f172a}.bar{position:sticky;top:0;background:#0b4a63;color:#fff;padding:12px 18px;display:flex;gap:14px;align-items:center;flex-wrap:wrap;z-index:2}'
    + '.bar button{font:inherit;font-weight:800;background:#22d3ee;color:#083344;border:0;border-radius:10px;padding:9px 16px;cursor:pointer}.bar span{font-size:13px;color:#cffafe}.bar input,.bar select{font:inherit;padding:6px;border-radius:8px;border:0}.bar input{width:60px}.bar a{color:#a5f3fc}'
    + '.pg{width:8.5in;height:11in;background:#fff;position:relative;margin:.3in auto;box-shadow:0 6px 20px rgba(0,0,0,.15);overflow:hidden}'
    + '.rc{position:absolute;width:1.5in;height:1.5in;border-radius:50%;outline:1px dashed #94a3b8;display:flex;align-items:center;justify-content:center}.rc img,.rc canvas{width:1in!important;height:1in!important;display:block}'
    + '.sq{position:absolute;width:3in;height:3in;border-radius:.125in;outline:1px dashed #94a3b8;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.06in;text-align:center}'
    + '.sq b{font-size:11pt;letter-spacing:.02em;color:#0b4a63}.sq span{font-size:8.5pt;font-weight:700;color:#0f172a}.sq img,.sq canvas{width:2.05in!important;height:2.05in!important;display:block}'
    + '@media print{body{background:#fff}.bar{display:none}.pg{margin:0;box-shadow:none;break-after:page}.rc,.sq{outline:0}@page{size:letter;margin:0}}</style>'
    + '<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script></head><body>'
    + '<div class="bar"><b>Truck QR stickers</b><label>Sheet <select id="sh"><option value="round">Round 1.5" labels (20 per sheet)</option><option value="uline3">Uline S-21909 weather-resistant 3 x 3" (6 per sheet)</option></select></label>'
    + '<label>Stickers <input id="n" type="number" min="1" max="200" value="20"></label><button onclick="print()">Print</button>'
    + '<span>Every sticker is the same code, so any sticker goes in any truck. It opens <a href="' + H(u) + '" target="_blank">the sign in / out page</a>. Print at Scale 100% (Actual size) with Margins: None. Uline vinyl labels: laser printer only.</span></div>'
    + '<div id="pages"></div><script>const U=' + JSON.stringify(u) + ';' + STICKERS_JS + '</script></body></html>';
}
// ---------------- Upkeep tab: cost per truck, gas vs GPS, oil due, renewals, weekly safety email ----------------
let lastBase = clean(process.env.PUBLIC_URL).replace(/\/$/, '');   // background emails need the site's address for links
const upState = () => (cache.get('upkeep') || {}).data || { safety: false, oil: false, renew: true, sent: {}, read: {}, src: {} };
const saveUp = d => { cache.set('upkeep', { data: d, t: Date.now() }); saveSnap('upkeep', d); };
const etNow = () => new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
const weekKey = () => { const d = etNow(); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.toLocaleDateString('en-CA'); };
const tname = t => (t.truckNo ? '#' + t.truckNo.split(/[ ~(]/)[0] + ' ' : '') + ([t.year, t.make, t.model].filter(Boolean).join(' ') || 'Truck');
const vOdo = r => Math.round(+r.vehicleDeviceCurrentodoReading || (r.odo_support && +r.vehicleSupportedOdoValue) || +r.totalDistanceTravelled || +r.odometerReading || 0);   // the truck's own value is sometimes in km, so the current (entered + GPS) reading comes first
const fleetPairs = async () => { const [vs, L] = await Promise.all([routes['/api/vehicles']().then(list), atLinks()]);
  return vs.map(v => { const l = L.links && L.links[v.trackeeId]; return l && l.linked ? { v, t: l.truck, odo: vOdo(v) } : null; }).filter(Boolean); };
async function myEmail() {
  const at = await atData(), d = at.drivers.find(x => dupeName(x.name) === dupeName('Callum Curcie'));
  if (d && d.email) return d.email;
  const u = (await pomUsers().catch(() => [])).find(x => dupeName(x.name) === dupeName('Callum Curcie'));
  if (u && u.email) return u.email;
  throw new Error('Could not find an email for Callum Curcie (Drivers table in Airtable).');
}
const UPKEEP_TO = clean(process.env.UPKEEP_EMAIL) || 'callum@millennialpools.com';   // renewal + oil emails and samples go here; safety emails go to each driver
const emailOf = async name => { const at = await atData(), d = at.drivers.find(x => dupeName(x.name) === dupeName(name)); return d && d.status !== 'Inactive' ? d.email : ''; };

// Cost per truck (last 12 months): invoices saved in the truck's notes + Ramp repair payments not already in the notes,
// gas = each person's Ramp gas split over the trucks they drove by Azuga miles, miles = Azuga's monthly score report.
const REP_LINE = /^([A-Z][a-z]{2} \d{1,2}, \d{4}) · From (.+?) (invoice|estimate)([^:]*): (.*)$/;
const noteRepairs = t => String(t.notes || '').split('\n').map(l => REP_LINE.exec(l)).filter(m => m && m[3] === 'invoice')
  .map(m => { const tm = /Total \$([\d,]+\.\d\d)/.exec(m[5]); return { ts: Date.parse(m[1]), amount: tm ? +tm[1].replace(/,/g, '') : 0, shop: m[2], work: m[5].replace(/\.? ?Total[^]*$/, '').slice(0, 90) }; });
// A pickup burns about $0.22 of gas a mile (17 mpg at $3.70). Gas far above that for a truck's miles went somewhere else
// (gas cans, another vehicle, a card used for someone else's truck), so it is shown but not counted in cost per mile.
const GAS_PER_MILE = +process.env.GAS_PER_MILE || 0.22;
const truckCost = () => cached('truckCost2', 3600, async () => {
  const yr = Date.now() - 365 * 864e5, mo = 30 * 864e5;
  const [at, pairs, hist, rr, y] = await Promise.all([atData(), fleetPairs().catch(() => []), drvHistory().catch(() => ({})), rampRepairs().catch(() => []), rampYear().catch(() => ({ card: [], reimb: [] }))]), gchk = gasChk();
  const byT = Object.fromEntries(pairs.map(p => [p.t.id, p])), rows = {}, same = (a, b) => !!matchPerson([{ name: a }], b);
  at.trucks.forEach(t => rows[t.id] = { id: t.id, name: tname(t), year: +t.year || null, driver: t.driver ? t.driver.name : '', active: t.active, odo: byT[t.id] ? byT[t.id].odo : 0,
    repairs: 0, nRep: 0, rep: [], gas: 0, gasBy: {}, how: {}, miles: 0, milesNamed: 0, warn: [] });
  for (const t of at.trucks) {
    const nr = noteRepairs(t).filter(r => r.ts > yr), row = rows[t.id];
    nr.forEach(r => { row.repairs += r.amount; row.nRep++; row.rep.push({ d: new Date(r.ts).toISOString().slice(0, 10), what: r.work || 'Invoice', where: r.shop, amt: r.amount, src: 'Invoice in truck notes' }); });
    rr.filter(x => x.truckId === t.id && Date.parse(x.date) > yr && !nr.some(n => Math.abs(n.amount - x.amount) <= x.amount * 0.03 && Math.abs(n.ts - Date.parse(x.date)) < 6 * 864e5))
      .forEach(x => { row.repairs += x.amount; row.nRep++; row.rep.push({ d: x.date, what: x.memo || 'Card payment', where: x.merchant, amt: x.amount,
        src: 'Ramp, ' + x.who + (x.how === 'memo' ? ' (truck # in memo)' : ' (paid by this truck’s driver, so it may be for another truck)') }); });
  }
  const drove = {};   // card holder -> [{ id, h }] trucks they drove in Azuga
  const droveBy = who => drove[who] = drove[who] || pairs.flatMap(p => Object.values(hist[p.v.trackeeId] || {}).filter(h => same(h.name, who)).map(h => ({ id: p.t.id, h })));
  for (const p of pairs) { const named = Object.values(hist[p.v.trackeeId] || {}).reduce((a, h) => a + h.miles, 0);
    rows[p.t.id].milesNamed = named; rows[p.t.id].miles = Math.max(named, (hist._tot || {})[p.v.trackeeId] || 0); }
  const cur = who => at.trucks.find(t => t.driver && same(t.driver.name, who));
  let unassigned = 0;
  const give = (id, g, amt, how) => { const r = rows[id]; r.gas += amt; const b = r.gasBy[g.who || 'Unknown'] = r.gasBy[g.who || 'Unknown'] || { amt: 0, n: 0 }; b.amt += amt; b.n += amt / g.amount; r.how[how] = (r.how[how] || 0) + amt; };
  for (const g of y.card.concat(y.reimb).filter(x => x.gas && x.amount > 0)) {
    const c = gchk[g.id], m = Math.min(11, Math.floor((Date.now() - Date.parse(g.at)) / mo)), d = droveBy(g.who);
    if (c && c.truckId && rows[c.truckId] && (c.verdict === 'ok' || c.verdict === 'moving')) { give(c.truckId, g, g.amount, 'gps'); continue; }   // GPS put the truck at the pump
    let parts = d.filter(x => x.h.mo && x.h.mo[m] > 0).map(x => [x.id, x.h.mo[m]]), how = 'month';
    if (!parts.length) { parts = d.map(x => [x.id, x.h.miles]); how = 'year'; }
    const tot = parts.reduce((a, x) => a + x[1], 0);
    if (tot) parts.forEach(([id, mi]) => give(id, g, g.amount * mi / tot, how));
    else { const t = cur(g.who); if (t) give(t.id, g, g.amount, 'driver'); else unassigned += g.amount; }
  }
  const out = Object.values(rows).map(r => {
    const expect = r.miles * GAS_PER_MILE, extra = r.gas > 300 && r.gas > Math.max(2 * expect, expect + 400) ? r.gas - 1.5 * expect : 0, counted = r.gas - extra;
    if (extra) r.warn.push(d0s(r.gas) + ' of gas for ' + Math.round(r.miles).toLocaleString() + ' miles. That many miles should use about ' + d0s(expect) + ', so ' + d0s(extra) + ' probably went into other vehicles or gas cans. It is left out of the cost per mile.');
    if (r.miles && r.milesNamed < r.miles * 0.5) r.warn.push('Most of this truck’s miles had nobody logged in to Azuga, so its gas can’t all be traced to a driver.');
    if (!byT[r.id]) r.warn.push('No Azuga tracker linked, so miles are unknown.');
    if (r.rep.some(x => /may be for another truck/.test(x.src))) r.warn.push('Some repairs were matched only by who paid. Check they were for this truck.');
    return { id: r.id, name: r.name, year: r.year, driver: r.driver, active: r.active, odo: r.odo, age: r.year ? new Date().getFullYear() - r.year : null,
      miles: Math.round(r.miles), repairs: Math.round(r.repairs), nRep: r.nRep, gas: Math.round(r.gas), gasExtra: Math.round(extra), gasCounted: Math.round(counted), expectGas: Math.round(expect),
      total: Math.round(r.repairs + counted), cpm: r.miles >= 100 ? Math.round((r.repairs + counted) / r.miles * 100) / 100 : null,
      rep: r.rep.sort((a, b) => b.amt - a.amt).slice(0, 12), gasBy: Object.entries(r.gasBy).map(([who, b]) => ({ who, amt: Math.round(b.amt), n: Math.round(b.n * 10) / 10 })).sort((a, b) => b.amt - a.amt).slice(0, 8),
      how: Object.fromEntries(Object.entries(r.how).map(([k, v]) => [k, Math.round(v)])), warn: r.warn };
  }).filter(r => r.total || r.miles || r.gas).sort((a, b) => (b.cpm ?? -1) - (a.cpm ?? -1) || b.total - a.total);
  return { rows: out, unassignedGas: Math.round(unassigned), gasPerMile: GAS_PER_MILE };
});
const d0s = n => '$' + Math.round(n || 0).toLocaleString();

// Gas fill-ups checked against GPS: was the person's truck stopped near that station within 30 minutes of the charge?
// Also flags more gallons than the tank holds and a 2nd fill-up within 24 hours with little driving between.
// Tank sizes by model (Azuga doesn't report them); the biggest tank option is used so only clear overfills show.
const TANKS = [[/ranger/i, 21], [/maverick/i, 13.8], [/colorado|canyon/i, 21], [/tacoma/i, 21], [/frontier/i, 21], [/f-?150/i, 36], [/silverado|sierra/i, 28], [/\bram\b|1500/i, 33], [/transit/i, 31], [/ridgeline/i, 19.5], [/gladiator/i, 22]];
const tankOf = t => { const h = t && TANKS.find(([re]) => re.test(t.make + ' ' + t.model)); return h ? h[1] : 0; };
// Results are kept packed (one short array per fill-up) so 60 days fit in one "Dashboard cache" row
const GPACK = ['verdict', 'at', 'who', 'merchant', 'amount', 'gal', 'truckId', 'flags', 'unverified', 'mi'];
const gasChk = () => Object.fromEntries(Object.entries((cache.get('gasChk2') || {}).data || {}).map(([id, a]) => [id, Object.fromEntries(GPACK.map((k, i) => [k, k === 'at' ? new Date(a[i] * 1000).toISOString() : a[i]]))]));
const saveGasChk = done => { const d = Object.fromEntries(Object.entries(done).map(([id, x]) => [id, GPACK.map(k => k === 'at' ? Math.round(Date.parse(x.at) / 1000) : k === 'merchant' ? String(x.merchant).slice(0, 28) : x[k] ?? (k === 'flags' ? [] : ''))]));
  cache.set('gasChk2', { data: d, t: Date.now() }); saveSnap('gasChk2', d); };
const geoCache = () => (cache.get('geo') || {}).data || {};
async function geocode(loc) {
  const q = loc.zip ? loc.zip + ', USA' : loc.city + ', ' + loc.state + ', USA', g = geoCache();
  if (q in g) return g[q];
  await sleep(1100);   // Nominatim allows 1 lookup a second
  const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=' + encodeURIComponent(q), { headers: { 'User-Agent': 'MillennialPools-FleetDashboard/1.0' } });
  if (!r.ok) throw new Error('Geocode ' + r.status);   // not cached, tried again next run
  const j = await r.json(); g[q] = j[0] ? { lat: +j[0].lat, lng: +j[0].lon } : null;
  cache.set('geo', { data: g, t: Date.now() }); saveSnap('geo', g); return g[q];
}
const trailMiles = pts => pts.reduce((s, p, i) => i ? s + miles(pts[i - 1], p) : 0, 0);
const NEAR_ZIP_MI = 6, NEAR_CITY_MI = 10;   // the station is placed at its ZIP / town centre, so allow that much slack
let gasBusy = false;
async function checkGas(max = 40) {
  if (gasBusy || !RAMP_CLIENT_ID) return; gasBusy = true;
  try {
    const [y, pairs, hist, at] = await Promise.all([rampYear(), fleetPairs(), drvHistory().catch(() => ({})), atData()]), done = gasChk(), gx = gasRx();
    const since = Date.now() - 60 * 864e5, byTruck = Object.fromEntries(pairs.map(p => [p.t.id, p]));
    const same = (a, b) => !!matchPerson([{ name: a }], b);   // Ramp "Matt Wonski" = Airtable "Matthew Wonski"
    // Trucks the card holder could have been in: their Airtable truck, sticker sign-ins, then trucks Azuga shows them driving
    const trucksOf = (who, ts) => { const c = {};
      at.trucks.filter(t => t.driver && same(t.driver.name, who)).forEach(t => c[t.id] = 1e9);
      swapLog().filter(x => !x.out && x.at < ts && x.at > ts - 30 * 864e5 && same(x.who, who)).forEach(x => c[x.tid] = (c[x.tid] || 0) + 1e8);
      pairs.forEach(p => Object.values(hist[p.v.trackeeId] || {}).forEach(h => { if (same(h.name, who)) c[p.t.id] = (c[p.t.id] || 0) + h.miles * (ts >= h.from - 864e5 && ts <= h.to + 864e5 ? 10 : 1); }));
      return Object.entries(c).sort((a, b) => b[1] - a[1]).map(x => byTruck[x[0]]).filter(Boolean).slice(0, 4); };
    const gas = y.card.filter(t => t.gas && t.amount >= 10 && Date.parse(t.at) > since).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    let n = 0;
    for (const t of gas) {
      if ((done[t.id] && done[t.id].verdict !== 'notruck') || n >= max) continue;   // no-truck ones are retried (cheap) in case Airtable gets updated
      const ts = Date.parse(t.at), rx = gx[t.id.slice(0, 10)], r = { at: t.at, who: t.who, merchant: t.merchant, amount: t.amount, gal: rx && rx[0] || 0, flags: [] };
      const cands = trucksOf(t.who, ts);
      if (!cands.length) { r.verdict = 'notruck'; r.unverified = 'No truck found for ' + (t.who || 'this card'); done[t.id] = r; continue; }
      n++;
      let here = null, best = null;
      try {   // an Azuga or map lookup that fails is retried next run, never counted as "not near"
        here = t.loc ? await geocode(t.loc) : null;
        for (const p of cands) {
          let pts = await trailRange(p.v.trackeeId, new Date(ts - 30 * 6e4), new Date(ts + 30 * 6e4), true), parked = false;
          if (!pts.length) {   // engine off the whole hour: use where the truck was parked (last point before the charge, else first after)
            const wide = await trailRange(p.v.trackeeId, new Date(ts - 12 * 36e5), new Date(ts + 2 * 36e5), true);
            const spot = wide.filter(x => x.t <= ts).pop() || wide.find(x => x.t > ts);
            if (spot) { pts = [{ ...spot, mph: 0 }]; parked = true; }
          }
          if (!pts.length) { best = best || { p, nogps: true }; continue; }
          const stopped = pts.filter(x => x.mph < 3), look = stopped.length ? stopped : pts;
          const byText = t.loc && look.some(x => (t.loc.zip && x.addr.includes(t.loc.zip)) || (t.loc.city && x.addr.toUpperCase().includes(t.loc.city.toUpperCase())));
          const mi = here ? Math.min(...look.map(x => miles(x, here))) : null;
          const c = { p, mi, parked, ok: byText || (mi !== null && mi <= (t.loc.zip ? NEAR_ZIP_MI : NEAR_CITY_MI)), stopped: stopped.length > 0 };
          if (!best || best.nogps || c.ok && !best.ok || (!best.ok && mi !== null && (best.mi == null || mi < best.mi))) best = c;
          if (c.ok) break;
        }
      } catch (e) { console.error('Gas check paused (will retry):', e.message); break; }
      r.truckId = best.p.t.id;
      if (!t.loc) { r.verdict = 'noloc'; r.unverified = 'Ramp gave no station location'; }
      else if (best.nogps) { r.verdict = 'nogps'; r.unverified = 'No GPS from ' + tname(best.p.t) + ' in the 12 hours before'; }
      else if (best.ok) r.verdict = best.stopped ? 'ok' : 'moving';
      else if (best.mi === null) { r.verdict = 'noloc'; r.unverified = 'Could not place ' + t.loc.city + ' ' + t.loc.state + ' on the map'; }
      else { r.verdict = 'far'; r.mi = Math.round(best.mi);
        r.flags.push((best.parked ? 'Truck was parked ' : 'Truck was ') + r.mi + ' miles from the station' + (cands.length > 1 ? ' (checked ' + cands.length + ' trucks they drive)' : '')); }
      if (r.verdict === 'moving') r.flags.push('Truck was driving, never stopped near the station');
      const tank = tankOf(best.p.t);
      if (r.gal && tank && r.gal > tank * 1.05) r.flags.push(r.gal.toFixed(1) + ' gal into a ' + tank + ' gal tank');
      const prev = Object.values(done).filter(x => x.who === t.who && x.truckId === r.truckId && ts - Date.parse(x.at) > 0 && ts - Date.parse(x.at) < 24 * 36e5).pop();
      if (prev && !best.nogps) {
        const d = trailMiles(await trailRange(best.p.v.trackeeId, new Date(Date.parse(prev.at)), new Date(ts), true).catch(() => null) || [1e9]);
        if (d < 60) r.flags.push('2nd fill-up in ' + Math.round((ts - Date.parse(prev.at)) / 36e5) + ' h with only ' + Math.round(d) + ' miles driven');
      }
      done[t.id] = r;
      await sleep(1500);
    }
    Object.keys(done).forEach(id => { if (Date.parse(done[id].at) < since) delete done[id]; });
    saveGasChk(done);
  } catch (e) { console.error('Gas check:', e.message); } finally { gasBusy = false; }
}

// Oil changes due: Azuga odometer now minus the miles on the last oil-change invoice (Airtable), or 6 months
const OIL_MI = +process.env.OIL_MILES || 5000, OIL_DAYS = 183;
async function oilList() {
  return (await fleetPairs()).map(p => {
    const since = p.t.oilMiles && p.odo ? p.odo - p.t.oilMiles : null, days = p.t.oilDate ? Math.round((Date.now() - Date.parse(p.t.oilDate + 'T12:00')) / 864e5) : null;
    const ok = since !== null && since >= 0 ? since : null;   // a negative gap means Azuga's odometer doesn't match the invoice
    const st = !p.t.oilDate ? 'unknown' : (ok !== null && ok >= OIL_MI) || days >= OIL_DAYS ? 'due' : (ok !== null && ok >= OIL_MI - 700) || days >= OIL_DAYS - 21 ? 'soon' : 'ok';
    return { id: p.t.id, name: tname(p.t), driver: p.t.driver ? p.t.driver.name : '', odo: p.odo, oilDate: p.t.oilDate, oilMiles: p.t.oilMiles, since: ok, days, status: st, odoMismatch: since !== null && since < 0 };
  }).sort((a, b) => ['due', 'soon', 'unknown', 'ok'].indexOf(a.status) - ['due', 'soon', 'unknown', 'ok'].indexOf(b.status) || (b.since || 0) - (a.since || 0));
}
const oilText = o => ({ subject: 'Oil change due: ' + o.name, body: 'Hi ' + o.driver.split(' ')[0] + ',\n\nYour truck (' + o.name + ') is due for an oil change: ' +
  (o.since !== null ? o.since.toLocaleString() + ' miles' : o.days + ' days') + ' since the last one (' + new Date(o.oilDate + 'T12:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ').\n\nPlease get it booked this week and send the invoice in when it\'s done.\n\nThanks,\nMillennial Pools' });

// Insurance and registration renewals: dates read from the insurance card / registration files by Claude, editable on the tab
async function readExpiry(f) {
  const r = await fetch(f.url); if (!r.ok) throw new Error('Download ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  let type = (f.type || r.headers.get('content-type') || '').split(';')[0];
  if (!/^image\/(jpeg|png|gif|webp)$|^application\/pdf$/.test(type)) type = buf.slice(0, 4).toString() === '%PDF' ? 'application/pdf' : buf[0] === 0x89 ? 'image/png' : 'image/jpeg';
  const part = { type: type === 'application/pdf' ? 'document' : 'image', source: { type: 'base64', media_type: type, data: buf.toString('base64') } };
  const a = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': AI_KEY(), 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: AI_MODEL, max_tokens: 300, messages: [{ role: 'user', content: [part, { type: 'text', text: 'Is this a vehicle insurance ID card or a vehicle registration? Reply with JSON only: {"kind":"insurance|registration|other","expires":"YYYY-MM-DD or empty","vin":"VIN if printed"}. expires is the policy expiration / registration expiration date. A registration that only shows a month (e.g. NJ "GOOD THRU: 05/2027") expires on the last day of that month.' }] }] }) });
  const j = await a.json().catch(() => ({})); if (!a.ok) throw new Error('Claude ' + a.status);
  const m = (((j.content || [])[0] || {}).text || '').match(/\{[\s\S]*\}/), o = m ? JSON.parse(m[0]) : {};
  return { kind: String(o.kind || ''), expires: /^\d{4}-\d{2}-\d{2}$/.test(o.expires || '') ? o.expires : '' };
}
let renewBusy = false;
async function readRenewals(max = 15) {
  if (renewBusy || !AI_KEY()) return { started: false }; renewBusy = true; let n = 0;
  try {
    const at = await atData(), st = upState();
    for (const t of at.trucks) {
      const docs = t.insCard.map(f => ({ ...f, hint: 'insurance' })).concat(t.files.filter(f => /reg|insur|card|id/i.test(f.name) || t.files.length <= 3));
      const fields = {};
      for (const f of docs) {
        const key = t.id + ':' + f.name; if (st.read[key] || n >= max) continue; n++;
        try { const r = await readExpiry(f); st.read[key] = r.kind || 'other';
          const fld = r.kind === 'insurance' ? 'ins' : r.kind === 'registration' ? 'reg' : '', cur = fld === 'ins' ? t.insExp : t.regExp;
          if (fld && r.expires && (!cur || r.expires > cur)) { fields[fld === 'ins' ? F.insExp : F.regExp] = r.expires; (st.src[t.id] = st.src[t.id] || {})[fld] = f.name; }
        } catch (e) { st.read[key] = 'error'; console.error('Renewal read', tname(t), f.name, e.message); }
      }
      if (Object.keys(fields).length) await airtable(AT_TRUCKS, { method: 'PATCH', body: JSON.stringify({ records: [{ id: t.id, fields }] }) });
    }
    saveUp(st); cache.delete('airtable');
  } finally { renewBusy = false; }
  return { read: n };
}
async function setRenewal(b) {
  const id = clean(b.id), f = {}, ok = v => v === '' || /^\d{4}-\d{2}-\d{2}$/.test(v);
  if ('ins' in b) { if (!ok(b.ins)) throw new Error('Bad date'); f[F.insExp] = b.ins || null; }
  if ('reg' in b) { if (!ok(b.reg)) throw new Error('Bad date'); f[F.regExp] = b.reg || null; }
  if (!(await atData()).trucks.some(t => t.id === id)) throw new Error('Unknown truck');
  await airtable(AT_TRUCKS, { method: 'PATCH', body: JSON.stringify({ records: [{ id, fields: f }] }) }); cache.delete('airtable'); return { ok: true };
}
// Registration / insurance dates the techs type into their weekly truck check-up (POM), sanity-checked before use
const paperCheck = (dt, other, kind, when) => { if (!dt) return null; const ms = Date.parse(dt + 'T12:00'), w = [];
  if (ms > when + (kind === 'reg' ? 800 : 500) * 864e5) w.push('more than ' + (kind === 'reg' ? '2 years' : '16 months') + ' out, probably a typo');
  if (ms < when - 400 * 864e5) w.push('over a year old, probably a typo');
  if (Math.abs(ms - when) < 2 * 864e5) w.push('same day as the check-up, probably not read off the card');
  if (other && other === dt) w.push('same date as the ' + (kind === 'reg' ? 'insurance' : 'registration') + ', one of them is likely wrong');
  return { date: dt, warn: w }; };
const ansOf = v => { const a = {}; (v.customFields || []).forEach(c => { const f = c.newCustomField || c.customField || {}; if (f.name) a[f.name] = c.value; }); return a; };
const ansGet = (a, re) => { const k = Object.keys(a).find(n => re.test(n)); return k ? clean(a[k]) : ''; };
const ymdOf = x => { const ms = Date.parse(x); return ms ? new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) : ''; };
const svcSeen = new Map();
const checkupPaperwork = () => cached('ckPaper', 3 * 3600, async () => {
  if (!clean(process.env.POM_API_KEY)) return {};
  const d = await routes['/api/pom/checkups'](new URLSearchParams('weeks=6')), at = await atData(), out = {}, latest = {};
  const drivers = at.trucks.filter(t => t.driver && t.driver.name).map(t => ({ name: t.driver.name, t }));
  for (const c of d.checkups || []) if (c.done && c.service && !latest[c.tech]) latest[c.tech] = c;   // newest first
  for (const c of Object.values(latest)) {
    let v = svcSeen.get(c.service); if (!v) { v = await pomService(c.service).catch(() => null); if (v) svcSeen.set(c.service, v); await sleep(250); }
    if (!v) continue;
    const a = ansOf(v), which = ansGet(a, /which truck/i), when = Date.parse(v.endTime || v.startTime || c.time) || Date.now();
    const vin = (which.toUpperCase().match(/[A-HJ-NPR-Z0-9]{17}/) || [])[0], num = (which.match(/^\s*#?\s*(\d{1,2})\b/) || [])[1];
    const t = (vin && at.trucks.find(x => x.vin === vin)) || (num && at.trucks.find(x => parseInt(x.truckNo) === +num)) || (rampMatch(drivers, c.tech) || {}).t;
    if (!t || (out[t.id] && out[t.id].when > when)) continue;
    const reg = ymdOf(ansGet(a, /regist/i)), ins = ymdOf(ansGet(a, /insur/i)), by = { who: c.tech, on: new Date(when).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }), service: c.service };
    out[t.id] = { when, reg: reg && { ...paperCheck(reg, ins, 'reg', when), ...by }, ins: ins && { ...paperCheck(ins, reg, 'ins', when), ...by } };
  }
  return out;
});
// Each truck's dates: the later of the Airtable date (from the card / registration file) and a check-up date that passed the checks
async function renewRows() {
  const at = await atData(), ck = await checkupPaperwork().catch(e => { console.error('Check-up paperwork:', e.message); return {}; });
  return at.trucks.map(t => { const c = ck[t.id] || {};
    const pick = (air, tech) => tech && tech.date && !tech.warn.length && (!air || tech.date > air) ? { date: tech.date, src: 'checkup' } : { date: air || '', src: air ? 'airtable' : '' };
    const ins = pick(t.insExp, c.ins), reg = pick(t.regExp, c.reg);
    return { t, id: t.id, name: tname(t), plate: t.plate, policy: t.policy, ins: ins.date, insSrc: ins.src, insAir: t.insExp, insTech: c.ins || null, insLeft: daysTo(ins.date),
      reg: reg.date, regSrc: reg.src, regAir: t.regExp, regTech: c.reg || null, regLeft: daysTo(reg.date), card: (t.insCard[0] || {}).url || '' }; });
}
const daysTo = d => d ? Math.round((Date.parse(d + 'T12:00') - Date.now()) / 864e5) : null;
async function attach(t, kind) {   // the card the date came from, else the first insurance card
  const st = upState(), name = (st.src[t.id] || {})[kind], f = t.insCard.concat(t.files).find(x => x.name === name) || (kind === 'ins' ? t.insCard[0] : t.files.find(x => /reg/i.test(x.name)));
  if (!f) return [];
  const r = await fetch(f.url); return r.ok ? [{ name: f.name, type: f.type, data: Buffer.from(await r.arrayBuffer()).toString('base64') }] : [];
}
async function renewalMail(force) {
  const st = upState(), at = await atData(), to = UPKEEP_TO, sent = [];
  for (const x of await renewRows()) for (const [kind, d, label] of [['ins', x.ins, 'Insurance'], ['reg', x.reg, 'Registration']]) { const t = x.t;
    const left = daysTo(d), key = 'renew:' + t.id + ':' + kind + ':' + d;
    if (left === null || left > 30 || left < -30 || (st.sent[key] && !force)) continue;
    await sendMail(to, label + (left < 0 ? ' expired' : ' renews in ' + left + ' day' + (left === 1 ? '' : 's')) + ': ' + tname(t),
      'Hi Callum,\n\n' + label + ' for ' + tname(t) + (t.plate ? ' (plate ' + t.plate + ')' : '') + (left < 0 ? ' expired on ' : ' expires on ') + new Date(d + 'T12:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) + '.' +
      (kind === 'ins' && t.policy ? '\nPolicy: ' + t.policy : '') + (t.driver ? '\nDriver: ' + t.driver.name : '') + '\n\nThe current card from Airtable is attached.\n\nFleet dashboard', await attach(t, kind).catch(() => []));
    st.sent[key] = Date.now(); sent.push(tname(t) + ' ' + label.toLowerCase());
  }
  saveUp(st); return { sent };
}

// Weekly safety email: score, rank, worst camera event this week, and the private report link with the clips
async function safetyText(name, fleet) {
  fleet = fleet || await fleetReport(); const me = fleet.find(x => dupeName(x.name) === dupeName(name));
  if (!me) return null;
  const td = await truckDrivers(), wk = Date.now() - 7 * 864e5;
  const ev = (await events30()).filter(x => (x.t || evTime(x)) > wk && dupeName(eventOwner(x, td)) === dupeName(name)).map(x => ({ x, k: eventKind(x.eventType), t: x.t || evTime(x) })).filter(e => e.k.pts)
    .sort((a, b) => b.k.pts - a.k.pts || b.t - a.t);
  const link = (lastBase || 'https://fleet-dashboard-oxei.onrender.com') + '/r/' + signShare({ k: 'd', n: me.name }, 14), first = me.name.split(' ')[0];
  const when = t => new Date(t).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return { name: me.name, subject: 'Your driving this week: ' + me.r.score + '/100', body: 'Hi ' + first + ',\n\nYour driver score: ' + me.r.score + ' out of 100, #' + me.r.rank + ' of ' + fleet.length + ' drivers.\n\n' +
    (ev.length ? 'Your worst camera event this week: ' + ev[0].k.label + ' on ' + when(ev[0].t) + (ev.length > 1 ? ' (' + ev.length + ' events in all)' : '') + '.' : 'No camera events this week. Nice work.') +
    '\n\nWatch the clip and see your full report (private to you, link works for 2 weeks):\n' + link + '\n\nThanks,\nMillennial Pools', events: ev.length };
}
async function safetyMail() {
  const st = upState(), fleet = await fleetReport(), sent = [], skipped = [];
  for (const row of fleet) { const key = 'safety:' + weekKey() + ':' + dupeName(row.name); if (st.sent[key]) continue;
    const to = await emailOf(row.name), bad = ((mailState().bounced) || []);   // safety emails go to the driver themselves
    if (!to || bad.includes(to.toLowerCase())) { skipped.push(row.name); continue; }
    const m = await safetyText(row.name, fleet);
    try { await sendMail(to, m.subject, m.body); st.sent[key] = Date.now(); sent.push(row.name); } catch (e) { console.error('Safety email', row.name, e.message); }
  }
  saveUp(st); return { sent, skipped };
}
async function oilMail() {
  const st = upState(), sent = [];
  for (const o of (await oilList()).filter(x => x.status === 'due' && x.driver)) { const key = 'oil:' + weekKey() + ':' + o.id, to = UPKEEP_TO;
    if (st.sent[key]) continue; const m = oilText(o);
    try { await sendMail(to, m.subject + ' (' + o.driver + ')', m.body); st.sent[key] = Date.now(); sent.push(o.name); } catch (e) { console.error('Oil email', o.name, e.message); } }
  saveUp(st); return { sent };
}
// Hourly: renewals (daily, 8 AM+), and on Mondays from 8 AM the safety + oil emails (each once a week)
async function upkeepTick() {
  const st = upState(), et = etNow(); if (et.getHours() < 8 || !mailReady()) return;
  const day = et.toLocaleDateString('en-CA');
  if (st.renew && st.lastRenew !== day) { st.lastRenew = day; saveUp(st); await renewalMail().catch(e => console.error('Renewal emails:', e.message)); }
  if (et.getDay() === 1) {
    if (st.safety && st.lastSafety !== weekKey()) { st.lastSafety = weekKey(); saveUp(st); await safetyMail().catch(e => console.error('Safety emails:', e.message)); }
    if (st.oil && st.lastOil !== weekKey()) { st.lastOil = weekKey(); saveUp(st); await oilMail().catch(e => console.error('Oil emails:', e.message)); }
  }
}
if (process.argv[2] !== 'test') {
  setInterval(upkeepTick, 60 * 60e3); setTimeout(upkeepTick, 6 * 60e3);
  setInterval(() => checkGas(), 30 * 60e3); setTimeout(() => checkGas(), 8 * 60e3);
  setInterval(() => readRenewals().catch(() => {}), 12 * 3600e3); setTimeout(() => readRenewals().catch(() => {}), 10 * 60e3);
}
routes['/api/upkeep'] = async () => {
  const st = upState(), at = await atData(), done = gasChk();
  const [cost, oil] = await Promise.all([truckCost().catch(e => ({ error: e.message })), oilList().catch(e => ({ error: e.message }))]);
  const tk = Object.fromEntries(at.trucks.map(t => [t.id, t]));
  const gas = Object.entries(done).map(([id, x]) => ({ id, ...x, truck: tk[x.truckId] ? tname(tk[x.truckId]) : '', tank: tankOf(tk[x.truckId]), link: 'https://app.ramp.com/business-overview/transactions/' + id })).sort((a, b) => b.flags.length - a.flags.length || Date.parse(b.at) - Date.parse(a.at));
  const renew = (await renewRows()).map(({ t, ...x }) => x);
  return { cost, oil, oilMiles: OIL_MI, gas, gasBusy, renew, settings: { safety: st.safety, oil: st.oil, renew: st.renew }, mail: mailReady(), ai: !!AI_KEY() };
};
routes['/api/upkeep/flags'] = () => ({ gas: Object.values(gasChk()).filter(x => x.verdict === 'far').length });
routes['/api/upkeep/safety-preview'] = async q => (await safetyText(q.get('name') || 'Callum Curcie')) || { error: 'No score for that name yet.' };
const UPKEEP_POSTS = {
  '/api/upkeep/settings': b => { const st = upState(); ['safety', 'oil', 'renew'].forEach(k => { if (k in b) st[k] = b[k] === true; }); saveUp(st); return { safety: st.safety, oil: st.oil, renew: st.renew }; },
  '/api/upkeep/renewal': setRenewal,
  '/api/upkeep/read-cards': () => { readRenewals(40).catch(e => console.error('Renewals:', e.message)); return { started: true }; },
  '/api/upkeep/gas-check': () => { checkGas(40); return { started: true }; },
  '/api/upkeep/safety-sample': async b => { const m = await safetyText(clean(b.name) || 'Callum Curcie'); if (!m) throw new Error('No score for that name yet.');
    const to = UPKEEP_TO; await sendMail(to, 'SAMPLE · ' + m.subject, m.body + '\n\n(Sample of the weekly email ' + m.name + ' would get.)'); return { to, name: m.name }; },
  '/api/upkeep/oil-sample': async () => { const o = (await oilList()).find(x => x.status === 'due') || (await oilList())[0]; if (!o) throw new Error('No trucks');
    const m = oilText({ ...o, driver: o.driver || 'Driver' }), to = UPKEEP_TO; await sendMail(to, 'SAMPLE · ' + m.subject, m.body); return { to, name: o.name }; },
  '/api/upkeep/renewal-test': async () => renewalMail(true),
};

// ---------------- Airtable "Cameras" + "Camera events" tables and the Trucks "Has Azuga tracker" box (hourly) ----------------
const AT_CAMS = 'tblLoVcQu5D9NDk77', CAM = { name: 'fldgORV66c1z9CWmb', truck: 'fldjyBQUVhW3aUClx', vehicle: 'fldd8MIj3pHn5A9HC', azId: 'fldsCnZn9qjDFn21j', driver: 'fld6IKjNDKuSHko8d', status: 'fldaxpmk2NHXqq7F4', n30: 'fldLn2wzxzeQxrKkd', last: 'fldUFpdFHxO5GZD7O', synced: 'fldoW0d4i2ACxQOZq' };
const AT_CAMEV = 'tblin63fFw2KKRfoo', CEV = { name: 'fldUAQznI5JnZIsSZ', key: 'fldXuDDvWND9qDZzw', when: 'fldNE0teW4wtmc3ii', type: 'fld31MQ0JclIgXv3H', pts: 'fld8mu2qOmRybBL6n', driver: 'fldYEjamgXSgnnHDR', truck: 'fldnErQwM6AEfv5d8', camera: 'fldiLX1kwXa3XbtFo', where: 'fldSnO5oNWAIqlLfb', mph: 'fldlf3Dv41n1dIhvL' };
const camState = () => (cache.get('camSync') || {}).data || { keys: [], at: 0, last: null };
let camBusy = false;
async function syncCameras() {
  if (camBusy || !AIRTABLE_TOKEN) return { busy: camBusy }; camBusy = true;
  const out = { trackers: 0, cameras: 0, events: 0, at: Date.now() };
  try {
    const [vs, L, at, evs, old] = await Promise.all([routes['/api/vehicles']().then(list), atLinks(), atData(), events30(), atAll(AT_CAMS, Object.values(CAM))]);
    // A camera whose Azuga vehicle isn't matched to a truck can be given one by hand in the Cameras table; that choice is kept
    const links = L.links || {}, manual = {};
    old.forEach(r => { const id = clean(r.fields[CAM.azId]), tk = (r.fields[CAM.truck] || [])[0], l = links[id]; if (id && tk && !(l && l.linked) && at.trucks.some(t => t.id === tk)) manual[id] = tk; });
    { const c = cache.get('camSync') || { data: { keys: [] } }; c.data = { ...c.data, manual }; c.t = Date.now(); cache.set('camSync', c); cache.delete('truckDrivers'); }
    const td = await truckDrivers();
    const truckOf = v => { const l = links[v.trackeeId]; return l && l.linked ? l.truck : manual[v.trackeeId] ? at.trucks.find(t => t.id === manual[v.trackeeId]) : null; };
    // 1. Trucks: tick "Has Azuga tracker" for every truck matched to a tracker, untick the rest
    const withT = new Set(vs.map(v => { const l = links[v.trackeeId]; return l && l.linked ? l.truck.id : null; }).filter(Boolean)), fix = at.trucks.filter(t => t.hasTracker !== withT.has(t.id)).map(t => ({ id: t.id, fields: { [F.hasTracker]: withT.has(t.id) } }));
    for (let i = 0; i < fix.length; i += 10) { await airtable(AT_TRUCKS, { method: 'PATCH', body: JSON.stringify({ records: fix.slice(i, i + 10) }) }); await sleep(250); }
    out.trackers = fix.length; if (fix.length) cache.delete('airtable');
    // 2. Cameras: one row per SafetyCam (matched on its serial); Broken / Spare / Removed set by hand are kept
    const byName = Object.fromEntries(old.map(r => [clean(r.fields[CAM.name]), r]));
    const since = Date.now() - 30 * 864e5, perV = {};
    evs.forEach(x => { const t = x.t || evTime(x); if (t < since || !eventKind(x.eventType).pts) return; const p = perV[x.vehicleId] = perV[x.vehicleId] || { n: 0, last: 0 }; p.n++; p.last = Math.max(p.last, t); });
    const cams = vs.filter(v => clean(v.safetyCamSerialNumber || v.safetyCam)), seen = new Set(), recs = [];
    for (const v of cams) {
      const serial = clean(v.safetyCamSerialNumber || v.safetyCam), t = truckOf(v), prev = byName[serial], keep = prev && /broken|spare|removed/i.test((prev.fields[CAM.status] || {}).name || prev.fields[CAM.status] || '');
      seen.add(serial);
      recs.push({ fields: { [CAM.name]: serial, [CAM.truck]: t ? [t.id] : [], [CAM.vehicle]: clean(v.name || v.trackeeName || v.vehicleName), [CAM.azId]: String(v.trackeeId), [CAM.driver]: clean(td[v.trackeeId]),
        ...(keep ? {} : { [CAM.status]: t ? 'Installed' : 'Not linked to a truck' }), [CAM.n30]: (perV[v.trackeeId] || {}).n || 0,
        [CAM.last]: (perV[v.trackeeId] || {}).last ? new Date(perV[v.trackeeId].last).toISOString() : null, [CAM.synced]: new Date().toISOString() } });
    }
    old.filter(r => !seen.has(clean(r.fields[CAM.name])) && /installed|not linked/i.test(((r.fields[CAM.status] || {}).name || r.fields[CAM.status] || ''))).forEach(r => recs.push({ fields: { [CAM.name]: clean(r.fields[CAM.name]), [CAM.status]: 'Removed', [CAM.synced]: new Date().toISOString() } }));
    for (let i = 0; i < recs.length; i += 10) { await airtable(AT_CAMS, { method: 'PATCH', body: JSON.stringify({ performUpsert: { fieldsToMergeOn: [CAM.name] }, typecast: true, records: recs.slice(i, i + 10) }) }); await sleep(250); }
    out.cameras = cams.length; out.byHand = Object.keys(manual).length;
    // 3. Camera events: last 30 days, real alerts only (camera notices skipped), each added once
    const camRecs = await atAll(AT_CAMS, [CAM.name, CAM.azId]), camOf = Object.fromEntries(camRecs.map(r => [clean(r.fields[CAM.azId]), r.id]));
    const st = camState(), done = new Set(st.keys), recent = list(await routes['/api/videos'](new URLSearchParams()).catch(() => [])), full = {};
    recent.forEach(x => { full[[x.vehicleId, evTime(x), x.eventType].join('|')] = x; });
    const vByT = Object.fromEntries(vs.map(v => [String(v.trackeeId), v])), add = [];
    for (const x of evs.filter(x => (x.t || evTime(x)) >= since).sort((a, b) => (a.t || evTime(a)) - (b.t || evTime(b)))) {
      const t = x.t || evTime(x), k = [x.vehicleId, t, x.eventType].join('|'), kind = eventKind(x.eventType);
      if (done.has(k) || !kind.pts) continue;
      const v = vByT[String(x.vehicleId)], tr = v && truckOf(v), f = full[k] || {}, who = eventOwner(x, td);
      add.push({ k, fields: { [CEV.name]: (kind.label || 'Event') + ' · ' + (who || 'Unknown') + ' · ' + new Date(t).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
        [CEV.key]: k, [CEV.when]: new Date(t).toISOString(), [CEV.type]: kind.label || clean(x.eventType), [CEV.pts]: kind.pts, [CEV.driver]: who,
        ...(tr ? { [CEV.truck]: [tr.id] } : {}), ...(camOf[String(x.vehicleId)] ? { [CEV.camera]: [camOf[String(x.vehicleId)]] } : {}),
        [CEV.where]: clean(f.address || f.location || ''), ...(f.speed ? { [CEV.mph]: Math.round(+f.speed * 0.621371) } : {}) } });
    }
    for (let i = 0; i < add.length; i += 10) {
      const part = add.slice(i, i + 10);
      await airtable(AT_CAMEV, { method: 'PATCH', body: JSON.stringify({ performUpsert: { fieldsToMergeOn: [CEV.key] }, typecast: true, records: part.map(a => ({ fields: a.fields })) }) });
      part.forEach(a => done.add(a.k)); await sleep(250);
    }
    out.events = add.length;
    const keep = [...done].filter(k => +k.split('|')[1] > Date.now() - 45 * 864e5);
    const ns = { keys: keep, at: out.at, last: out, manual }; cache.set('camSync', { data: ns, t: Date.now() }); saveSnap('camSync', ns);
    console.log(new Date().toISOString(), 'Airtable cameras synced:', JSON.stringify(out));
  } catch (e) { out.error = e.message; console.error('Camera sync:', e.message); } finally { camBusy = false; }
  return out;
}
if (process.argv[2] !== 'test' && AIRTABLE_TOKEN) { setTimeout(() => syncCameras(), 4 * 60e3); setInterval(() => syncCameras(), 60 * 60e3); }
routes['/api/cameras/sync-status'] = () => ({ busy: camBusy, ...camState(), keys: undefined });
// ---------------- Pool visits: time each tech's truck spent at each scheduled pool (Azuga GPS), one row per visit in Airtable "Pool visits" ----------------
const AT_VIS = 'tbluerTi9eXWDU9if', VIS = { name: 'fld7U3SsUZ30RoXVQ', key: 'fldmStwClNSwxbLdo', date: 'fldRQTn65zhEhoMoX', tech: 'fldFiwsaOtyQlSx4F', pool: 'fld9sewnDCen43WoB', addr: 'fldbs4X1HGDnuBNEA',
  mins: 'fldSuhmwtaTpO1Zbu', arr: 'fldIU9Ztb7NYqKLTs', left: 'fldV6xyN3FhXA4vGe', type: 'fld3jdlrXTrtIQrqi', status: 'fldO9Ry5EsIr8aRoK', truck: 'fldPSpFIs806AL36b' };
const VIS_DAYS = +process.env.VISIT_BACKFILL_DAYS || 90;   // how far back to work out visits from GPS history
const VIS_MIN = 2, VIS_MAX = 240;   // a truck there under 2 min drove past; over 4 h is a parked truck, not a service
const visState = () => (cache.get('visDays2') || {}).data || { days: [] };   // v2: redone once with the wider ring + address lookups
let visBusy = false;
async function logVisitDay(ymd) {
  const { start, end } = etDay(new Date(ymd + 'T16:00:00Z')), inDay = s => { const t = Date.parse(s.time); return t >= +start && t <= +end; };
  const techs = [...new Set((await pomDay(ymd)).map(pomStop).filter(s => !pomCheckup(s) && s.tech && inDay(s)).map(s => s.tech))];
  const L = (await atLinks()).links || {}, recs = [];
  for (const tech of techs) {
    const v = await visitsFor(tech, ymd).catch(() => null); if (!v || !v.trucks || !v.trucks.length) continue;
    const tk = v.trucks.map(id => L[id] && L[id].linked ? L[id].truck.id : null).filter(Boolean)[0];
    for (const s of v.stops) {
      if (!s.visit || !inDay(s)) continue;
      recs.push({ fields: { [VIS.name]: (s.customer || 'Pool') + ' · ' + tech + ' · ' + ymd, [VIS.key]: s.id + '|' + ymd, [VIS.date]: ymd, [VIS.tech]: tech, [VIS.pool]: s.customer || '', [VIS.addr]: s.address || '',
        [VIS.mins]: s.visit.mins, [VIS.arr]: new Date(s.visit.arrive).toISOString(), [VIS.left]: new Date(s.visit.leave).toISOString(), [VIS.type]: s.type || '', [VIS.status]: s.done ? 'Done' : 'Not done', ...(tk ? { [VIS.truck]: [tk] } : {}) } });
    }
    await sleep(500);
  }
  for (let i = 0; i < recs.length; i += 10) { await airtable(AT_VIS, { method: 'PATCH', body: JSON.stringify({ performUpsert: { fieldsToMergeOn: [VIS.key] }, typecast: true, records: recs.slice(i, i + 10) }) }); await sleep(250); }
  return recs.length;
}
// Works back from yesterday a few days per run until VIS_DAYS are logged; each new day is added the morning after
async function visitBackfill(max = 3) {
  if (visBusy || !AIRTABLE_TOKEN || !clean(process.env.POM_API_KEY)) return; visBusy = true;
  try {
    const done = new Set(visState().days); let n = 0;
    for (let i = 1; i <= VIS_DAYS && n < max; i++) {
      const ymd = etDay(new Date(Date.now() - i * 864e5)).ymd; if (done.has(ymd)) continue; n++;
      const c = await logVisitDay(ymd); done.add(ymd); cache.delete('visAll'); cache.delete('poolTime');
      const ns = { days: [...done].sort().slice(-(VIS_DAYS + 10)) }; cache.set('visDays2', { data: ns, t: Date.now() }); saveSnap('visDays2', ns);
      console.log(new Date().toISOString(), 'Pool visits logged for', ymd + ':', c);
    }
  } catch (e) { console.error('Pool visits:', e.message); } finally { visBusy = false; }
}
if (process.argv[2] !== 'test') { setTimeout(() => visitBackfill(), 7 * 60e3); setInterval(() => visitBackfill(), 20 * 60e3); }
const allVisits = () => cached('visAll', 1800, async () => (await atAll(AT_VIS, [VIS.date, VIS.tech, VIS.pool, VIS.addr, VIS.mins, VIS.arr, VIS.status, VIS.type])).map(r => { const f = r.fields;
  return { d: f[VIS.date] || '', tech: f[VIS.tech] || '', pool: f[VIS.pool] || '', addr: f[VIS.addr] || '', m: +f[VIS.mins] || 0, a: f[VIS.arr] || '', t: f[VIS.type] || '', done: ((f[VIS.status] && f[VIS.status].name) || f[VIS.status]) === 'Done' }; }));
// Only regular tech visits set a tech's average; winterizing, closing crew, check-ups, repairs etc. take a different amount of time
const isTechVisit = x => !x.t || /tech\s*visit/i.test(x.t);
const visAgg = (list, key) => { const g = {}; list.forEach(x => (g[x[key]] = g[x[key]] || []).push(x));
  return Object.entries(g).map(([k, xs]) => { const ms = xs.map(x => x.m).sort((a, b) => a - b), tot = ms.reduce((a, b) => a + b, 0);
    return { name: k, n: xs.length, avg: Math.round(tot / ms.length), med: ms[Math.floor(ms.length / 2)], short: xs.filter(x => x.m < 8).length, total: tot, days: new Set(xs.map(x => x.d)).size }; }); };
routes['/api/pools/time'] = async q => {
  const days = Math.max(1, Math.min(400, +q.get('days') || 30)), since = etDay(new Date(Date.now() - days * 864e5)).ymd;
  return cached('poolTime:' + days, 600, async () => {
    const every = (await allVisits()).filter(x => x.tech && x.m >= VIS_MIN && x.m <= VIS_MAX), all = every.filter(isTechVisit), vAll = every.filter(x => x.d >= since), v = vAll.filter(isTechVisit), other = vAll.filter(x => !isTechVisit(x));
    const base = Object.fromEntries(visAgg(all, 'tech').map(t => [t.name, t]));   // every visit on record: the average to expect going forward
    const techs = visAgg(v, 'tech').map(t => ({ ...t, perDay: Math.round(t.n / Math.max(1, t.days) * 10) / 10, allAvg: base[t.name] ? base[t.name].avg : t.avg, allN: base[t.name] ? base[t.name].n : t.n,
      pools: visAgg(v.filter(x => x.tech === t.name), 'pool').sort((a, b) => b.n - a.n).slice(0, 25),
      jobs: visAgg(other.filter(x => x.tech === t.name), 't').sort((a, b) => b.n - a.n),
      recent: vAll.filter(x => x.tech === t.name).sort((a, b) => b.a.localeCompare(a.a)).slice(0, 30).map(x => ({ d: x.d, a: x.a, pool: x.pool, m: x.m, done: x.done, t: isTechVisit(x) ? '' : x.t })) })).sort((a, b) => b.n - a.n);
    const pools = visAgg(v, 'pool').map(p => ({ ...p, addr: (v.find(x => x.pool === p.name) || {}).addr || '', techs: visAgg(v.filter(x => x.pool === p.name), 'tech').map(t => ({ name: t.name, avg: t.avg, n: t.n })).sort((a, b) => b.n - a.n) })).sort((a, b) => b.n - a.n).slice(0, 400);
    return { days, since, visits: v.length, fleetAvg: v.length ? Math.round(v.reduce((a, x) => a + x.m, 0) / v.length) : 0, logged: visState().days.length, backfill: VIS_DAYS,
      oldest: every.reduce((m, x) => x.d && x.d < m ? x.d : m, '9999'), jobs: visAgg(other, 't').sort((a, b) => b.n - a.n), techs, pools };
  });
};
routes['/api/pools/averages'] = async () => ({ techs: Object.fromEntries(visAgg((await allVisits()).filter(x => x.tech && x.m >= VIS_MIN && x.m <= VIS_MAX && isTechVisit(x)), 'tech').map(t => [t.name, { avg: t.avg, n: t.n }])) });

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
  if (!process.env.PUBLIC_URL && req.headers.host && !/localhost|127\.0\.0\.1/.test(req.headers.host)) lastBase = base;
  // Public SMS policy pages (needed for the Textedly / carrier 10DLC registration). No login.
  if (req.url === '/privacy' || req.url === '/terms') {
    const page = (title, body) => '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + title + ' · Millennial Pools</title><style>body{margin:0;font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a;background:#eef6f9}.w{max-width:760px;margin:0 auto;padding:32px 20px 60px}.c{background:#fff;border-radius:16px;padding:28px;box-shadow:0 2px 10px rgba(15,23,42,.06)}h1{margin:0 0 4px;font-size:26px}h2{font-size:17px;margin:22px 0 6px}.m{color:#64748b;font-size:14px}</style></head><body><div class="w"><div class="c"><h1>' + title + '</h1><p class="m">Millennial Pool Management LLC · 1041 Glassboro Road, Monroe Township, NJ 08094 · contact@millennialpools.com · Updated October 2026</p>' + body + '</div></div></body></html>';
    const privacy = '<p>This policy covers the text messages (SMS) Millennial Pools sends to its own employees about their work vehicles.</p>'
      + '<h2>What we collect</h2><p>Your name and mobile phone number, which you give us as an employee, and the record of the texts we send you and any replies.</p>'
      + '<h2>How we use it</h2><p>Only to send work texts such as weekly truck check-up reminders, vehicle maintenance reminders and truck assignment confirmations.</p>'
      + '<h2>Sharing</h2><p>We do not sell, rent or share your phone number or opt-in consent with any third party or affiliate for marketing. Your number is shared only with our texting provider (Textedly) so it can deliver our messages.</p>'
      + '<h2>Opting out</h2><p>Reply STOP to any message to stop receiving texts. Reply HELP for help, or email contact@millennialpools.com.</p>';
    const terms = '<h2>Program</h2><p>Millennial Pools Work Alerts: text messages to Millennial Pools employees about their work vehicles, such as weekly truck check-up reminders, maintenance reminders and truck assignment confirmations.</p>'
      + '<h2>Signing up</h2><p>Employees opt in by texting the keyword TRUCK to (609) 640-3140. You will get a confirmation text.</p>'
      + '<h2>Message frequency</h2><p>Message frequency varies, usually 1 to 2 messages per week.</p>'
      + '<h2>Costs</h2><p>Message and data rates may apply. Carriers are not liable for delayed or undelivered messages.</p>'
      + '<h2>Help and stopping</h2><p>Reply HELP for help or contact contact@millennialpools.com. Reply STOP at any time to cancel; you will get one final message confirming you are unsubscribed.</p>'
      + '<h2>Privacy</h2><p>See our <a href="/privacy">Privacy Policy</a>.</p>';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
    return res.end(req.url === '/privacy' ? page('Privacy Policy', privacy) : page('SMS Terms and Conditions', terms));
  }
  if (req.url.startsWith('/r/')) {   // shared report: no login, but only with a valid signed link
    const [tok, sub] = req.url.slice(3).split('?')[0].split('/'), o = readShare(tok);
    if (!o) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('This report link is invalid or has expired. Ask for a new one.'); }
    if (o.k === 'i') {   // invoice upload link: can add invoices, can't see anything else
      try {
        if (sub === 'read') {
          if (req.method !== 'POST' || !/application\/json/.test(req.headers['content-type'] || '')) { res.writeHead(405); return res.end(); }
          const out = await readInvoice(await readJson(req, 30e6));
          res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(out));
        }
        if (sub === 'add') {
          if (req.method !== 'POST' || !/application\/json/.test(req.headers['content-type'] || '')) { res.writeHead(405); return res.end(); }
          const out = await addRepair(await readJson(req, 30e6));
          console.log(new Date().toISOString(), 'Invoice added through the shared upload link');
          res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, oil: !!out.oil }));
        }
        if (sub) { res.writeHead(404); return res.end(); }
        const at = await atData();
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' }); return res.end(invoicePage(at.trucks));
      } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: e.message })); }
    }
    if (o.k === 's') {   // QR sticker: sign-in request / sign-out page
      try {
        if (sub === 'request' || sub === 'out') {
          if (req.method !== 'POST' || !/application\/json/.test(req.headers['content-type'] || '')) { res.writeHead(405); return res.end(); }
          const b = await readJson(req), out = sub === 'out' ? await signOutSelf(b) : await requestSignIn(b);
          res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(out));
        }
        if (sub) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' }); return res.end(signPage(await atData()));
      } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: e.message })); }
    }
    if (o.k !== 'd' && o.k !== 'f') { res.writeHead(404); return res.end(); }
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
  const POSTS = { '/api/repair/read': readInvoice, '/api/pom/checkup-oneoff': oneOffCheckups, '/api/mail/test': () => mailTest(), '/api/mail/now': b => { if (b.confirm !== 'SEND') throw new Error('Confirmation missing.'); return mailNow(); }, '/api/mail/auto': b => { const st = mailState(); if (b.on === true && !mailReady()) throw new Error('Add the Outlook email settings in Render first.'); st.auto = b.on === true; saveMail(st); return { auto: st.auto }; }, '/api/repair/add': addRepair, '/api/cameras/sync': () => syncCameras(), '/api/text/test': () => textTest(), '/api/svc/test': () => svcTest(), '/api/eod/test': () => eodTest(), '/api/eod/auto': b => { const st = mailState(); if (b.on === true && !mailReady()) throw new Error('Add the Outlook email settings in Render first.'); st.eod = { ...(st.eod || {}), on: b.on === true }; saveMail(st); return { on: st.eod.on }; }, '/api/svc/auto': b => { const st = mailState(); if (b.on === true && !mailReady()) throw new Error('Add the Outlook email settings in Render first.'); st.svc = { ...(st.svc || { day: '', sent: {} }), on: b.on === true }; saveMail(st); return { on: st.svc.on }; }, '/api/text/now': b => { if (b.confirm !== 'SEND') throw new Error('Confirmation missing.'); return textMissed(); }, '/api/text/auto': b => { const st = mailState(); if (b.on === true && !TXT_KEY()) throw new Error('Add TEXTEDLY_API_KEY in Render first.'); st.sms = b.on === true; saveMail(st); return { sms: st.sms }; }, '/api/repair/link': () => ({ url: '/r/' + signShare({ k: 'i' }, 365), days: 365 }), '/api/truck/note': addTruckNote, '/api/purchase/status': setItemStatus, '/api/purchase/items': saveItemsByHand, '/api/purchase/gas': saveGasByHand, '/api/purchase/read': () => { readReceipts(25).catch(() => {}); return { started: true }; }, '/api/truck/request': decideRequest, '/api/truck/note-delete': deleteTruckNote, '/api/pom/checkup-apply': b => applyCheckups(b.all === true ? 'all' : Array.isArray(b.keys) ? b.keys.map(String).slice(0, 50) : []),
    '/api/pom/checkup-auto': b => { const on = b.on === true; cache.set('chkAuto', { data: { on }, t: Date.now() }); saveSnap('chkAuto', { on }); if (on) setTimeout(autoCheckups, 1000); return { on }; },
    '/api/sync/import': b => { if (b.confirm !== 'COPY') throw new Error('Confirmation missing.'); return reconcile('import'); }, '/api/sync/now': () => reconcile(), '/api/update': saveTruck, '/api/sync': b => syncOne(String(b.trackeeId || '')), '/api/driver/create': createDriver, '/api/driver/update': updateDriver, '/api/driver/remove': deleteDriver, '/api/driver/azuga': addDriverToAzuga, '/api/driver/merge': mergeDrivers, '/api/driver/delete': deleteBlankDriver, '/api/driver/status': setDriverStatus };
  Object.assign(POSTS, UPKEEP_POSTS);
  if (POSTS[url.pathname]) {
    // JSON-only + POST-only, so another website can't trigger a change with a plain form
    if (req.method !== 'POST' || !/application\/json/.test(req.headers['content-type'] || '')) { res.writeHead(405); return res.end(); }
    try {
      const b = await readJson(req, /^\/api\/repair\/(add|read)$/.test(url.pathname) ? 30e6 : /^\/api\/driver\/(create|update)$/.test(url.pathname) ? 8e6 : 10000);  // room for a license photo
      const out = await POSTS[url.pathname](b);
      res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(out));
    } catch (e) {
      console.error('Update failed:', e.message);
      res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: e.message }));
    }
  }
  if (url.pathname === '/api/media') return media(url.searchParams.get('u'), req, res);
  if (url.pathname === '/receipts') { try { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(await receiptsPage(url.searchParams.get('gas') === '1')); } catch (e) { res.writeHead(502); return res.end(e.message); } }
  if (url.pathname === '/api/purchase/receipt') return receiptFile(url.searchParams.get('id'), res);
  if (url.pathname === '/stickers') { try { const at = await atData(); res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(stickersPage(at, base)); } catch (e) { res.writeHead(502); return res.end(e.message); } }
  if (url.pathname === '/checkup') return serveCheckup(res, url.searchParams.get('id'));
  if (url.pathname === '/report') return serveReport(res, url.searchParams.get('driver') ? 'driver' : 'fleet', url.searchParams.get('driver'), base, false);
  const route = routes[url.pathname];
  if (!route) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(PAGE_OUT); }
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
<script>(function(){var t;try{t=localStorage.getItem('theme')}catch(e){}document.documentElement.dataset.theme=t||(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light')})()</script>
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
.logo{animation:bob 4s ease-in-out infinite}
@property --la{syntax:'<angle>';inherits:false;initial-value:0deg}
.logo{border:2px solid transparent;background:linear-gradient(var(--pool),var(--pool)) padding-box,conic-gradient(from var(--la),#22d3ee,#a78bfa,#f472b6,#facc15,#22d3ee) border-box;animation:bob 4s ease-in-out infinite,lspin 3.5s linear infinite;box-shadow:0 0 14px -2px rgba(34,211,238,.6)}
@keyframes lspin{to{--la:360deg}}@keyframes bob{50%{transform:translateY(-2px) rotate(-3deg)}}
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
.toast.bad{background:var(--bad)}@keyframes tin{from{opacity:0;transform:translateY(8px)}}@media (prefers-reduced-motion:reduce){.toast{animation:none}
.toast{overflow:hidden;animation:tpop .35s cubic-bezier(.2,1.4,.4,1)}.toast::after{content:'';position:absolute;left:0;bottom:0;height:3px;width:100%;background:linear-gradient(90deg,#22d3ee,#a3e635);transform-origin:left;animation:tbar 4s linear forwards}.toast.bad::after{background:#fecaca}
@keyframes tpop{from{opacity:0;transform:translateY(14px) scale(.92)}}@keyframes tbar{to{transform:scaleX(0)}}}
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
.tabs button{position:relative}.tabs button.on::after{content:'';position:absolute;left:16%;right:16%;bottom:4px;height:3px;border-radius:3px;background:linear-gradient(90deg,#22d3ee,#a78bfa,#f472b6,#facc15,#22d3ee);background-size:300% 100%;animation:tabflow 2.5s linear infinite}
@keyframes tabflow{to{background-position:300% 0}}
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
.poolpin span{display:grid;place-items:center;width:32px;height:24px;border-radius:8px;background:linear-gradient(180deg,#67e8f9,#0891b2);border:2.5px solid #fff;box-shadow:0 0 0 3px rgba(8,145,178,.35),0 3px 10px rgba(8,51,68,.45);font-size:13px;color:#fff;font-weight:800;position:relative;overflow:hidden}
.poolpin span::after{content:'';position:absolute;left:-4px;right:-4px;top:4px;height:3px;border-radius:50%;border-top:1.5px solid rgba(255,255,255,.7)}
.poolpin.done span{background:linear-gradient(180deg,#86efac,#16a34a);box-shadow:0 0 0 3px rgba(22,163,74,.3),0 3px 10px rgba(8,51,68,.4)}.poolpin:not(.done):not(.sm) span{animation:poolPulse 2.4s ease-in-out infinite}@keyframes poolPulse{50%{box-shadow:0 0 0 7px rgba(8,145,178,.12),0 3px 10px rgba(8,51,68,.45)}}.poolpin.sm span{width:12px;height:12px;border-radius:50%;border-width:2px;box-shadow:0 1px 4px rgba(8,51,68,.5)}.poolpin.sm span::after{display:none}.pplab{position:absolute;top:27px;left:50%;transform:translateX(-50%);white-space:nowrap;font:700 11px/1.2 system-ui,sans-serif;color:#0b4a63;background:rgba(255,255,255,.92);padding:2px 6px;border-radius:6px;box-shadow:0 1px 4px rgba(0,0,0,.2);pointer-events:none}.poolpin.done span::after{display:none}

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
.plist .psvc{display:inline-block!important;width:auto!important;margin:3px 0 2px;font-size:11px!important;font-weight:700;letter-spacing:.02em;color:hsl(var(--h) 70% 28%)!important;background:hsl(var(--h) 85% 92%);border:1px solid hsl(var(--h) 60% 80%);border-radius:999px;padding:1px 8px}
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
@media(max-width:900px){#vPom,#vCam{padding:12px 16px}.tgrid{grid-template-columns:1fr}}

/* ===== v10: bubbles rising, shimmering name ===== */
#bubbles{position:fixed;inset:0;z-index:-1;pointer-events:none;overflow:hidden}
#bubbles i{position:absolute;bottom:-40px;border-radius:50%;background:radial-gradient(circle at 32% 30%,rgba(255,255,255,.95) 0 14%,rgba(165,243,252,.35) 40%,rgba(8,145,178,.12) 70%);box-shadow:inset 0 0 0 1px rgba(8,145,178,.25);animation:bub linear infinite}
@keyframes bub{0%{transform:translate(0,0)}25%{transform:translate(14px,-25vh)}50%{transform:translate(-10px,-50vh)}75%{transform:translate(12px,-75vh)}100%{transform:translate(0,-110vh)}}
.brand>div:last-child{background:linear-gradient(90deg,#fff 0%,#a5f3fc 30%,#fff 45%,#fde68a 60%,#fff 75%);background-size:300% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;animation:namesh 7s ease-in-out infinite}
.brand>div:last-child small{-webkit-text-fill-color:#a5f3fc;color:#a5f3fc}
.brand>div:last-child{text-shadow:none;filter:drop-shadow(0 1px 6px rgba(0,0,0,.3))}@keyframes namesh{0%,100%{background-position:0 0}50%{background-position:100% 0}}
@media (prefers-reduced-motion:reduce){#bubbles,.brand>div:last-child{animation:none!important}#bubbles{display:none}}

/* Cameras tab: one row per driver */
#vCam{max-width:1400px}body[data-v=vCam] .bar{max-width:1400px}#camSer[aria-pressed=true]{background:#dc2626;color:#fff;border-color:#dc2626}
.csum{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px}.csum>div{flex:1;min-width:120px;background:var(--card);border-radius:14px;padding:12px 16px;box-shadow:inset 0 3px 0 var(--c-cams),var(--sh)}
.csum b{display:block;font-size:26px;line-height:1.1;font-variant-numeric:tabular-nums}.csum span{font-size:12.5px;color:var(--muted)}.csum .red{box-shadow:inset 0 3px 0 #dc2626,var(--sh)}.csum .red b{color:#dc2626}
.cdrv{display:grid;grid-template-columns:250px 1fr;gap:14px;background:var(--card);border-radius:16px;padding:14px;margin-bottom:12px;box-shadow:var(--sh);animation:rise .35s ease-out both}
.cdh{display:flex;flex-direction:column;gap:8px;padding-right:14px;border-right:1px solid var(--line)}.cdh>div:nth-child(2) b{display:block;font-size:16px}.cdh small{color:var(--muted)}
.cdn{display:flex;gap:12px;font-size:13px;color:var(--ink2)}.cdn b{font-size:18px;margin-right:2px}.cdn .red{color:#dc2626}.cdn .ok{color:#16a34a;font-weight:600}
.cdt{display:flex;flex-wrap:wrap;gap:5px}.cdt .pill{font-size:11px}.cdt .muted{font-size:12px}
.cstrip{display:flex;gap:10px;overflow-x:auto;padding-bottom:6px;scroll-snap-type:x proximity}
.cshot{flex:0 0 220px;scroll-snap-align:start;font:inherit;text-align:left;color:inherit;background:none;border:0;padding:0;cursor:pointer}
.cim{position:relative;display:block;height:138px;border-radius:12px;overflow:hidden;background:#1e293b;box-shadow:0 0 0 1px rgba(15,23,42,.08);transition:transform .2s,box-shadow .2s}
.cshot.ser .cim{box-shadow:0 0 0 2.5px #dc2626}.cshot:hover .cim,.cshot:focus-visible .cim{transform:translateY(-3px);box-shadow:0 12px 24px -12px rgba(15,23,42,.6),0 0 0 2.5px var(--c-cams)}
.cim img,.cim video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}.cim em{position:absolute;inset:0;display:grid;place-items:center;font-style:normal;font-size:12.5px;color:#94a3b8}
.cim .pill{position:absolute;left:8px;top:8px;font-size:11px;z-index:1;box-shadow:0 2px 6px rgba(0,0,0,.3)}
.cim i{position:absolute;right:8px;bottom:8px;z-index:1;width:28px;height:28px;border-radius:50%;display:grid;place-items:center;background:rgba(124,58,237,.92);color:#fff}.cim i svg{width:14px;height:14px}
.cwhen{display:block;margin-top:5px;font-size:12.5px;font-weight:600;color:var(--ink2)}
@media(max-width:900px){.cdrv{grid-template-columns:1fr}.cdh{border-right:0;padding-right:0}.cshot{flex-basis:180px}}

/* ===== v12: icons on every tab ===== */
.tabs button,.tabs .reptab{display:inline-flex;align-items:center;gap:6px}
.ti{width:16px;height:16px;flex:none;transition:transform .25s cubic-bezier(.2,.9,.3,1.4)}
.tabs button:hover .ti,.tabs .reptab:hover .ti{transform:translateY(-2px) rotate(-8deg) scale(1.12)}
.tabs button.on .ti{color:#0891b2;animation:tibounce .5s cubic-bezier(.2,.9,.3,1.4)}
@keyframes tibounce{0%{transform:scale(.6)}60%{transform:scale(1.25)}100%{transform:scale(1)}}
@media(max-width:1180px){.tabs .ti{display:none}}
@media (prefers-reduced-motion:reduce){.ti{animation:none!important;transition:none}}

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

.cstrip{-webkit-mask:linear-gradient(90deg,#000 calc(100% - 60px),transparent);mask:linear-gradient(90deg,#000 calc(100% - 60px),transparent);padding-right:40px}
/* ===== v13: speed streaks behind moving trucks on the map ===== */
.pin.mv::before{content:'';position:absolute;right:calc(100% + 3px);top:50%;width:38px;height:16px;margin-top:-8px;pointer-events:none;
  background:linear-gradient(90deg,transparent,#16a34a) 0 1px/100% 3px no-repeat,linear-gradient(90deg,transparent,#4ade80) 8px 7px/80% 3px no-repeat,linear-gradient(90deg,transparent,#16a34a) 3px 13px/90% 3px no-repeat;
  border-radius:2px;animation:streak .6s linear infinite}
@keyframes streak{0%{transform:translateX(6px);opacity:.2}50%{opacity:1}100%{transform:translateX(-6px);opacity:.2}}
@media (prefers-reduced-motion:reduce){.pin.mv::before{animation:none}}

/* Truck check-ups tab */
#vChk{padding:14px 24px 24px;max-width:1240px;margin:0 auto;animation:fadein .3s ease-out}body[data-v=vChk] .vopt{display:none}body[data-v=vChk] .bar{max-width:1240px;margin:0 auto}
.chs{background:linear-gradient(110deg,#7c2d12,#c2410c 55%,#f59e0b)}.chs .pbring b{font-size:13px}
.chk{overflow-x:auto;padding:4px 0;box-shadow:inset 0 3px 0 #f59e0b,var(--sh)}.chk table{width:100%;border-collapse:collapse}
.chk th{font-size:11.5px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;padding:12px 8px;text-align:center;border-bottom:1px solid var(--line);white-space:nowrap}.chk th:first-child{text-align:left;padding-left:18px}
.chk th.now{color:#c2410c}.chk th.next{color:#0891b2}.chk td{padding:10px 8px;text-align:center;border-bottom:1px solid var(--line)}.chk td:first-child{text-align:left;padding-left:18px}
.chk tbody tr{animation:rise .35s ease-out both;animation-delay:calc(var(--i)*40ms)}.chk tbody tr:hover{background:#fffbeb}
.chd{display:flex;align-items:center;gap:10px}.chd b{display:block;font-size:14.5px}
.chc{display:inline-grid;place-items:center;width:30px;height:30px;border-radius:9px;font-weight:800;font-size:15px}
.chc.ok{background:#dcfce7;color:#15803d}a.chc{text-decoration:none;cursor:pointer;transition:transform .15s,box-shadow .15s}a.chc:hover{transform:scale(1.15);box-shadow:0 0 0 3px rgba(22,163,74,.3)}.chc.miss{background:#fee2e2;color:#dc2626}.chc.due{background:#fef3c7;color:#b45309;animation:duep 1.6s ease-in-out infinite}.chc.none{background:repeating-linear-gradient(135deg,#f1f5f9 0 4px,#fff 4px 8px);box-shadow:inset 0 0 0 1px #e2e8f0}
@keyframes duep{50%{box-shadow:0 0 0 4px rgba(245,158,11,.25)}}
.chr{font-size:14px}.chr.g{color:#15803d}.chr.y{color:#b45309}.chr.r{color:#dc2626}.chs2{font-size:13px;color:#15803d}
.chleg{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12.5px;color:var(--muted);padding:10px 18px 6px;margin:0}.chleg .chc{width:22px;height:22px;font-size:12px;border-radius:6px;margin-left:8px}
@media (prefers-reduced-motion:reduce){.chc.due{animation:none}}

/* ===== v14: Drivers tab rows coloured by driver score ===== */
.roster .rrow{position:relative;transition:transform .2s cubic-bezier(.2,.8,.2,1),box-shadow .2s,background .15s}
.roster .rrow::before{content:'';position:absolute;left:0;top:6px;bottom:6px;width:5px;border-radius:0 5px 5px 0;background:#cbd5e1;transition:width .2s}
.roster .rrow:has(.schip.good)::before{background:linear-gradient(#4ade80,#16a34a)}.roster .rrow:has(.schip.ok)::before{background:linear-gradient(#fcd34d,#d97706)}.roster .rrow:has(.schip.bad)::before{background:linear-gradient(#f87171,#dc2626)}
.roster .rrow:has(.schip.good){background:linear-gradient(90deg,rgba(74,222,128,.10),transparent 40%)}.roster .rrow:has(.schip.ok){background:linear-gradient(90deg,rgba(252,211,77,.14),transparent 40%)}.roster .rrow:has(.schip.bad){background:linear-gradient(90deg,rgba(248,113,113,.14),transparent 40%)}
.roster .rrow:hover{transform:translateY(-2px);box-shadow:0 12px 24px -16px rgba(8,74,99,.55);z-index:1}.roster .rrow:hover::before{width:8px}
.roster .schip{font-size:13px;padding:2px 9px;box-shadow:0 0 0 2px #fff,0 2px 6px rgba(0,0,0,.12)}
@media (prefers-reduced-motion:reduce){.roster .rrow:hover{transform:none}}

/* driver roles */
.role{display:inline-flex;align-items:center;gap:4px;margin-left:6px;font-size:11.5px;font-weight:700;padding:2px 9px;border-radius:999px;vertical-align:middle;background:#f1f5f9;color:#475569}
.role.r0{background:#cffafe;color:#0e7490}.role.r1{background:#ccfbf1;color:#0f766e}.role.r2{background:#dbeafe;color:#1d4ed8}.role.r3{background:#ede9fe;color:#6d28d9}.role.r4{background:#fef3c7;color:#a16207}.role.r5{background:#ffedd5;color:#c2410c}.role.r6{background:#e2e8f0;color:#334155}
.rsum{display:flex;flex-wrap:wrap;gap:6px;margin:-2px 0 12px}.rsum button{font:inherit;font-size:12.5px;font-weight:600;border:1px solid var(--line2);background:#fff;border-radius:999px;padding:5px 11px;cursor:pointer;margin:0;transition:transform .15s}
.rsum button:hover{transform:translateY(-1px)}.rsum button b{opacity:.65;margin-left:3px}.rsum button[aria-pressed=true]{box-shadow:0 0 0 2px var(--ink);border-color:transparent}.rsum button:not(.role)[aria-pressed=true]{background:var(--deep);color:#fff}

/* ===== v15: birds crossing the header sky ===== */
.birds{position:absolute;inset:0 0 auto 0;height:90px;pointer-events:none;z-index:0;overflow:hidden}
.birds b{position:absolute;left:-60px;top:52px;width:44px;animation:fly 38s linear infinite}
.birds b:nth-child(2){top:64px;width:34px;animation-delay:2.2s}.birds b:nth-child(3){top:58px;width:28px;animation-delay:3.6s}
.birds svg{width:100%;display:block;overflow:visible;fill:#f8fafc;filter:drop-shadow(0 1px 2px rgba(0,0,0,.35))}
.birds .wl,.birds .wr{transform-origin:20px 12px;animation:flap .45s ease-in-out infinite alternate}.birds .wr{animation-name:flapr}
@keyframes flap{to{transform:scaleY(-.6)}}@keyframes flapr{to{transform:scaleY(-.6)}}
@keyframes fly{0%{transform:translate(0,0)}25%{transform:translate(28vw,-8px)}50%{transform:translate(55vw,4px)}75%,100%{transform:translate(calc(100vw + 120px),-6px)}}
header[data-sky=night] .birds{display:none}
@media (prefers-reduced-motion:reduce){.birds{display:none}}@media(max-width:900px){.birds{display:none}}

.chk .chd b .role{font-size:10.5px;padding:1px 7px}.chmiss{background:#fffbeb}.chmiss small{color:#b45309!important;font-weight:600}
.chwarn{display:inline-block;font-size:12.5px;font-weight:600;color:#92400e;background:#fef3c7;border-radius:8px;padding:5px 10px}
.chskip{font-size:12.5px;color:var(--muted);padding:10px 18px 0;margin:0}

/* ===== v16: Edit vehicles header becomes a coloured banner ===== */
.edhero{position:relative;overflow:hidden;margin:-4px -4px 14px;padding:16px 18px;border-radius:16px;color:#fff;background:linear-gradient(115deg,#0b4a63,#0891b2 60%,#22d3ee);box-shadow:0 14px 30px -18px rgba(8,74,99,.8)}
.edhero.mk-ford{background:linear-gradient(115deg,#1e3a8a,#2563eb 60%,#60a5fa)}.edhero.mk-chevy{background:linear-gradient(115deg,#78350f,#d97706 60%,#fbbf24)}.edhero.mk-ram,.edhero.mk-dodge{background:linear-gradient(115deg,#7f1d1d,#dc2626 60%,#f87171)}.edhero.mk-gmc{background:linear-gradient(115deg,#450a0a,#b91c1c 60%,#ef4444)}.edhero.mk-toyota{background:linear-gradient(115deg,#3f3f46,#71717a 60%,#d4d4d8)}.edhero.mk-nissan{background:linear-gradient(115deg,#1f2937,#475569 60%,#94a3b8)}
.edhero h2{color:#fff}.edhero .azn,.edhero .pos{color:rgba(255,255,255,.85)!important}.edhero .tno,.edhero .mk{display:none}
.ehno{flex:none;display:grid;place-items:center;min-width:64px;height:64px;padding:0 10px;border-radius:16px;background:rgba(255,255,255,.18);font-size:26px;font-weight:800;letter-spacing:-.02em;box-shadow:inset 0 0 0 1px rgba(255,255,255,.3);animation:ehpop .5s cubic-bezier(.2,.9,.3,1.4) both}.ehno svg{width:30px;height:30px}
.ehtruck{position:absolute;right:96px;bottom:-6px;width:230px;animation:ehdrive 1.1s cubic-bezier(.2,.8,.2,1) both}
.edhero::after{content:'';position:absolute;right:-40px;top:-60px;width:220px;height:220px;border-radius:50%;background:radial-gradient(circle,rgba(255,255,255,.22),transparent 65%);pointer-events:none}
@keyframes ehpop{from{transform:scale(.4) rotate(-12deg);opacity:0}}@keyframes ehdrive{from{transform:translateX(-420px);opacity:0}70%{opacity:1}}
@media(max-width:900px){.ehtruck{display:none}}@media (prefers-reduced-motion:reduce){.ehno,.ehtruck{animation:none}}

/* ===== v17: a swim ring rides the end of each tech's progress bar ===== */
.tcard .pbar{overflow:visible;position:relative}.tcard .pbar i{position:relative}
.tcard .pbar i::after{content:'';position:absolute;right:-12px;top:50%;width:24px;height:24px;margin-top:-12px;background:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Ccircle cx='12' cy='12' r='8' fill='none' stroke='white' stroke-width='6'/%3E%3Ccircle cx='12' cy='12' r='8' fill='none' stroke='%23ef4444' stroke-width='6' stroke-dasharray='6.28 6.28'/%3E%3Ccircle cx='12' cy='12' r='11' fill='none' stroke='%230b2533' stroke-opacity='.35'/%3E%3Ccircle cx='12' cy='12' r='5' fill='none' stroke='%230b2533' stroke-opacity='.35'/%3E%3C/svg%3E") center/contain no-repeat;filter:drop-shadow(0 2px 3px rgba(8,74,99,.35));animation:ringbob 2.4s ease-in-out infinite}
.tcard.fin .pbar i::after{background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Ccircle cx='12' cy='12' r='8' fill='none' stroke='white' stroke-width='6'/%3E%3Ccircle cx='12' cy='12' r='8' fill='none' stroke='%2322c55e' stroke-width='6' stroke-dasharray='6.28 6.28'/%3E%3Ccircle cx='12' cy='12' r='11' fill='none' stroke='%230b2533' stroke-opacity='.35'/%3E%3Ccircle cx='12' cy='12' r='5' fill='none' stroke='%230b2533' stroke-opacity='.35'/%3E%3C/svg%3E")}
@keyframes ringbob{0%,100%{transform:translateY(0) rotate(-8deg)}50%{transform:translateY(-3px) rotate(8deg)}}
@media (prefers-reduced-motion:reduce){.tcard .pbar i::after{animation:none}}

.cplan{background:var(--card);border-radius:16px;padding:14px 18px;margin-bottom:14px;box-shadow:inset 0 3px 0 #0891b2,var(--sh)}
.cph2{display:flex;align-items:center;gap:14px;flex-wrap:wrap}.cph2>div{flex:1;min-width:220px}.cph2 b{display:block;font-size:15px}.cph2 .muted{font-size:12.5px}
.cauto{display:inline-flex;align-items:center;gap:7px;font-size:13px;font-weight:600;color:var(--ink2)}
.cplan ul{list-style:none;margin:10px 0 0;padding:0}.cplan li{display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px solid var(--line);font-size:13.5px}.cplan li>span:nth-child(2){flex:1}
.opi{flex:none;width:24px;height:24px;border-radius:8px;display:grid;place-items:center;font-weight:800}.op-create .opi{background:#dcfce7;color:#15803d}.op-move .opi{background:#e0f2fe;color:#0369a1}.op-remove .opi{background:#fee2e2;color:#dc2626}.op-none .opi{background:#fef3c7;color:#b45309}
.cpmsg{margin:8px 0 0;font-size:12.5px}

/* ===== v18: the live map follows the time of day ===== */
.leaflet-tile-pane{transition:filter 1.5s}
body:has(header[data-sky=dusk]) .leaflet-tile-pane,body:has(header[data-sky=dawn]) .leaflet-tile-pane{filter:sepia(.4) saturate(1.35) hue-rotate(-18deg) brightness(.96)}
body:has(header[data-sky=night]) .leaflet-tile-pane{filter:invert(1) hue-rotate(180deg) brightness(.92) contrast(.88) saturate(.75)}
body:has(header[data-sky=night]) .pin{box-shadow:0 0 0 3px rgba(255,255,255,.9),0 0 14px rgba(125,211,252,.8)}

/* ===== v19: heartbeat line in the Live badge ===== */
.live .ekg{width:34px;height:12px;flex:none;margin:0 2px 0 -2px}.live .ekg path{fill:none;stroke:#4ade80;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:60;stroke-dashoffset:60;animation:ekg 2.4s linear infinite;filter:drop-shadow(0 0 3px rgba(74,222,128,.8))}
.live.down .ekg path{stroke:#f59e0b;animation:none;stroke-dashoffset:0;filter:none}
@keyframes ekg{0%{stroke-dashoffset:60}55%{stroke-dashoffset:0}100%{stroke-dashoffset:-60}}
@media (prefers-reduced-motion:reduce){.live .ekg path{animation:none;stroke-dashoffset:0}}

/* ===== v20: Edit vehicles list striped by make ===== */
.eli{position:relative;transition:transform .2s cubic-bezier(.2,.8,.2,1),background .15s}.eli::before{content:'';position:absolute;left:0;top:8px;bottom:8px;width:5px;border-radius:0 5px 5px 0;background:linear-gradient(#67e8f9,#0891b2);transition:width .2s}
.eli:hover{transform:translateX(4px)}.eli:hover::before{width:8px}
.eli:has(.mk-ford)::before{background:linear-gradient(#93c5fd,#2563eb)}.eli:has(.mk-chevy)::before{background:linear-gradient(#fde68a,#d97706)}.eli:has(.mk-ram)::before{background:linear-gradient(#fca5a5,#dc2626)}.eli:has(.mk-gmc)::before{background:linear-gradient(#f87171,#991b1b)}.eli:has(.mk-toyota)::before,.eli:has(.mk-nissan)::before{background:linear-gradient(#d4d4d8,#52525b)}
@media (prefers-reduced-motion:reduce){.eli:hover{transform:none}}

/* ===== v21: wavy water underline on page titles ===== */
.crewhead h2{position:relative;padding-bottom:9px}.crewhead h2::after{content:'';position:absolute;left:0;bottom:0;width:min(100%,180px);height:8px;background:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 8'%3E%3Cpath d='M0 4 Q5 0 10 4 T20 4 T30 4 T40 4' fill='none' stroke='%2322d3ee' stroke-width='2.4' stroke-linecap='round'/%3E%3C/svg%3E") 0 0/40px 8px repeat-x;animation:wavey 2.2s linear infinite;opacity:.9}
@keyframes wavey{to{background-position:40px 0}}@media (prefers-reduced-motion:reduce){.crewhead h2::after{animation:none}}

/* vehicle notes */
.chc.ok{transition:transform .2s cubic-bezier(.2,1.6,.4,1)}.chc.ok:hover{transform:scale(1.25) rotate(-8deg)}.chc.miss:hover{animation:chshake .35s}@keyframes chshake{25%{transform:translateX(-2px)}75%{transform:translateX(2px)}}
.role{transition:transform .18s cubic-bezier(.2,1.4,.4,1)}tr:hover .role,.drow:hover .role{transform:scale(1.08) rotate(-2deg)}
.tchip{transition:transform .18s cubic-bezier(.2,1.4,.4,1),box-shadow .18s}.tchip:hover{transform:translateY(-2px);box-shadow:0 6px 14px -6px rgba(8,145,178,.7)}
.panel{transition:box-shadow .25s,transform .25s}.panel:hover{box-shadow:0 18px 40px -22px rgba(14,116,144,.55)}
.cm-auto{display:flex;align-items:center;gap:12px;flex-wrap:wrap;background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:12px 16px;margin-bottom:12px}.cm-auto>div{display:flex;flex-direction:column;flex:1;min-width:240px}.cm-auto>div b{font-size:14px}.cm-auto>div .muted{font-size:12.5px}.qrbtn{display:flex;justify-content:center;margin-top:10px;text-decoration:none;background:linear-gradient(135deg,#ecfeff,#cffafe);border-color:#67e8f9;color:#0e7490;font-weight:700;transition:transform .2s,box-shadow .2s}.qrbtn:hover{transform:translateY(-2px) rotate(-.6deg);box-shadow:0 8px 18px -10px rgba(8,145,178,.7)}
.pbring{animation:pbGlow 3s ease-in-out infinite}@keyframes pbGlow{50%{filter:drop-shadow(0 0 8px rgba(103,232,249,.75))}}
.rnav{display:inline-flex;background:#e0f2fe;border-radius:12px;padding:3px;gap:2px}.rnav button{font:inherit;font-size:13.5px;font-weight:700;border:0;background:transparent;color:#0b4a63;padding:7px 14px;border-radius:9px;cursor:pointer;transition:background .2s,color .2s}.rnav button.on{background:#0e7490;color:#fff;box-shadow:0 4px 10px -4px rgba(14,116,144,.7)}
.rbars>div{position:relative}.rbars>div em{position:absolute;top:-16px;left:50%;transform:translateX(-50%);font-size:9.5px;font-style:normal;color:#64748b;white-space:nowrap;opacity:0;transition:opacity .2s}.rbars>div:hover em,.rbars>div.hi em,.rbars>div.cur em{opacity:1}.rbars>div.hi i{background:linear-gradient(180deg,#f59e0b,#ea580c)!important}.rbars>div.cur i{outline:2px dashed #0891b2;outline-offset:1px}
.rpl{position:relative;display:flex;align-items:center;gap:8px;padding:8px 6px;border-top:1px solid #f1f5f9;font-size:13px;overflow:hidden}.rpl>div{flex:1;min-width:0;position:relative;z-index:1}.rpl small{display:block;color:#64748b;font-size:11.5px}.rpl>span{font-weight:700;position:relative;z-index:1}.rpl>i{position:absolute;left:0;bottom:0;height:3px;background:linear-gradient(90deg,#22d3ee,#0e7490);border-radius:2px}.rwarn{color:#b45309;font-weight:700}
.rfl{display:flex;align-items:center;gap:8px;padding:8px 4px;border-top:1px dashed #e2e8f0;font-size:13px}.rfl>div{flex:1}.rfl small{display:block;color:#b45309;font-size:12px}.rfl .btn2{padding:4px 9px;font-size:12px;text-decoration:none}.rgnote{font-size:12.5px;margin:-4px 0 12px}
.split .xgas{background:repeating-linear-gradient(45deg,#7dd3fc 0 4px,#e0f2fe 4px 8px)}.ukc-f s{text-decoration:none;color:#b45309;font-weight:700}
.ukwarn{font-size:12.5px;color:#92400e;background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:7px 9px;line-height:1.4}
.ukd summary{cursor:pointer;font-weight:700;font-size:13px;color:#0e7490;list-style:none;padding:6px 0 0;border-top:1px dashed #e2e8f0}.ukd summary::-webkit-details-marker{display:none}.ukd summary::before{content:"▸ ";display:inline-block;transition:transform .2s}.ukd[open] summary::before{transform:rotate(90deg)}
.bd h4{display:flex;justify-content:space-between;margin:12px 0 4px;font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#64748b}.bd h4 span{color:#0f172a}.bdr{display:flex;justify-content:space-between;gap:10px;padding:6px 0;border-top:1px solid #f1f5f9;font-size:13px}.bdr>div{min-width:0}.bdr small{display:block;color:#64748b;font-size:12px}.bdr.extra{color:#b45309}.bdn{font-size:12.5px;margin:6px 0 0}.bdw{margin:8px 0 0;padding-left:18px;font-size:12.5px;color:#92400e}
.rblks{display:grid;gap:8px}.rblk{border-radius:12px;padding:10px 12px;border:2px solid #e2e8f0}.rblk.reg{background:#eff6ff}.rblk.ins{background:#f5f3ff}.rblk.bad{border-color:#ef4444;background:#fef2f2}.rblk.warn{border-color:#fdba74}.rblk.ok{border-color:#bbf7d0}
.rblk-h{display:flex;justify-content:space-between;align-items:center;gap:8px;font-weight:800;font-size:12.5px;text-transform:uppercase;letter-spacing:.04em;color:#334155}.rblk-d{font-size:19px;font-weight:800;color:#0f172a;margin:4px 0 2px}.rblk.none .rblk-d{color:#94a3b8}.rsrc{font-size:12px;color:#64748b}
.rtech{font-size:12px;color:#334155;background:rgba(255,255,255,.7);border-radius:8px;padding:5px 7px;margin-top:6px}.rtech.w{color:#92400e;background:#fffbeb}.rblk input{width:100%;box-sizing:border-box;margin-top:8px;font:inherit;font-size:13px;border:1px solid #cbd5e1;border-radius:8px;padding:4px 6px;background:#fff}.rblk input.saved{background:#dcfce7}
.camload{display:inline-flex;align-items:center;gap:6px;margin-left:6px;color:#0e7490;font-weight:600}
.camat{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:#475569;background:#fff;border:1px solid #e2e8f0;border-radius:20px;padding:5px 11px}.camdot{width:8px;height:8px;border-radius:50%;background:#22c55e;box-shadow:0 0 0 3px rgba(34,197,94,.2)}.camdot.bad{background:#ef4444;box-shadow:0 0 0 3px rgba(239,68,68,.2)}.camdot.off{background:#94a3b8;box-shadow:none}.camdot.spin{background:#0ea5e9;animation:gbPulse 1s ease-in-out infinite}
.rmc.wide{margin-bottom:14px}.rmc.wide .rma .sw{flex:1 1 auto}
.dcon input{background:#f0f9ff}.dcon{position:relative}
.ptbar{position:relative;height:10px;border-radius:6px;background:#f1f5f9}.ptbar i{position:absolute;inset:0 auto 0 0;border-radius:6px;background:linear-gradient(90deg,#22d3ee,#0e7490)}.ptbar em{position:absolute;top:-4px;bottom:-4px;width:2px;background:#0f172a;opacity:.55}
.ptbad{color:#b91c1c;font-weight:700}.ptjobs{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:12.5px;margin:-4px 0 14px;color:#64748b}.ptjobs em{font-style:normal;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:999px;padding:3px 10px;color:#334155}.ptjt{display:inline-block;margin-left:6px;font-size:11px;font-weight:700;background:#ede9fe;color:#6d28d9;border-radius:999px;padding:1px 8px}.ptchg{font-size:12.5px;font-weight:700;border-radius:10px;padding:5px 9px}.ptchg.dn{background:#fff7ed;color:#c2410c}.ptchg.up{background:#ecfeff;color:#0e7490}.ptnote{font-size:12.5px;margin:-4px 0 12px}
.ptpools{display:grid;gap:8px}.ptp{display:grid;grid-template-columns:minmax(180px,1.4fr) 110px 2fr;gap:10px;align-items:center;background:#fff;border-radius:12px;padding:10px 14px;box-shadow:0 2px 8px rgba(15,23,42,.05)}.ptp small{display:block;color:#64748b;font-size:12px}.ptm b{font-size:17px;color:#0b4a63}.ptt{display:flex;flex-wrap:wrap;gap:5px}.ptt span{font-size:12px;background:#e0f2fe;color:#0b4a63;border-radius:10px;padding:2px 8px}
@media(max-width:700px){.ptp{grid-template-columns:1fr auto}.ptt{grid-column:1/-1}}.ptus{color:#0e7490;font-weight:700}#pomNav{margin-right:10px}
.rmhead{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px;margin:4px 0 10px}.rmhead h3{margin:0;font-size:16px;color:#0b4a63}.rmhead .muted{font-size:12.5px}
.rmgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px;margin-bottom:16px}.rmc{background:#fff;border:1px solid #e2e8f0;border-left:5px solid #94a3b8;border-radius:14px;padding:14px 16px;display:flex;flex-direction:column;gap:10px;transition:box-shadow .2s,transform .2s}.rmc:hover{transform:translateY(-2px);box-shadow:0 12px 26px -16px rgba(14,116,144,.5)}
.rmc.em{border-left-color:#0ea5e9}.rmc.tx{border-left-color:#8b5cf6}.rmc.sv{border-left-color:#06b6d4}.rmc.eo{border-left-color:#6366f1}.rmc.live{background:linear-gradient(180deg,#f0fdf4,#fff 45%)}
.rmh{display:flex;align-items:center;gap:10px}.rmh>div{flex:1;min-width:0}.rmh b{display:block;font-size:15px;color:#0f172a}.rmh small{color:#64748b;font-size:12px}.rmi{font-size:22px;width:38px;height:38px;border-radius:11px;background:#f1f5f9;display:grid;place-items:center;flex:none}
.rmpill{font-size:12px;font-weight:800;border-radius:20px;padding:3px 10px;white-space:nowrap}.rmpill.on{background:#dcfce7;color:#15803d}.rmpill.off{background:#f1f5f9;color:#475569}.rmpill.set{background:#fef3c7;color:#92400e}
.rmd{display:grid;grid-template-columns:62px 1fr;gap:4px 10px;margin:0;font-size:13px}.rmd dt{font-weight:700;color:#64748b;font-size:11.5px;text-transform:uppercase;letter-spacing:.04em;padding-top:2px}.rmd dd{margin:0;color:#334155}
.rmw{font-size:12.5px;color:#92400e;background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:7px 9px}.rma{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding-top:8px;border-top:1px dashed #e2e8f0}.rma .sw{flex:1 1 100%;min-width:0;font-size:13px}.rmm{font-size:12.5px;min-height:1em}
.cm-eod{width:100%;display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-top:10px;padding-top:10px;border-top:1px dashed #a5f3fc}.cm-eod>div{flex:1;min-width:220px}.cm-eod b{display:block}
.cm-svc{margin-top:10px;border-left:4px solid #06b6d4;background:linear-gradient(90deg,#ecfeff,#fff 60%)}
.cm-sms{margin-top:10px;border-left:4px solid #8b5cf6;background:linear-gradient(90deg,#f5f3ff,#fff 60%)}
.ukk{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin-bottom:14px}.ukk>div{background:#fff;border-radius:14px;padding:14px 16px;box-shadow:0 2px 10px rgba(15,23,42,.06);border-left:5px solid #0e7490;animation:rqIn .35s ease both}
.ukk b{display:block;font-size:26px;font-weight:800;color:#0b4a63;line-height:1.1}.ukk span{font-size:12.5px;color:#64748b}.ukk .bad{border-color:#ef4444}.ukk .bad b{color:#b91c1c}.ukk .warn{border-color:#f59e0b}.ukk .warn b{color:#b45309}.ukk .good{border-color:#22c55e}.ukk .good b{color:#15803d}
.ukbar{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:0 0 12px}.ukchips{display:flex;flex-wrap:wrap;gap:6px}.ukchips button{font:inherit;font-size:13px;font-weight:700;border:1px solid #cbd5e1;background:#fff;color:#334155;border-radius:20px;padding:6px 12px;cursor:pointer;transition:all .15s}.ukchips button i{font-style:normal;background:#e2e8f0;border-radius:10px;padding:0 6px;margin-left:3px;font-size:11.5px}.ukchips button.on{background:#0e7490;border-color:#0e7490;color:#fff}.ukchips button.on i{background:rgba(255,255,255,.25)}
.uklegend{display:inline-flex;gap:6px;align-items:center;font-size:12.5px;color:#64748b;margin-left:auto}.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin:0 4px 0 6px;vertical-align:0}.dot.rep{background:#f97316}.dot.gas{background:#0ea5e9}
.ukg{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:12px;margin-bottom:18px}.ukc{background:#fff;border-radius:16px;padding:14px 16px;box-shadow:0 2px 10px rgba(15,23,42,.06);border-top:4px solid #cbd5e1;display:flex;flex-direction:column;gap:10px;transition:transform .2s,box-shadow .2s;animation:rqIn .35s ease both}.ukc:hover{transform:translateY(-3px);box-shadow:0 14px 28px -14px rgba(14,116,144,.45)}
.ukc.hot{border-top-color:#ef4444;background:linear-gradient(180deg,#fff5f5,#fff 40%)}.ukc.good{border-top-color:#22c55e}.ukc-h{display:flex;justify-content:space-between;gap:8px;align-items:flex-start}.ukc-h b{font-size:15px;color:#0f172a}.ukc-h small{display:block;color:#64748b;font-size:12.5px;margin-top:2px}
.rank{background:#ef4444;color:#fff;font-weight:800;font-size:12px;border-radius:10px;padding:3px 8px}.ukc-big{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}.ukc-big b{font-size:30px;font-weight:800;color:#0b4a63;line-height:1}.ukc-big span{color:#64748b;font-size:13px}.ukc-big em{font-style:normal;font-size:12px;font-weight:700;border-radius:10px;padding:2px 8px}.ukc-big em.up{background:#fee2e2;color:#b91c1c}.ukc-big em.down{background:#dcfce7;color:#15803d}
.split{display:flex;height:10px;border-radius:6px;overflow:hidden;background:#f1f5f9}.split i{display:block;height:100%;transition:width .6s}.split .rep{background:#f97316}.split .gas{background:#0ea5e9}.ukc-f{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:12.5px;color:#475569}
.ukc.oil.due{border-top-color:#ef4444}.ukc.oil.soon{border-top-color:#f59e0b}.ukc.oil.ok{border-top-color:#22c55e}.oilbar{position:relative;height:10px;border-radius:6px;background:#f1f5f9}.oilbar i{position:absolute;inset:0 auto 0 0;border-radius:6px;background:linear-gradient(90deg,#22c55e,#facc15 60%,#ef4444 77%)}.oilbar em{position:absolute;top:-3px;bottom:-3px;width:2px;background:#0f172a;opacity:.5}
.ukc.oil.ok .oilbar i{background:#22c55e}.ukc.oil.unknown .oilbar{opacity:.4}
.ukgh{font-size:14px;margin:6px 0 10px;display:flex;align-items:center;gap:8px;color:#0b4a63}.ukgh i{font-style:normal;font-size:12px;background:#e2e8f0;border-radius:10px;padding:1px 8px}.ukgh.bad{color:#b91c1c}.ukgh.warn{color:#b45309}.ukgh.good{color:#15803d}
.renrow{display:grid;grid-template-columns:1fr auto;align-items:center;gap:6px 8px;font-size:13px;font-weight:700;color:#334155;padding-top:8px;border-top:1px solid #f1f5f9}.renrow input{grid-column:1/-1;width:100%;box-sizing:border-box;font:inherit;font-size:13px;border:1px solid #cbd5e1;border-radius:8px;padding:4px 6px;transition:background .3s}.renrow input.saved{background:#dcfce7}
.dchip{font-size:12px;font-weight:700;border-radius:10px;padding:3px 9px;white-space:nowrap}.ukc .upill,.ukc-h .btn2{white-space:nowrap;flex:none}.dchip.bad{background:#fee2e2;color:#b91c1c}.dchip.warn{background:#ffedd5;color:#c2410c}.dchip.ok{background:#dcfce7;color:#15803d}.dchip.none{background:#f1f5f9;color:#64748b}
.ukset{display:flex;flex-wrap:wrap;align-items:center;gap:10px;background:#fff;border-radius:14px;padding:10px 14px;margin-bottom:14px;box-shadow:0 2px 10px rgba(15,23,42,.05)}.sw{display:inline-flex;align-items:center;gap:10px;font-weight:700;font-size:13.5px;cursor:pointer;flex:1;min-width:220px}.sw input{position:absolute;opacity:0;width:1px;height:1px}.sw i{flex:none;width:40px;height:22px;border-radius:12px;background:#cbd5e1;position:relative;transition:background .2s}.sw i::after{content:"";position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .2s;box-shadow:0 1px 3px rgba(0,0,0,.3)}.sw input:checked+i{background:#0e7490}.sw input:checked+i::after{transform:translateX(18px)}.sw input:focus-visible+i{outline:2px solid #0891b2;outline-offset:2px}
.gc{display:flex;gap:12px;align-items:flex-start;background:#fff;border-radius:14px;padding:12px 14px;margin-bottom:8px;box-shadow:0 2px 8px rgba(15,23,42,.05);border-left:5px solid #22c55e;animation:rqIn .3s ease both}.gc.far{border-left-color:#ef4444}.gc.unv{border-left-color:#f59e0b}
.gc-ic{flex:none;width:30px;height:30px;border-radius:50%;display:grid;place-items:center;font-weight:800;color:#fff;background:#22c55e}.gc.far .gc-ic{background:#ef4444}.gc.unv .gc-ic{background:#f59e0b}.gc-m{flex:1;min-width:0}.gc-t{display:flex;flex-wrap:wrap;gap:4px 8px;align-items:baseline}.gc-t span{color:#334155;font-size:13.5px}.gc-m small{color:#64748b;font-size:12.5px}
.gc-m ul{margin:6px 0 0;padding-left:18px;color:#b91c1c;font-weight:700;font-size:13.5px}.gc-m p{margin:6px 0 0;font-size:13px;color:#475569}.gc.unv .gc-m p{color:#b45309}
.ukrank{display:flex;align-items:center;gap:10px;padding:7px 0;border-top:1px solid #f1f5f9}.ukrank>div{flex:1;min-width:0}.ukrank small{display:block;color:#64748b;font-size:12px}.ukrank>i{width:80px;height:8px;border-radius:5px;background:#f1f5f9;overflow:hidden}.ukrank>i b{display:block;height:100%;background:#ef4444;border-radius:5px}
.saf{display:grid;grid-template-columns:minmax(260px,380px) 1fr;gap:14px}@media(max-width:800px){.saf{grid-template-columns:1fr}}.safl{margin:12px 0;padding-left:18px;font-size:13.5px;color:#334155;line-height:1.7}.safq{display:flex;flex-wrap:wrap;gap:8px}.safq input{font:inherit;padding:8px 10px;border:1px solid #cbd5e1;border-radius:10px;flex:1;min-width:140px}
.mail{background:#fff;border-radius:16px;box-shadow:0 2px 12px rgba(15,23,42,.08);overflow:hidden}.mail-h{padding:14px 18px;background:linear-gradient(135deg,#0b4a63,#0e7490);color:#fff}.mail-h b{display:block;font-size:15px}.mail-h span{font-size:12.5px;color:#cffafe}.mail-b{padding:18px;font-size:14px;line-height:1.6;color:#0f172a;word-break:break-word}
#vUp{padding:14px 24px 24px;max-width:1240px;margin:0 auto;animation:fadein .3s ease-out}#usBody{overflow-x:auto}#upNav{flex-wrap:wrap;max-width:100%}body[data-v=vUp] .vopt{display:none}@media(max-width:900px){#vUp{padding:12px 16px}}
.gflag{color:#b91c1c}.gwarn{color:#c2410c;font-size:12.5px}.tabs .gbadge{background:#ef4444;animation:gbPulse 2s ease-in-out infinite}@keyframes gbPulse{50%{box-shadow:0 0 0 5px rgba(239,68,68,.25)}}
.newpill{font-style:normal;font-size:9px;font-weight:800;letter-spacing:.06em;padding:2px 5px;border-radius:6px;color:#fff;background:linear-gradient(90deg,#f472b6,#a78bfa,#22d3ee,#f472b6);background-size:300% 100%;animation:tabflow 3s linear infinite}
.utab{width:100%;border-collapse:separate;border-spacing:0 6px;font-size:13.5px}.utab th{text-align:left;font-size:11.5px;text-transform:uppercase;letter-spacing:.04em;color:#64748b;padding:0 10px}.utab td{background:#fff;padding:10px;vertical-align:middle}.utab td:first-child{border-radius:12px 0 0 12px}.utab td:last-child{border-radius:0 12px 12px 0}
.utab tr.hot td{background:#fff1f2}.utab tr.warm td{background:#fff7ed}.cpm{display:flex;align-items:center;gap:8px;min-width:150px}.cpm i{flex:1;height:8px;border-radius:6px;background:#e2e8f0;overflow:hidden;position:relative}.cpm i b{position:absolute;inset:0 auto 0 0;border-radius:6px;background:linear-gradient(90deg,#22c55e,#facc15,#ef4444);background-size:300px 100%;transition:width .6s cubic-bezier(.2,.9,.3,1)}
.upill{display:inline-block;font-size:11.5px;font-weight:700;padding:3px 9px;border-radius:20px}.upill.due,.upill.far{background:#fee2e2;color:#b91c1c}.upill.soon,.upill.moving{background:#ffedd5;color:#c2410c}.upill.ok{background:#dcfce7;color:#15803d}.upill.unknown,.upill.nogps,.upill.noloc,.upill.notruck{background:#f1f5f9;color:#475569}
.utog{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:6px 0 12px}.utog label{display:inline-flex;gap:8px;align-items:center;font-weight:700}.upre{white-space:pre-wrap;background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:14px;font:13.5px/1.5 system-ui,sans-serif}
.utab input[type=date]{font:inherit;border:1px solid #cbd5e1;border-radius:8px;padding:4px 6px}
.panel{transition:transform .2s ease,box-shadow .2s ease}.panel:hover{transform:translateY(-2px);box-shadow:0 12px 28px -14px rgba(14,116,144,.45)}
#vBuy{padding:14px 24px 24px;max-width:1240px;margin:0 auto;animation:fadein .3s ease-out}body[data-v=vBuy] .vopt{display:none}@media(max-width:900px){#vBuy{padding:12px 16px}}
.bsum{display:flex;flex-wrap:wrap;gap:12px;background:linear-gradient(135deg,#0b4a63,#0e7490 60%,#14b8a6);color:#fff;border-radius:16px;padding:16px 20px;margin-bottom:12px;position:relative;overflow:hidden}.bsum::after{content:"";position:absolute;inset:0;background:linear-gradient(110deg,transparent 30%,rgba(255,255,255,.14) 50%,transparent 70%);animation:bsumSheen 5s ease-in-out infinite}@keyframes bsumSheen{from{transform:translateX(-100%)}to{transform:translateX(100%)}}
.bsum>div{flex:1;min-width:120px}.bsum b{display:block;font-size:26px;font-weight:800}.bsum span{font-size:12.5px;color:#cffafe}.bnote{margin-bottom:10px}
.bchips{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap}.bchip{font:inherit;font-size:13px;font-weight:600;padding:6px 14px;border-radius:99px;border:1px solid #cbd5e1;background:#fff;color:#0b4a63;cursor:pointer;transition:transform .15s}.bchip:hover{transform:translateY(-1px)}.bchip.on{background:#0e7490;color:#fff;border-color:#0e7490}
.bcard{background:#fff;border:1px solid #e2e8f0;border-radius:14px;margin-bottom:10px;overflow:hidden;animation:fadein .3s ease-out both;animation-delay:calc(var(--i)*30ms)}.bhead{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 14px;background:#f8fafc;border-bottom:1px solid #e2e8f0;font-size:14px}.bhead small{display:block;color:#64748b;font-size:12px;margin-top:2px}.bhead .btn2{padding:5px 10px;font-size:12.5px;text-decoration:none}
.bit{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:9px 14px;border-top:1px dashed #eef2f7;font-size:13.5px}.bit>div{flex:1;min-width:180px}.bit a{color:#0b4a63;font-weight:600;text-decoration:none}.bit a:hover{text-decoration:underline}.bit small{display:block;color:#64748b;font-size:12px}
.bseg{display:inline-flex;border:1px solid #cbd5e1;border-radius:9px;overflow:hidden}.bseg button{font:inherit;font-size:12px;border:0;background:#fff;padding:5px 9px;cursor:pointer;color:#475569}.bseg button+button{border-left:1px solid #cbd5e1}.bseg .on.sOut{background:#f59e0b;color:#fff}.bseg .on.sReturned{background:#16a34a;color:#fff}.bseg .on.sUsedup{background:#64748b;color:#fff}
.bside{padding:14px;margin-bottom:12px}.bside h4{margin:0 0 8px;font-size:14px}.brow{display:flex;justify-content:space-between;gap:8px;padding:6px 0;border-top:1px solid #f1f5f9;font-size:13px;text-decoration:none;color:inherit}.brow span{color:#64748b;text-align:right}
.hist{margin-top:10px;border-top:1px solid #e2e8f0;padding-top:8px}.hist summary{cursor:pointer;font-weight:700;color:#0b4a63;font-size:13.5px}.hl{margin-top:6px}.hrow{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:7px 10px;border-radius:10px;font-size:13px;transition:background .2s}.hrow:hover{background:#f0f9ff}.hrow small{color:#64748b;width:100%}.hrow.now{background:linear-gradient(90deg,#ecfeff,transparent)}.hnow{background:#0891b2;color:#fff;border-radius:99px;padding:1px 8px;font-size:11px;font-weight:700;animation:hnowP 2s ease-in-out infinite}@keyframes hnowP{50%{box-shadow:0 0 0 4px rgba(8,145,178,.15)}}
.rqbox{margin-top:10px;background:#fffbeb;border:1px solid #fcd34d;border-radius:12px;padding:10px;animation:rqIn .4s ease both}.rqbox>b span,.rqb{background:#f59e0b;color:#fff;border-radius:99px;padding:0 7px;margin-left:5px;font-size:11px}.rqi{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:8px 0;border-top:1px dashed #fcd34d;font-size:13px}.rqi>div{flex:1;min-width:140px}.rqi small{display:block;color:#92400e}.rqi .btn2{padding:6px 10px}@keyframes rqIn{from{opacity:0;transform:translateY(-4px)}}
.swaps{margin-top:10px;font-size:12.5px}.swaps summary{cursor:pointer;font-weight:700;color:#0b4a63}.swaps summary span{background:#0891b2;color:#fff;border-radius:99px;padding:0 7px;margin-left:4px;font-size:11px}.swp{display:flex;flex-wrap:wrap;gap:4px;padding:6px 0;border-bottom:1px dashed #e2e8f0;animation:swpIn .35s ease both}.swp small{color:#64748b;width:100%}.swp.o b{color:#b91c1c}@keyframes swpIn{from{opacity:0;transform:translateX(-6px)}}
.cm-bounce{margin-top:6px;font-size:12.5px;color:#b45309;background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:4px 8px;animation:cmPulse 2.4s ease-in-out infinite}@keyframes cmPulse{50%{box-shadow:0 0 0 4px rgba(251,146,60,.18)}}
.btn2.pri{position:relative;overflow:hidden}.btn2.pri::after{content:'';position:absolute;top:0;bottom:0;left:-60%;width:40%;background:linear-gradient(100deg,transparent,rgba(255,255,255,.45),transparent);transform:skewX(-20deg);transition:left .5s ease}.btn2.pri:hover::after{left:120%}
.cm-list{list-style:none;margin:0;padding:0}.cm-list li{display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px solid #eef2f7;flex-wrap:wrap}.cm-list li b{min-width:150px}.cm-list li .muted{flex:1;font-size:13px}.cm-list .btn2{text-decoration:none}
.ctypes button{transition:transform .18s cubic-bezier(.2,1.4,.4,1),box-shadow .18s}.ctypes button:hover{transform:translateY(-3px) scale(1.04);box-shadow:0 8px 18px -8px rgba(14,116,144,.6)}
.eli.sel{position:relative}.eli.sel::after{content:'';position:absolute;left:0;top:8px;bottom:8px;width:4px;border-radius:4px;background:linear-gradient(180deg,#22d3ee,#a78bfa,#f472b6,#22d3ee);background-size:100% 300%;animation:selflow 2.4s linear infinite}@keyframes selflow{to{background-position:0 300%}}
.rp-ramp{font-size:10.5px;font-weight:800;color:#047857;background:#d1fae5;border-radius:6px;padding:1px 7px;text-decoration:none}.rp-ramp:hover{background:#a7f3d0}.rp-chip.unk{background:#94a3b8}
.pbs{position:relative;overflow:hidden}.pbs::after{content:'';position:absolute;top:0;bottom:0;left:-40%;width:30%;background:linear-gradient(100deg,transparent,rgba(255,255,255,.22),transparent);transform:skewX(-18deg);animation:pbsheen 5.5s ease-in-out infinite;pointer-events:none}@keyframes pbsheen{0%,55%{left:-40%}100%{left:130%}}
.tabs a.reptab{background:linear-gradient(90deg,#e4f222,#fde68a,#facc15,#e4f222);background-size:300% 100%;-webkit-background-clip:text;background-clip:text;color:transparent!important;animation:goldrun 4s linear infinite}.tabs a.reptab .ti{color:#e4f222}@keyframes goldrun{to{background-position:300% 0}}
.rp-add{padding:14px 16px;margin-bottom:14px;animation:vnin .3s ease-out}.rp-addh{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}.rp-addh b{font-size:15px}
.rp-cam{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;min-height:120px;border:2px dashed #67e8f9;border-radius:14px;background:#ecfeff;color:#0e7490;font-weight:700;cursor:pointer;padding:10px;text-align:center}
.rp-cam input{position:absolute;width:1px;height:1px;opacity:0}.rp-cam img{max-width:100%;max-height:260px;border-radius:10px;box-shadow:0 6px 16px -8px rgba(0,0,0,.4)}
.rp-f{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:12px}.rp-f label{display:flex;flex-direction:column;gap:4px;font-size:12px;font-weight:700;color:#475569}
.rp-f input,.rp-f select{font:inherit;font-size:16px;font-weight:400;padding:10px;border:1px solid #cbd5e1;border-radius:10px;min-height:44px;width:100%;box-sizing:border-box;background:#fff}.rp-f .rp-wide,.rp-f .rp-chk{grid-column:1/-1}
.rp-f .rp-chk{flex-direction:row;align-items:center;gap:8px;font-weight:600}.rp-f .rp-chk input{width:20px;min-height:20px}
@media(max-width:600px){.rp-f{grid-template-columns:1fr}#repAdd{width:100%;order:9}}

#vRep{padding:14px 24px 24px;max-width:1240px;margin:0 auto;animation:fadein .3s ease-out}body[data-v=vRep] .vopt{display:none}body[data-v=vRep] .bar{max-width:1240px;margin:0 auto}
#repMiss[aria-pressed=true]{background:#f59e0b;color:#fff;border-color:#f59e0b}
.rp-grid{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:16px;align-items:start}@media(max-width:900px){#vRep{padding:12px 16px}.rp-grid{grid-template-columns:1fr}}
.rp-pan{padding:14px 16px;margin-bottom:14px}.rp-pan h3{margin:0 0 10px;font-size:14px}
.rp-mo{display:flex;align-items:flex-end;gap:5px;height:120px}.rp-mo div{flex:1;height:100%;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:4px}
.rp-mo i{display:block;width:100%;border-radius:6px 6px 2px 2px;background:linear-gradient(180deg,#22d3ee,#0e7490);transition:height .5s cubic-bezier(.2,.9,.3,1.2)}.rp-mo div:hover i{background:linear-gradient(180deg,#facc15,#f59e0b)}.rp-mo span{font-size:10px;color:#64748b}
.rp-tk{position:relative;display:flex;justify-content:space-between;align-items:center;gap:8px;width:100%;text-align:left;border:1px solid #e2e8f0;background:#fff;border-radius:10px;padding:8px 10px;margin-bottom:6px;cursor:pointer;font:inherit;overflow:hidden;transition:border-color .15s,transform .15s}
.rp-tk:hover{border-color:#22d3ee;transform:translateX(2px)}.rp-tk.on{border-color:#0e7490;box-shadow:0 0 0 2px rgba(34,211,238,.35)}
.rp-tk span{display:flex;flex-direction:column;position:relative;z-index:1;min-width:0}.rp-tk b{font-size:13px}.rp-tk small{font-size:11.5px;color:#64748b}.rp-tk em{font-style:normal;font-weight:800;font-size:13px;position:relative;z-index:1;font-variant-numeric:tabular-nums}
.rp-tk i{position:absolute;left:0;bottom:0;height:3px;background:linear-gradient(90deg,#22d3ee,#a78bfa)}
.rp-list{padding:4px 0}.rp-row{display:grid;grid-template-columns:62px minmax(0,1fr) auto;gap:12px;align-items:center;padding:11px 16px;border-top:1px solid #eef2f7;animation:vnin .3s ease-out both;animation-delay:calc(var(--i)*25ms)}.rp-row:first-child{border-top:0}
.rp-row:hover{background:#f0fdff}.rp-dt{display:flex;flex-direction:column;align-items:center;background:#ecfeff;border-radius:10px;padding:5px 0}.rp-dt b{font-size:13px;color:#0e7490}.rp-dt small{font-size:10.5px;color:#64748b}
.rp-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.rp-chip{border:0;background:#0e7490;color:#fff;font:inherit;font-size:11.5px;font-weight:700;border-radius:999px;padding:2px 9px;cursor:pointer}.rp-chip:hover{background:#0891b2}
.rp-shop{font-size:12.5px;font-weight:600;color:#334155}.rp-tag{font-size:10.5px;font-weight:700;color:#7c3aed;background:#ede9fe;border-radius:6px;padding:1px 6px}
.rp-work{font-size:13.5px;color:#0f172a;margin-top:3px}.rp-amt{font-weight:800;font-size:15px;font-variant-numeric:tabular-nums;white-space:nowrap}.rp-amt.miss{font-size:12px;font-weight:700;color:#b45309;background:#fef3c7;border-radius:999px;padding:3px 10px}
.rp-fil{display:flex;align-items:center;gap:10px;margin-bottom:10px;font-size:13.5px}
.tabs button:hover .ti{animation:tiwig .45s ease-in-out}@keyframes tiwig{25%{transform:rotate(-14deg) scale(1.15)}60%{transform:rotate(10deg) scale(1.1)}}

.chk tbody tr:hover .av,.drow:hover .av,.eli:hover .av{box-shadow:0 0 0 2px #fff,0 0 0 4px #22d3ee,0 6px 14px -4px rgba(14,116,144,.6)}.chk th.now{background:linear-gradient(180deg,#cffafe,transparent);border-radius:10px 10px 0 0}
.nah{display:flex;justify-content:space-between;align-items:center;margin:16px 4px 6px;font-size:12px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#64748b}.nah span{background:#e2e8f0;color:#334155;border-radius:999px;padding:1px 9px}
.nai{display:block!important;cursor:default}.nai summary{display:flex;justify-content:space-between;align-items:center;gap:8px;cursor:pointer;list-style:none}.nai summary::-webkit-details-marker{display:none}
.nai .pill.nat{background:#f1f5f9;color:#64748b;border:1px dashed #94a3b8;font-size:11px;font-weight:700;border-radius:999px;padding:2px 8px;white-space:nowrap}.naw{margin-top:8px}.nai b .tno{margin-right:6px}
.tcard{transition:transform .2s cubic-bezier(.2,1.4,.4,1),box-shadow .2s}.tcard:hover{transform:translateY(-4px) rotate(-.4deg);box-shadow:0 14px 30px -12px rgba(14,116,144,.55),0 0 0 2px rgba(34,211,238,.35)}
.oilc{margin-left:auto;font-size:12px;font-weight:700;color:#15803d;background:#dcfce7;border-radius:999px;padding:3px 10px}
.vnl{list-style:none;margin:10px 0 0;padding:0;display:flex;flex-direction:column;gap:8px}
.vnl li{position:relative;background:#fff;border:1px solid #e2e8f0;border-left:4px solid #22d3ee;border-radius:12px;padding:9px 40px 9px 12px;font-size:13.5px;line-height:1.4;animation:vnin .3s ease-out both}
.vnl li.chk{border-left-color:#f59e0b}.vnl li.oil{border-left-color:#16a34a}.vnl li.oil .vnd{color:#15803d;background:#dcfce7}.vnl .vnd{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.03em;color:#0e7490;background:#cffafe;border-radius:6px;padding:1px 7px;margin-right:6px}
.vnl li.chk .vnd{color:#b45309;background:#fef3c7}.vnl .vns{font-size:11.5px;font-weight:600;color:#64748b}.vnl .vnt{display:block;margin-top:3px;color:#0f172a}
.vnl .vnx{position:absolute;right:8px;top:8px;border:0;background:none;color:#94a3b8;font:inherit;font-size:16px;font-weight:700;line-height:1;width:24px;height:24px;border-radius:7px;cursor:pointer;transition:background .15s,color .15s}
.vnl .vnx:hover{background:#fee2e2;color:#dc2626}.vnl .vnx.sure{width:auto;padding:0 8px;font-size:12px;background:#dc2626;color:#fff}
@keyframes vnin{from{opacity:0;transform:translateY(4px)}}
.vnmore{margin-top:6px}.vnmore summary{cursor:pointer;font-size:12.5px;font-weight:600;color:var(--poolInk)}
.vnotes{margin-top:12px;padding-top:10px;border-top:1px dashed rgba(14,116,144,.25)}.vnh{display:flex;align-items:baseline;gap:8px}.vnh .muted{font-size:12px}
.vnadd{display:flex;gap:6px;margin:8px 0}.vnadd input{flex:1;min-width:0;font:inherit;font-size:13px;padding:7px 10px;border:1px solid var(--line2);border-radius:9px;background:#fff}

/* ===== v22: frosted-glass map legend with a pulsing Moving dot ===== */
.legend{background:rgba(255,255,255,.62)!important;backdrop-filter:blur(10px) saturate(1.4);-webkit-backdrop-filter:blur(10px) saturate(1.4);border:1px solid rgba(255,255,255,.7)!important;box-shadow:0 8px 24px -10px rgba(8,74,99,.45)!important}
.legend span:first-child i{animation:legpulse 1.8s ease-out infinite}
@keyframes legpulse{0%{box-shadow:0 0 0 0 rgba(22,163,74,.6)}100%{box-shadow:0 0 0 7px rgba(22,163,74,0)}}
@media (prefers-reduced-motion:reduce){.legend span:first-child i{animation:none}}

/* ===== v23: trophy for a finished route ===== */
.tcard.fin{position:relative}.tcard.fin::after{content:'🏆';position:absolute;right:-8px;top:-10px;width:34px;height:34px;display:grid;place-items:center;font-size:18px;border-radius:50%;background:linear-gradient(135deg,#fef3c7,#fbbf24);box-shadow:0 6px 14px -6px rgba(180,83,9,.7),0 0 0 3px #fff;animation:trophy .7s cubic-bezier(.2,.9,.3,1.5) both;animation-delay:calc(var(--i,0)*35ms + .3s)}
@keyframes trophy{from{transform:scale(0) rotate(-40deg)}}
@media (prefers-reduced-motion:reduce){.tcard.fin::after{animation:none}}

.themebtn{margin-left:auto;display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:10px;border:0;background:rgba(255,255,255,.1);color:#e6f6fb;cursor:pointer}
.themebtn:hover{background:rgba(255,255,255,.18)}.themebtn .i-sun,html[data-theme=dark] .themebtn .i-moon{display:none}html[data-theme=dark] .themebtn .i-sun{display:block}
header .live{margin-left:8px!important}
.rp-cam small{font-weight:500;font-size:12px;opacity:.85}
#repThumbs{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:8px;margin:10px 0 0}#repThumbs:empty{display:none}#repThumbs figure{margin:0;position:relative}
#repThumbs img{width:100%;height:110px;object-fit:cover;border-radius:10px;display:block;border:1px solid var(--line)}#repThumbs figcaption{font-size:11.5px;color:var(--muted);text-align:center;margin-top:2px}
#repThumbs button{position:absolute;top:4px;right:4px;width:24px;height:24px;border-radius:50%;border:0;background:rgba(15,23,42,.75);color:#fff;font-size:15px;line-height:1;cursor:pointer;padding:0}
.rpai{margin-top:10px;padding:9px 12px;border-radius:10px;font-size:13px;background:var(--idleBg);color:var(--ink2)}.rpai.busy{background:var(--shallow);color:var(--poolInk)}.rpai.ok{background:var(--goBg);color:var(--go);font-weight:600}
.rpfill{border-color:#4ade80!important;box-shadow:0 0 0 3px rgba(74,222,128,.18)}
/* ===== v30: calm look. Same pool colours, no moving decorations, quieter cards, more room ===== */
:root{--deck:#f3f6f8;--deck2:#e9eef1;--line:#e2e8ec;--line2:#d3dce2;--card:#fff;--r:14px;
 --sh:0 1px 2px rgba(15,35,50,.05),0 2px 8px -4px rgba(15,35,50,.08)}
body,body[data-v]{background:var(--deck)!important;background-image:none!important}
body::before,body::after,#bubbles,.caus,.sun,.birds,#floaty,.hwave,.hwave.front,header::before,header::after{display:none!important}
header,header[data-sky]{background:linear-gradient(100deg,#082a3d 0%,#0b4a63 60%,#0e6f8a 100%)!important;padding:12px 24px 0!important;box-shadow:none!important;border-bottom:0}
header .brand{font-size:16px}
header .logo,header .logo::after{animation:none!important}
.brand>div:last-child{background:none!important;-webkit-background-clip:border-box!important;background-clip:border-box!important;color:#fff!important}
.tabs a.reptab{background:none!important;-webkit-background-clip:border-box!important;background-clip:border-box!important;color:#fde68a!important}.tabs a.reptab .ti{color:#fde68a}
.crewhead h2{background:none!important;-webkit-background-clip:border-box!important;background-clip:border-box!important}
.tabs{background:transparent!important;border:0!important;box-shadow:none!important;padding:0!important;margin-top:4px;gap:2px;overflow-x:auto;scrollbar-width:none}
.tabs .tabind{display:none!important}
.tabs button{border-radius:10px 10px 0 0!important;padding:10px 14px 11px!important;color:rgba(226,244,250,.78)!important;background:transparent!important;box-shadow:none!important;font-weight:600}
.tabs button:hover{color:#fff!important;background:rgba(255,255,255,.07)!important}
.tabs button.on{background:var(--deck)!important;color:var(--poolInk)!important;font-weight:700}
.tabs button.on::after,.tabs button::before{display:none!important}
.live{background:rgba(255,255,255,.08)!important;border:0!important}
.live .ekg{display:none}
*,*::before,*::after{animation-duration:0s!important;animation-iteration-count:1!important}
.dot,.pulse,.sk,.spin,.spinner,[class*=spin]{animation-duration:revert!important;animation-iteration-count:revert!important}
.crewhead h2::after,h2::after{display:none!important}
.crewhead h2{padding-bottom:0!important;color:var(--ink)!important;font-size:22px;letter-spacing:-.01em}
body:not([data-v=vMap]):not([data-v=vEdit]) .bar{max-width:1240px;margin:0 auto}
body[data-v=vCam]:not([data-v=vMap]) .bar{max-width:1400px}
.tabs{flex-wrap:nowrap!important}.tabs button,.tabs a{white-space:nowrap;flex:0 0 auto}
@media(max-width:700px){header,header[data-sky]{padding:10px 12px 0!important}.tabs button{padding:9px 11px 10px!important}.tabs .ti{display:none}}
.bar{padding-top:18px}
.search input,input:not([type=checkbox]):not([type=radio]):not([type=range]),select,textarea{border-radius:10px}
/* cards: one soft border, no coloured top/side stripes */
.ukc,.tcard,.rmc,.pt,.card,.panel,.box,.ptp,.dcard,.drow,.rcard,.chkc,.ev{box-shadow:var(--sh)!important}
.ukc,.tcard,.rmc,.ptp{border:1px solid var(--line)!important;border-top-width:1px!important}
.ukc::before,.tcard::before,.rmc::before{display:none!important}
</style></head><body>
<header>
 <div class="caus" aria-hidden="true"></div>
 <svg class="hwave" viewBox="0 0 1200 24" preserveAspectRatio="none" aria-hidden="true"><path d="M0 14 Q 75 0 150 14 T 300 14 T 450 14 T 600 14 T 750 14 T 900 14 T 1050 14 T 1200 14 T 1350 14 T 1500 14 T 1650 14 T 1800 14 T 1950 14 T 2100 14 T 2250 14 T 2400 14 V24 H0Z"/></svg>
 <div class="sun" aria-hidden="true"><i></i></div>
 <div class="birds" aria-hidden="true"><b><svg viewBox="0 0 40 20"><path class="wl" d="M20 12 Q12 2 2 6 Q12 6 20 12"/><path class="wr" d="M20 12 Q28 2 38 6 Q28 6 20 12"/><ellipse cx="20" cy="12.5" rx="3.2" ry="2"/></svg></b><b><svg viewBox="0 0 40 20"><path class="wl" d="M20 12 Q12 2 2 6 Q12 6 20 12"/><path class="wr" d="M20 12 Q28 2 38 6 Q28 6 20 12"/><ellipse cx="20" cy="12.5" rx="3.2" ry="2"/></svg></b><b><svg viewBox="0 0 40 20"><path class="wl" d="M20 12 Q12 2 2 6 Q12 6 20 12"/><path class="wr" d="M20 12 Q28 2 38 6 Q28 6 20 12"/><ellipse cx="20" cy="12.5" rx="3.2" ry="2"/></svg></b></div>
 <div id="floaty" aria-hidden="true"></div>
 <svg class="hwave front" viewBox="0 0 1200 24" preserveAspectRatio="none" aria-hidden="true"><path d="M0 14 Q 75 0 150 14 T 300 14 T 450 14 T 600 14 T 750 14 T 900 14 T 1050 14 T 1200 14 T 1350 14 T 1500 14 T 1650 14 T 1800 14 T 1950 14 T 2100 14 T 2250 14 T 2400 14 V24 H0Z"/></svg>
 <div class="brand"><div class="logo"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M3 9c1.5 1.3 3 1.3 4.5 0s3-1.3 4.5 0 3 1.3 4.5 0 3-1.3 4.5 0"/><path d="M3 15c1.5 1.3 3 1.3 4.5 0s3-1.3 4.5 0 3 1.3 4.5 0 3-1.3 4.5 0" opacity=".6"/></svg></div><div>Millennial Pools<small>Fleet</small></div></div>
 <button id="themeBtn" class="themebtn" type="button" title="Switch light / dark" aria-label="Switch between light and dark mode" onclick="var h=document.documentElement,t=h.dataset.theme==='dark'?'light':'dark';h.dataset.theme=t;try{localStorage.setItem('theme',t)}catch(e){}"><svg class="i-moon" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg><svg class="i-sun" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg></button>
 <div class="live" id="live"><span class="dot"></span><svg class="ekg" viewBox="0 0 40 14" aria-hidden="true"><path d="M0 7h12l3-5 4 10 3-8 2 3h16"/></svg><span id="upd">Connecting to Azuga...</span></div>
 <nav class="tabs"><span class="tabind" aria-hidden="true"></span><button data-v="vMap" class="on"><svg class="ti" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>Live map</button><button data-v="vEdit"><svg class="ti" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 13l2-5h11l3 5v4H3z"/><circle cx="7" cy="17" r="2"/><circle cx="16" cy="17" r="2"/></svg>Edit vehicles</button><button data-v="vDrv"><svg class="ti" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5"/><circle cx="17" cy="9" r="2.4"/><path d="M15.5 14.6c2.8.2 5 2.1 5 5.4"/></svg>Drivers</button><button data-v="vPom"><svg class="ti" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 15c1.7 1.4 3.3 1.4 5 0s3.3-1.4 5 0 3.3 1.4 5 0 3.3-1.4 5 0"/><path d="M2 19.5c1.7 1.4 3.3 1.4 5 0s3.3-1.4 5 0 3.3 1.4 5 0 3.3-1.4 5 0"/><path d="M8 12V5a2 2 0 0 1 4 0M14 12V5a2 2 0 0 1 4 0M8 8h6"/></svg>Pools</button><button data-v="vChk"><svg class="ti" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4h6v3H9zM9 12l2 2 4-4M9 17h6"/></svg>Truck check-ups</button><button data-v="vRep"><svg class="ti" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z"/></svg>Repairs</button><button data-v="vBuy"><svg class="ti" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>Ramp</button><button data-v="vUp"><svg class="ti" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/><circle cx="12" cy="12" r="5"/><path d="M12 9.5V12l1.8 1.2"/></svg>Upkeep</button><button data-v="vCam"><svg class="ti" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="7" width="13" height="10" rx="2"/><path d="M16 11l5-3v8l-5-3z"/></svg>Cameras</button><a class="reptab" href="/report" target="_blank" rel="noopener"><svg class="ti" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>Score report</a></nav>
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
  <label class="dcon">✉️ Email<input name="email" type="email" maxlength="120" placeholder="name@millennialpools.com" autocomplete="off"><span class="hint">Check-up, service and safety emails go here</span></label>
  <label class="dcon">📱 Mobile phone<input name="phone" type="tel" maxlength="20" placeholder="(609) 555-0100" autocomplete="off"><span class="hint">Used for reminder texts</span></label>
  <label>Insurance policy<input name="policy" maxlength="60" list="policyList"></label>
  <label>Role<select name="role"><option value="">Not set</option><option>Tech</option><option>Tech assistant</option><option>District</option><option>Regional</option><option>Owner</option><option>Auditor</option><option>Staffer</option></select></label>
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
 <nav class="rsum" id="rsum" aria-label="Filter by role"></nav>
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
   <label>Role<select name="role"><option value="">Not set</option><option>Tech</option><option>Tech assistant</option><option>District</option><option>Regional</option><option>Owner</option><option>Auditor</option><option>Staffer</option></select></label>
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
 <div class="crewhead"><div><h2>Pools</h2><p id="pbCount" class="muted">Loading today&rsquo;s schedule from Pool Office Manager...</p></div><span style="flex:1"></span>
  <div class="rnav" id="pomNav"><button data-ps="routes" class="on">Today’s routes</button><button data-ps="time">Time at pools</button></div><label class="pbdate" id="pbDateL">Day <input type="date" id="pbDate"></label></div>
 <div id="psRoutes"><div id="pbSum"></div><div id="pbList" class="tgrid"></div></div>
 <div id="psTime" hidden></div>
</div>
<div id="vChk" hidden>
 <div class="crewhead"><div><h2>Truck check-ups</h2><p id="chkCount" class="muted">Loading check-ups from Pool Office Manager...</p></div><span style="flex:1"></span><button class="btn2 pri" id="chkMail">✉️ Email who missed</button></div>
 <div id="chkMailAuto"></div><div id="chkMailBox"></div><div id="chkSum"></div><div id="chkPlan"></div><div id="chkGrid"></div>
</div>
<div id="vRep" hidden>
 <div class="crewhead"><div><h2>Repairs</h2><p id="repCount" class="muted">Loading repairs from Airtable...</p></div><span style="flex:1"></span><button class="btn2" id="repMiss" aria-pressed="false">Missing a total</button><button class="btn2" id="repLink">🔗 Share upload link</button><button class="btn2 pri" id="repAdd">📷 Add invoice</button></div>
 <div id="repNew"></div>
 <div id="repSum"></div><div class="rp-grid"><div id="repList"></div><aside id="repSide"></aside></div>
</div>
<div id="vBuy" hidden>
 <div class="crewhead"><div><h2>Ramp</h2><p id="rampCount" class="muted">Card spend and reimbursements, last 12 months</p></div><span style="flex:1"></span><div class="rnav" id="rampNav"><button data-rs="ov" class="on">Overview</button><button data-rs="gas">Gas</button><button data-rs="gps">Gas vs GPS</button><button data-rs="cost">Cost per truck</button><button data-rs="items">Tools &amp; items</button></div></div>
 <div id="rsOv"></div>
 <div id="rsGas" hidden></div>
 <div id="rsGps" hidden></div>
 <div id="rsCost" hidden></div>
 <div id="rsItems" hidden><div class="crewhead" style="margin-top:4px"><p id="buyCount" class="muted">Loading Ramp purchases...</p><span style="flex:1"></span><select id="buyWho" aria-label="Filter by person"><option value="">Everyone</option></select><button class="btn2" id="buyRead">Read new receipts now</button></div>
 <div id="buySum"></div><div class="bchips" id="buyChips"></div><div class="rp-grid"><div id="buyList"></div><aside id="buySide"></aside></div></div>
</div>
<div id="vUp" hidden>
 <div class="crewhead"><div><h2>Upkeep</h2><p id="upCount" class="muted">Oil changes, renewals and safety emails</p></div><span style="flex:1"></span><div class="rnav" id="upNav"><button data-us="oil" class="on">Oil changes</button><button data-us="ren">Renewals</button><button data-us="saf">Safety emails</button></div></div>
 <div id="usBody"><div class="empty">Loading...</div></div>
</div>
<div id="vCam" hidden>
 <div class="crewhead"><div><h2>Camera events</h2><p id="camCount" class="muted">Loading the last 7 days from Azuga...</p></div><span style="flex:1"></span>
  <span class="camat" id="camAt" title="Cameras and camera events are copied to Airtable every hour">Airtable</span><button class="btn2" id="camSync">⟳ Sync to Airtable</button><button class="btn2" id="camSer" aria-pressed="false">Serious only</button><select id="camDrv" aria-label="Filter by driver"><option value="">All drivers</option></select></div>
 <div id="camTypes" class="ctypes"></div><div id="cgrid" class="cboard"></div>
</div>
<div id="vEdit" hidden><div class="ed">
 <aside class="panel edl"><div class="edf"><label><input type="checkbox" id="needs"> Only show trucks that need attention</label><div id="syncBar" style="margin-top:10px"></div><div class="syncp sm" id="syncE"></div><a class="btn2 qrbtn" href="/stickers" target="_blank" rel="noopener">▦ Print truck QR stickers</a><div id="swapBox"></div></div><div id="edList"></div></aside>
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
// Azuga sends several odometers: prefer the current reading (what was entered here, plus GPS miles since), then the truck's own (sometimes in km).
// (vehicleDeviceOdoReading is the reading at tracker install, so it's stale.)
const odo=r=>{const cur=+r.vehicleDeviceCurrentodoReading,v=cur>0?cur:(r.odo_support&&+r.vehicleSupportedOdoValue)||+r.totalDistanceTravelled||+r.odometerReading;return v>0?Math.round(v).toLocaleString()+' mi'+(cur>0&&r.odoSource==='User input'?' (entered + GPS)':cur>0?'':' (from the truck)'):'Not reported yet'};
const when=t=>+t>1e11?new Date(+t).toLocaleString([], {weekday:'short',month:'short',day:'numeric',...(new Date(+t).getFullYear()!==new Date().getFullYear()?{year:'numeric'}:{}),hour:'numeric',minute:'2-digit'}):(t||'');
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
  $('media').showModal();syncVids([...$('mbody').querySelectorAll('video')]);
}
// road and driver cameras play together: the first video's controls drive the other one
function syncVids(vs){if(!vs.length)return;const [lead,...rest]=vs;
  rest.forEach(v=>{v.muted=true;v.controls=false;v.onclick=()=>lead.paused?lead.play():lead.pause()});
  const follow=()=>rest.forEach(v=>{if(Math.abs(v.currentTime-lead.currentTime)>.25)v.currentTime=lead.currentTime;v.playbackRate=lead.playbackRate;if(lead.paused!==v.paused)(lead.paused?v.pause():v.play().catch(()=>{}))});
  ['play','pause','seeked','ratechange'].forEach(ev=>lead.addEventListener(ev,follow));lead.addEventListener('timeupdate',follow);
  lead.play().catch(()=>{})}
document.addEventListener('click',e=>{const b=e.target.closest('.evb');if(b&&!b.disabled)openMedia(+b.dataset.i);if(e.target.id==='mclose'||e.target.id==='media')closeMedia()});
function closeMedia(){$('mbody').querySelectorAll('video').forEach(v=>v.pause());$('media').close()}
$('media').addEventListener('close',()=>$('mbody').querySelectorAll('video').forEach(v=>v.pause()));
const retried=new Set();function retry(id){if(retried.has(id))return;retried.add(id);setTimeout(()=>{if(sel==id)select(id)},30000)}
// ---- Airtable (source of truth) ----
let AT=null;
// Past drivers (last 12 months): Azuga driving + sticker sign-ins. Filled in after the card draws.
function histBox(v,t){return '<details class="hist" data-v="'+esc(v)+'" data-t="'+esc(t)+'"><summary>Past drivers · last 12 months</summary><div class="hl muted">Loading...</div></details>'}
document.addEventListener('toggle',async e=>{const d=e.target;if(!d.classList||!d.classList.contains('hist')||!d.open||d.dataset.done)return;d.dataset.done=1;const box=d.querySelector('.hl');
  try{const l=await get('/api/truck/history?v='+encodeURIComponent(d.dataset.v)+'&t='+encodeURIComponent(d.dataset.t));const f=x=>new Date(x).toLocaleDateString('en-US',{month:'short',year:'numeric'});
    box.className='hl';box.innerHTML=l.length?l.map(h=>'<div class="hrow'+(h.now?' now':'')+'"><b>'+esc(h.name)+'</b>'+(h.now?'<span class="hnow">Now</span>':'')+'<small>'+(f(h.from)===f(h.to)?f(h.to):f(h.from)+' – '+f(h.to))+(h.miles?' · '+h.miles.toLocaleString()+' mi':'')+(h.signIns?' · '+h.signIns+' sign-in'+(h.signIns>1?'s':''):'')+'</small></div>').join(''):'<span class="muted">No drivers on record yet. Sticker sign-ins will show here.</span>'}
  catch(err){box.textContent=err.message}},true);
async function swapPanel(){const el=$('swapBox');if(!el)return;let l=[],rq=[];try{[l,rq]=await Promise.all([get('/api/truck/swaps'),get('/api/truck/requests')])}catch(e){}
  const tab=[...document.querySelectorAll('nav button,.tabs button,[data-v]')].find(x=>/Edit vehicles/.test(x.textContent));if(tab){let b=tab.querySelector('.rqb');if(!b&&rq.length){b=document.createElement('span');b.className='rqb';tab.appendChild(b)}if(b){b.textContent=rq.length;b.hidden=!rq.length}}
  el.innerHTML=(rq.length?'<div class="rqbox"><b>Sign-in requests <span>'+rq.length+'</span></b>'+rq.map(r=>'<div class="rqi"><div><b>'+esc(r.who)+'</b> wants '+esc(r.truck)+'<small>'+new Date(r.at).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})+'</small></div><button class="btn2 pri" data-rq="'+esc(r.id)+'" data-ok="1">Approve</button><button class="btn2" data-rq="'+esc(r.id)+'">Deny</button></div>').join('')+'<div id="rqMsg" class="muted" style="font-size:12px"></div></div>':'')+(l.length?'<details class="swaps"><summary>Recent truck sign-ins <span>'+l.length+'</span></summary>'+l.slice(0,25).map(x=>'<div class="swp'+(x.out?' o':'')+'"><b>'+esc(x.who)+'</b> '+(x.denied?'denied for':x.out?'signed out of':'→')+' '+esc(x.truck)+(x.was?' <small>('+esc(x.was)+' bumped)</small>':'')+'<small>'+new Date(x.at).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})+'</small></div>').join('')+'</details>':'');
  el.querySelectorAll('[data-rq]').forEach(b=>b.onclick=async()=>{el.querySelectorAll('[data-rq]').forEach(x=>x.disabled=true);try{const r=await post('/api/truck/request',{id:b.dataset.rq,approve:!!b.dataset.ok});if(r.who)toast(r.who+' is now in '+r.truck+(r.left&&r.left.length?' (moved off '+r.left.join(', ')+')':''));await loadAT()}catch(err){$('rqMsg').textContent=err.message;el.querySelectorAll('[data-rq]').forEach(x=>x.disabled=false)}})}
setInterval(swapPanel,60000);
async function camAtLabel(){try{const r=await get('/api/cameras/sync-status'),el=$('camAt');if(!el)return;const l=r.last;el.innerHTML=r.busy?'<i class="camdot spin"></i>Syncing to Airtable...':l?'<i class="camdot'+(l.error?' bad':'')+'"></i>'+(l.error?'Airtable sync failed: '+esc(l.error):'Airtable synced '+new Date(l.at).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})+' · '+l.cameras+' cameras'+(l.events?' · +'+l.events+' events':'')):'<i class="camdot off"></i>Not synced to Airtable yet'}catch(e){}}
setTimeout(camAtLabel,4000);setInterval(camAtLabel,5*60e3);
document.addEventListener('click',async e=>{const b=e.target.closest('#camSync');if(!b)return;b.disabled=true;$('camAt').innerHTML='<i class="camdot spin"></i>Syncing to Airtable...';try{const r=await post('/api/cameras/sync',{});$('camAt').innerHTML=r.error?'<i class="camdot bad"></i>'+esc(r.error):r.busy?'<i class="camdot spin"></i>Already syncing...':'<i class="camdot"></i>Synced: '+r.cameras+' cameras, '+r.events+' new events, '+r.trackers+' tracker boxes updated'}catch(err){$('camAt').textContent=err.message}b.disabled=false});
async function upBadge(){try{const r=await get('/api/upkeep/flags'),tab=document.querySelector('.tabs button[data-v=vBuy]');if(!tab)return;let b=tab.querySelector('.gbadge');if(!b){b=document.createElement('span');b.className='rqb gbadge';b.title='Fill-ups where the truck was not near the card';tab.appendChild(b)}b.textContent=r.gas;b.hidden=!r.gas}catch(e){}}
setTimeout(upBadge,3000);setInterval(upBadge,5*60e3);
async function loadAT(){swapPanel();try{AT=await get('/api/airtable')}catch(e){AT={connected:true,error:e.message,links:{}}}if(!$('vEdit').hidden)renderEdit();if(vehicles.length||locs.length)render()}
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
// Vehicle notes from Airtable, newest first, with a box to add one
function notesBox(t){const n=String(t.notes||'').split('\\n').filter(Boolean);
  return '<div class="vnotes"><div class="vnh"><b>Vehicle notes</b><span class="muted">'+(n.length?n.length+' note'+(n.length>1?'s':''):'None yet')+'</span>'+(t.oilDate?'<span class="oilc" title="Saved to Airtable from a note">🛢 Oil changed '+esc(new Date(t.oilDate+'T12:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}))+(t.oilMiles?' · '+Number(t.oilMiles).toLocaleString()+' mi':'')+'</span>':'')+'</div>'
    +'<div class="vnadd"><input maxlength="500" placeholder="Add a note: maintenance done, things to fix..." data-vn="'+esc(t.id)+'"><button class="btn2" data-vnsave="'+esc(t.id)+'">Add</button></div>'
    +(n.length?'<ul class="vnl">'+n.slice(0,5).map(x=>vnLi(x,t.id)).join('')+'</ul>'+(n.length>5?'<details class="vnmore"><summary>Show '+(n.length-5)+' older note'+(n.length>6?'s':'')+'</summary><ul class="vnl">'+n.slice(5).map(x=>vnLi(x,t.id)).join('')+'</ul></details>':''):'')+'</div>'}
function vnLi(line,tid){const m=/^([A-Z][a-z]{2} \\d{1,2}, \\d{4}) · (?:(From [^:]+): )?([\\s\\S]*)$/.exec(line),e=s=>String(s).replace(/[&<>"']/g,c=>'&#'+c.charCodeAt(0)+';');
  return '<li class="'+(/\\boil\\b/i.test(line)&&/chang|service|swap|replac/i.test(line)?'oil':m&&m[2]?'chk':'')+'">'+(m?'<span class="vnd">'+e(m[1])+'</span>'+(m[2]?'<span class="vns">'+e(m[2])+'</span>':'')+'<span class="vnt">'+e(m[3])+'</span>':'<span class="vnt">'+e(line)+'</span>')
    +'<button class="vnx" title="Delete this note" aria-label="Delete this note" data-vndel="'+e(tid)+'" data-line="'+e(line)+'">×</button></li>'}
document.addEventListener('click',async e=>{const b=e.target.closest('.vnotes [data-vndel]');if(!b)return;
  if(!b.classList.contains('sure')){b.classList.add('sure');b.textContent='Delete?';setTimeout(()=>{if(b.isConnected){b.classList.remove('sure');b.textContent='×'}},3000);return}
  b.disabled=true;try{await post('/api/truck/note-delete',{truckId:b.dataset.vndel,line:b.dataset.line});toast('Note deleted');await loadAT();if(sel)select(sel);if(!$('vEdit').hidden&&edSel)openEd(edSel)}catch(err){toast(err.message,'bad');b.disabled=false}});
document.addEventListener('click',async e=>{const b=e.target.closest('[data-vnsave]');if(!b)return;const i=document.querySelector('[data-vn="'+b.dataset.vnsave+'"]');if(!i||!i.value.trim())return i&&i.focus();
  b.disabled=true;try{const r=await post('/api/truck/note',{truckId:b.dataset.vnsave,text:i.value});i.value='';toast(r&&r.oil?'Note saved · oil change logged for '+r.oil.date:'Note saved to the truck');await loadAT();if(sel)select(sel);if(!$('vEdit').hidden&&edSel)openEd(edSel)}catch(err){toast(err.message,'bad')}b.disabled=false});
document.addEventListener('keydown',e=>{if(e.key==='Enter'&&e.target.matches('[data-vn]')){e.preventDefault();const b=document.querySelector('[data-vnsave="'+e.target.dataset.vn+'"]');if(b)b.click()}});
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
   +(Object.keys(L.changes||{}).length?'<div class="note">Azuga is out of date for this truck. Open it in Edit vehicles to sync.</div>':'')+notesBox(t)+'</div>';
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
  // Trucks that are in Airtable but have no Azuga tracker, so they still show up here
  const q=$('q').value.toLowerCase(),na=(AT&&AT.notInAzuga||[]).filter(t=>!q||[t.truckNo,t.desc,t.driverName,t.plate].join(' ').toLowerCase().includes(q)).sort((a,b)=>(parseInt(a.truckNo)||999)-(parseInt(b.truckNo)||999)||a.desc.localeCompare(b.desc));
  if(na.length)$('edList').insertAdjacentHTML('beforeend','<div class="nah">In Airtable, no Azuga tracker <span>'+na.length+'</span></div>'+na.map(t=>'<details class="eli nai"><summary><div><b>'+(t.truckNo?'<span class="tno">#'+esc(t.truckNo.split(/[ ~(]/)[0])+'</span>':'')+esc(t.desc||'Truck')+'</b><small>'+esc(t.driverName||'No driver')+(t.plate?' · '+esc(t.plate.trim()):'')+'</small></div><span class="pill nat">No tracker</span></summary>'
    +'<div class="naw">'+(!t.vinOk?'<div class="note">The VIN in Airtable doesn’t look right ('+esc(t.vin||'empty')+'). Fix it there so a tracker can link.</div>':t.dupVin?'<div class="note">Another Airtable truck has the same VIN ('+esc(t.vin)+'). One of them is wrong.</div>':'<div class="muted" style="font-size:12.5px">VIN '+esc(t.vin)+'. If one of the unnamed trackers above is in this truck, open that tracker and link it to #'+esc(t.truckNo||'this truck')+'.</div>')+notesBox(t)+histBox('',t.id)+'</div></details>').join(''));
  document.querySelectorAll('.eli[data-id]').forEach(e=>e.onclick=()=>openEd(e.dataset.id));
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
  const eL=link(vid(v)),eNo=eL&&eL.linked&&eL.truck.truckNo?eL.truck.truckNo.split(/[ ~(]/)[0]:'',eMk=String((eL&&eL.linked&&eL.truck.make)||v.make||'').toLowerCase().split(' ')[0];
  $('edCard').innerHTML='<div class="edh edhero mk-'+(MAKES[eMk]?MAKES[eMk][1].replace(/^mk-/,''):'other')+'"><div class="ehno">'+(eNo?'#'+esc(eNo):ICON.truck)+'</div><div><h2>'+tno(vid(v))+esc(title(v))+'</h2>'+azSub(v)+'</div><span class="pos">'+(i+1)+' of '+rs.length+'</span>'
    +'<div class="ehtruck" aria-hidden="true">'+truckArt(truckKind([(eL&&eL.linked&&eL.truck.model)||v.model||'',title(v)].join(' ')))+'</div></div>'

   +(lk?'<div class="at"><h4>Linked to Airtable'+(L.truck.truckNo?' truck #'+esc(L.truck.truckNo):'')+' · matched by '+esc(L.how)+'</h4>'
      +(Object.keys(L.changes).length?'Fields marked <span class="fromAt">FROM AIRTABLE</span> have newer info in Airtable. Click Save to update Azuga.':'Azuga matches Airtable.')
      +(L.notes||[]).map(n=>'<div class="note">'+esc(n)+'</div>').join('')+'<div style="margin-top:6px"><b>Driver in Airtable:</b> '+drvLine(L.truck.driver)+'</div>'+docBtns(L.truck)+notesBox(L.truck)+histBox(vid(v),L.truck.id)+'</div>'
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
   +'<ol class="plist">'+st.map((s,i)=>'<li class="'+(s.done?'done':'')+'" data-i="'+i+'"><span class="pn">'+(s.done?'✓':i+1)+'</span><div><b>'+esc(s.customer||'Customer')+'</b>'+(s.type?'<span class="psvc" style="--h:'+([...s.type].reduce((h,c)=>h*31+c.charCodeAt(0)>>>0,7)%150+170)+'">'+esc(s.type)+'</span>':'')+'<span>'+esc(s.address||'No address')+'</span>'
     +(s.visit?'<span class="pvisit">Arrived '+t(s.visit.arrive)+' · left '+t(s.visit.leave)+(s.visit.visits>1?' · came back '+(s.visit.visits-1)+'×':'')+(s.visit.how==='wide'?' <span class="pfar">parked ~'+(s.visit.ft>=1000?(s.visit.ft/5280).toFixed(2)+' mi':s.visit.ft+' ft')+' away</span>'+flag('The truck never stopped within 500 ft of the address in Pool Office Manager, so this visit was matched from up to 0.3 mi away. The address in POM may be off, or this could be a neighbouring stop.'):s.visit.how==='addr'?' <span class="pfar">matched by street</span>'+flag('Matched by street address instead of map position: the truck stopped at '+(s.visit.parkedAt||'a nearby number on the same street')+'. '+(s.lat?'POM\\'s map pin for this pool is more than 0.3 mi away, so the pin is probably wrong.':'POM has no map pin for this pool.')):'')+'</span>':(!isToday||s.done?'<span class="pvisit none">Truck not seen at this address</span>':''))+'</div>'
     +'<em>'+(s.visit?'<strong class="vmins'+(s.visit.mins<5?' short':s.visit.mins>60?' long':'')+'">'+s.visit.mins+' min</strong>':'')+(s.done?'Done':esc(String(s.serviceStatus||s.status||'To do').toLowerCase().split('_').join(' ').replace(/^./,c=>c.toUpperCase())))+(s.time?'<small>Scheduled '+t(s.time)+'</small>':'')+'</em></li>').join('')+'</ol>';
  bind();POMDAY=isToday?null:st;
  el.querySelectorAll('.plist li').forEach(li=>li.onclick=()=>{const s=st[+li.dataset.i];if(s.lat&&s.lng){map.setView([s.lat,s.lng],17);showPools()}})}
let POMDAY=null;
// Pools on the map once you zoom in: every tech's stops for today
const poolLayer=L.layerGroup();
const poolIcon=(s,z)=>{z=z||16;const small=z<13,lab=z>=15&&s.customer?'<b class="pplab">'+esc(String(s.customer).slice(0,22))+'</b>':'';
  return L.divIcon({className:'poolpin'+(s.done?' done':'')+(small?' sm':''),html:'<span>'+(small?'':s.done?'\u2713':'\u{1F3CA}')+'</span>'+lab,iconSize:small?[12,12]:[32,24],iconAnchor:small?[6,6]:[16,12]})};
async function loadPools(){try{const r=await get('/api/pom/stops');if(!r.connected)return;POMSTOPS=r.stops;showPools()}catch(e){}}
function showPools(){if(!POMSTOPS)return;const z=map.getZoom(),on=z>=10;if(on&&!map.hasLayer(poolLayer)){poolLayer.addTo(map)}else if(!on&&map.hasLayer(poolLayer)){map.removeLayer(poolLayer);return}
  poolLayer.clearLayers();POMSTOPS.forEach(s=>L.marker([s.lat,s.lng],{icon:poolIcon(s,z),keyboard:false,zIndexOffset:z>=13?200:-500}).bindTooltip('<b>'+esc(s.customer||'Pool')+'</b><br>'+esc(s.address)+'<br>'+(s.type?'<i>'+esc(s.type)+'</i><br>':'')+esc(s.tech||'')+' · '+(s.done?'Done':'Not done yet'),{direction:'top',offset:[0,-8]}).addTo(poolLayer))}
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
const ROLES=['Tech','Tech assistant','District','Regional','Owner','Auditor','Staffer'],ROLE_K=r=>ROLES.indexOf(r);let rfilt='';
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
  $('rsum').innerHTML='<button data-r="" aria-pressed="'+!rfilt+'">All roles</button>'+ROLES.map(r=>'<button data-r="'+r+'" class="role r'+ROLE_K(r)+'" aria-pressed="'+(rfilt===r)+'">'+r+' <b>'+all.filter(d=>d.role===r).length+'</b></button>').join('')+'<button data-r="none" aria-pressed="'+(rfilt==='none')+'">No role <b>'+all.filter(d=>!d.role).length+'</b></button>';
  $('rsum').querySelectorAll('button').forEach(b=>b.onclick=()=>{rfilt=b.dataset.r;renderDrivers()});
  const q=$('q').value.toLowerCase(),ds=all.filter(d=>(!rfilt||(rfilt==='none'?!d.role:d.role===rfilt))&&DF[dfilt][1](d)&&(!q||(d.name+' '+d.trucks.join(' ')+' '+d.license+' '+(d.role||'')).toLowerCase().includes(q)))
    .sort((a,b)=>inactive(a)-inactive(b)||a.name.localeCompare(b.name));
  [...picked].forEach(id=>{if(!all.some(d=>d.id===id))picked.delete(id)});
  $('drvRows').innerHTML=(ds.length?ds.map(d=>'<div class="rrow'+(inactive(d)?' off':'')+(picked.has(d.id)?' picked':'')+'" data-id="'+esc(d.id)+'"><input type="checkbox" class="pick" aria-label="Select '+esc(d.name)+'"'+(picked.has(d.id)?' checked':'')+'><div class="mav" style="'+pcol(d.name)+'">'+esc(initials(d.name))+'</div>'
    +'<div class="rn"><b class="nm">'+esc(d.name)+scoreChip(d.name)+(d.role?'<span class="role r'+ROLE_K(d.role)+'">'+esc(d.role)+'</span>':'')+(inactive(d)?'<span class="tag">Inactive</span>':'')+'</b><span>'+(!d.license&&!inactive(d)?'<em class="nolic">No license #</em>'+(d.policy?' · ':''):'')+esc([d.license&&((d.state?d.state+' ':'')+d.license),!inactive(d)&&d.policy].filter(Boolean).join(' · '))+(d.notes?' · '+esc(d.notes):'')+'</span></div>'
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
  for(const k of ['name','license','state','policy','notes','role','email','phone'])f[k].value=d[k]||'';f.status.value=d.status==='Inactive'?'Inactive':'Active';
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
  if(sn){sn.style.left=(6+Math.min(1,f)*80).toFixed(1)+'%';sn.style.top=(64-Math.sin(Math.min(1,f)*Math.PI)*14).toFixed(1)+'px';sn.classList.toggle('moon',!day)}}
sky();setInterval(sky,10*60e3);
// ---- Pools tab: every tech's POM route for the day, with progress ----
let POMB=null,pomTimer=null;
const hm=t=>t?new Date(t).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}):'';
async function loadPomBoard(){if(!PTAVG)loadPoolAvg();const d=$('pbDate');if(!d.value){d.value=new Date().toLocaleDateString('en-CA');d.max=d.value}
  clearTimeout(pomTimer);if(!POMB)$('pbList').innerHTML='<div class="tcard"><div class="sk" style="width:60%"></div><div class="sk" style="width:80%"></div></div>'.repeat(3);
  try{POMB=await get('/api/pom/board?date='+d.value);renderPom()}catch(e){$('pbList').innerHTML='<div class="empty">'+esc(e.message)+'</div>'}
  if(POMB&&POMB.today)pomTimer=setTimeout(()=>{if(!$('vPom').hidden)loadPomBoard()},120e3)}
$('pbDate').onchange=()=>{POMB=null;loadPomBoard()};
function stopLi(s){return '<li class="'+(s.done?'done':'')+'"><i>'+(s.done?'✓':'')+'</i><span><b>'+esc(s.customer||'Pool')+'</b><small>'+esc(s.address)+'</small></span><em>'+hm(s.time)+'</em></li>'}

// ---- Pools tab › Time at pools: GPS time on site per tech and per pool, with each tech's usual time going forward ----
let PT=null,PTD=30,PTV='techs',PTAVG=null;
async function loadPoolTime(){if(!PT)$('psTime').innerHTML='<div class="empty">Loading pool visits...</div>';try{PT=await get('/api/pools/time?days='+PTD)}catch(e){$('psTime').innerHTML='<div class="empty">Could not load: '+esc(e.message)+'</div>';return}renderPoolTime()}
const mins=m=>m>=60?Math.floor(m/60)+' h '+(m%60)+' min':m+' min';
function renderPoolTime(){const r=PT;if(!r)return;const q=$('q').value.trim().toLowerCase(),fa=r.fleetAvg||1;
  const T=r.techs.filter(t=>!q||t.name.toLowerCase().includes(q)),P=r.pools.filter(p=>!q||(p.name+' '+p.addr).toLowerCase().includes(q));
  const prog=r.logged<r.backfill?'<p class="muted ptnote">Still working back through GPS history: '+r.logged+' of '+r.backfill+' days done so far (a few days every 20 minutes). New days are added each morning.</p>':'';
  let h=kpis([[r.visits.toLocaleString(),'tech visits in the last '+r.days+' days'],[mins(r.fleetAvg),'average tech visit'],[T.length,'techs'],[r.oldest&&r.oldest!=='9999'?fdate(r.oldest):'–','tracked since']])
   +'<div class="ukbar">'+chips('pd',String(PTD),[['7','7 days'],['30','30 days'],['90','90 days'],['365','Year']])+'<span style="flex:1"></span>'+chips('pv',PTV,[['techs','By tech'],['pools','By pool']])+'</div>'+prog
   +((r.jobs||[]).length?'<div class="ptjobs"><span>Not counted in the averages:</span>'+r.jobs.map(j=>'<em title="'+j.n+' jobs, '+j.avg+' min on average">'+esc(j.name)+' <b>'+j.n+'</b> · '+j.avg+'m</em>').join('')+'</div>':'');
  if(PTV==='techs'){const mx=Math.max(1,...T.map(t=>t.avg));
    h+=T.length?'<div class="ukg">'+T.map(t=>{const d=t.avg-t.allAvg,vf=Math.round((t.avg/fa-1)*100),sh=Math.round(t.short/Math.max(1,t.n)*100);
      return '<div class="ukc pt'+(sh>=25?' hot':'')+'"><div class="ukc-h"><div><b>'+esc(t.name)+'</b><small>'+t.n+' visits · '+t.days+' days · ~'+t.perDay+' pools a day</small></div></div>'
       +'<div class="ukc-big"><b>'+t.avg+'</b><span>min a pool</span><em class="'+(vf>15?'up':vf<-15?'down':'')+'">'+(vf>0?'+':'')+vf+'% vs fleet</em></div>'
       +'<div class="ptbar"><i style="width:'+Math.round(t.avg/mx*100)+'%"></i><em style="left:'+Math.min(100,Math.round(fa/mx*100))+'%" title="Fleet average"></em></div>'
       +'<div class="ukc-f"><span>Middle visit '+t.med+' min</span><span>Usual (all visits): <b>'+t.allAvg+' min</b></span>'+(t.short?'<span class="'+(sh>=25?'ptbad':'')+'">'+t.short+' under 8 min</span>':'')+'</div>'
       +(Math.abs(d)>=3&&t.allN>t.n?'<div class="ptchg '+(d<0?'dn':'up')+'">'+(d<0?'▼ ':'▲ ')+Math.abs(d)+' min '+(d<0?'shorter':'longer')+' than usual lately</div>':'')
       +'<details class="ukd"><summary>Pools and recent visits</summary><div class="bd"><h4>Their pools <span>avg · visits</span></h4>'+t.pools.map(p=>'<div class="bdr"><div><b>'+esc(p.name||'Pool')+'</b></div><b>'+p.avg+' min · '+p.n+'</b></div>').join('')
       +((t.jobs||[]).length?'<h4>Other jobs <span>not in their average</span></h4>'+t.jobs.map(j=>'<div class="bdr"><div><b>'+esc(j.name)+'</b></div><b>'+j.avg+' min · '+j.n+'</b></div>').join(''):'')
       +'<h4>Recent visits</h4>'+t.recent.map(x=>'<div class="bdr"><div><b>'+esc(x.pool||'Pool')+'</b>'+(x.t?'<span class="ptjt">'+esc(x.t)+'</span>':'')+'<small>'+fdate(x.d)+(x.a?' · arrived '+new Date(x.a).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}):'')+(x.done?'':' · not submitted in POM')+'</small></div><b class="'+(x.m<8&&!x.t?'ptbad':'')+'">'+mins(x.m)+'</b></div>').join('')+'</div></details></div>'}).join('')+'</div>'
     :'<div class="empty">'+(r.logged?'No pool visits found for this range yet.':'No visits logged yet. The first days of GPS history are being worked out now; check back in a few minutes.')+'</div>'}
  else h+=P.length?'<div class="ptpools">'+P.map(p=>'<div class="ptp"><div><b>'+esc(p.name||'Pool')+'</b><small>'+esc(p.addr)+'</small></div><div class="ptm"><b>'+p.avg+' min</b><small>'+p.n+' visit'+(p.n>1?'s':'')+'</small></div><div class="ptt">'+p.techs.map(t=>'<span title="'+t.n+' visits">'+esc(t.name.split(' ')[0])+' '+t.avg+'m</span>').join('')+'</div></div>').join('')+'</div>':'<div class="empty">No pools match.</div>';
  $('psTime').innerHTML=h}
document.addEventListener('click',e=>{const n=e.target.closest('#pomNav [data-ps]');if(n){document.querySelectorAll('#pomNav button').forEach(x=>x.classList.toggle('on',x===n));const t=n.dataset.ps==='time';$('psRoutes').hidden=t;$('psTime').hidden=!t;$('pbDateL').hidden=t;if(t)loadPoolTime();return}
  const d=e.target.closest('[data-pd]');if(d){PTD=+d.dataset.pd;PT=null;loadPoolTime();return}
  const v=e.target.closest('[data-pv]');if(v){PTV=v.dataset.pv;renderPoolTime()}});
async function loadPoolAvg(){try{PTAVG=(await get('/api/pools/averages')).techs;if(POMB)renderPom()}catch(e){}}
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
      +'<div class="pbar"><i style="width:'+p+'%"></i></div><div class="tmeta"><b>'+t.done+' of '+t.total+'</b> pools done'+(last?' · last at '+esc(last.customer||'a pool'):'')+(PTAVG&&PTAVG[t.name]?' · <span class="ptus" title="Average of '+PTAVG[t.name].n+' GPS visits">usually '+PTAVG[t.name].avg+' min a pool</span>':'')+'</div>'
      +(nx?'<div class="tnext"><span>Next</span><b>'+esc(nx.customer||'Pool')+'</b><small>'+esc(nx.address)+(nx.time?' · '+hm(nx.time):'')+'</small></div>':'<div class="tnext fin"><span>All done</span><b>Route finished</b></div>')
      +'<details><summary>All '+t.total+' stops</summary><ol class="tstops">'+t.stops.map(stopLi).join('')+'</ol></details></div>'}).join(''):'<div class="empty">'+(q?'No techs match your search.':'No pools scheduled for this day.')+'</div>')}
document.addEventListener('click',e=>{const b=e.target.closest('.tchip');if(!b)return;document.querySelector('.tabs button[data-v=vMap]').click();select(b.dataset.truck)});
// Side-view work vehicles, facing right, plain white fleet paint, no logos. kind: mid | full | van
function truckArt(kind){
 const P={ // y0 = sill line, w = wheel centre y
  mid: {W:250,bed:46,roof:16,cb:98,ws:[160,182],hood:42,nose:236,y0:68,wy:72,r:17,wh:[58,194]},
  full:{W:262,bed:40,roof:10,cb:104,ws:[170,190],hood:34,nose:250,y0:68,wy:72,r:19,wh:[62,206]}}[kind];
 const d='<defs><linearGradient id="tbB" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset=".6" stop-color="#e8edf3"/><stop offset="1" stop-color="#b8c2ce"/></linearGradient>'
  +'<linearGradient id="tbG" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#dbeafe"/><stop offset=".5" stop-color="#7dd3fc"/><stop offset="1" stop-color="#1e3a5f"/></linearGradient>'
  +'<radialGradient id="tbR" cx=".4" cy=".35" r=".7"><stop offset="0" stop-color="#f8fafc"/><stop offset="1" stop-color="#94a3b8"/></radialGradient></defs>';
 const well=(x,y,r)=>'<path d="M'+(x-r-5)+' '+(y+1)+' A'+(r+5)+' '+(r+5)+' 0 0 1 '+(x+r+5)+' '+(y+1)+' Z" fill="#111827"/>';
 const wheel=(x,y,r)=>{let s='';for(let a=0;a<6;a++){const t=(a*60-90)*Math.PI/180;s+='<path d="M'+x+' '+y+'L'+(x+Math.cos(t)*r*.58).toFixed(1)+' '+(y+Math.sin(t)*r*.58).toFixed(1)+'" stroke="#64748b" stroke-width="2.2" stroke-linecap="round"/>'}
   return '<circle cx="'+x+'" cy="'+y+'" r="'+r+'" fill="#1f2937"/><circle cx="'+x+'" cy="'+y+'" r="'+(r-2.5)+'" fill="none" stroke="#374151" stroke-width="1.2"/><circle cx="'+x+'" cy="'+y+'" r="'+(r*.62)+'" fill="url(#tbR)" stroke="#475569"/>'+s+'<circle cx="'+x+'" cy="'+y+'" r="'+(r*.17)+'" fill="#334155"/>'};
 if(kind==='van'){const W=244,y0=68,wy=72,r=17,wh=[56,190];
  return '<svg viewBox="0 0 '+W+' 100" xmlns="http://www.w3.org/2000/svg">'+d+'<ellipse cx="'+W/2+'" cy="92" rx="'+(W/2-14)+'" ry="3.5" fill="rgba(0,0,0,.2)"/>'
   +'<path d="M14 '+y0+' V24 Q14 14 24 14 H176 Q190 14 202 32 L226 46 Q236 50 236 58 V'+y0+' Z" fill="url(#tbB)" stroke="#475569" stroke-width="1.2"/>'
   +well(wh[0],wy,r)+well(wh[1],wy,r)
   +'<path d="M178 20 H184 Q192 20 202 36 H178 Z" fill="url(#tbG)" stroke="#334155"/><path d="M150 22 H172 V38 H150 Z" fill="url(#tbG)" stroke="#334155"/>'
   +'<path d="M176 18 V64 M146 18 V64 M90 16 V64 M20 20 V64" stroke="#9aa6b5" stroke-width="1.1"/><rect x="160" y="44" width="8" height="2.4" rx="1.2" fill="#64748b"/><rect x="132" y="44" width="8" height="2.4" rx="1.2" fill="#64748b"/>'
   +'<path d="M14 42 H222" stroke="#fff" stroke-width="1.4" opacity=".8"/><path d="M14 43.5 H222" stroke="#9aa6b5" stroke-width=".8"/>'
   +'<path d="M226 47 Q234 50 235 55 H224 Z" fill="#fef3c7" stroke="#92400e" stroke-width=".7"/><rect x="230" y="57" width="7" height="7" rx="1.5" fill="#1f2937"/>'
   +'<path d="M196 30 l7 -3 v7 h-7z" fill="#1e293b"/><rect x="14" y="30" width="5" height="14" rx="1.5" fill="#dc2626"/>'
   +'<rect x="8" y="62" width="14" height="7" rx="3" fill="#475569"/><rect x="226" y="62" width="14" height="7" rx="3" fill="#475569"/><rect x="'+(wh[0]+r+6)+'" y="65" width="'+(wh[1]-wh[0]-2*r-12)+'" height="4" rx="2" fill="#334155"/>'
   +wheel(wh[0],wy,r)+wheel(wh[1],wy,r)+'</svg>'}
 return pickupArt(kind)}
function pickupArt(kind){const F=kind==='full';
 const cowl=F?76:82,hood=F?84:88,noseTop=F?92:98;
 const g='<defs>'
  +'<linearGradient id="tkP" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset=".38" stop-color="#f1f4f8"/><stop offset=".54" stop-color="#dde3ea"/><stop offset=".56" stop-color="#c9d1db"/><stop offset=".8" stop-color="#b3bdc9"/><stop offset="1" stop-color="#8e99a7"/></linearGradient>'
  +'<linearGradient id="tkS" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".45" stop-color="#fff" stop-opacity=".55"/><stop offset=".55" stop-color="#fff" stop-opacity="0"/></linearGradient>'
  +'<linearGradient id="tkG" x1="0" y1="0" x2=".35" y2="1"><stop offset="0" stop-color="#64748b"/><stop offset=".45" stop-color="#1e293b"/><stop offset="1" stop-color="#0b1220"/></linearGradient>'
  +'<linearGradient id="tkC" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f8fafc"/><stop offset=".5" stop-color="#94a3b8"/><stop offset="1" stop-color="#475569"/></linearGradient>'
  +'<linearGradient id="tkL" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset=".6" stop-color="#dbeafe"/><stop offset="1" stop-color="#93c5fd"/></linearGradient>'
  +'<linearGradient id="tkT" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#7f1d1d"/><stop offset=".5" stop-color="#ef4444"/><stop offset="1" stop-color="#b91c1c"/></linearGradient>'
  +'<radialGradient id="tkW" cx=".5" cy=".5" r=".5"><stop offset=".62" stop-color="#2b3340"/><stop offset=".9" stop-color="#151a22"/><stop offset="1" stop-color="#0a0d12"/></radialGradient>'
  +'<radialGradient id="tkR" cx=".38" cy=".32" r=".75"><stop offset="0" stop-color="#ffffff"/><stop offset=".5" stop-color="#cbd5e1"/><stop offset="1" stop-color="#64748b"/></radialGradient>'
  +'<filter id="tkB" x="-10%" y="-200%" width="120%" height="500%"><feGaussianBlur stdDeviation="4"/></filter></defs>';
 const wheel=(cx,cy)=>{let sp='',lug='';for(let i=0;i<6;i++){const a=(i*60-90)*Math.PI/180,b=a+.22,c=a-.22,d=a+.13,e=a-.13,P=(r,t)=>(cx+Math.cos(t)*r).toFixed(1)+' '+(cy+Math.sin(t)*r).toFixed(1);
    sp+='<path d="M'+P(7,e)+' L'+P(21.5,c)+' A21.5 21.5 0 0 1 '+P(21.5,b)+' L'+P(7,d)+' Z" fill="url(#tkR)" stroke="#475569" stroke-width=".6"/>';
    const l=a+Math.PI/6;lug+='<circle cx="'+(cx+Math.cos(l)*9.5).toFixed(1)+'" cy="'+(cy+Math.sin(l)*9.5).toFixed(1)+'" r="1.5" fill="#94a3b8"/>'}
  return '<circle cx="'+cx+'" cy="'+cy+'" r="36" fill="url(#tkW)"/><circle cx="'+cx+'" cy="'+cy+'" r="33" fill="none" stroke="#3a4352" stroke-width="1"/>'
   +'<circle cx="'+cx+'" cy="'+cy+'" r="24.5" fill="#cbd5e1"/><circle cx="'+cx+'" cy="'+cy+'" r="23" fill="#1f2937"/><circle cx="'+cx+'" cy="'+cy+'" r="17" fill="#3f4a5a"/>'
   +'<path d="M'+(cx-14)+' '+(cy+6)+' a15 15 0 0 1 4 -18" stroke="#b91c1c" stroke-width="5" fill="none" stroke-linecap="round" opacity=".85"/>'
   +sp+'<circle cx="'+cx+'" cy="'+cy+'" r="12" fill="url(#tkR)" stroke="#64748b" stroke-width=".8"/>'+lug+'<circle cx="'+cx+'" cy="'+cy+'" r="4.5" fill="#334155" stroke="#e2e8f0" stroke-width="1"/>'
   +'<path d="M'+(cx-20)+' '+(cy-12)+' A23 23 0 0 1 '+(cx+6)+' '+(cy-22)+'" stroke="#fff" stroke-width="1.6" fill="none" opacity=".55"/>'};
 const body='M40 150 C34 150 32 146 32 140 L32 92 C32 86 36 84 42 84 L214 84 C216 64 220 50 228 44 C232 40 238 38 248 38 L330 37 C341 37 347 40 353 46 L392 '+cowl
  +' C420 '+(cowl+1)+' 456 '+hood+' 478 '+(hood+4)+' C490 '+(hood+7)+' 497 '+(noseTop+2)+' 498 '+(noseTop+12)+' L500 140 C500 148 496 150 490 150 L450 150 A40 40 0 0 0 370 150 L168 150 A40 40 0 0 0 88 150 Z';
 return '<svg viewBox="0 0 520 210" xmlns="http://www.w3.org/2000/svg">'+g
  +'<ellipse cx="268" cy="192" rx="236" ry="7" fill="rgba(15,23,42,.35)" filter="url(#tkB)"/>'
  +'<path d="M86 152 A42 42 0 0 1 170 152 Z M368 152 A42 42 0 0 1 452 152 Z" fill="#0b1220"/>'
  +'<path d="'+body+'" fill="url(#tkP)" stroke="#5b6675" stroke-width="1.4" stroke-linejoin="round"/>'
  // bed: rail cap, tailgate seam, inner bed shadow line
  +'<path d="M40 84 L45 79 H211 L214 84 Z" fill="#a3adba"/><path d="M46 80.5 H210" stroke="#6b7684" stroke-width="1"/>'+'<path d="M38 84 H214" stroke="#7b8796" stroke-width="3" stroke-linecap="round"/><path d="M40 82.6 H212" stroke="#fff" stroke-width="1" opacity=".9"/>'
  +'<path d="M46 87 V146" stroke="#8b96a4" stroke-width="1.1"/><path d="M47 87 V146" stroke="#fff" stroke-width=".8" opacity=".7"/>'
  // glass with pillars + reflection
  +'<path d="M228 82 C229 66 232 54 240 49 C243 47 247 46 253 46 L329 45 C336 45 341 47 345 51 L'+(F?372:378)+' '+(cowl-1)+' Z" fill="url(#tkG)" stroke="#0f172a" stroke-width="2.4" stroke-linejoin="round"/>'
  +'<rect x="295" y="44" width="8" height="'+(cowl-42)+'" fill="#111827"/>'
  +'<path d="M246 50 L262 50 L240 80 L232 80 Z M312 48 L330 48 L300 80 L284 80 Z" fill="#fff" opacity=".14"/>'
  +'<path d="M232 47 C238 41 244 40 252 40 L330 39" stroke="#fff" stroke-width="1.6" fill="none" opacity=".9"/>'
  // doors, handles, mirror
  +'<path d="M222 86 C222 108 224 128 228 147 M299 86 V148 M'+(F?380:386)+' '+(cowl+3)+' C'+(F?386:391)+' 104 388 126 364 147" stroke="#8b96a4" stroke-width="1.3" fill="none"/>'
  +'<rect x="262" y="95" width="16" height="4.5" rx="2.2" fill="#475569"/><rect x="262" y="95" width="16" height="1.6" rx=".8" fill="#e2e8f0"/>'
  +'<rect x="338" y="95" width="16" height="4.5" rx="2.2" fill="#475569"/><rect x="338" y="95" width="16" height="1.6" rx=".8" fill="#e2e8f0"/>'
  +'<path d="M'+(F?366:372)+' '+(cowl-14)+' l20 -3 c5 -.5 8 3 8 8 v5 c0 4 -3 6 -7 6 h-19 z" fill="#1f2937"/><path d="M'+(F?369:375)+' '+(cowl-13)+' l16 -2" stroke="#64748b" stroke-width="1.2"/>'
  // body crease + sheen
  +'<path d="M34 108 C150 108 330 109 496 113" stroke="#fff" stroke-width="2.2" fill="none" opacity=".75"/><path d="M34 110.5 C150 110.5 330 111.5 496 115.5" stroke="#8b96a4" stroke-width="1" fill="none"/>'
  +'<path d="'+body+'" fill="url(#tkS)" opacity=".5"/>'
  // rocker + flares
  +'<path d="M170 140 H368 V150 H170 Z" fill="#475569" opacity=".55"/>'
  +'<path d="M83 150 A45 45 0 0 1 173 150 M365 150 A45 45 0 0 1 455 150" stroke="#1f2937" stroke-width="7" fill="none" stroke-linecap="round"/>'
  // lights, grille, bumpers
  +'<path d="M32 92 H40 V120 H32 Z" fill="url(#tkT)" stroke="#450a0a" stroke-width=".8"/><path d="M33.5 95 H38.5 V104 H33.5 Z" fill="#fca5a5" opacity=".6"/>'
  +(F?'<path d="M470 '+(hood+3)+' C484 '+(hood+5)+' 494 '+(noseTop+2)+' 497 '+(noseTop+10)+' L472 '+(noseTop+12)+' Z" fill="url(#tkL)" stroke="#94a3b8" stroke-width="1"/><path d="M488 '+(noseTop+14)+' H500 V132 H486 Z" fill="#111827"/><path d="M487 '+(noseTop+20)+' H500 M486 '+(noseTop+27)+' H500 M486 '+(noseTop+34)+' H500" stroke="#475569" stroke-width="1.6"/>'
     :'<path d="M462 '+(hood+2)+' C478 '+(hood+4)+' 490 '+(noseTop+2)+' 495 '+(noseTop+8)+' L470 '+(noseTop+11)+' C465 '+(noseTop+7)+' 463 '+(hood+8)+' 462 '+(hood+2)+' Z" fill="url(#tkL)" stroke="#94a3b8" stroke-width="1"/><path d="M493 '+(noseTop+12)+' L499 '+(noseTop+13)+' L500 130 L490 130 Z" fill="#111827"/><path d="M492 '+(noseTop+18)+' H500 M491 '+(noseTop+24)+' H500" stroke="#475569" stroke-width="1.4"/>')
  +'<path d="M472 130 H502 C505 130 507 134 507 141 C507 150 503 155 497 155 H454 C452 150 456 140 462 136 Z" fill="#374151"/><path d="M472 130.5 H503" stroke="#9ca3af" stroke-width="1.4"/><rect x="484" y="143" width="14" height="5" rx="2" fill="#f59e0b" opacity=".8"/>'
  +'<path d="M22 136 H50 V156 H30 C25 156 22 152 22 147 Z" fill="url(#tkC)" stroke="#475569" stroke-width=".8"/><path d="M24 140 H50" stroke="#fff" stroke-width="1" opacity=".8"/>'
  +wheel(128,155)+wheel(410,155)+'</svg>'}

const truckKind=m=>/transit|promaster|express|savana|sprinter|econoline|e-?series|van/i.test(m)?'van':/f-?[123]50|silverado|sierra|ram|tundra|titan|super ?duty/i.test(m)?'full':'mid';
// ---- Truck check-ups tab: the weekly POM truck form, per driver, week by week ----
let CHK=null;
async function loadChk(){if(!CHK)$('chkGrid').innerHTML='<div class="panel" style="padding:16px"><div class="sk" style="width:60%"></div><div class="sk" style="width:80%"></div></div>';
  try{CHK=await get('/api/pom/checkups?weeks=8');renderChk()}catch(e){$('chkGrid').innerHTML='<div class="empty">'+esc(e.message)+'</div>'}
  loadPlan()}
// POM schedule: what the site would create / move / stop so roles and the Monday 9 AM check-up line up
let PLAN=null;
async function loadPlan(){try{PLAN=await get('/api/pom/checkup-plan');renderPlan()}catch(e){$('chkPlan').innerHTML='<div class="cplan"><b>POM schedule</b><p class="muted">'+esc(e.message)+'</p></div>'}}
function renderPlan(){const r=PLAN;if(!r||!r.connected){$('chkPlan').innerHTML='';return}
  const d=t=>new Date(t).toLocaleString([],{weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}),hr=h=>h==null?'another time':((h%12)||12)+(h<12?' AM':' PM');
  const txt={create:o=>'<b>Add</b> a Monday 9 AM truck check-up for <b>'+esc(o.name)+'</b> ('+esc(o.role)+'), starting '+d(o.when),
    move:o=>'<b>Move</b> <b>'+esc(o.name)+'</b>\u2019s check-up from '+hr(o.hour)+' to Monday 9 AM, starting '+d(o.when),
    remove:o=>'<b>Stop</b> <b>'+esc(o.name)+'</b>\u2019s weekly check-up from '+d(o.next)+' ('+esc(o.role)+' doesn\u2019t submit one)',
    none:o=>'<b>'+esc(o.name)+'</b> ('+esc(o.role)+') needs a check-up but '+esc(o.why.replace(/^Not /,'not '))};
  const ops=r.ops,act=ops.filter(o=>o.op!=='none');
  $('chkPlan').innerHTML='<div class="cplan"><div class="cph2"><div><b>POM schedule</b><span class="muted">'+(act.length?act.length+' change'+(act.length>1?'s':'')+' to line POM up with roles':'POM matches everyone\u2019s role. Nothing to change.')+'</span></div>'
    +'<label class="cauto"><input type="checkbox" id="chkAuto"'+(r.auto?' checked':'')+'> Keep POM in sync automatically</label>'+(act.length?'<button class="btn2 pri" id="chkAll">Apply all '+act.length+'</button>':'')+'</div>'
    +(ops.length?'<ul>'+ops.map(o=>'<li class="op-'+o.op+'"><span class="opi">'+({create:'+',move:'⟳',remove:'−',none:'!'})[o.op]+'</span><span>'+txt[o.op](o)+'</span>'+(o.op!=='none'?'<button class="btn2" data-key="'+esc(o.key)+'">Apply</button>':'')+'</li>').join('')+'</ul>':'')
    +'<p class="cpmsg muted" id="chkMsg"></p></div>';
  $('chkAuto').onchange=async e=>{try{await post('/api/pom/checkup-auto',{on:e.target.checked});$('chkMsg').textContent=e.target.checked?'On: POM is checked every hour and right after a role change.':'Off: changes only happen when you press Apply.'}catch(err){e.target.checked=!e.target.checked;$('chkMsg').textContent=err.message}};
  const run=async(body,btn)=>{btn.disabled=true;const m=$('chkMsg');m.textContent='Updating POM...';
    try{const x=await post('/api/pom/checkup-apply',body);m.textContent=x.done.length+' change'+(x.done.length===1?'':'s')+' made in POM.'+(x.failed.length?' '+x.failed.length+' failed: '+x.failed.map(f=>f.name+' ('+f.error+')').join('; '):'');CHK=null;loadChk()}
    catch(err){m.textContent=err.message;btn.disabled=false}};
  if($('chkAll'))$('chkAll').onclick=e=>{if(confirm('Make all '+act.length+' changes in Pool Office Manager?'))run({all:true},e.target)};
  $('chkPlan').querySelectorAll('li button').forEach(b=>b.onclick=()=>run({keys:[b.dataset.key]},b))}
function renderChk(){const r=CHK;if(!r)return;
  if(!r.connected){$('chkCount').textContent='Pool Office Manager is not connected (add POM_API_KEY in Render).';$('chkSum').innerHTML=$('chkGrid').innerHTML='';return}
  const ymd=t=>new Date(t).toLocaleDateString('en-CA',{timeZone:'America/New_York'}),now=r.now;
  const wkOf=t=>{const d=new Date(ymd(t)+'T12:00');d.setDate(d.getDate()-(d.getDay()+6)%7);return d.toLocaleDateString('en-CA')};   // Monday of that week
  const days=[...new Set(r.checkups.map(s=>wkOf(s.time)))].sort().reverse(),todayWk=wkOf(r.today+'T12:00');   // one column per week, newest first
  const RL=['Tech','Tech assistant','District','Regional','Owner','Auditor','Staffer'],NEED=['Tech','Tech assistant','Auditor'],role=n=>(r.roles||{})[n]||'',need=n=>!role(n)||NEED.includes(role(n));   // no role set yet: still expected
  const q=$('q').value.trim().toLowerCase(),every=[...new Set(r.checkups.map(s=>s.tech))].filter(n=>!q||n.toLowerCase().includes(q)),techs=every.filter(need),skip=every.filter(n=>!need(n));
  const cell=(n,d)=>{const cs=r.checkups.filter(s=>s.tech===n&&wkOf(s.time)===d);return cs.find(s=>s.done)||cs[0]};
  const state=s=>!s?'none':s.done?'ok':Date.parse(s.time)>now?'due':'miss';
  const rows=techs.map(n=>{const cs=days.map(d=>cell(n,d)),st=cs.map(state),given=st.filter(x=>x==='ok'||x==='miss'),ok=st.filter(x=>x==='ok').length;
    let streak=0;for(const x of st){if(x==='due'||x==='none')continue;if(x==='ok')streak++;else break}
    return {n,cs,st,ok,rate:given.length?Math.round(ok/given.length*100):null,streak,missed:given.length-ok}}).sort((a,b)=>b.missed-a.missed||a.n.localeCompare(b.n));
  const cur=days.find(d=>d<=todayWk)||days[days.length-1],curSt=techs.map(n=>state(cell(n,cur))),curOk=curSt.filter(x=>x==='ok').length,curDue=curSt.filter(x=>x==='due').length,curMiss=curSt.filter(x=>x==='miss').length,curN=curOk+curDue+curMiss;
  const lbl=d=>new Date(d+'T12:00').toLocaleDateString([],{month:'short',day:'numeric'}),wk=d=>new Date(d+'T12:00').toLocaleDateString([],{weekday:'short'});
  const curT=r.checkups.find(s=>wkOf(s.time)===cur&&Date.parse(s.time)>now);
  $('chkCount').textContent=techs.length+' drivers · weekly form in Pool Office Manager · last '+days.length+' weeks';
  $('chkSum').innerHTML=cur?'<div class="pbs chs"><div class="pbring" style="--v:'+(curN?Math.round(curOk/curN*100):0)+'"><svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="15.9" pathLength="100"/><circle class="fill" cx="18" cy="18" r="15.9" pathLength="100"/></svg><b>'+curOk+'/'+curN+'</b></div>'
    +'<div><b>'+wk(cur)+' '+lbl(cur)+'</b><span>this week’s check-up'+(curDue&&curT?' · due '+new Date(curT.time).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}):'')+'</span></div>'
    +'<div><b>'+curOk+'</b><span>submitted</span></div>'+(curDue?'<div><b>'+curDue+'</b><span>still due</span></div>':'')+(curMiss?'<div><b>'+curMiss+'</b><span>missed</span></div>':'')+(techs.length>curN?'<div><b>'+(techs.length-curN)+'</b><span>not assigned</span></div>':'')
    +'<div><b>'+rows.reduce((a,x)=>a+x.missed,0)+'</b><span>missed in '+days.filter(d=>d<=todayWk).length+' weeks</span></div></div>':'';
  const icon={ok:'✓',miss:'✕',due:'•',none:''},word={ok:'Submitted',miss:'Missed',due:'Due',none:'Not assigned'};
  $('chkGrid').innerHTML=rows.length?'<div class="chk panel"><table><thead><tr><th>Driver</th>'+days.map((d,i)=>'<th class="'+(d===cur?'now':d>todayWk?'next':'')+'">'+(d>todayWk?'Next week':'Week of')+'<br>'+lbl(d)+'</th>').join('')+'<th>On time</th><th>Streak</th></tr></thead><tbody>'
    +rows.map((x,ri)=>{const tr=r.trucks[x.n];return '<tr style="--i:'+ri+'"><td><div class="chd">'+avatar(x.n)+'<div><b>'+esc(x.n)+(role(x.n)?'<span class="role r'+RL.indexOf(role(x.n))+'">'+esc(role(x.n))+'</span>':'<span class="role" title="Set a role on the Drivers tab">No role</span>')+'</b>'+(tr?'<button class="tchip" data-truck="'+esc(tr)+'">'+tno(tr)+'Show on map</button>':'<small class="muted">No truck matched</small>')+'</div></div></td>'
      +x.st.map((st,i)=>{const s=x.cs[i],tip=word[st]+(s?' · '+esc(new Date(s.time).toLocaleString([],{weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})):'')+(s&&s.service?' · click to open':'');return '<td>'+(s&&s.service?'<a class="chc '+st+' open" href="/checkup?id='+encodeURIComponent(s.service)+'" target="_blank" rel="noopener" title="'+tip+'">'+icon[st]+'</a>':'<span class="chc '+st+'" title="'+tip+'">'+icon[st]+'</span>')+'</td>'}).join('')
      +'<td><b class="chr '+(x.rate===null?'':x.rate>=80?'g':x.rate>=50?'y':'r')+'">'+(x.rate===null?'–':x.rate+'%')+'</b></td><td>'+(x.streak?'<b class="chs2">'+x.streak+' wk'+(x.streak>1?'s':'')+'</b>':'<span class="muted">–</span>')+'</td></tr>'}).join('')
    +(r.missing||[]).filter(m=>!q||m.name.toLowerCase().includes(q)).map(m=>'<tr class="chmiss"><td><div class="chd">'+avatar(m.name)+'<div><b>'+esc(m.name)+'<span class="role r'+RL.indexOf(m.role)+'">'+esc(m.role)+'</span></b><small>No check-up set up in POM</small></div></div></td><td colspan="'+days.length+'"><span class="chwarn">⚠ '+esc(m.role)+'s should get the weekly truck check-up. Add it for them in Pool Office Manager.</span></td><td>–</td><td>–</td></tr>').join('')
    +'</tbody></table>'+(skip.length?'<p class="chskip">Not required: '+skip.map(n=>esc(n)+' ('+esc(role(n))+')').join(', ')+'. Owners, district, regional and staffers don\u2019t submit check-ups, so they aren\u2019t counted.</p>':'')+'<p class="chleg"><span class="chc ok">✓</span> Submitted <span class="chc miss">✕</span> Missed <span class="chc due">•</span> Still due <span class="chc none"></span> Not assigned that week</p></div>'
    :'<div class="empty">'+(q?'No drivers match your search.':'No truck check-ups found in Pool Office Manager.')+'</div>'}
// ---- Cameras tab: every camera event in the fleet, filter by type and driver ----
let CAMALL=[],camTabType='';
// Older footage: after the last 7 days load, keep pulling a week at a time while Azuga still has clips or photos
let CAMOLD=[],CAMBACK=0,CAMOLDBUSY=false;
async function loadOlderCams(){if(CAMOLDBUSY||CAMBACK<0)return;CAMOLDBUSY=true;let empty=0;const seen=new Set(CAMALL.concat(CAMOLD).map(x=>[x.vehicleId,pick(x,'eventTime','startTime'),pick(x,'eventType','eventName')].join('|')));
  for(let w=CAMBACK+1;w<=104&&empty<3;w++){let r;try{r=await get('/api/videos/week?w='+w)}catch(e){break}CAMBACK=w;
    const add=(r.events||[]).filter(x=>{const k=[x.vehicleId,pick(x,'eventTime','startTime'),pick(x,'eventType','eventName')].join('|');if(seen.has(k))return false;seen.add(k);return true});
    empty=add.length?0:empty+1;if(add.length){CAMOLD=CAMOLD.concat(add);if(!$('vCam').hidden)renderCamTab()}else if(!$('vCam').hidden)renderCamTab()}
  if(empty>=3)CAMBACK=-CAMBACK;CAMOLDBUSY=false;if(!$('vCam').hidden)renderCamTab()}
async function loadCamTab(){if(!CAMALL.length)$('cgrid').innerHTML='<div class="sk" style="width:60%"></div><div class="sk" style="width:40%"></div>';
  try{CAMALL=await fleetVids();renderCamTab();loadOlderCams()}catch(e){$('cgrid').innerHTML='<div class="empty">'+esc(e.message)+'</div>'}}
$('camDrv').onchange=()=>renderCamTab();$('camSer').onclick=()=>{const b=$('camSer'),on=b.getAttribute('aria-pressed')!=='true';b.setAttribute('aria-pressed',on);renderCamTab()};
function renderCamTab(){const ev=CAMALL.concat(CAMOLD),q=$('q').value.trim().toLowerCase(),dv=$('camDrv').value;
  const truckOf=x=>{const r=all().find(v=>vid(v)==x.vehicleId);return r?title(r):''};
  const drivers=[...new Set(ev.map(x=>evDriver(x).name).filter(Boolean))].sort();
  $('camDrv').innerHTML='<option value="">All drivers</option>'+drivers.map(d=>'<option'+(d===dv?' selected':'')+'>'+esc(d)+'</option>').join('');
  const byDrv=ev.filter(x=>!dv||evDriver(x).name===dv),c={};byDrv.forEach(x=>{const t=evName(pick(x,'eventType','eventName'));c[t]=(c[t]||0)+1});
  if(camTabType&&!c[camTabType])camTabType='';
  $('camTypes').innerHTML='<button class="cchip'+(camTabType?'':' on')+'" data-ct="">All <b>'+byDrv.length+'</b></button>'+Object.entries(c).sort((a,b)=>b[1]-a[1]).map(([t,n])=>'<button class="cchip pill '+evClass(t)+(camTabType===t?' on':'')+'" data-ct="'+esc(t)+'">'+esc(t)+' <b>'+n+'</b></button>').join('');
  const serOnly=$('camSer').getAttribute('aria-pressed')==='true';
  VIDS=byDrv.filter(x=>(!serOnly||isSerious(x))&&(!camTabType||evName(pick(x,'eventType','eventName'))===camTabType)&&(!q||(evDriver(x).name+' '+truckOf(x)+' '+evName(pick(x,'eventType','eventName'))+' '+(pick(x,'address')||'')).toLowerCase().includes(q)));
  const wk=Math.abs(CAMBACK),oldest=ev.reduce((m,x)=>{const v=pick(x,'eventTime','startTime'),t=+v||Date.parse(v)||0;return t&&t<m?t:m},Date.now());
  $('camCount').innerHTML=ev.length+' events across the fleet · '+(CAMOLD.length?'footage back to <b>'+new Date(oldest).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})+'</b>':'last 7 days')+(CAMOLDBUSY?' <span class="camload"><i class="camdot spin"></i>looking further back (week '+(wk+1)+')...</span>':CAMBACK<0?' · everything Azuga still has':'');
  // one row per driver: who they are and what they're doing on the left, their events as big photo cards on the right
  const tOf=x=>{const v=pick(x,'eventTime','startTime');return +v||Date.parse(v)||0},by={};
  VIDS.sort((a,b)=>tOf(b)-tOf(a)).forEach((x,i)=>{const n=evDriver(x).name||'Unknown driver';(by[n]=by[n]||[]).push(i)});
  const rows=Object.entries(by).map(([n,ix])=>({n,ix,ser:ix.filter(i=>isSerious(VIDS[i])).length})).sort((a,b)=>b.ser-a.ser||b.ix.length-a.ix.length);
  const ser=VIDS.filter(isSerious).length;
  const hm=t=>t?'<b>'+new Date(t).toLocaleDateString([],{weekday:'short',month:'short',day:'numeric',...(new Date(t).getFullYear()!==new Date().getFullYear()?{year:'numeric'}:{})})+'</b> '+new Date(t).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}):'';
  $('cgrid').innerHTML=rows.length?'<div class="csum"><div><b>'+VIDS.length+'</b><span>events</span></div><div class="red"><b>'+ser+'</b><span>serious</span></div><div><b>'+rows.length+'</b><span>drivers</span></div><div><b>'+VIDS.filter(x=>evMedia(x).videos.length).length+'</b><span>with video</span></div></div>'
    +rows.map(r=>{const tr=[...new Set(r.ix.map(i=>truckOf(VIDS[i])).filter(Boolean))],c={};r.ix.forEach(i=>{const t=evName(pick(VIDS[i],'eventType','eventName'));c[t]=(c[t]||0)+1});
      const top=Object.entries(c).sort((a,b)=>b[1]-a[1]);
      return '<section class="cdrv"><div class="cdh">'+avatar(r.n,1)+'<div><b>'+esc(r.n)+'</b><small>'+esc(tr.join(', ')||'No truck')+'</small></div>'
        +'<div class="cdn"><span><b>'+r.ix.length+'</b> event'+(r.ix.length>1?'s':'')+'</span>'+(r.ser?'<span class="red"><b>'+r.ser+'</b> serious</span>':'<span class="ok">nothing serious</span>')+'</div>'
        +'<div class="cdt">'+top.slice(0,3).map(([t,n])=>'<span class="pill '+evClass(t)+'">'+esc(t)+' '+n+'</span>').join('')+(top.length>3?'<span class="muted">+'+(top.length-3)+' more</span>':'')+'</div></div>'
        +'<div class="cstrip">'+r.ix.map(i=>{const x=VIDS[i],e=pick(x,'eventType','eventName'),m=evMedia(x),th=m.snaps[0]&&m.snaps[0].url||m.videos[0]&&m.videos[0].poster;
          return '<button class="cshot'+(isSerious(x)?' ser':'')+'" data-i="'+i+'"'+(m.videos[0]?' data-vid="'+esc(m.videos[0].url)+'"':'')+'><span class="cim">'+(th?'<img src="'+esc(th)+'" alt="" loading="lazy">':'<em>'+(x.requested?'Waiting on camera':'No photo')+'</em>')
            +'<span class="pill '+evClass(e)+'">'+esc(evName(e))+'</span>'+(m.videos.length?'<i>'+ICON.play+'</i>':'')+'</span><span class="cwhen">'+hm(tOf(x))+(truckOf(x)&&tr.length>1?' · '+esc(truckOf(x)):'')+'</span></button>'}).join('')+'</div></section>'}).join('')
    :'<div class="empty">No camera events match.</div>'}
function isSerious(x){return /hard\s*-?\s*core|(hard|harsh)\s*br[ae]a?k|critical\s*distance|tailgat|following\s*distance|violent\s*turn|harsh\s*turn|sharp\s*turn|rolling\s*stop|stop\s*sign|phone|cell|distract/i.test(String(pick(x,'eventType','eventName')||'').replace(/_/g,' '))}
document.addEventListener('click',e=>{const c=e.target.closest('.cshot');if(c)openMedia(+c.dataset.i)});
// hovering a card that has video plays it silently right in the card
document.addEventListener('mouseover',e=>{const c=e.target.closest('.cshot[data-vid]');if(!c||c.querySelector('video')||matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  const v=document.createElement('video');v.src=c.dataset.vid;v.muted=v.loop=v.playsInline=v.autoplay=true;c.querySelector('.cim').appendChild(v);c.addEventListener('mouseleave',()=>v.remove(),{once:true})});
document.addEventListener('click',e=>{const b=e.target.closest('.cchip');if(!b)return;camTabType=b.dataset.ct;renderCamTab()});
// a few bubbles drifting up behind the page
(()=>{const b=document.createElement('div');b.id='bubbles';b.setAttribute('aria-hidden','true');for(let k=0;k<14;k++){const i=document.createElement('i'),z=8+Math.random()*22;i.style.cssText='left:'+(Math.random()*100).toFixed(1)+'%;width:'+z+'px;height:'+z+'px;animation-duration:'+(14+Math.random()*16).toFixed(1)+'s;animation-delay:-'+(Math.random()*30).toFixed(1)+'s';b.appendChild(i)}document.body.appendChild(b)})();
// sliding white pill behind the active tab
function moveTab(){const b=document.querySelector('.tabs button.on'),i=document.querySelector('.tabind');if(b&&i){i.style.left=b.offsetLeft+'px';i.style.width=b.offsetWidth+'px'}}
addEventListener('resize',moveTab);(document.fonts&&document.fonts.ready||Promise.resolve()).then(moveTab);setTimeout(moveTab,50);
document.querySelectorAll('.tabs button').forEach(b=>b.onclick=()=>{
  document.querySelectorAll('.tabs button').forEach(x=>x.classList.toggle('on',x===b));moveTab();
  ['vMap','vEdit','vDrv','vPom','vCam','vChk','vRep','vBuy','vUp'].forEach(v=>$(v).hidden=b.dataset.v!==v);if(b.dataset.v==='vBuy')loadRampTab();if(b.dataset.v==='vUp')loadUp();if(b.dataset.v==='vChk'){loadChk();mailPanel()}if(b.dataset.v==='vRep')loadRep();if(b.dataset.v==='vPom')loadPomBoard();if(b.dataset.v==='vCam')loadCamTab();if(b.dataset.v==='vMap'&&sel&&TRUCKV.length)drawCams();document.body.dataset.v=b.dataset.v;$('sum').hidden=b.dataset.v!=='vMap';
  if(b.dataset.v!=='vMap')loadSync();if(b.dataset.v==='vEdit')renderEdit();else if(b.dataset.v==='vDrv'){if(!PEOPLE)loadPeople();else renderDrivers()}else map.invalidateSize();
});
$('q').oninput=()=>{render();if(!$('vEdit').hidden)renderEdit();if(!$('vDrv').hidden)renderDrivers();if(!$('vPom').hidden)renderPom();if(!$('vCam').hidden)renderCamTab();if(!$('vChk').hidden)renderChk();if(!$('vRep').hidden)renderRep();if(!$('vBuy').hidden){renderBuy();renderRampOv();renderRampUp()}if(!$('vPom').hidden&&!$('psTime').hidden)renderPoolTime();if(!$('vUp').hidden)renderUp()};
/*repadd*/
// Automatic emails: setup status, a test send to Callum, and the Monday switch
async function mailPanel(){const el=$('chkMailAuto');if(!el)return;let st;try{st=await get('/api/mail/status')}catch(e){el.innerHTML='';return}
  const pill=(on,ready)=>!ready?'<span class="rmpill set">Not set up</span>':on?'<span class="rmpill on">● On</span>':'<span class="rmpill off">Off</span>';
  const card=o=>'<div class="rmc '+o.cls+(o.on&&o.ready?' live':'')+'"><div class="rmh"><span class="rmi">'+o.icon+'</span><div><b>'+o.title+'</b><small>'+o.how+'</small></div>'+pill(o.on,o.ready)+'</div>'
    +'<dl class="rmd"><dt>Who</dt><dd>'+o.who+'</dd><dt>When</dt><dd>'+o.when+'</dd>'+(o.note?'<dt>Latest</dt><dd>'+o.note+'</dd>':'')+'</dl>'
    +(o.warn?'<div class="rmw">'+o.warn+'</div>':'')
    +'<div class="rma"><label class="sw"><input type="checkbox" id="'+o.tog+'"'+(o.on?' checked':'')+(o.ready?'':' disabled')+'><i></i>'+o.togLabel+'</label>'+o.btns.map(([id,l,pri])=>'<button class="btn2'+(pri?' pri':'')+'" id="'+id+'"'+(o.ready?'':' disabled')+'>'+l+'</button>').join('')+'</div>'
    +'<span class="rmm muted" id="'+o.msg+'"></span></div>';
  const bounced=(st.bounced&&st.bounced.length?'Bounced, never emailed again: '+st.bounced.map(esc).join(', ')+'. Fix the address in Airtable.':'')+(st.bounceErr?(st.bounced&&st.bounced.length?'<br>':'')+esc(st.bounceErr):'');
  el.innerHTML='<div class="rmhead"><h3>Automatic reminders</h3><span class="muted">'+(st.ready?'Emails come from '+esc(st.from)+'.':'Email isn’t set up yet: add the Outlook settings in Render (MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, MAIL_FROM).')+' Switch each one on when you’re ready; “Send me a sample” never goes to the techs.</span></div><div class="rmgrid">'
   +card({cls:'em',icon:'✉️',title:'Check-up reminder',how:'Email',ready:st.ready,on:st.auto,tog:'mailAuto',togLabel:'Send automatically',msg:'mailMsg',
     who:'Techs, tech assistants and auditors who haven’t submitted this week’s truck check-up',when:'Mon–Wed at 12 PM · Thu–Sun at 9 AM and 3 PM, until they submit',
     note:st.sent&&st.sent.length?'Emailed this week: '+st.sent.map(esc).join(', '):'Nobody emailed yet this week',warn:bounced,btns:[['mailTest','Send me a sample'],['mailNow','Send to everyone now',1]]})
   +card({cls:'tx',icon:'📱',title:'Check-up reminder',how:'Text message (Textedly)',ready:st.smsReady,on:st.sms,tog:'smsAuto',togLabel:'Text automatically',msg:'smsMsg',
     who:'Same people, to the phone number in Airtable',when:'Once a day while their check-up is missing',
     note:st.texted&&st.texted.length?'Texted today: '+st.texted.map(esc).join(', '):'Nobody texted today',warn:st.smsReady?'':'Add TEXTEDLY_API_KEY in Render. Texts only deliver once the number is approved.',btns:[['smsTest','Send me a sample'],['smsNow','Text everyone now',1]]})
   +card({cls:'sv',icon:'🏊',title:'Service report reminder',how:'Email',ready:st.ready,on:st.svc,tog:'svcAuto',togLabel:'Remind automatically',msg:'svcMsg',
     who:'A tech whose truck left a pool without submitting that service in POM',when:'20 minutes after they drive away · checked every 15 min, 7 AM–9 PM · one email per pool',
     note:st.svcToday?'Sent today: '+st.svcToday:'None sent today',btns:[['svcTest','Send me a sample']]})
   +card({cls:'eo',icon:'🌙',title:'End-of-day summary',how:'Email',ready:st.ready,on:st.eod,tog:'eodAuto',togLabel:'Send at end of day',msg:'eodMsg',
     who:'Each tech with services from today still not submitted in POM',when:'Every day at 6 PM · one email listing all of them',
     note:st.eodToday?'Sent today: '+(st.eodToday.length?st.eodToday.map(esc).join(', '):'nobody needed one'):'Not sent yet today',btns:[['eodTest','Send me a sample']]})
   +'</div>';
  const run=async(e,msg,fn)=>{const b=e.currentTarget;b.disabled=true;$(msg).textContent='Sending...';try{$(msg).textContent=await fn()}catch(err){$(msg).textContent=err.message}b.disabled=false};
  const tog=(id,url,msg,onTxt)=>{$(id).onchange=async e=>{try{const r=await post(url,{on:e.target.checked});const on=r.auto??r.sms??r.on;$(msg).textContent=on?onTxt:'Off.';mailPanel()}catch(err){e.target.checked=!e.target.checked;$(msg).textContent=err.message}}};
  $('mailTest').onclick=e=>run(e,'mailMsg',async()=>{const r=await post('/api/mail/test',{});return 'Sample sent to '+r.to+'. Check that inbox (and spam).'});
  $('mailNow').onclick=e=>{if(!confirm('Email everyone who hasn’t submitted this week’s check-up right now?'))return;run(e,'mailMsg',async()=>{const r=await post('/api/mail/now',{confirm:'SEND'});setTimeout(mailPanel,1500);return 'Sent to '+r.sent.length+(r.sent.length?': '+r.sent.join(', '):'')+'.'+(r.failed.length?' Failed: '+r.failed.map(f=>f.name+' ('+f.error+')').join('; '):'')+(r.noEmail.length?' No email: '+r.noEmail.join(', '):'')})};
  $('smsTest').onclick=e=>run(e,'smsMsg',async()=>{const r=await post('/api/text/test',{});return 'Sample text sent to '+r.to+'.'});
  $('smsNow').onclick=e=>{if(!confirm('Text everyone who hasn’t submitted this week’s check-up right now? (Anyone already texted today is skipped.)'))return;run(e,'smsMsg',async()=>{const r=await post('/api/text/now',{confirm:'SEND'});setTimeout(mailPanel,1500);return 'Texted '+r.sent.length+(r.sent.length?': '+r.sent.join(', '):'')+'.'+(r.failed.length?' Failed: '+r.failed.map(f=>f.name+' ('+f.error+')').join('; '):'')})};
  $('svcTest').onclick=e=>run(e,'svcMsg',async()=>{const r=await post('/api/svc/test',{});return 'Sample sent to '+r.to+'. '+(r.waiting.length?'Right now '+r.waiting.length+' would get one: '+r.waiting.map(w=>w.tech+' ('+w.customer+')'+(w.email?'':' – no email')).join(', '):'Nobody has left a pool without submitting right now.')});
  $('eodTest').onclick=e=>run(e,'eodMsg',async()=>{const r=await post('/api/eod/test',{});return 'Sample sent to '+r.to+'. '+(r.waiting.length?'Right now: '+r.waiting.map(w=>w.tech+' ('+w.n+')'+(w.email?'':' – no email')).join(', '):'Nobody has unsubmitted services right now.')});
  tog('mailAuto','/api/mail/auto','mailMsg','On.');tog('smsAuto','/api/text/auto','smsMsg','On.');tog('svcAuto','/api/svc/auto','svcMsg','On.');tog('eodAuto','/api/eod/auto','eodMsg','On.')}

// Email everyone who hasn't done this week's check-up, from your own email app (addresses come from POM users)
document.addEventListener('click',async e=>{if(e.target.closest('#chkMailX')){$('chkMailBox').innerHTML='';return}if(!e.target.closest('#chkMail'))return;const box=$('chkMailBox');box.innerHTML='<div class="panel rp-add"><span class="muted">Checking who still needs to submit...</span></div>';
  try{const r=await get('/api/texts/missed-checkups');if(!r.connected){box.innerHTML='<div class="panel rp-add">Pool Office Manager is not connected.</div>';return}
    const L=r.texts.filter(t=>t.email),no=r.texts.filter(t=>!t.email).map(t=>t.name).concat((r.skipped||[]).map(s=>s.name));
    if(!r.texts.length&&!no.length){box.innerHTML='<div class="panel rp-add"><div class="rp-addh"><b>Everyone has done this week’s check-up 🎉</b><button class="btn2" id="chkMailX">Close</button></div></div>';return}
    const subj=L[0]?L[0].subject:'Truck check-up missed',all='mailto:?bcc='+encodeURIComponent(L.map(t=>t.email).join(','))+'&subject='+encodeURIComponent(subj)+'&body='+encodeURIComponent('Hi,\\n\\nYour weekly truck check-up for this week hasn’t been submitted in Pool Office Manager yet. Please fill it out in the POM app today.\\n\\nThanks,\\nMillennial Pools');
    box.innerHTML='<div class="panel rp-add"><div class="rp-addh"><b>'+r.texts.length+' still need to submit this week’s check-up</b><button class="btn2" id="chkMailX">Close</button></div>'
      +(L.length?'<a class="btn2 pri" style="display:block;text-align:center;text-decoration:none;margin-bottom:10px" href="'+esc(all)+'">✉️ Email all '+L.length+' (each gets their own copy)</a>':'')
      +'<ul class="cm-list">'+L.map(t=>'<li><b>'+esc(t.name)+'</b><span class="muted">'+esc(t.email)+'</span><a class="btn2" href="'+esc('mailto:'+t.email+'?subject='+encodeURIComponent(t.subject)+'&body='+encodeURIComponent(t.body))+'">Email</a></li>').join('')
      +no.map(n=>'<li><b>'+esc(n)+'</b><span class="muted">No email in Airtable</span></li>').join('')+'</ul>'
      +'<p class="muted" style="font-size:12px;margin:8px 0 0">Opens in your email app so you can check it before sending. Emails come from the Email column on the Drivers table in Airtable. With the Mac set up, these also go out on their own every Monday at noon.</p></div>'}
  catch(err){box.innerHTML='<div class="panel rp-add">'+esc(err.message)+'</div>'}});

document.addEventListener('click',async e=>{if(!e.target.closest('#repLink'))return;try{const r=await post('/api/repair/link',{}),u=location.origin+r.url;
  $('repNew').innerHTML='<div class="panel rp-add"><div class="rp-addh"><b>Invoice upload link</b><button class="btn2" id="repX">Close</button></div><p class="muted" style="font-size:13px;margin:0 0 10px">Anyone with this link can take a photo and add an invoice to a truck. They can\u2019t see or change anything else. It works for 1 year.</p><div class="lnk"><input readonly value="'+esc(u)+'" id="repLinkU" style="flex:1;font:inherit;padding:10px;border:1px solid #cbd5e1;border-radius:10px;min-width:0"><button class="btn2 pri" id="repCopy">Copy</button></div>'+(navigator.share?'<button class="btn2" id="repShare" style="width:100%;margin-top:8px">Send link...</button>':'')+'</div>';
  $('repCopy').onclick=()=>{navigator.clipboard.writeText(u).then(()=>toast('Link copied'),()=>{$('repLinkU').select()})};if($('repShare'))$('repShare').onclick=()=>navigator.share({title:'Add a truck invoice',url:u}).catch(()=>{})}catch(err){toast(err.message,'bad')}});
// Add an invoice from a phone: photo goes to the truck's files in Airtable, details become a repair note
let repPhoto=null;
function repForm(){const tr=(REP&&REP.trucks||[]).slice().sort((a,b)=>(parseInt(a.truckNo)||999)-(parseInt(b.truckNo)||999)||repName(a).localeCompare(repName(b)));
  const shops=[...new Set(repParse(REP&&REP.trucks||[]).map(r=>r.shop))].sort();
  return '<div class="panel rp-add"><div class="rp-addh"><b>Add an invoice</b><button class="btn2" id="repX" aria-label="Close">Close</button></div>'
   +'<label class="rp-cam" id="repCamL"><input type="file" accept="image/*" multiple id="repCam"><span id="repCamT">📷 Add photos of the invoice</span><small id="repCamH">All pages at once: front, back, extra sheets</small></label><div id="repThumbs"></div><div class="rpai" id="repAi" hidden></div>'
   +'<div class="rp-f"><label>Truck<select id="repTruck"><option value="">Pick the truck...</option>'+tr.map(t=>'<option value="'+esc(t.id)+'">'+esc(repName(t))+(t.driver?' · '+esc(t.driver):'')+'</option>').join('')+'</select></label>'
   +'<label>Date<input type="date" id="repDate" value="'+new Date().toLocaleDateString('en-CA')+'"></label>'
   +'<label>Shop<input id="repShop" list="repShops" placeholder="e.g. Steve’s Auto Body" maxlength="60"><datalist id="repShops">'+shops.map(s=>'<option value="'+esc(s)+'">').join('')+'</datalist></label>'
   +'<label>Total<input id="repTot" inputmode="decimal" placeholder="$0.00"></label>'
   +'<label class="rp-wide">Work done<input id="repWork" maxlength="300" placeholder="e.g. Oil change, front brake pads"></label>'
   +'<label class="rp-chk"><input type="checkbox" id="repEst"> This is an estimate, not a final invoice</label></div>'
   +'<p class="muted" style="font-size:12px;margin:8px 0">Add the photos and Claude fills in the shop, date, total and work done. Check them before saving.</p>'
   +'<button class="btn2 pri" id="repSave" style="width:100%">Save invoice</button><div class="note" id="repMsg"></div></div>'}
document.addEventListener('click',async e=>{
  if(e.target.closest('#repAdd')){repPhoto=null;repPhotos=[];repTouched.clear();$('repNew').innerHTML=repForm();$('repNew').scrollIntoView({behavior:'smooth',block:'start'});return}
  if(e.target.closest('#repX')){$('repNew').innerHTML='';return}
  if(!e.target.closest('#repSave'))return;const b=$('repSave'),m=$('repMsg');
  if(!$('repTruck').value){m.textContent='Pick the truck first.';return}if(!repPhotos.length&&!$('repWork').value.trim()){m.textContent='Take a photo or write what was done.';return}
  m.textContent='';b.disabled=true;b.textContent='Saving...';
  try{const r=await post('/api/repair/add',{truckId:$('repTruck').value,date:$('repDate').value,shop:$('repShop').value,total:$('repTot').value,work:$('repWork').value,estimate:$('repEst').checked,photos:repPhotos});
    toast(r.oil?'Invoice saved · oil change logged':'Invoice saved to the truck');$('repNew').innerHTML='';REP=null;await loadRep()}
  catch(err){m.textContent=err.message;b.disabled=false;b.textContent='Save invoice'}});
let repPhotos=[],repReadN=0;const repTouched=new Set();
document.addEventListener('input',e=>{const id=e.target.id;if(['repTruck','repDate','repShop','repTot','repWork','repEst'].includes(id)){repTouched.add(id);e.target.classList.remove('rpfill')}});
function repThumbs(){$('repThumbs').innerHTML=repPhotos.map((p,i)=>'<figure><img src="data:image/jpeg;base64,'+p.data+'" alt="Page '+(i+1)+'"><button type="button" data-rprm="'+i+'" aria-label="Remove page '+(i+1)+'">×</button><figcaption>Page '+(i+1)+'</figcaption></figure>').join('');
  $('repCamT').textContent=repPhotos.length?'➕ Add another page':'📷 Add photos of the invoice';$('repCamH').textContent=repPhotos.length?repPhotos.length+' photo'+(repPhotos.length>1?'s':'')+' · add every page':'All pages at once: front, back, extra sheets'}
async function repRead(){const n=++repReadN,ai=$('repAi');ai.hidden=false;ai.className='rpai busy';ai.textContent='✨ Claude is reading the invoice...';
  try{const j=await post('/api/repair/read',{photos:repPhotos});if(n!==repReadN||!$('repAi'))return;
    if(!j.ai){ai.className='rpai';ai.textContent='Automatic reading needs ANTHROPIC_API_KEY in Render. Fill in the details below.';return}
    const set=(id,v)=>{if(v!==''&&v!=null&&!repTouched.has(id)){$(id).value=v;$(id).classList.add('rpfill')}};
    set('repShop',j.shop);set('repDate',j.date);set('repTot',j.total);set('repWork',j.work);if(j.truckId)set('repTruck',j.truckId);if(!repTouched.has('repEst'))$('repEst').checked=!!j.estimate;
    ai.className='rpai ok';ai.textContent='✨ Filled in from '+(j.pages>1?'all '+j.pages+' photos':'the photo')+'. Green fields came from the invoice; check them, then save.'+(j.truckId?' Truck matched from the VIN / plate.':'')}
  catch(err){if(n===repReadN&&$('repAi')){ai.className='rpai';ai.textContent='Could not read it automatically: '+err.message}}}
document.addEventListener('click',e=>{const b=e.target.closest('[data-rprm]');if(!b)return;e.preventDefault();repPhotos.splice(+b.dataset.rprm,1);repThumbs();if(repPhotos.length)repRead();else{repReadN++;$('repAi').hidden=true}});
document.addEventListener('change',async e=>{if(e.target.id!=='repCam')return;const fs=[...e.target.files].slice(0,10-repPhotos.length);e.target.value='';if(!fs.length)return;
  for(const f of fs){try{const c=await shrink(f,1600);repPhotos.push({type:'image/jpeg',data:c.toDataURL('image/jpeg',.8).split(',')[1]})}catch(err){$('repMsg').textContent='Could not read one of those photos.'}}
  repThumbs();repRead()});

$('repMiss').onclick=e=>{const b=e.currentTarget;b.setAttribute('aria-pressed',b.getAttribute('aria-pressed')==='true'?'false':'true');renderRep()};
// ===== Repairs tab: every shop invoice saved as a vehicle note, with totals =====
let REP=null,REPT='';
// Ramp payments: a payment that matches an invoice (same week, same amount or amount + 3% card fee) just marks it paid
// and fills in a missing total; anything else is its own row, so nothing is counted twice.
function repMerge(all,ramp,trucks){if(!Array.isArray(ramp))return all;const byId=Object.fromEntries(trucks.map(t=>[t.id,t]));
  const words=s=>String(s).toLowerCase().replace(/[^a-z ]/g,' ').split(/\\s+/).filter(w=>w.length>3&&!/^(auto|repair|body|shop|center|centre|service|services|invoice|estimate|motors?)$/.test(w));
  ramp.slice().sort((a,b)=>b.amount-a.amount).forEach(p=>{const ts=Date.parse(p.date+'T12:00:00'),near=all.filter(r=>!r.ramp&&!r.rampOnly&&Math.abs(r.ts-ts)<=6*864e5);
    const amt=r=>r.total>0&&(Math.abs(p.amount-r.total)<=Math.max(.02,r.total*.005)||Math.abs(p.amount-r.total*1.03)<=Math.max(.03,r.total*.005));
    const shop=r=>words(r.shop).some(w=>words(p.merchant).includes(w));
    const hit=near.find(amt)||near.find(r=>r.missing&&shop(r)&&(!p.truckId||p.truckId===r.t.id))||near.find(r=>r.missing&&shop(r));
    if(hit){hit.ramp=p;if(hit.missing){hit.total=p.amount;hit.missing=false;hit.fromRamp=true}return}
    all.push({t:byId[p.truckId]||{id:'',truckNo:'',desc:'Truck not known',driver:''},rampOnly:true,ramp:p,ts,date:new Date(ts).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}),
      shop:p.merchant,est:false,paid:true,work:p.memo||'Paid in Ramp',total:p.amount,missing:false})});
  return all.sort((a,b)=>b.ts-a.ts)}

const REP_RE=/^([A-Z][a-z]{2} \\d{1,2}, \\d{4}) · From (.+?) (invoice|estimate)([^:]*): (.*)$/;
function repParse(trucks){const out=[];trucks.forEach(t=>String(t.notes||'').split('\\n').forEach(line=>{const m=REP_RE.exec(line);if(!m)return;
  const tm=/Total \\$([\\d,]+\\.\\d\\d)/.exec(m[5]),noc=/No charge/i.test(m[5]);
  out.push({t,line,date:m[1],ts:Date.parse(m[1]),shop:m[2],est:m[3]==='estimate',paid:/paid/i.test(m[4]),work:m[5].replace(/\\.? ?(Total \\$[\\d,]+\\.\\d\\d|Total not shown on photo|Total not entered|No charge shown)[^]*$/,'').replace(/\\.$/,''),total:tm?+tm[1].replace(/,/g,''):noc?0:null,missing:!tm&&!noc})}));
  return out.sort((a,b)=>b.ts-a.ts)}
const repName=t=>(t.truckNo?'#'+t.truckNo.split(/[ ~(]/)[0]+' ':'')+(t.desc||'Truck');
const money=n=>'$'+n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
// ---- Ramp tab: Overview + Gas (from /api/ramp/overview), Tools & items (above) ----
let ROV=null,RSEC='ov';
async function loadRampTab(){loadBuy();if(!ROV){$('rsOv').innerHTML=$('rsGas').innerHTML='<div class="empty">Loading the last 12 months from Ramp... (the first load can take a minute)</div>'}
  try{ROV=await get('/api/ramp/overview')}catch(e){$('rsOv').innerHTML=$('rsGas').innerHTML='<div class="empty">Could not load Ramp: '+esc(e.message)+'</div>';return}renderRampOv()}
const mlab=k=>new Date(k+'-15').toLocaleDateString('en-US',{month:'short'}),mfull=k=>new Date(k+'-15').toLocaleDateString('en-US',{month:'long',year:'numeric'});
function bars(ms,key,fmt,base){const nz=ms.map(m=>m[key]).filter(v=>v>0),b0=base&&nz.length?Math.min(...nz)*0.9:0,mx=Math.max(b0+0.01,...ms.map(m=>m[key])),hi=ms.reduce((a,m)=>m[key]>a[key]?m:a,ms[0]),cur=ms[ms.length-1].k;
  return '<div class="rp-mo rbars">'+ms.map(m=>'<div title="'+mfull(m.k)+': '+fmt(m[key])+'" class="'+(m.k===hi.k?'hi':'')+(m.k===cur?' cur':'')+'"><em>'+(m[key]?fmt(m[key]).replace('.00',''):'')+'</em><i style="height:'+(m[key]?Math.max(4,(m[key]-b0)/(mx-b0)*100):2)+'%"></i><span>'+mlab(m.k)+'</span></div>').join('')+'</div>'}
const k0=n=>'$'+Math.round(n).toLocaleString(),plural=(n,w)=>n+' '+w+(n===1?'':'s');
function plist(rows,val,sub){const mx=Math.max(1,...rows.map(val));return rows.map(r=>'<div class="rpl"><div><b>'+esc(r.name)+'</b><small>'+sub(r)+'</small></div><span>'+money(val(r))+'</span><i style="width:'+(val(r)/mx*100)+'%"></i></div>').join('')}
function renderRampOv(){const r=ROV;if(!r)return;if(r.connected===false){$('rsOv').innerHTML=$('rsGas').innerHTML='<div class="empty">Ramp is not connected.</div>';return}
  const q=$('q').value.trim().toLowerCase(),f=x=>!q||x.name.toLowerCase().includes(q),ms=r.months,last=ms[ms.length-1],avg=a=>a.reduce((s,m)=>s+m,0)/Math.max(1,a.length);
  const all=ms.map(m=>({k:m.k,v:m.gas+m.other})),g=r.gas,gAvg=avg(ms.slice(0,-1).map(m=>m.gas)),hiG=ms.reduce((a,m)=>m.gas>a.gas?m:a,ms[0]);
  $('rampCount').textContent=r.n.toLocaleString()+' card purchases and reimbursements since '+new Date(r.since).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
  // Overview
  $('rsOv').innerHTML='<div class="pbs"><div><b>'+k0(r.total)+'</b><span>spent in 12 months</span></div><div><b>'+k0(r.total/12)+'</b><span>a month on average</span></div><div><b>'+k0(g.total)+'</b><span>on gas ('+Math.round(g.total/Math.max(1,r.total)*100)+'%)</span></div>'
    +'<div><b>'+r.noRc.toLocaleString()+'</b><span>card purchases with no receipt · '+k0(r.noRcAmt)+'</span></div></div>'
    +'<div class="rp-grid"><div><div class="panel rp-pan"><h3>Spend by month <small class="muted">gas + everything else</small></h3>'+bars(all.map(m=>({k:m.k,v:m.v})),'v',k0)+'</div>'
    +'<div class="panel rp-pan"><h3>By person</h3>'+plist(r.people.filter(f).slice(0,25),x=>x.total,x=>plural(x.n,'purchase')+' · gas '+k0(x.gas)+(x.noRc?' · <b class="rwarn">'+x.noRc+' without receipt</b>':''))+'</div></div>'
    +'<aside><div class="panel rp-pan"><h3>Top categories <small class="muted">not gas</small></h3>'+plist(r.cats,x=>x.total,x=>plural(x.n,'purchase'))+'</div>'
    +'<div class="panel rp-pan"><h3>Top stores</h3>'+plist(r.merchants.filter(f),x=>x.total,x=>plural(x.n,'purchase'))+'</div></aside></div>';
  // Gas
  const now=new Date(),frac=now.getDate()/new Date(now.getFullYear(),now.getMonth()+1,0).getDate(),pace=last.gas/frac,vs=gAvg?Math.round((pace-gAvg)/gAvg*100):0;
  $('rsGas').innerHTML='<div class="pbs"><div><b>'+k0(g.total)+'</b><span>gas in 12 months · '+g.n.toLocaleString()+' fill-ups</span></div><div><b>'+k0(gAvg)+'</b><span>a month on average</span></div>'
    +'<div><b>'+k0(last.gas)+'</b><span>so far in '+mfull(last.k).split(' ')[0]+(gAvg&&frac>=0.2?' · on pace for '+k0(pace)+' ('+(vs>=0?'+':'')+vs+'% vs avg)':'')+'</span></div><div><b>'+mlab(hiG.k)+'</b><span>most expensive month · '+k0(hiG.gas)+'</span></div>'
    +(g.gal?'<div><b>'+g.gal.toLocaleString()+'</b><span>gallons · '+(g.ppg?'$'+g.ppg.toFixed(2)+'/gal avg':'')+'</span></div>':'')+'</div>'
    +'<p class="muted rgnote">Gallons, price per gallon and fuel grade come from the receipts read so far ('+g.read+' of '+g.withRc+' gas receipts; '+(g.card-g.withRc)+' card fill-ups have no receipt). '+(g.reimb?k0(g.reimb)+' of the total is out-of-pocket gas paid back as reimbursements.':'')+'</p>'
    +'<div class="rp-grid"><div><div class="panel rp-pan"><h3>Gas by month</h3>'+bars(ms,'gas',k0)+(ms.some(m=>m.ppg)?'<h3 style="margin-top:14px">Price per gallon</h3>'+bars(ms.map(m=>({k:m.k,p:m.ppg})),'p',v=>'$'+v.toFixed(2),1):'')+'</div>'
    +'<div class="panel rp-pan"><h3>Worth a look <small class="muted">weekends, very early or late, over $120, a 2nd fill-up the same day, premium fuel</small></h3>'+(g.flags.filter(x=>!q||x.who.toLowerCase().includes(q)).slice(0,40).map(x=>'<div class="rfl"><div><b>'+esc(x.who)+'</b> · '+money(x.amount)+' at '+esc(x.merchant)+'<small>'+esc(x.date)+' · '+esc(x.why)+'</small></div>'+(x.link?'<a class="btn2" href="'+esc(x.link)+'" target="_blank" rel="noopener">Ramp ↗</a>':'')+'</div>').join('')||'<div class="muted">Nothing unusual.</div>')+'</div></div>'
    +'<aside><div class="panel rp-pan"><h3>Gas by person</h3>'+plist(g.people.filter(f).slice(0,30),x=>x.total,x=>plural(x.n,'fill-up')+(x.gal?' · '+Math.round(x.gal)+' gal':'')+(x.wk?' · '+x.wk+' weekend':'')+(x.big?' · '+x.big+' over $120':''))+'</div>'
    +'<div class="panel rp-pan"><h3>Stations</h3>'+plist(g.stations,x=>x.total,x=>plural(x.n,'fill-up'))+'</div></aside></div>';
}
document.addEventListener('click',e=>{const b=e.target.closest('#rampNav [data-rs]');if(!b)return;RSEC=b.dataset.rs;document.querySelectorAll('#rampNav button').forEach(x=>x.classList.toggle('on',x===b));
  $('rsOv').hidden=RSEC!=='ov';$('rsGas').hidden=RSEC!=='gas';$('rsItems').hidden=RSEC!=='items';$('rsGps').hidden=RSEC!=='gps';$('rsCost').hidden=RSEC!=='cost';if(RSEC==='gps'||RSEC==='cost'){if(UP)renderRampUp();else loadUp()}});

// ---- Upkeep tab (oil, renewals, safety) + Ramp's "Cost per truck" and "Gas vs GPS" (all from /api/upkeep) ----
let UP=null,USEC='oil',GF='far',CSORT='cpm',UPL=false;
const UPV=()=>['usBody','rsGps','rsCost'];
async function loadUp(){if(UPL)return;UPL=true;if(!UP)UPV().forEach(i=>$(i).innerHTML='<div class="empty">Loading... (the first load can take a minute)</div>');
  try{UP=await get('/api/upkeep')}catch(e){UPV().forEach(i=>$(i).innerHTML='<div class="empty">Could not load: '+esc(e.message)+'</div>');UPL=false;return}UPL=false;renderUp();renderRampUp()}
const d0=n=>'$'+Math.round(n||0).toLocaleString(),fdate=d=>d?new Date(d+'T12:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}):'–';
const upq=()=>$('q').value.trim().toLowerCase(),upf=x=>{const q=upq();return !q||((x.name||'')+' '+(x.driver||'')+' '+(x.who||'')+' '+(x.truck||'')).toLowerCase().includes(q)};
const kpis=a=>'<div class="ukk">'+a.map(([v,l,c])=>'<div class="'+(c||'')+'"><b>'+v+'</b><span>'+l+'</span></div>').join('')+'</div>';
const chips=(attr,cur,list)=>'<div class="ukchips">'+list.map(([k,l,n])=>'<button data-'+attr+'="'+k+'" class="'+(k===cur?'on':'')+'">'+l+(n!=null?' <i>'+n+'</i>':'')+'</button>').join('')+'</div>';
const dueChip=n=>n===null||n===undefined?'<span class="dchip none">No date</span>':n<0?'<span class="dchip bad">Expired '+(-n)+' d ago</span>':n<=30?'<span class="dchip warn">'+(n===0?'Today':'In '+n+' days')+'</span>':'<span class="dchip ok">'+(n>=60?Math.round(n/30.4)+' months':n+' days')+' left</span>';
const costWhy=(r,gpm)=>{const h=r.how||{},ht=Object.values(h).reduce((a,b)=>a+b,0)||1,lab={gps:'GPS put this truck at the pump',month:'card holder drove this truck that month',year:'card holder drove this truck during the year',driver:'card holder’s assigned truck'};
  const row=(a,b,amt,cls)=>'<div class="bdr'+(cls?' '+cls:'')+'"><div><b>'+a+'</b>'+(b?'<small>'+b+'</small>':'')+'</div><b>'+amt+'</b></div>';
  return '<div class="bd"><h4>Repairs <span>'+d0(r.repairs)+'</span></h4>'+(r.rep&&r.rep.length?r.rep.map(x=>row(esc(x.what),fdate(x.d)+' · '+esc(x.where)+' · '+esc(x.src),money(x.amt))).join(''):'<p class="muted bdn">No repairs in the last 12 months.</p>')
   +'<h4>Gas <span>'+d0(r.gas)+'</span></h4>'+row('Expected for '+r.miles.toLocaleString()+' miles','about $'+gpm.toFixed(2)+' a mile for a pickup',d0(r.expectGas))
   +(r.gasBy||[]).map(x=>row(esc(x.who),'about '+x.n+' fill-up'+(x.n==1?'':'s')+' put on this truck',d0(x.amt))).join('')
   +(r.gasExtra?row('Left out of cost per mile','more gas than the miles explain','−'+d0(r.gasExtra),'extra'):'')
   +(ht>1?'<p class="muted bdn">How the gas was matched to this truck: '+Object.entries(h).map(([k,v])=>Math.round(v/ht*100)+'% '+lab[k]).join(', ')+'.</p>':'')
   +(r.warn&&r.warn.length?'<ul class="bdw">'+r.warn.map(w=>'<li>'+esc(w)+'</li>').join('')+'</ul>':'')
   +'<h4>Cost per mile</h4><p class="bdn">('+d0(r.repairs)+' repairs + '+d0(r.gasCounted??r.gas)+' gas) ÷ '+r.miles.toLocaleString()+' miles'+(r.cpm!==null?' = <b>$'+r.cpm.toFixed(2)+'</b>':'')+'</p></div>'};
function renderRampUp(){if(!UP)return;
  // Cost per truck
  const c=UP.cost;if(c.error)$('rsCost').innerHTML='<div class="empty">'+esc(c.error)+'</div>';else{
    const all=c.rows,tot=all.reduce((a,r)=>a+r.total,0),mi=all.reduce((a,r)=>a+r.miles,0),avg=mi?tot/mi:0;
    const key={cpm:r=>r.cpm??-1,total:r=>r.total,repairs:r=>r.repairs,miles:r=>r.miles}[CSORT],rows=all.filter(upf).slice().sort((a,b)=>key(b)-key(a));
    const worst=all.filter(r=>r.cpm!==null).sort((a,b)=>b.cpm-a.cpm)[0];
    const extraAll=all.reduce((a,r)=>a+(r.gasExtra||0),0);
    $('rsCost').innerHTML=kpis([[d0(tot),'repairs + gas, last 12 months'],[avg?'$'+avg.toFixed(2):'–','fleet cost per mile'],[mi.toLocaleString(),'miles driven'],worst?['$'+worst.cpm.toFixed(2),'highest: '+esc(worst.name),'bad']:null,extraAll?[d0(extraAll),'gas the miles don’t explain (left out)','warn']:null].filter(Boolean))
      +'<div class="ukbar"><span class="muted">Sort by</span>'+chips('cs',CSORT,[['cpm','Cost per mile'],['total','Total cost'],['repairs','Repairs'],['miles','Miles']])+'<span class="uklegend"><i class="dot rep"></i>Repairs <i class="dot gas"></i>Gas</span></div>'
      +'<div class="ukg">'+rows.map((r,i)=>{const vs=r.cpm!==null&&avg?Math.round((r.cpm/avg-1)*100):null,t=Math.max(1,r.repairs+r.gas),hot=vs!==null&&vs>=40,gc=r.gasCounted??r.gas;
        return '<div class="ukc'+(hot?' hot':vs!==null&&vs<=-20?' good':'')+'"><div class="ukc-h"><div><b>'+esc(r.name)+'</b><small>'+esc(r.driver||'No driver')+(r.age!==null?' · '+r.age+' yrs old':'')+(r.odo?' · '+r.odo.toLocaleString()+' mi':'')+'</small></div>'+(CSORT==='cpm'&&i<3&&r.cpm!==null?'<span class="rank">#'+(i+1)+'</span>':'')+'</div>'
          +'<div class="ukc-big">'+(r.cpm!==null?'<b>$'+r.cpm.toFixed(2)+'</b><span>per mile</span>'+(vs!==null?'<em class="'+(vs>0?'up':'down')+'">'+(vs>0?'+':'')+vs+'% vs fleet</em>':''):'<b class="muted">–</b><span>under 100 miles tracked</span>')+'</div>'
          +'<div class="split"><i class="rep" style="width:'+(r.repairs/t*100)+'%"></i><i class="gas" style="width:'+(gc/t*100)+'%"></i><i class="xgas" style="width:'+((r.gasExtra||0)/t*100)+'%"></i></div>'
          +'<div class="ukc-f"><span><i class="dot rep"></i>'+d0(r.repairs)+(r.nRep?' · '+r.nRep+' repair'+(r.nRep>1?'s':''):'')+'</span><span><i class="dot gas"></i>'+d0(gc)+(r.gasExtra?' <s title="Gas the miles don’t explain">+'+d0(r.gasExtra)+'</s>':'')+'</span><span>'+r.miles.toLocaleString()+' mi</span></div>'
          +(r.warn&&r.warn.length?'<div class="ukwarn">⚠ '+esc(r.warn[0])+'</div>':'')
          +'<details class="ukd"><summary>Why does it cost this much?</summary>'+costWhy(r,c.gasPerMile||0.22)+'</details></div>'}).join('')+'</div>'
      +(c.unassignedGas?'<p class="muted rgnote">'+d0(c.unassignedGas)+' of gas could not be matched to a truck (card holders with no truck).</p>':'')}
  // Gas vs GPS
  const g=UP.gas.filter(upf),cnt=k=>g.filter(k).length,isFar=x=>x.flags.length>0,isUnv=x=>!x.flags.length&&x.unverified,isOk=x=>!x.flags.length&&!x.unverified;
  const pick={far:isFar,unv:isUnv,ok:isOk,all:()=>true}[GF],list=g.filter(pick);
  const by={};g.filter(x=>x.verdict==='far').forEach(x=>{const b=by[x.who]=by[x.who]||{n:0,amt:0};b.n++;b.amt+=x.amount});const top=Object.entries(by).sort((a,b)=>b[1].n-a[1].n).slice(0,10),tmx=top.length?top[0][1].n:1;
  const when=t=>new Date(t).toLocaleString('en-US',{weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
  $('rsGps').innerHTML=kpis([[g.length,'fill-ups checked (60 days)'],[cnt(x=>x.verdict==='far'),'truck not near the card','bad'],[cnt(isFar),'flagged in all','warn'],[cnt(isOk),'truck was at the station','good']])
    +'<div class="ukbar">'+chips('gf',GF,[['far','Flagged',cnt(isFar)],['unv','Could not check',cnt(isUnv)],['ok','All good',cnt(isOk)],['all','Everything',g.length]])+'<span style="flex:1"></span><button class="btn2" id="upGasRun">'+(UP.gasBusy?'Checking...':'Check new fill-ups now')+'</button></div>'
    +'<div class="rp-grid"><div>'+(list.length?list.slice(0,150).map(x=>{const k=isFar(x)?'far':isUnv(x)?'unv':'ok';
      return '<div class="gc '+k+'"><div class="gc-ic">'+(k==='far'?'!':k==='unv'?'?':'✓')+'</div><div class="gc-m"><div class="gc-t"><b>'+esc(x.who)+'</b><span>'+money(x.amount)+(x.gal?' · '+x.gal.toFixed(1)+' gal':'')+' at '+esc(x.merchant)+'</span></div>'
        +'<small>'+when(x.at)+(x.truck?' · '+esc(x.truck):'')+(x.tank?' ('+x.tank+' gal tank)':'')+'</small>'
        +(x.flags.length?'<ul>'+x.flags.map(f=>'<li>'+esc(f)+'</li>').join('')+'</ul>':x.unverified?'<p>'+esc(x.unverified)+'</p>':'<p>Truck was at the station'+(x.verdict==='moving'?' (driving past)':'')+'</p>')+'</div><a class="btn2" href="'+esc(x.link)+'" target="_blank" rel="noopener">Ramp ↗</a></div>'}).join('')
      :'<div class="empty">'+(g.length?'Nothing here.':'No fill-ups checked yet. The first check runs a few minutes after the server starts.')+'</div>')+'</div>'
    +'<aside><div class="panel rp-pan"><h3>Most “not near” fill-ups</h3>'+(top.length?top.map(([n,b])=>'<div class="ukrank"><div><b>'+esc(n)+'</b><small>'+b.n+' fill-up'+(b.n>1?'s':'')+' · '+money(b.amt)+'</small></div><i><b style="width:'+(b.n/tmx*100)+'%"></b></i></div>').join(''):'<div class="muted">Nobody yet.</div>')+'</div>'
    +'<div class="panel rp-pan"><h3>How it works</h3><p class="muted" style="margin:0;font-size:13px">For every gas charge on a Ramp card, the dashboard looks at where the card holder’s trucks were (Azuga) within 30 minutes. If the engine was off, it uses where the truck was parked. More than about 6–10 miles from the station is flagged. It also flags more gallons than the tank holds, and a second fill-up within a day with little driving.</p></div></aside></div>'}
const upRem=(icon,title,on,how,who,when,actions)=>'<div class="rmc wide'+(on?' live':'')+'"><div class="rmh"><span class="rmi">'+icon+'</span><div><b>'+title+'</b><small>'+how+'</small></div>'+(on?'<span class="rmpill on">● On</span>':'<span class="rmpill off">Off</span>')+'</div><dl class="rmd"><dt>About</dt><dd>'+who+'</dd><dt>When</dt><dd>'+when+'</dd></dl><div class="rma">'+actions+'</div></div>';
function renderUp(){const u=UP;if(!u)return;let h='';
  if(USEC==='oil'){const o=Array.isArray(u.oil)?u.oil.filter(upf):[],lab={due:'Due now',soon:'Due soon',ok:'OK',unknown:'No record'};
    $('upCount').textContent='Due every '+u.oilMiles.toLocaleString()+' miles or 6 months · last change comes from invoices saved in the truck notes';
    h=(u.oil.error?'<div class="empty">'+esc(u.oil.error)+'</div>':'')+kpis([[o.filter(x=>x.status==='due').length,'due now','bad'],[o.filter(x=>x.status==='soon').length,'due soon','warn'],[o.filter(x=>x.status==='ok').length,'up to date','good'],[o.filter(x=>x.status==='unknown').length,'no oil change on record']])
     +upRem('🛢️','Oil change reminder',u.settings.oil,'Email to callum@millennialpools.com (one per truck)','Every truck that is due (5,000 miles or 6 months)','Mondays at 8 AM','<label class="sw"><input type="checkbox" id="upOilOn"'+(u.settings.oil?' checked':'')+'><i></i>Send automatically</label><button class="btn2" id="upOilTest">Send me a sample</button>')
     +'<div class="ukg">'+o.map(x=>{const pct=x.since!==null?x.since/u.oilMiles*100:x.days!==null?x.days/183*100:0;
       return '<div class="ukc oil '+x.status+'"><div class="ukc-h"><div><b>'+esc(x.name)+'</b><small>'+esc(x.driver||'No driver')+'</small></div><span class="upill '+x.status+'">'+lab[x.status]+'</span></div>'
        +'<div class="ukc-big">'+(x.since!==null?'<b>'+x.since.toLocaleString()+'</b><span>miles since last change</span>':x.days!==null?'<b>'+x.days+'</b><span>days since last change'+(x.odoMismatch?' (odometer doesn’t match the invoice)':'')+'</span>':'<b class="muted">–</b><span>no oil change saved yet</span>')+'</div>'
        +'<div class="oilbar"><i style="width:'+Math.min(100,pct/1.3)+'%"></i><em style="left:'+(100/1.3)+'%"></em></div>'
        +'<div class="ukc-f"><span>Last: '+fdate(x.oilDate)+(x.oilMiles?' at '+Number(x.oilMiles).toLocaleString()+' mi':'')+'</span>'+(x.days!==null&&x.since!==null?'<span>'+x.days+' days ago</span>':'')+'<span>Now '+(x.odo?x.odo.toLocaleString()+' mi':'–')+'</span></div></div>'}).join('')+'</div>'}
  if(USEC==='ren'){const r=u.renew.filter(upf),soon=x=>x!==null&&x<=30,need=x=>soon(x.insLeft)||soon(x.regLeft),miss=x=>!need(x)&&(!x.ins||!x.reg);
    $('upCount').textContent='Registration and insurance dates come from the files in Airtable and from what techs enter in their weekly check-up · fix any date right on the card';
    const blk=(x,k)=>{const n=x[k+'Left'],d=x[k],src=x[k+'Src'],tech=x[k+'Tech'],st=n===null?'none':n<0?'bad':n<=30?'warn':'ok';
      const from=src==='checkup'?'From '+esc(tech.who)+'’s check-up on '+fdate(tech.on):src==='airtable'?'From the '+(k==='ins'?'insurance card':'registration file')+' in Airtable':'Not on file';
      const tl=tech&&tech.date&&src!=='checkup'?'<div class="rtech'+(tech.warn.length?' w':'')+'">'+esc(tech.who)+' entered '+fdate(tech.date)+' in their '+fdate(tech.on)+' check-up'+(tech.warn.length?'<br>⚠ Not used: '+esc(tech.warn.join('; ')):'')+'</div>':'';
      return '<div class="rblk '+k+' '+st+'"><div class="rblk-h"><span>'+(k==='reg'?'🪪 Registration':'🛡️ Insurance')+'</span>'+(n===null?'':dueChip(n))+'</div><div class="rblk-d">'+(d?fdate(d):'No date')+'</div><div class="rsrc">'+from+'</div>'+tl
        +'<input type="date" data-ren="'+k+'" data-id="'+x.id+'" value="'+esc(x[k+'Air']||'')+'" aria-label="'+(k==='reg'?'Registration':'Insurance')+' expires (Airtable)" title="Airtable date"></div>'};
    const card=x=>'<div class="ukc ren'+(need(x)?' hot':'')+'"><div class="ukc-h"><div><b>'+esc(x.name)+'</b><small>'+esc(x.plate||'No plate')+(x.policy?' · '+esc(x.policy):'')+'</small></div>'+(x.card?'<a class="btn2" href="'+esc(x.card)+'" target="_blank" rel="noopener">Card ↗</a>':'')+'</div>'
      +'<div class="rblks">'+blk(x,'reg')+blk(x,'ins')+'</div></div>';
    const grp=(t,list,cls)=>list.length?'<h3 class="ukgh '+cls+'">'+t+' <i>'+list.length+'</i></h3><div class="ukg">'+list.map(card).join('')+'</div>':'';
    const lt=x=>Math.min(x.insLeft??1e4,x.regLeft??1e4);
    h=kpis([[r.filter(x=>soon(x.insLeft)).length,'insurance due in 30 days','bad'],[r.filter(x=>soon(x.regLeft)).length,'registrations due in 30 days','bad'],[r.filter(x=>!x.reg).length,'trucks with no registration date','warn'],[r.filter(x=>x.ins&&x.reg&&!need(x)).length,'all set','good']])
     +upRem('📄','Renewal reminder',u.settings.renew,'Email to callum@millennialpools.com with the card attached','Any truck whose insurance or registration runs out within 30 days','Checked every day from 8 AM · once per renewal','<label class="sw"><input type="checkbox" id="upRenOn"'+(u.settings.renew?' checked':'')+'><i></i>Send automatically</label><button class="btn2" id="upRenRead"'+(u.ai?'':' disabled title="Needs ANTHROPIC_API_KEY"')+'>Read cards now</button><button class="btn2" id="upRenTest">Send due reminders now</button>')
     +grp('Due in 30 days or expired',r.filter(need).sort((a,b)=>lt(a)-lt(b)),'bad')+grp('Missing a date',r.filter(miss),'warn')+grp('All set',r.filter(x=>!need(x)&&!miss(x)).sort((a,b)=>lt(a)-lt(b)),'good')}
  if(USEC==='saf'){$('upCount').textContent='Every Monday each driver gets their own score, rank and worst camera event of the week';
    h='<div class="saf"><div class="panel rp-pan"><h3>Weekly safety email</h3><label class="sw"><input type="checkbox" id="upSafOn"'+(u.settings.safety?' checked':'')+'><i></i>Send to every driver, Mondays at 8 AM</label>'
     +'<ul class="safl"><li><b>Score</b> out of 100 and their rank in the fleet</li><li><b>Worst camera event</b> of the week</li><li><b>Private link</b> to their report with the clips (works 2 weeks)</li></ul>'
     +'<p class="muted" style="font-size:13px">Goes to the email on their Airtable record. Drivers with no email, or whose email bounced, are skipped.</p>'
     +'<div class="safq"><input id="upSafName" placeholder="Driver name" value="Callum Curcie"><button class="btn2" id="upSafPrev">Preview</button><button class="btn2" id="upSafTest">Send this to me</button></div><span id="upSafMsg" class="muted"></span></div>'
     +'<div id="upSafOut"><div class="mail"><div class="mail-h"><b>Preview</b><span>Pick a driver and press Preview</span></div></div></div></div>'}
  if(!u.mail)h='<p class="muted">Email isn’t set up in Render yet, so nothing will be sent.</p>'+h;
  $('usBody').innerHTML=h}
document.addEventListener('click',async e=>{const n=e.target.closest('#upNav [data-us]');if(n){USEC=n.dataset.us;document.querySelectorAll('#upNav button').forEach(x=>x.classList.toggle('on',x===n));renderUp();return}
  const gf=e.target.closest('[data-gf]');if(gf){GF=gf.dataset.gf;renderRampUp();return}
  const cs=e.target.closest('[data-cs]');if(cs){CSORT=cs.dataset.cs;renderRampUp();return}
  const id=e.target.id,go=async(u,b,ok)=>{e.target.disabled=true;try{const r=await post(u,b||{});if(ok)ok(r)}catch(err){alert(err.message)}e.target.disabled=false};
  if(id==='upGasRun')go('/api/upkeep/gas-check',{},()=>{e.target.textContent='Checking... refresh in a few minutes';setTimeout(()=>{UP=null;loadUp()},90e3)});
  if(id==='upOilTest')go('/api/upkeep/oil-sample',{},r=>{e.target.textContent='Sent to '+r.to});
  if(id==='upRenRead')go('/api/upkeep/read-cards',{},()=>{e.target.textContent='Reading... check back in a few minutes';setTimeout(()=>{UP=null;loadUp()},120e3)});
  if(id==='upRenTest')go('/api/upkeep/renewal-test',{},r=>{e.target.textContent=r.sent.length?'Sent: '+r.sent.length:'Nothing due in 30 days'});
  if(id==='upSafPrev'){const v=$('upSafName').value.trim();$('upSafOut').innerHTML='<div class="mail"><div class="mail-h"><b>Loading...</b></div></div>';try{const r=await get('/api/upkeep/safety-preview?name='+encodeURIComponent(v));
    $('upSafOut').innerHTML=r.error?'<div class="empty">'+esc(r.error)+'</div>':'<div class="mail"><div class="mail-h"><b>'+esc(r.subject)+'</b><span>To: '+esc(r.name)+' · from contact@millennialpools.com</span></div><div class="mail-b">'+esc(r.body).split('\\n').join('<br>')+'</div></div>'}catch(err){$('upSafOut').textContent=err.message}}
  if(id==='upSafTest')go('/api/upkeep/safety-sample',{name:$('upSafName').value.trim()},r=>{$('upSafMsg').textContent='Sent '+r.name+'’s email to '+r.to});
});
document.addEventListener('change',async e=>{const t=e.target,map={upOilOn:'oil',upRenOn:'renew',upSafOn:'safety'};
  if(map[t.id]){try{UP.settings=await post('/api/upkeep/settings',{[map[t.id]]:t.checked});renderUp()}catch(err){alert(err.message);t.checked=!t.checked}return}
  if(t.dataset&&t.dataset.ren){try{await post('/api/upkeep/renewal',{id:t.dataset.id,[t.dataset.ren]:t.value});const x=UP.renew.find(r=>r.id===t.dataset.id);x[t.dataset.ren+'Air']=t.value;if(!x[t.dataset.ren]||x[t.dataset.ren+'Src']!=='checkup'||t.value>x[t.dataset.ren]){x[t.dataset.ren]=t.value;x[t.dataset.ren+'Src']=t.value?'airtable':''}x[t.dataset.ren+'Left']=x[t.dataset.ren]?Math.round((Date.parse(x[t.dataset.ren]+'T12:00')-Date.now())/864e5):null;t.classList.add('saved');setTimeout(renderUp,700)}catch(err){alert(err.message)}}});
// ---- Purchases tab: hardware-store receipts from Ramp, item by item, with season-end return status ----
let BUY=null,BUYF='Out';
async function loadBuy(){if(!BUY)$('buyCount').textContent='Loading Ramp purchases...';try{BUY=await get('/api/purchases')}catch(e){$('buyCount').textContent='Could not load purchases: '+e.message;return}renderBuy()}
const BST={'Out':'Out','Returned':'Returned','Used up':'Used up'};
function renderBuy(){const r=BUY;if(!r)return;
  if(!r.connected){$('buyCount').textContent='Ramp is not connected (add RAMP_CLIENT_ID / RAMP_CLIENT_SECRET in Render).';return}
  const q=$('q').value.trim().toLowerCase(),who=$('buyWho').value;
  const ppl=[...new Set(r.txns.map(t=>t.who).filter(Boolean))].sort();if($('buyWho').options.length-1!==ppl.length)$('buyWho').innerHTML='<option value="">Everyone</option>'+ppl.map(p=>'<option'+(p===who?' selected':'')+'>'+esc(p)+'</option>').join('');
  const it=r.items.filter(x=>(!who||x.who===who)&&(!q||(x.name+' '+x.sku+' '+x.who+' '+x.store+' '+x.memo).toLowerCase().includes(q)));
  const sum=st=>it.filter(x=>x.status===st).reduce((a,x)=>[a[0]+1,a[1]+x.price],[0,0]),o=sum('Out'),rt=sum('Returned'),u=sum('Used up');
  const wait=r.txns.filter(t=>t.state==='waiting').length,nor=r.txns.filter(t=>t.state==='noReceipt').length,bad=r.txns.filter(t=>t.state==='error').length;
  $('buyCount').textContent=r.txns.length+' hardware-store purchases since '+r.since+' · '+r.items.length+' items read'+(r.last?' · last check '+new Date(r.last).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}):'');
  $('buySum').innerHTML=(r.err||!r.ai?'<div class="note bnote">'+esc(r.err||'Receipts are read by hand until ANTHROPIC_API_KEY is added in Render. Ask Claude to read the waiting ones.')+'</div>':'')
    +'<div class="bsum"><div><b>'+o[0]+'</b><span>still out · '+money(o[1])+'</span></div><div><b>'+rt[0]+'</b><span>returned</span></div><div><b>'+u[0]+'</b><span>used up</span></div><div><b>'+wait+'</b><span>receipts waiting to be read</span></div><div><b>'+nor+'</b><span>purchases with no receipt</span></div>'+(bad?'<div><b>'+bad+'</b><span>receipts unreadable</span></div>':'')+'</div>';
  $('buyChips').innerHTML=['Out','Returned','Used up','All'].map(k=>'<button class="bchip'+(BUYF===k?' on':'')+'" data-bf="'+k+'">'+(k==='Out'?'Still out':k)+'</button>').join('');
  const show=it.filter(x=>BUYF==='All'||x.status===BUYF),by={};show.forEach(x=>(by[x.txn]=by[x.txn]||[]).push(x));
  const tx=Object.fromEntries(r.txns.map(t=>[t.id,t])),ids=Object.keys(by).sort((a,b)=>((by[b][0].date||'')>(by[a][0].date||'')?1:-1));
  const seg=x=>'<span class="bseg">'+Object.keys(BST).map(k=>'<button data-bi="'+esc(x.id)+'" data-bs="'+k+'" class="'+(x.status===k?'on s'+k.replace(' ',''):'')+'">'+k+'</button>').join('')+'</span>';
  $('buyList').innerHTML=ids.length?ids.slice(0,150).map((id,i)=>{const L=by[id],f=L[0],t=tx[id]||{};
    return '<div class="bcard" style="--i:'+Math.min(i,12)+'"><div class="bhead"><div><b>'+esc(f.store)+'</b> · '+esc(f.who)+'<small>'+esc(f.date)+(t.amount?' · '+money(t.amount):'')+(f.memo?' · '+esc(f.memo):'')+'</small></div><span style="flex:1"></span>'
      +(f.ramp?'<a class="btn2" href="'+esc(f.ramp)+'" target="_blank" rel="noopener">Ramp ↗</a>':'')+'<button class="btn2" data-ball="'+esc(L.map(x=>x.id).join(','))+'" data-bs="Returned">All returned</button></div>'
      +L.map(x=>'<div class="bit"><div><a href="'+esc(x.link)+'" target="_blank" rel="noopener">'+esc(x.name)+' ↗</a><small>'+(x.sku?'SKU '+esc(x.sku)+' · ':'')+'Qty '+x.qty+' · '+money(x.price)+'</small></div>'+seg(x)+'</div>').join('')+'</div>'}).join('')
    :'<div class="empty">'+(r.items.length?'No items match.':'No receipts read yet.'+(wait?' '+wait+' are waiting.':''))+'</div>';
  const out={};it.filter(x=>x.status==='Out').forEach(x=>{const p=out[x.who]=out[x.who]||[0,0];p[0]+=x.qty;p[1]+=x.price});
  const nr=r.txns.filter(t=>t.state==='noReceipt'&&(!who||t.who===who)).slice(0,15);
  $('buySide').innerHTML='<div class="panel bside"><h4>Still out by person</h4>'+(Object.keys(out).length?Object.entries(out).sort((a,b)=>b[1][1]-a[1][1]).map(([p,v])=>'<div class="brow"><b>'+esc(p||'Unknown')+'</b><span>'+v[0]+' items · '+money(v[1])+'</span></div>').join(''):'<div class="muted">Nothing out.</div>')+'</div>'
    +(nr.length?'<div class="panel bside"><h4>No receipt in Ramp yet</h4>'+nr.map(t=>'<a class="brow" href="'+esc(t.link)+'" target="_blank" rel="noopener"><b>'+esc(t.who)+'</b><span>'+esc(t.store)+' · '+esc(t.date)+' · '+money(t.amount)+'</span></a>').join('')+'</div>':'');
}
$('buyWho').onchange=renderBuy;
document.addEventListener('click',async e=>{const c=e.target.closest('[data-bf]');if(c){BUYF=c.dataset.bf;renderBuy();return}
  const b=e.target.closest('#vBuy [data-bs]');if(!b)return;const ids=b.dataset.ball?b.dataset.ball.split(','):[b.dataset.bi],st=b.dataset.bs;b.disabled=true;
  try{await post('/api/purchase/status',{ids,status:st});BUY.items.forEach(x=>{if(ids.includes(x.id))x.status=st});renderBuy();toast(ids.length+' item'+(ids.length>1?'s':'')+' marked '+st.toLowerCase())}catch(err){toast(err.message,'bad');b.disabled=false}});
$('buyRead').onclick=async e=>{const b=e.currentTarget;b.disabled=true;b.textContent='Reading...';try{await post('/api/purchase/read',{});toast('Reading receipts. New items show up in a minute or two.');setTimeout(async()=>{BUY=null;await loadBuy();b.disabled=false;b.textContent='Read new receipts now'},60000)}catch(err){toast(err.message,'bad');b.disabled=false;b.textContent='Read new receipts now'}};

async function loadRep(){if(!REP)$('repCount').textContent='Loading repairs from Airtable...';try{REP=await get('/api/repairs')}catch(e){$('repCount').textContent='Could not load repairs: '+e.message;return}renderRep()}
function renderRep(){if(!REP)return;if(!REP.connected){$('repCount').textContent='Airtable is not connected.';return}
  const all=repMerge(repParse(REP.trucks),REP.ramp,REP.trucks),q=$('q').value.trim().toLowerCase(),miss=$('repMiss').getAttribute('aria-pressed')==='true';
  const rows=all.filter(r=>(!REPT||(r.t.id||'none')===REPT)&&(!miss||r.missing)&&(!q||(repName(r.t)+' '+(r.t.driver||'')+' '+r.shop+' '+r.work+' '+(r.ramp?r.ramp.who+' '+r.ramp.memo:'')).toLowerCase().includes(q)));
  const sum=a=>a.reduce((s,r)=>s+(r.total||0),0),yr=new Date().getFullYear(),thisYr=all.filter(r=>new Date(r.ts).getFullYear()===yr);
  const rc=all.filter(r=>r.ramp).length;$('repCount').textContent=all.length+' repairs · from invoices saved to each truck in Airtable'+(Array.isArray(REP.ramp)?' and '+rc+' repair payment'+(rc===1?'':'s')+' in Ramp':REP.ramp&&REP.ramp.error?' · Ramp could not be read: '+REP.ramp.error:'');
  // per truck
  const by={};all.forEach(r=>{const k=r.t.id||'none';(by[k]=by[k]||{t:r.t,n:0,sum:0,miss:0});by[k].n++;by[k].sum+=r.total||0;if(r.missing)by[k].miss++});
  const tr=Object.values(by).sort((a,b)=>b.sum-a.sum),top=tr[0],max=top?top.sum:1;
  $('repSum').innerHTML='<div class="pbs"><div><b>'+money(sum(all))+'</b><span>spent on repairs</span></div><div><b>'+money(sum(thisYr))+'</b><span>in '+yr+'</span></div><div><b>'+all.length+'</b><span>invoices</span></div>'
    +(top?'<div><b>'+esc(repName(top.t))+'</b><span>costs the most · '+money(top.sum)+'</span></div>':'')
    +(all.some(r=>r.missing)?'<div><b>'+all.filter(r=>r.missing).length+'</b><span>missing a total</span></div>':'')+'</div>';
  // monthly bars, last 12 months
  const mo=[];for(let i=11;i>=0;i--){const d=new Date();d.setDate(1);d.setMonth(d.getMonth()-i);mo.push({k:d.getFullYear()+'-'+d.getMonth(),l:d.toLocaleDateString('en-US',{month:'short'}),v:0})}
  all.forEach(r=>{const d=new Date(r.ts),m=mo.find(x=>x.k===d.getFullYear()+'-'+d.getMonth());if(m)m.v+=r.total||0});const mm=Math.max(1,...mo.map(m=>m.v));
  $('repSide').innerHTML='<div class="panel rp-pan"><h3>Spend by month</h3><div class="rp-mo">'+mo.map(m=>'<div title="'+m.l+': '+money(m.v)+'"><i style="height:'+Math.max(2,m.v/mm*100)+'%"></i><span>'+m.l+'</span></div>').join('')+'</div></div>'
    +'<div class="panel rp-pan"><h3>By truck</h3><p class="muted" style="font-size:12px;margin:-4px 0 8px">Click a truck to see only its repairs</p>'+tr.map(x=>'<button class="rp-tk'+(REPT===x.t.id?' on':'')+'" data-rt="'+esc(x.t.id||'none')+'"><span><b>'+esc(repName(x.t))+'</b><small>'+esc(x.t.driver||'No driver')+' · '+x.n+' invoice'+(x.n>1?'s':'')+(x.miss?' · '+x.miss+' no total':'')+'</small></span><em>'+money(x.sum)+'</em><i style="width:'+(x.sum/max*100)+'%"></i></button>').join('')+'</div>';
  $('repList').innerHTML=(REPT?'<div class="rp-fil">Showing <b>'+esc(repName(by[REPT].t))+'</b> · '+money(sum(rows))+' <button class="btn2" data-rt="">Show all trucks</button></div>':'')
    +(rows.length?'<div class="panel rp-list">'+rows.map((r,i)=>'<div class="rp-row" style="--i:'+Math.min(i,20)+'"><div class="rp-dt"><b>'+esc(r.date.replace(/, \\d{4}$/,''))+'</b><small>'+new Date(r.ts).getFullYear()+'</small></div>'
      +'<div class="rp-body"><div class="rp-top"><button class="rp-chip'+(r.t.id?'':' unk')+'" data-rt="'+esc(r.t.id||'none')+'">'+esc(repName(r.t))+'</button><span class="rp-shop">'+esc(r.shop)+'</span>'+(r.ramp?'<a class="rp-ramp" href="'+esc(r.ramp.link)+'" target="_blank" rel="noopener" title="'+esc((r.ramp.who?r.ramp.who+'\u2019s card · ':'')+'$'+r.ramp.amount.toFixed(2)+(r.ramp.memo?' · '+r.ramp.memo:''))+'">'+(r.rampOnly?'Ramp only':r.fromRamp?'Total from Ramp':'Paid in Ramp ✓')+'</a>':'')+(r.est?'<span class="rp-tag">'+(r.paid?'Estimate, paid':'Estimate')+'</span>':'')+'</div><div class="rp-work">'+esc(r.work)+(r.rampOnly&&r.ramp.who?' <span class="muted">· '+esc(r.ramp.who)+(r.ramp.how==='driver'?', matched to their truck':'')+'</span>':'')+'</div></div>'
      +'<div class="rp-amt'+(r.missing?' miss':'')+'">'+(r.missing?'No total':r.total===0?'No charge':money(r.total))+'</div></div>').join('')+'</div>'
     :'<div class="empty">'+(all.length?'No repairs match.':'No repair invoices saved yet. Send invoice photos to Claude and they show up here.')+'</div>')}
document.addEventListener('click',e=>{const b=e.target.closest('#vRep [data-rt]');if(!b)return;REPT=REPT===b.dataset.rt?'':b.dataset.rt;renderRep();$('vRep').scrollIntoView({behavior:'smooth',block:'start'})});

window.addEventListener('beforeunload',e=>{if(dirtyCount())e.preventDefault()});
refresh();setInterval(refresh,30000);
</script></body></html>`;

const DARK_FIX = `html[data-theme=dark]{color-scheme:dark;--deck:#0d161d;--deck2:#131f28;--card:#141f28;--line:#24333f;--line2:#2e404d;
 --ink:#e4ebf0;--ink2:#b7c5cf;--muted:#8d9eab;--shallow:#123441;--shallow2:#174556;--poolInk:#5fd3ea;--pool:#22b8d4;
 --go:#6ee7a0;--goBg:#123524;--idle:#a9b6c0;--idleBg:#1c2a34;--warn:#fbbf6a;--warnBg:#3a2a12;--bad:#fca5a5;--badBg:#3d1b1b;
 --coralBg:#3a1f1b;--sunBg:#382c12;--grapeBg:#271f3d;--leafBg:#123524;--sh:0 0 0 1px rgba(0,0,0,.25),0 2px 8px -4px rgba(0,0,0,.5)}
html[data-theme=dark] body{background:var(--deck)!important}
html[data-theme=dark] header{background:linear-gradient(100deg,#06141d 0%,#0a2a3a 60%,#0b3e50 100%)!important}
html[data-theme=dark] .tabs button.on{background:var(--deck)!important;color:#7fe0f2!important}
html[data-theme=dark] .leaflet-tile-pane{filter:invert(1) hue-rotate(180deg) brightness(.85) contrast(.9) saturate(.5)}
html[data-theme=dark] .leaflet-container{background:#0d161d}
html[data-theme=dark] img:not(.leaflet-tile){filter:brightness(.92)}
html[data-theme=dark] input,html[data-theme=dark] select,html[data-theme=dark] textarea{background:#101a22;color:var(--ink);border-color:var(--line2)}
html[data-theme=dark] ::placeholder{color:#6f808c}
html[data-theme=dark] [style*="background:#fff"],html[data-theme=dark] [style*="background: #fff"],html[data-theme=dark] [style*="background:white"]{background:var(--card)!important}
html[data-theme=dark] [style*="color:#0f172a"],html[data-theme=dark] [style*="color:#334155"],html[data-theme=dark] [style*="color:#1e293b"]{color:var(--ink)!important}
html[data-theme=dark] [style*="color:#64748b"],html[data-theme=dark] [style*="color:#475569"]{color:var(--muted)!important}
`;
// Dark mode: built once at startup from the page's own CSS, so every existing (and future) rule gets a dark version.
// Light backgrounds become dark surfaces, light borders become dim lines, dark text becomes light; accents stay.
function darkCss(css) {
  const hsl = (r, g, b) => { r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
    if (!d) return [0, 0, l]; const s = d / (1 - Math.abs(2 * l - 1)), h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return [h * 60, s, l]; };
  const out = (h, s, l, a) => 'hsl(' + Math.round(h) + ' ' + Math.round(s * 100) + '% ' + Math.round(l * 100) + '%' + (a < 1 ? ' / ' + a : '') + ')';
  const shift = (kind, h, s, l, a) => {
    if (kind === 'tx') return l < 0.6 ? out(h, Math.min(s, 0.75), 0.93 - l * 0.6, a) : null;
    if (l < (s > 0.3 ? 0.7 : 0.78)) return null;   // accents, buttons and dark panels already work on a dark page
    if (kind === 'bd') return s > 0.3 ? out(h, Math.min(s, 0.4), 0.3, a) : out(s < 0.15 ? 205 : h, 0.2, 0.22 + (1 - l) * 0.3, a);
    return s > 0.3 && l < 0.985 ? out(h, Math.min(s, 0.32), 0.16, a) : out(s < 0.15 ? 205 : h, s < 0.15 ? 0.22 : Math.min(s, 0.25), 0.135 - (1 - l) * 0.4, a);
  };
  const COL = /#([0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3})\b|rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)|\b(white)\b/gi;
  const conv = (kind, v) => { let hit = false; const r = v.replace(COL, (m, hex, R, G, B, A, w) => {
      let c, a = 1;
      if (w) c = [255, 255, 255];
      else if (hex) { const x = hex.length === 3 ? hex.split('').map(q => q + q).join('') : hex; c = [0, 2, 4].map(i => parseInt(x.slice(i, i + 2), 16)); if (x.length === 8) a = Math.round(parseInt(x.slice(6), 16) / 2.55) / 100; }
      else { c = [+R, +G, +B]; if (A) a = A.endsWith('%') ? parseFloat(A) / 100 : +A; }
      const n = shift(kind, ...hsl(...c), a); if (n) hit = true; return n || m; });
    return hit ? r : null; };
  const kindOf = p => /^(color|fill|stroke|caret-color|-webkit-text-fill-color|text-decoration-color)$/.test(p) ? 'tx' : /^(border|outline)/.test(p) ? 'bd' : /^background/.test(p) ? 'bg' : null;
  const pre = sel => sel.split(/,(?![^(]*\))/).map(x => { x = x.trim(); return /^(:root|html)\b/.test(x) ? x.replace(/^(:root|html)/, ':where(html[data-theme=dark])') : ':where(html[data-theme=dark]) ' + x; }).join(',');   // :where keeps each rule's own weight
  let res = '', i = 0;
  const walk = (src) => { let o = '', re = /([^{}]+)\{([^{}]*)\}|(@media[^{]+)\{|(@(?:-webkit-)?keyframes[^{]+)\{|\}/g, m, depth = [];
    while ((m = re.exec(src))) {
      if (m[3]) { depth.push('m'); o += m[3] + '{'; continue; }
      if (m[4]) { let d = 1, j = re.lastIndex; while (d && j < src.length) { if (src[j] === '{') d++; else if (src[j] === '}') d--; j++; } re.lastIndex = j; continue; }   // skip animations
      if (!m[1]) { if (depth.pop()) o += '}'; continue; }
      const sel = m[1].trim(); if (!sel || sel.startsWith('@') || /background-clip:\s*text/.test(m[2])) continue;
      const decl = m[2].split(/;(?![^(]*\))/).map(d => { const k = d.indexOf(':'); if (k < 0) return null; const p = d.slice(0, k).trim().toLowerCase(), v = d.slice(k + 1).trim(), kd = kindOf(p);
        const n = kd && conv(kd, v); return n ? p + ':' + n : null; }).filter(Boolean);
      if (decl.length) o += pre(sel) + '{' + decl.join(';') + '}';
    }
    return o.replace(/@media[^{]+\{\}/g, ''); };
  return walk(css.replace(/\/\*[\s\S]*?\*\//g, ''));
}
const PAGE_OUT = (() => { try { const a = PAGE.indexOf('<style>') + 7, b = PAGE.indexOf('</style></head><body>');
  return PAGE.slice(0, b) + '\n/* generated dark mode */\n' + darkCss(PAGE.slice(a, b)) + '\n' + DARK_FIX + PAGE.slice(b); } catch (e) { console.error('Dark mode CSS:', e.message); return PAGE; } })();
