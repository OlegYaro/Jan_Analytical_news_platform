// Классы органов: строки issuer — реальные, из candidates.json прогона 2026-11-18_1517 (lex.uz, UZ).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyIssuer, DEFAULT_ISSUER_RULES, issuerRulesFor } from './issuer-class.ts';

const UZ = DEFAULT_ISSUER_RULES['UZ'];

test('финансовые регуляторы — класс 1 (ru и uz написания)', () => {
  assert.equal(classifyIssuer(UZ, 'Правления Центрального банка Республики Узбекистан', 'Постановление'), 1);
  assert.equal(classifyIssuer(UZ, 'Oʻzbekiston Respublikasi Markaziy banki boshqaruvining', 'qarori'), 1);
  assert.equal(classifyIssuer(UZ, 'директора Национального агентства перспективных проектов Республики Узбекистан', 'Приказ'), 1);
});

test('общие законодатели и неопознанный орган — класс 2', () => {
  assert.equal(classifyIssuer(UZ, 'Кабинета Министров Республики Узбекистан', 'Постановление'), 2);
  assert.equal(classifyIssuer(UZ, 'Президента Республики Узбекистан', 'Постановление'), 2);
  assert.equal(classifyIssuer(UZ, 'Республики Узбекистан', 'Закон'), 2);
  assert.equal(classifyIssuer(UZ, 'Oʻzbekiston Respublikasining', 'Qonuni'), 2);
  assert.equal(classifyIssuer(UZ, 'Oʻzbekiston Respublikasi Vazirlar Mahkamasining', 'qarori'), 2);
  assert.equal(classifyIssuer(UZ, '', ''), 2);
});

test('прочие органы — класс 3, в том числе ведомства «при Президенте» и «при Кабмине»', () => {
  assert.equal(classifyIssuer(UZ, 'Налогового комитета Республики Узбекистан', 'Постановление'), 3);
  assert.equal(classifyIssuer(UZ, 'министра здравоохранения Республики Узбекистан', 'Приказ'), 3);
  assert.equal(classifyIssuer(UZ, 'директора агентства по контролю за наркотиками и огнестрельным оружием при Администрации Президента Республики Узбекистан', 'Приказ'), 3);
  assert.equal(classifyIssuer(UZ, 'Комитета промышленной, радиационной и ядерной безопасности при Кабинете Министров Республики Узбекистан', 'Постановление'), 3);
  assert.equal(classifyIssuer(UZ, 'Oʻzbekiston Respublikasi Prezidenti huzuridagi Ijtimoiy himoya milliy agentligi direktorining', 'buyrugʻi'), 3);
});

test('несколько органов: берётся самый важный', () => {
  assert.equal(classifyIssuer(UZ, 'Министерство экономики и финансов Республики Узбекистан, Налогового комитета Республики Узбекистан', 'Постановление'), 3);
  assert.equal(classifyIssuer(UZ, 'Правления Центрального банка Республики Узбекистан, Налогового комитета Республики Узбекистан', 'Постановление'), 1);
});

test('нет правил у страны — всегда класс 2 (ничего не теряется)', () => {
  assert.equal(classifyIssuer(undefined, 'Налогового комитета', ''), 2);
  assert.equal(issuerRulesFor({ code: 'KZ' }), undefined);
});

test('правила страны из countries.json важнее стартовых', () => {
  const own = { class1: ['минфин'], class2: [] };
  assert.equal(issuerRulesFor({ code: 'UZ', issuerClasses: own }), own);
  assert.equal(classifyIssuer(own, 'Минфин РК', ''), 1);
  assert.equal(issuerRulesFor({ code: 'UZ' }), UZ);
});
