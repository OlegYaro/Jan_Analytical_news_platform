import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareNumbers, extractFacts } from './numbers.ts';

const EN = `# Uzbekistan — weekly digest

## 1. Central Bank Board resolution No. 24/2

⚠️ 1️⃣ New amendment found.

1. Adopted on 17 September 2026, registered on 2026-10-09 under No. 3254-2.
2. Published 12.10.2026; enters into force on January 13, 2027 (3 months after publication).
3) Amends the Regulation No. 3254 approved by resolution 12/8; previous amendment PP-397.

- Annex items: 10; legal-base marks: 14 (points 3 and 53 carry 3 marks each).
- New chapter 8¹ (points 50¹–50⁵).
- Total capital threshold: 1,000 billion soums; ratio 12.5%.

Source: [lex.uz](https://lex.uz/docs/8530799), current version https://www.lex.uz/docs/-4888804.
Version on effective date: lex.uz/docs/-4888804?ONDATE=13.01.2027
`;

const RU = `# Узбекистан — еженедельный дайджест

## 1. Постановление Правления ЦБ № 24/2

⚠️ 1️⃣ Найдено новое изменение.

1. Принято 17 сентября 2026 г., зарегистрировано 09.10.2026 под № 3254-2.
2. Опубликовано 12.10.2026; вступает в силу 13 января 2027 г. (через 3 месяца после опубликования).
3) Изменяет Положение № 3254, утверждённое постановлением 12/8; предыдущее изменение — ПП-397.

- Пунктов приложения: 10; отметок о правовой базе: 14 (в пунктах 3 и 53 — по 3 отметки).
- Новая глава 8¹ (пункты 50¹–50⁵).
- Порог совокупного капитала: 1 000 млрд сумов; норматив 12,5%.

Источник: [lex.uz](https://lex.uz/docs/8530799), действующая редакция https://www.lex.uz/docs/-4888804.
Редакция на дату вступления в силу: lex.uz/docs/-4888804?ONDATE=13.01.2027
`;

test('extractFacts: даты, номера, URL и числа разделены', () => {
  const f = extractFacts(EN);
  assert.deepEqual(f.dates.sort(), ['2026-09-17', '2026-10-09', '2026-10-12', '2027-01-13']);
  assert.deepEqual(f.urls, [
    'https://lex.uz/docs/8530799',
    'https://www.lex.uz/docs/-4888804',
    'lex.uz/docs/-4888804?ONDATE=13.01.2027',
  ]);
  assert.deepEqual(f.actNumbers.sort(), ['12/8', '24/2', '3254-2', '397', '50^1', '50^5', '8^1'].sort());
  // Маркеры списков «1.», «3)», номера заголовков и эмодзи 1️⃣ не считаются; цифры из URL и дат — тоже.
  assert.deepEqual(f.numbers.sort(), ['10', '1000', '12.5', '14', '3', '3', '3', '3254', '53'].sort());
});

test('идентичный по фактам перевод → ok', () => {
  const r = compareNumbers(EN, RU);
  assert.deepEqual(r.details, []);
  assert.equal(r.ok, true);
});

test('T-7: изменено одно число в RU → блок с указанием числа', () => {
  const r = compareNumbers(EN, RU.replace('Пунктов приложения: 10', 'Пунктов приложения: 11'));
  assert.equal(r.ok, false);
  assert.deepEqual(r.missingInRu, ['10']);
  assert.deepEqual(r.extraInRu, ['11']);
  assert.ok(r.details.some((d) => d.includes('«10»')));
});

test('изменена дата → блок', () => {
  const r = compareNumbers(EN, RU.replace('13 января 2027 г.', '14 января 2027 г.'));
  assert.equal(r.ok, false);
  assert.deepEqual(r.missingInRu, ['2027-01-13']);
  assert.deepEqual(r.extraInRu, ['2027-01-14']);
  assert.ok(r.details.some((d) => d.startsWith('Дата «2027-01-13»')));
});

test('потерян URL → блок', () => {
  const r = compareNumbers(EN, RU.replace(', действующая редакция https://www.lex.uz/docs/-4888804', ''));
  assert.equal(r.ok, false);
  assert.deepEqual(r.missingInRu, ['https://www.lex.uz/docs/-4888804']);
  assert.ok(r.details[0].startsWith('Ссылка'));
});

test('разный формат даты, та же дата → ok', () => {
  const variantsEn = ['13 January 2027', 'January 13, 2027', '2027-01-13', '13.01.2027'];
  const variantsRu = ['13 января 2027 г.', '13.01.2027', '2027-01-13'];
  for (const e of variantsEn) {
    for (const r of variantsRu) assert.equal(compareNumbers(`Effective ${e}.`, `Вступает в силу ${r}.`).ok, true, `${e} / ${r}`);
  }
});

test('«1 000» = «1,000» = «1000»; десятичная запятая = точка', () => {
  assert.equal(compareNumbers('1,000 banks', '1 000 банков').ok, true);
  assert.equal(compareNumbers('1000 banks', '1 000 банков').ok, true);
  assert.equal(compareNumbers('1,000,000 soums', '1 000 000 сумов').ok, true);
  assert.equal(compareNumbers('ratio 12.5%', 'норматив 12,5%').ok, true);
  assert.equal(compareNumbers('1,000.5', '1 000,5').ok, true);
  assert.equal(compareNumbers('1,000 banks', '100 банков').ok, false);
});

test('номера 24/2 и 3254-2 сохраняются; подмена номера → блок', () => {
  assert.equal(compareNumbers('Resolution No. 24/2, reg. 3254-2', 'Постановление № 24/2, рег. 3254-2').ok, true);
  const r = compareNumbers('Resolution No. 24/2, reg. 3254-2', 'Постановление № 24/3, рег. 3254-2');
  assert.equal(r.ok, false);
  assert.deepEqual(r.missingInRu, ['24/2']);
  assert.deepEqual(r.extraInRu, ['24/3']);
  // «ПП-397» и «PP-397» — один номер в разных алфавитах.
  assert.equal(compareNumbers('Decree PP-397', 'Постановление ПП-397').ok, true);
});

test('лишнее число в RU → блок', () => {
  const r = compareNumbers(EN, RU.replace('Найдено новое изменение.', 'Найдено 2 новых изменения.'));
  assert.equal(r.ok, false);
  assert.deepEqual(r.extraInRu, ['2']);
  assert.deepEqual(r.missingInRu, []);
});

test('маркеры списков и номера заголовков игнорируются, эмодзи не мешают', () => {
  assert.equal(compareNumbers('## 2. Scope\n1. Banks\n2) Leasing ✅', '## 3. Сфера\n7. Банки\n8) Лизинг ❌ ⚠️').ok, true);
  assert.equal(compareNumbers('Points 2, 3, 5 and 53', 'Пункты 2, 3, 5 и 53').ok, true);
  assert.equal(compareNumbers('Points 2, 3, 5 and 53', 'Пункты 2, 3 и 53').ok, false);
});
