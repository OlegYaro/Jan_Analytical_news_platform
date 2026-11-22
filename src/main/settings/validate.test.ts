import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateSettings } from './validate.ts'
import { defaultSettings } from './defaults.ts'
import type { SettingsPatch } from '../../shared/types.ts'

const bad = (p: SettingsPatch, path: string) => {
  const r = validateSettings(p)
  assert.equal(r.ok, false)
  assert.ok(r.errors[path], path)
  assert.doesNotMatch(r.errors[path]!, /JSON|SMTP|CLI|токен/i)
}

test('значения по умолчанию (с заполненной почтой) валидны', () => {
  const d = defaultSettings('/h')
  d.mail.address = 'a@b.co'
  d.mail.recipients = ['a@b.co']
  assert.equal(validateSettings(d).ok, true)
})
test('пустой патч валиден', () => assert.equal(validateSettings({}).ok, true))
test('пустая тема', () => bad({ topic: '  ' }, 'topic'))
test('пустая перспектива', () => bad({ perspective: '' }, 'perspective'))
const sch = (over: Record<string, unknown> = {}, id = 'main') => ({ id, name: 'Основная', enabled: true, days: [1], time: '08:00', countries: [], ...over }) as never
test('расписание по умолчанию валидно; до 9 расписаний', () => {
  assert.equal(validateSettings({ schedules: [sch()] }).ok, true)
  assert.equal(validateSettings({ schedules: Array.from({ length: 9 }, (_, i) => sch({}, `s${i}`)) }).ok, true)
})
test('ни одного расписания или больше 9', () => {
  bad({ schedules: [] }, 'schedules')
  bad({ schedules: Array.from({ length: 10 }, (_, i) => sch({}, `s${i}`)) }, 'schedules')
  bad({ schedules: 'пн' as never }, 'schedules')
})
test('время не HH:MM', () => { bad({ schedules: [sch({ time: '8:00' })] }, 'schedules.0.time'); bad({ schedules: [sch({ time: '24:00' })] }, 'schedules.0.time') })
test('ни одного дня', () => bad({ schedules: [sch(), sch({ days: [] }, 'b'), sch({}, 'c')] }, 'schedules.1.days'))
test('день вне 0..6', () => bad({ schedules: [sch({ days: [7] })] }, 'schedules.0.days'))
test('id: шаблон и уникальность', () => {
  bad({ schedules: [sch({}, 'Основная')] }, 'schedules.0.id')
  bad({ schedules: [sch({}, '-x')] }, 'schedules.0.id')
  bad({ schedules: [sch({}, 'a'), sch({}, 'a')] }, 'schedules.1.id')
})
test('название 1..60 знаков', () => {
  bad({ schedules: [sch({ name: '   ' })] }, 'schedules.0.name')
  bad({ schedules: [sch({ name: 'я'.repeat(61) })] }, 'schedules.0.name')
  assert.equal(validateSettings({ schedules: [sch({ name: 'я'.repeat(60) })] }).ok, true)
})
test('страны: коды из 2 заглавных букв без повторов', () => {
  assert.equal(validateSettings({ schedules: [sch({ countries: ['KZ', 'UZ'] })] }).ok, true)
  bad({ schedules: [sch({ countries: ['kz'] })] }, 'schedules.0.countries')
  bad({ schedules: [sch({ countries: ['KZ', 'KZ'] })] }, 'schedules.0.countries')
  bad({ schedules: [sch({ countries: 'KZ' })] }, 'schedules.0.countries')
})
test('флажок «включено» и не-объект', () => {
  bad({ schedules: [sch({ enabled: 'да' })] }, 'schedules.0.enabled')
  bad({ schedules: [5 as never] }, 'schedules.0')
})
test('язык интерфейса', () => {
  assert.equal(validateSettings({ uiLanguage: 'en' }).ok, true)
  bad({ uiLanguage: 'de' as never }, 'uiLanguage')
})
test('ползунок вне 10–100', () => { bad({ limitPercent: 5 }, 'limitPercent'); bad({ limitPercent: 101 }, 'limitPercent') })
test('граничные значения ползунка', () => { assert.equal(validateSettings({ limitPercent: 10 }).ok, true); assert.equal(validateSettings({ limitPercent: 100 }).ok, true) })
test('неверный e-mail', () => bad({ mail: { address: 'abc' } }, 'mail.address'))
test('пустой адрес', () => bad({ mail: { address: '' } }, 'mail.address'))
test('пустые получатели', () => bad({ mail: { recipients: [] } }, 'mail.recipients'))
test('неверный получатель', () => bad({ mail: { recipients: ['a@b.co', 'xx'] } }, 'mail.recipients'))
test('порт', () => bad({ mail: { port: 70000 } }, 'mail.port'))
test('«Другой» без сервера', () => bad({ mail: { service: 'other', server: '' } }, 'mail.server'))
test('режим и язык', () => { bad({ preset: 'x' as never }, 'preset'); bad({ reportLanguage: 'de' as never }, 'reportLanguage') })
test('папка', () => bad({ workspaceDir: '' }, 'workspaceDir'))
test('дополнительно', () => {
  bad({ advanced: { firstRunDays: 0 } }, 'advanced.firstRunDays')
  bad({ advanced: { timeoutsMin: { news: 0 } } }, 'advanced.timeoutsMin.news')
})
