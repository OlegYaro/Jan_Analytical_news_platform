// Чистая логика окна «Прогон»: значки, тексты причин, расход, пауза. Без React и DOM.
import type { ActRun, CountryRun, CountryStatus, RunMode, StageName, StageStatus, Usage } from '../../../shared/run-types.ts'
import { tr } from '../../strings-run.ts'
import type { RunEstimateDto } from '../../../shared/run-types.ts'

export const STAGE_ORDER: readonly StageName[] = ['collect', 'news', 'triage', 'screen', 'analyze', 'verify']

const ICONS: Record<StageStatus, string> = { pending: '⏳', running: '🔄', done: '✅', skipped: '—', failed: '❌' }

export function stageIcon(state: StageStatus): string {
  return ICONS[state] ?? '⏳'
}

export function stageStateLabel(state: StageStatus): string {
  return tr.stageStates[state] ?? state
}

/** Код сбоя → простые слова; неизвестное показываем как есть. */
export function failureReason(code: string): string {
  return (tr.reasons as Record<string, string>)[code] ?? code
}

/** Итоговый статус страны текстом. */
export function countryStatusText(status: CountryStatus): string {
  if (status.startsWith('failed:')) return tr.failedStatus(failureReason(status.slice('failed:'.length)))
  const m = tr.countryStatus as Record<string, string>
  return m[status] ?? status
}

export type CountryTone = 'ok' | 'changes' | 'bad' | 'idle'

export function countryTone(status: CountryStatus): CountryTone {
  if (status.startsWith('failed')) return 'bad'
  if (status === 'changes') return 'changes'
  if (status === 'no_changes') return 'ok'
  return 'idle'
}

/** «3 акта: готово 2, в работе 1» или '' если актов нет. */
export function actsSummary(acts: Record<string, ActRun>): string {
  const all = Object.values(acts)
  if (all.length === 0) return ''
  const n = { pending: 0, running: 0, done: 0, failed: 0 }
  for (const a of all) n[a.analyze] = (n[a.analyze] ?? 0) + 1
  const parts: string[] = []
  if (n.done) parts.push(`${tr.acts.done} ${n.done}`)
  if (n.running) parts.push(`${tr.acts.running} ${n.running}`)
  if (n.pending) parts.push(`${tr.acts.pending} ${n.pending}`)
  if (n.failed) parts.push(`${tr.acts.failed} ${n.failed}`)
  return `${tr.acts.count(all.length)}: ${parts.join(', ')}`
}

/** «Экран: существенных 6, для сведения 9, шум 20» или '' если экран не работал. */
export function screenSummary(screen: CountryRun['screen']): string {
  const all = Object.values(screen ?? {})
  if (all.length === 0) return ''
  const n = { material: 0, minor: 0, dropped: 0, no_text: 0, waiting: 0 }
  for (const s of all) {
    if (s.state !== 'done' || !s.final) n.waiting++
    else n[s.final]++
  }
  const parts = (['material', 'minor', 'dropped', 'no_text', 'waiting'] as const).filter((k) => n[k] > 0).map((k) => `${tr.screen[k]} ${n[k]}`)
  return `${tr.screenTitle}: ${parts.join(', ')}`
}

export function modeLabel(mode: RunMode): string {
  return tr.modes[mode] ?? mode
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** Время: «14:20», а если не сегодня — «18.11 14:20». Некорректная строка → «—». */
export function formatWhen(iso: string, now: Date): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return tr.dash
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const same = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  return same ? hm : `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${hm}`
}

export function pauseText(pausedUntil: string, now: Date): string {
  return tr.pause(formatWhen(pausedUntil, now))
}

/** 12 340 → «12,3 тыс.»; 2 500 000 → «2,5 млн»; меньше тысячи — как есть. */
export function formatAmount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0'
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace('.', tr.decimal)} ${tr.usage.thousand}`
  return `${(n / 1_000_000).toFixed(1).replace('.', tr.decimal)} ${tr.usage.million}`
}

export function formatCost(usd: number): string {
  return `≈ $${(Number.isFinite(usd) ? usd : 0).toFixed(2)}`
}

export function sumUsage(list: Usage[]): Usage {
  const t: Usage = { input: 0, output: 0, cache_read: 0, cache_write: 0, cost_usd: 0 }
  for (const u of list) {
    t.input += u.input ?? 0
    t.output += u.output ?? 0
    t.cache_read += u.cache_read ?? 0
    t.cache_write += u.cache_write ?? 0
    t.cost_usd += u.cost_usd ?? 0
  }
  return t
}

export function isUsageEmpty(u: Usage): boolean {
  return u.input === 0 && u.output === 0 && (u.cache_read ?? 0) === 0 && (u.cache_write ?? 0) === 0 && u.cost_usd === 0
}

/**
 * «объём обработки 15,5 тыс. (прочитано 12,3 тыс., из кэша 4,3 млн, записано в кэш 1,9 млн, написано 3,2 тыс.), стоимость ≈ $0.12».
 * Чтение и запись кэша тоже расход лимита, поэтому показываются отдельно (нулевые опускаются).
 */
export function formatUsage(u: Usage): string {
  const parts = [`${tr.usage.read} ${formatAmount(u.input)}`]
  if ((u.cache_read ?? 0) > 0) parts.push(`${tr.usage.cached} ${formatAmount(u.cache_read)}`)
  if ((u.cache_write ?? 0) > 0) parts.push(`${tr.usage.cacheWritten} ${formatAmount(u.cache_write)}`)
  parts.push(`${tr.usage.written} ${formatAmount(u.output)}`)
  return `${tr.usage.volume} ${formatAmount(u.input + u.output)} (${parts.join(', ')}), ${tr.usage.cost} ${formatCost(u.cost_usd)}`
}

/** Ошибка этапа для подсказки: показываем текст как есть (оркестратор пишет его по-русски). */
export function stageErrorTitle(c: CountryRun, stage: StageName): string {
  const s = c.stages[stage]
  return s?.state === 'failed' && s.error ? s.error : ''
}

/** Можно ли нажимать «Остановить»: только пока прогон идёт и остановка ещё не запрошена. */
export function canStop(running: boolean, stopping: boolean): boolean {
  return running && !stopping
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export function isIsoDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

/** Окно «с—по»: обе даты ISO, «с» не позже «по». */
export function validatePeriod(from: string, to: string): { from: string; to: string } | null {
  const f = from.trim()
  const t = to.trim()
  return isIsoDate(f) && isIsoDate(t) && f <= t ? { from: f, to: t } : null
}

/** «2–4» из диапазона [low, high]; целые, если верхняя граница ≥ 2, иначе один знак после запятой. Одинаковые края — одно число. */
export function formatRange(low: number, high: number, unit: { step: number; max?: number }): string {
  const safe = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0)
  let lo = safe(low)
  let hi = Math.max(safe(high), lo)
  if (unit.step >= 1) {
    lo = Math.floor(lo / unit.step) * unit.step
    hi = Math.ceil(hi / unit.step) * unit.step
    if (hi === 0) {
      hi = unit.step
      lo = hi
    }
    if (unit.max !== undefined) hi = Math.min(hi, unit.max)
    lo = Math.min(lo, hi)
    return lo === hi ? String(hi) : `${lo}–${hi}`
  }
  const f = (n: number): string => n.toFixed(1).replace('.', tr.decimal)
  lo = Math.floor(lo * 10) / 10
  hi = Math.ceil(hi * 10) / 10
  if (hi === 0) {
    hi = 0.1
    lo = hi
  }
  return lo === hi ? f(hi) : `${f(lo)}–${f(hi)}`
}

/** Доллары: целые при верхней границе ≥ 2 («$2–4»), иначе десятые («$0,3–0,8»). */
export function formatUsdRange(usd: [number, number]): string {
  return `$${formatRange(usd[0], usd[1], { step: Math.max(usd[1], 0) >= 2 ? 1 : 0.1 })}`
}

/** Доля лимита: шаг 5 п.п., «20–40 %»; верх не больше 100 (дальше — больше одного окна, это показывает отдельная подсказка). */
export function formatPercentRange(pct: [number, number]): string {
  return `${formatRange(pct[0], pct[1], { step: 5, max: 100 })} %`
}

/** Строка оценки перед запуском и пометки к ней. */
export function estimateText(e: RunEstimateDto): { line: string; rough: string; over: string } {
  return {
    line: tr.estimate.line(formatUsdRange(e.usd), formatPercentRange(e.limitPercent), e.countries, e.days, e.from, e.to),
    rough: e.basis === 'default' ? tr.estimate.rough : '',
    over: e.exceedsLimit ? tr.estimate.over : '',
  }
}
