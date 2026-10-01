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

async function azuga(path, body = {}) {
  const r = await fetch(API + path, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + (await getToken()), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (r.status === 401) token = null; // force re-login next time
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

const routes = {
  '/api/vehicles': () => azuga('/trackees.json?limit=100&offset=0'),
  '/api/locations': () => azuga('/vehicles/latestlocation', {}),
  '/api/maintenance': () => azuga('/maintanance/reports/scheduledreport.json?' + new URLSearchParams({
    startTime: fmt(daysAgo(365)), endTime: fmt(daysAgo(-365)), isCount: 'false',
  })),
  '/api/videos': q => azuga('/eventVideos.json?videoType=eventVideo', {
    startTime: fmt(daysAgo(7)), endTime: fmt(new Date()), page: 1, limit: 25,
    vehiclesIds: q.get('vehicleId') || '',
  }),
};

if (process.argv[2] === 'test') {
  const s = fmt(new Date(2026, 0, 5, 13, 7, 9));
  if (s !== '2026-01-05 01:07:09 PM') throw new Error('fmt broken: ' + s);
  if (fmt(new Date(2026, 0, 5, 0, 0, 0)) !== '2026-01-05 12:00:00 AM') throw new Error('fmt midnight broken');
  console.log('ok');
  process.exit(0);
}

const { DASHBOARD_PASSWORD } = process.env;
http.createServer(async (req, res) => {
  // Browser's built-in login box. Any username works; password must match.
  const given = Buffer.from((req.headers.authorization || '').split(' ')[1] || '', 'base64').toString().split(':').slice(1).join(':');
  if (!DASHBOARD_PASSWORD || given !== DASHBOARD_PASSWORD) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Fleet Dashboard"' });
    return res.end(DASHBOARD_PASSWORD ? 'Login required' : 'Set DASHBOARD_PASSWORD to use this dashboard');
  }
  const url = new URL(req.url, 'http://x');
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

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fleet Dashboard</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
body{margin:0;font-family:system-ui,sans-serif;background:#f4f6f8;color:#1a2230}
header{background:#123a6b;color:#fff;padding:14px 20px;display:flex;gap:16px;align-items:center;flex-wrap:wrap}
header h1{font-size:18px;margin:0}header small{opacity:.8}
input{padding:8px 10px;border:1px solid #ccd;border-radius:6px;font-size:14px;flex:1;min-width:180px;max-width:360px}
main{display:grid;grid-template-columns:340px 1fr;gap:12px;padding:12px;height:calc(100vh - 70px);box-sizing:border-box}
#list{overflow:auto;display:flex;flex-direction:column;gap:8px}
.card{background:#fff;border-radius:8px;padding:10px 12px;cursor:pointer;border:2px solid transparent}
.card.sel{border-color:#123a6b}.card b{display:block}.card span{font-size:13px;color:#556}
#right{display:grid;grid-template-rows:55% 45%;gap:12px;min-height:0}
#map{border-radius:8px}#detail{background:#fff;border-radius:8px;padding:12px;overflow:auto;font-size:14px}
.warn{color:#a15c00}.bad{color:#b00020}#err{background:#fde8e8;color:#b00020;padding:8px 20px;display:none;white-space:pre-wrap;font-size:13px}
details pre{font-size:11px;background:#f4f6f8;padding:8px;overflow:auto}
@media(max-width:800px){main{grid-template-columns:1fr;height:auto}#list{max-height:40vh}#right{grid-template-rows:350px auto}}
</style></head><body>
<header><h1>Fleet Dashboard</h1><input id="q" placeholder="Search vehicle or driver..."><small id="upd"></small></header>
<div id="err"></div>
<main><div id="list">Loading...</div><div id="right"><div id="map"></div><div id="detail">Click a vehicle or driver to see maintenance and recent camera footage.</div></div></main>
<script>
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>'&#'+c.charCodeAt(0)+';');
// Azuga wraps lists differently per endpoint; grab the first array we find
const list=x=>Array.isArray(x)?x:x&&typeof x==='object'?(Object.values(x).map(list).find(a=>a.length)||[]):[];
const pick=(o,...k)=>{for(const key of k)if(o&&o[key]!=null&&o[key]!=='')return o[key]};
const vid=v=>pick(v,'trackeeId','vehicleId','id');
const vname=v=>pick(v,'trackeeName','vehicleName','name')||'Vehicle';
const dname=v=>pick(v,'driverName','userName','driverFullName')||[v.driverFirstName,v.driverLastName].filter(Boolean).join(' ')||'No driver';
const links=o=>JSON.stringify(o).match(/https?:[^"\\\\]+/g)||[];
let vehicles=[],locs=[],maint=[],sel=null,markers={};
const map=L.map('map').setView([40.7,-74],9);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'&copy; OpenStreetMap'}).addTo(map);

async function get(p){const r=await fetch(p);const j=await r.json();if(j.error)throw new Error(j.error);return j}
function showErr(e){$('err').style.display=e?'block':'none';$('err').textContent=e?'Problem talking to Azuga: '+e.message:''}

async function refresh(){
  try{
    const [v,l]=await Promise.all([vehicles.length?null:get('/api/vehicles'),get('/api/locations')]);
    if(v)vehicles=list(v);locs=list(l);showErr();
    $('upd').textContent='Live, updated '+new Date().toLocaleTimeString();
    render();
  }catch(e){showErr(e)}
}
function rows(){
  // merge vehicle info with its latest location
  const byId={};vehicles.forEach(v=>byId[vid(v)]=v);
  const all=locs.length?locs.map(l=>({...byId[vid(l)],...l})):vehicles;
  const q=$('q').value.toLowerCase();
  return all.filter(r=>!q||(vname(r)+' '+dname(r)).toLowerCase().includes(q));
}
function render(){
  const rs=rows();
  $('list').innerHTML=rs.length?rs.map(r=>'<div class="card'+(sel==vid(r)?' sel':'')+'" data-id="'+esc(vid(r))+'"><b>'+esc(vname(r))+'</b><span>Driver: '+esc(dname(r))+'</span><br><span>'+esc(pick(r,'address','landmark')||'')+'</span><br><span>Speed: '+esc(pick(r,'speed')??'?')+' &middot; Odometer: '+esc(pick(r,'odometer','currentOdometer')??'?')+'</span></div>').join(''):'No vehicles found.';
  document.querySelectorAll('.card').forEach(c=>c.onclick=()=>select(c.dataset.id));
  rs.forEach(r=>{const lat=+pick(r,'latitude','lat'),lng=+pick(r,'longitude','lng','lon');if(!lat||!lng)return;
    const id=vid(r);(markers[id]||(markers[id]=L.marker([lat,lng]).addTo(map).on('click',()=>select(id)))).setLatLng([lat,lng]).bindPopup(esc(vname(r))+'<br>'+esc(dname(r)));});
}
async function select(id){
  sel=id;render();const r=rows().find(x=>vid(x)==id)||{};
  if(markers[id])map.setView(markers[id].getLatLng(),13);
  $('detail').innerHTML='<h3>'+esc(vname(r))+' <small>('+esc(dname(r))+')</small></h3><div id="m">Loading maintenance...</div><h4>Camera events, last 7 days</h4><div id="vids">Loading footage...</div><details><summary>All Azuga data for this vehicle</summary><pre>'+esc(JSON.stringify(r,null,2))+'</pre></details>';
  try{if(!maint.length)maint=list(await get('/api/maintenance'));
    const m=maint.filter(x=>vid(x)==id||vname(x)==vname(r));
    $('m').innerHTML='<h4>Maintenance</h4>'+(m.length?m.map(x=>{const due=String(pick(x,'status','reminderStatus')||'');return '<div class="'+(/over/i.test(due)?'bad':/up/i.test(due)?'warn':'')+'">'+esc(pick(x,'serviceType','serviceName')||'Service')+': '+esc(due)+' '+esc(pick(x,'nextServiceDate','dueDate')||'')+' '+esc(pick(x,'nextServiceOdometer')?'at '+pick(x,'nextServiceOdometer')+' mi':'')+'</div>'}).join(''):'No maintenance scheduled.');
  }catch(e){$('m').textContent='Maintenance unavailable: '+e.message}
  try{const v=list(await get('/api/videos?vehicleId='+encodeURIComponent(id)));
    $('vids').innerHTML=v.length?v.map(x=>'<div><b>'+esc(pick(x,'eventType','eventName')||'Event')+'</b> '+esc(pick(x,'eventTime','startTime')||'')+' '+esc(pick(x,'driverName')||'')+'<br>'+links(x).filter(u=>!/thumb/i.test(u)).map((u,i)=>'<a target="_blank" rel="noopener" href="'+esc(u)+'">Video '+(i+1)+'</a>').join(' ')+'</div>').join('<hr>'):'No camera events.';
  }catch(e){$('vids').textContent='Footage unavailable: '+e.message}
}
$('q').oninput=render;
refresh();setInterval(refresh,30000);
</script></body></html>`;
