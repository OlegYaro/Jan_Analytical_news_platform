// Гейт «почта обязательна» (CFG-14, T-21). Чистая логика без electron.
import type { Settings } from '../shared/types.ts'
import { langOf, mt } from './i18n.ts'

export const MAIL_GATE_MESSAGE = 'Без настроенной почты регулярная проверка не запустится. Настройте почту в Настройках → Почта.'

export const MAIL_GATE_MESSAGE_EN = 'Without configured mail the regular check will not run. Set up mail in Settings → Mail.'
export const ONBOARDING_MAIL_MESSAGE_EN = 'The wizard cannot be finished without verified mail: send a test e-mail on the "Mail" step.'

export interface GateStatus {
  /** Можно ли запускать прогоны с письмом и расписание. */
  canRun: boolean
  /** Пробный прогон без письма разрешён всегда. */
  canDryRun: boolean
  /** Пусто, если запуск разрешён. */
  message: string
}

export type RunMode = 'scheduled' | 'manual' | 'dry_run' | 'backfill'

export interface GuardResult {
  allowed: boolean
  message: string
}

/** Запуск разрешён, только если почта проверена тестовым письмом, пароль приложения сохранён и адрес указан. */
export function evaluateGate(settings: Pick<Settings, 'mail'> & { uiLanguage?: string }, hasPassword: boolean): GateStatus {
  const m = settings.mail
  const canRun = m.verified === true && hasPassword && typeof m.address === 'string' && m.address.trim() !== ''
  return { canRun, canDryRun: true, message: canRun ? '' : mt(langOf(settings), MAIL_GATE_MESSAGE, MAIL_GATE_MESSAGE_EN) }
}

/** Проверка перед любым запуском: пробный прогон — всегда, остальные — только при настроенной почте. */
export function guardRun(mode: RunMode, gate: GateStatus): GuardResult {
  if (mode === 'dry_run') return { allowed: gate.canDryRun, message: '' }
  return gate.canRun ? { allowed: true, message: '' } : { allowed: false, message: gate.message || MAIL_GATE_MESSAGE }
}

export const ONBOARDING_MAIL_MESSAGE = 'Мастер нельзя завершить без проверенной почты: отправьте тестовое письмо на шаге «Почта».'

/** Завершить мастер первого запуска можно, только если почта проверена (CFG-14). */
export function canCompleteOnboarding(settings: Pick<Settings, 'mail'> & { uiLanguage?: string }, hasPassword: boolean): GuardResult {
  const gate = evaluateGate(settings, hasPassword)
  return gate.canRun ? { allowed: true, message: '' } : { allowed: false, message: mt(langOf(settings), ONBOARDING_MAIL_MESSAGE, ONBOARDING_MAIL_MESSAGE_EN) }
}
