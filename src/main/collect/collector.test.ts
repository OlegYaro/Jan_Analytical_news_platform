import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { CollectOutput, Outcome } from '../../shared/pipeline-types.ts';
import type { RunMode } from '../../shared/run-types.ts';
import type { Country, Source, WatchedAct } from '../../shared/types.ts';
import { actDir } from '../archive.ts';
import { sourceHealthFile } from '../checks/anomaly.ts';
import { loadCountries } from '../countries/store.ts';
import { ledgerFile } from '../ledger.ts';
import {
  BROKEN_LIST_REASON,
  NO_DATE_NOTE,
  NO_METHOD_REASON,
  createCollector,
  ensureSnapshot,
  watchedStateFile,
  type CollectContext,
  type WatchedFile,
} from './collector.ts';
import type { FetchOptions, FetchResult, Fetcher } from './fetcher-types.ts';

const FIX = join(import.meta.dirname, 'fixtures');
const fx = (name: string): string => readFileSync(join(FIX, name), 'utf8');
const NOW = new Date(2026, 10, 18, 9, 0, 0); // 18.11.2026 09:00 местного времени
const WINDOW = { from: '2026-07-01', to: '2026-11-17' };
const WATCHED_URL = 'https://www.lex.uz/docs/-4888804';

// ───────── Подменный Fetcher ─────────

interface Call {
  method: 'GET' | 'POST';
  url: string;
  fields?: Record<string, string>;
}
type Route = (c: Call) => FetchResult | null;

const ok = (url: string, body: string, contentType = 'text/html; charset=utf-8'): FetchResult => ({ ok: true, status: 200, url, body, contentType });
const notFound: FetchResult = { ok: false, kind: 'http', status: 404, message: 'Сайт ответил ошибку 404 (страница не найдена)' };
const down: FetchResult = { ok: false, kind: 'network', message: 'Сайт не отвечает (нет связи)' };

function fakeFetcher(...routes: Route[]): Fetcher & { calls: Call[] } {
  const calls: Call[] = [];
  const handle = (c: Call): FetchResult => {
    calls.push(c);
    for (const r of routes) {
      const res = r(c);
      if (res) return res;
    }
    return notFound;
  };
  return {
    calls,
    async get(url: string, _o?: FetchOptions) {
      return handle({ method: 'GET', url });
    },
    async postForm(url: string, fields: Record<string, string>, _o?: FetchOptions) {
      return handle({ method: 'POST', url, fields });
    },
  };
}

/** Синтетическая страница выдачи lex.uz (вёрстка как в fixtures) — для постраничного обхода через postForm. */
function synthPage(rows: Array<{ id: string; title: string; line: string }>, found: number, pageNo: number, hasNext: boolean, lang: 'ru' | 'uz'): string {
  const tr = rows
    .map(
      (r) => `<tr class="dd-table__main-item"><td>
<span class="lx_act_state"><i class="fa fa-check-circle status_code_y"></i></span>
<div class="dd-table__main-left-desc"><a class="lx_link " href="/${lang}/docs/${r.id}" target="_blank">${r.title}</a></div>
<div class="dd-table__main-extra"><div><span class="badge badge-pill badge-nine">${r.line}</span></div></div></td></tr>`,
    )
    .join('\n');
  const head = lang === 'ru' ? `По запросу найдено ${found} документа(ов)` : `${found} hujjat topildi`;
  return `<html><body><form method="post" action="./nat?lang=1" id="Form1">
<input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="vs-${lang}-${pageNo}" />
<input type="hidden" name="__VIEWSTATEGENERATOR" value="4CEDEDF5" />
<div class="refind__result-export__title mb-3">${head}</div>
<table>${tr}</table>
<div class="pgn"><div class="item_pgn3"><table id="ucFoundActsControl_rptPaging"><tr><td><a class="aspNetDisabled btn">${pageNo}</a></td></tr></table></div>
<div class="item_pgn4">${hasNext ? `<a id="ucFoundActsControl_LinkButton1" href="javascript:__doPostBack(&#39;ucFoundActsControl$LinkButton1&#39;,&#39;&#39;)">Следующий</a>` : ''}</div></div>
</form></body></html>`;
}

/** Акты без регистрации (постановления Президента): 24 в окне + 1 «по запасу» (28.06 — до начала окна 01.07). */
function presidentialRows(lang: 'ru' | 'uz') {
  return Array.from({ length: 25 }, (_, i) => {
    const date = i === 24 ? '28.06.2026' : '10.10.2026';
    return {
      id: String(lang === 'uz' ? 7000000 + i : 7500000 + i),
      title: `${lang} постановление ${i}`,
      line:
        lang === 'ru'
          ? `Постановление Президента Республики Узбекистан, от ${date} г. № ПП-${600 + i}`
          : `Oʻzbekiston Respublikasi Prezidentining qarori, ${date} yildagi PQ-${600 + i}-son`,
    };
  });
}

/** lex.uz: поиск с регистрацией — сохранённая выдача 3254-2; без регистрации — 25 синтетических строк на 2 страницах. */
const lexuzSearch: Route = (c) => {
  if (!c.url.includes('/search/nat')) return null;
  const lang = c.url.includes('/ru/') ? 'ru' : 'uz';
  if (c.url.includes('regnummj=1')) return ok(c.url, fx(`lexuz-search-${lang}-actnum-24-2.html`));
  const all = presidentialRows(lang);
  const pageNo = c.method === 'POST' ? Number(/vs-\w+-(\d+)/.exec(c.fields?.__VIEWSTATE ?? '')?.[1]) + 1 : 1;
  return ok(c.url, synthPage(all.slice((pageNo - 1) * 20, pageNo * 20), all.length, pageNo, pageNo * 20 < all.length, lang));
};

const lexuzEmptySearch: Route = (c) => (c.url.includes('/search/nat') ? ok(c.url, fx('lexuz-search-empty.html')) : null);

/** Страницы документов lex.uz для канала А и снимков. */
const lexuzDocs: Route = (c) => {
  if (c.url === WATCHED_URL) return ok(c.url, fx('lexuz-edition-m4888804.html'));
  if (c.url === `${WATCHED_URL}?ONDATE=13.01.2027`) return ok(c.url, fx('lexuz-edition-m4888804-ondate-20270113.html'));
  if (c.url === `${WATCHED_URL}?ONDATE=20.07.2026`) return ok(c.url, fx('lexuz-edition-m4888804.html'));
  if (c.url === 'https://lex.uz/docs/8530799') return ok(c.url, fx('lexuz-doc-8530799.html'));
  if (c.url === 'https://lex.uz/docs/8338608') return ok(c.url, '<html><head><title>3254-1</title></head><body><div id="divCont"><p>19/8-son qaror, ro‘yxat raqami 3254-1</p></div></body></html>');
  return null;
};

// ───────── Страна, контекст ─────────

function src(id: string, type: Source['type'], url: string, extra: Partial<Source> = {}): Source {
  return {
    id,
    name: new URL(url).hostname,
    url,
    type,
    language: 'uz',
    priority: 'main',
    enabled: true,
    state: 'unchecked',
    stateReason: '',
    checkedAt: null,
    seenLatest: [],
    note: '',
    ...extra,
  };
}

const watched: WatchedAct = { id: 'act-3254', title: 'Положение 3254', registrationNumber: 'рег. 3254', url: WATCHED_URL, state: 'unchecked', stateReason: '' };

function country(sources: Source[], watchedActs: WatchedAct[] = [], active = true): Country {
  return { code: 'UZ', name: 'Узбекистан', languages: ['uz', 'ru'], active, sources, watchedActs, lastCheckedAt: null, lastRunSummary: '' };
}

function setup(c: Country, mode: RunMode = 'scheduled', window = WINDOW) {
  const ws = mkdtempSync(join(tmpdir(), 'rw-collect-'));
  const runId = '2026-11-18_0900';
  const countryDir = join(ws, 'runs', runId, c.code);
  mkdirSync(countryDir, { recursive: true });
  const ctx: CollectContext = { runId, workspaceDir: ws, countryDir, country: c, mode, window };
  return { ws, ctx };
}

function out(r: Outcome<CollectOutput>): CollectOutput {
  assert.ok(r.ok, !r.ok ? r.message : '');
  return r.output;
}

const htmlWeekProfile = {
  kind: 'html_list' as const,
  url: 'https://lex.uz/ru/search/official?lang=1&pub_date=week',
  item: 'tr.dd-table__main-item',
  title: 'a.lx_link',
  link: 'a.lx_link[href]',
  date: '.badge',
  date_format: 'DD.MM.YYYY',
  issuer: '.badge',
};
const weekPage: Route = (c) => (c.url === htmlWeekProfile.url ? ok(c.url, fx('lexuz-official-week.html')) : null);

// ───────── Тесты ─────────

test('lex.uz: канал Б (обе выдачи, постраничный POST) + канал А (новые редакции, снимок на диске)', async () => {
  const c = country([src('s-lex', 'legal_base', 'https://lex.uz')], [watched]);
  const { ws, ctx } = setup(c);
  const f = fakeFetcher(lexuzSearch, lexuzDocs);
  const o = out(await createCollector({ fetcher: f, workspaceDir: ws, now: () => NOW }).collect(ctx));

  // Постраничность через postForm (выдача без регистрации: 25 строк = 2 страницы на язык).
  assert.equal(f.calls.filter((x) => x.method === 'POST').length, 2);

  const ids = o.candidates.map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length, 'id уникальны');
  const a2 = o.candidates.find((x) => x.key === 'reg:3254-2');
  const a1 = o.candidates.find((x) => x.key === 'reg:3254-1');
  assert.ok(a2 && a1);
  assert.equal(a2.id, 'lexuz-8530799');
  assert.equal(a2.channel, 'A', 'канал А выигрывает у Б');
  assert.equal(a2.url, 'https://lex.uz/docs/8530799');
  assert.equal(a2.date, '2026-10-09');
  assert.match(a2.snippet, /Название: /, 'название из выдачи Б дописано');
  assert.ok(a2.issuer, 'орган дополнен из канала Б');
  assert.equal(a1.channel, 'A');
  assert.equal(a1.maybeUpdate, undefined);

  const b = o.candidates.filter((x) => x.channel === 'B');
  assert.equal(b.length, 25);
  assert.ok(b.every((x) => /^lexuz-\d+$/.test(x.id) && x.key.startsWith('num:')));
  const grace = b.filter((x) => x.snippet.startsWith('по запасу'));
  assert.equal(grace.length, 1);
  assert.equal(grace[0]!.date, '2026-06-28');

  // Снимок канала А сразу: акт + базовый акт + редакция на дату вступления.
  const dir = actDir(ws, ctx.runId, 'UZ', 'lexuz-8530799');
  assert.ok(existsSync(join(dir, 'snapshot.txt')));
  assert.ok(existsSync(join(dir, 'snapshot.html')));
  const text = readFileSync(join(dir, 'snapshot.txt'), 'utf8');
  assert.match(text, /3254/);
  assert.match(text, /24\/2/);
  const meta = JSON.parse(readFileSync(join(dir, 'snapshot.json'), 'utf8'));
  assert.deepEqual(meta.related.map((r: { url: string; ok: boolean }) => [r.url, r.ok]), [
    ['https://www.lex.uz/docs/-4888804', true],
    ['https://www.lex.uz/docs/-4888804?ONDATE=13.01.2027', true],
  ]);
  assert.ok(existsSync(join(actDir(ws, ctx.runId, 'UZ', 'lexuz-8338608'), 'snapshot.txt')));
  // Кандидатам канала Б снимок при сборе не берётся.
  assert.equal(existsSync(actDir(ws, ctx.runId, 'UZ', b[0]!.id)), false);

  // COV-05: число актов за окно (окно ≥ 7 дней), без «запаса».
  assert.deepEqual(o.sourceCounts, [{ sourceId: 's-lex', count: 25 }]);
  assert.deepEqual(o.sourceFailures, []);
  assert.deepEqual(o.anomalies, []);

  // Состояние канала А записано (scheduled), журнал — по-русски в log.jsonl.
  const st = JSON.parse(readFileSync(watchedStateFile(ws), 'utf8')) as WatchedFile;
  assert.equal(st[WATCHED_URL]?.lastSeenEdition, '2027-01-13');
  assert.deepEqual(Object.keys(st[WATCHED_URL]?.reported ?? {}).sort(), ['2026-07-20', '2027-01-13']);
  const log = readFileSync(join(ctx.countryDir, 'log.jsonl'), 'utf8');
  assert.match(log, /адаптер lex\.uz/);
  assert.match(log, /0 вызовов модели/);
  // Источник-история сборщиком не пишется (это делает оркестратор, только scheduled|manual).
  assert.equal(existsSync(sourceHealthFile(ws)), false);
});

test('канал А: после провала страны редакция показывается снова; после успешного прогона — нет', async () => {
  const c = country([], [watched]);
  const { ws, ctx } = setup(c);
  const col = createCollector({ fetcher: fakeFetcher(lexuzDocs), workspaceDir: ws, now: () => NOW });
  const first = out(await col.collect(ctx)).candidates.map((x) => x.id).sort();
  assert.deepEqual(first, ['lexuz-8338608', 'lexuz-8530799']);
  // Окно не сдвинулось (страна провалилась после сбора) — снова те же.
  const again = out(await col.collect(ctx)).candidates.map((x) => x.id).sort();
  assert.deepEqual(again, first);
  // Успешный прогон сдвинул начало окна — редакции уже не новые.
  const later = out(await col.collect({ ...ctx, window: { from: '2026-11-19', to: '2026-11-25' } })).candidates;
  assert.deepEqual(later, []);
});

test('канал А: maybeUpdate по журналу (новая дата вступления), отправленный без новой стадии — без снимка', async () => {
  const c = country([], [watched]);
  const { ws, ctx } = setup(c);
  mkdirSync(join(ws, 'state', 'ledger'), { recursive: true });
  writeFileSync(
    ledgerFile(ws, 'UZ'),
    JSON.stringify([
      { key: 'reg:3254-2', first_reported_at: '2026-10-20T08:00:00Z', last_stage: 'published', effective_date: 'unknown', title_en: 'x', run_id: 'r0' },
      { key: 'reg:3254-1', first_reported_at: '2026-07-27T08:00:00Z', last_stage: 'in_force', effective_date: '2026-07-20', title_en: 'y', run_id: 'r0' },
    ]),
  );
  const o = out(await createCollector({ fetcher: fakeFetcher(lexuzDocs), workspaceDir: ws, now: () => NOW }).collect(ctx));
  assert.equal(o.candidates.find((x) => x.key === 'reg:3254-2')?.maybeUpdate, true);
  assert.equal(o.candidates.find((x) => x.key === 'reg:3254-1')?.maybeUpdate, undefined);
  assert.ok(existsSync(join(actDir(ws, ctx.runId, 'UZ', 'lexuz-8530799'), 'snapshot.txt')));
  assert.equal(existsSync(join(actDir(ws, ctx.runId, 'UZ', 'lexuz-8338608'), 'snapshot.txt')), false);
});

test('ретро-прогон: строго по окну, состояние канала А не читается и не пишется', async () => {
  const c = country([src('s-lex', 'legal_base', 'https://lex.uz')], [watched]);
  const { ws, ctx } = setup(c, 'backfill');
  const o = out(await createCollector({ fetcher: fakeFetcher(lexuzSearch, lexuzDocs), workspaceDir: ws, now: () => NOW }).collect(ctx));
  assert.equal(o.candidates.filter((x) => x.snippet.startsWith('по запасу')).length, 0);
  assert.ok(o.candidates.some((x) => x.key === 'reg:3254-2' && x.channel === 'A'));
  assert.ok(o.candidates.some((x) => x.key === 'reg:3254-1'));
  assert.equal(existsSync(watchedStateFile(ws)), false);
});

test('источник без адаптера и без профиля → пропуск с причиной (не «нет изменений»); при работающем lex.uz не критичен', async () => {
  const c = country([src('s-lex', 'legal_base', 'https://lex.uz'), src('s-cbu', 'regulator', 'https://cbu.uz')]);
  const { ws, ctx } = setup(c);
  const f = fakeFetcher(lexuzEmptySearch);
  const o = out(await createCollector({ fetcher: f, workspaceDir: ws, now: () => NOW }).collect(ctx));
  assert.deepEqual(o.sourceFailures, [{ sourceId: 's-cbu', message: `«cbu.uz»: ${NO_METHOD_REASON}`, critical: false }]);
  assert.ok(f.calls.every((x) => !x.url.includes('cbu.uz')), 'к источнику без способа чтения не ходим');
  assert.match(readFileSync(join(ctx.countryDir, 'log.jsonl'), 'utf8'), /нет способа чтения/);
});

test('источник без способа чтения при прочитанном дубле того же типа → critical:false', async () => {
  const c = country([
    src('s-cbu', 'regulator', 'https://cbu.uz'),
    src('s-reg2', 'regulator', 'https://reg.example.uz', { profile: htmlWeekProfile }),
  ]);
  const { ws, ctx } = setup(c);
  const o = out(await createCollector({ fetcher: fakeFetcher(weekPage), workspaceDir: ws, now: () => NOW }).collect(ctx));
  assert.deepEqual(o.sourceFailures, [{ sourceId: 's-cbu', message: `«cbu.uz»: ${NO_METHOD_REASON}`, critical: false }]);
});

test('единственный источник недоступен → critical; дублирующий того же типа → critical:false', async () => {
  const lexDown: Route = (x) => (x.url.includes('/search/nat') ? down : null);
  {
    const { ws, ctx } = setup(country([src('s-lex', 'legal_base', 'https://lex.uz')]));
    const o = out(await createCollector({ fetcher: fakeFetcher(lexDown), workspaceDir: ws, now: () => NOW }).collect(ctx));
    assert.equal(o.sourceFailures?.length, 1);
    assert.equal(o.sourceFailures![0]!.critical, true);
    assert.match(o.sourceFailures![0]!.message, /lex\.uz не ответил/);
    assert.deepEqual(o.sourceCounts, [], 'недоступный источник не даёт точку истории');
  }
  {
    const c = country([src('s-lex', 'legal_base', 'https://lex.uz'), src('s-lb2', 'legal_base', 'https://lb.example.uz', { profile: htmlWeekProfile })]);
    const { ws, ctx } = setup(c);
    const o = out(await createCollector({ fetcher: fakeFetcher(lexDown, weekPage), workspaceDir: ws, now: () => NOW }).collect(ctx));
    assert.deepEqual(o.sourceFailures?.map((x) => [x.sourceId, x.critical]), [['s-lex', false]]);
  }
});

test('профиль html_list на сохранённой странице: кандидаты строго по окну, ключ и id стабильны', async () => {
  const c = country([src('s-reg', 'regulator', 'https://reg.example.uz', { profile: htmlWeekProfile })]);
  const { ws, ctx } = setup(c, 'manual', { from: '2026-11-16', to: '2026-11-17' });
  const o = out(await createCollector({ fetcher: fakeFetcher(weekPage), workspaceDir: ws, now: () => NOW }).collect(ctx));
  assert.ok(o.candidates.length >= 1);
  assert.ok(o.candidates.every((x) => x.channel === 'B' && x.date >= '2026-11-16' && x.date <= '2026-11-17'));
  const first = o.candidates.find((x) => x.url === 'https://lex.uz/ru/docs/8594980');
  assert.ok(first);
  assert.equal(first.key, 'num:|2026-11-16|https://lex.uz/ru/docs/8594980');
  assert.match(first.id, /^lex\.uz-[0-9a-f]{12}$/);
  assert.match(first.snippet, /^reg\.example\.uz: О дополнительных мерах/);
  assert.deepEqual(o.sourceCounts, [{ sourceId: 's-reg', count: 3 }]);
  // Окно позже дат списка: кандидатов нет, но число документов — весь список источника (для COV-05).
  const later = out(await createCollector({ fetcher: fakeFetcher(weekPage), workspaceDir: ws, now: () => NOW }).collect({ ...ctx, window: { from: '2026-11-17', to: '2026-11-17' } }));
  assert.deepEqual(later.candidates, []);
  assert.deepEqual(later.sourceCounts, [{ sourceId: 's-reg', count: 3 }]);
  assert.deepEqual(later.sourceFailures, []);
});

test('профиль rss (fixtures/lexuz-rss.xml), канал В для проектов; документ без даты — дата окна и пометка', async () => {
  const rss = fx('lexuz-rss.xml');
  const undated = rss.replace(/<pubDate>Mon, 16 Nov 2026 03:59:19 GMT<\/pubDate>/, '');
  const feed: Route = (x) => (x.url === 'https://drafts.example.uz/rss' ? ok('https://lex.uz/rss', undated, 'application/rss+xml') : null);
  const c = country([src('s-dr', 'drafts', 'https://drafts.example.uz', { profile: { kind: 'rss', url: 'https://drafts.example.uz/rss' } })]);
  const { ws, ctx } = setup(c, 'manual', { from: '2026-11-10', to: '2026-11-17' });
  const o = out(await createCollector({ fetcher: fakeFetcher(feed), workspaceDir: ws, now: () => NOW }).collect(ctx));
  assert.ok(o.candidates.length >= 2);
  assert.ok(o.candidates.every((x) => x.channel === 'C'));
  const nd = o.candidates.find((x) => x.url === 'https://lex.uz/ru/docs/8594980');
  assert.ok(nd);
  assert.equal(nd.date, '2026-11-17');
  assert.ok(nd.snippet.startsWith(NO_DATE_NOTE));
  assert.equal(nd.key, 'num:||https://lex.uz/ru/docs/8594980', 'ключ без даты окна — журнал узнает документ');
});

test('аномалия: история с медианой > 0, сейчас 0 актов за окно ≥ 7 дней', async () => {
  const c = country([src('s-lex', 'legal_base', 'https://lex.uz')]);
  const { ws, ctx } = setup(c, 'scheduled', { from: '2026-11-04', to: '2026-11-17' });
  mkdirSync(join(ws, 'state'), { recursive: true });
  const hist = ['2026-10-14', '2026-10-21', '2026-10-28', '2026-11-04'].map((d) => ({ date: `${d}T08:00:00.000Z`, count: 30 }));
  writeFileSync(sourceHealthFile(ws), JSON.stringify({ 's-lex': hist }));
  const o = out(await createCollector({ fetcher: fakeFetcher(lexuzEmptySearch), workspaceDir: ws, now: () => NOW }).collect(ctx));
  assert.deepEqual(o.sourceCounts, [{ sourceId: 's-lex', count: 0 }]);
  assert.equal(o.anomalies?.length, 1);
  assert.equal(o.anomalies![0]!.sourceId, 's-lex');
  assert.equal(o.anomalies![0]!.median, 30);
  assert.deepEqual(o.sourceFailures, []);
});

test('окно короче 7 дней: число актов lex.uz в историю не идёт (нет ложной аномалии)', async () => {
  const c = country([src('s-lex', 'legal_base', 'https://lex.uz')]);
  const { ws, ctx } = setup(c, 'scheduled', { from: '2026-11-15', to: '2026-11-17' });
  mkdirSync(join(ws, 'state'), { recursive: true });
  const hist = ['2026-10-14', '2026-10-21', '2026-10-28', '2026-11-04'].map((d) => ({ date: `${d}T08:00:00.000Z`, count: 30 }));
  writeFileSync(sourceHealthFile(ws), JSON.stringify({ 's-lex': hist }));
  const o = out(await createCollector({ fetcher: fakeFetcher(lexuzEmptySearch), workspaceDir: ws, now: () => NOW }).collect(ctx));
  assert.deepEqual(o.sourceCounts, []);
  assert.deepEqual(o.anomalies, []);
});

test('dry_run: не пишет watched.json и source-health.json, ⚠ не ставит', async () => {
  const settingsDir = mkdtempSync(join(tmpdir(), 'rw-settings-'));
  const seeded = loadCountries(settingsDir).find((x) => x.code === 'UZ')!;
  const broken = { ...htmlWeekProfile, item: 'div.nope' };
  const c = { ...seeded, sources: [{ ...seeded.sources[1]!, profile: broken }], watchedActs: [watched] };
  const { ws, ctx } = setup(c, 'dry_run');
  const o = out(await createCollector({ fetcher: fakeFetcher(lexuzDocs, weekPage, (x) => (x.url === broken.url ? ok(x.url, fx('lexuz-official-week.html')) : null)), workspaceDir: ws, now: () => NOW, countriesDir: settingsDir }).collect(ctx));
  assert.ok(o.candidates.some((x) => x.channel === 'A'), 'канал А в пробном режиме работает');
  assert.equal(existsSync(watchedStateFile(ws)), false);
  assert.equal(existsSync(sourceHealthFile(ws)), false);
  assert.equal(loadCountries(settingsDir).find((x) => x.code === 'UZ')!.sources[1]!.state, 'unchecked');
});

test('SRC-08: страница непустая, селектор ничего не находит → ⚠ в countries.json, повтор не меняет checkedAt', async () => {
  const settingsDir = mkdtempSync(join(tmpdir(), 'rw-settings-'));
  const seeded = loadCountries(settingsDir).find((x) => x.code === 'UZ')!;
  const cbu = seeded.sources.find((s) => s.id === 'seed-uz-2')!;
  const broken = { ...htmlWeekProfile, item: 'div.nope' };
  const c = { ...seeded, sources: [{ ...cbu, profile: broken }], watchedActs: [] };
  const { ws, ctx } = setup(c, 'scheduled');
  let t = new Date(2026, 10, 18, 9, 0);
  const col = createCollector({ fetcher: fakeFetcher(weekPage), workspaceDir: ws, now: () => t, countriesDir: settingsDir });
  const o = out(await col.collect(ctx));
  assert.equal(o.sourceFailures?.length, 1);
  assert.equal(o.sourceFailures![0]!.critical, true);
  assert.match(o.sourceFailures![0]!.message, /Список документов не разобран/);
  const s1 = loadCountries(settingsDir).find((x) => x.code === 'UZ')!.sources.find((s) => s.id === 'seed-uz-2')!;
  assert.equal(s1.state, 'warn');
  assert.equal(s1.stateReason, BROKEN_LIST_REASON);
  const checked = s1.checkedAt;
  t = new Date(2026, 10, 25, 9, 0);
  out(await col.collect(ctx));
  assert.equal(loadCountries(settingsDir).find((x) => x.code === 'UZ')!.sources.find((s) => s.id === 'seed-uz-2')!.checkedAt, checked);
});

test('сайт не ответил на профиль → недоступность, без ⚠', async () => {
  const settingsDir = mkdtempSync(join(tmpdir(), 'rw-settings-'));
  const seeded = loadCountries(settingsDir).find((x) => x.code === 'UZ')!;
  const c = { ...seeded, sources: [{ ...seeded.sources[1]!, profile: htmlWeekProfile }], watchedActs: [] };
  const { ws, ctx } = setup(c, 'scheduled');
  const o = out(await createCollector({ fetcher: fakeFetcher(() => down), workspaceDir: ws, now: () => NOW, countriesDir: settingsDir }).collect(ctx));
  assert.equal(o.sourceFailures?.length, 1);
  assert.doesNotMatch(o.sourceFailures![0]!.message, /не разобран/);
  assert.equal(loadCountries(settingsDir).find((x) => x.code === 'UZ')!.sources[1]!.state, 'unchecked');
});

test('выключенный источник, новости и выключенная страна не опрашиваются', async () => {
  const f = fakeFetcher(lexuzSearch, lexuzDocs, weekPage);
  {
    const c = country([
      src('s-lex', 'legal_base', 'https://lex.uz', { enabled: false }),
      src('s-news', 'news', 'https://www.gazeta.uz', { profile: { kind: 'rss', url: 'https://www.gazeta.uz/rss' } }),
    ]);
    const { ws, ctx } = setup(c);
    const o = out(await createCollector({ fetcher: f, workspaceDir: ws, now: () => NOW }).collect(ctx));
    assert.deepEqual(o.candidates, []);
    assert.deepEqual(o.sourceFailures, []);
  }
  {
    const c = country([src('s-lex', 'legal_base', 'https://lex.uz')], [watched], false);
    const { ws, ctx } = setup(c);
    const o = out(await createCollector({ fetcher: f, workspaceDir: ws, now: () => NOW }).collect(ctx));
    assert.deepEqual(o.candidates, []);
  }
  assert.equal(f.calls.length, 0);
});

test('ensureSnapshot идемпотентна: второй вызов не качает', async () => {
  const { ws, ctx } = setup(country([]));
  const f = fakeFetcher(lexuzDocs);
  const cand = { id: 'lexuz-8530799', url: 'https://lex.uz/docs/8530799' };
  const a = await ensureSnapshot({ candidate: cand, ctx, fetcher: f });
  assert.ok(a.ok && a.fresh);
  assert.equal(f.calls.length, 1);
  const b = await ensureSnapshot({ candidate: cand, ctx, fetcher: f });
  assert.ok(b.ok && !b.fresh);
  assert.equal(b.textPath, a.textPath);
  assert.equal(f.calls.length, 1);
  const bad = await ensureSnapshot({ candidate: { id: 'x/../y', url: 'https://nowhere.example/1' }, ctx, fetcher: f });
  assert.ok(!bad.ok);
  assert.ok(bad.dir.endsWith(join('acts', 'x_.._y')));
});

test('0 вызовов модели: сборщик не импортирует раннер claude и electron (только типы оркестратора)', () => {
  const code = readFileSync(join(import.meta.dirname, 'collector.ts'), 'utf8');
  const runtime = [...code.matchAll(/^import (?!type )[^;]*?from '([^']+)'/gms)].map((m) => m[1]);
  assert.ok(runtime.length > 0);
  for (const m of runtime) assert.doesNotMatch(m!, /runner|claude|electron/, m);
});

test('нечем читать ни один источник страны (все без способа чтения) → critical', async () => {
  const c = country([src('s-cbu', 'regulator', 'https://cbu.uz'), src('s-reg', 'drafts', 'https://regulation.gov.uz')]);
  const { ws, ctx } = setup(c);
  const o = out(await createCollector({ fetcher: fakeFetcher(weekPage), workspaceDir: ws, now: () => NOW }).collect(ctx));
  assert.equal(o.sourceFailures?.length, 2);
  assert.ok(o.sourceFailures?.every((x) => x.critical === true));
});
