'use strict';

// ---------- Config ----------

const REFRESH_MS = 5000;          // public APIs allow ~1 req/s; 5 s is polite
const TRAIL_POINTS = 12;
const STORAGE_KEY = 'plane-radar.settings';
const DEMO = new URLSearchParams(location.search).has('demo');

const DEFAULTS = { label: 'Warszawa (domyślnie)', lat: 52.2297, lon: 21.0122, radiusKm: 15, source: 'adsb.lol' };

// Both services expose the readsb "v2" format: /v2/point/{lat}/{lon}/{radius in NM}
const SOURCES = {
  'adsb.lol': (lat, lon, nm) => `https://api.adsb.lol/v2/point/${lat}/${lon}/${nm}`,
  'airplanes.live': (lat, lon, nm) => `https://api.airplanes.live/v2/point/${lat}/${lon}/${nm}`,
};

// Fallback airline names + IATA codes when the route lookup has nothing.
const AIRLINES = {
  LOT: ['LOT Polish Airlines', 'LO'], RYR: ['Ryanair', 'FR'], WZZ: ['Wizz Air', 'W6'],
  WMT: ['Wizz Air Malta', 'W4'], DLH: ['Lufthansa', 'LH'], KLM: ['KLM', 'KL'],
  AFR: ['Air France', 'AF'], BAW: ['British Airways', 'BA'], UAE: ['Emirates', 'EK'],
  QTR: ['Qatar Airways', 'QR'], THY: ['Turkish Airlines', 'TK'], SAS: ['SAS', 'SK'],
  FIN: ['Finnair', 'AY'], EZY: ['easyJet', 'U2'], ENT: ['Enter Air', 'E4'],
  AUA: ['Austrian', 'OS'], SWR: ['Swiss', 'LX'], BEL: ['Brussels Airlines', 'SN'],
  TAP: ['TAP Air Portugal', 'TP'], IBE: ['Iberia', 'IB'], AEE: ['Aegean', 'A3'],
  ELY: ['El Al', 'LY'], NOZ: ['Norwegian', 'DY'], EWG: ['Eurowings', 'EW'],
  CSA: ['Czech Airlines', 'OK'], ETD: ['Etihad', 'EY'], SXS: ['SunExpress', 'XQ'],
  BTI: ['airBaltic', 'BT'], AZA: ['ITA Airways', 'AZ'], LGL: ['Luxair', 'LG'],
  UPS: ['UPS', '5X'], FDX: ['FedEx', 'FX'], DHK: ['DHL', 'D0'], BCS: ['DHL (EAT)', 'QY'],
};

// ---------- State ----------

const state = {
  settings: loadSettings(),
  aircraft: [],
  trails: new Map(),     // hex -> [[x,y], ...]
  routes: new Map(),     // callsign -> route object | null
  routePending: new Set(),
  selected: null,
  lastOk: 0,
  timer: null,
};

// ---------- Utils ----------

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n, d = 0) => n.toLocaleString('pl-PL', { maximumFractionDigits: d, minimumFractionDigits: d });

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw), saved: true };
  } catch { /* storage unavailable */ }
  return { ...DEFAULTS, saved: false };
}

function saveSettings(s) {
  state.settings = { ...s, saved: true };
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

// Flat-earth projection is fine at radar distances (< 100 km).
function project(lat, lon) {
  const { lat: lat0, lon: lon0 } = state.settings;
  const x = (lon - lon0) * 111.32 * Math.cos(lat0 * Math.PI / 180);
  const y = (lat - lat0) * 110.57;
  return [x, y]; // km east, km north
}

function compass(deg) {
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(((deg % 360) + 360) % 360 / 45) % 8];
}

// Altitude -> colour: low = warm orange, cruise = cool cyan/violet
function altColor(ft) {
  if (ft == null) return '#8a9bb8';
  const t = Math.max(0, Math.min(1, ft / 40000));
  return `hsl(${Math.round(25 + t * 235)} 85% 62%)`;
}

function airlineFromCallsign(cs) {
  const m = /^([A-Z]{3})(\d[0-9A-Z]*)$/.exec(cs || '');
  if (!m) return null;
  const known = AIRLINES[m[1]];
  return { icao: m[1], number: m[2], name: known?.[0] ?? null, iata: known?.[1] ?? null };
}

// ---------- Data ----------

function normalize(ac) {
  if (ac.lat == null || ac.lon == null) return null;
  const callsign = (ac.flight || '').trim();
  const [x, y] = project(ac.lat, ac.lon);
  const distKm = Math.hypot(x, y);
  const onGround = ac.alt_baro === 'ground';
  const altFt = onGround ? 0 : (typeof ac.alt_baro === 'number' ? ac.alt_baro : ac.alt_geom ?? null);
  return {
    hex: ac.hex,
    callsign,
    reg: ac.r || null,
    type: ac.t || null,
    desc: ac.desc || null,
    altFt,
    onGround,
    speedKmh: ac.gs != null ? ac.gs * 1.852 : null,
    track: ac.track ?? ac.true_heading ?? null,
    vsMs: (ac.baro_rate ?? ac.geom_rate) != null ? (ac.baro_rate ?? ac.geom_rate) * 0.00508 : null,
    squawk: ac.squawk || null,
    lat: ac.lat, lon: ac.lon, x, y,
    distKm,
    bearing: (Math.atan2(x, y) * 180 / Math.PI + 360) % 360,
  };
}

async function fetchJSON(url, timeoutMs = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function fetchAircraft() {
  if (DEMO) return demoAircraft();
  const { lat, lon, radiusKm, source } = state.settings;
  const nm = Math.ceil(radiusKm / 1.852);
  const order = [source, ...Object.keys(SOURCES).filter((k) => k !== source)];
  let lastErr;
  for (const key of order) {
    try {
      const data = await fetchJSON(SOURCES[key](lat.toFixed(4), lon.toFixed(4), nm));
      return { list: data.ac || [], source: key };
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

async function lookupRoute(callsign) {
  if (!callsign || state.routes.has(callsign) || state.routePending.has(callsign)) return;
  state.routePending.add(callsign);
  try {
    if (DEMO) { state.routes.set(callsign, DEMO_ROUTES[callsign] ?? null); return; }
    const data = await fetchJSON(`https://api.adsbdb.com/v0/callsign/${encodeURIComponent(callsign)}`);
    const fr = data?.response?.flightroute;
    state.routes.set(callsign, fr ? {
      airline: fr.airline?.name ?? null,
      iata: fr.airline?.iata ?? null,
      flightIata: fr.callsign_iata ?? null,
      from: fr.origin ? { code: fr.origin.iata_code || fr.origin.icao_code, city: fr.origin.municipality } : null,
      to: fr.destination ? { code: fr.destination.iata_code || fr.destination.icao_code, city: fr.destination.municipality } : null,
    } : null);
  } catch {
    // Network hiccup: allow a retry on a later tick.
    return;
  } finally {
    state.routePending.delete(callsign);
  }
  render();
}

async function tick() {
  try {
    const { list, source } = await fetchAircraft();
    const r = state.settings.radiusKm;
    state.aircraft = list.map(normalize).filter((a) => a && a.distKm <= r).sort((a, b) => a.distKm - b.distKm);
    updateTrails();
    state.lastOk = Date.now();
    setStatus('live', DEMO ? 'Tryb demo' : `Na żywo · ${source}`);
    state.aircraft.forEach((a) => lookupRoute(a.callsign));
  } catch (e) {
    setStatus(state.lastOk ? 'warn' : 'err', state.lastOk ? 'Problem z połączeniem – ponawiam…' : 'Brak danych – sprawdź połączenie');
    console.warn('fetch failed', e);
  }
  render();
}

function updateTrails() {
  const seen = new Set();
  for (const a of state.aircraft) {
    seen.add(a.hex);
    const t = state.trails.get(a.hex) || [];
    const last = t[t.length - 1];
    if (!last || last[0] !== a.x || last[1] !== a.y) t.push([a.x, a.y]);
    if (t.length > TRAIL_POINTS) t.shift();
    state.trails.set(a.hex, t);
  }
  for (const hex of state.trails.keys()) if (!seen.has(hex)) state.trails.delete(hex);
}

// ---------- View helpers ----------

function setStatus(kind, text) {
  $('#statusDot').className = `dot ${kind}`;
  $('#statusText').textContent = text;
}

function info(a) {
  const route = state.routes.get(a.callsign) || null;
  const al = airlineFromCallsign(a.callsign);
  return {
    route,
    flightNo: route?.flightIata || a.callsign || a.reg || a.hex.toUpperCase(),
    airline: route?.airline || al?.name || (al ? al.icao : (a.desc || 'Lot prywatny / GA')),
    iata: route?.iata || al?.iata || null,
    badge: al?.icao || (a.type ?? '✈'),
  };
}

function logoHtml(i, a) {
  // Badge is always rendered; the logo image covers it when it loads, and removes itself if it fails.
  const img = i.iata ? `<img alt="" loading="lazy" src="https://pics.avs.io/120/120/${esc(i.iata)}.png" onerror="this.remove()">` : '';
  return `<div class="logo" style="background:${altColor(a.altFt)}">${esc(i.badge)}${img}</div>`;
}

const altText = (a) => a.onGround ? 'na ziemi' : a.altFt == null ? '—' : `${fmt(Math.round(a.altFt * 0.3048 / 10) * 10)} m`;
const flText = (a) => a.onGround || a.altFt == null ? '' : `FL${String(Math.round(a.altFt / 100)).padStart(3, '0')}`;
const speedText = (a) => a.speedKmh == null ? '—' : `${fmt(a.speedKmh)} km/h`;
function vsText(a) {
  if (a.vsMs == null || a.onGround) return { cls: '', txt: '—' };
  if (Math.abs(a.vsMs) < 0.5) return { cls: '', txt: '→ poziom' };
  return a.vsMs > 0 ? { cls: 'vs-up', txt: `↑ ${fmt(a.vsMs, 1)} m/s` } : { cls: 'vs-down', txt: `↓ ${fmt(-a.vsMs, 1)} m/s` };
}

function routeHtml(route) {
  if (!route?.from || !route?.to) return '';
  return `<div class="route">
      <div><div>${esc(route.from.code)}</div><small>${esc(route.from.city)}</small></div>
      <div class="line"></div>
      <div class="to"><div>${esc(route.to.code)}</div><small>${esc(route.to.city)}</small></div>
    </div>`;
}

// ---------- Render ----------

let radarRadius = null;

function renderRadarBase() {
  const R = state.settings.radiusKm;
  const rings = [0.25, 0.5, 0.75, 1].map((f) => {
    const km = R * f;
    return `<circle class="ring" r="${100 * f}"/><text class="ring-label" x="2" y="${-100 * f + 6}">${fmt(km, km < 10 ? 1 : 0)} km</text>`;
  }).join('');
  $('#radar').innerHTML = `
    <defs>
      <radialGradient id="glow"><stop offset="0" stop-color="#38d39f" stop-opacity=".25"/><stop offset="1" stop-color="#38d39f" stop-opacity="0"/></radialGradient>
      <linearGradient id="sweepGrad" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#38d39f" stop-opacity="0"/><stop offset="1" stop-color="#38d39f" stop-opacity=".18"/>
      </linearGradient>
    </defs>
    <path class="sweep" d="M0 0 L100 0 A100 100 0 0 0 70.7 -70.7 Z"/>
    ${rings}
    <line class="axis" x1="-100" y1="0" x2="100" y2="0"/><line class="axis" x1="0" y1="-100" x2="0" y2="100"/>
    <text class="compass" x="0" y="-105">N</text><text class="compass" x="105" y="0">E</text>
    <text class="compass" x="0" y="106">S</text><text class="compass" x="-105" y="0">W</text>
    <circle r="14" fill="url(#glow)"/>
    <circle class="home-pulse" r="4"/>
    <path class="home" d="M0-4.5 4.5-.5H3V4H-3V-.5H-4.5Z"/>
    <g id="planes"></g>`;
  radarRadius = R;
}

function renderRadar() {
  if (radarRadius !== state.settings.radiusKm) renderRadarBase();
  const k = 100 / state.settings.radiusKm;
  $('#planes').innerHTML = state.aircraft.map((a) => {
    const px = a.x * k, py = -a.y * k;
    const color = altColor(a.altFt);
    const trail = (state.trails.get(a.hex) || []).map(([x, y]) => `${(x * k).toFixed(1)},${(-y * k).toFixed(1)}`).join(' ');
    const sel = state.selected === a.hex ? ' selected' : '';
    return `<polyline class="trail" stroke="${color}" points="${trail}"/>
      <g class="plane${sel}" data-hex="${esc(a.hex)}" transform="translate(${px.toFixed(1)} ${py.toFixed(1)})">
        <circle r="9" fill="transparent"/>
        <path fill="${color}" transform="rotate(${a.track ?? 0}) scale(.55)"
          d="M0-12 1.6-8 1.6-3 11 3 11 5.5 1.6 3 1.6 8.5 4.5 11 4.5 12.8 0 11.6-4.5 12.8-4.5 11-1.6 8.5-1.6 3-11 5.5-11 3-1.6-3-1.6-8Z"/>
        <text x="7" y="-5">${esc(a.callsign || a.reg || '')}</text>
      </g>`;
  }).join('');
}

function cardHtml(a) {
  const i = info(a);
  const vs = vsText(a);
  return `<li class="card${state.selected === a.hex ? ' selected' : ''}" data-hex="${esc(a.hex)}">
    <div class="card-top">
      ${logoHtml(i, a)}
      <div class="ident">
        <div class="flightno">${esc(i.flightNo)}</div>
        <div class="airline">${esc(i.airline)}${a.type ? ' · ' + esc(a.type) : ''}</div>
      </div>
      <div class="dist"><b>${fmt(a.distKm, 1)} km</b><span>${compass(a.bearing)} od domu</span></div>
    </div>
    ${routeHtml(i.route)}
    <div class="stats">
      <div class="stat"><span>Wysokość</span><b style="color:${altColor(a.altFt)}">${altText(a)}</b></div>
      <div class="stat"><span>Prędkość</span><b>${speedText(a)}</b></div>
      <div class="stat"><span>Pionowo</span><b class="${vs.cls}">${vs.txt}</b></div>
    </div>
  </li>`;
}

function renderList() {
  $('#count').textContent = state.aircraft.length;
  $('#list').innerHTML = state.aircraft.map(cardHtml).join('');
  $('#empty').hidden = state.aircraft.length > 0 || !state.lastOk;
}

function renderSheet() {
  const a = state.aircraft.find((x) => x.hex === state.selected);
  const sheet = $('#sheet');
  if (!a) { closeSheet(); return; }
  const i = info(a);
  const vs = vsText(a);
  const fr24 = `https://www.flightradar24.com/${encodeURIComponent(a.callsign || '')}`;
  const adsbx = `https://globe.adsbexchange.com/?icao=${encodeURIComponent(a.hex)}`;
  $('#sheetBody').innerHTML = `
    <div class="card-top">
      ${logoHtml(i, a)}
      <div class="ident">
        <div class="flightno" style="font-size:22px">${esc(i.flightNo)}</div>
        <div class="airline">${esc(i.airline)}</div>
      </div>
      <div class="dist"><b>${fmt(a.distKm, 1)} km</b><span>${compass(a.bearing)} od domu</span></div>
    </div>
    ${routeHtml(i.route)}
    <div class="stats">
      <div class="stat"><span>Wysokość</span><b style="color:${altColor(a.altFt)}">${altText(a)}</b> <small class="muted">${flText(a)}</small></div>
      <div class="stat"><span>Prędkość</span><b>${speedText(a)}</b></div>
      <div class="stat"><span>Prędkość pionowa</span><b class="${vs.cls}">${vs.txt}</b></div>
      <div class="stat"><span>Kurs</span><b>${a.track != null ? `${Math.round(a.track)}° ${compass(a.track)}` : '—'}</b></div>
      <div class="stat"><span>Samolot</span><b>${esc(a.desc || a.type || '—')}</b></div>
      <div class="stat"><span>Rejestracja</span><b>${esc(a.reg || '—')}</b></div>
      <div class="stat"><span>Znak wywoławczy</span><b>${esc(a.callsign || '—')}</b></div>
      <div class="stat"><span>Squawk / ICAO</span><b>${esc(a.squawk || '—')} · ${esc(a.hex.toUpperCase())}</b></div>
    </div>
    <div class="links">
      ${a.callsign ? `<a class="btn" href="${fr24}" target="_blank" rel="noopener">Flightradar24 ↗</a>` : ''}
      <a class="btn" href="${adsbx}" target="_blank" rel="noopener">ADS-B Exchange ↗</a>
      <button class="btn ghost" id="closeSheet">Zamknij</button>
    </div>`;
  sheet.classList.add('open');
  sheet.setAttribute('aria-hidden', 'false');
  $('#sheetBackdrop').hidden = false;
}

function render() {
  const s = state.settings;
  $('#place').textContent = `${s.label || 'Mój dom'} · ${s.lat.toFixed(3)}, ${s.lon.toFixed(3)}`;
  $('#radiusLabel').textContent = `promień ${s.radiusKm} km`;
  renderRadar();
  renderList();
  if (state.selected) renderSheet();
}

// ---------- Interaction ----------

function select(hex) {
  state.selected = hex;
  render();
}

function closeSheet() {
  state.selected = null;
  $('#sheet').classList.remove('open');
  $('#sheet').setAttribute('aria-hidden', 'true');
  $('#sheetBackdrop').hidden = true;
  renderRadar();
  document.querySelectorAll('.card.selected').forEach((c) => c.classList.remove('selected'));
}

function openSettings() {
  const f = $('#settingsForm');
  const s = state.settings;
  f.label.value = s.label || '';
  f.lat.value = s.lat;
  f.lon.value = s.lon;
  f.radiusKm.value = s.radiusKm;
  f.source.value = s.source;
  $('#radiusOut').textContent = s.radiusKm;
  $('#settings').showModal();
}

function bind() {
  document.addEventListener('click', (e) => {
    if (e.target.closest('#closeSheet')) return closeSheet();
    const el = e.target.closest('[data-hex]');
    if (el && !e.target.closest('#sheet')) select(el.dataset.hex);
  });
  $('#sheetBackdrop').addEventListener('click', closeSheet);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });
  $('#settingsBtn').addEventListener('click', openSettings);

  const f = $('#settingsForm');
  f.radiusKm.addEventListener('input', () => { $('#radiusOut').textContent = f.radiusKm.value; });
  $('#geoBtn').addEventListener('click', () => {
    if (!navigator.geolocation) return alert('Ta przeglądarka nie udostępnia lokalizacji.');
    $('#geoBtn').textContent = 'Ustalanie lokalizacji…';
    navigator.geolocation.getCurrentPosition(
      (p) => {
        f.lat.value = p.coords.latitude.toFixed(5);
        f.lon.value = p.coords.longitude.toFixed(5);
        if (!f.label.value || f.label.value === DEFAULTS.label) f.label.value = 'Mój dom';
        $('#geoBtn').textContent = '📍 Lokalizacja ustawiona';
      },
      () => { $('#geoBtn').textContent = '📍 Nie udało się – wpisz ręcznie'; },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  });
  $('#settings').addEventListener('close', () => {
    if ($('#settings').returnValue !== 'save') return;
    saveSettings({
      label: f.label.value.trim(),
      lat: parseFloat(f.lat.value),
      lon: parseFloat(f.lon.value),
      radiusKm: parseInt(f.radiusKm.value, 10),
      source: f.source.value,
    });
    state.trails.clear();
    restart();
  });

  // Pause polling while the app is in the background to save battery and API quota.
  document.addEventListener('visibilitychange', () => document.hidden ? stop() : restart());
}

function stop() { clearInterval(state.timer); state.timer = null; }
function restart() { stop(); tick(); state.timer = setInterval(tick, REFRESH_MS); }

// ---------- Demo data (?demo) ----------

const DEMO_FLEET = [
  { hex: '48af01', flight: 'LOT3KM', r: 'SP-LWA', t: 'E195', desc: 'Embraer 195', alt: 6200, gs: 330, vs: 1800, r0: 0.55, w: 0.020, ph: 0.3 },
  { hex: '4b1814', flight: 'RYR82TW', r: 'SP-RZB', t: 'B38M', desc: 'Boeing 737 MAX 8', alt: 36000, gs: 455, vs: 0, r0: 0.85, w: -0.012, ph: 2.1 },
  { hex: '471f5b', flight: 'WZZ1563', r: 'HA-LVK', t: 'A21N', desc: 'Airbus A321neo', alt: 24500, gs: 410, vs: -1400, r0: 0.35, w: 0.016, ph: 4.0 },
  { hex: '3c6752', flight: 'DLH1617', r: 'D-AINP', t: 'A20N', desc: 'Airbus A320neo', alt: 38000, gs: 470, vs: 0, r0: 0.7, w: 0.010, ph: 5.2 },
  { hex: '896177', flight: 'UAE180', r: 'A6-EVK', t: 'A388', desc: 'Airbus A380-800', alt: 3100, gs: 165, vs: -900, r0: 0.25, w: -0.025, ph: 1.2 },
  { hex: '48c2a4', flight: '', r: 'SP-KCX', t: 'C172', desc: 'Cessna 172', alt: 1500, gs: 95, vs: 200, r0: 0.45, w: 0.035, ph: 3.3 },
];
const DEMO_ROUTES = {
  LOT3KM: { airline: 'LOT Polish Airlines', iata: 'LO', flightIata: 'LO3', from: { code: 'WAW', city: 'Warszawa' }, to: { code: 'GDN', city: 'Gdańsk' } },
  RYR82TW: { airline: 'Ryanair', iata: 'FR', flightIata: 'FR2781', from: { code: 'WMI', city: 'Modlin' }, to: { code: 'BGY', city: 'Bergamo' } },
  WZZ1563: { airline: 'Wizz Air', iata: 'W6', flightIata: 'W61563', from: { code: 'LTN', city: 'Londyn' }, to: { code: 'WAW', city: 'Warszawa' } },
  DLH1617: { airline: 'Lufthansa', iata: 'LH', flightIata: 'LH1617', from: { code: 'FRA', city: 'Frankfurt' }, to: { code: 'RIX', city: 'Ryga' } },
  UAE180: { airline: 'Emirates', iata: 'EK', flightIata: 'EK179', from: { code: 'DXB', city: 'Dubaj' }, to: { code: 'WAW', city: 'Warszawa' } },
};

function demoAircraft() {
  const { lat, lon, radiusKm } = state.settings;
  const t = Date.now() / 1000;
  const list = DEMO_FLEET.map((p) => {
    const ang = p.ph + p.w * t;
    const rKm = p.r0 * radiusKm;
    const x = Math.cos(ang) * rKm, y = Math.sin(ang) * rKm;
    // tangent direction of circular motion -> compass track
    const track = (Math.atan2(-Math.sin(ang) * Math.sign(p.w), Math.cos(ang) * Math.sign(p.w)) * 180 / Math.PI + 360) % 360;
    return {
      hex: p.hex, flight: p.flight, r: p.r, t: p.t, desc: p.desc,
      alt_baro: p.alt, gs: p.gs, baro_rate: p.vs, track, squawk: '2000',
      lat: lat + y / 110.57,
      lon: lon + x / (111.32 * Math.cos(lat * Math.PI / 180)),
    };
  });
  return Promise.resolve({ list, source: 'demo' });
}

// ---------- Boot ----------

bind();
restart();
if (!state.settings.saved && !DEMO) openSettings();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
