// Бюджет 5-часового лимита подписки Claude (NFR-06, CFG-09, docs/02 §8). Без electron.
//
// Источник данных — `rate_limit_event` из stream-json каждого процесса модели (claude-runner разбирает его в
// RateLimitInfo). После КАЖДОГО процесса последние известные доли окон (5 ч и 7 дней) и время сброса
// записываются в <рабочая папка>/state/rate_limit.json (атомарно, с отметкой времени): так данные переживают
// перезапуск приложения и паузу.
//
// Решение перед процессом (beforeProcess):
// 1. Недельное окно ≥ 98 % (и ещё не сброшено) → CountryFailure('limit'): страна не проверяется. Ждать сброса
//    недельного окна — это дни: незавершённый прогон всё это время блокировал бы расписания и письмо с уже
//    найденным. Страна получает `failed:limit`, прогон идёт дальше и завершается; страна проверится следующим
//    прогоном после сброса (её окно поиска отсчитывается от последней успешной проверки — ничего не теряется).
// 2. Порог (settings.limitPercent) ≥ 100 → пауза только по настоящей ошибке лимита от CLI (её ловит оркестратор).
// 3. Данные 5-часового окна свежие (моложе 5 ч и время сброса ещё впереди) и доля окна ≥ порога → PauseSignal до
//    сброса окна + 30 с. Порог — АБСОЛЮТНАЯ доля окна, а не расход этого прогона: окно общее с обычной работой
//    пользователя в Claude, и «оставить запас» можно только так.
// 4. Данных нет (самый первый процесс) или они устарели → процесс идёт; дешёвой пробы не делаем: после первого
//    процесса данные появятся.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Outcome } from '../../shared/pipeline-types.ts';
import type { Settings } from '../../shared/types.ts';
import { writeJsonAtomic } from '../fs-atomic.ts';
import { langOf, mt } from '../i18n.ts';
import type { RateLimitInfo, RunStageOptions, StageResult } from './claude-runner.ts';
import { CountryFailure, PauseSignal, WEEKLY_LIMIT_FAILURE } from './signals.ts';

export const RATE_LIMIT_FILE = join('state', 'rate_limit.json');
/** Данные 5-часового окна старше этого не учитываются (окно за это время точно сбросилось). */
export const FRESH_MS = 5 * 3600_000;
/** Запас после времени сброса: часы CLI и Mac могут немного расходиться. */
export const RESUME_MARGIN_MS = 30_000;
/** Недельное окно: при такой доле страна не начинается (failed:limit). */
export const WEEKLY_STOP = 0.98;
/** Пауза по ошибке лимита длиннее этого — недельное окно (как MAX_LIMIT_PAUSE_MS оркестратора). */
const LONG_RESET_MS = 6 * 3600_000;

/** Наблюдение одного окна. */
export interface WindowObs {
  /** Доля окна 0..1. */
  utilization: number;
  /** Время сброса окна (ISO) или null — неизвестно. */
  resets_at: string | null;
  status?: string;
  /** Когда получено (ISO). */
  observed_at: string;
}

/** Файл state/rate_limit.json (docs/04 §9). */
export interface RateLimitFile {
  version: 1;
  updated_at: string;
  five_hour?: WindowObs;
  seven_day?: WindowObs;
}

export type BudgetDecision =
  | { kind: 'go'; reason: 'no_data' | 'stale' | 'below' | 'no_threshold' }
  | { kind: 'pause'; until: string; utilization: number; threshold: number; resetsAt: string }
  | { kind: 'weekly'; utilization: number; resetsAt: string | null };

export interface Budget {
  /** Перед каждым процессом модели: бросает PauseSignal (порог) или CountryFailure('limit') (недельный лимит). */
  beforeProcess(): Promise<void>;
  /** Сведения о лимите из процесса (RateLimitInfo раннера); `limit` — процесс получил ошибку лимита. */
  observe(info: RateLimitInfo | undefined, limit?: { resetsAt?: string }): void;
  /** То же по итогу runStage. */
  observeStage(res: StageResult): void;
  /** Текущее решение без побочных эффектов (для окна и тестов). */
  decide(): BudgetDecision;
  /** Последние известные данные (память или файл). */
  read(): RateLimitFile | null;
}

export interface BudgetDeps {
  workspaceDir(): string;
  /** Порог берётся из текущих настроек: сдвинул ползунок во время прогона — действует сразу. */
  getSettings(): Pick<Settings, 'limitPercent'> & { uiLanguage?: Settings['uiLanguage'] };
  now?(): Date;
  log?(event: string, text: string, data?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------------------------
// Чистая логика
// ---------------------------------------------------------------------------------------------

const ms = (iso: string | null | undefined): number => (typeof iso === 'string' ? Date.parse(iso) : NaN);
const pct = (u: number): number => Math.round(u * 1000) / 10;

/** Порог из настроек: 10..100 (валидация окна), вне диапазона — ближайшая граница; не число — 80. */
export function thresholdOf(limitPercent: unknown): number {
  const v = typeof limitPercent === 'number' && Number.isFinite(limitPercent) ? limitPercent : 80;
  return Math.min(100, Math.max(0, v));
}

/** Данные 5-часового окна ещё описывают текущее окно: моложе 5 ч и сброс ещё не наступил. */
export function isFresh(w: WindowObs | undefined, now: Date): w is WindowObs & { resets_at: string } {
  if (!w || typeof w.utilization !== 'number') return false;
  const obs = ms(w.observed_at);
  const reset = ms(w.resets_at);
  if (!Number.isFinite(obs) || !Number.isFinite(reset)) return false;
  return now.getTime() - obs < FRESH_MS && obs <= now.getTime() + 60_000 && reset > now.getTime();
}

/** Решение перед процессом (см. шапку файла). */
export function decideBudget(file: RateLimitFile | null, limitPercent: unknown, now: Date): BudgetDecision {
  // Недельное окно: доля в окне только растёт до сброса, поэтому старое значение — нижняя граница, пока сброс впереди.
  const week = file?.seven_day;
  if (week && typeof week.utilization === 'number' && week.utilization >= WEEKLY_STOP) {
    const reset = ms(week.resets_at);
    if (Number.isFinite(reset) && reset > now.getTime()) return { kind: 'weekly', utilization: week.utilization, resetsAt: week.resets_at };
  }
  const five = file?.five_hour;
  if (!five) return { kind: 'go', reason: 'no_data' };
  if (!isFresh(five, now)) return { kind: 'go', reason: 'stale' };
  const threshold = thresholdOf(limitPercent);
  if (threshold >= 100) return { kind: 'go', reason: 'no_threshold' };
  if (pct(five.utilization) < threshold) return { kind: 'go', reason: 'below' };
  const until = new Date(ms(five.resets_at) + RESUME_MARGIN_MS).toISOString();
  return { kind: 'pause', until, utilization: five.utilization, threshold, resetsAt: five.resets_at };
}

const whenText = (iso: string | null, en: boolean): string =>
  iso && Number.isFinite(ms(iso))
    ? new Date(iso).toLocaleString(en ? 'en-GB' : 'ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    : en
      ? 'unknown'
      : 'неизвестно';

/** Текст паузы по порогу (окно «Прогон», журнал). */
export function pauseMessage(d: Extract<BudgetDecision, { kind: 'pause' }>, lang: 'ru' | 'en'): string {
  return mt(
    lang,
    `5-часовой лимит Claude использован на ${pct(d.utilization)} % — это не меньше порога ${d.threshold} % (Настройки → Расход). Пауза до сброса окна, затем проверка продолжится сама`,
    `${pct(d.utilization)} % of the 5-hour Claude limit is used — not below the ${d.threshold} % threshold (Settings → Spending). Paused until the window resets, then the check resumes by itself`,
  );
}

/** Текст «недельный лимит почти исчерпан» (итог страны failed:limit). */
export function weeklyMessage(d: Extract<BudgetDecision, { kind: 'weekly' }>, lang: 'ru' | 'en'): string {
  const en = lang === 'en';
  return mt(
    lang,
    `Недельный лимит Claude почти исчерпан (${pct(d.utilization)} %, сброс около ${whenText(d.resetsAt, en)}) — страна не проверена, чтобы не ждать сброса несколько дней. Она будет проверена следующим прогоном после сброса`,
    `The weekly Claude limit is almost used up (${pct(d.utilization)} %, resets around ${whenText(d.resetsAt, en)}) — the country was not checked so as not to wait days for the reset. It will be checked by the next run after the reset`,
  );
}

/** Слияние нового наблюдения с прежним файлом: окно без новых данных остаётся как было. */
export function mergeObservation(prev: RateLimitFile | null, info: RateLimitInfo | undefined, limit: { resetsAt?: string } | undefined, now: Date): RateLimitFile | null {
  const at = now.toISOString();
  const next: RateLimitFile = { version: 1, updated_at: at, ...(prev?.five_hour ? { five_hour: prev.five_hour } : {}), ...(prev?.seven_day ? { seven_day: prev.seven_day } : {}) };
  let changed = false;
  if (info && typeof info.utilization === 'number' && Number.isFinite(info.utilization)) {
    next.five_hour = { utilization: info.utilization, resets_at: info.resetsAt ?? null, ...(info.status ? { status: info.status } : {}), observed_at: at };
    changed = true;
  }
  const sd = info?.sevenDay;
  if (sd && typeof sd.utilization === 'number' && Number.isFinite(sd.utilization)) {
    next.seven_day = { utilization: sd.utilization, resets_at: sd.resetsAt ?? null, ...(sd.status ? { status: sd.status } : {}), observed_at: at };
    changed = true;
  }
  // Ошибка лимита: отказавшее окно считается заполненным до своего сброса (сброс дальше 6 ч — недельное окно).
  if (limit) {
    const reset = ms(limit.resetsAt);
    if (Number.isFinite(reset)) {
      const long = reset - now.getTime() > LONG_RESET_MS;
      next[long ? 'seven_day' : 'five_hour'] = { utilization: 1, resets_at: new Date(reset).toISOString(), status: 'rejected', observed_at: at };
      changed = true;
    }
  }
  return changed ? next : null;
}

// ---------------------------------------------------------------------------------------------
// Обвязка
// ---------------------------------------------------------------------------------------------

export function readRateLimitFile(workspaceDir: string): RateLimitFile | null {
  try {
    const raw = JSON.parse(readFileSync(join(workspaceDir, RATE_LIMIT_FILE), 'utf8')) as Partial<RateLimitFile>;
    if (!raw || typeof raw !== 'object' || raw.version !== 1) return null;
    const ok = (w: unknown): w is WindowObs =>
      !!w && typeof w === 'object' && typeof (w as WindowObs).utilization === 'number' && typeof (w as WindowObs).observed_at === 'string';
    return {
      version: 1,
      updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : '',
      ...(ok(raw.five_hour) ? { five_hour: raw.five_hour } : {}),
      ...(ok(raw.seven_day) ? { seven_day: raw.seven_day } : {}),
    };
  } catch {
    return null;
  }
}

export function createBudget(deps: BudgetDeps): Budget {
  const now = (): Date => (deps.now ? deps.now() : new Date());
  /** Память на случай, если файл не записался (диск); новее из памяти и файла побеждает. */
  let mem: { ws: string; file: RateLimitFile } | null = null;
  const log = (event: string, text: string, data?: Record<string, unknown>): void => {
    try {
      deps.log?.(event, text, data);
    } catch {
      /* журнал не мешает бюджету */
    }
  };

  function read(): RateLimitFile | null {
    const ws = deps.workspaceDir();
    const disk = readRateLimitFile(ws);
    const m = mem && mem.ws === ws ? mem.file : null;
    if (!disk) return m;
    if (!m) return disk;
    return m.updated_at > disk.updated_at ? m : disk;
  }

  function decide(): BudgetDecision {
    return decideBudget(read(), deps.getSettings().limitPercent, now());
  }

  function observe(info: RateLimitInfo | undefined, limit?: { resetsAt?: string }): void {
    const ws = deps.workspaceDir();
    const next = mergeObservation(read(), info, limit, now());
    if (!next) return;
    mem = { ws, file: next };
    try {
      writeJsonAtomic(join(ws, RATE_LIMIT_FILE), next);
    } catch (e) {
      log('budget_write_error', `Не удалось записать ${RATE_LIMIT_FILE}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return {
    read,
    decide,
    observe,
    observeStage(res) {
      observe(res.rateLimit, !res.ok && res.failure === 'limit' ? { ...(res.resetsAt ? { resetsAt: res.resetsAt } : {}) } : undefined);
    },
    async beforeProcess() {
      const d = decide();
      const lang = langOf(deps.getSettings());
      if (d.kind === 'pause') {
        log('budget_pause', `Пауза по порогу: окно ${pct(d.utilization)} % ≥ ${d.threshold} %, до ${d.until}`, { ...d });
        throw new PauseSignal(d.until, pauseMessage(d, lang));
      }
      if (d.kind === 'weekly') {
        log('budget_weekly', `Недельный лимит ${pct(d.utilization)} % ≥ ${pct(WEEKLY_STOP)} %: страна не начинается`, { ...d });
        throw new CountryFailure('limit', weeklyMessage(d, lang));
      }
    },
  };
}

/** runStage, который после КАЖДОГО процесса передаёт сведения о лимите в бюджет. */
export function observingRunStage(run: (opts: RunStageOptions) => Promise<StageResult>, budget: Pick<Budget, 'observeStage'>): (opts: RunStageOptions) => Promise<StageResult> {
  return async (opts) => {
    const res = await run(opts);
    try {
      budget.observeStage(res);
    } catch {
      /* учёт лимита не роняет этап */
    }
    return res;
  };
}

/**
 * Бюджет внутри исполнителя (пакеты отбора, проверки, перевода): сигнал превращается в провал шага, чтобы
 * расход уже сделанных пакетов дошёл до учёта. `limit` → оркестратор ставит паузу до `resetsAt`;
 * WEEKLY_LIMIT_FAILURE → страна `failed:limit`. null — процесс можно запускать.
 */
export async function budgetGate(budget: { beforeProcess(): Promise<void> } | undefined): Promise<Extract<Outcome<never>, { ok: false }> | null> {
  if (!budget) return null;
  try {
    await budget.beforeProcess();
    return null;
  } catch (e) {
    if (e instanceof PauseSignal) return { ok: false, failure: 'limit', message: e.message, resetsAt: e.until };
    if (e instanceof CountryFailure && e.code === 'limit') return { ok: false, failure: WEEKLY_LIMIT_FAILURE, message: e.message };
    throw e;
  }
}
