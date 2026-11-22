import { pick, type Widen } from './i18n.ts'
import type { UiLanguage } from '../shared/types.ts'

/** Строки предупреждений Главной и блока «Расход последнего прогона». */
const ru = {
  failedSources: (n: number, names: string) => `Недоступные источники (❌): ${n}. Страны: ${names}. Они не участвуют в проверках.`,
  openCountries: 'Открыть «Страны»',
  failedCountries: (list: string) => `В последней проверке были сбои: ${list}.`,
  countryFail: (name: string, reason: string) => `${name} — ${reason}`,
  pausedUntil: (when: string) => `Проверка на паузе до ${when}: ждём восстановления лимита Claude.`,
  spend: {
    head: (mode: string, when: string, running: boolean) => `${mode}, ${when}${running ? ' (идёт сейчас)' : ''}`,
    total: 'Всего',
    country: 'Страна',
    empty: 'В этом прогоне пока ничего не потрачено.',
  },
  checkCountry: 'Проверить эту страну',
  checkCountryBusy: 'Запуск…',
  checkCountryHint: 'Проверит только эту страну, как «Проверить сейчас», и пришлёт письмо, если найдёт новое.',
  checkCountryOff: 'Страна выключена: включите её, чтобы проверить.',
  startFailed: 'Не удалось запустить проверку. Попробуйте ещё раз; если повторится, перезапустите RegWatch.',
}
const en: Widen<typeof ru> = {
  failedSources: (n: number, names: string) => `Unavailable sources (❌): ${n}. Countries: ${names}. They are not included in checks.`,
  openCountries: 'Open "Countries"',
  failedCountries: (list: string) => `The last check had failures: ${list}.`,
  countryFail: (name: string, reason: string) => `${name} — ${reason}`,
  pausedUntil: (when: string) => `The check is paused until ${when}: waiting for the Claude usage limit to recover.`,
  spend: {
    head: (mode: string, when: string, running: boolean) => `${mode}, ${when}${running ? ' (running now)' : ''}`,
    total: 'Total',
    country: 'Country',
    empty: 'Nothing has been spent in this run yet.',
  },
  checkCountry: 'Check this country',
  checkCountryBusy: 'Starting…',
  checkCountryHint: 'Checks only this country, like "Check now", and sends an email if something new is found.',
  checkCountryOff: 'The country is switched off: turn it on to check it.',
  startFailed: 'Could not start the check. Try again; if it happens again, restart RegWatch.',
}
export const th = pick(ru, en)
export const thFor = (lang: UiLanguage) => pick(ru, en, lang)
