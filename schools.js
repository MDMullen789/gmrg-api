// ── SCHOOL ZONING LOOKUP (Private Listings) ────────────────────
// Claude searches public sales/rental records for the home and its neighbors,
// returns one entry per property record, and the rules below decide what is
// solid enough to pre-fill. The model reports; the server judges.
//
// Rules:
//   - Only records for this home, the same street, or the same subdivision count.
//   - Records older than 3 years don't count (rezoning).
//   - This home's own record alone = confirmed.
//   - 2+ different neighbor properties agreeing = confirmed.
//   - 1 neighbor property = single (pre-filled, flagged to verify).
//   - Counted records that disagree = conflict (left blank, options shown).

const LEVELS = ['district', 'elementary', 'middle', 'high'];
const CLOSE = new Set(['self', 'same_street', 'same_subdivision']);
const STALE_YEARS = 3;

function norm(level, s) {
  let v = String(s || '').toLowerCase().replace(/[.,'’]/g, '').replace(/\s+/g, ' ').trim();
  if (level === 'district') v = v.replace(/independent school district|isd|school district/g, '');
  else v = v.replace(/\bsixth grade center\b|\b(junior high|elementary|middle|high|intermediate|school|el|es|ms|hs|jh)\b/g, '');
  return v.replace(/\s+/g, ' ').trim();
}

function display(level, s) {
  let v = String(s || '').trim();
  if (level === 'district') v = v.replace(/\s*independent school district$/i, ' ISD');
  return v;
}

function judge(records, now = new Date()) {
  const cutoff = now.getFullYear() - STALE_YEARS;
  const recs = (Array.isArray(records) ? records : []).map(r => {
    const relation = CLOSE.has(r.relation) ? r.relation : 'nearby';
    const year = Number.isInteger(r.year) ? r.year : null;
    const stale = year !== null && year < cutoff;
    return { ...r, relation, year, counted: CLOSE.has(relation) && !stale, stale };
  });

  const out = {};
  for (const level of LEVELS) {
    const groups = new Map(); // normalized -> { names:Set, props:Set, self:boolean }
    for (const r of recs) {
      if (!r.counted || !r[level]) continue;
      const key = norm(level, r[level]);
      if (!key) continue;
      const g = groups.get(key) || { names: new Set(), props: new Set(), self: false };
      g.names.add(display(level, r[level]));
      g.props.add(norm('x', r.address));
      if (r.relation === 'self') g.self = true;
      groups.set(key, g);
    }
    const best = g => [...g.names].sort((a, b) => b.length - a.length)[0];
    if (groups.size === 0) {
      out[level] = { value: '', status: 'none', count: 0 };
    } else if (groups.size > 1) {
      out[level] = { value: '', status: 'conflict', count: 0, options: [...groups.values()].map(best) };
    } else {
      const g = [...groups.values()][0];
      const count = g.props.size;
      out[level] = { value: best(g), status: (g.self || count >= 2) ? 'confirmed' : 'single', count, self: g.self };
    }
  }
  return { ...out, records: recs };
}

function extractJson(content) {
  const texts = (content || []).filter(b => b.type === 'text').map(b => b.text);
  for (let i = texts.length - 1; i >= 0; i--) {
    const t = texts[i], a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a < 0 || b <= a) continue;
    try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { /* try earlier block */ }
  }
  const all = texts.join('\n'), a = all.indexOf('{"records"'), b = all.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(all.slice(a, b + 1)); } catch (e) {} }
  return null;
}

const SYSTEM = `You research Texas public school attendance zoning for real estate listings using public web records: MLS-derived listing pages on brokerage and portal sites (Coldwell Banker, HAR, Redfin, Realtor.com, Compass, Century 21, etc.), rental listings, and school district pages. Report only what a source states for a specific property. Never infer, never fill gaps from general knowledge.`;

function prompt({ address, city, zip, subdivision }) {
  return `Property: ${address}${city ? ', ' + city : ''}${zip ? ' ' + zip : ''}, Texas.${subdivision ? ' Subdivision: ' + subdivision + '.' : ''}

Find the public school district and the elementary, middle and high schools this property is zoned to.
1. Search the exact address first. A past listing of this home is the best source.
2. Then search neighbors on the same street, then the same subdivision.
3. Only use a record if the page says those schools serve or are assigned to that property (e.g. "Schools serving…", "Elementary school:"). Ignore generic "nearby schools" lists, private schools and charter schools.

Return ONLY this JSON, no other text:
{"records":[{"address":"2208 Chebi Ln","relation":"self|same_street|same_subdivision|nearby","subdivision":"","year":2026,"district":"Denton ISD","elementary":"","middle":"","high":"","url":"https://..."}],"districtWebsite":""}

- One entry per property. If several sites show the same property, merge them into one entry with the most complete school names.
- relation: "self" = this exact address; "same_street" = same street name in the same city; "same_subdivision" = same subdivision on another street; "nearby" = anything else.
- year = year of that listing/sale record if shown, else null.
- "" for any school the record doesn't name. districtWebsite = the district's school-finder / attendance-zone page if you found one, else "".
- If nothing usable is found, return {"records":[],"districtWebsite":""}.`;
}

async function lookupSchools(client, input) {
  const messages = [{ role: 'user', content: prompt(input) }];
  const params = {
    model: 'claude-sonnet-4-6',
    max_tokens: 4000,
    system: SYSTEM,
    tools: [{
      type: 'web_search_20250305', name: 'web_search', max_uses: 8,
      user_location: { type: 'approximate', region: 'Texas', country: 'US', timezone: 'America/Chicago' }
    }],
    messages
  };
  let response;
  for (let turn = 0; turn < 4; turn++) {
    response = await client.messages.create(params);
    if (response.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: response.content });
  }
  const parsed = extractJson(response.content);
  if (!parsed) throw new Error('Could not read the search results');
  const result = judge(parsed.records);
  result.districtWebsite = /^https:\/\//.test(parsed.districtWebsite || '') ? parsed.districtWebsite : '';
  result.searches = response.usage?.server_tool_use?.web_search_requests ?? null;
  return result;
}

module.exports = { lookupSchools, judge, extractJson, norm };
