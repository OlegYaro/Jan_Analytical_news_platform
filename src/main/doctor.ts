// Проверки окружения пользователя (INS-03): мастер первого запуска и `npm run doctor`.
// Без импорта electron. Все тексты — по-русски, без стектрейсов (NFR-18).

import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DoctorCheck } from '../shared/doctor-types.ts';
import type { UiLanguage } from '../shared/types.ts';
import { mt } from './i18n.ts';
import { buildClaudeEnv, findClaude, runClaude } from './env.ts';
import type { EnvMap, FindClaudeOptions, RunFn, RunResult } from './env.ts';

/** Минимальная версия Node (docs/06 §1). */
export const MIN_NODE: readonly [number, number] = [22, 18];

/** Флаги, которые обязаны быть в `claude --help` (docs/02 §7, FINDINGS «Фаза 0»).
 * `--max-turns` в справке 2.1.326 нет, хотя он работает, — поэтому не требуется. */
export const REQUIRED_FLAGS = [
  '--json-schema',
  '--permission-mode',
  '--allowedTools',
  '--disallowedTools',
  '--tools',
  '--output-format',
  '--setting-sources',
  '--strict-mcp-config',
] as const;

const noClaude = (L: UiLanguage): string => mt(L, 'нет Claude Code', 'Claude Code is missing');
const installFix = (L: UiLanguage): string =>
  mt(
    L,
    'Установите Claude Code: откройте Терминал и выполните npm install -g @anthropic-ai/claude-code, затем наберите claude и войдите в аккаунт',
    'Install Claude Code: open Terminal and run npm install -g @anthropic-ai/claude-code, then type claude and sign in to your account',
  );
const loginFix = (L: UiLanguage): string => mt(L, 'Откройте Терминал, наберите claude и войдите в аккаунт', 'Open Terminal, type claude and sign in to your account');
const updateFix = (L: UiLanguage): string => mt(L, 'Обновите Claude Code: откройте Терминал и выполните claude update', 'Update Claude Code: open Terminal and run claude update');

export interface DoctorFs {
  mkdir(path: string, opts: { recursive: true }): Promise<unknown>;
  writeFile(path: string, data: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

export interface DoctorDeps {
  run: RunFn;
  findClaude: (opts: FindClaudeOptions) => string | null;
  /** Окружение для claude (login shell без CLAUDE_*). */
  buildEnv: () => Promise<EnvMap>;
  fs: DoctorFs;
}

export interface DoctorOptions {
  configuredClaudePath?: string | null;
  workspaceDir: string;
  /** По умолчанию process.version. */
  nodeVersion?: string;
  home?: string;
  /** Язык текстов проверок; по умолчанию русский. */
  lang?: UiLanguage;
  deps?: Partial<DoctorDeps>;
}

const defaultDeps: DoctorDeps = {
  run: runClaude,
  findClaude,
  buildEnv: () => buildClaudeEnv(),
  fs: { mkdir, writeFile: (p, d) => writeFile(p, d, 'utf8'), unlink },
};

/** «v24.15.0» → [24, 15, 0]; null, если не разобрать. */
export function parseNodeVersion(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
}

function checkNode(version: string, L: UiLanguage): DoctorCheck {
  const title = 'Node.js';
  const parsed = parseNodeVersion(version);
  const [minMajor, minMinor] = MIN_NODE;
  const ok =
    parsed !== null && (parsed[0] > minMajor || (parsed[0] === minMajor && parsed[1] >= minMinor));
  if (ok) return { id: 'node', title, ok, detail: mt(L, `версия ${version}`, `version ${version}`), fix: '' };
  return {
    id: 'node',
    title,
    ok: false,
    detail: mt(
      L,
      `установлена версия ${version || 'неизвестна'}, нужна ${minMajor}.${minMinor} или новее`,
      `installed version is ${version || 'unknown'}, ${minMajor}.${minMinor} or newer is required`,
    ),
    fix: mt(L, 'Скачайте установщик с nodejs.org (LTS) и установите его, затем откройте Терминал заново', 'Download the installer from nodejs.org (LTS) and install it, then reopen Terminal'),
    link: 'https://nodejs.org',
  };
}

/** Есть ли флаг в тексте справки (как отдельное слово, а не часть другого флага). */
export function helpHasFlag(help: string, flag: string): boolean {
  const esc = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[\\s,(])${esc}(?=[\\s,=<\\[)]|$)`, 'm').test(help);
}

/** Итоговое событие из вывода `--output-format json` (объект или массив событий). */
export function parseResultEvent(stdout: string): Record<string, unknown> | null {
  const tryParse = (s: string): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };
  const pick = (v: unknown): Record<string, unknown> | null => {
    if (Array.isArray(v)) {
      for (let i = v.length - 1; i >= 0; i--) {
        const e = v[i] as Record<string, unknown> | null;
        if (e && typeof e === 'object' && e['type'] === 'result') return e;
      }
      return null;
    }
    if (v && typeof v === 'object') return v as Record<string, unknown>;
    return null;
  };
  const whole = pick(tryParse(stdout.trim()));
  if (whole) return whole;
  // Запасной путь: построчно с конца.
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const e = pick(tryParse(lines[i]!));
    if (e && e['type'] === 'result') return e;
  }
  return null;
}

function notFoundCheck(id: DoctorCheck['id'], title: string, L: UiLanguage): DoctorCheck {
  return { id, title, ok: false, detail: noClaude(L), fix: installFix(L) };
}

function failedRunDetail(res: RunResult, what: string, L: UiLanguage): string {
  if (res.timedOut) return mt(L, `${what}: Claude Code не ответил вовремя`, `${what}: Claude Code did not respond in time`);
  if (res.spawnError) return mt(L, `${what}: Claude Code не запускается`, `${what}: Claude Code cannot be started`);
  return mt(L, `${what}: Claude Code завершился с ошибкой (код ${res.code ?? '—'})`, `${what}: Claude Code finished with an error (code ${res.code ?? '—'})`);
}

async function checkLogin(
  run: RunFn,
  bin: string,
  env: EnvMap,
  help: string | null,
  L: UiLanguage,
): Promise<DoctorCheck> {
  const id = 'claude-login';
  const title = mt(L, 'Вход в аккаунт Claude', 'Claude account sign-in');
  // Флаги безопасности добавляем, только если CLI их знает (иначе он упадёт на неизвестном флаге,
  // и мы ошибочно покажем «вход не выполнен»; про старую версию скажет проверка флагов).
  const has = (f: string): boolean => help === null || helpHasFlag(help, f);
  const args = ['-p', 'Reply with OK', '--model', 'haiku', '--output-format', 'json'];
  if (has('--tools')) args.push('--tools', '');
  if (has('--strict-mcp-config')) args.push('--strict-mcp-config');
  if (has('--setting-sources')) args.push('--setting-sources', 'project');
  if (has('--permission-mode')) args.push('--permission-mode', 'dontAsk');
  if (help !== null && helpHasFlag(help, '--no-session-persistence')) {
    args.push('--no-session-persistence');
  }

  // Нейтральная папка: без проектных настроек и скиллов.
  const res = await run(bin, args, { env, cwd: tmpdir(), timeoutMs: 120_000 });
  const ev = parseResultEvent(res.stdout);
  const text = typeof ev?.['result'] === 'string' ? ev['result'] : '';
  const isError = ev?.['is_error'] === true;

  if (ev && !isError && /\bOK\b/i.test(text)) {
    return { id, title, ok: true, detail: mt(L, 'вход выполнен, Claude отвечает', 'signed in, Claude responds'), fix: '' };
  }

  // Причину ищем в тексте ответа и stderr (в служебных полях события бывают случайные совпадения).
  const all = ev ? `${text}\n${res.stderr}` : `${res.stdout}\n${res.stderr}`;
  if (/log ?in|logged|auth|credential|api key|unauthori[sz]ed|\b401\b/i.test(all)) {
    return { id, title, ok: false, detail: mt(L, 'вход в аккаунт не выполнен', 'not signed in to the account'), fix: loginFix(L) };
  }
  if (/rate.?limit|usage limit|limit reached|quota/i.test(all)) {
    return {
      id,
      title,
      ok: false,
      detail: mt(L, 'лимит подписки сейчас исчерпан', 'the subscription limit is exhausted for now'),
      fix: mt(L, 'Подождите, пока лимит восстановится (обычно до нескольких часов), и повторите проверку', 'Wait for the limit to recover (usually up to a few hours) and run the check again'),
    };
  }
  if (res.timedOut || res.spawnError) {
    return { id, title, ok: false, detail: failedRunDetail(res, mt(L, 'проверка входа', 'sign-in check'), L), fix: loginFix(L) };
  }
  return {
    id,
    title,
    ok: false,
    detail: mt(L, 'Claude не дал ожидаемого ответа', 'Claude did not give the expected answer'),
    fix: mt(
      L,
      `${loginFix(L)}. Если вход уже выполнен — проверьте интернет и повторите проверку`,
      `${loginFix(L)}. If you are already signed in, check your internet connection and run the check again`,
    ),
  };
}

function checkFlags(help: string | null, res: RunResult | null, L: UiLanguage): DoctorCheck {
  const id = 'claude-flags';
  const title = mt(L, 'Возможности Claude Code', 'Claude Code capabilities');
  if (help === null) {
    return {
      id,
      title,
      ok: false,
      detail: res ? failedRunDetail(res, mt(L, 'не удалось получить справку', 'could not get the help text'), L) : noClaude(L),
      fix: updateFix(L),
    };
  }
  const missing = REQUIRED_FLAGS.filter((f) => !helpHasFlag(help, f));
  if (missing.length === 0) {
    return { id, title, ok: true, detail: mt(L, 'все нужные возможности есть', 'all required capabilities are present'), fix: '' };
  }
  return {
    id,
    title,
    ok: false,
    detail: mt(L, `версия устарела, не хватает параметров: ${missing.join(', ')}`, `the version is outdated, missing options: ${missing.join(', ')}`),
    fix: updateFix(L),
  };
}

async function checkWorkspace(fs: DoctorFs, dir: string, L: UiLanguage): Promise<DoctorCheck> {
  const id = 'workspace-write';
  const title = mt(L, 'Рабочая папка', 'Working folder');
  const probe = join(dir, `.regwatch-doctor-${process.pid}-${Date.now()}.tmp`);
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(probe, 'ok');
    await fs.unlink(probe);
    return { id, title, ok: true, detail: mt(L, `запись возможна: ${dir}`, `writing is possible: ${dir}`), fix: '' };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    const reason =
      code === 'EACCES' || code === 'EPERM'
        ? mt(L, 'нет прав на запись', 'no write permission')
        : code === 'EROFS'
          ? mt(L, 'диск только для чтения', 'the disk is read-only')
          : code === 'ENOSPC'
            ? mt(L, 'на диске нет места', 'no space left on the disk')
            : code === 'ENOTDIR' || code === 'EEXIST'
              ? mt(L, 'по этому пути лежит файл, а не папка', 'there is a file at this path, not a folder')
              : mt(L, 'запись не удалась', 'writing failed');
    return {
      id,
      title,
      ok: false,
      detail: `${reason}: ${dir}`,
      fix: mt(
        L,
        'Выберите другую рабочую папку в настройках (например, внутри «Документов») или проверьте права доступа к этой папке в Finder',
        'Choose another working folder in the settings (for example, inside Documents) or check the access permissions of this folder in Finder',
      ),
    };
  }
}

/** Выполняет все проверки по порядку. Проверка входа тратит немного лимита — только при вызове. */
export async function runDoctor(opts: DoctorOptions): Promise<DoctorCheck[]> {
  const deps: DoctorDeps = { ...defaultDeps, ...opts.deps };
  const home = opts.home ?? homedir();
  const L: UiLanguage = opts.lang ?? 'ru';
  const checks: DoctorCheck[] = [];

  checks.push(checkNode(opts.nodeVersion ?? process.version, L));

  let env: EnvMap;
  try {
    env = await deps.buildEnv();
  } catch {
    env = process.env;
  }

  const bin = deps.findClaude({ configured: opts.configuredClaudePath, env, home });
  if (!bin) {
    checks.push({
      id: 'claude-found',
      title: mt(L, 'Программа Claude Code', 'Claude Code program'),
      ok: false,
      detail: mt(L, 'не найдена на этом Mac', 'not found on this Mac'),
      fix: installFix(L),
    });
    checks.push(notFoundCheck('claude-version', mt(L, 'Версия Claude Code', 'Claude Code version'), L));
    checks.push(notFoundCheck('claude-login', mt(L, 'Вход в аккаунт Claude', 'Claude account sign-in'), L));
    checks.push(notFoundCheck('claude-flags', mt(L, 'Возможности Claude Code', 'Claude Code capabilities'), L));
  } else {
    checks.push({ id: 'claude-found', title: mt(L, 'Программа Claude Code', 'Claude Code program'), ok: true, detail: bin, fix: '' });

    const ver = await deps.run(bin, ['--version'], { env, timeoutMs: 30_000 });
    const verLine = ver.stdout.trim().split('\n')[0]?.trim() ?? '';
    const verOk = ver.code === 0 && !ver.timedOut && verLine !== '';
    checks.push(
      verOk
        ? { id: 'claude-version', title: mt(L, 'Версия Claude Code', 'Claude Code version'), ok: true, detail: verLine, fix: '' }
        : {
            id: 'claude-version',
            title: mt(L, 'Версия Claude Code', 'Claude Code version'),
            ok: false,
            detail: failedRunDetail(ver, mt(L, 'версия не определена', 'version not determined'), L),
            fix: mt(
              L,
              `Переустановите Claude Code: откройте Терминал и выполните npm install -g @anthropic-ai/claude-code`,
              `Reinstall Claude Code: open Terminal and run npm install -g @anthropic-ai/claude-code`,
            ),
          },
    );

    // Справку получаем до проверки входа: от неё зависят флаги запроса.
    const helpRes = await deps.run(bin, ['--help'], { env, timeoutMs: 30_000 });
    const help = helpRes.code === 0 && !helpRes.timedOut ? helpRes.stdout + helpRes.stderr : null;

    checks.push(await checkLogin(deps.run, bin, env, help, L));
    checks.push(checkFlags(help, helpRes, L));
  }

  checks.push(await checkWorkspace(deps.fs, opts.workspaceDir, L));
  return checks;
}
