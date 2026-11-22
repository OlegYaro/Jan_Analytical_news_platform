// Бюджет 5-часового лимита (NFR-06, T-8): решение по rate_limit.json, свежесть, порог 100, недельный лимит,
// проброс rate_limit_event → бюджет, пауза оркестратора и продолжение с той же страны и этапа.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import type { Candidate } from '../../shared/pipeline-types.ts';
import type { TriageOutput } from '../../shared/schema-types.ts';
import {
  FRESH_MS,
  RATE_LIMIT_FILE,
  RESUME_MARGIN_MS,
  budgetGate,
  createBudget,
  decideBudget,
  mergeObservation,
  observingRunStage,
  readRateLimitFile,
} from './budget.ts';
import type { RateLimitFile } from './budget.ts';
import type { RunStageOptions, StageResult } from './claude-runner.ts';
import { createStageExecutors } from './executors.ts';
import { CountryFailure, Orchestrator, PauseSignal, WEEKLY_LIMIT_FAILURE } from './orchestrator.ts';
import { loadRun } from './run-state.ts';
import { OPEN_GATE, cand, country, fail, makeCard, makeHarness, ok, settingsFor, triageAll } from './fixtures/orchestrator-stubs.ts';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'rw-budget-'));
const T0 = new Date('2026-11-21T10:00:00.000Z');
const at = (ms: number): Date => new Date(T0.getTime() + ms);
const H = 3600_000;

const file = (o: Partial<RateLimitFile>): RateLimitFile => ({ version: 1, updated_at: T0.toISOString(), ...o });
const win = (utilization: number, resetsIn: number, observedAgo = 0) => ({
  utilization,
  resets_at: at(resetsIn).toISOString(),
  observed_at: at(-observedAgo).toISOString(),
});

// ---------------------------------------------------------------------------------------------
// Чистое решение
// ---------------------------------------------------------------------------------------------

test('decideBudget: данных нет → процесс идёт (первый процесс без пробы)', () => {
  assert.deepEqual(decideBudget(null, 80, T0), { kind: 'go', reason: 'no_data' });
  assert.deepEqual(decideBudget(file({}), 80, T0), { kind: 'go', reason: 'no_data' });
});

test('decideBudget: окно ниже порога → идёт; достигло порога → пауза до сброса + 30 с', () => {
  assert.deepEqual(decideBudget(file({ five_hour: win(0.79, 2 * H) }), 80, T0), { kind: 'go', reason: 'below' });
  const d = decideBudget(file({ five_hour: win(0.8, 2 * H) }), 80, T0);
  assert.equal(d.kind, 'pause');
  assert.ok(d.kind === 'pause');
  assert.equal(d.until, new Date(at(2 * H).getTime() + RESUME_MARGIN_MS).toISOString());
  assert.equal(d.threshold, 80);
  // порог 1 % (T-8)
  assert.equal(decideBudget(file({ five_hour: win(0.01, H) }), 1, T0).kind, 'pause');
  assert.equal(decideBudget(file({ five_hour: win(0.009, H) }), 1, T0).kind, 'go');
});

test('decideBudget: устаревшие данные игнорируются (старше 5 ч или окно уже сброшено)', () => {
  assert.deepEqual(decideBudget(file({ five_hour: win(0.99, 2 * H, FRESH_MS + 1000) }), 80, T0), { kind: 'go', reason: 'stale' });
  assert.deepEqual(decideBudget(file({ five_hour: win(0.99, -1000) }), 80, T0), { kind: 'go', reason: 'stale' });
  assert.deepEqual(decideBudget(file({ five_hour: { utilization: 0.99, resets_at: null, observed_at: T0.toISOString() } }), 80, T0), { kind: 'go', reason: 'stale' });
});

test('decideBudget: порог 100 → пауза только по настоящей ошибке лимита (бюджет не останавливает)', () => {
  assert.deepEqual(decideBudget(file({ five_hour: win(1, H) }), 100, T0), { kind: 'go', reason: 'no_threshold' });
});

test('decideBudget: недельное окно ≥ 98 % → страна не начинается (в т.ч. при пороге 100); после сброса — нет', () => {
  const w = decideBudget(file({ five_hour: win(0.1, H), seven_day: win(0.98, 50 * H) }), 100, T0);
  assert.equal(w.kind, 'weekly');
  assert.equal(decideBudget(file({ seven_day: win(0.97, 50 * H) }), 80, T0).kind, 'go');
  assert.equal(decideBudget(file({ seven_day: win(0.99, -1000) }), 80, T0).kind, 'go', 'неделя сброшена');
});

test('mergeObservation: окно без новых данных сохраняется; ошибка лимита отмечает отказавшее окно', () => {
  const prev = file({ seven_day: win(0.5, 50 * H) });
  const m = mergeObservation(prev, { utilization: 0.4, resetsAt: at(H).toISOString(), status: 'allowed' }, undefined, T0)!;
  assert.equal(m.five_hour?.utilization, 0.4);
  assert.equal(m.seven_day?.utilization, 0.5, 'неделя из прежнего файла');
  assert.equal(mergeObservation(prev, { status: 'allowed' }, undefined, T0), null, 'без долей — без записи');
  const lim = mergeObservation(null, undefined, { resetsAt: at(2 * H).toISOString() }, T0)!;
  assert.equal(lim.five_hour?.utilization, 1);
  const week = mergeObservation(null, undefined, { resetsAt: at(40 * H).toISOString() }, T0)!;
  assert.equal(week.seven_day?.utilization, 1);
  assert.equal(week.five_hour, undefined);
});

// ---------------------------------------------------------------------------------------------
// Файл state/rate_limit.json, перезапуск, сигналы
// ---------------------------------------------------------------------------------------------

test('createBudget: наблюдение → state/rate_limit.json с отметкой времени; новый экземпляр (перезапуск) читает его и ставит паузу', async () => {
  const ws = tmp();
  let now = T0;
  const b = createBudget({ workspaceDir: () => ws, getSettings: () => ({ limitPercent: 80 }), now: () => now });
  await b.beforeProcess(); // данных нет — идёт
  b.observe({ utilization: 0.85, resetsAt: at(2 * H).toISOString(), status: 'allowed_warning', sevenDay: { utilization: 0.3, resetsAt: at(90 * H).toISOString() } });
  const f = JSON.parse(readFileSync(join(ws, RATE_LIMIT_FILE), 'utf8'));
  assert.equal(f.version, 1);
  assert.equal(f.five_hour.utilization, 0.85);
  assert.equal(f.five_hour.observed_at, T0.toISOString());
  assert.equal(f.seven_day.utilization, 0.3);
  assert.equal(f.updated_at, T0.toISOString());

  now = at(60_000);
  const b2 = createBudget({ workspaceDir: () => ws, getSettings: () => ({ limitPercent: 80 }), now: () => now });
  await assert.rejects(b2.beforeProcess(), (e: unknown) => {
    assert.ok(e instanceof PauseSignal);
    assert.equal(e.until, new Date(at(2 * H).getTime() + RESUME_MARGIN_MS).toISOString());
    assert.match(e.message, /85 %.*80 %/);
    return true;
  });
  // Ползунок подняли до 90 % — тот же бюджет пропускает (порог берётся из текущих настроек).
  const b3 = createBudget({ workspaceDir: () => ws, getSettings: () => ({ limitPercent: 90, uiLanguage: 'en' }), now: () => now });
  await b3.beforeProcess();
  // После сброса окна данные устарели — процесс идёт.
  now = at(2 * H + 1000);
  await b2.beforeProcess();
});

test('createBudget: старый rate_limit.json (больше 5 ч) игнорируется', async () => {
  const ws = tmp();
  mkdirSync(join(ws, 'state'), { recursive: true });
  writeFileSync(join(ws, RATE_LIMIT_FILE), JSON.stringify(file({ five_hour: { utilization: 1, resets_at: at(H).toISOString(), observed_at: at(-6 * H).toISOString() } })));
  const b = createBudget({ workspaceDir: () => ws, getSettings: () => ({ limitPercent: 50 }), now: () => T0 });
  assert.deepEqual(b.decide(), { kind: 'go', reason: 'stale' });
  await b.beforeProcess();
  // битый файл — как нет данных
  writeFileSync(join(ws, RATE_LIMIT_FILE), '{oops');
  assert.equal(readRateLimitFile(ws), null);
  await b.beforeProcess();
});

test('createBudget: недельный лимит → CountryFailure(limit) с понятной причиной (ru/en)', async () => {
  const ws = tmp();
  const b = createBudget({ workspaceDir: () => ws, getSettings: () => ({ limitPercent: 80 }), now: () => T0 });
  b.observe({ utilization: 0.1, resetsAt: at(H).toISOString(), sevenDay: { utilization: 0.985, resetsAt: at(60 * H).toISOString() } });
  await assert.rejects(b.beforeProcess(), (e: unknown) => e instanceof CountryFailure && e.code === 'limit' && /Недельный лимит Claude почти исчерпан \(98\.5 %/.test(e.message));
  const en = createBudget({ workspaceDir: () => ws, getSettings: () => ({ limitPercent: 80, uiLanguage: 'en' }), now: () => T0 });
  await assert.rejects(en.beforeProcess(), (e: unknown) => e instanceof CountryFailure && /weekly Claude limit is almost used up/.test(e.message));
});

test('observingRunStage: после каждого процесса сведения о лимите доезжают до бюджета; ошибка лимита — тоже', async () => {
  const ws = tmp();
  const b = createBudget({ workspaceDir: () => ws, getSettings: () => ({ limitPercent: 80 }), now: () => T0 });
  const res: StageResult = {
    ok: true, output: {}, usage: null, modelUsage: null, costUsd: 0.1, durationMs: 1, attempts: 1, exitCode: 0, denied: [],
    rateLimit: { utilization: 0.42, resetsAt: at(H).toISOString(), status: 'allowed' },
  };
  const run = observingRunStage(async () => res, b);
  assert.equal(await run({} as RunStageOptions), res, 'результат не меняется');
  assert.equal(b.read()?.five_hour?.utilization, 0.42);
  const lim: StageResult = { ok: false, failure: 'limit', message: 'Исчерпан лимит подписки Claude', resetsAt: at(3 * H).toISOString(), attempts: 1, durationMs: 1, exitCode: 1, denied: [] };
  await observingRunStage(async () => lim, b)({} as RunStageOptions);
  assert.equal(b.read()?.five_hour?.utilization, 1);
  assert.equal(b.decide().kind, 'pause');
});

test('budgetGate: пауза → провал limit с resetsAt; недельный → weekly_limit; без бюджета — null', async () => {
  assert.equal(await budgetGate(undefined), null);
  assert.equal(await budgetGate({ beforeProcess: async () => {} }), null);
  assert.deepEqual(await budgetGate({ beforeProcess: async () => { throw new PauseSignal('2026-11-21T12:00:30.000Z', 'пауза'); } }), {
    ok: false, failure: 'limit', message: 'пауза', resetsAt: '2026-11-21T12:00:30.000Z',
  });
  const w = await budgetGate({ beforeProcess: async () => { throw new CountryFailure('limit', 'неделя'); } });
  assert.equal(w?.failure, WEEKLY_LIMIT_FAILURE);
  await assert.rejects(budgetGate({ beforeProcess: async () => { throw new Error('другое'); } }), /другое/);
});

// ---------------------------------------------------------------------------------------------
// T-8: пауза оркестратора по порогу и продолжение с той же страны и этапа
// ---------------------------------------------------------------------------------------------

test('T-8: порог 1 % → пауза после первого процесса, paused_until = сброс окна + 30 с; после сброса — продолжение с той же страны и этапа без повторов', async () => {
  const ws = tmp();
  let now = T0;
  const settings = settingsFor(ws, { limitPercent: 1 });
  const budget = createBudget({ workspaceDir: () => ws, getSettings: () => settings, now: () => now });
  const reset = at(2 * H).toISOString();
  let util = 0.05;
  // Заглушки исполнителей ведут себя как runStage с обёрткой: каждый процесс сообщает долю окна.
  const report = (): void => budget.observe({ utilization: util, resetsAt: util > 0 ? reset : at(7 * H).toISOString() });
  const h = makeHarness({
    candidates: { UZ: [cand('a1'), cand('a2')], KZ: [cand('k1')] },
    triage: (ctx, cands) => (report(), ok('triage', triageAll(ctx.country.code, cands))),
    analyze: (ctx, c) => (report(), ok('analyze', makeCard(c.id, ctx.country.code), c.id)),
  });
  const orch = new Orchestrator({ executors: h.executors, budget, now: () => now });
  const countries = [country('UZ'), country('KZ')];

  const r = await orch.start({ mode: 'manual', countries, settings, gate: OPEN_GATE });
  assert.ok(r.ok && r.end === 'paused', JSON.stringify(r));
  let s = loadRun(r.runDir);
  assert.equal(s.paused_until, new Date(Date.parse(reset) + RESUME_MARGIN_MS).toISOString());
  assert.equal(h.count('triage', 'UZ'), 1, 'первый процесс прошёл (данных до него не было)');
  assert.equal(h.count('analyze', 'UZ'), 0, 'второй процесс не начат');
  assert.equal(s.countries.UZ!.status, 'running');
  assert.equal(s.countries.UZ!.stages.triage.state, 'done');
  assert.equal(s.countries.UZ!.stages.analyze.state, 'pending');
  assert.equal(s.countries.KZ!.status, 'pending');
  const log = readFileSync(join(r.runDir, 'log.jsonl'), 'utf8');
  assert.match(log, /run_paused/);
  assert.match(log, /5-часовой лимит Claude использован на 5 %/);

  // До сброса продолжение снова встаёт на паузу, ничего не запуская.
  now = at(H);
  const early = await orch.resume({ countries, settings });
  assert.ok(early && early.ok && early.end === 'paused');
  assert.equal(h.count('analyze', 'UZ'), 0);

  // После сброса окна (данные устарели) — продолжение с UZ / анализ, отбор не повторяется.
  now = at(2 * H + RESUME_MARGIN_MS + 5_000);
  util = 0;
  const r2 = await orch.resume({ countries, settings });
  assert.ok(r2 && r2.ok && r2.end === 'finished', JSON.stringify(r2));
  s = loadRun(r.runDir);
  assert.equal(s.paused_until, undefined);
  assert.ok(s.finished_at);
  assert.equal(h.count('collect', 'UZ'), 1);
  assert.equal(h.count('triage', 'UZ'), 1, 'отбор UZ не повторён');
  assert.equal(h.count('analyze', 'UZ', 'a1'), 1);
  assert.equal(h.count('analyze', 'UZ', 'a2'), 1);
  assert.equal(s.countries.UZ!.status, 'changes');
  assert.equal(s.countries.KZ!.status, 'changes');
});

test('T-8: ошибка лимита CLI → пауза до времени сброса; продолжение не повторяет сделанное; бюджет помнит отказ', async () => {
  const ws = tmp();
  let now = T0;
  const settings = settingsFor(ws, { limitPercent: 80 });
  const budget = createBudget({ workspaceDir: () => ws, getSettings: () => settings, now: () => now });
  const reset = at(3 * H).toISOString();
  let limited = true;
  const h = makeHarness({
    candidates: { UZ: [cand('a1'), cand('a2')] },
    analyze: (ctx, c) => {
      if (limited && c.id === 'a2') {
        budget.observe(undefined, { resetsAt: reset }); // как observingRunStage на провале limit
        return fail('analyze', 'limit', 'Исчерпан лимит подписки Claude', { resetsAt: reset });
      }
      return ok('analyze', makeCard(c.id, ctx.country.code), c.id);
    },
  });
  const orch = new Orchestrator({ executors: h.executors, budget, now: () => now });
  const r = await orch.start({ mode: 'manual', countries: [country('UZ')], settings, gate: OPEN_GATE });
  assert.ok(r.ok && r.end === 'paused');
  assert.equal(loadRun(r.runDir).paused_until, reset);
  assert.equal(budget.decide().kind, 'pause', 'отказ записан в rate_limit.json');
  assert.ok(existsSync(join(ws, RATE_LIMIT_FILE)));

  now = at(3 * H + 60_000);
  limited = false;
  const r2 = await orch.resume({ countries: [country('UZ')], settings });
  assert.ok(r2 && r2.ok && r2.end === 'finished');
  assert.equal(h.count('analyze', 'UZ', 'a1'), 1, 'готовый акт не повторён');
  assert.equal(h.count('analyze', 'UZ', 'a2'), 2);
  assert.equal(h.count('triage', 'UZ'), 1);
});

test('недельный лимит: страна failed:limit с понятной причиной, остальные тоже не начинаются, прогон завершается', async () => {
  const ws = tmp();
  const settings = settingsFor(ws);
  const budget = createBudget({ workspaceDir: () => ws, getSettings: () => settings, now: () => T0 });
  const h = makeHarness({
    candidates: { UZ: [cand('a1')], KZ: [cand('k1')] },
    triage: (ctx, cands) => {
      budget.observe({ utilization: 0.2, resetsAt: at(H).toISOString(), sevenDay: { utilization: 0.99, resetsAt: at(70 * H).toISOString() } });
      return ok('triage', triageAll(ctx.country.code, cands));
    },
  });
  const orch = new Orchestrator({ executors: h.executors, budget, now: () => T0 });
  const r = await orch.start({ mode: 'manual', countries: [country('UZ'), country('KZ')], settings, gate: OPEN_GATE });
  assert.ok(r.ok && r.end === 'finished', JSON.stringify(r));
  assert.equal(r.state.countries.UZ!.status, 'failed:limit');
  assert.equal(r.state.countries.KZ!.status, 'failed:limit');
  assert.equal(h.count('triage', 'KZ'), 0, 'KZ не тратит лимит');
  const res = JSON.parse(readFileSync(join(r.runDir, 'UZ', 'result.json'), 'utf8'));
  assert.match(res.error, /Недельный лимит Claude почти исчерпан/);
});

test('ошибка лимита со сбросом дальше 6 ч (недельное окно) → failed:limit, а не пауза на дни', async () => {
  const ws = tmp();
  const h = makeHarness({
    candidates: { UZ: [cand('a1')] },
    triage: () => fail('triage', 'limit', 'Исчерпан лимит подписки Claude', { resetsAt: at(48 * H).toISOString() }),
  });
  const orch = new Orchestrator({ executors: h.executors, now: () => T0 });
  const r = await orch.start({ mode: 'manual', countries: [country('UZ')], settings: settingsFor(ws), gate: OPEN_GATE });
  assert.ok(r.ok && r.end === 'finished');
  assert.equal(r.state.countries.UZ!.status, 'failed:limit');
  assert.equal(r.state.paused_until, undefined);
});

// ---------------------------------------------------------------------------------------------
// Боевые исполнители: rate_limit_event раннера → бюджет → пауза между пакетами отбора
// ---------------------------------------------------------------------------------------------

const SCHEMAS = resolve(import.meta.dirname, '..', '..', '..', 'schemas');

test('T-8 на боевых исполнителях: доля окна из процесса отбора → пауза перед вторым пакетом; расход учтён; после сброса готовый пакет не повторяется', async () => {
  const ws = tmp();
  let now = T0;
  const settings = settingsFor(ws, { limitPercent: 10 });
  const budget = createBudget({ workspaceDir: () => ws, getSettings: () => settings, now: () => now });
  const reset = at(H).toISOString();
  let util = 0.5;
  const calls: string[] = [];
  const fake = async (opts: RunStageOptions): Promise<StageResult> => {
    const input = JSON.parse(readFileSync(opts.invocation.prompt.split(' ').slice(1).join(' '), 'utf8')) as Record<string, unknown>;
    calls.push(opts.invocation.stage);
    let output: unknown;
    if (opts.invocation.stage === 'triage') {
      const items = (input['candidates'] as Candidate[]).map((c) => ({ id: c.id, decision: 'irrelevant' as const, reason_code: 'other_sector' as const, reason_text: 'r', confidence: 'high' as const }));
      output = { country: 'UZ', items } satisfies TriageOutput;
    } else {
      output = { country: 'UZ', cards: [], returned: [], watched_acts_check: [] };
    }
    return {
      ok: true, output, usage: { input_tokens: 10, output_tokens: 2 }, modelUsage: null, costUsd: 0.01, durationMs: 1, attempts: 1, exitCode: 0, denied: [],
      rateLimit: { utilization: util, resetsAt: util > 0 ? reset : at(6 * H).toISOString(), status: 'allowed' },
    };
  };
  const cands = Array.from({ length: 41 }, (_, i) => cand(`c${i + 1}`));
  const executors = createStageExecutors({
    schemasDir: SCHEMAS,
    claudeBin: () => '/usr/local/bin/claude',
    claudeEnv: () => ({ PATH: '/usr/bin' }),
    fetcher: { get: async () => ({ ok: false, kind: 'network', message: 'нет сети в тесте' }), postForm: async () => ({ ok: false, kind: 'network', message: 'нет' }) } as never,
    collector: { collect: async () => ({ ok: true, output: { candidates: cands } }) },
    runStage: observingRunStage(fake, budget),
    budget,
    now: () => now,
  });
  const orch = new Orchestrator({ executors, budget, now: () => now });
  const r = await orch.start({ mode: 'manual', countries: [country('UZ')], settings, gate: OPEN_GATE });
  assert.ok(r.ok && r.end === 'paused', JSON.stringify(r));
  assert.deepEqual(calls, ['triage'], 'второй пакет отбора не запущен');
  const s = loadRun(r.runDir);
  assert.equal(s.paused_until, new Date(Date.parse(reset) + RESUME_MARGIN_MS).toISOString());
  assert.equal(s.countries.UZ!.usage.input, 10, 'расход первого пакета учтён');
  assert.equal(s.countries.UZ!.stages.triage.state, 'pending');
  assert.equal(JSON.parse(readFileSync(join(ws, RATE_LIMIT_FILE), 'utf8')).five_hour.utilization, 0.5);

  now = at(H + RESUME_MARGIN_MS + 1000);
  util = 0;
  const r2 = await orch.resume({ countries: [country('UZ')], settings });
  assert.ok(r2 && r2.ok && r2.end === 'finished', JSON.stringify(r2));
  assert.deepEqual(calls, ['triage', 'triage', 'verify'], 'после сброса — только второй пакет отбора и проверка');
  assert.equal(r2.state.countries.UZ!.status, 'no_changes');
});
