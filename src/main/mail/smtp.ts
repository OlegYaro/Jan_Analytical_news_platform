// Отправка писем из приложения (DLV-05, CFG-07). Без electron: транспорт подаётся снаружи для тестов.
// Пароль приложения приходит параметром из main (safeStorage), здесь не хранится и в тексты ошибок не попадает.
import { createTransport } from 'nodemailer'
import type { MailSecurity, MailSettings, UiLanguage } from '../../shared/types.ts'
import { mt } from '../i18n.ts'
import { mailServicePreset } from '../settings/presets.ts'

/** Таймауты соединения, приветствия сервера и сокета, мс. */
export const MAIL_TIMEOUT_MS = 20_000

export interface SmtpEndpoint {
  host: string
  port: number
  security: MailSecurity
}

/** Ошибка, текст которой уже понятен пользователю (по-русски, с тем, что делать). */
export class MailUserError extends Error {
  /** Английский вариант того же текста (для интерфейса на английском). */
  en: string
  constructor(message: string, en?: string) {
    super(message)
    this.name = 'MailUserError'
    this.en = en ?? message
  }
}

type MailConfig = Pick<MailSettings, 'service' | 'server' | 'port' | 'security'>

/** Сервер, порт и шифрование: из пресета сервиса, для «Другой» — из настроек (docs/02 §11). */
export function resolveSmtp(mail: MailConfig): SmtpEndpoint {
  if (mail.service !== 'other') {
    const p = mailServicePreset(mail.service)
    return { host: p.server, port: p.port, security: p.security }
  }
  const host = (mail.server ?? '').trim()
  if (host === '') {
    throw new MailUserError('Не указан адрес почтового сервера. Для сервиса «Другой» заполните поле «Сервер» в Настройках → Почта, например mail.example.com.', `The mail server address is missing. For the "Other" service, fill in the "Server" field in Settings → Mail, for example mail.example.com.`)
  }
  if (!Number.isInteger(mail.port) || mail.port < 1 || mail.port > 65535) {
    throw new MailUserError('Не указан порт почтового сервера. Заполните поле «Порт» в Настройках → Почта (обычно 465 или 587).', `The mail server port is missing. Fill in the "Port" field in Settings → Mail (usually 465 or 587).`)
  }
  if (mail.security !== 'ssl' && mail.security !== 'starttls' && mail.security !== 'none') {
    throw new MailUserError('Не выбран способ шифрования. Выберите его в Настройках → Почта (обычно для порта 465 — SSL, для 587 — STARTTLS).', `No encryption method is selected. Choose one in Settings → Mail (usually SSL for port 465, STARTTLS for 587).`)
  }
  return { host, port: mail.port, security: mail.security }
}

export interface OutgoingMessage {
  from: { name: string; address: string }
  to: string[]
  subject: string
  text: string
  html?: string
}

export interface TransportOptions {
  host: string
  port: number
  secure: boolean
  requireTLS: boolean
  ignoreTLS: boolean
  auth: { user: string; pass: string }
  connectionTimeout: number
  greetingTimeout: number
  socketTimeout: number
}

/** Минимум транспорта, который нужен приложению (nodemailer или фейк в тестах). */
export interface MailTransport {
  sendMail(msg: OutgoingMessage): Promise<unknown>
  close?(): void
}

export interface SendMailDeps {
  createTransport?: (opts: TransportOptions) => MailTransport
}

export interface SendMailInput {
  mail: MailSettings
  password: string
  to: string[]
  subject: string
  text: string
  html?: string
}

function defaultCreateTransport(opts: TransportOptions): MailTransport {
  return createTransport(opts) as unknown as MailTransport
}

/** Пароль приложения Gmail показывается группами через пробел; сервис ждёт его без пробелов. */
function normalizePassword(service: MailSettings['service'], password: string): string {
  return service === 'gmail' ? password.replace(/\s+/g, '') : password.trim()
}

export function buildTransportOptions(mail: MailSettings, password: string): TransportOptions {
  const ep = resolveSmtp(mail)
  return {
    host: ep.host,
    port: ep.port,
    secure: ep.security === 'ssl',
    requireTLS: ep.security === 'starttls',
    ignoreTLS: ep.security === 'none',
    auth: { user: mail.address.trim(), pass: normalizePassword(mail.service, password) },
    connectionTimeout: MAIL_TIMEOUT_MS,
    greetingTimeout: MAIL_TIMEOUT_MS,
    socketTimeout: MAIL_TIMEOUT_MS,
  }
}

/** Отправляет письмо. Бросает исходную ошибку транспорта или MailUserError; текст для человека — translateMailError. */
export async function sendMail(input: SendMailInput, deps: SendMailDeps = {}): Promise<void> {
  const address = input.mail.address.trim()
  if (address === '') throw new MailUserError('Не указан ваш адрес электронной почты. Заполните поле «Ваш адрес» в Настройках → Почта.', `Your e-mail address is missing. Fill in the "Your address" field in Settings → Mail.`)
  if (input.password.trim() === '') throw new MailUserError('Сначала введите пароль приложения в Настройках → Почта.', `First enter the app password in Settings → Mail.`)
  const to = input.to.map((x) => x.trim()).filter((x) => x !== '')
  if (to.length === 0) throw new MailUserError('Не указано, кому отправлять письма. Заполните поле «Кому отправлять» в Настройках → Почта.', `No recipient is specified. Fill in the "Send to" field in Settings → Mail.`)

  const opts = buildTransportOptions(input.mail, input.password)
  const transport = (deps.createTransport ?? defaultCreateTransport)(opts)
  const msg: OutgoingMessage = { from: { name: 'RegWatch', address }, to, subject: input.subject, text: input.text }
  if (input.html !== undefined) msg.html = input.html
  try {
    await transport.sendMail(msg)
  } finally {
    try {
      transport.close?.()
    } catch {
      /* закрытие не влияет на результат */
    }
  }
}

interface ErrLike {
  code?: unknown
  responseCode?: unknown
  message?: unknown
  command?: unknown
}

function errFields(err: unknown): { code: string; responseCode: number; message: string; command: string } {
  const e = (typeof err === 'object' && err !== null ? err : {}) as ErrLike
  return {
    code: typeof e.code === 'string' ? e.code : '',
    responseCode: typeof e.responseCode === 'number' ? e.responseCode : 0,
    message: typeof e.message === 'string' ? e.message : typeof err === 'string' ? err : '',
    command: typeof e.command === 'string' ? e.command : '',
  }
}

export type MailErrorKind = 'user' | 'auth' | 'dns' | 'tls' | 'network' | 'recipient' | 'rejected' | 'unknown'

const NET_CODES = ['ECONNREFUSED', 'ETIMEDOUT', 'ESOCKET', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EPIPE']
const DNS_RE = /\b(ENOTFOUND|EAI_AGAIN|EAI_NONAME|EAI_FAIL)\b/
const TLS_RE = /wrong version number|certificate|self[- ]signed|handshake|ssl routines|\bSTARTTLS\b|\bTLS\b|unable to verify/i

/** Сортирует ошибку по виду: от этого зависят текст для пользователя и повтор (DLV-06). */
export function classifyMailError(err: unknown): MailErrorKind {
  if (err instanceof MailUserError) return 'user'
  const { code, responseCode, message, command } = errFields(err)
  if (code === 'EAUTH' || code === 'ENOAUTH' || responseCode === 535 || responseCode === 534 || responseCode === 530 || command === 'AUTH PLAIN' || command === 'AUTH LOGIN') {
    return 'auth'
  }
  if (code === 'EDNS' || code === 'ENOTFOUND' || code === 'EAI_AGAIN' || DNS_RE.test(message)) return 'dns'
  // ECONNECTION — сервер оборвал соединение сразу: обычно не тот порт или шифрование.
  if (code === 'ETLS' || code === 'EREQUIRETLS' || code === 'ECONNECTION' || TLS_RE.test(message)) return 'tls'
  if (NET_CODES.includes(code) || /\b(ECONNREFUSED|ETIMEDOUT|ECONNRESET|EHOSTUNREACH|ENETUNREACH)\b/.test(message)) {
    return 'network'
  }
  if (code === 'EENVELOPE' || command === 'RCPT TO' || command === 'MAIL FROM' || responseCode === 550 || responseCode === 553 || responseCode === 501) {
    return 'recipient'
  }
  if (code === 'EMESSAGE' || (responseCode >= 500 && responseCode < 600)) return 'rejected'
  if (responseCode >= 400 && responseCode < 500) return 'network'
  return 'unknown'
}

/** Стоит ли повторить отправку позже (нет сети, сервер временно недоступен). */
export function isRetryableMailError(err: unknown): boolean {
  const k = classifyMailError(err)
  return k === 'dns' || k === 'network' || k === 'unknown'
}

/**
 * Текст ошибки для человека: что случилось и что сделать (NFR-18).
 * Только заранее написанные фразы: исходный текст ошибки не показывается, поэтому пароль и служебные слова не утекают.
 */
export function translateMailError(err: unknown, mail: Pick<MailSettings, 'service'>, L: UiLanguage = 'ru'): string {
  const kind = classifyMailError(err)
  const other = mail.service === 'other'
  switch (kind) {
    case 'user':
      return mt(L, (err as MailUserError).message, (err as MailUserError).en)
    case 'auth': {
      const url = mailServicePreset(mail.service).helpUrl
      const how = url !== '' ? `пароль приложения: ${url} — создайте его по этой инструкции` : 'пароль приложения — как его создать, написано в справке вашего почтового сервиса. Создайте его'
      const howEn = url !== '' ? `an app password: ${url} — create it following these instructions` : 'an app password — how to create it is described in your mail service help. Create one'
      return mt(
        L,
        `Почтовый сервис не принял пароль. Нужен не обычный пароль, а ${how}, ` +
          'вставьте в поле «Пароль приложения», проверьте адрес и отправьте тестовое письмо ещё раз.',
        `The mail service did not accept the password. You need not your regular password but ${howEn}, ` +
          'paste it into the "App password" field, check the address and send the test e-mail again.',
      )
    }
    case 'dns':
      return other
        ? mt(L, 'Не удалось найти почтовый сервер. Проверьте подключение к интернету и адрес сервера в Настройках → Почта.', 'Could not find the mail server. Check your internet connection and the server address in Settings → Mail.')
        : mt(L, 'Не удалось связаться с почтовым сервисом: похоже, нет подключения к интернету. Проверьте интернет и попробуйте ещё раз.', 'Could not reach the mail service: there seems to be no internet connection. Check your internet and try again.')
    case 'tls':
      return other
        ? mt(L, 'Не удалось установить защищённое соединение с почтовым сервером. Проверьте порт и шифрование в Настройках → Почта: обычно порт 465 — SSL, порт 587 — STARTTLS.', 'Could not establish a secure connection to the mail server. Check the port and encryption in Settings → Mail: usually port 465 is SSL, port 587 is STARTTLS.')
        : mt(L, 'Не удалось установить защищённое соединение с почтовым сервисом. Проверьте подключение к интернету (иногда мешают VPN или антивирус) и попробуйте ещё раз.', 'Could not establish a secure connection to the mail service. Check your internet connection (a VPN or antivirus sometimes interferes) and try again.')
    case 'network':
      return other
        ? mt(L, 'Почтовый сервер не отвечает. Проверьте подключение к интернету, а также адрес сервера и порт в Настройках → Почта.', 'The mail server is not responding. Check your internet connection, as well as the server address and port in Settings → Mail.')
        : mt(L, 'Почтовый сервис не отвечает. Проверьте подключение к интернету и попробуйте ещё раз через несколько минут.', 'The mail service is not responding. Check your internet connection and try again in a few minutes.')
    case 'recipient':
      return mt(L, 'Почтовый сервис не принял адрес отправителя или получателя. Проверьте поля «Ваш адрес» и «Кому отправлять» в Настройках → Почта.', 'The mail service did not accept the sender or recipient address. Check the "Your address" and "Send to" fields in Settings → Mail.')
    case 'rejected':
      return mt(L, 'Почтовый сервис отказался отправить письмо. Проверьте адреса в Настройках → Почта и попробуйте ещё раз позже; если повторится — войдите в свой почтовый ящик через браузер и проверьте, нет ли там предупреждений.', 'The mail service refused to send the message. Check the addresses in Settings → Mail and try again later; if it repeats, sign in to your mailbox in a browser and check for warnings.')
    default:
      return mt(L, 'Письмо не отправилось из-за ошибки почтового сервиса. Проверьте настройки почты и подключение к интернету и попробуйте ещё раз через несколько минут.', 'The message was not sent because of a mail service error. Check the mail settings and your internet connection and try again in a few minutes.')
  }
}
