// ── SIGN-IN CHECK ──────────────────────────────────────────────
// Verifies the Firebase ID token the dashboard sends (Authorization: Bearer <token>)
// and confirms the person is still on the Team list. No service account or extra
// package: Google's public signing certificates + Firestore REST with the user's own token.
//
// Railway variables (all optional):
//   REQUIRE_AUTH=1        refuse requests without a valid sign-in (flip on at go-live)
//   FIREBASE_PROJECT_ID   default gmrg-tour-library
//   TEAM_DOMAIN           default ginamullen.com
//   TEAM_OWNERS           default matt@,gina@,shaylee@ginamullen.com (always allowed)

const crypto = require('crypto');

const PROJECT = process.env.FIREBASE_PROJECT_ID || 'gmrg-tour-library';
const DOMAIN = (process.env.TEAM_DOMAIN || 'ginamullen.com').toLowerCase();
const OWNERS = (process.env.TEAM_OWNERS || 'matt@ginamullen.com,gina@ginamullen.com,shaylee@ginamullen.com')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const REQUIRED = () => process.env.REQUIRE_AUTH === '1' || process.env.REQUIRE_AUTH === 'true';

const CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
let certs = { keys: {}, until: 0 };
async function getCerts() {
  if (Date.now() < certs.until) return certs.keys;
  const r = await fetch(CERTS_URL);
  if (!r.ok) throw new Error('cert fetch ' + r.status);
  const m = /max-age=(\d+)/.exec(r.headers.get('cache-control') || '');
  certs = { keys: await r.json(), until: Date.now() + (m ? +m[1] : 3600) * 1000 };
  return certs.keys;
}

const b64 = s => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

async function verifyIdToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const header = JSON.parse(b64(parts[0]).toString());
  const claims = JSON.parse(b64(parts[1]).toString());
  if (header.alg !== 'RS256') throw new Error('bad alg');
  let keys = await getCerts();
  if (!keys[header.kid]) { certs.until = 0; keys = await getCerts(); }   // keys rotate
  const pem = keys[header.kid];
  if (!pem) throw new Error('unknown key');
  const ok = crypto.createVerify('RSA-SHA256').update(parts[0] + '.' + parts[1]).verify(pem, b64(parts[2]));
  if (!ok) throw new Error('bad signature');
  const now = Math.floor(Date.now() / 1000);
  if (claims.aud !== PROJECT || claims.iss !== 'https://securetoken.google.com/' + PROJECT) throw new Error('wrong project');
  if (!(claims.exp > now - 60) || !(claims.iat < now + 300) || !claims.sub) throw new Error('expired');
  return claims;
}

// Team list check, cached 5 minutes per person.
const memberCache = new Map();
async function isActiveMember(email, token) {
  if (OWNERS.includes(email)) return true;
  const hit = memberCache.get(email);
  if (hit && Date.now() < hit.until) return hit.ok;
  const url = 'https://firestore.googleapis.com/v1/projects/' + PROJECT + '/databases/(default)/documents/members/' + encodeURIComponent(email);
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  let ok = false;
  if (r.ok) { const d = await r.json(); ok = !!(d.fields && d.fields.active && d.fields.active.booleanValue); }
  else if (r.status !== 404 && r.status !== 403) throw new Error('team list ' + r.status);
  memberCache.set(email, { ok, until: Date.now() + 5 * 60 * 1000 });
  return ok;
}

// Express middleware for agent-only endpoints.
async function requireSignIn(req, res, next) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  if (!m) {
    if (!REQUIRED()) return next();               // live site (no sign-in yet) keeps working until go-live
    return res.status(401).json({ error: 'Please sign in to the Agent Library first.' });
  }
  let c;
  try { c = await verifyIdToken(m[1]); }
  catch (e) { console.warn('[auth]', e.message); return res.status(401).json({ error: 'Your sign-in expired. Reload the page and try again.' }); }
  const email = String(c.email || '').toLowerCase();
  if (!c.email_verified || !email.endsWith('@' + DOMAIN)) return res.status(403).json({ error: 'This account isn’t part of the team.' });
  let member;
  try { member = await isActiveMember(email, m[1]); }
  catch (e) { console.warn('[auth] team list', e.message); return res.status(503).json({ error: 'Couldn’t check the team list. Try again in a minute.' }); }
  if (!member) return res.status(403).json({ error: 'Your access is turned off. Ask an admin.' });
  req.agent = { email, name: c.name || '' };
  return next();
}

// Same check, but a sign-in is always required (used for deleting pages), whatever REQUIRE_AUTH says.
function requireSignInAlways(req, res, next) {
  if (!/^Bearer\s+.+$/i.test(req.headers.authorization || '')) return res.status(401).json({ error: 'Please sign in to the Agent Library first.' });
  return requireSignIn(req, res, next);
}

module.exports = { requireSignIn, requireSignInAlways, verifyIdToken, PROJECT };
