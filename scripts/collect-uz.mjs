// Ручной прогон сборщика по Узбекистану на живом lex.uz (T-1, часть сбора; фаза 4).
// `node scripts/collect-uz.mjs [--from 2026-07-01] [--to 2026-11-17] [--mode backfill|manual|dry_run|scheduled]`
// ≈ 90–100 запросов с паузой ≥ 1 с, 2–3 минуты. Не входит в `npm test`. Модель не вызывается.
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCollector } from '../src/main/collect/collector.ts';
import { createFetcher } from '../src/main/collect/fetcher.ts';
import { actDir } from '../src/main/archive.ts';
import { seedCountries } from '../src/main/countries/seed.ts';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const from = arg('from', '2026-07-01');
const to = arg('to', '2026-11-17');
// T-1 — «Проверить за период» = ретро-прогон: строго по окну, без состояния канала А.
const mode = arg('mode', 'backfill');

const ws = mkdtempSync(join(tmpdir(), 'regwatch-collect-uz-'));
const runId = 'collect-uz';
const uz = seedCountries().find((c) => c.code === 'UZ');
const countryDir = join(ws, 'runs', runId, 'UZ');

// Вежливость поверх задержки fetcher: ≥ 1 с между концом запроса и началом следующего; счётчик запросов.
const base = createFetcher();
let last = 0;
let requests = 0;
const byHost = new Map();
const pause = async () => {
  const wait = last + 1000 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
};
const count = (url) => {
  requests++;
  const h = new URL(url).hostname;
  byHost.set(h, (byHost.get(h) ?? 0) + 1);
};
const fetcher = {
  async get(url, o) {
    await pause();
    count(url);
    try { return await base.get(url, o); } finally { last = Date.now(); }
  },
  async postForm(url, f, o) {
    await pause();
    count(url);
    try { return await base.postForm(url, f, o); } finally { last = Date.now(); }
  },
};

console.log(`Сбор UZ за ${from}…${to}, режим ${mode}; рабочая папка ${ws}`);
const t0 = Date.now();
const collector = createCollector({
  fetcher,
  workspaceDir: ws,
  log: (_ctx, event, text) => console.log(`  [${((Date.now() - t0) / 1000).toFixed(0).padStart(3)} с] ${event}: ${text}`),
});
const res = await collector.collect({ runId, workspaceDir: ws, countryDir, country: uz, mode, window: { from, to } });
const sec = ((Date.now() - t0) / 1000).toFixed(1);

if (!res.ok) {
  console.log(`\nПРОВАЛ сбора: ${res.failure}: ${res.message}`);
  process.exit(1);
}
const out = res.output;
const ch = (x) => out.candidates.filter((c) => c.channel === x).length;
console.log(`\nКандидатов: ${out.candidates.length} — канал А ${ch('A')}, Б ${ch('B')}, В ${ch('C')}`);
console.log(`Числа документов (COV-05): ${out.sourceCounts.map((s) => `${s.sourceId}=${s.count}`).join(', ') || '—'}`);
console.log(`Аномалии: ${out.anomalies.length ? out.anomalies.map((a) => `${a.sourceId} (обычно ${a.median})`).join('; ') : 'нет'}`);
console.log('Сбои источников:');
for (const f of out.sourceFailures) console.log(`  ${f.critical ? 'КРИТИЧНО' : 'предупреждение'} ${f.sourceId}: ${f.message}`);
if (!out.sourceFailures.length) console.log('  нет');
if (out.sourceFailures.some((f) => f.critical)) {
  console.log('  → оркестратор поставил бы стране failed:source (COV-04): источник своего типа не прочитан.');
}

let missing = 0;
const want = [
  { reg: '3254-1', label: 'пост. ЦБ № 19/8 от 08.07.2026, рег. 3254-1' },
  { reg: '3254-2', label: 'пост. ЦБ № 24/2 от 17.09.2026, рег. 3254-2' },
];
console.log('');
for (const w of want) {
  const c = out.candidates.find((x) => x.key === `reg:${w.reg}`);
  if (!c) {
    missing++;
    console.log(`❌ ${w.label}: не найден среди кандидатов`);
    continue;
  }
  console.log(`✅ ${w.label}: ${c.id}, канал ${c.channel}, дата ${c.date}, ${c.url}${c.maybeUpdate ? ', maybeUpdate' : ''}`);
  console.log(`   ${c.title_original.slice(0, 160)}`);
}

console.log('\nСнимки канала А:');
for (const c of out.candidates.filter((x) => x.channel === 'A')) {
  const dir = actDir(ws, runId, 'UZ', c.id);
  try {
    const txt = readFileSync(join(dir, 'snapshot.txt'), 'utf8');
    const html = statSync(join(dir, 'snapshot.html')).size;
    const meta = JSON.parse(readFileSync(join(dir, 'snapshot.json'), 'utf8'));
    const has = (s) => (txt.includes(s) ? 'да' : 'нет');
    console.log(`  ${c.id} (${c.key}): ${dir}`);
    console.log(`    snapshot.html ${html} байт, snapshot.txt ${Buffer.byteLength(txt)} байт; «3254» — ${has('3254')}, «24/2» — ${has('24/2')}, «24-2» — ${has('24-2')}`);
    for (const r of meta.related) console.log(`    связанная: ${r.label} — ${r.ok ? r.text : `не сохранена (${r.message})`}`);
  } catch {
    console.log(`  ${c.id} (${c.key}): снимка нет`);
  }
}

console.log(`\nЗапросов ${requests} (${[...byHost].map(([h, n]) => `${h} ${n}`).join(', ')}), время ${sec} с, вызовов модели 0.`);
console.log(`Рабочая папка со снимками: ${ws} (журнал сбора — выше в консоли)`);
if (missing) process.exitCode = 1;
