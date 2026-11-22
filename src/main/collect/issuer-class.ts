// Класс органа-издателя (SCR): решает, насколько внимательно смотреть на акт ДО дорогого анализа.
//   1 — финансовые регуляторы (ЦБ, рынок капитала, страхование): акт идёт дальше всегда;
//   2 — общие законодатели (законы, Президент, Кабмин) и неопознанный орган: смотрим текст на банковские термины;
//   3 — прочие органы (налоговый комитет, Минздрав, Минцифры…): без банковских терминов в тексте — шум.
// Правила — данные страны (countries.json → issuerClasses), по умолчанию — DEFAULT_ISSUER_RULES.
import type { Country } from '../../shared/types.ts';
import { normalizeText } from '../checks/bank-terms.ts';

export type IssuerClass = 1 | 2 | 3;

export interface IssuerClassRules {
  /** Подстроки названия органа (без учёта регистра и апострофов): орган — финансовый регулятор. */
  class1: string[];
  /**
   * Названия «общих» органов целиком (после отбрасывания «Республики Узбекистан» и т.п.): законодатель,
   * Президент, Кабинет Министров. Всё остальное при наличии правил — класс 3.
   */
  class2: string[];
}

/** Стартовые правила. Для стран без правил класс всегда 2 (дороже, но ничего не теряется). */
export const DEFAULT_ISSUER_RULES: Record<string, IssuerClassRules> = {
  UZ: {
    class1: [
      'центрального банка',
      'markaziy bank',
      'центральный банк',
      'перспективных проектов',
      'istiqbolli loyihalar',
      'рынку капитала',
      'рынка капитала',
      'kapital bozori',
      'страхов',
      'sugurta',
    ],
    class2: [
      'закон',
      'qonun',
      'президента',
      'prezidenti',
      'prezident',
      'кабинета министров',
      'vazirlar mahkamasi',
      'vazirlar mahkamasining',
    ],
  },
};

/** Общие слова, которые не отличают орган: «Республики Узбекистан», «Oʻzbekiston Respublikasi(ning)». */
const GENERIC = [/республики\s+узбекистан/g, /o'?zbekiston\s+respublikasi(?:ning)?/g];

const norm = (s: string): string => normalizeText(s).replace(/'/g, '').replace(/\s+/g, ' ').trim();

function stripGeneric(s: string): string {
  let out = norm(s);
  for (const re of GENERIC) out = out.replace(new RegExp(re.source.replace("'?", ''), re.flags), ' ');
  return out.replace(/[«»"“”]/g, '').replace(/\s+/g, ' ').trim();
}

function classifyOne(rules: IssuerClassRules, part: string): IssuerClass {
  const full = norm(part);
  if (rules.class1.some((p) => full.includes(norm(p)))) return 1;
  const rest = stripGeneric(part);
  if (rest === '' || rules.class2.some((p) => rest === norm(p))) return 2;
  return 3;
}

/**
 * Класс акта по органу и виду акта. Орган из нескольких (через запятую) — по самому «важному»; пустой орган
 * и страна без правил — класс 2; «Закон» по виду акта — класс 2.
 */
export function classifyIssuer(rules: IssuerClassRules | undefined, issuer: string, docType = ''): IssuerClass {
  if (!rules) return 2;
  const dt = norm(docType);
  const parts = issuer.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return 2;
  let best: IssuerClass = 3;
  for (const p of parts) {
    const c = classifyOne(rules, p);
    if (c < best) best = c;
  }
  if (best === 3 && rules.class2.some((p) => dt === norm(p))) return 2;
  return best;
}

/** Правила страны: свои (countries.json) или стартовые; нет ни тех ни других — undefined (всё класс 2). */
export function issuerRulesFor(country: Pick<Country, 'code' | 'issuerClasses'>): IssuerClassRules | undefined {
  return country.issuerClasses ?? DEFAULT_ISSUER_RULES[country.code];
}
