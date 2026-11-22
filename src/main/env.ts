// Окружение для запуска `claude` и поиск его бинаря.
// Без импорта electron: используется и приложением, и `npm run doctor`, и тестами.
// См. docs/10-lessons-from-claude-asist.md (ловушки №1, №2) и docs/02-architecture.md §7.

import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { Readable } from 'node:stream';

/** Окружение процесса: имя → значение. */
export type EnvMap = Record<string, string | undefined>;

/** Итог запуска внешней программы. */
export interface RunResult {
  /** Код выхода; null — процесс убит сигналом или не запустился. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Код ошибки запуска (например, ENOENT), если процесс не стартовал. */
  spawnError?: string;
}

export interface RunOptions {
  env?: EnvMap;
  cwd?: string;
  /** Предельное время работы; по истечении процесс (вся его группа) убивается. */
  timeoutMs?: number;
}

/** Сигнатура функции запуска — инъектируется в тестах. */
export type RunFn = (bin: string, args: readonly string[], opts?: RunOptions) => Promise<RunResult>;

/**
 * Убирает переменные `CLAUDE_*` и `CLAUDECODE`. Иначе дочерний `claude` считает себя вложенной
 * сессией (например, из-за CLAUDE_CODE_CHILD_SESSION) и не пишет транскрипт.
 * Прочие переменные (в т.ч. с CLAUDE в середине имени) не трогаются.
 */
export function stripClaudeEnv(env: EnvMap): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_')) continue;
    out[key] = value;
  }
  return out;
}

const ENV_LINE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

/**
 * Разбор вывода `env`. Берутся только строки вида `ИМЯ=значение`; продолжения многострочных
 * значений (строки без такого начала) пропускаются и разбор не ломают.
 */
export function parseEnvOutput(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = ENV_LINE.exec(line);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

export interface LoginShellOptions {
  /** Оболочка; по умолчанию `$SHELL`, а если её нет — `/bin/zsh`. */
  shell?: string;
  /** По умолчанию 5 с. */
  timeoutMs?: number;
  /** Функция запуска (для тестов). */
  run?: RunFn;
  /** Что вернуть при ошибке; по умолчанию копия process.env. */
  fallback?: EnvMap;
}

/**
 * Окружение пользователя из login shell (`$SHELL -ilc env`): Electron, запущенный из Finder,
 * не видит PATH пользователя. При ошибке, таймауте или пустом выводе — process.env.
 */
export async function loginShellEnv(opts: LoginShellOptions = {}): Promise<Record<string, string>> {
  const shell = opts.shell ?? (process.env['SHELL'] || '/bin/zsh');
  const run = opts.run ?? runClaude;
  const fallback = (): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(opts.fallback ?? process.env)) if (v !== undefined) out[k] = v;
    return out;
  };
  try {
    const res = await run(shell, ['-ilc', 'env'], { timeoutMs: opts.timeoutMs ?? 5000 });
    if (res.timedOut || res.spawnError) return fallback();
    const parsed = parseEnvOutput(res.stdout);
    // Без PATH такое окружение бесполезно (оболочка упала до вывода env).
    if (!parsed['PATH']) return fallback();
    return parsed;
  } catch {
    return fallback();
  }
}

/** Окружение для `claude`: переданное (или из login shell) минус `CLAUDE_*` и `CLAUDECODE`. */
export async function buildClaudeEnv(base?: EnvMap): Promise<Record<string, string>> {
  return stripClaudeEnv(base ?? (await loginShellEnv()));
}

/** Есть ли исполняемый файл по пути. */
export function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface FindClaudeOptions {
  /** Путь из настройки «Дополнительно» (может начинаться с `~`). */
  configured?: string | null;
  /** Окружение (обычно из login shell): из него берётся PATH. */
  env?: EnvMap;
  home?: string;
  /** Проверка наличия файла (для тестов). */
  exists?: (path: string) => boolean;
}

function expandHome(path: string, home: string): string {
  if (path === '~') return home;
  if (path.startsWith('~/')) return join(home, path.slice(2));
  return path;
}

/**
 * Поиск бинаря `claude`: путь из настройки → PATH из окружения → стандартные места.
 * Возвращает путь или null.
 */
export function findClaude(opts: FindClaudeOptions = {}): string | null {
  const home = opts.home ?? homedir();
  const exists = opts.exists ?? isExecutableFile;
  const env = opts.env ?? process.env;

  const configured = opts.configured?.trim();
  if (configured) {
    const p = expandHome(configured, home);
    if (exists(p)) return p;
  }

  for (const dir of (env['PATH'] ?? '').split(delimiter)) {
    if (!dir) continue;
    const p = join(expandHome(dir, home), 'claude');
    if (exists(p)) return p;
  }

  const standard = [
    join(home, '.claude/local/claude'),
    join(home, '.local/bin/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    join(home, '.npm-global/bin/claude'),
  ];
  for (const p of standard) if (exists(p)) return p;
  return null;
}

/**
 * Запуск программы без оболочки. stdin — 'ignore' (иначе `claude -p` ждёт ввод 3 с),
 * stdout/stderr собираются. По таймауту убивается вся группа процессов (SIGTERM, через 2 с
 * SIGKILL), чтобы не оставались дочерние процессы.
 */
export const runClaude: RunFn = (bin, args, opts = {}) =>
  new Promise<RunResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let exitGrace: NodeJS.Timeout | undefined;

    const finish = (r: Omit<RunResult, 'stdout' | 'stderr' | 'timedOut'>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(exitGrace);
      resolve({ ...r, stdout, stderr, timedOut });
    };

    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(bin, [...args], {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Своя группа процессов: по таймауту убиваем и потомков.
        detached: true,
      });
    } catch (err) {
      finish({ code: null, spawnError: (err as NodeJS.ErrnoException).code ?? 'ESPAWN' });
      return;
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => (stdout += d));
    child.stderr.on('data', (d: string) => (stderr += d));

    const killGroup = (signal: NodeJS.Signals): void => {
      const pid = child.pid;
      if (pid === undefined) return;
      try {
        process.kill(-pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // процесс уже завершился
        }
      }
    };

    if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killGroup('SIGTERM');
        killTimer = setTimeout(() => killGroup('SIGKILL'), 2000);
      }, opts.timeoutMs);
    }

    child.on('error', (err: NodeJS.ErrnoException) => {
      finish({ code: null, spawnError: err.code ?? 'ESPAWN' });
    });
    child.on('exit', (code) => {
      // Если потомок держит каналы открытыми, 'close' может не прийти — ждём недолго.
      exitGrace = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish({ code });
      }, 1000);
    });
    child.on('close', (code) => finish({ code }));
  });
