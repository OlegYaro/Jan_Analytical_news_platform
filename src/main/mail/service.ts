// Тестовое письмо и статус гейта почты (CFG-07, CFG-14). Без electron: пароль подаётся функцией из main.
import type { MailSettings, UiLanguage } from '../../shared/types.ts'
import { langOf, mt } from '../i18n.ts'
import { MAIL_IDENTITY_KEYS, loadSettings, saveSettings } from '../settings/store.ts'
import type { StoreOptions } from '../settings/store.ts'
import { sendMail, translateMailError } from './smtp.ts'
import type { SendMailDeps } from './smtp.ts'

export { evaluateGate as getGateStatus, guardRun, MAIL_GATE_MESSAGE } from '../mail-gate.ts'
export type { GateStatus, GuardResult, RunMode } from '../mail-gate.ts'

export const TEST_MAIL_SUBJECT = 'RegWatch: тестовое письмо'
export const TEST_MAIL_TEXT =
  'Если вы видите это письмо, почта настроена правильно.\n\n' +
  'RegWatch будет присылать отчёты об изменениях в регулировании на этот адрес — только когда найдёт что-то новое.\n'

export const TEST_MAIL_TEXT_EN =
  'If you can see this message, your mail is set up correctly.\n\n' +
  'RegWatch will send regulatory change reports to this address — only when it finds something new.\n'

export const NO_PASSWORD_MESSAGE = 'Сначала введите пароль приложения в поле «Пароль приложения» и сохраните его, затем отправьте тестовое письмо ещё раз.'

export interface TestMailResult {
  ok: boolean
  message: string
}

export interface TestMailOptions {
  settingsDir: string
  /** Пароль приложения из safeStorage; null/'' — не сохранён. */
  getPassword: () => string | null | Promise<string | null>
  deps?: SendMailDeps
  storeOptions?: StoreOptions
}

/** Получатели: из настроек, а если пусто — сам отправитель (docs/02 §11). */
export function testRecipients(mail: Pick<MailSettings, 'recipients' | 'address'>): string[] {
  const list = (mail.recipients ?? []).map((x) => x.trim()).filter((x) => x !== '')
  return list.length > 0 ? list : [mail.address.trim()].filter((x) => x !== '')
}

function sameIdentity(a: MailSettings, b: MailSettings): boolean {
  return MAIL_IDENTITY_KEYS.every((k) => a[k] === b[k])
}

/** Пишет mail.verified напрямую (без сброса в updateSettings). Перечитывает файл, чтобы не затереть чужие правки. */
function setVerified(settingsDir: string, value: boolean, storeOptions: StoreOptions, onlyIf?: (m: MailSettings) => boolean): boolean {
  const s = loadSettings(settingsDir, storeOptions)
  if (onlyIf && !onlyIf(s.mail)) return false
  if (s.mail.verified !== value) saveSettings(settingsDir, { ...s, mail: { ...s.mail, verified: value } })
  return true
}

async function readPassword(getPassword: TestMailOptions['getPassword'], L: UiLanguage = 'ru'): Promise<{ password: string } | { message: string }> {
  try {
    const p = await getPassword()
    return p ? { password: p } : { message: mt(L, NO_PASSWORD_MESSAGE, 'First enter the app password in the "App password" field and save it, then send the test e-mail again.') }
  } catch (err) {
    // secrets.ts бросает готовый русский текст (Связка ключей недоступна); прочее — общий текст.
    const own = err instanceof Error && (/[А-Яа-яЁё]/.test(err.message) || err.message.startsWith('The macOS secure storage'))
    const msg = own ? (err as Error).message : mt(L, 'Не удалось прочитать сохранённый пароль приложения. Введите его заново в Настройках → Почта.', 'Could not read the saved app password. Enter it again in Settings → Mail.')
    return { message: msg }
  }
}

/**
 * Отправляет тестовое письмо по сохранённым настройкам. Успех → mail.verified = true, ошибка → false.
 * Текст результата — по-русски, без служебных подробностей и без пароля.
 */
export async function sendTestMailFromSettings(opts: TestMailOptions): Promise<TestMailResult> {
  const storeOptions = opts.storeOptions ?? {}
  const settings = loadSettings(opts.settingsDir, storeOptions)
  const mail = settings.mail
  const L = langOf(settings)
  const fail = (message: string): TestMailResult => {
    setVerified(opts.settingsDir, false, storeOptions)
    return { ok: false, message }
  }

  if (mail.address.trim() === '') return fail(mt(L, 'Укажите ваш адрес электронной почты в поле «Ваш адрес» и сохраните настройки.', 'Enter your e-mail address in the "Your address" field and save the settings.'))
  const pw = await readPassword(opts.getPassword, L)
  if ('message' in pw) return fail(pw.message)
  const to = testRecipients(mail)

  try {
    await sendMail({ mail, password: pw.password, to, subject: mt(L, TEST_MAIL_SUBJECT, 'RegWatch: test e-mail'), text: L === 'en' ? TEST_MAIL_TEXT_EN : TEST_MAIL_TEXT }, opts.deps)
  } catch (err) {
    return fail(translateMailError(err, mail, L))
  }

  // Пока письмо уходило, настройки или пароль могли смениться — тогда проверка относится к старой конфигурации.
  const after = await readPassword(opts.getPassword, L)
  const stillSame = 'password' in after && after.password === pw.password
  const saved = stillSame && setVerified(opts.settingsDir, true, storeOptions, (m) => sameIdentity(m, mail))
  if (!saved) {
    return fail(
      mt(
        L,
        'Тестовое письмо ушло, но настройки почты или пароль изменились во время отправки. Отправьте тестовое письмо ещё раз.',
        'The test e-mail was sent, but the mail settings or password changed while sending. Send the test e-mail again.',
      ),
    )
  }
  return {
    ok: true,
    message: mt(
      L,
      `Тестовое письмо отправлено на ${to.join(', ')}. Проверьте почту (если письма нет во «Входящих», загляните в «Спам»). Почта настроена.`,
      `The test e-mail was sent to ${to.join(', ')}. Check your mail (if it is not in the inbox, look in Spam). Mail is set up.`,
    ),
  }
}

/** Вызывается из main при смене или удалении пароля приложения: прежняя проверка больше не действует. */
export function invalidateMailVerification(settingsDir: string, storeOptions: StoreOptions = {}): void {
  setVerified(settingsDir, false, storeOptions)
}

