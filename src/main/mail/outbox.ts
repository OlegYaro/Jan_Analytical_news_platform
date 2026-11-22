// Очередь исходящих писем (DLV-06): <рабочая папка>/state/outbox.json, атомарная запись, переживает перезапуск.
// Без electron: отправка, часы, текст ошибки и «что сделать после отправки» приходят параметрами.
//
// Правила:
// - письмо уходит, когда nextAttemptAt ≤ now; временная ошибка (isRetryableMailError) — повтор через 15 мин,
//   не больше 6 повторов (всего 7 попыток), затем `failed` — письмо остаётся в приложении со статусом
//   «не отправлено»; постоянная ошибка (неверный пароль, адрес) — `failed` сразу, без повторов;
// - идемпотентность: запись с тем же id не добавляется второй раз; перед вызовом транспорта попытка
//   записывается на диск (attempts, inFlightSince), после — итог (sent/queued/failed). Обработка очереди
//   в одном процессе идёт строго по одной (замок на файл);
// - после успешной отправки вызывается onSent(entry) — там журнал отправленного (TRI-04). Письма одной
//   группы (два языка одного прогона, both_two) коммитятся ОДИН раз: после первой успешной отправки
//   любого письма группы. Сбой onSent не теряется: повторится при следующей обработке, письмо второй раз
//   не уходит.
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { CommitItem } from '../../shared/pipeline-types.ts';
import { writeJsonAtomic } from '../fs-atomic.ts';

export type OutboxStatus = 'queued' | 'sent' | 'failed';
/** Язык письма; 'ru+en' — оба языка в одном письме (both_one). */
export type OutboxLang = 'ru' | 'en' | 'ru+en';
export type OutboxKind = 'digest' | 'failure_alert';

export interface OutboxEntry {
  /** Уникален в очереди: `<runId>:<kind>:<lang>`. */
  id: string;
  runId: string;
  kind: OutboxKind;
  /** Письма одной группы коммитят журнал один раз (обычно `<runId>:<kind>`). */
  group: string;
  createdAt: string;
  lang: OutboxLang;
  subject: string;
  html: string;
  text: string;
  to: string[];
  /** Сколько раз вызывался транспорт (включая прерванные попытки). */
  attempts: number;
  nextAttemptAt: string;
  status: OutboxStatus;
  /** Причина последней неудачи по-русски (translateMailError) и по-английски — для окна на английском. */
  lastError?: string;
  lastErrorEn?: string;
  lastAttemptAt?: string;
  sentAt?: string;
  failedAt?: string;
  /** Попытка начата и ещё не записан итог. Найдено при старте обработки — попытка прервалась (сбой, выход). */
  inFlightSince?: string;
  /** Что записать в журнал отправленного после отправки: страна → записи (RunReport.to_commit). */
  commit: Record<string, CommitItem[]>;
  /** Страны, которые после отправки считаются проверенными (state/last_success.json): код → момент прогона. */
  checked?: Record<string, string>;
  /** onSent для группы выполнен (журнал записан). */
  committed: boolean;
  commitError?: string;
}

export interface OutboxFile {
  version: 1;
  entries: OutboxEntry[];
}

/** DLV-06: повтор через 15 минут. */
export const OUTBOX_RETRY_MS = 15 * 60_000;
/** DLV-06: «до 6 раз» — шесть повторов после первой попытки. */
export const OUTBOX_MAX_RETRIES = 6;
/** Отправленные и окончательно неотправленные записи хранятся 30 дней (для идемпотентности и окна «Прогон»). */
export const OUTBOX_KEEP_MS = 30 * 24 * 60 * 60_000;

export const outboxFile = (workspaceDir: string): string => join(workspaceDir, 'state', 'outbox.json');

/** Читает очередь; нет файла — пусто; битый — переименовывается в .bak (чтобы не потерять), возвращается пустая. */
export function loadOutbox(file: string): OutboxFile {
  if (!existsSync(file)) return { version: 1, entries: [] };
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<OutboxFile>;
    if (!raw || !Array.isArray(raw.entries)) throw new Error('нет списка entries');
    return { version: 1, entries: raw.entries as OutboxEntry[] };
  } catch {
    try {
      renameSync(file, `${file}.bak`);
    } catch {
      /* нечего переименовывать */
    }
    return { version: 1, entries: [] };
  }
}

function saveOutbox(file: string, data: OutboxFile, now: Date): void {
  const keepAfter = now.getTime() - OUTBOX_KEEP_MS;
  data.entries = data.entries.filter((e) => e.status === 'queued' || !(Date.parse(e.createdAt) < keepAfter));
  writeJsonAtomic(file, data);
}

// Замок на файл очереди: в одном процессе обработка и добавление идут строго по очереди.
const locks = new Map<string, Promise<unknown>>();

function withLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(file) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  locks.set(file, tail);
  void tail.then(() => {
    if (locks.get(file) === tail) locks.delete(file);
  });
  return run;
}

export type NewOutboxEntry = Omit<OutboxEntry, 'attempts' | 'status' | 'committed' | 'nextAttemptAt' | 'createdAt'> &
  Partial<Pick<OutboxEntry, 'nextAttemptAt' | 'createdAt'>>;

/** Добавляет письма в очередь. Запись с уже существующим id не добавляется (идемпотентно). Возвращает записи очереди с этими id. */
export function enqueueOutbox(file: string, items: NewOutboxEntry[], now: Date = new Date()): Promise<OutboxEntry[]> {
  return withLock(file, async () => {
    const data = loadOutbox(file);
    const have = new Set(data.entries.map((e) => e.id));
    for (const it of items) {
      if (have.has(it.id)) continue;
      have.add(it.id);
      data.entries.push({
        ...it,
        createdAt: it.createdAt ?? now.toISOString(),
        nextAttemptAt: it.nextAttemptAt ?? now.toISOString(),
        attempts: 0,
        status: 'queued',
        committed: false,
      });
    }
    saveOutbox(file, data, now);
    const ids = new Set(items.map((i) => i.id));
    return data.entries.filter((e) => ids.has(e.id)).map((e) => structuredClone(e));
  });
}

/** Записи прогона (по runId), копии. */
export function outboxEntriesFor(file: string, runId: string): OutboxEntry[] {
  return loadOutbox(file).entries.filter((e) => e.runId === runId).map((e) => structuredClone(e));
}

export interface ProcessOutboxDeps {
  file: string;
  /** Отправка одного письма (sendMail с паролем из safeStorage; в тестах — подставной транспорт). Бросает ошибку при неудаче. */
  send(entry: OutboxEntry): Promise<void>;
  /** После первой успешной отправки письма группы: журнал отправленного и last_success. */
  onSent(entry: OutboxEntry): Promise<void> | void;
  /** Временная ли ошибка (по умолчанию — повторять всё). */
  isRetryable?(err: unknown): boolean;
  /** Понятный текст ошибки: русский и английский. */
  describeError?(err: unknown): { ru: string; en: string };
  /** Любое изменение записи (для окна «Прогон», run.json и уведомлений). */
  onChange?(entry: OutboxEntry): void;
  now?(): Date;
  retryMs?: number;
  maxRetries?: number;
}

export interface ProcessOutboxResult {
  sent: string[];
  retry: string[];
  failed: string[];
  committed: string[];
}

const INTERRUPTED = {
  ru: 'Отправка прервалась (приложение закрылось или Mac уснул). Повторим.',
  en: 'Sending was interrupted (the app closed or the Mac went to sleep). Will retry.',
};

function defaultDescribe(err: unknown): { ru: string; en: string } {
  const m = err instanceof Error ? err.message : String(err);
  const line = (m.split('\n')[0] ?? '').trim() || 'неизвестная ошибка';
  return { ru: `Письмо не отправилось: ${line}`, en: `The message was not sent: ${line}` };
}

/**
 * Обрабатывает очередь: отправляет письма, которым пора (nextAttemptAt ≤ now), и дописывает журнал для
 * отправленных, у которых он ещё не записан. Каждый переход состояния сразу пишется на диск.
 */
export function processOutbox(deps: ProcessOutboxDeps): Promise<ProcessOutboxResult> {
  return withLock(deps.file, () => processLocked(deps));
}

async function processLocked(deps: ProcessOutboxDeps): Promise<ProcessOutboxResult> {
  const now = (): Date => (deps.now ? deps.now() : new Date());
  const retryMs = deps.retryMs ?? OUTBOX_RETRY_MS;
  const maxAttempts = (deps.maxRetries ?? OUTBOX_MAX_RETRIES) + 1;
  const isRetryable = deps.isRetryable ?? (() => true);
  const describe = deps.describeError ?? defaultDescribe;
  const res: ProcessOutboxResult = { sent: [], retry: [], failed: [], committed: [] };
  const data = loadOutbox(deps.file);
  const save = (): void => saveOutbox(deps.file, data, now());
  const changed = (e: OutboxEntry): void => {
    try {
      deps.onChange?.(structuredClone(e));
    } catch {
      /* подписчик не должен ломать очередь */
    }
  };

  /** Ошибка попытки: повтор или окончательный отказ. */
  const failAttempt = (e: OutboxEntry, msg: { ru: string; en: string }, retryable: boolean): void => {
    const t = now();
    delete e.inFlightSince;
    e.lastError = msg.ru;
    e.lastErrorEn = msg.en;
    if (retryable && e.attempts < maxAttempts) {
      e.status = 'queued';
      e.nextAttemptAt = new Date(t.getTime() + retryMs).toISOString();
      res.retry.push(e.id);
    } else {
      e.status = 'failed';
      e.failedAt = t.toISOString();
      res.failed.push(e.id);
    }
  };

  // Попытки, начатые прошлым процессом и не дописанные: результат неизвестен — считаем временной ошибкой.
  // Риск дубля только если сервер принял письмо в те доли секунды до записи итога; потерять письмо хуже.
  for (const e of data.entries) {
    if (e.status === 'queued' && e.inFlightSince) {
      failAttempt(e, INTERRUPTED, true);
      if (e.status === 'queued') e.nextAttemptAt = now().toISOString();
      save();
      changed(e);
    }
  }

  const commitGroup = async (e: OutboxEntry): Promise<void> => {
    const group = data.entries.filter((x) => x.group === e.group);
    if (group.some((x) => x.committed)) {
      for (const x of group) if (x.status === 'sent' && !x.committed) x.committed = true;
      save();
      return;
    }
    try {
      await deps.onSent(structuredClone(e));
      for (const x of group) {
        x.committed = true;
        delete x.commitError;
      }
      res.committed.push(e.group);
    } catch (err) {
      e.commitError = err instanceof Error ? err.message : String(err);
    }
    save();
    changed(e);
  };

  const due = data.entries.filter((e) => e.status === 'queued' && Date.parse(e.nextAttemptAt) <= now().getTime());
  for (const e of due) {
    if (e.status !== 'queued') continue;
    e.attempts += 1;
    e.lastAttemptAt = now().toISOString();
    e.inFlightSince = e.lastAttemptAt;
    save();
    try {
      await deps.send(structuredClone(e));
    } catch (err) {
      let retryable = true;
      try {
        retryable = isRetryable(err);
      } catch {
        /* по умолчанию — повторять */
      }
      failAttempt(e, describe(err), retryable);
      save();
      changed(e);
      continue;
    }
    delete e.inFlightSince;
    delete e.lastError;
    delete e.lastErrorEn;
    e.status = 'sent';
    e.sentAt = now().toISOString();
    res.sent.push(e.id);
    save();
    changed(e);
    await commitGroup(e);
  }

  // Отправленные письма, для которых журнал ещё не записан (сбой onSent в прошлый раз).
  for (const e of data.entries) {
    if (e.status === 'sent' && !e.committed) await commitGroup(e);
  }
  return res;
}

/** Сводка по письмам прогона для run.json и окна «Прогон». */
export interface OutboxSummary {
  state: 'queued' | 'sent' | 'failed';
  attempts: number;
  lastError?: string;
  lastErrorEn?: string;
  nextAttemptAt?: string;
}

/** Есть ожидающие — queued; иначе есть неотправленные — failed; иначе sent. null — писем у прогона нет. */
export function summarizeEntries(entries: OutboxEntry[]): OutboxSummary | null {
  if (entries.length === 0) return null;
  const queued = entries.filter((e) => e.status === 'queued');
  const failed = entries.filter((e) => e.status === 'failed');
  const state: OutboxSummary['state'] = queued.length ? 'queued' : failed.length ? 'failed' : 'sent';
  const attempts = Math.max(...entries.map((e) => e.attempts));
  const withErr = [...queued, ...failed].find((e) => e.lastError);
  const next = queued.map((e) => e.nextAttemptAt).sort()[0];
  return {
    state,
    attempts,
    ...(withErr?.lastError ? { lastError: withErr.lastError } : {}),
    ...(withErr?.lastErrorEn ? { lastErrorEn: withErr.lastErrorEn } : {}),
    ...(state === 'queued' && next ? { nextAttemptAt: next } : {}),
  };
}
