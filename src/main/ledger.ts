// Журнал отправленного (TRI-04/05, COL-04): state/ledger/<CC>.json — массив LedgerEntry.
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { ActStage, ISODate, LedgerEntry, RunMode } from '../shared/run-types.ts';
import { writeJsonAtomic } from './fs-atomic.ts';

export const STAGE_ORDER: readonly ActStage[] = ['draft', 'adopted', 'registered', 'published', 'in_force'];

export function ledgerFile(workspaceDir: string, code: string): string {
  return join(workspaceDir, 'state', 'ledger', `${code}.json`);
}

const clean = (v: string | undefined | null): string => {
  const t = (v ?? '').trim();
  return t.toLowerCase() === 'unknown' ? '' : t;
};

/** `reg:<рег.номер>` или `num:<номер>|<дата>|<url>`. Пробелы по краям обрезаются, регистр не меняется. */
export function ledgerKey(a: { registrationNumber?: string; number?: string; date?: string; url?: string }): string {
  const reg = clean(a.registrationNumber);
  if (reg) return `reg:${reg}`;
  return `num:${clean(a.number)}|${clean(a.date)}|${clean(a.url)}`;
}

/** Нужен ли журнал для режима: пробный прогон и добор архива его не пишут. */
export function shouldWriteLedger(mode: RunMode): boolean {
  return mode === 'scheduled' || mode === 'manual';
}

/** Читает журнал; нет файла — пусто; битый — переименовывается в .bak, возвращается пустой. */
export function loadLedger(workspaceDir: string, code: string): LedgerEntry[] {
  const file = ledgerFile(workspaceDir, code);
  if (!existsSync(file)) return [];
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(raw)) throw new Error('не массив');
    return raw as LedgerEntry[];
  } catch {
    try {
      renameSync(file, file + '.bak');
    } catch {
      /* нечего переименовывать */
    }
    return [];
  }
}

export function saveLedger(workspaceDir: string, code: string, entries: LedgerEntry[]): void {
  writeJsonAtomic(ledgerFile(workspaceDir, code), entries);
}

export interface CardLike {
  stage: ActStage;
  effective_date?: string;
}

export type Classification =
  | { kind: 'new' }
  | { kind: 'duplicate' }
  | { kind: 'update'; since: string; reason: 'stage' | 'effective_date' };

const known = (d: string | undefined): d is string => !!d && d.trim() !== '' && d.trim().toLowerCase() !== 'unknown';

/** TRI-05: новая стадия (только вперёд) или смена даты вступления в силу → update; иначе duplicate. */
export function classify(entry: LedgerEntry | null, card: CardLike): Classification {
  if (!entry) return { kind: 'new' };
  const was = STAGE_ORDER.indexOf(entry.last_stage);
  const now = STAGE_ORDER.indexOf(card.stage);
  if (was >= 0 && now >= 0 && now < was) return { kind: 'duplicate' };
  if (now > was) return { kind: 'update', since: entry.first_reported_at, reason: 'stage' };
  if (known(card.effective_date) && card.effective_date !== entry.effective_date) {
    return { kind: 'update', since: entry.first_reported_at, reason: 'effective_date' };
  }
  return { kind: 'duplicate' };
}

export interface SentItem {
  key: string;
  stage: ActStage;
  effective_date: ISODate | 'unknown';
  title_en: string;
}

/**
 * Записывает отправленное. Вызывать ТОЛЬКО после успешной отправки письма.
 * Запись с тем же ключом обновляется (first_reported_at сохраняется), остальные не трогаются.
 */
export function commitSent(
  workspaceDir: string,
  code: string,
  items: SentItem[],
  runId: string,
  now: Date = new Date(),
): LedgerEntry[] {
  const ledger = loadLedger(workspaceDir, code);
  for (const it of items) {
    const i = ledger.findIndex((e) => e.key === it.key);
    const prev = i >= 0 ? ledger[i] : undefined;
    const next: LedgerEntry = {
      key: it.key,
      first_reported_at: prev?.first_reported_at ?? now.toISOString(),
      last_stage: it.stage,
      effective_date: it.effective_date,
      title_en: it.title_en,
      run_id: runId,
    };
    if (i >= 0) ledger[i] = next;
    else ledger.push(next);
  }
  saveLedger(workspaceDir, code, ledger);
  return ledger;
}

/** COL-04: кандидат с ключом из журнала остаётся, только если помечен maybeUpdate. */
export function filterCandidates<T extends { key: string; maybeUpdate?: boolean }>(
  ledger: LedgerEntry[],
  candidates: T[],
): T[] {
  const sent = new Set(ledger.map((e) => e.key));
  return candidates.filter((c) => !sent.has(c.key) || c.maybeUpdate === true);
}
