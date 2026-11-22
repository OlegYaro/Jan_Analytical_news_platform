// Контроллер проверки/поиска источников (IPC для окна): одно задание за раз, отказ во время прогона, ход, «Добавить».
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ActProposalDto, SourceProposalDto } from '../../shared/sources-types.ts';
import { loadCountries } from '../countries/store.ts';
import { defaultSettings } from '../settings/defaults.ts';
import type { CheckSourcesOptions, CheckSourcesResult } from './checker.ts';
import type { DiscoverOptions, DiscoverResult } from './discover.ts';
import { BAD_SCOPE_MESSAGE, RUN_BUSY_MESSAGE, SOURCES_BUSY_MESSAGE, STALE_PROPOSAL_MESSAGE, createSourcesController } from './sources-controller.ts';
import type { SourcesControllerDeps } from './sources-controller.ts';

function setup(over: Partial<SourcesControllerDeps> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'rw-sc-'));
  const cdir = join(root, 's');
  const ws = join(root, 'ws');
  mkdirSync(ws, { recursive: true });
  loadCountries(cdir); // стартовый набор: 9 стран
  const checked: CheckSourcesOptions[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const check = async (o: CheckSourcesOptions): Promise<CheckSourcesResult> => {
    checked.push(o);
    o.onProgress?.({ code: o.country, text: `${o.country}: открываем`, done: 1, total: 2 });
    await gate;
    return { country: o.country, ok: true, message: `${o.country}: ✅ 1`, sources: [], acts: [], costUsd: 0, modelCalls: [], unresolved: [], dir: '' };
  };
  let runBusy = false;
  const c = createSourcesController({
    fetcher: { get: async () => ({ ok: false, kind: 'network', message: '' }), postForm: async () => ({ ok: false, kind: 'network', message: '' }) },
    workspaceDir: () => ws,
    countriesDir: () => cdir,
    getSettings: () => ({ ...defaultSettings(ws), workspaceDir: ws }),
    isRunBusy: () => runBusy,
    schemasDir: '/nope',
    claudeBin: () => '/bin/false',
    claudeEnv: () => ({}),
    check,
    ...over,
  });
  return { c, cdir, checked, release, setRunBusy: (v: boolean) => (runBusy = v) };
}

test('check: все страны в фоне, ход в status/onChange, второе задание — отказ, итог', async () => {
  const t = setup();
  let events = 0;
  t.c.onChange(() => events++);
  const r = await t.c.check({ all: true });
  assert.ok(r.ok, r.message);
  assert.ok(t.c.status().running);
  assert.equal(t.c.status().total, 28 + 2, '28 источников и 2 акта стартового набора');
  assert.ok(t.c.status().startedAt);
  const again = await t.c.check({ code: 'UZ' });
  assert.deepEqual(again, { ok: false, message: SOURCES_BUSY_MESSAGE });
  const d = await t.c.discover('UZ', 'watched');
  assert.equal(d.ok, false);
  assert.equal(d.message, SOURCES_BUSY_MESSAGE);
  t.release();
  await t.c.idle();
  const st = t.c.status();
  assert.equal(st.running, false);
  assert.equal(st.done, st.total);
  assert.equal(t.checked.length, 9);
  assert.match(st.lastMessage ?? '', /UZ: ✅ 1/);
  assert.ok(events >= 3);
});

test('check: во время прогона — отказ «Дождитесь окончания проверки»; неверная область — понятный текст', async () => {
  const t = setup();
  t.setRunBusy(true);
  assert.deepEqual(await t.c.check({ all: true }), { ok: false, message: RUN_BUSY_MESSAGE });
  assert.match(RUN_BUSY_MESSAGE, /^Дождитесь окончания проверки/);
  t.setRunBusy(false);
  assert.deepEqual(await t.c.check({}), { ok: false, message: BAD_SCOPE_MESSAGE });
  assert.equal((await t.c.check({ code: 'XX' })).ok, false);
  assert.equal((await t.c.check({ code: 'UZ', sourceId: 'нет' })).message, 'Источник не найден');
  const one = await t.c.check({ code: 'UZ', sourceId: 'seed-uz-2' });
  assert.ok(one.ok);
  t.release();
  await t.c.idle();
  assert.deepEqual(t.checked[0]!.sourceIds, ['seed-uz-2']);
  assert.equal(t.c.status().total, 1);
});

test('нет Claude Code → отказ до начала задания', async () => {
  const t = setup({ preflight: async () => 'Не найдена программа Claude Code.' });
  assert.deepEqual(await t.c.check({ code: 'UZ' }), { ok: false, message: 'Не найдена программа Claude Code.' });
  assert.equal(t.c.status().running, false);
});

test('discover → «Добавить» принимает только подтверждённые предложения последнего поиска', async () => {
  const sp: SourceProposalDto = { type: 'drafts', name: 'Портал', url: 'https://drafts.example.uz', listing_url: 'https://drafts.example.uz/list', language: 'ru', reason: '', checkNote: '', listingOk: true, verified: true };
  const ap: ActProposalDto = { act_type: 'banking_law', act_type_ru: '', title_original: 'Banklar to‘g‘risida', number: 'O‘RQ-580', url: 'https://lex.uz/docs/4581969', last_edition_date: 'unknown', quote: '', reason: '', checkNote: '', verified: true };
  const discover = async (o: DiscoverOptions): Promise<DiscoverResult> => ({
    ok: true,
    message: 'Подтверждено 1 из 1',
    sourceProposals: o.mode === 'missing' ? [sp] : [],
    actProposals: o.mode === 'watched' ? [ap] : [],
    rejected: [],
    proposed: { sources: 1, acts: 1 },
    costUsd: 0,
    dir: '',
  });
  const t = setup({ discover });
  // до поиска — нечего принимать
  assert.equal(t.c.acceptAct('UZ', ap).errors['proposal'], STALE_PROPOSAL_MESSAGE);
  const w = await t.c.discover('UZ', 'watched');
  assert.ok(w.ok);
  assert.equal(w.actProposals.length, 1);
  assert.equal(t.c.status().running, false);
  // подделанное предложение не принимается
  assert.equal(t.c.acceptAct('UZ', { ...ap, url: 'https://evil.example' }).ok, false);
  const added = t.c.acceptAct('UZ', ap);
  assert.ok(added.ok);
  assert.equal(loadCountries(t.cdir).find((c) => c.code === 'UZ')!.watchedActs.length, 3);
  assert.equal(t.c.acceptAct('UZ', ap).ok, false, 'повторно то же — нет');
  await t.c.discover('UZ', 'missing');
  assert.ok(t.c.acceptSource('UZ', sp).ok);
  assert.equal(loadCountries(t.cdir).find((c) => c.code === 'UZ')!.sources.at(-1)!.url, 'https://drafts.example.uz/list');
  assert.equal((await t.c.discover('UZ', 'bad' as 'missing')).ok, false);
});
