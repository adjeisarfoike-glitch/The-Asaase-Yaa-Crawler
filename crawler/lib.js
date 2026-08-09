/**
 * Shared logic for the crawler and the backfill tool, so a record gathered
 * from a 2011 Wayback snapshot is classified exactly like one pulled from
 * this morning's RSS.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'incidents.json');
const gazetteer = JSON.parse(fs.readFileSync(path.join(__dirname, 'gazetteer.json'), 'utf8'));

// An item must hit this to be kept at all.
const TOPIC = /\b(galamsey|galamseyer|illegal mining|illegal minin|small-?scale mining|mining menace|excavator|changfan|chanfang|chamfang|forest reserve|NAIMOS|blue water guard|operation halt|operation vanguard)\b/i;

// Category is scored, not first-match. First-match filed the Wontumi verdict
// as an arrest, because the arrest rule saw the word "operation" inside
// "unlicensed mining operation" and never reached the prosecution rule.
// Order here still matters, but only to break ties.
const RULES = [
  // Enforcement action: the moment the state intervenes. "charged" belongs
  // here — charging accompanies arrest, and a story that ends "will appear in
  // court" is still an arrest story.
  { category: 'arrest', re: /\b(?:arrest\w*|apprehend\w*|swoop\w*|raid(?:s|ed|ing)?|seiz\w*|impound\w*|confiscat\w*|nabbed|detain\w*|crackdown\w*|clampdown\w*|task ?force\w*|charged|swept|held|holding|round\w* up|picked up|intercept\w*|blocked|busted|foreign nationals|abandon\w*|demolish\w*|immobilis\w*|immobiliz\w*|dismantl\w*|anti-?galamsey operation|joint operation|security operation)\b/i },

  // Anything that happens once a case is before a court — the outcome and the
  // process. "court" is included: an earlier version left it out to stop
  // arrest stories being mislabelled, but that dropped adjournments, bail and
  // hearings into the default category instead. Scoring handles the overlap
  // now, because an arrest story carries its arrest terms in the headline.
  { category: 'prosecution', re: /\b(?:convict\w*|sentenc\w*|jail\w*|imprison\w*|acquit\w*|verdict\w*|judg[em]ent\w*|guilty|plead\w*|remand\w*|prosecut\w*|fined|on trial|court\w*|tribunal\w*|magistrat\w*|arraign\w*|adjourn\w*|hearing\w*|bail|docket|testif\w*|testimon\w*|witness\w*|defence|defense|counsel|accused|suspects? appear\w*)\b/i },

  { category: 'reclamation', re: /\b(?:reclaim\w*|reclamation|restor\w*|rehabilitat\w*|replant\w*|reforest\w*|afforest\w*|revegetat\w*|remediat\w*|seedling\w*|tree planting|backfill\w*)\b/i },

  { category: 'water', re: /\b(?:river\w*|water bod\w*|turbidity|NTU|pollut\w*|contaminat\w*|mercury|cyanide|treatment plant\w*|potable|Ghana Water|silt\w*|dredg\w*|discolour\w*|discolor\w*)\b/i },

  { category: 'forest', re: /\b(?:forest reserve\w*|hectare\w*|deforest\w*|forest cover|degrad\w*|national park|cocoa farm\w*|farmland\w*|Forestry Commission|vegetation|canopy|timber)\b/i },

  { category: 'policy', re: /\b(?:minister\w*|ministry|parliament\w*|polic(?:y|ies)|L\.?I\.? ?2462|licen[cs]\w*|regulat\w*|repeal\w*|ban(?:s|ned|ning)?|moratorium|committee|legislat\w*|directive\w*|interfer\w*|politic\w*|enforcement|governmen\w*|amendment\w*|bill|law)\b/i }
];

const METRICS = [
  { key: 'arrests', re: /([\d,]+)\s+(?:suspect|people|persons|individual|miner|galamseyer|illegal miner)\w*\s+(?:were\s+)?(?:arrest|apprehend|nabbed|held)/i },
  { key: 'arrests', re: /arrest(?:ed|s)?\s+(?:of\s+)?([\d,]+)\s+(?:suspect|people|persons|individual|miner)/i },
  { key: 'excavators', re: /([\d,]+)\s+excavator/i },
  { key: 'hectares', re: /([\d,]+(?:\.\d+)?)\s+hectare/i },
  { key: 'acres', re: /([\d,]+(?:\.\d+)?)\s+acre/i },
  { key: 'changfan', re: /([\d,]+)\s+(?:changfan|chanfang|chamfang)/i },
  { key: 'ntu', re: /([\d,]+(?:\.\d+)?)\s*NTU/i }
];

function clean(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? clean(m[1]) : '';
}

function parseRss(xml, fallbackName) {
  const items = [];
  for (const b of xml.match(/<(item|entry)[\s\S]*?<\/(item|entry)>/gi) || []) {
    const link = tag(b, 'link') || (b.match(/<link[^>]*href="([^"]+)"/i) || [])[1] || '';
    const title = tag(b, 'title');
    if (!title || !link) continue;
    const outletMatch = title.match(/\s-\s([^-]{2,40})$/); // Google News appends the outlet
    items.push({
      title: outletMatch ? title.slice(0, outletMatch.index).trim() : title,
      link,
      summary: tag(b, 'description') || tag(b, 'summary') || tag(b, 'content'),
      date: tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated'),
      outlet: (outletMatch && outletMatch[1].trim()) || tag(b, 'source') || fallbackName
    });
  }
  return items;
}

/**
 * Score each category and take the highest. A term in the headline counts
 * triple — a verdict story says "jailed" in the headline and "operation"
 * only in passing, and the headline is what the story is about.
 * Ties fall to rule order, so "eight arrested and charged" stays an arrest.
 */
function classify(text, title = '') {
  const t = String(text), h = String(title);
  let best = 'forest', bestScore = 0;
  for (const rule of RULES) {
    const re = new RegExp(rule.re.source, 'gi');
    const body = (t.match(re) || []).length;
    if (!body) continue;
    const head = (h.match(new RegExp(rule.re.source, 'gi')) || []).length;
    const score = body + head * 3;
    if (score > bestScore) { bestScore = score; best = rule.category; }
  }
  return best;
}

// Upper bounds beyond which a matched number is almost certainly not the
// figure we think it is — a misparse, an unrelated statistic, or an OCR error.
const METRIC_MAX = {
  arrests: 5000, excavators: 2000, hectares: 500000, acres: 2000000,
  changfan: 20000, ntu: 100000, years: 200, structures: 100000
};

function extractMetrics(text) {
  const out = {};
  for (const m of METRICS) {
    if (out[m.key] !== undefined) continue;
    const hit = text.match(m.re);
    if (hit) {
      const n = parseFloat(hit[1].replace(/,/g, ''));
      const ceiling = METRIC_MAX[m.key] || Infinity;
      if (!Number.isNaN(n) && n > 0 && n <= ceiling) out[m.key] = n;
    }
  }
  return out;
}

// Place matching is scored, not first-match-wins. An earlier version tried
// names longest-first and took the first hit, which meant "Bolgatanga"
// mentioned in passing beat "Kibi" in the headline purely on string length.
const PLACES = Object.keys(gazetteer);
const reCache = new Map();
function placeRe(place) {
  if (!reCache.has(place)) {
    reCache.set(place, new RegExp(`\\b${place.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'));
  }
  const re = reCache.get(place);
  re.lastIndex = 0;
  return re;
}

// A handful of Ghanaian place names are also ordinary English words, or are
// too short to be distinctive. These only count when their region is named too.
const AMBIGUOUS = new Set(['Wa', 'Ho', 'Mim', 'Bole', 'Banda', 'Prang', 'Kade']);

/**
 * Score every gazetteer place against the text and return the best.
 *   - a mention in the headline counts triple; that is what the story is about
 *   - within the headline, earlier wins — news headlines lead with the subject,
 *     and a place named late is usually incidental
 *   - repeated mentions in the body add weight
 *   - multi-word names get a bonus: "Manso Adubia" is more specific evidence
 *     than "Manso"
 * Deliberately no bonus for name length. Ranking by length was the original
 * bug: "Bolgatanga" mentioned in passing beat "Kibi" in the headline.
 */
function geotag(text, title = '') {
  const t = String(text), h = String(title) || t;
  let best = null, bestScore = 0;

  for (const place of PLACES) {
    const body = (t.match(placeRe(place)) || []).length;
    if (!body) continue;

    const entry = gazetteer[place];
    // Ambiguous names need their region named alongside them.
    if (AMBIGUOUS.has(place) && !new RegExp(`\\b${entry.region}\\b`, 'i').test(t)) continue;

    const idx = h.search(placeRe(place));
    const inHead = idx >= 0;
    const earliness = inHead && h.length ? 2 * (1 - idx / h.length) : 0;

    const score = body + (inHead ? 3 : 0) + earliness + (place.split(/\s+/).length - 1) * 1.5;
    if (score > bestScore) { bestScore = score; best = { place, ...entry }; }
  }
  return best;
}

// A record with no identifiable place is still a real article about galamsey,
// so it is kept and parked here rather than thrown away. Every run retries the
// unplaced pile, which means adding one gazetteer entry retroactively fixes
// every old record that mentions it.
const UNPLACED = 'Unplaced';

function retagUnplaced(map) {
  let fixed = 0;
  for (const rec of map.values()) {
    if (rec.region !== UNPLACED || rec.verified) continue;
    const loc = geotag(`${rec.title}. ${rec.summary}`, rec.title);
    if (!loc) continue;
    rec.place = loc.place; rec.region = loc.region; rec.lat = loc.lat; rec.lon = loc.lon;
    fixed++;
  }
  return fixed;
}

// ---------------------------------------------------------------- threading
// The crawler used to treat every article as standalone, so the Samreboi raid
// and the conviction fifteen months later sat in the archive as unrelated
// records. Threading links them by the distinctive names they share.
//
// Deliberately not place-based: the raid happened at Samreboi and the verdict
// was handed down in Accra. What ties them together is "Akonta" and "Samreboi"
// appearing in both, not where either event happened.

// Words that turn up in almost every galamsey story. Matching on these would
// put the whole archive in one thread.
const COMMON = new Set(`ghana ghanaian ghanaians accra region regional district minister ministry
commission committee government national police service court high circuit
illegal mining miner miners galamsey galamseyers excavator excavators forest
reserve reserves river rivers water lands natural resources security operation
operations task force secretariat january february march april may june july
august september october november december monday tuesday wednesday thursday
friday saturday sunday chairman chief chiefs company limited ltd group news
report reports the and for with from that this have been will not was were
after over under about into more than some other`.split(/\s+/));

function entityTokens(text) {
  const out = new Set();
  // Proper nouns and any word not at the start of a sentence that is capitalised.
  for (const m of String(text).matchAll(/\b([A-Z][A-Za-z'-]{3,})\b/g)) {
    const w = m[1].toLowerCase();
    if (!COMMON.has(w)) out.add(w);
  }
  return out;
}

const shared = (a, b) => [...a].filter(x => b.has(x));

/**
 * Give every record a thread id, so a case can be followed across the months
 * it takes to move from raid to charge to verdict. Two records join the same
 * thread when they share at least MIN distinctive names. Records set by hand
 * in seed.js keep whatever thread they were given.
 */
function threadRecords(map, MIN = 2) {
  const recs = [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
  const tokens = new Map(recs.map(r => [r.id, entityTokens(`${r.title}. ${r.summary}`)]));
  let created = 0;

  for (let i = 0; i < recs.length; i++) {
    const a = recs[i];
    for (let j = 0; j < i; j++) {
      const b = recs[j];
      const hits = shared(tokens.get(a.id), tokens.get(b.id));
      if (hits.length < MIN) continue;
      if (a.thread && b.thread && a.thread !== b.thread) continue; // don't merge hand-set threads
      const id = b.thread || a.thread || ('t-' + hits.sort().slice(0, 2).join('-'));
      if (!b.thread) { b.thread = id; created++; }
      if (!a.thread) { a.thread = id; created++; }
      break;
    }
  }
  return created;
}

const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const normaliseTitle = s => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
const wait = ms => new Promise(r => setTimeout(r, ms));

// Wayback's /web/2/ prefix always resolves to the newest snapshot of a URL,
// so it is a valid archive link whether or not a snapshot exists yet.
const waybackUrl = u => 'https://web.archive.org/web/2/' + u;

const UA = 'SaveAsaaseYaa/1.0 (environmental news archive; contact: hello@saveasaaseyaa.org)';

async function getText(url, ms = 25000) {
  const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// Ask the Internet Archive to take a fresh snapshot. Best effort — a failure
// here must never cost us the record, and the link resolves either way.
async function snapshot(url) {
  try {
    const res = await fetch('https://web.archive.org/save/' + url, {
      headers: { 'user-agent': UA }, signal: AbortSignal.timeout(45000)
    });
    return res.ok;
  } catch { return false; }
}

// Anything without a confirmed snapshot, oldest first — including the seed
// records, which the old code never queued because they arrived pre-written
// rather than freshly crawled. Capped so one run cannot blow the rate limit.
function snapshotBacklog(keep, cap = 15) {
  return [...keep.values()]
    .filter(r => !r.archivedAt && r.source && /^https?:\/\//i.test(r.source.url))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, cap);
}

function loadArchive(seed) {
  const existing = fs.existsSync(OUT)
    ? (JSON.parse(fs.readFileSync(OUT, 'utf8')).incidents || []) : [];
  const keep = new Map();
  // seed.js is the source of truth for anything it defines, so it is applied
  // last and always wins. Applying it first meant a stale copy of the same
  // record in incidents.json silently overwrote every edit you made by hand.
  for (const rec of existing) keep.set(rec.id, rec);
  for (const rec of seed) {
    const prev = keep.get(rec.id);
    // keep the snapshot timestamp; it is earned at runtime, not authored
    keep.set(rec.id, prev && prev.archivedAt ? { ...rec, archivedAt: prev.archivedAt } : rec);
  }
  return keep;
}

function saveArchive(keep) {
  const incidents = [...keep.values()].sort((a, b) => b.date.localeCompare(a.date));
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({
    updated: new Date().toISOString(),
    counts: {
      total: incidents.length,
      verified: incidents.filter(i => i.verified).length,
      automated: incidents.filter(i => !i.verified).length,
      earliest: incidents.length ? incidents[incidents.length - 1].date : null,
      latest: incidents.length ? incidents[0].date : null
    },
    incidents
  }, null, 2));
  return incidents;
}

module.exports = {
  ROOT, OUT, gazetteer, TOPIC,
  clean, tag, parseRss, classify, extractMetrics, geotag,
  slug, normaliseTitle, wait, waybackUrl, getText, snapshot,
  UNPLACED, retagUnplaced, threadRecords, entityTokens,
  loadArchive, saveArchive, snapshotBacklog, UA
};
