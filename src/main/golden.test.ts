// Эталоны (HAL-06, T-2, T-16) без модели и без сети: целостность эталона, сравнение карточки, построенной из
// реальных снимков с дословными цитатами, искажённые карточки, сквозной T-14 на боевых исполнителях.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import type { Card, Fact, TriageOutput, Verification } from '../shared/schema-types.ts';
import { checkCardEvidence, evidenceFailures } from './checks/evidence.ts';
import {
  checkGoldenIntegrity,
  compareCard,
  goldenCandidate,
  goldenCountry,
  goldenFetcher,
  goldenSnapshotTexts,
  loadGoldenCases,
  normUrl,
  parseLocation,
  prepareGoldenAct,
  resolveLocation,
  runGoldenLive,
  runGoldenOffline,
} from './golden.ts';
import type { GoldenCase } from './golden.ts';
import type { RunStageOptions, StageResult } from './runner/claude-runner.ts';
import { createStageExecutors } from './runner/executors.ts';
import { Orchestrator } from './runner/orchestrator.ts';
import { settingsFor } from './runner/fixtures/orchestrator-stubs.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const GOLDEN = join(ROOT, 'docs', 'golden');
const SCHEMAS = join(ROOT, 'schemas');
const SKILLS = join(ROOT, 'skills');
const TODAY = '2026-11-18';

const CASE: GoldenCase = loadGoldenCases(GOLDEN).find((c) => c.id === 'UZ-3254-2')!;
const TEXTS = goldenSnapshotTexts(CASE);

const AMEND = 'https://lex.uz/docs/8530799';
const BASE = 'https://www.lex.uz/docs/-4888804';
const ONDATE = `${BASE}?ONDATE=13.01.2027`;
const U = (): Fact<never> => ({ value: 'unknown', quote: '', url: '' });
const f = <T>(value: T, quote: string, url = AMEND): Fact<T> => ({ value, quote, url });

type Sig = Card['changes'][number]['significance'];
type Dif = Card['changes'][number]['implementation_difficulty'];

/** Изменения: место, вид, цитата (дословно из snapshot.txt акта 24/2), значимость и сложность по таблице эталона. */
const CHANGES: Array<[string, Card['changes'][number]['kind'], string, Sig, Dif]> = [
  ['Point 2, paragraph 2', 'rewritten', '2-bandning ikkinchi xatboshisi quyidagi tahrirda bayon etilsin', 'not_significant', 'low'],
  ['Point 3, paragraphs 1, 2, 6', 'rewritten', 'birinchi va ikkinchi xatboshilar quyidagi tahrirda bayon etilsin', 'less_significant', 'low'],
  ['Point 5', 'added', 'quyidagi mazmundagi sakkizinchi xatboshi bilan toʻldirilsin', 'less_significant', 'low'],
  ['Point 8', 'added', 'quyidagi mazmundagi uchinchi va toʻrtinchi xatboshilar bilan toʻldirilsin', 'significant', 'high'],
  ['Point 11', 'added', '11-band quyidagi mazmundagi xatboshi bilan toʻldirilsin', 'not_significant', 'low'],
  ['Point 15', 'added', '15-band quyidagi mazmundagi xatboshilar bilan toʻldirilsin', 'not_significant', 'low'],
  ['Point 16', 'rewritten', 'Audit qoʻmitasining raisi kengashning mustaqil aʼzosi boʻlishi va kengash raisi boʻlmasligi lozim.', 'significant', 'medium'],
  ['Point 19', 'rewritten', 'mazkur qoʻmitani tashkil etish tizimli ahamiyatga molik banklar uchun majburiy hisoblanadi', 'significant', 'medium'],
  ['Chapter 8¹ (points 50¹–50⁵)', 'new_chapter', 'Rahbar kadrlar zaxirasini shakllantirish va rivojlantirish', 'less_significant', 'medium'],
  ['Point 53', 'added', 'quyidagi mazmundagi oʻn uchinchi xatboshi bilan toʻldirilsin', 'less_significant', 'low'],
];

/** Карточка 3254-2 по эталону, все цитаты — реальные выдержки из снимков (акт и related/1 — Положение). */
function goldenCard(): Card {
  return {
    candidate_id: 'lexuz-8530799',
    country: 'UZ',
    act: {
      type: f('Central Bank Board resolution', 'Oʻzbekiston Respublikasi Markaziy banki boshqaruvining qarori'),
      issuer: f('Central Bank of the Republic of Uzbekistan', 'Oʻzbekiston Respublikasi Markaziy banki'),
      number: f('24/2', 'Toshkent sh., 2026 yil 17 sentabr, 24/2-son'),
      title_original: f(
        'Tijorat banklarida korporativ boshqaruv toʻgʻrisidagi nizomga oʻzgartirish va qoʻshimchalar kiritish haqida',
        'Tijorat banklarida korporativ boshqaruv toʻgʻrisidagi nizomga oʻzgartirish va qoʻshimchalar kiritish haqida',
      ),
      title_en: 'On amendments and additions to the Regulation on corporate governance in commercial banks',
      adoption_date: f('2026-09-17', 'Oʻzbekiston Respublikasi Markaziy banki boshqaruvining 2026-yil 17-sentabrdagi 24/2-son qaroriga'),
      registration_number: f('3254-2', 'roʻyxat raqami 3254-2'),
      registration_date: f('2026-10-09', 'Oʻzbekiston Respublikasi Adliya vazirligi tomonidan 2026 yil 9 oktabrda roʻyxatdan oʻtkazildi'),
      publication_date: f('2026-10-12', '(Qonunchilik maʼlumotlari milliy bazasi, 12.10.2026 y., 10/26/3254-2/1020-son)'),
      effective_date: f('2027-01-13', 'Кучга кириш санаси 13.01.2027'),
      transition_period: {
        exists: f<'yes' | 'no'>('no', 'Mazkur qaror rasmiy eʼlon qilingan kundan eʼtiboran uch oydan keyin kuchga kiradi.'),
        details: 'In force 3 months after official publication; no transition period.',
      },
      original_language: 'uz',
      official_russian_text: 'no',
    },
    stage: 'published',
    update_of: null,
    amends: {
      base_act_title: f('Regulation on corporate governance in commercial banks', 'Tijorat banklarida korporativ boshqaruv toʻgʻrisidagi nizom'),
      base_act_number: f('3254', '12/8-son qarori (roʻyxat raqami 3254, 2020-yil 30-iyun)'),
      base_act_url: BASE,
      prior_amendments: [{ number: '3254-1', date: '2026-07-08', url: BASE }],
    },
    scope: {
      applies_to: f(
        'Commercial banks, including microfinance banks and banks carrying out Islamic banking',
        'Mazkur Nizom tijorat banklarida, shu jumladan mikromoliya banklarida, shuningdek islomiy bank faoliyatini amalga oshiruvchi banklar va mikromoliya banklarida',
        BASE,
      ),
      not_applies_to: U(),
    },
    change_count: {
      annex_items: f<number>(10, '10. 53-bandda:'),
      // 14 отметок видно в related/2, но число нигде не написано → процитировать нельзя (allow_unknown).
      legal_base_marks: U(),
      explanation: 'Annex has 10 items; the consolidated text on 13.01.2027 shows 14 change marks (3 in point 3, 3 in point 53).',
    },
    changes: CHANGES.map(([location, kind, quote, significance, implementation_difficulty], i) => ({
      n: i + 1,
      location,
      kind,
      summary_en: `Change ${i + 1}`,
      significance,
      significance_reason: 'test',
      implementation_difficulty,
      difficulty_reason: 'test',
      quote,
      url: AMEND,
    })),
    links: { amending_act: AMEND, current_version: BASE, version_on_effective_date: ONDATE },
    unknowns: ['scope.not_applies_to', 'change_count.legal_base_marks'],
    notes: '',
  };
}

const failedFields = (card: Card, today = TODAY): string[] => compareCard(card, CASE.expected, { today }).failed.map((x) => x.field);

// ───────── Эталон ─────────

test('эталон UZ-3254-2: загружается, снимки на месте и не изменены, повторяет таблицы .md', () => {
  assert.ok(CASE, 'эталон UZ-3254-2 не найден');
  assert.deepEqual(checkGoldenIntegrity(CASE, { repoRoot: ROOT }), []);
  assert.equal(CASE.expected.candidate.url, AMEND);
  assert.equal(CASE.expected.triage.decision, 'relevant');
  assert.equal(TEXTS.length, 3);
});

test('целостность: изменённый снимок и расхождение с .md находятся', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rw-golden-int-'));
  cpSync(GOLDEN, dir, { recursive: true });
  writeFileSync(join(dir, 'UZ-3254-2', 'related', '2.html'), readFileSync(join(dir, 'UZ-3254-2', 'related', '2.html'), 'utf8') + ' ');
  const file = join(dir, 'UZ-3254-2.expected.json');
  const e = JSON.parse(readFileSync(file, 'utf8'));
  e.card_fields['act.effective_date'].golden = '2027-03-13';
  e.changes_expect[6].significance.tolerance = 1;
  writeFileSync(file, JSON.stringify(e));
  const errs = checkGoldenIntegrity(loadGoldenCases(dir)[0]!);
  assert.ok(errs.some((x) => x.includes('related/2.html') && x.includes('изменён')), errs.join('\n'));
  assert.ok(errs.some((x) => x.includes('act.effective_date')), errs.join('\n'));
  assert.ok(errs.some((x) => x.includes('#7') && x.includes('допуск')), errs.join('\n'));
});

// ───────── Карточка на реальных снимках ─────────

test('карточка по эталону: все цитаты в снимках (HAL-02/03) и 100% совпадений с эталоном (T-2)', () => {
  const card = goldenCard();
  const ev = checkCardEvidence(card, TEXTS);
  assert.deepEqual(evidenceFailures(ev), [], JSON.stringify(ev.filter((x) => !x.ok)));
  const r = compareCard(card, CASE.expected, { today: TODAY });
  assert.equal(r.ok, true, JSON.stringify(r.failed, null, 1));
  assert.equal(r.failed.length, 0);
  assert.ok(r.passed.includes('act.effective_date'));
  assert.ok(r.passed.includes('changes[].location'));
  assert.ok(r.passed.includes('changes(16).significance'));
  // legal_base_marks = unknown допустим, 14 — тоже верно
  const c14 = goldenCard();
  c14.change_count.legal_base_marks = f<number>(14, '');
  assert.deepEqual(failedFields(c14), []);
  const c13 = goldenCard();
  c13.change_count.legal_base_marks = f<number>(13, '');
  assert.deepEqual(failedFields(c13), ['change_count.legal_base_marks']);
});

test('искажение: неверная дата вступления → ❌ ровно по этому полю', () => {
  const c = goldenCard();
  c.act.effective_date = f('2027-03-13', 'Кучга кириш санаси 13.01.2027');
  assert.deepEqual(failedFields(c), ['act.effective_date']);
  // Код цитат ловит то же самостоятельно (HAL-03).
  assert.deepEqual(evidenceFailures(checkCardEvidence(c, TEXTS)), ['act.effective_date']);
});

test('искажение: лишняя и пропавшая локация → ❌ по множеству мест (и по строке эталона)', () => {
  const extra = goldenCard();
  extra.changes.push({ ...extra.changes[0]!, n: 11, location: 'Point 20' });
  const r1 = compareCard(extra, CASE.expected, { today: TODAY });
  assert.deepEqual(r1.failed.map((x) => x.field), ['changes[].location']);
  assert.match(r1.failed[0]!.reason, /лишние: 20/);

  const missing = goldenCard();
  missing.changes = missing.changes.filter((c) => c.location !== 'Point 16');
  const r2 = compareCard(missing, CASE.expected, { today: TODAY });
  assert.deepEqual(r2.failed.map((x) => x.field), ['changes[].location', 'changes(16).significance', 'changes(16).difficulty']);
  assert.match(r2.failed[0]!.reason, /нет: 16/);

  const chapter = goldenCard();
  chapter.changes = chapter.changes.filter((c) => c.kind !== 'new_chapter');
  assert.match(compareCard(chapter, CASE.expected, { today: TODAY }).failed[0]!.reason, /нет: глава 8¹/);
});

test('значимость: строка 7 = not_significant → ❌ (строго significant); ±1 ступень работает', () => {
  const c = goldenCard();
  c.changes[6]!.significance = 'not_significant';
  assert.deepEqual(failedFields(c), ['changes(16).significance']);
  const c2 = goldenCard();
  c2.changes[6]!.significance = 'less_significant'; // строгая строка: и на одну ступень нельзя
  assert.deepEqual(failedFields(c2), ['changes(16).significance']);

  const ok1 = goldenCard();
  ok1.changes[0]!.significance = 'less_significant'; // строка 1: not_significant ±1
  ok1.changes[3]!.implementation_difficulty = 'medium'; // строка 4: high ±1
  ok1.changes[6]!.implementation_difficulty = 'low'; // строка 7: низкая–высокая
  ok1.changes[9]!.implementation_difficulty = 'high'; // строка 10: низкая–средняя ±1
  assert.deepEqual(failedFields(ok1), []);

  const bad2 = goldenCard();
  bad2.changes[0]!.significance = 'significant'; // две ступени
  bad2.changes[3]!.implementation_difficulty = 'low'; // две ступени
  assert.deepEqual(failedFields(bad2), ['changes(2).significance', 'changes(8).difficulty']);
});

test('место разбито на несколько строк: глава 8¹ пятью пунктами 50¹–50⁵, берётся наибольшая значимость', () => {
  const c = goldenCard();
  const ch = c.changes.find((x) => x.kind === 'new_chapter')!;
  c.changes = c.changes.filter((x) => x !== ch);
  for (const [i, p] of ['50¹', '50²', '50³', '50⁴', '50⁵'].entries()) {
    c.changes.push({ ...ch, location: `Point ${p}`, significance: i === 0 ? 'less_significant' : 'not_significant', implementation_difficulty: 'low' });
  }
  assert.deepEqual(failedFields(c), []);
  // Текст снимка склеивает надстрочный индекс: «81-bob», «501» → глава 8¹.
  const flat = goldenCard();
  flat.changes.find((x) => x.kind === 'new_chapter')!.location = '81-bob (501–505-bandlar)';
  const r = compareCard(flat, CASE.expected, { today: TODAY });
  assert.equal(r.ok, true, JSON.stringify(r.failed));
  assert.match(r.checks.find((x) => x.field === 'changes[].location')!.reason, /надстрочный/);
});

test('unknown: вне allow_unknown → ❌; из allow_unknown → ✅', () => {
  const c = goldenCard();
  c.act.publication_date = U();
  assert.deepEqual(failedFields(c), ['act.publication_date']);
  const c2 = goldenCard();
  c2.act.title_original = U(); // не поле эталона, но unknown там не допускается
  assert.deepEqual(failedFields(c2), ['unknown (прочие поля)']);
  const c3 = goldenCard();
  c3.act.official_russian_text = 'unknown';
  assert.deepEqual(failedFields(c3), []);
  const c4 = goldenCard();
  c4.act.official_russian_text = 'yes';
  assert.deepEqual(failedFields(c4), ['act.official_russian_text']);
  // legal_base_marks = unknown допустим, только если подсчёт 14 есть в explanation (ANA-05).
  const c5 = goldenCard();
  c5.change_count.explanation = 'Annex has 10 items; marks not counted.';
  assert.deepEqual(failedFields(c5), ['change_count.legal_base_marks']);
});

test('живой прогон 1 (18.11.2026): номер базового акта «12/8 (… No. 3254 …)» → ❌ и в эталоне, и в проверке цитат', () => {
  const c = goldenCard();
  c.amends.base_act_number = f('12/8 (MoJ registration No. 3254 of 30.06.2020)', '12/8-son qarori (roʻyxat raqami 3254, 2020-yil 30-iyun)');
  assert.deepEqual(failedFields(c), ['amends.base_act_number']);
  assert.deepEqual(evidenceFailures(checkCardEvidence(c, TEXTS)), ['amends.base_act_number']);
});

test('мягкие поля: ключевые слова сферы, номер предыдущей поправки, адреса, язык', () => {
  const c = goldenCard();
  c.scope.applies_to = f('Коммерческие банки, в том числе микрофинансовые и осуществляющие исламский банкинг', c.scope.applies_to.quote, BASE);
  c.act.issuer = f('Oʻzbekiston Respublikasi Markaziy banki', 'Oʻzbekiston Respublikasi Markaziy banki');
  c.act.number = f('No. 24/2', c.act.number.quote);
  c.amends.prior_amendments = [{ number: 'Resolution 19/8 (reg. No. 3254-1)', date: '2026-07-08', url: BASE }];
  c.links.version_on_effective_date = 'lex.uz/docs/-4888804?ONDATE=13.01.2027%2000';
  c.links.amending_act = 'https://www.lex.uz/docs/8530799/';
  assert.deepEqual(failedFields(c), []);

  const bad = goldenCard();
  bad.scope.applies_to = f('Commercial banks', 'Tijorat banklarida korporativ boshqaruv toʻgʻrisidagi nizom');
  bad.amends.prior_amendments = [{ number: '3254-11', date: 'unknown', url: '' }];
  bad.links.current_version = 'https://lex.uz/docs/4888804';
  bad.act.original_language = 'ru';
  assert.deepEqual(failedFields(bad), ['act.original_language', 'amends.prior_amendments', 'scope.applies_to', 'links.current_version']);
  assert.equal(normUrl('https://WWW.lex.uz/docs/-4888804?ONDATE=13.01.2027 00'), 'lex.uz/docs/-4888804?ondate=13.01.2027');
});

test('стадия зависит от даты прогона: до 13.01.2027 published, с 13.01.2027 in_force', () => {
  assert.deepEqual(failedFields(goldenCard(), '2027-01-12'), []);
  assert.deepEqual(failedFields(goldenCard(), '2027-01-13'), ['stage']);
  const c = goldenCard();
  c.stage = 'in_force';
  assert.deepEqual(failedFields(c, '2027-02-01'), []);
  assert.deepEqual(failedFields(c, TODAY), ['stage']);
});

test('места изменений: «Point 16», «п. 16», «пункт 16», «16-банд», главы и абзацы', () => {
  const cl = CASE.expected.change_locations;
  for (const s of ['Point 16', 'п. 16', 'пункт 16', '16-банд', '16-band', 'Пункт 16 (изложен заново)', 'Annex item 7: point 16', '16']) {
    assert.deepEqual(resolveLocation(s, cl).keys, ['16'], s);
  }
  assert.deepEqual(parseLocation('Chapter 8¹ (points 50¹–50⁵)'), { points: ['50^1', '50^2', '50^3', '50^4', '50^5'], chapters: ['8^1'] });
  for (const s of ['Chapter 8¹ (points 50¹–50⁵)', 'глава 8¹', '8¹-bob', 'Chapter 8<sup>1</sup>', 'Point 50³', 'new chapter 8^1']) {
    assert.deepEqual(resolveLocation(s, cl).keys, ['ch:8^1'], s);
  }
  assert.deepEqual(parseLocation('П. 3, абз. 1, 2, 6').points, ['3']);
  assert.deepEqual(parseLocation('Point 2, paragraph 2').points, ['2']);
  assert.deepEqual(parseLocation('Point 53 – 3 paragraphs added, 1 rewritten').points, ['53']);
  assert.deepEqual(parseLocation('Points 3 and 5').points, ['3', '5']);
  assert.deepEqual(resolveLocation('Point 81', cl).keys, ['ch:8^1']); // склеенный надстрочный индекс
  // Живой прогон 2 (18.11.2026): надстрочный индекс через дефис.
  assert.deepEqual(resolveLocation('Annex item 9 – new Chapter 8-1 (pp. 50-1 – 50-5)', cl).keys, ['ch:8^1']);
  assert.deepEqual(parseLocation('pp. 50-1 – 50-5').points, ['50^1', '50^2', '50^3', '50^4', '50^5']);
  assert.deepEqual(resolveLocation('Annex item 2 – Regulation p.3, paragraphs 1, 2 and 6', cl).keys, ['3']);
  assert.deepEqual(parseLocation('Points 2-5').points, ['2', '3', '4', '5']); // восходящий — диапазон
});

test('runGoldenOffline: целостность + сравнение готовой карточки + цитаты по снимкам эталона', () => {
  const [r] = runGoldenOffline({ cases: [CASE], repoRoot: ROOT, cards: { 'UZ-3254-2': goldenCard() }, today: TODAY });
  assert.deepEqual(r!.integrity, []);
  assert.equal(r!.compare!.ok, true);
  assert.deepEqual(evidenceFailures(r!.evidence!), []);
  const [only] = runGoldenOffline({ cases: [CASE] });
  assert.equal(only!.compare, undefined);
});

// ───────── Живой прогон на подменённом runStage (без claude и без сети) ─────────

function fakeRun(handler: (stage: string, input: Record<string, unknown>, n: number) => unknown) {
  const calls: Array<{ stage: string; input: Record<string, any>; opts: RunStageOptions }> = [];
  const runStage = async (opts: RunStageOptions): Promise<StageResult> => {
    const inputPath = opts.invocation.prompt.split(' ').slice(1).join(' ');
    const input = JSON.parse(readFileSync(inputPath, 'utf8')) as Record<string, unknown>;
    calls.push({ stage: opts.invocation.stage, input, opts });
    const output = handler(opts.invocation.stage, input, calls.filter((c) => c.stage === opts.invocation.stage).length);
    assert.deepEqual(opts.validate(output), { ok: true }, `${opts.invocation.stage}: ответ-заглушка не проходит схему`);
    return { ok: true, output, usage: { input_tokens: 100, output_tokens: 20 }, modelUsage: null, costUsd: 0.05, durationMs: 5, attempts: 1, exitCode: 0, numTurns: 4, denied: [] };
  };
  return { runStage, calls };
}

const relevant = (input: Record<string, unknown>): TriageOutput => ({
  country: 'UZ',
  items: (input['candidates'] as Array<{ id: string }>).map((c) => ({ id: c.id, decision: 'relevant', reason_code: null, reason_text: 'Amends CB governance regulation', confidence: 'high' })),
});

test('runGoldenLive (заглушка вместо claude): отбор → анализ на снимках эталона → цитаты → 100%, без сети', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'rw-golden-live-'));
  const fr = fakeRun((stage, input) => (stage === 'triage' ? relevant(input) : goldenCard()));
  const [r] = await runGoldenLive({
    claudeBin: '/usr/local/bin/claude',
    env: {},
    schemasDir: SCHEMAS,
    skillsSrc: SKILLS,
    settings: settingsFor(ws, { preset: 'balanced' }),
    cases: [CASE],
    workDir: ws,
    today: TODAY,
    runStage: fr.runStage,
  });
  assert.equal(r!.ok, true, JSON.stringify(r!.checks.filter((c) => !c.ok), null, 1));
  assert.equal(r!.percent, 100);
  assert.deepEqual(r!.networkMisses, []);
  assert.deepEqual(fr.calls.map((c) => [c.stage, c.opts.invocation.model]), [['triage', 'sonnet'], ['analyze', 'opus']]);
  // Анализ видит снимок акта и обе связанные страницы, WebFetch не выдан (нет доменов).
  const a = fr.calls[1]!;
  assert.equal(a.input['related_snapshots'].length, 2);
  assert.deepEqual(a.input['allowed_domains'], []);
  assert.ok(!a.opts.invocation.args.join(' ').includes('WebFetch('));
  assert.equal(r!.processes.length, 2);
  assert.equal(r!.processes[1]!.turns, 4);
  assert.ok(r!.dirs.cardPath && JSON.parse(readFileSync(r!.dirs.cardPath, 'utf8')).candidate_id === 'lexuz-8530799');
});

// ───────── T-14: ложная цитата → evidence-check ❌ → VERIFY с пометкой → исправление ─────────

test('T-14 (сквозной, боевые исполнители): подменённая цитата → failedFields → VERIFY с evidence_check → исправление', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'rw-t14-'));
  const fetcher = goldenFetcher(CASE);
  const fr = fakeRun((stage, input, n) => {
    if (stage === 'triage') return relevant(input);
    if (stage === 'screen' || stage === 'confirm') {
      // Экран по тексту (канал Б, орган — ЦБ): material, цитата — дословно из переданного фрагмента.
      const items = (input['candidates'] as Array<{ id: string; fragments: string[] }>).map((c) => ({
        id: c.id,
        decision: 'material' as const,
        points: ['p. 8'],
        quote: c.fragments[0]!.slice(0, 300),
        reason: 'Amends corporate governance regulation for commercial banks',
        confidence: 'high' as const,
      }));
      return { country: 'UZ', mode: input['mode'], items };
    }
    if (stage === 'analyze') {
      const card = goldenCard();
      // Круг 1: цитата подменена (в снимке «uch oydan» — «три месяца», а не «olti oydan» — «шесть»).
      if (n === 1) card.act.transition_period.exists.quote = 'Mazkur qaror rasmiy eʼlon qilingan kundan eʼtiboran olti oydan keyin kuchga kiradi.';
      return card;
    }
    const v: Verification = {
      country: 'UZ',
      cards: (input['cards'] as Array<{ candidate_id: string }>).map((c) => ({ candidate_id: c.candidate_id, fields: [], verdict: 'confirmed' })),
      returned: [],
      watched_acts_check: [],
    };
    return v;
  });
  const executors = createStageExecutors({
    schemasDir: SCHEMAS,
    claudeBin: () => '/usr/local/bin/claude',
    claudeEnv: () => ({}),
    fetcher,
    // Сборщик снимает акт сразу, как канал А (с базовым актом и редакцией на дату вступления).
    collector: {
      collect: async (ctx) => {
        await prepareGoldenAct(CASE, ctx, fetcher);
        return { ok: true, output: { candidates: [goldenCandidate(CASE)] } };
      },
    },
    runStage: fr.runStage,
  });
  const orch = new Orchestrator({ executors, now: () => new Date(2026, 10, 18, 8, 0) });
  const r = await orch.start({
    mode: 'dry_run',
    countries: [goldenCountry('UZ')],
    settings: settingsFor(ws),
    gate: { canRun: false, canDryRun: true, message: '' },
  });
  assert.ok(r.ok && r.end === 'finished', JSON.stringify(r));
  const analyze = fr.calls.filter((c) => c.stage === 'analyze');
  const verify = fr.calls.filter((c) => c.stage === 'verify');
  // Канал Б сначала проходит экран по тексту (один вызов, текст эталона есть), потом два круга анализа.
  assert.deepEqual(fr.calls.map((c) => c.stage), ['triage', 'screen', 'analyze', 'verify', 'analyze', 'verify']);
  assert.ok((fr.calls[1]!.input['candidates'][0].fragments as string[]).length > 0, 'экран получил фрагменты текста эталона');
  assert.equal(r.state.countries['UZ']!.screen?.['lexuz-8530799']?.final, 'material');
  assert.equal(analyze.length, 2, 'круг 2 — исправление');
  // VERIFY получил карточку с пометкой о проваленной цитате.
  assert.deepEqual(verify[0]!.input['evidence_check'][0].failed_fields, ['act.transition_period.exists']);
  assert.equal(verify[0]!.input['evidence_check'][0].details[0].reason, 'цитата не найдена в снимке');
  // Анализ круга 2 получил замечание именно по этому полю.
  const notes = analyze[1]!.input['reviewer_notes'] as Array<{ field: string; status: string }>;
  assert.ok(notes.some((x) => x.field === 'act.transition_period.exists' && x.status === 'quote_not_found'), JSON.stringify(notes));
  const st = r.state.countries['UZ']!;
  assert.equal(st.acts['lexuz-8530799']!.verdict, 'confirmed');
  const ev = JSON.parse(readFileSync(join(r.runDir, 'UZ', 'acts', 'lexuz-8530799', 'evidence-check.json'), 'utf8'));
  assert.equal(ev.ok, true, 'после исправления цитаты подтверждены');
  assert.deepEqual(fetcher.misses, []);
});
