import { useCallback, useEffect, useRef, useState } from 'react';
import type { SourceCheckScope, SourcesStatusDto } from '../../../shared/sources-types.ts';
import { ts } from '../../strings-sources.ts';

export interface SourcesJob {
  status: SourcesStatusDto | null;
  /** Идёт проверка или поиск: кнопки блокируем. */
  busy: boolean;
  /** Отказ контроллера или сбой запуска — показываем как есть. */
  message: string | null;
  /** Итог последней проверки, закончившейся при открытом окне. */
  result: string | null;
  start: (scope: SourceCheckScope) => Promise<boolean>;
  clearMessage: () => void;
}

/** Ход проверки источников: подписка на progress + status; по окончании вызывает onFinished. */
export function useSourcesJob(onFinished: () => void): SourcesJob {
  const [status, setStatus] = useState<SourcesStatusDto | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const wasRunning = useRef(false);
  const finished = useRef(onFinished);
  finished.current = onFinished;

  const apply = useCallback((s: SourcesStatusDto) => {
    setStatus(s);
    if (s.running) wasRunning.current = true;
    else if (wasRunning.current) {
      wasRunning.current = false;
      setResult(s.lastMessage || s.text || ts.finished);
      finished.current();
    }
  }, []);

  useEffect(() => {
    let alive = true;
    window.rw.sources.status().then((s) => alive && apply(s)).catch(() => {});
    let off: (() => void) | undefined;
    try {
      off = window.rw.sources.onProgress((s) => alive && apply(s));
    } catch {
      /* без подписки остаётся опрос ниже */
    }
    return () => {
      alive = false;
      off?.();
    };
  }, [apply]);

  // Страховка: пока идёт проверка, раз в 2 секунды спрашиваем состояние.
  const running = !!status?.running;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      window.rw.sources.status().then(apply).catch(() => {});
    }, 2000);
    return () => clearInterval(timer);
  }, [running, apply]);

  const start = useCallback(
    async (scope: SourceCheckScope): Promise<boolean> => {
      setMessage(null);
      setResult(null);
      setStarting(true);
      try {
        const r = await window.rw.sources.check(scope);
        if (!r.ok) {
          setMessage(r.message);
          return false;
        }
        wasRunning.current = true;
        apply(await window.rw.sources.status());
        return true;
      } catch {
        setMessage(ts.startFailed);
        return false;
      } finally {
        setStarting(false);
      }
    },
    [apply],
  );

  return { status, busy: running || starting, message, result, start, clearMessage: () => setMessage(null) };
}
