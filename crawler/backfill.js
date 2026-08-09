#!/usr/bin/env node
/**
 * Asaase Yaa Crawler — backfill
 *
 * RSS feeds only carry the last few dozen items, so crawl.js can only build
 * the archive forward from the day you start running it. This reaches
 * backwards, through two indexes that kept what the newsrooms did not.
 *
 *   node crawler/backfill.js gdelt   2017 2026
 *   node crawler/backfill.js wayback 2006 2016
 *   node crawler/backfill.js all     2006 2026
 *
 * How far back each one actually reaches:
 *
 *   gdelt    Structured and reliable, with real headlines and publish dates,
 *            but the DOC 2.0 index starts in January 2017. Nothing earlier
 *            exists in it, whatever date range you pass.
 *
 *   wayback  Reaches as far back as the Internet Archive crawled each outlet
 *            — GhanaWeb to around 1999, MyJoyOnline to about 2004. But the
 *            CDX index stores URLs, not articles, so a headline can only be
 *            recovered where the outlet put it in the path. Sites using
 *            artikel.php?ID=48122 yield nothing usable, and Ghanaian outlets
 *            largely moved to readable slugs between 2010 and 2014. Expect
 *            thin, uneven results before then.
 *
 * Everything landed here is marked verified:false. Backfill produces leads to
 * check, not findings — the older the record, the truer that is.
 */

const L = require('./lib.js');
const seed = require('./seed.js');

const DOMAINS = [
  'myjoyonline.com', 'ghanaweb.com', 'graphic.com.gh', 'citinewsroom.com',
  'adomonline.com', '3news.com', 'gbcghanaonline.com', 'ghanaiantimes.com.gh',
  'dailyguidenetwork.com', 'modernghana.com', 'peacefmonline.com',
  'thechronicle.com.gh', 'newsghana.com.gh', 'asaaseradio.com',
  'starrfm.com.gh', 'ghheadlines.com', 'pulse.com.gh'
];

const SLUG_HINTS = /galamsey|illegal-?mining|small-?scale-?mining|excavator|forest-?reserve|naimos|operation-?vanguard|operation-?halt|blue-?water/i;

const MODES = ['gdelt', 'wayback', 'all'];
const args = process.argv.slice(2);
const mode = args[0] || 'all';
if (!MODES.includes(mode)) {
  console.error(`Unknown mode "${mode}".\n\nUsage:\n  node crawler/backfill.js <${MODES.join('|')}> [fromYear] [toYear]\n\n` +
    '  gdelt    2017 onward — real headlines and publish dates\n' +
    '  wayback  roughly 2010 onward — headlines reconstructed from web addresses\n' +
    '  all      both, slowest\n');
  process.exit(1);
}
const fromYear = +(args[1] || 2017);
const toYear = +(args[2] || new Date().getFullYear());

/* ------------------------------------------------------------------ GDELT */
// The DOC 2.0 API caps a response at 250 articles, so the range is walked a
// month at a time. Anything busier than 250 articles in one month would be
// truncated, and galamsey coverage has never come close.
async function gdelt(keep) {
  const query = '(galamsey OR "illegal mining" OR "small-scale mining") sourcecountry:GH';
  let added = 0, calls = 0;

  for (let y = Math.max(fromYear, 2017); y <= toYear; y++) {
    for (let m = 1; m <= 12; m++) {
      const start = `${y}${String(m).padStart(2, '0')}01000000`;
      const endD = new Date(Date.UTC(y, m, 1));
      if (endD > new Date()) break;
      const end = `${endD.getUTCFullYear()}${String(endD.getUTCMonth() + 1).padStart(2, '0')}01000000`;

      const url = 'https://api.gdeltproject.org/api/v2/doc/doc'
        + `?query=${encodeURIComponent(query)}`
        + `&mode=artlist&maxrecords=250&format=json&sort=datedesc`
        + `&startdatetime=${start}&enddatetime=${end}`;

      let articles = [];
      try {
        const body = await L.getText(url, 40000);
        articles = (JSON.parse(body).articles) || [];
      } catch (e) {
        console.warn(`  ${y}-${String(m).padStart(2,'0')} skipped — ${e.message}`);
        await L.wait(2500);
        continue;
      }
      calls++;

      for (const a of articles) {
        if (!a.url || !a.title) continue;
        const text = a.title;
        if (!L.TOPIC.test(text)) continue;

        const key = L.normaliseTitle(a.title);
        if (keep.seen.has(key)) continue;

        const loc = L.geotag(text, a.title);
        if (!loc) keep.noplace++;

        // seendate looks like 20260315T121500Z
        const date = a.seendate
          ? `${a.seendate.slice(0,4)}-${a.seendate.slice(4,6)}-${a.seendate.slice(6,8)}`
          : `${y}-${String(m).padStart(2,'0')}-01`;

        keep.seen.add(key);
        const id = `gdelt-${date}-${L.slug(a.title)}`;
        keep.map.set(id, {
          id, date,
          category: L.classify(text, a.title),
          title: a.title,
          place: loc ? loc.place : null,
          region: loc ? loc.region : L.UNPLACED,
          lat: loc ? loc.lat : null, lon: loc ? loc.lon : null,
          summary: `Indexed by GDELT from ${a.domain || 'a Ghanaian outlet'}. Headline only — open the source or the archived copy for the full report.`,
          metrics: L.extractMetrics(text),
          source: { name: outletName(a.domain), url: a.url },
          archiveUrl: L.waybackUrl(a.url),
          via: 'gdelt',
          verified: false
        });
        added++;
      }
      // GDELT asks for roughly one call every five seconds.
      await L.wait(5000);
    }
  }
  console.log(`  GDELT: ${added} added over ${calls} monthly queries`);
  return added;
}

/* ---------------------------------------------------------------- Wayback */
// The CDX index lists every URL the Archive has a snapshot of. Filtering the
// path for galamsey terms finds historical articles without fetching a single
// page — but it means the headline has to be reconstructed from the slug.
async function wayback(keep) {
  let added = 0;

  for (const domain of DOMAINS) {
    // The inline flag has to lead the pattern, and the pipes and brackets must
    // be encoded or the query string is truncated at the first one.
    const pattern = '(?i).*(galamsey|illegal.?mining|excavator|forest.?reserve).*';
    const url = 'https://web.archive.org/cdx/search/cdx'
      + `?url=${encodeURIComponent(domain)}&matchType=domain&output=json&fl=original,timestamp`
      + `&collapse=urlkey&from=${fromYear}&to=${toYear}&limit=4000`
      + `&filter=${encodeURIComponent('original:' + pattern)}`;

    let rows = [];
    try {
      rows = JSON.parse(await L.getText(url, 60000));
    } catch (e) {
      console.warn(`  ${domain} skipped — ${e.message}`);
      await L.wait(3000);
      continue;
    }
    rows.shift(); // header row

    let hit = 0;
    for (const [original, timestamp] of rows) {
      const title = titleFromUrl(original);
      if (!title || !L.TOPIC.test(title)) continue;

      const key = L.normaliseTitle(title);
      if (keep.seen.has(key)) continue;

      const loc = L.geotag(title, title);
      if (!loc) keep.noplace++;

      const date = dateFromUrl(original) ||
        `${timestamp.slice(0,4)}-${timestamp.slice(4,6)}-${timestamp.slice(6,8)}`;

      keep.seen.add(key);
      const id = `wb-${date}-${L.slug(title)}`;
      keep.map.set(id, {
        id, date,
        category: L.classify(title, title),
        title,
        place: loc ? loc.place : null,
        region: loc ? loc.region : L.UNPLACED,
        lat: loc ? loc.lat : null, lon: loc ? loc.lon : null,
        summary: `Recovered from the Internet Archive's index of ${domain}. The headline is reconstructed from the article URL and the date may be the date of capture rather than publication — check the archived copy before citing.`,
        metrics: L.extractMetrics(title),
        source: { name: outletName(domain), url: original },
        archiveUrl: `https://web.archive.org/web/${timestamp}/${original}`,
        via: 'wayback',
        verified: false
      });
      added++; hit++;
    }
    console.log(`  ${domain}: ${rows.length} indexed URLs, ${hit} usable`);
    await L.wait(3000); // the CDX endpoint is rate limited and easily annoyed
  }
  console.log(`  Wayback: ${added} added`);
  return added;
}

/* ------------------------------------------------------------------ utils */
function titleFromUrl(u) {
  try {
    const parts = new URL(u).pathname.split('/').filter(Boolean);
    // The headline slug is normally the last meaningful path segment.
    let best = '';
    for (const p of parts) {
      const bare = p.replace(/\.(html?|php|aspx?)$/i, '');
      if (SLUG_HINTS.test(bare) && bare.length > best.length) best = bare;
    }
    if (!best) return null;
    const words = best.replace(/[-_+]+/g, ' ')
      .replace(/\b\d{5,}\b/g, '')        // trailing article IDs
      .replace(/\s+/g, ' ').trim();
    if (words.split(' ').length < 4) return null;   // too short to be a headline
    return words.charAt(0).toUpperCase() + words.slice(1);
  } catch { return null; }
}

const MONTHS = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };

function dateFromUrl(u) {
  // Numeric: /2026/03/15/ or /2026/03/
  let m = u.match(/\/(20\d{2})[\/\-](\d{1,2})(?:[\/\-](\d{1,2}))?[\/\-]?/);
  if (m && +m[2] >= 1 && +m[2] <= 12) return iso(m[1], m[2], m[3]);

  // Named: /2013/May-15th/ — MyJoyOnline's long-running format, and common
  // enough in the Wayback index that skipping it loses most of 2010-2015.
  m = u.match(/\/(20\d{2})\/([A-Za-z]{3,9})-?(\d{1,2})?/);
  if (m) {
    const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mo) return iso(m[1], mo, m[3]);
  }
  return null;
}
const iso = (y, mo, d) =>
  `${y}-${String(mo).padStart(2,'0')}-${String(d || 1).padStart(2,'0')}`;

const NAMES = {
  'myjoyonline.com': 'MyJoyOnline', 'ghanaweb.com': 'GhanaWeb',
  'graphic.com.gh': 'Graphic Online', 'citinewsroom.com': 'Citi Newsroom',
  'adomonline.com': 'Adom Online', '3news.com': '3News',
  'gbcghanaonline.com': 'GBC Ghana', 'ghanaiantimes.com.gh': 'Ghanaian Times',
  'dailyguidenetwork.com': 'Daily Guide', 'modernghana.com': 'Modern Ghana',
  'peacefmonline.com': 'Peace FM', 'thechronicle.com.gh': 'The Chronicle',
  'newsghana.com.gh': 'News Ghana', 'asaaseradio.com': 'Asaase Radio',
  'starrfm.com.gh': 'Starr FM', 'ghheadlines.com': 'Ghana Headlines',
  'pulse.com.gh': 'Pulse Ghana'
};
function outletName(domain) {
  if (!domain) return 'Unknown outlet';
  const d = domain.replace(/^www\./, '');
  return NAMES[d] || d;
}

/* -------------------------------------------------------------------- run */
async function main() {
  console.log(`Backfill — ${mode}, ${fromYear} to ${toYear}`);
  if (mode === 'gdelt' && fromYear < 2017) {
    console.log('  note: the GDELT index starts in 2017, so earlier years return nothing');
  }

  const map = L.loadArchive(seed);
  const keep = { map, seen: new Set([...map.values()].map(r => L.normaliseTitle(r.title))), noplace: 0 };
  const before = map.size;

  if (mode === 'gdelt' || mode === 'all') await gdelt(keep);
  if (mode === 'wayback' || mode === 'all') await wayback(keep);

  const fixed = L.retagUnplaced(map);
  if (fixed) console.log(`  ${fixed} previously unplaced records matched a place this run`);

  const threaded = L.threadRecords(map);
  if (threaded) console.log(`  ${threaded} records linked into running stories`);

  const incidents = L.saveArchive(map);
  console.log(`\n  ${map.size - before} new records, ${keep.noplace} of them with no place identified`);
  console.log(`  archive now spans ${incidents[incidents.length-1]?.date} to ${incidents[0]?.date}`);
  console.log(`  ${incidents.length} records total, ${incidents.filter(i => i.verified).length} verified by hand`);
  console.log('\n  Backfilled records are leads. Read the source before citing any of them.');
}

main().catch(e => { console.error(e); process.exit(1); });
