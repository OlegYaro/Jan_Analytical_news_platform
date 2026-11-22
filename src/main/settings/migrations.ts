import { join } from 'node:path'
import type { ScheduleEntry, Settings } from '../../shared/types.ts'
import { MAX_SCHEDULES, STAGE_KEYS } from '../../shared/types.ts'
import { DEFAULT_PERSPECTIVE, DEFAULT_TOPIC } from '../../shared/types.ts'
import { SCHEDULE_COUNTRY_RE, SCHEDULE_ID_RE, SCHEDULE_NAME_MAX, SCHEDULE_TIME_RE } from '../../shared/schedule-types.ts'
import { SCHEMA_VERSION, defaultSchedule, defaultSettings } from './defaults.ts'
import { LEGACY_DEFAULT_PERSPECTIVES, LEGACY_DEFAULT_TOPICS } from './legacy-defaults.ts'

type Raw = Record<string, unknown>

const squash = (t: string): string => t.replace(/\s+/g, ' ').trim()

/** migrations[n] переводит файл версии n в версию n+1. Версия 0 = файл без schemaVersion. */
const migrations: Record<number, (raw: Raw, homeDir: string) => Raw> = {
  0: (raw) => raw,
  // v2: стандартная папка ~/Documents/RegWatch заменена на ~/RegWatch (Documents защищена macOS и вызывает запрос доступа).
  1: (raw, homeDir) => {
    if (raw.workspaceDir === join(homeDir, 'Documents', 'RegWatch')) {
      const { workspaceDir: _old, ...rest } = raw
      return rest
    }
    return raw
  },
  // v3: новые тема и «для кого оценивать» по умолчанию (docs/05 §6.1, §7). Меняем только нетронутые прежние значения.
  2: (raw) => {
    const out: Raw = { ...raw }
    if (typeof raw.topic === 'string' && LEGACY_DEFAULT_TOPICS.some((t) => squash(t) === squash(raw.topic as string))) out.topic = DEFAULT_TOPIC
    if (typeof raw.perspective === 'string' && LEGACY_DEFAULT_PERSPECTIVES.some((t) => squash(t) === squash(raw.perspective as string))) {
      out.perspective = DEFAULT_PERSPECTIVE
    }
    return out
  },
  // v4: одно расписание (scheduleDays/scheduleTime) → список расписаний schedules; язык интерфейса.
  // Прочие ключи (в том числе неизвестные) не трогаются: лишнее отбрасывает только общий добор fill().
  3: (raw) => {
    const { scheduleDays, scheduleTime, ...rest } = raw
    const out: Raw = { ...rest }
    if (!Array.isArray(raw.schedules)) {
      const def = defaultSchedule()
      const days = cleanDays(scheduleDays)
      out.schedules = [
        {
          ...def,
          days: days.length > 0 ? days : def.days,
          time: typeof scheduleTime === 'string' && SCHEDULE_TIME_RE.test(scheduleTime) ? scheduleTime : def.time,
        },
      ]
    }
    if (raw.uiLanguage !== 'ru' && raw.uiLanguage !== 'en') out.uiLanguage = 'ru'
    return out
  },
}

/** Дни недели 0..6 без повторов, по порядку; всё остальное отбрасывается. */
function cleanDays(v: unknown): number[] {
  if (!Array.isArray(v)) return []
  return [...new Set(v.filter((x): x is number => Number.isInteger(x) && x >= 0 && x <= 6))].sort((a, b) => a - b)
}

/**
 * Приводит список расписаний к схеме (файл могли испортить вручную). Для данных, прошедших validateSettings,
 * меняет только порядок дней и повторы. Пусто или ничего годного — одно расписание по умолчанию.
 */
export function normalizeSchedules(v: unknown): ScheduleEntry[] {
  const out: ScheduleEntry[] = []
  const ids = new Set<string>()
  const list = Array.isArray(v) ? v : []
  for (const item of list) {
    if (out.length >= MAX_SCHEDULES) break
    if (!isObj(item)) continue
    const def = defaultSchedule()
    let id = typeof item.id === 'string' && SCHEDULE_ID_RE.test(item.id) ? item.id : ''
    if (!id || ids.has(id)) {
      let n = out.length + 1
      while (ids.has(`s${n}`)) n++
      id = `s${n}`
    }
    ids.add(id)
    const name = typeof item.name === 'string' ? item.name.trim().slice(0, SCHEDULE_NAME_MAX) : ''
    const days = cleanDays(item.days)
    const countries = Array.isArray(item.countries)
      ? [...new Set(item.countries.filter((c): c is string => typeof c === 'string').map((c) => c.trim().toUpperCase()))].filter((c) => SCHEDULE_COUNTRY_RE.test(c))
      : []
    out.push({
      id,
      name: name || `Расписание ${out.length + 1}`,
      enabled: typeof item.enabled === 'boolean' ? item.enabled : true,
      days: days.length > 0 ? days : def.days,
      time: typeof item.time === 'string' && SCHEDULE_TIME_RE.test(item.time) ? item.time : def.time,
      countries,
    })
  }
  return out.length > 0 ? out : [defaultSchedule()]
}

function isObj(v: unknown): v is Raw {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function sameKind(a: unknown, b: unknown): boolean {
  if (Array.isArray(b)) return Array.isArray(a)
  return typeof a === typeof b
}

/** Берёт из raw только известные поля того же типа, остальное — из defaults. */
function fill(raw: unknown, def: Raw, skip: ReadonlySet<string>): Raw {
  const src = isObj(raw) ? raw : {}
  const out: Raw = {}
  for (const key of Object.keys(def)) {
    const d = def[key]
    const v = src[key]
    if (skip.has(key)) out[key] = d
    else if (isObj(d)) out[key] = fill(v, d, skip)
    else if (v !== undefined && sameKind(v, d)) out[key] = Array.isArray(v) ? [...v] : v
    else out[key] = Array.isArray(d) ? [...d] : d
  }
  return out
}

function stageRecord(raw: unknown, type: 'string' | 'number'): Raw {
  const out: Raw = {}
  if (!isObj(raw)) return out
  for (const k of STAGE_KEYS) if (typeof raw[k] === type) out[k] = raw[k]
  return out
}

/** Приводит прочитанный файл к актуальной схеме: миграции, добор из defaults, отбрасывание лишнего. */
export function migrateSettings(raw: unknown, homeDir: string): Settings {
  let obj: Raw = isObj(raw) ? raw : {}
  let version = typeof obj.schemaVersion === 'number' && obj.schemaVersion >= 0 ? Math.floor(obj.schemaVersion) : 0
  while (version < SCHEMA_VERSION) {
    obj = migrations[version]?.(obj, homeDir) ?? obj
    version++
  }
  const def = defaultSettings(homeDir) as unknown as Raw
  const out = fill(obj, def, new Set<string>()) as unknown as Settings
  const adv = isObj(obj.advanced) ? obj.advanced : {}
  out.advanced.stageModels = stageRecord(adv.stageModels, 'string') as Settings['advanced']['stageModels']
  out.advanced.timeoutsMin = stageRecord(adv.timeoutsMin, 'number') as Settings['advanced']['timeoutsMin']
  out.schedules = normalizeSchedules(obj.schedules)
  if (out.uiLanguage !== 'ru' && out.uiLanguage !== 'en') out.uiLanguage = 'ru'
  out.schemaVersion = SCHEMA_VERSION
  return out
}
