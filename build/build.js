const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ARCHIVE = path.join(ROOT, 'data', 'incidents.json');

// Inline the real archive when it exists — it carries the crawler's work
// (story threads, snapshot stamps, anything backfilled), and the offline
// fallback should look like the live site, not like a subset of it.
// seed.js is only the fallback for a fresh clone that has never crawled.
let records, from;
if (fs.existsSync(ARCHIVE)) {
  records = JSON.parse(fs.readFileSync(ARCHIVE, 'utf8')).incidents || [];
  from = 'data/incidents.json';
}
if (!records || !records.length) {
  records = require(path.join(ROOT, 'crawler', 'seed.js'));
  from = 'crawler/seed.js';
}

const dataUri = f =>
  'data:image/png;base64,' + fs.readFileSync(path.join(ROOT, 'assets', f)).toString('base64');

const html = fs.readFileSync(path.join(__dirname, 'template.html'), 'utf8')
  .replace('__SEED_JSON__', JSON.stringify(records).replace(/<\/script>/gi, '<\\/script>'))
  .replace(/__LOGO__/g, dataUri('logo-web.png'))
  .replace(/__FAVICON__/g, dataUri('favicon.png'));

fs.writeFileSync(path.join(ROOT, 'index.html'), html);
console.log(
  'index.html built —', records.length, 'records from', from + ',',
  records.filter(r => r.thread).length, 'in story threads,',
  (Buffer.byteLength(html) / 1024).toFixed(0), 'KB'
);
