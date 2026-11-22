import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectInsideRegWatch } from './inside-check.mjs';

// Цепочка: pid → { ppid, comm }.
function chain(map) {
  return (pid) => map[pid] ?? null;
}

const normal = chain({
  500: { ppid: 400, comm: '/opt/homebrew/bin/node' },
  400: { ppid: 300, comm: '-zsh' },
  300: { ppid: 1, comm: '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal' },
});

test('обычный запуск из Терминала → false', () => {
  assert.equal(detectInsideRegWatch({ env: {}, versions: { node: '24.0.0' }, getParent: normal, pid: 500 }), false);
});

test('ELECTRON_RUN_AS_NODE → true', () => {
  assert.equal(
    detectInsideRegWatch({ env: { ELECTRON_RUN_AS_NODE: '1' }, versions: {}, getParent: normal, pid: 500 }),
    true,
  );
});

test('versions.electron → true', () => {
  assert.equal(
    detectInsideRegWatch({ env: {}, versions: { electron: '45.3.4' }, getParent: normal, pid: 500 }),
    true,
  );
});

test('предок в /Applications/RegWatch.app → true', () => {
  const getParent = chain({
    500: { ppid: 400, comm: 'node' },
    400: { ppid: 300, comm: '/bin/zsh' },
    300: { ppid: 1, comm: '/Applications/RegWatch.app/Contents/MacOS/RegWatch' },
  });
  assert.equal(detectInsideRegWatch({ env: {}, versions: {}, getParent, pid: 500 }), true);
});

test('предок в ~/Applications/RegWatch.app → true', () => {
  const getParent = chain({
    500: { ppid: 400, comm: 'node' },
    400: { ppid: 1, comm: '/Users/test/Applications/RegWatch.app/Contents/MacOS/RegWatch' },
  });
  assert.equal(detectInsideRegWatch({ env: {}, versions: {}, getParent, pid: 500 }), true);
});

test('цепочка длиннее 20 уровней → false без падения', () => {
  // RegWatch на 25-м уровне — за пределом поиска.
  const getParent = (pid) =>
    pid === 1000 + 25
      ? { ppid: 1, comm: '/Applications/RegWatch.app/Contents/MacOS/RegWatch' }
      : { ppid: pid + 1, comm: 'sh' };
  assert.equal(detectInsideRegWatch({ env: {}, versions: {}, getParent, pid: 1000 }), false);
});

test('цикл в цепочке → false без зависания', () => {
  const getParent = chain({
    500: { ppid: 400, comm: 'node' },
    400: { ppid: 500, comm: 'sh' },
  });
  assert.equal(detectInsideRegWatch({ env: {}, versions: {}, getParent, pid: 500 }), false);
});
