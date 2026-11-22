// Автопродолжение прогона после паузы по лимиту (RUN-06, NFR-06). Без electron: часы и таймеры — инъекцией.
//
// Цепочка: оркестратор пишет `paused_until` в run.json → index.ts вызывает arm(paused_until) (сразу при паузе
// и при каждом запуске приложения, когда находит незавершённый прогон) → в момент paused_until + 5 с
// вызывается fire() (= resumeUnfinished, которая сама не стартует дважды).
//
// Сон Mac: таймеры Node на macOS идут по монотонным часам, которые во сне стоят, поэтому один длинный
// setTimeout после пробуждения сработал бы с опозданием на время сна. Здесь таймер взводится шагами не
// длиннее STEP_MS и каждый раз сверяется с настенными часами; кроме того, onWake() (powerMonitor 'resume')
// пересчитывает сразу. Перезапуск приложения: таймер в памяти теряется, но paused_until лежит в run.json и
// читается при старте.
//
// RUN-05 во время паузы: сон разрешён (пауза длится до 5 ч — держать Mac бодрым всё это время незачем),
// кроме короткой паузы ≤ KEEP_AWAKE_MAX_MS — её проще переждать без сна, чтобы прогон закончился сам.

import type { UiLanguage } from '../shared/types.ts';
import { mt } from './i18n.ts';

/** Запас после paused_until (сам paused_until уже включает запас бюджета 30 с). */
export const RESUME_DELAY_MS = 5_000;
/** Самый длинный шаг таймера: после сна опоздание не больше этого. */
export const STEP_MS = 60_000;
/** Паузу не длиннее этого Mac пережидает без сна (powerSaveBlocker). */
export const KEEP_AWAKE_MAX_MS = 30 * 60_000;

/** Через сколько мс продолжать; 0 — уже пора; null — paused_until нет или он неверный. */
export function resumeDelayMs(pausedUntil: string | null | undefined, nowMs: number, delayMs = RESUME_DELAY_MS): number | null {
  if (!pausedUntil) return null;
  const t = Date.parse(pausedUntil);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, t + delayMs - nowMs);
}

/** Держать ли Mac бодрым во время этой паузы (RUN-05): только короткая пауза. */
export function keepAwakeDuringPause(pausedUntil: string | null | undefined, nowMs: number): boolean {
  const d = resumeDelayMs(pausedUntil, nowMs, 0);
  return d !== null && d > 0 && d <= KEEP_AWAKE_MAX_MS;
}

/** «ЧЧ:ММ», если сегодня; иначе «ДД.ММ ЧЧ:ММ» (местное время). */
export function formatPauseTime(iso: string, now: Date, lang: UiLanguage): string {
  const d = new Date(iso);
  const locale = lang === 'en' ? 'en-GB' : 'ru-RU';
  const time = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? time : `${d.toLocaleDateString(locale, { day: '2-digit', month: '2-digit' })} ${time}`;
}

/** Уведомление macOS о паузе. */
export function pauseNotice(pausedUntil: string, now: Date, lang: UiLanguage): { title: string; body: string } {
  const when = formatPauseTime(pausedUntil, now, lang);
  return {
    title: mt(lang, `Проверка на паузе до ${when} — лимит`, `Check paused until ${when} — limit`),
    body: mt(
      lang,
      'Достигнут лимит Claude (или порог из Настроек → Расход). Проверка продолжится сама с того же места; отчёт придёт позже, но целиком.',
      'The Claude limit (or the threshold in Settings → Spending) was reached. The check will resume by itself from the same place; the report arrives later, but in full.',
    ),
  };
}

/** Уведомление macOS о продолжении. */
export function resumedNotice(lang: UiLanguage): { title: string; body: string } {
  return {
    title: mt(lang, 'Проверка продолжена', 'Check resumed'),
    body: mt(lang, 'Лимит Claude восстановился — проверка продолжается с того места, где остановилась.', 'The Claude limit has recovered — the check continues from where it stopped.'),
  };
}

export interface ResumeTimerDeps {
  /** Настенные часы, мс. */
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** Продолжить прогон (resumeUnfinished: сама проверяет, что прогон не идёт). */
  fire(): void;
  stepMs?: number;
  delayMs?: number;
}

export interface ResumeTimer {
  /** Взвести на paused_until (повторный вызов заменяет прежний срок; неверный срок — снять). */
  arm(pausedUntil: string | null | undefined): void;
  /** Mac проснулся: пересчитать по настенным часам (если пора — продолжить сразу). */
  onWake(): void;
  cancel(): void;
  /** Взведённый срок (ISO) или null. */
  pending(): string | null;
}

export function createResumeTimer(deps: ResumeTimerDeps): ResumeTimer {
  const step = deps.stepMs ?? STEP_MS;
  const delay = deps.delayMs ?? RESUME_DELAY_MS;
  let until: string | null = null;
  let handle: unknown = null;

  const clear = (): void => {
    if (handle !== null) deps.clearTimer(handle);
    handle = null;
  };

  const schedule = (): void => {
    clear();
    if (until === null) return;
    const left = resumeDelayMs(until, deps.now(), delay);
    if (left === null) {
      until = null;
      return;
    }
    if (left === 0) {
      // Пора: срок снимается до вызова, чтобы fire() не сработал дважды.
      until = null;
      deps.fire();
      return;
    }
    handle = deps.setTimer(() => {
      handle = null;
      schedule();
    }, Math.min(left, step));
  };

  return {
    arm(p) {
      until = p ?? null;
      schedule();
    },
    onWake() {
      if (until !== null) schedule();
    },
    cancel() {
      until = null;
      clear();
    },
    pending: () => until,
  };
}
