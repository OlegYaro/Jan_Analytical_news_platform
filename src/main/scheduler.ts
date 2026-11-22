// Планировщик проверок (RUN-01, RUN-03, SCH): несколько расписаний, у каждого свои дни, время и страны.
// Чистая логика (расчёт запусков, догон, очередь без повторов стран) + тонкая обвязка без electron:
// таймер, файл состояния и запуск приходят инъекцией (см. src/main/index.ts).
import { langOf, mt } from './i18n.ts'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeJsonAtomic } from './fs-atomic.ts'
import type { ScheduleFiredFile, ScheduleStatusDto } from '../shared/schedule-types.ts'
import { SCHEDULE_TIME_RE } from '../shared/schedule-types.ts'
import type { Country, ScheduleEntry, Settings } from '../shared/types.ts'

/** id расписания → момент ISO, с которого считаются его запуски (последнее срабатывание или точка отсчёта). */
export type LastFired = Record<string, string>

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** Сколько после времени расписания запуск ещё считается «вовремя» (таймер мог чуть опоздать). */
export const ON_TIME_GRACE_MS = 5 * MINUTE
/** Догон пропущенного: не старше недели (дальше уже наступит следующее время любого расписания). */
export const CATCH_UP_WINDOW_HOURS = 7 * 24
/** После отказа (почта, claude, нет стран) — повторная попытка того же расписания не раньше чем через 5 минут. */
export const RETRY_AFTER_MS = 5 * MINUTE
/** Шаг таймера. */
export const TICK_MS = 30_000

export const SCHEDULE_FIRED_FILE = join('state', 'schedule_fired.json')

// ---------------------------------------------------------------------------------------------
// Чистая логика
// ---------------------------------------------------------------------------------------------

function parseTime(t: string): { h: number; m: number } | null {
  if (!SCHEDULE_TIME_RE.test(t)) return null
  const [h, m] = t.split(':').map(Number) as [number, number]
  return { h, m }
}

/**
 * Момент запуска в местный календарный день. Время, которого в этот день нет (переход на летнее, 02:30
 * в Европе), сдвигается вперёд на час; время, которое бывает дважды (переход на зимнее), — первое из двух.
 * В обоих случаях в день ровно один запуск: без пропуска и без дубля (так работает Date по ECMAScript).
 */
export function slotOn(year: number, month: number, day: number, time: string): Date | null {
  const t = parseTime(time)
  return t ? new Date(year, month, day, t.h, t.m, 0, 0) : null
}

/** Местный календарный день now + offset (полдень: день недели не зависит от перехода времени). */
function dayAt(now: Date, offset: number): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, 12, 0, 0, 0)
}

/** Ближайший запуск расписания строго после now; null — выключено или неверные дни/время. */
export function nextRunAt(entry: ScheduleEntry, now: Date): Date | null {
  if (!entry.enabled) return null
  for (let i = 0; i <= 7; i++) {
    const d = dayAt(now, i)
    if (!entry.days.includes(d.getDay())) continue
    const at = slotOn(d.getFullYear(), d.getMonth(), d.getDate(), entry.time)
    if (at && at.getTime() > now.getTime()) return at
  }
  return null
}

/** Последнее время расписания не позже now (за 8 дней назад); null — нет. Выключенность не учитывается. */
export function lastSlotAtOrBefore(entry: ScheduleEntry, now: Date): Date | null {
  for (let i = 0; i <= 7; i++) {
    const d = dayAt(now, -i)
    if (!entry.days.includes(d.getDay())) continue
    const at = slotOn(d.getFullYear(), d.getMonth(), d.getDate(), entry.time)
    if (at && at.getTime() <= now.getTime()) return at
  }
  return null
}

/** Ближайший запуск каждого включённого расписания, в порядке списка. */
export function nextRunTimes(schedules: readonly ScheduleEntry[], now: Date): Array<{ id: string; at: Date }> {
  const out: Array<{ id: string; at: Date }> = []
  for (const e of schedules) {
    const at = nextRunAt(e, now)
    if (at) out.push({ id: e.id, at })
  }
  return out
}

export interface DueOptions {
  /** «Если компьютер был выключен — проверить при включении» (settings.catchUpMissed). */
  catchUp: boolean
  /** Насколько старое пропущенное время ещё догоняется; по умолчанию CATCH_UP_WINDOW_HOURS. */
  catchUpWindowHours?: number
  /** Окно «вовремя»; по умолчанию ON_TIME_GRACE_MS. */
  graceMs?: number
}

export interface DueRun {
  id: string
  /** Время расписания, за которое запуск. */
  slot: Date
  /** true — это догон пропущенного (Mac спал, приложение было закрыто). */
  catchUp: boolean
}

function parseIso(s: string | undefined): number {
  return typeof s === 'string' ? Date.parse(s) : NaN
}

/**
 * Какие расписания пора запускать, в порядке списка. Берётся только последнее наступившее время
 * расписания: сколько бы раз его ни пропустили, догон один. Если с этого времени расписание уже
 * срабатывало (lastFired ≥ времени) — повторно не запускается, в том числе в ту же минуту.
 * Без записи в lastFired расписание запускается только вовремя (догонять нечего: отсчёт не начат).
 */
export function dueRuns(schedules: readonly ScheduleEntry[], lastFired: LastFired, now: Date, opts: DueOptions): DueRun[] {
  const grace = opts.graceMs ?? ON_TIME_GRACE_MS
  const window = (opts.catchUpWindowHours ?? CATCH_UP_WINDOW_HOURS) * HOUR
  const out: DueRun[] = []
  for (const e of schedules) {
    if (!e.enabled) continue
    const slot = lastSlotAtOrBefore(e, now)
    if (!slot) continue
    const last = parseIso(lastFired[e.id])
    if (Number.isFinite(last) && last >= slot.getTime()) continue
    const age = now.getTime() - slot.getTime()
    if (age <= grace) out.push({ id: e.id, slot, catchUp: false })
    else if (opts.catchUp && Number.isFinite(last) && age <= window) out.push({ id: e.id, slot, catchUp: true })
  }
  return out
}

function sameDays(a: readonly number[], b: readonly number[]): boolean {
  const x = [...a].sort((p, q) => p - q)
  const y = [...b].sort((p, q) => p - q)
  return x.length === y.length && x.every((v, i) => v === y[i])
}

/**
 * Точка отсчёта: новое расписание, сменившиеся дни/время или только что включённое расписание
 * отсчитываются от now — прошедшие до этого времена не «догоняются». prev = null — при запуске
 * приложения (ставится только тем, у кого записи нет). Записи удалённых расписаний отбрасываются.
 */
export function rebaseline(prev: readonly ScheduleEntry[] | null, next: readonly ScheduleEntry[], lastFired: LastFired, now: Date): LastFired {
  const out: LastFired = {}
  const iso = now.toISOString()
  for (const e of next) {
    const p = prev?.find((x) => x.id === e.id)
    const changed = prev !== null && (!p || p.time !== e.time || !sameDays(p.days, e.days) || (!p.enabled && e.enabled))
    const cur = lastFired[e.id]
    out[e.id] = changed || !Number.isFinite(parseIso(cur)) ? iso : (cur as string)
  }
  return out
}

/**
 * Страны расписания: пусто — все включённые; иначе только те из выбранных, что есть и включены
 * (удалённые и выключенные молча отбрасываются). Порядок — как в списке стран.
 */
export function resolveCountries(entry: Pick<ScheduleEntry, 'countries'>, allCountries: readonly Country[]): string[] {
  const active = allCountries.filter((c) => c.active).map((c) => c.code)
  if (entry.countries.length === 0) return active
  const want = new Set(entry.countries)
  return active.filter((c) => want.has(c))
}

export interface QueueItem {
  id: string
  name: string
  /** Что проверить этим запуском (без стран, уже взятых предыдущими в очереди). */
  countries: string[]
  /** Почему запуска не будет: в расписании нет включённых стран / все страны уже проверяются. */
  skip: 'no_countries' | 'covered' | null
}

/** Очередь сработавших вместе расписаний: по порядку, каждая страна — один раз (первому по списку). */
export function planQueue(entries: readonly ScheduleEntry[], allCountries: readonly Country[], covered: Iterable<string> = []): QueueItem[] {
  const taken = new Set(covered)
  return entries.map((e) => {
    const all = resolveCountries(e, allCountries)
    if (all.length === 0) return { id: e.id, name: e.name, countries: [], skip: 'no_countries' as const }
    const rest = all.filter((c) => !taken.has(c))
    for (const c of rest) taken.add(c)
    return { id: e.id, name: e.name, countries: rest, skip: rest.length === 0 ? ('covered' as const) : null }
  })
}

// ---------------------------------------------------------------------------------------------
// Файл состояния: <рабочая папка>/state/schedule_fired.json
// ---------------------------------------------------------------------------------------------

export interface FiredState {
  /** Для dueRuns: последнее срабатывание или точка отсчёта. */
  fired: LastFired
  /** Последний реальный старт прогона по расписанию (для окна). */
  lastStarted: LastFired
}

function cleanRecord(v: unknown): LastFired {
  const out: LastFired = {}
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return out
  for (const [k, s] of Object.entries(v as Record<string, unknown>)) if (typeof s === 'string' && Number.isFinite(Date.parse(s))) out[k] = s
  return out
}

/** Нет файла или он битый — пустое состояние (все расписания получат точку отсчёта «сейчас»). */
export function loadFiredState(workspaceDir: string): FiredState {
  try {
    const raw = JSON.parse(readFileSync(join(workspaceDir, SCHEDULE_FIRED_FILE), 'utf8')) as Partial<ScheduleFiredFile>
    return { fired: cleanRecord(raw.fired), lastStarted: cleanRecord(raw.lastStarted) }
  } catch {
    return { fired: {}, lastStarted: {} }
  }
}

export function saveFiredState(workspaceDir: string, st: FiredState): void {
  const file: ScheduleFiredFile = { version: 1, fired: st.fired, lastStarted: st.lastStarted }
  writeJsonAtomic(join(workspaceDir, SCHEDULE_FIRED_FILE), file)
}

// ---------------------------------------------------------------------------------------------
// Обвязка: таймер, очередь, запуск по одному
// ---------------------------------------------------------------------------------------------

export interface StartScheduledResult {
  /** Прогон действительно начался (или мгновенно завершился). */
  started: boolean
  /** Причина отказа простыми словами. */
  message: string
}

export interface SchedulerDeps {
  getSettings(): Settings
  getCountries(): Country[]
  /** Сейчас ничего начинать нельзя: идёт прогон или проверка источников, оркестратор не готов. */
  isBusy(): boolean
  /** Есть незавершённый и не остановленный прогон (RUN-06): он важнее новых запусков. */
  hasUnfinished(): boolean
  /** Попробовать продолжить незавершённый прогон (сама объясняет отказ в окне). */
  resumeUnfinished(): Promise<void>
  /** Запуск прогона mode 'scheduled' по этим странам (гейт почты и claude проверяет вызываемая сторона). */
  startRun(entry: ScheduleEntry, countries: string[]): Promise<StartScheduledResult>
  /** Пояснение для окна «Прогон» (русский текст). */
  notice(text: string): void
  log?(kind: string, detail: string): void
  now?(): Date
  catchUpWindowHours?: number
}

export interface Scheduler {
  /** Проверить расписания и, если можно, запустить следующее из очереди. Повторный вызов во время работы — пропуск. */
  tick(): Promise<void>
  /** Отложенный tick (после окончания прогона — не ждать шага таймера). */
  kick(delayMs?: number): void
  status(): ScheduleStatusDto
  /** Настройки расписаний сменились: новые/изменённые времена отсчитываются от «сейчас». */
  settingsChanged(prev: readonly ScheduleEntry[], next: readonly ScheduleEntry[]): void
  start(intervalMs?: number): void
  stop(): void
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const now = (): Date => (deps.now ? deps.now() : new Date())
  const log = (kind: string, detail: string): void => {
    try {
      deps.log?.(kind, detail)
    } catch {
      /* журнал не мешает расписанию */
    }
  }
  let queue: string[] = []
  /** Страны, уже взятые прогонами текущей пачки сработавших расписаний. */
  const covered = new Set<string>()
  const retryAt = new Map<string, number>()
  let lastResumeTry = -Infinity
  let ticking = false
  let timer: ReturnType<typeof setInterval> | undefined
  let kickTimer: ReturnType<typeof setTimeout> | undefined
  let lastError = ''

  function persist(ws: string, st: FiredState): void {
    saveFiredState(ws, st)
  }

  /** Записать срабатывание (файл перечитывается: его могли изменить, пока шёл запуск). */
  function markFired(ws: string, id: string, iso: string, started: boolean): void {
    const st = loadFiredState(ws)
    st.fired[id] = iso
    if (started) st.lastStarted[id] = iso
    persist(ws, st)
  }

  async function tick(): Promise<void> {
    if (ticking) return
    ticking = true
    try {
      const t = now()
      const settings = deps.getSettings()
      const ws = settings.workspaceDir
      const st = loadFiredState(ws)
      const based = rebaseline(null, settings.schedules, st.fired, t)
      if (JSON.stringify(based) !== JSON.stringify(st.fired)) {
        st.fired = based
        persist(ws, st)
      }

      const busy = deps.isBusy()
      if (queue.length === 0 && !busy) covered.clear()

      const enabled = new Set(settings.schedules.filter((e) => e.enabled).map((e) => e.id))
      queue = queue.filter((id) => enabled.has(id))
      for (const d of dueRuns(settings.schedules, st.fired, t, {
        catchUp: settings.catchUpMissed,
        ...(deps.catchUpWindowHours !== undefined ? { catchUpWindowHours: deps.catchUpWindowHours } : {}),
      })) {
        if (queue.includes(d.id) || (retryAt.get(d.id) ?? -Infinity) > t.getTime()) continue
        queue.push(d.id)
        log('schedule_due', `${d.id} ${d.catchUp ? 'догон' : 'вовремя'} за ${d.slot.toISOString()}`)
      }

      if (busy) return
      // Незавершённый прогон продолжается раньше новых (RUN-06); пока он есть, новые не начинаются.
      if (deps.hasUnfinished()) {
        if (t.getTime() - lastResumeTry >= RETRY_AFTER_MS) {
          lastResumeTry = t.getTime()
          await deps.resumeUnfinished()
        }
        return
      }
      lastResumeTry = -Infinity

      // По одному прогону за раз (RUN-07): запускаем первый, у кого есть что проверять.
      while (queue.length > 0) {
        const id = queue[0] as string
        const entry = settings.schedules.find((e) => e.id === id)
        if (!entry) {
          queue.shift()
          continue
        }
        const [item] = planQueue([entry], deps.getCountries(), covered) as [QueueItem]
        const iso = now().toISOString()
        if (item.skip) {
          queue.shift()
          markFired(ws, id, iso, false)
          if (item.skip === 'no_countries') {
            deps.notice(
              mt(
                langOf(settings),
                `Расписание «${entry.name}» сработало, но в нём нет ни одной включённой страны. Включите страны в разделе «Страны» или выберите другие в расписании.`,
                `The schedule "${entry.name}" fired, but it has no enabled countries. Enable countries in the "Countries" section or choose others in the schedule.`,
              ),
            )
          }
          log('schedule_skip', `${id} ${item.skip}`)
          continue
        }
        const r = await deps.startRun(entry, item.countries)
        queue.shift()
        if (r.started) {
          for (const c of item.countries) covered.add(c)
          markFired(ws, id, iso, true)
          retryAt.delete(id)
          log('schedule_start', `${id} ${item.countries.join(',')}`)
        } else {
          retryAt.set(id, now().getTime() + RETRY_AFTER_MS)
          deps.notice(mt(langOf(settings), `Проверка по расписанию «${entry.name}» не запущена: ${r.message}`, `The scheduled check "${entry.name}" was not started: ${r.message}`))
          log('schedule_refused', `${id} ${r.message}`)
        }
        break
      }
      lastError = ''
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg !== lastError) log('schedule_error', msg)
      lastError = msg
    } finally {
      ticking = false
    }
  }

  return {
    tick,
    kick(delayMs = 2_000) {
      if (kickTimer) return
      kickTimer = setTimeout(() => {
        kickTimer = undefined
        void tick()
      }, delayMs)
    },
    status() {
      const t = now()
      const settings = deps.getSettings()
      const st = loadFiredState(settings.workspaceDir)
      let countries: Country[] = []
      try {
        countries = deps.getCountries()
      } catch {
        /* без стран — пустые списки */
      }
      return {
        entries: settings.schedules.map((e) => ({
          id: e.id,
          name: e.name,
          enabled: e.enabled,
          nextRunAt: nextRunAt(e, t)?.toISOString() ?? null,
          lastStartedAt: st.lastStarted[e.id] ?? null,
          countries: resolveCountries(e, countries),
        })),
        queued: [...queue],
      }
    },
    settingsChanged(prev, next) {
      try {
        const ws = deps.getSettings().workspaceDir
        const st = loadFiredState(ws)
        const fired = rebaseline(prev, next, st.fired, now())
        const keep = new Set(next.map((e) => e.id))
        const lastStarted: LastFired = {}
        for (const [k, v] of Object.entries(st.lastStarted)) if (keep.has(k)) lastStarted[k] = v
        persist(ws, { fired, lastStarted })
        for (const e of next) {
          const p = prev.find((x) => x.id === e.id)
          if (!p || p.time !== e.time || !sameDays(p.days, e.days)) retryAt.delete(e.id)
        }
        queue = queue.filter((id) => next.some((e) => e.id === id && e.enabled))
      } catch (err) {
        log('schedule_error', err instanceof Error ? err.message : String(err))
      }
    },
    start(intervalMs = TICK_MS) {
      clearInterval(timer)
      timer = setInterval(() => void tick(), intervalMs)
      void tick()
    },
    stop() {
      clearInterval(timer)
      timer = undefined
      clearTimeout(kickTimer)
      kickTimer = undefined
    },
  }
}
