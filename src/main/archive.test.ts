import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { actDir, appendLog, countryDir, countryPaths, listRuns, runDir, safeActId } from './archive.ts';
import { createRun, markAct, saveRun, setCountryStatus, finishRun } from './runner/run-state.ts';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'rw-arc-'));

test('пути и безопасный id акта', () => {
  assert.equal(safeActId('24/2 ПП №5'), '24_2_____5');
  assert.equal(safeActId('..'), '__');
  assert.equal(safeActId('3254-2'), '3254-2');
  assert.equal(runDir('/w', 'r'), join('/w', 'runs', 'r'));
  assert.equal(countryDir('/w', 'r', 'UZ'), join('/w', 'runs', 'r', 'UZ'));
  assert.equal(actDir('/w', 'r', 'UZ', 'a/b'), join('/w', 'runs', 'r', 'UZ', 'acts', 'a_b'));
  const p = countryPaths('/c');
  assert.equal(p.reportRu, join('/c', 'report.ru.md'));
  assert.equal(p.log, join('/c', 'log.jsonl'));
});

test('appendLog дописывает строки jsonl', () => {
  const dir = join(tmp(), 'UZ');
  appendLog(dir, { a: 1 });
  appendLog(dir, { b: 'два' });
  const lines = readFileSync(countryPaths(dir).log, 'utf8').trim().split('\n');
  assert.deepEqual(lines.map((l) => JSON.parse(l)), [{ a: 1 }, { b: 'два' }]);
});

test('listRuns: индекс, новые сверху, битый run.json не падает', () => {
  const ws = tmp();
  assert.deepEqual(listRuns(ws), []);
  const W = { from: '2026-11-01', to: '2026-11-15' };
  const mk = (h: number) =>
    createRun({ workspaceDir: ws, mode: 'scheduled', countries: [{ code: 'UZ', window: W }, { code: 'KZ', window: W }], skillsHash: 'h', now: new Date(2026, 10, 17, h, 0) });
  const a = mk(8);
  setCountryStatus(a.state, 'UZ', 'changes');
  setCountryStatus(a.state, 'KZ', 'failed:source');
  finishRun(a.state, new Date());
  saveRun(a.dir, a.state);
  mk(9);
  mkdirSync(join(ws, 'runs', 'broken'));
  writeFileSync(join(ws, 'runs', 'broken', 'run.json'), '{');
  markAct(a.state, 'UZ', 'x', {});
  const list = listRuns(ws);
  assert.equal(list.length, 3);
  assert.equal(list.find((r) => r.id === 'broken')?.broken, true);
  const ok = list.filter((r) => !r.broken);
  assert.deepEqual(ok.map((r) => r.id), ['2026-11-17_0900', '2026-11-17_0800']);
  assert.deepEqual(ok[1]!.summary, { changes: 1, no_changes: 0, failed: 1, pending: 0 });
  assert.equal(ok[1]!.finished, true);
  assert.equal(ok[0]!.finished, false);
  assert.equal(ok[0]!.mode, 'scheduled');
});
