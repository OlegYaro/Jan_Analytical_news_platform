import type { DoctorCheck } from '../../../shared/doctor-types.ts';
import { t } from '../../strings.ts';
import { DoctorTable } from '../DoctorTable.tsx';

interface Props {
  checks: DoctorCheck[] | null;
  running: boolean;
  failed: boolean;
  onRecheck: () => void;
}

export function StepComputer({ checks, running, failed, onRecheck }: Props) {
  return (
    <section className="card">
      <div className="card-head">
        <h2>{t.doctor.title}</h2>
        <button type="button" onClick={onRecheck} disabled={running}>{t.doctor.recheck}</button>
      </div>
      {running && <p className="muted">{t.extra.doctorChecking}</p>}
      {failed && <p className="error">{t.extra.doctorError}</p>}
      {!running && checks && <DoctorTable checks={checks} />}
    </section>
  );
}
