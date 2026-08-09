#!/usr/bin/env node
/**
 * Asaase Yaa Crawler — vocabulary analysis
 *
 *   node crawler/analyse.js
 *
 * Reads the archive and reports on the words in it, so the crawler's
 * vocabulary can be tuned against what Ghanaian newsrooms actually write
 * rather than against what seemed plausible when the rules were drafted.
 *
 * It answers five questions:
 *   1. Does the classifier agree with the categories set by hand?
 *   2. Which rule terms never match anything? (dead vocabulary)
 *   3. Which words mark out one category from the others? (candidate terms)
 *   4. Which names and places recur but are not in the gazetteer?
 *   5. Which phrases recur? (candidate multi-word terms)
 */

const fs = require('fs');
const path = require('path');
const L = require('./lib.js');

const ARCHIVE = path.join(__dirname, '..', 'data', 'incidents.json');
const records = fs.existsSync(ARCHIVE)
  ? (JSON.parse(fs.readFileSync(ARCHIVE, 'utf8')).incidents || [])
  : require('./seed.js');

const gazetteer = JSON.parse(fs.readFileSync(path.join(__dirname, 'gazetteer.json'), 'utf8'));
const gazLower = new Set(Object.keys(gazetteer).flatMap(p => p.toLowerCase().split(/\s+/)));

const STOP = new Set(`the a an and or but of in on at to for from with by as is are was were be been
being it its this that these those they them their he she his her him we us our you your i
have has had do does did will would can could should may might must not no nor so than then
there here when where which who whom whose what why how all any both each few more most other
some such only own same too very just also into over under after before during about against
between through above below up down out off again further once new said says say told which
one two three four five six seven eight nine ten first second third last next year years month
months week weeks day days time times per cent percent`.split(/\s+/));

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9\s'-]/g, ' ').replace(/\s+/g, ' ').trim();
const words = s => norm(s).split(' ').filter(w => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w));
const bar = (n, max, w = 24) => '█'.repeat(Math.max(1, Math.round(n / max * w)));
const pct = (a, b) => b ? (a / b * 100).toFixed(0) + '%' : '—';

console.log(`\nArchive: ${records.length} records, ${new Set(records.map(r => r.source.name)).size} outlets`);
console.log(`Span: ${records.map(r=>r.date).sort()[0]} to ${records.map(r=>r.date).sort().slice(-1)[0]}`);
console.log('='.repeat(72));

/* ---------------------------------------------------------- 1. accuracy */
console.log('\n1. CLASSIFIER vs HAND-SET CATEGORIES');
console.log('   Records set by hand are the only ground truth available.\n');

const labelled = records.filter(r => r.verified && r.category);
let agree = 0; const misses = [];
for (const r of labelled) {
  const got = L.classify(`${r.title}. ${r.summary}`, r.title);
  if (got === r.category) agree++;
  else misses.push({ r, got });
}
console.log(`   ${agree}/${labelled.length} agree (${pct(agree, labelled.length)})`);
if (misses.length) {
  console.log('\n   Disagreements — each is either a rule to fix or a label to revisit:');
  for (const { r, got } of misses) {
    console.log(`     labelled ${r.category.padEnd(12)} classified ${got.padEnd(12)} ${r.title.slice(0, 46)}`);
  }
}

/* ------------------------------------------------------ 2. dead vocabulary */
console.log('\n\n2. RULE TERMS THAT NEVER MATCH');
console.log('   Dead terms cost nothing but hide gaps — they look like coverage.\n');

const corpus = records.map(r => `${r.title}. ${r.summary}`).join('\n');
const RULE_SRC = fs.readFileSync(path.join(__dirname, 'lib.js'), 'utf8');
const ruleBlocks = [...RULE_SRC.matchAll(/category: '(\w+)', re: \/(.+?)\/i \}/g)];

// Split on "|" only at depth zero — otherwise raid(?:s|ed|ing)? reports "ed"
// as if it were a rule term of its own.
function topLevelAlternatives(src) {
  const out = []; let buf = '', depth = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { buf += c + (src[++i] || ''); continue; }
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === '|' && depth === 0) { out.push(buf); buf = ''; continue; }
    buf += c;
  }
  if (buf) out.push(buf);
  return out.filter(Boolean);
}

let dead = 0, live = 0;
for (const [, cat, src] of ruleBlocks) {
  const terms = topLevelAlternatives(src.replace(/^\\b\(\?:/, '').replace(/\)\\b$/, ''));
  const unmatched = terms.filter(t => {
    try { return !(new RegExp('\\b' + t + '\\b', 'i')).test(corpus); }
    catch { return false; }
  });
  live += terms.length - unmatched.length;
  dead += unmatched.length;
  if (unmatched.length) {
    console.log(`   ${cat}: ${terms.length - unmatched.length}/${terms.length} terms fire`);
    console.log(`     silent: ${unmatched.join(' ').slice(0, 200)}`);
  }
}
console.log(`\n   ${live} terms fire, ${dead} silent in this corpus.`);
console.log('   Silent is not necessarily wrong — it may just mean the story');
console.log('   has not been written yet. Recheck after real crawling.');

/* ------------------------------------------------ 3. distinctive vocabulary */
console.log('\n\n3. WORDS THAT MARK OUT EACH CATEGORY');
console.log('   Appears in 2+ records of one category and none of the others.\n');

const byCat = {};
for (const r of records) (byCat[r.category] ||= []).push(r);

const docsWith = {};
for (const r of records) {
  for (const w of new Set(words(`${r.title} ${r.summary}`))) {
    (docsWith[w] ||= new Set()).add(r.id);
  }
}

for (const [cat, rs] of Object.entries(byCat).sort((a, b) => b[1].length - a[1].length)) {
  const ids = new Set(rs.map(r => r.id));
  const marks = [];
  for (const [w, set] of Object.entries(docsWith)) {
    const inCat = [...set].filter(id => ids.has(id)).length;
    const outside = set.size - inCat;
    if (inCat >= 2 && outside === 0) marks.push([w, inCat]);
  }
  marks.sort((a, b) => b[1] - a[1]);
  console.log(`   ${cat} (${rs.length} records)`);
  console.log(`     ${marks.length ? marks.slice(0, 14).map(m => `${m[0]}(${m[1]})`).join('  ') : 'nothing exclusive — too few records'}`);
}

/* ------------------------------------------------------- 4. gazetteer gaps */
console.log('\n\n4. RECURRING NAMES NOT IN THE GAZETTEER');
console.log('   Candidate places, agencies and actors.\n');

const ents = {};
for (const r of records) {
  for (const e of L.entityTokens(`${r.title}. ${r.summary}`)) {
    if (gazLower.has(e)) continue;
    ents[e] = (ents[e] || 0) + 1;
  }
}
const top = Object.entries(ents).filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]);
const max = top.length ? top[0][1] : 1;
for (const [e, n] of top.slice(0, 25)) {
  console.log(`   ${String(n).padStart(3)}  ${bar(n, max, 18).padEnd(19)} ${e}`);
}

/* -------------------------------------------------------------- 5. phrases */
console.log('\n\n5. RECURRING TWO-WORD PHRASES');
console.log('   Multi-word terms are safer than single words — they misfire less.\n');

const grams = {};
for (const r of records) {
  const ws = norm(`${r.title} ${r.summary}`).split(' ');
  for (let i = 0; i < ws.length - 1; i++) {
    if (STOP.has(ws[i]) || STOP.has(ws[i + 1])) continue;
    if (ws[i].length < 3 || ws[i + 1].length < 3) continue;
    const g = ws[i] + ' ' + ws[i + 1];
    grams[g] = (grams[g] || 0) + 1;
  }
}
const gtop = Object.entries(grams).filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 24);
const gmax = gtop.length ? gtop[0][1] : 1;
for (const [g, n] of gtop) console.log(`   ${String(n).padStart(3)}  ${bar(n, gmax, 18).padEnd(19)} ${g}`);

console.log('\n' + '='.repeat(72));
console.log('CAVEAT: with a small, hand-written archive this measures the');
console.log('summaries more than it measures Ghanaian news writing. Re-run it');
console.log('once a few hundred crawled records are in — that is when it starts');
console.log('telling you something you did not already know.\n');
