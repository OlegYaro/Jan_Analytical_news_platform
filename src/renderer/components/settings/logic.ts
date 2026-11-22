// Чистая логика раздела «Настройки»: без React и DOM.
import { MAX_SCHEDULES } from '../../../shared/types.ts'
import { currentLang, L } from '../../i18n.ts'
import type { UiLanguage } from '../../../shared/types.ts'
import type { ScheduleEntry, SettingsPatch, StageKey } from '../../../shared/types.ts'

/** Порядок дней в интерфейсе: Пн..Вс. Значения — как в scheduleDays (0 = воскресенье). */
export const WEEK_ORDER: readonly number[] = [1, 2, 3, 4, 5, 6, 0]
const DAY_NAMES = {
  ru: {
    short: { 0: 'вс', 1: 'пн', 2: 'вт', 3: 'ср', 4: 'чт', 5: 'пт', 6: 'сб' } as Record<number, string>,
    long: {
      0: 'воскресенье', 1: 'понедельник', 2: 'вторник', 3: 'среда', 4: 'четверг', 5: 'пятница', 6: 'суббота',
    } as Record<number, string>,
    months: [
      'января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
    ],
    today: 'сегодня',
    tomorrow: 'завтра',
  },
  en: {
    short: { 0: 'Sun', 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat' } as Record<number, string>,
    long: {
      0: 'Sunday', 1: 'Monday', 2: 'Tuesday', 3: 'Wednesday', 4: 'Thursday', 5: 'Friday', 6: 'Saturday',
    } as Record<number, string>,
    months: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    today: 'today',
    tomorrow: 'tomorrow',
  },
}

/** Названия дней на языке интерфейса (0 = воскресенье). */
export const DAY_SHORT: Record<number, string> = DAY_NAMES[currentLang()].short
export const DAY_LONG: Record<number, string> = DAY_NAMES[currentLang()].long

/** Таймауты по умолчанию, минуты (копия из src/main/settings/presets.ts, docs/02 §6). */
export const DEFAULT_TIMEOUTS_MIN: Record<StageKey, number> = {
  news: 5, triage: 5, screen: 5, confirm: 5, analyze: 10, verify: 10, translate: 5, srcCheck: 10, srcDiscover: 10,
}

export function parseTime(s: string): { h: number; m: number } | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s)
  return m ? { h: Number(m[1]), m: Number(m[2]) } : null
}

/** Ближайший запуск строго после `now` (локальное время) или null, если дни/время не заданы. */
export function nextRun(days: readonly number[], time: string, now: Date): Date | null {
  const tm = parseTime(time)
  if (!tm || days.length === 0) return null
  for (let off = 0; off <= 7; off++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + off, tm.h, tm.m, 0, 0)
    if (d.getTime() > now.getTime() && days.includes(d.getDay())) return d
  }
  return null
}

const pad = (n: number) => String(n).padStart(2, '0')

/**
 * Русский: «понедельник, 08:00» в ближайшие 6 дней, иначе «пн 23 ноября, 08:00»; сегодня/завтра — словами.
 * Английский: «Monday, 08:00», «Mon 23 Nov, 08:00», «today/tomorrow, 08:00».
 */
export function formatNextRun(d: Date, now: Date, lang: UiLanguage = currentLang()): string {
  const n = DAY_NAMES[lang]
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const dayDiff = Math.round(
    (new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() -
      new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86_400_000,
  )
  if (dayDiff === 0) return `${n.today}, ${time}`
  if (dayDiff === 1) return `${n.tomorrow}, ${time}`
  if (dayDiff < 7) return `${n.long[d.getDay()]}, ${time}`
  return `${n.short[d.getDay()]} ${d.getDate()} ${n.months[d.getMonth()]}, ${time}`
}

/** Включить/выключить день; результат отсортирован по возрастанию. */
export function toggleDay(days: readonly number[], day: number): number[] {
  const set = new Set(days)
  if (set.has(day)) set.delete(day)
  else set.add(day)
  return [...set].sort((a, b) => a - b)
}

// ---- Расписания (несколько расписаний со своими странами) ----

/** Порядок выбора дня для нового расписания: сначала понедельник и четверг. */
const DEFAULT_DAY_ORDER: readonly number[] = [1, 4, 2, 3, 5, 6, 0]

/** Новое расписание: уникальные id и название, день, который ещё не занят другими. Время — 08:00, страны — все. */
export function newSchedule(existing: readonly ScheduleEntry[], nameBase = L('Расписание', 'Schedule')): ScheduleEntry {
  const ids = new Set(existing.map((e) => e.id))
  let n = 1
  while (ids.has(`s${n}`)) n++
  const names = new Set(existing.map((e) => e.name))
  let k = existing.length + 1
  while (names.has(`${nameBase} ${k}`)) k++
  const used = new Set(existing.flatMap((e) => e.days))
  const day = DEFAULT_DAY_ORDER.find((d) => !used.has(d)) ?? 1
  return { id: `s${n}`, name: `${nameBase} ${k}`, enabled: true, days: [day], time: '08:00', countries: [] }
}

export function canAddSchedule(list: readonly ScheduleEntry[]): boolean {
  return list.length < MAX_SCHEDULES
}

/** Последнее расписание удалить нельзя. */
export function canRemoveSchedule(list: readonly ScheduleEntry[]): boolean {
  return list.length > 1
}

/** Страны, которые проверяет расписание: пусто = все включённые; выключенные страны не считаются. */
export function effectiveCountries(entry: Pick<ScheduleEntry, 'countries'>, activeCodes: readonly string[]): string[] {
  if (entry.countries.length === 0) return [...activeCodes]
  return entry.countries.filter((c) => activeCodes.includes(c))
}

export function toggleCountry(codes: readonly string[], code: string): string[] {
  return codes.includes(code) ? codes.filter((c) => c !== code) : [...codes, code]
}

/** «Узбекистан, Казахстан» или allLabel, если страны не выбраны. */
export function countriesLabel(
  entry: Pick<ScheduleEntry, 'countries'>,
  known: readonly { code: string; name: string }[],
  allLabel: string,
): string {
  if (entry.countries.length === 0) return allLabel
  return entry.countries.map((c) => known.find((k) => k.code === c)?.name ?? c).join(', ')
}

export interface ScheduleRun {
  index: number
  entry: ScheduleEntry
  date: Date
}

/** Ближайший запуск каждого включённого расписания, по возрастанию времени. */
export function scheduleRuns(list: readonly ScheduleEntry[], now: Date): ScheduleRun[] {
  const out: ScheduleRun[] = []
  list.forEach((entry, index) => {
    if (!entry.enabled) return
    const date = nextRun(entry.days, entry.time, now)
    if (date) out.push({ index, entry, date })
  })
  return out.sort((a, b) => a.date.getTime() - b.date.getTime() || a.index - b.index)
}

/** Ближайший запуск из всех включённых расписаний; entries — все расписания на это же время. */
export function nearestRun(list: readonly ScheduleEntry[], now: Date): { date: Date; entries: ScheduleEntry[] } | null {
  const runs = scheduleRuns(list, now)
  if (runs.length === 0) return null
  const t = runs[0].date.getTime()
  return { date: runs[0].date, entries: runs.filter((r) => r.date.getTime() === t).map((r) => r.entry) }
}

/** Для главной/мастера: «понедельник, 08:00 · страны: Узбекистан, Казахстан» (страны — через запятую, у нескольких расписаний — объединение). */
export function nearestRunText(
  list: readonly ScheduleEntry[],
  now: Date,
  known: readonly { code: string; name: string; active?: boolean }[],
  labels: { countries: string; all: string },
  lang: UiLanguage = currentLang(),
): string | null {
  const n = nearestRun(list, now)
  if (!n) return null
  const when = formatNextRun(n.date, now, lang)
  if (n.entries.some((e) => e.countries.length === 0)) return `${when} · ${labels.countries}: ${labels.all.toLowerCase()}`
  const codes = [...new Set(n.entries.flatMap((e) => e.countries))]
  const names = codes.map((c) => known.find((k) => k.code === c)?.name ?? c).join(', ')
  return `${when} · ${labels.countries}: ${names}`
}

export interface ScheduleOverlap {
  a: number
  b: number
  /** Общие дни (0 = воскресенье), по возрастанию. */
  days: number[]
  /** Общие страны. */
  codes: string[]
}

/** Страна в двух включённых расписаниях в один и тот же день. */
export function findOverlaps(list: readonly ScheduleEntry[], activeCodes: readonly string[]): ScheduleOverlap[] {
  const out: ScheduleOverlap[] = []
  for (let a = 0; a < list.length; a++) {
    for (let b = a + 1; b < list.length; b++) {
      if (!list[a].enabled || !list[b].enabled) continue
      const days = list[a].days.filter((d) => list[b].days.includes(d)).sort((x, y) => x - y)
      if (days.length === 0) continue
      const ca = effectiveCountries(list[a], activeCodes)
      const codes = effectiveCountries(list[b], activeCodes).filter((c) => ca.includes(c))
      if (codes.length > 0) out.push({ a, b, days, codes })
    }
  }
  return out
}

/** Включённые страны, которых нет ни в одном включённом расписании (автоматически не проверяются). */
export function uncoveredCountries(list: readonly ScheduleEntry[], activeCodes: readonly string[]): string[] {
  const covered = new Set<string>()
  for (const e of list) if (e.enabled) for (const c of effectiveCountries(e, activeCodes)) covered.add(c)
  return activeCodes.filter((c) => !covered.has(c))
}

export interface ScheduleErrors {
  /** Ошибки без номера расписания (schedules, schedules.name…). */
  general: string[]
  /** По номеру расписания → поле → текст. */
  byIndex: Record<number, Record<string, string>>
}

/** Ключи вида `schedules.2.days` → {byIndex:{2:{days}}}; прочие `schedules*` → general. */
export function parseScheduleErrors(errors: Record<string, string>): ScheduleErrors {
  const out: ScheduleErrors = { general: [], byIndex: {} }
  for (const [key, msg] of Object.entries(errors)) {
    if (key !== 'schedules' && !key.startsWith('schedules.')) continue
    const m = /^schedules\.(\d+)(?:\.(.+))?$/.exec(key)
    if (!m) {
      out.general.push(msg)
      continue
    }
    const i = Number(m[1])
    ;(out.byIndex[i] ??= {})[m[2] ?? 'entry'] = msg
  }
  return out
}

/** Стрелки/Home/End на панели вкладок; null — клавиша не наша. */
export function nextTabIndex(current: number, key: string, count: number): number | null {
  if (count <= 0) return null
  switch (key) {
    case 'ArrowRight': return (current + 1) % count
    case 'ArrowLeft': return (current - 1 + count) % count
    case 'Home': return 0
    case 'End': return count - 1
    default: return null
  }
}

/** «a@x.ru, b@y.ru; c@z.ru» → массив адресов без пустых и дублей. */
export function parseRecipients(text: string): string[] {
  const out: string[] = []
  for (const part of text.split(/[,;\s]+/)) {
    const p = part.trim()
    if (p !== '' && !out.includes(p)) out.push(p)
  }
  return out
}

export function formatRecipients(list: readonly string[]): string {
  return list.join(', ')
}

/** Пустое поле «Кому отправлять» означает «на ваш адрес». */
export function effectiveRecipients(text: string, address: string): string[] {
  const list = parseRecipients(text)
  if (list.length > 0) return list
  const a = address.trim()
  return a === '' ? [] : [a]
}

/** Список путей полей в патче: {mail:{address}} → ['mail.address']. Массивы считаются листьями. */
export function patchPaths(patch: SettingsPatch): string[] {
  const out: string[] = []
  const walk = (o: unknown, prefix: string) => {
    if (o !== null && typeof o === 'object' && !Array.isArray(o)) {
      for (const [k, v] of Object.entries(o)) walk(v, prefix === '' ? k : `${prefix}.${k}`)
    } else if (prefix !== '') out.push(prefix)
  }
  walk(patch, '')
  return out
}

/** Ошибки после ответа: убираем ошибки полей из патча и добавляем новые. */
export function mergeErrors(
  prev: Record<string, string>,
  patch: SettingsPatch,
  fresh: Record<string, string>,
): Record<string, string> {
  const paths = patchPaths(patch)
  const next: Record<string, string> = {}
  for (const [k, v] of Object.entries(prev)) {
    if (!paths.some((p) => k === p || k.startsWith(`${p}.`))) next[k] = v
  }
  return { ...next, ...fresh }
}

/** Минуты из текста: целое число ≥ 1, иначе null. */
export function parseMinutes(text: string): number | null {
  const s = text.trim()
  if (!/^\d+$/.test(s)) return null
  const n = Number(s)
  return n >= 1 ? n : null
}

export function limitLabel(percent: number): string {
  return `${Math.round(percent)}%`
}
