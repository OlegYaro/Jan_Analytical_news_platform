import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { MailService, MailSettings } from '../../shared/types.ts'
import { MAIL_SERVICES } from '../settings/presets.ts'
import { MAIL_TIMEOUT_MS, MailUserError, classifyMailError, isRetryableMailError, resolveSmtp, sendMail, translateMailError } from './smtp.ts'
import type { OutgoingMessage, TransportOptions } from './smtp.ts'

const PASSWORD = 'abcd efgh ijkl mnop'

function mail(over: Partial<MailSettings> = {}): MailSettings {
  return { service: 'gmail', address: 'me@gmail.com', recipients: [], server: '', port: 465, security: 'ssl', verified: false, ...over }
}

function errWith(fields: Record<string, unknown>, message = 'boom'): Error {
  return Object.assign(new Error(message), fields)
}

function fakeTransport(fail?: unknown) {
  const calls: { opts: TransportOptions; msgs: OutgoingMessage[]; closed: boolean } = { opts: undefined as never, msgs: [], closed: false }
  const createTransport = (opts: TransportOptions) => {
    calls.opts = opts
    return {
      async sendMail(m: OutgoingMessage) {
        calls.msgs.push(m)
        if (fail !== undefined) throw fail
        return { messageId: '<1@x>' }
      },
      close() {
        calls.closed = true
      },
    }
  }
  return { calls, deps: { createTransport } }
}

test('пресеты сервисов (docs/02 §11)', () => {
  const expected: Record<Exclude<MailService, 'other'>, [string, number, string]> = {
    gmail: ['smtp.gmail.com', 465, 'ssl'],
    outlook: ['smtp-mail.outlook.com', 587, 'starttls'],
    icloud: ['smtp.mail.me.com', 587, 'starttls'],
    yandex: ['smtp.yandex.ru', 465, 'ssl'],
    mailru: ['smtp.mail.ru', 465, 'ssl'],
  }
  for (const [service, [host, port, security]] of Object.entries(expected)) {
    // сервер/порт из настроек для пресетов игнорируются
    const ep = resolveSmtp(mail({ service: service as MailService, server: 'evil.example', port: 25, security: 'none' }))
    assert.deepEqual(ep, { host, port, security }, service)
  }
})

test('«Другой»: берутся сервер/порт/шифрование из настроек', () => {
  assert.deepEqual(resolveSmtp(mail({ service: 'other', server: ' mail.x.ru ', port: 587, security: 'starttls' })), {
    host: 'mail.x.ru',
    port: 587,
    security: 'starttls',
  })
})

test('«Другой» без сервера или с неверным портом — понятная ошибка', () => {
  assert.throws(() => resolveSmtp(mail({ service: 'other', server: '  ' })), (e: unknown) => e instanceof MailUserError && /Сервер/.test(e.message))
  assert.throws(() => resolveSmtp(mail({ service: 'other', server: 'mail.x.ru', port: 0 })), (e: unknown) => e instanceof MailUserError && /Порт/.test(e.message))
  const e = (() => {
    try {
      resolveSmtp(mail({ service: 'other', server: '' }))
    } catch (err) {
      return err
    }
  })()
  assert.match(translateMailError(e, { service: 'other' }), /адрес почтового сервера/)
})

test('отправка: транспорт получает правильные параметры и письмо', async () => {
  const { calls, deps } = fakeTransport()
  await sendMail({ mail: mail(), password: PASSWORD, to: ['a@b.co', ' ', 'c@d.co '], subject: 'Тема', text: 'Текст', html: '<p>x</p>' }, deps)
  assert.equal(calls.opts.host, 'smtp.gmail.com')
  assert.equal(calls.opts.port, 465)
  assert.equal(calls.opts.secure, true)
  assert.equal(calls.opts.requireTLS, false)
  assert.deepEqual(calls.opts.auth, { user: 'me@gmail.com', pass: 'abcdefghijklmnop' }) // пробелы Gmail убраны
  assert.equal(calls.opts.connectionTimeout, MAIL_TIMEOUT_MS)
  assert.equal(calls.opts.greetingTimeout, MAIL_TIMEOUT_MS)
  assert.equal(calls.opts.socketTimeout, MAIL_TIMEOUT_MS)
  assert.equal(MAIL_TIMEOUT_MS, 20_000)
  assert.equal(calls.msgs.length, 1)
  assert.deepEqual(calls.msgs[0], { from: { name: 'RegWatch', address: 'me@gmail.com' }, to: ['a@b.co', 'c@d.co'], subject: 'Тема', text: 'Текст', html: '<p>x</p>' })
  assert.equal(calls.closed, true)
})

test('отправка: STARTTLS для Outlook/iCloud', async () => {
  const { calls, deps } = fakeTransport()
  await sendMail({ mail: mail({ service: 'icloud', address: 'me@icloud.com' }), password: 'pw', to: ['a@b.co'], subject: 's', text: 't' }, deps)
  assert.equal(calls.opts.secure, false)
  assert.equal(calls.opts.requireTLS, true)
  assert.equal(calls.opts.port, 587)
})

test('отправка: ошибка транспорта пробрасывается, транспорт закрывается', async () => {
  const boom = errWith({ code: 'EAUTH', responseCode: 535 })
  const { calls, deps } = fakeTransport(boom)
  await assert.rejects(sendMail({ mail: mail(), password: 'pw', to: ['a@b.co'], subject: 's', text: 't' }, deps), (e) => e === boom)
  assert.equal(calls.closed, true)
})

test('отправка: пустой адрес, пароль, получатели — понятная ошибка до соединения', async () => {
  const { calls, deps } = fakeTransport()
  const base = { password: 'pw', to: ['a@b.co'], subject: 's', text: 't' }
  for (const input of [
    { ...base, mail: mail({ address: ' ' }) },
    { ...base, mail: mail(), password: ' ' },
    { ...base, mail: mail(), to: [' '] },
  ]) {
    await assert.rejects(sendMail(input, deps), (e: unknown) => e instanceof MailUserError && /Настройках → Почта/.test(e.message))
  }
  assert.equal(calls.msgs.length, 0)
})

test('перевод: неверный пароль → пароль приложения со ссылкой выбранного сервиса', () => {
  const gmailUrl = MAIL_SERVICES.find((s) => s.id === 'gmail')!.helpUrl
  for (const e of [errWith({ code: 'EAUTH', responseCode: 535 }), errWith({ responseCode: 535 }), errWith({ code: 'EAUTH' })]) {
    const msg = translateMailError(e, { service: 'gmail' })
    assert.ok(msg.startsWith(`Почтовый сервис не принял пароль. Нужен не обычный пароль, а пароль приложения: ${gmailUrl} — `), msg)
    assert.ok(msg.includes(`Нужен не обычный пароль, а пароль приложения: ${gmailUrl}`), msg)
  }
  const ya = translateMailError(errWith({ code: 'EAUTH' }), { service: 'yandex' })
  assert.ok(ya.includes(MAIL_SERVICES.find((s) => s.id === 'yandex')!.helpUrl))
  const other = translateMailError(errWith({ code: 'EAUTH' }), { service: 'other' })
  assert.match(other, /справке вашего почтового сервиса/)
  assert.doesNotMatch(other, /https?:/)
})

test('перевод: сеть и сервер', () => {
  const dns = translateMailError(errWith({ code: 'EDNS' }, 'getaddrinfo ENOTFOUND smtp.gmail.com'), { service: 'gmail' })
  assert.match(dns, /интернет/)
  const dnsOther = translateMailError(errWith({ code: 'ESOCKET' }, 'getaddrinfo ENOTFOUND ssl.example.com'), { service: 'other' })
  assert.match(dnsOther, /адрес сервера/)
  assert.equal(classifyMailError(errWith({ code: 'ENOTFOUND' })), 'dns')

  for (const code of ['ETIMEDOUT', 'ECONNREFUSED', 'ESOCKET']) {
    const m = translateMailError(errWith({ code }), { service: 'gmail' })
    assert.match(m, /интернет/, code)
    const o = translateMailError(errWith({ code }), { service: 'other' })
    assert.match(o, /адрес сервера и порт/, code)
  }
  const refused = translateMailError(errWith({}, 'connect ECONNREFUSED 1.2.3.4:465'), { service: 'other' })
  assert.match(refused, /порт/)
})

test('перевод: шифрование и порт', () => {
  for (const e of [errWith({ code: 'ETLS' }), errWith({ code: 'ECONNECTION' }), errWith({ code: 'ESOCKET' }, 'ssl3_get_record:wrong version number')]) {
    assert.equal(classifyMailError(e), 'tls')
    assert.match(translateMailError(e, { service: 'other' }), /порт и шифрование/)
  }
})

test('перевод: получатель отклонён и неизвестная ошибка', () => {
  assert.match(translateMailError(errWith({ code: 'EENVELOPE', responseCode: 550 }), { service: 'gmail' }), /Кому отправлять/)
  const unknown = translateMailError(new Error('что-то странное'), { service: 'gmail' })
  assert.match(unknown, /^Письмо не отправилось/)
  assert.equal(translateMailError('строка', { service: 'gmail' }), unknown)
  assert.equal(translateMailError(undefined, { service: 'gmail' }), unknown)
})

test('сообщения без служебных слов, исходного текста ошибки и пароля (NFR-18)', () => {
  const secret = 'S3cr3tPa55'
  const errors: unknown[] = [
    errWith({ code: 'EAUTH', responseCode: 535, response: `535 5.7.8 Username and Password not accepted ${secret}` }, `Invalid login: 535 ${secret}`),
    errWith({ code: 'EDNS' }, `getaddrinfo ENOTFOUND ${secret}`),
    errWith({ code: 'ETIMEDOUT' }, `Connection timeout ${secret}`),
    errWith({ code: 'ECONNREFUSED' }, `connect ECONNREFUSED ${secret}`),
    errWith({ code: 'ETLS' }, `TLS ${secret}`),
    errWith({ code: 'EENVELOPE' }, `No recipients ${secret}`),
    errWith({ responseCode: 554 }, `554 spam ${secret}`),
    new Error(`{"json": "${secret}"} at Object.<anonymous> (/x.js:1:1)`),
  ]
  for (const service of ['gmail', 'outlook', 'icloud', 'yandex', 'mailru', 'other'] as MailService[]) {
    for (const e of errors) {
      const m = translateMailError(e, { service })
      assert.doesNotMatch(m, /SMTP|JSON|EAUTH|ENOTFOUND|ETIMEDOUT|ECONN|ESOCKET|EDNS|\bat\s|\{|\}/i, m)
      assert.ok(!m.includes(secret), m)
      assert.ok(/[А-Яа-я]/.test(m))
    }
  }
})

test('повтор отправки: сеть — да, пароль и настройки — нет (DLV-06)', () => {
  assert.equal(isRetryableMailError(errWith({ code: 'ETIMEDOUT' })), true)
  assert.equal(isRetryableMailError(errWith({ code: 'EDNS' }, 'getaddrinfo EAI_AGAIN smtp.gmail.com')), true)
  assert.equal(isRetryableMailError(errWith({ responseCode: 421 })), true)
  assert.equal(isRetryableMailError(errWith({ code: 'EAUTH' })), false)
  assert.equal(isRetryableMailError(new MailUserError('x')), false)
  assert.equal(isRetryableMailError(errWith({ code: 'EENVELOPE' })), false)
})
