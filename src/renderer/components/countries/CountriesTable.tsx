import type { Country } from '../../../shared/types.ts';
import { tc, countryDisplayName } from '../../strings-countries.ts';
import { countryHealth, flagEmoji, formatCheckedDate } from './logic.ts';
import { hasFailedSources, lastCheckIso, sourcesSummaryText } from './sources-logic.ts';
import { ts } from '../../strings-sources.ts';
import type { RunOp } from './types.ts';

interface Props {
  countries: Country[];
  run: RunOp;
  onOpen: (code: string) => void;
}

export function CountriesTable({ countries, run, onOpen }: Props) {
  return (
    <table className="cty-table">
      <thead>
        <tr>
          <th>{tc.cols.active}</th>
          <th>{tc.cols.country}</th>
          <th>{tc.cols.sources}</th>
          <th>{tc.cols.state}</th>
          <th>{tc.cols.checked}</th>
          <th>{tc.cols.result}</th>
        </tr>
      </thead>
      <tbody>
        {countries.map((c) => {
          const health = countryHealth(c.sources);
          return (
            <tr key={c.code} className={c.active ? 'cty-row' : 'cty-row cty-off'} title={c.active ? undefined : tc.inactiveHint} onClick={() => onOpen(c.code)}>
              <td onClick={(e) => e.stopPropagation()}>
                <input
                  type="checkbox"
                  className="cty-switch"
                  role="switch"
                  aria-label={`${tc.cols.active}: ${countryDisplayName(c.code, c.name)}`}
                  checked={c.active}
                  onChange={(e) => void run(() => window.rw.countries.setActive(c.code, e.target.checked))}
                />
              </td>
              <td className="cty-name">
                <span aria-hidden="true">{flagEmoji(c.code)}</span> {countryDisplayName(c.code, c.name)}
                {hasFailedSources(c.sources) && <span className="cty-state-warn" title={ts.failBadgeHint} aria-label={ts.failBadgeHint}> {ts.failBadge}</span>}
              </td>
              <td>{tc.sourcesCount(c.sources.length)}</td>
              <td className={`cty-state cty-state-${health}`}>{sourcesSummaryText(c.sources)}</td>
              <td>{formatCheckedDate(lastCheckIso(c))}</td>
              <td>{c.lastRunSummary || tc.noRunYet}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
