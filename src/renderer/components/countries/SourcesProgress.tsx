import { ts } from '../../strings-sources.ts';
import { progressFraction, progressText } from './sources-logic.ts';
import type { SourcesJob } from './useSourcesJob.ts';

/** Ход проверки, отказ контроллера и итог последней проверки. */
export function SourcesProgress({ job }: { job: SourcesJob }) {
  const s = job.status;
  return (
    <>
      {job.message && <div className="banner warn" role="alert">{job.message}</div>}
      {s?.running && (
        <div className="src-progress" role="status">
          <div>{progressText(s) || ts.checkingNow}</div>
          <progress value={progressFraction(s)} max={1} />
        </div>
      )}
      {!s?.running && job.result && <div className="src-result" role="status">{job.result}</div>}
    </>
  );
}
