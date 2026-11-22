import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accountingTotals, checkCompleteness, completenessFailure } from './completeness.ts';

const ids = ['a', 'b', 'c'];
const it = (id: string, decision = 'relevant', reason_code: string | null = null) => ({ id, decision, reason_code });

test('полный ответ', () => {
  const items = [it('a'), it('b', 'borderline'), it('c', 'irrelevant', 'other_sector')];
  const r = checkCompleteness(ids, items);
  assert.equal(r.ok, true);
  assert.equal(completenessFailure(r), null);
  assert.deepEqual(accountingTotals(ids, items), { candidates: 3, selected: 2, discarded: 1, balanced: true });
});

test('T-15: потерянный кандидат', () => {
  const items = [it('a'), it('b')];
  const r = checkCompleteness(ids, items);
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['c']);
  assert.match(completenessFailure(r)!, /c/);
  assert.equal(accountingTotals(ids, items).balanced, false);
});

test('дубль', () => {
  const r = checkCompleteness(ids, [it('a'), it('a'), it('b'), it('c')]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.duplicates, ['a']);
});

test('лишний id', () => {
  const r = checkCompleteness(ids, [it('a'), it('b'), it('c'), it('zzz')]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.extra, ['zzz']);
});

test('irrelevant без причины', () => {
  const items = [it('a'), it('b'), it('c', 'irrelevant', null)];
  const r = checkCompleteness(ids, items);
  assert.equal(r.ok, false);
  assert.deepEqual(r.invalidIrrelevant, ['c']);
  assert.equal(accountingTotals(ids, items).balanced, false);
});
