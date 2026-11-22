import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSettings, saveSettings, updateSettings } from './store.ts'
import { defaultSettings } from './defaults.ts'

const home = '/home/u'
const tmp = () => mkdtempSync(join(tmpdir(), 'rw-settings-'))

test('создаёт файл из defaults', () => {
  const dir = tmp()
  const s = loadSettings(dir, { homeDir: home })
  assert.deepEqual(s, defaultSettings(home))
  assert.ok(existsSync(join(dir, 'settings.json')))
})

test('updateSettings сливает и сохраняет', () => {
  const dir = tmp()
  const sch = { id: 'main', name: 'Пн и чт', enabled: true, days: [1, 4], time: '08:00', countries: [] }
  const r = updateSettings(dir, { topic: 'X', mail: { address: 'a@b.co' }, schedules: [sch] }, { homeDir: home })
  assert.equal(r.ok, true)
  assert.equal(r.settings.mail.address, 'a@b.co')
  assert.equal(r.settings.mail.service, 'gmail')
  const again = loadSettings(dir, { homeDir: home })
  assert.equal(again.topic, 'X')
  assert.deepEqual(again.schedules, [sch])
})

test('патч schedules заменяет список целиком', () => {
  const dir = tmp()
  const a = { id: 'a', name: 'Казахстан', enabled: true, days: [1], time: '08:00', countries: ['KZ'] }
  const b = { id: 'b', name: 'Кавказ', enabled: false, days: [3], time: '21:30', countries: ['GE', 'AM'] }
  updateSettings(dir, { schedules: [a, b] }, { homeDir: home })
  const r = updateSettings(dir, { schedules: [b] }, { homeDir: home })
  assert.equal(r.ok, true)
  assert.deepEqual(loadSettings(dir, { homeDir: home }).schedules, [b])
})

test('невалидный патч ничего не меняет', () => {
  const dir = tmp()
  const r = updateSettings(dir, { schedules: [{ id: 'main', name: 'Основная', enabled: true, days: [1], time: '25:99', countries: [] }] }, { homeDir: home })
  assert.equal(r.ok, false)
  assert.ok(r.errors['schedules.0.time'])
  assert.equal(loadSettings(dir, { homeDir: home }).schedules[0]!.time, '08:00')
})

test('stageModels: слияние и удаление пустой строкой', () => {
  const dir = tmp()
  updateSettings(dir, { advanced: { stageModels: { triage: 'opus', news: 'haiku' } } }, { homeDir: home })
  const r = updateSettings(dir, { advanced: { stageModels: { news: '' } } }, { homeDir: home })
  assert.deepEqual(r.settings.advanced.stageModels, { triage: 'opus' })
})

test('миграция: старый файл без полей и версии (CFG-13)', () => {
  const dir = tmp()
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ topic: 'Старая', scheduleDays: [2], mail: { address: 'o@o.ru' }, junk: 1 }))
  const s = loadSettings(dir, { homeDir: home })
  assert.equal(s.topic, 'Старая')
  assert.deepEqual(s.schedules, [{ id: 'main', name: 'Основная проверка', enabled: true, days: [2], time: '08:00', countries: [] }])
  assert.equal(s.mail.address, 'o@o.ru')
  assert.equal(s.mail.port, 465)
  assert.equal(s.limitPercent, 80)
  assert.equal(s.advanced.firstRunDays, 30)
  assert.equal(s.schemaVersion, 4)
  assert.equal('junk' in s, false)
  assert.equal('scheduleDays' in s, false)
  assert.equal('junk' in JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')), false)
})

test('поля неверного типа заменяются значениями по умолчанию', () => {
  const dir = tmp()
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ limitPercent: 'много', scheduleDays: 'пн', mail: 5 }))
  const s = loadSettings(dir, { homeDir: home })
  assert.equal(s.limitPercent, 80)
  assert.deepEqual(s.schedules[0]!.days, [1])
  assert.equal(s.mail.service, 'gmail')
})

test('битый файл → .bak и defaults', () => {
  const dir = tmp()
  writeFileSync(join(dir, 'settings.json'), '{не json')
  const s = loadSettings(dir, { homeDir: home })
  assert.deepEqual(s, defaultSettings(home))
  assert.equal(readFileSync(join(dir, 'settings.json.bak'), 'utf8'), '{не json')
})

test('атомарность: tmp-файл не остаётся', () => {
  const dir = tmp()
  saveSettings(dir, defaultSettings(home))
  updateSettings(dir, { topic: 'Y' }, { homeDir: home })
  assert.deepEqual(readdirSync(dir), ['settings.json'])
})

test('миграция v1→v2: прежняя стандартная папка ~/Documents/RegWatch заменяется на ~/RegWatch', async () => {
  const { migrateSettings } = await import('./migrations.ts');
  const home = '/Users/test';
  const old = migrateSettings({ schemaVersion: 1, workspaceDir: '/Users/test/Documents/RegWatch' }, home);
  assert.equal(old.workspaceDir, '/Users/test/RegWatch');
  const custom = migrateSettings({ schemaVersion: 1, workspaceDir: '/Volumes/X/RW' }, home);
  assert.equal(custom.workspaceDir, '/Volumes/X/RW');
});

test('смена сервиса/адреса/сервера/порта/шифрования сбрасывает mail.verified (CFG-14)', () => {
  const dir = tmp()
  const verify = () => updateSettings(dir, { mail: { verified: true } }, { homeDir: home })
  updateSettings(dir, { mail: { address: 'a@b.co', service: 'other', server: 'mail.x.ru', port: 465, security: 'ssl' } }, { homeDir: home })
  const changes = [
    { address: 'c@d.co' },
    { service: 'yandex' as const },
    { server: 'mail.y.ru' },
    { port: 587 },
    { security: 'starttls' as const },
  ]
  for (const mail of changes) {
    assert.equal(verify().settings.mail.verified, true)
    const r = updateSettings(dir, { mail }, { homeDir: home })
    assert.equal(r.ok, true)
    assert.equal(r.settings.mail.verified, false, JSON.stringify(mail))
    assert.equal(loadSettings(dir, { homeDir: home }).mail.verified, false)
  }
})

test('mail.verified не сбрасывается без реальных изменений и при явном verified в патче', () => {
  const dir = tmp()
  updateSettings(dir, { mail: { address: 'a@b.co', verified: true } }, { homeDir: home })
  // то же значение, получатели, язык — проверка остаётся
  let r = updateSettings(dir, { mail: { address: 'a@b.co', recipients: ['x@y.co'] }, reportLanguage: 'en' }, { homeDir: home })
  assert.equal(r.settings.mail.verified, true)
  // явный verified в патче важнее
  r = updateSettings(dir, { mail: { address: 'n@b.co', verified: true } }, { homeDir: home })
  assert.equal(r.settings.mail.verified, true)
  assert.equal(r.settings.mail.address, 'n@b.co')
})
