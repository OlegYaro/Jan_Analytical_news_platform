// Чистая логика предупреждений Главной (docs/05 §3) и блока «Расход последнего прогона». Без React и DOM.
import type { RunState, RunStatusDto, Usage } from '../../../shared/run-types.ts'
import type { Country, UiLanguage } from '../../../shared/types.ts'
import { thFor } from '../../strings-home.ts'
import { trFor } from '../../strings-run.ts'
import { countryDisplayName } from '../../strings-countries.ts'
import { currentLang } from '../../i18n.ts'
import { sumUsage } from '../run/logic.ts'

export interface HomeWarning {
  kind: 'sources' | 'countries' | 'paused'
  text: string
  /** Есть ссылка «Открыть Страны». */
  linkToCountries: boolean
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function whenText(iso: string, now: Date): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const same = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  return same ? hm : `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${hm}`
}

function nameOf(code: string, countries: readonly Pick<Country, 'code' | 'name'>[], lang: UiLanguage): string {
  const c = countries.find((x) => x.code === code)
  if (!c) return code
  return lang === 'en' ? countryDisplayName(c.code, c.name, 'en') : c.name
}

/** Включённые страны, у которых есть источник в состоянии «не работает» (❌). */
export function countriesWithFailedSources(countries: readonly Country[]): Country[] {
  return countries.filter((c) => c.active && c.sources.some((s) => s.state === 'fail'))
}

/** Причина сбоя страны простыми словами из статуса `failed:<код>`. */
function failReason(status: string, lang: UiLanguage): string {
  const code = status.slice('failed:'.length)
  return (trFor(lang).reasons as Record<string, string>)[code] ?? code
}

/** Предупреждения Главной. Письмо «не отправлено» уже показывает панель прогона, здесь его нет. */
export function homeWarnings(
  countries: readonly Country[] | null,
  status: RunStatusDto | null,
  now: Date,
  lang: UiLanguage = currentLang(),
): HomeWarning[] {
  const th = thFor(lang)
  const out: HomeWarning[] = []
  if (status?.paused && status.pausedUntil && !status.running) {
    out.push({ kind: 'paused', text: th.pausedUntil(whenText(status.pausedUntil, now)), linkToCountries: false })
  }
  const bad = countries ? countriesWithFailedSources(countries) : []
  if (bad.length > 0) {
    const total = bad.reduce((n, c) => n + c.sources.filter((s) => s.state === 'fail').length, 0)
    out.push({ kind: 'sources', text: th.failedSources(total, bad.map((c) => nameOf(c.code, countries ?? [], lang)).join(', ')), linkToCountries: true })
  }
  const run = status?.run
  if (run && !status?.running) {
    const failed = Object.entries(run.countries).filter(([, c]) => c.status.startsWith('failed:'))
    if (failed.length > 0) {
      const list = failed.map(([code, c]) => th.countryFail(nameOf(code, countries ?? [], lang), failReason(c.status, lang))).join('; ')
      out.push({ kind: 'countries', text: th.failedCountries(list), linkToCountries: false })
    }
  }
  return out
}

export interface SpendRow {
  code: string
  name: string
  usage: Usage
}

export interface SpendSummary {
  mode: string
  when: string
  running: boolean
  total: Usage
  rows: SpendRow[]
}

/** Расход последнего (идущего или завершённого) прогона; null — прогонов не было. */
export function spendSummary(
  run: RunState | null,
  running: boolean,
  countries: readonly Pick<Country, 'code' | 'name'>[],
  now: Date,
  lang: UiLanguage = currentLang(),
): SpendSummary | null {
  if (!run) return null
  const rows = Object.entries(run.countries).map(([code, c]) => ({ code, name: nameOf(code, countries, lang), usage: c.usage }))
  return {
    mode: (trFor(lang).modes as Record<string, string>)[run.mode] ?? run.mode,
    when: whenText(run.started_at, now),
    running,
    total: sumUsage(rows.map((r) => r.usage)),
    rows,
  }
}
