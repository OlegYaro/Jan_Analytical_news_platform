// Экран по тексту (SCR-01…SCR-04): чистая логика решений. Модель и сеть — в executors.ts, порядок — в orchestrator.ts.
//
// Идея: между отбором по заголовку и дорогим разбором стоит дешёвый экран. Код готовит текст (снимок, банковские
// слова, фрагменты) и отсекает очевидный шум; дешёвая модель судит по фрагментам; всё сомнительное и все «нет» у
// финансовых и общих органов перепроверяет модель не слабее sonnet. Ничего не отбрасывается молча.
import { normalizeForQuote, quoteInTexts } from '../checks/evidence.ts';
import type { Candidate } from '../../shared/pipeline-types.ts';
import type { ScreenFinal } from '../../shared/run-types.ts';
import type { ScreenDecision, ScreenOutput } from '../../shared/schema-types.ts';

/** Сколько кандидатов в одном вызове модели. */
export const SCREEN_BATCH = 5;
/** Класс 3 (прочие органы) без стольких банковских терминов в тексте — шум (SCR-01). */
export const MIN_TERMS_CLASS3 = 3;
/** Сколько знаков начала текста видит модель, если банковских терминов в акте нет совсем. */
export const BLIND_HEAD_CHARS = 2500;
/** Текст короче этого (знаков, без заголовка) считается отсутствующим: анализ вслепую бессмысленен (SCR-04). */
export const MIN_TEXT_CHARS = 400;

/** Что код подготовил по кандидату (снимок, текст, термины). */
export interface ScreenPrep {
  /** Тела акта достаточно для суждения. */
  hasText: boolean;
  textSource: 'html' | 'pdf' | 'none';
  /** Банковских терминов во всём тексте. */
  termCount: number;
  /** Заголовок и фрагменты вокруг терминов (то, что увидит модель). */
  fragments: string[];
  /** Если текста нет: почему (по-русски). */
  message?: string;
}

export type Route =
  | { kind: 'no_text'; reason: string }
  | { kind: 'drop'; reason: string }
  | { kind: 'ask' };

/**
 * Решение кода до модели. `prep` null — снимок не получился (сайт не открылся).
 * Класс 3 без банковских терминов — шум; нет текста — «не удалось проверить»; остальное — к модели.
 */
export function routeCandidate(cand: Pick<Candidate, 'issuerClass'>, prep: ScreenPrep | null, failMessage?: string): Route {
  if (!prep) return { kind: 'no_text', reason: failMessage ?? 'страница акта не открылась' };
  if (!prep.hasText) return { kind: 'no_text', reason: prep.message ?? 'текста акта на сайте нет (возможно, только PDF-скан)' };
  const cls = cand.issuerClass ?? 2;
  if (cls === 3 && prep.termCount < MIN_TERMS_CLASS3) {
    return { kind: 'drop', reason: `орган не из финансовых, банковских терминов в тексте ${prep.termCount} (нужно ≥ ${MIN_TERMS_CLASS3})` };
  }
  return { kind: 'ask' };
}

/** Доля слов цитаты, которые должны найтись во фрагментах, если точного совпадения нет (модель могла ошибиться в окончании). */
export const FUZZY_QUOTE_SHARE = 0.9;

/**
 * Цитата «почти дословная»: ≥ 90 % слов (от 3 букв) находятся во фрагментах по первым 5 буквам. Спасает верное решение
 * от понижения из-за опечатки в окончании («импорти» вместо «импортига»), но выдуманную цитату не пропускает.
 */
export function quoteMostlyIn(quote: string, texts: readonly string[]): boolean {
  const words = normalizeForQuote(quote).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3);
  if (words.length < 3) return false;
  const have = new Set(
    normalizeForQuote(texts.join(' '))
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 3)
      .map((w) => w.slice(0, 5)),
  );
  const hit = words.filter((w) => have.has(w.slice(0, 5))).length;
  return hit / words.length >= FUZZY_QUOTE_SHARE;
}

/** Решение модели после проверки кодом (полнота id и дословность цитаты). */
export interface Decided {
  id: string;
  decision: ScreenDecision;
  points: string[];
  quote: string;
  reason: string;
  confidence: 'high' | 'medium' | 'low';
  /** Код понизил решение до `unsure` и объясняет почему. */
  downgraded?: string;
}

/**
 * Приводит ответ модели к одному решению на каждый запрошенный id.
 * Нет в ответе — `unsure`; цитата не найдена во фрагментах — `unsure` (решение без проверяемого основания не верим);
 * лишние id отбрасываются.
 */
export function normalizeScreenOutput(ids: readonly string[], out: ScreenOutput | undefined, fragmentsById: ReadonlyMap<string, readonly string[]>): Decided[] {
  const byId = new Map<string, ScreenOutput['items'][number]>();
  for (const it of out?.items ?? []) if (!byId.has(it.id)) byId.set(it.id, it);
  return ids.map((id): Decided => {
    const it = byId.get(id);
    if (!it) return { id, decision: 'unsure', points: [], quote: '', reason: 'модель не вернула решение', confidence: 'low', downgraded: 'нет в ответе' };
    const frags = [...(fragmentsById.get(id) ?? [])];
    const base: Decided = { id, decision: it.decision, points: it.points ?? [], quote: it.quote ?? '', reason: it.reason ?? '', confidence: it.confidence };
    if (it.decision !== 'unsure' && !(it.quote && (quoteInTexts(it.quote, frags) || quoteMostlyIn(it.quote, frags)))) {
      return { ...base, decision: 'unsure', downgraded: it.quote ? 'цитата не найдена во фрагментах' : 'нет цитаты' };
    }
    return base;
  });
}

export type NextStep = { kind: 'final'; final: ScreenFinal } | { kind: 'confirm' };

/**
 * Что делать после первого решения. «Нет» у финансовых и общих органов и любое «не уверен» идут на перепроверку;
 * у прочих органов «нет» окончательно.
 */
export function afterScreen(cand: Pick<Candidate, 'issuerClass'>, d: Decided): NextStep {
  const cls = cand.issuerClass ?? 2;
  switch (d.decision) {
    case 'material':
      return { kind: 'final', final: 'material' };
    case 'minor':
      return { kind: 'final', final: 'minor' };
    case 'none':
      return cls === 3 ? { kind: 'final', final: 'dropped' } : { kind: 'confirm' };
    default:
      return { kind: 'confirm' };
  }
}

/** Итог перепроверки: сомнение идёт дальше на полный разбор (SCR-03). */
export function afterConfirm(d: Decided): ScreenFinal {
  switch (d.decision) {
    case 'minor':
      return 'minor';
    case 'none':
      return 'dropped';
    default:
      return 'material';
  }
}
