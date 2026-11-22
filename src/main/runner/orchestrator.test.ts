import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { RunState } from '../../shared/run-types.ts';
import type { CountryResult, RunReport, StartResult } from '../../shared/pipeline-types.ts';
import { sourceHealthFile } from '../checks/anomaly.ts';
import { ledgerFile, saveLedger } from '../ledger.ts';
import { MAIL_GATE_MESSAGE, evaluateGate } from '../mail-gate.ts';
import { Orchestrator, computeWindow, outcomeFromStage, usageFromRunner } from './orchestrator.ts';
import type { OrchestratorDeps } from './orchestrator.ts';
import { findUnfinishedRun, loadRun } from './run-state.ts';
import {
  OPEN_GATE,
  cand,
  confirmAll,
  country,
  fail,
  makeCard,
  makeHarness,
  ok,
  settingsFor,
  triageAll,
} from './fixtures/orchestrator-stubs.ts';
import type { HarnessOptions } from './fixtures/orchestrator-stubs.ts';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'rw-orch-'));
const NOW = new Date(2026, 10, 17, 8, 0);

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

function setup(o: HarnessOptions, deps: Partial<OrchestratorDeps> = {}) {
  const ws = tmp();
  const h = makeHarness(o);
  const orch = new Orchestrator({ executors: h.executors, now: () => NOW, ...deps });
  return { ws, h, orch };
}

type Ok = Extract<StartResult, { ok: true }>;
function okRes(r: StartResult | null): Ok {
  assert.ok(r && r.ok, `ожидался прогон, получено ${JSON.stringify(r)}`);
  return r as Ok;
}

const readResult = (r: Ok, code: string): CountryResult => JSON.parse(readFileSync(join(r.runDir, code, 'result.json'), 'utf8'));
const readLog = (r: Ok, code: string): Array<Record<string, unknown>> =>
  readFileSync(join(r.runDir, code, 'log.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

// ---------------------------------------------------------------------------------------------
// (а) полный проход
// ---------------------------------------------------------------------------------------------

test('(а) полный проход трёх стран; страна без кандидатов — 0 вызовов модели; выключенная не участвует', async () => {
  const reports: RunReport[] = [];
  const progress: RunState[] = [];
  const power: string[] = [];
  const { ws, h, orch } = setup(
    { candidates: { UZ: [cand('u1'), cand('u2')], KZ: [], KG: [cand('g1')] } },
    {
      finalize: async (r) => void reports.push(r),
      onProgress: (s) => void progress.push(s),
      powerSave: { start: () => void power.push('start'), stop: () => void power.push('stop') },
    },
  );
  const r = okRes(
    await orch.start({
      mode: 'manual',
      countries: [country('UZ'), country('KZ'), country('TJ', false), country('KG')],
      settings: settingsFor(ws),
      gate: OPEN_GATE,
    }),
  );
  assert.equal(r.end, 'finished');
  const s = loadRun(r.runDir);
  assert.ok(s.finished_at);
  assert.deepEqual(Object.keys(s.countries), ['UZ', 'KZ', 'KG'], 'выключенная TJ не входит в прогон (CTY-07)');
  assert.equal(s.countries.UZ!.status, 'changes');
  assert.equal(s.countries.KZ!.status, 'no_changes');
  assert.equal(s.countries.KG!.status, 'changes');

  // порядок стран — по одной, по порядку
  assert.deepEqual(h.calls.filter((c) => c.stage === 'collect').map((c) => c.country), ['UZ', 'KZ', 'KG']);
  // KZ: 0 вызовов модели (NFR-07)
  for (const st of ['triage', 'analyze', 'verify'] as const) assert.equal(h.count(st, 'KZ'), 0, st);
  assert.deepEqual(
    Object.fromEntries(['triage', 'analyze', 'verify'].map((st) => [st, s.countries.KZ!.stages[st as 'triage'].state])),
    { triage: 'skipped', analyze: 'skipped', verify: 'skipped' },
  );
  // UZ: 2 кандидата → 2 analyze, 1 verify
  assert.equal(h.count('triage', 'UZ'), 1);
  assert.equal(h.count('analyze', 'UZ'), 2);
  assert.equal(h.count('verify', 'UZ'), 1);
  assert.deepEqual(s.countries.UZ!.acts, {
    u1: { analyze: 'done', rounds: 1, verdict: 'confirmed' },
    u2: { analyze: 'done', rounds: 1, verdict: 'confirmed' },
  });
  // расход: triage + 2 analyze + verify = 4 процесса по 100 токенов
  assert.equal(s.countries.UZ!.usage.input, 400);
  assert.equal(s.countries.KZ!.usage.input, 0);

  // архив
  for (const f of ['candidates.json', 'triage.json', 'verification.json', 'result.json', 'log.jsonl', 'acts/u1/card.json', 'acts/u2/card.json']) {
    assert.ok(existsSync(join(r.runDir, 'UZ', f)), f);
  }
  const uz = readResult(r, 'UZ');
  assert.equal(uz.items.length, 2);
  assert.ok(uz.items.every((i) => i.kind === 'new' && i.confirmed));
  assert.deepEqual(uz.to_commit.map((c) => c.key), ['reg:u1', 'reg:u2'], 'manual: есть что закоммитить после отправки');
  assert.ok(!existsSync(ledgerFile(ws, 'UZ')), 'журнал оркестратор не пишет');

  // лог: процессы, решения triage, полнота, итог
  const log = readLog(r, 'UZ');
  const ev = (e: string) => log.filter((l) => l.event === e);
  assert.equal(ev('process').length, 4);
  assert.equal(ev('process')[0]!.model, 'stub');
  assert.equal(ev('triage_decision').length, 2);
  assert.equal(ev('completeness')[0]!.ok, true);
  assert.equal(ev('status')[0]!.status, 'changes');
  assert.ok(readLog(r, 'KZ').some((l) => l.event === 'no_candidates'));

  // finalize — один раз, после всех стран
  assert.equal(reports.length, 1);
  assert.deepEqual(reports[0]!.countries.map((c) => c.country), ['UZ', 'KZ', 'KG']);
  assert.equal(reports[0]!.countries[0]!.cards['u1']!.candidate_id, 'u1');
  assert.ok(progress.length > 5);
  assert.deepEqual(power, ['start', 'stop']);
  assert.equal(orch.running, false);
});

// ---------------------------------------------------------------------------------------------
// (б) сбой одной страны
// ---------------------------------------------------------------------------------------------

test('(б) T-13: analyze → timeout → failed:timeout, остальные страны идут', async () => {
  const { ws, h, orch } = setup({
    candidates: { UZ: [cand('u1')], KZ: [cand('k1'), cand('k2')], KG: [cand('g1')] },
    analyze: (ctx, c) =>
      ctx.country.code === 'KZ' && c.id === 'k1'
        ? fail('analyze', 'timeout', 'Этап не уложился во время и был остановлен')
        : ok('analyze', makeCard(c.id, ctx.country.code), c.id),
  });
  const r = okRes(await orch.start({ mode: 'manual', countries: [country('UZ'), country('KZ'), country('KG')], settings: settingsFor(ws), gate: OPEN_GATE }));
  const s = loadRun(r.runDir);
  assert.equal(r.end, 'finished');
  assert.equal(s.countries.UZ!.status, 'changes');
  assert.equal(s.countries.KZ!.status, 'failed:timeout');
  assert.equal(s.countries.KG!.status, 'changes');
  assert.equal(s.countries.KZ!.stages.analyze.state, 'failed');
  assert.match(s.countries.KZ!.stages.analyze.error!, /не уложился/);
  assert.equal(s.countries.KZ!.acts.k1!.analyze, 'failed');
  assert.equal(h.count('analyze', 'KZ', 'k1'), 1, 'оркестратор не повторяет поверх повтора раннера');
  assert.equal(h.count('verify', 'KZ'), 0);
  const kz = readResult(r, 'KZ');
  assert.equal(kz.status, 'failed:timeout');
  assert.match(kz.error!, /Анализ акта \(акт k1\)/);
  assert.ok(readLog(r, 'KZ').some((l) => l.event === 'process' && l.failure === 'timeout'));
});

test('сбор: недоступный единственный источник → failed:source; аномалия → failed:parser; дублирующий → ⚠ и дальше', async () => {
  const { ws, h, orch } = setup({
    collect: (ctx) => {
      const code = ctx.country.code;
      if (code === 'UZ') return { ok: true, output: { candidates: [cand('u1')], sourceFailures: [{ sourceId: 'lex', message: 'сайт не отвечает', critical: true }] } };
      if (code === 'KZ') return { ok: true, output: { candidates: [], anomalies: [{ sourceId: 'nbk', median: 12 }] } };
      return { ok: true, output: { candidates: [cand('g1')], sourceFailures: [{ sourceId: 'news', message: 'нет ответа', critical: false }] } };
    },
  });
  const r = okRes(await orch.start({ mode: 'manual', countries: [country('UZ'), country('KZ'), country('KG')], settings: settingsFor(ws), gate: OPEN_GATE }));
  const s = loadRun(r.runDir);
  assert.equal(s.countries.UZ!.status, 'failed:source');
  assert.equal(s.countries.KZ!.status, 'failed:parser');
  assert.equal(s.countries.KG!.status, 'changes');
  assert.equal(h.count('triage', 'UZ'), 0);
  assert.match(s.countries.UZ!.stages.collect.error!, /Источник недоступен: lex/);
  assert.match(s.countries.KZ!.stages.collect.error!, /0 документов/);
  assert.equal(s.countries.KG!.warnings!.length, 1);
  assert.deepEqual(readResult(r, 'KG').warnings, s.countries.KG!.warnings);
});

// ---------------------------------------------------------------------------------------------
// (в) T-15 полнота
// ---------------------------------------------------------------------------------------------

test('(в) T-15: triage дважды теряет id → повтор → failed:completeness', async () => {
  const { ws, h, orch } = setup({
    candidates: { UZ: [cand('a'), cand('b'), cand('c')] },
    triage: (ctx, cands) => ok('triage', triageAll(ctx.country.code, cands.filter((c) => c.id !== 'c'))),
  });
  const r = okRes(await orch.start({ mode: 'manual', countries: [country('UZ')], settings: settingsFor(ws), gate: OPEN_GATE }));
  const s = loadRun(r.runDir);
  assert.equal(s.countries.UZ!.status, 'failed:completeness');
  assert.equal(h.count('triage', 'UZ'), 2);
  const retryCall = h.calls.filter((c) => c.stage === 'triage')[1]!;
  assert.match(retryCall.retry!, /потеряны кандидаты: c/, 'повтор получает причину в ctx');
  assert.equal(h.count('analyze'), 0);
  assert.equal(s.countries.UZ!.stages.triage.state, 'failed');
  assert.equal(s.countries.UZ!.stages.triage.attempts, 2);
  assert.ok(s.finished_at, 'страна получила статус — прогон завершён');
  const log = readLog(r, 'UZ');
  assert.equal(log.filter((l) => l.event === 'completeness' && l.ok === false).length, 2);
  assert.equal(log.filter((l) => l.event === 'retry').length, 1);
});

test('(в) T-15: потерял один раз → повтор успешен; irrelevant без причины тоже нарушение', async () => {
  const { ws, h, orch } = setup({
    candidates: { UZ: [cand('a'), cand('b')], KZ: [cand('k1'), cand('k2')] },
    triage: (ctx, cands, n) => {
      if (ctx.country.code === 'UZ' && n === 1) return ok('triage', triageAll('UZ', cands.slice(0, 1)));
      if (ctx.country.code === 'KZ' && n === 1) {
        const t = triageAll('KZ', cands);
        t.items[1] = { ...t.items[1]!, decision: 'irrelevant', reason_code: null };
        return ok('triage', t);
      }
      return ok('triage', triageAll(ctx.country.code, cands));
    },
  });
  const r = okRes(await orch.start({ mode: 'manual', countries: [country('UZ'), country('KZ')], settings: settingsFor(ws), gate: OPEN_GATE }));
  const s = loadRun(r.runDir);
  assert.equal(s.countries.UZ!.status, 'changes');
  assert.equal(s.countries.KZ!.status, 'changes');
  assert.equal(h.count('triage', 'UZ'), 2);
  assert.equal(h.count('triage', 'KZ'), 2);
  assert.equal(h.count('analyze', 'UZ'), 2);
});

// ---------------------------------------------------------------------------------------------
// (г) круги проверки
// ---------------------------------------------------------------------------------------------

test('(г) mismatch → analyze с замечаниями → confirmed на круге 2 (T-6)', async () => {
  const { ws, h, orch } = setup({
    candidates: { UZ: [cand('a1'), cand('a2')] },
    verify: (ctx, cards, _rej, n) => {
      const v = confirmAll('UZ', cards);
      if (n === 1) {
        const i = v.cards.findIndex((c) => c.candidate_id === 'a1');
        v.cards[i] = {
          candidate_id: 'a1',
          verdict: 'needs_correction',
          fields: [{ field: 'act.effective_date', status: 'mismatch', correct_value: '2027-01-13', comment: 'неверная дата' }],
        };
      }
      return ok('verify', v);
    },
  });
  const r = okRes(await orch.start({ mode: 'manual', countries: [country('UZ')], settings: settingsFor(ws), gate: OPEN_GATE }));
  const s = loadRun(r.runDir);
  assert.equal(h.count('analyze', 'UZ', 'a1'), 2);
  assert.equal(h.count('analyze', 'UZ', 'a2'), 1);
  const second = h.calls.filter((c) => c.stage === 'analyze' && c.act === 'a1')[1]!;
  assert.equal(second.notes!.fields[0]!.field, 'act.effective_date');
  assert.equal(second.notes!.fields[0]!.correct_value, '2027-01-13');
  const verifies = h.calls.filter((c) => c.stage === 'verify');
  assert.deepEqual(verifies.map((v) => v.cards), [['a1', 'a2'], ['a1']], 'на втором круге проверяется только исправленная');
  assert.deepEqual(s.countries.UZ!.acts.a1, { analyze: 'done', rounds: 2, verdict: 'confirmed' });
  const res = readResult(r, 'UZ');
  assert.ok(res.items.every((i) => i.confirmed));
  assert.ok(existsSync(join(r.runDir, 'UZ', 'verification.pass-2.json')));
});

test('(г) неустранимое расхождение после 2 кругов → unconfirmed в результате со спорными полями', async () => {
  const { ws, h, orch } = setup({
    candidates: { UZ: [cand('a1')] },
    verify: (_ctx, cards) =>
      ok('verify', {
        country: 'UZ',
        cards: cards.map((c) => ({
          candidate_id: c.candidate.id,
          verdict: 'needs_correction' as const,
          fields: [
            { field: 'act.number', status: 'mismatch' as const, comment: 'другой номер' },
            { field: 'scope.applies_to', status: 'unverifiable' as const, comment: '' },
          ],
        })),
        returned: [],
        watched_acts_check: [],
      }),
  });
  const r = okRes(await orch.start({ mode: 'manual', countries: [country('UZ')], settings: settingsFor(ws), gate: OPEN_GATE }));
  const s = loadRun(r.runDir);
  assert.equal(h.count('analyze', 'UZ', 'a1'), 2, 'исходный анализ + 1 исправление');
  assert.equal(h.count('verify', 'UZ'), 2, 'максимум 2 круга (VER-03)');
  assert.deepEqual(s.countries.UZ!.acts.a1, { analyze: 'done', rounds: 2, verdict: 'unconfirmed' });
  assert.equal(s.countries.UZ!.status, 'changes');
  const item = readResult(r, 'UZ').items[0]!;
  assert.equal(item.confirmed, false);
  assert.deepEqual(item.disputed_fields, ['act.number', 'scope.applies_to']);
});

test('(г) возвращённый из отброшенных идёт в анализ и проверку; канал А анализируется всегда', async () => {
  const { ws, h, orch } = setup({
    candidates: { UZ: [cand('a1'), cand('b2'), cand('w3', 'A')] },
    triage: (_ctx, cands) => {
      const t = triageAll('UZ', cands);
      for (const it of t.items) if (it.id !== 'a1') Object.assign(it, { decision: 'irrelevant', reason_code: 'other_sector', reason_text: 'insurance' });
      return ok('triage', t);
    },
    verify: (_ctx, cards, _rej, n) => {
      const v = confirmAll('UZ', cards);
      if (n === 1) v.returned = [{ id: 'b2', reason: 'touches bank capital' }, { id: 'zzz', reason: 'unknown' }];
      return ok('verify', v);
    },
  });
  const r = okRes(await orch.start({ mode: 'manual', countries: [country('UZ')], settings: settingsFor(ws), gate: OPEN_GATE }));
  const s = loadRun(r.runDir);
  const verifies = h.calls.filter((c) => c.stage === 'verify');
  assert.deepEqual(verifies[0]!.cards, ['a1', 'w3'], 'канал А пошёл в анализ, хотя triage сказал irrelevant');
  assert.deepEqual(verifies[0]!.rejected, ['b2']);
  assert.deepEqual(verifies[1]!.cards, ['b2']);
  assert.deepEqual(verifies[1]!.rejected, []);
  assert.equal(h.count('analyze', 'UZ', 'b2'), 1);
  assert.equal(s.countries.UZ!.acts.b2!.verdict, 'confirmed');
  assert.deepEqual(readResult(r, 'UZ').items.map((i) => i.candidate_id), ['a1', 'w3', 'b2']);
  assert.ok(readLog(r, 'UZ').some((l) => l.event === 'returned_ignored' && l.id === 'zzz'));
});

test('(г) провал проверки цитат → в VERIFY с пометкой → исправление; без кандидатов в анализе verify смотрит только отброшенные', async () => {
  const { ws, h, orch } = setup({
    candidates: { UZ: [cand('a1')], KZ: [cand('k1')] },
    triage: (ctx, cands) => {
      const t = triageAll(ctx.country.code, cands);
      if (ctx.country.code === 'KZ') Object.assign(t.items[0]!, { decision: 'irrelevant', reason_code: 'not_regulatory' });
      return ok('triage', t);
    },
    checkEvidence: (_ctx, _c, _card, n) => (n === 1 ? { ok: false, failedFields: ['act.adoption_date'] } : { ok: true, failedFields: [] }),
  });
  const r = okRes(await orch.start({ mode: 'manual', countries: [country('UZ'), country('KZ')], settings: settingsFor(ws), gate: OPEN_GATE }));
  const s = loadRun(r.runDir);
  assert.equal(h.count('analyze', 'UZ', 'a1'), 2, 'верификатор подтвердил, но цитаты не прошли — исправление');
  assert.deepEqual(h.calls.find((c) => c.stage === 'analyze' && c.notes)!.notes!.evidenceFailedFields, ['act.adoption_date']);
  assert.equal(s.countries.UZ!.acts.a1!.verdict, 'confirmed');
  assert.ok(existsSync(join(r.runDir, 'UZ', 'acts', 'a1', 'evidence-check.json')));
  // KZ: всё отброшено → 1 проход проверки только по отброшенным, итог no_changes
  assert.equal(h.count('analyze', 'KZ'), 0);
  assert.equal(h.count('verify', 'KZ'), 1);
  assert.deepEqual(h.calls.find((c) => c.stage === 'verify' && c.country === 'KZ')!.rejected, ['k1']);
  assert.equal(s.countries.KZ!.status, 'no_changes');
});

// ---------------------------------------------------------------------------------------------
// (д) режимы, журнал, RUN-07, гейт
// ---------------------------------------------------------------------------------------------

test('(д) пробный режим не пишет ledger и source-health; manual пишет source-health, но не ledger', async () => {
  const collect = () => ({ ok: true as const, output: { candidates: [cand('u1')], sourceCounts: [{ sourceId: 'UZ-lex', count: 7 }] } });
  const a = setup({ collect });
  const r1 = okRes(await a.orch.start({ mode: 'dry_run', countries: [country('UZ')], settings: settingsFor(a.ws), gate: OPEN_GATE }));
  assert.equal(r1.end, 'finished');
  assert.ok(!existsSync(sourceHealthFile(a.ws)));
  assert.ok(!existsSync(ledgerFile(a.ws, 'UZ')));
  assert.deepEqual(readResult(r1, 'UZ').to_commit, [], 'пробный прогон: коммитить нечего');
  assert.equal(readResult(r1, 'UZ').items.length, 1);

  const b = setup({ collect });
  const r2 = okRes(await b.orch.start({ mode: 'manual', countries: [country('UZ')], settings: settingsFor(b.ws), gate: OPEN_GATE }));
  assert.ok(existsSync(sourceHealthFile(b.ws)));
  assert.ok(!existsSync(ledgerFile(b.ws, 'UZ')));
  assert.equal(readResult(r2, 'UZ').to_commit.length, 1);

  const c = setup({ collect });
  const r3 = okRes(await c.orch.start({ mode: 'backfill', countries: [country('UZ')], settings: settingsFor(c.ws), gate: OPEN_GATE, windowOverride: { from: '2026-07-01', to: '2026-11-17' } }));
  assert.ok(!existsSync(sourceHealthFile(c.ws)));
  assert.deepEqual(loadRun(r3.runDir).countries.UZ!.window, { from: '2026-07-01', to: '2026-11-17' });
  assert.deepEqual(readResult(r3, 'UZ').to_commit, []);
});

test('(д) журнал: отправленное отфильтровано до triage; новая стадия → обновление; та же стадия → дубль', async () => {
  const { ws, h, orch } = setup({
    candidates: {
      UZ: [cand('sent'), cand('upd', 'B', { maybeUpdate: true }), cand('dup', 'B', { maybeUpdate: true }), cand('new')],
    },
    analyze: (_ctx, c) => ok('analyze', makeCard(c.id, 'UZ', { stage: c.id === 'upd' ? 'in_force' : 'published' }), c.id),
  });
  const base = { first_reported_at: '2026-10-01T08:00:00.000Z', effective_date: '2027-01-13', title_en: 'T', run_id: 'old' };
  saveLedger(ws, 'UZ', [
    { key: 'reg:sent', last_stage: 'published', ...base },
    { key: 'reg:upd', last_stage: 'published', ...base },
    { key: 'reg:dup', last_stage: 'published', ...base },
  ]);
  const before = readFileSync(ledgerFile(ws, 'UZ'), 'utf8');
  const r = okRes(await orch.start({ mode: 'manual', countries: [country('UZ')], settings: settingsFor(ws), gate: OPEN_GATE }));
  assert.equal(h.count('analyze', 'UZ', 'sent'), 0, 'COL-04');
  const res = readResult(r, 'UZ');
  assert.deepEqual(res.items.map((i) => [i.candidate_id, i.kind]), [['upd', 'update'], ['new', 'new']]);
  const upd = res.items[0]!;
  assert.equal(upd.first_reported_at, '2026-10-01T08:00:00.000Z');
  assert.equal(upd.update_reason, 'stage');
  assert.deepEqual(res.duplicates, [{ candidate_id: 'dup', key: 'reg:dup' }]);
  assert.deepEqual(res.to_commit.map((x) => x.key), ['reg:upd', 'reg:new']);
  assert.equal(readFileSync(ledgerFile(ws, 'UZ'), 'utf8'), before, 'журнал не изменён оркестратором');
  const cf = JSON.parse(readFileSync(join(r.runDir, 'UZ', 'candidates.json'), 'utf8'));
  assert.deepEqual(cf.filtered_by_ledger, [{ id: 'sent', key: 'reg:sent' }]);
});

test('(д) RUN-07: повторный start при идущем прогоне возвращает тот же прогон', async () => {
  const gate = deferred();
  const { ws, h, orch } = setup({
    collect: async (ctx) => {
      if (ctx.country.code === 'UZ') await gate.promise;
      return { ok: true, output: { candidates: [] } };
    },
  });
  const opts = { mode: 'manual' as const, countries: [country('UZ')], settings: settingsFor(ws), gate: OPEN_GATE };
  const p1 = orch.start(opts);
  const p2 = orch.start({ ...opts, mode: 'dry_run' });
  assert.equal(p1, p2);
  assert.equal(orch.running, true);
  assert.equal(orch.resume({ countries: opts.countries, settings: opts.settings }), p1);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(orch.current()?.mode, 'manual');
  gate.resolve();
  const r = okRes(await p1);
  assert.equal(r.end, 'finished');
  assert.equal(h.count('collect'), 1);
  assert.equal(orch.running, false);
  assert.equal(orch.current(), null);
  // после завершения можно запустить новый
  const r2 = okRes(await orch.start(opts));
  assert.notEqual(r2.runDir, r.runDir);
});

test('(д) гейт почты: scheduled/manual/backfill без проверенной почты блокируются, dry_run идёт', async () => {
  const { ws, h, orch } = setup({ candidates: {} });
  const closed = evaluateGate(settingsFor(ws), false);
  for (const mode of ['scheduled', 'manual', 'backfill'] as const) {
    const r = await orch.start({ mode, countries: [country('UZ')], settings: settingsFor(ws), gate: closed });
    assert.deepEqual(r, { ok: false, blocked: MAIL_GATE_MESSAGE });
  }
  assert.ok(!existsSync(join(ws, 'runs')), 'ничего не создано');
  assert.equal(h.calls.length, 0);
  const r = okRes(await orch.start({ mode: 'dry_run', countries: [country('UZ')], settings: settingsFor(ws), gate: closed }));
  assert.equal(r.end, 'finished');
  // нет включённых стран
  const none = await orch.start({ mode: 'dry_run', countries: [country('UZ', false)], settings: settingsFor(ws), gate: OPEN_GATE });
  assert.equal(none.ok, false);
});

test('NEWS: подтверждённая кодом наводка становится кандидатом, неподтверждённая — только в лог', async () => {
  const lead = (n: string) => ({ headline: n, outlet: 'x', date: '2026-11-01', url: `https://news/${n}`, act_number: n, act_date: '', issuer: '', summary: '' });
  const { ws, h, orch } = setup({
    candidates: { UZ: [] },
    news: async () => ok('news', { country: 'UZ', leads: [lead('found'), lead('ghost')] }),
    resolveLead: (_ctx, l) => (l.kind === 'news' && l.lead.headline === 'found' ? cand('n1') : null),
  });
  const r = okRes(await orch.start({ mode: 'manual', countries: [country('UZ')], settings: settingsFor(ws, { newsEnabled: true }), gate: OPEN_GATE }));
  const s = loadRun(r.runDir);
  assert.equal(s.countries.UZ!.stages.news.state, 'done');
  assert.equal(h.count('analyze', 'UZ', 'n1'), 1);
  assert.equal(s.countries.UZ!.status, 'changes');
  assert.ok(existsSync(join(r.runDir, 'UZ', 'news.json')));
  assert.ok(readLog(r, 'UZ').some((l) => l.event === 'lead_unconfirmed' && l.headline === 'ghost'));
  const cf = JSON.parse(readFileSync(join(r.runDir, 'UZ', 'candidates.json'), 'utf8'));
  assert.deepEqual(cf.candidates.map((c: { id: string }) => c.id), ['n1']);

  // выключенный NEWS: 0 вызовов
  const b = setup({ candidates: { UZ: [] }, news: async () => ok('news', { country: 'UZ', leads: [] }) });
  const r2 = okRes(await b.orch.start({ mode: 'manual', countries: [country('UZ')], settings: settingsFor(b.ws), gate: OPEN_GATE }));
  assert.equal(b.h.count('news'), 0);
  assert.equal(loadRun(r2.runDir).countries.UZ!.stages.news.state, 'skipped');
});

// ---------------------------------------------------------------------------------------------
// (е) лимит → пауза → продолжение
// ---------------------------------------------------------------------------------------------

test('(е) лимит → paused, resume продолжает с того же акта без повторов', async () => {
  let limited = true;
  const { ws, h, orch } = setup({
    candidates: { UZ: [cand('a1'), cand('a2'), cand('a3')], KZ: [cand('k1')] },
    analyze: (ctx, c) =>
      limited && c.id === 'a2'
        ? fail('analyze', 'limit', 'Исчерпан лимит подписки Claude', { resetsAt: '2026-11-17T12:00:00.000Z' })
        : ok('analyze', makeCard(c.id, ctx.country.code), c.id),
  });
  const countries = [country('UZ'), country('KZ')];
  const settings = settingsFor(ws);
  const r = okRes(await orch.start({ mode: 'manual', countries, settings, gate: OPEN_GATE }));
  assert.equal(r.end, 'paused');
  let s = loadRun(r.runDir);
  assert.equal(s.paused_until, '2026-11-17T12:00:00.000Z');
  assert.equal(s.finished_at, undefined);
  assert.equal(s.countries.UZ!.status, 'running');
  assert.equal(s.countries.UZ!.stages.analyze.state, 'pending');
  assert.deepEqual(
    Object.fromEntries(Object.entries(s.countries.UZ!.acts).map(([k, v]) => [k, v.analyze])),
    { a1: 'done', a2: 'pending', a3: 'pending' },
  );
  assert.equal(s.countries.KZ!.status, 'pending');
  assert.equal(h.count('collect', 'KZ'), 0);
  assert.equal(findUnfinishedRun(ws)?.state.id, s.id, 'пауза — не остановка: прогон продолжаемый');

  limited = false;
  const r2 = okRes(await orch.resume({ countries, settings }));
  assert.equal(r2.end, 'finished');
  assert.equal(r2.runDir, r.runDir);
  s = loadRun(r.runDir);
  assert.ok(s.finished_at);
  assert.equal(s.paused_until, undefined);
  assert.equal(h.count('collect', 'UZ'), 1);
  assert.equal(h.count('triage', 'UZ'), 1);
  assert.equal(h.count('analyze', 'UZ', 'a1'), 1, 'готовый акт не повторяется');
  assert.equal(h.count('analyze', 'UZ', 'a2'), 2);
  assert.equal(h.count('analyze', 'UZ', 'a3'), 1);
  assert.equal(s.countries.UZ!.status, 'changes');
  assert.equal(s.countries.KZ!.status, 'changes');
  assert.equal(await orch.resume({ countries, settings }), null, 'продолжать больше нечего');
});

test('(е) лимит без времени сброса → пауза на 30 минут', async () => {
  const { ws, orch } = setup({
    candidates: { UZ: [cand('a1')] },
    triage: () => fail('triage', 'limit', 'Исчерпан лимит подписки Claude'),
  });
  const r = okRes(await orch.start({ mode: 'manual', countries: [country('UZ')], settings: settingsFor(ws), gate: OPEN_GATE }));
  assert.equal(r.end, 'paused');
  assert.equal(loadRun(r.runDir).paused_until, new Date(NOW.getTime() + 30 * 60_000).toISOString());
  assert.equal(loadRun(r.runDir).countries.UZ!.stages.triage.state, 'pending');
});

// ---------------------------------------------------------------------------------------------
// (ж) исключение в исполнителе
// ---------------------------------------------------------------------------------------------

test('(ж) исключение в исполнителе → failed:internal без стектрейса, остальные идут', async () => {
  const { ws, orch } = setup({
    candidates: { UZ: [cand('a1')], KZ: [cand('k1')] },
    triage: (ctx, cands) => {
      if (ctx.country.code === 'UZ') throw new TypeError('boom\n    at secret (/x.ts:1:1)');
      return ok('triage', triageAll(ctx.country.code, cands));
    },
  });
  const r = okRes(await orch.start({ mode: 'manual', countries: [country('UZ'), country('KZ')], settings: settingsFor(ws), gate: OPEN_GATE }));
  const s = loadRun(r.runDir);
  assert.equal(s.countries.UZ!.status, 'failed:internal');
  assert.equal(s.countries.KZ!.status, 'changes');
  const err = s.countries.UZ!.stages.triage.error!;
  assert.match(err, /Внутренняя ошибка на этапе «Отбор кандидатов»: boom/);
  assert.doesNotMatch(err, /at secret/);
  assert.doesNotMatch(readFileSync(join(r.runDir, 'run.json'), 'utf8'), /at secret/);
});

// ---------------------------------------------------------------------------------------------
// (з) остановка
// ---------------------------------------------------------------------------------------------

test('(з) stop(): текущий шаг доделывается, состояние сохранено, сам не возобновляется', async () => {
  const inCollect = deferred();
  const release = deferred();
  const { ws, h, orch } = setup({
    collect: async (ctx) => {
      if (ctx.country.code === 'UZ') {
        inCollect.resolve();
        await release.promise;
      }
      return { ok: true, output: { candidates: [cand(`${ctx.country.code.toLowerCase()}1`)] } };
    },
  });
  const countries = [country('UZ'), country('KZ')];
  const settings = settingsFor(ws);
  const p = orch.start({ mode: 'manual', countries, settings, gate: OPEN_GATE });
  await inCollect.promise;
  assert.equal(orch.stop(), p);
  release.resolve();
  const r = okRes(await p);
  assert.equal(r.end, 'stopped');
  let s = loadRun(r.runDir);
  assert.equal(s.stopped, true);
  assert.equal(s.finished_at, undefined);
  assert.equal(s.countries.UZ!.stages.collect.state, 'done', 'начатый шаг доделан и записан');
  assert.equal(s.countries.UZ!.stages.triage.state, 'pending');
  assert.equal(s.countries.KZ!.status, 'pending');
  assert.equal(h.count('triage'), 0);
  assert.equal(orch.stop(), null);

  // при старте приложения сам не продолжается
  assert.equal(findUnfinishedRun(ws), null);
  assert.equal(await orch.resume({ countries, settings }), null);
  // явное «Продолжить» по папке — продолжает без повторения сбора
  const r2 = okRes(await orch.resume({ countries, settings, runDir: r.runDir }));
  assert.equal(r2.end, 'finished');
  s = loadRun(r.runDir);
  assert.equal(s.stopped, undefined);
  assert.equal(h.count('collect', 'UZ'), 1);
  assert.equal(s.countries.UZ!.status, 'changes');
  assert.equal(s.countries.KZ!.status, 'changes');
});

// ---------------------------------------------------------------------------------------------
// Прочее
// ---------------------------------------------------------------------------------------------

test('resume: страна, удалённая из списка, получает failed:missing; finalize с ошибкой не мешает завершению', async () => {
  const { ws, orch } = setup({ candidates: { UZ: [cand('a1')] } }, { finalize: async () => { throw new Error('smtp down'); } });
  const r = okRes(await orch.start({ mode: 'manual', countries: [country('UZ')], settings: settingsFor(ws), gate: OPEN_GATE }));
  assert.ok(loadRun(r.runDir).finished_at);
  assert.ok(readFileSync(join(r.runDir, 'log.jsonl'), 'utf8').includes('smtp down'));

  const b = setup({ candidates: { UZ: [cand('a1')], KZ: [cand('k1')] }, triage: () => fail('triage', 'limit', 'лимит') });
  const p = okRes(await b.orch.start({ mode: 'manual', countries: [country('UZ'), country('KZ')], settings: settingsFor(b.ws), gate: OPEN_GATE }));
  assert.equal(p.end, 'paused');
  const c = new Orchestrator({ executors: makeHarness({ candidates: { KZ: [cand('k1')] } }).executors, now: () => NOW });
  const r2 = okRes(await c.resume({ countries: [country('KZ')], settings: settingsFor(b.ws) }));
  const s = loadRun(r2.runDir);
  assert.equal(s.countries.UZ!.status, 'failed:missing');
  assert.equal(s.countries.KZ!.status, 'changes');
});

test('computeWindow: с последнего успеха, иначе firstRunDays назад; override — как есть', () => {
  const ws = tmp();
  const st = settingsFor(ws);
  assert.deepEqual(computeWindow(ws, 'UZ', st, NOW), { from: '2026-10-18', to: '2026-11-17' });
  mkdirSync(join(ws, 'state'), { recursive: true });
  writeFileSync(join(ws, 'state', 'last_success.json'), JSON.stringify({ UZ: new Date(2026, 10, 10, 9, 0).toISOString() }));
  assert.deepEqual(computeWindow(ws, 'UZ', st, NOW), { from: '2026-11-10', to: '2026-11-17' });
  assert.deepEqual(computeWindow(ws, 'KZ', st, NOW).from, '2026-10-18');
  assert.deepEqual(computeWindow(ws, 'UZ', st, NOW, { from: '2026-01-01', to: '2026-02-01' }), { from: '2026-01-01', to: '2026-02-01' });
});

test('outcomeFromStage: успех и провал claude-runner → Outcome с процессом и расходом', () => {
  const inv = { stage: 'analyze' as const, model: 'opus' };
  const okRes = outcomeFromStage<{ x: number }>(
    { ok: true, output: { x: 1 }, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3 }, modelUsage: null, costUsd: 0.2, durationMs: 1500, attempts: 1, exitCode: 0, denied: [] },
    inv,
    'a1',
  );
  assert.ok(okRes.ok);
  assert.deepEqual(okRes.usage, { input: 10, output: 5, cache_read: 3, cache_write: 0, cost_usd: 0.2 });
  assert.equal(okRes.processes![0]!.act, 'a1');
  const bad = outcomeFromStage(
    { ok: false, failure: 'limit', message: 'Исчерпан лимит', resetsAt: '2026-11-17T12:00:00.000Z', attempts: 1, durationMs: 10, exitCode: 1, denied: [{ tool: 'Bash', input: null, kind: 'no_tool' }] },
    inv,
  );
  assert.ok(!bad.ok);
  assert.equal(bad.failure, 'limit');
  assert.equal(bad.resetsAt, '2026-11-17T12:00:00.000Z');
  assert.deepEqual(bad.processes![0]!.denied, ['Bash']);
  assert.deepEqual(usageFromRunner(null, null), { input: 0, output: 0, cache_read: 0, cache_write: 0, cost_usd: 0 });
});
