#!/usr/bin/env node
// Живая проверка скилла translate-ru (LNG-02/03): реальные фрагменты карточек 24/2 и 22/4
// (src/main/digest/fixtures) → createTranslator → настоящий `claude -p` (haiku, пресет «Экономно»), один процесс.
// Сначала дешёвый вызов haiku читает долю 5-часового окна лимита; при ≥ 90 % перевод не запускается.
// Временная рабочая папка; пользовательские данные не трогаются.
//
//   node scripts/translate-live.mjs           проверка лимита + один вызов перевода
//   node scripts/translate-live.mjs --force   без проверки лимита
//
// Код выхода: 0 — все фрагменты переведены и прошли сверку чисел; 1 — есть отвергнутые; 2 — лимит/нет claude/провал.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildClaudeEnv, findClaude } from '../src/main/env.ts';
import { compareNumbers } from '../src/main/checks/numbers.ts';
import { collectTranslatable } from '../src/main/digest/build.ts';
import { runStage as realRunStage } from '../src/main/runner/claude-runner.ts';
import { createTranslator } from '../src/main/runner/executors.ts';
import { defaultSettings } from '../src/main/settings/defaults.ts';
import { ensureWorkspace } from '../src/main/workspace.ts';

const ROOT = resolve(import.meta.dirname, '..');
const force = process.argv.includes('--force');
const env = await buildClaudeEnv();
const bin = findClaude({ env });
if (!bin) {
  console.log('❌ Claude Code не найден');
  process.exit(2);
}
console.log(spawnSync(bin, ['--version'], { env, encoding: 'utf8' }).stdout.trim());

// ── окно лимита ──
if (!force) {
  const cwd = mkdtempSync(join(tmpdir(), 'rw-limit-'));
  const r = spawnSync(
    bin,
    ['-p', 'Reply with the single word OK.', '--model', 'haiku', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'dontAsk',
      '--setting-sources', 'project', '--strict-mcp-config', '--max-turns', '1', '--no-session-persistence', '--tools', ''],
    { cwd, env, encoding: 'utf8', timeout: 120_000 },
  );
  let util = null;
  let resetsAt = null;
  for (const line of (r.stdout ?? '').split('\n')) {
    try {
      const e = JSON.parse(line);
      if (e.type === 'rate_limit_event') {
        const w = e.rate_limit_info?.unifiedWindows?.five_hour ?? e.rate_limit_info;
        util = w?.utilization ?? util;
        resetsAt = w?.resetsAt ?? resetsAt;
      }
    } catch {
      /* не JSON */
    }
  }
  const when = resetsAt ? new Date(resetsAt * 1000).toLocaleString('ru-RU') : '—';
  console.log(`Окно 5 ч: ${util === null ? 'не удалось узнать' : Math.round(util * 100) + ' %'}, сброс ${when}`);
  if (util !== null && util >= 0.9) {
    console.log('⏸ Использовано ≥ 90 % окна — перевод не запускается (повторите после сброса или с --force).');
    process.exit(2);
  }
}

// ── фрагменты из реальных карточек ──
const card = (n) => JSON.parse(readFileSync(join(ROOT, 'src', 'main', 'digest', 'fixtures', `${n}.card.json`), 'utf8'));
const c24 = card('uz-24-2');
const c22 = card('uz-22-4');
const item = (c) => ({ candidate_id: c.candidate_id, key: `reg:${c.candidate_id}`, channel: 'B', kind: 'new', confirmed: true, disputed_fields: [], rounds: 1, title_en: c.act.title_en, card_file: '' });
const digestFrags = collectTranslatable({
  runId: 'live', date: '2026-11-20', checked: { ok: 1, total: 1 }, failures: [],
  countries: [{ code: 'UZ', nameRu: 'Узбекистан', result: { country: 'UZ', status: 'changes', items: [item(c24), item(c22)], duplicates: [], warnings: [], to_commit: [] }, cards: { [c24.candidate_id]: c24, [c22.candidate_id]: c22 } }],
});
// Плюс остальные строки изменений и названия (для подробной проверки скилла: в них есть номера пунктов и даты).
const extra = [...c24.changes, ...c22.changes].map((c) => c.summary_en).concat(c24.act.title_en, c22.act.title_en, c24.act.transition_period.details, c22.change_count.explanation);
const texts = [...new Set([...digestFrags, ...extra])];
console.log(`Фрагментов: ${texts.length} (из письма: ${digestFrags.length})`);

// ── один вызов перевода ──
const ws = realpathSync(mkdtempSync(join(tmpdir(), 'regwatch-translate-')));
ensureWorkspace({ dir: ws, skillsSrc: join(ROOT, 'skills'), goldenSrc: join(ws, 'none') });
const settings = { ...defaultSettings(homedir()), workspaceDir: ws, preset: 'economy' };
settings.advanced = { ...settings.advanced, saveTranscripts: true };
const runDir = join(ws, 'runs', 'live');
let cost = 0;
const tr = createTranslator({
  schemasDir: join(ROOT, 'schemas'),
  claudeBin: () => bin,
  claudeEnv: () => env,
  runStage: async (o) => {
    const r = await realRunStage(o);
    cost += r.costUsd ?? 0;
    console.log(`  процесс: модель ${o.invocation.model}, ${r.ok ? 'ok' : r.failure}, ${(r.durationMs / 1000).toFixed(1)} с, $${(r.costUsd ?? 0).toFixed(4)}, ходов ${r.numTurns ?? '—'}` +
      (r.rateLimit?.utilization !== undefined ? `, окно ${Math.round(r.rateLimit.utilization * 100)} %` : ''));
    return r;
  },
});
const t0 = Date.now();
const out = await tr({ workspaceDir: ws, runDir, settings }, texts);
console.log(`Время: ${((Date.now() - t0) / 1000).toFixed(1)} с; расход $${cost.toFixed(4)}; папка ${join(runDir, 'translate')}`);
if (!out.ok) {
  console.log(`❌ Перевод не получен: ${out.failure} — ${out.message}`);
  process.exit(2);
}
let i = 0;
for (const en of texts) {
  i++;
  const ru = out.output.translations[en];
  const rej = out.output.rejected.find((r) => r.text === en);
  const chk = ru ? compareNumbers(en, ru) : null;
  console.log(`\n[${i}] EN: ${en}`);
  console.log(`    RU: ${ru ?? '— (остаётся английский)'}`);
  console.log(`    сверка: ${ru ? (chk.ok ? '✅ числа, даты, номера, URL совпадают' : '❌ ' + chk.details.join('; ')) : rej ? '❌ ' + rej.diffs.join('; ') : '—'}`);
}
const okN = Object.keys(out.output.translations).length;
console.log(`\nИтого: переведено и сверено ${okN} из ${texts.length}; отвергнуто ${out.output.rejected.length}.`);
process.exit(out.output.rejected.length === 0 && okN === texts.length ? 0 : 1);
