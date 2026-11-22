// Безопасное чтение архива прогонов для «Истории» и эталонов из приложения (ARC-03, HAL-07).
// Только чтение, без electron. Всё мягко: битый, огромный или отсутствующий файл — null, а не исключение.
// Пути строятся только из id по шаблонам и проверяются realpath на принадлежность рабочей папке
// (id из окна не доверяем: «..», «/», символьные ссылки наружу не проходят).
import { closeSync, existsSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { RunState } from '../shared/run-types.ts';

/** id прогона: `YYYY-MM-DD_HHMM` и, при совпадении минуты, `-N` (run-state.ts createRun). */
export const RUN_ID_RE = /^\d{4}-\d{2}-\d{2}_\d{4}(?:-\d{1,4})?$/;
/** Код страны — две латинские заглавные (countries/store.ts). */
export const COUNTRY_RE = /^[A-Z]{2}$/;
/** Предел для JSON-файлов архива: больше — считаем файл повреждённым, не читаем в память. */
export const JSON_MAX_BYTES = 32 * 1024 * 1024;

export const isRunId = (v: unknown): v is string => typeof v === 'string' && RUN_ID_RE.test(v);
export const isCountryCode = (v: unknown): v is string => typeof v === 'string' && COUNTRY_RE.test(v);

/**
 * Читает не больше `max` байт: начало файла (`head`) или конец (`tail`). null — нет файла, не файл, ошибка.
 * Обрезанный многобайтовый символ на границе декодируется как U+FFFD — вызывающий решает, что с ним делать.
 */
export function readLimited(file: string, max: number, from: 'head' | 'tail' = 'head'): { text: string; truncated: boolean } | null {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    const len = Math.min(st.size, Math.max(0, max));
    const pos = from === 'tail' ? st.size - len : 0;
    const buf = Buffer.alloc(len);
    let off = 0;
    while (off < len) {
      const n = readSync(fd, buf, off, len - off, pos + off);
      if (n <= 0) break;
      off += n;
    }
    return { text: new TextDecoder('utf-8').decode(buf.subarray(0, off)), truncated: st.size > len };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* уже закрыт */
      }
    }
  }
}

/** JSON-файл целиком (не больше JSON_MAX_BYTES); нет, битый или слишком большой — null. */
export function readJsonSafe<T>(file: string, max = JSON_MAX_BYTES): T | null {
  const r = readLimited(file, max);
  if (!r || r.truncated) return null;
  try {
    return JSON.parse(r.text) as T;
  } catch {
    return null;
  }
}

/** Путь `inner` лежит внутри `root` (оба — после realpath). */
export function isInside(root: string, inner: string): boolean {
  const base = root.endsWith(sep) ? root : root + sep;
  return inner.startsWith(base);
}

export type ArchivePath =
  | { ok: true; path: string; exists: boolean }
  | { ok: false; reason: 'bad_id' | 'outside' };

/**
 * Папка прогона (`runs/<runId>`) или страны в нём (`runs/<runId>/<code>`).
 * `bad_id` — id не по шаблону; `outside` — существующий путь после realpath уводит из рабочей папки (символьная ссылка).
 */
export function archivePath(workspaceDir: string, runId: unknown, code?: unknown): ArchivePath {
  if (typeof workspaceDir !== 'string' || !workspaceDir) return { ok: false, reason: 'bad_id' };
  if (!isRunId(runId)) return { ok: false, reason: 'bad_id' };
  if (code !== undefined && !isCountryCode(code)) return { ok: false, reason: 'bad_id' };
  const path = code === undefined ? join(workspaceDir, 'runs', runId) : join(workspaceDir, 'runs', runId, code as string);
  if (!existsSync(path)) return { ok: true, path, exists: false };
  try {
    const realWs = realpathSync(workspaceDir);
    const real = realpathSync(path);
    if (!isInside(realWs, real)) return { ok: false, reason: 'outside' };
    return { ok: true, path, exists: true };
  } catch {
    return { ok: false, reason: 'outside' };
  }
}

/** Файл внутри рабочей папки (после realpath); нет файла — тоже false. */
export function fileInsideWorkspace(workspaceDir: string, file: string): boolean {
  try {
    return isInside(realpathSync(workspaceDir), realpathSync(file));
  } catch {
    return false;
  }
}

/** run.json прогона без исключений: нет, битый, не той формы — null. */
export function loadRunSafe(runDirPath: string): RunState | null {
  const s = readJsonSafe<Partial<RunState>>(join(runDirPath, 'run.json'));
  if (!s || typeof s !== 'object' || typeof s.id !== 'string' || typeof s.started_at !== 'string') return null;
  if (!s.countries || typeof s.countries !== 'object' || Array.isArray(s.countries)) return null;
  return s as RunState;
}
