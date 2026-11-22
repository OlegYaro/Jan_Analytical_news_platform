import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildClaudeEnv,
  findClaude,
  loginShellEnv,
  parseEnvOutput,
  runClaude,
  stripClaudeEnv,
} from './env.ts';
import type { RunFn } from './env.ts';

test('stripClaudeEnv: вырезает CLAUDE_* и CLAUDECODE, остальное не трогает', () => {
  const out = stripClaudeEnv({
    PATH: '/usr/bin',
    HOME: '/Users/x',
    CLAUDECODE: '1',
    CLAUDE_CODE_CHILD_SESSION: '1',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CONFIG_DIR: '/tmp/c',
    MY_CLAUDE_VAR: 'keep',
    CLAUDE: 'keep-too',
    CLAUDECODE_X: 'keep-also',
    EMPTY: undefined,
  });
  assert.deepEqual(out, {
    PATH: '/usr/bin',
    HOME: '/Users/x',
    MY_CLAUDE_VAR: 'keep',
    CLAUDE: 'keep-too',
    CLAUDECODE_X: 'keep-also',
  });
});

test('buildClaudeEnv: вырезает из переданного окружения', async () => {
  const out = await buildClaudeEnv({ PATH: '/bin', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDECODE: '1' });
  assert.deepEqual(out, { PATH: '/bin' });
});

const ENV_DUMP = [
  'PATH=/opt/homebrew/bin:/usr/bin:/bin',
  'MULTI=line one',
  'line two with = sign',
  '  indented continuation',
  'HOME=/Users/x',
  'EMPTY=',
  'WITH_EQ=a=b=c',
  '1BAD=no',
  '',
].join('\n');

test('parseEnvOutput: многострочное значение не ломает разбор', () => {
  assert.deepEqual(parseEnvOutput(ENV_DUMP), {
    PATH: '/opt/homebrew/bin:/usr/bin:/bin',
    MULTI: 'line one',
    HOME: '/Users/x',
    EMPTY: '',
    WITH_EQ: 'a=b=c',
  });
});

test('loginShellEnv: запускает $SHELL -ilc env с таймаутом 5 с и разбирает вывод', async () => {
  const calls: { bin: string; args: readonly string[]; timeoutMs?: number }[] = [];
  const run: RunFn = async (bin, args, opts) => {
    calls.push({ bin, args, timeoutMs: opts?.timeoutMs });
    return { code: 0, stdout: `zsh: some noise\n${ENV_DUMP}`, stderr: '', timedOut: false };
  };
  const env = await loginShellEnv({ shell: '/bin/zsh', run });
  assert.deepEqual(calls, [{ bin: '/bin/zsh', args: ['-ilc', 'env'], timeoutMs: 5000 }]);
  assert.equal(env['PATH'], '/opt/homebrew/bin:/usr/bin:/bin');
  assert.equal(env['MULTI'], 'line one');
});

test('loginShellEnv: при ошибке, таймауте или пустом выводе — фолбэк', async () => {
  const fallback = { PATH: '/fallback', X: '1' };
  const throwing: RunFn = async () => {
    throw new Error('boom');
  };
  assert.deepEqual(await loginShellEnv({ run: throwing, fallback }), fallback);

  const timedOut: RunFn = async () => ({ code: null, stdout: 'PATH=/partial\n', stderr: '', timedOut: true });
  assert.deepEqual(await loginShellEnv({ run: timedOut, fallback }), fallback);

  const noSpawn: RunFn = async () => ({ code: null, stdout: '', stderr: '', timedOut: false, spawnError: 'ENOENT' });
  assert.deepEqual(await loginShellEnv({ run: noSpawn, fallback }), fallback);

  const empty: RunFn = async () => ({ code: 1, stdout: 'garbage\n', stderr: 'err', timedOut: false });
  assert.deepEqual(await loginShellEnv({ run: empty, fallback }), fallback);
});

test('loginShellEnv: несуществующая оболочка → process.env', async () => {
  const env = await loginShellEnv({ shell: '/nonexistent/shell-xyz' });
  assert.equal(env['PATH'], process.env['PATH']);
});

test('findClaude: порядок поиска', () => {
  const home = '/Users/u';
  const env = { PATH: '/a/bin:/b/bin' };
  const all = new Set([
    '/custom/claude',
    '/b/bin/claude',
    '/Users/u/.claude/local/claude',
    '/Users/u/.local/bin/claude',
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    '/Users/u/.npm-global/bin/claude',
  ]);
  const order: string[] = [];
  const set = new Set(all);
  const exists = (p: string): boolean => set.has(p);

  // Снимаем найденный путь и ищем снова — получаем полный порядок.
  for (;;) {
    const found = findClaude({ configured: '/custom/claude', env, home, exists });
    if (!found) break;
    order.push(found);
    set.delete(found);
  }
  assert.deepEqual(order, [
    '/custom/claude',
    '/b/bin/claude',
    '/Users/u/.claude/local/claude',
    '/Users/u/.local/bin/claude',
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    '/Users/u/.npm-global/bin/claude',
  ]);
});

test('findClaude: путь из настройки с ~, несуществующий путь пропускается', () => {
  const home = '/Users/u';
  const exists = (p: string): boolean => p === '/Users/u/tools/claude' || p === '/usr/local/bin/claude';
  assert.equal(findClaude({ configured: '~/tools/claude', env: { PATH: '' }, home, exists }), '/Users/u/tools/claude');
  assert.equal(findClaude({ configured: '/missing/claude', env: { PATH: '' }, home, exists }), '/usr/local/bin/claude');
  assert.equal(findClaude({ configured: null, env: {}, home, exists: () => false }), null);
});

function fakeBin(dir: string, name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

test('runClaude: stdin = /dev/null, вывод, код выхода, окружение и cwd', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rw-env-'));
  try {
    const bin = fakeBin(
      dir,
      'fake-claude',
      [
        'if [ -c /dev/stdin ]; then echo "stdin=null"; else echo "stdin=other"; fi',
        'cat', // с открытым stdin повисло бы до таймаута
        'echo "arg=$1 var=$RW_TEST pwd=$(pwd -P)"',
        'echo "to stderr" >&2',
        'exit 3',
      ].join('\n'),
    );
    const started = Date.now();
    const res = await runClaude(bin, ['hello'], {
      env: { PATH: '/usr/bin:/bin', RW_TEST: 'x1' },
      cwd: dir,
      timeoutMs: 5000,
    });
    assert.ok(Date.now() - started < 3000, 'не ждал stdin');
    assert.equal(res.code, 3);
    assert.equal(res.timedOut, false);
    assert.match(res.stdout, /^stdin=null$/m);
    assert.match(res.stdout, /arg=hello var=x1 pwd=.*rw-env-/);
    assert.equal(res.stderr.trim(), 'to stderr');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runClaude: таймаут убивает процесс вместе с потомками', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rw-env-'));
  try {
    const bin = fakeBin(dir, 'slow', 'echo started\nsleep 30\necho never');
    const started = Date.now();
    const res = await runClaude(bin, [], { timeoutMs: 1500 });
    const elapsed = Date.now() - started;
    assert.equal(res.timedOut, true);
    assert.equal(res.code, null);
    assert.match(res.stdout, /started/);
    assert.doesNotMatch(res.stdout, /never/);
    assert.ok(elapsed < 6000, `завершился за ${elapsed} мс`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runClaude: нет такого файла → spawnError', async () => {
  const res = await runClaude('/nonexistent/claude-xyz', []);
  assert.equal(res.code, null);
  assert.equal(res.spawnError, 'ENOENT');
});
