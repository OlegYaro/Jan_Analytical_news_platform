// Типы ответов модели. Источник: docs/04-schemas.md §1–8; JSON Schema лежат в schemas/*.json.

export type ISODate = string // "YYYY-MM-DD"
export type Unknown = 'unknown'

/** Факт с доказательством. Если value = 'unknown', quote и url могут быть пустыми строками. */
export interface Fact<T = string> {
  value: T | Unknown
  quote: string // дословно, язык оригинала, ≤ 300 символов
  url: string
}

export type TriageDecision = 'relevant' | 'borderline' | 'irrelevant'

export type ReasonCode =
  | 'other_sector'
  | 'personnel_appointment'
  | 'individual_decision'
  | 'not_regulatory'
  | 'duplicate_of_other_candidate'
  | 'outside_date_window'

export type ActStage = 'draft' | 'adopted' | 'registered' | 'published' | 'in_force'

export interface TriageOutput {
  country: string
  items: Array<{
    id: string
    decision: TriageDecision
    reason_code: null | ReasonCode
    reason_text: string // ≤ 200 символов
    confidence: 'high' | 'medium' | 'low'
  }>
}

export interface Card {
  candidate_id: string
  country: string
  act: {
    type: Fact
    issuer: Fact
    number: Fact
    title_original: Fact
    title_en: string
    adoption_date: Fact<ISODate>
    registration_number: Fact
    registration_date: Fact<ISODate>
    publication_date: Fact<ISODate>
    effective_date: Fact<ISODate>
    transition_period: { exists: Fact<'yes' | 'no'>; details: string }
    original_language: string
    official_russian_text: 'yes' | 'no' | 'unknown'
  }
  /** Тема акта в 3–5 английских слов для письма (ANA-10). Нет в старых карточках: письмо берёт запасной вариант. */
  headline?: string
  /** До 3 главных изменений для письма (подмножество changes[]). */
  top_changes?: Array<{
    n: number
    location: string
    summary_en: string
    implementation_difficulty: 'low' | 'medium' | 'high'
  }>
  stage: ActStage
  update_of: null | { ledger_key: string; what_changed: string }
  amends: {
    base_act_title: Fact
    base_act_number: Fact
    base_act_url: string
    prior_amendments: Array<{ number: string; date: ISODate | Unknown; url: string }>
  }
  scope: { applies_to: Fact; not_applies_to: Fact }
  change_count: {
    annex_items: Fact<number>
    legal_base_marks: Fact<number>
    explanation: string
  }
  changes: Array<{
    n: number
    location: string
    kind: 'rewritten' | 'added' | 'repealed' | 'new_chapter'
    summary_en: string
    significance: 'significant' | 'less_significant' | 'not_significant'
    significance_reason: string
    implementation_difficulty: 'low' | 'medium' | 'high'
    difficulty_reason: string
    quote: string
    url: string
  }>
  links: { amending_act: string; current_version: string; version_on_effective_date: string }
  unknowns: string[] // пути полей со значением unknown
  notes: string
}

export type ScreenDecision = 'material' | 'minor' | 'none' | 'unsure'

/** Ответ `/screen-act` (SCR): режим `screen` — первое решение, `confirm` — перепроверка сомнительного. */
export interface ScreenOutput {
  country: string
  mode: 'screen' | 'confirm'
  items: Array<{
    id: string
    decision: ScreenDecision
    points: string[] // ≤ 5
    quote: string // дословно из переданных фрагментов, ≤ 300 символов; пусто только при unsure без текста
    reason: string // ≤ 200 символов
    confidence: 'high' | 'medium' | 'low'
  }>
}

export interface Verification {
  country: string
  cards: Array<{
    candidate_id: string
    fields: Array<{
      field: string // путь, напр. "act.effective_date", "changes[3].location"
      status: 'ok' | 'mismatch' | 'unverifiable'
      correct_value?: string
      quote?: string
      url?: string
      comment: string
    }>
    verdict: 'confirmed' | 'needs_correction' | 'unconfirmed'
  }>
  returned: Array<{ id: string; reason: string }>
  watched_acts_check: Array<{
    registration_number: string
    new_edition_found: boolean
    edition_date?: ISODate
    url?: string
  }>
}

export interface SourcesCheck {
  country: string
  sources: Array<{
    id: string
    reachable: boolean
    login_or_captcha: boolean
    final_url: string
    official: boolean
    official_reason: string
    type_matches: boolean
    has_dated_listing: boolean
    needs_js: 'yes' | 'no' | 'unknown'
    language: string
    profile: null | {
      kind: 'rss' | 'html_list' | 'json_api'
      url: string
      item?: string
      title?: string
      link?: string
      date?: string
      date_format?: string
      issuer?: string
      pagination?: { param: string; max_pages: number }
      json_paths?: { items: string; title: string; link: string; date: string }
    }
    seen_latest: Array<{ title: string; date: string; url: string }> // ≤ 5
    verdict: 'ok' | 'warn' | 'fail'
    reasons: string[]
  }>
  watched_acts: Array<{ registration_number: string; verdict: 'ok' | 'warn' | 'fail'; reason: string }>
}

export interface DiscoverSources {
  country: string
  proposals: Array<{
    type: 'legal_base' | 'regulator' | 'drafts' | 'news'
    name: string
    url: string
    listing_url: string
    language: string
    reason: string
  }>
  /** Режим поиска отслеживаемых актов (SRC-09): пусто, если режим не запрашивался. */
  watched_act_proposals: Array<{
    act_type:
      | 'banking_law'
      | 'central_bank_law'
      | 'joint_stock_law'
      | 'fx_law'
      | 'aml_law'
      | 'deposit_insurance_law'
      | 'cb_corporate_governance'
    title_original: string
    number: string
    url: string
    last_edition_date: ISODate | Unknown
    quote: string
    reason: string
  }>
}

export interface NewsSweep {
  country: string
  leads: Array<{
    headline: string
    outlet: string
    date: ISODate
    url: string
    act_number: string
    act_date: string
    issuer: string
    summary: string
  }>
}

/** Ответ `/translate-ru`: русский перевод коротких фрагментов письма, по id входа (`{ glossary, items:[{id,text}] }`). */
export interface Translation {
  items: Array<{ id: string; ru: string }>
}
