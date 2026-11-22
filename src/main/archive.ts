// Архив прогонов (ARC-01/02): пути по docs/02 §5, лог страны, индекс для «Истории».
import { appendFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { RunMode } from '../shared/run-types.ts';
import { loadRun } from './runner/run-state.ts';

export const runDir = (workspace: string, runId: string): string => join(workspace, 'runs', runId);
export const countryDir = (workspace: string, runId: string, code: string): string =>
  join(runDir(workspace, runId), code);

/** Безопасный для файловой системы id акта: только `[A-Za-z0-9._-]`. */
export function safeActId(actId: string): string {
  const s = actId.replace(/[^A-Za-z0-9._-]/g, '_');
  return /^\.+$/.test(s) ? s.replace(/\./g, '_') : s;
}

export const actDir = (workspace: string, runId: string, code: string, actId: string): string =>
  join(countryDir(workspace, runId, code), 'acts', safeActId(actId));

export function runPaths(dir: string) {
  return {
    runJson: join(dir, 'run.json'),
    digestEn: join(dir, 'digest.en.md'),
    digestRu: join(dir, 'digest.ru.md'),
    email: join(dir, 'email'),
    outbox: join(dir, 'email', 'outbox.json'),
  };
}

export function countryPaths(cdir: string) {
  return {
    candidates: join(cdir, 'candidates.json'),
    news: join(cdir, 'news.json'),
    triage: join(cdir, 'triage.json'),
    verification: join(cdir, 'verification.json'),
    reportEn: join(cdir, 'report.en.md'),
    reportRu: join(cdir, 'report.ru.md'),
    log: join(cdir, 'log.jsonl'),
    acts: join(cdir, 'acts'),
  };
}

export function actPaths(adir: string) {
  return {
    input: join(adir, 'input.json'),
    snapshotHtml: join(adir, 'snapshot.html'),
    snapshotTxt: join(adir, 'snapshot.txt'),
    card: join(adir, 'card.json'),
    evidenceCheck: join(adir, 'evidence-check.json'),
    transcript: join(adir, 'transcript.jsonl'),
  };
}

/** Дописывает одну JSON-строку в log.jsonl страны (папка создаётся при необходимости). */
export function appendLog(cdir: string, record: Record<string, unknown>): void {
  mkdirSync(cdir, { recursive: true });
  appendFileSync(countryPaths(cdir).log, JSON.stringify(record) + '\n', 'utf8');
}

export interface RunIndexEntry {
  id: string;
  /** Дата начала (ISO) из run.json; для битого файла — null. */
  date: string | null;
  mode: RunMode | null;
  finished: boolean;
  /** Итог: сколько стран с каждым статусом. */
  summary: { changes: number; no_changes: number; failed: number; pending: number };
  broken: boolean;
}

/** Индекс прогонов для «Истории», новые сверху. Битый run.json не роняет список. */
export function listRuns(workspace: string): RunIndexEntry[] {
  let names: string[];
  try {
    names = readdirSync(join(workspace, 'runs'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  const out: RunIndexEntry[] = [];
  for (const id of names) {
    const summary = { changes: 0, no_changes: 0, failed: 0, pending: 0 };
    try {
      const s = loadRun(runDir(workspace, id));
      for (const c of Object.values(s.countries)) {
        if (c.status === 'changes') summary.changes++;
        else if (c.status === 'no_changes') summary.no_changes++;
        else if (c.status.startsWith('failed')) summary.failed++;
        else summary.pending++;
      }
      out.push({ id, date: s.started_at, mode: s.mode, finished: !!s.finished_at, summary, broken: false });
    } catch {
      out.push({ id, date: null, mode: null, finished: false, summary, broken: true });
    }
  }
  return out.sort((a, b) => (a.date && b.date ? b.date.localeCompare(a.date) : b.id.localeCompare(a.id)));
}
