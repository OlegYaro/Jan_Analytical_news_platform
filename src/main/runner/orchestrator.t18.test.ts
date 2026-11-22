// T-18 (RUN-06): прогон убит SIGKILL посреди анализа → новый оркестратор продолжает с того же
// акта, готовые акты не повторяются, прерванный выполняется заново.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Orchestrator } from './orchestrator.ts';
import { findUnfinishedRun, loadRun } from './run-state.ts';
import { settingsFor } from './fixtures/orchestrator-stubs.ts';
import { T18_COUNTRIES, callCount, t18Executors } from './fixtures/t18-child.ts';

const CHILD = fileURLToPath(new URL('./fixtures/t18-child.ts', import.meta.url));

/** Ждёт появления файла; падает по таймауту или если дочерний процесс вышел раньше. */
function waitForFile(file: string, child: ReturnType<typeof spawn>, stderr: () => string, timeoutMs = 20_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const onExit = (code: number | null): void => {
      clearInterval(timer);
      reject(new Error(`дочерний процесс вышел раньше маркера (код ${code}): ${stderr()}`));
    };
    child.once('exit', onExit);
    const timer = setInterval(() => {
      if (existsSync(file)) {
        clearInterval(timer);
        child.off('exit', onExit);
        resolve();
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(timer);
        child.off('exit', onExit);
        reject(new Error(`маркер ${file} не появился за ${timeoutMs} мс: ${stderr()}`));
      }
    }, 20);
  });
}

test('T-18: SIGKILL во время анализа второго акта → resume продолжает с этого акта', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'rw-t18-ws-'));
  const markers = mkdtempSync(join(tmpdir(), 'rw-t18-mk-'));
  const child = spawn(process.execPath, [CHILD, ws, markers], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (d: string) => (err = (err + d).slice(-4000)));
  const exited = new Promise<NodeJS.Signals | null>((r) => child.once('exit', (_c, sig) => r(sig)));

  try {
    await waitForFile(join(markers, 'hang-a2'), child, () => err);
  } catch (e) {
    child.kill('SIGKILL');
    throw e;
  }
  child.kill('SIGKILL');
  assert.equal(await exited, 'SIGKILL');
  assert.ok(!existsSync(join(markers, 'child-finished')));

  // Состояние на момент убийства: a1 готов, a2 прерван, a3 не начат, KZ не начата.
  const found = findUnfinishedRun(ws);
  assert.ok(found, 'прерванный прогон найден при «следующем запуске»');
  const before = found.state.countries;
  assert.equal(before.UZ!.status, 'running');
  assert.equal(before.UZ!.stages.analyze.state, 'running');
  assert.deepEqual(
    Object.fromEntries(Object.entries(before.UZ!.acts).map(([k, v]) => [k, v.analyze])),
    { a1: 'done', a2: 'running', a3: 'pending' },
  );
  assert.equal(before.KZ!.status, 'pending');
  assert.equal(callCount(markers, 'analyze-a1'), 1);
  assert.equal(callCount(markers, 'analyze-a2'), 1);
  assert.equal(callCount(markers, 'analyze-a3'), 0);

  // «Перезапуск приложения»: новый оркестратор продолжает.
  const orch = new Orchestrator({ executors: t18Executors(markers) });
  const r = await orch.resume({ countries: T18_COUNTRIES, settings: settingsFor(ws) });
  assert.ok(r && r.ok);
  assert.equal(r.end, 'finished');
  assert.equal(r.runDir, found.dir);

  assert.equal(callCount(markers, 'collect-UZ'), 1, 'сбор не повторён');
  assert.equal(callCount(markers, 'triage-UZ'), 1, 'отбор не повторён');
  assert.equal(callCount(markers, 'analyze-a1'), 1, 'готовый акт не повторён');
  assert.equal(callCount(markers, 'analyze-a2'), 2, 'прерванный акт выполнен заново');
  assert.equal(callCount(markers, 'analyze-a3'), 1);
  assert.equal(callCount(markers, 'verify-UZ'), 1);
  assert.equal(callCount(markers, 'collect-KZ'), 1);
  assert.equal(callCount(markers, 'analyze-k1'), 1);

  const s = loadRun(found.dir);
  assert.ok(s.finished_at);
  assert.equal(s.countries.UZ!.status, 'changes');
  assert.equal(s.countries.KZ!.status, 'changes');
  assert.deepEqual(
    Object.fromEntries(Object.entries(s.countries.UZ!.acts).map(([k, v]) => [k, [v.analyze, v.verdict]])),
    { a1: ['done', 'confirmed'], a2: ['done', 'confirmed'], a3: ['done', 'confirmed'] },
  );
  assert.equal(findUnfinishedRun(ws), null);
});
