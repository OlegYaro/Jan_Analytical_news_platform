import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Fetcher, FetchResult } from './fetcher-types.ts';
import { jsonPath, parseDate, profileHealthy, runProfile } from './profile.ts';
import type { HtmlListProfile, JsonApiProfile, RssProfile } from './profile.ts';

const fx = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

/** Подставной Fetcher: страницы из словаря url → тело. */
function fakeFetcher(pages: Record<string, string>, requested: string[] = []): Fetcher {
  const get = async (url: string): Promise<FetchResult> => {
    requested.push(url);
    const body = pages[url];
    if (body === undefined) return { ok: false, kind: 'http', status: 404, message: 'Сайт вернул ошибку 404' };
    return { ok: true, status: 200, url, body, contentType: 'text/html' };
  };
  return { get, postForm: async (u) => get(u) };
}

test('parseDate: форматы', () => {
  assert.equal(parseDate('16.11.2026'), '2026-11-16');
  assert.equal(parseDate('от 16.11.2026 г. № ПП-397'), '2026-11-16');
  assert.equal(parseDate('2026-11-16'), '2026-11-16');
  assert.equal(parseDate('2026-11-16T10:20:30+05:00'), '2026-11-16');
  assert.equal(parseDate('Mon, 16 Nov 2026 03:59:19 GMT'), '2026-11-16');
  assert.equal(parseDate('16 ноября 2026 года'), '2026-11-16');
  assert.equal(parseDate('9 oktabr 2026'), '2026-10-09');
  assert.equal(parseDate('2026 yil 9 oktabr'), '2026-10-09');
  assert.equal(parseDate('9 октябр 2026'), '2026-10-09');
  assert.equal(parseDate('March 5, 2026'), '2026-03-05');
  assert.equal(parseDate('5 March 2026'), '2026-03-05');
  assert.equal(parseDate('01/02/2026', 'MM/DD/YYYY'), '2026-01-02');
  assert.equal(parseDate('01/02/2026', 'DD/MM/YYYY'), '2026-02-01');
});

test('parseDate: мусор дает null; армянский и грузинский месяцы понимаются с фазы 6 (словарь checks/evidence.ts)', () => {
  assert.equal(parseDate(''), null);
  assert.equal(parseDate('вчера'), null);
  assert.equal(parseDate('31.02.2026'), null);
  assert.equal(parseDate('5 հոկտեմբերի 2026'), '2026-10-05');
  assert.equal(parseDate('5 ოქტომბერი 2026'), '2026-10-05');
});

test('jsonPath', () => {
  const o = { a: { b: [{ c: 'x' }, { c: 'y' }] } };
  assert.equal(jsonPath(o, 'a.b[1].c'), 'y');
  assert.equal(jsonPath(o, '$.a.b[0].c'), 'x');
  assert.equal(jsonPath(o, 'a.z.c'), undefined);
  assert.equal(jsonPath(o, 'a.b[9].c'), undefined);
  assert.equal(jsonPath(o, 'a.__proto__.x'), undefined);
});

test('RSS lex.uz (сохранённая страница)', async () => {
  const profile: RssProfile = { kind: 'rss', url: 'https://lex.uz/ru/rss' };
  const r = await runProfile(profile, fakeFetcher({ [profile.url]: fx('lexuz-rss.xml') }));
  assert.ok(r.ok);
  assert.ok(r.docs.length >= 20, `документов: ${r.docs.length}`);
  assert.ok(profileHealthy(r.docs));
  for (const d of r.docs) {
    assert.match(d.url, /^https:\/\/lex\.uz\/ru\/docs\/\d+$/);
    assert.match(d.date ?? '', /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(d.title.length > 5);
  }
  assert.equal(new Set(r.docs.map((d) => d.url)).size, r.docs.length);
  assert.equal(r.docs[0]?.url, 'https://lex.uz/ru/docs/8594980');
  assert.equal(r.docs[0]?.date, '2026-11-16');
});

const weekProfile: HtmlListProfile = {
  kind: 'html_list',
  url: 'https://lex.uz/ru/search/official?lang=1&pub_date=week',
  item: 'tr.dd-table__main-item',
  title: 'a.lx_link',
  link: 'a.lx_link[href]',
  date: '.badge',
  date_format: 'DD.MM.YYYY',
  issuer: '.badge',
};

test('html_list lex.uz official (сохранённая страница)', async () => {
  const r = await runProfile(weekProfile, fakeFetcher({ [weekProfile.url]: fx('lexuz-official-week.html') }));
  assert.ok(r.ok);
  assert.ok(r.docs.length >= 3, `документов: ${r.docs.length}`);
  assert.ok(profileHealthy(r.docs));
  const first = r.docs[0];
  assert.equal(first?.url, 'https://lex.uz/ru/docs/8594980');
  assert.equal(first?.date, '2026-11-16');
  assert.match(first?.title ?? '', /^О дополнительных мерах по подготовке к освобождению/);
  assert.match(first?.issuer ?? '', /Постановление Президента/);
  assert.ok(r.docs.every((d) => d.url.startsWith('https://lex.uz/')));
});

test('html_list: неверный селектор → понятная причина', async () => {
  const p = { ...weekProfile, item: 'div.nope' };
  const r = await runProfile(p, fakeFetcher({ [p.url]: fx('lexuz-official-week.html') }));
  assert.ok(!r.ok);
  assert.match(r.reason, /div\.nope/);
});

test('ошибка сети → ok:false с русским текстом', async () => {
  const r = await runProfile(weekProfile, fakeFetcher({}));
  assert.ok(!r.ok);
  assert.match(r.reason, /ошибку 404/);
});

test('пагинация и дедупликация (SYNTHETIC html)', async () => {
  const row = (n: number, d: string) =>
    `<li class="r"><a href="/doc/${n}">Документ ${n}</a><span class="d">${d}</span></li>`;
  const p: HtmlListProfile = {
    kind: 'html_list',
    url: 'https://example.test/list',
    item: 'li.r',
    title: 'a',
    link: 'a',
    date: '.d',
    pagination: { param: 'page', max_pages: 3 },
  };
  const asked: string[] = [];
  const f = fakeFetcher(
    {
      'https://example.test/list': row(1, '1 марта 2026') + row(2, '2 марта 2026'),
      'https://example.test/list?page=2': row(2, '2 марта 2026') + row(3, '3 марта 2026'),
      'https://example.test/list?page=3': row(2, '2 марта 2026'),
    },
    asked,
  );
  const r = await runProfile(p, f);
  assert.ok(r.ok);
  assert.deepEqual(
    r.docs.map((d) => d.url),
    ['https://example.test/doc/1', 'https://example.test/doc/2', 'https://example.test/doc/3'],
  );
  assert.equal(asked.length, 3);
  assert.ok(profileHealthy(r.docs));
  const r2 = await runProfile(p, fakeFetcher({ 'https://example.test/list': row(1, '1 марта 2026') }), { maxPages: 1 });
  assert.ok(r2.ok && !profileHealthy(r2.docs));
});

test('profileHealthy требует даты (SYNTHETIC)', () => {
  const d = (date: string | null) => ({ id: 'x', title: 't', date, url: 'u', issuer: '' });
  assert.equal(profileHealthy([d('2026-01-01'), d('2026-01-02'), d(null), d(null)]), false);
  assert.equal(profileHealthy([d('2026-01-01'), d('2026-01-02'), d('2026-01-03')]), true);
});

test('json_api (SYNTHETIC)', async () => {
  const p: JsonApiProfile = {
    kind: 'json_api',
    url: 'https://example.test/api',
    json_paths: { items: 'data.items', title: 'name', link: 'links[0].href', date: 'published' },
  };
  const body = JSON.stringify({
    data: { items: [{ name: 'A', links: [{ href: '/a' }], published: '2026-03-01' }, { name: 'B', links: [{ href: '/b' }], published: 1772323200 }] },
  });
  const r = await runProfile(p, fakeFetcher({ [p.url]: body }));
  assert.ok(r.ok);
  assert.deepEqual(r.docs.map((d) => [d.url, d.date]), [['https://example.test/a', '2026-03-01'], ['https://example.test/b', '2026-03-01']]);
});

test('Atom (SYNTHETIC)', async () => {
  const xml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><title type="html">Акт 1</title><link rel="alternate" href="/e/1"/><id>tag:1</id><updated>2026-05-04T10:00:00Z</updated><author><name>Минфин</name></author></entry></feed>`;
  const r = await runProfile({ kind: 'rss', url: 'https://example.test/atom' }, fakeFetcher({ 'https://example.test/atom': xml }));
  assert.ok(r.ok);
  assert.deepEqual(r.docs[0], { id: 'tag:1', title: 'Акт 1', date: '2026-05-04', url: 'https://example.test/e/1', issuer: 'Минфин' });
});

test('parseDate: даты на языках стран (kk, az, tk, ka, hy, mn) — словарь месяцев проверки цитат (фаза 6)', () => {
  assert.equal(parseDate('17 қараша 2026'), '2026-11-17');
  assert.equal(parseDate('17 noyabr 2026'), '2026-11-17');
  assert.equal(parseDate('2026.11.17'), '2026-11-17');
  assert.equal(parseDate('2026 оны 11 дүгээр сарын 17'), '2026-11-17');
  assert.equal(parseDate('без даты'), null);
});
