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

async function azuga(path, body = {}, method = 'POST') {
  const r = await fetch(API + path, {
    method,
    headers: { Authorization: 'Bearer ' + (await getToken()), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (r.status === 401) token = null; // force re-login next time
  if (r.status === 429) throw new Error('Azuga is limiting requests right now. Retrying shortly.');
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
async function updateVehicle(b) {
  const id = String(b.trackeeId || '');
  const cur = list(await azuga('/trackees.json?limit=100&offset=0')).find(v => v.trackeeId === id);
  if (!cur) throw new Error('Vehicle not found in Azuga.');
  const body = { ...cur }, changed = [];
  if (b.name !== undefined) {
    const n = String(b.name).trim();
    if (!n || n.length > 100) throw new Error('Name must be 1-100 characters.');
    body.name = n; changed.push('name');
  }
  if (b.licensePlateNo !== undefined) {
    const v = String(b.licensePlateNo).trim().toUpperCase();
    if (!/^[A-Z0-9 -]{0,20}$/.test(v)) throw new Error('Plate can only use letters, numbers, spaces and dashes.');
    body.licensePlateNo = v; changed.push('plate');
  }
  if (b.vin !== undefined) {
    const v = String(b.vin).trim().toUpperCase();
    if (v && !/^[A-HJ-NPR-Z0-9]{17}$/.test(v)) throw new Error('VIN must be 17 letters/numbers (no I, O or Q).');
    body.vin = v; changed.push('VIN');
  }
  if (b.odometer !== undefined) {
    const o = Number(b.odometer);
    if (!Number.isInteger(o) || o < 0 || o > 2000000) throw new Error('Odometer must be a whole number of miles.');
    body.odometerReading = o; body.currentOdometerReading = o; changed.push('odometer=' + o);
  }
  if (!changed.length) throw new Error('Nothing to change.');
  const r = await azuga('/trackees/' + encodeURIComponent(id) + '.json', body, 'PUT');
  if (r && r.error) throw new Error('Azuga rejected the change: ' + JSON.stringify(r.error).slice(0, 200));
  cache.delete('vehicles'); cache.delete('locations');
  console.log(new Date().toISOString(), 'Updated', cur.name, '->', changed.join(', '));
  return { ok: true, changed };
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
  if (url.pathname === '/api/update') {
    // JSON-only + POST-only, so another website can't trigger a change with a plain form
    if (req.method !== 'POST' || !/application\/json/.test(req.headers['content-type'] || '')) { res.writeHead(405); return res.end(); }
    try {
      const out = await updateVehicle(await readJson(req));
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
:root{--bg:#eef2f6;--card:#fff;--ink:#0f1b2d;--muted:#64748b;--line:#e2e8f0;--navy:#0b2545;--accent:#0ea5b7;--go:#16a34a;--goBg:#dcfce7;--idle:#64748b;--idleBg:#f1f5f9;--warn:#b45309;--warnBg:#fef3c7;--bad:#b91c1c;--badBg:#fee2e2;--r:14px}
*{box-sizing:border-box}
body{margin:0;font-family:Inter,system-ui,sans-serif;background:var(--bg);color:var(--ink);font-size:14px}
header{background:linear-gradient(90deg,var(--navy),#13406e);color:#fff;padding:14px 24px;display:flex;align-items:center;gap:20px;flex-wrap:wrap}
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
#vEdit{padding:16px 24px 24px}
.panel{background:var(--card);border-radius:var(--r);box-shadow:0 1px 2px rgba(15,27,45,.06);overflow:auto}
.panel .intro{padding:16px 20px;border-bottom:1px solid var(--line);color:var(--muted)}.panel .intro b{color:var(--ink)}
table{width:100%;border-collapse:collapse}th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);padding:10px 12px;border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:8px 12px;border-bottom:1px solid var(--line);vertical-align:top}
td input{font:inherit;width:100%;min-width:110px;padding:7px 9px;border:1px solid var(--line);border-radius:8px;background:#fff}
td input:focus{outline:2px solid var(--accent);border-color:transparent}td input.dirty{background:#fffbeb;border-color:#f59e0b}
.save{font:inherit;font-weight:600;font-size:13px;color:#fff;background:var(--navy);border:0;padding:8px 14px;border-radius:8px;cursor:pointer}.save:disabled{opacity:.5;cursor:default}
.msg{font-size:12px;margin-top:4px;max-width:220px}.msg.ok{color:var(--go)}.msg.bad{color:var(--bad)}
#err{background:var(--badBg);color:var(--bad);padding:10px 24px;display:none;font-size:13px}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;padding:16px 24px 0}
.stat{background:var(--card);border-radius:var(--r);padding:14px 16px;box-shadow:0 1px 2px rgba(15,27,45,.06)}
.stat b{display:block;font-size:24px;font-weight:700}.stat span{color:var(--muted);font-size:12px;font-weight:500;text-transform:uppercase;letter-spacing:.04em}
main{display:grid;grid-template-columns:360px 1fr;gap:16px;padding:16px 24px 24px;height:calc(100vh - 170px);min-height:560px}
#list{overflow:auto;display:flex;flex-direction:column;gap:8px;padding-right:4px}
.card{background:var(--card);border-radius:var(--r);padding:12px 14px;cursor:pointer;border:2px solid transparent;display:flex;gap:12px;box-shadow:0 1px 2px rgba(15,27,45,.06);transition:border-color .15s,transform .15s}
.card:hover{transform:translateY(-1px);border-color:var(--line)}.card.sel{border-color:var(--accent)}
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
.kv{background:var(--bg);border-radius:10px;padding:10px 12px}.kv span{display:block;color:var(--muted);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em}.kv b{font-weight:600;font-size:14px}
h3{font-size:13px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:18px 0 8px}
.ev{display:flex;align-items:center;gap:12px;padding:10px 0;border-top:1px solid var(--line);flex-wrap:wrap}
.ev .t{color:var(--muted);font-size:12px;min-width:150px}.ev .clips{margin-left:auto;display:flex;gap:6px}
.btn{font:inherit;font-size:12px;font-weight:600;color:var(--navy);background:#e0f2f5;padding:5px 10px;border-radius:8px;text-decoration:none}.btn:hover{background:#c7eaf0}
.muted{color:var(--muted)}
details{margin-top:18px}summary{cursor:pointer;color:var(--muted);font-size:12px}details pre{font-size:11px;background:var(--bg);padding:10px;border-radius:8px;overflow:auto;max-height:260px}
@media(max-width:900px){.stats{grid-template-columns:repeat(2,1fr);padding:12px 16px 0}main{grid-template-columns:1fr;height:auto;padding:12px 16px}#list{max-height:45vh}#right{grid-template-rows:340px auto}.grid{grid-template-columns:repeat(2,1fr)}header{padding:12px 16px}.live{margin-left:auto}.search{flex-basis:100%;max-width:none;order:3}}
</style></head><body>
<header>
 <div class="brand"><div class="logo">MP</div><div>Fleet Dashboard<small>Millennial Pools</small></div></div>
 <div class="search"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input id="q" placeholder="Search vehicle or driver"></div>
 <div class="live"><span class="dot"></span><span id="upd">Connecting...</span></div>
<nav class="tabs"><button data-v="vMap" class="on">Live map</button><button data-v="vEdit">Edit vehicles</button></nav>
</header>
<div id="err"></div>
<div id="vMap"><section class="stats">
 <div class="stat"><span>Vehicles</span><b id="sTotal">–</b></div>
 <div class="stat"><span>Moving now</span><b id="sMoving" style="color:var(--go)">–</b></div>
 <div class="stat"><span>Parked</span><b id="sParked">–</b></div>
 <div class="stat"><span>No driver assigned</span><b id="sNoDriver" style="color:var(--warn)">–</b></div>
</section>
<main><div id="list"><div class="empty">Loading vehicles...</div></div>
<div id="right"><div id="map"></div><div id="detail"><div class="empty">Select a vehicle to see its driver, maintenance and camera footage.</div></div></div></main></div>
<div id="vEdit" hidden><div class="panel"><div class="intro"><b>Edit vehicle details.</b> Changes are sent straight to Azuga. Edited boxes turn yellow; click Save on that row to send them. Leave odometer blank to keep the current reading.</div>
<table><thead><tr><th>Vehicle name</th><th>Driver</th><th>License plate</th><th>VIN</th><th>Odometer (miles)</th><th></th></tr></thead><tbody id="editRows"><tr><td colspan="6" class="muted">Loading...</td></tr></tbody></table></div></div>
<script>
const $=id=>document.getElementById(id);
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
function rows(){
  const q=$('q').value.toLowerCase();
  return all().filter(r=>!q||(vname(r)+' '+dname(r)).toLowerCase().includes(q))
    .sort((a,b)=>moving(b)-moving(a)||vname(a).localeCompare(vname(b)));
}
function render(){
  const a=all(),rs=rows();
  $('sTotal').textContent=a.length;$('sMoving').textContent=a.filter(moving).length;
  $('sParked').textContent=a.filter(r=>!moving(r)).length;$('sNoDriver').textContent=a.filter(r=>!/[a-z]/i.test(dname(r))).length;
  $('list').innerHTML=rs.length?rs.map(r=>{const d=dname(r),named=/[a-z]/i.test(d);return '<div class="card'+(sel==vid(r)?' sel':'')+'" data-id="'+esc(vid(r))+'"><div class="av'+(named?'':' none')+'">'+esc(initials(d))+'</div><div class="ci"><div class="top"><b>'+esc(vname(r))+'</b>'+status(r)+'</div><div class="d">'+(named?esc(d):'<span class="muted">No driver name'+(d?' · '+esc(d):'')+'</span>')+'</div><div class="a">'+esc(pick(r,'address','landmark')||'Location unavailable')+'</div></div></div>'}).join(''):'<div class="empty">No vehicles match your search.</div>';
  document.querySelectorAll('.card').forEach(c=>c.onclick=()=>select(c.dataset.id));
  const pts=[];
  rs.forEach(r=>{const lat=+pick(r,'latitude','lat'),lng=+pick(r,'longitude','lng','lon');if(!lat||!lng)return;pts.push([lat,lng]);
    const id=vid(r),isSel=sel==id,c=moving(r)?'#16a34a':'#0b2545';
    const m=markers[id]||(markers[id]=L.circleMarker([lat,lng]).addTo(map).on('click',()=>select(id)));
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
   +'<div class="muted">📍 '+esc(pick(r,'address','landmark')||'Location unavailable')+'</div>'
   +'<h3>Maintenance</h3><div id="m" class="muted">Loading...</div><h3>Camera events · last 7 days</h3><div id="vids" class="muted">Loading...</div>'
   +'<details><summary>All Azuga data for this vehicle</summary><pre>'+esc(JSON.stringify(r,null,2))+'</pre></details>';
  try{if(!maint.length)maint=list(await get('/api/maintenance'));
    const m=maint.filter(x=>vid(x)==id||vname(x)==vname(r));
    $('m').innerHTML=m.length?m.map(x=>{const s=String(pick(x,'status','reminderStatus')||'');return '<div class="ev"><span class="pill '+(/over/i.test(s)?'bad':/up/i.test(s)?'warn':'idle')+'">'+esc(s||'Scheduled')+'</span><b>'+esc(pick(x,'serviceType','serviceName')||'Service')+'</b><span class="t">'+esc(when(pick(x,'nextServiceDate','dueDate')))+(pick(x,'nextServiceOdometer')?' · at '+esc(pick(x,'nextServiceOdometer'))+' mi':'')+'</span></div>'}).join(''):(r.maintenanceEnabled===false?'Maintenance tracking is turned off for this vehicle in Azuga.':'No maintenance scheduled.');
  }catch(e){$('m').textContent=e.message;retry(id)}
  try{const v=list(await get('/api/videos?vehicleId='+encodeURIComponent(id)));
    $('vids').innerHTML=v.length?v.map(x=>{const e=pick(x,'eventType','eventName');const clips=links(x).filter(u=>!/thumb/i.test(u));return '<div class="ev"><span class="pill '+evClass(e)+'">'+esc(evName(e))+'</span><span class="t">'+esc(when(pick(x,'eventTime','startTime')))+'</span><span class="muted">'+esc(pick(x,'driverName')||'')+'</span><span class="clips">'+clips.map((u,i)=>'<a class="btn" target="_blank" rel="noopener" href="'+esc(u)+'">▶ Clip '+(i+1)+'</a>').join('')+'</span></div>'}).join(''):'No camera events in the last 7 days.';
  }catch(e){$('vids').textContent=e.message;retry(id)}
}
const retried=new Set();function retry(id){if(retried.has(id))return;retried.add(id);setTimeout(()=>{if(sel==id)select(id)},30000)}
function renderEdit(){
  const q=$('q').value.toLowerCase();
  const vs=vehicles.filter(v=>!q||(vname(v)+' '+dname(v)).toLowerCase().includes(q)).sort((a,b)=>vname(a).localeCompare(vname(b)));
  $('editRows').innerHTML=vs.length?vs.map(v=>'<tr data-id="'+esc(vid(v))+'" data-name="'+esc(vname(v))+'"><td><input name="name" value="'+esc(vname(v))+'" maxlength="100"></td><td class="muted">'+esc(dname(v)||'No driver')+'</td><td><input name="licensePlateNo" value="'+esc(pick(v,'licensePlateNo','licensePlate')||'')+'" maxlength="20"></td><td><input name="vin" value="'+esc(v.vin||'')+'" maxlength="17"></td><td><input name="odometer" type="number" min="0" step="1" placeholder="'+esc(odo(v))+'"></td><td><button class="save">Save</button><div class="msg"></div></td></tr>').join(''):'<tr><td colspan="6" class="muted">No vehicles match your search.</td></tr>';
}
$('editRows').addEventListener('input',e=>{if(e.target.tagName==='INPUT')e.target.classList.toggle('dirty',e.target.value!==e.target.defaultValue)});
$('editRows').addEventListener('click',async e=>{
  if(!e.target.classList.contains('save'))return;
  const tr=e.target.closest('tr'),msg=tr.querySelector('.msg'),body={trackeeId:tr.dataset.id},lines=[];
  tr.querySelectorAll('input').forEach(i=>{if(i.value!==i.defaultValue){body[i.name]=i.name==='odometer'?Number(i.value):i.value;lines.push(i.closest('table').querySelectorAll('th')[i.closest('td').cellIndex].textContent+': '+i.value)}});
  if(!lines.length){msg.className='msg';msg.textContent='Nothing changed.';return}
  if(!confirm('Update '+tr.dataset.name+' in Azuga?\\n\\n'+lines.join('\\n')))return;
  e.target.disabled=true;msg.className='msg';msg.textContent='Saving to Azuga...';
  try{const r=await fetch('/api/update',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const j=await r.json();if(j.error)throw new Error(j.error);
    tr.querySelectorAll('input').forEach(i=>{if(i.name!=='odometer')i.defaultValue=i.value;else i.value='';i.classList.remove('dirty')});
    msg.className='msg ok';msg.textContent='Saved to Azuga ✓';vehicles=[];refresh();
  }catch(err){msg.className='msg bad';msg.textContent=err.message}
  e.target.disabled=false;
});
document.querySelectorAll('.tabs button').forEach(b=>b.onclick=()=>{
  document.querySelectorAll('.tabs button').forEach(x=>x.classList.toggle('on',x===b));
  $('vMap').hidden=b.dataset.v!=='vMap';$('vEdit').hidden=b.dataset.v!=='vEdit';
  if(b.dataset.v==='vEdit')renderEdit();else map.invalidateSize();
});
$('q').oninput=()=>{render();if(!$('vEdit').hidden)renderEdit()};
refresh();setInterval(refresh,30000);
</script></body></html>`;
