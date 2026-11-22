import { useState } from 'react';
import type { Country } from '../../../shared/types.ts';
import { t } from '../../strings.ts';
import { ts } from '../../strings-sources.ts';
import { SourcesProgress } from '../countries/SourcesProgress.tsx';
import { countriesSummary } from '../countries/sources-logic.ts';
import { useSourcesJob } from '../countries/useSourcesJob.ts';

export function StepSources() {
  const [countries, setCountries] = useState<Country[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const job = useSourcesJob(() => {
    window.rw.countries.list().then((c) => { setCountries(c); setLoadFailed(false); }).catch(() => setLoadFailed(true));
  });

  const sum = countries ? countriesSummary(countries) : null;
  const showSummary = !!sum && !job.busy && !!job.result;

  return (
    <section className="card">
      <h2>{t.wizard.sourcesTitle}</h2>
      <p>{ts.wizard.text}</p>
      <button type="button" disabled={job.busy} title={job.busy ? ts.checkingNow : undefined} onClick={() => void job.start({ all: true })}>{t.wizard.checkSources}</button>
      <SourcesProgress job={job} />
      {loadFailed && <p className="error">{t.wizard.countriesLoadError}</p>}
      {showSummary && (
        <div className="src-summary">
          <h3>{ts.wizard.summaryTitle}</h3>
          {sum.ok + sum.warn + sum.fail + sum.unchecked === 0 ? (
            <p className="muted">{ts.wizard.noCountries}</p>
          ) : (
            <p>{ts.wizard.summary(sum.ok, sum.warn, sum.fail, sum.unchecked)}</p>
          )}
          {sum.fail > 0 && <p className="wz-hint">{ts.wizard.failNote}</p>}
        </div>
      )}
    </section>
  );
}
