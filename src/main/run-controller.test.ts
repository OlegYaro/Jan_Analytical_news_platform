import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { join } from 'node:path'
import { createRunController, NOT_READY_MESSAGE, NOTHING_RUNNING_MESSAGE } from './run-controller.ts'
import type { RunControllerDeps } from './run-controller.ts'
import type { Orchestrator } from './runner/orchestrator.ts'
import { createRun, markStage, saveRun } from './runner/run-state.ts'
import { defaultSettings } from './settings/defaults.ts'
import { MAIL_GATE_MESSAGE } from './mail-gate.ts'
import type { GateStatus } from './mail-gate.ts'
import type { Country } from '../shared/types.ts'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'rw-ctl-'))
const OPEN: GateStatus = { canRun: true, canDryRun: true, message: '' }
const CLOSED: GateStatus = { canRun: false, canDryRun: true, message: MAIL_GATE_MESSAGE }
const W = { from: '2026-11-01', to: '2026-11-15' }

function make(ws: string, gate: GateStatus, orchestrator?: RunControllerDeps['orchestrator'], extra: Partial<RunControllerDeps> = {}) {
  return createRunController({
    workspaceDir: () => ws,
    getSettings: () => defaultSettings('/home/u'),
    gate: () => gate,
    ...(orchestrator !== undefined ? { orchestrator } : {}),
    ...extra,
  })
}

test('статус без прогонов: run = null, ничего не идёт', () => {
  const st = make(tmp(), OPEN).status()
  assert.equal(st.run, null)
  assert.equal(st.running, false)
  assert.equal(st.paused, false)
  assert.equal(st.canStart, true)
  assert.equal(st.startBlockedReason, '')
})

test('статус с готовым run.json: показывает реальное состояние', () => {
  const ws = tmp()
  const { dir, state } = createRun({ workspaceDir: ws, mode: 'manual', countries: [{ code: 'UZ', window: W }], skillsHash: 'h', now: new Date(2026, 10, 17, 8, 0) })
  markStage(state, 'UZ', 'collect', { state: 'done' })
  saveRun(dir, state)
  const st = make(ws, OPEN).status()
  assert.equal(st.running, false)
  assert.equal(st.run?.id, '2026-11-17_0800')
  assert.equal(st.run?.countries['UZ']?.stages.collect.state, 'done')
})

test('гейт закрыт: статус объясняет причину', () => {
  const st = make(tmp(), CLOSED).status()
  assert.equal(st.canStart, false)
  assert.equal(st.canDryRun, true)
  assert.equal(st.startBlockedReason, MAIL_GATE_MESSAGE)
})

test('start до создания оркестратора: просьба подождать', async () => {
  for (const o of [undefined, null, () => null]) {
    const r = await make(tmp(), OPEN, o).start('manual')
    assert.deepEqual(r, { ok: false, message: NOT_READY_MESSAGE })
  }
})

test('start: оркестратор из функции, хеш скиллов и окно периода передаются; preflight может отказать', async () => {
  const seen: Array<Record<string, unknown>> = []
  const fake = {
    running: false,
    current: () => null,
    stop: () => null,
    start: (o: Record<string, unknown>) => {
      seen.push(o)
      return new Promise(() => {}) // прогон «идёт»
    },
  } as unknown as Orchestrator
  const W2 = { from: '2026-10-01', to: '2026-10-31' }
  const c = make(tmp(), OPEN, () => fake, { skillsHash: () => 'abc' })
  const r = await c.start('backfill', { window: W2 })
  assert.deepEqual(r, { ok: true, message: 'Проверка запущена.', started: true })
  assert.equal(seen[0]!['mode'], 'backfill')
  assert.deepEqual(seen[0]!['windowOverride'], W2)
  assert.equal(seen[0]!['skillsHash'], 'abc')

  const blocked = make(tmp(), OPEN, () => fake, { preflight: async () => 'Не найдена программа Claude Code.' })
  assert.deepEqual(await blocked.start('manual'), { ok: false, message: 'Не найдена программа Claude Code.' })
  assert.equal(seen.length, 1)
})

test('start: запуск по расписанию передаёт mode scheduled и страны; гейт почты его блокирует', async () => {
  const seen: Array<Record<string, unknown>> = []
  const fake = {
    running: false,
    current: () => null,
    stop: () => null,
    start: (o: Record<string, unknown>) => {
      seen.push(o)
      return new Promise(() => {})
    },
  } as unknown as Orchestrator
  const r = await make(tmp(), OPEN, fake).start('scheduled', { countries: ['KZ', 'UZ'] })
  assert.deepEqual(r, { ok: true, message: 'Проверка запущена.', started: true })
  assert.equal(seen[0]!['mode'], 'scheduled')
  assert.deepEqual(seen[0]!['onlyCountries'], ['KZ', 'UZ'])
  assert.deepEqual(await make(tmp(), CLOSED, fake).start('scheduled', { countries: ['KZ'] }), { ok: false, message: MAIL_GATE_MESSAGE })
  // уже идёт — не «начат»
  const busy = { ...fake, running: true } as unknown as Orchestrator
  const b = await make(tmp(), OPEN, busy).start('scheduled', { countries: ['KZ'] })
  assert.equal(b.started, undefined)
  assert.equal(seen.length, 1)
})

test('статус показывает пояснение (notice), если оно есть', () => {
  assert.equal(make(tmp(), OPEN, null, { notice: () => 'Незавершённая проверка не продолжена' }).status().notice, 'Незавершённая проверка не продолжена')
  assert.equal(make(tmp(), OPEN).status().notice, undefined)
})

test('start: гейт блокирует обычный запуск, но не пробный', async () => {
  let started = 0
  const fake = {
    running: false,
    current: () => null,
    stop: () => null,
    start: () => {
      started++
      return Promise.resolve({ ok: false as const, blocked: 'Нет ни одной включённой страны. Включите страну в разделе «Страны».' })
    },
  } as unknown as Orchestrator
  const c = make(tmp(), CLOSED, fake)
  const r = await c.start('manual')
  assert.deepEqual(r, { ok: false, message: MAIL_GATE_MESSAGE })
  assert.equal(started, 0)
  const d = await c.start('dry_run')
  assert.equal(started, 1)
  assert.equal(d.ok, false)
  assert.match(d.message, /включённой страны/)
})

test('start: неверный период и исключение оркестратора дают русский текст', async () => {
  const fake = {
    running: false,
    current: () => null,
    stop: () => null,
    start: () => {
      throw new Error('boom at /x/y.ts:1')
    },
  } as unknown as Orchestrator
  const c = make(tmp(), OPEN, fake)
  const bad = await c.start('backfill', { window: { from: '2026-11-20', to: '2026-11-01' } })
  assert.equal(bad.ok, false)
  const err = await c.start('manual')
  assert.equal(err.ok, false)
  assert.doesNotMatch(err.message, /boom|\.ts/)
})

test('stop без прогона', async () => {
  assert.deepEqual(await make(tmp(), OPEN).stop(), { ok: false, message: NOTHING_RUNNING_MESSAGE })
  const fake = { running: false, current: () => null, stop: () => null } as unknown as Orchestrator
  assert.deepEqual(await make(tmp(), OPEN, fake).stop(), { ok: false, message: NOTHING_RUNNING_MESSAGE })
})

test('статус: письмо прогона (DLV-06) приходит из mailStatus; сбой mailStatus не ломает окно', () => {
  const ws = tmp()
  const { dir, state } = createRun({ workspaceDir: ws, mode: 'manual', countries: [{ code: 'UZ', window: W }], skillsHash: 'h', now: new Date(2026, 10, 17, 8, 0) })
  saveRun(dir, state)
  const mail = { state: 'queued' as const, attempts: 2, lastError: 'Почтовый сервис не отвечает.', nextAttemptAt: '2026-11-17T08:30:00.000Z' }
  const st = make(ws, OPEN, undefined, { mailStatus: (run) => (run?.id === '2026-11-17_0800' ? mail : undefined) }).status()
  assert.deepEqual(st.mail, mail)
  const st2 = make(ws, OPEN, undefined, {
    mailStatus: () => {
      throw new Error('битый outbox')
    },
  }).status()
  assert.equal(st2.mail, undefined)
  assert.equal(st2.run?.id, '2026-11-17_0800')
})

test('статус: оценка до прогона (NFR-08) из подставной функции, кэш 10 с, не при идущем прогоне', () => {
  const ws = tmp()
  const countries = [
    { code: 'UZ', name: 'Узбекистан', languages: [], active: true, sources: [] },
    { code: 'KZ', name: 'Казахстан', languages: [], active: true, sources: [] },
    { code: 'GE', name: 'Грузия', languages: [], active: false, sources: [] },
  ] as unknown as Country[]
  let calls = 0
  let t = 1_000_000
  const c = make(ws, OPEN, undefined, {
    getCountries: () => countries,
    nowMs: () => t,
    // синтетические числа
    estimate: (list) => {
      calls++
      assert.equal(list.length, 2) // только включённые
      return { perCountry: [{ code: 'UZ', usdLow: 1, usdHigh: 2, basis: 'history', days: 30, from: '2026-10-23', to: '2026-11-22' }, { code: 'KZ', usdLow: 1, usdHigh: 2, basis: 'default', days: 7, from: '2026-11-15', to: '2026-11-22' }], totalUsdLow: 2, totalUsdHigh: 4, limitPercentLow: 10, limitPercentHigh: 90, runsConsidered: 1 }
    },
  })
  const st = c.status()
  assert.deepEqual(st.estimate, { usd: [2, 4], limitPercent: [10, 90], countries: 2, days: 30, from: '2026-10-23', to: '2026-11-22', basis: 'default', exceedsLimit: true }) // порог по умолчанию 80; одна страна без истории — вся оценка «грубая»
  c.status()
  assert.equal(calls, 1)
  t += 11_000
  c.status()
  assert.equal(calls, 2)
})

test('статус: оценка отсутствует без включённых стран и при сбое расчёта', () => {
  assert.equal(make(tmp(), OPEN).status().estimate, undefined)
  const c = make(tmp(), OPEN, undefined, {
    getCountries: () => [{ code: 'UZ', name: 'Узбекистан', languages: [], active: true, sources: [] }] as unknown as Country[],
    estimate: () => {
      throw new Error('boom')
    },
  })
  assert.equal(c.status().estimate, undefined)
})
