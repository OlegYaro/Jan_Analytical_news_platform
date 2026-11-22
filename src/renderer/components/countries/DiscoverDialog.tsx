import type { DiscoverResultDto } from '../../../shared/sources-types.ts';
import { ts } from '../../strings-sources.ts';
import { Modal } from './Modal.tsx';
import { actTypeLabel, languageLabel, sourceTypeHelp } from './sources-logic.ts';

export type DiscoverMode = 'missing' | 'watched';

export interface DiscoverState {
  mode: DiscoverMode;
  loading: boolean;
  result: DiscoverResultDto | null;
  /** Сбой самого запроса (исключение). */
  failed: boolean;
  /** Что уже добавлено (адреса) — для подписи «Добавлено». */
  added: string[];
  /** Ошибка последнего «Добавить». */
  addError: string;
  /** Только что добавленный источник — предложить проверить. */
  justAdded: { id: string; name: string } | null;
}

interface Props {
  state: DiscoverState;
  busy: boolean;
  progressLine: string;
  onAddSource: (p: DiscoverResultDto['sourceProposals'][number]) => void;
  onAddAct: (p: DiscoverResultDto['actProposals'][number]) => void;
  onCheck: (sourceId: string) => void;
  onClose: () => void;
}

export function DiscoverDialog({ state, busy, progressLine, onAddSource, onAddAct, onCheck, onClose }: Props) {
  const r = state.result;
  const sources = r?.sourceProposals ?? [];
  const acts = r?.actProposals ?? [];
  const empty = !!r && r.ok && sources.length === 0 && acts.length === 0;
  const title = state.mode === 'watched' ? ts.dlg.actsTitle : ts.dlg.sourcesTitle;

  return (
    <Modal title={title} onClose={onClose}>
      {state.loading && (
        <div role="status">
          <p>{progressLine || ts.dlg.searching}</p>
          <progress className="src-indeterminate" />
        </div>
      )}
      {state.failed && <div className="banner warn" role="alert">{ts.dlg.failed}</div>}
      {r && !r.ok && <div className="banner warn" role="alert">{r.message}</div>}
      {state.addError && <div className="banner warn" role="alert">{state.addError}</div>}
      {state.justAdded && (
        <div className="cty-soft">
          <div>{ts.dlg.askCheck(state.justAdded.name)}</div>
          <div className="cty-actions cty-left">
            <button type="button" className="cty-primary" disabled={busy} onClick={() => onCheck(state.justAdded!.id)}>{ts.dlg.checkNow}</button>
            <button type="button" onClick={() => onClose()}>{ts.dlg.later}</button>
          </div>
        </div>
      )}
      {empty && (
        <>
          <p>{ts.dlg.nothing}</p>
          <p className="muted">{ts.dlg.nothingHint}</p>
        </>
      )}
      {r?.ok && !empty && <p className="muted">{ts.dlg.note}</p>}

      {sources.map((p) => {
        const done = state.added.includes(p.url);
        return (
          <div key={`${p.type}|${p.url}`} className="cty-source">
            <strong>{p.name}</strong>
            <div><a href={p.url} target="_blank" rel="noreferrer">{p.url}</a></div>
            <div className="muted">{sourceTypeHelp(p.type)} · {ts.dlg.language}: {languageLabel(p.language)}</div>
            {p.checkNote && <div>{ts.dlg.checked}: {p.checkNote}</div>}
            {p.reason && <div className="muted">{ts.dlg.reason}: {p.reason}</div>}
            <div className="cty-actions cty-left">
              {done ? <span className="cty-ok">{ts.dlg.added}</span> : <button type="button" className="cty-primary" disabled={busy} onClick={() => onAddSource(p)}>{ts.dlg.add}</button>}
            </div>
          </div>
        );
      })}

      {acts.map((p) => {
        const done = state.added.includes(p.url);
        return (
          <div key={p.url} className="cty-source">
            <strong>{p.title_original}</strong>
            <div className="muted">
              {ts.dlg.kind}: {actTypeLabel(p.act_type, p.act_type_ru)}
              {p.number && <> · {ts.dlg.number}: {p.number}</>}
              {p.last_edition_date && <> · {ts.dlg.edition}: {p.last_edition_date}</>}
            </div>
            <div><a href={p.url} target="_blank" rel="noreferrer">{p.url}</a></div>
            {p.checkNote && <div>{ts.dlg.checked}: {p.checkNote}</div>}
            {p.reason && <div className="muted">{ts.dlg.reason}: {p.reason}</div>}
            <div className="cty-actions cty-left">
              {done ? <span className="cty-ok">{ts.dlg.added}</span> : <button type="button" className="cty-primary" disabled={busy} onClick={() => onAddAct(p)}>{ts.dlg.add}</button>}
            </div>
          </div>
        );
      })}

      <div className="cty-actions">
        <button type="button" onClick={onClose}>{ts.dlg.close}</button>
      </div>
    </Modal>
  );
}
