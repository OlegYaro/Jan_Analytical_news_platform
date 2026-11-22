// Язык пользовательских сообщений главного процесса (окно «Прогон», трей, уведомления, ошибки валидации).
// Русский — по умолчанию и не меняется; английский выбирается по Settings.uiLanguage на момент формирования текста.
// Журнал log.jsonl и файлы архива для разбора остаются на русском.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { UiLanguage } from '../shared/types.ts'

/** Тип строк без литералов: русская и английская ветки одной формы совместимы. */
export type Widen<T> = T extends string
  ? string
  : T extends (...a: infer A) => infer R
    ? (...a: A) => Widen<R>
    : T extends readonly (infer U)[]
      ? Widen<U>[]
      : T extends object
        ? { [K in keyof T]: Widen<T[K]> }
        : T

/** Язык из настроек (нет настроек или значение не 'en' — русский). */
export function langOf(settings: { uiLanguage?: string } | null | undefined): UiLanguage {
  return settings?.uiLanguage === 'en' ? 'en' : 'ru'
}

/** Русский или английский вариант: `mt(lang, 'Привет', 'Hello')`. */
export function mt<T>(lang: UiLanguage | undefined, ru: T, en: Widen<T>): Widen<T> {
  return lang === 'en' ? en : (ru as unknown as Widen<T>)
}

/** Язык интерфейса по файлу settings.json в папке настроек, без побочных эффектов (нет файла/битый — русский). */
export function langFromDir(dir: string): UiLanguage {
  try {
    const raw = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as { uiLanguage?: string }
    return langOf(raw)
  } catch {
    return 'ru'
  }
}
