import { useState } from 'react';
import type { Source, SourceType } from '../../../shared/types.ts';
import { tc } from '../../strings-countries.ts';
import { ALL_SOURCE_TYPES } from './logic.ts';
import { Modal } from './Modal.tsx';
import type { RunOp } from './types.ts';

interface Props {
  code: string;
  /** Язык по умолчанию для нового источника. */
  defaultLanguage: string;
  source: Source | null;
  run: RunOp;
  onClose: () => void;
}

export function SourceForm({ code, defaultLanguage, source, run, onClose }: Props) {
  const [url, setUrl] = useState(source?.url ?? '');
  const [name, setName] = useState(source?.name ?? '');
  const [type, setType] = useState<SourceType>(source?.type ?? 'legal_base');
  const [language, setLanguage] = useState(source?.language ?? defaultLanguage);
  const [priority, setPriority] = useState<'main' | 'extra'>(source?.priority ?? 'main');
  const [enabled, setEnabled] = useState(source?.enabled ?? true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function submit() {
    const input = { url: url.trim(), name: name.trim(), type, language: language.trim().toLowerCase(), priority, enabled };
    setBusy(true);
    const res = await run(() => (source ? window.rw.sources.update(code, source.id, input) : window.rw.sources.add(code, input)));
    setBusy(false);
    if (!res) return;
    if (res.ok) onClose();
    else setErrors(res.errors);
  }

  return (
    <Modal title={source ? tc.sourceForm.editTitle : tc.sourceForm.addTitle} onClose={onClose}>
      <label className="cty-label" htmlFor="sf-url">{tc.sourceForm.url}</label>
      <input id="sf-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" autoFocus />
      <div className="muted cty-hint">{tc.sourceForm.urlHint}</div>
      {errors['url'] && <div className="error">{errors['url']}</div>}

      <label className="cty-label" htmlFor="sf-type">{tc.sourceForm.type}</label>
      <select id="sf-type" value={type} onChange={(e) => setType(e.target.value as SourceType)}>
        {ALL_SOURCE_TYPES.map((k) => <option key={k} value={k}>{tc.typeHelp[k]}</option>)}
      </select>
      {errors['type'] && <div className="error">{errors['type']}</div>}

      <label className="cty-label" htmlFor="sf-lang">{tc.sourceForm.language}</label>
      <input id="sf-lang" value={language} onChange={(e) => setLanguage(e.target.value)} />
      <div className="muted cty-hint">{tc.sourceForm.languageHint}</div>
      {errors['language'] && <div className="error">{errors['language']}</div>}

      <label className="cty-label" htmlFor="sf-prio">{tc.sourceForm.priority}</label>
      <select id="sf-prio" value={priority} onChange={(e) => setPriority(e.target.value as 'main' | 'extra')}>
        <option value="main">{tc.sources.main}</option>
        <option value="extra">{tc.sources.extra}</option>
      </select>
      {errors['priority'] && <div className="error">{errors['priority']}</div>}

      <label className="cty-check">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> {tc.sourceForm.enabled}
      </label>

      <label className="cty-label" htmlFor="sf-name">{tc.sourceForm.name}</label>
      <input id="sf-name" value={name} onChange={(e) => setName(e.target.value)} />
      <div className="muted cty-hint">{tc.sourceForm.nameHint}</div>
      {errors['name'] && <div className="error">{errors['name']}</div>}

      <div className="cty-actions">
        <button type="button" onClick={onClose} disabled={busy}>{tc.sourceForm.cancel}</button>
        <button type="button" className="cty-primary" onClick={submit} disabled={busy}>{tc.sourceForm.submit}</button>
      </div>
    </Modal>
  );
}
