import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_PERSPECTIVE, DEFAULT_TOPIC } from '../../shared/types.ts'
import { SCHEMA_VERSION } from './defaults.ts'
import { LEGACY_DEFAULT_PERSPECTIVES, LEGACY_DEFAULT_TOPICS } from './legacy-defaults.ts'
import { migrateSettings } from './migrations.ts'

const home = '/Users/test'

test('v2→v3: прежняя тема и perspective по умолчанию заменяются новыми', () => {
  const s = migrateSettings({ schemaVersion: 2, topic: LEGACY_DEFAULT_TOPICS[0], perspective: LEGACY_DEFAULT_PERSPECTIVES[0] }, home)
  assert.equal(s.topic, DEFAULT_TOPIC)
  assert.equal(s.perspective, DEFAULT_PERSPECTIVE)
  assert.equal(s.schemaVersion, SCHEMA_VERSION)
  assert.equal(SCHEMA_VERSION, 4)
})

test('v2→v3: сравнение с точностью до пробелов', () => {
  const s = migrateSettings({ schemaVersion: 2, topic: '  ' + LEGACY_DEFAULT_TOPICS[0]!.replace(/ /g, '\n  ') + '\n' }, home)
  assert.equal(s.topic, DEFAULT_TOPIC)
})

test('v2→v3: правки пользователя не трогаются', () => {
  const s = migrateSettings({ schemaVersion: 2, topic: LEGACY_DEFAULT_TOPICS[0] + ' Plus tax.', perspective: 'Commercial bank risk officer' }, home)
  assert.equal(s.topic, LEGACY_DEFAULT_TOPICS[0] + ' Plus tax.')
  assert.equal(s.perspective, 'Commercial bank risk officer')
  assert.equal(s.schemaVersion, 4)
})

test('файл v3 не мигрируется повторно', () => {
  const s = migrateSettings({ schemaVersion: 3, topic: LEGACY_DEFAULT_TOPICS[0], perspective: LEGACY_DEFAULT_PERSPECTIVES[0] }, home)
  assert.equal(s.topic, LEGACY_DEFAULT_TOPICS[0])
  assert.equal(s.perspective, LEGACY_DEFAULT_PERSPECTIVES[0])
})

test('v0→v3: старый файл без версии с прежней темой тоже обновляется', () => {
  assert.equal(migrateSettings({ topic: LEGACY_DEFAULT_TOPICS[0] }, home).topic, DEFAULT_TOPIC)
})

test('v3→v4: scheduleDays/scheduleTime → одно расписание, язык интерфейса ru', () => {
  const s = migrateSettings({ schemaVersion: 3, scheduleDays: [4, 1, 4], scheduleTime: '07:15', topic: 'Своя тема' }, home)
  assert.deepEqual(s.schedules, [{ id: 'main', name: 'Основная проверка', enabled: true, days: [1, 4], time: '07:15', countries: [] }])
  assert.equal(s.uiLanguage, 'ru')
  assert.equal(s.topic, 'Своя тема')
  assert.equal('scheduleDays' in s, false)
  assert.equal('scheduleTime' in s, false)
  assert.equal(s.schemaVersion, 4)
})

test('v3→v4: неверные старые дни/время → значения по умолчанию', () => {
  const s = migrateSettings({ schemaVersion: 3, scheduleDays: 'пн', scheduleTime: '8:00' }, home)
  assert.deepEqual(s.schedules[0]!.days, [1])
  assert.equal(s.schedules[0]!.time, '08:00')
})

test('v3→v4: шаг миграции не теряет остальные ключи', async () => {
  // Прочие поля (в том числе вложенные) переживают переход; лишнее верхнего уровня отбрасывает только общий добор.
  const s = migrateSettings({ schemaVersion: 3, scheduleDays: [2], limitPercent: 55, mail: { address: 'a@b.co', port: 587 }, advanced: { firstRunDays: 10, stageModels: { triage: 'opus' } } }, home)
  assert.equal(s.limitPercent, 55)
  assert.equal(s.mail.address, 'a@b.co')
  assert.equal(s.mail.port, 587)
  assert.equal(s.advanced.firstRunDays, 10)
  assert.deepEqual(s.advanced.stageModels, { triage: 'opus' })
})

test('v4: список расписаний приводится к схеме (файл испорчен вручную)', () => {
  const s = migrateSettings(
    {
      schemaVersion: 4,
      uiLanguage: 'de',
      schedules: [
        { id: 'a', name: '  Кавказ  ', enabled: false, days: [5, 3, 9], time: '21:00', countries: ['ge', 'AM', 'GE', 'XXX', 7] },
        { id: 'a', name: '', days: [], time: 'утро' },
        'мусор',
        ...Array.from({ length: 12 }, (_, i) => ({ id: `x${i}`, name: `X${i}`, enabled: true, days: [1], time: '08:00', countries: [] })),
      ],
    },
    home,
  )
  assert.equal(s.uiLanguage, 'ru')
  assert.equal(s.schedules.length, 9)
  assert.deepEqual(s.schedules[0], { id: 'a', name: 'Кавказ', enabled: false, days: [3, 5], time: '21:00', countries: ['GE', 'AM'] })
  assert.deepEqual(s.schedules[1], { id: 's2', name: 'Расписание 2', enabled: true, days: [1], time: '08:00', countries: [] })
})

test('v4: пустой список расписаний → одно стандартное', () => {
  assert.deepEqual(migrateSettings({ schemaVersion: 4, schedules: [] }, home).schedules.map((x) => x.id), ['main'])
})

test('v4: правильные данные не меняются', () => {
  const sch = [
    { id: 'main', name: 'Основная проверка', enabled: true, days: [1], time: '08:00', countries: [] },
    { id: 'kz-thu', name: 'Казахстан, четверг', enabled: true, days: [4], time: '09:30', countries: ['KZ'] },
  ]
  const s = migrateSettings({ schemaVersion: 4, schedules: sch, uiLanguage: 'en' }, home)
  assert.deepEqual(s.schedules, sch)
  assert.equal(s.uiLanguage, 'en')
})
