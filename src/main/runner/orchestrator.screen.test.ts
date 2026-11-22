// Экран по тексту в оркестраторе (SCR-01…SCR-04, VER-02/03) на фейковых исполнителях: без сети и без claude.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { RunState } from '../../shared/run-types.ts';
import type { Candidate, CountryResult, Outcome, StartResult } from '../../shared/pipeline-types.ts';
import type { ScreenDecision, ScreenOutput, TriageOutput, Verification } from '../../shared/schema-types.ts';
import { Orchestrator } from './orchestrator.ts';
import type { ScreenInputItem, StageExecutors, VerifyCardInput } from './orchestrator.ts';
import { loadRun, runFile } from './run-state.ts';
import type { ScreenPrep } from './screen.ts';
import { OPEN_GATE, cand, country, fail, makeCard, makeHarness, ok, settingsFor } from './fixtures/orchestrator-stubs.ts';
import type { Harness, HarnessOptions } from './fixtures/orchestrator-stubs.ts';

const NOW = new Date(2026, 10, 17, 8, 0);
const tmp = (): string => mkdtempSync(join(tmpdir(), 'rw-orch-screen-'));

// Класс органа ставит оркестратор при сборе (правила UZ по умолчанию), поэтому класс задаётся органом.
const CLASS1 = 'Правления Центрального банка Республики Узбекистан';
const CLASS2 = 'Кабинета Министров Республики Узбекистан';
const CLASS3 = 'Налогового комитета Республики Узбекистан';
const c1 = (id: string, extra: Partial<Candidate> = {}): Candidate => cand(id, 'B', { issuer: CLASS1, ...extra });
const c2 = (id: string, extra: Partial<Candidate> = {}): Candidate => cand(id, 'B', { issuer: CLASS2, ...extra });
const c3 = (id: string, extra: Partial<Candidate> = {}): Candidate => cand(id, 'B', { issuer: CLASS3, ...extra });

/** Фрагмент текста акта по умолчанию (то, что «вырезал код»). */
const fragmentOf = (id: string): string => `Markaziy bank boshqaruvining qarori ${id}: tijorat banklari uchun kapital talablari, 12-band.`;
const textPrep = (id: string, termCount = 10): ScreenPrep => ({ hasText: true, textSource: 'html', termCount, fragments: [fragmentOf(id)] });

type Prep = { ok: true; prep: ScreenPrep } | { ok: false; message: string };
type Decide = (id: string, mode: 'screen' | 'confirm', n: number) => ScreenDecision | { decision: ScreenDecision; quote: string };

interface ScreenCall {
  mode: 'screen' | 'confirm';
  ids: string[];
  previous: Array<ScreenInputItem['previous']>;
}

interface ScreenHarness extends Harness {
  prepares: string[];
  screens: ScreenCall[];
}

/**
 * Заглушки с экраном. По умолчанию: текст есть, 10 терминов; модель экрана отвечает `material` с цитатой из фрагмента.
 * screenOutcome — полная подмена ответа экрана (лимит и т.п.).
 */
function screenHarness(
  o: HarnessOptions & {
    prep?: (c: Candidate) => Prep;
    decide?: Decide;
    screenOutcome?: (items: ScreenInputItem[], mode: 'screen' | 'confirm', n: number) => Outcome<ScreenOutput> | null;
  } = {},
): ScreenHarness {
  const h = makeHarness(o) as ScreenHarness;
  h.prepares = [];
  h.screens = [];
  const ex: StageExecutors = h.executors;
  ex.prepareScreen = async (_ctx, c) => {
    h.prepares.push(c.id);
    return o.prep ? o.prep(c) : { ok: true, prep: textPrep(c.id) };
  };
  ex.screen = async (ctx, items, mode) => {
    h.screens.push({ mode, ids: items.map((i) => i.candidate.id), previous: items.map((i) => i.previous) });
    const n = h.screens.length;
    const custom = o.screenOutcome?.(items, mode, n);
    if (custom) return custom;
    const out: ScreenOutput = {
      country: ctx.country.code,
      mode,
      items: items.map((i) => {
        const d = o.decide ? o.decide(i.candidate.id, mode, n) : 'material';
        const decision = typeof d === 'string' ? d : d.decision;
        const quote = typeof d === 'string' ? i.prep.fragments[0]!.slice(0, 300) : d.quote;
        return { id: i.candidate.id, decision, points: ['12-band'], quote, reason: `${mode}: ${decision}`, confidence: 'high' as const };
      }),
    };
    return ok(mode, out);
  };
  return h;
}

type Ok = Extract<StartResult, { ok: true }>;
function okRes(r: StartResult | null): Ok {
  assert.ok(r && r.ok, `ожидался прогон, получено ${JSON.stringify(r)}`);
  return r as Ok;
}
const readResult = (r: Ok, code = 'UZ'): CountryResult => JSON.parse(readFileSync(join(r.runDir, code, 'result.json'), 'utf8'));
const readLog = (r: Ok, code = 'UZ'): Array<Record<string, unknown>> =>
  readFileSync(join(r.runDir, code, 'log.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
const finals = (s: RunState, code = 'UZ'): Record<string, [string | undefined, string | undefined]> =>
  Object.fromEntries(Object.entries(s.countries[code]!.screen ?? {}).map(([id, x]) => [id, [x.final, x.by]]));
const analyzed = (h: Harness): string[] => h.calls.filter((c) => c.stage === 'analyze').map((c) => c.act!);

async function run(h: Harness, ws = tmp()): Promise<{ r: Ok; ws: string; orch: Orchestrator }> {
  const orch = new Orchestrator({ executors: h.executors, now: () => NOW });
  const r = okRes(await orch.start({ mode: 'manual', countries: [country('UZ')], settings: settingsFor(ws), gate: OPEN_GATE }));
  return { r, ws, orch };
}

const verification = (cards: VerifyCardInput[], f: (id: string) => Verification['cards'][number] | null, returned: Verification['returned'] = []): Verification => ({
  country: 'UZ',
  cards: cards.map((c) => f(c.candidate.id)).filter((x): x is Verification['cards'][number] => x !== null),
  returned,
  watched_acts_check: [],
});

// ---------------------------------------------------------------------------------------------
// (а) класс 3 без терминов — отброшен кодом
// ---------------------------------------------------------------------------------------------

test('(а) класс 3 без банковских терминов → dropped кодом, 0 вызовов модели экрана и анализа; с терминами — к модели', async () => {
  const h = screenHarness({
    candidates: { UZ: [c3('t1'), c3('t2')] },
    prep: (c) => ({ ok: true, prep: textPrep(c.id, c.id === 't1' ? 0 : 5) }),
    decide: () => 'none', // класс 3: «нет» окончательно, без перепроверки
  });
  const { r } = await run(h);
  const s = loadRun(r.runDir);
  assert.equal(r.end, 'finished');
  assert.deepEqual(finals(s), { t1: ['dropped', 'code'], t2: ['dropped', 'screen'] });
  assert.equal(h.screens.length, 1, 'одна модель-экран (только t2), без перепроверки');
  assert.deepEqual(h.screens[0]!.ids, ['t2']);
  assert.equal(h.count('analyze'), 0);
  assert.equal(s.countries.UZ!.stages.screen.state, 'done');
  assert.equal(s.countries.UZ!.status, 'no_changes');
  // VER-02: отброшенные экраном видны проверке полноты.
  const ver = h.calls.filter((c) => c.stage === 'verify');
  assert.equal(ver.length, 1);
  assert.deepEqual(ver[0]!.cards, []);
  assert.deepEqual(ver[0]!.rejected, ['t1', 't2']);
  const log = readLog(r);
  assert.ok(log.some((e) => e['event'] === 'screen_decision' && e['id'] === 't1' && e['by'] === 'code' && /банковских терминов в тексте 0/.test(String(e['reason']))));
  const res = readResult(r);
  assert.deepEqual(res.items, []);
  assert.deepEqual(res.for_information, []);
  assert.deepEqual(res.unverified, []);
});

// ---------------------------------------------------------------------------------------------
// (б) нет текста → «не удалось проверить»
// ---------------------------------------------------------------------------------------------

test('(б) нет текста или страница не открылась → no_text → unverified в result.json, страна changes, без модели', async () => {
  const h = screenHarness({
    candidates: { UZ: [c1('p1'), c2('p2')] },
    prep: (c) =>
      c.id === 'p1'
        ? { ok: true, prep: { hasText: false, textSource: 'none', termCount: 0, fragments: [], message: 'PDF не прочитан: скан без текста' } }
        : { ok: false, message: 'страница акта не открылась: Сайт не отвечает' },
  });
  const { r } = await run(h);
  const s = loadRun(r.runDir);
  assert.deepEqual(finals(s), { p1: ['no_text', 'code'], p2: ['no_text', 'code'] });
  assert.equal(h.screens.length, 0, 'модель экрана не вызывается');
  assert.equal(h.count('analyze'), 0, 'анализа «вслепую» нет');
  assert.equal(s.countries.UZ!.status, 'changes', 'непроверенное — тоже результат (SCR-04)');
  // Все решил код (asks пуст): screen.json всё равно записан для архива и письма.
  const sf = JSON.parse(readFileSync(join(r.runDir, 'UZ', 'screen.json'), 'utf8')) as { items: Array<{ id: string; final: string }> };
  assert.deepEqual(sf.items.map((i) => [i.id, i.final]), [['p1', 'no_text'], ['p2', 'no_text']]);
  const res = readResult(r);
  assert.equal(res.status, 'changes');
  assert.deepEqual(res.items, []);
  assert.deepEqual(
    res.unverified!.map((u) => [u.candidate_id, u.reason, u.url]),
    [
      ['p1', 'PDF не прочитан: скан без текста', 'https://lex.uz/docs/p1'],
      ['p2', 'страница акта не открылась: Сайт не отвечает', 'https://lex.uz/docs/p2'],
    ],
  );
});

// ---------------------------------------------------------------------------------------------
// (в) material → анализ; minor → «для сведения»
// ---------------------------------------------------------------------------------------------

test('(в) material → анализ и карточка; minor → for_information без анализа; канал А — в анализ без экрана', async () => {
  const h = screenHarness({
    candidates: { UZ: [cand('a1', 'A', { issuer: CLASS3 }), c1('m1'), c2('n1')] },
    decide: (id) => (id === 'n1' ? 'minor' : 'material'),
  });
  const { r } = await run(h);
  const s = loadRun(r.runDir);
  assert.deepEqual(finals(s), { m1: ['material', 'screen'], n1: ['minor', 'screen'] });
  assert.deepEqual(h.prepares, ['m1', 'n1'], 'канал А текст для экрана не готовит');
  assert.deepEqual(h.screens.map((x) => [x.mode, x.ids]), [['screen', ['m1', 'n1']]]);
  assert.deepEqual(analyzed(h), ['a1', 'm1']);
  assert.deepEqual(Object.keys(s.countries.UZ!.acts), ['a1', 'm1']);
  const res = readResult(r);
  assert.equal(res.status, 'changes');
  assert.deepEqual(res.items.map((i) => [i.candidate_id, i.confirmed]), [['a1', true], ['m1', true]]);
  assert.deepEqual(res.for_information!.map((x) => [x.candidate_id, x.key, x.reason, x.points]), [['n1', 'reg:n1', 'screen: minor', ['12-band']]]);
  assert.deepEqual(res.unverified, []);
  assert.equal(s.countries.UZ!.screen!['m1']!.quote, fragmentOf('m1'));
  // screen.json — итог экрана для архива
  const sf = JSON.parse(readFileSync(join(r.runDir, 'UZ', 'screen.json'), 'utf8'));
  assert.deepEqual(sf.items.map((x: { id: string; final: string }) => [x.id, x.final]), [['m1', 'material'], ['n1', 'minor']]);
});

test('(в) только minor → страна changes, а дорогого анализа нет вовсе', async () => {
  const h = screenHarness({ candidates: { UZ: [c1('n1')] }, decide: () => 'minor' });
  const { r } = await run(h);
  const s = loadRun(r.runDir);
  assert.equal(h.count('analyze'), 0);
  assert.equal(s.countries.UZ!.stages.analyze.state, 'skipped');
  assert.equal(s.countries.UZ!.status, 'changes');
  assert.equal(readResult(r).for_information!.length, 1);
});

// ---------------------------------------------------------------------------------------------
// (г) перепроверка
// ---------------------------------------------------------------------------------------------

test('(г) none у классов 1/2 → перепроверка confirm; unsure после confirm → анализ; none после confirm → dropped', async () => {
  const h = screenHarness({
    candidates: { UZ: [c1('x1'), c2('x2'), c3('x3'), c1('x4')] },
    decide: (id, mode) => {
      if (mode === 'screen') return 'none';
      return id === 'x4' ? 'none' : 'unsure';
    },
  });
  const { r } = await run(h);
  const s = loadRun(r.runDir);
  assert.deepEqual(h.screens.map((x) => [x.mode, x.ids]), [
    ['screen', ['x1', 'x2', 'x3', 'x4']],
    ['confirm', ['x1', 'x2', 'x4']],
  ]);
  assert.deepEqual(h.screens[1]!.previous.map((p) => p?.decision), ['none', 'none', 'none'], 'перепроверка видит прежнее решение');
  assert.deepEqual(finals(s), { x1: ['material', 'confirm'], x2: ['material', 'confirm'], x3: ['dropped', 'screen'], x4: ['dropped', 'confirm'] });
  assert.deepEqual(analyzed(h), ['x1', 'x2'], 'сомнение идёт на полный разбор (SCR-03)');
  assert.deepEqual(h.calls.find((c) => c.stage === 'verify')!.rejected, ['x3', 'x4']);
});

test('(г) цитата не из фрагментов → понижение до unsure → перепроверка; нет в ответе → тоже перепроверка', async () => {
  const h = screenHarness({
    candidates: { UZ: [c1('q1'), c1('q2'), c1('q3'), c3('q4')] },
    decide: (id, mode) => {
      if (mode === 'confirm') return id === 'q2' ? 'minor' : 'material';
      if (id === 'q1') return { decision: 'material', quote: 'Этой цитаты нет во фрагментах акта' };
      if (id === 'q4') return { decision: 'none', quote: 'выдумано' }; // класс 3, но «нет» без проверяемой цитаты — не верим
      return 'material';
    },
    screenOutcome: (items, mode) =>
      // q2 модель «потеряла» в ответе экрана
      mode === 'screen'
        ? ok('screen', {
            country: 'UZ',
            mode,
            items: items
              .filter((i) => i.candidate.id !== 'q2')
              .map((i) => {
                const id = i.candidate.id;
                const quote = id === 'q1' ? 'Этой цитаты нет во фрагментах акта' : id === 'q4' ? 'выдумано' : i.prep.fragments[0]!;
                return { id, decision: (id === 'q4' ? 'none' : 'material') as ScreenDecision, points: [], quote, reason: 'r', confidence: 'high' as const };
              }),
          })
        : null,
  });
  const { r } = await run(h);
  const s = loadRun(r.runDir);
  assert.deepEqual(h.screens.map((x) => [x.mode, x.ids]), [
    ['screen', ['q1', 'q2', 'q3', 'q4']],
    ['confirm', ['q1', 'q2', 'q4']],
  ]);
  assert.deepEqual(h.screens[1]!.previous.map((p) => p?.decision), ['unsure', 'unsure', 'unsure']);
  assert.deepEqual(finals(s), { q1: ['material', 'confirm'], q2: ['minor', 'confirm'], q3: ['material', 'screen'], q4: ['material', 'confirm'] });
  const log = readLog(r);
  const doubt = log.filter((e) => e['event'] === 'screen_doubt').map((e) => [e['id'], e['downgraded']]);
  assert.deepEqual(doubt, [
    ['q1', 'цитата не найдена во фрагментах'],
    ['q2', 'нет в ответе'],
    ['q4', 'цитата не найдена во фрагментах'],
  ]);
});

test('(г) пакеты экрана по 5 кандидатов', async () => {
  const ids = Array.from({ length: 12 }, (_, i) => `b${i + 1}`);
  const h = screenHarness({ candidates: { UZ: ids.map((id) => c1(id)) }, decide: () => 'minor' });
  await run(h);
  assert.deepEqual(h.screens.map((x) => x.ids.length), [5, 5, 2]);
});

// ---------------------------------------------------------------------------------------------
// (д) пауза по лимиту посреди экрана
// ---------------------------------------------------------------------------------------------

test('(д) лимит на втором пакете экрана → пауза; продолжение не повторяет решённые', async () => {
  const ids = Array.from({ length: 7 }, (_, i) => `s${i + 1}`);
  let limited = true;
  const h = screenHarness({
    candidates: { UZ: ids.map((id) => c1(id)) },
    decide: (id) => (id === 's2' ? 'minor' : 'material'),
    screenOutcome: (_items, mode, n) =>
      limited && mode === 'screen' && n === 2 ? fail('screen', 'limit', 'Исчерпан лимит подписки Claude', { resetsAt: '2026-11-17T12:00:00.000Z' }) : null,
  });
  const ws = tmp();
  const settings = settingsFor(ws);
  const orch = new Orchestrator({ executors: h.executors, now: () => NOW });
  const r = okRes(await orch.start({ mode: 'manual', countries: [country('UZ')], settings, gate: OPEN_GATE }));
  assert.equal(r.end, 'paused');
  let s = loadRun(r.runDir);
  assert.equal(s.paused_until, '2026-11-17T12:00:00.000Z');
  assert.equal(s.countries.UZ!.stages.screen.state, 'pending', 'прерванный этап вернулся в «ждёт»');
  assert.deepEqual(
    Object.fromEntries(Object.entries(s.countries.UZ!.screen!).map(([id, x]) => [id, x.state === 'done' ? x.final : 'pending'])),
    { s1: 'material', s2: 'minor', s3: 'material', s4: 'material', s5: 'material', s6: 'pending', s7: 'pending' },
    'итог первого пакета записан сразу',
  );
  assert.equal(h.count('analyze'), 0);

  limited = false;
  const before = { prepares: h.prepares.length, screens: h.screens.length };
  const r2 = okRes(await orch.resume({ countries: [country('UZ')], settings }));
  assert.equal(r2.end, 'finished');
  assert.deepEqual(h.prepares.slice(before.prepares), ['s6', 's7'], 'текст готовится только для нерешённых');
  assert.deepEqual(h.screens.slice(before.screens).map((x) => [x.mode, x.ids]), [['screen', ['s6', 's7']]], 'решённые не идут на экран повторно');
  s = loadRun(r.runDir);
  assert.equal(s.countries.UZ!.stages.screen.state, 'done');
  assert.deepEqual(analyzed(h).sort(), ['s1', 's3', 's4', 's5', 's6', 's7'], 'каждый material анализируется ровно один раз');
  assert.equal(s.countries.UZ!.status, 'changes');
  assert.deepEqual(readResult(r2).for_information!.map((x) => x.candidate_id), ['s2']);
});

test('(д) лимит на перепроверке → продолжение не повторяет решённые экраном', async () => {
  let limited = true;
  const h = screenHarness({
    candidates: { UZ: [c1('d1'), c1('d2')] },
    decide: (id, mode) => (mode === 'confirm' ? 'material' : id === 'd1' ? 'material' : 'none'),
    screenOutcome: (_i, mode) => (limited && mode === 'confirm' ? fail('confirm', 'limit', 'Исчерпан лимит подписки Claude') : null),
  });
  const ws = tmp();
  const settings = settingsFor(ws);
  const orch = new Orchestrator({ executors: h.executors, now: () => NOW });
  assert.equal(okRes(await orch.start({ mode: 'manual', countries: [country('UZ')], settings, gate: OPEN_GATE })).end, 'paused');
  limited = false;
  const n = h.screens.length;
  const r2 = okRes(await orch.resume({ countries: [country('UZ')], settings }));
  assert.equal(r2.end, 'finished');
  const after = h.screens.slice(n);
  assert.ok(after.every((x) => !x.ids.includes('d1')), 'd1 (material) решён и повторно не смотрится');
  assert.deepEqual(after.at(-1), { mode: 'confirm', ids: ['d2'], previous: [{ decision: 'none', reason: 'screen: none' }] });
  assert.deepEqual(finals(loadRun(r2.runDir)), { d1: ['material', 'screen'], d2: ['material', 'confirm'] });
  assert.deepEqual(analyzed(h), ['d1', 'd2']);
});

// ---------------------------------------------------------------------------------------------
// (е) возврат отброшенного проверкой
// ---------------------------------------------------------------------------------------------

test('(е) возврат с обоснованием → на экран и дальше по его решению; «just in case» и пустое → игнор', async () => {
  const triage = (cands: Candidate[]): TriageOutput => ({
    country: 'UZ',
    items: cands.map((c) => ({
      id: c.id,
      decision: c.id === 'k1' ? ('relevant' as const) : ('irrelevant' as const),
      reason_code: c.id === 'k1' ? null : ('other_sector' as const),
      reason_text: 'r',
      confidence: 'high' as const,
    })),
  });
  const h = screenHarness({
    candidates: { UZ: [c1('k1'), c2('r1'), c2('r2'), c2('r3')] },
    triage: (_ctx, cands) => ok('triage', triage(cands)),
    verify: (_ctx, cards, rejected, n) =>
      ok(
        'verify',
        verification(cards, (id) => ({ candidate_id: id, fields: [], verdict: 'confirmed' }), n === 1
          ? [
              { id: 'r1', reason: 'Title amends capital adequacy rules for commercial banks' },
              { id: 'r2', reason: 'just in case, may touch banks somehow' },
              { id: 'r3', reason: '' },
            ]
          : []),
      ),
  });
  const { r } = await run(h);
  const s = loadRun(r.runDir);
  const ver = h.calls.filter((c) => c.stage === 'verify');
  assert.deepEqual(ver.map((v) => [v.cards, v.rejected]), [
    [['k1'], ['r1', 'r2', 'r3']],
    [['r1'], []],
  ]);
  assert.deepEqual(h.screens.map((x) => [x.mode, x.ids]), [['screen', ['k1']], ['screen', ['r1']]], 'возвращённый идёт на экран, а не сразу в анализ');
  assert.equal(s.countries.UZ!.screen!['r1']!.returned, true);
  assert.deepEqual(analyzed(h), ['k1', 'r1']);
  assert.equal(s.countries.UZ!.screen!['r2'], undefined);
  assert.equal(s.countries.UZ!.acts['r2'], undefined);
  assert.equal(s.countries.UZ!.acts['r3'], undefined);
  const ignored = readLog(r).filter((e) => e['event'] === 'returned_ignored').map((e) => e['id']);
  assert.deepEqual(ignored, ['r2', 'r3']);
  assert.deepEqual(readResult(r).items.map((i) => i.candidate_id), ['k1', 'r1']);
});

test('(е) возвращённый, которого экран счёл minor, анализа не получает и попадает в «для сведения»', async () => {
  const h = screenHarness({
    candidates: { UZ: [c2('r1')] },
    triage: (_ctx, cands) => ok('triage', { country: 'UZ', items: cands.map((c) => ({ id: c.id, decision: 'irrelevant' as const, reason_code: 'other_sector' as const, reason_text: 'r', confidence: 'high' as const })) }),
    decide: () => 'minor',
    verify: (_ctx, cards, _rej, n) => ok('verify', verification(cards, () => null, n === 1 ? [{ id: 'r1', reason: 'Title mentions deposit insurance for banks' }] : [])),
  });
  const { r } = await run(h);
  assert.equal(h.count('analyze'), 0);
  assert.deepEqual(readResult(r).for_information!.map((x) => x.candidate_id), ['r1']);
  assert.equal(readResult(r).status, 'changes');
});

// ---------------------------------------------------------------------------------------------
// (ж) второй круг только по ключевым полям
// ---------------------------------------------------------------------------------------------

const field = (f: string, status: 'ok' | 'mismatch' | 'unverifiable' = 'mismatch'): Verification['cards'][number]['fields'][number] => ({
  field: f,
  status,
  correct_value: 'x',
  comment: 'c',
});

test('(ж) расхождение только в неключевых полях → confirmed без второго круга; в ключевых → круг 2', async () => {
  const h = screenHarness({
    candidates: { UZ: [c1('n1'), c1('n2'), c1('n3'), c1('k1'), c1('k2')] },
    verify: (_ctx, cards, _rej, n) =>
      ok(
        'verify',
        verification(cards, (id) => {
          if (n > 1) return { candidate_id: id, fields: [], verdict: 'confirmed' };
          if (id === 'n1') return { candidate_id: id, fields: [field('scope.applies_to'), field('change_count.annex_items')], verdict: 'needs_correction' };
          if (id === 'n2') return { candidate_id: id, fields: [field('act.title_en')], verdict: 'confirmed' };
          if (id === 'n3') return { candidate_id: id, fields: [field('act.transition_period.details', 'unverifiable')], verdict: 'needs_correction' };
          if (id === 'k1') return { candidate_id: id, fields: [field('act.effective_date'), field('scope.applies_to')], verdict: 'needs_correction' };
          return { candidate_id: id, fields: [field('changes[2].location')], verdict: 'needs_correction' };
        }),
      ),
  });
  const { r } = await run(h);
  const s = loadRun(r.runDir);
  const acts = s.countries.UZ!.acts;
  assert.deepEqual(
    Object.fromEntries(Object.entries(acts).map(([id, a]) => [id, [a.rounds, a.verdict]])),
    { n1: [1, 'confirmed'], n2: [1, 'confirmed'], n3: [1, 'confirmed'], k1: [2, 'confirmed'], k2: [2, 'confirmed'] },
  );
  for (const id of ['n1', 'n2', 'n3']) assert.equal(h.count('analyze', 'UZ', id), 1, `${id}: без второго круга`);
  for (const id of ['k1', 'k2']) assert.equal(h.count('analyze', 'UZ', id), 2, `${id}: второй круг`);
  // Замечания второго круга — по полям проверки (включая неключевые, раз круг всё равно идёт).
  const notes = h.calls.find((c) => c.stage === 'analyze' && c.act === 'k1' && c.notes)!.notes!;
  assert.deepEqual(notes.fields.map((f) => f.field), ['act.effective_date', 'scope.applies_to']);
  // Спорные неключевые поля сохраняются в review.json (архив), но карточка подтверждена.
  const review = JSON.parse(readFileSync(join(r.runDir, 'UZ', 'acts', 'n1', 'review.json'), 'utf8'));
  assert.equal(review.verdict, 'confirmed');
  assert.deepEqual(review.notes.fields.map((f: { field: string }) => f.field), ['scope.applies_to', 'change_count.annex_items']);
  assert.ok(readResult(r).items.every((i) => i.confirmed));
});

test('(ж) ключевое поле осталось спорным после круга 2 → unconfirmed с перечнем полей', async () => {
  const h = screenHarness({
    candidates: { UZ: [c1('k1')] },
    verify: (_ctx, cards) => ok('verify', verification(cards, (id) => ({ candidate_id: id, fields: [field('act.effective_date')], verdict: 'needs_correction' }))),
  });
  const { r } = await run(h);
  const a = loadRun(r.runDir).countries.UZ!.acts['k1']!;
  assert.deepEqual([a.rounds, a.verdict], [2, 'unconfirmed']);
  assert.equal(h.count('analyze', 'UZ', 'k1'), 2);
  const item = readResult(r).items[0]!;
  assert.equal(item.confirmed, false);
  assert.deepEqual(item.disputed_fields, ['act.effective_date']);
});

// ---------------------------------------------------------------------------------------------
// (з) без экрана — как раньше
// ---------------------------------------------------------------------------------------------

test('(з) исполнители без screen: отобранные сразу в анализ, этап screen пропущен, второй круг по любому mismatch', async () => {
  const h = makeHarness({
    candidates: { UZ: [c1('a1'), c3('a2')] },
    verify: (_ctx, cards, _rej, n) =>
      ok('verify', verification(cards, (id) => (n === 1 && id === 'a1' ? { candidate_id: id, fields: [field('scope.applies_to')], verdict: 'needs_correction' } : { candidate_id: id, fields: [], verdict: 'confirmed' }))),
  });
  const { r } = await run(h);
  const s = loadRun(r.runDir);
  assert.equal(s.countries.UZ!.screen, undefined);
  assert.equal(s.countries.UZ!.stages.screen.state, 'skipped');
  assert.deepEqual(Object.keys(s.countries.UZ!.acts), ['a1', 'a2'], 'класс 3 без экрана не отсекается');
  assert.equal(h.count('analyze', 'UZ', 'a1'), 2, 'прежнее правило VER-03: любой mismatch → круг 2');
  const res = readResult(r);
  assert.equal('for_information' in res, false);
  assert.equal('unverified' in res, false);
  assert.equal(res.status, 'changes');
});

test('(з) старый прогон без этапа screen продолжается новыми исполнителями с того же акта, без экрана', async () => {
  let limited = true;
  const old = makeHarness({
    candidates: { UZ: [c1('o1'), c1('o2')] },
    analyze: (ctx, c) => (limited && c.id === 'o2' ? fail('analyze', 'limit', 'Исчерпан лимит подписки Claude') : ok('analyze', makeCard(c.id, ctx.country.code), c.id)),
  });
  const ws = tmp();
  const settings = settingsFor(ws);
  const r = okRes(await new Orchestrator({ executors: old.executors, now: () => NOW }).start({ mode: 'manual', countries: [country('UZ')], settings, gate: OPEN_GATE }));
  assert.equal(r.end, 'paused');
  // Превращаем run.json в «старый»: этапа screen там ещё не было.
  const raw = JSON.parse(readFileSync(runFile(r.runDir), 'utf8')) as RunState;
  delete (raw.countries.UZ!.stages as Partial<RunState['countries'][string]['stages']>).screen;
  delete raw.countries.UZ!.screen;
  writeFileSync(runFile(r.runDir), JSON.stringify(raw));
  assert.equal(loadRun(r.runDir).countries.UZ!.stages.screen.state, 'skipped', 'миграция: отбор был готов → экран пропущен');

  limited = false;
  const neu = screenHarness({ candidates: { UZ: [c1('o1'), c1('o2')] } });
  const r2 = okRes(await new Orchestrator({ executors: neu.executors, now: () => NOW }).resume({ countries: [country('UZ')], settings, runDir: r.runDir }));
  assert.equal(r2.end, 'finished');
  assert.equal(neu.screens.length, 0);
  assert.equal(neu.prepares.length, 0);
  assert.deepEqual(analyzed(neu), ['o2'], 'продолжение с прерванного акта');
  const s = loadRun(r.runDir);
  assert.equal(s.countries.UZ!.status, 'changes');
  assert.deepEqual(readResult(r2).items.map((i) => i.candidate_id), ['o1', 'o2']);
});
