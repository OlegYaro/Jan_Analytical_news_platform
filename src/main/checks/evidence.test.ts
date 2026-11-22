import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Card, Fact } from '../../shared/schema-types.ts';
import { htmlToText } from '../collect/snapshot.ts';
import {
  MONTH_NAMES,
  checkCardEvidence,
  evidenceFailures,
  evidenceOk,
  hasNumberToken,
  normalizeForQuote,
  parseDatesFromQuote,
  quoteInTexts,
  toIso,
} from './evidence.ts';

const isoDates = (q: string): string[] => parseDatesFromQuote(q).map(toIso);

// ───────── Нормализация ─────────

test('нормализация: апострофы ʼ \' ’ ‘ ʻ ` ´ → \'', () => {
  const forms = ['Oʼzbekiston', "O'zbekiston", 'O’zbekiston', 'O‘zbekiston', 'Oʻzbekiston', 'O`zbekiston', 'O´zbekiston'];
  for (const f of forms) assert.equal(normalizeForQuote(f), "o'zbekiston", f);
});

test('нормализация: кавычки, регистр, пробелы, тире, невидимые символы', () => {
  assert.equal(normalizeForQuote('«Banklar» “va” „bank‟'), '"banklar" "va" "bank"');
  assert.equal(normalizeForQuote('  Markaziy BANK boshqaruvi\n\t qarori  '), 'markaziy bank boshqaruvi qarori');
  assert.equal(normalizeForQuote('kor­pora​tiv'), 'korporativ');
  assert.equal(normalizeForQuote('50¹–50⁵ — 3254−2'), '50¹-50⁵ - 3254-2');
  // Диакритика и национальные буквы не выбрасываются.
  assert.equal(normalizeForQuote('ҚЫРКҮЙЕК ŞİRKƏT Ўзбекистон ӨРГӨДӨЛ'), 'қыркүйек şirkət ўзбекистон өргөдөл');
  // NFC: составной и разложенный «й» дают одно и то же.
  assert.equal(normalizeForQuote('йюн'), normalizeForQuote('йюн'));
});

test('цитата: подстрока найдена после нормализации', () => {
  const snap = 'Oʻzbekiston Respublikasi Adliya vazirligi tomonidan 2026 yil 9 oktabrda\nroʻyxatdan oʻtkazildi, roʻyxat raqami 3254-2';
  assert.equal(quoteInTexts("OZBEKISTON", [snap]), false);
  assert.equal(quoteInTexts("O'zbekiston respublikasi ADLIYA vazirligi", [snap]), true);
  assert.equal(quoteInTexts('9 oktabrda ro’yxatdan o‘tkazildi', [snap]), true); // перенос строки = пробел
  assert.equal(quoteInTexts('roʻyxat raqami 3254-2', ['другой текст', snap]), true); // любой из снимков
});

test('T-14: ложная цитата → не найдена', () => {
  const snap = 'Mazkur qaror rasmiy eʼlon qilingan kundan eʼtiboran uch oydan keyin kuchga kiradi.';
  assert.equal(quoteInTexts('Mazkur qaror rasmiy eʼlon qilingan kundan eʼtiboran olti oydan keyin kuchga kiradi', [snap]), false);
  assert.equal(quoteInTexts('', [snap]), false);
  assert.equal(quoteInTexts('   ', [snap]), false);
});

// ───────── Даты ─────────

test('даты: числовые форматы', () => {
  assert.deepEqual(isoDates('Кучга кириш санаси 13.01.2027'), ['2027-01-13']);
  assert.deepEqual(isoDates('effective 2027-01-13'), ['2027-01-13']);
  assert.deepEqual(isoDates('2027.01.13'), ['2027-01-13']);
  assert.deepEqual(isoDates('30.06.2020-y., 10/20/3254/1045-son'), ['2020-06-30']);
  assert.deepEqual(isoDates('31.02.2027 и 2027-13-01'), []); // несуществующие даты не считаются
});

test('даты: названия месяцев (uz, ru, en, kk, az, mn)', () => {
  assert.deepEqual(isoDates('13 yanvar 2027-yil'), ['2027-01-13']);
  assert.deepEqual(isoDates('13 январ 2027 йил'), ['2027-01-13']);
  assert.deepEqual(isoDates('13 января 2027 г.'), ['2027-01-13']);
  assert.deepEqual(isoDates('January 13, 2027'), ['2027-01-13']);
  assert.deepEqual(isoDates('13 January 2027'), ['2027-01-13']);
  // Узбекский порядок «год — день — месяц» с аффиксами (как на lex.uz).
  assert.deepEqual(isoDates('boshqaruvining 2026-yil 17-sentabrdagi 24/2-son qaroriga'), ['2026-09-17']);
  assert.deepEqual(isoDates('2026 yil 9 oktabrda roʻyxatdan oʻtkazildi'), ['2026-10-09']);
  // Казахский, азербайджанский.
  assert.deepEqual(isoDates('2026 жылғы 17 қыркүйектегі қаулысы'), ['2026-09-17']);
  assert.deepEqual(isoDates('17 sentyabr 2026-cı il tarixli'), ['2026-09-17']);
  // Монгольский.
  assert.deepEqual(isoDates('2027 оны 1 дүгээр сарын 13'), ['2027-01-13']);
  assert.deepEqual(isoDates('2026 оны арван нэгдүгээр сарын 17-ны өдөр'), ['2026-11-17']);
  assert.deepEqual(isoDates('2026 оны 11 сарын 17'), ['2026-11-17']);
  assert.deepEqual(isoDates('2026 оны тогтоол, 11 дүгээр сарын 17'), ['2026-11-17']); // год из «YYYY оны» выше
  assert.deepEqual(isoDates('11 дүгээр сарын 17'), []); // без года дата не засчитывается
});

test('даты: несколько дат в цитате, без повторов', () => {
  assert.deepEqual(isoDates('2020-yil 25-maydagi 12/8-son qarori (roʻyxat raqami 3254, 2020-yil 30-iyun) 30.06.2020-y.'), [
    '2020-05-25',
    '2020-06-30',
  ]);
});

test('словарь месяцев: 12 месяцев на каждом языке', () => {
  for (const lang of ['ru', 'uz', 'kk', 'ky', 'tg', 'tk', 'ka', 'hy', 'az', 'en', 'mn']) {
    assert.equal(MONTH_NAMES[lang]?.length, 12, lang);
  }
});

// ───────── Номера ─────────

test('номер в цитате отдельным токеном', () => {
  const n = (q: string, v: string): boolean => hasNumberToken(normalizeForQuote(q), normalizeForQuote(v));
  assert.equal(n('2026 yil 17 sentabr, 24/2-son', '24/2'), true);
  assert.equal(n('№ 24/2 от 17.09.2026', '24/2'), true);
  assert.equal(n('qaror 124/22-son', '24/2'), false);
  assert.equal(n('roʻyxat raqami 3254-2', '3254-2'), true);
  assert.equal(n('roʻyxat raqami 3254-2', '3254'), false); // «3254-2» — другой номер
  assert.equal(n('10/20/3254/1045-son', '3254'), false);
  assert.equal(n('(roʻyxat raqami 3254, 2020-yil 30-iyun)', '3254'), true);
  assert.equal(n('10. 53-bandda', '10'), true);
  assert.equal(n('10.5 foiz', '10'), false);
});

// ───────── Карточка на реальном снимке 3254-2 ─────────

const AMEND = 'https://lex.uz/docs/8530799';
const BASE = 'https://www.lex.uz/docs/-4888804';
const SNAPSHOT = htmlToText(
  readFileSync(join(import.meta.dirname, '..', 'collect', 'fixtures', 'lexuz-doc-8530799.html'), 'utf8'),
);
const U = (): Fact<never> => ({ value: 'unknown', quote: '', url: '' });
const f = <T>(value: T, quote: string, url = AMEND): Fact<T> => ({ value, quote, url });

/** Цитаты изменений — дословно из snapshot.txt акта 24/2 (3254-2). */
const CHANGE_QUOTES: Array<[string, Card['changes'][number]['kind'], string]> = [
  ['Point 2', 'rewritten', '2-bandning ikkinchi xatboshisi quyidagi tahrirda bayon etilsin'],
  ['Point 3', 'rewritten', 'birinchi va ikkinchi xatboshilar quyidagi tahrirda bayon etilsin'],
  ['Point 5', 'added', 'quyidagi mazmundagi sakkizinchi xatboshi bilan toʻldirilsin'],
  ['Point 8', 'added', 'quyidagi mazmundagi uchinchi va toʻrtinchi xatboshilar bilan toʻldirilsin'],
  ['Point 11', 'added', '11-band quyidagi mazmundagi xatboshi bilan toʻldirilsin'],
  ['Point 15', 'added', '15-band quyidagi mazmundagi xatboshilar bilan toʻldirilsin'],
  ['Point 16', 'rewritten', 'Audit qoʻmitasining raisi kengashning mustaqil aʼzosi boʻlishi va kengash raisi boʻlmasligi lozim.'],
  ['Point 19', 'rewritten', 'mazkur qoʻmitani tashkil etish tizimli ahamiyatga molik banklar uchun majburiy hisoblanadi'],
  ['Chapter 8¹ (points 50¹–50⁵)', 'new_chapter', 'Rahbar kadrlar zaxirasini shakllantirish va rivojlantirish'],
  ['Point 53', 'added', 'quyidagi mazmundagi oʻn uchinchi xatboshi bilan toʻldirilsin'],
];

/** Та же форма, что FIXTURE_FORM_ONLY в src/main/schemas.test.ts, но цитаты — реальные выдержки из снимка. */
function realCard(): Card {
  return {
    candidate_id: 'lexuz-8530799',
    country: 'UZ',
    act: {
      type: f('Central Bank Board resolution', 'Oʻzbekiston Respublikasi Markaziy banki boshqaruvining qarori'),
      issuer: f('Central Bank of the Republic of Uzbekistan', 'Oʻzbekiston Respublikasi Markaziy banki'),
      // В снимке «2026 yil 17 sentabr,» и «24/2-son» — на разных строках: перенос = пробел.
      number: f('24/2', 'Toshkent sh., 2026 yil 17 sentabr, 24/2-son'),
      title_original: f(
        'Tijorat banklarida korporativ boshqaruv toʻgʻrisidagi nizomga oʻzgartirish va qoʻshimchalar kiritish haqida',
        "Tijorat banklarida korporativ boshqaruv to'g'risidagi nizomga o'zgartirish va qo'shimchalar kiritish haqida",
      ),
      title_en: 'On amendments and additions to the Regulation on corporate governance in commercial banks',
      adoption_date: f('2026-09-17', 'Oʻzbekiston Respublikasi Markaziy banki boshqaruvining 2026-yil 17-sentabrdagi 24/2-son qaroriga'),
      registration_number: f('3254-2', 'roʻyxat raqami 3254-2'),
      registration_date: f('2026-10-09', 'Oʻzbekiston Respublikasi Adliya vazirligi tomonidan 2026 yil 9 oktabrda roʻyxatdan oʻtkazildi'),
      publication_date: f('2026-10-12', '(Qonunchilik maʼlumotlari milliy bazasi, 12.10.2026 y., 10/26/3254-2/1020-son)'),
      effective_date: f('2027-01-13', 'Кучга кириш санаси 13.01.2027'),
      transition_period: {
        exists: f<'yes' | 'no'>('no', 'Mazkur qaror rasmiy eʼlon qilingan kundan eʼtiboran uch oydan keyin kuchga kiradi.'),
        details: 'In force 3 months after official publication; no transition period.',
      },
      original_language: 'uz',
      official_russian_text: 'no',
    },
    stage: 'published',
    update_of: null,
    amends: {
      base_act_title: f('Regulation on corporate governance in commercial banks', 'Tijorat banklarida korporativ boshqaruv toʻgʻrisidagi nizom'),
      base_act_number: f('3254', '12/8-son qarori (roʻyxat raqami 3254, 2020-yil 30-iyun)'),
      base_act_url: BASE,
      prior_amendments: [{ number: '3254-1', date: '2026-07-08', url: BASE }],
    },
    scope: {
      applies_to: f('Commercial banks', 'Tijorat banklarida korporativ boshqaruv toʻgʻrisidagi nizom'),
      not_applies_to: U(),
    },
    change_count: {
      annex_items: f<number>(10, '10. 53-bandda:'),
      legal_base_marks: U(), // в тексте акта счёт отметок не виден
      explanation: 'Annex has 10 items.',
    },
    changes: CHANGE_QUOTES.map(([location, kind, quote], i) => ({
      n: i + 1,
      location,
      kind,
      summary_en: `Change ${i + 1}`,
      significance: 'less_significant',
      significance_reason: 'test',
      implementation_difficulty: 'low',
      difficulty_reason: 'test',
      quote,
      url: AMEND,
    })),
    links: { amending_act: AMEND, current_version: BASE, version_on_effective_date: `${BASE}?ONDATE=13.01.2027` },
    unknowns: ['scope.not_applies_to', 'change_count.legal_base_marks'],
    notes: '',
  };
}

test('реальная карточка 3254-2 на реальном снимке: все проверки ok', () => {
  const r = checkCardEvidence(realCard(), [SNAPSHOT]);
  assert.deepEqual(evidenceFailures(r), [], JSON.stringify(r.filter((x) => !x.ok), null, 1));
  assert.equal(evidenceOk(r), true);
  // 16 фактических полей + 10 цитат изменений, по одному результату на поле.
  assert.equal(r.length, 16 + 10);
  assert.equal(new Set(r.map((x) => x.field)).size, r.length);
  assert.equal(r.find((x) => x.field === 'scope.not_applies_to')?.reason, 'unknown — не проверяется');
  assert.ok(r.some((x) => x.field === 'changes[9].quote' && x.ok));
});

test('T-14: подмена одной цитаты → ❌ ровно по этому полю', () => {
  const c = realCard();
  c.act.transition_period.exists.quote = 'Mazkur qaror rasmiy eʼlon qilingan kundan eʼtiboran olti oydan keyin kuchga kiradi.';
  const r = checkCardEvidence(c, [SNAPSHOT]);
  assert.deepEqual(evidenceFailures(r), ['act.transition_period.exists']);
  assert.equal(r.find((x) => !x.ok)?.reason, 'цитата не найдена в снимке');
  assert.equal(evidenceOk(r), false);

  const c2 = realCard();
  c2.changes[3].quote = 'kengashning kamida yarmi mustaqil aʼzolardan iborat boʻlishi lozim';
  assert.deepEqual(evidenceFailures(checkCardEvidence(c2, [SNAPSHOT])), ['changes[3].quote']);
});

test('HAL-03: дата значения не совпадает с датой в цитате', () => {
  const c = realCard();
  c.act.effective_date.value = '2027-01-12';
  const r = checkCardEvidence(c, [SNAPSHOT]);
  assert.deepEqual(evidenceFailures(r), ['act.effective_date']);
  assert.equal(r.find((x) => !x.ok)?.reason, 'в цитате нет даты 2027-01-12');

  const c2 = realCard();
  c2.act.registration_date.quote = 'roʻyxat raqami 3254-2'; // цитата есть в снимке, но без даты
  const r2 = checkCardEvidence(c2, [SNAPSHOT]);
  assert.deepEqual(evidenceFailures(r2), ['act.registration_date']);
  assert.equal(r2.find((x) => !x.ok)?.reason, 'в цитате нет даты 2026-10-09');

  const c3 = realCard();
  c3.act.adoption_date.value = '17.09.2026';
  assert.match(checkCardEvidence(c3, [SNAPSHOT]).find((x) => !x.ok)?.reason ?? '', /не является датой/);
});

test('HAL-03: номер не найден в цитате', () => {
  const c = realCard();
  c.act.number.value = '24/3';
  const r = checkCardEvidence(c, [SNAPSHOT]);
  assert.deepEqual(evidenceFailures(r), ['act.number']);
  assert.equal(r.find((x) => !x.ok)?.reason, 'номер 24/3 не найден в цитате');

  const c2 = realCard();
  c2.amends.base_act_number.quote = 'roʻyxat raqami 3254-2'; // «3254» есть только как часть «3254-2»
  assert.deepEqual(evidenceFailures(checkCardEvidence(c2, [SNAPSHOT])), ['amends.base_act_number']);

  const c3 = realCard();
  c3.change_count.annex_items.value = 11;
  const r3 = checkCardEvidence(c3, [SNAPSHOT]);
  assert.deepEqual(evidenceFailures(r3), ['change_count.annex_items']);
  assert.equal(r3.find((x) => !x.ok)?.reason, 'число 11 не найдено в цитате');
});

test('пустая цитата при непустом значении → ❌; unknown пропускается', () => {
  const c = realCard();
  c.act.issuer.quote = '';
  c.changes[0].quote = ' ';
  c.act.publication_date = U();
  const r = checkCardEvidence(c, [SNAPSHOT]);
  assert.deepEqual(evidenceFailures(r), ['act.issuer', 'changes[0].quote']);
  assert.ok(r.filter((x) => !x.ok).every((x) => x.reason === 'цитата пуста'));
  assert.deepEqual(r.find((x) => x.field === 'act.publication_date'), {
    field: 'act.publication_date',
    ok: true,
    reason: 'unknown — не проверяется',
  });
});

test('цитата из связанного снимка засчитывается; без снимков — всё ❌ кроме unknown', () => {
  const c = realCard();
  c.amends.base_act_title.quote = 'Tijorat banklarida korporativ boshqaruv toʻgʻrisidagi NIZOM (yangi tahrir)';
  const related = 'Tijorat banklarida korporativ boshqaruv toʻgʻrisidagi nizom (yangi tahrir)';
  assert.equal(evidenceOk(checkCardEvidence(c, [SNAPSHOT, related])), true);
  const r = checkCardEvidence(c, []);
  assert.equal(evidenceFailures(r).length, r.length - 2);
});
