import { useEffect, useRef, useState } from 'react';
import type { GoldenCaseInput } from '../../../shared/history-types.ts';
import { currentLang } from '../../i18n.ts';
import { th } from '../../strings-history.ts';
import { validateCaseForm } from './logic.ts';

interface Props {
  kind: 'false_positive' | 'missed';
  runId: string;
  country: string;
  candidateId?: string;
  title: string;
  onDone: () => void;
  onCancel: () => void;
}

/** Небольшая форма «в эталоны»: комментарий (и ссылка для пропущенного акта). */
export function CaseForm({ kind, runId, country, candidateId, title, onDone, onCancel }: Props) {
  const lang = currentLang();
  const [url, setUrl] = useState('');
  const [comment, setComment] = useState('');
  const [errors, setErrors] = useState<{ url?: string; comment?: string }>({});
  const [serverError, setServerError] = useState('');
  const [busy, setBusy] = useState(false);
  const firstRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  useEffect(() => {
    firstRef.current?.focus();
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const errs = validateCaseForm(kind, url, comment, lang);
    setErrors(errs);
    setServerError('');
    if (errs.url || errs.comment) return;
    setBusy(true);
    try {
      const input: GoldenCaseInput = { kind, runId, country, comment: comment.trim() };
      if (kind === 'false_positive') input.candidateId = candidateId;
      else input.url = url.trim();
      const res = await window.rw.history.addCase(input);
      if (res.ok) onDone();
      else setServerError(res.error);
    } catch (err) {
      setServerError(String((err as Error)?.message ?? err));
    } finally {
      setBusy(false);
    }
  }

  const hint = kind === 'missed' ? th.commentHintMissed : th.commentHintFp;
  return (
    <form className="hist-form" onSubmit={submit} aria-label={title}>
      <h4>{title}</h4>
      {kind === 'missed' && (
        <>
          <label className="cty-label" htmlFor={`url-${runId}-${country}`}>{th.urlLabel}</label>
          <input
            id={`url-${runId}-${country}`}
            ref={(el) => {
              firstRef.current = el;
            }}
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            aria-invalid={!!errors.url}
            placeholder="https://"
          />
          {errors.url && <div className="error" role="alert">{errors.url}</div>}
        </>
      )}
      <label className="cty-label" htmlFor={`cm-${runId}-${country}-${candidateId ?? ''}`}>{th.commentLabel}</label>
      <textarea
        id={`cm-${runId}-${country}-${candidateId ?? ''}`}
        ref={(el) => {
          if (kind === 'false_positive') firstRef.current = el;
        }}
        rows={3}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        aria-invalid={!!errors.comment}
      />
      <div className="muted cty-hint">{hint}</div>
      {errors.comment && <div className="error" role="alert">{errors.comment}</div>}
      {serverError && <div className="error" role="alert">{serverError}</div>}
      <div className="hist-actions">
        <button type="submit" className="cty-primary" disabled={busy}>{busy ? th.sending : th.send}</button>
        <button type="button" onClick={onCancel} disabled={busy}>{th.cancel}</button>
      </div>
    </form>
  );
}
