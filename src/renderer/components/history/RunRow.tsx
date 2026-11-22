import { useState } from 'react';
import type { HistoryRunDto } from '../../../shared/history-types.ts';
import { currentLang } from '../../i18n.ts';
import { countryDisplayName } from '../../strings-countries.ts';
import { th } from '../../strings-history.ts';
import { flagEmoji } from '../countries/logic.ts';
import { countryStatusText, countryTone, modeLabel } from '../run/logic.ts';
import { CaseForm } from './CaseForm.tsx';
import { FolderButton } from './FolderButton.tsx';
import { foundLabel, formatDateTime, mailLabel, mailTone, runFlags } from './logic.ts';

interface Props {
  run: HistoryRunDto;
  names: Record<string, string>;
  open: boolean;
  onToggle: () => void;
  onCountry: (code: string) => void;
}

export function RunRow({ run, names, open, onToggle, onCountry }: Props) {
  const lang = currentLang();
  const [missedOpen, setMissedOpen] = useState(false);
  const [missedCountry, setMissedCountry] = useState(run.countries[0]?.code ?? '');
  const [saved, setSaved] = useState(false);
  const flags = runFlags(run, lang);
  const panelId = `run-${run.id}`;
  return (
    <li className="card hist-run">
      <button type="button" className="hist-run-head" aria-expanded={open} aria-controls={panelId} onClick={onToggle} title={open ? th.collapse : th.expand}>
        <span className="hist-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
        <span className="hist-when">{formatDateTime(run.startedAt, lang)}</span>
        <span className="hist-mode">{modeLabel(run.mode)}</span>
        <span>{th.checked(run.checked.ok, run.checked.total)}</span>
        <span className="hist-found">{foundLabel(run.found, lang)}</span>
        <span className={`hist-mail hist-mail-${mailTone(run.mail)}`}>{mailLabel(run.mail, lang)}</span>
        {flags.map((f) => (
          <span key={f} className="hist-flag">{f}</span>
        ))}
      </button>
      {open && (
        <div id={panelId} className="hist-run-body">
          <div className="hist-actions">
            <FolderButton runId={run.id} />
            <button type="button" onClick={() => setMissedOpen((v) => !v)} aria-expanded={missedOpen} title={th.casesHint}>
              {th.missed}
            </button>
          </div>
          <p className="muted cty-hint">{th.casesHint}</p>
          {saved && <div className="cty-ok" role="status">{th.caseSaved}</div>}
          {missedOpen && (
            <>
              {run.countries.length > 1 && (
                <label className="cty-label">
                  {th.missedCountry}{' '}
                  <select value={missedCountry} onChange={(e) => setMissedCountry(e.target.value)}>
                    {run.countries.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.code}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            <CaseForm
              key={missedCountry}
              kind="missed"
              runId={run.id}
              country={missedCountry}
              title={th.missedTitle}
              onCancel={() => setMissedOpen(false)}
              onDone={() => {
                setMissedOpen(false);
                setSaved(true);
              }}
            />
            </>
          )}
          <h3>{th.countries}</h3>
          {run.countries.length === 0 ? (
            <p className="muted">{th.noCountries}</p>
          ) : (
            <ul className="hist-countries">
              {run.countries.map((c) => (
                <li key={c.code}>
                  <button type="button" className="hist-country-btn" onClick={() => onCountry(c.code)}>
                    <span aria-hidden="true">{flagEmoji(c.code)}</span>
                    <span className="cty-name">{countryDisplayName(c.code, names[c.code] ?? c.code)}</span>
                    <span className={`hist-status hist-status-${countryTone(c.status)}`}>{countryStatusText(c.status)}</span>
                    <span className="muted">{foundLabel({ material: c.material, forInfo: c.forInfo, unverified: c.unverified }, lang)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}
