// Проверка и поиск источников (фаза 6, SRC-01..09): данные для окна. Чистые типы без логики.
import type { ExtractionProfile } from './profile-types.ts'
import type { SeenItem, SourceState, SourceType } from './types.ts'

/** Что проверять: один источник страны, всю страну или все страны. */
export interface SourceCheckScope {
  code?: string
  sourceId?: string
  all?: boolean
}

/** Состояние фоновой проверки/поиска источников. */
export interface SourcesStatusDto {
  running: boolean
  /** Что происходит сейчас, по-русски («Казахстан: проверяем adilet.zan.kz (2 из 4)»), или итог последнего задания. */
  text: string
  done: number
  total: number
  startedAt?: string
  finishedAt?: string
  /** Итог последнего задания (по-русски), если оно закончилось. */
  lastMessage?: string
}

/** Предложенный источник, подтверждённый кодом (страница открылась без входа и капчи). */
export interface SourceProposalDto {
  type: SourceType
  name: string
  url: string
  listing_url: string
  language: string
  /** Почему предложен (как ответила модель; английский). */
  reason: string
  /** Что проверил код, по-русски. */
  checkNote: string
  /** Страница списка тоже открылась. */
  listingOk: boolean
  verified: true
}

export type WatchedActType =
  | 'banking_law'
  | 'central_bank_law'
  | 'joint_stock_law'
  | 'fx_law'
  | 'aml_law'
  | 'deposit_insurance_law'
  | 'cb_corporate_governance'

/** Предложенный отслеживаемый акт, подтверждённый кодом (страница открылась и на ней видно название или номер). */
export interface ActProposalDto {
  act_type: WatchedActType
  /** Тип акта по-русски («закон о банках и банковской деятельности»). */
  act_type_ru: string
  title_original: string
  number: string
  url: string
  last_edition_date: string
  quote: string
  reason: string
  checkNote: string
  verified: true
}

export interface DiscoverResultDto {
  ok: boolean
  message: string
  sourceProposals: SourceProposalDto[]
  actProposals: ActProposalDto[]
}

/** Итог проверки одного источника (для журнала и скриптов; в окне — через Source.state/stateReason/seenLatest). */
export interface SourceCheckResultDto {
  sourceId: string
  name: string
  url: string
  type: SourceType
  state: Exclude<SourceState, 'unchecked'>
  reason: string
  /** Как читается: адаптер lex.uz, профиль, никак. */
  method: 'adapter' | 'profile' | 'none'
  /** Сколько документов С ДАТАМИ извлёк код последним способом чтения. */
  extracted: number
  seenLatest: SeenItem[]
  /** Сколько раз модель предлагала способ чтения. */
  rounds: number
  finalUrl?: string
  profile?: ExtractionProfile | null
  /** Совет пользователю (например, сайт переехал на другой адрес). */
  recommendation?: string
  /** Исходные причины модели (английский) — только для журнала. */
  modelReasons?: string[]
  /** Записано в список стран (false — адрес сменили во время проверки или проверка прервана). */
  written: boolean
}

export interface ActCheckResultDto {
  actId: string
  title: string
  url: string
  state: Exclude<SourceState, 'unchecked'>
  reason: string
  written: boolean
}
