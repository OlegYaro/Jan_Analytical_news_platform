// Автопродолжение после паузы по лимиту (RUN-06, RUN-05): подставные часы и таймеры, сон Mac, перезапуск.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KEEP_AWAKE_MAX_MS, RESUME_DELAY_MS, STEP_MS, createResumeTimer, formatPauseTime, keepAwakeDuringPause, pauseNotice, resumeDelayMs, resumedNotice } from './auto-resume.ts';

/** Подставные часы: настенное время и монотонное (во «сне» монотонное стоит, как на macOS). */
function fakeClock(startMs: number) {
  let wall = startMs;
  let mono = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const runDue = (): void => {
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= mono).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) return;
      timers.delete(due[0]);
      due[1].fn();
    }
  };
  return {
    now: () => wall,
    setTimer: (fn: () => void, ms: number) => {
      const id = ++seq;
      timers.set(id, { at: mono + ms, fn });
      return id;
    },
    clearTimer: (h: unknown) => void timers.delete(h as number),
    /** Время идёт, Mac бодрствует. */
    advance(ms: number) {
      const end = mono + ms;
      while (mono < end) {
        const next = Math.min(end, ...[...timers.values()].map((t) => t.at).filter((a) => a > mono), end);
        wall += next - mono;
        mono = next;
        runDue();
      }
    },
    /** Mac спит: настенные часы идут, монотонные и таймеры стоят. */
    sleep(ms: number) {
      wall += ms;
    },
    pending: () => timers.size,
  };
}

const T0 = Date.parse('2026-11-21T10:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

test('resumeDelayMs: срок + 5 с; прошедший — 0; нет/неверный — null', () => {
  assert.equal(resumeDelayMs(iso(T0 + 60_000), T0), 60_000 + RESUME_DELAY_MS);
  assert.equal(resumeDelayMs(iso(T0 - 60_000), T0), 0);
  assert.equal(resumeDelayMs(undefined, T0), null);
  assert.equal(resumeDelayMs('не дата', T0), null);
});

test('таймер: продолжение ровно один раз в момент сброса; повторный arm заменяет срок', () => {
  const c = fakeClock(T0);
  let fired = 0;
  const t = createResumeTimer({ ...c, fire: () => void fired++ });
  t.arm(iso(T0 + 10 * 60_000));
  t.arm(iso(T0 + 20 * 60_000)); // тот же прогон встал на паузу снова — один таймер
  c.advance(15 * 60_000);
  assert.equal(fired, 0);
  c.advance(5 * 60_000 + RESUME_DELAY_MS);
  assert.equal(fired, 1);
  assert.equal(t.pending(), null);
  c.advance(60 * 60_000);
  assert.equal(fired, 1, 'не стартует дважды');
  assert.equal(c.pending(), 0);
});

test('таймер: шаги не длиннее минуты (сверка с настенными часами)', () => {
  const c = fakeClock(T0);
  const t = createResumeTimer({ ...c, fire: () => {} });
  t.arm(iso(T0 + 3 * 3600_000));
  c.advance(STEP_MS - 1);
  assert.equal(c.pending(), 1);
  assert.equal(t.pending(), iso(T0 + 3 * 3600_000));
});

test('сон Mac: монотонный таймер стоял — после пробуждения onWake продолжает сразу; без onWake — не позже чем через шаг', () => {
  const c = fakeClock(T0);
  let fired = 0;
  const t = createResumeTimer({ ...c, fire: () => void fired++ });
  t.arm(iso(T0 + 2 * 3600_000));
  c.advance(10 * 60_000);
  c.sleep(5 * 3600_000); // Mac проспал срок
  assert.equal(fired, 0);
  t.onWake();
  assert.equal(fired, 1);
  t.onWake();
  assert.equal(fired, 1, 'повторное пробуждение не запускает второй раз');

  // Событие пробуждения не пришло: таймер сам сверится с настенными часами на следующем шаге.
  const c2 = fakeClock(T0);
  let fired2 = 0;
  const t2 = createResumeTimer({ ...c2, fire: () => void fired2++ });
  t2.arm(iso(T0 + 2 * 3600_000));
  c2.sleep(3 * 3600_000);
  c2.advance(STEP_MS);
  assert.equal(fired2, 1);
});

test('сон Mac до срока: после пробуждения таймер ждёт остаток, а не всё время заново', () => {
  const c = fakeClock(T0);
  let fired = 0;
  const t = createResumeTimer({ ...c, fire: () => void fired++ });
  t.arm(iso(T0 + 2 * 3600_000));
  c.sleep(90 * 60_000);
  t.onWake();
  c.advance(30 * 60_000 + RESUME_DELAY_MS);
  assert.equal(fired, 1);
});

test('перезапуск приложения: новый таймер со сроком из run.json; срок уже прошёл — продолжение сразу', () => {
  const c = fakeClock(T0 + 6 * 3600_000);
  let fired = 0;
  const t = createResumeTimer({ ...c, fire: () => void fired++ });
  t.arm(iso(T0 + 2 * 3600_000)); // paused_until из run.json, приложение было закрыто
  assert.equal(fired, 1);
  t.arm('мусор');
  assert.equal(t.pending(), null);
  t.cancel();
  assert.equal(fired, 1);
});

test('RUN-05: короткую паузу (≤ 30 мин) Mac пережидает без сна, длинную — спит', () => {
  assert.equal(keepAwakeDuringPause(iso(T0 + KEEP_AWAKE_MAX_MS), T0), true);
  assert.equal(keepAwakeDuringPause(iso(T0 + KEEP_AWAKE_MAX_MS + 1), T0), false);
  assert.equal(keepAwakeDuringPause(iso(T0 - 1), T0), false);
  assert.equal(keepAwakeDuringPause(undefined, T0), false);
});

test('уведомления: «Проверка на паузе до ЧЧ:ММ — лимит» и «продолжена» (ru/en)', () => {
  const now = new Date(2026, 10, 21, 10, 0);
  const until = new Date(2026, 10, 21, 14, 20).toISOString();
  assert.equal(formatPauseTime(until, now, 'ru'), '14:20');
  assert.equal(pauseNotice(until, now, 'ru').title, 'Проверка на паузе до 14:20 — лимит');
  assert.equal(pauseNotice(until, now, 'en').title, 'Check paused until 14:20 — limit');
  const tomorrow = new Date(2026, 10, 22, 1, 5).toISOString();
  assert.equal(formatPauseTime(tomorrow, now, 'ru'), '22.11 01:05');
  assert.equal(resumedNotice('ru').title, 'Проверка продолжена');
  assert.equal(resumedNotice('en').title, 'Check resumed');
});
