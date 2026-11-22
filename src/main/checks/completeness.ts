// Проверка полноты triage (HAL-04): каждый кандидат ровно один раз, irrelevant ⇒ reason_code.

export interface TriageItemLite {
  id: string;
  decision: string;
  reason_code: string | null;
}

export interface CompletenessResult {
  ok: boolean;
  missing: string[];
  extra: string[];
  duplicates: string[];
  invalidIrrelevant: string[];
}

export function checkCompleteness(candidateIds: string[], items: TriageItemLite[]): CompletenessResult {
  const cand = new Set(candidateIds);
  const seen = new Set<string>();
  const dup = new Set<string>();
  const extra = new Set<string>();
  const invalid: string[] = [];
  for (const it of items) {
    if (seen.has(it.id)) dup.add(it.id);
    seen.add(it.id);
    if (!cand.has(it.id)) extra.add(it.id);
    if (it.decision === 'irrelevant' && it.reason_code == null && !invalid.includes(it.id)) invalid.push(it.id);
  }
  const missing = [...cand].filter((id) => !seen.has(id));
  const duplicates = [...dup];
  return {
    ok: !missing.length && !extra.size && !duplicates.length && !invalid.length,
    missing,
    extra: [...extra],
    duplicates,
    invalidIrrelevant: invalid,
  };
}

/** Кандидаты = отобранные + отброшенные с причиной. */
export function accountingTotals(candidateIds: string[], items: TriageItemLite[]) {
  const ids = new Set(candidateIds);
  const uniq = new Map<string, TriageItemLite>();
  for (const it of items) if (ids.has(it.id) && !uniq.has(it.id)) uniq.set(it.id, it);
  let selected = 0;
  let discarded = 0;
  for (const it of uniq.values()) {
    if (it.decision !== 'irrelevant') selected++;
    else if (it.reason_code != null) discarded++;
  }
  return { candidates: ids.size, selected, discarded, balanced: ids.size === selected + discarded };
}

/** Текст причины для `failed:completeness`; null, если всё в порядке. */
export function completenessFailure(r: CompletenessResult): string | null {
  if (r.ok) return null;
  const parts: string[] = [];
  if (r.missing.length) parts.push(`потеряны кандидаты: ${r.missing.join(', ')}`);
  if (r.duplicates.length) parts.push(`повторные записи: ${r.duplicates.join(', ')}`);
  if (r.extra.length) parts.push(`лишние id: ${r.extra.join(', ')}`);
  if (r.invalidIrrelevant.length) parts.push(`отброшено без причины: ${r.invalidIrrelevant.join(', ')}`);
  return `Отбор вернул неполный ответ (${parts.join('; ')})`;
}
