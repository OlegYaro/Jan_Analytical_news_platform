// Адаптер lex.uz (COL-07): канал Б — новые акты из поиска /search/nat, канал А — редакции отслеживаемых актов, ONDATE.
// Без electron: работает только через интерфейс Fetcher. Поведение сайта и решения — docs/FINDINGS.md, «Фаза 4: lex.uz».
import { load } from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import type { Candidate, Channel } from '../../../shared/pipeline-types.ts';
import { ledgerKey } from '../../ledger.ts';
import type { FetchResult, Fetcher } from '../fetcher-types.ts';

export const LEXUZ_ORIGIN = 'https://lex.uz';
/** Строк на странице выдачи поиска (размер страницы на сайте не настраивается). */
export const LEXUZ_PAGE_SIZE = 20;
/** Таймаут запроса к lex.uz: первая страница поиска отвечала до 16 с. */
const SEARCH_TIMEOUT_MS = 60_000;

// ───────────────────────── Общие типы ─────────────────────────

/** Провал адаптера: `source` — сайт не ответил (COV-04), `parser` — страница не распознана или список обрезан (COV-05). */
export interface LexuzFail {
  ok: false;
  failure: 'source' | 'parser';
  /** Причина по-русски простыми словами. */
  reason: string;
  requests: number;
}

/** Состояние акта по отметке в строке выдачи (иконка `status_code_*`). */
export type LexuzActState = 'in_force' | 'repealed' | 'not_in_force';

/** Строка выдачи поиска — ровно то, что видно на странице. */
export interface LexuzRow {
  /** id из ссылки как есть: отрицательный — автоматическая транслитерация, положительный — оригинал. */
  rawId: string;
  /** Абсолютная ссылка из строки. */
  href: string;
  title: string;
  /** Текст бейджа «вид акта и орган, дата, номер» без изменений. */
  line: string;
  docType: string | null;
  issuer: string | null;
  adoptionDate: string | null;
  adoptionNumber: string | null;
  registrationNumber: string | null;
  registrationDate: string | null;
  state: LexuzActState | null;
}

export interface LexuzSearchPage {
  rows: LexuzRow[];
  /** «найдено N» (0 — «ничего не найдено»). */
  found: number;
  /** Цель постбэка «Следующий» или null на последней странице. */
  next: { target: string; argument: string } | null;
  /** Номер текущей страницы из блока постраничности (null — блока нет). */
  activePage: number | null;
  /** Форма ASP.NET для постбэка: адрес и все поля (включая __VIEWSTATE). */
  form: { action: string; fields: Record<string, string> } | null;
}

/** Найденный акт (канал Б). Всё только из строк выдачи: чего не видно — null. */
export interface LexuzDoc {
  /** id оригинала (положительный id lex.uz), строкой. */
  docId: string;
  /** Оригинальная версия: https://lex.uz/docs/<docId>. Если оригинал не сопоставлен — русская ссылка (см. originalKnown). */
  url: string;
  /** Русский перевод — ОТДЕЛЬНЫЙ документ со своим id: https://lex.uz/ru/docs/<ruId>; null — перевода нет в выдаче. */
  urlRu: string | null;
  /** Название по-русски, если есть перевод; иначе узбекское. */
  title: string;
  titleRu: string | null;
  /** Название на узбекском (латиница, как в выдаче O‘ZB). */
  titleUz: string | null;
  /** Вид акта (по-русски, если есть перевод), напр. «Постановление». */
  docType: string | null;
  /** Орган, как в строке (по-русски в родительном падеже: «Правления Центрального банка Республики Узбекистан»). */
  issuer: string | null;
  adoptionDate: string | null;
  /** Номер акта из узбекской строки (оригинал, напр. `PQ-397`); у актов с регистрацией в строке его нет. */
  adoptionNumber: string | null;
  /** Номер из русской строки (напр. `ПП-397`). */
  adoptionNumberRu: string | null;
  registrationNumber: string | null;
  registrationDate: string | null;
  /** Строки-бейджи из выдачи (ru | uz). */
  snippet: string;
  state: LexuzActState | null;
  /** Видимая дата (регистрации, а без неё — принятия) внутри окна; false — попал по запасу graceDays. */
  inWindow: boolean;
  /** false — нашёлся только русский перевод, оригинал в выдаче не сопоставлен. */
  originalKnown: boolean;
}

export interface LexuzSearchOptions {
  fetcher: Fetcher;
  /** Окно ISO `YYYY-MM-DD` (RUN-09). */
  window: { from: string; to: string };
  /** true — только акты с регистрацией Минюста (`regnummj=1`); false — только акты БЕЗ регистрации (законы, указы, постановления…). */
  regOnly: boolean;
  /** Фильтр по органу (`body_id`), как на сайте. */
  bodyId?: string;
  /** Фильтр по номеру акта (`actnum`, номер ПРИНЯТИЯ, напр. `24/2`), как в форме поиска сайта. Для проверки наводок. */
  actNum?: string;
  /**
   * Сайт ищет по дате ПРИНЯТИЯ, а в строке видна дата регистрации. Запрос уходит с from − lookbackDays.
   * По умолчанию: 60 дней для regOnly, иначе = graceDays.
   */
  lookbackDays?: number;
  /**
   * Запас назад для видимой даты: акт попадает на сайт через несколько дней после регистрации/подписания,
   * поэтому оставляем и видимые даты в [from − graceDays, from). По умолчанию 7.
   */
  graceDays?: number;
  /** Дополнительно пройти русскую выдачу (название и ссылка на перевод). По умолчанию true. */
  withRussian?: boolean;
  /** Предел страниц на один запрос (защита от бесконечного цикла). По умолчанию 150. */
  maxPages?: number;
  timeoutMs?: number;
}

export type LexuzSearchResult =
  | {
      ok: true;
      docs: LexuzDoc[];
      /** «найдено N» узбекской (основной) выдачи запроса; столько строк собрано и проверено. */
      found: number;
      /** «найдено N» русской выдачи (null — не запрашивалась или не удалась). */
      foundRu: number | null;
      /** Фактический запрос к сайту (с учётом lookbackDays). */
      query: { from: string; to: string };
      requests: number;
      /** Нефатальные замечания (русская выдача не прошла, нераспознанные строки и т. п.). */
      warnings: string[];
    }
  | LexuzFail;

// ───────────────────────── Даты и адреса ─────────────────────────

/** `DD.MM.YYYY` → `YYYY-MM-DD` (null, если не дата). */
export function ruDateToIso(d: string): string | null {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(d.trim());
  if (!m) return null;
  const iso = `${m[3]}-${m[2]}-${m[1]}`;
  return isIsoDate(iso) ? iso : null;
}

/** `YYYY-MM-DD` → `DD.MM.YYYY`. */
export function isoToRuDate(iso: string): string {
  if (!isIsoDate(iso)) throw new Error(`Неверная дата «${iso}», нужна ГГГГ-ММ-ДД`);
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(s + 'T00:00:00Z');
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
}

function addDays(iso: string, days: number): string {
  const t = Date.parse(iso + 'T00:00:00Z') + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** Сегодня по местному времени, ISO. */
function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Адрес документа без ONDATE/ONDATE2/action и якоря. */
/**
 * Адрес PDF документа lex.uz (`/pdffile/<id>`). Свежие акты там выложены только в PDF, а в HTML — один заголовок.
 * null — это не страница документа lex.uz.
 */
export function lexuzPdfUrl(docUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(docUrl);
  } catch {
    return null;
  }
  if (!/(^|\.)lex\.uz$/i.test(u.hostname)) return null;
  const m = /\/docs\/-?(\d+)/.exec(u.pathname);
  return m ? `${LEXUZ_ORIGIN}/pdffile/${m[1]}` : null;
}

export function baseDocUrl(docUrl: string): string {
  const u = new URL(docUrl);
  for (const k of ['ONDATE', 'ONDATE2', 'action']) u.searchParams.delete(k);
  u.hash = '';
  return u.toString();
}

/** Редакция на дату: `…/docs/<id>?ONDATE=DD.MM.YYYY`. */
export function ondateUrl(docUrl: string, isoDate: string): string {
  const u = new URL(baseDocUrl(docUrl));
  u.searchParams.set('ONDATE', isoToRuDate(isoDate));
  return u.toString();
}

/** Оригинал = положительный id: отрицательный id — транслитерация того же документа другой письменностью. */
function originalId(rawId: string): string {
  return rawId.replace(/^-/, '');
}

function docIdFromHref(href: string): string | null {
  return /\/docs\/(-?\d+)/.exec(href)?.[1] ?? null;
}

const clean = (s: string): string => s.replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

// ───────────────────────── Разбор выдачи поиска ─────────────────────────

/** Виды актов из фильтра поиска (для отделения вида от органа в русской строке); длинные — первыми. */
const RU_ACT_TYPES = [
  'Конституция Республики Каракалпакстан', 'Закон Республики Каракалпакстан', 'Межотраслевая инструкция',
  'Методические указания', 'Методическое пособие', 'Предельные нормы', 'Разъяснительное письмо',
  'Типовое положение', 'Типовой контракт', 'Типовой проспект эмиссии', 'Руководящий документ', 'Основные условия',
  'Порядок и условия', 'Изменения и дополнения', 'План счетов', 'Совместное постановление',
  'Конституция', 'Кодекс', 'Закон', 'Указ', 'Постановление', 'Распоряжение', 'Инструкция', 'Перечень', 'Письмо',
  'Положение', 'Порядок', 'Правила', 'Приказ', 'Регламент', 'Список', 'Ставки', 'Стандарт', 'Указания', 'Устав',
  'Решение', 'Концепция', 'Доктрина', 'Декларация', 'Программа', 'Протокол', 'Система', 'Разъяснение', 'Нормативы',
  'Требования', 'Критерии', 'Ограничения', 'Классификация', 'План', 'Сборник',
];

const APOS = `[ʻʼ‘’'\`]?`;

interface LineFields {
  docType: string | null;
  issuer: string | null;
  adoptionDate: string | null;
  adoptionNumber: string | null;
  registrationNumber: string | null;
  registrationDate: string | null;
}

function splitRuHead(head: string): { docType: string | null; issuer: string | null } {
  const h = clean(head);
  for (const t of RU_ACT_TYPES) {
    if (h === t) return { docType: t, issuer: null };
    if (h.startsWith(t + ' ')) return { docType: t, issuer: h.slice(t.length + 1).trim() || null };
  }
  const sp = h.indexOf(' ');
  return sp > 0 ? { docType: h.slice(0, sp), issuer: h.slice(sp + 1) } : { docType: h || null, issuer: null };
}

/** Узбекская строка: «<орган>ning qarori» — вид акта последним словом. */
function splitUzHead(head: string): { docType: string | null; issuer: string | null } {
  const h = clean(head);
  const sp = h.lastIndexOf(' ');
  return sp > 0 ? { docType: h.slice(sp + 1), issuer: h.slice(0, sp) } : { docType: h || null, issuer: null };
}

/** Разбор бейджа строки (ru, uz-латиница, uz-кириллица). Нераспознанное — null-поля. */
export function parseActLine(line: string): LineFields {
  const s = clean(line);
  const none: LineFields = {
    docType: null, issuer: null, adoptionDate: null, adoptionNumber: null, registrationNumber: null, registrationDate: null,
  };
  let m = /^(.*),\s*зарегистрировано\s+(\d{2}\.\d{2}\.\d{4})\s*г\.?,\s*рег\.\s*номер\s+(\S+)$/.exec(s);
  if (m) return { ...none, ...splitRuHead(m[1]!), registrationDate: ruDateToIso(m[2]!), registrationNumber: m[3]! };
  m = /^(.*),\s*от\s+(\d{2}\.\d{2}\.\d{4})\s*г\.?(?:\s*№\s*(\S+))?$/.exec(s);
  if (m) return { ...none, ...splitRuHead(m[1]!), adoptionDate: ruDateToIso(m[2]!), adoptionNumber: m[3] ?? null };
  m = new RegExp(`^(.*),\\s*(\\d{2}\\.\\d{2}\\.\\d{4})\\s*yilda\\s+ro${APOS}yxatdan\\s+o${APOS}tgan,\\s*ro${APOS}yxat\\s+raqami\\s+(\\S+)$`, 'i').exec(s);
  if (m) return { ...none, ...splitUzHead(m[1]!), registrationDate: ruDateToIso(m[2]!), registrationNumber: m[3]! };
  m = /^(.*),\s*(\d{2}\.\d{2}\.\d{4})\s*йилда\s+рўйхатдан\s+ўтган,\s*рўйхат\s+рақами\s+(\S+)$/.exec(s);
  if (m) return { ...none, ...splitUzHead(m[1]!), registrationDate: ruDateToIso(m[2]!), registrationNumber: m[3]! };
  m = /^(.*),\s*(\d{2}\.\d{2}\.\d{4})\s*(?:yildagi|йилдаги)(?:\s+(\S+?)-(?:son|сон))?$/i.exec(s);
  if (m) return { ...none, ...splitUzHead(m[1]!), adoptionDate: ruDateToIso(m[2]!), adoptionNumber: m[3] ?? null };
  return none;
}

function parseFound($: CheerioAPI): number | null {
  if ($('.refindHeader__notFound').length > 0) return 0;
  const t = clean($('.refind__result-export__title').first().text());
  const m = /(\d[\d\s]*)/.exec(t);
  return m ? Number(m[1]!.replace(/\s/g, '')) : null;
}

function parsePostBack(href: string | undefined): { target: string; argument: string } | null {
  const m = /__doPostBack\(\s*'([^']*)'\s*,\s*'([^']*)'\s*\)/.exec(href ?? '');
  return m ? { target: m[1]!, argument: m[2]! } : null;
}

/** Все поля формы ASP.NET, которые браузер отправил бы при постбэке. */
function formFields($: CheerioAPI, pageUrl: string): { action: string; fields: Record<string, string> } | null {
  let form = $('form#Form1');
  if (form.length === 0) form = $('form').filter((_, f) => $(f).find('input[name="__VIEWSTATE"]').length > 0).first();
  if (form.length === 0) return null;
  const fields: Record<string, string> = {};
  form.find('input[name], select[name], textarea[name]').each((_, el) => {
    const e = $(el);
    const name = e.attr('name')!;
    const type = (e.attr('type') ?? '').toLowerCase();
    if (['submit', 'button', 'image', 'file', 'reset'].includes(type)) return;
    if ((type === 'checkbox' || type === 'radio') && e.attr('checked') === undefined) return;
    if (el.tagName === 'select') {
      const opt = e.find('option[selected]').first();
      fields[name] = (opt.length ? opt : e.find('option').first()).attr('value') ?? '';
    } else if (el.tagName === 'textarea') {
      fields[name] = e.text();
    } else {
      fields[name] = e.attr('value') ?? (type === 'checkbox' || type === 'radio' ? 'on' : '');
    }
  });
  return { action: new URL(form.attr('action') ?? pageUrl, pageUrl).toString(), fields };
}

function rowState(cls: string | undefined): LexuzActState | null {
  if (!cls) return null;
  if (/status_code_y\b/.test(cls)) return 'in_force';
  if (/status_code_r\b/.test(cls)) return 'repealed';
  if (/status_code_n\b/.test(cls)) return 'not_in_force';
  return null;
}

/** Разбор одной страницы выдачи. Ошибка — строкой (страница не похожа на выдачу поиска). */
export function parseSearchPage(html: string, pageUrl: string): LexuzSearchPage | { error: string } {
  const $ = load(html);
  const found = parseFound($);
  if (found === null) return { error: 'на странице нет счётчика «найдено N» — вёрстка поиска lex.uz изменилась' };
  const rows: LexuzRow[] = [];
  let broken = 0;
  $('tr.dd-table__main-item').each((_, tr) => {
    const r = $(tr);
    const a = r.find('.dd-table__main-left-desc a[href]').first();
    const href = a.attr('href');
    const rawId = href ? docIdFromHref(href) : null;
    if (!href || !rawId) {
      broken++;
      return;
    }
    const line = clean(r.find('.dd-table__main-extra .badge').first().text());
    rows.push({
      rawId,
      href: new URL(href, pageUrl).toString(),
      title: clean(a.text()),
      line,
      ...parseActLine(line),
      state: rowState(r.find('.lx_act_state i').attr('class')),
    });
  });
  if (broken > 0) return { error: `в ${broken} строках выдачи нет ссылки на документ — вёрстка изменилась` };
  if (found > 0 && rows.length === 0) return { error: `сайт пишет «найдено ${found}», но строк в выдаче нет` };
  const next = parsePostBack($('.pgn .item_pgn4 a[href*="__doPostBack"]').first().attr('href'));
  const active = $('[id$="_rptPaging"] a.aspNetDisabled').first().text().trim();
  return {
    rows,
    found,
    next,
    activePage: /^\d+$/.test(active) ? Number(active) : null,
    form: formFields($, pageUrl),
  };
}

// ───────────────────────── Постраничный обход ─────────────────────────

interface WalkOk {
  ok: true;
  rows: LexuzRow[];
  found: number;
  pages: number;
}

function netFail(r: FetchResult & { ok: false }, what: string, requests: number): LexuzFail {
  return { ok: false, failure: 'source', reason: `lex.uz не ответил (${what}): ${r.message}`, requests, };
}

/**
 * Обходит ВСЕ страницы выдачи: первая — GET, дальше — POST формы с __VIEWSTATE и
 * `__EVENTTARGET` = цель кнопки «Следующий» (ucFoundActsControl$LinkButton1). GET-параметры страниц сайт не понимает.
 * Проверка: уникальных строк ровно «найдено N», иначе — `parser` «список обрезан».
 */
export async function walkSearch(
  fetcher: Fetcher,
  url: string,
  counter: { requests: number },
  opts: { maxPages?: number; timeoutMs?: number } = {},
): Promise<WalkOk | LexuzFail> {
  const timeoutMs = opts.timeoutMs ?? SEARCH_TIMEOUT_MS;
  const fail = (failure: 'source' | 'parser', reason: string): LexuzFail => ({ ok: false, failure, reason, requests: counter.requests });
  counter.requests++;
  let res = await fetcher.get(url, { timeoutMs });
  if (!res.ok) return netFail(res, 'поиск, страница 1', counter.requests);
  let page = parseSearchPage(res.body, res.url);
  if ('error' in page) return fail('parser', `Поиск lex.uz, страница 1: ${page.error}`);
  const found = page.found;
  const expectedPages = Math.ceil(found / LEXUZ_PAGE_SIZE);
  const maxPages = Math.min(opts.maxPages ?? 150, expectedPages + 2);
  if (expectedPages > (opts.maxPages ?? 150)) {
    return fail('parser', `Поиск lex.uz: найдено ${found} — больше ${opts.maxPages ?? 150} страниц, сузьте окно`);
  }
  const rows: LexuzRow[] = [...page.rows];
  const seen = new Set(page.rows.map((r) => r.rawId));
  let pages = 1;
  let prevActive = page.activePage;
  while (page.next) {
    if (pages >= maxPages) return fail('parser', `Поиск lex.uz: страниц больше ожидаемых ${expectedPages} — постраничный переход зациклился`);
    if (!page.form) return fail('parser', `Поиск lex.uz, страница ${pages}: нет формы для перехода на следующую страницу`);
    const fields = { ...page.form.fields, __EVENTTARGET: page.next.target, __EVENTARGUMENT: page.next.argument };
    counter.requests++;
    res = await fetcher.postForm(page.form.action, fields, { timeoutMs });
    if (!res.ok) return netFail(res, `поиск, страница ${pages + 1}`, counter.requests);
    const nextPage = parseSearchPage(res.body, res.url);
    if ('error' in nextPage) return fail('parser', `Поиск lex.uz, страница ${pages + 1}: ${nextPage.error}`);
    pages++;
    if (nextPage.found !== found) {
      return fail('parser', `Поиск lex.uz: во время обхода счётчик изменился (${found} → ${nextPage.found}) — выдача сдвинулась, повторите позже`);
    }
    if (prevActive !== null && nextPage.activePage !== null && nextPage.activePage <= prevActive) {
      return fail('parser', `Поиск lex.uz: переход на следующую страницу не сработал (снова страница ${nextPage.activePage})`);
    }
    let fresh = 0;
    for (const r of nextPage.rows) {
      if (seen.has(r.rawId)) continue;
      seen.add(r.rawId);
      rows.push(r);
      fresh++;
    }
    if (fresh === 0) return fail('parser', `Поиск lex.uz, страница ${pages}: только повторы — постраничный переход не сработал`);
    prevActive = nextPage.activePage;
    page = nextPage;
  }
  if (rows.length !== found) {
    return fail('parser', `Поиск lex.uz: список обрезан — собрано ${rows.length} из «найдено ${found}» (${pages} стр.)`);
  }
  return { ok: true, rows, found, pages };
}

// ───────────────────────── Канал Б: новые акты ─────────────────────────

function searchUrl(lang: 'ru' | 'uz', q: { from: string; to: string; regOnly: boolean; bodyId?: string; actNum?: string }): string {
  const u = new URL(lang === 'ru' ? '/ru/search/nat' : '/uz/search/nat', LEXUZ_ORIGIN);
  u.searchParams.set('lang', lang === 'ru' ? '1' : '4');
  u.searchParams.set('from', isoToRuDate(q.from));
  u.searchParams.set('to', isoToRuDate(q.to));
  if (q.regOnly) u.searchParams.set('regnummj', '1');
  if (q.bodyId) u.searchParams.set('body_id', q.bodyId);
  if (q.actNum?.trim()) u.searchParams.set('actnum', q.actNum.trim());
  return u.toString();
}

/** Ключ сопоставления строки uz ↔ ru: рег. номер + дата регистрации, иначе дата + цифры номера (ПП-397 ↔ PQ-397). */
function matchKey(r: LexuzRow): string | null {
  if (r.registrationNumber) return `reg:${r.registrationNumber}|${r.registrationDate ?? ''}`;
  if (!r.adoptionDate) return null;
  const n = r.adoptionNumber ?? '';
  const digits = (n.match(/\d+/g) ?? []).join('/');
  return `num:${r.adoptionDate}|${digits}|${/\p{L}/u.test(n) ? 'L' : '-'}`;
}

function groupBy(rows: LexuzRow[]): Map<string, LexuzRow[]> {
  const m = new Map<string, LexuzRow[]>();
  for (const r of rows) {
    const k = matchKey(r);
    if (!k) continue;
    const list = m.get(k);
    if (list) list.push(r);
    else m.set(k, [r]);
  }
  return m;
}

/** Склейка узбекской (основной) и русской выдачи в LexuzDoc. */
export function mergeRows(uzRows: LexuzRow[], ruRows: LexuzRow[]): { docs: Omit<LexuzDoc, 'inWindow'>[]; ambiguous: number } {
  const ruByKey = groupBy(ruRows);
  const uzByKey = groupBy(uzRows);
  const usedRu = new Set<LexuzRow>();
  let ambiguous = 0;
  const docs: Omit<LexuzDoc, 'inWindow'>[] = [];
  for (const uz of uzRows) {
    const k = matchKey(uz);
    const cands = k ? (ruByKey.get(k) ?? []) : [];
    let ru: LexuzRow | null = null;
    if (k && cands.length === 1 && (uzByKey.get(k)?.length ?? 0) === 1) ru = cands[0]!;
    else if (cands.length > 1) ambiguous++;
    if (ru) usedRu.add(ru);
    const docId = originalId(uz.rawId);
    docs.push({
      docId,
      url: `${LEXUZ_ORIGIN}/docs/${docId}`,
      urlRu: ru ? `${LEXUZ_ORIGIN}/ru/docs/${ru.rawId}` : null,
      title: ru?.title ?? uz.title,
      titleRu: ru?.title ?? null,
      titleUz: uz.title,
      docType: ru?.docType ?? uz.docType,
      issuer: ru?.issuer ?? uz.issuer,
      adoptionDate: uz.adoptionDate ?? ru?.adoptionDate ?? null,
      adoptionNumber: uz.adoptionNumber,
      adoptionNumberRu: ru?.adoptionNumber ?? null,
      registrationNumber: uz.registrationNumber ?? ru?.registrationNumber ?? null,
      registrationDate: uz.registrationDate ?? ru?.registrationDate ?? null,
      snippet: [ru?.line, uz.line].filter(Boolean).join(' | '),
      state: uz.state ?? ru?.state ?? null,
      originalKnown: true,
    });
  }
  // Русские строки без пары: оригинал не сопоставлен — не теряем акт, ссылка на перевод.
  for (const ru of ruRows) {
    if (usedRu.has(ru)) continue;
    docs.push({
      docId: `ru${ru.rawId}`,
      url: `${LEXUZ_ORIGIN}/ru/docs/${ru.rawId}`,
      urlRu: `${LEXUZ_ORIGIN}/ru/docs/${ru.rawId}`,
      title: ru.title,
      titleRu: ru.title,
      titleUz: null,
      docType: ru.docType,
      issuer: ru.issuer,
      adoptionDate: ru.adoptionDate,
      adoptionNumber: null,
      adoptionNumberRu: ru.adoptionNumber,
      registrationNumber: ru.registrationNumber,
      registrationDate: ru.registrationDate,
      snippet: ru.line,
      state: ru.state,
      originalKnown: false,
    });
  }
  return { docs, ambiguous };
}

/** Дедупликация по docId (первая запись сохраняется). Для склейки результатов regOnly:true и regOnly:false. */
export function dedupeDocs(docs: LexuzDoc[]): LexuzDoc[] {
  const seen = new Set<string>();
  return docs.filter((d) => (seen.has(d.docId) ? false : (seen.add(d.docId), true)));
}

/**
 * Канал Б: новые акты lex.uz за окно. Поиск идёт по узбекской выдаче (O‘ZB, lang=4 — все акты; русских переводов
 * меньше) и, если withRussian, по русской (lang=1) — для русского названия и ссылки на перевод.
 * Обе выдачи обходятся полностью и сверяются с «найдено N». Отбор по видимой дате: регистрации (regOnly) или
 * принятия — в [from − graceDays, to]. Вызывать дважды (regOnly true и false) и склеивать dedupeDocs.
 */
export async function lexuzSearchNew(opts: LexuzSearchOptions): Promise<LexuzSearchResult> {
  const { fetcher, window, regOnly } = opts;
  const counter = { requests: 0 };
  if (!isIsoDate(window.from) || !isIsoDate(window.to) || window.from > window.to) {
    return { ok: false, failure: 'parser', reason: `Неверное окно поиска ${window.from}…${window.to}`, requests: 0 };
  }
  const grace = opts.graceDays ?? 7;
  const lookback = Math.max(opts.lookbackDays ?? (regOnly ? 60 : grace), grace);
  const query = { from: addDays(window.from, -lookback), to: window.to };
  const q = { ...query, regOnly, bodyId: opts.bodyId, actNum: opts.actNum };
  const walkOpts = { maxPages: opts.maxPages, timeoutMs: opts.timeoutMs };
  const warnings: string[] = [];

  const uz = await walkSearch(fetcher, searchUrl('uz', q), counter, walkOpts);
  if (!uz.ok) return uz;
  let ruRows: LexuzRow[] = [];
  let foundRu: number | null = null;
  if (opts.withRussian !== false) {
    const ru = await walkSearch(fetcher, searchUrl('ru', q), counter, walkOpts);
    if (ru.ok) {
      ruRows = ru.rows;
      foundRu = ru.found;
    } else {
      warnings.push(`Русская выдача lex.uz не получена (${ru.reason}); названия только на узбекском`);
    }
  }
  const unparsed = uz.rows.filter((r) => !r.registrationNumber && !r.adoptionDate).length;
  if (unparsed > 0) warnings.push(`${unparsed} строк выдачи без распознанной даты — оставлены как есть`);

  const merged = mergeRows(uz.rows, ruRows);
  if (merged.ambiguous > 0) warnings.push(`${merged.ambiguous} строк не сопоставлены с русскими из-за неоднозначности`);
  const unmatchedRu = merged.docs.filter((d) => !d.originalKnown).length;
  if (unmatchedRu > 0) warnings.push(`${unmatchedRu} русских строк без пары в узбекской выдаче — ссылка на перевод`);

  const lo = addDays(window.from, -grace);
  const docs: LexuzDoc[] = [];
  for (const d of merged.docs) {
    const isReg = !!d.registrationNumber;
    if (isReg !== regOnly) continue; // regOnly:false — только акты без регистрации; с регистрацией их даёт regOnly:true
    const visible = isReg ? d.registrationDate : d.adoptionDate;
    if (visible && (visible < lo || visible > window.to)) continue;
    docs.push({ ...d, inWindow: visible === null || visible >= window.from });
  }
  return { ok: true, docs: dedupeDocs(docs), found: uz.found, foundRu, query, requests: counter.requests, warnings };
}

/** LexuzDoc → Candidate (канал Б, либо A для изменяющего акта). Ключ — по TRI-04 через ledgerKey. */
export function toCandidate(doc: LexuzDoc, channel: Channel, _country = 'UZ'): Candidate {
  return {
    id: `lexuz-${doc.docId}`,
    key: ledgerKey({
      registrationNumber: doc.registrationNumber ?? undefined,
      number: doc.adoptionNumber ?? doc.adoptionNumberRu ?? undefined,
      date: doc.adoptionDate ?? undefined,
      url: doc.url,
    }),
    title_original: doc.titleUz ?? doc.title,
    issuer: doc.issuer ?? '',
    date: doc.registrationDate ?? doc.adoptionDate ?? '',
    doc_type: doc.docType ?? '',
    url: doc.url,
    snippet: [doc.titleRu && doc.titleUz ? `RU: ${doc.titleRu}` : '', doc.snippet, doc.urlRu ? `RU: ${doc.urlRu}` : '']
      .filter(Boolean)
      .join(' | '),
    channel,
  };
}

// ───────────────────────── Канал А: редакции документа ─────────────────────────

/** Изменяющий акт из примечаний «… tahririda» в тексте редакции. */
export interface LexuzAmendment {
  docId: string;
  /** Оригинал: https://lex.uz/docs/<docId>. */
  url: string;
  registrationNumber: string | null;
  registrationDate: string | null;
  adoptionNumber: string | null;
  adoptionDate: string | null;
  /** «Kuchga kirish sanasi — …», если указано в примечании. */
  effectiveDate: string | null;
  /** Текст примечания (до 500 символов). */
  note: string;
}

export type LexuzEditionStatus = 'past' | 'current' | 'future';

export interface LexuzEdition {
  /** Дата редакции (вступления изменений в силу), ISO. */
  date: string;
  /** Редакция на дату: …?ONDATE=DD.MM.YYYY. */
  url: string;
  label: string;
  /** current — действует на `today`; future — вступит в силу позже (дата > today). */
  status: LexuzEditionStatus;
  /** Изменяющие акты этой редакции (пусто — примечаний на просмотренной странице нет). */
  amendingActs: LexuzAmendment[];
}

export interface LexuzPublication {
  date: string | null;
  /** Номер публикации в Национальной базе, напр. `10/26/3254-2/1020`. */
  ref: string;
  /** Рег. номер акта внутри номера публикации (`3254-2`), если формат узнаваем. */
  registrationNumber: string | null;
}

export interface LexuzDocInfo {
  /** Адрес без ONDATE. */
  url: string;
  title: string;
  /** Номер из заголовка страницы («3254-сон 30.06.2020»): у актов с регистрацией — рег. номер. */
  headerNumber: string | null;
  headerDate: string | null;
  /** Редакция, показанная сайтом по умолчанию (`lx_date_selected`). */
  shownEdition: string | null;
  /** Все редакции из списка «Вариантлар», по возрастанию даты. */
  editions: LexuzEdition[];
  publications: LexuzPublication[];
  /** Ссылки на версии на других языках/письменностях (переключатель на странице). */
  languages: { ru: string | null; uzCyrl: string | null; uzLatn: string | null };
}

export type LexuzEditionsResult = ({ ok: true; requests: number } & LexuzDocInfo) | LexuzFail;

const UZ_LAT_MONTHS = ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr'];
const UZ_CYR_MONTHS = ['январ', 'феврал', 'март', 'апрел', 'май', 'июн', 'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр'];
const RU_MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

function iso(y: string, mIdx: number, d: string): string | null {
  const s = `${y}-${String(mIdx + 1).padStart(2, '0')}-${d.padStart(2, '0')}`;
  return mIdx >= 0 && isIsoDate(s) ? s : null;
}

/** «2026-yil 17-sentabr…», «2026-йил 17-сентябр…», «17 сентября 2026 г…» → ISO. */
function wordDate(text: string): string | null {
  let m = /(\d{4})-yil\s+(\d{1,2})-([a-zʻ‘']+)/i.exec(text);
  if (m) return iso(m[1]!, UZ_LAT_MONTHS.findIndex((x) => m![3]!.toLowerCase().startsWith(x)), m[2]!);
  m = /(\d{4})-йил\s+(\d{1,2})-([а-яўқғҳ]+)/i.exec(text);
  if (m) return iso(m[1]!, UZ_CYR_MONTHS.findIndex((x) => m![3]!.toLowerCase().startsWith(x)), m[2]!);
  m = /(\d{1,2})\s+([а-я]+)\s+(\d{4})/i.exec(text);
  if (m) return iso(m[3]!, RU_MONTHS.indexOf(m[2]!.toLowerCase()), m[1]!);
  return null;
}

/** Разбор текста примечания об изменении. */
export function parseAmendmentNote(note: string): Omit<LexuzAmendment, 'docId' | 'url' | 'note'> {
  const t = clean(note);
  const reg = new RegExp(
    `(?:ro${APOS}yxat\\s+raqami|рўйхат\\s+рақами|рег\\.\\s*№|рег(?:истрационный)?\\.?\\s*номер)\\s*(\\d+(?:-\\d+)*)(?:\\s*(?:,|от)\\s*(\\d{2}\\.\\d{2}\\.\\d{4}))?`,
    'i',
  ).exec(t);
  const num = /(\S+?)-(?:sonli|сонли)\b/i.exec(t)?.[1] ?? /года\s*№\s*([^\s,)]+)/.exec(t)?.[1] ?? null;
  const adoptPart = /(\d{4}-(?:yil|йил)\s+\d{1,2}-\S+?(?:dagi|даги))/i.exec(t)?.[1] ?? /от\s+(\d{1,2}\s+[а-я]+\s+\d{4})/i.exec(t)?.[1];
  const eff = /(?:Kuchga\s+kirish\s+sanasi|Кучга\s+кириш\s+санаси|Дата\s+вступления\s+в\s+силу)\s*[—–-]\s*([^;)]+)/i.exec(t)?.[1];
  return {
    registrationNumber: reg?.[1] ?? null,
    registrationDate: reg?.[2] ? ruDateToIso(reg[2]) : null,
    adoptionNumber: num,
    adoptionDate: adoptPart ? wordDate(adoptPart) : null,
    effectiveDate: eff ? (ruDateToIso(eff.trim().slice(0, 10)) ?? wordDate(eff)) : null,
  };
}

/** Изменяющие акты из примечаний CHANGES_ORIGINS, по датам редакций (ONDATE ссылки). */
function amendmentsByDate($: CheerioAPI, selfId: string): Map<string, LexuzAmendment[]> {
  const out = new Map<string, LexuzAmendment[]>();
  $('.CHANGES_ORIGINS').each((_, el) => {
    const box = $(el);
    const note = clean(box.text()).slice(0, 500);
    box.find('a[href*="ONDATE="]').each((_, a) => {
      const href = $(a).attr('href') ?? '';
      const raw = docIdFromHref(href);
      const date = /ONDATE=(\d{2}\.\d{2}\.\d{4})/.exec(href)?.[1];
      if (!raw || !date) return;
      const docId = originalId(raw);
      if (docId === selfId) return;
      const isoDate = ruDateToIso(date);
      if (!isoDate) return;
      const list = out.get(isoDate) ?? [];
      if (list.some((x) => x.docId === docId)) return;
      list.push({ docId, url: `${LEXUZ_ORIGIN}/docs/${docId}`, note, ...parseAmendmentNote(note) });
      out.set(isoDate, list);
    });
  });
  return out;
}

function editionLabel(e: { date: string; status: LexuzEditionStatus; amendingActs: LexuzAmendment[] }): string {
  const st = e.status === 'current' ? 'действующая' : e.status === 'future' ? 'вступит в силу' : 'прежняя';
  const acts = e.amendingActs
    .map((a) => (a.registrationNumber ? `рег. ${a.registrationNumber}` : a.adoptionNumber ? `№ ${a.adoptionNumber}` : `docs/${a.docId}`))
    .join(', ');
  return `Редакция от ${isoToRuDate(e.date)} (${st}${acts ? `; изменения: ${acts}` : ''})`;
}

/** Разбор страницы документа: заголовок, список редакций, публикации, языковые версии. */
export function parseDocPage(html: string, docUrl: string, today: string = localToday()): LexuzDocInfo | { error: string } {
  const $ = load(html);
  if ($('#divCont').length === 0) return { error: 'на странице нет текста документа (#divCont) — вёрстка lex.uz изменилась' };
  const base = baseDocUrl(docUrl);
  const selfId = originalId(docIdFromHref(new URL(base).pathname) ?? '');

  const rawTitle = clean($('title').first().text());
  const tm = /^(.+?)-сон\s+(\d{2}\.\d{2}\.\d{4})\.?\s*(.*)$/.exec(rawTitle);
  const actTitle = clean($('.ACT_TITLE div[name]').first().text());
  const title = actTitle || (tm ? tm[3]! : rawTitle);

  const dates = new Set<string>();
  let shown: string | null = null;
  $('#lx_var_t .dropdown-menu__item').each((_, el) => {
    const d = ruDateToIso(clean($(el).text()));
    if (!d) return;
    dates.add(d);
    if ($(el).hasClass('lx_date_selected')) shown = d;
  });
  const sorted = [...dates].sort();
  const currentDate = sorted.filter((d) => d <= today).at(-1) ?? null;
  const amend = amendmentsByDate($, selfId);
  const editions: LexuzEdition[] = sorted.map((date) => {
    const status: LexuzEditionStatus = date > today ? 'future' : date === currentDate ? 'current' : 'past';
    const e = { date, url: ondateUrl(base, date), status, amendingActs: amend.get(date) ?? [], label: '' };
    e.label = editionLabel(e);
    return e;
  });

  const publications: LexuzPublication[] = [];
  const pub = clean($('.PUBLICATION_ORIGIN').first().text());
  for (const m of pub.matchAll(/(\d{2}\.\d{2}\.\d{4})[^,;]*,\s*(\d+\/\d+\/([\d-]+)\/\d+)/g)) {
    publications.push({ date: ruDateToIso(m[1]!), ref: m[2]!, registrationNumber: m[3] ?? null });
  }

  const languages: LexuzDocInfo['languages'] = { ru: null, uzCyrl: null, uzLatn: null };
  $('.docContentHeader__item-link[title]').each((_, el) => {
    const e = $(el);
    const t = e.attr('title') ?? '';
    const key = t === 'На русском' ? 'ru' : t === 'Ўзбекча' ? 'uzCyrl' : /^O['ʻ‘’]zbekcha$/.test(t) ? 'uzLatn' : null;
    if (!key) return;
    const path = /openUrl\('([^']+)'\)/.exec(e.attr('onclick') ?? '')?.[1];
    languages[key] = path ? new URL(path, base).toString() : e.hasClass('active') ? base : null;
  });

  return {
    url: base,
    title,
    headerNumber: tm ? tm[1]! : null,
    headerDate: tm ? ruDateToIso(tm[2]!) : null,
    shownEdition: shown,
    editions,
    publications,
    languages,
  };
}

/**
 * Канал А: список редакций документа. Будущие редакции (дата > today) есть в списке, но их изменяющие акты видны
 * только на странице ?ONDATE=<дата> — для них (и для дат из detailDates без найденных актов) делается доп. запрос.
 */
export async function lexuzEditions(opts: {
  fetcher: Fetcher;
  docUrl: string;
  today?: string;
  /** Даты (ISO), для которых при необходимости догрузить страницу редакции. По умолчанию — все будущие. */
  detailDates?: string[];
  timeoutMs?: number;
}): Promise<LexuzEditionsResult> {
  const counter = { requests: 0 };
  const timeoutMs = opts.timeoutMs ?? SEARCH_TIMEOUT_MS;
  const today = opts.today ?? localToday();
  const base = baseDocUrl(opts.docUrl);
  counter.requests++;
  const res = await opts.fetcher.get(base, { timeoutMs });
  if (!res.ok) return netFail(res, 'страница документа', counter.requests);
  const info = parseDocPage(res.body, base, today);
  if ('error' in info) return { ok: false, failure: 'parser', reason: `Документ lex.uz ${base}: ${info.error}`, requests: counter.requests };
  info.url = base;
  const want = new Set(opts.detailDates ?? info.editions.filter((e) => e.status === 'future').map((e) => e.date));
  for (const e of info.editions) {
    if (!want.has(e.date) || e.amendingActs.length > 0) continue;
    counter.requests++;
    const r = await opts.fetcher.get(e.url, { timeoutMs });
    if (!r.ok) return netFail(r, `редакция от ${isoToRuDate(e.date)}`, counter.requests);
    const $ = load(r.body);
    e.amendingActs = amendmentsByDate($, originalId(docIdFromHref(new URL(base).pathname) ?? '')).get(e.date) ?? [];
    e.label = editionLabel(e);
  }
  return { ok: true, requests: counter.requests, ...info };
}

// ───────────────────────── Состояние отслеживаемых актов ─────────────────────────

/**
 * Запись `state/watched.json` об одном отслеживаемом акте (файл ведёт collector.ts).
 * `lastSeenEdition` — самая поздняя виденная дата редакции (ISO), null — акт ещё не проверялся.
 * `knownEditions` — ВСЕ виденные даты: новая поправка может вступить в силу РАНЬШЕ уже известной будущей
 * редакции (известна 13.01.2027, появилась 01.12.2026) — сравнение только с lastSeenEdition её пропустит.
 */
export interface WatchedActState {
  url: string;
  lastSeenEdition: string | null;
  knownEditions?: string[];
  /** Когда проверялся (ISO-время). */
  checkedAt?: string;
}

/**
 * Новые редакции. Есть `known` — всё, чего нет в known; иначе — даты > lastSeen.
 * lastSeen = null и нет known (первая проверка): с `firstRunFrom` — даты ≥ firstRunFrom (обычно начало окна),
 * без него — все редакции.
 */
export function newEditionsSince(
  editions: LexuzEdition[],
  lastSeen: string | null,
  opts: { known?: string[]; firstRunFrom?: string } = {},
): LexuzEdition[] {
  if (opts.known && opts.known.length > 0) {
    const k = new Set(opts.known);
    return editions.filter((e) => !k.has(e.date));
  }
  if (lastSeen) return editions.filter((e) => e.date > lastSeen);
  if (opts.firstRunFrom) return editions.filter((e) => e.date >= opts.firstRunFrom!);
  return [...editions];
}

/** Состояние после проверки: lastSeenEdition = максимум, knownEditions = объединение. */
export function nextWatchedState(prev: WatchedActState, editions: LexuzEdition[], now: Date = new Date()): WatchedActState {
  const all = new Set([...(prev.knownEditions ?? []), ...editions.map((e) => e.date)]);
  if (prev.lastSeenEdition) all.add(prev.lastSeenEdition);
  const known = [...all].sort();
  return { url: prev.url, lastSeenEdition: known.at(-1) ?? null, knownEditions: known, checkedAt: now.toISOString() };
}

/**
 * Кандидаты канала А из новой редакции: по одному на изменяющий акт (id `lexuz-<docId>` — совпадает с id канала Б,
 * ключ `reg:<рег.номер>` по TRI-04); если изменяющий акт не виден — один кандидат на саму редакцию.
 */
export function editionCandidates(info: Pick<LexuzDocInfo, 'url' | 'title'>, edition: LexuzEdition): Candidate[] {
  const head = `${info.title} — ${edition.label}`;
  if (edition.amendingActs.length === 0) {
    const selfId = originalId(docIdFromHref(new URL(info.url).pathname) ?? 'x');
    return [
      {
        id: `lexuz-${selfId}-ed-${edition.date.replace(/-/g, '')}`,
        key: ledgerKey({ number: 'edition', date: edition.date, url: edition.url }),
        title_original: head,
        issuer: '',
        date: edition.date,
        doc_type: '',
        url: edition.url,
        snippet: `Новая редакция ${edition.url}`,
        channel: 'A',
      },
    ];
  }
  return edition.amendingActs.map((a) => ({
    id: `lexuz-${a.docId}`,
    key: ledgerKey({ registrationNumber: a.registrationNumber ?? undefined, number: a.adoptionNumber ?? undefined, date: a.adoptionDate ?? undefined, url: a.url }),
    title_original: head,
    issuer: '',
    date: a.registrationDate ?? a.adoptionDate ?? edition.date,
    doc_type: '',
    url: a.url,
    snippet: `${a.note} | Редакция: ${edition.url}`,
    channel: 'A' as Channel,
  }));
}

/** Склейка кандидатов разных каналов: одинаковый id → одна запись (первая), сниппеты объединяются. */
export function dedupeCandidates(list: Candidate[]): Candidate[] {
  const byId = new Map<string, Candidate>();
  for (const c of list) {
    const prev = byId.get(c.id);
    if (!prev) byId.set(c.id, { ...c });
    else if (c.snippet && !prev.snippet.includes(c.snippet)) prev.snippet = `${prev.snippet} | ${c.snippet}`;
  }
  return [...byId.values()];
}
