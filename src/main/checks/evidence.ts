// Проверка доказательств карточки (HAL-02, HAL-03; docs/04-schemas.md §3, блок «evidence-check.json»).
// 1) каждая цитата дословно (после нормализации) есть в снимке акта или в связанных снимках;
// 2) дата значения (день, месяц, год) встречается среди дат цитаты;
// 3) номер/число значения встречается в цитате отдельным токеном.
// Модель здесь не участвует: всё решает код.
import type { Card } from '../../shared/schema-types.ts';

// ───────────────────────────── Нормализация ─────────────────────────────

/** Мягкий перенос и символы нулевой ширины — удаляются. */
const INVISIBLE = /[­​‌‍⁠﻿]/g;
/** Апострофы и похожие знаки: ʼ ' ’ ‘ ʻ ` ´ ‛ ′ → '. */
const APOSTROPHES = /[ʼ'’‘ʻ`´‛′]/g;
/** Кавычки: « » “ ” „ ‟ → ". */
const QUOTES = /[«»“”„‟]/g;
/** Дефисы и тире: ‐ ‑ ‒ – — ― − → -. */
const DASHES = /[‐‑‒–—―−]/g;

/**
 * Нормализация текста для сравнения цитат (HAL-02). Диакритика и буквы национальных алфавитов
 * (oʻ, ў, қ, ғ, ҳ, ә, ө, ү, ı, ş, ç, ...) сохраняются; меняется только регистр.
 * Турецко-азербайджанская İ приводится к i (иначе toLowerCase даёт i + U+0307).
 */
export function normalizeForQuote(s: string): string {
  return s
    .normalize('NFC')
    .replace(INVISIBLE, '')
    .replace(APOSTROPHES, "'")
    .replace(QUOTES, '"')
    .replace(DASHES, '-')
    .replace(/İ/g, 'i')
    .toLowerCase()
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Нормализованная цитата дословно входит хотя бы в один нормализованный текст. Пустая цитата — false. */
export function quoteInTexts(quote: string, texts: string[]): boolean {
  return quoteInNormalized(normalizeForQuote(quote), texts.map(normalizeForQuote));
}

function quoteInNormalized(normQuote: string, normTexts: string[]): boolean {
  if (!normQuote) return false;
  return normTexts.some((t) => t.includes(normQuote));
}

// ───────────────────────────── Словари месяцев ─────────────────────────────

/**
 * Названия месяцев по языкам (в нижнем регистре): индекс 0 = январь. Сопоставление идёт по
 * началу слова (форма — префикс слова), поэтому падежные и аффиксальные формы покрываются
 * основой: «sentabr» → «sentabrdagi», «январ» → «января», «қыркүйек» → «қыркүйектегі»,
 * «სექტემბ» → «სექტემბრის», «սեպտեմբեր» → «սեպտեմբերի».
 * Если форма не распознана, дата просто не находится — проверка даёт ❌ (безопасная сторона).
 */
export const MONTH_NAMES: Readonly<Record<string, ReadonlyArray<readonly string[]>>> = {
  en: [
    ['january', 'jan'], ['february', 'feb'], ['march', 'mar'], ['april', 'apr'], ['may'], ['june', 'jun'],
    ['july', 'jul'], ['august', 'aug'], ['september', 'sept', 'sep'], ['october', 'oct'], ['november', 'nov'],
    ['december', 'dec'],
  ],
  // Русский: основы покрывают «января/январь/январе», «мая/май/мае».
  ru: [
    ['январ'], ['феврал'], ['март'], ['апрел'], ['май', 'мая', 'мае'], ['июн'], ['июл'], ['август'],
    ['сентябр'], ['октябр'], ['ноябр'], ['декабр'],
  ],
  // Узбекский: латиница и кириллица (в т.ч. «yanvar», «январ», «sentabr»/«sentyabr»).
  uz: [
    ['yanvar', 'январ'], ['fevral', 'феврал'], ['mart', 'март'], ['aprel', 'апрел'], ['may', 'май'],
    ['iyun', 'июн'], ['iyul', 'июл'], ['avgust', 'август'], ['sentabr', 'sentyabr', 'сентябр', 'сентабр'],
    ['oktabr', 'oktyabr', 'октябр', 'октабр'], ['noyabr', 'ноябр'], ['dekabr', 'декабр'],
  ],
  // Казахский.
  kk: [
    ['қаңтар'], ['ақпан'], ['наурыз'], ['сәуір'], ['мамыр'], ['маусым'], ['шілде'], ['тамыз'], ['қыркүйек'],
    ['қазан'], ['қараша'], ['желтоқсан'],
  ],
  // Азербайджанский.
  az: [
    ['yanvar'], ['fevral'], ['mart'], ['aprel'], ['may'], ['iyun'], ['iyul'], ['avqust'], ['sentyabr'],
    ['oktyabr'], ['noyabr'], ['dekabr'],
  ],
  // Кыргызский — неполный словарь: только русские по происхождению названия (январь, «сентябры» и т.п.);
  // исконные названия («үчтүн айы», «бирдин айы», ...) не распознаются.
  ky: [
    ['январ'], ['феврал'], ['март'], ['апрел'], ['май'], ['июн'], ['июл'], ['август'], ['сентябр'],
    ['октябр'], ['ноябр'], ['декабр'],
  ],
  // Таджикский — неполный словарь: русские по происхождению названия («январ», «сентябри»).
  tg: [
    ['январ'], ['феврал'], ['март'], ['апрел'], ['май'], ['июн'], ['июл'], ['август'], ['сентябр'],
    ['октябр'], ['ноябр'], ['декабр'],
  ],
  // Туркменский — неполный словарь: современные латинские названия («ýanwar», «sentýabr»).
  tk: [
    ['ýanwar'], ['fewral'], ['mart'], ['aprel'], ['maý'], ['iýun'], ['iýul'], ['awgust'], ['sentýabr'],
    ['oktýabr'], ['noýabr'], ['dekabr'],
  ],
  // Грузинский — неполный словарь: именительный и родительный падеж (იანვარი / იანვრის).
  ka: [
    ['იანვარ', 'იანვრ'], ['თებერვალ', 'თებერვლ'], ['მარტ'], ['აპრილ'], ['მაის'], ['ივნის'], ['ივლის'],
    ['აგვისტო'], ['სექტემბერ', 'სექტემბრ'], ['ოქტომბერ', 'ოქტომბრ'], ['ნოემბერ', 'ნოემბრ'],
    ['დეკემბერ', 'დეკემბრ'],
  ],
  // Армянский — неполный словарь: именительный падеж и формы с окончанием (-ի).
  hy: [
    ['հունվար'], ['փետրվար'], ['մարտ'], ['ապրիլ'], ['մայիս'], ['հունիս'], ['հուլիս'], ['օգոստոս'],
    ['սեպտեմբեր'], ['հոկտեմբեր'], ['նոյեմբեր'], ['դեկտեմբեր'],
  ],
  // Монгольский: порядковые названия «N-дүгээр/дугаар сар»; разбираются отдельным шаблоном (см. MN_*).
  mn: [
    ['нэгдүгээр сар'], ['хоёрдугаар сар'], ['гуравдугаар сар'], ['дөрөвдүгээр сар'], ['тавдугаар сар'],
    ['зургадугаар сар'], ['долдугаар сар'], ['наймдугаар сар'], ['есдүгээр сар'], ['аравдугаар сар'],
    ['арван нэгдүгээр сар'], ['арван хоёрдугаар сар'],
  ],
};

/** Основа → номер месяца (1–12), для всех языков, кроме mn (у него отдельный шаблон). */
const STEM_TO_MONTH: Map<string, number> = (() => {
  const m = new Map<string, number>();
  for (const [lang, months] of Object.entries(MONTH_NAMES)) {
    if (lang === 'mn') continue;
    months.forEach((forms, i) => {
      for (const f of forms) {
        const prev = m.get(f);
        if (prev !== undefined && prev !== i + 1) throw new Error(`Словарь месяцев: «${f}» указывает на разные месяцы`);
        m.set(f, i + 1);
      }
    });
  }
  return m;
})();

const STEMS_DESC = [...STEM_TO_MONTH.keys()].sort((a, b) => b.length - a.length);

/** Номер месяца по слову (самая длинная подходящая основа) или 0. */
function monthOfWord(word: string): number {
  for (const s of STEMS_DESC) if (word.startsWith(s)) return STEM_TO_MONTH.get(s) ?? 0;
  return 0;
}

// ───────────────────────────── Поиск дат ─────────────────────────────

export interface YMD {
  y: number;
  m: number;
  d: number;
}

export interface DateSpan extends YMD {
  /** Позиция в нормализованном тексте. */
  start: number;
  end: number;
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Слово-месяц: основа + любые буквы (падеж, аффиксы). */
const MON = `(?<![\\p{L}])((?:${STEMS_DESC.map(esc).join('|')})\\p{L}*)`;
/** День: 1–2 цифры и, возможно, порядковый суффикс (13th, 13-го, 17-nji). */
const DAY = `(?<![\\d.,/-])(\\d{1,2})(?!\\d)(?:st|nd|rd|th|-?го|-?nj[iyuü])?`;
/** Год: 4 цифры. */
const YEAR = `(?<![\\d.,/])(\\d{4})(?![\\d/])`;
/**
 * Слово «год» после числа года: uz «yil/yilda/йил», kk/ky «жыл/жылғы/жылдын», tk «-njy ýylyň»,
 * az «-cı il», ru «г./года», ka «წლის/წ.», hy «թվականի/թ.».
 */
const YEAR_WORD =
  `(?:\\s*-?\\s*(?:(?:nj[iyuü]|c[iıuü])\\s+)?` +
  `(?:yil\\p{L}*|йил\\p{L}*|жыл\\p{L}*|ýyl\\p{L}*|y\\.|й\\.|ж\\.|il(?:in|də|de)?(?!\\p{L})|г\\.|года|году|год(?!\\p{L})|г(?!\\p{L})|წლის|წ\\.|թվականի|թ\\.)\\.?)`;

/** D <месяц> [,] [соли] YYYY [год] — ru, uz, kk, az, tg, ka, en «13 January 2027». */
const RE_D_M_Y = new RegExp(`${DAY}[\\s-]*(?:of\\s+)?${MON}[\\s,.-]*(?:соли\\s+)?${YEAR}${YEAR_WORD}?`, 'gu');
/** YYYY <год> D <месяц> — uz «2026-yil 17-sentabr», kk «2026 жылғы 17 қыркүйек», ka «2026 წლის 17 სექტემბერი». */
const RE_Y_D_M = new RegExp(`${YEAR}${YEAR_WORD}[\\s,-]*${DAY}[\\s-]*${MON}`, 'gu');
/** <месяц> D, YYYY — en «January 13, 2027». */
const RE_M_D_Y = new RegExp(`${MON}[\\s.-]*${DAY}[\\s,]+${YEAR}${YEAR_WORD}?`, 'gu');
/** YYYY <год> <месяц> D — hy «2026 թվականի սեպտեմբերի 17». */
const RE_Y_M_D = new RegExp(`${YEAR}${YEAR_WORD}[\\s,-]*${MON}[\\s-]*${DAY}`, 'gu');

/** DD.MM.YYYY (также D.M.YYYY). */
const RE_DMY_NUM = /(?<![\d.])(\d{1,2})\.(\d{1,2})\.(\d{4})(?![\d])/g;
/** YYYY-MM-DD. */
const RE_ISO = /(?<![\d-])(\d{4})-(\d{1,2})-(\d{1,2})(?![\d])/g;
/** YYYY.MM.DD (монгольский числовой формат). */
const RE_YMD_DOT = /(?<![\d.])(\d{4})\.(\d{1,2})\.(\d{1,2})(?![\d])/g;

/** Монгольские порядковые названия месяцев (основа перед «дугаар/дүгээр»). */
const MN_ORDINALS: ReadonlyArray<readonly [string, number]> = [
  ['арван\\s*нэг', 11], ['арван\\s*хоёр', 12], ['нэг', 1], ['хоёр', 2], ['гурав', 3], ['дөрөв', 4],
  ['тав', 5], ['зургаа?', 6], ['дол(?:оо)?', 7], ['найм', 8], ['ес', 9], ['арав', 10],
];
/**
 * mn: «[YYYY оны] (11 дүгээр | 11-р | 11 | арван нэгдүгээр) сар[ын] 17». Год можно опустить — тогда
 * берётся ближайший предыдущий «YYYY оны» из той же цитаты; без года дата не засчитывается.
 */
const RE_MN = new RegExp(
  `(?:${YEAR}\\s*(?:оны|он)\\s*,?\\s*)?` +
    `(?:(?<![\\p{L}\\d])(${MN_ORDINALS.map(([s]) => s).join('|')})\\s*(?:дугаар|дүгээр)` +
    `|(?<![\\d.,/])(\\d{1,2})\\s*(?:-?\\s*р|дугаар|дүгээр)?)` +
    `\\s*сар(?:ын|ийн)?\\s*(\\d{1,2})(?!\\d)(?:\\s*-?\\s*(?:ны|ний|нд|нь))?`,
  'gu',
);
const RE_MN_YEAR = /(?<![\d.,/])(\d{4})\s*(?:оны|он)(?!\p{L})/gu;

function validYmd(y: number, m: number, d: number): boolean {
  if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function mnMonth(ord: string): number {
  const s = ord.replace(/\s+/g, '');
  for (const [re, n] of MN_ORDINALS) if (new RegExp(`^${re.replace('\\s*', '')}$`, 'u').test(s)) return n;
  return 0;
}

/**
 * Все даты в уже нормализованном тексте (результат normalizeForQuote или эквивалент в нижнем
 * регистре) с позициями. Пересекающиеся совпадения разрешаются в пользу более раннего, затем
 * более длинного — одна дата в тексте даёт одну запись.
 */
export function findDateSpans(norm: string): DateSpan[] {
  const found: DateSpan[] = [];
  const push = (y: number, m: number, d: number, start: number, end: number): void => {
    if (validYmd(y, m, d)) found.push({ y, m, d, start, end });
  };
  const each = (re: RegExp, fn: (g: RegExpExecArray) => void): void => {
    re.lastIndex = 0;
    for (let g = re.exec(norm); g; g = re.exec(norm)) {
      fn(g);
      if (g[0].length === 0) re.lastIndex++;
    }
  };
  const end = (g: RegExpExecArray): number => g.index + g[0].length;

  each(RE_DMY_NUM, (g) => push(+g[3], +g[2], +g[1], g.index, end(g)));
  each(RE_ISO, (g) => push(+g[1], +g[2], +g[3], g.index, end(g)));
  each(RE_YMD_DOT, (g) => push(+g[1], +g[2], +g[3], g.index, end(g)));
  each(RE_D_M_Y, (g) => push(+g[3], monthOfWord(g[2]), +g[1], g.index, end(g)));
  each(RE_Y_D_M, (g) => push(+g[1], monthOfWord(g[3]), +g[2], g.index, end(g)));
  each(RE_M_D_Y, (g) => push(+g[3], monthOfWord(g[1]), +g[2], g.index, end(g)));
  each(RE_Y_M_D, (g) => push(+g[1], monthOfWord(g[2]), +g[3], g.index, end(g)));

  const mnYears: Array<{ at: number; y: number }> = [];
  each(RE_MN_YEAR, (g) => mnYears.push({ at: g.index, y: +g[1] }));
  each(RE_MN, (g) => {
    const m = g[2] ? mnMonth(g[2]) : +g[3];
    let y = g[1] ? +g[1] : 0;
    if (!y) {
      const prev = mnYears.filter((p) => p.at < g.index).pop();
      if (prev) y = prev.y;
    }
    if (y) push(y, m, +g[4], g.index, end(g));
  });

  found.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const out: DateSpan[] = [];
  let lastEnd = -1;
  for (const f of found) {
    if (f.start < lastEnd) continue;
    out.push(f);
    lastEnd = f.end;
  }
  return out;
}

/** Все даты в цитате (любые поддерживаемые форматы и языки), без повторов, в порядке появления. */
export function parseDatesFromQuote(quote: string): YMD[] {
  const seen = new Set<string>();
  const out: YMD[] = [];
  for (const { y, m, d } of findDateSpans(normalizeForQuote(quote))) {
    const k = `${y}-${m}-${d}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ y, m, d });
  }
  return out;
}

export function toIso({ y, m, d }: YMD): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// ───────────────────────────── Номера ─────────────────────────────

const ALNUM = /[\p{L}\p{N}]/u;
const DIGIT = /\p{N}/u;
const NUM_SEP = /[/.,\-]/;

/**
 * Номер встречается в нормализованной цитате отдельным токеном: соседние символы — не буквы и не
 * цифры, и номер не продолжается через «/ . , -» + цифру («24/2» ≠ «124/22», «3254» ≠ «3254-2»,
 * «3254» ≠ «10/20/3254/1045»). «24/2-son», «№ 24/2», «3254,» — подходят.
 */
export function hasNumberToken(normText: string, normToken: string): boolean {
  if (!normToken) return false;
  for (let i = normText.indexOf(normToken); i >= 0; i = normText.indexOf(normToken, i + 1)) {
    const j = i + normToken.length;
    const b1 = normText[i - 1] ?? '';
    const b2 = normText[i - 2] ?? '';
    const a1 = normText[j] ?? '';
    const a2 = normText[j + 1] ?? '';
    const beforeOk = !ALNUM.test(b1) && !(NUM_SEP.test(b1) && DIGIT.test(b2));
    const afterOk = !ALNUM.test(a1) && !(NUM_SEP.test(a1) && DIGIT.test(a2));
    if (beforeOk && afterOk) return true;
  }
  return false;
}

// ───────────────────────────── Проверка карточки ─────────────────────────────

export interface EvidenceFieldResult {
  /** Путь поля, напр. "act.effective_date", "changes[3].quote". */
  field: string;
  ok: boolean;
  /** Причина по-русски. */
  reason: string;
}

type FieldKind = 'text' | 'date' | 'number' | 'count';

interface FactLike {
  value: unknown;
  quote: string;
}

/** Все фактические поля карточки, которые проверяются (docs/04 §3). */
const FACT_FIELDS: ReadonlyArray<readonly [string, FieldKind, (c: Card) => FactLike | undefined]> = [
  ['act.type', 'text', (c) => c.act?.type],
  ['act.issuer', 'text', (c) => c.act?.issuer],
  ['act.number', 'number', (c) => c.act?.number],
  ['act.title_original', 'text', (c) => c.act?.title_original],
  ['act.adoption_date', 'date', (c) => c.act?.adoption_date],
  ['act.registration_number', 'number', (c) => c.act?.registration_number],
  ['act.registration_date', 'date', (c) => c.act?.registration_date],
  ['act.publication_date', 'date', (c) => c.act?.publication_date],
  ['act.effective_date', 'date', (c) => c.act?.effective_date],
  ['act.transition_period.exists', 'text', (c) => c.act?.transition_period?.exists],
  ['amends.base_act_title', 'text', (c) => c.amends?.base_act_title],
  ['amends.base_act_number', 'number', (c) => c.amends?.base_act_number],
  ['scope.applies_to', 'text', (c) => c.scope?.applies_to],
  ['scope.not_applies_to', 'text', (c) => c.scope?.not_applies_to],
  ['change_count.annex_items', 'count', (c) => c.change_count?.annex_items],
  ['change_count.legal_base_marks', 'count', (c) => c.change_count?.legal_base_marks],
];

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function checkFact(
  field: string,
  kind: FieldKind,
  fact: FactLike | undefined,
  normTexts: string[],
): EvidenceFieldResult {
  if (!fact || typeof fact !== 'object') return { field, ok: false, reason: 'поле отсутствует в карточке' };
  if (fact.value === 'unknown') return { field, ok: true, reason: 'unknown — не проверяется' };
  const q = normalizeForQuote(typeof fact.quote === 'string' ? fact.quote : '');
  if (!q) return { field, ok: false, reason: 'цитата пуста' };

  const reasons: string[] = [];
  if (!quoteInNormalized(q, normTexts)) reasons.push('цитата не найдена в снимке');

  const value = String(fact.value ?? '');
  if (kind === 'date') {
    const m = ISO_RE.exec(value);
    if (!m || !validYmd(+m[1], +m[2], +m[3])) {
      reasons.push(`значение «${value}» не является датой ГГГГ-ММ-ДД`);
    } else {
      const want = { y: +m[1], m: +m[2], d: +m[3] };
      const has = findDateSpans(q).some((x) => x.y === want.y && x.m === want.m && x.d === want.d);
      if (!has) reasons.push(`в цитате нет даты ${value}`);
    }
  } else if (kind === 'number' || kind === 'count') {
    const label = kind === 'number' ? 'номер' : 'число';
    const token = normalizeForQuote(value);
    if (!token) reasons.push(`${label} пуст`);
    else if (!hasNumberToken(q, token)) {
      reasons.push(kind === 'number' ? `номер ${value} не найден в цитате` : `число ${value} не найдено в цитате`);
    }
  }
  return reasons.length === 0
    ? { field, ok: true, reason: 'подтверждено цитатой' }
    : { field, ok: false, reason: reasons.join('; ') };
}

/**
 * evidence-check карточки: по одному результату на каждое проверенное поле (все Fact-поля из
 * FACT_FIELDS и все `changes[i].quote`). `snapshotTexts` — snapshot.txt и тексты related_snapshots.
 */
export function checkCardEvidence(card: Card, snapshotTexts: string[]): EvidenceFieldResult[] {
  const normTexts = snapshotTexts.map(normalizeForQuote).filter(Boolean);
  const out: EvidenceFieldResult[] = FACT_FIELDS.map(([field, kind, get]) => {
    let fact: FactLike | undefined;
    try {
      fact = get(card);
    } catch {
      fact = undefined;
    }
    return checkFact(field, kind, fact, normTexts);
  });
  const changes = Array.isArray(card.changes) ? card.changes : [];
  changes.forEach((ch, i) => {
    const field = `changes[${i}].quote`;
    const q = normalizeForQuote(typeof ch?.quote === 'string' ? ch.quote : '');
    if (!q) out.push({ field, ok: false, reason: 'цитата пуста' });
    else if (!quoteInNormalized(q, normTexts)) out.push({ field, ok: false, reason: 'цитата не найдена в снимке' });
    else out.push({ field, ok: true, reason: 'цитата найдена в снимке' });
  });
  return out;
}

/** Пути полей, не прошедших проверку. */
export function evidenceFailures(results: EvidenceFieldResult[]): string[] {
  return results.filter((r) => !r.ok).map((r) => r.field);
}

/** Все поля прошли проверку. */
export function evidenceOk(results: EvidenceFieldResult[]): boolean {
  return results.every((r) => r.ok);
}
