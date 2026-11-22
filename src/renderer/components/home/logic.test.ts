import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RunState, RunStatusDto, Usage } from '../../../shared/run-types.ts'
import type { Country } from '../../../shared/types.ts'
import { countriesWithFailedSources, homeWarnings, spendSummary } from './logic.ts'

const now = new Date(2026, 10, 21, 12, 0)
const u = (cost: number): Usage => ({ input: 1000, output: 500, cache_read: 0, cache_write: 0, cost_usd: cost })

function country(code: string, name: string, active: boolean, states: string[]): Country {
  return {
    code, name, languages: [], active, watchedActs: [], lastCheckedAt: null, lastRunSummary: '',
    sources: states.map((state, i) => ({ id: `s${i}`, state })),
  } as unknown as Country
}

function runWith(statuses: Record<string, string>): RunState {
  const countries: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(statuses)) countries[k] = { status: v, usage: u(0.5) }
  return { id: 'r', mode: 'manual', started_at: new Date(2026, 10, 21, 9, 5).toISOString(), countries } as unknown as RunState
}

const base = { running: false, paused: false, canStart: true, canDryRun: true, startBlockedReason: '' } as RunStatusDto

test('источники с ❌: только у включённых стран', () => {
  const list = [country('UZ', 'Узбекистан', true, ['ok', 'fail']), country('KZ', 'Казахстан', false, ['fail']), country('GE', 'Грузия', true, ['ok'])]
  assert.deepEqual(countriesWithFailedSources(list).map((c) => c.code), ['UZ'])
  const w = homeWarnings(list, base, now, 'ru')
  assert.equal(w.length, 1)
  assert.equal(w[0].kind, 'sources')
  assert.match(w[0].text, /Узбекистан/)
  assert.ok(w[0].linkToCountries)
})

test('страны со сбоем: причина простыми словами, ru и en', () => {
  const st = { ...base, run: runWith({ UZ: 'failed:timeout', KZ: 'changes' }) } as RunStatusDto
  const ru = homeWarnings([country('UZ', 'Узбекистан', true, [])], st, now, 'ru')
  assert.equal(ru[0].text, 'В последней проверке были сбои: Узбекистан — не уложились во время.')
  const en = homeWarnings([country('UZ', 'Узбекистан', true, [])], st, now, 'en')
  assert.match(en[0].text, /Uzbekistan — ran out of time/)
})

test('пауза показывается, пока прогон не идёт; идущий прогон не дублируется', () => {
  const until = new Date(2026, 10, 21, 14, 30).toISOString()
  const w = homeWarnings([], { ...base, paused: true, pausedUntil: until }, now, 'ru')
  assert.equal(w[0].kind, 'paused')
  assert.match(w[0].text, /14:30/)
  assert.deepEqual(homeWarnings([], { ...base, running: true, paused: true, pausedUntil: until }, now, 'ru'), [])
})

test('нет данных — нет предупреждений; письмо не дублируется', () => {
  assert.deepEqual(homeWarnings(null, null, now, 'ru'), [])
  const st = { ...base, mail: { state: 'failed', attempts: 3 } } as RunStatusDto
  assert.deepEqual(homeWarnings([], st, now, 'en'), [])
})

test('расход последнего прогона', () => {
  assert.equal(spendSummary(null, false, [], now, 'ru'), null)
  const s = spendSummary(runWith({ UZ: 'changes', KZ: 'no_changes' }), true, [country('UZ', 'Узбекистан', true, [])], now, 'en')!
  assert.equal(s.mode, 'Manual check')
  assert.equal(s.when, '09:05')
  assert.equal(s.running, true)
  assert.equal(s.rows[0].name, 'Uzbekistan')
  assert.equal(s.rows[1].name, 'KZ')
  assert.equal(s.total.cost_usd, 1)
  assert.equal(s.total.input, 2000)
})
