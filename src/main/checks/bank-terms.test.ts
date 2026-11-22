// Тесты банковских терминов (SCR): строки взяты из реальных снимков прогона 2026-11-18_1517 (lex.uz, UZ).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFragments, findTerms, hasBankTerms, normalizeText } from './bank-terms.ts';

// lexuz-8554315 (пост. ЦБ № 22/4, платёжный коммутатор) — существенный акт.
const PAYMENT_SWITCH = [
  '3960-сон 23.10.2026. Toʻlov svitchi orqali chakana toʻlovlarni oʻtkazish tartibi toʻgʻrisidagi nizomni tasdiqlash haqida',
  'Oʻzbekiston Respublikasi Markaziy banki boshqaruvining qarori, 23.10.2026 yilda ro‘yxatdan o‘tgan, ro‘yxat raqami 3960',
  'Toʻlov svitchi orqali chakana toʻlovlarni oʻtkazish tartibi toʻgʻrisidagi nizomni tasdiqlash haqida',
].join('\n');

// lexuz-8543784 (почтовые правила) и lexuz-8537099 (международный договор) — шум.
const POSTAL = [
  '2219-19-сон 16.10.2026. Pochta aloqasi xizmatlarini koʻrsatish qoidalariga oʻzgartirishlar kiritish toʻgʻrisida',
  'Oʻzbekiston Respublikasi raqamli texnologiyalar vazirining buyrugʻi, 16.10.2026 yilda ro‘yxatdan o‘tgan, ro‘yxat raqami 2219-19',
].join('\n');
const TREATY = 'ПҚ-373-сон 14.10.2026. Халқаро шартномани тасдиқлаш тўғрисида\nЎзбекистон Республикаси Президентининг қарори';

test('нормализация сохраняет длину и приводит апострофы и узбекскую кириллицу', () => {
  const s = 'Toʻlov Қарор ҳақида';
  const n = normalizeText(s);
  assert.equal(n.length, s.length);
  assert.ok(n.startsWith("to'lov"));
  assert.ok(n.includes('карор'));
});

test('платёжный коммутатор ЦБ: термины найдены', () => {
  const hits = findTerms(PAYMENT_SWITCH);
  const ids = new Set(hits.map((h) => h.term));
  assert.ok(ids.has('payment'), 'платёж');
  assert.ok(ids.has('central-bank'), 'Markaziy bank');
  assert.ok(hasBankTerms(PAYMENT_SWITCH).has);
});

test('шум (почта, международный договор): терминов нет', () => {
  assert.equal(findTerms(POSTAL).length, 0);
  assert.equal(findTerms(TREATY).length, 0);
  assert.equal(hasBankTerms(POSTAL).has, false);
});

test('«bank» в «bankrot» — банкротство, а не банк', () => {
  const ids = findTerms('Bankrotlik toʻgʻrisidagi qonun').map((h) => h.term);
  assert.deepEqual(ids, ['insolvency']);
});

test('вложенное совпадение не считается дважды: «Markaziy bank» — одно вхождение', () => {
  const hits = findTerms('Markaziy bank qarori');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].term, 'central-bank');
});

test('окончания слов (морфология): кредитлар, депозитов, акционеров', () => {
  const ids = new Set(findTerms('кредитлар; депозитов; акционеров').map((h) => h.term));
  assert.ok(ids.has('credit') && ids.has('deposit') && ids.has('shareholder'));
});

test('порог hasBankTerms настраивается', () => {
  assert.equal(hasBankTerms('Markaziy bank', { threshold: 1 }).has, true);
  assert.equal(hasBankTerms('Markaziy bank', { threshold: 2 }).has, false);
});

test('вырезка фрагментов: заголовок всегда есть, лимит соблюдается, истина о усечении', () => {
  const filler = 'Umumiy qoida matni. '.repeat(400);
  const body = `${PAYMENT_SWITCH}\n${filler}\nBank depoziti va kredit bo'yicha talablar. ${filler}`.repeat(6);
  const r = extractFragments(body, { maxChars: 3000 });
  assert.ok(r.fragments[0].text.includes('Toʻlov svitchi'));
  assert.equal(r.fragments[0].start, 0);
  const total = r.fragments.reduce((a, f) => a + f.text.length, 0);
  assert.ok(total <= 3000 + 200, `итого ${total}`);
  assert.ok(r.truncated);
  assert.ok(r.termCount > 0);
});

test('вырезка фрагментов: у акта без терминов остаётся только заголовок', () => {
  const r = extractFragments(POSTAL + '\n' + 'Pochta xizmati. '.repeat(500));
  assert.equal(r.termCount, 0);
  assert.equal(r.fragments.length, 1);
  assert.ok(r.fragments[0].text.length < 700);
});

test('вырезка фрагментов: короткий текст возвращается целиком', () => {
  const r = extractFragments(PAYMENT_SWITCH, { maxChars: 12000 });
  assert.equal(r.truncated, false);
  assert.equal(r.fragments.length, 1);
  assert.equal(r.fragments[0].text, PAYMENT_SWITCH);
});

test('AML на узбекской кириллице распознаётся', () => {
  const ids = findTerms('Жиноий фаолиятдан олинган даромадларни легаллаштиришга ва терроризмни молиялаштиришга қарши').map((h) => h.term);
  assert.ok(ids.includes('aml'));
});
