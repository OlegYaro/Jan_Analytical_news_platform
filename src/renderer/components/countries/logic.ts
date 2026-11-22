import { countryDisplayName } from '../../strings-countries.ts';
import { currentLang } from '../../i18n.ts';
import type { CatalogCountry, Source, SourceState, SourceType } from '../../../shared/types.ts';

/** Сводка состояния источников страны — только по включённым источникам. */
export type CountryHealth = SourceState;

export function countryHealth(sources: readonly Source[]): CountryHealth {
  const on = sources.filter((s) => s.enabled);
  if (on.length === 0) return 'unchecked';
  if (on.some((s) => s.state === 'fail')) return 'fail';
  if (on.some((s) => s.state === 'warn')) return 'warn';
  if (on.every((s) => s.state === 'ok')) return 'ok';
  return 'unchecked';
}

/** Флаг-эмодзи из ISO 3166-1 alpha-2 (региональные индикаторы). Для неверного кода — пустая строка. */
export function flagEmoji(code: string): string {
  const c = code.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return '';
  return String.fromCodePoint(...[...c].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
}

/** «23.11» или «—». */
export function formatCheckedDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}`;
}

/** Каталог без уже добавленных стран, с поиском по названию и коду. */
export function filterCatalog(catalog: readonly CatalogCountry[], existingCodes: readonly string[], query: string): CatalogCountry[] {
  const taken = new Set(existingCodes.map((c) => c.toUpperCase()));
  const q = query.trim().toLowerCase();
  return catalog
    .filter((c) => !taken.has(c.code.toUpperCase()))
    .filter((c) => q === '' || c.nameRu.toLowerCase().includes(q) || countryDisplayName(c.code, c.nameRu).toLowerCase().includes(q) || c.code.toLowerCase().includes(q))
    .sort((a, b) => countryDisplayName(a.code, a.nameRu).localeCompare(countryDisplayName(b.code, b.nameRu), currentLang()));
}

/** «uz, ru» → ['uz','ru'] (без пустых и повторов, строчные). */
export function parseLanguages(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(/[,;\s]+/)) {
    const l = part.trim().toLowerCase();
    if (l && !out.includes(l)) out.push(l);
  }
  return out;
}

export const ALL_SOURCE_TYPES: readonly SourceType[] = ['legal_base', 'regulator', 'drafts', 'news'];

/** Типы, которых нет среди источников страны (новости не считаем обязательными). */
export function missingSourceTypes(sources: readonly Source[]): SourceType[] {
  return (['legal_base', 'regulator', 'drafts'] as const).filter((t) => !sources.some((s) => s.type === t));
}

export const ISSUER_MAX_ITEMS = 50;
export const ISSUER_MAX_LEN = 120;

/** Текст поля (по органу в строке) → список: обрезка, без пустых и повторов (без учёта регистра). */
export function parseIssuerLines(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim().replace(/\s+/g, ' ');
    if (t && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out;
}

export function formatIssuerLines(list: readonly string[]): string {
  return list.join('\n');
}

export interface IssuerRulesText {
  class1: string;
  class2: string;
}

/** Проверка полей; ошибки по-русски (в той же форме, что и в хранилище). */
export function validateIssuerRules(
  rules: { class1: readonly string[]; class2: readonly string[] },
  msg: { tooMany: (n: number) => string; tooLong: (n: number) => string },
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const k of ['class1', 'class2'] as const) {
    if (rules[k].length > ISSUER_MAX_ITEMS) errors[k] = msg.tooMany(ISSUER_MAX_ITEMS);
    else if (rules[k].some((x) => x.length > ISSUER_MAX_LEN)) errors[k] = msg.tooLong(ISSUER_MAX_LEN);
  }
  return errors;
}

/** Совпадают ли два набора правил (порядок и регистр учитываются). */
export function sameIssuerRules(a: { class1: readonly string[]; class2: readonly string[] }, b: { class1: readonly string[]; class2: readonly string[] }): boolean {
  return JSON.stringify([a.class1, a.class2]) === JSON.stringify([b.class1, b.class2]);
}
