import { useEffect, useState } from 'react';
import type { HistoryCountryDto } from '../../../shared/history-types.ts';
import { countryDisplayName } from '../../strings-countries.ts';
import { th } from '../../strings-history.ts';
import { flagEmoji } from '../countries/logic.ts';
import { countryStatusText } from '../run/logic.ts';
import { CaseForm } from './CaseForm.tsx';
import { DiscardedTab, FindingsTab, HowTab, LogTab, ReportTab, UsageTab } from './CountryTabs.tsx';
import { FolderButton } from './FolderButton.tsx';

type TabId = keyof typeof th.tabs;
const TABS: TabId[] = ['findings', 'report', 'how', 'discarded', 'log', 'usage'];

interface Props {
  runId: string;
  code: string;
  name: string;
  onBack: () => void;
}

export function CountryView({ runId, code, name, onBack }: Props) {
  const [data, setData] = useState<HistoryCountryDto | null | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [tab, setTab] = useState<TabId>('findings');
  const [missedOpen, setMissedOpen] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let alive = true;
    setData(undefined);
    setFailed(false);
    window.rw.history
      .country(runId, code)
      .then((d) => alive && setData(d))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [runId, code]);

  const title = `${flagEmoji(code)} ${countryDisplayName(code, name)}`;
  return (
    <section className="hist-country" aria-label={title}>
      <button type="button" className="link cty-back" onClick={onBack}>{th.back}</button>
      <h2>{title}</h2>
      {failed && <div className="banner warn">{th.loadError}</div>}
      {!failed && data === undefined && <p className="muted">{th.countryLoading}</p>}
      {!failed && data === null && <p className="muted">{th.countryMissing}</p>}
      {data && (
        <>
          <p className="muted">
            {countryStatusText(data.status)}
            {data.error ? ` · ${th.countryError(data.error)}` : ''}
          </p>
          <div className="hist-actions">
            <FolderButton runId={runId} code={code} />
            <button type="button" onClick={() => setMissedOpen((v) => !v)} aria-expanded={missedOpen} title={th.casesHint}>
              {th.missed}
            </button>
          </div>
          <p className="muted cty-hint">{th.casesHint}</p>
          {saved && <div className="cty-ok" role="status">{th.caseSaved}</div>}
          {missedOpen && (
            <CaseForm
              kind="missed"
              runId={runId}
              country={code}
              title={th.missedTitle}
              onCancel={() => setMissedOpen(false)}
              onDone={() => {
                setMissedOpen(false);
                setSaved(true);
              }}
            />
          )}
          <div className="hist-tabs" role="tablist" aria-label={title}>
            {TABS.map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                className={tab === id ? 'hist-on' : ''}
                onClick={() => setTab(id)}
              >
                {th.tabs[id]}
              </button>
            ))}
          </div>
          <div role="tabpanel" className="hist-panel">
            {tab === 'findings' && <FindingsTab data={data} />}
            {tab === 'report' && <ReportTab data={data} />}
            {tab === 'how' && <HowTab data={data} />}
            {tab === 'discarded' && <DiscardedTab data={data} />}
            {tab === 'log' && <LogTab data={data} />}
            {tab === 'usage' && <UsageTab data={data} />}
          </div>
        </>
      )}
    </section>
  );
}
