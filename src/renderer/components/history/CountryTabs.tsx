import { useState } from 'react';
import type { HistoryCountryDto } from '../../../shared/history-types.ts';
import { currentLang } from '../../i18n.ts';
import { th } from '../../strings-history.ts';
import { formatAmount, formatCost } from '../run/logic.ts';
import { CaseForm } from './CaseForm.tsx';
import { discardedByLabel, formatDateTime, groupFields, levelLabel, reasonLabel, unconfirmedLabel, verdictLabel } from './logic.ts';

export function FindingsTab({ data }: { data: HistoryCountryDto }) {
  const lang = currentLang();
  const [formFor, setFormFor] = useState<string | null>(null);
  const [sent, setSent] = useState<Set<string>>(new Set());
  if (data.findings.length === 0) return <p className="muted">{th.noFindings}</p>;
  return (
    <ul className="hist-list">
      {data.findings.map((f) => {
        const marked = f.markedFalsePositive || sent.has(f.candidateId);
        const warn = unconfirmedLabel(f, lang);
        return (
          <li key={f.candidateId} className="hist-finding">
            <div className="hist-finding-head">
              <a href={f.url} target="_blank" rel="noreferrer">{f.title || f.url}</a>
              <span className={`hist-level hist-level-${f.level}`}>{levelLabel(f.level, lang)}</span>
            </div>
            {warn && <div className="hist-warn">{warn}</div>}
            {f.reason && <div className="muted">{th.reasonPrefix}{reasonLabel(f.reason, lang)}</div>}
            <div className="hist-actions">
              {marked ? (
                <span className="cty-ok">{th.fpMarked}</span>
              ) : (
                <button type="button" onClick={() => setFormFor(formFor === f.candidateId ? null : f.candidateId)} aria-expanded={formFor === f.candidateId}>
                  {th.falsePositive}
                </button>
              )}
            </div>
            {formFor === f.candidateId && !marked && (
              <CaseForm
                kind="false_positive"
                runId={data.runId}
                country={data.code}
                candidateId={f.candidateId}
                title={th.fpTitle}
                onCancel={() => setFormFor(null)}
                onDone={() => {
                  setSent((s) => new Set(s).add(f.candidateId));
                  setFormFor(null);
                }}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function ReportTab({ data }: { data: HistoryCountryDto }) {
  const [rep, setRep] = useState<'ru' | 'en'>(currentLang());
  const text = rep === 'ru' ? data.reportRu : data.reportEn;
  const none = data.reportRu === null && data.reportEn === null ? th.reportNone : rep === 'ru' ? th.reportNoRu : th.reportNoEn;
  return (
    <div>
      <div className="hist-switch" role="group" aria-label={th.reportLang}>
        {(['ru', 'en'] as const).map((l) => (
          <button key={l} type="button" className={l === rep ? 'hist-on' : ''} aria-pressed={l === rep} onClick={() => setRep(l)}>
            {l.toUpperCase()}
          </button>
        ))}
      </div>
      {text ? <pre className="hist-report" tabIndex={0}>{text}</pre> : <p className="muted">{none}</p>}
    </div>
  );
}

export function HowTab({ data }: { data: HistoryCountryDto }) {
  const lang = currentLang();
  if (data.verification.length === 0) return <p className="muted">{th.howEmpty}</p>;
  const titles = new Map(data.findings.map((f) => [f.candidateId, f.title]));
  return (
    <ul className="hist-list">
      {data.verification.map((v) => (
        <li key={v.candidateId} className="hist-finding">
          <strong>{titles.get(v.candidateId) || v.candidateId}</strong>
          <div className="muted">{th.verdict}{verdictLabel(v.verdict, lang)}</div>
          {groupFields(v.fields, lang).map((g) => (
            <div key={g.status} className="hist-group">
              <div className={`hist-group-title hist-fs-${g.status}`}>{g.label}</div>
              <ul>
                {g.fields.map((f) => (
                  <li key={f.field}>
                    <code>{f.field}</code>
                    {f.comment ? ` — ${f.comment}` : ''}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </li>
      ))}
    </ul>
  );
}

export function DiscardedTab({ data }: { data: HistoryCountryDto }) {
  const lang = currentLang();
  if (data.discarded.length === 0) return <p className="muted">{th.discardedEmpty}</p>;
  return (
    <table className="cty-table">
      <thead>
        <tr>
          <th>{th.discCols.title}</th>
          <th>{th.discCols.issuer}</th>
          <th>{th.discCols.by}</th>
          <th>{th.discCols.reason}</th>
        </tr>
      </thead>
      <tbody>
        {data.discarded.map((d) => (
          <tr key={d.candidateId}>
            <td><a href={d.url} target="_blank" rel="noreferrer">{d.title || d.url}</a></td>
            <td>{d.issuer || th.dash}</td>
            <td>{discardedByLabel(d.by, lang)}</td>
            <td>{reasonLabel(d.reason, lang)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function LogTab({ data }: { data: HistoryCountryDto }) {
  const lang = currentLang();
  if (data.log.length === 0) return <p className="muted">{th.logEmpty}</p>;
  return (
    <ul className="hist-log">
      {data.log.map((l, i) => (
        <li key={i}>
          <span className="muted">{formatDateTime(l.ts, lang)}</span> {l.text}
        </li>
      ))}
    </ul>
  );
}

export function UsageTab({ data }: { data: HistoryCountryDto }) {
  const u = data.usage;
  if (!u || (u.costUsd === 0 && u.input === 0 && u.output === 0 && u.cacheRead === 0 && u.cacheWrite === 0)) {
    return <p className="muted">{th.usageEmpty}</p>;
  }
  const rows: Array<[string, string]> = [
    [th.usageCost, formatCost(u.costUsd)],
    [th.usageRead, formatAmount(u.input)],
    [th.usageCached, formatAmount(u.cacheRead)],
    [th.usageWritten, formatAmount(u.cacheWrite)],
    [th.usageWrittenOut, formatAmount(u.output)],
  ];
  return (
    <table className="hist-usage">
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k}>
            <th scope="row">{k}</th>
            <td>{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
