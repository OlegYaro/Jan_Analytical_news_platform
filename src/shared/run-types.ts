// Состояние прогона и журнал отправленного. Источник: docs/04-schemas.md §9.

export type ISODate = string // "YYYY-MM-DD"

export type RunMode = 'scheduled' | 'manual' | 'dry_run' | 'backfill'

export type StageName = 'collect' | 'news' | 'triage' | 'screen' | 'analyze' | 'verify'

/** `running` добавлен к docs/04: при старте приложения он означает «прервано, повторить сначала». */
export type StageStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed'

export interface StageState {
  state: StageStatus
  attempts: number
  error?: string
}

export type CountryStatus = 'pending' | 'running' | 'changes' | 'no_changes' | `failed:${string}`

export type ActAnalyzeState = 'pending' | 'running' | 'done' | 'failed'

export interface ActRun {
  analyze: ActAnalyzeState
  rounds: number
  verdict?: string
}

/** Итог экрана по тексту для одного кандидата (SCR). */
export type ScreenFinal =
  /** Идёт на полный разбор. */
  | 'material'
  /** Строка «Для сведения», без разбора. */
  | 'minor'
  /** Не относится к теме: отброшен моделью или кодом (класс 3 без банковских терминов). */
  | 'dropped'
  /** Текста акта нет или страница не открылась: «⚠ не удалось проверить» (SCR-04). */
  | 'no_text'

export interface ScreenRun {
  state: 'pending' | 'done'
  final?: ScreenFinal
  /** Кто решил: код, экран или перепроверка. */
  by?: 'code' | 'screen' | 'confirm'
  /** Причина простыми словами (для журнала и письма). */
  reason?: string
  /** Попал в экран из возвращённых проверкой (VER-02). */
  returned?: boolean
  /** Сколько банковских терминов нашёл код во всём тексте. */
  term_count?: number
  /** Пункты акта и цитата, на которые опирался экран (для письма и архива). */
  points?: string[]
  quote?: string
}

export interface Usage {
  input: number
  output: number
  cache_read: number
  cache_write: number
  cost_usd: number
}

export interface CountryRun {
  window: { from: ISODate; to: ISODate }
  status: CountryStatus
  stages: Record<StageName, StageState>
  acts: Record<string, ActRun>
  /** Кандидаты на экране по тексту (SCR); нет у старых прогонов и при выключенном экране. */
  screen?: Record<string, ScreenRun>
  usage: Usage
  /** Нефатальные предупреждения страны (⚠ в письме): дублирующий источник недоступен и т.п. */
  warnings?: string[]
}

/** «Что делается сейчас» простыми словами (для экрана прогона). */
export interface CurrentActivity {
  country: string
  stage: StageName | 'translate' | 'email'
  act?: string
  text: string
}

export interface RunState {
  id: string
  mode: RunMode
  started_at: string
  finished_at?: string
  window_override?: { from: ISODate; to: ISODate }
  skills_hash: string
  countries: Record<string, CountryRun>
  digest?: { en: boolean; ru: 'pending' | 'done' | 'blocked' | 'not_needed' }
  email?: { state: 'not_needed' | 'queued' | 'sent' | 'failed'; attempts: number }
  paused_until?: string
  /** Остановлен пользователем (RUN-08): при старте приложения сам не возобновляется. */
  stopped?: boolean
  current?: CurrentActivity
}

export type ActStage = 'draft' | 'adopted' | 'registered' | 'published' | 'in_force'

export interface LedgerEntry {
  key: string // "reg:3254-2" | "num:24/2|2026-09-17|<url>"
  first_reported_at: string
  last_stage: ActStage
  effective_date: ISODate | 'unknown'
  title_en: string
  run_id: string
}

/** Письма прогона (очередь state/outbox.json, DLV-06) для окна «Прогон». */
export interface MailStatusDto {
  state: 'not_needed' | 'queued' | 'sent' | 'failed';
  attempts: number;
  /** Причина последней неудачи простыми словами (на языке интерфейса). */
  lastError?: string;
  /** Когда следующая попытка (ISO), если письмо ждёт повтора. */
  nextAttemptAt?: string;
}

/** Состояние окна «Прогон»: только то, что реально есть в run.json (ничего не выдумывается). */
export interface RunStatusDto {
  /** Письма текущего/последнего прогона; нет — прогон без писем или ещё не дошёл до отправки. */
  mail?: MailStatusDto;
  /** Прогон идёт прямо сейчас (в этом процессе). */
  running: boolean
  paused: boolean
  pausedUntil?: string
  current?: { country: string; stage: string; text: string }
  /** Текущий или последний прогон; null — прогонов ещё не было. */
  run: RunState | null
  /** Можно ли нажать «Проверить сейчас» / «За период» (гейт почты, ничего не идёт). */
  canStart: boolean
  /** Можно ли нажать «Пробная проверка». */
  canDryRun: boolean
  /** Почему запуск недоступен (пусто, если доступен). */
  startBlockedReason: string
  countriesSummary: { active: number; total: number }
  /** Пояснение для окна: например, почему незавершённая проверка не продолжилась при запуске. */
  notice?: string
  /** Оценка ближайшей «Проверить сейчас» по всем включённым странам (NFR-08); нет — нечего проверять или идёт прогон. */
  estimate?: RunEstimateDto
}

/** Оценка до прогона: доллары и доля 5-часового лимита — диапазоны [от, до]. */
export interface RunEstimateDto {
  usd: [number, number]
  limitPercent: [number, number]
  countries: number
  /** Самое длинное окно поиска среди стран, в днях: оценка относится к следующей проверке за этот период. */
  days: number
  /** Окно следующей проверки: самая ранняя дата «с» и самая поздняя «по» среди стран (ГГГГ-ММ-ДД). */
  from: string
  to: string
  /** 'default' — истории нет ни у одной страны, оценка грубая. */
  basis: 'history' | 'default'
  /** Верхняя граница выше порога лимита из настроек: проверка может встать на паузу. */
  exceedsLimit: boolean
}

export type RunStartMode = 'manual' | 'dry_run' | 'backfill'

export interface RunStartOptions {
  /** Для «за период»: границы окна, YYYY-MM-DD. */
  window?: { from: ISODate; to: ISODate }
  /** «Проверить сейчас» только эти страны. */
  countries?: string[]
}
