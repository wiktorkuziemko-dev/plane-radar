// Cloudflare Worker: CORS proxy for Plane Radar.
//
// adsb.fi, adsb.lol, airplanes.live and adsbdb.com don't send CORS headers, so a web page can't call them
// directly. This Worker forwards a small, fixed set of read-only requests and adds the headers.
//
//   GET /{source}/v2/point/{lat}/{lon}/{radiusNm}  -> aircraft around a point, source = adsb.fi | adsb.lol | airplanes.live
//   GET /route/{callsign}                          -> https://api.adsbdb.com/v0/callsign/...
//   GET /diag                                      -> tries every source once and reports which ones answer

// Which pages may use this proxy is configured outside the code, in the Worker's
// Settings → Variables: ALLOWED_ORIGINS = comma-separated origins, e.g. "https://login.github.io".
// If the variable is not set, any page may use the proxy (still limited to the routes above).

const UPSTREAMS = {
  'adsb.fi': (lat, lon, nm) => `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${nm}`,
  'adsb.lol': (lat, lon, nm) => `https://api.adsb.lol/v2/point/${lat}/${lon}/${nm}`,
  'airplanes.live': (lat, lon, nm) => `https://api.airplanes.live/v2/point/${lat}/${lon}/${nm}`,
};

const POINT = /^\/(adsb\.fi|adsb\.lol|airplanes\.live)\/v2\/point\/(-?\d{1,2}(?:\.\d{1,6})?)\/(-?\d{1,3}(?:\.\d{1,6})?)\/(\d{1,3})$/;
const ROUTE = /^\/route\/([A-Za-z0-9]{2,8})$/;

export default {
  async fetch(request, env) {
    const allowedOrigins = (env.ALLOWED_ORIGINS || '').split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean);
    const origin = request.headers.get('Origin') || '';
    const allowed = allowedOrigins.length === 0 || allowedOrigins.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': allowedOrigins.length === 0 ? '*' : (allowed ? origin : allowedOrigins[0]),
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405, cors);
    // Browsers always send Origin on cross-origin fetches; refuse other websites.
    if (origin && !allowed) return json({ error: 'origin not allowed' }, 403, cors);

    const { pathname } = new URL(request.url);
    if (pathname === '/diag') return json(await diagnose(), 200, cors);
    let target;
    let m;
    if ((m = POINT.exec(pathname))) {
      const [, source, lat, lon, nm] = m;
      if (Number(nm) > 100) return json({ error: 'radius too large' }, 400, cors);
      target = UPSTREAMS[source](lat, lon, nm);
    } else if ((m = ROUTE.exec(pathname))) {
      target = `https://api.adsbdb.com/v0/callsign/${m[1].toUpperCase()}`;
    } else {
      return json({ error: 'not found' }, 404, cors);
    }

    let upstream;
    try {
      upstream = await fetch(target, {
        headers: UPSTREAM_HEADERS,
      });
    } catch (e) {
      return json({ error: 'upstream unreachable' }, 502, cors);
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  },
};

const UPSTREAM_HEADERS = { Accept: 'application/json', 'User-Agent': 'plane-radar-proxy' };

// One small request per source (Warsaw, 5 NM), run in parallel.
async function diagnose() {
  const checks = Object.entries(UPSTREAMS).map(([name, url]) => [name, url('52.23', '21.01', '5'), [200]]);
  // adsbdb answers 404 for callsigns it doesn't know; that still means the service is reachable.
  checks.push(['adsbdb (trasy)', 'https://api.adsbdb.com/v0/callsign/LOT1', [200, 404]]);
  const results = await Promise.all(checks.map(async ([name, url, okStatuses]) => {
    try {
      const res = await fetch(url, { headers: UPSTREAM_HEADERS });
      const text = await res.text();
      let aircraft = null;
      try { const data = JSON.parse(text); aircraft = (data.ac || data.aircraft || null)?.length ?? null; } catch { /* not JSON */ }
      const ok = okStatuses.includes(res.status);
      return [name, { ok, status: res.status, aircraft, body: ok ? undefined : text.slice(0, 200) }];
    } catch (e) {
      return [name, { ok: false, error: String(e) }];
    }
  }));
  return Object.fromEntries(results);
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } });
}
