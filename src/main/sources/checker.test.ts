// Проверка источников (фаза 6, T-10 на подменах): без сети и без claude. Сайты — fixtures lex.uz (реальные
// сохранённые страницы) и SYNTHETIC-страницы из ./fixtures (помечены в самих файлах).
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import type { SourcesCheck } from '../../shared/schema-types.ts';
import type { Country, Source, WatchedAct } from '../../shared/types.ts';
import type { LexuzDoc, LexuzSearchResult } from '../collect/adapters/lexuz.ts';
import type { FetchResult, Fetcher } from '../collect/fetcher-types.ts';
import { COUNTRIES_FILE, loadCountries } from '../countries/store.ts';
import type { RunStageOptions, StageResult } from '../runner/claude-runner.ts';
import { defaultSettings } from '../settings/defaults.ts';
import { checkDomains, checkSources, latestSeen, normActNumber, numberSeen, titleSeen } from './checker.ts';
import type { CheckSourcesOptions } from './checker.ts';
import { FORBIDDEN_UI_WORDS } from './reasons-ru.ts';

const SCHEMAS = resolve(import.meta.dirname, '..', '..', '..', 'schemas');
const LEX_FIX = resolve(import.meta.dirname, '..', 'collect', 'fixtures');
const FIX = resolve(import.meta.dirname, 'fixtures');
const lx = (n: string): string => readFileSync(join(LEX_FIX, n), 'utf8');
const fx = (n: string): string => readFileSync(join(FIX, n), 'utf8');
const NOW = new Date(2026, 10, 18, 10, 0, 0);

// ───────── окружение ─────────

function src(id: string, type: Source['type'], url: string, extra: Partial<Source> = {}): Source {
  return { id, name: new URL(url).hostname, url, type, language: 'ru', priority: 'main', enabled: true, state: 'unchecked', stateReason: '', checkedAt: null, seenLatest: [], note: '', ...extra };
}
function act(id: string, reg: string, url: string, title = 'Положение о корпоративном управлении в коммерческих банках'): WatchedAct {
  return { id, title, registrationNumber: reg, url, state: 'unchecked', stateReason: '' };
}
function country(code: string, sources: Source[], watchedActs: WatchedAct[] = []): Country {
  return { code, name: code === 'UZ' ? 'Узбекистан' : code === 'KZ' ? 'Казахстан' : 'Тестовая', languages: ['ru'], active: true, sources, watchedActs, lastCheckedAt: null, lastRunSummary: '' };
}

function env(countries: Country[]) {
  const root = mkdtempSync(join(tmpdir(), 'rw-src-'));
  const cdir = join(root, 'settings');
  const ws = join(root, 'ws');
  writeFileSync(join(mkdirp(cdir), COUNTRIES_FILE), JSON.stringify({ schemaVersion: 2, countries }, null, 2));
  mkdirp(ws);
  return { cdir, ws };
}
function mkdirp(d: string): string {
  mkdirSync(d, { recursive: true });
  return d;
}

type Route = (url: string) => FetchResult | null;
const ok = (url: string, body: string, contentType = 'text/html; charset=utf-8'): FetchResult => ({ ok: true, status: 200, url, body, contentType });
const down: FetchResult = { ok: false, kind: 'network', message: 'Нет соединения с сайтом (проверьте интернет и адрес источника)' };

function fakeFetcher(...routes: Route[]): Fetcher & { urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    async get(url: string) {
      urls.push(url);
      for (const r of routes) {
        const x = r(url);
        if (x) return x;
      }
      return { ok: false, kind: 'http', status: 404, message: 'Сайт вернул ошибку 404 (страница не найдена)' };
    },
    async postForm(url: string) {
      urls.push(`POST ${url}`);
      return { ok: false, kind: 'http', status: 404, message: 'Сайт вернул ошибку 404 (страница не найдена)' };
    },
  };
}

interface Call {
  input: Record<string, unknown>;
  opts: RunStageOptions;
}
/** Подмена runStage: читает input.json (как модель) и отвечает обработчиком. */
function fakeRunner(handler: (c: Call, n: number) => SourcesCheck | StageResult) {
  const calls: Call[] = [];
  const runStage = async (opts: RunStageOptions): Promise<StageResult> => {
    const inputPath = opts.invocation.prompt.split(' ').slice(1).join(' ');
    const c: Call = { input: JSON.parse(readFileSync(inputPath, 'utf8')) as Record<string, unknown>, opts };
    calls.push(c);
    const out = handler(c, calls.length);
    if ('durationMs' in out) return out;
    const v = opts.validate(out);
    assert.ok(v.ok, `ответ заглушки должен проходить схему: ${!v.ok ? v.error : ''}`);
    return { ok: true, output: out, usage: null, modelUsage: null, costUsd: 0.05, durationMs: 5, attempts: 1, exitCode: 0, numTurns: 4, denied: [] };
  };
  return { runStage, calls };
}

function opts(e: { cdir: string; ws: string }, code: string, fetcher: Fetcher, runStage: CheckSourcesOptions['runStage'], extra: Partial<CheckSourcesOptions> = {}): CheckSourcesOptions {
  return {
    country: code,
    fetcher,
    workspaceDir: e.ws,
    countriesDir: e.cdir,
    settings: { ...defaultSettings(e.ws), workspaceDir: e.ws },
    schemasDir: SCHEMAS,
    claudeBin: () => '/usr/bin/false',
    claudeEnv: () => ({}),
    ...(runStage ? { runStage } : {}),
    now: () => NOW,
    log: () => {},
    ...extra,
  };
}

function modelSource(id: string, over: Partial<SourcesCheck['sources'][number]> = {}): SourcesCheck['sources'][number] {
  return {
    id,
    reachable: true,
    login_or_captcha: false,
    final_url: 'https://nb.example.tj/ru/acts',
    official: true,
    official_reason: 'central bank domain',
    type_matches: true,
    has_dated_listing: true,
    needs_js: 'no',
    language: 'ru',
    profile: null,
    seen_latest: [],
    verdict: 'ok',
    reasons: [],
    ...over,
  };
}

const LIST_URL = 'https://nb.example.tj/ru/acts';
const listProfile = { kind: 'html_list' as const, url: LIST_URL, item: 'li.act', title: 'a.act__title', link: 'a.act__title[href]', date: '.act__date', date_format: 'DD.MM.YYYY' };
const listSite: Route = (u) => (u === LIST_URL || u === 'https://nb.example.tj' ? ok(u, fx('synthetic-acts-list.html')) : null);

function lexDocs(n: number): LexuzDoc[] {
  return Array.from({ length: n }, (_, i) => ({
    docId: String(8600000 + i),
    url: `https://lex.uz/docs/${8600000 + i}`,
    urlRu: null,
    title: `Акт ${i + 1}`,
    titleRu: null,
    titleUz: `Hujjat ${i + 1}`,
    docType: 'Qaror',
    issuer: 'Vazirlar Mahkamasi',
    adoptionDate: `2026-11-${String(5 + i).padStart(2, '0')}`,
    adoptionNumber: `${100 + i}`,
    adoptionNumberRu: null,
    registrationNumber: null,
    registrationDate: null,
    snippet: '',
    state: 'in_force',
    inWindow: true,
    originalKnown: true,
  }));
}

const noModel = fakeRunner(() => {
  throw new Error('модель не должна вызываться');
});

// ───────── lex.uz (адаптер, без модели) ─────────

test('T-10: lex.uz → ✅ (адаптер: ≥ 3 акта с датами), «что видно на сайте» — 5 последних из кода, модель не вызывается', async () => {
  const e = env([country('UZ', [src('lex', 'legal_base', 'https://lex.uz')])]);
  let asked: { from: string; to: string } | null = null;
  const r = await checkSources(
    opts(e, 'UZ', fakeFetcher((u) => (u === 'https://lex.uz' ? ok('https://lex.uz/uz/', '<html><body><p>Milliy baza</p></body></html>') : null)), noModel.runStage, {
      adapters: {
        lexuzSearchNew: async (o) => {
          asked = o.window;
          return { ok: true, docs: lexDocs(7), found: 7, foundRu: 7, query: o.window, requests: 2, warnings: [] } satisfies LexuzSearchResult;
        },
      },
    }),
  );
  assert.equal(noModel.calls.length, 0);
  assert.deepEqual(asked, { from: '2026-11-05', to: '2026-11-18' }, 'окно — 14 дней по сегодня');
  const s = r.sources[0]!;
  assert.equal(s.state, 'ok');
  assert.equal(s.method, 'adapter');
  assert.equal(s.extracted, 7);
  assert.equal(s.seenLatest.length, 5);
  assert.deepEqual(s.seenLatest.map((x) => x.date), ['2026-11-11', '2026-11-10', '2026-11-09', '2026-11-08', '2026-11-07']);
  const saved = loadCountries(e.cdir)[0]!.sources[0]!;
  assert.equal(saved.state, 'ok');
  assert.equal(saved.seenLatest.length, 5);
  assert.equal(saved.checkedAt, NOW.toISOString());
  assert.ok(!('profile' in saved) || saved.profile == null, 'lex.uz читается адаптером — профиль не нужен');
  assert.ok(existsSync(join(r.dir, 'lex', 'page-0.html')) && existsSync(join(r.dir, 'lex', 'page-0.txt')));
});

test('lex.uz: поиск не прочитан, лента (fixtures/lexuz-rss.xml) читается → ⚠, а не ✅; документы — из ленты', async () => {
  const e = env([country('UZ', [src('lex', 'legal_base', 'https://lex.uz')])]);
  const f = fakeFetcher(
    (u) => (u === 'https://lex.uz' ? ok(u, '<html><body>lex</body></html>') : null),
    (u) => (u === 'https://lex.uz/ru/rss' ? ok(u, lx('lexuz-rss.xml'), 'application/rss+xml') : null),
  );
  const r = await checkSources(
    opts(e, 'UZ', f, noModel.runStage, { adapters: { lexuzSearchNew: async () => ({ ok: false, failure: 'parser', reason: 'Поиск lex.uz, страница 1: вёрстка изменилась', requests: 1 }) } }),
  );
  const s = r.sources[0]!;
  assert.equal(s.state, 'warn');
  assert.match(s.reason, /ленте сайта/);
  assert.equal(s.seenLatest.length, 5);
  assert.equal(s.seenLatest[0]!.url, 'https://lex.uz/ru/docs/8594980');
});

// ───────── недоступен / вход ─────────

test('T-10: битый адрес → ❌ «Сайт не открывается: …» простыми словами, модель не вызывается', async () => {
  const e = env([country('KZ', [src('bad', 'legal_base', 'https://nonexistent.invalid')])]);
  const r = await checkSources(opts(e, 'KZ', fakeFetcher((u) => (u.includes('nonexistent') ? down : null)), noModel.runStage));
  const s = r.sources[0]!;
  assert.equal(s.state, 'fail');
  assert.match(s.reason, /^Сайт не открывается: нет соединения с сайтом\. Проверьте адрес источника$/);
  assert.doesNotMatch(s.reason, FORBIDDEN_UI_WORDS);
  assert.equal(noModel.calls.length, 0);
  const saved = loadCountries(e.cdir)[0]!.sources[0]!;
  assert.equal(saved.state, 'fail');
  assert.equal(saved.stateReason, s.reason);
  assert.deepEqual(saved.seenLatest, []);
});

test('ошибка 404 → ❌ с кодом и пояснением', async () => {
  const e = env([country('KZ', [src('bad', 'drafts', 'https://legal.example.kz/no-such-page')])]);
  const r = await checkSources(opts(e, 'KZ', fakeFetcher(), noModel.runStage));
  assert.equal(r.sources[0]!.state, 'fail');
  assert.match(r.sources[0]!.reason, /Сайт не открывается: сайт вернул ошибку 404 \(страница не найдена\)/);
});

test('страница с формой пароля (SYNTHETIC) → ❌ «требует входа», модель не вызывается', async () => {
  const e = env([country('KZ', [src('lg', 'regulator', 'https://portal.example.kz')])]);
  const r = await checkSources(opts(e, 'KZ', fakeFetcher((u) => ok('https://portal.example.kz/login', fx('synthetic-login.html'))), noModel.runStage));
  assert.equal(r.sources[0]!.state, 'fail');
  assert.match(r.sources[0]!.reason, /требует входа/);
  assert.equal(noModel.calls.length, 0);
});

// ───────── профиль: код прогоняет сам ─────────

test('HTML-список: профиль модели код подтверждает (≥ 3 с датами) → ✅, профиль сохранён; seenLatest — из кода, не из ответа модели', async () => {
  const e = env([country('TJ', [src('nb', 'regulator', 'https://nb.example.tj')])]);
  const fr = fakeRunner((c) => {
    const s = (c.input['sources'] as Array<Record<string, unknown>>)[0]!;
    const page = (s['pages'] as Array<Record<string, string>>)[0]!;
    // модель «читает» сохранённый файл: он есть, без скриптов, по строке на метку
    const html = readFileSync(page['html_path']!, 'utf8');
    assert.match(html, /class="act__date"/);
    assert.doesNotMatch(html, /<script/);
    assert.ok(existsSync(page['text_path']!));
    return {
      country: 'TJ',
      sources: [modelSource('nb', { profile: listProfile, seen_latest: [{ title: 'ВЫДУМАНО МОДЕЛЬЮ', date: '2030-01-01', url: 'https://nb.example.tj/fake' }] })],
      watched_acts: [],
    };
  });
  const r = await checkSources(opts(e, 'TJ', fakeFetcher(listSite), fr.runStage));
  assert.equal(fr.calls.length, 1);
  const inv = fr.calls[0]!.opts.invocation;
  assert.equal(inv.stage, 'srcCheck');
  assert.equal(inv.model, 'sonnet');
  assert.equal(inv.cwd, r.dir, 'cwd = папка проверки страны');
  assert.ok(r.dir.endsWith(join('state', 'source-checks', 'TJ')));
  assert.deepEqual(inv.domains, ['nb.example.tj', 'www.nb.example.tj'], 'WebFetch — только домены проверяемых источников');
  const s = r.sources[0]!;
  assert.equal(s.state, 'ok', s.reason);
  assert.equal(s.rounds, 1);
  assert.equal(s.extracted, 6);
  assert.deepEqual(s.seenLatest.map((x) => x.url), [105, 104, 103, 102, 101].map((n) => `https://nb.example.tj/ru/acts/${n}`));
  assert.ok(!s.seenLatest.some((x) => x.title.includes('ВЫДУМАНО')));
  const saved = loadCountries(e.cdir)[0]!.sources[0]!;
  assert.equal(saved.state, 'ok');
  assert.deepEqual(saved.profile, listProfile);
  assert.equal(saved.seenLatest[0]!.date, '2026-11-14');
  assert.equal(r.costUsd, 0.05);
});

test('профиль извлекает < 3 документов с датами → не ✅: 3 раунда, со 2-го — previous_attempt с сохранённой страницей; итог ⚠', async () => {
  const e = env([country('TJ', [src('nb', 'regulator', 'https://nb.example.tj')])]);
  const bad = { ...listProfile, date: '.no-such-date' };
  const fr = fakeRunner(() => ({ country: 'TJ', sources: [modelSource('nb', { profile: bad })], watched_acts: [] }));
  const r = await checkSources(opts(e, 'TJ', fakeFetcher(listSite), fr.runStage));
  assert.equal(fr.calls.length, 3);
  assert.equal((fr.calls[0]!.input['sources'] as Array<Record<string, unknown>>)[0]!['previous_attempt'], undefined);
  for (const n of [1, 2]) {
    const prev = (fr.calls[n]!.input['sources'] as Array<Record<string, unknown>>)[0]!['previous_attempt'] as Record<string, unknown>;
    assert.ok(prev, `раунд ${n + 1}: previous_attempt`);
    assert.equal(prev['extracted_count'], 6);
    assert.equal(prev['dated_count'], 0);
    assert.match(String(prev['problem']), /0 with a parsed date/);
    assert.deepEqual(prev['profile'], bad);
    assert.ok(existsSync(String(prev['html_path'])));
  }
  const s = r.sources[0]!;
  assert.equal(s.state, 'warn');
  assert.equal(s.rounds, 3);
  assert.match(s.reason, /не смогло надёжно прочитать список новых документов за 3 попытки/);
  assert.doesNotMatch(s.reason, FORBIDDEN_UI_WORDS);
  const saved = loadCountries(e.cdir)[0]!.sources[0]!;
  assert.equal(saved.state, 'warn');
  assert.ok(saved.profile == null, 'нерабочий профиль не сохраняется');
});

test('второй раунд исправляет профиль → ✅ (только неудачный источник идёт в следующий вызов)', async () => {
  const e = env([
    country('TJ', [src('nb', 'regulator', 'https://nb.example.tj'), src('nb2', 'legal_base', 'https://law.example.tj')]),
  ]);
  const law: Route = (u) => (u.startsWith('https://law.example.tj') ? ok(u, fx('synthetic-acts-list.html')) : null);
  const fr = fakeRunner((c, n) => {
    const ids = (c.input['sources'] as Array<{ id: string }>).map((s) => s.id);
    if (n === 1) {
      assert.deepEqual(ids, ['nb', 'nb2']);
      return {
        country: 'TJ',
        sources: [modelSource('nb', { profile: { ...listProfile, date: '.x' } }), modelSource('nb2', { profile: { ...listProfile, url: 'https://law.example.tj' } })],
        watched_acts: [],
      };
    }
    assert.deepEqual(ids, ['nb'], 'во втором раунде — только неудачный');
    return { country: 'TJ', sources: [modelSource('nb', { profile: listProfile })], watched_acts: [] };
  });
  const r = await checkSources(opts(e, 'TJ', fakeFetcher(listSite, law), fr.runStage));
  assert.equal(fr.calls.length, 2);
  assert.deepEqual(r.sources.map((s) => [s.sourceId, s.state, s.rounds]), [['nb', 'ok', 2], ['nb2', 'ok', 1]]);
});

test('модель просит страницу, которой нет среди файлов (item "?"): код скачивает её и отдаёт в следующем раунде → ✅', async () => {
  const e = env([country('TJ', [src('nb', 'regulator', 'https://nb.example.tj')])]);
  const home: Route = (u) => (u === 'https://nb.example.tj' ? ok(u, '<html><body><a href="/ru/acts">Акты</a></body></html>') : null);
  const fr = fakeRunner((c, n) => {
    const s = (c.input['sources'] as Array<Record<string, unknown>>)[0]!;
    if (n === 1) return { country: 'TJ', sources: [modelSource('nb', { profile: { kind: 'html_list', url: LIST_URL, item: '?' } })], watched_acts: [] };
    const prev = s['previous_attempt'] as Record<string, unknown>;
    assert.match(String(prev['problem']), /downloaded the page you asked for/);
    assert.match(readFileSync(String(prev['html_path']), 'utf8'), /act__date/);
    assert.equal((s['pages'] as unknown[]).length, 2, 'скачанная страница — в pages[]');
    return { country: 'TJ', sources: [modelSource('nb', { profile: listProfile })], watched_acts: [] };
  });
  const r = await checkSources(opts(e, 'TJ', fakeFetcher(home, listSite), fr.runStage));
  assert.equal(r.sources[0]!.state, 'ok');
  assert.equal(r.sources[0]!.rounds, 2);
});

test('неофициальный домен → ⚠ с причиной (не ❌), рабочий профиль сохраняется; тип не тот → ⚠', async () => {
  const e = env([country('TJ', [src('nb', 'regulator', 'https://nb.example.tj')])]);
  const fr = fakeRunner(() => ({
    country: 'TJ',
    sources: [modelSource('nb', { profile: listProfile, official: false, official_reason: 'private aggregator', type_matches: false, verdict: 'warn', reasons: ['not an official site'] })],
    watched_acts: [],
  }));
  const r = await checkSources(opts(e, 'TJ', fakeFetcher(listSite), fr.runStage));
  const s = r.sources[0]!;
  assert.equal(s.state, 'warn');
  assert.match(s.reason, /не официальный сайт/);
  assert.match(s.reason, /не соответствует выбранному типу/);
  assert.equal(loadCountries(e.cdir)[0]!.sources[0]!.profile?.url, LIST_URL);
});

test('новости: «не официальный» — не замечание (СМИ по определению) → ✅ при рабочем способе чтения', async () => {
  const e = env([country('TJ', [src('news', 'news', 'https://nb.example.tj')])]);
  const fr = fakeRunner(() => ({ country: 'TJ', sources: [modelSource('news', { profile: listProfile, official: false, reasons: ['news media, not official'] })], watched_acts: [] }));
  const r = await checkSources(opts(e, 'TJ', fakeFetcher(listSite), fr.runStage));
  assert.equal(r.sources[0]!.state, 'ok', r.sources[0]!.reason);
});

test('модель не нашла способа чтения (profile null, JavaScript) → ⚠ с русской причиной, без повторов', async () => {
  const e = env([country('TJ', [src('spa', 'drafts', 'https://spa.example.tj')])]);
  const fr = fakeRunner((c) => {
    const s = (c.input['sources'] as Array<Record<string, unknown>>)[0]!;
    assert.equal((s['observed_by_app'] as Record<string, unknown>)['little_visible_text_many_scripts'], true);
    return { country: 'TJ', sources: [modelSource('spa', { needs_js: 'yes', has_dated_listing: false, verdict: 'warn', reasons: ['list is rendered by JavaScript', 'some odd remark xyz'] })], watched_acts: [] };
  });
  const r = await checkSources(opts(e, 'TJ', fakeFetcher((u) => ok(u, fx('synthetic-spa.html'))), fr.runStage));
  assert.equal(fr.calls.length, 1);
  const s = r.sources[0]!;
  assert.equal(s.state, 'warn');
  assert.match(s.reason, /только в браузере \(с JavaScript\)/);
  assert.doesNotMatch(s.reason, /проверьте его вручную/, 'общая фраза — только когда конкретных причин нет');
  assert.doesNotMatch(s.reason, /не найден список/, '«нужен JavaScript» уже объясняет отсутствие списка');
  assert.doesNotMatch(s.reason, FORBIDDEN_UI_WORDS);
});

test('сохранённый рабочий профиль → ✅ без вызова модели', async () => {
  const e = env([country('TJ', [src('nb', 'regulator', 'https://nb.example.tj', { profile: listProfile, state: 'warn', stateReason: 'Список документов не разобран — перепроверьте источник' })])]);
  const r = await checkSources(opts(e, 'TJ', fakeFetcher(listSite), noModel.runStage));
  assert.equal(r.sources[0]!.state, 'ok');
  assert.equal(noModel.calls.length, 0);
});

test('лимит Claude → проверка прервана: источники без итога не меняются, понятное сообщение', async () => {
  const e = env([country('TJ', [src('nb', 'regulator', 'https://nb.example.tj'), src('bad', 'drafts', 'https://nonexistent.invalid')])]);
  const fr = fakeRunner(() => ({ ok: false, failure: 'limit', message: 'Исчерпан лимит подписки Claude', attempts: 1, durationMs: 1, exitCode: 1, denied: [] }));
  const r = await checkSources(opts(e, 'TJ', fakeFetcher(listSite, (u) => (u.includes('nonexistent') ? down : null)), fr.runStage));
  assert.ok(!r.ok);
  assert.equal(r.interrupted?.failure, 'limit');
  assert.match(r.message, /Проверка прервана: Исчерпан лимит/);
  const saved = loadCountries(e.cdir)[0]!.sources;
  assert.equal(saved.find((s) => s.id === 'nb')!.state, 'unchecked');
  assert.equal(saved.find((s) => s.id === 'bad')!.state, 'fail', 'то, что код выяснил сам, записано');
});

// ───────── NFR-05 ─────────

test('NFR-05: вход модели содержит только данные проверяемой страны', async () => {
  const e = env([
    country('UZ', [src('lex', 'legal_base', 'https://lex.uz'), src('cbu', 'regulator', 'https://cbu.uz')], [act('a1', 'рег. 3254', 'https://www.lex.uz/docs/-4888804')]),
    country('KZ', [src('adilet', 'legal_base', 'https://adilet.example.kz')]),
  ]);
  const fr = fakeRunner(() => ({ country: 'KZ', sources: [modelSource('adilet')], watched_acts: [] }));
  await checkSources(opts(e, 'KZ', fakeFetcher((u) => ok(u, fx('synthetic-acts-list.html'))), fr.runStage));
  const text = JSON.stringify(fr.calls[0]!.input);
  for (const bad of ['lex.uz', 'cbu.uz', '3254', 'Узбекистан', '"UZ"', 'source-checks/UZ']) assert.ok(!text.includes(bad), bad);
  assert.ok(text.includes('adilet.example.kz'));
  assert.ok(!fr.calls[0]!.opts.invocation.domains.some((d) => d.includes('lex.uz')));
});

// ───────── отслеживаемые акты (SRC-06) ─────────

const editionPage: Route = (u) => (u.startsWith('https://www.lex.uz/docs/-4888804') ? ok(u, lx('lexuz-edition-m4888804.html')) : null);

test('SRC-06: акт lex.uz с верным рег. номером → ✅ с историей редакций; неверный номер → ❌', async () => {
  const e = env([
    country('UZ', [], [act('good', 'рег. 3254', 'https://www.lex.uz/docs/-4888804'), act('wrong', '3999', 'https://www.lex.uz/docs/-4888804')]),
  ]);
  const r = await checkSources(opts(e, 'UZ', fakeFetcher(editionPage), noModel.runStage));
  assert.equal(noModel.calls.length, 0);
  const good = r.acts.find((a) => a.actId === 'good')!;
  const wrong = r.acts.find((a) => a.actId === 'wrong')!;
  assert.equal(good.state, 'ok', good.reason);
  assert.match(good.reason, /№ 3254; редакций: 5, действующая от 20\.07\.2026/);
  assert.equal(wrong.state, 'fail');
  assert.match(wrong.reason, /Номер не совпадает: в записи «3999», а по ссылке акт № 3254/);
  const saved = loadCountries(e.cdir)[0]!.watchedActs;
  assert.equal(saved.find((a) => a.id === 'wrong')!.state, 'fail');
  assert.equal(saved.find((a) => a.id === 'good')!.checkedAt, NOW.toISOString());
});

test('SRC-06: акт не на lex.uz → вердикт модели (страницу открыл и сохранил код); неверный → ❌', async () => {
  const e = env([country('KZ', [], [act('k1', '123-IV', 'https://adilet.example.kz/rus/docs/Z123', 'Закон о банках')])]);
  const fr = fakeRunner((c) => {
    const acts = c.input['watched_acts'] as Array<Record<string, unknown>>;
    assert.equal(acts.length, 1);
    assert.equal(acts[0]!['registration_number'], '123-IV');
    assert.ok(existsSync(String((acts[0]!['pages'] as Array<Record<string, string>>)[0]!['html_path'])));
    return { country: 'KZ', sources: [], watched_acts: [{ registration_number: '123-IV', verdict: 'fail', reason: 'the page shows a different act' }] };
  });
  const r = await checkSources(opts(e, 'KZ', fakeFetcher((u) => ok(u, '<html><body><h1>Закон о связи</h1></body></html>')), fr.runStage));
  assert.equal(r.acts[0]!.state, 'fail');
  assert.match(r.acts[0]!.reason, /Ссылка не ведёт на этот акт/);
});

// ───────── мелкие функции ─────────

test('помощники: номера, названия, домены, последние документы', () => {
  assert.equal(normActNumber('рег. 3254'), '3254');
  assert.equal(normActNumber('№ 3254-сон'), '3254');
  assert.equal(normActNumber('ЗРУ-370'), 'зру-370');
  assert.ok(numberSeen('3254', 'зарегистрировано 30.06.2020, рег. номер 3254'));
  assert.ok(!numberSeen('3254', 'рег. номер 3254-2'));
  assert.ok(!numberSeen('3254', 'номер 13254'));
  assert.ok(titleSeen('Закон «Об акционерных обществах и защите прав акционеров» (рус.)', 'ОБ АКЦИОНЕРНЫХ ОБЩЕСТВАХ И ЗАЩИТЕ ПРАВ АКЦИОНЕРОВ'));
  assert.ok(!titleSeen('Закон о банках и банковской деятельности', 'О валютном регулировании'));
  assert.deepEqual(checkDomains(['https://www.cbu.uz/ru/', 'https://cbu.uz', 'bad url']), ['www.cbu.uz', 'cbu.uz']);
  assert.deepEqual(
    latestSeen([
      { id: '1', title: 'a', date: null, url: 'u1', issuer: '' },
      { id: '2', title: 'b', date: '2026-01-02', url: 'u2', issuer: '' },
      { id: '3', title: 'c', date: '2026-03-01', url: 'u3', issuer: '' },
    ]).map((x) => x.url),
    ['u3', 'u2', 'u1'],
  );
});
