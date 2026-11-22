// «История» (ARC-03, ARC-04, VER-04): список прогонов и разбор страны из архива рабочей папки.
// Только чтение, без electron. Ничего не выдумывается: каждое поле — из файла прогона; нет файла — пусто.
// Все ошибки чтения мягкие (null / пустой список), исключений наружу нет.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  HistoryCountryDto,
  HistoryDiscardedDto,
  HistoryFindingDto,
  HistoryRunDto,
  HistoryVerificationDto,
} from '../shared/history-types.ts';
import type { Candidate, CandidatesFile, CountryResult } from '../shared/pipeline-types.ts';
import type { CountryStatus, RunState, ScreenRun } from '../shared/run-types.ts';
import type { TriageOutput, Verification } from '../shared/schema-types.ts';
import type { UiLanguage } from '../shared/types.ts';
import { archivePath, isRunId, loadRunSafe, readJsonSafe, readLimited } from './archive-read.ts';
import { falsePositiveIds } from './golden-cases.ts';
import { mt } from './i18n.ts';
import { summarizeEntries } from './mail/outbox.ts';
import type { OutboxEntry } from './mail/outbox.ts';

/** Отчёт страны читается не больше этого (ARC-04); длиннее — обрезается с пометкой. */
export const REPORT_MAX_BYTES = 2 * 1024 * 1024;
/** Журнал страны: читаем только хвост такого размера. */
export const LOG_TAIL_BYTES = 8 * 1024 * 1024;
export const LOG_MAX_LINES = 200;
const LOG_TEXT_MAX = 500;
const SCREEN_TEXT_MAX = 200;

/**
 * Сводные события журнала страны «простыми словами» (поле text — как есть). Шумные (process, candidate,
 * triage_decision, evidence, snapshot…) отбрасываются: они есть в log.jsonl для разбора.
 */
export const LOG_EVENTS: ReadonlySet<string> = new Set([
  'country_start',
  'country_resume',
  'collect_summary',
  'triage_done',
  'screen_decision',
  'act_done',
  'verify_card',
  'returned',
  'result_item',
  'status',
  'paused',
  'stopped',
]);

type MailDto = HistoryRunDto['mail'];
/** Своё правило статуса писем прогона (по умолчанию — state/outbox.json по runId, иначе run.json email). */
export type MailInfo = (runId: string, run: RunState) => MailDto;

const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const statusOf = (v: unknown): CountryStatus => (typeof v === 'string' && v ? (v as CountryStatus) : 'pending');
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Очередь писем без побочных эффектов (loadOutbox переименовывает битый файл — «История» этого делать не должна). */
function readOutboxEntries(workspaceDir: string): OutboxEntry[] {
  const f = readJsonSafe<{ entries?: unknown }>(join(workspaceDir, 'state', 'outbox.json'));
  return arr<OutboxEntry>(f?.entries).filter((e) => !!e && typeof e === 'object' && typeof e.runId === 'string');
}

function mailFromOutbox(entries: OutboxEntry[], run: RunState): MailDto {
  const s = summarizeEntries(entries.filter((e) => e.runId === run.id));
  if (s) return { state: s.state, attempts: num(s.attempts) };
  const e = run.email;
  if (e && (e.state === 'not_needed' || e.state === 'queued' || e.state === 'sent' || e.state === 'failed')) return { state: e.state, attempts: num(e.attempts) };
  return undefined;
}

function countResult(r: CountryResult | null): { material: number; forInfo: number; unverified: number } {
  return { material: arr(r?.items).length, forInfo: arr(r?.for_information).length, unverified: arr(r?.unverified).length };
}

/** Список прогонов для «Истории», новые сверху. Папки не по шаблону id и битые run.json пропускаются. */
export function listRuns(workspaceDir: string, mailInfo?: MailInfo): HistoryRunDto[] {
  let names: string[];
  try {
    names = readdirSync(join(workspaceDir, 'runs'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && isRunId(e.name))
      .map((e) => e.name);
  } catch {
    return [];
  }
  const outbox = mailInfo ? [] : readOutboxEntries(workspaceDir);
  const out: HistoryRunDto[] = [];
  for (const id of names) {
    const p = archivePath(workspaceDir, id);
    if (!p.ok || !p.exists) continue;
    const s = loadRunSafe(p.path);
    if (!s) continue;
    const countries: HistoryRunDto['countries'] = [];
    const found = { material: 0, forInfo: 0, unverified: 0 };
    let ok = 0;
    for (const [code, c] of Object.entries(s.countries)) {
      const status = statusOf(c?.status);
      if (status === 'changes' || status === 'no_changes') ok++;
      const cp = archivePath(workspaceDir, id, code);
      const r = cp.ok && cp.exists ? readJsonSafe<CountryResult>(join(cp.path, 'result.json')) : null;
      const n = countResult(r);
      found.material += n.material;
      found.forInfo += n.forInfo;
      found.unverified += n.unverified;
      countries.push({ code, status, ...n });
    }
    let mail: MailDto;
    try {
      mail = mailInfo ? mailInfo(id, s) : mailFromOutbox(outbox, s);
    } catch {
      mail = undefined;
    }
    out.push({
      id,
      mode: s.mode,
      startedAt: s.started_at,
      ...(typeof s.finished_at === 'string' ? { finishedAt: s.finished_at } : {}),
      stopped: s.stopped === true,
      paused: typeof s.paused_until === 'string' && !s.finished_at,
      checked: { ok, total: countries.length },
      found,
      ...(mail ? { mail } : {}),
      countries,
    });
  }
  return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
}

/** Отчёт страны (Markdown) не больше REPORT_MAX_BYTES; длиннее — обрезан с пометкой. Нет файла — null. */
function readReport(file: string, L: UiLanguage): string | null {
  const r = readLimited(file, REPORT_MAX_BYTES);
  if (!r) return null;
  if (!r.truncated) return r.text;
  return `${r.text.replace(/�+$/, '')}\n\n…\n\n${mt(L, '_Отчёт слишком большой — показано начало. Полностью — в папке прогона._', '_The report is too large — only the beginning is shown. The full report is in the run folder._')}\n`;
}

/** Журнал страны простыми словами: сводные события, последние LOG_MAX_LINES строк. */
export function readCountryLog(file: string): Array<{ ts: string; text: string }> {
  const r = readLimited(file, LOG_TAIL_BYTES, 'tail');
  if (!r) return [];
  const lines = r.text.split('\n');
  if (r.truncated) lines.shift(); // первая строка хвоста — оборванная
  const out: Array<{ ts: string; text: string }> = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const event = str(rec?.['event']);
    const text = str(rec?.['text']).trim();
    if (!LOG_EVENTS.has(event) || !text) continue;
    out.push({ ts: str(rec['ts']), text: clip(text, event === 'screen_decision' ? SCREEN_TEXT_MAX : LOG_TEXT_MAX) });
  }
  return out.slice(-LOG_MAX_LINES);
}

/** Проверка по полям: все проходы (verification.pass-N.json по возрастанию N, затем verification.json); по карточке — последний. */
function readVerification(cdir: string): Map<string, HistoryVerificationDto> {
  const files: Array<{ n: number; name: string }> = [];
  try {
    for (const e of readdirSync(cdir, { withFileTypes: true })) {
      const m = /^verification\.pass-(\d{1,4})\.json$/.exec(e.name);
      if (e.isFile() && m) files.push({ n: Number(m[1]), name: e.name });
    }
  } catch {
    /* нет папки — нет проверки */
  }
  files.sort((a, b) => a.n - b.n);
  const out = new Map<string, HistoryVerificationDto>();
  for (const name of [...files.map((f) => f.name), 'verification.json']) {
    const v = readJsonSafe<Partial<Verification>>(join(cdir, name));
    for (const card of arr<Verification['cards'][number]>(v?.cards)) {
      if (!card || typeof card.candidate_id !== 'string') continue;
      out.set(card.candidate_id, {
        candidateId: card.candidate_id,
        verdict: str(card.verdict),
        fields: arr<Verification['cards'][number]['fields'][number]>(card.fields)
          .filter((f) => !!f && typeof f.field === 'string')
          .map((f) => ({
            field: f.field,
            status: f.status === 'ok' || f.status === 'mismatch' ? f.status : 'unverifiable',
            comment: str(f.comment),
          })),
      });
    }
  }
  return out;
}

/** Итог экрана по кандидатам: screen.json, иначе run.json (старые прогоны и прерванный экран). */
function readScreen(cdir: string, fromRun: Record<string, ScreenRun> | undefined): Record<string, ScreenRun> {
  const out: Record<string, ScreenRun> = { ...(fromRun && typeof fromRun === 'object' ? fromRun : {}) };
  const f = readJsonSafe<{ items?: unknown }>(join(cdir, 'screen.json'));
  for (const it of arr<ScreenRun & { id?: unknown }>(f?.items)) if (it && typeof it.id === 'string') out[it.id] = it;
  return out;
}

/**
 * Разбор страны в прогоне. null — id не по шаблону, путь вне рабочей папки, run.json битый или страны в прогоне нет.
 * `lang` — язык пояснений, которые пишет сам код (дубль журнала, обрезанный отчёт); причины модели — как в файлах.
 */
export function getCountryRun(workspaceDir: string, runId: string, code: string, lang: UiLanguage = 'ru'): HistoryCountryDto | null {
  const rp = archivePath(workspaceDir, runId);
  if (!rp.ok || !rp.exists) return null;
  const cp = archivePath(workspaceDir, runId, code);
  if (!cp.ok) return null;
  const state = loadRunSafe(rp.path);
  const cr = state?.countries[code];
  if (!state || !cr) return null;
  const cdir = cp.path;
  const L = lang;

  const result = cp.exists ? readJsonSafe<CountryResult>(join(cdir, 'result.json')) : null;
  const cf = cp.exists ? readJsonSafe<Partial<CandidatesFile>>(join(cdir, 'candidates.json')) : null;
  const cands = new Map<string, Candidate>();
  for (const c of arr<Candidate>(cf?.candidates)) if (c && typeof c.id === 'string') cands.set(c.id, c);
  const marked = falsePositiveIds(workspaceDir, code);

  // Находки: существенные (карточки), «для сведения», «не удалось проверить».
  const findings: HistoryFindingDto[] = [];
  const fp = (id: string): { markedFalsePositive?: boolean } => (marked.has(id) ? { markedFalsePositive: true } : {});
  for (const it of arr<CountryResult['items'][number]>(result?.items)) {
    if (!it || typeof it.candidate_id !== 'string') continue;
    const c = cands.get(it.candidate_id);
    findings.push({
      candidateId: it.candidate_id,
      title: str(it.title_en) || str(c?.title_original) || it.candidate_id,
      url: str(c?.url),
      level: 'material',
      confirmed: it.confirmed === true,
      disputedFields: arr<unknown>(it.disputed_fields).filter((x): x is string => typeof x === 'string'),
      ...fp(it.candidate_id),
    });
  }
  // «Для сведения» проверку по полям не проходит и пометки «⚠ не подтверждено» в письме не получает: confirmed = true.
  for (const it of arr<NonNullable<CountryResult['for_information']>[number]>(result?.for_information)) {
    if (!it || typeof it.candidate_id !== 'string') continue;
    findings.push({ candidateId: it.candidate_id, title: str(it.title_original) || it.candidate_id, url: str(it.url), level: 'for_info', confirmed: true, disputedFields: [], reason: str(it.reason), ...fp(it.candidate_id) });
  }
  for (const it of arr<NonNullable<CountryResult['unverified']>[number]>(result?.unverified)) {
    if (!it || typeof it.candidate_id !== 'string') continue;
    findings.push({ candidateId: it.candidate_id, title: str(it.title_original) || it.candidate_id, url: str(it.url), level: 'unverified', confirmed: false, disputedFields: [], reason: str(it.reason), ...fp(it.candidate_id) });
  }

  // Отброшенные: отбор по названию, экран по тексту (модель или код), журнал отправленного и дубли (код).
  const discarded: HistoryDiscardedDto[] = [];
  const screen = cp.exists ? readScreen(cdir, cr.screen) : {};
  const acts = cr.acts && typeof cr.acts === 'object' ? cr.acts : {};
  const inResult = new Set(findings.map((f) => f.candidateId));
  const row = (id: string, by: HistoryDiscardedDto['by'], reason: string): HistoryDiscardedDto => {
    const c = cands.get(id);
    return { candidateId: id, title: str(c?.title_original) || id, url: str(c?.url), issuer: str(c?.issuer), by, reason };
  };
  const triage = cp.exists ? readJsonSafe<Partial<TriageOutput>>(join(cdir, 'triage.json')) : null;
  for (const t of arr<TriageOutput['items'][number]>(triage?.items)) {
    if (!t || typeof t.id !== 'string' || t.decision !== 'irrelevant') continue;
    // Возвращённый проверкой (VER-02) дальше шёл на экран или анализ — он не отброшен отбором.
    if (screen[t.id] || acts[t.id] || inResult.has(t.id)) continue;
    discarded.push(row(t.id, 'triage', str(t.reason_text) || str(t.reason_code)));
  }
  for (const [id, s] of Object.entries(screen)) {
    if (!s || s.state !== 'done' || s.final !== 'dropped') continue;
    discarded.push(row(id, s.by === 'code' ? 'code' : 'screen', str(s.reason)));
  }
  for (const f of arr<{ id?: unknown; key?: unknown }>(cf?.filtered_by_ledger)) {
    if (!f || typeof f.id !== 'string') continue;
    const key = str(f.key);
    discarded.push({
      candidateId: f.id,
      title: key || f.id,
      url: '',
      issuer: '',
      by: 'code',
      reason: mt(L, `уже отправлялся раньше (журнал отправленного: ${key})`, `already sent earlier (sent log: ${key})`),
    });
  }
  for (const d of arr<{ candidate_id?: unknown; key?: unknown }>(result?.duplicates)) {
    if (!d || typeof d.candidate_id !== 'string') continue;
    const key = str(d.key);
    discarded.push(row(d.candidate_id, 'code', mt(L, `дубль уже отправленного (${key}), без новой стадии`, `duplicate of an already sent act (${key}), no new stage`)));
  }

  // Проверка по полям (VER-04): сначала находки в их порядке, затем остальные карточки.
  const ver = cp.exists ? readVerification(cdir) : new Map<string, HistoryVerificationDto>();
  const verification: HistoryVerificationDto[] = [];
  for (const f of findings) {
    const v = ver.get(f.candidateId);
    if (v) {
      verification.push(v);
      ver.delete(f.candidateId);
    }
  }
  verification.push(...ver.values());

  // Ошибка страны: из result.json, иначе текст сбоя этапа в run.json.
  const stageErr = Object.values(cr.stages ?? {}).find((s) => s && s.state === 'failed' && typeof s.error === 'string')?.error;
  const error = str(result?.error) || (statusOf(cr.status).startsWith('failed') ? str(stageErr) : '');
  const u = cr.usage ?? ({} as Partial<RunState['countries'][string]['usage']>);

  return {
    runId,
    code,
    status: statusOf(cr.status),
    ...(error ? { error } : {}),
    findings,
    discarded,
    verification,
    reportEn: cp.exists ? readReport(join(cdir, 'report.en.md'), L) : null,
    reportRu: cp.exists ? readReport(join(cdir, 'report.ru.md'), L) : null,
    log: cp.exists ? readCountryLog(join(cdir, 'log.jsonl')) : [],
    usage: { costUsd: num(u.cost_usd), input: num(u.input), output: num(u.output), cacheRead: num(u.cache_read), cacheWrite: num(u.cache_write) },
    dir: cdir,
  };
}

/** Что открыть в Finder: папку прогона или страны. Чистая функция (без electron), путь проверен на принадлежность рабочей папке. */
export function resolveOpenTarget(
  workspaceDir: string,
  runId: unknown,
  code?: unknown,
): { ok: true; path: string } | { ok: false; reason: 'bad_id' | 'outside' | 'not_found' } {
  const p = archivePath(workspaceDir, runId, code === undefined || code === null || code === '' ? undefined : code);
  if (!p.ok) return p;
  if (!p.exists) return { ok: false, reason: 'not_found' };
  return { ok: true, path: p.path };
}
