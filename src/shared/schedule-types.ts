// Расписания проверок (SCH, RUN-01/03): общие для main и окна правила и формат состояния.

/** Идентификатор расписания: строчная латиница, цифры, дефис; 1..40 знаков, начинается не с дефиса. */
export const SCHEDULE_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/

/** Максимальная длина названия расписания. */
export const SCHEDULE_NAME_MAX = 60

/** Код страны в расписании: ISO 3166-1 alpha-2, заглавные. */
export const SCHEDULE_COUNTRY_RE = /^[A-Z]{2}$/

/** 'HH:MM', 00:00..23:59. */
export const SCHEDULE_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

/** Одно расписание в окне «Расписание» (ответ schedule.status()). */
export interface ScheduleEntryStatus {
  id: string
  name: string
  enabled: boolean
  /** Ближайший запуск (ISO, UTC); null — расписание выключено. */
  nextRunAt: string | null
  /** Когда по этому расписанию последний раз начался прогон (ISO); null — ещё не начинался. */
  lastStartedAt: string | null
  /** Какие страны реально будут проверены (пусто в настройках = все включённые; выключенные и удалённые отброшены). */
  countries: string[]
}

export interface ScheduleStatusDto {
  entries: ScheduleEntryStatus[]
  /** id расписаний, которые сработали и ждут своей очереди (идёт другой прогон). */
  queued: string[]
}

/** Файл `<рабочая папка>/state/schedule_fired.json`. */
export interface ScheduleFiredFile {
  version: 1
  /** id расписания → когда оно сработало (или когда его время было принято за точку отсчёта). По нему считается догон. */
  fired: Record<string, string>
  /** id расписания → когда по нему реально начался прогон (для окна). */
  lastStarted: Record<string, string>
}
