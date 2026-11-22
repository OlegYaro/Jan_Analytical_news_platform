// Поиск источников и основных законов (SRC-07, SRC-09) на подменах: без сети и без claude.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import type { DiscoverSources } from '../../shared/schema-types.ts';
import type { Country, Source, WatchedAct } from '../../shared/types.ts';
import type { FetchResult, Fetcher } from '../collect/fetcher-types.ts';
import { COUNTRIES_FILE, loadCountries } from '../countries/store.ts';
import type { RunStageOptions, StageResult } from '../runner/claude-runner.ts';
import { defaultSettings } from '../settings/defaults.ts';
import { WATCHED_ACT_TYPES, acceptActProposal, acceptSourceProposal, actTracked, discoverSources, missingTypes, sourceExists } from './discover.ts';
import type { DiscoverOptions } from './discover.ts';

const SCHEMAS = resolve(import.meta.dirname, '..', '..', '..', 'schemas');

function src(id: string, type: Source['type'], url: string, extra: Partial<Source> = {}): Source {
  return { id, name: new URL(url).hostname, url, type, language: 'uz', priority: 'main', enabled: true, state: 'ok', stateReason: '', checkedAt: null, seenLatest: [], note: '', ...extra };
}
const act = (id: string, reg: string, url: string): WatchedAct => ({ id, title: 'Положение', registrationNumber: reg, url, state: 'ok', stateReason: '' });

function uz(): Country {
  return {
    code: 'UZ',
    name: 'Узбекистан',
    languages: ['uz', 'ru'],
    active: true,
    sources: [src('lex', 'legal_base', 'https://lex.uz'), src('cbu', 'regulator', 'https://cbu.uz')],
    watchedActs: [act('a1', 'рег. 3254', 'https://www.lex.uz/docs/-4888804')],
    lastCheckedAt: null,
    lastRunSummary: '',
  };
}

function env(countries: Country[] = [uz()]) {
  const root = mkdtempSync(join(tmpdir(), 'rw-disc-'));
  const cdir = join(root, 's');
  const ws = join(root, 'ws');
  mkdirSync(cdir, { recursive: true });
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(cdir, COUNTRIES_FILE), JSON.stringify({ schemaVersion: 2, countries }));
  return { cdir, ws };
}

const ok = (url: string, body: string): FetchResult => ({ ok: true, status: 200, url, body, contentType: 'text/html' });
function fetcher(pages: Record<string, string>): Fetcher & { urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    async get(url) {
      urls.push(url);
      return pages[url] !== undefined ? ok(url, pages[url]!) : { ok: false, kind: 'network', message: 'Нет соединения с сайтом (проверьте интернет и адрес источника)' };
    },
    async postForm() {
      return { ok: false, kind: 'http', status: 404, message: 'нет' };
    },
  };
}

function runner(out: DiscoverSources) {
  const calls: Array<{ input: Record<string, unknown>; opts: RunStageOptions }> = [];
  const runStage = async (opts: RunStageOptions): Promise<StageResult> => {
    const p = opts.invocation.prompt.split(' ').slice(1).join(' ');
    calls.push({ input: JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>, opts });
    const v = opts.validate(out);
    assert.ok(v.ok, !v.ok ? v.error : '');
    return { ok: true, output: out, usage: null, modelUsage: null, costUsd: 0.2, durationMs: 1, attempts: 1, exitCode: 0, denied: [] };
  };
  return { runStage, calls };
}

function opts(e: { cdir: string; ws: string }, mode: DiscoverOptions['mode'], f: Fetcher, runStage: DiscoverOptions['runStage']): DiscoverOptions {
  return { mode, country: 'UZ', fetcher: f, workspaceDir: e.ws, countriesDir: e.cdir, settings: defaultSettings(e.ws), schemasDir: SCHEMAS, claudeBin: () => '/bin/false', claudeEnv: () => ({}), ...(runStage ? { runStage } : {}), log: () => {} };
}

const lawPage = '<html><body><h1>O‘zbekiston Respublikasining Qonuni</h1><h2>Banklar va bank faoliyati to‘g‘risida</h2><p>O‘RQ-580-son 05.11.2019</p></body></html>';

test('SRC-09 (watched): вход — 7 типов и уже отслеживаемые акты; код оставляет только подтверждённые предложения', async () => {
  const e = env();
  const out: DiscoverSources = {
    country: 'UZ',
    proposals: [],
    watched_act_proposals: [
      { act_type: 'banking_law', title_original: 'Banklar va bank faoliyati to‘g‘risida', number: 'O‘RQ-580', url: 'https://lex.uz/docs/4581969', last_edition_date: '2026-01-10', quote: 'Banklar va bank faoliyati to‘g‘risida', reason: 'main banking law' },
      { act_type: 'central_bank_law', title_original: 'Markaziy banki to‘g‘risida', number: 'O‘RQ-582', url: 'https://lex.uz/docs/9999999', last_edition_date: 'unknown', quote: 'Markaziy banki to‘g‘risida', reason: 'page did not open' },
      { act_type: 'aml_law', title_original: 'Jinoiy faoliyatdan olingan daromadlarni legallashtirishga qarshi kurashish to‘g‘risida', number: 'O‘RQ-660', url: 'https://lex.uz/docs/1111', last_edition_date: 'unknown', quote: 'legallashtirishga qarshi', reason: 'title not on page' },
      { act_type: 'cb_corporate_governance', title_original: 'Nizom', number: '3254', url: 'https://lex.uz/docs/4888804', last_edition_date: 'unknown', quote: 'Nizom', reason: 'already tracked' },
    ],
  };
  const r0 = runner(out);
  const f = fetcher({ 'https://lex.uz/docs/4581969': lawPage, 'https://lex.uz/docs/1111': '<html><body><p>Boshqa hujjat matni</p></body></html>' });
  const r = await discoverSources(opts(e, 'watched', f, r0.runStage));
  const input = r0.calls[0]!.input;
  assert.deepEqual(input['watched_act_types'], [...WATCHED_ACT_TYPES]);
  assert.equal((input['watched_acts'] as unknown[]).length, 1);
  assert.deepEqual(input['missing_types'], []);
  assert.equal(r0.calls[0]!.opts.invocation.stage, 'srcDiscover');
  assert.equal(r0.calls[0]!.opts.invocation.model, 'sonnet');
  assert.ok(r.ok);
  assert.deepEqual(r.proposed, { sources: 0, acts: 4 });
  assert.deepEqual(r.actProposals.map((a) => a.url), ['https://lex.uz/docs/4581969']);
  assert.equal(r.actProposals[0]!.verified, true);
  assert.equal(r.actProposals[0]!.act_type_ru, 'закон о банках и банковской деятельности');
  assert.match(r.actProposals[0]!.checkNote, /название/);
  const why = Object.fromEntries(r.rejected.map((x) => [x.url, x.reason]));
  assert.match(why['https://lex.uz/docs/9999999']!, /Сайт не открывается/);
  assert.match(why['https://lex.uz/docs/1111']!, /не найдены ни название, ни номер, ни цитата/);
  assert.match(why['https://lex.uz/docs/4888804']!, /уже отслеживается/);
  assert.ok(!f.urls.includes('https://lex.uz/docs/4888804'), 'отслеживаемое даже не открывается');
  assert.match(r.message, /Подтверждено 1 из 4/);
  // ничего не добавлено само (SRC-09)
  assert.equal(loadCountries(e.cdir)[0]!.watchedActs.length, 1);
});

test('SRC-07 (missing): ищутся только недостающие типы; неоткрывающийся и уже существующий — отброшены', async () => {
  const e = env();
  const out: DiscoverSources = {
    country: 'UZ',
    proposals: [
      { type: 'drafts', name: 'Regulation portal', url: 'https://regulation.gov.uz', listing_url: 'https://regulation.gov.uz/ru/documents', language: 'ru', reason: 'official drafts portal' },
      { type: 'news', name: 'Dead', url: 'https://dead.example.uz', listing_url: 'https://dead.example.uz/news', language: 'ru', reason: 'x' },
      { type: 'regulator', name: 'CBU press', url: 'https://cbu.uz/ru/press', listing_url: 'https://cbu.uz/ru/press', language: 'ru', reason: 'dup' },
    ],
    watched_act_proposals: [],
  };
  const r0 = runner(out);
  const f = fetcher({ 'https://regulation.gov.uz': '<html><body>Проекты</body></html>', 'https://regulation.gov.uz/ru/documents': '<html><body>Список</body></html>' });
  const r = await discoverSources(opts(e, 'missing', f, r0.runStage));
  assert.deepEqual(r0.calls[0]!.input['missing_types'], ['drafts', 'news']);
  assert.deepEqual(r.sourceProposals.map((p) => [p.url, p.listingOk]), [['https://regulation.gov.uz', true]]);
  assert.deepEqual(r.rejected.map((x) => x.url).sort(), ['https://cbu.uz/ru/press', 'https://dead.example.uz']);
  // «Добавить» → источник в состоянии «не проверен», адрес — страница списка
  const add = acceptSourceProposal(e.cdir, 'UZ', r.sourceProposals[0]!);
  assert.ok(add.ok, JSON.stringify(add.errors));
  const s = loadCountries(e.cdir)[0]!.sources.at(-1)!;
  assert.equal(s.url, 'https://regulation.gov.uz/ru/documents');
  assert.equal(s.type, 'drafts');
  assert.equal(s.state, 'unchecked');
  assert.equal(s.language, 'ru');
});

test('missing без недостающих типов — модель не вызывается; acceptActProposal добавляет акт', async () => {
  const e = env([{ ...uz(), sources: (['legal_base', 'regulator', 'drafts', 'news'] as const).map((t, i) => src(`s${i}`, t, `https://s${i}.example.uz`)) }]);
  const r0 = runner({ country: 'UZ', proposals: [], watched_act_proposals: [] });
  const r = await discoverSources(opts(e, 'missing', fetcher({}), r0.runStage));
  assert.equal(r0.calls.length, 0);
  assert.match(r.message, /всех типов/);
  const add = acceptActProposal(e.cdir, 'UZ', {
    act_type: 'banking_law',
    act_type_ru: 'закон о банках и банковской деятельности',
    title_original: 'Banklar va bank faoliyati to‘g‘risida',
    number: 'O‘RQ-580',
    url: 'https://lex.uz/docs/4581969',
    last_edition_date: 'unknown',
    quote: '',
    reason: '',
    checkNote: '',
    verified: true,
  });
  assert.ok(add.ok);
  const a = loadCountries(e.cdir)[0]!.watchedActs.at(-1)!;
  assert.equal(a.registrationNumber, 'O‘RQ-580');
  assert.equal(a.state, 'unchecked');
});

test('помощники: missingTypes, sourceExists, actTracked', () => {
  const c = uz();
  c.sources.push(src('dr', 'drafts', 'https://regulation.gov.uz', { state: 'fail' }));
  assert.deepEqual(missingTypes(c), ['drafts', 'news'], '❌ считается отсутствующим');
  assert.ok(sourceExists(c, 'https://www.cbu.uz/ru/press'));
  assert.ok(!sourceExists({ sources: [src('k', 'regulator', 'https://www.gov.kz/memleket/entities/ardfm')] }, 'https://www.gov.kz/memleket/entities/minfin'));
  assert.ok(actTracked(c, { url: 'https://lex.uz/docs/4888804', number: 'unknown' }), 'тот же документ lex.uz другой письменностью');
  assert.ok(actTracked(c, { url: 'https://other.example/x', number: '3254' }));
  assert.ok(!actTracked(c, { url: 'https://lex.uz/ru/docs/4888804', number: 'unknown' }), 'русский перевод — отдельный документ lex.uz');
});
