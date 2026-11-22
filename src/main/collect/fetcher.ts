// Сетевой слой сбора (COL-06): таймаут, повторы, вежливая задержка на домен, куки сессии, кодировки.
import type { FetchFail, FetchOptions, FetchResult, Fetcher } from './fetcher-types.ts';

export const DEFAULT_USER_AGENT = 'RegWatch/0.1 (мониторинг нормативных актов)';

export interface FetcherConfig {
  userAgent?: string;
  /** Таймаут одного запроса, мс. */
  timeoutMs?: number;
  /** Сколько раз повторять при сбое (не считая первой попытки). */
  retries?: number;
  /** Паузы перед повторами, мс (если повторов больше — берётся последняя). */
  retryPauseMs?: number[];
  /** Минимум между запросами к одному домену, мс. */
  perDomainDelayMs?: number;
  maxBytes?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const MAX_REDIRECTS = 10;

/** fetch принимает в заголовках только Latin-1: кириллицу отправляем как сырые байты UTF-8. */
function toByteString(v: string): string {
  return /^[\x00-\xff]*$/.test(v) ? v : Buffer.from(v, 'utf8').toString('latin1');
}

class TooLargeError extends Error {}
class TimeoutError extends Error {}

/** Декодирует байты по charset из Content-Type или meta/xml-декларации; по умолчанию utf-8. */
export function decodeBody(bytes: Uint8Array, contentType: string): string {
  let charset = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType)?.[1];
  if (!charset) {
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 4096));
    charset =
      /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head)?.[1] ??
      /^\s*<\?xml[^>]+encoding\s*=\s*["']([\w.:-]+)["']/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

export function createFetcher(cfg: FetcherConfig = {}): Fetcher {
  const userAgent = cfg.userAgent ?? DEFAULT_USER_AGENT;
  const defTimeout = cfg.timeoutMs ?? 30000;
  const retries = cfg.retries ?? 2;
  const pauses = cfg.retryPauseMs ?? [1000, 3000];
  const domainDelay = cfg.perDomainDelayMs ?? 1000;
  const maxBytes = cfg.maxBytes ?? 15_000_000;
  const doFetch = cfg.fetchImpl ?? fetch;
  const sleep = cfg.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = cfg.now ?? Date.now;

  // Очередь на домен: каждый запрос ждёт предыдущего слота и затем не раньше delay после его старта.
  const tails = new Map<string, Promise<void>>();
  const lastStart = new Map<string, number>();
  const cookies = new Map<string, Map<string, string>>();

  function acquireSlot(host: string): Promise<void> {
    const prev = tails.get(host) ?? Promise.resolve();
    const mine = prev.then(async () => {
      const last = lastStart.get(host);
      if (last !== undefined) {
        const wait = last + domainDelay - now();
        if (wait > 0) await sleep(wait);
      }
      lastStart.set(host, now());
    });
    tails.set(host, mine);
    return mine;
  }

  function storeCookies(host: string, res: Response): void {
    const list = res.headers.getSetCookie?.() ?? [];
    if (list.length === 0) return;
    const jar = cookies.get(host) ?? new Map<string, string>();
    for (const line of list) {
      const pair = line.split(';')[0] ?? '';
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = /;\s*max-age\s*=\s*0\b/i.test(line);
      if (expired || value === '') jar.delete(name);
      else jar.set(name, value);
    }
    cookies.set(host, jar);
  }

  async function readBody(res: Response, signal: AbortSignal): Promise<Uint8Array> {
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      void res.body?.cancel().catch(() => {});
      throw new TooLargeError();
    }
    if (!res.body) return new Uint8Array(0);
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      if (signal.aborted) throw new TimeoutError();
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new TooLargeError();
      }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.byteLength;
    }
    return out;
  }

  /** Одна попытка (с переходом по редиректам). Возвращает результат; ошибки возвращает как FetchFail. */
  async function attempt(
    method: 'GET' | 'POST',
    startUrl: string,
    body: string | undefined,
    opts: FetchOptions | undefined,
  ): Promise<FetchResult> {
    const timeoutMs = opts?.timeoutMs ?? defTimeout;
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, timeoutMs);
    try {
      let url = startUrl;
      let m = method;
      let payload = body;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const u = new URL(url);
        await acquireSlot(u.host);
        const headers: Record<string, string> = {
          'User-Agent': userAgent,
          Accept: '*/*',
          ...(opts?.headers ?? {}),
        };
        const jar = cookies.get(u.host);
        if (jar && jar.size > 0 && !Object.keys(headers).some((k) => k.toLowerCase() === 'cookie')) {
          headers['Cookie'] = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
        }
        if (m === 'POST') headers['Content-Type'] = 'application/x-www-form-urlencoded';
        for (const k of Object.keys(headers)) headers[k] = toByteString(headers[k] as string);
        const res = await doFetch(url, {
          method: m,
          headers,
          body: m === 'POST' ? payload : undefined,
          redirect: 'manual',
          signal: ctrl.signal,
        });
        storeCookies(u.host, res);
        if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
          void res.body?.cancel().catch(() => {});
          url = new URL(res.headers.get('location') as string, url).href;
          if (res.status !== 307 && res.status !== 308) {
            m = 'GET';
            payload = undefined;
          }
          continue;
        }
        if (res.status >= 300) {
          void res.body?.cancel().catch(() => {});
          return httpFail(res.status);
        }
        const bytes = await readBody(res, ctrl.signal);
        const contentType = res.headers.get('content-type') ?? '';
        if (opts?.binary) return { ok: true, status: res.status, url, body: '', contentType, bytes };
        return { ok: true, status: res.status, url, body: decodeBody(bytes, contentType), contentType };
      }
      return { ok: false, kind: 'network', message: 'Сайт слишком много раз перенаправляет запрос' };
    } catch (e) {
      if (e instanceof TooLargeError) {
        return {
          ok: false,
          kind: 'too_large',
          message: `Страница слишком большая (больше ${Math.round(maxBytes / 1_000_000)} МБ)`,
        };
      }
      if (timedOut || e instanceof TimeoutError) {
        return { ok: false, kind: 'timeout', message: `Сайт не отвечает за ${Math.round(timeoutMs / 1000)} секунд` };
      }
      if (e instanceof TypeError && /Invalid URL/i.test(e.message)) {
        return { ok: false, kind: 'network', message: 'Некорректный адрес страницы' };
      }
      return {
        ok: false,
        kind: 'network',
        message: 'Нет соединения с сайтом (проверьте интернет и адрес источника)',
      };
    } finally {
      clearTimeout(timer);
    }
  }

  function httpFail(status: number): FetchFail {
    const hint = status === 404 ? ' (страница не найдена)' : status === 429 ? ' (слишком частые запросы)' : '';
    return { ok: false, kind: 'http', status, message: `Сайт вернул ошибку ${status}${hint}` };
  }

  const retryable = (r: FetchFail): boolean =>
    r.kind === 'network' || r.kind === 'timeout' || (r.kind === 'http' && (r.status === 429 || (r.status ?? 0) >= 500));

  async function run(
    method: 'GET' | 'POST',
    url: string,
    body: string | undefined,
    opts: FetchOptions | undefined,
  ): Promise<FetchResult> {
    let last: FetchResult | undefined;
    for (let i = 0; i <= retries; i++) {
      if (i > 0) await sleep(pauses[Math.min(i - 1, pauses.length - 1)] ?? 1000);
      last = await attempt(method, url, body, opts);
      if (last.ok || !retryable(last)) return last;
    }
    return last as FetchResult;
  }

  return {
    get: (url, opts) => run('GET', url, undefined, opts),
    postForm: (url, fields, opts) => run('POST', url, new URLSearchParams(fields).toString(), opts),
  };
}
