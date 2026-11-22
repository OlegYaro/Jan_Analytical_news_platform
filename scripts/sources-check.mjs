#!/usr/bin/env node
// Проверка источников (фаза 6, SRC-02..06, T-10) на живых сайтах и настоящей модели — вручную, из терминала.
//
//   node scripts/sources-check.mjs --t10                       T-10: lex.uz (адаптер, без модели) + заведомо битый адрес
//   node scripts/sources-check.mjs --country UZ                одна страна (стартовый набор docs/08)
//   node scripts/sources-check.mjs --country all               все страны по очереди
//   node scripts/sources-check.mjs --discover watched --country UZ   поиск основных законов (SRC-09), ничего не добавляет
//   общие ключи: --data <папка с countries.json> (по умолчанию — новая временная со стартовым набором),
//                --no-model (только то, что код выясняет сам: открывается ли сайт, вход/капча, JavaScript, lex.uz),
//                --workspace <рабочая папка> (по умолчанию — новая временная), --max-window 0.85 (остановиться,
//                если 5-часовое окно Claude заполнено больше), --report <файл.json>
//
// Реальные данные пользователя (~/Library/Application Support/RegWatch, ~/RegWatch) по умолчанию НЕ трогаются.
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFetcher } from '../src/main/collect/fetcher.ts';
import { addSource, loadCountries } from '../src/main/countries/store.ts';
import { buildClaudeEnv, findClaude } from '../src/main/env.ts';
import { defaultSettings } from '../src/main/settings/defaults.ts';
import { checkSources } from '../src/main/sources/checker.ts';
import { discoverSources } from '../src/main/sources/discover.ts';
import { ensureWorkspace } from '../src/main/workspace.ts';

const ROOT = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};
const flag = (n) => args.includes(`--${n}`);
const T10 = flag('t10');
const discoverMode = opt('discover', null);
const target = (opt('country', T10 ? 'UZ' : 'all') ?? 'all').toUpperCase();
const MAX_WINDOW = Number(opt('max-window', '0.85'));
const NO_MODEL = flag('no-model');

const dataDir = opt('data', null) ?? realpathSync(mkdtempSync(join(tmpdir(), 'regwatch-src-data-')));
const ws = opt('workspace', null) ?? realpathSync(mkdtempSync(join(tmpdir(), 'regwatch-src-ws-')));
ensureWorkspace({ dir: ws, skillsSrc: join(ROOT, 'skills'), goldenSrc: join(ROOT, 'docs', 'golden') });
const settings = { ...defaultSettings(process.env.HOME ?? tmpdir()), workspaceDir: ws };
const env = await buildClaudeEnv();
const bin = findClaude({ env });
const fetcher = createFetcher({ perDomainDelayMs: 1500 });

const t0 = Date.now();
const sec = () => `${((Date.now() - t0) / 1000).toFixed(0)} с`;
const icon = { ok: '✅', warn: '⚠', fail: '❌', unresolved: '…' };
const pct = (x) => (typeof x === 'number' ? `${Math.round(x * 100)}%` : '—');
let countries = loadCountries(dataDir);
console.log(`Данные: ${dataDir}\nРабочая папка: ${ws}\nclaude: ${bin ?? 'не найден'}; модель проверки: ${settings.preset} → srcCheck/srcDiscover`);

const base = {
  fetcher,
  workspaceDir: ws,
  countriesDir: dataDir,
  settings,
  schemasDir: join(ROOT, 'schemas'),
  claudeBin: () => bin,
  claudeEnv: () => env,
  onProgress: (p) => process.stdout.write(`  [${sec()}] ${p.text} (${p.done}/${p.total})\n`),
};

if (discoverMode) {
  const r = await discoverSources({ ...base, mode: discoverMode, country: target });
  console.log(`\nПоиск (${discoverMode}) ${target}: ${r.message}; предложено моделью: ${JSON.stringify(r.proposed)}; $${r.costUsd.toFixed(3)}; окно 5 ч ${pct(r.rateLimit?.utilization)}`);
  for (const a of r.actProposals) console.log(`  ✅ ${a.act_type} | ${a.title_original} | № ${a.number} | ${a.url} | ред. ${a.last_edition_date} | ${a.checkNote}`);
  for (const s of r.sourceProposals) console.log(`  ✅ ${s.type} | ${s.name} | ${s.url} | список ${s.listing_url} (${s.listingOk ? 'открывается' : 'не открылся'})`);
  for (const x of r.rejected) console.log(`  ✗ ${x.kind} | ${x.title} | ${x.url} | ${x.reason}`);
  const report = opt('report', join(ws, `discover-${discoverMode}-${target}.json`));
  writeFileSync(report, JSON.stringify(r, null, 2));
  console.log(`Отчёт: ${report}`);
  process.exit(0);
}

let plan;
if (T10) {
  // T-10: lex.uz и заведомо битый адрес (добавляется во временную копию данных, не в данные пользователя).
  const add = addSource(dataDir, 'UZ', { name: 'Битый адрес (T-10)', url: 'https://nonexistent.invalid', type: 'drafts', language: 'ru' });
  if (!add.ok) throw new Error(JSON.stringify(add.errors));
  countries = loadCountries(dataDir);
  const uz = countries.find((c) => c.code === 'UZ');
  const broken = uz.sources.find((s) => s.url === 'https://nonexistent.invalid');
  plan = [{ code: 'UZ', sourceIds: [uz.sources.find((s) => s.url === 'https://lex.uz').id, broken.id], actIds: uz.watchedActs.map((a) => a.id) }];
} else {
  plan = (target === 'ALL' ? countries : countries.filter((c) => c.code === target)).map((c) => ({ code: c.code }));
}

const rows = [];
const results = [];
let total = 0;
let stopped = '';
for (const p of plan) {
  console.log(`\n── ${p.code} (${sec()}) ──`);
  const r = await checkSources({ ...base, ...(NO_MODEL ? { skipModel: true } : {}), country: p.code, ...(p.sourceIds ? { sourceIds: p.sourceIds } : {}), ...(p.actIds ? { actIds: p.actIds } : {}) });
  results.push(r);
  total += r.costUsd;
  const rounds = r.modelCalls.length;
  console.log(`  ${r.message}; вызовов модели ${rounds}, $${r.costUsd.toFixed(3)}, окно 5 ч ${pct(r.rateLimit?.utilization)}`);
  for (const s of r.sources) {
    rows.push({ country: p.code, name: s.name, url: s.url, state: s.state, reason: s.reason, extracted: s.extracted, rounds: s.rounds, method: s.method, finalUrl: s.finalUrl ?? '', recommendation: s.recommendation ?? '', seen: s.seenLatest });
    console.log(`  ${icon[s.state]} ${s.name} — ${s.reason} | извлечено с датами: ${s.extracted} | раундов: ${s.rounds}`);
    for (const x of s.seenLatest) console.log(`       · ${x.date || 'без даты'} ${x.title.slice(0, 90)} ${x.url}`);
  }
  for (const a of r.acts) console.log(`  ${icon[a.state]} акт: ${a.title.slice(0, 70)} — ${a.reason}`);
  for (const u of r.unresolved) {
    const what = `открывается (${u.status}) → ${u.finalUrl}; видимого текста ${u.visibleTextChars} симв.${u.needsJs ? '; похоже, нужен JavaScript' : ''}${u.passwordField ? '; есть поле пароля' : ''}`;
    rows.push({ country: p.code, name: u.name, url: u.url, state: 'unresolved', reason: `без итога (модель не вызывалась): ${what}`, extracted: 0, rounds: 0, method: 'none', finalUrl: u.finalUrl ?? '', recommendation: '', seen: [] });
    console.log(`  … ${u.name} — ${what}`);
  }
  if (r.interrupted && !NO_MODEL) {
    stopped = `проверка прервана на ${p.code}: ${r.interrupted.message}`;
    break;
  }
  const u = r.rateLimit?.utilization;
  if (!NO_MODEL && typeof u === 'number' && u > MAX_WINDOW) {
    stopped = `5-часовое окно ${pct(u)} > ${pct(MAX_WINDOW)} — остановлено после ${p.code}`;
    break;
  }
}

console.log(`\nИтог (${sec()}): источников ${rows.length}: ✅ ${rows.filter((r) => r.state === 'ok').length}, ⚠ ${rows.filter((r) => r.state === 'warn').length}, ❌ ${rows.filter((r) => r.state === 'fail').length}; модель $${total.toFixed(3)}${stopped ? `\n${stopped}` : ''}`);
console.log('\n| Страна | Источник | Итог | Причина | Извлечено с датами | Раунды |');
console.log('|---|---|---|---|---|---|');
for (const r of rows) console.log(`| ${r.country} | ${r.name} | ${icon[r.state]} | ${r.reason.replace(/\|/g, '/')} | ${r.extracted} | ${r.rounds} |`);
const costs = results.map((r) => `${r.country} $${r.costUsd.toFixed(3)} (${r.modelCalls.length} выз.)`).join(', ');
console.log(`\nРасход по странам: ${costs}`);
const report = opt('report', join(ws, 'sources-check-report.json'));
writeFileSync(report, JSON.stringify({ at: new Date().toISOString(), dataDir, ws, stopped, totalUsd: total, rows, results }, null, 2));
console.log(`Отчёт: ${report}`);
