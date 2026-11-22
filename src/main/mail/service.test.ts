import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSettings, updateSettings } from '../settings/store.ts'
import {
  MAIL_GATE_MESSAGE,
  NO_PASSWORD_MESSAGE,
  TEST_MAIL_SUBJECT,
  getGateStatus,
  invalidateMailVerification,
  sendTestMailFromSettings,
  testRecipients,
} from './service.ts'
import type { OutgoingMessage, TransportOptions } from './smtp.ts'

const home = '/home/u'
const storeOptions = { homeDir: home }

function setup(mail: Record<string, unknown> = { address: 'me@gmail.com' }): string {
  const dir = mkdtempSync(join(tmpdir(), 'rw-mail-'))
  const r = updateSettings(dir, { mail }, storeOptions)
  assert.equal(r.ok, true, JSON.stringify(r.errors))
  return dir
}

function fake(fail?: unknown, during?: () => void) {
  const sent: OutgoingMessage[] = []
  let opts: TransportOptions | undefined
  return {
    sent,
    get opts() {
      return opts
    },
    deps: {
      createTransport: (o: TransportOptions) => {
        opts = o
        return {
          async sendMail(m: OutgoingMessage) {
            sent.push(m)
            during?.()
            if (fail !== undefined) throw fail
            return {}
          },
        }
      },
    },
  }
}

test('успех: письмо самому себе, verified = true', async () => {
  const dir = setup()
  const t = fake()
  const r = await sendTestMailFromSettings({ settingsDir: dir, getPassword: () => 'app-pass', deps: t.deps, storeOptions })
  assert.equal(r.ok, true)
  assert.match(r.message, /me@gmail\.com/)
  assert.equal(t.sent.length, 1)
  assert.deepEqual(t.sent[0]!.to, ['me@gmail.com'])
  assert.deepEqual(t.sent[0]!.from, { name: 'RegWatch', address: 'me@gmail.com' })
  assert.equal(t.sent[0]!.subject, TEST_MAIL_SUBJECT)
  assert.equal(TEST_MAIL_SUBJECT, 'RegWatch: тестовое письмо')
  assert.match(t.sent[0]!.text, /Если вы видите это письмо, почта настроена правильно/)
  assert.equal(t.opts?.host, 'smtp.gmail.com')
  assert.equal(loadSettings(dir, storeOptions).mail.verified, true)
  // гейт открывается
  assert.equal(getGateStatus(loadSettings(dir, storeOptions), true).canRun, true)
})

test('получатели из настроек, если заданы', async () => {
  const dir = setup({ address: 'me@gmail.com', recipients: ['a@b.co', 'c@d.co'] })
  const t = fake()
  const r = await sendTestMailFromSettings({ settingsDir: dir, getPassword: async () => 'pw', deps: t.deps, storeOptions })
  assert.equal(r.ok, true)
  assert.deepEqual(t.sent[0]!.to, ['a@b.co', 'c@d.co'])
  assert.deepEqual(testRecipients({ recipients: [' ', ''], address: 'x@y.co' }), ['x@y.co'])
})

test('ошибка: verified снимается, текст переведён, пароля в тексте нет', async () => {
  const dir = setup()
  updateSettings(dir, { mail: { verified: true } }, storeOptions)
  const t = fake(Object.assign(new Error('Invalid login: 535 secret-pw'), { code: 'EAUTH', responseCode: 535 }))
  const r = await sendTestMailFromSettings({ settingsDir: dir, getPassword: () => 'secret-pw', deps: t.deps, storeOptions })
  assert.equal(r.ok, false)
  assert.match(r.message, /пароль приложения: https:\/\/support\.google\.com/)
  assert.ok(!r.message.includes('secret-pw'))
  assert.equal(loadSettings(dir, storeOptions).mail.verified, false)
  assert.equal(getGateStatus(loadSettings(dir, storeOptions), true).message, MAIL_GATE_MESSAGE)
})

test('нет пароля → «Сначала введите пароль приложения», письмо не отправляется', async () => {
  const dir = setup()
  updateSettings(dir, { mail: { verified: true } }, storeOptions)
  for (const getPassword of [() => null, () => '']) {
    const t = fake()
    const r = await sendTestMailFromSettings({ settingsDir: dir, getPassword, deps: t.deps, storeOptions })
    assert.equal(r.ok, false)
    assert.equal(r.message, NO_PASSWORD_MESSAGE)
    assert.match(r.message, /^Сначала введите пароль приложения/)
    assert.equal(t.sent.length, 0)
  }
  assert.equal(loadSettings(dir, storeOptions).mail.verified, false)
})

test('пароль не читается: русский текст из хранилища передаётся, остальное — общий текст', async () => {
  const dir = setup()
  const ru = await sendTestMailFromSettings({ settingsDir: dir, getPassword: () => { throw new Error('Связка ключей недоступна.') }, deps: fake().deps, storeOptions })
  assert.equal(ru.message, 'Связка ключей недоступна.')
  const en = await sendTestMailFromSettings({ settingsDir: dir, getPassword: () => { throw new Error('decrypt failed') }, deps: fake().deps, storeOptions })
  assert.match(en.message, /Введите его заново/)
})

test('пустой адрес → понятная ошибка без отправки', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rw-mail-'))
  const t = fake()
  const r = await sendTestMailFromSettings({ settingsDir: dir, getPassword: () => 'pw', deps: t.deps, storeOptions })
  assert.equal(r.ok, false)
  assert.match(r.message, /адрес/)
  assert.equal(t.sent.length, 0)
})

test('«Другой» без сервера → понятная ошибка', async () => {
  const dir = setup({ address: 'me@x.ru', service: 'other' })
  const r = await sendTestMailFromSettings({ settingsDir: dir, getPassword: () => 'pw', deps: fake().deps, storeOptions })
  assert.equal(r.ok, false)
  assert.match(r.message, /Сервер/)
})

test('настройки сменились во время отправки → verified не ставится', async () => {
  const dir = setup()
  const t = fake(undefined, () => updateSettings(dir, { mail: { address: 'other@gmail.com' } }, storeOptions))
  const r = await sendTestMailFromSettings({ settingsDir: dir, getPassword: () => 'pw', deps: t.deps, storeOptions })
  assert.equal(r.ok, false)
  assert.match(r.message, /ещё раз/)
  assert.equal(loadSettings(dir, storeOptions).mail.verified, false)
})

test('invalidateMailVerification снимает проверку (смена пароля)', () => {
  const dir = setup()
  updateSettings(dir, { mail: { verified: true } }, storeOptions)
  invalidateMailVerification(dir, storeOptions)
  const s = loadSettings(dir, storeOptions)
  assert.equal(s.mail.verified, false)
  assert.equal(s.mail.address, 'me@gmail.com')
  assert.equal(getGateStatus(s, true).canRun, false)
})
