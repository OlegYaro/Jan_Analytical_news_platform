// Аномалия источника (COV-05): 0 документов там, где обычно они есть → failed:parser.
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { RunMode } from '../../shared/run-types.ts';
import { writeJsonAtomic } from '../fs-atomic.ts';
import { shouldWriteLedger } from '../ledger.ts';

export interface HistoryPoint {
  date: string;
  count: number;
}
export type SourceHealth = Record<string, HistoryPoint[]>;

export const MEDIAN_RUNS = 8;
export const MIN_WINDOW_DAYS = 7;
export const MIN_POINTS = 3;
export const MAX_HISTORY = 16;

const DAY = 86_400_000;

export function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export interface AnomalyResult {
  anomaly: boolean;
  status?: 'failed:parser';
  median: number;
  windowDays: number;
}

/**
 * Аномалия: сейчас 0, медиана последних 8 прогонов > 0, история охватывает ≥ 7 дней
 * (и не меньше MIN_POINTS записей, чтобы одна запись не считалась «обычно»).
 */
export function detectAnomaly(history: HistoryPoint[], now: Date, current: number): AnomalyResult {
  const last = [...history].sort((a, b) => a.date.localeCompare(b.date)).slice(-MEDIAN_RUNS);
  const med = median(last.map((h) => h.count));
  const first = last.length ? Date.parse(last[0]!.date) : NaN;
  const windowDays = Number.isNaN(first) ? 0 : Math.floor((now.getTime() - first) / DAY);
  const anomaly = current === 0 && med > 0 && last.length >= MIN_POINTS && windowDays >= MIN_WINDOW_DAYS;
  return anomaly ? { anomaly, status: 'failed:parser', median: med, windowDays } : { anomaly, median: med, windowDays };
}

export const sourceHealthFile = (workspaceDir: string): string => join(workspaceDir, 'state', 'source-health.json');

export function loadSourceHealth(workspaceDir: string): SourceHealth {
  const file = sourceHealthFile(workspaceDir);
  if (!existsSync(file)) return {};
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('не объект');
    return raw as SourceHealth;
  } catch {
    try {
      renameSync(file, file + '.bak');
    } catch {
      /* нечего переименовывать */
    }
    return {};
  }
}

export function saveSourceHealth(workspaceDir: string, health: SourceHealth): void {
  writeJsonAtomic(sourceHealthFile(workspaceDir), health);
}

/** Добавляет число документов источника в историю (хвост до MAX_HISTORY). dry_run/backfill не пишут. */
export function recordSourceCount(
  workspaceDir: string,
  sourceId: string,
  count: number,
  now: Date,
  mode: RunMode,
): boolean {
  if (!shouldWriteLedger(mode)) return false;
  const health = loadSourceHealth(workspaceDir);
  health[sourceId] = [...(health[sourceId] ?? []), { date: now.toISOString(), count }].slice(-MAX_HISTORY);
  saveSourceHealth(workspaceDir, health);
  return true;
}
