import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Fetcher, FetchResult } from './fetcher-types.ts';
import { htmlToText, takeSnapshot } from './snapshot.ts';

const fx = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('htmlToText: страница документа lex.uz (сохранённая)', () => {
  const text = htmlToText(fx('lexuz-doc-8530799.html'));
  const lines = text.split('\n');
  // заголовок страницы первой строкой
  assert.match(lines[0] ?? '', /^3254-2-сон 09\.10\.2026\. Tijorat banklarida korporativ boshqaruv toʻgʻrisidagi nizomga/);
  // заголовок акта
  assert.ok(text.includes('Tijorat banklarida korporativ boshqaruv toʻgʻrisidagi nizomga oʻzgartirish va qoʻshimchalar kiritish haqida'));
  assert.ok(text.includes('24/2-son'));
  // служебного мусора нет
  for (const junk of ['gtag', 'googletagmanager', 'Telegram', 'Facebook', 'Ҳужжатга таклиф юбориш', 'Аудиони тинглаш', 'Улашиш', 'function(', 'display:none', '<div']) {
    assert.ok(!text.includes(junk), `мусор в тексте: ${junk}`);
  }
  // номера пунктов в начале строк, по одному пункту на строку
  assert.ok(lines.some((l) => /^1\. Oʻzbekiston Respublikasi Markaziy banki boshqaruvining 2020-yil/.test(l)));
  assert.ok(lines.includes('2. Mazkur qaror rasmiy eʼlon qilingan kundan eʼtiboran uch oydan keyin kuchga kiradi.'));
  assert.ok(lines.some((l) => /^10\. 53-bandda:$/.test(l)));
  // оригинальные символы без нормализации
  assert.ok(text.includes('toʻgʻrisidagi')); // ʻ U+02BB
  assert.ok(text.includes('maʼlumotlari')); // ʼ U+02BC
  assert.ok(text.includes('ro‘yxatdan o‘tgan')); // ‘ U+2018
  assert.ok(text.includes('“bankning ichki hujjatlarida')); // “ ” сохранены
  assert.ok(text.includes('Кучга кириш санаси'));
  assert.ok(!/ {2,}/.test(text));
  assert.ok(text.endsWith('\n'));
});

test('htmlToText: SYNTHETIC — структура, символы, мусор', () => {
  const html = `<html><head><title>Қарор  № 5</title><script>var x=1</script></head><body>
    <header>Шапка сайта</header><nav><a href="/">Меню</a></nav>
    <div class="menu">Пункт меню</div>
    <div id="mD"><p>Ўзбекистон   Республикаси қонуни ҳақида «Ғалаба»</p>
      <p>50¹. Банк <b>ҳақли</b>
      эмас</p>
      <ul><li>16. Первый пункт</li><li>17. Второй</li></ul>
      <table><tr><th>№</th><th>Название</th></tr><tr><td>1</td><td>Акт <i>А</i></td></tr></table>
      Строка<br>после br
      <form action="/x"><input name="q"><label>Поиск</label></form>
    </div><footer>Подвал</footer><div style="display:none">скрыто</div></body></html>`;
  const lines = htmlToText(html).split('\n').filter(Boolean);
  assert.deepEqual(lines, [
    'Қарор № 5',
    'Ўзбекистон Республикаси қонуни ҳақида «Ғалаба»',
    '50¹. Банк ҳақли эмас',
    '16. Первый пункт',
    '17. Второй',
    '№ | Название',
    '1 | Акт А',
    'Строка',
    'после br',
  ]);
});

test('htmlToText: SYNTHETIC — форма-обёртка всей страницы не вырезается', () => {
  const html = '<html><head><title>T</title></head><body><form id="aspnetForm"><input type="hidden" name="v"><div>Текст акта</div></form></body></html>';
  assert.deepEqual(htmlToText(html).split('\n').filter(Boolean), ['T', 'Текст акта']);
});

test('takeSnapshot: файлы, finalUrl, related, ошибка сети', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rw-snap-'));
  try {
    const pages: Record<string, string> = {
      'https://lex.uz/docs/8530799': fx('lexuz-doc-8530799.html'),
      'https://lex.uz/docs/rel': '<html><title>Приложение</title><body><p>1. Текст</p></body></html>',
    };
    const fetcher: Fetcher = {
      get: async (url): Promise<FetchResult> =>
        pages[url] === undefined
          ? { ok: false, kind: 'http', status: 404, message: 'Сайт вернул ошибку 404' }
          : { ok: true, status: 200, url: url + '?final', body: pages[url], contentType: 'text/html' },
      postForm: async () => ({ ok: false, kind: 'network', message: 'n/a' }),
    };
    const r = await takeSnapshot({
      fetcher,
      url: 'https://lex.uz/docs/8530799',
      dir,
      relatedSnapshots: [
        { label: 'Приложение', url: 'https://lex.uz/docs/rel' },
        { label: 'Битая', url: 'https://lex.uz/docs/missing' },
      ],
    });
    assert.ok(r.ok);
    assert.equal(r.htmlPath, join(dir, 'snapshot.html'));
    assert.equal(r.textPath, join(dir, 'snapshot.txt'));
    assert.equal(r.finalUrl, 'https://lex.uz/docs/8530799?final');
    assert.equal(readFileSync(r.htmlPath, 'utf8'), pages['https://lex.uz/docs/8530799']);
    assert.equal(r.bytes, Buffer.byteLength(fx('lexuz-doc-8530799.html'), 'utf8'));
    assert.match(readFileSync(r.textPath, 'utf8'), /^3254-2-сон/);
    assert.equal(r.related.length, 2);
    assert.ok(r.related[0]?.ok);
    assert.equal(readFileSync(join(dir, 'related', '1.txt'), 'utf8'), 'Приложение\n1. Текст\n');
    assert.ok(existsSync(join(dir, 'related', '1.html')));
    assert.ok(!r.related[1]?.ok);
    assert.ok(!existsSync(join(dir, 'related', '2.html')));

    const bad = await takeSnapshot({ fetcher, url: 'https://lex.uz/nope', dir: join(dir, 'x') });
    assert.ok(!bad.ok);
    assert.equal(bad.message, 'Сайт вернул ошибку 404');
    assert.ok(!existsSync(join(dir, 'x')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
