// Перевод причин модели (английский, свободный текст) в простые русские фразы для окна (SRC-05, NFR-18).
// Словарь — по ключевым словам; неизвестная причина → общая фраза. Без терминов «JSON/CLI/селектор/парсер/токен».

import type { UiLanguage } from '../../shared/types.ts';

export type ReasonCode =
  | 'unreachable'
  | 'login'
  | 'captcha'
  | 'geo_blocked'
  | 'not_official'
  | 'type_mismatch'
  | 'no_listing'
  | 'no_dates'
  | 'needs_js'
  | 'pdf_only'
  | 'stale'
  | 'redirect'
  | 'profile_failed'
  | 'other_site'
  | 'reachable';

export const REASON_RU: Readonly<Record<ReasonCode, string>> = {
  unreachable: 'Сайт не открывается',
  login: 'Сайт требует входа (логин и пароль)',
  captcha: 'Сайт показывает проверку «я не робот»',
  geo_blocked: 'Сайт закрыт для доступа из этой сети или страны',
  not_official: 'Похоже, это не официальный сайт госоргана — решите сами, оставлять ли его',
  type_mismatch: 'Содержимое сайта не соответствует выбранному типу источника',
  no_listing: 'На сайте не найден список новых документов с датами',
  no_dates: 'В списке документов нет дат',
  needs_js: 'Список документов появляется только в браузере (с JavaScript) — приложение его не видит',
  pdf_only: 'Документы выложены только файлами (PDF, сканы) без списка с датами',
  stale: 'Список документов давно не обновлялся',
  redirect: 'Адрес перенаправляет на другой сайт',
  profile_failed: 'Приложению не удалось настроить чтение списка документов',
  other_site: 'Список документов найден на другом сайте',
  reachable: 'Сайт открывается',
};

export const REASON_EN: Readonly<Record<ReasonCode, string>> = {
  unreachable: 'The site does not open',
  login: 'The site requires signing in (login and password)',
  captcha: 'The site shows an "I am not a robot" check',
  geo_blocked: 'The site is closed to access from this network or country',
  not_official: 'This does not look like an official government site — decide yourself whether to keep it',
  type_mismatch: 'The site content does not match the selected source type',
  no_listing: 'No list of new documents with dates was found on the site',
  no_dates: 'The document list has no dates',
  needs_js: 'The document list appears only in a browser (with JavaScript) — the app cannot see it',
  pdf_only: 'Documents are published only as files (PDF, scans) without a list with dates',
  stale: 'The document list has not been updated for a long time',
  redirect: 'The address redirects to another site',
  profile_failed: 'The app could not set up reading of the document list',
  other_site: 'The document list was found on another site',
  reachable: 'The site opens',
};

export const GENERIC_REASON_EN = 'There is a remark about the source — open the site and check it manually';

export const GENERIC_REASON_RU = 'Есть замечание к источнику — откройте сайт и проверьте его вручную';

/** Порядок важен: более конкретные правила раньше общих. */
const RULES: Array<[RegExp, ReasonCode]> = [
  [/captcha|not a robot|bot (?:check|protection)|challenge page|cloudflare|ddos/i, 'captcha'],
  [/log ?in|sign ?in|authori[sz]|authentica|password|registration required|account required/i, 'login'],
  [/geo|region(?:al)? (?:block|restrict)|blocked|access denied|forbidden|\b403\b/i, 'geo_blocked'],
  [/not (?:an? )?official|unofficial|third[- ]party|private (?:site|company|portal)|commercial|aggregator|not (?:a )?government/i, 'not_official'],
  [/(?:type|content)[^.]{0,40}(?:mismatch|does not match|doesn'?t match|not match)|not (?:a |the )?(?:legal database|regulator|draft|news)|declared type/i, 'type_mismatch'],
  [/javascript|\bjs\b|dynamic(?:ally)?|client[- ]side|spa\b|single[- ]page|rendered/i, 'needs_js'],
  [/\bpdf\b|scan(?:ned)?|only files|attachments only/i, 'pdf_only'],
  [/no (?:dated )?(?:list|listing)|listing not found|could not find (?:a |the )?(?:list|listing|page)|no (?:new|recent) documents|no list of|no (?:rss|feed)/i, 'no_listing'],
  [/\bno dates?\b|without dates?|undated|dates? (?:are )?(?:missing|not shown|not visible)/i, 'no_dates'],
  [/outdated|stale|not updated|last update|old(?:est)? (?:news|documents)|no updates/i, 'stale'],
  [/redirect/i, 'redirect'],
  [/other (?:domain|site)|different (?:domain|site)/i, 'other_site'],
  [/unreachable|not reachable|timed? ?out|timeout|connection|refused|dns|does not (?:open|load|resolve)|cannot be (?:opened|reached|loaded)|failed to (?:load|fetch)|\b(?:404|500|502|503|504)\b|server error|not found|offline|down\b/i, 'unreachable'],
  [/selector|profile|pars(?:e|ing)|extract/i, 'profile_failed'],
  [/reachable|opens|accessible|loads fine|works/i, 'reachable'],
];

export function reasonCode(en: string): ReasonCode | null {
  for (const [re, code] of RULES) if (re.test(en)) return code;
  return null;
}

/** Одна причина модели → русская фраза. */
export function translateReason(en: string, L: UiLanguage = 'ru'): string {
  const code = reasonCode(en);
  if (L === 'en') return code ? REASON_EN[code] : GENERIC_REASON_EN;
  return code ? REASON_RU[code] : GENERIC_REASON_RU;
}

/**
 * Причины модели → русские фразы без повторов; «сайт открывается» и прочие нейтральные — убираются (`skip`).
 * Неизвестных причин много — одна общая фраза.
 */
export function translateReasons(list: readonly string[], skip: readonly ReasonCode[] = ['reachable'], L: UiLanguage = 'ru'): string[] {
  const out: string[] = [];
  for (const en of list) {
    if (!en.trim()) continue;
    const code = reasonCode(en);
    if (code && skip.includes(code)) continue;
    const ru = L === 'en' ? (code ? REASON_EN[code] : GENERIC_REASON_EN) : code ? REASON_RU[code] : GENERIC_REASON_RU;
    if (!out.includes(ru)) out.push(ru);
  }
  return out;
}

/** Слова, которых не должно быть в текстах для пользователя (docs/05: «без JSON, CLI, селектор, токен»). */
export const FORBIDDEN_UI_WORDS = /json|cli\b|селектор|парсер|токен|selector|parser|token|stack|undefined|null\b/i;
