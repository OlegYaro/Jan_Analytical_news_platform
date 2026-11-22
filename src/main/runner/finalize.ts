// Шаги 7–10 прогона (docs/02 §4): DIGEST → TRANSLATE → SEND → COMMIT. Это код, не модель: модель только
// переводит короткие фрагменты (TranslateFn). Без electron: отправка, перевод, часы и уведомления — параметрами.
//
// Решения (подробно — docs/FINDINGS.md «Фаза 7: отправка и учёт»):
// - письмо только если есть что показать (DLV-01) или страна не проверена 2 прогона подряд (COV-06);
// - журнал отправленного (TRI-04/05) и last_success стран из письма пишутся ТОЛЬКО после успешной отправки
//   (onSent очереди). Страны без находок, проверенные без сбоя, засчитываются сразу: терять в них нечего;
// - both_two: два письма одной группы; журнал пишется один раз — после первой успешной отправки любого из
//   них (содержание одинаковое, получатель его уже увидел; второе письмо продолжает свои повторы);
// - both_one: одно письмо, сверху русская версия, ниже английская;
// - пробный прогон и «за период» (dry_run, backfill): письмо и отчёты кладутся в папку прогона, письмо не
//   уходит, журнал и last_success не пишутся, счётчики сбоев (COV-06) не меняются;
// - идемпотентность: письма прогона имеют id `<runId>:<kind>:<lang>`; повторный вызов (после сбоя/перезапуска)
//   письма заново не собирает и не ставит, а только дообрабатывает очередь; счётчики сбоев помнят runId.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { CommitItem, CountryResult, RunReport } from '../../shared/pipeline-types.ts';
import type { MailStatusDto, RunMode, RunState } from '../../shared/run-types.ts';
import type { Card } from '../../shared/schema-types.ts';
import type { Country, Settings, UiLanguage } from '../../shared/types.ts';
import { appendLog } from '../archive.ts';
import { buildDigest, collectTranslatable, hasFindings } from '../digest/build.ts';
import type { DigestCountry, DigestInput, DigestOutput } from '../digest/build.ts';
import type { DigestLang, TranslateFn, TranslateResult } from '../digest/contracts.ts';
import { buildCountryReport } from '../digest/report.ts';
import { writeAtomic, writeJsonAtomic } from '../fs-atomic.ts';
import { mt } from '../i18n.ts';
import { commitSent, shouldWriteLedger } from '../ledger.ts';
import { enqueueOutbox, outboxEntriesFor, outboxFile, processOutbox, summarizeEntries } from '../mail/outbox.ts';
import type { NewOutboxEntry, OutboxEntry, OutboxLang, ProcessOutboxResult } from '../mail/outbox.ts';
import { testRecipients } from '../mail/service.ts';
import { isRetryableMailError, translateMailError } from '../mail/smtp.ts';
import { computeWindow } from './orchestrator.ts';
import { loadRun, saveRun } from './run-state.ts';

// ---------------------------------------------------------------------------------------------
// Состояние в <рабочая папка>/state
// ---------------------------------------------------------------------------------------------

/** RUN-09: { "UZ": "<ISO момента начала прогона>" } — читает computeWindow (orchestrator.ts). */
export const lastSuccessFile = (ws: string): string => join(ws, 'state', 'last_success.json');
/** COV-06: счётчики подряд не проверенных стран. */
export const countryFailuresFile = (ws: string): string => join(ws, 'state', 'country_failures.json');

function readJsonObject(file: string): Record<string, unknown> {
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Засчитывает страны как проверенные: last_success[код] = момент (ISO). Только вперёд: более старый прогон,
 * дообработанный позже, окно не откатывает. Формат — как читает computeWindow: строка ISO на страну.
 */
export function markLastSuccess(ws: string, marks: Record<string, string>): void {
  const codes = Object.keys(marks);
  if (codes.length === 0) return;
  const file = lastSuccessFile(ws);
  const cur = readJsonObject(file);
  let changed = false;
  for (const code of codes) {
    const next = marks[code]!;
    const prev = cur[code];
    if (Number.isNaN(Date.parse(next))) continue;
    if (typeof prev === 'string' && !Number.isNaN(Date.parse(prev)) && Date.parse(prev) >= Date.parse(next)) continue;
    cur[code] = next;
    changed = true;
  }
  if (changed) writeJsonAtomic(file, cur);
}

export interface CountryFailureRecord {
  /** Сколько обычных прогонов подряд страна не проверена (0 — последний прогон успешен). */
  consecutive: number;
  /** Последний учтённый прогон: повтор finalize того же прогона счётчик не меняет. */
  lastRunId: string;
  lastStatus: string;
  lastError?: string;
  /** Начало текущей серии сбоев (ISO). */
  since?: string;
}

export interface CountryFailuresFile {
  version: 1;
  countries: Record<string, CountryFailureRecord>;
}

export function loadCountryFailures(ws: string): CountryFailuresFile {
  const raw = readJsonObject(countryFailuresFile(ws));
  const c = raw['countries'];
  return { version: 1, countries: c && typeof c === 'object' && !Array.isArray(c) ? (c as Record<string, CountryFailureRecord>) : {} };
}

/** Страна со сбоем → +1, проверена → 0. Идемпотентно по runId. Возвращает счётчики после обновления. */
export function updateCountryFailures(
  ws: string,
  runId: string,
  outcomes: Array<{ code: string; status: string; error?: string }>,
  now: Date,
): Record<string, number> {
  const data = loadCountryFailures(ws);
  const out: Record<string, number> = {};
  let changed = false;
  for (const o of outcomes) {
    const prev = data.countries[o.code];
    if (prev && prev.lastRunId === runId) {
      out[o.code] = prev.consecutive;
      continue;
    }
    const failed = o.status.startsWith('failed');
    const consecutive = failed ? (prev?.consecutive ?? 0) + 1 : 0;
    const rec: CountryFailureRecord = { consecutive, lastRunId: runId, lastStatus: o.status };
    if (failed && o.error) rec.lastError = o.error;
    if (failed) rec.since = prev && prev.consecutive > 0 && prev.since ? prev.since : now.toISOString();
    data.countries[o.code] = rec;
    out[o.code] = consecutive;
    changed = true;
  }
  if (changed) writeJsonAtomic(countryFailuresFile(ws), data);
  return out;
}

/** COV-06: письмо о сбое — со второго прогона подряд без проверки. */
export const FAILURE_ALERT_AFTER = 2;

// ---------------------------------------------------------------------------------------------
// Письма
// ---------------------------------------------------------------------------------------------

/** Флаг страны из кода ISO (региональные символы). */
export function flagOf(code: string): string {
  return /^[A-Z]{2}$/.test(code) ? String.fromCodePoint(...[...code].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65)) : '';
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export const INCOMPLETE_TRANSLATION_RU =
  'Перевод неполный: часть фрагментов оставлена на английском (перевод не получен или не прошёл сверку чисел, дат и ссылок).';

/** Строка в конец письма (HTML — перед закрытием контейнера, текст — последней строкой). */
export function appendNote(d: DigestOutput, note: string): DigestOutput {
  const p = `<p style="margin:8px 0;font-size:12px;color:#b45309;line-height:1.4;">${esc(note)}</p>\n`;
  const i = d.html.lastIndexOf('</div></body>');
  const html = i >= 0 ? d.html.slice(0, i) + p + d.html.slice(i) : d.html + p;
  return { ...d, html, text: d.text.replace(/\n*$/, '\n') + '\n' + note + '\n' };
}

const bodyInner = (html: string): string => {
  const m = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
  return m ? m[1]! : html;
};

/** both_one: одно письмо — сверху русская версия, ниже английская. */
export function combineLetters(ru: DigestOutput, en: DigestOutput): DigestOutput {
  const sep = '<hr style="margin:24px auto;max-width:640px;border:0;border-top:3px solid #999;">\n';
  const i = ru.html.lastIndexOf('</body>');
  const html = i >= 0 ? ru.html.slice(0, i) + sep + bodyInner(en.html) + ru.html.slice(i) : ru.html + sep + en.html;
  const text = `${ru.text.replace(/\n*$/, '\n')}\n${'—'.repeat(24)}\nEnglish version\n\n${en.text}`;
  return { subject: ru.subject, html, text, hasContent: ru.hasContent || en.hasContent };
}

export interface AlertCountry {
  code: string;
  nameRu: string;
  reason: string;
  consecutive: number;
}

/** Письмо о сбое страны (COV-06), когда изменений нет, а страна не проверена 2+ прогона подряд. */
export function buildFailureAlert(
  countries: AlertCountry[],
  checked: { ok: number; total: number },
  date: string,
  lang: DigestLang,
): DigestOutput {
  const d = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  const day = d ? `${d[3]}.${d[2]}.${d[1]}` : date;
  const codes = countries.map((c) => c.code).join(', ');
  const ru = lang === 'ru';
  const heading = ru ? `RegWatch — сбой проверки ${day}` : `RegWatch — check failure ${day}`;
  const subject = ru ? `RegWatch: не удалось проверить ${codes}` : `RegWatch: could not check ${codes}`;
  const intro = ru
    ? 'Эти страны не удалось проверить несколько прогонов подряд — изменения в них могли пройти незамеченными:'
    : 'These countries could not be checked several runs in a row — changes there may have gone unnoticed:';
  const lines = countries.map((c) => {
    const flag = flagOf(c.code);
    const name = ru ? c.nameRu : c.code;
    return ru
      ? `· ${flag ? flag + ' ' : ''}${name} — ${c.reason} (прогонов подряд без проверки: ${c.consecutive})`
      : `· ${flag ? flag + ' ' : ''}${name} — ${c.reason} (runs in a row without a check: ${c.consecutive})`;
  });
  const what = ru
    ? 'Что сделать: откройте RegWatch → «Прогон», посмотрите причину; если сайт недоступен — запустите «Проверку источников» для этой страны.'
    : 'What to do: open RegWatch → "Run" and look at the reason; if a website is unavailable, run "Check sources" for that country.';
  const foot = ru
    ? `Проверено ${checked.ok} из ${checked.total} стран · В остальных странах изменений не найдено · Подробно в приложении`
    : `Checked ${checked.ok} of ${checked.total} countries · No changes found in the other countries · Details in the app`;
  const text = [heading, '', intro, ...lines, '', what, '', foot].join('\n') + '\n';
  const p = (s: string, style = 'margin:4px 0;font-size:14px;line-height:1.4;') => `<p style="${style}">${esc(s)}</p>`;
  const html =
    `<!doctype html>\n<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${esc(heading)}</title></head>\n<body style="margin:0;padding:0;background:#f4f4f4;">` +
    '<div style="max-width:640px;margin:0 auto;padding:16px;background:#ffffff;font-family:-apple-system,Helvetica,Arial,sans-serif;color:#111;">\n' +
    `<h1 style="margin:0 0 8px;font-size:20px;">${esc(heading)}</h1>\n` +
    [p(intro), ...lines.map((l) => p(l, 'margin:3px 0 3px 8px;font-size:14px;line-height:1.4;color:#b45309;')), p(what), p(foot, 'margin:12px 0 4px;font-size:12px;color:#666;')].join('\n') +
    '\n</div></body></html>';
  return { subject, html, text, hasContent: true };
}

// ---------------------------------------------------------------------------------------------
// Уведомления macOS (DLV-07): тексты; показывает их index.ts
// ---------------------------------------------------------------------------------------------

export interface FinalizeNotice {
  runId: string;
  mode: RunMode;
  changes: Array<{ code: string; material: number; info: number; unverified: number }>;
  failed: Array<{ code: string; consecutive: number }>;
  /** queued/sent/failed — письмо поставлено/ушло/не ушло; not_needed — письма нет; preview — пробный прогон. */
  mail: 'not_needed' | 'queued' | 'sent' | 'failed' | 'preview';
  mailError?: string;
  mailErrorEn?: string;
}

const plural = (n: number, one: string, few: string, many: string): string => {
  const a = n % 100;
  const b = n % 10;
  if (a >= 11 && a <= 14) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
};

/** Заголовок и текст уведомления о завершении прогона. */
export function noticeText(n: FinalizeNotice, L: UiLanguage): { title: string; body: string } {
  const trial = n.mode === 'dry_run' || n.mode === 'backfill';
  const prefix = n.mode === 'dry_run' ? mt(L, 'Пробная проверка. ', 'Dry run. ') : n.mode === 'backfill' ? mt(L, 'Проверка за период. ', 'Period check. ') : '';
  const parts: string[] = [];
  let title: string;
  if (n.changes.length > 0) {
    title = mt(L, 'RegWatch: есть изменения', 'RegWatch: changes found');
    const list = n.changes.map((c) => {
      const what: string[] = [];
      if (c.material) what.push(L === 'en' ? `${c.material} material` : `${c.material} ${plural(c.material, 'существенный', 'существенных', 'существенных')}`);
      if (c.info) what.push(mt(L, `${c.info} для сведения`, `${c.info} for information`));
      if (c.unverified) what.push(mt(L, `${c.unverified} не удалось проверить`, `${c.unverified} could not be verified`));
      return `${c.code} — ${what.join(', ')}`;
    });
    parts.push(mt(L, `Есть изменения: ${list.join('; ')}.`, `Changes: ${list.join('; ')}.`));
  } else {
    title = mt(L, 'RegWatch: проверка завершена', 'RegWatch: check finished');
    parts.push(mt(L, 'Проверка завершена, изменений нет.', 'Check finished, no changes.'));
  }
  if (n.failed.length > 0) {
    const f = n.failed.map((x) => (x.consecutive >= FAILURE_ALERT_AFTER ? mt(L, `${x.code} (${x.consecutive}-й раз подряд)`, `${x.code} (${x.consecutive} runs in a row)`) : x.code));
    parts.push(mt(L, `Не удалось проверить: ${f.join(', ')}.`, `Could not check: ${f.join(', ')}.`));
  }
  if (n.mail === 'failed') parts.push(mt(L, 'Письмо не отправлено — откройте RegWatch.', 'The e-mail was not sent — open RegWatch.'));
  else if (n.mail === 'queued') parts.push(mt(L, 'Письмо пока не ушло, повторим через 15 минут.', 'The e-mail has not gone out yet; will retry in 15 minutes.'));
  else if (trial && n.changes.length > 0) parts.push(mt(L, 'Письмо не отправлялось — результат в приложении.', 'No e-mail was sent — see the result in the app.'));
  return { title: n.failed.length > 0 && n.changes.length === 0 ? mt(L, 'RegWatch: сбой проверки', 'RegWatch: check failure') : title, body: prefix + parts.join(' ') };
}

/** Уведомление, когда повтор из очереди окончательно не удался. */
export function mailFailedText(e: Pick<OutboxEntry, 'lastError' | 'lastErrorEn'>, L: UiLanguage): { title: string; body: string } {
  const why = L === 'en' ? e.lastErrorEn : e.lastError;
  return {
    title: mt(L, 'RegWatch: письмо не отправлено', 'RegWatch: e-mail not sent'),
    body: mt(L, 'Письмо не отправлено — откройте RegWatch.', 'The e-mail was not sent — open RegWatch.') + (why ? ` ${why}` : ''),
  };
}

// ---------------------------------------------------------------------------------------------
// Очередь: обработка с журналом отправленного (общая для finalize и таймера в index.ts)
// ---------------------------------------------------------------------------------------------

export interface MailQueueDeps {
  getSettings(): Settings;
  /** Отправка одного письма (sendMail + пароль из safeStorage). Бросает ошибку транспорта. */
  send(entry: OutboxEntry, settings: Settings): Promise<void>;
  now?(): Date;
  /** Изменение записи очереди (окно «Прогон», уведомление «письмо не отправлено»). */
  onOutboxChange?(entry: OutboxEntry): void;
  retryMs?: number;
  maxRetries?: number;
}

/** Журнал прогона: runs/<id>/log.jsonl. */
function runLog(runDir: string, now: Date, event: string, text: string, data: Record<string, unknown> = {}): void {
  try {
    appendLog(runDir, { ts: now.toISOString(), event, text, ...data });
  } catch {
    /* диск недоступен — не роняем отправку */
  }
}

/** state.email прогона по его письмам в очереди (для run.json). */
function emailState(entries: OutboxEntry[]): RunState['email'] | null {
  const s = summarizeEntries(entries);
  return s ? { state: s.state, attempts: s.attempts } : null;
}

/** Обновляет email в run.json завершённого прогона (у идущего его ставит finalize в памяти оркестратора). */
export function syncRunEmail(ws: string, runId: string): void {
  const dir = join(ws, 'runs', runId);
  try {
    if (!existsSync(join(dir, 'run.json'))) return;
    const st = loadRun(dir);
    if (!st.finished_at) return;
    const e = emailState(outboxEntriesFor(outboxFile(ws), runId));
    if (!e || (st.email?.state === e.state && st.email.attempts === e.attempts)) return;
    st.email = e;
    saveRun(dir, st);
  } catch {
    /* run.json битый — состояние всё равно в outbox.json */
  }
}

/** Обрабатывает очередь рабочей папки: отправка, повторы, журнал отправленного после успеха. */
export function processMailQueue(ws: string, deps: MailQueueDeps): Promise<ProcessOutboxResult> {
  const now = (): Date => (deps.now ? deps.now() : new Date());
  const settings = deps.getSettings();
  return processOutbox({
    file: outboxFile(ws),
    now,
    ...(deps.retryMs !== undefined ? { retryMs: deps.retryMs } : {}),
    ...(deps.maxRetries !== undefined ? { maxRetries: deps.maxRetries } : {}),
    send: (e) => deps.send(e, deps.getSettings()),
    isRetryable: isRetryableMailError,
    describeError: (err) => ({ ru: translateMailError(err, settings.mail, 'ru'), en: translateMailError(err, settings.mail, 'en') }),
    onSent: (e) => {
      const t = now();
      // TRI-04/05: журнал — только после успешной отправки; commitSent обновляет запись по ключу (повтор безопасен).
      for (const [code, items] of Object.entries(e.commit)) if (items.length) commitSent(ws, code, items, e.runId, t);
      markLastSuccess(ws, e.checked ?? {});
      const dir = join(ws, 'runs', e.runId);
      const n = Object.values(e.commit).reduce((a, x) => a + x.length, 0);
      runLog(dir, t, 'finalize_commit', `Письмо ушло; журнал отправленного записан (${n} записей), страны засчитаны проверенными`, {
        id: e.id,
        ledger: Object.fromEntries(Object.entries(e.commit).map(([k, v]) => [k, v.map((i) => i.key)])),
        checked: Object.keys(e.checked ?? {}),
      });
    },
    onChange: (e) => {
      const dir = join(ws, 'runs', e.runId);
      if (e.status === 'sent') runLog(dir, now(), 'finalize_sent', `Письмо отправлено (${e.lang}), попытка ${e.attempts}`, { id: e.id });
      else if (e.status === 'failed') runLog(dir, now(), 'finalize_mail_failed', `Письмо не отправлено (${e.lang}): ${e.lastError ?? ''}`, { id: e.id, attempts: e.attempts });
      else runLog(dir, now(), 'finalize_mail_retry', `Письмо не ушло (${e.lang}), повтор в ${e.nextAttemptAt}: ${e.lastError ?? ''}`, { id: e.id, attempts: e.attempts });
      syncRunEmail(ws, e.runId);
      deps.onOutboxChange?.(e);
    },
  });
}

/** Статус писем прогона для окна «Прогон» (RunStatusDto.mail). */
export function mailStatusFor(ws: string, run: RunState | null, L: UiLanguage): MailStatusDto | undefined {
  if (!run) return undefined;
  const s = summarizeEntries(outboxEntriesFor(outboxFile(ws), run.id));
  if (s) {
    const err = L === 'en' ? (s.lastErrorEn ?? s.lastError) : s.lastError;
    return { state: s.state, attempts: s.attempts, ...(err ? { lastError: err } : {}), ...(s.nextAttemptAt ? { nextAttemptAt: s.nextAttemptAt } : {}) };
  }
  return run.email ? { state: run.email.state, attempts: run.email.attempts } : undefined;
}

// ---------------------------------------------------------------------------------------------
// finalize
// ---------------------------------------------------------------------------------------------

export interface FinalizeDeps extends MailQueueDeps {
  getCountries(): Country[];
  /** Перевод фрагментов для русского письма (createTranslator); нет — русское письмо с английскими фрагментами. */
  translate?: TranslateFn;
  /** Итог прогона для уведомления macOS (DLV-07). */
  notify?(n: FinalizeNotice): void;
}

type ReportCountry = RunReport['countries'][number];

const isFailed = (status: string): boolean => status.startsWith('failed');

function digestCountry(c: ReportCountry, names: Map<string, Country>): DigestCountry {
  const { cards, ...result } = c;
  return { code: c.country, nameRu: names.get(c.country)?.name ?? c.country, flag: flagOf(c.country), result: result as CountryResult, cards: cards as Record<string, Card> };
}

/** Языки писем по настройке (CFG-08). */
function plannedLangs(lang: Settings['reportLanguage']): OutboxLang[] {
  if (lang === 'en') return ['en'];
  if (lang === 'both_one') return ['ru+en'];
  if (lang === 'both_two') return ['ru', 'en'];
  return ['ru'];
}

export function createFinalize(deps: FinalizeDeps): (report: RunReport) => Promise<void> {
  const now = (): Date => (deps.now ? deps.now() : new Date());

  return async (report: RunReport): Promise<void> => {
    const s = report.state;
    const runDir = report.runDir;
    const ws = resolve(runDir, '..', '..');
    const settings = deps.getSettings();
    const names = new Map(deps.getCountries().map((c) => [c.code, c]));
    const log = (event: string, text: string, data: Record<string, unknown> = {}): void => runLog(runDir, now(), event, text, data);
    const real = shouldWriteLedger(s.mode);
    log('finalize_start', real ? 'Шаги дайджеста и отправки начаты' : 'Шаги дайджеста начаты (письмо в этом режиме не отправляется)', { mode: s.mode });

    // ---- итоги стран ----
    const byCode = new Map(report.countries.map((c) => [c.country, c]));
    const outcomes = Object.entries(s.countries).map(([code, cr]) => {
      const r = byCode.get(code);
      // Нет result.json — страна не может считаться проверенной.
      const status: string = r ? r.status : isFailed(cr.status) ? cr.status : 'failed:internal';
      const error = r ? r.error : 'итог страны не найден';
      return { code, status, ...(error ? { error } : {}) };
    });
    const okCodes = outcomes.filter((o) => !isFailed(o.status)).map((o) => o.code);
    const failedOutcomes = outcomes.filter((o) => isFailed(o.status));
    const counters = real ? updateCountryFailures(ws, s.id, outcomes, now()) : {};
    if (real && failedOutcomes.length) log('finalize_failures', 'Счётчики непроверенных стран (COV-06) обновлены', { counters });

    const input: DigestInput = {
      runId: s.id,
      date: s.started_at,
      countries: report.countries.filter((c) => !isFailed(c.status)).map((c) => digestCountry(c, names)),
      checked: { ok: okCodes.length, total: outcomes.length },
      failures: failedOutcomes.map((o) => ({ code: o.code, nameRu: names.get(o.code)?.name ?? o.code, reason: o.error ?? o.status })),
    };
    const shown = input.countries.filter(hasFindings);
    const notice = (mail: FinalizeNotice['mail'], err?: { ru?: string; en?: string }): FinalizeNotice => ({
      runId: s.id,
      mode: s.mode,
      changes: shown.map((c) => ({ code: c.code, material: c.result.items.length, info: c.result.for_information?.length ?? 0, unverified: c.result.unverified?.length ?? 0 })),
      failed: failedOutcomes.map((o) => ({ code: o.code, consecutive: counters[o.code] ?? 0 })),
      mail,
      ...(err?.ru ? { mailError: err.ru } : {}),
      ...(err?.en ? { mailErrorEn: err.en } : {}),
    });
    const tell = (n: FinalizeNotice): void => {
      try {
        deps.notify?.(n);
      } catch {
        /* уведомление не должно ломать прогон */
      }
    };

    // ---- повтор finalize того же прогона: письма уже в очереди — только дообработать ----
    const file = outboxFile(ws);
    if (real) {
      const existing = outboxEntriesFor(file, s.id);
      if (existing.length > 0 || (s.email && s.email.state !== 'not_needed')) {
        log('finalize_resume', 'Письма этого прогона уже в очереди — заново не собираются, только дообработка очереди');
        if (existing.length > 0) await processMailQueue(ws, deps);
        const e = emailState(outboxEntriesFor(file, s.id));
        if (e) s.email = e;
        return;
      }
      if (s.email?.state === 'not_needed') {
        log('finalize_resume', 'Решение по письму уже принято (письмо не нужно)');
        return;
      }
    }

    // ---- DIGEST + TRANSLATE ----
    const langs = plannedLangs(settings.reportLanguage);
    const needRu = langs.some((l) => l !== 'en');
    const alerts: AlertCountry[] =
      real && settings.failureAlerts
        ? failedOutcomes
            .filter((o) => (counters[o.code] ?? 0) >= FAILURE_ALERT_AFTER)
            .map((o) => ({ code: o.code, nameRu: names.get(o.code)?.name ?? o.code, reason: o.error ?? o.status, consecutive: counters[o.code] ?? 0 }))
        : [];
    const hasContent = shown.length > 0;

    let tr: TranslateResult = { translations: {}, rejected: [] };
    let complete = true;
    if (hasContent && needRu) {
      const texts = collectTranslatable(input);
      if (texts.length > 0) {
        if (!deps.translate) {
          complete = false;
          log('finalize_translate', 'Перевод не подключён: русское письмо с английскими фрагментами');
        } else {
          try {
            const out = await deps.translate({ workspaceDir: ws, runDir, settings }, texts);
            if (out.ok) {
              tr = out.output;
              complete = tr.rejected.length === 0;
              log('finalize_translate', `Перевод: ${Object.keys(tr.translations).length} из ${texts.length} фрагментов, отвергнуто ${tr.rejected.length}`, {
                rejected: tr.rejected,
              });
            } else {
              complete = false;
              log('finalize_translate', `Перевод не получен (${out.failure}): ${out.message}. Русское письмо с английскими фрагментами`);
            }
          } catch (e) {
            complete = false;
            log('finalize_translate', `Перевод не получен: ${e instanceof Error ? e.message : String(e)}. Русское письмо с английскими фрагментами`);
          }
        }
      }
    }
    const ruOpts = { lang: 'ru' as const, translate: (t: string): string => tr.translations[t] ?? t };
    const ruLetter = (): DigestOutput => {
      const d = buildDigest(input, ruOpts);
      return complete ? d : appendNote(d, INCOMPLETE_TRANSLATION_RU);
    };
    const enLetter = (): DigestOutput => buildDigest(input, { lang: 'en' });
    s.digest = { en: true, ru: needRu ? (hasContent ? (complete ? 'done' : 'blocked') : 'not_needed') : 'not_needed' };

    // Письма: дайджест, если есть находки; иначе — письмо о сбое (COV-06), если нужно.
    const kind: OutboxEntry['kind'] | null = hasContent ? 'digest' : alerts.length > 0 ? 'failure_alert' : null;
    const letters: Array<{ lang: OutboxLang; out: DigestOutput }> = [];
    for (const l of langs) {
      if (kind === 'failure_alert') {
        const ru = buildFailureAlert(alerts, input.checked, s.started_at, 'ru');
        const en = buildFailureAlert(alerts, input.checked, s.started_at, 'en');
        letters.push({ lang: l, out: l === 'ru' ? ru : l === 'en' ? en : combineLetters(ru, en) });
      } else {
        letters.push({ lang: l, out: l === 'ru' ? ruLetter() : l === 'en' ? enLetter() : combineLetters(ruLetter(), enLetter()) });
      }
    }

    // ---- архив: отчёты стран и письмо (DLV-06: отчёт в архиве, даже если письмо не уйдёт) ----
    try {
      for (const c of input.countries) {
        writeAtomic(join(runDir, c.code, 'report.en.md'), buildCountryReport(c, 'en'));
        if (needRu) writeAtomic(join(runDir, c.code, 'report.ru.md'), buildCountryReport(c, 'ru'));
      }
      const files = kind ? letters : [{ lang: langs[0]!, out: langs[0] === 'en' ? enLetter() : ruLetter() }];
      files.forEach((f, i) => {
        if (i === 0) {
          writeAtomic(join(runDir, 'digest.html'), f.out.html);
          writeAtomic(join(runDir, 'digest.txt'), f.out.text);
        }
        writeAtomic(join(runDir, `digest.${f.lang}.html`), f.out.html);
        writeAtomic(join(runDir, `digest.${f.lang}.txt`), f.out.text);
      });
      log('finalize_digest', `Дайджест собран: ${hasContent ? 'есть находки' : 'находок нет'}; отчёты стран: ${input.countries.length}`, {
        countries_shown: shown.map((c) => c.code),
        langs,
      });
    } catch (e) {
      log('finalize_digest_error', `Не удалось записать дайджест в архив: ${e instanceof Error ? e.message : String(e)}`);
    }

    // ---- пробный прогон и «за период»: письма нет, журнала нет ----
    if (!real) {
      s.email = { state: 'not_needed', attempts: 0 };
      // «За период» двигает окно страны, только если период непрерывно продолжает проверенное: начинается не позже
      // того дня, с которого начнётся следующая обычная проверка. Иначе между ними остался бы непроверенный
      // промежуток, а находки периода письмом не приходят. Отметка ставится на день `to` (день to следующая
      // проверка просмотрит ещё раз — журнал за период не пишется, зато ничего не теряется). dry_run окно не меняет.
      if (s.mode === 'backfill') {
        const marks: Record<string, string> = {};
        const skipped: Record<string, string> = {};
        for (const code of okCodes) {
          const w = s.countries[code]?.window;
          if (!w) continue;
          const nextFrom = computeWindow(ws, code, settings, now()).from;
          if (w.from <= nextFrom) marks[code] = new Date(`${w.to}T12:00:00`).toISOString();
          else skipped[code] = `период начинается ${w.from}, позже начала следующей проверки ${nextFrom}`;
        }
        markLastSuccess(ws, marks);
        log('finalize_done', 'Проверка за период: письмо не отправляется, журнал не меняется; окно сдвинуто только у стран, где период продолжает проверенное', {
          checked: Object.keys(marks),
          not_counted: skipped,
        });
      } else {
        log('finalize_done', 'Пробный режим: письмо не отправляется, журнал отправленного и окна стран не меняются');
      }
      tell(notice('preview'));
      return;
    }

    // ---- COMMIT без письма: страны без находок засчитываются сразу ----
    const at = s.started_at;
    const shownCodes = new Set(hasContent ? shown.map((c) => c.code) : []);
    markLastSuccess(ws, Object.fromEntries(okCodes.filter((c) => !shownCodes.has(c)).map((c) => [c, at])));

    if (!kind) {
      s.email = { state: 'not_needed', attempts: 0 };
      log('finalize_done', 'Находок нет — письма нет (DLV-01); страны без сбоя засчитаны проверенными', { checked: okCodes });
      tell(notice('not_needed'));
      return;
    }

    // ---- SEND: в очередь и сразу попытка ----
    const commit: Record<string, CommitItem[]> = {};
    const checked: Record<string, string> = {};
    if (kind === 'digest') {
      for (const c of report.countries) {
        if (!shownCodes.has(c.country)) continue;
        checked[c.country] = at;
        if (c.to_commit.length) commit[c.country] = c.to_commit;
      }
    }
    const to = testRecipients(settings.mail);
    const items: NewOutboxEntry[] = letters.map((l) => ({
      id: `${s.id}:${kind}:${l.lang}`,
      runId: s.id,
      kind,
      group: `${s.id}:${kind}`,
      lang: l.lang,
      subject: l.out.subject,
      html: l.out.html,
      text: l.out.text,
      to,
      commit,
      checked,
    }));
    await enqueueOutbox(file, items, now());
    s.email = { state: 'queued', attempts: 0 };
    log('finalize_queued', `Письмо поставлено в очередь (${letters.map((l) => l.lang).join(', ')}), получатели: ${to.length}`, {
      kind,
      ids: items.map((i) => i.id),
    });
    await processMailQueue(ws, deps);
    const after = outboxEntriesFor(file, s.id);
    const e = emailState(after);
    if (e) s.email = e;
    const sum = summarizeEntries(after);
    log('finalize_done', `Итог отправки: ${s.email?.state}`, { email: s.email });
    tell(notice(s.email?.state ?? 'queued', { ...(sum?.lastError ? { ru: sum.lastError } : {}), ...(sum?.lastErrorEn ? { en: sum.lastErrorEn } : {}) }));
  };
}
