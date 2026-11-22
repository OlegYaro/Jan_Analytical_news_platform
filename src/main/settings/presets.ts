import type { MailSecurity, MailService, Preset, StageKey } from '../../shared/types.ts'

type Model = 'haiku' | 'sonnet' | 'opus'

/** Модели этапов по пресетам (docs/02 §6). Алиасы CLI, чтобы не устаревали. */
export const PRESET_MODELS: Record<Preset, Record<StageKey, Model>> = {
  economy: { news: 'haiku', triage: 'haiku', screen: 'haiku', confirm: 'sonnet', analyze: 'sonnet', verify: 'sonnet', translate: 'haiku', srcCheck: 'sonnet', srcDiscover: 'sonnet' },
  balanced: { news: 'sonnet', triage: 'sonnet', screen: 'sonnet', confirm: 'sonnet', analyze: 'opus', verify: 'opus', translate: 'sonnet', srcCheck: 'sonnet', srcDiscover: 'sonnet' },
  max: { news: 'opus', triage: 'opus', screen: 'sonnet', confirm: 'opus', analyze: 'opus', verify: 'opus', translate: 'sonnet', srcCheck: 'opus', srcDiscover: 'opus' },
}

/** Таймауты этапов в минутах (docs/02 §6). */
export const DEFAULT_TIMEOUTS_MIN: Record<StageKey, number> = {
  news: 5, triage: 5, screen: 5, confirm: 5, analyze: 10, verify: 10, translate: 5, srcCheck: 10, srcDiscover: 10,
}

export function modelForStage(preset: Preset, stage: StageKey, override?: Partial<Record<StageKey, string>>): string {
  const o = override?.[stage]
  const model = o !== undefined && o !== '' ? o : PRESET_MODELS[preset][stage]
  // Перепроверка сомнительного (SCR-02) не слабее sonnet: дешёвой моделью её делать нельзя, иначе смысла нет.
  return stage === 'confirm' && model === 'haiku' ? 'sonnet' : model
}

export function timeoutForStage(stage: StageKey, override?: Partial<Record<StageKey, number>>): number {
  return override?.[stage] ?? DEFAULT_TIMEOUTS_MIN[stage]
}

export interface MailServicePreset {
  id: MailService
  label: string
  server: string
  port: number
  security: MailSecurity
  /** Ссылка «как получить пароль приложения»; у «Другой» нет. */
  helpUrl: string
}

export const MAIL_SERVICES: readonly MailServicePreset[] = [
  { id: 'gmail', label: 'Gmail', server: 'smtp.gmail.com', port: 465, security: 'ssl', helpUrl: 'https://support.google.com/accounts/answer/185833' },
  { id: 'outlook', label: 'Outlook', server: 'smtp-mail.outlook.com', port: 587, security: 'starttls', helpUrl: 'https://support.microsoft.com/account-billing/5896ed9b-4263-e681-128a-a6f2979a7944' },
  { id: 'icloud', label: 'iCloud', server: 'smtp.mail.me.com', port: 587, security: 'starttls', helpUrl: 'https://support.apple.com/102654' },
  { id: 'yandex', label: 'Яндекс', server: 'smtp.yandex.ru', port: 465, security: 'ssl', helpUrl: 'https://yandex.ru/support/id/authorization/app-passwords.html' },
  { id: 'mailru', label: 'Mail.ru', server: 'smtp.mail.ru', port: 465, security: 'ssl', helpUrl: 'https://help.mail.ru/mail/security/protection/external' },
  { id: 'other', label: 'Другой', server: '', port: 465, security: 'ssl', helpUrl: '' },
]

export function mailServicePreset(id: MailService): MailServicePreset {
  return MAIL_SERVICES.find((s) => s.id === id) ?? MAIL_SERVICES[MAIL_SERVICES.length - 1]!
}
