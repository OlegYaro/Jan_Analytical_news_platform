// Контракт экрана «История» (ARC-03, VER-04, HAL-07) между main (history.ts, golden-cases.ts) и renderer.
import type { CountryStatus, RunMode } from './run-types.ts'

/** Строка списка прогонов. */
export interface HistoryRunDto {
  id: string
  mode: RunMode
  startedAt: string
  finishedAt?: string
  stopped: boolean
  paused: boolean
  /** «Проверено N из N»: страны без сбоя / все страны прогона. */
  checked: { ok: number; total: number }
  /** Найдено: существенных / для сведения / не удалось проверить — сумма по странам. */
  found: { material: number; forInfo: number; unverified: number }
  /** Письмо: not_needed | queued | sent | failed; нет данных — undefined. */
  mail?: { state: 'not_needed' | 'queued' | 'sent' | 'failed'; attempts: number }
  countries: Array<{ code: string; status: CountryStatus; material: number; forInfo: number; unverified: number }>
}

/** Одна находка (карточка) страны. */
export interface HistoryFindingDto {
  candidateId: string
  title: string
  url: string
  /** 'material' — полный разбор; 'for_info' — «для сведения»; 'unverified' — «не удалось проверить». */
  level: 'material' | 'for_info' | 'unverified'
  confirmed: boolean
  disputedFields: string[]
  reason?: string
  /** Уже помечено пользователем как «ложное срабатывание». */
  markedFalsePositive?: boolean
}

/** Отброшенный кандидат и почему. */
export interface HistoryDiscardedDto {
  candidateId: string
  title: string
  url: string
  issuer: string
  /** Кто отбросил: отбор по названию / экран по тексту / код / проверка вернула. */
  by: 'triage' | 'screen' | 'code'
  reason: string
}

/** Проверка карточки по полям (VER-04). */
export interface HistoryVerificationDto {
  candidateId: string
  verdict: string
  fields: Array<{ field: string; status: 'ok' | 'mismatch' | 'unverifiable'; comment: string }>
}

export interface HistoryCountryDto {
  runId: string
  code: string
  status: CountryStatus
  error?: string
  findings: HistoryFindingDto[]
  discarded: HistoryDiscardedDto[]
  verification: HistoryVerificationDto[]
  /** Отчёт по стране: текст Markdown на выбранном языке; нет файла — null. */
  reportEn: string | null
  reportRu: string | null
  /** Журнал прогона по стране простыми словами (последние строки). */
  log: Array<{ ts: string; text: string }>
  /** Расход страны в прогоне. */
  usage: { costUsd: number; input: number; output: number; cacheRead: number; cacheWrite: number }
  /** Папка страны в прогоне (для «Открыть в Finder»). */
  dir: string
}

/** Случай для эталонов (HAL-07): ложное срабатывание или пропущенный акт. */
export type GoldenCaseKind = 'false_positive' | 'missed'

export interface GoldenCaseInput {
  kind: GoldenCaseKind
  runId: string
  country: string
  /** false_positive: id кандидата из этого прогона; missed: не нужен. */
  candidateId?: string
  /** missed: ссылка на пропущенный акт (обязательна). */
  url?: string
  comment: string
}

export type GoldenCaseResult = { ok: true; file: string } | { ok: false; error: string }

export interface GoldenCaseDto {
  id: string
  kind: GoldenCaseKind
  country: string
  title: string
  url: string
  comment: string
  createdAt: string
  runId: string
}

export interface HistoryApi {
  list(): Promise<HistoryRunDto[]>
  country(runId: string, code: string): Promise<HistoryCountryDto | null>
  /** Открыть папку прогона/страны в Finder; путь проверяется на принадлежность рабочей папке. */
  openFolder(runId: string, code?: string): Promise<{ ok: boolean; error?: string }>
  addCase(input: GoldenCaseInput): Promise<GoldenCaseResult>
  cases(): Promise<GoldenCaseDto[]>
}
