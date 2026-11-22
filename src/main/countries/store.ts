import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CountriesResult } from '../../shared/api.ts'
import type { ExtractionProfile } from '../../shared/profile-types.ts'
import type { UiLanguage, Country, SeenItem, Source, SourceState, SourceType, WatchedAct } from '../../shared/types.ts'
import { seedCountries } from './seed.ts'
import { langFromDir, mt } from '../i18n.ts'

export const COUNTRIES_FILE = 'countries.json'
export const COUNTRIES_SCHEMA_VERSION = 2
const SOURCE_TYPES: readonly SourceType[] = ['legal_base', 'regulator', 'drafts', 'news']

export interface CountryInput {
  code: string
  name: string
  languages: string[]
}
export interface IssuerClassesInput {
  class1: string[]
  class2: string[]
}
export interface CountryPatch {
  name?: string
  languages?: string[]
  /** Правила классов органов; null — вернуть стартовые (поле удаляется). */
  issuerClasses?: IssuerClassesInput | null
}

export const ISSUER_MAX_ITEMS = 50
export const ISSUER_MAX_LEN = 120
export interface SourceInput {
  name?: string
  url: string
  type: SourceType
  language: string
  priority?: 'main' | 'extra'
  enabled?: boolean
  note?: string
}
export type SourcePatch = Partial<SourceInput>
export interface ActInput {
  title: string
  registrationNumber?: string
  url: string
}
export type ActPatch = Partial<ActInput>

function atomicWrite(file: string, text: string): void {
  const tmp = `${file}.tmp-${process.pid}`
  try {
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, file)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}

function save(dir: string, countries: Country[]): void {
  mkdirSync(dir, { recursive: true })
  atomicWrite(
    join(dir, COUNTRIES_FILE),
    JSON.stringify({ schemaVersion: COUNTRIES_SCHEMA_VERSION, countries }, null, 2) + '\n',
  )
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Миграции файла стран: migrations[n] переводит версию n в n+1.
 * v1→v2: добавлена Монголия (docs/08). Только при переходе; удалённая позже страна не возвращается.
 */
const migrations: Record<number, (list: Country[]) => Country[]> = {
  1: (list) => {
    if (list.some((c) => c.code === 'MN')) return list
    const mn = seedCountries().find((c) => c.code === 'MN')
    return mn ? [...list, mn] : list
  },
}

/** Читает список стран; нет файла или он битый — создаёт из стартового набора (CTY-08). */
export function loadCountries(dir: string): Country[] {
  const file = join(dir, COUNTRIES_FILE)
  if (existsSync(file)) {
    try {
      const raw: unknown = JSON.parse(readFileSync(file, 'utf8'))
      if (isObj(raw) && Array.isArray(raw['countries']) && raw['countries'].every((c) => isObj(c) && typeof c['code'] === 'string')) {
        let list = raw['countries'] as Country[]
        let version = typeof raw['schemaVersion'] === 'number' && raw['schemaVersion'] >= 1 ? Math.floor(raw['schemaVersion']) : 1
        if (version < COUNTRIES_SCHEMA_VERSION) {
          while (version < COUNTRIES_SCHEMA_VERSION) {
            list = migrations[version]?.(list) ?? list
            version++
          }
          save(dir, list)
        }
        return list
      }
      throw new Error('bad shape')
    } catch {
      try {
        renameSync(file, file + '.bak')
      } catch {
        /* ignore */
      }
    }
  }
  const seed = seedCountries()
  save(dir, seed)
  return seed
}

const fail = (countries: Country[], errors: Record<string, string>): CountriesResult => ({ ok: false, errors, countries })

type Mutator = (list: Country[]) => Record<string, string> | null

/** Общий путь: загрузить, применить, при ошибках не писать ничего. */
function mutate(dir: string, fn: Mutator): CountriesResult {
  curLang = langFromDir(dir)
  const list = loadCountries(dir)
  const draft: Country[] = structuredClone(list)
  const errors = fn(draft)
  if (errors && Object.keys(errors).length > 0) return fail(list, errors)
  save(dir, draft)
  return { ok: true, errors: {}, countries: draft }
}

/** Язык текстов ошибок: выставляется в начале каждой (синхронной) операции из settings.json рядом со списком стран. */
let curLang: UiLanguage = 'ru'
const L = (ru: string, en: string): string => mt(curLang, ru, en)
const noCountry = (): Record<string, string> => ({ code: L('Страна не найдена', 'Country not found') })

function checkLanguages(languages: unknown, errors: Record<string, string>): string[] {
  if (!Array.isArray(languages) || languages.length === 0) {
    errors['languages'] = mt(curLang, 'Укажите хотя бы один язык', 'Specify at least one language')
    return []
  }
  const out: string[] = []
  for (const l of languages) {
    const v = typeof l === 'string' ? l.trim().toLowerCase() : ''
    if (!/^[a-z]{2,3}$/.test(v)) {
      errors['languages'] = mt(curLang, 'Язык указывается кодом из двух букв, например ru', 'The language is given as a two-letter code, for example ru')
      return []
    }
    if (!out.includes(v)) out.push(v)
  }
  return out
}

/** Список органов: строки обрезаются, пустые и повторы убираются; ≤ 50 штук по ≤ 120 знаков. */
function checkIssuerList(v: unknown, field: string, errors: Record<string, string>): string[] {
  if (!Array.isArray(v)) {
    errors[field] = mt(curLang, 'Список органов задан неверно', 'The list of authorities is invalid')
    return []
  }
  const out: string[] = []
  for (const item of v) {
    if (typeof item !== 'string') {
      errors[field] = mt(curLang, 'Каждый орган — строка текста', 'Each authority must be a text string')
      return []
    }
    const t = item.trim().replace(/\s+/g, ' ')
    if (!t) continue
    if (t.length > ISSUER_MAX_LEN) {
      errors[field] = mt(curLang, `Название органа длиннее ${ISSUER_MAX_LEN} знаков: «${t.slice(0, 30)}…»`, `The authority name is longer than ${ISSUER_MAX_LEN} characters: "${t.slice(0, 30)}…"`)
      return []
    }
    if (!out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t)
  }
  if (out.length > ISSUER_MAX_ITEMS) {
    errors[field] = mt(curLang, `Слишком много органов: не больше ${ISSUER_MAX_ITEMS}`, `Too many authorities: at most ${ISSUER_MAX_ITEMS}`)
    return []
  }
  return out
}

function checkName(name: unknown, errors: Record<string, string>): string {
  const v = typeof name === 'string' ? name.trim() : ''
  if (!v) errors['name'] = mt(curLang, 'Введите название', 'Enter a name')
  return v
}

/** http(s)-адрес; схему не угадываем. */
function checkUrl(url: unknown, errors: Record<string, string>): string {
  const v = typeof url === 'string' ? url.trim() : ''
  if (!v) {
    errors['url'] = mt(curLang, 'Введите адрес', 'Enter an address')
    return ''
  }
  if (!/^https?:\/\//i.test(v)) {
    errors['url'] = mt(curLang, 'Адрес должен начинаться с https://', 'The address must start with https://')
    return ''
  }
  try {
    const u = new URL(v)
    if (!u.hostname) throw new Error('no host')
  } catch {
    errors['url'] = mt(curLang, 'Адрес записан неправильно. Пример: https://example.org', 'The address is malformed. Example: https://example.org')
    return ''
  }
  return v
}

export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url)
    u.hash = ''
    return (u.protocol + '//' + u.host + u.pathname.replace(/\/+$/, '') + u.search).toLowerCase()
  } catch {
    return url.trim().toLowerCase()
  }
}

function hostName(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

export function addCountry(dir: string, input: CountryInput): CountriesResult {
  return mutate(dir, (list) => {
    const errors: Record<string, string> = {}
    const code = typeof input.code === 'string' ? input.code.trim().toUpperCase() : ''
    if (!/^[A-Z]{2}$/.test(code)) errors['code'] = mt(curLang, 'Код страны — две латинские буквы, например UZ', 'The country code is two Latin letters, for example UZ')
    else if (list.some((c) => c.code === code)) errors['code'] = mt(curLang, 'Такая страна уже есть в списке', 'This country is already in the list')
    const name = checkName(input.name, errors)
    const languages = checkLanguages(input.languages, errors)
    if (Object.keys(errors).length > 0) return errors
    list.push({ code, name, languages, active: true, sources: [], watchedActs: [], lastCheckedAt: null, lastRunSummary: '' })
    return null
  })
}

/** Удаляет только запись о стране. Архив прогонов и журнал отправленного в рабочей папке не трогаем (CTY-03). */
export function removeCountry(dir: string, code: string): CountriesResult {
  return mutate(dir, (list) => {
    const i = list.findIndex((c) => c.code === code)
    if (i < 0) return noCountry()
    list.splice(i, 1)
    return null
  })
}

export function setCountryActive(dir: string, code: string, active: boolean): CountriesResult {
  return mutate(dir, (list) => {
    const c = list.find((x) => x.code === code)
    if (!c) return noCountry()
    c.active = Boolean(active)
    return null
  })
}

export function updateCountry(dir: string, code: string, patch: CountryPatch): CountriesResult {
  return mutate(dir, (list) => {
    const c = list.find((x) => x.code === code)
    if (!c) return noCountry()
    const errors: Record<string, string> = {}
    const name = patch.name !== undefined ? checkName(patch.name, errors) : c.name
    const languages = patch.languages !== undefined ? checkLanguages(patch.languages, errors) : c.languages
    let issuer: IssuerClassesInput | null | undefined
    if (patch.issuerClasses === null) issuer = null
    else if (patch.issuerClasses !== undefined) {
      if (typeof patch.issuerClasses !== 'object') errors['issuerClasses'] = mt(curLang, 'Правила органов заданы неверно', 'The authority rules are invalid')
      else issuer = { class1: checkIssuerList(patch.issuerClasses.class1, 'class1', errors), class2: checkIssuerList(patch.issuerClasses.class2, 'class2', errors) }
    }
    if (Object.keys(errors).length > 0) return errors
    c.name = name
    c.languages = languages
    if (issuer === null) delete c.issuerClasses
    else if (issuer) c.issuerClasses = issuer
    return null
  })
}

function isDupUrl(urls: string[], url: string): boolean {
  const n = normalizeUrl(url)
  return urls.some((u) => normalizeUrl(u) === n)
}

export function addSource(dir: string, code: string, input: SourceInput): CountriesResult {
  return mutate(dir, (list) => {
    const c = list.find((x) => x.code === code)
    if (!c) return noCountry()
    const errors: Record<string, string> = {}
    const url = checkUrl(input.url, errors)
    if (url && isDupUrl(c.sources.map((s) => s.url), url)) errors['url'] = mt(curLang, 'Такой адрес у этой страны уже есть', 'This country already has this address')
    if (!SOURCE_TYPES.includes(input.type)) errors['type'] = mt(curLang, 'Выберите тип источника из списка', 'Choose a source type from the list')
    const language = typeof input.language === 'string' ? input.language.trim().toLowerCase() : ''
    if (!language) errors['language'] = mt(curLang, 'Укажите язык источника', 'Specify the source language')
    if (input.priority !== undefined && input.priority !== 'main' && input.priority !== 'extra') errors['priority'] = mt(curLang, 'Приоритет: основной или дополнительный', 'Priority: main or additional')
    if (Object.keys(errors).length > 0) return errors
    const s: Source = {
      id: randomUUID(),
      name: (input.name ?? '').trim() || hostName(url),
      url,
      type: input.type,
      language,
      priority: input.priority ?? 'main',
      enabled: input.enabled ?? true,
      state: 'unchecked',
      stateReason: '',
      checkedAt: null,
      seenLatest: [],
      note: (input.note ?? '').trim(),
    }
    c.sources.push(s)
    return null
  })
}

export function updateSource(dir: string, code: string, id: string, patch: SourcePatch): CountriesResult {
  return mutate(dir, (list) => {
    const c = list.find((x) => x.code === code)
    if (!c) return noCountry()
    const s = c.sources.find((x) => x.id === id)
    if (!s) return { id: mt(curLang, 'Источник не найден', 'Source not found') }
    const errors: Record<string, string> = {}
    let url = s.url
    if (patch.url !== undefined) {
      url = checkUrl(patch.url, errors)
      if (url && isDupUrl(c.sources.filter((x) => x.id !== id).map((x) => x.url), url)) errors['url'] = mt(curLang, 'Такой адрес у этой страны уже есть', 'This country already has this address')
    }
    if (patch.type !== undefined && !SOURCE_TYPES.includes(patch.type)) errors['type'] = mt(curLang, 'Выберите тип источника из списка', 'Choose a source type from the list')
    let language = s.language
    if (patch.language !== undefined) {
      language = typeof patch.language === 'string' ? patch.language.trim().toLowerCase() : ''
      if (!language) errors['language'] = mt(curLang, 'Укажите язык источника', 'Specify the source language')
    }
    if (patch.priority !== undefined && patch.priority !== 'main' && patch.priority !== 'extra') errors['priority'] = mt(curLang, 'Приоритет: основной или дополнительный', 'Priority: main or additional')
    if (Object.keys(errors).length > 0) return errors
    if (url !== s.url) {
      s.url = url
      s.state = 'unchecked' // новый адрес ещё не проверялся
      s.stateReason = ''
      s.checkedAt = null
      s.seenLatest = []
      if (s.profile) s.profile = null // профиль был подобран под прежний адрес
    }
    if (patch.name !== undefined) s.name = patch.name.trim() || hostName(s.url)
    if (patch.type !== undefined) s.type = patch.type
    s.language = language
    if (patch.priority !== undefined) s.priority = patch.priority
    if (patch.enabled !== undefined) s.enabled = Boolean(patch.enabled)
    if (patch.note !== undefined) s.note = patch.note.trim()
    return null
  })
}

/**
 * Состояние источника, выставленное кодом (SRC-08: профиль сломался в прогоне → ⚠). Не из окна: UI его не меняет.
 * Если состояние и причина уже такие же — файл не переписывается и `checkedAt` не трогается.
 */
export function setSourceState(
  dir: string,
  code: string,
  id: string,
  state: SourceState,
  stateReason: string,
  now: Date = new Date(),
  check?: SourceCheckPatch,
): CountriesResult & { changed: boolean } {
  const list = loadCountries(dir)
  const s = list.find((x) => x.code === code)?.sources.find((x) => x.id === id)
  // Итог проверки источников (check) пишется всегда: проверка была, дата и «что видно на сайте» обновляются.
  if (!check && s && s.state === state && s.stateReason === stateReason) return { ok: true, errors: {}, countries: list, changed: false }
  if (check?.expectUrl !== undefined && s && s.url !== check.expectUrl) {
    // Адрес сменили, пока шла проверка: результат относится к прежнему адресу и не записывается.
    return { ok: false, errors: { url: mt(curLang, 'Адрес источника изменился во время проверки — проверьте его ещё раз', 'The source address changed during the check — check it again') }, countries: list, changed: false }
  }
  const r = mutate(dir, (draft) => {
    const c = draft.find((x) => x.code === code)
    if (!c) return noCountry()
    const src = c.sources.find((x) => x.id === id)
    if (!src) return { id: mt(curLang, 'Источник не найден', 'Source not found') }
    src.state = state
    src.stateReason = stateReason
    src.checkedAt = now.toISOString()
    if (check) {
      if (check.seenLatest !== undefined) src.seenLatest = check.seenLatest.slice(0, 5).map((x) => ({ title: x.title, date: x.date, url: x.url }))
      if (check.profile !== undefined) src.profile = check.profile
    }
    return null
  })
  return { ...r, changed: r.ok }
}

/**
 * Дополнение к setSourceState от проверки источников (SRC-03/04): «что видно на сайте» (≤ 5, только извлечённое кодом),
 * профиль извлечения (undefined — не трогать, null — убрать) и адрес, который проверялся (если адрес успели сменить,
 * результат не пишется).
 */
export interface SourceCheckPatch {
  seenLatest?: SeenItem[]
  profile?: ExtractionProfile | null
  expectUrl?: string
}

/** Состояние отслеживаемого акта по итогам проверки (SRC-06). Адрес сменили во время проверки — не пишется. */
export function setWatchedActState(
  dir: string,
  code: string,
  id: string,
  state: SourceState,
  stateReason: string,
  now: Date = new Date(),
  expectUrl?: string,
): CountriesResult {
  return mutate(dir, (draft): Record<string, string> | null => {
    const c = draft.find((x) => x.code === code)
    if (!c) return noCountry()
    const a = c.watchedActs.find((x) => x.id === id)
    if (!a) return { id: mt(curLang, 'Акт не найден', 'Act not found') }
    if (expectUrl !== undefined && a.url !== expectUrl) return { url: mt(curLang, 'Ссылка на акт изменилась во время проверки — проверьте его ещё раз', 'The act link changed during the check — check it again') }
    a.state = state
    a.stateReason = stateReason
    a.checkedAt = now.toISOString()
    return null
  })
}

export function removeSource(dir: string, code: string, id: string): CountriesResult {
  return mutate(dir, (list) => {
    const c = list.find((x) => x.code === code)
    if (!c) return noCountry()
    const i = c.sources.findIndex((x) => x.id === id)
    if (i < 0) return { id: mt(curLang, 'Источник не найден', 'Source not found') }
    c.sources.splice(i, 1)
    return null
  })
}

function checkActFields(title: string, url: unknown, errors: Record<string, string>): string {
  if (!title.trim()) errors['title'] = mt(curLang, 'Введите название акта', 'Enter the act title')
  const u = typeof url === 'string' ? url.trim() : ''
  if (!u) {
    errors['url'] = mt(curLang, 'Укажите ссылку на акт', 'Specify the act link')
    return ''
  }
  return checkUrl(u, errors)
}

export function addWatchedAct(dir: string, code: string, input: ActInput): CountriesResult {
  return mutate(dir, (list) => {
    const c = list.find((x) => x.code === code)
    if (!c) return noCountry()
    const errors: Record<string, string> = {}
    const title = typeof input.title === 'string' ? input.title.trim() : ''
    const url = checkActFields(title, input.url, errors)
    if (Object.keys(errors).length > 0) return errors
    const a: WatchedAct = {
      id: randomUUID(),
      title,
      registrationNumber: (input.registrationNumber ?? '').trim(),
      url,
      state: 'unchecked',
      stateReason: '',
    }
    c.watchedActs.push(a)
    return null
  })
}

export function updateWatchedAct(dir: string, code: string, id: string, patch: ActPatch): CountriesResult {
  return mutate(dir, (list) => {
    const c = list.find((x) => x.code === code)
    if (!c) return noCountry()
    const a = c.watchedActs.find((x) => x.id === id)
    if (!a) return { id: mt(curLang, 'Акт не найден', 'Act not found') }
    const errors: Record<string, string> = {}
    const title = patch.title !== undefined ? String(patch.title).trim() : a.title
    const url = checkActFields(title, patch.url !== undefined ? patch.url : a.url, errors)
    if (Object.keys(errors).length > 0) return errors
    if (url !== a.url) {
      a.state = 'unchecked'
      a.stateReason = ''
      if (a.checkedAt !== undefined) a.checkedAt = null
    }
    a.title = title
    a.url = url
    if (patch.registrationNumber !== undefined) a.registrationNumber = patch.registrationNumber.trim()
    return null
  })
}

export function removeWatchedAct(dir: string, code: string, id: string): CountriesResult {
  return mutate(dir, (list) => {
    const c = list.find((x) => x.code === code)
    if (!c) return noCountry()
    const i = c.watchedActs.findIndex((x) => x.id === id)
    if (i < 0) return { id: mt(curLang, 'Акт не найден', 'Act not found') }
    c.watchedActs.splice(i, 1)
    return null
  })
}
