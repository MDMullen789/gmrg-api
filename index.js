const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;

// ── MIDDLEWARE ─────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '50mb' })); // Handle large PDF payloads

// ── HEALTH CHECK ───────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'GMRG API running', version: '1.0.0' });
});

// ── ANTHROPIC PROXY ────────────────────────────────────────────
app.post('/api/claude', async (req, res) => {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured on server' });
    }

    const client = new Anthropic({ apiKey });

    const { model, max_tokens, messages, system } = req.body;

    if (!model || !max_tokens || !messages) {
      return res.status(400).json({ error: 'Missing required fields: model, max_tokens, messages' });
    }

    const params = { model, max_tokens, messages };
    if (system) params.system = system;

    console.log(`[Claude] model=${model} max_tokens=${max_tokens} messages=${messages.length}`);

    const response = await client.messages.create(params);

    console.log(`[Claude] done — stop_reason=${response.stop_reason} tokens=${response.usage?.output_tokens}`);

    res.json(response);

  } catch (err) {
    console.error('[Claude] Error:', err.message);
    const status = err.status || 500;
    res.status(status).json({ error: err.message });
  }
});

// ── NETLIFY PUBLISH ────────────────────────────────────────────
// Publishing used to happen in the browser with a Netlify token embedded in
// the dashboard HTML (anyone could read it via View Source). The token now
// lives only here, in Railway's NETLIFY_TOKEN variable.
const crypto = require('crypto');
const NETLIFY_API = 'https://api.netlify.com/api/v1';
const NETLIFY_TEAM = 'gina-mullen-realty-group';
const PUBLISH_TARGETS = {
  tours:   { siteId: 'da1e01aa-f682-48e5-a12a-93ca34c493be' },  // gmrg-tours
  updates: { siteId: '3d1c0551-5546-4f7a-ae9e-08c9fbd84629' },  // gmrg-updates
  listing: { newSite: true }                                     // one site per listing
};
const PUBLISH_ORIGINS = [/^https:\/\/gmrglibrary\.netlify\.app$/, /^https:\/\/[a-z0-9-]+--gmrglibrary\.netlify\.app$/];
const MAX_FILES = 60;
const MAX_TOTAL_BYTES = 40 * 1024 * 1024;

// Simple in-memory limiter: 20 publishes per 10 minutes per IP.
const publishHits = new Map();
function publishRateLimited(ip) {
  const now = Date.now(), win = 10 * 60 * 1000;
  const hits = (publishHits.get(ip) || []).filter(t => now - t < win);
  hits.push(now); publishHits.set(ip, hits);
  return hits.length > 20;
}

async function netlify(path, opts, token) {
  const r = await fetch(NETLIFY_API + path, {
    ...opts,
    headers: { Authorization: 'Bearer ' + token, ...(opts.headers || {}) }
  });
  const text = await r.text();
  if (!r.ok) {
    const err = new Error('Netlify ' + r.status + ': ' + text.slice(0, 200));
    err.status = 502;
    throw err;
  }
  return text ? JSON.parse(text) : {};
}

// Body: { target: 'tours'|'updates'|'listing', files: { '/index.html': { content, encoding: 'utf8'|'base64' } },
//         draft?: boolean, slug?: string }
// Returns: { deployId, deployUrl, siteUrl }
app.post('/api/publish', async (req, res) => {
  try {
    const origin = req.get('origin') || '';
    if (!PUBLISH_ORIGINS.some(re => re.test(origin))) return res.status(403).json({ error: 'Origin not allowed' });
    if (publishRateLimited(req.ip)) return res.status(429).json({ error: 'Too many publishes — try again in a few minutes' });

    const token = process.env.NETLIFY_TOKEN;
    if (!token) return res.status(500).json({ error: 'NETLIFY_TOKEN not configured on server' });

    const { target, files, draft, slug, existingUrl } = req.body || {};
    const cfg = PUBLISH_TARGETS[target];
    if (!cfg) return res.status(400).json({ error: 'Unknown publish target' });
    if (!files || typeof files !== 'object') return res.status(400).json({ error: 'Missing files' });

    // Decode + validate files, build the SHA1 manifest Netlify expects.
    const buffers = {}, manifest = {};
    let total = 0;
    const paths = Object.keys(files);
    if (!paths.length || paths.length > MAX_FILES) return res.status(400).json({ error: 'Between 1 and ' + MAX_FILES + ' files allowed' });
    for (const path of paths) {
      if (!/^\/[A-Za-z0-9._\-\/]+$/.test(path) || path.includes('..')) return res.status(400).json({ error: 'Bad file path: ' + path });
      const f = files[path];
      if (!f || typeof f.content !== 'string') return res.status(400).json({ error: 'Bad file: ' + path });
      const buf = Buffer.from(f.content, f.encoding === 'base64' ? 'base64' : 'utf8');
      total += buf.length;
      buffers[path] = buf;
      manifest[path] = crypto.createHash('sha1').update(buf).digest('hex');
    }
    if (total > MAX_TOTAL_BYTES) return res.status(413).json({ error: 'Publish too large' });

    // Resolve the site (existing, or a new one for listings — always under the paid team).
    let siteId = cfg.siteId, siteUrl = null;
    if (cfg.newSite && existingUrl) {
      // Republish onto an existing listing page (e.g. Private Listing -> Active) so the link stays the same.
      let host;
      try { host = new URL(String(existingUrl)).hostname.toLowerCase(); } catch (e) { return res.status(400).json({ error: 'Existing link is not a valid URL' }); }
      const m = host.match(/^(?:[a-z0-9]+--)?(gmrg-[a-z0-9-]+)\.netlify\.app$/);
      if (!m) return res.status(400).json({ error: 'Existing link must be a published listing page (gmrg-….netlify.app)' });
      const site = await netlify('/sites/' + m[1] + '.netlify.app', { method: 'GET' }, token);
      if (!site || !site.id || site.account_slug !== NETLIFY_TEAM || !String(site.name || '').startsWith('gmrg-')) {
        return res.status(403).json({ error: 'That page is not a GMRG listing page' });
      }
      siteId = site.id;
      siteUrl = site.ssl_url || ('https://' + site.default_domain);
    } else if (cfg.newSite) {
      const base = String(slug || 'listing').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 45) || 'listing';
      const name = 'gmrg-' + base + '-' + crypto.randomBytes(2).toString('hex');
      const site = await netlify('/' + NETLIFY_TEAM + '/sites', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name })
      }, token);
      siteId = site.id;
      siteUrl = 'https://' + (site.default_domain || name + '.netlify.app');
    }

    const deploy = await netlify('/sites/' + siteId + '/deploys', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: manifest, draft: !!draft })
    }, token);

    // Upload only the files Netlify doesn't already have.
    const required = new Set(deploy.required || []);
    for (const path of paths) {
      if (required.size && !required.has(manifest[path])) continue;
      await netlify('/deploys/' + deploy.id + '/files' + path, {
        method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: buffers[path]
      }, token);
    }

    console.log(`[Publish] target=${target} files=${paths.length} bytes=${total} deploy=${deploy.id}`);
    res.json({
      deployId: deploy.id,
      deployUrl: deploy.deploy_ssl_url || deploy.ssl_url,
      siteUrl: siteUrl || deploy.ssl_url
    });
  } catch (err) {
    console.error('[Publish] Error:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ── LIVE PRICE (from ginamullen.com IDX listing pages) ─────────
// Listing summary pages call this on load to show the current price.
// Reads the listing page's <meta name="keywords"> e.g.
//   "For sale, beds 5, bath 5, 6839 sq. ft, 901 Hat Creek Ct, Bartonville, TX 76226, $3859000"
const livePriceCache = new Map(); // url -> { at, data }
const livePriceHits = new Map();
app.get('/api/live-price', async (req, res) => {
  try {
    const now = Date.now();
    const hits = (livePriceHits.get(req.ip) || []).filter(t => now - t < 10 * 60 * 1000);
    hits.push(now); livePriceHits.set(req.ip, hits);
    if (hits.length > 120) return res.status(429).json({ error: 'Too many requests' });

    let url;
    try { url = new URL(String(req.query.url || '')); } catch (e) { return res.status(400).json({ error: 'Bad url' }); }
    if (url.protocol !== 'https:' || !/^(www\.)?ginamullen\.com$/i.test(url.hostname) || !url.pathname.startsWith('/search/')) {
      return res.status(400).json({ error: 'Only ginamullen.com listing pages are supported' });
    }
    const key = url.origin + url.pathname;
    const cached = livePriceCache.get(key);
    if (cached && now - cached.at < 30 * 60 * 1000) return res.json(cached.data);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(key, { signal: ctrl.signal, headers: { 'User-Agent': 'GMRG-AgentLibrary/1.0 (+https://gmrglibrary.netlify.app)' } });
    clearTimeout(timer);
    if (!r.ok) return res.status(502).json({ error: 'Listing page returned ' + r.status });
    const html = await r.text();

    const m = html.match(/<meta[^>]+name=["']keywords["'][^>]*content=["']([^"']*)["']/i) ||
              html.match(/<meta[^>]+content=["']([^"']*)["'][^>]*name=["']keywords["']/i);
    const keywords = m ? m[1] : '';
    const pm = keywords.match(/\$\s?([\d,]{4,})/);
    const price = pm ? parseInt(pm[1].replace(/,/g, ''), 10) : null;
    const status = (keywords.split(',')[0] || '').trim(); // e.g. "For sale", "Pending", "Sold"
    // Address as the page states it, so callers can confirm the MLS# landed on the right home
    const parts = keywords.split(',').map(x => x.trim());
    const ai = parts.findIndex(x => /^\d+[A-Za-z]?\s+\S/.test(x) && !/sq\.?\s*ft/i.test(x));
    const address = ai >= 0 ? parts[ai] : '';
    const city = ai >= 0 ? (parts[ai + 1] || '') : '';

    const data = { price, status, address, city, checkedAt: new Date(now).toISOString() };
    if (price) livePriceCache.set(key, { at: now, data });
    console.log(`[LivePrice] ${key} price=${price} status="${status}"`);
    res.json(data);
  } catch (err) {
    console.error('[LivePrice] Error:', err.message);
    res.status(502).json({ error: 'Could not read listing page' });
  }
});

// ── SCHOOL ZONING LOOKUP ───────────────────────────────────────
// Used by the Listing Summary's Private Listing mode. Rules live in schools.js.
const { lookupSchools } = require('./schools');
const schoolCache = new Map(); // address key -> { at, data }
const schoolHits = new Map();
app.post('/api/schools', async (req, res) => {
  try {
    const origin = req.get('origin') || '';
    if (!PUBLISH_ORIGINS.some(re => re.test(origin))) return res.status(403).json({ error: 'Origin not allowed' });

    const now = Date.now();
    const hits = (schoolHits.get(req.ip) || []).filter(t => now - t < 10 * 60 * 1000);
    hits.push(now); schoolHits.set(req.ip, hits);
    if (hits.length > 15) return res.status(429).json({ error: 'Too many lookups — try again in a few minutes' });

    const clean = v => String(v || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 160);
    const input = { address: clean(req.body.address), city: clean(req.body.city), zip: clean(req.body.zip), subdivision: clean(req.body.subdivision) };
    if (!input.address || !(input.city || input.zip)) return res.status(400).json({ error: 'Address with city or ZIP required' });

    const key = [input.address, input.city, input.zip].join('|').toLowerCase().replace(/\s+/g, ' ');
    const cached = schoolCache.get(key);
    if (cached && now - cached.at < 24 * 60 * 60 * 1000) return res.json(cached.data);

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured on server' });
    const data = await lookupSchools(new Anthropic({ apiKey }), input);
    data.checkedAt = new Date(now).toISOString();
    if (data.records.length) schoolCache.set(key, { at: now, data });
    console.log(`[Schools] ${key} records=${data.records.length} elem=${data.elementary.status} mid=${data.middle.status} high=${data.high.status}`);
    res.json(data);
  } catch (err) {
    console.error('[Schools] Error:', err.message);
    res.status(err.status || 502).json({ error: err.message || 'School lookup failed' });
  }
});

// ── ADDRESS SEARCH ─────────────────────────────────────────────
// Autocomplete for the Listing Summary address field. Free Photon (OpenStreetMap)
// by default; Google Places API (New) if GOOGLE_MAPS_KEY is set in Railway. Uses session tokens so each pick is billed
// as one Place Details Essentials call (10,000 free per month).
const PLACES = 'https://places.googleapis.com/v1';
const placesHits = new Map();
function placesGuard(req, res) {
  const origin = req.get('origin') || '';
  if (!PUBLISH_ORIGINS.some(re => re.test(origin))) { res.status(403).json({ error: 'Origin not allowed' }); return null; }
  const now = Date.now();
  const hits = (placesHits.get(req.ip) || []).filter(t => now - t < 10 * 60 * 1000);
  hits.push(now); placesHits.set(req.ip, hits);
  if (hits.length > 400) { res.status(429).json({ error: 'Too many requests' }); return null; }
  return process.env.GOOGLE_MAPS_KEY || 'photon';
}

// Free fallback when there's no Google key: Photon (OpenStreetMap), limited to Texas.
// If OSM has the street but not the house, the typed house number is put in front,
// so "2309 chebi" still becomes "2309 Chebi Ln, Denton, TX 76209".
const USPS = { lane: 'Ln', court: 'Ct', drive: 'Dr', road: 'Rd', street: 'St', boulevard: 'Blvd', avenue: 'Ave', circle: 'Cir',
  trail: 'Trl', place: 'Pl', parkway: 'Pkwy', terrace: 'Ter', cove: 'Cv', crossing: 'Xing', highway: 'Hwy', way: 'Way', point: 'Pt',
  north: 'N', south: 'S', east: 'E', west: 'W' };
const abbr = s => String(s || '').replace(/\b(Lane|Court|Drive|Road|Street|Boulevard|Avenue|Circle|Trail|Place|Parkway|Terrace|Cove|Crossing|Highway|Point)$/i, m => USPS[m.toLowerCase()])
  .replace(/^(North|South|East|West)\b/i, m => USPS[m.toLowerCase()]);
async function photonSearch(input) {
  const num = (input.match(/^\s*(\d+[A-Za-z]?)\s+/) || [])[1] || '';
  const url = 'https://photon.komoot.io/api/?' + new URLSearchParams({ q: input, limit: '10', lang: 'en', lat: '33.2', lon: '-97.13', bbox: '-106.65,25.84,-93.51,36.5' });
  const r = await fetch(url, { headers: { 'User-Agent': 'GMRG-AgentLibrary/1.0 (+https://gmrglibrary.netlify.app)' } });
  if (!r.ok) throw new Error('Address search returned ' + r.status);
  const j = await r.json();
  const seen = new Set(), out = [];
  for (const f of j.features || []) {
    const p = f.properties || {};
    if (p.state && p.state !== 'Texas') continue;
    const isHouse = !!p.housenumber;
    const isStreet = !isHouse && p.osm_key === 'highway';
    if (!isHouse && !isStreet) continue;
    const road = abbr(isHouse ? p.street : p.name);
    const house = isHouse ? p.housenumber : num;
    if (!road || !house) continue;
    const street = house + ' ' + road;
    const city = p.city || p.town || p.village || p.district || p.county || '';
    const key = (street + city).toLowerCase();
    if (seen.has(key)) continue; seen.add(key);
    out.push({ id: '', main: street, secondary: [city, 'TX'].filter(Boolean).join(', ') + (p.postcode ? ' ' + p.postcode : ''),
      address: { street, city, state: 'TX', zip: p.postcode || '', neighborhood: '' } });
    if (out.length >= 6) break;
  }
  return out;
}
const token = v => String(v || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);

app.get('/api/places/autocomplete', async (req, res) => {
  const key = placesGuard(req, res); if (!key) return;
  const input = String(req.query.q || '').trim().slice(0, 120);
  if (input.length < 3) return res.json({ suggestions: [] });
  try {
    if (key === 'photon') return res.json({ suggestions: await photonSearch(input), source: 'photon' });
    const r = await fetch(PLACES + '/places:autocomplete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key },
      body: JSON.stringify({
        input,
        sessionToken: token(req.query.session) || undefined,
        includedRegionCodes: ['us'],
        includedPrimaryTypes: ['street_address', 'premise', 'subpremise'],
        // Bias toward North Texas (Denton County, 50 km — the max Google allows)
        locationBias: { circle: { center: { latitude: 33.2, longitude: -97.13 }, radius: 50000 } }
      })
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error?.message || ('Google returned ' + r.status));
    res.json({ source: 'google', suggestions: (j.suggestions || []).filter(s => s.placePrediction).map(s => ({
      id: s.placePrediction.placeId,
      main: s.placePrediction.structuredFormat?.mainText?.text || s.placePrediction.text?.text || '',
      secondary: s.placePrediction.structuredFormat?.secondaryText?.text || ''
    })) });
  } catch (err) {
    console.error('[Places] autocomplete:', err.message);
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/places/details', async (req, res) => {
  const key = placesGuard(req, res); if (!key) return;
  if (key === 'photon') return res.status(400).json({ error: 'Details not needed for this source' });
  const id = String(req.query.id || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!id) return res.status(400).json({ error: 'Missing id' });
  try {
    const qs = token(req.query.session) ? '?sessionToken=' + token(req.query.session) : '';
    const r = await fetch(PLACES + '/places/' + id + qs, {
      headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'addressComponents,formattedAddress' }
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error?.message || ('Google returned ' + r.status));
    const get = (type, short) => { const c = (j.addressComponents || []).find(c => (c.types || []).includes(type)); return c ? (short ? c.shortText : c.longText) : ''; };
    const street = [get('street_number', true), get('route', true)].filter(Boolean).join(' ');
    res.json({
      street,
      city: get('locality') || get('sublocality') || get('postal_town'),
      state: get('administrative_area_level_1', true),
      zip: get('postal_code'),
      county: get('administrative_area_level_2'),
      neighborhood: get('neighborhood'),
      formatted: j.formattedAddress || ''
    });
  } catch (err) {
    console.error('[Places] details:', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ── START ──────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`GMRG API server running on port ${PORT}`);
});
