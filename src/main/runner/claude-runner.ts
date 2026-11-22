// Запуск одного этапа `claude -p` (docs/02 §7): сторож, таймаут, разбор stream-json, проверка
// схемы, повтор, учёт токенов и лимита. Без импорта electron.
//
// Политика повторов (COV-03, PRM-07): всего не больше 2 попыток.
// - невалидный structured_output → повтор с текстом ошибки схемы в промпте → `schema`;
// - нет результата (процесс вышел без события result, ошибка выполнения, нет structured_output)
//   → повтор → `no_result`;
// - таймаут этапа или сторож (нет событий watchdogMs) → группа процессов убита → повтор → `timeout`;
// - `error_max_turns` → сразу `max_turns`, без повтора: те же вход, скилл и лимит ходов почти
//   наверняка снова упрутся в лимит, а повтор удвоит расход. Решение о повторе с бо́льшим лимитом
//   принимает оркестратор, а не этот модуль;
// - лимит подписки → сразу `limit` с `resetsAt`: повтор до сброса бессмыслен (docs/02 §8);
// - бинарь не запустился → сразу `spawn`.
// Отказы разрешений (permission_denials) — не ошибка: возвращаются в `denied` для лога.
// Окружение и секреты никуда не пишутся: в транскрипт идёт только stdout claude.

import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { StageInvocation } from './stage-profiles.ts';
import { withPromptSuffix } from './stage-profiles.ts';

export type ValidateFn = (data: unknown) => { ok: true } | { ok: false; error: string };

export type SpawnFn = (bin: string, args: readonly string[], opts: SpawnOptions) => ChildProcess;

/** Причина провала. `denied` runStage сам не выдаёт (отказ разрешения — не ошибка, см. `denied`
 * в результате); значение оставлено для оркестратора, если тот решит провалить этап по отказам. */
export type StageFailure = 'timeout' | 'schema' | 'no_result' | 'limit' | 'max_turns' | 'spawn' | 'denied';

/** Сведения о 5-часовом окне из `rate_limit_event`. */
export interface RateLimitInfo {
  /** Статус окна (`allowed`, `allowed_warning`, `rejected`…). */
  status?: string;
  /** Доля использованного 5-часового окна, 0..1. */
  utilization?: number;
  /** Время сброса, ISO. */
  resetsAt?: string;
  /** Недельное окно (`unifiedWindows.seven_day`): доля 0..1 и время сброса (ISO). */
  sevenDay?: { utilization?: number; resetsAt?: string; status?: string };
}

/** Отказ: инструмент и его вход. `kind`: `permission` — из permission_denials (правило не
 * разрешило), `no_tool` — модель вызвала инструмент, которого нет в сессии (так CLI отказывает в
 * Bash/Write, не выданных через --tools; в permission_denials это не попадает — T-12). */
export interface PermissionDenial {
  tool: string;
  input: unknown;
  kind: 'permission' | 'no_tool';
}

export interface StageSuccess {
  ok: true;
  output: unknown;
  usage: Record<string, unknown> | null;
  modelUsage: Record<string, unknown> | null;
  costUsd: number | null;
  /** Суммарная длительность всех попыток, мс. */
  durationMs: number;
  attempts: number;
  exitCode: number | null;
  numTurns?: number;
  rateLimit?: RateLimitInfo;
  denied: PermissionDenial[];
}

export interface StageError {
  ok: false;
  failure: StageFailure;
  /** Понятное сообщение по-русски (для лога и экрана). */
  message: string;
  attempts: number;
  durationMs: number;
  exitCode: number | null;
  /** Для `limit`: когда снимется ограничение, ISO. */
  resetsAt?: string;
  usage?: Record<string, unknown> | null;
  modelUsage?: Record<string, unknown> | null;
  costUsd?: number | null;
  rateLimit?: RateLimitInfo;
  denied: PermissionDenial[];
}

export type StageResult = StageSuccess | StageError;

export interface RunStageOptions {
  invocation: StageInvocation;
  bin: string;
  /** Окружение для claude (login shell без CLAUDE_*, см. env.ts buildClaudeEnv). */
  env: Record<string, string | undefined>;
  /** По умолчанию invocation.cwd. */
  cwd?: string;
  validate: ValidateFn;
  /** Куда дописывать сырые строки stdout (jsonl). */
  transcriptPath?: string;
  /** Каждое разобранное событие stream-json (для живого прогресса). */
  onEvent?: (event: Record<string, unknown>) => void;
  /** Сторож PRM-08: нет ни одного события столько мс → процесс зависший. По умолчанию 3 мин. */
  watchdogMs?: number;
  /** Пауза между SIGTERM и SIGKILL, мс. По умолчанию 2 с. */
  killGraceMs?: number;
  spawn?: SpawnFn;
}

/** Итог одной попытки. */
type Attempt =
  | { kind: 'ok'; output: unknown; result: Record<string, unknown> }
  | { kind: 'schema'; error: string; result: Record<string, unknown> }
  | { kind: 'no_result'; message: string; result?: Record<string, unknown> }
  | { kind: 'timeout'; message: string; result?: Record<string, unknown> }
  | { kind: 'max_turns'; result: Record<string, unknown> }
  | { kind: 'limit'; message: string; resetsAt?: string; result?: Record<string, unknown> }
  | { kind: 'spawn'; message: string };

interface AttemptRaw {
  exitCode: number | null;
  spawnError?: string;
  timedOut: boolean;
  watchdog: boolean;
  /** Последнее событие result. */
  result?: Record<string, unknown>;
  rateLimit?: RateLimitInfo;
  /** Статус окна лимита «отказано». */
  limitRejected: boolean;
  limitResetsAt?: string;
  stderrTail: string;
  /** Вызовы отсутствующих инструментов (см. PermissionDenial.kind). */
  noTool: PermissionDenial[];
}

const NO_SUCH_TOOL = /No such tool available/i;

const LIMIT_TEXT =
  /(rate[ _-]?limit|usage limit|limit (?:reached|exceeded)|reached your .*limit|out of (?:extra )?usage|5-hour limit|weekly limit|resets? (?:at|in)\b)/i;

/** Хвост к промпту при повторе после ошибки схемы (английский — язык промптов). */
export function schemaRetrySuffix(error: string): string {
  return `\n\nYour previous answer was rejected by the schema check: ${error}. Return a corrected answer.`;
}

function unixToIso(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
    // Секунды или миллисекунды.
    const ms = v < 1e12 ? v * 1000 : v;
    return new Date(ms).toISOString();
  }
  if (typeof v === 'string' && v) {
    const n = Number(v);
    if (Number.isFinite(n)) return unixToIso(n);
    const d = Date.parse(v);
    if (!Number.isNaN(d)) return new Date(d).toISOString();
  }
  return undefined;
}

function isRejected(status: unknown): boolean {
  // `allowed` и `allowed_warning` — работать можно. Только явный отказ считается лимитом.
  // `overageStatus: "rejected"` встречается и при обычной работе — его не смотрим.
  return typeof status === 'string' && status !== '' && !status.startsWith('allowed');
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Разбор `rate_limit_event`: статус, 5-часовое окно, время сброса. */
export function parseRateLimitEvent(ev: Record<string, unknown>): { info: RateLimitInfo; rejected: boolean; resetsAt?: string } {
  const rli = asRecord(ev['rate_limit_info']) ?? {};
  const windows = asRecord(rli['unifiedWindows']) ?? {};
  const five = asRecord(windows['five_hour']) ?? {};
  const info: RateLimitInfo = {};
  const status = (rli['status'] ?? five['status']) as unknown;
  if (typeof status === 'string') info.status = status;
  if (typeof five['utilization'] === 'number') info.utilization = five['utilization'];
  const fiveReset = unixToIso(five['resetsAt']);
  if (fiveReset) info.resetsAt = fiveReset;
  const seven = asRecord(windows['seven_day']);
  if (seven) {
    const sd: NonNullable<RateLimitInfo['sevenDay']> = {};
    if (typeof seven['utilization'] === 'number') sd.utilization = seven['utilization'];
    const sr = unixToIso(seven['resetsAt']);
    if (sr) sd.resetsAt = sr;
    if (typeof seven['status'] === 'string') sd.status = seven['status'];
    if (Object.keys(sd).length) info.sevenDay = sd;
  }

  let rejected = isRejected(rli['status']);
  let resetsAt = rejected ? unixToIso(rli['resetsAt']) : undefined;
  // Любое окно (5 ч, 7 дней) в отказе — тоже лимит; сброс — по этому окну.
  for (const w of Object.values(windows)) {
    const wr = asRecord(w);
    if (wr && isRejected(wr['status'])) {
      rejected = true;
      resetsAt ??= unixToIso(wr['resetsAt']);
    }
  }
  if (rejected) resetsAt ??= unixToIso(rli['resetsAt']) ?? info.resetsAt;
  return { info, rejected, ...(resetsAt ? { resetsAt } : {}) };
}

function collectDenials(result: Record<string, unknown> | undefined, into: PermissionDenial[]): void {
  const list = result?.['permission_denials'];
  if (!Array.isArray(list)) return;
  for (const d of list) {
    const r = asRecord(d);
    if (!r) continue;
    into.push({ tool: String(r['tool_name'] ?? '?'), input: r['tool_input'] ?? null, kind: 'permission' });
  }
}

function contentBlocks(ev: Record<string, unknown>): Record<string, unknown>[] {
  const content = asRecord(ev['message'])?.['content'];
  return Array.isArray(content) ? content.map(asRecord).filter((b): b is Record<string, unknown> => b !== null) : [];
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (typeof asRecord(c)?.['text'] === 'string' ? (asRecord(c)!['text'] as string) : '')).join(' ');
  return '';
}

/** Классификация попытки по сырым данным. */
function classify(raw: AttemptRaw, validate: ValidateFn): Attempt {
  if (raw.spawnError) return { kind: 'spawn', message: `Не удалось запустить Claude Code (${raw.spawnError})` };
  const result = raw.result;
  if (raw.timedOut || raw.watchdog) {
    return {
      kind: 'timeout',
      message: raw.watchdog ? 'Claude Code не отвечал (нет событий) и был остановлен' : 'Этап не уложился во время и был остановлен',
      ...(result ? { result } : {}),
    };
  }
  if (result) {
    const subtype = String(result['subtype'] ?? '');
    const isError = result['is_error'] === true;
    const text = typeof result['result'] === 'string' ? result['result'] : '';
    if (subtype === 'error_max_turns') return { kind: 'max_turns', result };
    if (isError && (raw.limitRejected || result['api_error_status'] === 429 || LIMIT_TEXT.test(text))) {
      return { kind: 'limit', message: 'Исчерпан лимит подписки Claude', ...(raw.limitResetsAt ? { resetsAt: raw.limitResetsAt } : {}), result };
    }
    if (!isError && subtype === 'success') {
      if (!('structured_output' in result) || result['structured_output'] === undefined || result['structured_output'] === null) {
        return { kind: 'no_result', message: 'Claude Code не вернул ответ по схеме', result };
      }
      const v = validate(result['structured_output']);
      if (v.ok) return { kind: 'ok', output: result['structured_output'], result };
      return { kind: 'schema', error: v.error, result };
    }
    return { kind: 'no_result', message: `Claude Code завершился с ошибкой (${subtype || 'is_error'})`, result };
  }
  if (raw.limitRejected) {
    return { kind: 'limit', message: 'Исчерпан лимит подписки Claude', ...(raw.limitResetsAt ? { resetsAt: raw.limitResetsAt } : {}) };
  }
  if (LIMIT_TEXT.test(raw.stderrTail)) return { kind: 'limit', message: 'Исчерпан лимит подписки Claude' };
  return { kind: 'no_result', message: `Claude Code завершился без результата (код ${raw.exitCode ?? 'нет'})` };
}

/** Одна попытка: запуск, чтение stream-json, сторож и таймаут. */
function runOnce(o: {
  bin: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  timeoutMs: number;
  watchdogMs: number;
  killGraceMs: number;
  transcriptPath?: string;
  onEvent?: (e: Record<string, unknown>) => void;
  spawn: SpawnFn;
}): Promise<AttemptRaw> {
  return new Promise<AttemptRaw>((resolve) => {
    const raw: AttemptRaw = { exitCode: null, timedOut: false, watchdog: false, limitRejected: false, stderrTail: '', noTool: [] };
    const toolUses = new Map<string, { tool: string; input: unknown }>();
    let settled = false;
    let buf = '';
    let stageTimer: NodeJS.Timeout | undefined;
    let watchTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let exitGrace: NodeJS.Timeout | undefined;
    let child: ChildProcess;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(stageTimer);
      clearTimeout(watchTimer);
      clearTimeout(exitGrace);
      // killTimer не снимаем: если группу уже начали убивать, SIGKILL должен дойти до потомков.
      if (buf.trim()) handleLine(buf);
      buf = '';
      resolve(raw);
    };

    const writeTranscript = (line: string): void => {
      if (!o.transcriptPath) return;
      try {
        appendFileSync(o.transcriptPath, line + '\n', 'utf8');
      } catch {
        // транскрипт — вспомогательный, его ошибка не роняет этап
      }
    };

    const handleLine = (line: string): void => {
      if (!line.trim()) return;
      writeTranscript(line);
      let ev: unknown;
      try {
        ev = JSON.parse(line);
      } catch {
        return; // мусор или обрезанная строка
      }
      const e = asRecord(ev);
      if (!e) return;
      if (e['type'] === 'result') raw.result = e;
      else if (e['type'] === 'assistant') {
        for (const b of contentBlocks(e))
          if (b['type'] === 'tool_use' && typeof b['id'] === 'string') toolUses.set(b['id'], { tool: String(b['name'] ?? '?'), input: b['input'] ?? null });
      } else if (e['type'] === 'user') {
        for (const b of contentBlocks(e)) {
          if (b['type'] !== 'tool_result' || b['is_error'] !== true) continue;
          const use = toolUses.get(String(b['tool_use_id']));
          if (use && NO_SUCH_TOOL.test(resultText(b['content']))) raw.noTool.push({ ...use, kind: 'no_tool' });
        }
      } else if (e['type'] === 'rate_limit_event') {
        const p = parseRateLimitEvent(e);
        // Слияние: событие без доли (только статус) не стирает известную долю окна.
        raw.rateLimit = { ...raw.rateLimit, ...p.info, ...(p.info.sevenDay || raw.rateLimit?.sevenDay ? { sevenDay: { ...raw.rateLimit?.sevenDay, ...p.info.sevenDay } } : {}) };
        if (p.rejected) {
          raw.limitRejected = true;
          if (p.resetsAt) raw.limitResetsAt = p.resetsAt;
        }
      }
      try {
        o.onEvent?.(e);
      } catch {
        // ошибка наблюдателя не должна ломать разбор
      }
    };

    const killGroup = (signal: NodeJS.Signals): void => {
      const pid = child?.pid;
      if (pid === undefined) return;
      try {
        process.kill(-pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // уже завершился
        }
      }
    };

    const stop = (why: 'timeout' | 'watchdog'): void => {
      if (raw.timedOut || raw.watchdog) return;
      if (why === 'timeout') raw.timedOut = true;
      else raw.watchdog = true;
      clearTimeout(stageTimer);
      clearTimeout(watchTimer);
      killGroup('SIGTERM');
      killTimer = setTimeout(() => killGroup('SIGKILL'), o.killGraceMs);
      killTimer.unref?.();
    };

    const armWatchdog = (): void => {
      clearTimeout(watchTimer);
      if (o.watchdogMs > 0 && !raw.timedOut && !raw.watchdog) watchTimer = setTimeout(() => stop('watchdog'), o.watchdogMs);
    };

    if (o.transcriptPath) {
      try {
        mkdirSync(dirname(o.transcriptPath), { recursive: true });
      } catch {
        // см. writeTranscript
      }
    }

    try {
      child = o.spawn(o.bin, o.args, {
        cwd: o.cwd,
        env: o.env,
        // stdin закрыт: иначе `claude -p` ждёт ввод 3 с (FINDINGS «Фаза 0», 3e).
        stdio: ['ignore', 'pipe', 'pipe'],
        // Своя группа процессов: убиваем вместе с потомками.
        detached: true,
      });
    } catch (err) {
      raw.spawnError = (err as NodeJS.ErrnoException).code ?? 'ESPAWN';
      finish();
      return;
    }

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => {
      // Любой вывод — признак жизни (длинное событие может прийти несколькими кусками).
      armWatchdog();
      buf += d;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        handleLine(line);
      }
    });
    child.stderr?.on('data', (d: string) => {
      raw.stderrTail = (raw.stderrTail + d).slice(-2000);
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (child.pid === undefined) raw.spawnError = err.code ?? 'ESPAWN';
      finish();
    });
    child.on('exit', (code) => {
      raw.exitCode = code;
      // Потомок может держать каналы открытыми — 'close' тогда не придёт; ждём недолго.
      exitGrace = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish();
      }, 1000);
    });
    child.on('close', (code) => {
      if (raw.exitCode === null) raw.exitCode = code;
      finish();
    });

    if (o.timeoutMs > 0) stageTimer = setTimeout(() => stop('timeout'), o.timeoutMs);
    armWatchdog();
  });
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Запуск этапа с повтором (см. шапку файла). */
export async function runStage(opts: RunStageOptions): Promise<StageResult> {
  const spawnFn = opts.spawn ?? (nodeSpawn as unknown as SpawnFn);
  const watchdogMs = opts.watchdogMs ?? 180_000;
  const killGraceMs = opts.killGraceMs ?? 2000;
  const cwd = opts.cwd ?? opts.invocation.cwd;
  const denied: PermissionDenial[] = [];
  const t0 = Date.now();

  let inv = opts.invocation;
  let attempts = 0;
  let last: Attempt | undefined;
  let lastRaw: AttemptRaw | undefined;
  let rateLimit: RateLimitInfo | undefined;

  while (attempts < 2) {
    attempts++;
    const raw = await runOnce({
      bin: opts.bin,
      args: inv.args,
      cwd,
      env: opts.env,
      timeoutMs: inv.timeoutMs,
      watchdogMs,
      killGraceMs,
      ...(opts.transcriptPath ? { transcriptPath: opts.transcriptPath } : {}),
      ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
      spawn: spawnFn,
    });
    lastRaw = raw;
    if (raw.rateLimit) rateLimit = raw.rateLimit;
    collectDenials(raw.result, denied);
    denied.push(...raw.noTool);
    const a = classify(raw, opts.validate);
    last = a;

    if (a.kind === 'ok' || a.kind === 'spawn' || a.kind === 'limit' || a.kind === 'max_turns') break;
    if (a.kind === 'schema') inv = withPromptSuffix(opts.invocation, schemaRetrySuffix(a.error));
    else inv = opts.invocation;
  }

  const durationMs = Date.now() - t0;
  const exitCode = lastRaw?.exitCode ?? null;
  const a = last!;
  const result = 'result' in a ? a.result : undefined;
  const usage = (asRecord(result?.['usage']) ?? null) as Record<string, unknown> | null;
  const modelUsage = (asRecord(result?.['modelUsage']) ?? null) as Record<string, unknown> | null;
  const costUsd = num(result?.['total_cost_usd']);
  const extra = rateLimit ? { rateLimit } : {};

  if (a.kind === 'ok') {
    const turns = num(a.result['num_turns']);
    return {
      ok: true,
      output: a.output,
      usage,
      modelUsage,
      costUsd,
      durationMs,
      attempts,
      exitCode,
      ...(turns !== null ? { numTurns: turns } : {}),
      ...extra,
      denied,
    };
  }

  const base = { ok: false as const, attempts, durationMs, exitCode, denied, ...extra };
  const acc = result ? { usage, modelUsage, costUsd } : {};
  switch (a.kind) {
    case 'schema':
      return { ...base, ...acc, failure: 'schema', message: `Ответ не прошёл проверку схемы: ${a.error}` };
    case 'no_result':
      return { ...base, ...acc, failure: 'no_result', message: a.message };
    case 'timeout':
      return { ...base, ...acc, failure: 'timeout', message: a.message };
    case 'max_turns':
      return { ...base, ...acc, failure: 'max_turns', message: `Превышено число ходов (${opts.invocation.maxTurns})` };
    case 'limit':
      return { ...base, ...acc, failure: 'limit', message: a.message, ...(a.resetsAt ? { resetsAt: a.resetsAt } : {}) };
    case 'spawn':
      return { ...base, failure: 'spawn', message: a.message };
  }
}
