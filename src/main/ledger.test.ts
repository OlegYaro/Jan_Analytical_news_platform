import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { LedgerEntry } from '../shared/run-types.ts';
import { classify, commitSent, filterCandidates, ledgerFile, ledgerKey, loadLedger, shouldWriteLedger } from './ledger.ts';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'rw-led-'));
const entry = (o: Partial<LedgerEntry> = {}): LedgerEntry => ({
  key: 'reg:3254-2',
  first_reported_at: '2026-10-01T08:00:00.000Z',
  last_stage: 'adopted',
  effective_date: '2026-12-01',
  title_en: 'T',
  run_id: 'r1',
  ...o,
});

test('ключи', () => {
  assert.equal(ledgerKey({ registrationNumber: ' 3254-2 ', number: '24/2' }), 'reg:3254-2');
  assert.equal(ledgerKey({ registrationNumber: 'unknown', number: '24/2', date: '2026-09-17', url: ' http://x ' }), 'num:24/2|2026-09-17|http://x');
  assert.equal(ledgerKey({ number: 'Ab' }), 'num:Ab||');
});

test('classify', () => {
  assert.deepEqual(classify(null, { stage: 'draft' }), { kind: 'new' });
  assert.deepEqual(classify(entry(), { stage: 'adopted', effective_date: '2026-12-01' }), { kind: 'duplicate' });
  assert.deepEqual(classify(entry(), { stage: 'registered', effective_date: '2026-12-01' }), {
    kind: 'update', since: '2026-10-01T08:00:00.000Z', reason: 'stage',
  });
  assert.deepEqual(classify(entry(), { stage: 'adopted', effective_date: '2027-01-01' }), {
    kind: 'update', since: '2026-10-01T08:00:00.000Z', reason: 'effective_date',
  });
  assert.deepEqual(classify(entry(), { stage: 'adopted', effective_date: 'unknown' }), { kind: 'duplicate' });
  assert.deepEqual(classify(entry(), { stage: 'draft', effective_date: '2027-01-01' }), { kind: 'duplicate' });
});

test('режимы: dry_run и backfill не пишут журнал', () => {
  assert.equal(shouldWriteLedger('scheduled'), true);
  assert.equal(shouldWriteLedger('manual'), true);
  assert.equal(shouldWriteLedger('dry_run'), false);
  assert.equal(shouldWriteLedger('backfill'), false);
});

test('commitSent: не теряет прошлое, сохраняет first_reported_at, повтор не приходит', () => {
  const ws = tmp();
  const t1 = new Date('2026-10-01T08:00:00Z');
  commitSent(ws, 'UZ', [{ key: 'reg:1', stage: 'adopted', effective_date: 'unknown', title_en: 'A' }], 'r1', t1);
  commitSent(ws, 'UZ', [{ key: 'reg:2', stage: 'draft', effective_date: 'unknown', title_en: 'B' }], 'r2', new Date('2026-10-02T00:00:00Z'));
  const l = commitSent(ws, 'UZ', [{ key: 'reg:1', stage: 'registered', effective_date: '2026-12-01', title_en: 'A' }], 'r3');
  assert.equal(l.length, 2);
  const a = l.find((e) => e.key === 'reg:1')!;
  assert.equal(a.first_reported_at, t1.toISOString());
  assert.equal(a.last_stage, 'registered');
  assert.equal(a.run_id, 'r3');
  assert.deepEqual(loadLedger(ws, 'UZ'), l);
  assert.equal(classify(a, { stage: 'registered', effective_date: '2026-12-01' }).kind, 'duplicate');
});

test('битый файл → .bak и пустой журнал', () => {
  const ws = tmp();
  assert.deepEqual(loadLedger(ws, 'UZ'), []);
  const f = ledgerFile(ws, 'UZ');
  mkdirSync(join(ws, 'state', 'ledger'), { recursive: true });
  writeFileSync(f, '{not json');
  assert.deepEqual(loadLedger(ws, 'UZ'), []);
  assert.ok(existsSync(f + '.bak'));
  assert.equal(readFileSync(f + '.bak', 'utf8'), '{not json');
  assert.ok(!existsSync(f));
});

test('filterCandidates', () => {
  const ledger = [entry({ key: 'reg:1' })];
  const out = filterCandidates(ledger, [
    { key: 'reg:1' },
    { key: 'reg:1', maybeUpdate: true },
    { key: 'reg:2' },
  ]);
  assert.deepEqual(out, [{ key: 'reg:1', maybeUpdate: true }, { key: 'reg:2' }]);
});
