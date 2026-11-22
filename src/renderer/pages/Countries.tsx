import { useCallback, useEffect, useState } from 'react';
import type { CountriesResult } from '../../shared/api.ts';
import type { Country, Settings } from '../../shared/types.ts';
import { AddCountryDialog } from '../components/countries/AddCountryDialog.tsx';
import { CountriesTable } from '../components/countries/CountriesTable.tsx';
import { CountryCard } from '../components/countries/CountryCard.tsx';
import { SourcesProgress } from '../components/countries/SourcesProgress.tsx';
import { useSourcesJob } from '../components/countries/useSourcesJob.ts';
import { tc } from '../strings-countries.ts';
import { ts } from '../strings-sources.ts';
import '../styles-countries.css';
import '../styles-sources.css';

interface Props {
  settings?: Settings | null;
}

export function CountriesPage(_props: Props) {
  const [countries, setCountries] = useState<Country[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [openCode, setOpenCode] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [banner, setBanner] = useState(false);

  useEffect(() => {
    window.rw.countries.list().then(setCountries).catch(() => setLoadFailed(true));
  }, []);

  const run = useCallback(async (op: () => Promise<CountriesResult>): Promise<CountriesResult | null> => {
    try {
      const res = await op();
      setCountries(res.countries);
      setBanner(false);
      return res;
    } catch {
      setBanner(true);
      return null;
    }
  }, []);

  const job = useSourcesJob(() => {
    window.rw.countries.list().then(setCountries).catch(() => {});
  });

  const opened = openCode ? countries?.find((c) => c.code === openCode) : undefined;

  let body;
  if (loadFailed) body = <div className="banner warn">{tc.loadError}</div>;
  else if (!countries) body = <p className="muted">{tc.loading}</p>;
  else if (openCode && opened) body = <CountryCard country={opened} run={run} job={job} onBack={() => setOpenCode(null)} />;
  else
    body = (
      <>
        <h1>{tc.title}</h1>
        <div className="cty-toolbar">
          <button type="button" className="cty-primary" onClick={() => setAdding(true)}>{tc.addCountry}</button>
          <button type="button" disabled={job.busy} title={job.busy ? ts.checkingNow : undefined} onClick={() => void job.start({ all: true })}>{tc.checkAll}</button>
        </div>
        <SourcesProgress job={job} />
        {countries.length === 0 ? <p className="muted">{tc.empty}</p> : <CountriesTable countries={countries} run={run} onOpen={setOpenCode} />}
        {adding && <AddCountryDialog existingCodes={countries.map((c) => c.code)} run={run} onClose={() => setAdding(false)} />}
      </>
    );

  return (
    <>
      {banner && <div className="banner warn">{tc.saveError}</div>}
      {body}
    </>
  );
}
