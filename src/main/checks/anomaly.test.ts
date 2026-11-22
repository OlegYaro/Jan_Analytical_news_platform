import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { detectAnomaly, loadSourceHealth, recordSourceCount, MAX_HISTORY } from './anomaly.ts';

const now = new Date('2026-11-17T08:00:00Z');
const hist = (counts: number[]) =>
  counts.map((count, i) => ({ date: new Date(now.getTime() - (counts.length - i) * 2 * 86_400_000).toISOString(), count }));

test('медиана 0 — аномалии нет', () => {
  assert.equal(detectAnomaly(hist([0, 0, 0, 5, 0, 0, 0, 0]), now, 0).anomaly, false);
});

test('мало истории — аномалии нет', () => {
  assert.equal(detectAnomaly(hist([5, 5]), now, 0).anomaly, false);
  // окно меньше 7 дней
  const short = [1, 2, 3].map((c, i) => ({ date: new Date(now.getTime() - (3 - i) * 86_400_000).toISOString(), count: c + 3 }));
  assert.equal(detectAnomaly(short, now, 0).anomaly, false);
});

test('0 при медиане > 0 и окне >= 7 дней — failed:parser', () => {
  const r = detectAnomaly(hist([4, 5, 6, 4, 5]), now, 0);
  assert.equal(r.anomaly, true);
  assert.equal(r.status, 'failed:parser');
  assert.equal(r.median, 5);
  assert.equal(detectAnomaly(hist([4, 5, 6, 4, 5]), now, 2).anomaly, false);
});

test('медиана считается по последним 8', () => {
  const old = Array(10).fill(9);
  assert.equal(detectAnomaly(hist([...old, 0, 0, 0, 0, 0, 0, 0, 0]), now, 0).anomaly, false);
});

test('source-health: запись и обрезка истории; dry_run/backfill не пишут', () => {
  const ws = mkdtempSync(join(tmpdir(), 'rw-sh-'));
  for (let i = 0; i < MAX_HISTORY + 4; i++) {
    recordSourceCount(ws, 'uz-main', i, new Date(now.getTime() + i * 1000), 'scheduled');
  }
  const h = loadSourceHealth(ws);
  assert.equal(h['uz-main']!.length, MAX_HISTORY);
  assert.equal(h['uz-main']!.at(-1)!.count, MAX_HISTORY + 3);
  assert.equal(h['uz-main']![0]!.count, 4);
  assert.equal(recordSourceCount(ws, 'uz-main', 99, now, 'dry_run'), false);
  assert.equal(recordSourceCount(ws, 'uz-main', 99, now, 'backfill'), false);
  assert.equal(loadSourceHealth(ws)['uz-main']!.at(-1)!.count, MAX_HISTORY + 3);
});
