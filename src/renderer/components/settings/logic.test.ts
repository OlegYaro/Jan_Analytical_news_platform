import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ScheduleEntry } from '../../../shared/types.ts'
import {
  canAddSchedule, canRemoveSchedule, countriesLabel, effectiveCountries, effectiveRecipients, findOverlaps, formatNextRun,
  nearestRun, nearestRunText, newSchedule, nextTabIndex, parseScheduleErrors, scheduleRuns, toggleCountry, uncoveredCountries, mergeErrors, nextRun, parseMinutes, parseRecipients, parseTime, patchPaths, toggleDay,
} from './logic.ts'

// 2026-11-17 — вторник
const tue10 = new Date(2026, 10, 17, 10, 0)

test('nextRun: сегодня позже по времени', () => {
  const d = nextRun([2], '12:30', tue10)
  assert.equal(d?.getDate(), 17)
  assert.equal(d?.getHours(), 12)
})

test('nextRun: время уже прошло — через неделю', () => {
  const d = nextRun([2], '08:00', tue10)
  assert.equal(d?.getDate(), 24)
})

test('nextRun: ближайший из нескольких дней, воскресенье = 0', () => {
  const d = nextRun([0, 1], '08:00', tue10)
  assert.equal(d?.getDay(), 0)
  assert.equal(d?.getDate(), 22)
})

test('nextRun: нет дней или плохое время', () => {
  assert.equal(nextRun([], '08:00', tue10), null)
  assert.equal(nextRun([1], '8:00', tue10), null)
})

test('formatNextRun', () => {
  assert.equal(formatNextRun(new Date(2026, 10, 17, 12, 30), tue10), 'сегодня, 12:30')
  assert.equal(formatNextRun(new Date(2026, 10, 18, 8, 0), tue10), 'завтра, 08:00')
  assert.equal(formatNextRun(new Date(2026, 10, 22, 8, 0), tue10), 'воскресенье, 08:00')
  assert.equal(formatNextRun(new Date(2026, 10, 24, 8, 0), tue10), 'вт 24 ноября, 08:00')
})

test('formatNextRun: английский', () => {
  assert.equal(formatNextRun(new Date(2026, 10, 17, 12, 30), tue10, 'en'), 'today, 12:30')
  assert.equal(formatNextRun(new Date(2026, 10, 18, 8, 0), tue10, 'en'), 'tomorrow, 08:00')
  assert.equal(formatNextRun(new Date(2026, 10, 22, 8, 0), tue10, 'en'), 'Sunday, 08:00')
  assert.equal(formatNextRun(new Date(2026, 10, 24, 8, 0), tue10, 'en'), 'Tue 24 Nov, 08:00')
})

test('parseTime', () => {
  assert.deepEqual(parseTime('08:05'), { h: 8, m: 5 })
  assert.equal(parseTime('24:00'), null)
})

test('toggleDay сортирует', () => {
  assert.deepEqual(toggleDay([1, 4], 0), [0, 1, 4])
  assert.deepEqual(toggleDay([1, 4], 1), [4])
})

test('parseRecipients: разделители и дубли', () => {
  assert.deepEqual(parseRecipients(' a@x.ru, b@y.ru;a@x.ru\nc@z.ru '), ['a@x.ru', 'b@y.ru', 'c@z.ru'])
  assert.deepEqual(parseRecipients('  '), [])
})

test('effectiveRecipients: пусто = ваш адрес', () => {
  assert.deepEqual(effectiveRecipients('', ' me@x.ru '), ['me@x.ru'])
  assert.deepEqual(effectiveRecipients('a@x.ru', 'me@x.ru'), ['a@x.ru'])
  assert.deepEqual(effectiveRecipients('', ''), [])
})

test('patchPaths и mergeErrors', () => {
  assert.deepEqual(patchPaths({ scheduleTime: '08:00', mail: { address: 'a', recipients: ['x'] } }), [
    'scheduleTime', 'mail.address', 'mail.recipients',
  ])
  const prev = { scheduleTime: 'ош', 'mail.address': 'ош2' }
  assert.deepEqual(mergeErrors(prev, { scheduleTime: '09:00' }, {}), { 'mail.address': 'ош2' })
  assert.deepEqual(mergeErrors(prev, { scheduleTime: '99' }, { scheduleTime: 'new' }), { 'mail.address': 'ош2', scheduleTime: 'new' })
})

test('parseMinutes', () => {
  assert.equal(parseMinutes(' 10 '), 10)
  assert.equal(parseMinutes('0'), null)
  assert.equal(parseMinutes('1.5'), null)
  assert.equal(parseMinutes(''), null)
})

const mk = (id: string, days: number[], time: string, countries: string[] = [], enabled = true): ScheduleEntry => ({
  id, name: id, enabled, days, time, countries,
})

test('newSchedule: уникальные id/название, свободный день', () => {
  const a = newSchedule([])
  assert.deepEqual([a.id, a.name, a.days, a.time, a.countries, a.enabled], ['s1', 'Расписание 1', [1], '08:00', [], true])
  const b = newSchedule([a])
  assert.deepEqual([b.id, b.name, b.days], ['s2', 'Расписание 2', [4]])
  const c = newSchedule([mk('s1', [1], '08:00'), { ...mk('s3', [4], '08:00'), name: 'Расписание 3' }])
  assert.equal(c.id, 's2')
  assert.equal(c.name, 'Расписание 4')
  assert.deepEqual(c.days, [2])
})

test('лимит расписаний', () => {
  const nine = Array.from({ length: 9 }, (_, i) => mk(`s${i}`, [1], '08:00'))
  assert.equal(canAddSchedule(nine), false)
  assert.equal(canAddSchedule(nine.slice(1)), true)
  assert.equal(canRemoveSchedule([nine[0]]), false)
  assert.equal(canRemoveSchedule(nine.slice(0, 2)), true)
})

test('страны расписания', () => {
  assert.deepEqual(effectiveCountries({ countries: [] }, ['UZ', 'KZ']), ['UZ', 'KZ'])
  assert.deepEqual(effectiveCountries({ countries: ['KZ', 'AM'] }, ['UZ', 'KZ']), ['KZ'])
  assert.deepEqual(toggleCountry(['UZ'], 'KZ'), ['UZ', 'KZ'])
  assert.deepEqual(toggleCountry(['UZ', 'KZ'], 'UZ'), ['KZ'])
  const known = [{ code: 'UZ', name: 'Узбекистан' }, { code: 'KZ', name: 'Казахстан' }]
  assert.equal(countriesLabel({ countries: ['UZ', 'KZ'] }, known, 'Все'), 'Узбекистан, Казахстан')
  assert.equal(countriesLabel({ countries: [] }, known, 'Все'), 'Все')
})

test('ближайшие запуски по списку', () => {
  const list = [mk('a', [1], '08:00', ['UZ']), mk('b', [4], '08:00'), mk('c', [3], '07:00', [], false), mk('d', [], '08:00')]
  const runs = scheduleRuns(list, tue10)
  assert.deepEqual(runs.map((r) => r.entry.id), ['b', 'a'])
  assert.equal(nearestRun(list, tue10)?.date.getDate(), 19)
  assert.equal(nearestRun([list[2], list[3]], tue10), null)
  const same = nearestRun([mk('x', [4], '08:00', ['UZ']), mk('y', [4], '08:00', ['KZ'])], tue10)
  assert.equal(same?.entries.length, 2)
  const known = [{ code: 'UZ', name: 'Узбекистан' }, { code: 'KZ', name: 'Казахстан' }]
  const labels = { countries: 'страны', all: 'Все включённые страны' }
  assert.equal(nearestRunText([mk('x', [4], '08:00', ['UZ', 'KZ'])], tue10, known, labels), 'четверг, 08:00 · страны: Узбекистан, Казахстан')
  assert.equal(nearestRunText([mk('x', [4], '08:00')], tue10, known, labels), 'четверг, 08:00 · страны: все включённые страны')
  assert.equal(nearestRunText([mk('x', [], '08:00')], tue10, known, labels), null)
})

test('пересечения и непокрытые страны', () => {
  const active = ['UZ', 'KZ', 'GE']
  const a = mk('a', [1, 4], '08:00', ['UZ', 'KZ'])
  const b = mk('b', [4], '09:00', ['KZ', 'GE'])
  assert.deepEqual(findOverlaps([a, b], active), [{ a: 0, b: 1, days: [4], codes: ['KZ'] }])
  assert.deepEqual(findOverlaps([a, mk('c', [2], '08:00', ['KZ'])], active), [])
  assert.deepEqual(findOverlaps([a, { ...b, enabled: false }], active), [])
  // «все страны» пересекаются с любым расписанием в тот же день
  assert.equal(findOverlaps([a, mk('d', [1], '10:00')], active)[0].codes.length, 2)
  assert.deepEqual(uncoveredCountries([a], active), ['GE'])
  assert.deepEqual(uncoveredCountries([a, mk('d', [2], '08:00')], active), [])
  assert.deepEqual(uncoveredCountries([{ ...a, enabled: false }], ['UZ']), ['UZ'])
})

test('parseScheduleErrors', () => {
  const r = parseScheduleErrors({
    'schedules.2.days': 'д', 'schedules.0.time': 'в', 'schedules.name': 'общая', schedules: 'все', 'schedules.1': 'целиком', launchAtLogin: 'x',
  })
  assert.deepEqual(r.general.sort(), ['все', 'общая'])
  assert.deepEqual(r.byIndex, { 2: { days: 'д' }, 0: { time: 'в' }, 1: { entry: 'целиком' } })
})

test('nextTabIndex', () => {
  assert.equal(nextTabIndex(0, 'ArrowRight', 6), 1)
  assert.equal(nextTabIndex(5, 'ArrowRight', 6), 0)
  assert.equal(nextTabIndex(0, 'ArrowLeft', 6), 5)
  assert.equal(nextTabIndex(3, 'Home', 6), 0)
  assert.equal(nextTabIndex(3, 'End', 6), 5)
  assert.equal(nextTabIndex(3, 'Enter', 6), null)
})
