import { useState } from 'react';
import type { Country, WatchedAct } from '../../../shared/types.ts';
import { tc } from '../../strings-countries.ts';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import { Modal } from './Modal.tsx';
import { StateBadge } from './StateBadge.tsx';
import type { DiscoverMode } from './DiscoverDialog.tsx';
import { formatCheckedAt } from './sources-logic.ts';
import { ts } from '../../strings-sources.ts';
import type { SourcesJob } from './useSourcesJob.ts';
import type { RunOp } from './types.ts';

interface Props {
  country: Country;
  run: RunOp;
  job: SourcesJob;
  onDiscover: (mode: DiscoverMode) => void;
}

function ActForm({ code, act, run, onClose }: { code: string; act: WatchedAct | null; run: RunOp; onClose: () => void }) {
  const [title, setTitle] = useState(act?.title ?? '');
  const [number, setNumber] = useState(act?.registrationNumber ?? '');
  const [url, setUrl] = useState(act?.url ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function submit() {
    const input = { title: title.trim(), registrationNumber: number.trim(), url: url.trim() };
    setBusy(true);
    const res = await run(() => (act ? window.rw.acts.update(code, act.id, input) : window.rw.acts.add(code, input)));
    setBusy(false);
    if (!res) return;
    if (res.ok) onClose();
    else setErrors(res.errors);
  }

  return (
    <Modal title={act ? tc.acts.formEdit : tc.acts.formAdd} onClose={onClose}>
      <label className="cty-label" htmlFor="act-title">{tc.acts.fTitle}</label>
      <input id="act-title" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
      {errors['title'] && <div className="error">{errors['title']}</div>}
      <label className="cty-label" htmlFor="act-num">{tc.acts.fNumber}</label>
      <input id="act-num" value={number} onChange={(e) => setNumber(e.target.value)} />
      <div className="muted cty-hint">{tc.acts.fNumberHint}</div>
      {errors['registrationNumber'] && <div className="error">{errors['registrationNumber']}</div>}
      <label className="cty-label" htmlFor="act-url">{tc.acts.fUrl}</label>
      <input id="act-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" />
      {errors['url'] && <div className="error">{errors['url']}</div>}
      <div className="cty-actions">
        <button type="button" onClick={onClose} disabled={busy}>{tc.acts.cancel}</button>
        <button type="button" className="cty-primary" onClick={submit} disabled={busy}>{tc.acts.submit}</button>
      </div>
    </Modal>
  );
}

export function ActsSection({ country, run, job, onDiscover }: Props) {
  const [form, setForm] = useState<{ act: WatchedAct | null } | null>(null);
  const [removing, setRemoving] = useState<WatchedAct | null>(null);

  return (
    <section className="card">
      <div className="card-head">
        <h2>{tc.acts.title}</h2>
        <span className="cty-actions cty-left" style={{ margin: 0 }}>
          <button type="button" disabled={job.busy} title={job.busy ? ts.checkingNow : undefined} onClick={() => onDiscover('watched')}>{ts.discoverActs}</button>
          <button type="button" className="cty-primary" onClick={() => setForm({ act: null })}>{tc.acts.add}</button>
        </span>
      </div>
      <p className="muted">{tc.acts.hint}</p>
      {country.watchedActs.length === 0 ? (
        <p className="muted">{tc.acts.empty}</p>
      ) : (
        <table className="cty-table cty-acts">
          <thead>
            <tr>
              <th>{tc.acts.cols.title}</th>
              <th>{tc.acts.cols.number}</th>
              <th>{tc.acts.cols.link}</th>
              <th>{tc.acts.cols.state}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {country.watchedActs.map((a) => (
              <tr key={a.id}>
                <td>{a.title}</td>
                <td>{a.registrationNumber || '—'}</td>
                <td><a href={a.url} target="_blank" rel="noreferrer">{tc.acts.link}</a></td>
                <td>
                  <StateBadge state={a.state} />
                  {a.stateReason && <div className="muted">{a.stateReason}</div>}
                  <div className="muted">{a.checkedAt ? `${ts.actsCheckedOn} ${formatCheckedAt(a.checkedAt)}` : ts.neverChecked}</div>
                </td>
                <td className="cty-rowactions">
                  <button type="button" onClick={() => setForm({ act: a })}>{tc.acts.edit}</button>
                  <button type="button" onClick={() => setRemoving(a)}>{tc.acts.remove}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {form && <ActForm code={country.code} act={form.act} run={run} onClose={() => setForm(null)} />}
      {removing && (
        <ConfirmDialog
          title={tc.acts.removeTitle}
          text={tc.acts.removeText(removing.title)}
          confirmLabel={tc.acts.remove}
          cancelLabel={tc.remove.cancel}
          onCancel={() => setRemoving(null)}
          onConfirm={async () => {
            const res = await run(() => window.rw.acts.remove(country.code, removing.id));
            if (res) setRemoving(null);
          }}
        />
      )}
    </section>
  );
}
