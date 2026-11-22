// Оценка стоимости проверки до запуска (NFR-08, docs/02 «Оценка до прогона»).
// Основа — прошлые прогоны: <рабочая папка>/runs/*/run.json. Только чтение, без записи и без модели.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CountryRun, RunState } from '../../shared/run-types.ts'
import type { Country, Settings } from '../../shared/types.ts'
import { computeWindow } from './orchestrator.ts'

/**
 * Стоимость страны по умолчанию, когда истории нет: $1,5 за 7 дней. Источник: docs/FINDINGS — экран по тексту
 * заметно дешевле старой схемы (факт replay: $3,3 на Узбекистан за 30 дней, то есть ≈ $0,11 в день);
 * $1,5 за 7 дней взят с запасом (≈ $0,21 в день) как грубая прикидка, а не измерение.
 */
export const DEFAULT_USD_PER_7_DAYS = 1.5
/** Разброс грубой оценки по умолчанию: от половины до удвоенного значения (эвристика, не измерение). */
export const DEFAULT_SPREAD: readonly [number, number] = [0.5, 2]
/** Если образцов мало (< 3), квартили вырождены: расширяем диапазон вокруг min/max на эти множители. */
export const FEW_SAMPLES_SPREAD: readonly [number, number] = [0.7, 1.4]
/** Ретро-прогоны с окном длиннее этого в историю не берутся: они нетипичны для обычной проверки. */
export const MAX_BACKFILL_DAYS = 45
/**
 * Доля 5-часового лимита (в процентных пунктах) на $1 расхода, нижняя и верхняя граница.
 * Источник — docs/FINDINGS: на sonnet ≈ 11 % окна на $1 («Факт по лимиту»), на opus ≈ 5,2 % на $1 (прогон
 * T-1: анализ + проверка). Стоимость $ уже учитывает цену моделей выбранного пресета, поэтому отдельный
 * множитель по пресету не нужен: opus дороже в долларах, но тратит на доллар МЕНЬШЕ лимита (не больше).
 * Нижняя граница оценки берёт 5, верхняя — 11: так диапазон честно покрывает оба измерения.
 */
export const LIMIT_PCT_PER_USD: readonly [number, number] = [5, 11]

export interface CountryEstimate {
  code: string
  usdLow: number
  usdHigh: number
  basis: 'history' | 'default'
  /** Длина окна поиска страны в днях (с последней успешной проверки). */
  days: number
  /** Окно следующей проверки (даты ГГГГ-ММ-ДД). */
  from: string
  to: string
}

export interface RunEstimate {
  perCountry: CountryEstimate[]
  totalUsdLow: number
  totalUsdHigh: number
  limitPercentLow: number
  limitPercentHigh: number
  /** Сколько прошлых прогонов дали хотя бы один образец. */
  runsConsidered: number
}

const DAY_MS = 86_400_000

/** Длина окна в днях (включительно не считаем: to − from), минимум 1. */
export function windowDays(w: { from: string; to: string }): number {
  const a = Date.parse(`${w.from}T00:00:00Z`)
  const b = Date.parse(`${w.to}T00:00:00Z`)
  if (Number.isNaN(a) || Number.isNaN(b)) return 1
  return Math.max(1, Math.round((b - a) / DAY_MS))
}

/** Квантиль q (0..1) отсортированного массива с линейной интерполяцией. */
export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return (sorted[lo] ?? 0) + ((sorted[hi] ?? 0) - (sorted[lo] ?? 0)) * (pos - lo)
}

export interface Sample {
  usdPerDay: number
}

/** Образцы по странам: завершённые страны прогонов без сбоев и без длинных ретро-окон. */
export function collectSamples(workspaceDir: string): { byCountry: Map<string, Sample[]>; runsConsidered: number } {
  const byCountry = new Map<string, Sample[]>()
  let runsConsidered = 0
  let names: string[] = []
  try {
    names = readdirSync(join(workspaceDir, 'runs'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return { byCountry, runsConsidered }
  }
  for (const id of names) {
    let run: RunState
    try {
      run = JSON.parse(readFileSync(join(workspaceDir, 'runs', id, 'run.json'), 'utf8')) as RunState
    } catch {
      continue
    }
    const list = Object.entries(run?.countries ?? {}) as Array<[string, CountryRun]>
    if (list.length === 0) continue
    if (list.some(([, c]) => String(c?.status ?? '').startsWith('failed:'))) continue
    let used = false
    for (const [code, c] of list) {
      // Прогоны до экрана по тексту (нет этапа screen) стоили в несколько раз дороже: как образец они завышают оценку.
      if (!c.stages || !('screen' in c.stages)) continue
      if (c.status !== 'changes' && c.status !== 'no_changes') continue
      const cost = c.usage?.cost_usd
      if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0 || !c.window) continue
      const days = windowDays(c.window)
      if (run.mode === 'backfill' && days > MAX_BACKFILL_DAYS) continue
      const arr = byCountry.get(code) ?? []
      arr.push({ usdPerDay: cost / days })
      byCountry.set(code, arr)
      used = true
    }
    if (used) runsConsidered++
  }
  return { byCountry, runsConsidered }
}

/** Диапазон стоимости на `days` дней по образцам страны: квартили 25–75 % (при <3 образцах — min/max, расширенные). */
function rangeFromSamples(samples: Sample[], days: number): [number, number] {
  const v = samples.map((s) => s.usdPerDay).sort((a, b) => a - b)
  if (v.length < 3) return [(v[0] ?? 0) * days * FEW_SAMPLES_SPREAD[0], (v[v.length - 1] ?? 0) * days * FEW_SAMPLES_SPREAD[1]]
  return [quantile(v, 0.25) * days, quantile(v, 0.75) * days]
}

export function estimateRun(
  workspaceDir: string,
  countries: Country[],
  settings: Pick<Settings, 'advanced'>,
  now: Date,
): RunEstimate {
  const { byCountry, runsConsidered } = collectSamples(workspaceDir)
  const perCountry: CountryEstimate[] = countries.map((c) => {
    const win = computeWindow(workspaceDir, c.code, settings, now)
    const days = windowDays(win)
    const samples = byCountry.get(c.code)
    if (samples && samples.length > 0) {
      const [lo, hi] = rangeFromSamples(samples, days)
      return { code: c.code, usdLow: lo, usdHigh: hi, basis: 'history' as const, days, from: win.from, to: win.to }
    }
    const mid = (DEFAULT_USD_PER_7_DAYS / 7) * days
    return { code: c.code, usdLow: mid * DEFAULT_SPREAD[0], usdHigh: mid * DEFAULT_SPREAD[1], basis: 'default' as const, days, from: win.from, to: win.to }
  })
  const totalUsdLow = perCountry.reduce((s, c) => s + c.usdLow, 0)
  const totalUsdHigh = perCountry.reduce((s, c) => s + c.usdHigh, 0)
  return {
    perCountry,
    totalUsdLow,
    totalUsdHigh,
    limitPercentLow: totalUsdLow * LIMIT_PCT_PER_USD[0],
    limitPercentHigh: totalUsdHigh * LIMIT_PCT_PER_USD[1],
    runsConsidered,
  }
}
