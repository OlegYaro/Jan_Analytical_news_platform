// Банковские и финансовые термины в тексте акта: быстрый признак и вырезка фрагментов для экрана.
// Чистая логика: без модели и сети. Словарь — данные (BANK_TERMS), а не россыпь регулярных выражений.

export type TermGroup =
  | 'bank'
  | 'credit'
  | 'deposit'
  | 'equity'
  | 'payment'
  | 'finance'
  | 'insurance'
  | 'securities'
  | 'compliance'
  | 'insolvency';

export interface BankTerm {
  /** Стабильный идентификатор термина (латиницей). */
  id: string;
  group: TermGroup;
  /**
   * Основы (подстрока от начала слова: «кредит» найдёт «кредитлар», «кредитов»). Пишутся в нормализованном
   * виде: строчные, апострофы убраны, узбекская кириллица упрощена (қ→к, ҳ→х, ғ→г, ў→у, ё→е).
   * Пробел внутри основы = любой пробельный промежуток; «~» = «дописать окончание слова и пробел»;
   * «$» в конце = слово кончается здесь (для аббревиатур).
   */
  stems: string[];
  /** Продолжения, при которых совпадение ложное («bank» + «rot»). Проверяются сразу после основы. */
  notFollowedBy?: string[];
}

export const BANK_TERMS: BankTerm[] = [
  { id: 'bank', group: 'bank', stems: ['bank', 'банк', 'банк'], notFollowedBy: ['rot', 'рот'] },
  { id: 'central-bank', group: 'bank', stems: ['markaziy bank', 'марказий банк', 'центральн~банк', 'central bank'] },
  { id: 'credit', group: 'credit', stems: ['kredit', 'кредит', 'credit', 'loan', 'lending', 'ipoteka', 'ипотек', 'mortgage', 'lizing', 'лизинг', 'leasing', 'faktoring', 'факторинг', 'lombard', 'ломбард'] },
  { id: 'deposit', group: 'deposit', stems: ['depozit', 'omonat', 'депозит', 'омонат', 'вклад', 'deposit'] },
  {
    id: 'shareholder',
    group: 'equity',
    stems: ['aksiyador', 'aksiya', 'акционер', 'акци', 'shareholder', 'share capital', 'stockholder', 'ustav kapital', 'устав капитал', 'уставн~капитал', 'charter capital', 'korporativ boshqaruv', 'корпоративн~управлен', 'corporate governance'],
    notFollowedBy: ['з'],
  },
  { id: 'dividend', group: 'equity', stems: ['dividend', 'дивиденд'] },
  { id: 'payment', group: 'payment', stems: ['tolov', 'платеж', 'payment', 'pul otkazma', 'денежн~перевод', 'money transfer'] },
  { id: 'finance', group: 'finance', stems: ['moliya', 'финанс', 'financ', 'kapital bozor', 'moliya bozor', 'рынок капитал', 'capital market'] },
  { id: 'insurance', group: 'insurance', stems: ['sugurta', 'страхов', 'страховани', 'insurance', 'insurer'] },
  {
    id: 'securities',
    group: 'securities',
    stems: ['qimmatli qogoz', 'киммат~когоз', 'ценн~бумаг', 'ценных бумаг', 'securities', 'fond birja', 'фондов~бирж', 'stock exchange', 'obligatsiya', 'облигац', 'bond$', 'bonds$'],
  },
  { id: 'microfinance', group: 'finance', stems: ['mikromoliya', 'mikrokredit', 'микрофинанс', 'микрокредит', 'microfinanc', 'microcredit'] },
  { id: 'islamic-finance', group: 'finance', stems: ['islom moliya', 'islom bank', 'исламск~финанс', 'исламск~банк', 'islamic', 'sukuk', 'сукук'] },
  { id: 'fx', group: 'finance', stems: ['valyuta', 'валют', 'foreign exchange', 'currency'] },
  {
    id: 'aml',
    group: 'compliance',
    stems: ['legallashtir', 'terrorizmni moliyalashtir', 'легаллаштир', 'терроризмни молиялаштир', 'легализац', 'отмывани', 'финансирован~терроризм', 'money laundering', 'laundering', 'aml$', 'под/фт', 'kyc$'],
  },
  { id: 'license', group: 'compliance', stems: ['litsenziya', 'lisenziya', 'литсензия', 'лицензи', 'licens'] },
  { id: 'crypto', group: 'finance', stems: ['kripto', 'крипто', 'crypto', 'virtual aktiv', 'виртуальн~актив', 'virtual asset'] },
  { id: 'insolvency', group: 'insolvency', stems: ['bankrot', 'банкрот', 'insolven', 'неплатежеспособ', 'tolovga qobiliyatsiz', 'bankruptcy'] },
];

/** Найденное вхождение термина в исходном тексте (позиции — в исходной строке, не в нормализованной). */
export interface TermHit {
  term: string;
  group: TermGroup;
  start: number;
  end: number;
  /** Фрагмент исходного текста как есть. */
  text: string;
}

const APOSTROPHES = new Set(["ʻ", 'ʼ', "'", '’', '‘', '`', '´', 'ʹ', 'ʽ', 'ʾ', '′']);
const CYR_MAP: Record<string, string> = { қ: 'к', ҳ: 'х', ғ: 'г', ў: 'у', ё: 'е', ъ: '', ь: 'ь' };

/**
 * Нормализация с сохранением длины: индексы в результате совпадают с индексами в исходном тексте.
 * Строчные буквы; все апострофы → «'» (его потом убирает matchable); узбекские кириллические буквы упрощены.
 */
export function normalizeText(text: string): string {
  let out = '';
  for (const ch of text) {
    let c = ch.toLowerCase();
    if (c.length !== ch.length) c = ch; // «İ» → два знака: оставляем как есть, чтобы не сдвигать позиции
    if (APOSTROPHES.has(c)) c = "'";
    else if (c in CYR_MAP) c = CYR_MAP[c] === '' ? c : CYR_MAP[c];
    out += c;
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** Основа → фрагмент регулярного выражения (см. BankTerm.stems). Апостроф между буквами допускается. */
function stemToPattern(stem: string): string {
  const exact = stem.endsWith('$');
  const body = exact ? stem.slice(0, -1) : stem;
  const parts = body.split('~').map((part) =>
    part
      .split(' ')
      .map((word) => [...word].map((c) => escapeRe(c)).join("'?"))
      .join('\\s+'),
  );
  let re = parts.join('\\p{L}*\\s+');
  if (exact) re += '(?![\\p{L}\\p{N}])';
  return re;
}

interface Compiled {
  term: BankTerm;
  re: RegExp;
}

const COMPILED: Compiled[] = BANK_TERMS.map((term) => {
  const stems = term.stems.map(stemToPattern).join('|');
  const not = term.notFollowedBy?.length ? `(?!${term.notFollowedBy.map(stemToPattern).join('|')})` : '';
  // Начало слова: перед основой не буква и не цифра. Окончание свободное (морфология).
  return { term, re: new RegExp(`(?<![\\p{L}\\p{N}])(?:${stems})${not}`, 'gu') };
});

/**
 * Все вхождения терминов, по порядку в тексте. Вхождение, целиком лежащее внутри более длинного
 * (например «bank» внутри «Markaziy bank»), отбрасывается, чтобы не считать дважды.
 */
export function findTerms(text: string): TermHit[] {
  const norm = normalizeText(text);
  const raw: TermHit[] = [];
  for (const { term, re } of COMPILED) {
    re.lastIndex = 0;
    for (let m = re.exec(norm); m; m = re.exec(norm)) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      raw.push({ term: term.id, group: term.group, start: m.index, end: m.index + m[0].length, text: text.slice(m.index, m.index + m[0].length) });
    }
  }
  raw.sort((a, b) => a.start - b.start || b.end - a.end);
  const hits: TermHit[] = [];
  let maxEnd = -1;
  for (const h of raw) {
    if (h.end <= maxEnd) continue; // целиком внутри предыдущего, более длинного
    hits.push(h);
    maxEnd = h.end;
  }
  return hits;
}

export interface HasBankTermsOptions {
  /** Сколько вхождений достаточно, чтобы считать акт «банковским». По умолчанию 3. */
  threshold?: number;
}

export interface HasBankTermsResult {
  has: boolean;
  /** Число вхождений (без вложенных дублей). */
  count: number;
  /** Сколько разных терминов встретилось. */
  distinct: number;
}

export function hasBankTerms(text: string, opts: HasBankTermsOptions = {}): HasBankTermsResult {
  const threshold = opts.threshold ?? 3;
  const hits = findTerms(text);
  return { has: hits.length >= threshold, count: hits.length, distinct: new Set(hits.map((h) => h.term)).size };
}

export interface Fragment {
  /** Смещение начала фрагмента в исходном тексте. */
  start: number;
  end: number;
  text: string;
  /** Сколько вхождений терминов внутри (0 — для заголовка, если в нём терминов нет). */
  termCount: number;
}

export interface ExtractOptions {
  /** Общий лимит знаков во всех фрагментах. По умолчанию 12 000 (≈3 тыс. токенов). */
  maxChars?: number;
  /** Сколько знаков брать вокруг вхождения с каждой стороны. По умолчанию 400. */
  context?: number;
  /** Длина заголовка акта в начале. По умолчанию 500. */
  titleChars?: number;
}

export interface ExtractResult {
  fragments: Fragment[];
  /** Всего вхождений терминов в акте (не только вошедших во фрагменты). */
  termCount: number;
  /** true, если часть вхождений не поместилась в лимит. */
  truncated: boolean;
}

/** Самый длинный кусок, который можно взять целиком: крупные слитые окна режутся, чтобы выбирать плотные места. */
const PIECE = 3000;

/** Сдвигает границу к ближайшему пробелу (не дальше 40 знаков), чтобы не рвать слова. */
function snapStart(text: string, i: number): number {
  if (i <= 0) return 0;
  for (let k = i; k < Math.min(text.length, i + 40); k++) if (/\s/.test(text[k])) return k + 1;
  return i;
}
function snapEnd(text: string, i: number): number {
  if (i >= text.length) return text.length;
  for (let k = i; k > Math.max(0, i - 40); k--) if (/\s/.test(text[k])) return k;
  return i;
}

interface Win {
  start: number;
  end: number;
  hits: number;
}

export function extractFragments(text: string, opts: ExtractOptions = {}): ExtractResult {
  const maxChars = opts.maxChars ?? 12_000;
  const ctx = opts.context ?? 400;
  const titleChars = opts.titleChars ?? 500;
  const hits = findTerms(text);

  // Заголовок: первые titleChars знаков, но не дальше конца третьей строки.
  let titleEnd = Math.min(text.length, titleChars);
  const nl = [...text.slice(0, titleEnd).matchAll(/\n/g)];
  if (nl.length >= 3) titleEnd = nl[2].index!;
  titleEnd = snapEnd(text, titleEnd);

  // Окна вокруг вхождений со слиянием перекрытий.
  const merged: Win[] = [];
  for (const h of hits) {
    const s = Math.max(0, h.start - ctx);
    const e = Math.min(text.length, h.end + ctx);
    const last = merged[merged.length - 1];
    if (last && s <= last.end) {
      last.end = Math.max(last.end, e);
      last.hits++;
    } else merged.push({ start: s, end: e, hits: 1 });
  }

  // Крупные окна режутся на куски ≤ PIECE; число вхождений считается по реальным позициям.
  const pieces: Win[] = [];
  for (const w of merged) {
    for (let s = w.start; s < w.end; s += PIECE) {
      const e = Math.min(w.end, s + PIECE);
      pieces.push({ start: s, end: e, hits: hits.filter((h) => h.start >= s && h.start < e).length });
    }
  }

  // Заголовок занимает место всегда; остаток отдаётся самым плотным кускам.
  const budget = maxChars - titleEnd;
  const chosen: Win[] = [];
  let used = 0;
  let truncated = false;
  const byDensity = pieces
    .filter((p) => p.start >= titleEnd || p.end > titleEnd)
    .map((p) => ({ ...p, start: Math.max(p.start, titleEnd) }))
    .filter((p) => p.end > p.start)
    .sort((a, b) => b.hits / (b.end - b.start) - a.hits / (a.end - a.start) || a.start - b.start);
  for (const p of byDensity) {
    const len = p.end - p.start;
    if (used + len <= budget) {
      chosen.push(p);
      used += len;
    } else {
      truncated = true;
      const room = budget - used;
      if (room >= 500) {
        chosen.push({ ...p, end: p.start + room });
        used += room;
      }
    }
  }
  chosen.sort((a, b) => a.start - b.start);

  // Заголовок + выбранные куски, склейка соседних.
  const spans: Win[] = [{ start: 0, end: titleEnd, hits: 0 }, ...chosen];
  const out: Win[] = [];
  for (const w of spans) {
    const last = out[out.length - 1];
    if (last && w.start <= last.end + 1) {
      last.end = Math.max(last.end, w.end);
    } else out.push({ ...w });
  }
  const fragments: Fragment[] = out.map((w, i) => {
    const start = i === 0 ? 0 : snapStart(text, w.start);
    const end = w.end >= text.length ? text.length : snapEnd(text, w.end);
    return { start, end, text: text.slice(start, end), termCount: hits.filter((h) => h.start >= start && h.start < end).length };
  });
  return { fragments, termCount: hits.length, truncated };
}
