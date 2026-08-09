# Asaase Yaa Crawler

A crawler that reads Ghanaian newsrooms every six hours, keeps everything about
illegal mining, and holds it in one searchable archive — headline, date, place,
figures, source, and a snapshot that outlives the original page.

A project of Save Asaase Yaa.

```
index.html                  the site (open it, it works)
data/incidents.json         what the crawler writes and the site reads
crawler/crawl.js            forward crawl — reads feeds on a schedule
crawler/backfill.js         backward crawl — GDELT and Wayback
crawler/lib.js              shared classify / tag / archive logic
crawler/seed.js             hand-verified records, never overwritten
crawler/gazetteer.json      ~140 Ghanaian places used to tag reports
assets/                     logo, background removed, plus favicon
build/template.html         source template
build/build.js              inlines data, logo and favicon into index.html
.github/workflows/crawl.yml runs the crawler every six hours
```

## Run it

Open `index.html` in a browser. It ships with 27 verified records baked in and
needs no server.

To pick up crawled data as well, serve the folder over HTTP:

```bash
python3 -m http.server 8000     # then visit localhost:8000
```

Over `file://` the browser blocks the fetch of `data/incidents.json`, so the page
falls back to its built-in records. Over `http://` it loads the crawler's output.

## Run the crawler

```bash
node crawler/crawl.js              # read feeds, update the archive
ARCHIVE=1 node crawler/crawl.js    # also snapshot new links to the Internet Archive
```

Node 18+, no dependencies. It reads RSS from Graphic Online, MyJoyOnline, Citi
Newsroom, GhanaWeb, GBC, Adom, 3News and a set of targeted Google News queries,
then:

1. **Filters** — an item survives only if it mentions illegal mining, excavators,
   changfan, forest reserves or a named task force.
2. **Classifies** — arrest, prosecution, forest, water, reclamation or policy.
   Categories are scored rather than first-match, with headline terms weighted
   triple. *Arrest* covers enforcement action including charging; *prosecution*
   covers everything once a case is before a court, from adjournments and bail
   through to the verdict.
3. **Extracts** — arrests, excavators, hectares, acres, changfan destroyed, NTU.
4. **Places** — matches text against `crawler/gazetteer.json`. Anything with no
   locatable place is dropped rather than guessed at.
5. **Merges** — deduplicates on normalised headline. Records with
   `"verified": true` always win and are never overwritten.
6. **Snapshots** — with `ARCHIVE=1`, pushes each new link to the Internet
   Archive's Save Page Now, spaced six seconds apart to stay inside its rate
   limit. Snapshot failures never cost you the record.

Output goes to `data/incidents.json`.

## How far back it can crawl

Short answer: the forward crawler only reaches days, backfill reaches 2017
cleanly and roughly 2010 patchily, and twenty years is not realistically
available as usable text.

| Route | Reach | What you get |
|---|---|---|
| `crawl.js` (RSS) | Days to weeks | Full headline, summary, publish date. RSS feeds carry only the last few dozen items, so this builds the archive **forward** from the day you start running it. |
| `backfill.js gdelt` | **January 2017 onward** | Real headlines and publish dates, structured JSON, free, no key. The GDELT DOC index does not exist before 2017 — passing an earlier year returns nothing. |
| `backfill.js wayback` | **Roughly 2010 onward**, thinning fast | The Internet Archive's CDX index lists every URL it ever snapshotted, back to about 1999 for GhanaWeb. But it stores *addresses*, not articles. |

The Wayback limitation is the one that decides your real floor. A URL like
`.../galamsey-operators-arrested-at-dunkwa` yields a usable headline. A URL like
`.../artikel.php?ID=48122` yields nothing. Ghanaian outlets moved from numbered
article IDs to readable addresses roughly between 2010 and 2014, so coverage
before then is largely unrecoverable by this method.

There is also a content limit underneath the technical one. "Galamsey" barely
appears in the online Ghanaian press before the mid-2000s, and volume only
really climbs from 2013, when the crackdown on foreign miners began. Even a
perfect index would find little to hold from 2006.

```bash
node crawler/backfill.js gdelt   2017 2026    # the reliable pass, run this first
node crawler/backfill.js wayback 2010 2016    # fills the gap before GDELT
node crawler/backfill.js all     2010 2026    # both, slow, run it overnight
```

Backfill is slow on purpose — GDELT asks for about one call every five seconds,
and the Wayback CDX endpoint throttles aggressively. A full 2010–2026 pass takes
a couple of hours. Run it once, commit the result, and never run it again.

**Everything backfilled is marked `verified: false`, and the site labels each one
with where it came from** — from feed, from GDELT, from Wayback. Treat Wayback
records with particular care: the headline is reconstructed from the web address
and the date may be when the page was captured rather than when it was
published. Read the archived copy before citing any of them.

### Going deeper than this

If you need genuine full-text coverage before 2010, the routes are manual:
the **Daily Graphic** print archive held at the Ghana Library Authority and the
Balme Library at Legon, **GhanaWeb's** own dated news archive, and university
repositories. That's a research project, not a crawl.

**Why it doesn't run in the browser.** News sites don't send CORS headers, so a
web page can't fetch their feeds directly. The crawler runs on a schedule and
commits JSON that the page then loads. The included Actions workflow does this
for you — enable Actions and it starts on its own, with archiving on.

## Theme

The site opens in whichever theme the reader's system prefers, and the control in
the header overrides it for the session. The choice rides in the URL hash, so a
shared search link opens looking the way you sent it.

The palette is built so the six subjects stay distinguishable in both themes —
amber, red, cyan, green, violet and magenta, every one of them at 5:1 contrast or
better against its background. The ground is deliberately near-neutral rather
than brown: warm backgrounds swallow the amber and red, and those two carry the
two most common subjects in the archive.

## Archiving

Snapshotting still runs — with `ARCHIVE=1` every link is pushed to the Internet
Archive, and `archiveUrl` is stored on each record — but the archived copy is no
longer shown as a second link on the page. The preservation is the point; the
extra link was clutter on every row. To put it back, restore the `arch` anchor
in `links()` in `build/template.html`.

## Following a story

Reporting on one case arrives in pieces months apart. The Samreboi raid was
April 2025; the conviction that followed it came in July 2026. Records that
share distinctive names — a company, a concession, a defendant — are threaded
together, and a record in a thread carries a "Follow this story" control that
filters the archive to just that case, ordered oldest first so it reads forwards.

Threading deliberately ignores place. The raid happened at Samreboi and the
verdict was handed down in Accra; what ties them together is that "Akonta" and
"Samreboi" appear in both. Two records join a thread when they share at least
two distinctive names, with common words like *Ghana*, *minister* and *illegal*
excluded — matching on those would put the whole archive in one thread.

Threads are recomputed on every crawl. To force a link the crawler missed, set
`thread: "t-something"` by hand on the records in `seed.js`; hand-set threads are
never merged away.

## Searching and sharing

Search runs client-side across headline, summary, place, region and outlet.
Filters combine — subject chips, outlet, month, and free text all narrow
together — and the URL hash tracks the whole filter state, so any search is a
shareable link:

```
index.html#q=oda+river&cat=arrest
index.html#src=Ghana%20Peace%20Journal&sort=old
```

## Rebuild the page

Edit `build/template.html`, then:

```bash
node build/build.js
```

The build inlines `data/incidents.json` when it exists, so the offline fallback
carries the crawler's work — story threads and all — rather than a stale subset.
It falls back to `seed.js` on a fresh clone that has never crawled.

Records, logo and favicon are inlined as base64, so `index.html` has no
external image dependencies and works opened straight from disk. That puts it at
about 260 KB. To link the files instead, point the two `.replace()` calls in
`build/build.js` at `assets/logo-web.png` and `assets/favicon.png`.

## Adding a verified record

Append to `crawler/seed.js`, then run `node build/build.js`:

```js
{
  id: "arr-2026-08-01-example",
  date: "2026-08-01",
  category: "arrest",              // arrest | prosecution | forest | water | reclamation | policy
  title: "Headline as published",
  place: "Nearest named town, district",
  region: "Ashanti",
  lat: 6.28, lon: -2.05,           // optional, kept for future use
  summary: "What happened, in your own words.",
  metrics: { arrests: 8, excavators: 4 },
  source: { name: "Outlet", url: "https://..." },
  verified: true
}
```

## How places are matched, and the unplaced pile

The crawler has no geocoding service. It matches article text against
`crawler/gazetteer.json`, an index of about 200 Ghanaian towns, districts,
forest reserves and rivers with coordinates. Every candidate is scored:

- a mention in the headline counts triple — that is what the story is about
- within the headline, earlier wins; a place named late is usually incidental
- repeated mentions in the body add weight
- multi-word names get a bonus, since "Manso Adubia" is more specific
  evidence than "Manso"

Name length is deliberately **not** a factor. An earlier version tried names
longest-first and took the first hit, which meant a headline like *"Galamsey pit
collapses at Kibi as Bolgatanga marks its anniversary"* got filed under
Bolgatanga, purely because the string is longer.

A few names — Wa, Ho, Mim, Bole, Banda, Prang, Kade — are ordinary English words
or too short to be distinctive, so they only count when their region is named
alongside them.

### Nothing gets dropped

Records the gazetteer can't place are **kept and parked under `Unplaced`**, not
discarded. Two kinds land there: national stories that name no town
(*"Parliament passes new penalties for illegal mining"*), and stories about a
place the index has never seen — usually a new mining front, which is exactly
the thing you most want to know about.

Every run reprints the unplaced headlines, and every run retries the whole pile.
So adding one gazetteer entry retroactively fixes every old record that mentions
it. You never re-crawl; the coverage is still in the archive, waiting.

```json
"Nyameadom": { "lat": 6.80, "lon": -2.02, "region": "Ashanti" }
```

Then `node crawler/crawl.js` and the record moves itself into Ashanti.

Names are scored, not matched first-come. A few — Wa, Ho, Mim, Bole, Banda,
Prang, Kade — are ordinary English words or too short to be distinctive, so they
only count when their region is named alongside them.

Working the unplaced pile down is the main recurring maintenance job on this
project, and the most valuable one — it is a list of places Ghana's mining
frontier has reached that your index does not yet know about.

## About the logo

`assets/logo.png` is the supplied artwork with its white background cut out.
Wherever it appears it sits on a bone-coloured disc, because the black hands in
the mark are invisible against the dark background otherwise. The artwork itself
is unmodified — no recolouring, no redrawing.

Once you have a live URL, add social card tags to `build/template.html` — they
need absolute URLs, so they can't be filled in until the domain exists:

```html
<meta property="og:image" content="https://yourdomain/assets/logo-large.png">
<meta property="og:title" content="Asaase Yaa Crawler">
<meta property="og:description" content="A searchable archive of Ghanaian reporting on illegal mining.">
```

## Hosting on GitHub, and keeping it crawling

Push the **contents** of this folder as the repo root, so `index.html` is at the
top level. If you upload through the browser rather than git, check afterwards
that `.github/` made it — it's a hidden folder and Finder and Explorer both
silently leave it behind, which gives you a working site with no crawler and no
error to tell you why.

Then three settings. None are on by default and the project needs all three:

1. **Settings → Pages → Source: GitHub Actions.** Not "Deploy from a branch".
   The workflow publishes the site itself.
2. **Settings → Actions → General → Workflow permissions: Read and write.**
   Without this the commit step fails, and the error doesn't say why.
3. **Actions tab → "Crawl and publish" → Run workflow.** Don't wait six hours.
   Run it by hand and read the log — that's where you find out which feeds work.

After that it runs every six hours on its own: crawl, snapshot new links to the
Internet Archive, commit `data/incidents.json`, publish. It also runs on every
push, so editing the site deploys it.

### Why crawling and publishing are in one workflow

A commit made with `GITHUB_TOKEN` does not trigger other workflows — GitHub
blocks that to prevent loops. So with the ordinary "deploy from a branch" Pages
setup, the bot's commits would never trigger a rebuild: the data would keep
updating in the repo while the live site quietly served whatever was there the
last time a human pushed. Doing both in one run avoids it.

### What will actually break

**GitHub disables scheduled workflows after 60 days of repo inactivity.** The
bot's own commits generally don't reset that timer, because they're made with
`GITHUB_TOKEN`. You'll get a warning email with a one-click re-enable, but if you
miss it the crawler just stops. Push something yourself every couple of months,
or set a calendar reminder.

**Cron is best effort.** Runs get delayed or dropped under load. Treat "every six
hours" as roughly, not exactly. That's why the schedule is `17 */6 * * *` rather
than on the hour.

**Feeds go stale.** Expect two or three outlets to start returning 403 or nothing
as sites move CMS. The run log prints a line per feed, so you'll see it. Fix by
editing the `FEEDS` array in `crawler/crawl.js` — usually it's just `/feed/`
versus `/rss` versus `/feed.xml`.

### If it stops for a while

Feeds only hold a couple of weeks, so a month of downtime is a month of coverage
you'd otherwise lose permanently. It isn't lost — run
`node crawler/backfill.js gdelt 2026 2026` and GDELT fills the gap. Worth knowing
before you panic about an outage.

### Other hosts

Netlify, Cloudflare Pages, or a folder on a server all work — it's static files.
But the crawler needs somewhere to run on a timer. GitHub Actions is doing that
job here; elsewhere you'd need cron on a box, or the host's own scheduled
functions.

## Robustness

The page defends itself against malformed data, because an archive assembled
from live feeds and hand edits will eventually contain a broken record. Every
record is normalised on load — a missing source, a bad date, a non-numeric
metric, an unknown category are all coerced to safe defaults rather than
crashing the render. Metric figures that aren't positive finite numbers are not
shown. The crawler applies plausibility ceilings when extracting numbers, so a
headline reading "1,000,000 arrested" contributes no figure rather than a false
one. And a shared link carrying a filter the data no longer contains — a renamed
region, a merged thread, a mistyped month — falls back to the full archive
instead of an empty screen.

## Deliberate limits

- **Automated records are leads, not findings.** They carry the outlet's own
  headline and a link. Anything asserted as fact should be read at the source and
  promoted to `verified: true` by hand.
- **Counts are of records, not events.** A region appearing rarely may mean
  little coverage rather than little mining. The archive measures reporting.
- **Figures are reproduced as their sources state them.** The Forestry Commission
  survey is current to 31 December 2024, so real present-day loss is higher.
- **Allegations stay allegations.** Named individuals and companies appear only
  as their sources named them.
- **Headlines and short summaries only.** Copyright in each article stays with
  the outlet. The archive holds enough to find and cite a piece, and sends
  readers to the source to read it.
- **The report form sends nothing.** It formats text on the user's own device to
  send to NAIMOS, the Forestry Commission, the EPA or the police. Real intake
  would need a backend, a retention policy, and thought about who is exposed if
  it leaks.

## Editing seed.js

`seed.js` is the source of truth. It is applied *after* whatever is already in
`data/incidents.json`, so an edit there always wins — earlier versions applied it
first, which meant a stale copy of the same record silently overwrote every hand
edit. Snapshot timestamps are preserved across the merge, since they are earned
at runtime rather than authored.

## Snapshot backlog

With `ARCHIVE=1`, the crawler snapshots any record that has no confirmed copy —
including the hand-verified seed records, which arrive pre-written rather than
freshly crawled. It works through at most 15 per run at six-second spacing, so a
cold archive clears its backlog over a few runs instead of hitting the rate limit
and failing all at once. Successful snapshots are stamped with `archivedAt` and
never re-sent.

## Sources behind the seed data

Forestry Commission satellite verification (Feb 2026, via Graphic Online) ·
Ministry of Lands and Natural Resources half-year figures (Jul 2026) ·
NAIMOS quarterly briefings · Ghana Water Company turbidity readings (via
Ghanaian Times, May 2026) · EPA Birim pilot (Feb 2026) · Ghana Peace Journal
operation reports · Institute for Security Studies · NCCE Ghana.

Not affiliated with the Government of Ghana, the Forestry Commission, NAIMOS or
the EPA.
