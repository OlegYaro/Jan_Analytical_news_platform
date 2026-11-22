// Все числа здесь синтетические (придуманы для проверки арифметики), не измерения.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Country, Settings } from '../../shared/types.ts'
import { defaultSettings } from '../settings/defaults.ts'
import { DEFAULT_USD_PER_7_DAYS, LIMIT_PCT_PER_USD, estimateRun, quantile, windowDays } from './estimate.ts'

const NOW = new Date(2026, 10, 20, 12, 0)
const settings = (): Settings => defaultSettings('/home/u') // firstRunDays = 30
const ctry = (code: string): Country => ({ code, name: code, languages: [], active: true, sources: [] }) as unknown as Country
const tmp = (): string => mkdtempSync(join(tmpdir(), 'rw-est-'))

interface Spec {
  status?: string
  usd: number
  /** Прогон старой схемы (без этапа screen): в оценку не берётся. */
  old?: boolean
  from?: string
  to?: string
}
function addRun(ws: string, id: string, mode: string, countries: Record<string, Spec>): void {
  const dir = join(ws, 'runs', id)
  mkdirSync(dir, { recursive: true })
  const cs: Record<string, unknown> = {}
  for (const [code, s] of Object.entries(countries)) {
    cs[code] = {
      window: { from: s.from ?? '2026-10-21', to: s.to ?? '2026-11-20' }, // 30 дней
      status: s.status ?? 'changes',
      stages: s.old ? {} : { screen: { state: 'done', attempts: 1 } },
      acts: {},
      usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, cost_usd: s.usd },
    }
  }
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ id, mode, started_at: '2026-11-01T00:00:00Z', skills_hash: 'h', countries: cs }))
}

test('windowDays и quantile', () => {
  assert.equal(windowDays({ from: '2026-11-01', to: '2026-11-08' }), 7)
  assert.equal(windowDays({ from: '2026-11-08', to: '2026-11-08' }), 1)
  assert.equal(windowDays({ from: 'x', to: 'y' }), 1)
  assert.equal(quantile([1, 2, 3, 4, 5], 0.5), 3)
  assert.equal(quantile([0, 10], 0.25), 2.5)
})

test('нет истории: значение по умолчанию на окно страны, basis=default', () => {
  const e = estimateRun(tmp(), [ctry('UZ')], settings(), NOW)
  assert.equal(e.runsConsidered, 0)
  const mid = (DEFAULT_USD_PER_7_DAYS / 7) * 30
  assert.equal(e.perCountry[0]?.basis, 'default')
  assert.ok(Math.abs((e.perCountry[0]?.usdLow ?? 0) - mid * 0.5) < 1e-9)
  assert.ok(Math.abs((e.perCountry[0]?.usdHigh ?? 0) - mid * 2) < 1e-9)
})

test('пустой список стран: нули', () => {
  const e = estimateRun(tmp(), [], settings(), NOW)
  assert.deepEqual(e.perCountry, [])
  assert.equal(e.totalUsdLow, 0)
  assert.equal(e.totalUsdHigh, 0)
  assert.equal(e.limitPercentHigh, 0)
})

test('история: квартили 25–75 % по образцам страны (30 дней → окно 30 дней)', () => {
  const ws = tmp()
  for (const [i, usd] of [3, 6, 9, 12, 15].entries()) addRun(ws, `2026-11-0${i + 1}_1000`, 'manual', { UZ: { usd } })
  const e = estimateRun(ws, [ctry('UZ')], settings(), NOW)
  const c = e.perCountry[0]!
  assert.equal(c.basis, 'history')
  assert.equal(e.runsConsidered, 5)
  assert.ok(Math.abs(c.usdLow - 6) < 1e-9) // q25 из 3,6,9,12,15
  assert.ok(Math.abs(c.usdHigh - 12) < 1e-9)
  assert.ok(Math.abs(e.limitPercentLow - 6 * LIMIT_PCT_PER_USD[0]) < 1e-9)
  assert.ok(Math.abs(e.limitPercentHigh - 12 * LIMIT_PCT_PER_USD[1]) < 1e-9)
})

test('мало образцов (один): диапазон расширен вокруг значения', () => {
  const ws = tmp()
  addRun(ws, '2026-11-01_1000', 'dry_run', { UZ: { usd: 10 } })
  const c = estimateRun(ws, [ctry('UZ')], settings(), NOW).perCountry[0]!
  assert.ok(Math.abs(c.usdLow - 7) < 1e-9)
  assert.ok(Math.abs(c.usdHigh - 14) < 1e-9)
})

test('пересчёт окна: страна проверялась вчера — окно 1 день, цена линейно', () => {
  const ws = tmp()
  addRun(ws, '2026-11-01_1000', 'manual', { UZ: { usd: 30 } }) // $1/день
  mkdirSync(join(ws, 'state'), { recursive: true })
  writeFileSync(join(ws, 'state', 'last_success.json'), JSON.stringify({ UZ: new Date(2026, 10, 18, 9, 0).toISOString() }))
  const c = estimateRun(ws, [ctry('UZ')], settings(), NOW).perCountry[0]!
  assert.ok(Math.abs(c.usdLow - 2 * 0.7) < 1e-9) // окно 18.11 → 20.11 = 2 дня
  assert.ok(Math.abs(c.usdHigh - 2 * 1.4) < 1e-9)
})

test('отсев: прогон с failed-страной, незавершённые страны, длинный ретро-прогон', () => {
  const ws = tmp()
  addRun(ws, '2026-11-01_1000', 'manual', { UZ: { usd: 100 }, KZ: { usd: 100, status: 'failed:timeout' } }) // весь прогон вон
  addRun(ws, '2026-11-02_1000', 'manual', { UZ: { usd: 100, status: 'running' } })
  addRun(ws, '2026-11-03_1000', 'backfill', { UZ: { usd: 100, from: '2026-08-01', to: '2026-11-01' } }) // 92 дня
  addRun(ws, '2026-11-04_1000', 'backfill', { UZ: { usd: 20, from: '2026-10-21', to: '2026-11-20' } }) // 30 дней — годится
  const e = estimateRun(ws, [ctry('UZ'), ctry('KZ')], settings(), NOW)
  assert.equal(e.runsConsidered, 1)
  assert.equal(e.perCountry[0]?.basis, 'history')
  assert.ok(Math.abs((e.perCountry[0]?.usdLow ?? 0) - 14) < 1e-9)
  assert.equal(e.perCountry[1]?.basis, 'default')
})

test('битый run.json и отсутствие папки не ломают оценку', () => {
  const ws = tmp()
  mkdirSync(join(ws, 'runs', 'bad'), { recursive: true })
  writeFileSync(join(ws, 'runs', 'bad', 'run.json'), '{не json')
  const e = estimateRun(ws, [ctry('UZ')], settings(), NOW)
  assert.equal(e.perCountry[0]?.basis, 'default')
})

test('прогон старой схемы (без этапа screen) не берётся как образец: оценка по умолчанию', () => {
  const ws = tmp()
  addRun(ws, '2026-11-01_0800', 'manual', { UZ: { usd: 11.5, old: true } })
  const e = estimateRun(ws, [ctry('UZ')], settings(), NOW)
  assert.equal(e.runsConsidered, 0)
  assert.equal(e.perCountry[0]?.basis, 'default')
})
