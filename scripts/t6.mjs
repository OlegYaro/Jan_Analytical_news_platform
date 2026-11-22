#!/usr/bin/env node
// T-6 (docs/07): верификатор ловит ошибку. Реальный claude (opus по пресету balanced), без сети.
//
// Берёт карточку живого прогона эталона (scripts/golden.mjs пишет путь в <tmp>/regwatch-golden-last.json;
// можно указать --card <card.json>), подменяет act.effective_date на неверную дату при НЕИЗМЕННОЙ цитате,
// кладёт карточку и снимки эталона в новую временную рабочую папку и запускает executors.verify.
// Ожидание: mismatch по act.effective_date (и/или verdict needs_correction).
//
//   node scripts/t6.mjs                 круг 1: один процесс verify (opus)
//   node scripts/t6.mjs --round2        + круг 2: analyze с reviewer_notes → проверка цитат → verify (ещё 2 процесса opus)
//   node scripts/t6.mjs --card <path> [--wrong 2027-03-13]
//
// Код выхода: 0 — ✅; 1 — ❌; 2 — лимит/нет claude/нет карточки.
import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildClaudeEnv, findClaude } from '../src/main/env.ts';
import { writeJsonAtomic } from '../src/main/fs-atomic.ts';
import {
  compareCard,
  formatChecks,
  goldenCandidate,
  goldenContext,
  goldenFetcher,
  loadGoldenCases,
  onceSpawn,
  prepareGoldenAct,
  processOf,
} from '../src/main/golden.ts';
import { runStage as realRunStage } from '../src/main/runner/claude-runner.ts';
import { createStageExecutors } from '../src/main/runner/executors.ts';
import { defaultSettings } from '../src/main/settings/defaults.ts';
import { ensureWorkspace } from '../src/main/workspace.ts';

const ROOT = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const opt = (n) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const round2 = args.includes('--round2');
const WRONG = opt('wrong') ?? '2027-03-13';
const FIELD = 'act.effective_date';

const c = loadGoldenCases(join(ROOT, 'docs', 'golden')).find((x) => x.id === (opt('id') ?? 'UZ-3254-2'));
let cardPath = opt('card');
if (!cardPath) {
  try {
    const last = JSON.parse(readFileSync(join(tmpdir(), 'regwatch-golden-last.json'), 'utf8'));
    cardPath = last.results.find((r) => r.id === c.id)?.cardPath ?? undefined;
  } catch {
    /* нет итога прогона эталона */
  }
}
if (!cardPath || !existsSync(cardPath)) {
  console.log('❌ Нет карточки живого прогона эталона: сначала `node scripts/golden.mjs` или укажите --card <card.json>');
  process.exit(2);
}
const original = JSON.parse(readFileSync(cardPath, 'utf8'));
const env = await buildClaudeEnv();
const bin = findClaude({ env });
if (!bin) {
  console.log('❌ Claude Code не найден');
  process.exit(2);
}

// Рабочая папка: скиллы, снимки эталона (без сети), карточка с подменённой датой.
const ws = realpathSync(mkdtempSync(join(tmpdir(), 'regwatch-t6-')));
ensureWorkspace({ dir: ws, skillsSrc: join(ROOT, 'skills'), goldenSrc: c.dir });
const settings = { ...defaultSettings(homedir()), preset: 'balanced' };
settings.advanced = { ...settings.advanced, saveTranscripts: true };
const ctx = goldenContext(c, ws, settings);
const fetcher = goldenFetcher(c);
const cand = goldenCandidate(c);
const adir = await prepareGoldenAct(c, ctx, fetcher);

const card = structuredClone(original);
const before = card.act.effective_date;
card.act.effective_date = { ...before, value: WRONG };
writeJsonAtomic(join(adir, 'card.json'), card);
console.log(`Карточка: ${cardPath}`);
console.log(`Подмена: ${FIELD} ${JSON.stringify(before.value)} → ${JSON.stringify(WRONG)}; цитата без изменений: «${before.quote}»`);
console.log(`Рабочая папка: ${ws}\n`);

const processes = [];
const ex = createStageExecutors({
  schemasDir: join(ROOT, 'schemas'),
  claudeBin: () => bin,
  claudeEnv: () => env,
  fetcher,
  collector: { collect: async () => ({ ok: true, output: { candidates: [] } }) },
  runStage: async (o) => {
    const r = await realRunStage({ ...o, spawn: onceSpawn() });
    processes.push(processOf(o, r));
    return r;
  },
  log: () => {},
});
const spend = () =>
  processes
    .map(
      (p) =>
        `  ${p.stage} (${p.model}): ${p.ok ? 'ok' : `${p.failure}: ${p.message}`}; вход ${p.inputTokens}, выход ${p.outputTokens}, ` +
        `кэш ${p.cacheRead}/${p.cacheWrite}; $${p.costUsd.toFixed(4)}; ходов ${p.turns ?? '—'}; ${(p.durationMs / 1000).toFixed(0)} с` +
        `${p.fiveHour !== undefined ? `; 5-часовое окно ${(p.fiveHour * 100).toFixed(0)}%` : ''}`,
    )
    .join('\n');

// Проверка цитат кодом (HAL-03) — для справки: в конвейере она тоже поймала бы подмену.
const ev = await ex.checkEvidence(ctx, cand, card);
console.log(`Проверка цитат кодом: ${ev.ok ? 'ok' : `❌ ${ev.failedFields.join(', ')}`} (верификатору НЕ передаётся — проверяем его самостоятельно)`);

// ── Круг 1: VERIFY ──
const v = await ex.verify(ctx, [{ candidate: cand, card, evidenceFailedFields: [], round: 1 }], []);
if (!v.ok) {
  console.log(`❌ VERIFY не вернул результат: ${v.failure}: ${v.message}\n${spend()}`);
  process.exit(v.failure === 'limit' ? 2 : 1);
}
const vc = v.output.cards.find((x) => x.candidate_id === cand.id);
const f = vc?.fields.find((x) => x.field === FIELD || x.field.endsWith('effective_date'));
console.log(`\nVERIFY (круг 1): verdict ${vc?.verdict ?? '—'}`);
for (const x of vc?.fields ?? []) {
  if (x.status !== 'ok') console.log(`  ${x.status} ${x.field}${x.correct_value ? ` → ${x.correct_value}` : ''}: ${x.comment}`);
}
const caught = f?.status === 'mismatch';
console.log(`${caught ? '✅' : '❌'} mismatch по ${FIELD}: ${f ? `${f.status}${f.correct_value ? `, верно: ${f.correct_value}` : ''}` : 'поля нет в ответе'}`);
console.log(`${vc?.verdict === 'needs_correction' ? '✅' : '❌'} verdict needs_correction: ${vc?.verdict ?? '—'}`);
let ok = caught || vc?.verdict === 'needs_correction';

// ── Круг 2: ANALYZE с замечаниями → цитаты → VERIFY ──
if (round2 && ok) {
  const notes = { round: 1, fields: (vc?.fields ?? []).filter((x) => x.status !== 'ok'), evidenceFailedFields: ev.failedFields };
  console.log(`\nКруг 2: analyze с reviewer_notes (${notes.fields.length} полей проверяющего, ${notes.evidenceFailedFields.length} — от проверки цитат)…`);
  const a = await ex.analyze(ctx, cand, notes);
  if (!a.ok) {
    console.log(`❌ analyze круга 2: ${a.failure}: ${a.message}\n${spend()}`);
    process.exit(a.failure === 'limit' ? 2 : 1);
  }
  const fixed = a.output;
  writeJsonAtomic(join(adir, 'card.json'), fixed);
  const fixedOk = fixed.act.effective_date.value === original.act.effective_date.value;
  console.log(`${fixedOk ? '✅' : '❌'} исправлено: ${FIELD} = ${JSON.stringify(fixed.act.effective_date.value)}`);
  const ev2 = await ex.checkEvidence(ctx, cand, fixed);
  console.log(`${ev2.ok ? '✅' : '❌'} проверка цитат после исправления: ${ev2.ok ? 'все подтверждены' : ev2.failedFields.join(', ')}`);
  const v2 = await ex.verify(ctx, [{ candidate: cand, card: fixed, evidenceFailedFields: ev2.failedFields, round: 2 }], []);
  if (!v2.ok) {
    console.log(`❌ VERIFY круга 2: ${v2.failure}: ${v2.message}\n${spend()}`);
    process.exit(v2.failure === 'limit' ? 2 : 1);
  }
  const vc2 = v2.output.cards.find((x) => x.candidate_id === cand.id);
  const f2 = vc2?.fields.find((x) => x.field === FIELD);
  console.log(`VERIFY (круг 2): verdict ${vc2?.verdict ?? '—'}; ${FIELD}: ${f2?.status ?? 'не упомянуто (значит ok)'}`);
  for (const x of vc2?.fields ?? []) if (x.status !== 'ok') console.log(`  ${x.status} ${x.field}${x.correct_value ? ` → ${x.correct_value}` : ''}: ${x.comment}`);
  const confirmed = (f2 ? f2.status === 'ok' : true) && vc2?.verdict !== 'needs_correction';
  console.log(`${confirmed ? '✅' : '❌'} верификатор подтвердил исправление на круге 2`);
  const cmp = compareCard(fixed, c.expected);
  console.log(`\nСверка исправленной карточки с эталоном: ${cmp.passed.length} из ${cmp.checks.length}`);
  if (!cmp.ok) console.log(formatChecks(cmp.checks.filter((x) => !x.ok)));
  ok = ok && fixedOk && confirmed;
} else if (!round2) {
  console.log('\nКруг 2 не запускался (нужен ключ --round2: ещё 2 процесса opus).');
}

console.log(`\nРасход:\n${spend()}\n  итого $${processes.reduce((s, p) => s + p.costUsd, 0).toFixed(4)}`);
console.log(ok ? '\n✅ T-6 пройден' : '\n❌ T-6 не пройден');
process.exit(ok ? 0 : 1);
