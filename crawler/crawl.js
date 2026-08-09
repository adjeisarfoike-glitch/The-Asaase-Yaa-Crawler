#!/usr/bin/env node
/**
 * Asaase Yaa Crawler — forward crawl
 *
 * Reads public RSS feeds from Ghanaian outlets and Google News queries, keeps
 * items about illegal mining, classifies them, pulls out numbers, tags them to
 * a place, and writes data/incidents.json.
 *
 *   node crawler/crawl.js              read feeds and update the archive
 *   ARCHIVE=1 node crawler/crawl.js    also snapshot new links to the
 *                                      Internet Archive, so the record
 *                                      survives the page going dark
 *
 * Feeds only carry the last few dozen items, so this builds the archive
 * forward from the day you start running it. To reach backwards through
 * years already published, use crawler/backfill.js.
 *
 * Node 18+, no dependencies.
 */

const fs = require('fs');
const path = require('path');
const L = require('./lib.js');
const seed = require('./seed.js');

const GOOGLE_NEWS = q =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-GH&gl=GH&ceid=GH:en`;

const FEEDS = [
  // Targeted queries — broadest coverage, updates fastest.
  { name: 'Google News', url: GOOGLE_NEWS('galamsey when:14d') },
  { name: 'Google News', url: GOOGLE_NEWS('illegal mining Ghana arrest when:14d') },
  { name: 'Google News', url: GOOGLE_NEWS('NAIMOS excavator seized when:14d') },
  { name: 'Google News', url: GOOGLE_NEWS('forest reserve Ghana mining reclamation when:30d') },
  { name: 'Google News', url: GOOGLE_NEWS('"Forestry Commission" Ghana galamsey when:30d') },
  { name: 'Google News', url: GOOGLE_NEWS('Ghana Water Company turbidity river pollution when:30d') },
  { name: 'Google News', url: GOOGLE_NEWS('"Blue Water Guards" OR "Operation Halt" Ghana when:30d') },

  // Direct outlet feeds. Add or remove as feed paths change.
  { name: 'MyJoyOnline', url: 'https://www.myjoyonline.com/feed/' },
  { name: 'Citi Newsroom', url: 'https://citinewsroom.com/feed/' },
  // Graphic runs Joomla — feeds are <section>.feed?type=rss. Verified live.
  { name: 'Graphic Online', url: 'https://www.graphic.com.gh/news.feed?type=rss' },
  { name: 'Graphic Online', url: 'https://www.graphic.com.gh/news/general-news.feed?type=rss' },
  { name: 'GhanaWeb', url: 'https://www.ghanaweb.com/GhanaHomePage/NewsArchive/rss.xml' },
  { name: '3News', url: 'https://3news.com/feed/' },
  { name: 'Adom Online', url: 'https://www.adomonline.com/feed/' },
  { name: 'GBC Ghana', url: 'https://www.gbcghanaonline.com/feed/' },
  { name: 'Asaase Radio', url: 'https://asaaseradio.com/feed/' },
  { name: 'Ghanaian Times', url: 'https://ghanaiantimes.com.gh/feed/' }
];

async function getFeed(feed) {
  try {
    return L.parseRss(await L.getText(feed.url, 20000), feed.name);
  } catch (err) {
    console.warn(`  skipped ${feed.name} — ${err.message}`);
    return [];
  }
}

async function main() {
  console.log(`Asaase Yaa Crawler — ${new Date().toISOString()}`);
  console.log(`Reading ${FEEDS.length} feeds`);

  const raw = (await Promise.all(FEEDS.map(getFeed))).flat();
  console.log(`  ${raw.length} items fetched`);

  const keep = L.loadArchive(seed);
  const seen = new Set([...keep.values()].map(r => L.normaliseTitle(r.title)));

  let added = 0, noplace = 0;
  const fresh = [];

  for (const item of raw) {
    const text = `${item.title}. ${item.summary}`;
    if (!L.TOPIC.test(text)) continue;

    const key = L.normaliseTitle(item.title);
    if (seen.has(key)) continue;

    // A record with no identifiable place is still a real article about
    // galamsey. Park it rather than lose it; retagging below will pick it up
    // as soon as the gazetteer learns the place.
    const loc = L.geotag(text, item.title);
    if (!loc) noplace++;

    const when = new Date(item.date || Date.now());
    const date = (Number.isNaN(when.getTime()) ? new Date() : when).toISOString().slice(0, 10);

    seen.add(key);
    const id = `auto-${date}-${L.slug(item.title)}`;
    keep.set(id, {
      id, date,
      category: L.classify(text, item.title),
      title: item.title,
      place: loc ? loc.place : null,
      region: loc ? loc.region : L.UNPLACED,
      lat: loc ? loc.lat : null, lon: loc ? loc.lon : null,
      summary: L.clean(item.summary).slice(0, 420),
      metrics: L.extractMetrics(text),
      source: { name: item.outlet, url: item.link },
      archiveUrl: L.waybackUrl(item.link),
      via: 'rss',
      verified: false
    });
    fresh.push(item.link);
    added++;
  }

  // Snapshot anything without a confirmed copy, newest first, spaced out —
  // Save Page Now is rate limited and hammering it throttles the whole run.
  // The cap means a cold archive works through its backlog over several runs
  // rather than failing all at once.
  const queue = L.snapshotBacklog(keep);
  if (process.env.ARCHIVE === '1' && queue.length) {
    console.log(`  snapshotting ${queue.length} links to the Internet Archive`);
    let ok = 0;
    for (const rec of queue) {
      if (await L.snapshot(rec.source.url)) { rec.archivedAt = new Date().toISOString(); ok++; }
      await L.wait(6000);
    }
    const left = L.snapshotBacklog(keep, 1e6).length;
    console.log(`  ${ok} accepted${left ? `, ${left} still queued for the next run` : ', backlog clear'}`);
  } else if (queue.length) {
    const total = L.snapshotBacklog(keep, 1e6).length;
    console.log(`  ${total} links have no snapshot — set ARCHIVE=1 to send them to the Internet Archive`);
  }

  // Adding one gazetteer entry should fix every old record that mentions it,
  // so the unplaced pile is retried on every run.
  const fixed = L.retagUnplaced(keep);
  if (fixed) console.log(`  ${fixed} previously unplaced records matched a place this run`);

  const threaded = L.threadRecords(keep);
  if (threaded) console.log(`  ${threaded} records linked into running stories`);

  const incidents = L.saveArchive(keep);
  const unplaced = incidents.filter(i => i.region === L.UNPLACED);
  console.log(`  ${added} new reports added, ${noplace} of them with no place identified`);
  if (unplaced.length) {
    console.log(`  ${unplaced.length} records are unplaced. Full list follows and is written to data/unplaced.txt:`);
    // Print every one to the log, and also drop a plain-text file in the repo
    // so the whole list is easy to read or share without scrolling the log.
    unplaced.forEach((r, i) => console.log(`    ${String(i + 1).padStart(3)}. ${r.title.slice(0, 90)}`));
    try {
      fs.writeFileSync(
        path.join(L.ROOT, 'data', 'unplaced.txt'),
        `# ${unplaced.length} unplaced records — ${new Date().toISOString()}\n` +
        `# Records mentioning no place in crawler/gazetteer.json.\n` +
        `# National commentary belongs here; a real town name means the gazetteer needs it.\n\n` +
        unplaced.map(r => `${r.date}  ${r.title}\n           ${r.source.url}`).join('\n\n') + '\n'
      );
    } catch (e) { console.warn('  could not write data/unplaced.txt —', e.message); }
  }
  console.log(`  ${incidents.length} total records, spanning ${incidents[incidents.length-1]?.date} to ${incidents[0]?.date}`);
}

main().catch(e => { console.error(e); process.exit(1); });
