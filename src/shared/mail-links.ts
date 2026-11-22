import type { MailService } from './types.ts'

/**
 * Ссылки «как получить пароль приложения» (docs/05 §6.3).
 * Дублируют helpUrl из src/main/settings/presets.ts: из main в renderer импортировать нельзя.
 * При правке меняйте оба места.
 */
export const MAIL_HELP_LINKS: Record<MailService, string> = {
  gmail: 'https://support.google.com/accounts/answer/185833',
  outlook: 'https://support.microsoft.com/account-billing/5896ed9b-4263-e681-128a-a6f2979a7944',
  icloud: 'https://support.apple.com/102654',
  yandex: 'https://yandex.ru/support/id/authorization/app-passwords.html',
  mailru: 'https://help.mail.ru/mail/security/protection/external',
  other: '',
}
