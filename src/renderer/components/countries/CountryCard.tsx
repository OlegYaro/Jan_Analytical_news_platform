import { useEffect, useState } from 'react';
import type { Country } from '../../../shared/types.ts';
import { tc, countryDisplayName } from '../../strings-countries.ts';
import { IssuerRules } from './IssuerRules.tsx';
import { ActsSection } from './ActsSection.tsx';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import { flagEmoji, parseLanguages } from './logic.ts';
import { DiscoverDialog } from './DiscoverDialog.tsx';
import { hasFailedSources, progressText } from './sources-logic.ts';
import { useDiscover } from './useDiscover.ts';
import type { SourcesJob } from './useSourcesJob.ts';
import { ts } from '../../strings-sources.ts';
import { SourcesSection } from './SourcesSection.tsx';
import type { RunOp } from './types.ts';
import { useRunStatus } from '../run/useRunStatus.ts';
import { th } from '../../strings-home.ts';

interface Props {
  country: Country;
  run: RunOp;
  job: SourcesJob;
  onBack: () => void;
}

export function CountryCard({ country, run, job, onBack }: Props) {
  const discover = useDiscover(country.code, run);
  const [name, setName] = useState(country.name);
  const [languages, setLanguages] = useState(country.languages.join(', '));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const { status, refresh } = useRunStatus();
  const [starting, setStarting] = useState(false);
  const [startMsg, setStartMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const canCheck = !!status?.canStart && country.active && !starting;
  const blockedWhy = !country.active ? th.checkCountryOff : status?.startBlockedReason ?? '';

  async function checkThis() {
    setStarting(true);
    setStartMsg(null);
    try {
      const r = await window.rw.run.start('manual', { countries: [country.code] });
      setStartMsg({ ok: r.ok, text: r.message });
      refresh();
    } catch {
      setStartMsg({ ok: false, text: th.startFailed });
    } finally {
      setStarting(false);
    }
  }

  useEffect(() => {
    setName(country.name);
    setLanguages(country.languages.join(', '));
  }, [country.code, country.name, country.languages.join(',')]);

  async function save() {
    setSaved(false);
    const res = await run(() => window.rw.countries.update(country.code, { name: name.trim(), languages: parseLanguages(languages) }));
    if (!res) return;
    setErrors(res.ok ? {} : res.errors);
    setSaved(res.ok);
  }

  return (
    <div className={country.active ? undefined : 'cty-off-page'}>
      <button type="button" className="link cty-back" onClick={onBack}>{tc.back}</button>
      <h1>
        <span aria-hidden="true">{flagEmoji(country.code)}</span> {countryDisplayName(country.code, country.name)}
      </h1>

      <section className="card">
        <label className="cty-check">
          <input type="checkbox" role="switch" checked={country.active} onChange={(e) => void run(() => window.rw.countries.setActive(country.code, e.target.checked))} /> {tc.card.active}
        </label>
        {!country.active && <div className="muted">{tc.inactiveHint}</div>}

        <label className="cty-label" htmlFor="cc-name">{tc.card.name}</label>
        <input id="cc-name" value={name} onChange={(e) => { setName(e.target.value); setSaved(false); }} />
        {errors['name'] && <div className="error">{errors['name']}</div>}

        <label className="cty-label" htmlFor="cc-langs">{tc.card.languages}</label>
        <input id="cc-langs" value={languages} onChange={(e) => { setLanguages(e.target.value); setSaved(false); }} />
        <div className="muted cty-hint">{tc.add.languagesHint}</div>
        {errors['languages'] && <div className="error">{errors['languages']}</div>}

        <div className="cty-actions cty-left">
          <button type="button" className="cty-primary" onClick={save}>{tc.card.save}</button>
          {saved && <span className="cty-ok">{tc.card.saved}</span>}
          <span className="cty-spacer" />
          <button type="button" className="cty-danger-outline" onClick={() => setConfirmRemove(true)}>{tc.remove.button}</button>
        </div>
      </section>

      <section className="card">
        <div className="cty-actions cty-left">
          <button type="button" disabled={!canCheck} title={canCheck ? undefined : blockedWhy} onClick={() => void checkThis()}>
            {starting ? th.checkCountryBusy : th.checkCountry}
          </button>
        </div>
        <div className="muted cty-hint">{th.checkCountryHint}</div>
        {!canCheck && !starting && blockedWhy && <div className="run-actions-msg">{blockedWhy}</div>}
        {startMsg && <div className={startMsg.ok ? 'run-actions-msg' : 'run-actions-msg error'}>{startMsg.text}</div>}
      </section>

      <IssuerRules country={country} run={run} />

      {hasFailedSources(country.sources) && <div className="banner warn" role="alert">{ts.failWarning}</div>}
      <SourcesSection country={country} run={run} job={job} onDiscover={(m) => void discover.open(m)} />
      <ActsSection country={country} run={run} job={job} onDiscover={(m) => void discover.open(m)} />
      {discover.state && (
        <DiscoverDialog
          state={discover.state}
          busy={job.busy && !discover.state.loading}
          progressLine={job.status?.running ? progressText(job.status) : ''}
          onAddSource={(p) => void discover.addSource(p)}
          onAddAct={(p) => void discover.addAct(p)}
          onCheck={(id) => {
            discover.close();
            void job.start({ code: country.code, sourceId: id });
          }}
          onClose={discover.close}
        />
      )}

      <section className="card">
        <div className="card-head"><h2>{tc.findings.title}</h2></div>
        <p>{tc.findings.empty}</p>
        <p className="muted">{tc.findings.note}</p>
      </section>

      {confirmRemove && (
        <ConfirmDialog
          title={tc.remove.title}
          text={tc.remove.text}
          confirmLabel={tc.remove.confirm}
          cancelLabel={tc.remove.cancel}
          onCancel={() => setConfirmRemove(false)}
          onConfirm={async () => {
            const res = await run(() => window.rw.countries.remove(country.code));
            if (res?.ok) onBack();
            else setConfirmRemove(false);
          }}
        />
      )}
    </div>
  );
}
