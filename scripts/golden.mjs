#!/usr/bin/env node
// Прогон эталонов (T-2, T-16, HAL-06): `npm run golden` — живой прогон на реальном claude.
// Модели — по пресету «Сбалансированно» (balanced): отбор — sonnet, анализ — opus; на эталон ОДИН отбор и ОДИН
// анализ (повтор раннера отключён, бережём лимит). Снимки — из docs/golden/<id>/, сеть не используется:
// код берёт страницы из снимков, модели WebFetch не выдаётся.
//
//   node scripts/golden.mjs            живой прогон (тратит лимит подписки)
//   node scripts/golden.mjs --offline  без модели: целостность эталонов + юнит-тесты src/main/golden.test.ts
//   node scripts/golden.mjs --offline --card <card.json> [--id UZ-3254-2]   сравнить готовую карточку
//   node scripts/golden.mjs --app-cases [--workspace <папка>]   случаи из «Истории» (HAL-07): <рабочая папка>/golden/cases —
//        перечислить, проверить формат и кодовую часть экрана на сохранённом тексте; модель не вызывается
//
// Код выхода: 0 — 100%; 1 — меньше 100% или ошибка эталона; 2 — лимит подписки / нет claude.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildClaudeEnv, findClaude } from '../src/main/env.ts';
import {
  checkAppCases,
  checkGoldenIntegrity,
  formatAppCasesReport,
  formatChecks,
  formatGoldenReport,
  loadGoldenCases,
  runGoldenLive,
  runGoldenOffline,
} from '../src/main/golden.ts';
import { defaultSettings } from '../src/main/settings/defaults.ts';
import { PRESET_MODELS } from '../src/main/settings/presets.ts';

const ROOT = resolve(import.meta.dirname, '..');
const GOLDEN = join(ROOT, 'docs', 'golden');
/** Где лежит итог последнего живого прогона (для scripts/t6.mjs). */
const LAST_RUN_FILE = join(tmpdir(), 'regwatch-golden-last.json');

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

// ── Случаи из приложения (HAL-07): отдельная секция, без модели ──
if (flag('app-cases')) {
  const expandHome = (p) => (p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);
  let ws = opt('workspace') ? resolve(expandHome(opt('workspace'))) : join(homedir(), 'RegWatch');
  if (!opt('workspace')) {
    // Рабочая папка — из настроек приложения (если они есть), иначе ~/RegWatch.
    const settingsFile = join(homedir(), 'Library', 'Application Support', 'RegWatch', 'settings.json');
    try {
      const s = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, 'utf8')) : null;
      if (s && typeof s.workspaceDir === 'string' && s.workspaceDir) ws = s.workspaceDir;
    } catch {
      /* битые настройки — ~/RegWatch */
    }
  }
  const r = checkAppCases(ws);
  console.log(formatAppCasesReport(r));
  process.exit(r.ok ? 0 : 1);
}

const cases = loadGoldenCases(GOLDEN).filter((c) => !opt('id') || c.id === opt('id'));
if (cases.length === 0) {
  console.log('❌ Эталонов не найдено (docs/golden/*.expected.json)');
  process.exit(1);
}

// ── Целостность (всегда) ──
let broken = 0;
console.log(`Эталоны: ${cases.map((c) => c.id).join(', ')}`);
for (const c of cases) {
  const errs = checkGoldenIntegrity(c, { repoRoot: ROOT });
  if (errs.length) {
    broken++;
    console.log(`❌ ${c.id}: эталон повреждён:\n  - ${errs.join('\n  - ')}`);
  } else {
    console.log(`✅ ${c.id}: эталон цел (снимки по sha256, таблицы совпадают с ${c.expected.source_md})`);
  }
}
if (broken) process.exit(1);

if (flag('offline')) {
  const cardPath = opt('card');
  if (cardPath) {
    const card = JSON.parse(readFileSync(cardPath, 'utf8'));
    const c = cases[0];
    const [r] = runGoldenOffline({ cases: [c], repoRoot: ROOT, cards: { [c.id]: card } });
    console.log(`\nКарточка ${cardPath} против ${c.id}:`);
    console.log(formatChecks(r.compare.checks));
    const evBad = r.evidence.filter((x) => !x.ok);
    console.log(`${evBad.length ? '❌' : '✅'} цитаты по снимкам эталона: ${evBad.length ? evBad.map((x) => `${x.field}: ${x.reason}`).join('; ') : 'все подтверждены'}`);
    const total = r.compare.checks.length + 1;
    const ok = r.compare.passed.length + (evBad.length ? 0 : 1);
    console.log(`\nИтого: ${ok} из ${total} (${Math.round((ok / total) * 1000) / 10}%)`);
    process.exit(ok === total ? 0 : 1);
  }
  console.log('\nЮнит-часть (без модели): node --test src/main/golden.test.ts');
  const t = spawnSync(process.execPath, ['--test', join(ROOT, 'src', 'main', 'golden.test.ts')], { stdio: 'inherit' });
  process.exit(t.status === 0 ? 0 : 1);
}

// ── Живой прогон ──
const env = await buildClaudeEnv();
const bin = findClaude({ env });
if (!bin) {
  console.log('❌ Claude Code не найден — живой прогон невозможен (есть --offline)');
  process.exit(2);
}
const settings = { ...defaultSettings(homedir()), preset: 'balanced' };
settings.advanced = { ...settings.advanced, saveTranscripts: true };
const m = PRESET_MODELS.balanced;
console.log(`\nЖивой прогон: claude ${bin}; пресет balanced — отбор ${m.triage}, анализ ${m.analyze}; по одному процессу на этап; без сети.`);
const t0 = Date.now();
const results = await runGoldenLive({
  claudeBin: bin,
  env,
  schemasDir: join(ROOT, 'schemas'),
  skillsSrc: join(ROOT, 'skills'),
  settings,
  cases,
  progress: (s) => console.log(`  [${((Date.now() - t0) / 1000).toFixed(0).padStart(4)} с] ${s}`),
});
console.log(formatGoldenReport(results));

for (const r of results) writeFileSync(join(r.dirs.workspace, `golden-result-${r.id}.json`), JSON.stringify(r, null, 2));
writeFileSync(
  LAST_RUN_FILE,
  JSON.stringify(
    {
      at: new Date().toISOString(),
      results: results.map((r) => ({ id: r.id, percent: r.percent, ...r.dirs })),
    },
    null,
    2,
  ),
);
console.log(`\nИтог прогона записан: ${LAST_RUN_FILE}`);

if (results.some((r) => r.processes.some((p) => p.failure === 'limit'))) {
  console.log('⏸ Исчерпан лимит подписки Claude — прогон не завершён.');
  process.exit(2);
}
process.exit(results.every((r) => r.ok) ? 0 : 1);
