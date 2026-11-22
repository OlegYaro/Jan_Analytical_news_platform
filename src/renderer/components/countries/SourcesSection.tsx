import { useState } from 'react';
import type { Country, Source } from '../../../shared/types.ts';
import { tc } from '../../strings-countries.ts';
import { ts } from '../../strings-sources.ts';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import { missingSourceTypes } from './logic.ts';
import { formatCheckedAt, sourceTypeHelp } from './sources-logic.ts';
import { SourceForm } from './SourceForm.tsx';
import { StateBadge } from './StateBadge.tsx';
import type { DiscoverMode } from './DiscoverDialog.tsx';
import { SourcesProgress } from './SourcesProgress.tsx';
import type { SourcesJob } from './useSourcesJob.ts';
import type { RunOp } from './types.ts';

interface Props {
  country: Country;
  run: RunOp;
  job: SourcesJob;
  onDiscover: (mode: DiscoverMode) => void;
}

export function SourcesSection({ country, run, job, onDiscover }: Props) {
  const [form, setForm] = useState<{ source: Source | null } | null>(null);
  const [removing, setRemoving] = useState<Source | null>(null);
  const missing = missingSourceTypes(country.sources);

  return (
    <section className="card">
      <div className="card-head">
        <h2>{tc.sources.title}</h2>
        <button type="button" className="cty-primary" onClick={() => setForm({ source: null })}>{tc.sources.add}</button>
      </div>

      <SourcesProgress job={job} />
      {missing.length > 0 && <div className="cty-soft">{tc.sources.missing(missing.map((m) => tc.type[m]))}</div>}
      {country.sources.length === 0 && <p className="muted">{tc.sources.empty}</p>}

      {country.sources.map((s) => (
        <div key={s.id} className={s.enabled ? 'cty-source' : 'cty-source cty-off'}>
          <div className="cty-source-head">
            <strong>{s.name}</strong>
            <label className="cty-check">
              <input type="checkbox" role="switch" checked={s.enabled} onChange={(e) => void run(() => window.rw.sources.update(country.code, s.id, { enabled: e.target.checked }))} /> {tc.sources.enabled}
            </label>
          </div>
          <div>
            <a href={s.url} target="_blank" rel="noreferrer">{s.url}</a>
          </div>
          <div className="muted">
            {sourceTypeHelp(s.type)} · {tc.sources.language}: {s.language} · {s.priority === 'main' ? tc.sources.main : tc.sources.extra}
          </div>
          <div>
            <StateBadge state={s.state} />
            {s.stateReason && <span className="muted"> — {s.stateReason}</span>}
            <span className="muted"> · {s.checkedAt ? `${tc.sources.checkedOn} ${formatCheckedAt(s.checkedAt)}` : ts.neverChecked}</span>
          </div>
          {s.state === 'fail' && s.enabled && <div className="error">{ts.failNotUsed}</div>}
          <details className="cty-seen">
            <summary>{tc.sources.seen}</summary>
            {s.seenLatest.length === 0 ? (
              <div className="muted">{tc.sources.seenEmpty}</div>
            ) : (
              <ul>
                {s.seenLatest.slice(0, 5).map((it, i) => (
                  <li key={i}>
                    {it.date && <span className="muted">{it.date} · </span>}
                    {it.url ? <a href={it.url} target="_blank" rel="noreferrer">{it.title}</a> : it.title}
                  </li>
                ))}
              </ul>
            )}
          </details>
          <div className="cty-actions cty-left">
            <button type="button" onClick={() => setForm({ source: s })}>{tc.sources.edit}</button>
            <button type="button" onClick={() => setRemoving(s)}>{tc.sources.remove}</button>
            <button type="button" disabled={job.busy} title={job.busy ? ts.checkingNow : undefined} onClick={() => void job.start({ code: country.code, sourceId: s.id })}>{tc.sources.checkOne}</button>
          </div>
        </div>
      ))}

      <div className="cty-actions cty-left">
        <button type="button" disabled={job.busy} title={job.busy ? ts.checkingNow : undefined} onClick={() => void job.start({ code: country.code })}>{tc.sources.checkCountry}</button>
        {missing.length > 0 && <button type="button" disabled={job.busy} title={job.busy ? ts.checkingNow : undefined} onClick={() => onDiscover('missing')}>{tc.sources.discover}</button>}
      </div>

      {form && (
        <SourceForm code={country.code} defaultLanguage={country.languages[0] ?? ''} source={form.source} run={run} onClose={() => setForm(null)} />
      )}
      {removing && (
        <ConfirmDialog
          title={tc.sources.removeTitle}
          text={tc.sources.removeText(removing.name)}
          confirmLabel={tc.sources.remove}
          cancelLabel={tc.remove.cancel}
          onCancel={() => setRemoving(null)}
          onConfirm={async () => {
            const res = await run(() => window.rw.sources.remove(country.code, removing.id));
            if (res) setRemoving(null);
          }}
        />
      )}
    </section>
  );
}
