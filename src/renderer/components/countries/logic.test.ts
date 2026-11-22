import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Source } from '../../../shared/types.ts';
import { countryHealth, filterCatalog, flagEmoji, formatCheckedDate, missingSourceTypes, parseLanguages, parseIssuerLines, formatIssuerLines, validateIssuerRules, sameIssuerRules } from './logic.ts';

function src(state: Source['state'], enabled = true, type: Source['type'] = 'legal_base'): Source {
  return { id: 'x', name: 'n', url: 'https://a.b', type, language: 'ru', priority: 'main', enabled, state, stateReason: '', checkedAt: null, seenLatest: [], note: '' };
}

test('countryHealth: учитывает только включённые', () => {
  assert.equal(countryHealth([]), 'unchecked');
  assert.equal(countryHealth([src('fail', false)]), 'unchecked');
  assert.equal(countryHealth([src('ok'), src('fail', false)]), 'ok');
  assert.equal(countryHealth([src('ok'), src('warn')]), 'warn');
  assert.equal(countryHealth([src('warn'), src('fail')]), 'fail');
  assert.equal(countryHealth([src('ok'), src('unchecked')]), 'unchecked');
});

test('flagEmoji', () => {
  assert.equal(flagEmoji('UZ'), '🇺🇿');
  assert.equal(flagEmoji('kz'), '🇰🇿');
  assert.equal(flagEmoji('X'), '');
  assert.equal(flagEmoji('123'), '');
});

test('formatCheckedDate', () => {
  assert.equal(formatCheckedDate(null), '—');
  assert.equal(formatCheckedDate('мусор'), '—');
  assert.equal(formatCheckedDate('2026-11-23T10:00:00'), '23.11');
  assert.equal(formatCheckedDate('2026-03-05T10:00:00'), '05.03');
});

test('filterCatalog: исключает добавленные и ищет', () => {
  const cat = [
    { code: 'UZ', nameRu: 'Узбекистан', languages: ['uz', 'ru'] },
    { code: 'KZ', nameRu: 'Казахстан', languages: ['kk', 'ru'] },
    { code: 'AM', nameRu: 'Армения', languages: ['hy'] },
  ];
  assert.deepEqual(filterCatalog(cat, ['uz'], '').map((c) => c.code), ['AM', 'KZ']);
  assert.deepEqual(filterCatalog(cat, [], 'каз').map((c) => c.code), ['KZ']);
  assert.deepEqual(filterCatalog(cat, [], 'am').map((c) => c.code), ['AM']);
});

test('parseLanguages', () => {
  assert.deepEqual(parseLanguages('uz, RU ,uz'), ['uz', 'ru']);
  assert.deepEqual(parseLanguages(''), []);
});

test('missingSourceTypes', () => {
  assert.deepEqual(missingSourceTypes([src('ok', true, 'legal_base')]), ['regulator', 'drafts']);
  assert.deepEqual(missingSourceTypes([]), ['legal_base', 'regulator', 'drafts']);
});

test('parseIssuerLines / formatIssuerLines', () => {
  assert.deepEqual(parseIssuerLines('  Центрального  банка \n\nцентрального банка\r\nстрахов'), ['Центрального банка', 'страхов']);
  assert.deepEqual(parseIssuerLines(''), []);
  assert.equal(formatIssuerLines(['а', 'б']), 'а\nб');
});

test('validateIssuerRules и sameIssuerRules', () => {
  const msg = { tooMany: (n: number) => `много ${n}`, tooLong: (n: number) => `длинно ${n}` };
  assert.deepEqual(validateIssuerRules({ class1: ['а'], class2: [] }, msg), {});
  assert.deepEqual(validateIssuerRules({ class1: Array.from({ length: 51 }, (_, i) => String(i)), class2: ['я'.repeat(121)] }, msg), { class1: 'много 50', class2: 'длинно 120' });
  assert.equal(sameIssuerRules({ class1: ['а'], class2: [] }, { class1: ['а'], class2: [] }), true);
  assert.equal(sameIssuerRules({ class1: ['а'], class2: [] }, { class1: [], class2: ['а'] }), false);
});
