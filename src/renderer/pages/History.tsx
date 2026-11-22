import { useCallback, useEffect, useState } from 'react';
import type { HistoryRunDto } from '../../shared/history-types.ts';
import { CountryView } from '../components/history/CountryView.tsx';
import { RunRow } from '../components/history/RunRow.tsx';
import { useKnownCountries } from '../components/settings/useCountryNames.ts';
import { th } from '../strings-history.ts';
import '../styles-countries.css';
import '../styles-history.css';

export function HistoryPage() {
  const [runs, setRuns] = useState<HistoryRunDto[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [sel, setSel] = useState<{ runId: string; code: string } | null>(null);
  const known = useKnownCountries();
  const names: Record<string, string> = {};
  for (const c of known) names[c.code] = c.name;

  const load = useCallback(() => {
    setBusy(true);
    setFailed(false);
    window.rw.history
      .list()
      .then(setRuns)
      .catch(() => setFailed(true))
      .finally(() => setBusy(false));
  }, []);

  useEffect(load, [load]);

  if (sel) {
    return <CountryView runId={sel.runId} code={sel.code} name={names[sel.code] ?? sel.code} onBack={() => setSel(null)} />;
  }

  return (
    <>
      <div className="card-head">
        <h1>{th.title}</h1>
        <button type="button" onClick={load} disabled={busy}>{th.refresh}</button>
      </div>
      {failed && <div className="banner warn">{th.loadError}</div>}
      {!failed && runs === null && <p className="muted">{th.loading}</p>}
      {runs && runs.length === 0 && <p className="muted">{th.empty}</p>}
      {runs && runs.length > 0 && (
        <ul className="hist-runs">
          {runs.map((r) => (
            <RunRow
              key={r.id}
              run={r}
              names={names}
              open={openId === r.id}
              onToggle={() => setOpenId(openId === r.id ? null : r.id)}
              onCountry={(code) => setSel({ runId: r.id, code })}
            />
          ))}
        </ul>
      )}
    </>
  );
}
