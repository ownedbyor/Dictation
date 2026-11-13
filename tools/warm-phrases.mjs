#!/usr/bin/env node
// Pre-renders every fixed speech clip (phrases.js + the English word bank in index.html) into the
// Supabase Storage cache, so the app plays them instantly. Safe to re-run: cached clips are skipped.
// Usage: node tools/warm-phrases.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(fileURLToPath(new URL(p, root)), 'utf8');

const SB_URL = 'https://ugtqcfrtstfpzbhxybdm.supabase.co';
const html = read('index.html');
const ANON = /var SBK='([^']+)'/.exec(html)[1];

// Load phrases.js and the English bank (EN_NUM / EN_COL / EN_WRD) from index.html in a sandbox.
const ctx = { globalThis: {}, window: undefined, S: { topic: 'all' } };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(read('phrases.js'), ctx);
const script = html.split('<script>')[1];
const bank = script.slice(script.indexOf('var EN_NUM'), script.indexOf('var EN_PRAISE'));
vm.runInContext(bank + '\nglobalThis.EN = EN_NUM.concat(EN_COL, EN_WRD);', ctx);

let todo = ctx.PH.all(ctx.EN);
console.log(`${todo.length} clips`);
for (let round = 1; todo.length && round <= 20; round++) {
  const batch = todo.slice(0, 20);
  const res = await fetch(`${SB_URL}/functions/v1/dictation-tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON, Authorization: `Bearer ${ANON}` },
    body: JSON.stringify({ warm: batch }),
  }).then((r) => r.json());
  const results = res.results ?? [];
  const failed = results.filter((r) => r.error);
  const done = results.filter((r) => !r.error && !r.skipped).map((r) => r.text);
  console.log(`round ${round}: ${done.length} ready, ${failed.length} failed${failed[0] ? ` (${failed[0].error})` : ''}`);
  todo = todo.filter((t) => !done.includes(t.text));
  if (failed.length && !done.length) await new Promise((r) => setTimeout(r, 60_000)); // likely rate-limited
}
console.log(todo.length ? `${todo.length} clips still missing; run again later.` : 'All clips cached.');
