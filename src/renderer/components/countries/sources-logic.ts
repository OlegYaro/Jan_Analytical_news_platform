// Чистая логика проверки источников: без React и DOM.
import type { SourcesStatusDto, WatchedActType } from '../../../shared/sources-types.ts';
import type { Country, Source, SourceState, SourceType } from '../../../shared/types.ts';
import { tc } from '../../strings-countries.ts';
import { ts } from '../../strings-sources.ts';
import { L } from '../../i18n.ts';
import { countryHealth } from './logic.ts';

export interface StateCounts {
  ok: number;
  warn: number;
  fail: number;
  unchecked: number;
}

/** Сколько включённых источников в каждом состоянии. */
export function countStates(sources: readonly Source[]): StateCounts {
  const c: StateCounts = { ok: 0, warn: 0, fail: 0, unchecked: 0 };
  for (const s of sources) if (s.enabled) c[s.state] += 1;
  return c;
}

/** «✅ 2 · ⚠ 1 · ❌ 1 · не проверено: 1» — только ненулевые части. */
export function sourcesSummaryText(sources: readonly Source[]): string {
  const c = countStates(sources);
  const parts: string[] = [];
  if (c.ok) parts.push(`✅ ${c.ok}`);
  if (c.warn) parts.push(`⚠ ${c.warn}`);
  if (c.fail) parts.push(`❌ ${c.fail}`);
  if (c.unchecked) parts.push(ts.unchecked(c.unchecked));
  return parts.length ? parts.join(' · ') : ts.noEnabledSources;
}

/** Есть ли включённые источники в состоянии ❌. */
export function hasFailedSources(sources: readonly Source[]): boolean {
  return sources.some((s) => s.enabled && s.state === 'fail');
}

/** Самая поздняя дата проверки страны: по источникам и по последнему прогону. */
export function lastCheckIso(c: Pick<Country, 'sources' | 'lastCheckedAt'>): string | null {
  let best: string | null = null;
  let bestT = -Infinity;
  for (const iso of [c.lastCheckedAt, ...c.sources.map((s) => s.checkedAt)]) {
    if (!iso) continue;
    const t = new Date(iso).getTime();
    if (!Number.isNaN(t) && t > bestT) {
      best = iso;
      bestT = t;
    }
  }
  return best;
}

/** «23.11 в 10:05» или «ещё не проверялся». */
export function formatCheckedAt(iso: string | null | undefined): string {
  if (!iso) return ts.neverChecked;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return ts.neverChecked;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)} ${L('в', 'at')} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** «Проверяем: <текст>, N из M»; для поиска (один шаг) — просто текст. */
export function progressText(s: Pick<SourcesStatusDto, 'text' | 'done' | 'total'>): string {
  if (!s.text) return '';
  if (s.total <= 1 || /^(Ищем|Searching)/.test(s.text)) return s.text;
  return ts.progress(s.text, Math.min(s.done, s.total), s.total);
}

/** Доля выполненного 0..1. */
export function progressFraction(s: Pick<SourcesStatusDto, 'done' | 'total'>): number {
  if (s.total <= 0) return 0;
  return Math.max(0, Math.min(1, s.done / s.total));
}

/** Название типа источника с пояснением. */
export function sourceTypeHelp(type: SourceType): string {
  return tc.typeHelp[type];
}

export function actTypeLabel(type: WatchedActType | string, ru?: string): string {
  if (ru) return ru;
  return (ts.actTypes as Record<string, string>)[type] ?? type;
}

export function languageLabel(code: string): string {
  return (ts.languages as Record<string, string>)[code.toLowerCase()] ?? code;
}

export interface CountrySummary {
  ok: number;
  warn: number;
  fail: number;
  unchecked: number;
}

/** Сводка по включённым странам: сколько с ✅/⚠/❌ (по худшему источнику) и сколько не проверено. */
export function countriesSummary(countries: readonly Country[]): CountrySummary {
  const r: CountrySummary = { ok: 0, warn: 0, fail: 0, unchecked: 0 };
  for (const c of countries) {
    if (!c.active) continue;
    const h: SourceState = countryHealth(c.sources);
    r[h] += 1;
  }
  return r;
}
