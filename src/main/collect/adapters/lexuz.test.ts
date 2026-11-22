import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { FetchOptions, FetchResult, Fetcher } from '../fetcher-types.ts';
import {
  dedupeCandidates,
  dedupeDocs,
  editionCandidates,
  lexuzEditions,
  lexuzSearchNew,
  mergeRows,
  newEditionsSince,
  nextWatchedState,
  ondateUrl,
  parseActLine,
  parseDocPage,
  parseSearchPage,
  toCandidate,
  type LexuzDoc,
  type LexuzEdition,
  type LexuzSearchPage,
} from './lexuz.ts';

const FIX = join(import.meta.dirname, '..', 'fixtures');
const fx = (name: string): string => readFileSync(join(FIX, name), 'utf8');
const RU_SEARCH = 'https://lex.uz/ru/search/nat?lang=1&from=01.07.2026&to=17.11.2026';
const UZ_SEARCH = 'https://lex.uz/uz/search/nat?lang=4&from=01.07.2026&to=17.11.2026';

function page(html: string, url: string): LexuzSearchPage {
  const p = parseSearchPage(html, url);
  if ('error' in p) throw new Error(p.error);
  return p;
}

const ok = (url: string, body: string): FetchResult => ({ ok: true, status: 200, url, body, contentType: 'text/html; charset=utf-8' });

// ───────── Разбор реальных страниц (fixtures) ─────────

test('выдача ru, regnummj=1: 20 строк, «найдено 194», постбэк «Следующий», форма с __VIEWSTATE', () => {
  const p = page(fx('lexuz-search-ru-reg-p1.html'), RU_SEARCH + '&regnummj=1');
  assert.equal(p.found, 194);
  assert.equal(p.rows.length, 20);
  assert.equal(p.activePage, 1);
  assert.deepEqual(p.next, { target: 'ucFoundActsControl$LinkButton1', argument: '' });
  assert.ok(p.form);
  assert.ok(p.form.fields.__VIEWSTATE && p.form.fields.__VIEWSTATE.length > 100);
  assert.equal(p.form.action, RU_SEARCH + '&regnummj=1');
  for (const r of p.rows) {
    assert.ok(r.registrationNumber, r.line);
    assert.match(r.registrationDate ?? '', /^2026-\d{2}-\d{2}$/);
    assert.ok(r.docType && r.issuer, r.line);
  }
});

test('последняя страница: 14 строк, ссылки «Следующий» нет', () => {
  const p = page(fx('lexuz-search-ru-reg-p10.html'), RU_SEARCH);
  assert.equal(p.rows.length, 14);
  assert.equal(p.found, 194);
  assert.equal(p.activePage, 10);
  assert.equal(p.next, null);
});

test('пустая выдача: found 0, без ошибки', () => {
  const p = page(fx('lexuz-search-empty.html'), RU_SEARCH);
  assert.equal(p.found, 0);
  assert.equal(p.rows.length, 0);
});

test('не страница поиска → ошибка разбора', () => {
  const p = parseSearchPage('<html><body>Service Unavailable</body></html>', RU_SEARCH);
  assert.ok('error' in p);
});

test('3254-2 (actnum=24/2): рег. номер, дата рег., ЦБ; ru и uz склеиваются, оригинал = 8530799', () => {
  const ru = page(fx('lexuz-search-ru-actnum-24-2.html'), RU_SEARCH);
  const uz = page(fx('lexuz-search-uz-actnum-24-2.html'), UZ_SEARCH);
  assert.equal(ru.found, 1);
  const r = ru.rows[0]!;
  assert.equal(r.registrationNumber, '3254-2');
  assert.equal(r.registrationDate, '2026-10-09');
  assert.equal(r.docType, 'Постановление');
  assert.equal(r.issuer, 'Правления Центрального банка Республики Узбекистан');
  assert.equal(r.adoptionNumber, null, 'номера 24/2 в строке нет — не выдумываем');
  const { docs } = mergeRows(uz.rows, ru.rows);
  assert.equal(docs.length, 1);
  const d = docs[0]!;
  assert.equal(d.docId, '8530799');
  assert.equal(d.url, 'https://lex.uz/docs/8530799');
  assert.equal(d.urlRu, 'https://lex.uz/ru/docs/8538001');
  assert.match(d.title, /^О внесении изменений и дополнений в Положение о корпоративном управлении/);
  assert.match(d.titleUz ?? '', /^Tijorat banklarida korporativ boshqaruv/);
  assert.equal(d.registrationNumber, '3254-2');
  assert.equal(d.registrationDate, '2026-10-09');
  assert.match(d.issuer ?? '', /Центрального банка/);
});

test('строки без регистрации: ru «от … № ПП-397», uz «… yildagi PQ-397-son»; оригинал — положительный id', () => {
  const ru = page(fx('lexuz-search-ru-all-p1.html'), RU_SEARCH);
  const uz = page(fx('lexuz-search-uz-all-p1.html'), UZ_SEARCH);
  assert.equal(ru.found, 458);
  assert.equal(uz.found, 467);
  const pp = ru.rows.find((r) => r.adoptionNumber === 'ПП-397')!;
  assert.equal(pp.adoptionDate, '2026-11-16');
  assert.equal(pp.docType, 'Постановление');
  assert.equal(pp.issuer, 'Президента Республики Узбекистан');
  assert.equal(pp.registrationNumber, null);
  const pq = uz.rows.find((r) => r.adoptionNumber === 'PQ-397')!;
  assert.equal(pq.rawId, '-8594970');
  const { docs } = mergeRows(uz.rows, ru.rows);
  const d = docs.find((x) => x.adoptionNumber === 'PQ-397')!;
  assert.equal(d.docId, '8594970');
  assert.equal(d.url, 'https://lex.uz/docs/8594970');
  assert.equal(d.adoptionNumberRu, 'ПП-397');
  assert.equal(d.urlRu, `https://lex.uz/ru/docs/${pp.rawId}`);
});

test('parseActLine: ru, uz-латиница, uz-кириллица, нераспознанное', () => {
  assert.deepEqual(parseActLine('Закон Республики Узбекистан, от 12.11.2026 г. № ЗРУ-1188'), {
    docType: 'Закон', issuer: 'Республики Узбекистан', adoptionDate: '2026-11-12', adoptionNumber: 'ЗРУ-1188',
    registrationNumber: null, registrationDate: null,
  });
  const c = parseActLine('Ўзбекистон Республикаси Марказий банки бошқарувининг қарори, 16.11.2026 йилда рўйхатдан ўтган, рўйхат рақами 3976');
  assert.equal(c.registrationNumber, '3976');
  assert.equal(c.registrationDate, '2026-11-16');
  assert.equal(c.docType, 'қарори');
  const v = parseActLine('Ўзбекистон Республикаси Вазирлар Маҳкамасининг қарори, 12.11.2026 йилдаги 619-сон');
  assert.equal(v.adoptionNumber, '619');
  assert.equal(v.adoptionDate, '2026-11-12');
  const x = parseActLine('что-то непонятное');
  assert.equal(x.registrationNumber, null);
  assert.equal(x.adoptionDate, null);
});

// ───────── Страница документа (канал А) ─────────

test('редакции Положения 3254 (-4888804): 20.07.2026 действующая (3254-1), 13.01.2027 будущая', () => {
  const d = parseDocPage(fx('lexuz-edition-m4888804.html'), 'https://www.lex.uz/docs/-4888804', '2026-11-17');
  assert.ok(!('error' in d));
  assert.equal(d.headerNumber, '3254');
  assert.equal(d.headerDate, '2020-06-30');
  assert.match(d.title, /korporativ boshqaruv/);
  assert.equal(d.shownEdition, '2026-07-20');
  assert.deepEqual(
    d.editions.map((e) => [e.date, e.status]),
    [['2020-10-01', 'past'], ['2021-07-28', 'past'], ['2025-08-09', 'past'], ['2026-07-20', 'current'], ['2027-01-13', 'future']],
  );
  const cur = d.editions.find((e) => e.date === '2026-07-20')!;
  assert.equal(cur.url, 'https://www.lex.uz/docs/-4888804?ONDATE=20.07.2026');
  assert.equal(cur.amendingActs.length, 1);
  assert.deepEqual(
    { ...cur.amendingActs[0]!, note: undefined },
    {
      docId: '8338608', url: 'https://lex.uz/docs/8338608', note: undefined, registrationNumber: '3254-1',
      registrationDate: '2026-07-18', adoptionNumber: '19/8', adoptionDate: '2026-07-08', effectiveDate: null,
    },
  );
  // Изменяющий акт будущей редакции на странице по умолчанию не виден.
  assert.deepEqual(d.editions.at(-1)!.amendingActs, []);
  assert.ok(d.publications.some((p) => p.registrationNumber === '3254-2' && p.date === '2026-10-12'));
  assert.equal(d.languages.ru, 'https://www.lex.uz/docs/4888807');
  assert.equal(d.languages.uzLatn, 'https://www.lex.uz/docs/-4888804');
});

test('страница ?ONDATE=13.01.2027: изменяющий акт 3254-2 (пост. 24/2 от 17.09.2026, вступает 13.01.2027)', () => {
  const d = parseDocPage(fx('lexuz-edition-m4888804-ondate-20270113.html'), 'https://www.lex.uz/docs/-4888804?ONDATE=13.01.2027', '2026-11-17');
  assert.ok(!('error' in d));
  assert.equal(d.url, 'https://www.lex.uz/docs/-4888804');
  assert.equal(d.shownEdition, '2027-01-13');
  const fut = d.editions.find((e) => e.date === '2027-01-13')!;
  assert.equal(fut.status, 'future', 'статус — по дате today, а не по показанной редакции');
  const a = fut.amendingActs[0]!;
  assert.equal(a.docId, '8530799');
  assert.equal(a.registrationNumber, '3254-2');
  assert.equal(a.registrationDate, '2026-10-09');
  assert.equal(a.adoptionNumber, '24/2');
  assert.equal(a.adoptionDate, '2026-09-17');
  assert.equal(a.effectiveDate, '2027-01-13');
});

test('ondateUrl', () => {
  assert.equal(ondateUrl('https://www.lex.uz/docs/-4888804', '2027-01-13'), 'https://www.lex.uz/docs/-4888804?ONDATE=13.01.2027');
  assert.equal(
    ondateUrl('https://lex.uz/docs/-4888804?ONDATE=20.07.2026#-123', '2026-07-20'),
    'https://lex.uz/docs/-4888804?ONDATE=20.07.2026',
  );
  assert.throws(() => ondateUrl('https://lex.uz/docs/1', '13.01.2027'));
});

const ed = (date: string): LexuzEdition => ({ date, url: `u?${date}`, label: date, status: 'past', amendingActs: [] });

test('newEditionsSince: lastSeen, known (поправка раньше известной будущей), первая проверка', () => {
  const eds = ['2025-08-09', '2026-07-20', '2026-12-01', '2027-01-13'].map(ed);
  assert.deepEqual(newEditionsSince(eds, '2026-07-20').map((e) => e.date), ['2026-12-01', '2027-01-13']);
  // Ловушка: известна будущая 13.01.2027, новая поправка вступает 01.12.2026 — по lastSeen её не видно.
  assert.deepEqual(newEditionsSince(eds, '2027-01-13').map((e) => e.date), []);
  assert.deepEqual(
    newEditionsSince(eds, '2027-01-13', { known: ['2025-08-09', '2026-07-20', '2027-01-13'] }).map((e) => e.date),
    ['2026-12-01'],
  );
  assert.equal(newEditionsSince(eds, null).length, 4);
  assert.deepEqual(newEditionsSince(eds, null, { firstRunFrom: '2026-07-01' }).map((e) => e.date), ['2026-07-20', '2026-12-01', '2027-01-13']);
  const st = nextWatchedState({ url: 'u', lastSeenEdition: '2026-07-20', knownEditions: ['2026-07-20'] }, eds, new Date('2026-11-17T10:00:00Z'));
  assert.equal(st.lastSeenEdition, '2027-01-13');
  assert.deepEqual(st.knownEditions, ['2025-08-09', '2026-07-20', '2026-12-01', '2027-01-13']);
  assert.equal(st.checkedAt, '2026-11-17T10:00:00.000Z');
});

// ───────── Подменённый Fetcher ─────────

interface FakeCall {
  method: 'GET' | 'POST';
  url: string;
  fields?: Record<string, string>;
}

function fakeFetcher(handler: (c: FakeCall) => FetchResult): Fetcher & { calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  return {
    calls,
    async get(url: string, _o?: FetchOptions) {
      const c: FakeCall = { method: 'GET', url };
      calls.push(c);
      return handler(c);
    },
    async postForm(url: string, fields: Record<string, string>, _o?: FetchOptions) {
      const c: FakeCall = { method: 'POST', url, fields };
      calls.push(c);
      return handler(c);
    },
  };
}

interface SynthRow {
  id: string;
  title: string;
  line: string;
}

/** Синтетическая страница выдачи в вёрстке lex.uz (как в fixtures). */
function synthPage(rows: SynthRow[], found: number, pageNo: number, hasNext: boolean, lang: 'ru' | 'uz'): string {
  const tr = rows
    .map(
      (r, i) => `<tr class="dd-table__main-item"><td><span class="dd-table__main-item_number">${(pageNo - 1) * 20 + i + 1}</span></td><td>
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

/** Сайт с N строками на язык; postForm листает по __VIEWSTATE предыдущей страницы. */
function synthSite(opts: { uz: SynthRow[]; ru: SynthRow[]; foundUz?: number; brokenPaging?: boolean; ruDown?: boolean }) {
  return fakeFetcher((c) => {
    const lang = c.url.includes('/ru/') ? 'ru' : 'uz';
    if (lang === 'ru' && opts.ruDown) return { ok: false, kind: 'network', message: 'нет связи' };
    const all = lang === 'ru' ? opts.ru : opts.uz;
    const found = lang === 'uz' && opts.foundUz !== undefined ? opts.foundUz : all.length;
    let pageNo = 1;
    if (c.method === 'POST') {
      assert.equal(c.fields?.__EVENTTARGET, 'ucFoundActsControl$LinkButton1');
      assert.equal(c.fields?.__EVENTARGUMENT, '');
      const prev = Number(/vs-\w+-(\d+)/.exec(c.fields?.__VIEWSTATE ?? '')?.[1]);
      pageNo = opts.brokenPaging ? 1 : prev + 1;
    }
    const slice = all.slice((pageNo - 1) * 20, pageNo * 20);
    const pages = Math.ceil(all.length / 20);
    return ok(lang === 'ru' ? RU_SEARCH : UZ_SEARCH, synthPage(slice, found, pageNo, pageNo < pages, lang));
  });
}

const regRow = (i: number, lang: 'ru' | 'uz', date = '10.10.2026'): SynthRow => ({
  id: lang === 'uz' ? String(9000000 + i) : String(9500000 + i),
  title: `${lang} акт ${i}`,
  line:
    lang === 'ru'
      ? `Приказ министра юстиции Республики Узбекистан, зарегистрировано ${date} г., рег. номер ${4000 + i}`
      : `Oʻzbekiston Respublikasi adliya vazirining buyrugʻi, ${date} yilda ro‘yxatdan o‘tgan, ro‘yxat raqami ${4000 + i}`,
});

test('постраничный обход: 45 строк = 3 страницы на язык, всё собрано, POST с __VIEWSTATE предыдущей страницы', async () => {
  const uz = Array.from({ length: 45 }, (_, i) => regRow(i, 'uz'));
  const ru = Array.from({ length: 45 }, (_, i) => regRow(i, 'ru'));
  const f = synthSite({ uz, ru });
  const r = await lexuzSearchNew({ fetcher: f, window: { from: '2026-10-01', to: '2026-10-31' }, regOnly: true });
  assert.ok(r.ok, !r.ok ? r.reason : '');
  assert.equal(r.found, 45);
  assert.equal(r.foundRu, 45);
  assert.equal(r.docs.length, 45);
  assert.equal(r.requests, 6);
  assert.deepEqual(f.calls.map((c) => c.method), ['GET', 'POST', 'POST', 'GET', 'POST', 'POST']);
  assert.equal(f.calls[1]!.fields?.__VIEWSTATE, 'vs-uz-1');
  assert.equal(f.calls[2]!.fields?.__VIEWSTATE, 'vs-uz-2');
  assert.match(f.calls[0]!.url, /^https:\/\/lex\.uz\/uz\/search\/nat\?lang=4&from=02\.08\.2026&to=31\.10\.2026&regnummj=1$/);
  assert.ok(r.docs.every((d) => d.urlRu && d.titleRu && d.inWindow));
  assert.equal(r.docs[3]!.registrationNumber, '4003');
  assert.deepEqual(r.query, { from: '2026-08-02', to: '2026-10-31' });
});

test('несовпадение с «найдено N» → failed:parser «список обрезан»', async () => {
  const uz = Array.from({ length: 45 }, (_, i) => regRow(i, 'uz'));
  const f = synthSite({ uz, ru: [], foundUz: 50 });
  const r = await lexuzSearchNew({ fetcher: f, window: { from: '2026-10-01', to: '2026-10-31' }, regOnly: true, withRussian: false });
  assert.equal(r.ok, false);
  assert.ok(!r.ok);
  assert.equal(r.failure, 'parser');
  assert.match(r.reason, /список обрезан — собрано 45 из «найдено 50»/);
});

test('постбэк не листает (снова страница 1) → failed:parser, без зацикливания', async () => {
  const uz = Array.from({ length: 45 }, (_, i) => regRow(i, 'uz'));
  const f = synthSite({ uz, ru: [], brokenPaging: true });
  const r = await lexuzSearchNew({ fetcher: f, window: { from: '2026-10-01', to: '2026-10-31' }, regOnly: true, withRussian: false });
  assert.ok(!r.ok);
  assert.equal(r.failure, 'parser');
  assert.ok(f.calls.length <= 3);
});

test('сайт недоступен → failed:source; русская выдача недоступна → предупреждение, не провал', async () => {
  const down = fakeFetcher(() => ({ ok: false, kind: 'timeout', message: 'нет ответа за 60 с' }));
  const r = await lexuzSearchNew({ fetcher: down, window: { from: '2026-10-01', to: '2026-10-31' }, regOnly: true });
  assert.ok(!r.ok);
  assert.equal(r.failure, 'source');
  const uz = Array.from({ length: 3 }, (_, i) => regRow(i, 'uz'));
  const r2 = await lexuzSearchNew({ fetcher: synthSite({ uz, ru: [], ruDown: true }), window: { from: '2026-10-01', to: '2026-10-31' }, regOnly: true });
  assert.ok(r2.ok);
  assert.equal(r2.docs.length, 3);
  assert.equal(r2.foundRu, null);
  assert.equal(r2.docs[0]!.urlRu, null);
  assert.match(r2.warnings.join(' '), /Русская выдача/);
});

test('отбор по видимой дате: регистрация в окне; запас graceDays помечен inWindow=false; старее — отброшено', async () => {
  const uz = [regRow(1, 'uz', '10.10.2026'), regRow(2, 'uz', '27.09.2026'), regRow(3, 'uz', '01.09.2026')];
  const r = await lexuzSearchNew({ fetcher: synthSite({ uz, ru: [] }), window: { from: '2026-10-01', to: '2026-10-31' }, regOnly: true, withRussian: false });
  assert.ok(r.ok);
  assert.equal(r.found, 3);
  assert.deepEqual(r.docs.map((d) => [d.registrationNumber, d.inWindow]), [['4001', true], ['4002', false]]);
});

test('regOnly:false — только акты без регистрации (с регистрацией их даёт regOnly:true)', async () => {
  const uz: SynthRow[] = [
    regRow(1, 'uz'),
    { id: '-9100001', title: 'farmon', line: 'Oʻzbekiston Respublikasi Prezidentining Farmoni, 12.10.2026 yildagi PF-250-son' },
  ];
  const ru: SynthRow[] = [
    regRow(1, 'ru'),
    { id: '9100005', title: 'указ', line: 'Указ Президента Республики Узбекистан, от 12.10.2026 г. № УП-250' },
  ];
  const f = synthSite({ uz, ru });
  const r = await lexuzSearchNew({ fetcher: f, window: { from: '2026-10-01', to: '2026-10-31' }, regOnly: false });
  assert.ok(r.ok);
  assert.equal(r.docs.length, 1);
  const d = r.docs[0]!;
  assert.equal(d.docId, '9100001');
  assert.equal(d.adoptionNumber, 'PF-250');
  assert.equal(d.adoptionNumberRu, 'УП-250');
  assert.equal(d.title, 'указ');
  assert.doesNotMatch(f.calls[0]!.url, /regnummj/);
  assert.match(f.calls[0]!.url, /from=24\.09\.2026/);
});

test('lexuzSearchNew на реальных страницах (actnum=24/2) → 3254-2; toCandidate: id, ключ reg:, канал', async () => {
  const f = fakeFetcher((c) =>
    c.url.includes('/ru/') ? ok(c.url, fx('lexuz-search-ru-actnum-24-2.html')) : ok(c.url, fx('lexuz-search-uz-actnum-24-2.html')),
  );
  const r = await lexuzSearchNew({ fetcher: f, window: { from: '2026-07-01', to: '2026-11-17' }, regOnly: true });
  assert.ok(r.ok);
  assert.equal(r.docs.length, 1);
  const c = toCandidate(r.docs[0]!, 'B', 'UZ');
  assert.equal(c.id, 'lexuz-8530799');
  assert.equal(c.key, 'reg:3254-2');
  assert.equal(c.channel, 'B');
  assert.equal(c.url, 'https://lex.uz/docs/8530799');
  assert.equal(c.date, '2026-10-09');
  assert.equal(c.doc_type, 'Постановление');
  assert.match(c.title_original, /^Tijorat banklarida/);
  assert.match(c.snippet, /RU: О внесении изменений/);
});

test('toCandidate без регистрации: ключ num:<номер>|<дата>|<url>', () => {
  const d: LexuzDoc = {
    docId: '8594970', url: 'https://lex.uz/docs/8594970', urlRu: null, title: 't', titleRu: null, titleUz: 't',
    docType: 'qarori', issuer: 'x', adoptionDate: '2026-11-16', adoptionNumber: 'PQ-397', adoptionNumberRu: null,
    registrationNumber: null, registrationDate: null, snippet: 's', state: 'in_force', inWindow: true, originalKnown: true,
  };
  assert.equal(toCandidate(d, 'B').key, 'num:PQ-397|2026-11-16|https://lex.uz/docs/8594970');
});

test('дедупликация: docs по docId; кандидаты каналов А и Б по id', async () => {
  const a = { docId: '1', snippet: 'a' } as LexuzDoc;
  const b = { docId: '2', snippet: 'b' } as LexuzDoc;
  assert.deepEqual(dedupeDocs([a, b, { ...a, snippet: 'a2' }]).map((d) => d.snippet), ['a', 'b']);

  const f = fakeFetcher((c) =>
    c.url.includes('ONDATE=13.01.2027') ? ok(c.url, fx('lexuz-edition-m4888804-ondate-20270113.html')) : ok(c.url, fx('lexuz-edition-m4888804.html')),
  );
  const e = await lexuzEditions({ fetcher: f, docUrl: 'https://www.lex.uz/docs/-4888804', today: '2026-11-17' });
  assert.ok(e.ok);
  assert.equal(e.requests, 2, 'основная страница + страница будущей редакции');
  assert.deepEqual(f.calls.map((c) => c.url), ['https://www.lex.uz/docs/-4888804', 'https://www.lex.uz/docs/-4888804?ONDATE=13.01.2027']);
  const fut = e.editions.find((x) => x.date === '2027-01-13')!;
  assert.equal(fut.amendingActs[0]!.registrationNumber, '3254-2');
  assert.match(fut.label, /вступит в силу; изменения: рег\. 3254-2/);

  const newEds = newEditionsSince(e.editions, '2025-08-09');
  assert.deepEqual(newEds.map((x) => x.date), ['2026-07-20', '2027-01-13']);
  const fromA = newEds.flatMap((x) => editionCandidates(e, x));
  assert.deepEqual(fromA.map((c) => [c.id, c.key, c.channel]), [
    ['lexuz-8338608', 'reg:3254-1', 'A'],
    ['lexuz-8530799', 'reg:3254-2', 'A'],
  ]);
  const ru = page(fx('lexuz-search-ru-actnum-24-2.html'), RU_SEARCH);
  const uz = page(fx('lexuz-search-uz-actnum-24-2.html'), UZ_SEARCH);
  const fromB = mergeRows(uz.rows, ru.rows).docs.map((d) => toCandidate({ ...d, inWindow: true }, 'B'));
  const all = dedupeCandidates([...fromB, ...fromA]);
  assert.deepEqual(all.map((c) => [c.id, c.channel]), [['lexuz-8530799', 'B'], ['lexuz-8338608', 'A']]);
  assert.match(all[0]!.snippet, /Редакция: https:\/\/www\.lex\.uz\/docs\/-4888804\?ONDATE=13\.01\.2027/);
});

test('редакция без видимого изменяющего акта → кандидат на саму редакцию', () => {
  const c = editionCandidates({ url: 'https://www.lex.uz/docs/-4888804', title: 'Nizom' }, {
    date: '2025-08-09', url: 'https://www.lex.uz/docs/-4888804?ONDATE=09.08.2025', label: 'Редакция от 09.08.2025 (прежняя)', status: 'past', amendingActs: [],
  });
  assert.equal(c.length, 1);
  assert.equal(c[0]!.id, 'lexuz-4888804-ed-20250809');
  assert.equal(c[0]!.key, 'num:edition|2025-08-09|https://www.lex.uz/docs/-4888804?ONDATE=09.08.2025');
});

test('страница документа не распознана → failed:parser', async () => {
  const f = fakeFetcher((c) => ok(c.url, '<html><body>captcha</body></html>'));
  const r = await lexuzEditions({ fetcher: f, docUrl: 'https://lex.uz/docs/1' });
  assert.ok(!r.ok);
  assert.equal(r.failure, 'parser');
});
