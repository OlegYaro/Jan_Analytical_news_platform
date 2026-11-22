import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DoctorCheck } from '../shared/doctor-types.ts';
import { helpHasFlag, parseResultEvent, runDoctor } from './doctor.ts';
import type { DoctorDeps, DoctorFs } from './doctor.ts';
import type { RunFn, RunResult } from './env.ts';

const HELP_OK = `Usage: claude [options] [command] [prompt]

Options:
  --allowedTools, --allowed-tools <tools...>
  --disallowedTools, --disallowed-tools <tools...>
  --json-schema <schema>                JSON Schema for structured output
  --model <model>                       Model for the current session
  --no-session-persistence              Don't save sessions to disk
  --output-format <format>              Output format (only works with --print)
  --permission-mode <mode>              Permission mode to use for the session
  --setting-sources <sources>           Comma-separated list of setting sources
  --strict-mcp-config                   Only use MCP servers from --mcp-config
  --tools <tools...>                    Built-in tools to make available
`;

const LOGIN_OK = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 1401,
  result: 'OK',
});

const LOGIN_FAIL = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: true,
  result: 'Not logged in · Please run /login',
});

const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '', timedOut: false });

interface Scenario {
  help?: string;
  login?: RunResult;
  claude?: string | null;
  fs?: Partial<DoctorFs>;
}

function makeDeps(s: Scenario = {}): { deps: Partial<DoctorDeps>; calls: string[][]; files: string[] } {
  const calls: string[][] = [];
  const files: string[] = [];
  const run: RunFn = async (bin, args) => {
    calls.push([bin, ...args]);
    if (args[0] === '--version') return ok('2.1.326 (Claude Code)\n');
    if (args[0] === '--help') return ok(s.help ?? HELP_OK);
    if (args[0] === '-p') return s.login ?? ok(LOGIN_OK);
    throw new Error('unexpected call');
  };
  const fs: DoctorFs = {
    mkdir: async () => undefined,
    writeFile: async (p) => {
      files.push(p);
    },
    unlink: async (p) => {
      files.splice(files.indexOf(p), 1);
    },
    ...s.fs,
  };
  return {
    deps: {
      run,
      fs,
      buildEnv: async () => ({ PATH: '/usr/bin' }),
      findClaude: () => (s.claude === undefined ? '/Users/u/.local/bin/claude' : s.claude),
    },
    calls,
    files,
  };
}

const ORDER: DoctorCheck['id'][] = [
  'node',
  'claude-found',
  'claude-version',
  'claude-login',
  'claude-flags',
  'workspace-write',
];

function byId(checks: DoctorCheck[], id: DoctorCheck['id']): DoctorCheck {
  const c = checks.find((x) => x.id === id);
  assert.ok(c, id);
  return c;
}

/** Тексты для пользователя: по-русски, без технических терминов и стектрейсов. */
function assertUserFriendly(checks: DoctorCheck[]): void {
  for (const c of checks) {
    const text = `${c.title} ${c.detail} ${c.fix}`;
    assert.doesNotMatch(text, /\bJSON\b|\bCLI\b|токен|Error|\n\s+at /, text);
    if (!c.ok) assert.ok(c.fix.length > 0, `нет «что делать» у ${c.id}`);
    else assert.equal(c.fix, '');
  }
}

test('всё зелёное', async () => {
  const { deps, calls, files } = makeDeps();
  const checks = await runDoctor({ workspaceDir: '/ws', nodeVersion: 'v24.15.0', deps });
  assert.deepEqual(checks.map((c) => c.id), ORDER);
  assert.ok(checks.every((c) => c.ok), JSON.stringify(checks, null, 1));
  assert.match(byId(checks, 'claude-version').detail, /2\.1\.326/);
  assert.equal(byId(checks, 'claude-found').detail, '/Users/u/.local/bin/claude');
  assertUserFriendly(checks);
  assert.equal(files.length, 0, 'временный файл удалён');

  const login = calls.find((c) => c[1] === '-p');
  assert.ok(login);
  const args = login.slice(1);
  const after = (f: string): string | undefined => args[args.indexOf(f) + 1];
  assert.equal(after('-p'), 'Reply with OK');
  assert.equal(after('--model'), 'haiku');
  assert.equal(after('--output-format'), 'json');
  assert.equal(after('--tools'), '');
  assert.equal(after('--setting-sources'), 'project');
  assert.equal(after('--permission-mode'), 'dontAsk');
  assert.ok(args.includes('--strict-mcp-config'));
});

test('старый Node', async () => {
  const { deps } = makeDeps();
  for (const v of ['v20.11.1', 'v22.17.0']) {
    const checks = await runDoctor({ workspaceDir: '/ws', nodeVersion: v, deps });
    const node = byId(checks, 'node');
    assert.equal(node.ok, false);
    assert.match(node.fix, /Скачайте установщик с nodejs\.org \(LTS\)/);
    assert.equal(node.link, 'https://nodejs.org');
    assertUserFriendly(checks);
  }
  const fresh = await runDoctor({ workspaceDir: '/ws', nodeVersion: 'v22.18.0', deps });
  assert.equal(byId(fresh, 'node').ok, true);
});

test('claude не найден: зависимые проверки ❌ «нет Claude Code», без запусков', async () => {
  const { deps, calls } = makeDeps({ claude: null });
  const checks = await runDoctor({ workspaceDir: '/ws', nodeVersion: 'v24.15.0', deps });
  assert.deepEqual(checks.map((c) => c.id), ORDER);
  const found = byId(checks, 'claude-found');
  assert.equal(found.ok, false);
  assert.match(found.fix, /npm install -g @anthropic-ai\/claude-code/);
  assert.match(found.fix, /claude/);
  for (const id of ['claude-version', 'claude-login', 'claude-flags'] as const) {
    const c = byId(checks, id);
    assert.equal(c.ok, false);
    assert.equal(c.detail, 'нет Claude Code');
  }
  assert.equal(byId(checks, 'workspace-write').ok, true);
  assert.equal(calls.length, 0);
  assertUserFriendly(checks);
});

test('вход не выполнен (is_error)', async () => {
  const { deps } = makeDeps({ login: { code: 1, stdout: LOGIN_FAIL, stderr: '', timedOut: false } });
  const checks = await runDoctor({ workspaceDir: '/ws', nodeVersion: 'v24.15.0', deps });
  const login = byId(checks, 'claude-login');
  assert.equal(login.ok, false);
  assert.match(login.fix, /Откройте Терминал, наберите claude и войдите в аккаунт/);
  assert.equal(byId(checks, 'claude-flags').ok, true);
  assertUserFriendly(checks);
});

test('ответ с is_error, даже если в тексте есть OK, — не зелёный', async () => {
  const stdout = JSON.stringify({ type: 'result', is_error: true, result: 'OK but error' });
  const { deps } = makeDeps({ login: { code: 1, stdout, stderr: '', timedOut: false } });
  const checks = await runDoctor({ workspaceDir: '/ws', nodeVersion: 'v24.15.0', deps });
  assert.equal(byId(checks, 'claude-login').ok, false);
});

test('нет обязательного флага', async () => {
  const help = HELP_OK.replace(/^.*--json-schema.*\n/m, '').replace(/^.*--strict-mcp-config.*\n/m, '');
  const { deps, calls } = makeDeps({ help });
  const checks = await runDoctor({ workspaceDir: '/ws', nodeVersion: 'v24.15.0', deps });
  const flags = byId(checks, 'claude-flags');
  assert.equal(flags.ok, false);
  assert.match(flags.detail, /--json-schema/);
  assert.match(flags.detail, /--strict-mcp-config/);
  assert.match(flags.fix, /Обновите Claude Code: .*claude update/);
  // Неизвестный старой версии флаг не передаётся в проверку входа.
  const login = calls.find((c) => c[1] === '-p');
  assert.ok(login && !login.includes('--strict-mcp-config'));
  assert.equal(byId(checks, 'claude-login').ok, true);
  assertUserFriendly(checks);
});

test('папка не пишется', async () => {
  const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
  const { deps } = makeDeps({
    fs: {
      writeFile: async () => {
        throw denied;
      },
    },
  });
  const checks = await runDoctor({ workspaceDir: '/locked', nodeVersion: 'v24.15.0', deps });
  const ws = byId(checks, 'workspace-write');
  assert.equal(ws.ok, false);
  assert.match(ws.detail, /нет прав на запись: \/locked/);
  assert.doesNotMatch(ws.detail, /EACCES/);
  assertUserFriendly(checks);
});

test('helpHasFlag: флаг целиком, а не часть другого', () => {
  assert.equal(helpHasFlag('  --allowedTools <tools...>', '--tools'), false);
  assert.equal(helpHasFlag('  --tools-extra <x>', '--tools'), false);
  assert.equal(helpHasFlag('  --tools <tools...>', '--tools'), true);
  assert.equal(helpHasFlag('  --allowedTools, --allowed-tools <tools...>', '--allowedTools'), true);
});

test('parseResultEvent: объект, массив событий, мусор', () => {
  assert.equal(parseResultEvent(LOGIN_OK)?.['result'], 'OK');
  const arr = JSON.stringify([{ type: 'system' }, { type: 'result', result: 'OK' }]);
  assert.equal(parseResultEvent(arr)?.['result'], 'OK');
  assert.equal(parseResultEvent(`noise\n${LOGIN_OK}\n`)?.['result'], 'OK');
  assert.equal(parseResultEvent('not json'), null);
});
