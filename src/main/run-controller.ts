// Контроллер запусков для окна «Прогон» (RUN-02/07/08). Без electron: всё приходит инъекцией.
// Показывает только реальное состояние run.json; запуск идёт через оркестратор с боевыми этапами.
import type { GateStatus } from './mail-gate.ts'
import { guardRun } from './mail-gate.ts'
import { listRuns, runDir } from './archive.ts'
import type { Orchestrator } from './runner/orchestrator.ts'
import { loadRun } from './runner/run-state.ts'
import { estimateRun } from './runner/estimate.ts'
import type { RunEstimate } from './runner/estimate.ts'
import type { MailStatusDto, RunEstimateDto, RunMode, RunStartOptions, RunState, RunStatusDto } from '../shared/run-types.ts'
import type { Country, Settings } from '../shared/types.ts'
import { langOf, mt } from './i18n.ts'

/** Оркестратор ещё не создан (первые секунды после запуска приложения). */
export const NOT_READY_MESSAGE = 'RegWatch ещё готовится к работе. Подождите несколько секунд и нажмите ещё раз.'
export const NOTHING_RUNNING_MESSAGE = 'Сейчас ничего не запущено.'
export const ALREADY_RUNNING_MESSAGE = 'Проверка уже идёт. Показываем текущую.'
export const STARTED_MESSAGE = 'Проверка запущена.'
export const STOPPING_MESSAGE = 'Останавливаем: текущий шаг будет доделан, состояние сохранится.'
export const START_ERROR_MESSAGE =
  'Не удалось запустить проверку из-за внутренней ошибки. Попробуйте ещё раз; если повторится, перезапустите RegWatch.'
export const STOP_ERROR_MESSAGE = 'Не удалось остановить проверку. Подождите немного и нажмите «Остановить» ещё раз.'
export const BAD_WINDOW_MESSAGE = 'Период указан неверно. Введите две даты в виде ГГГГ-ММ-ДД, «с» не позже «по».'

/** Английские варианты сообщений; русские константы выше остаются эталоном (на них опираются тесты). */
const EN: Record<string, string> = {
  [NOT_READY_MESSAGE]: 'RegWatch is still getting ready. Wait a few seconds and press again.',
  [NOTHING_RUNNING_MESSAGE]: 'Nothing is running right now.',
  [ALREADY_RUNNING_MESSAGE]: 'A check is already running. Showing the current one.',
  [STARTED_MESSAGE]: 'The check has started.',
  [STOPPING_MESSAGE]: 'Stopping: the current step will be finished and the state saved.',
  [START_ERROR_MESSAGE]: 'Could not start the check because of an internal error. Try again; if it repeats, restart RegWatch.',
  [STOP_ERROR_MESSAGE]: 'Could not stop the check. Wait a moment and press "Stop" again.',
  [BAD_WINDOW_MESSAGE]: 'The period is invalid. Enter two dates as YYYY-MM-DD, with "from" not later than "to".',
}

export interface RunControllerDeps {
  workspaceDir: () => string
  getSettings: () => Settings
  gate: () => GateStatus
  /** Список стран для запуска; без него «countriesSummary» нулевой. */
  getCountries?: () => Country[]
  /** Оркестратор или функция, его возвращающая (создаётся после подготовки рабочей папки); null — ещё не готов. */
  orchestrator?: Orchestrator | null | (() => Orchestrator | null)
  /** Хеш набора скиллов для run.json (NFR-15). */
  skillsHash?: () => string
  /** Проверка перед запуском (найден ли claude и т.п.): текст причины отказа или null. */
  preflight?: (mode: RunMode) => Promise<string | null>
  /** Пояснение для окна (например, почему незавершённая проверка не продолжена); '' — нет. */
  notice?: () => string
  /** Письма прогона из очереди отправки (DLV-06); undefined — писем нет. */
  mailStatus?: (run: RunState | null) => MailStatusDto | undefined
  /** Оценка до прогона (NFR-08); по умолчанию — estimateRun по истории рабочей папки. Подставляется в тестах. */
  estimate?: (countries: Country[], settings: Settings, now: Date) => RunEstimate
  /** Часы для кэша оценки (мс); по умолчанию Date.now. */
  nowMs?: () => number
}

/** Оценку считаем не чаще раза в это время (она читает run.json всех прошлых прогонов). */
export const ESTIMATE_TTL_MS = 10_000

export interface ActionResult {
  ok: boolean
  message: string
  /** Для start: прогон действительно начат этим вызовом (а не «уже идёт» и не отказ). */
  started?: boolean
}

export interface RunController {
  status(): RunStatusDto
  /** 'scheduled' — только из планировщика (окно его не передаёт: IPC пропускает manual/dry_run/backfill). */
  start(mode: RunMode, opts?: RunStartOptions): Promise<ActionResult>
  stop(): Promise<ActionResult>
  /** Подписка на изменения (для webContents.send). Возвращает отписку. */
  onChange(cb: () => void): () => void
  /** Сообщить подписчикам, что состояние изменилось (звать из onProgress оркестратора). */
  notify(): void
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function validDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

function lastRun(ws: string): RunState | null {
  try {
    const entry = listRuns(ws).find((r) => !r.broken)
    return entry ? loadRun(runDir(ws, entry.id)) : null
  } catch {
    return null
  }
}

export function createRunController(deps: RunControllerDeps): RunController {
  const lang = () => langOf(deps.getSettings())
  /** Фиксированное сообщение на языке интерфейса. */
  const T = (ru: string): string => mt(lang(), ru, EN[ru] ?? ru)
  const orchestrator = (): Orchestrator | null => {
    const o = deps.orchestrator
    return typeof o === 'function' ? o() : (o ?? null)
  }
  const listeners = new Set<() => void>()
  const notify = (): void => {
    for (const cb of [...listeners]) {
      try {
        cb()
      } catch {
        /* подписчик не должен ломать запуск */
      }
    }
  }

  let estCache: { key: string; at: number; value: RunEstimateDto | undefined } | null = null
  function estimate(settings: Settings, countries: Country[]): RunEstimateDto | undefined {
    const active = countries.filter((c) => c.active)
    if (active.length === 0) return undefined
    const nowMs = deps.nowMs ? deps.nowMs() : Date.now()
    const key = `${deps.workspaceDir()}|${active.map((c) => c.code).join(',')}|${settings.advanced?.firstRunDays}|${settings.limitPercent}`
    if (estCache && estCache.key === key && nowMs - estCache.at < ESTIMATE_TTL_MS) return estCache.value
    let value: RunEstimateDto | undefined
    try {
      const now = new Date(nowMs)
      const e = deps.estimate ? deps.estimate(active, settings, now) : estimateRun(deps.workspaceDir(), active, settings, now)
      value = {
        usd: [e.totalUsdLow, e.totalUsdHigh],
        limitPercent: [e.limitPercentLow, e.limitPercentHigh],
        countries: active.length,
        days: Math.max(1, ...e.perCountry.map((c) => c.days)),
        from: e.perCountry.map((c) => c.from).sort()[0] ?? '',
        to: e.perCountry.map((c) => c.to).sort().at(-1) ?? '',
        basis: e.perCountry.length > 0 && e.perCountry.every((c) => c.basis === 'history') ? 'history' : 'default',
        exceedsLimit: e.limitPercentHigh > settings.limitPercent,
      }
    } catch {
      value = undefined // оценка вспомогательная: сбой не ломает окно
    }
    estCache = { key, at: nowMs, value }
    return value
  }

  function status(): RunStatusDto {
    const orch = orchestrator()
    const live = orch?.running ? orch.current() : null
    const run = live ?? lastRun(deps.workspaceDir())
    const running = !!live
    // Пауза по лимиту: прогон в процессе не идёт, но не завершён и не остановлен — ждёт сброса окна.
    const pausedUntil = run && !run.finished_at && !run.stopped ? run.paused_until : undefined
    const gate = deps.gate()
    const countries = deps.getCountries ? deps.getCountries() : []
    const notice = deps.notice ? deps.notice() : ''
    let mail: MailStatusDto | undefined
    try {
      mail = deps.mailStatus ? deps.mailStatus(run) : undefined
    } catch {
      mail = undefined
    }
    let reason = ''
    if (running) reason = mt(lang(), 'Проверка уже идёт.', 'A check is already running.')
    else if (!gate.canRun) reason = gate.message
    const est = running ? undefined : estimate(deps.getSettings(), countries)
    return {
      running,
      paused: !!pausedUntil,
      ...(pausedUntil ? { pausedUntil } : {}),
      ...(running && run?.current ? { current: { country: run.current.country, stage: run.current.stage, text: run.current.text } } : {}),
      run,
      canStart: !running && gate.canRun,
      canDryRun: !running && gate.canDryRun,
      startBlockedReason: reason,
      countriesSummary: { active: countries.filter((c) => c.active).length, total: countries.length },
      ...(notice ? { notice } : {}),
      ...(mail ? { mail } : {}),
      ...(est ? { estimate: est } : {}),
    }
  }

  async function start(mode: RunMode, opts: RunStartOptions = {}): Promise<ActionResult> {
    const orch = orchestrator()
    if (!orch) return { ok: false, message: T(NOT_READY_MESSAGE) }
    try {
      if (orch.running) return { ok: true, message: T(ALREADY_RUNNING_MESSAGE) }
      const gate = deps.gate()
      const g = guardRun(mode, gate)
      if (!g.allowed) return { ok: false, message: g.message }
      if (mode === 'backfill') {
        const w = opts.window
        if (!w || !validDate(w.from) || !validDate(w.to) || w.from > w.to) return { ok: false, message: T(BAD_WINDOW_MESSAGE) }
      }
      const why = deps.preflight ? await deps.preflight(mode) : null
      if (why) return { ok: false, message: why }
      const skillsHash = deps.skillsHash ? deps.skillsHash() : ''
      const p = orch.start({
        mode,
        countries: deps.getCountries ? deps.getCountries() : [],
        settings: deps.getSettings(),
        gate,
        ...(mode === 'backfill' && opts.window ? { windowOverride: opts.window } : {}),
        ...(opts.countries?.length ? { onlyCountries: opts.countries } : {}),
        ...(skillsHash ? { skillsHash } : {}),
      })
      // Прогон долгий: ждём лишь миг, чтобы поймать мгновенный отказ (нет стран, гейт).
      let timer: ReturnType<typeof setTimeout> | undefined
      const first = await Promise.race([
        p.then((r) => ({ done: true as const, r })),
        new Promise<{ done: false }>((res) => {
          timer = setTimeout(() => res({ done: false }), 50)
        }),
      ])
      clearTimeout(timer)
      p.then(notify, notify)
      if (first.done) {
        if (!first.r.ok) return { ok: false, message: first.r.blocked }
        return { ok: true, message: mt(lang(), 'Проверка завершена.', 'The check is complete.'), started: true }
      }
      notify()
      return { ok: true, message: T(STARTED_MESSAGE), started: true }
    } catch {
      return { ok: false, message: T(START_ERROR_MESSAGE) }
    }
  }

  async function stop(): Promise<ActionResult> {
    const orch = orchestrator()
    if (!orch) return { ok: false, message: T(NOTHING_RUNNING_MESSAGE) }
    try {
      const p = orch.stop()
      if (!p) return { ok: false, message: T(NOTHING_RUNNING_MESSAGE) }
      p.then(notify, notify)
      return { ok: true, message: T(STOPPING_MESSAGE) }
    } catch {
      return { ok: false, message: T(STOP_ERROR_MESSAGE) }
    }
  }

  return {
    status,
    start,
    stop,
    onChange(cb) {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    notify,
  }
}
