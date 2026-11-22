// Язык интерфейса (renderer). Строки живут в модулях strings-*.ts и shared/i18n.ts в двух вариантах (ru/en одинаковой формы);
// выбирает `pick` один раз при загрузке модуля. Язык хранится в localStorage (читается синхронно), главным остаётся
// Settings.uiLanguage: при расхождении окно приводит localStorage к настройке и перезагружается один раз (см. App.tsx).
import type { UiLanguage } from '../shared/types.ts'

export const LANG_KEY = 'rw-ui-lang'

/** Текущий язык интерфейса; без localStorage (тесты, ошибка доступа) — русский. */
export function currentLang(): UiLanguage {
  try {
    return globalThis.localStorage?.getItem(LANG_KEY) === 'en' ? 'en' : 'ru'
  } catch {
    return 'ru'
  }
}

export function setLangLocal(lang: UiLanguage): void {
  try {
    globalThis.localStorage?.setItem(LANG_KEY, lang)
  } catch {
    /* без хранилища язык применится после следующего чтения настроек */
  }
}

/** Тип строк без литералов: `as const`-русский объект и английский той же формы совместимы. */
export type Widen<T> = T extends string
  ? string
  : T extends (...a: infer A) => infer R
    ? (...a: A) => Widen<R>
    : T extends readonly (infer U)[]
      ? Widen<U>[]
      : T extends object
        ? { [K in keyof T]: Widen<T[K]> }
        : T

/** Русский или английский вариант набора строк (английский обязан иметь ту же форму, что русский). */
export function pick<T>(ru: T, en: Widen<T>, lang: UiLanguage = currentLang()): Widen<T> {
  return lang === 'en' ? en : (ru as unknown as Widen<T>)
}

/** Одна строка/функция: `L('Привет', 'Hello')`. Для разовых текстов вне словарей. */
export function L<T>(ru: T, en: Widen<T>): Widen<T> {
  return pick(ru, en)
}
