// Cloudflare Worker: CORS proxy for Plane Radar.
//
// adsb.lol, airplanes.live and adsbdb.com don't send CORS headers, so a web page can't call them
// directly. This Worker forwards a small, fixed set of read-only requests and adds the headers.
//
//   GET /adsb.lol/v2/point/{lat}/{lon}/{radiusNm}        -> https://api.adsb.lol/v2/point/...
//   GET /airplanes.live/v2/point/{lat}/{lon}/{radiusNm}  -> https://api.airplanes.live/v2/point/...
//   GET /route/{callsign}                                -> https://api.adsbdb.com/v0/callsign/...

// Pages allowed to use this proxy. Add your own domain here if you host the app elsewhere.
const ALLOWED_ORIGINS = [
  'https://wiktorkuziemko-dev.github.io',
  'http://localhost:8000',
];

const UPSTREAMS = {
  'adsb.lol': 'https://api.adsb.lol',
  'airplanes.live': 'https://api.airplanes.live',
};

const POINT = /^\/(adsb\.lol|airplanes\.live)\/v2\/point\/(-?\d{1,2}(?:\.\d{1,6})?)\/(-?\d{1,3}(?:\.\d{1,6})?)\/(\d{1,3})$/;
const ROUTE = /^\/route\/([A-Za-z0-9]{2,8})$/;

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';
    const allowed = ALLOWED_ORIGINS.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': allowed ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405, cors);
    // Browsers always send Origin on cross-origin fetches; refuse other websites.
    if (origin && !allowed) return json({ error: 'origin not allowed' }, 403, cors);

    const { pathname } = new URL(request.url);
    let target;
    let m;
    if ((m = POINT.exec(pathname))) {
      const [, source, lat, lon, nm] = m;
      if (Number(nm) > 100) return json({ error: 'radius too large' }, 400, cors);
      target = `${UPSTREAMS[source]}/v2/point/${lat}/${lon}/${nm}`;
    } else if ((m = ROUTE.exec(pathname))) {
      target = `https://api.adsbdb.com/v0/callsign/${m[1].toUpperCase()}`;
    } else {
      return json({ error: 'not found' }, 404, cors);
    }

    let upstream;
    try {
      upstream = await fetch(target, {
        headers: { Accept: 'application/json', 'User-Agent': 'plane-radar-proxy (+https://github.com/wiktorkuziemko-dev/plane-radar)' },
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

function json(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
}
