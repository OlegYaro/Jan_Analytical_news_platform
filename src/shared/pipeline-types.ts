// Данные конвейера прогона (docs/02 §4): кандидаты, журнал процессов модели, итог страны.
// Чистые типы без логики: ими пользуются оркестратор (main) и экраны «Прогон»/«История» (renderer).

import type { ActStage, CountryStatus, ISODate, RunState, Usage } from './run-types.ts'
import type { Card } from './schema-types.ts'

/** Канал (COL-02): А — история редакций отслеживаемых актов, Б — новые акты, В — проекты, Г — новости. */
export type Channel = 'A' | 'B' | 'C' | 'D'

/** Кандидат, найденный кодом (этап COLLECT или подтверждённая наводка). */
export interface Candidate {
  /** Уникален в пределах страны и прогона; он же — имя папки акта (через safeActId). */
  id: string
  /** Ключ журнала отправленного (TRI-04): `reg:<номер>` или `num:<номер>|<дата>|<url>`. */
  key: string
  title_original: string
  title_en?: string
  issuer: string
  date: string
  doc_type: string
  url: string
  snippet: string
  channel: Channel
  /** Ключ уже в журнале, но, возможно, новая стадия (COL-04): кандидат не отфильтровывается. */
  maybeUpdate?: boolean
  /** Класс органа-издателя (SCR): 1 — финрегулятор, 2 — общий законодатель/неопознан, 3 — прочие. Ставит сборщик. */
  issuerClass?: 1 | 2 | 3
}

/** Этап модели в журнале процессов. */
export type ModelStage = 'news' | 'triage' | 'screen' | 'confirm' | 'analyze' | 'verify' | 'translate'

/** Один процесс `claude -p` для log.jsonl (NFR-13). */
export interface ProcessLog {
  stage: ModelStage
  model: string
  durationMs: number
  /** Токены и стоимость процесса. */
  tokens?: Partial<Usage>
  exitCode: number | null
  /** Сколько попыток сделал раннер (с его собственным повтором). */
  attempts?: number
  /** id акта для ANALYZE. */
  act?: string
  /** Код провала раннера, если процесс не дал результата. */
  failure?: string
  /** Отказанные инструменты (для лога, PRM-02). */
  denied?: string[]
}

/** Результат одного шага: либо ответ, либо понятная причина провала (`failure` — технический код). */
export type Outcome<T> =
  | { ok: true; output: T; usage?: Partial<Usage>; processes?: ProcessLog[] }
  | {
      ok: false
      /** timeout | schema | no_result | max_turns | spawn | source | parser | limit | … */
      failure: string
      /** Русский текст причины простыми словами. */
      message: string
      /** Для `limit`: когда снимется ограничение (ISO). */
      resetsAt?: string
      usage?: Partial<Usage>
      processes?: ProcessLog[]
    }

/** Источник не ответил (COV-04). `critical` — единственный источник своего типа → `failed:source`. */
export interface SourceFailure {
  sourceId: string
  message: string
  critical: boolean
}

/** Аномалия «0 документов» (COV-05) → `failed:parser`. */
export interface SourceAnomaly {
  sourceId: string
  median: number
  message?: string
}

/** Ответ этапа COLLECT (код, 0 токенов). */
export interface CollectOutput {
  candidates: Candidate[]
  sourceFailures?: SourceFailure[]
  anomalies?: SourceAnomaly[]
  /** Число документов по источникам → state/source-health.json (только scheduled/manual). */
  sourceCounts?: Array<{ sourceId: string; count: number }>
}

/** Файл candidates.json страны (пишет оркестратор). */
export interface CandidatesFile {
  country: string
  window: { from: ISODate; to: ISODate }
  /** Кандидаты, которые идут в TRIAGE (после фильтра журнала) и добавленные позже (наводки, канал А). */
  candidates: Candidate[]
  /** Отфильтровано журналом отправленного (COL-04). */
  filtered_by_ledger: Array<{ id: string; key: string }>
  source_failures: SourceFailure[]
  anomalies: SourceAnomaly[]
  source_counts: Array<{ sourceId: string; count: number }>
}

/** Запись для журнала отправленного: коммитится ТОЛЬКО после успешной отправки (фаза 7). */
export interface CommitItem {
  key: string
  stage: ActStage
  effective_date: ISODate | 'unknown'
  title_en: string
}

/** Карточка в результате страны. */
export interface ResultItem {
  candidate_id: string
  key: string
  channel: Channel
  /** Новая находка или «🔄 Обновление» уже отправленного (TRI-05). */
  kind: 'new' | 'update'
  /** Для обновления: дата первого уведомления. */
  first_reported_at?: string
  update_reason?: 'stage' | 'effective_date'
  /** false → в письме «⚠ не подтверждено» со списком спорных полей (VER-03). */
  confirmed: boolean
  disputed_fields: string[]
  /** Число кругов проверки. */
  rounds: number
  title_en: string
  /** Путь к card.json относительно папки страны. */
  card_file: string
}

/** Строка «Для сведения» (экран решил `minor`): акт про банки, но мелкий, без полного разбора. */
export interface ForInfoItem {
  candidate_id: string
  key: string
  title_original: string
  issuer: string
  date: string
  url: string
  /** Одно предложение по-английски: что за акт и почему мелкий. */
  reason: string
  /** Пункты акта, на которые опирался экран. */
  points: string[]
}

/** «⚠ Не удалось проверить»: текста акта нет или страница не открылась (SCR-04, HAL-08). */
export interface UnverifiedItem {
  candidate_id: string
  title_original: string
  issuer: string
  date: string
  url: string
  reason: string
}

/** result.json страны: что попадёт в дайджест и что закоммитить в журнал. */
export interface CountryResult {
  country: string
  status: CountryStatus
  /** Причина сбоя по-русски (для `failed:*`). */
  error?: string
  items: ResultItem[]
  /** Есть, только если работал экран по тексту. */
  for_information?: ForInfoItem[]
  unverified?: UnverifiedItem[]
  /** Дубли уже отправленного: в результат не идут (TRI-05). */
  duplicates: Array<{ candidate_id: string; key: string }>
  warnings: string[]
  /** Пусто в пробном и ретро-режиме (shouldWriteLedger). */
  to_commit: CommitItem[]
}

/** Итог прогона для шагов 7–10 (DIGEST/TRANSLATE/SEND/COMMIT). */
export interface RunReport {
  runDir: string
  state: RunState
  countries: Array<CountryResult & { cards: Record<string, Card> }>
}

/** Чем закончился вызов start()/resume(). */
export type RunEnd = 'finished' | 'paused' | 'stopped'

export type StartResult =
  | { ok: false; blocked: string }
  | { ok: true; end: RunEnd; runDir: string; state: RunState }
