// Проверка страницы кодом (SRC-03): открывается ли, куда перенаправляет, нужен ли вход/капча/JavaScript.
// Сохраняет страницу в файлы для модели (FINDINGS №3: WebFetch отдаёт обработанный текст, а не HTML, поэтому
// селекторы модель пишет по сырому HTML, который скачал код). Без electron.
import type { UiLanguage } from '../../shared/types.ts';
import { mt } from '../i18n.ts';
import { load } from 'cheerio';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FetchFailureKind, Fetcher } from '../collect/fetcher-types.ts';
import { htmlToText } from '../collect/snapshot.ts';

export interface PageProbe {
  /** Запрошенный адрес. */
  url: string;
  ok: boolean;
  status?: number;
  /** Итоговый адрес после перенаправлений. */
  finalUrl?: string;
  /** Перенаправил на другой сайт (не просто www/https). */
  otherSite: boolean;
  failKind?: FetchFailureKind;
  /** Причина по-русски (от fetcher). */
  failMessage?: string;
  contentType?: string;
  body?: string;
  /** Тип содержимого: страница, лента, данные. */
  format: 'html' | 'xml' | 'json' | 'other';
  /** Форма с паролем и почти пустая страница / адрес входа / 401. */
  loginRequired: boolean;
  /** Страница проверки «я не робот» вместо содержимого. */
  captcha: boolean;
  /** Видимого текста почти нет, а скриптов много: содержимое рисует JavaScript. */
  needsJs: boolean;
  /** На странице есть поле пароля (даже если страница содержательная). */
  passwordField: boolean;
  visibleTextLength: number;
  scriptCount: number;
}

/** Сайт по имени хоста: последние две метки; для зон вида gov.kz, com.ge, org.uz — три. */
export function siteOf(hostOrUrl: string): string {
  let h = hostOrUrl.trim().toLowerCase();
  try {
    if (h.includes('://')) h = new URL(h).hostname;
  } catch {
    return h;
  }
  h = h.replace(/\.$/, '').replace(/^www\./, '');
  const parts = h.split('.');
  if (parts.length <= 2) return h;
  const second = parts[parts.length - 2]!;
  const tld = parts[parts.length - 1]!;
  const generic = ['gov', 'com', 'org', 'net', 'edu', 'co', 'ac', 'int', 'mil'];
  if (tld.length === 2 && generic.includes(second)) return parts.slice(-3).join('.');
  return parts.slice(-2).join('.');
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function formatOf(contentType: string, body: string): PageProbe['format'] {
  const ct = contentType.toLowerCase();
  const head = body.slice(0, 500).trimStart().replace(/^﻿/, '');
  if (ct.includes('json') || /^[[{]/.test(head)) return 'json';
  if (ct.includes('xml') && !ct.includes('xhtml')) return 'xml';
  if (/^<\?xml/i.test(head) && /<(rss|feed|rdf:RDF)[\s>]/i.test(body.slice(0, 2000))) return 'xml';
  if (ct.includes('html') || /<html[\s>]/i.test(body.slice(0, 5000)) || /<body[\s>]/i.test(body)) return 'html';
  return 'other';
}

const LOGIN_PATH = /\/(?:login|log-in|signin|sign-in|auth|sso|account\/login|user\/login|kirish|vhod)(?:[/?#.]|$)/i;
const LOGIN_WORDS = /(войти|вход в систему|авторизац|sign in|log in|login|kirish|кириш)/i;
/** Текст страницы-заслонки «проверка браузера / я не робот». Подключённый скрипт reCAPTCHA (для форм) — не заслонка. */
const CAPTCHA_TEXT = /(Just a moment\.\.\.|Attention Required!|checking your browser|проверка браузера|ddos-guard|я не робот|i'?m not a robot|verify you are human|подтвердите, что вы не робот)/i;
const CAPTCHA_ELEMENTS = '.g-recaptcha, .h-captcha, .cf-turnstile, #challenge-form, #cf-challenge-running, [id^="cf-chl"], form[action*="captcha" i]';
const SPA_ROOT = '#root, #app, #__next, #__nuxt, app-root, [ng-app], [data-reactroot]';
const ENABLE_JS = /(enable javascript|javascript is (?:disabled|required)|requires javascript|включите javascript|need to enable javascript)/i;

/** Эвристики по телу страницы (без сети). */
export function analyzePage(
  body: string,
  finalUrl: string,
  contentType: string,
): Pick<PageProbe, 'format' | 'loginRequired' | 'captcha' | 'needsJs' | 'passwordField' | 'visibleTextLength' | 'scriptCount'> {
  const format = formatOf(contentType, body);
  if (format !== 'html') {
    return { format, loginRequired: false, captcha: false, needsJs: false, passwordField: false, visibleTextLength: body.length, scriptCount: 0 };
  }
  const $ = load(body);
  const scriptCount = $('script').length;
  const passwordField = $('input[type="password" i]').length > 0;
  const noscript = $('noscript').text();
  const title = $('title').first().text();
  const captchaElement = $(CAPTCHA_ELEMENTS).length > 0;
  const spaRoot = $(SPA_ROOT).length > 0;
  $('script, style, noscript, template, svg').remove();
  const visible = $('body').text().replace(/\s+/g, ' ').trim();
  const visibleTextLength = visible.length;
  let path = '';
  try {
    path = new URL(finalUrl).pathname + new URL(finalUrl).search;
  } catch {
    /* адрес не разобран — путь пустой */
  }
  const loginRequired =
    (passwordField && (visibleTextLength < 1500 || LOGIN_PATH.test(path))) ||
    (LOGIN_PATH.test(path) && visibleTextLength < 1500 && LOGIN_WORDS.test(visible));
  const captcha = visibleTextLength < 2000 && (CAPTCHA_TEXT.test(`${title} ${visible}`) || captchaElement);
  const needsJs =
    !captcha &&
    !loginRequired &&
    ((visibleTextLength < 300 && (scriptCount >= 3 || (scriptCount >= 1 && spaRoot))) || (ENABLE_JS.test(noscript + ' ' + visible) && visibleTextLength < 800));
  return { format, loginRequired, captcha, needsJs, passwordField, visibleTextLength, scriptCount };
}

/** Адрес перенаправления скриптом (`location.href = "…"`) или `<meta http-equiv="refresh">` на почти пустой странице. */
export function softRedirect(body: string, baseUrl: string): string | null {
  if (body.length > 20_000) return null;
  const $ = load(body);
  const visible = $('body').clone().find('script, style, noscript').remove().end().text().replace(/\s+/g, ' ').trim();
  if (visible.length > 200) return null;
  const meta = $('meta[http-equiv="refresh" i]').attr('content') ?? '';
  const m = /url\s*=\s*['"]?([^'";]+)/i.exec(meta);
  const js = /(?:window\.|document\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']|location\.replace\(\s*["']([^"']+)["']\s*\)/i.exec($('script').text());
  const target = m?.[1] ?? js?.[1] ?? js?.[2];
  if (!target) return null;
  try {
    const u = new URL(target.trim(), baseUrl);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/** Открывает адрес (один GET через общий fetcher с его повторами и паузой на домен) и разбирает страницу. */
export async function probePage(fetcher: Fetcher, url: string, timeoutMs = 45_000): Promise<PageProbe> {
  const r = await fetcher.get(url, { timeoutMs });
  if (!r.ok) {
    const loginRequired = r.kind === 'http' && r.status === 401;
    return {
      url,
      ok: false,
      ...(r.status !== undefined ? { status: r.status } : {}),
      otherSite: false,
      failKind: r.kind,
      failMessage: r.message,
      format: 'other',
      loginRequired,
      captcha: false,
      needsJs: false,
      passwordField: false,
      visibleTextLength: 0,
      scriptCount: 0,
    };
  }
  // Перенаправление скриптом или <meta refresh> на почти пустой странице: идём по нему один раз.
  const jump = softRedirect(r.body, r.url);
  if (jump && jump !== r.url) {
    const r2 = await fetcher.get(jump, { timeoutMs });
    if (r2.ok) {
      const a2 = analyzePage(r2.body, r2.url, r2.contentType);
      return { url, ok: true, status: r2.status, finalUrl: r2.url, otherSite: siteOf(r2.url) !== siteOf(url), contentType: r2.contentType, body: r2.body, ...a2 };
    }
  }
  const a = analyzePage(r.body, r.url, r.contentType);
  return {
    url,
    ok: true,
    status: r.status,
    finalUrl: r.url,
    otherSite: siteOf(r.url) !== siteOf(url),
    contentType: r.contentType,
    body: r.body,
    ...a,
  };
}

/**
 * HTML для чтения моделью: без script/style/svg/комментариев и встроенных стилей, каждая метка с новой строки
 * (инструмент Read обрезает слишком длинные строки, а сжатый HTML часто — одна строка). Структура и классы
 * не меняются, поэтому селекторы, подобранные по этому файлу, работают и на исходной странице.
 */
export function readableHtml(body: string): string {
  const $ = load(body);
  $('script, style, svg, link, meta, iframe, canvas, template').remove();
  $('*')
    .contents()
    .filter((_, n) => n.type === 'comment')
    .remove();
  $('*').each((_, el) => {
    const attribs = (el as unknown as { attribs?: Record<string, string> }).attribs ?? {};
    for (const name of Object.keys(attribs)) {
      if (name === 'style' || name.startsWith('on')) $(el).removeAttr(name);
      else if (attribs[name] && attribs[name]!.length > 300 && name !== 'href') $(el).attr(name, attribs[name]!.slice(0, 300) + '…');
    }
  });
  return $.html().replace(/>\s*</g, '>\n<');
}

export interface SavedPage {
  url: string;
  final_url: string;
  http_status: number | null;
  /** Файл страницы (HTML для чтения; для ленты/данных — как получено). */
  html_path: string;
  /** Видимый текст страницы. */
  text_path: string;
  /** Исходная страница как получена (для разбора сбоев). */
  raw_path: string;
}

/** Пишет страницу в `<dir>/<name>.html|.xml|.json` (+ .txt, + .raw.*). Возвращает пути (абсолютные, как dir). */
export function savePage(dir: string, name: string, p: { url: string; finalUrl?: string; status?: number; body: string; format: PageProbe['format'] }): SavedPage {
  mkdirSync(dir, { recursive: true });
  const ext = p.format === 'xml' ? 'xml' : p.format === 'json' ? 'json' : 'html';
  const htmlPath = join(dir, `${name}.${ext}`);
  const textPath = join(dir, `${name}.txt`);
  const rawPath = join(dir, `${name}.raw.${ext}`);
  writeFileSync(rawPath, p.body, 'utf8');
  if (p.format === 'html') {
    let readable: string;
    let text: string;
    try {
      readable = readableHtml(p.body);
      text = htmlToText(p.body);
    } catch {
      readable = p.body;
      text = p.body;
    }
    writeFileSync(htmlPath, readable, 'utf8');
    writeFileSync(textPath, text, 'utf8');
  } else {
    writeFileSync(htmlPath, p.body, 'utf8');
    writeFileSync(textPath, p.format === 'xml' ? p.body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ') : p.body, 'utf8');
  }
  return { url: p.url, final_url: p.finalUrl ?? p.url, http_status: p.status ?? null, html_path: htmlPath, text_path: textPath, raw_path: rawPath };
}

const lowerFirst = (s: string): string => (s ? s[0]!.toLowerCase() + s.slice(1) : s);

/** Сообщение загрузчика (русское) → английское, для интерфейса на английском. */
export function translateFetchMessage(msg: string, L: UiLanguage): string {
  if (L !== 'en') return msg;
  let m: RegExpExecArray | null;
  if (msg === 'Сайт слишком много раз перенаправляет запрос') return 'The site redirects the request too many times';
  if ((m = /^Страница слишком большая \(больше (\d+) МБ\)$/.exec(msg))) return `The page is too large (over ${m[1]} MB)`;
  if ((m = /^Сайт не отвечает за (\d+) секунд$/.exec(msg))) return `The site did not respond within ${m[1]} seconds`;
  if (msg === 'Некорректный адрес страницы') return 'Invalid page address';
  if (msg === 'Нет соединения с сайтом (проверьте интернет и адрес источника)') return 'No connection to the site (check your internet and the source address)';
  if ((m = /^Сайт вернул ошибку (\d+)(?: \((.*)\))?$/.exec(msg))) {
    const hint = m[2] === 'страница не найдена' ? ' (page not found)' : m[2] === 'слишком частые запросы' ? ' (too many requests)' : '';
    return `The site returned error ${m[1]}${hint}`;
  }
  return msg;
}

/** «Сайт не открывается: …» простыми словами (NFR-18). */
export function unreachableReason(p: PageProbe, L: UiLanguage = 'ru'): string {
  if (p.loginRequired && !p.ok) return loginReason(L);
  if (p.failKind === 'http' && p.status === 403) {
    return mt(
      L,
      'Сайт не открывается: доступ закрыт для автоматических запросов (ошибка 403). Возможно, сайт закрыт для этой сети',
      'The site does not open: access is closed to automated requests (error 403). The site may be closed to this network',
    );
  }
  const msg = translateFetchMessage((p.failMessage ?? mt(L, 'нет ответа', 'no response')).replace(/\s*\(проверьте интернет и адрес источника\)/, ''), L);
  return mt(L, `Сайт не открывается: ${lowerFirst(msg)}. Проверьте адрес источника`, `The site does not open: ${lowerFirst(msg)}. Check the source address`);
}

export const LOGIN_REASON = 'Сайт требует входа (логин и пароль) — приложение не может читать его без входа';
export const CAPTCHA_REASON = 'Сайт показывает проверку «я не робот» вместо содержимого — приложение не может его читать';
export const loginReason = (L: UiLanguage): string => mt(L, LOGIN_REASON, 'The site requires signing in (login and password) — the app cannot read it without signing in');
export const captchaReason = (L: UiLanguage): string =>
  mt(L, CAPTCHA_REASON, 'The site shows an "I am not a robot" check instead of the content — the app cannot read it');
