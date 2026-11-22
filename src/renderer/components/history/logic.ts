// Чистая логика экрана «История»: подписи, проверка ссылки, группировка полей. Без React и DOM.
import type { HistoryFindingDto, HistoryRunDto, HistoryVerificationDto } from '../../../shared/history-types.ts'
import type { UiLanguage } from '../../../shared/types.ts'
import { hs } from '../../strings-history.ts'

/** Строка «найдено»: «6 существенных · 15 для сведения · 2 не проверено»; нули опускаются. */
export function foundLabel(found: HistoryRunDto['found'], lang: UiLanguage): string {
  const s = hs(lang)
  const parts: string[] = []
  if (found.material > 0) parts.push(s.foundMaterial(found.material))
  if (found.forInfo > 0) parts.push(s.foundInfo(found.forInfo))
  if (found.unverified > 0) parts.push(s.foundUnverified(found.unverified))
  return parts.length ? parts.join(' · ') : s.foundNone
}

export function mailLabel(mail: HistoryRunDto['mail'], lang: UiLanguage): string {
  const s = hs(lang)
  return mail ? (s.mail[mail.state] ?? mail.state) : s.mailUnknown
}

export type MailTone = 'ok' | 'idle' | 'warn' | 'bad'

export function mailTone(mail: HistoryRunDto['mail']): MailTone {
  if (!mail) return 'idle'
  if (mail.state === 'sent') return 'ok'
  if (mail.state === 'failed') return 'bad'
  if (mail.state === 'queued') return 'warn'
  return 'idle'
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** «18.11.2026 14:20»; некорректная строка → «—». */
export function formatDateTime(iso: string | undefined, lang: UiLanguage): string {
  const d = iso ? new Date(iso) : new Date(NaN)
  if (Number.isNaN(d.getTime())) return hs(lang).dash
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Метки «остановлен»/«пауза» для строки прогона. */
export function runFlags(run: Pick<HistoryRunDto, 'stopped' | 'paused'>, lang: UiLanguage): string[] {
  const s = hs(lang)
  const out: string[] = []
  if (run.stopped) out.push(s.stopped)
  if (run.paused) out.push(s.paused)
  return out
}

export function levelLabel(level: HistoryFindingDto['level'], lang: UiLanguage): string {
  return hs(lang).levels[level] ?? level
}

/** Причина простыми словами; неизвестный код показываем как есть. */
export function reasonLabel(code: string, lang: UiLanguage): string {
  return (hs(lang).reasons as Record<string, string>)[code] ?? code
}

export function discardedByLabel(by: string, lang: UiLanguage): string {
  return (hs(lang).by as Record<string, string>)[by] ?? by
}

/** «⚠ не подтверждено: поля a, b» для находки без подтверждения; у подтверждённой — ''. */
export function unconfirmedLabel(f: Pick<HistoryFindingDto, 'confirmed' | 'disputedFields'>, lang: UiLanguage): string {
  if (f.confirmed) return ''
  const s = hs(lang)
  return f.disputedFields.length ? s.unconfirmed(f.disputedFields.join(', ')) : s.unconfirmedNoFields
}

/** Ссылка на акт: только http(s) с хостом. */
export function isValidUrl(raw: string): boolean {
  const v = raw.trim()
  if (!/^https?:\/\//i.test(v)) return false
  try {
    const u = new URL(v)
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname.length > 0
  } catch {
    return false
  }
}

export interface CaseFormErrors {
  url?: string
  comment?: string
}

/** Проверка формы: для «пропущен акт» нужны ссылка и комментарий, для «ложного срабатывания» — комментарий. */
export function validateCaseForm(kind: 'false_positive' | 'missed', url: string, comment: string, lang: UiLanguage): CaseFormErrors {
  const s = hs(lang)
  const errors: CaseFormErrors = {}
  if (kind === 'missed' && !isValidUrl(url)) errors.url = s.urlInvalid
  if (comment.trim() === '') errors.comment = s.commentEmpty
  return errors
}

export type FieldStatus = 'ok' | 'mismatch' | 'unverifiable'
const FIELD_ORDER: readonly FieldStatus[] = ['mismatch', 'unverifiable', 'ok']

export interface FieldGroup {
  status: FieldStatus
  label: string
  fields: HistoryVerificationDto['fields']
}

/** Поля проверки по группам: сначала расхождения, затем не подтверждённые, затем совпавшие; пустые группы опускаются. */
export function groupFields(fields: HistoryVerificationDto['fields'], lang: UiLanguage): FieldGroup[] {
  const s = hs(lang)
  return FIELD_ORDER.map((status) => ({
    status,
    label: s.fieldGroups[status],
    fields: fields.filter((f) => f.status === status),
  })).filter((g) => g.fields.length > 0)
}

export function verdictLabel(verdict: string, lang: UiLanguage): string {
  return (hs(lang).verdicts as Record<string, string>)[verdict] ?? verdict
}
