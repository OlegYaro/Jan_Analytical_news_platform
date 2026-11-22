import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { writeAtomic } from '../fs-atomic.ts';
import {
  addUsage,
  createRun,
  findUnfinishedRun,
  finishRun,
  loadRun,
  markAct,
  markStage,
  resumePlan,
  saveRun,
  setCountryStatus,
  setCurrent,
} from './run-state.ts';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'rw-run-'));
const W = { from: '2026-11-01', to: '2026-11-15' };
const mk = (ws: string, now = new Date(2026, 10, 17, 8, 0)) =>
  createRun({ workspaceDir: ws, mode: 'manual', countries: [{ code: 'UZ', window: W }, { code: 'KZ', window: W }], skillsHash: 'h', now });

test('createRun: форма по docs/04 §9 и id по минуте', () => {
  const ws = tmp();
  const { dir, state } = mk(ws);
  assert.equal(state.id, '2026-11-17_0800');
  const loaded = loadRun(dir);
  assert.deepEqual(loaded, state);
  assert.equal(loaded.mode, 'manual');
  assert.equal(loaded.skills_hash, 'h');
  const uz = loaded.countries.UZ!;
  assert.equal(uz.status, 'pending');
  assert.deepEqual(Object.keys(uz.stages), ['collect', 'news', 'triage', 'screen', 'analyze', 'verify']);
  assert.deepEqual(uz.stages.collect, { state: 'pending', attempts: 0 });
  assert.deepEqual(uz.usage, { input: 0, output: 0, cache_read: 0, cache_write: 0, cost_usd: 0 });
  assert.deepEqual(uz.acts, {});
  assert.equal(loaded.finished_at, undefined);
});

test('createRun: суффикс при совпадении минуты', () => {
  const ws = tmp();
  assert.equal(mk(ws).state.id, '2026-11-17_0800');
  assert.equal(mk(ws).state.id, '2026-11-17_0800-2');
  assert.equal(mk(ws).state.id, '2026-11-17_0800-3');
});

test('запись атомарна: нет tmp-хвостов', () => {
  const { dir, state } = mk(tmp());
  for (let i = 0; i < 5; i++) {
    addUsage(state, 'UZ', { input: 1 });
    saveRun(dir, state);
  }
  assert.deepEqual(readdirSync(dir), ['run.json']);
  assert.equal(loadRun(dir).countries.UZ!.usage.input, 5);
});

test('падение между tmp и rename: старый файл цел; сбой rename убирает tmp', () => {
  const { dir, state } = mk(tmp());
  // «упали» после записи tmp, до rename
  writeFileSync(join(dir, 'run.json.tmp-999-0'), '{"id": "полу');
  assert.equal(loadRun(dir).id, state.id);
  // сбой rename (на месте цели каталог) не оставляет хвоста
  const target = join(dir, 'blocked');
  mkdirSync(target);
  assert.throws(() => writeAtomic(target, 'x'));
  assert.deepEqual(readdirSync(dir).sort(), ['blocked', 'run.json', 'run.json.tmp-999-0']);
});

test('операции над состоянием', () => {
  const { state } = mk(tmp());
  markStage(state, 'UZ', 'collect', { state: 'running', attempts: 1 });
  markStage(state, 'UZ', 'collect', { state: 'failed', error: 'boom' });
  assert.deepEqual(state.countries.UZ!.stages.collect, { state: 'failed', attempts: 1, error: 'boom' });
  markAct(state, 'UZ', '3254-2', { analyze: 'done', rounds: 2, verdict: 'ok' });
  assert.equal(state.countries.UZ!.acts['3254-2']!.rounds, 2);
  setCountryStatus(state, 'UZ', 'failed:source');
  addUsage(state, 'UZ', { cost_usd: 0.5, output: 3 });
  addUsage(state, 'UZ', { cost_usd: 0.25 });
  assert.equal(state.countries.UZ!.usage.cost_usd, 0.75);
  setCurrent(state, { country: 'UZ', stage: 'analyze', act: '3254-2', text: 'Читаю акт' });
  assert.equal(state.current?.text, 'Читаю акт');
  finishRun(state, new Date(2026, 10, 17, 9, 0));
  assert.ok(state.finished_at);
  assert.equal(state.current, undefined);
  assert.throws(() => setCountryStatus(state, 'XX', 'running'));
});

test('findUnfinishedRun: самый свежий без finished_at, битые пропускаются', () => {
  const ws = tmp();
  assert.equal(findUnfinishedRun(ws), null);
  const a = mk(ws, new Date(2026, 10, 17, 8, 0));
  finishRun(a.state, new Date());
  saveRun(a.dir, a.state);
  assert.equal(findUnfinishedRun(ws), null);
  const b = mk(ws, new Date(2026, 10, 17, 9, 0));
  const c = mk(ws, new Date(2026, 10, 17, 10, 0));
  mkdirSync(join(ws, 'runs', 'zzz-broken'));
  writeFileSync(join(ws, 'runs', 'zzz-broken', 'run.json'), '{oops');
  assert.equal(findUnfinishedRun(ws)?.state.id, c.state.id);
  finishRun(c.state, new Date());
  saveRun(c.dir, c.state);
  assert.equal(findUnfinishedRun(ws)?.state.id, b.state.id);
});

test('findUnfinishedRun: остановленный пользователем не возобновляется сам', () => {
  const ws = tmp();
  const a = mk(ws, new Date(2026, 10, 17, 8, 0));
  const b = mk(ws, new Date(2026, 10, 17, 9, 0));
  b.state.stopped = true;
  saveRun(b.dir, b.state);
  assert.equal(findUnfinishedRun(ws)?.state.id, a.state.id);
  a.state.stopped = true;
  saveRun(a.dir, a.state);
  assert.equal(findUnfinishedRun(ws), null);
  // явное продолжение снимает флаг — прогон снова виден
  delete b.state.stopped;
  saveRun(b.dir, b.state);
  assert.equal(findUnfinishedRun(ws)?.state.id, b.state.id);
});

test('resumePlan: этапы и акты', () => {
  const { state } = mk(tmp());
  // UZ: collect, news готовы, triage прервался (running), analyze: один акт готов
  markStage(state, 'UZ', 'collect', { state: 'done', attempts: 1 });
  markStage(state, 'UZ', 'news', { state: 'skipped' });
  markStage(state, 'UZ', 'triage', { state: 'running', attempts: 1 });
  markAct(state, 'UZ', 'a1', { analyze: 'done' });
  markAct(state, 'UZ', 'a2', { analyze: 'running' });
  markAct(state, 'UZ', 'a3', { analyze: 'failed' });
  // KZ закончена
  setCountryStatus(state, 'KZ', 'no_changes');
  const plan = resumePlan(state);
  const uz = plan.find((p) => p.code === 'UZ')!;
  assert.equal(uz.skip, false);
  assert.equal(uz.nextStage, 'triage');
  assert.deepEqual(uz.stages, { collect: 'skip', news: 'skip', triage: 'run', screen: 'run', analyze: 'run', verify: 'run' });
  assert.deepEqual(uz.doneActs, ['a1']);
  assert.deepEqual(uz.pendingActs, ['a2', 'a3']);
  const kz = plan.find((p) => p.code === 'KZ')!;
  assert.equal(kz.skip, true);
  assert.equal(kz.nextStage, null);
  assert.deepEqual(kz.pendingActs, []);
});

test('resumePlan: analyze завершён — акты не повторяются', () => {
  const { state } = mk(tmp());
  for (const s of ['collect', 'news', 'triage', 'screen', 'analyze'] as const) markStage(state, 'UZ', s, { state: 'done' });
  markAct(state, 'UZ', 'a1', { analyze: 'done' });
  const uz = resumePlan(state).find((p) => p.code === 'UZ')!;
  assert.equal(uz.nextStage, 'verify');
  assert.deepEqual(uz.pendingActs, []);
});

test('run.json читается как JSON с отступами', () => {
  const { dir } = mk(tmp());
  assert.ok(existsSync(join(dir, 'run.json')));
  assert.ok(readFileSync(join(dir, 'run.json'), 'utf8').endsWith('\n'));
});

test('loadRun: у старого прогона без этапа «screen» экран пропускается, если отбор уже сделан', () => {
  const dir = mkdtempSync(join(tmpdir(), 'regwatch-rs-'));
  try {
    const stage = (state: string) => ({ state, attempts: 1 });
    const old = (triage: string) => ({
      id: '2026-11-18_1517', mode: 'dry_run', started_at: '2026-11-18T14:17:15.631Z', skills_hash: '',
      countries: {
        UZ: { window: { from: '2026-10-19', to: '2026-11-18' }, status: 'running', acts: {}, usage: {},
          stages: { collect: stage('done'), news: stage('done'), triage: stage(triage), analyze: stage('pending'), verify: stage('pending') } },
      },
    });
    writeFileSync(join(dir, 'run.json'), JSON.stringify(old('done')));
    assert.equal(loadRun(dir).countries['UZ']!.stages.screen.state, 'skipped');
    writeFileSync(join(dir, 'run.json'), JSON.stringify(old('pending')));
    assert.equal(loadRun(dir).countries['UZ']!.stages.screen.state, 'pending');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
