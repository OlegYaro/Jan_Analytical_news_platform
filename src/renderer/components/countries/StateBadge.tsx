import type { SourceState } from '../../../shared/types.ts';
import { tc } from '../../strings-countries.ts';

export function StateBadge({ state }: { state: SourceState }) {
  const mark = tc.stateMark[state];
  return (
    <span className={`cty-state cty-state-${state}`}>
      {mark && <span aria-hidden="true">{mark} </span>}
      {tc.stateText[state]}
    </span>
  );
}
