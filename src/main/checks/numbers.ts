// Сверка чисел, дат, номеров и URL между английским отчётом и русским переводом (LNG-03, T-7).
// Расхождение блокирует RU-версию. Сравнение — мультимножества по четырём видам фактов.
import { findDateSpans, toIso } from './evidence.ts';

export interface ExtractedFacts {
  /** Числа в каноническом виде: «1 000» = «1,000» = «1000» → "1000"; «1,5» = «1.5» → "1.5". */
  numbers: string[];
  /** Даты в ISO (YYYY-MM-DD). */
  dates: string[];
  /** URL как в тексте, без завершающих знаков препинания. */
  urls: string[];
  /**
   * Номера актов, регистрации и пунктов: «24/2», «3254-2», «12/8», «50^1» (из «50¹»),
   * «397» (из «ПП-397»/«PP-397»: буквенный префикс отбрасывается, т.к. в переводе меняется алфавит).
   */
  actNumbers: string[];
}

export type FactKind = 'number' | 'date' | 'actNumber' | 'url';

export interface FactDiff {
  kind: FactKind;
  value: string;
  /** Сколько раз встречается в EN. */
  en: number;
  /** Сколько раз встречается в RU. */
  ru: number;
}

export interface NumbersCheck {
  ok: boolean;
  /** Значения, которых в RU меньше, чем в EN (повторяются столько раз, сколько не хватает). */
  missingInRu: string[];
  /** Значения, которых в RU больше, чем в EN. */
  extraInRu: string[];
  /** По-русски: что именно расходится, по строке на значение. */
  details: string[];
  diffs: FactDiff[];
}

const INVISIBLE = /[­​‌‍⁠﻿]/g;
const DASHES = /[‐‑‒–—―−]/g;
/** Эмодзи-цифры (1️⃣) и пиктограммы (⚠️, ✅, ❌ …) — не числа. */
const KEYCAP = /[0-9#*]️?⃣/g;
const PICTO = /[\p{Extended_Pictographic}︎️]/gu;

/** http(s)://…, www.…, а также «домен/путь» без схемы (lex.uz/docs/-4888804?ONDATE=13.01.2027). */
const URL_RE =
  /(?:https?:\/\/|www\.)[^\s<>()[\]{}"'`«»]+|(?<![\p{L}\p{N}@/.\-])(?:[a-z0-9-]+\.)+[a-z]{2,24}\/[^\s<>()[\]{}"'`«»]*/giu;
const URL_TRAIL = /[.,;:!?…)\]}»"'*_>]+$/u;

/** Номер заголовка Markdown: «## 3. Changes», «### 2.1 Scope». */
const HEADING_NUM = /^(\s{0,3}#{1,6}\s+)\d{1,3}(?:\.\d{1,3})*\.?(?=\s)/gm;
/** Маркер нумерованного списка: «1. », «2) », «  - 3. », «> 1. ». */
const LIST_NUM = /^(\s*(?:>\s*)*(?:[-*+]\s+)?)\d{1,3}(?:\.\d{1,3})*[.)](?=\s)/gm;

const SUP: Record<string, string> = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9' };
const SUP_NUM = /(?<![\d])(\d+)([⁰¹²³⁴⁵⁶⁷⁸⁹]+)/g;
/** «ПП-397», «PP-397», «УП-6», «T-7»: заглавные буквы + дефис + номер. */
const PREFIXED_NUM = /(?<![\p{L}\p{N}])\p{Lu}{1,5}-(\d+(?:[/-]\d+)*)(?![\d])/gu;
/** «24/2», «3254-2», «12/8», «10/26/3254-2/1020». */
const SEP_NUM = /(?<![\d.,/-])\d+(?:[/-]\d+)+(?![\d])/g;
/** Числа с разделителями тысяч/дробной части: «1 000», «1,000», «1 000,5», «1,000.5», «10.5». */
const NUM = /(?<![\d])\d+(?:[ ,.]\d+)*(?![\d])/g;

const blank = (s: string, start: number, end: number): string =>
  s.slice(0, start) + ' '.repeat(end - start) + s.slice(end);

/** Каноническая запись числа (без незначащих нулей). */
function canonNumber(intPart: string, frac: string): string {
  const i = intPart.replace(/^0+(?=\d)/, '');
  const f = frac.replace(/0+$/, '');
  return f ? `${i}.${f}` : i;
}

/** Одно число из группы цифр с разделителями или null, если это несколько чисел подряд. */
function parseSingleNumber(tok: string): string | null {
  const parts = tok.split(/([ ,.])/);
  const groups = parts.filter((_, i) => i % 2 === 0);
  const seps = parts.filter((_, i) => i % 2 === 1);
  if (seps.length === 0) return canonNumber(tok, '');
  const thousandsOk = (gs: string[]): boolean => gs[0].length <= 3 && gs.slice(1).every((g) => g.length === 3);

  // «1,000.5» / «1 000,5» / «1.000,5»: последний разделитель другого вида — дробная часть.
  const last = seps[seps.length - 1];
  const head = seps.slice(0, -1);
  if (head.length > 0 && head.every((x) => x === head[0]) && head[0] !== last && last !== ' ') {
    const intGroups = groups.slice(0, -1);
    return thousandsOk(intGroups) ? canonNumber(intGroups.join(''), groups[groups.length - 1]) : null;
  }
  if (new Set(seps).size !== 1) return null;
  if (last === ' ') return thousandsOk(groups) ? canonNumber(groups.join(''), '') : null;
  if (last === ',') {
    if (thousandsOk(groups)) return canonNumber(groups.join(''), '');
    return groups.length === 2 ? canonNumber(groups[0], groups[1]) : null;
  }
  // «.»: одна точка — десятичная дробь; несколько групп по 3 — разделители тысяч.
  if (groups.length === 2) return canonNumber(groups[0], groups[1]);
  return thousandsOk(groups) ? canonNumber(groups.join(''), '') : null;
}

/** Разбор группы цифр с разделителями: одно число или несколько («15 16 19», «2,3,5», «1.2.3»). */
function parseNumberToken(tok: string): string[] {
  const one = parseSingleNumber(tok);
  if (one !== null) return [one];
  for (const sep of [' ', ',', '.']) {
    if (tok.includes(sep)) return tok.split(sep).flatMap(parseNumberToken);
  }
  return [canonNumber(tok, '')];
}

/** Извлекает все числа, даты, номера и URL из Markdown-текста (EN или RU). */
export function extractFacts(text: string): ExtractedFacts {
  const urls: string[] = [];
  const dates: string[] = [];
  const actNumbers: string[] = [];
  const numbers: string[] = [];

  // 1. Эмодзи и маркеры, затем нумерация заголовков и списков (по строкам, до склейки пробелов).
  let s = text.normalize('NFC').replace(INVISIBLE, '').replace(KEYCAP, ' ').replace(PICTO, ' ');
  s = s.replace(HEADING_NUM, '$1').replace(LIST_NUM, '$1');

  // 2. URL — строками как есть (регистр важен), без завершающей пунктуации.
  s = s.replace(URL_RE, (m) => {
    const u = m.replace(URL_TRAIL, '');
    urls.push(u);
    return ' '.repeat(m.length);
  });

  // 3. Единая форма пробелов и тире; копия в нижнем регистре той же длины — для поиска дат.
  s = s.replace(DASHES, '-').replace(/\s+/g, ' ');
  let lower = s.replace(/İ/g, 'i').toLowerCase();
  if (lower.length !== s.length) {
    s = lower; // редкий случай изменения длины при смене регистра: работаем по нижнему регистру
    lower = s;
  }

  // 4. Даты (все форматы и языки, что знает evidence-check) → ISO, и вырезаем их.
  for (const d of findDateSpans(lower)) {
    dates.push(toIso(d));
    s = blank(s, d.start, d.end);
  }

  // 5. Номера пунктов с надстрочными цифрами: «50¹» → «50^1».
  s = s.replace(SUP_NUM, (m, base: string, sup: string) => {
    actNumbers.push(`${base}^${[...sup].map((c) => SUP[c] ?? '').join('')}`);
    return ' '.repeat(m.length);
  });

  // 6. Номера актов: «ПП-397» → «397»; «24/2», «3254-2».
  s = s.replace(PREFIXED_NUM, (m, num: string) => {
    actNumbers.push(num);
    return ' '.repeat(m.length);
  });
  s = s.replace(SEP_NUM, (m) => {
    actNumbers.push(m);
    return ' '.repeat(m.length);
  });

  // 7. Остальные числа.
  for (const m of s.matchAll(NUM)) numbers.push(...parseNumberToken(m[0]));

  return { numbers, dates, urls, actNumbers };
}

const KIND_LABEL: Record<FactKind, string> = {
  number: 'Число',
  date: 'Дата',
  actNumber: 'Номер',
  url: 'Ссылка',
};

function counts(xs: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return m;
}

/** Сверка EN и RU: ok=false, если хоть одно мультимножество (числа, даты, номера, URL) различается. */
export function compareNumbers(en: string, ru: string): NumbersCheck {
  const a = extractFacts(en);
  const b = extractFacts(ru);
  const pairs: Array<[FactKind, string[], string[]]> = [
    ['number', a.numbers, b.numbers],
    ['date', a.dates, b.dates],
    ['actNumber', a.actNumbers, b.actNumbers],
    ['url', a.urls, b.urls],
  ];
  const diffs: FactDiff[] = [];
  const missingInRu: string[] = [];
  const extraInRu: string[] = [];
  const details: string[] = [];
  for (const [kind, xs, ys] of pairs) {
    const ca = counts(xs);
    const cb = counts(ys);
    const keys = [...new Set([...ca.keys(), ...cb.keys()])];
    for (const value of keys) {
      const n = ca.get(value) ?? 0;
      const m = cb.get(value) ?? 0;
      if (n === m) continue;
      diffs.push({ kind, value, en: n, ru: m });
      for (let i = m; i < n; i++) missingInRu.push(value);
      for (let i = n; i < m; i++) extraInRu.push(value);
      const label = `${KIND_LABEL[kind]} «${value}»`;
      if (m === 0) details.push(`${label} есть в английском отчёте (${n} раз), но нет в русском переводе`);
      else if (n === 0) details.push(`${label} есть в русском переводе (${m} раз), но нет в английском отчёте`);
      else details.push(`${label}: в английском отчёте ${n} раз, в русском переводе ${m} раз`);
    }
  }
  return { ok: diffs.length === 0, missingInRu, extraInRu, details, diffs };
}
