// Чистая логика мастера: без React и DOM.
import type { DoctorCheck } from '../../../shared/doctor-types.ts'

export const STEP_COUNT = 8

/** Проверки, без которых работать нельзя (docs/05 §2, шаг 1). */
export const REQUIRED_CHECKS: readonly DoctorCheck['id'][] = ['node', 'claude-found', 'claude-login', 'claude-flags']

export interface WizardCtx {
  /** null — проверка ещё не выполнена. */
  doctor: readonly DoctorCheck[] | null
  mailVerified: boolean
}

/** Все обязательные проверки есть в результате и пройдены. */
export function requiredChecksOk(checks: readonly DoctorCheck[] | null): boolean {
  if (!checks) return false
  return REQUIRED_CHECKS.every((id) => checks.some((c) => c.id === id && c.ok))
}

/** Можно ли нажать «Дальше» на шаге (нумерация с 1). */
export function canProceed(step: number, ctx: WizardCtx): boolean {
  if (step === 1) return requiredChecksOk(ctx.doctor)
  if (step === 3) return ctx.mailVerified === true
  return true
}
