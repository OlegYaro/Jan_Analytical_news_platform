// Общий движок профилей извлечения (COL-01, SRC-04): rss | html_list | json_api. Код сам прогоняет профиль, 0 токенов.
import { load } from 'cheerio';
import { XMLParser } from 'fast-xml-parser';
import type { Fetcher } from './fetcher-types.ts';
import { parseDatesFromQuote, toIso } from '../checks/evidence.ts';
import type {
  ExtractionProfile,
  HtmlListProfile,
  JsonApiProfile,
  PaginationSpec,
  RssProfile,
} from '../../shared/profile-types.ts';

// Типы профиля живут в shared (их хранит Source в countries.json); здесь — реэкспорт для прежних импортов.
export type { ExtractionProfile, HtmlListProfile, JsonApiProfile, PaginationSpec, RssProfile };

export interface CollectedDoc {
  /** guid (RSS) или абсолютный url. */
  id: string;
  title: string;
  /** ISO `YYYY-MM-DD` или null, если дату извлечь не удалось. */
  date: string | null;
  url: string;
  /** Орган-издатель; пустая строка, если неизвестен. */
  issuer: string;
}

export type ProfileResult = { ok: true; docs: CollectedDoc[] } | { ok: false; reason: string };

export interface RunProfileOptions {
  /** Для относительных ссылок; по умолчанию — итоговый адрес загруженной страницы. */
  baseUrl?: string;
  /** Верхняя граница числа страниц (дополнительно к pagination.max_pages). */
  maxPages?: number;
}

// ---------- даты ----------

const MONTH_STEMS: Array<[string, number]> = [
  // ru + uz (кириллица: январ, феврал, март, апрел, май, июн, июл, август, сентабр, октабр, ноябр, декабр)
  ['янв', 1], ['фев', 2], ['мар', 3], ['апр', 4], ['мая', 5], ['май', 5], ['июн', 6], ['июл', 7],
  ['авг', 8], ['сен', 9], ['окт', 10], ['ноя', 11], ['дек', 12],
  // uz (латиница)
  ['yan', 1], ['fev', 2], ['mart', 3], ['apr', 4], ['may', 5], ['iyun', 6], ['iyul', 7],
  ['avg', 8], ['sent', 9], ['okt', 10], ['noy', 11], ['dek', 12],
  // en
  ['jan', 1], ['feb', 2], ['mar', 3], ['may', 5], ['jun', 6], ['jul', 7], ['aug', 8],
  ['sep', 9], ['oct', 10], ['nov', 11], ['dec', 12],
];

function monthByName(word: string): number | null {
  const w = word.toLowerCase().replace(/[.ʼ’'`]/g, '');
  if (w.length < 3) return w === 'may' ? 5 : null;
  for (const [stem, n] of MONTH_STEMS) if (w.startsWith(stem)) return n;
  return null;
}

function iso(y: number, m: number, d: number): string | null {
  if (y < 1900 || y > 2100) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const WORD = "[A-Za-zА-Яа-яЁёЎўҚқҒғҲҳʼ’'`.]+";

/** Достаёт первую дату из текста (формат необязателен: подсказка для числовых дат). Неизвестное → null. */
export function parseDate(text: string, format?: string): string | null {
  const s = text.replace(/\s+/g, ' ').trim();
  if (!s) return null;
  let m: RegExpExecArray | null;

  // Подсказка: порядок полей числовой даты.
  if (format) {
    const f = format.toUpperCase();
    const order = [...f.matchAll(/YYYY|DD|MM/g)].map((x) => x[0]);
    if (order.length === 3 && order.includes('YYYY') && order.includes('DD') && order.includes('MM')) {
      const re = /(\d{1,4})[.\-/\s](\d{1,2})[.\-/\s](\d{1,4})/.exec(s);
      if (re) {
        const v: Record<string, number> = {};
        order.forEach((k, i) => (v[k] = Number(re[i + 1])));
        const r = iso(v['YYYY'] as number, v['MM'] as number, v['DD'] as number);
        if (r) return r;
      }
    }
  }

  if ((m = /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/.exec(s))) {
    const r = iso(+(m[1] as string), +(m[2] as string), +(m[3] as string));
    if (r) return r;
  }
  if ((m = /(?<!\d)(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?!\d)/.exec(s))) {
    const r = iso(+(m[3] as string), +(m[2] as string), +(m[1] as string));
    if (r) return r;
  }
  // D <месяц> YYYY (в т.ч. RFC-822 «Mon, 16 Nov 2026 …», «2026-yil 9-oktabr» не берём: нужен порядок D M Y)
  const dmy = new RegExp(`(?<!\\d)(\\d{1,2})(?:-?(?:yil|й|г))?\\.?\\s+(${WORD})\\s+(\\d{4})(?!\\d)`, 'g');
  for (const x of s.matchAll(dmy)) {
    const mo = monthByName(x[2] as string);
    if (mo) {
      const r = iso(+(x[3] as string), mo, +(x[1] as string));
      if (r) return r;
    }
  }
  // «2026 yil 9 oktabr», «2026-yil 9-oktabr»
  const ymd = new RegExp(`(?<!\\d)(\\d{4})(?:-?\\s?(?:yil|й|г)\\.?)?,?\\s+(\\d{1,2})-?\\s?(${WORD})`, 'g');
  for (const x of s.matchAll(ymd)) {
    const mo = monthByName(x[3] as string);
    if (mo) {
      const r = iso(+(x[1] as string), mo, +(x[2] as string));
      if (r) return r;
    }
  }
  // «Nov 16, 2026»
  const mdy = new RegExp(`(${WORD})\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})(?!\\d)`, 'g');
  for (const x of s.matchAll(mdy)) {
    const mo = monthByName(x[1] as string);
    if (mo) {
      const r = iso(+(x[3] as string), mo, +(x[2] as string));
      if (r) return r;
    }
  }
  // Остальные языки стран (kk, ky, tg, tk, ka, hy, az, mn …): общий словарь месяцев проверки цитат (checks/evidence.ts).
  // Фаза 6: даты на сайтах KZ — «17 қараша 2026», MN — «2026.11.17» / «2026 оны 11 сарын 17».
  const any = parseDatesFromQuote(s)[0];
  return any ? toIso(any) : null;
}

/** SRC-04: профиль «здоров», только если извлечено ≥ 3 документа С ДАТАМИ. */
export function profileHealthy(docs: CollectedDoc[]): boolean {
  return docs.filter((d) => d.date !== null).length >= 3;
}

// ---------- общие помощники ----------

const clean = (s: string): string => s.replace(/[\s ]+/g, ' ').trim();

function abs(href: string, base: string): string | null {
  try {
    const u = new URL(href.trim(), base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

function pageUrl(url: string, pagination: PaginationSpec | undefined, page: number): string {
  if (!pagination || page === 1) return url;
  const u = new URL(url);
  u.searchParams.set(pagination.param, String(page));
  return u.href;
}

// ---------- RSS / Atom ----------

type Xml = Record<string, unknown>;

function xmlText(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number') return clean(String(v));
  if (Array.isArray(v)) return xmlText(v[0]);
  if (typeof v === 'object') return xmlText((v as Xml)['#text']);
  return '';
}

function atomLink(v: unknown): string {
  const arr = Array.isArray(v) ? v : [v];
  const links = arr.filter((x): x is Xml => typeof x === 'object' && x !== null);
  const alt = links.find((l) => !l['@_rel'] || l['@_rel'] === 'alternate') ?? links[0];
  return alt ? xmlText(alt['@_href']) : xmlText(v);
}

function parseRss(body: string, base: string): CollectedDoc[] | string {
  let root: Xml;
  try {
    root = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', trimValues: true }).parse(
      body.replace(/^﻿/, ''),
    ) as Xml;
  } catch {
    return 'Ответ источника не похож на RSS/Atom';
  }
  const rss = root['rss'] as Xml | undefined;
  const feed = root['feed'] as Xml | undefined;
  let entries: unknown[];
  if (rss && typeof rss === 'object') {
    const ch = rss['channel'] as Xml | undefined;
    entries = [(ch?.['item'] as unknown) ?? []].flat();
  } else if (feed && typeof feed === 'object') {
    entries = [(feed['entry'] as unknown) ?? []].flat();
  } else {
    return 'Ответ источника не похож на RSS/Atom';
  }
  const out: CollectedDoc[] = [];
  for (const e of entries) {
    if (typeof e !== 'object' || e === null) continue;
    const it = e as Xml;
    const title = xmlText(it['title']);
    const href = feed ? atomLink(it['link']) : xmlText(it['link']);
    const url = href ? abs(href, base) : null;
    if (!title || !url) continue;
    const dateText =
      xmlText(it['pubDate']) || xmlText(it['published']) || xmlText(it['updated']) || xmlText(it['dc:date']);
    const author = it['author'] as unknown;
    const issuer =
      xmlText(it['dc:creator']) ||
      (typeof author === 'object' && author !== null ? xmlText((author as Xml)['name']) : xmlText(author)) ||
      xmlText(it['source']);
    const guid = xmlText(it['guid']) || xmlText(it['id']);
    out.push({ id: guid || url, title, date: parseDate(dateText), url, issuer });
  }
  return out;
}

// ---------- html_list ----------

function parseHtmlList(body: string, p: HtmlListProfile, base: string): CollectedDoc[] | string {
  const $ = load(body);
  const rows = $(p.item);
  if (rows.length === 0) return `Селектор строки «${p.item}» ничего не нашёл на странице`;
  let linkSel = (p.link ?? '').trim();
  let linkAttr = 'href';
  const at = /^(.*)@([\w-]+)$/.exec(linkSel);
  if (at) {
    linkSel = (at[1] as string).trim();
    linkAttr = at[2] as string;
  } else if (linkSel.endsWith('[href]')) {
    linkSel = linkSel.slice(0, -'[href]'.length).trim();
  }
  const out: CollectedDoc[] = [];
  rows.each((_, el) => {
    const row = $(el);
    const pick = (sel: string) => (row.is(sel) ? row : row.find(sel).first());
    const titleEl = p.title ? pick(p.title) : row;
    const title = clean(titleEl.text());
    let linkEl = linkSel ? pick(linkSel) : row.is('a') ? row : row.find('a[href]').first();
    if (linkEl.length === 0 && !linkSel) linkEl = row;
    const href = linkEl.attr(linkAttr);
    const url = href ? abs(href, base) : null;
    if (!title || !url) return;
    let date: string | null = null;
    if (p.date) {
      const d = pick(p.date);
      date = parseDate(d.attr('datetime') ?? '', p.date_format) ?? parseDate(d.text(), p.date_format);
    }
    const issuer = p.issuer ? clean(pick(p.issuer).text()) : '';
    out.push({ id: url, title, date, url, issuer });
  });
  return out;
}

// ---------- json_api ----------

/** Простой доступ по пути `a.b[0].c` (допускается ведущий `$`); без eval. Пустой путь — сам объект. */
export function jsonPath(obj: unknown, path: string): unknown {
  const p = path.trim().replace(/^\$\.?/, '');
  if (p === '') return obj;
  const tokens = [...p.matchAll(/([^.[\]]+)|\[(\d+)\]|\["([^"]*)"\]/g)];
  let cur: unknown = obj;
  for (const t of tokens) {
    if (cur === null || typeof cur !== 'object') return undefined;
    const key = t[1] ?? t[2] ?? t[3];
    if (key === undefined) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(key);
      if (!Number.isInteger(idx)) return undefined;
      cur = cur[idx];
    } else {
      if (!Object.hasOwn(cur, key)) return undefined;
      cur = (cur as Xml)[key];
    }
  }
  return cur;
}

function jsonScalar(v: unknown): string {
  return typeof v === 'string' || typeof v === 'number' ? String(v) : '';
}

function jsonDate(v: unknown, fmt?: string): string | null {
  const s = jsonScalar(v);
  if (/^\d{10}(\d{3})?$/.test(s)) {
    const ms = s.length === 10 ? Number(s) * 1000 : Number(s);
    return new Date(ms).toISOString().slice(0, 10);
  }
  return parseDate(s, fmt);
}

function parseJson(body: string, p: JsonApiProfile, base: string): CollectedDoc[] | string {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return 'Ответ источника не является JSON';
  }
  const items = jsonPath(data, p.json_paths.items);
  if (!Array.isArray(items)) return `По пути «${p.json_paths.items}» нет списка`;
  const out: CollectedDoc[] = [];
  for (const it of items) {
    const title = clean(jsonScalar(jsonPath(it, p.json_paths.title)));
    const href = jsonScalar(jsonPath(it, p.json_paths.link));
    const url = href ? abs(href, base) : null;
    if (!title || !url) continue;
    out.push({ id: url, title, date: jsonDate(jsonPath(it, p.json_paths.date), p.date_format), url, issuer: '' });
  }
  return out;
}

// ---------- запуск ----------

export async function runProfile(
  profile: ExtractionProfile,
  fetcher: Fetcher,
  opts: RunProfileOptions = {},
): Promise<ProfileResult> {
  const maxPages = Math.max(1, Math.min(profile.pagination?.max_pages ?? 1, opts.maxPages ?? Infinity));
  const seen = new Set<string>();
  const docs: CollectedDoc[] = [];
  for (let page = 1; page <= maxPages; page++) {
    let target: string;
    try {
      target = pageUrl(profile.url, profile.pagination, page);
    } catch {
      return { ok: false, reason: 'Адрес в профиле некорректен' };
    }
    const r = await fetcher.get(target);
    if (!r.ok) {
      if (page === 1) return { ok: false, reason: r.message };
      break;
    }
    const base = opts.baseUrl ?? r.url;
    const parsed =
      profile.kind === 'rss'
        ? parseRss(r.body, base)
        : profile.kind === 'html_list'
          ? parseHtmlList(r.body, profile, base)
          : parseJson(r.body, profile, base);
    if (typeof parsed === 'string') {
      if (page === 1) return { ok: false, reason: parsed };
      break;
    }
    if (page === 1 && parsed.length === 0) {
      return { ok: false, reason: 'Профиль не нашёл на странице ни одного документа' };
    }
    let added = 0;
    for (const d of parsed) {
      if (seen.has(d.url)) continue;
      seen.add(d.url);
      docs.push(d);
      added++;
    }
    if (added === 0) break;
  }
  return { ok: true, docs };
}
