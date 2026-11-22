// Контракты фазы 7 между сборкой письма/переводом (digest/, executors.translate) и отправкой (mail/outbox, finalize).
import type { Outcome } from '../../shared/pipeline-types.ts'
import type { Settings } from '../../shared/types.ts'

/** Язык одного письма. */
export type DigestLang = 'ru' | 'en'

/** Результат перевода коротких английских фрагментов письма (заголовки тем, строки изменений, причины). */
export interface TranslateResult {
  /** Исходный английский текст → русский. Нет ключа = перевод не прошёл проверку чисел/дат/номеров/URL (LNG-03) или не получен: в письме остаётся английский. */
  translations: Record<string, string>
  /** Фрагменты, перевод которых отвергнут кодом (для приложения и FINDINGS): английский текст и что разошлось. */
  rejected: Array<{ text: string; diffs: string[] }>
}

/** Перевод пакета фрагментов моделью `translate-ru` (дешёвая модель, без сети, один–два вызова на письмо). */
export type TranslateFn = (
  ctx: { workspaceDir: string; runDir: string; settings: Settings },
  texts: string[],
) => Promise<Outcome<TranslateResult>>
