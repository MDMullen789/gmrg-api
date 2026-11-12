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

    const data = { price, status, checkedAt: new Date(now).toISOString() };
    if (price) livePriceCache.set(key, { at: now, data });
    console.log(`[LivePrice] ${key} price=${price} status="${status}"`);
    res.json(data);
  } catch (err) {
    console.error('[LivePrice] Error:', err.message);
    res.status(502).json({ error: 'Could not read listing page' });
  }
});

// ── START ──────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`GMRG API server running on port ${PORT}`);
});
