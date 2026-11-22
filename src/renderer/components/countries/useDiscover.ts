import { useState } from 'react';
import type { ActProposalDto, SourceProposalDto } from '../../../shared/sources-types.ts';
import { ts } from '../../strings-sources.ts';
import type { DiscoverMode, DiscoverState } from './DiscoverDialog.tsx';
import type { RunOp } from './types.ts';

/** Поиск предложений по стране и «Добавить». Список предложений сам не меняется — только по кнопке. */
export function useDiscover(code: string, run: RunOp) {
  const [state, setState] = useState<DiscoverState | null>(null);

  async function open(mode: DiscoverMode) {
    setState({ mode, loading: true, result: null, failed: false, added: [], addError: '', justAdded: null });
    try {
      const result = await window.rw.sources.discover(code, mode);
      setState((s) => (s ? { ...s, loading: false, result } : s));
    } catch {
      setState((s) => (s ? { ...s, loading: false, failed: true } : s));
    }
  }

  async function addSource(p: SourceProposalDto) {
    setState((s) => (s ? { ...s, addError: '', justAdded: null } : s));
    const res = await run(() => window.rw.sources.acceptSource(code, p));
    if (!res) return;
    if (!res.ok) {
      const text = Object.values(res.errors).join(' ') || ts.dlg.addFailed;
      setState((s) => (s ? { ...s, addError: text } : s));
      return;
    }
    const created = res.countries.find((c) => c.code === code)?.sources.find((x) => x.url === p.url);
    setState((s) => (s ? { ...s, added: [...s.added, p.url], justAdded: created ? { id: created.id, name: created.name } : null } : s));
  }

  async function addAct(p: ActProposalDto) {
    setState((s) => (s ? { ...s, addError: '' } : s));
    const res = await run(() => window.rw.sources.acceptAct(code, p));
    if (!res) return;
    if (!res.ok) {
      const text = Object.values(res.errors).join(' ') || ts.dlg.addFailed;
      setState((s) => (s ? { ...s, addError: text } : s));
      return;
    }
    setState((s) => (s ? { ...s, added: [...s.added, p.url] } : s));
  }

  return { state, open, addSource, addAct, close: () => setState(null) };
}
