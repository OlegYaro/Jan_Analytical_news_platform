import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createScheduler,
  dueRuns,
  lastSlotAtOrBefore,
  loadFiredState,
  nextRunAt,
  nextRunTimes,
  planQueue,
  rebaseline,
  resolveCountries,
  RETRY_AFTER_MS,
  SCHEDULE_FIRED_FILE,
} from './scheduler.ts'
import type { SchedulerDeps, StartScheduledResult } from './scheduler.ts'
import { defaultSettings } from './settings/defaults.ts'
import type { Country, ScheduleEntry, Settings } from '../shared/types.ts'

// Все времена — местные часы Берлина: там переходы 2026-03-29 (02:00→03:00) и 2026-10-25 (03:00→02:00).
process.env.TZ = 'Europe/Berlin'

const sch = (id: string, over: Partial<ScheduleEntry> = {}): ScheduleEntry => ({ id, name: id, enabled: true, days: [1], time: '08:00', countries: [], ...over })
const country = (code: string, active = true): Country =>
  ({ code, name: code, languages: [], active, sources: [], watchedActs: [], lastCheckedAt: null, lastRunSummary: '' }) as Country
const ALL = [country('KZ'), country('UZ'), country('KG'), country('MN', false)]
const iso = (d: Date): string => d.toISOString()

// ---- nextRunTimes / слоты ----

test('ближайший запуск: понедельник 08:00 местного времени', () => {
  // 2026-11-20 — пятница
  const at = nextRunAt(sch('a'), new Date('2026-11-20T10:00:00+01:00'))
  assert.equal(iso(at!), '2026-11-23T07:00:00.000Z')
  // ровно в момент запуска — следующий уже через неделю
  assert.equal(iso(nextRunAt(sch('a'), new Date('2026-11-23T08:00:00+01:00'))!), '2026-11-30T07:00:00.000Z')
})

test('nextRunTimes: только включённые, по порядку списка', () => {
  const now = new Date('2026-11-20T10:00:00+01:00')
  const r = nextRunTimes([sch('a'), sch('b', { enabled: false }), sch('c', { days: [5], time: '11:00' })], now)
  assert.deepEqual(r.map((x) => [x.id, iso(x.at)]), [
    ['a', '2026-11-23T07:00:00.000Z'],
    ['c', '2026-11-20T10:00:00.000Z'],
  ])
})

test('DST весна (2026-03-29): 08:00 остаётся 08:00 по местным часам, без сдвига', () => {
  const daily = sch('d', { days: [0, 1, 2, 3, 4, 5, 6] })
  const at = nextRunAt(daily, new Date('2026-03-28T09:00:00+01:00'))
  assert.equal(iso(at!), '2026-03-29T06:00:00.000Z') // 08:00 CEST, а не 07:00Z (это было бы +24 ч)
})

test('DST весна: несуществующее 02:30 → один запуск в 03:30, без пропуска', () => {
  const e = sch('n', { days: [0], time: '02:30' })
  const at = nextRunAt(e, new Date('2026-03-28T12:00:00+01:00'))
  assert.equal(iso(at!), '2026-03-29T01:30:00.000Z') // 03:30 CEST
  const due = dueRuns([e], { n: '2026-03-28T12:00:00+01:00' }, new Date('2026-03-29T01:30:20Z'), { catchUp: false })
  assert.deepEqual(due.map((d) => d.id), ['n'])
  // после срабатывания до следующего воскресенья — ничего
  const fired = { n: '2026-03-29T01:30:20Z' }
  for (const t of ['2026-03-29T01:31:00Z', '2026-03-29T02:30:00Z', '2026-03-29T12:00:00Z']) {
    assert.deepEqual(dueRuns([e], fired, new Date(t), { catchUp: true }), [], t)
  }
})

test('DST осень (2026-10-25): дважды бывающее 02:30 — один запуск (первый), без дубля', () => {
  const e = sch('f', { days: [0], time: '02:30' })
  const at = nextRunAt(e, new Date('2026-10-24T12:00:00+02:00'))
  assert.equal(iso(at!), '2026-10-25T00:30:00.000Z') // 02:30 CEST (первое)
  const fired = { f: '2026-10-24T12:00:00+02:00' }
  assert.deepEqual(dueRuns([e], fired, new Date('2026-10-25T00:30:30Z'), { catchUp: true }).map((d) => d.id), ['f'])
  // второе 02:30 (CET, 01:30Z) — уже не запуск
  assert.deepEqual(dueRuns([e], { f: '2026-10-25T00:30:30Z' }, new Date('2026-10-25T01:30:30Z'), { catchUp: true }), [])
  assert.equal(iso(nextRunAt(e, new Date('2026-10-25T01:30:30Z'))!), '2026-11-01T01:30:00.000Z') // следующее воскресенье, CET
})

test('DST осень: ежедневное 08:00 после перехода — 08:00 CET', () => {
  const daily = sch('d', { days: [0, 1, 2, 3, 4, 5, 6] })
  assert.equal(iso(nextRunAt(daily, new Date('2026-10-24T09:00:00+02:00'))!), '2026-10-25T07:00:00.000Z')
  assert.equal(iso(lastSlotAtOrBefore(daily, new Date('2026-10-25T07:00:00Z'))!), '2026-10-25T07:00:00.000Z')
})

// ---- dueRuns ----

const MON_0800 = new Date('2026-11-23T08:00:00+01:00')
const before = { a: '2026-11-20T10:00:00+01:00' }

test('вовремя: в пределах 5 минут после времени — запуск, повторно в ту же минуту — нет', () => {
  const t = new Date(MON_0800.getTime() + 20_000)
  assert.deepEqual(dueRuns([sch('a')], before, t, { catchUp: false }).map((d) => [d.id, d.catchUp]), [['a', false]])
  assert.deepEqual(dueRuns([sch('a')], { a: iso(t) }, new Date(t.getTime() + 15_000), { catchUp: false }), [])
  assert.deepEqual(dueRuns([sch('a')], before, new Date(MON_0800.getTime() - 1000), { catchUp: true }), [])
})

test('догон: Mac спал в 08:00 — запуск при пробуждении в 14:00, один раз', () => {
  const t = new Date('2026-11-23T14:00:00+01:00')
  const due = dueRuns([sch('a')], before, t, { catchUp: true })
  assert.deepEqual(due.map((d) => [d.id, d.catchUp, iso(d.slot)]), [['a', true, '2026-11-23T07:00:00.000Z']])
  assert.deepEqual(dueRuns([sch('a')], { a: iso(t) }, new Date(t.getTime() + 60_000), { catchUp: true }), [])
})

test('догон выключен: пропущенное не запускается', () => {
  assert.deepEqual(dueRuns([sch('a')], before, new Date('2026-11-23T14:00:00+01:00'), { catchUp: false }), [])
})

test('догон: несколько пропущенных времён — один запуск (за последнее)', () => {
  const daily = sch('a', { days: [0, 1, 2, 3, 4, 5, 6] })
  // приложение было закрыто с пятницы до понедельника 12:00
  const due = dueRuns([daily], { a: '2026-11-20T09:00:00+01:00' }, new Date('2026-11-23T12:00:00+01:00'), { catchUp: true })
  assert.equal(due.length, 1)
  assert.equal(iso(due[0]!.slot), '2026-11-23T07:00:00.000Z')
})

test('догон: окно ограничено', () => {
  const t = new Date('2026-11-24T14:00:00+01:00') // через 30 ч после пн 08:00
  assert.equal(dueRuns([sch('a')], before, t, { catchUp: true, catchUpWindowHours: 24 }).length, 0)
  assert.equal(dueRuns([sch('a')], before, t, { catchUp: true, catchUpWindowHours: 48 }).length, 1)
})

test('без записи о срабатывании — только вовремя (отсчёт не начат, догонять нечего)', () => {
  assert.equal(dueRuns([sch('a')], {}, new Date('2026-11-23T14:00:00+01:00'), { catchUp: true }).length, 0)
  assert.equal(dueRuns([sch('a')], {}, new Date(MON_0800.getTime() + 1000), { catchUp: true }).length, 1)
})

test('выключенное расписание не запускается', () => {
  assert.deepEqual(dueRuns([sch('a', { enabled: false })], before, new Date(MON_0800.getTime() + 1000), { catchUp: true }), [])
})

test('два расписания в одно время — оба, по порядку списка', () => {
  const list = [sch('b'), sch('a'), sch('c', { time: '09:00' })]
  const due = dueRuns(list, { a: before.a, b: before.a, c: before.a }, new Date(MON_0800.getTime() + 1000), { catchUp: false })
  assert.deepEqual(due.map((d) => d.id), ['b', 'a'])
})

// ---- rebaseline ----

test('rebaseline: новое, изменённое и включённое расписание отсчитываются от «сейчас»; удалённое забывается', () => {
  const now = new Date('2026-11-23T12:00:00+01:00')
  const old = '2026-11-16T07:00:00.000Z'
  const prev = [sch('same'), sch('time'), sch('days'), sch('off', { enabled: false }), sch('gone')]
  const next = [sch('same', { countries: ['KZ'], name: 'другое' }), sch('time', { time: '07:00' }), sch('days', { days: [1, 2] }), sch('off'), sch('new')]
  const r = rebaseline(prev, next, { same: old, time: old, days: old, off: old, gone: old }, now)
  assert.deepEqual(r, { same: old, time: iso(now), days: iso(now), off: iso(now), new: iso(now) })
  // при запуске приложения (prev = null) — только тем, у кого записи нет
  assert.deepEqual(rebaseline(null, [sch('same'), sch('x')], { same: old }, now), { same: old, x: iso(now) })
})

// ---- страны и очередь ----

test('resolveCountries: пусто — все включённые; выключенные и несуществующие отброшены', () => {
  assert.deepEqual(resolveCountries(sch('a'), ALL), ['KZ', 'UZ', 'KG'])
  assert.deepEqual(resolveCountries(sch('a', { countries: ['UZ', 'MN', 'ZZ'] }), ALL), ['UZ'])
  assert.deepEqual(resolveCountries(sch('a', { countries: ['MN'] }), ALL), [])
})

test('planQueue: страна из двух сработавших расписаний проверяется один раз', () => {
  const q = planQueue([sch('a', { countries: ['KZ', 'UZ'] }), sch('b', { countries: ['UZ', 'KG'] }), sch('c', { countries: ['KZ'] }), sch('d', { countries: ['MN'] })], ALL)
  assert.deepEqual(
    q.map((x) => [x.id, x.countries, x.skip]),
    [
      ['a', ['KZ', 'UZ'], null],
      ['b', ['KG'], null],
      ['c', [], 'covered'],
      ['d', [], 'no_countries'],
    ],
  )
  // «все страны» после частного — только оставшиеся
  assert.deepEqual(planQueue([sch('a', { countries: ['UZ'] }), sch('all')], ALL).map((x) => x.countries), [['UZ'], ['KZ', 'KG']])
})

// ---- обвязка ----

interface Harness {
  deps: SchedulerDeps
  started: Array<{ id: string; countries: string[] }>
  notices: string[]
  setNow(d: Date): void
  busy: { value: boolean }
  unfinished: { value: boolean; resumes: number }
  refuse: { message: string | null }
  ws: string
  settings: Settings
}

function harness(schedules: ScheduleEntry[], opts: { catchUp?: boolean; fired?: Record<string, string> } = {}): Harness {
  const ws = mkdtempSync(join(tmpdir(), 'rw-sched-'))
  const settings: Settings = { ...defaultSettings('/home/u'), workspaceDir: ws, schedules, catchUpMissed: opts.catchUp ?? true }
  if (opts.fired) {
    mkdirSync(join(ws, 'state'), { recursive: true })
    writeFileSync(join(ws, SCHEDULE_FIRED_FILE), JSON.stringify({ version: 1, fired: opts.fired, lastStarted: {} }))
  }
  let now = new Date()
  const h: Harness = {
    started: [],
    notices: [],
    busy: { value: false },
    unfinished: { value: false, resumes: 0 },
    refuse: { message: null },
    ws,
    settings,
    setNow: (d) => {
      now = d
    },
    deps: {
      getSettings: () => h.settings,
      getCountries: () => ALL,
      isBusy: () => h.busy.value,
      hasUnfinished: () => h.unfinished.value,
      resumeUnfinished: async () => {
        h.unfinished.resumes++
      },
      startRun: async (entry, countries): Promise<StartScheduledResult> => {
        if (h.refuse.message) return { started: false, message: h.refuse.message }
        h.started.push({ id: entry.id, countries })
        h.busy.value = true // прогон идёт, пока тест не «завершит» его
        return { started: true, message: '' }
      },
      notice: (t) => h.notices.push(t),
      now: () => now,
    },
  }
  return h
}

const WEEK_AGO = '2026-11-16T12:00:00.000Z'

test('обвязка: два расписания сразу — по очереди, без повтора стран; состояние в файле', async () => {
  const h = harness([sch('a', { countries: ['KZ', 'UZ'] }), sch('b', { countries: ['UZ', 'KG'] }), sch('c', { countries: ['KZ'] })], {
    fired: { a: WEEK_AGO, b: WEEK_AGO, c: WEEK_AGO },
  })
  const s = createScheduler(h.deps)
  h.setNow(new Date(MON_0800.getTime() + 10_000))
  await s.tick()
  assert.deepEqual(h.started, [{ id: 'a', countries: ['KZ', 'UZ'] }])
  assert.deepEqual(s.status().queued, ['b', 'c'])
  const st = loadFiredState(h.ws)
  assert.equal(st.fired['a'], iso(new Date(MON_0800.getTime() + 10_000)))
  assert.equal(st.lastStarted['a'], st.fired['a'])
  assert.equal(st.fired['b'], WEEK_AGO) // ещё не стартовал — не записан

  // пока идёт прогон — ничего нового
  h.setNow(new Date(MON_0800.getTime() + 40_000))
  await s.tick()
  assert.equal(h.started.length, 1)

  // прогон закончился (через 2 часа, вне окна «вовремя») — очередь продолжается
  h.busy.value = false
  h.setNow(new Date(MON_0800.getTime() + 2 * 3600_000))
  await s.tick()
  assert.deepEqual(h.started[1], { id: 'b', countries: ['KG'] })
  h.busy.value = false
  h.setNow(new Date(MON_0800.getTime() + 3 * 3600_000))
  await s.tick()
  // c: KZ уже проверен в этой пачке — пропуск, срабатывание записано, прогона нет
  assert.equal(h.started.length, 2)
  assert.deepEqual(s.status().queued, [])
  const after = JSON.parse(readFileSync(join(h.ws, SCHEDULE_FIRED_FILE), 'utf8'))
  assert.equal(after.version, 1)
  assert.ok(after.fired.c > WEEK_AGO)
  assert.equal(after.lastStarted.c, undefined)
})

test('обвязка: догон после сна, один раз', async () => {
  const h = harness([sch('a')], { fired: { a: WEEK_AGO } })
  const s = createScheduler(h.deps)
  h.setNow(new Date('2026-11-23T15:00:00+01:00'))
  await s.tick()
  assert.deepEqual(h.started, [{ id: 'a', countries: ['KZ', 'UZ', 'KG'] }])
  h.busy.value = false
  h.setNow(new Date('2026-11-23T15:01:00+01:00'))
  await s.tick()
  assert.equal(h.started.length, 1)
})

test('T-9: приложение было закрыто, время расписания прошло — после перезапуска (новый планировщик, тот же файл) прогон стартует сам, один раз', async () => {
  const h = harness([sch('a')], { fired: { a: WEEK_AGO } })
  // Первый запуск приложения: понедельник 08:00 — вовремя.
  const s1 = createScheduler(h.deps)
  h.setNow(new Date(MON_0800.getTime() + 10_000))
  await s1.tick()
  assert.equal(h.started.length, 1)
  s1.stop()
  h.busy.value = false
  // Приложение закрыто неделю + 1 день: следующий понедельник 08:00 пропущен. Новый процесс — новый планировщик.
  const s2 = createScheduler(h.deps)
  const restart = new Date(MON_0800.getTime() + 8 * 24 * 3600_000 + 3600_000)
  h.setNow(restart)
  await s2.tick()
  assert.equal(h.started.length, 2, 'догон пропущенного при старте')
  assert.equal(loadFiredState(h.ws).lastStarted['a'], iso(restart))
  h.busy.value = false
  h.setNow(new Date(restart.getTime() + 30_000))
  await s2.tick()
  // Ещё один перезапуск в тот же день — без повтора.
  const s3 = createScheduler(h.deps)
  await s3.tick()
  assert.equal(h.started.length, 2, 'повторно не запускается')
})

test('T-9: сон Mac — таймер не тикал, после пробуждения (powerMonitor resume → tick) по подставным часам — догон; без «Если компьютер был выключен» — нет', async () => {
  for (const catchUp of [true, false]) {
    // Вчерашнее 09:00 уже сработало.
    const h = harness([sch('a', { days: [0, 1, 2, 3, 4, 5, 6], time: '09:00' })], { fired: { a: '2026-11-23T08:00:30.000Z' }, catchUp })
    const s = createScheduler(h.deps)
    h.setNow(new Date('2026-11-24T08:59:00+01:00'))
    await s.tick()
    assert.equal(h.started.length, 0)
    // Mac уснул в 08:59 и проснулся в 13:00: шагов таймера не было, срабатывает tick по событию пробуждения.
    h.setNow(new Date('2026-11-24T13:00:00+01:00'))
    await s.tick()
    assert.equal(h.started.length, catchUp ? 1 : 0)
  }
})

test('обвязка: первый запуск приложения — точка отсчёта, прошлое не догоняется', async () => {
  const h = harness([sch('a')])
  const s = createScheduler(h.deps)
  h.setNow(new Date('2026-11-23T15:00:00+01:00'))
  await s.tick()
  assert.equal(h.started.length, 0)
  assert.equal(loadFiredState(h.ws).fired['a'], iso(new Date('2026-11-23T15:00:00+01:00')))
  h.setNow(new Date('2026-11-30T08:00:30+01:00'))
  await s.tick()
  assert.equal(h.started.length, 1)
})

test('обвязка: незавершённый прогон важнее — новые не стартуют, продолжение не чаще раза в 5 минут', async () => {
  const h = harness([sch('a')], { fired: { a: WEEK_AGO } })
  h.unfinished.value = true
  const s = createScheduler(h.deps)
  h.setNow(new Date(MON_0800.getTime() + 10_000))
  await s.tick()
  h.setNow(new Date(MON_0800.getTime() + 40_000))
  await s.tick()
  assert.equal(h.unfinished.resumes, 1)
  assert.equal(h.started.length, 0)
  assert.deepEqual(s.status().queued, ['a'])
  h.unfinished.value = false
  h.setNow(new Date(MON_0800.getTime() + 3600_000))
  await s.tick()
  assert.equal(h.started.length, 1)
})

test('обвязка: отказ (почта не настроена) — пояснение, срабатывание не записано, повтор не раньше 5 минут', async () => {
  const h = harness([sch('a', { name: 'Основная' })], { fired: { a: WEEK_AGO } })
  h.refuse.message = 'Без настроенной почты регулярная проверка не запустится.'
  const s = createScheduler(h.deps)
  const t0 = new Date('2026-11-23T10:00:00+01:00')
  h.setNow(t0)
  await s.tick()
  assert.equal(h.notices.length, 1)
  assert.match(h.notices[0]!, /«Основная» не запущена: Без настроенной почты/)
  assert.equal(loadFiredState(h.ws).fired['a'], WEEK_AGO)
  h.setNow(new Date(t0.getTime() + 60_000))
  await s.tick()
  assert.equal(h.notices.length, 1)
  h.refuse.message = null
  h.setNow(new Date(t0.getTime() + RETRY_AFTER_MS + 1000))
  await s.tick()
  assert.equal(h.started.length, 1)
})

test('обвязка: расписание без включённых стран — пояснение, запуска нет, повторов нет', async () => {
  const h = harness([sch('a', { countries: ['MN'], name: 'Монголия' })], { fired: { a: WEEK_AGO } })
  const s = createScheduler(h.deps)
  h.setNow(new Date(MON_0800.getTime() + 10_000))
  await s.tick()
  h.setNow(new Date(MON_0800.getTime() + 40_000))
  await s.tick()
  assert.equal(h.started.length, 0)
  assert.equal(h.notices.length, 1)
  assert.match(h.notices[0]!, /«Монголия».*нет ни одной включённой страны/)
})

test('обвязка: выключенное расписание и выключение во время ожидания в очереди', async () => {
  const h = harness([sch('a', { countries: ['KZ'] }), sch('b', { countries: ['UZ'] }), sch('off', { enabled: false })], {
    fired: { a: WEEK_AGO, b: WEEK_AGO, off: WEEK_AGO },
  })
  const s = createScheduler(h.deps)
  h.setNow(new Date(MON_0800.getTime() + 10_000))
  await s.tick()
  assert.deepEqual(s.status().queued, ['b'])
  // пользователь выключил b, пока шёл a
  const prev = h.settings.schedules
  h.settings = { ...h.settings, schedules: [prev[0]!, { ...prev[1]!, enabled: false }, prev[2]!] }
  s.settingsChanged(prev, h.settings.schedules)
  h.busy.value = false
  h.setNow(new Date(MON_0800.getTime() + 3600_000))
  await s.tick()
  assert.deepEqual(h.started.map((x) => x.id), ['a'])
  assert.deepEqual(s.status().queued, [])
})

test('обвязка: смена времени — прошедшее новое время не догоняется', async () => {
  const h = harness([sch('a')], { fired: { a: WEEK_AGO } })
  const s = createScheduler(h.deps)
  h.setNow(new Date('2026-11-23T07:30:00+01:00')) // до 08:00
  await s.tick()
  const prev = h.settings.schedules
  h.settings = { ...h.settings, schedules: [{ ...prev[0]!, time: '07:00' }] } // новое время уже прошло
  s.settingsChanged(prev, h.settings.schedules)
  h.setNow(new Date('2026-11-23T07:31:00+01:00'))
  await s.tick()
  assert.equal(h.started.length, 0)
})

test('status: ближайший запуск, страны, последний старт', async () => {
  const h = harness([sch('a', { countries: ['UZ', 'MN'] }), sch('b', { enabled: false })], { fired: { a: WEEK_AGO, b: WEEK_AGO } })
  const s = createScheduler(h.deps)
  h.setNow(new Date('2026-11-20T10:00:00+01:00'))
  const st = s.status()
  assert.deepEqual(st.entries, [
    { id: 'a', name: 'a', enabled: true, nextRunAt: '2026-11-23T07:00:00.000Z', lastStartedAt: null, countries: ['UZ'] },
    { id: 'b', name: 'b', enabled: false, nextRunAt: null, lastStartedAt: null, countries: ['KZ', 'UZ', 'KG'] },
  ])
})

test('битый файл состояния — пустое состояние', () => {
  const ws = mkdtempSync(join(tmpdir(), 'rw-sched-'))
  mkdirSync(join(ws, 'state'), { recursive: true })
  writeFileSync(join(ws, SCHEDULE_FIRED_FILE), '{не json')
  assert.deepEqual(loadFiredState(ws), { fired: {}, lastStarted: {} })
  writeFileSync(join(ws, SCHEDULE_FIRED_FILE), JSON.stringify({ fired: { a: 'вчера', b: WEEK_AGO } }))
  assert.deepEqual(loadFiredState(ws), { fired: { b: WEEK_AGO }, lastStarted: {} })
})
