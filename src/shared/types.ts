import type { ExtractionProfile } from './profile-types.ts'

export type StageKey = 'news' | 'triage' | 'screen' | 'confirm' | 'analyze' | 'verify' | 'translate' | 'srcCheck' | 'srcDiscover'
export type MailService = 'gmail' | 'outlook' | 'icloud' | 'yandex' | 'mailru' | 'other'
export type MailSecurity = 'ssl' | 'starttls' | 'none'
export type ReportLanguage = 'ru' | 'en' | 'both_one' | 'both_two'
export type Preset = 'economy' | 'balanced' | 'max'

export interface MailSettings {
  service: MailService
  address: string
  recipients: string[]
  /** Только для service === 'other'. */
  server: string
  port: number
  security: MailSecurity
  /** Почта проверена тестовым письмом (гейт CFG-14). Пароль здесь не хранится. */
  verified: boolean
}

export interface AdvancedSettings {
  stageModels: Partial<Record<StageKey, string>>
  timeoutsMin: Partial<Record<StageKey, number>>
  firstRunDays: number
  saveTranscripts: boolean
  /** '' = искать автоматически. */
  claudePath: string
}

/** Язык интерфейса приложения (не путать с языком отчёта). */
export type UiLanguage = 'ru' | 'en'

/** Одно расписание: в эти дни и в это время проверяются эти страны (до 9 расписаний). */
export interface ScheduleEntry {
  /** Стабильный идентификатор (латиница/цифры/дефис), нужен для журнала догона. */
  id: string
  /** Название для пользователя, например «Центральная Азия, понедельник». */
  name: string
  enabled: boolean
  /** 0..6, 0 = воскресенье; не пусто. */
  days: number[]
  /** 'HH:MM', местное время. */
  time: string
  /** Коды стран. Пусто = все включённые страны. */
  countries: string[]
}

export const MAX_SCHEDULES = 9

export interface Settings {
  topic: string
  perspective: string
  newsEnabled: boolean
  /** Расписания проверок: 1..MAX_SCHEDULES. Заменили scheduleDays/scheduleTime (миграция v3→v4). */
  schedules: ScheduleEntry[]
  /** Язык интерфейса. */
  uiLanguage: UiLanguage
  launchAtLogin: boolean
  catchUpMissed: boolean
  mail: MailSettings
  reportLanguage: ReportLanguage
  failureAlerts: boolean
  preset: Preset
  /** 10..100 */
  limitPercent: number
  workspaceDir: string
  advanced: AdvancedSettings
  onboardingDone: boolean
  schemaVersion: number
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends (infer U)[] ? U[] : T[K] extends object ? DeepPartial<T[K]> : T[K]
}

export type SettingsPatch = DeepPartial<Settings>

export const STAGE_KEYS: readonly StageKey[] = ['news', 'triage', 'screen', 'confirm', 'analyze', 'verify', 'translate', 'srcCheck', 'srcDiscover']

/** Тема по умолчанию (docs/05 §7), английский текст дословно (многострочный). */
export const DEFAULT_TOPIC = `Any new law, amendment or regulation (draft, adopted, published or entering into force) that could materially affect banks and other financial institutions or an equity investor in them:
- banking law and central bank / financial regulator acts: prudential norms, capital, liquidity, risk management, licensing, reporting and disclosure, related-party rules, resolution and recovery, deposit insurance;
- corporate and joint-stock company law, corporate governance rules and codes, board composition, fit-and-proper requirements, shareholder and minority rights;
- ownership: foreign ownership limits, acquisition and change-of-control approvals, privatisation of state-owned banks;
- dividends and exit: dividend restrictions, securities and listing rules relevant to bank IPOs, currency control and capital repatriation;
- taxation of banks, dividends and capital gains;
- AML/CFT and sanctions;
- consumer lending, interest-rate caps, payments, digital banking, data protection affecting banks;
- Islamic finance and microfinance.
Exclude: personnel appointments, decisions about individual persons or companies (except bank licence revocations and sanctions on banks), acts of other sectors without financial impact.`

export const DEFAULT_TOPIC_RU =
  'Изменения, которые могут существенно повлиять на банки и другие финансовые институты или на инвестора в их капитал: банковское и корпоративное право, владение и контроль, дивиденды и выход, налоги, валютный контроль, AML, потребительское кредитование и др.'

/** «Для кого оценивать значимость» по умолчанию (docs/05 §6.1). */
export const DEFAULT_PERSPECTIVE =
  'Private equity firm holding minority and majority equity stakes in banks and other financial institutions. Cares about enterprise value, control and governance rights, dividends and exit options, regulatory capital, compliance cost and regulatory risk.'
export const DEFAULT_PERSPECTIVE_RU =
  'PE-фирма с долями в капитале банков и финансовых институтов: стоимость, права контроля, дивиденды и выход, капитал, стоимость соблюдения требований'

// ---- Страны и источники (docs/08, CTY) ----

export type SourceType = 'legal_base' | 'regulator' | 'drafts' | 'news'
export type SourceState = 'unchecked' | 'ok' | 'warn' | 'fail'

export interface SeenItem {
  title: string
  date: string
  url: string
}

export interface Source {
  id: string
  name: string
  url: string
  type: SourceType
  language: string
  priority: 'main' | 'extra'
  enabled: boolean
  state: SourceState
  stateReason: string
  checkedAt: string | null
  seenLatest: SeenItem[]
  note: string
  /**
   * Профиль извлечения (docs/02 §10). Заполняет `/verify-sources` (фаза 6); нет поля или null — способа чтения
   * пока нет (для lex.uz не нужен: адаптер). Необязательно, чтобы прежние записи countries.json оставались валидными.
   */
  profile?: ExtractionProfile | null
}

export interface WatchedAct {
  id: string
  title: string
  registrationNumber: string
  url: string
  state: SourceState
  stateReason: string
  /** Когда акт проверялся проверкой источников (SRC-06); нет поля — не проверялся. */
  checkedAt?: string | null
}

export interface Country {
  /** ISO 3166-1 alpha-2, заглавные. */
  code: string
  /** Название по-русски. */
  name: string
  /** ISO 639-1. */
  languages: string[]
  active: boolean
  sources: Source[]
  watchedActs: WatchedAct[]
  lastCheckedAt: string | null
  lastRunSummary: string
  /** Правила классов органов (SCR); нет — берутся стартовые для страны, а для остальных стран класс 2. */
  issuerClasses?: { class1: string[]; class2: string[] }
}

export interface CatalogCountry {
  code: string
  nameRu: string
  languages: string[]
}
