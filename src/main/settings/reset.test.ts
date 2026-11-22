import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSettings, updateSettings } from './store.ts'
import { defaultSettings } from './defaults.ts'
import { resetSection } from './reset.ts'

const home = '/home/u'
const tmp = () => mkdtempSync(join(tmpdir(), 'rw-reset-'))

test('reset: раздел почты очищает адрес и verified, остальное цело', () => {
  const dir = tmp()
  updateSettings(dir, { topic: 'Banking regulation of test country', limitPercent: 50, mail: { address: 'a@example.com', recipients: ['d@example.com'], verified: true } }, { homeDir: home })
  const s = resetSection(dir, 'mail', { homeDir: home })
  assert.equal(s.mail.address, '')
  assert.deepEqual(s.mail.recipients, [])
  assert.equal(s.mail.verified, false)
  assert.equal(s.topic, 'Banking regulation of test country')
  assert.equal(s.limitPercent, 50)
})

test('reset: all сохраняет onboardingDone', () => {
  const dir = tmp()
  updateSettings(dir, { topic: 'Banking regulation of test country', onboardingDone: true }, { homeDir: home })
  const s = resetSection(dir, 'all', { homeDir: home })
  assert.equal(s.onboardingDone, true)
  assert.equal(s.topic, defaultSettings(home).topic)
  assert.deepEqual(loadSettings(dir, { homeDir: home }), s)
})

test('reset: раздел расписания — одно стандартное расписание, автозапуск и догон', () => {
  const dir = tmp()
  updateSettings(dir, {
    schedules: [
      { id: 'a', name: 'А', enabled: true, days: [2], time: '10:00', countries: ['KZ'] },
      { id: 'b', name: 'Б', enabled: true, days: [3], time: '11:00', countries: [] },
    ],
    launchAtLogin: false,
    catchUpMissed: false,
    limitPercent: 40,
  }, { homeDir: home })
  const s = resetSection(dir, 'schedule', { homeDir: home })
  assert.deepEqual(s.schedules, defaultSettings(home).schedules)
  assert.equal(s.launchAtLogin, true)
  assert.equal(s.catchUpMissed, true)
  assert.equal(s.limitPercent, 40)
})

test('reset: all не меняет язык интерфейса', () => {
  const dir = tmp()
  updateSettings(dir, { uiLanguage: 'en', limitPercent: 40 }, { homeDir: home })
  const s = resetSection(dir, 'all', { homeDir: home })
  assert.equal(s.uiLanguage, 'en')
  assert.equal(s.limitPercent, 80)
})
