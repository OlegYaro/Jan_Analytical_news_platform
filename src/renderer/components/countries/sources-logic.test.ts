import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Country, Source } from '../../../shared/types.ts';
import {
  actTypeLabel,
  countStates,
  countriesSummary,
  formatCheckedAt,
  hasFailedSources,
  lastCheckIso,
  progressFraction,
  progressText,
  sourcesSummaryText,
} from './sources-logic.ts';

function src(state: Source['state'], enabled = true, checkedAt: string | null = null): Source {
  return { id: 'x', name: 'n', url: 'https://a.b', type: 'legal_base', language: 'ru', priority: 'main', enabled, state, stateReason: '', checkedAt, seenLatest: [], note: '' };
}
function country(sources: Source[], active = true, lastCheckedAt: string | null = null): Country {
  return { code: 'UZ', name: 'Узбекистан', languages: ['uz'], active, sources, watchedActs: [], lastCheckedAt, lastRunSummary: '' };
}

test('countStates и текст сводки: только включённые', () => {
  const s = [src('ok'), src('ok'), src('warn'), src('fail', false), src('unchecked')];
  assert.deepEqual(countStates(s), { ok: 2, warn: 1, fail: 0, unchecked: 1 });
  assert.equal(sourcesSummaryText(s), '✅ 2 · ⚠ 1 · не проверено: 1');
  assert.equal(sourcesSummaryText([]), 'нет включённых источников');
  assert.equal(sourcesSummaryText([src('fail')]), '❌ 1');
});

test('hasFailedSources', () => {
  assert.equal(hasFailedSources([src('fail')]), true);
  assert.equal(hasFailedSources([src('fail', false), src('ok')]), false);
});

test('lastCheckIso: самая поздняя дата', () => {
  assert.equal(lastCheckIso(country([])), null);
  const c = country([src('ok', true, '2026-11-20T10:00:00'), src('ok', true, '2026-11-22T10:00:00')], true, '2026-11-21T10:00:00');
  assert.equal(lastCheckIso(c), '2026-11-22T10:00:00');
  assert.equal(lastCheckIso(country([src('ok', true, 'мусор')], true, '2026-11-21T10:00:00')), '2026-11-21T10:00:00');
});

test('formatCheckedAt', () => {
  assert.equal(formatCheckedAt(null), 'ещё не проверялся');
  assert.equal(formatCheckedAt('мусор'), 'ещё не проверялся');
  assert.equal(formatCheckedAt('2026-03-05T09:07:00'), '05.03 в 09:07');
});

test('progressText и progressFraction', () => {
  assert.equal(progressText({ text: 'Казахстан: adilet.zan.kz', done: 2, total: 4 }), 'Проверяем: Казахстан: adilet.zan.kz, 2 из 4');
  assert.equal(progressText({ text: 'Ищем основные законы страны…', done: 0, total: 1 }), 'Ищем основные законы страны…');
  assert.equal(progressText({ text: '', done: 0, total: 3 }), '');
  assert.equal(progressText({ text: 'x', done: 9, total: 4 }), 'Проверяем: x, 4 из 4');
  assert.equal(progressFraction({ done: 1, total: 4 }), 0.25);
  assert.equal(progressFraction({ done: 1, total: 0 }), 0);
});

test('actTypeLabel: приоритет у русского названия от приложения', () => {
  assert.equal(actTypeLabel('aml_law', 'закон про AML'), 'закон про AML');
  assert.equal(actTypeLabel('fx_law'), 'закон о валютном регулировании');
  assert.equal(actTypeLabel('unknown'), 'unknown');
});

test('countriesSummary: только включённые страны', () => {
  const list = [
    country([src('ok')]),
    country([src('ok'), src('warn')]),
    country([src('fail')]),
    country([src('fail')], false),
    country([]),
  ];
  assert.deepEqual(countriesSummary(list), { ok: 1, warn: 1, fail: 1, unchecked: 1 });
});
