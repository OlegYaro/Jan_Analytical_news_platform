// Контракт сетевого слоя сбора (COL-06). Реализация — fetcher.ts; адаптеры и движок профилей зависят только от этих типов.
export interface FetchOk {
  ok: true;
  status: number;
  /** Итоговый адрес после перенаправлений. */
  url: string;
  body: string;
  contentType: string;
  /** Сырые байты ответа: только при `FetchOptions.binary` (PDF); тогда `body` пустой. */
  bytes?: Uint8Array;
}

export type FetchFailureKind = 'network' | 'timeout' | 'http' | 'too_large';

export interface FetchFail {
  ok: false;
  kind: FetchFailureKind;
  status?: number;
  /** Объяснение простыми словами, по-русски. */
  message: string;
}

export type FetchResult = FetchOk | FetchFail;

export interface FetchOptions {
  headers?: Record<string, string>;
  /** Переопределение таймаута, мс (по умолчанию 30000). */
  timeoutMs?: number;
  /** Вернуть сырые байты (`bytes`) вместо декодированного текста — для PDF. */
  binary?: boolean;
}

export interface Fetcher {
  get(url: string, opts?: FetchOptions): Promise<FetchResult>;
  /** POST формы (application/x-www-form-urlencoded); куки сессии сохраняются между вызовами одного Fetcher. */
  postForm(url: string, fields: Record<string, string>, opts?: FetchOptions): Promise<FetchResult>;
}
