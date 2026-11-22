import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRateLimitEvent, runStage, schemaRetrySuffix } from './claude-runner.ts';
import type { ValidateFn } from './claude-runner.ts';
import { buildStageInvocation } from './stage-profiles.ts';
import type { StageInvocation } from './stage-profiles.ts';

// Фейковый claude: поведение задаёт FAKE_SCENARIO, номер попытки — по числу файлов call-*.json.
const FAKE = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const dir = process.env.FAKE_DIR;
const n = fs.readdirSync(dir).filter((f) => f.startsWith('call-')).length + 1;
const args = process.argv.slice(2);
fs.writeFileSync(path.join(dir, 'call-' + n + '.json'), JSON.stringify({ args, cwd: process.cwd(), env: Object.keys(process.env) }));
const out = (o) => process.stdout.write((typeof o === 'string' ? o : JSON.stringify(o)) + '\n');
const init = { type: 'system', subtype: 'init', tools: ['Read'] };
const usage = { input_tokens: 10, output_tokens: 5 };
const modelUsage = { 'claude-haiku': { inputTokens: 10, outputTokens: 5, costUSD: 0.001 } };
const result = (extra) => ({ type: 'result', subtype: 'success', is_error: false, num_turns: 2, usage, modelUsage, total_cost_usd: 0.001, permission_denials: [], ...extra });
const rl = (status, reset) => ({ type: 'rate_limit_event', rate_limit_info: { status, resetsAt: reset, rateLimitType: 'five_hour', overageStatus: 'rejected',
  unifiedWindows: { five_hour: { utilization: status === 'allowed' ? 0.42 : 1, resetsAt: reset, status }, seven_day: { utilization: 0.3, resetsAt: reset + 1000, status: 'allowed' } } } });
const sc = process.env.FAKE_SCENARIO;
if (sc === 'ok') {
  out(init); out(rl('allowed', 1794954600));
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo x' } }] } });
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: '<tool_use_error>Error: No such tool available: Bash.</tool_use_error>' }] } });
  out(result({ structured_output: { answer: 'yes' }, permission_denials: [{ tool_name: 'WebFetch', tool_input: { url: 'https://example.com' } }] }));
} else if (sc === 'schema-then-ok') {
  out(init);
  const fixed = args[1].includes('rejected by the schema check: /answer must be string. Return a corrected answer.');
  out(result({ structured_output: n === 1 ? { answer: 1 } : fixed ? { answer: 'fixed' } : { answer: 2 } }));
} else if (sc === 'schema-always') {
  out(init); out(result({ structured_output: { answer: 1 } }));
} else if (sc === 'no-result') {
  out(init);
} else if (sc === 'hang') {
  const c = spawn('sleep', ['30'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'pids-' + n + '.json'), JSON.stringify([process.pid, c.pid]));
  out(init);
  setInterval(() => out({ type: 'system', subtype: 'thinking_tokens' }), 100);
} else if (sc === 'silent') {
  setInterval(() => {}, 1000);
} else if (sc === 'limit') {
  out(init); out(rl('rejected', 1794954600));
  out(result({ is_error: true, result: "You've hit your usage limit", num_turns: 1 }));
  process.exitCode = 1;
} else if (sc === 'max-turns') {
  out(init); out(result({ subtype: 'error_max_turns', is_error: true, result: '' }));
  process.exitCode = 1;
} else if (sc === 'garbage') {
  out('not json at all'); out('{"type":"system","subtype":"init"'); out('');
  out('[1,2,3]'); out('null');
  const line = JSON.stringify(result({ structured_output: { answer: 'parsed' } }));
  process.stdout.write('garbage-without-newline-then\n' + line.slice(0, 40));
  setTimeout(() => process.stdout.write(line.slice(40)), 50);
}
`;

let root: string;
let bin: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'rw-runner-'));
  bin = join(root, 'fake-claude.cjs');
  writeFileSync(bin, `#!${process.execPath}\n${FAKE}`);
  chmodSync(bin, 0o755);
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

const validate: ValidateFn = (data) => {
  const d = data as { answer?: unknown } | null;
  return d && typeof d.answer === 'string' ? { ok: true } : { ok: false, error: '/answer must be string' };
};

function invocation(timeoutMs = 30_000): StageInvocation {
  const inv = buildStageInvocation({
    stage: 'triage',
    settings: { preset: 'economy', advanced: { stageModels: {}, timeoutsMin: {}, firstRunDays: 30, saveTranscripts: false, claudePath: '' } },
    countryDir: root,
    inputPath: join(root, 'input.json'),
    schemaJson: '{"type":"object"}',
  });
  return { ...inv, timeoutMs };
}

function scenario(name: string): { dir: string; env: Record<string, string> } {
  const dir = mkdtempSync(join(root, `${name}-`));
  return { dir, env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', FAKE_DIR: dir, FAKE_SCENARIO: name } };
}

function calls(dir: string): { args: string[]; cwd: string; env: string[] }[] {
  return readdirSync(dir)
    .filter((f) => f.startsWith('call-'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitDead(pid: number, ms = 4000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !alive(pid);
}

test('успех: structured_output валиден, учёт, лимит, отказы, транскрипт, события', async () => {
  const { dir, env } = scenario('ok');
  const transcriptPath = join(dir, 'sub', 'transcript.jsonl');
  const events: string[] = [];
  const r = await runStage({ invocation: invocation(), bin, env, validate, transcriptPath, onEvent: (e) => events.push(String(e['type'])) });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.output, { answer: 'yes' });
  assert.equal(r.attempts, 1);
  assert.equal(r.exitCode, 0);
  assert.equal(r.costUsd, 0.001);
  assert.deepEqual(r.usage, { input_tokens: 10, output_tokens: 5 });
  assert.ok(r.modelUsage && 'claude-haiku' in r.modelUsage);
  assert.equal(r.numTurns, 2);
  assert.equal(r.rateLimit?.utilization, 0.42);
  assert.equal(r.rateLimit?.status, 'allowed');
  assert.equal(r.rateLimit?.resetsAt, new Date(1794954600 * 1000).toISOString());
  // Недельное окно — для бюджета (budget.ts): доля и сброс.
  assert.equal(r.rateLimit?.sevenDay?.utilization, 0.3);
  assert.equal(r.rateLimit?.sevenDay?.resetsAt, new Date((1794954600 + 1000) * 1000).toISOString());
  assert.deepEqual(r.denied, [
    { tool: 'WebFetch', input: { url: 'https://example.com' }, kind: 'permission' },
    { tool: 'Bash', input: { command: 'echo x' }, kind: 'no_tool' },
  ]);
  assert.deepEqual(events, ['system', 'rate_limit_event', 'assistant', 'user', 'result']);
  const lines = readFileSync(transcriptPath, 'utf8').trim().split('\n');
  assert.equal(lines.length, 5);
  const c = calls(dir);
  assert.equal(c.length, 1);
  // cwd по умолчанию — invocation.cwd; окружение передано как есть.
  assert.equal(c[0]!.cwd, realpathSync(invocation().cwd));
  assert.ok(c[0]!.env.includes('FAKE_SCENARIO'));
  assert.deepEqual(c[0]!.args, invocation().args);
});

test('невалидная схема → повтор с текстом ошибки в промпте → успех', async () => {
  const { dir, env } = scenario('schema-then-ok');
  const r = await runStage({ invocation: invocation(), bin, env, validate });
  assert.equal(r.ok, true, JSON.stringify(r));
  if (!r.ok) return;
  assert.deepEqual(r.output, { answer: 'fixed' });
  assert.equal(r.attempts, 2);
  const c = calls(dir);
  assert.equal(c.length, 2);
  assert.equal(c[0]!.args[1], invocation().prompt);
  assert.equal(c[1]!.args[1], invocation().prompt + schemaRetrySuffix('/answer must be string'));
  assert.deepEqual(c[1]!.args.slice(2), invocation().args.slice(2));
});

test('дважды невалидно → failure schema', async () => {
  const { dir, env } = scenario('schema-always');
  const r = await runStage({ invocation: invocation(), bin, env, validate });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.failure, 'schema');
  assert.equal(r.attempts, 2);
  assert.match(r.message, /\/answer must be string/);
  assert.equal(calls(dir).length, 2);
});

test('нет события result → 1 повтор → no_result', async () => {
  const { dir, env } = scenario('no-result');
  const r = await runStage({ invocation: invocation(), bin, env, validate });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.failure, 'no_result');
  assert.equal(r.attempts, 2);
  const c = calls(dir);
  assert.equal(c.length, 2);
  // Повтор без хвоста про схему.
  assert.equal(c[1]!.args[1], invocation().prompt);
});

test('T-13: зависший процесс → таймаут этапа, группа убита, ровно 2 попытки, failure timeout', async () => {
  const { dir, env } = scenario('hang');
  const t0 = Date.now();
  const r = await runStage({ invocation: invocation(1000), bin, env, validate, watchdogMs: 60_000 });
  const elapsed = Date.now() - t0;
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.failure, 'timeout');
  assert.equal(r.attempts, 2);
  assert.equal(calls(dir).length, 2);
  // 2 × (1 с таймаут + до 1 с ожидания выхода) + запуск; щедрый допуск.
  assert.ok(elapsed >= 2000 && elapsed < 9000, `elapsed ${elapsed}`);
  for (const n of [1, 2]) {
    const pids = JSON.parse(readFileSync(join(dir, `pids-${n}.json`), 'utf8')) as number[];
    for (const pid of pids) assert.ok(await waitDead(pid), `процесс ${pid} (попытка ${n}) жив`);
  }
});

test('сторож: молчащий процесс при watchdogMs=500 → убит, 2 попытки, timeout', async () => {
  const { dir, env } = scenario('silent');
  const t0 = Date.now();
  const r = await runStage({ invocation: invocation(60_000), bin, env, validate, watchdogMs: 500 });
  const elapsed = Date.now() - t0;
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.failure, 'timeout');
  assert.match(r.message, /не отвечал/);
  assert.equal(r.attempts, 2);
  assert.equal(calls(dir).length, 2);
  assert.ok(elapsed < 8000, `elapsed ${elapsed}`);
});

test('лимит: rate_limit_event rejected + is_error → limit с resetsAt, 1 попытка', async () => {
  const { dir, env } = scenario('limit');
  const r = await runStage({ invocation: invocation(), bin, env, validate });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.failure, 'limit');
  assert.equal(r.attempts, 1);
  assert.equal(r.resetsAt, new Date(1794954600 * 1000).toISOString());
  assert.equal(r.rateLimit?.utilization, 1);
  assert.equal(r.exitCode, 1);
  assert.equal(calls(dir).length, 1);
});

test('error_max_turns → max_turns без повтора', async () => {
  const { dir, env } = scenario('max-turns');
  const r = await runStage({ invocation: invocation(), bin, env, validate });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.failure, 'max_turns');
  assert.equal(r.attempts, 1);
  assert.equal(r.exitCode, 1);
  assert.equal(calls(dir).length, 1);
});

test('мусорные и обрезанные строки не ломают разбор; событие по кускам', async () => {
  const { env } = scenario('garbage');
  const r = await runStage({ invocation: invocation(), bin, env, validate });
  assert.equal(r.ok, true, JSON.stringify(r));
  if (r.ok) assert.deepEqual(r.output, { answer: 'parsed' });
});

test('нет бинаря → spawn, 1 попытка', async () => {
  const { env } = scenario('ok');
  const r = await runStage({ invocation: invocation(), bin: join(root, 'no-such-claude'), env, validate });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.failure, 'spawn');
  assert.equal(r.attempts, 1);
  assert.match(r.message, /ENOENT/);
});

test('spawn бросает синхронно → spawn', async () => {
  const r = await runStage({
    invocation: invocation(),
    bin,
    env: {},
    validate,
    spawn: () => {
      throw Object.assign(new Error('boom'), { code: 'EACCES' });
    },
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.failure, 'spawn');
});

test('parseRateLimitEvent: overageStatus rejected и allowed_warning — не лимит', () => {
  const ev = (status: string) => ({
    type: 'rate_limit_event',
    rate_limit_info: { status, resetsAt: 1794954600, overageStatus: 'rejected', unifiedWindows: { five_hour: { utilization: 0.9, resetsAt: 1794954600, status } } },
  });
  assert.equal(parseRateLimitEvent(ev('allowed')).rejected, false);
  assert.equal(parseRateLimitEvent(ev('allowed_warning')).rejected, false);
  const r = parseRateLimitEvent(ev('rejected'));
  assert.equal(r.rejected, true);
  assert.equal(r.resetsAt, new Date(1794954600 * 1000).toISOString());
  // Отказ по 7-дневному окну — тоже лимит, сброс по нему.
  const w = parseRateLimitEvent({
    rate_limit_info: { unifiedWindows: { five_hour: { status: 'allowed', resetsAt: 1 }, seven_day: { status: 'rejected', resetsAt: 1795125600 } } },
  });
  assert.equal(w.rejected, true);
  assert.equal(w.resetsAt, new Date(1795125600 * 1000).toISOString());
  assert.deepEqual(w.info.sevenDay, { resetsAt: new Date(1795125600 * 1000).toISOString(), status: 'rejected' });
});

test('parseRateLimitEvent: доли 5-часового и недельного окон (для бюджета)', () => {
  const p = parseRateLimitEvent({
    rate_limit_info: {
      status: 'allowed_warning',
      unifiedWindows: { five_hour: { utilization: 0.83, resetsAt: 1794954600, status: 'allowed_warning' }, seven_day: { utilization: 0.97, resetsAt: 1795125600, status: 'allowed' } },
    },
  });
  assert.equal(p.rejected, false);
  assert.deepEqual(p.info, {
    status: 'allowed_warning',
    utilization: 0.83,
    resetsAt: new Date(1794954600 * 1000).toISOString(),
    sevenDay: { utilization: 0.97, resetsAt: new Date(1795125600 * 1000).toISOString(), status: 'allowed' },
  });
});
